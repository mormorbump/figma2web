// Minimal Figma REST client. Token comes ONLY from the FIGMA_TOKEN env var
// (never argv, never written to disk) per ADR-0001 / design §3.7.

import { loadDotenv } from './env.js';

const API = 'https://api.figma.com/v1';

loadDotenv(); // pick up FIGMA_SECRET_KEY / FIGMA_TOKEN from .env if present

function token() {
  const t = process.env.FIGMA_TOKEN || process.env.FIGMA_SECRET_KEY;
  if (!t) {
    throw new Error(
      'No Figma token found. Set FIGMA_SECRET_KEY (or FIGMA_TOKEN) in .env or the environment — a Personal Access Token with "File content (read)" scope. Do NOT pass it as an argument.',
    );
  }
  return t;
}

async function getJson(path, { retries = 4 } = {}) {
  const url = `${API}${path}`;
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers: { 'X-Figma-Token': token() } });
    } catch (e) {
      if (attempt < retries) {
        await sleep(2 ** attempt * 1000);
        continue;
      }
      throw e;
    }
    // Retry on rate limit (429) and transient server errors (5xx).
    if ((res.status === 429 || (res.status >= 500 && res.status < 600)) && attempt < retries) {
      const ra = Number(res.headers.get('retry-after') || 2 ** attempt);
      // Don't block for minutes/days on a long rate-limit penalty — fail fast so
      // the caller can degrade (skip ref/assets) instead of hanging.
      if (res.status === 429 && ra > 120) {
        const body = await res.text().catch(() => '');
        throw new Error(`Figma API 429 (retry-after ${ra}s, too long to wait) for ${path}: ${body.slice(0, 200)}`);
      }
      await sleep(Math.min(ra, 60) * 1000);
      continue;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Figma API ${res.status} for ${path}: ${body.slice(0, 300)}`);
    }
    return res.json();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// GET /v1/files/:key/nodes?ids=...&geometry=paths
export async function getNodes(fileKey, ids, { geometry = 'paths', depth } = {}) {
  const q = new URLSearchParams({ ids: ids.join(',') });
  if (geometry) q.set('geometry', geometry);
  if (depth) q.set('depth', String(depth));
  return getJson(`/files/${fileKey}/nodes?${q}`);
}

// GET /v1/files/:key  (whole file, used to discover top-level frames & version)
export async function getFile(fileKey, { depth } = {}) {
  const q = new URLSearchParams();
  if (depth) q.set('depth', String(depth));
  const qs = q.toString();
  return getJson(`/files/${fileKey}${qs ? `?${qs}` : ''}`);
}

// GET /v1/images/:key?ids=...&format=&scale=  -> { images, failed }
// Batches ids, polls for async nulls, and ADAPTIVELY SPLITS a chunk when Figma
// replies "400 Render timeout, try requesting fewer or smaller images". Asset
// rendering never throws — failed ids are returned so ingest can continue
// (model.json + ref.png are the critical outputs; assets are secondary).
export async function getImageRenders(fileKey, ids, { format = 'png', scale = 2, chunkSize = 20, maxPolls = 4 } = {}) {
  const images = {};
  const failed = [];

  async function renderChunk(chunk) {
    if (!chunk.length) return;
    let pending = chunk;
    for (let poll = 0; poll <= maxPolls && pending.length; poll++) {
      if (poll > 0) await sleep(1500);
      const q = new URLSearchParams({ ids: pending.join(','), format, scale: String(scale) });
      let resp;
      try {
        resp = await getJson(`/images/${fileKey}?${q}`);
      } catch (e) {
        if (/Render timeout|render|413|400/i.test(e.message) && chunk.length > 1) {
          const mid = Math.ceil(chunk.length / 2);
          await renderChunk(chunk.slice(0, mid));
          await renderChunk(chunk.slice(mid));
          return;
        }
        failed.push(...pending); // single id (or non-splittable) keeps failing -> skip
        return;
      }
      if (resp.err) {
        if (chunk.length > 1) {
          const mid = Math.ceil(chunk.length / 2);
          await renderChunk(chunk.slice(0, mid));
          await renderChunk(chunk.slice(mid));
          return;
        }
        failed.push(...pending);
        return;
      }
      const map = resp.images || {};
      const still = [];
      for (const id of pending) {
        if (map[id]) images[id] = map[id];
        else still.push(id);
      }
      pending = still;
    }
    failed.push(...pending); // still null after polling
  }

  for (let i = 0; i < ids.length; i += chunkSize) {
    await renderChunk(ids.slice(i, i + chunkSize));
  }
  return { images, failed };
}

// GET /v1/files/:key/images -> { meta: { images: { imageRef: url } } }
export async function getImageFills(fileKey) {
  return getJson(`/files/${fileKey}/images`);
}

export async function downloadTo(url, destPath, fs) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed ${res.status}: ${url.slice(0, 120)}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(destPath, buf);
  return buf.length;
}
