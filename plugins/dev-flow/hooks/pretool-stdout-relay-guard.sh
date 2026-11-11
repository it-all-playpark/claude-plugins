#!/usr/bin/env bash
# PreToolUse(Bash|StructuredOutput) hook: CI 判定の中継（dev-flow:stdout-relay）の Bash を prompt の最終行の `check-ci` 1 単文に、
# 返り値を {"stdout": <その実 stdout の 1 行目と一字一句同じ文字列>} か {"stdout": ""} に縛る
#
# 分類: incentive-structural（中継が PR の文を読める限り誘導を否定できない。sunset しない）。
#
# 目的:
#   pr-iterate の ci-check#i / ci-wait-check#i.k / ci-verify#i.k と dev-flow の ci-check-lite は、check-ci の stdout を
#   stdout-relay に写させる。中継は PR の worktree を cwd に起動し（PR が変えた CLAUDE.md 等を受け取り得る）、誘導されて
#   check-ci を実行せずに件数ごと整った status:"passed" を返し得る。workflow 側の事後の照合ではそれを止められないので、
#   workflow が書いた prompt と harness が記録した実行結果を正にする（_lib/scripts/stdout-relay-bind.mjs）。
#   許す先頭トークンは check-ci だけ（Merge tier の merge-tier-facts の中継など、他の用途はこの hook の対象にしない）。
#
# 判定フロー:
#   1. 入力に `stdout-relay` の文字列が無い → 無出力 exit 0（他の agent・メイン session の高速経路）
#   2. JSON として読めない → deny。`agent_type` が `dev-flow:stdout-relay` でない・tool が Bash / StructuredOutput でない
#      → 無出力 exit 0
#   3. Bash は command が改行・`|` `;` `&` `<` `>` `` ` `` `$` を含む、または先頭トークンが check-ci でないなら deny
#   4. Bash（3 を通ったもの）と StructuredOutput は node の stdout-relay-bind.mjs が通すときだけ通す（Bash は prompt の最終行との
#      完全一致と dangerouslyDisableSandbox の拒否、返り値はキーが stdout だけで、値が実 stdout の 1 行目との一字一句の一致か空文字）。
#      node が無い・判定が読めない → deny
#
# fail-closed: exit 2 以外の非 0 終了は tool を通すので、判定中に想定外で終わったら EXIT trap が deny を出して exit 0 にする。
# hook は deny を出力するだけで、ファイルの変更・プロセス操作・外部送信をしない。抜け道（環境変数・フラグ）は作らない。
# 判定用の記録を別に書かない。deny の理由は guard と bind の固定の文に限る（中継の session に入力由来の文字列を返さない）。

export LC_ALL=C

DECIDED=0
RELAY_AGENT='dev-flow:stdout-relay'
BIND="$(dirname "${BASH_SOURCE[0]}")/../_lib/scripts/stdout-relay-bind.mjs"

emit_deny() {
  DECIDED=1
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$1"
  exit 0
}

on_exit() {
  if [[ $DECIDED -eq 0 ]]; then
    DECIDED=1
    printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"command を判定できない"}}\n'
  fi
  exit 0
}

pass_through() {
  DECIDED=1
  exit 0
}

# stdout-relay-bind.mjs が {allow:true} を返したときだけ通す（node が無い・落ちた・判定が読めないときは deny）。
# deny の理由は bind が返す固定の文（入力由来の文字列を含まない）
bind() {
  local out denied
  command -v node >/dev/null 2>&1 || emit_deny "node を実行できず中継の入出力を確かめられない"
  out=$(node "$BIND" 2>/dev/null <<<"$INPUT") || emit_deny "中継の入出力を確かめられない"
  [[ $(jq -r '.allow == true' 2>/dev/null <<<"$out") == true ]] && pass_through
  # reason は `"` や `\` を含み得るので、文字列に埋め込まず jq に JSON として出させる（中継は理由の文を見て返り値を直す）
  denied=$(jq -c 'if .allow == false and (.reason | type == "string" and . != "") then
      {hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: .reason}}
    else error("bad") end' 2>/dev/null <<<"$out") || emit_deny "中継の入出力を確かめられない"
  [[ -n $denied ]] || emit_deny "中継の入出力を確かめられない"
  DECIDED=1
  printf '%s\n' "$denied"
  exit 0
}

INPUT=$(cat) || INPUT=""

if [[ $INPUT != *stdout-relay* ]]; then
  pass_through
fi

trap on_exit EXIT

jq -e 'type == "object"' >/dev/null 2>&1 <<<"$INPUT" || emit_deny "入力が JSON の object でない"
AGENT_TYPE=$(jq -r '.agent_type | if type == "string" then . else "" end' 2>/dev/null <<<"$INPUT") || emit_deny "agent_type を読めない"
[[ $AGENT_TYPE == "$RELAY_AGENT" ]] || pass_through

TOOL=$(jq -r '.tool_name | if type == "string" then . else "" end' 2>/dev/null <<<"$INPUT") || emit_deny "tool_name を読めない"
[[ $TOOL == StructuredOutput ]] && bind
[[ $TOOL == Bash ]] || pass_through
# 改行を含む command は判定できない扱い（command substitution は末尾の改行を落とすため）
CMD=$(jq -r '.tool_input.command | if type == "string" and (test("\n") | not) then . else error("bad") end' 2>/dev/null <<<"$INPUT") \
  || emit_deny "command を読めない"

ALLOWED="stdout-relay は prompt の最終行の check-ci の単文だけを一字一句そのまま実行できる"
[[ $CMD == *[\|\;\&\<\>\`\$]* ]] && emit_deny "$ALLOWED"
[[ $CMD == "check-ci "* ]] || emit_deny "$ALLOWED"
bind
