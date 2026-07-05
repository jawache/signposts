#!/usr/bin/env node
// rules/_engine.mjs — the engine. ONE evaluator, TWO trigger paths, no registry.
//
//   • edit   — the PreToolUse hook reconstructs the would-be file and calls
//              evaluate({phase:'edit', …}) → a `deny` before the write lands.
//   • commit — lefthook runs this as a CLI over the staged set:
//              node rules/_engine.mjs --phase commit <files…>   (exit 2 on violation)
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
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { matchAny } from './util.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));           // …/src (the library)
// The built-in rule types live in the package, next to the engine (src/core). A
// consumer's project doesn't vendor them — `use: core/x` resolves HERE; a consumer's
// own `use: <ns>/y` resolves from THEIR repo's rules/<ns>/. Different owners, different
// folders. (In this repo, "their repo" is this repo — the dogfood.)
const CORE_DIR = join(HERE, 'core');
const TS_GLOB = '**/*.{ts,tsx,mts,cts}';
const CORE = ['ast-grep', 'sibling-exists', 'symbols-in-sibling', 'json-invariant',
              'text-ban', 'command-guard', 'protected-path', 'tool-gate'];

// ── load + normalise rules ────────────────────────────────────────────────────
export function loadRules(root, configPath) {
  const rules = [];

  // 1. instances from signposts.yaml `rules:` — GROUPED BY NAMESPACE (ns → [entries])
  try {
    const doc = parseYaml(readFileSync(configPath || join(root, 'signposts.yaml'), 'utf8')) || {};
    const grouped = doc.rules;
    if (grouped && typeof grouped === 'object' && !Array.isArray(grouped)) {
      for (const [ns, list] of Object.entries(grouped)) {
        if (!Array.isArray(list)) continue;
        for (const r of list) if (r && r.use) rules.push(normalise({ ...r, namespace: ns }));
      }
    } else if (Array.isArray(grouped)) {                        // tolerate a legacy flat list
      for (const r of grouped) if (r && r.use) rules.push(normalise(r));
    }
  } catch { /* no config / malformed → just the ast-grep rules below */ }

  // 2. auto-discovered ast-grep pattern files → synthetic `core/ast-grep` rules.
  // They live in any `ast-grep/` folder under rules/ — rules/ast-grep/ (namespace core) or
  // rules/<ns>/ast-grep/ (e.g. the seeded rules/examples/ast-grep/). The package ships none.
  const seen = new Set(rules.map((r) => r.id));
  for (const dir of astGrepDirs(root)) {
    let files = [];
    try { files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)); } catch { continue; /* no such dir */ }
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

// ── evaluate file-oriented rules for a phase ──────────────────────────────────
// files: repo paths to check. getContent(file)->string reconstructs the would-be
// bytes (in-memory at edit; disk read at commit) for content rules.
export async function evaluate({ phase, files, root, getContent, configPath }) {
  const rules = loadRules(root, configPath).filter((r) => (r.when || []).includes(phase));
  const violations = [];

  for (const rule of rules) {
    const s = await resolveScript(rule.use, root);
    if (!s || s.kind === 'command') continue;                  // command rules: see evaluateCommand

    if (s.kind === 'project') {                                // tool-gate: run once for the phase
      if (!s.js) continue;
      try { const hits = await s.js.evaluate(rule, { root }); if (hits.length) violations.push({ rule, path: null, hits }); }
      catch { /* fail safe */ }
      continue;
    }

    for (const abs of files) {
      const path = rel(abs, root);
      if (rule.on && !matchAny(path, [].concat(rule.on))) continue;
      if (rule.ignore && matchAny(path, [].concat(rule.ignore))) continue;   // opt paths out (e.g. *.test.ts)

      if (s.shell) {                                            // shell contract (dest + content-file argv)
        try { const hits = runShell(s.shell, rule, { path, abs, root, phase, getContent }); if (hits.length) violations.push({ rule, path, hits }); }
        catch { /* fail safe */ }
        continue;
      }

      const ctx = {                                            // JS contract
        path, root, phase,
        exists: (p) => existsSync(p),
        readText: (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } },
      };
      if (s.kind === 'content') {
        try { ctx.content = getContent(abs); } catch { continue; }
        if (ctx.content == null) continue;
      }
      try { const hits = await s.js.evaluate(rule, ctx); if (hits && hits.length) violations.push({ rule, path, hits }); }
      catch { /* a stumbling rule never breaks the gate */ }
    }
  }
  return violations;
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
export async function evaluateCommand({ command, phase = 'edit', root, configPath }) {
  const rules = loadRules(root, configPath).filter((r) => (r.when || []).includes(phase));
  const out = [];
  for (const rule of rules) {
    const s = await resolveScript(rule.use, root);
    if (!s || s.kind !== 'command' || !s.js) continue;
    try { const hits = await s.js.evaluate(rule, { command, root }); if (hits.length) out.push({ rule, hits }); }
    catch { /* fail safe */ }
  }
  return out;
}

export function formatViolation(v) {
  const where = v.path ? ` · ${v.path}` : '';
  const msg = v.rule.message ? `\n  ${v.rule.message}` : '';
  return `✗ ${v.rule.id} (${v.rule.use})${where}${msg}\n` + v.hits.map((h) => `    ${h}`).join('\n');
}

// ── CLI (lefthook commit/push path) ───────────────────────────────────────────
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
  const getContent = (f) => { try { return readFileSync(isAbsolute(f) ? f : join(root, f), 'utf8'); } catch { return null; } };
  const violations = await evaluate({ phase, files, root, getContent, configPath });
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

    // 5. ast-grep discovery reaches a namespaced rules/<ns>/ast-grep/ folder (seeded tour).
    mkdirSync(join(tmp, 'rules/examples/ast-grep'), { recursive: true });
    writeFileSync(join(tmp, 'rules/examples/ast-grep/nsrule.yml'), 'id: ns-astgrep\nlanguage: typescript\nrule:\n  pattern: var $X = $Y\n');
    const nsFound = loadRules(tmp, join(tmp, 'no-config.yaml')).some((r) => r.id === 'ns-astgrep');
    results.push({ name: 'ast-grep discovered under rules/<ns>/ast-grep', pass: nsFound });
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
