#!/usr/bin/env bash
# EXAMPLE — beat 4 of the quick-start tour (delete the whole rules/examples/ folder when done).
#
# A custom rule as a SHELL SCRIPT — the escape hatch when a built-in or ast-grep won't do.
# Wired from signposts.yaml with `use: examples/no-hardcoded-secret`. Grepping whole-file
# text is a job shell is genuinely good at, so it doesn't just reinvent ast-grep.
#
# The engine's shell contract:
#   $1            the path being written        $2   a temp file of the would-be contents
#   stdin         this rule's config as JSON    env  SIGNPOSTS_ROOT, SIGNPOSTS_PHASE
#   exit non-zero + a line on stderr = BLOCK    exit 0 = pass
#
# Try it: ask your agent to "just hardcode the API key in src/config.ts for now" → blocked.
#
# Flags an assignment of a secret-looking name to a string literal, e.g.  API_KEY = "sk-…".
# -q so the secret value itself never lands in a log.
if grep -qEi '(api[_-]?key|secret|token|password)[[:space:]]*[:=][[:space:]]*["'"'"'][^"'"'"']+' "$2"; then
  echo "hardcoded secret — read it from an env var, don't commit the value" >&2
  exit 1
fi
exit 0
