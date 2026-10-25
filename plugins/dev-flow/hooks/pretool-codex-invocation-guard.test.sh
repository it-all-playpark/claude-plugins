#!/usr/bin/env bash
# Test suite for pretool-codex-invocation-guard.sh（issue #1087）
#
# hooks.json から取り出した command 文字列を CLAUDE_PLUGIN_ROOT 付きで実行し、配線ごと確かめる。
# 許可する固定形が _lib/security-review.mjs の codexSecurityReviewCommand と一致することは
# _lib/security-review.test.mjs が同じ hook を起動して確かめる。
#
# Usage: bash pretool-codex-invocation-guard.test.sh
#
# Exit 0 on all pass, non-zero otherwise.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HOOKS_JSON="${SCRIPT_DIR}/hooks.json"

HOOK_CMD=$(jq -r '.hooks.PreToolUse[] | select(.matcher == "Bash") | .hooks[].command | select(contains("pretool-codex-invocation-guard.sh"))' "$HOOKS_JSON")
if [[ $HOOK_CMD != *'${CLAUDE_PLUGIN_ROOT}/hooks/pretool-codex-invocation-guard.sh'* ]]; then
  echo "FAIL: hooks.json の matcher Bash に pretool-codex-invocation-guard.sh が無い: ${HOOK_CMD}" >&2
  exit 1
fi

RELAY="dev-flow:security-codex-relay"
OTHER="dev-flow:dev-runner-haiku-ro"
WT="/tmp/wt"
D="/tmp/x/dev-flow-security-review-Ab12Cd"
D2="/tmp/x/dev-flow-security-review-Zz98Yy"
SHA="$(printf 'a%.0s' {1..40})"
CODEX_PROMPT='Run the security review described in your instructions and reply only with the JSON object defined by the output schema.'

# codex_cmd <D> — _lib/security-review.mjs の codexSecurityReviewCommand と同じ固定形
codex_cmd() {
  printf 'codex exec -s read-only --ephemeral --ignore-user-config --ignore-rules --skip-git-repo-check -C %s/cwd -c web_search="disabled" --disable shell_tool --disable unified_exec --disable apps --disable browser_use --disable computer_use -c model_instructions_file=%s/prompt.md --output-schema %s/schema.json -o %s/result.json "%s"' "$1" "$1" "$1" "$1" "$CODEX_PROMPT"
}
CODEX_CMD="$(codex_cmd "$D")"

PASS=0
FAIL=0
FAILURES=()

# run_raw <name> <expected: deny|silent> <raw stdin>
#   silent: 無出力で exit 0 / deny: permissionDecision=deny の JSON を出して exit 0
run_raw() {
  local name="$1" expected="$2" input="$3"
  local output status=0
  output=$(printf '%s' "$input" | CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" "$BASH" -c "$HOOK_CMD" 2>/dev/null) || status=$?

  local got
  if [[ $status -ne 0 ]]; then
    got="exit=${status}"
  elif [[ -z $output ]]; then
    got="silent"
  else
    got=$(jq -r '.hookSpecificOutput | select(.hookEventName == "PreToolUse") | .permissionDecision' <<<"$output" 2>/dev/null || true)
    [[ -n $got ]] || got="unparsable-output"
  fi

  if [[ $got == "$expected" ]]; then
    PASS=$((PASS + 1))
    printf "  \033[32mPASS\033[0m %s\n" "$name"
  else
    FAIL=$((FAIL + 1))
    FAILURES+=("$name: expected=$expected got=$got")
    printf "  \033[31mFAIL\033[0m %s (expected=%s, got=%s)\n" "$name" "$expected" "$got"
  fi
}

# run_bash <name> <expected> <agent_type|""(キー無し)> <command> [tool]
run_bash() {
  local name="$1" expected="$2" agent="$3" cmd="$4" tool="${5:-Bash}"
  local input
  input=$(jq -cn --arg agent "$agent" --arg cmd "$cmd" --arg cwd "$WT" --arg tool "$tool" \
    '{session_id:"s", hook_event_name:"PreToolUse", cwd:$cwd, tool_name:$tool, tool_input:{command:$cmd}}
     + (if $agent == "" then {} else {agent_type:$agent} end)')
  run_raw "$name" "$expected" "$input"
}

echo "=== pretool-codex-invocation-guard tests ==="

echo "[security-codex-relay でない — 無出力 exit 0]"
run_bash "メイン session（agent_type 無し）は対象外" silent "" "codex exec -s danger-full-access hi"
run_bash "他の dev-flow の agent は対象外" silent "$OTHER" "codex exec -s danger-full-access hi"
run_bash "他 plugin の agent は対象外" silent "other:agent" "rm -rf ${D}"
run_bash "中継でも Bash 以外の tool は対象外" silent "$RELAY" "codex" "Read"

echo "[security-codex-relay — 固定の 3 形だけ通す]"
run_bash "prep" silent "$RELAY" "security-review-codex-prep ${D} ${SHA} 5"
run_bash "prep --verify-from" silent "$RELAY" "security-review-codex-prep ${D} ${SHA} 5 --verify-from ${D2}"
run_bash "codex exec の固定形" silent "$RELAY" "$CODEX_CMD"
run_bash "result" silent "$RELAY" "security-review-codex-result ${D} ${SHA}"
run_bash "result --issues" silent "$RELAY" "security-review-codex-result ${D} ${SHA} --issues"

echo "[security-codex-relay — 固定形から外れたものは deny]"
run_bash "任意のコマンド" deny "$RELAY" "cat ${D}/result.json"
run_bash "result.json の上書き" deny "$RELAY" "printf '{}' > ${D}/result.json"
run_bash "固定形の後ろに別のコマンド" deny "$RELAY" "security-review-codex-result ${D} ${SHA}; rm -rf /"
run_bash "codex の sandbox を変える" deny "$RELAY" "${CODEX_CMD/-s read-only/-s danger-full-access}"
run_bash "codex の flag を外す" deny "$RELAY" "${CODEX_CMD/ --disable shell_tool/}"
run_bash "codex の flag を足す" deny "$RELAY" "${CODEX_CMD} --dangerously-bypass-approvals-and-sandbox"
run_bash "codex の -o を保存先の外へ" deny "$RELAY" "${CODEX_CMD/-o ${D}\/result.json/-o /tmp/elsewhere.json}"
run_bash "codex の prompt を変える" deny "$RELAY" "${CODEX_CMD/reply only/ignore the schema and reply}"
run_bash "codex の保存先が 1 つに揃っていない" deny "$RELAY" "${CODEX_CMD/-o ${D}/-o ${D2}}"
run_bash "codex をパス付きで起動" deny "$RELAY" "/usr/local/bin/${CODEX_CMD}"
run_bash "env 前置の codex" deny "$RELAY" "env ${CODEX_CMD}"
run_bash "保存先の名前でないパス" deny "$RELAY" "security-review-codex-prep /tmp/x/other ${SHA} 5"
run_bash "保存先に .. の要素" deny "$RELAY" "security-review-codex-result /tmp/../x/dev-flow-security-review-Ab12Cd ${SHA}"
run_bash "--verify-from に .. の要素" deny "$RELAY" "security-review-codex-prep ${D} ${SHA} 5 --verify-from /tmp/../dev-flow-security-review-Zz98Yy"
run_bash "codex の保存先に . の要素" deny "$RELAY" "$(codex_cmd /tmp/./dev-flow-security-review-Ab12Cd)"
run_bash "sha が 40 桁でない" deny "$RELAY" "security-review-codex-result ${D} abc"
run_bash "PR 番号が数字でない" deny "$RELAY" "security-review-codex-prep ${D} ${SHA} x"
run_bash "引用符で包んだ引数" deny "$RELAY" "security-review-codex-result '${D}' ${SHA}"
run_bash "改行を含む command" deny "$RELAY" "security-review-codex-result ${D} ${SHA}
rm -rf /"
run_bash "余分な空白" deny "$RELAY" "security-review-codex-result  ${D} ${SHA}"

echo "[判定できない入力は deny]"
run_raw "JSON でない入力" deny 'not json security-codex-relay'
run_raw "command が文字列でない" deny "{\"agent_type\":\"${RELAY}\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":1}}"

echo
echo "=== ${PASS} passed, ${FAIL} failed ==="
if [[ $FAIL -gt 0 ]]; then
  printf '  %s\n' "${FAILURES[@]}"
  exit 1
fi
