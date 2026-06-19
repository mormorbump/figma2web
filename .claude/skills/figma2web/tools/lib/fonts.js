// Font resolution. We cannot truly probe browser font availability offline,
// so we classify each used family as: web-safe, google (likely loadable), or
// unknown (needs a pinned substitute). Per design §3.6 we do NOT pixel-diff
// text, so the goal here is to flag families that need a substitute decision.

const WEB_SAFE = new Set(['arial', 'helvetica', 'helvetica neue', 'times new roman', 'times', 'georgia', 'courier new', 'verdana', 'tahoma', 'trebuchet ms', 'system-ui', 'sans-serif', 'serif', 'monospace']);

// A small allowlist of common Google Fonts; extend as needed. Not exhaustive —
// "google" just means "very likely available via next/font/google".
const GOOGLE = new Set(['inter', 'roboto', 'open sans', 'lato', 'montserrat', 'poppins', 'noto sans', 'noto sans jp', 'noto serif jp', 'm plus 1p', 'm plus rounded 1c', 'jost', 'work sans', 'source sans pro', 'source sans 3', 'nunito', 'raleway', 'oswald', 'merriweather', 'playfair display', 'zen kaku gothic new', 'kosugi maru', 'sawarabi gothic', 'sawarabi mincho', 'shippori mincho', 'bIz udpgothic', 'biz udpgothic', 'dm sans', 'manrope', 'figtree']);

export function resolveFonts(model) {
  const families = new Map();
  for (const n of model.nodes) {
    if (n.typography?.fontFamily) {
      const fam = n.typography.fontFamily;
      const key = fam.toLowerCase();
      if (!families.has(key)) families.set(key, { family: fam, weights: new Set(), count: 0 });
      const e = families.get(key);
      e.count++;
      if (n.typography.fontWeight) e.weights.add(n.typography.fontWeight);
    }
  }
  return [...families.values()].map((e) => {
    const key = e.family.toLowerCase();
    const cls = WEB_SAFE.has(key) ? 'web-safe' : GOOGLE.has(key) ? 'google' : 'unknown';
    return {
      family: e.family,
      weights: [...e.weights].sort((a, b) => a - b),
      usageCount: e.count,
      availability: cls,
      // unknown families need a human/skill decision; default substitute is sans-serif
      substitute: cls === 'unknown' ? 'sans-serif' : null,
      note:
        cls === 'unknown'
          ? 'Not recognized as web-safe/Google. Pin a substitute or self-host the font; do NOT chase text pixel diffs (design §3.6).'
          : cls === 'google'
            ? 'Likely loadable via next/font/google.'
            : 'Web-safe family.',
    };
  });
}
