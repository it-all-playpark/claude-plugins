import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash, shapeOverrides } from './test-helpers/vm-sandbox.mjs';

import {
  EVALUATOR_OPERATIONAL_CONTRACT, CONCERN_RESOLUTIONS, normalizeConcernResolution,
  EVAL_DESCRIPTION_MAX, EVAL_SUGGESTION_MAX, EVAL_EVIDENCE_MAX, EVAL_FULL_SUITE,
  TEST_LOG_REUSE, TEST_LOG_EVIDENCE_LIMIT, validateResultPromptBlock, acceptedCriticalResolutions,
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

// issue #658 / #1168: final_ac_reconcile 契約に item_resolutions（ESCALATE/advisory item の fix 後 tree
// 再評価。resolved / unresolved の 2 値 enum）があり、最終 tree で確かめられない item は unresolved にすることを pin する。
test('[evaluator-contract][#1168] final_ac_reconcile 契約の item_resolutions は resolved / unresolved の 2 値で、確かめられない item は unresolved', () => {
  const contract = EVALUATOR_OPERATIONAL_CONTRACT.final_ac_reconcile;
  assert.ok(contract.includes('item_resolutions'), 'final_ac_reconcile 契約に item_resolutions の説明が必要です');
  assert.ok(contract.includes('resolved（指摘内容が最終 tree で解消されている — revert / 修正済み等）/ unresolved の 2 値のみ'), contract);
  assert.ok(contract.includes('最終 tree で確かめられない item（ローカルで実行できない build / compose / e2e 等）は unresolved にする'), contract);
});

// issue #1144: テストログに載っている AC 関連テストファイルはログの行を evidence に使ってよく、載っていないものは実行する。
// ログの行も実行結果も PR が書いたテストの出力なので、テストの本体と対象実装を読んで assert を確かめたときだけ根拠にする
const LOG_EVIDENCE = 'ログの該当行（テスト名と ok / not ok）を evidence にして';
const TEST_BODY_CHECK = '実行するかはテストの本体を読んで決め';
test('[evaluator-contract][#1144] TEST_LOG_REUSE と final_ac_reconcile 契約は、ログの行を使うか実行するかをテストの本体を読んで決めさせ、ログに無いものは実行させる', () => {
  for (const [name, text] of [['TEST_LOG_REUSE', TEST_LOG_REUSE], ['final_ac_reconcile', EVALUATOR_OPERATIONAL_CONTRACT.final_ac_reconcile]]) {
    assert.ok(text.includes(TEST_BODY_CHECK), `${name}: 実行するかをテストの本体で決める指示が無い`);
    assert.ok(text.includes(LOG_EVIDENCE) && text.includes('verified_by:"test"'), `${name}: ログの行を evidence にして verified_by:"test" とする指示が無い`);
    assert.ok(/ログに載っていない AC (に関係する|関連)テストファイルは実行/.test(text), `${name}: ログに無いものを実行する指示が無い`);
    // ログはテストが自由に書けるので、この diff が変更したファイルの、実行対象一覧とファイルの実体で裏を取れる行だけを根拠にする
    assert.ok(text.includes(TEST_LOG_EVIDENCE_LIMIT), `${name}: ログ行の裏取りの指示が無い`);
  }
  for (const s of ['「ログを根拠にできるテストファイル」（この diff が変更したファイル）に載るファイルだけ', 'ログに載っていても実行する',
    '集計行', '実行対象一覧', '評価対象の tree（working tree）のそのファイルに実在する',
    'ログの行だけを AC 達成の根拠にしない', 'テストの本体と対象実装を読み', '条件分岐で実行を避けていない・成功の行を自分で出力していない',
    '確かめられないテストはログの行も実行結果も verified_by:"test" の根拠にしない']) {
    assert.ok(TEST_LOG_EVIDENCE_LIMIT.includes(s), `${s}: ${TEST_LOG_EVIDENCE_LIMIT}`);
  }
  // 契約はテストログが渡されたときに限る（渡されない・読めないときは AC 関連テストを実行する）
  assert.ok(EVALUATOR_OPERATIONAL_CONTRACT.final_ac_reconcile.includes('テストログが渡されない・読めない場合は AC に関係するテストファイルを実行'));
});

test('[evaluator-contract][#1144] evaluator.md の「進め方」2 はテストログの行を使うか実行するかをテストの本体を読んで決める', () => {
  const steps = evaluatorMd.slice(evaluatorMd.indexOf('## 進め方'), evaluatorMd.indexOf('## 判定'));
  const step2 = steps.slice(steps.indexOf('\n2. '), steps.indexOf('\n3. ')).replace(/\n\s+/g, '');
  assert.ok(step2.includes(TEST_BODY_CHECK) && step2.includes(LOG_EVIDENCE) && step2.includes('`verified_by: "test"`'), step2);
  assert.ok(step2.includes('ログに載っていない AC に関係するテストファイルは実行する'), step2);
  assert.ok(step2.includes(TEST_LOG_EVIDENCE_LIMIT), step2);
  assert.ok(step2.includes('ログが渡されない・読めないときは AC に関係するテストファイルを実行する'), step2);
});

test('[evaluator-contract][#1144] validateResultPromptBlock はログと変更ファイルがあるときだけログパス・根拠にできるファイル・TEST_LOG_REUSE を入れる', () => {
  const scripts = [{ path: '/wt/tests/run-all-bats.sh', exit: 0, launch_failed: false, log: '/tmp/run-tests-q/0.log' }];
  const changed = ['plugins/x/a.bats', 'plugins/x/a.sh'];
  const withLogs = validateResultPromptBlock({ tests: 'passed', green: true, summary: 's', scripts }, changed);
  assert.ok(withLogs.includes('/tmp/run-tests-q/0.log') && withLogs.includes(TEST_LOG_REUSE), withLogs);
  assert.ok(withLogs.includes(`ログを根拠にできるテストファイル（この diff が変更したファイル。git から取った一覧）:\n${JSON.stringify(changed)}\n`), withLogs);
  for (const [name, val, files] of [
    ['scripts 無し', { tests: 'passed', green: true, summary: 's' }, changed],
    ['log 無し', { tests: 'passed', green: true, summary: 's', scripts: [{ path: '/wt/tests/run-all-bats.sh', exit: 0, launch_failed: false }] }, changed],
    ['tests:error', { tests: 'error', green: false, summary: 's', scripts }, changed],
    // 変更ファイルが取れない・空なら、ログを根拠にできるファイルが無いので再実行抑止の指示を入れない
    ['変更ファイル null', { tests: 'passed', green: true, summary: 's', scripts }, null],
    ['変更ファイル空', { tests: 'passed', green: true, summary: 's', scripts }, []],
    // red のまま Evaluate に進んだ Validate のログは渡さない
    ['Validate red', { tests: 'failed', green: false, summary: 'not ok 1 x', scripts }, changed],
  ]) {
    const block = validateResultPromptBlock(val, files);
    assert.ok(!block.includes(TEST_LOG_REUSE) && !block.includes('/tmp/run-tests-q/'), `${name}: ${block}`);
    assert.ok(block.includes(`${EVAL_FULL_SUITE}は走らせず、AC に関係するテストファイルだけを実行して根拠にせよ。`), `${name}: ${block}`);
  }
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
        diffhash: { hash: 'H', empty: false },
      },
      'impl:serial:issue-1': { status: 'DONE_WITH_CONCERNS', task_id: 'issue-1', files: ['src/x.ts'], summary: 's', concerns: ['未検証の入力値がある'] },
    },
  });
  const { error } = await runWorkflowCapture(devFlowSrc, ctx);
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
  const { error } = await runWorkflowCapture(devFlowSrc, ctx);
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
  const { error } = await runWorkflowCapture(devFlowSrc, ctx);
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
        diffhash: { hash: 'H', empty: false },
      },
    },
  });
  const { error } = await runWorkflowCapture(devFlowSrc, ctx);
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

// ---- issue #1267: critical_resolutions の採用規則（Evaluate と Final AC reconcile が共有）----

const EVAL_A = { id: 'EVAL-1-authz-missing', source: 'evaluator', severity: 'critical', checked: false };
const EVAL_B = { id: 'EVAL-1-summary-format', source: 'evaluator', severity: 'critical', checked: false };
const CRIT_ITEMS = [
  EVAL_A, EVAL_B,
  { id: 'EVAL-1-already-done', source: 'evaluator', severity: 'critical', checked: true },
  { id: 'SEC-SECRETS', source: 'seed', dimension: 'security', severity: 'critical', checked: false },
  { id: 'TESTSURF-SKIP', source: 'seed', dimension: 'test-integrity', severity: 'critical', checked: false },
  { id: 'AC-FINAL-1', source: 'evaluator', dimension: 'ac', severity: 'critical', checked: false },
];
const ALL_IDS = CRIT_ITEMS.map((it) => it.id);

test('[acceptedCriticalResolutions] 渡した未 checked の EVAL-* に resolved:true + evidence → evidence 付きで採用', () => {
  const r = acceptedCriticalResolutions([{ id: EVAL_A.id, resolved: true, evidence: 'src/api.ts:12 で認可チェックを追加' }], [EVAL_A.id], CRIT_ITEMS);
  assert.deepEqual(r, [{ id: EVAL_A.id, evidence: 'src/api.ts:12 で認可チェックを追加' }]);
});

test('[acceptedCriticalResolutions] 渡していない id は resolved:true + evidence でも採用しない', () => {
  const r = acceptedCriticalResolutions([{ id: EVAL_B.id, resolved: true, evidence: 'src/s.ts:3' }], [EVAL_A.id], CRIT_ITEMS);
  assert.deepEqual(r, []);
});

test('[acceptedCriticalResolutions] evidence の無い resolved:true（欠落・空文字・空白のみ・非 string）は採用しない', () => {
  for (const evidence of [undefined, '', '   ', 42]) {
    const r = acceptedCriticalResolutions([{ id: EVAL_A.id, resolved: true, evidence }], [EVAL_A.id], CRIT_ITEMS);
    assert.deepEqual(r, [], `evidence=${JSON.stringify(evidence)}`);
  }
});

test('[acceptedCriticalResolutions] resolved:false は evidence があっても採用しない', () => {
  const r = acceptedCriticalResolutions([{ id: EVAL_A.id, resolved: false, evidence: '認可チェックがまだ無い' }], [EVAL_A.id], CRIT_ITEMS);
  assert.deepEqual(r, []);
});

test('[acceptedCriticalResolutions] SEC / TESTSURF / AC-FINAL-* / checked 済み / ledger に無い id は渡されていても採用しない', () => {
  const ids = ['SEC-SECRETS', 'TESTSURF-SKIP', 'AC-FINAL-1', 'EVAL-1-already-done', 'EVAL-9-unknown'];
  const r = acceptedCriticalResolutions(ids.map((id) => ({ id, resolved: true, evidence: 'ok' })), [...ALL_IDS, 'EVAL-9-unknown'], CRIT_ITEMS);
  assert.deepEqual(r, []);
});

test('[acceptedCriticalResolutions] 同じ id は最初に採用した 1 件だけ・入力順・null や配列でない入力は空', () => {
  const r = acceptedCriticalResolutions([
    null,
    { id: EVAL_B.id, resolved: true, evidence: 'b1' },
    { id: EVAL_A.id, resolved: true, evidence: 'a1' },
    { id: EVAL_B.id, resolved: true, evidence: 'b2' },
  ], ALL_IDS, CRIT_ITEMS);
  assert.deepEqual(r, [{ id: EVAL_B.id, evidence: 'b1' }, { id: EVAL_A.id, evidence: 'a1' }]);
  for (const input of [null, undefined, {}]) assert.deepEqual(acceptedCriticalResolutions(input, ALL_IDS, CRIT_ITEMS), []);
});

test('[acceptedCriticalResolutions] 入力を mutate しない', () => {
  const items = CRIT_ITEMS.map((it) => ({ ...it }));
  const resolutions = [{ id: EVAL_A.id, resolved: true, evidence: 'e' }];
  const before = JSON.stringify({ items, resolutions });
  acceptedCriticalResolutions(resolutions, [EVAL_A.id], items);
  assert.equal(JSON.stringify({ items, resolutions }), before);
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
  const { error } = await runWorkflowCapture(devFlowSrc, ctx);
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
  // resolution の enum は FINAL_ITEM_RESOLUTIONS（resolved / unresolved の 2 値。issue #1168）
  assert.equal(JSON.stringify(finalSchema.properties.item_resolutions.items.properties.resolution.enum), JSON.stringify(['resolved', 'unresolved']));
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
