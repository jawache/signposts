import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileDialect, globToRe, entryToMatcher } from './depcruise-compile.mjs';

const dialect = {
  layers: {
    core: ['src/lib/**/domain.ts'],
    effects: ['src/lib/**/db.ts'],
    features: ['src/lib/*'],
    'pure-libs': ['zod', 'date-fns'],
    'node-fx': ['node:*'],
  },
  only: { core: ['core', 'pure-libs'] },
  except: ['type-only'],
  forbid: [
    { from: 'core', to: 'effects', transitive: true, why: 'purity is transitive' },
    { from: 'core', to: 'node-fx', why: 'builtins are effects' },
    'circular', 'orphans',
    { 'cycles-between': 'features', why: 'features talk via shared/' },
  ],
  require: [{ in: 'src/pages/api/**', import: 'src/pages/api/_runtime', why: 'gate first' }],
  warn: ['sdp'],
};
const byName = (c) => Object.fromEntries(c.forbidden.map((r) => [r.name, r]));

test('glob compilation is ReDoS-safe', () => {
  assert.equal(globToRe('src/lib/**/domain.ts'), '^src/lib/.*domain\\.ts$');
  assert.equal(globToRe('src/pages/**'), '^src/pages/');
  assert.equal(globToRe('src/lib/*'), '^src/lib/[^/]*$');
});

test('layer entries: npm package vs node builtin', () => {
  assert.equal(entryToMatcher('zod').path, 'node_modules/zod(/|$)');
  assert.equal(entryToMatcher('node:*').core, true);
});

test('only → fail-closed allowlist carving out type-only', () => {
  const n = byName(compileDialect(dialect));
  assert.ok(n['core-only']);
  assert.ok(n['core-only'].to.pathNot.some((p) => /domain/.test(p)) && n['core-only'].to.pathNot.some((p) => /zod/.test(p)));
  assert.deepEqual(n['core-only'].to.dependencyTypesNot, ['type-only']);
});

test('transitive fence → reachable; node builtins → dependencyTypes core', () => {
  const n = byName(compileDialect(dialect));
  assert.equal(n['no-core-to-effects-transitive'].to.reachable, true);
  assert.deepEqual(n['no-core-to-node-fx'].to.dependencyTypes, ['core']);
});

test('circular, orphans (warn), cycles-between backreference, require, sdp', () => {
  const c = compileDialect(dialect);
  const n = byName(c);
  assert.equal(n['no-circular'].to.circular, true);
  assert.equal(n['no-orphans'].severity, 'warn');
  assert.match(n['no-cycles-between-features'].to.pathNot, /\$1/);
  assert.ok(c.required[0].module.path && c.required[0].to.path);
  assert.equal(n['sdp'].severity, 'warn');
});

test('no except → no type-only carve-out', () => {
  const c = compileDialect({ layers: dialect.layers, only: { core: ['core'] } });
  assert.equal(c.forbidden[0].to.dependencyTypesNot, undefined);
});
