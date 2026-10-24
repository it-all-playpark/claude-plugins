#!/usr/bin/env bash
# PreToolUse(Bash) hook: dev-flow の agent による codex の起動を、Codex 経路の security review の固定形だけに限る（issue #1087）
#
# 目的:
#   pr-iterate の Codex 経路は、workflow が組み立てた `codex exec` を dev-runner-haiku-ro に一字一句写させる。中継の agent は
#   PR の worktree を cwd に起動し、PR が書いた指示ファイルや codex の出力に誘導され得るので、フラグを足す（sandbox を
#   workspace-write / danger-full-access にする・--dangerously-* で承認と sandbox を外す・-c で shell や web 検索を戻す）、
#   作業ディレクトリを PR の worktree にする（cwd の AGENTS.md を読ませる）、指示ファイル・schema・出力を保存先の外に向ける、
#   といった書き換えを prompt の文で頼むだけでは止められない。hook で毎回確定で止める。
#   分類: incentive-structural（中継が攻撃者の文を読める限り誘導を否定できない。sunset しない）。
#
# 判定フロー:
#   1. 入力に `codex` の文字列が無い → 無出力 exit 0（高速経路）
#   2. JSON として読めない → deny。`agent_type` が `dev-flow:` で始まらない（メイン session・他 plugin の agent）→ 無出力 exit 0
#   3. command に codex を起動しうる語（前後が英数字・`_` `.` `-` でない `codex`）が無い → 無出力 exit 0
#   4. ここから先は dev-flow の agent による codex の起動。command が次の形と完全に一致するときだけ通す（_lib/security-review.mjs の
#      codexSecurityReviewCommand と同じ。起動形を変えるときは両方を同時に変える）:
#        codex exec -s read-only --ephemeral --ignore-user-config --ignore-rules --skip-git-repo-check -C <C>
#        -c web_search="disabled" --disable shell_tool --disable unified_exec --disable apps --disable browser_use
#        --disable computer_use -c model_instructions_file=<D>/prompt.md --output-schema <D>/schema.json -o <D>/result.json "<固定文>"
#      （実際は 1 行）。<C> は basename が `dev-flow-codex-cwd-XXXXXX` の空の実ディレクトリ、<D> は basename が
#      `dev-flow-security-review-XXXXXX` の実ディレクトリで prompt.md・schema.json を実ファイルとして持ち result.json を持たない
#      （symlink の result.json を通じて保存先の外へ書かせない）。どちらも空白・引用符・shell の記号を含まない絶対パスで、
#      `.` / `..` の要素を持たず、入力の cwd の配下でない。判定できない入力（command が文字列でない・改行を含む・cwd が無い・
#      realpath が失敗する）は deny
#
# fail-closed: exit 2 以外の非 0 終了は tool を通すので、判定中に想定外で終わったら EXIT trap が deny を出して exit 0 にする。
# hook は deny を出力するだけで、ファイルの変更・プロセス操作・外部送信をしない。抜け道（環境変数・フラグ）は作らない。
# deny の理由に入力の文字列を埋め込まない（中継の session に入力由来の文字列を返さない）。

export LC_ALL=C

DECIDED=0
CODEX_PROMPT='Run the security review described in your instructions and reply only with the JSON object defined by the output schema.'
SAVE_DIR_RE='^dev-flow-security-review-[A-Za-z0-9]{6}$'
CWD_DIR_RE='^dev-flow-codex-cwd-[A-Za-z0-9]{6}$'
PATH_RE='^(/[A-Za-z0-9._-]+)+$'
CODEX_WORD_RE='(^|[^A-Za-z0-9_.-])codex([^A-Za-z0-9_.-]|$)'

emit_deny() {
  DECIDED=1
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"dev-flow の agent は codex を Codex 経路の security review の固定形でだけ起動できる（%s）。prompt のコマンド行を一字一句そのまま実行せよ。文字列の検索は Grep tool を使う"}}\n' "$1"
  exit 0
}

on_exit() {
  if [[ $DECIDED -eq 0 ]]; then
    DECIDED=1
    printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"codex の起動形を判定できない"}}\n'
  fi
  exit 0
}

pass_through() {
  DECIDED=1
  exit 0
}

INPUT=$(cat) || INPUT=""

if ! grep -qF 'codex' <<<"$INPUT"; then
  pass_through
fi

trap on_exit EXIT

if ! jq -e 'type == "object"' >/dev/null 2>&1 <<<"$INPUT"; then
  emit_deny "入力が JSON の object でない"
fi

AGENT_TYPE=$(jq -r '.agent_type | if type == "string" then . else "" end' 2>/dev/null <<<"$INPUT") || emit_deny "agent_type を読めない"
if [[ $AGENT_TYPE != dev-flow:* ]]; then
  pass_through
fi

# 文字列で改行を含まない値だけを取り出す（command substitution は末尾の改行を落とすため、改行入りは判定できない扱い）
read_str() {
  jq -r "($1) as \$v | if \$v == null then \"\" elif (\$v | type) == \"string\" and (\$v | test(\"\\n\") | not) then \$v else error(\"bad\") end" 2>/dev/null <<<"$INPUT"
}

TOOL=$(read_str '.tool_name') || emit_deny "tool_name を読めない"
[[ $TOOL == "Bash" ]] || pass_through
CMD=$(read_str '.tool_input.command') || emit_deny "command を読めない"
[[ $CMD =~ $CODEX_WORD_RE ]] || pass_through

# ここから先は dev-flow の agent による codex の起動
CWD=$(read_str '.cwd') || emit_deny "cwd を読めない"
[[ $CWD == /* ]] || emit_deny "cwd が絶対パスでない"

[[ $CMD =~ \ -C\ ([^ ]+)\  ]] || emit_deny "-C が無い"
C="${BASH_REMATCH[1]}"
[[ $CMD =~ \ -c\ model_instructions_file=([^ ]+)/prompt\.md\  ]] || emit_deny "指示ファイルが保存先の prompt.md でない"
D="${BASH_REMATCH[1]}"

EXPECTED="codex exec -s read-only --ephemeral --ignore-user-config --ignore-rules --skip-git-repo-check -C ${C} -c web_search=\"disabled\" --disable shell_tool --disable unified_exec --disable apps --disable browser_use --disable computer_use -c model_instructions_file=${D}/prompt.md --output-schema ${D}/schema.json -o ${D}/result.json \"${CODEX_PROMPT}\""
[[ $CMD == "$EXPECTED" ]] || emit_deny "起動形が固定形と一致しない（フラグの過不足・schema / 出力が保存先の外）"

# 空白・引用符・shell の記号を含まず、`.` / `..` の要素を持たない絶対パスで、basename が $2 の形
plain_path() {
  local p="$1" name_re="$2" seg
  [[ $p =~ $PATH_RE ]] || return 1
  IFS='/' read -r -a SEGS <<<"${p#/}" || return 1
  for seg in "${SEGS[@]}"; do
    [[ $seg == "." || $seg == ".." ]] && return 1
  done
  [[ ${p##*/} =~ $name_re ]]
}

plain_path "$C" "$CWD_DIR_RE" || emit_deny "-C が mkdtemp の形（dev-flow-codex-cwd-XXXXXX）でない"
plain_path "$D" "$SAVE_DIR_RE" || emit_deny "保存先が mkdtemp の形（dev-flow-security-review-XXXXXX）でない"

[[ -d $C && ! -L $C ]] || emit_deny "-C が実ディレクトリでない"
shopt -s nullglob dotglob
C_ENTRIES=("$C"/*)
shopt -u nullglob dotglob
((${#C_ENTRIES[@]} == 0)) || emit_deny "-C が空でない"

[[ -d $D && ! -L $D ]] || emit_deny "保存先が実ディレクトリでない"
[[ -f "$D/prompt.md" && ! -L "$D/prompt.md" ]] || emit_deny "保存先に prompt.md が無い"
[[ -f "$D/schema.json" && ! -L "$D/schema.json" ]] || emit_deny "保存先に schema.json が無い"
[[ ! -e "$D/result.json" && ! -L "$D/result.json" ]] || emit_deny "保存先に result.json が既にある"

# 存在するパスの realpath（存在しない・失敗は空で返す）
resolve() {
  local p="$1" r
  [[ -e $p ]] || return 1
  r=$(realpath -- "$p" 2>/dev/null) || return 1
  [[ $r == /* && -e $r ]] || return 1
  printf '%s' "$r"
}

CWD_REAL=$(resolve "$CWD") || emit_deny "cwd の realpath を取れない"
C_REAL=$(resolve "$C") || emit_deny "-C の realpath を取れない"
D_REAL=$(resolve "$D") || emit_deny "保存先の realpath を取れない"

# $1（realpath）自身かその祖先のどれかが cwd と同じディレクトリか（dev+inode で比べる — firmlink・大文字小文字の別表記に依らない）
under_cwd() {
  local a="$1"
  while :; do
    [[ $a -ef $CWD_REAL ]] && return 0
    [[ -z $a || $a == / ]] && return 1
    a="${a%/*}"
    [[ -n $a ]] || a=/
  done
}

under_cwd "$C_REAL" && emit_deny "-C が cwd の配下"
under_cwd "$D_REAL" && emit_deny "保存先が cwd の配下"

DECIDED=1
exit 0
