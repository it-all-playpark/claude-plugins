# devflow-config.sh - repo 設定 "dev-flow".<key>（ci_verify / local_verify / pr_title_format / security_reviewer）を読む
# 共有ヘルパー（source 専用。単体では実行しない）。dev-flow-prerun（dev-flow/scripts/prerun.sh）と
# pr-iterate-prerun（pr-iterate-prerun.sh。security-reviewer-config.sh 経由）が使う。
#
# 読むのは PR が書き換えられない場所だけ。キーごとに次の順で最初に null でない値を返し、どこにも無ければ null:
#   (1) user 設定の repo 別の節 "dev-flow".repos["<owner>/<repo>"].<key>（user 設定のファイルの順）
#   (2) origin/<base> の tree の skill-config.json → .claude/skill-config.json（git show で読む）
#   (3) user 設定の "dev-flow".<key>（user 設定のファイルの順）
# user 設定は $SKILL_CONFIG_PATH → ~/.config/skills/config.json → ~/.claude/skill-config.json。<owner>/<repo> は
# 起動元のメイン checkout の origin の URL から決め（devflow_origin_repo）、大文字・小文字を区別せずに照合する。決められ
# なければ (1) は読まない。PR head（worktree）とメイン checkout の作業ツリーにある設定ファイルは読まない —
# 作業ツリーは sandbox 内で実行される PR のコードから書けるので、PR が自分の判定条件（どの check で判定するか・
# どのコマンドの exit 0 で satisfied にするか・gate の判定者）を選べてしまう。repo 別の上書きを user 設定にだけ
# 置くのも同じ理由（repo に置く gitignore 済みのファイルも作業ツリーにある）。
# 値の検証は workflow（_lib/prerun-setup.mjs、pr-iterate は parseSecurityReviewArg）が行う。JSON として読めない
# ファイルと、object でない "dev-flow".repos・repo 別の節は未設定として扱う。

# devflow_origin_repo <root>
#   <root> の origin の URL（https://github.com/ / git@github.com: / ssh://git@github.com/ の形。末尾の / と .git は
#   落とす）から <owner>/<repo> を stdout に出す。決められなければ何も出さない。URL は設定に書かれたまま
#   （url.<base>.insteadOf を展開しない）で読む。
devflow_origin_repo() {
    local url body
    url="$(git -C "$1" config --get remote.origin.url 2>/dev/null)" || url=''
    if [[ "$url" =~ ^https://github\.com/(.+)$ ]]; then
        body="${BASH_REMATCH[1]}"
    elif [[ "$url" =~ ^git@github\.com:(.+)$ ]]; then
        body="${BASH_REMATCH[1]}"
    elif [[ "$url" =~ ^ssh://git@github\.com/(.+)$ ]]; then
        body="${BASH_REMATCH[1]}"
    else
        return 0
    fi
    body="${body%/}"
    body="${body%.git}"
    if [[ "$body" =~ ^([^/]+)/([^/]+)$ ]]; then
        printf '%s/%s' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
    fi
}

# stdin の skill-config JSON から "dev-flow".<key> を JSON 値で出す（無ければ null）
devflow_config_value_of() {
    jq -c --arg key "$1" 'if type == "object" and (.["dev-flow"] | type) == "object" then .["dev-flow"][$key] else null end' 2>/dev/null
}

# stdin の user 設定 JSON から "dev-flow".repos["<owner>/<repo>"].<key>（第 1 引数の repo と大文字・小文字を区別せずに
# 一致する節）を JSON 値で出す（無ければ null）
devflow_repo_config_value_of() {
    jq -c --arg repo "$1" --arg key "$2" '
        if type == "object" and (.["dev-flow"] | type) == "object" and (.["dev-flow"].repos | type) == "object" then
            [.["dev-flow"].repos | to_entries[]
             | select((.key | ascii_downcase) == ($repo | ascii_downcase))
             | .value | select(type == "object") | .[$key] | select(. != null)][0]
        else null end' 2>/dev/null
}

# devflow_config <root> <base_ref> <key>
#   "dev-flow".<key> を JSON 値（無ければ null）で stdout に出す。<root> は origin を持つ起動元のメイン checkout、
#   <base_ref> が空なら base branch は見ずに user 設定だけを読む。
devflow_config() {
    local root="$1" base_ref="$2" key="$3" rel cfg v repo
    local user_configs=("${SKILL_CONFIG_PATH:-}" "${HOME}/.config/skills/config.json" "${HOME}/.claude/skill-config.json")
    repo="$(devflow_origin_repo "$root")"
    if [[ -n "$repo" ]]; then
        for cfg in "${user_configs[@]}"; do
            [[ -n "$cfg" && -f "$cfg" ]] || continue
            v="$(devflow_repo_config_value_of "$repo" "$key" <"$cfg")" || v=''
            if [[ -n "$v" && "$v" != 'null' ]]; then
                printf '%s' "$v"
                return 0
            fi
        done
    fi
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
