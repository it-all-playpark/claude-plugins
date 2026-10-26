#!/usr/bin/env bash
# conflict-autoresolve.sh - PR branch（HEAD）へ base を merge し、衝突が機械的に解ける 2 型だけなら解消して
# merge commit を作る。1 ファイルでもそれ以外の衝突があれば git merge --abort で merge 前に戻す。
#
# 用途: pr-iterate の LGTM 確定前、PR の mergeable が CONFLICTING / DIRTY のとき（issue #916）。
# fetch / push は呼び出し側 agent の bare 単文で行い、本スクリプトはネットワーク I/O を持たない。
#
# 型（衝突ファイル単位。stage 1/2/3 の blob を `git merge-file --diff3` で分類する）:
#   A: 全 hunk で base（merge-base）側が空 = 両側が同じ位置に行を足しただけ。PR 側 → base 側の順の和集合で解く
#   B: <root>/.claude/workflows/*.js で、全 hunk が inline 生成区間（BEGIN inline 〜 END inline）の内側にあり、
#      区間の canonical（<root>/<source>）は衝突していない。<repo>/tools/sync-inlines.mjs --write で再生成し、
#      --check が通ることを確かめる
# 上記以外（base の行を両側が書き換えた hunk・lockfile・バイナリ・modify/delete・add/add・rename・canonical の衝突）は
# 自動解消しない。どちらを採るかは仕様判断で、決定論では決められない。
# lockfile は型 A の形でも解かない — 和集合は依存解決の結果として壊れる（同じ package の 2 版が並ぶ等）。
#
# 使い方: conflict-autoresolve.sh --worktree <path> --base-ref <ref>
# 出力(stdout, JSON 1 行):
#   {"status":"resolved"|"aborted"|"no_conflict"|"error","reason":string,"base_ref":string,
#    "head_before":string,"head_after":string,"restored":bool,
#    "files":[{"path":string,"type":"A"|"B"|"content"|"lockfile"|"binary"|"modify_delete"|"add_add"|"rename"|"canonical_conflict"|"inline_partial"}]}
#   resolved:    merge commit を作った（head_after がその sha。push は呼び出し側）
#   aborted:     解けない衝突があった / 再生成が --check を通らなかった。merge 前に戻した
#   no_conflict: 衝突なしで merge できた。取り込みは自動解消の対象外なので merge 前に戻した
#   error:       作業ツリーが dirty / merge の起動失敗 / commit 失敗（merge を始めていれば戻した）
#   restored は merge 前に戻した経路で HEAD と tracked ファイルが merge 前と一致したか（resolved は false）
# Exit: 0（判定を JSON で返した）/ 2（引数不正）
set -euo pipefail

wt=""
base_ref=""
while [ $# -gt 0 ]; do
    case "$1" in
        --worktree) wt="${2:-}"; shift 2 ;;
        --base-ref) base_ref="${2:-}"; shift 2 ;;
        *) echo "Usage: conflict-autoresolve.sh --worktree <path> --base-ref <ref>" >&2; exit 2 ;;
    esac
done
if [ -z "$wt" ] || [ -z "$base_ref" ] || [ ! -d "$wt" ]; then
    echo "Usage: conflict-autoresolve.sh --worktree <path> --base-ref <ref>" >&2
    exit 2
fi

g() { git -C "$wt" -c core.quotepath=off "$@"; }

tmp="$(mktemp -d "${TMPDIR:-/tmp}/conflict-autoresolve.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

head_before="$(g rev-parse HEAD)"
paths=()
types=()

emit() {
    local status="$1" reason="$2" restored="$3"
    local head_after
    head_after="$(g rev-parse HEAD 2>/dev/null || echo "")"
    local i
    : > "$tmp/files.tsv"
    for i in "${!paths[@]}"; do
        printf '%s\t%s\n' "${paths[$i]}" "${types[$i]}" >> "$tmp/files.tsv"
    done
    jq -cn --arg status "$status" --arg reason "$reason" --arg base_ref "$base_ref" \
        --arg head_before "$head_before" --arg head_after "$head_after" --argjson restored "$restored" \
        --rawfile files "$tmp/files.tsv" \
        '{status: $status, reason: $reason, base_ref: $base_ref, head_before: $head_before, head_after: $head_after,
          restored: $restored,
          files: [$files | split("\n")[] | select(. != "") | split("\t") | {path: .[0], type: .[1]}]}'
    exit 0
}

# merge 前に戻し、HEAD と tracked ファイルが merge 前と一致するかを返す。
abort_merge() {
    g merge --abort >/dev/null 2>&1 || true
    if [ "$(g rev-parse HEAD)" = "$head_before" ] && g diff-index --quiet HEAD -- \
        && ! g rev-parse -q --verify MERGE_HEAD >/dev/null; then
        echo true
    else
        echo false
    fi
}

if ! g diff-index --quiet HEAD --; then
    emit error dirty_worktree false
fi

if g merge --no-ff --no-commit "$base_ref" >"$tmp/merge.log" 2>&1; then
    emit no_conflict "" "$(abort_merge)"
fi
if ! g rev-parse -q --verify MERGE_HEAD >/dev/null; then
    # 衝突以外で merge が始まらなかった（ref が無い・untracked が上書きされる等）
    emit error merge_failed "$(abort_merge)"
fi

# ---- 衝突ファイルの列挙（unmerged entry の stage 集合）----
g ls-files -u | awk -F'\t' '{split($1, m, " "); st[$2] = st[$2] m[3]} END {for (p in st) print st[p] "\t" p}' \
    | sort -t "$(printf '\t')" -k2 > "$tmp/unmerged.tsv"

# 両側の rename（merge-base からの R）。rename が絡む衝突は自動解消しない
merge_base="$(g merge-base HEAD MERGE_HEAD)"
{ g diff --name-status -M --diff-filter=R "$merge_base" HEAD; g diff --name-status -M --diff-filter=R "$merge_base" MERGE_HEAD; } \
    | awk -F'\t' '{print $2; print $3}' > "$tmp/renamed.txt"

has_nul() { [ "$(LC_ALL=C tr -d -c '\000' < "$1" | wc -c | tr -d ' ')" -gt 0 ]; }

# diff3 出力（merge-file --diff3 -p）を hunk 単位で集計する:
#   hunks base_nonempty outside inside crossing sources(空白区切り)
# inside / outside は inline 生成区間の内外。crossing は衝突ブロックの中に区間 marker 行がある hunk。
DIFF3_AWK='
BEGIN { state = 0; region = ""; hunks = 0; base_nonempty = 0; outside = 0; inside = 0; crossing = 0; srcs = "" }
function is_marker(s) { return s ~ /^\/\/ ==== (BEGIN|END) inline: / }
state == 0 {
    if ($0 ~ /^<<<<<<< /) {
        state = 1; hunks++; blines = 0
        if (region == "") outside++
        else { inside++; if (index(" " srcs " ", " " region " ") == 0) srcs = srcs (srcs == "" ? "" : " ") region }
        next
    }
    if ($0 ~ /^\/\/ ==== BEGIN inline: /) { split($0, a, " "); region = a[5]; next }
    if ($0 ~ /^\/\/ ==== END inline: /) { region = ""; next }
    next
}
state == 1 { if ($0 ~ /^\|\|\|\|\|\|\| /) state = 2; else if (is_marker($0)) crossing++; next }
state == 2 { if ($0 == "=======") { state = 3; if (blines > 0) base_nonempty++ } else { blines++; if (is_marker($0)) crossing++ }; next }
state == 3 { if ($0 ~ /^>>>>>>> /) state = 0; else if (is_marker($0)) crossing++; next }
END { print hunks, base_nonempty, outside, inside, crossing, srcs }
'

# b_roots / b_sources は paths と同じ index（型 B のときだけ値を持つ）
b_roots=()
b_sources=()
idx=0
while IFS="$(printf '\t')" read -r stages path; do
    d="$tmp/f$idx"
    mkdir -p "$d"
    type=""
    # ls-files -u は stage 順に並ぶ。base・両側の 3 stage が揃う衝突だけが内容の衝突
    case "$stages" in
        123) ;;
        23) type="add_add" ;;
        *) type="modify_delete" ;;
    esac
    if [ -z "$type" ] && grep -Fxq -- "$path" "$tmp/renamed.txt"; then
        type="rename"
    fi
    if [ -z "$type" ]; then
        case "${path##*/}" in
            *.lock | *.lockb | *-lock.json | *-lock.yaml | *-lock.yml | *.lock.json | go.sum | npm-shrinkwrap.json) type="lockfile" ;;
        esac
    fi
    if [ -z "$type" ]; then
        g cat-file blob ":2:$path" > "$d/ours"
        g cat-file blob ":1:$path" > "$d/base"
        g cat-file blob ":3:$path" > "$d/theirs"
        if has_nul "$d/ours" || has_nul "$d/base" || has_nul "$d/theirs"; then
            type="binary"
        fi
    fi
    if [ -z "$type" ]; then
        rc=0
        git merge-file -p --diff3 -L ours -L base -L theirs "$d/ours" "$d/base" "$d/theirs" > "$d/diff3" 2>/dev/null || rc=$?
        if [ "$rc" -ge 128 ]; then
            type="binary"
        else
            read -r hunks base_nonempty outside inside crossing srcs <<< "$(awk "$DIFF3_AWK" "$d/diff3")"
            if [[ "$path" =~ ^(.*/)?\.claude/workflows/[^/]+\.js$ ]] && [ "$inside" -gt 0 ]; then
                if [ "$outside" -eq 0 ] && [ "$crossing" -eq 0 ]; then
                    type="B"
                    b_roots[$idx]="${path%.claude/workflows/*}"
                    b_sources[$idx]="$srcs"
                else
                    type="inline_partial"
                fi
            elif [ "$hunks" -gt 0 ] && [ "$base_nonempty" -eq 0 ] && [ "$crossing" -eq 0 ]; then
                type="A"
            else
                type="content"
            fi
        fi
    fi
    paths+=("$path")
    types+=("$type")
    idx=$((idx + 1))
done < "$tmp/unmerged.tsv"

# 型 B の canonical が衝突していれば、その workflow は再生成の入力が確定しないので解かない。
# 衝突パスはファイルで渡す（早く終わる grep -q へ pipe すると残りの write が SIGPIPE になり pipefail で偽になる）
printf '%s\n' "${paths[@]}" > "$tmp/unmerged-paths.txt"
for i in "${!paths[@]}"; do
    [ "${types[$i]}" = "B" ] || continue
    for src in ${b_sources[$i]}; do
        if grep -Fxq -- "${b_roots[$i]}$src" "$tmp/unmerged-paths.txt"; then
            types[$i]="canonical_conflict"
        fi
    done
done

for t in "${types[@]}"; do
    if [ "$t" != "A" ] && [ "$t" != "B" ]; then
        emit aborted unsupported_conflict "$(abort_merge)"
    fi
done

# ---- 解消 ----
roots_to_sync=()
for i in "${!paths[@]}"; do
    path="${paths[$i]}"
    d="$tmp/f$i"
    if [ "${types[$i]}" = "A" ]; then
        git merge-file -p --union -L ours -L base -L theirs "$d/ours" "$d/base" "$d/theirs" > "$wt/$path" || true
        g add -- "$path"
    else
        # 区間の中身は再生成で丸ごと置き換わるので、衝突 hunk は PR 側で仮に埋めて marker を消す
        git merge-file -p --ours -L ours -L base -L theirs "$d/ours" "$d/base" "$d/theirs" > "$wt/$path" || true
        root="${path%.claude/workflows/*}"
        case " ${roots_to_sync[*]:-} " in
            *" $root "*) ;;
            *) roots_to_sync+=("$root") ;;
        esac
    fi
done

if [ "${#roots_to_sync[@]}" -gt 0 ]; then
    top="$(g rev-parse --show-toplevel)"
    tool="$top/tools/sync-inlines.mjs"
    for root in "${roots_to_sync[@]}"; do
        root_dir="$wt/${root%/}"
        if [ ! -f "$tool" ] \
            || ! node "$tool" --write --root "$root_dir" >"$tmp/sync.log" 2>&1 \
            || ! node "$tool" --check --root "$root_dir" >>"$tmp/sync.log" 2>&1; then
            emit aborted sync_inlines_failed "$(abort_merge)"
        fi
        g add -u -- "${root}.claude/workflows"
    done
fi

if [ -n "$(g diff --name-only --diff-filter=U)" ]; then
    emit aborted unsupported_conflict "$(abort_merge)"
fi

summary=""
for i in "${!paths[@]}"; do
    summary="${summary}- ${paths[$i]}: 型 ${types[$i]}"$'\n'
done
if ! g commit -q -m "Merge ${base_ref} into PR branch (conflict auto-resolved)" -m "$summary" >"$tmp/commit.log" 2>&1; then
    emit error commit_failed "$(abort_merge)"
fi
emit resolved "" false
