// test/e2e/wave2.test.mjs — B wave-2: the pack lifecycle as-installed (install · refresh ·
// uninstall), plus the offline propagate pattern (a rule pushed to a local bare git remote).
// All offline — a local folder source and a local bare remote, no network, no auth.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeProject, runCli, write, read, has } from './harness.mjs';

// A hub source: the `neon` namespace with a sign, a rule, an own-script (+ an optional 2nd rule).
function makeHub({ extraRule = false } = {}) {
  const hub = mkdtempSync(join(tmpdir(), 'sg-hub-'));
  mkdirSync(join(hub, 'rules', 'neon'), { recursive: true });
  writeFileSync(join(hub, 'rules', 'neon', 'no-raw-pool.mjs'), 'export default { kind: "content", evaluate() { return []; } };\n');
  const rules = ['rules:', '  neon:', '    - id: no-raw-pool', '      use: neon/no-raw-pool', '      on: ["src/**"]'];
  if (extraRule) rules.push('    - id: no-select-star', '      use: core/text-ban', '      on: ["src/**"]', '      ban: ["SELECT count"]', '      message: "count via the ORM"');
  writeFileSync(join(hub, 'signposts.yaml'),
    ['signs:', '  neon:', '    - id: db-area', '      globs: ["src/db/**"]', '      text: append-only', ...rules, ''].join('\n'));
  return hub;
}

test('install: a namespace lands from a local source (rules, sign, script, provenance)', () => {
  const dir = makeProject();
  assert.equal(runCli(dir, ['--no-activate']).status, 0);
  const hub = makeHub();
  const r = runCli(dir, ['install', hub, 'neon']);
  assert.equal(r.status, 0, `install:\n${r.stdout}${r.stderr}`);
  const yaml = read(dir, 'signposts.yml') || '';
  assert.match(yaml, /no-raw-pool/, 'rule merged into the neon namespace');
  assert.match(yaml, /db-area/, 'sign merged too');
  assert.ok(has(dir, 'rules/neon/no-raw-pool.mjs'), 'own-script copied in');
  assert.match(yaml, /packs:[\s\S]*neon/, 'provenance recorded in packs:');
});

test('refresh: pulls a new upstream rule and keeps a local script edit (3-way)', () => {
  const dir = makeProject();
  assert.equal(runCli(dir, ['--no-activate']).status, 0);
  const hub = makeHub();
  assert.equal(runCli(dir, ['install', hub, 'neon']).status, 0);

  // local edit to the installed script (upstream won't touch this line)
  const script = 'rules/neon/no-raw-pool.mjs';
  write(dir, script, '// LOCAL EDIT — keep me\n' + read(dir, script));

  // upstream gains a second rule (signposts.yaml only; the script is unchanged)
  writeFileSync(join(hub, 'signposts.yaml'), readFileSync(join(hub, 'signposts.yaml'), 'utf8')
    .replace('      on: ["src/**"]\n', '      on: ["src/**"]\n    - id: no-select-star\n      use: core/text-ban\n      on: ["src/**"]\n      ban: ["SELECT count"]\n      message: "count via the ORM"\n'));

  const r = runCli(dir, ['refresh']);
  assert.equal(r.status, 0, `refresh:\n${r.stdout}${r.stderr}`);
  assert.match(read(dir, 'signposts.yml') || '', /no-select-star/, 'refresh pulled the new upstream rule');
  assert.match(read(dir, script) || '', /LOCAL EDIT — keep me/, 'the local script edit survived');
});

test('uninstall --pack: removes the namespace footprint, preserves the rest', () => {
  const dir = makeProject();
  assert.equal(runCli(dir, ['--no-activate']).status, 0);
  const hub = makeHub();
  assert.equal(runCli(dir, ['install', hub, 'neon']).status, 0);
  assert.ok(has(dir, 'rules/neon/no-raw-pool.mjs'));

  const r = runCli(dir, ['uninstall', '--pack', 'neon']);
  assert.equal(r.status, 0, `uninstall:\n${r.stdout}${r.stderr}`);
  assert.doesNotMatch(read(dir, 'signposts.yml') || '', /no-raw-pool/, 'the pack\'s rule is gone');
  assert.ok(!has(dir, 'rules/neon/no-raw-pool.mjs'), 'the pack\'s script is removed');
  // user + scaffold files untouched
  assert.ok(has(dir, '.githooks/pre-commit') && has(dir, 'rules/examples/no-hardcoded-secret.sh'), 'the rest of the project is intact');
});

test('propagate: a rule is pushed as a branch to a local bare remote (offline git pattern)', () => {
  const dir = makeProject();
  assert.equal(runCli(dir, ['--no-activate']).status, 0);
  const git = (...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  write(dir, '.gitignore', 'node_modules/\n.signposts/\n');
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  git('add', '-A'); git('commit', '-qm', 'base');

  // a bare remote stands in for the hub / upstream
  const remote = mkdtempSync(join(tmpdir(), 'sg-remote-'));
  spawnSync('git', ['init', '--bare', '-q', remote]);
  git('remote', 'add', 'hub', remote);

  // the propagate git steps the skill runs: branch, author a rule, commit, push
  git('checkout', '-qb', 'propagate/neon');
  write(dir, 'rules/neon/no-raw-pool.mjs', 'export default { kind: "content", evaluate() { return []; } };\n');
  git('add', '-A'); git('commit', '-qm', 'propagate: neon/no-raw-pool');
  const push = git('push', '-q', 'hub', 'propagate/neon');
  assert.equal(push.status, 0, `push to the bare remote:\n${push.stderr}`);

  // the remote received the branch with the rule file
  const ls = spawnSync('git', ['-C', remote, 'ls-tree', '-r', '--name-only', 'propagate/neon'], { encoding: 'utf8' });
  assert.match(ls.stdout, /rules\/neon\/no-raw-pool\.mjs/, 'the bare remote has the propagated rule on its branch');
  // (`gh pr create` is the final skill step — asserted at command level; not run here: no gh/network.)
});
