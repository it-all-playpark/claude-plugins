#!/usr/bin/env bash
# Test suite for stop-devflow-telemetry.sh
#
# Usage: bash stop-devflow-telemetry.test.sh
#
# Exit 0 on all pass, non-zero otherwise.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="${SCRIPT_DIR}/stop-devflow-telemetry.sh"
REAL_JOURNAL="${SCRIPT_DIR}/../../playpark-core/journal/scripts/journal.sh"

PASS=0
FAIL=0
FAILURES=()

pass() {
  local name="$1"
  PASS=$((PASS + 1))
  printf "  \033[32mPASS\033[0m %s\n" "$name"
}
fail() {
  local name="$1" msg="$2"
  FAIL=$((FAIL + 1))
  FAILURES+=("$name: $msg")
  printf "  \033[31mFAIL\033[0m %s (%s)\n" "$name" "$msg"
}

# --------------------------------------------------------------------------
# Setup / teardown helpers
# --------------------------------------------------------------------------

make_tmpdir() {
  mktemp -d "${TMPDIR:-/tmp}/stop-devflow-test.XXXXXX"
}

# dev-flow / pr-iterate が書く telemetry キーの例（キー一覧は dev-flow/references/telemetry.md）
KEPT_TELEMETRY='{
  "plugin_commit": "1ef2e0ab6254",
  "plugin_version": "0.3.0",
  "shape": "standard",
  "route": "full",
  "duration_seconds": 840,
  "phase_durations": {"implement": 120, "validate": 95},
  "merge_tier": "REVIEW",
  "iterate_status": "lgtm",
  "eval_verdict": "pass",
  "eval_model_config": "opus",
  "impl_model_config": "opus",
  "review_model_config": "opus"
}'

# Build a minimal handoff JSON and write it to a file.
# Usage: make_handoff <tmpdir> <filename> [extra_jq_filter]
make_handoff() {
  local dir="$1" fname="$2" extra="${3:-.}"
  jq -n --argjson tel "$KEPT_TELEMETRY" '{
    skill: "dev-flow",
    outcome: "success",
    issue: 203,
    journal_sh: "STUB_PLACEHOLDER",
    telemetry: $tel
  }' | jq "$extra" >"${dir}/${fname}"
}

# Build a handoff whose journal_sh points at <stub_path>, then apply a jq filter.
# Usage: make_base_handoff <outfile> <stub_path> <jq_filter>
make_base_handoff() {
  local outfile="$1" stub="$2" extra_filter="$3"
  jq -n --arg js "$stub" --argjson tel "$KEPT_TELEMETRY" '{
    skill: "dev-flow",
    outcome: "success",
    issue: 390,
    journal_sh: $js,
    telemetry: $tel
  }' | jq "$extra_filter" >"$outfile"
}

# --------------------------------------------------------------------------
# Test 1: hook not found / not executable → skip (guard)
# --------------------------------------------------------------------------
echo "=== stop-devflow-telemetry tests ==="

if [[ ! -f ${HOOK} ]]; then
  fail "hook_exists" "hook file not found: ${HOOK}"
fi

# If hook not found, remaining tests will fail in unhelpful ways. Bail early.
if ((FAIL > 0)); then
  echo ""
  echo "=== Results: ${PASS} passed, ${FAIL} failed ==="
  for f in "${FAILURES[@]}"; do printf '  - %s\n' "$f"; done
  exit 1
fi

if [[ ! -x ${HOOK} ]]; then
  fail "hook_executable" "hook not executable: ${HOOK}"
  echo ""
  echo "=== Results: ${PASS} passed, ${FAIL} failed ==="
  for f in "${FAILURES[@]}"; do printf '  - %s\n' "$f"; done
  exit 1
fi

# --------------------------------------------------------------------------
# Helper: run the hook with given env vars and stdin
# Returns hook exit code via $RUN_EXIT; hook stdout captured (should be empty)
# --------------------------------------------------------------------------
RUN_EXIT=0
RUN_OUT=""
run_hook() {
  local envargs=("$@")
  RUN_EXIT=0
  RUN_OUT=""
  RUN_OUT=$(env "${envargs[@]}" bash "$HOOK" </dev/null 2>&1) || RUN_EXIT=$?
}

# --------------------------------------------------------------------------
# Stub journal.sh builder
# Creates a stub script that records its arguments to a capture file
# --------------------------------------------------------------------------
make_stub_journal() {
  local stub_path="$1" capture_file="$2" exit_code="${3:-0}"
  cat >"$stub_path" <<STUB_EOF
#!/usr/bin/env bash
# Stub journal.sh for testing
echo "\$*" >> "${capture_file}"
exit ${exit_code}
STUB_EOF
  chmod +x "$stub_path"
}

# --telemetry-json の値（stub は argv を空白連結で記録する。telemetry JSON は compact で最後の引数）
telemetry_arg_of() {
  printf '%s' "$1" | sed -n 's/.*--telemetry-json //p'
}

# --------------------------------------------------------------------------
# Test 2: pending dir not present → exit 0
# --------------------------------------------------------------------------
{
  tmpd=$(make_tmpdir)
  run_hook "CLAUDE_JOURNAL_DIR=${tmpd}" "HOME=${tmpd}"
  if [[ $RUN_EXIT -eq 0 ]]; then
    pass "pending_dir_absent_exits_0"
  else
    fail "pending_dir_absent_exits_0" "expected exit 0, got ${RUN_EXIT}"
  fi
  rm -rf "$tmpd"
}

# --------------------------------------------------------------------------
# Test 3: escape hatch CLAUDE_DEVFLOW_TELEMETRY_HOOK=0 → exit 0
# --------------------------------------------------------------------------
{
  tmpd=$(make_tmpdir)
  mkdir -p "${tmpd}/journal/pending"
  make_handoff "${tmpd}/journal/pending" "handoff.json"
  run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}" "CLAUDE_DEVFLOW_TELEMETRY_HOOK=0"
  if [[ $RUN_EXIT -eq 0 ]]; then
    pass "escape_hatch_exits_0"
  else
    fail "escape_hatch_exits_0" "expected exit 0 with escape hatch, got ${RUN_EXIT}"
  fi
  if [[ -f "${tmpd}/journal/pending/handoff.json" ]]; then
    pass "escape_hatch_file_untouched"
  else
    fail "escape_hatch_file_untouched" "file should not be processed when escape hatch is set"
  fi
  rm -rf "$tmpd"
}

# --------------------------------------------------------------------------
# Test 4: happy path — 残す 12 キーの telemetry が --telemetry-json 1 本でそのまま渡り、
#         telemetry 用の個別 flag は出ない。pending は削除される
# --------------------------------------------------------------------------
{
  tmpd=$(make_tmpdir)
  mkdir -p "${tmpd}/journal/pending"
  capture="${tmpd}/capture.txt"
  stub="${tmpd}/journal.sh"
  make_stub_journal "$stub" "$capture" 0

  make_base_handoff "${tmpd}/journal/pending/handoff.json" "$stub" \
    '.issue = 203 | .repo = "acme/skills" | .pr_number = 123'

  run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"

  if [[ $RUN_EXIT -eq 0 ]]; then
    pass "happy_path_exits_0"
  else
    fail "happy_path_exits_0" "expected exit 0, got ${RUN_EXIT}. output: ${RUN_OUT}"
  fi

  captured=$(cat "$capture" 2>/dev/null || echo "")
  expected_prefix='log dev-flow success --issue 203 --repo acme/skills --pr-number 123 --telemetry-json '
  if [[ $captured == "$expected_prefix"* ]]; then
    pass "happy_path_args_are_base_fields_plus_telemetry_json"
  else
    fail "happy_path_args_are_base_fields_plus_telemetry_json" "expected prefix [${expected_prefix}] got: [${captured}]"
  fi

  if telemetry_arg_of "$captured" | jq -e --argjson want "$KEPT_TELEMETRY" '. == $want' >/dev/null 2>&1; then
    pass "happy_path_telemetry_json_is_all_12_keys"
  else
    fail "happy_path_telemetry_json_is_all_12_keys" "telemetry JSON mismatch. got: $(telemetry_arg_of "$captured")"
  fi

  if [[ ! -f "${tmpd}/journal/pending/handoff.json" ]]; then
    pass "happy_path_pending_file_removed"
  else
    fail "happy_path_pending_file_removed" "pending file should be removed after successful processing"
  fi

  rm -rf "$tmpd"
}

# --------------------------------------------------------------------------
# Test 5: failure path — stub exits 1 → file restored, log written
# --------------------------------------------------------------------------
{
  tmpd=$(make_tmpdir)
  mkdir -p "${tmpd}/journal/pending"
  capture="${tmpd}/capture.txt"
  stub="${tmpd}/journal.sh"
  make_stub_journal "$stub" "$capture" 1

  make_base_handoff "${tmpd}/journal/pending/handoff.json" "$stub" '.'

  run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"

  if [[ $RUN_EXIT -eq 0 ]]; then
    pass "failure_path_exits_0"
  else
    fail "failure_path_exits_0" "hook must always exit 0, got ${RUN_EXIT}"
  fi
  if [[ -f "${tmpd}/journal/pending/handoff.json" ]]; then
    pass "failure_path_file_restored"
  else
    fail "failure_path_file_restored" "pending file should be restored after journal.sh failure"
  fi
  logfile="${tmpd}/.claude/logs/stop-devflow-telemetry.log"
  if grep -q "journal-failed" "$logfile" 2>/dev/null; then
    pass "failure_path_log_written"
  else
    fail "failure_path_log_written" "journal-failed not logged at ${logfile}"
  fi

  rm -rf "$tmpd"
}

# --------------------------------------------------------------------------
# Test 6: malformed JSON → moved to pending/malformed/, error logged, exit 0
# --------------------------------------------------------------------------
{
  tmpd=$(make_tmpdir)
  mkdir -p "${tmpd}/journal/pending"

  echo "{ not valid json }" >"${tmpd}/journal/pending/bad.json"

  run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"

  if [[ $RUN_EXIT -eq 0 ]]; then
    pass "malformed_exits_0"
  else
    fail "malformed_exits_0" "hook must always exit 0, got ${RUN_EXIT}"
  fi
  if [[ ! -f "${tmpd}/journal/pending/bad.json" ]] && [[ -f "${tmpd}/journal/pending/malformed/bad.json" ]]; then
    pass "malformed_moved_to_malformed_dir"
  else
    fail "malformed_moved_to_malformed_dir" "malformed file not moved to pending/malformed/"
  fi

  rm -rf "$tmpd"
}

# --------------------------------------------------------------------------
# Test 7: .telemetry が非 object（文字列）→ jq エラーで malformed 経路へ落ちる
# --------------------------------------------------------------------------
{
  tmpd=$(make_tmpdir)
  mkdir -p "${tmpd}/journal/pending"
  capture="${tmpd}/capture.txt"
  stub="${tmpd}/journal.sh"
  make_stub_journal "$stub" "$capture" 0

  make_base_handoff "${tmpd}/journal/pending/pi.json" "$stub" '.telemetry = "oops"'

  run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"

  if [[ $RUN_EXIT -eq 0 && ! -f $capture ]]; then
    pass "non_object_telemetry_not_forwarded"
  else
    fail "non_object_telemetry_not_forwarded" "exit=${RUN_EXIT}, stub must not be called. got: $(cat "$capture" 2>/dev/null)"
  fi
  if [[ -f "${tmpd}/journal/pending/malformed/pi.json" ]] &&
    grep -q "malformed-json" "${tmpd}/.claude/logs/stop-devflow-telemetry.log" 2>/dev/null; then
    pass "non_object_telemetry_moved_to_malformed"
  else
    fail "non_object_telemetry_moved_to_malformed" "expected pending/malformed/pi.json and malformed-json log"
  fi

  rm -rf "$tmpd"
}

# --------------------------------------------------------------------------
# Test 8: skill / outcome missing → malformed treatment (producer 契約違反)
# --------------------------------------------------------------------------
for missing in skill outcome; do
  tmpd=$(make_tmpdir)
  mkdir -p "${tmpd}/journal/pending"

  jq -n '{skill: "dev-flow", outcome: "success", issue: 1, journal_sh: "/bin/true", telemetry: {merge_tier: "REVIEW"}}' |
    jq --arg k "$missing" 'del(.[$k])' >"${tmpd}/journal/pending/no${missing}.json"

  run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"

  if [[ $RUN_EXIT -eq 0 && -f "${tmpd}/journal/pending/malformed/no${missing}.json" ]]; then
    pass "missing_${missing}_moved_to_malformed"
  else
    fail "missing_${missing}_moved_to_malformed" "exit=${RUN_EXIT}; handoff missing ${missing} must be moved to malformed/"
  fi

  rm -rf "$tmpd"
done

# --------------------------------------------------------------------------
# Test 9: telemetry が空 / 欠落 → --telemetry-json を付けずに記録する（空 object を渡さない）
# --------------------------------------------------------------------------
for variant in empty absent; do
  tmpd=$(make_tmpdir)
  mkdir -p "${tmpd}/journal/pending"
  capture="${tmpd}/capture.txt"
  stub="${tmpd}/journal.sh"
  make_stub_journal "$stub" "$capture" 0

  if [[ $variant == empty ]]; then
    jq -n --arg js "$stub" '{skill: "dev-flow", outcome: "success", issue: 1, journal_sh: $js, telemetry: {}}' \
      >"${tmpd}/journal/pending/notel.json"
  else
    jq -n --arg js "$stub" '{skill: "pr-iterate", outcome: "success", journal_sh: $js}' \
      >"${tmpd}/journal/pending/notel.json"
  fi

  run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"

  captured=$(cat "$capture" 2>/dev/null || echo "")
  if [[ $RUN_EXIT -eq 0 ]] && echo "$captured" | grep -q "^log " && ! echo "$captured" | grep -q -- "--telemetry-json"; then
    pass "telemetry_${variant}_recorded_without_flag"
  else
    fail "telemetry_${variant}_recorded_without_flag" "exit=${RUN_EXIT} got: ${captured}"
  fi
  if [[ ! -f "${tmpd}/journal/pending/notel.json" && ! -d "${tmpd}/journal/pending/malformed" ]]; then
    pass "telemetry_${variant}_pending_removed"
  else
    fail "telemetry_${variant}_pending_removed" "pending file should be removed (not malformed)"
  fi

  rm -rf "$tmpd"
done

# --------------------------------------------------------------------------
# Test 10: dev-flow 失敗 run → error_category / error_msg / error_phase (top-level) が
#          --error-category / --error-msg / --error-phase として転送される
# --------------------------------------------------------------------------
{
  tmpd=$(make_tmpdir)
  mkdir -p "${tmpd}/journal/pending"
  capture="${tmpd}/capture.txt"
  stub="${tmpd}/journal.sh"
  make_stub_journal "$stub" "$capture" 0

  make_base_handoff "${tmpd}/journal/pending/abortrun.json" "$stub" \
    '.outcome = "failure" | .error_category = "abort" | .error_msg = "abort@Evaluate/eval#1: evaluator boom" | .error_phase = "Evaluate"'

  run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"

  captured=$(cat "$capture" 2>/dev/null || echo "")
  if echo "$captured" | grep -q "log dev-flow failure" &&
    echo "$captured" | grep -q -- "--error-category abort" &&
    echo "$captured" | grep -q -- "--error-msg abort@Evaluate/eval#1: evaluator boom" &&
    echo "$captured" | grep -q -- "--error-phase Evaluate"; then
    pass "failure_run_error_fields_forwarded"
  else
    fail "failure_run_error_fields_forwarded" "got: ${captured}"
  fi
  if [[ ! -f "${tmpd}/journal/pending/abortrun.json" ]]; then
    pass "failure_run_pending_removed"
  else
    fail "failure_run_pending_removed" "pending file should be removed after successful processing"
  fi

  rm -rf "$tmpd"
}

# --------------------------------------------------------------------------
# Test 11: stdout must be empty (hook prints nothing to stdout)
# --------------------------------------------------------------------------
{
  tmpd=$(make_tmpdir)
  mkdir -p "${tmpd}/journal/pending"
  capture="${tmpd}/capture.txt"
  stub="${tmpd}/journal.sh"
  make_stub_journal "$stub" "$capture" 0

  make_base_handoff "${tmpd}/journal/pending/handoff.json" "$stub" '.'

  stdout_out=$(env "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}" bash "$HOOK" </dev/null 2>/dev/null || true)

  if [[ -z $stdout_out ]]; then
    pass "no_stdout_output"
  else
    fail "no_stdout_output" "hook should not write to stdout, got: ${stdout_out}"
  fi

  rm -rf "$tmpd"
}

# --------------------------------------------------------------------------
# Test 12: null 値のキーは落とす（0 は残す）。plugin_commit だけは null も JSON null で渡す
# --------------------------------------------------------------------------
for pc in '"1ef2e0ab6254"' 'null'; do
  tmpd=$(make_tmpdir)
  mkdir -p "${tmpd}/journal/pending"
  capture="${tmpd}/capture.txt"
  stub="${tmpd}/journal.sh"
  make_stub_journal "$stub" "$capture" 0

  make_base_handoff "${tmpd}/journal/pending/nulls.json" "$stub" \
    ".telemetry.plugin_commit = ${pc} | .telemetry.eval_verdict = null | .telemetry.duration_seconds = 0"

  run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"

  captured=$(cat "$capture" 2>/dev/null || echo "")
  if telemetry_arg_of "$captured" | jq -e --argjson pc "$pc" '
      has("plugin_commit") and .plugin_commit == $pc and
      (has("eval_verdict") | not) and
      .duration_seconds == 0 and
      (keys | length) == 11
    ' >/dev/null 2>&1; then
    pass "null_handling_plugin_commit_${pc//\"/}"
  else
    fail "null_handling_plugin_commit_${pc//\"/}" "expected plugin_commit=${pc}, eval_verdict dropped, duration_seconds=0. got: $(telemetry_arg_of "$captured")"
  fi

  rm -rf "$tmpd"
done

# --------------------------------------------------------------------------
# Test 13 (静的検証): hook が journal.sh へ渡す flag は entry の基本項目と --telemetry-json だけ。
#          telemetry キー個別の flag 転送・jq projection・除外リストを持たない
# --------------------------------------------------------------------------
{
  forwarded_flags=$(grep -oE 'cmd_args\+=\(--[a-z-]+' "$HOOK" | sed 's/^cmd_args+=(//' | sort -u | tr '\n' ' ')
  expected_flags='--error-category --error-msg --error-phase --pr-number --repo --telemetry-json '
  if [[ $forwarded_flags == "$expected_flags" ]]; then
    pass "static_forwarded_flags_are_base_fields_and_telemetry_json"
  else
    fail "static_forwarded_flags_are_base_fields_and_telemetry_json" "expected [${expected_flags}] got [${forwarded_flags}]"
  fi

  per_key_refs=$(grep -nE '\.telemetry\.[a-z_]+|PER_KEY_TELEMETRY_KEYS|telemetry-key-dropped' "$HOOK" || true)
  if [[ -z $per_key_refs ]]; then
    pass "static_no_per_key_telemetry_wiring"
  else
    fail "static_no_per_key_telemetry_wiring" "per-key telemetry wiring remains: ${per_key_refs}"
  fi

  residue=$(grep -n 'trust' "$HOOK" || true)
  if [[ -z $residue ]]; then
    pass "static_no_trust_residue_in_hook"
  else
    fail "static_no_trust_residue_in_hook" "trust-layer residue found in hook: ${residue}"
  fi
}

# --------------------------------------------------------------------------
# Test 14 (integration): 実 journal.sh を通すと、残す 12 キーがそのまま journal entry の
#          telemetry に入る。plugin_commit が null の run でも entry が書かれ JSON null が残る
# --------------------------------------------------------------------------
{
  if [[ ! -x $REAL_JOURNAL ]]; then
    fail "integration_real_journal_present" "real journal.sh not found: ${REAL_JOURNAL}"
  else
    for pc in '"1ef2e0ab6254"' 'null'; do
      tmpd=$(make_tmpdir)
      mkdir -p "${tmpd}/journal/pending"
      make_base_handoff "${tmpd}/journal/pending/int.json" "$REAL_JOURNAL" \
        ".repo = \"acme/skills\" | .pr_number = 12 | .telemetry.plugin_commit = ${pc}"

      run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"

      entry=$(ls "${tmpd}/journal"/*.json 2>/dev/null | head -1 || true)
      want=$(jq -c --argjson pc "$pc" '.plugin_commit = $pc' <<<"$KEPT_TELEMETRY")
      if [[ -n $entry ]] && jq -e --argjson want "$want" '
          .telemetry == $want and
          (.telemetry | has("plugin_commit")) and
          .context.repo == "acme/skills" and .context.pr_number == 12
        ' "$entry" >/dev/null 2>&1; then
        pass "integration_12_keys_persisted_plugin_commit_${pc//\"/}"
      else
        fail "integration_12_keys_persisted_plugin_commit_${pc//\"/}" "entry telemetry: $(jq -c '.telemetry' "$entry" 2>/dev/null) hook output: ${RUN_OUT} log: $(cat "${tmpd}/.claude/logs/stop-devflow-telemetry.log" 2>/dev/null)"
      fi
      if [[ ! -e "${tmpd}/journal/pending/int.json" ]]; then
        pass "integration_pending_removed_plugin_commit_${pc//\"/}"
      else
        fail "integration_pending_removed_plugin_commit_${pc//\"/}" "pending handoff should be removed after flush"
      fi
      rm -rf "$tmpd"
    done
  fi
}

# --------------------------------------------------------------------------
# plugin cache mode: PATH に journal が無くても、
# <cache>/<marketplace>/playpark-core/<version>/journal/scripts/journal.sh の最新版へ流す
# --------------------------------------------------------------------------
{
  tmpd=$(make_tmpdir)
  cache="${tmpd}/cache/playpark"
  mkdir -p "${cache}/dev-flow/aaa111/hooks" "${tmpd}/journal/pending"
  cp "$HOOK" "${cache}/dev-flow/aaa111/hooks/stop-devflow-telemetry.sh"
  for v in old000 new999; do
    mkdir -p "${cache}/playpark-core/${v}/journal/scripts"
    make_stub_journal "${cache}/playpark-core/${v}/journal/scripts/journal.sh" "${tmpd}/capture-${v}.txt" 0
  done
  touch -t 202001010000 "${cache}/playpark-core/old000/journal/scripts/journal.sh"
  make_handoff "${tmpd}/journal/pending" "cache.json" '.journal_sh = "journal"'

  jq_dir="$(dirname "$(command -v jq)")"
  RUN_EXIT=0
  RUN_OUT=$(env "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}" "PATH=${jq_dir}:/usr/bin:/bin" \
    bash "${cache}/dev-flow/aaa111/hooks/stop-devflow-telemetry.sh" </dev/null 2>&1) || RUN_EXIT=$?

  if [[ $RUN_EXIT -eq 0 && -s "${tmpd}/capture-new999.txt" && ! -s "${tmpd}/capture-old000.txt" ]]; then
    pass "cache_mode_resolves_newest_playpark_core_journal"
  else
    fail "cache_mode_resolves_newest_playpark_core_journal" "exit=${RUN_EXIT} new=$(cat "${tmpd}/capture-new999.txt" 2>/dev/null) old=$(cat "${tmpd}/capture-old000.txt" 2>/dev/null) log=$(cat "${tmpd}/.claude/logs/stop-devflow-telemetry.log" 2>/dev/null)"
  fi
  if [[ ! -e "${tmpd}/journal/pending/cache.json" ]]; then
    pass "cache_mode_handoff_flushed"
  else
    fail "cache_mode_handoff_flushed" "pending handoff should be removed after flush"
  fi
  rm -rf "$tmpd"
}

# --------------------------------------------------------------------------
# Summary
# --------------------------------------------------------------------------
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
