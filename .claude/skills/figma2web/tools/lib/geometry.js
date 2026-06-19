// Pure geometry helpers for layout reconstruction. Operates on rects
// { x, y, w, h } expressed relative to the frame's top-left.

export const area = (r) => Math.max(0, r.w) * Math.max(0, r.h);
export const right = (r) => r.x + r.w;
export const bottom = (r) => r.y + r.h;

// A contains B (with tolerance eps), and A is strictly larger.
export function contains(a, b, eps = 1) {
  return a.x - eps <= b.x && a.y - eps <= b.y && right(a) + eps >= right(b) && bottom(a) + eps >= bottom(b) && area(a) > area(b);
}

// Intersection-over-union and overlap ratio of the smaller box.
export function intersect(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(right(a), right(b));
  const bt = Math.min(bottom(a), bottom(b));
  if (r <= x || bt <= y) return 0;
  return (r - x) * (bt - y);
}
export function overlapRatio(a, b) {
  const i = intersect(a, b);
  if (i <= 0) return 0;
  return i / Math.min(area(a), area(b));
}

// 1-D overlap ratio of two intervals along an axis.
function rangeOverlap(a0, a1, b0, b1) {
  const lo = Math.max(a0, b0);
  const hi = Math.min(a1, b1);
  if (hi <= lo) return 0;
  return (hi - lo) / Math.min(a1 - a0, b1 - b0);
}
export const vOverlap = (a, b) => rangeOverlap(a.y, bottom(a), b.y, bottom(b)); // share rows?
export const hOverlap = (a, b) => rangeOverlap(a.x, right(a), b.x, right(b)); // share columns?

export function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Infer a flex direction for a set of sibling rects.
// Returns { direction, gap, confidence, overlap } where direction is
// 'row' | 'column' | 'grid' | 'stack' (overlapping/absolute) | 'single'.
export function inferLayout(children) {
  if (children.length <= 1) return { direction: 'single', gap: 0, confidence: 1, overlap: false };

  // Detect significant pairwise overlap (z-stacking / absolute candidates).
  let overlaps = 0;
  for (let i = 0; i < children.length; i++)
    for (let j = i + 1; j < children.length; j++) if (overlapRatio(children[i].rect, children[j].rect) > 0.25) overlaps++;
  const overlap = overlaps > 0;

  // Row: children sorted by x share vertical band and don't horizontally overlap.
  const byX = [...children].sort((a, b) => a.rect.x - b.rect.x);
  const byY = [...children].sort((a, b) => a.rect.y - b.rect.y);

  let rowOk = true;
  const rowGaps = [];
  for (let i = 1; i < byX.length; i++) {
    const prev = byX[i - 1].rect, cur = byX[i].rect;
    if (vOverlap(prev, cur) < 0.5) rowOk = false;
    rowGaps.push(cur.x - right(prev));
  }
  let colOk = true;
  const colGaps = [];
  for (let i = 1; i < byY.length; i++) {
    const prev = byY[i - 1].rect, cur = byY[i].rect;
    if (hOverlap(prev, cur) < 0.5) colOk = false;
    colGaps.push(cur.y - bottom(prev));
  }

  if (overlap && !rowOk && !colOk) return { direction: 'stack', gap: 0, confidence: 0.5, overlap: true };
  if (rowOk && !colOk) return { direction: 'row', gap: Math.max(0, Math.round(median(rowGaps))), confidence: 0.8, overlap };
  if (colOk && !rowOk) return { direction: 'column', gap: Math.max(0, Math.round(median(colGaps))), confidence: 0.8, overlap };
  if (rowOk && colOk) return { direction: 'row', gap: Math.max(0, Math.round(median(rowGaps))), confidence: 0.5, overlap };

  // Neither clean row nor column -> likely a grid or wrapped flow.
  return { direction: 'grid', gap: Math.max(0, Math.round(median([...rowGaps, ...colGaps].filter((g) => g > 0)))), confidence: 0.4, overlap };
}

// Padding = inset from parent rect to the bounding box of its children.
export function inferPadding(parentRect, children) {
  if (!children.length) return { l: 0, r: 0, t: 0, b: 0 };
  const minX = Math.min(...children.map((c) => c.rect.x));
  const minY = Math.min(...children.map((c) => c.rect.y));
  const maxR = Math.max(...children.map((c) => right(c.rect)));
  const maxB = Math.max(...children.map((c) => bottom(c.rect)));
  return {
    l: Math.max(0, Math.round(minX - parentRect.x)),
    t: Math.max(0, Math.round(minY - parentRect.y)),
    r: Math.max(0, Math.round(right(parentRect) - maxR)),
    b: Math.max(0, Math.round(bottom(parentRect) - maxB)),
  };
}
