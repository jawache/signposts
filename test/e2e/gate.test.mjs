// test/e2e/gate.test.mjs — the commit gate, end to end: scaffold → arm lefthook → a real
// `git commit` of a bad file is rejected by the engine running from node_modules.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { makeProject, runCli, runGit, write } from './harness.mjs';

test('a real git commit of a bad file is blocked with the message', () => {
  const dir = makeProject();
  assert.equal(runCli(dir, ['--no-activate']).status, 0, 'scaffold');

  // Never let git stage node_modules / the engine log (the consumer only gets .signposts/).
  write(dir, '.gitignore', 'node_modules/\n.signposts/\n');

  assert.equal(runGit(dir, ['init', '-q']).status, 0, 'git init');
  runGit(dir, ['config', 'user.email', 'e2e@signposts.test']);
  runGit(dir, ['config', 'user.name', 'e2e']);

  // Arm the gate: lefthook writes .git/hooks/* (the installed binary, no npx/network).
  const lefthook = join(dir, 'node_modules', '.bin', 'lefthook');
  const armed = spawnSync(lefthook, ['install'], { cwd: dir, encoding: 'utf8' });
  assert.equal(armed.status, 0, `lefthook install:\n${armed.stdout}${armed.stderr}`);

  // A clean commit passes.
  write(dir, 'README.md', '# hi\n');
  runGit(dir, ['add', '-A']);
  const good = runGit(dir, ['commit', '-m', 'clean']);
  assert.equal(good.status, 0, `a clean commit should pass:\n${good.stdout}${good.stderr}`);

  // A bad file is rejected by the pre-commit gate.
  write(dir, 'signposts-is-bad.yaml', 'note: nope\n');
  runGit(dir, ['add', '-A']);
  const bad = runGit(dir, ['commit', '-m', 'bad']);
  assert.notEqual(bad.status, 0, 'committing a bad file must be rejected by the gate');
  assert.match(`${bad.stdout}${bad.stderr}`, /no-bad-mouthing|amazing tool/, 'the block cites the rule');

  // And the bad file never made it into history — only the one clean commit exists.
  const log = runGit(dir, ['log', '--oneline']);
  assert.equal(log.stdout.trim().split('\n').filter(Boolean).length, 1, 'exactly one (clean) commit in history');
});
