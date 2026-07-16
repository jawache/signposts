#!/usr/bin/env node
// src/hooks/session-start.mjs — SessionStart hook: the composed orientation ("the CLAUDE.md
// the bundles wrote"). Every bundle may carry ONE `at: session` sign — a few terse lines of
// orientation. At session start (and after resume, /clear, and a compaction) this composes
// them, in bundle order, and injects the concatenation as SessionStart additionalContext.
// Install a bundle and its orientation line appears in every session; drop it and the line
// goes too — nothing to keep in sync by hand, and it travels on cherry-pick.
//
// It also PRE-MARKS the drift-state file so the PostToolUse injector (signs.mjs), which fires
// these same signs as `global`, doesn't immediately re-inject what SessionStart just delivered.
//
// FAILS SAFE: any error → exit 0 with no output; orientation is a side-channel, never a gate.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { loadConfig, normalizeDoc, isOff } from '../schema.mjs'
import { tokensFromTranscript } from './signs-core.mjs'
import { logEvent } from '../log.mjs'

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd()

// ── pure composition (unit-tested) ─────────────────────────────────────────────
// Build the orientation block from a normalised config. `readFile(rel)` resolves a sign's
// `file:` to text (null if unreadable). Returns { text, ids } — text '' and ids [] when no
// bundle carries a session sign. Order follows the bundles/namespaces in the yaml.
export function composeOrientation(config, readFile = () => null) {
  const sections = []
  const ids = []
  for (const [ns, list] of Object.entries(config.signs || {})) {
    for (const s of list) {
      if (!s || s.at !== 'session' || !s.id) continue
      const body = (s.text != null ? String(s.text) : readFile(s.file)) || ''
      if (!body.trim()) continue
      sections.push(`## ${ns}\n${body.trim()}`)
      ids.push(s.id)
    }
  }
  if (!sections.length) return { text: '', ids: [] }
  const text = `# Orientation — the regime this project runs under (composed from its signposts bundles)\n\n${sections.join('\n\n')}`
  return { text, ids }
}

// ── IO shell (runs ONLY when this file is the entry point, never on import) ─────
const entry = process.argv[1]?.endsWith('session-start.mjs')
if (entry && process.argv[2] === '--test') selfTest()
else if (entry) main()

function main() {
  try {
    if (isOff(ROOT)) process.exit(0)                            // off switch: no orientation
    const input = JSON.parse(readFileSync(0, 'utf8'))
    const session = input.session_id || 'unknown'
    const agent = input.agent_id || 'main'

    const config = loadConfig(ROOT)
    const { text, ids } = composeOrientation(config, readRepoFile)
    if (!text) process.exit(0)

    // Pre-mark: record these session signs as "already shown at the current context size", so
    // the PostToolUse injector's first-touch path doesn't duplicate them. Merges into any
    // existing state (a real area-sign touch this session keeps its own mark). Drift still
    // re-shows them: after `drift_tokens` more tokens, tokensSoFar - mark crosses the threshold.
    const tokensSoFar = readTranscriptTokens(input.transcript_path)
    const stateFile = statePath(session, agent)
    const state = readState(stateFile)
    for (const id of ids) state[id] = tokensSoFar
    writeState(stateFile, state)
    for (const id of ids) logEvent(ROOT, session, { kind: 'sign', sign: id, reason: 'session' })

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text },
    }))
  } catch (e) {
    console.error(`signposts: ${e?.message || e}`)
  }
  process.exit(0)
}

function readRepoFile(file) {
  if (!file) return null
  try { return readFileSync(isAbsolute(file) ? file : join(ROOT, file), 'utf8') } catch { return null }
}
function readTranscriptTokens(path) {
  if (!path || !existsSync(path)) return 0
  try { return tokensFromTranscript(readFileSync(path, 'utf8')) } catch { return 0 }
}
function statePath(session, agent) {
  return join(homedir(), '.claude', 'sessions', `signposts-${session}-${agent}.json`)
}
function readState(f) {
  try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return {} }
}
function writeState(f, st) {
  try { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(st)) } catch { /* fail safe */ }
}

// ── self-test ────────────────────────────────────────────────────────────────
function selfTest() {
  const cases = []
  const check = (name, got, want) => cases.push([name, JSON.stringify(got) === JSON.stringify(want), got, want])

  // Two bundles, each with one session sign → composed in bundle order, under per-bundle headers.
  const cfg = loadConfigFrom({
    bundles: {
      core: { signs: [{ id: 'core-orient', at: 'session', text: 'docs/arch is the prior.' }] },
      security: { signs: [{ id: 'sec-orient', at: 'session', text: '.env files are encrypted; read freely.' }] },
    },
  })
  const c = composeOrientation(cfg)
  check('composes both bundles in order', c.ids, ['core-orient', 'sec-orient'])
  check('core section before security', c.text.indexOf('## core') < c.text.indexOf('## security'), true)
  check('carries each body', c.text.includes('docs/arch is the prior.') && c.text.includes('read freely.'), true)

  // A `file:` session sign loads via readFile.
  const cfgFile = loadConfigFrom({ bundles: { docs: { signs: [{ id: 'd', at: 'session', file: 'ORIENT.md' }] } } })
  const cf = composeOrientation(cfgFile, (rel) => rel === 'ORIENT.md' ? 'from a file' : null)
  check('file: session sign loads its contents', cf.text.includes('from a file') && cf.ids[0] === 'd', true)

  // A touch sign is NOT orientation; empty config → no output.
  const cfgTouch = loadConfigFrom({ bundles: { core: { signs: [{ id: 'area', globs: ['src/**'], text: 'x' }] } } })
  check('touch signs excluded', composeOrientation(cfgTouch), { text: '', ids: [] })
  check('empty config → no output', composeOrientation(loadConfigFrom({})), { text: '', ids: [] })

  let pass = 0
  for (const [name, ok, got, want] of cases) { if (ok) pass++; else console.log(`  ✗ ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }
  const allOk = pass === cases.length
  console.log(`${allOk ? 'PASS' : 'FAIL'} session-start  (${pass}/${cases.length})`)
  process.exit(allOk ? 0 : 1)
}

// Normalise a raw doc object for the test without touching disk.
function loadConfigFrom(doc) {
  return normalizeDoc(doc)
}
