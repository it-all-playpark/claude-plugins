// post-eval-recheck-routing.test.mjs — Evaluate 後に入った変更を run 内で確かめ直す経路を dev-flow.js の VM 実行で pin する。
//
// (1) post-eval green-fix の再評価: Evaluate 差し戻し後の PR 前テストで green-fix が入った run は、green-fix の差分に
//     diff-triage（testsurf / structural）を当て、hit 0 かつテストファイルだけなら assert_only、それ以外は full で
//     evaluator に差分を評価させ、評価済み tree（evalDiffHash）を green-fix 後の tree へ進める。
//     assert を弱めない修正なら hash_mismatch で HOLD にならず、弱めた修正は critical（全 gate_policy で blocking）で HOLD。
// (2) 解消済み item の再検証: green-fix / pr-iterate fix が触ったファイルに言及する解消済み item は、
//     最終 tree で再検証され、崩れた・確かめられなかった解消根拠は終端サマリの「解消済み」に残らない。
//
// ハーネス: makeDevFlowSandbox + DEV_FLOW_SCENARIOS['post-eval-green-fix'] / ['final-recheck']。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash, devFlowArgs, mergeTierFacts, COMPLEX_FILES } from './test-helpers/vm-sandbox.mjs';
import { DEV_FLOW_SCENARIOS } from './test-helpers/dev-flow-scenarios.mjs';
import { EVALUATOR_OPERATIONAL_CONTRACT } from './evaluator-contract.mjs';
import { GATE_POLICIES } from './gate-policy.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', '.claude/workflows/dev-flow.js'), 'utf8');

const POST_EVAL = DEV_FLOW_SCENARIOS['post-eval-green-fix'];
const FINAL_RECHECK = DEV_FLOW_SCENARIOS['final-recheck'];

async function run({ scenario = POST_EVAL, overrides = {}, workflow, gatePolicy } = {}) {
  const extra = gatePolicy ? { args: { ...devFlowArgs(1), gate_policy: gatePolicy } } : {};
  const { ctx, calls, logs } = makeDevFlowSandbox({
    overrides: { ...(scenario.overrides ?? {}), ...overrides },
    workflow: workflow ?? scenario.workflow,
    extra,
  });
  const { result, error } = await runWorkflowCapture(src, ctx);
  assertNoCrash(error, 'post-eval-recheck');
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  const labels = calls.map((c) => c.label);
  const call = (label) => calls.find((c) => c.label === label);
  return { calls, logs, result, labels, call, summary: call('post-summary')?.prompt ?? '' };
}

const holdCodes = (result) => (result.merge_tier_hold_reasons ?? []).map((r) => r.code);

// ---- (1) post-eval green-fix の再評価 ----

test('[post-eval-recheck] assert を弱めない test-only の green-fix は assert_only で再評価され、hash_mismatch で HOLD にならず評価済み tree = PR tree で終わる', async () => {
  const { labels, call, logs, result } = await run();
  const s = labels.join(', ');
  const order = ['green-fix#post-eval-1', 'test#post-eval-2', 'green-fix-classify', 'green-fix-numstat', 'eval-green-fix', 'diff-hash-pr', 'pr#1'];
  const idx = order.map((l) => labels.indexOf(l));
  assert.ok(idx.every((n) => n >= 0), `再評価経路の label が揃わない (labels: ${s})`);
  assert.deepEqual([...idx].sort((a, b) => a - b), idx, `順序が green-fix → test → classify → numstat → eval-green-fix → PR でない (labels: ${s})`);
  const ev = call('eval-green-fix');
  assert.equal(ev.agentType, 'dev-flow:evaluator');
  assert.equal(ev.model, null, 'evaluator の model は override しない');
  assert.ok(ev.prompt.includes('mode: assert_only'), 'test-only・hit 0 の green-fix は assert_only で再評価する');
  assert.ok(ev.prompt.includes('git diff AAA BBB'), 'evaluator に評価済み tree → green-fix 後 tree の差分を渡していない');
  assert.ok(ev.prompt.includes(EVALUATOR_OPERATIONAL_CONTRACT.green_fix_recheck), 'green_fix_recheck 契約が verbatim 注入されていない');
  // 評価済み tree が green-fix 後の tree（BBB）へ進み、PR 直前の hash（BBB）と一致する
  assert.ok(logs.some((l) => l.includes('AAA → BBB を評価済み tree として採用')), `評価済み tree の更新 log が無い: ${JSON.stringify(logs)}`);
  assert.equal(labels.includes('tree-diff-numstat'), false, `hash 一致なら tree-diff-numstat は走らない (labels: ${s})`);
  assert.equal(result.eval_staleness, 'none');
  assert.ok(!holdCodes(result).includes('hash_mismatch'), `hash_mismatch で HOLD している: ${JSON.stringify(result.merge_tier_hold_reasons)}`);
  assert.notEqual(result.merge_tier, 'HOLD', `HOLD になった: ${JSON.stringify(result.merge_tier_reasons)}`);
  assert.equal(result.test_green, true);
});

test('[post-eval-recheck] テストファイル以外を触る green-fix は full で差分全体を評価させ、宣言外の変更も評価対象に渡す', async () => {
  const { call, result } = await run({
    overrides: {
      'green-fix#post-eval-1': { status: 'DONE', task_id: 'issue-1', files: ['src/new-helper.ts'], summary: 'helper を足した', concerns: [] },
      'green-fix-classify': { risk: { ok: true, hits: [] }, files: [...COMPLEX_FILES, 'src/new-helper.ts'], struct: null, diffhash: { hash: 'BBB', empty: false } },
      'green-fix-numstat': { ok: true, lines: ['5\t0\tsrc/new-helper.ts'] },
    },
  });
  const ev = call('eval-green-fix');
  assert.ok(ev.prompt.includes('mode: full'), 'テストファイル以外を触る green-fix は full で評価する');
  assert.ok(ev.prompt.includes('plan 宣言外の変更') && ev.prompt.includes('src/new-helper.ts'), 'green-fix の宣言外変更が evaluator に渡っていない');
  assert.equal(result.eval_staleness, 'none');
  assert.notEqual(result.merge_tier, 'HOLD', `HOLD になった: ${JSON.stringify(result.merge_tier_reasons)}`);
});

test('[post-eval-recheck] green-fix 差分に test-weakening hit があれば full + testsurf_focus で評価し、evidence 付き clear で TESTSURF は解消する', async () => {
  const hit = { class: 'test-weakening', pattern: 'skip', file: 'tests/foo.test.ts', severity: 'critical' };
  const { call, result } = await run({
    overrides: {
      'green-fix-classify': { risk: { ok: true, hits: [hit] }, files: ['tests/foo.test.ts'], struct: null, diffhash: { hash: 'BBB', empty: false } },
      'eval-green-fix': { findings: [], testsurf_clearance: [{ pattern: 'skip', cleared: true, evidence: 'tests/foo.test.ts の skip は flaky な外部 API テストで、同等の検査が tests/foo.unit.test.ts:12 にある' }] },
      'merge-tier-facts': mergeTierFacts({ hash: 'BBB', tree: 'BBB', risk: { ok: true, hits: [hit] } }),
    },
  });
  const ev = call('eval-green-fix');
  assert.ok(ev.prompt.includes('mode: full'), 'hit のある green-fix は full で評価する');
  assert.ok(ev.prompt.includes('testsurf_focus') && ev.prompt.includes(EVALUATOR_OPERATIONAL_CONTRACT.testsurf_clearance), 'testsurf_focus と testsurf_clearance 契約が渡っていない');
  assert.ok(!holdCodes(result).includes('testsurf_uncleared'), `clear 済みの TESTSURF が HOLD 理由に残っている: ${JSON.stringify(result.merge_tier_hold_reasons)}`);
  assert.equal(result.eval_staleness, 'none');
});

test('[post-eval-recheck] assert を弱めた green-fix は再評価で critical として検出され、どの gate_policy でも blocking（HOLD）になる', async () => {
  for (const gatePolicy of GATE_POLICIES) {
    const { result, summary, call } = await run({
      gatePolicy,
      overrides: {
        'eval-green-fix': { findings: [{ severity: 'critical', topic: 'assert 弱体化', description: 'expect(x).toBe(3) を toBeTruthy() に緩めて green にした' }] },
      },
    });
    assert.ok(call('eval-green-fix').prompt.includes('mode: assert_only'), `[${gatePolicy}] 前提: assert_only で再評価していない`);
    assert.equal(result.gate_policy, gatePolicy);
    assert.equal(result.merge_tier, 'HOLD', `[${gatePolicy}] assert 弱体化が HOLD にならない: ${JSON.stringify(result.merge_tier_reasons)}`);
    assert.equal(result.ledger_converged, false, `[${gatePolicy}] critical が blocking に入っていない`);
    assert.ok(holdCodes(result).includes('ledger_unconverged'), `[${gatePolicy}] HOLD 理由が ledger_unconverged でない: ${JSON.stringify(result.merge_tier_hold_reasons)}`);
    // 評価自体はできているので hash_mismatch ではなく finding で止まる
    assert.equal(result.eval_staleness, 'none', `[${gatePolicy}] eval_staleness`);
    assert.ok(summary.includes('post-eval green-fix: assert 弱体化'), `[${gatePolicy}] 終端サマリに critical finding が無い`);
  }
});

test('[post-eval-recheck] evaluator の応答が取れなければ評価済み tree を進めず hash_mismatch（HOLD）で人間へ', async () => {
  const { result } = await run({
    overrides: {
      'eval-green-fix': null,
      'tree-diff-numstat': { ok: true, lines: ['1\t0\ttests/foo.test.ts'] },
    },
  });
  assert.equal(result.eval_staleness, 'hash_mismatch');
  assert.equal(result.merge_tier, 'HOLD');
  assert.ok(holdCodes(result).includes('hash_mismatch'));
});

test('[post-eval-recheck] green-fix 後の tree が評価済み tree と同じなら numstat / evaluator を起動しない', async () => {
  const { labels } = await run({
    overrides: {
      'green-fix-classify': { risk: { ok: true, hits: [] }, files: [...COMPLEX_FILES], struct: null, diffhash: { hash: 'AAA', empty: false } },
      'diff-hash-pr': { hash: 'AAA', empty: false },
      'merge-tier-facts': mergeTierFacts({ hash: 'AAA', tree: 'AAA' }),
    },
  });
  assert.equal(labels.includes('green-fix-numstat'), false);
  assert.equal(labels.includes('eval-green-fix'), false);
});

// ---- (2) 解消済み item の再検証 ----

// eval#2 が「generate_thumbnail.bats の変更は取り消し済み」と concern を解消したあと、post-eval green-fix が同じファイルを触る
const STALE_EVIDENCE = 'tests/generate_thumbnail.bats の変更を取り消し済み';
const CONCERN_OVERRIDES = {
  'impl:serial:issue-1': { status: 'DONE', task_id: 'issue-1', files: [...COMPLEX_FILES], summary: 's', concerns: ['tests/generate_thumbnail.bats の期待値を変更した'] },
  'eval#2': {
    ...POST_EVAL.overrides['eval#2'],
    concern_resolutions: [{ id: 'CONCERN-1', resolution: 'resolved', evidence: STALE_EVIDENCE }],
  },
  'green-fix#post-eval-1': { status: 'DONE', task_id: 'issue-1', files: ['tests/generate_thumbnail.bats'], summary: 'thumbnail テストの期待値を直した', concerns: [] },
  'green-fix-classify': { risk: { ok: true, hits: [] }, files: [...COMPLEX_FILES, 'tests/generate_thumbnail.bats'], struct: null, diffhash: { hash: 'BBB', empty: false } },
  'green-fix-numstat': { ok: true, lines: ['3\t3\ttests/generate_thumbnail.bats'] },
};

test('[post-eval-recheck] green-fix が触ったファイルに言及する解消済み item は再検証され、崩れた解消根拠は終端サマリの「解消済み」に残らない', async () => {
  const { call, summary, result } = await run({
    overrides: {
      ...CONCERN_OVERRIDES,
      'eval-green-fix': { findings: [], recheck_resolutions: [{ id: 'CONCERN-1', resolution: 'unresolved', evidence: 'green-fix が generate_thumbnail.bats の期待値変更を再び入れた' }] },
    },
  });
  const ev = call('eval-green-fix');
  assert.ok(ev.prompt.includes('再検証対象 resolved item 一覧') && ev.prompt.includes('"id":"CONCERN-1"'), '解消済み CONCERN-1 が再検証対象として渡っていない');
  assert.ok(ev.prompt.includes(EVALUATOR_OPERATIONAL_CONTRACT.resolved_recheck), 'resolved_recheck 契約が verbatim 注入されていない');
  assert.ok(!ev.prompt.includes('"id":"EVAL-1-X"'), 'green-fix が触っていないファイル（src/a.ts）に言及する item まで再検証対象にしている');
  assert.ok(!summary.includes(STALE_EVIDENCE), `崩れた解消根拠が終端サマリに残っている:\n${summary}`);
  assert.ok(summary.includes('post-eval green-fix 後の tree で再検証し解消根拠が不成立'), `取り下げた理由が終端サマリに無い:\n${summary}`);
  // EVAL-1-X の解消根拠（src/a.ts）は触られていないので残る
  assert.ok(summary.includes('src/a.ts で修正済み'));
  assert.equal(result.eval_staleness, 'none');
});

test('[post-eval-recheck] 再検証で根拠が成り立つと確認された item は、再検証結果の evidence で解消済みに残る', async () => {
  const { summary } = await run({
    overrides: {
      ...CONCERN_OVERRIDES,
      'eval-green-fix': { findings: [], recheck_resolutions: [{ id: 'CONCERN-1', resolution: 'resolved', evidence: 'green-fix は import 行だけで期待値は base と同じ（tests/generate_thumbnail.bats:20）' }] },
    },
  });
  assert.ok(!summary.includes(STALE_EVIDENCE), '再検証前の evidence が残っている');
  assert.ok(summary.includes('post-eval green-fix 後の tree で再検証済み: green-fix は import 行だけ'), `再検証済みの evidence が無い:\n${summary}`);
});

test('[post-eval-recheck] 再検証対象を evaluator が返さなければ解消根拠を取り下げる', async () => {
  const { summary } = await run({ overrides: { ...CONCERN_OVERRIDES, 'eval-green-fix': { findings: [] } } });
  assert.ok(!summary.includes(STALE_EVIDENCE), '確かめられていない解消根拠が残っている');
  assert.ok(summary.includes('再検証できず — 解消根拠を取り下げ'), `取り下げの表示が無い:\n${summary}`);
});

const FINAL_STALE = 'src/x.ts:10 で境界条件を確認済み';
const finalAc = (extra = {}) => ({
  ac_results: [
    { ac_index: 0, satisfied: true, evidence: 'e0', verified_by: 'inspection' },
    { ac_index: 1, satisfied: true, evidence: 'e1', verified_by: 'inspection' },
  ],
  ...extra,
});

test('[post-eval-recheck] pr-iterate fix が触ったファイルに言及する解消済み item は Final AC reconcile で再検証され、崩れた根拠は残らない', async () => {
  const { labels, call, summary } = await run({
    scenario: FINAL_RECHECK,
    overrides: {
      'final-ac-reconcile': finalAc({ recheck_resolutions: [{ id: 'CONCERN-1', resolution: 'unresolved', evidence: 'fix で src/x.ts の境界チェックが消えた' }] }),
    },
  });
  const s = labels.join(', ');
  assert.ok(labels.indexOf('fix-diff-numstat') > labels.indexOf('changed-files-final') && labels.indexOf('fix-diff-numstat') < labels.indexOf('final-ac-reconcile'), `fix-diff-numstat の位置 (labels: ${s})`);
  assert.ok(call('fix-diff-numstat').prompt.includes('diff --numstat AAA HEAD'), 'fix 差分は PR 作成時の tree → 最終 HEAD で取る');
  const fa = call('final-ac-reconcile');
  assert.ok(fa.prompt.includes('再検証対象 resolved item 一覧') && fa.prompt.includes('"id":"CONCERN-1"'), '解消済み CONCERN-1 が Final AC reconcile の再検証対象に無い');
  assert.ok(fa.prompt.includes(EVALUATOR_OPERATIONAL_CONTRACT.resolved_recheck));
  assert.ok(!summary.includes(FINAL_STALE), `崩れた解消根拠が終端サマリに残っている:\n${summary}`);
  assert.ok(summary.includes('fix 後の最終 tree で再検証し解消根拠が不成立'), `取り下げた理由が無い:\n${summary}`);
});

test('[post-eval-recheck] fix が触っていないファイルに言及する解消済み item は再検証対象にしない', async () => {
  const { call, summary } = await run({
    scenario: FINAL_RECHECK,
    overrides: { 'fix-diff-numstat': { ok: true, lines: ['1\t1\tsrc/y.ts'] }, 'final-ac-reconcile': finalAc() },
  });
  assert.ok(!call('final-ac-reconcile').prompt.includes('再検証対象 resolved item 一覧'));
  assert.ok(summary.includes(FINAL_STALE), '再検証対象外の解消根拠まで消えている');
});

test('[post-eval-recheck] Final AC reconcile が走らない（final test red）run では再検証対象の解消根拠を取り下げる', async () => {
  const { labels, summary, result } = await run({
    scenario: FINAL_RECHECK,
    overrides: { 'test#final': { tests: 'failed', green: false, summary: 'red' } },
  });
  assert.equal(labels.includes('final-ac-reconcile'), false, '前提: final test red なら Final AC reconcile は走らない');
  assert.equal(result.merge_tier, 'HOLD');
  assert.ok(!summary.includes(FINAL_STALE), '再検証されなかった解消根拠が残っている');
  assert.ok(summary.includes('fix 後の最終 tree で再検証できず'), `取り下げの表示が無い:\n${summary}`);
});
