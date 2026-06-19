// Zero-dependency .env loader. Searches up from cwd (and near this module) for
// a .env file and populates process.env for keys not already set. Used so the
// Figma token can live in .env instead of being exported/passed on argv.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

let loaded = false;

export function loadDotenv() {
  if (loaded) return;
  loaded = true;
  const candidates = [];
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    candidates.push(join(dir, '.env'));
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  // The primary lookup is the cwd up-search above (cwd = the target app's
  // project root, where the user keeps .env / FIGMA_FILE_URL). The token can
  // also come purely from an exported env var — loadDotenv only fills unset
  // keys. No skill-relative fallback: tools now live inside the skill dir and
  // a user .env never sits next to them.

  for (const f of candidates) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m || line.trimStart().startsWith('#')) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
    break; // first .env found wins
  }
}
