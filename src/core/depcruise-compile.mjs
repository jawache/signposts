// src/core/depcruise-compile.mjs — compile the signposts LAYERS-&-FENCES dialect to
// dependency-cruiser's native rule schema. PURE (no IO), so it golden-tests cleanly and the
// runner (depcruise.mjs) can materialise the result to a config file.
//
// The dialect names LAYERS (sets of path globs / npm packages / node:*) and declares FENCES
// between them; this turns each affordance into the tool's own `forbidden` / `required` rules:
//   only        → fail-closed allowlist (from a layer, to anything NOT in the allowed layers)
//   forbid      → forbidden edges between layers (+ transitive:true → reachable)
//   except      → carve-outs (type-only imports are erased at compile time → never fenced)
//   cycles-between → a feature importing a DIFFERENT feature (backreference), + plain circular/orphans
//   require     → an inverted rule: modules in a path MUST import a target
//   warn        → informational (moreUnstable = the Stable Dependencies Principle)
//
// We ORCHESTRATE, never reimplement: the graph walk stays dependency-cruiser's job. Same doctrine
// as ast-grep.

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// A path glob → an anchored module-path regex (posix module paths). Emits only SAFE constructs:
// dependency-cruiser's ReDoS guard rejects GROUPED/nested quantifiers (`(?:.*/)?`, `(?:[^/]+/)*`)
// but accepts a bare `.*`. So `**` becomes `.*` and a trailing `**` becomes a prefix (no end anchor).
// One pass with a replacer so a generated `.*` is never re-processed by the `*` rule.
export function globToRe(glob) {
  let g = String(glob);
  let anchorEnd = true;
  if (g.endsWith('/**')) { g = g.slice(0, -3) + '/'; anchorEnd = false; }     // "under this dir"
  else if (g.endsWith('**')) { g = g.slice(0, -2); anchorEnd = false; }
  const re = g
    .replace(/[.+^${}()|[\]]/g, '\\$&')                       // escape specials (NOT * or /)
    .replace(/\*\*\/?|\*/g, (m) => (m.startsWith('**') ? '.*' : '[^/]*'));
  return `^${re}${anchorEnd ? '$' : ''}`;
}

// A layer entry → a module-path regex or a marker. node:* → the builtin marker; a bare name
// (no slash/star) → an npm package under node_modules; anything else → a path glob.
export function entryToMatcher(entry) {
  if (entry === 'node:*') return { core: true };
  if (entry.startsWith('node:')) return { path: `^${escapeRe(entry)}$` };
  if (entry.includes('/') || entry.includes('*')) return { path: globToRe(entry) };
  return { path: `node_modules/${escapeRe(entry)}(/|$)` };   // bare npm package
}

// A set of layer names → a dependency-cruiser matcher fragment ({ path?: [...], dependencyTypes? }).
// `path` is an OR-list; the node builtins marker becomes dependencyTypes:['core'].
export function layersMatcher(names, layers) {
  const path = [];
  let core = false;
  for (const name of [].concat(names)) {
    for (const entry of layers[name] || []) {
      const m = entryToMatcher(entry);
      if (m.core) core = true; else path.push(m.path);
    }
  }
  const out = {};
  if (path.length) out.path = path;
  if (core) out.dependencyTypes = ['core'];
  return out;
}

// The whole dialect → { forbidden, required } native config.
export function compileDialect(rule) {
  const layers = rule.layers || {};
  const forbidden = [];
  const required = [];
  const typeOnlyAllowed = [].concat(rule.except || []).includes('type-only');
  // A `to` matcher gets the type-only carve-out: a type-only import is erased at compile time,
  // so it's never a real edge — never fenced.
  const withExcept = (to) => (typeOnlyAllowed ? { ...to, dependencyTypesNot: ['type-only'] } : to);

  // ── only: fail-closed allowlist. From a layer, importing anything NOT in the allowed layers
  //    blocks — so the list grows only by deliberate decision, at the moment of need.
  for (const [layer, allowed] of Object.entries(rule.only || {})) {
    const allow = layersMatcher(allowed, layers);
    const to = { pathNot: allow.path || [] };
    forbidden.push({
      name: `${layer}-only`,
      severity: 'error',
      comment: `${layer} may import only: ${[].concat(allowed).join(', ')} — an unlisted import blocks here (add it to a layer, or keep it out).`,
      from: layersMatcher(layer, layers),
      to: withExcept(to),
    });
  }

  // ── forbid: edges between layers, plain circular, orphans, cycles-between.
  for (const f of rule.forbid || []) {
    if (f === 'circular') {
      forbidden.push({ name: 'no-circular', severity: 'error', comment: 'no dependency cycles', from: { pathNot: 'node_modules' }, to: { circular: true } });
    } else if (f === 'orphans') {
      forbidden.push({ name: 'no-orphans', severity: 'warn', comment: 'unreferenced module', from: { orphan: true, pathNot: 'node_modules|\\.d\\.ts$' }, to: {} });
    } else if (f && f['cycles-between']) {
      // A feature importing a DIFFERENT feature (sideways). Capture the feature folder from the
      // layer's first glob and forbid an import into a sibling feature via a backreference.
      const first = (layers[f['cycles-between']] || [])[0] || '';
      const base = globToRe(first).replace(/\$$/, '').replace(/\[\^\/\]\*$/, '([^/]+)');   // last * → capture
      forbidden.push({
        name: `no-cycles-between-${f['cycles-between']}`, severity: 'error',
        comment: f.why || `${f['cycles-between']} must not import sideways`,
        from: { path: `${base}/` }, to: withExcept({ path: `${base.replace(/\(\[\^\/\]\+\)/, '[^/]+')}/`, pathNot: '$1/' }),
      });
    } else if (f && f.from && f.to) {
      const to = { ...layersMatcher(f.to, layers) };
      if (f.transitive) to.reachable = true;                  // purity is about what core can REACH
      forbidden.push({
        name: `no-${f.from}-to-${f.to}${f.transitive ? '-transitive' : ''}`,
        severity: 'error', comment: f.why || `${f.from} must not import ${f.to}`,
        from: layersMatcher(f.from, layers), to: withExcept(to),
      });
    }
  }

  // ── require: an INVERTED rule — modules in a path MUST import a target (directly or not).
  for (const r of rule.require || []) {
    required.push({
      name: `must-import-${r.import}`, severity: 'error',
      comment: r.why || `modules in ${r.in} must import ${r.import}`,
      module: { path: globToRe(r.in) },
      to: { path: globToRe(r.import) },
    });
  }

  // ── warn: informational only. sdp = the Stable Dependencies Principle.
  for (const w of [].concat(rule.warn || [])) {
    if (w === 'sdp') forbidden.push({ name: 'sdp', severity: 'warn', comment: 'depends on a more-unstable module (Stable Dependencies Principle)', from: {}, to: { moreUnstable: true } });
  }

  // options: resolve TS/JS imports to real module paths (so a fence's `to` matches a resolved
  // file, not a bare './db'), and record edges into node_modules without walking their trees.
  const options = {
    enhancedResolveOptions: { extensions: ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.json'] },
    doNotFollow: { path: 'node_modules' },
    // Post-compilation deps only: a pure `import type {...}` is erased at compile time, so it never
    // becomes an edge and is transparent to every fence for free ("type-only runs nothing"). The
    // `except: [type-only]` affordance still emits its carve-out for anyone who flips this to true.
    // (Requires a depcruise-compatible typescript — >=2 <7 — which ships as a signposts baseline dep.)
    tsPreCompilationDeps: false,
    ...(rule.options || {}),
  };
  return { forbidden, required, options };
}

// ── self-test (golden-ish: one assertion per affordance) ───────────────────────
function selfTest() {
  const cases = [];
  const ok = (name, cond) => cases.push([name, !!cond]);

  const dialect = {
    layers: {
      core: ['src/lib/**/domain.ts'],
      effects: ['src/lib/**/db.ts'],
      shell: ['src/pages/**'],
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
  const c = compileDialect(dialect);
  const byName = Object.fromEntries(c.forbidden.map((r) => [r.name, r]));

  // glob / entry compilation
  ok('glob **/ compiles to a ReDoS-safe run', globToRe('src/lib/**/domain.ts') === '^src/lib/.*domain\\.ts$');
  ok('trailing ** → prefix match, no end anchor', globToRe('src/pages/**') === '^src/pages/');
  ok('single * stays within a path segment', globToRe('src/lib/*') === '^src/lib/[^/]*$');
  ok('bare name → node_modules matcher', entryToMatcher('zod').path === 'node_modules/zod(/|$)');
  ok('node:* → core marker', entryToMatcher('node:*').core === true);

  // only → fail-closed allowlist with pathNot of allowed layers
  ok('only rule present', !!byName['core-only']);
  ok('only is fail-closed (pathNot of allowed)', Array.isArray(byName['core-only'].to.pathNot) && byName['core-only'].to.pathNot.some((p) => /domain/.test(p)) && byName['core-only'].to.pathNot.some((p) => /zod/.test(p)));
  ok('only carves out type-only', JSON.stringify(byName['core-only'].to.dependencyTypesNot) === JSON.stringify(['type-only']));

  // transitive → reachable
  ok('transitive fence → reachable:true', byName['no-core-to-effects-transitive']?.to.reachable === true);
  // node builtins → dependencyTypes core
  ok('node-fx fence → dependencyTypes core', JSON.stringify(byName['no-core-to-node-fx']?.to.dependencyTypes) === JSON.stringify(['core']));
  // circular + orphans
  ok('circular rule', byName['no-circular']?.to.circular === true);
  ok('orphans rule (warn)', byName['no-orphans']?.severity === 'warn' && byName['no-orphans'].from.orphan === true);
  // cycles-between → backreference
  ok('cycles-between uses a $1 backreference', /\$1/.test(byName['no-cycles-between-features']?.to.pathNot || ''));
  // require → inverted
  ok('require rule inverted (module + to)', c.required[0]?.module?.path && c.required[0]?.to?.path);
  // sdp → moreUnstable warn
  ok('sdp warn rule', byName['sdp']?.severity === 'warn' && byName['sdp'].to.moreUnstable === true);

  // except off → no carve-out
  const noExcept = compileDialect({ layers: dialect.layers, only: { core: ['core'] } });
  ok('no except → no type-only carve-out', !noExcept.forbidden[0].to.dependencyTypesNot);

  let pass = 0;
  for (const [name, cond] of cases) { if (cond) pass++; else console.log(`  ✗ ${name}`); }
  const allOk = pass === cases.length;
  console.log(`${allOk ? 'PASS' : 'FAIL'} depcruise-compile  (${pass}/${cases.length})`);
  process.exit(allOk ? 0 : 1);
}

if (process.argv[1]?.endsWith('depcruise-compile.mjs') && process.argv[2] === '--test') selfTest();
