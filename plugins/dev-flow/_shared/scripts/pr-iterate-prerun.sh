#!/usr/bin/env bash
# pr-iterate-prerun.sh - /pr-iterate 単体起動の isolation preflight を 1 コマンドに集約する (issue #828)
#
# top-level Bash が bare 名 launcher (bin/pr-iterate-prerun) 経由でこのスクリプトを実行し、wrapper skill
# (pr-iterate/SKILL.md) が stdout の JSON 1 行を EnterWorktree の path と
# `Workflow({ name: 'dev-flow:pr-iterate-run', args: { pr, nested, prior_devflow } })` の nested・prior_devflow へ渡す。
# workflow 側は NESTED 分岐で pr-meta（haiku の gh pr view 転写）と isolation-cleanup を起動しない。
#
# Usage: pr-iterate-prerun <PR> [--repo owner/name] [--direction <file>]
#
# --direction <file>: /pr-iterate を起動した人が決めた修正方針のファイル。wrapper が EnterWorktree する前（launch dir）に
# 実行されるこの prerun が読み、本文を加工せずに出力の fix_direction に載せる（workflow が全 fix#i の prompt に入れる）。
# PR の作者が書けるファイルを人の方針として fix に届けないよう、実体（symlink は辿る）が PR の worktree の中にあれば拒否する。
# 読めない・空（空白だけを含む）・FIX_DIRECTION_MAX_CHARS 字を超えるときも拒否する。拒否は引数不正と同じ exit 2・stdout 空。
#
# 行う処理: gh pr view で url / headRefName / baseRefName / headRefOid / comments を取得（comments からは直前の
# dev-flow サマリーと最後の終端サマリーの marker を読む）→ git fetch origin →
# origin/<head> が PR の headRefOid と一致することを検証 → PR head の worktree を用意（既存なら再利用、
# 無ければ origin/<head> から作成。作成時は取り出せないパスに skip-worktree を付け、再利用時は未ステージの
# 削除が残っていれば fail-closed — worktree-checkout.sh）→ worktree の HEAD を PR head に合わせる（遅れていて未コミット変更が
# 無ければ fast-forward、独自コミット・分岐があれば fail-closed）→ 書き込み probe →
# `.devflow-tmp/.isolation-probe*` の git clean（前 run の probe 残置物。workflow の isolation-cleanup の代替）→
# `.devflow-tmp/` を worktree 共有の info/exclude に足す（対象 repo が ignore していなければ）。
#
# worktree の置き場所は dev-flow-prerun と同じ規則: 候補は既定 `<repo>/.claude/worktrees/pr-<N>` と
# repo 外 `<repo>-wt/pr-<N>`。既定候補が存在すればそれ、無ければ repo 外候補が存在すればそれ、どちらも
# 無ければ既定候補。PR の head branch を既に checkout している worktree（dev-flow の df-<N> 等）があれば
# 候補より優先して再利用する（git は同じ branch の二重 checkout を許さない）。
# 書き込めない場合の退避も同じ規則: この呼び出しで作った worktree が書けなければ remove して repo 外候補で
# 1 回だけ作り直す（skills repo の repo 内 worktree は index.lock が EPERM になる既知の問題があるため）。
# 再利用した worktree が書けない場合は退避しない（branch がそこで checkout 済み）— ok:false で人間に返す。
# 再利用する worktree の basename が git / git-* のときも ok:false で人間に返す（worktree 分離ガードの拒否。移動はしない）。
#
# Output (stdout, JSON 1 行):
#   {ok, pr, worktree, head_ref, base_ref, head_sha, repo, epoch, worktree_status, worktree_removed, skip_worktree, prior_devflow, prior_summary, ci_wait_ceiling_seconds, security_review, plugin_commit, fix_direction?, error?}
#   plugin_commit: 実行中の dev-flow plugin の commit（12 桁 hex）。dev-flow-prerun と同じ dev-flow/scripts/plugin-commit.sh で
#     plugin root から決める（telemetry 記録専用で gate の入力にしない）。決められなければ null（ok:false でも載せる）
#   fix_direction: --direction のファイルの本文（ok:true で --direction を渡したときだけ載せる）
#   worktree_status: created / reused / unwritable / error / skipped
#   skip_worktree: 作成時に取り出せず skip-worktree を付けたパス（worktree-checkout.sh。full checkout できれば []）
#   prior_devflow: PR コメントのうち `<!-- dev-flow:<tier>[ codes=<code>,...][ head=<sha>] -->` marker を持つ最後のもの
#     {tier, codes, url}（codes は HOLD 理由の code。HOLD 以外は []）。marker を持つコメントが無ければ null
#   prior_summary: PR コメントのうち終端サマリーの marker（`<!-- dev-flow:... -->` / `<!-- pr-iterate:<status>:<n>[ head=<sha>] -->`）を
#     持つ最後のもの {source: "dev-flow"|"pr-iterate", url, head_sha, head_mismatch}。head_sha は marker の head（無ければ null）、
#     head_mismatch は head_sha が今の PR head（headRefOid）と違うか、head_sha が null のとき true。終端サマリーが無ければ null
#   ci_wait_ceiling_seconds: pr-iterate の CI 待ちの上限（秒）。PR の base branch の CI 所要時間から決める
#     （ci-wait-ceiling.sh。base_ref が決まる前に止まった ok:false と gh の読み取り失敗は 300）
#   security_review: 敵対的 security review の起動時の判定 {target, reasons, reviewer_context_changed, reviewer}。reviewer は review を回す
#     CLI の opt-in（"dev-flow".security_reviewer。base branch の skill-config.json か user 設定から読み、PR head の設定は読まない。
#     無ければ "claude"。ok:false の早期終端では載せない — workflow は省略を "claude" として扱う）。origin/<base>...<PR head> の diff を
#     security-review-scope.sh で判定し、全ファイルが許可リストに当たるときだけ target:false。判定できない（ok:false の
#     早期終端・base 不明・node 不在・取得失敗）ときは target:true。reviewer_context_changed は diff が reviewer の指示ファイル
#     （CLAUDE.md / AGENTS.md / repo 直下の .claude/ 等）を変えるか — 判定できたうえで false のときだけ false（workflow は
#     この決定論の値を run の終わりまで固定する。run 中の判定は LLM の中継を通るので PR の指示文で偽れる）
#   不明な値は null。ok:false でも exit 0（引数不正と --direction の拒否のみ exit 2、stdout 空）。
#
# GitHub I/O は `gh pr view` と `gh run list`（base branch の成功 run。いずれも読み取り）のみ。push / comment / worktree の削除（この呼び出しで作った
# 書けない worktree の退避を除く）はしない — 単体起動の worktree は回収後も人間が確認できるよう残す。
#
# sandbox 内で動く。起動元 repo の .git/config は sandbox 内から書けないので、worktree は --no-track で作る
# （upstream を書かない。呼び出し側の push は remote と HEAD を明示して同名 branch へ送る）。

set -euo pipefail

command -v jq >/dev/null 2>&1 || { echo "jq is required" >&2; exit 127; }

# shellcheck source=worktree-checkout.sh
source "$(dirname "${BASH_SOURCE[0]}")/worktree-checkout.sh"
# shellcheck source=ci-wait-ceiling.sh
source "$(dirname "${BASH_SOURCE[0]}")/ci-wait-ceiling.sh"
# shellcheck source=security-reviewer-config.sh
source "$(dirname "${BASH_SOURCE[0]}")/security-reviewer-config.sh"

usage() {
    echo "Usage: pr-iterate-prerun <PR> [--repo owner/name] [--direction <file>]" >&2
}

# 修正方針の上限（字数。workflow の args.fix_direction の検査と同じ値）
FIX_DIRECTION_MAX_CHARS=4000

# ============================================================================
# Args
# ============================================================================

PR=""
REPO_ARG=""
DIRECTION_ARG=""
DIRECTION_GIVEN=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --repo)
            [[ $# -ge 2 ]] || { usage; exit 2; }
            REPO_ARG="$2"; shift 2 ;;
        --direction)
            [[ $# -ge 2 ]] || { usage; exit 2; }
            DIRECTION_ARG="$2"; DIRECTION_GIVEN=true; shift 2 ;;
        -*)
            echo "Unknown option: $1" >&2
            usage
            exit 2 ;;
        *)
            [[ -z "$PR" ]] || { echo "PR number given twice: $1" >&2; usage; exit 2; }
            PR="$1"; shift ;;
    esac
done

[[ -n "$PR" ]] || { echo "<PR> is required" >&2; usage; exit 2; }
[[ "$PR" =~ ^[1-9][0-9]*$ ]] || { echo "<PR> must be a positive integer" >&2; exit 2; }
if [[ -n "$REPO_ARG" ]]; then
    [[ "$REPO_ARG" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || {
        echo "--repo must be owner/name" >&2
        exit 2
    }
fi

# --direction: launch dir（EnterWorktree の前）で読み、本文を JSON 文字列で保持する。PR の worktree の中かどうかは
# worktree を決めた後（Segment 3 の後）に、ここで取った実体の物理パスで判定する。
direction_reject() {
    echo "--direction ${DIRECTION_ARG}: $1" >&2
    exit 2
}
# symlink を辿った実体の物理パス（読めなければ失敗）
direction_physical_path() {
    local p="$1" link n=0 dir
    while [[ -L "$p" ]]; do
        (( n++ < 40 )) || return 1
        link="$(readlink "$p")" || return 1
        case "$link" in
            /*) p="$link" ;;
            *) p="$(dirname "$p")/$link" ;;
        esac
    done
    dir="$(cd "$(dirname "$p")" 2>/dev/null && pwd -P)" || return 1
    printf '%s/%s' "$dir" "$(basename "$p")"
}
DIRECTION_JSON=""
DIRECTION_REAL=""
if [[ "$DIRECTION_GIVEN" == true ]]; then
    [[ -n "$DIRECTION_ARG" ]] || direction_reject "ファイルのパスが空"
    [[ -f "$DIRECTION_ARG" && -r "$DIRECTION_ARG" ]] || direction_reject "読めない（通常のファイルでないか、読み取り権限が無い）"
    DIRECTION_REAL="$(direction_physical_path "$DIRECTION_ARG")" || direction_reject "実体のパスを解決できない"
    DIRECTION_JSON="$(jq -Rs . <"$DIRECTION_ARG" 2>/dev/null)" || direction_reject "読めない"
    jq -e 'test("[^[:space:]]")' >/dev/null 2>&1 <<<"$DIRECTION_JSON" || direction_reject "空（空白だけ）"
    direction_chars="$(jq -r 'length' <<<"$DIRECTION_JSON")"
    (( direction_chars <= FIX_DIRECTION_MAX_CHARS )) || direction_reject "${direction_chars} 字（上限 ${FIX_DIRECTION_MAX_CHARS} 字）を超える"
fi

# epoch は workflow の isolation-probe token（`.devflow-tmp/.isolation-probe-<epoch>`）と clock の給電元。
# 再起動のたびに prerun を通せば新しい値になり、前 run の probe ファイルと衝突しない
epoch="$(date +%s)"

# plugin_commit: 実行中の dev-flow plugin の commit（12 桁 hex）。telemetry 記録専用で gate の入力にしない。
# 決められなければ null（fail-open）
PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
plugin_commit="$(bash "$PLUGIN_ROOT/dev-flow/scripts/plugin-commit.sh" "$PLUGIN_ROOT" 2>/dev/null)" || plugin_commit=""

repo="$REPO_ARG"
url=""
head_ref=""
base_ref=""
head_sha=""
WT=""
worktree_status="skipped"
worktree_removed=false
prior_devflow="null"
prior_summary="null"
ci_wait_ceiling_seconds="$CI_WAIT_CEILING_DEFAULT"
# 敵対的 security review の起動時の判定。判定できるまで（ok:false の早期終端を含む）は対象（fail-closed）
security_review='{"target":true,"reasons":["not_determined"],"reviewer_context_changed":true}'
error=""

emit() {
    local ok="$1"
    jq -nc \
        --argjson ok "$ok" \
        --argjson pr "$PR" \
        --arg worktree "$WT" \
        --arg head_ref "$head_ref" \
        --arg base_ref "$base_ref" \
        --arg head_sha "$head_sha" \
        --arg repo "$repo" \
        --argjson epoch "$epoch" \
        --arg worktree_status "$worktree_status" \
        --argjson worktree_removed "$worktree_removed" \
        --argjson skip_worktree "$(skip_worktree_json)" \
        --argjson prior_devflow "$prior_devflow" \
        --argjson prior_summary "$prior_summary" \
        --argjson ci_wait_ceiling_seconds "$ci_wait_ceiling_seconds" \
        --argjson security_review "$security_review" \
        --argjson fix_direction "${DIRECTION_JSON:-null}" \
        --arg plugin_commit "$plugin_commit" \
        --arg error "$error" \
        '
        def nz: if . == "" then null else . end;
        {ok: $ok, pr: $pr, worktree: ($worktree | nz), head_ref: ($head_ref | nz), base_ref: ($base_ref | nz),
         head_sha: ($head_sha | nz), repo: ($repo | nz), epoch: $epoch,
         worktree_status: $worktree_status, worktree_removed: $worktree_removed, skip_worktree: $skip_worktree,
         prior_devflow: $prior_devflow, prior_summary: $prior_summary, ci_wait_ceiling_seconds: $ci_wait_ceiling_seconds,
         security_review: $security_review,
         plugin_commit: (if ($plugin_commit | test("^[0-9a-f]{12}$")) then $plugin_commit else null end)}
        + (if $ok and $fix_direction != null then {fix_direction: $fix_direction} else {} end)
        + (if $error == "" then {} else {error: $error} end)
        '
    exit 0
}

fail() {
    error="$1"
    emit false
}

# ============================================================================
# Segment 1: PR metadata (gh pr view)
# ============================================================================

GH_ARGS=(pr view "$PR")
[[ -n "$REPO_ARG" ]] && GH_ARGS+=(--repo "$REPO_ARG")
GH_ARGS+=(--json url,headRefName,baseRefName,headRefOid,comments)

if ! VIEW_RAW="$(gh "${GH_ARGS[@]}" 2>&1)"; then
    fail "gh pr view ${PR} failed: ${VIEW_RAW}"
fi
if ! printf '%s' "$VIEW_RAW" | jq -e 'type == "object"' >/dev/null 2>&1; then
    fail "gh pr view ${PR} returned malformed JSON: ${VIEW_RAW}"
fi
url="$(printf '%s' "$VIEW_RAW" | jq -r '.url // "" | strings')"
head_ref="$(printf '%s' "$VIEW_RAW" | jq -r '.headRefName // "" | strings')"
base_ref="$(printf '%s' "$VIEW_RAW" | jq -r '.baseRefName // "" | strings')"
PR_HEAD_OID="$(printf '%s' "$VIEW_RAW" | jq -r '.headRefOid // "" | strings')"
# 直前の dev-flow サマリー: marker を持つ最後のコメントの、本文中で最後の marker（AC の引用等で本文に同じ形の
# 文字列が出ても、dev-flow が末尾に置く marker を採る）
prior_devflow="$(printf '%s' "$VIEW_RAW" | jq -c '
    [(.comments // [])[]
     | . as $c
     | ([(($c.body // "") | match("<!-- dev-flow:([A-Za-z_]+)(?: codes=([a-z_,]*))?(?: head=[0-9a-f]{40})? -->"; "g"))] | last) as $m
     | select($m != null)
     | {tier: $m.captures[0].string,
        codes: (($m.captures[1].string // "") | split(",") | map(select(. != ""))),
        url: ($c.url // null)}]
    | last')"
# 最後の終端サマリー（dev-flow / pr-iterate の marker を持つ最後のコメント）の head と今の PR head の食い違い。
# head の無い marker は、どの head に対する結論か分からないので食い違い扱い
prior_summary="$(printf '%s' "$VIEW_RAW" | jq -c --arg head "$PR_HEAD_OID" '
    [(.comments // [])[]
     | . as $c
     | ([(($c.body // "") | match("<!-- (dev-flow):[A-Za-z_]+(?: codes=[a-z_,]*)?(?: head=([0-9a-f]{40}))? -->|<!-- (pr-iterate):[a-z_]+:[0-9]+(?: head=([0-9a-f]{40}))? -->"; "g"))] | last) as $m
     | select($m != null)
     | ($m.captures[1].string // $m.captures[3].string) as $sha
     | {source: ($m.captures[0].string // $m.captures[2].string),
        url: ($c.url // null),
        head_sha: $sha,
        head_mismatch: ($sha == null or $sha != ($head | ascii_downcase))}]
    | last')"

if [[ -z "$repo" && "$url" =~ ^https://github\.com/([^/]+)/([^/]+)/pull/[0-9]+$ ]]; then
    repo="${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"
fi
[[ -n "$head_ref" ]] || fail "gh pr view ${PR} did not return headRefName"
git check-ref-format --branch "$head_ref" >/dev/null 2>&1 || fail "headRefName is not a valid branch name: ${head_ref}"
[[ "$PR_HEAD_OID" =~ ^[0-9a-f]{40}$ ]] || fail "gh pr view ${PR} did not return a 40-hex headRefOid: ${PR_HEAD_OID}"
# CI 待ちの上限は PR の base branch の CI 所要時間から決める（dev-flow-prerun と同じ ci-wait-ceiling.sh）
[[ -n "$base_ref" ]] && ci_wait_ceiling_seconds="$(ci_wait_ceiling "$base_ref" "$repo")"

# ============================================================================
# Segment 2: ROOT resolution + fetch + PR head 一致検証
# ============================================================================

WTLIST_RAW="$(git worktree list --porcelain 2>&1)" || fail "not a git repository (git worktree list failed): ${WTLIST_RAW}"
# here-string で渡す（awk の exit へ pipe すると残りの write が SIGPIPE になり pipefail で非 0 になる）
ROOT="$(awk '/^worktree /{print substr($0,10); exit}' <<<"$WTLIST_RAW")"
[[ -n "$ROOT" ]] || fail "failed to resolve git root from worktree list"

if ! FETCH_OUT="$(git -C "$ROOT" fetch origin --quiet 2>&1)"; then
    fail "git fetch origin failed: ${FETCH_OUT}"
fi
ORIGIN_HEAD="$(git -C "$ROOT" rev-parse --verify --quiet "refs/remotes/origin/${head_ref}^{commit}" 2>/dev/null)" || ORIGIN_HEAD=""
if [[ -z "$ORIGIN_HEAD" ]]; then
    fail "origin に PR の head branch ${head_ref} が無い（fork からの PR は origin から worktree を作れない）"
fi
if [[ "$ORIGIN_HEAD" != "$PR_HEAD_OID" ]]; then
    fail "PR head 不一致: origin/${head_ref} は ${ORIGIN_HEAD}、PR の headRefOid は ${PR_HEAD_OID}（push 直後なら時間をおいて再実行する。別 repo の PR なら --repo と cwd の repo を揃える）"
fi
head_sha="$PR_HEAD_OID"

# ============================================================================
# Segment 3: worktree 用意（再利用 / 作成 / 書けない場合の退避）
# ============================================================================

# git worktree list --porcelain はシンボリックリンク解決済みの物理パスを報告する（macOS の /var 等）
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

# 登録済み worktree を「path<TAB>branch<TAB>prunable」で列挙する（detached は branch 空）
list_worktrees() {
    git -C "$ROOT" worktree list --porcelain 2>/dev/null | awk '
        BEGIN { RS=""; FS="\n" }
        {
            path=""; branch=""; prunable=0
            for (i = 1; i <= NF; i++) {
                if ($i ~ /^worktree /) path=substr($i, 10)
                else if ($i ~ /^branch refs\/heads\//) { b=$i; sub(/^branch refs\/heads\//, "", b); branch=b }
                else if ($i ~ /^prunable/) prunable=1
            }
            print path "\t" branch "\t" prunable
        }
    '
}

CANON_ROOT="$(canon_path "$ROOT")"
REUSE_PATH=""
NEED_PRUNE=false
while IFS=$'\t' read -r p b pr_flag; do
    [[ -n "$p" && "$b" == "$head_ref" ]] || continue
    if [[ "$pr_flag" == "1" ]]; then
        NEED_PRUNE=true
        continue
    fi
    if [[ "$p" == "$CANON_ROOT" ]]; then
        fail "PR の head branch ${head_ref} が main checkout（${ROOT}）で checkout されている。main checkout を別 branch へ切り替えてから再実行する"
    fi
    REUSE_PATH="$p"
done <<<"$(list_worktrees)"
if [[ "$NEED_PRUNE" == true ]]; then
    git -C "$ROOT" worktree prune >/dev/null 2>&1 || true
fi

DEFAULT_WT="${ROOT}/.claude/worktrees/pr-${PR}"
OUTSIDE_WT="${ROOT}-wt/pr-${PR}"

write_probe() {
    local wt="$1"
    { mkdir -p "$wt/.devflow-tmp" && touch "$wt/.devflow-tmp/.prerun-write-probe" && rm -f "$wt/.devflow-tmp/.prerun-write-probe"; } 2>&1
}

# 作業ツリーの HEAD を PR head に合わせる。遅れていて未コミット変更が無ければ fast-forward、
# HEAD が PR head に無いコミットを持つ（未 push / 分岐）か、遅れていて未コミット変更があれば fail-closed。
# PR head と一致していれば未コミット変更はそのまま残す（fix_failed 回収など、run の commit-ensure が拾う）
align_head() {
    local wt="$1" cur dirty ff_out
    cur="$(git -C "$wt" rev-parse HEAD 2>&1)" || { error="worktree の HEAD を読めなかった: ${cur}"; return 1; }
    [[ "$cur" == "$head_sha" ]] && return 0
    if ! git -C "$wt" merge-base --is-ancestor "$cur" "$head_sha" 2>/dev/null; then
        error="worktree ${wt} の HEAD（${cur}）が PR head（${head_sha}）に無いコミットを持つ（未 push のコミットか分岐）。push してから再実行するか、git worktree remove ${wt} で削除して再実行する"
        return 1
    fi
    dirty="$(git -C "$wt" status --porcelain --untracked-files=all -- . ':(exclude).devflow-tmp' 2>&1)" || {
        error="worktree ${wt} の未コミット変更を判定できなかった: ${dirty}"
        return 1
    }
    if [[ -n "$dirty" ]]; then
        error="worktree ${wt} の HEAD（${cur}）が PR head（${head_sha}）より遅れていて未コミット変更がある。変更を退避してから再実行する"
        return 1
    fi
    if ! ff_out="$(git -C "$wt" merge --ff-only --quiet "$head_sha" 2>&1)"; then
        error="worktree ${wt} を PR head（${head_sha}）へ fast-forward できなかった: ${ff_out}"
        return 1
    fi
    return 0
}

# 未登録パスに worktree を作る。成功で 0（WT は呼び出し側が設定済み）
create_at() {
    local wt="$1"
    if [[ -e "$wt" ]]; then
        error="path exists but is not a registered git worktree: ${wt}"
        return 1
    fi
    worktree_add "$ROOT" "$wt" "$head_ref" "origin/${head_ref}" || { error="$WT_ADD_ERR"; return 1; }
    return 0
}

if [[ -n "$REUSE_PATH" ]]; then
    WT="$REUSE_PATH"
    worktree_status="reused"
    # basename が git / git-* の worktree は、パスを operand に取る exec-proxy（security-review-scope 等）を
    # worktree 分離ガードが git サブコマンドとみなして拒否し、security review が diff_unavailable で止まる。
    # 人の session の worktree かもしれないので移動・削除せず、起動前に人間へ返す
    wt_base="$(basename "$WT")"
    if [[ "$wt_base" == "git" || "$wt_base" == git-* ]]; then
        fail "再利用する worktree ${WT} の名前（${wt_base}）が git / git- で始まるため、worktree パスを渡す exec-proxy（security-review-scope 等）が worktree 分離ガードに git コマンドとみなされて拒否される。git worktree move ${WT} <git- で始まらない別名のパス> で移すか、その worktree で ${head_ref} の checkout を外して（別 branch へ切り替えて）から再実行する"
    fi
    if ! PROBE_ERR="$(write_probe "$WT")"; then
        worktree_status="unwritable"
        fail "${PROBE_ERR}（再利用した worktree は ${head_ref} を checkout 済みのため退避しない。git worktree remove ${WT} で削除してから再実行する）"
    fi
    PARTIAL_ERR="$(partial_checkout_error "$WT")" || fail "$PARTIAL_ERR"
    align_head "$WT" || fail "$error"
else
    if [[ -e "$DEFAULT_WT" ]]; then
        WT="$DEFAULT_WT"
    elif [[ -e "$OUTSIDE_WT" ]]; then
        WT="$OUTSIDE_WT"
    else
        WT="$DEFAULT_WT"
    fi
    # 候補パスが別 branch の worktree として登録済みなら、上書きせず止める
    CANON_WT="$(canon_path "$WT")"
    while IFS=$'\t' read -r p b _; do
        if [[ "$p" == "$CANON_WT" ]]; then
            worktree_status="error"
            fail "worktree ${WT} は別の branch（${b:-detached HEAD}）を checkout している。git worktree remove ${WT} で削除してから再実行する"
        fi
    done <<<"$(list_worktrees)"

    worktree_status="created"
    create_at "$WT" || { worktree_status="error"; fail "$error"; }
    if ! PROBE_ERR="$(write_probe "$WT")"; then
        # この呼び出しで作った worktree だけを remove し、repo 外候補で 1 回だけ作り直す（二重 checkout にならない）
        if REMOVE_ERR="$(git -C "$ROOT" worktree remove --force "$WT" 2>&1)"; then
            worktree_removed=true
        else
            worktree_status="unwritable"
            fail "${PROBE_ERR}; worktree remove failed: ${REMOVE_ERR}"
        fi
        if [[ "$WT" == "$OUTSIDE_WT" || -e "$OUTSIDE_WT" ]]; then
            worktree_status="unwritable"
            fail "$PROBE_ERR"
        fi
        FIRST_ERR="$PROBE_ERR"
        WT="$OUTSIDE_WT"
        mkdir -p "$(dirname "$WT")" 2>/dev/null || true
        create_at "$WT" || { worktree_status="error"; fail "${FIRST_ERR}; 退避先 ${WT} の作成に失敗: ${error}"; }
        if ! PROBE_ERR="$(write_probe "$WT")"; then
            worktree_status="unwritable"
            git -C "$ROOT" worktree remove --force "$WT" >/dev/null 2>&1 || true
            fail "${FIRST_ERR}; 退避先 ${WT} も書き込めない: ${PROBE_ERR}"
        fi
    fi
    align_head "$WT" || fail "$error"
fi

# --direction の実体が PR の worktree の中なら拒否する（PR の作者が書けるファイルを人の方針として fix に届けない）
if [[ -n "$DIRECTION_REAL" ]]; then
    CANON_WT_FINAL="$(canon_path "$WT")"
    if [[ "$DIRECTION_REAL" == "$CANON_WT_FINAL"/* ]]; then
        direction_reject "PR の worktree（${WT}）の中のファイルは方針として読まない（PR の作者が書ける）。launch dir 側のファイルを渡す"
    fi
fi

# ============================================================================
# Segment 4: 前 run の isolation probe 残置物の除去（advisory）
# ============================================================================

# token は毎回新しい epoch なので残置物が残っても probe は衝突しない。失敗しても ok は変えない。
# `.devflow-tmp` 全体は消さない（dev-flow の df-<N> を再利用したとき、PR phase 失敗の回収用 commit
# message / PR body 等が残っている）
git -C "$WT" clean -fdx -- '.devflow-tmp/.isolation-probe*' >/dev/null 2>&1 || true

# scratch を対象 repo の .gitignore に依らず fix の commit から外す（worktree-checkout.sh）。失敗は stderr に出して進む
exclude_devflow_tmp "$WT" || true

# ============================================================================
# Segment 5: 敵対的 security review の起動時の判定
# ============================================================================

# PR 全体（origin/<base>...<PR head>）の diff が決定論の許可リスト（_lib/security-review-scope.mjs）だけなら対象外。
# 判定できない（base 不明・node 不在・取得失敗・出力が読めない）ときは対象のまま。workflow は LGTM の前に PR head の diff で
# 判定し直し、どれか 1 回でも対象なら対象のまま扱う。
if [[ -n "$base_ref" ]]; then
    scope_out="$(bash "$(dirname "${BASH_SOURCE[0]}")/security-review-scope.sh" "$WT" "origin/${base_ref}" "$head_sha" 2>/dev/null)" || scope_out=""
    if scope_json="$(printf '%s' "$scope_out" | jq -ce '
        (type == "object" and .ok == true and .reviewer_context_changed == false | not) as $ctx
        | if type == "object" and .ok == true and .target == false then {target: false, reasons: [], reviewer_context_changed: $ctx}
        else {target: true, reasons: ((.reasons // []) | map(select(type == "string")) | .[:20]), reviewer_context_changed: $ctx} end' 2>/dev/null)"; then
        security_review="$scope_json"
    else
        security_review='{"target":true,"reasons":["scope_unreadable"],"reviewer_context_changed":true}'
    fi
fi

# security review を回す CLI の opt-in（"dev-flow".security_reviewer。issue #1087）。読む場所と優先順は
# security-reviewer-config.sh（dev-flow-prerun と共通）。PR head（worktree）の設定ファイルは読まない
security_reviewer="$(security_reviewer_config "$ROOT" "$base_ref")"
security_review="$(printf '%s' "$security_review" | jq -c --argjson r "$security_reviewer" '. + {reviewer: $r}')"

emit true
