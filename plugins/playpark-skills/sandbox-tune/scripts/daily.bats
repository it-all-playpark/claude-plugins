#!/usr/bin/env bats
# Tests for sandbox-tune/scripts/daily.sh と install-schedule.sh
#
# HOME / TMPDIR は一時ディレクトリ、launchctl は PATH stub にして、実ディレクトリと実 launchd には触れない。
# daily.sh の run は、daily.sh を一時ディレクトリに写して隣に置いた sandbox-tune.sh の stub に置き換える
# （stub は受け取った引数を記録する）。最後の 1 件だけは install-schedule.sh --print の plist の
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
    echo '{"issue":{"repo":"o/r"}}' > "$CONFIG"

    STUB="$BATS_TEST_TMPDIR/stub"
    LAUNCHCTL_CALLS="$BATS_TEST_TMPDIR/launchctl-calls"
    mkdir -p "$STUB"
    printf '#!/bin/sh\nprintf "%%s\\n" "$*" >> "%s"\n' "$LAUNCHCTL_CALLS" > "$STUB/launchctl"
    chmod +x "$STUB/launchctl"
    export PATH="$STUB:$PATH"

    # daily.sh の写しと、run の stub（sandbox-tune.sh）
    STUB_SCRIPTS="$BATS_TEST_TMPDIR/scripts"
    RUN_ARGS="$BATS_TEST_TMPDIR/run-args"
    mkdir -p "$STUB_SCRIPTS"
    cp "$SCRIPTS/daily.sh" "$STUB_SCRIPTS/daily.sh"

    # 日次の下書きの段階の stub。ANALYSIS は run の要約が指す集計結果（resolved の型を読む）、
    # REC は recurring の出力、DRAFT_ARGS は draft の引数の記録、DRAFT_RC は draft の終了コード。
    # claude は受け取った引数を CLAUDE_ARGS に記録し、CLAUDE_OUT の中身を出して CLAUDE_RC で終わる
    ANALYSIS="$BATS_TEST_TMPDIR/analysis.json"
    echo '{"types":[]}' > "$ANALYSIS"
    REC="$BATS_TEST_TMPDIR/recurring"
    echo '[]' > "$REC"
    DRAFT_ARGS="$BATS_TEST_TMPDIR/draft-args"
    DRAFT_RC="$BATS_TEST_TMPDIR/draft-rc"
    echo 0 > "$DRAFT_RC"
    CLAUDE_ARGS="$BATS_TEST_TMPDIR/claude-args"
    CLAUDE_OUT="$BATS_TEST_TMPDIR/claude-out"
    CLAUDE_RC="$BATS_TEST_TMPDIR/claude-rc"
    : > "$CLAUDE_OUT"
    echo 0 > "$CLAUDE_RC"
    cat > "$STUB/claude" <<EOF
#!/bin/sh
printf '%s\n' "\$@" > "$CLAUDE_ARGS"
cat "$CLAUDE_OUT"
exit \$(cat "$CLAUDE_RC")
EOF
    chmod +x "$STUB/claude"
    DRAFTS_ROOT="$(dirname "$CONFIG")/claudedocs/sandbox-tune-drafts"
    TRIAGED="$LOGS/triaged.json"
    mkdir -p "$LOGS"
}

# run の stub を成功させる。途中の行のあとに、本物の run と同じ形の要約 JSON を最終行に出す
stub_run_ok() {
    cat > "$STUB_SCRIPTS/sandbox-tune.sh" <<EOF
case "\$1" in
  run)
    printf '%s\n' "\$@" > "$RUN_ARGS"
    echo 'progress line'
    echo '{"report":"r.md","analysis":"$ANALYSIS","verified":true,"types":5,"remaining":3,"stale_branch":1,"resolved":1,"recurring":2}' ;;
  recurring) cat "$REC" ;;
  config) cat "\$3" ;;
  draft)
    printf '%s\n' "\$@" > "$DRAFT_ARGS"
    echo 'draft: 伏せ字に失敗' >&2
    exit \$(cat "$DRAFT_RC") ;;
esac
EOF
}

# LLM の出力。前後に地の文を置き、候補ブロックを 1 つ持つ
claude_says() {
    {
        echo 'ここまでの判断:'
        echo '<!-- sandbox-tune-daily-candidates:begin -->'
        printf '%s\n' "$1"
        echo '<!-- sandbox-tune-daily-candidates:end -->'
        echo 'おわり'
    } > "$CLAUDE_OUT"
}

CAND_B='{"candidates":[{"id":"b","title":"t","cause":"c","fix":"f","safety":"s","ac":["a"],"paths":["p"],"security":false}],"skipped":[]}'

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
}

@test "daily: triaged.json が無い初回は今の recurring を判断済みとして書くだけで claude を呼ばない" {
    stub_run_ok
    echo '["a","b"]' > "$REC"
    run bash "$STUB_SCRIPTS/daily.sh" --config "$CONFIG"
    [ "$status" -eq 0 ]
    [ "$(jq -c . "$TRIAGED")" = '["a","b"]' ]
    [ ! -e "$CLAUDE_ARGS" ]
    jq -e --arg root "$DRAFTS_ROOT" '.new_recurring == 0 and .drafts == 0 and .drafts_root == $root and .draft_error == null' "$LOGS/runs.jsonl"
}

@test "daily: 判断済みでない recurring だけを claude -p に渡し、候補を draft で下書きにして、扱われた型だけ判断済みに足す" {
    stub_run_ok
    # r は判断済みだったが resolved になったので外す。c は LLM が候補にも skipped にも挙げないので翌日に回す
    echo '["a","r"]' > "$TRIAGED"
    echo '{"types":[{"id":"r","status":"resolved"},{"id":"a","status":"remaining"}]}' > "$ANALYSIS"
    echo '["a","b","c"]' > "$REC"
    claude_says "$CAND_B"
    run bash "$STUB_SCRIPTS/daily.sh" --config "$CONFIG"
    [ "$status" -eq 0 ]
    [ "$(cat "$CLAUDE_ARGS")" = "-p
/playpark-skills:sandbox-tune --daily --analysis $ANALYSIS --ids b,c --config $CONFIG" ]
    dir="$(dirname "$(sed -n '/^--candidates$/{n;p;}' "$DRAFT_ARGS")")"
    [[ "$dir" == "$DRAFTS_ROOT/"* ]]
    [ "$(cat "$DRAFT_ARGS")" = "draft
--issue
--analysis
$ANALYSIS
--candidates
$dir/triage.json
--ids
b
--out
$dir
--config
$CONFIG" ]
    # 候補ブロックの中身だけを triage.json に書き、LLM の出力全体は llm.log に残す
    [ "$(jq -c . "$dir/triage.json")" = "$(jq -c . <<<"$CAND_B")" ]
    grep -q 'おわり' "$dir/llm.log"
    [ "$(jq -c . "$TRIAGED")" = '["a","b"]' ]
    jq -e --arg root "$DRAFTS_ROOT" '.new_recurring == 2 and .drafts == 1 and .drafts_root == $root and .draft_error == null' "$LOGS/runs.jsonl"

    # 翌日は判断済みでない c だけを回す。skipped に挙がれば下書きは作らず判断済みにする
    rm -f "$DRAFT_ARGS"
    claude_says '{"candidates":[],"skipped":[{"id":"c","class":"noise","reason":"一回限り"}]}'
    run bash "$STUB_SCRIPTS/daily.sh" --config "$CONFIG"
    [ "$status" -eq 0 ]
    [[ "$(cat "$CLAUDE_ARGS")" == *"--ids c --config"* ]]
    [ ! -e "$DRAFT_ARGS" ]
    [ "$(jq -c . "$TRIAGED")" = '["a","b","c"]' ]
    [ "$(tail -n 1 "$LOGS/runs.jsonl" | jq -c '[.new_recurring, .drafts, .draft_error]')" = '[1,0,null]' ]

    # 新しい再発が無ければ claude を呼ばない
    rm -f "$CLAUDE_ARGS"
    run bash "$STUB_SCRIPTS/daily.sh" --config "$CONFIG"
    [ "$status" -eq 0 ]
    [ ! -e "$CLAUDE_ARGS" ]
    [ "$(tail -n 1 "$LOGS/runs.jsonl" | jq -c '[.new_recurring, .drafts]')" = '[0,0]' ]
}

@test "daily: claude の失敗・候補ブロックが無い・draft の失敗では新しい再発を判断済みにせず、理由を draft_error に出して exit 0" {
    stub_run_ok
    echo '["a"]' > "$TRIAGED"
    echo '["a","b"]' > "$REC"

    claude_says "$CAND_B"
    echo 3 > "$CLAUDE_RC"
    run bash "$STUB_SCRIPTS/daily.sh" --config "$CONFIG"
    [ "$status" -eq 0 ]
    [ "$(tail -n 1 "$LOGS/runs.jsonl" | jq -r '.draft_error')" = "claude exited 3" ]
    [ "$(jq -c . "$TRIAGED")" = '["a"]' ]

    echo 0 > "$CLAUDE_RC"
    echo 'ブロックなし' > "$CLAUDE_OUT"
    run bash "$STUB_SCRIPTS/daily.sh" --config "$CONFIG"
    [ "$status" -eq 0 ]
    [ "$(tail -n 1 "$LOGS/runs.jsonl" | jq -r '.draft_error')" = "no candidates block in LLM output" ]
    [ "$(jq -c . "$TRIAGED")" = '["a"]' ]

    # 要素が object でない候補ブロックも、jq で落ちずに同じく draft_error にする
    claude_says '{"candidates":["b"],"skipped":[]}'
    run bash "$STUB_SCRIPTS/daily.sh" --config "$CONFIG"
    [ "$status" -eq 0 ]
    [ "$(tail -n 1 "$LOGS/runs.jsonl" | jq -r '.draft_error')" = "no candidates block in LLM output" ]
    [ "$(jq -c . "$TRIAGED")" = '["a"]' ]

    claude_says "$CAND_B"
    echo 2 > "$DRAFT_RC"
    run bash "$STUB_SCRIPTS/daily.sh" --config "$CONFIG"
    [ "$status" -eq 0 ]
    tail -n 1 "$LOGS/runs.jsonl" | jq -e '.drafts == 0 and (.draft_error | startswith("draft failed:") and contains("伏せ字に失敗"))'
    [ "$(jq -c . "$TRIAGED")" = '["a"]' ]

    # 設定に issue.repo が無ければ draft は必ず失敗するので、claude を呼ばずに draft_error を出す
    echo '{}' > "$CONFIG"
    rm -f "$CLAUDE_ARGS"
    run bash "$STUB_SCRIPTS/daily.sh" --config "$CONFIG"
    [ "$status" -eq 0 ]
    [ ! -e "$CLAUDE_ARGS" ]
    [ "$(tail -n 1 "$LOGS/runs.jsonl" | jq -r '.draft_error')" = "no issue.repo in config; drafts need it" ]
    [ "$(jq -c . "$TRIAGED")" = '["a"]' ]
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
