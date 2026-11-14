#!/usr/bin/env bash
# red→green 実証: 実装だけ退避して base に戻し、test が red→green に転じるか決定論判定する。
# untracked(新規)・tracked-modified いずれの impl ファイルにも対応する。
# 使い方:
#   redgreen-verify state-dir → {"state_dir":"<abs>"}(worktree の外に mktemp -d で作る。失敗は {"state_dir":""} で exit 2)
#   redgreen-verify start --state-dir <abs> [--wait-sec <n=300>] [--base <ref>] [--commands <file>] <worktree> <test_files_csv> <impl_files_csv> [<test_files_csv> <impl_files_csv> ...]
#   redgreen-verify wait  --state-dir <abs> [--wait-sec <n=480>]
#   redgreen-verify stop  --state-dir <abs> [--timeout-sec <n=60>]
#   （内部）redgreen-verify supervise --state-dir <abs> / redgreen-verify run --state-dir <abs>
#   red→green は 1 回の Bash の上限（600 秒）を超えうるので、切り離して実行する（_lib/scripts/bg-job.sh）。
#   start は起動してすぐ返り、wait は最大 --wait-sec 待って、終わっていれば下の出力を、まだなら {"status":"running","results":[]} を返す。
#   results を空で持たせるのは、終わった応答と同じ schema（results 必須）に収めるため。
#   state dir の results.json が判定の入力になり、テストは同じ uid で worktree を cwd に走る。テストが既知のパスで結果を書けないよう、
#   state dir は worktree の外の推測できない場所に置き(start は worktree の中を拒否する)、読むのは run が完走して書いた結果だけにする(emit_outcome)。
#   stop は実行を止める。退避した impl は実行の止まり方によらず supervisor が戻す（bg_job_hook_cleanup）—
#   止めた後の worktree を以降の phase がそのまま使うので、テストを KILL しても impl を欠いたままにしない。
#   (test_files, impl_files) ペアを複数受け、引数順に 1 ペアずつ退避→red→復元→green を実行する。
#   退避先の base は既定で HEAD(implementer は commit しないので、Evaluate の変更は HEAD との差分にある)。
#   --base <ref> を渡すと HEAD と <ref> の merge-base を base にする。Final reconcile は PR の commit 済み tree を
#   判定するので、HEAD 基準では impl が全件 HEAD と同一になり何も外せない(PR の差分 = merge-base からの差分)。
#   merge-base が解決できなければ判定せず {"results":[]} で exit 2。
#   ペアごとの red 意味論は 1 ペア呼び出しと同一(当該ペアの impl だけを外す)。worktree を書き換えるため
#   ペア間の並列化は不可で、Evaluate の全 AC を 1 呼び出しにまとめるのは spawn 数削減のため(issue #683)。
# テストは repo の任意コードなので sandbox 内で走らせる(bin/redgreen-verify を excludedCommands に登録しない。
# .claude/rules/dev-flow.md)。そのため index を書く git は使わない(write_head_blob)。
# テストの実行の形(起動するコマンド・実行する script)は、Setup が base の tree から解決したコマンドファイル
# (--commands。中身の形は test-commands-prepare.sh)と base($BASE)の tree だけで決める。worktree 側で欠けた・変わったものは
# 入力エラーにして昇格させず、PR 側の形では実行しない(PR が自分のテストの起動の形を選べると、red→green を作れる)。
# テストファイル自体とランナーの設定ファイルは worktree(PR)の内容のまま実行する。言語別に決め打ちした判定は持たない。
#   - status "resolved" で commands({dir, full_command, files_command} の配列)がある(user 設定・resolver): ペアの test_files を
#     含む最も深い entry を 1 つ選び(run-tests の --files と同じ振り分け)、その files_command を空白で区切り、{files} の語を
#     test_files(dir からの相対パス)に置き換えた argv を、dir を cwd に shell を通さず 1 本実行する。test_files がどの entry の
#     dir にも含まれない・複数の entry に分かれる・dir が worktree 内の実ディレクトリでない(無い・symlink)ペアは
#     reason "test command dir ..." の入力エラー。起動内容を worktree のファイルへ委譲する形
#     (npm / pnpm / yarn / bun の script → 全 package.json の scripts、make / just / task → Makefile 等、語が名指す repo の
#     ファイル)は委譲先が $BASE と違うペアを reason "test command script changed vs base: <path> (scripts)" /
#     "test command file changed vs base: <path>" の入力エラーにする
#   - source "runners": $BASE の tree の tests/run-*.sh(mode 100755)を全本、DEVFLOW_TEST_FILES=<test_files を 1 行 1 件で
#     書いたファイル>(run-tests の --files と同じ契約)を渡して実行する。実行する script が worktree で $BASE と違う・欠けている、
#     または $BASE に無い tests/run-*.sh が worktree にあるペアは reason "test runner script changed vs base: <path>" /
#     "test runner script not in base: <path>" の入力エラー(script 自身の出力を red→green の根拠にしない)
#   - --commands 無し・ファイルが無い・JSON として読めない・status "unresolved"・{files} の語がちょうど 1 つ無い:
#     全ペアが reason "test command unresolved (<理由>)" の入力エラー
# 出力(stdout, JSON 1行。results は引数順の配列。root を object にするのは workflow の agent() schema が
# root object を要求するため — haiku proxy に配列を包み直させず verbatim 転写で済ませる):
#   {"results":[{"index":N,"red":bool,"green":bool,"reason":"..."[,"headdiff":{new,modified,unchanged,total}]}, ...]}
# 入力・分離エラーのペアは {"index":N,"red":false,"green":false,"reason":"..."} で続行する(headdiff なし)。
# red / green どちらの test 実行の前にも workspace-prebuild.sh で pnpm ワークスペースのビルド成果物を
# その時点のソースから作り直す(issue #754。red は impl 退避後・green は復元後でソースが違うため両方で呼ぶ)。
# ビルドが失敗した phase ではテストを実行せず、当該ペアを reason "workspace build failed: <pkgs> (red|green)"
# の入力・分離エラーと同じ形で返す(テスト未実行を red / green と判定しない)。
# headdiff は判定が完了し(reason "ok")、base を解決できたペアに付く。
# test_files を base(既定 HEAD)基準で new(base に無い)/modified(base にあり差分あり)/unchanged(base と同一)
# に三分類した件数で、runner の種類・拡張子に依存しない fallback 信号。red/green の判定には影響しない。
# exit 0 = 1 ペア以上が判定完了(red/green は JSON 参照) / exit 2 = 全ペアが入力・分離エラー、
# 実行が結果を残さず終わった(stop・上限時間・supervisor の消失)、または引数不正(stdout は {"results":[]})
# (= deterministic 昇格しないこと)。running の応答は exit 0
# REDGREEN_VERIFY_POLL_SEC(状態確認の間隔)は bats が短い間隔で回すための上書き口(workflow は渡さない)。
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREBUILD="$SCRIPT_DIR/workspace-prebuild.sh"

# shellcheck source=../../_lib/scripts/bg-job.sh
source "$SCRIPT_DIR/../../_lib/scripts/bg-job.sh"
BG_JOB_NAME=redgreen-verify
BG_JOB_SELF="$SCRIPT_DIR/$(basename "${BASH_SOURCE[0]}")"
BG_JOB_POLL_SEC="${REDGREEN_VERIFY_POLL_SEC:-1}"
# supervisor が実行を止める上限。workflow の待機上限（_lib/redgreen-targets.mjs の REDGREEN_WAIT_CAP_SEC）より長くして
# 通常は workflow の stop で止め、workflow が stop を呼ばずに終わったときだけこれで止める
RG_TIMEOUT_SEC=3900

paths() {
  bg_job_paths "$1"
  RG_RESULTS="$BG_JOB_STATE_DIR/results.json"
  # 退避した impl の置き場(相対パス保持)。run が消えても supervisor が戻せるよう state dir に置く
  IMPL_BACKUP="$BG_JOB_STATE_DIR/impl-backup"
  TEST_FILES_LIST="$BG_JOB_STATE_DIR/test-files.txt"
}

# impl の退避・headdiff の比較先(commit)。--base 無しは HEAD(run が決める)
BASE_REF=""
BASE="HEAD"
# テストの起動の形(run が load_test_command で決める)。RUN_MODE は "command"(FILES_WORDS を実行)・"runners"(BASE_RUNNERS を
# 実行)・""(RUN_ERROR を reason にした入力エラー)
RUN_MODE=""
RUN_ERROR=""
# コマンドファイルの commands の dir と files_command(同じ添字で対応。load_test_command が読む)
CMD_DIRS=()
CMD_FILES_COMMANDS=()
# ペアが使う entry(select_pair_command が決める): files_command を空白で区切った語({files} の語をちょうど 1 つ含む)・
# 起動する cwd("." か worktree 相対の dir)・dir からの相対パスにした test_files
FILES_WORDS=()
PAIR_DIR="."
PAIR_TESTS=()
# $BASE の tree の tests/run-*.sh(mode 100755)の worktree 相対パス
BASE_RUNNERS=()
# source "runners" で DEVFLOW_TEST_FILES に渡す一覧(state dir = worktree の外。paths が決める)
TEST_FILES_LIST=""

# --- ペア単位の状態(verify_pair の冒頭で毎回リセットする) ---
TESTS=()
IMPLS=()
# impl ファイルを $BASE(既定 HEAD)基準で三分類する。共有 stash スタック(main checkout・全 worktree・
# 全セッションで共有)には一切読み書きしない — 位置指定 pop は「自分が積んだ entry」を
# 保証せず、他セッションの WIP を worktree に適用する(issue #630)。
#   UNTRACKED_IMPLS: $BASE に無い(未追跡 / git add のみの新規 / --base 以降に commit された新規) → cp -p 退避 + rm
#   TRACKED_IMPLS  : $BASE にあり worktree と差分あり → cp -p 退避 + write_head_blob で base 化(index は書かない)
#   UNCHANGED_IMPLS: $BASE と同一 → 退避対象外(base 化しても red 判定に寄与しない)
UNTRACKED_IMPLS=()
TRACKED_IMPLS=()
UNCHANGED_IMPLS=()
UNTRACKED_SAVED=false
TRACKED_SAVED=false
PAIR_JSON=""
# 直近の run_tests で workspace-prebuild が失敗したときの理由(成功・対象なしは空)
BUILD_FAILURE=""

run_tests() {
  local rc=0 pb_out w path argv
  BUILD_FAILURE=""
  if ! pb_out="$(bash "$PREBUILD" "$PWD" 2>/dev/null)"; then
    BUILD_FAILURE="$(jq -r '.reason // empty' <<< "$pb_out" 2>/dev/null)"
    [ -n "$BUILD_FAILURE" ] || BUILD_FAILURE="workspace build failed"
    return 1
  fi
  if [ "$RUN_MODE" = runners ]; then
    printf '%s\n' "${TESTS[@]}" > "$TEST_FILES_LIST" || return 1
    for path in "${BASE_RUNNERS[@]}"; do
      DEVFLOW_TEST_FILES="$TEST_FILES_LIST" "$PWD/$path" >/dev/null 2>&1 < /dev/null || rc=1
    done
    return $rc
  fi
  argv=()
  for w in "${FILES_WORDS[@]}"; do
    if [ "$w" = "{files}" ]; then argv+=("${PAIR_TESTS[@]}"); else argv+=("$w"); fi
  done
  ( cd "$PAIR_DIR" || exit 1; "${argv[@]}" ) >/dev/null 2>&1 < /dev/null || rc=1
  return $rc
}

# ペアの test_files(TESTS)が使う commands の entry を決める(FILES_WORDS / PAIR_DIR / PAIR_TESTS)。各ファイルを含む最も深い
# entry("." は全ファイルを含む)が全ファイルで同じ 1 つのときだけ決まる。決まらない・dir が worktree 内の実ディレクトリでない
# (pwd -P が <worktree の実体>/<dir> と一致しない = 無い・symlink を経由する)ときは理由を stdout に出して 1 を返す
select_pair_command() {
  local t k dir len best best_len chosen=-1
  for t in "${TESTS[@]}"; do
    best=-1; best_len=-1
    for k in "${!CMD_DIRS[@]}"; do
      dir="${CMD_DIRS[$k]}"
      if [ "$dir" = "." ]; then len=0; elif [[ "$t" == "$dir"/* ]]; then len=${#dir}; else continue; fi
      if [ "$len" -gt "$best_len" ]; then best=$k; best_len=$len; fi
    done
    if [ "$best" -lt 0 ]; then echo "test command dir: test file is not under any commands dir: $t"; return 1; fi
    if [ "$chosen" -ge 0 ] && [ "$chosen" -ne "$best" ]; then
      echo "test command dir: test files belong to more than one commands dir: ${CMD_DIRS[$chosen]}, ${CMD_DIRS[$best]}"; return 1
    fi
    chosen=$best
  done
  dir="${CMD_DIRS[$chosen]}"
  if [ "$dir" != "." ]; then
    if [[ -z "$dir" || "$dir" == /* || "/$dir/" == *//* || "/$dir/" == */./* || "/$dir/" == */../* ]] \
        || [ ! -d "$dir" ] || [ "$(cd "$dir" 2>/dev/null && pwd -P)" != "$(pwd -P)/$dir" ]; then
      echo "test command dir is not a real directory inside the worktree: $dir"; return 1
    fi
  fi
  PAIR_DIR="$dir"
  PAIR_TESTS=()
  for t in "${TESTS[@]}"; do
    [ "$dir" = "." ] || t="${t#"$dir"/}"
    # `-` で始まるパスは ./ を付けて渡す(PR が足した `-x` 名のファイルをランナーが option として読み、
    # テストを実行しないまま exit 0 で green にしないように)
    case "$t" in -*) t="./$t" ;; esac
    PAIR_TESTS+=("$t")
  done
  read -r -a FILES_WORDS <<< "${CMD_FILES_COMMANDS[$chosen]}"
}

# source "runners" のとき、実行する tests/run-*.sh が $BASE の tree と同じかを確かめる。違う・欠けている・$BASE に無い
# script があれば、その理由を stdout に出して 1 を返す(git hash-object は書き込まない。失敗は違うものとして数える)
check_base_runners() {
  local path blob
  for path in "${BASE_RUNNERS[@]}"; do
    blob=""
    [ -f "$path" ] && blob="$(git hash-object -- "$path" 2>/dev/null)"
    if [ -z "$blob" ] || [ "$blob" != "$(git rev-parse -q --verify "$BASE:$path" 2>/dev/null)" ]; then
      echo "test runner script changed vs base: $path"; return 1
    fi
  done
  for path in tests/run-*.sh; do
    [ -f "$path" ] || continue
    if ! git cat-file -e "$BASE:$path" 2>/dev/null; then
      echo "test runner script not in base: $path"; return 1
    fi
    if [ "$(git hash-object -- "$path" 2>/dev/null)" != "$(git rev-parse -q --verify "$BASE:$path" 2>/dev/null)" ]; then
      echo "test runner script changed vs base: $path"; return 1
    fi
  done
  return 0
}

# files_command は base から解決しても、起動内容を worktree のファイルへ委譲する形(PM の script・make / just / task・
# repo の script を名指す語)だと PR が中身を差し替えて red→green を作れる。委譲先が $BASE の tree と同じかを確かめ、
# 違えばその理由を stdout に出して 1 を返す(runners の check_base_runners と同じ扱い。コマンドが名指さないランナーの設定ファイルは対象外)
same_as_base() {
  local path="$1" blob=""
  [ -f "$path" ] && blob="$(git hash-object -- "$path" 2>/dev/null)"
  [ -n "$blob" ] && [ "$blob" = "$(git rev-parse -q --verify "$BASE:$path" 2>/dev/null)" ]
}

# 照合するのは $BASE にあるか git が追跡しているパスだけ。PR が持ち込めるのは追跡されたファイルで、未追跡のもの
# (.venv/bin/pytest・node_modules/.bin/* 等の環境側の実行ファイル)まで照合すると全ペアが入力エラーになり実証が成立しない
in_command_scope() {
  [ "$(git cat-file -t "$BASE:$1" 2>/dev/null)" = blob ] || git ls-files --error-unmatch -- "$1" >/dev/null 2>&1
}

# package.json の scripts(pre / post を含む)を $BASE と worktree で比べる。workspace の各 package も対象にする
# (--filter 等で別の package の script に委譲できる)
check_package_scripts() {
  local list path b w
  list="$( { git ls-tree -r --name-only "$BASE" 2>/dev/null; git ls-files -co --exclude-standard 2>/dev/null; } \
    | grep -E '(^|/)package\.json$' | sort -u)"
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    b='{}'
    if git cat-file -e "$BASE:$path" 2>/dev/null; then
      b="$(git cat-file --filters "$BASE:$path" 2>/dev/null | jq -cS '.scripts // {}' 2>/dev/null)" || b=invalid
    fi
    w='{}'
    [ -f "$path" ] && { w="$(jq -cS '.scripts // {}' "$path" 2>/dev/null)" || w=invalid; }
    if [ "$b" != "$w" ]; then
      echo "test command script changed vs base: $path (scripts)"; return 1
    fi
  done <<< "$list"
  return 0
}

check_base_command() {
  local w path f prefix=""
  [ "$PAIR_DIR" = "." ] || prefix="$PAIR_DIR/"
  case "${FILES_WORDS[0]}" in
    npm|pnpm|yarn|bun)
      case "${FILES_WORDS[1]:-}" in
        exec|dlx|x) ;;
        *) check_package_scripts || return 1 ;;
      esac ;;
    make|gmake|just|task)
      for f in GNUmakefile makefile Makefile justfile Justfile .justfile Taskfile.yml Taskfile.yaml; do
        if in_command_scope "$prefix$f"; then
          same_as_base "$prefix$f" || { echo "test command file changed vs base: $prefix$f"; return 1; }
        fi
      done ;;
  esac
  # コマンドが名指す repo のファイル(語そのもの・--opt=<path> の値)
  for w in "${FILES_WORDS[@]}"; do
    [ "$w" = "{files}" ] && continue
    for path in "$w" "${w#*=}"; do
      path="${path#./}"
      [ -n "$path" ] && [[ "$path" != /* ]] || continue
      if in_command_scope "$prefix$path"; then
        same_as_base "$prefix$path" || { echo "test command file changed vs base: $prefix$path"; return 1; }
      fi
    done
  done
  return 0
}

# 退避済み impl を $IMPL_BACKUP から相対パス保持で書き戻す(cp -p で mode も戻す)。
# 配列展開は set -u のため必ず件数 guard 下で行う。
restore_saved() {
  local f
  if [ "$UNTRACKED_SAVED" = true ] && [ "${#UNTRACKED_IMPLS[@]}" -gt 0 ]; then
    for f in "${UNTRACKED_IMPLS[@]}"; do
      if [ -f "$IMPL_BACKUP/$f" ]; then mkdir -p "$(dirname "$f")"; cp -p "$IMPL_BACKUP/$f" "$f"; fi
    done
  fi
  if [ "$TRACKED_SAVED" = true ] && [ "${#TRACKED_IMPLS[@]}" -gt 0 ]; then
    for f in "${TRACKED_IMPLS[@]}"; do
      if [ -f "$IMPL_BACKUP/$f" ]; then mkdir -p "$(dirname "$f")"; cp -p "$IMPL_BACKUP/$f" "$f"; fi
    done
  fi
}

# tracked impl 1 件を $BASE の内容と実行ビットに戻す。git checkout HEAD -- は index も書き換える(index.lock を
# 取る)ので使わない — テストを sandbox 内で回すこのスクリプトからは、checkout の .git が sandbox から書けない
# 場合に .git/worktrees/*/index.lock が書けない。blob の読み出し(filter 適用済み)と ls-tree は index に触れない。通常ファイル以外(symlink 等)は失敗扱い。
write_head_blob() {
  local f="$1" mode
  mode="$(git ls-tree "$BASE" -- "$f" 2>/dev/null | awk '{print $1}')"
  case "$mode" in
    100644|100755) : ;;
    *) return 1 ;;
  esac
  git cat-file --filters "$BASE:$f" > "$f" 2>/dev/null || return 1
  if [ "$mode" = 100755 ]; then chmod +x "$f"; else chmod -x "$f"; fi
}

# --- cleanup / restore(二段構え: 各ペアの終端で本文から呼び、途中終了時は supervisor の bg_job_hook_cleanup が現ペア分を戻す) ---
restore_impl() {
  restore_saved
  UNTRACKED_SAVED=false
  TRACKED_SAVED=false
  rm -rf "$IMPL_BACKUP"
}

# 1 ペアを判定する。PAIR_JSON に index 抜きの JSON 本体を残し、判定完了なら 0・入力/分離エラーなら 2 を返す。
# 退避した impl の復元は呼び出し側の restore_impl が担う(return 経路を問わず必ず呼ぶ)。
verify_pair() {
  local test_csv="$1" impl_csv="$2" t i f
  TESTS=(); IMPLS=()
  UNTRACKED_IMPLS=(); TRACKED_IMPLS=(); UNCHANGED_IMPLS=()
  UNTRACKED_SAVED=false; TRACKED_SAVED=false
  FILES_WORDS=(); PAIR_DIR="."; PAIR_TESTS=()
  PAIR_JSON=""

  IFS=',' read -r -a TESTS <<< "$test_csv"
  IFS=',' read -r -a IMPLS <<< "$impl_csv"

  # テストの起動の形が決まらない(コマンドファイルが無い・unresolved 等)ペアは判定しない
  if [ -z "$RUN_MODE" ]; then
    PAIR_JSON="$(jq -nc --arg r "$RUN_ERROR" '{red: false, green: false, reason: $r}')"
    PAIR_JSON="${PAIR_JSON#\{}"; PAIR_JSON="${PAIR_JSON%\}}"
    return 2
  fi
  # 実行する tests/run-*.sh が base と違うペアは判定しない(impl を退避する前の worktree で確かめる)
  local runner_problem
  if [ "$RUN_MODE" = runners ] && ! runner_problem="$(check_base_runners)"; then
    PAIR_JSON="$(jq -nc --arg r "$runner_problem" '{red: false, green: false, reason: $r}')"
    PAIR_JSON="${PAIR_JSON#\{}"; PAIR_JSON="${PAIR_JSON%\}}"
    return 2
  fi
  # test_files を実行する entry(dir と files_command)が 1 つに決まらないペアは判定しない
  if [ "$RUN_MODE" = command ]; then
    # $(...) の中では配列を残せないので、理由はファイルで受ける
    if ! select_pair_command > "$BG_JOB_STATE_DIR/pair-command.reason"; then
      PAIR_JSON="$(jq -nc --arg r "$(cat "$BG_JOB_STATE_DIR/pair-command.reason")" '{red: false, green: false, reason: $r}')"
      PAIR_JSON="${PAIR_JSON#\{}"; PAIR_JSON="${PAIR_JSON%\}}"
      return 2
    fi
  fi
  # files_command の委譲先(package の script・Makefile 等・名指す repo のファイル)が base と違うペアも判定しない
  if [ "$RUN_MODE" = command ] && ! runner_problem="$(check_base_command)"; then
    PAIR_JSON="$(jq -nc --arg r "$runner_problem" '{red: false, green: false, reason: $r}')"
    PAIR_JSON="${PAIR_JSON#\{}"; PAIR_JSON="${PAIR_JSON%\}}"
    return 2
  fi
  # 層4: test と impl の混在(同一ファイル)は曖昧 → 昇格しない
  for t in "${TESTS[@]}"; do
    for i in "${IMPLS[@]}"; do
      [ "$t" = "$i" ] && { PAIR_JSON="\"red\":false,\"green\":false,\"reason\":\"file is both test and impl: $t\""; return 2; }
    done
  done

  for f in "${IMPLS[@]}"; do
    # cat-file -e は $BASE に無いと rc 128 + stderr メッセージ → 抑止して成否だけ使う
    if git cat-file -e "$BASE:$f" >/dev/null 2>&1; then
      if git diff --quiet "$BASE" -- "$f"; then
        UNCHANGED_IMPLS+=("$f")
      else
        TRACKED_IMPLS+=("$f")
      fi
    else
      UNTRACKED_IMPLS+=("$f")
    fi
  done

  # 0. 退避対象(untracked + 変更あり tracked)の存在を、worktree に何も加える前に全件検証する
  #    (部分退避による消失防止。削除済み tracked impl も base 化しても red 判定に意味が無いのでここで弾く)
  if [ "${#UNTRACKED_IMPLS[@]}" -gt 0 ]; then
    for f in "${UNTRACKED_IMPLS[@]}"; do
      [ -f "$f" ] || { PAIR_JSON="\"red\":false,\"green\":false,\"reason\":\"impl file not found: $f\""; return 2; }
    done
  fi
  if [ "${#TRACKED_IMPLS[@]}" -gt 0 ]; then
    for f in "${TRACKED_IMPLS[@]}"; do
      [ -f "$f" ] || { PAIR_JSON="\"red\":false,\"green\":false,\"reason\":\"impl file not found: $f\""; return 2; }
    done
  fi

  # 有効 impl が 0 件 = 何も外せないので red 判定に意味が無い → 判定せず 2(deterministic 昇格しない契約)
  if [ "${#UNTRACKED_IMPLS[@]}" -eq 0 ] && [ "${#TRACKED_IMPLS[@]}" -eq 0 ]; then
    PAIR_JSON="\"red\":false,\"green\":false,\"reason\":\"no impl changed vs ${BASE_REF:-HEAD}: $impl_csv\""; return 2
  fi

  # 1. 全件を cp -p で退避してから rename で $IMPL_BACKUP に見せる(supervisor は $IMPL_BACKUP の中身を無条件に書き戻すので、
  #    コピーの途中で止められたときに書きかけのファイルで impl を上書きしないため)
  local partial="$IMPL_BACKUP.partial"
  rm -rf "$partial"
  mkdir -p "$partial"
  for f in ${UNTRACKED_IMPLS[@]+"${UNTRACKED_IMPLS[@]}"} ${TRACKED_IMPLS[@]+"${TRACKED_IMPLS[@]}"}; do
    mkdir -p "$partial/$(dirname "$f")"
    cp -p "$f" "$partial/$f"
  done
  mv "$partial" "$IMPL_BACKUP"

  # 2. untracked impl: rm
  if [ "${#UNTRACKED_IMPLS[@]}" -gt 0 ]; then
    UNTRACKED_SAVED=true
    for f in "${UNTRACKED_IMPLS[@]}"; do
      rm -f "$f"
    done
  fi

  # 3. 変更あり tracked impl: TRACKED_SAVED=true(以降の失敗は restore_impl が戻す) → $BASE の内容で base 化
  if [ "${#TRACKED_IMPLS[@]}" -gt 0 ]; then
    TRACKED_SAVED=true
    for f in "${TRACKED_IMPLS[@]}"; do
      if ! write_head_blob "$f"; then
        PAIR_JSON="\"red\":false,\"green\":false,\"reason\":\"base checkout failed: $f\""; return 2
      fi
    done
  fi

  # red 判定(impl 退避中: test は落ちるべき)
  local red green build_failure=""
  if run_tests; then red=false; else red=true; fi
  [ -n "$BUILD_FAILURE" ] && build_failure="$BUILD_FAILURE (red)"

  # 復元(本文側。restore_impl も呼ばれるがフラグを落として二重復元を防ぐ)
  restore_saved
  UNTRACKED_SAVED=false
  TRACKED_SAVED=false

  # green 判定(復元後: test は通るべき)。red でビルドが失敗していても、成果物を復元後のソースで
  # 作り直すため green 側の run_tests は必ず実行する
  if run_tests; then green=true; else green=false; fi
  [ -z "$build_failure" ] && [ -n "$BUILD_FAILURE" ] && build_failure="$BUILD_FAILURE (green)"

  if [ -n "$build_failure" ]; then
    PAIR_JSON="\"red\":false,\"green\":false,\"reason\":\"$build_failure\""; return 2
  fi

  # headdiff: test_files を $BASE(既定 HEAD)基準で三分類する(拡張子非依存の fallback 信号。判定には使わない)。
  local headdiff_json="" hd_new=0 hd_mod=0 hd_unch=0
  if git rev-parse --verify -q "$BASE" >/dev/null 2>&1; then
    for t in "${TESTS[@]}"; do
      if git cat-file -e "$BASE:$t" >/dev/null 2>&1; then
        if git diff --quiet "$BASE" -- "$t"; then hd_unch=$((hd_unch+1)); else hd_mod=$((hd_mod+1)); fi
      else
        hd_new=$((hd_new+1))
      fi
    done
    headdiff_json=",\"headdiff\":{\"new\":$hd_new,\"modified\":$hd_mod,\"unchanged\":$hd_unch,\"total\":${#TESTS[@]}}"
  fi

  PAIR_JSON="\"red\":$red,\"green\":$green,\"reason\":\"ok\"$headdiff_json"
  return 0
}

# 結果を atomic に書く(wait が書きかけを読まないように)
write_results() {
  local tmp="$RG_RESULTS.$$.tmp"
  printf '%s\n' "$1" > "$tmp" && mv "$tmp" "$RG_RESULTS"
}

# ---------------------------------------------------------------------------
# run(supervisor が worktree を cwd に起こす command。引数は start が spec に書く)
# ---------------------------------------------------------------------------

# コマンドファイル(spec の commands)と $BASE の tree からテストの起動の形を決める(RUN_MODE / RUN_ERROR)
load_test_command() {
  local file mode entry meta path n=0 w k count words
  file="$(bg_job_read_field "$BG_JOB_SPEC" .commands)"
  if [ -z "$file" ] || [ ! -f "$file" ]; then
    RUN_ERROR="test command unresolved (コマンドファイルが無い)"; return
  fi
  mode="$(jq -r 'if type != "object" then "invalid"
    elif .status == "unresolved" then "unresolved"
    elif .status == "resolved" and .source == "runners" then "runners"
    elif .status == "resolved" and (.commands | type == "array" and length > 0
        and all(.[]; type == "object" and (.dir | type == "string") and (.files_command | type == "string"))) then "command"
    else "invalid" end' "$file" 2>/dev/null)" || mode=invalid
  case "$mode" in
    command)
      count="$(jq -r '.commands | length' "$file")"
      for ((k = 0; k < count; k++)); do
        CMD_DIRS+=("$(jq -r --argjson k "$k" '.commands[$k].dir' "$file")")
        CMD_FILES_COMMANDS+=("$(jq -r --argjson k "$k" '.commands[$k].files_command' "$file")")
        read -r -a words <<< "${CMD_FILES_COMMANDS[$k]}"
        n=0
        for w in ${words[@]+"${words[@]}"}; do [ "$w" = "{files}" ] && n=$((n+1)); done
        if [ "$n" -ne 1 ]; then
          RUN_ERROR="test command unresolved (files_command に {files} の語がちょうど 1 つ無い)"; return
        fi
      done
      RUN_MODE=command ;;
    runners)
      # 1 行 1 エントリの出力を here-string で読む(process substitution は sandbox で /dev/fd が塞がれる)
      while IFS= read -r entry; do
        meta="${entry%%$'\t'*}"
        path="${entry#*$'\t'}"
        [[ "$path" == tests/run-*.sh && "$meta" == 100755\ blob\ * ]] && BASE_RUNNERS+=("$path")
      done <<< "$(git ls-tree "$BASE" -- tests/ 2>/dev/null)"
      if [ "${#BASE_RUNNERS[@]}" -eq 0 ]; then
        RUN_ERROR="test command unresolved (base の tree に tests/run-*.sh が無い)"; return
      fi
      RUN_MODE=runners ;;
    unresolved) RUN_ERROR="test command unresolved (status unresolved)" ;;
    *) RUN_ERROR="test command unresolved (コマンドファイルを読めない)" ;;
  esac
}

cmd_run() {
  BASE_REF="$(bg_job_read_field "$BG_JOB_SPEC" .base)"
  if [ -n "$BASE_REF" ]; then
    BASE="$(git merge-base HEAD "$BASE_REF" 2>/dev/null)" || BASE=""
    if [ -z "$BASE" ]; then
      echo "merge-base failed: HEAD $BASE_REF" >&2
      write_results '{"results":[]}'
      exit 2
    fi
  fi
  load_test_command
  # 呼び出し元の環境の同名変数は継がない(入れ子の run-tests の一覧を tests/run-*.sh に渡さない)
  unset DEVFLOW_CHANGED_FILES DEVFLOW_BASE DEVFLOW_TEST_FILES DEVFLOW_FAILED_FILES

  local args=() a
  while IFS= read -r a; do args+=("$a"); done <<< "$(jq -r '.pairs[]' "$BG_JOB_SPEC")"
  set -- "${args[@]}"

  local results=() completed=0 index=0 k out
  while [ "$#" -ge 2 ]; do
    if verify_pair "$1" "$2"; then completed=$((completed+1)); fi
    restore_impl
    results+=("{\"index\":$index,$PAIR_JSON}")
    index=$((index+1))
    shift 2
  done

  out='{"results":['
  for ((k = 0; k < ${#results[@]}; k++)); do
    [ "$k" -gt 0 ] && out="$out,"
    out="$out${results[$k]}"
  done
  # 書けなければ exit 0 / 2 で終わらない(残っている results.json を run の結果として読ませない)
  write_results "$out]}" || exit 3
  [ "$completed" -gt 0 ] && exit 0
  exit 2
}

# ---------------------------------------------------------------------------
# bg-job の hook(退避した impl の書き戻し)
# ---------------------------------------------------------------------------

# $IMPL_BACKUP があれば run が復元を終える前に止まっている。中身を worktree へ書き戻す
restore_backup() {
  [ -d "$IMPL_BACKUP" ] || return 0
  local cwd f
  cwd="$(bg_job_read_field "$BG_JOB_SPEC" .cwd)"
  ( cd "$IMPL_BACKUP" && find . -type f -print0 ) | while IFS= read -r -d '' f; do
    mkdir -p "$(dirname "$cwd/$f")"
    cp -p "$IMPL_BACKUP/$f" "$cwd/$f"
  done
  rm -rf "$IMPL_BACKUP"
}

bg_job_hook_cleanup() { restore_backup; }
# supervisor が KILL 等で trap を走らせずに居なくなったときは、stop がここで書き戻す
bg_job_hook_orphan_cleanup() { restore_backup; }

# ---------------------------------------------------------------------------
# start / wait / stop
# ---------------------------------------------------------------------------

# bg-job の応答を redgreen-verify の出力に畳む
emit_outcome() {
  local job="$1"
  if [ "$(jq -r '.status // empty' <<< "$job")" = running ]; then
    echo '{"status":"running","results":[]}'
    return 0
  fi
  # 終わった応答はどれも supervisor がもう居ない。後片付けをせずに消えた場合はここで書き戻す
  bg_job_hook_orphan_cleanup
  # results.json を書いて exit 0 / 2 で終わるのは完走した run だけ。テストが run ごと落とした(kill -9 0 等)ときに
  # 上書きされずに残ったファイルを結果として読まない
  local code
  code="$(jq -r '.exit_code' <<< "$job")"
  if [ -f "$RG_RESULTS" ] && { [ "$code" = 0 ] || [ "$code" = 2 ]; }; then
    cat "$RG_RESULTS"
    [ "$code" = 0 ] && return 0
    return 2
  fi
  echo "redgreen-verify: 結果が無い: $job" >&2
  echo '{"results":[]}'
  return 2
}

cmd_state_dir() {
  local dir tmp="${TMPDIR:-/tmp}"
  # macOS の TMPDIR は末尾が / で、そのままだと // を含むパスになり redgreenStateDirFrom が拒否する
  if dir="$(mktemp -d "${tmp%/}/redgreen-verify.XXXXXXXX")"; then
    jq -nc --arg d "$dir" '{state_dir: $d}'
    return 0
  fi
  echo '{"state_dir":""}'
  return 2
}

cmd_start() {
  local wait_sec="$1" base="$2" commands="$3" worktree="$4" problem
  shift 4
  case "$BG_JOB_STATE_DIR/" in
    "$worktree"/*)
      echo "redgreen-verify: --state-dir ($BG_JOB_STATE_DIR) が worktree の中にある(テストが結果を書ける)" >&2
      echo '{"results":[]}'
      return 2 ;;
  esac
  # 前回 run の残り(同じ state dir)を先に止める
  if ! problem="$(bg_job_reset "$worktree")"; then
    echo "redgreen-verify: $problem" >&2
    echo '{"results":[]}'
    return 2
  fi
  bg_job_write_json "$BG_JOB_SPEC" --arg cwd "$worktree" \
    --arg command "bash $(printf '%q' "$BG_JOB_SELF") run --state-dir $(printf '%q' "$BG_JOB_STATE_DIR")" \
    --argjson timeout_seconds "$RG_TIMEOUT_SEC" --arg base "$base" --arg commands "$commands" \
    --argjson pairs "$(printf '%s\n' "$@" | jq -R . | jq -sc .)" \
    '{cwd: $cwd, command: $command, timeout_seconds: $timeout_seconds, base: $base, commands: $commands, pairs: $pairs}'
  emit_outcome "$(bg_job_start "$wait_sec")"
}

# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

usage() {
  [ -z "${1:-}" ] || echo "redgreen-verify: $1" >&2
  echo "usage: redgreen-verify.sh state-dir" >&2
  echo "       redgreen-verify.sh start --state-dir <abs> [--wait-sec <n>] [--base <ref>] [--commands <file>] <worktree> <test_files_csv> <impl_files_csv> [<test_files_csv> <impl_files_csv> ...]" >&2
  echo "       redgreen-verify.sh wait --state-dir <abs> [--wait-sec <n>]" >&2
  echo "       redgreen-verify.sh stop --state-dir <abs> [--timeout-sec <n>]" >&2
  echo '{"results":[]}'
  exit 2
}

main() {
  local sub="${1:-}" state_dir='' wait_sec='' timeout_sec='' base='' commands=''
  case "$sub" in
    state-dir) cmd_state_dir; return ;;
    start|wait|stop|supervise|run) shift ;;
    *) usage 'subcommand (state-dir|start|wait|stop) required' ;;
  esac
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --state-dir|--wait-sec|--timeout-sec|--base|--commands)
        [ -n "${2:-}" ] || usage "$1 requires a value"
        case "$1" in
          --state-dir) state_dir="$2" ;;
          --wait-sec) wait_sec="$2" ;;
          --timeout-sec) timeout_sec="$2" ;;
          --base) base="$2" ;;
          --commands) commands="$2" ;;
        esac
        shift 2 ;;
      --*) usage "Unknown option: $1" ;;
      *) break ;;
    esac
  done
  [ -n "$state_dir" ] || usage '--state-dir is required'
  [[ -z "$wait_sec" || "$wait_sec" =~ ^[0-9]+$ ]] || usage "--wait-sec must be a non-negative integer, got '$wait_sec'"
  [[ -z "$timeout_sec" || "$timeout_sec" =~ ^[0-9]+$ ]] || usage "--timeout-sec must be a non-negative integer, got '$timeout_sec'"
  if [ "$sub" = start ]; then
    [ "$#" -ge 3 ] && [ $(( $# % 2 )) -eq 1 ] || usage
  else
    [ "$#" -eq 0 ] || usage "Unexpected argument: $1"
  fi
  mkdir -p "$state_dir" 2>/dev/null
  paths "$(cd "$state_dir" 2>/dev/null && pwd || echo "$state_dir")"

  case "$sub" in
    supervise) bg_job_supervise ;;
    run) cmd_run ;;
    start)
      local worktree
      worktree="$(cd "$1" 2>/dev/null && pwd)" || { echo "cd failed: $1" >&2; echo '{"results":[]}'; exit 2; }
      shift
      cmd_start "$wait_sec" "$base" "$commands" "$worktree" "$@" ;;
    wait) emit_outcome "$(bg_job_wait "$wait_sec")" ;;
    stop) bg_job_stop "$timeout_sec" ;;
  esac
}

main "$@"
