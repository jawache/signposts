import { test } from 'node:test';
import assert from 'node:assert/strict';
import { textBan } from './text-ban.mjs';

test('clean text has no hits', () => {
  assert.equal(textBan('all good here', ['\\bTODO\\b']).length, 0);
});

test('a banned word is flagged with its line number', () => {
  const hits = textBan('x\nleft a TODO here', ['\\bTODO\\b']);
  assert.equal(hits.length, 1);
  assert.match(hits[0], /line 2/);
});

test('multiple patterns each scan every line', () => {
  assert.equal(textBan('FIXME\nTODO', ['TODO', 'FIXME']).length, 2);
});
