// src/core/ran-since-edit.mjs — ADAPTER: a TURN-moment check "you changed X but never ran Y".
// The decisions are pure (./pure/ran-since-edit.mjs); this reads the session transcript and calls
// them, blocking (at the Stop hook, phase `turn`) when a matching edit came AFTER the last run.
//
// Config:  edited: ["rules/**"]     — globs whose edits require the command
//          must_run: "just test-rules"
// Contract: kind 'project' → ctx = { root }. The transcript path arrives out-of-band: ctx.transcript
// (tests) or $SIGNPOSTS_TURN_TRANSCRIPT (the turn-guard hook sets it). Fails safe: no transcript → [].

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ranSinceEdit, parseToolUses } from './pure/ran-since-edit.mjs';
export { ranSinceEdit, parseToolUses };

export default {
  kind: 'project',
  evaluate(rule, ctx) {
    const transcript = ctx.transcript ?? process.env.SIGNPOSTS_TURN_TRANSCRIPT;
    if (!transcript) return [];
    let text;
    try { text = readFileSync(transcript, 'utf8'); } catch { return []; }
    const edited = [].concat(rule.edited || []);
    if (ranSinceEdit({ events: parseToolUses(text), edited, mustRun: rule.must_run })) {
      return [`edited ${edited.join(', ')} this turn but never ran \`${rule.must_run}\` afterwards`];
    }
    return [];
  },
  test() {
    const dir = mkdtempSync(join(tmpdir(), 'sg-rse-'));
    const line = (name, input) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
    try {
      const rule = { edited: ['rules/**'], must_run: 'just test-rules' };
      const t1 = join(dir, 't1.jsonl');
      writeFileSync(t1, [line('Edit', { file_path: 'rules/local/x.mjs' }), line('Read', { file_path: 'README.md' })].join('\n'));
      const blocked = this.evaluate(rule, { root: dir, transcript: t1 }).length === 1;
      const t2 = join(dir, 't2.jsonl');
      writeFileSync(t2, [line('Edit', { file_path: 'rules/local/x.mjs' }), line('Bash', { command: 'just test-rules' })].join('\n'));
      const cleared = this.evaluate(rule, { root: dir, transcript: t2 }).length === 0;
      const t3 = join(dir, 't3.jsonl');
      writeFileSync(t3, [line('Bash', { command: 'just test-rules' }), line('Edit', { file_path: 'rules/local/x.mjs' })].join('\n'));
      const stale = this.evaluate(rule, { root: dir, transcript: t3 }).length === 1;
      const t4 = join(dir, 't4.jsonl');
      writeFileSync(t4, [line('Edit', { file_path: 'src/app.ts' })].join('\n'));
      const unrelated = this.evaluate(rule, { root: dir, transcript: t4 }).length === 0;
      const safe = this.evaluate(rule, { root: dir }).length === 0;
      return { name: 'core/ran-since-edit', pass: blocked && cleared && stale && unrelated && safe };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  },
};
