#!/usr/bin/env bats
# hooks.json 配線そのものを実 repo / 実 command 文字列経由で実測する bats。
# 各 hook を直接呼ぶのではなく、hooks.json から取り出した command 文字列を
# CLAUDE_PLUGIN_ROOT=$PLUGIN_ROOT bash -c "$cmd" で実行し、${CLAUDE_PLUGIN_ROOT}
# 展開を含む配線全体を検証する。

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
  PLUGIN_ROOT="$REPO_ROOT/plugins/dev-flow"
  HOOKS_JSON="$PLUGIN_ROOT/hooks/hooks.json"
}

# fixture repo を $BATS_TEST_TMPDIR/repo に構築する。sync-inlines.mjs は
# 自身の位置から既定 root を `../plugins/dev-flow` に解決するため、
# tools/ と plugins/dev-flow/{_lib,.claude/workflows} の相対配置を再現する。
build_fixture() {
  FIX="$BATS_TEST_TMPDIR/repo"
  mkdir -p "$FIX/tools" "$FIX/plugins/dev-flow/.claude/workflows"
  cp "$REPO_ROOT/tools/sync-inlines.mjs" "$FIX/tools/"
  cp -R "$PLUGIN_ROOT/_lib" "$FIX/plugins/dev-flow/_lib"
  cp "$PLUGIN_ROOT"/.claude/workflows/*.js "$FIX/plugins/dev-flow/.claude/workflows/"
  git init -q "$FIX"
  git -C "$FIX" config user.email t@example.com
  git -C "$FIX" config user.name t
}

@test "AC3-deny: pretool-inline-edit-guard denies Edit touching a BEGIN marker line" {
  wf="$PLUGIN_ROOT/.claude/workflows/dev-flow.js"
  marker="$(grep -m1 '^// ==== BEGIN inline: ' "$wf")"
  cmd=$(jq -r '.hooks.PreToolUse[] | select(.matcher=="Edit|Write") | .hooks[0].command' "$HOOKS_JSON")
  input=$(jq -n --arg fp "$wf" --arg old "$marker" '{tool_name:"Edit",tool_input:{file_path:$fp,old_string:$old,new_string:"// x"}}')

  export CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT"
  run bash -c "$cmd" <<<"$input"
  echo "$output"
  [ "$status" -eq 0 ]
  echo "$output" | jq -e '.hookSpecificOutput.permissionDecision == "deny"'
}

@test "AC3-allow: pretool-inline-edit-guard allows Edit to a canonical _lib file" {
  cmd=$(jq -r '.hooks.PreToolUse[] | select(.matcher=="Edit|Write") | .hooks[0].command' "$HOOKS_JSON")
  input=$(jq -n --arg fp "$PLUGIN_ROOT/_lib/plugin-version.mjs" '{tool_name:"Edit",tool_input:{file_path:$fp,old_string:"x",new_string:"y"}}')

  export CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT"
  run bash -c "$cmd" <<<"$input"
  echo "$output"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "AC4-allow: pretool-bash-inline-commit-gate permits commit when sync-inlines --check passes" {
  command -v node >/dev/null 2>&1 || skip "node not available"
  build_fixture

  run bash -c "cd \"$FIX\" && node tools/sync-inlines.mjs --check"
  echo "$output"
  [ "$status" -eq 0 ]

  cmd=$(jq -r '.hooks.PreToolUse[] | select(.matcher=="Bash") | .hooks[0].command' "$HOOKS_JSON")
  input=$(jq -n --arg cwd "$FIX" '{tool_name:"Bash",cwd:$cwd,tool_input:{command:"git commit -m x"}}')

  export CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT"
  run bash -c "$cmd" <<<"$input"
  echo "$output"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "AC4-deny: pretool-bash-inline-commit-gate denies commit when sync-inlines --check fails (drift)" {
  command -v node >/dev/null 2>&1 || skip "node not available"
  build_fixture

  wf="$FIX/plugins/dev-flow/.claude/workflows/dev-flow.js"
  awk 'BEGIN{d=0} {print} /^\/\/ ==== BEGIN inline: / && d==0 {print "// drift"; d=1}' "$wf" >"$wf.tmp" && mv "$wf.tmp" "$wf"

  run bash -c "cd \"$FIX\" && node tools/sync-inlines.mjs --check"
  echo "$output"
  [ "$status" -ne 0 ]

  cmd=$(jq -r '.hooks.PreToolUse[] | select(.matcher=="Bash") | .hooks[0].command' "$HOOKS_JSON")
  input=$(jq -n --arg cwd "$FIX" '{tool_name:"Bash",cwd:$cwd,tool_input:{command:"git commit -m x"}}')

  export CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT"
  run bash -c "$cmd" <<<"$input"
  echo "$output"
  [ "$status" -eq 0 ]
  echo "$output" | jq -e '.hookSpecificOutput.permissionDecision == "deny"'
  echo "$output" | jq -r '.hookSpecificOutput.permissionDecisionReason' | grep -q 'sync-inlines'
}

@test "AC4-realroot: commit-gate decision matches sync-inlines --check status at checkout root" {
  command -v node >/dev/null 2>&1 || skip "node not available"

  check_status=0
  (cd "$REPO_ROOT" && node tools/sync-inlines.mjs --check) || check_status=$?

  cmd=$(jq -r '.hooks.PreToolUse[] | select(.matcher=="Bash") | .hooks[0].command' "$HOOKS_JSON")
  input=$(jq -n --arg cwd "$REPO_ROOT" '{tool_name:"Bash",cwd:$cwd,tool_input:{command:"git commit -m x"}}')

  export CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT"
  run bash -c "$cmd" <<<"$input"
  echo "$output"
  [ "$status" -eq 0 ]

  if [ "$check_status" -eq 0 ]; then
    [ -z "$output" ]
  else
    echo "$output" | jq -e '.hookSpecificOutput.permissionDecision == "deny"'
  fi
}

@test "issue-create-guard: PreToolUse の Bash matcher に登録され、素の起票を deny し閲覧は通す" {
  cmd=$(jq -r '.hooks.PreToolUse[] | select(.matcher=="Bash") | .hooks[].command | select(contains("pretool-bash-issue-create-guard.sh"))' "$HOOKS_JSON")
  [ -n "$cmd" ]

  export CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT"
  input=$(jq -n '{tool_name:"Bash",tool_input:{command:"gh -R o/r issue create -t x"}}')
  run bash -c "$cmd" <<<"$input"
  echo "$output"
  [ "$status" -eq 0 ]
  echo "$output" | jq -e '.hookSpecificOutput.permissionDecision == "deny"'

  input=$(jq -n '{tool_name:"Bash",tool_input:{command:"gh issue view 12"}}')
  run bash -c "$cmd" <<<"$input"
  echo "$output"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "journal 解決 (bare 名): PATH 上の playpark-core bin/journal で解決される" {
  local_journal_dir="$BATS_TEST_TMPDIR/j"
  mkdir -p "$local_journal_dir/pending"
  jq -n '{skill:"dev-flow",outcome:"success",issue:572,journal_sh:"journal",telemetry:{merge_tier:"REVIEW"}}' \
    >"$local_journal_dir/pending/handoff-1.json"

  cmd=$(jq -r '.hooks.Stop[] | select(.matcher=="") | .hooks[0].command' "$HOOKS_JSON")

  run env \
    CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" \
    CLAUDE_JOURNAL_DIR="$local_journal_dir" \
    PATH="$REPO_ROOT/plugins/playpark-core/bin:$PATH" \
    HOME="$BATS_TEST_TMPDIR/h" \
    bash -c "$cmd" </dev/null
  echo "$output"
  [ "$status" -eq 0 ]

  pending_files=("$local_journal_dir"/pending/*.json)
  [ ! -e "${pending_files[0]}" ]

  entry_files=("$local_journal_dir"/*.json)
  [ -e "${entry_files[0]}" ]
  [ "${#entry_files[@]}" -eq 1 ]
  [ "$(jq -r '.skill' "${entry_files[0]}")" = "dev-flow" ]
}

@test "journal 解決 (隣接パス): bare 名が解決しない環境では隣接 playpark-core 経由で記録される" {
  local_journal_dir="$BATS_TEST_TMPDIR/j"
  mkdir -p "$local_journal_dir/pending"
  jq -n '{skill:"dev-flow",outcome:"success",issue:572,journal_sh:"journal",telemetry:{merge_tier:"REVIEW"}}' \
    >"$local_journal_dir/pending/handoff-1.json"

  cmd=$(jq -r '.hooks.Stop[] | select(.matcher=="") | .hooks[0].command' "$HOOKS_JSON")

  # PATH=/usr/bin:/bin には journal (bare 名) が存在しない → 隣接 SIBLING_JOURNAL 経路のみで解決する
  run env \
    CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" \
    CLAUDE_JOURNAL_DIR="$local_journal_dir" \
    PATH="/usr/bin:/bin" \
    HOME="$BATS_TEST_TMPDIR/h" \
    bash -c "$cmd" </dev/null
  echo "$output"
  [ "$status" -eq 0 ]

  pending_files=("$local_journal_dir"/pending/*.json)
  [ ! -e "${pending_files[0]}" ]

  entry_files=("$local_journal_dir"/*.json)
  [ -e "${entry_files[0]}" ]
  [ "${#entry_files[@]}" -eq 1 ]
  [ "$(jq -r '.skill' "${entry_files[0]}")" = "dev-flow" ]
}
