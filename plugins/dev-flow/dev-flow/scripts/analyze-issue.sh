#!/usr/bin/env bash
# analyze-issue.sh - Fetch a GitHub issue via `gh` and emit the analysis JSON
#
# The fetch lives INSIDE this script (bare `gh issue view <n> [--repo R] --json ...`,
# stdout captured in-process, no file relay). The caller passes only the issue
# number (+ optional --repo); it must NOT be asked to run `gh issue view ... > file`
# itself: a redirect appended to `gh` changes the command's shape so the caller's
# environment no longer recognises it as the registered bare `gh` form, and the
# fetch then fails on `~/.config/gh` access. This script's own bare name is what
# the caller's environment recognises, so the in-process `gh` inherits that.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# _lib/common.sh は playpark-core plugin にある。core の bin/journal（PATH）を起点に解決する（plugin 境界を ../ で跨がない）
_CORE_BIN="$(command -v journal)" || { echo "playpark-core plugin (bin/journal) not on PATH" >&2; exit 127; }
source "$(dirname "$_CORE_BIN")/../_lib/common.sh"

require_cmd "jq" "jq is required for JSON parsing. Install: brew install jq"

# File-extension whitelist for comprehensive-mode AFFECTED_FILES scanning. Includes
# scripting/config extensions common in this repo (sh/bats/mjs/json/...) in addition to
# general source extensions. The contract mode does not derive any file-count estimate from
# the body: dev-flow decides the effective shape from the realized diff after implementation.
FILE_EXT_PATTERN='ts|tsx|js|jsx|mjs|cjs|py|go|rs|md|sh|bash|bats|json|yml|yaml|toml'

ISSUE_NUMBER=""
DEPTH="standard"
CONTRACT_MODE=false
REPO=""
DUMP_BODY_PATH=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --depth) DEPTH="$2"; shift 2 ;;
        --contract) CONTRACT_MODE=true; shift ;;
        --repo) REPO="$2"; shift 2 ;;
        --dump-body) DUMP_BODY_PATH="$2"; shift 2 ;;
        -h|--help)
            echo "Usage: analyze-issue.sh <issue-number> [--repo <owner/repo>] [--depth minimal|standard|comprehensive] [--contract] [--dump-body <file>]"
            exit 0
            ;;
        -*)
            die_json "Unknown option: $1"
            ;;
        *)
            [[ -z "$ISSUE_NUMBER" ]] && ISSUE_NUMBER="$1"
            shift
            ;;
    esac
done

[[ -z "$ISSUE_NUMBER" ]] && die_json "Issue number required"

# Fetch the issue JSON in-process. The --json field list is a contract with the
# `comments` guard below (a missing "comments" key is treated as a fetch-contract
# violation, not as "no comments"), so keep `comments` and `author` in it.
require_cmd "gh" "GitHub CLI (gh) not installed. Install: brew install gh"
GH_JSON_FIELDS="body,title,labels,assignees,milestone,state,comments,author,updatedAt"
GH_ARGS=(issue view "$ISSUE_NUMBER")
[[ -n "$REPO" ]] && GH_ARGS+=(--repo "$REPO")
GH_ARGS+=(--json "$GH_JSON_FIELDS")
# stderr is captured separately (not merged into stdout) so a gh warning printed
# alongside a successful fetch cannot corrupt the JSON, while a failed fetch still
# surfaces gh's own error text in the die_json message.
GH_STDERR_FILE=$(mktemp "${TMPDIR:-/tmp}/analyze-issue-gh-XXXXXX")
trap 'rm -f "$GH_STDERR_FILE"' EXIT
if ! ISSUE_JSON=$(gh "${GH_ARGS[@]}" 2>"$GH_STDERR_FILE"); then
    GH_STDERR=$(tr '\n' ' ' <"$GH_STDERR_FILE")
    die_json "gh issue view ${ISSUE_NUMBER}${REPO:+ (--repo $REPO)} failed: ${GH_STDERR:-exit non-zero}"
fi

# Extract fields
TITLE=$(echo "$ISSUE_JSON" | jq -r '.title // ""')
STATE=$(echo "$ISSUE_JSON" | jq -r '.state // "unknown"')
BODY=$(echo "$ISSUE_JSON" | jq -r '.body // ""')
LABELS=$(echo "$ISSUE_JSON" | jq -c '[.labels[].name] // []')
MILESTONE=$(echo "$ISSUE_JSON" | jq -r '.milestone.title // null')
# Issue reporter login (fixture / gh output missing "author" -> "" 扱い, plain jq
# null-safety, not a legacy fallback branch). Used downstream (dev-flow prerun-analyze.sh)
# as one of the trust signals for comment_overrides adoption alongside author_association
# (issue #573 review on PR #578): an issue's own reporter may correct their own request
# in a follow-up comment even without elevated repo permissions.
# Emitted with json_escape (NOT json_str): json_str maps an empty string to JSON
# `null` (correct for milestone, where "absent" is the meaning), but issue_author
# must stay a string so the consumer compares login-to-login and never conflates
# "unknown reporter" with a JSON null of some other origin.
ISSUE_AUTHOR=$(echo "$ISSUE_JSON" | jq -r '.author.login // ""')
# Issue updatedAt (body edit / comment / label change のいずれかの最終時刻。gh の issue
# JSON に本文だけの編集時刻は無い)。prerun-analyze.sh が comment 判定の state に
# 最新 comment の createdAt と並べて載せ、「comment の後に issue が更新された」前後関係を
# Jev に渡す (issue #728)。
ISSUE_UPDATED_AT=$(echo "$ISSUE_JSON" | jq -r '.updatedAt // ""')

# Fail closed when the fetched issue JSON has no well-typed "comments" array. This is
# NOT the same case as "issue has zero comments" — gh's `--json ...,comments` always
# emits `"comments":[]` for a comment-free issue, so a missing/wrong-typed key means the
# in-process `gh issue view --json ...` fetch omitted the `comments` field (or produced a
# malformed shape), not that there genuinely are none. Previously `(.comments // [])`
# treated that ambiguous case as comment_count=0 and let the --contract fast path stay
# eligible:true with nothing to reconcile against the body — silently reproducing the
# exact failure mode issue #573 fixed (missed comment-based corrections), because a
# probe agent that drops `comments` from its `--json` field list would never be caught
# (PR #578 review). Fail closed instead: die_json (exit non-zero) so the fetch
# contract violation surfaces immediately rather than degrading silently.
echo "$ISSUE_JSON" | jq -e 'has("comments") and (.comments | type == "array")' >/dev/null \
    || die_json "issue JSON missing required \"comments\" array field (fetch must include --json ...,comments)"

# issue comments. Comments are part of the requirement-extraction input alongside body
# (issue #573); capped at 50 items, body kept in full for downstream (Jev per-comment
# choice in dev-flow's prerun-analyze.sh). author_association is passed through verbatim
# (gh's authorAssociation, e.g. OWNER/MEMBER/COLLABORATOR/NONE) so the consumer can
# restrict comment_overrides adoption to trusted posters instead of any commenter
# (issue #573 review on PR #578: without this, an arbitrary external comment on this
# PUBLIC repo could silently override requirements extracted from the issue body).
# `.comments` (not `.comments // []`) is safe here: the guard above already proved the
# key exists and is an array (possibly empty).
COMMENT_COUNT=$(echo "$ISSUE_JSON" | jq -r '.comments | length')
COMMENTS_JSON=$(echo "$ISSUE_JSON" | jq -c '[.comments[:50][] | {author: (.author.login // ""), author_association: (.authorAssociation // ""), created_at: (.createdAt // ""), body: (.body // "")}]')

# Detect type from labels
detect_type() {
    local labels="$1"
    if echo "$labels" | grep -qi "bug"; then echo "fix"
    elif echo "$labels" | grep -qi "enhancement\|feature"; then echo "feat"
    elif echo "$labels" | grep -qi "refactor"; then echo "refactor"
    elif echo "$labels" | grep -qi "doc"; then echo "docs"
    else echo "feat"
    fi
}

TYPE=$(detect_type "$LABELS")

# Breaking keyword scan (deterministic floor, applies to all depths).
# NOTE: uses a here-string (not a pipe) so grep -q's early-exit on match
# cannot cause an upstream SIGPIPE / silent false negative on large bodies.
BREAKING_KEYWORD_SCAN="false"
grep -qiE 'breaking|incompatible|migration|破壊的|非互換' <<<"${TITLE}"$'\n'"${BODY}" && BREAKING_KEYWORD_SCAN="true"

# ============================================================
# Contract mode (--contract): deterministic T1/T2 contract parse (issue #374)
# ============================================================
# T1 = AC heading (h1-h6, "Acceptance Criteria" / "受け入れ基準" etc.) + >=1 checkbox item.
# T2 = same heading + >=1 plain bullet/numbered item (no checkbox).
# Eligible only when contract in {t1,t2}, issue_type (title prefix -> label fallback) is in
# {feat,fix,docs,refactor,chore,test,perf,ci}, no `!` breaking marker in title, and
# breaking_keyword_scan==false.
# Ineligible/unparseable => eligible:false + ineligible_reason (exit 0). `eligible` is the
# single first-failing verdict; the raw signals behind it (acceptance_criteria /
# breaking_keyword_scan / title_breaking_marker / comment_count / comments / issue_author) are
# always emitted so dev-flow's prerun (prerun-analyze.sh) can route the two non-deterministic
# reasons (breaking keyword hit / comments present) to a bounded Jev judgement instead of an
# LLM transcription pass (issue #690).

# Line-anchored regex matching a markdown heading whose text CONTAINS one of the
# accepted AC-heading forms (case-insensitive), mirroring _lib/scripts/ac-lint.sh's
# HEADING_RE exactly: same alternation set (受け入れ基準|受け入れ条件|受入基準|
# 受入条件|Acceptance Criteria|完了条件) and the same "trailing text after the match is not
# required to end the line" tolerance (e.g. "受け入れ基準（Acceptance Criteria）"
# annotations match, and so does a substring like "受け入れ基準外" — same as
# ac-lint.sh), and the same heading-level range `#{2,6}` — an h1 `# 受け入れ基準`
# is NOT an AC heading here because ac-lint.sh (HEADING_RE, h2〜h6) does not accept
# it either; such a heading is surfaced via ac_heading_near_miss and handled by the
# sonnet fallback rather than silently dropped.
# This fast-path eligibility check MUST agree with ac-lint.sh's real
# contract gate, or the two silently diverge (an AC heading that one accepts and the
# other rejects makes the issue eligible on one path and AC-empty on the other).
# Substring matches like "受け入れ基準外" are accepted as ac-lint.sh does; see
# extract_ac_section below for how the *section body* is still correctly bounded at
# the *next heading of any kind* regardless of this looser heading match.
# NOTE: implemented with grep -E (not awk ==) — macOS's bundled awk (one true awk
# 20200816) has a confirmed locale-dependent bug where `==` between two non-identical
# multibyte Japanese strings (e.g. "受け入れ基準外" vs "受け入れ基準") spuriously
# returns true, so awk string-equality cannot be trusted for this comparison here.
AC_HEADING_LINE_RE='^#{2,6}[[:space:]]+(acceptance criteria|受け入れ基準|受け入れ条件|受入基準|受入条件|完了条件)'
HEADING_LINE_RE='^#{1,6}[[:space:]]+'
# Near-miss detector: any fence-external heading line that CONTAINS one of these
# fragments but does not match AC_HEADING_LINE_RE (e.g. "受入れ要件", "完了基準")
# is surfaced via ac_heading_near_miss so an AC-like heading in a non-accepted form
# is never silently dropped (issue #573; 完了条件|完了基準 added so a common
# near-miss variant of the 完了条件 accepted form is also surfaced).
AC_NEAR_MISS_RE='受け入れ|受入|acceptance|完了条件|完了基準'
# Fenced code block delimiter: ``` or ~~~ (>=3 chars), optionally indented up to 3 spaces
# per CommonMark. Used to toggle fence state so lines inside a fenced code block (e.g. a
# `# comment` in a shell snippet) are never mistaken for markdown headings (issue #388 review).
FENCE_LINE_RE='^[[:space:]]{0,3}(```+|~~~+)'

is_ac_heading_line() { grep -qiE "$AC_HEADING_LINE_RE" <<<"$1"; }
is_heading_line() { grep -qE "$HEADING_LINE_RE" <<<"$1"; }
is_fence_line() { grep -qE "$FENCE_LINE_RE" <<<"$1"; }

# Emits (verbatim, one per line) every fence-external heading line that looks
# AC-like (matches AC_NEAR_MISS_RE) but is NOT an accepted AC heading form
# (does not match is_ac_heading_line). Used to surface heading typos / unaccepted
# wording (e.g. "## 受入れ要件") and sibling headings (e.g. "## 受け入れ基準外")
# instead of silently treating them as "AC heading not found" with no trace
# (issue #573). Same fence-tracking as extract_ac_section.
collect_ac_near_miss() {
    local body="$1" in_fence=false line
    while IFS= read -r line || [[ -n "$line" ]]; do
        if is_fence_line "$line"; then
            [[ "$in_fence" == true ]] && in_fence=false || in_fence=true
            continue
        fi
        if [[ "$in_fence" != true ]] && is_heading_line "$line"; then
            if grep -qiE "$AC_NEAR_MISS_RE" <<<"$line" && ! is_ac_heading_line "$line"; then
                printf '%s\n' "$line"
            fi
        fi
    done <<<"$body"
    return 0
}

# Extracts the body lines that fall under the AC heading (heading line itself excluded,
# section ends at the FIRST subsequent heading of ANY level or EOF — matching
# ac-lint.sh's section-boundary rule: it only scans for the first matching heading
# line, then bounds the section at the very next heading regardless of whether that
# next heading itself also happens to look AC-like). Empty when no AC heading found.
# Once the (first) AC heading has been found, `found` latches so a later heading that
# also matches AC_HEADING_LINE_RE (e.g. a second, unrelated AC-like heading further
# down the body) does not re-open extraction — this is what keeps a sibling heading
# like "受け入れ基準の補足" from merging its content into the real AC section even
# though AC_HEADING_LINE_RE's substring match would otherwise match it too (issue #388
# review; re-verified after the substring-match alignment in issue #573).
# Tracks fenced-code-block state so heading detection is skipped for lines inside a fence
# (a `# comment` line inside a ```code block``` in the AC section must not be treated as a
# heading and prematurely close the AC section).
# NOTE: reads via a here-string / `read` loop (not a pipe) for the same SIGPIPE-safety
# reason as breaking_keyword_scan above.
extract_ac_section() {
    local body="$1" skip=false found=false in_fence=false line
    while IFS= read -r line || [[ -n "$line" ]]; do
        if is_fence_line "$line"; then
            [[ "$in_fence" == true ]] && in_fence=false || in_fence=true
            [[ "$skip" == true ]] && printf '%s\n' "$line"
            continue
        fi
        if [[ "$in_fence" != true ]] && is_heading_line "$line"; then
            if [[ "$found" == true ]]; then
                skip=false
            elif is_ac_heading_line "$line"; then
                found=true
                skip=true
            fi
            continue
        fi
        if [[ "$skip" == true ]]; then printf '%s\n' "$line"; fi
    done <<<"$body"
    return 0
}

# Returns the body with the AC heading + its section removed (everything else preserved).
# Same first-match-latches boundary rule and fence-tracking as extract_ac_section
# (issue #388 review; re-verified after issue #573's substring-match alignment).
extract_non_ac_body() {
    local body="$1" skip=false found=false in_fence=false line
    while IFS= read -r line || [[ -n "$line" ]]; do
        if is_fence_line "$line"; then
            [[ "$in_fence" == true ]] && in_fence=false || in_fence=true
            [[ "$skip" == true ]] && continue
            printf '%s\n' "$line"
            continue
        fi
        if [[ "$in_fence" != true ]] && is_heading_line "$line"; then
            if [[ "$found" == true ]]; then
                skip=false
            elif is_ac_heading_line "$line"; then
                found=true
                skip=true
                continue
            fi
        fi
        if [[ "$skip" == true ]]; then continue; fi
        printf '%s\n' "$line"
    done <<<"$body"
    return 0
}

# Extracts item text (marker stripped, blank lines dropped) from an AC section.
# mode="checkbox" -> `- [ ]`/`- [x]` items only. mode="plain" -> `- `/`* `/numbered items.
# NOTE: `|| true` on the grep stages so a no-match (exit 1) doesn't kill the script under
# set -e + pipefail; the function's last stage is itself `|| true`-guarded so its own exit
# status is always 0 regardless of match count.
extract_contract_ac_items() {
    local ac_section="$1" mode="$2"
    if [[ "$mode" == "checkbox" ]]; then
        { grep -E '^[[:space:]]*[-*][[:space:]]*\[[ xX]\][[:space:]]*' <<<"$ac_section" || true; } \
            | sed -E 's/^[[:space:]]*[-*][[:space:]]*\[[ xX]\][[:space:]]*//' \
            | { grep -v '^[[:space:]]*$' || true; }
    else
        { grep -E '^[[:space:]]*([-*][[:space:]]+|[0-9]+\.[[:space:]]+)' <<<"$ac_section" || true; } \
            | sed -E 's/^[[:space:]]*([-*][[:space:]]+|[0-9]+\.[[:space:]]+)//' \
            | { grep -v '^[[:space:]]*$' || true; }
    fi
}

run_contract_mode() {
    local heading_found=false in_fence=false line
    while IFS= read -r line || [[ -n "$line" ]]; do
        if is_fence_line "$line"; then
            [[ "$in_fence" == true ]] && in_fence=false || in_fence=true
            continue
        fi
        if [[ "$in_fence" != true ]] && is_heading_line "$line" && is_ac_heading_line "$line"; then
            heading_found=true
            break
        fi
    done <<<"$BODY"

    local contract="none" eligible=true ineligible_reason="" ac_items="" ac_section=""

    if [[ "$heading_found" != true ]]; then
        eligible=false
        ineligible_reason="AC heading not found"
    else
        ac_section="$(extract_ac_section "$BODY")"
        local checkbox_items checkbox_count
        checkbox_items="$(extract_contract_ac_items "$ac_section" checkbox)"
        checkbox_count=$(printf '%s\n' "$checkbox_items" | grep -c '^.' || true)
        if (( checkbox_count >= 1 )); then
            contract="t1"
            ac_items="$checkbox_items"
        else
            local plain_items plain_count
            plain_items="$(extract_contract_ac_items "$ac_section" plain)"
            plain_count=$(printf '%s\n' "$plain_items" | grep -c '^.' || true)
            if (( plain_count >= 1 )); then
                contract="t2"
                ac_items="$plain_items"
            else
                eligible=false
                ineligible_reason="AC heading found but no items"
            fi
        fi
    fi

    # Comments present -> the decision-tree light path cannot judge body/comment
    # semantic reconciliation on its own (issue #573). dev-flow's prerun routes each
    # comment to a bounded Jev choice instead of an LLM transcription pass.
    if [[ "$eligible" == true && "$COMMENT_COUNT" -gt 0 ]]; then
        eligible=false
        ineligible_reason="comments present ($COMMENT_COUNT) — body/comment reconciliation is not decidable by the light path"
    fi

    # scope truncated -> a spec written past the 4000-char cap can be silently
    # cut out of the contract-mode `scope` excerpt. The light path has no way
    # to notice this (it never reads the full body); the fact is surfaced via
    # scope_truncated / issue_body_truncated so the consumer (dev-flow's implementer
    # prompt) treats acceptance_criteria as authoritative for the cut region.
    if [[ "$eligible" == true && "$SCOPE_TRUNCATED" == true ]]; then
        eligible=false
        ineligible_reason="scope truncated"
    fi

    # issue_type: conventional-commit title prefix (e.g. `feat:`, `fix(scope)!:`) takes
    # precedence; falls back to label-based detect_type when the title has no such prefix.
    local title_type="" title_bang="false" issue_type
    local title_re='^([A-Za-z]+)(\([^)]*\))?(!)?:[[:space:]]'
    if [[ "$TITLE" =~ $title_re ]]; then
        title_type="$(tr '[:upper:]' '[:lower:]' <<<"${BASH_REMATCH[1]}")"
        [[ -n "${BASH_REMATCH[3]}" ]] && title_bang="true"
    fi
    if [[ -n "$title_type" ]]; then
        issue_type="$title_type"
    else
        issue_type="$TYPE"
    fi

    if [[ "$eligible" == true ]]; then
        case "$issue_type" in
            feat|fix|docs|refactor|chore|test|perf|ci) ;;
            *)
                eligible=false
                ineligible_reason="issue_type '$issue_type' not in {feat,fix,docs,refactor,chore,test,perf,ci}"
                ;;
        esac
    fi

    if [[ "$eligible" == true && "$title_bang" == true ]]; then
        eligible=false
        ineligible_reason="breaking marker (!) in title"
    fi

    if [[ "$eligible" == true && "$BREAKING_KEYWORD_SCAN" == "true" ]]; then
        eligible=false
        ineligible_reason="breaking_keyword_scan true"
    fi

    local ac_items_json
    ac_items_json=$(printf '%s\n' "$ac_items" | grep -v '^[[:space:]]*$' | head -20 | json_array || true)
    [[ -z "$ac_items_json" ]] && ac_items_json="[]"

    jq -n \
        --arg contract "$contract" \
        --argjson eligible "$eligible" \
        --arg ineligible_reason "$ineligible_reason" \
        --argjson issue_number "$ISSUE_NUMBER" \
        --arg title "$TITLE" \
        --arg issue_type "$issue_type" \
        --argjson acceptance_criteria "$ac_items_json" \
        --arg scope "$SCOPE" \
        --argjson scope_truncated "$SCOPE_TRUNCATED" \
        --argjson scope_total_chars "$SCOPE_TOTAL_CHARS" \
        --arg issue_body "$ISSUE_BODY" \
        --argjson issue_body_truncated "$ISSUE_BODY_TRUNCATED" \
        --argjson breaking_keyword_scan "$BREAKING_KEYWORD_SCAN" \
        --argjson comment_count "$COMMENT_COUNT" \
        --argjson ac_heading_near_miss "$NEAR_MISS_JSON" \
        --argjson title_breaking_marker "$title_bang" \
        --arg issue_author "$ISSUE_AUTHOR" \
        --arg issue_updated_at "$ISSUE_UPDATED_AT" \
        --argjson comments "$COMMENTS_JSON" \
        '
        {
          contract: $contract,
          eligible: $eligible,
          issue_number: $issue_number,
          title: $title,
          issue_type: $issue_type,
          acceptance_criteria: $acceptance_criteria,
          scope: $scope,
          scope_truncated: $scope_truncated,
          scope_total_chars: $scope_total_chars,
          issue_body: $issue_body,
          issue_body_truncated: $issue_body_truncated,
          breaking_keyword_scan: $breaking_keyword_scan,
          title_breaking_marker: $title_breaking_marker,
          comment_count: $comment_count,
          issue_author: $issue_author,
          issue_updated_at: $issue_updated_at,
          comments: $comments,
          ac_heading_near_miss: $ac_heading_near_miss
        }
        + (if $eligible then {} else {ineligible_reason: $ineligible_reason} end)
        '
}

# AC heading near-miss detection (applies to all depths, computed once ahead of the
# contract-mode dispatch): fence-external headings that look AC-like but do not match
# an accepted heading form, verbatim, capped at 10 (issue #573).
NEAR_MISS_JSON=$(collect_ac_near_miss "$BODY" | head -10 | json_array || true)
[[ -z "$NEAR_MISS_JSON" ]] && NEAR_MISS_JSON="[]"

# ============================================================
# scope / body_preview truncation (issue #596)
# ============================================================
# Both `scope` (contract mode + standard/comprehensive depth) and
# `body_preview` (standard/comprehensive depth) are capped for context-budget
# reasons. The caps themselves (4000 / 500) are an intentional design choice
# and are NOT changed here. What issue #596 fixes is that the truncation used
# to be silent: a spec written at the end of a long body could be cut with no
# trace, and analyze subagents (and humans debugging a repeated
# needs_clarification) had no way to tell "absent from excerpt" apart from
# "absent from issue". Every truncation now appends an explicit marker to the
# returned string AND emits a boolean + total-char-count pair so downstream
# consumers that only look at booleans (e.g. dev-flow.js's needs_clarification
# gate) still see the fact even if they never render the string.
SCOPE_MAX_CHARS=4000
BODY_PREVIEW_MAX_CHARS=500
# NOTE: the marker text must never contain a token matching FILE_EXT_PATTERN
# (e.g. no bare ".sh"/".ts" mentions) — it is appended to $SCOPE, which
# downstream analyze subagents read as an excerpt of the issue body.
truncation_marker() {
    # truncation_marker <label> <shown> <total> <suffix-after-chars>
    printf '\n[TRUNCATED: %s shows the first %s of %s chars%s; the remainder was NOT included. Do not treat anything absent from this excerpt as unspecified — read the full body from the body_dump_path file (--dump-body) before raising ambiguities]' "$1" "$2" "$3" "$4"
}
SCOPE=""; SCOPE_TRUNCATED=false; SCOPE_TOTAL_CHARS=0
if [[ "$CONTRACT_MODE" == true || "$DEPTH" != minimal ]]; then
    # NOTE: no pipe into `head -c` here — for multi-line non-AC bodies over
    # 4000 bytes, `head -c` early-exits after reading its byte quota and
    # SIGPIPEs the upstream extract_non_ac_body writer (printf), which under
    # set -o pipefail kills the whole script (issue #388 review). Capture full
    # output first, then substring in bash (no pipe).
    SCOPE_FULL="$(extract_non_ac_body "$BODY")"
    SCOPE_TOTAL_CHARS=${#SCOPE_FULL}
    SCOPE="${SCOPE_FULL:0:$SCOPE_MAX_CHARS}"
    if (( SCOPE_TOTAL_CHARS > SCOPE_MAX_CHARS )); then
        SCOPE_TRUNCATED=true
        SCOPE+="$(truncation_marker scope "$SCOPE_MAX_CHARS" "$SCOPE_TOTAL_CHARS" " of the issue body (AC section excluded)")"
    fi
fi
BODY_TOTAL_CHARS=${#BODY}
# Character-unit substring (bash), not the old `head -c 500` (byte-unit): a
# byte cut can split a multibyte character mid-sequence (U+FFFD corruption)
# and was inconsistent with $SCOPE's character-unit cut above.
BODY_PREVIEW="${BODY:0:$BODY_PREVIEW_MAX_CHARS}"
BODY_PREVIEW_TRUNCATED=false
if (( BODY_TOTAL_CHARS > BODY_PREVIEW_MAX_CHARS )); then
    BODY_PREVIEW_TRUNCATED=true
    BODY_PREVIEW+="$(truncation_marker body_preview "$BODY_PREVIEW_MAX_CHARS" "$BODY_TOTAL_CHARS" "")"
fi
# issue_body (contract mode + standard/comprehensive depth): the raw body (AC section
# INCLUDED, unlike `scope`) capped at SCOPE_MAX_CHARS with the same marker / boolean
# convention as `scope`. dev-flow.js hands it to the plan+impl implementer
# (dev-implementer, issue #668) as the issue text; the AC list travels separately,
# so a truncated body still leaves the implementer with the full acceptance criteria.
ISSUE_BODY="${BODY:0:$SCOPE_MAX_CHARS}"
ISSUE_BODY_TRUNCATED=false
if (( BODY_TOTAL_CHARS > SCOPE_MAX_CHARS )); then
    ISSUE_BODY_TRUNCATED=true
    ISSUE_BODY+="$(truncation_marker issue_body "$SCOPE_MAX_CHARS" "$BODY_TOTAL_CHARS" " of the issue body (AC section included)")"
fi

# --dump-body <file> (standard / comprehensive depth only): when any excerpt above was
# truncated, write the raw body verbatim to <file> and report its absolute path as
# body_dump_path so the consumer can Read the full text without re-fetching the issue.
# Nothing is written (body_dump_path: null) when no excerpt was cut — the excerpts already
# carry the whole body, and a stray file per run would only accumulate.
BODY_DUMP_PATH_JSON=null
if [[ -n "$DUMP_BODY_PATH" && "$CONTRACT_MODE" != true && "$DEPTH" != minimal ]] \
    && [[ "$SCOPE_TRUNCATED" == true || "$BODY_PREVIEW_TRUNCATED" == true || "$ISSUE_BODY_TRUNCATED" == true ]]; then
    printf '%s' "$BODY" > "$DUMP_BODY_PATH" || die_json "--dump-body: cannot write $DUMP_BODY_PATH"
    BODY_DUMP_ABS="$(cd "$(dirname "$DUMP_BODY_PATH")" && pwd)/$(basename "$DUMP_BODY_PATH")"
    BODY_DUMP_PATH_JSON=$(json_escape "$BODY_DUMP_ABS")
fi

if [[ "$CONTRACT_MODE" == true ]]; then
    run_contract_mode
    exit 0
fi

# Minimal output
if [[ "$DEPTH" == "minimal" ]]; then
    echo "{\"issue_number\":$ISSUE_NUMBER,\"title\":$(json_str "$TITLE"),\"type\":\"$TYPE\",\"state\":\"$STATE\",\"labels\":$LABELS,\"milestone\":$(json_str "$MILESTONE"),\"breaking_keyword_scan\":$BREAKING_KEYWORD_SCAN,\"comment_count\":$COMMENT_COUNT,\"issue_author\":$(json_escape "$ISSUE_AUTHOR")}"
    exit 0
fi

# Extract AC and requirements
# NOTE: uses here-strings (not pipes) for the same SIGPIPE-safety reason as
# breaking_keyword_scan above — a large $1 fed via a pipe into a
# downstream head -N that early-exits can SIGPIPE-kill the upstream writer.
# NOTE: `|| true` because a no-match grep exits 1, which under
# set -e + pipefail kills the whole script with no output.
extract_ac() {
    { grep -E '^\s*-\s*\[[ x]\]|^[0-9]+\.\s' <<<"$1" || true; } | head -20 | json_array
}

extract_requirements() {
    { grep -E '^\s*[-*]\s+[A-Z]' <<<"$1" || true; } | head -15 | json_array
}

AC=$(extract_ac "$BODY")
REQUIREMENTS=$(extract_requirements "$BODY")

# Warnings (standard/comprehensive only): surfaces an empty acceptance_criteria
# extraction and any AC-like heading that doesn't match an accepted form, so
# AC 0 件 never silently degrades to an empty array with no trace (issue #573).
# NOTE: here-string / `|| true` accumulation, same SIGPIPE-safety rationale as
# breaking_keyword_scan above.
WARNINGS_LIST=""
if [[ "$AC" == "[]" ]]; then
    WARNINGS_LIST+="acceptance_criteria is empty (no checkbox/numbered items found in body)"$'\n'
fi
if [[ "$SCOPE_TRUNCATED" == true ]]; then
    WARNINGS_LIST+="scope truncated: showing first ${SCOPE_MAX_CHARS} of ${SCOPE_TOTAL_CHARS} chars (AC section excluded) — read the full body from the body_dump_path file"$'\n'
fi
if [[ "$BODY_PREVIEW_TRUNCATED" == true ]]; then
    WARNINGS_LIST+="body_preview truncated: showing first ${BODY_PREVIEW_MAX_CHARS} of ${BODY_TOTAL_CHARS} chars — read the full body from the body_dump_path file"$'\n'
fi
NEAR_MISS_LINES_RAW=$(echo "$NEAR_MISS_JSON" | jq -r '.[]' 2>/dev/null || true)
while IFS= read -r nm_line || [[ -n "$nm_line" ]]; do
    [[ -z "$nm_line" ]] && continue
    WARNINGS_LIST+="AC heading near-miss (not an accepted form): $nm_line"$'\n'
done <<<"$NEAR_MISS_LINES_RAW"
WARNINGS_JSON=$({ printf '%s' "$WARNINGS_LIST" | grep -v '^[[:space:]]*$' || true; } | json_array || true)
[[ -z "$WARNINGS_JSON" ]] && WARNINGS_JSON="[]"

# Standard output
if [[ "$DEPTH" == "standard" ]]; then
    cat <<JSONEOF
{
  "issue_number": $ISSUE_NUMBER,
  "title": $(json_str "$TITLE"),
  "type": "$TYPE",
  "state": "$STATE",
  "labels": $LABELS,
  "milestone": $(json_str "$MILESTONE"),
  "acceptance_criteria": $AC,
  "requirements": $REQUIREMENTS,
  "breaking_keyword_scan": $BREAKING_KEYWORD_SCAN,
  "comment_count": $COMMENT_COUNT,
  "comments": $COMMENTS_JSON,
  "issue_author": $(json_escape "$ISSUE_AUTHOR"),
  "ac_heading_near_miss": $NEAR_MISS_JSON,
  "warnings": $WARNINGS_JSON,
  "body_preview": $(printf '%s' "$BODY_PREVIEW" | jq -Rs .),
  "body_preview_truncated": $BODY_PREVIEW_TRUNCATED,
  "body_total_chars": $BODY_TOTAL_CHARS,
  "scope": $(printf '%s' "$SCOPE" | jq -Rs .),
  "scope_truncated": $SCOPE_TRUNCATED,
  "scope_total_chars": $SCOPE_TOTAL_CHARS,
  "issue_body": $(printf '%s' "$ISSUE_BODY" | jq -Rs .),
  "issue_body_truncated": $ISSUE_BODY_TRUNCATED,
  "body_dump_path": $BODY_DUMP_PATH_JSON
}
JSONEOF
    exit 0
fi

# Comprehensive
# NOTE: `|| true` for the same no-match reason as extract_ac above.
AFFECTED_FILES=$({ grep -oE "[a-zA-Z0-9_/-]+\\.($FILE_EXT_PATTERN)" <<<"$BODY" || true; } | sort -u | head -10 | json_array)
COMPONENTS=$({ grep -oE '\b[A-Z][a-zA-Z]+Component\b|\b[a-z]+Service\b' <<<"$BODY" || true; } | sort -u | head -10 | json_array)

cat <<JSONEOF
{
  "issue_number": $ISSUE_NUMBER,
  "title": $(json_str "$TITLE"),
  "type": "$TYPE",
  "state": "$STATE",
  "labels": $LABELS,
  "milestone": $(json_str "$MILESTONE"),
  "acceptance_criteria": $AC,
  "requirements": $REQUIREMENTS,
  "affected_files": $AFFECTED_FILES,
  "components": $COMPONENTS,
  "comment_count": $COMMENT_COUNT,
  "comments": $COMMENTS_JSON,
  "issue_author": $(json_escape "$ISSUE_AUTHOR"),
  "ac_heading_near_miss": $NEAR_MISS_JSON,
  "warnings": $WARNINGS_JSON,
  "breaking_keyword_scan": $BREAKING_KEYWORD_SCAN,
  "body_full": $(printf '%s' "$BODY" | jq -Rs .),
  "body_preview_truncated": $BODY_PREVIEW_TRUNCATED,
  "body_total_chars": $BODY_TOTAL_CHARS,
  "scope": $(printf '%s' "$SCOPE" | jq -Rs .),
  "scope_truncated": $SCOPE_TRUNCATED,
  "scope_total_chars": $SCOPE_TOTAL_CHARS,
  "issue_body": $(printf '%s' "$ISSUE_BODY" | jq -Rs .),
  "issue_body_truncated": $ISSUE_BODY_TRUNCATED,
  "body_dump_path": $BODY_DUMP_PATH_JSON
}
JSONEOF
