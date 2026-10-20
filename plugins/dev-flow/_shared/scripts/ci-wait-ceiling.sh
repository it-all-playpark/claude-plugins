# ci-wait-ceiling.sh - pr-iterate の CI 待ちの上限（秒）を base branch の CI 所要時間から決める（source 専用。単体では実行しない）
# dev-flow-prerun（dev-flow/scripts/prerun.sh）と pr-iterate-prerun（pr-iterate-prerun.sh）が使い、出力の
# ci_wait_ceiling_seconds が pr-iterate-run の args.ci_wait_ceiling_seconds に渡る（nested・単体起動で同じ値）。
#
# 一律の上限では CI が長い repo で「CI はじきに通る」PR が ci_pending → HOLD で終わるため、base branch で直近に
# 成功した workflow run の所要時間（updatedAt - startedAt）の p90 に余裕 60 秒を足し、300〜900 秒に収める。
# 履歴が 5 件未満・gh の読み取りに失敗したときは 300 秒（workflow 側の既定 CI_WAIT_CEILING_SECONDS と同じ値）。

CI_WAIT_CEILING_DEFAULT=300
CI_WAIT_CEILING_MIN=300
CI_WAIT_CEILING_MAX=900
CI_WAIT_CEILING_MARGIN=60
CI_WAIT_CEILING_RUNS=20
CI_WAIT_CEILING_MIN_RUNS=5

# ci_wait_ceiling_from_runs <runs-json>
#   gh run list --json startedAt,updatedAt の出力（新しい順の配列）から上限（秒の整数）を stdout に出す純変換。
#   先頭 CI_WAIT_CEILING_RUNS 件のうち、時刻を読めて所要時間が負でない run だけを数える。
#   p90 は nearest-rank（昇順で ceil(0.9n) 番目）。配列でない・JSON でない入力は既定値。
ci_wait_ceiling_from_runs() {
    local out
    out="$(printf '%s' "$1" | jq -r \
        --argjson def "$CI_WAIT_CEILING_DEFAULT" \
        --argjson lo "$CI_WAIT_CEILING_MIN" \
        --argjson hi "$CI_WAIT_CEILING_MAX" \
        --argjson margin "$CI_WAIT_CEILING_MARGIN" \
        --argjson limit "$CI_WAIT_CEILING_RUNS" \
        --argjson min_runs "$CI_WAIT_CEILING_MIN_RUNS" '
        if type != "array" then $def else
          [ .[:$limit][]
            | select(type == "object")
            | (try ((.updatedAt | fromdateiso8601) - (.startedAt | fromdateiso8601)) catch null)
            | select(type == "number" and . >= 0) ]
          | sort
          | if length < $min_runs then $def
            else .[((9 * length + 9) / 10 | floor) - 1] + $margin
              | if . < $lo then $lo elif . > $hi then $hi else . end
              | floor
            end
        end
        ' 2>/dev/null)" || out=""
    if [[ "$out" =~ ^[0-9]+$ ]]; then
        printf '%s' "$out"
    else
        printf '%s' "$CI_WAIT_CEILING_DEFAULT"
    fi
}

# ci_wait_ceiling <base> [<owner/name>]
#   base branch の成功した workflow run を gh run list（読み取り）で直近 CI_WAIT_CEILING_RUNS 件取り、上限を stdout に出す。
#   gh の失敗は既定値（fail-open: 上限が決まらないことで prerun を止めない）。
ci_wait_ceiling() {
    local base="$1" repo="${2:-}" raw
    local args=(run list --branch "$base" --status success --limit "$CI_WAIT_CEILING_RUNS" --json startedAt,updatedAt)
    [[ -n "$repo" ]] && args+=(--repo "$repo")
    if ! raw="$(gh "${args[@]}" 2>/dev/null)"; then
        printf '%s' "$CI_WAIT_CEILING_DEFAULT"
        return 0
    fi
    ci_wait_ceiling_from_runs "$raw"
}
