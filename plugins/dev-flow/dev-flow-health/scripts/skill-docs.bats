#!/usr/bin/env bats
# Static pins for dev-flow-health SKILL.md の起票手順（issue #993 / #1009 / #1018）
#
# - 各 signature を dev_flow / target_repo / environment / transient に振り分け、dev_flow だけを
#   重複確認 → git-issue で起票し、全 signature の振り分けをマーカー付きブロックで出力する（記録は daily.sh）
# - 起票は signature ごとの finding を Skill ツールで dev-flow:git-issue（--repo <issue_repo> --labels self-improve）に
#   1 回でまとめて渡し、git-issue の軽い経路と Phase 7（dev-flow-ready-set）を通す
# - create_issue.py の直接実行と素の gh issue create を手順に書かない（起票手順を git-issue の 1 箇所にまとめる。
#   素の gh issue create は dev-flow の PreToolUse hook が拒否する）
# - 重複確認用の `<!-- dev-flow-health:<id> -->` を本文末尾に残させ、報告に git-issue の ## Launch Order を含める

setup() {
    SKILL_DIR="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
    SKILL_MD="$SKILL_DIR/SKILL.md"
}

# 「起票」手順（`**起票**` の行から次の番号付き手順の行まで）を抜き出す
extract_filing_step() {
    awk '/\*\*起票\*\*/ { f = 1 }
         f && /^[0-9]+\. / { exit }
         f { print }' "$SKILL_MD"
}

# 「finding をまとめる」手順（`**finding をまとめる**` の行から `**起票**` の行の手前まで）を抜き出す
extract_finding_step() {
    awk '/\*\*finding をまとめる\*\*/ { f = 1 }
         f && /\*\*起票\*\*/ { exit }
         f { print }' "$SKILL_MD"
}

# 手順 3（報告）を抜き出す
extract_report_step() {
    awk '/^3\. / { f = 1 }
         f && (/^## / || /^$/) { exit }
         f { print }' "$SKILL_MD"
}

@test "起動条件: SKILL.md の「日次の流れ」と rules の dev-flow-health 節は日次ジョブと journal の即時トリガの両方を書く" {
    flow="$(awk '/^## 日次の流れ/ { f = 1; next } f && /^## / { exit } f { print }' "$SKILL_MD")"
    [[ "$flow" == *'launchd 07:00（日次ジョブ）／ journal に entry が書かれた時（即時トリガ）→ scripts/daily.sh'* ]]
    [[ "$flow" == *'`WatchPaths`'* ]]
    [[ "$flow" == *'install-schedule.sh --install --repo <skills checkout> --watch-journal'* ]]
    [[ "$flow" == *'YYYY-MM-DDTHHMMSSZ.json（実行ごとに別ファイル）'* ]]

    rules="$SKILL_DIR/../../../.claude/rules/dev-flow.md"
    section="$(awk '/^## dev-flow-health/ { f = 1; next } f && /^## / { exit } f { print }' "$rules")"
    [[ "$section" == *'起動は日次 07:00 と journal の WatchPaths 即時トリガ'* ]]
    [[ "$section" == *'lock で直列'* ]]
}

@test "起票は Skill ツールで dev-flow:git-issue を --repo <issue_repo> --labels self-improve で 1 回だけ起動する" {
    step="$(extract_filing_step)"
    [ -n "$step" ]
    [[ "$step" == *'Skill ツールで `dev-flow:git-issue` を 1 回だけ起動し'* ]]
    [[ "$step" == *'dev-flow:git-issue <finding の file> --repo <issue_repo> --labels self-improve'* ]]
    [[ "$step" == *'軽い経路'* ]]
    [[ "$step" == *'`dev-flow-ready-set` が起票した全 issue に 1 回だけ走る'* ]]
}

@test "SKILL.md は create_issue.py を直接実行せず、素の gh issue create も実行しない" {
    run grep -nE 'python3? [^ ]*create_issue\.py|create_issue\.py --' "$SKILL_MD"
    [ "$status" -ne 0 ]
    run grep -nE '^[[:space:]]*`?gh issue create |gh issue create --' "$SKILL_MD"
    [ "$status" -ne 0 ]
}

@test "finding は症状・原因・直し方・変更対象パスを持ち、本文末尾に dev-flow-health:<id> マーカーを残させる" {
    step="$(extract_finding_step)"
    [ -n "$step" ]
    [[ "$step" == *'- 症状: signature・status・first_seen / last_seen（commit 付き）・発生回数・該当 run'* ]]
    [[ "$step" == *'- 原因: '* ]]
    [[ "$step" == *'- 直し方: 修正案'* ]]
    [[ "$step" == *'- 変更対象パス: '* ]]
    [[ "$step" == *'本文末尾に残すマーカー: `<!-- dev-flow-health:<id> -->`'* ]]
}

@test "重複確認は起票前に dev-flow-health 側で dev-flow-health:<id> を検索する" {
    dup_line="$(grep -n '\*\*重複確認\*\*' "$SKILL_MD" | cut -d: -f1)"
    filing_line="$(grep -n '\*\*起票\*\*' "$SKILL_MD" | cut -d: -f1)"
    [ -n "$dup_line" ]
    [ -n "$filing_line" ]
    [ "$dup_line" -lt "$filing_line" ]
    run grep -F 'gh issue list --repo <issue_repo> --label self-improve --state open --search "dev-flow-health:<id>"' "$SKILL_MD"
    [ "$status" -eq 0 ]
}

@test "振り分けは 4 分類の判定基準を 1 行ずつ持ち、重複確認より前に行う" {
    step="$(awk '/\*\*振り分け\*\*/ { f = 1 } f && /\*\*重複確認\*\*/ { exit } f { print }' "$SKILL_MD")"
    [ -n "$step" ]
    [[ "$step" == *'- `dev_flow`: skills repo の plugin を直せば消える'* ]]
    [[ "$step" == *'- `target_repo`: PR 先 repo のテスト・hook・lint が原因'* ]]
    [[ "$step" == *'- `environment`: sandbox・認証・権限・hook 拒否など実行環境が原因'* ]]
    [[ "$step" == *'- `transient`: 再実行で消える一過性'* ]]
    # 判定基準の行は 4 つだけ（enum を SKILL.md 側で増やさない）
    [ "$(printf '%s\n' "$step" | grep -cE '^ *- `[a-z_]+`: ')" = "4" ]
    [[ "$step" == *'`dev_flow` 以外に分類した signature は 3〜5 と起票を行わず、7 の記録だけ行う'* ]]
}

@test "重複確認・diff・finding・起票は dev_flow に分類した signature だけに行う" {
    grep -qF '**重複確認**（`dev_flow` のみ）' "$SKILL_MD"
    grep -qF '**候補 commit の diff を読む**（`dev_flow` のみ）' "$SKILL_MD"
    grep -qF '**finding をまとめる**（`dev_flow` のみ）' "$SKILL_MD"
    step="$(extract_filing_step)"
    [[ "$step" == *'重複を除いた `dev_flow` の finding が 1 件以上あれば'* ]]
    grep -qF '`dev_flow` に分類した signature だけ 1 signature = 1 issue で起票する' "$SKILL_MD"
}

@test "記録は全 signature の振り分けを daily.sh と同じマーカーで囲んだブロックとして最終出力に含め、skill からは記録スクリプトを実行しない" {
    step="$(awk '/\*\*記録\*\*/ { f = 1 } f && /^[0-9]+\. / { exit } f { print }' "$SKILL_MD")"
    [ -n "$step" ]
    [[ "$step" == *'全 signature（`dev_flow` 以外も含む）の `{id, signature, classification, reason, issue}`'* ]]
    [[ "$step" == *'マーカー行で囲んだブロックとして最終出力に 1 回だけ含める'* ]]
    # マーカーは daily.sh が .llm.log から取り出すときの区切り行と同じ文字列
    begin="$(sed -n "s/^CLASS_BEGIN='\(.*\)'$/\1/p" "$SKILL_DIR/scripts/daily.sh")"
    end="$(sed -n "s/^CLASS_END='\(.*\)'$/\1/p" "$SKILL_DIR/scripts/daily.sh")"
    [ "$begin" = '<!-- dev-flow-health-classifications:begin -->' ]
    [ "$end" = '<!-- dev-flow-health-classifications:end -->' ]
    [[ "$step" == *"      $begin"$'\n'*$'\n'"      $end"* ]]
    [[ "$step" == *'本 skill から `record-classification.sh` を実行せず、JSONL を Write / Edit / echo で直接書かない'* ]]
    run grep -F 'record-classification.sh --report' "$SKILL_MD"
    [ "$status" -ne 0 ]
    # 記録は起票の後（issue 番号を載せる）
    filing_line="$(grep -n '\*\*起票\*\*' "$SKILL_MD" | cut -d: -f1)"
    record_line="$(grep -n '\*\*記録\*\*' "$SKILL_MD" | cut -d: -f1)"
    [ "$filing_line" -lt "$record_line" ]
}

@test "rules の dev-flow-health 節は dev_flow に分類した signature だけを 1 signature = 1 issue で起票する" {
    rules="$SKILL_DIR/../../../.claude/rules/dev-flow.md"
    section="$(awk '/^## dev-flow-health/ { f = 1; next } f && /^## / { exit } f { print }' "$rules")"
    [[ "$section" == *'`dev_flow` に分類した signature だけ 1 signature = 1 issue で起票する'* ]]
    [[ "$section" == *'LLM は分類と理由だけ付ける'* ]]
}

@test "報告（手順 3）は起票番号・重複・candidates.error に加え git-issue の ## Launch Order を含む" {
    step="$(extract_report_step)"
    [ -n "$step" ]
    [[ "$step" == *'起票した issue 番号'* ]]
    [[ "$step" == *'重複で見送った signature'* ]]
    [[ "$step" == *'`candidates.error` で原因を絞れなかった signature'* ]]
    [[ "$step" == *'`## Launch Order`'* ]]
}
