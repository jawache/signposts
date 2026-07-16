// src/core/ran-since-edit.mjs — a TURN-moment check: "you changed X this turn but never ran Y".
//
// Some checks belong at the end of a turn, not at commit: e.g. "you edited rules/ but never ran
// `just test-rules`". This project-kind rule reads the session transcript and blocks (at the Stop
// hook, phase `turn`) when the LAST edit to an `edited:` path came AFTER the last run of the
// `must_run:` command — i.e. the required command is stale or was never run for this change.
//
// Config:  edited: ["rules/**"]     — globs whose edits require the command
//          must_run: "just test-rules"
// Contract: kind 'project' → ctx = { root }. The transcript path arrives out-of-band: ctx.transcript
// (tests) or $SIGNPOSTS_TURN_TRANSCRIPT (the turn-guard hook sets it), mirroring runShell's env pass.
// Fails safe: no transcript / unreadable → [] (can't judge → never traps a turn).

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { globMatch } from '../hooks/signs-core.mjs';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);

// Ordered tool-use list from a transcript's JSONL: { name, file_path?, command? } per tool_use block.
export function parseToolUses(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let o; try { o = JSON.parse(t); } catch { continue; }
    const content = o.message && Array.isArray(o.message.content) ? o.message.content : null;
    if (!content) continue;
    for (const b of content) {
      if (b && b.type === 'tool_use') out.push({ name: b.name, file_path: b.input?.file_path, command: b.input?.command });
    }
  }
  return out;
}

// Pure: did an `edited`-matching edit happen AFTER the last `mustRun` command? (true = violation.)
export function ranSinceEdit({ events, edited, mustRun }) {
  if (!mustRun || !edited.length) return false;
  let lastEdit = -1, lastRun = -1;
  events.forEach((e, i) => {
    if (EDIT_TOOLS.has(e.name) && e.file_path && edited.some((g) => globMatch(g, e.file_path))) lastEdit = i;
    if (e.name === 'Bash' && e.command && e.command.includes(mustRun)) lastRun = i;
  });
  return lastEdit >= 0 && lastEdit > lastRun;
}

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
      // edit-then-no-run → block
      const t1 = join(dir, 't1.jsonl');
      writeFileSync(t1, [line('Edit', { file_path: 'rules/local/x.mjs' }), line('Read', { file_path: 'README.md' })].join('\n'));
      const blocked = this.evaluate(rule, { root: dir, transcript: t1 }).length === 1;
      // edit-then-run → pass
      const t2 = join(dir, 't2.jsonl');
      writeFileSync(t2, [line('Edit', { file_path: 'rules/local/x.mjs' }), line('Bash', { command: 'just test-rules' })].join('\n'));
      const cleared = this.evaluate(rule, { root: dir, transcript: t2 }).length === 0;
      // run-then-edit-again → block (the run is now stale)
      const t3 = join(dir, 't3.jsonl');
      writeFileSync(t3, [line('Bash', { command: 'just test-rules' }), line('Edit', { file_path: 'rules/local/x.mjs' })].join('\n'));
      const stale = this.evaluate(rule, { root: dir, transcript: t3 }).length === 1;
      // an edit OUTSIDE the globs → pass
      const t4 = join(dir, 't4.jsonl');
      writeFileSync(t4, [line('Edit', { file_path: 'src/app.ts' })].join('\n'));
      const unrelated = this.evaluate(rule, { root: dir, transcript: t4 }).length === 0;
      // no transcript → pass (fail-safe, never traps)
      const safe = this.evaluate(rule, { root: dir }).length === 0;
      return { name: 'core/ran-since-edit', pass: blocked && cleared && stale && unrelated && safe };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  },
};
