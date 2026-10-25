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
#   3. agent_type が dev-flow:security-codex-relay → command が次の 4 形のどれかと完全に一致するときだけ通す（改行・余分な空白・
#      引用符・shell の記号を含む形は一致しない）:
#        security-review-codex-prep <D> <sha> <pr> <H> <O>[ --verify-from <N> <B>]
#        codex exec -s read-only --ephemeral --ignore-user-config --ignore-rules --skip-git-repo-check
#          -C <O>/dev-flow-codex-cwd-<N>-<B> -c dev_flow_review_dir="<D>" -c web_search="disabled" --disable shell_tool --disable unified_exec --disable apps --disable browser_use
#          --disable computer_use -c model_instructions_file=<O>/dev-flow-codex-prompt-<N>-<B>.md
#          --output-schema <O>/dev-flow-codex-schema-<N>-<B>.json -o <O>/dev-flow-codex-result-<N>-<B>.json "<固定文> <N>"
#        （codex は実際は 1 行。_lib/security-review.mjs の codexSecurityReviewCommand と同じ — 起動形を変えるときは両方を同時に変える）
#        security-review-codex-result <D> <sha> <N> <B> <P> <S> <O>[ --issues]
#        security-review-diff-check <D> <H> <ino> <ctime_ns> <dir_ino> <dir_ctime_ns>（Claude 経路でも、clear の前に保存先の pr.diff を
#          security-review-scope の sha256・ino・ctime と、<D> 自身を dir の ino・ctime と照合する。ino / ctime_ns は 1〜30 桁の数字）
#      <D> は basename が dev-flow-security-review-XXXXXX の、<O> は人が用意した出力先の、
#      `.` / `..` の要素を持たない [A-Za-z0-9._-] だけの絶対パス。<sha> は 40 桁の hex、<pr> は数字、<N> は prep が返した nonce
#      （32 桁の小文字 hex）、<B> は prep が返した binding、<P> / <S> は prep が返した prompt.md・schema.json の sha256、<H> は
#      security-review-scope が返した diff の sha256（どれも 64 桁の小文字 hex）。
#      prep・codex・result の 3 形は <O> が user 設定の "dev-flow".codex_output_dir（pr-iterate-prerun と同じ順: $SKILL_CONFIG_PATH →
#      ~/.config/skills/config.json → ~/.claude/skill-config.json）と完全に一致するときだけ通し、値が無ければ deny する —
#      prep が書き込み不可を確かめた出力先以外（sandbox から書ける別の場所）を -o にした codex を中継が起動できないようにする。
#      prep / result のパスの実体は各 script が確かめる。
#      codex の形は hook がパスの実体も確かめる: dev_flow_review_dir の <D>（codex は使わない設定キー。hook が複製元を知るためだけに
#      置く）は prompt.md・schema.json を実ファイルとして持つ実ディレクトリで、入力の cwd（PR の worktree）の配下でない。4 つの名前の
#      nonce は prompt の nonce と同じで、<O> は symlink でない実ディレクトリで realpath が自身と一致する（祖先にも symlink が無い）・
#      cwd / $TMPDIR / /tmp / /private/tmp の配下でない・作業ディレクトリ・複製・結果ファイル（symlink を含む）がまだ無い。
#      -C は sandbox の中から書けない <O> の直下に置き、binding の照合を通した後に hook が新しく作る（既にあれば deny）。<D> の配下に
#      置くと、常駐プロセスが hook の確認の後に <D> へ .git・AGENTS.md を置き、codex に <D> を project root として指示を読ませられる。
#      <O> と祖先に .git・AGENTS.md 等が無いことは prep が確かめる（どちらも sandbox の中から書けないので prep の後に置けない）。
#      codex を excludedCommands に入れると -o は sandbox の外で codex CLI 自身が書くので、sandbox の中から書ける場所を出力先にすると
#      常駐プロセスが結果ファイルの名前に symlink を置いて任意のファイルを上書きさせられる（sandbox の中から書けないことは prep が確かめる）。
#      <D> も sandbox の中から書けるので codex に読ませない: 全部の確認が通った後、hook が <D>/prompt.md・schema.json を <O> の
#      dev-flow-codex-{prompt,schema}-<N>-<B> へ複製し、複製の中身と <D> から計算した binding
#      （sha256("<D>\n<sha256(prompt)>\n<sha256(schema)>\n")。_lib/scripts/security-review-codex-binding.mjs と同じ式）が <B> と
#      一致したときだけ通す。prep が書いた後に <D> を書き換えられた・別の保存先を指した起動は、一致しないか、prep が返した <B> と
#      違う名前に結果を書く（result script は prep の <B> の名前だけを読む）。
#      中継は PR の worktree を cwd に bare 名の codex を起動し、codex は sandbox の外で動く。PATH 上で codex が解決されるファイル
#      （先頭から見て最初の実行できる通常ファイル）が、解決できない・PATH の相対パスか空の要素（cwd 基準）から解決される・realpath が
#      cwd・$TMPDIR・/tmp・/private/tmp の配下なら deny する（PR のコードが置いた codex を sandbox の外で走らせない）。
#      hook の確認は起動の直前の 1 回なので、codex の後の入力の書き換えは result script が再照合する
#   4. それ以外の dev-flow の agent → 引用符とバックスラッシュを外した command を `;` `&` `|` `(` `)` `{` `}` と改行で単文に分け、
#      各単文の先頭から予約語（then / do / ! 等）・前置コマンド（env / exec / command / nohup / timeout 等）とその option・
#      `NAME=value` の代入を読み飛ばした最初のトークンが `codex` か `*/codex` なら deny。保存先・作業ディレクトリ・結果ファイルの名前
#      （dev-flow-security-review- / dev-flow-codex-cwd- / dev-flow-codex-result- / -prompt- / -schema-）を含む command も deny。それ以外は通す。引数の中の codex の語（`grep codex`・
#      `gh pr create --title "… codex …"`）では止めない。
#      この agent たちは任意の Bash を持つので、ここは誤って codex や保存先を触ることを止める多層防御であり保証ではない —
#      Codex の review の完全性は 3 の allowlist と、round の間に他の agent を起動しない workflow の順序で持つ
#
# fail-closed: exit 2 以外の非 0 終了は tool を通すので、判定中に想定外で終わったら EXIT trap が deny を出して exit 0 にする。
# hook が変えるのは、Codex 経路を opt-in した利用者の出力先（codex_output_dir）に round の複製 2 つと空の作業ディレクトリを新しく作ることだけで、
# 既存のファイルの変更・削除・プロセス操作・外部送信をしない。抜け道（環境変数・フラグ）は作らない。
# deny の理由に入力の文字列を埋め込まない（中継の session に入力由来の文字列を返さない）。

export LC_ALL=C

DECIDED=0
RELAY_AGENT='dev-flow:security-codex-relay'
SEG='/[A-Za-z0-9._-]+'
D_RE="(${SEG})*/dev-flow-security-review-[A-Za-z0-9]{6}"
O_RE="(${SEG})+"
SHA_RE='[0-9a-fA-F]{40}'
NONCE_RE='[0-9a-f]{32}'
BINDING_RE='[0-9a-f]{64}'
SHA256_RE='[0-9a-f]{64}'
PREP_RE="^security-review-codex-prep ${D_RE} ${SHA_RE} [0-9]+ ${SHA256_RE} ${O_RE}( --verify-from ${NONCE_RE} ${BINDING_RE})?$"
CODEX_PROMPT='Run the security review described in your instructions and reply only with the JSON object defined by the output schema. Set its nonce field to'
RESULT_RE="^security-review-codex-result ${D_RE} ${SHA_RE} ${NONCE_RE} ${BINDING_RE} ${SHA256_RE} ${SHA256_RE} ${O_RE}( --issues)?$"
DIFF_CHECK_RE="^security-review-diff-check ${D_RE} ${SHA256_RE} [0-9]{1,30} [0-9]{1,30} [0-9]{1,30} [0-9]{1,30}$"
DIR_NAME_RE='dev-flow-security-review-|dev-flow-codex-cwd-|dev-flow-codex-result-|dev-flow-codex-prompt-|dev-flow-codex-schema-'

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

# user 設定の "dev-flow".codex_output_dir（pr-iterate-prerun と同じ探索順: $SKILL_CONFIG_PATH → ~/.config/skills/config.json →
# ~/.claude/skill-config.json。最初に null でない値を持つファイルの値）を CONFIGURED_OUTPUT_DIR に入れる。無い・文字列でなければ deny。
# 中継が nonce を自分で選んだ codex を、prep が書き込み不可を確かめていない別の場所を出力先にして起動できないよう、<O> をこの値に縛る
load_configured_output_dir() {
  local cfg v
  for cfg in "${SKILL_CONFIG_PATH:-}" "${HOME:-}/.config/skills/config.json" "${HOME:-}/.claude/skill-config.json"; do
    [[ -n $cfg && -f $cfg ]] || continue
    v=$(jq -c 'if type == "object" and (.["dev-flow"] | type) == "object" then .["dev-flow"].codex_output_dir else null end' 2>/dev/null <"$cfg") || v=''
    [[ -n $v && $v != 'null' ]] || continue
    CONFIGURED_OUTPUT_DIR=$(jq -r 'if type == "string" then . else "" end' 2>/dev/null <<<"$v") || CONFIGURED_OUTPUT_DIR=''
    [[ -n $CONFIGURED_OUTPUT_DIR ]] || emit_deny "user 設定の dev-flow.codex_output_dir が文字列でない"
    return 0
  done
  emit_deny "user 設定に dev-flow.codex_output_dir が無い"
}

# 出力先が user 設定の codex_output_dir と完全に一致するか。一致しなければ deny する
require_configured_output_dir() {
  load_configured_output_dir
  [[ $1 == "$CONFIGURED_OUTPUT_DIR" ]] || emit_deny "出力先が user 設定の dev-flow.codex_output_dir と一致しない"
}

# 中継の codex の起動が固定形と完全に一致し、パスの実体が条件を満たすか。満たさなければ deny する
sha256_hex() {
  local h
  if command -v sha256sum >/dev/null 2>&1; then
    h=$(sha256sum) || return 1
  else
    h=$(shasum -a 256) || return 1
  fi
  h="${h%% *}"
  [[ $h =~ ^[0-9a-f]{64}$ ]] || return 1
  printf '%s' "$h"
}

# 保存先 <D> と 2 つの中身（文字列）から binding を計算する（_lib/scripts/security-review-codex-binding.mjs の codexBinding と同じ式）
codex_binding() {
  local ph sh
  ph=$(printf '%s' "$2" | sha256_hex) || return 1
  sh=$(printf '%s' "$3" | sha256_hex) || return 1
  printf '%s\n%s\n%s\n' "$1" "$ph" "$sh" | sha256_hex
}

# 実パス $1 の自身か祖先のどれかが、残りの引数のどれかと同じディレクトリか（dev+inode で比べる — firmlink・大文字小文字の
# 別表記に依らない）
under_any() {
  local a="$1" x
  shift
  while :; do
    for x in "$@"; do
      [[ $a -ef $x ]] && return 0
    done
    [[ -z $a || $a == / ]] && return 1
    a="${a%/*}"
    [[ -n $a ]] || a=/
  done
}

# 中継の Bash が先頭トークン codex を解決する先（PATH の先頭から見て最初の、実行できる通常ファイル）を確かめる。codex は sandbox の
# 外で動くので、PR のコードが置ける場所に解決されるなら通さない: 解決できない・PATH の相対パスか空の要素（Bash の cwd = PR の
# worktree 基準）から解決される・実体（realpath）が cwd・$TMPDIR・/tmp・/private/tmp の配下。$1 は入力の cwd、$2 はその realpath
check_codex_binary() {
  local rest="${PATH-}:" e cand real
  local -a forbid=("$2" /tmp /private/tmp)
  [[ -n ${TMPDIR:-} ]] && forbid+=("$TMPDIR")
  while [[ -n $rest ]]; do
    e="${rest%%:*}"
    rest="${rest#*:}"
    if [[ $e == /* ]]; then cand="${e%/}/codex"; else cand="$1/${e:+$e/}codex"; fi
    [[ -f $cand && -x $cand ]] || continue
    [[ $e == /* ]] || emit_deny "codex が PATH の相対パスか空の要素（cwd 基準）から解決される"
    real=$(realpath -- "$cand" 2>/dev/null) || emit_deny "codex の実体の realpath を取れない"
    under_any "$real" "${forbid[@]}" && emit_deny "codex の実体が cwd（PR の worktree）・\$TMPDIR・/tmp の配下にある"
    return 0
  done
  emit_deny "codex が PATH 上に見つからない"
}

check_codex() {
  local c d n o on b f pc sc p s cwd cwd_real a expected got
  local -a forbid
  [[ $CMD =~ \ -o\ ([^ ]+)/dev-flow-codex-result-([0-9a-f]{32})-([0-9a-f]{64})\.json\  ]] || emit_deny "codex の -o が出力先の dev-flow-codex-result-<nonce>-<binding>.json の形でない"
  o="${BASH_REMATCH[1]}"
  on="${BASH_REMATCH[2]}"
  b="${BASH_REMATCH[3]}"
  [[ $CMD =~ \ -c\ dev_flow_review_dir=\"([^ \"]+)\"\  ]] || emit_deny "codex の起動形が固定形と一致しない"
  d="${BASH_REMATCH[1]}"
  [[ $CMD =~ \ ([^ \"]+)\"$ ]] || emit_deny "codex の起動形が固定形と一致しない"
  n="${BASH_REMATCH[1]}"
  [[ $d =~ ^${D_RE}$ ]] || emit_deny "codex の dev_flow_review_dir が保存先の mkdtemp の形でない"
  [[ $o =~ ^${O_RE}$ ]] || emit_deny "codex の出力先が絶対パスの形でない"
  [[ $n =~ ^${NONCE_RE}$ ]] || emit_deny "codex の prompt の nonce が固定の形でない"
  [[ $on == "$n" ]] || emit_deny "codex の -o の nonce が prompt の nonce と一致しない"
  c="${o}/dev-flow-codex-cwd-${n}-${b}"
  f="${o}/dev-flow-codex-result-${n}-${b}.json"
  pc="${o}/dev-flow-codex-prompt-${n}-${b}.md"
  sc="${o}/dev-flow-codex-schema-${n}-${b}.json"
  expected="codex exec -s read-only --ephemeral --ignore-user-config --ignore-rules --skip-git-repo-check -C ${c} -c dev_flow_review_dir=\"${d}\" -c web_search=\"disabled\" --disable shell_tool --disable unified_exec --disable apps --disable browser_use --disable computer_use -c model_instructions_file=${pc} --output-schema ${sc} -o ${f} \"${CODEX_PROMPT} ${n}\""
  [[ $CMD == "$expected" ]] || emit_deny "codex の起動形が固定形と一致しない（フラグの過不足・作業ディレクトリ・指示ファイル・schema が出力先の round の名前でない）"
  for p in "$d" "$o"; do
    IFS='/' read -r -a SEGS <<<"${p#/}"
    for s in "${SEGS[@]}"; do
      [[ $s == "." || $s == ".." ]] && emit_deny "security-codex-relay のパスに . / .. の要素がある"
    done
  done
  [[ -d $d && ! -L $d ]] || emit_deny "保存先が実ディレクトリでない"
  [[ -f "$d/prompt.md" && ! -L "$d/prompt.md" ]] || emit_deny "保存先に prompt.md が無い"
  [[ -f "$d/schema.json" && ! -L "$d/schema.json" ]] || emit_deny "保存先に schema.json が無い"
  [[ -d $o && ! -L $o ]] || emit_deny "codex の出力先が symlink でない実ディレクトリでない"
  # 祖先の symlink も許さない（realpath が自身と一致する出力先だけ。祖先の書き込み不可は prep が確かめる）
  [[ $(realpath -- "$o" 2>/dev/null) == "$o" ]] || emit_deny "codex の出力先の realpath が自身と一致しない（祖先に symlink がある）"
  for p in "$c" "$f" "$pc" "$sc"; do
    [[ ! -e $p && ! -L $p ]] || emit_deny "codex の出力先に作業ディレクトリ・結果ファイル・複製が既にある"
  done
  cwd=$(jq -r '.cwd | if type == "string" then . else "" end' 2>/dev/null <<<"$INPUT") || emit_deny "cwd を読めない"
  [[ $cwd == /* ]] || emit_deny "cwd が絶対パスでない"
  cwd_real=$(realpath -- "$cwd" 2>/dev/null) || emit_deny "cwd の realpath を取れない"
  check_codex_binary "$cwd" "$cwd_real"
  # 保存先は cwd の配下でなく、出力先は sandbox の中から書ける一時領域（$TMPDIR・/tmp・/private/tmp）の配下でもない
  for p in "$d" "$o"; do
    forbid=("$cwd_real")
    if [[ $p == "$o" ]]; then
      forbid+=(/tmp /private/tmp)
      [[ -n ${TMPDIR:-} ]] && forbid+=("$TMPDIR")
    fi
    a=$(realpath -- "$p" 2>/dev/null) || emit_deny "codex の保存先・出力先の realpath を取れない"
    under_any "$a" "${forbid[@]}" && emit_deny "codex の保存先が cwd の配下か、出力先が cwd・\$TMPDIR・/tmp の配下"
  done
  require_configured_output_dir "$o"
  # 保存先の 2 つを 1 回ずつ読み、読んだ中身と保存先から計算した binding が起動形の binding と一致したときだけ、その中身を出力先
  # （sandbox の中から書けない）へ新しいファイルとして書く（noclobber: 既にある名前には書かない）。codex にはその複製を読ませる。
  # 照合の前に書かない — 保存先の名前を symlink に差し替えて sandbox の外のファイルを読ませても、一致しない中身は出力先に出ない
  # （NUL を含む中身は bash の変数で落ちて一致しない）
  local pbody sbody
  pbody=$(cat -- "$d/prompt.md" 2>/dev/null && printf x) || emit_deny "保存先の prompt.md を読めない"
  sbody=$(cat -- "$d/schema.json" 2>/dev/null && printf x) || emit_deny "保存先の schema.json を読めない"
  pbody="${pbody%x}"
  sbody="${sbody%x}"
  got=$(codex_binding "$d" "$pbody" "$sbody") || emit_deny "保存先の binding を計算できない"
  [[ $got == "$b" ]] || emit_deny "保存先から計算した binding が起動形の binding と一致しない（prep の後に保存先が変わった・別の保存先）"
  (set -C && printf '%s' "$pbody" >"$pc") 2>/dev/null || emit_deny "prompt.md を出力先へ複製できない"
  (set -C && printf '%s' "$sbody" >"$sc") 2>/dev/null || emit_deny "schema.json を出力先へ複製できない"
  # 作業ディレクトリは照合の後に新しく作る（既にあれば mkdir が失敗して拒否 — 先に置かれた中身を codex に読ませない）
  mkdir -- "$c" 2>/dev/null || emit_deny "codex の作業ディレクトリを出力先に作れない"
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
    # 出力先は prep の 6 番目・result の 8 番目のトークン。diff の照合は出力先を使わない（Claude 経路でも走る）
    read -r -a TOKS <<<"$CMD"
    if [[ $CMD == security-review-codex-prep\ * ]]; then
      require_configured_output_dir "${TOKS[5]}"
    elif [[ $CMD == security-review-codex-result\ * ]]; then
      require_configured_output_dir "${TOKS[7]}"
    fi
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
