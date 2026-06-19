// Normalize a Figma node subtree into a flat list of nodes carrying the
// geometry + style we need downstream. The ORIGINAL parent/child relation is
// kept only as `parentId` for reference — reconstruction ignores it (ADR-0001).

const LEAF_TYPES = new Set(['TEXT', 'VECTOR', 'LINE', 'ELLIPSE', 'RECTANGLE', 'STAR', 'POLYGON', 'BOOLEAN_OPERATION']);

function paintToColor(paint) {
  if (!paint || paint.visible === false) return null;
  if (paint.type === 'SOLID' && paint.color) {
    const { r, g, b } = paint.color;
    const a = paint.opacity ?? paint.color.a ?? 1;
    return { type: 'solid', rgba: [round255(r), round255(g), round255(b), round2(a)], hex: toHex(r, g, b) };
  }
  if (paint.type && paint.type.startsWith('GRADIENT')) {
    return { type: 'gradient', gradient: paint.type, stops: (paint.gradientStops || []).map((s) => ({ pos: s.position, hex: toHex(s.color.r, s.color.g, s.color.b), a: round2(s.color.a) })) };
  }
  if (paint.type === 'IMAGE') {
    return { type: 'image', imageRef: paint.imageRef, scaleMode: paint.scaleMode };
  }
  return { type: paint.type?.toLowerCase() || 'unknown' };
}

const round255 = (v) => Math.round(v * 255);
const round2 = (v) => Math.round(v * 100) / 100;
function toHex(r, g, b) {
  const h = (v) => round255(v).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

function bbox(n) {
  const b = n.absoluteBoundingBox;
  if (!b) return null;
  return { x: round2(b.x), y: round2(b.y), w: round2(b.width), h: round2(b.height) };
}

// Rotation (deg) from the 2x3 relativeTransform [[a,c,tx],[b,d,ty]].
// For a rotated node, absoluteBoundingBox is the AXIS-ALIGNED bounds (larger
// than the visual box), so reconstruction must treat rotated nodes as absolute.
function rotationDeg(n) {
  const t = n.relativeTransform;
  if (!t || !t[0] || !t[1]) return 0;
  const deg = (Math.atan2(t[1][0], t[0][0]) * 180) / Math.PI;
  return Math.round(deg * 10) / 10;
}

function typography(n) {
  if (n.type !== 'TEXT' || !n.style) return null;
  const s = n.style;
  return {
    characters: n.characters,
    fontFamily: s.fontFamily,
    fontWeight: s.fontWeight,
    fontSize: s.fontSize,
    lineHeightPx: s.lineHeightPx,
    letterSpacing: s.letterSpacing,
    textAlignHorizontal: s.textAlignHorizontal,
    textAlignVertical: s.textAlignVertical,
    textCase: s.textCase,
    textDecoration: s.textDecoration,
  };
}

// Walk the subtree; produce flat nodes + the set of "leaf" nodes (renderable content).
export function flatten(root, frameOrigin) {
  const nodes = [];
  const ox = frameOrigin?.x ?? 0;
  const oy = frameOrigin?.y ?? 0;

  function visit(n, parentId, depth) {
    const b = bbox(n);
    const rel = b ? { x: round2(b.x - ox), y: round2(b.y - oy), w: b.w, h: b.h } : null; // relative to frame top-left
    const fills = (n.fills || []).map(paintToColor).filter(Boolean);
    const strokes = (n.strokes || []).map(paintToColor).filter(Boolean);
    const node = {
      id: n.id,
      name: n.name,
      type: n.type,
      visible: n.visible !== false,
      opacity: n.opacity ?? 1,
      rotation: rotationDeg(n),
      rotated: Math.abs(rotationDeg(n)) > 0.5,
      parentId,
      depth,
      abs: b,
      rect: rel,
      renderBounds: n.absoluteRenderBounds
        ? { x: round2(n.absoluteRenderBounds.x - ox), y: round2(n.absoluteRenderBounds.y - oy), w: round2(n.absoluteRenderBounds.width), h: round2(n.absoluteRenderBounds.height) }
        : null,
      isLeaf: LEAF_TYPES.has(n.type) || !n.children || n.children.length === 0,
      childCount: n.children?.length ?? 0,
      fills,
      strokes,
      strokeWeight: n.strokeWeight,
      cornerRadius: n.cornerRadius ?? (n.rectangleCornerRadii ? n.rectangleCornerRadii : undefined),
      effects: (n.effects || []).filter((e) => e.visible !== false).map((e) => ({ type: e.type, radius: e.radius, spread: e.spread, offset: e.offset, color: e.color ? toHex(e.color.r, e.color.g, e.color.b) : undefined, a: e.color ? round2(e.color.a) : undefined })),
      // auto-layout (container hints; trusted only when geometry agrees)
      layoutMode: n.layoutMode,
      padding: n.layoutMode ? { l: n.paddingLeft || 0, r: n.paddingRight || 0, t: n.paddingTop || 0, b: n.paddingBottom || 0 } : undefined,
      itemSpacing: n.itemSpacing,
      counterAxisSpacing: n.counterAxisSpacing,
      primaryAxisAlignItems: n.primaryAxisAlignItems,
      counterAxisAlignItems: n.counterAxisAlignItems,
      layoutPositioning: n.layoutPositioning, // AUTO | ABSOLUTE (trustable overlay hint)
      // component identity (reuse candidate)
      componentId: n.componentId,
      isInstance: n.type === 'INSTANCE',
      isComponent: n.type === 'COMPONENT' || n.type === 'COMPONENT_SET',
      typography: typography(n),
      hasImageFill: fills.some((f) => f.type === 'image'),
      clipsContent: n.clipsContent,
    };
    nodes.push(node);
    if (n.children) for (const c of n.children) visit(c, n.id, depth + 1);
  }

  visit(root, null, 0);
  return nodes;
}

// Parse a Figma variant master name ("Property1=desktop, State=active") into
// { Property1: 'desktop', State: 'active' } — captures responsive/state intent.
function parseVariant(name) {
  if (!name || !name.includes('=')) return null;
  const out = {};
  for (const part of name.split(',')) {
    const [k, v] = part.split('=');
    if (k && v !== undefined) out[k.trim()] = v.trim();
  }
  return Object.keys(out).length ? out : null;
}

export function buildModel(rootNode, maps = {}) {
  const frame = bbox(rootNode) || { x: 0, y: 0, w: 0, h: 0 };
  const nodes = flatten(rootNode, frame);
  const components = maps.components || {};
  const componentSets = maps.componentSets || {};

  // Resolve every INSTANCE to its master/family/variant so codegen can build
  // one component per family and switch by variant (desktop/mobile, states).
  for (const n of nodes) {
    if (n.isInstance && n.componentId && components[n.componentId]) {
      const c = components[n.componentId];
      const setName = c.componentSetId && componentSets[c.componentSetId] ? componentSets[c.componentSetId].name : null;
      n.component = {
        id: n.componentId,
        masterName: c.name,
        family: setName || c.name, // the reuse key across variants
        setId: c.componentSetId || null,
        variant: parseVariant(c.name),
      };
    }
  }

  // Per-family reuse summary (across this frame).
  const families = {};
  for (const n of nodes) {
    if (!n.component) continue;
    const f = (families[n.component.family] ||= { family: n.component.family, setId: n.component.setId, instances: 0, variants: new Set() });
    f.instances++;
    if (n.component.variant) f.variants.add(JSON.stringify(n.component.variant));
  }
  const componentFamilies = Object.values(families).map((f) => ({ family: f.family, setId: f.setId, instances: f.instances, variants: [...f.variants].map((v) => JSON.parse(v)) }));

  return {
    frame: { id: rootNode.id, name: rootNode.name, type: rootNode.type, width: frame.w, height: frame.h, abs: frame },
    nodeCount: nodes.length,
    leafCount: nodes.filter((n) => n.isLeaf && n.visible).length,
    componentCount: nodes.filter((n) => n.isInstance || n.isComponent).length,
    componentFamilies,
    components,
    componentSets,
    nodes,
  };
}
