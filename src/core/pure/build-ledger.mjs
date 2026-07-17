// src/core/pure/build-ledger.mjs — PURE decision: the cumulative rule-lifetime ledger.
//
// Retirement is a MULTI-run call, never a one-run one: a rule quiet this session may just be
// watching an area you didn't touch. This sums every session's log into a per-rule lifetime —
// evaluated / matched / fired, sessions-seen, first-seen, last-fired — and grades a never-fired
// rule by how much OPPORTUNITY it had: ample history + 0 evaluations ⇒ retire candidate; thin
// history ⇒ "unproven, too soon". No I/O, no clock (session logs + `now` injected) → testable;
// the report skill reads the logs and calls this. Colocated test: build-ledger.test.mjs.

const DAY_MS = 86_400_000;
const minTs = (a, b) => (!a ? b : !b ? a : a < b ? a : b);
const maxTs = (a, b) => (!a ? b : !b ? a : a > b ? a : b);

export function buildLedger(sessionLogs, universeIds, nowMs, opts = {}) {
  const minSessions = opts.minSessions ?? 15;
  const minDays = opts.minDays ?? 30;
  const rules = {};
  const ensure = (id) => (rules[id] ||= { id, evaluated: 0, matched: 0, fired: 0, sessions: 0, firstSeen: null, lastEvaluated: null, lastFired: null });
  let firstLog = null, lastLog = null, totalSessions = 0;
  for (const { session, events } of sessionLogs) {
    const seen = new Set();
    let sessionHasRun = false;
    for (const e of events || []) {
      if (e.ts) { firstLog = minTs(firstLog, e.ts); lastLog = maxTs(lastLog, e.ts); }
      if (e.kind === 'run') {
        sessionHasRun = true;
        for (const r of e.rules || []) {
          const t = ensure(r.id); seen.add(r.id);
          t.evaluated += r.evaluated || 0;
          t.matched += r.matched || 0;                       // legacy runs lack `matched` → contribute 0
          t.fired += r.hits || 0;
          if (e.ts) { t.firstSeen = minTs(t.firstSeen, e.ts); t.lastEvaluated = maxTs(t.lastEvaluated, e.ts); if ((r.hits || 0) > 0) t.lastFired = maxTs(t.lastFired, e.ts); }
        }
      } else if (e.kind === 'check' && (e.out === 'deny' || e.out === 'override')) {
        if (e.ts) ensure(e.rule).lastFired = maxTs(ensure(e.rule).lastFired, e.ts);
      } else if (e.kind === 'deny') {
        if (e.ts) ensure(e.rule).lastFired = maxTs(ensure(e.rule).lastFired, e.ts);   // legacy back-compat
      }
    }
    for (const id of seen) rules[id].sessions += 1;
    if (session !== 'commit' && sessionHasRun) totalSessions += 1;   // 'commit' is a shared file, not a session
  }
  const spanDays = firstLog && lastLog ? Math.round((Date.parse(lastLog) - Date.parse(firstLog)) / DAY_MS) : 0;
  const ample = totalSessions >= minSessions || spanDays >= minDays;   // enough opportunity to trust a "never ran"
  const retire = [], unproven = [], wentQuiet = [];
  for (const id of universeIds) {
    const t = rules[id];
    if (!t || t.evaluated === 0) { (ample ? retire : unproven).push(id); continue; }   // never RAN anywhere
    if (t.fired === 0) continue;                                       // ran but never caught — a working deterrent, keep
    const daysSince = t.lastFired ? Math.round((nowMs - Date.parse(t.lastFired)) / DAY_MS) : null;
    if (ample && daysSince != null && daysSince > minDays) wentQuiet.push({ id, lastFired: t.lastFired, daysSince });
  }
  return { totalSessions, spanDays, firstLog, lastLog, ample, minSessions, minDays, rules, retire: retire.sort(), unproven: unproven.sort(), wentQuiet: wentQuiet.sort((a, b) => b.daysSince - a.daysSince) };
}
