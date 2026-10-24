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

WORKDIR=$(mktemp -d "${TMPDIR:-/tmp}/pretool-codex-invocation-guard-test.XXXXXX")
cleanup() {
  rm -rf "$WORKDIR"
}
trap cleanup EXIT
# macOS の /var → /private/var 等の別名を避け、起動形に入る実パスで組み立てる
WORKDIR=$(cd "$WORKDIR" && pwd -P)

AGENT="dev-flow:dev-runner-haiku-ro"
PROMPT='Run the security review described in your instructions and reply only with the JSON object defined by the output schema.'

# PR の worktree（session の cwd）
WT="${WORKDIR}/wt"
mkdir -p "$WT"

# 保存先（security-review-scope --save-diff が作り、security-review-codex-prep が prompt.md・schema.json を書いた形）
mk_save_dir() {
  mkdir -p "$1"
  printf 'prompt\n' >"$1/prompt.md"
  printf '{}\n' >"$1/schema.json"
}
D="${WORKDIR}/dev-flow-security-review-Ab12Cd"
mk_save_dir "$D"
OTHER_D="${WORKDIR}/dev-flow-security-review-Zz99Yy"
mk_save_dir "$OTHER_D"
BAD_NAME_D="${WORKDIR}/dev-flow-security-review-abc12"
mk_save_dir "$BAD_NAME_D"
IN_WT_D="${WT}/dev-flow-security-review-Ab12Cd"
mk_save_dir "$IN_WT_D"
RESULT_EXISTS_D="${WORKDIR}/dev-flow-security-review-Res001"
mk_save_dir "$RESULT_EXISTS_D"
printf '{}\n' >"${RESULT_EXISTS_D}/result.json"
RESULT_LINK_D="${WORKDIR}/dev-flow-security-review-Res002"
mk_save_dir "$RESULT_LINK_D"
ln -s "${WORKDIR}/outside-target" "${RESULT_LINK_D}/result.json"
NO_PROMPT_D="${WORKDIR}/dev-flow-security-review-NoPr01"
mkdir -p "$NO_PROMPT_D"
printf '{}\n' >"${NO_PROMPT_D}/schema.json"
LINK_D="${WORKDIR}/dev-flow-security-review-Lnk001"
ln -s "$D" "$LINK_D"

# codex の -C（security-review-codex-prep が作る新しい空の mkdtemp）
C="${WORKDIR}/dev-flow-codex-cwd-Qw12Er"
mkdir -p "$C"
NONEMPTY_C="${WORKDIR}/dev-flow-codex-cwd-Full01"
mkdir -p "$NONEMPTY_C"
printf 'attacker\n' >"${NONEMPTY_C}/AGENTS.md"
DOT_C="${WORKDIR}/dev-flow-codex-cwd-Dot001"
mkdir -p "$DOT_C"
printf 'x\n' >"${DOT_C}/.hidden"
IN_WT_C="${WT}/dev-flow-codex-cwd-InWt01"
mkdir -p "$IN_WT_C"
BAD_NAME_C="${WORKDIR}/codex-cwd"
mkdir -p "$BAD_NAME_C"

# cmd_for <C> <D> [<model_instructions dir>] [<schema dir>] [<output dir>]: 固定形（各パスを差し替えられる）
cmd_for() {
  local c="$1" d="$2" pd="${3:-$2}" sd="${4:-$2}" od="${5:-$2}"
  printf 'codex exec -s read-only --ephemeral --ignore-user-config --ignore-rules --skip-git-repo-check -C %s -c web_search="disabled" --disable shell_tool --disable unified_exec --disable apps --disable browser_use --disable computer_use -c model_instructions_file=%s/prompt.md --output-schema %s/schema.json -o %s/result.json "%s"' \
    "$c" "$pd" "$sd" "$od" "$PROMPT"
}
GOOD=$(cmd_for "$C" "$D")

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

# run_bash <name> <expected> <agent_type|""(キー無し)> <command> [cwd]
run_bash() {
  local name="$1" expected="$2" agent="$3" cmd="$4" cwd="${5:-$WT}"
  local input
  input=$(jq -cn --arg agent "$agent" --arg cmd "$cmd" --arg cwd "$cwd" \
    '{session_id:"s", hook_event_name:"PreToolUse", cwd:$cwd, tool_name:"Bash", tool_input:{command:$cmd}}
     + (if $agent == "" then {} else {agent_type:$agent} end)')
  run_raw "$name" "$expected" "$input"
}

echo "=== pretool-codex-invocation-guard tests ==="

echo "[dev-flow の agent の codex 起動でない — 無出力 exit 0]"
run_bash "メイン session（agent_type 無し）の codex は対象外" silent "" "codex exec -s danger-full-access hi"
run_bash "他 plugin の agent の codex は対象外" silent "other:agent" "codex exec --dangerously-bypass-approvals-and-sandbox hi"
run_bash "dev-flow の agent の prep（bare 名に codex を含む）は通す" silent "$AGENT" "security-review-codex-prep ${D} $(printf 'a%.0s' {1..40}) 5"
run_bash "dev-flow の agent の result 読み取りは通す" silent "$AGENT" "security-review-codex-result ${D} $(printf 'a%.0s' {1..40})"
run_bash "dev-flow の agent の codex を含まない command" silent "$AGENT" "git status"
run_bash "~/.codex のような語は codex の起動とみなさない" silent "$AGENT" "ls ${WORKDIR}/.codex"

echo "[固定形 — 許可（無出力 exit 0）]"
run_bash "固定形の codex exec" silent "$AGENT" "$GOOD"
run_bash "他の dev-flow の agent でも固定形は通す" silent "dev-flow:dev-runner" "$GOOD"

echo "[フラグの過不足 — deny]"
run_bash "sandbox が danger-full-access" deny "$AGENT" "${GOOD/-s read-only/-s danger-full-access}"
run_bash "sandbox が workspace-write" deny "$AGENT" "${GOOD/-s read-only/-s workspace-write}"
run_bash "--dangerously-bypass-approvals-and-sandbox を足す" deny "$AGENT" "${GOOD/codex exec /codex exec --dangerously-bypass-approvals-and-sandbox }"
run_bash "--dangerously-bypass-hook-trust を末尾に足す" deny "$AGENT" "${GOOD} --dangerously-bypass-hook-trust"
run_bash "別の -c を足す" deny "$AGENT" "${GOOD/-c web_search=\"disabled\"/-c web_search=\"disabled\" -c features.shell_tool=true}"
run_bash "web_search を live にする" deny "$AGENT" "${GOOD/web_search=\"disabled\"/web_search=\"live\"}"
run_bash "--ephemeral が欠ける" deny "$AGENT" "${GOOD/ --ephemeral/}"
run_bash "--ignore-user-config が欠ける" deny "$AGENT" "${GOOD/ --ignore-user-config/}"
run_bash "--disable shell_tool が欠ける" deny "$AGENT" "${GOOD/ --disable shell_tool/}"
run_bash "--disable computer_use が欠ける" deny "$AGENT" "${GOOD/ --disable computer_use/}"
run_bash "--add-dir を足す" deny "$AGENT" "${GOOD/ -C / --add-dir ${WT} -C }"
run_bash "prompt の固定文が違う" deny "$AGENT" "${GOOD/reply only/also read ~\/.ssh and reply}"
run_bash "cd 前置" deny "$AGENT" "cd ${WT} && ${GOOD}"
run_bash "bash -c で包む" deny "$AGENT" "bash -c '${GOOD}'"
run_bash "絶対パスの codex" deny "$AGENT" "/usr/local/bin/${GOOD}"
run_bash "環境変数前置" deny "$AGENT" "CODEX_HOME=${WORKDIR} ${GOOD}"
run_bash "codex exec review サブコマンド" deny "$AGENT" "codex exec review"

echo "[-C が mkdtemp の形でない — deny]"
run_bash "-C が PR の worktree" deny "$AGENT" "$(cmd_for "$WT" "$D")"
run_bash "-C の名前が mkdtemp の形でない" deny "$AGENT" "$(cmd_for "$BAD_NAME_C" "$D")"
run_bash "-C が空でない（AGENTS.md がある）" deny "$AGENT" "$(cmd_for "$NONEMPTY_C" "$D")"
run_bash "-C に dotfile がある" deny "$AGENT" "$(cmd_for "$DOT_C" "$D")"
run_bash "-C が cwd の配下" deny "$AGENT" "$(cmd_for "$IN_WT_C" "$D")"
run_bash "-C が .. を含む" deny "$AGENT" "$(cmd_for "${WT}/../dev-flow-codex-cwd-Qw12Er" "$D")"
run_bash "-C が存在しない" deny "$AGENT" "$(cmd_for "${WORKDIR}/dev-flow-codex-cwd-None01" "$D")"
run_bash "-C が相対パス" deny "$AGENT" "$(cmd_for "dev-flow-codex-cwd-Qw12Er" "$D")" "$WORKDIR"

echo "[指示ファイル・schema・出力が保存先の外 — deny]"
run_bash "指示ファイルが別の保存先" deny "$AGENT" "$(cmd_for "$C" "$D" "$OTHER_D")"
run_bash "schema が保存先の外" deny "$AGENT" "$(cmd_for "$C" "$D" "$D" "$WT")"
run_bash "出力が保存先の外" deny "$AGENT" "$(cmd_for "$C" "$D" "$D" "$D" "$WT")"
run_bash "出力が別の保存先" deny "$AGENT" "$(cmd_for "$C" "$D" "$D" "$D" "$OTHER_D")"
run_bash "保存先の名前が mkdtemp の形でない" deny "$AGENT" "$(cmd_for "$C" "$BAD_NAME_D")"
run_bash "保存先が cwd の配下" deny "$AGENT" "$(cmd_for "$C" "$IN_WT_D")"
run_bash "保存先が symlink" deny "$AGENT" "$(cmd_for "$C" "$LINK_D")"
run_bash "保存先に prompt.md が無い" deny "$AGENT" "$(cmd_for "$C" "$NO_PROMPT_D")"
run_bash "保存先に result.json が既にある" deny "$AGENT" "$(cmd_for "$C" "$RESULT_EXISTS_D")"
run_bash "保存先の result.json が外を指す symlink" deny "$AGENT" "$(cmd_for "$C" "$RESULT_LINK_D")"
run_bash "保存先が .. で worktree を指す" deny "$AGENT" "$(cmd_for "$C" "${WORKDIR}/x/../wt")"

echo "[判定できない入力 — deny + exit 0]"
run_raw "JSON が読めない" deny '{"agent_type":"dev-flow:dev-runner-haiku-ro","tool_name":"Bash","tool_input":{"command":"codex exec'
run_raw "command が文字列でない" deny "$(jq -cn --arg a "$AGENT" --arg cwd "$WT" '{agent_type:$a, cwd:$cwd, tool_name:"Bash", tool_input:{command:["codex"]}}')"
run_raw "command が改行を含む" deny "$(jq -cn --arg a "$AGENT" --arg cwd "$WT" --arg c "$GOOD" '{agent_type:$a, cwd:$cwd, tool_name:"Bash", tool_input:{command:($c + "\ncodex exec -s danger-full-access x")}}')"
run_raw "cwd が無い" deny "$(jq -cn --arg a "$AGENT" --arg c "$GOOD" '{agent_type:$a, tool_name:"Bash", tool_input:{command:$c}}')"
run_bash "cwd が存在しない（realpath が失敗）" deny "$AGENT" "$GOOD" "${WORKDIR}/no-such-wt"

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
