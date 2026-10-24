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
D2="/tmp/x/dev-flow-security-review-Zz99Yy"
C="/tmp/x/dev-flow-codex-cwd-Qw12Er"
SHA="$(printf 'a%.0s' {1..40})"

PASS=0
FAIL=0
FAILURES=()

# run_raw <name> <expected: deny|silent> <raw stdin>
#   silent: 無出力で exit 0 / deny: permissionDecision=deny の JSON を出して exit 0
run_raw() {
  local name="$1" expected="$2" input="$3"
  local output status=0
  output=$(printf '%s' "$input" | CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" bash -c "$HOOK_CMD" 2>/dev/null) || status=$?

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

echo "[dev-flow の agent でない — 無出力 exit 0]"
run_bash "メイン session（agent_type 無し）の codex は対象外" silent "" "codex exec -s danger-full-access hi"
run_bash "他 plugin の agent の codex は対象外" silent "other:agent" "codex exec --dangerously-bypass-approvals-and-sandbox hi"
run_bash "dev-flow の agent でも Bash 以外の tool は対象外" silent "$RELAY" "codex" "Read"

echo "[security-codex-relay — 固定の 3 形だけ通す]"
run_bash "prep" silent "$RELAY" "security-review-codex-prep ${D} ${SHA} 5"
run_bash "prep --verify-from" silent "$RELAY" "security-review-codex-prep ${D} ${SHA} 5 --verify-from ${D2}"
run_bash "run" silent "$RELAY" "security-review-codex-run ${D} ${C}"
run_bash "result" silent "$RELAY" "security-review-codex-result ${D} ${SHA}"
run_bash "result --issues" silent "$RELAY" "security-review-codex-result ${D} ${SHA} --issues"

echo "[security-codex-relay — それ以外は語を見ずに deny]"
run_bash "result.json の上書き（codex の語を含まない）" deny "$RELAY" "printf '{\"reviewed_sha\":\"${SHA}\",\"issues\":[],\"summary\":\"ok\"}' > ${D}/result.json"
run_bash "codex の直接起動" deny "$RELAY" "codex exec -s read-only -C ${C} hi"
run_bash "引用で分割した codex" deny "$RELAY" "cod''ex exec -s danger-full-access --dangerously-bypass-approvals-and-sandbox -C ${WT} hi"
run_bash "バックスラッシュで分割した codex" deny "$RELAY" "c\\odex exec -s danger-full-access hi"
run_bash "変数で組み立てた codex" deny "$RELAY" "X=cod; \${X}ex exec hi"
run_bash "固定形の後ろに連結" deny "$RELAY" "security-review-codex-run ${D} ${C}; rm -f ${D}/result.json"
run_bash "固定形の後ろにリダイレクト" deny "$RELAY" "security-review-codex-result ${D} ${SHA} > ${D}/result.json"
run_bash "固定形に改行で続ける" deny "$RELAY" "security-review-codex-run ${D} ${C}"$'\n'"touch ${D}/result.json"
run_bash "run に余分な引数" deny "$RELAY" "security-review-codex-run ${D} ${C} --extra"
run_bash "run の -C 側が保存先の形" deny "$RELAY" "security-review-codex-run ${D} ${D2}"
run_bash "保存先の名前が mkdtemp の形でない" deny "$RELAY" "security-review-codex-result /tmp/x/dev-flow-security-review-abc12 ${SHA}"
run_bash "保存先が相対パス" deny "$RELAY" "security-review-codex-result dev-flow-security-review-Ab12Cd ${SHA}"
run_bash "保存先が .. を含む" deny "$RELAY" "security-review-codex-result /tmp/../tmp/dev-flow-security-review-Ab12Cd ${SHA}"
run_bash "sha が 40 桁でない" deny "$RELAY" "security-review-codex-result ${D} abc"
run_bash "cd 前置" deny "$RELAY" "cd ${WT} && security-review-codex-run ${D} ${C}"
run_bash "環境変数前置" deny "$RELAY" "PATH=/tmp/evil security-review-codex-run ${D} ${C}"
run_bash "bash 前置" deny "$RELAY" "bash security-review-codex-run ${D} ${C}"
run_bash "他の bare 名" deny "$RELAY" "git status"

echo "[他の dev-flow の agent — codex と保存先だけ deny]"
run_bash "codex を含まない command は通す" silent "$OTHER" "git status"
run_bash "bare 名に codex を含む script は通す" silent "$OTHER" "bash plugins/dev-flow/hooks/pretool-codex-invocation-guard.test.sh"
run_bash "~/.codex のような語は codex の起動とみなさない" silent "$OTHER" "ls /tmp/.codex"
run_bash "codex の直接起動" deny "$OTHER" "codex exec -s read-only hi"
run_bash "引用で分割した codex" deny "$OTHER" "cod''ex exec hi"
run_bash "二重引用で分割した codex" deny "$OTHER" "c\"o\"dex exec hi"
run_bash "バックスラッシュで分割した codex" deny "$OTHER" "c\\odex exec hi"
run_bash "固定形の run も relay 以外は通さない" deny "$OTHER" "security-review-codex-run ${D} ${C}"
run_bash "保存先を触る" deny "$OTHER" "printf x > ${D}/result.json"
run_bash "作業ディレクトリを触る" deny "$OTHER" "touch ${C}/AGENTS.md"

echo "[判定できない入力 — deny + exit 0]"
run_raw "JSON が読めない" deny '{"agent_type":"dev-flow:security-codex-relay","tool_name":"Bash","tool_input":{"command":"x'
run_raw "command が文字列でない" deny "$(jq -cn --arg a "$RELAY" '{agent_type:$a, cwd:"/tmp", tool_name:"Bash", tool_input:{command:["security-review-codex-run"]}}')"

echo ""
echo "=== Results: ${PASS} passed, ${FAIL} failed ==="
if ((FAIL > 0)); then
  printf '\n'
  printf 'Failures:\n'
  for f in "${FAILURES[@]}"; do
    printf '  - %s\n' "$f"
  done
  exit 1
fi
exit 0
