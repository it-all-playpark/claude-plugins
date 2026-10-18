#!/usr/bin/env bash
# Test suite for pretool-context-guard.sh
#
# Usage: bash pretool-context-guard.test.sh
#
# Exit 0 on all pass, non-zero otherwise.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="${SCRIPT_DIR}/pretool-context-guard.sh"

if [[ ! -x ${HOOK} ]]; then
  echo "FAIL: hook not executable: ${HOOK}" >&2
  exit 1
fi

# --- フィクスチャ ---
FIXTURE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/context-guard-test.XXXXXX")
cleanup() { rm -rf "$FIXTURE_DIR"; }
trap cleanup EXIT

# 小さい JSON (< 20KB)
printf '{"a":1,"b":2}\n' >"${FIXTURE_DIR}/small.json"
# 大きい JSON (> 20KB)
{
  printf '{"items":['
  for i in $(seq 1 2000); do printf '{"id":%d,"name":"item-%d"},' "$i" "$i"; done
  printf '{"id":0}]}\n'
} >"${FIXTURE_DIR}/big.json"
# 大きい YAML (> 20KB)
for i in $(seq 1 2000); do printf 'key_%d: value-%d\n' "$i" "$i"; done >"${FIXTURE_DIR}/big.yaml"
# 大きい CSV (> 20KB)
for i in $(seq 1 2000); do printf '%d,name-%d,value-%d\n' "$i" "$i" "$i"; done >"${FIXTURE_DIR}/big.csv"
# 小さい Markdown
printf '# hello\n' >"${FIXTURE_DIR}/small.md"
# 巨大 Markdown (> 100KB)
for i in $(seq 1 4000); do printf 'line %d: the quick brown fox jumps over the lazy dog\n' "$i"; done >"${FIXTURE_DIR}/huge.md"
# 中くらいの Markdown (20KB < size < 100KB) — plain は 100KB まで通す
for i in $(seq 1 600); do printf 'line %d: the quick brown fox jumps over the lazy dog\n' "$i"; done >"${FIXTURE_DIR}/medium.md"
# バイナリ文書（中身は問わない、拡張子で判定する）
printf '%%PDF-1.4 dummy\n' >"${FIXTURE_DIR}/doc.pdf"
# 巨大な画像 (> 100KB)（中身は問わない、拡張子で判定する）。大文字拡張子は別名にする
# （case-insensitive な FS で huge.png と huge.PNG が同じファイルになるため）
for name in huge.png huge.jpg huge.jpeg huge.gif huge.webp upper.PNG upper.JPEG; do
  head -c 110000 /dev/zero >"${FIXTURE_DIR}/${name}"
done

PASS=0
FAIL=0
FAILURES=()

# run_bash <name> <command> <expected: deny|pass>
run_bash() {
  local name="$1" cmd="$2" expected="$3"
  local input output decision
  input=$(jq -n --arg cmd "$cmd" --arg cwd "$FIXTURE_DIR" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')
  output=$(echo "$input" | bash "$HOOK" 2>&1 || true)
  decision="pass"
  if [[ -n $output ]]; then
    decision=$(echo "$output" | jq -r '.hookSpecificOutput.permissionDecision // "pass"' 2>/dev/null || echo "pass")
  fi
  assert "$name" "$expected" "$decision" "$cmd"
}

# run_read <name> <file> <limit: -|N> <expected: deny|pass>
run_read() {
  local name="$1" file="$2" limit="$3" expected="$4"
  local input output decision
  if [[ $limit == "-" ]]; then
    input=$(jq -n --arg f "$file" --arg cwd "$FIXTURE_DIR" \
      '{tool_name:"Read", cwd:$cwd, tool_input:{file_path:$f}}')
  else
    input=$(jq -n --arg f "$file" --arg cwd "$FIXTURE_DIR" --argjson l "$limit" \
      '{tool_name:"Read", cwd:$cwd, tool_input:{file_path:$f, limit:$l}}')
  fi
  output=$(echo "$input" | bash "$HOOK" 2>&1 || true)
  decision="pass"
  if [[ -n $output ]]; then
    decision=$(echo "$output" | jq -r '.hookSpecificOutput.permissionDecision // "pass"' 2>/dev/null || echo "pass")
  fi
  assert "$name" "$expected" "$decision" "Read $file"
}

assert() {
  local name="$1" expected="$2" got="$3" detail="$4"
  if [[ $got == "$expected" ]]; then
    PASS=$((PASS + 1))
    printf "  \033[32mPASS\033[0m %s\n" "$name"
  else
    FAIL=$((FAIL + 1))
    FAILURES+=("$name: expected=$expected got=$got detail=$detail")
    printf "  \033[31mFAIL\033[0m %s (expected=%s, got=%s)\n" "$name" "$expected" "$got"
  fi
}

echo "=== pretool-context-guard tests ==="

echo "[Positive cases — should deny]"
run_bash "cat 大きい JSON" "cat ${FIXTURE_DIR}/big.json" "deny"
run_bash "cat 大きい YAML" "cat ${FIXTURE_DIR}/big.yaml" "deny"
run_bash "cat 大きい CSV" "cat ${FIXTURE_DIR}/big.csv" "deny"
run_bash "cat 巨大 Markdown" "cat ${FIXTURE_DIR}/huge.md" "deny"
run_bash "cat PDF" "cat ${FIXTURE_DIR}/doc.pdf" "deny"
run_bash "rg を PDF に向ける" "rg pattern ${FIXTURE_DIR}/doc.pdf" "deny"
run_bash "grep を PDF に向ける" "grep pattern ${FIXTURE_DIR}/doc.pdf" "deny"
run_bash "パイプ後段の cat も対象" "echo start && cat ${FIXTURE_DIR}/big.json" "deny"
run_bash "cat 巨大な画像" "cat ${FIXTURE_DIR}/huge.png" "deny"
run_read "Read 大きい JSON (limit なし)" "${FIXTURE_DIR}/big.json" "-" "deny"
run_read "Read 巨大 Markdown (limit なし)" "${FIXTURE_DIR}/huge.md" "-" "deny"

echo "[Negative cases — should pass]"
run_bash "cat 小さい JSON" "cat ${FIXTURE_DIR}/small.json" "pass"
run_bash "cat 小さい Markdown" "cat ${FIXTURE_DIR}/small.md" "pass"
run_bash "cat 中サイズ Markdown (100KB 未満)" "cat ${FIXTURE_DIR}/medium.md" "pass"
run_bash "jq に渡す cat" "cat ${FIXTURE_DIR}/big.json | jq '.items[0]'" "pass"
run_bash "リダイレクトする cat" "cat ${FIXTURE_DIR}/big.json > /dev/null" "pass"
run_bash "head で絞る" "head -20 ${FIXTURE_DIR}/big.json" "pass"
run_bash "jq で直接絞る" "jq '.items[0]' ${FIXTURE_DIR}/big.json" "pass"
run_bash "rg を通常ファイルに向ける" "rg pattern ${FIXTURE_DIR}/huge.md" "pass"
run_bash "存在しないファイル" "cat ${FIXTURE_DIR}/nonexistent.json" "pass"
run_bash "変数展開されたパス" 'cat "$SOME_VAR/big.json"' "pass"
run_bash "cat という文字列を含む別コマンド" "echo cat ${FIXTURE_DIR}/big.json" "pass"
run_bash "git 操作" "git status --short" "pass"
run_read "Read 大きい JSON (limit あり)" "${FIXTURE_DIR}/big.json" "50" "pass"
run_read "Read 小さい JSON" "${FIXTURE_DIR}/small.json" "-" "pass"
run_read "Read 中サイズ Markdown" "${FIXTURE_DIR}/medium.md" "-" "pass"
for name in huge.png huge.jpg huge.jpeg huge.gif huge.webp upper.PNG upper.JPEG; do
  run_read "Read 巨大な画像 ${name} (limit なし)" "${FIXTURE_DIR}/${name}" "-" "pass"
done

echo
echo "=== Results: ${PASS} passed, ${FAIL} failed ==="
if ((FAIL > 0)); then
  printf '\nFailures:\n'
  for f in "${FAILURES[@]}"; do printf '  - %s\n' "$f"; done
  exit 1
fi
