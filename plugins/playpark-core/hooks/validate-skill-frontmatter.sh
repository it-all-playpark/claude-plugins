#!/usr/bin/env bash
# validate-skill-frontmatter.sh - PreToolUse Hook for SKILL.md frontmatter validation
#
# Reads PreToolUse JSON from stdin. Blocks Write if SKILL.md frontmatter is invalid.
#
# Validation rules:
#   - name: required
#   - description: required. description + when_to_use combined max 1536 chars
#     (Claude Code truncates the combined text there; description alone has no limit)
#   - model: if present, must be inherit, a /model alias, or a full model ID (claude-*)
#   - effort: if present, must be low|medium|high|xhigh|max
#   - context: if present, must be fork
#
# Spec: https://code.claude.com/docs/en/skills#frontmatter-reference

set -euo pipefail

COMBINED_DESC_LIMIT=1536

INPUT=$(cat)

CONTENT=$(echo "$INPUT" | jq -r '.tool_input.content // empty' 2>/dev/null) || exit 0
[[ -z $CONTENT ]] && exit 0

# Extract frontmatter (between first pair of ---)
FRONTMATTER=$(echo "$CONTENT" | sed -n '/^---$/,/^---$/p' | sed '1d;$d')
[[ -z $FRONTMATTER ]] && exit 0

ERRORS=()

# Value of a top-level key: inline scalar, or the indented lines of a block scalar (| > |- >- ...)
field_value() {
  local key=$1 inline block_re='^[|>][-+]?$'
  inline=$(echo "$FRONTMATTER" | grep -E "^${key}:" | head -1 | sed -E "s/^${key}:[[:space:]]*//")
  if [[ -z $inline || $inline =~ $block_re ]]; then
    echo "$FRONTMATTER" | sed -n "/^${key}:/,/^[a-z]/{/^${key}:/d;/^[a-z]/d;p;}" | sed 's/^  //'
  else
    echo "$inline"
  fi
}

# Character (code point) count independent of the caller's locale
char_len() {
  printf '%s' "$1" | jq -Rs 'length'
}

# --- Required fields ---

NAME=$(echo "$FRONTMATTER" | grep -E '^name:\s*' | head -1 | sed 's/^name:\s*//' | xargs 2>/dev/null || true)
if [[ -z $NAME ]]; then
  ERRORS+=("Missing required field: name")
fi

# Here-strings, not `echo | grep -q`: grep -q exits at the first match, the echo then dies of SIGPIPE,
# and pipefail would turn a present field into a missing one.
if ! grep -qE '^description:' <<<"$FRONTMATTER"; then
  ERRORS+=("Missing required field: description")
else
  DESC_VALUE=$(field_value description)

  # Not xargs: it rejects unmatched quotes (e.g. "devil's") and would report a non-empty description as empty
  if [[ -z ${DESC_VALUE//[[:space:]]/} ]]; then
    ERRORS+=("description is empty")
  fi

  WHEN_VALUE=""
  if grep -qE '^when_to_use:' <<<"$FRONTMATTER"; then
    WHEN_VALUE=$(field_value when_to_use)
  fi

  COMBINED_LEN=$(($(char_len "$DESC_VALUE") + $(char_len "$WHEN_VALUE")))
  if [[ $COMBINED_LEN -gt $COMBINED_DESC_LIMIT ]]; then
    ERRORS+=("description + when_to_use exceeds ${COMBINED_DESC_LIMIT} character limit (current: ${COMBINED_LEN} chars)")
  fi
fi

# --- Optional field validation ---

MODEL=$(echo "$FRONTMATTER" | grep -E '^model:\s*' | head -1 | sed 's/^model:\s*//' | xargs 2>/dev/null || true)
if [[ -n $MODEL ]]; then
  case "$MODEL" in
  inherit | default | best | fable | sonnet | opus | haiku | 'sonnet[1m]' | 'opus[1m]' | opusplan) ;;
  claude-[a-z0-9]*) ;;
  *) ERRORS+=("Invalid model: '${MODEL}'. Must be inherit, an alias (default, best, fable, sonnet, opus, haiku, sonnet[1m], opus[1m], opusplan), or a full model ID (claude-*)") ;;
  esac
fi

EFFORT=$(echo "$FRONTMATTER" | grep -E '^effort:\s*' | head -1 | sed 's/^effort:\s*//' | xargs 2>/dev/null || true)
if [[ -n $EFFORT ]]; then
  case "$EFFORT" in
  low | medium | high | xhigh | max) ;;
  *) ERRORS+=("Invalid effort: '${EFFORT}'. Must be one of: low, medium, high, xhigh, max") ;;
  esac
fi

CONTEXT=$(echo "$FRONTMATTER" | grep -E '^context:\s*' | head -1 | sed 's/^context:\s*//' | xargs 2>/dev/null || true)
if [[ -n $CONTEXT ]]; then
  case "$CONTEXT" in
  fork) ;;
  *) ERRORS+=("Invalid context: '${CONTEXT}'. Must be: fork") ;;
  esac
fi

# --- Output ---

if [[ ${#ERRORS[@]} -gt 0 ]]; then
  REASON=""
  for err in "${ERRORS[@]}"; do
    [[ -n $REASON ]] && REASON+="; "
    REASON+="$err"
  done

  jq -n --arg reason "SKILL.md frontmatter validation failed: $REASON" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"block",permissionDecisionReason:$reason}}'
fi
