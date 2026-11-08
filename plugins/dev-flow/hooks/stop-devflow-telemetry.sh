#!/usr/bin/env bash
# Stop hook: dev-flow telemetry handoff flush
#
# Claude Code の Stop event で呼び出される hook。dev-flow が pending dir に書き出した
# handoff JSON を読み取り、journal.sh log コマンドへ転送して telemetry を記録する。
#
# pending dir: ${CLAUDE_JOURNAL_DIR:-$HOME/.claude/journal}/pending/
# 各 *.json を atomic claim（mv + PID suffix）してから処理し、成功なら削除、
# 失敗なら元のファイル名に戻す（次回 Stop で再試行）。
#
# malformed replay runbook（pending/malformed/ に落ちた handoff の回収手順）:
#   1. mv ~/.claude/journal/pending/malformed/<file>.json ~/.claude/journal/pending/
#   2. echo '{}' | bash "${CLAUDE_PLUGIN_ROOT}/hooks/stop-devflow-telemetry.sh"  # または次の Stop event
#   3. ~/.claude/logs/stop-devflow-telemetry.log に journal-failed が無いことを確認
#   注: outcome=failure かつ error_category/error_msg を欠く payload は journal.sh 契約
#   （outcome != success で両キー必須）で journal-failed → pending/ に残り続ける。
#   再投入前に payload へ error_category（enum: lint|test|build|runtime|config|env|merge|
#   type-check|needs_clarification|empty_diff|cross_repo|guard_blocked|abort|pr_phase_failed|evaluate_failed）と error_msg を
#   手で追記すること。
#
# 無効化:
#   - 環境変数 CLAUDE_DEVFLOW_TELEMETRY_HOOK=0（escape hatch）
#   - pending dir が存在しない
#
# journal.sh の解決順: payload path → payload bare 名(command -v) → command -v journal
#   → 隣接 playpark-core（link mode、skills#572）→ plugin cache の playpark-core 最新版
#
# telemetry は `.telemetry` を丸ごと --telemetry-json で渡す。キーごとの flag・検証は持たない
# （handoff に載せたキーはそのまま journal に届く）。
#
# stdout: なし
# stderr: なし（ログは $HOME/.claude/logs/stop-devflow-telemetry.log へ）
# 終了コード: 常に 0（Stop を絶対にブロックしない）
#
# Ref: https://code.claude.com/docs/en/hooks

set -euo pipefail

# stdin は JSON payload 前提。SIGPIPE 回避のため drain する。
cat >/dev/null 2>&1 || true

# Escape hatch
if [[ ${CLAUDE_DEVFLOW_TELEMETRY_HOOK:-1} == "0" ]]; then
  exit 0
fi

PENDING_DIR="${CLAUDE_JOURNAL_DIR:-${HOME}/.claude/journal}/pending"

if [[ ! -d $PENDING_DIR ]]; then
  exit 0
fi

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# repo checkout / link mode: dev-flow plugin root の隣に playpark-core がある
SIBLING_JOURNAL="${HOOK_DIR}/../../playpark-core/journal/scripts/journal.sh"
# plugin cache mode: <cache>/<marketplace>/dev-flow/<version>/hooks から見て
# <cache>/<marketplace>/playpark-core/<version>/journal/scripts/journal.sh にある。
# Stop hook の PATH には plugin の bin/ が載らず `command -v journal` が失敗するため、
# cache mode ではこれが唯一の解決経路になる。複数版が残っていれば最も新しいものを使う。
CACHE_SIBLING_JOURNAL=""
for cand in "${HOOK_DIR}"/../../../playpark-core/*/journal/scripts/journal.sh; do
  [[ -x $cand ]] || continue
  if [[ -z $CACHE_SIBLING_JOURNAL || $cand -nt $CACHE_SIBLING_JOURNAL ]]; then
    CACHE_SIBLING_JOURNAL="$cand"
  fi
done
LOG_FILE="${HOME}/.claude/logs/stop-devflow-telemetry.log"

# telemetry の null 値は落とすが、ここに挙げたキーは null も JSON null として記録する。
# plugin_commit（skills#785）: null は「取得を試みて決められなかった」で、キー欠落（#785 以前の entry）と区別する
PASSTHROUGH_NULLABLE_KEYS=(plugin_commit)
nullable_keys_json=$(printf '%s\n' "${PASSTHROUGH_NULLABLE_KEYS[@]}" | jq -R . | jq -sc .)

# Process each *.json in pending dir
for f in "${PENDING_DIR}"/*.json; do
  # No files matched (glob literal returned)
  [[ -e $f ]] || continue

  claimed="${f}.claimed.$$"

  # Atomic claim: mv 失敗 = 他プロセスが処理中 → skip
  if ! mv "$f" "$claimed" 2>/dev/null; then
    continue
  fi

  # --- Parse JSON ---
  # .telemetry が object 以外（文字列等）なら with_entries が jq エラーになり malformed 経路へ落ちる
  if ! parsed=$(jq -e '{
    skill: .skill,
    outcome: .outcome,
    issue: .issue,
    journal_sh: .journal_sh,
    repo: .repo,
    pr_number: .pr_number,
    error_category: .error_category,
    error_msg: .error_msg,
    error_phase: .error_phase,
    telemetry: ((.telemetry // {}) | with_entries(select((.value != null) or ((.key as $k | $nullable | index($k)) != null))))
  }' --argjson nullable "$nullable_keys_json" "$claimed" 2>/dev/null); then
    # JSON parse error
    mkdir -p "${PENDING_DIR}/malformed"
    mv "$claimed" "${PENDING_DIR}/malformed/$(basename "$f")"
    mkdir -p "$(dirname "$LOG_FILE")"
    printf '%s malformed-json %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(basename "$f")" >>"$LOG_FILE"
    continue
  fi

  skill=$(echo "$parsed" | jq -r '.skill // empty')
  outcome=$(echo "$parsed" | jq -r '.outcome // empty')

  # Required key check（producer 契約 _lib/journal-handoff.mjs と一致: skill/outcome のみ必須）
  if [[ -z $skill || -z $outcome ]]; then
    mkdir -p "${PENDING_DIR}/malformed"
    mv "$claimed" "${PENDING_DIR}/malformed/$(basename "$f")"
    mkdir -p "$(dirname "$LOG_FILE")"
    printf '%s missing-required-key %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(basename "$f")" >>"$LOG_FILE"
    continue
  fi

  issue=$(echo "$parsed" | jq -r '.issue // empty')
  journal_sh_field=$(echo "$parsed" | jq -r '.journal_sh // empty')
  repo=$(echo "$parsed" | jq -r '.repo // empty')
  pr_number=$(echo "$parsed" | jq -r '.pr_number // empty')
  error_category=$(echo "$parsed" | jq -r '.error_category // empty')
  error_msg=$(echo "$parsed" | jq -r '.error_msg // empty')
  error_phase=$(echo "$parsed" | jq -r '.error_phase // empty')
  telemetry_json=$(echo "$parsed" | jq -c '.telemetry')

  # --- Resolve journal.sh ---
  journal_sh=""
  resolved=""
  if [[ -n $journal_sh_field && -x $journal_sh_field ]]; then
    journal_sh="$journal_sh_field"
  elif [[ -n $journal_sh_field && $journal_sh_field != */* ]] && resolved=$(command -v -- "$journal_sh_field" 2>/dev/null); then
    # payload が bare 名（dev-flow.js は journal_sh: 'journal'）→ PATH 上の playpark-core bin/journal
    journal_sh="$resolved"
  elif resolved=$(command -v journal 2>/dev/null); then
    journal_sh="$resolved"
  elif [[ -x $SIBLING_JOURNAL ]]; then
    journal_sh="$SIBLING_JOURNAL"
  elif [[ -n $CACHE_SIBLING_JOURNAL ]]; then
    journal_sh="$CACHE_SIBLING_JOURNAL"
  else
    mkdir -p "$(dirname "$LOG_FILE")"
    printf '%s no-journal-sh %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(basename "$f")" >>"$LOG_FILE"
    mv "$claimed" "$f"
    continue
  fi

  # --- Build command args ---
  cmd_args=(
    log "$skill" "$outcome"
    --issue "$issue"
  )

  # Optional fields: only append if non-empty and not null
  if [[ -n $repo && $repo != "null" ]]; then
    cmd_args+=(--repo "$repo")
  fi
  if [[ -n $pr_number && $pr_number != "null" ]]; then
    cmd_args+=(--pr-number "$pr_number")
  fi
  # journal.sh は outcome != success のとき --error-category / --error-msg を必須とする。
  # これを欠くと失敗 run が journal-failed で pending に留まり続ける。
  if [[ -n $error_category && $error_category != "null" ]]; then
    cmd_args+=(--error-category "$error_category")
  fi
  if [[ -n $error_msg && $error_msg != "null" ]]; then
    cmd_args+=(--error-msg "$error_msg")
  fi
  if [[ -n $error_phase && $error_phase != "null" ]]; then
    cmd_args+=(--error-phase "$error_phase")
  fi
  # 空 object は渡さない（entry に空の telemetry を作らない）
  if [[ $telemetry_json != "{}" ]]; then
    cmd_args+=(--telemetry-json "$telemetry_json")
  fi

  # --- Execute journal.sh ---
  journal_stderr=""
  if journal_stderr=$(bash "$journal_sh" "${cmd_args[@]}" 2>&1 >/dev/null); then
    # Success: remove claimed file
    rm -f "$claimed"
  else
    # Failure: restore original filename, write log
    mv "$claimed" "$f"
    mkdir -p "$(dirname "$LOG_FILE")"
    printf '%s %s journal-failed: %s\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      "$(basename "$f")" \
      "$(echo "$journal_stderr" | head -1 | tr '\n' ' ')" >>"$LOG_FILE"
  fi
done

exit 0
