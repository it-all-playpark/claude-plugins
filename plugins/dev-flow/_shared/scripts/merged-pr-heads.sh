# merged-pr-heads.sh - branch を head にした merged PR の番号と head commit を読む（source 専用。単体では実行しない）
# dev-flow-prerun（dev-flow/scripts/prerun.sh）が、既存 branch で worktree を始める前に使う。
#
# squash / rebase で merge された PR の commit は origin/<base> の履歴に入らないので、git の祖先関係だけでは
# 「merge 済みの branch」と「作業中の branch」を区別できない。tree の内容での取り込み判定（merge-tree 等）は merge 後に
# base が同じ行を変えると conflict になって見逃すため、merged PR の head commit という事実を読む。

# 同じ名前の branch を head にした merged PR（branch を作り直して出し直した PR 等）を全件読める件数
MERGED_PR_HEADS_LIMIT=100

# merged_pr_heads <owner/name> <branch>
#   <branch> を head にした merged PR を gh pr list（読み取り 1 回）で読み、1 PR 1 行の `<番号> <head commit の sha>` を
#   stdout に出す（無ければ何も出さない）。gh の失敗・出力が期待した形の JSON でないときは何も出さず 1 を返す
#   （呼び出し側が「merged PR 無し」と区別できるようにする。読めなかったことを無しとみなすと merge 済みの branch を通す）。
merged_pr_heads() {
    local repo="$1" branch="$2" raw
    raw="$(gh pr list --repo "$repo" --head "$branch" --state merged --limit "$MERGED_PR_HEADS_LIMIT" --json number,headRefOid 2>/dev/null)" || return 1
    printf '%s' "$raw" | jq -r '
        if type == "array" and all(.[];
            type == "object"
            and (.number | type) == "number"
            and (.headRefOid | type) == "string"
            and (.headRefOid | test("^[0-9a-f]{40,64}$")))
        then .[] | "\(.number) \(.headRefOid)"
        else error("unexpected shape")
        end' 2>/dev/null
}
