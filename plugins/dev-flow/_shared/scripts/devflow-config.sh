# devflow-config.sh - repo 設定 "dev-flow".<key>（ci_verify / local_verify / pr_title_format / security_reviewer）を読む
# 共有ヘルパー（source 専用。単体では実行しない）。dev-flow-prerun（dev-flow/scripts/prerun.sh）と
# pr-iterate-prerun（pr-iterate-prerun.sh。security-reviewer-config.sh 経由）が使う。
#
# 読むのは PR が書き換えられない場所だけ: (1) origin/<base> の tree の skill-config.json → .claude/skill-config.json
# （git show で読む）、(2) user 設定（$SKILL_CONFIG_PATH → ~/.config/skills/config.json → ~/.claude/skill-config.json）。キーごとに最初に null でない値が見つかったファイルの
# 値を返し、どこにも無ければ null。PR head（worktree）とメイン checkout の作業ツリーにある設定ファイルは読まない —
# 作業ツリーは sandbox 内で実行される PR のコードから書けるので、PR が自分の判定条件（どの check で判定するか・
# どのコマンドの exit 0 で satisfied にするか・gate の判定者）を選べてしまう。
# 値の検証は workflow（_lib/prerun-setup.mjs、pr-iterate は parseSecurityReviewArg）が行う。JSON として読めない
# ファイルは未設定として扱う。

# stdin の skill-config JSON から "dev-flow".<key> を JSON 値で出す（無ければ null）
devflow_config_value_of() {
    jq -c --arg key "$1" 'if type == "object" and (.["dev-flow"] | type) == "object" then .["dev-flow"][$key] else null end' 2>/dev/null
}

# devflow_config <root> <base_ref> <key>
#   "dev-flow".<key> を JSON 値（無ければ null）で stdout に出す。<root> は origin を持つ起動元のメイン checkout、
#   <base_ref> が空なら base branch は見ずに user 設定だけを読む。
devflow_config() {
    local root="$1" base_ref="$2" key="$3" rel cfg v
    local user_configs=("${SKILL_CONFIG_PATH:-}" "${HOME}/.config/skills/config.json" "${HOME}/.claude/skill-config.json")
    if [[ -n "$base_ref" ]]; then
        for rel in skill-config.json .claude/skill-config.json; do
            v="$(git -C "$root" show "refs/remotes/origin/${base_ref}:${rel}" 2>/dev/null | devflow_config_value_of "$key")" || v=''
            if [[ -n "$v" && "$v" != 'null' ]]; then
                printf '%s' "$v"
                return 0
            fi
        done
    fi
    for cfg in "${user_configs[@]}"; do
        [[ -n "$cfg" && -f "$cfg" ]] || continue
        v="$(devflow_config_value_of "$key" <"$cfg")" || v=''
        if [[ -n "$v" && "$v" != 'null' ]]; then
            printf '%s' "$v"
            return 0
        fi
    done
    printf 'null'
}
