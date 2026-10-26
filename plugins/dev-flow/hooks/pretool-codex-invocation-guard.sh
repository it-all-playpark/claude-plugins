#!/usr/bin/env bash
# PreToolUse(Bash|StructuredOutput) hook: security review の中継（dev-flow:security-codex-relay）の Bash を固定の 6 形に限り
# （issue #1087）、Bash と返り値をその spawn の workflow の prompt と実 stdout に縛る（issue #1116）
#
# 目的:
#   pr-iterate の Codex 経路は、security-scope・prep・codex の起動・result.json の判定を security-codex-relay に写させる。中継は PR の
#   worktree を cwd に起動し（PR が変えた CLAUDE.md 等を受け取り得る）、codex の出力や指摘の本文（Codex が diff を引用した文）を読む
#   round もあるので、誘導されて別のコマンド（result.json の上書き・flag を変えた codex の起動）を実行し得る。文字列の一致で
#   「危ないコマンド」を探すやり方は、引用の分割（cod''ex）・バックスラッシュ・$ 展開・glob で語を組み立てられるので止められない。
#   中継には allowlist（固定の形で、可変部は保存先・worktree のパスと sha・PR 番号・base branch だけ）を当て、それ以外は語を見ずに
#   全部拒否する。allowlist の形のまま引数を差し替える（base を head に・前回の保存先に）・コマンドを実行せずに clear の JSON を返す、
#   は形では止められないので、_lib/scripts/security-relay-bind.mjs が transcript の prompt と実 stdout で縛る。
#   分類: incentive-structural（中継が攻撃者の文を読める限り誘導を否定できない。sunset しない）。
#
#   守る範囲は「PR の文に誘導された中継」まで。sandbox に残った PR のプロセスによる保存先の書き換えや PATH の前方への同名ファイルの
#   設置は守る範囲の外（dev-flow/references/security-review.md の「守る要件と境界」）なので、パスの実体や bare 名の解決先は確かめない。
#
# 判定フロー:
#   1. 入力に `security-codex-relay` の文字列が無い → 無出力 exit 0（他の agent・メイン session の高速経路）
#   2. JSON として読めない → deny。`agent_type` が `dev-flow:security-codex-relay` でない・tool が Bash / StructuredOutput でない
#      → 無出力 exit 0
#   3. Bash は command が次の形のどれかと完全に一致するときだけ 4 へ進む（改行・余分な空白・引用符・shell の記号を含む形は一致しない）:
#        gh pr view <pr> --repo <owner>/<name> --json baseRefOid,headRefOid
#        git fetch origin <base> refs/pull/<pr>/head
#        security-review-scope <W> <sha> <sha> --save-diff
#        security-review-codex-prep <D> <sha> <pr>[ --verify-from <D>]
#        codex exec -s read-only --ephemeral --ignore-user-config --ignore-rules --skip-git-repo-check -C <D>/cwd
#          -c web_search="disabled" --disable shell_tool --disable unified_exec --disable apps --disable browser_use --disable computer_use
#          -c model_instructions_file=<D>/prompt.md --output-schema <D>/schema.json -o <D>/result.json "<固定文>"
#        （codex は実際は 1 行。_lib/security-review.mjs の codexSecurityReviewCommand と同じ — 起動形を変えるときは両方を同時に変える）
#        security-review-codex-result <D> <sha>[ --issues]
#      <D> は basename が dev-flow-security-review-XXXXXX の、`.` / `..` の要素を持たない [A-Za-z0-9._-] だけの絶対パス。
#      <W> は `.` / `..` の要素を持たない [A-Za-z0-9._-] だけの絶対パス、<base> は同じ文字の `/` 区切り。
#      <sha> は 40 桁の hex、<pr> は数字
#   4. Bash（3 を通ったもの）と StructuredOutput は node の security-relay-bind.mjs が通すときだけ通す（Bash は prompt の最終行との
#      完全一致、返り値は実 stdout の JSON か prompt の失敗時の JSON との一致）。node が無い・判定が読めない → deny
#
# fail-closed: exit 2 以外の非 0 終了は tool を通すので、判定中に想定外で終わったら EXIT trap が deny を出して exit 0 にする。
# hook は deny を出力するだけで、ファイルの変更・プロセス操作・外部送信をしない。抜け道（環境変数・フラグ）は作らない。
# deny の理由に入力の文字列を埋め込まない（中継の session に入力由来の文字列を返さない）。

export LC_ALL=C

DECIDED=0
RELAY_AGENT='dev-flow:security-codex-relay'
D_RE='(/[A-Za-z0-9._-]+)*/dev-flow-security-review-[A-Za-z0-9]{6}'
SHA_RE='[0-9a-fA-F]{40}'
PREP_RE="^security-review-codex-prep (${D_RE}) ${SHA_RE} [1-9][0-9]*( --verify-from (${D_RE}))?$"
RESULT_RE="^security-review-codex-result (${D_RE}) ${SHA_RE}( --issues)?$"
CODEX_HEAD_RE="^codex exec -s read-only --ephemeral --ignore-user-config --ignore-rules --skip-git-repo-check -C (${D_RE})/cwd "
CODEX_PROMPT='Run the security review described in your instructions and reply only with the JSON object defined by the output schema.'
W_RE='(/[A-Za-z0-9._-]+)+'
REF_RE='[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*'
SCOPE_RE="^security-review-scope (${W_RE}) ${SHA_RE} ${SHA_RE} --save-diff$"
PR_HEAD_RE="^gh pr view [1-9][0-9]* --repo [A-Za-z0-9._-]+/[A-Za-z0-9._-]+ --json baseRefOid,headRefOid$"
FETCH_RE="^git fetch origin (${REF_RE}) refs/pull/[1-9][0-9]*/head$"
BIND="$(dirname "${BASH_SOURCE[0]}")/../_lib/scripts/security-relay-bind.mjs"

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

# パスが `.` / `..` の要素を持たないか
plain_path() {
  [[ $1/ != */./* && $1/ != */../* ]]
}

# security-relay-bind.mjs が {allow:true} を返したときだけ通す（node が無い・落ちた・判定が読めないときは deny）。
# deny の理由は bind が返す固定の文（入力由来の文字列を含まない）
bind() {
  local out reason
  command -v node >/dev/null 2>&1 || emit_deny "node を実行できず中継の入出力を確かめられない"
  out=$(node "$BIND" 2>/dev/null <<<"$INPUT") || emit_deny "中継の入出力を確かめられない"
  [[ $(jq -r '.allow == true' 2>/dev/null <<<"$out") == true ]] && pass_through
  reason=$(jq -r '.reason | if type == "string" and (test("[\"\\\\]") | not) then . else "" end' 2>/dev/null <<<"$out") || reason=""
  emit_deny "${reason:-中継の入出力を確かめられない}"
}

INPUT=$(cat) || INPUT=""

if [[ $INPUT != *security-codex-relay* ]]; then
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

ALLOWED="security-codex-relay は prompt が指定した固定のコマンドだけを一字一句そのまま実行できる"

if [[ $CMD =~ $SCOPE_RE ]]; then
  plain_path "${BASH_REMATCH[1]}" || emit_deny "$ALLOWED"
  bind
fi

[[ $CMD =~ $PR_HEAD_RE ]] && bind

if [[ $CMD =~ $FETCH_RE ]]; then
  plain_path "/${BASH_REMATCH[1]}" || emit_deny "$ALLOWED"
  bind
fi

if [[ $CMD =~ $PREP_RE ]]; then
  plain_path "${BASH_REMATCH[1]}" || emit_deny "$ALLOWED"
  [[ -z ${BASH_REMATCH[4]} ]] || plain_path "${BASH_REMATCH[4]}" || emit_deny "$ALLOWED"
  bind
fi

if [[ $CMD =~ $RESULT_RE ]]; then
  plain_path "${BASH_REMATCH[1]}" || emit_deny "$ALLOWED"
  bind
fi

if [[ $CMD =~ $CODEX_HEAD_RE ]]; then
  d=${BASH_REMATCH[1]}
  plain_path "$d" || emit_deny "$ALLOWED"
  expected="codex exec -s read-only --ephemeral --ignore-user-config --ignore-rules --skip-git-repo-check -C ${d}/cwd -c web_search=\"disabled\" --disable shell_tool --disable unified_exec --disable apps --disable browser_use --disable computer_use -c model_instructions_file=${d}/prompt.md --output-schema ${d}/schema.json -o ${d}/result.json \"${CODEX_PROMPT}\""
  [[ $CMD == "$expected" ]] && bind
fi

emit_deny "$ALLOWED"
