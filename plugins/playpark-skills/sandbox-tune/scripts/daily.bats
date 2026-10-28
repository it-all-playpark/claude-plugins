#!/usr/bin/env bats
bats_require_minimum_version 1.5.0
# Tests for sandbox-tune/scripts/daily.sh と install-schedule.sh
#
# HOME / TMPDIR は一時ディレクトリ、launchctl は PATH stub にして、実ディレクトリと実 launchd には触れない。
# daily.sh の run は、daily.sh を一時ディレクトリに写して隣に置いた sandbox-tune.sh の stub に置き換える
# （stub は受け取った引数を記録し、集計 JSON は $ANALYSIS を指す。run 以外の subcommand は本物に渡す）。
# claude は PATH stub にして、引数・stdin・呼び出し回数を記録し $CLAUDE_OUT を返す（sandbox の中からは API に届かない）。
# gh は PATH stub で、提出先を非公開 repo として返す。最後の 1 件だけは install-schedule.sh --print の plist の
# ProgramArguments を本物の daily.sh / sandbox-tune.sh でそのまま実行して、日次ジョブの起動を再現する。

setup() {
    SCRIPTS="$BATS_TEST_DIRNAME"
    INSTALL="$SCRIPTS/install-schedule.sh"
    REPO_ROOT="$(git -C "$SCRIPTS" rev-parse --show-toplevel)"

    export HOME="$BATS_TEST_TMPDIR/home"
    export TMPDIR="$BATS_TEST_TMPDIR/tmp"
    mkdir -p "$HOME" "$TMPDIR"
    LOGS="$HOME/.claude/logs/sandbox-tune"
    CONFIG="$BATS_TEST_TMPDIR/conf/sandbox-tune.json"
    mkdir -p "$(dirname "$CONFIG")"
    echo '{}' > "$CONFIG"

    STUB="$BATS_TEST_TMPDIR/stub"
    LAUNCHCTL_CALLS="$BATS_TEST_TMPDIR/launchctl-calls"
    mkdir -p "$STUB"
    printf '#!/bin/sh\nprintf "%%s\\n" "$*" >> "%s"\n' "$LAUNCHCTL_CALLS" > "$STUB/launchctl"
    chmod +x "$STUB/launchctl"
    export PATH="$STUB:$PATH"

    export CLAUDE_CALLS="$BATS_TEST_TMPDIR/claude-calls"
    export CLAUDE_ARGS="$BATS_TEST_TMPDIR/claude-args"
    export CLAUDE_STDIN="$BATS_TEST_TMPDIR/claude-stdin"
    export CLAUDE_OUT="$BATS_TEST_TMPDIR/claude-out"
    export CLAUDE_ERR_TEXT=""
    export CLAUDE_EXIT=0
    cat > "$STUB/claude" <<'EOF'
#!/usr/bin/env bash
echo call >> "$CLAUDE_CALLS"
printf '%s\n' "$@" > "$CLAUDE_ARGS"
cat > "$CLAUDE_STDIN"
cat "$CLAUDE_OUT"
[ -z "$CLAUDE_ERR_TEXT" ] || echo "$CLAUDE_ERR_TEXT" >&2
exit "$CLAUDE_EXIT"
EOF
    printf '#!/bin/sh\n[ "$1 $2" = "repo view" ] && echo PRIVATE\nexit 0\n' > "$STUB/gh"
    chmod +x "$STUB/claude" "$STUB/gh"

    # daily.sh の写しと、daily.sh が読む判断基準・schema・jq、run の stub（sandbox-tune.sh）
    STUB_SCRIPTS="$BATS_TEST_TMPDIR/scripts"
    RUN_ARGS="$BATS_TEST_TMPDIR/run-args"
    ANALYSIS="$BATS_TEST_TMPDIR/analysis.json"
    mkdir -p "$STUB_SCRIPTS"
    cp "$SCRIPTS/daily.sh" "$SCRIPTS/issue.jq" "$SCRIPTS/criteria.md" "$SCRIPTS/daily-prompt.md" "$SCRIPTS/triage-schema.json" "$STUB_SCRIPTS/"
    write_analysis "remaining true $A" "remaining true $B" "remaining true $OLD" "remaining false $ONCE" "resolved false $FIXED"
}

A="sandbox:network:a.example.test"
B="sandbox:path:/etc/b"
OLD="sandbox:network:old.example.test"
ONCE="sandbox:network:once.example.test"
FIXED="sandbox:network:fixed.example.test"

# 集計 JSON（verify 済み）を $ANALYSIS に書く。引数 1 つが型 1 つで `<status> <recurring> <id>`
write_analysis() {
    printf '%s\n' "$@" | jq -R -s '
        {period: {since: "2026-09-01T00:00:00Z", until: "2026-10-01T00:00:00Z", days: 30},
         verify: {repo: "~/dotfiles", paths: ["settings.json"]},
         types: [split("\n")[] | select(. != "") | capture("^(?<status>[a-z_]+) (?<rec>true|false) (?<id>.+)$")
           | {id, kind: "network", target: (.id | split(":")[2]), needle: (.id | split(":")[2]),
              count: 3, sessions: 2, first_seen: "2026-09-20T00:00:00Z", last_seen: "2026-09-30T00:00:00Z",
              projects: ["~/src/app"], examples: ["Operation not permitted: \(.id)"], example_cwds: [["~/src/app"]],
              occurrences: [{ts: "2026-09-30T00:00:00Z", cwd: "~/src/app", git_branch: "main"}],
              status, evidence: {commit: null}, recurring: (.rec == "true")}]}' > "$ANALYSIS"
}

# run の stub を成功させる。途中の行のあとに、本物の run と同じ形の要約 JSON を最終行に出す。$1 は verified（既定 true）
stub_run_ok() {
    cat > "$STUB_SCRIPTS/sandbox-tune.sh" <<EOF
[ "\$1" = run ] || exec bash "$SCRIPTS/sandbox-tune.sh" "\$@"
printf '%s\n' "\$@" > "$RUN_ARGS"
echo 'progress line'
echo '{"report":"r.md","analysis":"$ANALYSIS","verified":${1:-true},"types":5,"remaining":3,"stale_branch":1,"resolved":1,"recurring":2}'
EOF
}

# 下書きを作れる設定: git repo（claudedocs/ を無視）に置き、criteriaFiles と issue.repo を持つ
triage_config() {
    export GIT_CEILING_DIRECTORIES="$BATS_TEST_TMPDIR"
    CONF_DIR="$(dirname "$CONFIG")"
    DRAFTS_ROOT="$CONF_DIR/claudedocs/sandbox-tune-drafts"
    git init -q "$CONF_DIR"
    printf 'claudedocs/\n' > "$CONF_DIR/.gitignore"
    printf '# 運用ルール\n\nRULE-MARKER: 資格情報を sandbox の外に出さない\n' > "$CONF_DIR/RULES.md"
    jq -n '{criteriaFiles: ["RULES.md"], issue: {repo: "acme/dotfiles"}}' > "$CONFIG"
}

# 判断済みの記録を書く（引数が型の id）
write_triaged() {
    mkdir -p "$LOGS"
    printf '%s\n' "$@" | jq -R -s -c 'split("\n") | map(select(. != ""))' > "$LOGS/triaged.json"
}

# claude の stub が返す出力（.structured_output に $1 を入れる）
claude_returns() {
    jq -n --argjson s "$1" '{type: "result", subtype: "success", is_error: false, result: "", structured_output: $s}' > "$CLAUDE_OUT"
}

candidate() {
    jq -nc --arg id "$1" '{id: $id, title: "\($id) を許可する", cause: "許可リストに無い", fix: "allowedDomains に足す",
        safety: "取得先が 1 ホスト増えるだけ", ac: ["sandbox 内の curl が exit 0 で終わる"], paths: ["claude/settings.json"], security: false}'
}

# stdin の新しい再発の型（```json の区間）
stdin_types() {
    sed -n '/^```json$/,/^```$/p' "$CLAUDE_STDIN" | sed '1d;$d'
}

# run の stub を exit $1 で失敗させる。stderr に 15 行出し、最後の行がエラーの本文
stub_run_fail() {
    cat > "$STUB_SCRIPTS/sandbox-tune.sh" <<EOF
printf '%s\n' "\$@" > "$RUN_ARGS"
for i in \$(seq 1 14); do echo "noise \$i" >&2; done
echo 'sandbox-tune: run: 設定がありません' >&2
exit $1
EOF
}

@test "install-schedule --print: 毎日 06:30 に checkout の daily.sh を --config の絶対パス付き・登録時の PATH で起動する plist" {
    # --config は cwd 相対で渡しても絶対パスにして書く
    cd "$(dirname "$CONFIG")"
    run bash "$INSTALL" --print --repo "$SCRIPTS" --config sandbox-tune.json
    [ "$status" -eq 0 ]
    expected="$(cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.playpark.sandbox-tune</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$REPO_ROOT/plugins/playpark-skills/sandbox-tune/scripts/daily.sh</string>
    <string>--config</string>
    <string>$CONFIG</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO_ROOT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$PATH</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>6</integer>
    <key>Minute</key><integer>30</integer>
  </dict>
  <key>StandardOutPath</key><string>$HOME/.claude/logs/sandbox-tune.log</string>
  <key>StandardErrorPath</key><string>$HOME/.claude/logs/sandbox-tune.err.log</string>
</dict>
</plist>
PLIST
)"
    [ "$output" = "$expected" ]

    # launchd は ~ を展開しないので、~/ 始まりは $HOME の絶対パスにして書く
    mkdir -p "$HOME/dotfiles"
    echo '{}' > "$HOME/dotfiles/sandbox-tune.json"
    run bash "$INSTALL" --print --repo "$SCRIPTS" --config '~/dotfiles/sandbox-tune.json'
    [ "$status" -eq 0 ]
    [[ "$output" == *"<string>--config</string>
    <string>$HOME/dotfiles/sandbox-tune.json</string>
  </array>"* ]]
}

@test "install-schedule --print: --repo か --config が無ければ usage を出して非 0、checkout でない・設定が無いなら error" {
    run bash "$INSTALL" --print --config "$CONFIG"
    [ "$status" -ne 0 ]
    [[ "$output" == *"Usage:"* ]]
    run bash "$INSTALL" --print --repo "$SCRIPTS"
    [ "$status" -ne 0 ]
    [[ "$output" == *"Usage:"* ]]
    run bash "$INSTALL" --install --repo "$SCRIPTS"
    [ "$status" -ne 0 ]
    [[ "$output" == *"Usage:"* ]]

    mkdir -p "$BATS_TEST_TMPDIR/not-git"
    run bash "$INSTALL" --print --repo "$BATS_TEST_TMPDIR/not-git" --config "$CONFIG"
    [ "$status" -ne 0 ]
    [[ "$output" == *"git checkout"* ]]
    git init -q "$BATS_TEST_TMPDIR/other"
    run bash "$INSTALL" --print --repo "$BATS_TEST_TMPDIR/other" --config "$CONFIG"
    [ "$status" -ne 0 ]
    [[ "$output" == *"daily.sh"* ]]
    run bash "$INSTALL" --print --repo "$SCRIPTS" --config "$BATS_TEST_TMPDIR/missing.json"
    [ "$status" -ne 0 ]
    [[ "$output" == *"--config"* ]]
}

@test "install-schedule --install / --uninstall: plist を書いて bootstrap し、解除は bootout と plist 削除だけ" {
    plist="$HOME/Library/LaunchAgents/com.playpark.sandbox-tune.plist"
    run bash "$INSTALL" --install --repo "$SCRIPTS" --config "$CONFIG"
    [ "$status" -eq 0 ]
    [ -f "$plist" ]
    grep -q "<string>$CONFIG</string>" "$plist"
    grep -qx "bootstrap gui/$(id -u) $plist" "$LAUNCHCTL_CALLS"

    run bash "$INSTALL" --uninstall
    [ "$status" -eq 0 ]
    [ ! -e "$plist" ]
    [ "$(tail -n 1 "$LAUNCHCTL_CALLS")" = "bootout gui/$(id -u) $plist" ]
}

@test "daily: run を出力先 ~/.claude/logs/sandbox-tune で走らせ、成功したら最終行の要約に ts を足して runs.jsonl に追記する" {
    stub_run_ok
    run bash "$STUB_SCRIPTS/daily.sh" --config "$CONFIG"
    [ "$status" -eq 0 ]
    [ "$(cat "$RUN_ARGS")" = "run
--config
$CONFIG
--out
$LOGS" ]

    [ "$(wc -l < "$LOGS/runs.jsonl" | tr -d ' ')" = "1" ]
    jq -e --arg a "$ANALYSIS" '(.ts | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))
        and .remaining == 3 and .types == 5 and .stale_branch == 1 and .resolved == 1 and .recurring == 2 and .verified == true
        and .report == "r.md" and .analysis == $a' "$LOGS/runs.jsonl"
    [ "$output" = "$(cat "$LOGS/runs.jsonl")" ]
    # 下書き段階の結果も同じ行に入る（triaged.json が無い初回なので記録するだけ）
    jq -e --arg r "$BATS_TEST_TMPDIR/conf/claudedocs/sandbox-tune-drafts" \
        '.new_recurring == 0 and .drafts == 0 and .drafts_root == $r and .draft_error == null' "$LOGS/runs.jsonl"

    # 実行ごとに 1 行ずつ追記する（前の行を消さない）
    run bash "$STUB_SCRIPTS/daily.sh" --config "$CONFIG"
    [ "$status" -eq 0 ]
    [ "$(wc -l < "$LOGS/runs.jsonl" | tr -d ' ')" = "2" ]
    # 一時ファイルを出力先に残さない
    [ "$(find "$LOGS" -name '.run-*' | wc -l | tr -d ' ')" = "0" ]
}

@test "daily: run が非 0 なら ts・exit・stderr の末尾 error を持つ 1 行を runs.jsonl に追記し、run の終了コードで終わる" {
    stub_run_fail 2
    run bash "$STUB_SCRIPTS/daily.sh" --config "$CONFIG"
    [ "$status" -eq 2 ]
    [ "$(wc -l < "$LOGS/runs.jsonl" | tr -d ' ')" = "1" ]
    jq -e '(.ts | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))
        and .exit == 2
        and (.error | endswith("sandbox-tune: run: 設定がありません"))
        and (.error | contains("noise 5") | not)
        and (has("remaining") | not)' "$LOGS/runs.jsonl"
    # launchd の stderr ログにも run の stderr を流す
    [[ "$output" == *"sandbox-tune: run: 設定がありません"* ]]

    stub_run_fail 7
    run bash "$STUB_SCRIPTS/daily.sh" --config "$CONFIG"
    [ "$status" -eq 7 ]
    [ "$(tail -n 1 "$LOGS/runs.jsonl" | jq '.exit')" = "7" ]
    [ "$(wc -l < "$LOGS/runs.jsonl" | tr -d ' ')" = "2" ]
    [ ! -e "$CLAUDE_CALLS" ]
}

@test "daily: --config のディレクトリが無く本物の run が失敗しても {ts, exit, error} の行を runs.jsonl に残す" {
    run bash "$SCRIPTS/daily.sh" --config "$BATS_TEST_TMPDIR/missing/sandbox-tune.json"
    [ "$status" -eq 2 ]
    jq -e '(keys == ["error", "exit", "ts"]) and .exit == 2 and (.error | contains("設定ファイルがありません"))' "$LOGS/runs.jsonl"
    [ ! -e "$CLAUDE_CALLS" ]
}

@test "daily: 新しい再発があれば claude をツールなしで 1 回だけ起動し、型・criteriaFiles・判断基準を stdin で渡して、判断と下書きを置き場に書く" {
    triage_config
    stub_run_ok
    write_triaged "$OLD"
    claude_returns "$(jq -nc --argjson c "$(candidate "$A")" --arg b "$B" \
        '{candidates: [$c], skipped: [{id: $b, class: "noise", reason: "報告文を依頼と数えた"}]}')"
    run bash "$STUB_SCRIPTS/daily.sh" --config "$CONFIG"
    [ "$status" -eq 0 ]
    [ "$output" = "$(cat "$LOGS/runs.jsonl")" ]

    # 1 回だけ、ツール・skill・MCP・session を持たない形で起動する（skill の呼び出しを引数に含まない）
    [ "$(wc -l < "$CLAUDE_CALLS" | tr -d ' ')" = "1" ]
    expected_args="$(printf '%s\n' -p --tools "" --safe-mode --strict-mcp-config --disable-slash-commands --no-session-persistence \
        --max-budget-usd 1 --output-format json --json-schema "$(jq -c . "$SCRIPTS/triage-schema.json")")"
    [ "$(cat "$CLAUDE_ARGS")" = "$expected_args" ]
    run ! grep -q 'playpark-skills:sandbox-tune' "$CLAUDE_ARGS"

    # stdin: 判断基準・criteriaFiles の本文・新しい再発の型（analysis の該当型そのもの。判断済み・recurring でない型は渡さない）
    grep -qF '## 安全性の基準' "$CLAUDE_STDIN"
    grep -qF '**unclear**' "$CLAUDE_STDIN"
    grep -qF 'RULE-MARKER: 資格情報を sandbox の外に出さない' "$CLAUDE_STDIN"
    [ "$(stdin_types | jq -c .)" = "$(jq -c --arg a "$A" --arg b "$B" '[.types[] | select(.id == $a or .id == $b)]' "$ANALYSIS")" ]
    run ! grep -qF "$OLD" "$CLAUDE_STDIN"
    run ! grep -qF "$ONCE" "$CLAUDE_STDIN"

    # 置き場: 設定のディレクトリの claudedocs/sandbox-tune-drafts/<実行時刻>/ に triage.json と candidates の下書き
    run_dirs="$(ls "$DRAFTS_ROOT")"
    [[ "$run_dirs" =~ ^[0-9]{8}T[0-9]{6}Z$ ]]
    d="$DRAFTS_ROOT/$run_dirs"
    [ "$(jq -c . "$d/triage.json")" = "$(jq -c .structured_output "$CLAUDE_OUT")" ]
    [ -f "$d/sandbox-tune-issue-1.md" ]
    [ "$(jq -r .id "$d/sandbox-tune-issue-1.meta.json")" = "$A" ]
    [ "$(jq -r .repo "$d/sandbox-tune-issue-1.meta.json")" = "acme/dotfiles" ]
    [ ! -e "$d/sandbox-tune-issue-2.md" ]

    # candidates と skipped に挙がった型が判断済みになる
    [ "$(jq -c . "$LOGS/triaged.json")" = "$(jq -nc --arg a "$A" --arg b "$B" --arg o "$OLD" '[$a, $b, $o] | sort')" ]
    jq -e --arg r "$DRAFTS_ROOT" '.new_recurring == 2 and .drafts == 1 and .drafts_root == $r and .draft_error == null' "$LOGS/runs.jsonl"
}

@test "daily: candidates にも skipped にも挙がらなかった型は判断済みにせず、翌日の run で再び新しい再発として渡す" {
    triage_config
    stub_run_ok
    write_triaged "$OLD"
    claude_returns "$(jq -nc --arg a "$A" '{candidates: [], skipped: [{id: $a, class: "intended", reason: "permissions.deny で止めている"}]}')"
    run bash "$STUB_SCRIPTS/daily.sh" --config "$CONFIG"
    [ "$status" -eq 0 ]
    [ "$(jq -c . "$LOGS/triaged.json")" = "$(jq -nc --arg a "$A" --arg o "$OLD" '[$a, $o] | sort')" ]
    jq -e '.new_recurring == 2 and .drafts == 0 and .draft_error == null' "$LOGS/runs.jsonl"

    claude_returns "$(jq -nc --arg b "$B" '{candidates: [], skipped: [{id: $b, class: "unclear", reason: "代表例だけでは言い切れない"}]}')"
    run bash "$STUB_SCRIPTS/daily.sh" --config "$CONFIG"
    [ "$status" -eq 0 ]
    [ "$(wc -l < "$CLAUDE_CALLS" | tr -d ' ')" = "2" ]
    [ "$(stdin_types | jq -c '[.[].id]')" = "$(jq -nc --arg b "$B" '[$b]')" ]
    [ "$(jq -c . "$LOGS/triaged.json")" = "$(jq -nc --arg a "$A" --arg b "$B" --arg o "$OLD" '[$a, $b, $o] | sort')" ]
    [ "$(tail -n 1 "$LOGS/runs.jsonl" | jq -c '[.new_recurring, .drafts, .draft_error]')" = '[1,0,null]' ]
}

@test "daily: 初回（triaged.json が無い）・新しい再発が無い・issue.repo が無い・verify していない run では claude を呼ばない" {
    triage_config
    stub_run_ok
    # 初回は今の recurring を判断済みとして記録するだけ
    run bash "$STUB_SCRIPTS/daily.sh" --config "$CONFIG"
    [ "$status" -eq 0 ]
    [ "$(jq -c . "$LOGS/triaged.json")" = "$(jq -nc --arg a "$A" --arg b "$B" --arg o "$OLD" '[$a, $b, $o] | sort')" ]
    [ "$(tail -n 1 "$LOGS/runs.jsonl" | jq -c '[.new_recurring, .drafts, .draft_error]')" = '[0,0,null]' ]
    # 新しい再発が無い
    run bash "$STUB_SCRIPTS/daily.sh" --config "$CONFIG"
    [ "$status" -eq 0 ]
    [ "$(tail -n 1 "$LOGS/runs.jsonl" | jq -c '[.new_recurring, .drafts, .draft_error]')" = '[0,0,null]' ]
    # issue.repo が無い（新しい再発は判断済みにしない）
    write_triaged "$OLD"
    jq -n '{criteriaFiles: ["RULES.md"]}' > "$CONFIG"
    run bash "$STUB_SCRIPTS/daily.sh" --config "$CONFIG"
    [ "$status" -eq 0 ]
    [ "$(tail -n 1 "$LOGS/runs.jsonl" | jq -c '[.new_recurring, .drafts, .draft_error]')" = '[2,0,null]' ]
    [ "$(jq -c . "$LOGS/triaged.json")" = "$(jq -nc --arg o "$OLD" '[$o]')" ]
    # verify していない run
    jq -n '{criteriaFiles: ["RULES.md"], issue: {repo: "acme/dotfiles"}}' > "$CONFIG"
    stub_run_ok false
    run bash "$STUB_SCRIPTS/daily.sh" --config "$CONFIG"
    [ "$status" -eq 0 ]
    [ "$(tail -n 1 "$LOGS/runs.jsonl" | jq -c '[.new_recurring, .drafts, .draft_error]')" = '[null,0,null]' ]
    [ "$(jq -c . "$LOGS/triaged.json")" = "$(jq -nc --arg o "$OLD" '[$o]')" ]

    [ ! -e "$CLAUDE_CALLS" ]
    [ ! -e "$DRAFTS_ROOT" ]
}

@test "daily: resolved になった型は triaged.json から外れる" {
    triage_config
    stub_run_ok
    write_triaged "$A" "$B" "$OLD" "$FIXED"
    run bash "$STUB_SCRIPTS/daily.sh" --config "$CONFIG"
    [ "$status" -eq 0 ]
    [ "$(jq -c . "$LOGS/triaged.json")" = "$(jq -nc --arg a "$A" --arg b "$B" --arg o "$OLD" '[$a, $b, $o] | sort')" ]
    [ ! -e "$CLAUDE_CALLS" ]
}

@test "daily: claude の失敗・出力の誤り・draft の失敗では理由入りの draft_error を残し、新しい再発を判断済みにせず、run の終了コードで終わる" {
    triage_config
    stub_run_ok
    local ok_skip
    ok_skip="$(jq -nc --arg b "$B" '[{id: $b, class: "noise", reason: "r"}]')"
    # <draft_error に含む文> と、claude の stub の設定（CLAUDE_EXIT / 出力）を 1 件ずつ試す
    check() {
        write_triaged "$OLD"
        run bash "$STUB_SCRIPTS/daily.sh" --config "$CONFIG"
        [ "$status" -eq 0 ]
        tail -n 1 "$LOGS/runs.jsonl" | jq -e --arg m "$1" '(.draft_error | contains($m)) and .new_recurring == 2'
        [ "$(jq -c . "$LOGS/triaged.json")" = "$(jq -nc --arg o "$OLD" '[$o]')" ]
    }

    # claude の非 0 終了（stderr の末尾が理由に入る）
    claude_returns '{"candidates": [], "skipped": []}'
    export CLAUDE_EXIT=3 CLAUDE_ERR_TEXT="budget exceeded"
    check "claude が exit 3 で終わりました: budget exceeded"
    export CLAUDE_EXIT=0 CLAUDE_ERR_TEXT=""
    # .structured_output が無い
    echo '{"type":"result","is_error":true,"result":"x"}' > "$CLAUDE_OUT"
    check ".structured_output"
    # candidates が candidates_errors で誤り（ac が無い）
    claude_returns "$(jq -nc --argjson c "$(candidate "$A" | jq -c 'del(.ac)')" --argjson s "$ok_skip" '{candidates: [$c], skipped: $s}')"
    check "ac は空でない文字列の配列にしてください"
    # skipped の要素が object でない・id が文字列でない・class が無い
    claude_returns "$(jq -nc --arg a "$A" '{candidates: [], skipped: [$a]}')"
    check "skipped[0] は id（文字列）と class を持つオブジェクトにしてください"
    claude_returns '{"candidates": [], "skipped": [{"id": 1, "class": "noise"}]}'
    check "skipped[0] は id（文字列）と class を持つオブジェクトにしてください"
    claude_returns "$(jq -nc --arg a "$A" '{candidates: [], skipped: [{id: $a, reason: "r"}]}')"
    check "skipped[0] は id（文字列）と class を持つオブジェクトにしてください"
    # draft の失敗（集計に無い id の候補）
    claude_returns "$(jq -nc --argjson c "$(candidate sandbox:network:ghost.example.test)" --argjson s "$ok_skip" '{candidates: [$c], skipped: $s}')"
    check "draft が exit 2 で終わりました: sandbox-tune: draft: レポートにない id です: sandbox:network:ghost.example.test"

    [ "$(wc -l < "$CLAUDE_CALLS" | tr -d ' ')" = "7" ]
}

@test "daily: 下書き置き場が git に無視されていると確かめられない（無視されない・git repo でない）ときは claude を呼ばず、何も書かずに draft_error を出す" {
    triage_config
    stub_run_ok
    # git repo だが claudedocs/ を無視していない
    : > "$CONF_DIR/.gitignore"
    write_triaged "$OLD"
    run bash "$STUB_SCRIPTS/daily.sh" --config "$CONFIG"
    [ "$status" -eq 0 ]
    jq -e --arg r "$DRAFTS_ROOT" '(.draft_error | contains("git check-ignore") and contains($r)) and .drafts == 0' "$LOGS/runs.jsonl"
    [ ! -e "$CONF_DIR/claudedocs" ]
    [ "$(jq -c . "$LOGS/triaged.json")" = "$(jq -nc --arg o "$OLD" '[$o]')" ]

    # git repo でない
    plain="$BATS_TEST_TMPDIR/plain"
    mkdir -p "$plain"
    printf 'claudedocs/\n' > "$plain/.gitignore"
    cp "$CONF_DIR/RULES.md" "$CONFIG" "$plain/"
    run bash "$STUB_SCRIPTS/daily.sh" --config "$plain/sandbox-tune.json"
    [ "$status" -eq 0 ]
    tail -n 1 "$LOGS/runs.jsonl" | jq -e --arg r "$plain/claudedocs/sandbox-tune-drafts" '(.draft_error | contains("git check-ignore") and contains($r)) and .drafts_root == $r'
    [ ! -e "$plain/claudedocs" ]

    [ ! -e "$CLAUDE_CALLS" ]
}

@test "日次ジョブの plist の ProgramArguments を実行すると、本物の run のレポートが ~/.claude/logs/sandbox-tune に書かれ要約が runs.jsonl に残る" {
    mkdir -p "$HOME/.claude/projects"
    cfg_repo="$BATS_TEST_TMPDIR/dotfiles"
    git init -q "$cfg_repo"
    echo '{}' > "$cfg_repo/settings.json"
    git -C "$cfg_repo" add settings.json
    git -C "$cfg_repo" -c user.name=t -c user.email=t@example.com commit -q -m init
    jq -n --arg p "$cfg_repo" '{configRepo: {path: $p, paths: ["settings.json"]}}' > "$CONFIG"

    bash "$INSTALL" --print --repo "$SCRIPTS" --config "$CONFIG" > "$BATS_TEST_TMPDIR/plist"
    # ProgramArguments の /bin/bash 以降を 1 行ずつ取り出す
    awk '/<key>ProgramArguments<\/key>/ { f = 1; next }
         f && /<\/array>/ { exit }
         f && /<string>/ { sub(/^ *<string>/, ""); sub(/<\/string>$/, ""); print }' "$BATS_TEST_TMPDIR/plist" \
        | tail -n +2 > "$BATS_TEST_TMPDIR/job-args"
    job_args=()
    while IFS= read -r a; do job_args+=("$a"); done < "$BATS_TEST_TMPDIR/job-args"
    [ "${job_args[1]}" = "--config" ]

    run bash "${job_args[@]}"
    [ "$status" -eq 0 ]
    jq -e '.ts and .verified == true and .remaining == 0 and .recurring == 0' "$LOGS/runs.jsonl"
    report="$(jq -r '.report' "$LOGS/runs.jsonl")"
    [[ "$report" == "$LOGS/sandbox-tune-"*".md" ]]
    [ -f "$report" ]
}
