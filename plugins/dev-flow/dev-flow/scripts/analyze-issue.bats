#!/usr/bin/env bats
# Tests for dev-flow/scripts/analyze-issue.sh
#
# Strategy: shim out `gh` with a PATH-first stub (same approach as
# git-pr/scripts/create-pr.bats). analyze-issue.sh fetches the issue itself
# via `gh issue view <n> [--repo R] --json ...`; the stub records its argv to
# a log file and prints the fixture JSON named by $GH_STUB_FIXTURE (or fails
# with $GH_STUB_FAIL on stderr). Each test writes a fixture file and runs the
# script through the `analyze <fixture> <args...>` helper below.
#
# Covers: breaking_keyword_scan determinism across all depths (minimal /
# standard / comprehensive), full-body scan beyond the 500-char body_preview
# boundary, Japanese keyword detection, a >64KB body regression to pin
# the here-string (non-pipe) SIGPIPE-safe implementation, the gh fetch
# contract (--repo / --json field list forwarded to gh, gh failure -> die_json,
# --issue-json no longer accepted), and --dump-body.

setup() {
    SKILLS_REPO="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
    SCRIPT="$SKILLS_REPO/dev-flow/scripts/analyze-issue.sh"

    # $BATS_TMPDIR は同時に走る別の bats run（他 worktree・並列 Validate）と共有され、
    # 固定名の fixture が互いに上書きされる。テストごとに閉じた dir に置く。
    FIXTURE_DIR="$BATS_TEST_TMPDIR/fixtures"
    mkdir -p "$FIXTURE_DIR"

    # gh stub: one log record per invocation ("<arg1> <arg2> ... <argN>"), then
    # the fixture JSON on stdout. $GH_STUB_FIXTURE / $GH_STUB_FAIL are read at
    # call time so each test picks its fixture through the `analyze` helper.
    GH_LOG="$BATS_TEST_TMPDIR/gh.log"
    : > "$GH_LOG"
    STUB_DIR="$BATS_TEST_TMPDIR/stub-bin"
    mkdir -p "$STUB_DIR"
    cat > "$STUB_DIR/gh" << EOF
#!/usr/bin/env bash
{
    sep=""
    for a in "\$@"; do
        printf "%s%s" "\$sep" "\${a//$'\n'/<NL>}"
        sep=" "
    done
    printf "\n"
} >> "$GH_LOG"
if [[ -n "\${GH_STUB_FAIL:-}" ]]; then
    echo "\$GH_STUB_FAIL" >&2
    exit 1
fi
cat "\$GH_STUB_FIXTURE"
EOF
    chmod +x "$STUB_DIR/gh"
    export PATH="$STUB_DIR:$PATH"
}

# analyze <fixture-path> <script args...>
# Runs analyze-issue.sh with the gh stub serving <fixture-path>.
analyze() {
    export GH_STUB_FIXTURE="$1"
    shift
    "$SCRIPT" "$@"
}

make_fixture() {
    # make_fixture <path> <title> <body> [labels_json] [comments_json] [author_login]
    local path="$1" title="$2" body="$3" labels="${4:-[]}" comments="${5:-[]}" author_login="${6:-}"
    jq -n --arg title "$title" --arg body "$body" --argjson labels "$labels" --argjson comments "$comments" --arg author_login "$author_login" \
        '{title: $title, state: "open", body: $body, labels: $labels, assignees: [], milestone: null, comments: $comments, author: {login: $author_login}}' \
        > "$path"
}

# Placeholder AC/requirement bullet lines prepended to bodies used at
# --depth standard|comprehensive. These are NOT part of the breaking-keyword
# scan under test; they exist only so extract_ac / extract_requirements
# always have >=1 match (a pre-existing, out-of-scope pipefail edge case in
# analyze-issue.sh causes the whole script to exit non-zero when a body has
# zero AC/requirement bullet matches). Keeping fixtures self-contained here
# avoids widening this task's blast radius into that unrelated bug.
AC_STUB="- [ ] Placeholder AC item"$'\n'"- Placeholder Requirement Item"$'\n\n'
# Same rationale, additionally covering --depth comprehensive's
# affected_files / components extraction (also zero-match-sensitive).
COMPREHENSIVE_STUB="${AC_STUB}See src/example.ts and FooComponent for details."$'\n\n'

# ---------------------------------------------------------------------------
# (a) clean issue + --depth minimal -> breaking_keyword_scan:false present
# ---------------------------------------------------------------------------
@test "minimal depth: clean issue -> breaking_keyword_scan:false present" {
    FIXTURE="$FIXTURE_DIR/clean.json"
    make_fixture "$FIXTURE" "Add a button" "Just a UI tweak, nothing else."
    run analyze "$FIXTURE" 1 --depth minimal
    [ "$status" -eq 0 ]
    [[ "$output" == *'"breaking_keyword_scan":false'* ]]
    echo "$output" | jq -e '.breaking_keyword_scan == false'
}

# ---------------------------------------------------------------------------
# (b) title has breaking keyword, body clean + --depth minimal -> true
# ---------------------------------------------------------------------------
@test "minimal depth: breaking keyword in title -> breaking_keyword_scan:true" {
    FIXTURE="$FIXTURE_DIR/breaking-title.json"
    make_fixture "$FIXTURE" "Breaking: rename API" "Just a UI tweak, nothing else."
    run analyze "$FIXTURE" 2 --depth minimal
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.breaking_keyword_scan == true'
}

# ---------------------------------------------------------------------------
# (c) keyword appears after the 500-char body_preview boundary + --depth standard -> true
# ---------------------------------------------------------------------------
@test "standard depth: keyword beyond 500-char body_preview boundary -> true (full-body scan)" {
    PAD="$(printf '%*s' 600 '')"
    PAD="${PAD// /x}"
    BODY="${AC_STUB}${PAD} migration required for downstream consumers."
    FIXTURE="$FIXTURE_DIR/boundary.json"
    make_fixture "$FIXTURE" "Refactor internals" "$BODY"
    run analyze "$FIXTURE" 3 --depth standard
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.breaking_keyword_scan == true'
}

# ---------------------------------------------------------------------------
# (d) Japanese keyword 破壊的変更 + --depth standard -> true
# ---------------------------------------------------------------------------
@test "standard depth: Japanese keyword 破壊的変更 -> true" {
    FIXTURE="$FIXTURE_DIR/ja.json"
    make_fixture "$FIXTURE" "スキーマ更新" "${AC_STUB}この変更には破壊的変更が含まれます。"
    run analyze "$FIXTURE" 4 --depth standard
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.breaking_keyword_scan == true'
}

# ---------------------------------------------------------------------------
# (e) ~70KB body with keyword at the very front + --depth standard -> true
# (SIGPIPE / 64KB pipe-buffer regression: here-string must not silently
#  false-negative when a downstream grep -q early-exits on a large upstream)
# ---------------------------------------------------------------------------
@test "standard depth: ~70KB body with leading keyword -> true (SIGPIPE regression)" {
    PAD="$(printf '%*s' 70000 '')"
    PAD="${PAD// /a}"
    BODY="${AC_STUB}breaking change needed"$'\n'"${PAD}"
    FIXTURE="$FIXTURE_DIR/large.json"
    make_fixture "$FIXTURE" "Large body issue" "$BODY"
    run analyze "$FIXTURE" 5 --depth standard
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.breaking_keyword_scan == true'
}

# ---------------------------------------------------------------------------
# (f) clean issue + --depth comprehensive -> breaking_keyword_scan key present,
#     legacy breaking_changes key absent
# ---------------------------------------------------------------------------
@test "comprehensive depth: clean issue -> breaking_keyword_scan present, breaking_changes absent" {
    FIXTURE="$FIXTURE_DIR/clean-comprehensive.json"
    make_fixture "$FIXTURE" "Add a button" "${COMPREHENSIVE_STUB}Just a UI tweak, nothing else."
    run analyze "$FIXTURE" 6 --depth comprehensive
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '(.breaking_keyword_scan == false) and (has("breaking_changes") | not)'
}

# ---------------------------------------------------------------------------
# (g) all outputs must be parseable JSON (checked implicitly by jq -e above,
#     plus explicit standard-depth clean-issue parse check)
# ---------------------------------------------------------------------------
@test "standard depth: clean issue output is valid JSON with breaking_keyword_scan:false" {
    FIXTURE="$FIXTURE_DIR/clean-standard.json"
    make_fixture "$FIXTURE" "Add a button" "${AC_STUB}Just a UI tweak, nothing else."
    run analyze "$FIXTURE" 7 --depth standard
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.breaking_keyword_scan == false'
}

# ===========================================================================
# --contract mode tests (issue #374): deterministic T1/T2 contract parse.
# ===========================================================================

# ---------------------------------------------------------------------------
# AC 見出しの表: 各行の本文を analyze-issue --contract と ac-lint.sh の両方に流し、
# (1) contract (t1 / t2 / none) と ac-lint の verdict (t1 / t2 / non_compliant) が一致し、
# (2) 行ごとの期待値 (eligible / ineligible_reason / ac_heading_near_miss 等) を満たすことを見る。
# 見出しの受理範囲が 2 つの判定でずれると fast-path と contract gate が黙って食い違う (issue #573)。
#
#   (h)   checkbox AC heading + feat: prefix -> t1, issue_type feat
#   (i)   plain-bullet 受け入れ基準 + fix: prefix -> t2, issue_type fix
#   (j)   AC 見出しなし -> none, "AC heading not found"
#   (k)   AC 見出しはあるが項目なし -> none, "AC heading found but no items"
#   (r)   h4 Acceptance Criteria -> t1 (h2-h6 agnostic)
#   (u)/(aa5) 受け入れ基準外 (substring) -> t2, near-miss に二重計上しない
#   (aa2) 受け入れ条件 -> t1, comment_count 0, near-miss []
#   (aa3) 受入条件 (け/え省略) -> t2, AC 抽出, near-miss []
#   (aa4) 受入れ要件 (受理外) -> none, near-miss 報告
#   (aa6) fence 内の '# acceptance notes' は near-miss にしない
#   (ab1) 完了条件 -> t1
#   (ab2) 受け入れ基準（Acceptance Criteria） (後続テキスト付き) -> t1
#   (ab3) 完了基準 (受理外) -> none, near-miss 報告
#   (ad1) h1 受け入れ基準 -> none, near-miss 報告 (ac-lint は h2-h6)
#   (ad2) h2 受け入れ基準 -> t1 (ad1 の対照)
# ---------------------------------------------------------------------------

# ac_heading_case <label> <title> <body> <ac-lint verdict> <analyze 側の jq 条件>
ac_heading_case() {
    local label="$1" title="$2" body="$3" verdict="$4" expect="$5"
    local fixture="$FIXTURE_DIR/ac-heading-case.json" body_file="$BATS_TEST_TMPDIR/ac-heading-body.md"
    local contract lint lint_verdict contract_kind
    make_fixture "$fixture" "$title" "$body"
    contract="$(analyze "$fixture" 10 --contract)" || { echo "[$label] analyze-issue --contract failed"; return 1; }
    printf '%s\n' "$body" > "$body_file"
    lint="$(bash "$AC_LINT" "$body_file")" || [ "$?" -eq 3 ] || { echo "[$label] ac-lint failed: $lint"; return 1; }
    lint_verdict="$(jq -r '.verdict' <<<"$lint")"
    contract_kind="$(jq -r 'if .contract == "none" then "non_compliant" else .contract end' <<<"$contract")"
    [ "$lint_verdict" = "$verdict" ] || { echo "[$label] ac-lint verdict=$lint_verdict, want $verdict"; return 1; }
    [ "$contract_kind" = "$lint_verdict" ] || { echo "[$label] contract=$contract_kind != ac-lint=$lint_verdict"; return 1; }
    jq -e "$expect" <<<"$contract" >/dev/null || { echo "[$label] unexpected contract: $contract"; return 1; }
}

@test "contract mode: AC 見出しの表 -> analyze-issue --contract と ac-lint.sh の判定が一致し、行ごとの期待値を満たす" {
    AC_LINT="$SKILLS_REPO/_lib/scripts/ac-lint.sh"

    ac_heading_case "(h)" "feat: add button" $'## Acceptance Criteria\n\n- [ ] item one\n- [x] item two' \
        t1 '.contract == "t1" and .eligible == true and .issue_type == "feat"'
    ac_heading_case "(i)" "fix: correct typo" $'## 受け入れ基準\n\n- plain item 1\n- plain item 2' \
        t2 '.contract == "t2" and .eligible == true and .issue_type == "fix"'
    ac_heading_case "(j)" "feat: something" "Just prose, no AC heading anywhere." \
        non_compliant '.contract == "none" and .eligible == false and .ineligible_reason == "AC heading not found"'
    ac_heading_case "(k)" "feat: something" $'## Acceptance Criteria\n\nSome prose but no bullet points here.\n\n## Next Section' \
        non_compliant '.contract == "none" and .eligible == false and .ineligible_reason == "AC heading found but no items"'
    ac_heading_case "(r)" "feat: deep heading" $'#### Acceptance Criteria\n\n- [ ] deep item' \
        t1 '.contract == "t1" and .eligible == true'
    ac_heading_case "(u)/(aa5)" "feat: something" $'## 受け入れ基準外\n\n- this is now treated as an AC item, same as ac-lint.sh' \
        t2 '.contract == "t2" and .eligible == true and .ac_heading_near_miss == []'
    ac_heading_case "(aa2)" "fix: correct typo" $'## 受け入れ条件\n\n- [ ] item one' \
        t1 '.contract == "t1" and .eligible == true and .comment_count == 0 and .ac_heading_near_miss == []'
    ac_heading_case "(aa3)" "feat: something" $'## 受入条件\n\n- plain item' \
        t2 '.contract == "t2" and .eligible == true and .acceptance_criteria == ["plain item"] and .ac_heading_near_miss == []'
    ac_heading_case "(aa4)" "feat: something" $'## 受入れ要件\n\n- [ ] item one' \
        non_compliant '.contract == "none" and .eligible == false and .ineligible_reason == "AC heading not found" and .ac_heading_near_miss == ["## 受入れ要件"]'
    ac_heading_case "(aa6)" "feat: something" $'## Acceptance Criteria\n\n- [ ] item one\n\n```\n# acceptance notes\nsome code\n```' \
        t1 '.ac_heading_near_miss == []'
    ac_heading_case "(ab1)" "feat: something" $'## 完了条件\n\n- [ ] item one' \
        t1 '.contract == "t1" and .eligible == true'
    ac_heading_case "(ab2)" "feat: something" $'## 受け入れ基準（Acceptance Criteria）\n\n- [ ] item one' \
        t1 '.contract == "t1" and .eligible == true'
    ac_heading_case "(ab3)" "feat: something" $'## 完了基準\n\n- [ ] item one' \
        non_compliant '.contract == "none" and .eligible == false and .ineligible_reason == "AC heading not found" and .ac_heading_near_miss == ["## 完了基準"]'
    ac_heading_case "(ad1)" "feat: something" $'# 受け入れ基準\n\n- [ ] item one' \
        non_compliant '.contract == "none" and .eligible == false and .ineligible_reason == "AC heading not found" and .ac_heading_near_miss == ["# 受け入れ基準"]'
    ac_heading_case "(ad2)" "feat: something" $'## 受け入れ基準\n\n- [ ] item one' \
        t1 '.contract == "t1" and .eligible == true'
}

# ---------------------------------------------------------------------------
# (l) chore: prefix -> issue_type in {feat,fix,docs,refactor,chore,test,perf,ci}
#     -> eligible (issue #442 enum 拡張)
# ---------------------------------------------------------------------------
@test "contract mode: chore: prefix title -> eligible (issue #442 enum 拡張)" {
    FIXTURE="$FIXTURE_DIR/contract-chore.json"
    make_fixture "$FIXTURE" "chore: bump deps" "## Acceptance Criteria

- [ ] deps bumped"
    run analyze "$FIXTURE" 14 --contract
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.eligible == true and .issue_type == "chore"'
}

# ---------------------------------------------------------------------------
# (l2) style: prefix -> issue_type not in enum -> ineligible (out-of-enum
#      regression coverage now that chore is valid; 'style' stays out-of-enum)
# ---------------------------------------------------------------------------
@test "contract mode: style: prefix title -> ineligible (out-of-enum)" {
    FIXTURE="$FIXTURE_DIR/contract-style.json"
    make_fixture "$FIXTURE" "style: tweak css" "## Acceptance Criteria

- [ ] css tweaked"
    run analyze "$FIXTURE" 29 --contract
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.eligible == false and (.ineligible_reason | contains("issue_type"))'
}

# ---------------------------------------------------------------------------
# (l3) test: prefix -> issue_type in enum -> eligible (bash reserved-word /
#      `test` command name collision check, issue #442)
# ---------------------------------------------------------------------------
@test "contract mode: test: prefix title -> eligible (issue #442 enum 拡張)" {
    FIXTURE="$FIXTURE_DIR/contract-test-type.json"
    make_fixture "$FIXTURE" "test: add regression spec" "## Acceptance Criteria

- [ ] regression spec added"
    run analyze "$FIXTURE" 30 --contract
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.eligible == true and .issue_type == "test"'
}

# ---------------------------------------------------------------------------
# (m) feat!: breaking marker in title -> ineligible (breaking marker)
# ---------------------------------------------------------------------------
@test "contract mode: feat!: breaking marker in title -> ineligible" {
    FIXTURE="$FIXTURE_DIR/contract-bang.json"
    make_fixture "$FIXTURE" "feat!: change API" "## Acceptance Criteria

- [ ] API changed"
    run analyze "$FIXTURE" 15 --contract
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.eligible == false and (.ineligible_reason | contains("breaking marker"))'
}

# ---------------------------------------------------------------------------
# (n) breaking keyword inside AC section (excluded from scope) still trips
#     the full-body breaking_keyword_scan -> ineligible
# ---------------------------------------------------------------------------
@test "contract mode: breaking keyword in AC-excluded section still detected -> ineligible" {
    FIXTURE="$FIXTURE_DIR/contract-breaking-kw.json"
    make_fixture "$FIXTURE" "feat: update" "## Acceptance Criteria

- [ ] item with a breaking change noted here"
    run analyze "$FIXTURE" 16 --contract
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.breaking_keyword_scan == true and .eligible == false and .ineligible_reason == "breaking_keyword_scan true"'
}

# ---------------------------------------------------------------------------
# (o) title without conventional prefix -> label-based issue_type fallback
# ---------------------------------------------------------------------------
@test "contract mode: no title prefix -> label-based issue_type fallback" {
    FIXTURE="$FIXTURE_DIR/contract-label-fallback.json"
    make_fixture "$FIXTURE" "Something is broken" "## Acceptance Criteria

- [ ] it works again" '[{"name":"bug"}]'
    run analyze "$FIXTURE" 17 --contract
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.eligible == true and .issue_type == "fix"'
}

# ---------------------------------------------------------------------------
# (p) contract mode never emits a file-count estimate, even when the scope
#     lists file paths: dev-flow decides the effective shape from the realized
#     diff after implementation (issue #676), not from the issue body.
# ---------------------------------------------------------------------------
@test "contract mode: file paths in scope -> no estimated_change_file_count / shape key" {
    FIXTURE="$FIXTURE_DIR/contract-file-count.json"
    make_fixture "$FIXTURE" "feat: touch files" "## Acceptance Criteria

- [ ] done

## Scope
Update src/foo.ts and src/bar.ts."
    run analyze "$FIXTURE" 18 --contract
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.eligible == true and (has("estimated_change_file_count") | not) and (has("shape") | not)'
}

# ---------------------------------------------------------------------------
# (s) ~70KB body, breaking keyword after large padding -> exit 0, correctly
#     detected (SIGPIPE regression, contract-mode variant of the existing
#     depth-mode large-body test)
# ---------------------------------------------------------------------------
@test "contract mode: ~70KB body with trailing breaking keyword -> detected (SIGPIPE regression)" {
    PAD="$(printf '%*s' 70000 '')"
    PAD="${PAD// /a}"
    BODY="## Acceptance Criteria"$'\n\n'"- [ ] item"$'\n\n'"${PAD}"$'\n'"migration required afterward."
    FIXTURE="$FIXTURE_DIR/contract-large.json"
    make_fixture "$FIXTURE" "feat: large issue" "$BODY"
    run analyze "$FIXTURE" 21 --contract
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.contract == "t1" and .breaking_keyword_scan == true and .eligible == false'
}

# ---------------------------------------------------------------------------
# (t) ineligible_reason key presence is exactly gated by eligible (absent
#     when eligible=true, present when eligible=false) -- valid JSON check
# ---------------------------------------------------------------------------
@test "contract mode: ineligible_reason key present only when eligible=false" {
    ELIGIBLE_FIXTURE="$FIXTURE_DIR/contract-key-eligible.json"
    make_fixture "$ELIGIBLE_FIXTURE" "docs: update readme" "## Acceptance Criteria

- [ ] readme updated"
    run analyze "$ELIGIBLE_FIXTURE" 22 --contract
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '(has("ineligible_reason") | not)'

    INELIGIBLE_FIXTURE="$FIXTURE_DIR/contract-key-ineligible.json"
    make_fixture "$INELIGIBLE_FIXTURE" "no prefix title" "no AC heading here"
    run analyze "$INELIGIBLE_FIXTURE" 23 --contract
    [ "$status" -eq 0 ]
    echo "$output" | jq -e 'has("ineligible_reason")'
}

# ---------------------------------------------------------------------------
# (v) A sibling heading that STARTS WITH the real AC heading text (e.g.
#     "受け入れ基準の補足") must not merge its items into the real AC section
#     (PR #388 review finding, major #1).
# ---------------------------------------------------------------------------
@test "contract mode: 受け入れ基準の補足 sibling heading does not merge into AC section" {
    FIXTURE="$FIXTURE_DIR/contract-ac-hosoku.json"
    make_fixture "$FIXTURE" "feat: something" "## 受け入れ基準

- [ ] real ac item

## 受け入れ基準の補足

- this must not merge into acceptance_criteria"
    run analyze "$FIXTURE" 25 --contract
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.acceptance_criteria == ["real ac item"]'
}

# ---------------------------------------------------------------------------
# (w) A scope mentioning only .sh/.bats files is still eligible and, like any
#     other scope, carries no file-count estimate (issue #676).
# ---------------------------------------------------------------------------
@test "contract mode: sh/bats-only scope -> eligible, no estimated_change_file_count" {
    FIXTURE="$FIXTURE_DIR/contract-sh-scope.json"
    make_fixture "$FIXTURE" "feat: touch shell files" "## Acceptance Criteria

- [ ] done

## Scope
Update dev-flow/scripts/analyze-issue.sh and dev-flow/scripts/analyze-issue.bats."
    run analyze "$FIXTURE" 26 --contract
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.eligible == true and (has("estimated_change_file_count") | not)'
}

# ---------------------------------------------------------------------------
# (x) Multi-line non-AC body over 4000 bytes must not SIGPIPE-kill the script
#     via `extract_non_ac_body | head -c 4000` (PR #388 review finding,
#     critical #1). Regression: with the pipe form, head -c's early exit after
#     reading its byte quota SIGPIPEs the upstream printf writer under
#     set -o pipefail, causing exit 141 with empty stdout instead of exit 0 +
#     JSON. 200 lines x 30 chars (~6000 bytes incl. newlines) reproduces the
#     multi-write pattern that a single large single-line body does not.
# ---------------------------------------------------------------------------
@test "contract mode: multi-line non-AC scope over 4000 bytes -> exit 0, scope truncated -> ineligible" {
    LINES=""
    for i in $(seq 1 200); do
        LINES="${LINES}line-${i}-xxxxxxxxxxxxxxxxxxxx"$'\n'
    done
    BODY="## Acceptance Criteria

- [ ] item one

## Scope
${LINES}"
    FIXTURE="$FIXTURE_DIR/contract-large-scope.json"
    make_fixture "$FIXTURE" "feat: large scope" "$BODY"
    run analyze "$FIXTURE" 27 --contract
    [ "$status" -eq 0 ]
    # scope > 4000 bytes -> scope_truncated true -> ineligible (falls back to
    # sonnet analyze, which reads the full body; issue #598 review on PR #598).
    # This test's purpose remains the SIGPIPE regression: exit 0 + valid JSON.
    echo "$output" | jq -e '.contract == "t1" and .eligible == false and .ineligible_reason == "scope truncated"'
}

# ---------------------------------------------------------------------------
# (y) A `# comment`-style line inside a fenced code block within the AC
#     section must not be mistaken for a markdown heading and prematurely
#     terminate the AC section (PR #388 review finding, major #1/fence
#     tracking). Without fence tracking, the fenced `# comment` line closes
#     the AC section early and "item two" (after the fence) is silently
#     dropped from acceptance_criteria.
# ---------------------------------------------------------------------------
@test "contract mode: '#' comment inside fenced code block in AC section does not truncate AC items" {
    FIXTURE="$FIXTURE_DIR/contract-fence.json"
    make_fixture "$FIXTURE" "feat: something with code fence" '## Acceptance Criteria

- [ ] item one

```
# comment not a heading
some code
```

- [ ] item two'
    run analyze "$FIXTURE" 28 --contract
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.acceptance_criteria == ["item one", "item two"]'
}

# ===========================================================================
# gh fetch contract (in-process `gh issue view`, no file relay)
# ===========================================================================

# ---------------------------------------------------------------------------
# (z1) --issue-json is not an accepted option (no dual input path)
# ---------------------------------------------------------------------------
@test "--issue-json is rejected as an unknown option" {
    FIXTURE="$FIXTURE_DIR/z1.json"
    make_fixture "$FIXTURE" "Add a button" "Just a UI tweak."
    run analyze "$FIXTURE" 31 --issue-json "$FIXTURE" --depth minimal
    [ "$status" -ne 0 ]
    echo "$output" | jq -e '.status == "error" and (.error | contains("Unknown option: --issue-json"))'
    # The unknown option is rejected before any fetch is attempted.
    [ ! -s "$GH_LOG" ]
}

# ---------------------------------------------------------------------------
# (z2) the script calls gh itself with the issue number, --repo and the full
#      --json field list (comments + author + updatedAt included: the comments
#      guard, issue_author and issue_updated_at depend on them)
# ---------------------------------------------------------------------------
@test "gh stub receives issue number, --repo and the --json field list" {
    FIXTURE="$FIXTURE_DIR/z2.json"
    make_fixture "$FIXTURE" "Add a button" "Just a UI tweak."
    run analyze "$FIXTURE" 32 --repo acme/skills --depth minimal
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.issue_number == 32 and .title == "Add a button"'
    GH_LINE=$(grep "issue view" "$GH_LOG" || true)
    [ "$GH_LINE" = "issue view 32 --repo acme/skills --json body,title,labels,assignees,milestone,state,comments,author,updatedAt" ]
    # exactly one fetch per run
    [ "$(wc -l < "$GH_LOG" | tr -d ' ')" -eq 1 ]
}

# ---------------------------------------------------------------------------
# (z3) --repo omitted -> gh resolves the repo from cwd; no --repo argv
# ---------------------------------------------------------------------------
@test "without --repo the gh invocation carries no --repo argument" {
    FIXTURE="$FIXTURE_DIR/z3.json"
    make_fixture "$FIXTURE" "Add a button" "Just a UI tweak."
    run analyze "$FIXTURE" 33 --depth minimal
    [ "$status" -eq 0 ]
    GH_LINE=$(grep "issue view" "$GH_LOG" || true)
    [ "$GH_LINE" = "issue view 33 --json body,title,labels,assignees,milestone,state,comments,author,updatedAt" ]
}

# ---------------------------------------------------------------------------
# (z4) --contract and --depth standard run on the issue number alone
# ---------------------------------------------------------------------------
@test "contract mode runs on the issue number alone (fetch inside the script)" {
    FIXTURE="$FIXTURE_DIR/z4.json"
    make_fixture "$FIXTURE" "feat: add button" "## Acceptance Criteria

- [ ] item one"
    run analyze "$FIXTURE" 34 --contract
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.contract == "t1" and .eligible == true and .issue_number == 34'
    grep -q "^issue view 34 " "$GH_LOG"
}

@test "standard depth runs on the issue number alone (fetch inside the script)" {
    FIXTURE="$FIXTURE_DIR/z4-standard.json"
    make_fixture "$FIXTURE" "Add a button" "${AC_STUB}Just a UI tweak."
    run analyze "$FIXTURE" 35 --depth standard
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.issue_number == 35 and (.acceptance_criteria | length) == 1'
    grep -q "^issue view 35 " "$GH_LOG"
}

# ---------------------------------------------------------------------------
# (z5) gh failure -> die_json (exit non-zero) carrying gh's stderr text
# ---------------------------------------------------------------------------
@test "gh failure -> die_json with gh stderr in the error message" {
    FIXTURE="$FIXTURE_DIR/z5.json"
    make_fixture "$FIXTURE" "Add a button" "Just a UI tweak."
    export GH_STUB_FAIL="GraphQL: Could not resolve to an Issue (repository.issue)"
    run analyze "$FIXTURE" 36 --repo acme/skills --contract
    [ "$status" -ne 0 ]
    echo "$output" | jq -e '.status == "error" and (.error | contains("gh issue view 36")) and (.error | contains("Could not resolve to an Issue"))'
}

# ===========================================================================
# --dump-body (full body written out only when an excerpt was truncated)
# ===========================================================================

# ---------------------------------------------------------------------------
# (y1) standard depth, body over the cap + --dump-body -> file holds the raw
#      body verbatim, body_dump_path is the absolute path
# ---------------------------------------------------------------------------
@test "--dump-body: truncated body -> full body written, body_dump_path absolute" {
    FIXTURE="$FIXTURE_DIR/y1.json"
    BODY="${AC_STUB}$(head -c 4500 /dev/zero | tr '\0' 'x')"$'\n'"FINAL_SPEC_LINE_AT_THE_END"
    make_fixture "$FIXTURE" "Add a button" "$BODY"
    DUMP="$BATS_TEST_TMPDIR/dump/issue-37-body.md"
    mkdir -p "$(dirname "$DUMP")"
    run analyze "$FIXTURE" 37 --depth standard --dump-body "$DUMP"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.scope_truncated == true and .issue_body_truncated == true'
    echo "$output" | jq -e --arg p "$DUMP" '.body_dump_path == $p'
    echo "$output" | jq -e '.body_dump_path | startswith("/")'
    [ -f "$DUMP" ]
    # verbatim: the tail the excerpts cut off is present, no marker appended
    grep -q 'FINAL_SPEC_LINE_AT_THE_END' "$DUMP"
    ! grep -q 'TRUNCATED' "$DUMP"
    [ "$(wc -c < "$DUMP" | tr -d ' ')" -eq "$(printf '%s' "$BODY" | wc -c | tr -d ' ')" ]
}

# ---------------------------------------------------------------------------
# (y2) --dump-body given but nothing truncated -> no file, body_dump_path null
# ---------------------------------------------------------------------------
@test "--dump-body: body under every cap -> no file written, body_dump_path null" {
    FIXTURE="$FIXTURE_DIR/y2.json"
    make_fixture "$FIXTURE" "Add a button" "${AC_STUB}Short body."
    DUMP="$BATS_TEST_TMPDIR/issue-38-body.md"
    run analyze "$FIXTURE" 38 --depth standard --dump-body "$DUMP"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.scope_truncated == false and .body_preview_truncated == false and .body_dump_path == null'
    [ ! -e "$DUMP" ]
}

# ---------------------------------------------------------------------------
# (y3) --dump-body omitted -> body_dump_path null even when truncated
# ---------------------------------------------------------------------------
@test "--dump-body omitted: truncated body -> body_dump_path null" {
    FIXTURE="$FIXTURE_DIR/y3.json"
    make_fixture "$FIXTURE" "Add a button" "${AC_STUB}$(head -c 4500 /dev/zero | tr '\0' 'x')"
    run analyze "$FIXTURE" 39 --depth comprehensive
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.scope_truncated == true and .body_dump_path == null'
}

# ===========================================================================
# comments / AC heading near-miss (issue #573)
# ===========================================================================

# ---------------------------------------------------------------------------
# (aa1) contract mode: comments present -> ineligible (comment/body reconciliation
#       requires sonnet analyze; comment_count reported)
# ---------------------------------------------------------------------------
@test "contract mode: comments present -> ineligible, comment_count reported" {
    FIXTURE="$FIXTURE_DIR/contract-comments.json"
    make_fixture "$FIXTURE" "feat: add button" "## Acceptance Criteria

- [ ] item one" '[]' '[{"author":{"login":"alice"},"createdAt":"2026-01-01T00:00:00Z","body":"訂正: 30 箇所"},{"author":{"login":"bob"},"createdAt":"2026-01-02T00:00:00Z","body":"了解"}]'
    run analyze "$FIXTURE" 33 --contract
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.contract == "t1" and .eligible == false and .comment_count == 2 and (.ineligible_reason | startswith("comments present (2)"))'
}

# ---------------------------------------------------------------------------
# (aa1b) contract mode always carries the raw signals prerun-analyze.sh routes to Jev
#        (issue #690): comments[] (author / author_association / created_at / body),
#        issue_author, title_breaking_marker — independent of `eligible`.
# ---------------------------------------------------------------------------
@test "contract mode: comments[] / issue_author / title_breaking_marker are emitted (issue #690)" {
    FIXTURE="$FIXTURE_DIR/contract-jev-signals.json"
    make_fixture "$FIXTURE" "feat!: add button" "## Acceptance Criteria

- [ ] item one" '[]' '[{"author":{"login":"alice"},"authorAssociation":"OWNER","createdAt":"2026-01-01T00:00:00Z","body":"訂正: 30 箇所"}]' "reporter"
    run analyze "$FIXTURE" 35 --contract
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.title_breaking_marker == true and .issue_author == "reporter"'
    echo "$output" | jq -e '.comments == [{"author":"alice","author_association":"OWNER","created_at":"2026-01-01T00:00:00Z","body":"訂正: 30 箇所"}]'
    # no bang / no comments / no author -> false / [] / ""
    FIXTURE2="$FIXTURE_DIR/contract-jev-signals-empty.json"
    make_fixture "$FIXTURE2" "feat: add button" "## Acceptance Criteria

- [ ] item one"
    run analyze "$FIXTURE2" 36 --contract
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.title_breaking_marker == false and .issue_author == "" and .comments == []'
}

# ---------------------------------------------------------------------------
# (aa1c) contract mode carries the issue updatedAt as issue_updated_at (issue #728):
#        prerun-analyze.sh compares it with the latest comment createdAt so Jev can
#        tell "issue was updated after the comment". Missing key -> "".
# ---------------------------------------------------------------------------
@test "contract mode: issue_updated_at mirrors gh updatedAt (missing -> \"\") (issue #728)" {
    FIXTURE="$FIXTURE_DIR/contract-updated-at.json"
    make_fixture "$FIXTURE" "feat: add button" "## Acceptance Criteria

- [ ] item one"
    jq '. + {updatedAt: "2026-09-25T01:02:03Z"}' "$FIXTURE" >"$FIXTURE.tmp" && mv "$FIXTURE.tmp" "$FIXTURE"
    run analyze "$FIXTURE" 37 --contract
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.issue_updated_at == "2026-09-25T01:02:03Z"'
    FIXTURE2="$FIXTURE_DIR/contract-updated-at-missing.json"
    make_fixture "$FIXTURE2" "feat: add button" "## Acceptance Criteria

- [ ] item one"
    run analyze "$FIXTURE2" 38 --contract
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.issue_updated_at == ""'
}

# ---------------------------------------------------------------------------
# (aa7) standard depth: comments -> comment_count + comments[] populated
# ---------------------------------------------------------------------------
@test "standard depth: comments populated in output" {
    FIXTURE="$FIXTURE_DIR/standard-comments.json"
    make_fixture "$FIXTURE" "Add a button" "${AC_STUB}Just a UI tweak, nothing else." '[]' '[{"author":{"login":"alice"},"createdAt":"2026-01-01T00:00:00Z","body":"訂正: 30 箇所"}]'
    run analyze "$FIXTURE" 39 --depth standard
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.comment_count == 1 and .comments[0].author == "alice" and .comments[0].created_at == "2026-01-01T00:00:00Z" and .comments[0].body == "訂正: 30 箇所"'
}

# ---------------------------------------------------------------------------
# (aa8) standard depth: no AC lines in body -> acceptance_criteria empty,
#       warnings include the empty-AC message and the near-miss heading text
# ---------------------------------------------------------------------------
@test "standard depth: no AC lines -> warnings report empty AC and near-miss heading" {
    FIXTURE="$FIXTURE_DIR/standard-no-ac.json"
    make_fixture "$FIXTURE" "feat: something" "## 受入れ要件

Just prose, no checkbox or numbered items here."
    run analyze "$FIXTURE" 40 --depth standard
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.acceptance_criteria == [] and (.warnings | any(startswith("acceptance_criteria is empty"))) and (.warnings | any(contains("受入れ要件")))'
}

# ---------------------------------------------------------------------------
# (aa9) standard depth: AC present, no near-miss heading -> warnings empty
# ---------------------------------------------------------------------------
@test "standard depth: AC present, no near-miss -> warnings empty" {
    FIXTURE="$FIXTURE_DIR/standard-warnings-empty.json"
    make_fixture "$FIXTURE" "Add a button" "${AC_STUB}Just a UI tweak, nothing else."
    run analyze "$FIXTURE" 41 --depth standard
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.warnings == []'
}

# ---------------------------------------------------------------------------
# (aa10) minimal depth: comment_count reflects comments length
# ---------------------------------------------------------------------------
@test "minimal depth: comment_count reflects comments length" {
    FIXTURE="$FIXTURE_DIR/minimal-comments.json"
    make_fixture "$FIXTURE" "Add a button" "Just a UI tweak, nothing else." '[]' '[{"author":{"login":"a"},"createdAt":"2026-01-01T00:00:00Z","body":"1"},{"author":{"login":"b"},"createdAt":"2026-01-02T00:00:00Z","body":"2"},{"author":{"login":"c"},"createdAt":"2026-01-03T00:00:00Z","body":"3"}]'
    run analyze "$FIXTURE" 42 --depth minimal
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.comment_count == 3'
}

# ---------------------------------------------------------------------------
# (aa11) fixture with no "comments" key at all -> fetch-contract violation,
#        fails closed with a non-zero exit / error JSON rather than silently
#        degrading to comment_count 0 (PR #578 review of #573/#578: a probe
#        agent that drops "comments" from its `--json` field list must not be
#        able to slip an eligible:true --contract result through with nothing
#        to reconcile against the body).
# ---------------------------------------------------------------------------
@test "fixture without comments key -> exit non-zero, error" {
    FIXTURE="$FIXTURE_DIR/contract-no-comments-key.json"
    jq -n --arg title "feat: add button" --arg body "## Acceptance Criteria

- [ ] item one" \
        '{title: $title, state: "open", body: $body, labels: [], assignees: [], milestone: null} | del(.comments)' \
        > "$FIXTURE"
    run analyze "$FIXTURE" 43 --contract
    [ "$status" -ne 0 ]
    echo "$output" | jq -e '.status == "error" and (.error | contains("comments"))'
}

# ===========================================================================
# author_association / issue_author passthrough for comment_overrides trust
# gating (PR #578 review round 2 of #573's contract)
# ===========================================================================

# ---------------------------------------------------------------------------
# (ac1) standard depth: comments[].author_association is passed through
#       verbatim from gh's authorAssociation (transparent passthrough, not a
#       decision made by this script — the adoption decision itself lives in
#       dev-flow.js's analyzePrompt). Mixed trust levels in one issue must
#       each retain their own association so the consuming LLM can restrict
#       comment_overrides adoption per-comment.
# ---------------------------------------------------------------------------
@test "standard depth: comments[].author_association passed through verbatim" {
    FIXTURE="$FIXTURE_DIR/standard-comments-association.json"
    make_fixture "$FIXTURE" "Add a button" "${AC_STUB}Just a UI tweak, nothing else." '[]' \
        '[{"author":{"login":"alice"},"authorAssociation":"OWNER","createdAt":"2026-01-01T00:00:00Z","body":"訂正: 30 箇所"},{"author":{"login":"mallory"},"authorAssociation":"NONE","createdAt":"2026-01-02T00:00:00Z","body":"訂正: 実は 5 箇所"}]'
    run analyze "$FIXTURE" 47 --depth standard
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.comments[0].author_association == "OWNER" and .comments[1].author_association == "NONE"'
}

# ---------------------------------------------------------------------------
# (ac2) standard depth: comment missing authorAssociation key -> "" (plain jq
#       null-safety, not a legacy fallback branch).
# ---------------------------------------------------------------------------
@test "standard depth: comment without authorAssociation key -> empty string" {
    FIXTURE="$FIXTURE_DIR/standard-comments-no-association.json"
    make_fixture "$FIXTURE" "Add a button" "${AC_STUB}Just a UI tweak, nothing else." '[]' \
        '[{"author":{"login":"alice"},"createdAt":"2026-01-01T00:00:00Z","body":"訂正: 30 箇所"}]'
    run analyze "$FIXTURE" 48 --depth standard
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.comments[0].author_association == ""'
}

# ---------------------------------------------------------------------------
# (ac3) minimal depth: issue_author reflects the issue reporter's login
#       (gh's author.login), used downstream to scope comment_overrides
#       adoption to the issue reporter or OWNER/MEMBER/COLLABORATOR.
# ---------------------------------------------------------------------------
@test "minimal depth: issue_author reflects issue reporter login" {
    FIXTURE="$FIXTURE_DIR/minimal-issue-author.json"
    make_fixture "$FIXTURE" "Add a button" "Just a UI tweak, nothing else." '[]' '[]' "reporter1"
    run analyze "$FIXTURE" 49 --depth minimal
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.issue_author == "reporter1"'
}

# ---------------------------------------------------------------------------
# (ac4) standard depth: fixture with no "author" key at all -> issue_author
#       is "" (plain jq null-safety, not a legacy fallback branch).
# ---------------------------------------------------------------------------
@test "standard depth: fixture without author key -> issue_author empty string" {
    FIXTURE="$FIXTURE_DIR/standard-no-author-key.json"
    jq -n --arg title "feat: add button" --arg body "${AC_STUB}Just a UI tweak, nothing else." \
        '{title: $title, state: "open", body: $body, labels: [], assignees: [], milestone: null, comments: []} | del(.author)' \
        > "$FIXTURE"
    run analyze "$FIXTURE" 50 --depth standard
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.issue_author == ""'
}

# ===========================================================================
# scope / body_preview 切断の非 silent 化 (issue #596)
# ===========================================================================

# ---------------------------------------------------------------------------
# (ae1) contract mode: non-AC body over 4000 chars -> scope_truncated true,
#       marker appended, and a spec written at the very end of the body is
#       cut out of the returned scope (the failure mode issue #596 fixes).
# ---------------------------------------------------------------------------
@test "contract mode: non-AC body over 4000 chars -> scope_truncated true, marker appended, spec at the end is cut" {
    LINES=""
    for i in $(seq 1 150); do
        LINES="${LINES}line-${i}-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"$'\n'
    done
    BODY="## Acceptance Criteria

- [ ] item one

## Scope
${LINES}DECISION: use the marker approach"
    FIXTURE="$FIXTURE_DIR/scope-truncated-596.json"
    make_fixture "$FIXTURE" "feat: large scope with decision" "$BODY"
    run analyze "$FIXTURE" 53 --contract
    [ "$status" -eq 0 ]
    # scope_truncated:true now makes the contract path ineligible (falls back
    # to sonnet analyze, which reads the full body instead of building a REQ
    # from an excerpt that may be missing a spec written past the cut — issue
    # #598 review on PR #598). The excerpt/marker fields are still asserted
    # here because they remain part of the contract output contract even when
    # ineligible (dev-flow.js's whitelist check reads scope_truncated off the
    # sonnet-path REQ, not off this ineligible contract-mode output).
    echo "$output" | jq -e '
        .scope_truncated == true and
        (.scope_total_chars > 4000) and
        (.scope | contains("[TRUNCATED: scope shows the first 4000 of ")) and
        (.scope | endswith("before raising ambiguities]")) and
        ((.scope | split("\n[TRUNCATED")[0] | length) == 4000) and
        ((.scope | contains("DECISION:")) | not) and
        (.eligible == false) and
        (.ineligible_reason == "scope truncated")
    '
}

# ---------------------------------------------------------------------------
# (ae2) contract mode: non-AC body under 4000 chars -> scope_truncated false,
#       no marker appended, scope_total_chars matches the returned scope length.
# ---------------------------------------------------------------------------
@test "contract mode: non-AC body under 4000 chars -> scope_truncated false, no marker" {
    BODY="## Acceptance Criteria

- [ ] item one

## Scope
Update a few files, nothing large here."
    FIXTURE="$FIXTURE_DIR/scope-not-truncated-596.json"
    make_fixture "$FIXTURE" "feat: small scope" "$BODY"
    run analyze "$FIXTURE" 54 --contract
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.scope_truncated == false and (.scope | contains("[TRUNCATED") | not) and (.scope_total_chars == (.scope | length))'
}

# ---------------------------------------------------------------------------
# (ae3) contract mode: exactly 4000 non-AC chars -> not truncated (`>`
#       boundary judgment, not `>=`).
# ---------------------------------------------------------------------------
@test "contract mode: exactly 4000 non-AC chars -> not truncated (boundary)" {
    PAD="$(printf '%*s' 3991 '')"
    PAD="${PAD// /y}"
    BODY="## Acceptance Criteria

- [ ] item one

## Scope
${PAD}"
    FIXTURE="$FIXTURE_DIR/scope-boundary-596.json"
    make_fixture "$FIXTURE" "feat: boundary scope" "$BODY"
    run analyze "$FIXTURE" 55 --contract
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.scope_truncated == false and .scope_total_chars == 4000'
}

# ---------------------------------------------------------------------------
# (ae4) contract mode: a truncated scope still yields an eligible contract with
#       scope_truncated=true and no file-count estimate (issue #676).
# ---------------------------------------------------------------------------
@test "contract mode: truncated scope -> scope_truncated true, no estimated_change_file_count" {
    PAD="$(printf '%*s' 4500 '')"
    PAD="${PAD// /q}"
    BODY="## Acceptance Criteria

- [ ] item one

## Scope
src/a.ts and src/b.ts are affected.
${PAD}"
    FIXTURE="$FIXTURE_DIR/scope-file-count-596.json"
    make_fixture "$FIXTURE" "feat: touch two files" "$BODY"
    run analyze "$FIXTURE" 56 --contract
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.scope_truncated == true and (has("estimated_change_file_count") | not)'
}

# ---------------------------------------------------------------------------
# (ae5) standard depth: body over 500 chars -> body_preview_truncated true,
#       marker appended, body_total_chars reflects the real length, and a
#       warnings[] entry is emitted.
# ---------------------------------------------------------------------------
@test "standard depth: body over 500 chars -> body_preview_truncated true + marker + body_total_chars + warnings entry" {
    PAD="$(printf '%*s' 700 '')"
    PAD="${PAD// /z}"
    BODY="${AC_STUB}${PAD}"
    BODY_LEN=${#BODY}
    FIXTURE="$FIXTURE_DIR/body-preview-truncated-596.json"
    make_fixture "$FIXTURE" "feat: long body" "$BODY"
    run analyze "$FIXTURE" 57 --depth standard
    [ "$status" -eq 0 ]
    echo "$output" | jq -e --argjson body_len "$BODY_LEN" '
        .body_preview_truncated == true and
        .body_total_chars == $body_len and
        (.body_preview | contains("[TRUNCATED: body_preview shows the first 500 of ")) and
        ((.body_preview | split("\n[TRUNCATED")[0] | length) == 500) and
        (.warnings | any(startswith("body_preview truncated:")))
    '
}

# ---------------------------------------------------------------------------
# (ae6) standard depth: body under 500 chars -> body_preview_truncated false,
#       body_preview equals the full body verbatim, no warnings entry.
# ---------------------------------------------------------------------------
@test "standard depth: body under 500 chars -> body_preview_truncated false, body_preview == body" {
    BODY="${AC_STUB}Short body under 500 chars."
    FIXTURE="$FIXTURE_DIR/body-preview-not-truncated-596.json"
    make_fixture "$FIXTURE" "feat: short body" "$BODY"
    run analyze "$FIXTURE" 58 --depth standard
    [ "$status" -eq 0 ]
    echo "$output" | jq -e --arg body "$BODY" '
        .body_preview == $body and
        .body_preview_truncated == false and
        ((.warnings | any(startswith("body_preview truncated:"))) | not)
    '
}

# ---------------------------------------------------------------------------
# (ae7) standard depth: scope / scope_truncated / scope_total_chars are
#       present at standard depth too (not contract-mode only), and a
#       warnings[] entry is emitted when scope is truncated.
# ---------------------------------------------------------------------------
@test "standard depth: scope / scope_truncated / scope_total_chars present; >4000 non-AC body -> scope_truncated true + warnings entry" {
    PAD="$(printf '%*s' 4500 '')"
    PAD="${PAD// /w}"
    BODY="${AC_STUB}${PAD}"
    FIXTURE="$FIXTURE_DIR/standard-scope-truncated-596.json"
    make_fixture "$FIXTURE" "feat: long scope standard" "$BODY"
    run analyze "$FIXTURE" 59 --depth standard
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '
        .scope_truncated == true and
        (.scope | contains("[TRUNCATED: scope shows")) and
        (.warnings | any(startswith("scope truncated:")))
    '
}

# ---------------------------------------------------------------------------
# (ae8) comprehensive depth: scope_truncated / body_preview_truncated keys
#       are present and boolean (short body -> both false), scope is a string.
# ---------------------------------------------------------------------------
@test "comprehensive depth: scope_truncated / body_preview_truncated keys present and boolean" {
    FIXTURE="$FIXTURE_DIR/comprehensive-truncation-keys-596.json"
    make_fixture "$FIXTURE" "Add a button" "${COMPREHENSIVE_STUB}Just a UI tweak, nothing else."
    run analyze "$FIXTURE" 60 --depth comprehensive
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '
        (.scope_truncated == false) and
        (.body_preview_truncated == false) and
        (.scope | type == "string")
    '
}

# ---------------------------------------------------------------------------
# issue_body (issue #668): raw body (AC section included) capped at the scope
# limit (4000 chars), same marker / boolean convention as scope. dev-flow.js
# hands it to dev-implementer as the issue text.
# ---------------------------------------------------------------------------
@test "contract mode: issue_body is the raw body verbatim (AC section included) when under 4000 chars" {
    FIXTURE="$FIXTURE_DIR/issue-body-short.json"
    BODY="## 背景"$'\n'"Some context here."$'\n\n'"## 受け入れ基準"$'\n'"- [ ] AC one"$'\n'"- [ ] AC two"
    make_fixture "$FIXTURE" "feat: add issue_body" "$BODY"
    run analyze "$FIXTURE" 668 --contract
    [ "$status" -eq 0 ]
    echo "$output" | jq -e --arg body "$BODY" '
        .issue_body == $body and
        .issue_body_truncated == false and
        (.issue_body | contains("## 受け入れ基準")) and
        (.scope | contains("## 受け入れ基準") | not)
    '
}

@test "contract mode: issue_body over 4000 chars -> truncated to 4000 + marker, issue_body_truncated true" {
    FIXTURE="$FIXTURE_DIR/issue-body-long.json"
    LONG=$(printf 'x%.0s' $(seq 1 4500))
    BODY="## 背景"$'\n'"${LONG}"$'\n\n'"## 受け入れ基準"$'\n'"- [ ] AC one"$'\n'
    make_fixture "$FIXTURE" "feat: add issue_body" "$BODY"
    run analyze "$FIXTURE" 668 --contract
    [ "$status" -eq 0 ]
    echo "$output" | jq -e --arg body "$BODY" '
        .issue_body_truncated == true and
        (.issue_body | startswith($body[0:4000])) and
        (.issue_body | contains("[TRUNCATED: issue_body shows the first 4000 of")) and
        (.issue_body | contains("## 受け入れ基準") | not)
    '
}

@test "standard depth: issue_body / issue_body_truncated present (verbatim body under the cap)" {
    FIXTURE="$FIXTURE_DIR/issue-body-standard.json"
    BODY="${AC_STUB}Short body for standard depth."
    make_fixture "$FIXTURE" "Add a button" "$BODY"
    run analyze "$FIXTURE" 668 --depth standard
    [ "$status" -eq 0 ]
    echo "$output" | jq -e --arg body "$BODY" '.issue_body == $body and .issue_body_truncated == false'
}
