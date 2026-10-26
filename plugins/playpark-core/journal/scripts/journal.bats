#!/usr/bin/env bats
# Tests for journal/scripts/journal.sh
# Focus: cmd_log の entry 組み立て（telemetry は --telemetry-json だけで受ける）と query / stats / error category。

setup() {
    SKILLS_REPO="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
    SCRIPT="$SKILLS_REPO/journal/scripts/journal.sh"

    # Isolate journal output to a temp directory for each test
    export CLAUDE_JOURNAL_DIR="$BATS_TMPDIR/journal-$$"
    mkdir -p "$CLAUDE_JOURNAL_DIR"
}

teardown() {
    rm -rf "$CLAUDE_JOURNAL_DIR"
}

# Helper: get the most recently written journal JSON file
latest_entry() {
    # Find the most recent .json file in CLAUDE_JOURNAL_DIR
    ls -t "$CLAUDE_JOURNAL_DIR"/*.json 2>/dev/null | head -n 1
}

# dev-flow / pr-iterate が書く telemetry キーの例（キー一覧は dev-flow/references/telemetry.md）
KEPT_TELEMETRY='{
  "plugin_commit": "0123456789ab",
  "plugin_version": "1.2.3",
  "shape": "standard",
  "route": "full",
  "duration_seconds": 840,
  "phase_durations": {"implement": 300, "validate": 60},
  "merge_tier": "REVIEW",
  "iterate_status": "lgtm",
  "eval_verdict": "pass",
  "eval_model_config": "opus",
  "impl_model_config": "opus",
  "review_model_config": "opus"
}'

# ---------------------------------------------------------------------------
# telemetry 未指定 -> entry に telemetry キーが無い
# ---------------------------------------------------------------------------
@test "no --telemetry-json -> no telemetry key in entry" {
    run "$SCRIPT" log dev-flow success
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    has_telemetry=$(jq 'has("telemetry")' "$entry_file")
    [ "$has_telemetry" = "false" ]
}

# ---------------------------------------------------------------------------
# 残す 12 キーを --telemetry-json で渡すと、そのまま entry の telemetry になる
# ---------------------------------------------------------------------------
@test "--telemetry-json: 残す 12 キーがそのまま telemetry に入る" {
    run "$SCRIPT" log dev-flow success --telemetry-json "$KEPT_TELEMETRY"
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    same=$(jq --argjson want "$KEPT_TELEMETRY" '.telemetry == $want' "$entry_file")
    [ "$same" = "true" ]
    [ "$(jq '.telemetry | keys | length' "$entry_file")" = "12" ]
}

# ---------------------------------------------------------------------------
# plugin_commit が null の run も JSON null のまま記録される
# ---------------------------------------------------------------------------
@test "--telemetry-json: plugin_commit null は JSON null のまま記録される" {
    tel=$(jq -c '.plugin_commit = null' <<<"$KEPT_TELEMETRY")
    run "$SCRIPT" log pr-iterate success --telemetry-json "$tel"
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    [ "$(jq '.telemetry | has("plugin_commit")' "$entry_file")" = "true" ]
    [ "$(jq '.telemetry.plugin_commit' "$entry_file")" = "null" ]
    same=$(jq --argjson want "$tel" '.telemetry == $want' "$entry_file")
    [ "$same" = "true" ]
}

# ---------------------------------------------------------------------------
# 撤去した per-key telemetry flag は受け付けない（Unknown option で error）
# ---------------------------------------------------------------------------
@test "撤去した per-key telemetry flag: journal.sh log に渡すと Unknown option で error になる" {
    for flag in \
        --merge-tier --gate-policy --danger-hits --shape --eval-iter --eval-verdict \
        --iterate-status --eval-staleness --ci-wait-seconds --ci-poll-attempts \
        --vdelta-verdicts --vdelta-fail-open --redgreen-deny --testsurf-hits \
        --duration-seconds --phase-durations --merge-tier-reasons --route \
        --subagent-invocations --guard-id --eval-confidence --review-confidence --review-decision; do
        run "$SCRIPT" log dev-flow success "$flag" x
        [ "$status" -ne 0 ]
        [[ "$output" == *"Unknown option: $flag"* ]]
    done
}

# ---------------------------------------------------------------------------
# journal.sh の option 分岐に telemetry キー個別の flag が残っていない（静的 pin）
# 受け付ける option は entry の基本項目・context・error・recovery と --telemetry-json だけ
# ---------------------------------------------------------------------------
@test "journal.sh log の option は --telemetry-json 以外に telemetry 用 flag を持たない" {
    run bash -c "sed -n '/^cmd_log()/,/^}/p' '$SCRIPT' | grep -oE '^ +--[a-z-]+\)' | tr -d ' )' | sort"
    [ "$status" -eq 0 ]
    expected=$(printf '%s\n' \
        --args --context --duration-turns --error-category --error-msg --error-phase \
        --issue --mode --pr-number --project --recovery --recovery-turns --repo \
        --telemetry-json --worktree | sort)
    [ "$output" = "$expected" ]
}

# ===========================================================================
# Tests for new features: source field, atomic write, --source filter, iconv
# ===========================================================================

# ---------------------------------------------------------------------------
# Test (a): log で書いたエントリに source == "skill" がある
# ---------------------------------------------------------------------------
@test "log entry has source == skill" {
    run "$SCRIPT" log test-skill success
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    source_val=$(jq -r '.source' "$entry_file")
    [ "$source_val" = "skill" ]
}

# ---------------------------------------------------------------------------
# Test (b): hook-capture で書いたエントリに source == "hook" がある
# ---------------------------------------------------------------------------
@test "hook-capture entry has source == hook" {
    run bash -c 'printf "%s" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"x\"},\"error\":\"boom error\",\"session_id\":\"s1\"}" | '"$SCRIPT"' hook-capture'
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    source_val=$(jq -r '.source' "$entry_file")
    [ "$source_val" = "hook" ]
}

# ---------------------------------------------------------------------------
# pipe buffer（64KB）を超える入力でも、早く終わる reader（grep -q / head）の SIGPIPE で
# 分類を誤ったり hook-capture が落ちたりしない
# ---------------------------------------------------------------------------

# hook-capture 経由だと classify_error には 3 行 × 300 文字の snippet しか届かないので、
# 関数定義だけを切り出して journal.sh と同じ set -euo pipefail の下で呼ぶ
classify_error_of_file() {
    local fn_file="$BATS_TEST_TMPDIR/classify_error.sh"
    sed -n '/^classify_error() {/,/^}/p' "$SCRIPT" > "$fn_file"
    bash -c 'set -euo pipefail; source "$1"; classify_error "$(<"$2")"' _ "$fn_file" "$1"
}

# error に $1 のファイル内容を入れた PostToolUseFailure payload で hook-capture を走らせる
hook_capture_with_error_file() {
    local payload="$BATS_TEST_TMPDIR/payload.json"
    jq -n --rawfile e "$1" \
        '{tool_name: "Bash", tool_input: {command: "x"}, error: $e, session_id: "s1"}' > "$payload"
    run bash -c "'$SCRIPT' hook-capture < '$payload'"
}

@test "classify_error: 1 行目が lint に一致し後ろに 64KB 超が続いても lint を返す" {
    msg_file="$BATS_TEST_TMPDIR/msg.txt"
    { echo "eslint error x"; awk 'BEGIN { for (i = 0; i < 4000; i++) printf "filler line %05d\n", i }'; } > "$msg_file"
    [ "$(wc -c < "$msg_file")" -gt 65536 ]

    run classify_error_of_file "$msg_file"
    [ "$status" -eq 0 ]
    [ "$output" = "lint" ]
}

# 100KB 程度では grep が入力を読み切ってから終わり SIGPIPE が再現しないので、数 MB にする
@test "hook-capture: 一致行を多数含む数 MB の error でも 1 件記録し、message は一致行の先頭 3 行（各 300 文字まで）" {
    err_file="$BATS_TEST_TMPDIR/err.txt"
    long_line="error $(printf 'x%.0s' $(seq 1 400))"
    {
        echo "header without keyword"
        echo "$long_line"
        awk 'BEGIN { for (i = 0; i < 200000; i++) printf "error line %06d\n", i }'
    } > "$err_file"
    [ "$(wc -c < "$err_file")" -gt 3000000 ]

    hook_capture_with_error_file "$err_file"
    [ "$status" -eq 0 ]

    count=$(ls "$CLAUDE_JOURNAL_DIR"/*.json 2>/dev/null | wc -l | tr -d ' ')
    [ "$count" -eq 1 ]

    expected="${long_line:0:300}"$'\n'"error line 000000"$'\n'"error line 000001"
    [ "$(jq -r '.error.message' "$(latest_entry)")" = "$expected" ]
}

@test "hook-capture: 一致行を含まない 64KB 超の error でも 1 件記録し、message は先頭 3 行" {
    err_file="$BATS_TEST_TMPDIR/err.txt"
    awk 'BEGIN { for (i = 0; i < 6000; i++) printf "plain line %05d\n", i }' > "$err_file"
    [ "$(wc -c < "$err_file")" -gt 65536 ]

    hook_capture_with_error_file "$err_file"
    [ "$status" -eq 0 ]

    count=$(ls "$CLAUDE_JOURNAL_DIR"/*.json 2>/dev/null | wc -l | tr -d ' ')
    [ "$count" -eq 1 ]

    expected=$'plain line 00000\nplain line 00001\nplain line 00002'
    [ "$(jq -r '.error.message' "$(latest_entry)")" = "$expected" ]
}

# ---------------------------------------------------------------------------
# Test (c): 同一秒 2 回書き込みで 2 ファイル存在し両方 jq empty を通る
# (現実装: ファイル名衝突で 1 ファイルに上書きされ red)
# ---------------------------------------------------------------------------
@test "concurrent writes in same second produce 2 valid JSON files" {
    # stub date: 引数を無視して固定時刻を返す
    stub_dir="$BATS_TMPDIR/stub-date-$$"
    mkdir -p "$stub_dir"
    cat > "$stub_dir/date" <<'STUB'
#!/usr/bin/env bash
# Stub date: always return fixed timestamp regardless of args
if [[ "$*" == *"+%s"* ]]; then
    echo "1749600000"
else
    echo "2026-06-11T00:00:00Z"
fi
STUB
    chmod +x "$stub_dir/date"

    run bash -c "PATH='$stub_dir:$PATH' '$SCRIPT' log test-skill success"
    [ "$status" -eq 0 ]
    run bash -c "PATH='$stub_dir:$PATH' '$SCRIPT' log test-skill success"
    [ "$status" -eq 0 ]

    # 2 ファイルが存在すること
    count=$(ls "$CLAUDE_JOURNAL_DIR"/*.json 2>/dev/null | wc -l | tr -d ' ')
    [ "$count" -eq 2 ]

    # 両ファイルが valid JSON であること
    for f in "$CLAUDE_JOURNAL_DIR"/*.json; do
        run jq empty "$f"
        [ "$status" -eq 0 ]
    done
}

# ---------------------------------------------------------------------------
# Test (d): 制御文字 regression pin
# --error-msg に制御文字を含む値を渡しても jq empty が通り生制御バイトが無い
# NOTE: jq --arg が既にエスケープするためこのテストは最初から green になる。
#       regression pin として残す（将来の変更で壊れないことを確認するため）。
# ---------------------------------------------------------------------------
@test "regression pin: control chars in error-msg produce valid JSON (jq --arg escapes them)" {
    # $'...' はテストランナー (bash) が展開する
    error_with_ctrl=$'line1\x01\x02\ttab'
    run "$SCRIPT" log test-skill failure \
        --error-category runtime \
        --error-msg "$error_with_ctrl"
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    # ファイルが valid JSON であること
    run jq empty "$entry_file"
    [ "$status" -eq 0 ]

    # 生制御バイト \x01 が含まれていないこと
    raw_ctrl_count=$(LC_ALL=C grep -c $'\x01' "$entry_file" || true)
    [ "$raw_ctrl_count" -eq 0 ]

    # jq -s で複数ファイルをまとめて読めること
    run jq -s '.' "$CLAUDE_JOURNAL_DIR"/*.json
    [ "$status" -eq 0 ]
}

# ---------------------------------------------------------------------------
# Test (e): query --source skill が hook エントリを除外し、source 欠落エントリを含む
# ---------------------------------------------------------------------------
@test "query --source skill excludes hook entries and includes entries without source" {
    # hook エントリを書く
    run bash -c 'printf "%s" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"x\"},\"error\":\"boom error\",\"session_id\":\"s1\"}" | '"$SCRIPT"' hook-capture'
    [ "$status" -eq 0 ]

    # skill エントリを書く
    run "$SCRIPT" log my-skill success
    [ "$status" -eq 0 ]

    # source 欠落エントリを手書きで配置（後方互換確認）
    cat > "$CLAUDE_JOURNAL_DIR/2026-06-11-00-00-01-legacy.json" <<'JSON'
{"version":"1.0.0","id":"20260611T000001-legacy","timestamp":"2026-06-11T00:00:01Z","skill":"legacy","outcome":"success"}
JSON

    run "$SCRIPT" query --source skill
    [ "$status" -eq 0 ]

    # hook エントリが除外されていること（source == "hook" のエントリが結果に無い）
    hook_count=$(echo "$output" | jq '[.[] | select(.source == "hook")] | length')
    [ "$hook_count" -eq 0 ]

    # skill エントリが含まれること
    skill_count=$(echo "$output" | jq '[.[] | select(.source == "skill")] | length')
    [ "$skill_count" -ge 1 ]

    # source 欠落エントリが含まれること（後方互換: source 欠落は skill 扱い）
    legacy_count=$(echo "$output" | jq '[.[] | select(.skill == "legacy")] | length')
    [ "$legacy_count" -eq 1 ]
}

# ---------------------------------------------------------------------------
# Test (f): query --source hook が hook エントリのみ返す
# ---------------------------------------------------------------------------
@test "query --source hook returns only hook entries" {
    # hook エントリを書く
    run bash -c 'printf "%s" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"x\"},\"error\":\"boom error\",\"session_id\":\"s1\"}" | '"$SCRIPT"' hook-capture'
    [ "$status" -eq 0 ]

    # skill エントリを書く
    run "$SCRIPT" log my-skill success
    [ "$status" -eq 0 ]

    run "$SCRIPT" query --source hook
    [ "$status" -eq 0 ]

    # hook エントリのみ含まれること
    total=$(echo "$output" | jq 'length')
    hook_count=$(echo "$output" | jq '[.[] | select(.source == "hook")] | length')
    [ "$total" -eq "$hook_count" ]
    [ "$total" -ge 1 ]
}

# ---------------------------------------------------------------------------
# Test (g): query --source invalid が非 0 exit
# ---------------------------------------------------------------------------
@test "query --source invalid exits non-zero" {
    run "$SCRIPT" query --source invalid
    [ "$status" -ne 0 ]
}

# ===========================================================================
# Tests for stats default source filter (#308): stats defaults to skill-only
# ===========================================================================

# ---------------------------------------------------------------------------
# Test (i): stats のデフォルトが hook エントリを集計から除外する
# ---------------------------------------------------------------------------
@test "stats default excludes hook entries" {
    # skill success エントリを2件書く
    run "$SCRIPT" log dev-flow success
    [ "$status" -eq 0 ]
    run "$SCRIPT" log dev-flow success
    [ "$status" -eq 0 ]

    # hook failure エントリを1件書く
    run bash -c 'printf "%s" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"x\"},\"error\":\"boom error\",\"session_id\":\"s1\"}" | '"$SCRIPT"' hook-capture'
    [ "$status" -eq 0 ]

    run "$SCRIPT" stats
    [ "$status" -eq 0 ]

    total=$(echo "$output" | jq '.total')
    [ "$total" -eq 2 ]

    failure=$(echo "$output" | jq '.failure')
    [ "$failure" -eq 0 ]

    hook_skill_count=$(echo "$output" | jq '[.by_skill[] | select(.skill == "Bash")] | length')
    [ "$hook_skill_count" -eq 0 ]
}

# ---------------------------------------------------------------------------
# Test (j): stats --source hook を明示した場合は hook エントリのみ集計する
# ---------------------------------------------------------------------------
@test "stats --source hook returns only hook entries" {
    # skill success エントリを1件書く
    run "$SCRIPT" log dev-flow success
    [ "$status" -eq 0 ]

    # hook failure エントリを1件書く
    run bash -c 'printf "%s" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"x\"},\"error\":\"boom error\",\"session_id\":\"s1\"}" | '"$SCRIPT"' hook-capture'
    [ "$status" -eq 0 ]

    run "$SCRIPT" stats --source hook
    [ "$status" -eq 0 ]

    total=$(echo "$output" | jq '.total')
    [ "$total" -eq 1 ]

    failure=$(echo "$output" | jq '.failure')
    [ "$failure" -eq 1 ]
}

# ---------------------------------------------------------------------------
# Test (k): stats のデフォルトは source フィールド欠落エントリを skill 扱いで含む
# ---------------------------------------------------------------------------
@test "stats default includes entries without source field" {
    # source 欠落エントリを手書きで配置（#201 以前の journal 互換）
    cat > "$CLAUDE_JOURNAL_DIR/2026-06-11-00-00-01-legacy.json" <<'JSON'
{"version":"1.0.0","id":"20260611T000001-legacy","timestamp":"2026-06-11T00:00:01Z","skill":"legacy","outcome":"success"}
JSON

    # skill エントリを1件書く
    run "$SCRIPT" log dev-flow success
    [ "$status" -eq 0 ]

    run "$SCRIPT" stats
    [ "$status" -eq 0 ]

    total=$(echo "$output" | jq '.total')
    [ "$total" -eq 2 ]
}

# ===========================================================================
# Tests for new error categories: needs_clarification, empty_diff (#225)
# ===========================================================================

# ---------------------------------------------------------------------------
# カテゴリ受理の表: 各行を journal.sh log に渡し、exit 0 で entry が書かれ、
# outcome / error.category（と指定時は error.message / error.phase）がそのまま記録されることを見る。
# telemetry を渡した行は、省略した merge_tier キーが telemetry に無いことも見る。
#   needs_clarification / empty_diff (#225) / runtime（既存カテゴリの回帰） /
#   partial + cross_repo (#432) / success・failure + guard_blocked (#530) /
#   pr_phase_failed + PR phase (#823) / abort + --error-phase (#607)
# ---------------------------------------------------------------------------

# assert_category_accepted <outcome> <category> <error-msg|""> <error-phase|""> [telemetry-json]
assert_category_accepted() {
    local outcome="$1" category="$2" msg="$3" phase="$4" telemetry="${5:-}" label="$1/$2"
    local -a args=(log dev-flow "$outcome" --error-category "$category")
    [[ -n "$msg" ]] && args+=(--error-msg "$msg")
    [[ -n "$phase" ]] && args+=(--error-phase "$phase")
    [[ -n "$telemetry" ]] && args+=(--telemetry-json "$telemetry")
    rm -f "$CLAUDE_JOURNAL_DIR"/*.json
    "$SCRIPT" "${args[@]}" >/dev/null || { echo "[$label] journal.sh log exited non-zero"; return 1; }

    local entry_file
    entry_file="$(latest_entry)"
    [ -n "$entry_file" ] || { echo "[$label] no entry written"; return 1; }
    jq -e --arg o "$outcome" --arg c "$category" '.outcome == $o and .error.category == $c' "$entry_file" >/dev/null \
        || { echo "[$label] outcome/category mismatch: $(cat "$entry_file")"; return 1; }
    if [[ -n "$msg" ]]; then
        jq -e --arg m "$msg" '.error.message == $m' "$entry_file" >/dev/null \
            || { echo "[$label] error.message mismatch"; return 1; }
    fi
    if [[ -n "$phase" ]]; then
        jq -e --arg p "$phase" '.error.phase == $p' "$entry_file" >/dev/null \
            || { echo "[$label] error.phase mismatch"; return 1; }
    fi
    if [[ -n "$telemetry" ]]; then
        # merge_tier キーが telemetry に無いこと（省略時は含まれない）
        jq -e '.telemetry | has("merge_tier") | not' "$entry_file" >/dev/null \
            || { echo "[$label] telemetry unexpectedly has merge_tier"; return 1; }
    fi
}

@test "error category の受理: 表の各 outcome × category が exit 0 で記録される" {
    assert_category_accepted failure needs_clarification 'user clarification needed' '' '{"plugin_version":"1.2.3"}'
    assert_category_accepted failure empty_diff 'no changes produced' '' '{"plugin_version":"1.2.3"}'
    assert_category_accepted failure runtime 'runtime error' ''
    assert_category_accepted partial cross_repo 'x' ''
    assert_category_accepted success guard_blocked '' ''
    assert_category_accepted failure guard_blocked 'guard blocked the run' ''
    assert_category_accepted failure pr_phase_failed 'dev-flow: PR phase 失敗（step: push、reason: remote: 403）' PR
    assert_category_accepted failure abort 'abort@Evaluate/eval#1: evaluator boom' Evaluate
}

# ---------------------------------------------------------------------------
# Test (j): --error-category bogus は die_json で失敗（out-of-enum 拒否の回帰）
# ---------------------------------------------------------------------------
@test "failure with bogus category exits non-zero (out-of-enum rejection)" {
    run "$SCRIPT" log dev-flow failure \
        --error-category bogus \
        --error-msg 'some error'
    [ "$status" -ne 0 ]
}

# ---------------------------------------------------------------------------
# Test (k): failure で --error-msg 欠落は従来どおり失敗
# ---------------------------------------------------------------------------
@test "failure without --error-msg exits non-zero" {
    run "$SCRIPT" log dev-flow failure \
        --error-category needs_clarification
    [ "$status" -ne 0 ]
}

# ---------------------------------------------------------------------------
# Test (o): 未知カテゴリは引き続き die_json で拒否される（enum が閉じたままの回帰確認）
# ---------------------------------------------------------------------------
@test "partial with bogus category still exits non-zero (enum stays closed)" {
    run "$SCRIPT" log dev-flow partial \
        --error-category bogus \
        --error-msg 'some error'
    [ "$status" -ne 0 ]
}

# ===========================================================================
# Tests for --repo / --pr-number (issue #309)
# ===========================================================================

# ---------------------------------------------------------------------------
# Test (m): --repo と --pr-number が context に記録され、telemetry と共存する
# ---------------------------------------------------------------------------
@test "--repo and --pr-number recorded in context and coexist with telemetry" {
    run "$SCRIPT" log dev-flow success --telemetry-json '{"merge_tier":"REVIEW"}' --repo acme/skills --pr-number 123
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    repo_val=$(jq -r '.context.repo' "$entry_file")
    [ "$repo_val" = "acme/skills" ]

    pr_number_val=$(jq '.context.pr_number' "$entry_file")
    [ "$pr_number_val" = "123" ]

    pr_number_type=$(jq '.context.pr_number | type' "$entry_file")
    [ "$pr_number_type" = '"number"' ]

    merge_tier=$(jq -r '.telemetry.merge_tier' "$entry_file")
    [ "$merge_tier" = "REVIEW" ]
}

# ---------------------------------------------------------------------------
# Test (n): --repo に owner/name 形式でない値（スラッシュ無し）を渡すと exit 1
# ---------------------------------------------------------------------------
@test "--repo without slash exits non-zero with Invalid message" {
    run "$SCRIPT" log dev-flow success --repo acme
    [ "$status" -eq 1 ]
    combined_output="$output"
    [[ "$combined_output" == *"Invalid"* ]]
}

# ---------------------------------------------------------------------------
# Test (o): --pr-number 0 は exit 1
# ---------------------------------------------------------------------------
@test "--pr-number 0 exits non-zero" {
    run "$SCRIPT" log dev-flow success --pr-number 0
    [ "$status" -eq 1 ]
}

# ---------------------------------------------------------------------------
# Test (p): --pr-number abc（非数値）は exit 1
# ---------------------------------------------------------------------------
@test "--pr-number abc exits non-zero" {
    run "$SCRIPT" log dev-flow success --pr-number abc
    [ "$status" -eq 1 ]
}

# ---------------------------------------------------------------------------
# Test (q): --repo / --pr-number 未指定時は context.repo / context.pr_number キーが無い
# ---------------------------------------------------------------------------
@test "no --repo/--pr-number -> context has no repo/pr_number keys" {
    run "$SCRIPT" log dev-flow success
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    has_repo=$(jq '.context // {} | has("repo")' "$entry_file")
    has_pr_number=$(jq '.context // {} | has("pr_number")' "$entry_file")
    [ "$has_repo" = "false" ]
    [ "$has_pr_number" = "false" ]
}

# ---------------------------------------------------------------------------
# --telemetry-json (workflow handoff の telemetry をそのまま載せる汎用 flag)
# ---------------------------------------------------------------------------
@test "--telemetry-json: 任意 object が telemetry に入る" {
    run "$SCRIPT" log dev-flow success \
        --telemetry-json '{"candidates_found":3,"issues_filed":2,"backpressure_skipped":false}'
    [ "$status" -eq 0 ]
    entry_file=$(latest_entry)
    [ -n "$entry_file" ]
    [ "$(jq -r '.telemetry.candidates_found' "$entry_file")" = "3" ]
    [ "$(jq -r '.telemetry.issues_filed' "$entry_file")" = "2" ]
    [ "$(jq -r '.telemetry.backpressure_skipped' "$entry_file")" = "false" ]
}

@test "--telemetry-json: JSON でない値は error" {
    run "$SCRIPT" log dev-flow success --telemetry-json 'not-json'
    [ "$status" -ne 0 ]
}

@test "--telemetry-json: object 以外（配列）は error" {
    run "$SCRIPT" log dev-flow success --telemetry-json '[1,2]'
    [ "$status" -ne 0 ]
}

# ---------------------------------------------------------------------------
# 撤去済み trust-layer flag (issue #698): 受け流す分岐を持たず Unknown option で error になる。
# flag 名は residue grep（AC-2 が `trust` プレフィックス flag の文字列を禁止）に掛からないよう
# 分割して組み立てる
# ---------------------------------------------------------------------------
@test "撤去済み trust flag: journal.sh log に渡すと Unknown option で error になる" {
    local flag_prefix="--trust"
    for suffix in -run-id -receipts -surfaceproof -evalseal-missing-reason -effectdelta-pr-missing-reason; do
        run "$SCRIPT" log dev-flow success "${flag_prefix}${suffix}" '[]'
        [ "$status" -ne 0 ]
        [[ "$output" == *"Unknown option: ${flag_prefix}${suffix}"* ]]
    done
}

# ===========================================================================
# Tests for new error category: abort (issue #607)
# ===========================================================================

# abort + --error-phase の受理は上の「error category の受理」表が見る

# ---------------------------------------------------------------------------
# stats --source skill の by_category が abort entry を集計できる
# ---------------------------------------------------------------------------
@test "stats counts abort entries under by_category" {
    run "$SCRIPT" log dev-flow failure \
        --error-category abort \
        --error-msg "abort@Evaluate/eval#1: evaluator boom" \
        --error-phase Evaluate
    [ "$status" -eq 0 ]

    run "$SCRIPT" log dev-flow success
    [ "$status" -eq 0 ]

    run "$SCRIPT" stats --source skill
    [ "$status" -eq 0 ]

    by_category_abort=$(echo "$output" | jq -r '.by_category[] | select(.category == "abort") | .count')
    [ "$by_category_abort" = "1" ]

    failure_count=$(echo "$output" | jq -r '.failure')
    [ "$failure_count" = "1" ]
}
