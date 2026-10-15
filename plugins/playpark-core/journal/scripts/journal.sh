#!/usr/bin/env bash
# journal.sh - Skill execution journal logger and query tool
# Usage:
#   journal.sh log <skill> <outcome> [options]
#   journal.sh query [options]
#   journal.sh stats [options]
#   journal.sh prune [options]
#
# Subcommands:
#   log   - Record a skill execution entry
#   query - Query journal entries with filters
#   stats - Show summary statistics
#   prune - Delete old entries except the dev-flow family (also run daily from track-skill)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

require_cmd jq

JOURNAL_DIR="${CLAUDE_JOURNAL_DIR:-$HOME/.claude/journal}"

# ============================================================================
# Helpers
# ============================================================================

ensure_journal_dir() {
    mkdir -p "$JOURNAL_DIR"
}

iso_now() {
    date -u +"%Y-%m-%dT%H:%M:%SZ"
}

# Generate entry ID from timestamp and skill name
# Format: YYYYMMDDTHHMMSS-skillname
entry_id() {
    local ts="$1" skill="$2"
    local compact="${ts//:/-}"
    compact="${compact%Z}"
    compact="${compact//-/}"
    printf '%s-%s' "${compact:0:15}" "$skill"
}

# Parse relative date (7d, 2w, 1m) to ISO date
parse_since() {
    local since="$1"
    case "$since" in
        *d) date -u -v-"${since%d}"d +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || \
             date -u -d "${since%d} days ago" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null ;;
        *w) date -u -v-"${since%w}"w +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || \
             date -u -d "${since%w} weeks ago" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null ;;
        *m) date -u -v-"${since%m}"m +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || \
             date -u -d "${since%m} months ago" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null ;;
        *) echo "$since" ;;  # Assume ISO date
    esac
}

# ============================================================================
# Log Subcommand
# ============================================================================

cmd_log() {
    local skill="" outcome="" args=""
    local error_category="" error_msg="" error_phase=""
    local recovery="" recovery_turns=""
    local issue="" duration_turns="" context_extra=""
    local project="" worktree="" mode=""
    local repo="" pr_number=""
    local telemetry_json=""

    # Parse positional args
    if [[ $# -lt 2 ]]; then
        die_json "Usage: journal.sh log <skill> <outcome> [options]" 1
    fi
    skill="$1"; shift
    outcome="$1"; shift

    # Validate outcome
    case "$outcome" in
        success|failure|partial) ;;
        *) die_json "Invalid outcome: $outcome. Must be success|failure|partial" 1 ;;
    esac

    # Parse options
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --args) args="$2"; shift 2 ;;
            --error-category) error_category="$2"; shift 2 ;;
            --error-msg) error_msg="$2"; shift 2 ;;
            --error-phase) error_phase="$2"; shift 2 ;;
            --recovery) recovery="$2"; shift 2 ;;
            --recovery-turns) recovery_turns="$2"; shift 2 ;;
            --issue) issue="$2"; shift 2 ;;
            --duration-turns) duration_turns="$2"; shift 2 ;;
            --project) project="$2"; shift 2 ;;
            --worktree) worktree="$2"; shift 2 ;;
            --context) context_extra="$2"; shift 2 ;;
            --mode) mode="$2"; shift 2 ;;
            --repo) repo="$2"; shift 2 ;;
            --pr-number) pr_number="$2"; shift 2 ;;
            --telemetry-json) telemetry_json="$2"; shift 2 ;;
            *) die_json "Unknown option: $1" 1 ;;
        esac
    done

    # Validate error fields for failure/partial outcomes
    if [[ "$outcome" != "success" && -z "$error_category" ]]; then
        die_json "Error category required for $outcome outcome. Use --error-category" 1
    fi
    if [[ "$outcome" != "success" && -z "$error_msg" ]]; then
        die_json "Error message required for $outcome outcome. Use --error-msg" 1
    fi

    # Validate error category
    if [[ -n "$error_category" ]]; then
        case "$error_category" in
            lint|test|build|runtime|config|env|merge|type-check|needs_clarification|empty_diff|cross_repo|guard_blocked|abort|pr_phase_failed) ;;
            *) die_json "Invalid error category: $error_category" 1 ;;
        esac
    fi

    # Validate --telemetry-json (must be a JSON object)
    if [[ -n "$telemetry_json" ]]; then
        if ! echo "$telemetry_json" | jq -e 'type == "object"' >/dev/null 2>&1; then
            die_json "Invalid --telemetry-json: must be a JSON object" 1
        fi
    fi

    if [[ -n "$repo" ]] && ! [[ "$repo" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9._-]+$ ]]; then
        die_json "Invalid --repo: $repo. Must be owner/name format" 1
    fi
    if [[ -n "$pr_number" ]] && ! [[ "$pr_number" =~ ^[1-9][0-9]*$ ]]; then
        die_json "Invalid --pr-number: $pr_number. Must be a positive integer" 1
    fi

    ensure_journal_dir

    local now
    now=$(iso_now)
    local id
    id=$(entry_id "$now" "$skill")

    # Build JSON using jq for safety
    local entry
    entry=$(jq -n \
        --arg version "1.0.0" \
        --arg id "$id" \
        --arg timestamp "$now" \
        --arg skill "$skill" \
        --arg outcome "$outcome" \
        '{version: $version, id: $id, timestamp: $timestamp, skill: $skill, outcome: $outcome, source: "skill"}')

    # Add optional fields
    if [[ -n "$args" ]]; then
        entry=$(echo "$entry" | jq --arg v "$args" '. + {args: $v}')
    fi

    if [[ -n "$duration_turns" ]]; then
        entry=$(echo "$entry" | jq --argjson v "$duration_turns" '. + {duration_turns: $v}')
    fi

    # Context object
    local has_context=false
    local context='{}'
    if [[ -n "$project" ]]; then
        context=$(echo "$context" | jq --arg v "$project" '. + {project: $v}')
        has_context=true
    fi
    if [[ -n "$issue" ]]; then
        context=$(echo "$context" | jq --argjson v "$issue" '. + {issue: $v}')
        has_context=true
    fi
    if [[ -n "$worktree" ]]; then
        context=$(echo "$context" | jq --arg v "$worktree" '. + {worktree: $v}')
        has_context=true
    fi
    if [[ -n "$mode" ]]; then
        context=$(echo "$context" | jq --arg v "$mode" '. + {mode: $v}')
        has_context=true
    fi
    if [[ -n "$repo" ]]; then
        context=$(echo "$context" | jq --arg v "$repo" '. + {repo: $v}')
        has_context=true
    fi
    if [[ -n "$pr_number" ]]; then
        context=$(echo "$context" | jq --argjson v "$pr_number" '. + {pr_number: $v}')
        has_context=true
    fi
    if [[ -n "$context_extra" ]]; then
        context=$(echo "$context" | jq --argjson v "$context_extra" '. * $v')
        has_context=true
    fi
    if [[ "$has_context" == true ]]; then
        entry=$(echo "$entry" | jq --argjson ctx "$context" '. + {context: $ctx}')
    fi

    # Telemetry object: --telemetry-json の object をそのまま入れる（キーごとの flag は持たない）
    if [[ -n "$telemetry_json" ]]; then
        entry=$(echo "$entry" | jq --argjson tel "$telemetry_json" '. + {telemetry: $tel}')
    fi

    # Error object
    if [[ -n "$error_category" ]]; then
        local error_obj
        error_obj=$(jq -n --arg cat "$error_category" --arg msg "$error_msg" \
            '{category: $cat, message: $msg}')
        if [[ -n "$error_phase" ]]; then
            error_obj=$(echo "$error_obj" | jq --arg v "$error_phase" '. + {phase: $v}')
        fi
        entry=$(echo "$entry" | jq --argjson err "$error_obj" '. + {error: $err}')
    fi

    # Recovery object
    if [[ -n "$recovery" ]]; then
        local recovery_obj
        recovery_obj=$(jq -n --arg action "$recovery" '{action: $action, successful: true}')
        if [[ -n "$recovery_turns" ]]; then
            recovery_obj=$(echo "$recovery_obj" | jq --argjson v "$recovery_turns" '. + {turns_spent: $v}')
        fi
        entry=$(echo "$entry" | jq --argjson rec "$recovery_obj" '. + {recovery: $rec}')
    fi

    # Write entry to file (atomic write with PID suffix to avoid same-second collision)
    local filename="${now//:/-}"
    filename="${filename//T/-}"
    filename="${filename%Z}-${skill}-$$.json"
    local tmp
    tmp=$(mktemp "$JOURNAL_DIR/.tmp.XXXXXX")
    printf '%s\n' "$entry" > "$tmp"
    mv "$tmp" "$JOURNAL_DIR/$filename"

    echo "{\"status\":\"logged\",\"id\":\"$id\",\"file\":\"$filename\"}"
}

# ============================================================================
# Query Subcommand
# ============================================================================

cmd_query() {
    local since="" skill="" outcome="" limit="50" source_filter=""

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --since) since="$2"; shift 2 ;;
            --skill) skill="$2"; shift 2 ;;
            --outcome) outcome="$2"; shift 2 ;;
            --limit) limit="$2"; shift 2 ;;
            --source) source_filter="$2"; shift 2 ;;
            *) die_json "Unknown option: $1" 1 ;;
        esac
    done

    # Validate --source value
    if [[ -n "$source_filter" ]]; then
        case "$source_filter" in
            skill|hook) ;;
            *) die_json "Invalid --source: $source_filter. Must be skill|hook" 1 ;;
        esac
    fi

    ensure_journal_dir

    # Parse since date
    local since_iso=""
    if [[ -n "$since" ]]; then
        since_iso=$(parse_since "$since")
    fi

    # Collect JSON files - handle empty directory.
    # ファイル名の先頭は UTC の YYYY-MM-DD（cmd_log / cmd_hook_capture が iso_now から作る）なので、
    # --since があれば中身を読む前に日付で絞る。日付で始まらない名前は判定できないので残す。
    local since_date="${since_iso:0:10}"
    local files=() base
    for f in "$JOURNAL_DIR"/*.json; do
        [[ -f "$f" ]] || continue
        if [[ -n "$since_date" ]]; then
            base="${f##*/}"
            if [[ "$base" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}- && "${base:0:10}" < "$since_date" ]]; then
                continue
            fi
        fi
        files+=("$f")
    done

    if [[ ${#files[@]} -eq 0 ]]; then
        echo "[]"
        return 0
    fi

    # Build jq filter for all conditions in one pass
    local jq_filter='.'
    if [[ -n "$skill" ]]; then
        jq_filter="$jq_filter | select(.skill == \$skill)"
    fi
    if [[ -n "$outcome" ]]; then
        jq_filter="$jq_filter | select(.outcome == \$outcome)"
    fi
    if [[ -n "$since_iso" ]]; then
        jq_filter="$jq_filter | select(.timestamp >= \$since_iso)"
    fi
    if [[ "$source_filter" == "skill" ]]; then
        # source 欠落 = skill 扱い（後方互換）
        jq_filter="$jq_filter | select((.source // \"skill\") == \"skill\")"
    elif [[ "$source_filter" == "hook" ]]; then
        jq_filter="$jq_filter | select(.source == \"hook\")"
    fi

    # ファイルを引数に並べると件数次第で ARG_MAX を超える（jq: Argument list too long）ので、
    # printf（builtin）→ xargs cat → jq stdin で流す。
    # 不正 JSON が混ざると一括 slurp が失敗するので、そのときだけ 1 ファイルずつ検査して
    # 壊れたものを警告付きで飛ばす。
    local slurped
    if ! slurped=$(printf '%s\0' "${files[@]}" | xargs -0 cat -- 2>/dev/null | jq -cs '.' 2>/dev/null); then
        slurped=$(
            for f in "${files[@]}"; do
                if ! jq -c '.' "$f" 2>/dev/null; then
                    echo "journal query: skipping corrupt file: $f" >&2
                fi
            done | jq -cs '.'
        )
    fi

    printf '%s' "$slurped" | jq \
        --arg skill "$skill" \
        --arg outcome "$outcome" \
        --arg since_iso "$since_iso" \
        --argjson lim "$limit" \
        "[.[] | $jq_filter] | sort_by(.timestamp) | reverse | .[:(\$lim)]"
}

# ============================================================================
# Stats Subcommand
# ============================================================================

cmd_stats() {
    local since="" source_filter=""

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --since) since="$2"; shift 2 ;;
            --source) source_filter="$2"; shift 2 ;;
            *) die_json "Unknown option: $1" 1 ;;
        esac
    done

    local query_args=("--limit" "9999")
    if [[ -n "$since" ]]; then
        query_args+=("--since" "$since")
    fi
    query_args+=("--source" "${source_filter:-skill}")

    local entries
    entries=$(cmd_query "${query_args[@]}")

    echo "$entries" | jq '{
        total: length,
        success: [.[] | select(.outcome == "success")] | length,
        failure: [.[] | select(.outcome == "failure")] | length,
        partial: [.[] | select(.outcome == "partial")] | length,
        by_skill: (group_by(.skill) | map({
            skill: .[0].skill,
            total: length,
            failures: [.[] | select(.outcome != "success")] | length
        }) | sort_by(-.failures)),
        by_category: ([.[] | select(.error != null) | .error.category] | group_by(.) | map({
            category: .[0],
            count: length
        }) | sort_by(-.count)),
        avg_recovery_turns: (
            [.[] | select(.recovery != null and .recovery.turns_spent != null) | .recovery.turns_spent]
            | if length > 0 then (add / length | . * 10 | round / 10) else 0 end
        )
    }'
}

# ============================================================================
# Hook Capture Subcommand
# ============================================================================

# Error classification patterns (from error-categories.md)
classify_error() {
    local msg="$1"
    if echo "$msg" | grep -qiE 'eslint|prettier|biome|stylelint|lint.*error'; then
        echo "lint"
    elif echo "$msg" | grep -qiE 'test.*fail|assert|expect.*to|FAIL.*test'; then
        echo "test"
    elif echo "$msg" | grep -qiE 'build.*fail|compile.*error|esbuild|webpack.*error|vite.*error'; then
        echo "build"
    elif echo "$msg" | grep -qiE 'CONFLICT|merge.*fail|rebase.*conflict|cannot.*merge'; then
        echo "merge"
    elif echo "$msg" | grep -qiE 'TS[0-9]+:|type.*error|mypy.*error|no.*overload'; then
        echo "type-check"
    elif echo "$msg" | grep -qiE 'node_modules|ENOENT.*package|pip.*not found|command not found|version.*mismatch'; then
        echo "env"
    elif echo "$msg" | grep -qiE 'config.*not found|invalid.*config|missing.*setting'; then
        echo "config"
    else
        echo "runtime"
    fi
}

# Called from PostToolUseFailure hook — only fires on actual tool failures
cmd_hook_capture() {
    local input
    input=$(cat)

    # Parse PostToolUseFailure JSON from stdin.
    # Claude Code payload fields: session_id, tool_name, tool_input, error, is_interrupt.
    # Also tolerate legacy/PostToolUse payloads that use tool_response/tool_result.
    local tool_name tool_input error_text session_id is_interrupt
    tool_name=$(jq -r '.tool_name // empty' <<<"$input" 2>/dev/null || true)
    tool_input=$(jq -c '.tool_input // {}' <<<"$input" 2>/dev/null || echo '{}')
    error_text=$(jq -r '.error // .tool_response // .tool_result // empty' <<<"$input" 2>/dev/null || true)
    session_id=$(jq -r '.session_id // empty' <<<"$input" 2>/dev/null || true)
    is_interrupt=$(jq -r '.is_interrupt // false' <<<"$input" 2>/dev/null || echo false)

    [[ -z "$tool_name" ]] && return 0
    # Skip user-triggered interrupts — they aren't real failures worth analyzing
    [[ "$is_interrupt" == "true" ]] && return 0

    # Extract error snippet (first 3 matching lines, max 300 chars).
    # Guard every stage so empty input / no-match doesn't trip `set -e -o pipefail`.
    # iconv -f UTF-8 -t UTF-8 -c removes invalid UTF-8 bytes caused by multibyte truncation,
    # ensuring safe input to jq --arg.
    local error_snippet=""
    if [[ -n "$error_text" ]]; then
        error_snippet=$(printf '%s\n' "$error_text" \
            | { grep -iE 'error|fail|exception|fatal|panic|denied|not found' || true; } \
            | head -n 3 \
            | cut -c1-300 \
            | iconv -f UTF-8 -t UTF-8 -c)
        if [[ -z "$error_snippet" ]]; then
            error_snippet=$(printf '%s\n' "$error_text" | head -n 3 | cut -c1-300 | iconv -f UTF-8 -t UTF-8 -c)
        fi
    fi
    [[ -z "$error_snippet" ]] && error_snippet="(no error text)"

    # Classify error
    local category
    category=$(classify_error "$error_snippet")

    # Extract command for Bash tool (useful context)
    local input_summary
    if [[ "$tool_name" == "Bash" ]]; then
        input_summary=$(echo "$tool_input" | jq -r '.command // empty' 2>/dev/null | cut -c1-200)
    elif [[ "$tool_name" == "Skill" ]]; then
        input_summary=$(echo "$tool_input" | jq -r '.skill // empty' 2>/dev/null)
    else
        input_summary=$(echo "$tool_input" | jq -c '.' 2>/dev/null | cut -c1-200)
    fi

    # Read active skill context from state file (written by PreToolUse Skill hook).
    # TTL (30 min) ガード: UserPromptSubmit hook (clear-skill-ctx) がクリアし損ねたケース
    # (skill が完了 log を呼ばずに死亡 等) でも誤帰属が無限に続かないよう保険を入れる。
    local active_skill=""
    local state_file="/tmp/claude-skill-ctx-${session_id}"
    if [[ -n "$session_id" && -f "$state_file" ]]; then
        # stat の引数は GNU (Linux / Nix) と BSD (macOS) で非互換。GNU を先に試す。
        local file_mtime file_age
        file_mtime=$(stat -c %Y "$state_file" 2>/dev/null || stat -f %m "$state_file" 2>/dev/null || echo 0)
        # stat -f が format spec を誤解釈して "File: ..." を吐くケースに備えて数値検証
        [[ "$file_mtime" =~ ^[0-9]+$ ]] || file_mtime=0
        file_age=$(( $(date +%s) - file_mtime ))
        if (( file_age <= 1800 )); then
            active_skill=$(cat "$state_file" 2>/dev/null)
        fi
    fi

    # Build skill name: prefer active skill context, fallback to tool name
    local skill_label
    if [[ -n "$active_skill" ]]; then
        skill_label="$active_skill"
    else
        skill_label="hook-$tool_name"
    fi

    ensure_journal_dir

    local now
    now=$(iso_now)
    local id
    id=$(entry_id "$now" "$skill_label")

    # Build context object
    local context
    context=$(jq -n \
        --arg tool_name "$tool_name" \
        --arg input_summary "$input_summary" \
        --arg session_id "$session_id" \
        --arg active_skill "$active_skill" \
        '{tool_name: $tool_name, input_summary: $input_summary, session_id: $session_id}
         | if $active_skill != "" then . + {active_skill: $active_skill} else . end
         | with_entries(select(.value != ""))')

    local entry
    entry=$(jq -n \
        --arg version "1.0.0" \
        --arg id "$id" \
        --arg timestamp "$now" \
        --arg skill "$skill_label" \
        --arg outcome "failure" \
        --arg err_category "$category" \
        --arg err_message "$error_snippet" \
        --argjson context "$context" \
        '{
            version: $version,
            id: $id,
            timestamp: $timestamp,
            skill: $skill,
            outcome: "failure",
            source: "hook",
            context: $context,
            error: {
                category: $err_category,
                message: $err_message
            }
        }')

    # Atomic write with PID suffix to avoid same-second collision
    local filename="${now//:/-}"
    filename="${filename//T/-}"
    filename="${filename%Z}-${skill_label}-$$.json"
    local tmp
    tmp=$(mktemp "$JOURNAL_DIR/.tmp.XXXXXX")
    printf '%s\n' "$entry" > "$tmp"
    mv "$tmp" "$JOURNAL_DIR/$filename"
}

# Track active skill: called by PreToolUse Skill hook to write state file
cmd_track_skill() {
    local input
    input=$(cat)

    maybe_auto_prune

    local skill_name session_id
    skill_name=$(echo "$input" | jq -r '.tool_input.skill // empty' 2>/dev/null) || return 0
    session_id=$(echo "$input" | jq -r '.session_id // empty' 2>/dev/null) || return 0

    [[ -z "$skill_name" || -z "$session_id" ]] && return 0

    echo "$skill_name" > "/tmp/claude-skill-ctx-${session_id}"
}

# Clear active skill: called by UserPromptSubmit hook so a new prompt is not
# attributed to the skill tracked in the previous turn
cmd_clear_skill_ctx() {
    local input session_id
    input=$(cat)
    session_id=$(echo "$input" | jq -r '.session_id // empty' 2>/dev/null) || return 0
    [[ -z "$session_id" ]] && return 0

    rm -f "/tmp/claude-skill-ctx-${session_id}"
}

# ============================================================================
# Prune Subcommand
# ============================================================================

# dev-flow 系の skill。期間を問わず残す（dev-flow-health は dev-flow / pr-iterate の全履歴から
# first_seen と resolved を判定するので、30 日で消すと解消済みの型が new に戻る）。
# 廃止済みの旧 skill 名（dev-kickoff / pr-fix / dev-flow-doctor 等）は誰も読まないので入れない。
PRUNE_KEEP_DEFAULT="dev-flow,pr-iterate,git-commit,git-pr,git-issue"

# Delete entries older than N days whose skill is not in the keep list.
# 日付はファイル名先頭（UTC の YYYY-MM-DD）で判定する。日付で始まらない名前と、
# 壊れていて skill を読めないファイルは判定できないので残す。
cmd_prune() {
    local days="30" keep="$PRUNE_KEEP_DEFAULT" dry_run=false

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --days) days="$2"; shift 2 ;;
            --keep) keep="$2"; shift 2 ;;
            --dry-run) dry_run=true; shift ;;
            *) die_json "Unknown option: $1" 1 ;;
        esac
    done

    [[ "$days" =~ ^[1-9][0-9]*$ ]] || die_json "Invalid --days: $days. Must be a positive integer" 1

    ensure_journal_dir

    local cutoff
    cutoff=$(parse_since "${days}d")
    cutoff="${cutoff:0:10}"
    [[ "$cutoff" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || die_json "Failed to compute cutoff date" 1

    local old=() base
    for f in "$JOURNAL_DIR"/*.json; do
        [[ -f "$f" ]] || continue
        base="${f##*/}"
        if [[ "$base" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}- && "${base:0:10}" < "$cutoff" ]]; then
            old+=("$f")
        fi
    done

    # 1 回の jq に渡すファイル数を絞り、壊れたファイルで止まっても巻き添えを小さくする
    local targets=()
    if [[ ${#old[@]} -gt 0 ]]; then
        local path skill
        while IFS=$'\t' read -r path skill; do
            [[ -n "$path" ]] || continue
            [[ ",$keep," == *",$skill,"* ]] && continue
            targets+=("$path")
        done < <(printf '%s\0' "${old[@]}" \
            | xargs -0 -n 100 jq -r 'select(type == "object") | [input_filename, (.skill // "")] | @tsv' 2>/dev/null || true)
    fi

    if [[ "$dry_run" == "false" && ${#targets[@]} -gt 0 ]]; then
        printf '%s\0' "${targets[@]}" | xargs -0 rm -f --
    fi

    jq -n \
        --arg cutoff "$cutoff" \
        --argjson dry_run "$dry_run" \
        --argjson scanned "${#old[@]}" \
        --argjson pruned "${#targets[@]}" \
        '{status: (if $dry_run then "dry-run" else "pruned" end), cutoff: $cutoff, older_than_cutoff: $scanned, pruned: $pruned, kept: ($scanned - $pruned)}'
}

# track-skill（Skill 起動ごと）から 1 日 1 回だけ prune をバックグラウンドで走らせる。
# hook の timeout に掛からないよう待たない。JOURNAL_PRUNE_DAYS=0 で無効化。
maybe_auto_prune() {
    local days="${JOURNAL_PRUNE_DAYS:-30}"
    [[ "$days" =~ ^[1-9][0-9]*$ ]] || return 0
    [[ -d "$JOURNAL_DIR" ]] || return 0

    local stamp="$JOURNAL_DIR/.last-prune"
    if [[ -f "$stamp" && -n "$(find "$stamp" -mtime -1 2>/dev/null)" ]]; then
        return 0
    fi
    touch "$stamp" 2>/dev/null || return 0

    ( bash "${BASH_SOURCE[0]}" prune --days "$days" >/dev/null 2>&1 </dev/null & )
}

# ============================================================================
# Main
# ============================================================================

SUBCMD="${1:-}"
shift || true

case "$SUBCMD" in
    log) cmd_log "$@" ;;
    hook-capture) cmd_hook_capture ;;
    track-skill) cmd_track_skill ;;
    clear-skill-ctx) cmd_clear_skill_ctx ;;
    query) cmd_query "$@" ;;
    stats) cmd_stats "$@" ;;
    prune) cmd_prune "$@" ;;
    *)
        cat <<'USAGE'
Usage: journal.sh <subcommand> [options]

Subcommands:
  log <skill> <outcome>  Record skill execution
  hook-capture           Capture failures from PostToolUse hook (reads stdin)
  track-skill            Track active skill from PreToolUse Skill hook (reads stdin)
  clear-skill-ctx        Clear tracked skill from UserPromptSubmit hook (reads stdin)
  query [--since] [--skill] [--outcome] [--source <skill|hook>]  Query entries
  stats [--since] [--source <skill|hook>]  Show summary statistics (default: skill)
  prune [--days 30] [--keep a,b] [--dry-run]  Delete old entries except dev-flow family

Examples:
  journal.sh log dev-kickoff success --issue 42 --duration-turns 15
  journal.sh log dev-flow success --repo acme/skills --pr-number 123 --telemetry-json '{"merge_tier":"REVIEW","shape":"standard","route":"full"}'
  journal.sh log dev-flow failure --error-category abort --error-msg "abort@Evaluate/eval#1: ..." --error-phase Evaluate  # run abort telemetry (issue #607)
  journal.sh log dev-kickoff failure --error-category env --error-msg "node_modules not found"
  journal.sh hook-capture < posttooluse.json
  journal.sh query --since 7d --skill dev-kickoff
  journal.sh query --source skill
  journal.sh query --source hook
  journal.sh stats --since 30d
  journal.sh stats --source skill
  journal.sh prune --days 30 --dry-run
USAGE
        exit 1
        ;;
esac
