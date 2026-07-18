#!/usr/bin/env node
// src/skill/rule-test.mjs — the declarative rule-test runner (A4).
//
// A rule is a claim about code; an untested rule is a guess. Every rule carries a colocated
// `rules/<ns>/<name>.test.yml` — data, not code — and this runs each case through the SAME
// engine the edit/commit gate uses (no mock), so green means the rule blocks in production.
//
//   node src/skill/rule-test.mjs [--target <dir>]     # discover + run every .test.yml
//   node src/skill/rule-test.mjs --test               # this runner's own self-test
//
// Formats (dispatched by shape):
//   • content / ast-grep / script → `path:` + `valid:`/`invalid:` code samples (+ `message:` regex)
//   • path rules                  → `cases: [{ files:{…}, check: <path>, expect: pass|block }]`
//   • command rules               → `cases: [{ command: …, expect, files?, git?, dirty?, message? }]`
// A test maps to its rule by basename (`justfile-docs.test.yml` → rule id `justfile-docs`),
// or an explicit `id:`. The rule is evaluated IN ISOLATION (a temp repo carrying only it).

import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parse as parseYaml, stringify as yamlStringify } from 'yaml';
import { evaluate, evaluateCommand, evaluateDelete, loadRules, formatViolation } from '../engine.mjs';
import { astGrepHits } from '../core/ast-grep.mjs';
import { walkFiles, defaultGetContent } from '../core/fs.mjs';

// ── discovery ─────────────────────────────────────────────────────────────────
const isTestYml = (p) => /\.test\.ya?ml$/.test(p);
const isYml = (p) => /\.ya?ml$/.test(p) && !isTestYml(p);

function discoverTests(root) { return walkFiles(join(root, 'rules')).filter(isTestYml); }
function discoverAstGrepYmls(root) {
  return walkFiles(join(root, 'rules')).filter((p) => isYml(p) && p.split(/[\\/]/).includes('ast-grep'));
}

// ── build a temp repo carrying ONLY the rule under test ───────────────────────
function buildRuleRoot(rule) {
  const tmp = mkdtempSync(join(tmpdir(), 'sg-ruletest-'));
  const entry = { ...rule };
  const ns = entry.namespace || 'test';
  delete entry.namespace;
  // own-script (use: <ns>/<name>) → point `use` at the real file by ABSOLUTE path, so it
  // loads from the repo (no copy, no relative-import surprises). `root` is on the rule's use.
  if (typeof entry.use === 'string' && !entry.use.startsWith('core/') && !/\.(mjs|js|sh)$/.test(entry.use)) {
    for (const ext of ['mjs', 'sh']) {
      const abs = join(rule.__root, 'rules', `${entry.use}.${ext}`);
      if (existsSync(abs)) { entry.use = abs; break; }
    }
  }
  delete entry.__root;
  writeFileSync(join(tmp, 'signposts.yaml'), yamlStringify({ rules: { [ns]: [entry] } }));
  return { tmp, cfg: join(tmp, 'signposts.yaml') };
}
function writeInto(root, rel, content) {
  const p = join(root, rel); mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, typeof content === 'string' && content.endsWith('\n') ? content : `${content}\n`);
}
function stripRe(s) { const m = /^\/(.*)\/([a-z]*)$/.exec(String(s)); return m ? new RegExp(m[1], m[2]) : new RegExp(String(s)); }

// Judge a set of violations against the expected RESPONSE. A rule either blocks or it passes —
// there is no warn tier — so any violation is a block.
//   expect ∈ 'block' | 'pass'   (+ optional message match on a block).
function judge(violations, expect, message) {
  const got = violations.length ? 'block' : 'pass';
  if (got !== expect) {
    if (expect === 'pass') return `expected PASS, got ${got}: ${violations.map((v) => (v.hits || []).join('; ')).join(' | ')}`;
    return `expected ${expect.toUpperCase()}, got ${got.toUpperCase()}`;
  }
  if (expect === 'block' && message) {
    const text = violations.map(formatViolation).join('\n');
    if (!stripRe(message).test(text)) return `matched ${expect}, but message did not match ${message}`;
  }
  return null;   // ok
}

// ── the three case kinds ──────────────────────────────────────────────────────
async function evalContent(rule, path, code, expect, message) {
  const { tmp, cfg } = buildRuleRoot(rule);
  try {
    writeInto(tmp, path, code);
    const violations = await evaluate({ phase: 'commit', files: [path], root: tmp, getContent: defaultGetContent(tmp), configPath: cfg });
    return judge(violations, expect, message);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}
async function evalPath(rule, c) {
  const { tmp, cfg } = buildRuleRoot(rule);
  try {
    for (const [p, content] of Object.entries(c.files || {})) writeInto(tmp, p, content);
    const violations = await evaluate({ phase: 'commit', files: [c.check], root: tmp, getContent: defaultGetContent(tmp), configPath: cfg });
    return judge(violations, c.expect, c.message);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}
async function evalCommand(rule, c) {
  const { tmp, cfg } = buildRuleRoot(rule);
  try {
    for (const [p, content] of Object.entries(c.files || {})) writeInto(tmp, p, content);
    if (c.git) {
      const git = (...a) => spawnSync('git', ['-C', tmp, ...a], { stdio: 'pipe' });
      git('init', '-q'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'checkout', '-qb', 'main');
      git('add', '.'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base');
    }
    for (const [p, content] of Object.entries(c.dirty || {})) writeInto(tmp, p, content);
    const violations = await evaluateCommand({ command: c.command, phase: 'commit', root: tmp, configPath: cfg });
    return judge(violations, c.expect, c.message);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}
async function evalDelete(rule, c) {
  const { tmp, cfg } = buildRuleRoot(rule);
  try {
    for (const [p, content] of Object.entries(c.files || {})) writeInto(tmp, p, content);
    const violations = await evaluateDelete({ command: c.delete, phase: 'delete', root: tmp, configPath: cfg });
    return judge(violations, c.expect, c.message);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

// ── run one .test.yml against its rule ────────────────────────────────────────
async function runOne(root, rules, testPath) {
  const rel = testPath.slice(root.length + 1);
  let spec; try { spec = parseYaml(readFileSync(testPath, 'utf8')); } catch (e) { return [{ name: rel, ok: false, err: `unparseable: ${e.message}` }]; }
  if (!spec || typeof spec !== 'object') return [{ name: rel, ok: false, err: 'empty test' }];

  const id = spec.id || basename(testPath).replace(/\.test\.ya?ml$/, '');
  const rule = rules.find((r) => r.id === id);
  if (!rule) return [{ name: rel, ok: false, err: `no rule with id '${id}' (name the test after its rule, or set id:)` }];
  rule.__root = root;   // so an own-script `use:` resolves to the real file

  const out = [];
  if (Array.isArray(spec.invalid) || Array.isArray(spec.valid)) {
    const path = spec.path || 'probe.ts';
    for (const [kind, list, expect] of [['invalid', spec.invalid, 'block'], ['valid', spec.valid, 'pass']]) {
      for (let i = 0; i < (Array.isArray(list) ? list.length : 0); i++) {
        const err = await evalContent(rule, path, String(list[i]), expect, kind === 'invalid' ? spec.message : null);
        out.push({ name: `${rel} › ${kind}[${i}]`, ok: !err, err });
      }
    }
  }
  if (Array.isArray(spec.cases)) {
    for (let i = 0; i < spec.cases.length; i++) {
      const c = spec.cases[i];
      const err = c.command !== undefined ? await evalCommand(rule, c)
        : c.delete !== undefined ? await evalDelete(rule, c)
          : await evalPath(rule, c);
      out.push({ name: `${rel} › case[${i}]`, ok: !err, err });
    }
  }
  if (!out.length) out.push({ name: rel, ok: false, err: 'no valid/invalid samples and no cases' });
  return out;
}

// ── every ast-grep yml must actually compile (surfaces the unknown-language error) ──
async function validateAstGrep(root) {
  const out = [];
  for (const p of discoverAstGrepYmls(root)) {
    const rel = p.slice(root.length + 1);
    let doc; try { doc = parseYaml(readFileSync(p, 'utf8')); } catch (e) { out.push({ name: `ast-grep parses: ${rel}`, ok: false, err: e.message }); continue; }
    if (!doc || !doc.rule) continue;   // not an ast-grep rule file
    try { await astGrepHits('', doc.rule, doc.language, root); out.push({ name: `ast-grep parses: ${rel}`, ok: true }); }
    catch (e) { out.push({ name: `ast-grep parses: ${rel}`, ok: false, err: e.message }); }
  }
  return out;
}

export async function runRuleTests(root) {
  const rules = loadRules(root);
  const results = [];
  results.push(...await validateAstGrep(root));
  for (const t of discoverTests(root)) results.push(...await runOne(root, rules, t));
  return results;
}

// ── self-test: the runner must CATCH a wrong claim (not be a no-op) ───────────
async function selfTest() {
  const rule = { id: 'probe', namespace: 'test', use: 'core/protected-path', deny: ['**/bad.txt'], when: ['edit', 'commit'], message: 'no bad.txt', __root: process.cwd() };
  const checks = [
    ['invalid that truly blocks → ok', (await evalContent(rule, 'bad.txt', 'x', 'block')) === null],
    ['valid that truly passes → ok', (await evalContent(rule, 'fine.txt', 'x', 'pass')) === null],
    ['a WRONG valid claim is caught', (await evalContent(rule, 'bad.txt', 'x', 'pass')) !== null],
    ['a WRONG invalid claim is caught', (await evalContent(rule, 'fine.txt', 'x', 'block')) !== null],
    ['message mismatch is caught', (await evalContent(rule, 'bad.txt', 'x', 'block', '/totally different/')) !== null],
  ];
  const fail = checks.filter(([, ok]) => !ok).map(([n]) => n);
  if (fail.length) { console.error('FAIL rule-test:\n  ' + fail.join('\n  ')); process.exit(1); }
  console.log(`PASS rule-test (${checks.length} checks)`);
}

// ── CLI ───────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  if (argv.includes('--test')) { await selfTest(); process.exit(0); }
  const ti = argv.indexOf('--target');
  const root = resolve(ti >= 0 ? argv[ti + 1] : process.cwd());
  const results = await runRuleTests(root);
  for (const r of results) console.log(r.ok ? 'PASS' : 'FAIL', r.name, r.err ? `— ${r.err}` : '');
  const ok = results.every((r) => r.ok);
  console.log(ok ? `\nsignposts test: PASS (${results.length} checks)` : `\nsignposts test: FAIL (${results.filter((r) => !r.ok).length}/${results.length})`);
  process.exit(ok ? 0 : 1);
}
