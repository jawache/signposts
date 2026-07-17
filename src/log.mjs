#!/usr/bin/env node
// src/log.mjs — the engine's own event log. Append-only, per-session JSONL under
// .signposts/log/ (gitignored), plus a reader. This is the DETERMINISTIC ground
// truth the session report card and coach read for hard numbers; the transcript
// stays the source for narrative only.
//
// Event kinds, kept deliberately small:
//   meta  — one per file, written on creation. The fail-loud marker: a file with
//           ONLY a meta line means "armed but quiet" (0 real events); NO file at
//           all means "never armed". A reader can tell them apart (files>0 vs 0).
//   run   — one per engine invocation: phase, file count, per-rule tallies
//           ({id, evaluated, matched, hits}).
//   check — one per MATCHED (rule, file): phase, rule, ns, path, out
//           (allow|deny|override), msg (only on deny). The per-file trace the report renders.
//   deny  — one per violation: phase, rule id, namespace, path, first hit (kept for back-compat).
//   sign  — one per sign injection: sign id, reason (first-touch|drift).
//
// Also a non-.jsonl SESSION MARKER (.signposts/log/.session): the PreToolUse hook writes the
// live Claude session id here so the commit gate (spawned by git, outside any session) can
// attribute its run/deny events to that session instead of the shared 'commit' file.
//
// FAILS SAFE: logEvent + the marker helpers NEVER throw — any error returns false/null. The
// log is a side-channel; a broken or unwritable log can never block an edit, a commit, a
// scan, or a sign injection.

import { existsSync, mkdirSync, readdirSync, readFileSync, appendFileSync, writeFileSync, rmSync, mkdtempSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const LOG_DIR = ['.signposts', 'log'];

// A session id becomes a filename — keep it to a safe charset. The 'nosession'
// fallback happens HERE, so call sites can pass whatever the host handed them.
// Exported so the report card sanitises session ids identically to the log.
export function sanitise(s) {
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

// ── the commit-gate session marker ──────────────────────────────────────────────
// The gate runs inside git's pre-commit hook, outside any Claude session, so it can't know
// which session a commit belongs to. The PreToolUse hook leaves a breadcrumb: the live
// session id + a timestamp. The gate reads it and, when fresh, attributes its events there.
const SESSION_MARKER = '.session';
const MARKER_MAX_AGE_MS = 4 * 60 * 60 * 1000;   // 4h — a commit long after the last edit is not "this session"

// PURE decision: which session id does a commit-gate run belong to? A fresh, well-formed
// marker wins; a stale / missing / malformed / clock-skewed marker → the fallback ('commit'),
// so a human or CI commit stays unattributed rather than mis-pinned to an old session.
// now/maxAge are injected → deterministic and testable.
export function sessionFrom(marker, fallback, nowMs, maxAgeMs = MARKER_MAX_AGE_MS) {
  if (!marker || typeof marker.session !== 'string' || !marker.session) return fallback;
  const t = Date.parse(marker.ts);
  if (!Number.isFinite(t) || Math.abs(nowMs - t) > maxAgeMs) return fallback;   // stale OR absurd future
  return marker.session;
}

// Best-effort write of the session marker. NEVER throws (fail-safe, like logEvent). Called
// from the PreToolUse hook on every edit, so the marker tracks the session's latest activity.
export function writeSessionMarker(root, session) {
  try {
    if (!root || !session) return false;
    const dir = join(root, ...LOG_DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, SESSION_MARKER), JSON.stringify({ session: String(session), ts: new Date().toISOString() }) + '\n');
    return true;
  } catch { return false; }
}

// Resolve the commit-gate session id: the fresh marker's session, else 'commit'. NEVER throws.
export function commitSession(root, nowMs = Date.now()) {
  let marker = null;
  try { marker = JSON.parse(readFileSync(join(root, ...LOG_DIR, SESSION_MARKER), 'utf8')); } catch { /* missing/corrupt → fallback */ }
  return sessionFrom(marker, 'commit', nowMs);
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

    // 3b. a `check` event round-trips like any other kind (readEvents parses any JSONL).
    logEvent(tmp, 'sess/one', { kind: 'check', phase: 'edit', rule: 'demo', ns: 'core', path: 'a.ts', out: 'deny', msg: 'no' });
    ok('check event round-trips', readEvents(tmp, { session: 'sess/one' }).events.some((e) => e.kind === 'check' && e.out === 'deny'));

    // 4. no-session read concatenates every file.
    logEvent(tmp, 'commit', { kind: 'run', phase: 'commit', files: 3, rules: [{ id: 'demo', evaluated: 3, matched: 0, hits: 0 }] });
    ok('all files concatenated', readEvents(tmp).files === 2);

    // 4b. the session marker: fresh → its session; stale / missing / malformed → 'commit' fallback.
    const now = Date.parse('2026-07-17T12:00:00Z');
    ok('sessionFrom: fresh marker wins', sessionFrom({ session: 'sess-live', ts: '2026-07-17T11:59:00Z' }, 'commit', now) === 'sess-live');
    ok('sessionFrom: stale → fallback', sessionFrom({ session: 'sess-old', ts: '2026-07-17T06:00:00Z' }, 'commit', now) === 'commit');
    ok('sessionFrom: absurd future → fallback', sessionFrom({ session: 'sess-future', ts: '2027-01-01T00:00:00Z' }, 'commit', now) === 'commit');
    ok('sessionFrom: missing marker → fallback', sessionFrom(null, 'commit', now) === 'commit');
    ok('sessionFrom: malformed ts → fallback', sessionFrom({ session: 'x', ts: 'not-a-date' }, 'commit', now) === 'commit');
    ok('sessionFrom: empty session → fallback', sessionFrom({ session: '', ts: '2026-07-17T11:59:00Z' }, 'commit', now) === 'commit');
    // write → read round-trip through the real dir; the marker is NOT a .jsonl so readEvents ignores it.
    ok('writeSessionMarker returns true', writeSessionMarker(tmp, 'sess-live') === true);
    ok('commitSession reads a fresh marker', commitSession(tmp) === 'sess-live');
    ok('marker is not read as an event file', readEvents(tmp).files === 2);   // still just the 2 .jsonl files
    ok('commitSession fallback when no marker', commitSession(mkdtempSync(join(tmpdir(), 'sg-nomark-'))) === 'commit');
    // FAIL SAFE: the marker helpers never throw on bad input.
    let mThrew = false;
    try { writeSessionMarker('', 'x'); commitSession(''); } catch { mThrew = true; }
    ok('marker helpers never throw', mThrew === false);

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
      chmodSync(join(ro, ...LOG_DIR), 0o555);            // read-only dir → a NEW file can't be created
      let threw = false, res;
      try { res = logEvent(ro, 'blocked-new-file', { kind: 'run' }); } catch { threw = true; }
      ok('unwritable dir: logEvent never throws', threw === false);              // the headline fail-safe
      ok('unwritable dir: returns a boolean', typeof res === 'boolean');
      // the real contract: if it reported failure, it did NOT leave a partial file behind.
      // (a false escape hatch for the rare FS/uid where the write actually succeeds)
      ok('unwritable dir: false ⇒ no file written', res === true || !existsSync(join(ro, ...LOG_DIR, 'blocked-new-file.jsonl')));
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
