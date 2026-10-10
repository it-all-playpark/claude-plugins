#!/usr/bin/env bats
# Tests for validate-skill-frontmatter.sh, invoked via the hooks.json
# PreToolUse(Write) command exactly as Claude Code would run it.

setup() {
  PLUGIN_ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  CMD=$(jq -r '.hooks.PreToolUse[] | select(.matcher=="Write") | .hooks[0].command' "$PLUGIN_ROOT/hooks/hooks.json")
}

# Content goes through stdin, not --arg: Linux caps a single exec argument at 128KB (MAX_ARG_STRLEN).
run_hook() {
  printf '%s' "$1" | jq -Rs '{tool_name:"Write",tool_input:{file_path:"/x/SKILL.md",content:.}}' \
    | CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" bash -c "$CMD"
}

# repeat <string> <count>
repeat() {
  local out="" i
  for ((i = 0; i < $2; i++)); do out+=$1; done
  printf '%s' "$out"
}

assert_blocked_with() {
  [ "$status" -eq 0 ]
  echo "$output" | jq -e '.hookSpecificOutput.permissionDecision == "block"'
  echo "$output" | jq -r '.hookSpecificOutput.permissionDecisionReason' | grep -qF "$1"
}

@test "description + when_to_use of exactly 1536 chars passes (counted as characters, not bytes)" {
  run run_hook "---
name: foo
description: $(repeat a 1000)
when_to_use: $(repeat あ 536)
---"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "description + when_to_use of 1537 chars is blocked" {
  run run_hook "---
name: foo
description: $(repeat a 1000)
when_to_use: $(repeat あ 537)
---"
  assert_blocked_with "exceeds 1536 character limit (current: 1537 chars)"
}

@test "block scalar (>-) description counts toward the combined limit" {
  run run_hook "---
name: foo
description: >-
  $(repeat a 1537)
---"
  assert_blocked_with "exceeds 1536 character limit (current: 1537 chars)"
}

@test "description alone of 501 chars passes" {
  run run_hook "---
name: foo
description: $(repeat a 501)
---"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "model inherit / alias / full model ID passes" {
  for m in inherit fable claude-opus-5-5; do
    run run_hook $'---\nname: foo\ndescription: does x\nmodel: '"$m"$'\n---'
    [ "$status" -eq 0 ]
    [ -z "$output" ]
  done
}

@test "every tracked SKILL.md passes the validator" {
  local repo_root files f
  repo_root="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
  files=$(git -C "$repo_root" ls-files -- '*SKILL.md')
  [ -n "$files" ]
  while IFS= read -r f; do
    run run_hook "$(cat "$repo_root/$f")"
    [ "$status" -eq 0 ] || { echo "$f: exit $status"; return 1; }
    [ -z "$output" ] || { echo "$f: $output"; return 1; }
  done <<<"$files"
}

@test "content without frontmatter passes through (exit 0, no output)" {
  run run_hook $'# title\n\nno frontmatter here.'
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "missing name is blocked" {
  run run_hook $'---\ndescription: x\n---'
  [ "$status" -eq 0 ]
  echo "$output" | jq -e '.hookSpecificOutput.permissionDecision == "block"'
  echo "$output" | jq -r '.hookSpecificOutput.permissionDecisionReason' | grep -q "name"
}

@test "empty description is blocked" {
  run run_hook $'---\nname: foo\ndescription:\n---'
  [ "$status" -eq 0 ]
  echo "$output" | jq -e '.hookSpecificOutput.permissionDecision == "block"'
}

@test "invalid model is blocked" {
  run run_hook $'---\nname: foo\ndescription: does x\nmodel: foo\n---'
  assert_blocked_with "Invalid model: 'foo'"
}

@test "invalid effort is blocked" {
  run run_hook $'---\nname: foo\ndescription: does x\neffort: turbo\n---'
  [ "$status" -eq 0 ]
  echo "$output" | jq -e '.hookSpecificOutput.permissionDecision == "block"'
  echo "$output" | jq -r '.hookSpecificOutput.permissionDecisionReason' | grep -q "Invalid effort"
}

# grep -q exits at the first match; if the frontmatter is still being piped in, the writer gets
# SIGPIPE and pipefail turns a present field into "missing". A large frontmatter makes it deterministic.
@test "description near the top of a large frontmatter is not reported missing" {
  run run_hook "---
name: foo
description: does x
when_to_use: when y
metadata:
$(repeat $'  k: v\n' 50000)---"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "valid frontmatter passes through (exit 0, no output)" {
  run run_hook $'---\nname: foo\ndescription: does x\nmodel: haiku\neffort: low\n---'
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}
