import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  FINAL_AC_RECONCILE_VALUES,
  shouldRunFinalAcReconcile,
  validateFinalAcResults,
  FINAL_ITEM_RESOLUTIONS,
  validateFinalItemResolutions,
  finalEvalBlockingResolutions,
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
    runEval: true,
    acCount: 2,
  });
  assert.deepEqual(result, { run: false, reason: 'no_fixes' });
});

test('shouldRunFinalAcReconcile: fixesApplied が数値でない → no_fixes', () => {
  const result = shouldRunFinalAcReconcile({
    fixesApplied: null,
    finalReconcile: 'reverified',
    finalTestGreen: true,
    runEval: true,
    acCount: 2,
  });
  assert.deepEqual(result, { run: false, reason: 'no_fixes' });
});

test('shouldRunFinalAcReconcile: fixesApplied が負数 → no_fixes', () => {
  const result = shouldRunFinalAcReconcile({
    fixesApplied: -1,
    finalReconcile: 'reverified',
    finalTestGreen: true,
    runEval: true,
    acCount: 2,
  });
  assert.deepEqual(result, { run: false, reason: 'no_fixes' });
});

test('shouldRunFinalAcReconcile: runEval !== true → eval_skipped (micro path)', () => {
  const result = shouldRunFinalAcReconcile({
    fixesApplied: 3,
    finalReconcile: 'reverified',
    finalTestGreen: true,
    runEval: false,
    acCount: 2,
  });
  assert.deepEqual(result, { run: false, reason: 'eval_skipped' });
});

test('shouldRunFinalAcReconcile: acCount=0 → no_ac', () => {
  const result = shouldRunFinalAcReconcile({
    fixesApplied: 3,
    finalReconcile: 'reverified',
    finalTestGreen: true,
    runEval: true,
    acCount: 0,
  });
  assert.deepEqual(result, { run: false, reason: 'no_ac' });
});

test('shouldRunFinalAcReconcile: acCount が非整数 → no_ac', () => {
  const result = shouldRunFinalAcReconcile({
    fixesApplied: 3,
    finalReconcile: 'reverified',
    finalTestGreen: true,
    runEval: true,
    acCount: 1.5,
  });
  assert.deepEqual(result, { run: false, reason: 'no_ac' });
});

test('shouldRunFinalAcReconcile: acCount が負数 → no_ac', () => {
  const result = shouldRunFinalAcReconcile({
    fixesApplied: 3,
    finalReconcile: 'reverified',
    finalTestGreen: true,
    runEval: true,
    acCount: -2,
  });
  assert.deepEqual(result, { run: false, reason: 'no_ac' });
});

test('shouldRunFinalAcReconcile: acCount=2 + finalReconcile=unavailable → final_test_unavailable', () => {
  const result = shouldRunFinalAcReconcile({
    fixesApplied: 3,
    finalReconcile: 'unavailable',
    finalTestGreen: null,
    runEval: true,
    acCount: 2,
  });
  assert.deepEqual(result, { run: false, reason: 'final_test_unavailable' });
});

test('shouldRunFinalAcReconcile: finalReconcile=skipped → final_test_unavailable', () => {
  const result = shouldRunFinalAcReconcile({
    fixesApplied: 3,
    finalReconcile: 'skipped',
    finalTestGreen: null,
    runEval: true,
    acCount: 2,
  });
  assert.deepEqual(result, { run: false, reason: 'final_test_unavailable' });
});

test('shouldRunFinalAcReconcile: finalTestGreen=false → final_test_red', () => {
  const result = shouldRunFinalAcReconcile({
    fixesApplied: 3,
    finalReconcile: 'reverified',
    finalTestGreen: false,
    runEval: true,
    acCount: 2,
  });
  assert.deepEqual(result, { run: false, reason: 'final_test_red' });
});

test('shouldRunFinalAcReconcile: finalTestGreen=null(no_tests) + reverified → run:true', () => {
  const result = shouldRunFinalAcReconcile({
    fixesApplied: 3,
    finalReconcile: 'reverified',
    finalTestGreen: null,
    runEval: true,
    acCount: 2,
  });
  assert.deepEqual(result, { run: true, reason: 'ok' });
});

test('shouldRunFinalAcReconcile: finalTestGreen=true → run:true', () => {
  const result = shouldRunFinalAcReconcile({
    fixesApplied: 1,
    finalReconcile: 'reverified',
    finalTestGreen: true,
    runEval: true,
    acCount: 5,
  });
  assert.deepEqual(result, { run: true, reason: 'ok' });
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

test('FINAL_ITEM_RESOLUTIONS は resolved/ci_delegated/unresolved の 3 値配列', () => {
  assert.deepEqual(FINAL_ITEM_RESOLUTIONS, ['resolved', 'ci_delegated', 'unresolved']);
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
test('validateFinalItemResolutions: enum 外 resolution → invalid_resolution', () => {
  const result = validateFinalItemResolutions(
    [{ id: 'A', resolution: 'partially', evidence: 'e' }],
    ['A'],
  );
  assert.deepEqual(result, { accepted: [], rejected: [{ index: 0, reason: 'invalid_resolution' }] });
});
test('validateFinalItemResolutions: resolved で evidence 欠落 → empty_evidence', () => {
  const result = validateFinalItemResolutions([{ id: 'A', resolution: 'resolved' }], ['A']);
  assert.deepEqual(result, { accepted: [], rejected: [{ index: 0, reason: 'empty_evidence' }] });
});
test('validateFinalItemResolutions: ci_delegated で evidence 空白のみ → empty_evidence', () => {
  const result = validateFinalItemResolutions(
    [{ id: 'A', resolution: 'ci_delegated', evidence: '   ' }],
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
      { id: 'B', resolution: 'ci_delegated', evidence: 'PR CI の e2e check' },
      { id: 'A', resolution: 'resolved', evidence: 'commit abc revert 済み' },
      { id: 'C', resolution: 'unknown-enum', evidence: 'x' },
    ],
    ['A', 'B', 'C'],
  );
  assert.deepEqual(result.accepted, [
    { id: 'B', resolution: 'ci_delegated', evidence: 'PR CI の e2e check' },
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

// ---- (5) finalEvalBlockingResolutions (issue #720) ----

const SHA = 'f'.repeat(40);
const EVAL_OPEN = { id: 'EVAL-1-vitest-regression', source: 'evaluator', severity: 'critical', checked: false };
const MIXED_BLOCKING = [
  EVAL_OPEN,
  { id: 'EVAL-1-already-done', source: 'evaluator', severity: 'critical', checked: true },
  { id: 'EVAL-1-escalated', source: 'evaluator', severity: 'critical', checked: false, escalate: true },
  { id: 'SEC-SECRETS', source: 'seed', dimension: 'security', severity: 'critical', checked: false },
  { id: 'TESTSURF-SKIP', source: 'seed', dimension: 'test-integrity', severity: 'critical', checked: false },
  { id: 'AC-FINAL-1', source: 'evaluator', dimension: 'ac', severity: 'critical', checked: false },
  { id: 'AC-1', source: 'ac', dimension: 'ac', severity: 'critical', checked: false },
];
const GREEN_RUN = { fixesApplied: 1, finalReconcile: 'reverified', finalTestGreen: true, headSha: SHA };

test('finalEvalBlockingResolutions: reverified + test#final green → 未 checked EVAL-* のみ test#final green @ sha で解消', () => {
  const r = finalEvalBlockingResolutions({ ...GREEN_RUN, blockingItems: MIXED_BLOCKING });
  assert.deepEqual(r, { reason: 'ok', evidence: `test#final green @ ${SHA}`, ids: ['EVAL-1-vitest-regression'] });
});
test('finalEvalBlockingResolutions: SEC seed / TESTSURF / AC-FINAL-* / AC-* / escalate / checked 済みは対象外', () => {
  const r = finalEvalBlockingResolutions({ ...GREEN_RUN, blockingItems: MIXED_BLOCKING });
  for (const id of ['SEC-SECRETS', 'TESTSURF-SKIP', 'AC-FINAL-1', 'AC-1', 'EVAL-1-escalated', 'EVAL-1-already-done']) {
    assert.ok(!r.ids.includes(id), `${id} は解消対象になってはならない`);
  }
});
test('finalEvalBlockingResolutions: EVAL- 接頭辞でも source が evaluator 以外なら対象外', () => {
  const r = finalEvalBlockingResolutions({ ...GREEN_RUN, blockingItems: [{ id: 'EVAL-X', source: 'seed', checked: false }] });
  assert.deepEqual(r.ids, []);
});
test('finalEvalBlockingResolutions: fixesApplied=0 / 非数値 → no_fixes（green でも解消しない）', () => {
  for (const fixesApplied of [0, -1, null, undefined, '1', Number.NaN]) {
    const r = finalEvalBlockingResolutions({ ...GREEN_RUN, fixesApplied, blockingItems: [EVAL_OPEN] });
    assert.deepEqual(r, { reason: 'no_fixes', evidence: null, ids: [] }, `fixesApplied=${String(fixesApplied)}`);
  }
});
test('finalEvalBlockingResolutions: reverified + test#final red → not_verified', () => {
  const r = finalEvalBlockingResolutions({ ...GREEN_RUN, finalTestGreen: false, blockingItems: [EVAL_OPEN] });
  assert.deepEqual(r, { reason: 'not_verified', evidence: null, ids: [] });
});
test('finalEvalBlockingResolutions: reverified + no_tests（finalTestGreen=null）→ not_verified', () => {
  const r = finalEvalBlockingResolutions({ ...GREEN_RUN, finalTestGreen: null, blockingItems: [EVAL_OPEN] });
  assert.equal(r.reason, 'not_verified');
});
test('finalEvalBlockingResolutions: reverified + green でも head sha 不明 → not_verified', () => {
  for (const headSha of [null, undefined, '']) {
    const r = finalEvalBlockingResolutions({ ...GREEN_RUN, headSha, blockingItems: [EVAL_OPEN] });
    assert.equal(r.reason, 'not_verified', `headSha=${JSON.stringify(headSha)}`);
  }
});
test('finalEvalBlockingResolutions: unavailable / skipped → not_verified', () => {
  for (const finalReconcile of ['unavailable', 'skipped']) {
    const r = finalEvalBlockingResolutions({ ...GREEN_RUN, finalReconcile, blockingItems: [EVAL_OPEN] });
    assert.equal(r.reason, 'not_verified', `finalReconcile=${finalReconcile}`);
  }
});
test('finalEvalBlockingResolutions: 入力 item を mutate しない', () => {
  const input = MIXED_BLOCKING.map((it) => ({ ...it }));
  const copy = JSON.parse(JSON.stringify(input));
  finalEvalBlockingResolutions({ ...GREEN_RUN, blockingItems: input });
  assert.deepEqual(input, copy);
});
