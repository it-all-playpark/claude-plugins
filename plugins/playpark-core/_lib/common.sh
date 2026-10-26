#!/usr/bin/env bash
# common.sh - Shared utilities for skill scripts
# Source this file:
#   - 同一 plugin（playpark-core）内: source "$(dirname "$0")/../../_lib/common.sh"
#   - 他 plugin（dev-flow / playpark-skills）から: core の bin/journal を PATH 上の
#     起点にする 3 行 locator を使う（plugin 境界を ../ で跨げないため）。
#     詳細: README / docs/skill-creation-guide.md

[[ -n "${_SKILL_COMMON_LOADED:-}" ]] && return 0
_SKILL_COMMON_LOADED=1

# ============================================================================
# SKILLS_DIR Resolution
# ============================================================================
# Resolve playpark-core plugin root from this file's location (_lib/common.sh → core plugin root)。
# core plugin root（旧: skills repo root）。$SKILLS_DIR/journal/scripts/journal.sh は
# この root で解決する
export SKILLS_DIR="${SKILLS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

# ============================================================================
# JSON Helpers
# ============================================================================

has_jq() {
    command -v jq &>/dev/null
}

# Escape string for JSON - strips trailing newlines
json_escape() {
    local str="${1%$'\n'}"  # Strip trailing newline
    if has_jq; then
        printf '%s' "$str" | jq -Rs .
    else
        str="${str//\\/\\\\}"
        str="${str//\"/\\\"}"
        str="${str//$'\n'/\\n}"
        str="${str//$'\t'/\\t}"
        echo "\"$str\""
    fi
}

json_str() {
    local val="${1%$'\n'}"  # Strip trailing newline
    if [[ -z "$val" ]]; then
        echo "null"
    else
        json_escape "$val"
    fi
}

json_array() {
    if has_jq; then
        jq -nR '[inputs]'
    else
        local first=true
        echo -n "["
        while IFS= read -r line; do
            [[ "$first" == true ]] || echo -n ","
            first=false
            json_escape "$line" | tr -d '\n'
        done
        echo "]"
    fi
}

# ============================================================================
# Error Handling
# ============================================================================

die_json() {
    local msg="$1"
    local code="${2:-1}"
    echo "{\"status\":\"error\",\"error\":$(json_str "$msg"),\"exit_code\":$code}" >&2
    exit "$code"
}

err() { echo "Error: $1" >&2; }
warn() { echo "Warning: $1" >&2; }

# ============================================================================
# Requirement Checks
# ============================================================================

require_cmd() {
    local cmd="$1"
    local msg="${2:-Required command '$cmd' not found}"
    command -v "$cmd" &>/dev/null || die_json "$msg" 127
}

require_git_repo() {
    git rev-parse --git-dir &>/dev/null 2>&1 || die_json "Not a git repository" 128
}

require_gh_auth() {
    require_cmd "gh" "GitHub CLI (gh) not installed. Install: brew install gh"
    # Use 'gh auth token' instead of 'gh auth status' to check authentication
    # 'gh auth status' returns exit code 1 if ANY account is invalid, even if active account works
    # 'gh auth token' only checks if active account has a valid token
    gh auth token &>/dev/null || die_json "GitHub CLI not authenticated. Run: gh auth login" 129
}

require_cmds() {
    for cmd in "$@"; do require_cmd "$cmd"; done
}

# ============================================================================
# Git Helpers
# ============================================================================

git_current_branch() {
    git branch --show-current 2>/dev/null | tr -d '\n'
}

git_root() {
    git rev-parse --show-toplevel 2>/dev/null | tr -d '\n'
}

# ============================================================================
# Timing
# ============================================================================

now_sec() { date +%s; }

# ============================================================================
# Config Loading
# ============================================================================

# Load skill section from global config
# Resolution: $SKILL_CONFIG_PATH > ~/.config/skills/config.json > ~/.claude/skill-config.json
_load_global_skill_config() {
  local skill_name="$1"
  local candidates=(
    "${SKILL_CONFIG_PATH:-}"
    "${HOME}/.config/skills/config.json"
    "${HOME}/.claude/skill-config.json"
  )
  for global_path in "${candidates[@]}"; do
    [[ -n "$global_path" && -f "$global_path" ]] || continue
    local section
    section=$(jq -r --arg key "$skill_name" '.[$key] // empty' "$global_path" 2>/dev/null)
    [[ -n "$section" ]] && { echo "$section"; return; }
  done
  echo "{}"
}

# Load skill config: global → project merge
load_skill_config() {
  local skill_name="$1"

  # Layer 1: Global
  local global_cfg
  global_cfg="$(_load_global_skill_config "$skill_name")"

  # Layer 2: Project
  local project_cfg="{}"
  local git_root
  git_root="$(git rev-parse --show-toplevel 2>/dev/null)" || true

  if [[ -n "$git_root" ]]; then
    # 2a. skill-config.json (tool-agnostic path first, then legacy)
    local config_candidates=(
      "${git_root}/skill-config.json"
      "${git_root}/.claude/skill-config.json"
    )
    for config_path in "${config_candidates[@]}"; do
      if [[ -f "$config_path" ]]; then
        local section
        section=$(jq -r --arg key "$skill_name" '.[$key] // empty' "$config_path" 2>/dev/null)
        [[ -n "$section" ]] && { project_cfg="$section"; break; }
      fi
    done
  fi

  # Merge: global * project (project wins)
  if [[ "$global_cfg" == "{}" ]]; then
    echo "$project_cfg"
  elif [[ "$project_cfg" == "{}" ]]; then
    echo "$global_cfg"
  else
    echo "$global_cfg" | jq --argjson proj "$project_cfg" '. * $proj'
  fi
}

# Deep merge: defaults → skill-config.json[skill] (CLI args handled by caller)
merge_config() {
  local defaults="$1"
  local skill_name="$2"
  local skill_cfg
  skill_cfg="$(load_skill_config "$skill_name")"
  echo "$defaults" | jq --argjson user "$skill_cfg" '. * $user'
}
