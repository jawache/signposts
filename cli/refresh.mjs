// cli/refresh.mjs — `npx signposts refresh` pulls updates for installed packs.
//
// A three-way merge per vendored file, using the lock as the common base:
//   base   = the sha recorded in signposts.lock.json (what was last installed)
//   mine   = the file currently on disk
//   theirs = the file in the (new) pack
//
//   theirs == base                         → up to date, nothing to do
//   theirs != base, mine == base           → take theirs (clean update)
//   theirs != base, mine == theirs         → you already had it; just re-lock
//   theirs != base, mine != base != theirs → CONFLICT: you edited a vendored file
//                                            upstream also changed → keep yours, drop
//                                            <file>.theirs beside it, report it
//
// The lock is rewritten to the new shas for every file that wasn't left in conflict.

import { join } from 'node:path';
import {
  PACK_NAME, listPackFiles, readBytes, readText, writeBytes, writeText, sha256, exists,
} from './pack.mjs';

export function refresh({ packRoot, target, log = console.log }) {
  const lockPath = join(target, 'signposts.lock.json');
  const lock = safeJson(readText(lockPath));
  if (!lock?.packs?.[PACK_NAME]) {
    log(`No ${PACK_NAME} in signposts.lock.json — run \`npx signposts\` to scaffold first.`);
    return { updated: 0, conflicts: [], upToDate: 0 };
  }
  const base = lock.packs[PACK_NAME].files || {};
  const files = listPackFiles(packRoot);
  const nextLock = { version: rootVersion(packRoot), files: {} };

  let updated = 0, upToDate = 0, added = 0;
  const conflicts = [];

  for (const f of files) {
    const theirsBytes = readBytes(join(packRoot, f));
    const theirs = sha256(theirsBytes);
    const baseSha = base[f];
    const mineBytes = exists(join(target, f)) ? readBytes(join(target, f)) : null;
    const mine = mineBytes ? sha256(mineBytes) : null;

    if (baseSha === undefined) {                 // new file in the pack
      writeBytes(join(target, f), theirsBytes); nextLock.files[f] = theirs; added++;
      log(`+ added   ${f}`); continue;
    }
    if (theirs === baseSha) {                     // upstream unchanged
      nextLock.files[f] = theirs;
      if (mine !== baseSha) log(`  (kept your local edit: ${f})`);
      upToDate++; continue;
    }
    // upstream changed
    if (mine === baseSha || mine === null) {      // you hadn't touched it → clean update
      writeBytes(join(target, f), theirsBytes); nextLock.files[f] = theirs; updated++;
      log(`↑ updated ${f}`);
    } else if (mine === theirs) {                 // you already had the new version
      nextLock.files[f] = theirs; upToDate++;
    } else {                                      // both changed → conflict
      writeBytes(join(target, `${f}.theirs`), theirsBytes);
      nextLock.files[f] = baseSha;               // keep base so the conflict resurfaces next time
      conflicts.push(f);
      log(`! conflict ${f} — you edited a vendored file; upstream changed too. New version left at ${f}.theirs`);
    }
  }

  // report files that left the pack (kept on disk, dropped from the lock)
  for (const f of Object.keys(base)) if (!files.includes(f)) log(`- removed from pack (kept on disk): ${f}`);

  lock.packs[PACK_NAME] = nextLock;
  writeText(lockPath, JSON.stringify(lock, null, 2) + '\n');

  log(`\n${updated} updated, ${added} added, ${upToDate} up to date, ${conflicts.length} conflict(s).`);
  if (conflicts.length) log(`Resolve each .theirs, then run refresh again.`);
  return { updated, added, upToDate, conflicts };
}

function safeJson(s) { if (!s) return null; try { return JSON.parse(s); } catch { return null; } }
function rootVersion(packRoot) { return safeJson(readText(join(packRoot, 'package.json')))?.version || '0.0.0'; }
