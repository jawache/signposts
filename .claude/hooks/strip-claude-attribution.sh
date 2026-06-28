#!/bin/bash
# strip-claude-attribution.sh
# PreToolUse hook on Bash.
# Blocks `git commit`, `gh pr`, and `gh issue` commands whose body contains
# Claude/Anthropic attribution. Forces re-attempt without.

COMMAND=$(jq -r '.tool_input.command // empty')
[ -z "$COMMAND" ] && exit 0

# Only check git commit and gh pr/issue commands
if echo "$COMMAND" | grep -qE 'git commit|gh (pr|issue)'; then
  if echo "$COMMAND" | grep -qiE 'co-authored-by:[^\n]*claude|co-authored-by:[^\n]*anthropic|generated with[[:space:]]*\[?claude|🤖[[:space:]]*Generated|claude\.com/claude-code|anthropic\.com'; then
    cat <<'EOF' >&2
BLOCKED: commit/PR/issue contains Claude or Anthropic attribution.

Remove these from the message body and retry:
  - "Co-Authored-By: Claude <noreply@anthropic.com>"
  - "🤖 Generated with [Claude Code](https://claude.com/claude-code)"
  - Any other Claude / Anthropic mention.
EOF
    exit 2
  fi
fi

exit 0