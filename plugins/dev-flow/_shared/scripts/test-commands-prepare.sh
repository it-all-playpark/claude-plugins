#!/usr/bin/env bash
# test-commands-prepare.sh - テストコマンドの解決元を決め、run ごとの場所にコマンドファイルを置く（issue #1278）。
# Usage: test-commands-prepare <worktree> --base <branch>
#
# Setup（実装より前）に 1 回だけ実行する。解決元は次の順で 1 つに決まる:
#   (1) user 設定 "dev-flow".repos["<owner>/<repo>"].test_commands（devflow-config.sh の devflow_config で読む）
#       → source "user_config"。形が不正なら status "unresolved"（黙って次の解決元に倒さない — 誤記に気付けない）
#   (2) origin/<base> の tree に tests/run-*.sh（mode 100755 の blob）がある → source "runners"（run-tests が今どおり実行する）
#   (3) どちらも無い → source "resolver"。origin/<base> の tree から CI 定義・Makefile・package.json 等を git show で集めた
#       束（bundle_file）を書き、workflow が resolver agent（test-command-resolver）に渡す
# 判定と束の中身は refs/remotes/origin/<base> の tree だけから読み、worktree の作業ツリーは読まない — PR（worktree）が
# tests/run-*.sh・CI 定義を足す・書き換えることで、自分のテストの実行の形を選べないようにする。
#
# コマンドファイル（commands_file）は $TMPDIR 配下に mktemp -d で作る run ごとの推測できないディレクトリに置く
# （worktree の中・既知のパスに置くと、テストが書き換えて実行の中身を差し替えられる。redgreen-verify の state dir と同じ理由）。
# (1)(2) はここで書き、(3) は workflow が resolver の返り値を検証してから書く（resolved のときだけ。無ければ run-tests は no_tests）。
# 中身: {"source":..., "status":"resolved"|"unresolved", "full_command":string|null, "files_command":string|null, "sources":[...]}
#   full_command / files_command は shell を通さず空白で区切って argv にする（run-tests）。files_command は {files} を独立した
#   語としてちょうど 1 回含み、run-tests がそこを再実行するテストファイルに置き換える。
#
# 出力（stdout, JSON 1 行）: コマンドファイルの中身 + {ok:true, commands_file, run_dir}（(3) は bundle_file / bundle_files も、
# (1) の形が不正なら error も）。base の ref を解決できない・一時ディレクトリを作れないときは {ok:false, error}。
# exit: JSON を出したら 0 / 引数不正は 2。
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=devflow-config.sh
source "$SCRIPT_DIR/devflow-config.sh"

# 束に入れるファイル（origin/<base> の tree のパスに対する ERE）。CI 定義と、テストの起動方法を宣言するビルド・パッケージの定義
BUNDLE_PATH_RE='^(\.github/workflows/[^/]+\.ya?ml|\.gitlab-ci\.yml|\.circleci/config\.ya?ml|azure-pipelines\.ya?ml|bitbucket-pipelines\.ya?ml|\.travis\.yml|Jenkinsfile|\.buildkite/[^/]+\.ya?ml|GNUmakefile|[Mm]akefile|[Jj]ustfile|Taskfile\.ya?ml|package\.json|pnpm-workspace\.yaml|pyproject\.toml|setup\.cfg|tox\.ini|pytest\.ini|noxfile\.py|Cargo\.toml|go\.mod|Gemfile|composer\.json|deno\.jsonc?|build\.gradle(\.kts)?|pom\.xml|mix\.exs|(vitest|jest)\.config\.[cm]?[jt]s)$'
BUNDLE_FILES_MAX=40
BUNDLE_FILE_BYTES_MAX=20000

# コマンド文字列の形（jq）。空でない 1 行で、shell の記号・引用符を含まない（run-tests は shell を通さず空白で区切る）。
# files_command は {files} を独立した語としてちょうど 1 回含む
JQ_CMD_DEFS='
def cmd_ok: type == "string" and test("\\S") and (test("[;&|<>$`'"'"'\"\\\\\\n\\r]") | not);
def files_ok: cmd_ok and ([splits("\\s+")] | map(select(. == "{files}")) | length) == 1 and ([match("\\{files\\}"; "g")] | length) == 1;
'

usage() {
    jq -nc '{ok: false, error: "usage: test-commands-prepare <worktree> --base <branch>"}'
    exit 2
}

fail() {
    jq -nc --arg e "$1" '{ok: false, error: $e}'
    exit 0
}

[[ $# -eq 3 && "$2" == "--base" && -n "$3" ]] || usage
WT=$(cd "$1" 2>/dev/null && pwd) || fail "cd failed: $1"
BASE="$3"
REF="refs/remotes/origin/$BASE"
TREE=$(git -C "$WT" rev-parse -q --verify "$REF^{tree}" 2>/dev/null) || fail "origin/$BASE を解決できない — テストコマンドの解決元は base の tree から決めるので決められない"

RUN_DIR=$(mktemp -d "${TMPDIR:-/tmp}/test-commands-XXXXXX") || fail "cannot create a directory under ${TMPDIR:-/tmp}"
COMMANDS_FILE="$RUN_DIR/commands.json"

# $1 = コマンドファイルの中身（JSON）。ファイルに書き、出力の JSON を stdout に出す（$2 以降は出力にだけ足す jq の引数と式）
emit_record() {
    local record="$1"
    printf '%s\n' "$record" > "$COMMANDS_FILE" || fail "cannot write $COMMANDS_FILE"
    jq -c --arg f "$COMMANDS_FILE" --arg d "$RUN_DIR" '{ok: true} + . + {commands_file: $f, run_dir: $d}' <<<"$record"
    exit 0
}

# (1) user 設定（repo 別の節。devflow_config は base の tree の skill-config.json と user 設定の共通の節も読む）
tc=$(devflow_config "$WT" "$BASE" test_commands)
if [[ "$tc" != "null" ]]; then
    if jq -e "$JQ_CMD_DEFS"' type == "object" and (.full_command | cmd_ok) and (.files_command | files_ok)' >/dev/null 2>&1 <<<"$tc"; then
        emit_record "$(jq -c '{source: "user_config", status: "resolved", full_command: (.full_command | gsub("^\\s+|\\s+$"; "")), files_command: (.files_command | gsub("^\\s+|\\s+$"; "")), sources: []}' <<<"$tc")"
    fi
    record=$(jq -nc '{source: "user_config", status: "unresolved", full_command: null, files_command: null, sources: []}')
    printf '%s\n' "$record" > "$COMMANDS_FILE" || fail "cannot write $COMMANDS_FILE"
    jq -c --arg f "$COMMANDS_FILE" --arg d "$RUN_DIR" --arg raw "$tc" \
        '{ok: true} + . + {commands_file: $f, run_dir: $d, error: ("user 設定の \"dev-flow\".test_commands が不正（{full_command, files_command} の object で、どちらも shell の記号・引用符を含まない 1 行、files_command は {files} を独立した語としてちょうど 1 回含む。受信: " + $raw + "）")}' <<<"$record"
    exit 0
fi

# (2) origin/<base> の tree の tests/run-*.sh（run-tests と同じく mode 100755 の blob だけ）
git -C "$WT" ls-tree -z "$TREE" -- tests/ > "$RUN_DIR/base-tests.raw" 2>/dev/null || fail "git ls-tree origin/$BASE failed"
runners=()
while IFS= read -r -d '' entry; do
    meta="${entry%%$'\t'*}"
    path="${entry#*$'\t'}"
    [[ "$path" == tests/run-*.sh && "${meta#* }" == blob\ * && "${meta%% *}" == 100755 ]] && runners+=("$path")
done < "$RUN_DIR/base-tests.raw"
if [[ ${#runners[@]} -gt 0 ]]; then
    emit_record "$(printf '%s\n' "${runners[@]}" | jq -R . | jq -sc '{source: "runners", status: "resolved", full_command: null, files_command: null, sources: .}')"
fi

# (3) resolver に渡す束（origin/<base> の tree から git ls-tree / git show で読む）
BUNDLE_FILE="$RUN_DIR/bundle.md"
git -C "$WT" ls-tree -r --name-only "$TREE" > "$RUN_DIR/base-tree.txt" 2>/dev/null || fail "git ls-tree origin/$BASE failed"
picked=()
while IFS= read -r path; do
    [[ ${#picked[@]} -lt $BUNDLE_FILES_MAX ]] || break
    [[ "$path" =~ $BUNDLE_PATH_RE ]] && picked+=("$path")
done < "$RUN_DIR/base-tree.txt"
{
    printf '# origin/%s の tree（%s）から集めたファイル\n\n' "$BASE" "$TREE"
    printf '## トップレベルのエントリ\n\n'
    git -C "$WT" ls-tree --name-only "$TREE" 2>/dev/null
    for path in "${picked[@]+"${picked[@]}"}"; do
        printf '\n## ファイル: %s\n<<<FILE %s>>>\n' "$path" "$path"
        git -C "$WT" show "$TREE:$path" 2>/dev/null | head -c "$BUNDLE_FILE_BYTES_MAX"
        printf '\n<<<END FILE>>>\n'
    done
} > "$BUNDLE_FILE" || fail "cannot write $BUNDLE_FILE"

jq -nc --arg f "$COMMANDS_FILE" --arg d "$RUN_DIR" --arg b "$BUNDLE_FILE" --args \
    '{ok: true, source: "resolver", status: "unresolved", full_command: null, files_command: null, sources: [],
      commands_file: $f, run_dir: $d, bundle_file: $b, bundle_files: $ARGS.positional}' "${picked[@]+"${picked[@]}"}"
