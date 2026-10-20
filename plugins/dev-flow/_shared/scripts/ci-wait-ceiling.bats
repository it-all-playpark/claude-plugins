#!/usr/bin/env bats
bats_require_minimum_version 1.5.0

# Tests for _shared/scripts/ci-wait-ceiling.sh (issue #1046)
#
# base branch の直近 20 件の成功 run の所要時間（updatedAt - startedAt）の p90 + 60 秒を 300〜900 秒に収めて
# pr-iterate の CI 待ちの上限にする。履歴 5 件未満・gh の読み取り失敗は 300 秒。
# fixture は gh run list --json startedAt,updatedAt と同形の配列（新しい順）。

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

# runs_json <秒> ... — 所要時間の列から gh run list と同形の配列を作る（startedAt は run ごとにずらす）
runs_json() {
    printf '%s\n' "$@" | jq -sc '
        to_entries
        | map((1787000000 - .key * 3600) as $s
              | {startedAt: ($s | todateiso8601), updatedAt: ($s + .value | todateiso8601)})'
}

@test "履歴 4 件は 300 秒（p90 を使わない）" {
    run ci_wait_ceiling_from_runs "$(runs_json 100 200 400 800)"
    [ "$status" -eq 0 ]
    [ "$output" = "300" ]
}

@test "履歴 5 件で p90 + 60 秒（nearest-rank: 5 件なら最大値）" {
    run ci_wait_ceiling_from_runs "$(runs_json 100 200 300 400 500)"
    [ "$status" -eq 0 ]
    [ "$output" = "560" ]
}

@test "20 件の p90 は昇順 18 番目、21 件目以降（古い run）は数えない" {
    # 30, 60, ..., 600 の 20 件 → 18 番目は 540 → 600。21 件目の 5000 秒は直近 20 件の外
    local d=() k
    for k in $(seq 1 20); do d+=("$((k * 30))"); done
    run ci_wait_ceiling_from_runs "$(runs_json "${d[@]}" 5000)"
    [ "$status" -eq 0 ]
    [ "$output" = "600" ]
}

@test "p90 + 60 が 300 未満なら下限 300 に丸める" {
    run ci_wait_ceiling_from_runs "$(runs_json 100 120 150 180 200)"
    [ "$status" -eq 0 ]
    [ "$output" = "300" ]
}

@test "p90 + 60 が 900 を超えるなら上限 900 に丸める" {
    run ci_wait_ceiling_from_runs "$(runs_json 600 700 800 900 1000)"
    [ "$status" -eq 0 ]
    [ "$output" = "900" ]
}

@test "時刻を読めない run は数えず、残りが 5 件未満なら 300 秒" {
    local runs
    runs="$(runs_json 400 500 600 700 | jq -c '. + [{startedAt: null, updatedAt: "2026-10-20T00:00:00Z"}, {startedAt: "x", updatedAt: "y"}]')"
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

@test "ci_wait_ceiling: base branch の成功 run 20 件を gh run list で読み、上限を出す" {
    runs_json 238 300 350 400 455 >"$GH_STUB_FIXTURE"
    run ci_wait_ceiling main acme/skills
    [ "$status" -eq 0 ]
    [ "$output" = "515" ]
    grep -qx "run list --branch main --status success --limit 20 --json startedAt,updatedAt --repo acme/skills" "$GH_STUB_LOG"
}

@test "ci_wait_ceiling: repo 省略時は --repo を付けない" {
    runs_json 100 200 300 400 500 >"$GH_STUB_FIXTURE"
    run ci_wait_ceiling dev
    [ "$output" = "560" ]
    grep -qx "run list --branch dev --status success --limit 20 --json startedAt,updatedAt" "$GH_STUB_LOG"
}

@test "ci_wait_ceiling: gh の読み取りに失敗したら 300 秒で exit 0" {
    export GH_STUB_FAIL=1
    run ci_wait_ceiling main acme/skills
    [ "$status" -eq 0 ]
    [ "$output" = "300" ]
}
