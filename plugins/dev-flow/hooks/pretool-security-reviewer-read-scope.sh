#!/usr/bin/env bash
# PreToolUse(Read|Grep|Glob) hook: security-reviewer の読み取りを diff の保存先の配下に限る
#
# 目的:
#   security-reviewer の session の cwd は PR の worktree のまま（workflow の agent() は cwd を受け付けない）。
#   reviewer が worktree のファイルを読むと、PR 側の `.claude/rules` 等が path に応じて session に注入され、
#   攻撃者の文が gate の判定者に届く。agent 定義と prompt の文で頼むだけでは漏れるので、hook で毎回確定で止める。
#   分類: incentive-structural（判定者が攻撃者の書いたファイルを読める限り誘導を否定できない。sunset しない）。
#
# 判定フロー:
#   1. 入力に `security-reviewer` の文字列が無い → 無出力 exit 0（他の agent・メイン session の高速経路）
#   2. JSON として読み、`agent_type` が `dev-flow:security-reviewer` でない（無い・他の agent）→ 無出力 exit 0
#   3. ここから先は security-reviewer。判定できない入力（JSON が読めない・tool_input が無い・path が文字列でない・
#      realpath が失敗する・存在しないパス）は deny
#   4. 対象パス: Read は file_path、Grep / Glob は path（無い・空は deny）。相対パスは入力の cwd から解決する
#      Glob の pattern と Grep の glob は `/` か `~` 始まり、または `/` `{` `}` `,` で区切った要素に `..` があれば deny
#   5. 許可は、対象パスの realpath T が、basename が `dev-flow-security-review-[A-Za-z0-9]{6}` のディレクトリ D
#      （T 自身かその祖先。T が realpath なので D も realpath）の配下で、D と T が入力の cwd の realpath の配下でないときだけ。
#      cwd の配下かは、パスとその各祖先が cwd と同じ inode か（[[ -ef ]]）で判定する（firmlink・大文字小文字の別表記に依らない）
#   6. Read / Grep（中身を読む）は、さらに T の basename が `pr-<dev>-<ino>.diff`（security-review-scope が pr.diff への hard link
#      として作る）で、T が symlink でない通常ファイルで、その dev・ino が名前の値と一致するときだけ許可する（Glob は 5 まで）。
#      保存先の祖先を rename で退避して同じパスに良性の保存先を置くと、置いたファイルは scope の書いたファイルの dev・ino を持てない。
#      確認は読む直前の 1 回なので、確認と Read の間の差し替え（競合）は防げない
#
# fail-closed: exit 2 以外の非 0 終了は tool を通すので、security-reviewer の判定中に想定外で終わったら
# EXIT trap が deny を出して exit 0 にする。timeout で kill された場合は防げないので、外部コマンドは
# jq / realpath / grep / stat だけに絞る（stat は 1 ファイルの metadata だけを読む。中身の hash は取らない）。
# hook は deny を出力するだけで、ファイルの変更・プロセス操作・外部送信をしない。抜け道（環境変数・フラグ）は作らない。
# deny の理由に入力のパスを埋め込まない（reviewer の session に入力由来の文字列を返さない）。

export LC_ALL=C

DECIDED=0
REVIEWER_AGENT="dev-flow:security-reviewer"
SAVE_DIR_RE='^dev-flow-security-review-[A-Za-z0-9]{6}$'
# security-review-scope が pr.diff への hard link として作る、reviewer が読む diff の名前（_lib/security-review.mjs の
# SECURITY_REVIEW_DIFF_NAME_RE と同じ形）。数字は pr.diff の dev と ino
DIFF_NAME_RE='^pr-([0-9]{1,30})-([0-9]{1,30})\.diff$'

emit_deny() {
  DECIDED=1
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"security-reviewer は diff の保存先（dev-flow-security-review-XXXXXX）の配下だけを Read / Grep / Glob できる（%s）。PR の worktree は読まず、prompt の diff_path を読め"}}\n' "$1"
  exit 0
}

on_exit() {
  if [[ $DECIDED -eq 0 ]]; then
    DECIDED=1
    printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"security-reviewer の読み取り範囲を判定できない"}}\n'
  fi
  exit 0
}

pass_through() {
  DECIDED=1
  exit 0
}

INPUT=$(cat) || INPUT=""

if ! grep -qF 'security-reviewer' <<<"$INPUT"; then
  pass_through
fi

trap on_exit EXIT

if ! jq -e 'type == "object"' >/dev/null 2>&1 <<<"$INPUT"; then
  emit_deny "入力が JSON の object でない"
fi

AGENT_TYPE=$(jq -r '.agent_type | if type == "string" then . else "" end' 2>/dev/null <<<"$INPUT") || emit_deny "agent_type を読めない"
if [[ $AGENT_TYPE != "$REVIEWER_AGENT" ]]; then
  pass_through
fi

# 文字列で改行を含まない値だけを取り出す（command substitution は末尾の改行を落とすため、改行入りは判定できない扱い）
# 引数: jq の path 式。キーが無い・null のときは空文字列、文字列以外は失敗
read_str() {
  jq -r "($1) as \$v | if \$v == null then \"\" elif (\$v | type) == \"string\" and (\$v | test(\"\\n\") | not) then \$v else error(\"bad\") end" 2>/dev/null <<<"$INPUT"
}

jq -e '.tool_input | type == "object"' >/dev/null 2>&1 <<<"$INPUT" || emit_deny "tool_input が無い"

TOOL=$(read_str '.tool_name') || emit_deny "tool_name を読めない"
CWD=$(read_str '.cwd') || emit_deny "cwd を読めない"
[[ $CWD == /* ]] || emit_deny "cwd が絶対パスでない"

case "$TOOL" in
  Read)
    TARGET=$(read_str '.tool_input.file_path') || emit_deny "file_path を読めない"
    ;;
  Grep)
    TARGET=$(read_str '.tool_input.path') || emit_deny "path を読めない"
    PATTERN=$(read_str '.tool_input.glob') || emit_deny "glob を読めない"
    ;;
  Glob)
    TARGET=$(read_str '.tool_input.path') || emit_deny "path を読めない"
    PATTERN=$(read_str '.tool_input.pattern') || emit_deny "pattern を読めない"
    ;;
  *)
    emit_deny "対象外の tool"
    ;;
esac

[[ -n $TARGET ]] || emit_deny "対象パスが無い"

# Glob の pattern / Grep の glob が保存先の外へ出る形（絶対パス・~・.. の要素。brace 展開の要素も見る）
if [[ -n ${PATTERN:-} ]]; then
  [[ $PATTERN == /* || $PATTERN == '~'* ]] && emit_deny "pattern が絶対パス"
  IFS='/{},' read -r -a PARTS <<<"$PATTERN" || emit_deny "pattern を分解できない"
  for part in "${PARTS[@]}"; do
    [[ $part == ".." ]] && emit_deny "pattern が .. を含む"
  done
fi

# 存在するパスの realpath。存在しないパス・realpath の失敗は空で返す（GNU realpath は末尾の要素が無くても成功するので先に -e を見る）
resolve() {
  local p="$1" r
  [[ -e $p ]] || return 1
  r=$(realpath -- "$p" 2>/dev/null) || return 1
  [[ $r == /* && -e $r ]] || return 1
  printf '%s' "$r"
}

[[ $TARGET == /* ]] || TARGET="$CWD/$TARGET"

CWD_REAL=$(resolve "$CWD") || emit_deny "cwd の realpath を取れない"
TARGET_REAL=$(resolve "$TARGET") || emit_deny "対象パスが存在しないか realpath を取れない"

# $1（realpath）自身かその祖先のどれかが cwd と同じディレクトリか。文字列ではなく dev+inode（[[ -ef ]]）で比べる:
# macOS の firmlink（/System/Volumes/Data/Users ↔ /Users）は realpath が正規化しないので、
# 文字列の prefix 比較だと別名の表記 1 つで cwd 配下の判定を抜けられる。大文字小文字の違いも同じ inode に解決される
under_cwd() {
  local a="$1"
  while :; do
    [[ $a -ef $CWD_REAL ]] && return 0
    [[ -z $a || $a == / ]] && return 1
    a="${a%/*}"
    [[ -n $a ]] || a=/
  done
}

under_cwd "$TARGET_REAL" && emit_deny "対象パスが cwd の配下"

# T 自身から祖先へ上り、保存先の名前のディレクトリ D のうち cwd の配下でないものを探す
in_save_dir=0
d="$TARGET_REAL"
while [[ -n $d && $d != / ]]; do
  if [[ ${d##*/} =~ $SAVE_DIR_RE && -d $d ]] && ! under_cwd "$d"; then
    in_save_dir=1
    break
  fi
  d="${d%/*}"
done
[[ $in_save_dir -eq 1 ]] || emit_deny "対象パスが保存先の配下でない"

# Glob はファイル名の一覧だけを返すので、保存先の配下なら許可
[[ $TOOL == Glob ]] && pass_through

# $1 の dev と ino（symlink は辿らない）を "<dev> <ino>" で返す。GNU（-c）と BSD（-f）の stat のどちらでも取る
file_id() {
  local out
  out=$(stat -c '%d %i' -- "$1" 2>/dev/null) || out=$(stat -f '%d %i' -- "$1" 2>/dev/null) || return 1
  [[ $out =~ ^[0-9]+\ [0-9]+$ ]] || return 1
  printf '%s' "$out"
}

# Read / Grep は中身を読むので、security-review-scope が書いた diff（pr-<dev>-<ino>.diff）が今その名前の dev・ino のファイルの
# ときだけ許可する。保存先の祖先を退避して同じパスに良性の保存先を置くと、置いたファイルは scope の書いたファイルと同じ dev・ino を
# 持てない（祖先の ctime は無関係な一時ファイルでも変わるので、review の後の照合では見分けられない）
[[ ${TARGET_REAL##*/} =~ $DIFF_NAME_RE ]] || emit_deny "対象が保存先の diff（pr-<dev>-<ino>.diff）でない"
EXPECTED_ID="${BASH_REMATCH[1]} ${BASH_REMATCH[2]}"
[[ -f $TARGET_REAL && ! -L $TARGET_REAL ]] || emit_deny "保存先の diff が通常ファイルでない"
ACTUAL_ID=$(file_id "$TARGET_REAL") || emit_deny "保存先の diff の dev・ino を取れない"
[[ $ACTUAL_ID == "$EXPECTED_ID" ]] || emit_deny "保存先の diff が security-review-scope の書いたファイルでない"

DECIDED=1
exit 0
