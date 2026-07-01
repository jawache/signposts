#!/usr/bin/env bash
# rules/local/no-ai-attribution.sh — a SHELL rule (proves the shell contract).
#
# This repo ships no Claude/Anthropic attribution anywhere. This blocks the marker
# lines from landing in prose (scoped to **/*.md in signposts.yaml).
#
# The shell calling contract (a shell script can't take a JS object):
#   $1    = destination path   (logical: docs/x.md — the truth for messages)
#   $2    = content-file path  (a TEMP file @edit, the real file @commit)
#   stdin = the rule config as JSON            (jq to read your params)
#   env   : SIGNPOSTS_ROOT, SIGNPOSTS_PHASE
#   non-zero exit + a message on stderr = block. Fails safe: unreadable → allow.
#
#   node/…  --test   runs a legal + an illegal sample (its proof; `just test-rules`).

set -uo pipefail

# The marker lines we never want in committed prose. A config `ban` (JSON on stdin)
# overrides it; by default nothing needs to appear in signposts.yaml (so this rule
# can never match its own config entry).
default_ban='Co-Authored-By:[[:space:]]*Claude|Generated with \[?Claude|🤖 Generated'

# scan <dest> <content-file> <ban> → exit 1 + stderr on a hit, else 0. The whole rule.
scan() {
  local dest="$1" file="$2" ban="$3"
  [ -r "$file" ] || return 0                       # nothing to read → allow (fail safe)
  local hit
  hit=$(grep -nE "$ban" "$file" 2>/dev/null | head -1) || return 0
  if [ -n "$hit" ]; then
    echo "$dest: AI attribution is not allowed in this repo (${hit%%:*}: matches marker)" >&2
    return 1
  fi
  return 0
}

# ── self-test: a legal and an illegal sample ──────────────────────────────────
if [ "${1:-}" = "--test" ]; then
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  printf 'A clean commit message.\nAll our own work.\n'          > "$tmp/legal.md"
  printf 'Fixed the bug.\n\nCo-Authored-By: Claude <x@y>\n'      > "$tmp/illegal.md"
  scan "legal.md"   "$tmp/legal.md"   "$default_ban" 2>/dev/null; legal=$?
  scan "illegal.md" "$tmp/illegal.md" "$default_ban" 2>/dev/null; illegal=$?
  if [ "$legal" -eq 0 ] && [ "$illegal" -eq 1 ]; then
    echo "PASS local/no-ai-attribution"; exit 0
  fi
  echo "FAIL local/no-ai-attribution (legal=$legal illegal=$illegal)"; exit 1
fi

# ── the engine invocation: config on stdin, dest + content-file as argv ────────
config=$(cat 2>/dev/null || true)
ban=$(printf '%s' "$config" | jq -r '.ban // empty' 2>/dev/null)
[ -n "$ban" ] || ban="$default_ban"
scan "$1" "$2" "$ban"
