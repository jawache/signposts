// rules/_util.mjs — tiny shared helpers for the category engine. No deps.
//
//   globToRegExp / matchGlob  — match a rule's `on:` / `deny:` globs against a path.
//   expandTemplate            — fill {dir} {name} {base} {path} in a sibling template.
//   escapeRe                  — regex-escape a literal.

export function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Minimal glob → RegExp: supports ** (across /), * (within a segment), ?, {a,b}.
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      re += '(' + glob.slice(i + 1, end).split(',').map(escapeRe).join('|') + ')';
      i = end;
    } else re += escapeRe(c);
  }
  return new RegExp('^' + re + '$');
}

export function matchGlob(path, glob) {
  return globToRegExp(glob).test(path);
}

export function matchAny(path, globs) {
  return (globs || []).some((g) => matchGlob(path, g));
}

// file "a/b/x.ts" → {dir:"a/b", base:"x.ts", name:"x", path:"a/b/x"}
export function fileParts(file) {
  const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '.';
  const base = file.slice(file.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  const name = dot > 0 ? base.slice(0, dot) : base;
  const path = dir === '.' ? name : `${dir}/${name}`;
  return { dir, base, name, path };
}

export function expandTemplate(tpl, file) {
  const p = fileParts(file);
  return tpl.replace(/\{(dir|base|name|path)\}/g, (_, k) => p[k]);
}
