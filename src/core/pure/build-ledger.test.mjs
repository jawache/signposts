import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLedger } from './build-ledger.mjs';

const mk = (session, events) => ({ session, events });
const run = (ts, rules) => ({ ts, kind: 'run', phase: 'edit', rules });

test('sums evaluated/matched/fired and counts sessions across logs', () => {
  const logs = [
    mk('s1', [run('2026-05-01T00:00:00Z', [{ id: 'a', evaluated: 5, matched: 2, hits: 1 }])]),
    mk('s2', [run('2026-06-01T00:00:00Z', [{ id: 'a', evaluated: 4, matched: 1, hits: 0 }])]),
  ];
  const l = buildLedger(logs, ['a'], Date.parse('2026-06-02T00:00:00Z'), { minSessions: 1, minDays: 1 });
  assert.equal(l.rules.a.evaluated, 9);
  assert.equal(l.rules.a.matched, 3);
  assert.equal(l.rules.a.fired, 1);
  assert.equal(l.rules.a.sessions, 2);
  assert.equal(l.totalSessions, 2);
});

test('span-days is measured from first to last log ts', () => {
  const l = buildLedger([mk('s', [run('2026-01-01T00:00:00Z', [{ id: 'a', evaluated: 1 }]), run('2026-01-11T00:00:00Z', [])])], ['a'], Date.now(), {});
  assert.equal(l.spanDays, 10);
});

test('retire: a rule that never ran, with ample history (sessions)', () => {
  const logs = [mk('s1', [run('2026-05-01T00:00:00Z', [])]), mk('s2', [run('2026-05-02T00:00:00Z', [])]), mk('s3', [run('2026-05-03T00:00:00Z', [])])];
  const l = buildLedger(logs, ['z'], Date.now(), { minSessions: 3, minDays: 9999 });
  assert.equal(l.ample, true);
  assert.deepEqual(l.retire, ['z']);
  assert.deepEqual(l.unproven, []);
});

test('unproven: never ran, but the history is too thin to judge', () => {
  const l = buildLedger([mk('s1', [run('2026-05-01T00:00:00Z', [])])], ['z'], Date.now(), { minSessions: 50, minDays: 365 });
  assert.equal(l.ample, false);
  assert.deepEqual(l.unproven, ['z']);
  assert.deepEqual(l.retire, []);
});

test('ample via span-days even with few sessions', () => {
  const l = buildLedger([mk('s', [run('2026-01-01T00:00:00Z', []), run('2026-03-01T00:00:00Z', [])])], ['z'], Date.now(), { minSessions: 999, minDays: 30 });
  assert.equal(l.ample, true);
  assert.deepEqual(l.retire, ['z']);
});

test('went quiet: fired long ago, silent since', () => {
  const l = buildLedger([mk('s1', [run('2026-01-01T00:00:00Z', [{ id: 'a', evaluated: 3, matched: 1, hits: 1 }])])], ['a'], Date.parse('2026-06-01T00:00:00Z'), { minSessions: 1, minDays: 30 });
  assert.equal(l.wentQuiet.length, 1);
  assert.equal(l.wentQuiet[0].id, 'a');
  assert.ok(l.wentQuiet[0].daysSince > 30);
});

test('recently fired is not "went quiet"', () => {
  const l = buildLedger([mk('s1', [run('2026-05-30T00:00:00Z', [{ id: 'a', evaluated: 3, matched: 1, hits: 1 }])])], ['a'], Date.parse('2026-06-01T00:00:00Z'), { minSessions: 1, minDays: 30 });
  assert.deepEqual(l.wentQuiet, []);
});

test('ran but never caught is a working deterrent — not retired/unproven/quiet', () => {
  const l = buildLedger([mk('s1', [run('2026-05-01T00:00:00Z', [{ id: 'a', evaluated: 10, matched: 4, hits: 0 }])])], ['a'], Date.parse('2026-06-01T00:00:00Z'), { minSessions: 1, minDays: 1 });
  assert.deepEqual(l.retire, []);
  assert.deepEqual(l.unproven, []);
  assert.deepEqual(l.wentQuiet, []);
});

test("the shared 'commit' file adds to totals but is not a distinct session", () => {
  const logs = [
    mk('s1', [run('2026-05-01T00:00:00Z', [{ id: 'a', evaluated: 2, matched: 1, hits: 1 }])]),
    mk('commit', [run('2026-05-02T00:00:00Z', [{ id: 'a', evaluated: 1, matched: 0, hits: 0 }])]),
  ];
  const l = buildLedger(logs, ['a'], Date.now(), { minSessions: 1, minDays: 1 });
  assert.equal(l.totalSessions, 1);
  assert.equal(l.rules.a.evaluated, 3);
});

test('check deny/override and a legacy deny event each update lastFired', () => {
  const logs = [mk('s1', [
    run('2026-05-01T00:00:00Z', [{ id: 'a', evaluated: 1, matched: 1, hits: 0 }]),
    { ts: '2026-05-02T00:00:00Z', kind: 'check', rule: 'a', out: 'deny' },
    { ts: '2026-05-03T00:00:00Z', kind: 'check', rule: 'b', out: 'override' },
    { ts: '2026-05-04T00:00:00Z', kind: 'deny', rule: 'c' },
    { ts: '2026-05-05T00:00:00Z', kind: 'check', rule: 'd', out: 'allow' },   // allow doesn't count as fired
  ])];
  const l = buildLedger(logs, ['a', 'b', 'c', 'd'], Date.now(), {});
  assert.equal(l.rules.a.lastFired, '2026-05-02T00:00:00Z');
  assert.equal(l.rules.b.lastFired, '2026-05-03T00:00:00Z');
  assert.equal(l.rules.c.lastFired, '2026-05-04T00:00:00Z');
  assert.equal(l.rules.d, undefined);   // an allow-only check for a never-run rule makes no ledger entry
});

test('a legacy run without matched contributes 0; a fired-but-timeless rule is not quiet; ample tolerated', () => {
  const l = buildLedger([mk('s', [{ kind: 'run', rules: [{ id: 'a', evaluated: 2, hits: 1 }] }])], ['a'], Date.now(), { minSessions: 1, minDays: 1 });
  assert.equal(l.rules.a.matched, 0);           // no `matched` field → 0
  assert.equal(l.rules.a.evaluated, 2);
  assert.equal(l.spanDays, 0);                  // no ts anywhere
  assert.equal(l.ample, true);                  // 1 session ≥ minSessions 1
  assert.deepEqual(l.wentQuiet, []);            // fired but lastFired null → daysSince null → not quiet
});

test('empty logs → zeros, and default thresholds (15 sessions / 30 days) apply', () => {
  const l = buildLedger([], ['a'], Date.now());
  assert.equal(l.totalSessions, 0);
  assert.equal(l.ample, false);
  assert.equal(l.minSessions, 15);
  assert.equal(l.minDays, 30);
  assert.deepEqual(l.unproven, ['a']);
});
