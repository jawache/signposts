#!/usr/bin/env node
// src/hooks/turn-guard.mjs — the TURN moment: a Stop hook that runs `at: turn` rules when the
// agent tries to end its turn. A failing rule holds the turn open with a re-guiding reason
// ("you changed rules/ but never ran `just test-rules`"). Most checks belong at `commit` (the
// gate sees the whole change, once) — `turn` is for the rare case where the turn boundary is
// genuinely the right moment.
//
// NEVER TRAPS: the loop guard is Claude Code's own `stop_hook_active`. When we block, Claude
// continues; on its next attempt to stop, the payload carries stop_hook_active=true and we bow
// out — so an unsatisfiable check nags at most once, then the turn ends. No custom retry counter.
//
// Contract: Stop hooks read the tool call as JSON on stdin; `{ "decision": "block", "reason" }`
// holds the turn open and feeds the reason back. FAILS SAFE: any error → exit 0 (turn proceeds).

import { readFileSync } from 'node:fs';
import { evaluate, partitionBySeverity, formatViolation } from '../engine.mjs';
import { isOff } from '../schema.mjs';

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();

async function main() {
  if (isOff(ROOT)) return;                                     // off switch: turn checks silenced
  let raw = '';
  try { raw = readFileSync(0, 'utf8'); } catch { return; }
  const input = JSON.parse(raw || '{}');

  // Loop guard: we already blocked once this turn-chain and Claude continued — do NOT block again.
  if (input.stop_hook_active) return;

  // `at: turn` rules (e.g. ran-since-edit) read the session transcript; hand it over out-of-band,
  // the same way runShell passes SIGNPOSTS_ROOT/PHASE (the engine's project ctx is only { root }).
  if (input.transcript_path) process.env.SIGNPOSTS_TURN_TRANSCRIPT = input.transcript_path;

  const violations = await evaluate({
    phase: 'turn', files: [], root: ROOT, getContent: () => '',
    logCtx: { root: ROOT, session: input.session_id },
  });
  if (!violations.length) return;

  const { blocks, warns } = partitionBySeverity(violations);
  if (blocks.length) {
    process.stdout.write(JSON.stringify({
      decision: 'block',
      reason: 'Signposts — turn held open:\n\n' + blocks.map(formatViolation).join('\n\n') + '\n\nDo the above, then end your turn.',
    }));
    return;                                                    // exit 0: the JSON decision does the blocking
  }
  if (warns.length) process.stderr.write('\n⚠ Signposts turn warning (not blocking):\n' + warns.map(formatViolation).join('\n\n') + '\n');
}

main().catch(() => process.exit(0));
