#!/usr/bin/env bats
bats_require_minimum_version 1.5.0

# Tests for dev-flow/scripts/prerun-analyze.sh (issue #690)
#
# ネットワークには出ない。gh は fixture JSON を返す stub、Jev は偽 jev-classify（PATH 先頭）で応答を
# 制御する。偽 jev-classify は stdin の state に埋め込んだマーカーで応答を決める:
#   noul 質問 <id> → `[[jev:<id>:<p>]]`、無ければ `[[jev:noul:<p>]]`（全 noul 質問に同じ p）
#   choice 質問 kind → `[[jev:<choice>:<p>]]`
# <p> は JSON 値をそのまま応答に載せる（`true` / `"0.95"` 等、数値以外の確率を返す client を再現できる）。
# どの質問にも値が無ければ空 stdout と reason `bad response …` を返す。FAKE_JEV_REASON を置くとその理由で
# 空 stdout を返す（クライアントの失敗理由 → prerun の見出しの対応を見る）。
# これで comment ごとに別の判定を返せる（1 request = 1 comment）。

SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)/prerun-analyze.sh"

setup() {
    WORK="$BATS_TEST_TMPDIR/work"
    mkdir -p "$WORK/bin"

    # ---- gh stub ----
    GH_LOG="$WORK/gh.log"
    : >"$GH_LOG"
    # dependencies API（blocked_by）は GH_STUB_DEPS_FIXTURE（未設定なら []）、GH_STUB_DEPS_FAIL で失敗。
    # 対象 issue（#7）以外の `issue view N` は $GH_STUB_ISSUES_DIR/N.json（無ければ not found で失敗）
    GH_STUB_ISSUES_DIR="$WORK/issues"
    mkdir -p "$GH_STUB_ISSUES_DIR"
    cat >"$WORK/bin/gh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$GH_LOG"
if [[ -n "${GH_STUB_FAIL:-}" ]]; then
    echo "$GH_STUB_FAIL" >&2
    exit 1
fi
if [[ "$1" == "api" && "$2" == */dependencies/blocked_by* ]]; then
    if [[ -n "${GH_STUB_DEPS_FAIL:-}" ]]; then
        echo "$GH_STUB_DEPS_FAIL" >&2
        exit 1
    fi
    if [[ -n "${GH_STUB_DEPS_FIXTURE:-}" ]]; then cat "$GH_STUB_DEPS_FIXTURE"; else echo '[]'; fi
    exit 0
fi
if [[ "$1 $2" == "issue view" && "$3" != "7" ]]; then
    if [[ -f "$GH_STUB_ISSUES_DIR/$3.json" ]]; then
        cat "$GH_STUB_ISSUES_DIR/$3.json"
        exit 0
    fi
    echo "GraphQL: Could not resolve to an issue with the number of $3." >&2
    exit 1
fi
cat "$GH_STUB_FIXTURE"
STUB
    chmod +x "$WORK/bin/gh"

    # ---- jev-classify stub (Jev) ----
    JEV_LOG="$WORK/jev.log"
    : >"$JEV_LOG"
    cat >"$WORK/bin/jev-classify" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
questions=""
reason_file=""
printf '%s\n' "$*" >>"$JEV_LOG.argv"
while [[ $# -gt 0 ]]; do
  case "$1" in
  --questions) questions="$2"; shift 2 ;;
  --reason-file) reason_file="$2"; shift 2 ;;
  *) shift ;;
  esac
done
state="$(cat)"
printf 'call\n' >>"$JEV_LOG"
printf 'max-time=%s\n' "${JEV_MAX_TIME:-}" >>"$JEV_LOG"
printf '%s' "$questions" | jq -c '.' >>"$JEV_LOG.questions"
printf '%s' "$state" >"$JEV_LOG.state"
if [[ -n "${FAKE_JEV_REASON:-}" ]]; then
  [[ -n "$reason_file" ]] && printf '%s\n' "$FAKE_JEV_REASON" >"$reason_file"
  exit 0
fi
answers='{}'
for q in $(printf '%s' "$questions" | jq -r 'to_entries[] | select(.value.type == "noul") | .key'); do
  p=""
  if [[ "$state" =~ \[\[jev:${q}:([^]]+)\]\] ]]; then
    p="${BASH_REMATCH[1]}"
  elif [[ "$state" =~ \[\[jev:noul:([^]]+)\]\] ]]; then
    p="${BASH_REMATCH[1]}"
  fi
  [[ -n "$p" ]] && answers="$(jq -c --arg q "$q" --argjson p "$p" '. + {($q): {type: "noul", noul: $p}}' <<<"$answers")"
done
if printf '%s' "$questions" | jq -e '.kind.type == "choice"' >/dev/null \
  && [[ "$state" =~ \[\[jev:(override|conflict|resolved|unrelated):([^]]+)\]\] ]]; then
  c="${BASH_REMATCH[1]}"; p="${BASH_REMATCH[2]}"
  answers="$(jq -c --arg c "$c" --argjson p "$p" '. + {kind: {type: "choice", choice: $c, probabilities: {($c): $p}}}' <<<"$answers")"
fi
if [[ "$answers" == '{}' ]]; then
  [[ -n "$reason_file" ]] && echo 'bad response (no .answers object): <html>502</html>' >"$reason_file"
  exit 0
fi
jq -cn --argjson a "$answers" '{model: "typesafe-ai/jev", answers: $a, usage: {input_tokens: 1, output_tokens: 0}}'
FAKE
    chmod +x "$WORK/bin/jev-classify"

    export GH_LOG JEV_LOG GH_STUB_ISSUES_DIR
    unset GH_STUB_DEPS_FIXTURE GH_STUB_DEPS_FAIL
    export PATH="$WORK/bin:$PATH"
    unset DEVFLOW_JEV_DISABLE DEVFLOW_JEV_CLASSIFY FAKE_JEV_REASON
}

# fixture <path> <title> <body> [comments_json] [author_login] [updated_at]
fixture() {
    local path="$1" title="$2" body="$3" comments="${4:-[]}" author="${5:-reporter}" updated="${6:-}"
    jq -n --arg title "$title" --arg body "$body" --argjson comments "$comments" --arg author "$author" --arg updated "$updated" \
        '{title: $title, state: "open", body: $body, labels: [], assignees: [], milestone: null, comments: $comments, author: {login: $author}}
         + (if $updated == "" then {} else {updatedAt: $updated} end)' \
        >"$path"
}

# comment <author> <association> <body>
comment() {
    jq -n --arg a "$1" --arg s "$2" --arg b "$3" '{author: {login: $a}, authorAssociation: $s, createdAt: "2026-01-01T00:00:00Z", body: $b}'
}

run_analyze() {
    export GH_STUB_FIXTURE="$1"
    shift
    run "$SCRIPT" --issue 7 "$@"
}

AC_BODY="## 概要

説明。

## 受け入れ基準

- [ ] AC one
- [ ] AC two"

jev_calls() { grep -c '^call$' "$JEV_LOG" || true; }

# ---- contract 経路（Jev 不要）----

@test "contract 経路: AC あり・comment 無し・breaking 無し -> ok, analyze_path=contract, Jev 未呼び出し" {
    fixture "$WORK/i.json" "feat: add button" "$AC_BODY"
    run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true and .analyze_path == "contract" and .jev_reasons == []'
    echo "$output" | jq -e '.acceptance_criteria == ["AC one", "AC two"] and .issue_type == "feat" and .issue_title == "feat: add button"'
    echo "$output" | jq -e '.breaking_change == false and .breaking_keyword_scan == false and .comment_overrides == [] and .comment_conflicts == [] and .uncertain == []'
    echo "$output" | jq -e '(.issue_body | type) == "string" and .issue_body_truncated == false and .comment_count == 0 and .contract == "t1"'
    echo "$output" | jq -e '.ac_observational == [false, false] and .ac_observational_evidence == ["正規表現の絞り込みに当たらない", "正規表現の絞り込みに当たらない"]'
    [ "$(jev_calls)" -eq 0 ]
}

@test "AC 見出し無し -> ok:true で acceptance_criteria は空（ゲート判定は Workflow 側）" {
    fixture "$WORK/i.json" "feat: add button" "本文のみ"
    run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true and .acceptance_criteria == [] and .contract == "none"'
}

@test "--repo は analyze-issue 経由で gh に渡る" {
    fixture "$WORK/i.json" "feat: x" "$AC_BODY"
    run_analyze "$WORK/i.json" --repo acme/skills
    [ "$status" -eq 0 ]
    grep -q -- '--repo acme/skills' "$GH_LOG"
}

@test "gh 到達不能 -> ok:false + reason（exit 0）" {
    fixture "$WORK/i.json" "feat: x" "$AC_BODY"
    GH_STUB_FAIL="HTTP 502: bad gateway" run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == false and (.reason | test("bad gateway")) and .analyze_path == "contract"'
}

@test "analyze-issue が JSON 以外を返す -> ok:false + reason" {
    printf 'not json' >"$WORK/i.json"
    run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == false and (.reason | length) > 0'
}

# ---- blockers（issue #744）----

# deps_fixture <number> <state>...: dependencies API（blocked_by）の応答を組む（acme/skills の issue）
deps_fixture() {
    local items='[]'
    while [[ $# -ge 2 ]]; do
        items="$(jq -c --argjson n "$1" --arg s "$2" '. + [{id: (9000 + $n), number: $n, state: $s, html_url: "https://github.com/acme/skills/issues/\($n)", repository_url: "https://api.github.com/repos/acme/skills"}]' <<<"$items")"
        shift 2
    done
    printf '%s' "$items" >"$WORK/deps.json"
    export GH_STUB_DEPS_FIXTURE="$WORK/deps.json"
}

# issue_fixture <repo> <number> <STATE>: 本文の Blocked by で参照される issue の `gh issue view` 応答
issue_fixture() {
    jq -n --arg r "$1" --argjson n "$2" --arg s "$3" '{number: $n, state: $s, url: "https://github.com/\($r)/issues/\($n)"}' \
        >"$GH_STUB_ISSUES_DIR/$2.json"
}

# blockers の判定（API と本文 Blocked by の和集合・重複除去・state 正規化・行頭判定・--repo 省略・
# 各取得失敗）は _lib/scripts/issue-blockers.bats が持つ。ここは prerun への配線 1 件と失敗経路 1 件だけを見る。

@test "blockers 配線: issue-blockers の結果（API と、本文 4000 字より後ろの Blocked by）を blockers に載せる" {
    local filler
    filler="$(printf 'x%.0s' $(seq 1 4500))"
    fixture "$WORK/i.json" "feat: x" "$AC_BODY

${filler}

Blocked by #13
- blocked by: other/lib#5, #12"
    deps_fixture 12 open
    issue_fixture acme/skills 12 OPEN
    issue_fixture acme/skills 13 OPEN
    issue_fixture other/lib 5 CLOSED
    run_analyze "$WORK/i.json" --repo acme/skills
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true and .blockers == [
        {repo: "acme/skills", number: 12, state: "OPEN", source: "api", url: "https://github.com/acme/skills/issues/12"},
        {repo: "acme/skills", number: 13, state: "OPEN", source: "body", url: "https://github.com/acme/skills/issues/13"},
        {repo: "other/lib", number: 5, state: "CLOSED", source: "body", url: "https://github.com/other/lib/issues/5"}]'
    grep -qx 'api repos/acme/skills/issues/7/dependencies/blocked_by?per_page=100' "$GH_LOG"
}

@test "blockers: dependencies API の取得失敗 -> ok:false（fail-closed）" {
    fixture "$WORK/i.json" "feat: x" "$AC_BODY"
    GH_STUB_DEPS_FAIL="HTTP 404: Not Found (dependencies)" run_analyze "$WORK/i.json" --repo acme/skills
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == false and (.reason | test("dependencies API") and test("HTTP 404")) and .analyze_path == "contract"'
}

# ---- breaking noul ----

@test "breaking keyword + Jev noul p>=0.9 -> breaking_change=true, analyze_path=jev" {
    fixture "$WORK/i.json" "feat: schema migration" "$AC_BODY

[[jev:noul:0.95]]"
    run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.breaking_keyword_scan == true and .breaking_change == true and .analyze_path == "jev"'
    echo "$output" | jq -e '.jev_reasons == ["breaking_keyword_scan true"] and .uncertain == []'
    echo "$output" | jq -e '.breaking_evidence | test("0.95")'
    [ "$(jev_calls)" -eq 1 ]
}

@test "breaking keyword + Jev noul p<=0.1 -> breaking_change=false, uncertain 空" {
    fixture "$WORK/i.json" "feat: keep compat" "$AC_BODY

breaking を避ける。[[jev:noul:0.04]]"
    run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.breaking_keyword_scan == true and .breaking_change == false and .uncertain == [] and .analyze_path == "jev"'
}

@test "breaking keyword + Jev 低確信（0.1<p<0.9）-> breaking_change=false, uncertain に積む" {
    fixture "$WORK/i.json" "feat: maybe migration" "$AC_BODY

[[jev:noul:0.55]]"
    run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.breaking_change == false and (.uncertain | length) == 1 and (.uncertain[0] | test("breaking_keyword_scan") and test("0.55"))'
}

@test "breaking keyword + Jev 空 stdout（非 JSON 応答）-> uncertain（fail-closed）" {
    fixture "$WORK/i.json" "feat: migration" "$AC_BODY"
    run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.breaking_keyword_scan == true and .breaking_change == false and (.uncertain | length) == 1 and (.uncertain[0] | test("Jev 応答なし（応答不正: bad response"))'
    [ "$(jev_calls)" -eq 1 ]
}

# ---- 互換性判定の 2 問分割（issue #728）----

@test "互換性判定は breaking / migration の 2 問を 1 request で聞き、読み込み時破棄を後方互換・変換不要と明示する" {
    fixture "$WORK/i.json" "feat: migration" "$AC_BODY

[[jev:noul:0.02]]"
    run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    [ "$(jev_calls)" -eq 1 ]
    jq -e 'keys == ["breaking", "migration"] and .breaking.type == "noul" and .migration.type == "noul"' "$JEV_LOG.questions"
    jq -e '.breaking.instructions | test("後方互換") and test("読み込み時に無視・破棄")' "$JEV_LOG.questions"
    jq -e '.migration.instructions | test("既存データ") and test("読み込み時に無視・破棄")' "$JEV_LOG.questions"
}

@test "設定項目を削除し古い値は読み込み時に捨てる issue -> 互換性判定で uncertain にならない（breaking_change=false）" {
    fixture "$WORK/i.json" "feat: 設定項目 legacy_mode を削除する" "## 概要

設定項目 legacy_mode を削除する。古い値は読み込み時に捨てるので、既存の設定ファイルはそのまま読める。
既存データの変換（migration）は不要。

## 受け入れ基準

- [ ] legacy_mode を読まない
- [ ] 古い設定ファイルに legacy_mode があっても読み込みが成功する

[[jev:breaking:0.06]] [[jev:migration:0.03]]"
    run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.breaking_keyword_scan == true and .analyze_path == "jev"'
    echo "$output" | jq -e '.breaking_change == false and .uncertain == [] and .comment_conflicts == []'
}

@test "互換性判定: どちらか一方が p>=0.9 -> breaking_change=true（根拠に両方の p）" {
    fixture "$WORK/i.json" "feat: migration" "$AC_BODY

[[jev:breaking:0.04]] [[jev:migration:0.97]]"
    run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.breaking_change == true and .uncertain == []'
    echo "$output" | jq -e '.breaking_evidence | test("p=0.04") and test("p=0.97")'
}

@test "互換性判定: 片方だけ低確信 -> uncertain に両方の p、明記の指示文は breaking キーワードを含まない" {
    fixture "$WORK/i.json" "feat: migration" "$AC_BODY

[[jev:breaking:0.62]] [[jev:migration:0.03]]"
    run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.breaking_change == false and (.uncertain | length) == 1 and (.uncertain[0] | test("p=0.62") and test("p=0.03"))'
    # 指示どおり body に書いた語で analyze-issue.sh のキーワード判定（breaking|incompatible|migration|破壊的|非互換）に
    # 再び掛からないこと
    echo "$output" | jq -e '.uncertain[0] | split("— ")[1] | (test("明記せよ") and (test("breaking|incompatible|migration|破壊的|非互換"; "i") | not))'
}

# ---- 確率値の型と範囲（issue #940）----

@test "互換性判定: Jev の noul が true（数値でない）-> 判定値なしとして uncertain に積む（no に倒さない）" {
    fixture "$WORK/i.json" "feat: migration" "$AC_BODY

[[jev:noul:true]]"
    run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.breaking_keyword_scan == true and .breaking_change == false and (.uncertain | length) == 1 and (.uncertain[0] | test("breaking_keyword_scan") and test("Jev 応答なし"))'
}

@test "互換性判定: noul が false / null / 文字列 / 範囲外 -> どれも uncertain（yes にも no にも倒さない）" {
    for p in false null '"0.95"' 1.5 -0.5; do
        fixture "$WORK/i.json" "feat: migration" "$AC_BODY

[[jev:noul:${p}]]"
        run_analyze "$WORK/i.json"
        [ "$status" -eq 0 ]
        echo "$output" | jq -e '.breaking_change == false and (.uncertain | length) == 1 and (.uncertain[0] | test("Jev 応答なし"))' \
            || { echo "noul=${p}: $output"; false; }
    done
}

@test "comment: 選んだ選択肢の確率が true / 範囲外 -> uncertain（override・conflict に振り分けない）" {
    fixture "$WORK/i.json" "feat: x" "$AC_BODY" "[$(comment reporter NONE 'a [[jev:override:true]]'), $(comment reporter NONE 'b [[jev:override:1.5]]')]" reporter
    run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.comment_overrides == [] and .comment_conflicts == [] and (.uncertain | length) == 2 and (.uncertain[0] | test("comment #1") and test("Jev 応答なし")) and (.uncertain[1] | test("comment #2"))'
}

# ---- Jev が判定を返さない理由（issue #728）----

# jev_reason_label <reason> <見出し>: クライアントの reason 1 行が uncertain に見出し付きでそのまま載る
jev_reason_label() {
    fixture "$WORK/i.json" "feat: migration" "$AC_BODY

[[jev:noul:0.95]]"
    FAKE_JEV_REASON="$1" run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e --arg label "$2" --arg reason "$1" \
        '(.uncertain | length) == 1 and (.uncertain[0] | contains("Jev 応答なし（" + $label + ": " + $reason + "）"))'
}

@test "クライアントの失敗理由ごとに uncertain の見出しが付く（Keychain / 鍵なし / timeout / 通信失敗 / broker）" {
    jev_reason_label 'keychain unreachable (security exit 36: errSecInteractionNotAllowed)' 'Keychain に届かない（ロック中・sandbox 内・bg job など別セッション）'
    jev_reason_label 'keychain read failed (security exit 51)' 'Keychain から API 鍵を読めない'
    jev_reason_label "no API key (keychain item 'x' not found: security exit 44)" 'API 鍵が無い'
    jev_reason_label 'timeout (curl exit 28, --max-time 10s)' 'タイムアウト（DEVFLOW_JEV_MAX_TIME）'
    jev_reason_label 'request failed (curl exit 7): x' '通信失敗'
    jev_reason_label 'broker unreachable (curl exit 7 on /s); keychain unreachable (security exit 36)' 'jev-broker に接続できない'
    jev_reason_label 'broker request failed (curl exit 22): x' 'jev-broker 経由の呼び出し失敗'
}

@test "comment の判定でも失敗理由が comment ごとの uncertain に載る" {
    fixture "$WORK/i.json" "feat: x" "$AC_BODY" "[$(comment alice OWNER 'a [[jev:override:0.99]]')]" reporter
    FAKE_JEV_REASON='keychain read failed (security exit 51)' run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.comment_conflicts == [] and (.uncertain | length) == 1 and (.uncertain[0] | test("comment #1 by alice") and test("Keychain から API 鍵を読めない") and test("security exit 51"))'
}

@test "jev-classify が PATH に無い -> Jev 未導入として uncertain（fail-closed）" {
    fixture "$WORK/i.json" "feat: migration" "$AC_BODY

[[jev:noul:0.95]]"
    DEVFLOW_JEV_CLASSIFY=jev-classify-not-installed run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.breaking_change == false and (.uncertain | length) == 1 and (.uncertain[0] | test("jev-classify が PATH に無い（Jev 未導入）") and test("jev-classify-not-installed not on PATH"))'
    [ "$(jev_calls)" -eq 0 ]
}

@test "title の ! marker -> 決定論で breaking_change=true（Jev 未呼び出し）" {
    fixture "$WORK/i.json" "feat!: drop v1" "$AC_BODY"
    run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.breaking_change == true and (.breaking_evidence | test("!")) and .uncertain == [] and .analyze_path == "contract"'
    [ "$(jev_calls)" -eq 0 ]
}

@test "DEVFLOW_JEV_DISABLE=1 -> Jev を呼ばず breaking 判定は uncertain" {
    fixture "$WORK/i.json" "feat: migration" "$AC_BODY

[[jev:noul:0.99]]"
    DEVFLOW_JEV_DISABLE=1 run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.breaking_change == false and (.uncertain | length) == 1 and (.uncertain[0] | test("DEVFLOW_JEV_DISABLE=1"))'
    [ "$(jev_calls)" -eq 0 ]
}

@test "Jev の --max-time は DEVFLOW_JEV_MAX_TIME（既定 10 秒）" {
    fixture "$WORK/i.json" "feat: migration" "$AC_BODY

[[jev:noul:0.95]]"
    run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    grep -q '^max-time=10$' "$JEV_LOG"
    : >"$JEV_LOG"
    DEVFLOW_JEV_MAX_TIME=25 run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    grep -q '^max-time=25$' "$JEV_LOG"
}

# ---- comment choice 3 分岐 × 権限 2 分岐 ----

@test "comment override × 報告者本人 -> comment_overrides" {
    fixture "$WORK/i.json" "feat: x" "$AC_BODY" "[$(comment reporter NONE '訂正: 30 箇所 [[jev:override:0.97]]')]" reporter
    run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.analyze_path == "jev" and .jev_reasons == ["comments present (1)"]'
    echo "$output" | jq -e '(.comment_overrides | length) == 1 and (.comment_overrides[0] | startswith("override:") and test("reporter") and test("訂正: 30 箇所")) and .comment_conflicts == [] and .uncertain == []'
}

@test "comment override × OWNER/MEMBER/COLLABORATOR -> comment_overrides" {
    fixture "$WORK/i.json" "feat: x" "$AC_BODY" "[$(comment alice OWNER 'A [[jev:override:0.95]]'), $(comment bob MEMBER 'B [[jev:override:0.95]]'), $(comment carol COLLABORATOR 'C [[jev:override:0.95]]')]" reporter
    run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '(.comment_overrides | length) == 3 and .comment_conflicts == []'
}

@test "comment override × 権限なし（NONE・非報告者）-> comment_conflicts（fail-closed）" {
    fixture "$WORK/i.json" "feat: x" "$AC_BODY" "[$(comment mallory NONE 'X ではなく Y [[jev:override:0.97]]')]" reporter
    run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.comment_overrides == [] and (.comment_conflicts | length) == 1 and (.comment_conflicts[0] | startswith("override（権限なし") and test("mallory"))'
}

@test "comment conflict × 権限あり / なし -> どちらも comment_conflicts" {
    fixture "$WORK/i.json" "feat: x" "$AC_BODY" "[$(comment alice OWNER 'hmm [[jev:conflict:0.93]]'), $(comment mallory NONE 'hmm2 [[jev:conflict:0.93]]')]" reporter
    run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.comment_overrides == [] and (.comment_conflicts | length) == 2 and all(.comment_conflicts[]; startswith("conflict:"))'
}

@test "comment unrelated（高確信）× 権限あり / なし -> どちらにも積まない" {
    fixture "$WORK/i.json" "feat: x" "$AC_BODY" "[$(comment alice OWNER '了解 [[jev:unrelated:0.98]]'), $(comment mallory NONE 'thanks [[jev:unrelated:0.98]]')]" reporter
    run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.comment_overrides == [] and .comment_conflicts == [] and .uncertain == [] and .analyze_path == "jev"'
    [ "$(jev_calls)" -eq 2 ]
}

@test "comment の未決事項が本文で決着済み（resolved 高確信）-> comment_conflicts にも overrides にも積まない（issue #728）" {
    fixture "$WORK/i.json" "feat: 通知の再送間隔" "## 概要

通知の再送間隔を設定可能にする。

## 決定事項

再送間隔の既定値は 30 分とする（comment で挙がった 15 分 / 30 分の未決事項はこの本文で決着済み）。

## 受け入れ基準

- [ ] 再送間隔の既定値が 30 分
- [ ] 設定で再送間隔を変えられる" \
        "[$(comment alice OWNER '既定値は 15 分と 30 分のどちらにしますか？未決です。[[jev:resolved:0.96]]')]" reporter "2026-01-02T00:00:00Z"
    run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.analyze_path == "jev" and .comment_conflicts == [] and .comment_overrides == [] and .uncertain == []'
    # choice に resolved があり、state に前後関係（issue updated_at > 最新 comment created_at）が載る
    tail -n 1 "$JEV_LOG.questions" | jq -e '.kind.criteria | keys == ["conflict", "override", "resolved", "unrelated"]'
    grep -q 'issue の updated_at: 2026-01-02T00:00:00Z' "$JEV_LOG.state"
    grep -q '最新 comment の created_at: 2026-01-01T00:00:00Z' "$JEV_LOG.state"
    grep -q 'issue は最新 comment より後に更新されている' "$JEV_LOG.state"
}

@test "comment 後に issue が更新されていない -> state に「後に更新されている」行を載せない" {
    fixture "$WORK/i.json" "feat: x" "$AC_BODY" "[$(comment alice OWNER 'q [[jev:unrelated:0.98]]')]" reporter "2026-01-01T00:00:00Z"
    run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    grep -q 'issue の updated_at: 2026-01-01T00:00:00Z' "$JEV_LOG.state"
    ! grep -q 'issue は最新 comment より後に更新されている' "$JEV_LOG.state"
}

@test "comment resolved でも低確信（p<0.9）-> comment_conflicts（fail-closed）" {
    fixture "$WORK/i.json" "feat: x" "$AC_BODY" "[$(comment alice OWNER 'q [[jev:resolved:0.55]]')]" reporter
    run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '(.comment_conflicts | length) == 1 and (.comment_conflicts[0] | startswith("low-confidence（resolved p=0.55"))'
}

@test "comment 低確信（p<0.9）-> choice に関わらず comment_conflicts（fail-closed）" {
    fixture "$WORK/i.json" "feat: x" "$AC_BODY" "[$(comment alice OWNER 'a [[jev:unrelated:0.6]]'), $(comment alice OWNER 'b [[jev:override:0.7]]')]" reporter
    run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.comment_overrides == [] and (.comment_conflicts | length) == 2 and all(.comment_conflicts[]; startswith("low-confidence（"))'
}

@test "comment で Jev 空 stdout -> uncertain（fail-closed）" {
    fixture "$WORK/i.json" "feat: x" "$AC_BODY" "[$(comment alice OWNER 'no marker here')]" reporter
    run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.comment_overrides == [] and .comment_conflicts == [] and (.uncertain | length) == 1 and (.uncertain[0] | test("comment #1 by alice") and test("Jev 応答なし"))'
}

@test "DEVFLOW_JEV_DISABLE=1 で comments あり -> 全 comment が uncertain、Jev 未呼び出し" {
    fixture "$WORK/i.json" "feat: x" "$AC_BODY" "[$(comment alice OWNER 'a [[jev:override:0.99]]'), $(comment bob NONE 'b [[jev:unrelated:0.99]]')]" reporter
    DEVFLOW_JEV_DISABLE=1 run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '(.uncertain | length) == 2 and all(.uncertain[]; test("DEVFLOW_JEV_DISABLE=1")) and .analyze_path == "jev"'
    [ "$(jev_calls)" -eq 0 ]
}

@test "breaking keyword + comments 同時 -> jev_reasons に両方、判定は独立" {
    fixture "$WORK/i.json" "feat: migration" "$AC_BODY

[[jev:noul:0.95]]" "[$(comment reporter NONE '訂正 [[jev:override:0.95]]')]" reporter
    run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.jev_reasons == ["breaking_keyword_scan true", "comments present (1)"]'
    echo "$output" | jq -e '.breaking_change == true and (.comment_overrides | length) == 1'
}

@test "Jev は常に --redact と --reason-file 付きで呼ぶ（breaking / comment / 観測型 AC の全経路）" {
    # AC-3 は観測型の絞り込みに当たる（APP_REPO_REGRESSION_ACS の table-4）
    fixture "$WORK/i.json" "feat: migration" "$AC_BODY
- [ ] 実行ログに 1 件以上記録される

[[jev:noul:0.95]]" "[$(comment reporter NONE '訂正 [[jev:override:0.95]]')]" reporter
    run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.jev_reasons == ["breaking_keyword_scan true", "comments present (1)", "observational_ac prefilter hit (AC-3)"]'
    [ "$(jev_calls)" -eq 3 ]
    [ "$(wc -l <"$JEV_LOG.argv")" -eq 3 ]
    [ "$(grep -c -- '--redact' "$JEV_LOG.argv")" -eq 3 ]
    [ "$(grep -c -- '--reason-file ' "$JEV_LOG.argv")" -eq 3 ]
}

# ---- 観測型 AC（issue #859）: 正規表現の絞り込み → Jev ----
# 対照 AC は _lib/test-helpers/observational-ac-controls.mjs（vitest と共有）を node で読む。
# Jev の応答は title に埋めたマーカー（質問 id は ac_<n>）で AC ごとに固定する。

CONTROLS="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)/_lib/test-helpers/observational-ac-controls.mjs"

# controls_json <JS 式>: controls module を m として import し、式の値を JSON で出す
controls_json() {
    node --input-type=module -e "const { pathToFileURL } = await import('node:url'); const m = await import(pathToFileURL(process.argv[1]).href); process.stdout.write(JSON.stringify($1))" "$CONTROLS"
}

# ac_body: stdin の AC 配列（JSON）から受け入れ基準つきの issue 本文を組む
ac_body() {
    jq -r '"## 概要\n\n説明。\n\n## 受け入れ基準\n\n" + (map("- [ ] " + .) | join("\n"))'
}

REG_MARKERS="[[jev:ac_2:0.04]] [[jev:ac_3:0.5]] [[jev:ac_4:0.96]] [[jev:ac_5:0.03]]"

@test "観測型 AC の positive / negative control（issue #844）: 絞り込み + Jev スタブで positive は全て true、negative は全て false" {
    ACS="$(controls_json '[...Object.values(m.KNOWN_OBSERVATIONAL_ACS), ...Object.values(m.NON_OBSERVATIONAL_ACS)]')"
    NPOS="$(controls_json 'Object.keys(m.KNOWN_OBSERVATIONAL_ACS).length')"
    # Jev は positive（AC-1..AC-NPOS）にだけ観測型 p=0.97、それ以外に聞かれたら p=0.03 を返す
    MARKERS="$(jq -rn --argjson n "$NPOS" '[range(1; $n + 1) | "[[jev:ac_\(.):0.97]]"] | join(" ")') [[jev:noul:0.03]]"
    fixture "$WORK/i.json" "test: controls ${MARKERS}" "$(printf '%s' "$ACS" | ac_body)"
    run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e --argjson acs "$ACS" '.acceptance_criteria == $acs'
    echo "$output" | jq -e --argjson n "$NPOS" '(.ac_observational | length) == ($n + 5) and (.ac_observational[:$n] | all(. == true)) and (.ac_observational[$n:] | all(. == false))'
    echo "$output" | jq -e --argjson n "$NPOS" 'all(.ac_observational_evidence[:$n][]; test("Jev noul 観測型 p=0.97"))'
    echo "$output" | jq -e '.uncertain == [] and .analyze_path == "jev"'
    [ "$(jev_calls)" -eq 1 ]
}

@test "観測型 AC の回帰（acme/webapp）: 絞り込みに当たった AC だけを title と AC 文面で 1 request に聞き、Jev の p で true / false / null に振り分ける" {
    ACS="$(controls_json 'm.APP_REPO_REGRESSION_ACS.map((r) => r.ac)')"
    fixture "$WORK/i.json" "test(video): 件数の直書きを整理 ${REG_MARKERS}" "$(printf '%s' "$ACS" | ac_body)"
    run_analyze "$WORK/i.json" --repo acme/webapp
    [ "$status" -eq 0 ]
    echo "$output" | jq -e --argjson acs "$ACS" '.acceptance_criteria == $acs'
    # 本番コード… = 絞り込みに当たらない / ログの件数表示 p=0.04 / エラー件数… 低確信 / 1 件以上記録 p=0.96 / #104 AC#2 p=0.03
    echo "$output" | jq -e '.ac_observational == [false, false, null, true, false]'
    echo "$output" | jq -e '.ac_observational_evidence[0] == "正規表現の絞り込みに当たらない" and (.ac_observational_evidence[1] | test("p=0.04")) and (.ac_observational_evidence[2] | test("低確信") and test("p=0.5") and test("分類 agent")) and (.ac_observational_evidence[3] | test("p=0.96"))'
    echo "$output" | jq -e '.jev_reasons == ["observational_ac prefilter hit (AC-2, AC-3, AC-4, AC-5)"] and .analyze_path == "jev"'
    echo "$output" | jq -e '.uncertain == [] and .comment_conflicts == []' # null は needs_clarification にしない
    [ "$(jev_calls)" -eq 1 ]
    jq -e '(keys | sort) == ["ac_2", "ac_3", "ac_4", "ac_5"] and all(.[]; .type == "noul")' "$JEV_LOG.questions"
    jq -e '.ac_5.instructions | test("AC-5") and test("コードとテストを読むだけでは確かめられず、実行した結果・ログ・計測を観測しないと確かめられないか") and test("テストコードやソースコード自体の書き方・構成について述べているなら no")' "$JEV_LOG.questions"
    # state は title と当たった AC の文面だけ（当たらない AC と本文は送らない）
    grep -q 'AC-5: 件数の直書きを、元データ（GUIDE_SLUGS 等）の長さとの比較か、件数に依存しない不変条件に置き換える' "$JEV_LOG.state"
    ! grep -q '本番コードは変更しない' "$JEV_LOG.state" || false
    ! grep -q '説明。' "$JEV_LOG.state" || false
}

@test "観測型 AC: Jev が応答しない（bg セッション等）-> 当たった AC は null（uncertain には積まない）、理由を根拠に載せる" {
    ACS="$(controls_json 'm.APP_REPO_REGRESSION_ACS.map((r) => r.ac)')"
    fixture "$WORK/i.json" "test(video): 件数の直書きを整理" "$(printf '%s' "$ACS" | ac_body)"
    FAKE_JEV_REASON='timeout (curl exit 28, --max-time 10s)' run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ac_observational == [false, null, null, null, null] and .uncertain == []'
    echo "$output" | jq -e 'all(.ac_observational_evidence[1:][]; test("Jev 応答なし") and test("タイムアウト") and test("分類 agent"))'
}

@test "観測型 AC: Jev の noul が true / 文字列（数値でない）-> 当たった AC は null（false に倒さない、issue #940）" {
    ACS="$(controls_json 'm.APP_REPO_REGRESSION_ACS.map((r) => r.ac)')"
    fixture "$WORK/i.json" "test(video): 件数の直書きを整理 [[jev:ac_2:true]] [[jev:ac_3:\"0.95\"]] [[jev:ac_4:0.96]] [[jev:ac_5:true]]" "$(printf '%s' "$ACS" | ac_body)"
    run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ac_observational == [false, null, null, true, null] and .uncertain == []'
    echo "$output" | jq -e '[.ac_observational_evidence[1, 2, 4]] | all(test("Jev 応答なし") and test("分類 agent"))'
}

@test "観測型 AC: DEVFLOW_JEV_DISABLE=1 -> Jev を呼ばず当たった AC は null" {
    ACS="$(controls_json 'm.APP_REPO_REGRESSION_ACS.map((r) => r.ac)')"
    fixture "$WORK/i.json" "test(video): 件数の直書きを整理 ${REG_MARKERS}" "$(printf '%s' "$ACS" | ac_body)"
    DEVFLOW_JEV_DISABLE=1 run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ac_observational == [false, null, null, null, null] and .uncertain == []'
    echo "$output" | jq -e 'all(.ac_observational_evidence[1:][]; test("DEVFLOW_JEV_DISABLE=1"))'
    [ "$(jev_calls)" -eq 0 ]
}

@test "観測型 AC: 正規表現の絞り込みが実行できない（node 失敗）-> 全 AC を null にして分類 agent に回す" {
    ACS="$(controls_json 'm.APP_REPO_REGRESSION_ACS.map((r) => r.ac)')"
    fixture "$WORK/i.json" "test(video): 件数の直書きを整理 ${REG_MARKERS}" "$(printf '%s' "$ACS" | ac_body)"
    printf '#!/usr/bin/env bash\necho "node: broken" >&2\nexit 1\n' >"$WORK/bin/node"
    chmod +x "$WORK/bin/node"
    run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true and .ac_observational == [null, null, null, null, null] and .uncertain == []'
    echo "$output" | jq -e 'all(.ac_observational_evidence[]; test("正規表現の絞り込みを実行できない") and test("node: broken"))'
    [ "$(jev_calls)" -eq 0 ]
}

# path_without_node: PATH のうち node を持つ dir だけを、node 以外の symlink を並べた影 dir に差し替えた PATH
path_without_node() {
    local dir entry shadow n=0 out=""
    local -a dirs
    IFS=: read -r -a dirs <<<"$PATH"
    for dir in "${dirs[@]}"; do
        if [[ -n "$dir" && -e "$dir/node" ]]; then
            n=$((n + 1))
            shadow="$WORK/no-node-path/$n"
            mkdir -p "$shadow"
            for entry in "$dir"/*; do
                [[ "$(basename "$entry")" == "node" ]] && continue
                ln -s "$entry" "$shadow/$(basename "$entry")"
            done
            dir="$shadow"
        fi
        out="${out:+$out:}$dir"
    done
    printf '%s' "$out"
}

@test "観測型 AC: PATH に node が無い -> uncertain に node を実行できない旨を積み、全 AC を null（確定させない、issue #1048）" {
    fixture "$WORK/i.json" "feat: add button" "$AC_BODY"
    NO_NODE_PATH="$(path_without_node)"
    ! PATH="$NO_NODE_PATH" command -v node || false
    PATH="$NO_NODE_PATH" run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true and .acceptance_criteria == ["AC one", "AC two"]'
    # analyze ゲートが needs_clarification に倒す入力: node を実行できないことを示す uncertain が 1 件以上
    echo "$output" | jq -e '[.uncertain[] | select(test("node"))] | length >= 1'
    echo "$output" | jq -e '.uncertain[0] | test("node を実行できない")'
    # 各 AC は true / false に確定させない（分類 agent が確定済みとして扱わない）
    echo "$output" | jq -e '(.ac_observational | length) == 2 and all(.ac_observational[]; . != true and . != false)'
    echo "$output" | jq -e 'all(.ac_observational_evidence[]; test("node を実行できない"))'
    [ "$(jev_calls)" -eq 0 ]
}

# ---- 引数 ----

@test "--issue 欠落 / 非数値 -> exit 2" {
    run "$SCRIPT"
    [ "$status" -eq 2 ]
    run "$SCRIPT" --issue abc
    [ "$status" -eq 2 ]
}
