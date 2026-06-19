#!/usr/bin/env node
// figma-ingest: fetch a Figma frame via REST, normalize geometry, export the
// reference PNG (gate-A baseline) and assets, resolve fonts, write index.json.
//
// Usage:
//   FIGMA_TOKEN=figd_... node figma-ingest.js --url "<figma url>" [--node 12:34] \
//       [--out .context/figma] [--scale 2] [--list]
//
// Token is read ONLY from env. Never pass it on the command line.

import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fsp from 'node:fs/promises';
import { parseFigmaUrl, nodeIdToSlug } from './lib/figma-url.js';
import { getNodes, getFile, getImageRenders, downloadTo } from './lib/figma-rest.js';
import { buildModel } from './lib/normalize.js';
import { resolveFonts } from './lib/fonts.js';

function parseArgs(argv) {
  const a = { out: '.context/figma', scale: 2 };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--url') a.url = argv[++i];
    else if (k === '--node') a.node = argv[++i];
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--scale') a.scale = Number(argv[++i]);
    else if (k === '--asset-scale') a.assetScale = Number(argv[++i]);
    else if (k === '--list') a.list = true;
    else if (k === '--no-assets') a.noAssets = true;
    else if (k === '--no-ref') a.noRef = true;
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv);
  // Default the target to FIGMA_FILE_URL from .env so a human can run the skill
  // without pasting a URL each time ("just implement the figma content").
  if (!args.url) args.url = process.env.FIGMA_FILE_URL;
  if (!args.url) {
    console.error('Error: no Figma URL. Pass --url "<figma url>" or set FIGMA_FILE_URL in .env.\nUsage: node figma-ingest.js --url "<figma url>" [--node 12:34] [--list]');
    process.exit(1);
  }
  const { fileKey, nodeId: urlNode } = parseFigmaUrl(args.url);
  const nodeId = args.node || urlNode;

  // --list: enumerate top-level frames/pages so the user can pick a target.
  if (args.list || !nodeId) {
    const file = await getFile(fileKey, { depth: 2 });
    console.log(`File: ${file.name}  (version ${file.version})`);
    console.log('Top-level frames (use one of these node ids with --node):');
    for (const page of file.document.children || []) {
      console.log(`  page: ${page.name}`);
      for (const child of page.children || []) {
        const b = child.absoluteBoundingBox;
        const size = b ? `${Math.round(b.width)}x${Math.round(b.height)}` : '';
        console.log(`    ${child.id}  [${child.type}] ${child.name}  ${size}`);
      }
    }
    if (!nodeId) {
      console.error('\nNo --node given. Re-run with --node <id> from the list above.');
      process.exit(args.list ? 0 : 2);
    }
  }

  console.log(`Ingesting node ${nodeId} from file ${fileKey} ...`);
  const nodesResp = await getNodes(fileKey, [nodeId], { geometry: 'paths' });
  const fileVersion = nodesResp.version;
  const doc = nodesResp.nodes[nodeId];
  if (!doc) throw new Error(`Node ${nodeId} not found in file ${fileKey}.`);
  const rootNode = doc.document;

  const model = buildModel(rootNode, { components: doc.components, componentSets: doc.componentSets });
  model.fileKey = fileKey;
  model.nodeId = nodeId;
  model.fileVersion = fileVersion;

  const slug = nodeIdToSlug(nodeId);
  const outDir = join(args.out, slug);
  const assetsDir = join(outDir, 'assets');
  await mkdir(assetsDir, { recursive: true });

  await writeFile(join(outDir, 'model.json'), JSON.stringify(model, null, 2));
  console.log(`  model.json: ${model.nodeCount} nodes, ${model.leafCount} leaves, ${model.componentCount} components`);

  // text_boxes.json: frame-coord boxes of TEXT nodes, consumed by visual_diff.py
  // (--text-boxes) to EXCLUDE text from pixel diff (font renderer noise, §3.6).
  const textBoxes = model.nodes
    .filter((n) => n.typography && n.visible && n.rect)
    .map((n) => ({ x: n.rect.x, y: n.rect.y, w: n.rect.w, h: n.rect.h }));
  await writeFile(join(outDir, 'text_boxes.json'), JSON.stringify(textBoxes));

  // Reference PNG (gate-A baseline). Skippable when /images is rate-limited and
  // only structure is needed (e.g. ingesting the component library).
  if (args.noRef) {
    console.log('  ref.png: skipped (--no-ref)');
  } else {
    try {
      const png = await getImageRenders(fileKey, [nodeId], { format: 'png', scale: args.scale });
      const refUrl = png.images[nodeId];
      if (refUrl) {
        const bytes = await downloadTo(refUrl, join(outDir, 'ref.png'), fsp);
        console.log(`  ref.png: ${(bytes / 1024).toFixed(0)} KB @ scale ${args.scale}`);
      } else {
        console.warn('  WARN: no reference image returned (rate-limited?). Re-run without --no-assets later for gate-A.');
      }
    } catch (e) {
      console.warn(`  WARN: ref.png skipped (${e.message.slice(0, 80)}). Structure (model.json) is intact.`);
    }
  }

  // Fonts
  const fonts = resolveFonts(model);
  if (fonts.some((f) => f.availability === 'unknown')) {
    console.warn('  WARN: unknown fonts (pin a substitute, do not pixel-diff text):', fonts.filter((f) => f.availability === 'unknown').map((f) => f.family).join(', '));
  }

  // Assets: image fills + vector exports. Resilient: never abort ingest on
  // asset failures (model.json + ref.png are the critical outputs).
  const assets = [];
  const assetScale = args.assetScale || 2;
  if (!args.noAssets) {
    try {
      // Only render TOP-LEVEL image-fill nodes (skip ones nested inside another
      // image-fill node) to avoid re-rendering the same pixels many times.
      const imageNodes = model.nodes.filter((n) => n.hasImageFill && n.visible && n.rect);
      const vectorNodes = model.nodes.filter((n) => (n.type === 'VECTOR' || n.type === 'BOOLEAN_OPERATION') && n.visible && n.rect && n.rect.w * n.rect.h < 600 * 600);

      if (imageNodes.length) {
        const ren = await getImageRenders(fileKey, imageNodes.map((n) => n.id), { format: 'png', scale: assetScale });
        for (const n of imageNodes) {
          const url = ren.images[n.id];
          if (!url) continue;
          const file = `${nodeIdToSlug(n.id)}.png`;
          await downloadTo(url, join(assetsDir, file), fsp);
          assets.push({ id: n.id, name: n.name, type: 'image', path: join('assets', file), w: n.rect.w, h: n.rect.h, orientation: orient(n.rect) });
        }
        if (ren.failed.length) console.warn(`  WARN: ${ren.failed.length} image assets failed to render (skipped).`);
      }
      if (vectorNodes.length) {
        const svg = await getImageRenders(fileKey, vectorNodes.map((n) => n.id), { format: 'svg' });
        for (const n of vectorNodes) {
          const url = svg.images[n.id];
          if (!url) continue;
          const file = `${nodeIdToSlug(n.id)}.svg`;
          await downloadTo(url, join(assetsDir, file), fsp);
          assets.push({ id: n.id, name: n.name, type: 'svg', path: join('assets', file), w: n.rect.w, h: n.rect.h, orientation: orient(n.rect) });
        }
        if (svg.failed.length) console.warn(`  WARN: ${svg.failed.length} svg assets failed to render (skipped).`);
      }
      console.log(`  assets: ${assets.length} (${assets.filter((a) => a.type === 'image').length} png, ${assets.filter((a) => a.type === 'svg').length} svg)`);
    } catch (e) {
      console.warn(`  WARN: asset export partially failed (${e.message}). Continuing — model.json and ref.png are intact.`);
    }
  }

  // index.json (NEVER includes token or auth'd URLs — design §3.7)
  const index = {
    frame: { name: model.frame.name, nodeId, width: model.frame.width, height: model.frame.height, fileVersion },
    refImage: existsSync(join(outDir, 'ref.png')) ? { path: 'ref.png', scale: args.scale } : null,
    fonts,
    assets,
    leafCount: model.leafCount,
    components: model.componentCount,
    componentFamilies: model.componentFamilies, // family -> instances + variants (desktop/mobile, states)
    generatedAt: new Date().toISOString(),
  };
  await writeFile(join(outDir, 'index.json'), JSON.stringify(index, null, 2));
  console.log(`Done. Output: ${outDir}`);
  console.log('Next: node "' + fileURLToPath(new URL('layout-reconstruct.js', import.meta.url)) + '" --in ' + outDir);
}

function orient(r) {
  if (!r) return 'unknown';
  if (Math.abs(r.w - r.h) < 2) return 'square';
  return r.w > r.h ? 'landscape' : 'portrait';
}

main().catch((e) => {
  console.error('figma-ingest failed:', e.message);
  process.exit(1);
});
