// agent({schema}) が有効な StructuredOutput を得られずに終わった失敗（StructuredOutput 契約違反）の判定。
// trackedAgent の再試行条件（retryOnContractViolation の opt-in call site だけ・1 回）と、Merge tier の
// merge-tier-facts の catch（HOLD reason を merge_facts_dropped にするか）がこの 1 関数だけで判定する。
// harness の文言ごとに呼び出し側へ文字列判定を複製すると、文言が増えたとき全箇所が同時に取りこぼすため。
//
// harness がこの失敗に使う文言:
//   - `agent({schema}): subagent completed without calling StructuredOutput ...`（呼ばずに終わった）
//   - `agent({schema}): StructuredOutput retry cap (N) exceeded`（schema 不一致の呼び出しが上限に達した）
// guard の拒否など他の失敗は false — 同じ prompt で再実行しても同じ理由で落ちるので再試行しない。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ inline 生成される。
// 直接 workflow 側を編集しない。一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。

/**
 * @param {unknown} e - agent() が throw した値
 * @returns {boolean} 有効な StructuredOutput を得られずに終わった失敗なら true
 */
export function isStructuredOutputFailure(e) {
  if (e == null) return false
  const msg = String(e.message ?? e)
  return msg.includes('without calling StructuredOutput') || msg.includes('StructuredOutput retry cap')
}
