#!/usr/bin/env bash
# ac-lint.sh - Lint an issue body for AC (Acceptance Criteria) contract compliance
# Usage: ac-lint.sh <body-file>
# Output: single-line JSON on stdout:
#   {"ok":true,"verdict":"t1|t2|non_compliant","heading_found":true|false,
#    "checkbox_count":N,"bullet_count":N}
# Exit code: 0 = t1/t2 (pass), 3 = non_compliant, 1 = usage/IO error
#
# AC heading detection (extended regex, first match wins):
#   ^#{2,6}[[:space:]]+(受け入れ基準|受け入れ条件|受入基準|受入条件|Acceptance Criteria|完了条件)
#   English alternative matched case-insensitively; heading text after the
#   match is not required to end the line (e.g. trailing "（Acceptance
#   Criteria）" annotations are allowed).
#
# Section = heading line's next line through the line before the next
# markdown heading (or EOF).
#
# Verdict:
#   t1            - section contains >=1 checkbox line: ^[-*][[:space:]]+\[[ xX]\]
#   t2            - not t1, but section contains >=1 bullet/numbered line:
#                    ^([-*][[:space:]]+|[0-9]+\.[[:space:]]+)
#   non_compliant - heading not found, or section has neither

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# _lib/common.sh は playpark-core plugin にある。core の bin/journal（PATH）を起点に解決する（plugin 境界を ../ で跨がない）
_CORE_BIN="$(command -v journal)" || { echo "playpark-core plugin (bin/journal) not on PATH" >&2; exit 127; }
source "$(dirname "$_CORE_BIN")/../_lib/common.sh"

# This script's usage/IO error contract is {"ok":false,"error":...} on
# stdout with exit 1 (callers gate on stdout JSON only) — distinct from
# common.sh's die_json, which emits {"status":"error",...} to stderr with
# an arbitrary exit code. die_json's message formatting (json_str) is
# still reused for consistency.
fail_json() {
    local msg="$1"
    echo "{\"ok\":false,\"error\":$(json_str "$msg")}"
    exit 1
}

BODY_FILE="${1:-}"

[[ -n "$BODY_FILE" ]] || fail_json "Usage: ac-lint.sh <body-file>"
[[ -f "$BODY_FILE" ]] || fail_json "Body file not found: $BODY_FILE"
[[ -s "$BODY_FILE" ]] || fail_json "Body file is empty: $BODY_FILE"

# Strip trailing CR (CRLF -> LF) into a working copy of lines.
mapfile -t LINES < <(sed 's/\r$//' "$BODY_FILE")

HEADING_RE='^#{2,6}[[:space:]]+(受け入れ基準|受け入れ条件|受入基準|受入条件|Acceptance Criteria|完了条件)'
ANY_HEADING_RE='^#{1,6}[[:space:]]'
CHECKBOX_RE='^[[:space:]]*[-*][[:space:]]+\[[ xX]\]'
BULLET_RE='^[[:space:]]*([-*][[:space:]]+|[0-9]+\.[[:space:]]+)'

heading_found=false
heading_idx=-1
total=${#LINES[@]}

# 行ごとの判定は grep を fork せず bash の [[ =~ ]]（同じ POSIX ERE）で行う。-i 相当は nocasematch
shopt -s nocasematch
for ((i = 0; i < total; i++)); do
    if [[ "${LINES[$i]}" =~ $HEADING_RE ]]; then
        heading_found=true
        heading_idx=$i
        break
    fi
done
shopt -u nocasematch

checkbox_count=0
bullet_count=0

if [[ "$heading_found" == true ]]; then
    # Section: from heading_idx+1 up to (not including) next markdown heading or EOF
    section_end=$total
    for ((i = heading_idx + 1; i < total; i++)); do
        if [[ "${LINES[$i]}" =~ $ANY_HEADING_RE ]]; then
            section_end=$i
            break
        fi
    done

    for ((i = heading_idx + 1; i < section_end; i++)); do
        line="${LINES[$i]}"
        if [[ "$line" =~ $CHECKBOX_RE ]]; then
            checkbox_count=$((checkbox_count + 1))
        elif [[ "$line" =~ $BULLET_RE ]]; then
            bullet_count=$((bullet_count + 1))
        fi
    done
fi

if [[ "$checkbox_count" -ge 1 ]]; then
    verdict="t1"
    exit_code=0
elif [[ "$bullet_count" -ge 1 ]]; then
    verdict="t2"
    exit_code=0
else
    verdict="non_compliant"
    exit_code=3
fi

heading_found_json="false"
[[ "$heading_found" == true ]] && heading_found_json="true"

echo "{\"ok\":true,\"verdict\":\"$verdict\",\"heading_found\":$heading_found_json,\"checkbox_count\":$checkbox_count,\"bullet_count\":$bullet_count}"
exit "$exit_code"
