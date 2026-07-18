#!/usr/bin/env node
// .claude/hooks/signposts-core.mjs — the pure core of the signposts hook.
//
// selectPayloads() decides WHICH notes to inject for a given match target,
// given how many tokens have elapsed and when each note was last shown. No IO:
// the hook shell (signposts.mjs) reads stdin / the transcript / the YAML and
// calls this. Mirrors rules/check-*.mjs: exported pure fns + a `--test`
// self-test, run by `just test-rules`.

const DEFAULT_THRESHOLD = 200_000

// glob → RegExp. `**/` = zero or more directories, `**` = any chars (incl. /),
// `*` = any non-slash run. Anchored. (The earlier `**` placeholder form left the
// trailing `/` in place, so `a/**/x.ts` required a directory and missed a flat
// `a/x.ts` — that silently killed the talk-mdx-writeup sign on flat talks files.)
export function globMatch(glob, path) {
  const re =
    '^' +
    glob
      .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex specials (not * or /)
      .replace(/\*\*\/|\*\*|\*/g, (m) => (m === '**/' ? '(?:.*/)?' : m === '**' ? '.*' : '[^/]*')) +
    '$'
  return new RegExp(re).test(path)
}

// Command pattern matches if it appears anywhere in the command line.
export function commandMatch(pattern, command) {
  return command.includes(pattern)
}

// The context size a `usage` record represents — input plus BOTH cache buckets.
// (Verified on a real transcript: input_tokens alone is ~nil; the context lives
// in cache_read_input_tokens, so summing without cache reads ~0 forever.)
export function contextTokens(usage = {}) {
  return (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0)
}

// Derive the match target from a tool call: a path (file tools) or a command
// (Bash). `root` relativises absolute paths so they match repo-relative globs.
export function matchTarget(input, root = '') {
  const ti = (input && input.tool_input) || {}
  const relish = (p) => {
    const s = String(p)
    return root && s.startsWith(root + '/') ? s.slice(root.length + 1) : s
  }
  switch (input && input.tool_name) {
    case 'Bash':
      return ti.command ? { kind: 'command', value: String(ti.command) } : null
    case 'Read':
    case 'Edit':
    case 'Write':
      return ti.file_path ? { kind: 'path', value: relish(ti.file_path) } : null
    case 'Glob':
    case 'Grep': {
      const p = ti.path || ti.glob || ti.pattern
      return p ? { kind: 'path', value: relish(p) } : null
    }
    default:
      return null
  }
}

// Current context size from a transcript's JSONL text: the latest assistant
// message's usage, summed via contextTokens. 0 if none / unparseable.
export function tokensFromTranscript(text) {
  const lines = String(text).split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim()) continue
    try {
      const o = JSON.parse(lines[i])
      if (o.message && o.message.usage) return contextTokens(o.message.usage)
    } catch {
      /* skip malformed line */
    }
  }
  return 0
}

// Does an entry match the target? Returns >= 0 on a match (path = matched-glob
// length, global/command = 0), -1 on no match. Only the sign of the result is
// used now — every matching sign injects, so the magnitude no longer narrows.
function matchScore(entry, target) {
  if (entry.global) return 0
  if (target.kind === 'path' && entry.globs) {
    const hits = entry.globs.filter((g) => globMatch(g, target.value))
    if (hits.length) return Math.max(...hits.map((g) => g.length))
  }
  if (target.kind === 'command' && entry.commands) {
    if (entry.commands.some((c) => commandMatch(c, target.value))) return 0
  }
  return -1
}

// Pick the notes to inject now: EVERY entry whose glob/command matches the target
// (general + specific stack — no most-specific narrowing, so a file gets its area
// note AND any finer notes layered on top), each gated so it shows on first touch
// or after `threshold` tokens of drift since last shown. Order follows the YAML.
export function selectPayloads({ target, entries, tokensSoFar, lastShown = {}, threshold = DEFAULT_THRESHOLD }) {
  const keep = entries
    .map((e) => ({ e, score: matchScore(e, target) }))
    .filter((x) => x.score >= 0) // every match injects; magnitude is no longer used to narrow

  const out = []
  for (const { e } of keep) {
    const limit = e.drift_tokens ?? threshold // a sign may override the global cadence
    const last = lastShown[e.id]
    if (last === undefined) out.push({ id: e.id, text: e.text, reason: 'first-touch' })
    else if (tokensSoFar - last >= limit) out.push({ id: e.id, text: e.text, reason: 'drift' })
  }
  return out
}


function selfTest() {
  const E = [
    { id: 'claude', global: true, text: 'CLAUDE' },
    { id: 'lib', globs: ['src/lib/**'], text: 'lib' },
    { id: 'auth', globs: ['src/lib/auth/**'], text: 'auth' },
    { id: 'tests', globs: ['**/*.test.ts'], text: 'tests' },
    { id: 'just', commands: ['drizzle-kit'], text: 'just' },
  ]
  const ids = (r) => r.map((x) => x.id).sort().join(',')
  const cases = []
  const check = (name, got, want) => cases.push([name, got === want, got, want])

  check('first-touch path → area note + global CLAUDE',
    ids(selectPayloads({ target: { kind: 'path', value: 'src/lib/courses/domain.ts' }, entries: E, tokensSoFar: 5000 })),
    'claude,lib')
  check('all matching signs stack (auth AND lib); recent CLAUDE skipped',
    ids(selectPayloads({ target: { kind: 'path', value: 'src/lib/auth/db.ts' }, entries: E, tokensSoFar: 1000, lastShown: { claude: 0 } })),
    'auth,lib')
  check('under threshold → nothing',
    ids(selectPayloads({ target: { kind: 'path', value: 'src/lib/x.ts' }, entries: E, tokensSoFar: 100000, lastShown: { lib: 0, claude: 0 } })),
    '')
  check('over threshold → re-inject (drift)',
    ids(selectPayloads({ target: { kind: 'path', value: 'src/lib/x.ts' }, entries: E, tokensSoFar: 250000, lastShown: { lib: 0, claude: 0 } })),
    'claude,lib')
  check('no match, no global → nothing',
    ids(selectPayloads({ target: { kind: 'path', value: 'src/pages/x.astro' }, entries: [E[1]], tokensSoFar: 1000 })),
    '')
  check('command match',
    ids(selectPayloads({ target: { kind: 'command', value: 'npx drizzle-kit push' }, entries: E, tokensSoFar: 1000, lastShown: { claude: 0 } })),
    'just')
  check('command no-match still gets global CLAUDE',
    ids(selectPayloads({ target: { kind: 'command', value: 'ls -la' }, entries: E, tokensSoFar: 1000 })),
    'claude')
  check('dedupe within window',
    ids(selectPayloads({ target: { kind: 'path', value: 'src/lib/x.ts' }, entries: E, tokensSoFar: 50000, lastShown: { lib: 1000, claude: 1000 } })),
    '')
  check('contextTokens sums input + both cache buckets',
    String(contextTokens({ input_tokens: 2, cache_read_input_tokens: 691674, cache_creation_input_tokens: 136 })),
    '691812')
  check('contextTokens of empty usage is 0', String(contextTokens({})), '0')
  check('matchTarget Read → path',
    JSON.stringify(matchTarget({ tool_name: 'Read', tool_input: { file_path: 'src/lib/x.ts' } })),
    JSON.stringify({ kind: 'path', value: 'src/lib/x.ts' }))
  check('matchTarget Bash → command',
    JSON.stringify(matchTarget({ tool_name: 'Bash', tool_input: { command: 'npx drizzle-kit push' } })),
    JSON.stringify({ kind: 'command', value: 'npx drizzle-kit push' }))
  check('matchTarget Glob uses path',
    JSON.stringify(matchTarget({ tool_name: 'Glob', tool_input: { path: 'e2e', pattern: '*.mjs' } })),
    JSON.stringify({ kind: 'path', value: 'e2e' }))
  check('matchTarget relativises absolute path',
    JSON.stringify(matchTarget({ tool_name: 'Read', tool_input: { file_path: '/repo/src/db/x.ts' } }, '/repo')),
    JSON.stringify({ kind: 'path', value: 'src/db/x.ts' }))
  check('matchTarget unknown tool → null', String(matchTarget({ tool_name: 'WebFetch', tool_input: {} })), 'null')
  check('matchTarget missing field → null', String(matchTarget({ tool_name: 'Read', tool_input: {} })), 'null')
  const tx = [
    JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 5, cache_read_input_tokens: 100 } } }),
    'garbage line {not json',
    JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 2, cache_read_input_tokens: 300, cache_creation_input_tokens: 50 } } }),
    JSON.stringify({ type: 'user', message: { content: 'hi' } }),
  ].join('\n')
  check('tokensFromTranscript: latest usage, skips junk', String(tokensFromTranscript(tx)), '352')
  check('tokensFromTranscript empty → 0', String(tokensFromTranscript('')), '0')
  check('per-sign drift_tokens overrides the global threshold',
    ids(selectPayloads({ target: { kind: 'path', value: 'x' }, entries: [{ id: 'q', global: true, text: 'q', drift_tokens: 50000 }], tokensSoFar: 60000, lastShown: { q: 0 }, threshold: 200000 })),
    'q')

  // globMatch: `**/` spans zero or more dirs (the flat-file fix)
  check('glob **/ matches a nested file', String(globMatch('src/content/**/*.md', 'src/content/writing/a.md')), 'true')
  check('glob **/ matches a FLAT file (zero dirs)', String(globMatch('src/content/talks/**/*.mdx', 'src/content/talks/a.mdx')), 'true')
  check('glob **/ matches a deep file', String(globMatch('src/content/**/*.md', 'src/content/a/b/c.md')), 'true')
  check('glob still anchors the extension', String(globMatch('src/content/**/*.md', 'src/content/a/c.mdx')), 'false')
  check('trailing ** matches anything under', String(globMatch('src/lib/**', 'src/lib/x/y.ts')), 'true')

  let pass = 0
  for (const [name, ok, got, want] of cases) {
    if (ok) pass++
    else console.log(`  ✗ ${name}: got "${got}" want "${want}"`)
  }
  const allOk = pass === cases.length
  console.log(`${allOk ? 'PASS' : 'FAIL'} signposts-core  (${pass}/${cases.length})`)
  process.exit(allOk ? 0 : 1)
}

// Run the self-test only when this file is the entry point — NOT when another
// module (e.g. rules/check-signposts.mjs) imports it with a --test arg of its own.
if (process.argv[1]?.endsWith('signposts-core.mjs') && process.argv[2] === '--test') selfTest()
