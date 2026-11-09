// Goal Ledger: dev-flow の収束エンジン。収束 = BLOCKING lane の全項目 checked。
// item = { id, text, dimension, severity, source, checked, evidence, check, floor, triaged, triaged_evidence,
//          final_resolution, final_evidence }
//   severity: 'critical' | 'major' | 'minor'
//   source:   'ac' | 'seed' | 'reviewer' | 'evaluator' | 'danger-grep' | 'concern' | 'analyze' | 'implement'
//   check:    { kind: 'deterministic' | 'inspection', ref?: string } | null
//   floor:    boolean  (true = 決定論 floor が注入。LLM は severity を lower できない)
//   triaged:  boolean | undefined  (表示専用。checked とは独立。gate/収束/merge tier には不使用)
//   triaged_evidence: string | null | undefined  (triaged:true のときの根拠)
//   final_resolution: 'resolved'|'unresolved'|undefined（表示専用。Final AC reconcile
//     時の fix 後 tree 再評価結果。checked とは独立で gate/収束/merge tier には不使用）
//   final_evidence: string|null|undefined
//
// lane 分類（blocking/advisory）は _lib/gate-policy.mjs の gateLane(item, policy) に一本化。
// 全関数は純粋(ledger を mutate せず新オブジェクトを返す)。state は呼び出し側の JS 変数に持つ。
//
// INLINE COPY POLICY: workflow から参照される最上位宣言だけが tools/sync-inlines.mjs --write で inline 生成される。
// 直接 workflow 側を編集しない。一致は _lib/workflow-inlines.sync.test.mjs が検証する。

export function makeLedger() {
  return { items: [], round: 0 };
}

export function topicKey(item) {
  const norm = String(item.text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  return `${item.dimension ?? '?'}::${norm}`;
}

export function canAppend(ledger, item) {
  if (ledger.round === 0) return true;
  if (item.severity === 'critical') return true;
  if (item.escalate === true) return true;
  const key = topicKey(item);
  return ledger.items.some((it) => topicKey(it) === key);
}

export function appendItem(ledger, item) {
  if (!canAppend(ledger, item)) return { ledger, accepted: false };
  const key = topicKey(item);
  const idx = ledger.round > 0 ? ledger.items.findIndex((it) => topicKey(it) === key) : -1;
  const items = ledger.items.slice();
  if (idx >= 0) items[idx] = { ...items[idx], ...item, id: items[idx].id };
  else items.push({ checked: false, evidence: null, floor: false, check: null, ...item, check: item.check ? { ...item.check } : null });
  return { ledger: { ...ledger, items }, accepted: true };
}

function ledgerItemIndex(ledger, id) {
  const idx = ledger.items.findIndex((it) => it.id === id);
  if (idx < 0) throw new Error(`goal-ledger: 未知の item id "${id}"`);
  return idx;
}

function patchLedgerItem(ledger, id, patch) {
  const idx = ledgerItemIndex(ledger, id);
  const items = ledger.items.slice();
  items[idx] = { ...items[idx], ...patch };
  return { ...ledger, items };
}

export function checkItem(ledger, id, evidence) {
  return patchLedgerItem(ledger, id, { checked: true, evidence: evidence ?? null });
}

// reopenItem: LLM 判断で checked になった item の解消根拠が、後の変更（post-eval green-fix / pr-iterate fix）で
// 崩れた・確かめられなかったときに未解消へ戻す。gate を厳しくする方向にだけ動く。決定論で checked になった
// item（seed / check.kind:'deterministic'）は最終 tree の決定論再判定が担うので戻さない（呼ぶと throw）。
export function reopenItem(ledger, id, evidence) {
  const it = ledger.items[ledgerItemIndex(ledger, id)];
  if (it.source === 'seed' || (it.check && it.check.kind === 'deterministic')) {
    throw new Error(`goal-ledger: 決定論 item "${id}" は reopen しない`);
  }
  return patchLedgerItem(ledger, id, { checked: false, evidence: evidence ?? null });
}

// triaged: evaluator が「再検証済み・対応不要」と判断した item に付ける表示専用フラグ（issue #614）。
// checked / evidence は変えない（ゲート・収束・merge tier・lane 分類の入力にならない）。
export function triageItem(ledger, id, evidence) {
  return patchLedgerItem(ledger, id, { triaged: true, triaged_evidence: evidence ?? null });
}

// final_resolution: Final AC reconcile evaluator が「fix 後の最終 tree で再検証した結果」を付ける
// 表示専用フィールド（issue #658）。FINAL_ITEM_RESOLUTIONS は _lib/final-ac-reconcile.mjs
// （canonical は import 不可のため重複定義）。checked / evidence / triaged は変えない（純粋関数）。
export function setFinalResolution(ledger, id, resolution, evidence) {
  // FINAL_ITEM_RESOLUTIONS は _lib/final-ac-reconcile.mjs（canonical は import 不可のため重複定義）
  if (!['resolved', 'unresolved'].includes(resolution)) throw new Error(`goal-ledger: 不正な final_resolution "${resolution}"`);
  return patchLedgerItem(ledger, id, { final_resolution: resolution, final_evidence: evidence ?? null });
}

export function setCheck(ledger, id, check) {
  return patchLedgerItem(ledger, id, { check });
}

export function nextRound(ledger) {
  return { ...ledger, round: ledger.round + 1 };
}
