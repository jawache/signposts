import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unreferenced } from './symbols-in-sibling.mjs';

test('a referenced name is not flagged; an unreferenced one is', () => {
  const flagged = unreferenced(['foo', 'bar'], 'test(foo)');
  assert.deepEqual(flagged, ['bar']);
});

test('whole-word matching (no substring false-positive)', () => {
  assert.deepEqual(unreferenced(['bar'], 'rebarbative'), ['bar']);   // "bar" inside a word doesn't count
  assert.deepEqual(unreferenced(['bar'], 'call(bar)'), []);
});
