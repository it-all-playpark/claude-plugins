#!/usr/bin/env bats
# plugin-hooks.bats - hook を持つ 2 plugin (dev-flow / playpark-core) 横断の
# hooks/hooks.json 構造 invariant テスト（issue #572）。
#
# Invariants pinned here:
#   - 2 plugin すべてに hooks/hooks.json が存在し valid JSON である。
#   - hooks.json 内の全 command は ${CLAUDE_PLUGIN_ROOT} 経由で参照する（dotfiles 由来の
#     絶対パス $HOME/.claude/hooks・~/.claude/skills・$HOME/.claude/skills・ghq/github.com
#     を含む command は 0 件）。
#   - ${CLAUDE_PLUGIN_ROOT}/<rel> で参照される全ファイルが実在し実行可能である。
#     git index 上 tracked なファイルに限り mode 100755 も確認する（新規 hook は
#     implementer が git add/commit しない規約のため untracked のまま — index 検査は
#     tracked のみに限定し、untracked をスキップする）。
#   - dev-flow / playpark-core それぞれの参照 rel 集合・
#     event/matcher 配線が計画どおりである。
#   - plugin hook script が dotfiles 側の絶対パス（旧 skills repo の ghq パス・
#     $HOME/.claude/hooks/）を参照していない（dead path 不在）。
#   - claude CLI の実挙動（`plugin details` の Hooks 行）で各 plugin の event 名が
#     実際にロードされていることを pin する。

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
}

hooks_json_path() {
    echo "$REPO_ROOT/plugins/$1/hooks/hooks.json"
}

all_commands() {
    jq -r '.hooks[][]?.hooks[]?.command' "$(hooks_json_path "$1")"
}

plugin_root_refs() {
    all_commands "$1" | grep -oE '\$\{CLAUDE_PLUGIN_ROOT\}/[^" ]+' | sed 's#^\${CLAUDE_PLUGIN_ROOT}/##' | sort -u
}

PLUGIN_NAMES=(dev-flow playpark-core)

# --- 1. hooks.json の存在・構造 ---------------------------------------------

@test "2 plugin すべてに plugins/<name>/hooks/hooks.json が存在する" {
    for name in "${PLUGIN_NAMES[@]}"; do
        [ -f "$(hooks_json_path "$name")" ]
    done
}

@test "2 plugin すべての hooks.json が valid JSON である" {
    for name in "${PLUGIN_NAMES[@]}"; do
        run jq empty "$(hooks_json_path "$name")"
        [ "$status" -eq 0 ]
    done
}

@test "2 plugin すべての hooks.json の .hooks は object である" {
    for name in "${PLUGIN_NAMES[@]}"; do
        run jq -r '.hooks | type' "$(hooks_json_path "$name")"
        [ "$status" -eq 0 ]
        [ "$output" = "object" ]
    done
}

# --- 2. command 内容: PLUGIN_ROOT 経由 or 既知の一時ファイル掃除のみ --------

@test "全 command は \${CLAUDE_PLUGIN_ROOT} を含む" {
    for name in "${PLUGIN_NAMES[@]}"; do
        while IFS= read -r cmd; do
            [ -z "$cmd" ] && continue
            case "$cmd" in
                *'${CLAUDE_PLUGIN_ROOT}'*) ;;
                *)
                    echo "unexpected command in $name: $cmd"
                    return 1
                    ;;
            esac
        done < <(all_commands "$name")
    done
}

@test "全 command に dotfiles 由来の絶対パスを含むものが 0 件である" {
    for name in "${PLUGIN_NAMES[@]}"; do
        run bash -c "jq -r '.hooks[][]?.hooks[]?.command' '$(hooks_json_path "$name")' | grep -F -e '\$HOME/.claude/hooks' -e '~/.claude/skills' -e '\$HOME/.claude/skills' -e 'ghq/github.com'"
        [ "$status" -ne 0 ]
        [ -z "$output" ]
    done
}

# --- 3. 参照先ファイルの存在・実行ビット ------------------------------------

@test "\${CLAUDE_PLUGIN_ROOT} 参照先ファイルが全て実在し実行可能である" {
    for name in "${PLUGIN_NAMES[@]}"; do
        while IFS= read -r rel; do
            [ -z "$rel" ] && continue
            target="$REPO_ROOT/plugins/$name/$rel"
            [ -f "$target" ]
            [ -x "$target" ]
        done < <(plugin_root_refs "$name")
    done
}

@test "\${CLAUDE_PLUGIN_ROOT} 参照先のうち git index で tracked なファイルは mode 100755 である" {
    for name in "${PLUGIN_NAMES[@]}"; do
        while IFS= read -r rel; do
            [ -z "$rel" ] && continue
            relpath="plugins/$name/$rel"
            if git -C "$REPO_ROOT" ls-files --error-unmatch -- "$relpath" >/dev/null 2>&1; then
                mode="$(git -C "$REPO_ROOT" ls-files -s -- "$relpath" | awk '{print $1}')"
                [ "$mode" = "100755" ]
            fi
        done < <(plugin_root_refs "$name")
    done
}

# --- 4. dev-flow: 参照集合・event/matcher 配線 ------------------------------

@test "dev-flow の参照 rel 集合が計画どおり 6 hook に完全一致する" {
    expected=$'hooks/pretool-bash-inline-commit-gate.sh\nhooks/pretool-bash-issue-create-guard.sh\nhooks/pretool-codex-invocation-guard.sh\nhooks/pretool-inline-edit-guard.sh\nhooks/pretool-security-reviewer-read-scope.sh\nhooks/stop-devflow-telemetry.sh'
    actual="$(plugin_root_refs dev-flow)"
    [ "$actual" = "$expected" ]
}

@test "dev-flow の .hooks.Stop は 1 entry である" {
    run jq -r '.hooks.Stop | length' "$(hooks_json_path dev-flow)"
    [ "$status" -eq 0 ]
    [ "$output" = "1" ]
}

@test "dev-flow の .hooks.PreToolUse[].matcher 集合が Bash と Edit|Write と Read|Grep|Glob である" {
    run jq -r '[.hooks.PreToolUse[].matcher] | sort | join(",")' "$(hooks_json_path dev-flow)"
    [ "$status" -eq 0 ]
    [ "$output" = "Bash,Edit|Write,Read|Grep|Glob" ]
}

# --- 5. playpark-core: 参照集合・配線 ---------------------------------------

@test "playpark-core の参照 rel 集合が計画どおり 4 hook に完全一致する" {
    expected=$'hooks/posttool-secret-mask.sh\nhooks/pretool-context-guard.sh\nhooks/validate-skill-frontmatter.sh\njournal/scripts/journal.sh'
    actual="$(plugin_root_refs playpark-core)"
    [ "$actual" = "$expected" ]
}

@test "playpark-core の hook-capture が PostToolUseFailure にある" {
    run jq -r '.hooks.PostToolUseFailure[0].hooks[0].command' "$(hooks_json_path playpark-core)"
    [ "$status" -eq 0 ]
    [[ "$output" == *'journal.sh" hook-capture'* ]]
}

@test "playpark-core の track-skill が PreToolUse(matcher Skill) にある" {
    run jq -r '.hooks.PreToolUse[] | select(.matcher=="Skill") | .hooks[0].command' "$(hooks_json_path playpark-core)"
    [ "$status" -eq 0 ]
    [[ "$output" == *'journal.sh" track-skill'* ]]
}

@test "playpark-core の validate-skill-frontmatter entry は if: Write(*/SKILL.md) である" {
    run jq -r '.hooks.PreToolUse[] | select(.matcher=="Write") | .hooks[0].if' "$(hooks_json_path playpark-core)"
    [ "$status" -eq 0 ]
    [ "$output" = "Write(*/SKILL.md)" ]
}

# --- 7/8. dead path invariant -----------------------------------------------

@test "tracked な *.sh にrepo clone の ghq 絶対パスが残っていない" {
    run git -C "$REPO_ROOT" grep -nIF -e 'ghq/github.com/it-all-playpark/claude-plugins/' -- '*.sh' ':(exclude)tests/'
    echo "$output"
    [ "$status" -ne 0 ]
}

@test "新規 hook (untracked) にもrepo clone の ghq 絶対パスが残っていない" {
    run bash -c "grep -rlF 'ghq/github.com/it-all-playpark/claude-plugins/' '$REPO_ROOT/plugins/dev-flow/hooks' '$REPO_ROOT/plugins/playpark-core/hooks'"
    echo "$output"
    [ "$status" -ne 0 ]
    [ -z "$output" ]
}

@test "plugin hook が dotfiles hook dir (.claude/hooks/) を参照していない" {
    run bash -c "grep -rlF '.claude/hooks/' '$REPO_ROOT/plugins/dev-flow/hooks' '$REPO_ROOT/plugins/playpark-core/hooks'"
    echo "$output"
    [ -z "$output" ]
}

# --- 9. claude CLI 実挙動 pin -------------------------------------------------

@test "claude CLI: dev-flow plugin の Hooks 行に Stop と PreToolUse が含まれる" {
    command -v claude >/dev/null 2>&1 || skip "claude CLI not available"
    run claude --plugin-dir "$REPO_ROOT/plugins/dev-flow" plugin details dev-flow
    [ "$status" -eq 0 ]
    [[ "$output" == *"Hooks ("* ]]
    [[ "$output" != *"Hooks (0)"* ]]
    hooks_line="$(echo "$output" | grep 'Hooks (')"
    [[ "$hooks_line" == *"Stop"* ]]
    [[ "$hooks_line" == *"PreToolUse"* ]]
}

@test "claude CLI: playpark-core plugin の Hooks 行に全 3 event が含まれる" {
    command -v claude >/dev/null 2>&1 || skip "claude CLI not available"
    run claude --plugin-dir "$REPO_ROOT/plugins/playpark-core" plugin details playpark-core
    [ "$status" -eq 0 ]
    [[ "$output" == *"Hooks ("* ]]
    [[ "$output" != *"Hooks (0)"* ]]
    hooks_line="$(echo "$output" | grep 'Hooks (')"
    [[ "$hooks_line" == *"PreToolUse"* ]]
    [[ "$hooks_line" == *"PostToolUse"* ]]
    [[ "$hooks_line" == *"PostToolUseFailure"* ]]
}
