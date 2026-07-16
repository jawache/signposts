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

// ── the hard numbers, from the event log ───────────────────────────────────
// session = the Claude session id (transcript basename). Per-session run/deny/sign
// events give fires + edit-catches + injections; commit-phase denies (logged under
// the shared 'commit' session) that fall after this session started count as leaks.
// never-fired is computed across ALL sessions (a rule that never fired anywhere is a
// retire candidate). Fails loud: a missing log and an armed-but-empty log are distinct.
function logMetrics(root, session) {
  const universe = (() => { try { return loadRules(root).map((r) => ({ id: r.id, ns: r.namespace ?? null })); } catch { return []; } })();
  const sessionLog = readEvents(root, { session });
  const allLog = readEvents(root, {});

  const started = (() => {
    const meta = sessionLog.events.find((e) => e.kind === 'meta');
    if (meta && meta.started) return meta.started;
    const ts = sessionLog.events.map((e) => e.ts).filter(Boolean).sort();
    return ts[0] || null;
  })();
  // Upper bound for commit-leak attribution = the NEXT real session's start. Commit-gate runs
  // log under the shared 'commit' id (no session), so a session owns the commit denies from its
  // start until the next Claude session begins. Without this bound, re-running facts on an old
  // session would sweep up every later commit as its "leak", and overlapping sessions would
  // cross-attribute. (The newest session has no next start yet — it self-corrects once one exists.)
  const nextStart = allLog.events
    .filter((e) => e.kind === 'meta' && e.started && e.session && e.session !== 'commit' && started && e.started > started)
    .map((e) => e.started).sort()[0] || null;

  const perRule = {};
  const ensure = (id, ns) => (perRule[id] ||= { id, ns: ns ?? null, fires: 0, hits: 0, caught: 0, leaked: 0 });
  for (const e of sessionLog.events) {
    if (e.kind === 'run') for (const r of e.rules || []) { const t = ensure(r.id); t.fires += r.evaluated || 0; t.hits += r.hits || 0; }
    else if (e.kind === 'deny' && e.phase === 'edit') ensure(e.rule, e.ns).caught++;
  }
  // commit/push denies live in commit.jsonl (no session id) — attribute the ones in this
  // session's window [started, nextStart).
  for (const e of allLog.events) {
    if (e.kind === 'deny' && (e.phase === 'commit' || e.phase === 'push')
        && (!started || (e.ts && e.ts >= started && (!nextStart || e.ts < nextStart)))) ensure(e.rule, e.ns).leaked++;
  }

  // run tallies carry only {id, evaluated, hits} — backfill each row's namespace from
  // the rule universe (a static property) so the table isn't blank for never-denied rules.
  const nsById = Object.fromEntries(universe.map((u) => [u.id, u.ns]));
  for (const r of Object.values(perRule)) if (r.ns == null && nsById[r.id] != null) r.ns = nsById[r.id];

  const firesAll = {};
  for (const e of allLog.events) if (e.kind === 'run') for (const r of e.rules || []) firesAll[r.id] = (firesAll[r.id] || 0) + (r.evaluated || 0);
  const neverFired = universe.filter((u) => !(firesAll[u.id] > 0)).map((u) => u.id).sort();

  const signs = {};
  for (const e of sessionLog.events) if (e.kind === 'sign') {
    const t = (signs[e.sign] ||= { id: e.sign, firstTouch: 0, drift: 0 });
    if (e.reason === 'drift') t.drift++; else t.firstTouch++;
  }

  const rows = Object.values(perRule).sort((a, b) => a.id.localeCompare(b.id));
  const realEvents = sessionLog.events.filter((e) => e.kind && e.kind !== 'meta').length;
  // Composed-orientation size: the SessionStart block every session pays for up front. Tracked so
  // the coach can flag creep — orientation should stay terse (a few lines per bundle); depth belongs
  // in the just-in-time area signs, not here.
  const orientation = (() => {
    try { const { text, ids } = composeOrientation(loadConfig(root)); return { bundles: ids.length, lines: text ? text.split('\n').length : 0, bytes: text.length }; }
    catch { return { bundles: 0, lines: 0, bytes: 0 }; }
  })();
  return {
    logPresent: allLog.files > 0,           // the .signposts/log dir has any file
    sessionArmed: sessionLog.files > 0,      // THIS session recorded events
    realEvents, badLines: allLog.badLines,
    rows, neverFired, signs: Object.values(signs).sort((a, b) => a.id.localeCompare(b.id)),
    caught: rows.reduce((s, r) => s + r.caught, 0),
    leaked: rows.reduce((s, r) => s + r.leaked, 0),
    universeCount: universe.length, orientation,
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
      const inRepo = e.rel && !e.rel.startsWith('/') && !e.rel.startsWith('..');
      if (inRepo && e.rel === loopFile) { loopCount++; loopLast = e.line; }
      else { flushLoop(); loopFile = inRepo ? e.rel : null; loopFrom = e.line; loopLast = e.line; loopCount = inRepo ? 1 : 0; }
      if (!inRepo) continue;
      (editedFilesByDir[path.dirname(e.rel)] ||= new Set()).add(e.rel);
    } else if (e.name === 'Read') {
      if (e.rel === 'justfile' || /(^|\/)justfile$/.test(e.rel)) reads.justfile++;
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

  const signGlobs = readSignpostGlobs(cwd);
  const touchedFiles = [...new Set(Object.values(editedFilesByDir).flatMap((s) => [...s]))];
  const covered = [], uncovered = [];
  for (const f of touchedFiles) (signGlobs.some((g) => matchGlob(g, f)) ? covered : uncovered).push(f);

  return {
    stats: { edits, writes, commits, justCalls, bypasses, reads,
      coverage: { covered: covered.sort(), uncovered: uncovered.sort() }, touched: gitTouchedFiles(base) },
    drift: { userTurns, corrections, bypassSites, editLoops, retries },
    signpostGaps: uncovered.sort(),
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

  L.push('## Event log — the hard numbers (deterministic)');
  const h = numbersHealth(m);
  if (h.blocked) { L.push(`- **${h.blocked}**`); }
  else {
    for (const w of h.warn) L.push(`- **${w}**`);
    L.push(`- health: **${m.caught} caught pre-emptively (edit)** · **${m.leaked} leaked to the commit gate** · **${m.neverFired.length} of ${m.universeCount} rules never fired**` + (m.signs.length ? ` · ${m.signs.length} sign${m.signs.length > 1 ? 's' : ''} injected` : ''));
    L.push('');
    if (m.rows.length) {
      L.push('| rule | ns | evaluated | hits | caught@edit | leaked@commit |');
      L.push('|---|---|--:|--:|--:|--:|');
      for (const r of m.rows) L.push(`| ${r.id} | ${r.ns ?? ''} | ${r.fires} | ${r.hits} | ${r.caught} | ${r.leaked} |`);
    } else L.push('- no rule evaluations recorded this session.');
    L.push('');
    L.push(`### Never-fired rules (${m.neverFired.length} — retire candidates, in signposts.yaml but 0 fires across all sessions)`);
    for (const id of m.neverFired) L.push(`- ${id}`);
    if (m.signs.length) {
      L.push('');
      L.push('### Signs injected (this session)');
      for (const g of m.signs) L.push(`- ${g.id} · first-touch ×${g.firstTouch} · drift ×${g.drift}`);
    }
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

  L.push('## Signpost gaps — touched files matching no sign (candidate area for a new sign)');
  for (const f of a.signpostGaps) L.push(`- ${f}`);
  L.push('');
  L.push(`_justfile: ${tot(s.justCalls)} recipe calls vs ${tot(s.bypasses)} raw-tool bypasses [heuristic] · diff touched ${s.touched.length} files. Numbers above are exact; bypass/correction detection is text-based — triage. Run \`--around <line>\` for a clean view._`);
  return L.join('\n');
}

// ── render: the HTML report card (self-contained, no JS) ───────────────────
function renderHtml(a, m, meta, weaken = []) {
  const date = (meta.started || new Date().toISOString()).slice(0, 10);
  const h = numbersHealth(m);
  const healthLine = h.blocked
    ? `<span class="bad">${esc(h.blocked)}</span>`
    : `<b>${m.caught}</b> caught pre-emptively · <b>${m.leaked}</b> leaked to the commit gate · <b>${m.neverFired.length}</b>/${m.universeCount} rules never fired`
      + (m.signs.length ? ` · <b>${m.signs.length}</b> sign${m.signs.length > 1 ? 's' : ''} injected` : '');
  const warns = (h.warn || []).map((w) => `<p class="warn">${esc(w)}</p>`).join('');

  const ruleRows = m.rows.length
    ? m.rows.map((r) => `<tr><td><code>${esc(r.id)}</code></td><td>${esc(r.ns ?? '')}</td><td class="n">${r.fires}</td><td class="n">${r.hits}</td><td class="n ${r.caught ? 'good' : ''}">${r.caught}</td><td class="n ${r.leaked ? 'bad' : ''}">${r.leaked}</td></tr>`).join('')
    : '<tr><td colspan="6" class="mut">no rule evaluations recorded this session</td></tr>';
  const neverRows = m.neverFired.length ? m.neverFired.map((id) => `<li><code>${esc(id)}</code></li>`).join('') : '<li class="mut">none — every rule fired at least once</li>';
  const signRows = m.signs.length
    ? m.signs.map((g) => `<tr><td><code>${esc(g.id)}</code></td><td class="n">${g.firstTouch}</td><td class="n">${g.drift}</td></tr>`).join('')
    : '<tr><td colspan="3" class="mut">no signs injected this session</td></tr>';
  const turns = a.drift.userTurns.map((t) => `<li><span class="ln">L${t.line}</span> ${esc(t.text)}</li>`).join('') || '<li class="mut">—</li>';
  const corr = a.drift.corrections.length ? a.drift.corrections.map((c) => `<li><span class="ln">L${c.line}</span> ${esc(c.text)}</li>`).join('') : '<li class="mut">none detected</li>';
  const byp = a.drift.bypassSites.length ? a.drift.bypassSites.map((b) => `<li><span class="ln">L${b.line}</span> [${esc(b.tool)}] <code>${esc(b.cmd)}</code></li>`).join('') : '<li class="mut">none detected</li>';
  const weakenRows = weaken.length
    ? weaken.map((w) => `<li><span class="ln">L${w.editLine}</span> rule <code>${esc(w.rule)}</code> denied → <code>${esc(w.path)}</code> edited ~${w.gapSec}s later</li>`).join('')
    : '';
  const weakenBlock = weaken.length
    ? `<h2 class="bad">⚠ Rule-weakening flags <span class="sub">[pointer · judge intent — authoring is fine, loosening-to-escape is not]</span></h2><ul>${weakenRows}</ul>`
    : '';

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Signposts session report — ${esc(meta.session)}</title><style>
:root{--ink:#1b2430;--mut:#5d6b7a;--line:#e4e9f0;--bg:#f7f9fc;--card:#fff;--brand:#2a6fb0;--brand-bg:#eaf3fb;--rule:#c8472f;--rule-bg:#fdeee9;--sign:#1f7a8c;--sign-bg:#e8f5f7;--ok:#1f9d57;--ok-bg:#e9f8ef;--gold:#b07d00;--gold-bg:#fbf3df;--maxw:880px;}
*{box-sizing:border-box}body{font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;color:var(--ink);background:var(--bg);margin:0}
main{max-width:var(--maxw);margin:0 auto;padding:2.2rem 1.4rem 4rem}h1{font-size:1.5rem;margin:0 0 .2rem}h2{font-size:1.05rem;margin:2rem 0 .6rem;padding-bottom:.3rem;border-bottom:2px solid var(--line)}
.sub{color:var(--mut);font-size:.85rem}.health{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--brand);border-radius:8px;padding:.7rem 1rem;margin:1rem 0}
.warn{color:var(--gold);background:var(--gold-bg);border-radius:6px;padding:.35rem .6rem;margin:.4rem 0;font-size:.85rem}.bad{color:var(--rule)}.good{color:var(--ok)}
table{border-collapse:collapse;width:100%;background:var(--card);border:1px solid var(--line);border-radius:8px;overflow:hidden;font-size:.88rem}
th,td{text-align:left;padding:.4rem .6rem;border-bottom:1px solid var(--line)}th{font-size:.72rem;text-transform:uppercase;letter-spacing:.03em;color:var(--mut);background:var(--bg)}
td.n{text-align:right;font-variant-numeric:tabular-nums}td.good{color:var(--ok);font-weight:700}td.bad{color:var(--rule);font-weight:700}.mut{color:var(--mut);font-style:italic}
code{background:#eef1f6;padding:.05rem .3rem;border-radius:4px;font-size:.85em}ul{padding-left:0;list-style:none;margin:.4rem 0}li{padding:.2rem 0;border-bottom:1px solid var(--line)}
.ln{display:inline-block;min-width:3.2rem;color:var(--brand);font-variant-numeric:tabular-nums;font-size:.8rem}
</style></head><body><main>
<h1>Signposts session report</h1>
<p class="sub">session <code>${esc(meta.session)}</code> · ${date} · transcript ${esc(meta.file)} (${meta.lines} lines)</p>
<div class="health">${healthLine}</div>${warns}
${weakenBlock}
<h2>Per-rule (this session)</h2>
<table><thead><tr><th>rule</th><th>ns</th><th>evaluated</th><th>hits</th><th>caught@edit</th><th>leaked@commit</th></tr></thead><tbody>${ruleRows}</tbody></table>
<h2>Never-fired rules — retire candidates</h2><ul>${neverRows}</ul>
<h2>Signs injected</h2>
<table><thead><tr><th>sign</th><th>first-touch</th><th>drift</th></tr></thead><tbody>${signRows}</tbody></table>
<h2>Session map — user turns <span class="sub">[transcript · heuristic]</span></h2><ul>${turns}</ul>
<h2>Course-corrections <span class="sub">[transcript · heuristic]</span></h2><ul>${corr}</ul>
<h2>justfile bypasses <span class="sub">[transcript · heuristic]</span></h2><ul>${byp}</ul>
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

  // ---- log-side (numbers) — synthetic log in a temp root ----
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-report-'));
  try {
    fs.writeFileSync(path.join(tmp, 'signposts.yaml'),
      'rules:\n  core:\n    - id: demo\n      use: core/protected-path\n      deny: ["x"]\n    - id: sleepy\n      use: core/protected-path\n      deny: ["y"]\n');
    const logDir = path.join(tmp, '.signposts', 'log');
    fs.mkdirSync(logDir, { recursive: true });
    const sess = 'sess-abc';
    fs.writeFileSync(path.join(logDir, `${sess}.jsonl`), [
      JSON.stringify({ kind: 'meta', v: 1, session: sess, started: '2026-07-06T00:00:00.000Z' }),
      JSON.stringify({ ts: '2026-07-06T00:00:01Z', kind: 'run', phase: 'edit', files: 1, rules: [{ id: 'demo', evaluated: 3, hits: 1 }] }),
      JSON.stringify({ ts: '2026-07-06T00:00:01Z', kind: 'deny', phase: 'edit', rule: 'demo', ns: 'core', path: 'x', hits: ['nope'] }),
      JSON.stringify({ ts: '2026-07-06T00:00:02Z', kind: 'sign', sign: 'rules', reason: 'first-touch' }),
      JSON.stringify({ ts: '2026-07-06T00:00:03Z', kind: 'sign', sign: 'rules', reason: 'drift' }),
      'corrupt {not json',
    ].join('\n') + '\n');
    // a commit-gate deny AFTER session start → counts as a leak for demo
    fs.writeFileSync(path.join(logDir, 'commit.jsonl'), [
      JSON.stringify({ kind: 'meta', v: 1, session: 'commit', started: '2026-07-06T00:00:00Z' }),
      JSON.stringify({ ts: '2026-07-06T00:05:00Z', kind: 'run', phase: 'commit', files: 2, rules: [{ id: 'demo', evaluated: 2, hits: 1 }] }),
      JSON.stringify({ ts: '2026-07-06T00:05:00Z', kind: 'deny', phase: 'commit', rule: 'demo', ns: 'core', path: 'x', hits: ['leaked'] }),
    ].join('\n') + '\n');

    const m = logMetrics(tmp, sess);
    eq(m.logPresent, true, 'logMetrics: log present');
    eq(m.sessionArmed, true, 'logMetrics: session armed');
    eq(m.badLines, 1, 'logMetrics: counts the corrupt line (fail-loud)');
    const demo = m.rows.find((r) => r.id === 'demo');
    eq(demo.fires, 3, 'logMetrics: demo evaluated 3 (edit run)');
    eq(demo.caught, 1, 'logMetrics: demo caught 1 at edit');
    eq(demo.leaked, 1, 'logMetrics: demo leaked 1 at commit (since session start)');
    eq(m.caught, 1, 'logMetrics: total caught');
    eq(m.leaked, 1, 'logMetrics: total leaked');
    // a LATER real session bounds the window: the 00:05 commit deny is no longer THIS session's leak.
    fs.writeFileSync(path.join(logDir, 'sess-later.jsonl'), JSON.stringify({ kind: 'meta', v: 1, session: 'sess-later', started: '2026-07-06T00:02:00Z' }) + '\n');
    eq(logMetrics(tmp, sess).leaked, 0, 'logMetrics: commit leak after the next session start is not attributed');
    fs.rmSync(path.join(logDir, 'sess-later.jsonl'));
    eq(m.neverFired, ['sleepy'], 'logMetrics: sleepy never fired (demo did)');
    eq(m.signs.find((s) => s.id === 'rules').firstTouch, 1, 'logMetrics: sign first-touch');
    eq(m.signs.find((s) => s.id === 'rules').drift, 1, 'logMetrics: sign drift');

    // fail-loud distinctions
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-empty-'));
    eq(numbersHealth(logMetrics(emptyRoot, 'nope')).blocked ? true : false, true, 'fail-loud: no log → blocked message (not zeros)');
    fs.rmSync(emptyRoot, { recursive: true, force: true });
    // armed (commit.jsonl present) but this session id absent → a warn, not "blocked", not silent zeros
    const mMiss = logMetrics(tmp, 'ghost-session');
    eq(mMiss.logPresent, true, 'fail-loud: dir present for a ghost session');
    eq(mMiss.sessionArmed, false, 'fail-loud: ghost session not armed');
    eq(numbersHealth(mMiss).warn.some((w) => /session id/.test(w)), true, 'fail-loud: ghost session warns explicitly');

    // renderHtml smoke — non-empty, self-contained, escapes
    const html = renderHtml(a, m, { session: sess, file: 't.jsonl', lines: 8, started: '2026-07-06T00:00:00Z' });
    eq(/<!doctype html>/i.test(html) && html.includes('Per-rule') && html.includes('caught pre-emptively'), true, 'renderHtml: self-contained report card');
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
