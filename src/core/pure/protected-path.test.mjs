import { test } from 'node:test';
import assert from 'node:assert/strict';
import { protectedPathHits } from './protected-path.mjs';

test('an unprotected path passes', () => {
  assert.equal(protectedPathHits('src/app/x.ts', ['src/generated/**', 'legacy/**']).length, 0);
});

test('a protected path is flagged', () => {
  assert.equal(protectedPathHits('src/generated/api.ts', ['src/generated/**']).length, 1);
});
