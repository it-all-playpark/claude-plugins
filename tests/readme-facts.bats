#!/usr/bin/env bats
# readme-facts.bats - README.md の記述を repo の実体と照合する（issue #899）。
#
# README は marketplace 利用者が最初に読む文書で、実体とずれると「載っている skill が
# 無い」「手順どおりに動かない」になる。ここでは実体から導ける事実だけを照合する:
#   - スキル一覧 = plugin 配下の skill（SKILL.md / skill.md）
#     （行の削除・架空 skill の追加で落ちることを fixture の README で確かめる。issue #925）
#   - 件数は書かない（skill / agent / wrapper の数は増減で腐る。manifest の件数は
#     plugin-manifest.bats が実数と照合する）
#   - License は LICENSE / plugin.json の license と一致させる
#   - Python 例の import は実際の script が使う形と同じ
#   - ほかの agent から使う節は locator が要求する PATH と ${CLAUDE_PLUGIN_ROOT} の前提を書く
#   - README / .gitignore は作者個人の環境（dotfiles repo・home-manager・rip）を前提にしない
#   - 設定節に載せる skill は実在し、キーは実装がそのセクションから読むものだけを書く（issue #900）

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
    README="$REPO_ROOT/README.md"
}

# README の `## <title>` 節（次の `## ` 見出しの手前まで）を出力する
readme_h2_section() {
    awk -v t="## $1" '$0 == t {on=1; next} on && /^## / {exit} on {print}' "$README"
}

# README の `### <title>` 節（次の `##` / `###` 見出しの手前まで）を出力する
readme_h3_section() {
    awk -v t="### $1" '$0 == t {on=1; next} on && /^##+ / {exit} on {print}' "$README"
}

# README の `#### <skill>` 設定キー表（次の見出しの手前まで）からトップレベルのキー名を出力する
readme_config_keys() {
    awk -v t="#### $1" '$0 == t {on=1; next} on && /^#+ / {exit} on {print}' "$README" \
        | grep -oE '^\| `[a-z_]+`' | grep -oE '[a-z_]+' | sort -u
}

@test "README の設定節に載る skill は plugin 配下に実在する" {
    # readme_h3_section は `####` でも止まるので、ここは次の `#`〜`###` 見出しまでを取る
    section="$(awk '$0 == "### 対応スキルと設定項目" {on=1; next} on && /^#{1,3} / {exit} on {print}' "$README")"
    global_example="$(readme_h3_section 'グローバル設定の例')"
    names="$( { grep -oE '^#### [a-z0-9-]+$' <<< "$section" | cut -d' ' -f2
                grep -oE '^  "[a-z0-9-]+": \{' <<< "$global_example" | grep -oE '[a-z0-9-]+'; } | sort -u)"
    [ -n "$names" ]
    while IFS= read -r name; do
        compgen -G "$REPO_ROOT/plugins/*/$name/SKILL.md" >/dev/null || {
            echo "README の設定節に実在しない skill: $name"
            return 1
        }
    done <<< "$names"
}

@test "README の ga-analyzer の設定キーは実装が読むセクションのキーと一致する" {
    skills="$REPO_ROOT/plugins/playpark-skills"
    # ga-analyzer: ga_fetch.py の merge_config(defaults, "ga-analyzer") の defaults
    impl="$(grep -E 'merge_config\(\{.*\}, "ga-analyzer"\)' "$skills/ga-analyzer/scripts/ga_fetch.py" | grep -oE '"[a-z_]+":' | grep -oE '[a-z_]+' | sort -u)"
    documented="$(readme_config_keys ga-analyzer)"
    echo "ga-analyzer impl=[$impl] documented=[$documented]"
    [ -n "$impl" ]
    [ "$documented" = "$impl" ]
}

# <readme> のスキル一覧が plugin 配下の skill と過不足なく一致すれば 0。ずれた skill 名を出して 1 を返す。
# local README で readme_h2_section の読み先を差し替える（fixture の README でも同じ判定を通すため）。
readme_skill_list_matches() {
    local README="$1" listed actual
    listed="$(readme_h2_section 'スキル一覧' | grep -oE '^\| `[a-z0-9-]+` \|' | grep -oE '[a-z0-9-]+' | sort -u)"
    actual="$(git -C "$REPO_ROOT" ls-files -- 'plugins/*' | grep -iE '^plugins/[^/]+/[^/]+/skill\.md$' | cut -d/ -f3 | sort -u)"
    [ -n "$listed" ] || { echo "スキル一覧の表が空"; return 1; }
    [ "$listed" = "$actual" ] && return 0
    echo "$listed" > "$BATS_TEST_TMPDIR/listed"
    echo "$actual" > "$BATS_TEST_TMPDIR/actual"
    grep -vxFf "$BATS_TEST_TMPDIR/actual" "$BATS_TEST_TMPDIR/listed" | sed 's/^/README にだけある: /'
    grep -vxFf "$BATS_TEST_TMPDIR/listed" "$BATS_TEST_TMPDIR/actual" | sed 's/^/README に無い: /'
    return 1
}

@test "README のスキル一覧は plugin 配下の skill に過不足なく一致する" {
    run readme_skill_list_matches "$README"
    echo "$output"
    [ "$status" -eq 0 ]
}

@test "fixture: README のスキル一覧から実在 skill を 1 行消すと一致しない" {
    fixture="$BATS_TEST_TMPDIR/README.md"
    grep -v '^| `git-commit` |' "$README" > "$fixture"
    run readme_skill_list_matches "$fixture"
    echo "$output"
    [ "$status" -eq 1 ]
    [ "$output" = "README に無い: git-commit" ]
}

@test "fixture: README のスキル一覧に実在しない skill を 1 行足すと一致しない" {
    fixture="$BATS_TEST_TMPDIR/README.md"
    awk '{print} $0 ~ /^\| `git-commit` \|/ {print "| `no-such-skill` | 実在しない |"}' "$README" > "$fixture"
    run readme_skill_list_matches "$fixture"
    echo "$output"
    [ "$status" -eq 1 ]
    [ "$output" = "README にだけある: no-such-skill" ]
}

@test "README は skill / agent / bin wrapper の件数を書かない" {
    run grep -nE '[0-9]+\+? ?([A-Za-z-]+ )?(skills?|agents?)([^A-Za-z/._-]|$)|wrapper（[0-9]+|[0-9]+ ?本' "$README"
    echo "$output"
    [ "$status" -eq 1 ]
}

@test "README の License 節は LICENSE と各 plugin.json の license を書く" {
    section="$(readme_h2_section 'License')"
    head -1 "$REPO_ROOT/LICENSE" | grep -qx 'MIT License'
    for pj in "$REPO_ROOT"/plugins/*/.claude-plugin/plugin.json; do
        license="$(jq -r '.license' "$pj")"
        [ "$license" = "MIT" ]
    done
    [[ "$section" == *"MIT"* ]]
    [[ "$section" == *"LICENSE"* ]]
}

@test "README の Python 例の sys.path / import 行は playpark-skills の実 script と同じ形である" {
    py="$(awk '/^```python$/ {on=1; next} on && /^```$/ {on=0} on {print}' "$README")"
    [ -n "$py" ]
    lines="$(echo "$py" | grep -E '^(sys\.path\.insert|from |import )')"
    [ -n "$lines" ]
    while IFS= read -r line; do
        git -C "$REPO_ROOT" grep -qF -e "$line" -- 'plugins/playpark-skills/*.py' || {
            echo "README の Python 例の行が実 script に無い: $line"
            return 1
        }
    done <<< "$lines"
    [[ "$lines" == *"from config import merge_config"* ]]
}

@test "README のほかの agent から使う節は locator が要求する PATH と \${CLAUDE_PLUGIN_ROOT} の前提を書く" {
    section="$(readme_h3_section 'ほかの agent（Codex 等）から使う')"
    [ -n "$section" ]
    # common.sh locator は PATH 上の journal を探す（tests/common-sh-locator.bats）
    [ -x "$REPO_ROOT/plugins/playpark-core/bin/journal" ]
    [[ "$section" == *"plugins/playpark-core/bin"* ]]
    [[ "$section" == *"plugins/playpark-skills/bin"* ]]
    if git -C "$REPO_ROOT" grep -qF '${CLAUDE_PLUGIN_ROOT}' -- 'plugins/playpark-skills/*SKILL.md'; then
        [[ "$section" == *'${CLAUDE_PLUGIN_ROOT}'* ]]
        [[ "$section" == *'export CLAUDE_PLUGIN_ROOT='* ]]
    fi
    [[ "$section" == *"Claude Code 専用"* ]]
}

@test "README と .gitignore は作者個人の環境（dotfiles repo・home-manager・rip）を前提にしない" {
    run grep -nE 'dotfiles|home-manager|(^|[^a-z])rip ' "$README" "$REPO_ROOT/.gitignore"
    echo "$output"
    [ "$status" -eq 1 ]
    # ~/.claude/skills が本 repo を指す構成は撤去済み（plugin install に移行）で、.gitignore が前提にしない
    run grep -nF '~/.claude/skills' "$REPO_ROOT/.gitignore"
    echo "$output"
    [ "$status" -eq 1 ]
}
