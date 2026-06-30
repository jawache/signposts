#!/usr/bin/env node
// rules/_engine.mjs — the category engine. ONE evaluator, TWO trigger paths.
//
//   • edit   — the PreToolUse hook reconstructs the would-be file and calls
//              evaluate({phase:'edit', …}) → a `deny` before the write lands.
//   • commit — lefthook runs this as a CLI over the staged set:
//              node rules/_engine.mjs --phase commit <files…>   (exit 2 on violation)
//   • push   — same CLI, --phase push.
//
// A rule's `when:` decides which paths it fires on, so ONE config line drives both.
// Rules come from signposts.yaml `rules:` (instances naming a primitive via `use:`)
// PLUS auto-discovered ast-grep rules/ast-grep/*.yml (category A — zero-code authoring).
//
// Fails safe everywhere: a malformed config / rule / primitive is skipped, never throws.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, isAbsolute, relative, extname } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { matchAny } from './_util.mjs';
import { primitives, selfTestAll } from './primitives.mjs';

const TS_GLOB = '**/*.{ts,tsx,mts,cts}';

// ── load + normalise rules ────────────────────────────────────────────────────
export function loadRules(root, configPath) {
  const rules = [];

  // 1. instances from signposts.yaml (list form = the engine schema)
  try {
    const doc = parseYaml(readFileSync(configPath || join(root, 'signposts.yaml'), 'utf8')) || {};
    if (Array.isArray(doc.rules)) {
      for (const r of doc.rules) if (r && r.use) rules.push(normalise(r));
    }
  } catch { /* no config / malformed → just the ast-grep rules below */ }

  // 2. auto-discovered ast-grep rules (category A)
  const dir = join(root, 'rules/ast-grep');
  let files = [];
  try { files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)); } catch { /* none */ }
  for (const f of files) {
    try {
      const r = parseYaml(readFileSync(join(dir, f), 'utf8'));
      if (!r || !r.rule) continue;
      rules.push(normalise({
        id: r.id || f,
        use: 'ast-grep-pattern',
        astgrep: r.rule,
        lang: r.language,
        on: r.files || TS_GLOB,
        when: (r.metadata && r.metadata.when) || ['edit', 'commit'],
        message: r.message,
      }));
    } catch { /* skip malformed rule */ }
  }
  return rules;
}

function normalise(r) {
  return { ...r, when: r.when || ['edit', 'commit'] };
}

async function resolvePrimitive(rule, root) {
  if (primitives[rule.use]) return primitives[rule.use];
  if (typeof rule.use === 'string' && /^[./]/.test(rule.use)) {       // escape hatch: own script
    try { return (await import(isAbsolute(rule.use) ? rule.use : join(root, rule.use))).default; } catch { return null; }
  }
  return null;
}

function rel(file, root) {
  return isAbsolute(file) ? relative(root, file) : file;
}

// ── evaluate file-oriented rules for a phase ──────────────────────────────────
// files: repo paths to check. getContent(file)->string for 'content' primitives
// (in-memory reconstruction at edit; disk read at commit).
export async function evaluate({ phase, files, root, getContent, configPath }) {
  const rules = loadRules(root, configPath).filter((r) => (r.when || []).includes(phase));
  const violations = [];

  for (const rule of rules) {
    const prim = await resolvePrimitive(rule, root);
    if (!prim || prim.kind === 'command') continue;          // command rules: see evaluateCommand

    if (prim.kind === 'project') {                            // tool-gate: run once for the phase
      try {
        const hits = await prim.evaluate(rule, { root });
        if (hits.length) violations.push({ rule, file: null, hits });
      } catch { /* fail safe */ }
      continue;
    }

    for (const abs of files) {
      const file = rel(abs, root);
      if (rule.on && !matchAny(file, [].concat(rule.on))) continue;
      const ctx = {
        file, root,
        exists: (p) => existsSync(p),
        readText: (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } },
      };
      if (prim.kind === 'content') {
        try { ctx.content = getContent(abs); } catch { continue; }
        if (ctx.content == null) continue;
      }
      try {
        const hits = await prim.evaluate(rule, ctx);
        if (hits && hits.length) violations.push({ rule, file, hits });
      } catch { /* a stumbling rule never breaks the gate */ }
    }
  }
  return violations;
}

// ── evaluate command-guard rules (F) against a Bash command string ────────────
export async function evaluateCommand({ command, phase = 'edit', root, configPath }) {
  const rules = loadRules(root, configPath).filter((r) => (r.when || []).includes(phase));
  const out = [];
  for (const rule of rules) {
    const prim = await resolvePrimitive(rule, root);
    if (!prim || prim.kind !== 'command') continue;
    try { const hits = await prim.evaluate(rule, { command, root }); if (hits.length) out.push({ rule, hits }); }
    catch { /* fail safe */ }
  }
  return out;
}

export function formatViolation(v) {
  const where = v.file ? ` · ${v.file}` : '';
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
  const getContent = (f) => { try { return readFileSync(f, 'utf8'); } catch { return null; } };
  const violations = await evaluate({ phase, files, root, getContent, configPath });
  if (violations.length === 0) process.exit(0);
  process.stderr.write('\n' + violations.map(formatViolation).join('\n\n') + '\n\n');
  process.exit(2);
}

// ── self-test (prove all eight + when-routing both paths) ─────────────────────
async function selfTest() {
  const results = await selfTestAll();                       // the eight categories
  // integration: ONE rule, when:[edit,commit], fires on BOTH paths via the same code.
  const root = '/tmp/sg-engine-test';
  const cfg = { rules: [{ id: 'no-generated', use: 'protected-path', deny: ['**/*.generated.ts'], when: ['edit', 'commit'] }] };
  // stub loadRules by passing the config inline through a temp evaluate
  const fakeFile = 'src/api.generated.ts';
  const run = async (phase) => evaluateViaConfig(cfg, { phase, files: [fakeFile], root, getContent: () => '' });
  const editV = await run('edit');
  const commitV = await run('commit');
  const cleanV = await evaluateViaConfig(cfg, { phase: 'edit', files: ['src/api.ts'], root, getContent: () => '' });
  results.push({ name: 'when-routing edit', pass: editV.length === 1 });
  results.push({ name: 'when-routing commit (same rule)', pass: commitV.length === 1 && commitV[0].rule.id === editV[0].rule.id });
  results.push({ name: 'when-routing clean passes', pass: cleanV.length === 0 });

  for (const r of results) console.log(r.pass ? 'PASS' : 'FAIL', r.name);
  const ok = results.every((r) => r.pass);
  console.log(ok ? `\nengine self-test: PASS (${results.length} checks)` : '\nengine self-test: FAIL');
  process.exit(ok ? 0 : 1);
}

// evaluate against an inline config object (used by the self-test; no file I/O)
async function evaluateViaConfig(cfg, { phase, files, root, getContent }) {
  const rules = cfg.rules.map(normalise).filter((r) => r.when.includes(phase));
  const out = [];
  for (const rule of rules) {
    const prim = primitives[rule.use];
    for (const file of files) {
      if (rule.on && !matchAny(file, [].concat(rule.on))) continue;
      const hits = await prim.evaluate(rule, { file, root, content: getContent(file), exists: () => false, readText: () => null });
      if (hits.length) out.push({ rule, file, hits });
    }
  }
  return out;
}

const entry = process.argv[1] && process.argv[1].endsWith('_engine.mjs');
if (entry) {
  if (process.argv[2] === '--test') selfTest();
  else cli(process.argv.slice(2));
}
