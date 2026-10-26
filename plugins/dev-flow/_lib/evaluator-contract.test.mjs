import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash, shapeOverrides } from './test-helpers/vm-sandbox.mjs';

import {
  EVALUATOR_OPERATIONAL_CONTRACT, CONCERN_RESOLUTIONS, normalizeConcernResolution,
  EVAL_DESCRIPTION_MAX, EVAL_SUGGESTION_MAX, EVAL_EVIDENCE_MAX, EVAL_FULL_SUITE,
} from './evaluator-contract.mjs';
import { RESOLVED_CELL_MAX } from './devflow-summary-format.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');
const devFlowSrc = readFileSync(devFlowPath, 'utf8');
const prIterateSrc = readFileSync(join(repoRoot, '.claude/workflows/pr-iterate.js'), 'utf8');
const evaluatorMd = readFileSync(join(repoRoot, '.claude/agents/evaluator.md'), 'utf8');

// ============================================================
// VM harness: 共有 vm-sandbox.mjs の makeDevFlowSandbox / runWorkflowCapture / assertNoCrash を使い、
// dev-flow.js が実際に agent() へ渡す prompt を捕捉して canonical contract の verbatim 注入を検証する。
// 既定 responder に無い Final reconcile 系の応答のみ overrides で補う。
// ============================================================

const FINAL_RECONCILE_DEFAULTS = {
  'reconcile-sync': { ok: true, head: 'deadbeef' },
  'changed-files-final': { files: [] },
  'final-ac-reconcile': {
    ac_results: [
      { ac_index: 0, satisfied: true, evidence: 'e0', verified_by: 'inspection' },
      { ac_index: 1, satisfied: true, evidence: 'e1', verified_by: 'inspection' },
    ],
  },
};

function makeSandbox({ overrides = {}, fixesApplied = 0 } = {}) {
  return makeDevFlowSandbox({
    overrides: { ...FINAL_RECONCILE_DEFAULTS, ...overrides },
    workflow: async () => ({ status: 'lgtm', iterations: 2, fixes_applied: fixesApplied }),
  });
}

const runDevFlowCapture = runWorkflowCapture;

const evaluatorContractBlock = [
  EVALUATOR_OPERATIONAL_CONTRACT.critical_resolutions,
  '',
  EVALUATOR_OPERATIONAL_CONTRACT.security_clearance,
].join('\n');

test('[evaluator-contract] evaluator.md contains the canonical _lib contract block verbatim', () => {
  assert.ok(
    evaluatorMd.includes(evaluatorContractBlock),
    'evaluator.md の critical_resolutions/security_clearance 契約が _lib/evaluator-contract.mjs と乖離しています',
  );
});

test('[evaluator-contract] evaluator.md contains the canonical concern_resolutions contract block verbatim', () => {
  assert.ok(
    evaluatorMd.includes(EVALUATOR_OPERATIONAL_CONTRACT.concern_resolutions),
    'evaluator.md の concern_resolutions 契約が _lib/evaluator-contract.mjs と乖離しています',
  );
});

// final_ac_reconcile 契約は evaluator.md へ mirror しない（issue #331 design decision）。
// .claude/agents/ は sandbox レベルの書き込み禁止領域であり、契約は dev-flow.js の
// final-ac-reconcile agent 呼び出し prompt への verbatim 注入のみで配送する（唯一の配送経路）。
// mirror 化する場合はこの pin ごと人間が明示的に変更すること。
test('[evaluator-contract] evaluator.md does NOT mirror the final_ac_reconcile contract (prompt-injection-only delivery, issue #331)', () => {
  assert.ok(
    !evaluatorMd.includes('final_ac_reconcile'),
    'final_ac_reconcile 契約は evaluator.md へ mirror せず、dev-flow.js の final-ac-reconcile prompt 注入のみで配送する設計。mirror 化する場合はこの pin ごと人間が変更すること',
  );
});

// issue #658: final_ac_reconcile 契約に item_resolutions（ESCALATE/advisory item の fix 後 tree
// 再評価。ci_delegated を含む 3 値 enum）が追加されていることを pin する。
test('[evaluator-contract][#658] final_ac_reconcile 契約が item_resolutions と ci_delegated を含む', () => {
  const contract = EVALUATOR_OPERATIONAL_CONTRACT.final_ac_reconcile;
  assert.ok(contract.includes('item_resolutions'), 'final_ac_reconcile 契約に item_resolutions の説明が必要です');
  assert.ok(contract.includes('ci_delegated'), 'final_ac_reconcile 契約に ci_delegated の説明が必要です');
});

// concern_resolutions 契約は openConcerns.length>0（implementer concerns がある）ときにのみ
// eval#1 prompt へ注入される。standard shape の既定 responder は implementer concerns:[] を
// 返すため、この test だけ overrides で implementer concerns を与える。
test('[evaluator-contract] eval#1 prompt contains EVALUATOR_OPERATIONAL_CONTRACT.critical_resolutions / security_clearance / concern_resolutions verbatim', async () => {
  const { ctx, calls } = makeSandbox({
    overrides: {
      'danger-grep': {
        risk: { ok: true, hits: [{ file: 'src/x.ts', class: 'network-egress', severity: 'critical', pattern: 'fetch' }] },
        files: ['src/x.ts'],
        struct: null,
        diffhash: { hash: 'H', empty: false },
      },
      'impl:serial:issue-1': { status: 'DONE_WITH_CONCERNS', task_id: 'issue-1', files: ['src/x.ts'], summary: 's', concerns: ['未検証の入力値がある'] },
    },
  });
  const { error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'contract-eval1');
  const eval1 = calls.find((c) => c.label === 'eval#1');
  assert.ok(eval1 != null, `label === 'eval#1' の call が見つからない (labels: ${calls.map((c) => c.label).join(', ')})`);
  assert.ok(
    eval1.prompt.includes(EVALUATOR_OPERATIONAL_CONTRACT.security_clearance),
    'eval#1 の prompt に EVALUATOR_OPERATIONAL_CONTRACT.security_clearance が verbatim 含まれていない（danger-grep hit による security_focus 注入）',
  );
  assert.ok(
    eval1.prompt.includes(EVALUATOR_OPERATIONAL_CONTRACT.concern_resolutions),
    'eval#1 の prompt に EVALUATOR_OPERATIONAL_CONTRACT.concern_resolutions が verbatim 含まれていない（未解消 concern 一覧による注入）',
  );
});

// critical_resolutions 契約は「未解消 critical 一覧」（前 iteration の critical feedback）または
// 「既出 feedback」が prompt に渡る場合にのみ注入される（eval#1 には prior state が無く注入されない）。
// complex shape の 2 iteration フィクスチャ（1 回目 critical → 2 回目解消）で eval#2 の prompt を検証する
// （_lib/eval-convergence.test.mjs の contract test と同じ理由）。
test('[evaluator-contract] eval#2 prompt contains EVALUATOR_OPERATIONAL_CONTRACT.critical_resolutions verbatim (issue #174)', async () => {
  const ac4 = [
    { ac_index: 0, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
    { ac_index: 1, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
    { ac_index: 2, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
    { ac_index: 3, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
  ];
  const { ctx, calls } = makeSandbox({
    overrides: {
      ...shapeOverrides('complex'),
      'eval#1': {
        verdict: 'fail', total: 5, threshold: 7,
        feedback: [{ severity: 'critical', topic: 'X', description: '重大欠陥', suggestion: '修正せよ' }],
        feedback_level: 'implementation', ac_results: ac4, security_clearance: [],
      },
      'eval#2': {
        verdict: 'pass', total: 9, threshold: 7, feedback: [],
        feedback_level: 'implementation', ac_results: ac4, security_clearance: [],
        critical_resolutions: [{ id: 'EVAL-1-X', resolved: true, evidence: 'src/x.ts の入力検証を追加し test で確認' }],
      },
    },
  });
  const { error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'contract-eval2');
  const evalCalls = calls.filter((c) => c.agentType === 'dev-flow:evaluator');
  assert.equal(evalCalls.length, 2, `evaluator は 2 回呼ばれるはずだが ${evalCalls.length} 回だった (labels: ${calls.map((c) => c.label).join(', ')})`);
  assert.ok(
    evalCalls[1].prompt.includes(EVALUATOR_OPERATIONAL_CONTRACT.critical_resolutions),
    'eval#2 の prompt に EVALUATOR_OPERATIONAL_CONTRACT.critical_resolutions が verbatim 含まれていない',
  );
});

test('[evaluator-contract] final-ac-reconcile prompt contains EVALUATOR_OPERATIONAL_CONTRACT.final_ac_reconcile verbatim', async () => {
  const { ctx, calls } = makeSandbox({
    fixesApplied: 1,
    overrides: { 'test#final': { tests: 'passed', green: true, summary: '' } },
  });
  const { error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'contract-final-ac');
  const finalAc = calls.find((c) => c.label === 'final-ac-reconcile');
  assert.ok(finalAc != null, `label === 'final-ac-reconcile' の call が見つからない (labels: ${calls.map((c) => c.label).join(', ')})`);
  assert.ok(
    finalAc.prompt.includes(EVALUATOR_OPERATIONAL_CONTRACT.final_ac_reconcile),
    'final-ac-reconcile の prompt に EVALUATOR_OPERATIONAL_CONTRACT.final_ac_reconcile が verbatim 含まれていない',
  );
});

// testsurf_clearance 契約は evaluator.md へ mirror しない（issue #362 design decision、final_ac_reconcile
// と同一 precedent）。.claude/agents/ は sandbox レベルの書き込み禁止領域であり、契約は dev-flow.js の
// testsurf_focus 注入 prompt への verbatim 注入のみで配送する（唯一の配送経路）。
// mirror 化する場合はこの pin ごと人間が明示的に変更すること。
test('[evaluator-contract] evaluator.md does NOT mirror the testsurf_clearance contract (prompt-injection-only delivery, issue #362)', () => {
  assert.ok(
    !evaluatorMd.includes('testsurf_clearance'),
    'testsurf_clearance 契約は evaluator.md へ mirror せず、dev-flow.js の testsurf_focus prompt 注入のみで配送する設計。mirror 化する場合はこの pin ごと人間が変更すること',
  );
});

test('[evaluator-contract] eval#1 prompt contains EVALUATOR_OPERATIONAL_CONTRACT.testsurf_clearance verbatim when danger-grep reports a test-weakening hit', async () => {
  const { ctx, calls } = makeSandbox({
    overrides: {
      'danger-grep': {
        risk: { ok: true, hits: [{ file: '_lib/foo.test.mjs', class: 'test-weakening', severity: 'critical', pattern: 'skip' }] },
        files: ['_lib/foo.test.mjs'],
        struct: null,
        diffhash: { hash: 'H', empty: false },
      },
    },
  });
  const { error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'contract-testsurf');
  const eval1 = calls.find((c) => c.label === 'eval#1');
  assert.ok(eval1 != null, `label === 'eval#1' の call が見つからない (labels: ${calls.map((c) => c.label).join(', ')})`);
  assert.ok(
    eval1.prompt.includes(EVALUATOR_OPERATIONAL_CONTRACT.testsurf_clearance),
    'eval#1 の prompt に EVALUATOR_OPERATIONAL_CONTRACT.testsurf_clearance が verbatim 含まれていない',
  );
});

test('[evaluator-contract] evaluator.md output example does not include schema-less score field', () => {
  assert.ok(!evaluatorMd.includes('"score"'), 'EVAL schema に無い score を evaluator.md の例に載せない');
});

test('[evaluator-contract] CONCERN_RESOLUTIONS is the closed 3-value enum', () => {
  assert.deepEqual(CONCERN_RESOLUTIONS, ['resolved', 'triaged', 'unresolved']);
});

test('[evaluator-contract] concern_resolutions contract mentions all 3 resolution values and {id, resolution, evidence}, not the legacy {id, resolved, evidence}', () => {
  const contract = EVALUATOR_OPERATIONAL_CONTRACT.concern_resolutions;
  for (const value of CONCERN_RESOLUTIONS) {
    assert.ok(contract.includes(value), `concern_resolutions 契約に '${value}' の説明が必要です`);
  }
  assert.ok(contract.includes('{id, resolution, evidence}'));
  assert.ok(!contract.includes('{id, resolved, evidence}'));
});

// #626 で撤回した旧仕様の文言が契約・evaluator.md に残っていないことだけを pin する（否定側のみ。
// 新仕様の言い回しは変えられるべきなので肯定側の文言 pin は置かない — issue #636 AC-1。
// 契約と evaluator.md の同期は上の verbatim mirror テストが担保する）。
test('[evaluator-contract][#626] concern_resolutions 契約と evaluator.md に旧「要対応に「トリアージ済み」として残る」が残っていない', () => {
  const contract = EVALUATOR_OPERATIONAL_CONTRACT.concern_resolutions;
  assert.ok(!contract.includes('triaged は要対応に「トリアージ済み」として残る'));
  assert.ok(!evaluatorMd.includes('triaged は要対応に「トリアージ済み」として残る'));
});

test('[normalizeConcernResolution] normalizes a well-formed triaged item', () => {
  const result = normalizeConcernResolution({ id: 'CONCERN-1', resolution: 'triaged', evidence: 'e' });
  assert.deepEqual(result, { id: 'CONCERN-1', resolution: 'triaged', evidence: 'e' });
});

test('[normalizeConcernResolution] missing evidence normalizes to null', () => {
  const result = normalizeConcernResolution({ id: 'CONCERN-1', resolution: 'unresolved' });
  assert.deepEqual(result, { id: 'CONCERN-1', resolution: 'unresolved', evidence: null });
});

test('[normalizeConcernResolution] legacy boolean key resolved throws', () => {
  assert.throws(
    () => normalizeConcernResolution({ id: 'CONCERN-1', resolved: true, evidence: 'e' }),
    /resolved/,
  );
});

test('[normalizeConcernResolution] out-of-enum resolution throws', () => {
  assert.throws(
    () => normalizeConcernResolution({ id: 'CONCERN-1', resolution: 'maybe', evidence: 'e' }),
    /out-of-enum/,
  );
});

test('[normalizeConcernResolution] missing id throws', () => {
  assert.throws(
    () => normalizeConcernResolution({ resolution: 'resolved', evidence: 'e' }),
  );
});

test('[normalizeConcernResolution] null input throws', () => {
  assert.throws(() => normalizeConcernResolution(null));
});

test('[normalizeConcernResolution] array input throws', () => {
  assert.throws(() => normalizeConcernResolution(['CONCERN-1', 'resolved', 'e']));
});

test('[schema] pr-iterate REVIEW.issues enforces stable stuck-detection fields', () => {
  assert.match(
    prIterateSrc,
    /issues:\s*\{\s*type:\s*'array',\s*items:\s*\{\s*type:\s*'object',\s*required:\s*\['severity', 'topic', 'file', 'description', 'suggestion'\]/s,
    'pr-iterate REVIEW.issues は item schema と topic/file/description を required にする必要があります',
  );
});

// ---- issue #842: evaluator 出力の自然文欄は schema の maxLength で書き手に収めさせる ----

test('[evaluator-contract][#842] 自然文欄の字数上限は description 300 / suggestion 200 / evidence 200', () => {
  assert.deepEqual(
    { description: EVAL_DESCRIPTION_MAX, suggestion: EVAL_SUGGESTION_MAX, evidence: EVAL_EVIDENCE_MAX },
    { description: 300, suggestion: 200, evidence: 200 },
  );
});

test('[evaluator-contract][#842] evidence 上限は終端サマリーの解消済み折りたたみ表のセル上限（RESOLVED_CELL_MAX）以下', () => {
  assert.ok(EVAL_EVIDENCE_MAX <= RESOLVED_CELL_MAX,
    `EVAL_EVIDENCE_MAX ${EVAL_EVIDENCE_MAX} > RESOLVED_CELL_MAX ${RESOLVED_CELL_MAX} — 上限いっぱいの evidence が表で切られる`);
});

test('[evaluator-contract][#842] eval#i の EVAL schema と final-ac-reconcile の item_resolutions に maxLength が付く', async () => {
  const { ctx, calls } = makeSandbox({
    fixesApplied: 1,
    overrides: { 'test#final': { tests: 'passed', green: true, summary: '' } },
  });
  const { error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'contract-eval-maxlength');
  const evalSchema = calls.find((c) => c.label === 'eval#1')?.schema;
  assert.ok(evalSchema, 'eval#1 の schema が取れない');
  const p = evalSchema.properties;
  const item = (k) => p[k].items.properties;
  assert.equal(item('feedback').description.maxLength, EVAL_DESCRIPTION_MAX);
  assert.equal(item('feedback').suggestion.maxLength, EVAL_SUGGESTION_MAX);
  for (const k of ['ac_results', 'security_clearance', 'testsurf_clearance', 'critical_resolutions', 'concern_resolutions']) {
    assert.equal(item(k).evidence.maxLength, EVAL_EVIDENCE_MAX, `${k}[].evidence`);
  }
  const finalSchema = calls.find((c) => c.label === 'final-ac-reconcile')?.schema;
  assert.ok(finalSchema, 'final-ac-reconcile の schema が取れない');
  assert.equal(finalSchema.properties.item_resolutions.items.properties.evidence.maxLength, EVAL_EVIDENCE_MAX);
});

test('[evaluator-contract][#842] evaluator.md の「書き方」の字数は schema の maxLength と一致する', () => {
  const section = evaluatorMd.slice(evaluatorMd.indexOf('## 書き方'), evaluatorMd.indexOf('## 出力 JSON'));
  assert.ok(section.includes(`\`description\` ${EVAL_DESCRIPTION_MAX} 字`), section);
  assert.ok(section.includes(`\`suggestion\` ${EVAL_SUGGESTION_MAX} 字`), section);
  assert.ok(section.includes(`各 \`evidence\` ${EVAL_EVIDENCE_MAX} 字`), section);
  assert.ok(!section.includes('200 字程度'), '上限ではない目安の字数が残っている');
});

test('[evaluator-contract][#842] evaluator.md の「進め方」2 は validate_result があれば全件スイートを走らせず AC に関係するテストだけを走らせる', () => {
  const steps = evaluatorMd.slice(evaluatorMd.indexOf('## 進め方'), evaluatorMd.indexOf('## 判定'));
  const step2 = steps.slice(steps.indexOf('\n2. '), steps.indexOf('\n3. '));
  assert.ok(step2.includes('`validate_result`'), step2);
  assert.ok(step2.includes(`${EVAL_FULL_SUITE}は走らせず、AC に関係するテストファイルだけを実行して根拠にする`), step2);
});
