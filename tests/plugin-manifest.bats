#!/usr/bin/env bats
# plugin-manifest.bats - Regression tests for the marketplace layout
# (playpark-core / dev-flow / playpark-skills / host-exec / meeting / bg-sessions, issue #571).
#
# Invariants pinned here:
#   - marketplace.json lists exactly the 6 plugins, each sourced from
#     ./plugins/<name>, so they can be installed independently.
#   - Each plugin.json is valid, its name matches its directory, skills
#     is ["./"] for the skill-shipping plugins and absent for host-exec
#     (a hooks-module plugin with no skills), and there is no "agents" key (plugin subagents are only ever loaded from
#     plugin-root agents/, never from a plugin.json "agents" key -
#     measured: Agents (0)).
#   - dev-flow is the only plugin that ships workflows (the 5 dynamic
#     workflow scripts) and it declares a dependency on playpark-core
#     (cross-plugin bin/_lib resolution requires playpark-core's bin/ on
#     PATH - see _lib/common.sh locator).
#   - dev-flow/agents/ stays a REAL directory (not a symlink): git checks
#     out a mode-120000 entry as a plain text file wherever symlinks are
#     unavailable (Windows without Developer Mode, core.symlinks=false),
#     so putting the symlink on agents/ would make a consumer's install
#     silently degrade to Agents (0) while skills still load - measured,
#     not theoretical. dev-flow/.claude/agents stays the symlink (only
#     affects developing this repo, never consuming it).
#   - neither plugin.json nor the marketplace entries carry a "version"
#     key: with an explicit version, installs only update on a bump;
#     without it the git commit SHA is the version, so every commit on
#     main reaches marketplace installs.
#   - the old single-plugin root manifest (.claude-plugin/plugin.json) is
#     gone; the repo is no longer a plugin itself.

REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
MARKETPLACE_JSON="$REPO_ROOT/.claude-plugin/marketplace.json"
ROOT_PLUGIN_JSON="$REPO_ROOT/.claude-plugin/plugin.json"

PLUGIN_NAMES=(playpark-core dev-flow playpark-skills host-exec meeting bg-sessions)
SKILL_PLUGIN_NAMES=(playpark-core dev-flow playpark-skills meeting)

plugin_json_path() {
    echo "$REPO_ROOT/plugins/$1/.claude-plugin/plugin.json"
}

@test "marketplace.json が存在する" {
    [ -f "$MARKETPLACE_JSON" ]
}

@test "marketplace.json は valid JSON" {
    run jq empty "$MARKETPLACE_JSON"
    [ "$status" -eq 0 ]
}

@test "root の .claude-plugin/plugin.json は存在しない（repo 自体は plugin ではない）" {
    [ ! -f "$ROOT_PLUGIN_JSON" ]
}

@test "marketplace.json の plugins は 6 件である" {
    run jq -r '.plugins | length' "$MARKETPLACE_JSON"
    [ "$status" -eq 0 ]
    [ "$output" = "6" ]
}

@test "marketplace.json の plugins[].name が playpark-core/dev-flow/playpark-skills/host-exec/meeting/bg-sessions に完全一致する" {
    run jq -r '[.plugins[].name] | sort | join(",")' "$MARKETPLACE_JSON"
    [ "$status" -eq 0 ]
    [ "$output" = "bg-sessions,dev-flow,host-exec,meeting,playpark-core,playpark-skills" ]
}

@test "marketplace.json の各 plugins[].source が ./plugins/<name> である" {
    for name in "${PLUGIN_NAMES[@]}"; do
        run jq -r --arg n "$name" '.plugins[] | select(.name == $n) | .source' "$MARKETPLACE_JSON"
        [ "$status" -eq 0 ]
        [ "$output" = "./plugins/$name" ]
    done
}

@test "各 plugins/<name>/.claude-plugin/plugin.json が存在し valid JSON である" {
    for name in "${PLUGIN_NAMES[@]}"; do
        pj="$(plugin_json_path "$name")"
        [ -f "$pj" ]
        run jq empty "$pj"
        [ "$status" -eq 0 ]
    done
}

@test "各 plugin.json の name はディレクトリ名と一致する" {
    for name in "${PLUGIN_NAMES[@]}"; do
        pj="$(plugin_json_path "$name")"
        run jq -r '.name' "$pj"
        [ "$status" -eq 0 ]
        [ "$output" = "$name" ]
    done
}

@test "skill を持つ plugin の plugin.json の skills は [\"./\"] に完全一致する" {
    for name in "${SKILL_PLUGIN_NAMES[@]}"; do
        pj="$(plugin_json_path "$name")"
        run jq -c '.skills' "$pj"
        [ "$status" -eq 0 ]
        [ "$output" = '["./"]' ]
    done
}

@test "各 plugin.json に agents キーが存在しない（plugin-root agents/ ディレクトリ規約を使う）" {
    for name in "${PLUGIN_NAMES[@]}"; do
        pj="$(plugin_json_path "$name")"
        run jq -r 'has("agents")' "$pj"
        [ "$status" -eq 0 ]
        [ "$output" = "false" ]
    done
}

@test "各 plugin.json に version キーが存在しない（git commit SHA で main 追随させる）" {
    for name in "${PLUGIN_NAMES[@]}"; do
        pj="$(plugin_json_path "$name")"
        run jq -r 'has("version")' "$pj"
        [ "$status" -eq 0 ]
        [ "$output" = "false" ]
    done
}

@test "marketplace.json の各 plugins[] に version キーが存在しない（git commit SHA で main 追随させる）" {
    run jq -r '[.plugins[] | has("version")] | any' "$MARKETPLACE_JSON"
    [ "$status" -eq 0 ]
    [ "$output" = "false" ]
}

@test "host-exec・bg-sessions は skill を持たず、hooks.json の modules で register module を読み込む" {
    for pair in host-exec:register.ts bg-sessions:register.tsx; do
        name="${pair%%:*}" module="${pair#*:}"
        pj="$(plugin_json_path "$name")"
        run jq -r 'has("skills")' "$pj"
        [ "$status" -eq 0 ]
        [ "$output" = "false" ]
        run jq -c '.modules' "$REPO_ROOT/plugins/$name/hooks/hooks.json"
        [ "$status" -eq 0 ]
        [ "$output" = "[\"./$module\"]" ]
        [ -f "$REPO_ROOT/plugins/$name/hooks/$module" ]
    done
}

@test "dev-flow の plugin.json の workflows は [\"./.claude/workflows\"] に完全一致する" {
    pj="$(plugin_json_path dev-flow)"
    run jq -c '.workflows' "$pj"
    [ "$status" -eq 0 ]
    [ "$output" = '["./.claude/workflows"]' ]
}

@test "dev-flow の workflows ディレクトリに 4 本の js が存在し、撤去した dev-improve.js は無い" {
    dir="$REPO_ROOT/plugins/dev-flow/.claude/workflows"
    [ -f "$dir/dev-flow.js" ]
    [ -f "$dir/pr-iterate.js" ]
    [ -f "$dir/dev-flow-canary.js" ]
    [ -f "$dir/dev-flow-canary-child.js" ]
    [ ! -e "$dir/dev-improve.js" ]
}

@test "dev-flow の plugin.json の dependencies は [\"playpark-core\"] に完全一致する" {
    pj="$(plugin_json_path dev-flow)"
    run jq -c '.dependencies' "$pj"
    [ "$status" -eq 0 ]
    [ "$output" = '["playpark-core"]' ]
}

@test "playpark-skills の plugin.json の dependencies は [\"playpark-core\"] に完全一致する" {
    pj="$(plugin_json_path playpark-skills)"
    run jq -c '.dependencies' "$pj"
    [ "$status" -eq 0 ]
    [ "$output" = '["playpark-core"]' ]
}

@test "dev-flow 以外の plugin.json に workflows キーが存在しない" {
    for name in playpark-core playpark-skills host-exec meeting bg-sessions; do
        pj="$(plugin_json_path "$name")"
        run jq -r 'has("workflows")' "$pj"
        [ "$status" -eq 0 ]
        [ "$output" = "false" ]
    done
}

@test "dev-flow/agents は実ファイルのディレクトリである（symlink にしない）" {
    dir="$REPO_ROOT/plugins/dev-flow/agents"
    [ -d "$dir" ]
    [ ! -L "$dir" ]
    run git -C "$REPO_ROOT" ls-files -s plugins/dev-flow/agents
    [ "$status" -eq 0 ]
    [ -n "$output" ]
    [[ "$output" != *"120000 "* ]]
}

@test "dev-flow/.claude/agents は ../agents への symlink で、git 上も mode 120000 である" {
    link="$REPO_ROOT/plugins/dev-flow/.claude/agents"
    [ -L "$link" ]
    run readlink "$link"
    [ "$status" -eq 0 ]
    [ "$output" = "../agents" ]
    run git -C "$REPO_ROOT" ls-files -s plugins/dev-flow/.claude/agents
    [ "$status" -eq 0 ]
    [[ "$output" == 120000\ * ]]
}

@test "dev-flow/.claude/agents 経由で agents/*.md が解決でき、同一集合である" {
    real_dir="$REPO_ROOT/plugins/dev-flow/agents"
    link_dir="$REPO_ROOT/plugins/dev-flow/.claude/agents"
    listed="$(cd "$real_dir" && /bin/ls -1 *.md | sort)"
    via_symlink="$(cd "$link_dir" && /bin/ls -1 *.md | sort)"
    [ -n "$listed" ]
    [ "$listed" = "$via_symlink" ]
}

@test "dev-flow の manifest の description が謳う agent 数は実際の agents/*.md 件数と一致する" {
    real_dir="$REPO_ROOT/plugins/dev-flow/agents"
    actual="$(cd "$real_dir" && /bin/ls -1 *.md | wc -l | tr -d ' ')"
    pj="$(plugin_json_path dev-flow)"
    for desc in "$(jq -r '.description' "$pj")" \
                "$(jq -r '.plugins[] | select(.name=="dev-flow") | .description' "$MARKETPLACE_JSON")"; do
        claimed="$(echo "$desc" | grep -oE '[0-9]+ dev-flow agents' | grep -oE '^[0-9]+' || true)"
        if [ -n "$claimed" ]; then
            [ "$claimed" = "$actual" ]
        fi
    done
}

@test "tracked な SKILL.md は全て plugins/ 配下にある（どの plugin にも属さない skill を作らない）" {
    # plugins/ 外に取り残された skill は plugin install 環境で解決できず、
    # それを呼ぶ workflow phase（例: PR phase の Skill: git-commit / git-pr）が壊れる。
    run git -C "$REPO_ROOT" ls-files -- '*SKILL.md' ':(exclude)plugins/'
    [ "$status" -eq 0 ]
    [ -z "$output" ]
}

@test "別 repo（サイト側）に移した seed 収穫 skill は playpark-skills に無く、repo 内に参照も残っていない" {
    # 名前はリテラルで書かない: このテスト自身が git grep に引っかからないようにする
    stem="seed"
    [ ! -e "$REPO_ROOT/plugins/playpark-skills/$stem-harvest" ]
    run git -C "$REPO_ROOT" grep -n -e "$stem-harvest" -e "${stem}_harvest"
    [ "$status" -eq 1 ]
    [ -z "$output" ]
}

@test "各 manifest の description が謳う skill 数は実際の SKILL.md 件数と一致する" {
    for name in "${PLUGIN_NAMES[@]}"; do
        # 作業ツリーの実体で数える: 未 commit の skill 追加（untracked）・削除（index にだけ残る）を commit 前に検証できるように
        actual="$(git -C "$REPO_ROOT" ls-files --cached --others --exclude-standard -- "plugins/$name/*SKILL.md" | sort -u | while IFS= read -r f; do [ -f "$REPO_ROOT/$f" ] && echo "$f"; done | wc -l | tr -d ' ')"
        pj="$(plugin_json_path "$name")"
        for desc in "$(jq -r '.description' "$pj")" \
                    "$(jq -r --arg n "$name" '.plugins[] | select(.name==$n) | .description' "$MARKETPLACE_JSON")"; do
            claimed="$(echo "$desc" | grep -oE '[0-9]+ skills' | grep -oE '^[0-9]+' || true)"
            if [ -n "$claimed" ]; then
                [ "$claimed" = "$actual" ]
            fi
        done
    done
}

@test "claude CLI が dev-flow plugin から agent を実際に読み込める（実挙動の pin）" {
    command -v claude >/dev/null 2>&1 || skip "claude CLI not available"
    real_dir="$REPO_ROOT/plugins/dev-flow/agents"
    actual="$(cd "$real_dir" && /bin/ls -1 *.md | wc -l | tr -d ' ')"
    run claude --plugin-dir "$REPO_ROOT/plugins/dev-flow" plugin details dev-flow
    [ "$status" -eq 0 ]
    [[ "$output" == *"Agents ($actual)"* ]]
}
