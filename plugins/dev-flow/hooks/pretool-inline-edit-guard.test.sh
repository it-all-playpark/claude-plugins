#!/usr/bin/env bash
# Test suite for pretool-inline-edit-guard.sh
#
# Usage: bash pretool-inline-edit-guard.test.sh
#
# Exit 0 on all pass, non-zero otherwise.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="${SCRIPT_DIR}/pretool-inline-edit-guard.sh"

if [[ ! -x ${HOOK} ]]; then
  echo "FAIL: hook not executable: ${HOOK}" >&2
  exit 1
fi

WORKDIR=$(mktemp -d "${TMPDIR:-/tmp}/pretool-inline-edit-guard-test.XXXXXX")
cleanup() {
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

mkdir -p "${WORKDIR}/.claude/workflows"
mkdir -p "${WORKDIR}/_lib"

MARKED_FILE="${WORKDIR}/.claude/workflows/wf.js"
cat >"$MARKED_FILE" <<'EOF'
// ==== BEGIN inline: _lib/foo.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====
function foo() {
  return 1;
}
// ==== END inline: _lib/foo.mjs ====
EOF

PLAIN_FILE="${WORKDIR}/.claude/workflows/plain.js"
cat >"$PLAIN_FILE" <<'EOF'
function plain() {
  return 1;
}
EOF

CANONICAL_FILE="${WORKDIR}/_lib/foo.mjs"
cat >"$CANONICAL_FILE" <<'EOF'
function foo() {
  return 1;
}
EOF

README_FILE="${WORKDIR}/.claude/workflows/README.md"
cat >"$README_FILE" <<'EOF'
# README
This mentions BEGIN inline: _lib/foo.mjs inside a sentence, not a comment.
EOF

STRING_LITERAL_FILE="${WORKDIR}/.claude/workflows/literal.js"
cat >"$STRING_LITERAL_FILE" <<'EOF'
const doc = "see // ==== BEGIN inline: _lib/foo.mjs ==== for details";
function literal() {
  return doc;
}
EOF

# 生成区間（BEGIN/END）と手書きコード（前後）が混在するファイル。
# issue #138 の指摘: 手書き区間への Edit まで一律 deny してはいけない。
MIXED_FILE="${WORKDIR}/.claude/workflows/mixed.js"
cat >"$MIXED_FILE" <<'EOF'
// hand-written header comment
function handWrittenBefore() {
  return "before";
}

// ==== BEGIN inline: _lib/foo.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====
function foo() {
  return 1;
}
// ==== END inline: _lib/foo.mjs ====

function handWrittenAfter() {
  return "after";
}
EOF

NEW_FILE_PATH="${WORKDIR}/.claude/workflows/new.js"

PASS=0
FAIL=0
FAILURES=()

# run_case <name> <tool_name> <file_path> <content> <expected: deny|pass>
run_case() {
  local name="$1"
  local tool_name="$2"
  local file_path="$3"
  local content="$4"
  local expected="$5"

  local input
  input=$(jq -n --arg tool "$tool_name" --arg fp "$file_path" --arg content "$content" \
    '{tool_name:$tool, tool_input:{file_path:$fp, content:$content}}')

  local output
  output=$(echo "$input" | bash "$HOOK" 2>&1 || true)

  local decision="pass"
  if [[ -n $output ]]; then
    decision=$(echo "$output" | jq -r '.hookSpecificOutput.permissionDecision // "pass"' 2>/dev/null || echo "pass")
  fi

  if [[ $decision == "$expected" ]]; then
    PASS=$((PASS + 1))
    printf "  \033[32mPASS\033[0m %s\n" "$name"
  else
    FAIL=$((FAIL + 1))
    FAILURES+=("$name: expected=$expected got=$decision file=$file_path")
    printf "  \033[31mFAIL\033[0m %s (expected=%s, got=%s)\n" "$name" "$expected" "$decision"
  fi
}

# run_edit_case <name> <file_path> <old_string> <new_string> <expected: deny|pass>
# Edit tool の実スキーマ（old_string/new_string）で hook を呼ぶ。
run_edit_case() {
  local name="$1"
  local file_path="$2"
  local old_string="$3"
  local new_string="$4"
  local expected="$5"

  local input
  input=$(jq -n --arg fp "$file_path" --arg old "$old_string" --arg new "$new_string" \
    '{tool_name:"Edit", tool_input:{file_path:$fp, old_string:$old, new_string:$new}}')

  local output
  output=$(echo "$input" | bash "$HOOK" 2>&1 || true)

  local decision="pass"
  if [[ -n $output ]]; then
    decision=$(echo "$output" | jq -r '.hookSpecificOutput.permissionDecision // "pass"' 2>/dev/null || echo "pass")
  fi

  if [[ $decision == "$expected" ]]; then
    PASS=$((PASS + 1))
    printf "  \033[32mPASS\033[0m %s\n" "$name"
  else
    FAIL=$((FAIL + 1))
    FAILURES+=("$name: expected=$expected got=$decision file=$file_path")
    printf "  \033[31mFAIL\033[0m %s (expected=%s, got=%s)\n" "$name" "$expected" "$decision"
  fi
}

# run_bash_case <name> <command> <expected>
run_bash_case() {
  local name="$1"
  local cmd="$2"
  local expected="$3"

  local input
  input=$(jq -n --arg cmd "$cmd" '{tool_name:"Bash", tool_input:{command:$cmd}}')

  local output
  output=$(echo "$input" | bash "$HOOK" 2>&1 || true)

  local decision="pass"
  if [[ -n $output ]]; then
    decision=$(echo "$output" | jq -r '.hookSpecificOutput.permissionDecision // "pass"' 2>/dev/null || echo "pass")
  fi

  if [[ $decision == "$expected" ]]; then
    PASS=$((PASS + 1))
    printf "  \033[32mPASS\033[0m %s\n" "$name"
  else
    FAIL=$((FAIL + 1))
    FAILURES+=("$name: expected=$expected got=$decision cmd=$cmd")
    printf "  \033[31mFAIL\033[0m %s (expected=%s, got=%s)\n" "$name" "$expected" "$decision"
  fi
}

echo "=== pretool-inline-edit-guard tests ==="

echo "[Positive cases — should deny]"
run_case "Write on marker-containing workflows/*.js" "Write" "$MARKED_FILE" "$(cat "$MARKED_FILE")" "deny"
run_case "Write new workflows/*.js with marker in content" "Write" "$NEW_FILE_PATH" "$(cat "$MARKED_FILE")" "deny"
run_edit_case "Edit whose old_string is inside the generated region" "$MIXED_FILE" \
  $'function foo() {\n  return 1;\n}' $'function foo() {\n  return 2;\n}' "deny"
run_edit_case "Edit whose old_string is exactly a marker line" "$MIXED_FILE" \
  '// ==== END inline: _lib/foo.mjs ====' '' "deny"
run_edit_case "Edit whose new_string injects a marker line into hand-written code" "$MIXED_FILE" \
  $'function handWrittenBefore() {\n  return "before";\n}' \
  $'// ==== BEGIN inline: _lib/evil.mjs ====\nfunction handWrittenBefore() {\n  return "evil";\n}' "deny"
# マーカー行の後ろに pipe buffer（64KB）を超える内容が続いても、grep の早期終了で判定が偽にならない。
# 約 84KB に収める: jq --arg に渡すので Linux の 1 引数上限（MAX_ARG_STRLEN 128KB）を超えると E2BIG で落ちる
LARGE_TAIL=$(awk 'BEGIN { for (i = 0; i < 3000; i++) printf "const pad%d = 0; // filler\n", i }')
run_case "Write whose content starts with a marker line followed by >64KB" "Write" "$NEW_FILE_PATH" \
  $'// ==== BEGIN inline: _lib/evil.mjs ====\n'"$LARGE_TAIL" "deny"
run_edit_case "Edit whose new_string starts with a marker line followed by >64KB" "$MIXED_FILE" \
  $'function handWrittenBefore() {\n  return "before";\n}' \
  $'// ==== BEGIN inline: _lib/evil.mjs ====\n'"$LARGE_TAIL" "deny"

echo "[Negative cases — should pass through]"
run_case "Edit on marker-less workflows/*.js" "Edit" "$PLAIN_FILE" "" "pass"
run_case "Edit on canonical _lib source" "Edit" "$CANONICAL_FILE" "" "pass"
run_case "Write on non-.js workflows README" "Write" "$README_FILE" "# updated" "pass"
run_bash_case "sync-inlines.mjs --write via Bash is not blocked" "node tools/sync-inlines.mjs --write" "pass"
run_case "Edit on .js with non-header-comment 'BEGIN inline:' string literal" "Edit" "$STRING_LITERAL_FILE" "" "pass"
run_edit_case "Edit whose old_string is hand-written code before the generated region" "$MIXED_FILE" \
  $'function handWrittenBefore() {\n  return "before";\n}' \
  $'function handWrittenBefore() {\n  return "before-updated";\n}' "pass"
run_edit_case "Edit whose old_string is hand-written code after the generated region" "$MIXED_FILE" \
  $'function handWrittenAfter() {\n  return "after";\n}' \
  $'function handWrittenAfter() {\n  return "after-updated";\n}' "pass"

echo ""
echo "=== Results: ${PASS} passed, ${FAIL} failed ==="
if ((FAIL > 0)); then
  printf '\n'
  printf 'Failures:\n'
  for f in "${FAILURES[@]}"; do
    printf '  - %s\n' "$f"
  done
  exit 1
fi
exit 0
