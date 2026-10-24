#!/usr/bin/env bash
# security-review-codex-run.sh - Codex 経路の security review（issue #1087）で codex exec を固定の argv で 1 回起動する。
#
# codex の stdout / stderr は捨て、固定の JSON だけを出す。codex の出力には Codex の最終応答（diff の文を引用した description）が
# 載るので、起動を写す中継の agent に読ませると、diff に書かれた指示（result.json の上書き等）に誘導され得る。中継が読むのは
# この script の固定の出力だけにする。分類: incentive-structural（中継が攻撃者の文を読める限り誘導を否定できない。sunset しない）。
#
# 起動前に次を確かめ、どれかを満たさなければ codex を起動しない（{"done":false}）:
#   - <review_dir> は basename が dev-flow-security-review-XXXXXX、<cwd_dir> は basename が dev-flow-codex-cwd-XXXXXX の、空白・引用符・
#     shell の記号を含まない絶対パスで、`.` / `..` の要素を持たない実ディレクトリ（symlink でない）
#   - <cwd_dir> は空（codex が cwd の AGENTS.md 等を読まない）
#   - <review_dir> に prompt.md・schema.json が実ファイルであり、result.json が無い（symlink の result.json を通じて保存先の外へ
#     書かせない・先に置かれた result.json を codex の結果として読ませない）
#   - どちらも起動元の cwd（PR の worktree）の配下でない
#
# Usage: security-review-codex-run <review_dir> <cwd_dir>
# Output (stdout, JSON 1 行): {"done":true}（codex が result.json を書いた）/ {"done":false}（それ以外）。常に exit 0
#   （usage error だけ exit 2）。判定は security-review-codex-result が result.json から行う — この出力は判定に使わない。

set -uo pipefail
export LC_ALL=C

CODEX_PROMPT='Run the security review described in your instructions and reply only with the JSON object defined by the output schema.'
SAVE_DIR_RE='^dev-flow-security-review-[A-Za-z0-9]{6}$'
CWD_DIR_RE='^dev-flow-codex-cwd-[A-Za-z0-9]{6}$'
PATH_RE='^(/[A-Za-z0-9._-]+)+$'

done_false() {
    printf '%s\n' '{"done":false}'
    exit 0
}

if [[ $# -ne 2 ]]; then
    printf '%s\n' '{"done":false}'
    exit 2
fi
D="$1"
C="$2"

plain_path() {
    local p="$1" name_re="$2" seg
    [[ $p =~ $PATH_RE ]] || return 1
    IFS='/' read -r -a SEGS <<<"${p#/}" || return 1
    for seg in "${SEGS[@]}"; do
        [[ $seg == "." || $seg == ".." ]] && return 1
    done
    [[ ${p##*/} =~ $name_re ]]
}

plain_path "$D" "$SAVE_DIR_RE" || done_false
plain_path "$C" "$CWD_DIR_RE" || done_false

[[ -d $C && ! -L $C ]] || done_false
shopt -s nullglob dotglob
C_ENTRIES=("$C"/*)
shopt -u nullglob dotglob
((${#C_ENTRIES[@]} == 0)) || done_false

[[ -d $D && ! -L $D ]] || done_false
[[ -f "$D/prompt.md" && ! -L "$D/prompt.md" ]] || done_false
[[ -f "$D/schema.json" && ! -L "$D/schema.json" ]] || done_false
[[ ! -e "$D/result.json" && ! -L "$D/result.json" ]] || done_false

CWD_REAL=$(pwd -P 2>/dev/null) || done_false
[[ $CWD_REAL == /* ]] || done_false

# $1 自身かその祖先のどれかが cwd と同じディレクトリか（dev+inode で比べる — firmlink・大文字小文字の別表記に依らない）
under_cwd() {
    local a
    a=$(realpath -- "$1" 2>/dev/null) || return 0
    while :; do
        [[ $a -ef $CWD_REAL ]] && return 0
        [[ -z $a || $a == / ]] && return 1
        a="${a%/*}"
        [[ -n $a ]] || a=/
    done
}

under_cwd "$C" && done_false
under_cwd "$D" && done_false

command -v codex >/dev/null 2>&1 || done_false

codex exec -s read-only --ephemeral --ignore-user-config --ignore-rules --skip-git-repo-check \
    -C "$C" \
    -c 'web_search="disabled"' \
    --disable shell_tool --disable unified_exec --disable apps --disable browser_use --disable computer_use \
    -c "model_instructions_file=$D/prompt.md" \
    --output-schema "$D/schema.json" \
    -o "$D/result.json" \
    "$CODEX_PROMPT" </dev/null >/dev/null 2>&1

[[ -f "$D/result.json" && ! -L "$D/result.json" ]] || done_false
printf '%s\n' '{"done":true}'
exit 0
