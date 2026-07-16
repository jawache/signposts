import { test } from 'node:test';
import assert from 'node:assert/strict';
import { overBudget, parseSize, globHit } from './max-size.mjs';

const budgets = [{ glob: '**/*.{png,jpg}', max: '200KB', hint: 'compress it' }, { glob: '**/*', max: '500KB' }];
const ev = (files) => overBudget({ files, budgets, allowMarker: '.budget-ok.' });

test('under the image budget passes', () => {
  assert.equal(ev([{ path: 'public/a.png', bytes: 100 * 1024 }]).length, 0);
});

test('over the image budget blocks', () => {
  assert.equal(ev([{ path: 'public/a.png', bytes: 300 * 1024 }]).length, 1);
});

test('the catch-all budget applies to other files', () => {
  assert.equal(ev([{ path: 'public/b.bin', bytes: 600 * 1024 }]).length, 1);
});

test('the allow_marker opts a file out', () => {
  assert.equal(ev([{ path: 'public/big.budget-ok.png', bytes: 900 * 1024 }]).length, 0);
});

test('parseSize understands units', () => {
  assert.equal(parseSize('200KB'), 204800);
  assert.equal(parseSize('1.5 MB'), 1572864);
  assert.equal(parseSize(4096), 4096);
});

test('globHit expands braces', () => {
  assert.ok(globHit('**/*.{png,jpg}', 'a/b/c.jpg'));
  assert.ok(!globHit('**/*.{png,jpg}', 'a/b/c.gif'));
});
