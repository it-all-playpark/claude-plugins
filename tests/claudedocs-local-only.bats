#!/usr/bin/env bats
# Invariant (#895): repo root の claudedocs/ は作業者ローカルの設計メモ・計測・RCA 置き場で、public repo に
# 載せない（セッションダンプ・ホームパス・コスト額が混ざる）。現行の不変条件は AGENTS.md /
# .claude/rules/ / 各 references/ が持つので、tracked ファイルから claudedocs/ の memo を出典として指さない
# （clone した第三者には存在しないパスになる）。
# plugins/playpark-skills/ の skill（sandbox-tune 等）が書く claudedocs/ は
# 利用者 project 側の出力先なので対象外。

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
}

# claudedocs/ 配下に tracked ファイルが無いことは tests/public-repo-hygiene.bats が全追跡ファイルで検査する。
@test "repo root の claudedocs/ は gitignore される" {
    run git -C "$REPO_ROOT" check-ignore -q claudedocs/any-memo.md
    [ "$status" -eq 0 ]
}

# public-repo-hygiene.bats は claudedocs/ の追跡ファイルを検出する側なので、パターンとして持つ。
@test "tracked ファイルが repo root の claudedocs/ を参照していない（利用者 project 側の skill 出力先は除く）" {
    run git -C "$REPO_ROOT" grep -nIF -e 'claudedocs/' -- \
        ':(exclude)plugins/playpark-skills/' \
        ':(exclude).gitignore' \
        ':(exclude)tests/claudedocs-local-only.bats' \
        ':(exclude)tests/public-repo-hygiene.bats'
    echo "$output"
    [ "$status" -ne 0 ]
}
