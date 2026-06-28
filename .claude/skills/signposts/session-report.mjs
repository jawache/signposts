#!/usr/bin/env node
/**
 * Signposts facts + drift pointers for the `coach` agent — the detector half of
 * the /signposts loop (run by `/signposts audit`, chained from `/review`'s wrap-up).
 *
 * Deterministic measurement belongs in a script; judgement belongs in the agent
 * (same split as a `rules/` check vs the agent). Coach used to grep the raw
 * transcript — unreliable (grep can't tell a real hook fire from us *discussing*
 * hooks) and opaque (the JSONL is one fat event per line, so coach can't even
 * see where the tool uses are). This LINEARISES the transcript: it counts the
 * hard stats, and — crucially — emits a navigable INDEX with transcript line
 * numbers (the session map + drift sites), so coach reads the actual spots and
 * forms its own judgement rather than trusting a summary.
 *
 * Output:
 *   • Hard stats — lefthook fires/outcomes, justfile hit-rate, signpost coverage, diff flags.
 *   • Session map — the user turns (the chapters), line-numbered.
 *   • Drift sites — course-corrections, hook-caught-and-fixed, bypasses, edit loops,
 *     retries, harness error feedback — each with a transcript line + local tool-use context.
 *   • Signpost gaps — touched files matching no sign in signposts.yaml.
 *
 * Coach navigates these: `--around <line>` prints a clean tool-use view of any spot;
 * the cited `file:line` in the diff grounds code/doc/signpost proposals.
 *
 * Lives with the skill that owns it. Run from the repo root (cwd-relative: reads
 * ./lefthook.yml, discovers the transcript from the cwd's project dir).
 *
 * Usage:
 *   node .claude/skills/signposts/session-report.mjs [--base <gitref>] [--transcript <path>] [--json]
 *   node .claude/skills/signposts/session-report.mjs --around <line> [--radius <n>]
 *   node .claude/skills/signposts/session-report.mjs --test
 *
 * Couples to Claude Code's transcript shape (assistant.message.content[].tool_use,
 * user.message.content[].tool_result, user string/text = a typed prompt). If that
 * format changes, fix parseEvents().
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

const ANSI = /\x1b\[[0-9;]*m/g;
const strip = (s) => String(s ?? '').replace(ANSI, '');
const snip = (s, n = 140) => strip(s).replace(/\s+/g, ' ').trim().slice(0, n);

const RECIPE_TOOLS = [
  'vitest', 'drizzle-kit', 'ast-grep', 'depcruise', 'dependency-cruiser',
  'astro', 'dotenvx', 'pagefind', 'lefthook', 'tree-sitter',
];

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
// High-signal pushback markers — where the human corrected the agent.
const CORRECTION = /\b(actually|wait[, ]|hold on|nope|that'?s (wrong|not right|not what|not)|do(n'?t| not) |stop |revert|undo|instead|you (broke|shouldn'?t|missed|forgot|didn'?t)|why (did|are) you|rather than|let'?s not|no[, ]|hmm)\b/i;
// Harness complaints in tool output (a check/hook blocked something) — the "where".
const HARNESS_ERR = /lefthook|ast-grep|🥊|plaintext secret|MissingImage|dependency violation|✗ |rule\b|revoke|not encrypted/i;

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
      // A real typed message is a plain string with no isMeta flag. Injected
      // user-role events (skill bodies, command expansions) are text-block arrays
      // and/or isMeta:true — never treat those as the human talking.
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
          out.push({ line, kind: 'use', id: c.id, name: c.name, input: c.input || {}, rel: rel(c.input && c.input.file_path) });
        }
      }
    }
  }
  return out;
}

// ── glob matching (lefthook agent-edit globs) ─────────────────────────────
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
function lefthookAgentEditJobs(yml) {
  const jobs = [];
  let inBlock = false, curName = null;
  for (const raw of yml.split('\n')) {
    const line = raw.replace(/\t/g, '  ');
    if (/^agent-edit:/.test(line)) { inBlock = true; continue; }
    if (inBlock && /^[A-Za-z0-9_-]+:/.test(line)) break;
    if (!inBlock) continue;
    const nm = line.match(/^\s*-\s*name:\s*(\S+)/);
    if (nm) { curName = nm[1]; continue; }
    const gl = line.match(/^\s*glob:\s*["']?([^"'\n]+)["']?/);
    if (gl && curName) jobs.push({ name: curName, glob: gl[1].trim() });
  }
  return jobs;
}

// ── lefthook output parse (from a `git commit` result) ────────────────────
function parseLefthookOutput(text) {
  const t = strip(text);
  if (!/lefthook/i.test(t) && !/^summary:/m.test(t)) return null;
  const hookName = (t.match(/hook:\s*([a-z-]+)/) || [])[1] || null;
  const jobs = [];
  for (const m of t.matchAll(/(✔️|🥊)\s+([\w-]+)/g)) {
    const name = m[2];
    // Skip lefthook's own banner tokens — "🥊 lefthook  v2.1.8  hook: …" — they
    // aren't jobs; a bare version after the glove must not count as a failed job.
    if (name === 'lefthook' || /^v?\d/.test(name)) continue;
    jobs.push({ name, status: m[1] === '✔️' ? 'pass' : 'fail' });
  }
  const failed = /exit status [1-9]/.test(t) || jobs.some((j) => j.status === 'fail');
  return { hookName, jobs, failed };
}

// ── bash classification ───────────────────────────────────────────────────
function classifyBash(cmd) {
  const c = strip(cmd);
  if (/<<-?\s*['"]?\w/.test(c)) return { justCalls: [], bypasses: [], isCommit: false }; // heredoc = authoring
  const justCalls = [];
  for (const m of c.matchAll(/(?:^|\n|;|\||&&|\()\s*just\s+([a-z][\w-]*)/g)) justCalls.push(m[1]);
  const bypasses = [];
  for (const t of RECIPE_TOOLS) {
    const direct = new RegExp(`(?:^|\\n|;|\\||&&|\\(|node_modules/\\.bin/|npx\\s+)\\s*(?:\\./)?${t}\\b`);
    const viaJust = new RegExp(`just\\s+\\S*\\b${t}\\b`);
    if (direct.test(c) && !viaJust.test(c)) bypasses.push(t);
  }
  return { justCalls, bypasses, isCommit: /\bgit\s+commit\b/.test(c) };
}

// ── git diff facts ────────────────────────────────────────────────────────
function detectBase(explicit) {
  if (explicit) return explicit;
  for (const b of ['dev', 'origin/dev', 'master', 'origin/master', 'main']) {
    try {
      execSync(`git rev-parse --verify ${b}`, { stdio: 'ignore' });
      return execSync(`git merge-base HEAD ${b}`, { encoding: 'utf8' }).trim();
    } catch { /* next */ }
  }
  return null;
}
function gitFacts(base) {
  let files = [];
  try {
    const range = base ? `${base}...HEAD` : 'HEAD~5...HEAD';
    files = execSync(`git diff --name-only ${range}`, { encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch { /* not a repo / bad range */ }
  const has = (re) => files.some((f) => re.test(f));
  return {
    files,
    migrations: has(/src\/db\/migrations\//),
    schema: has(/src\/db\/schema\.ts$/),
    env: has(/(^|\/)\.env/) || has(/wrangler\.|\.dev\.vars/),
    seedOrData: has(/tools\/(neon|db)\//) || has(/seed/i),
  };
}

// Globs lifted from signposts.yaml — used to score touched-file coverage.
function readSignpostGlobs(cwd) {
  try {
    const y = fs.readFileSync(path.join(cwd, 'signposts.yaml'), 'utf8');
    const globs = [];
    for (const m of y.matchAll(/globs:\s*\[([^\]]*)\]/g))
      for (const g of m[1].split(',')) {
        const s = g.trim().replace(/^["']|["']$/g, '');
        if (s) globs.push(s);
      }
    return globs;
  } catch { return []; }
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

// ── core analysis ─────────────────────────────────────────────────────────
function analyze({ events, cwd, base, lefthookYml }) {
  const jobs = lefthookAgentEditJobs(lefthookYml);
  const agentEditFires = Object.fromEntries(jobs.map((j) => [j.name, 0]));
  let edits = 0, writes = 0, commits = 0;
  const justCalls = {}, bypasses = {};
  const preCommit = { runs: 0, passed: 0, failed: 0, failingJobs: {} };
  const reads = { justfile: 0 };
  const editedFilesByDir = {};

  // drift collections (each carries a transcript line)
  const userTurns = [], corrections = [], bypassSites = [], preCommitFailSites = [],
    errorSites = [], editLoops = [], retries = [];
  const bashByCmd = {};
  let loopFile = null, loopFrom = null, loopLast = null, loopCount = 0;
  const flushLoop = () => { if (loopCount >= 5) editLoops.push({ file: loopFile, count: loopCount, fromLine: loopFrom, toLine: loopLast }); };

  const resultById = {};
  for (const e of events) if (e.kind === 'result') resultById[e.id] = e;

  for (const e of events) {
    if (e.kind === 'usertext') {
      if (isInjected(e.text)) continue;
      userTurns.push({ line: e.line, text: snip(e.text, 120) });
      if (CORRECTION.test(e.text)) corrections.push({ line: e.line, text: snip(e.text, 140) });
      continue;
    }
    if (e.kind === 'result') {
      if (e.is_error && HARNESS_ERR.test(e.content)) errorSites.push({ line: e.line, snippet: snip(e.content, 160) });
      continue;
    }
    if (e.kind !== 'use') continue;

    if (e.name === 'Edit' || e.name === 'Write') {
      if (e.name === 'Edit') edits++; else writes++;
      const inRepo = e.rel && !e.rel.startsWith('/') && !e.rel.startsWith('..');
      // edit-loop streak (consecutive edits to the same file)
      if (inRepo && e.rel === loopFile) { loopCount++; loopLast = e.line; }
      else { flushLoop(); loopFile = inRepo ? e.rel : null; loopFrom = e.line; loopLast = e.line; loopCount = inRepo ? 1 : 0; }
      if (!inRepo) continue;
      const dir = path.dirname(e.rel);
      (editedFilesByDir[dir] ||= new Set()).add(e.rel);
      for (const j of jobs) if (matchGlob(j.glob, e.rel)) agentEditFires[j.name]++;
    } else if (e.name === 'Read') {
      if (e.rel === 'justfile' || /(^|\/)justfile$/.test(e.rel)) reads.justfile++;
    } else if (e.name === 'Bash') {
      const cmd = e.input.command || '';
      const { justCalls: jc, bypasses: bp, isCommit } = classifyBash(cmd);
      for (const r of jc) justCalls[r] = (justCalls[r] || 0) + 1;
      for (const t of bp) { bypasses[t] = (bypasses[t] || 0) + 1; bypassSites.push({ line: e.line, tool: t, cmd: snip(cmd, 120) }); }
      // Key on the FULL normalised command (not a 120-char prefix) so two long
      // `just …` / `git diff …` commands that merely share a prefix aren't merged.
      const norm = strip(cmd).replace(/\s+/g, ' ').trim();
      (bashByCmd[norm] ||= []).push(e.line);
      if (isCommit) {
        commits++;
        const res = resultById[e.id];
        const lh = res && parseLefthookOutput(res.content);
        if (lh && (lh.hookName === 'pre-commit' || lh.jobs.length)) {
          preCommit.runs++;
          if (lh.failed) {
            preCommit.failed++;
            const failed = lh.jobs.filter((j) => j.status === 'fail').map((j) => j.name);
            for (const n of failed) preCommit.failingJobs[n] = (preCommit.failingJobs[n] || 0) + 1;
            // the fix = the next Edit/Write after the failure result
            const fix = res ? events.find((x) => x.line > res.line && (x.kind === 'use') && (x.name === 'Edit' || x.name === 'Write')) : null;
            preCommitFailSites.push({ line: (res && res.line) || e.line, jobs: failed, fixLine: fix ? fix.line : null });
          } else preCommit.passed++;
        }
      }
    }
  }
  flushLoop();
  for (const [cmd, ls] of Object.entries(bashByCmd)) if (ls.length >= 3) retries.push({ cmd, count: ls.length, lines: ls });

  const git = gitFacts(base);
  // Signpost coverage, by-design: does each touched file match a glob in signposts.yaml?
  // (signposts.yaml replaced the per-dir AGENTS.md, so we score paths, not dir-presence.)
  const signGlobs = readSignpostGlobs(cwd);
  const touchedFiles = [...new Set(Object.values(editedFilesByDir).flatMap((s) => [...s]))];
  const covered = [], uncovered = [];
  for (const f of touchedFiles) (signGlobs.some((g) => matchGlob(g, f)) ? covered : uncovered).push(f);
  const signpostGaps = uncovered.sort();

  return {
    stats: { edits, writes, commits, agentEditFires, preCommit, justCalls, bypasses, reads,
      coverage: { covered: covered.sort(), uncovered: uncovered.sort() }, git },
    drift: { userTurns, corrections, bypassSites, preCommitFailSites, errorSites, editLoops, retries },
    signpostGaps,
  };
}

// ── render ────────────────────────────────────────────────────────────────
function renderMarkdown(a, events, meta) {
  const L = [];
  const tot = (o) => Object.values(o).reduce((s, n) => s + n, 0);
  const s = a.stats;
  L.push('# Harness facts + drift pointers (deterministic — for coach)');
  L.push(`Transcript: ${meta.file} (${meta.lines} lines). Lines below are events in THIS file.`);
  L.push('Investigate any spot with: `node .claude/skills/signposts/session-report.mjs --around <line>`');
  L.push('');

  L.push('## Hard stats (the verdict inputs)');
  const fires = Object.entries(s.agentEditFires).filter(([, n]) => n > 0);
  L.push(`- agent-edit fires: ${tot(s.agentEditFires)}${fires.length ? ' — ' + fires.map(([k, n]) => `${k}×${n}`).join(', ') : ''}`);
  L.push(`- pre-commit: ${s.preCommit.runs} runs (passed ${s.preCommit.passed}, failed ${s.preCommit.failed})`);
  const fj = Object.entries(s.preCommit.failingJobs);
  if (fj.length) L.push(`- pre-commit caught: ${fj.map(([k, n]) => `${k}×${n}`).join(', ')}  ← drift sites below`);
  L.push(`- justfile: ${tot(s.justCalls)} recipe calls vs ${tot(s.bypasses)} raw-tool bypasses [heuristic]`);
  L.push(`- signposts: ${s.coverage.covered.length}/${s.coverage.covered.length + s.coverage.uncovered.length} touched files match a sign · ${s.coverage.uncovered.length} with none`);
  L.push(`- diff: ${s.git.files.length} files · migrations ${s.git.migrations} · schema ${s.git.schema} · env ${s.git.env} · seed ${s.git.seedOrData} · **ops footprint: ${s.git.migrations || s.git.schema || s.git.env || s.git.seedOrData}**`);
  L.push('');

  const cap = (arr, n, label) => arr.length > n ? `${label} (showing ${n} of ${arr.length})` : `${label} — ${arr.length}`;
  const ctx = (line) => contextAround(events, line, 2).map((c) => `      ${c}`).join('\n');

  L.push('## Session map — the user turns (the chapters)');
  for (const t of a.drift.userTurns) L.push(`- L${t.line} · "${t.text}"`);
  L.push('');

  L.push('## DRIFT SITES — read these, then judge for yourself');
  L.push('');
  L.push(`### ${cap(a.drift.corrections, 40, 'Course-corrections (the human pushed back — richest signal)')}`);
  for (const c of a.drift.corrections.slice(0, 40)) { L.push(`- L${c.line} · "${c.text}"`); L.push(ctx(c.line)); }
  L.push('');
  L.push(`### ${cap(a.drift.preCommitFailSites, 40, 'Hook caught something (the gate working — find the before/after)')}`);
  for (const f of a.drift.preCommitFailSites.slice(0, 40)) L.push(`- L${f.line} · pre-commit FAILED: ${f.jobs.join(', ')}${f.fixLine ? ` → fix at L${f.fixLine}` : ''}`);
  L.push('');
  L.push(`### ${cap(a.drift.errorSites, 30, 'Harness error feedback (a check/hook complained — where?)')}`);
  for (const e of a.drift.errorSites.slice(0, 30)) { L.push(`- L${e.line} · ${e.snippet}`); }
  L.push('');
  L.push(`### ${cap(a.drift.bypassSites, 40, 'justfile bypasses (verbatim — name the missing recipe)')}`);
  for (const b of a.drift.bypassSites.slice(0, 40)) L.push(`- L${b.line} · [${b.tool}] \`${b.cmd}\``);
  L.push('');
  L.push(`### ${cap(a.drift.editLoops, 30, 'Edit loops (same file ≥5 in a row — where the agent flailed)')}`);
  for (const lp of a.drift.editLoops.slice(0, 30)) L.push(`- L${lp.fromLine}–${lp.toLine} · ${lp.file} ×${lp.count}`);
  L.push('');
  L.push(`### ${cap(a.drift.retries, 30, 'Bash retries (same command ≥3×)')}`);
  for (const r of a.drift.retries.slice(0, 30)) L.push(`- ×${r.count} · \`${snip(r.cmd, 100)}\` · L${r.lines.slice(0, 8).join(', L')}`);
  L.push('');

  L.push('## Signpost gaps — touched files matching no sign (a candidate area for a new sign)');
  for (const f of a.signpostGaps) L.push(`- ${f}`);
  L.push('');
  L.push('_Heuristics: bypass detection is text-based; corrections use keyword markers (triage them). For a clean tool-use view of any line, run `--around <line>`. Ground code/doc/signpost proposals in the diff at `file:line`._');
  return L.join('\n');
}

// ── self-test ─────────────────────────────────────────────────────────────
function selfTest() {
  const lefthookYml = ['agent-edit:', '  jobs:', '    - name: ast-grep', '      glob: "*.{ts,tsx,sql,astro}"',
    '    - name: env-encrypted', '      glob: ".env*"', 'pre-commit:', '  jobs:', '    - name: ast-grep', '      glob: "*.ts"'].join('\n');
  const ev = (obj) => JSON.stringify({ type: 'assistant', message: { content: [obj] } });
  const res = (id, content, is_error = false) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error }] } });
  const ut = (text) => JSON.stringify({ type: 'user', message: { content: text } });
  const cwd = '/repo';
  const failOut = '✗ plaintext secret\nsummary:\n🥊 env-encrypted (0s)\nexit status 2';
  const jsonl = [
    ut('just do the thing'),                                                                 // 1 user turn (no correction)
    ev({ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'just test' } }),       // 2
    ev({ type: 'tool_use', id: 'b2', name: 'Bash', input: { command: 'node_modules/.bin/vitest run' } }), // 3 bypass
    ev({ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: '/repo/src/foo.ts' } }),  // 4
    ev({ type: 'tool_use', id: 'e2', name: 'Edit', input: { file_path: '/repo/src/foo.ts' } }),  // 5
    ev({ type: 'tool_use', id: 'e3', name: 'Edit', input: { file_path: '/repo/src/foo.ts' } }),  // 6
    ev({ type: 'tool_use', id: 'e4', name: 'Edit', input: { file_path: '/repo/src/foo.ts' } }),  // 7
    ev({ type: 'tool_use', id: 'e5', name: 'Edit', input: { file_path: '/repo/src/foo.ts' } }),  // 8 loop ×5
    ut('actually no, that is wrong, revert it'),                                             // 9 correction
    ev({ type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'git commit -m y' } }),     // 10
    res('c1', failOut, true),                                                                // 11 pre-commit fail + harness err
    ev({ type: 'tool_use', id: 'e6', name: 'Edit', input: { file_path: '/repo/.env' } }),        // 12 fix
    ev({ type: 'tool_use', id: 'c2', name: 'Bash', input: { command: 'git commit -m ok' } }),    // 13
    res('c2', 'summary: (done)\n✔️ ast-grep (1s)\n✔️ revoke (1s)'),                               // 14 green commit
  ].join('\n');

  const events = parseEvents(jsonl, cwd);
  const a = analyze({ events, cwd, base: null, lefthookYml });
  const fail = [];
  let asserted = 0;
  const eq = (got, want, label) => { asserted++; if (JSON.stringify(got) !== JSON.stringify(want)) fail.push(`${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); };
  eq(a.stats.agentEditFires['ast-grep'], 5, 'ast-grep fires');
  eq(a.stats.agentEditFires['env-encrypted'], 1, 'env-encrypted fires');
  eq(a.stats.justCalls['test'], 1, 'just test');
  eq(a.stats.bypasses['vitest'], 1, 'vitest bypass count');
  eq(a.drift.bypassSites.length, 1, 'one bypass site');
  eq(a.drift.bypassSites[0].line, 3, 'bypass site line');
  eq(a.drift.userTurns.length, 2, 'two user turns');
  eq(a.drift.corrections.length, 1, 'one correction');
  eq(a.drift.corrections[0].line, 9, 'correction line');
  eq(a.drift.editLoops.length, 1, 'one edit loop');
  eq(a.drift.editLoops[0].count, 5, 'loop count');
  eq(a.drift.editLoops[0].fromLine, 4, 'loop from line');
  eq(a.stats.preCommit.failed, 1, 'pre-commit failed');
  eq(a.drift.preCommitFailSites.length, 1, 'one pre-commit fail site');
  eq(a.drift.preCommitFailSites[0].line, 11, 'fail site line');
  eq(a.drift.preCommitFailSites[0].fixLine, 12, 'fix line');
  eq(a.drift.errorSites.length, 1, 'one harness error site');
  eq(a.stats.preCommit.runs, 2, 'pre-commit runs (1 fail + 1 pass)');
  eq(a.stats.preCommit.passed, 1, 'pre-commit passed — the green path');
  // direct helper checks — the load-bearing branches codeops flagged untested
  eq(matchGlob('src/lib/**/domain.ts', 'src/lib/courses/domain.ts'), true, 'glob ** match');
  eq(matchGlob('src/lib/**/domain.ts', 'src/lib/courses/db.ts'), false, 'glob ** non-match');
  eq(matchGlob('src/db/migrations/*.sql', 'src/db/migrations/0001_x.sql'), true, 'glob *.sql match');
  eq(matchGlob('src/lib/**', 'src/lib/courses/domain.ts'), true, 'signpost glob ** dir match');
  eq(a.stats.coverage.uncovered.includes('src/foo.ts'), true, 'coverage: uncovered when no signposts.yaml');
  eq(isInjected('<system-reminder>x'), true, 'isInjected: system-reminder');
  eq(isInjected('Caveat: x'), true, 'isInjected: caveat');
  eq(isInjected('please fix the bug'), false, 'isInjected: a real message');
  eq(classifyBash('npx vitest run').bypasses.includes('vitest'), true, 'classifyBash: raw vitest is a bypass');
  eq(classifyBash('just test').bypasses.length, 0, 'classifyBash: via-just is not a bypass');
  eq(classifyBash('cat > f <<EOF\nvitest\nEOF').bypasses.length, 0, 'classifyBash: heredoc body not classified');
  eq(parseLefthookOutput('summary:\n🥊 v2.1.8\n✔️ ast-grep').failed, false, 'lefthook version banner is not a failed job');

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
  const jsonl = fs.readFileSync(transcript, 'utf8');
  const events = parseEvents(jsonl, cwd);

  const around = getArg('--around');
  if (around) {
    const radius = parseInt(getArg('--radius') || '8', 10);
    console.log(`# Tool-use context around L${around} (±${radius}) in ${path.basename(transcript)}`);
    console.log(contextAround(events, parseInt(around, 10), radius).join('\n'));
    return;
  }

  const lefthookPath = path.join(cwd, 'lefthook.yml');
  const lefthookYml = fs.existsSync(lefthookPath) ? fs.readFileSync(lefthookPath, 'utf8') : '';
  const base = detectBase(getArg('--base'));
  const a = analyze({ events, cwd, base, lefthookYml });
  if (argv.includes('--json')) console.log(JSON.stringify(a, null, 2));
  else console.log(renderMarkdown(a, events, { file: path.basename(transcript), lines: jsonl.split('\n').length }));
}

main();
