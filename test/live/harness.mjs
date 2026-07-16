// test/live/harness.mjs — drive a REAL agent headlessly and observe what the hooks did.
//
// The primitive the user asked for: an end-to-end integration test with no human in the loop.
// It runs `claude --bare -p` against a scratch repo wired with signposts' hooks (via --settings),
// captures the stream, and lets a test assert on (a) the streamed events and (b) the side effects
// on disk — the drift-state file the SessionStart hook writes, the yaml a /signposts flow edits.
//
// `--bare` skips ambient hook/skill/MCP discovery, so ONLY our --settings hooks run — deterministic.
// Auth in bare mode needs ANTHROPIC_API_KEY (or an apiKeyHelper); tests skip when it is absent.

import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const haveKey = () => !!process.env.ANTHROPIC_API_KEY;

// Wire a scratch repo: signposts.yaml + a .claude/settings.json whose hooks point at THIS repo's
// source (absolute paths, so the scratch repo needs no install). Returns the paths + helpers.
export function scratchRepo(yaml) {
  const root = mkdtempSync(join(tmpdir(), 'sg-live-'));
  writeFileSync(join(root, 'signposts.yaml'), yaml);
  mkdirSync(join(root, '.claude'), { recursive: true });
  const hook = (f) => ({ hooks: [{ type: 'command', command: `node "${join(REPO, 'src/hooks', f)}"` }] });
  const settings = {
    hooks: {
      SessionStart: [{ matcher: 'startup|resume|clear|compact', ...hook('session-start.mjs') }],
      PostToolUse: [{ matcher: 'Read|Glob|Grep|Edit|Write|Bash', ...hook('signs.mjs') }],
      Stop: [hook('turn-guard.mjs')],           // present from Phase 4 on; harmless if the file is absent (fails safe)
    },
  };
  const settingsPath = join(root, '.claude', 'settings.json');
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return { root, settingsPath };
}

// Run one headless turn. Returns { sessionId, events[], result, raw }. events is the parsed
// stream-json (system/init, hook_*, assistant, result). Throws on a non-JSON stream.
export function runAgent({ root, settingsPath, prompt, allowedTools = 'Read,Glob,Grep', extraArgs = [] }) {
  const args = [
    '--bare', '-p', prompt,
    '--settings', settingsPath,
    '--add-dir', root,
    '--allowedTools', allowedTools,
    '--output-format', 'stream-json', '--verbose',
    ...extraArgs,
  ];
  const r = spawnSync('claude', args, {
    cwd: root,
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 180_000,
  });
  const events = [];
  for (const line of (r.stdout || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { events.push(JSON.parse(t)); } catch { /* skip a partial line */ }
  }
  const result = events.find((e) => e.type === 'result') || events[events.length - 1] || {};
  const sessionId = result.session_id || events.find((e) => e.session_id)?.session_id || null;
  return { sessionId, events, result, raw: r.stdout, stderr: r.stderr, status: r.status };
}

// The drift-state file SessionStart / signs.mjs write for a session (proof the hooks ran).
export function driftState(sessionId, agent = 'main') {
  const f = join(homedir(), '.claude', 'sessions', `signposts-${sessionId}-${agent}.json`);
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; }
}
export function driftStatePath(sessionId, agent = 'main') {
  return join(homedir(), '.claude', 'sessions', `signposts-${sessionId}-${agent}.json`);
}

// Any hook_response/hook event in the stream mentioning `needle` (best-effort; shape varies by
// Claude Code version — the durable proof is the on-disk side effect, not the stream text).
export function streamMentions(events, needle) {
  return events.some((e) => JSON.stringify(e).includes(needle));
}

export function cleanup(root, sessionId) {
  if (sessionId) { const f = driftStatePath(sessionId); if (existsSync(f)) rmSync(f); }
  rmSync(root, { recursive: true, force: true });
}
