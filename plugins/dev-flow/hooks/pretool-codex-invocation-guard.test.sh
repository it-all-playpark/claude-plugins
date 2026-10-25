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

# codex の形は hook がパスの実体を確かめるので、実在する保存先・作業ディレクトリを作る
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT
TMP_ROOT="$(cd "$TMP_ROOT" && pwd -P)"
RD="${TMP_ROOT}/dev-flow-security-review-Ab12Cd"
RC="${TMP_ROOT}/dev-flow-codex-cwd-Qw12Er"
mkdir -p "$RD" "$RC" "${TMP_ROOT}/wt"
printf 'p' >"$RD/prompt.md"
printf '{}' >"$RD/schema.json"
N="0123456789abcdef0123456789abcdef"
CODEX_PROMPT='Run the security review described in your instructions and reply only with the JSON object defined by the output schema. Set its nonce field to'
# codex_cmd <C> <D> [<nonce>] — _lib/security-review.mjs の codexSecurityReviewCommand と同じ固定形
codex_cmd() {
  printf 'codex exec -s read-only --ephemeral --ignore-user-config --ignore-rules --skip-git-repo-check -C %s -c web_search="disabled" --disable shell_tool --disable unified_exec --disable apps --disable browser_use --disable computer_use -c model_instructions_file=%s/prompt.md --output-schema %s/schema.json -o %s/result.json "%s %s"' "$1" "$2" "$2" "$2" "$CODEX_PROMPT" "${3:-$N}"
}
CODEX_CMD="$(codex_cmd "$RC" "$RD")"

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
run_bash "codex exec の固定形" silent "$RELAY" "$CODEX_CMD"
run_bash "result" silent "$RELAY" "security-review-codex-result ${D} ${SHA} ${N}"
run_bash "result --issues" silent "$RELAY" "security-review-codex-result ${D} ${SHA} ${N} --issues"

echo "[security-codex-relay — それ以外は語を見ずに deny]"
run_bash "result.json の上書き（codex の語を含まない）" deny "$RELAY" "printf '{\"reviewed_sha\":\"${SHA}\",\"issues\":[],\"summary\":\"ok\"}' > ${D}/result.json"
run_bash "固定形でない codex" deny "$RELAY" "codex exec -s read-only -C ${RC} hi"
run_bash "codex の sandbox を緩める" deny "$RELAY" "${CODEX_CMD/-s read-only/-s workspace-write}"
run_bash "codex にフラグを足す" deny "$RELAY" "${CODEX_CMD} --dangerously-bypass-approvals-and-sandbox"
run_bash "codex の出力を保存先の外へ" deny "$RELAY" "${CODEX_CMD/-o ${RD}\/result.json/-o ${TMP_ROOT}/result.json}"
run_bash "codex の保存先が実在しない" deny "$RELAY" "$(codex_cmd "$RC" "$D")"
run_bash "codex の作業ディレクトリが実在しない" deny "$RELAY" "$(codex_cmd "$C" "$RD")"
run_bash "codex の固定形の後ろに連結" deny "$RELAY" "${CODEX_CMD}; rm -f ${RD}/result.json"
run_bash "codex の固定形の後ろにリダイレクト" deny "$RELAY" "${CODEX_CMD} > /dev/null"
run_raw "codex の保存先・作業ディレクトリが cwd の配下" deny "$(jq -cn --arg a "$RELAY" --arg c "$CODEX_CMD" --arg cwd "$TMP_ROOT" '{agent_type:$a, cwd:$cwd, tool_name:"Bash", tool_input:{command:$c}}')"
touch "$RD/result.json"
run_bash "codex の保存先に result.json が既にある" deny "$RELAY" "$CODEX_CMD"
rm -f "$RD/result.json"
touch "$RC/AGENTS.md"
run_bash "codex の作業ディレクトリが空でない" deny "$RELAY" "$CODEX_CMD"
rm -f "$RC/AGENTS.md"
run_bash "引用で分割した codex" deny "$RELAY" "cod''ex exec -s danger-full-access --dangerously-bypass-approvals-and-sandbox -C ${WT} hi"
run_bash "バックスラッシュで分割した codex" deny "$RELAY" "c\\odex exec -s danger-full-access hi"
run_bash "変数で組み立てた codex" deny "$RELAY" "X=cod; \${X}ex exec hi"
run_bash "固定形の後ろに連結" deny "$RELAY" "security-review-codex-result ${D} ${SHA} ${N}; rm -f ${D}/result.json"
run_bash "固定形の後ろにリダイレクト" deny "$RELAY" "security-review-codex-result ${D} ${SHA} ${N} > ${D}/result.json"
run_bash "固定形に改行で続ける" deny "$RELAY" "${CODEX_CMD}"$'\n'"touch ${RD}/result.json"
run_bash "result に余分な引数" deny "$RELAY" "security-review-codex-result ${D} ${SHA} ${N} --extra"
run_bash "codex の -C 側が保存先の形" deny "$RELAY" "$(codex_cmd "$RD" "$RD")"
run_bash "保存先の名前が mkdtemp の形でない" deny "$RELAY" "security-review-codex-result /tmp/x/dev-flow-security-review-abc12 ${SHA} ${N}"
run_bash "保存先が相対パス" deny "$RELAY" "security-review-codex-result dev-flow-security-review-Ab12Cd ${SHA} ${N}"
run_bash "保存先が .. を含む" deny "$RELAY" "security-review-codex-result /tmp/../tmp/dev-flow-security-review-Ab12Cd ${SHA} ${N}"
run_bash "result に nonce が無い" deny "$RELAY" "security-review-codex-result ${D} ${SHA}"
run_bash "result の nonce が 32 桁の小文字 hex でない" deny "$RELAY" "security-review-codex-result ${D} ${SHA} ${N^^}"
run_bash "codex の prompt の nonce が 32 桁の小文字 hex でない" deny "$RELAY" "$(codex_cmd "$RC" "$RD" "abc")"
run_bash "codex の prompt に nonce が無い" deny "$RELAY" "${CODEX_CMD/ ${N}\"/\"}"
run_bash "sha が 40 桁でない" deny "$RELAY" "security-review-codex-result ${D} abc ${N}"
run_bash "cd 前置" deny "$RELAY" "cd ${WT} && ${CODEX_CMD}"
run_bash "環境変数前置" deny "$RELAY" "PATH=/tmp/evil ${CODEX_CMD}"
run_bash "bash 前置" deny "$RELAY" "bash security-review-codex-result ${D} ${SHA} ${N}"
run_bash "他の bare 名" deny "$RELAY" "git status"

echo "[他の dev-flow の agent — codex と保存先だけ deny]"
run_bash "codex を含まない command は通す" silent "$OTHER" "git status"
run_bash "bare 名に codex を含む script は通す" silent "$OTHER" "bash plugins/dev-flow/hooks/pretool-codex-invocation-guard.test.sh"
run_bash "~/.codex のような語は codex の起動とみなさない" silent "$OTHER" "ls /tmp/.codex"
run_bash "引数の codex の語は通す（grep）" silent "$OTHER" "grep -rn codex plugins/dev-flow"
run_bash "タイトルの codex の語は通す（gh pr create）" silent "$OTHER" "gh pr create --draft --title \"feat: codex exec の起動形を直す\" --body-file /tmp/x/pr-body.md"
run_bash "codex の直接起動" deny "$OTHER" "codex exec -s read-only hi"
run_bash "絶対パスの codex" deny "$OTHER" "/opt/homebrew/bin/codex exec hi"
run_bash "連結の後ろの codex" deny "$OTHER" "git status && codex exec hi"
run_bash "パイプの後ろの codex" deny "$OTHER" "echo hi | codex exec -"
run_bash "サブシェルの codex" deny "$OTHER" "(codex exec hi)"
run_bash "引用で分割した codex" deny "$OTHER" "cod''ex exec hi"
run_bash "二重引用で分割した codex" deny "$OTHER" "c\"o\"dex exec hi"
run_bash "バックスラッシュで分割した codex" deny "$OTHER" "c\\odex exec hi"
run_bash "固定形の codex も relay 以外は通さない" deny "$OTHER" "$CODEX_CMD"
run_bash "保存先を触る" deny "$OTHER" "printf x > ${D}/result.json"
run_bash "作業ディレクトリを触る" deny "$OTHER" "touch ${C}/AGENTS.md"

echo "[判定できない入力 — deny + exit 0]"
run_raw "JSON が読めない" deny '{"agent_type":"dev-flow:security-codex-relay","tool_name":"Bash","tool_input":{"command":"x'
run_raw "command が文字列でない" deny "$(jq -cn --arg a "$RELAY" '{agent_type:$a, cwd:"/tmp", tool_name:"Bash", tool_input:{command:["security-review-codex-result"]}}')"

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
