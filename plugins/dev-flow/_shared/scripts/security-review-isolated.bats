#!/usr/bin/env bats
bats_require_minimum_version 1.5.0

# Tests for bin/security-review-isolated（_shared/scripts/security-review-isolated.sh → _lib/scripts/security-review-isolated.mjs。issue #1083）
#
# 指示ファイルを変える PR の security review を、PR の worktree に入らない別の claude -p プロセスで人が回す CLI。
# fixture は bare origin（main + PR head の feature/x）+ clone した ROOT（人が実行する repo の checkout）。gh と claude は stub する。
# claude の stub は起動時の cwd・argv・stdin（prompt）と、prompt の diff_path が起動時に読めたかを記録し、
# CLAUDE_STUB_RESPONSE の内容を stdout に出す。

BIN="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)/bin/security-review-isolated"

setup() {
    ORIGIN="$BATS_TEST_TMPDIR/origin.git"
    git init --bare -q "$ORIGIN"

    SEED="$BATS_TEST_TMPDIR/seed"
    git init -q -b main "$SEED"
    git -C "$SEED" config user.name "Test"
    git -C "$SEED" config user.email "test@example.com"
    echo "# seed" > "$SEED/README.md"
    git -C "$SEED" add README.md
    git -C "$SEED" commit -q -m "init"
    git -C "$SEED" checkout -q -b feature/x
    echo "PR_CHANGE_MARKER" > "$SEED/CLAUDE.md"
    git -C "$SEED" add CLAUDE.md
    git -C "$SEED" commit -q -m "pr commit"
    git -C "$SEED" remote add origin "$ORIGIN"
    git -C "$SEED" push -q origin main feature/x
    git -C "$ORIGIN" symbolic-ref HEAD refs/heads/main
    HEAD_SHA="$(git -C "$SEED" rev-parse feature/x)"

    # 人の checkout は main のまま（PR head は fetch で取り込む）
    ROOT="$BATS_TEST_TMPDIR/root"
    git clone -q "$ORIGIN" "$ROOT"
    ROOT_P="$(cd "$ROOT" && pwd -P)"

    # 一時ディレクトリ（保存先・空の cwd）は checkout の外の専用ディレクトリに作らせ、後始末を確かめる
    export TMPDIR="$BATS_TEST_TMPDIR/tmp"
    mkdir -p "$TMPDIR"

    STUB_DIR="$BATS_TEST_TMPDIR/stub-bin"
    mkdir -p "$STUB_DIR"
    cat >"$STUB_DIR/gh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$GH_STUB_LOG"
cat "$GH_STUB_FIXTURE"
STUB
    cat >"$STUB_DIR/claude" <<'STUB'
#!/usr/bin/env bash
pwd -P >"$CLAUDE_STUB_DIR/cwd"
ls -A | wc -l | tr -d ' ' >"$CLAUDE_STUB_DIR/cwd_entries"
printf '%s\n' "$@" >"$CLAUDE_STUB_DIR/argv"
cat >"$CLAUDE_STUB_DIR/prompt"
diff_path="$(sed -n 's/^diff_path: //p' "$CLAUDE_STUB_DIR/prompt")"
if [[ -f "$diff_path" ]]; then cp "$diff_path" "$CLAUDE_STUB_DIR/diff"; fi
cat "$CLAUDE_STUB_RESPONSE"
exit "${CLAUDE_STUB_EXIT:-0}"
STUB
    chmod +x "$STUB_DIR/gh" "$STUB_DIR/claude"
    export PATH="$STUB_DIR:$PATH"
    export GH_STUB_LOG="$BATS_TEST_TMPDIR/gh.log"
    export GH_STUB_FIXTURE="$BATS_TEST_TMPDIR/pr.json"
    export CLAUDE_STUB_DIR="$BATS_TEST_TMPDIR/claude-rec"
    export CLAUDE_STUB_RESPONSE="$BATS_TEST_TMPDIR/claude-response.json"
    mkdir -p "$CLAUDE_STUB_DIR"
    unset CLAUDE_STUB_EXIT
    jq -n --arg oid "$HEAD_SHA" '{headRefOid: $oid, baseRefName: "main"}' >"$GH_STUB_FIXTURE"
}

# 第 1 引数: issues の JSON 配列。第 2 引数: reviewed_sha（省略時は PR head）
respond() {
    jq -n --argjson issues "$1" --arg sha "${2:-$HEAD_SHA}" \
        '{type: "result", is_error: false, result: "", structured_output: {reviewed_sha: $sha, issues: $issues, summary: "SUMMARY_TEXT"}}' \
        >"$CLAUDE_STUB_RESPONSE"
}

MAJOR_ISSUE='[{"severity":"major","topic":"hook-injection","file":"CLAUDE.md","line":1,"description":"MAJOR_DESCRIPTION_BODY","suggestion":"MAJOR_SUGGESTION"}]'

# ---- AC-1: 起動の形（cwd・--agent・prompt の diff_path と head_sha）----

@test "clear: 空の新しいディレクトリ（checkout の外・保存先の祖先でない）を cwd に claude -p --agent dev-flow:security-reviewer を起動し、prompt に diff_path と head_sha を渡す" {
    respond '[]'
    cd "$ROOT"
    run bash "$BIN" 5
    [ "$status" -eq 0 ]

    grep -qxF 'pr view 5 --json headRefOid,baseRefName' "$GH_STUB_LOG"

    cwd="$(cat "$CLAUDE_STUB_DIR/cwd")"
    [[ "$(basename "$cwd")" == dev-flow-security-review-cwd-* ]]
    [[ "$cwd" != "$ROOT_P" && "$cwd" != "$ROOT_P"/* ]]
    [ "$(cat "$CLAUDE_STUB_DIR/cwd_entries")" = "0" ]

    # argv: -p と --agent dev-flow:security-reviewer
    grep -qxF -- '-p' "$CLAUDE_STUB_DIR/argv"
    [ "$(grep -xF -A1 -- '--agent' "$CLAUDE_STUB_DIR/argv" | sed -n 2p)" = "dev-flow:security-reviewer" ]
    # argv: tool は Read / Grep / Glob だけ、許可は保存先の配下の Read だけ、他は拒否、project / local 設定を読まない
    [ "$(grep -xF -A1 -- '--tools' "$CLAUDE_STUB_DIR/argv" | sed -n 2p)" = "Read,Grep,Glob" ]
    [ "$(grep -xF -A1 -- '--permission-mode' "$CLAUDE_STUB_DIR/argv" | sed -n 2p)" = "dontAsk" ]
    [ "$(grep -xF -A1 -- '--setting-sources' "$CLAUDE_STUB_DIR/argv" | sed -n 2p)" = "user" ]
    allowed="$(grep -xF -A1 -- '--allowedTools' "$CLAUDE_STUB_DIR/argv" | sed -n 2p)"

    # prompt は securityReviewPrompt（DATA 区間に head_sha と diff_path）
    grep -qxF '<<<SECURITY_REVIEW_DATA_BEGIN>>>' "$CLAUDE_STUB_DIR/prompt"
    grep -qxF "head_sha: $HEAD_SHA" "$CLAUDE_STUB_DIR/prompt"
    diff_path="$(sed -n 's/^diff_path: //p' "$CLAUDE_STUB_DIR/prompt")"
    review_dir="$(dirname "$diff_path")"
    [[ "$(basename "$review_dir")" =~ ^dev-flow-security-review-[A-Za-z0-9]{6}$ ]]
    [ "$(basename "$diff_path")" = "pr.diff" ]
    [[ "$review_dir" != "$ROOT_P"/* ]]
    [[ "$review_dir" != "$cwd"/* ]]
    [ "$allowed" = "Read(/${review_dir}/**)" ]
    # 保存した diff は origin/main...PR head（起動時に読めた）
    grep -qF '+PR_CHANGE_MARKER' "$CLAUDE_STUB_DIR/diff"

    # stdout: 判定・件数・review した head
    [[ "$output" == *"判定: clear（critical / major 0 件）"* ]]
    [[ "$output" == *"件数: critical 0 / major 0 / minor 0"* ]]
    [[ "$output" == *"review した head: $HEAD_SHA"* ]]

    # 空の cwd と diff の保存先は後始末する（結果をファイルに残さない）
    [ -z "$(ls -A "$TMPDIR")" ]
}

@test "--repo owner/repo は gh pr view に渡す" {
    respond '[]'
    cd "$ROOT"
    run bash "$BIN" 5 --repo acme/skills
    [ "$status" -eq 0 ]
    grep -qxF 'pr view 5 --repo acme/skills --json headRefOid,baseRefName' "$GH_STUB_LOG"
}

@test "一時ディレクトリが checkout の中なら claude を起動せず exit 2" {
    respond '[]'
    export TMPDIR="$ROOT/tmp"
    mkdir -p "$TMPDIR"
    cd "$ROOT"
    run bash "$BIN" 5
    [ "$status" -eq 2 ]
    [[ "$output" == *"一時ディレクトリが checkout の中にある"* ]]
    [ ! -e "$CLAUDE_STUB_DIR/argv" ]
    [[ "$output" != *"clear"* ]]
}

@test "checkout の HEAD が PR head（PR の worktree）なら claude を起動せず exit 2" {
    respond '[]'
    cd "$ROOT"
    git checkout -q "$HEAD_SHA"
    run bash "$BIN" 5
    [ "$status" -eq 2 ]
    [[ "$output" == *"checkout の HEAD が PR の変更を含む"* ]]
    [ ! -e "$CLAUDE_STUB_DIR/argv" ]
    [[ "$output" != *"clear"* ]]
}

@test "checkout の HEAD が PR の commit の上に積んだ branch でも exit 2" {
    respond '[]'
    cd "$ROOT"
    git checkout -q -b local-on-pr "$HEAD_SHA"
    git -c user.name=T -c user.email=t@example.com commit -q --allow-empty -m "local"
    run bash "$BIN" 5
    [ "$status" -eq 2 ]
    [ ! -e "$CLAUDE_STUB_DIR/argv" ]
}

# ---- AC-2: 応答の判定（SECURITY_REVIEW_SCHEMA + securityReviewVerdict）----

@test "critical / major が残れば exit 1 で、判定・件数・指摘の本文を stdout に出す" {
    respond "$MAJOR_ISSUE"
    cd "$ROOT"
    run bash "$BIN" 5
    [ "$status" -eq 1 ]
    [[ "$output" == *"判定: 指摘あり（critical / major が残っている）"* ]]
    [[ "$output" == *"件数: critical 0 / major 1 / minor 0"* ]]
    [[ "$output" == *"review した head: $HEAD_SHA"* ]]
    [[ "$output" == *"[major] hook-injection — CLAUDE.md:1"* ]]
    [[ "$output" == *"MAJOR_DESCRIPTION_BODY"* ]]
    [[ "$output" == *"MAJOR_SUGGESTION"* ]]
    [[ "$output" == *"SUMMARY_TEXT"* ]]
    [[ "$output" != *"判定: clear"* ]]
}

@test "minor だけなら clear（exit 0）で minor の件数と本文を出す" {
    respond '[{"severity":"minor","topic":"t","file":"a.sh","description":"MINOR_BODY","suggestion":"s"}]'
    cd "$ROOT"
    run bash "$BIN" 5
    [ "$status" -eq 0 ]
    [[ "$output" == *"件数: critical 0 / major 0 / minor 1"* ]]
    [[ "$output" == *"MINOR_BODY"* ]]
}

@test "reviewed_sha が PR head と一致しなければ exit 2 で clear と出さない" {
    respond '[]' "0123456789012345678901234567890123456789"
    cd "$ROOT"
    run bash "$BIN" 5
    [ "$status" -eq 2 ]
    [[ "$output" == *"判定: 判定できない（reviewed_sha が PR head と一致しない"* ]]
    [[ "$output" == *"review した head: 0123456789012345678901234567890123456789"* ]]
    [[ "$output" != *"clear"* ]]
}

@test "応答から JSON を取り出せなければ exit 2 で clear と出さない" {
    printf '%s\n' '{"type":"result","is_error":false,"result":"looks safe to me"}' >"$CLAUDE_STUB_RESPONSE"
    cd "$ROOT"
    run bash "$BIN" 5
    [ "$status" -eq 2 ]
    [[ "$output" == *"判定: 判定できない（reviewer の応答から JSON を取り出せない）"* ]]
    [[ "$output" != *"clear"* ]]

    printf '%s\n' 'not json at all' >"$CLAUDE_STUB_RESPONSE"
    run bash "$BIN" 5
    [ "$status" -eq 2 ]
    [[ "$output" != *"clear"* ]]
}

@test "SECURITY_REVIEW_SCHEMA に合わない応答（severity が enum 外・required 欠落）は exit 2" {
    respond '[{"severity":"high","topic":"t","file":"f","description":"d","suggestion":"s"}]'
    cd "$ROOT"
    run bash "$BIN" 5
    [ "$status" -eq 2 ]
    [[ "$output" == *"SECURITY_REVIEW_SCHEMA に合わない"* ]]
    [[ "$output" != *"clear"* ]]

    jq -n --arg sha "$HEAD_SHA" '{type: "result", is_error: false, structured_output: {reviewed_sha: $sha, issues: []}}' >"$CLAUDE_STUB_RESPONSE"
    run bash "$BIN" 5
    [ "$status" -eq 2 ]
    [[ "$output" != *"clear"* ]]
}

@test "structured_output が無ければ result の本文の JSON を判定に使う" {
    jq -n --arg sha "$HEAD_SHA" --argjson issues "$MAJOR_ISSUE" \
        '{type: "result", is_error: false, result: ({reviewed_sha: $sha, issues: $issues, summary: "s"} | tojson)}' >"$CLAUDE_STUB_RESPONSE"
    cd "$ROOT"
    run bash "$BIN" 5
    [ "$status" -eq 1 ]
    [[ "$output" == *"MAJOR_DESCRIPTION_BODY"* ]]
}

@test "claude が非 0 で終われば exit 2 で clear と出さない" {
    respond '[]'
    export CLAUDE_STUB_EXIT=1
    cd "$ROOT"
    run bash "$BIN" 5
    [ "$status" -eq 2 ]
    [[ "$output" != *"clear"* ]]
}

@test "指摘の本文の制御文字（ESC 等）は落として端末に出す" {
    respond '[{"severity":"major","topic":"t","file":"f","description":"A\u001b[2JB","suggestion":"s"}]'
    cd "$ROOT"
    run bash "$BIN" 5
    [ "$status" -eq 1 ]
    [[ "$output" == *"A?[2JB"* ]]
    [[ "$output" != *$'\e'* ]]
}

@test "PR 番号が無い・数字でないときは usage で exit 2（gh も claude も呼ばない）" {
    cd "$ROOT"
    run bash "$BIN"
    [ "$status" -eq 2 ]
    run bash "$BIN" abc
    [ "$status" -eq 2 ]
    run bash "$BIN" 5 --repo
    [ "$status" -eq 2 ]
    [ ! -e "$GH_STUB_LOG" ]
    [ ! -e "$CLAUDE_STUB_DIR/argv" ]
}
