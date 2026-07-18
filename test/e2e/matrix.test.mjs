// test/e2e/matrix.test.mjs — D: the delete + block matrix, driven through the real HOOKS
// as-installed. Delete (rm/git rm/mv via Bash) is guarded at PreToolUse. A rule is ABSOLUTE:
// it blocks or it doesn't exist — there is no warn tier and no per-command escape hatch.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { makeProject, runCli, runEngine, write } from './harness.mjs';

// A minimal project with a delete-guard and a content rule — both block, nothing warns.
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
    '    - id: no-todo',
    '      use: core/text-ban',
    '      on: ["**/*.md"]',
    '      ban: ["TODO"]',
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

test('delete: an unprotected path passes; a trailing comment does NOT bypass the block', () => {
  const dir = ready();
  assert.equal(runHook(dir, 'command-guard.mjs', bash('rm build/output.js')).status, 0, 'unprotected path passes');
  // The delete-guard is absolute — there is no `# signposts-delete-ok` escape hatch any more.
  assert.equal(runHook(dir, 'command-guard.mjs', bash('rm secret/creds.ts # signposts-delete-ok')).status, 2,
    'a protected delete still blocks — no marker can clear it');
});

test('edit × block: a content rule DENIES the write (permissionDecision deny)', () => {
  const dir = ready();
  const r = runHook(dir, 'preemptive-block.mjs', { tool_name: 'Write', tool_input: { file_path: 'notes.md', content: 'a TODO here\n' } });
  assert.equal(r.status, 0, 'the PreToolUse hook denies via JSON, not an exit code');
  assert.match(r.stdout, /"permissionDecision":\s*"deny"/, 'a rule denies the edit — there is no inform-only tier');
  assert.match(r.stdout, /leftover TODO/, 'surfaces the message');
});

test('commit × block: a content rule fails the commit gate (exit 2)', () => {
  const dir = ready();
  write(dir, 'notes.md', 'a TODO here\n');
  const r = runEngine(dir, ['--phase', 'commit', 'notes.md']);
  assert.equal(r.status, 2, 'a rule blocks the commit gate');
  assert.match(r.stderr, /leftover TODO/, 'surfaces the message');
});
