// post-eval-recheck: Evaluate 後に入った変更（post-eval green-fix / pr-iterate fix）を run 内で確かめ直すための
// 純関数群。I/O なし、非決定性なし。
//
// - classifyGreenFixDiff: green-fix 差分の再評価モード（assert_only / full）を決定論で決める
// - recheckTargets: 台帳の解消済み項目のうち、後から変更されたファイルに言及するものを再検証対象にする
// - planRecheck: evaluator の recheck_resolutions を「再確認（evidence 差し替え）/ 取り下げ（reopen）」に振り分ける
// - greenFixRecheckItems: green-fix 再評価の critical finding を台帳 item に変換する
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。

// green-fix 再評価のモード。assert_only = テストファイルだけの変更で testsurf / danger hit 0 件
// （テストの assert を弱めていないかだけを確認）。full = それ以外（差分全体を評価）。
export const GREEN_FIX_RECHECK_MODES = ['assert_only', 'full'];

// recheck_resolutions[].resolution の closed enum。resolved 以外（enum 外を含む）は解消根拠を取り下げる側に倒す。
export const RECHECK_RESOLUTIONS = ['resolved', 'unresolved'];

// テストファイル判定。tests/ 配下・__tests__/ 配下・*.test.* / *.spec.* / *_test.* / *.bats。
// assert_only に倒す条件の一部なので、判定に迷うパス（helper の置き場所が不明等）は full 側に落ちる。
const TEST_FILE_RES = [
  /(^|\/)(tests?|__tests__|spec)\//i,
  /\.(test|spec)\.[^/]+$/i,
  /_test\.[^/]+$/i,
  /\.bats$/i,
];

export function isTestFilePath(p) {
  return typeof p === 'string' && p.length > 0 && TEST_FILE_RES.some((re) => re.test(p));
}

// green-fix 差分の再評価モードを決める。
//   files:     評価済み tree → green-fix 後 tree の差分パス（ephemeral 除外済み）。null = 取得不能
//   truncated: numstat の打ち切り有無（打ち切りは差分全体が見えていないので full）
//   risk:      diff-triage の risk（working tree 全体 vs base）。hit は files に含まれるものだけを見る
// 差分パス不明・risk 取得失敗は full（fail-safe: 軽い確認に倒さない）。
// hits は green-fix 差分のファイルに載った risk hit（danger / test-weakening の両方）。
export function classifyGreenFixDiff({ files, truncated, risk }) {
  if (!Array.isArray(files) || files.length === 0) return { mode: 'full', reason: 'files_unknown', hits: [] };
  if (truncated === true) return { mode: 'full', reason: 'files_truncated', hits: [] };
  if (!risk || risk.ok !== true || !Array.isArray(risk.hits)) return { mode: 'full', reason: 'risk_unavailable', hits: [] };
  const fileSet = new Set(files);
  const hits = risk.hits.filter((h) => h && fileSet.has(h.file));
  if (hits.length > 0) return { mode: 'full', reason: 'hits', hits };
  if (!files.every((f) => isTestFilePath(f))) return { mode: 'full', reason: 'non_test_files', hits };
  return { mode: 'assert_only', reason: 'test_only_clean', hits };
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function basenameOf(p) {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

// text がファイル名 needle に言及しているか。前後が識別子・パス文字で連続している一致（index.ts に対する x.ts、
// x.tsx に対する x.ts）は言及とみなさない。
function mentions(text, needle) {
  if (typeof text !== 'string' || text.length === 0) return false;
  return new RegExp(`(^|[^\\w.-])${escapeRegExp(needle)}(?![\\w-])`).test(text);
}

// 再検証の候補になる台帳 item: LLM 判断（evaluator の critical_resolutions / concern_resolutions）で
// checked になったもの。決定論で checked になった item（seed の SEC / TESTSURF、red→green 実証の AC）は
// Merge tier の danger-grep 再判定・テスト再実行が最終 tree で確かめ直すので対象外。AC item は Final AC reconcile が、
// ESCALATE は人間が判断するので対象外。
export function isRecheckCandidate(it) {
  return !!it && it.checked === true
    && (it.source === 'evaluator' || it.source === 'concern')
    && it.dimension !== 'environment'
    && it.escalate !== true
    && !(it.check && it.check.kind === 'deterministic');
}

// 後から変更されたファイル（touchedFiles）を本文か evidence に含む解消済み item を返す。
// パス全体か basename のどちらかで言及していれば対象（evaluator の evidence は basename だけを書くことが多い）。
export function recheckTargets(ledger, touchedFiles) {
  const paths = (Array.isArray(touchedFiles) ? touchedFiles : []).filter((p) => typeof p === 'string' && p.length > 0);
  if (paths.length === 0 || !ledger || !Array.isArray(ledger.items)) return [];
  const needles = [...new Set([...paths, ...paths.map(basenameOf)])].filter((n) => n.length > 0);
  return ledger.items.filter((it) => isRecheckCandidate(it)
    && needles.some((n) => mentions(it.text, n) || mentions(it.evidence, n)));
}

// evaluator の recheck_resolutions を対象ごとに振り分ける。
//   resolved + 非空 evidence → reconfirm（evidence を再検証の結果で置き換えて checked を保つ）
//   それ以外（unresolved / evidence 欠落 / 未返却 / enum 外 / resolutions 自体が null）→ reopen
//   （後の変更で根拠が崩れたか確かめられていない解消根拠を、終端サマリの「解消済み」に残さない）
// 対象外 id・重複 id（2 件目以降）は無視する。where は evidence の接頭辞（どの tree で確かめたか）。
export function planRecheck(targets, resolutions, where) {
  const byId = new Map();
  for (const r of Array.isArray(resolutions) ? resolutions : []) {
    if (!r || typeof r !== 'object' || typeof r.id !== 'string' || byId.has(r.id)) continue;
    byId.set(r.id, r);
  }
  const reconfirm = [];
  const reopen = [];
  for (const it of Array.isArray(targets) ? targets : []) {
    const r = byId.get(it.id);
    const ev = r && typeof r.evidence === 'string' ? r.evidence.trim() : '';
    if (r && r.resolution === 'resolved' && ev.length > 0) {
      reconfirm.push({ id: it.id, evidence: `${where} で再検証済み: ${ev}` });
    } else if (r && r.resolution === 'unresolved' && ev.length > 0) {
      reopen.push({ id: it.id, evidence: `${where} で再検証し解消根拠が不成立: ${ev}` });
    } else {
      reopen.push({ id: it.id, evidence: `${where} で再検証できず — 解消根拠を取り下げ（要確認）` });
    }
  }
  return { reconfirm, reopen };
}

// green-fix 再評価の findings のうち critical だけを台帳 item にする（Evaluate round 以降の台帳は
// critical 以外を受け付けない）。id は GF-RECHECK-<n>（EVAL-* と分けるのは、fix 後の test green で
// EVAL-* を決定論 check する経路に乗せないため — テスト弱体化は test green では否定できない）。
export function greenFixRecheckItems(findings) {
  const items = [];
  for (const f of Array.isArray(findings) ? findings : []) {
    if (!f || typeof f !== 'object' || f.severity !== 'critical') continue;
    const topic = typeof f.topic === 'string' && f.topic.trim() ? f.topic.trim() : 'green-fix';
    const desc = typeof f.description === 'string' && f.description.trim() ? ` — ${f.description.trim()}` : '';
    items.push({
      id: `GF-RECHECK-${items.length + 1}`,
      text: `post-eval green-fix: ${topic}${desc}`.slice(0, 500),
      dimension: typeof f.dimension === 'string' && f.dimension ? f.dimension : 'test-integrity',
      severity: 'critical', source: 'evaluator', check: { kind: 'inspection' },
    });
  }
  return items;
}
