// src/core/pure/command-guard.mjs — PURE decision: does a shell command match a banned pattern?
// No IO — the adapter (../command-guard.mjs) receives the command from the hook and calls this.

export function bannedCommand(command, bans) {
  return [].concat(bans).filter((pat) => new RegExp(pat).test(command)).map((pat) => `command matches banned /${pat}/`);
}
