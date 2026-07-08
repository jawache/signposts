#!/usr/bin/env node
// .claude/hooks/command-guard.mjs — PreToolUse Bash hook: run the command-guard rules.
//
// The generic runner for every `kind: 'command'` rule in signposts.yaml (e.g. a
// git-hygiene rule that blocks a commit carrying Claude/Anthropic attribution). It
// replaces bespoke per-concern shell hooks: the ban lives as DATA in signposts.yaml,
// not as a copied .sh — so a pack can carry it. (check-git-discard stays bespoke: it
// needs live git state a regex can't see.)
//
// Contract: PreToolUse hooks read the tool call as JSON on stdin. A non-zero exit +
// a message on stderr blocks the command and feeds the reason back to the agent.
// FAILS SAFE: any error → exit 0, so a hook bug never wedges a command.

import { readFileSync } from 'node:fs';
import { evaluateCommand, evaluateDelete, partitionBySeverity, formatViolation } from '../engine.mjs';

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();

async function main() {
  let raw = '';
  try { raw = readFileSync(0, 'utf8'); } catch { return; }
  const input = JSON.parse(raw || '{}');
  const command = input?.tool_input?.command;
  if (!command) return;
  const logCtx = { root: ROOT, session: input.session_id };

  // Two rails on the same PreToolUse Bash event: command rules (a banned command shape) and
  // DELETE rules (a path/content rule guarding what an rm/git rm/mv would remove).
  const hits = [
    ...await evaluateCommand({ command, phase: 'edit', root: ROOT, logCtx }),
    ...await evaluateDelete({ command, phase: 'delete', root: ROOT, logCtx }),
  ];
  if (!hits.length) return;

  const { blocks, warns } = partitionBySeverity(hits);
  if (blocks.length) {                                          // block → exit 2, stderr fed back
    process.stderr.write('\nSignposts — command blocked (before it ran):\n\n' + blocks.map(formatViolation).join('\n\n') + '\n\nAdjust the command, then retry.\n');
    process.exit(2);
  }
  if (warns.length) {                                           // warn → inform, never block
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'Signposts warning (not blocking):\n\n' + warns.map(formatViolation).join('\n\n') } }));
  }
}

main().catch(() => process.exit(0));
