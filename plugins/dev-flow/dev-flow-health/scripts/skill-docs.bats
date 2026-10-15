#!/usr/bin/env bats
# Static pins for dev-flow-health SKILL.md の起票手順（issue #993）
#
# - 起票は github-issue-orchestrator の create_issue.py（--kind agent --labels self-improve）を通し、
#   素の gh issue create を手順に書かない（dev-flow の PreToolUse hook が拒否する）
# - 本文の雛形は `## 変更対象パス`・`- [ ]` の受け入れ条件・重複確認用の `<!-- dev-flow-health:<id> -->` を持ち、
#   create_issue.py --kind agent のゲートをそのまま通る

setup() {
    command -v python3 >/dev/null || skip "python3 not available"

    SKILL_DIR="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
    SKILL_MD="$SKILL_DIR/SKILL.md"
    CREATE_ISSUE="$SKILL_DIR/../github-issue-orchestrator/scripts/create_issue.py"
}

# 「起票」手順（`**起票**` の行から次の番号付き手順の行まで）を抜き出す
extract_filing_step() {
    awk '/\*\*起票\*\*/ { f = 1 }
         f && /^[0-9]+\. / { exit }
         f { print }' "$SKILL_MD"
}

# 起票手順の中の ```markdown フェンス（本文の雛形）を抜き出し、行頭のインデントを外す
extract_body_template() {
    extract_filing_step | awk '/^[[:space:]]*```markdown$/ { f = 1; next }
         f && /^[[:space:]]*```$/ { exit }
         f { sub(/^      /, ""); print }'
}

@test "起票は create_issue.py --kind agent --labels self-improve で行い、素の gh issue create を実行しない" {
    step="$(extract_filing_step)"
    [ -n "$step" ]
    [[ "$step" == *'github-issue-orchestrator/scripts/create_issue.py --kind agent --labels self-improve'* ]]
    [[ "$step" == *'--repo <issue_repo>'* ]]
    [[ "$step" == *'--body-file <file>'* ]]
    run grep -nE '^[[:space:]]*`?gh issue create |gh issue create --' "$SKILL_MD"
    [ "$status" -ne 0 ]
}

@test "本文の雛形は 変更対象パス・- [ ] の受け入れ条件・dev-flow-health:<id> マーカーを持つ" {
    body="$(extract_body_template)"
    [ -n "$body" ]
    [[ "$body" == *$'## 変更対象パス\n- <原因の推定で直す対象としたファイルの repo 相対パス>'* ]]
    [[ "$body" == *$'## 受け入れ条件\n- [ ] '* ]]
    [[ "$body" == *'<!-- dev-flow-health:<id> -->' ]]
}

@test "本文の雛形は create_issue.py --kind agent --labels self-improve を通る" {
    BODY="$BATS_TEST_TMPDIR/body.md"
    extract_body_template >"$BODY"

    run python3 "$CREATE_ISSUE" --kind agent --labels self-improve --title "fix(dev-flow): x" --body-file "$BODY" --dry-run
    echo "$output"
    [ "$status" -eq 0 ]
    [[ "$output" == *"--label self-improve"* ]]
}
