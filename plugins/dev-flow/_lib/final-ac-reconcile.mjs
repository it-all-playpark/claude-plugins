// dev-flow Final AC reconcile phase: fix 適用後の最終 PR tree に対して Setup 末尾の analyze
// ゲートで freeze した既存 AC を one-shot で再検証するための決定論 helper 群（skip/run 判定 + ac_results
// 完全性検証）。判断（targeted evaluator の起動・prompt 構築・agent 呼び出し）は workflow
// 側が担い、本ファイルは pure 関数のみを提供する。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。

// telemetry final_ac_reconcile の 3 値。
export const FINAL_AC_RECONCILE_VALUES = ['skipped', 'reverified', 'unavailable'];

// Final AC reconcile を実行すべきかを判定する純粋関数。
//
// 判定順（最初に該当した reason を返す）:
//   1. fixesApplied が数値でない/<=0        → no_fixes
//   2. runEval !== true                      → eval_skipped（micro path は Evaluate 0 回）
//   3. acCount が正整数でない                → no_ac（AC 0 件で agent を起動しない）
//   4. finalReconcile が 'reverified' でも 'ci_verified' でもない
//      → final_test_unavailable（ci_verified は sync 成功 = worktree が PR 最終 HEAD、かつ
//        CI で test 状態検証済みのため reverified と同様に AC 再検証へ進む。issue #599）
//   5. finalTestGreen === false              → final_test_red
//   6. それ以外（true または null=no_tests） → run:true
export function shouldRunFinalAcReconcile({ fixesApplied, finalReconcile, finalTestGreen, runEval, acCount }) {
  if (typeof fixesApplied !== 'number' || !Number.isFinite(fixesApplied) || fixesApplied <= 0) {
    return { run: false, reason: 'no_fixes' };
  }
  if (runEval !== true) {
    return { run: false, reason: 'eval_skipped' };
  }
  if (!(Number.isInteger(acCount) && acCount > 0)) {
    return { run: false, reason: 'no_ac' };
  }
  if (finalReconcile !== 'reverified' && finalReconcile !== 'ci_verified') {
    return { run: false, reason: 'final_test_unavailable' };
  }
  if (finalTestGreen === false) {
    return { run: false, reason: 'final_test_red' };
  }
  return { run: true, reason: 'ok' };
}

// Final AC reconcile agent の出力（ac_results 配列）を fail-closed で検証する純粋関数。
// 入力を mutate しない。
//
// 検証規則（最初に落ちた規則の reason を返す）:
//   (a) acCount が 1 以上の整数でない       → invalid_ac_count
//   (b) acResults が配列でない              → not_array
//   (c) acResults.length !== acCount        → count_mismatch
//   (d) 各要素が object でない/null         → invalid_item
//   (e) ac_index が非整数/範囲外            → index_out_of_range
//   (f) ac_index 重複                       → index_duplicate
//   (g) satisfied が boolean でない         → invalid_satisfied
//   (h) evidence が非空文字列でない         → empty_evidence
//
// 成功時は ac_index 昇順に sort した shallow copy 配列と、satisfied!==true の
// ac_index 昇順配列（unsatisfiedIndexes）を返す。
export function validateFinalAcResults(acResults, acCount) {
  if (!(Number.isInteger(acCount) && acCount >= 1)) {
    return { ok: false, reason: 'invalid_ac_count' };
  }
  if (!Array.isArray(acResults)) {
    return { ok: false, reason: 'not_array' };
  }
  if (acResults.length !== acCount) {
    return { ok: false, reason: 'count_mismatch' };
  }

  const seenIndexes = new Set();
  for (const item of acResults) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return { ok: false, reason: 'invalid_item' };
    }
    const { ac_index: acIndex, satisfied, evidence } = item;
    if (!(Number.isInteger(acIndex) && acIndex >= 0 && acIndex < acCount)) {
      return { ok: false, reason: 'index_out_of_range' };
    }
    if (seenIndexes.has(acIndex)) {
      return { ok: false, reason: 'index_duplicate' };
    }
    seenIndexes.add(acIndex);
    if (typeof satisfied !== 'boolean') {
      return { ok: false, reason: 'invalid_satisfied' };
    }
    if (typeof evidence !== 'string' || evidence.trim().length === 0) {
      return { ok: false, reason: 'empty_evidence' };
    }
  }

  const results = acResults
    .map((item) => ({ ...item }))
    .sort((a, b) => a.ac_index - b.ac_index);
  const unsatisfiedIndexes = results
    .filter((item) => item.satisfied !== true)
    .map((item) => item.ac_index);

  return { ok: true, results, unsatisfiedIndexes };
}

// Final AC reconcile の後に最終 tree で redgreen-verify（label 'redgreen-final'）にかける ac_results 要素を返す純粋関数
// （issue #1146）。入力を mutate しない。
//
// 観測型 AC は red→green 実証（deterministic 昇格）でしか達成扱いにしない。Evaluate で実証できなかった AC でも、
// pr-iterate の fix がテストを直して最終 tree で red→green が成立していれば実証の機会を与える。inspection の
// satisfied:true は対象にしない（evaluator のコード読みで観測型 AC を達成扱いにしない）。
//
// 対象（全条件を満たす要素。ac_index 昇順の validateFinalAcResults の results 順を保つ）:
//   - ac_index が整数で ciIndexes に含まれない（ci の AC は CI の結果で決める）
//   - observational[ac_index] === true かつ provenIndexes に含まれない（Evaluate で昇格済みの AC は再実行しない）
//   - satisfied === true・verified_by === 'test'・test_files / impl_files が空でない配列
export function finalRedgreenTargets({ results, observational, provenIndexes, ciIndexes }) {
  const obs = Array.isArray(observational) ? observational : [];
  const proven = Array.isArray(provenIndexes) ? provenIndexes : [];
  const ci = Array.isArray(ciIndexes) ? ciIndexes : [];
  return (Array.isArray(results) ? results : []).filter((r) => r
    && Number.isInteger(r.ac_index) && !ci.includes(r.ac_index)
    && obs[r.ac_index] === true && !proven.includes(r.ac_index)
    && r.satisfied === true && r.verified_by === 'test'
    && Array.isArray(r.test_files) && r.test_files.length > 0
    && Array.isArray(r.impl_files) && r.impl_files.length > 0);
}

// goal-ledger item の final_resolution の 3 値 enum（issue #658）。
export const FINAL_ITEM_RESOLUTIONS = ['resolved', 'ci_delegated', 'unresolved'];

// Final AC reconcile evaluator が返す item_resolutions[]（ESCALATE / advisory item の「fix 後 tree
// での再評価結果」）を fail-open で要素ごとに検証する純粋関数。入力を mutate しない。
//
// ac_results（validateFinalAcResults）は fail-closed（1 件でも不正なら全体 unavailable）だが、
// item_resolutions は表示専用（ledger の checked / merge tier / HOLD 判定を変えない）のため、
// 不正な要素だけを reject して有効な要素は採用する fail-open にする。表示のための任意情報が
// 1 件不正なだけで再評価結果全体を捨てる理由がない。
//
// 返り値 { accepted: Array<{id, resolution, evidence}>, rejected: Array<{index, reason}> }
// accepted は入力順。
export function validateFinalItemResolutions(resolutions, targetIds) {
  if (resolutions === null || resolutions === undefined) {
    return { accepted: [], rejected: [] };
  }
  if (!Array.isArray(resolutions)) {
    return { accepted: [], rejected: [{ index: -1, reason: 'not_array' }] };
  }

  const accepted = [];
  const rejected = [];
  const seenIds = new Set();

  resolutions.forEach((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      rejected.push({ index, reason: 'invalid_item' });
      return;
    }
    const { id, resolution, evidence } = item;
    if (typeof id !== 'string' || !targetIds.includes(id)) {
      rejected.push({ index, reason: 'unknown_id' });
      return;
    }
    if (seenIds.has(id)) {
      rejected.push({ index, reason: 'duplicate_id' });
      return;
    }
    seenIds.add(id);
    if (!FINAL_ITEM_RESOLUTIONS.includes(resolution)) {
      rejected.push({ index, reason: 'invalid_resolution' });
      return;
    }
    const hasEvidence = typeof evidence === 'string' && evidence.trim().length > 0;
    if ((resolution === 'resolved' || resolution === 'ci_delegated') && !hasEvidence) {
      rejected.push({ index, reason: 'empty_evidence' });
      return;
    }
    accepted.push({ id, resolution, evidence: hasEvidence ? evidence : null });
  });

  return { accepted, rejected };
}

// fix 後の最終 tree に対する決定論の検証が成立した run で、未 checked の EVAL-* blocking item を
// 解消する id と evidence を返す純粋関数（issue #720）。入力を mutate しない。
//
// standard は Evaluate 1 パスで、EVAL-* を checked にできる evaluator（critical_resolutions）は
// pr-iterate の fix 後に再実行されない。fix で直った critical が ledger 未収束の HOLD に残り続けるため、
// fix 後 tree の test#final green（head sha に pin）または CI 委譲（ci_verified）を決定論の根拠に解消する。
// LLM 判断（final_resolution）は根拠にしない（blocking を LLM 判断で解消しない規則は不変）。
//
// 判定順（最初に該当した reason を返す。ok 以外は ids 空）:
//   1. fixesApplied が数値でない/<=0                                    → no_fixes
//   2. finalReconcile==='reverified' かつ finalTestGreen===true かつ headSha 非空
//      → ok（evidence `test#final green @ <headSha>`）
//   3. finalReconcile==='ci_verified' かつ finalCi.verified===true
//      → ok（evidence `ci_verified: <check 名, ...>`）
//   4. それ以外（red / no_tests / unavailable / skipped / head sha 不明） → not_verified
//
// 対象は blockingItems のうち id が 'EVAL-' で始まり source==='evaluator' の未 checked item のみ。
// escalate item は当事者性で人間判断を要求する機構で test green では解消しないため除外する。
// SEC / TESTSURF（source:'seed'）・AC-FINAL-*（id 接頭辞が異なる）はこの経路で解消しない。
export function finalEvalBlockingResolutions({ fixesApplied, finalReconcile, finalTestGreen, headSha, finalCi, blockingItems }) {
  if (typeof fixesApplied !== 'number' || !Number.isFinite(fixesApplied) || fixesApplied <= 0) {
    return { reason: 'no_fixes', evidence: null, ids: [] };
  }
  let evidence = null;
  if (finalReconcile === 'reverified' && finalTestGreen === true && typeof headSha === 'string' && headSha.length > 0) {
    evidence = `test#final green @ ${headSha}`;
  } else if (finalReconcile === 'ci_verified' && finalCi && finalCi.verified === true) {
    evidence = `ci_verified: ${(Array.isArray(finalCi.checkNames) ? finalCi.checkNames : []).join(', ')}`;
  } else {
    return { reason: 'not_verified', evidence: null, ids: [] };
  }
  const ids = (Array.isArray(blockingItems) ? blockingItems : [])
    .filter((it) => it && typeof it.id === 'string' && it.id.startsWith('EVAL-')
      && it.source === 'evaluator' && it.checked !== true && it.escalate !== true)
    .map((it) => it.id);
  return { reason: 'ok', evidence, ids };
}
