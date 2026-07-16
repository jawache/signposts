// src/core/pure/ran-since-edit.mjs — PURE decisions for the turn-moment "you changed X but never
// ran Y" rule. No IO — the adapter (../ran-since-edit.mjs) reads the transcript and calls these.

import { matchAny } from '../../util.mjs';

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

// Did an `edited`-matching edit happen AFTER the last `mustRun` command? (true = violation.)
export function ranSinceEdit({ events, edited, mustRun }) {
  if (!mustRun || !edited.length) return false;
  let lastEdit = -1, lastRun = -1;
  events.forEach((e, i) => {
    if (EDIT_TOOLS.has(e.name) && e.file_path && matchAny(e.file_path, edited)) lastEdit = i;
    if (e.name === 'Bash' && e.command && e.command.includes(mustRun)) lastRun = i;
  });
  return lastEdit >= 0 && lastEdit > lastRun;
}
