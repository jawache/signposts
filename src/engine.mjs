#!/usr/bin/env node
// src/engine.mjs — the engine. ONE evaluator, TWO trigger paths, no registry.
//
//   • edit   — the PreToolUse hook reconstructs the would-be file and calls
//              evaluate({phase:'edit', …}) → a `deny` before the write lands.
//   • commit — the .githooks/pre-commit hook runs this as a CLI over the staged set:
//              node src/engine.mjs --phase commit <files…>   (exit 2 on violation)
//   • push   — same CLI, --phase push.
//
// A rule NAMES A SCRIPT with `use:` (always a path) and carries its config inline.
// The whole entry is handed to the script VERBATIM — there is no category registry.
//   • use: core/<name>         → rules/core/<name>.mjs   (the shipped scripts)
//   • use: <namespace>/<name>  → rules/<namespace>/<name>.{mjs,sh}   (your own)
// Rules live GROUPED BY NAMESPACE under `rules:` in signposts.yaml, PLUS the
// auto-discovered ast-grep pattern files (rules/ast-grep/*.yml → core/ast-grep).
//
// `when:` decides which triggers a rule fires on; it defaults to [edit, commit], so
// ONE config line drives both paths. Fails safe everywhere: a malformed config /
// rule / script is skipped, never throws.

import { readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, isAbsolute, relative, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { matchAny } from './util.mjs';
import { inScope } from './core/pure/scope.mjs';
import { logEvent, commitSession, readEvents } from './log.mjs';
import { defaultGetContent, walkFiles } from './core/fs.mjs';
import { loadRuleEntries, isOff } from './schema.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));           // …/src (the library)
// The built-in rule types live in the package, next to the engine (src/core). A
// consumer's project doesn't vendor them — `use: core/x` resolves HERE; a consumer's
// own `use: <ns>/y` resolves from THEIR repo's rules/<ns>/. Different owners, different
// folders. (In this repo, "their repo" is this repo — the dogfood.)
const CORE_DIR = join(HERE, 'core');
const TS_GLOB = '**/*.{ts,tsx,mts,cts}';
const CORE = ['ast-grep', 'sibling-exists', 'symbols-in-sibling', 'json-invariant',
              'text-ban', 'command-guard', 'protected-path', 'tool-gate', 'ran-since-edit', 'depcruise',
              'change-together', 'signposts-lint'];

// ── load + normalise rules ────────────────────────────────────────────────────
export function loadRules(root, configPath) {
  // 1. instances from signposts.yaml `rules:` — via the shared normaliser (schema.mjs),
  //    which accepts bundle-first AND section-first and folds `at:` / `when:` into the
  //    internal phase list. Each entry arrives flat, namespaced, and `when`-defaulted.
  const rules = loadRuleEntries(root, configPath);

  // 2. auto-discovered ast-grep pattern files → synthetic `core/ast-grep` rules.
  // They live in any `ast-grep/` folder under rules/ — rules/ast-grep/ (namespace core) or
  // rules/<ns>/ast-grep/ (e.g. the seeded rules/examples/ast-grep/). The package ships none.
  const seen = new Set(rules.map((r) => r.id));
  for (const dir of astGrepDirs(root)) {
    let files = [];
    try { files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f) && !/\.test\.ya?ml$/.test(f)); } catch { continue; /* no such dir; never load a .test.yml fixture as a rule */ }
    for (const f of files) {
      try {
        const r = parseYaml(readFileSync(join(dir, f), 'utf8'));
        if (!r || !r.rule) continue;
        const id = r.id || f;
        if (seen.has(id)) continue;
        seen.add(id);
        rules.push(normalise({
          id, namespace: 'core', use: 'core/ast-grep',
          astgrep: r.rule, lang: r.language,
          on: r.files || TS_GLOB,
          ignore: r.ignores,          // A3: honour the yml's `ignores:` — was dropped, so engine and CLI scan could disagree.
          when: (r.metadata && r.metadata.when) || ['edit', 'commit'],
          message: r.message,
        }));
      } catch { /* skip malformed pattern file */ }
    }
  }
  return rules;
}

// Every `ast-grep/` folder under rules/: the root one (namespace core) plus one per
// namespace subfolder, so seeded examples under rules/examples/ast-grep/ are picked up.
function astGrepDirs(root) {
  const rulesDir = join(root, 'rules');
  const dirs = [join(rulesDir, 'ast-grep')];
  try {
    for (const e of readdirSync(rulesDir, { withFileTypes: true })) {
      if (e.isDirectory() && e.name !== 'ast-grep') dirs.push(join(rulesDir, e.name, 'ast-grep'));
    }
  } catch { /* no rules/ dir */ }
  return dirs;
}

// A3 (honesty): an ast-grep-shaped yml (a top-level `rule:`) ONLY runs when it lives in an
// `ast-grep/` folder — discovery looks nowhere else. A rule authored in the wrong place is
// therefore silently ignored. This finds those so `signposts test` / setup can WARN rather
// than let them no-op. Returns repo-relative paths. Fails safe: no rules/ dir → [].
export function findMisplacedAstGrep(root) {
  const out = [];
  const ymls = walkFiles(join(root, 'rules'), {
    skip: ['ast-grep'],                                                       // ast-grep/ folders are the legit home
    filter: (p) => /\.ya?ml$/.test(p) && !/\.test\.ya?ml$/.test(p),           // skip declarative test fixtures
  });
  for (const abs of ymls) {
    try { const doc = parseYaml(readFileSync(abs, 'utf8')); if (doc && doc.rule) out.push(relative(root, abs)); }
    catch { /* skip malformed */ }
  }
  return out;
}

function normalise(r) {
  return { ...r, when: r.when || ['edit', 'commit'] };
}

// Resolve `use:` (always a path) to a runnable: a JS script module or a shell path.
// Returns { kind, js } for JavaScript, { kind:'content', shell } for a shell script.
async function resolveScript(use, root) {
  if (!use || typeof use !== 'string') return null;
  const candidates = [];
  if (use.startsWith('core/')) {                                 // built-in → the package (src/core)
    candidates.push({ type: 'js', abs: join(CORE_DIR, `${use.slice(5)}.mjs`) });
  } else if (/\.(mjs|js)$/.test(use)) {
    candidates.push({ type: 'js', abs: isAbsolute(use) ? use : join(root, use) });
  } else if (/\.sh$/.test(use)) {
    candidates.push({ type: 'sh', abs: isAbsolute(use) ? use : join(root, use) });
  } else {                                                       // <ns>/<name> → the project's rules/
    candidates.push({ type: 'js', abs: join(root, 'rules', `${use}.mjs`) });
    candidates.push({ type: 'sh', abs: join(root, 'rules', `${use}.sh`) });
  }
  for (const c of candidates) {
    if (!existsSync(c.abs)) continue;
    if (c.type === 'js') {
      try { const mod = (await import(c.abs)).default; if (mod) return { kind: mod.kind || 'content', js: mod }; }
      catch { return null; }
    } else {
      return { kind: 'content', shell: c.abs };   // shell rules follow the content contract
    }
  }
  return null;
}

function rel(file, root) {
  return isAbsolute(file) ? relative(root, file) : file;
}

// Per-rule fire tallies for the event log. `evaluated` = times the rule actually
// ran against a file (post on/ignore filter) — the coach's is-it-alive signal;
// `matched` = times a touched file fell within the rule's SCOPE (the human-facing
// number: did the rule engage with the work); `hits` = times it produced a violation.
// A rule with evaluated===0 across all sessions is a retire candidate.
function makeTally() {
  const tally = new Map();
  return {
    tally,
    record(rule, matched, n) {
      let t = tally.get(rule.id);
      if (!t) { t = { id: rule.id, evaluated: 0, matched: 0, hits: 0 }; tally.set(rule.id, t); }
      t.evaluated += 1; if (matched) t.matched += 1; if (n > 0) t.hits += 1;
    },
  };
}

// The resolved core script's scope globs, fail-safe (a stumbling scope() never breaks the
// gate) — for the "matched" metric. null → the rule declares no scope of its own.
function scopeGlobsOf(s, rule) {
  try { return s && s.js && typeof s.js.scope === 'function' ? s.js.scope(rule) : null; }
  catch { return null; }
}

// One `check` event per MATCHED (rule, file) — the per-file trace the report renders:
// path · outcome (allow | deny | override) · the block message on a deny. `checks` items
// are {rule, path, hits}; the outcome is decided by which logger fires (a run allows/denies,
// an override clears). Volume is bounded by matched files, not every file. logEvent never throws.
function logChecks(root, session, phase, checks, denyOut) {
  for (const c of checks || []) {
    const denied = (c.hits || []).length > 0;
    const ev = { kind: 'check', phase, rule: c.rule.id, ns: c.rule.namespace || null, path: c.path, out: denied ? denyOut : 'allow' };
    if (denied && c.rule.message) ev.msg = c.rule.message;
    logEvent(root, session, ev);
  }
}

// Emit one `run` tally + per-file `check` events + one `deny` per violation, when a logCtx is
// supplied. Scan passes null (it is itself the report). The `deny` events stay for back-compat
// (old readers) alongside the richer `check` trace. logEvent never throws.
function logRun(logCtx, phase, files, tally, violations, checks = []) {
  if (!logCtx || !logCtx.root) return;
  const { root, session } = logCtx;
  logEvent(root, session, { kind: 'run', phase, files: Array.isArray(files) ? files.length : 0, rules: [...tally.values()] });
  logChecks(root, session, phase, checks, 'deny');
  for (const v of violations) {
    logEvent(root, session, { kind: 'deny', phase, rule: v.rule.id, ns: v.rule.namespace || null, path: v.path, hits: (v.hits || []).slice(0, 1) });
  }
}

// ── evaluate file-oriented rules for a phase ──────────────────────────────────
// files: repo paths to check. getContent(file)->string reconstructs the would-be
// bytes (in-memory at edit; disk read at commit) for content rules.
// logCtx {root, session}: when set, append run/deny events; scan passes null.
export async function evaluate({ phase, files, root, getContent, configPath, logCtx = null }) {
  const rules = loadRules(root, configPath).filter((r) => (r.when || []).includes(phase));
  const violations = [];
  const checks = [];                                           // matched (rule, file) → the per-file trace
  const { tally, record } = makeTally();

  for (const rule of rules) {
    const s = await resolveScript(rule.use, root);
    if (!s || s.kind === 'command') continue;                  // command rules: see evaluateCommand

    if (s.kind === 'project') {                                // tool-gate: run once for the phase
      if (!s.js) continue;
      // `files` (the staged set at commit / all-tracked at `just gate`) lets a project rule scope
      // itself — e.g. a tool-gate that only runs when its area changed (rule.changed). A project
      // rule has no per-file scope; it "matched" the phase when it fired.
      try {
        const hits = await s.js.evaluate(rule, { root, files });
        record(rule, hits.length > 0, hits.length);
        if (hits.length) { violations.push({ rule, path: null, hits }); checks.push({ rule, path: null, hits }); }
      } catch { /* fail safe */ }
      continue;
    }

    const scopeGlobs = scopeGlobsOf(s, rule);
    for (const abs of files) {
      const res = await runFileRule(s, rule, abs, root, phase, getContent);
      if (!res) continue;                                      // out of scope (on / ignore / no content)
      const matched = inScope(res.path, rule.on, scopeGlobs);  // did a touched file fall in the rule's scope
      record(rule, matched, res.hits.length);
      if (matched) checks.push({ rule, path: res.path, hits: res.hits });
      if (res.hits.length) violations.push({ rule, path: res.path, hits: res.hits });
    }
  }

  logRun(logCtx, phase, files, tally, violations, checks);
  return violations;
}

// Run one resolved per-file rule against one file. Returns { path, hits } (hits may
// be empty = evaluated-no-hit), or null when the file is out of scope (on/ignore
// filter, or content unavailable). Shared by evaluate() and scanTree() so both paths
// apply the SAME matching + fail-safe semantics.
async function runFileRule(s, rule, abs, root, phase, getContent) {
  const path = rel(abs, root);
  if (rule.on && !matchAny(path, [].concat(rule.on))) return null;
  if (rule.ignore && matchAny(path, [].concat(rule.ignore))) return null;   // opt paths out (e.g. *.test.ts)

  if (s.shell) {                                               // shell contract (dest + content-file argv)
    try { return { path, hits: runShell(s.shell, rule, { path, abs, root, phase, getContent }) }; }
    catch { return { path, hits: [] }; }                       // a stumbling rule never breaks the gate
  }

  const ctx = {                                               // JS contract
    path, root, phase,
    exists: (p) => existsSync(p),
    readText: (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } },
  };
  if (s.kind === 'content') {
    try { ctx.content = getContent(abs); } catch { return null; }
    if (ctx.content == null) return null;
  }
  try { const hits = await s.js.evaluate(rule, ctx); return { path, hits: (hits && hits.length) ? hits : [] }; }
  catch { return { path, hits: [] }; }
}

// The shell calling contract: config JSON on stdin, dest path + content-file path as
// argv. The content-file is a TEMP file at edit (the would-be bytes materialised) and
// the REAL file at commit — so the script never has to know which trigger it's on.
function runShell(shellPath, rule, { path, abs, root, phase, getContent }) {
  let tmpDir;
  try {
    let contentFile;
    if (phase === 'commit' || phase === 'push') {
      contentFile = isAbsolute(abs) ? abs : join(root, abs);   // the real file on disk
    } else {
      const content = getContent(abs);
      if (content == null) return [];
      tmpDir = mkdtempSync(join(tmpdir(), 'sg-'));
      contentFile = join(tmpDir, 'content');
      writeFileSync(contentFile, content);
    }
    const r = spawnSync('bash', [shellPath, path, contentFile], {
      cwd: root, encoding: 'utf8',
      input: JSON.stringify(rule),
      env: { ...process.env, SIGNPOSTS_ROOT: root, SIGNPOSTS_PHASE: phase },
    });
    if (r.status === 0) return [];
    const msg = (r.stderr || r.stdout || '').trim();
    return msg ? msg.split('\n') : [`shell rule exited ${r.status}`];
  } finally {
    if (tmpDir) { try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } }
  }
}

// ── evaluate command-guard rules against a Bash command string ────────────────
export async function evaluateCommand({ command, phase = 'edit', root, configPath, logCtx = null }) {
  const rules = loadRules(root, configPath).filter((r) => (r.when || []).includes(phase));
  const out = [];
  const { tally, record } = makeTally();
  for (const rule of rules) {
    const s = await resolveScript(rule.use, root);
    if (!s || s.kind !== 'command' || !s.js) continue;
    // a command guard has no file scope; it "matched" the command when it fired.
    try { const hits = await s.js.evaluate(rule, { command, root }); record(rule, hits.length > 0, hits.length); if (hits.length) out.push({ rule, hits }); }
    catch { /* fail safe */ }
  }
  const checks = out.map((v) => ({ rule: v.rule, path: null, hits: v.hits }));
  logRun(logCtx, phase, [], tally, checks, checks);
  return out;
}

// ── D: the event × response matrix ────────────────────────────────────────────
// Deletion has no tool/hook of its own — it's a side-effect of Bash. Parse the targets of
// rm / git rm / mv / git mv so a rule can guard them at PreToolUse (the same rail no-git-discard
// rides). PURE parsing. Fails safe: unparseable → [].
export function deleteTargets(command) {
  if (typeof command !== 'string') return [];
  const out = [];
  for (const seg of command.split(/&&|\|\||;|\|/)) {                       // each sub-command
    let toks = (seg.trim().match(/"[^"]*"|'[^']*'|\S+/g) || []).map((t) => t.replace(/^["']|["']$/g, ''));
    const hash = toks.findIndex((t) => t.startsWith('#'));                 // cut a trailing `# comment` — not a delete target
    if (hash >= 0) toks = toks.slice(0, hash);
    if (!toks.length) continue;
    const nonFlag = (a) => a.filter((t) => !t.startsWith('-'));
    const sources = (a) => { const n = nonFlag(a); if (n.length >= 2) out.push(...n.slice(0, -1)); };  // rename: sources, not the dest
    if (toks[0] === 'rm') out.push(...nonFlag(toks.slice(1)));
    else if (toks[0] === 'git' && toks[1] === 'rm') out.push(...nonFlag(toks.slice(2)));
    else if (toks[0] === 'mv') sources(toks.slice(1));
    else if (toks[0] === 'git' && toks[1] === 'mv') sources(toks.slice(2));   // git mv was a blind spot: a move out of the tree slipped past unguarded
  }
  return out;
}

// Evaluate per-file rules that opted into `when: [delete]` against a Bash delete's targets.
// The file still exists at PreToolUse, so a content/ast-grep rule can inspect it before it's
// gone ("this file matched X — did you move the code first?"). Returns violations.
export async function evaluateDelete({ command, phase = 'delete', root, configPath, logCtx = null }) {
  const targets = deleteTargets(command);
  if (!targets.length) return [];
  const rules = loadRules(root, configPath).filter((r) => (r.when || []).includes('delete'));
  const getContent = defaultGetContent(root);
  const out = [];
  const checks = [];
  const { tally, record } = makeTally();
  for (const rule of rules) {
    const s = await resolveScript(rule.use, root);
    if (!s || s.kind === 'command' || s.kind === 'project') continue;       // per-file rules only
    const scopeGlobs = scopeGlobsOf(s, rule);
    for (const t of targets) {
      const res = await runFileRule(s, rule, t, root, phase, getContent);
      if (!res) continue;
      const matched = inScope(res.path, rule.on, scopeGlobs);
      record(rule, matched, res.hits.length);
      if (matched) checks.push({ rule, path: res.path, hits: res.hits });
      if (res.hits.length) out.push({ rule, path: res.path, hits: res.hits });
    }
  }
  logRun(logCtx, phase, targets, tally, out, checks);
  return out;
}

// ── scan the whole tree (the THIRD trigger — reports, never blocks, never logs) ──
// Runs every per-file rule over the whole tree as if each file were being written,
// and reports the violations. Command + project rules have nothing per-file to scan,
// so their ids are returned in `skipped`. Unlike evaluate(), scan does NOT filter on
// `when:` — a rule scoped `when:[commit]` is still scanned. logCtx is intentionally
// absent: scan is itself the report, so logging it would double-count fires.
export async function scanTree({ root, configPath }) {
  const files = listTrackedFiles(root);
  const rules = loadRules(root, configPath);
  const getContent = defaultGetContent(root);
  const byRule = {};
  const skipped = [];
  let violations = 0, scannedRules = 0;

  for (const rule of rules) {
    const s = await resolveScript(rule.use, root);
    if (!s) continue;
    if (s.kind === 'command' || s.kind === 'project') { skipped.push(rule.id); continue; } // nothing per-file
    scannedRules++;
    for (const abs of files) {
      const res = await runFileRule(s, rule, abs, root, 'scan', getContent);
      if (!res || !res.hits.length) continue;
      (byRule[rule.id] ||= []).push({ path: res.path, hits: res.hits, message: rule.message, use: rule.use, ns: rule.namespace });
      violations++;
    }
  }
  return { byRule, counts: { files: files.length, rules: scannedRules, violations }, skipped };
}

// Files to scan: prefer `git ls-files` (respects .gitignore, includes staged-not-yet-
// committed files, fast); fall back to a recursive walk when git is unavailable.
function listTrackedFiles(root) {
  try {
    const out = execSync('git ls-files', { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const files = out.split('\n').map((f) => f.trim()).filter(Boolean);
    if (files.length) return files;
  } catch { /* not a git repo → walk */ }
  return walkTree(root, root, []);
}

function walkTree(root, dir, acc) {
  const SKIP = new Set(['node_modules', '.signposts', '.work', '.git']);
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const abs = join(dir, e.name);
    if (e.isDirectory()) walkTree(root, abs, acc);
    else if (e.isFile()) acc.push(relative(root, abs));
  }
  return acc;
}

export function formatViolation(v) {
  const where = v.path ? ` · ${v.path}` : '';
  const msg = v.rule.message ? `\n  ${v.rule.message}` : '';
  return `✗ ${v.rule.id} (${v.rule.use})${where}${msg}\n` + v.hits.map((h) => `    ${h}`).join('\n');
}

// ── CLI (the .githooks/pre-commit gate) ───────────────────────────────────────
async function cli(argv) {
  const args = [...argv];
  let phase = 'commit', configPath;
  const files = [];
  while (args.length) {
    const a = args.shift();
    if (a === '--phase') phase = args.shift();
    else if (a === '--config') configPath = args.shift();
    else files.push(a);
  }
  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  if (isOff(root)) process.exit(0);                            // off switch: the commit gate is silenced
  const getContent = defaultGetContent(root);
  // the gate runs outside any Claude session; a fresh session marker (left by the PreToolUse
  // hook) attributes commit/push events to that session, else they land in commit.jsonl.
  const violations = await evaluate({ phase, files, root, getContent, configPath, logCtx: { root, session: commitSession(root) } });
  if (violations.length === 0) process.exit(0);
  process.stderr.write('\n' + violations.map(formatViolation).join('\n\n') + '\n\n');
  process.exit(2);
}

// ── self-test (every core script + when-routing + the shell contract) ─────────
async function selfTest() {
  const results = [];

  // 1. every core script's own legal + illegal sample.
  for (const name of CORE) {
    try { const mod = (await import(join(HERE, 'core', `${name}.mjs`))).default; results.push(await mod.test()); }
    catch (e) { results.push({ name: `core/${name}`, pass: false, err: e?.message }); }
  }

  const root = join(HERE, '..');                               // real repo root (rules/core lives here)
  const tmp = mkdtempSync(join(tmpdir(), 'sg-selftest-'));
  try {
    // 2. when-routing: ONE grouped-config rule fires on edit AND commit via the same code.
    const cfg = join(tmp, 'when.yaml');
    writeFileSync(cfg, 'rules:\n  local:\n    - id: no-generated\n      use: core/protected-path\n      deny: ["**/*.generated.ts"]\n');
    const run = (phase, file) => evaluate({ phase, files: [file], root, getContent: () => '', configPath: cfg });
    const editV = await run('edit', 'src/api.generated.ts');
    const commitV = await run('commit', 'src/api.generated.ts');
    const cleanV = await run('edit', 'src/api.ts');
    results.push({ name: 'when-routing edit', pass: editV.length === 1 });
    results.push({ name: 'when-routing commit (same rule)', pass: commitV.length === 1 && commitV[0].rule.id === editV[0].rule.id });
    results.push({ name: 'when-routing clean passes', pass: cleanV.length === 0 });

    // 2b. `matched` ≠ `evaluated` for a deny-style rule: it runs against every file (evaluated)
    // but only MATCHES the ones inside its `deny` scope. This is the report's headline fix.
    const mroot = mkdtempSync(join(tmpdir(), 'sg-matched-'));
    try {
      const mcfg = join(mroot, 'm.yaml');
      writeFileSync(mcfg, 'rules:\n  local:\n    - id: no-generated\n      use: core/protected-path\n      deny: ["**/*.generated.ts"]\n');
      // three writes, none in scope → evaluated 3, matched 0
      await evaluate({ phase: 'edit', files: ['a.ts', 'b.ts', 'c.ts'], root: mroot, getContent: () => '', configPath: mcfg, logCtx: { root: mroot, session: 'm1' } });
      // one write in scope → matched 1 + a check event out:deny
      await evaluate({ phase: 'edit', files: ['x.generated.ts'], root: mroot, getContent: () => '', configPath: mcfg, logCtx: { root: mroot, session: 'm1' } });
      const ev = readEvents(mroot, { session: 'm1' }).events;
      const runs = ev.filter((e) => e.kind === 'run');
      const firstTally = runs[0].rules.find((r) => r.id === 'no-generated');
      const secondTally = runs[1].rules.find((r) => r.id === 'no-generated');
      results.push({ name: 'matched: unscoped writes evaluate but do not match', pass: firstTally.evaluated === 3 && firstTally.matched === 0 });
      results.push({ name: 'matched: an in-scope write matches', pass: secondTally.evaluated === 1 && secondTally.matched === 1 });
      results.push({ name: 'check event: one per matched deny with out:deny', pass: ev.some((e) => e.kind === 'check' && e.path === 'x.generated.ts' && e.out === 'deny') });
      results.push({ name: 'check event: no allow/deny for out-of-scope files', pass: !ev.some((e) => e.kind === 'check' && ['a.ts', 'b.ts', 'c.ts'].includes(e.path)) });
    } finally { try { rmSync(mroot, { recursive: true, force: true }); } catch {} }

    // 3. the SHELL contract: a self-contained shell rule blocks via the temp-file path.
    // (Self-contained so this proof holds in any scaffolded repo, not just this one.)
    const probe = join(tmp, 'probe.sh');
    writeFileSync(probe, '#!/usr/bin/env bash\ngrep -q BANNED "$2" && { echo "banned in $1" >&2; exit 1; }\nexit 0\n', { mode: 0o755 });
    const cfg2 = join(tmp, 'shell.yaml');
    writeFileSync(cfg2, `rules:\n  local:\n    - id: probe\n      use: "${probe}"\n      on: ["**/*.md"]\n`);
    const bad = await evaluate({ phase: 'edit', files: ['NOTES.md'], root, getContent: () => 'note\nBANNED line\n', configPath: cfg2 });
    const ok = await evaluate({ phase: 'edit', files: ['NOTES.md'], root, getContent: () => 'clean notes only\n', configPath: cfg2 });
    results.push({ name: 'shell-contract edit blocks (temp-file)', pass: bad.length === 1 });
    results.push({ name: 'shell-contract edit clean passes', pass: ok.length === 0 });

    // 4. `ignore:` opts paths out (a test file shouldn't be asked for a test of its own).
    const cfg3 = join(tmp, 'ignore.yaml');
    writeFileSync(cfg3, 'rules:\n  local:\n    - id: needs-test\n      use: core/sibling-exists\n' +
      '      on: ["src/**/*.ts"]\n      ignore: ["**/*.test.ts"]\n      sibling: "{dir}/{name}.test.ts"\n');
    const ignored = await evaluate({ phase: 'commit', files: ['src/a.test.ts'], root: tmp, getContent: () => '', configPath: cfg3 });
    const enforced = await evaluate({ phase: 'commit', files: ['src/a.ts'], root: tmp, getContent: () => '', configPath: cfg3 });
    results.push({ name: 'ignore skips opted-out paths', pass: ignored.length === 0 });
    results.push({ name: 'ignore leaves others enforced', pass: enforced.length === 1 });

    // 5. ast-grep discovery reaches a namespaced rules/<ns>/ast-grep/ folder (seeded tour),
    //    and A3: honours a yml's `ignores:` (previously dropped, so engine & CLI scan disagreed).
    mkdirSync(join(tmp, 'rules/examples/ast-grep'), { recursive: true });
    writeFileSync(join(tmp, 'rules/examples/ast-grep/nsrule.yml'), 'id: ns-astgrep\nlanguage: typescript\nrule:\n  pattern: var $X = $Y\n');
    writeFileSync(join(tmp, 'rules/examples/ast-grep/ignoring.yml'),
      'id: ns-ignore\nlanguage: typescript\nfiles: ["src/**"]\nignores: ["**/*.gen.ts"]\nrule:\n  pattern: var $X = $Y\n');
    const disc = loadRules(tmp, join(tmp, 'no-config.yaml'));
    results.push({ name: 'ast-grep discovered under rules/<ns>/ast-grep', pass: disc.some((r) => r.id === 'ns-astgrep') });
    const ignoreRule = disc.find((r) => r.id === 'ns-ignore');
    results.push({ name: 'ast-grep ignores: mapped to rule.ignore', pass: !!ignoreRule && Array.isArray(ignoreRule.ignore) && ignoreRule.ignore.includes('**/*.gen.ts') });

    // 5c. A3: an ast-grep-shaped yml OUTSIDE an ast-grep/ folder is flagged, not silently ignored.
    writeFileSync(join(tmp, 'rules/examples/misplaced.yml'), 'id: oops\nlanguage: typescript\nrule:\n  pattern: var $X = $Y\n');
    const misplaced = findMisplacedAstGrep(tmp);
    results.push({ name: 'misplaced ast-grep yml flagged', pass: misplaced.includes(join('rules', 'examples', 'misplaced.yml')) });
    results.push({ name: 'well-placed ast-grep yml not flagged', pass: !misplaced.some((p) => p.split(/[\\/]/).includes('ast-grep')) });

    // 6. scanTree: whole-tree scan reports EXACTLY the offender; a command rule is skipped, not run.
    const scanRoot = mkdtempSync(join(tmpdir(), 'sg-scan-'));
    writeFileSync(join(scanRoot, 'signposts.yaml'),
      'rules:\n  local:\n    - id: ban-todo\n      use: core/text-ban\n      on: ["**/*.md"]\n      ban: "TODO"\n' +
      '    - id: cmd\n      use: core/command-guard\n      ban: ["rm -rf"]\n');
    writeFileSync(join(scanRoot, 'bad.md'), 'intro\nleft a TODO here\n');
    writeFileSync(join(scanRoot, 'clean.md'), 'all good\n');
    const scan = await scanTree({ root: scanRoot, configPath: join(scanRoot, 'signposts.yaml') });
    results.push({ name: 'scanTree reports the one offender', pass: (scan.byRule['ban-todo'] || []).length === 1 && scan.byRule['ban-todo'][0].path === 'bad.md' });
    results.push({ name: 'scanTree counts one violation, one per-file rule', pass: scan.counts.violations === 1 && scan.counts.rules === 1 });
    results.push({ name: 'scanTree skips the command rule', pass: scan.skipped.includes('cmd') });
    try { rmSync(scanRoot, { recursive: true, force: true }); } catch { /* ignore */ }

    // 7. D — delete coverage. deleteTargets parses rm/git rm/mv; a when:[delete] rule blocks
    //    the rm of a denied path. Deletion is absolute — no per-command escape hatch.
    results.push({ name: 'deleteTargets parses rm', pass: JSON.stringify(deleteTargets('rm -rf secret/a.ts b.ts')) === JSON.stringify(['secret/a.ts', 'b.ts']) });
    results.push({ name: 'deleteTargets parses git rm / mv / git mv sources', pass:
      JSON.stringify(deleteTargets('git rm secret/a.ts')) === JSON.stringify(['secret/a.ts'])
      && JSON.stringify(deleteTargets('mv secret/a.ts elsewhere/a.ts')) === JSON.stringify(['secret/a.ts'])
      && JSON.stringify(deleteTargets('git mv secret/a.ts elsewhere/a.ts')) === JSON.stringify(['secret/a.ts']) });   // git mv was blind
    const delCfg = join(tmp, 'delete.yaml');
    writeFileSync(delCfg, 'rules:\n  local:\n    - id: no-del\n      use: core/protected-path\n      deny: ["secret/**"]\n      when: [delete]\n      message: protected\n');
    const delBlocked = await evaluateDelete({ command: 'rm secret/x.ts', root: tmp, configPath: delCfg });
    const delAllowed = await evaluateDelete({ command: 'rm other.ts', root: tmp, configPath: delCfg });
    const delGitMv = await evaluateDelete({ command: 'git mv secret/x.ts /tmp/gone.ts', root: tmp, configPath: delCfg });
    results.push({ name: 'evaluateDelete blocks a denied path', pass: delBlocked.length === 1 && delBlocked[0].rule.id === 'no-del' });
    results.push({ name: 'evaluateDelete allows other paths', pass: delAllowed.length === 0 });
    results.push({ name: 'evaluateDelete catches git mv out of the tree (was blind)', pass: delGitMv.length === 1 });
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  for (const r of results) console.log(r.pass ? 'PASS' : 'FAIL', r.name, r.err ? `— ${r.err}` : '');
  const okAll = results.every((r) => r.pass);
  console.log(okAll ? `\nengine self-test: PASS (${results.length} checks)` : '\nengine self-test: FAIL');
  process.exit(okAll ? 0 : 1);
}

const entry = process.argv[1] && process.argv[1].endsWith('engine.mjs');
if (entry) {
  if (process.argv[2] === '--test') selfTest();
  else cli(process.argv.slice(2));
}
