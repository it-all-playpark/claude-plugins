#!/usr/bin/env bats
# Static pins for git-issue docs ↔ create_issue.py (issue #744)
#
# - human 判定基準と `executor: human` マーカーが SKILL.md と references/issue-template.md で一致する
# - devils-advocate-checklist.md の Blocking Categories に人手作業混入の 2 項目がある
# - SKILL.md Phase 6 が human issue（--kind human）→ 実装 issue（--blocked-by）の順で、Output Contract に
#   human issue と依存関係が含まれる
# - template の 2 つの本文雛形が create_issue.py の --kind agent / --kind human ゲートを通る
#
# agent issue の分割・変更対象パス・依存（issue #774）:
# - SKILL.md Phase 3 に「agent issue 1 本 = dev-flow 1 run = 1 PR」と分割基準 3 条件・分けない条件がある
# - `## 変更対象パス` の書式行が issue-template.md の実装 issue テンプレートと SKILL.md で一致する
# - SKILL.md Phase 6 が agent issue をトポロジカル順に --blocked-by 付きで起票し、--dry-run で依存グラフを
#   Output Contract に並べる。Output Contract に agent issue 一覧と依存関係がある
# - devils-advocate-checklist.md の Blocking Categories に分割・パス・依存の 3 項目がある
#
# 起票後の起動順:
# - SKILL.md Phase 7 が起票した agent issue に dev-flow-ready-set を bare 名先頭で実行し、--dry-run と
#   ok:false では launch を出さない。Output Contract に launch / 後の波 / 実行中を並べる ## Launch Order がある
# - ## Launch Order の写し方と雛形が launch[] ごとに bg_command（claude --bg "/dev-flow <N>"）を載せる（issue #1000）
# - Output Contract の雛形と Launch Order への写し方は references/output-contract.md に置く
#
# 実装 issue の本文はゴールと境界条件だけ（issue #855）:
# - 実装 issue テンプレートの節が ゴール / なぜ / 受け入れ基準 / 制約・取らないこと / 変更対象パス / 未解決事項 の 6 つ
# - SKILL.md Phase 5 の本文に含めるものがその 6 節で、Phase 2・Phase 4 の結果は AC と制約に反映させるだけ
#
# 起票の依頼を規模を問わず受ける軽い経路（issue #991）:
# - frontmatter が model: opus / effort: xhigh で、guide の effort 表と食い違わない
# - description の Use when: に普通の頼み方のトリガー語がある
# - 経路の選択基準、軽い経路が Phase 2・4 を省いて Phase 5〜7 を通ること、重い経路への切り替え、複数 finding の
#   まとめ起票、Plan Quality Gate の経路欄
#
# 起票時の AC の人手判定（issue #1026）:
# - Phase 6 の --kind agent と軽い経路のゲートに、dev-flow と同じ ac-actor.mjs の判定が載る
#
# dev-flow の security review の脅威モデル（PR の作者が攻撃者）:
# - devils-advocate-checklist.md の Blocking Categories に、PR が書き換えられる入力を根拠に gate を外す・
#   検証を省く AC を止める項目がある
#
# 症状の条件分岐を足すだけの直し方を軽い経路で起票しない（issue #1199）:
# - devils-advocate-checklist.md の Blocking Categories に、分岐・ガード・入力の追加だけの直し方を止める項目がある
# - 軽い経路の手順 1 で同じ仕組みを直した close 済み issue を数え、手順 2 でその項目に当たったら重い経路に切り替える

setup() {
    command -v python3 >/dev/null || skip "python3 not available"

    SKILL_DIR="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
    SKILL_MD="$SKILL_DIR/SKILL.md"
    TEMPLATE="$SKILL_DIR/references/issue-template.md"
    CHECKLIST="$SKILL_DIR/references/devils-advocate-checklist.md"
    CONTRACT="$SKILL_DIR/references/output-contract.md"
    RECOVERY="$SKILL_DIR/references/ac-lint-recovery.md"
    SCRIPT="$SKILL_DIR/scripts/create_issue.py"
    REPO_ROOT="$(cd "$SKILL_DIR/../../.." && pwd)"
}

# human 判定基準の番号付きリスト（見出し行の直後のリスト）を抜き出す
extract_criteria() {
    awk '/human 判定基準/ { f = 1; next }
         f && /^[0-9]+\. / { print; seen = 1; next }
         f && seen { exit }' "$1"
}

# <start-regex> 以降で最初の ```markdown フェンスの中身を抜き出す
extract_fence() {
    awk -v start="$2" '$0 ~ start { f = 1 }
         f && !in_fence && /^```markdown$/ { in_fence = 1; next }
         in_fence && /^```$/ { exit }
         in_fence { print }' "$1"
}

# references/output-contract.md のサマリー雛形（最初の ```markdown フェンス）
extract_contract() {
    extract_fence "$CONTRACT" "^# Output Contract"
}

# SKILL.md の `### <name>` / `## <name>` 節を次の `##` / `###` 見出しまで抜き出す（コードフェンス内の見出しは無視）
extract_section() {
    awk -v h="$2" 'index($0, h) == 1 { f = 1; print; next }
         f && /^```/ { in_fence = !in_fence }
         f && !in_fence && /^##+ / && !/^####/ { exit }
         f { print }' "$1"
}

@test "(1) human 判定基準が SKILL.md と issue-template.md で一致し、6 項目ある" {
    skill="$(extract_criteria "$SKILL_MD")"
    template="$(extract_criteria "$TEMPLATE")"
    [ -n "$skill" ]
    [ "$skill" = "$template" ]
    [ "$(printf '%s\n' "$skill" | wc -l | tr -d ' ')" -eq 6 ]
    for item in "外部サービスの管理画面操作・アカウント作成" "secret・API キーの発行と登録" "DNS・課金・契約" \
        "顧客への確認・承認" "本番データの手作業操作" "実機での手動確認"; do
        [[ "$skill" == *"$item"* ]]
    done
}

@test "(2) マーカー文字列 executor: human / executor: agent が SKILL.md と issue-template.md の両方にある" {
    for f in "$SKILL_MD" "$TEMPLATE"; do
        grep -q '`executor: human`' "$f"
        grep -q 'executor: agent' "$f"
    done
    # create_issue.py のゲートは同じ固定文字列を正規表現で判定する
    grep -q 'HUMAN_MARKER_RE = re.compile(r"executor:\[ \\t\]\*human\\b")' "$SCRIPT"
}

@test "(3) devils-advocate-checklist の Blocking Categories に人手作業混入の 2 項目がある" {
    section="$(awk '/^## Blocking Categories/ { f = 1; next } f && /^## / { exit } f { print }' "$CHECKLIST")"
    [[ "$section" == *'agent issue に `executor: human` タスクが残存'* ]]
    [[ "$section" == *"human タスクに完了確認方法が無い"* ]]
}

@test "(4) SKILL.md Phase 6 は human issue（--kind human）→ 実装 issue（--blocked-by）の順で起票する" {
    phase6="$(extract_section "$SKILL_MD" "### Phase 6")"
    human_line="$(printf '%s\n' "$phase6" | grep -n -- '--kind human' | head -1 | cut -d: -f1)"
    blocked_line="$(printf '%s\n' "$phase6" | grep -n -- '--blocked-by' | head -1 | cut -d: -f1)"
    [ -n "$human_line" ] && [ -n "$blocked_line" ]
    [ "$human_line" -lt "$blocked_line" ]
    [[ "$phase6" == *"human issue を先に起票する"* ]]
}

@test "(5) Output Contract に human issue と Blocked by 関係が含まれる" {
    contract="$(extract_contract)"
    [[ "$contract" == *"## Human Tasks"* ]]
    [[ "$contract" == *"human issue:"* ]]
    [[ "$contract" == *"Blocked by"* ]]
}

@test "(6) 実装 issue テンプレートは create_issue.py --kind agent を通る" {
    BODY="$BATS_TEST_TMPDIR/agent.md"
    extract_fence "$TEMPLATE" "^# GitHub Issue Template" >"$BODY"
    grep -q '^## 受け入れ基準' "$BODY"

    run python3 "$SCRIPT" --kind agent --title "Test" --body-file "$BODY" --dry-run

    [ "$status" -eq 0 ]
}

@test "(7) human issue テンプレートは create_issue.py --kind human を通る" {
    BODY="$BATS_TEST_TMPDIR/human.md"
    extract_fence "$TEMPLATE" "^## human issue テンプレート" >"$BODY"
    grep -q '^## 手順' "$BODY"

    run python3 "$SCRIPT" --kind human --title "Test" --body-file "$BODY" --dry-run

    [ "$status" -eq 0 ]
    [[ "$output" == *"--label human-task"* ]]
}

# `## 変更対象パス` 見出し直後のエントリ行（空行かコードフェンスまで）を抜き出す
extract_paths_block() {
    awk '/^## 変更対象パス$/ { f = 1; next }
         f && (/^$/ || /^```/) { exit }
         f { print }' <<<"$1"
}

@test "(8) SKILL.md Phase 3 に agent issue 1 本 = dev-flow 1 run = 1 PR と分割基準 3 条件・分けない条件がある" {
    phase3="$(extract_section "$SKILL_MD" "### Phase 3")"
    [[ "$phase3" == *"agent issue 1 本 = dev-flow 1 run = 1 PR"* ]]
    [[ "$phase3" == *"1. 単独で merge しても main のテストが green のまま価値を持つ成果物が 2 つ以上ある"* ]]
    [[ "$phase3" == *"2. AC の中に、別の成果物のコードが無いと検証できない組がある（先行成果物を別 issue にし Blocked by で繋ぐ）"* ]]
    [[ "$phase3" == *"3. 変更対象パスが互いに独立した 2 群に分かれ、どちらか片方だけで価値がある"* ]]
    [[ "$phase3" == *"分けない: 片方だけではテストが書けない・main を壊す（例: 呼び出し側の無い内部 API だけ）分割。"* ]]
    [[ "$phase3" == *"分けすぎは人手 merge 回数を増やす。"* ]]
}

@test "(9) ## 変更対象パス の書式行が実装 issue テンプレートと SKILL.md で一致する" {
    template="$(extract_paths_block "$(extract_fence "$TEMPLATE" "^# GitHub Issue Template")")"
    skill="$(extract_paths_block "$(extract_section "$SKILL_MD" "### Phase 3")")"
    [ "$template" = "- <repo 相対パスまたは glob>" ]
    [ "$skill" = "$template" ]
    # human issue テンプレートには変更対象パス欄を置かない
    ! extract_fence "$TEMPLATE" "^## human issue テンプレート" | grep -q '変更対象パス'
}

@test "(10) SKILL.md Phase 6 は agent issue を依存のトポロジカル順に --blocked-by 付きで起票し、--dry-run で依存グラフを並べる" {
    phase6="$(extract_section "$SKILL_MD" "### Phase 6")"
    human_line="$(printf '%s\n' "$phase6" | grep -n 'human issue を先に起票する' | head -1 | cut -d: -f1)"
    agent_line="$(printf '%s\n' "$phase6" | grep -n 'agent issue を依存のトポロジカル順に起票する' | head -1 | cut -d: -f1)"
    [ -n "$human_line" ] && [ -n "$agent_line" ]
    [ "$human_line" -lt "$agent_line" ]
    [[ "$phase6" == *"先行 issue（その issue が待つ human issue と、先に起票した agent issue）の番号を"*"--blocked-by <番号[,…]>"* ]]
    [[ "$phase6" == *"全 issue（human issue → agent issue）と依存グラフ"*"Output Contract に並べて表示する"* ]]
    [[ "$phase6" == *"--dry-run"* ]]
}

@test "(11) Output Contract に agent issue 一覧と依存関係の欄がある" {
    contract="$(extract_contract)"
    agent="$(awk '/^## Agent Issues/ { f = 1; next } f && /^## / { exit } f { print }' <<<"$contract")"
    [ -n "$agent" ]
    [[ "$agent" == *"agent issue（起票順 = トポロジカル順）:"* ]]
    [[ "$agent" == *"変更対象パス:"* ]]
    [[ "$agent" == *"依存関係:"* ]]
    [[ "$agent" == *"Blocked by"* ]]
}

@test "(12) devils-advocate-checklist の Blocking Categories に分割・変更対象パス・依存の 3 項目がある" {
    section="$(awk '/^## Blocking Categories/ { f = 1; next } f && /^## / { exit } f { print }' "$CHECKLIST")"
    [[ "$section" == *"1 本の agent issue が単独で merge できる成果物を 2 つ以上含む"* ]]
    [[ "$section" == *'agent issue に `## 変更対象パス` が無い'* ]]
    [[ "$section" == *"agent issue 間の依存が循環している / 先行 issue の成果物を使うのに Blocked by が無い"* ]]
}

@test "(13) SKILL.md Phase 7 は起票した agent issue に dev-flow-ready-set を bare 名先頭で実行し、dry-run と ok:false では launch を出さない" {
    phase7="$(extract_section "$SKILL_MD" "### Phase 7")"
    [ -n "$phase7" ]
    # 起動形は bare 名が先頭トークン（plugin bin/ の PATH 解決）
    printf '%s\n' "$phase7" | grep -q '^dev-flow-ready-set \[--repo owner/repo\] --with-in-flight <M1> <M2> \.\.\.$'
    [[ "$phase7" == *"human issue は渡さない"* ]]
    [[ "$phase7" == *'`--dry-run` では issue 番号が無いので実行しない'* ]]
    [[ "$phase7" == *'{"ok":false,...}'*"失敗した判定を launch として見せない"* ]]
    # 他 issue の実行中 run は --with-in-flight で拾い、そのパスとの衝突も判定する
    [[ "$phase7" == *'`--with-in-flight` で他 issue の実行中 run'*"その変更対象パスとの衝突も判定する"* ]]
    # JSON を ## Launch Order へ写す規則は output-contract.md に置く
    [[ "$phase7" == *'`references/output-contract.md`'* ]]
    mapping="$(awk '/^## Launch Order への写し方/ { f = 1; next } f && /^## / { exit } f { print }' "$CONTRACT")"
    [[ "$mapping" == *"issue ごとに別セッション"* ]]
    # launch[] ごとに command と別セッション起動の bg_command を写す
    [[ "$mapping" == *'`launch[]`'*'各要素の `command`（`/dev-flow <N>`）と `bg_command`'*'（`claude --bg "/dev-flow <N>"`'* ]]
    [[ "$mapping" == *"(変更対象パスなし)"* ]]
    contract="$(extract_contract)"
    order="$(awk '/^## Launch Order/ { f = 1; next } f && /^## / { exit } f { print }' <<<"$contract")"
    [[ "$order" == *"--with-in-flight"* ]]
    [[ "$order" == *"実行中（他 issue の run。パスを占有）"* ]]
    # Phase 6 の起票より後に置く
    p6="$(grep -n '^### Phase 6' "$SKILL_MD" | cut -d: -f1)"
    p7="$(grep -n '^### Phase 7' "$SKILL_MD" | cut -d: -f1)"
    [ "$p6" -lt "$p7" ]
}

@test "(14) Output Contract に launch / 後の波 / 実行中を並べる ## Launch Order がある" {
    contract="$(extract_contract)"
    order="$(awk '/^## Launch Order/ { f = 1; next } f && /^## / { exit } f { print }' <<<"$contract")"
    [ -n "$order" ]
    [[ "$order" == *"dev-flow-ready-set"* ]]
    [[ "$order" == *'`/dev-flow <M1>`'* ]]
    # launch[] の各行に bg_command
    printf '%s\n' "$order" | grep -qF -- '  - `/dev-flow <M1>` — #M1 タイトル — bg_command: `claude --bg "/dev-flow <M1>"`'
    [[ "$order" == *"後の波:"* ]]
    for reason in blocked_by path_conflict no_declared_paths human_task open_pr local_branch worktree; do
        [[ "$order" == *"$reason"* ]]
    done
    # Agent Issues の後、Plan Quality Gate の前
    agent_line="$(grep -n '^## Agent Issues' <<<"$contract" | cut -d: -f1)"
    order_line="$(grep -n '^## Launch Order' <<<"$contract" | cut -d: -f1)"
    gate_line="$(grep -n '^## Plan Quality Gate' <<<"$contract" | cut -d: -f1)"
    [ "$agent_line" -lt "$order_line" ] && [ "$order_line" -lt "$gate_line" ]
}

# 実装 issue の本文の節（この順で、これ以外の節を持たない）
AGENT_BODY_SECTIONS="## ゴール
## なぜ
## 受け入れ基準（Acceptance Criteria）
## 制約・取らないこと
## 変更対象パス
## 未解決事項（Open Questions）"

@test "(15) 実装 issue テンプレートの節は ゴール / なぜ / 受け入れ基準 / 制約・取らないこと / 変更対象パス / 未解決事項 だけ" {
    headings="$(extract_fence "$TEMPLATE" "^# GitHub Issue Template" | grep -E '^#+ ')"
    [ "$headings" = "$AGENT_BODY_SECTIONS" ]
}

@test "(16) SKILL.md Phase 5 の本文に含めるものは 6 節で、Phase 2・Phase 4 の結果は AC と制約に反映させるだけで書き写さない" {
    phase5="$(extract_section "$SKILL_MD" "### Phase 5")"
    listed="$(awk '/^本文に含めるもの/ { f = 1; next } f && /^- / { print; next } f { exit }' <<<"$phase5" \
        | sed -E 's/^- `([^`]*)`.*/\1/')"
    [ "$listed" = "$AGENT_BODY_SECTIONS" ]
    [[ "$phase5" != *"specialist summaries"* ]]
    [[ "$phase5" != *"devil's-advocate history"* ]]
    [[ "$phase5" == *"Phase 2（調査）・Phase 4（devil's advocate）の結果は AC と制約に反映させるだけで本文に書き写さない。"* ]]
    # 調査と devil's advocate の工程は残す（出力先は Phase 5 の 1 文で AC と制約に向ける）
    [[ "$(extract_section "$SKILL_MD" "### Phase 2")" == *'`frontend`'*'`backend`'*'`infra`'* ]]
    [[ "$(extract_section "$SKILL_MD" "### Phase 4")" == *"Loop rules:"* ]]
}

# frontmatter の top-level key の値（inline か block scalar の本文）を抜き出す
frontmatter_value() {
    awk -v key="$2" 'NR == 1 && /^---$/ { fm = 1; next }
         fm && /^---$/ { exit }
         fm && index($0, key ":") == 1 { v = substr($0, length(key) + 2); sub(/^[ \t]+/, "", v)
             if (v != "|" && v != ">") { print v; exit }
             in_key = 1; next }
         in_key && /^[a-z]/ { exit }
         in_key { sub(/^  /, ""); print }' "$1"
}

# validate-skill-frontmatter.sh（description + when_to_use の 1536 字上限を含む）を通ることは
# playpark-core/hooks/validate-skill-frontmatter.bats の "every tracked SKILL.md passes the validator" が検査する
@test "(17) frontmatter は model: opus / effort: xhigh" {
    [ "$(frontmatter_value "$SKILL_MD" model)" = "opus" ]
    [ "$(frontmatter_value "$SKILL_MD" effort)" = "xhigh" ]
}

@test "(18) docs/skill-creation-guide.md の effort 表で例に挙げるなら、その行は SKILL.md の effort と一致する" {
    effort="$(frontmatter_value "$SKILL_MD" effort)"
    rows="$(grep -E '^\| `(low|medium|high|xhigh|max)` \|' "$REPO_ROOT/docs/skill-creation-guide.md" \
        | grep -F '`git-issue`' || true)"
    while IFS= read -r row; do
        [ -z "$row" ] && continue
        [[ "$row" == "| \`$effort\` |"* ]]
    done <<<"$rows"
}

@test "(19) description の Use when: に普通の頼み方のトリガー語があり、規模を問わずこの skill で起票すると書く" {
    use_when="$(frontmatter_value "$SKILL_MD" description | awk '/Use when:/ { f = 1 } /^Accepts args:/ { exit } f')"
    [ -n "$use_when" ]
    for phrase in "issue にして" "issue 化" "起票" "issue 立てて" "create an issue" "file an issue"; do
        [[ "$use_when" == *"\"$phrase\""* ]]
    done
    [[ "$use_when" == *"issue を作る依頼は規模を問わずこの skill で行う"* ]]
}

@test "(20) 経路の選択: 軽い経路は具体的な finding・1 finding = 1 agent issue・human タスクも依存も無いもの、それ以外は重い経路" {
    sel="$(extract_section "$SKILL_MD" "## 経路の選択")"
    [ -n "$sel" ]
    light="$(awk '/^\*\*軽い経路\*\*/ { f = 1 } /^\*\*重い経路\*\*/ { exit } f' <<<"$sel")"
    heavy="$(awk '/^\*\*重い経路\*\*/ { f = 1 } f' <<<"$sel")"
    [[ "$light" == *"すべて満たすとき"* ]]
    [[ "$light" == *"症状・原因・直し方の分かった具体的な finding"* ]]
    [[ "$light" == *"1 finding = 1 agent issue"* ]]
    [[ "$light" == *"human タスクを含まない"* ]]
    [[ "$light" == *"issue 間の依存が無い"* ]]
    [[ "$heavy" == *"（Phase 1〜7）は、それ以外のすべて"* ]]
    for item in "議論から起こす新機能" "設計判断が要る計画" "分割や依存が要るもの" "human タスクを含むもの"; do
        [[ "$heavy" == *"$item"* ]]
    done
    # 経路は Workflow に入る前に決める
    sel_line="$(grep -n '^## 経路の選択' "$SKILL_MD" | cut -d: -f1)"
    wf_line="$(grep -n '^## Workflow' "$SKILL_MD" | cut -d: -f1)"
    [ "$sel_line" -lt "$wf_line" ]
}

@test "(21) 軽い経路は Phase 2・Phase 4 を行わず、Blocking Categories に 1 回照らして Phase 5〜7 を通る（gh issue create を直接書かない）" {
    light="$(extract_section "$SKILL_MD" "### 軽い経路（Light Path）")"
    [ -n "$light" ]
    [[ "$light" == *"Phase 2 の 3 観点調査"*"Phase 4 の devil's-advocate ループを行わない"* ]]
    [[ "$light" == *"対象コード"*"を読み"*"AC・"*'`## 制約・取らないこと`・`## 変更対象パス` を埋める'* ]]
    [[ "$light" == *'`references/devils-advocate-checklist.md` の Blocking Categories に 1 回だけ照らし'* ]]
    grep -q '^## Blocking Categories' "$CHECKLIST"
    [[ "$light" == *"Phase 5"*'AC Lint Self-Check（`ac-lint`）を通す'* ]]
    [[ "$light" == *'Phase 6 の `create_issue.py`（`--kind agent`'* ]]
    [[ "$light" == *"Phase 7"*'`dev-flow-ready-set`'* ]]
    [[ "$light" != *"gh issue create"* ]]
    # 参照先の Phase 5〜7 が ac-lint / create_issue.py / dev-flow-ready-set を実行する
    [[ "$(extract_section "$SKILL_MD" "### Phase 5")" == *"ac-lint /tmp/git-issue-body.md"* ]]
    [[ "$(extract_section "$SKILL_MD" "### Phase 6")" == *"scripts/create_issue.py"* ]]
    [[ "$(extract_section "$SKILL_MD" "### Phase 7")" == *"dev-flow-ready-set [--repo owner/repo]"* ]]
}

@test "(22) 軽い経路の途中で分割・依存・human タスクが要ると分かったら、同じ仕組みの修正が続いたら、分岐を足すだけの直し方なら重い経路に切り替える" {
    light="$(extract_section "$SKILL_MD" "### 軽い経路（Light Path）")"
    switch="$(awk '/^途中で分割/ { f = 1 } f { print } f && /^$/ { exit }' <<<"$light")"
    [[ "$switch" == *"途中で分割・issue 間の依存・human タスクが必要と分かったら"*"重い経路"*"に切り替える"* ]]
    # 手順 1 の close 済み issue の数と、手順 2 の Blocking 項目が契機に入る
    [[ "$switch" == *"手順 1 で同じ仕組みを直した close 済みの issue が"*"直近 30 日に 2 件以上見つかったら"* ]]
    [[ "$switch" == *"手順 2 で「直し方が症状の条件の分岐・ガード・入力の追加だけ」の項目に"*"当たったら"* ]]
    # 無人の claude -p から呼ばれても止まらない
    [[ "$switch" == *"症状・原因・直し方を Phase 1 の入力にして、人に質問せずに進む"* ]]
    [[ "$switch" == *'切り替えた finding と理由は'*'Output Contract の `## Plan Quality Gate` に書く'* ]]
}

@test "(23) 軽い経路は複数 finding を 1 回で起票し、本文ファイルごとに ac-lint と create_issue.py、Phase 7 は全 issue で 1 回" {
    light="$(extract_section "$SKILL_MD" "### 軽い経路（Light Path）")"
    [[ "$light" == *"複数の finding を 1 回の呼び出しでまとめて起票できる"* ]]
    [[ "$light" == *"finding ごとに本文ファイルを作り"* ]]
    [[ "$light" == *'本文ファイルごとに AC Lint Self-Check（`ac-lint`）を通す'* ]]
    [[ "$light" == *'本文ファイルごとに Phase 6 の `create_issue.py`'* ]]
    [[ "$light" == *'Phase 7 は起票した全 issue の番号をまとめて `dev-flow-ready-set` に 1 回だけ渡す'* ]]
}

@test "(24) Output Contract の ## Plan Quality Gate に通った経路（軽い / 重い）が出る" {
    contract="$(extract_contract)"
    gate="$(awk '/^## Plan Quality Gate/ { f = 1; next } f && /^## / { exit } f { print }' <<<"$contract")"
    [[ "$gate" == *"- 経路: 軽い / 重い"* ]]
}

@test "(25) ac-lint の non_compliant は ac-lint-recovery.md の手順で直し、直せなければ起票せず abort する" {
    row="$(extract_section "$SKILL_MD" "### Phase 5" | grep '^| `non_compliant` |')"
    [[ "$row" == *'`references/ac-lint-recovery.md`'* ]]
    [[ "$row" == *"issue を作らず abort"* ]]
    grep -q '## 受け入れ基準（Acceptance Criteria）' "$RECOVERY"
    grep -q 'Phase 3 に戻って' "$RECOVERY"
    grep -q 'issue を作らず abort' "$RECOVERY"
}

@test "(26) Phase 6 の --kind agent と軽い経路のゲートに AC の人手判定（dev-flow と同じ ac-actor.mjs の判定）が載り、create_issue.py はその CLI を呼ぶ" {
    agent="$(extract_section "$SKILL_MD" "### Phase 6" | awk '/^- `--kind agent`/ { f = 1 } /^- `--kind human`/ { exit } f { print }')"
    [[ "$agent" == *'AC の人手判定も dev-flow と同じ `_lib/ac-actor.mjs` の判定で行う'* ]]
    [[ "$agent" == *"repo 内外の作業が混ざった AC も理由を出して exit 1"* ]]
    [[ "$agent" == *'人の作業は `--kind human` で別 issue に切り出して先に起票し'*'この issue は `--blocked-by` で紐付ける'* ]]
    light="$(extract_section "$SKILL_MD" "### 軽い経路（Light Path）")"
    [[ "$light" == *'ゲート（ac-lint・4000 字・変更対象パス・`executor: human` の検出・AC の人手判定（dev-flow と同じ `ac-actor.mjs` の判定））は重い経路と同じ'* ]]
    # 載せた判定は create_issue.py が ac-actor.mjs を import する CLI を呼んで行う
    grep -q '"ac-actor-classify.mjs"' "$SCRIPT"
    grep -q "from '../ac-actor.mjs'" "$REPO_ROOT/plugins/dev-flow/_lib/scripts/ac-actor-classify.mjs"
}

@test "(27) devils-advocate-checklist の Blocking Categories に、PR が書き換えられる入力で gate を外す・検証を省く AC を止める項目がある" {
    section="$(awk '/^## Blocking Categories/ { f = 1; next } f && /^## / { exit } f { print }' "$CHECKLIST")"
    [[ "$section" == *"PR が書き換えられる入力"*"merge gate・HOLD を外す、または検証"*"を省くよう指示している"* ]]
    [[ "$section" == *"実行する中身（テスト・script）を PR が書けるなら PR が書き換えられる入力に当たる"* ]]
    [[ "$section" == *"gate 自身の判定より弱い実行"*"その gate を外すのも同じ"* ]]
}

@test "(28) devils-advocate-checklist の Blocking Categories に、症状の条件の分岐・ガード・入力の追加だけの直し方を止める項目がある" {
    section="$(awk '/^## Blocking Categories/ { f = 1; next } f && /^## / { exit } f { print }' "$CHECKLIST")"
    [[ "$section" == *"- 直し方が症状の条件の分岐・ガード・入力の追加だけで、同じ型の別の症状が残る、または削除・統合で済む案を検討していない"* ]]
}

@test "(29) 軽い経路の手順 1 で変更対象パスごとに close 済み issue を引き、同じ仕組みの修正が直近 30 日に 2 件以上なら重い経路に切り替える（パスの重なりだけでは切り替えない）" {
    light="$(extract_section "$SKILL_MD" "### 軽い経路（Light Path）")"
    step1="$(awk '/^1\. / { f = 1 } /^2\. / { exit } f' <<<"$light")"
    [[ "$step1" == *'`## 変更対象パス` の各パスについて'* ]]
    [[ "$step1" == *'`gh issue list --state closed --search "\"<path>\" in:body"` で close 済みの issue を引き'* ]]
    # パスはコマンド文字列に置換せず、ファイル経由で 1 つの引数として渡す（パス中の $(…) をシェルに評価させない）
    [[ "$step1" == *'`<path>` をコマンド文字列に書き込まない'* ]]
    [[ "$step1" == *'`--search "\"$(cat /tmp/git-issue-path.txt)\" in:body"` の形で 1 つの引数として渡す'* ]]
    [[ "$step1" == *"finding と同じ仕組み（同じ判定・同じ prompt の組み立て・"*"同じガード）を直した issue が直近 30 日に 2 件以上あれば"*"重い経路に切り替える"* ]]
    [[ "$step1" == *"パスが重なるだけでは"*"切り替えない"* ]]
}

@test "(30) 軽い経路の手順 2 で、分岐・ガード・入力の追加だけの項目に当たった finding はその場で直さず重い経路に切り替え、他の Blocking 項目はその場で直す" {
    light="$(extract_section "$SKILL_MD" "### 軽い経路（Light Path）")"
    step2="$(awk '/^2\. / { f = 1 } /^3\. / { exit } f' <<<"$light")"
    [[ "$step2" == *"「直し方が症状の条件の分岐・ガード・入力の追加だけ」の項目に当たった finding は、その場で"*"直さずに重い経路に切り替える"* ]]
    [[ "$step2" == *"他の Blocking 項目はこれまでどおりその場で直す"* ]]
    # 参照先の項目が Blocking Categories にある
    section="$(awk '/^## Blocking Categories/ { f = 1; next } f && /^## / { exit } f { print }' "$CHECKLIST")"
    [[ "$section" == *"直し方が症状の条件の分岐・ガード・入力の追加だけで"* ]]
}
