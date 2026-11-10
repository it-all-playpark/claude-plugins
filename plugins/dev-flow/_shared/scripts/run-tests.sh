#!/usr/bin/env bash
# run-tests.sh - Validate（test#i）・post-eval・test#final のテスト実行 exec-proxy（issue #821）。
# Usage:
#   run-tests start <worktree> --base <ref> [--commands <file>] [--files <test file>...]
#   run-tests wait  <worktree> [--wait-sec <n=480>]
#   run-tests stop  <worktree> [--timeout-sec <n=60>]
#   （内部）run-tests supervise --state-dir <dir> / run-tests run <worktree> [...]
#
# green 判定を LLM の解釈ではなく exit code から決める。呼び出し側 agent は stdout の JSON 1 行を
# verbatim で転写するだけで、スクリプトの選択・起動失敗の分類・failed_files の抽出はここで行う。
#
# 切り離し実行: テストの所要時間は Bash 1 回の上限（600 秒）を超えうるので、start は引数を検証してテストを切り離して起動し
# すぐ返る。wait は最大 --wait-sec 待ち、終わっていれば下の「出力」の JSON を、終わっていなければ running の JSON
# （{"status":"running","tests":"running","green":false,...}）を返す。running も GREEN schema の必須キーを持ち、green は常に false。
# stop はテストを止める（その後の wait は tests "error"）。supervisor・状態ファイルは _lib/scripts/bg-job.sh が持ち、
# state dir は <WT>/.devflow-tmp/run-tests（前回の残りは start が止めて作り直す）。下の手順と判定は supervisor が
# 起動する内部の `run` の中身で、結果の JSON は state dir の tests-result.json に書く（stderr は logs/command.log）。
# 止まらないまま残らないよう、切り離したテストは RUN_TESTS_TIMEOUT_SEC で打ち切る（tests "error"）。
#
# ランナーの集合は base で決める（issue #1277）: --base は必須で、実行する tests/run-*.sh は `git merge-base <ref> HEAD` の
# tree にある tests/run-*.sh（mode 100755）だけ — worktree を glob しない。PR がランナーを消す・実行ビットを外す・足すことで
# 実行対象を減らして（全部消せば no_tests）Validate を通せないようにする。base のランナーが <WT> で欠けている・実行ビットが
# 無いときもそのパスを実行し、exit 127 / 126 の起動失敗（status "error"）にする。中身が base と違う tests/run-*.sh と
# base に無い tests/run-*.sh は <WT> 相対パスを changed_runners に載せる（実行はするが、merge tier が gate_policy に依らず HOLD
# にする — PR が書き換えたランナーの green はランナー自身の出力）。merge-base を解決できない run は集合を決められないので
# テストを 1 本も実行せず status "error"。
#
# 解決したテストコマンド（issue #1278）: --commands <file> は Setup の test-commands-prepare / resolver が worktree の外の
# run ごとの場所に置いたコマンドファイル（中身の形は test-commands-prepare.sh）。コマンドを argv で受けない — 転写の
# 経路で中身が変わらず、PR が既知のパスで書き換えられないようにする。読み方:
#   - status "resolved" で commands（{dir, full_command, files_command} の 1 件以上の配列。user 設定・resolver）: base の
#     tests/run-*.sh に代えて、各 entry の full_command を <WT>/<dir> を cwd に並び順で 1 本ずつ実行する（1 つでも red なら red）。
#     --files は各ファイルを、そのファイルを含む最も深い entry の dir に振り分け、その entry の files_command の {files} の語を
#     dir からの相対パスに置き換えて実行する（ファイルの無い entry は実行しない）。コマンドは shell を通さず空白で区切った argv で起動する。
#     dir は "." か <WT> 相対のパスで、<WT>/<dir> が <WT> 内の実ディレクトリでない（無い・symlink を経由する・.. を含む）entry が
#     1 つでもあれば、テストを 1 本も実行せず status "error"（PR が dir を symlink に差し替えて <WT> の外で起動させない）。
#     --files のファイルがどの entry の dir にも含まれないときも status "error"（実行しないまま passed にしない）
#   - status "unresolved": テストを実行せず tests "no_tests"（base に tests/run-*.sh があっても実行しない）
#   - --commands 無し・ファイルが無い・source "runners": base の tree の tests/run-*.sh を実行し、無ければ no_tests
#   - JSON として読めない・上のどの形でもない: テストを実行せず status "error"
# 言語別に決め打ちしたコマンドで実行する経路は持たない（解決は repo の CI 定義等を読む resolver か user 設定が行う）。
#
# 変更ファイルの受け渡し（issue #835）: --files でない run では、merge-base から working tree への差分（commit 済み・
# staged・未 stage）と untracked（--exclude-standard、.devflow-tmp/ を除く）の <WT> 相対パスを重複なく 1 行 1 件で
# $LOG_DIR/changed-files.txt に書き、tests/run-*.sh に DEVFLOW_CHANGED_FILES=<その絶対パス> と DEVFLOW_BASE=<merge-base の sha> を渡す。
# 何を回すかは repo 側のランナーが決める — run-tests はテストの選択・skip をしない（repo 固有の知識を持たない）。
# 一覧を取る git が失敗したときは両変数とも設定しない（未設定 = ランナーは全件実行）。
# 失敗は stderr に 1 行出すだけで status / green には影響させない。解決したテストコマンドには渡さない。
# 呼び出し元の環境に同名変数があっても継がない（入れ子の run-tests で外側の一覧を誤って使わない）。
#
# 落ちたファイルだけの再実行（issue #865。Final reconcile が test#final の red を flake と本物の red に分ける入口）:
# --base <ref> --files <WT 相対のテストファイル>... は、そのパスを 1 行 1 件で $LOG_DIR/test-files.txt に書き、
# tests/run-*.sh（集合は同じく base で決める）に DEVFLOW_TEST_FILES=<その絶対パス> を渡す（DEVFLOW_CHANGED_FILES / DEVFLOW_BASE は渡さない）。
# ランナーは一覧のうち自分が扱うファイルだけを実行し、扱うファイルが無ければ何も実行せず exit 0 する。
# 変数を読まないランナーは全件を実行する（遅くなるだけで green を緩めない）。どのファイルを誰が扱うかは repo 側が決める。
# 一覧のパスが WT 内の通常ファイルでなければ引数不正（exit 2）。解決したテストコマンドで実行する run は上の振り分けで
# 実行する。どちらも無い・実行する entry の files_command に {files} の語がちょうど 1 つ無いときは
# status "error" を返す（呼び出し側は flake と判定しない）。
#
# 落ちたテストファイルの受け取り（issue #1249）: tests/run-*.sh には毎回 DEVFLOW_FAILED_FILES=<$LOG_DIR 内のまだ存在しない
# ファイルの絶対パス>を渡す（解決したテストコマンドには渡さない。呼び出し元の環境の同名変数は継がない）。
# 契約: exit 非 0 で終わるランナーは、落ちたテストファイルを 1 行 1 件（<WT> 相対か <WT> 配下の絶対パス）でそこに書いてよい。
# 書くなら落ちたテストファイルを漏れなく書くこと — 漏れがあると base との切り分け（base-failure-triage）が漏れた失敗を
# 見落として green に倒しうる。全部を書けないランナーは書かない（書かない・空ならログからの抽出に戻る）。
# 一覧を使うのは --files でない run で、changed-files にそのランナーのパスが無い（base の tree と同じランナー）
# ときだけ。PR が書き換えたランナーは一部だけを書いて他の失敗を残したまま green にできるので、その一覧は使わない。
# 一覧に <WT> 内の通常ファイルでない行（.. を含む・<WT> の外・存在しない）が 1 件でもあれば結び付かない失敗とみなす。
#
# 手順:
#   0. <WT> の untracked で ignore 対象外のファイル（.devflow-tmp/ を除く）を git add --intent-to-add で index に
#      載せる（中身は stage しない）。git grep / git ls-files 系のテストから新規ファイルが見える状態で走らせる。
#   1. workspace-prebuild.sh <WT>（pnpm ワークスペースのビルド成果物をテストの直前に作り直す）。
#      status "failed" のときはテストを 1 本も実行せず status "failed"（reason を summary の先頭に置く）。
#      それ以外（built / skipped / JSON でない）はビルドを再試行せずテストへ進む。
#   2. base の tree の tests/run-*.sh を全本、名前順に <WT> の絶対パスの bare 形で直列実行する
#      （1 本だけ選ぶと残りのランナーの回帰が CI まで検出されない。並列化しない — repo によっては共有資源を使う）。
#      コマンドファイルに解決したテストコマンドがあれば、tests/run-*.sh に代えて commands の各 entry を直列実行する。
#      どちらも無ければ tests "no_tests"。
#   リトライ・環境の自動修復はしない（起動失敗は環境要因で、同じ操作の繰り返しや store / ロックの操作では直らない）。
#
# status は全 script の exit code だけで決まる: 起動失敗（exit 126 / 127）が 1 本でもあれば "error"、
# それ以外で exit 非 0 が 1 本でもあれば "failed"、全本 0（0 本を含む）なら "passed"。
# 例外: 解決したテストコマンドが pnpm で始まり、テストを起動する前に pnpm 自身の失敗で非 0 になったときは
# 起動失敗とする — テストは 1 件も走っておらず、red と報告すると本物の失敗と区別できない。次のどちらか:
#   - テスト前の依存 install（pnpm の verifyDepsBeforeRun）の失敗（出力に `Command failed with exit code N: '<pnpm>' install`）
#   - pnpm のエラー見出し行（` ERROR  <msg>` / `ERR_PNPM_<CODE>`）があり、スクリプトを起動した痕跡
#     （`> <name>@<version> test` の見出し行・`ELIFECYCLE`・テストランナーの `FAIL` / `not ok` 行）が 1 つも無い
#   痕跡の有無だけでは判定しない — `--silent` 等で見出し行が出ない設定の本物の red を error に倒さないよう、
#   pnpm 自身のエラー見出し行があるときに限る。
# tests / green は workflow の GREEN schema の必須キーで、status から機械的に写す（agent に組み立てさせない）:
#   passed → tests "passed" green true / failed → "failed" false / error → "error" false /
#   実行対象 0 本 → status "passed"・tests "no_tests"・green false（何も走っていないので green を主張しない）
#
# failed_files（status "failed" のときだけ非空になりうる）: exit 非 0 の script ごとに、上の DEVFLOW_FAILED_FILES の
# 一覧を使えるときはそれを、使えないときは出力から bats の `not ok` 行
# （直後の診断行 `# (in test file <path>, line N)` のパス）と vitest / jest の `FAIL <path>` 行を抽出したものを取り、
# <WT> 相対にして重複なく並べる（解決したテストコマンドの出力の相対パスは entry の dir からの相対なので dir を前置する）。exit 非 0 の script から 1 件も抽出できない・ファイルに結び付かない
# `not ok` がある・ビルド失敗のときは空配列にする — 一部だけ列挙すると、base でも落ちる既存の失敗の
# 切り分け（base-failure-triage）が結び付かない失敗を見落として green に倒しうるため。
#
# 出力（stdout, JSON 1 行。各 script の出力は $TMPDIR のログに残し stdout に混ぜない — Bash tool の出力上限で
# JSON 行が切れないように、stderr にも 1 script 1 行の要約だけを出す）:
#   {"status":"passed|failed|error","tests":"passed|failed|error|no_tests","green":bool,"summary":"...",
#    "scripts":[{"path":"...","exit":N,"launch_failed":bool,"log":"..."}],"failed_files":[...],"epoch":N
#    [,"changed_runners":["tests/run-x.sh",...]]}
#   changed_runners は中身が base と違う・base に無い tests/run-*.sh があるときだけ載る（無ければキー自体を出さない）。
#   解決したテストコマンドの scripts[].path は実行した argv を空白で繋いだもの（dir が "." でなければ "<dir>: " を前置する）。
#   scripts[].log はその script の stdout / stderr を書いたログの絶対パス（$TMPDIR 配下 = worktree の外。worktree 内に
#   置くと diff-hash が untracked を含むため merge tier を壊す）。evaluator が同じ tree で実行済みのテストを再実行せず
#   ログの行を根拠にするために渡す。どのテストファイルが走ったかはログの中身から読み手が判断する。
# exit: JSON を出力したら 0（判定は JSON の status）/ 引数不正は 2（status "error" の JSON を出す）。
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREBUILD="$SCRIPT_DIR/workspace-prebuild.sh"
SUMMARY_MAX=4000
LINES_MAX=30
USAGE="usage: run-tests start <worktree> --base <ref> [--commands <file>] [--files <test file>...] | wait <worktree> [--wait-sec <n>] | stop <worktree> [--timeout-sec <n>]"
# 切り離したテストの上限（秒）。workflow の待機上限（RUN_TESTS_MAX_WAIT_SEC）より長くして、普段は workflow の stop で止まる。
# これは run が落ちて stop が呼ばれないときにテストを残さないための上限（bats が短くするための上書き口）
RUN_TIMEOUT_SEC="${RUN_TESTS_TIMEOUT_SEC:-4200}"

# shellcheck source=../../_lib/scripts/bg-job.sh
source "$SCRIPT_DIR/../../_lib/scripts/bg-job.sh"
BG_JOB_NAME=run-tests
BG_JOB_SELF="$SCRIPT_DIR/$(basename "${BASH_SOURCE[0]}")"

# base と違う・base に無い tests/run-*.sh（<WT> 相対パスの JSON 配列）。空でなければ emit が changed_runners に載せる
CHANGED_RUNNERS_JSON='[]'

emit() {
    # $1 status / $2 tests / $3 green / $4 summary / $5 scripts JSON / $6 failed_files JSON
    jq -nc --arg s "$1" --arg t "$2" --argjson g "$3" --arg m "${4:0:$SUMMARY_MAX}" \
        --argjson sc "$5" --argjson ff "$6" --argjson e "$(date +%s)" --argjson cr "$CHANGED_RUNNERS_JSON" \
        '{status: $s, tests: $t, green: $g, summary: $m, scripts: $sc, failed_files: $ff, epoch: $e}
            + (if $cr == [] then {} else {changed_runners: $cr} end)'
}

usage_error() {
    emit error error false "$USAGE" '[]' '[]'
    exit 2
}

resolve_worktree() {
    WT=$(cd "$1" 2>/dev/null && pwd) || { emit error error false "cd failed: $1" '[]' '[]'; exit 2; }
}

# start / run の引数を検証する。start で弾くので、切り離した後に引数不正で落ちない
parse_run_args() {
    TEST_FILES=()
    COMMANDS_FILE=""
    [[ $# -ge 3 && "$2" == "--base" && -n "$3" ]] || usage_error
    BASE_REF="$3"
    local next=4
    if [[ $# -ge 5 && "$4" == "--commands" && -n "$5" ]]; then
        COMMANDS_FILE="$5"
        next=6
    fi
    if [[ $# -ge $((next + 1)) && "${!next}" == "--files" ]]; then
        TEST_FILES=("${@:$((next + 1))}")
    elif [[ $# -ne $((next - 1)) ]]; then
        usage_error
    fi
    resolve_worktree "$1"
    WT_PHYS=$(cd "$WT" && pwd -P)
    # テスト script・解決したテストコマンドとも <WT> を cwd にして実行する
    cd "$WT" || { emit error error false "cd failed: $WT" '[]' '[]'; exit 2; }

    local p
    for p in "${TEST_FILES[@]+"${TEST_FILES[@]}"}"; do
        if [[ -z "$p" || "$p" == /* || "/$p/" == */../* || ! -f "$WT/$p" ]]; then
            emit error error false "--files: not a test file under the worktree: $p" '[]' '[]'
            exit 2
        fi
    done
}

job_paths() {
    bg_job_paths "$WT/.devflow-tmp/run-tests"
    TESTS_RESULT="$BG_JOB_STATE_DIR/tests-result.json"
}

# bg-job の応答を run-tests の JSON に写す。終わっていれば `run` が残した結果をそのまま返し、結果が無ければ tests "error"
# （テストが通ったかを確かめられていない）。読み手が見るのはこの形だけ
emit_job_response() {
    local res="$1" status
    status=$(jq -r '.status // empty' <<<"$res" 2>/dev/null)
    case "$status" in
        running)
            jq -nc --arg l "$(jq -r '.log_path // ""' <<<"$res")" --argjson e "$(date +%s)" \
                '{status: "running", tests: "running", green: false, summary: "", log_path: $l, epoch: $e}'
            ;;
        passed|failed)
            jq -ce 'select(type == "object" and has("tests") and has("green"))' "$TESTS_RESULT" 2>/dev/null \
                || emit error error false "run-tests ended without a result (exit $(jq -r '.exit_code // "?"' <<<"$res"), log: $BG_JOB_CMD_LOG)" '[]' '[]'
            ;;
        timeout)
            emit error error false "tests did not finish within ${RUN_TIMEOUT_SEC}s and were stopped (log: $BG_JOB_CMD_LOG)" '[]' '[]'
            ;;
        stopped)
            emit error error false "tests were stopped before they finished (log: $BG_JOB_CMD_LOG)" '[]' '[]'
            ;;
        *)
            emit error error false "$(jq -r '.error // .reason // "run-tests job failed"' <<<"$res" 2>/dev/null)" '[]' '[]'
            ;;
    esac
}

cmd_start() {
    job_paths
    local reset cmd
    reset=$(bg_job_reset "$WT") || { emit_job_response "$reset"; return; }
    printf -v cmd '%q ' bash "$BG_JOB_SELF" run "$WT" "${@:2}"
    printf -v cmd '%s> %q' "$cmd" "$TESTS_RESULT"
    bg_job_write_json "$BG_JOB_SPEC" --arg cwd "$WT" --arg cmd "$cmd" --argjson timeout "$RUN_TIMEOUT_SEC" \
        '{cwd: $cwd, command: $cmd, timeout_seconds: $timeout}'
    emit_job_response "$(bg_job_start)"
}

SUBCOMMAND="${1:-}"
[[ $# -eq 0 ]] || shift
case "$SUBCOMMAND" in
    start)
        parse_run_args "$@"
        cmd_start "$@"
        exit 0
        ;;
    wait|stop)
        [[ $# -ge 1 ]] || usage_error
        flag=--wait-sec
        [[ "$SUBCOMMAND" == wait ]] || flag=--timeout-sec
        [[ $# -eq 1 || ( $# -eq 3 && "$2" == "$flag" && "$3" =~ ^[0-9]+$ ) ]] || usage_error
        resolve_worktree "$1"
        job_paths
        if [[ "$SUBCOMMAND" == wait ]]; then
            emit_job_response "$(bg_job_wait "${3:-}")"
        else
            bg_job_stop "${3:-}"
        fi
        exit 0
        ;;
    supervise)
        [[ $# -eq 2 && "$1" == "--state-dir" ]] || usage_error
        bg_job_paths "$2"
        bg_job_supervise
        exit 0
        ;;
    run)
        parse_run_args "$@"
        ;;
    *)
        usage_error
        ;;
esac

unset DEVFLOW_CHANGED_FILES DEVFLOW_BASE DEVFLOW_TEST_FILES DEVFLOW_FAILED_FILES

LOG_DIR=$(mktemp -d "${TMPDIR:-/tmp}/run-tests-XXXXXX") \
    || { emit error error false "cannot create log dir under ${TMPDIR:-/tmp}" '[]' '[]'; exit 0; }

TEST_FILES_LIST=""
if [[ ${#TEST_FILES[@]} -gt 0 ]]; then
    TEST_FILES_LIST="$LOG_DIR/test-files.txt"
    printf '%s\n' "${TEST_FILES[@]}" > "$TEST_FILES_LIST"
fi

# 解決したテストコマンド（--commands）。COMMAND_MODE は "command"（commands の各 entry を実行）・"unresolved"
# （実行しない）・""（base の tests/run-*.sh）。実行する entry ごとに ENTRY_DIRS（"." か <WT> 相対の dir）と
# ENTRY_ARGVS（argv を 1 行 1 語で書いたファイル。shell を通さず空白で区切る）を並べる
COMMAND_MODE=""
ENTRY_DIRS=()
ENTRY_ARGVS=()
if [[ -n "$COMMANDS_FILE" && -e "$COMMANDS_FILE" ]]; then
    if ! COMMAND_MODE=$(jq -r 'if type != "object" then error("not an object")
        elif .status == "unresolved" then "unresolved"
        elif .status == "resolved" and .source == "runners" then ""
        elif .status == "resolved" and (.commands | type == "array" and length > 0
            and all(.[]; type == "object" and (.dir | type == "string") and (.full_command | type == "string" and test("\\S"))))
            then "command"
        else error("no commands") end' "$COMMANDS_FILE" 2>"$LOG_DIR/commands.log"); then
        emit error error false "test commands file is not readable as JSON with commands [{dir, full_command, files_command}] — no test was run: $COMMANDS_FILE (log: $LOG_DIR/commands.log)" '[]' '[]'
        exit 0
    fi
fi
if [[ "$COMMAND_MODE" == command ]]; then
    # <WT>/<dir> は <WT> 内の実ディレクトリ（pwd -P が <WT の実体>/<dir> と一致 = どの要素も symlink でない）だけを受ける
    entry_dirs=()
    n_entries=$(jq -r '.commands | length' "$COMMANDS_FILE")
    for ((k = 0; k < n_entries; k++)); do
        dir=$(jq -r --argjson k "$k" '.commands[$k].dir' "$COMMANDS_FILE")
        if [[ "$dir" != "." ]] && { [[ -z "$dir" || "$dir" == /* || "/$dir/" == *//* || "/$dir/" == */./* || "/$dir/" == */../* ]] \
                || [[ ! -d "$WT/$dir" || "$(cd "$WT/$dir" 2>/dev/null && pwd -P)" != "$WT_PHYS/$dir" ]]; }; then
            emit error error false "commands[$k].dir is not a real directory inside the worktree (missing, symlink or not a relative path) — no test was run: $dir" '[]' '[]'
            exit 0
        fi
        entry_dirs+=("$dir")
    done
    if [[ -n "$TEST_FILES_LIST" ]]; then
        # 各ファイルを、そのファイルを含む最も深い entry に振り分ける（"." は全ファイルを含む）
        for p in "${TEST_FILES[@]}"; do
            best=-1
            best_len=-1
            for k in "${!entry_dirs[@]}"; do
                dir="${entry_dirs[$k]}"
                if [[ "$dir" == "." ]]; then len=0; elif [[ "$p" == "$dir"/* ]]; then len=${#dir}; else continue; fi
                if [[ $len -gt $best_len ]]; then best=$k; best_len=$len; fi
            done
            if [[ $best -lt 0 ]]; then
                emit error error false "--files: not under any commands[].dir of the test commands file — no test was run: $p" '[]' '[]'
                exit 0
            fi
            dir="${entry_dirs[$best]}"
            [[ "$dir" == "." ]] || p="${p#"$dir"/}"
            # `-` で始まるパスは ./ を付けて渡す（PR が足した `-x` 名のファイルをランナーが option として読み、
            # テストを実行しないまま exit 0 で passed にしないように）
            [[ "$p" == -* ]] && p="./$p"
            printf '%s\n' "$p" >> "$LOG_DIR/entry-$best.files"
        done
    fi
    for k in "${!entry_dirs[@]}"; do
        argv_file="$LOG_DIR/entry-$k.argv"
        if [[ -n "$TEST_FILES_LIST" ]]; then
            [[ -f "$LOG_DIR/entry-$k.files" ]] || continue
            read -r -a words <<< "$(jq -r --argjson k "$k" '.commands[$k].files_command // "" | tostring' "$COMMANDS_FILE")"
            n=0
            for w in "${words[@]+"${words[@]}"}"; do
                if [[ "$w" == "{files}" ]]; then
                    cat "$LOG_DIR/entry-$k.files"
                    n=$((n + 1))
                else
                    printf '%s\n' "$w"
                fi
            done > "$argv_file"
            if [[ $n -ne 1 ]]; then
                emit error error false "--files needs files_command with exactly one {files} word in commands[$k] of the test commands file: $COMMANDS_FILE" '[]' '[]'
                exit 0
            fi
        else
            read -r -a words <<< "$(jq -r --argjson k "$k" '.commands[$k].full_command' "$COMMANDS_FILE")"
            printf '%s\n' "${words[@]}" > "$argv_file"
        fi
        ENTRY_DIRS+=("${entry_dirs[$k]}")
        ENTRY_ARGVS+=("$argv_file")
    done
fi

# merge-base（ランナーの集合を決める tree。解決できなければテストを 1 本も実行せず error）
if ! MERGE_BASE=$(git merge-base "$BASE_REF" HEAD 2>"$LOG_DIR/merge-base.log"); then
    emit error error false "merge-base of $BASE_REF and HEAD not resolved — the set of tests/run-*.sh is taken from the base tree, so no test was run (log: $LOG_DIR/merge-base.log)" '[]' '[]'
    exit 0
fi

# base の tree の tests/run-*.sh。ls-tree は名前のバイト順で出す（= LC_ALL=C の名前順）。
# BASE_RUNNERS は実行する（mode 100755 の）WT 相対パス、base-runners.txt は「<blob> <path>」で全 mode の中身の比較用
BASE_RUNNERS=()
if ! git ls-tree -z "$MERGE_BASE" -- tests/ > "$LOG_DIR/base-tree.raw" 2>"$LOG_DIR/merge-base.log"; then
    emit error error false "git ls-tree $MERGE_BASE failed — the set of tests/run-*.sh cannot be taken from the base tree, so no test was run (log: $LOG_DIR/merge-base.log)" '[]' '[]'
    exit 0
fi
: > "$LOG_DIR/base-runners.txt"
while IFS= read -r -d '' entry; do
    meta="${entry%%$'\t'*}"
    path="${entry#*$'\t'}"
    [[ "$path" == tests/run-*.sh && "${meta#* }" == blob\ * ]] || continue
    printf '%s %s\n' "${meta##* }" "$path" >> "$LOG_DIR/base-runners.txt"
    [[ "${meta%% *}" == 100755 ]] && BASE_RUNNERS+=("$path")
done < "$LOG_DIR/base-tree.raw"

# 中身が base と違う・base に無い <WT> の tests/run-*.sh（git hash-object は書き込まない。失敗は違うものとして数える）
shopt -s nullglob
wt_runners=(tests/run-*.sh)
shopt -u nullglob
changed_runners=""
for path in "${wt_runners[@]+"${wt_runners[@]}"}"; do
    [[ -f "$path" ]] || continue
    blob=$(git hash-object -- "$path" 2>/dev/null) || blob=""
    [[ -n "$blob" ]] && grep -Fxq -- "$blob $path" "$LOG_DIR/base-runners.txt" && continue
    changed_runners+="$path"$'\n'
done
if [[ -n "$changed_runners" ]]; then
    CHANGED_RUNNERS_JSON=$(printf '%s' "$changed_runners" | jq -R . | jq -sc .)
    echo "[run-tests] tests/run-*.sh differing from or absent in the base tree: $(printf '%s' "$changed_runners" | tr '\n' ' ')" >&2
fi

# 変更ファイルの一覧（--files でない run だけ。intent-to-add の前に取る — 載せた後は untracked に出ないが、
# git diff <merge-base> には intent-to-add のファイルも出るので、再実行時も一覧は変わらない）。
# rename は旧パス・新パスの両方を載せる（--no-renames）。-z で取り、パスを quote させない
CHANGED_FILES=""
if [[ -z "$TEST_FILES_LIST" ]]; then
    changed="$LOG_DIR/changed-files.txt"
    if ! { git diff -z --name-only --no-renames --relative "$MERGE_BASE" -- \
                && git ls-files -z --others --exclude-standard -- . ':(exclude).devflow-tmp'; } \
            > "$LOG_DIR/changed-files.raw" 2>"$LOG_DIR/changed-files.log"; then
        echo "[run-tests] warning: git diff / ls-files failed — DEVFLOW_CHANGED_FILES / DEVFLOW_BASE not set (log: $LOG_DIR/changed-files.log)" >&2
    else
        tr '\0' '\n' < "$LOG_DIR/changed-files.raw" | LC_ALL=C awk 'length && !seen[$0]++' > "$changed"
        CHANGED_FILES="$changed"
    fi
fi

# 0. untracked の新規ファイルを intent-to-add で index に載せる
#    テストは commit 前の worktree で走るため、Implement / fix が作ったファイルは untracked のまま。
#    git grep / git ls-files で repo 全体を検査する invariant テストからは見えず、ローカル green・CI red になる
#    （個々のテストを --untracked に直すとテストを足すたびに同じ漏れが起きるので、runner で一度だけ載せる）。
#    intent-to-add は中身を stage しない — write-tree・commit される tree は変わらず、PR phase の
#    git add -A が従来どおり中身を載せる。.devflow-tmp/ は run の一時ファイル置き場なので載せない。
#    git の work tree でなければ何もしない。失敗してもテストは止めず stderr に警告を出す（従来の挙動に戻るだけ）。
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    if git ls-files -z --others --exclude-standard -- . ':(exclude).devflow-tmp' > "$LOG_DIR/untracked.list" \
        2>"$LOG_DIR/intent-to-add.log"; then
        if [[ -s "$LOG_DIR/untracked.list" ]] \
            && ! git --literal-pathspecs add --intent-to-add --pathspec-from-file="$LOG_DIR/untracked.list" \
                --pathspec-file-nul >>"$LOG_DIR/intent-to-add.log" 2>&1; then
            echo "[run-tests] warning: git add --intent-to-add failed — untracked files stay invisible to git grep (log: $LOG_DIR/intent-to-add.log)" >&2
        fi
    else
        echo "[run-tests] warning: git ls-files --others failed (log: $LOG_DIR/intent-to-add.log)" >&2
    fi
fi

# 1. workspace-prebuild
PREBUILD_OUT=$(bash "$PREBUILD" "$WT" 2>"$LOG_DIR/prebuild.log")
if [[ "$(jq -r '.status? // empty' <<< "$PREBUILD_OUT" 2>/dev/null)" == "failed" ]]; then
    reason=$(jq -r '.reason // "workspace build failed"' <<< "$PREBUILD_OUT")
    echo "[run-tests] workspace-prebuild failed — tests not run (log: $LOG_DIR/prebuild.log)" >&2
    emit failed failed false "$reason"$'\n'"$(tail -n "$LINES_MAX" "$LOG_DIR/prebuild.log")" '[]' '[]'
    exit 0
fi

# 2. 実行対象: 解決したテストコマンド、無ければ base の tree の tests/run-*.sh（<WT> に無い・実行ビットが無いものも実行して
#    起動失敗にする）
TARGETS=()      # 表示・JSON 用の path
TARGET_DIRS=()  # 解決したテストコマンドの cwd（"." か <WT> 相対の dir）。run-*.sh は空 = path を bare 実行
TARGET_ARGVS=() # 解決したテストコマンドの argv のファイル（run-*.sh は空）
if [[ "$COMMAND_MODE" == unresolved ]]; then
    emit passed no_tests false "the test commands file says unresolved — no test was run: $COMMANDS_FILE" '[]' '[]'
    exit 0
elif [[ "$COMMAND_MODE" == command ]]; then
    for k in "${!ENTRY_DIRS[@]}"; do
        label=$(tr '\n' ' ' < "${ENTRY_ARGVS[$k]}")
        label="${label% }"
        [[ "${ENTRY_DIRS[$k]}" == "." ]] || label="${ENTRY_DIRS[$k]}: $label"
        TARGETS+=("$label")
        TARGET_DIRS+=("${ENTRY_DIRS[$k]}")
        TARGET_ARGVS+=("${ENTRY_ARGVS[$k]}")
    done
else
    for path in "${BASE_RUNNERS[@]+"${BASE_RUNNERS[@]}"}"; do
        TARGETS+=("$WT/$path")
        TARGET_DIRS+=("")
        TARGET_ARGVS+=("")
    done
fi

if [[ ${#TARGETS[@]} -eq 0 && -n "$TEST_FILES_LIST" ]]; then
    emit error error false "--files needs tests/run-*.sh in the base tree or a resolved test command (--commands)" '[]' '[]'
    exit 0
fi

if [[ ${#TARGETS[@]} -eq 0 ]]; then
    emit passed no_tests false "no tests/run-*.sh in the base tree and no resolved test command (--commands)" '[]' '[]'
    exit 0
fi

# 出力から失敗したテストファイルを抽出する。1 行 1 パス。結び付かない `not ok` があれば "\t" 行を出す。
extract_failed_files() {
    LC_ALL=C sed $'s/\x1b\\[[0-9;]*[A-Za-z]//g' "$1" | LC_ALL=C awk '
        function flush() { if (pending) print "\t"; pending = 0 }
        /^not ok / { flush(); pending = 1; next }
        /^ok / { flush(); next }
        pending && match($0, /in test file .*, line [0-9]+\)/) {
            s = substr($0, RSTART + 13, RLENGTH - 13)
            sub(/, line [0-9]+\)$/, "", s)
            print s; pending = 0; next
        }
        /^[ \t]*FAIL[ \t]+/ {
            line = $0
            sub(/^[ \t]*FAIL[ \t]+/, "", line)
            n = split(line, tok, /[ \t]+/)
            i = 1
            if (tok[1] ~ /^\|.*\|$/) i = 2
            if (i <= n && tok[i] != "") print tok[i]
            next
        }
        END { flush() }
    '
}

# pnpm がテストスクリプトを起動する前に自身のエラーで終了したか（$1 = ログ）。判定規則は冒頭コメントの status 例外
pnpm_failed_before_script() {
    local plain
    plain=$(LC_ALL=C sed $'s/\x1b\\[[0-9;]*[A-Za-z]//g' "$1")
    LC_ALL=C grep -qE '^[[:space:]]*\[?(ERROR|ERR_PNPM_[A-Z0-9_]+)\]?[[:space:]]' <<< "$plain" \
        && ! LC_ALL=C grep -qE '^> |ELIFECYCLE|^(not ok |[[:space:]]*FAIL[[:space:]])' <<< "$plain"
}

to_rel() {
    local p="$1"
    p="${p#"$WT"/}"
    p="${p#"$WT_PHYS"/}"
    printf '%s\n' "${p#./}"
}

# ランナーが DEVFLOW_FAILED_FILES に書いた一覧を読む（$1 = ランナーの絶対パス、$2 = 一覧のパス）。使える（merge-base が
# 解決でき、ランナーが changed-files に無く、一覧に空でない行がある）ときは 1 行 1 パス（<WT> 相対）を出して 0 を返し、
# <WT> 内の通常ファイルでない行には "\t" 行を出す。使えないときは何も出さず 1（呼び出し側はログからの抽出に戻る）
runner_failed_files() {
    local list="$2" p
    [[ -n "$list" && -n "$CHANGED_FILES" && -f "$list" ]] || return 1
    grep -Fxq -- "$(to_rel "$1")" "$CHANGED_FILES" && return 1
    grep -q . "$list" || return 1
    while IFS= read -r p || [[ -n "$p" ]]; do
        [[ -n "$p" ]] || continue
        p=$(to_rel "$p")
        if [[ "$p" == /* || "/$p/" == */../* || ! -f "$WT/$p" ]]; then
            printf '\t\n'
        else
            printf '%s\n' "$p"
        fi
    done < "$list"
}

# 3. 直列実行
SCRIPTS_JSON='[]'
FAILED_LIST=""
UNATTRIBUTED=false
LAUNCH_FAILED_ANY=false
NONZERO_ANY=false
SUMMARY_HEAD=""
SUMMARY_BODY=""
for i in "${!TARGETS[@]}"; do
    target="${TARGETS[$i]}"
    log="$LOG_DIR/$i.log"
    failed_out=""
    tdir="${TARGET_DIRS[$i]}"
    [[ -n "$tdir" ]] || failed_out="$LOG_DIR/$i.failed-files"
    CMD_ARGV=()
    if [[ -z "$tdir" && -n "$TEST_FILES_LIST" ]]; then
        DEVFLOW_FAILED_FILES="$failed_out" DEVFLOW_TEST_FILES="$TEST_FILES_LIST" "$target" > "$log" 2>&1 < /dev/null
        rc=$?
    elif [[ -z "$tdir" && -n "$CHANGED_FILES" ]]; then
        DEVFLOW_FAILED_FILES="$failed_out" DEVFLOW_CHANGED_FILES="$CHANGED_FILES" DEVFLOW_BASE="$MERGE_BASE" "$target" > "$log" 2>&1 < /dev/null
        rc=$?
    elif [[ -z "$tdir" ]]; then
        DEVFLOW_FAILED_FILES="$failed_out" "$target" > "$log" 2>&1 < /dev/null
        rc=$?
    else
        while IFS= read -r w; do CMD_ARGV+=("$w"); done < "${TARGET_ARGVS[$i]}"
        (cd "$WT/$tdir" || exit 126; exec "${CMD_ARGV[@]}") > "$log" 2>&1 < /dev/null
        rc=$?
    fi
    pnpm_cmd=false
    [[ -n "$tdir" && "${CMD_ARGV[0]}" == pnpm ]] && pnpm_cmd=true
    launch=false
    if [[ $rc -eq 126 || $rc -eq 127 ]]; then
        launch=true
    elif [[ $rc -ne 0 && "$pnpm_cmd" == true ]] \
        && LC_ALL=C sed $'s/\x1b\\[[0-9;]*[A-Za-z]//g' "$log" \
            | LC_ALL=C grep -qE "Command failed with exit code [0-9]+: '[^']*/pnpm[^'/]*' install[[:space:]]*$"; then
        launch=true
    elif [[ $rc -ne 0 && "$pnpm_cmd" == true ]] && pnpm_failed_before_script "$log"; then
        launch=true
    fi
    [[ "$launch" == true ]] && LAUNCH_FAILED_ANY=true
    echo "[run-tests] $target exit=$rc launch_failed=$launch (log: $log)" >&2
    SCRIPTS_JSON=$(jq -c --arg p "$target" --argjson e "$rc" --argjson l "$launch" --arg o "$log" \
        '. + [{path: $p, exit: $e, launch_failed: $l, log: $o}]' <<< "$SCRIPTS_JSON")
    [[ $rc -eq 0 ]] && continue
    NONZERO_ANY=true
    if [[ "$launch" == true ]]; then
        SUMMARY_HEAD+="launch failed: $target (exit $rc, log: $log)"$'\n'
        SUMMARY_BODY+="--- $target"$'\n'"$(tail -n 5 "$log")"$'\n'
        continue
    fi
    SUMMARY_HEAD+="failed: $target (exit $rc, log: $log)"$'\n'
    found=$(runner_failed_files "$target" "$failed_out") || found=$(extract_failed_files "$log")
    if [[ -z "$found" ]] || grep -q $'^\t$' <<< "$found"; then
        UNATTRIBUTED=true
    fi
    while IFS= read -r p; do
        [[ -n "$p" && "$p" != $'\t' ]] || continue
        rel=$(to_rel "$p")
        # 解決したテストコマンドの出力の相対パスは entry の dir からの相対
        [[ -n "$tdir" && "$tdir" != "." && "$p" != /* ]] && rel="$tdir/$rel"
        FAILED_LIST+="$rel"$'\n'
    done <<< "$found"
    # 件数は最後まで読む awk で絞る（head へ pipe すると先に終わり、上流が SIGPIPE で pipefail が非 0 になる）
    fail_lines=$(LC_ALL=C sed $'s/\x1b\\[[0-9;]*[A-Za-z]//g' "$log" | LC_ALL=C grep -E '^(not ok |[[:space:]]*FAIL[[:space:]])' | awk -v max="$LINES_MAX" 'NR <= max')
    [[ -n "$fail_lines" ]] || fail_lines=$(tail -n "$LINES_MAX" "$log")
    SUMMARY_BODY+="--- $target"$'\n'"$fail_lines"$'\n'
done

FAILED_JSON='[]'
if [[ "$LAUNCH_FAILED_ANY" == false && "$NONZERO_ANY" == true && "$UNATTRIBUTED" == false && -n "$FAILED_LIST" ]]; then
    FAILED_JSON=$(printf '%s' "$FAILED_LIST" | awk 'NF && !seen[$0]++' | jq -R . | jq -sc .)
fi

if [[ "$LAUNCH_FAILED_ANY" == true ]]; then
    emit error error false "$SUMMARY_HEAD$SUMMARY_BODY" "$SCRIPTS_JSON" '[]'
elif [[ "$NONZERO_ANY" == true ]]; then
    emit failed failed false "$SUMMARY_HEAD$SUMMARY_BODY" "$SCRIPTS_JSON" "$FAILED_JSON"
else
    names=$(jq -r '[.[].path] | join(", ")' <<< "$SCRIPTS_JSON")
    emit passed passed true "passed: $names" "$SCRIPTS_JSON" '[]'
fi
exit 0
