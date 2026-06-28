#!/usr/bin/env node
// signposts-test.mjs — integration test for the hook SHELL (signposts.mjs).
//
// Runs the real hook as a subprocess against fixtures: a temp signposts.yaml +
// CLAUDE.md (via CLAUDE_PROJECT_DIR), a fake transcript, and an isolated HOME for
// state. Feeds payloads on stdin and asserts the additionalContext it emits —
// covering wiring, cross-call state/dedupe, PostCompact reset, and fail-safe.
// Run by `just test-rules`. (Pure logic is covered by signposts-core.mjs --test.)

import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HOOK = fileURLToPath(new URL('./signposts.mjs', import.meta.url))
const root = mkdtempSync(join(tmpdir(), 'sp-root-'))
const home = mkdtempSync(join(tmpdir(), 'sp-home-'))

const YAML = [
  'config:',
  '  drift_tokens: 1000',
  'signs:',
  '  - id: lib',
  '    globs: ["src/lib/**"]',
  '    text: "LIB NOTE"',
  '  - id: just',
  '    commands: ["drizzle-kit"]',
  '    text: "JUST NOTE"',
  '  - id: claude',
  '    global: true',
  '    file: CLAUDE.md',
  '',
].join('\n')
writeFileSync(join(root, 'signposts.yaml'), YAML)
writeFileSync(join(root, 'CLAUDE.md'), 'CLAUDE FILE NOTE')
const transcript = join(root, 't.jsonl')
writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 1, cache_read_input_tokens: 1000 } } }) + '\n')
const transcript2 = join(root, 't2.jsonl') // ~4000 more tokens → past config.drift_tokens
writeFileSync(transcript2, JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 1, cache_read_input_tokens: 5000 } } }) + '\n')

function rawRun(stdin) {
  try {
    const out = execFileSync('node', [HOOK], {
      input: stdin,
      env: { ...process.env, CLAUDE_PROJECT_DIR: root, HOME: home },
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'], // ignore child stderr (fail-safe logs are expected)
    })
    return { out, code: 0 }
  } catch (e) {
    return { out: String(e.stdout || ''), code: e.status ?? 1 }
  }
}
const run = (payload) => rawRun(JSON.stringify(payload))
const ctx = (r) => {
  try {
    return JSON.parse(r.out).hookSpecificOutput.additionalContext
  } catch {
    return ''
  }
}
const base = { hook_event_name: 'PostToolUse', transcript_path: transcript }

const cases = []
const check = (name, cond) => cases.push([name, !!cond])

// 1. first touch: area note + global file-backed note
let r = run({ ...base, session_id: 's1', tool_name: 'Read', tool_input: { file_path: 'src/lib/x.ts' } })
check('first touch injects the area note', ctx(r).includes('LIB NOTE'))
check('global file entry injects file content', ctx(r).includes('CLAUDE FILE NOTE'))
check('exit 0 on a normal call', r.code === 0)

// 2. second touch, same session + tokens → deduped
r = run({ ...base, session_id: 's1', tool_name: 'Read', tool_input: { file_path: 'src/lib/y.ts' } })
check('dedupe within window → no injection', ctx(r) === '')

// 3. command nudge (fresh session)
r = run({ ...base, session_id: 's2', tool_name: 'Bash', tool_input: { command: 'npx drizzle-kit push' } })
check('command pattern injects the nudge', ctx(r).includes('JUST NOTE'))

// 4. no-match command, global already shown → nothing
r = run({ ...base, session_id: 's2', tool_name: 'Bash', tool_input: { command: 'ls -la' } })
check('no match + global already shown → no injection', ctx(r) === '')

// 5. PostCompact resets state → the area note re-injects afterwards
r = run({ ...base, session_id: 's1', hook_event_name: 'PostCompact', tool_name: 'Read', tool_input: {} })
check('PostCompact exits 0', r.code === 0)
r = run({ ...base, session_id: 's1', tool_name: 'Read', tool_input: { file_path: 'src/lib/z.ts' } })
check('after reset, the area note re-injects', ctx(r).includes('LIB NOTE'))

// 6. fail-safe: malformed YAML → exit 0, no injection, no crash
writeFileSync(join(root, 'signposts.yaml'), ':\n  bad: [unclosed')
r = run({ ...base, session_id: 's3', tool_name: 'Read', tool_input: { file_path: 'src/lib/x.ts' } })
check('malformed YAML → exit 0', r.code === 0)
check('malformed YAML → no injection (fail safe)', ctx(r) === '')
writeFileSync(join(root, 'signposts.yaml'), YAML)

// 7. fail-safe: garbage stdin → exit 0
r = rawRun('this is not json {')
check('garbage stdin → exit 0 (fail safe)', r.code === 0)

// 8. missing transcript_path → still injects on first touch (tokens default 0)
r = run({ hook_event_name: 'PostToolUse', session_id: 's4', tool_name: 'Read', tool_input: { file_path: 'src/lib/x.ts' } })
check('missing transcript_path → still first-touch injects', ctx(r).includes('LIB NOTE'))

// 9. drift: same area, but enough tokens have passed (config.drift_tokens) → re-inject
r = run({ ...base, session_id: 's5', tool_name: 'Read', tool_input: { file_path: 'src/lib/a.ts' } })
check('drift setup: first touch injects', ctx(r).includes('LIB NOTE'))
r = run({ ...base, session_id: 's5', transcript_path: transcript2, tool_name: 'Read', tool_input: { file_path: 'src/lib/b.ts' } })
check('past config.drift_tokens → re-injects', ctx(r).includes('LIB NOTE'))

rmSync(root, { recursive: true, force: true })
rmSync(home, { recursive: true, force: true })

let pass = 0
for (const [name, ok] of cases) {
  if (ok) pass++
  else console.log(`  ✗ ${name}`)
}
const allOk = pass === cases.length
console.log(`${allOk ? 'PASS' : 'FAIL'} signposts-test  (${pass}/${cases.length})`)
process.exit(allOk ? 0 : 1)
