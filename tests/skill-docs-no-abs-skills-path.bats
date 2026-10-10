#!/usr/bin/env bats
# Invariant (#570, #571): 全 skill の SKILL.md / references に ~/.claude/skills/
# 絶対パス記述を残さない（plugin install 形態に依存しない表現にするため）。
# #571 で skills symlink 自体を撤去したため dev-flow の除外は外した — plugin 配下は
# ${CLAUDE_PLUGIN_ROOT} 相対か bin/ の bare 名で表現する。
# git grep で tracked ファイルのみを検査し、repo root の gitignored な外部 skill
# symlink（gsc 等）を構造的に対象外にする。

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
}

# repo の clone（~/ghq/.../claude-plugins/）の絶対パスも書かない。clone は sandbox から書けるので
# excludedCommands に入らず、そこを指す実行例は sandbox 内に落ちる（除外されるのは plugin cache だけ）。
# 作者の clone のパスと作者環境の checkout 名（skills-dev）も同じ理由で書かない — 第三者の環境には無いので、
# 前提は「checkout が sandbox から書けない場合」のような条件として書く。
@test "全skillのSKILL.md/referencesに~/.claude/skills/とskills cloneのパス・作者環境名の記述が残っていない" {
    run git -C "$REPO_ROOT" grep -nIF \
        -e '~/.claude/skills/' \
        -e '$HOME/.claude/skills/' \
        -e 'ghq/github.com/it-all-playpark/claude-plugins' \
        -e 'skills-dev' \
        -- '*SKILL.md' '*skill.md' '*references/*.md' \
        ':(exclude).claude/'
    echo "$output"
    [ "$status" -ne 0 ]
}

# $SKILLS_DIR は _lib/common.sh を source した script の中でだけ定義される（core plugin root）。
# SKILL.md / references の実行例は agent の素の Bash shell で走るため未定義に展開され、
# symlink 撤去後は解決先も無い。journal は core bin/ の bare 名、skill 内スクリプトは
# 各 plugin bin/ の bare 名（`<skill>-<action>`）、SKILL.md 内のドキュメント参照のみ
# ${CLAUDE_PLUGIN_ROOT} 相対で書く。
@test "全pluginのSKILL.md/referencesに\$SKILLS_DIR 実行例が残っていない" {
    run git -C "$REPO_ROOT" grep -nIF \
        -e '$SKILLS_DIR/' \
        -e '${SKILLS_DIR}/' \
        -- '*SKILL.md' '*skill.md' '*references/*.md' \
           'plugins/playpark-skills/skill-creator/assets/skill-template.md' \
           ':(exclude).claude/'
    echo "$output"
    [ "$status" -ne 0 ]
}

# references/*.md は Read tool で素読みされるため ${CLAUDE_PLUGIN_ROOT} が展開されない
# （skills#567 実測）。references からの script 呼び出しは bin/ の bare 名で書く。
# SKILL.md / agents/*.md は content として展開されるので対象外。
@test "全pluginのreferencesに\${CLAUDE_PLUGIN_ROOT} 参照が残っていない" {
    run git -C "$REPO_ROOT" grep -nIF \
        -e '${CLAUDE_PLUGIN_ROOT}' \
        -e '$CLAUDE_PLUGIN_ROOT' \
        -- '*references/*.md' \
           ':(exclude).claude/'
    echo "$output"
    [ "$status" -ne 0 ]
}

# skill は利用者の project を CWD として実行されるので、`scripts/...` / `./scripts/...` の相対呼び出しは
# 見つからない（#903）。SKILL.md は ${CLAUDE_PLUGIN_ROOT}/<skill>/scripts/、references は bin/ の bare 名で書く。
# 検出するのは呼び出しの形（interpreter 前置・行頭のコマンド・./scripts/・Run:・「を実行」）だけで、
# Resources 一覧や見出しの `scripts/foo.sh` のような skill dir 内の所在説明は対象外。
@test "全pluginのSKILL.md/referencesにCWD相対の scripts/ 呼び出しが残っていない" {
    run git -C "$REPO_ROOT" grep -nIE \
        -e '(^|[^[:alnum:]_/-])(bash|sh|zsh|python3?|node|uv run|ruby|perl) +(\./)?scripts/' \
        -e '^[[:space:]]*(\$ +)?(\./)?scripts/[^[:space:]]' \
        -e '(^|[^[:alnum:]_.-])\./scripts/' \
        -e '[Rr]un:? +`?(\./)?scripts/' \
        -e '(^|[^[:alnum:]_./}-])scripts/[^[:space:]`]+`? *を実行' \
        -- '*SKILL.md' '*skill.md' '*references/*.md' \
           'plugins/playpark-skills/skill-creator/assets/skill-template.md' \
           ':(exclude).claude/'
    echo "$output"
    [ "$status" -ne 0 ]
}

@test "skill script(*.sh/*.py)に~/.claude/skills絶対パス参照が残っていない" {
    run git -C "$REPO_ROOT" grep -nIF \
        -e '~/.claude/skills/' \
        -e '$HOME/.claude/skills/' \
        -e '${HOME}/.claude/skills/' \
        -e 'Path.home() / ".claude/skills' \
        -- '*.sh' '*.py' ':(exclude)tests/'
    echo "$output"
    [ "$status" -ne 0 ]
}

@test "skill script(*.sh/*.py)にskills cloneのパス・作者環境名(skills-dev)の記述が残っていない" {
    run git -C "$REPO_ROOT" grep -nIF \
        -e 'ghq/github.com/it-all-playpark/claude-plugins' \
        -e 'skills-dev' \
        -- '*.sh' '*.py' ':(exclude)tests/'
    echo "$output"
    [ "$status" -ne 0 ]
}
