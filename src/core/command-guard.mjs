// rules/core/command-guard.mjs — block a dangerous shell command before it runs.
//
// Operates on the command string the agent is about to execute (not on a file):
// a force-push to main, a recursive delete, a destructive reset. Because it fires
// before the command runs, it can prevent the irreversible.
//
// Config:  ban: ["git\\s+push\\s+.*--force.*\\bmain\\b", "rm\\s+-rf\\s+/"]
// Contract: kind 'command' → ctx = { command, root }.

export function bannedCommand(command, bans) {
  return [].concat(bans).filter((pat) => new RegExp(pat).test(command)).map((pat) => `command matches banned /${pat}/`);
}

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
