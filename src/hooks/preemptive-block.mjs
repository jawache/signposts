#!/usr/bin/env node
// .claude/hooks/preemptive-block.mjs — the pre-emptive block (edit-phase trigger).
//
// A normal commit-time / PostToolUse check sees a file only AFTER it lands on disk.
// This PreToolUse hook sees the *proposed* Edit/Write while disk is still untouched,
// reconstructs the would-be file in memory, and runs the category engine over it at
// phase `edit`. On a violation it returns a PreToolUse `deny` whose reason is fed
// back to Claude, which self-corrects BEFORE the write — the headline capability.
//
//   • Rules + dispatch live in src/engine.mjs (ast-grep A, plus B–E/P instances).
//   • This file owns only the edit-time concern: reconstruct, then ask the engine.
//   • Reconstruct covers Edit (old→new), MultiEdit (fold edits), Write (full content).
//
// Contract: PreToolUse hooks read the tool call as JSON on stdin and may print a
// decision as JSON on stdout (exit 0). To block:
//   {"hookSpecificOutput":{"hookEventName":"PreToolUse",
//     "permissionDecision":"deny","permissionDecisionReason":"…"}}
//
// FAILS SAFE: any error (bad input, parse failure, missing dep) → exit 0 with no
// output, so a broken hook can never wedge the user's edit. Set SIGNPOSTS_FORCE_ERROR=1
// to exercise that path.

import { readFileSync, appendFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { evaluate, partitionBySeverity } from '../engine.mjs';
import { isOff } from '../schema.mjs';

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();

// Optional trace: when SIGNPOSTS_DEBUG is set, append a line per stage to
// .work/preemptive-block-trace.log (the fail-safe otherwise hides bugs).
function trace(msg) {
  if (!process.env.SIGNPOSTS_DEBUG) return;
  try {
    appendFileSync(join(ROOT, '.work/preemptive-block-trace.log'), `${new Date().toISOString()} ${msg}\n`);
  } catch {}
}

// ── helpers ──────────────────────────────────────────────────────────────────

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function resolvePath(p) {
  if (!p) return null;
  return isAbsolute(p) ? p : join(ROOT, p);
}

function readFileOr(path, fallback = '') {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return fallback;
  }
}

// Apply one Edit op the way the Edit tool does: replace the first occurrence of
// old_string with new_string (or every occurrence when replace_all).
function applyEdit(content, { old_string = '', new_string = '', replace_all = false }) {
  if (old_string === '') return new_string; // Write-via-Edit edge; treat as content
  if (replace_all) return content.split(old_string).join(new_string);
  const idx = content.indexOf(old_string);
  if (idx === -1) return null; // can't locate anchor → can't reconstruct → bail (fail safe)
  return content.slice(0, idx) + new_string + content.slice(idx + old_string.length);
}

// Reconstruct the file *as it would be on disk* after this tool call, without writing.
function reconstruct(tool_name, tool_input) {
  const path = resolvePath(tool_input.file_path);
  if (!path) return null;

  if (tool_name === 'Write') {
    return { path, content: tool_input.content ?? '' };
  }

  if (tool_name === 'Edit') {
    const base = readFileOr(path);
    const next = applyEdit(base, tool_input);
    return next === null ? null : { path, content: next };
  }

  if (tool_name === 'MultiEdit') {
    let content = readFileOr(path);
    for (const edit of tool_input.edits || []) {
      content = applyEdit(content, edit);
      if (content === null) return null;
    }
    return { path, content };
  }

  return null;
}

// ── compose the deny reason from engine violations ────────────────────────────

function denyReason(violations) {
  const blocks = violations.map((v) => {
    const head = `[${v.rule.id}]${v.path ? ` · ${v.path}` : ''}`;
    const msg = v.rule.message ? '\n  ' + String(v.rule.message).trim().replace(/\n/g, '\n  ') : '';
    const hits = v.hits.map((h) => '    ' + h).join('\n');
    return head + msg + '\n' + hits;
  });
  return [
    'Signposts — pre-emptive block (caught before the write landed)',
    '',
    ...blocks,
    '',
    'Adjust the change so it passes, then retry.',
  ].join('\n');
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    })
  );
}

// A `severity: warn` rule informs without blocking: additionalContext, no deny decision.
function warnReason(violations) {
  const items = violations.map((v) => {
    const head = `[${v.rule.id}]${v.path ? ` · ${v.path}` : ''}`;
    const msg = v.rule.message ? '\n  ' + String(v.rule.message).trim().replace(/\n/g, '\n  ') : '';
    return head + msg + '\n' + v.hits.map((h) => '    ' + h).join('\n');
  });
  return ['Signposts — warning (not blocking):', '', ...items].join('\n');
}
function inform(context) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: context } }));
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (process.env.SIGNPOSTS_FORCE_ERROR) throw new Error('forced error (fail-safe test)');
  if (isOff(ROOT)) { trace('off switch → allow'); return; }    // off switch: pre-emptive block silenced

  const raw = readStdin();
  trace(`invoked · stdin ${raw.length}B`);
  const input = JSON.parse(raw || '{}');
  const { tool_name, tool_input } = input;
  if (!tool_name || !tool_input) { trace('no tool_name/tool_input → allow'); return; }

  const file = reconstruct(tool_name, tool_input);
  if (!file) { trace(`${tool_name}: could not reconstruct → allow`); return; }
  trace(`${tool_name}: reconstructed ${file.path} (${file.content.length}B)`);

  const violations = await evaluate({
    phase: 'edit',
    files: [file.path],
    root: ROOT,
    getContent: () => file.content,
    logCtx: { root: ROOT, session: input.session_id },
  });
  const { blocks, warns } = partitionBySeverity(violations);
  trace(`eval → ${blocks.length ? `DENY (${blocks.length})` : warns.length ? `WARN (${warns.length})` : 'allow'}`);
  if (blocks.length) { deny(denyReason(blocks)); return; }     // block wins if both
  if (warns.length) inform(warnReason(warns));
}

main().catch((e) => {
  // FAIL SAFE: never break the user's edit because the hook stumbled.
  trace(`FAILED SAFE: ${e && e.stack ? e.stack.split('\n')[0] : e}`);
  process.exit(0);
});
