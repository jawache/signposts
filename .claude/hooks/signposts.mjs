#!/usr/bin/env node
// .claude/hooks/signposts.mjs — PostToolUse + PostCompact hook shell (thin IO).
//
// Reads the tool call off stdin, asks signposts-core for the match target, loads
// signposts.yaml, works out the session's token count from the transcript, reads/
// writes per-session state, and emits the matching notes as additionalContext.
// On PostCompact it wipes the state so everything re-briefs. The pure logic lives
// in signposts-core.mjs (unit-tested); this file is only IO.
//
// FAILS SAFE: any error logs to stderr and exits 0, so a hook bug can never break
// the tool call it's annotating.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { parse as parseYaml } from 'yaml'
import { selectPayloads, matchTarget, tokensFromTranscript, renderAvoid } from './signposts-core.mjs'

const THRESHOLD = 200_000
const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd()

try {
  const input = JSON.parse(readFileSync(0, 'utf8'))
  const stateFile = statePath(input.session_id || 'unknown', input.agent_id || 'main')

  if ((input.hook_event_name || '') === 'PostCompact') {
    writeState(stateFile, {}) // reset — everything re-briefs after a compaction
    process.exit(0)
  }

  const target = matchTarget(input, ROOT)
  if (!target) process.exit(0)

  const { signs, drift } = loadMap(join(ROOT, 'signposts.yaml'))
  if (!signs.length) process.exit(0)

  const tokensSoFar = readTranscriptTokens(input.transcript_path)
  const state = readState(stateFile) // { id: tokenMark }
  const picks = selectPayloads({ target, entries: signs, tokensSoFar, lastShown: state, threshold: drift })
  if (!picks.length) process.exit(0)

  const blocks = []
  for (const p of picks) {
    const entry = signs.find((e) => e.id === p.id)
    const base = entry?.text ?? readRepoFile(entry?.file) ?? ''
    const body = [base, renderAvoid(entry?.avoid)].filter(Boolean).join('\n\n') // note + its avoid-list
    if (!body) continue
    blocks.push(`# signpost: ${p.id} (${p.reason})\n${body}`)
    state[p.id] = tokensSoFar
  }
  if (!blocks.length) process.exit(0)
  writeState(stateFile, state)

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: blocks.join('\n\n') },
    }),
  )
} catch (e) {
  console.error(`signposts: ${e?.message || e}`)
}
process.exit(0)

// ── IO helpers ───────────────────────────────────────────────────────────────

function loadMap(p) {
  try {
    const d = parseYaml(readFileSync(p, 'utf8')) || {}
    // `advisory:` is the canonical section; `signs:` is the older name (still accepted);
    // a bare top-level list is also tolerated.
    const list = Array.isArray(d.advisory) ? d.advisory : Array.isArray(d.signs) ? d.signs : Array.isArray(d) ? d : []
    const signs = list.filter((e) => e && e.id)
    const drift = Number(d.config && d.config.drift_tokens) || THRESHOLD
    return { signs, drift }
  } catch {
    return { signs: [], drift: THRESHOLD }
  }
}
function readTranscriptTokens(path) {
  if (!path || !existsSync(path)) return 0
  try {
    return tokensFromTranscript(readFileSync(path, 'utf8'))
  } catch {
    return 0
  }
}
function readRepoFile(file) {
  if (!file) return null
  try {
    return readFileSync(isAbsolute(file) ? file : join(ROOT, file), 'utf8')
  } catch {
    return null
  }
}
function statePath(session, agent) {
  return join(homedir(), '.claude', 'sessions', `signposts-${session}-${agent}.json`)
}
function readState(f) {
  try {
    return JSON.parse(readFileSync(f, 'utf8'))
  } catch {
    return {}
  }
}
function writeState(f, st) {
  try {
    mkdirSync(dirname(f), { recursive: true })
    writeFileSync(f, JSON.stringify(st))
  } catch {
    /* fail safe */
  }
}
