#!/usr/bin/env bats
# Tests for dev-flow-health/scripts/daily.sh と install-schedule.sh
#
# claude CLI は PATH stub に置き換え、呼ばれたら引数を記録する。
# new / regressed が 0 件の実行は stub が呼ばれないこと（LLM を起動しないこと）を確かめる。
# 振り分けの記録は、stub に SKILL.md 手順 7 の振り分けブロックを出力させて確かめる。
# HOME / CLAUDE_JOURNAL_DIR は一時ディレクトリ、launchctl は PATH stub にして、実ディレクトリと実 launchd には触れない。
# 日次ジョブと即時トリガの起動は、install-schedule.sh --print の plist の ProgramArguments をそのまま実行して再現する。

setup() {
    SKILL_DIR="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
    DAILY="$SKILL_DIR/scripts/daily.sh"
    INSTALL="$SKILL_DIR/scripts/install-schedule.sh"

    export HOME="$BATS_TEST_TMPDIR/home"
    mkdir -p "$HOME"
    JOURNAL="$BATS_TEST_TMPDIR/journal"
    export CLAUDE_JOURNAL_DIR="$JOURNAL"
    OUT="$BATS_TEST_TMPDIR/out"
    mkdir -p "$JOURNAL"
    while IFS= read -r line; do
        [[ -n "$line" ]] || continue
        name="$(printf '%s' "$line" | jq -r '._file')"
        printf '%s' "$line" | jq 'del(._file)' > "$JOURNAL/$name"
    done < "$SKILL_DIR/tests/fixtures/lifecycle.jsonl"

    STUB="$BATS_TEST_TMPDIR/stub"
    CALLS="$BATS_TEST_TMPDIR/claude-calls"
    LAUNCHCTL_CALLS="$BATS_TEST_TMPDIR/launchctl-calls"
    mkdir -p "$STUB"
    printf '#!/bin/sh\nprintf "%%s\\n" "$*" >> "%s"\n' "$CALLS" > "$STUB/claude"
    printf '#!/bin/sh\nprintf "%%s\\n" "$*" >> "%s"\n' "$LAUNCHCTL_CALLS" > "$STUB/launchctl"
    chmod +x "$STUB/claude" "$STUB/launchctl"
    export PATH="$STUB:$PATH"
}

daily() {
    bash "$DAILY" --out-dir "$OUT" --journal-dir "$JOURNAL" --repo "$BATS_TEST_TMPDIR/no-repo" "$@"
}

# SKILL.md 手順 7 の振り分けブロックの区切り行
CLASS_BEGIN='<!-- dev-flow-health-classifications:begin -->'
CLASS_END='<!-- dev-flow-health-classifications:end -->'

# claude stub を、渡されたレポートの new / regressed の全 signature に classification を付けたブロックを出力する形にする。
# $1 = 空白区切りの classification。1 語ごとに 1 ブロックを順に出す（途中の下書き → 最後の確定、を再現する）。$2 = 終了コード
stub_claude_classify() {
    {
        printf '#!/bin/sh\nprintf "%%s\\n" "$*" >> "%s"\n' "$CALLS"
        printf 'report="${2#/dev-flow:dev-flow-health }"\n'
        printf 'echo "new / regressed を振り分けました"\n'
        for c in $1; do
            printf "echo '%s'\n" "$CLASS_BEGIN"
            printf 'jq %s "$report"\n' \
                "'[.signatures[] | select(.status == \"new\" or .status == \"regressed\") | {id, signature, classification: \"$c\", reason: \"test\", issue: null}]'"
            printf "echo '%s'\n" "$CLASS_END"
        done
        printf 'exit %s\n' "${2:-0}"
    } > "$STUB/claude"
    chmod +x "$STUB/claude"
}

# claude stub を、$1 のファイルの中身をそのまま出力する形にする
stub_claude_print() {
    printf '#!/bin/sh\ncat "%s"\n' "$1" > "$STUB/claude"
    chmod +x "$STUB/claude"
}

claude_calls() {
    if [[ -f "$CALLS" ]]; then wc -l < "$CALLS" | tr -d ' '; else echo 0; fi
}

# $1 = timestamp, $2 = error.message — fixture の「evaluator returned no verdict」と同じ skill / category / phase の失敗 entry
write_failure() {
    local name
    name="$(printf '%s' "$1" | tr 'T:' '--' | tr -d 'Z')-dev-flow-$RANDOM.json"
    jq -n --arg ts "$1" --arg m "$2" \
        '{skill:"dev-flow", outcome:"failure", source:"skill", timestamp:$ts, telemetry:{plugin_commit:"eeeeeeeeeee5"},
          error:{category:"runtime", phase:"Evaluate", message:$m}}' > "$JOURNAL/$name"
}

# install-schedule.sh --print の plist（stdin）から ProgramArguments の /bin/bash 以降を 1 行ずつ出す
plist_args() {
    awk '/<key>ProgramArguments<\/key>/ { f = 1; next }
         f && /<\/array>/ { exit }
         f && /<string>/ { sub(/^ *<string>/, ""); sub(/<\/string>$/, ""); print }' | tail -n +2
}

# $1 = --print に足す引数（"" または --watch-journal）。結果を JOB_ARGS 配列に入れる
load_job_args() {
    bash "$INSTALL" --print --repo "$SKILL_DIR" $1 | plist_args > "$BATS_TEST_TMPDIR/job-args"
    JOB_ARGS=()
    while IFS= read -r a; do JOB_ARGS+=("$a"); done < "$BATS_TEST_TMPDIR/job-args"
}

# 日次ジョブ / 即時トリガの plist の ProgramArguments を --now 付きで実行する（出力先は既定の $HOME/.claude/logs/dev-flow-health）
run_daily_job() {
    load_job_args ""
    bash "${JOB_ARGS[@]}" --now "$1"
}
run_watch_trigger() {
    load_job_args --watch-journal
    bash "${JOB_ARGS[@]}" --now "$1"
}

@test "new / regressed が 0 件の実行は LLM（claude）を呼ばずにレポートだけ書く" {
    # 窓 10-05..10-06 には fixture の失敗が無い
    run daily --now 2026-10-06T00:00:00Z
    [ "$status" -eq 0 ]
    [ "$(printf '%s' "$output" | jq '.needs_llm')" = "false" ]
    [ "$(printf '%s' "$output" | jq '.llm_invoked')" = "false" ]
    [ ! -f "$CALLS" ]
    [ "$(printf '%s' "$output" | jq -r '.report')" = "$OUT/2026-10-06T000000Z.json" ]
    [ "$(jq -c '.summary' "$OUT/2026-10-06T000000Z.json")" = '{"new":0,"regressed":0,"ongoing":4,"resolved":1}' ]
}

@test "new / regressed がある実行だけ claude -p で dev-flow-health skill にレポートを渡す" {
    run daily --now 2026-10-05T00:00:00Z
    [ "$status" -eq 0 ]
    [ "$(printf '%s' "$output" | jq '.needs_llm')" = "true" ]
    [ "$(printf '%s' "$output" | jq '.llm_invoked')" = "true" ]
    [ "$(printf '%s' "$output" | jq '.llm_exit')" = "0" ]
    [ "$(claude_calls)" = "1" ]
    [ "$(cat "$CALLS")" = "-p /dev-flow:dev-flow-health $OUT/2026-10-05T000000Z.json" ]
    [ "$(jq '.summary.new + .summary.regressed' "$OUT/2026-10-05T000000Z.json")" = "3" ]
}

@test "窓の始点は同じ日の分も含む直前の実行の generated_at — 実行が空いても取りこぼさず、日付名のレポートは読まない" {
    mkdir -p "$OUT"
    echo '{"generated_at":"2026-10-04T15:00:00Z"}' > "$OUT/2026-10-04T150000Z.json"
    echo '{"generated_at":"2026-10-04T20:00:00Z"}' > "$OUT/2026-10-04.json"
    run daily --now 2026-10-04T23:00:00Z
    [ "$status" -eq 0 ]
    [ "$(jq -r '.window.since' "$OUT/2026-10-04T230000Z.json")" = "2026-10-04T15:00:00Z" ]
    # 10-04T18:00 の再発が窓に入る
    [ "$(jq '.summary.regressed' "$OUT/2026-10-04T230000Z.json")" = "1" ]
    [ "$(printf '%s' "$output" | jq '.llm_invoked')" = "true" ]
}

@test "同じ signature の失敗が続いても、2 回続けた実行で LLM を起動するのは 1 回だけ — レポートは実行ごとに別ファイル" {
    run daily --now 2026-10-05T00:00:00Z
    [ "$status" -eq 0 ]
    [ "$(claude_calls)" = "1" ]

    write_failure 2026-10-05T03:00:00Z "evaluator returned no verdict"
    run daily --now 2026-10-05T06:00:00Z
    [ "$status" -eq 0 ]
    [ "$(printf '%s' "$output" | jq '.llm_invoked')" = "false" ]
    [ "$(claude_calls)" = "1" ]
    [ "$(jq -r '.window.since' "$OUT/2026-10-05T060000Z.json")" = "2026-10-05T00:00:00Z" ]
    [ "$(jq '[.signatures[] | select(.template == "evaluator returned no verdict")] | .[0].count' "$OUT/2026-10-05T060000Z.json")" = "2" ]
    [ -f "$OUT/2026-10-05T000000Z.json" ]
}

@test "即時トリガの plist の起動でも daily.sh と同じ処理が走り、new / regressed があるときだけ claude -p にレポートを渡す" {
    run run_watch_trigger 2026-10-05T00:00:00Z
    [ "$status" -eq 0 ]
    report="$HOME/.claude/logs/dev-flow-health/2026-10-05T000000Z.json"
    [ "$(printf '%s' "$output" | jq -r '.report')" = "$report" ]
    [ "$(jq '.needs_llm' "$report")" = "true" ]
    [ "$(cat "$CALLS")" = "-p /dev-flow:dev-flow-health $report" ]

    run run_watch_trigger 2026-10-05T01:00:00Z
    [ "$status" -eq 0 ]
    [ "$(printf '%s' "$output" | jq '.needs_llm')" = "false" ]
    [ "$(claude_calls)" = "1" ]
}

@test "日次ジョブと即時トリガが交互に走っても、間に入った失敗は 1 回だけ new になる" {
    run_daily_job 2026-10-05T07:00:00Z
    # 失敗の書き込みと同じ秒にトリガが走る
    write_failure 2026-10-05T09:00:00Z "trigger caught failure"
    run_watch_trigger 2026-10-05T09:00:00Z
    run_watch_trigger 2026-10-05T12:00:00Z
    # トリガが走らなかった失敗（スリープ中など）は次の日次ジョブが拾う
    write_failure 2026-10-06T06:59:59Z "daily caught failure"
    run_daily_job 2026-10-06T07:00:00Z
    run_watch_trigger 2026-10-06T08:00:00Z

    reports=("$HOME/.claude/logs/dev-flow-health"/*.json)
    [ "${#reports[@]}" -eq 5 ]
    [ "$(jq -s '[.[].signatures[] | select(.template == "trigger caught failure" and .status == "new")] | length' "${reports[@]}")" = "1" ]
    [ "$(jq -s '[.[].signatures[] | select(.template == "daily caught failure" and .status == "new")] | length' "${reports[@]}")" = "1" ]
    [ "$(jq -r '.signatures[] | select(.template == "trigger caught failure") | .status' "$HOME/.claude/logs/dev-flow-health/2026-10-05T090000Z.json")" = "new" ]
    [ "$(jq -r '.signatures[] | select(.template == "daily caught failure") | .status' "$HOME/.claude/logs/dev-flow-health/2026-10-06T070000Z.json")" = "new" ]
}

@test "--now を省いた即時トリガの実行は、自分を起こした直前の失敗を new にして LLM を起動する" {
    export DEV_FLOW_HEALTH_NOW_LAG_SECONDS=1
    write_failure "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "trigger woke on this failure"
    run daily
    [ "$status" -eq 0 ]
    report="$(printf '%s' "$output" | jq -r '.report')"
    [ "$(jq -r '.signatures[] | select(.template == "trigger woke on this failure") | .status' "$report")" = "new" ]
    [ "$(printf '%s' "$output" | jq '.llm_invoked')" = "true" ]
}

@test "--now を省いた実行は待ってから走査する — 終点以前の timestamp で走査の前に書き終わった失敗を今回の窓で拾う" {
    export DEV_FLOW_HEALTH_NOW_LAG_SECONDS=3
    started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    daily > "$BATS_TEST_TMPDIR/run.out" &
    pid=$!
    # journal.sh は timestamp を確定してから mv するので、終点以前の timestamp の entry が実行の開始後に現れる
    sleep 1
    write_failure "$started" "late written failure"
    wait "$pid"
    report="$(jq -r '.report' "$BATS_TEST_TMPDIR/run.out")"
    [ "$(jq -r '.signatures[] | select(.template == "late written failure") | .status' "$report")" = "new" ]
}

@test "重なった 2 本は lock で 1 本ずつ走り、LLM は 1 回だけ起動する" {
    # LLM の実行中にもう 1 本が来る状況を作る
    printf '#!/bin/sh\nsleep 1\nprintf "%%s\\n" "$*" >> "%s"\n' "$CALLS" > "$STUB/claude"
    daily --now 2026-10-05T00:00:00Z > "$BATS_TEST_TMPDIR/a.out" &
    pid_a=$!
    daily --now 2026-10-05T00:00:00Z > "$BATS_TEST_TMPDIR/b.out" &
    pid_b=$!
    wait "$pid_a"
    wait "$pid_b"

    [ "$(claude_calls)" = "1" ]
    [ "$(cat "$BATS_TEST_TMPDIR/a.out" "$BATS_TEST_TMPDIR/b.out" | jq -s '[.[] | select(.llm_invoked)] | length')" = "1" ]
    # 同じ秒の 2 本目は別ファイルに書き、lock は残さない
    [ -f "$OUT/2026-10-05T000000Z.json" ]
    [ -f "$OUT/2026-10-05T000000Z.2.json" ]
    [ ! -e "$OUT/.lock" ]
}

@test "保持していたプロセスが居ない lock は取り直して走る" {
    mkdir -p "$OUT/.lock"
    sh -c 'exit 0' &
    dead=$!
    wait "$dead"
    echo "$dead" > "$OUT/.lock/pid"
    run daily --now 2026-10-06T00:00:00Z
    [ "$status" -eq 0 ]
    [ -f "$OUT/2026-10-06T000000Z.json" ]
    [ ! -e "$OUT/.lock" ]
}

@test "claude が失敗しても実行は止まらず終了コードを記録する" {
    printf '#!/bin/sh\nexit 3\n' > "$STUB/claude"
    run daily --now 2026-10-05T00:00:00Z
    [ "$status" -eq 0 ]
    [ "$(printf '%s' "$output" | jq '.llm_exit')" = "3" ]
}

@test "LLM の出力の振り分けブロックを record-classification.sh に渡し、classifications.jsonl に signature ごとに 1 行追記する" {
    stub_claude_classify transient
    run daily --now 2026-10-05T00:00:00Z
    [ "$status" -eq 0 ]
    report="$OUT/2026-10-05T000000Z.json"
    [ "$(printf '%s' "$output" | jq '.classifications_recorded')" = "3" ]
    [ "$(printf '%s' "$output" | jq '.classification_error')" = "null" ]
    [ "$(wc -l < "$OUT/classifications.jsonl" | tr -d ' ')" = "3" ]
    # 行は record-classification.sh の形（レポートのパス・generated_at 付き）で、new / regressed の signature と 1 対 1
    [ "$(jq -sc '[.[].id] | sort' "$OUT/classifications.jsonl")" = \
      "$(jq -c '[.signatures[] | select(.status == "new" or .status == "regressed") | .id] | sort' "$report")" ]
    [ "$(jq -sc '[.[] | {report, generated_at, classification}] | unique' "$OUT/classifications.jsonl")" = \
      "$(jq -c --arg r "$report" '[{report: $r, generated_at, classification: "transient"}]' "$report")" ]
    # 受け渡しの一時ファイルを残さない
    [ -z "$(find "$OUT" -name '.classifications.*')" ]
}

@test "振り分けブロックが複数あれば最後の 1 つだけを記録する" {
    stub_claude_classify "dev_flow environment"
    run daily --now 2026-10-05T00:00:00Z
    [ "$status" -eq 0 ]
    [ "$(printf '%s' "$output" | jq '.classifications_recorded')" = "3" ]
    [ "$(jq -sc '[.[].classification] | unique' "$OUT/classifications.jsonl")" = '["environment"]' ]
}

@test "振り分けブロックが無い・JSON が不正・enum 外なら何も追記せず、exit 0 で記録 0 件と理由を出す" {
    # ブロックが無い（既定の stub は何も出力しない）
    run daily --now 2026-10-05T00:00:00Z
    [ "$status" -eq 0 ]
    [ "$(printf '%s' "$output" | jq '.classifications_recorded')" = "0" ]
    [ "$(printf '%s' "$output" | jq -r '.classification_error | type')" = "string" ]
    [ ! -e "$OUT/classifications.jsonl" ]

    # JSON が不正
    printf '%s\n[{"id": "abc",\n%s\n' "$CLASS_BEGIN" "$CLASS_END" > "$BATS_TEST_TMPDIR/llm-out"
    stub_claude_print "$BATS_TEST_TMPDIR/llm-out"
    rm -rf "$OUT"
    run daily --now 2026-10-05T00:00:00Z
    [ "$status" -eq 0 ]
    [ "$(printf '%s' "$output" | jq '.classifications_recorded')" = "0" ]
    [ "$(printf '%s' "$output" | jq -r '.classification_error | type')" = "string" ]
    [ ! -e "$OUT/classifications.jsonl" ]

    # enum 外の classification
    stub_claude_classify bogus
    rm -rf "$OUT"
    run daily --now 2026-10-05T00:00:00Z
    [ "$status" -eq 0 ]
    [ "$(printf '%s' "$output" | jq '.classifications_recorded')" = "0" ]
    [[ "$(printf '%s' "$output" | jq -r '.classification_error')" == *"invalid classification entry"* ]]
    [ ! -e "$OUT/classifications.jsonl" ]
    [ -z "$(find "$OUT" -name '.classifications.*')" ]
}

@test "LLM を呼ばない実行は記録を試みず、classifications_recorded / classification_error は null" {
    stub_claude_classify transient
    run daily --now 2026-10-06T00:00:00Z
    [ "$status" -eq 0 ]
    [ "$(printf '%s' "$output" | jq '.needs_llm')" = "false" ]
    [ "$(printf '%s' "$output" | jq -c '[.classifications_recorded, .classification_error]')" = "[null,null]" ]
    [ ! -e "$OUT/classifications.jsonl" ]
}

@test "claude が exit 3 で終わっても llm_exit 3 を記録し、出力に振り分けブロックがあれば記録する" {
    stub_claude_classify target_repo 3
    run daily --now 2026-10-05T00:00:00Z
    [ "$status" -eq 0 ]
    [ "$(printf '%s' "$output" | jq '.llm_exit')" = "3" ]
    [ "$(printf '%s' "$output" | jq '.classifications_recorded')" = "3" ]
    [ "$(printf '%s' "$output" | jq '.classification_error')" = "null" ]
    [ "$(wc -l < "$OUT/classifications.jsonl" | tr -d ' ')" = "3" ]
}

@test "install-schedule --print: 毎日 07:00 に checkout の daily.sh を --repo 付き・登録時の PATH で起動する plist" {
    REPO_ROOT="$(git -C "$SKILL_DIR" rev-parse --show-toplevel)"
    run bash "$INSTALL" --print --repo "$SKILL_DIR"
    [ "$status" -eq 0 ]
    expected="$(cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.playpark.dev-flow-health</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$REPO_ROOT/plugins/dev-flow/dev-flow-health/scripts/daily.sh</string>
    <string>--repo</string>
    <string>$REPO_ROOT</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO_ROOT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$PATH</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>7</integer>
    <key>Minute</key><integer>0</integer>
  </dict>
  <key>StandardOutPath</key><string>$HOME/.claude/logs/dev-flow-health.log</string>
  <key>StandardErrorPath</key><string>$HOME/.claude/logs/dev-flow-health.err.log</string>
</dict>
</plist>
PLIST
)"
    [ "$output" = "$expected" ]
}

@test "install-schedule --print --watch-journal: 別 Label で journal ディレクトリを WatchPaths に持ち、同じ daily.sh にそのディレクトリを渡す" {
    REPO_ROOT="$(git -C "$SKILL_DIR" rev-parse --show-toplevel)"
    run bash "$INSTALL" --print --repo "$SKILL_DIR" --watch-journal
    [ "$status" -eq 0 ]
    [[ "$output" == *"<key>Label</key><string>com.playpark.dev-flow-health.watch-journal</string>"* ]]
    [[ "$output" == *"<key>WatchPaths</key>
  <array>
    <string>$JOURNAL</string>
  </array>"* ]]
    [[ "$output" != *"StartCalendarInterval"* ]]
    [[ "$output" == *"<string>$REPO_ROOT/plugins/dev-flow/dev-flow-health/scripts/daily.sh</string>
    <string>--repo</string>
    <string>$REPO_ROOT</string>
    <string>--journal-dir</string>
    <string>$JOURNAL</string>
  </array>"* ]]
    [[ "$output" == *"<key>PATH</key><string>$STUB:"* ]]

    # CLAUDE_JOURNAL_DIR が無ければ $HOME/.claude/journal
    unset CLAUDE_JOURNAL_DIR
    run bash "$INSTALL" --print --repo "$SKILL_DIR" --watch-journal
    [ "$status" -eq 0 ]
    [[ "$output" == *"<key>WatchPaths</key>
  <array>
    <string>$HOME/.claude/journal</string>
  </array>"* ]]
}

@test "install-schedule --install / --uninstall --watch-journal: 即時トリガの plist だけを登録・解除し、日次ジョブには触れない" {
    agents="$HOME/Library/LaunchAgents"
    mkdir -p "$agents"
    echo daily > "$agents/com.playpark.dev-flow-health.plist"
    watch_plist="$agents/com.playpark.dev-flow-health.watch-journal.plist"

    run bash "$INSTALL" --install --repo "$SKILL_DIR" --watch-journal
    [ "$status" -eq 0 ]
    [ -f "$watch_plist" ]
    grep -q "<string>$JOURNAL</string>" "$watch_plist"
    grep -qx "bootstrap gui/$(id -u) $watch_plist" "$LAUNCHCTL_CALLS"

    run bash "$INSTALL" --uninstall --watch-journal
    [ "$status" -eq 0 ]
    [ ! -e "$watch_plist" ]
    [ "$(tail -n 1 "$LAUNCHCTL_CALLS")" = "bootout gui/$(id -u) $watch_plist" ]
    [ "$(cat "$agents/com.playpark.dev-flow-health.plist")" = "daily" ]
    run grep -c 'com.playpark.dev-flow-health.plist' "$LAUNCHCTL_CALLS"
    [ "$output" = "0" ]
}

@test "install-schedule: --repo が無い / git checkout でない / skills checkout でないなら error" {
    run bash "$INSTALL" --print
    [ "$status" -ne 0 ]
    [[ "$output" == *"--repo"* ]]
    mkdir -p "$BATS_TEST_TMPDIR/not-git"
    run bash "$INSTALL" --print --repo "$BATS_TEST_TMPDIR/not-git"
    [ "$status" -ne 0 ]
    [[ "$output" == *"git checkout"* ]]
    git init -q "$BATS_TEST_TMPDIR/other"
    run bash "$INSTALL" --print --repo "$BATS_TEST_TMPDIR/other"
    [ "$status" -ne 0 ]
    [[ "$output" == *"daily.sh"* ]]
}

@test "install-schedule --print: claude CLI 不在なら error、不明引数は usage で exit 1" {
    PATH="/usr/bin:/bin" run bash "$INSTALL" --print --repo "$SKILL_DIR"
    [ "$status" -ne 0 ]
    run bash "$INSTALL"
    [ "$status" -eq 1 ]
    run bash "$INSTALL" --bogus
    [ "$status" -eq 1 ]
}
