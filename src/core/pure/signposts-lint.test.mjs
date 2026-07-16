import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lint } from './signposts-lint.mjs';

const bundle = (signposts) => ({ mybundle: { title: 'T', summary: 'S', signposts } });

test('a well-formed typed bundle passes', () => {
  const doc = bundle([
    { type: 'sign', id: 's', description: 'a sign', on: ['x'], text: 'hi' },
    { type: 'rule', id: 'r', description: 'a rule', use: 'core/protected-path', deny: ['y'] },
  ]);
  assert.equal(lint(doc).length, 0);
});

test('a rule missing its description is flagged', () => {
  const doc = bundle([{ type: 'rule', id: 'r', use: 'core/protected-path', deny: ['y'] }]);
  assert.ok(lint(doc).some((h) => /missing description/.test(h)));
});

test('a rule missing use: is flagged', () => {
  const doc = bundle([{ type: 'rule', id: 'r', description: 'a rule' }]);
  assert.ok(lint(doc).some((h) => /must name a script/.test(h)));
});

test('an untyped signpost is flagged', () => {
  const doc = bundle([{ id: 'r', description: 'a thing' }]);
  assert.ok(lint(doc).some((h) => /unknown `type`/.test(h)));
});

test('a custom required field is enforced', () => {
  const doc = bundle([{ type: 'sign', id: 's', description: 'd', text: 't' }]);
  assert.ok(lint(doc, ['description', 'message']).some((h) => /missing message/.test(h)));
});

test('the legacy bundles: wrapper still lints', () => {
  const doc = { bundles: { local: { rules: [{ id: 'r', description: 'ok', use: 'core/x' }] } } };
  assert.equal(lint(doc).length, 0);
});
