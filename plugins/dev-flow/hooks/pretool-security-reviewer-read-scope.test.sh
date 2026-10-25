#!/usr/bin/env bash
# Test suite for pretool-security-reviewer-read-scope.sh
#
# hooks.json から取り出した command 文字列を CLAUDE_PLUGIN_ROOT 付きで実行し、配線ごと確かめる。
#
# Usage: bash pretool-security-reviewer-read-scope.test.sh
#
# Exit 0 on all pass, non-zero otherwise.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HOOKS_JSON="${SCRIPT_DIR}/hooks.json"
HOOK="${SCRIPT_DIR}/pretool-security-reviewer-read-scope.sh"

if [[ ! -x ${HOOK} ]]; then
  echo "FAIL: hook not executable: ${HOOK}" >&2
  exit 1
fi

HOOK_CMD=$(jq -r '.hooks.PreToolUse[] | select(.matcher == "Read|Grep|Glob") | .hooks[].command' "$HOOKS_JSON")
if [[ $HOOK_CMD != *'${CLAUDE_PLUGIN_ROOT}/hooks/pretool-security-reviewer-read-scope.sh'* ]]; then
  echo "FAIL: hooks.json に matcher Read|Grep|Glob の PreToolUse hook が無い: ${HOOK_CMD}" >&2
  exit 1
fi

WORKDIR=$(mktemp -d "${TMPDIR:-/tmp}/pretool-security-reviewer-read-scope-test.XXXXXX")
cleanup() {
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

AGENT="dev-flow:security-reviewer"

# PR の worktree（session の cwd）
WT="${WORKDIR}/wt"
mkdir -p "${WT}/.claude/rules"
printf 'attacker text\n' >"${WT}/CLAUDE.md"
printf 'attacker rule\n' >"${WT}/.claude/rules/dev-flow.md"

# diff の保存先（security-review-scope --save-diff が mkdtemp で作る形）
D="${WORKDIR}/dev-flow-security-review-Ab12Cd"
mkdir -p "$D"
printf 'diff --git a/x b/x\n' >"${D}/pr.diff"
printf 'outside\n' >"${WORKDIR}/outside.txt"
ln -s "${WT}/CLAUDE.md" "${D}/escape-to-cwd"
ln -s "${WORKDIR}/outside.txt" "${D}/escape-to-outside"
ln -s "${D}/pr.diff" "${D}/inner-link"
ln -s "${WORKDIR}/missing-target" "${D}/dangling"

# cwd の配下に同じ名前のディレクトリ
FAKE_D="${WT}/dev-flow-security-review-Ab12Cd"
mkdir -p "$FAKE_D"
cp "${D}/pr.diff" "${FAKE_D}/pr.diff"

# 名前が mkdtemp の形でないディレクトリ
mkdir -p "${WORKDIR}/dev-flow-security-review-abc12" "${WORKDIR}/dev-flow-security-review-abc12!"
cp "${D}/pr.diff" "${WORKDIR}/dev-flow-security-review-abc12/pr.diff"
cp "${D}/pr.diff" "${WORKDIR}/dev-flow-security-review-abc12!/pr.diff"

# 親ディレクトリを symlink 経由で書いた表記
ln -s "$WORKDIR" "${WORKDIR}/alias"

# 失敗する外部コマンドの stub
STUB_REALPATH="${WORKDIR}/stub-realpath"
STUB_JQ="${WORKDIR}/stub-jq"
mkdir -p "$STUB_REALPATH" "$STUB_JQ"
printf '#!/bin/sh\nexit 1\n' >"${STUB_REALPATH}/realpath"
printf '#!/bin/sh\nexit 1\n' >"${STUB_JQ}/jq"
chmod +x "${STUB_REALPATH}/realpath" "${STUB_JQ}/jq"

PASS=0
FAIL=0
FAILURES=()

# run_raw <name> <expected: deny|silent> <raw stdin> [PATH prefix]
#   silent: 無出力で exit 0 / deny: permissionDecision=deny の JSON を出して exit 0
run_raw() {
  local name="$1" expected="$2" input="$3" path_prefix="${4:-}"
  local output status=0
  if [[ -n $path_prefix ]]; then
    output=$(printf '%s' "$input" | PATH="${path_prefix}:${PATH}" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" bash -c "$HOOK_CMD" 2>/dev/null) || status=$?
  else
    output=$(printf '%s' "$input" | CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" bash -c "$HOOK_CMD" 2>/dev/null) || status=$?
  fi

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

# run_tool <name> <expected> <agent_type|""(キー無し)> <tool> <tool_input JSON> [cwd]
run_tool() {
  local name="$1" expected="$2" agent="$3" tool="$4" tool_input="$5" cwd="${6:-$WT}"
  local input
  input=$(jq -cn --arg agent "$agent" --arg tool "$tool" --argjson ti "$tool_input" --arg cwd "$cwd" \
    '{session_id:"s", hook_event_name:"PreToolUse", cwd:$cwd, tool_name:$tool, tool_input:$ti}
     + (if $agent == "" then {} else {agent_type:$agent} end)')
  run_raw "$name" "$expected" "$input"
}

read_input() {
  jq -cn --arg p "$1" '{file_path:$p}'
}

echo "=== pretool-security-reviewer-read-scope tests ==="

echo "[agent_type が security-reviewer でない — 無出力 exit 0]"
run_tool "agent_type 無し（メイン session）の worktree Read" silent "" Read "$(read_input "${WT}/CLAUDE.md")"
run_tool "他の agent（pr-reviewer）の worktree Read" silent "dev-flow:pr-reviewer" Read "$(read_input "${WT}/.claude/rules/dev-flow.md")"
run_tool "namespace の無い security-reviewer は対象外" silent "security-reviewer-x" Read "$(read_input "${WT}/CLAUDE.md")"
run_tool "メイン session が security-reviewer.md を Read" silent "" Read "$(read_input "${PLUGIN_ROOT}/agents/security-reviewer.md")"
run_tool "他の agent の path 無し Grep" silent "dev-flow:evaluator" Grep '{"pattern":"x"}'
run_raw "agent_type 無しの JSON でない入力" silent 'not json'

echo "[保存先の配下 — 許可（無出力 exit 0）]"
run_tool "保存先の diff を Read" silent "$AGENT" Read "$(read_input "${D}/pr.diff")"
run_tool "親を symlink 経由で書いた保存先の diff" silent "$AGENT" Read "$(read_input "${WORKDIR}/alias/dev-flow-security-review-Ab12Cd/pr.diff")"
run_tool "保存先の中の .. を含む表記" silent "$AGENT" Read "$(read_input "${D}/../dev-flow-security-review-Ab12Cd/pr.diff")"
run_tool "Grep: path が保存先の diff・glob が相対" silent "$AGENT" Grep "$(jq -cn --arg p "${D}/pr.diff" '{pattern:"x", path:$p, glob:"**/*.diff"}')"

run_tool "Grep: path が保存先自身" silent "$AGENT" Grep "$(jq -cn --arg p "$D" '{pattern:"x", path:$p}')"
run_tool "保存先の中で diff を指す symlink を Read" silent "$AGENT" Read "$(read_input "${D}/inner-link")"

echo "[Glob は保存先の配下でも deny]"
run_tool "Glob: path が保存先自身" deny "$AGENT" Glob "$(jq -cn --arg p "$D" '{pattern:"*.diff", path:$p}')"

# /tmp と /private/tmp（macOS の /tmp -> private/tmp）の表記の違い
D_REAL=$(realpath "$D")
if [[ $D_REAL == /private/* && -e "/${D_REAL#/private/}" ]]; then
  SHORT="/${D_REAL#/private/}"
  run_tool "/private/ 付きの realpath 表記で Read" silent "$AGENT" Read "$(read_input "${D_REAL}/pr.diff")"
  run_tool "/private/ を外した表記（/tmp 等）で Read" silent "$AGENT" Read "$(read_input "${SHORT}/pr.diff")"
  WT_REAL=$(realpath "$WT")
  run_tool "cwd と表記が違う（/private/ 付き）cwd 配下の CLAUDE.md" deny "$AGENT" Read "$(read_input "${WT_REAL}/CLAUDE.md")" "/${WT_REAL#/private/}"
  run_tool "cwd と表記が違う（/private/ 付き）cwd 配下の同じ名前のディレクトリ" deny "$AGENT" Read "$(read_input "${WT_REAL}/dev-flow-security-review-Ab12Cd/pr.diff")" "/${WT_REAL#/private/}"
else
  echo "  SKIP /tmp と /private/tmp の表記（TMPDIR の realpath が /private/ 配下でない環境）"
fi

# macOS の firmlink（/System/Volumes/Data 経由）の表記。realpath はこの表記を正規化しない
WT_REAL=$(realpath "$WT")
FIRM_WT="/System/Volumes/Data${WT_REAL}"
if [[ -d $FIRM_WT && $FIRM_WT -ef $WT_REAL ]]; then
  run_tool "/System/Volumes/Data 経由の cwd 配下の CLAUDE.md" deny "$AGENT" Read "$(read_input "${FIRM_WT}/CLAUDE.md")"
  run_tool "/System/Volumes/Data 経由の cwd 配下の同じ名前のディレクトリ" deny "$AGENT" Read "$(read_input "${FIRM_WT}/dev-flow-security-review-Ab12Cd/pr.diff")"
  run_tool "/System/Volumes/Data 経由の cwd 配下の同じ名前のディレクトリを Glob" deny "$AGENT" Glob "$(jq -cn --arg p "${FIRM_WT}/dev-flow-security-review-Ab12Cd" '{pattern:"*", path:$p}')"
  run_tool "/System/Volumes/Data 経由の保存先の diff は許可" silent "$AGENT" Read "$(read_input "/System/Volumes/Data$(realpath "$D")/pr.diff")"
else
  echo "  SKIP /System/Volumes/Data 経由の表記（firmlink の無い環境）"
fi

echo "[保存先の外 — deny]"
run_tool "cwd 配下の CLAUDE.md" deny "$AGENT" Read "$(read_input "${WT}/CLAUDE.md")"
run_tool "cwd 配下の .claude/rules" deny "$AGENT" Read "$(read_input "${WT}/.claude/rules/dev-flow.md")"
run_tool "cwd 配下に作った同じ名前のディレクトリ" deny "$AGENT" Read "$(read_input "${FAKE_D}/pr.diff")"
run_tool "cwd 配下の同じ名前のディレクトリを Glob" deny "$AGENT" Glob "$(jq -cn --arg p "$FAKE_D" '{pattern:"*", path:$p}')"
run_tool "保存先の中の symlink が cwd を指す" deny "$AGENT" Read "$(read_input "${D}/escape-to-cwd")"
run_tool "保存先の中の symlink が保存先の外を指す" deny "$AGENT" Read "$(read_input "${D}/escape-to-outside")"
run_tool "保存先の中の dangling symlink" deny "$AGENT" Read "$(read_input "${D}/dangling")"
run_tool "存在しないパス（保存先の中）" deny "$AGENT" Read "$(read_input "${D}/missing.diff")"
run_tool "保存先の .. で外に出る" deny "$AGENT" Read "$(read_input "${D}/../outside.txt")"
run_tool "保存先と無関係のファイル" deny "$AGENT" Read "$(read_input "${WORKDIR}/outside.txt")"
run_tool "名前の乱数部が 5 文字" deny "$AGENT" Read "$(read_input "${WORKDIR}/dev-flow-security-review-abc12/pr.diff")"
run_tool "名前の乱数部に記号" deny "$AGENT" Read "$(read_input "${WORKDIR}/dev-flow-security-review-abc12!/pr.diff")"
run_tool "相対パスは cwd から解決する" deny "$AGENT" Read "$(read_input "CLAUDE.md")"
run_tool "cwd 自身が保存先の配下でも cwd 配下は deny" deny "$AGENT" Read "$(read_input "${D}/pr.diff")" "$D"

echo "[Grep / Glob の path と pattern — deny]"
run_tool "Grep: path 無し" deny "$AGENT" Grep '{"pattern":"x"}'
run_tool "Grep: path が空" deny "$AGENT" Grep '{"pattern":"x","path":""}'
run_tool "Glob: path 無し" deny "$AGENT" Glob '{"pattern":"*.diff"}'
run_tool "Glob: path が空" deny "$AGENT" Glob '{"pattern":"*.diff","path":""}'
run_tool "Glob: pattern が / 始まり" deny "$AGENT" Glob "$(jq -cn --arg p "$D" --arg pat "${WT}/*" '{pattern:$pat, path:$p}')"
run_tool "Glob: pattern が .. で始まる" deny "$AGENT" Glob "$(jq -cn --arg p "$D" '{pattern:"../wt/*", path:$p}')"
run_tool "Glob: pattern の途中に .. の要素" deny "$AGENT" Glob "$(jq -cn --arg p "$D" '{pattern:"**/../../wt/CLAUDE.md", path:$p}')"
run_tool "Glob: pattern の brace に .." deny "$AGENT" Glob "$(jq -cn --arg p "$D" '{pattern:"{..,x}/wt/*", path:$p}')"
run_tool "Glob: pattern が ~ 始まり" deny "$AGENT" Glob "$(jq -cn --arg p "$D" '{pattern:"~/x", path:$p}')"
run_tool "Grep: glob が / 始まり" deny "$AGENT" Grep "$(jq -cn --arg p "$D" '{pattern:"x", path:$p, glob:"/etc/*"}')"
run_tool "Grep: glob が .. の要素を含む" deny "$AGENT" Grep "$(jq -cn --arg p "$D" '{pattern:"x", path:$p, glob:"a/../../wt/*"}')"
run_tool "Grep: path が cwd" deny "$AGENT" Grep "$(jq -cn --arg p "$WT" '{pattern:"x", path:$p}')"
run_tool "Grep: path が ." deny "$AGENT" Grep '{"pattern":"x","path":"."}'

echo "[claude -p --agent の main thread（agent_id 無し・agent_type だけ）— security-review-isolated の起動形]"
# security-review-isolated は空の新しいディレクトリを cwd に `claude -p --agent dev-flow:security-reviewer` を起動する。
# main thread の hook 入力には agent_id が無く agent_type だけが入るので、その形でも checkout を読ませないことを確かめる
NEUTRAL="${WORKDIR}/dev-flow-security-review-cwd-x"
mkdir -p "$NEUTRAL"
main_input() {
  jq -cn --arg a "$AGENT" --arg cwd "$NEUTRAL" --arg tool "$1" --argjson ti "$2" \
    '{session_id:"s", hook_event_name:"PreToolUse", cwd:$cwd, agent_type:$a, tool_name:$tool, tool_input:$ti}'
}
run_raw "--agent: checkout の CLAUDE.md を Read" deny "$(main_input Read "$(read_input "${WT}/CLAUDE.md")")"
run_raw "--agent: checkout の .claude/rules を Read" deny "$(main_input Read "$(read_input "${WT}/.claude/rules/dev-flow.md")")"
run_raw "--agent: checkout を Grep" deny "$(main_input Grep "$(jq -cn --arg p "$WT" '{pattern:"x", path:$p}')")"
run_raw "--agent: 相対パスは空の cwd から解決し保存先の外" deny "$(main_input Read "$(read_input "CLAUDE.md")")"
run_raw "--agent: 保存先の diff は許可" silent "$(main_input Read "$(read_input "${D}/pr.diff")")"
run_raw "subagent（agent_id 付き）の checkout Read も deny" deny "$(jq -cn --arg a "$AGENT" --arg cwd "$NEUTRAL" --arg p "${WT}/CLAUDE.md" \
  '{session_id:"s", hook_event_name:"PreToolUse", cwd:$cwd, agent_id:"a1", agent_type:$a, tool_name:"Read", tool_input:{file_path:$p}}')"

echo "[判定できない入力 — deny + exit 0]"
run_raw "JSON が読めない" deny '{"agent_type":"dev-flow:security-reviewer","tool_name":"Read",'
run_raw "JSON が object でない" deny '["dev-flow:security-reviewer"]'
run_raw "tool_input が無い" deny "$(jq -cn --arg cwd "$WT" --arg a "$AGENT" '{agent_type:$a, cwd:$cwd, tool_name:"Read"}')"
run_raw "tool_input が object でない" deny "$(jq -cn --arg cwd "$WT" --arg a "$AGENT" '{agent_type:$a, cwd:$cwd, tool_name:"Read", tool_input:"x"}')"
run_tool "Read: file_path が無い" deny "$AGENT" Read '{}'
run_tool "Read: file_path が文字列でない" deny "$AGENT" Read '{"file_path":42}'
run_tool "Read: file_path が改行を含む" deny "$AGENT" Read "$(jq -cn --arg p "${D}/pr.diff" '{file_path:($p + "\n")}')"
run_tool "対象外の tool 名" deny "$AGENT" Write "$(read_input "${D}/pr.diff")"
run_raw "cwd が無い" deny "$(jq -cn --arg a "$AGENT" --arg p "${D}/pr.diff" '{agent_type:$a, tool_name:"Read", tool_input:{file_path:$p}}')"
run_tool "cwd が存在しない（realpath が失敗）" deny "$AGENT" Read "$(read_input "${D}/pr.diff")" "${WORKDIR}/no-such-wt"
run_raw "realpath コマンドが失敗する" deny "$(jq -cn --arg a "$AGENT" --arg cwd "$WT" --arg p "${D}/pr.diff" '{agent_type:$a, cwd:$cwd, tool_name:"Read", tool_input:{file_path:$p}}')" "$STUB_REALPATH"
run_raw "jq が失敗する" deny "$(jq -cn --arg a "$AGENT" --arg cwd "$WT" --arg p "${D}/pr.diff" '{agent_type:$a, cwd:$cwd, tool_name:"Read", tool_input:{file_path:$p}}')" "$STUB_JQ"

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
