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
import { evaluateCommand } from '../engine.mjs';

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();

async function main() {
  let raw = '';
  try { raw = readFileSync(0, 'utf8'); } catch { return; }
  const input = JSON.parse(raw || '{}');
  const command = input?.tool_input?.command;
  if (!command) return;

  const hits = await evaluateCommand({ command, phase: 'edit', root: ROOT, logCtx: { root: ROOT, session: input.session_id } });
  if (!hits.length) return;

  const blocks = hits.map((h) => {
    const msg = h.rule.message ? `\n  ${String(h.rule.message).trim().replace(/\n/g, '\n  ')}` : '';
    return `✗ ${h.rule.id} (${h.rule.use})${msg}\n` + h.hits.map((x) => '    ' + x).join('\n');
  });
  process.stderr.write('\nSignposts — command blocked (before it ran):\n\n' + blocks.join('\n\n') + '\n\nAdjust the command, then retry.\n');
  process.exit(2);
}

main().catch(() => process.exit(0));
