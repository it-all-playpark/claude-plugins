#!/usr/bin/env bats
# Tests for dev-flow-health/scripts/health-report.sh
#
# Focus 1: signature 化（パス・数値・PR 番号・hash の <*> 化）と new / ongoing / resolved / regressed の判定
#          — tests/fixtures/lifecycle.jsonl（plugin_commit は架空の hex）を journal に展開して確かめる。
# Focus 2: 候補 commit の列挙 — 一時 git repo を作り、その commit を plugin_commit に持つ journal で確かめる。
# Focus 3: 起票先（issue_repo）の解決と、SKILL.md の起票手順がそれだけを使うこと。

bats_require_minimum_version 1.5.0

setup() {
    SKILL_DIR="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
    SCRIPT="$SKILL_DIR/scripts/health-report.sh"
    FIXTURES="$SKILL_DIR/tests/fixtures"

    JOURNAL="$BATS_TEST_TMPDIR/journal"
    mkdir -p "$JOURNAL"
    NOW="2026-10-05T00:00:00Z"
}

# lifecycle.jsonl の各行を _file の名前で journal に書く
load_fixture() {
    local line name
    while IFS= read -r line; do
        [[ -n "$line" ]] || continue
        name="$(printf '%s' "$line" | jq -r '._file')"
        printf '%s' "$line" | jq 'del(._file)' > "$JOURNAL/$name"
    done < "$FIXTURES/$1"
}

report() {
    bash "$SCRIPT" --journal-dir "$JOURNAL" --now "$NOW" "$@"
}

sig_field() {
    # $1 = template の部分一致, $2 = jq path
    printf '%s' "$output" | jq -r --arg t "$1" "[.signatures[] | select(.template | contains(\$t))] | first | $2"
}

# --- signature ----------------------------------------------------------------

@test "message のパス・PR 番号・hash・数値は <*> になり、同じ型の失敗は 1 signature にまとまる" {
    load_fixture lifecycle.jsonl
    run report --repo "$BATS_TEST_TMPDIR/no-repo"
    [ "$status" -eq 0 ]

    [ "$(sig_field 'tests red' .template)" = "validate failed: <*> tests red in PR <*>" ]
    [ "$(sig_field 'tests red' .count)" = "2" ]
    [ "$(sig_field 'tests red' .signature)" = "dev-flow | test | Validate | validate failed: <*> tests red in PR <*>" ]
    [ "$(sig_field 'pr create' .template)" = "abort@PR/pr-create: gh pr create exited <*> for PR <*> at <*>" ]
    [ "$(sig_field 'agent returned null' .template)" = "abort@Implement/impl<*>: agent returned null in <*>" ]
    [ "$(sig_field 'tests red' '.id | test("^[0-9a-f]{12}$")')" = "true" ]
}

@test "hook 由来の entry と dev-flow / pr-iterate 以外の skill は読まない" {
    load_fixture lifecycle.jsonl
    run report
    [ "$status" -eq 0 ]
    [ "$(printf '%s' "$output" | jq '[.signatures[] | select(.template | test("hook-captured|not a dev-flow run"))] | length')" = "0" ]
    [ "$(printf '%s' "$output" | jq '.runs["dev-flow"]')" = "12" ]
    [ "$(printf '%s' "$output" | jq '.runs["pr-iterate"]')" = "1" ]
}

@test "needs_clarification（analyze ゲート等の設計どおりの停止）は窓内でも signature にしない" {
    load_fixture lifecycle.jsonl
    run report
    [ "$status" -eq 0 ]
    # fixture の 10-04T16:00 の needs_clarification 停止は窓内だが new にならない
    [ "$(printf '%s' "$output" | jq '[.signatures[] | select(.category == "needs_clarification" or (.template | test("AC 空")))] | length')" = "0" ]
    [ "$(printf '%s' "$output" | jq '.summary.new')" = "2" ]
}

@test "壊れた journal ファイルがあっても残りを読んで判定する" {
    load_fixture lifecycle.jsonl
    echo '{not valid json' > "$JOURNAL/2026-10-04-21-00-00-dev-flow-999.json"
    run report
    [ "$status" -eq 0 ]
    [ "$(printf '%s' "$output" | jq '.runs["dev-flow"]')" = "12" ]
}

@test "PR phase 失敗（error_category pr_phase_failed）は category / phase PR の signature になり、worktree パスと番号の違う run は 1 つにまとまる" {
    load_fixture pr-phase-failed.jsonl
    run report --repo "$BATS_TEST_TMPDIR/no-repo"
    [ "$status" -eq 0 ]

    [ "$(printf '%s' "$output" | jq '[.signatures[] | select(.category == "pr_phase_failed")] | length')" = "2" ]
    [ "$(sig_field 'step: push' .signature)" = "dev-flow | pr_phase_failed | PR | dev-flow: PR phase 失敗（step: push、reason: error: failed to push some refs to 'github.com:o/r.git'、push 出力全文: <*> proxy 応答 pr_url=\"\" pr_number=<*> committed=true。closes-check / nested pr-iterate へは進まない" ]
    [ "$(sig_field 'step: push' .count)" = "2" ]
    [ "$(sig_field 'step: push' .status)" = "new" ]
    [ "$(sig_field 'step: push' .candidates.first_bad_commit)" = "ddddddddddd4" ]
    [ "$(sig_field 'step: push' .candidates.last_good_commit)" = "bbbbbbbbbbb2" ]
    # commit 段の失敗は push とは別の signature
    [ "$(sig_field 'step: commit' .category)" = "pr_phase_failed" ]
    [ "$(sig_field 'step: commit' .phase)" = "PR" ]
    [ "$(sig_field 'step: commit' .count)" = "1" ]
    [ "$(printf '%s' "$output" | jq '.needs_llm')" = "true" ]
}

# --- 解消済みの判定 -------------------------------------------------------------

@test "last_seen と別の commit で N 回（既定 5）成功し再発しなければ resolved" {
    load_fixture lifecycle.jsonl
    run report
    [ "$status" -eq 0 ]
    [ "$(printf '%s' "$output" | jq '.resolve_after_runs')" = "5" ]
    [ "$(sig_field 'agent returned null' .status)" = "resolved" ]
    [ "$(sig_field 'agent returned null' .last_seen.plugin_commit)" = "aaaaaaaaaaa1" ]
    # 09-01 以後の別 commit の run は 10 件あるが、成功は 09-04..09-08 の 5 件だけ（失敗 run は数えない）
    [ "$(sig_field 'agent returned null' .clean_runs_since_last_seen)" = "5" ]
    [ "$(sig_field 'agent returned null' .candidates)" = "null" ]
}

@test "別 commit の run が N 回に届かなければ resolved にしない（ongoing）" {
    load_fixture lifecycle.jsonl
    run report
    [ "$status" -eq 0 ]
    # 09-12（ccccccccccc3）以後で commit が違う dev-flow run は 10-04 の ddddddddddd4 の 2 件だけで、どちらも失敗
    [ "$(sig_field 'tests red' .status)" = "ongoing" ]
    [ "$(sig_field 'tests red' .clean_runs_since_last_seen)" = "0" ]
    [ "$(sig_field 'tests red' .first_seen.timestamp)" = "2026-09-10T00:00:00Z" ]
    [ "$(sig_field 'tests red' .last_seen.timestamp)" = "2026-09-12T00:00:00Z" ]
    [ "$(sig_field 'tests red' .last_seen.plugin_commit)" = "ccccccccccc3" ]
}

@test "同じ commit の run は何回あっても resolved の根拠にしない" {
    load_fixture lifecycle.jsonl
    for n in 1 2 3 4 5 6; do
        jq -n --arg ts "2026-09-13T00:00:0${n}Z" \
            '{skill:"dev-flow", outcome:"success", source:"skill", timestamp:$ts, telemetry:{plugin_commit:"ccccccccccc3"}}' \
            > "$JOURNAL/2026-09-13-00-00-0${n}-dev-flow-20${n}.json"
    done
    run report
    [ "$status" -eq 0 ]
    [ "$(sig_field 'tests red' .status)" = "ongoing" ]
}

@test "別 commit でも別の失敗で止まった run は resolved の根拠にしない" {
    load_fixture lifecycle.jsonl
    for n in 1 2 3 4 5 6; do
        jq -n --arg ts "2026-09-13T00:00:0${n}Z" \
            '{skill:"dev-flow", outcome:"failure", source:"skill", timestamp:$ts, telemetry:{plugin_commit:"eeeeeeeeeee5"},
              error:{category:"abort", phase:"Implement", message:"abort@Implement/impl#1: other failure"}}' \
            > "$JOURNAL/2026-09-13-00-00-0${n}-dev-flow-30${n}.json"
    done
    run report
    [ "$status" -eq 0 ]
    [ "$(sig_field 'tests red' .status)" = "ongoing" ]
    [ "$(sig_field 'tests red' .clean_runs_since_last_seen)" = "0" ]
}

@test "--resolve-after で N を変えられる" {
    load_fixture lifecycle.jsonl
    # agent returned null は別 commit の成功 run が 5 件 — N=6 では届かない
    run report --resolve-after 6
    [ "$status" -eq 0 ]
    [ "$(sig_field 'agent returned null' .status)" = "ongoing" ]
    run report --resolve-after 5
    [ "$status" -eq 0 ]
    [ "$(sig_field 'agent returned null' .status)" = "resolved" ]
}

@test "resolved の条件を満たした後に再び出た signature は regressed" {
    load_fixture lifecycle.jsonl
    run report
    [ "$status" -eq 0 ]
    [ "$(sig_field 'pr create' .status)" = "regressed" ]
    [ "$(sig_field 'pr create' .first_seen.timestamp)" = "2026-09-03T00:00:00Z" ]
    [ "$(sig_field 'pr create' .regressed_at.timestamp)" = "2026-10-04T18:00:00Z" ]
    [ "$(sig_field 'pr create' .regressed_at.plugin_commit)" = "ddddddddddd4" ]
    # 再発を起点に、その前で最後に成功した run の commit と比べる
    [ "$(sig_field 'pr create' .candidates.first_bad_commit)" = "ddddddddddd4" ]
    [ "$(sig_field 'pr create' .candidates.last_good_commit)" = "bbbbbbbbbbb2" ]
}

@test "窓（--since より後）に初めて出た signature は new、窓の外なら ongoing" {
    load_fixture lifecycle.jsonl
    run report
    [ "$status" -eq 0 ]
    [ "$(sig_field 'evaluator returned no verdict' .status)" = "new" ]
    [ "$(sig_field 'evaluator returned no verdict' .candidates.first_bad_commit)" = "ccccccccccc3" ]
    [ "$(sig_field 'evaluator returned no verdict' .candidates.last_good_commit)" = "bbbbbbbbbbb2" ]

    run report --since 2026-10-04T15:00:00Z
    [ "$status" -eq 0 ]
    [ "$(sig_field 'evaluator returned no verdict' .status)" = "ongoing" ]
    [ "$(sig_field 'pr create' .status)" = "regressed" ]
}

@test "窓は --since ちょうどを含まず --now ちょうどを含み、--now より後の entry は読まない" {
    write_run 2026-10-04T12:00:00Z failure "aaaaaaaaaaa1" "abort@Evaluate/eval#1: at since"
    write_run 2026-10-05T00:00:00Z failure "aaaaaaaaaaa1" "abort@Evaluate/eval#1: at now"
    write_run 2026-10-05T00:00:01Z failure "aaaaaaaaaaa1" "abort@Evaluate/eval#1: after now"

    run report --since 2026-10-04T12:00:00Z
    [ "$status" -eq 0 ]
    [ "$(sig_field 'at since' .status)" = "ongoing" ]
    [ "$(sig_field 'at now' .status)" = "new" ]
    [ "$(printf '%s' "$output" | jq '[.signatures[] | select(.template | contains("after now"))] | length')" = "0" ]
    [ "$(printf '%s' "$output" | jq '.runs["dev-flow"]')" = "2" ]

    # 次の実行は前回の --now を --since にする: at now は 2 回目には new にならず、after now が new になる
    run bash "$SCRIPT" --journal-dir "$JOURNAL" --since 2026-10-05T00:00:00Z --now 2026-10-05T00:00:01Z
    [ "$status" -eq 0 ]
    [ "$(sig_field 'at now' .status)" = "ongoing" ]
    [ "$(sig_field 'after now' .status)" = "new" ]
}

@test "skill ごとに run を数える — pr-iterate に成功 run が無ければ候補は no_prior_good_run" {
    load_fixture lifecycle.jsonl
    run report
    [ "$status" -eq 0 ]
    [ "$(sig_field 'schema mismatch' .skill)" = "pr-iterate" ]
    [ "$(sig_field 'schema mismatch' .status)" = "new" ]
    [ "$(sig_field 'schema mismatch' .candidates.error)" = "no_prior_good_run" ]
    [ "$(sig_field 'schema mismatch' .candidates.commits)" = "[]" ]
}

@test "summary と needs_llm は new / regressed の件数から決まる" {
    load_fixture lifecycle.jsonl
    run report
    [ "$status" -eq 0 ]
    [ "$(printf '%s' "$output" | jq -c '.summary')" = '{"new":2,"regressed":1,"ongoing":1,"resolved":1}' ]
    [ "$(printf '%s' "$output" | jq '.needs_llm')" = "true" ]
    [ "$(printf '%s' "$output" | jq -r '[.signatures[].status] | join(",")')" = "new,new,regressed,ongoing,resolved" ]

    # 窓を 10-05 以後に絞ると new / regressed は 0 件で needs_llm は false
    run report --since 2026-10-05T00:00:00Z
    [ "$status" -eq 0 ]
    [ "$(printf '%s' "$output" | jq -c '.summary')" = '{"new":0,"regressed":0,"ongoing":4,"resolved":1}' ]
    [ "$(printf '%s' "$output" | jq '.needs_llm')" = "false" ]
}

@test "journal が空なら signature 0 件・needs_llm false" {
    run report
    [ "$status" -eq 0 ]
    [ "$(printf '%s' "$output" | jq -c '.summary')" = '{"new":0,"regressed":0,"ongoing":0,"resolved":0}' ]
    [ "$(printf '%s' "$output" | jq '.needs_llm')" = "false" ]
}

@test "不正な引数は error JSON で exit 2" {
    run --separate-stderr report --resolve-after 0
    [ "$status" -eq 2 ]
    printf '%s' "$stderr" | jq -e '.error | test("resolve-after")'
    run --separate-stderr bash "$SCRIPT" --journal-dir "$JOURNAL" --now 2026-10-05
    [ "$status" -eq 2 ]
}

# --- 候補 commit の列挙 ----------------------------------------------------------

# plugins/dev-flow/ を触る commit と触らない commit を持つ repo を作り、各 commit の 12 桁 sha を C1..C4 に入れる
make_repo() {
    REPO="$BATS_TEST_TMPDIR/repo"
    mkdir -p "$REPO/plugins/dev-flow" "$REPO/docs"
    git -C "$REPO" init -q
    git -C "$REPO" config user.email t@t
    git -C "$REPO" config user.name t
    echo a > "$REPO/plugins/dev-flow/a.txt"
    git -C "$REPO" add -A && git -C "$REPO" commit -q -m "feat: base"
    C1="$(git -C "$REPO" rev-parse --short=12 HEAD)"
    echo b > "$REPO/docs/b.md"
    git -C "$REPO" add -A && git -C "$REPO" commit -q -m "docs: unrelated"
    C2="$(git -C "$REPO" rev-parse --short=12 HEAD)"
    echo x > "$REPO/plugins/dev-flow/x.mjs"
    git -C "$REPO" add -A && git -C "$REPO" commit -q -m "fix: change x"
    C3="$(git -C "$REPO" rev-parse --short=12 HEAD)"
    echo y > "$REPO/plugins/dev-flow/y.mjs"
    git -C "$REPO" add -A && git -C "$REPO" commit -q -m "feat: change y"
    C4="$(git -C "$REPO" rev-parse --short=12 HEAD)"
}

write_run() {
    # $1 = timestamp, $2 = outcome, $3 = commit, $4 = message（失敗時のみ）
    local ts="$1" outcome="$2" commit="$3" msg="${4:-}"
    local name
    name="$(printf '%s' "$ts" | tr 'T:' '--' | tr -d 'Z')-dev-flow-$RANDOM.json"
    jq -n --arg ts "$ts" --arg o "$outcome" --arg c "$commit" --arg m "$msg" \
        '{skill:"dev-flow", outcome:$o, source:"skill", timestamp:$ts, telemetry:{plugin_commit:$c}}
         + (if $m == "" then {} else {error:{category:"abort", phase:"Evaluate", message:$m}} end)' \
        > "$JOURNAL/$name"
}

@test "new: 最後の成功 run の commit から最初の失敗 commit までで plugins/dev-flow/ を触った commit を列挙する" {
    make_repo
    write_run 2026-09-20T00:00:00Z success "$C1"
    write_run 2026-10-04T12:00:00Z failure "$C4" "abort@Evaluate/eval#1: verdict missing"

    run report --repo "$REPO"
    [ "$status" -eq 0 ]
    [ "$(sig_field 'verdict missing' .status)" = "new" ]
    [ "$(sig_field 'verdict missing' .candidates.last_good_commit)" = "$C1" ]
    [ "$(sig_field 'verdict missing' .candidates.first_bad_commit)" = "$C4" ]
    [ "$(sig_field 'verdict missing' .candidates.error)" = "null" ]
    # docs だけを触った C2 と、成功 run の C1 自身は入らない
    [ "$(sig_field 'verdict missing' '[.candidates.commits[].subject] | join(",")')" = "feat: change y,fix: change x" ]
    [ "$(sig_field 'verdict missing' '.candidates.commits[0].sha[0:12]')" = "$C4" ]
}

@test "regressed: 再発 run の commit と、その前の最後の成功 run の commit の間を列挙する" {
    make_repo
    write_run 2026-09-01T00:00:00Z failure "$C1" "abort@Evaluate/eval#1: verdict missing"
    for d in 02 03 04 05 06; do
        write_run "2026-09-${d}T00:00:00Z" success "$C2"
    done
    write_run 2026-10-04T12:00:00Z failure "$C4" "abort@Evaluate/eval#2: verdict missing"

    run report --repo "$REPO"
    [ "$status" -eq 0 ]
    [ "$(sig_field 'verdict missing' .status)" = "regressed" ]
    [ "$(sig_field 'verdict missing' .candidates.last_good_commit)" = "$C2" ]
    [ "$(sig_field 'verdict missing' '[.candidates.commits[].subject] | join(",")')" = "feat: change y,fix: change x" ]
}

@test "repo が git checkout でなければ候補は列挙せず repo_unavailable" {
    make_repo
    write_run 2026-09-20T00:00:00Z success "$C1"
    write_run 2026-10-04T12:00:00Z failure "$C4" "abort@Evaluate/eval#1: verdict missing"

    run report --repo "$BATS_TEST_TMPDIR"
    [ "$status" -eq 0 ]
    [ "$(sig_field 'verdict missing' .candidates.error)" = "repo_unavailable" ]
    [ "$(sig_field 'verdict missing' .candidates.commits)" = "[]" ]
}

@test "repo に無い commit なら git_log_failed で止まらない" {
    make_repo
    write_run 2026-09-20T00:00:00Z success "aaaaaaaaaaa1"
    write_run 2026-10-04T12:00:00Z failure "$C4" "abort@Evaluate/eval#1: verdict missing"

    run report --repo "$REPO"
    [ "$status" -eq 0 ]
    [ "$(sig_field 'verdict missing' .candidates.error)" = "git_log_failed" ]
}

# --- 起票先（issue_repo） ----------------------------------------------------------

@test "issue_repo は --repo の checkout の origin（https / ssh の GitHub URL）から OWNER/NAME で解決する" {
    make_repo
    git -C "$REPO" remote add origin https://github.com/someone/fork-of-skills.git
    run report --repo "$REPO"
    [ "$status" -eq 0 ]
    [ "$(printf '%s' "$output" | jq -r '.issue_repo')" = "someone/fork-of-skills" ]

    git -C "$REPO" remote set-url origin git@github.com:other-org/skills
    run report --repo "$REPO"
    [ "$status" -eq 0 ]
    [ "$(printf '%s' "$output" | jq -r '.issue_repo')" = "other-org/skills" ]
}

@test "origin が無い・GitHub でない・checkout が無いときは issue_repo を null にする" {
    make_repo
    run report --repo "$REPO"
    [ "$status" -eq 0 ]
    [ "$(printf '%s' "$output" | jq '.issue_repo')" = "null" ]

    git -C "$REPO" remote add origin https://gitlab.com/someone/skills.git
    run report --repo "$REPO"
    [ "$status" -eq 0 ]
    [ "$(printf '%s' "$output" | jq '.issue_repo')" = "null" ]

    run report --repo "$BATS_TEST_TMPDIR/no-repo"
    [ "$status" -eq 0 ]
    [ "$(printf '%s' "$output" | jq '.issue_repo')" = "null" ]
}

@test "SKILL.md の gh issue 手順は起票先をレポートの issue_repo から取り、null なら起票せずに止まる" {
    local skill_md="$SKILL_DIR/SKILL.md"
    # 重複確認の gh issue list と、起票の dev-flow:git-issue 起動はどちらも --repo <issue_repo>（固定の OWNER/NAME を書かない）
    run grep -c 'gh issue list' "$skill_md"
    [ "$output" -ge 1 ]
    run grep -c 'gh issue list --repo <issue_repo> ' "$skill_md"
    [ "$output" = "$(grep -c 'gh issue list' "$skill_md")" ]
    run grep -c '^ *dev-flow:git-issue .* --repo <issue_repo> ' "$skill_md"
    [ "$output" -ge 1 ]
    # 参照するキーを script が実際に出す
    make_repo
    run report --repo "$REPO"
    [ "$(printf '%s' "$output" | jq 'has("issue_repo")')" = "true" ]
    # null のときは起票せずに終える手順がある
    grep -q '`issue_repo` が `null` なら、重複確認・起票をせずに' "$skill_md"
}

@test "LLM を呼ばない（claude を PATH に置いても起動しない）" {
    load_fixture lifecycle.jsonl
    STUB="$BATS_TEST_TMPDIR/stub"
    mkdir -p "$STUB"
    printf '#!/bin/sh\ntouch "%s/claude-called"\n' "$BATS_TEST_TMPDIR" > "$STUB/claude"
    chmod +x "$STUB/claude"
    PATH="$STUB:$PATH" run report
    [ "$status" -eq 0 ]
    [ "$(printf '%s' "$output" | jq '.needs_llm')" = "true" ]
    [ ! -f "$BATS_TEST_TMPDIR/claude-called" ]
}
