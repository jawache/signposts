import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skipForChanged, failureExcerpt } from './tool-gate.mjs';

test('no changed globs → never skip', () => {
  assert.equal(skipForChanged(['a.ts'], undefined), false);
  assert.equal(skipForChanged(['a.ts'], []), false);
});

test('changed globs → skip only when nothing matches', () => {
  assert.equal(skipForChanged(['src/x.mjs', 'README.md'], ['site/**']), true);   // site untouched → skip
  assert.equal(skipForChanged(['site/src/x.astro'], ['site/**']), false);        // site touched → run
});

test('no files to judge → run (fail-safe, never silently skip)', () => {
  assert.equal(skipForChanged([], ['site/**']), false);
  assert.equal(skipForChanged(undefined, ['site/**']), false);
});

test('failureExcerpt surfaces the actual error lines first', () => {
  const out = ['Running tests', 'ok 1', 'ok 2', '✖ the widget renders', 'AssertionError: expected 1 to equal 2', 'ℹ tests 3', 'ℹ pass 2', 'ℹ fail 1'].join('\n');
  const ex = failureExcerpt(out);
  assert.match(ex, /AssertionError/);
  assert.match(ex, /widget renders/);
  assert.ok(!ex.includes('Running tests'), 'the noise chatter is dropped');
});

test('failureExcerpt falls back to the tail when nothing looks like an error, and stays capped', () => {
  const ex = failureExcerpt(Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n'));
  assert.ok(ex.split('\n').length <= 8);
  assert.match(ex, /line 39/);   // the tail
});
