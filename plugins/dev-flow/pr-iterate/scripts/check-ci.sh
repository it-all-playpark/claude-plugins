#!/usr/bin/env bash
# check-ci.sh - Classify PR CI status from a `gh pr checks` snapshot.
# Usage: check-ci.sh --checks-data <string> [--fetch-error-data <string>]
#                    [--attempt N] [--max-attempts K] [--poll-seconds M]
#                    [--only <check name>]... [--exclude <check name>]...
#
# --only / --exclude (repeatable, issue #861) narrow the snapshot by exact check
# name before the verdict is derived. pr-iterate uses --exclude for the
# review-round CI gate and --only for the post-LGTM wait on the checks a repo
# declared in "dev-flow".ci_verify (sandbox-unreachable verification such as
# E2E, which runs far longer than the round gate's wait ceiling). When --only
# is given the output also carries passed_checks, and every reported check
# keeps its `link` when the snapshot has one (fetch with --json ...,link) so
# the caller can record the check run URL as AC evidence.
#
# Exits 0 when CI status is determined (passed/failed/pending/no_checks).
# Exits 1 when the snapshot is unusable (the caller's fetch failed) or when
# argument validation fails.
# CI state is reported via stdout JSON so the caller can treat pending != failure.
#
# PURE TRANSFORM — this script performs no network I/O and no wall-clock waiting.
# It reduces a snapshot string the caller already fetched to the output
# contract below. The caller owns fetching, sleeping, and relaying the
# snapshot as argv data (two bare, single-statement commands — no file relay,
# no redirection, no pipes):
#
#   gh pr checks <pr> --repo <owner/repo> --json name,state,bucket
#   check-ci.sh --checks-data '<that stdout, verbatim>' \
#     --fetch-error-data '<that stderr, verbatim, if the gh call failed>' \
#     --attempt <n> --max-attempts <k> --poll-seconds <m>
#
# This script trusts that the caller transcribes `gh`'s stdout/stderr
# verbatim into --checks-data/--fetch-error-data — it has no way to verify
# the transcription against the original `gh` output. --json is kept to the
# minimal fields (name,state,bucket) specifically to keep the transcribed
# payload small, which keeps the transcription-corruption surface small.
# Quote breakage or partial transcription during the caller's argv relay is
# not silently swallowed: a corrupted --checks-data value fails to parse as a
# JSON array and falls into the same "error" path as a genuine fetch failure
# (fail-safe), so it can never read as a false "passed".
#
# issue #488: the fetch used to live inside this script — first as curl+REST
# (authenticated only via a GH_TOKEN/GITHUB_TOKEN env var, so private repos
# returned HTTP 404 and every run misreported status=error), then briefly as an
# in-script `gh` call. Both are wrong here: an exec-proxy script must not carry
# authenticated network I/O, because `gh` reading its own credential store from
# inside a script makes correctness depend on how the script was launched. The
# fetch therefore belongs to the caller, which runs `gh` directly; `gh`
# authenticates from its own credential store, so private repo CI state is read
# correctly with no token plumbed across the workflow/agent boundary.
#
# issue #499: the snapshot used to be relayed through $TMPDIR files
# (--checks-json <file> / --fetch-error <file>, written via shell redirection
# from the caller's `gh` invocation). It is now relayed as argv data instead,
# so the caller's whole interaction is two single statements (the `gh` call,
# then this script) with no redirection, pipe, or compound command in
# between.
#
# Verdict derivation is a pure function of the `bucket` field in
# `gh pr checks --json ...`'s output (pass/fail/pending/skipping/cancel);
# `cancel` is folded into "failed" (fail-closed) and `skipping` is folded
# into "passed" (+ a separate skipped count; with --only it is folded into
# "pending" instead — see compute_verdict). Any bucket value outside this
# known 5-value vocabulary is also folded into "failed" (fail-closed): if
# `gh` ever emits a new bucket, an unrecognized value must never fall
# through the passed/failed/pending partition uncounted and let the
# `else -> "passed"` default paper over it (that would be wrong-green).
#
# The verdict is never derived from gh's exit code, and the caller must not
# gate on it either: `gh pr checks` exits 8 while checks are pending and exits
# 1 when any check has failed, so treating a non-zero exit as a fetch failure
# would misclassify pending/failed runs as "error" (the bug class fixed by
# c7ada02). A snapshot is only treated as failed when --checks-data does not
# parse as a JSON array and --fetch-error-data does not indicate there were
# no checks to report.
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
#   { "status": "passed" | "failed" | "pending" | "no_checks" | "error",
#     "passed": N, "failed": N, "pending": N, "skipped": N,
#     "failed_checks": [...], "pending_checks": [...],
#     "waited_seconds": N, "poll_attempts": N,
#     "epoch": N | null, "next_action": "poll" | "done" }
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

CHECKS_DATA=""
HAVE_CHECKS_DATA=0
FETCH_ERR_DATA=""
ATTEMPT=1
MAX_ATTEMPTS=1
POLL_SECONDS=15
ONLY_JSON='[]'
EXCLUDE_JSON='[]'
while [[ $# -gt 0 ]]; do
    case "$1" in
        --checks-data) CHECKS_DATA="$2"; HAVE_CHECKS_DATA=1; shift 2 ;;
        --only) ONLY_JSON="$(jq -c --arg n "$2" '. + [$n]' <<<"$ONLY_JSON")"; shift 2 ;;
        --exclude) EXCLUDE_JSON="$(jq -c --arg n "$2" '. + [$n]' <<<"$EXCLUDE_JSON")"; shift 2 ;;
        --fetch-error-data) FETCH_ERR_DATA="$2"; shift 2 ;;
        --attempt) ATTEMPT="$2"; shift 2 ;;
        --max-attempts) MAX_ATTEMPTS="$2"; shift 2 ;;
        --poll-seconds) POLL_SECONDS="$2"; shift 2 ;;
        *) die_json "Unknown option: $1" 1 ;;
    esac
done

# Validation (deterministic, before anything else).
POLL_MIN=5
WAIT_MAX=1800
ATTEMPTS_MAX=120
(( HAVE_CHECKS_DATA == 1 )) || die_json "--checks-data <string> required" 1
[[ "$ATTEMPT" =~ ^[0-9]+$ ]] || die_json "Invalid --attempt: $ATTEMPT. Must be an integer >= 1" 1
(( ATTEMPT >= 1 )) || die_json "Invalid --attempt: $ATTEMPT. Must be an integer >= 1" 1
[[ "$MAX_ATTEMPTS" =~ ^[0-9]+$ ]] || die_json "Invalid --max-attempts: $MAX_ATTEMPTS. Must be an integer 1-${ATTEMPTS_MAX}" 1
(( MAX_ATTEMPTS >= 1 && MAX_ATTEMPTS <= ATTEMPTS_MAX )) || die_json "Invalid --max-attempts: $MAX_ATTEMPTS. Must be an integer 1-${ATTEMPTS_MAX}" 1
(( ATTEMPT <= MAX_ATTEMPTS )) || die_json "Invalid --attempt: $ATTEMPT exceeds --max-attempts $MAX_ATTEMPTS" 1
[[ "$POLL_SECONDS" =~ ^[0-9]+$ ]] || die_json "Invalid --poll-seconds: $POLL_SECONDS. Must be an integer >= ${POLL_MIN}" 1
(( POLL_SECONDS >= POLL_MIN )) || die_json "Invalid --poll-seconds: $POLL_SECONDS. Must be an integer >= ${POLL_MIN}" 1
(( (MAX_ATTEMPTS - 1) * POLL_SECONDS <= WAIT_MAX )) || die_json "Invalid wait budget: (--max-attempts - 1) * --poll-seconds must be <= ${WAIT_MAX}" 1

WAITED=$(( (ATTEMPT - 1) * POLL_SECONDS ))

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

# read_snapshot - validates $CHECKS_DATA into CHECKS_JSON. A value that does
# not parse as a JSON array is a failed fetch, except when --fetch-error-data
# indicates gh had no checks to report (which is a legitimate empty result).
read_snapshot() {
    CHECKS_JSON="[]"
    FETCH_ERR=""
    if printf '%s' "$CHECKS_DATA" | jq -e 'type == "array"' >/dev/null 2>&1; then
        CHECKS_JSON="$CHECKS_DATA"
        return 0
    fi
    # 早く終わる reader（grep -q / head）へ pipe しない: 残りの write が SIGPIPE になり pipefail で偽・非 0 になる
    if grep -qi 'no checks reported' <<<"$FETCH_ERR_DATA"; then
        CHECKS_JSON="[]"
        return 0
    fi
    if [[ -n "$FETCH_ERR_DATA" ]]; then
        FETCH_ERR="gh pr checks: $(printf '%s' "$FETCH_ERR_DATA" | { head -3; cat >/dev/null; } | tr '\n' ' ')"
    else
        FETCH_ERR="gh pr checks: snapshot data is not a JSON array"
    fi
    return 1
}

# compute_verdict - reduces $CHECKS_JSON to $result_json / $status.
# bucket field values: pass | fail | pending | skipping | cancel
# is_passed:  bucket IN("pass", "skipping")   — completed successfully or intentionally skipped
#             (with --only: bucket == "pass" only)
# is_pending: bucket == "pending"             — still running
#             (with --only: bucket IN("pending", "skipping"))
# is_failed:  bucket IN("fail", "cancel") OR bucket outside the known
#             5-value vocabulary — failed, cancelled, or unrecognized
#             (fail-closed: an unknown bucket must count as failed, not
#             silently drop out of every count and let the "no failed, no
#             pending -> passed" default misreport it as green).
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
      def is_known:   .bucket | IN("pass", "fail", "pending", "skipping", "cancel");
      def is_failed:  (.bucket | IN("fail", "cancel")) or (is_known | not);
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

if ! read_snapshot; then
    printf '{"status":"error","message":%s,"waited_seconds":%s,"poll_attempts":%s,"epoch":%s,"next_action":"done"}\n' \
        "$(printf '%s' "$FETCH_ERR" | jq -Rs '.')" "$WAITED" "$ATTEMPT" "$(epoch_field)"
    exit 1
fi

compute_verdict

NEXT_ACTION="done"
if [[ "$status" == "pending" ]] && (( ATTEMPT < MAX_ATTEMPTS )); then
    NEXT_ACTION="poll"
fi

printf '%s' "$result_json" | jq -c \
    --argjson w "$WAITED" \
    --argjson p "$ATTEMPT" \
    --argjson e "$(epoch_field)" \
    --arg n "$NEXT_ACTION" \
    '. + {waited_seconds:$w, poll_attempts:$p, epoch:$e, next_action:$n}'
