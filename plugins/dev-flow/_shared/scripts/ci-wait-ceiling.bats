#!/usr/bin/env bats
bats_require_minimum_version 1.5.0

# Tests for _shared/scripts/ci-wait-ceiling.sh (issue #1046, #1211)
#
# PR で走った（--event pull_request）直近 50 件の成功 run を workflow 名ごとに分け、5 件以上ある workflow の
# 所要時間（updatedAt - startedAt）の p90 の最大 + 60 秒を 300〜900 秒に収めて pr-iterate の CI 待ちの上限にする。
# 5 件以上の workflow が無い・gh の読み取り失敗は 300 秒。
# fixture は gh run list --json workflowName,startedAt,updatedAt と同形の配列（新しい順）。

LIB="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)/ci-wait-ceiling.sh"

setup() {
    # shellcheck source=ci-wait-ceiling.sh
    source "$LIB"
    STUB_DIR="$BATS_TEST_TMPDIR/stub-bin"
    mkdir -p "$STUB_DIR"
    cat >"$STUB_DIR/gh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$GH_STUB_LOG"
if [[ -n "${GH_STUB_FAIL:-}" ]]; then
    echo "gh stub: HTTP 403" >&2
    exit 1
fi
cat "$GH_STUB_FIXTURE"
STUB
    chmod +x "$STUB_DIR/gh"
    export PATH="$STUB_DIR:$PATH"
    export GH_STUB_LOG="$BATS_TEST_TMPDIR/gh.log"
    export GH_STUB_FIXTURE="$BATS_TEST_TMPDIR/runs.json"
    unset GH_STUB_FAIL
}

# runs_json <workflow 名> <秒> ... — 所要時間の列から gh run list と同形の配列を作る（startedAt は run ごとにずらす）
runs_json() {
    local name="$1"
    shift
    printf '%s\n' "$@" | jq -sc --arg name "$name" '
        to_entries
        | map((1787000000 - .key * 3600) as $s
              | {workflowName: $name, startedAt: ($s | todateiso8601), updatedAt: ($s + .value | todateiso8601)})'
}

@test "履歴 4 件は 300 秒（p90 を使わない）" {
    run ci_wait_ceiling_from_runs "$(runs_json CI 100 200 400 800)"
    [ "$status" -eq 0 ]
    [ "$output" = "300" ]
}

@test "履歴 5 件で p90 + 60 秒（nearest-rank: 5 件なら最大値）" {
    run ci_wait_ceiling_from_runs "$(runs_json CI 100 200 300 400 500)"
    [ "$status" -eq 0 ]
    [ "$output" = "560" ]
}

@test "短い workflow の run が多数でも、5 件ある長い workflow の p90 + 60 秒を出す" {
    # Lint 20 件（60 秒）+ CI 5 件（500〜580 秒）。CI の p90 は 580 → 640。
    # 全 25 件をまとめた p90（昇順 23 番目）は 540 → 600 になり、CI の途中で打ち切る
    local d=() k runs
    for k in $(seq 1 20); do d+=(60); done
    runs="$(printf '%s\n' "$(runs_json Lint "${d[@]}")" "$(runs_json CI 500 520 540 560 580)" | jq -sc 'add')"
    run ci_wait_ceiling_from_runs "$runs"
    [ "$status" -eq 0 ]
    [ "$output" = "640" ]
}

@test "どの workflow も 5 件未満なら、合計が 5 件以上でも 300 秒" {
    local runs
    runs="$(printf '%s\n' "$(runs_json Lint 400 500 600)" "$(runs_json CI 700 800 850)" | jq -sc 'add')"
    run ci_wait_ceiling_from_runs "$runs"
    [ "$status" -eq 0 ]
    [ "$output" = "300" ]
}

@test "workflowName が文字列でない run は数えない" {
    local runs
    runs="$(runs_json CI 400 500 600 700 | jq -c '. + [{workflowName: null, startedAt: "2026-10-20T00:00:00Z", updatedAt: "2026-10-20T00:10:00Z"}, {startedAt: "2026-10-20T00:00:00Z", updatedAt: "2026-10-20T00:10:00Z"}]')"
    run ci_wait_ceiling_from_runs "$runs"
    [ "$status" -eq 0 ]
    [ "$output" = "300" ]
}

@test "50 件の p90 は昇順 45 番目、51 件目以降（古い run）は数えない" {
    # 10, 20, ..., 500 の 50 件 → 45 番目は 450 → 510。51 件目の 5000 秒は直近 50 件の外
    local d=() k
    for k in $(seq 1 50); do d+=("$((k * 10))"); done
    run ci_wait_ceiling_from_runs "$(runs_json CI "${d[@]}" 5000)"
    [ "$status" -eq 0 ]
    [ "$output" = "510" ]
}

@test "p90 + 60 が 300 未満なら下限 300 に丸める" {
    run ci_wait_ceiling_from_runs "$(runs_json CI 100 120 150 180 200)"
    [ "$status" -eq 0 ]
    [ "$output" = "300" ]
}

@test "p90 + 60 が 900 を超えるなら上限 900 に丸める" {
    run ci_wait_ceiling_from_runs "$(runs_json CI 600 700 800 900 1000)"
    [ "$status" -eq 0 ]
    [ "$output" = "900" ]
}

@test "時刻を読めない run は数えず、残りが 5 件未満なら 300 秒" {
    local runs
    runs="$(runs_json CI 400 500 600 700 | jq -c '. + [{workflowName: "CI", startedAt: null, updatedAt: "2026-10-20T00:00:00Z"}, {workflowName: "CI", startedAt: "x", updatedAt: "y"}]')"
    run ci_wait_ceiling_from_runs "$runs"
    [ "$status" -eq 0 ]
    [ "$output" = "300" ]
}

@test "配列でない・JSON でない入力は 300 秒" {
    run ci_wait_ceiling_from_runs '{"message":"Not Found"}'
    [ "$output" = "300" ]
    run ci_wait_ceiling_from_runs 'not json'
    [ "$output" = "300" ]
    run ci_wait_ceiling_from_runs ''
    [ "$output" = "300" ]
}

@test "ci_wait_ceiling: PR で走った成功 run 50 件を branch で絞らずに gh run list で読み、上限を出す" {
    runs_json CI 238 300 350 400 455 >"$GH_STUB_FIXTURE"
    run ci_wait_ceiling acme/skills
    [ "$status" -eq 0 ]
    [ "$output" = "515" ]
    grep -qx "run list --event pull_request --status success --limit 50 --json workflowName,startedAt,updatedAt --repo acme/skills" "$GH_STUB_LOG"
    run grep -e '--branch' "$GH_STUB_LOG"
    [ "$status" -ne 0 ]
}

@test "ci_wait_ceiling: repo 省略時は --repo を付けない" {
    runs_json CI 100 200 300 400 500 >"$GH_STUB_FIXTURE"
    run ci_wait_ceiling
    [ "$output" = "560" ]
    grep -qx "run list --event pull_request --status success --limit 50 --json workflowName,startedAt,updatedAt" "$GH_STUB_LOG"
}

@test "ci_wait_ceiling: gh の読み取りに失敗したら 300 秒で exit 0" {
    export GH_STUB_FAIL=1
    run ci_wait_ceiling acme/skills
    [ "$status" -eq 0 ]
    [ "$output" = "300" ]
}
