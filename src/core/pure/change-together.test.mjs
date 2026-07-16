import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changeTogether } from './change-together.mjs';

const groups = [{ if: ['package.json'], 'then-any': ['package-lock.json', 'pnpm-lock.yaml'] }];

test('a trigger without its companion blocks', () => {
  assert.equal(changeTogether({ changed: ['package.json', 'src/x.mjs'], groups }).length, 1);
});

test('trigger + companion clears', () => {
  assert.equal(changeTogether({ changed: ['package.json', 'package-lock.json'], groups }).length, 0);
});

test('no trigger → nothing to enforce', () => {
  assert.equal(changeTogether({ changed: ['src/x.mjs', 'README.md'], groups }).length, 0);
});
