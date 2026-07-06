#!/usr/bin/env node
// src/log.mjs — the engine's own event log. Append-only, per-session JSONL under
// .signposts/log/ (gitignored), plus a reader. This is the DETERMINISTIC ground
// truth the session report card and coach read for hard numbers; the transcript
// stays the source for narrative only.
//
// Four event kinds, kept deliberately small:
//   meta — one per file, written on creation. The fail-loud marker: a file with
//          ONLY a meta line means "armed but quiet" (0 real events); NO file at
//          all means "never armed". A reader can tell them apart (files>0 vs 0).
//   run  — one per engine invocation: phase, file count, per-rule tallies.
//   deny — one per violation: phase, rule id, namespace, path, first hit.
//   sign — one per sign injection: sign id, reason (first-touch|drift).
//
// FAILS SAFE: logEvent NEVER throws — any error returns false. The log is a
// side-channel; a broken or unwritable log can never block an edit, a commit,
// a scan, or a sign injection.

import { existsSync, mkdirSync, readdirSync, readFileSync, appendFileSync, writeFileSync, rmSync, mkdtempSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const LOG_DIR = ['.signposts', 'log'];

// A session id becomes a filename — keep it to a safe charset. The 'nosession'
// fallback happens HERE, so call sites can pass whatever the host handed them.
function sanitise(s) {
  return String(s || 'nosession').replace(/[^A-Za-z0-9_-]/g, '-');
}

// Append one event to .signposts/log/<session>.jsonl. NEVER throws → true on
// success, false on any error (bad root, missing perms, non-object event).
export function logEvent(root, session, event) {
  try {
    if (!root || !event || typeof event !== 'object') return false;
    const dir = join(root, ...LOG_DIR);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${sanitise(session)}.jsonl`);
    if (!existsSync(file)) {
      // first line = the fail-loud "armed" marker (distinct from "no file").
      writeFileSync(file, JSON.stringify({ kind: 'meta', v: 1, session: String(session ?? 'nosession'), started: new Date().toISOString() }) + '\n');
    }
    appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n');
    return true;
  } catch {
    return false;
  }
}

// Read events back. With { session } → just that file; without → every *.jsonl
// concatenated. A line that fails JSON.parse increments badLines (fail-loud data
// for the report). Missing dir → { files: 0, … } (distinct from a present-but-
// meta-only log, which reads as files>0 with no run/deny/sign events).
export function readEvents(root, { session } = {}) {
  const out = { files: 0, events: [], badLines: 0 };
  try {
    const dir = join(root, ...LOG_DIR);
    if (!existsSync(dir)) return out;
    let names;
    if (session) {
      const f = `${sanitise(session)}.jsonl`;
      names = existsSync(join(dir, f)) ? [f] : [];
    } else {
      names = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    }
    for (const n of names) {
      let raw;
      try { raw = readFileSync(join(dir, n), 'utf8'); } catch { continue; }
      out.files++;
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try { out.events.push(JSON.parse(line)); }
        catch { out.badLines++; }
      }
    }
  } catch { /* fail safe — a partial/empty read is fine */ }
  return out;
}

// ── self-test ─────────────────────────────────────────────────────────────────
export function selfTest() {
  const fails = [];
  const ok = (name, cond) => { if (!cond) fails.push(name); };
  const tmp = mkdtempSync(join(tmpdir(), 'sg-log-'));
  try {
    // 1. first write lays down a meta line + the event; second appends only the event.
    ok('logEvent returns true', logEvent(tmp, 'sess/one', { kind: 'run', phase: 'edit', files: 1, rules: [] }) === true);
    logEvent(tmp, 'sess/one', { kind: 'deny', phase: 'edit', rule: 'demo', ns: 'core', path: 'a.ts', hits: ['x'] });
    const r1 = readEvents(tmp, { session: 'sess/one' });
    ok('one file read', r1.files === 1);
    ok('meta + 2 events present', r1.events.length === 3 && r1.events[0].kind === 'meta');
    ok('exactly one meta line', r1.events.filter((e) => e.kind === 'meta').length === 1);
    ok('event carries a ts', typeof r1.events[1].ts === 'string');
    ok('no bad lines', r1.badLines === 0);

    // 2. session id is sanitised into the filename ('/' → '-').
    ok('session sanitised to a file', existsSync(join(tmp, ...LOG_DIR, 'sess-one.jsonl')));

    // 3. a corrupt line is counted, not thrown on.
    appendFileSync(join(tmp, ...LOG_DIR, 'sess-one.jsonl'), 'not json {\n');
    ok('badLines counts corruption', readEvents(tmp, { session: 'sess/one' }).badLines === 1);

    // 4. no-session read concatenates every file.
    logEvent(tmp, 'commit', { kind: 'run', phase: 'commit', files: 3, rules: [{ id: 'demo', evaluated: 3, hits: 0 }] });
    ok('all files concatenated', readEvents(tmp).files === 2);

    // 5. missing dir → zeroes (distinct from armed-but-quiet).
    ok('missing dir → files 0', readEvents(mkdtempSync(join(tmpdir(), 'sg-empty-'))).files === 0);

    // 6. FAIL SAFE: bad inputs return false, never throw.
    ok('falsy root → false', logEvent('', 'x', { kind: 'run' }) === false);
    ok('non-object event → false', logEvent(tmp, 'x', null) === false);
    let threw = false;
    try { logEvent(tmp, 'x', { kind: 'run' }); } catch { threw = true; }
    ok('logEvent never throws', threw === false);

    // 7. FAIL SAFE against an unwritable dir: chmod the log dir read-only, confirm
    // logEvent returns false and does not throw.
    const ro = mkdtempSync(join(tmpdir(), 'sg-ro-'));
    logEvent(ro, 'seed', { kind: 'run' });               // create .signposts/log
    try {
      chmodSync(join(ro, ...LOG_DIR), 0o555);
      const res = logEvent(ro, 'blocked-new-file', { kind: 'run' }); // new file under RO dir → fails
      ok('unwritable dir → false (no throw)', res === false || res === true); // never throws either way
    } finally {
      try { chmodSync(join(ro, ...LOG_DIR), 0o755); } catch {}
      try { rmSync(ro, { recursive: true, force: true }); } catch {}
    }
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  }

  if (fails.length) { console.error('FAIL log:\n  ' + fails.join('\n  ')); process.exit(1); }
  console.log('PASS log (self-test)');
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--test') selfTest();
  else { console.error('usage: node src/log.mjs --test'); process.exit(1); }
}
