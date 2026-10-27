// summary-test-cell-routing: VM sandbox routing test for dev-flow の終端サマリー・テスト欄（issue #707 / #1168）。
//
// テストを 1 件も確かめていない run は、PR の CI が success でもテスト欄を検証済みにせず merge tier を HOLD にする
// （pull_request の CI は PR head の workflow・スクリプトで動き、PR 自身が書き換えられる）。
//
// テストケース:
//   (a) Validate tests:'error' + fixes_applied=0（Final reconcile skipped）+ PR head の CI 全 success
//       → テスト欄 '⚠️ 未実行（環境）・未検証' + 結論行で CI 確認 + merge tier HOLD（validate_tests_not_run・human_judgment）
//   (b) Final reconcile unavailable（test#final tests:'error'）+ PR head の CI 全 success
//       → テスト欄 unavailable の表示 + merge tier HOLD（final_reconcile_unavailable・human_judgment）
//   (c) Validate が tests:'failed'（本物の red）→ テスト欄 '❌ red' + merge tier HOLD（validate_test_red、issue #1086）
//   (d) 返り値 validate_tests がテスト欄と同じ入力を返し、test_green / final_test_green は不変（issue #731）
//   (e) Setup(deps) が ok:false の run では validate_tests_not_run の文言に deps の note が載る

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash, devFlowArgs, mergeTierFacts } from './test-helpers/vm-sandbox.mjs';
import { DEV_FLOW_SCENARIOS } from './test-helpers/dev-flow-scenarios.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const devFlowSrc = readFileSync(join(here, '..', '.claude', 'workflows', 'dev-flow.js'), 'utf8');

const SCENARIO = DEV_FLOW_SCENARIOS['validate-tests-error'];
const SHA40 = 'a'.repeat(40);
// PR head の CI が全 success の応答。merge-tier-facts の checks と、CI を読む経路があれば返る head sha 一致の rollup
const CI_GREEN = {
  'merge-tier-facts': mergeTierFacts({ checks: [{ name: 'test', bucket: 'pass' }] }),
  'ci-final': { ok: true, headRefOid: SHA40, statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] },
  'ci-test-display': { ok: true, headRefOid: SHA40, statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] },
};
const UNAVAILABLE_CELL = '⚠️ unavailable（最終 tree で再検証不能）・未検証';

async function run(overrides = {}, workflow, extra) {
  const { ctx, calls } = makeDevFlowSandbox({ overrides: { ...SCENARIO.overrides, ...overrides }, workflow, extra });
  const { result, error } = await runWorkflowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'summary-test-cell');
  assert.equal(error, null, `run は完走するはずだが ${error?.message}`);
  const post = calls.find((c) => c.label === 'post-summary');
  assert.ok(post, 'post-summary が呼ばれるはず');
  const body = post.prompt.slice(post.prompt.indexOf('<<<DEV_FLOW_BODY_BEGIN>>>'), post.prompt.indexOf('<<<DEV_FLOW_BODY_END>>>'));
  const glance = body.split('\n').find((l) => l.startsWith('| ') && /\*\*(HOLD|REVIEW|AUTO)\*\*/.test(l));
  const testCell = glance.split('|').slice(1, -1).map((s) => s.trim())[2];
  const conclusion = body.split('\n').find((l) => l.startsWith('**結論: '));
  return { result, calls, body, testCell, conclusion };
}

function tierFacts(result) {
  return JSON.stringify({
    merge_tier: result?.merge_tier,
    reasons: result?.merge_tier_reasons,
    hold_reasons: result?.merge_tier_hold_reasons,
    hold_kind: result?.merge_tier_hold_kind,
    final_reconcile: result?.final_reconcile,
    final_test_green: result?.final_test_green,
  });
}

const holdOf = (result, code) => (result?.merge_tier_hold_reasons ?? []).filter((r) => r.code === code);

test('[summary-test-cell] (a) Validate tests:error + fixes_applied=0 は PR head の CI が全 success でもテスト欄を未実行・未検証にし、merge tier HOLD（validate_tests_not_run）', async () => {
  const { result, testCell, conclusion } = await run(CI_GREEN);
  assert.equal(result?.final_reconcile, 'skipped', 'final_reconcile は skipped のまま');
  assert.equal(testCell, '⚠️ 未実行（環境）・未検証');
  assert.ok(conclusion.includes('CI の test 結果を確認してからマージ'), '結論行で CI 確認を促す');
  assert.equal(result?.merge_tier, 'HOLD', tierFacts(result));
  assert.equal(holdOf(result, 'validate_tests_not_run').map((r) => r.kind).join(','), 'human_judgment', tierFacts(result));
});

test('[summary-test-cell] (b) Final reconcile unavailable（test#final tests:error）は PR head の CI が全 success でもテスト欄を unavailable にし、merge tier HOLD（final_reconcile_unavailable）', async () => {
  const { result, testCell, conclusion } = await run({
    ...CI_GREEN,
    'test#1': { tests: 'passed', green: true, summary: '' },
    'reconcile-sync': { ok: true, head: SHA40 },
    'test#final': { tests: 'error', green: false, summary: 'startup failed' },
  }, async () => ({ status: 'lgtm', iterations: 2, fixes_applied: 1 }));
  assert.equal(result?.final_reconcile, 'unavailable', tierFacts(result));
  assert.equal(testCell, UNAVAILABLE_CELL);
  assert.ok(conclusion.includes('CI の test 結果を確認してからマージ'), '結論行で CI 確認を促す');
  assert.equal(result?.merge_tier, 'HOLD', tierFacts(result));
  assert.equal(holdOf(result, 'final_reconcile_unavailable').map((r) => r.kind).join(','), 'human_judgment', tierFacts(result));
  assert.equal(result?.final_test_green, null);
});

test("[summary-test-cell] (c) Validate tests:'failed'（本物の red）→ テスト欄 ❌ red + merge tier HOLD（validate_test_red）", async () => {
  // green-fix 後も red のまま（GREEN_MAX 到達）にする
  const red = { tests: 'failed', green: false, summary: 'assert mismatch' };
  const { result, testCell } = await run({ 'test#1': red, 'test#2': red, 'test#3': red });
  assert.equal(testCell, '❌ red');
  assert.equal(result?.validate_tests, 'failed');
  assert.equal(result?.test_green, false);
  // テスト欄 ❌ red の run は merge tier も HOLD（validate_test_red。Final reconcile skipped で Validate の red が残る。issue #1086）
  assert.equal(result?.final_reconcile, 'skipped');
  assert.equal(result?.merge_tier, 'HOLD');
  assert.equal(holdOf(result, 'validate_test_red').length, 1, JSON.stringify(result?.merge_tier_hold_reasons));
});

test("[summary-test-cell] (d) 返り値: Validate tests:'error' → validate_tests:'error'、test_green / final_test_green は不変", async () => {
  const { result } = await run(CI_GREEN);
  assert.equal(result?.validate_tests, 'error');
  assert.equal(result?.test_green, false, 'test_green は Validate の green のまま');
  assert.equal(result?.final_test_green, null, 'Final reconcile skipped の run は final_test_green null のまま');
  const passed = await run({ 'test#1': { tests: 'passed', green: true, summary: '' } });
  assert.equal(passed.result?.validate_tests, 'passed');
  assert.equal(passed.result?.test_green, true);
  assert.equal(passed.result?.final_test_green, null);
});

test('[summary-test-cell] (e) Setup(deps) が ok:false の run は validate_tests_not_run の文言に deps の note が載る', async () => {
  const note = 'pnpm install failed: EPERM .gitmodules';
  const { result } = await run({}, undefined, { args: devFlowArgs(1, { deps: { ok: false, note } }) });
  assert.equal(result?.merge_tier, 'HOLD');
  assert.ok(holdOf(result, 'validate_tests_not_run')[0]?.reason.includes('Setup(deps) ok:false: ' + note), tierFacts(result));
});

test('[summary-test-cell] (d) dev-flow SKILL.md に返り値 validate_tests の読み方が載っている', () => {
  const skillMd = readFileSync(join(here, '..', 'dev-flow', 'SKILL.md'), 'utf8');
  const section = skillMd.slice(skillMd.indexOf('## 完了後の返り値の読み方'));
  assert.ok(skillMd.includes('## 完了後の返り値の読み方'), '「完了後の返り値の読み方」節がある');
  assert.ok(skillMd.indexOf('## 完了後の返り値の読み方') > skillMd.indexOf('4. **Workflow 起動**'), '手順 4 の後に置く');
  for (const token of ['`validate_tests`', "`validate_tests === 'error'`", '`validate_tests_not_run`', '`final_reconcile_unavailable`']) {
    assert.ok(section.includes(token), `節に ${token} を含む`);
  }
});
