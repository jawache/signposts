// test/e2e/diffable-pack.test.mjs — A1: the installed package IS a real, diffable pack.
// Before this, node_modules/signposts shipped the engine but not the pack's own rules, so
// `signposts diff node_modules/signposts` found nothing. Now it ships signposts.yaml + rules/.

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeProject, runCli, has } from './harness.mjs';

test('the tarball ships the pack\'s own signposts.yaml + rules/', () => {
  const dir = makeProject();
  assert.ok(has(dir, 'node_modules/signposts/signposts.yaml'), 'the pack ships its own signposts.yaml');
  assert.ok(has(dir, 'node_modules/signposts/rules/README.md'), 'the pack ships rules/');
  assert.ok(has(dir, 'node_modules/signposts/rules/git-hygiene/no-git-discard.mjs'), 'a real own-script ships');
});

test('`signposts diff node_modules/signposts` finds the pack\'s rules (not "no namespaces")', () => {
  const dir = makeProject();
  assert.equal(runCli(dir, ['--no-activate']).status, 0);           // gives the project a target signposts.yaml
  const r = runCli(dir, ['diff', 'node_modules/signposts']);
  assert.equal(r.status, 0, `diff exit:\n${r.stdout}${r.stderr}`);
  const out = `${r.stdout}${r.stderr}`;
  assert.doesNotMatch(out, /no installable namespaces/, 'the pack is no longer an empty diff');
  assert.match(out, /git-hygiene/, 'diff surfaces a real pack namespace to adopt');
});
