# devflow-config.sh - repo 設定 "dev-flow".<key>（ci_verify / local_verify / visual_snapshots / pr_title_format / security_reviewer /
# branch_format / test_commands）を読む共有ヘルパー（source 専用。単体では実行しない）。dev-flow-prerun（dev-flow/scripts/prerun.sh）と
# pr-iterate-prerun（pr-iterate-prerun.sh。security-reviewer-config.sh 経由）、dev-flow-ready-set（ready-set.sh）、
# test-commands-prepare（test-commands-prepare.sh。test_commands の形はそこで検証する）が使う。
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
# 値の検証は workflow（_lib/prerun-setup.mjs、pr-iterate は args.security_reviewer の検査）が行う。branch_format だけは worktree を
# 作る前にブランチ名を決めるので、ここの devflow_branch_format_of が検証する。visual_snapshots もここの
# devflow_visual_snapshots_of が検証する（dev-flow-prerun が不正な宣言で止める）。JSON として読めない
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

# ---- 作業ブランチ名の書式 "dev-flow".branch_format（dev-flow-prerun と dev-flow-ready-set が共有する）----
# 差し込みは {issue}（必須・1 回）と {slug}（1 回まで。/dev-flow の wrapper が issue タイトルから作る英語の短い名前を
# dev-flow-prerun --slug で渡す）。未設定は feature/issue-{issue}。既存のブランチは {slug} を任意の [A-Za-z0-9._-]+ と
# みなしたパターン（issue 番号は固定）で探す — slug は run ごとに作り直すので、名前の完全一致で探すと同じ issue に
# 別のブランチができる。パターンの組み立てはここ 1 箇所に置き、prerun と ready-set で書式の解釈を食い違わせない。
DEVFLOW_BRANCH_FORMAT_DEFAULT='feature/issue-{issue}'

# devflow_branch_name <format> <issue> <slug>
#   書式の {issue} と {slug} を埋めた名前を stdout に出す
devflow_branch_name() {
    local s="${1//"{issue}"/$2}"
    printf '%s' "${s//"{slug}"/$3}"
}

# devflow_branch_regex <format> [<issue>]
#   書式に合うブランチ名の ERE（行全体）を stdout に出す。{issue} は <issue>（省略時は ([1-9][0-9]*) で、issue 番号が
#   BASH_REMATCH[1] / sed の \1 に入る）、{slug} は [A-Za-z0-9._-]+、それ以外の文字はそのまま一致させる
#   （検証済みの書式の文字は A-Za-z0-9._/- だけなので、逃がすのは . だけ）
devflow_branch_regex() {
    local fmt="$1" issue="${2:-}" re=''
    while [[ -n "$fmt" ]]; do
        case "$fmt" in
            '{issue}'*) re+="${issue:-([1-9][0-9]*)}"; fmt="${fmt:7}" ;;
            '{slug}'*) re+='[A-Za-z0-9._-]+'; fmt="${fmt:6}" ;;
            .*) re+='\.'; fmt="${fmt:1}" ;;
            *) re+="${fmt:0:1}"; fmt="${fmt:1}" ;;
        esac
    done
    printf '^%s$' "$re"
}

# devflow_branch_format_of <devflow_config の branch_format の JSON 値>
#   検証した書式を stdout に出す（null は既定の feature/issue-{issue}）。不正ならどのキーがなぜ不正かを書いたエラー文を
#   stdout に出して 1 を返す。黙って既定に倒すと repo のブランチ名の規則に合わないブランチを作り続け、誤記に気付けない。
#   LC_ALL=C で文字の範囲を ASCII に限る
devflow_branch_format_of() {
    local LC_ALL=C
    local raw="$1" fmt rest why='' unknown expanded
    if [[ "$raw" == 'null' ]]; then
        printf '%s' "$DEVFLOW_BRANCH_FORMAT_DEFAULT"
        return 0
    fi
    if ! jq -e 'type == "string" and . != ""' >/dev/null 2>&1 <<<"$raw"; then
        why='空でない文字列でない'
    elif jq -e 'test("[\r\n]")' >/dev/null 2>&1 <<<"$raw"; then
        why='改行を含む'
    else
        fmt="$(jq -r '.' <<<"$raw")"
        rest="${fmt//"{issue}"/}"
        case $(( (${#fmt} - ${#rest}) / 7 )) in
            0) why='{issue} が無い' ;;
            1) ;;
            *) why='{issue} が 2 回以上ある' ;;
        esac
        if [[ -z "$why" ]]; then
            rest="${rest//"{slug}"/}"
            if (( (${#fmt} - 7 - ${#rest}) / 6 > 1 )); then
                why='{slug} が 2 回以上ある'
            fi
        fi
        if [[ -z "$why" ]]; then
            unknown="$(grep -oE '\{[^{}]*\}' <<<"$rest" | tr '\n' ' ')" || unknown=''
            if [[ -n "$unknown" ]]; then
                why="未知の差し込み ${unknown% }"
            fi
        fi
        if [[ -z "$why" ]]; then
            expanded="$(devflow_branch_name "$fmt" 1 x)"
            if [[ ! "$expanded" =~ ^[A-Za-z0-9._/-]+$ ]]; then
                why="展開した名前 ${expanded} に A-Za-z0-9._/- 以外の文字がある"
            elif ! git check-ref-format --branch "$expanded" >/dev/null 2>&1; then
                why="展開した名前 ${expanded} が git check-ref-format --branch を通らない"
            fi
        fi
    fi
    if [[ -n "$why" ]]; then
        printf 'dev-flow: skill-config の "dev-flow".branch_format が不正（%s。受信: %s）— {issue}（必須）と {slug} を 1 回ずつまで差し込める、git の branch 名として正しい 1 行の文字列（文字は A-Za-z0-9._/-）に直してから再実行せよ' \
            "$why" "$raw"
        return 1
    fi
    printf '%s' "$fmt"
}

# ---- 基準画像の撮影の宣言 "dev-flow".visual_snapshots（dev-flow-prerun が読む）----
# 形は local_verify と同じ command・db・env・timeout_seconds に、基準画像のディレクトリ paths（repo 相対の glob の配列）を
# 足したもの。dev-flow は Evaluate の各評価の前に command を local-verify で実行し、paths の下で変わった PNG だけを PR に入れる。

# devflow_visual_snapshots_of <devflow_config の visual_snapshots の JSON 値>
#   検証した宣言（{command, db: {engine, version}, env, timeout_seconds, paths}）を JSON 1 行で stdout に出す（null は null）。
#   不正ならどのキーがなぜ不正かを書いたエラー文を stdout に出して 1 を返す。黙って未設定に倒すと、撮影されないまま
#   画面の変わる PR が出続け、誤記に気付けない。paths を repo 相対に限るのは、worktree の外を「PNG なら変えてよい場所」に
#   しないため（/ 始まり・.. を含むものは不正）
devflow_visual_snapshots_of() {
    local raw="$1" why
    if [[ "$raw" == 'null' ]]; then
        printf 'null'
        return 0
    fi
    why="$(jq -r '
        if type != "object" then "object でない"
        elif (.command | type) != "string" or (.command | test("^\\s*$")) then "command が空でない文字列でない"
        elif (.db | type) != "object" or .db.engine != "postgres" then "db.engine が \"postgres\" でない"
        elif (.db.version | type) != "string" or (.db.version | test("^\\s*$")) then "db.version が空でない文字列でない"
        elif (.env | type) != "string" or (.env | test("^[A-Za-z_][A-Za-z0-9_]*$") | not) then "env が環境変数名でない"
        elif (.timeout_seconds | type) != "number" or .timeout_seconds <= 0 or (.timeout_seconds | floor) != .timeout_seconds then "timeout_seconds が正の整数でない"
        elif (.paths | type) != "array" or (.paths | length) == 0 then "paths が空でない配列でない"
        elif .paths | any(type != "string" or test("^\\s*$")) then "paths に空でない文字列でないものがある"
        elif .paths | any(startswith("/")) then "paths に / 始まりのものがある"
        elif .paths | any(split("/") | any(. == "..")) then "paths に .. を含むものがある"
        else empty end' 2>/dev/null <<<"$raw")" || why='JSON として読めない'
    if [[ -n "$why" ]]; then
        printf 'dev-flow: skill-config の "dev-flow".visual_snapshots が不正（%s。受信: %s）— { command: string, db: { engine: "postgres", version: string }, env: 環境変数名, timeout_seconds: 正の整数, paths: repo 相対の glob の配列（1 件以上） } に直してから再実行せよ' \
            "$why" "$raw"
        return 1
    fi
    jq -c '{command, db: {engine: .db.engine, version: .db.version}, env, timeout_seconds, paths}' <<<"$raw"
}

# devflow_visual_snapshots <root> <base_ref>
#   "dev-flow".visual_snapshots を devflow_config と同じ読み先の順（repo 別の節 → origin/<base> → user 設定）で読み、
#   devflow_visual_snapshots_of で検証して出す
devflow_visual_snapshots() {
    devflow_visual_snapshots_of "$(devflow_config "$1" "$2" visual_snapshots)"
}
