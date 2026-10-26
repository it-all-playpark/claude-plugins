// summary-test-cell-routing: VM sandbox routing test for dev-flow の終端サマリー・テスト欄（issue #707）。
//
// Validate が tests:'error'（起動失敗 = テスト未実行）で pr-iterate の fix が無く Final reconcile が
// skipped の run は、PR phase の head sha に pin した CI check を ci-test-display（finalCiPrompt +
// finalCiVerdict の再利用）で 1 回読み、その判定を終端サマリーのテスト欄と merge tier（validateCi）の
// 両方に使う。CI 確認が成立しなければ merge tier は validate_tests_not_run で HOLD（issue #1117）。
//
// テストケース:
//   (a) sha 一致 + 全 success → テスト欄 '✅ green (CI)'
//   (b) sha 不一致 / check failure / 取得失敗 / throw → テスト欄 '⚠️ 未実行（環境）・未検証' + 結論行で CI 確認
//   (c) (b) と PR head sha 無し（未取得）は merge tier HOLD（validate_tests_not_run）、(a) は積まない。final_reconcile は skipped のまま
//   (d) Validate が tests:'failed'（green-fix 上限後も red。base で pass する flake を含む）も ci-test-display を 1 回読む（issue #1138）
//       (d-1) CI 確認あり → テスト欄 '✅ green (CI)' + validate_test_red を積まない
//       (d-2) CI 確認なし（未確認・PR head sha 無し）→ テスト欄 '❌ red' + merge tier HOLD（validate_test_red、issue #1086）
//   (e) fixes_applied>0（Final reconcile 実行）→ ci-test-display 不発
//   (f) PR head sha が取れていない → ci-test-display 不発 + 未検証表示
//   (g) CI の読み取りは ci-test-display の 1 回だけで、その判定がテスト欄と merge tier の validateCi に渡る。
//       merge-tier.mjs は表示用入力（validateTests / ciTestVerified / ci-test-display）を参照しない
//   (h) 返り値 validate_tests / ci_test_verified がテスト欄と同じ入力を返し、test_green / final_test_green は不変（issue #731）
//   (i) Setup(deps) が ok:false の run では validate_tests_not_run の文言に deps の note が載る

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash, devFlowArgs } from './test-helpers/vm-sandbox.mjs';
import { DEV_FLOW_SCENARIOS } from './test-helpers/dev-flow-scenarios.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const devFlowSrc = readFileSync(join(here, '..', '.claude', 'workflows', 'dev-flow.js'), 'utf8');
const mergeTierSrc = readFileSync(join(here, 'merge-tier.mjs'), 'utf8');

const SCENARIO = DEV_FLOW_SCENARIOS['ci-test-display'];
const SHA40 = 'a'.repeat(40);

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

test('[summary-test-cell] (a) Validate tests:error + fixes_applied=0 + 同一 sha の CI 全 success → テスト欄 ✅ green (CI)', async () => {
  const { result, calls, testCell, conclusion } = await run();
  const probe = calls.filter((c) => c.label === 'ci-test-display');
  assert.equal(probe.length, 1, 'ci-test-display は 1 回呼ばれる');
  assert.equal(probe[0].agentType, 'dev-flow:dev-runner-haiku-ro');
  assert.ok(probe[0].prompt.includes('gh pr view 1 --json headRefOid,statusCheckRollup'), 'ci-final と同じ finalCiPrompt を使う');
  assert.ok(!calls.some((c) => c.label === 'ci-final'), 'Final reconcile の ci-final は起動しない');
  assert.equal(result?.final_reconcile, 'skipped', 'final_reconcile は skipped のまま');
  assert.equal(testCell, '✅ green (CI)');
  assert.ok(!conclusion.includes('CI の test 結果を確認してから'), '確認済みなので結論行に CI 確認を出さない');
});

const UNVERIFIED = {
  'sha 不一致': { ok: true, headRefOid: 'b'.repeat(40), statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] },
  'check failure': { ok: true, headRefOid: SHA40, statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }] },
  '取得失敗': { ok: false, error: 'gh failed' },
  throw: () => { throw new Error('injected'); },
};

test('[summary-test-cell] (b) CI 未確認（sha 不一致 / failure / 取得失敗 / throw）→ テスト欄は ❌ red ではなく未実行・未検証 + 結論行で CI 確認', async () => {
  for (const [name, resp] of Object.entries(UNVERIFIED)) {
    const { result, testCell, conclusion } = await run({ 'ci-test-display': resp });
    assert.equal(testCell, '⚠️ 未実行（環境）・未検証', `${name}: テスト欄`);
    assert.ok(conclusion.includes('CI の test 結果を確認してからマージ'), `${name}: 結論行に CI 確認`);
    assert.equal(result?.validate_tests, 'error', `${name}: 返り値 validate_tests`);
    assert.equal(result?.ci_test_verified, false, `${name}: 返り値 ci_test_verified は未検証`);
  }
});

const notRunCodes = (result) => (result?.merge_tier_hold_reasons ?? []).filter((r) => r.code === 'validate_tests_not_run');

test('[summary-test-cell] (c) CI 確認が成立しない run（未確認 / PR head sha 無しで未取得）は merge tier HOLD（validate_tests_not_run）、成立した run は積まない', async () => {
  const verified = await run();
  assert.equal(notRunCodes(verified.result).length, 0, 'CI green の run は validate_tests_not_run を積まない');
  assert.equal(verified.result?.merge_tier, 'REVIEW', tierFacts(verified.result));
  for (const [name, resp] of Object.entries(UNVERIFIED)) {
    const other = await run({ 'ci-test-display': resp });
    assert.equal(other.result?.merge_tier, 'HOLD', `${name}: ${tierFacts(other.result)}`);
    assert.equal(notRunCodes(other.result).length, 1, `${name}: ${tierFacts(other.result)}`);
    assert.equal(other.result?.final_reconcile, 'skipped', `${name}: final_reconcile は skipped のまま`);
  }
  // probe を起動しない run（PR head sha 無し）は CI 未取得として HOLD
  const noProbe = await run({ 'pr#1': { pr_url: 'http://x', pr_number: 1, committed: true } });
  assert.ok(!noProbe.calls.some((c) => c.label === 'ci-test-display'));
  assert.equal(noProbe.result?.merge_tier, 'HOLD', tierFacts(noProbe.result));
  assert.ok(notRunCodes(noProbe.result)[0]?.reason.includes('PR head sha の CI を取得していない'), tierFacts(noProbe.result));
});

// green-fix 後も red のまま（GREEN_MAX 到達）にする
const RED = { tests: 'failed', green: false, summary: 'assert mismatch' };
const RED_OVERRIDES = { 'test#1': RED, 'test#2': RED, 'test#3': RED };
const testRedCodes = (result) => (result?.merge_tier_hold_reasons ?? []).filter((r) => r.code === 'validate_test_red');

test("[summary-test-cell] (d-1) Validate tests:'failed' + 同一 sha の CI 全 success → ci-test-display 1 回 + テスト欄 ✅ green (CI) + validate_test_red を積まない（issue #1138）", async () => {
  const { result, calls, testCell, conclusion } = await run(RED_OVERRIDES);
  const probe = calls.filter((c) => c.label === 'ci-test-display');
  assert.equal(probe.length, 1, 'Validate red の run でも ci-test-display は 1 回呼ばれる');
  assert.ok(probe[0].prompt.includes('gh pr view 1 --json headRefOid,statusCheckRollup'), 'tests:error と同じ finalCiPrompt を使う');
  assert.equal(testCell, '✅ green (CI)', 'tests:error の CI 確認済み run と同じ表示');
  assert.ok(!conclusion.includes('CI の test 結果を確認してから'), conclusion);
  assert.equal(result?.validate_tests, 'failed');
  assert.equal(result?.ci_test_verified, true);
  assert.equal(result?.test_green, false, 'test_green は Validate の green のまま');
  assert.equal(result?.final_reconcile, 'skipped', 'final_reconcile は skipped のまま');
  assert.equal(testRedCodes(result).length, 0, tierFacts(result));
  assert.equal(result?.merge_tier, 'REVIEW', tierFacts(result));
});

test("[summary-test-cell] (d-2) Validate tests:'failed' で CI 確認なし（sha 不一致 / failure / 取得失敗 / throw / PR head sha 無し）→ テスト欄 ❌ red + merge tier HOLD（validate_test_red）", async () => {
  const cases = [
    ...Object.entries(UNVERIFIED).map(([name, resp]) => [name, { ...RED_OVERRIDES, 'ci-test-display': resp }, 1, false]),
    ['PR head sha 無し', { ...RED_OVERRIDES, 'pr#1': { pr_url: 'http://x', pr_number: 1, committed: true } }, 0, null],
  ];
  for (const [name, overrides, probes, verified] of cases) {
    const { result, calls, testCell } = await run(overrides);
    assert.equal(calls.filter((c) => c.label === 'ci-test-display').length, probes, `${name}: ci-test-display の回数`);
    assert.equal(testCell, '❌ red', `${name}: テスト欄`);
    assert.equal(result?.validate_tests, 'failed', name);
    assert.equal(result?.ci_test_verified, verified, `${name}: 返り値 ci_test_verified`);
    assert.equal(result?.test_green, false, name);
    // Final reconcile skipped で Validate の red が残る（issue #1086）
    assert.equal(result?.final_reconcile, 'skipped', name);
    assert.equal(result?.merge_tier, 'HOLD', `${name}: ${tierFacts(result)}`);
    assert.equal(testRedCodes(result).length, 1, `${name}: ${tierFacts(result)}`);
    assert.equal(notRunCodes(result).length, 0, `${name}: tests:failed は validate_tests_not_run を積まない`);
  }
});

test('[summary-test-cell] (e) fixes_applied>0（Final reconcile 実行）→ ci-test-display 不発', async () => {
  const { calls } = await run({ 'reconcile-sync': { ok: true, head: SHA40 } }, async () => ({ status: 'lgtm', iterations: 2, fixes_applied: 1 }));
  assert.ok(!calls.some((c) => c.label === 'ci-test-display'), 'Final reconcile が test 状態を扱う run では起動しない');
});

test('[summary-test-cell] (f) PR head sha が取れていない → ci-test-display 不発 + 未検証表示', async () => {
  const { calls, testCell } = await run({ 'pr#1': { pr_url: 'http://x', pr_number: 1, committed: true, head_sha: '' } });
  assert.ok(!calls.some((c) => c.label === 'ci-test-display'));
  assert.equal(testCell, '⚠️ 未実行（環境）・未検証');
});

test('[summary-test-cell] (g) CI の 1 回の取得の判定がテスト欄と merge tier の validateCi に渡り、merge-tier.mjs は表示用入力を参照しない', () => {
  for (const token of ['validateTests', 'ciTestVerified', 'ci-test-display', 'summaryCiTestVerified']) {
    assert.ok(!mergeTierSrc.includes(token), `merge-tier.mjs に ${token} を含まない`);
  }
  const code = (token) => devFlowSrc.split('\n').filter((l) => l.includes(token) && !l.trim().startsWith('//')).map((l) => l.trim());
  // ci-test-display の判定 displayCi は finalCiVerdict で 1 回だけ作り、テスト欄（summaryCiTestVerified）と
  // merge tier（validateCi）にだけ渡る — merge tier 用に CI を読み直さない
  assert.deepEqual(code('displayCi '), [
    'let displayCi = null',
    'displayCi = finalCiVerdict({ expectedSha: prHeadShaForDisplay, meta: displayCiMeta })',
  ]);
  assert.deepEqual(code('validateCi:'), ['validateCi: displayCi,']);
  assert.equal(code("label: 'ci-test-display'").length, 1, 'ci-test-display の取得は 1 か所');
  // 表示確認の結果は終端サマリーの引数と run 返り値にだけ渡る（telemetry には渡らない）
  assert.deepEqual(code('summaryCiTestVerified'), [
    'let summaryCiTestVerified = null',
    'summaryCiTestVerified = displayCi.verified',
    'ciTestVerified: summaryCiTestVerified,',
    'ci_test_verified: summaryCiTestVerified,',
  ]);
});

test("[summary-test-cell] (h) 返り値: Validate tests:'error' + CI 照合成功 → validate_tests:'error' + ci_test_verified:true、test_green / final_test_green は不変", async () => {
  const { result } = await run();
  assert.equal(result?.validate_tests, 'error');
  assert.equal(result?.ci_test_verified, true);
  assert.equal(result?.test_green, false, 'test_green は Validate の green のまま（CI 照合で true にしない）');
  assert.equal(result?.final_test_green, null, 'Final reconcile skipped の run は final_test_green null のまま');
});

test('[summary-test-cell] (i) Setup(deps) が ok:false の run は validate_tests_not_run の文言に deps の note が載る', async () => {
  const note = 'pnpm install failed: EPERM .gitmodules';
  const { result } = await run({ 'ci-test-display': UNVERIFIED['取得失敗'] }, undefined, { args: devFlowArgs(1, { deps: { ok: false, note } }) });
  assert.equal(result?.merge_tier, 'HOLD');
  assert.ok(notRunCodes(result)[0]?.reason.includes('Setup(deps) ok:false: ' + note), tierFacts(result));
});

test("[summary-test-cell] (h) 返り値: Validate tests:'passed' → validate_tests:'passed' + ci_test_verified null + test_green true", async () => {
  const { result, calls } = await run({ 'test#1': { tests: 'passed', green: true, summary: '' } });
  assert.ok(!calls.some((c) => c.label === 'ci-test-display'), 'passed の run では CI 表示確認を起動しない');
  assert.equal(result?.validate_tests, 'passed');
  assert.equal(result?.ci_test_verified, null);
  assert.equal(result?.test_green, true);
  assert.equal(result?.final_test_green, null);
});

test('[summary-test-cell] (h) dev-flow SKILL.md に返り値 validate_tests / ci_test_verified の読み方が載っている', () => {
  const skillMd = readFileSync(join(here, '..', 'dev-flow', 'SKILL.md'), 'utf8');
  const section = skillMd.slice(skillMd.indexOf('## 完了後の返り値の読み方'));
  assert.ok(skillMd.includes('## 完了後の返り値の読み方'), '「完了後の返り値の読み方」節がある');
  assert.ok(skillMd.indexOf('## 完了後の返り値の読み方') > skillMd.indexOf('4. **Workflow 起動**'), '手順 4 の後に置く');
  for (const token of ['`validate_tests`', '`ci_test_verified`', "`validate_tests === 'error' && ci_test_verified === true`", '再検証せず', '`validate_tests_not_run`']) {
    assert.ok(section.includes(token), `節に ${token} を含む`);
  }
});
