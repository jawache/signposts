// src/core/command-guard.mjs — ADAPTER: block a dangerous shell command before it runs.
// The decision is pure (./pure/command-guard.mjs); this wires it to the engine's command contract.
//
// Config:  ban: ["git\\s+push\\s+.*--force.*\\bmain\\b", "rm\\s+-rf\\s+/"]
// Contract: kind 'command' → ctx = { command, root }.

import { bannedCommand } from './pure/command-guard.mjs';
export { bannedCommand };

export default {
  kind: 'command',
  evaluate(rule, ctx) { return bannedCommand(ctx.command, rule.ban); },
  test() {
    const bans = ['git\\s+checkout\\s+--', 'git\\s+reset\\s+--hard'];
    const legal = bannedCommand('git status', bans).length === 0;
    const illegal = bannedCommand('git checkout -- src/x.ts', bans).length === 1;
    return { name: 'core/command-guard', pass: legal && illegal };
  },
};
