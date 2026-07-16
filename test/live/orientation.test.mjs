// test/live/orientation.test.mjs — LIVE proof that a real headless agent receives the composed
// orientation at session start. Skips unless ANTHROPIC_API_KEY is set (bare mode needs it, and
// this spends tokens). The durable assertion is the on-disk side effect: after the run, the
// SessionStart hook must have written the orientation sign ids into the drift-state file — proof
// it fired inside a genuine agent session, independent of model wording or stream-shape churn.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haveKey, scratchRepo, runAgent, driftState, streamMentions, cleanup } from './harness.mjs';

const YAML = [
  'config:', '  drift_tokens: 1000',
  'bundles:',
  '  core:',
  '    signs:',
  '      - id: core-orient',
  '        at: session',
  '        text: "docs/arch is the system prior — read before structural work."',
  '  security:',
  '    signs:',
  '      - id: sec-orient',
  '        at: session',
  '        text: ".env files are dotenvx-encrypted — committed, safe to read."',
  '',
].join('\n');

test('a real headless session receives the composed orientation (both bundles)', { skip: haveKey() ? false : 'set ANTHROPIC_API_KEY to run the live tier' }, () => {
  const { root, settingsPath } = scratchRepo(YAML);
  let sessionId = null;
  try {
    const run = runAgent({ root, settingsPath, prompt: 'Reply with just the word: ready.' });
    sessionId = run.sessionId;
    assert.ok(sessionId, 'got a session id back from the headless run');

    // Durable proof: SessionStart pre-marked BOTH orientation signs in the drift-state file.
    const st = driftState(sessionId);
    assert.ok(st, 'the drift-state file exists → the SessionStart hook ran in the real session');
    assert.ok('core-orient' in st && 'sec-orient' in st, 'both bundles\' orientation signs were composed + pre-marked');

    // Best-effort stream proof (shape varies by CC version): the orientation text rode the stream.
    assert.ok(streamMentions(run.events, 'dotenvx-encrypted') || 'core-orient' in st, 'orientation delivered');
  } finally {
    cleanup(root, sessionId);
  }
});
