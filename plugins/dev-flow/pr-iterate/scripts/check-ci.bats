#!/usr/bin/env bats
# Tests for pr-iterate/scripts/check-ci.sh
#
# issue #488: check-ci.sh is a pure transform over a `gh pr view --json
# statusCheckRollup` snapshot the caller has already fetched. It performs no
# network I/O and no waiting, so these tests need no `gh`/`curl` stub and no
# fake clock — they pass snapshot data via argv and assert on the emitted JSON.
#
# issue #499: the snapshot used to be relayed through $TMPDIR files
# (--checks-json/--fetch-error). Isolation guards reject the redirects a file
# relay requires, so the caller now transcribes `gh`'s stdout/stderr verbatim
# into --checks-data/--fetch-error-data argv strings instead. The tests below
# were rewritten from file writes to argv strings; case coverage is otherwise
# unchanged, plus new cases for the argv-specific edge cases (empty data,
# quoted check names, rejection of the removed file-based options).
#
# Tests removed from the previous (in-script fetch) versions with no successor
# here: gh/curl stub protocols, transient-fetch retry/backoff accounting,
# unauthenticated-request warnings, rate-limit disambiguation, REST pagination
# guards, and PR-reference/owner-repo resolution — all of those existed only
# because the fetch lived inside this script. Fetch failures now reach the
# script as "the snapshot data is not a JSON array" plus the caller's
# transcribed stderr, which is covered below.

setup() {
    SKILLS_REPO="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
    SCRIPT="$SKILLS_REPO/pr-iterate/scripts/check-ci.sh"
}

# rollup の要素。キーは --jq で畳んだ後の形。
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
# verdict derivation
# ---------------------------------------------------------------------------

@test "passed: all SUCCESS -> status passed" {
    run bash "$SCRIPT" --checks-data "[$SUCCESS_LINT,$(check_run test SUCCESS)]"
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.status')" = "passed" ]
    [ "$(echo "$output" | jq -r '.passed')" = "2" ]
    [ "$(echo "$output" | jq -r '.failed')" = "0" ]
}

@test "passed: skipping counts as passed and is also reported as skipped" {
    run bash "$SCRIPT" --checks-data "[$SUCCESS_LINT,$(check_run e2e SKIPPED)]"
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.status')" = "passed" ]
    [ "$(echo "$output" | jq -r '.passed')" = "2" ]
    [ "$(echo "$output" | jq -r '.skipped')" = "1" ]
}

@test "failed: FAILURE -> status failed with failed_checks entry" {
    run bash "$SCRIPT" --checks-data "[$(check_run bats FAILURE)]"
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.status')" = "failed" ]
    [ "$(echo "$output" | jq -r '.failed')" = "1" ]
    [ "$(echo "$output" | jq -r '.failed_checks[0].name')" = "bats" ]
    [ "$(echo "$output" | jq -r '.failed_checks[0].bucket')" = "fail" ]
    [ "$(echo "$output" | jq -r '.failed_checks[0].state')" = "FAILURE" ]
}

@test "failed: CANCELLED is bucket cancel and folds into failed (fail-closed)" {
    run bash "$SCRIPT" --checks-data "[$(check_run build CANCELLED)]"
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.status')" = "failed" ]
    [ "$(echo "$output" | jq -r '.failed')" = "1" ]
    [ "$(echo "$output" | jq -r '.failed_checks[0].bucket')" = "cancel" ]
}

@test "pending: empty conclusion -> status pending with pending_checks entry" {
    run bash "$SCRIPT" --checks-data "[$SUCCESS_LINT,$PENDING_E2E]"
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.status')" = "pending" ]
    [ "$(echo "$output" | jq -r '.pending')" = "1" ]
    echo "$output" | jq -e '.pending_checks == [{"name":"e2e","state":"IN_PROGRESS"}]'
}

@test "pending: failure takes precedence over pending" {
    run bash "$SCRIPT" --checks-data "[$(check_run bats FAILURE),$PENDING_E2E]"
    [ "$(echo "$output" | jq -r '.status')" = "failed" ]
}

# ---------------------------------------------------------------------------
# CheckRun: conclusion decides, status does not (issue #1232 AC-1)
# ---------------------------------------------------------------------------

@test "status left IN_PROGRESS: conclusion SUCCESS -> passed, not pending" {
    run bash "$SCRIPT" --checks-data "[$(check_run lint SUCCESS IN_PROGRESS)]"
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.status')" = "passed" ]
    [ "$(echo "$output" | jq -r '.passed')" = "1" ]
    [ "$(echo "$output" | jq -r '.pending')" = "0" ]
}

@test "status left IN_PROGRESS: conclusion FAILURE -> failed, reported with the conclusion" {
    run bash "$SCRIPT" --checks-data "[$(check_run lint FAILURE IN_PROGRESS)]"
    [ "$(echo "$output" | jq -r '.status')" = "failed" ]
    [ "$(echo "$output" | jq -r '.failed_checks[0].state')" = "FAILURE" ]
}

@test "status IN_PROGRESS with empty conclusion -> pending" {
    run bash "$SCRIPT" --checks-data "[$(check_run lint '' IN_PROGRESS)]"
    [ "$(echo "$output" | jq -r '.status')" = "pending" ]
    [ "$(echo "$output" | jq -r '.pending')" = "1" ]
}

@test "status COMPLETED with empty conclusion -> pending (status is not read)" {
    run bash "$SCRIPT" --checks-data "[$(check_run lint '' COMPLETED)]"
    [ "$(echo "$output" | jq -r '.status')" = "pending" ]
}

@test "the rollup as gh exports it (with __typename, completedAt, urls) classifies the same" {
    run bash "$SCRIPT" --checks-data '[{"__typename":"CheckRun","name":"lint","workflowName":"CI","status":"IN_PROGRESS","conclusion":"SUCCESS","startedAt":"2026-01-01T00:00:00Z","completedAt":"2026-01-01T00:01:00Z","detailsUrl":"https://github.com/o/r/actions/runs/1/job/11"},{"__typename":"StatusContext","context":"vercel","state":"SUCCESS","startedAt":"2026-01-01T00:00:00Z","targetUrl":"https://vercel.example/1"}]'
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.status')" = "passed" ]
    [ "$(echo "$output" | jq -r '.passed')" = "2" ]
}

# ---------------------------------------------------------------------------
# classification table (issue #1232 AC-2)
# ---------------------------------------------------------------------------

# assert_bucket <rollup element> <check name> <expected bucket>。--only を付けずに件数から bucket を確かめる。
assert_bucket() {
    run bash "$SCRIPT" --checks-data "[$1]"
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
    run bash "$SCRIPT" --checks-data "[$SUCCESS_LINT,$(check_run new WHATEVER)]"
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
    run bash "$SCRIPT" --checks-data "[$(check_run bats FAILURE COMPLETED "$EARLY"),$(check_run bats SUCCESS COMPLETED "$LATE")]"
    [ "$(echo "$output" | jq -r '.status')" = "failed" ]
    [ "$(echo "$output" | jq -r '.failed')" = "1" ]
    [ "$(echo "$output" | jq -r '.passed')" = "0" ]
    echo "$output" | jq -e '.failed_checks == [{"name":"bats","bucket":"fail","state":"FAILURE"}]'
}

@test "duplicate CheckRun: a later failure beats an earlier success, in either rollup order" {
    run bash "$SCRIPT" --checks-data "[$(check_run bats SUCCESS COMPLETED "$EARLY"),$(check_run bats FAILURE COMPLETED "$LATE")]"
    [ "$(echo "$output" | jq -r '.status')" = "failed" ]
    run bash "$SCRIPT" --checks-data "[$(check_run bats FAILURE COMPLETED "$LATE"),$(check_run bats SUCCESS COMPLETED "$EARLY")]"
    [ "$(echo "$output" | jq -r '.status')" = "failed" ]
}

@test "duplicate CheckRun: a cancelled run counts as failed and is not erased by a later success" {
    run bash "$SCRIPT" --checks-data "[$(check_run bats CANCELLED COMPLETED "$EARLY"),$(check_run bats SUCCESS COMPLETED "$LATE")]"
    [ "$(echo "$output" | jq -r '.status')" = "failed" ]
    [ "$(echo "$output" | jq -r '.failed_checks[0].bucket')" = "cancel" ]
}

@test "duplicate CheckRun: failed never drops to pending" {
    run bash "$SCRIPT" --checks-data "[$(check_run bats FAILURE COMPLETED "$EARLY"),$(check_run bats '' IN_PROGRESS "$LATE")]"
    [ "$(echo "$output" | jq -r '.status')" = "failed" ]
    [ "$(echo "$output" | jq -r '.pending')" = "0" ]
}

@test "duplicate CheckRun with no failure: the latest startedAt decides" {
    run bash "$SCRIPT" --checks-data "[$(check_run bats SUCCESS COMPLETED "$LATE"),$(check_run bats '' IN_PROGRESS "$EARLY")]"
    [ "$(echo "$output" | jq -r '.status')" = "passed" ]
    [ "$(echo "$output" | jq -r '.passed')" = "1" ]

    run bash "$SCRIPT" --checks-data "[$(check_run bats SUCCESS COMPLETED "$EARLY"),$(check_run bats '' IN_PROGRESS "$LATE")]"
    [ "$(echo "$output" | jq -r '.status')" = "pending" ]
    [ "$(echo "$output" | jq -r '.pending')" = "1" ]
    [ "$(echo "$output" | jq -r '.passed')" = "0" ]
}

@test "duplicate CheckRun: a run that has not started counts as the latest (an old success does not green a queued re-run)" {
    for not_started in 0001-01-01T00:00:00Z ""; do
        run bash "$SCRIPT" --checks-data "[$(check_run bats SUCCESS COMPLETED "$LATE"),$(jq -nc --arg s "$not_started" '{name:"bats",workflowName:"CI",status:"QUEUED",conclusion:"",startedAt:$s}')]"
        [ "$(echo "$output" | jq -r '.status')" = "pending" ]
    done
}

@test "duplicate CheckRun: on the same startedAt a pending run wins over a success, in either rollup order" {
    run bash "$SCRIPT" --checks-data "[$(check_run bats SUCCESS COMPLETED "$EARLY"),$(check_run bats '' IN_PROGRESS "$EARLY")]"
    [ "$(echo "$output" | jq -r '.status')" = "pending" ]
    run bash "$SCRIPT" --checks-data "[$(check_run bats '' IN_PROGRESS "$EARLY"),$(check_run bats SUCCESS COMPLETED "$EARLY")]"
    [ "$(echo "$output" | jq -r '.status')" = "pending" ]
}

@test "same name in a different workflowName is a different check" {
    run bash "$SCRIPT" --checks-data "[$(check_run test FAILURE COMPLETED "$EARLY" A),$(check_run test SUCCESS COMPLETED "$LATE" B)]"
    [ "$(echo "$output" | jq -r '.status')" = "failed" ]
    [ "$(echo "$output" | jq -r '.failed')" = "1" ]
    [ "$(echo "$output" | jq -r '.passed')" = "1" ]
}

@test "duplicate StatusContext: the latest startedAt decides, a later success replaces a failure" {
    run bash "$SCRIPT" --checks-data "[$(status_context vercel FAILURE "$EARLY"),$(status_context vercel SUCCESS "$LATE")]"
    [ "$(echo "$output" | jq -r '.status')" = "passed" ]
    [ "$(echo "$output" | jq -r '.passed')" = "1" ]

    run bash "$SCRIPT" --checks-data "[$(status_context vercel SUCCESS "$EARLY"),$(status_context vercel FAILURE "$LATE")]"
    [ "$(echo "$output" | jq -r '.status')" = "failed" ]
    [ "$(echo "$output" | jq -r '.failed')" = "1" ]
}

# ---------------------------------------------------------------------------
# empty rollup and fetch failures (issue #1232 AC-5)
# ---------------------------------------------------------------------------

@test "no_checks: empty array -> status no_checks (not passed, not error)" {
    run bash "$SCRIPT" --checks-data '[]'
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.status')" = "no_checks" ]
}

@test "no_checks: null rollup -> status no_checks" {
    run bash "$SCRIPT" --checks-data 'null'
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.status')" = "no_checks" ]
    echo "$output" | jq -e '.passed == 0 and .failed == 0 and .pending == 0 and .skipped == 0 and .failed_checks == [] and .pending_checks == []'
}

@test "output keys: the verdict output keeps its keys" {
    run bash "$SCRIPT" --checks-data "[$SUCCESS_LINT]"
    echo "$output" | jq -e 'keys == ["epoch","failed","failed_checks","next_action","passed","pending","pending_checks","poll_attempts","skipped","status","waited_seconds"]'
    run bash "$SCRIPT" --checks-data 'garbage'
    echo "$output" | jq -e 'keys == ["epoch","message","next_action","poll_attempts","status","waited_seconds"]'
}

@test "error: JSON that is not a rollup fails closed" {
    for data in '{}' '"text"' '1' '[1]' '["lint"]' '{"statusCheckRollup":[]}'; do
        run bash "$SCRIPT" --checks-data "$data"
        [ "$status" -eq 1 ]
        [ "$(echo "$output" | jq -r '.status')" = "error" ]
    done
}

@test "error: non-array data + auth/network fetch-error-data -> status error, exit 1" {
    run bash "$SCRIPT" --checks-data '' --fetch-error-data 'gh: Not Found (HTTP 404)'
    [ "$status" -eq 1 ]
    [ "$(echo "$output" | jq -r '.status')" = "error" ]
    [[ "$(echo "$output" | jq -r '.message')" == *"404"* ]]
}

@test "error: non-array data with no fetch-error-data still fails closed" {
    run bash "$SCRIPT" --checks-data 'garbage'
    [ "$status" -eq 1 ]
    [ "$(echo "$output" | jq -r '.status')" = "error" ]
}

@test "error: empty --checks-data with no --fetch-error-data -> error" {
    run bash "$SCRIPT" --checks-data ''
    [ "$status" -eq 1 ]
    [ "$(echo "$output" | jq -r '.status')" = "error" ]
}

@test "error: error output still carries the bounded-wait accounting keys" {
    run bash "$SCRIPT" --checks-data '' --fetch-error-data 'gh: Not Found (HTTP 404)' --attempt 2 --max-attempts 3 --poll-seconds 45
    [ "$status" -eq 1 ]
    [ "$(echo "$output" | jq -r '.waited_seconds')" = "45" ]
    [ "$(echo "$output" | jq -r '.poll_attempts')" = "2" ]
    [ "$(echo "$output" | jq -r '.next_action')" = "done" ]
}

@test "error: arbitrary non-array fetch-error-data is reflected in the message" {
    run bash "$SCRIPT" --checks-data 'not json' --fetch-error-data 'some transient network hiccup'
    [ "$status" -eq 1 ]
    [ "$(echo "$output" | jq -r '.status')" = "error" ]
    [[ "$(echo "$output" | jq -r '.message')" == *"transient network hiccup"* ]]
}

# ---------------------------------------------------------------------------
# argv transcription edge cases (issue #499)
# ---------------------------------------------------------------------------

@test "argv: check name containing a single quote parses correctly" {
    run bash "$SCRIPT" --checks-data '[{"name":"lint'"'"'s check","conclusion":"SUCCESS"}]'
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.status')" = "passed" ]
    [ "$(echo "$output" | jq -r '.passed')" = "1" ]
}

@test "argv: check name containing a double quote parses correctly" {
    run bash "$SCRIPT" --checks-data '[{"name":"say \"hi\" check","conclusion":"SUCCESS"}]'
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
    run bash "$SCRIPT" --checks-data "$SNAPSHOT_WITH_E2E" --exclude e2e
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.status')" = "passed" ]
    [ "$(echo "$output" | jq -r '.pending')" = "0" ]
    echo "$output" | jq -e 'has("passed_checks") | not'
}

@test "filter: --only keeps just the named checks and reports passed_checks with link" {
    run bash "$SCRIPT" --checks-data "$SNAPSHOT_WITH_E2E" --only e2e
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.status')" = "pending" ]
    [ "$(echo "$output" | jq -r '.passed')" = "0" ]
    echo "$output" | jq -e '.pending_checks == [{"name":"e2e","state":"IN_PROGRESS","link":"https://github.com/o/r/actions/runs/2/job/22"}]'
    echo "$output" | jq -e '.passed_checks == []'

    run bash "$SCRIPT" --checks-data "[$SUCCESS_LINT,$(check_run e2e SUCCESS COMPLETED "$EARLY" CI "$E2E_URL")]" --only e2e
    [ "$(echo "$output" | jq -r '.status')" = "passed" ]
    echo "$output" | jq -e '.passed_checks == [{"name":"e2e","bucket":"pass","state":"SUCCESS","link":"https://github.com/o/r/actions/runs/2/job/22"}]'

    run bash "$SCRIPT" --checks-data "[$(check_run e2e FAILURE COMPLETED "$EARLY" CI "$E2E_URL")]" --only e2e
    [ "$(echo "$output" | jq -r '.status')" = "failed" ]
    echo "$output" | jq -e '.failed_checks[0].link == "https://github.com/o/r/actions/runs/2/job/22"'

    # StatusContext の URL は targetUrl
    run bash "$SCRIPT" --checks-data "[$(status_context e2e SUCCESS "$EARLY" "$E2E_URL")]" --only e2e
    echo "$output" | jq -e '.passed_checks[0].link == "https://github.com/o/r/actions/runs/2/job/22"'
}

@test "filter: --only / --exclude see the check after duplicates are settled" {
    rollup="[$(check_run e2e FAILURE COMPLETED "$EARLY"),$(check_run e2e SUCCESS COMPLETED "$LATE"),$SUCCESS_LINT]"
    run bash "$SCRIPT" --checks-data "$rollup" --only e2e
    [ "$(echo "$output" | jq -r '.status')" = "failed" ]
    run bash "$SCRIPT" --checks-data "$rollup" --exclude e2e
    [ "$(echo "$output" | jq -r '.status')" = "passed" ]
    [ "$(echo "$output" | jq -r '.passed')" = "1" ]
}

@test "filter: --only never counts a skipped check as passed (label-gated e2e skipped on this run -> pending, not in passed_checks)" {
    run bash "$SCRIPT" --checks-data "[$SUCCESS_LINT,$(check_run e2e SKIPPED COMPLETED "$EARLY" CI "$E2E_URL")]" --only e2e
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.status')" = "pending" ]
    [ "$(echo "$output" | jq -r '.passed')" = "0" ]
    [ "$(echo "$output" | jq -r '.pending')" = "1" ]
    [ "$(echo "$output" | jq -r '.skipped')" = "1" ]
    echo "$output" | jq -e '.passed_checks == []'
    echo "$output" | jq -e '.pending_checks == [{"name":"e2e","state":"SKIPPED","link":"https://github.com/o/r/actions/runs/2/job/22"}]'

    # without --only a skipped check still folds into passed (round gate behaviour unchanged)
    run bash "$SCRIPT" --checks-data "[$SUCCESS_LINT,$(check_run e2e SKIPPED)]"
    [ "$(echo "$output" | jq -r '.status')" = "passed" ]
    [ "$(echo "$output" | jq -r '.passed')" = "2" ]
}

@test "filter: --only on a check that is not registered yet -> no_checks" {
    run bash "$SCRIPT" --checks-data "[$SUCCESS_LINT]" --only e2e
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.status')" = "no_checks" ]
    echo "$output" | jq -e '.passed_checks == []'
}

@test "argv: removed --checks-json option is rejected as Unknown option" {
    run bash "$SCRIPT" --checks-json /tmp/whatever.json
    [ "$status" -eq 1 ]
    [[ "$output" == *"Unknown option"* ]]
}

@test "argv: removed --fetch-error option is rejected as Unknown option" {
    run bash "$SCRIPT" --checks-data '[]' --fetch-error /tmp/whatever.txt
    [ "$status" -eq 1 ]
    [[ "$output" == *"Unknown option"* ]]
}

# ---------------------------------------------------------------------------
# bounded-wait accounting (the caller polls; the script only reports)
# ---------------------------------------------------------------------------

@test "accounting: waited_seconds is (attempt-1)*poll-seconds and poll_attempts is attempt" {
    run bash "$SCRIPT" --checks-data "[$SUCCESS_LINT]" --attempt 3 --max-attempts 3 --poll-seconds 45
    [ "$(echo "$output" | jq -r '.waited_seconds')" = "90" ]
    [ "$(echo "$output" | jq -r '.poll_attempts')" = "3" ]
}

@test "accounting: first attempt has waited_seconds 0" {
    run bash "$SCRIPT" --checks-data "[$SUCCESS_LINT]" --attempt 1 --max-attempts 3 --poll-seconds 45
    [ "$(echo "$output" | jq -r '.waited_seconds')" = "0" ]
    [ "$(echo "$output" | jq -r '.poll_attempts')" = "1" ]
}

@test "accounting: defaults are attempt 1 / max-attempts 1 / poll-seconds 15" {
    run bash "$SCRIPT" --checks-data "[$PENDING_E2E]"
    [ "$(echo "$output" | jq -r '.waited_seconds')" = "0" ]
    [ "$(echo "$output" | jq -r '.poll_attempts')" = "1" ]
    # max-attempts defaults to 1, so a single-shot call never asks for another poll.
    [ "$(echo "$output" | jq -r '.next_action')" = "done" ]
}

@test "next_action: pending with attempts remaining -> poll" {
    run bash "$SCRIPT" --checks-data "[$PENDING_E2E]" --attempt 1 --max-attempts 3 --poll-seconds 45
    [ "$(echo "$output" | jq -r '.next_action')" = "poll" ]
}

@test "next_action: pending on the final attempt -> done" {
    run bash "$SCRIPT" --checks-data "[$PENDING_E2E]" --attempt 3 --max-attempts 3 --poll-seconds 45
    [ "$(echo "$output" | jq -r '.next_action')" = "done" ]
}

@test "next_action: a settled verdict never asks for another poll" {
    run bash "$SCRIPT" --checks-data "[$SUCCESS_LINT]" --attempt 1 --max-attempts 3 --poll-seconds 45
    [ "$(echo "$output" | jq -r '.next_action')" = "done" ]
}

@test "epoch: emitted as a number on success" {
    run bash "$SCRIPT" --checks-data "[$SUCCESS_LINT]"
    [ "$(echo "$output" | jq -r '.epoch | type')" = "number" ]
}

# ---------------------------------------------------------------------------
# argument validation (deterministic, before any snapshot parsing)
# ---------------------------------------------------------------------------

@test "validation: --checks-data is required" {
    run bash "$SCRIPT"
    [ "$status" -eq 1 ]
    [[ "$output" == *"--checks-data"* ]]
}

@test "validation: --poll-seconds below 5 is rejected" {
    run bash "$SCRIPT" --checks-data '[]' --poll-seconds 4
    [ "$status" -eq 1 ]
    [[ "$output" == *"--poll-seconds"* ]]
}

@test "validation: non-numeric --poll-seconds is rejected" {
    run bash "$SCRIPT" --checks-data '[]' --poll-seconds abc
    [ "$status" -eq 1 ]
    [[ "$output" == *"--poll-seconds"* ]]
}

@test "validation: --attempt 0 is rejected" {
    run bash "$SCRIPT" --checks-data '[]' --attempt 0
    [ "$status" -eq 1 ]
    [[ "$output" == *"--attempt"* ]]
}

@test "validation: --attempt beyond --max-attempts is rejected" {
    run bash "$SCRIPT" --checks-data '[]' --attempt 4 --max-attempts 3
    [ "$status" -eq 1 ]
    [[ "$output" == *"exceeds"* ]]
}

@test "validation: --max-attempts 0 is rejected" {
    run bash "$SCRIPT" --checks-data '[]' --max-attempts 0
    [ "$status" -eq 1 ]
    [[ "$output" == *"--max-attempts"* ]]
}

@test "validation: implied wait ceiling above 1800s is rejected" {
    run bash "$SCRIPT" --checks-data '[]' --attempt 1 --max-attempts 100 --poll-seconds 60
    [ "$status" -eq 1 ]
    [[ "$output" == *"1800"* ]]
}

@test "validation: unknown option is rejected" {
    run bash "$SCRIPT" --checks-data '[]' --bogus 1
    [ "$status" -eq 1 ]
    [[ "$output" == *"Unknown option"* ]]
}

# ---------------------------------------------------------------------------
# architectural invariant (issue #488)
# ---------------------------------------------------------------------------

# NET_CMD_AT_COMMAND_POSITION matches gh/curl/wget only where a command can
# start (line start, or after ; & | or an opening paren such as `$(`). Comments
# are stripped first, and error strings like FETCH_ERR="gh pr view: ..." are
# not matched because there the name follows `="`.
NET_CMD_AT_COMMAND_POSITION='(^|[;&|(])[[:space:]]*(gh|curl|wget)[[:space:]]'

@test "invariant: the script performs no network I/O of its own" {
    # An exec-proxy script must not carry authenticated network I/O: correctness
    # would then depend on how the script was launched. Fetching belongs to the caller.
    run bash -c "grep -vE '^[[:space:]]*#' '$SCRIPT' | grep -nE '$NET_CMD_AT_COMMAND_POSITION'"
    [ "$status" -ne 0 ]
}

@test "invariant: the network-I/O guard actually catches an invocation (positive control)" {
    # Guards that can never fire are worse than no guard: pin that this one fires.
    probe="$BATS_TMPDIR/probe.sh"
    printf '%s\n' '#!/usr/bin/env bash' 'out=$(gh pr view 1 --json statusCheckRollup)' > "$probe"
    run bash -c "grep -vE '^[[:space:]]*#' '$probe' | grep -nE '$NET_CMD_AT_COMMAND_POSITION'"
    [ "$status" -eq 0 ]
}

@test "invariant: the script does not sleep (the caller owns wall-clock waiting)" {
    run bash -c "grep -vE '^[[:space:]]*#' '$SCRIPT' | grep -nE '(^|[;&|(])[[:space:]]*sleep[[:space:]]'"
    [ "$status" -ne 0 ]
}
