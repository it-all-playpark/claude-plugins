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
#      cwd との比較は大文字小文字を区別しない（macOS の FS は区別しない。区別する FS では deny 側に倒れるだけ）
#
# fail-closed: exit 2 以外の非 0 終了は tool を通すので、security-reviewer の判定中に想定外で終わったら
# EXIT trap が deny を出して exit 0 にする。timeout で kill された場合は防げないので、外部コマンドは
# jq / realpath / grep だけに絞る。
# hook は deny を出力するだけで、ファイルの変更・プロセス操作・外部送信をしない。抜け道（環境変数・フラグ）は作らない。
# deny の理由に入力のパスを埋め込まない（reviewer の session に入力由来の文字列を返さない）。

export LC_ALL=C

DECIDED=0
REVIEWER_AGENT="dev-flow:security-reviewer"
SAVE_DIR_RE='^dev-flow-security-review-[A-Za-z0-9]{6}$'

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

lower() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

CWD_LC=$(lower "$CWD_REAL")
# $1 が cwd の realpath 自身かその配下か（大文字小文字を区別しない）
under_cwd() {
  local p
  p=$(lower "$1")
  [[ $CWD_LC == / || $p == "$CWD_LC" || $p == "$CWD_LC"/* ]]
}

under_cwd "$TARGET_REAL" && emit_deny "対象パスが cwd の配下"

# T 自身から祖先へ上り、保存先の名前のディレクトリ D のうち cwd の配下でないものがあれば許可
d="$TARGET_REAL"
while [[ -n $d && $d != / ]]; do
  if [[ ${d##*/} =~ $SAVE_DIR_RE && -d $d ]] && ! under_cwd "$d"; then
    DECIDED=1
    exit 0
  fi
  d="${d%/*}"
done

emit_deny "対象パスが保存先の配下でない"
