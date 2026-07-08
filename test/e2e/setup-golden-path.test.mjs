// test/e2e/setup-golden-path.test.mjs — Phase 6 (C, setup mode).
//
// A skill is prose steering an LLM, so we can't unit-test "does the agent get steered". What we
// CAN test — and do here — is the deterministic MECHANICS the `setup` mode orchestrates, run as
// the exact command sequence against a fresh install, asserting the composite end-state. (The
// agent-judgement layer — "does a real agent follow the skill?" — is the deferred `test-setup`
// eval; see the plan's follow-ons.)

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeProject, runCli, runEngine, write, read } from './harness.mjs';

test('the setup sequence readies a project end-to-end (detect → add grammar → surface rules → armed)', () => {
  const dir = makeProject();

  // 1. scaffold (step 1 of setup) — writes config + wiring, seeds the tour
  assert.equal(runCli(dir, ['--no-activate']).status, 0, 'scaffold');
  assert.match(read(dir, 'signposts.yaml') || '', /rules:/, 'scaffold left a signposts.yaml');

  // 2. detect (step 2) — a stack that needs a grammar
  write(dir, 'package.json', JSON.stringify({ name: 'app', type: 'module', dependencies: { astro: '^4.0.0' } }, null, 2));
  write(dir, 'src/page.astro', '---\nconst x = 1;\n---\n<div/>\n');
  const detect = runCli(dir, ['detect', '--json']);
  assert.equal(detect.status, 0, detect.stderr);
  assert.ok(JSON.parse(detect.stdout).recommend.includes('astro'), 'detect recommends the astro grammar');

  // 3. get the grammar in (step 3). astro has no npm package, so the skill builds the .so and
  //    registers it in sgconfig.yml customLanguages — here we drive the deterministic register step.
  assert.equal(runCli(dir, ['languages', 'register', 'astro', '--library-path', 'grammars/astro.so', '--ext', 'astro']).status, 0, 'languages register');
  assert.match(read(dir, 'sgconfig.yml') || '', /customLanguages:[\s\S]*astro/, 'grammar declared in sgconfig customLanguages');

  // 4. surface the pack's own rules (step 4) — the installed package is a diffable pack
  const diff = runCli(dir, ['diff', 'node_modules/signposts']);
  assert.equal(diff.status, 0, diff.stderr);
  assert.match(`${diff.stdout}${diff.stderr}`, /git-hygiene/, 'the pack\'s rules are visible to adopt');

  // 5. armed — a bad edit is blocked at the gate, and the seeded rule's test runs green
  write(dir, 'signposts-is-bad.yaml', 'x: 1\n');
  const blocked = runEngine(dir, ['--phase', 'commit', 'signposts-is-bad.yaml']);
  assert.equal(blocked.status, 2, `the gate should block a bad file:\n${blocked.stdout}${blocked.stderr}`);
  assert.equal(runCli(dir, ['test']).status, 0, 'signposts test green on the readied project');
});
