#!/usr/bin/env node
/**
 * Signposts facts + drift pointers for the `coach` agent — the detector half of the
 * /signposts reflect loop (run by `npx signposts facts`, chained from /review's wrap-up).
 *
 * Two sources, kept strictly apart (this is the whole point of the rebuild):
 *   • NUMBERS come from the engine's own event log (.signposts/log/<session>.jsonl) —
 *     deterministic ground truth. Per-rule fires, edit-catches vs commit-leaks, rules
 *     that never fired, sign injections. This replaces the old approach of scraping
 *     the git hook's emoji output out of the transcript, which silently reported
 *     "agent-edit fires: 0" against a hook structure the engine model had replaced.
 *   • NARRATIVE comes from the transcript — heuristic, and labelled as such: the
 *     session map (user turns), course-corrections, edit loops, retries, justfile
 *     bypasses, signpost gaps. Each carries a transcript line so coach reads the spot.
 *
 * Coach navigates these: `--around <line>` prints a clean tool-use view of any spot;
 * the numbers ground the "is the harness working?" verdict in observed behaviour.
 *
 * Run from the repo root (cwd-relative). The session is identified by the transcript
 * filename (Claude Code names transcripts <session_id>.jsonl — the same id the hooks
 * pass to the log), so facts and log line up automatically.
 *
 * Usage:
 *   node src/skill/session-report.mjs [--base <gitref>] [--transcript <path>] [--json] [--html]
 *   node src/skill/session-report.mjs --around <line> [--radius <n>]
 *   node src/skill/session-report.mjs --test
 *   (or, installed: `npx signposts facts …`)
 *
 * Couples to Claude Code's transcript shape (assistant.message.content[].tool_use,
 * user.message.content[].tool_result, user string/text = a typed prompt). If that
 * format changes, fix parseEvents(). Numbers do NOT depend on the transcript.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { readEvents, sanitise } from '../log.mjs';
import { loadRules } from '../engine.mjs';
import { loadConfig, resolveConfigPath } from '../schema.mjs';
import { composeOrientation } from '../hooks/session-start.mjs';

const ANSI = /\x1b\[[0-9;]*m/g;
const strip = (s) => String(s ?? '').replace(ANSI, '');
const snip = (s, n = 140) => strip(s).replace(/\s+/g, ' ').trim().slice(0, n);
const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// User prompts whose text starts with one of these are harness-injected, not the
// human talking — excluded from "user turns" and course-correction detection.
const INJECTED = [
  '<system-reminder>', 'Caveat:', '<command-name>', '<command-message>',
  '<local-command', 'Result of calling', 'This session is being continued',
  '[Request interrupted', '<user-prompt-submit-hook', 'DO NOT respond',
  '<budget:', 'tool_use_id',
];
const isInjected = (t) => {
  const s = t.trimStart();
  return INJECTED.some((m) => s.startsWith(m)) || s.slice(0, 40).includes('<system-reminder>');
};
// High-signal pushback markers — where the human corrected the agent (heuristic).
const CORRECTION = /\b(actually|wait[, ]|hold on|nope|that'?s (wrong|not right|not what|not)|do(n'?t| not) |stop |revert|undo|instead|you (broke|shouldn'?t|missed|forgot|didn'?t)|why (did|are) you|rather than|let'?s not|no[, ]|hmm)\b/i;

// ── transcript discovery ──────────────────────────────────────────────────
function projectDir(cwd) {
  return path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[/.]/g, '-'));
}
function newestTranscript(cwd) {
  const dir = projectDir(cwd);
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => path.join(dir, f))
    .map((p) => ({ p, m: fs.statSync(p).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  return files.length ? files[0].p : null;
}

// ── event parsing (line-numbered, role-aware) ─────────────────────────────
// Each event carries `line` = its 1-based line in the file (a navigable pointer).
function parseEvents(jsonl, cwd) {
  const out = [];
  const rel = (fp) => (fp && fp.startsWith(cwd) ? fp.slice(cwd.length + 1) : fp || '');
  const lines = jsonl.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim()) continue;
    let o;
    try { o = JSON.parse(raw); } catch { continue; }
    const line = i + 1;
    const content = o.message && o.message.content;
    if (o.type === 'user') {
      if (typeof content === 'string' && !o.isMeta) out.push({ line, kind: 'usertext', text: content });
      else if (Array.isArray(content)) {
        for (const c of content) {
          if (c.type !== 'tool_result') continue;
          const txt = typeof c.content === 'string' ? c.content
            : Array.isArray(c.content) ? c.content.map((x) => x.text || '').join('\n')
            : JSON.stringify(c.content ?? '');
          out.push({ line, kind: 'result', id: c.tool_use_id, content: txt, is_error: !!c.is_error });
        }
      }
    } else if (o.type === 'assistant' && Array.isArray(content)) {
      for (const c of content) {
        if (c.type === 'tool_use') {
          out.push({ line, ts: o.timestamp || null, kind: 'use', id: c.id, name: c.name, input: c.input || {}, rel: rel(c.input && c.input.file_path) });
        }
      }
    }
  }
  return out;
}

// ── glob matching (signpost globs, for coverage) ──────────────────────────
function globToRe(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
      else re += '[^/]*';
    } else if (ch === '?') re += '[^/]';
    else if (ch === '{') {
      const end = glob.indexOf('}', i);
      const alts = glob.slice(i + 1, end).split(',').map((a) => a.replace(/[.+^${}()|[\]\\]/g, '\\$&'));
      re += '(' + alts.join('|') + ')';
      i = end;
    } else if ('.+^$()|[]\\'.includes(ch)) re += '\\' + ch;
    else re += ch;
  }
  return new RegExp(re + '$');
}
function matchGlob(glob, relpath) {
  const re = globToRe(glob);
  return re.test(relpath) || re.test(path.basename(relpath));
}

// The guardrail areas — SINGLE-SOURCED with the `rules-self-edit` sign's globs so the
// sign (injected at edit time) and this detector (surfaced at wrap-up) can't drift apart.
export const GUARDRAIL_GLOBS = ['signposts.yml', 'signposts.yaml', 'rules/**', '.claude/settings.json'];
const isGuardrailPath = (rel) => !!rel && GUARDRAIL_GLOBS.some((g) => matchGlob(g, rel));

// Weaken-after-deny: a deny event (from the log — carries ts + rule), then a transcript
// Edit/Write to a guardrail file AFTER it. Flags the closest such edit per deny. It is a
// POINTER for coach, not an accusation — the edit may be legitimate authoring; coach reads
// the cited line and judges intent.
function weakenAfterDeny(denyEvents, events) {
  const denies = (denyEvents || []).filter((e) => e.kind === 'deny' && e.ts).map((e) => ({ rule: e.rule, ts: e.ts }));
  const edits = events.filter((e) => e.kind === 'use' && (e.name === 'Edit' || e.name === 'Write') && e.ts && isGuardrailPath(e.rel));
  const flags = [];
  for (const d of denies) {
    const after = edits.filter((e) => e.ts > d.ts).sort((a, b) => a.ts.localeCompare(b.ts))[0];
    if (after) flags.push({ rule: d.rule, editLine: after.line, path: after.rel, gapSec: Math.round((Date.parse(after.ts) - Date.parse(d.ts)) / 1000) });
  }
  return flags;
}

// ── recipe tools, DERIVED from the justfile (not hardcoded) ────────────────
// Every recipe body line → each command segment's first word → the set of tools
// that "should go through just". Shell noise is dropped; if there's no justfile,
// bypass detection is switched off entirely (returns []).
const NOISE = new Set(['set', 'node', 'npx', 'just', 'cd', 'export', 'echo', 'then', 'fi', 'do', 'done', 'if', 'for', 'while', 'source']);
function parseRecipeTools(text) {
  const tools = new Set();
  let inRecipe = false;
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    const indented = /^\s/.test(raw);
    const line = raw.trim();
    if (line.startsWith('#')) continue;                             // comment
    if (!indented) {                                                // a top-level line: is it a recipe header?
      inRecipe = /^[A-Za-z0-9_-]+(\s+\S+)*\s*:/.test(line) && !line.includes(':=');
      continue;                                                     // the header itself is not a command
    }
    if (!inRecipe) continue;
    for (const segRaw of line.split(/&&|\|\||\||;/)) {
      let w = (segRaw.trim().split(/\s+/)[0] || '').replace(/^@/, '');  // strip just's echo-suppress '@'
      if (!w || !/^[A-Za-z]/.test(w) || NOISE.has(w)) continue;
      tools.add(w);
    }
  }
  return [...tools];
}
function recipeTools(cwd) {
  try { return parseRecipeTools(fs.readFileSync(path.join(cwd, 'justfile'), 'utf8')); }
  catch { return []; }                                              // no justfile → no bypass section
}

// ── bash classification (justfile bypass — heuristic) ──────────────────────
function classifyBash(cmd, tools) {
  const c = strip(cmd);
  if (/<<-?\s*['"]?\w/.test(c)) return { justCalls: [], bypasses: [], isCommit: false }; // heredoc = authoring
  const justCalls = [];
  for (const m of c.matchAll(/(?:^|\n|;|\||&&|\()\s*just\s+([a-z][\w-]*)/g)) justCalls.push(m[1]);
  const bypasses = [];
  for (const t of tools) {
    const e = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const direct = new RegExp(`(?:^|\\n|;|\\||&&|\\(|node_modules/\\.bin/|npx\\s+)\\s*(?:\\./)?${e}\\b`);
    const viaJust = new RegExp(`just\\s+\\S*\\b${e}\\b`);
    if (direct.test(c) && !viaJust.test(c)) bypasses.push(t);
  }
  return { justCalls, bypasses, isCommit: /\bgit\s+commit\b/.test(c) };
}

// ── git touched files (base main-first; no website-specific flags) ─────────
function detectBase(explicit) {
  if (explicit) return explicit;
  for (const b of ['main', 'origin/main', 'master', 'origin/master']) {
    try {
      execSync(`git rev-parse --verify ${b}`, { stdio: 'ignore' });
      return execSync(`git merge-base HEAD ${b}`, { encoding: 'utf8' }).trim();
    } catch { /* next */ }
  }
  return null;
}
function gitTouchedFiles(base) {
  try {
    const range = base ? `${base}...HEAD` : 'HEAD~5...HEAD';
    return execSync(`git diff --name-only ${range}`, { encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch { return []; }
}

// Globs lifted from the signposts config — used to score touched-file coverage.
function readSignpostGlobs(cwd) {
  try {
    const y = fs.readFileSync(resolveConfigPath(cwd), 'utf8');
    const globs = [];
    for (const m of y.matchAll(/globs:\s*\[([^\]]*)\]/g))
      for (const g of m[1].split(',')) {
        const s = g.trim().replace(/^["']|["']$/g, '');
        if (s) globs.push(s);
      }
    return globs;
  } catch { return []; }
}

// A rule's scope globs (its `on:` or, for a deny-rule, its `deny:`) — so a file guarded by a
// RULE (not just a sign) doesn't count as an uncovered gap. Uses the normalised rule list.
function readRuleGlobs(cwd) {
  try {
    const globs = [];
    for (const r of loadRules(cwd)) {
      const g = r.on != null ? r.on : (r.deny != null ? r.deny : null);
      if (g != null) globs.push(...[].concat(g));
    }
    return globs;
  } catch { return []; }
}

// ── rule + sign config, joined into the report ─────────────────────────────
// Verbatim config the report shows (glob / message / description / sign text) — so a row is
// legible without guessing. Read once, fail-safe.
function ruleUniverse(root) {
  try {
    return loadRules(root).map((r) => ({
      id: r.id, ns: r.namespace ?? null, when: r.when || [],
      message: r.message ?? null, description: r.description ?? null,
      scope: r.on != null ? { kind: 'on', globs: [].concat(r.on) }
        : (r.deny != null ? { kind: 'deny', globs: [].concat(r.deny) } : null),
      use: r.use ?? null,
    }));
  } catch { return []; }
}
function signUniverse(root) {
  const out = {};
  try {
    const cfg = loadConfig(root);
    for (const [ns, list] of Object.entries(cfg.signs || {})) {
      for (const s of list || []) {
        if (!s || !s.id) continue;
        out[s.id] = { id: s.id, ns: ns || null,
          watches: s.global ? 'session' : (s.globs ? [].concat(s.globs).join(', ') : (s.at || 'touch')),
          text: s.text ?? s.note ?? null };
      }
    }
  } catch { /* fail-safe */ }
  return out;
}

// ── cumulative rule lifetime — the ledger across ALL sessions ───────────────
// Retirement is a MULTI-run call, never a one-run one: a rule quiet this session may just be
// watching an area you didn't touch. This sums every session's log into a per-rule lifetime —
// evaluated / matched / fired, sessions-seen, first-seen, last-fired — and grades a
// never-fired rule by how much OPPORTUNITY it had: ample history + 0 evaluations ⇒ retire
// candidate; thin history ⇒ "unproven, too soon". Pure (session logs + now injected → testable).
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

// The session ids that have a log file (filename stem). 'commit' is included — its events
// still count toward a rule's lifetime totals, just not toward the distinct-session count.
function allSessionIds(root) {
  try {
    return fs.readdirSync(path.join(root, '.signposts', 'log'))
      .filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, -6));
  } catch { return []; }
}

// ── the hard numbers, from the event log ───────────────────────────────────
// session = the Claude session id (transcript basename). Per-rule the report answers "did this
// rule ENGAGE with my work, and did it catch anything?" via `matched` (a touched file fell in
// the rule's scope) and `blocked`/`overridden` (from the per-file `check` trace). Commit-phase
// events attribute to the live session when the marker worked, else to commit.jsonl in this
// session's window [started, nextStart). Legacy logs (no `matched`, no `check`) degrade to the
// old evaluated/deny counts, flagged. A cumulative `lifetime` ledger (all sessions) grades
// retirement — never-fired this session is not never-fired ever.
function logMetrics(root, session) {
  const universe = ruleUniverse(root);
  const cfgById = Object.fromEntries(universe.map((u) => [u.id, u]));
  const signsCfg = signUniverse(root);
  const sessionLog = readEvents(root, { session });
  const allLog = readEvents(root, {});

  const started = (() => {
    const meta = sessionLog.events.find((e) => e.kind === 'meta');
    if (meta && meta.started) return meta.started;
    const ts = sessionLog.events.map((e) => e.ts).filter(Boolean).sort();
    return ts[0] || null;
  })();
  const nextStart = allLog.events
    .filter((e) => e.kind === 'meta' && e.started && e.session && e.session !== 'commit' && started && e.started > started)
    .map((e) => e.started).sort()[0] || null;
  const inWindow = (e) => !started || (e.ts && e.ts >= started && (!nextStart || e.ts < nextStart));

  // The events this session accounts for: its own file (includes commit events the marker
  // attributed here), PLUS commit/push-phase events from commit.jsonl in the window (the
  // marker-less fallback). Guard the double-count when the session IS 'commit'.
  const commitFile = session === 'commit' ? { events: [] } : readEvents(root, { session: 'commit' });
  const windowCommit = commitFile.events.filter((e) => (e.phase === 'commit' || e.phase === 'push') && inWindow(e));
  const consider = [...sessionLog.events, ...windowCommit];

  const perRule = {};
  const ensure = (id, ns) => (perRule[id] ||= {
    id, ns: (cfgById[id]?.ns) ?? ns ?? null,
    when: cfgById[id]?.when || [], message: cfgById[id]?.message ?? null,
    description: cfgById[id]?.description ?? null, scope: cfgById[id]?.scope ?? null,
    retired: !cfgById[id],                                     // in the log but gone from config
    evaluated: 0, matched: 0, hasMatched: false, hits: 0,
    blockedEdit: 0, blockedCommit: 0, overridden: 0,
    denyEdit: 0, denyCommit: 0, overrideEvents: 0, checkSeen: false, trace: [],
  });
  for (const e of consider) {
    if (e.kind === 'run') {
      for (const r of e.rules || []) {
        const t = ensure(r.id);
        t.evaluated += r.evaluated || 0; t.hits += r.hits || 0;
        if (r.matched !== undefined) { t.hasMatched = true; t.matched += r.matched || 0; }
      }
    } else if (e.kind === 'check') {
      const t = ensure(e.rule, e.ns); t.checkSeen = true;
      t.trace.push({ path: e.path, ts: e.ts, out: e.out, msg: e.msg || null });
      if (e.out === 'deny') (e.phase === 'edit' ? t.blockedEdit++ : t.blockedCommit++);
      else if (e.out === 'override') t.overridden++;
    } else if (e.kind === 'deny') {
      const t = ensure(e.rule, e.ns); (e.phase === 'edit' ? t.denyEdit++ : t.denyCommit++);
    } else if (e.kind === 'override') {
      ensure(e.rule, e.ns).overrideEvents++;
    }
  }
  // Legacy fallback per rule: no `check` events → derive blocked/overridden from deny/override
  // events; no `matched` field on any run → matched is unknown (shown as "—", flagged legacy).
  let legacy = false;
  for (const t of Object.values(perRule)) {
    if (!t.checkSeen) { t.blockedEdit = t.denyEdit; t.blockedCommit = t.denyCommit; t.overridden = t.overrideEvents; }
    if (!t.hasMatched && t.evaluated > 0) { t.matched = null; legacy = true; }
    t.blocked = t.blockedEdit + t.blockedCommit;
    t.missingGuidance = !t.message && !t.description && !t.retired;
  }

  const firesAll = {};
  for (const e of allLog.events) if (e.kind === 'run') for (const r of e.rules || []) firesAll[r.id] = (firesAll[r.id] || 0) + (r.evaluated || 0);
  const neverFired = universe.filter((u) => !(firesAll[u.id] > 0)).map((u) => u.id).sort();

  // Cumulative lifetime across every session log — the multi-run view that grades retirement.
  const lcfg = (() => { try { return loadConfig(root).config || {}; } catch { return {}; } })();
  const ledgerOpts = { minSessions: Number(lcfg.retire_min_sessions) || 15, minDays: Number(lcfg.retire_min_days) || 30 };
  const sessionLogs = allSessionIds(root).map((id) => ({ session: id, events: readEvents(root, { session: id }).events }));
  const lifetime = buildLedger(sessionLogs, universe.map((u) => u.id), Date.now(), ledgerOpts);

  const signs = {};
  for (const e of sessionLog.events) if (e.kind === 'sign') {
    const c = signsCfg[e.sign] || {};
    const t = (signs[e.sign] ||= { id: e.sign, ns: c.ns ?? null, watches: c.watches ?? null, text: c.text ?? null, firstTouch: 0, drift: 0 });
    if (e.reason === 'drift') t.drift++; else t.firstTouch++;
  }

  const rows = Object.values(perRule).sort((a, b) => a.id.localeCompare(b.id));
  const realEvents = sessionLog.events.filter((e) => e.kind && e.kind !== 'meta').length;
  const orientation = (() => {
    try { const { text, ids } = composeOrientation(loadConfig(root)); return { bundles: ids.length, lines: text ? text.split('\n').length : 0, bytes: text.length }; }
    catch { return { bundles: 0, lines: 0, bytes: 0 }; }
  })();
  const sum = (f) => rows.reduce((s, r) => s + (f(r) || 0), 0);
  return {
    logPresent: allLog.files > 0,
    sessionArmed: sessionLog.files > 0,
    realEvents, badLines: allLog.badLines, legacy,
    rows, neverFired, signs: Object.values(signs).sort((a, b) => a.id.localeCompare(b.id)),
    matched: sum((r) => r.matched), blocked: sum((r) => r.blocked), overridden: sum((r) => r.overridden),
    flagged: rows.filter((r) => r.missingGuidance).map((r) => r.id),
    retired: rows.filter((r) => r.retired).map((r) => r.id),
    universeCount: universe.length, orientation, lifetime,
  };
}

// ── compact one-liners for the index / context views ──────────────────────
function compactEvent(e) {
  if (e.kind === 'usertext') return `L${e.line} [user] "${snip(e.text, 90)}"`;
  if (e.kind === 'result') return `L${e.line}  ⮑ ${e.is_error ? 'ERR' : 'ok'}: ${snip(e.content, 80)}`;
  if (e.kind === 'use') {
    if (e.name === 'Bash') return `L${e.line} Bash: ${snip(e.input.command, 90)}`;
    if (['Edit', 'Write', 'Read'].includes(e.name)) return `L${e.line} ${e.name}: ${e.rel || ''}`;
    return `L${e.line} ${e.name}`;
  }
  return `L${e.line} ?`;
}
function contextAround(events, line, k) {
  let idx = events.findIndex((e) => e.line >= line);
  if (idx < 0) idx = events.length - 1;
  return events.slice(Math.max(0, idx - k), Math.min(events.length, idx + k + 1)).map(compactEvent);
}

// ── transcript-side analysis (narrative — heuristic) ───────────────────────
function analyze({ events, cwd, base, tools }) {
  let edits = 0, writes = 0, commits = 0;
  const justCalls = {}, bypasses = {};
  const reads = { justfile: 0 };
  const editedFilesByDir = {};
  const touches = {};                              // in-repo file → Read+Edit+Write count (uncovered-file signal)
  const inRepoRel = (r) => r && !r.startsWith('/') && !r.startsWith('..');
  const userTurns = [], corrections = [], bypassSites = [], editLoops = [], retries = [];
  const bashByCmd = {};
  let loopFile = null, loopFrom = null, loopLast = null, loopCount = 0;
  const flushLoop = () => { if (loopCount >= 5) editLoops.push({ file: loopFile, count: loopCount, fromLine: loopFrom, toLine: loopLast }); };

  for (const e of events) {
    if (e.kind === 'usertext') {
      if (isInjected(e.text)) continue;
      userTurns.push({ line: e.line, text: snip(e.text, 120) });
      if (CORRECTION.test(e.text)) corrections.push({ line: e.line, text: snip(e.text, 140) });
      continue;
    }
    if (e.kind !== 'use') continue;

    if (e.name === 'Edit' || e.name === 'Write') {
      if (e.name === 'Edit') edits++; else writes++;
      const inRepo = inRepoRel(e.rel);
      if (inRepo && e.rel === loopFile) { loopCount++; loopLast = e.line; }
      else { flushLoop(); loopFile = inRepo ? e.rel : null; loopFrom = e.line; loopLast = e.line; loopCount = inRepo ? 1 : 0; }
      if (!inRepo) continue;
      (editedFilesByDir[path.dirname(e.rel)] ||= new Set()).add(e.rel);
      touches[e.rel] = (touches[e.rel] || 0) + 1;
    } else if (e.name === 'Read') {
      if (e.rel === 'justfile' || /(^|\/)justfile$/.test(e.rel)) reads.justfile++;
      if (inRepoRel(e.rel)) touches[e.rel] = (touches[e.rel] || 0) + 1;
    } else if (e.name === 'Bash') {
      const cmd = e.input.command || '';
      const { justCalls: jc, bypasses: bp, isCommit } = classifyBash(cmd, tools);
      for (const r of jc) justCalls[r] = (justCalls[r] || 0) + 1;
      for (const t of bp) { bypasses[t] = (bypasses[t] || 0) + 1; bypassSites.push({ line: e.line, tool: t, cmd: snip(cmd, 120) }); }
      const norm = strip(cmd).replace(/\s+/g, ' ').trim();
      (bashByCmd[norm] ||= []).push(e.line);
      if (isCommit) commits++;
    }
  }
  flushLoop();
  for (const [cmd, ls] of Object.entries(bashByCmd)) if (ls.length >= 3) retries.push({ cmd, count: ls.length, lines: ls });

  // A touched file is "watched" if it matches a sign glob OR a rule's scope globs (on/deny) —
  // the spec's "files you touched that no rule or sign watched". Each gap carries a touch count.
  const watchGlobs = [...readSignpostGlobs(cwd), ...readRuleGlobs(cwd)];
  const editedFiles = [...new Set(Object.values(editedFilesByDir).flatMap((s) => [...s]))];
  const covered = [], uncovered = [];
  for (const f of editedFiles) (watchGlobs.some((g) => matchGlob(g, f)) ? covered : uncovered).push(f);
  const uncoveredWithCounts = uncovered.sort().map((f) => ({ file: f, touches: touches[f] || 1 }));

  return {
    stats: { edits, writes, commits, justCalls, bypasses, reads,
      coverage: { covered: covered.sort(), uncovered: uncovered.sort() }, touched: gitTouchedFiles(base) },
    drift: { userTurns, corrections, bypassSites, editLoops, retries },
    signpostGaps: uncoveredWithCounts,
  };
}

// ── fail-loud header for the numbers section ───────────────────────────────
function numbersHealth(m) {
  const warn = [];
  if (!m.logPresent) return { blocked: 'event log: NOT ARMED (no .signposts/log — hooks have not run here, so no numbers). This is not "zero drift".' };
  if (!m.sessionArmed) warn.push('no events for THIS session id (commit-gate log present, but the edit hooks did not record — session id mismatch or edits-free session).');
  else if (m.realEvents === 0) warn.push('event log armed but 0 events recorded this session.');
  if (m.badLines > 0) warn.push(`⚠ ${m.badLines} unparseable log line(s) — the log may be corrupt (numbers below may undercount).`);
  return { warn };
}

// ── render: markdown facts ─────────────────────────────────────────────────
function renderMarkdown(a, m, events, meta, weaken = []) {
  const L = [];
  const tot = (o) => Object.values(o).reduce((s, n) => s + n, 0);
  const s = a.stats;
  L.push('# Signposts facts + drift pointers (numbers deterministic · narrative heuristic — for coach)');
  L.push(`Transcript: ${meta.file} (${meta.lines} lines). NUMBERS from the event log; NARRATIVE (session map, drift) from the transcript.`);
  L.push('Investigate any spot with: `npx signposts facts --around <line>`');
  L.push('');

  L.push('## Event log — did the guardrails engage? (deterministic)');
  const num = (n) => (n == null ? '—' : String(n));
  const h = numbersHealth(m);
  if (h.blocked) { L.push(`- **${h.blocked}**`); }
  else {
    for (const w of h.warn) L.push(`- **${w}**`);
    L.push(`- health: **${m.matched} matched** (a touched file fell in a rule's scope) · **${m.blocked} blocked** · **${m.overridden} overridden** · **${m.neverFired.length} of ${m.universeCount} rules never fired**` + (m.signs.length ? ` · ${m.signs.length} sign${m.signs.length > 1 ? 's' : ''} injected` : ''));
    if (m.legacy) L.push('- _legacy log: some rows predate the `matched`/`check` events — matched shown as “—”._');
    L.push('');
    if (m.rows.length) {
      L.push('| rule | pack | when | matched | blocked | overridden | |');
      L.push('|---|---|---|--:|--:|--:|---|');
      for (const r of m.rows) {
        const flags = [r.retired ? 'retired' : '', r.missingGuidance ? '⚠ no message/description' : ''].filter(Boolean).join(' · ');
        L.push(`| ${r.id} | ${r.ns ?? ''} | ${(r.when || []).join('/')} | ${num(r.matched)} | ${r.blocked} | ${r.overridden} | ${flags} |`);
      }
    } else L.push('- no rule evaluations recorded this session.');
    L.push('');
    // Rule detail — verbatim scope / message / description + the per-file trace, for rules that engaged.
    const engaged = m.rows.filter((r) => (r.matched || r.blocked || r.overridden || r.trace.length));
    if (engaged.length) {
      L.push('### Rule detail — verbatim scope · message · description · files seen');
      for (const r of engaged) {
        const scope = r.scope ? `${r.scope.kind}: ${r.scope.globs.join(', ')}` : 'everything (no scope declared)';
        L.push(`- **${r.id}**${r.retired ? ' _(retired)_' : ''} — scope \`${scope}\``);
        L.push(`    - message: ${r.message ? `"${r.message}"` : '_(none)_'} · description: ${r.description ? `"${r.description}"` : '_(none)_'}${r.missingGuidance ? ' ⚠ **flag: neither a message nor a description**' : ''}`);
        for (const t of r.trace.slice(0, 12)) L.push(`    - ${t.path} · ${(t.ts || '').slice(11, 19)} · ${t.out}${t.msg ? ` — "${snip(t.msg, 80)}"` : ''}`);
        if (r.trace.length > 12) L.push(`    - …and ${r.trace.length - 12} more`);
      }
      L.push('');
    }
    const lt = m.lifetime || { totalSessions: 0, spanDays: 0, ample: false, retire: [], unproven: [], wentQuiet: [], rules: {} };
    L.push('### Rule lifetime — cumulative across all sessions (retirement is a multi-run call)');
    L.push(`- history: **${lt.totalSessions} session${lt.totalSessions === 1 ? '' : 's'}** over **${lt.spanDays} day${lt.spanDays === 1 ? '' : 's'}**` + (lt.ample ? '' : ` — thin sample (need ≥${lt.minSessions} sessions or ≥${lt.minDays} days before a "never ran" means "retire")`));
    if (lt.retire.length) { L.push(`- **Retire candidates** (never ran anywhere, ample opportunity): ${lt.retire.map((id) => `\`${id}\``).join(', ')}`); }
    if (lt.unproven.length) { L.push(`- **Unproven** (never ran this history, too soon to judge — revisit as sessions accrue): ${lt.unproven.map((id) => `\`${id}\``).join(', ')}`); }
    if (lt.wentQuiet.length) { L.push(`- **Went quiet** (fired before, silent >${lt.minDays}d): ${lt.wentQuiet.map((w) => `\`${w.id}\` (${w.daysSince}d ago)`).join(', ')}`); }
    if (!lt.retire.length && !lt.unproven.length && !lt.wentQuiet.length) L.push('- every rule has fired within the window — nothing to retire.');
    L.push('');
    L.push('### Signs injected (this session)');
    if (m.signs.length) {
      L.push('| sign | pack | watches | shown | first-touch | drift |');
      L.push('|---|---|---|--:|--:|--:|');
      for (const g of m.signs) L.push(`| ${g.id} | ${g.ns ?? ''} | ${g.watches ?? ''} | ${g.firstTouch + g.drift} | ${g.firstTouch} | ${g.drift} |`);
      L.push('');
      for (const g of m.signs) if (g.text) L.push(`- **${g.id}**: "${snip(g.text, 160)}"`);
    } else L.push('- no signs injected this session.');
    if (m.orientation && m.orientation.bundles) {
      L.push('');
      L.push(`### Composed orientation (session start): ${m.orientation.bundles} bundle${m.orientation.bundles > 1 ? 's' : ''} · ${m.orientation.lines} lines · ${m.orientation.bytes} bytes`);
      L.push('- keep it terse — orientation says WHERE and WHAT REGIME; depth belongs in the just-in-time area signs. Flag creep.');
    }
  }
  L.push('');

  if (weaken.length) {
    L.push('## ⚠ Rule-weakening flags — a rule fired, then a guardrail file was edited [pointer · judge intent]');
    for (const w of weaken) L.push(`- rule \`${w.rule}\` denied, then \`${w.path}\` edited at L${w.editLine} (~${w.gapSec}s later) — read the edit: authoring a new sign/rule is fine; loosening the one that just blocked you is the user's call.`);
    L.push('');
  }

  const cap = (arr, n, label) => arr.length > n ? `${label} (showing ${n} of ${arr.length})` : `${label} — ${arr.length}`;
  const ctx = (line) => contextAround(events, line, 2).map((c) => `      ${c}`).join('\n');

  L.push('## Session map — the user turns (chapters) [transcript · heuristic]');
  for (const t of a.drift.userTurns) L.push(`- L${t.line} · "${t.text}"`);
  L.push('');

  L.push('## DRIFT SITES — read these, then judge for yourself [transcript · heuristic]');
  L.push('');
  L.push(`### ${cap(a.drift.corrections, 40, 'Course-corrections (the human pushed back — richest signal)')}`);
  for (const c of a.drift.corrections.slice(0, 40)) { L.push(`- L${c.line} · "${c.text}"`); L.push(ctx(c.line)); }
  L.push('');
  L.push(`### ${cap(a.drift.bypassSites, 40, 'justfile bypasses (raw tool run instead of a recipe — name the missing recipe)')}`);
  for (const b of a.drift.bypassSites.slice(0, 40)) L.push(`- L${b.line} · [${b.tool}] \`${b.cmd}\``);
  L.push('');
  L.push(`### ${cap(a.drift.editLoops, 30, 'Edit loops (same file ≥5 in a row — where the agent flailed)')}`);
  for (const lp of a.drift.editLoops.slice(0, 30)) L.push(`- L${lp.fromLine}–${lp.toLine} · ${lp.file} ×${lp.count}`);
  L.push('');
  L.push(`### ${cap(a.drift.retries, 30, 'Bash retries (same command ≥3×)')}`);
  for (const r of a.drift.retries.slice(0, 30)) L.push(`- ×${r.count} · \`${snip(r.cmd, 100)}\` · L${r.lines.slice(0, 8).join(', L')}`);
  L.push('');

  L.push('## Signpost gaps — files you touched that no rule or sign watched (candidate area for a new sign)');
  if (a.signpostGaps.length) for (const g of a.signpostGaps) L.push(`- ${g.file} · touched ×${g.touches}`);
  else L.push('- none — every edited file matched a rule or sign.');
  L.push('');
  L.push(`_justfile: ${tot(s.justCalls)} recipe calls vs ${tot(s.bypasses)} raw-tool bypasses [heuristic] · diff touched ${s.touched.length} files. Numbers above are exact; bypass/correction detection is text-based — triage. Run \`--around <line>\` for a clean view._`);
  return L.join('\n');
}

// ── render: the HTML report card (self-contained, no JS — <details> expanders) ──
function renderHtml(a, m, meta, weaken = []) {
  const date = (meta.started || new Date().toISOString()).slice(0, 10);
  const numH = (n) => (n == null ? '—' : String(n));
  const h = numbersHealth(m);
  const healthLine = h.blocked
    ? `<span class="bad">${esc(h.blocked)}</span>`
    : `<b>${m.matched}</b> matched <span class="sub">(a touched file fell in a rule's scope)</span> · <b>${m.blocked}</b> blocked · <b>${m.overridden}</b> overridden · <b>${m.neverFired.length}</b>/${m.universeCount} rules never fired`
      + (m.signs.length ? ` · <b>${m.signs.length}</b> sign${m.signs.length > 1 ? 's' : ''} injected` : '');
  const warns = (h.warn || []).map((w) => `<p class="warn">${esc(w)}</p>`).join('')
    + (m.legacy ? '<p class="warn">legacy log: some rows predate the matched/check events — matched shown as “—”.</p>' : '');

  // Rules — each an expander: summary = the row, body = verbatim scope/message/description + per-file trace.
  const traceRows = (r) => r.trace.length
    ? `<table class="trace"><thead><tr><th>file</th><th>time</th><th>outcome</th><th>message</th></tr></thead><tbody>`
      + r.trace.slice(0, 40).map((t) => `<tr><td><code>${esc(t.path ?? '')}</code></td><td class="n">${esc((t.ts || '').slice(11, 19))}</td><td class="${t.out === 'deny' ? 'bad' : t.out === 'override' ? 'gold' : 'good'}">${esc(t.out)}</td><td>${t.msg ? esc(snip(t.msg, 100)) : ''}</td></tr>`).join('')
      + (r.trace.length > 40 ? `<tr><td colspan="4" class="mut">…and ${r.trace.length - 40} more</td></tr>` : '')
      + `</tbody></table>`
    : '<p class="mut">no files seen this session</p>';
  const ruleCards = m.rows.length
    ? m.rows.map((r) => {
        const scope = r.scope ? `${r.scope.kind}: ${r.scope.globs.join(', ')}` : 'everything (no scope declared)';
        const tags = `${r.retired ? '<span class="tag ret">retired</span>' : ''}${r.missingGuidance ? '<span class="tag flag">⚠ no message/description</span>' : ''}`;
        return `<details class="rc${r.missingGuidance ? ' isflag' : ''}"><summary>`
          + `<code class="rid">${esc(r.id)}</code><span class="pack">${esc(r.ns ?? '')}</span><span class="when">${esc((r.when || []).join('/'))}</span>`
          + `<span class="ms">matched <b>${numH(r.matched)}</b></span><span class="ms ${r.blocked ? 'bad' : ''}">blocked <b>${r.blocked}</b></span><span class="ms ${r.overridden ? 'gold' : ''}">override <b>${r.overridden}</b></span>${tags}`
          + `</summary><div class="body"><p>scope <code>${esc(scope)}</code></p>`
          + `<p>message: ${r.message ? esc(`"${r.message}"`) : '<span class="mut">none</span>'} · description: ${r.description ? esc(`"${r.description}"`) : '<span class="mut">none</span>'}${r.missingGuidance ? ' <b class="bad">— flag: neither a message nor a description</b>' : ''}</p>`
          + traceRows(r) + `</div></details>`;
      }).join('')
    : '<p class="mut">no rule evaluations recorded this session</p>';

  const lt = m.lifetime || { totalSessions: 0, spanDays: 0, ample: false, retire: [], unproven: [], wentQuiet: [], minSessions: 15, minDays: 30 };
  const idList = (ids) => ids.map((id) => `<code>${esc(id)}</code>`).join(' ');
  const lifetimeRows = [
    `<li><b>${lt.totalSessions}</b> session${lt.totalSessions === 1 ? '' : 's'} over <b>${lt.spanDays}</b> day${lt.spanDays === 1 ? '' : 's'} of history${lt.ample ? '' : ` <span class="sub">— thin sample; a "never ran" needs ≥${lt.minSessions} sessions or ≥${lt.minDays} days to mean "retire"</span>`}</li>`,
    lt.retire.length ? `<li><b class="bad">Retire candidates</b> <span class="sub">(never ran anywhere, ample opportunity)</span>: ${idList(lt.retire)}</li>` : '',
    lt.unproven.length ? `<li><b class="gold">Unproven</b> <span class="sub">(never ran this history — too soon; revisit as sessions accrue)</span>: ${idList(lt.unproven)}</li>` : '',
    lt.wentQuiet.length ? `<li><b class="gold">Went quiet</b> <span class="sub">(fired before, silent &gt;${lt.minDays}d)</span>: ${lt.wentQuiet.map((w) => `<code>${esc(w.id)}</code> <span class="sub">${w.daysSince}d ago</span>`).join(' ')}</li>` : '',
    (!lt.retire.length && !lt.unproven.length && !lt.wentQuiet.length) ? '<li class="mut">every rule has fired within the window — nothing to retire</li>' : '',
  ].filter(Boolean).join('');
  const signCards = m.signs.length
    ? m.signs.map((g) => `<details class="rc"><summary><code class="rid">${esc(g.id)}</code><span class="pack">${esc(g.ns ?? '')}</span><span class="when">${esc(g.watches ?? '')}</span><span class="ms">shown <b>${g.firstTouch + g.drift}</b></span><span class="ms">first <b>${g.firstTouch}</b></span><span class="ms">drift <b>${g.drift}</b></span></summary><div class="body">${g.text ? esc(g.text) : '<span class="mut">no verbatim text in config</span>'}</div></details>`).join('')
    : '<p class="mut">no signs injected this session</p>';
  const gaps = a.signpostGaps.length ? a.signpostGaps.map((g) => `<li><code>${esc(g.file)}</code> <span class="sub">touched ×${g.touches}</span></li>`).join('') : '<li class="mut">none — every edited file matched a rule or sign</li>';
  const turns = a.drift.userTurns.map((t) => `<li><span class="ln">L${t.line}</span> ${esc(t.text)}</li>`).join('') || '<li class="mut">—</li>';
  const corr = a.drift.corrections.length ? a.drift.corrections.map((c) => `<li><span class="ln">L${c.line}</span> ${esc(c.text)}</li>`).join('') : '<li class="mut">none detected</li>';
  const byp = a.drift.bypassSites.length ? a.drift.bypassSites.map((b) => `<li><span class="ln">L${b.line}</span> [${esc(b.tool)}] <code>${esc(b.cmd)}</code></li>`).join('') : '<li class="mut">none detected</li>';
  const loops = a.drift.editLoops.length ? a.drift.editLoops.map((lp) => `<li><span class="ln">L${lp.fromLine}–${lp.toLine}</span> <code>${esc(lp.file)}</code> ×${lp.count}</li>`).join('') : '<li class="mut">none detected</li>';
  const rets = a.drift.retries.length ? a.drift.retries.map((r) => `<li>×${r.count} <code>${esc(snip(r.cmd, 100))}</code></li>`).join('') : '<li class="mut">none detected</li>';
  const orient = m.orientation && m.orientation.bundles
    ? `<h2>Composed orientation <span class="sub">session start · keep it terse (depth belongs in area signs)</span></h2><div class="health">${m.orientation.bundles} bundle${m.orientation.bundles > 1 ? 's' : ''} · ${m.orientation.lines} lines · ${m.orientation.bytes} bytes</div>`
    : '';
  const weakenRows = weaken.length ? weaken.map((w) => `<li><span class="ln">L${w.editLine}</span> rule <code>${esc(w.rule)}</code> denied → <code>${esc(w.path)}</code> edited ~${w.gapSec}s later</li>`).join('') : '';
  const weakenBlock = weaken.length ? `<h2 class="bad">⚠ Rule-weakening flags <span class="sub">[pointer · judge intent — authoring is fine, loosening-to-escape is not]</span></h2><ul>${weakenRows}</ul>` : '';

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Signposts session report — ${esc(meta.session)}</title><style>
:root{--ink:#1b2430;--mut:#5d6b7a;--line:#e4e9f0;--bg:#f7f9fc;--card:#fff;--brand:#2a6fb0;--brand-bg:#eaf3fb;--rule:#c8472f;--rule-bg:#fdeee9;--sign:#1f7a8c;--sign-bg:#e8f5f7;--ok:#1f9d57;--ok-bg:#e9f8ef;--gold:#b07d00;--gold-bg:#fbf3df;--maxw:900px;}
*{box-sizing:border-box}body{font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;color:var(--ink);background:var(--bg);margin:0}
main{max-width:var(--maxw);margin:0 auto;padding:2.2rem 1.4rem 4rem}h1{font-size:1.5rem;margin:0 0 .2rem}h2{font-size:1.05rem;margin:2rem 0 .6rem;padding-bottom:.3rem;border-bottom:2px solid var(--line)}
.sub{color:var(--mut);font-size:.85rem;font-weight:400}.health{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--brand);border-radius:8px;padding:.7rem 1rem;margin:1rem 0}
.warn{color:var(--gold);background:var(--gold-bg);border-radius:6px;padding:.35rem .6rem;margin:.4rem 0;font-size:.85rem}.bad{color:var(--rule)}.good{color:var(--ok)}.gold{color:var(--gold)}
table{border-collapse:collapse;width:100%;background:var(--card);border:1px solid var(--line);border-radius:8px;overflow:hidden;font-size:.85rem;margin:.4rem 0}
th,td{text-align:left;padding:.35rem .55rem;border-bottom:1px solid var(--line)}th{font-size:.7rem;text-transform:uppercase;letter-spacing:.03em;color:var(--mut);background:var(--bg)}
td.n{text-align:right;font-variant-numeric:tabular-nums}.mut{color:var(--mut);font-style:italic}
code{background:#eef1f6;padding:.05rem .3rem;border-radius:4px;font-size:.85em}ul{padding-left:0;list-style:none;margin:.4rem 0}li{padding:.2rem 0;border-bottom:1px solid var(--line)}
.ln{display:inline-block;min-width:3.2rem;color:var(--brand);font-variant-numeric:tabular-nums;font-size:.8rem}
details.rc{background:var(--card);border:1px solid var(--line);border-radius:8px;margin:.35rem 0;overflow:hidden}
details.rc.isflag{border-left:3px solid var(--gold)}
details.rc>summary{cursor:pointer;display:flex;flex-wrap:wrap;align-items:center;gap:.5rem;padding:.5rem .75rem;list-style:none}
details.rc>summary::-webkit-details-marker{display:none}details.rc>summary::before{content:"▸";color:var(--mut);font-size:.8rem}details.rc[open]>summary::before{content:"▾"}
.rid{font-weight:600}.pack{font-size:.72rem;color:var(--sign);background:var(--sign-bg);padding:.05rem .4rem;border-radius:999px}
.when{font-size:.72rem;color:var(--mut)}.ms{font-size:.8rem;color:var(--mut);margin-left:auto}.ms+.ms{margin-left:0}.ms b{color:var(--ink)}
.tag{font-size:.68rem;font-weight:700;padding:.05rem .4rem;border-radius:999px}.tag.flag{color:var(--gold);background:var(--gold-bg)}.tag.ret{color:var(--mut);background:var(--bg);border:1px solid var(--line)}
details.rc .body{padding:.2rem .85rem .7rem;border-top:1px solid var(--line);font-size:.9rem}
table.trace td.bad{color:var(--rule);font-weight:600}table.trace td.good{color:var(--ok)}table.trace td.gold{color:var(--gold);font-weight:600}
</style></head><body><main>
<h1>Signposts session report</h1>
<p class="sub">session <code>${esc(meta.session)}</code> · ${date} · transcript ${esc(meta.file)} (${meta.lines} lines)</p>
<div class="health">${healthLine}</div>${warns}
${weakenBlock}
<h2>Rules — did they engage? <span class="sub">click a rule to see its scope, message &amp; the files it saw</span></h2>${ruleCards}
<h2>Signs injected <span class="sub">click to read the verbatim sign</span></h2>${signCards}
<h2>Rule lifetime <span class="sub">cumulative across all sessions — retirement is a multi-run call</span></h2><ul>${lifetimeRows}</ul>
<h2>Signpost gaps <span class="sub">files you touched that no rule or sign watched</span></h2><ul>${gaps}</ul>
${orient}
<h2>Session map — user turns <span class="sub">[transcript · heuristic]</span></h2><ul>${turns}</ul>
<h2>Course-corrections <span class="sub">[transcript · heuristic]</span></h2><ul>${corr}</ul>
<h2>justfile bypasses <span class="sub">[transcript · heuristic]</span></h2><ul>${byp}</ul>
<h2>Edit loops <span class="sub">[transcript · heuristic — same file ≥5×]</span></h2><ul>${loops}</ul>
<h2>Bash retries <span class="sub">[transcript · heuristic — same command ≥3×]</span></h2><ul>${rets}</ul>
</main></body></html>`;
}

// ── self-test ─────────────────────────────────────────────────────────────
function selfTest() {
  const fail = [];
  let asserted = 0;
  const eq = (got, want, label) => { asserted++; if (JSON.stringify(got) !== JSON.stringify(want)) fail.push(`${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); };

  // ---- transcript-side (narrative) ----
  const tools = parseRecipeTools([
    '# a comment', 'export PATH := "x"', '[doc("build")]', 'test-rules:',
    '    ast-grep test && node src/engine.mjs --test', 'fmt:', '    npx prettier --write .', 'ci:', '    npm ci && vitest run',
  ].join('\n'));
  eq(tools.includes('ast-grep'), true, 'recipeTools: ast-grep from a recipe body');
  eq(tools.includes('vitest'), true, 'recipeTools: vitest from a recipe body');
  eq(tools.includes('npm'), true, 'recipeTools: npm from a recipe body');
  eq(tools.includes('node'), false, 'recipeTools: node is dropped as noise');
  eq(tools.includes('prettier'), false, 'recipeTools: an npx-prefixed tool is dropped (npx is noise)');

  const ev = (obj) => JSON.stringify({ type: 'assistant', message: { content: [obj] } });
  const ut = (text) => JSON.stringify({ type: 'user', message: { content: text } });
  const cwd = '/repo';
  const jsonl = [
    ut('just do the thing'),                                                                  // 1 user turn (no correction)
    ev({ type: 'tool_use', id: 'b2', name: 'Bash', input: { command: 'node_modules/.bin/vitest run' } }), // 2 bypass
    ev({ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: '/repo/src/foo.ts' } }),   // 3
    ev({ type: 'tool_use', id: 'e2', name: 'Edit', input: { file_path: '/repo/src/foo.ts' } }),   // 4
    ev({ type: 'tool_use', id: 'e3', name: 'Edit', input: { file_path: '/repo/src/foo.ts' } }),   // 5
    ev({ type: 'tool_use', id: 'e4', name: 'Edit', input: { file_path: '/repo/src/foo.ts' } }),   // 6
    ev({ type: 'tool_use', id: 'e5', name: 'Edit', input: { file_path: '/repo/src/foo.ts' } }),   // 7 loop ×5
    ut('actually no, that is wrong, revert it'),                                              // 8 correction
  ].join('\n');
  const events = parseEvents(jsonl, cwd);
  const a = analyze({ events, cwd, base: null, tools: ['vitest', 'ast-grep'] });
  eq(a.stats.bypasses['vitest'], 1, 'vitest bypass count');
  eq(a.drift.bypassSites.length, 1, 'one bypass site');
  eq(a.drift.bypassSites[0].line, 2, 'bypass site line');
  eq(a.drift.userTurns.length, 2, 'two user turns');
  eq(a.drift.corrections.length, 1, 'one correction');
  eq(a.drift.corrections[0].line, 8, 'correction line');
  eq(a.drift.editLoops.length, 1, 'one edit loop');
  eq(a.drift.editLoops[0].count, 5, 'loop count');
  eq(a.drift.editLoops[0].fromLine, 3, 'loop from line');
  eq(a.stats.coverage.uncovered.includes('src/foo.ts'), true, 'coverage: uncovered when no signposts.yaml');
  eq(matchGlob('src/lib/**/domain.ts', 'src/lib/courses/domain.ts'), true, 'glob ** match');
  eq(matchGlob('src/lib/**/domain.ts', 'src/lib/courses/db.ts'), false, 'glob ** non-match');
  eq(matchGlob('src/lib/**', 'src/lib/courses/domain.ts'), true, 'signpost glob ** dir match');
  eq(isInjected('<system-reminder>x'), true, 'isInjected: system-reminder');
  eq(isInjected('Caveat: x'), true, 'isInjected: caveat');
  eq(isInjected('please fix the bug'), false, 'isInjected: a real message');
  eq(classifyBash('npx vitest run', ['vitest']).bypasses.includes('vitest'), true, 'classifyBash: raw vitest is a bypass');
  eq(classifyBash('just test', ['vitest']).bypasses.length, 0, 'classifyBash: via-just is not a bypass');
  eq(classifyBash('cat > f <<EOF\nvitest\nEOF', ['vitest']).bypasses.length, 0, 'classifyBash: heredoc body not classified');

  // ---- weaken-after-deny detection ----
  eq(isGuardrailPath('signposts.yaml'), true, 'guardrail: signposts.yaml');
  eq(isGuardrailPath('rules/core/x.mjs'), true, 'guardrail: rules/**');
  eq(isGuardrailPath('.claude/settings.json'), true, 'guardrail: settings.json');
  eq(isGuardrailPath('src/foo.ts'), false, 'guardrail: a normal file is not one');
  const tev = (id, name, file, ts) => JSON.stringify({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'tool_use', id, name, input: { file_path: file } }] } });
  const wEvents = parseEvents([
    tev('a', 'Edit', '/repo/rules/x.mjs', '2026-07-06T00:00:02Z'),      // guardrail but BEFORE the deny
    tev('b', 'Edit', '/repo/signposts.yaml', '2026-07-06T00:00:10Z'),   // guardrail, AFTER → flag
    tev('c', 'Edit', '/repo/src/foo.ts', '2026-07-06T00:00:11Z'),       // after but NOT a guardrail
  ].join('\n'), '/repo');
  const flags = weakenAfterDeny([{ kind: 'deny', ts: '2026-07-06T00:00:05Z', rule: 'demo' }], wEvents);
  eq(flags.length, 1, 'weaken: exactly one flag (the guardrail edit after the deny)');
  eq(flags[0] && flags[0].rule, 'demo', 'weaken: flag cites the denied rule');
  eq(flags[0] && flags[0].path, 'signposts.yaml', 'weaken: flag cites the edited guardrail');
  eq(weakenAfterDeny([], wEvents).length, 0, 'weaken: no denies → no flags');

  // ---- log-side (numbers) — synthetic v2 log in a temp root ----
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-report-'));
  try {
    fs.writeFileSync(path.join(tmp, 'signposts.yaml'),
      'rules:\n  core:\n' +
      '    - id: demo\n      use: core/protected-path\n      deny: ["x"]\n      message: "no x"\n      description: "blocks x"\n' +
      '    - id: sleepy\n      use: core/protected-path\n      deny: ["y"]\n' +           // never fired → retire candidate
      '    - id: bare\n      use: core/protected-path\n      deny: ["z"]\n' +              // no message + no description → flagged
      '    - id: delguard\n      use: core/protected-path\n      deny: ["d"]\n');           // the overridden one
    const logDir = path.join(tmp, '.signposts', 'log');
    fs.mkdirSync(logDir, { recursive: true });
    const sess = 'sess-abc';
    fs.writeFileSync(path.join(logDir, `${sess}.jsonl`), [
      JSON.stringify({ kind: 'meta', v: 1, session: sess, started: '2026-07-06T00:00:00.000Z' }),
      // demo evaluated 3 but matched only 1 (the deny-rule poster case); bare + delguard + ghost each match 1.
      JSON.stringify({ ts: '2026-07-06T00:00:01Z', kind: 'run', phase: 'edit', files: 4, rules: [
        { id: 'demo', evaluated: 3, matched: 1, hits: 1 }, { id: 'bare', evaluated: 2, matched: 1, hits: 0 },
        { id: 'delguard', evaluated: 1, matched: 1, hits: 1 }, { id: 'ghost', evaluated: 1, matched: 1, hits: 1 }] }),
      JSON.stringify({ ts: '2026-07-06T00:00:01Z', kind: 'check', phase: 'edit', rule: 'demo', ns: 'core', path: 'x', out: 'deny', msg: 'no x' }),
      JSON.stringify({ ts: '2026-07-06T00:00:01Z', kind: 'check', phase: 'edit', rule: 'bare', ns: 'core', path: 'z', out: 'allow' }),
      JSON.stringify({ ts: '2026-07-06T00:00:01Z', kind: 'check', phase: 'edit', rule: 'delguard', ns: 'core', path: 'd', out: 'override' }),
      JSON.stringify({ ts: '2026-07-06T00:00:01Z', kind: 'check', phase: 'edit', rule: 'ghost', ns: 'core', path: 'g', out: 'deny', msg: 'gone' }),   // ghost: in log, gone from config → retired
      JSON.stringify({ ts: '2026-07-06T00:00:01Z', kind: 'deny', phase: 'edit', rule: 'demo', ns: 'core', path: 'x', hits: ['nope'] }),  // back-compat deny alongside check
      JSON.stringify({ ts: '2026-07-06T00:00:02Z', kind: 'sign', sign: 'rules', reason: 'first-touch' }),
      JSON.stringify({ ts: '2026-07-06T00:00:03Z', kind: 'sign', sign: 'rules', reason: 'drift' }),
      'corrupt {not json',
    ].join('\n') + '\n');
    // a commit-gate block AFTER session start (marker-less fallback → commit.jsonl) → demo blocked@commit
    fs.writeFileSync(path.join(logDir, 'commit.jsonl'), [
      JSON.stringify({ kind: 'meta', v: 1, session: 'commit', started: '2026-07-06T00:00:00Z' }),
      JSON.stringify({ ts: '2026-07-06T00:05:00Z', kind: 'run', phase: 'commit', files: 2, rules: [{ id: 'demo', evaluated: 2, matched: 1, hits: 1 }] }),
      JSON.stringify({ ts: '2026-07-06T00:05:00Z', kind: 'check', phase: 'commit', rule: 'demo', ns: 'core', path: 'x', out: 'deny', msg: 'no x' }),
    ].join('\n') + '\n');

    const m = logMetrics(tmp, sess);
    eq(m.logPresent, true, 'logMetrics: log present');
    eq(m.sessionArmed, true, 'logMetrics: session armed');
    eq(m.badLines, 1, 'logMetrics: counts the corrupt line (fail-loud)');
    eq(m.legacy, false, 'logMetrics: v2 log is not legacy');
    const demo = m.rows.find((r) => r.id === 'demo');
    eq(demo.matched, 2, 'logMetrics: demo matched 1@edit + 1@commit');
    eq(demo.blocked, 2, 'logMetrics: demo blocked 1@edit + 1@commit');
    eq(demo.blockedCommit, 1, 'logMetrics: demo blocked@commit attributed via window');
    eq(demo.overridden, 0, 'logMetrics: demo not overridden');
    eq([demo.message, demo.description].join('|'), 'no x|blocks x', 'logMetrics: demo joins verbatim message + description');
    eq(demo.trace.length, 2, 'logMetrics: demo per-file trace = 2 check events');
    const bare = m.rows.find((r) => r.id === 'bare');
    eq(bare.matched, 1, 'logMetrics: bare matched 1');
    eq(bare.blocked, 0, 'logMetrics: bare blocked 0 (allowed)');
    eq(bare.missingGuidance, true, 'logMetrics: bare flagged (no message + no description)');
    const delguard = m.rows.find((r) => r.id === 'delguard');
    eq(delguard.overridden, 1, 'logMetrics: delguard overridden 1');
    eq(delguard.blocked, 0, 'logMetrics: an override is not a block');
    const ghost = m.rows.find((r) => r.id === 'ghost');
    eq(ghost.retired, true, 'logMetrics: ghost is retired (in log, gone from config)');
    eq(m.matched, 5, 'logMetrics: total matched = demo2 + bare1 + delguard1 + ghost1');
    eq(m.blocked, 3, 'logMetrics: total blocked = demo2 + ghost1');
    eq(m.overridden, 1, 'logMetrics: total overridden = delguard1');
    eq(m.flagged, ['bare', 'delguard'], 'logMetrics: flagged rules (both lack a message + description)');
    eq(m.retired, ['ghost'], 'logMetrics: retired rules');
    // a LATER real session bounds the window: the 00:05 commit block is no longer THIS session's.
    fs.writeFileSync(path.join(logDir, 'sess-later.jsonl'), JSON.stringify({ kind: 'meta', v: 1, session: 'sess-later', started: '2026-07-06T00:02:00Z' }) + '\n');
    eq(logMetrics(tmp, sess).rows.find((r) => r.id === 'demo').blocked, 1, 'logMetrics: commit block after the next session start is not attributed');
    fs.rmSync(path.join(logDir, 'sess-later.jsonl'));
    eq(m.neverFired, ['sleepy'], 'logMetrics: sleepy never fired (others did)');
    eq(m.signs.find((s) => s.id === 'rules').firstTouch, 1, 'logMetrics: sign first-touch');
    eq(m.signs.find((s) => s.id === 'rules').drift, 1, 'logMetrics: sign drift');

    // legacy log (no matched, no check events) → matched shown as null, blocked from deny events, flagged legacy.
    const legRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-legacy-'));
    fs.mkdirSync(path.join(legRoot, '.signposts', 'log'), { recursive: true });
    fs.writeFileSync(path.join(legRoot, 'signposts.yaml'), 'rules:\n  core:\n    - id: demo\n      use: core/protected-path\n      deny: ["x"]\n');
    fs.writeFileSync(path.join(legRoot, '.signposts', 'log', 'leg.jsonl'), [
      JSON.stringify({ kind: 'meta', v: 1, session: 'leg', started: '2026-07-06T00:00:00Z' }),
      JSON.stringify({ ts: '2026-07-06T00:00:01Z', kind: 'run', phase: 'edit', files: 5, rules: [{ id: 'demo', evaluated: 5, hits: 2 }] }),
      JSON.stringify({ ts: '2026-07-06T00:00:01Z', kind: 'deny', phase: 'edit', rule: 'demo', ns: 'core', path: 'x', hits: ['nope'] }),
      JSON.stringify({ ts: '2026-07-06T00:00:02Z', kind: 'deny', phase: 'edit', rule: 'demo', ns: 'core', path: 'x', hits: ['nope'] }),
    ].join('\n') + '\n');
    const mLeg = logMetrics(legRoot, 'leg');
    eq(mLeg.legacy, true, 'logMetrics: legacy log flagged');
    eq(mLeg.rows.find((r) => r.id === 'demo').matched, null, 'logMetrics: legacy matched is null (unknown)');
    eq(mLeg.rows.find((r) => r.id === 'demo').blocked, 2, 'logMetrics: legacy blocked from deny events');
    fs.rmSync(legRoot, { recursive: true, force: true });

    // ---- cumulative ledger (multi-run retirement grading) — pure over synthetic session logs ----
    const now = Date.parse('2026-07-17T00:00:00Z');
    const mkLog = (sess, started, ruleTallies) => ({ session: sess, events: [
      { kind: 'meta', session: sess, started }, { ts: started, kind: 'run', phase: 'edit', rules: ruleTallies } ] });
    const logs = [
      mkLog('s1', '2026-05-01T00:00:00Z', [{ id: 'active', evaluated: 5, matched: 2, hits: 1 }, { id: 'ranquiet', evaluated: 3, matched: 1, hits: 1 }]),
      mkLog('s2', '2026-06-01T00:00:00Z', [{ id: 'active', evaluated: 4, matched: 1, hits: 1 }]),
      mkLog('s3', '2026-07-15T00:00:00Z', [{ id: 'active', evaluated: 2, matched: 1, hits: 1 }]),
    ];
    const led = buildLedger(logs, ['active', 'ranquiet', 'dormant'], now, { minSessions: 2, minDays: 10 });
    eq(led.totalSessions, 3, 'ledger: 3 distinct sessions');
    eq(led.rules.active.evaluated, 11, 'ledger: active evaluated summed across sessions');
    eq(led.rules.active.fired, 3, 'ledger: active fired (hits) summed');
    eq(led.rules.active.sessions, 3, 'ledger: active seen in 3 sessions');
    eq(led.ample, true, 'ledger: ample sample (≥2 sessions)');
    eq(led.retire, ['dormant'], 'ledger: a rule that never ran anywhere → retire (ample opportunity)');
    eq(led.wentQuiet.map((w) => w.id), ['ranquiet'], 'ledger: fired long ago, silent since → went quiet');
    // thin sample: same logs, high thresholds → nothing retired, dormant is "unproven" instead.
    const thin = buildLedger(logs, ['active', 'dormant'], now, { minSessions: 50, minDays: 365 });
    eq(thin.ample, false, 'ledger: thin sample is not ample');
    eq(thin.unproven, ['dormant'], 'ledger: never-ran rule is UNPROVEN (not retired) on a thin sample');
    eq(thin.retire, [], 'ledger: a one/two-run history retires nothing (the whole point)');
    // the shared 'commit' file adds to totals but is not a distinct session.
    const withCommit = buildLedger([...logs, mkLog('commit', '2026-07-16T00:00:00Z', [{ id: 'active', evaluated: 1, matched: 0, hits: 0 }])], ['active'], now, { minSessions: 2, minDays: 10 });
    eq(withCommit.totalSessions, 3, "ledger: the 'commit' file is not counted as a distinct session");
    eq(withCommit.rules.active.evaluated, 12, 'ledger: commit-file events still add to a rule\'s lifetime totals');

    // fail-loud distinctions
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-empty-'));
    eq(numbersHealth(logMetrics(emptyRoot, 'nope')).blocked ? true : false, true, 'fail-loud: no log → blocked message (not zeros)');
    fs.rmSync(emptyRoot, { recursive: true, force: true });
    const mMiss = logMetrics(tmp, 'ghost-session');
    eq(mMiss.logPresent, true, 'fail-loud: dir present for a ghost session');
    eq(mMiss.sessionArmed, false, 'fail-loud: ghost session not armed');
    eq(numbersHealth(mMiss).warn.some((w) => /session id/.test(w)), true, 'fail-loud: ghost session warns explicitly');

    // renderHtml smoke — self-contained, the new headline, expanders, escapes.
    const html = renderHtml(a, m, { session: sess, file: 't.jsonl', lines: 8, started: '2026-07-06T00:00:00Z' });
    eq(/<!doctype html>/i.test(html) && html.includes('matched') && html.includes('Rules — did they engage') && html.includes('<details'), true, 'renderHtml: self-contained report card with expanders');
    // renderMarkdown smoke — leads with matched, drops evaluated from the human render.
    const md = renderMarkdown(a, m, [], { session: sess, file: 't.jsonl', lines: 8 });
    eq(md.includes('matched') && !/\|\s*evaluated\s*\|/.test(md), true, 'renderMarkdown: matched leads, evaluated dropped from the table');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  if (fail.length) { console.error('SELF-TEST FAILED:\n  ' + fail.join('\n  ')); process.exit(1); }
  console.log(`session-report self-test: PASS (${asserted} assertions)`);
}

// ── main ──────────────────────────────────────────────────────────────────
function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--test')) return selfTest();
  const getArg = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
  const cwd = process.cwd();
  const transcript = getArg('--transcript') || newestTranscript(cwd);
  if (!transcript || !fs.existsSync(transcript)) {
    console.error(`No transcript found (looked in ${projectDir(cwd)}). Pass --transcript <path>.`);
    process.exit(1);
  }
  let jsonl;
  try { jsonl = fs.readFileSync(transcript, 'utf8'); }
  catch (e) { console.error(`Transcript unreadable (${transcript}): ${e.message}`); process.exit(1); }  // fail loud
  const events = parseEvents(jsonl, cwd);

  const around = getArg('--around');
  if (around) {
    const radius = parseInt(getArg('--radius') || '8', 10);
    console.log(`# Tool-use context around L${around} (±${radius}) in ${path.basename(transcript)}`);
    console.log(contextAround(events, parseInt(around, 10), radius).join('\n'));
    return;
  }

  const session = path.basename(transcript, '.jsonl');
  const base = detectBase(getArg('--base'));
  const a = analyze({ events, cwd, base, tools: recipeTools(cwd) });
  const m = logMetrics(cwd, session);
  const logEv = readEvents(cwd, { session }).events;
  const weaken = weakenAfterDeny(logEv, events);
  const meta = { session, file: path.basename(transcript), lines: jsonl.split('\n').length,
    started: logEv.find((e) => e.kind === 'meta')?.started };

  if (argv.includes('--json')) { console.log(JSON.stringify({ stats: a.stats, drift: a.drift, signpostGaps: a.signpostGaps, metrics: m, weakenFlags: weaken }, null, 2)); return; }
  if (argv.includes('--html')) {
    const dir = path.join(cwd, '.signposts', 'reports');
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, `${sanitise(session)}.html`);
    fs.writeFileSync(out, renderHtml(a, m, meta, weaken));
    console.log(out);
    return;
  }
  console.log(renderMarkdown(a, m, events, meta, weaken));
}

main();
