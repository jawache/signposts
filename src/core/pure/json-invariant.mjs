// src/core/pure/json-invariant.mjs — PURE decision: does a parsed JSON object hold an invariant?
// No IO, no node builtins — the adapter (../json-invariant.mjs) reads the file and calls this.
//
// Each assert names a dot-`path` and one check on the value there:
//   keysPrefixedWith  the value is an object; EVERY key starts with this string
//   equals            the value === this (deep-equal via JSON)
//   matches           the value (stringified) matches this regex
//   required          the path must exist at all (an absent optional path is skipped silently)

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

// assert may be ONE assert object or a LIST of them. jsonText that won't parse → [] (fail-safe).
export function jsonInvariant(jsonText, assert) {
  let obj; try { obj = JSON.parse(jsonText); } catch { return []; }
  const out = [];
  for (const a of [].concat(assert || [])) out.push(...checkOne(obj, a));
  return out;
}
