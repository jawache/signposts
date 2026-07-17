#!/usr/bin/env node
// src/skill/context.mjs — `npx signposts context [--json]`: machine-readable metadata about
// THIS worktree, so a consumer (the workbench's review / work skills) can locate a checkout's
// signposts data without re-deriving any of it. Because the log is now pooled per-repo in the
// home dir, `logDir` is the same for every worktree — so the value this adds is the per-worktree
// view: what branch/worktree this is, the live session, and which past sessions belong to this
// branch (a work-unit that a compaction may have split across several session ids).
//
// Everything resolves from file reads (via ../log.mjs) — no git subprocess, fully fail-safe.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logDir, repoKey, branchOf, gitCommonDir, markerPath, sessionFrom, readEvents } from '../log.mjs';
import { isOff } from '../schema.mjs';

export function buildContext(root, nowMs = Date.now()) {
  const branch = branchOf(root);
  const dir = logDir(root);
  const isWorktree = (() => { try { return fs.statSync(path.join(root, '.git')).isFile(); } catch { return false; } })();

  // the live session for THIS worktree, from its worktree-local marker (fresh = within the window).
  let session = null;
  try {
    const mk = JSON.parse(fs.readFileSync(markerPath(root), 'utf8'));
    if (mk && mk.session) session = { id: mk.session, ts: mk.ts ?? null, fresh: sessionFrom(mk, 'commit', nowMs) !== 'commit' };
  } catch { /* no marker yet */ }

  // sessions whose meta is tagged with this branch — the work-unit, read cheaply from each log's
  // first line (the meta). Old sessions logged before branch-tagging simply won't match.
  const sessionsForBranch = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl') || f === 'commit.jsonl') continue;
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8').split('\n', 1)[0] || '{}');
        if (meta.kind === 'meta' && branch != null && meta.branch === branch) sessionsForBranch.push({ id: meta.session ?? f.slice(0, -6), started: meta.started ?? null });
      } catch { /* skip an unreadable log */ }
    }
    sessionsForBranch.sort((a, b) => String(a.started).localeCompare(String(b.started)));
  } catch { /* no log dir yet */ }

  return {
    root,
    repoKey: repoKey(root),
    branch,
    isWorktree,
    gitCommonDir: gitCommonDir(root),
    logDir: dir,
    reportsDir: path.join(root, '.signposts', 'reports'),
    session,
    sessionsForBranch,
    off: isOff(root),
  };
}

// ── self-test ─────────────────────────────────────────────────────────────────
export function selfTest() {
  const fails = [];
  let n = 0;
  const ok = (name, cond) => { n++; if (!cond) fails.push(name); };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-ctx-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-ctxhome-'));
  const prev = process.env.SIGNPOSTS_HOME;
  process.env.SIGNPOSTS_HOME = home;
  try {
    // a fake main worktree with an origin remote, on branch feature/x
    fs.mkdirSync(path.join(tmp, '.git'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/a/b.git\n');
    fs.writeFileSync(path.join(tmp, '.git', 'HEAD'), 'ref: refs/heads/feature/x\n');
    const dir = logDir(tmp);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 's1.jsonl'), JSON.stringify({ kind: 'meta', v: 1, session: 's1', started: '2026-07-01T00:00:00Z', branch: 'feature/x', worktree: tmp }) + '\n');
    fs.writeFileSync(path.join(dir, 's2.jsonl'), JSON.stringify({ kind: 'meta', v: 1, session: 's2', started: '2026-07-02T00:00:00Z', branch: 'other', worktree: '/elsewhere' }) + '\n');
    fs.mkdirSync(path.join(tmp, '.signposts'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.signposts', '.session'), JSON.stringify({ session: 's1', ts: new Date().toISOString() }) + '\n');

    const ctx = buildContext(tmp);
    ok('repoKey from the origin remote', ctx.repoKey === 'github.com-a-b');
    ok('branch resolved from HEAD', ctx.branch === 'feature/x');
    ok('main worktree → isWorktree false', ctx.isWorktree === false);
    ok('gitCommonDir points at .git', ctx.gitCommonDir === path.join(tmp, '.git'));
    ok('logDir is the shared home location', ctx.logDir === dir && dir.startsWith(home));
    ok('reportsDir stays worktree-local', ctx.reportsDir === path.join(tmp, '.signposts', 'reports'));
    ok('live session read from the worktree marker', ctx.session && ctx.session.id === 's1' && ctx.session.fresh === true);
    ok('sessionsForBranch = only this branch (not the other worktree\'s)', ctx.sessionsForBranch.length === 1 && ctx.sessionsForBranch[0].id === 's1');
    ok('off is false', ctx.off === false);
  } finally {
    if (prev === undefined) delete process.env.SIGNPOSTS_HOME; else process.env.SIGNPOSTS_HOME = prev;
    try { fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  if (fails.length) { console.error('FAIL context:\n  ' + fails.join('\n  ')); process.exit(1); }
  console.log(`context self-test: PASS (${n} assertions)`);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--test')) return selfTest();
  const i = argv.indexOf('--target');
  const root = i >= 0 ? path.resolve(argv[i + 1]) : process.cwd();
  console.log(JSON.stringify(buildContext(root), null, 2));   // inherently machine-readable → always JSON
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main();
