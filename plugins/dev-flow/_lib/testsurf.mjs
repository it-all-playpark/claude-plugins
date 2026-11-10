// dev-flow issue #362: TESTSURF ledger seeding/reconcile の pure 関数群（test-weakening 第8
// danger クラス）。SEC の seedSecurityLedger/reconcileDanger（_lib/merge-tier.mjs L340-399 相当）と
// 同型だが別 dimension（test-integrity）— dangerHits / security_focus / danger_hits telemetry /
// reconcileDanger の意味論を一切変えない別系統の seed family。
//
// INLINE COPY POLICY: workflow から参照される最上位宣言だけが tools/sync-inlines.mjs --write で inline 生成される。
// 直接 workflow 側を編集しない。一致は _lib/workflow-inlines.sync.test.mjs が検証する。

// risk.hits のうち class==='test-weakening'（test-surface 縮小系）の hit のみを返す。
// risk が null または risk.ok!==true（danger-grep 実行失敗/転写失敗/空出力）は空配列を返す。
// fail-closed（全 TESTSURF item を unchecked に戻す等）は同一スクリプトの SEC 側 reconcileDanger
// が担保する invariant に相乗りするため、ここでは単に「hit なし」として扱う。
export function testsurfHitsOf(risk) {
  if (!risk || risk.ok !== true) return [];
  return (risk.hits ?? []).filter((h) => h.class === 'test-weakening');
}

// risk.hits のうち class!=='test-weakening'（従来の 7 danger クラス）の hit のみを返す。
// 呼び出し側の dangerHits（SEC reconcile 用の入力）算出用の分離ヘルパー。test-weakening hit が
// dangerHits に混入すると security_focus / danger_hits telemetry / SEC reconcile の意味論が壊れる
// ため、workflow 側はこの関数で必ず分離してから reconcileDanger に渡す。
export function secHitsOf(risk) {
  if (!risk || risk.ok !== true) return [];
  return (risk.hits ?? []).filter((h) => h.class !== 'test-weakening');
}

// testsurfHitsOf の pattern を dedup した配列を返す。pattern 欠落/未知は 'unknown' にバケットする
// （out-of-enum を握りつぶさない repo 規約）。
export function testsurfPatternsOf(risk) {
  const hits = testsurfHitsOf(risk);
  const seen = new Set();
  const result = [];
  for (const h of hits) {
    const pattern = h.pattern ?? 'unknown';
    if (seen.has(pattern)) continue;
    seen.add(pattern);
    result.push(pattern);
  }
  return result;
}

function testsurfId(pattern) {
  return `TESTSURF-${pattern.toUpperCase()}`;
}

// TESTSURF-<PATTERN> の id から pattern を逆算する（testsurfId の逆写像）。TESTSURF- 接頭辞が
// 無ければ null。
function patternFromId(id) {
  if (typeof id !== 'string' || !id.startsWith('TESTSURF-')) return null;
  return id.slice('TESTSURF-'.length).toLowerCase();
}

function isTestsurfSeedItem(it) {
  return typeof it.id === 'string' && it.id.startsWith('TESTSURF-')
    && it.source === 'seed' && it.dimension === 'test-integrity';
}

// TESTSURF seed item を test-weakening hit で reconcile する。SEC の reconcileDanger と同型だが
// dimension は 'test-integrity'、severity は常に 'critical'（実効 blocking は source:'seed' の
// gateLane が担保 — 軸A invariant で policy に依らず blocking）。
//
// risk が null または risk.ok!==true のときは ledger をそのまま返す（一切 touch しない）。同一
// スクリプト（diff-risk-classify.sh）の SEC 側 fail-closed（reconcileDanger）が全 SEC unchecked →
// merge tier HOLD を既に担保しているため、fail と clean を同一視しないという invariant は SEC 側の
// safety net に委ねてよい（TESTSURF 側での二重実装を避ける）。
//
// risk.ok===true のとき、hit を pattern ごとに group する（pattern 欠落は 'unknown' バケット）:
//   - hit がある pattern:
//       item 未存在 → append（id 重複時は追加しない = append 単調性）。
//       既存 item が checked&&floor（evaluator clearance 済み）→ そのまま維持（HOLD に巻き戻さない）。
//       既存 item が checked&&!floor（前回 "testsurf clean" で自動解決済み）→ 今回 hit に転じたので
//         unchecked 復活（floor=true, evidence=null）。
//       既存 item が unchecked → 据え置き。
//   - hit が無い pattern の既存 TESTSURF item → checked=true + evidence 付与で自動解消（floor は
//     touch しない — reconcileDanger clean 分岐と同型）。
// TESTSURF 以外（id が TESTSURF- で始まらない / source!=='seed' / dimension!=='test-integrity'）の
// item は一切 touch しない。ledger は mutate しない。
export function reconcileTestsurf(ledger, risk) {
  if (!risk || risk.ok !== true) return ledger;

  const hits = testsurfHitsOf(risk);
  const hitsByPattern = new Map();
  for (const h of hits) {
    const pattern = h.pattern ?? 'unknown';
    if (!hitsByPattern.has(pattern)) hitsByPattern.set(pattern, []);
    if (h.file != null) hitsByPattern.get(pattern).push(h.file);
  }

  const items = ledger.items.map((it) => {
    if (!isTestsurfSeedItem(it)) return it;
    const pattern = patternFromId(it.id);
    const hasHit = pattern != null && hitsByPattern.has(pattern);
    if (hasHit) {
      // floor=true かつ checked=true → evaluator が clearance 済み。同 pattern が依然 hit でも
      // checked を維持して HOLD に巻き戻さない。
      if (it.checked && it.floor) return it;
      // floor=false かつ checked=true → 前回 reconcile で "testsurf clean" 自動解決されたが
      // 今回 hit に転じた → unchecked にして block を復活させる。
      if (it.checked && !it.floor) {
        return { ...it, checked: false, floor: true, evidence: null };
      }
      // unchecked → 据え置き。
      return it;
    }
    return { ...it, checked: true, evidence: 'testsurf clean (pattern no longer detected)' };
  });

  const existingIds = new Set(items.map((it) => it.id));
  for (const [pattern, files] of hitsByPattern) {
    const id = testsurfId(pattern);
    if (existingIds.has(id)) continue;
    const fileList = [...new Set(files)].join(', ');
    items.push({
      id,
      text: `test-surface 縮小検出(${pattern}): ${fileList}`,
      dimension: 'test-integrity',
      severity: 'critical',
      source: 'seed',
      floor: true,
      checked: false,
      check: { kind: 'deterministic' },
      evidence: null,
    });
  }

  return { ...ledger, items };
}
