// subagent-invocations: run あたりの subagent (agent-invoke) 起動数カウント用の純関数群。
// I/O なし・Date.now/Math.random 不使用。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。

/**
 * counts（plain object）の counts[key] を +1 する。
 * agentType が非空文字列の string でなければ 'unknown' へ計上する（fail-safe）。
 * @param {object} counts - mutate 対象のカウント集計 object
 * @param {string|undefined} agentType - subagent の agentType
 * @returns {object} counts（同一 object）
 */
export function recordSubagentInvocation(counts, agentType) {
  const key = typeof agentType === 'string' && agentType.trim() !== '' ? agentType : 'unknown';
  counts[key] = (counts[key] || 0) + 1;
  return counts;
}

/**
 * counts から telemetry 用の { total, by_type } を組み立てる。
 * by_type はキーを sort した新 object（counts を mutate しない）。
 * @param {object} counts - recordSubagentInvocation の集計 object
 * @returns {{total: number, by_type: object}}
 */
export function buildSubagentInvocations(counts) {
  const keys = Object.keys(counts).sort();
  let total = 0;
  const by_type = {};
  for (const key of keys) {
    const value = counts[key];
    total += value;
    by_type[key] = value;
  }
  return { total, by_type };
}
