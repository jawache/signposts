// test/e2e/matrix.test.mjs — D: the event × response matrix, driven through the real HOOKS
// as-installed. Delete (rm/git rm/mv via Bash) is guarded at PreToolUse; `severity: warn`
// informs without blocking, on both edit and commit.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { makeProject, runCli, runEngine, write } from './harness.mjs';

// A minimal project with one delete-guard (block) and one warn rule.
function ready() {
  const dir = makeProject();
  assert.equal(runCli(dir, ['--no-activate']).status, 0);
  write(dir, 'signposts.yml', [           // overwrite the scaffolded config (resolver prefers .yml)
    'rules:',
    '  local:',
    '    - id: no-del',
    '      use: core/protected-path',
    '      deny: ["secret/**"]',
    '      when: [delete]',
    '      message: "protected path — do not delete"',
    '    - id: warn-todo',
    '      use: core/text-ban',
    '      on: ["**/*.md"]',
    '      ban: ["TODO"]',
    '      severity: warn',
    '      message: "leftover TODO"',
    '',
  ].join('\n'));
  return dir;
}
function runHook(dir, rel, input) {
  return spawnSync('node', [join(dir, 'node_modules', 'signposts', 'src', 'hooks', rel)],
    { cwd: dir, encoding: 'utf8', input: JSON.stringify(input), env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
}
const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });

test('delete × block: rm of a protected path is blocked at PreToolUse', () => {
  const dir = ready();
  const r = runHook(dir, 'command-guard.mjs', bash('rm secret/creds.ts'));
  assert.equal(r.status, 2, `rm of a protected path should block (exit 2):\n${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /protected path/, 'cites the rule message');
});

test('delete: an unprotected path, and the # signposts-delete-ok override, both pass', () => {
  const dir = ready();
  assert.equal(runHook(dir, 'command-guard.mjs', bash('rm build/output.js')).status, 0, 'unprotected path passes');
  assert.equal(runHook(dir, 'command-guard.mjs', bash('rm secret/creds.ts # signposts-delete-ok')).status, 0, 'override passes');
});

test('edit × warn: a warn rule INFORMS without blocking (additionalContext, not deny)', () => {
  const dir = ready();
  const r = runHook(dir, 'preemptive-block.mjs', { tool_name: 'Write', tool_input: { file_path: 'notes.md', content: 'a TODO here\n' } });
  assert.equal(r.status, 0, 'warn must never block the edit');
  assert.match(r.stdout, /additionalContext/, 'informs via additionalContext');
  assert.doesNotMatch(r.stdout, /"permissionDecision":\s*"deny"/, 'a warn is NOT a deny');
  assert.match(r.stdout, /leftover TODO|warning/, 'surfaces the warning');
});

test('commit × warn: a warn rule prints a warning but the commit passes (exit 0)', () => {
  const dir = ready();
  write(dir, 'notes.md', 'a TODO here\n');
  const r = runEngine(dir, ['--phase', 'commit', 'notes.md']);
  assert.equal(r.status, 0, 'a warn rule must not fail the commit gate');
  assert.match(r.stderr, /warning|leftover TODO/i, 'the warning is surfaced');
});
