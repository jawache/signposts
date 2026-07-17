import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inScope } from './scope.mjs';

test('on: globs decide scope when present', () => {
  assert.equal(inScope('src/lib/x.ts', ['src/lib/**'], null), true);
  assert.equal(inScope('src/app/x.ts', ['src/lib/**'], null), false);
});

test('script scope globs decide when there is no on:', () => {
  // a deny-style rule (protected-path) reports matched via its deny globs — the poster case
  assert.equal(inScope('src/generated/api.ts', null, ['src/generated/**']), true);
  assert.equal(inScope('src/app/x.ts', null, ['src/generated/**']), false);
});

test('on: wins over script scope globs', () => {
  assert.equal(inScope('src/app/x.ts', ['src/app/**'], ['src/generated/**']), true);
});

test('no scope at all → watches everything', () => {
  assert.equal(inScope('anything/at/all.ts', null, null), true);
  assert.equal(inScope('anything/at/all.ts', [], null), true);   // empty on: is not "nothing"
});

test('deny-style and on-style report matched identically for the same globs', () => {
  const g = ['vendor/**'];
  assert.equal(inScope('vendor/x.js', g, null), inScope('vendor/x.js', null, g));
  assert.equal(inScope('src/x.js', g, null), inScope('src/x.js', null, g));
});
