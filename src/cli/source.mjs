// cli/source.mjs — resolve a pack SOURCE to a local directory.
//
// A pack is just a repo with a signposts.yaml — no separate format. Three sources (only
// git/npm need a fetch; a local path is read straight from disk):
//   • local (private / quick) — a path on disk: ./hub, ../sibling, /abs/path
//   • git (default) — github:owner/repo[#ref], ssh/https .git URLs, file:// (+ #ref)
//   • npm (at scale) — @scope/name[@semver], or npm:@scope/name
// Plus a .tgz tarball (what the tests + `npm pack` produce).
//
// parseSource() is pure (unit-tested); resolveSource() does the fetch (clone / npm pack
// + extract) into a cache dir and hands back the local path the rest of the CLI reads.

import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveConfigPath } from '../schema.mjs';

// ── parse a source spec into { kind, … } (pure) ───────────────────────────────
export function parseSource(spec) {
  if (!spec || typeof spec !== 'string') throw new Error('empty source');
  const s = spec.trim();

  // npm: @scope/name[@version], or explicit npm:
  if (s.startsWith('npm:')) return npmSpec(s.slice(4));
  if (s.startsWith('@')) return npmSpec(s);

  // tarball (what `npm pack` emits; a local pack artifact)
  if (/\.(tgz|tar\.gz)$/.test(s)) return { kind: 'tarball', path: s, spec };

  // git: github: shorthand
  let m;
  if ((m = s.match(/^github:([^/]+)\/([^#]+?)(?:#(.+))?$/))) {
    return { kind: 'git', url: `https://github.com/${m[1]}/${m[2].replace(/\.git$/, '')}.git`, ref: m[3] || null, spec };
  }
  // git: any explicit git/ssh/https/file URL (optionally with #ref)
  if (/^(git\+|ssh:\/\/|git@|https?:\/\/|file:\/\/)/.test(s) || /\.git(#.+)?$/.test(s)) {
    const [url, ref] = splitRef(s.replace(/^git\+/, ''));
    return { kind: 'git', url, ref: ref || null, spec };
  }

  // otherwise: a local filesystem path
  return { kind: 'local', path: s, spec };
}

function npmSpec(s) {
  const at = s.lastIndexOf('@');
  const scoped = s.startsWith('@');
  const version = scoped && at > 0 ? s.slice(at + 1) : (!scoped && at > 0 ? s.slice(at + 1) : null);
  const pkg = version ? s.slice(0, s.length - version.length - 1) : s;
  return { kind: 'npm', pkg, version: version || null, spec: `npm:${s}` };
}
function splitRef(s) { const i = s.indexOf('#'); return i >= 0 ? [s.slice(0, i), s.slice(i + 1)] : [s, null]; }

// ── resolve to a local directory (does the fetch) ─────────────────────────────
export function resolveSource(spec, { cacheDir } = {}) {
  const src = parseSource(spec);
  const cache = cacheDir || mkdtempSync(join(tmpdir(), 'sg-src-'));

  if (src.kind === 'local') {
    const p = isAbsolute(src.path) ? src.path : resolve(process.cwd(), src.path);
    if (!existsSync(resolveConfigPath(p))) throw new Error(`no signposts.yml / signposts.yaml at ${p}`);
    return { ...src, path: p };
  }
  if (src.kind === 'tarball') return { ...src, path: extractTarball(resolve(src.path), cache) };
  if (src.kind === 'git') {
    const args = ['clone', '--depth', '1'];
    if (src.ref) args.push('--branch', src.ref);
    args.push(src.url, cache);
    run('git', args, `git clone ${src.url}`);
    return { ...src, path: cache };
  }
  if (src.kind === 'npm') {
    // `npm pack` fetches the tarball (works for a registry pkg or a local dir); extract it.
    const ref = src.version ? `${src.pkg}@${src.version}` : src.pkg;
    const out = run('npm', ['pack', ref, '--pack-destination', cache, '--silent'], `npm pack ${ref}`);
    const tgz = out.trim().split('\n').pop().trim();
    return { ...src, path: extractTarball(join(cache, tgz), cache) };
  }
  throw new Error(`unknown source kind: ${src.kind}`);
}

function extractTarball(tgz, cache) {
  const dest = join(cache, 'package');
  run('tar', ['-xzf', tgz, '-C', cache], `extract ${tgz}`);
  // npm tarballs unpack into ./package; a plain tarball may not — fall back to cache.
  return existsSync(resolveConfigPath(dest)) ? dest : cache;
}

function run(cmd, args, what) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${what} failed (exit ${r.status}): ${(r.stderr || r.stdout || '').trim().split('\n').slice(-2).join(' ')}`);
  return r.stdout || '';
}

// ── self-test (parse only — no network) ───────────────────────────────────────
export function selfTest() {
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const cases = [
    ['github:you/neon', { kind: 'git', url: 'https://github.com/you/neon.git', ref: null }],
    ['github:you/neon#v1', { kind: 'git', url: 'https://github.com/you/neon.git', ref: 'v1' }],
    ['@signposts/neon', { kind: 'npm', pkg: '@signposts/neon', version: null }],
    ['@acme/guardrails@2.1.0', { kind: 'npm', pkg: '@acme/guardrails', version: '2.1.0' }],
    ['npm:@signposts/core', { kind: 'npm', pkg: '@signposts/core', version: null }],
    ['git@github.com:you/neon.git#main', { kind: 'git', url: 'git@github.com:you/neon.git', ref: 'main' }],
    ['./local/hub', { kind: 'local', path: './local/hub' }],
    ['/tmp/pack.tgz', { kind: 'tarball', path: '/tmp/pack.tgz' }],
  ];
  const fails = [];
  for (const [spec, want] of cases) {
    const got = parseSource(spec);
    for (const k of Object.keys(want)) if (!eq(got[k], want[k])) fails.push(`${spec}: ${k} = ${JSON.stringify(got[k])} ≠ ${JSON.stringify(want[k])}`);
  }
  if (fails.length) { console.error('FAIL source:\n  ' + fails.join('\n  ')); process.exit(1); }
  console.log(`PASS source (${cases.length} specs)`);
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--test') selfTest();
  else if (process.argv[2]) { const r = resolveSource(process.argv[2]); console.log(`${r.kind} → ${r.path}`); }
  else { console.error('usage: node cli/source.mjs <source-spec> | --test'); process.exit(1); }
}
