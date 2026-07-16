import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bannedCommand } from './command-guard.mjs';

test('a safe command has no hits', () => {
  assert.equal(bannedCommand('git status', ['git\\s+reset\\s+--hard']).length, 0);
});

test('a banned command is flagged', () => {
  const bans = ['git\\s+checkout\\s+--', 'git\\s+reset\\s+--hard'];
  assert.equal(bannedCommand('git checkout -- src/x.ts', bans).length, 1);
});

test('every matching pattern contributes a hit', () => {
  assert.equal(bannedCommand('rm -rf / ; rm -rf /tmp', ['rm -rf /', 'rm -rf /tmp']).length, 2);
});
