#!/usr/bin/env bash
# check-ci.sh - Read a PR's head sha and CI rollup with one `gh pr view` and classify the CI status.
# Usage: check-ci.sh --pr <N> [--repo <owner/name>]
#                    [--attempt N] [--max-attempts K] [--poll-seconds M]
#                    [--only <check name>]... [--exclude <check name>]...
#                    [--wait <seconds>]
#
# The script runs gh exactly once, as an argv array (no shell string, no eval):
#
#   gh pr view <N> [--repo <owner/name>] --json headRefOid,statusCheckRollup
#
# gh is read-only here and authenticates from its own credential store. The
# head sha and the rollup come from the same response, so the verdict always
# belongs to the reported head_sha. The caller (the stdout-relay subagent) runs
# this script as one bare statement and relays its stdout; it neither fetches
# the rollup nor transcribes it into argv, so a transcription slip on the way in
# cannot turn into a wrong verdict. The script never re-fetches and never
# writes anything to GitHub: the caller owns polling.
#
# --wait <seconds> (optional) first waits exactly like ci-wait (it runs
# ci-wait.sh: a chain of short sleeps, so the relay's Bash call is one bare
# `check-ci` statement instead of a rejected long bare sleep), then fetches
# once and adds "slept": true to the output (the error output included). When
# the wait does not complete, gh is not run and the output is
#   {"slept":false,"status":"pending","passed":0,"failed":0,"pending":0,"skipped":0}
# (exit 0), so the caller neither counts the wait nor takes a verdict from it.
# The wait plus the fetch must fit in the Bash tool's default timeout (120s),
# so --wait must be an integer 1..WAIT_SECONDS_MAX; anything else exits 1
# before waiting. One wait and one fetch per run: there is no retry loop.
#
# --pr must be a positive integer and --repo (optional; without it gh uses the
# cwd's repo) must be owner/name. Invalid arguments exit 1 before gh is run.
#
# --only / --exclude (repeatable, issue #861) narrow the snapshot by exact check
# name before the verdict is derived. pr-iterate uses --exclude for the
# review-round CI gate and --only for the post-LGTM wait on the checks a repo
# declared in "dev-flow".ci_verify (sandbox-unreachable verification such as
# E2E, which runs far longer than the round gate's wait ceiling). When --only
# is given the output also carries passed_checks, and every reported check
# keeps its `link` when the rollup has one (detailsUrl / targetUrl) so the
# caller can record the check run URL as AC evidence.
#
# Exits 0 when CI status is determined (passed/failed/pending/no_checks).
# Exits 1 with status "error" when the snapshot is unusable, and when argument
# validation fails. CI state is reported via stdout JSON so the caller can
# treat pending != failure.
#
# Fail-closed: the snapshot is unusable — status "error", never a verdict — when
# gh exits non-zero, its stdout is not a JSON object, headRefOid is not a
# 40-hex commit sha, or statusCheckRollup is neither an array of objects nor
# null. The message carries up to the first 3 lines of gh's stderr. The verdict
# is never derived from gh's exit code.
#
# _shared/scripts/ci-rollup.jq reduces the rollup to one {name, state, bucket}
# per check (merge-tier-facts.sh uses the same file, so the CI gate and the
# Merge tier cannot classify differently; the classification table and the
# duplicate rule live there). Verdict derivation is then a pure function of
# `bucket` (pass/fail/pending/skipping/cancel): `cancel` is folded into
# "failed" (fail-closed) and `skipping` is folded into "passed" (+ a separate
# skipped count; with --only it is folded into "pending" instead — see
# compute_verdict). A conclusion / state the table does not know is bucket
# "fail", so an unrecognized value can never read as green. A rollup of null
# or [] reads as no_checks.
#
# Bounded-wait accounting (the caller polls; this script only reports it):
# --attempt N (default 1): 1-based index of the caller's current poll attempt.
#   Reported verbatim as poll_attempts.
# --poll-seconds M (default 15): the caller's sleep interval between attempts.
#   Must be an integer >= 5.
# --max-attempts K (default 1): the caller's total attempt budget. Must be an
#   integer 1-120, and --attempt must not exceed it. (K-1)*M is the implied
#   wait ceiling and must not exceed 1800s.
# waited_seconds is derived as (N-1)*M — the wall-clock the caller has slept by
# the time it took this snapshot. Re-fetch retries after a failed fetch must NOT
# advance --attempt, so fetch-error retries never consume waited_seconds.
#
# Output JSON:
#   { "status": "passed" | "failed" | "pending" | "no_checks",
#     "passed": N, "failed": N, "pending": N, "skipped": N,
#     "failed_checks": [...], "pending_checks": [...], "head_sha": "<40 hex>",
#     "waited_seconds": N, "poll_attempts": N,
#     "epoch": N | null, "next_action": "poll" | "done" }
#   { "status": "error", "message": "...", "waited_seconds": N, "poll_attempts": N,
#     "epoch": N | null, "next_action": "done" }
# With --wait both carry "slept": true as well (and a wait that did not complete
# prints only the fixed slept:false object above).
#
# "next_action" tells the caller whether to sleep --poll-seconds and re-fetch
# ("poll", emitted only when status is "pending" and attempt < max-attempts) or
# to stop and report ("done"). It exists so the caller does not have to re-derive
# the polling condition from status; it is additive and callers that ignore it
# keep the pre-existing contract.
#
# "epoch" is `date +%s` taken immediately before the JSON is emitted (present
# on every status, including "error"). If `date +%s` fails, epoch is emitted
# as JSON null instead of failing the script (fail-open; exit code and every
# other key are unaffected).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# _lib/common.sh は playpark-core plugin にある。core の bin/journal（PATH）を起点に解決する（plugin 境界を ../ で跨がない）
_CORE_BIN="$(command -v journal)" || { echo "playpark-core plugin (bin/journal) not on PATH" >&2; exit 127; }
source "$(dirname "$_CORE_BIN")/../_lib/common.sh"

require_cmd jq

PR=""
REPO=""
HAVE_REPO=0
ATTEMPT=1
MAX_ATTEMPTS=1
POLL_SECONDS=15
ONLY_JSON='[]'
EXCLUDE_JSON='[]'
WAIT=""
HAVE_WAIT=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        --pr) PR="$2"; shift 2 ;;
        --repo) REPO="$2"; HAVE_REPO=1; shift 2 ;;
        --only) ONLY_JSON="$(jq -c --arg n "$2" '. + [$n]' <<<"$ONLY_JSON")"; shift 2 ;;
        --exclude) EXCLUDE_JSON="$(jq -c --arg n "$2" '. + [$n]' <<<"$EXCLUDE_JSON")"; shift 2 ;;
        --attempt) ATTEMPT="$2"; shift 2 ;;
        --max-attempts) MAX_ATTEMPTS="$2"; shift 2 ;;
        --poll-seconds) POLL_SECONDS="$2"; shift 2 ;;
        --wait) WAIT="$2"; HAVE_WAIT=1; shift 2 ;;
        *) die_json "Unknown option: $1" 1 ;;
    esac
done

# Validation (deterministic, before gh is run).
POLL_MIN=5
WAIT_MAX=1800
ATTEMPTS_MAX=120
[[ -n "$PR" ]] || die_json "--pr <N> required" 1
[[ "$PR" =~ ^[1-9][0-9]*$ ]] || die_json "Invalid --pr: $PR. Must be a positive integer" 1
if (( HAVE_REPO == 1 )); then
    [[ "$REPO" =~ ^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9_.-]+$ ]] || die_json "Invalid --repo: $REPO. Must be owner/name" 1
fi
[[ "$ATTEMPT" =~ ^[0-9]+$ ]] || die_json "Invalid --attempt: $ATTEMPT. Must be an integer >= 1" 1
(( ATTEMPT >= 1 )) || die_json "Invalid --attempt: $ATTEMPT. Must be an integer >= 1" 1
[[ "$MAX_ATTEMPTS" =~ ^[0-9]+$ ]] || die_json "Invalid --max-attempts: $MAX_ATTEMPTS. Must be an integer 1-${ATTEMPTS_MAX}" 1
(( MAX_ATTEMPTS >= 1 && MAX_ATTEMPTS <= ATTEMPTS_MAX )) || die_json "Invalid --max-attempts: $MAX_ATTEMPTS. Must be an integer 1-${ATTEMPTS_MAX}" 1
(( ATTEMPT <= MAX_ATTEMPTS )) || die_json "Invalid --attempt: $ATTEMPT exceeds --max-attempts $MAX_ATTEMPTS" 1
[[ "$POLL_SECONDS" =~ ^[0-9]+$ ]] || die_json "Invalid --poll-seconds: $POLL_SECONDS. Must be an integer >= ${POLL_MIN}" 1
(( POLL_SECONDS >= POLL_MIN )) || die_json "Invalid --poll-seconds: $POLL_SECONDS. Must be an integer >= ${POLL_MIN}" 1
(( (MAX_ATTEMPTS - 1) * POLL_SECONDS <= WAIT_MAX )) || die_json "Invalid wait budget: (--max-attempts - 1) * --poll-seconds must be <= ${WAIT_MAX}" 1
# --wait の上限: 待機 + gh の取得が Bash tool の既定 timeout（120 秒）に収まる長さ
WAIT_SECONDS_MAX=100
if (( HAVE_WAIT == 1 )); then
    [[ "$WAIT" =~ ^[1-9][0-9]{0,2}$ ]] && (( WAIT <= WAIT_SECONDS_MAX )) \
        || die_json "Invalid --wait: $WAIT. Must be an integer 1-${WAIT_SECONDS_MAX} (wait + fetch must fit the 120s Bash timeout)" 1
fi

WAITED=$(( (ATTEMPT - 1) * POLL_SECONDS ))

GH_ARGS=(pr view "$PR")
if (( HAVE_REPO == 1 )); then
    GH_ARGS+=(--repo "$REPO")
fi
GH_ARGS+=(--json headRefOid,statusCheckRollup)

GH_STDERR="$(mktemp "${TMPDIR:-/tmp}/check-ci-stderr.XXXXXX")"
trap 'rm -f "$GH_STDERR"' EXIT

# epoch_field - prints the current `date +%s` as a bare JSON number, or the
# JSON literal `null` if `date +%s` fails. Called once per JSON emission site
# (never cached), so its output can be spliced directly into printf/jq output
# without further quoting: both a digit string and the literal `null` are
# valid unquoted JSON.
epoch_field() {
    local e
    e=$(date +%s 2>/dev/null) || true
    if [[ "$e" =~ ^[0-9]+$ ]]; then
        printf '%s' "$e"
    else
        printf 'null'
    fi
}

# fetch_error <reason> - sets FETCH_ERR to "gh pr view: <reason>", followed by
# up to the first 3 lines of gh's stderr when there are any.
fetch_error() {
    local stderr_head
    stderr_head="$(head -3 "$GH_STDERR" 2>/dev/null | tr '\n' ' ' || true)"
    FETCH_ERR="gh pr view: $1"
    if [[ -n "${stderr_head// /}" ]]; then
        FETCH_ERR+=": ${stderr_head% }"
    fi
}

# read_snapshot - runs gh once and reduces its response to HEAD_SHA and
# CHECKS_JSON (through ci-rollup.jq). A response it does not accept is a
# failed fetch (FETCH_ERR set, return 1).
read_snapshot() {
    local out rc=0
    CHECKS_JSON="[]"
    HEAD_SHA=""
    FETCH_ERR=""
    out="$(gh "${GH_ARGS[@]}" 2>"$GH_STDERR")" || rc=$?
    if (( rc != 0 )); then
        fetch_error "exit $rc"
        return 1
    fi
    if ! printf '%s' "$out" | jq -e 'type == "object"' >/dev/null 2>&1; then
        fetch_error "stdout is not a JSON object"
        return 1
    fi
    if ! HEAD_SHA="$(printf '%s' "$out" | jq -er '.headRefOid | select(type == "string" and test("^[0-9a-fA-F]{40}$"))' 2>/dev/null)"; then
        HEAD_SHA=""
        fetch_error "headRefOid is not a 40-hex commit sha"
        return 1
    fi
    if ! CHECKS_JSON="$(printf '%s' "$out" | jq -c 'if has("statusCheckRollup") then .statusCheckRollup else error("no statusCheckRollup") end' 2>/dev/null \
        | jq -ce -f "$SCRIPT_DIR/../../_shared/scripts/ci-rollup.jq" 2>/dev/null)"; then
        CHECKS_JSON="[]"
        fetch_error "statusCheckRollup is not an array of checks or null"
        return 1
    fi
    return 0
}

# compute_verdict - reduces $CHECKS_JSON to $result_json / $status.
# bucket field values: pass | fail | pending | skipping | cancel
# is_passed:  bucket IN("pass", "skipping")   — completed successfully or intentionally skipped
#             (with --only: bucket == "pass" only)
# is_pending: bucket == "pending"             — still running
#             (with --only: bucket IN("pending", "skipping"))
# is_failed:  bucket IN("fail", "cancel")     — failed, cancelled, or unrecognized by ci-rollup.jq
#
# --only / --exclude filter the snapshot by exact name first (--only keeps the
# named checks, --exclude drops them); the verdict is then derived from what
# is left, so a filter that leaves nothing reads as no_checks. `link` is kept
# on each reported check only when the snapshot carries it.
# With --only a skipped check is pending, never passed: --only waits on checks
# whose success is AC evidence, and a check skipped on this run (e.g. an E2E
# job gated on a label the triggering event did not carry) verified nothing.
# passed_checks therefore holds bucket "pass" only.
compute_verdict() {
    result_json=$(printf '%s' "$CHECKS_JSON" | jq -c --argjson only "$ONLY_JSON" --argjson exclude "$EXCLUDE_JSON" '
      def only_mode:  ($only | length) > 0;
      def is_passed:  if only_mode then .bucket == "pass" else .bucket | IN("pass", "skipping") end;
      def is_pending: if only_mode then .bucket | IN("pending", "skipping") else .bucket == "pending" end;
      def is_failed:  .bucket | IN("fail", "cancel");
      def with_link:  if (.link | type) == "string" and .link != "" then {link} else {} end;
      def passed_checks_field:
        if only_mode then {passed_checks: [.[] | select(is_passed) | {name, bucket, state} + with_link]} else {} end;

      [.[] | . as $c
           | select((($only | length) == 0) or ($only | any(. == $c.name)))
           | select($exclude | any(. == $c.name) | not)] |
      if length == 0 then
        {status: "no_checks", passed: 0, failed: 0, pending: 0, skipped: 0,
         failed_checks: [], pending_checks: []} + passed_checks_field
      else
        {
          passed:  ([.[] | select(is_passed)]  | length),
          failed:  ([.[] | select(is_failed)]  | length),
          pending: ([.[] | select(is_pending)] | length),
          skipped: ([.[] | select(.bucket == "skipping")] | length),
          failed_checks:  [.[] | select(is_failed)  | {name, bucket, state} + with_link],
          pending_checks: [.[] | select(is_pending) | {name, state} + with_link]
        } + passed_checks_field |
        . + {
          status: (if .failed > 0 then "failed"
                   elif .pending > 0 then "pending"
                   else "passed" end)
        }
      end
    ')
    status=$(printf '%s' "$result_json" | jq -r '.status')
}

# --wait: ci-wait.sh と同じ待機（短い sleep の連結）を 1 回。成立しなければ gh を呼ばずに slept:false を出して終える
SLEPT_JSON='{}'
if (( HAVE_WAIT == 1 )); then
    wait_out=""
    if ! wait_out="$(bash "$SCRIPT_DIR/ci-wait.sh" "$WAIT" 2>/dev/null)" \
        || ! jq -e '.slept == true' >/dev/null 2>&1 <<<"$wait_out"; then
        printf '{"slept":false,"status":"pending","passed":0,"failed":0,"pending":0,"skipped":0}\n'
        exit 0
    fi
    SLEPT_JSON='{"slept":true}'
fi

if ! read_snapshot; then
    printf '%s' "$SLEPT_JSON" | jq -c \
        --arg m "$FETCH_ERR" \
        --argjson w "$WAITED" \
        --argjson p "$ATTEMPT" \
        --argjson e "$(epoch_field)" \
        '. + {status:"error", message:$m, waited_seconds:$w, poll_attempts:$p, epoch:$e, next_action:"done"}'
    exit 1
fi

compute_verdict

NEXT_ACTION="done"
if [[ "$status" == "pending" ]] && (( ATTEMPT < MAX_ATTEMPTS )); then
    NEXT_ACTION="poll"
fi

printf '%s' "$result_json" | jq -c \
    --arg h "$HEAD_SHA" \
    --argjson w "$WAITED" \
    --argjson p "$ATTEMPT" \
    --argjson e "$(epoch_field)" \
    --arg n "$NEXT_ACTION" \
    --argjson s "$SLEPT_JSON" \
    '$s + . + {head_sha:$h, waited_seconds:$w, poll_attempts:$p, epoch:$e, next_action:$n}'
