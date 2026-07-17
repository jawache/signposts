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

import { existsSync, statSync, mkdirSync, readdirSync, readFileSync, appendFileSync, writeFileSync, copyFileSync, rmSync, mkdtempSync, chmodSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

// ── where the log lives ─────────────────────────────────────────────────────────
// The event log is telemetry that must OUTLIVE a single checkout: with git worktrees
// (a fresh working dir per branch) an in-repo .signposts/log/ FRAGMENTS the history —
// each worktree accumulates its own, so the cumulative rule-lifetime ledger only ever
// sees one branch's sessions. So the log lives in the HOME dir, keyed by the repo it
// belongs to: ~/.signposts/<repo-key>/log/ — one shared log across every worktree.
//
// The key is resolved by READING git's own files (never spawning git — that keeps this
// fail-safe and hermetic at commit-time, where a git subprocess could corrupt the index):
// the shared config's `remote.origin.url` when there is one (durable — survives a move),
// else the main repo's path. A non-git dir (or any error) falls back to <root>/.signposts/log,
// exactly the old behaviour. Reports stay per-worktree; it's only the log that wants sharing.
const LOG_LEAF = 'log';
const keyCache = new Map();

function normaliseRemote(url) {
  return String(url).trim()
    .replace(/^[a-z]+:\/\//i, '').replace(/^git@/, '').replace(/^[^@/]+@/, '')   // strip scheme + user@
    .replace(/:/, '/').replace(/\.git$/, '').replace(/\/+$/, '');                // scp-form host:path → host/path
}
// A repo identity stable across all its worktrees, or null for a non-git dir. Pure file reads.
function repoKey(root) {
  if (keyCache.has(root)) return keyCache.get(root);
  let key = null;
  try {
    const dotgit = join(root, '.git');
    const st = statSync(dotgit);
    let commonGitDir;
    if (st.isDirectory()) {
      commonGitDir = dotgit;                                                    // the main worktree
    } else {                                                                    // a linked worktree: .git is a file
      const gd = readFileSync(dotgit, 'utf8').match(/gitdir:\s*(.+)/)?.[1]?.trim();
      const wtGitDir = gd ? resolve(root, gd) : null;
      if (wtGitDir) {
        try { commonGitDir = resolve(wtGitDir, readFileSync(join(wtGitDir, 'commondir'), 'utf8').trim()); }
        catch { commonGitDir = wtGitDir; }                                      // no commondir file → treat as its own
      }
    }
    if (commonGitDir) {
      try {                                                                     // prefer the durable remote identity
        const cfg = readFileSync(join(commonGitDir, 'config'), 'utf8');
        const m = cfg.match(/\[remote "origin"\][^[]*?\burl\s*=\s*([^\n\r]+)/);
        if (m) key = normaliseRemote(m[1]);
      } catch { /* no config / no origin */ }
      if (!key) key = dirname(commonGitDir);                                    // else the main repo working dir
    }
  } catch { /* not a git repo, or unreadable → fall back below */ }
  key = key ? key.replace(/[^A-Za-z0-9_.-]/g, '-').replace(/^-+|-+$/g, '') : null;
  keyCache.set(root, key);
  return key;
}
// The absolute log dir for a repo root: the shared home location, or the in-repo fallback.
// SIGNPOSTS_HOME overrides the home base (an escape hatch; used by the self-tests so they
// never touch the real ~/.signposts).
export function logDir(root) {
  const key = repoKey(root);
  const base = process.env.SIGNPOSTS_HOME || homedir();
  return key ? join(base, '.signposts', key, LOG_LEAF) : join(root, '.signposts', LOG_LEAF);
}

// One-time, best-effort: when a repo FIRST logs to the shared home location, carry over any
// pre-existing in-repo log (from before the log moved out of the working tree) so the
// cumulative ledger keeps its history. Guarded to run once — skipped the moment the home dir
// exists — and only for THIS worktree's legacy dir (a repo already spread across several
// worktrees wants a deliberate all-worktree merge instead). NEVER throws: migration is a
// convenience, never a gate.
function migrateLegacyLog(root, homeDir) {
  try {
    const legacy = join(root, '.signposts', LOG_LEAF);
    if (homeDir === legacy || existsSync(homeDir) || !existsSync(legacy)) return;
    const files = readdirSync(legacy).filter((f) => f.endsWith('.jsonl'));   // logs only — the marker is worktree-local
    if (!files.length) return;
    mkdirSync(homeDir, { recursive: true });
    for (const f of files) { try { copyFileSync(join(legacy, f), join(homeDir, f)); } catch { /* skip one bad file */ } }
  } catch { /* fail-safe: a migration hiccup must never block logging */ }
}

// The session marker is PER-WORKTREE state (it tells the pre-commit gate which live session
// THIS worktree's commit belongs to) — so it lives in the worktree, NOT the pooled home log
// dir. Sharing it would let two worktrees committing at once clobber each other's marker and
// mis-attribute a commit. Kept out of the log dir on purpose.
export function markerPath(root) {
  return join(root, '.signposts', SESSION_MARKER);
}

// The branch checked out in a worktree, read from its own HEAD (a file read — no git subprocess,
// so it stays fail-safe and hermetic). A detached HEAD yields the short sha; a non-git dir → null.
export function branchOf(root) {
  try {
    const dotgit = join(root, '.git');
    const st = statSync(dotgit);
    const gitdir = st.isDirectory() ? dotgit : resolve(root, readFileSync(dotgit, 'utf8').match(/gitdir:\s*(.+)/)?.[1]?.trim() || '');
    const head = readFileSync(join(gitdir, 'HEAD'), 'utf8').trim();
    const m = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    return m ? m[1] : (head.slice(0, 12) || null);
  } catch { return null; }
}

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
    const dir = logDir(root);
    migrateLegacyLog(root, dir);                          // one-time carry-over of any in-repo history
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${sanitise(session)}.jsonl`);
    if (!existsSync(file)) {
      // first line = the fail-loud "armed" marker (distinct from "no file"). It also stamps the
      // session's branch + worktree, so a pooled log stays worktree-attributable — reflect can
      // group a work-unit's sessions by branch (compaction splits one task into several), and a
      // commit can never cross-attribute across worktrees.
      writeFileSync(file, JSON.stringify({ kind: 'meta', v: 1, session: String(session ?? 'nosession'), started: new Date().toISOString(), branch: branchOf(root), worktree: root }) + '\n');
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
    const mp = markerPath(root);                          // worktree-local, not the pooled log dir
    mkdirSync(dirname(mp), { recursive: true });
    writeFileSync(mp, JSON.stringify({ session: String(session), ts: new Date().toISOString() }) + '\n');
    return true;
  } catch { return false; }
}

// Resolve the commit-gate session id: the fresh marker's session, else 'commit'. NEVER throws.
export function commitSession(root, nowMs = Date.now()) {
  let marker = null;
  try { marker = JSON.parse(readFileSync(markerPath(root), 'utf8')); } catch { /* missing/corrupt → fallback */ }
  return sessionFrom(marker, 'commit', nowMs);
}

// Read events back. With { session } → just that file; without → every *.jsonl
// concatenated. A line that fails JSON.parse increments badLines (fail-loud data
// for the report). Missing dir → { files: 0, … } (distinct from a present-but-
// meta-only log, which reads as files>0 with no run/deny/sign events).
export function readEvents(root, { session } = {}) {
  const out = { files: 0, events: [], badLines: 0 };
  try {
    const dir = logDir(root);
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
    ok('session sanitised to a file', existsSync(join(logDir(tmp), 'sess-one.jsonl')));

    // 3. a corrupt line is counted, not thrown on.
    appendFileSync(join(logDir(tmp), 'sess-one.jsonl'), 'not json {\n');
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
      chmodSync(logDir(ro), 0o555);            // read-only dir → a NEW file can't be created
      let threw = false, res;
      try { res = logEvent(ro, 'blocked-new-file', { kind: 'run' }); } catch { threw = true; }
      ok('unwritable dir: logEvent never throws', threw === false);              // the headline fail-safe
      ok('unwritable dir: returns a boolean', typeof res === 'boolean');
      // the real contract: if it reported failure, it did NOT leave a partial file behind.
      // (a false escape hatch for the rare FS/uid where the write actually succeeds)
      ok('unwritable dir: false ⇒ no file written', res === true || !existsSync(join(logDir(ro), 'blocked-new-file.jsonl')));
    } finally {
      try { chmodSync(logDir(ro), 0o755); } catch {}
      try { rmSync(ro, { recursive: true, force: true }); } catch {}
    }
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  }

  // ── log LOCATION: shared home dir keyed by repo, one log across all worktrees ──
  const scratch = [];
  const mk = (p) => { const d = mkdtempSync(join(tmpdir(), p)); scratch.push(d); return d; };
  try {
    // 1. a non-git dir → the in-repo fallback (old behaviour, unchanged).
    const plain = mk('sg-plain-');
    ok('non-git dir → in-repo fallback', logDir(plain) === join(plain, '.signposts', 'log'));

    // 2. a main repo with an origin remote → home dir keyed by the normalised remote.
    const main = mk('sg-main-');
    mkdirSync(join(main, '.git'), { recursive: true });
    writeFileSync(join(main, '.git', 'config'), '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:jawache/signposts.git\n');
    const key = 'github.com-jawache-signposts';
    ok('git repo → ~/.signposts/<remote-key>/log', logDir(main) === join(homedir(), '.signposts', key, 'log'));

    // 3. a LINKED WORKTREE of that repo → the SAME shared log (the whole point).
    const wt = mk('sg-wt-');
    const wtGit = join(main, '.git', 'worktrees', 'wt');
    mkdirSync(wtGit, { recursive: true });
    writeFileSync(join(wtGit, 'commondir'), '../..\n');           // → <main>/.git
    writeFileSync(join(wt, '.git'), `gitdir: ${wtGit}\n`);        // a worktree's .git is a FILE
    ok('a worktree resolves to its main repo\'s shared log', logDir(wt) === logDir(main));

    // 4. https + scp-form remotes normalise identically.
    const https = mk('sg-https-');
    mkdirSync(join(https, '.git'), { recursive: true });
    writeFileSync(join(https, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/jawache/signposts.git\n');
    ok('https + scp remote → same key', logDir(https) === logDir(main));

    // 5. a git repo with NO remote → still in home (keyed by the main repo path), not in-repo.
    const noremote = mk('sg-noremote-');
    mkdirSync(join(noremote, '.git'), { recursive: true });
    ok('git, no remote → home (path-keyed), not in-repo', logDir(noremote).startsWith(join(homedir(), '.signposts')) && logDir(noremote) !== join(noremote, '.signposts', 'log'));

    // 6. AUTO-MIGRATION: the first log to a fresh home carries over the in-repo history, once.
    const home = mk('sg-home-');
    const repo = mk('sg-mig-');
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeFileSync(join(repo, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/x/y.git\n');
    mkdirSync(join(repo, '.signposts', 'log'), { recursive: true });               // pre-move in-repo history
    writeFileSync(join(repo, '.signposts', 'log', 'old-sess.jsonl'), JSON.stringify({ kind: 'meta', session: 'old-sess', started: '2026-01-01T00:00:00Z' }) + '\n');
    const prevHome = process.env.SIGNPOSTS_HOME;
    process.env.SIGNPOSTS_HOME = home;
    try {
      ok('first logEvent to a fresh home succeeds', logEvent(repo, 'new-sess', { kind: 'run', phase: 'edit', rules: [] }) === true);
      const hd = logDir(repo);
      ok('legacy session log carried into the shared home', existsSync(join(hd, 'old-sess.jsonl')));
      ok('the new session is written to home', existsSync(join(hd, 'new-sess.jsonl')));
      logEvent(repo, 'new-sess', { kind: 'run', phase: 'commit', rules: [] });     // second write must NOT re-migrate
      ok('migration is one-time (home exists → skipped, no duplication)', readEvents(repo, { session: 'old-sess' }).events.length === 1);

      // 7. the session marker is WORKTREE-LOCAL — never the pooled log dir (no cross-worktree race).
      ok('marker path is in the worktree, not the log dir', markerPath(repo) === join(repo, '.signposts', SESSION_MARKER) && !markerPath(repo).startsWith(hd));
      writeSessionMarker(repo, 'new-sess');
      ok('marker round-trips from the worktree-local path', commitSession(repo) === 'new-sess');
      ok('marker is not written into the shared log', !existsSync(join(hd, SESSION_MARKER)));

      // 8. the meta event stamps branch + worktree (branch null for this bare fake repo).
      const meta = readEvents(repo, { session: 'new-sess' }).events.find((e) => e.kind === 'meta');
      ok('meta carries the worktree path', meta && meta.worktree === repo);
      ok('meta carries a branch field', meta && 'branch' in meta);
    } finally { if (prevHome === undefined) delete process.env.SIGNPOSTS_HOME; else process.env.SIGNPOSTS_HOME = prevHome; }
  } finally {
    for (const d of scratch) try { rmSync(d, { recursive: true, force: true }); } catch {}
  }

  if (fails.length) { console.error('FAIL log:\n  ' + fails.join('\n  ')); process.exit(1); }
  console.log('PASS log (self-test)');
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--test') selfTest();
  else { console.error('usage: node src/log.mjs --test'); process.exit(1); }
}
