// Parse a Figma file/design URL into { fileKey, nodeId }.
// Accepts forms like:
//   https://www.figma.com/file/<key>/<name>?node-id=12-34
//   https://www.figma.com/design/<key>/<name>?node-id=12%3A34
//   https://www.figma.com/design/<key>/...   (no node-id)
// node-id in the URL uses "12-34"; the REST API expects "12:34".

export function parseFigmaUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`Invalid Figma URL: ${url}`);
  }
  const m = u.pathname.match(/\/(?:file|design|proto)\/([A-Za-z0-9]+)/);
  if (!m) {
    throw new Error(
      `Could not extract file key from URL path: ${u.pathname}. Expected /file/<key> or /design/<key>.`,
    );
  }
  const fileKey = m[1];

  let nodeId = null;
  const raw = u.searchParams.get('node-id');
  if (raw) {
    nodeId = decodeURIComponent(raw).replace(/-/g, ':');
  }
  return { fileKey, nodeId };
}

// REST node ids are "12:34"; image/asset filenames must be filesystem-safe.
export function nodeIdToSlug(nodeId) {
  return String(nodeId).replace(/[^A-Za-z0-9]+/g, '-');
}
