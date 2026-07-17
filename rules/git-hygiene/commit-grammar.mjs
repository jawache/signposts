#!/usr/bin/env node
// rules/git-hygiene/commit-grammar.mjs — the commit header must speak Conventional Commits.
//
// A command rule (PreToolUse on Bash): before `git commit` runs, it reads the `-m` message and
// checks the FIRST line against Conventional Commits v1.0.0 — `type(scope)!: description`. A
// consistent grammar is what lets tooling derive the changelog and the SemVer bump; the TYPE
// itself is judgement (fix vs feat vs refactor) the grammar can't check.
//
// Scope is deliberately narrow (prefer false negatives over blocking real work): only a `git
// commit` carrying an inline `-m` / `--message` is judged. An editor commit (no `-m`) has no
// message to see and passes; so does anything that isn't a commit.
//
// Config:  types: [feat, fix, docs, ...]     # the allowed type words (default: the CC set + release)
// Contract: kind 'command' → ctx = { command, root }.

import { tokenize } from './no-git-discard.mjs';

const OPERATORS = new Set([';', '&&', '||', '|', '&', '|&']);
const DEFAULT_TYPES = ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert', 'release'];

// The first `-m` / `--message` value of a `git commit` in the command, or null if there's no
// judgeable commit (not a commit, or an editor commit with no inline message).
export function commitMessage(command) {
  const tokens = tokenize(command);
  if (!tokens) return null;
  let i = 0, atCommand = true;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (OPERATORS.has(tok)) { atCommand = true; i++; continue; }
    if (atCommand && tok === 'git') {
      let j = i + 1; const args = [];                                   // this git invocation's args
      while (j < tokens.length && !OPERATORS.has(tokens[j])) args.push(tokens[j++]);
      if (args[0] === 'commit') {
        for (let k = 1; k < args.length; k++) {
          const a = args[k];
          if (a === '-m' || a === '--message') return args[k + 1] ?? null;
          if (a.startsWith('-m')) return a.slice(2);                    // -mMESSAGE
          if (a.startsWith('--message=')) return a.slice('--message='.length);
        }
        return null;                                                    // a commit, but no inline message
      }
      i = j; atCommand = false; continue;
    }
    atCommand = false; i++;
  }
  return null;
}

// Pure: does the header line satisfy Conventional Commits for the given type set? The types come
// from config, so escape their regex metacharacters before building the alternation (a stray `.`
// or `|` would otherwise widen or break the check).
export function isConventional(header, types) {
  const alt = [].concat(types).map((t) => String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const re = new RegExp(`^(${alt})(\\([^)]+\\))?!?: .+`);
  return re.test(String(header).split('\n')[0]);
}

const impl = {
  kind: 'command',
  evaluate(rule, ctx) {
    const msg = commitMessage(ctx.command);
    if (msg == null) return [];                                         // nothing judgeable → pass
    const types = [].concat(rule.types || DEFAULT_TYPES);
    return isConventional(msg, types) ? [] : [`commit header "${msg.split('\n')[0]}" is not Conventional Commits (type(scope)!: description)`];
  },
};
export default impl;

// ── self-test (the .test.yml is the engine-run proof; this covers the pure parsers) ──
function selfTest() {
  const ev = (command) => impl.evaluate({}, { command });
  const cases = [
    ['git commit -m "feat(auth): renew session"', 0],
    ['git commit -m "just fixing stuff"', 1],
    ['git commit', 0],
    ['echo "git commit -m nope"', 0],
    ['git commit -m"feat: attached message form"', 0],
  ];
  let ok = true;
  for (const [cmd, want] of cases) { const got = ev(cmd).length; if (got !== want) { ok = false; console.error(`  mismatch: ${cmd} want ${want} got ${got}`); } }
  if (commitMessage('git commit --message="feat: x"') !== 'feat: x') { ok = false; console.error('  --message= not extracted'); }
  // regex metacharacters in a configured type are escaped (a `.` must not match any char)
  if (isConventional('feat: x', ['fe.t']) !== false) { ok = false; console.error('  type metachar not escaped'); }
  if (isConventional('feat: x', ['feat']) !== true) { ok = false; console.error('  literal type stopped matching'); }
  console.log(ok ? 'PASS git-hygiene/commit-grammar' : 'FAIL git-hygiene/commit-grammar');
  process.exit(ok ? 0 : 1);
}
const isMain = process.argv[1] && process.argv[1].endsWith('commit-grammar.mjs');
if (isMain && process.argv[2] === '--test') selfTest();
