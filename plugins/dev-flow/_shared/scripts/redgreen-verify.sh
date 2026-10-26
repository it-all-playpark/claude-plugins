#!/usr/bin/env bash
# red→green 実証: 実装だけ退避して base に戻し、test が red→green に転じるか決定論判定する。
# untracked(新規)・tracked-modified いずれの impl ファイルにも対応する。
# 使い方: redgreen-verify.sh <worktree> <test_files_csv> <impl_files_csv> [<test_files_csv> <impl_files_csv> ...]
#   (test_files, impl_files) ペアを複数受け、引数順に 1 ペアずつ退避→red→復元→green を実行する。
#   ペアごとの red 意味論は 1 ペア呼び出しと同一(当該ペアの impl だけを外す)。worktree を書き換えるため
#   ペア間の並列化は不可で、Evaluate の全 AC を 1 呼び出しにまとめるのは spawn 数削減のため(issue #683)。
# テストは repo の任意コードなので sandbox 内で走らせる(bin/redgreen-verify を excludedCommands に登録しない。
# .claude/rules/dev-flow.md)。そのため index を書く git は使わない(write_head_blob)。
# test_files の受理判定と実行コマンドは detect-test-runner.sh(repo に既にある設定ファイルからランナーを判定)が決める。
# ランナーが判定できないファイルを含むペアは reason "non-test file declared (ランナー未検出): <file>" の入力エラー(昇格しない)。
# vdelta 経路: package.json の dependencies / devDependencies に vdelta があり、ランナーが vitest のときだけ、
# vitest の単体実行コマンドを `<PM の exec> vdelta run --report json -- <vitest のコマンド>` で包み、green 後に
# `<PM の exec> vdelta compare --report json` の出力を verdict として載せる(PM の exec は vitest コマンドの
# vitest より前の部分 = detect-test-runner.sh が lockfile から決めた prefix)。それ以外は素のランナーで実行する。
# 出力(stdout, JSON 1行。results は引数順の配列。root を object にするのは workflow の agent() schema が
# root object を要求するため — haiku proxy に配列を包み直させず verbatim 転写で済ませる):
#   {"results":[{"index":N,"red":bool,"green":bool,"reason":"...","testcmd_ran":bool[,"headdiff":{new,modified,unchanged,total}][,"verdict":{...}]}, ...]}
# testcmd_ran は当該ペアで vdelta run 経路を実行したか。
# 入力・分離エラーのペアは {"index":N,"red":false,"green":false,"reason":"..."} で続行する(testcmd_ran なし)。
# red / green どちらの test 実行の前にも workspace-prebuild.sh で pnpm ワークスペースのビルド成果物を
# その時点のソースから作り直す(issue #754。red は impl 退避後・green は復元後でソースが違うため両方で呼ぶ)。
# ビルドが失敗した phase ではテストを実行せず、当該ペアを reason "workspace build failed: <pkgs> (red|green)"
# の入力・分離エラーと同じ形で返す(テスト未実行を red / green と判定しない)。
# headdiff は vdelta run 経路が走らなかったペア(testcmd_ran=false)でのみ付く。
# test_files を HEAD 基準で new(HEAD に無い)/modified(HEAD にあり差分あり)/unchanged(HEAD と同一)
# に三分類した件数で、runner の種類・拡張子に依存しない fallback 信号。red/green の判定には影響しない。
# exit 0 = 1 ペア以上が判定完了(red/green は JSON 参照) / exit 2 = 全ペアが入力・分離エラー、
# または引数不正(stdout は {"results":[]})(= deterministic 昇格しないこと)
set -uo pipefail

WT="${1:?worktree required}"
shift
if [ "$#" -lt 2 ] || [ $(( $# % 2 )) -ne 0 ]; then
  echo "usage: redgreen-verify.sh <worktree> <test_files_csv> <impl_files_csv> [<test_files_csv> <impl_files_csv> ...]" >&2
  echo '{"results":[]}'; exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREBUILD="$SCRIPT_DIR/workspace-prebuild.sh"
DETECT="$SCRIPT_DIR/detect-test-runner.sh"

cd "$WT" 2>/dev/null || { echo "cd failed: $WT" >&2; echo '{"results":[]}'; exit 2; }

# vdelta 経路の有効化は repo の package.json の依存だけで決める(dev-flow 専用の設定ファイルは読まない)
VDELTA=false
if [ -f package.json ] && jq -e '((.dependencies // {}) + (.devDependencies // {})) | has("vdelta")' package.json >/dev/null 2>&1; then
  VDELTA=true
fi

# --- ペア単位の状態(verify_pair の冒頭で毎回リセットする) ---
TESTS=()
IMPLS=()
# detect-test-runner.sh が当該ペアの test_files について返した実行コマンド
# (1 要素 = argv を 1 行 1 要素で連結した文字列。先頭行は runner 名)
RUN_CMDS=()
# vdelta compare は当該ペアで vdelta run 経路が実際に実行された
# 場合のみ起動する。bats-only 等 vdelta run 未実行のペアでは RunStore に
# 当該 red/green の run pair が存在せず、無条件実行すると spurious な
# baseline-missing/malformed verdict を招くため。
VDELTA_TESTCMD_RAN=false
# vdelta run 経路で使った PM の exec prefix(vdelta compare も同じ prefix で起動する)
VDELTA_PREFIX=()
# impl ファイルを HEAD 基準で三分類する。共有 stash スタック(main checkout・全 worktree・
# 全セッションで共有)には一切読み書きしない — 位置指定 pop は「自分が積んだ entry」を
# 保証せず、他セッションの WIP を worktree に適用する(issue #630)。
#   UNTRACKED_IMPLS: HEAD に無い(未追跡 / git add のみの新規) → cp -p 退避 + rm
#   TRACKED_IMPLS  : HEAD にあり worktree と差分あり → cp -p 退避 + write_head_blob で base 化(index は書かない)
#   UNCHANGED_IMPLS: HEAD と同一 → 退避対象外(base 化しても red 判定に寄与しない)
TMPDIR_IMPL=""
UNTRACKED_IMPLS=()
TRACKED_IMPLS=()
UNCHANGED_IMPLS=()
UNTRACKED_SAVED=false
TRACKED_SAVED=false
PAIR_JSON=""
# 直近の run_tests で workspace-prebuild が失敗したときの理由(成功・対象なしは空)
BUILD_FAILURE=""

run_tests() {
  local rc=0 pb_out c runner argv a prefix
  BUILD_FAILURE=""
  if ! pb_out="$(bash "$PREBUILD" "$PWD" 2>/dev/null)"; then
    BUILD_FAILURE="$(jq -r '.reason // empty' <<< "$pb_out" 2>/dev/null)"
    [ -n "$BUILD_FAILURE" ] || BUILD_FAILURE="workspace build failed"
    return 1
  fi
  if [ "${#RUN_CMDS[@]}" -gt 0 ]; then
    for c in "${RUN_CMDS[@]}"; do
      runner="${c%%$'\n'*}"
      argv=()
      while IFS= read -r a; do argv+=("$a"); done <<< "${c#*$'\n'}"
      if [ "$runner" = vitest ] && [ "$VDELTA" = true ]; then
        prefix=()
        for a in "${argv[@]}"; do [ "$a" = vitest ] && break; prefix+=("$a"); done
        VDELTA_PREFIX=(${prefix[@]+"${prefix[@]}"})
        argv=(${prefix[@]+"${prefix[@]}"} vdelta run --report json -- "${argv[@]}")
        # vdelta run 経路を実行した事実を記録する(rc とは独立。
        # red phase の失敗は期待値であり vdelta run 未実行を意味しない)。
        VDELTA_TESTCMD_RAN=true
      fi
      "${argv[@]}" >/dev/null 2>&1 || rc=1
    done
  fi
  return $rc
}

# 退避済み impl を $TMPDIR_IMPL から相対パス保持で書き戻す(cp -p で mode も戻す)。
# 本文と EXIT trap の両方から呼ぶ。配列展開は set -u のため必ず件数 guard 下で行う。
restore_saved() {
  local f
  if [ "$UNTRACKED_SAVED" = true ] && [ "${#UNTRACKED_IMPLS[@]}" -gt 0 ]; then
    for f in "${UNTRACKED_IMPLS[@]}"; do
      if [ -f "$TMPDIR_IMPL/$f" ]; then mkdir -p "$(dirname "$f")"; cp -p "$TMPDIR_IMPL/$f" "$f"; fi
    done
  fi
  if [ "$TRACKED_SAVED" = true ] && [ "${#TRACKED_IMPLS[@]}" -gt 0 ]; then
    for f in "${TRACKED_IMPLS[@]}"; do
      if [ -f "$TMPDIR_IMPL/$f" ]; then mkdir -p "$(dirname "$f")"; cp -p "$TMPDIR_IMPL/$f" "$f"; fi
    done
  fi
}

# tracked impl 1 件を HEAD の内容と実行ビットに戻す。git checkout HEAD -- は index も書き換える(index.lock を
# 取る)ので使わない — テストを sandbox 内で回すこのスクリプトからは、checkout の .git が sandbox から書けない
# 場合に .git/worktrees/*/index.lock が書けない。blob の読み出し(filter 適用済み)と ls-tree は index に触れない。通常ファイル以外(symlink 等)は失敗扱い。
write_head_blob() {
  local f="$1" mode
  mode="$(git ls-tree HEAD -- "$f" 2>/dev/null | awk '{print $1}')"
  case "$mode" in
    100644|100755) : ;;
    *) return 1 ;;
  esac
  git cat-file --filters "HEAD:$f" > "$f" 2>/dev/null || return 1
  if [ "$mode" = 100755 ]; then chmod +x "$f"; else chmod -x "$f"; fi
}

# --- cleanup / restore(二段構え: 各ペアの終端で本文から呼び、途中終了時は EXIT trap が現ペア分を戻す) ---
restore_impl() {
  restore_saved
  UNTRACKED_SAVED=false
  TRACKED_SAVED=false
  if [ -n "$TMPDIR_IMPL" ]; then rm -rf "$TMPDIR_IMPL"; TMPDIR_IMPL=""; fi
}
trap restore_impl EXIT

# 1 ペアを判定する。PAIR_JSON に index 抜きの JSON 本体を残し、判定完了なら 0・入力/分離エラーなら 2 を返す。
# 退避した impl の復元は呼び出し側の restore_impl が担う(return 経路を問わず必ず呼ぶ)。
verify_pair() {
  local test_csv="$1" impl_csv="$2" t i f
  TESTS=(); IMPLS=(); RUN_CMDS=()
  UNTRACKED_IMPLS=(); TRACKED_IMPLS=(); UNCHANGED_IMPLS=()
  UNTRACKED_SAVED=false; TRACKED_SAVED=false
  VDELTA_TESTCMD_RAN=false; VDELTA_PREFIX=()
  PAIR_JSON=""

  IFS=',' read -r -a TESTS <<< "$test_csv"
  IFS=',' read -r -a IMPLS <<< "$impl_csv"

  # 層2: test_files ごとのランナーを repo の既存設定から判定する(detect-test-runner.sh)。ランナー未検出の
  # ファイル(playwright repo の *.spec.* を含む)が 1 件でもあれば拒否する
  local det unknown c
  if ! det="$(bash "$DETECT" "$PWD" "${TESTS[@]}" 2>/dev/null)" || ! jq -e '.files and .commands' >/dev/null 2>&1 <<< "$det"; then
    PAIR_JSON="\"red\":false,\"green\":false,\"reason\":\"test runner detection failed\""; return 2
  fi
  if jq -e 'any(.files[]; .runner == null)' >/dev/null <<< "$det"; then
    unknown="$(jq -r 'first(.files[] | select(.runner == null) | .file)' <<< "$det")"
    PAIR_JSON="\"red\":false,\"green\":false,\"reason\":\"non-test file declared (ランナー未検出): $unknown\""; return 2
  fi
  # 1 行 1 要素の出力を here-string で読む(process substitution は sandbox で /dev/fd が塞がれる)
  while IFS= read -r c; do
    [ -n "$c" ] && RUN_CMDS+=("$(jq -r '.runner, .argv[]' <<< "$c")")
  done <<< "$(jq -c '.commands[]' <<< "$det")"
  # 層4: test と impl の混在(同一ファイル)は曖昧 → 昇格しない
  for t in "${TESTS[@]}"; do
    for i in "${IMPLS[@]}"; do
      [ "$t" = "$i" ] && { PAIR_JSON="\"red\":false,\"green\":false,\"reason\":\"file is both test and impl: $t\""; return 2; }
    done
  done

  TMPDIR_IMPL="$(mktemp -d)"
  for f in "${IMPLS[@]}"; do
    # cat-file -e は HEAD に無いと rc 128 + stderr メッセージ → 抑止して成否だけ使う
    if git cat-file -e "HEAD:$f" >/dev/null 2>&1; then
      if git diff --quiet HEAD -- "$f"; then
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
    PAIR_JSON="\"red\":false,\"green\":false,\"reason\":\"no impl changed vs HEAD: $impl_csv\""; return 2
  fi

  # 1. untracked impl: cp -p 退避 → rm
  if [ "${#UNTRACKED_IMPLS[@]}" -gt 0 ]; then
    for f in "${UNTRACKED_IMPLS[@]}"; do
      mkdir -p "$TMPDIR_IMPL/$(dirname "$f")"
      cp -p "$f" "$TMPDIR_IMPL/$f"
      rm -f "$f"
    done
    UNTRACKED_SAVED=true
  fi

  # 2. 変更あり tracked impl: 全件 cp -p 退避 → TRACKED_SAVED=true(以降の失敗は restore_impl が戻す) → HEAD の内容で base 化
  if [ "${#TRACKED_IMPLS[@]}" -gt 0 ]; then
    for f in "${TRACKED_IMPLS[@]}"; do
      mkdir -p "$TMPDIR_IMPL/$(dirname "$f")"
      cp -p "$f" "$TMPDIR_IMPL/$f"
    done
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

  # 復元(本文側。EXIT trap / restore_impl も呼ばれるがフラグを落として二重復元を防ぐ)
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

  # headdiff: vdelta run 経路が走らなかったペア(VDELTA_TESTCMD_RAN=false)でのみ、
  # test_files を HEAD 基準で三分類する(拡張子非依存の fallback 信号。判定には使わない)。
  local headdiff_json="" hd_new=0 hd_mod=0 hd_unch=0
  if [ "$VDELTA_TESTCMD_RAN" = false ] && git rev-parse --verify -q HEAD >/dev/null 2>&1; then
    for t in "${TESTS[@]}"; do
      if git cat-file -e "HEAD:$t" >/dev/null 2>&1; then
        if git diff --quiet HEAD -- "$t"; then hd_unch=$((hd_unch+1)); else hd_mod=$((hd_mod+1)); fi
      else
        hd_new=$((hd_new+1))
      fi
    done
    headdiff_json=",\"headdiff\":{\"new\":$hd_new,\"modified\":$hd_mod,\"unchanged\":$hd_unch,\"total\":${#TESTS[@]}}"
  fi

  PAIR_JSON="\"red\":$red,\"green\":$green,\"reason\":\"ok\",\"testcmd_ran\":$VDELTA_TESTCMD_RAN$headdiff_json"

  # post-green verdict(fail-open): red/green 判定が確定した後にのみ走る。
  # 非ゼロ exit・空出力・不正 JSON・jq 不在のいずれでも PAIR_JSON をそのまま返す。
  # 当該ペアで vdelta run 経路が実行されていない場合(bats-only AC・vitest 以外のランナー等)は
  # RunStore に run pair が存在しないため起動しない(VDELTA_TESTCMD_RAN guard)。
  if [ "$VDELTA_TESTCMD_RAN" = true ] && command -v jq >/dev/null 2>&1; then
    local hook_json hook_rc merged
    hook_json="$(${VDELTA_PREFIX[@]+"${VDELTA_PREFIX[@]}"} vdelta compare --report json 2>/dev/null)"
    hook_rc=$?
    if [ "$hook_rc" -eq 0 ] && [ -n "$hook_json" ] && jq -c . >/dev/null 2>&1 <<< "$hook_json"; then
      merged="$(jq -c --argjson v "$hook_json" '. + {verdict: $v}' <<< "{$PAIR_JSON}")"
      PAIR_JSON="${merged#\{}"
      PAIR_JSON="${PAIR_JSON%\}}"
    fi
  fi
  return 0
}

RESULTS=()
COMPLETED=0
INDEX=0
while [ "$#" -ge 2 ]; do
  if verify_pair "$1" "$2"; then COMPLETED=$((COMPLETED+1)); fi
  restore_impl
  RESULTS+=("{\"index\":$INDEX,$PAIR_JSON}")
  INDEX=$((INDEX+1))
  shift 2
done

OUT='{"results":['
for ((k = 0; k < ${#RESULTS[@]}; k++)); do
  [ "$k" -gt 0 ] && OUT="$OUT,"
  OUT="$OUT${RESULTS[$k]}"
done
echo "$OUT]}"
[ "$COMPLETED" -gt 0 ] && exit 0
exit 2
