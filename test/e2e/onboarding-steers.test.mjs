// test/e2e/onboarding-steers.test.mjs — the harness's job isn't only "does it run" but
// "does it STEER". These assert the guidance a real consumer sees at onboarding. The beats
// that depend on later phases are `todo` placeholders wired to flip on when those land.

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeProject, runCli, write } from './harness.mjs';

test('diff of a legacy flat-format source prints the WHY, not "(no namespaces)" (Phase 1)', () => {
  const dir = makeProject();
  assert.equal(runCli(dir, ['--no-activate']).status, 0);          // gives the project a grouped target
  // A source repo in the old flat layout (signs: as a bare array).
  write(dir, 'legacy-src/signposts.yaml', 'signs:\n  - id: old\n    globs: ["**"]\n    text: heed me\n');
  const r = runCli(dir, ['diff', 'legacy-src']);
  assert.match(`${r.stdout}${r.stderr}`, /legacy flat format/i,
    `legacy source should be diagnosed, not silently empty:\n${r.stdout}${r.stderr}`);
});

test('scaffold output names node_modules/signposts as the diff source (Phase 3)', () => {
  const dir = makeProject();
  const r = runCli(dir, ['--no-activate']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(`${r.stdout}${r.stderr}`, /diff node_modules\/signposts/,
    'scaffold should point the user at the installed pack to diff');
});

test('`signposts test` runs a seeded rule\'s .test.yml in a scaffolded project (Phase 4)', () => {
  const dir = makeProject();
  assert.equal(runCli(dir, ['--no-activate']).status, 0);
  const r = runCli(dir, ['test']);
  assert.equal(r.status, 0, `signposts test should pass on a fresh scaffold:\n${r.stdout}${r.stderr}`);
  assert.match(`${r.stdout}${r.stderr}`, /functional-style\.test\.yml/, 'the seeded rule\'s test ran');
});

test('`signposts test` surfaces an unknown ast-grep language (Phase 4)', () => {
  const dir = makeProject();
  assert.equal(runCli(dir, ['--no-activate']).status, 0);
  // an ast-grep rule authored for a language the base install doesn't know
  write(dir, 'rules/mine/ast-grep/x.yml', 'id: uses-astro\nlanguage: astro\nrule:\n  pattern: let $X = $Y\n');
  const r = runCli(dir, ['test']);
  assert.notEqual(r.status, 0, 'an unregistered language must fail the test run, not silently pass');
  assert.match(`${r.stdout}${r.stderr}`, /unknown ast-grep language|astro/, 'names the offending language');
});
