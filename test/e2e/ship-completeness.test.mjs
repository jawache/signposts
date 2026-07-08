// test/e2e/ship-completeness.test.mjs — the exact guard for the yaml devDep bug.
//
// The engine statically imports `yaml` and dynamically imports `@ast-grep/napi`. When those
// sat in devDependencies, a real `npm install signposts` left them absent and the engine
// died the instant a hook ran. This asserts every bare specifier the SHIPPED package imports
// resolves from a clean install — and proves the guard actually goes red when one is missing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeProject, unresolvedSpecs, removeDep } from './harness.mjs';

test('every runtime import resolves in a clean install', () => {
  const dir = makeProject();
  const bad = unresolvedSpecs(dir);
  assert.deepEqual(bad, [], `these bare specifiers do not resolve as-installed: ${bad.join(', ')}`);
});

test('GUARD proves it guards — removing a runtime dep (yaml) goes red', () => {
  const dir = makeProject();
  removeDep(dir, 'yaml');
  const bad = unresolvedSpecs(dir);
  assert.ok(bad.includes('yaml'),
    `deleting node_modules/yaml should make the guard report it unresolved; got: ${bad.join(', ') || '(none)'}`);
});
