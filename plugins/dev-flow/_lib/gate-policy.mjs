// dev-flow W5: gate_policy による lane 分類の純粋関数群。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。

// gate_policy の 2 値（LLM major を advisory / blocking のどちらに置くか）。
export const GATE_POLICIES = [
  'llm-major-advisory',
  'llm-major-blocking',
];

// デフォルト gate_policy。
export const DEFAULT_GATE_POLICY = 'llm-major-advisory';

// gate_policy 値を解決する。null/undefined/空文字は DEFAULT_GATE_POLICY を返す。
// 有効値はそのまま返す。未知の値は Error を throw する。
export function resolveGatePolicy(value) {
  if (value == null || value === '') return DEFAULT_GATE_POLICY;
  if (GATE_POLICIES.includes(value)) return value;
  throw new Error(
    `gate-policy: 未知の gate_policy "${value}"（許可: ${GATE_POLICIES.join(', ')}）`,
  );
}

// item を 'blocking' | 'advisory' に分類する純粋関数。
//
// 軸A invariant（policy によらず常に blocking）:
//   - item.severity === 'critical'
//   - item.check && item.check.kind === 'deterministic'
//   - item.source === 'seed'
//
// LLM major（critical でなく deterministic でなく seed でない major）の写像:
//   llm-major-advisory  → advisory
//   llm-major-blocking  → blocking
//
// LLM minor は全 policy で advisory。
export function gateLane(item, policy) {
  // 軸A invariant: 決定論 oracle / critical / seed は policy に依らず blocking
  if (item.severity === 'critical') return 'blocking';
  if (item.check && item.check.kind === 'deterministic') return 'blocking';
  if (item.source === 'seed') return 'blocking';
  // LLM major の写像
  if (item.severity === 'major') {
    return policy === 'llm-major-blocking' ? 'blocking' : 'advisory';
  }
  // LLM minor（および未知 severity）は advisory
  return 'advisory';
}

// ledger.items のうち blocking に分類される item を返す純粋関数。
export function policyBlockingItems(ledger, policy) {
  return ledger.items.filter((it) => gateLane(it, policy) === 'blocking');
}

// ledger.items のうち advisory に分類される item を返す純粋関数。
export function policyAdvisoryItems(ledger, policy) {
  return ledger.items.filter((it) => gateLane(it, policy) === 'advisory');
}

// 全 blocking item が checked かどうかを判定する純粋関数（空は true）。
export function isConvergedUnderPolicy(ledger, policy) {
  return policyBlockingItems(ledger, policy).every((it) => it.checked);
}

// Evaluate ループ収束専用の純粋関数（issue #271）。
//
// danger-grep fail-closed(risk.ok!==true) でマークした SEC seed（source==='seed' &&
// dimension==='security' && fail_closed===true）を Evaluate ループの収束対象からのみ
// 除外する。merge tier 側は isConvergedUnderPolicy を使い fail_closed item を含めたまま
// HOLD を強制する（分離。issue #271）。
//
// fail_closed でない SEC item（実際に danger を検出した hit item を含む）は除外されず、
// 従来通り checked になるまでループを blocking し続ける。非 SEC dimension の blocking item
// の収束ロジックは isConvergedUnderPolicy と同一。
export function isLoopConvergedUnderPolicy(ledger, policy) {
  return policyBlockingItems(ledger, policy)
    .filter((it) => !(it.source === 'seed' && it.dimension === 'security' && it.fail_closed === true))
    .every((it) => it.checked);
}
