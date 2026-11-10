import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  FINAL_AC_RECONCILE_VALUES,
  shouldRunFinalAcReconcile,
  validateFinalAcResults,
  FINAL_ITEM_RESOLUTIONS,
  validateFinalItemResolutions,
  finalRedgreenTargets,
} from './final-ac-reconcile.mjs';

// ---- (1) FINAL_AC_RECONCILE_VALUES ----

test('FINAL_AC_RECONCILE_VALUES は skipped/reverified/unavailable の 3 値配列', () => {
  assert.deepEqual(FINAL_AC_RECONCILE_VALUES, ['skipped', 'reverified', 'unavailable']);
});

// ---- (2) shouldRunFinalAcReconcile ----

test('shouldRunFinalAcReconcile: fixesApplied=0 → no_fixes', () => {
  const result = shouldRunFinalAcReconcile({
    fixesApplied: 0,
    finalReconcile: 'reverified',
    finalTestGreen: true,
    acCount: 2,
  });
  assert.deepEqual(result, { run: false, reason: 'no_fixes' });
});

test('shouldRunFinalAcReconcile: fixesApplied が数値でない → no_fixes', () => {
  const result = shouldRunFinalAcReconcile({
    fixesApplied: null,
    finalReconcile: 'reverified',
    finalTestGreen: true,
    acCount: 2,
  });
  assert.deepEqual(result, { run: false, reason: 'no_fixes' });
});

test('shouldRunFinalAcReconcile: fixesApplied が負数 → no_fixes', () => {
  const result = shouldRunFinalAcReconcile({
    fixesApplied: -1,
    finalReconcile: 'reverified',
    finalTestGreen: true,
    acCount: 2,
  });
  assert.deepEqual(result, { run: false, reason: 'no_fixes' });
});

test('shouldRunFinalAcReconcile: 入力に shape・Evaluate の有無は無く、runEval:false を渡しても fix 適用時は run:true（micro でも走る）', () => {
  const result = shouldRunFinalAcReconcile({
    fixesApplied: 3,
    finalReconcile: 'reverified',
    finalTestGreen: true,
    runEval: false,
    acCount: 2,
  });
  assert.deepEqual(result, { run: true, reason: 'ok' });
});

test('shouldRunFinalAcReconcile: acCount=0 → no_ac', () => {
  const result = shouldRunFinalAcReconcile({
    fixesApplied: 3,
    finalReconcile: 'reverified',
    finalTestGreen: true,
    acCount: 0,
  });
  assert.deepEqual(result, { run: false, reason: 'no_ac' });
});

test('shouldRunFinalAcReconcile: acCount が非整数 → no_ac', () => {
  const result = shouldRunFinalAcReconcile({
    fixesApplied: 3,
    finalReconcile: 'reverified',
    finalTestGreen: true,
    acCount: 1.5,
  });
  assert.deepEqual(result, { run: false, reason: 'no_ac' });
});

test('shouldRunFinalAcReconcile: acCount が負数 → no_ac', () => {
  const result = shouldRunFinalAcReconcile({
    fixesApplied: 3,
    finalReconcile: 'reverified',
    finalTestGreen: true,
    acCount: -2,
  });
  assert.deepEqual(result, { run: false, reason: 'no_ac' });
});

test('shouldRunFinalAcReconcile: acCount=2 + finalReconcile=unavailable → final_test_unavailable', () => {
  const result = shouldRunFinalAcReconcile({
    fixesApplied: 3,
    finalReconcile: 'unavailable',
    finalTestGreen: null,
    acCount: 2,
  });
  assert.deepEqual(result, { run: false, reason: 'final_test_unavailable' });
});

test('shouldRunFinalAcReconcile: finalReconcile=skipped → final_test_unavailable', () => {
  const result = shouldRunFinalAcReconcile({
    fixesApplied: 3,
    finalReconcile: 'skipped',
    finalTestGreen: null,
    acCount: 2,
  });
  assert.deepEqual(result, { run: false, reason: 'final_test_unavailable' });
});

test('shouldRunFinalAcReconcile: finalTestGreen=false → final_test_red', () => {
  const result = shouldRunFinalAcReconcile({
    fixesApplied: 3,
    finalReconcile: 'reverified',
    finalTestGreen: false,
    acCount: 2,
  });
  assert.deepEqual(result, { run: false, reason: 'final_test_red' });
});

test('shouldRunFinalAcReconcile: finalTestGreen=null(no_tests) + reverified → run:true', () => {
  const result = shouldRunFinalAcReconcile({
    fixesApplied: 3,
    finalReconcile: 'reverified',
    finalTestGreen: null,
    acCount: 2,
  });
  assert.deepEqual(result, { run: true, reason: 'ok' });
});

test('shouldRunFinalAcReconcile: finalTestGreen=true → run:true', () => {
  const result = shouldRunFinalAcReconcile({
    fixesApplied: 1,
    finalReconcile: 'reverified',
    finalTestGreen: true,
    acCount: 5,
  });
  assert.deepEqual(result, { run: true, reason: 'ok' });
});

// ---- (2b) shouldRunFinalAcReconcile: 'reverified' 以外は final_test_unavailable (issue #1168) ----
// PR の CI の success で最終 tree の test 状態を代替しない — 撤去した 'ci_verified' を含め、
// 最終 tree を再検証していない値はどれも AC 再検証へ進まない。

test('shouldRunFinalAcReconcile: finalReconcile が reverified 以外（ci_verified / unavailable / skipped / null）→ finalTestGreen に依らず final_test_unavailable', () => {
  for (const finalReconcile of ['ci_verified', 'unavailable', 'skipped', null, undefined]) {
    for (const finalTestGreen of [true, null]) {
      const result = shouldRunFinalAcReconcile({ fixesApplied: 1, finalReconcile, finalTestGreen, acCount: 2 });
      assert.deepEqual(result, { run: false, reason: 'final_test_unavailable' }, `${finalReconcile} / ${finalTestGreen}`);
    }
  }
});

// ---- (3) validateFinalAcResults ----

test('validateFinalAcResults: 正常 2 件（順不同入力が sort されて返る + unsatisfiedIndexes 抽出）', () => {
  const input = [
    { ac_index: 1, satisfied: false, evidence: 'not satisfied' },
    { ac_index: 0, satisfied: true, evidence: 'satisfied fully' },
  ];
  const result = validateFinalAcResults(input, 2);
  assert.equal(result.ok, true);
  assert.deepEqual(result.results, [
    { ac_index: 0, satisfied: true, evidence: 'satisfied fully' },
    { ac_index: 1, satisfied: false, evidence: 'not satisfied' },
  ]);
  assert.deepEqual(result.unsatisfiedIndexes, [1]);
});

test('validateFinalAcResults: 入力配列を mutate しない', () => {
  const input = [
    { ac_index: 1, satisfied: false, evidence: 'not satisfied' },
    { ac_index: 0, satisfied: true, evidence: 'satisfied fully' },
  ];
  const inputCopy = JSON.parse(JSON.stringify(input));
  validateFinalAcResults(input, 2);
  assert.deepEqual(input, inputCopy);
});

test('validateFinalAcResults: acResults=null → not_array', () => {
  const result = validateFinalAcResults(null, 2);
  assert.deepEqual(result, { ok: false, reason: 'not_array' });
});

test('validateFinalAcResults: acResults がオブジェクト → not_array', () => {
  const result = validateFinalAcResults({}, 2);
  assert.deepEqual(result, { ok: false, reason: 'not_array' });
});

test('validateFinalAcResults: 件数不足 → count_mismatch', () => {
  const result = validateFinalAcResults(
    [{ ac_index: 0, satisfied: true, evidence: 'ok' }],
    2,
  );
  assert.deepEqual(result, { ok: false, reason: 'count_mismatch' });
});

test('validateFinalAcResults: 件数過剰 → count_mismatch', () => {
  const result = validateFinalAcResults(
    [
      { ac_index: 0, satisfied: true, evidence: 'ok' },
      { ac_index: 1, satisfied: true, evidence: 'ok' },
      { ac_index: 2, satisfied: true, evidence: 'ok' },
    ],
    2,
  );
  assert.deepEqual(result, { ok: false, reason: 'count_mismatch' });
});

test('validateFinalAcResults: 要素が object でない → invalid_item', () => {
  const result = validateFinalAcResults(['not-an-object', { ac_index: 1, satisfied: true, evidence: 'ok' }], 2);
  assert.deepEqual(result, { ok: false, reason: 'invalid_item' });
});

test('validateFinalAcResults: 要素が null → invalid_item', () => {
  const result = validateFinalAcResults([null, { ac_index: 1, satisfied: true, evidence: 'ok' }], 2);
  assert.deepEqual(result, { ok: false, reason: 'invalid_item' });
});

test('validateFinalAcResults: ac_index が非整数 → index_out_of_range', () => {
  const result = validateFinalAcResults(
    [
      { ac_index: 0.5, satisfied: true, evidence: 'ok' },
      { ac_index: 1, satisfied: true, evidence: 'ok' },
    ],
    2,
  );
  assert.deepEqual(result, { ok: false, reason: 'index_out_of_range' });
});

test('validateFinalAcResults: ac_index が負数 → index_out_of_range', () => {
  const result = validateFinalAcResults(
    [
      { ac_index: -1, satisfied: true, evidence: 'ok' },
      { ac_index: 1, satisfied: true, evidence: 'ok' },
    ],
    2,
  );
  assert.deepEqual(result, { ok: false, reason: 'index_out_of_range' });
});

test('validateFinalAcResults: ac_index が acCount 以上 → index_out_of_range', () => {
  const result = validateFinalAcResults(
    [
      { ac_index: 0, satisfied: true, evidence: 'ok' },
      { ac_index: 2, satisfied: true, evidence: 'ok' },
    ],
    2,
  );
  assert.deepEqual(result, { ok: false, reason: 'index_out_of_range' });
});

test('validateFinalAcResults: ac_index 重複 → index_duplicate', () => {
  const result = validateFinalAcResults(
    [
      { ac_index: 0, satisfied: true, evidence: 'ok' },
      { ac_index: 0, satisfied: false, evidence: 'dup' },
    ],
    2,
  );
  assert.deepEqual(result, { ok: false, reason: 'index_duplicate' });
});

test('validateFinalAcResults: satisfied 欠落 → invalid_satisfied', () => {
  const result = validateFinalAcResults(
    [
      { ac_index: 0, evidence: 'ok' },
      { ac_index: 1, satisfied: true, evidence: 'ok' },
    ],
    2,
  );
  assert.deepEqual(result, { ok: false, reason: 'invalid_satisfied' });
});

test('validateFinalAcResults: satisfied が boolean でない → invalid_satisfied', () => {
  const result = validateFinalAcResults(
    [
      { ac_index: 0, satisfied: 'true', evidence: 'ok' },
      { ac_index: 1, satisfied: true, evidence: 'ok' },
    ],
    2,
  );
  assert.deepEqual(result, { ok: false, reason: 'invalid_satisfied' });
});

test('validateFinalAcResults: evidence 空文字 → empty_evidence', () => {
  const result = validateFinalAcResults(
    [
      { ac_index: 0, satisfied: true, evidence: '' },
      { ac_index: 1, satisfied: true, evidence: 'ok' },
    ],
    2,
  );
  assert.deepEqual(result, { ok: false, reason: 'empty_evidence' });
});

test('validateFinalAcResults: evidence 空白のみ → empty_evidence', () => {
  const result = validateFinalAcResults(
    [
      { ac_index: 0, satisfied: true, evidence: '   ' },
      { ac_index: 1, satisfied: true, evidence: 'ok' },
    ],
    2,
  );
  assert.deepEqual(result, { ok: false, reason: 'empty_evidence' });
});

test('validateFinalAcResults: evidence 欠落（非string）→ empty_evidence', () => {
  const result = validateFinalAcResults(
    [
      { ac_index: 0, satisfied: false },
      { ac_index: 1, satisfied: true, evidence: 'ok' },
    ],
    2,
  );
  assert.deepEqual(result, { ok: false, reason: 'empty_evidence' });
});

test('validateFinalAcResults: satisfied=false でも evidence 必須（空だと empty_evidence）', () => {
  const result = validateFinalAcResults(
    [
      { ac_index: 0, satisfied: false, evidence: '' },
    ],
    1,
  );
  assert.deepEqual(result, { ok: false, reason: 'empty_evidence' });
});

test('validateFinalAcResults: acCount=0 → invalid_ac_count', () => {
  const result = validateFinalAcResults([], 0);
  assert.deepEqual(result, { ok: false, reason: 'invalid_ac_count' });
});

test('validateFinalAcResults: acCount が非整数 → invalid_ac_count', () => {
  const result = validateFinalAcResults(
    [{ ac_index: 0, satisfied: true, evidence: 'ok' }],
    1.5,
  );
  assert.deepEqual(result, { ok: false, reason: 'invalid_ac_count' });
});

test('validateFinalAcResults: acCount が負数 → invalid_ac_count', () => {
  const result = validateFinalAcResults([], -1);
  assert.deepEqual(result, { ok: false, reason: 'invalid_ac_count' });
});

test('validateFinalAcResults: 全件 satisfied:true → unsatisfiedIndexes は空配列', () => {
  const result = validateFinalAcResults(
    [
      { ac_index: 0, satisfied: true, evidence: 'a' },
      { ac_index: 1, satisfied: true, evidence: 'b' },
      { ac_index: 2, satisfied: true, evidence: 'c' },
    ],
    3,
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.unsatisfiedIndexes, []);
});

// ---- (4) FINAL_ITEM_RESOLUTIONS / validateFinalItemResolutions (issue #658) ----

test('FINAL_ITEM_RESOLUTIONS は resolved/unresolved の 2 値配列', () => {
  assert.deepEqual(FINAL_ITEM_RESOLUTIONS, ['resolved', 'unresolved']);
});

test('validateFinalItemResolutions: null 入力 → accepted:[] rejected:[]', () => {
  assert.deepEqual(validateFinalItemResolutions(null, ['A']), { accepted: [], rejected: [] });
});
test('validateFinalItemResolutions: undefined 入力 → accepted:[] rejected:[]', () => {
  assert.deepEqual(validateFinalItemResolutions(undefined, ['A']), { accepted: [], rejected: [] });
});
test('validateFinalItemResolutions: 配列でない → not_array', () => {
  assert.deepEqual(validateFinalItemResolutions({ id: 'A' }, ['A']), {
    accepted: [],
    rejected: [{ index: -1, reason: 'not_array' }],
  });
});
test('validateFinalItemResolutions: 要素が object でない → invalid_item', () => {
  const result = validateFinalItemResolutions(['not-an-object'], ['A']);
  assert.deepEqual(result, { accepted: [], rejected: [{ index: 0, reason: 'invalid_item' }] });
});
test('validateFinalItemResolutions: 要素が null → invalid_item', () => {
  const result = validateFinalItemResolutions([null], ['A']);
  assert.deepEqual(result, { accepted: [], rejected: [{ index: 0, reason: 'invalid_item' }] });
});
test('validateFinalItemResolutions: 要素が配列 → invalid_item', () => {
  const result = validateFinalItemResolutions([['A', 'resolved', 'e']], ['A']);
  assert.deepEqual(result, { accepted: [], rejected: [{ index: 0, reason: 'invalid_item' }] });
});
test('validateFinalItemResolutions: 未知 id → unknown_id', () => {
  const result = validateFinalItemResolutions(
    [{ id: 'ESCALATE-9', resolution: 'resolved', evidence: 'commit abc' }],
    ['ESCALATE-1'],
  );
  assert.deepEqual(result, { accepted: [], rejected: [{ index: 0, reason: 'unknown_id' }] });
});
test('validateFinalItemResolutions: 同 id 2 回目以降 → duplicate_id', () => {
  const result = validateFinalItemResolutions(
    [
      { id: 'ESCALATE-1', resolution: 'resolved', evidence: 'commit abc' },
      { id: 'ESCALATE-1', resolution: 'unresolved', evidence: null },
    ],
    ['ESCALATE-1'],
  );
  assert.deepEqual(result.accepted, [{ id: 'ESCALATE-1', resolution: 'resolved', evidence: 'commit abc' }]);
  assert.deepEqual(result.rejected, [{ index: 1, reason: 'duplicate_id' }]);
});
test('validateFinalItemResolutions: enum 外 resolution（撤去した ci_delegated を含む）→ invalid_resolution', () => {
  for (const resolution of ['partially', 'ci_delegated']) {
    const result = validateFinalItemResolutions(
      [{ id: 'A', resolution, evidence: 'PR CI の e2e check' }],
      ['A'],
    );
    assert.deepEqual(result, { accepted: [], rejected: [{ index: 0, reason: 'invalid_resolution' }] }, resolution);
  }
});
test('validateFinalItemResolutions: resolved で evidence 欠落 → empty_evidence', () => {
  const result = validateFinalItemResolutions([{ id: 'A', resolution: 'resolved' }], ['A']);
  assert.deepEqual(result, { accepted: [], rejected: [{ index: 0, reason: 'empty_evidence' }] });
});
test('validateFinalItemResolutions: resolved で evidence 空白のみ → empty_evidence', () => {
  const result = validateFinalItemResolutions(
    [{ id: 'A', resolution: 'resolved', evidence: '   ' }],
    ['A'],
  );
  assert.deepEqual(result, { accepted: [], rejected: [{ index: 0, reason: 'empty_evidence' }] });
});
test('validateFinalItemResolutions: unresolved は evidence 任意（非 string は null に正規化）', () => {
  const result = validateFinalItemResolutions([{ id: 'A', resolution: 'unresolved' }], ['A']);
  assert.deepEqual(result, { accepted: [{ id: 'A', resolution: 'unresolved', evidence: null }], rejected: [] });
});
test('validateFinalItemResolutions: unresolved で evidence に非 string を渡しても null 正規化', () => {
  const result = validateFinalItemResolutions([{ id: 'A', resolution: 'unresolved', evidence: 123 }], ['A']);
  assert.deepEqual(result, { accepted: [{ id: 'A', resolution: 'unresolved', evidence: null }], rejected: [] });
});
test('validateFinalItemResolutions: accepted は入力順（複数件・混在）', () => {
  const result = validateFinalItemResolutions(
    [
      { id: 'B', resolution: 'unresolved', evidence: 'ローカルで e2e を実行できず' },
      { id: 'A', resolution: 'resolved', evidence: 'commit abc revert 済み' },
      { id: 'C', resolution: 'unknown-enum', evidence: 'x' },
    ],
    ['A', 'B', 'C'],
  );
  assert.deepEqual(result.accepted, [
    { id: 'B', resolution: 'unresolved', evidence: 'ローカルで e2e を実行できず' },
    { id: 'A', resolution: 'resolved', evidence: 'commit abc revert 済み' },
  ]);
  assert.deepEqual(result.rejected, [{ index: 2, reason: 'invalid_resolution' }]);
});
test('validateFinalItemResolutions: 入力配列を mutate しない', () => {
  const input = [{ id: 'A', resolution: 'resolved', evidence: 'e' }];
  const inputCopy = JSON.parse(JSON.stringify(input));
  validateFinalItemResolutions(input, ['A']);
  assert.deepEqual(input, inputCopy);
});

// ---- finalRedgreenTargets（issue #1146）----

const byTestAc = (i, extra = {}) => ({ ac_index: i, satisfied: true, verified_by: 'test', evidence: 'ok', test_files: ['t.test.mjs'], impl_files: ['x.mjs'], ...extra });

test('finalRedgreenTargets: 観測型・未昇格・ci 以外で satisfied:true + verified_by:test + 空でない test_files / impl_files の要素だけを順に返す', () => {
  const results = [
    byTestAc(0),                                            // 対象
    byTestAc(1),                                            // 観測型でない
    byTestAc(2),                                            // Evaluate で昇格済み
    byTestAc(3),                                            // ci の AC
    byTestAc(4, { verified_by: 'inspection' }),             // inspection
    byTestAc(5, { satisfied: false }),                      // 未達
    byTestAc(6, { test_files: [] }),                        // test_files 空
    byTestAc(7, { impl_files: undefined }),                 // impl_files 欠落
    byTestAc(8),                                            // 対象
  ];
  const observational = [true, false, true, true, true, true, true, true, true];
  const out = finalRedgreenTargets({ results, observational, provenIndexes: [2], ciIndexes: [3] });
  assert.deepEqual(out.map((r) => r.ac_index), [0, 8]);
  assert.equal(out[0], results[0], '要素は写さずそのまま返す（buildRedgreenPairs に渡す ac_results 要素）');
});

test('finalRedgreenTargets: observational / results が配列でなければ空', () => {
  assert.deepEqual(finalRedgreenTargets({ results: [byTestAc(0)], observational: null, provenIndexes: [], ciIndexes: [] }), []);
  assert.deepEqual(finalRedgreenTargets({ results: null, observational: [true], provenIndexes: [], ciIndexes: [] }), []);
});
