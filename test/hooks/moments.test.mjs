// test/hooks/moments.test.mjs — re-runnable integration tests for the MOMENT hooks, with NO
// human in the loop and NO token cost. Each drives a REAL hook (session-start.mjs, signs.mjs,
// …) with the exact JSON payload Claude Code would send, then asserts the JSON it emits and the
// drift-state file it writes. This is the deterministic tier of the moment verification; the
// live `claude -p` harness (test/live/) adds the "a real agent received it" fidelity on top.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// A scratch repo carrying `yaml` as its signposts.yaml, and a fresh session id whose drift-state
// file we own and clean up. Returns helpers to drive a hook and read the state.
function scratch(yaml) {
  const root = mkdtempSync(join(tmpdir(), 'sg-moments-'));
  writeFileSync(join(root, 'signposts.yaml'), yaml);
  const sid = `moments-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const stateFile = join(homedir(), '.claude', 'sessions', `signposts-${sid}-main.json`);
  const env = { ...process.env, CLAUDE_PROJECT_DIR: root };
  const drive = (hook, payload) => {
    const r = spawnSync('node', [join(REPO, 'src/hooks', hook)], { env, input: JSON.stringify({ session_id: sid, agent_id: 'main', ...payload }), encoding: 'utf8' });
    let json = {};
    try { json = JSON.parse(r.stdout || '{}'); } catch { /* non-JSON stdout */ }
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, json, ctx: json.hookSpecificOutput?.additionalContext || '' };
  };
  const state = () => { try { return JSON.parse(readFileSync(stateFile, 'utf8')); } catch { return null; } };
  const cleanup = () => { if (existsSync(stateFile)) rmSync(stateFile); rmSync(root, { recursive: true, force: true }); };
  return { root, sid, drive, state, cleanup };
}

const TWO_BUNDLES = [
  'config:', '  drift_tokens: 1000',
  'bundles:',
  '  core:',
  '    signs:',
  '      - id: core-orient',
  '        at: session',
  '        text: "docs/arch is the system prior — read before structural work."',
  '      - id: db-area',
  '        globs: ["src/db/**"]',
  '        text: "db is append-only"',
  '  security:',
  '    signs:',
  '      - id: sec-orient',
  '        at: session',
  '        text: ".env files are dotenvx-encrypted — committed, safe to read."',
  '',
].join('\n');

test('SessionStart composes both bundles\' orientation, in bundle order', () => {
  const s = scratch(TWO_BUNDLES);
  try {
    const r = s.drive('session-start.mjs', { hook_event_name: 'SessionStart', source: 'startup' });
    assert.equal(r.json.hookSpecificOutput?.hookEventName, 'SessionStart');
    assert.match(r.ctx, /docs\/arch is the system prior/);
    assert.match(r.ctx, /dotenvx-encrypted/);
    assert.ok(r.ctx.indexOf('## core') < r.ctx.indexOf('## security'), 'core section precedes security');
    assert.doesNotMatch(r.ctx, /db is append-only/, 'the area sign is not orientation');
  } finally { s.cleanup(); }
});

test('SessionStart pre-marks orientation signs so the first touch does not duplicate them', () => {
  const s = scratch(TWO_BUNDLES);
  try {
    s.drive('session-start.mjs', { hook_event_name: 'SessionStart', source: 'startup' });
    const st = s.state();
    assert.ok(st && 'core-orient' in st && 'sec-orient' in st, 'orientation signs pre-marked');
    assert.ok(!('db-area' in st), 'area sign not pre-marked');

    const touch = s.drive('signs.mjs', { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: 'src/db/schema.ts' } });
    assert.match(touch.ctx, /db is append-only/, 'area sign injects on touch');
    assert.doesNotMatch(touch.ctx, /docs\/arch is the system prior/, 'orientation not re-injected');
    assert.doesNotMatch(touch.ctx, /dotenvx-encrypted/, 'orientation not re-injected');
  } finally { s.cleanup(); }
});

test('after a compaction: area signs re-brief, orientation stays suppressed (SessionStart re-delivered it)', () => {
  const s = scratch(TWO_BUNDLES);
  try {
    s.drive('session-start.mjs', { hook_event_name: 'SessionStart', source: 'startup' });
    s.drive('signs.mjs', { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: 'src/db/schema.ts' } });
    s.drive('signs.mjs', { hook_event_name: 'PostCompact' });
    const st = s.state();
    assert.ok(st && 'core-orient' in st && 'sec-orient' in st, 'orientation marks survive compaction');
    assert.ok(!('db-area' in st), 'area mark cleared → re-briefs');

    const touch = s.drive('signs.mjs', { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: 'src/db/schema.ts' } });
    assert.match(touch.ctx, /db is append-only/, 'area re-briefs after compaction');
    assert.doesNotMatch(touch.ctx, /docs\/arch is the system prior/, 'orientation still suppressed');
  } finally { s.cleanup(); }
});

test('SessionStart re-delivers orientation on the compact source too', () => {
  const s = scratch(TWO_BUNDLES);
  try {
    const r = s.drive('session-start.mjs', { hook_event_name: 'SessionStart', source: 'compact' });
    assert.match(r.ctx, /docs\/arch is the system prior/);
    assert.match(r.ctx, /dotenvx-encrypted/);
  } finally { s.cleanup(); }
});

test('off switch silences the SessionStart orientation', () => {
  const s = scratch(TWO_BUNDLES);
  try {
    mkdirSync(join(s.root, '.signposts'), { recursive: true });
    writeFileSync(join(s.root, '.signposts', 'off'), 'off\n');
    const r = s.drive('session-start.mjs', { hook_event_name: 'SessionStart', source: 'startup' });
    assert.equal(r.stdout.trim(), '', 'no orientation emitted when off');
  } finally { s.cleanup(); }
});
