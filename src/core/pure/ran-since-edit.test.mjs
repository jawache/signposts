import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ranSinceEdit, parseToolUses } from './ran-since-edit.mjs';

const line = (name, input) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
const rule = { edited: ['rules/**'], mustRun: 'just test-rules' };
const check = (jsonl) => ranSinceEdit({ events: parseToolUses(jsonl), edited: rule.edited, mustRun: rule.mustRun });

test('edit then no run → violation', () => {
  assert.equal(check([line('Edit', { file_path: 'rules/local/x.mjs' }), line('Read', { file_path: 'README.md' })].join('\n')), true);
});

test('edit then run → clear', () => {
  assert.equal(check([line('Edit', { file_path: 'rules/local/x.mjs' }), line('Bash', { command: 'just test-rules' })].join('\n')), false);
});

test('run then edit again → stale, violation', () => {
  assert.equal(check([line('Bash', { command: 'just test-rules' }), line('Edit', { file_path: 'rules/local/x.mjs' })].join('\n')), true);
});

test('an edit outside the globs → clear', () => {
  assert.equal(check([line('Edit', { file_path: 'src/app.ts' })].join('\n')), false);
});
