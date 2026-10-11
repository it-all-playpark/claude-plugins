#!/usr/bin/env bats
# Tests for the journal.sh-backed hooks (hook-capture / track-skill),
# invoked via the hooks.json commands exactly as Claude Code would run them.

setup() {
  PLUGIN_ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  HOOKS_JSON="$PLUGIN_ROOT/hooks/hooks.json"
  export CLAUDE_JOURNAL_DIR="$BATS_TEST_TMPDIR/journal"
  mkdir -p "$CLAUDE_JOURNAL_DIR"
  SID="bats-$$"

  # /tmp write probe: this sandbox denies writes directly under /tmp, but
  # CI (ubuntu) allows it. track-skill only makes sense against a real
  # /tmp state file, so skip it when the probe fails.
  TMP_OK=0
  if touch "/tmp/.claude-skill-ctx-probe-$$" 2>/dev/null; then
    TMP_OK=1
    rm -f "/tmp/.claude-skill-ctx-probe-$$"
  fi
}

teardown() {
  rm -f "/tmp/claude-skill-ctx-${SID}"
}

# Runs a hooks.json command with the given JSON stdin payload, without
# nesting `bash -c` inside `bash -c` (which mangles the command's own
# double quotes when interpolated as a string).
run_hook_cmd() {
  local payload="$1" cmd="$2"
  printf '%s' "$payload" | CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" bash -c "$cmd"
}

@test "hook-capture writes a journal entry with source=hook and skill=hook-<ToolName>" {
  cmd=$(jq -r '.hooks.PostToolUseFailure[0].hooks[0].command' "$HOOKS_JSON")
  payload=$(jq -n '{tool_name:"Bash",tool_input:{command:"x"},error:"boom error",session_id:"s1"}')

  run run_hook_cmd "$payload" "$cmd"
  [ "$status" -eq 0 ]

  run bash -c "ls '$CLAUDE_JOURNAL_DIR'/*.json"
  [ "$status" -eq 0 ]
  [ "$(echo "$output" | wc -l | tr -d ' ')" -eq 1 ]

  entry_file="$output"
  run jq -r '.source' "$entry_file"
  [ "$status" -eq 0 ]
  [ "$output" = "hook" ]

  run jq -r '.skill' "$entry_file"
  [ "$status" -eq 0 ]
  [ "$output" = "hook-Bash" ]
}

@test "track-skill writes the active skill name to the session state file" {
  [ "$TMP_OK" = 1 ] || skip "/tmp not writable in this sandbox"

  cmd=$(jq -r '.hooks.PreToolUse[] | select(.matcher=="Skill") | .hooks[0].command' "$HOOKS_JSON")
  payload=$(jq -n --arg sid "$SID" '{tool_input:{skill:"foo"},session_id:$sid}')

  run run_hook_cmd "$payload" "$cmd"
  [ "$status" -eq 0 ]

  [ -f "/tmp/claude-skill-ctx-${SID}" ]
  run cat "/tmp/claude-skill-ctx-${SID}"
  [ "$output" = "foo" ]
}

@test "UserPromptSubmit hook clears the session state file written by track-skill" {
  [ "$TMP_OK" = 1 ] || skip "/tmp not writable in this sandbox"

  echo foo > "/tmp/claude-skill-ctx-${SID}"
  cmd=$(jq -r '.hooks.UserPromptSubmit[0].hooks[0].command' "$HOOKS_JSON")
  payload=$(jq -n --arg sid "$SID" '{prompt:"next",session_id:$sid}')

  run run_hook_cmd "$payload" "$cmd"
  [ "$status" -eq 0 ]
  [ ! -f "/tmp/claude-skill-ctx-${SID}" ]
}
