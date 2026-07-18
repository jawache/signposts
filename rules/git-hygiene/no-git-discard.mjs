#!/usr/bin/env node
// rules/check-git-discard.mjs — blocks a git command that would silently
// destroy uncommitted work.
//
// `git checkout -- <paths>` and `git restore <paths>` overwrite the working
// tree with no undo. In an agent session, reverting a dirty file is almost
// never wanted without a stash (origin: 2026-06-10, a stray `git checkout --`
// during cache debugging wiped a file's entire uncommitted rewrite). This is a
// PreToolUse hook on Bash — it must fire BEFORE the command runs; a post-hoc
// check can't un-destroy work — so it is wired in .claude/settings.json, not
// the commit gate.
//
// Scope is deliberately narrow (prefer false negatives over blocking real
// work): only the `--` pathspec form of checkout (branch switching passes) and
// `git restore` forms that touch the working tree (`--staged`-only passes).
// There is no escape hatch: the safe path for a deliberate discard is `git
// stash` (reversible), so the block stands absolute.
//
// Usage:  hook mode (default): reads PreToolUse JSON on stdin   (exit 2 blocks)
//         node rules/check-git-discard.mjs --test               (self-test)

import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── pure ─────────────────────────────────────────────────────────────────────

const OPERATORS = new Set([';', '&&', '||', '|', '&', '|&']);

// Shell-ish tokeniser: respects quotes (so a commit message mentioning
// "git checkout --" doesn't false-positive) and emits shell operators as
// their own tokens. Returns null on unparseable input (unclosed quote) —
// callers must be permissive then.
export function tokenize(cmd) {
  const tokens = [];
  let cur = '';
  let started = false;
  let i = 0;
  const push = () => { if (started) tokens.push(cur); cur = ''; started = false; };
  while (i < cmd.length) {
    const c = cmd[i];
    if (c === "'" || c === '"') {
      const quote = c;
      const end = quote === "'" ? cmd.indexOf("'", i + 1) : findDquoteEnd(cmd, i + 1);
      if (end === -1) return null;
      cur += cmd.slice(i + 1, end).replace(quote === '"' ? /\\(["\\$`])/g : /$^/, '$1');
      started = true;
      i = end + 1;
    } else if (c === '\\' && i + 1 < cmd.length) {
      cur += cmd[i + 1];
      started = true;
      i += 2;
    } else if (/\s/.test(c)) {
      push();
      i++;
    } else if (c === ';' || c === '|' || c === '&') {
      push();
      const two = cmd.slice(i, i + 2);
      if (two === '&&' || two === '||' || two === '|&') { tokens.push(two); i += 2; }
      else { tokens.push(c); i++; }
    } else {
      cur += c;
      started = true;
      i++;
    }
  }
  push();
  return tokens;
}

function findDquoteEnd(s, from) {
  for (let i = from; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === '"') return i;
  }
  return -1;
}

// `git restore` args → the paths it would overwrite in the working tree.
// `--staged` (-S) without `--worktree` (-W) only touches the index → none.
function restoreWorktreePaths(args) {
  const staged = args.includes('--staged') || args.includes('-S');
  const worktree = args.includes('--worktree') || args.includes('-W');
  if (staged && !worktree) return [];
  const paths = [];
  let afterDashDash = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (afterDashDash) { paths.push(a); continue; }
    if (a === '--') { afterDashDash = true; continue; }
    if (a === '-s' || a === '--source') { i++; continue; } // skip the source value
    if (a.startsWith('-')) continue;
    paths.push(a);
  }
  return paths;
}

// Pure: the working-tree paths a command would discard, or [] if it's safe to run.
export function discardPaths(cmd) {
  const tokens = tokenize(cmd);
  if (!tokens) return [];
  const paths = [];
  let i = 0;
  let atCommandPosition = true;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (OPERATORS.has(tok)) { atCommandPosition = true; i++; continue; }
    if (atCommandPosition && tok === 'git' && i + 1 < tokens.length) {
      const sub = tokens[i + 1];
      let j = i + 2;
      const args = [];
      while (j < tokens.length && !OPERATORS.has(tokens[j])) args.push(tokens[j++]);
      if (sub === 'checkout') {
        // Only the explicit pathspec form — `git checkout <branch>` passes.
        const dd = args.indexOf('--');
        if (dd !== -1) paths.push(...args.slice(dd + 1));
      } else if (sub === 'restore') {
        paths.push(...restoreWorktreePaths(args));
      }
      i = j;
      atCommandPosition = false;
      continue;
    }
    atCommandPosition = false;
    i++;
  }
  return paths;
}

// ── IO ───────────────────────────────────────────────────────────────────────

// Of the targeted paths, those with uncommitted tracked changes. Untracked
// (`??`) files are skipped — checkout/restore don't delete them.
export function dirtyTargets(paths, cwd) {
  let out;
  try {
    out = execFileSync('git', ['status', '--porcelain', '--', ...paths], {
      cwd: cwd || process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return []; // not a repo / bad pathspec — let git produce the real error
  }
  return out
    .split('\n')
    .filter((l) => l && !l.startsWith('??'))
    .map((l) => l.slice(3));
}

// The command-rule the engine loads via `use: git-hygiene/no-git-discard`. It's a
// `kind: 'command'` script: the command-guard hook runs it via evaluateCommand with
// ctx = { command, root }, and returns hits (the dirty files) to block on.
export default {
  kind: 'command',
  evaluate(rule, ctx) {
    const targets = discardPaths(ctx.command);
    if (!targets.length) return [];
    const dirty = dirtyTargets(targets, ctx.root);
    return dirty.map((f) => `would discard uncommitted edits to ${f} (stash first — \`git stash\` is the reversible path)`);
  },
};

// ── self-test ────────────────────────────────────────────────────────────────

function selfTest() {
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const cases = [
    // blocked shapes → paths extracted
    ['git checkout -- "src/pages/app/classroom/[course]/index.astro"',
      ['src/pages/app/classroom/[course]/index.astro']],
    ['git checkout HEAD -- a.ts b.ts', ['a.ts', 'b.ts']],
    ['cd foo && git checkout -- a.ts', ['a.ts']],
    ['git restore src/a.ts src/b.ts', ['src/a.ts', 'src/b.ts']],
    ['git restore --staged --worktree a.ts', ['a.ts']],
    ['git restore -s HEAD~1 a.ts', ['a.ts']],
    ['git restore -- a.ts', ['a.ts']],
    // allowed shapes → no paths
    ['git checkout main', []],
    ['git checkout -b feat/x', []],
    ['git restore --staged a.ts', []],
    ['git restore -S a.ts', []],
    ['echo "git checkout -- a.ts"', []],
    ['git log -- a.ts', []],
  ];
  let ok = true;
  for (const [cmd, want] of cases) {
    const got = discardPaths(cmd);
    if (!eq(got, want)) {
      ok = false;
      console.error(`  parse mismatch: ${cmd}\n    want ${JSON.stringify(want)} got ${JSON.stringify(got)}`);
    }
  }

  // dirty-detection against a real throwaway repo
  const dir = mkdtempSync(join(tmpdir(), 'check-git-discard-'));
  try {
    const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
    git('init', '-q');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'checkout', '-qb', 'main');
    writeFileSync(join(dir, 'dirty.txt'), 'v1\n');
    writeFileSync(join(dir, 'clean.txt'), 'v1\n');
    git('add', '.');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
    writeFileSync(join(dir, 'dirty.txt'), 'v2\n');      // tracked + modified → must block
    writeFileSync(join(dir, 'untracked.txt'), 'x\n');   // untracked → not destroyed, must pass
    const blocked = dirtyTargets(['dirty.txt'], dir);
    const cleanOk = dirtyTargets(['clean.txt'], dir);
    const untrackedOk = dirtyTargets(['untracked.txt'], dir);
    if (!(blocked.length === 1 && blocked[0] === 'dirty.txt')) { ok = false; console.error('  dirty file not detected'); }
    if (cleanOk.length !== 0) { ok = false; console.error('  clean file false positive'); }
    if (untrackedOk.length !== 0) { ok = false; console.error('  untracked file false positive'); }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(ok ? 'PASS git-hygiene/no-git-discard' : 'FAIL git-hygiene/no-git-discard');
  process.exit(ok ? 0 : 1);
}

// Guarded CLI: importing this (the engine) has no side-effects; `--test` is its proof.
const isMain = process.argv[1] && process.argv[1].endsWith('no-git-discard.mjs');
if (isMain && process.argv[2] === '--test') selfTest();
