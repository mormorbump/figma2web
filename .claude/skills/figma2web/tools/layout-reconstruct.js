#!/usr/bin/env node
// layout-reconstruct: turn model.json (absolute geometry) into a CANDIDATE
// intermediate representation by IGNORING the Figma layer tree and rebuilding
// containment + row/column/grid + overlap from rectangles.
//
// This is deliberately a *candidate* generator (design §3.2): the figma2web
// skill / LLM looks at ref.png and makes the final structural decisions. We
// emit measurements + flags, not final markup.
//
// Usage: node layout-reconstruct.js --in .context/figma/<slug> [--out ir-candidates.json]

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { area, contains, overlapRatio, inferLayout, inferPadding, right, bottom } from './lib/geometry.js';

function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--in') a.in = argv[++i];
    else if (argv[i] === '--out') a.out = argv[++i];
  }
  return a;
}


function styleSummary(n) {
  const s = {};
  if (n.fills?.length) s.fill = n.fills[0].hex || n.fills[0].type;
  if (n.strokes?.length) s.stroke = n.strokes[0].hex;
  if (n.cornerRadius) s.radius = n.cornerRadius;
  if (n.effects?.length) s.effects = n.effects.map((e) => e.type);
  if (n.typography) s.text = { content: n.typography.characters, font: n.typography.fontFamily, size: n.typography.fontSize, weight: n.typography.fontWeight, lh: n.typography.lineHeightPx, align: n.typography.textAlignHorizontal };
  return s;
}

const SHAPE_TYPES = new Set(['ELLIPSE', 'STAR', 'POLYGON', 'RECTANGLE', 'LINE']);
function roleGuess(n) {
  if (n.typography) return 'text';
  if (n.isInstance || n.isComponent) return 'component';
  if (n.type === 'VECTOR' || n.type === 'BOOLEAN_OPERATION' || n.type === 'LINE') return 'icon';
  if (n.hasImageFill) return 'image';
  if (SHAPE_TYPES.has(n.type) && n.childCount === 0) return 'shape';
  return 'container';
}

// A node may act as a CONTAINMENT PARENT only if it is a plausible container.
// A painted leaf shape (RECTANGLE/ELLIPSE/VECTOR/TEXT with no children) is NOT
// a container — this is what stops a full-bleed background rectangle from
// "adopting" every node it visually covers (design §3.2-1, the background trap).
const CONTAINER_TYPES = new Set(['FRAME', 'GROUP', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'SECTION']);
function canBeParent(n) {
  return n.childCount > 0 || CONTAINER_TYPES.has(n.type);
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.in) {
    console.error('Usage: node layout-reconstruct.js --in .context/figma/<slug>');
    process.exit(1);
  }
  const model = JSON.parse(await readFile(join(args.in, 'model.json'), 'utf8'));

  // Candidate nodes: visible, positive area, not the frame root itself.
  const frameRect = { x: 0, y: 0, w: model.frame.width, h: model.frame.height };
  const candidates = model.nodes.filter((n) => n.visible && n.rect && n.rect.w > 0.5 && n.rect.h > 0.5 && n.id !== model.frame.id);

  // 1) Build a geometric containment forest (smallest enclosing box = parent).
  //    Sort by area desc so a node's parent is processed first.
  const sorted = [...candidates].sort((a, b) => area(b.rect) - area(a.rect));
  const byId = new Map(sorted.map((n) => [n.id, n]));
  const childrenOf = new Map(); // parentId|'ROOT' -> node[]
  const parentOf = new Map();

  for (const n of sorted) {
    // smallest node that contains n AND is a plausible container
    let best = null;
    for (const cand of sorted) {
      if (cand.id === n.id) continue;
      if (!canBeParent(cand)) continue; // painted leaves can't be parents
      if (contains(cand.rect, n.rect)) {
        if (!best || area(cand.rect) < area(best.rect)) best = cand;
      }
    }
    const pid = best ? best.id : 'ROOT';
    parentOf.set(n.id, pid);
    if (!childrenOf.has(pid)) childrenOf.set(pid, []);
    childrenOf.get(pid).push(n);
  }

  // 2) Recursively build the candidate IR, separating backgrounds + inferring layout.
  const stats = { backgrounds: 0, absoluteCandidates: 0, components: 0, textNodes: 0, maxDepth: 0 };
  const decorationBoxes = []; // frame-coord rects of separated decorations (for visual_diff exemption)

  // Count TEXT leaves in a node's geometric subtree (memoized). Text density is
  // how we tell a real section (contains text) from a decorative backdrop
  // (full-bleed but textless) — e.g. a real landing page where several full-bleed
  // animation layers sit behind the actual content.
  const textCountMemo = new Map();
  function textLeafCount(id) {
    if (textCountMemo.has(id)) return textCountMemo.get(id);
    const n = byId.get(id);
    let c = n && n.typography ? 1 : 0;
    for (const k of childrenOf.get(id) || []) c += textLeafCount(k.id);
    textCountMemo.set(id, c);
    return c;
  }

  // A page-width, TEXTLESS node that sits BEHIND sibling content is a decoration
  // / background z-layer (leaf or container alike). A node that contains text is
  // a real section and must be kept (the P0-1 hero-section lesson). On a tall
  // scrolling page these backdrops are full page-WIDTH but only section-height,
  // so the test is width-span + textless + overlapped-by-a-sibling, NOT
  // area-vs-whole-frame.
  function isDecoration(node, parentRect, siblings) {
    if (node.typography || !parentRect) return false;
    if (textLeafCount(node.id) > 0) return false;
    const widthSpan = node.rect.w >= 0.9 * parentRect.w;
    if (!widthSpan) return false;
    return siblings.some((s) => s.id !== node.id && overlapRatio(node.rect, s.rect) > 0.3);
  }

  function build(node, parentRect, depth) {
    stats.maxDepth = Math.max(stats.maxDepth, depth);
    const kids = (childrenOf.get(node ? node.id : 'ROOT') || []).filter((k) => k.id !== (node && node.id));
    const rect = node ? node.rect : frameRect;

    // Separate decorative backgrounds / z-layers from layout content.
    const backgrounds = [];
    const content = [];
    for (const k of kids) {
      if (isDecoration(k, rect, kids)) {
        backgrounds.push(k);
        decorationBoxes.push({ x: k.rect.x, y: k.rect.y, w: k.rect.w, h: k.rect.h }); // for visual_diff --decoration-boxes
        stats.backgrounds++;
      } else content.push(k);
    }

    const layout = inferLayout(content);
    const padding = inferPadding(rect, content);

    // Flag overlap/absolute candidates among content children.
    const overlapSet = new Set();
    for (let i = 0; i < content.length; i++)
      for (let j = i + 1; j < content.length; j++)
        if (overlapRatio(content[i].rect, content[j].rect) > 0.25) {
          overlapSet.add(content[i].id);
          overlapSet.add(content[j].id);
        }

    const childIR = content
      .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x)
      .map((k) => {
        const flags = {};
        if (overlapSet.has(k.id) || k.rotated) {
          flags.absoluteCandidate = true;
          stats.absoluteCandidates++;
        }
        if (k.rotated) flags.rotated = k.rotation; // bbox is axis-aligned; treat as absolute
        if (k.layoutPositioning === 'ABSOLUTE') flags.figmaAbsolute = true; // trustable
        if (k.isInstance || k.isComponent) {
          flags.component = { id: k.componentId };
          stats.components++;
        }
        if (k.typography) stats.textNodes++;
        return buildNode(k, rect, depth + 1, flags);
      });

    return {
      id: node ? node.id : model.frame.id,
      name: node ? node.name : model.frame.name,
      type: node ? node.type : 'FRAME',
      role: node ? roleGuess(node) : 'frame',
      rect,
      layout: { direction: layout.direction, gap: layout.gap, padding, confidence: layout.confidence, overlap: layout.overlap },
      // auto-layout meta trusted only if it agrees with geometry (direction match)
      figmaAutoLayout: node?.layoutMode ? { mode: node.layoutMode, agrees: agrees(node.layoutMode, layout.direction) } : undefined,
      backgrounds: backgrounds.map((b) => ({ id: b.id, name: b.name, style: styleSummary(b) })),
      style: node ? styleSummary(node) : {},
      children: childIR,
    };
  }

  function buildNode(node, parentRect, depth, flags) {
    const ir = build(node, parentRect, depth);
    ir.flags = flags;
    return ir;
  }

  const root = build(null, frameRect, 0);

  const ir = {
    frame: model.frame,
    fileKey: model.fileKey,
    nodeId: model.nodeId,
    fileVersion: model.fileVersion,
    note: 'CANDIDATE IR from geometry. The skill/LLM must confirm grouping/flex-grid-absolute/semantics against ref.png before generating code (design §3.2-3.3).',
    stats,
    tree: root,
  };

  const outPath = join(args.in, args.out || 'ir-candidates.json');
  await writeFile(outPath, JSON.stringify(ir, null, 2));
  // decoration_boxes.json: feed to visual_diff --decoration-boxes so the score
  // measures real CONTENT fidelity, not the exempt decorative background (the
  // biggest false diff contributor — learned from real-data reproduction runs).
  await writeFile(join(args.in, 'decoration_boxes.json'), JSON.stringify(decorationBoxes));
  console.log(`Wrote ${outPath} + decoration_boxes.json (${decorationBoxes.length} regions)`);
  console.log(`  depth=${stats.maxDepth} text=${stats.textNodes} components=${stats.components} backgrounds=${stats.backgrounds} absoluteCandidates=${stats.absoluteCandidates}`);
  console.log('Next: render overlay -> .context/figma2web/.venv/bin/python "' + fileURLToPath(new URL('visual-diff/overlay.py', import.meta.url)) + '" --in ' + args.in);
}

function agrees(mode, dir) {
  if (mode === 'HORIZONTAL') return dir === 'row';
  if (mode === 'VERTICAL') return dir === 'column';
  return false;
}

main().catch((e) => {
  console.error('layout-reconstruct failed:', e.message);
  process.exit(1);
});
