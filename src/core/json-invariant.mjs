// rules/core/json-invariant.mjs — a structured (JSON) file must hold an invariant.
//
// Used e.g. to keep package.json `scripts` empty (only //-prefixed comment keys), to pin a
// version to SemVer, or to keep a tsconfig strict. Each assert names a dot-`path` into the
// parsed JSON and one check on the value there:
//   keysPrefixedWith  the value is an object; EVERY key starts with this string
//   equals            the value === this (deep-equal for arrays/objects via JSON)
//   matches           the value (stringified) matches this regex
//   required          the path must exist at all (an absent optional path is skipped silently)
//
// Config:  assert: { path: "scripts", keysPrefixedWith: "//" }
//          assert:                                         # or a LIST of asserts
//            - { path: version, matches: '^\d+\.\d+\.\d+' }
//            - { path: compilerOptions.strict, equals: true, required: true }
// Contract: kind 'content' → ctx = { path, content, root, exists, readText }.

// Walk a dot-path into obj. Returns { found, value } — found:false means the path is absent.
function dig(obj, path) {
  let node = obj;
  for (const k of String(path || '').split('.').filter(Boolean)) {
    if (node == null || typeof node !== 'object' || !(k in node)) return { found: false };
    node = node[k];
  }
  return { found: true, value: node };
}

// One assert → its violation strings (usually 0 or 1).
function checkOne(obj, assert) {
  const out = [];
  const { path } = assert;
  const { found, value } = dig(obj, path);

  if (!found) {
    if (assert.required) out.push(`"${path}" is missing (required)`);
    return out;                                              // absent + optional → nothing to check
  }
  if (assert.keysPrefixedWith != null) {
    if (!value || typeof value !== 'object') return out;     // nothing to constrain
    for (const k of Object.keys(value)) {
      if (!k.startsWith(assert.keysPrefixedWith)) out.push(`"${path}.${k}" must be prefixed "${assert.keysPrefixedWith}"`);
    }
  }
  if ('equals' in assert && JSON.stringify(value) !== JSON.stringify(assert.equals)) {
    out.push(`"${path}" must equal ${JSON.stringify(assert.equals)} (is ${JSON.stringify(value)})`);
  }
  if (assert.matches != null && !new RegExp(assert.matches).test(String(value))) {
    out.push(`"${path}" (${JSON.stringify(value)}) must match /${assert.matches}/`);
  }
  return out;
}

// assert may be ONE assert object or a LIST of them.
export function jsonInvariant(jsonText, assert) {
  let obj; try { obj = JSON.parse(jsonText); } catch { return []; }
  const out = [];
  for (const a of [].concat(assert || [])) out.push(...checkOne(obj, a));
  return out;
}

export default {
  kind: 'content',
  evaluate(rule, ctx) { return jsonInvariant(ctx.content, rule.assert); },
  test() {
    // keysPrefixedWith (unchanged contract)
    const a = { path: 'scripts', keysPrefixedWith: '//' };
    const legal = jsonInvariant('{"scripts":{"//":"see justfile"}}', a).length === 0;
    const illegal = jsonInvariant('{"scripts":{"//":"x","dev":"run"}}', a).length === 1;
    // matches (SemVer)
    const semver = { path: 'version', matches: '^\\d+\\.\\d+\\.\\d+$' };
    const goodVer = jsonInvariant('{"version":"1.2.3"}', semver).length === 0;
    const badVer = jsonInvariant('{"version":"1.2"}', semver).length === 1;
    // equals + required (tsconfig strict), as a LIST
    const strict = [
      { path: 'compilerOptions.strict', equals: true, required: true },
      { path: 'compilerOptions.noUncheckedIndexedAccess', equals: true },
    ];
    const strictOk = jsonInvariant('{"compilerOptions":{"strict":true}}', strict).length === 0;             // optional absent → fine
    const strictMissing = jsonInvariant('{"compilerOptions":{}}', strict).length === 1;                      // required absent → hit
    const strictWrong = jsonInvariant('{"compilerOptions":{"strict":false,"noUncheckedIndexedAccess":false}}', strict).length === 2;
    const pass = legal && illegal && goodVer && badVer && strictOk && strictMissing && strictWrong;
    return { name: 'core/json-invariant', pass };
  },
};
