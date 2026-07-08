// src/core/fs.mjs — tiny filesystem helpers shared across the engine + skill modules, so the
// same recursive walk and content-reader aren't re-implemented (and left to drift) in several
// places. No engine coupling — just node:fs, so anything can import it.

import { readFileSync, readdirSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';

// Recursively collect file paths under `dir` (absolute). `skip` prunes dir/file names (a Set or
// array); `filter(absPath)` (optional) keeps only matching files. Fails safe: an unreadable dir
// is skipped, never thrown.
export function walkFiles(dir, { skip = [], filter } = {}) {
  const skipSet = skip instanceof Set ? skip : new Set(skip);
  const out = [];
  const walk = (d) => {
    let ents; try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (skipSet.has(e.name)) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (!filter || filter(p)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

// The content-reader the engine hands a per-file rule: read the would-be bytes, resolving a
// relative path against `root`. Fails safe: unreadable → null.
export function defaultGetContent(root) {
  return (f) => { try { return readFileSync(isAbsolute(f) ? f : join(root, f), 'utf8'); } catch { return null; } };
}
