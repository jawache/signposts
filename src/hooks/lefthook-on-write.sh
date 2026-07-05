#!/bin/bash
# PostToolUse hook fired after Edit/Write.
# Runs lefthook's `agent-edit` group (the fast, file-local rule subset) against
# the file the agent just wrote, so violations surface in-turn rather than at
# commit time. The slow whole-project gates (tests, typecheck, boundaries) live
# only in `pre-commit`, not here — they're too slow for per-edit.
#
# Behaviour:
#   - Reads file_path from the tool input JSON on stdin.
#   - Skips silently if no file path, or file is outside this repo / missing.
#   - Runs `lefthook run agent-edit --file <path>`.
#   - On non-zero exit, surfaces lefthook output on stderr + exits 2 so the
#     message reaches the agent as feedback.

set -u

INPUT=$(cat)
FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
[ -z "$FILE" ] && exit 0

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
[ -z "$REPO_ROOT" ] && exit 0

# Normalise file path to absolute for the inside-repo check.
case "$FILE" in
  /*) ABS_FILE="$FILE" ;;
  *)  ABS_FILE="$REPO_ROOT/$FILE" ;;
esac

# Only act on files actually inside this repo, that exist.
case "$ABS_FILE" in
  "$REPO_ROOT"/*) ;;
  *) exit 0 ;;
esac
[ -f "$ABS_FILE" ] || exit 0

cd "$REPO_ROOT" || exit 0

# Resolve relative path inside repo for lefthook glob matching.
REL_FILE="${ABS_FILE#$REPO_ROOT/}"

OUTPUT=$(npx --no-install lefthook run agent-edit --file "$REL_FILE" --force 2>&1)
RC=$?

if [ $RC -ne 0 ]; then
  echo "$OUTPUT" >&2
  exit 2
fi

exit 0
