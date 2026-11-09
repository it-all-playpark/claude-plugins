#!/usr/bin/env bats
# dev-flow-health SKILL.md を、スクリプトの値・起票経路の制約と照合する。説明文の言い回しは固定しない。

setup() {
    SKILL_DIR="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
    SKILL_MD="$SKILL_DIR/SKILL.md"
}

@test "SKILL.md は create_issue.py を直接実行せず、素の gh issue create も実行しない" {
    run grep -nE 'python3? [^ ]*create_issue\.py|create_issue\.py --' "$SKILL_MD"
    [ "$status" -ne 0 ]
    run grep -nE '^[[:space:]]*`?gh issue create |gh issue create --' "$SKILL_MD"
    [ "$status" -ne 0 ]
}

@test "振り分けは 4 分類だけを持ち、重複確認より前に行う" {
    step="$(awk '/\*\*振り分け\*\*/ { f = 1 } f && /\*\*重複確認\*\*/ { exit } f { print }' "$SKILL_MD")"
    [ -n "$step" ]
    [ "$(printf '%s\n' "$step" | sed -nE 's/^ *- `([a-z_]+)`: .*/\1/p' | sort | tr '\n' ' ')" = "dev_flow environment target_repo transient " ]
}

@test "振り分けの記録ブロックは daily.sh と同じマーカーで囲み、skill からは記録スクリプトを実行しない" {
    step="$(awk '/\*\*記録\*\*/ { f = 1 } f && /^[0-9]+\. / { exit } f { print }' "$SKILL_MD")"
    begin="$(sed -n "s/^CLASS_BEGIN='\(.*\)'$/\1/p" "$SKILL_DIR/scripts/daily.sh")"
    end="$(sed -n "s/^CLASS_END='\(.*\)'$/\1/p" "$SKILL_DIR/scripts/daily.sh")"
    [ -n "$begin" ] && [ -n "$end" ]
    [[ "$step" == *"      $begin"$'\n'*$'\n'"      $end"* ]]
    run grep -F 'record-classification.sh --report' "$SKILL_MD"
    [ "$status" -ne 0 ]
}

@test "model の変化は model_changes の各件を分類せず起票し、重複確認のマーカーは dev-flow-health:model:<agent_type>:<model_id>" {
    step="$(awk '/\*\*model の変化\*\*/ { f = 1 } f && /^[0-9]+\. / && !/\*\*model の変化\*\*/ { exit } f { print }' "$SKILL_MD")"
    [ -n "$step" ]
    [[ "$step" == *'`model_changes`'* ]]
    [[ "$step" == *'分類せずに'* ]]
    [[ "$step" == *'--search "dev-flow-health:model:<agent_type>:<model_id>"'* ]]
    [[ "$step" == *'<!-- dev-flow-health:model:<agent_type>:<model_id> -->'* ]]
    [[ "$step" == *'capability-bound.md'*'major モデルリリースごとの dry-run'* ]]
    # needs_llm が false で終える条件は model_changes を含む
    [[ "$(grep -F '`needs_llm` が false' "$SKILL_MD")" == *'`model_changes`'* ]]
}

@test "レポートの読み方は HOLD 由来の signature が拾う HOLD 理由（health-report.sh の定数と同じ）と、再現率優先・精度は分類で担うことを書く" {
    reading="$(awk '/^## レポートの読み方/ { f = 1; next } f && /^## / { exit } f { print }' "$SKILL_MD")"
    row="$(printf '%s\n' "$reading" | grep -F '| HOLD 由来の signature |')"
    [ -n "$row" ]
    [[ "$row" == *'`dev-flow \| hold \| Merge tier \| <HOLD 理由の code>`'* ]]
    script="$SKILL_DIR/scripts/health-report.sh"
    codes="$(sed -n "s/^HOLD_SIGNATURE_CODES='\(.*\)'\$/\1/p" "$script")"
    statuses="$(sed -n "s/^HOLD_SIGNATURE_ITERATE_STATUSES='\(.*\)'\$/\1/p" "$script")"
    [ -n "$codes" ]
    [ -n "$statuses" ]
    for v in $(printf '%s' "$codes" | jq -r '.[]') $(printf '%s' "$statuses" | jq -r '.[]') iterate_non_lgtm ac_human_pending; do
        [[ "$row" == *"\`$v\`"* ]]
    done
    [[ "$row" == *'再現率を優先'* ]]
    [[ "$row" == *'精度は手順の分類'* ]]
    # 細目の template（health-report.sh の security_template / iterate_template と同じ形）
    [[ "$row" == *'`security_review_unresolved status=<security_review_status> stop=<security_review_stop_reason>`'* ]]
    [[ "$row" == *'`iterate_non_lgtm status=fix_failed fix=<fix_terminal_reason>`'* ]]
    grep -qF '"security_review_unresolved status=\(.security_review_status // "none") stop=\(.security_review_stop_reason // "none")"' "$script"
    grep -qF '"iterate_non_lgtm status=fix_failed fix=\(.fix_terminal_reason // "none")"' "$script"
    # 単体起動の pr-iterate の signature の行
    iter_row="$(printf '%s\n' "$reading" | grep -F '| 単体の pr-iterate の signature |')"
    [[ "$iter_row" == *'`pr-iterate \| hold \| Iterate \| <template>`'* ]]
    [[ "$iter_row" == *'iterate_caller` が `standalone`'* ]]
    [[ "$iter_row" == *'`iterate_caller` が `dev-flow`'*'発生にも resolved の判定にも入れない'* ]]
}
