#!/usr/bin/env bats
bats_require_minimum_version 1.5.0
# Tests for git-issue/scripts/create_issue.py
#
# Focus: the pre-flight AC lint gate (lint_ac()) invoked at the top of run(),
# exercised only through the --dry-run path so `gh` is never required, plus the
# --kind agent|human gate (incl. the agent `## 変更対象パス` gate, tests 20+, and the
# 4000-char non-AC body cap pinned to analyze-issue.sh's scope_total_chars, tests 27+) and
# --blocked-by dependency wiring (tests 5+; the non-dry-run ones put a recording
# gh stub first on PATH).
#
# verdict handling contract:
#   t1            -> silent pass
#   t2            -> stderr Warning, continue
#   non_compliant -> Error on stderr (with remediation hint), exit 1
#   lint script missing / bad JSON / other non-zero exit -> RuntimeError -> exit 1

setup() {
    command -v python3 >/dev/null || skip "python3 not available"

    SKILLS_REPO="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
    SCRIPT="$SKILLS_REPO/git-issue/scripts/create_issue.py"

    write_body() {
        local out="$1"
        shift
        printf '%s\n' "$@" > "$out"
    }
}

@test "(1) T1準拠 body + --dry-run -> exit 0, Dry run プレビュー出力" {
    BODY="$BATS_TEST_TMPDIR/body.md"
    write_body "$BODY" \
        "# Title" \
        "" \
        "## 変更対象パス" \
        "- src/foo.py" \
        "" \
        "## 受け入れ基準" \
        "- [ ] AC-1 foo"

    run python3 "$SCRIPT" --title "Test" --body-file "$BODY" --dry-run

    [ "$status" -eq 0 ]
    [[ "$output" == *"Dry run: issue will not be created."* ]]
}

@test "(2) T2 body + --dry-run -> exit 0 かつ stderr に Warning" {
    BODY="$BATS_TEST_TMPDIR/body.md"
    write_body "$BODY" \
        "## 変更対象パス" \
        "- src/foo.py" \
        "## 受け入れ基準" \
        "- foo" \
        "- bar"

    run python3 "$SCRIPT" --title "Test" --body-file "$BODY" --dry-run

    [ "$status" -eq 0 ]
    [[ "$output" == *"Warning"* ]]
    [[ "$output" == *"T2"* ]]
}

@test "(3) 見出しなし non_compliant body + --dry-run -> exit 1 かつ是正手順を含む Error" {
    BODY="$BATS_TEST_TMPDIR/body.md"
    write_body "$BODY" \
        "## 変更対象パス" \
        "- src/foo.py" \
        "## Tasks" \
        "- [ ] not an AC section"

    run python3 "$SCRIPT" --title "Test" --body-file "$BODY" --dry-run

    [ "$status" -eq 1 ]
    [[ "$output" == *"Error"* ]]
    [[ "$output" == *"受け入れ基準"* ]]
}

@test "(4) 空 body file -> exit 1 (既存 ensure_body_file 挙動の regression 確認)" {
    BODY="$BATS_TEST_TMPDIR/empty.md"
    : > "$BODY"

    run python3 "$SCRIPT" --title "Test" --body-file "$BODY" --dry-run

    [ "$status" -eq 1 ]
    [[ "$output" == *"Error"* ]]
    [[ "$output" == *"body file is empty"* ]]
}

# ---- gh stub（非 dry-run 経路用）----
# 呼び出しを $GH_LOG に 1 行ずつ記録し、引数で応答を切り替える:
#   auth status / label create（GH_STUB_LABEL_EXIT）
#   issue create → --body-file の中身を $SENT_BODY に写し、URL .../issues/$GH_STUB_NEW_ISSUE を返す
#   api repos/.../issues/N → {"id": N+9000}（GH_STUB_MISSING に含む番号は 404）
#   api --method POST .../dependencies/blocked_by → 成功（GH_STUB_DEP_FAIL で失敗）
#   issue view → $GH_STUB_ISSUE_JSON の中身（analyze-issue.sh に読ませる issue JSON）
use_gh_stub() {
    local bin="$BATS_TEST_TMPDIR/bin"
    mkdir -p "$bin"
    cat >"$bin/gh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$GH_LOG"
case "$1 $2" in
    "auth status") exit 0 ;;
    "label create") exit "${GH_STUB_LABEL_EXIT:-0}" ;;
    "issue create")
        prev=""
        for a in "$@"; do
            [[ "$prev" == "--body-file" ]] && cp "$a" "$SENT_BODY"
            prev="$a"
        done
        echo "https://github.com/acme/app/issues/${GH_STUB_NEW_ISSUE:-50}"
        exit 0 ;;
    "issue view") cat "$GH_STUB_ISSUE_JSON"; exit 0 ;;
esac
if [[ "$1" == "api" && "$2" == "--method" ]]; then
    if [[ -n "${GH_STUB_DEP_FAIL:-}" ]]; then
        echo "$GH_STUB_DEP_FAIL" >&2
        exit 1
    fi
    echo '{}'
    exit 0
fi
if [[ "$1" == "api" ]]; then
    n="${2##*/}"
    if [[ " ${GH_STUB_MISSING:-} " == *" $n "* ]]; then
        echo "HTTP 404: Not Found" >&2
        exit 1
    fi
    printf '{"id": %d, "number": %d}\n' "$((n + 9000))" "$n"
    exit 0
fi
echo "unexpected gh call: $*" >&2
exit 1
STUB
    chmod +x "$bin/gh"
    export PATH="$bin:$PATH"
    export GH_LOG="$BATS_TEST_TMPDIR/gh.log"
    export SENT_BODY="$BATS_TEST_TMPDIR/sent-body.md"
    : >"$GH_LOG"
}

write_agent_body() {
    write_body "$1" \
        "## 背景" \
        "- 目的: foo" \
        "" \
        "## 変更対象パス" \
        "- src/foo.py" \
        "" \
        "## 受け入れ基準" \
        "- [ ] AC-1 foo"
}

write_human_body() {
    write_body "$1" \
        "## 背景" \
        "- 外部管理画面で API キーを発行する" \
        "" \
        "## 手順" \
        "1. 管理画面で API キーを発行する" \
        "2. repository secret に登録する" \
        "" \
        "## 完了条件" \
        "- [ ] API_KEY が repository secret に登録されている" \
        "" \
        "## 後続 issue" \
        "- 実装 issue（この issue に Blocked by で紐付く）"
}

# ---- --kind agent（既定）: executor: human マーカーの拒否 ----

@test "(5) --kind 省略（agent）+ 本文に executor: human + --dry-run -> exit 1 で拒否" {
    BODY="$BATS_TEST_TMPDIR/body.md"
    write_body "$BODY" \
        "## 実装計画" \
        "### フェーズ1" \
        "- executor: human" \
        "- タスク: API キーを発行する" \
        "" \
        "## 変更対象パス" \
        "- src/foo.py" \
        "" \
        "## 受け入れ基準" \
        "- [ ] AC-1 foo"

    run python3 "$SCRIPT" --title "Test" --body-file "$BODY" --dry-run

    [ "$status" -eq 1 ]
    [[ "$output" == *"executor: human"* ]]
    [[ "$output" != *"Dry run: issue will not be created."* ]]
}

@test "(6) --kind agent + 本文に executor: human（非 dry-run）-> exit 1、gh issue create を呼ばない" {
    use_gh_stub
    BODY="$BATS_TEST_TMPDIR/body.md"
    write_body "$BODY" \
        "- 担当: backend / executor:  human" \
        "## 変更対象パス" \
        "- src/foo.py" \
        "## 受け入れ基準" \
        "- [ ] AC-1 foo"

    run python3 "$SCRIPT" --kind agent --title "Test" --body-file "$BODY"

    [ "$status" -eq 1 ]
    [[ "$output" == *"executor: human"* ]]
    ! grep -q '^issue create' "$GH_LOG"
}

@test "(7) --kind agent + executor: agent のみ -> 起票する" {
    use_gh_stub
    BODY="$BATS_TEST_TMPDIR/body.md"
    write_body "$BODY" \
        "- executor: agent" \
        "## 変更対象パス" \
        "- src/foo.py" \
        "## 受け入れ基準" \
        "- [ ] AC-1 foo"

    run python3 "$SCRIPT" --title "Test" --body-file "$BODY"

    [ "$status" -eq 0 ]
    [[ "$output" == *"https://github.com/acme/app/issues/50"* ]]
    grep -q '^issue create' "$GH_LOG"
    ! grep -q 'human-task' "$GH_LOG"
}

# ---- --kind human: 手順 / 完了条件 の必須と human-task ラベル ----

@test "(8) --kind human + ## 手順 なし -> exit 1" {
    BODY="$BATS_TEST_TMPDIR/body.md"
    write_body "$BODY" \
        "## 背景" \
        "- foo" \
        "## 完了条件" \
        "- [ ] done"

    run python3 "$SCRIPT" --kind human --title "Test" --body-file "$BODY" --dry-run

    [ "$status" -eq 1 ]
    [[ "$output" == *"## 手順"* ]]
}

@test "(9) --kind human + ## 完了条件 なし（受け入れ基準のみ）-> exit 1" {
    BODY="$BATS_TEST_TMPDIR/body.md"
    write_body "$BODY" \
        "## 手順" \
        "1. foo" \
        "## 受け入れ基準" \
        "- [ ] done"

    run python3 "$SCRIPT" --kind human --title "Test" --body-file "$BODY" --dry-run

    [ "$status" -eq 1 ]
    [[ "$output" == *"## 完了条件"* ]]
}

@test "(10) --kind human + ## 完了条件 が checkbox でない（ac-lint t2）-> exit 1" {
    BODY="$BATS_TEST_TMPDIR/body.md"
    write_body "$BODY" \
        "## 手順" \
        "1. foo" \
        "## 完了条件" \
        "- done"

    run python3 "$SCRIPT" --kind human --title "Test" --body-file "$BODY" --dry-run

    [ "$status" -eq 1 ]
    [[ "$output" == *"checkbox"* ]]
}

@test "(11) --kind human + 手順・完了条件あり + --dry-run -> human-task ラベル付きの起票コマンドを組み立てる" {
    BODY="$BATS_TEST_TMPDIR/body.md"
    write_human_body "$BODY"

    run python3 "$SCRIPT" --kind human --title "API キー発行" --body-file "$BODY" --labels ops --dry-run

    [ "$status" -eq 0 ]
    [[ "$output" == *"Command: gh issue create"*"--label ops --label human-task"* ]]
    [[ "$output" == *"Label command: gh label create human-task"*"--force"* ]]
}

@test "(12) --kind human（非 dry-run）-> human-task ラベルを作成してから human-task 付きで起票" {
    use_gh_stub
    BODY="$BATS_TEST_TMPDIR/body.md"
    write_human_body "$BODY"

    run python3 "$SCRIPT" --kind human --title "API キー発行" --body-file "$BODY" --repo acme/app

    [ "$status" -eq 0 ]
    [[ "$output" == *"https://github.com/acme/app/issues/50"* ]]
    label_line="$(grep -n '^label create human-task' "$GH_LOG" | cut -d: -f1)"
    create_line="$(grep -n '^issue create' "$GH_LOG" | cut -d: -f1)"
    [ -n "$label_line" ] && [ -n "$create_line" ]
    [ "$label_line" -lt "$create_line" ]
    grep '^label create human-task' "$GH_LOG" | grep -q -- '--force'
    grep '^label create human-task' "$GH_LOG" | grep -q -- '--repo acme/app'
    grep '^issue create' "$GH_LOG" | grep -q -- '--label human-task'
}

@test "(13) --kind human でラベル作成に失敗 -> exit 1、起票しない" {
    use_gh_stub
    BODY="$BATS_TEST_TMPDIR/body.md"
    write_human_body "$BODY"

    GH_STUB_LABEL_EXIT=1 run python3 "$SCRIPT" --kind human --title "Test" --body-file "$BODY"

    [ "$status" -eq 1 ]
    ! grep -q '^issue create' "$GH_LOG"
}

# ---- --blocked-by ----

@test "(14) --blocked-by 12,13 + --dry-run -> 本文先頭に Blocked by 行を追記し、依存登録コマンドを表示する" {
    BODY="$BATS_TEST_TMPDIR/body.md"
    write_agent_body "$BODY"

    run python3 "$SCRIPT" --title "Test" --body-file "$BODY" --blocked-by 12,13 --dry-run

    [ "$status" -eq 0 ]
    [[ "$output" == *"Blocked by #12: gh api --method POST 'repos/{owner}/{repo}/issues/<new>/dependencies/blocked_by'"* ]]
    [[ "$output" == *"Body preview (first 20 lines):"$'\n'"Blocked by #12"$'\n'"Blocked by #13"$'\n'* ]]
    # 元の body file は書き換えない
    ! grep -q 'Blocked by' "$BODY"
}

@test "(15) 本文に Blocked by #12 が既にある -> 重複して追記しない" {
    BODY="$BATS_TEST_TMPDIR/body.md"
    write_body "$BODY" \
        "## 背景" \
        "- Blocked by #12" \
        "## 変更対象パス" \
        "- src/foo.py" \
        "## 受け入れ基準" \
        "- [ ] AC-1 foo"

    run python3 "$SCRIPT" --title "Test" --body-file "$BODY" --blocked-by 12 --dry-run

    [ "$status" -eq 0 ]
    [ "$(printf '%s\n' "$output" | grep -c 'Blocked by #12$')" -eq 1 ]
    [[ "$output" != *"Blocked by 行を先頭に追記"* ]]
}

@test "(16) --blocked-by 12（非 dry-run）-> 存在確認 → 起票 → dependencies API で依存登録、本文に Blocked by #12" {
    use_gh_stub
    BODY="$BATS_TEST_TMPDIR/body.md"
    write_agent_body "$BODY"

    GH_STUB_NEW_ISSUE=77 run python3 "$SCRIPT" --title "Test" --body-file "$BODY" --blocked-by 12

    [ "$status" -eq 0 ]
    [[ "$output" == *"https://github.com/acme/app/issues/77"* ]]
    lookup_line="$(grep -n '^api repos/{owner}/{repo}/issues/12$' "$GH_LOG" | cut -d: -f1)"
    create_line="$(grep -n '^issue create' "$GH_LOG" | cut -d: -f1)"
    dep_line="$(grep -n '^api --method POST repos/{owner}/{repo}/issues/77/dependencies/blocked_by -F issue_id=9012$' "$GH_LOG" | cut -d: -f1)"
    [ -n "$lookup_line" ] && [ -n "$create_line" ] && [ -n "$dep_line" ]
    [ "$lookup_line" -lt "$create_line" ]
    [ "$create_line" -lt "$dep_line" ]
    head -1 "$SENT_BODY" | grep -qx 'Blocked by #12'
}

@test "(17) --blocked-by の issue が存在しない -> exit 1、起票しない" {
    use_gh_stub
    BODY="$BATS_TEST_TMPDIR/body.md"
    write_agent_body "$BODY"

    GH_STUB_MISSING=12 run python3 "$SCRIPT" --title "Test" --body-file "$BODY" --blocked-by 12

    [ "$status" -eq 1 ]
    [[ "$output" == *"#12"* ]]
    ! grep -q '^issue create' "$GH_LOG"
}

@test "(18) 依存登録に失敗 -> 非 0 終了し、issue URL と手動登録コマンドを出力する" {
    use_gh_stub
    BODY="$BATS_TEST_TMPDIR/body.md"
    write_agent_body "$BODY"

    GH_STUB_NEW_ISSUE=77 GH_STUB_DEP_FAIL="HTTP 404: dependencies not available" \
        run python3 "$SCRIPT" --title "Test" --body-file "$BODY" --blocked-by 12 --repo acme/app

    [ "$status" -ne 0 ]
    [[ "$output" == *"https://github.com/acme/app/issues/77"* ]]
    [[ "$output" == *"dependencies not available"* ]]
    [[ "$output" == *"手動登録: gh api --method POST repos/acme/app/issues/77/dependencies/blocked_by -F issue_id=9012"* ]]
}

@test "(19) --blocked-by に数値以外 -> exit 1" {
    BODY="$BATS_TEST_TMPDIR/body.md"
    write_agent_body "$BODY"

    run python3 "$SCRIPT" --title "Test" --body-file "$BODY" --blocked-by 12,abc --dry-run

    [ "$status" -eq 1 ]
    [[ "$output" == *"--blocked-by"* ]]
}

# ---- --kind agent: ## 変更対象パス の必須（--kind human は要求しない）----

# write_paths_body <file> <変更対象パス節の行...>: 変更対象パス節だけを差し替えた agent 本文
write_paths_body() {
    local out="$1"
    shift
    write_body "$out" \
        "## 背景" \
        "- 目的: foo" \
        "" \
        "$@" \
        "" \
        "## 受け入れ基準" \
        "- [ ] AC-1 foo"
}

@test "(20) --kind agent + ## 変更対象パス なし + --dry-run -> exit 1、理由を stderr に出す" {
    BODY="$BATS_TEST_TMPDIR/body.md"
    write_body "$BODY" \
        "## 背景" \
        "- 目的: foo" \
        "" \
        "## 受け入れ基準" \
        "- [ ] AC-1 foo"

    run --separate-stderr python3 "$SCRIPT" --kind agent --title "Test" --body-file "$BODY" --dry-run

    [ "$status" -eq 1 ]
    [[ "$stderr" == *"## 変更対象パス"*"見出しが無い"* ]]
    [[ "$output" != *"Dry run: issue will not be created."* ]]
}

@test "(21) --kind agent + ## 変更対象パス のエントリ 0 件 + --dry-run -> exit 1、理由を stderr に出す" {
    BODY="$BATS_TEST_TMPDIR/body.md"
    write_paths_body "$BODY" \
        "## 変更対象パス" \
        "（未定）"

    run --separate-stderr python3 "$SCRIPT" --kind agent --title "Test" --body-file "$BODY" --dry-run

    [ "$status" -eq 1 ]
    [[ "$stderr" == *"エントリが無い"* ]]
    [[ "$output" != *"Dry run: issue will not be created."* ]]
}

@test "(22) --kind agent + エントリが / 始まり + --dry-run -> exit 1、理由を stderr に出す" {
    BODY="$BATS_TEST_TMPDIR/body.md"
    write_paths_body "$BODY" \
        "## 変更対象パス" \
        "- src/ok.py" \
        "- /etc/passwd"

    run --separate-stderr python3 "$SCRIPT" --kind agent --title "Test" --body-file "$BODY" --dry-run

    [ "$status" -eq 1 ]
    [[ "$stderr" == *'`/` 始まり'*"/etc/passwd"* ]]
    [[ "$output" != *"Dry run: issue will not be created."* ]]
}

@test "(23) --kind agent + エントリが .. セグメントを含む + --dry-run -> exit 1、理由を stderr に出す" {
    BODY="$BATS_TEST_TMPDIR/body.md"
    write_paths_body "$BODY" \
        "## 変更対象パス" \
        "- src/../../other-repo/x.py"

    run --separate-stderr python3 "$SCRIPT" --kind agent --title "Test" --body-file "$BODY" --dry-run

    [ "$status" -eq 1 ]
    [[ "$stderr" == *'`..` セグメント'*"src/../../other-repo/x.py"* ]]
    [[ "$output" != *"Dry run: issue will not be created."* ]]
}

@test "(24) --kind agent + 変更対象パス欄なし（非 dry-run）-> exit 1、gh issue create を呼ばない" {
    use_gh_stub
    BODY="$BATS_TEST_TMPDIR/body.md"
    write_body "$BODY" \
        "## 背景" \
        "- 目的: foo" \
        "## 受け入れ基準" \
        "- [ ] AC-1 foo"

    run --separate-stderr python3 "$SCRIPT" --title "Test" --body-file "$BODY"

    [ "$status" -eq 1 ]
    [[ "$stderr" == *"## 変更対象パス"* ]]
    ! grep -q '^issue create' "$GH_LOG"
}

@test "(25) --kind agent + 相対パスと glob のエントリ（.. を名前に含むだけのものも可）+ --dry-run -> exit 0" {
    BODY="$BATS_TEST_TMPDIR/body.md"
    write_paths_body "$BODY" \
        "## 変更対象パス" \
        "- plugins/dev-flow/git-issue/scripts/create_issue.py" \
        "- plugins/dev-flow/git-issue/references/*" \
        "- docs/a..b.md" \
        "" \
        "## テスト戦略" \
        "- /absolute/path/in/another/section"

    run --separate-stderr python3 "$SCRIPT" --kind agent --title "Test" --body-file "$BODY" --dry-run

    [ "$status" -eq 0 ]
    [[ "$output" == *"Dry run: issue will not be created."* ]]
}

@test "(26) --kind human は ## 変更対象パス を要求しない" {
    BODY="$BATS_TEST_TMPDIR/body.md"
    write_human_body "$BODY"
    ! grep -q '変更対象パス' "$BODY"

    run python3 "$SCRIPT" --kind human --title "API キー発行" --body-file "$BODY" --dry-run

    [ "$status" -eq 0 ]
    [[ "$output" == *"Dry run: issue will not be created."* ]]
}

# ---- --kind agent: AC 節を除いた本文の 4000 字上限（analyze-issue.sh の scope_total_chars と同じ数え方）----

# repeat_char <char> <n>: <char> を n 個並べる
repeat_char() {
    local pad
    pad="$(printf '%*s' "$2" '')"
    printf '%s' "${pad// /$1}"
}

# write_scope_body <file> <pad 字数>: AC 節を除いた字数が 31 + <pad 字数> になる agent 本文
#   "## 変更対象パス\n- src/foo.py\n\n## ゴール\n" = 31 字。AC 節（見出しと項目）と末尾改行は数えない
write_scope_body() {
    write_body "$1" \
        "## 受け入れ基準" \
        "- [ ] AC-1 foo" \
        "" \
        "## 変更対象パス" \
        "- src/foo.py" \
        "" \
        "## ゴール" \
        "$(repeat_char あ "$2")"
}

@test "(27) --kind agent + AC 節を除いて 4000 字ちょうど（マルチバイト）+ --dry-run -> exit 0" {
    BODY="$BATS_TEST_TMPDIR/body.md"
    write_scope_body "$BODY" 3969

    run --separate-stderr python3 "$SCRIPT" --title "Test" --body-file "$BODY" --dry-run

    [ "$status" -eq 0 ]
    [[ "$output" == *"Dry run: issue will not be created."* ]]
}

@test "(28) --kind agent + AC 節を除いて 4001 字 + --dry-run -> exit 1、超過字数と書き直しの指示を stderr に出す" {
    BODY="$BATS_TEST_TMPDIR/body.md"
    write_scope_body "$BODY" 3970

    run --separate-stderr python3 "$SCRIPT" --title "Test" --body-file "$BODY" --dry-run

    [ "$status" -eq 1 ]
    [[ "$stderr" == *"（AC 節を除く）が 4001 字"*"上限 4000 字を 1 字超えている"* ]]
    [[ "$stderr" == *"要点を絞って書き直す"* ]]
    [[ "$output" != *"Dry run: issue will not be created."* ]]
}

@test "(29) --blocked-by が先頭に足す行も字数に入る（4000 字ちょうど + Blocked by #12 -> exit 1）" {
    BODY="$BATS_TEST_TMPDIR/body.md"
    write_scope_body "$BODY" 3969

    run --separate-stderr python3 "$SCRIPT" --title "Test" --body-file "$BODY" --blocked-by 12 --dry-run

    [ "$status" -eq 1 ]
    # "Blocked by #12\n\n" の 16 字が加わる
    [[ "$stderr" == *"（AC 節を除く）が 4016 字"* ]]
}

@test "(30) 4000 字超の本文（非 dry-run）-> exit 1、gh issue create を呼ばない" {
    use_gh_stub
    BODY="$BATS_TEST_TMPDIR/body.md"
    write_scope_body "$BODY" 3970

    run --separate-stderr python3 "$SCRIPT" --title "Test" --body-file "$BODY"

    [ "$status" -eq 1 ]
    [[ "$stderr" == *"4001 字"* ]]
    ! grep -q '^issue create' "$GH_LOG"
}

@test "(31) 字数は同じ本文で analyze-issue.sh の scope_total_chars と一致する（フェンス・AC 節の境界・マルチバイト）" {
    command -v jq >/dev/null || skip "jq not available"
    use_gh_stub
    ANALYZE="$SKILLS_REPO/dev-flow/scripts/analyze-issue.sh"
    BODY="$BATS_TEST_TMPDIR/body.md"
    write_body "$BODY" \
        "## ゴール" \
        "  日本語のゴールと末尾の空白  " \
        '```bash' \
        "# フェンス内のコメントは見出しではない" \
        '```' \
        "## 受け入れ基準（Acceptance Criteria）" \
        "- [ ] AC-1 foo" \
        "~~~" \
        "## フェンス内の見出しは AC 節を閉じない" \
        "~~~" \
        "- [ ] AC-2 bar" \
        "### 受け入れ基準の補足" \
        "補足は AC 節に入らない（最初の AC 見出しだけを除く）" \
        "## 変更対象パス" \
        "- src/foo.py" \
        "####### 7 個の # は見出しではない" \
        "$(repeat_char い 4100)" \
        "" \
        ""
    jq -n --rawfile body "$BODY" \
        '{title: "feat: x", state: "open", body: $body, labels: [], assignees: [], milestone: null, comments: [], author: {login: "a"}}' \
        >"$BATS_TEST_TMPDIR/issue.json"
    export GH_STUB_ISSUE_JSON="$BATS_TEST_TMPDIR/issue.json"

    expected="$("$ANALYZE" 1 --contract | jq -r '.scope_total_chars')"
    [ "$expected" -gt 4000 ]

    run --separate-stderr python3 "$SCRIPT" --title "Test" --body-file "$BODY" --dry-run

    [ "$status" -eq 1 ]
    [[ "$stderr" == *"（AC 節を除く）が ${expected} 字"* ]]
}
