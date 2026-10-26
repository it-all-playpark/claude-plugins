# security-reviewer-config.sh - security review を回す CLI の opt-in（"dev-flow".security_reviewer）を読む（source 専用。単体では実行しない）
# dev-flow-prerun（dev-flow/scripts/prerun.sh）と pr-iterate-prerun（pr-iterate-prerun.sh）が使い、値は pr-iterate-run の
# args.security_review.reviewer に渡る（nested・単体起動で同じ規則）。
#
# base branch（origin/<base>）の skill-config.json / .claude/skill-config.json（前者優先）を先に、無ければ user 設定
# （USER_CONFIGS の順）を読む。PR head（worktree）の設定ファイルは読まない — PR が gate の判定者を自分で選べないようにする。
# どこにも無ければ "claude"。値の検証は workflow（dev-flow は _lib/prerun-setup.mjs、pr-iterate は parseSecurityReviewArg）が
# 行い、out-of-enum は明示 error にする。JSON として読めないファイルは未設定として扱う。

USER_CONFIGS=("${SKILL_CONFIG_PATH:-}" "${HOME}/.config/skills/config.json" "${HOME}/.claude/skill-config.json")

# stdin の skill-config JSON から "dev-flow".security_reviewer を JSON 値で出す（無ければ null）
reviewer_of() {
    jq -c 'if type == "object" and (.["dev-flow"] | type) == "object" then .["dev-flow"].security_reviewer else null end' 2>/dev/null
}

# security_reviewer_config <root> <base_ref>
#   opt-in の値を JSON 値（既定は "claude"）で stdout に出す。<root> は origin を持つ checkout、<base_ref> が空なら
#   base branch は見ずに user 設定だけを読む。
security_reviewer_config() {
    local root="$1" base_ref="$2" rel cfg v
    if [[ -n "$base_ref" ]]; then
        for rel in skill-config.json .claude/skill-config.json; do
            v="$(git -C "$root" show "refs/remotes/origin/${base_ref}:${rel}" 2>/dev/null | reviewer_of)" || v=''
            if [[ -n "$v" && "$v" != 'null' ]]; then
                printf '%s' "$v"
                return 0
            fi
        done
    fi
    for cfg in "${USER_CONFIGS[@]}"; do
        [[ -n "$cfg" && -f "$cfg" ]] || continue
        v="$(reviewer_of <"$cfg")" || v=''
        if [[ -n "$v" && "$v" != 'null' ]]; then
            printf '%s' "$v"
            return 0
        fi
    done
    printf '"claude"'
}
