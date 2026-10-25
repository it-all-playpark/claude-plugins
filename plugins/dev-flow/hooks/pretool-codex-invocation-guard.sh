#!/usr/bin/env bash
# PreToolUse(Bash) hook: security review の中継（dev-flow:security-codex-relay）の Bash を固定の 4 形に限り、
# 他の dev-flow の agent には codex と review の保存先を触らせない（issue #1087 / #1095）
#
# 目的:
#   pr-iterate の Codex 経路は、prep・codex の起動・result.json の判定を security-codex-relay に写させる。中継は PR の worktree を cwd に
#   起動し、指摘の本文（Codex が diff を引用した文）を読む round もあるので、誘導されて別のコマンド（result.json の上書き・
#   フラグを足した codex の起動）を実行し得る。文字列の一致で「危ないコマンド」を探すやり方は、引用の分割（cod''ex）・
#   バックスラッシュ・$ 展開・glob で語を組み立てられるので止められない。中継の agent には allowlist（先頭トークンが固定の bare 名で、
#   引数が mkdtemp の形のパスと sha だけ）を当て、それ以外は語を見ずに全部拒否する。codex は中継が先頭トークン codex の固定形の単文で
#   起動する（sandbox の外で通信できるのは先頭が codex の単文だけで、script の中から起動すると通信が拒否される）。
#   分類: incentive-structural（中継が攻撃者の文を読める限り誘導を否定できない。sunset しない）。
#
# 判定フロー:
#   1. 入力に `dev-flow:` の文字列が無い → 無出力 exit 0（高速経路。dev-flow の agent の入力は agent_type に必ず含む）
#   2. JSON として読めない → deny。`agent_type` が `dev-flow:` で始まらない（メイン session・他 plugin の agent）→ 無出力 exit 0。
#      tool が Bash でない → 無出力 exit 0
#   3. agent_type が dev-flow:security-codex-relay → command が次のどれかと完全に一致するときだけ通す（改行・余分な空白・
#      引用符・shell の記号を含む形は一致しない）:
#        security-review-codex-prep <D> <sha> <pr>[ --verify-from <D>/out/<O>]
#        codex exec -s read-only --ephemeral --ignore-user-config --ignore-rules --skip-git-repo-check -C <C>
#          -c web_search="disabled" --disable shell_tool --disable unified_exec --disable apps --disable browser_use
#          --disable computer_use -c model_instructions_file=<D>/prompt.md --output-schema <D>/schema.json -o <D>/out/<O>/result.json "<固定文> <N>"
#        （codex は実際は 1 行。_lib/security-review.mjs の codexSecurityReviewCommand と同じ — 起動形を変えるときは両方を同時に変える）
#        security-review-codex-result <D> <sha> <N> <C> <O> <h> <h> <h>[ --issues]
#        security-review-diff-check <D> <h> <h>（Claude 経路の review の後の pr.diff の照合）
#      <D> は basename が dev-flow-security-review-XXXXXX、<C> は dev-flow-codex-cwd-XXXXXX の、`.` / `..` の要素を持たない
#      [A-Za-z0-9._-] だけの絶対パス。<sha> は 40 桁の hex、<pr> は数字、<N> は prep が返した nonce・<O> は prep が保存先の中に
#      作った出力の置き場の名前（どちらも 32 桁の小文字 hex）、<h> は prep / scope が返した sha256・statDigest（64 桁の小文字 hex）。
#      prep / result / diff-check のパスの実体は各 script が確かめる。
#      codex の形は hook がパスの実体も確かめる: <C> は prep の空の .git（通常ファイル）だけを持つ実ディレクトリ、<D> は prompt.md・
#      schema.json を実ファイルとして持つ実ディレクトリ、<D>/out/<O> は result.json を持たない実ディレクトリ（symlink の result.json を通じて保存先の外へ書かせない・先に
#      置かれた result.json を codex の結果として読ませない）で、<C> と <D> は入力の cwd（PR の worktree）の配下でない。
#      起動される codex の実体も確かめる: bash と同じ順で PATH をたどって最初に見つかる実行可能な通常ファイルの realpath が、
#      解決できない・PATH の相対パスか空の要素から解決された・入力の cwd・$TMPDIR・/tmp・/private/tmp の配下なら deny
#      （中継の codex は sandbox の外で動くので、PR のコードが sandbox の中から置いた codex を起動させない。PATH は hook の
#      環境のもの）
#   4. それ以外の dev-flow の agent → 引用符とバックスラッシュを外した command を `;` `&` `|` `(` `)` `{` `}` と改行で単文に分け、
#      各単文の先頭から予約語（then / do / ! 等）・前置コマンド（env / exec / command / nohup / timeout 等）とその option・
#      `NAME=value` の代入を読み飛ばした最初のトークンが `codex` か `*/codex` なら deny。保存先・作業ディレクトリの名前（dev-flow-security-review- /
#      dev-flow-codex-cwd-）を含む command も deny。それ以外は通す。引数の中の codex の語（`grep codex`・
#      `gh pr create --title "… codex …"`）では止めない。
#      この agent たちは任意の Bash を持つので、ここは誤って codex や保存先を触ることを止める多層防御であり保証ではない —
#      Codex の review の完全性は 3 の allowlist と、round の間に他の agent を起動しない workflow の順序で持つ
#
# fail-closed: exit 2 以外の非 0 終了は tool を通すので、判定中に想定外で終わったら EXIT trap が deny を出して exit 0 にする。
# hook は deny を出力するだけで、ファイルの変更・プロセス操作・外部送信をしない。抜け道（環境変数・フラグ）は作らない。
# deny の理由に入力の文字列を埋め込まない（中継の session に入力由来の文字列を返さない）。

export LC_ALL=C

DECIDED=0
RELAY_AGENT='dev-flow:security-codex-relay'
SEG='/[A-Za-z0-9._-]+'
D_RE="(${SEG})*/dev-flow-security-review-[A-Za-z0-9]{6}"
C_RE="(${SEG})*/dev-flow-codex-cwd-[A-Za-z0-9]{6}"
SHA_RE='[0-9a-fA-F]{40}'
OUT_RE='[0-9a-f]{32}'
PREP_RE="^security-review-codex-prep ${D_RE} ${SHA_RE} [0-9]+( --verify-from ${D_RE}/out/${OUT_RE})?$"
NONCE_RE='[0-9a-f]{32}'
CODEX_PROMPT='Run the security review described in your instructions and reply only with the JSON object defined by the output schema. Set its nonce field to'
SHA256_RE='[0-9a-f]{64}'
RESULT_RE="^security-review-codex-result ${D_RE} ${SHA_RE} ${NONCE_RE} ${C_RE} ${OUT_RE} ${SHA256_RE} ${SHA256_RE} ${SHA256_RE}( --issues)?$"
DIFF_CHECK_RE="^security-review-diff-check ${D_RE} ${SHA256_RE} ${SHA256_RE}$"
DIR_NAME_RE='dev-flow-security-review-|dev-flow-codex-cwd-'

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

# 中継の codex の起動が固定形と完全に一致し、パスの実体が条件を満たすか。満たさなければ deny する
check_codex() {
  local c d o n p s cwd cwd_real a expected
  [[ $CMD =~ \ -C\ ([^ ]+)\  ]] || emit_deny "codex の起動形が固定形と一致しない"
  c="${BASH_REMATCH[1]}"
  [[ $CMD =~ \ -c\ model_instructions_file=([^ ]+)/prompt\.md\  ]] || emit_deny "codex の起動形が固定形と一致しない"
  d="${BASH_REMATCH[1]}"
  local o_re=' -o [^ ]+/out/([^ /]+)/result\.json '
  [[ $CMD =~ $o_re ]] || emit_deny "codex の起動形が固定形と一致しない"
  o="${BASH_REMATCH[1]}"
  [[ $CMD =~ \ ([^ \"]+)\"$ ]] || emit_deny "codex の起動形が固定形と一致しない"
  n="${BASH_REMATCH[1]}"
  [[ $c =~ ^${C_RE}$ && $d =~ ^${D_RE}$ ]] || emit_deny "codex の作業ディレクトリ・保存先が mkdtemp の形でない"
  [[ $o =~ ^${OUT_RE}$ ]] || emit_deny "codex の出力の置き場が prep の作る形でない"
  [[ $n =~ ^${NONCE_RE}$ ]] || emit_deny "codex の prompt の nonce が固定の形でない"
  expected="codex exec -s read-only --ephemeral --ignore-user-config --ignore-rules --skip-git-repo-check -C ${c} -c web_search=\"disabled\" --disable shell_tool --disable unified_exec --disable apps --disable browser_use --disable computer_use -c model_instructions_file=${d}/prompt.md --output-schema ${d}/schema.json -o ${d}/out/${o}/result.json \"${CODEX_PROMPT} ${n}\""
  [[ $CMD == "$expected" ]] || emit_deny "codex の起動形が固定形と一致しない（フラグの過不足・schema / 出力が保存先の外）"
  for p in "$c" "$d"; do
    IFS='/' read -r -a SEGS <<<"${p#/}"
    for s in "${SEGS[@]}"; do
      [[ $s == "." || $s == ".." ]] && emit_deny "security-codex-relay のパスに . / .. の要素がある"
    done
  done
  [[ -d $c && ! -L $c ]] || emit_deny "codex の作業ディレクトリが実ディレクトリでない"
  shopt -s nullglob dotglob
  local entries=("$c"/*)
  shopt -u nullglob dotglob
  # -C は prep の空の .git（codex の project root を -C に止める）だけを持つ
  ((${#entries[@]} == 1)) && [[ ${entries[0]} == "$c/.git" && -f "$c/.git" && ! -L "$c/.git" && ! -s "$c/.git" ]] \
    || emit_deny "codex の作業ディレクトリが prep の空の .git だけを持つ形でない"
  [[ -d $d && ! -L $d ]] || emit_deny "保存先が実ディレクトリでない"
  [[ -f "$d/prompt.md" && ! -L "$d/prompt.md" ]] || emit_deny "保存先に prompt.md が無い"
  [[ -f "$d/schema.json" && ! -L "$d/schema.json" ]] || emit_deny "保存先に schema.json が無い"
  [[ -d "$d/out" && ! -L "$d/out" && -d "$d/out/$o" && ! -L "$d/out/$o" ]] || emit_deny "保存先に出力の置き場が無い"
  [[ ! -e "$d/out/$o/result.json" && ! -L "$d/out/$o/result.json" ]] || emit_deny "出力の置き場に result.json が既にある"
  cwd=$(jq -r '.cwd | if type == "string" then . else "" end' 2>/dev/null <<<"$INPUT") || emit_deny "cwd を読めない"
  [[ $cwd == /* ]] || emit_deny "cwd が絶対パスでない"
  cwd_real=$(realpath -- "$cwd" 2>/dev/null) || emit_deny "cwd の realpath を取れない"
  # 自身かその祖先のどれかが cwd と同じディレクトリか（dev+inode で比べる — firmlink・大文字小文字の別表記に依らない）
  for p in "$c" "$d"; do
    a=$(realpath -- "$p" 2>/dev/null) || emit_deny "codex の作業ディレクトリ・保存先の realpath を取れない"
    while :; do
      [[ $a -ef $cwd_real ]] && emit_deny "codex の作業ディレクトリ・保存先が cwd の配下"
      [[ -z $a || $a == / ]] && break
      a="${a%/*}"
      [[ -n $a ]] || a=/
    done
  done
  check_codex_binary "$cwd" "$cwd_real"
}

# 絶対パス $1 が、実在するディレクトリ $2 自身かその配下か（祖先を dev+inode で比べる）
is_under() {
  local a="$1" root="$2"
  [[ -n $root && -d $root ]] || return 1
  while :; do
    [[ $a -ef $root ]] && return 0
    [[ -z $a || $a == / ]] && return 1
    a="${a%/*}"
    [[ -n $a ]] || a=/
  done
}

# 中継が bare 名で起動する codex の実体（sandbox の外で動く）が、PR のコードの置ける場所に解決されないか。
# bash の検索と同じく PATH の要素を先頭から見て、最初に見つかる実行可能な通常ファイルを起動される codex とする。
# 相対パス・空の要素は Bash tool の cwd（入力の cwd = PR の worktree）から解決される
check_codex_binary() {
  local cwd="$1" cwd_real="$2" rest="${PATH-}:" seg f="" from_relative=0 real root
  while [[ -n $rest ]]; do
    seg="${rest%%:*}"
    rest="${rest#*:}"
    if [[ $seg == /* ]]; then
      f="$seg/codex"
    else
      f="$cwd/${seg:+$seg/}codex"
    fi
    if [[ -f $f && -x $f ]]; then
      [[ $seg == /* ]] || from_relative=1
      break
    fi
    f=""
  done
  [[ -n $f ]] || emit_deny "codex を PATH 上で解決できない"
  ((from_relative == 0)) || emit_deny "codex が PATH の相対パス・空の要素から解決される"
  real=$(realpath -- "$f" 2>/dev/null) || emit_deny "codex の実体の realpath を取れない"
  is_under "$real" "$cwd_real" && emit_deny "codex の実体が cwd の配下"
  for root in "${TMPDIR-}" /tmp /private/tmp; do
    is_under "$real" "$root" && emit_deny "codex の実体が一時ディレクトリの配下"
  done
  return 0
}

INPUT=$(cat) || INPUT=""

if ! grep -qF 'dev-flow:' <<<"$INPUT"; then
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

TOOL=$(jq -r '.tool_name | if type == "string" then . else "" end' 2>/dev/null <<<"$INPUT") || emit_deny "tool_name を読めない"
[[ $TOOL == "Bash" ]] || pass_through

# command は文字列でなければ判定できない。jq -r の出力は末尾の改行を落とすので、改行の有無は jq の側で調べる
jq -e '.tool_input.command | type == "string"' >/dev/null 2>&1 <<<"$INPUT" || emit_deny "command が文字列でない"
HAS_NL=$(jq -r '.tool_input.command | test("[\\n\\r]")' 2>/dev/null <<<"$INPUT") || emit_deny "command を読めない"
CMD=$(jq -r '.tool_input.command' 2>/dev/null <<<"$INPUT") || emit_deny "command を読めない"

if [[ $AGENT_TYPE == "$RELAY_AGENT" ]]; then
  [[ $HAS_NL == "false" ]] || emit_deny "security-codex-relay は prompt のコマンド行を 1 行の単文でだけ実行できる"
  if [[ $CMD == "codex "* ]]; then
    check_codex
    pass_through
  fi
  if [[ $CMD =~ $PREP_RE || $CMD =~ $RESULT_RE || $CMD =~ $DIFF_CHECK_RE ]]; then
    # 正規表現は `.` / `..` の要素を弾けないので、パスの要素を別に確かめる
    for tok in $CMD; do
      [[ $tok == /* ]] || continue
      IFS='/' read -r -a SEGS <<<"${tok#/}"
      for s in "${SEGS[@]}"; do
        [[ $s == "." || $s == ".." ]] && emit_deny "security-codex-relay のパスに . / .. の要素がある"
      done
    done
    pass_through
  fi
  emit_deny "security-codex-relay は security-review-codex-prep / codex exec / security-review-codex-result / security-review-diff-check の固定形でだけ Bash を使える。prompt のコマンド行を一字一句そのまま実行せよ"
fi

NORM=${CMD//\'/}
NORM=${NORM//\"/}
NORM=${NORM//\\/}
# 単文の区切りで分け、各単文で実際に起動されるコマンド名だけを見る（引数・タイトル文字列の中の codex の語では止めない）。
# 先頭の予約語・前置コマンド（env / exec 等）・その option・`NAME=value` の代入は読み飛ばす
SEP_GLOB='[;&|(){}]'
SIMPLE=${NORM//$SEP_GLOB/$'\n'}
while read -r -a words; do
  after_prefix=0
  for w in "${words[@]}"; do
    case $w in
      then | do | else | elif | if | while | until | ! | env | exec | command | builtin | nohup | time | nice | timeout | sudo)
        after_prefix=1
        continue
        ;;
    esac
    [[ $w =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] && continue
    [[ $after_prefix -eq 1 && ( $w == -* || $w =~ ^[0-9.]+[smhd]?$ ) ]] && continue
    if [[ $w == "codex" || $w == */codex ]]; then
      emit_deny "dev-flow の agent は codex を起動できない（Codex 経路の security review は security-codex-relay が固定形で起動する）"
    fi
    break
  done
done <<<"$SIMPLE"
if [[ $NORM =~ $DIR_NAME_RE ]]; then
  emit_deny "dev-flow の agent は security review の保存先・作業ディレクトリを Bash で触れない（security-codex-relay の固定形だけが扱う）。文字列の検索は Grep tool を使う"
fi

pass_through
