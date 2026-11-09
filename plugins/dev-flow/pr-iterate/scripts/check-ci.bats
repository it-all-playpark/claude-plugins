#!/usr/bin/env bats
# Tests for pr-iterate/scripts/check-ci.sh
#
# check-ci.sh runs `gh pr view <N> [--repo R] --json headRefOid,statusCheckRollup`
# once and classifies the rollup. A gh stub at the head of PATH records its argv
# and returns the response the test wrote, so every case below feeds the rollup
# through the same gh call the script makes in production.

HEAD_SHA=0123456789abcdef0123456789abcdef01234567

setup() {
    SKILLS_REPO="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
    SCRIPT="$SKILLS_REPO/pr-iterate/scripts/check-ci.sh"

    STUB_DIR="$BATS_TEST_TMPDIR/stub-bin"
    mkdir -p "$STUB_DIR"
    cat >"$STUB_DIR/gh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$GH_STUB_LOG"
cat "$GH_STUB_STDOUT"
if [[ -f "$GH_STUB_STDERR" ]]; then cat "$GH_STUB_STDERR" >&2; fi
exit "${GH_STUB_EXIT:-0}"
STUB
    chmod +x "$STUB_DIR/gh"
    export PATH="$STUB_DIR:$PATH"
    export GH_STUB_LOG="$BATS_TEST_TMPDIR/gh.log"
    export GH_STUB_STDOUT="$BATS_TEST_TMPDIR/gh.stdout"
    export GH_STUB_STDERR="$BATS_TEST_TMPDIR/gh.stderr"
    : >"$GH_STUB_STDOUT"
    unset GH_STUB_EXIT
}

# gh_returns <stdout text>: gh スタブの stdout をそのまま決める（JSON でない応答も書ける）
gh_returns() {
    printf '%s' "$1" >"$GH_STUB_STDOUT"
}

# ci <rollup text> [check-ci args...]: gh スタブに {headRefOid, statusCheckRollup: <rollup>} を返させて check-ci を 1 回走らせる。
# rollup は JSON として組まずに文字列で埋めるので、rollup として読めない値もそのまま渡せる。
ci() {
    gh_returns "{\"headRefOid\":\"$HEAD_SHA\",\"statusCheckRollup\":$1}"
    shift
    run bash "$SCRIPT" --pr 7 --repo acme/skills "$@"
}

# gh_calls: gh スタブが呼ばれた回数
gh_calls() {
    if [[ -f "$GH_STUB_LOG" ]]; then wc -l <"$GH_STUB_LOG" | tr -d ' '; else echo 0; fi
}

# rollup の要素（gh がエクスポートする形）。
# check_run <name> <conclusion> [status] [startedAt] [workflowName] [detailsUrl]
check_run() {
    jq -nc --arg name "$1" --arg conclusion "$2" --arg status "${3:-COMPLETED}" \
        --arg started "${4:-2026-01-01T00:00:00Z}" --arg workflow "${5:-CI}" --arg url "${6:-}" \
        '{name: $name, workflowName: $workflow, status: $status, conclusion: $conclusion, startedAt: $started}
         + (if $url != "" then {detailsUrl: $url} else {} end)'
}

# status_context <context> <state> [startedAt] [targetUrl]
status_context() {
    jq -nc --arg context "$1" --arg state "$2" --arg started "${3:-2026-01-01T00:00:00Z}" --arg url "${4:-}" \
        '{context: $context, state: $state, startedAt: $started}
         + (if $url != "" then {targetUrl: $url} else {} end)'
}

SUCCESS_LINT='{"name":"lint","workflowName":"CI","status":"COMPLETED","conclusion":"SUCCESS","startedAt":"2026-01-01T00:00:00Z"}'
PENDING_E2E='{"name":"e2e","workflowName":"CI","status":"IN_PROGRESS","conclusion":"","startedAt":"2026-01-01T00:00:00Z"}'

# ---------------------------------------------------------------------------
# the gh call
# ---------------------------------------------------------------------------

@test "gh: one call, argv is pr view <N> --repo <R> --json headRefOid,statusCheckRollup" {
    ci "[$SUCCESS_LINT]"
    [ "$status" -eq 0 ]
    [ "$(gh_calls)" = "1" ]
    [ "$(cat "$GH_STUB_LOG")" = "pr view 7 --repo acme/skills --json headRefOid,statusCheckRollup" ]
}

@test "gh: without --repo the argv has no --repo" {
    gh_returns "{\"headRefOid\":\"$HEAD_SHA\",\"statusCheckRollup\":[]}"
    run bash "$SCRIPT" --pr 42
    [ "$status" -eq 0 ]
    [ "$(cat "$GH_STUB_LOG")" = "pr view 42 --json headRefOid,statusCheckRollup" ]
}

@test "head_sha: the verdict output carries the headRefOid gh returned" {
    ci "[$SUCCESS_LINT]"
    [ "$(echo "$output" | jq -r '.head_sha')" = "$HEAD_SHA" ]
    ci "[$(check_run bats FAILURE)]"
    [ "$(echo "$output" | jq -r '.head_sha')" = "$HEAD_SHA" ]
    ci "[$PENDING_E2E]"
    [ "$(echo "$output" | jq -r '.head_sha')" = "$HEAD_SHA" ]
    ci 'null'
    [ "$(echo "$output" | jq -r '.head_sha')" = "$HEAD_SHA" ]
}

# ---------------------------------------------------------------------------
# verdict derivation
# ---------------------------------------------------------------------------

@test "passed: all SUCCESS -> status passed" {
    ci "[$SUCCESS_LINT,$(check_run test SUCCESS)]"
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.status')" = "passed" ]
    [ "$(echo "$output" | jq -r '.passed')" = "2" ]
    [ "$(echo "$output" | jq -r '.failed')" = "0" ]
}

@test "passed: skipping counts as passed and is also reported as skipped" {
    ci "[$SUCCESS_LINT,$(check_run e2e SKIPPED)]"
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.status')" = "passed" ]
    [ "$(echo "$output" | jq -r '.passed')" = "2" ]
    [ "$(echo "$output" | jq -r '.skipped')" = "1" ]
}

@test "failed: FAILURE -> status failed with failed_checks entry" {
    ci "[$(check_run bats FAILURE)]"
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.status')" = "failed" ]
    [ "$(echo "$output" | jq -r '.failed')" = "1" ]
    [ "$(echo "$output" | jq -r '.failed_checks[0].name')" = "bats" ]
    [ "$(echo "$output" | jq -r '.failed_checks[0].bucket')" = "fail" ]
    [ "$(echo "$output" | jq -r '.failed_checks[0].state')" = "FAILURE" ]
}

@test "failed: CANCELLED is bucket cancel and folds into failed (fail-closed)" {
    ci "[$(check_run build CANCELLED)]"
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.status')" = "failed" ]
    [ "$(echo "$output" | jq -r '.failed')" = "1" ]
    [ "$(echo "$output" | jq -r '.failed_checks[0].bucket')" = "cancel" ]
}

@test "pending: empty conclusion -> status pending with pending_checks entry" {
    ci "[$SUCCESS_LINT,$PENDING_E2E]"
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.status')" = "pending" ]
    [ "$(echo "$output" | jq -r '.pending')" = "1" ]
    echo "$output" | jq -e '.pending_checks == [{"name":"e2e","state":"IN_PROGRESS"}]'
}

@test "pending: failure takes precedence over pending" {
    ci "[$(check_run bats FAILURE),$PENDING_E2E]"
    [ "$(echo "$output" | jq -r '.status')" = "failed" ]
}

# ---------------------------------------------------------------------------
# CheckRun: conclusion decides, status does not (issue #1232 AC-1)
# ---------------------------------------------------------------------------

@test "status left IN_PROGRESS: conclusion SUCCESS -> passed, not pending" {
    ci "[$(check_run lint SUCCESS IN_PROGRESS)]"
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.status')" = "passed" ]
    [ "$(echo "$output" | jq -r '.passed')" = "1" ]
    [ "$(echo "$output" | jq -r '.pending')" = "0" ]
}

@test "status left IN_PROGRESS: conclusion FAILURE -> failed, reported with the conclusion" {
    ci "[$(check_run lint FAILURE IN_PROGRESS)]"
    [ "$(echo "$output" | jq -r '.status')" = "failed" ]
    [ "$(echo "$output" | jq -r '.failed_checks[0].state')" = "FAILURE" ]
}

@test "status IN_PROGRESS with empty conclusion -> pending" {
    ci "[$(check_run lint '' IN_PROGRESS)]"
    [ "$(echo "$output" | jq -r '.status')" = "pending" ]
    [ "$(echo "$output" | jq -r '.pending')" = "1" ]
}

@test "status COMPLETED with empty conclusion -> pending (status is not read)" {
    ci "[$(check_run lint '' COMPLETED)]"
    [ "$(echo "$output" | jq -r '.status')" = "pending" ]
}

@test "the rollup as gh exports it (with __typename, completedAt, urls) classifies the same" {
    ci '[{"__typename":"CheckRun","name":"lint","workflowName":"CI","status":"IN_PROGRESS","conclusion":"SUCCESS","startedAt":"2026-01-01T00:00:00Z","completedAt":"2026-01-01T00:01:00Z","detailsUrl":"https://github.com/o/r/actions/runs/1/job/11"},{"__typename":"StatusContext","context":"vercel","state":"SUCCESS","startedAt":"2026-01-01T00:00:00Z","targetUrl":"https://vercel.example/1"}]'
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.status')" = "passed" ]
    [ "$(echo "$output" | jq -r '.passed')" = "2" ]
}

# ---------------------------------------------------------------------------
# classification table (issue #1232 AC-2)
# ---------------------------------------------------------------------------

# assert_bucket <rollup element> <check name> <expected bucket>。--only を付けずに件数から bucket を確かめる。
assert_bucket() {
    ci "[$1]"
    [ "$status" -eq 0 ]
    case "$3" in
        pass)     echo "$output" | jq -e --arg n "$2" '.status == "passed" and .passed == 1 and .skipped == 0 and .failed_checks == [] and .pending_checks == []' ;;
        skipping) echo "$output" | jq -e --arg n "$2" '.status == "passed" and .passed == 1 and .skipped == 1' ;;
        pending)  echo "$output" | jq -e --arg n "$2" '.status == "pending" and .pending == 1 and .pending_checks[0].name == $n' ;;
        *)        echo "$output" | jq -e --arg n "$2" --arg b "$3" '.status == "failed" and .failed == 1 and .failed_checks[0].name == $n and .failed_checks[0].bucket == $b' ;;
    esac
}

@test "table: CheckRun conclusion -> bucket" {
    assert_bucket "$(check_run c SUCCESS)" c pass
    for v in SKIPPED NEUTRAL; do assert_bucket "$(check_run c "$v")" c skipping; done
    for v in FAILURE ERROR TIMED_OUT ACTION_REQUIRED STARTUP_FAILURE; do assert_bucket "$(check_run c "$v")" c fail; done
    assert_bucket "$(check_run c CANCELLED)" c cancel
    for v in PENDING EXPECTED STALE; do assert_bucket "$(check_run c "$v")" c pending; done
}

@test "table: a conclusion the table does not know -> fail, never passed or pending (fail-closed)" {
    for v in QUARANTINED success COMPLETED; do assert_bucket "$(check_run c "$v")" c fail; done
    ci "[$SUCCESS_LINT,$(check_run new WHATEVER)]"
    [ "$(echo "$output" | jq -r '.status')" = "failed" ]
    [ "$(echo "$output" | jq -r '.failed_checks[0].state')" = "WHATEVER" ]
}

@test "table: StatusContext uses context as the check name and classifies by state" {
    assert_bucket "$(status_context vercel SUCCESS)" vercel pass
    for v in FAILURE ERROR; do assert_bucket "$(status_context vercel "$v")" vercel fail; done
    for v in PENDING EXPECTED; do assert_bucket "$(status_context vercel "$v")" vercel pending; done
}

@test "table: a state the table does not know, including empty -> fail (only a CheckRun reads empty as pending)" {
    for v in WHATEVER ""; do assert_bucket "$(status_context vercel "$v")" vercel fail; done
}

# ---------------------------------------------------------------------------
# duplicates (issue #1232 AC-3)
# ---------------------------------------------------------------------------

EARLY=2026-01-01T00:00:00Z
LATE=2026-01-01T00:05:00Z

@test "duplicate CheckRun: a later success does not erase a failure" {
    ci "[$(check_run bats FAILURE COMPLETED "$EARLY"),$(check_run bats SUCCESS COMPLETED "$LATE")]"
    [ "$(echo "$output" | jq -r '.status')" = "failed" ]
    [ "$(echo "$output" | jq -r '.failed')" = "1" ]
    [ "$(echo "$output" | jq -r '.passed')" = "0" ]
    echo "$output" | jq -e '.failed_checks == [{"name":"bats","bucket":"fail","state":"FAILURE"}]'
}

@test "duplicate CheckRun: a later failure beats an earlier success, in either rollup order" {
    ci "[$(check_run bats SUCCESS COMPLETED "$EARLY"),$(check_run bats FAILURE COMPLETED "$LATE")]"
    [ "$(echo "$output" | jq -r '.status')" = "failed" ]
    ci "[$(check_run bats FAILURE COMPLETED "$LATE"),$(check_run bats SUCCESS COMPLETED "$EARLY")]"
    [ "$(echo "$output" | jq -r '.status')" = "failed" ]
}

@test "duplicate CheckRun: a cancelled run counts as failed and is not erased by a later success" {
    ci "[$(check_run bats CANCELLED COMPLETED "$EARLY"),$(check_run bats SUCCESS COMPLETED "$LATE")]"
    [ "$(echo "$output" | jq -r '.status')" = "failed" ]
    [ "$(echo "$output" | jq -r '.failed_checks[0].bucket')" = "cancel" ]
}

@test "duplicate CheckRun: failed never drops to pending" {
    ci "[$(check_run bats FAILURE COMPLETED "$EARLY"),$(check_run bats '' IN_PROGRESS "$LATE")]"
    [ "$(echo "$output" | jq -r '.status')" = "failed" ]
    [ "$(echo "$output" | jq -r '.pending')" = "0" ]
}

@test "duplicate CheckRun with no failure: the latest startedAt decides" {
    ci "[$(check_run bats SUCCESS COMPLETED "$LATE"),$(check_run bats '' IN_PROGRESS "$EARLY")]"
    [ "$(echo "$output" | jq -r '.status')" = "passed" ]
    [ "$(echo "$output" | jq -r '.passed')" = "1" ]

    ci "[$(check_run bats SUCCESS COMPLETED "$EARLY"),$(check_run bats '' IN_PROGRESS "$LATE")]"
    [ "$(echo "$output" | jq -r '.status')" = "pending" ]
    [ "$(echo "$output" | jq -r '.pending')" = "1" ]
    [ "$(echo "$output" | jq -r '.passed')" = "0" ]
}

@test "duplicate CheckRun: a run that has not started counts as the latest (an old success does not green a queued re-run)" {
    for not_started in 0001-01-01T00:00:00Z ""; do
        ci "[$(check_run bats SUCCESS COMPLETED "$LATE"),$(jq -nc --arg s "$not_started" '{name:"bats",workflowName:"CI",status:"QUEUED",conclusion:"",startedAt:$s}')]"
        [ "$(echo "$output" | jq -r '.status')" = "pending" ]
    done
}

@test "duplicate CheckRun: on the same startedAt a pending run wins over a success, in either rollup order" {
    ci "[$(check_run bats SUCCESS COMPLETED "$EARLY"),$(check_run bats '' IN_PROGRESS "$EARLY")]"
    [ "$(echo "$output" | jq -r '.status')" = "pending" ]
    ci "[$(check_run bats '' IN_PROGRESS "$EARLY"),$(check_run bats SUCCESS COMPLETED "$EARLY")]"
    [ "$(echo "$output" | jq -r '.status')" = "pending" ]
}

@test "same name in a different workflowName is a different check" {
    ci "[$(check_run test FAILURE COMPLETED "$EARLY" A),$(check_run test SUCCESS COMPLETED "$LATE" B)]"
    [ "$(echo "$output" | jq -r '.status')" = "failed" ]
    [ "$(echo "$output" | jq -r '.failed')" = "1" ]
    [ "$(echo "$output" | jq -r '.passed')" = "1" ]
}

@test "duplicate StatusContext: the latest startedAt decides, a later success replaces a failure" {
    ci "[$(status_context vercel FAILURE "$EARLY"),$(status_context vercel SUCCESS "$LATE")]"
    [ "$(echo "$output" | jq -r '.status')" = "passed" ]
    [ "$(echo "$output" | jq -r '.passed')" = "1" ]

    ci "[$(status_context vercel SUCCESS "$EARLY"),$(status_context vercel FAILURE "$LATE")]"
    [ "$(echo "$output" | jq -r '.status')" = "failed" ]
    [ "$(echo "$output" | jq -r '.failed')" = "1" ]
}

# ---------------------------------------------------------------------------
# empty rollup
# ---------------------------------------------------------------------------

@test "no_checks: empty array -> status no_checks (not passed, not error)" {
    ci '[]'
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.status')" = "no_checks" ]
}

@test "no_checks: null rollup -> status no_checks" {
    ci 'null'
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.status')" = "no_checks" ]
    echo "$output" | jq -e '.passed == 0 and .failed == 0 and .pending == 0 and .skipped == 0 and .failed_checks == [] and .pending_checks == []'
}

@test "output keys: the verdict output keeps its keys plus head_sha, the error output keeps its keys" {
    ci "[$SUCCESS_LINT]"
    echo "$output" | jq -e 'keys == ["epoch","failed","failed_checks","head_sha","next_action","passed","pending","pending_checks","poll_attempts","skipped","status","waited_seconds"]'
    gh_returns 'garbage'
    run bash "$SCRIPT" --pr 7
    echo "$output" | jq -e 'keys == ["epoch","message","next_action","poll_attempts","status","waited_seconds"]'
}

# ---------------------------------------------------------------------------
# unusable snapshot -> status error, exit 1 (fail-closed)
# ---------------------------------------------------------------------------

# assert_error <message substring>: status error・exit 1 で、message に substring を含む
assert_error() {
    [ "$status" -eq 1 ]
    [ "$(echo "$output" | jq -r '.status')" = "error" ]
    [[ "$(echo "$output" | jq -r '.message')" == *"$1"* ]]
}

@test "error: gh exits non-zero -> error with the first 3 lines of gh's stderr in the message" {
    printf '%s\n' 'line1: Not Found (HTTP 404)' 'line2' 'line3' 'line4-not-included' 'line5' >"$GH_STUB_STDERR"
    export GH_STUB_EXIT=1
    gh_returns ''
    run bash "$SCRIPT" --pr 7 --repo acme/skills
    assert_error 'line1: Not Found (HTTP 404) line2 line3'
    [[ "$(echo "$output" | jq -r '.message')" != *"line4-not-included"* ]]
}

@test "error: gh exits non-zero even with a well-formed passing rollup on stdout -> error, never passed" {
    printf 'gh: rate limited\n' >"$GH_STUB_STDERR"
    export GH_STUB_EXIT=1
    ci "[$SUCCESS_LINT]"
    assert_error 'rate limited'
}

@test "error: stdout is not JSON -> error, with gh's stderr in the message" {
    printf 'warning: something odd\n' >"$GH_STUB_STDERR"
    gh_returns 'not json'
    run bash "$SCRIPT" --pr 7 --repo acme/skills
    assert_error 'warning: something odd'
    gh_returns ''
    run bash "$SCRIPT" --pr 7 --repo acme/skills
    assert_error 'not a JSON object'
}

@test "error: stdout is JSON but not an object -> error" {
    for data in '[]' '"text"' '1' 'null'; do
        gh_returns "$data"
        run bash "$SCRIPT" --pr 7 --repo acme/skills
        assert_error 'not a JSON object'
    done
}

@test "error: statusCheckRollup that is neither an array of checks nor null -> error" {
    for rollup in '{}' '"text"' '1' 'true' '[1]' '["lint"]' '{"statusCheckRollup":[]}'; do
        ci "$rollup"
        assert_error 'statusCheckRollup'
    done
    gh_returns "{\"headRefOid\":\"$HEAD_SHA\"}"
    run bash "$SCRIPT" --pr 7 --repo acme/skills
    assert_error 'statusCheckRollup'
}

@test "error: headRefOid that is not a 40-hex commit sha -> error" {
    for oid in '"0123456"' '""' 'null' '1' "\"${HEAD_SHA}0\"" '"gggggggggggggggggggggggggggggggggggggggg"'; do
        gh_returns "{\"headRefOid\":$oid,\"statusCheckRollup\":[$SUCCESS_LINT]}"
        run bash "$SCRIPT" --pr 7 --repo acme/skills
        assert_error 'headRefOid'
    done
    gh_returns "{\"statusCheckRollup\":[$SUCCESS_LINT]}"
    run bash "$SCRIPT" --pr 7 --repo acme/skills
    assert_error 'headRefOid'
}

@test "error: error output still carries the bounded-wait accounting keys" {
    printf 'gh: Not Found (HTTP 404)\n' >"$GH_STUB_STDERR"
    export GH_STUB_EXIT=1
    run bash "$SCRIPT" --pr 7 --attempt 2 --max-attempts 3 --poll-seconds 45
    [ "$status" -eq 1 ]
    [ "$(echo "$output" | jq -r '.waited_seconds')" = "45" ]
    [ "$(echo "$output" | jq -r '.poll_attempts')" = "2" ]
    [ "$(echo "$output" | jq -r '.next_action')" = "done" ]
}

# ---------------------------------------------------------------------------
# check names with quotes
# ---------------------------------------------------------------------------

@test "check name containing a single quote parses correctly" {
    ci '[{"name":"lint'"'"'s check","conclusion":"SUCCESS"}]'
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.status')" = "passed" ]
    [ "$(echo "$output" | jq -r '.passed')" = "1" ]
}

@test "check name containing a double quote parses correctly" {
    ci '[{"name":"say \"hi\" check","conclusion":"SUCCESS"}]'
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.status')" = "passed" ]
    [ "$(echo "$output" | jq -r '.passed')" = "1" ]
}

# ---------------------------------------------------------------------------
# --only / --exclude: narrow the snapshot by check name (issue #861)
# ---------------------------------------------------------------------------

SNAPSHOT_WITH_E2E='[{"name":"lint","workflowName":"CI","status":"COMPLETED","conclusion":"SUCCESS","startedAt":"2026-01-01T00:00:00Z","detailsUrl":"https://github.com/o/r/actions/runs/1/job/11"},{"name":"e2e","workflowName":"CI","status":"IN_PROGRESS","conclusion":"","startedAt":"2026-01-01T00:00:00Z","detailsUrl":"https://github.com/o/r/actions/runs/2/job/22"}]'
E2E_URL=https://github.com/o/r/actions/runs/2/job/22

@test "filter: --exclude drops the named check before the verdict (pending e2e no longer blocks the round gate)" {
    ci "$SNAPSHOT_WITH_E2E" --exclude e2e
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.status')" = "passed" ]
    [ "$(echo "$output" | jq -r '.pending')" = "0" ]
    echo "$output" | jq -e 'has("passed_checks") | not'
}

@test "filter: --only keeps just the named checks and reports passed_checks with link" {
    ci "$SNAPSHOT_WITH_E2E" --only e2e
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.status')" = "pending" ]
    [ "$(echo "$output" | jq -r '.passed')" = "0" ]
    echo "$output" | jq -e '.pending_checks == [{"name":"e2e","state":"IN_PROGRESS","link":"https://github.com/o/r/actions/runs/2/job/22"}]'
    echo "$output" | jq -e '.passed_checks == []'

    ci "[$SUCCESS_LINT,$(check_run e2e SUCCESS COMPLETED "$EARLY" CI "$E2E_URL")]" --only e2e
    [ "$(echo "$output" | jq -r '.status')" = "passed" ]
    echo "$output" | jq -e '.passed_checks == [{"name":"e2e","bucket":"pass","state":"SUCCESS","link":"https://github.com/o/r/actions/runs/2/job/22"}]'

    ci "[$(check_run e2e FAILURE COMPLETED "$EARLY" CI "$E2E_URL")]" --only e2e
    [ "$(echo "$output" | jq -r '.status')" = "failed" ]
    echo "$output" | jq -e '.failed_checks[0].link == "https://github.com/o/r/actions/runs/2/job/22"'

    # StatusContext の URL は targetUrl
    ci "[$(status_context e2e SUCCESS "$EARLY" "$E2E_URL")]" --only e2e
    echo "$output" | jq -e '.passed_checks[0].link == "https://github.com/o/r/actions/runs/2/job/22"'
}

@test "filter: --only / --exclude see the check after duplicates are settled" {
    rollup="[$(check_run e2e FAILURE COMPLETED "$EARLY"),$(check_run e2e SUCCESS COMPLETED "$LATE"),$SUCCESS_LINT]"
    ci "$rollup" --only e2e
    [ "$(echo "$output" | jq -r '.status')" = "failed" ]
    ci "$rollup" --exclude e2e
    [ "$(echo "$output" | jq -r '.status')" = "passed" ]
    [ "$(echo "$output" | jq -r '.passed')" = "1" ]
}

@test "filter: --only never counts a skipped check as passed (label-gated e2e skipped on this run -> pending, not in passed_checks)" {
    ci "[$SUCCESS_LINT,$(check_run e2e SKIPPED COMPLETED "$EARLY" CI "$E2E_URL")]" --only e2e
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.status')" = "pending" ]
    [ "$(echo "$output" | jq -r '.passed')" = "0" ]
    [ "$(echo "$output" | jq -r '.pending')" = "1" ]
    [ "$(echo "$output" | jq -r '.skipped')" = "1" ]
    echo "$output" | jq -e '.passed_checks == []'
    echo "$output" | jq -e '.pending_checks == [{"name":"e2e","state":"SKIPPED","link":"https://github.com/o/r/actions/runs/2/job/22"}]'

    # without --only a skipped check still folds into passed (round gate behaviour unchanged)
    ci "[$SUCCESS_LINT,$(check_run e2e SKIPPED)]"
    [ "$(echo "$output" | jq -r '.status')" = "passed" ]
    [ "$(echo "$output" | jq -r '.passed')" = "2" ]
}

@test "filter: --only on a check that is not registered yet -> no_checks" {
    ci "[$SUCCESS_LINT]" --only e2e
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.status')" = "no_checks" ]
    echo "$output" | jq -e '.passed_checks == []'
}

# ---------------------------------------------------------------------------
# bounded-wait accounting (the caller polls; the script only reports)
# ---------------------------------------------------------------------------

@test "accounting: waited_seconds is (attempt-1)*poll-seconds and poll_attempts is attempt" {
    ci "[$SUCCESS_LINT]" --attempt 3 --max-attempts 3 --poll-seconds 45
    [ "$(echo "$output" | jq -r '.waited_seconds')" = "90" ]
    [ "$(echo "$output" | jq -r '.poll_attempts')" = "3" ]
}

@test "accounting: first attempt has waited_seconds 0" {
    ci "[$SUCCESS_LINT]" --attempt 1 --max-attempts 3 --poll-seconds 45
    [ "$(echo "$output" | jq -r '.waited_seconds')" = "0" ]
    [ "$(echo "$output" | jq -r '.poll_attempts')" = "1" ]
}

@test "accounting: defaults are attempt 1 / max-attempts 1 / poll-seconds 15" {
    ci "[$PENDING_E2E]"
    [ "$(echo "$output" | jq -r '.waited_seconds')" = "0" ]
    [ "$(echo "$output" | jq -r '.poll_attempts')" = "1" ]
    # max-attempts defaults to 1, so a single-shot call never asks for another poll.
    [ "$(echo "$output" | jq -r '.next_action')" = "done" ]
}

@test "next_action: pending with attempts remaining -> poll" {
    ci "[$PENDING_E2E]" --attempt 1 --max-attempts 3 --poll-seconds 45
    [ "$(echo "$output" | jq -r '.next_action')" = "poll" ]
}

@test "next_action: pending on the final attempt -> done" {
    ci "[$PENDING_E2E]" --attempt 3 --max-attempts 3 --poll-seconds 45
    [ "$(echo "$output" | jq -r '.next_action')" = "done" ]
}

@test "next_action: a settled verdict never asks for another poll" {
    ci "[$SUCCESS_LINT]" --attempt 1 --max-attempts 3 --poll-seconds 45
    [ "$(echo "$output" | jq -r '.next_action')" = "done" ]
}

@test "epoch: emitted as a number on success" {
    ci "[$SUCCESS_LINT]"
    [ "$(echo "$output" | jq -r '.epoch | type')" = "number" ]
}

# ---------------------------------------------------------------------------
# argument validation (deterministic, before gh is run)
# ---------------------------------------------------------------------------

# assert_rejected <message substring>: exit 1 で gh を呼んでいない
assert_rejected() {
    [ "$status" -eq 1 ]
    [[ "$output" == *"$1"* ]]
    [ "$(gh_calls)" = "0" ]
}

@test "validation: --pr is required" {
    run bash "$SCRIPT"
    assert_rejected '--pr'
    run bash "$SCRIPT" --repo acme/skills
    assert_rejected '--pr'
}

@test "validation: --pr that is not a positive integer is rejected without calling gh" {
    for pr in 0 -1 abc 1.5 '' 07 '7 --repo x/y' '7;id'; do
        run bash "$SCRIPT" --pr "$pr" --repo acme/skills
        assert_rejected '--pr'
    done
}

@test "validation: --repo that is not owner/name is rejected without calling gh" {
    for repo in '' acme acme/ /skills a/b/c 'acme/skills --json x' 'acme/sk;ills' '-R/x'; do
        run bash "$SCRIPT" --pr 7 --repo "$repo"
        assert_rejected '--repo'
    done
}

@test "validation: --checks-data / --fetch-error-data are unknown options (exit 1, gh not called)" {
    run bash "$SCRIPT" --pr 7 --checks-data '[]'
    assert_rejected 'Unknown option: --checks-data'
    run bash "$SCRIPT" --checks-data "[$SUCCESS_LINT]"
    assert_rejected 'Unknown option: --checks-data'
    run bash "$SCRIPT" --pr 7 --fetch-error-data 'gh: Not Found (HTTP 404)'
    assert_rejected 'Unknown option: --fetch-error-data'
}

@test "validation: --poll-seconds below 5 is rejected" {
    run bash "$SCRIPT" --pr 7 --poll-seconds 4
    assert_rejected '--poll-seconds'
}

@test "validation: non-numeric --poll-seconds is rejected" {
    run bash "$SCRIPT" --pr 7 --poll-seconds abc
    assert_rejected '--poll-seconds'
}

@test "validation: --attempt 0 is rejected" {
    run bash "$SCRIPT" --pr 7 --attempt 0
    assert_rejected '--attempt'
}

@test "validation: --attempt beyond --max-attempts is rejected" {
    run bash "$SCRIPT" --pr 7 --attempt 4 --max-attempts 3
    assert_rejected 'exceeds'
}

@test "validation: --max-attempts 0 is rejected" {
    run bash "$SCRIPT" --pr 7 --max-attempts 0
    assert_rejected '--max-attempts'
}

@test "validation: implied wait ceiling above 1800s is rejected" {
    run bash "$SCRIPT" --pr 7 --attempt 1 --max-attempts 100 --poll-seconds 60
    assert_rejected '1800'
}

@test "validation: unknown option is rejected" {
    run bash "$SCRIPT" --pr 7 --bogus 1
    assert_rejected 'Unknown option'
}

# ---------------------------------------------------------------------------
# architectural invariant: the only GitHub I/O is one read-only `gh pr view`
# ---------------------------------------------------------------------------

# CMD_POS matches where a command can start (line start, or after ; & | or an
# opening paren such as `$(`). Comments are stripped first, and error strings
# like FETCH_ERR="gh pr view: ..." are not matched because there the name
# follows `"`.
CMD_POS='(^|[;&|(])[[:space:]]*'
# gh の呼び出しとして許すのは `gh pr view ...` と、`pr view` で始まる GH_ARGS 配列の展開だけ
GH_READ_ONLY_CALL='(^|[;&|(])[[:space:]]*gh[[:space:]]+(pr[[:space:]]+view|"\$\{GH_ARGS\[@\]\}")([[:space:])]|$)'
# 書き込み系の gh サブコマンド（argv 配列の要素として書かれた場合も拾うため、コード全体に掛ける）
GH_WRITE='(^|[^[:alnum:]_-])(pr[[:space:]]+(merge|comment|edit|close|create|ready|review|reopen|checkout)|issue[[:space:]]+(create|comment|edit|close|reopen)|api|push|release|workflow[[:space:]]+run|run[[:space:]]+(rerun|cancel))([^[:alnum:]_-]|$)'

# github_io_violations <file>: prints lines that do GitHub / network I/O other than a read-only `gh pr view`
github_io_violations() {
    local code
    code="$(grep -vE '^[[:space:]]*#' "$1")"
    printf '%s\n' "$code" | grep -nE "${CMD_POS}(gh|curl|wget)([[:space:]]|$)" | grep -vE "$GH_READ_ONLY_CALL" || true
    printf '%s\n' "$code" | grep -nE "$GH_WRITE" || true
    printf '%s\n' "$code" | grep -nE '(^|[[:space:]])GH_ARGS=\(' | grep -vE 'GH_ARGS=\(pr[[:space:]]+view[[:space:]]' || true
}

@test "invariant: the script's only gh call is a read-only pr view, and it calls no write-family gh, curl or wget" {
    run github_io_violations "$SCRIPT"
    [ "$status" -eq 0 ]
    [ -z "$output" ]
    # the read-only call does exist (the guard is not vacuous on this script)
    run bash -c "grep -vE '^[[:space:]]*#' '$SCRIPT' | grep -cE '$GH_READ_ONLY_CALL'"
    [ "$output" = "1" ]
}

@test "invariant: the GitHub I/O guard catches write-family gh, other gh reads, and curl (positive control)" {
    # Guards that can never fire are worse than no guard: pin that this one fires.
    probe="$BATS_TEST_TMPDIR/probe.sh"
    for body in \
        'out=$(gh pr merge 1 --squash)' \
        'gh pr comment 1 --body x' \
        'gh pr edit 1 --add-label x' \
        'gh api -X PATCH repos/o/r/issues/1' \
        'git push origin HEAD' \
        'GH_ARGS=(pr view "$PR"); GH_ARGS+=(--repo o/r); GH_ARGS=(pr comment 1)' \
        'GH_ARGS=(issue view 1)' \
        'gh issue view 1' \
        'curl -s https://api.github.com/'; do
        printf '%s\n' '#!/usr/bin/env bash' "$body" >"$probe"
        run github_io_violations "$probe"
        [ -n "$output" ]
    done
    printf '%s\n' '#!/usr/bin/env bash' 'GH_ARGS=(pr view "$PR")' 'out="$(gh "${GH_ARGS[@]}")"' 'FETCH_ERR="gh pr view: x"' >"$probe"
    run github_io_violations "$probe"
    [ -z "$output" ]
}

@test "invariant: the script does not sleep (the caller owns wall-clock waiting)" {
    run bash -c "grep -vE '^[[:space:]]*#' '$SCRIPT' | grep -nE '(^|[;&|(])[[:space:]]*sleep[[:space:]]'"
    [ "$status" -ne 0 ]
}
