# worktree-checkout.sh - 作業ブランチへの付け替え・部分 checkout の検査・run の scratch の除外（source 専用。単体では実行しない）
# dev-flow-prerun（dev-flow/scripts/prerun.sh）と pr-iterate-prerun（pr-iterate-prerun.sh）が使う。
#
# prerun は sandbox 内で動き、worktree を作らない（sandbox 内からは起動元 repo の `.git/worktrees` に書けない）。worktree は
# wrapper が EnterWorktree で用意し（無ければ Claude Code が branch `worktree-<ディレクトリ名>` で作る）、prerun はその中で
# 作業ブランチへ `git switch` する。sandbox が書けないパス（`.githooks` 等）の中身が付け替えの前後で違う repo では
# `git switch` が `cannot create directory at '.githooks': Operation not permitted` 等で失敗する。
# そこで HEAD だけを作業ブランチへ向け、取り出せるパスだけを取り出して、取り出せないパスに skip-worktree を付ける。
# 付けずに残すと未ステージの変更・削除になり、commit 時の `git add -A` がそのパスを stage する。
# `checkout-index -a` はディレクトリを作れないと最初のパスで fatal 終了するので、パスごとに取り出す。

WT_SKIP_WORKTREE=()
WT_SWITCH_ERR=""

# githooks(5) のクライアント側の hook 名（サーバー側の pre-receive / update 等は worktree の commit・push で動かない）
WT_CLIENT_HOOK_EVENTS=(
    applypatch-msg pre-applypatch post-applypatch
    pre-commit pre-merge-commit prepare-commit-msg commit-msg post-commit
    pre-rebase post-checkout post-merge pre-push
    reference-transaction pre-auto-gc post-rewrite sendemail-validate post-index-change
)

# git worktree list --porcelain はシンボリックリンク解決済みの物理パスを報告する（macOS の /var -> /private/var 等）。
# 登録済み worktree との突合せはこの物理パスで行う。
canon_path() {
    local p="$1" dir base
    if [[ -e "$p" ]]; then
        (cd "$p" 2>/dev/null && pwd -P) || printf '%s' "$p"
    else
        dir="$(dirname "$p")"
        base="$(basename "$p")"
        if [[ -d "$dir" ]]; then
            printf '%s/%s' "$(cd "$dir" && pwd -P)" "$base"
        else
            printf '%s' "$p"
        fi
    fi
}

# worktree_fresh_branch <wt>
#   Claude Code が EnterWorktree({name}) で worktree を作った直後の branch 名（`worktree-<worktree のディレクトリ名>`）
worktree_fresh_branch() {
    printf 'worktree-%s' "$(basename "$1")"
}

# worktree_toplevel_of_cwd: cwd を含む作業ツリーの物理パス（git の作業ツリーの中でなければ空）
worktree_toplevel_of_cwd() {
    local top
    top="$(git rev-parse --show-toplevel 2>/dev/null)" || return 0
    canon_path "$top"
}

# worktree_has_symlink_leading_path <wt> <path>
#   <wt> からの相対パス <path> の親ディレクトリのどれかが symlink か、ディレクトリでなければ 0
worktree_has_symlink_leading_path() {
    local wt="$1" d="$2"
    while [[ "$d" == */* ]]; do
        d="${d%/*}"
        if [[ -L "$wt/$d" || ! -d "$wt/$d" ]]; then
            return 0
        fi
    done
    return 1
}

# worktree_switch <wt> <branch> <start>
#   worktree <wt>（cwd がその中にある）を branch へ付け替える。branch が無ければ <start> から --no-track で作り
#   （起動元 repo の .git/config に upstream を書かない）、あればそのまま switch する。成功で 0。WT_SKIP_WORKTREE に
#   skip-worktree を付けたパス（全パスを取り出せたときは空）、失敗時は WT_SWITCH_ERR にエラーを入れる。
#   呼び出し側は、未コミットの変更が無いことを確かめてから呼ぶ（部分 checkout は作業ツリーを上書きする）。
#   `git switch` が書けないパスに当たったときの終わり方は 2 通りあり、終了コードではなく HEAD で見分ける:
#     HEAD が branch を指している — 置き換えられない既存ファイル（`unable to unlink old ...`）は fatal にならず、
#       index と食い違ったまま残る。食い違うパスだけを取り出し直す
#     HEAD が動いていない — ディレクトリを作れない等の fatal。HEAD だけを branch へ向け、index を branch の tree から
#       作って全パスを取り出す
worktree_switch() {
    local wt="$1" branch="$2" start="$3" full_err out list p old cur wtlist
    WT_SKIP_WORKTREE=()
    WT_SWITCH_ERR=""
    if ! old="$(git -C "$wt" rev-parse --verify --quiet 'HEAD^{commit}' 2>&1)"; then
        WT_SWITCH_ERR="worktree ${wt} の HEAD を読めなかった: ${old}"
        return 1
    fi
    if git -C "$wt" show-ref --verify --quiet "refs/heads/${branch}"; then
        full_err="$(git -C "$wt" switch "$branch" 2>&1)" || true
    else
        full_err="$(git -C "$wt" switch --no-track -c "$branch" "$start" 2>&1)" || true
    fi
    cur="$(git -C "$wt" symbolic-ref --short -q HEAD 2>/dev/null)" || cur=""
    list="$(mktemp "${TMPDIR:-/tmp}/worktree-checkout.XXXXXX")"
    if [[ "$cur" == "$branch" ]]; then
        git -C "$wt" update-index -q --refresh >/dev/null 2>&1 || true
        git -C "$wt" ls-files -m -z >"$list"
    else
        # 取り出し以外の失敗（branch が別の worktree で checkout 済み・起点を解決できない等）は部分 checkout にせず、
        # `git switch` のエラーを返す。symbolic-ref は二重 checkout を検査しないので、ここで確かめる
        # （一覧は先に取り切る。pipe で grep -q へ渡すと、一致で grep が先に終わったとき pipefail で不一致に見える）
        wtlist="$(git -C "$wt" worktree list --porcelain 2>/dev/null)" || wtlist=""
        if [[ -z "$wtlist" ]] || grep -qxF -- "branch refs/heads/${branch}" <<<"$wtlist"; then
            rm -f "$list"
            WT_SWITCH_ERR="$full_err"
            return 1
        fi
        if ! git -C "$wt" show-ref --verify --quiet "refs/heads/${branch}" \
            && ! git -C "$wt" branch --no-track "$branch" "$start" >/dev/null 2>&1; then
            rm -f "$list"
            WT_SWITCH_ERR="$full_err"
            return 1
        fi
        if ! out="$(git -C "$wt" symbolic-ref HEAD "refs/heads/${branch}" 2>&1)" \
            || ! out="$(git -C "$wt" read-tree HEAD 2>&1)"; then
            rm -f "$list"
            WT_SWITCH_ERR="${full_err}; 部分 checkout で ${branch} へ付け替えられなかった: ${out}"
            return 1
        fi
        git -C "$wt" ls-files -z >"$list"
    fi
    while IFS= read -r -d '' p; do
        git -C "$wt" checkout-index -f -- "$p" >/dev/null 2>&1 || WT_SKIP_WORKTREE+=("$p")
    done <"$list"
    # 付け替え前の commit にだけあるパスは作業ツリーから消す（残すと untracked になり、commit 時の `git add -A` が stage する）。
    # 親ディレクトリのどれかが symlink（付け替え後の tree が置いたもの）なら、そのパスは作業ツリーに無いので消さない
    # （辿ると symlink の先の別のファイルを消す。git も symlink を辿って消さない）
    git -C "$wt" diff --name-only --no-renames --diff-filter=D -z "$old" HEAD >"$list" 2>/dev/null || : >"$list"
    out=""
    while IFS= read -r -d '' p; do
        worktree_has_symlink_leading_path "$wt" "$p" && continue
        rm -f -- "$wt/$p" 2>/dev/null || out="${out:+${out}, }${p}"
    done <"$list"
    rm -f "$list"
    if [[ -n "$out" ]]; then
        WT_SWITCH_ERR="${full_err:+${full_err}; }付け替え前の commit にだけあるパスを作業ツリーから消せなかった: ${out}"
        WT_SKIP_WORKTREE=()
        return 1
    fi
    if [[ ${#WT_SKIP_WORKTREE[@]} -gt 0 ]] \
        && ! out="$(git -C "$wt" update-index --skip-worktree -- "${WT_SKIP_WORKTREE[@]}" 2>&1)"; then
        WT_SWITCH_ERR="${full_err:+${full_err}; }取り出せないパスに skip-worktree を付けられなかった: ${out}"
        WT_SKIP_WORKTREE=()
        return 1
    fi
    # 取り出したファイルの stat を index に載せる（載せないと以後の git status が毎回全ファイルを読み直す）
    git -C "$wt" update-index -q --refresh >/dev/null 2>&1 || true
    return 0
}

# skip_worktree_json: WT_SKIP_WORKTREE を JSON 配列で出す
skip_worktree_json() {
    if [[ ${#WT_SKIP_WORKTREE[@]} -eq 0 ]]; then
        printf '[]'
        return
    fi
    printf '%s\n' "${WT_SKIP_WORKTREE[@]}" | jq -R . | jq -sc .
}

# hooks_not_running_json <wt>
#   repo が追跡している hook のうち、worktree で動かない event を JSON 配列で出す（無ければ []）。追跡の判定は basename が
#   WT_CLIENT_HOOK_EVENTS に一致するファイル（skip-worktree の有無を問わない）。動かない判定は `git hook list <event>` の
#   exit 1 だけ（0 = ある。それ以外は git が判定できていないので数えない）。相対の core.hooksPath は worktree の中で解決されるので、
#   `.husky` を取り出せない worktree や生成物の `.husky/_` が無い worktree では失敗を出さずに hook なしになる。開示専用で、
#   失敗しても run を止めない。`git hook list` は hook を実行しない（prerun は repo の任意コードを実行しない）。
hooks_not_running_json() {
    local wt="$1" tracked event rc
    local events=()
    tracked="$(git -C "$wt" ls-files -z 2>/dev/null | tr '\0' '\n' | sed 's|.*/||')" || tracked=""
    for event in "${WT_CLIENT_HOOK_EVENTS[@]}"; do
        grep -qxF -- "$event" <<<"$tracked" || continue
        rc=0
        git -C "$wt" hook list "$event" >/dev/null 2>&1 || rc=$?
        if [[ "$rc" -eq 1 ]]; then
            events+=("$event")
        fi
    done
    if [[ ${#events[@]} -eq 0 ]]; then
        printf '[]'
        return
    fi
    printf '%s\n' "${events[@]}" | jq -R . | jq -sc .
}

# partial_checkout_error <wt>
#   再利用する worktree に skip-worktree の付いていない未ステージの削除があれば、エラー文を stdout に出して 1 を返す。
#   取り出していないパス（部分 checkout）と作業中の削除は区別できないので、取り出し直さずに止める
#   （取り出し直すと作業中の削除を黙って戻す。残したまま進むと commit 時の `git add -A` が削除を stage する）。
partial_checkout_error() {
    local wt="$1" deleted n
    if ! deleted="$(git -C "$wt" ls-files --deleted 2>/dev/null)"; then
        printf 'worktree %s の未ステージの削除を判定できなかった' "$wt"
        return 1
    fi
    [[ -z "$deleted" ]] && return 0
    n="$(printf '%s\n' "$deleted" | wc -l | tr -d ' ')"
    printf 'worktree %s に未ステージの削除が %s 件ある（部分 checkout の疑い。例: %s）。commit 時に削除が stage されるので再利用しない。git worktree remove %s で削除してから再実行する（付け替えでは取り出せないパスに skip-worktree を付ける）' \
        "$wt" "$n" "$(printf '%s\n' "$deleted" | head -n 3 | paste -sd ',' -)" "$wt"
    return 1
}

# exclude_devflow_tmp <wt>
#   run の scratch（`.devflow-tmp/`）を worktree 共有の info/exclude に足す。対象 repo が `.gitignore` に
#   `.devflow-tmp/` を持たないと、pr-fixer の commit や commit-ensure の stage（`git add --ignore-removal .`）が
#   prerun-setup.json（作者マシンの絶対パスと issue 本文）や isolation probe を PR に commit する。
#   追跡ファイル（`.gitignore`）は書かない。既に ignore されていれば何もしない。書けなければ stderr に出して 1 を返す。
exclude_devflow_tmp() {
    local wt="$1" path err
    git -C "$wt" check-ignore -q .devflow-tmp/ 2>/dev/null && return 0
    if ! path="$(git -C "$wt" rev-parse --path-format=absolute --git-path info/exclude 2>&1)"; then
        echo "exclude_devflow_tmp: info/exclude のパスを解決できなかった: ${path}" >&2
        return 1
    fi
    # 末尾に改行の無い既存行へ連結しない
    if ! err="$( {
        mkdir -p "$(dirname "$path")" \
            && { [[ ! -s "$path" || -z "$(tail -c 1 "$path")" ]] || printf '\n' >>"$path"; } \
            && printf '/.devflow-tmp/\n' >>"$path"
    } 2>&1 )"; then
        echo "exclude_devflow_tmp: ${path} に書けなかった: ${err}" >&2
        return 1
    fi
}
