// summary-test-cell-routing: VM sandbox routing test for dev-flow の終端サマリー・テスト欄と、Final reconcile が
// skip（fixes_applied=0）の run の Validate 結果の扱い（issue #707 / #1086 / #1117 / #1138）。
//
// Final reconcile が skip の run は PR tree のテスト状態が Validate の結果のまま。PR が書き換えられる CI の success では
// テスト状態を代えない（pull_request の CI は PR head の workflow で動き、CI が呼ぶスクリプトも PR が変えられる）。
//
// テストケース:
//   (a) Validate tests:'error'（起動失敗）→ テスト欄は未実行・未検証 + 結論行で CI 確認 + merge tier は PR head の CI が
//       全 pass でも validate_tests_not_run（human_judgment）で HOLD
//   (d) Validate tests:'failed'（green-fix の上限後も red）— 落ちたファイルだけの 1 回の再実行（test#validate-rerun）で:
//       (d1) flake あり（再実行 green）→ テスト欄 '⚠️ flake（単体再実行で green）' + validate_test_red なし + final_test_flaky 記録
//       (d2) flake なし（再実行も red）→ テスト欄 '❌ red' + merge tier HOLD（validate_test_red）
//   (e) test#validate-rerun の 4 経路: flake / 再実行しない（failed_files が空・欠落・安全に渡せないパス）/
//       再実行の結果を使わない（throw / null / red / error）/ 対象外の run（Final reconcile 実行・Validate が red でない）
//   (h) 返り値 validate_tests がテスト欄と同じ入力を返し、test_green / final_test_green は不変（issue #731）
//   (i) Setup(deps) が ok:false の run では validate_tests_not_run の文言に deps の note が載る

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
const FLAKY_CELL = '⚠️ flake（単体再実行で green）';

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

const holdCodes = (result) => (result?.merge_tier_hold_reasons ?? []).map((r) => r.code);
const notRunCodes = (result) => (result?.merge_tier_hold_reasons ?? []).filter((r) => r.code === 'validate_tests_not_run');

test('[summary-test-cell] (a) Validate tests:error + fixes_applied=0 → テスト欄は未実行・未検証 + 結論行で CI 確認 + PR head の CI が全 pass でも validate_tests_not_run で HOLD', async () => {
  const { result, testCell, conclusion } = await run({ 'merge-tier-facts': mergeTierFacts({ checks: [{ name: 'test', bucket: 'pass' }] }) });
  assert.equal(result?.final_reconcile, 'skipped', 'final_reconcile は skipped のまま');
  assert.equal(testCell, '⚠️ 未実行（環境）・未検証');
  assert.ok(conclusion.includes('CI の test 結果を確認してからマージ'), '結論行に CI 確認');
  assert.equal(result?.merge_tier, 'HOLD', tierFacts(result));
  assert.equal(holdCodes(result).join(','), 'validate_tests_not_run', tierFacts(result));
  assert.equal(notRunCodes(result)[0]?.kind, 'human_judgment', tierFacts(result));
  assert.equal(result?.merge_tier_hold_kind, 'human_judgment', tierFacts(result));
});

// ============================================================
// (d) / (e) Validate red（tests:'failed'）の落ちたファイルだけの 1 回の再実行（issue #1138）
// ============================================================

const RED_FILE = 'plugins/x/scripts/a.bats';
// green-fix の上限（GREEN_MAX=3）まで red のまま（test#1〜3）。1 回目の summary に落ちたランナーのログが載る
const validateRed = (extra = {}) => {
  const red = {
    tests: 'failed', green: false,
    summary: 'failed: /tmp/wt/tests/run-all-bats.sh (exit 1, log: /tmp/run-tests-v/0.log)',
    failed_files: [RED_FILE],
    ...extra,
  };
  return { 'test#1': red, 'test#2': red, 'test#3': red };
};

test('[summary-test-cell] (d1) Validate red + 落ちたファイルだけの再実行が green（flake あり）→ テスト欄 flake・validate_test_red なし・final_test_flaky 記録', async () => {
  const { result, calls, body, testCell } = await run({ ...validateRed(), 'test#validate-rerun': { tests: 'passed', green: true, summary: 'passed' } });
  const reruns = calls.filter((c) => c.label === 'test#validate-rerun');
  assert.equal(reruns.length, 1, 'test#validate-rerun は 1 回だけ');
  assert.equal(reruns[0].agentType, 'dev-flow:dev-runner-haiku');
  assert.equal(reruns[0].prompt.split('\n').at(-1), `run-tests /tmp/wt --files ${RED_FILE}`, '落ちたファイルだけを run-tests --files で渡す');
  assert.equal(result?.final_reconcile, 'skipped');
  assert.equal(result?.validate_tests, 'failed');
  assert.equal(result?.test_green, false, 'test_green は Validate の green のまま');
  assert.deepEqual(JSON.parse(JSON.stringify(result?.final_test_flaky)), { files: [RED_FILE], logs: ['/tmp/run-tests-v/0.log'] });
  assert.equal(testCell, FLAKY_CELL);
  assert.ok(!holdCodes(result).includes('validate_test_red'), tierFacts(result));
  assert.equal(result?.merge_tier, 'REVIEW', tierFacts(result));
  assert.ok(body.includes(`Validate test flake（単体再実行で green）: ${RED_FILE}`), '参考に Validate flake の開示行（ファイル）が出る');
  // telemetry: flake の run だけ final_test_flaky を載せる
  const handoff = calls.find((c) => c.label === 'journal-log');
  const m = handoff?.prompt.match(/<<<JOURNAL_HANDOFF_BODY_BEGIN>>>\n([\s\S]*?)\n<<<JOURNAL_HANDOFF_BODY_END>>>/);
  assert.ok(m, "'journal-log' の handoff body が見つからない");
  assert.deepEqual(JSON.parse(m[1]).telemetry?.final_test_flaky, { files: [RED_FILE], logs: ['/tmp/run-tests-v/0.log'] });
});

test('[summary-test-cell] (d2) Validate red + 再実行も red（flake なし）→ テスト欄 ❌ red・merge tier HOLD（validate_test_red）', async () => {
  const { result, calls, testCell } = await run({ ...validateRed(), 'test#validate-rerun': { tests: 'failed', green: false, summary: 'still red', failed_files: [RED_FILE] } });
  assert.equal(calls.filter((c) => c.label === 'test#validate-rerun').length, 1);
  assert.equal(testCell, '❌ red');
  assert.equal(result?.validate_tests, 'failed');
  assert.equal(result?.test_green, false);
  assert.equal(result?.final_test_flaky, null);
  // テスト欄 ❌ red の run は merge tier も HOLD（validate_test_red。Final reconcile skipped で Validate の red が残る。issue #1086）
  assert.equal(result?.final_reconcile, 'skipped');
  assert.equal(result?.merge_tier, 'HOLD');
  assert.ok((result?.merge_tier_hold_reasons ?? []).some((r) => r.code === 'validate_test_red' && r.kind === 'human_judgment'), tierFacts(result));
});

test('[summary-test-cell] (e) test#validate-rerun: failed_files が空・欠落・安全に渡せないパスの red は再実行せず validate_test_red', async () => {
  for (const [name, extra] of Object.entries({ empty: { failed_files: [] }, missing: { failed_files: undefined }, unsafe: { failed_files: [RED_FILE, 'b c.bats'] } })) {
    const { result, calls, testCell } = await run(validateRed(extra));
    assert.ok(!calls.some((c) => c.label === 'test#validate-rerun'), `${name}: test#validate-rerun を呼んではならない`);
    assert.equal(result?.final_test_flaky, null, name);
    assert.equal(testCell, '❌ red', name);
    assert.ok(holdCodes(result).includes('validate_test_red'), `${name}: ${tierFacts(result)}`);
  }
});

test('[summary-test-cell] (e) test#validate-rerun: 再実行の throw / null / red / error は結果を使わず validate_test_red（run は完走）', async () => {
  const variants = {
    throw: () => { throw new Error('EPERM'); },
    null: null,
    red: { tests: 'failed', green: false, summary: 'still red', failed_files: [RED_FILE] },
    error: { tests: 'error', green: false, summary: 'run-tests did not return JSON' },
  };
  for (const [name, rerun] of Object.entries(variants)) {
    const { result, calls } = await run({ ...validateRed(), 'test#validate-rerun': rerun });
    assert.equal(calls.filter((c) => c.label === 'test#validate-rerun').length, 1, `${name}: 再実行は 1 回だけ`);
    assert.equal(result?.final_test_flaky, null, name);
    assert.equal(result?.merge_tier, 'HOLD', `${name}: ${tierFacts(result)}`);
    assert.ok(holdCodes(result).includes('validate_test_red'), `${name}: ${tierFacts(result)}`);
  }
});

test('[summary-test-cell] (e) test#validate-rerun は Final reconcile が skip で Validate が red の run だけ（Final reconcile 実行・Validate が error / green の run では呼ばない）', async () => {
  const finalRun = await run({ ...validateRed(), 'reconcile-sync': { ok: true, head: 'a'.repeat(40) } }, async () => ({ status: 'lgtm', iterations: 2, fixes_applied: 1 }));
  assert.equal(finalRun.result?.final_reconcile, 'reverified', '前提: Final reconcile が最終 tree を再検証する run');
  assert.ok(!finalRun.calls.some((c) => c.label === 'test#validate-rerun'), 'Final reconcile が走る run では Validate の red を再実行しない');
  for (const [name, overrides] of Object.entries({ error: {}, green: { 'test#1': { tests: 'passed', green: true, summary: '' } } })) {
    const { calls } = await run(overrides);
    assert.ok(!calls.some((c) => c.label === 'test#validate-rerun'), `${name}: test#validate-rerun を呼んではならない`);
  }
});

test("[summary-test-cell] (h) 返り値: Validate tests:'error' → validate_tests:'error'、test_green / final_test_green は不変", async () => {
  const { result } = await run();
  assert.equal(result?.validate_tests, 'error');
  assert.equal(result?.test_green, false, 'test_green は Validate の green のまま');
  assert.equal(result?.final_test_green, null, 'Final reconcile skipped の run は final_test_green null のまま');
});

test('[summary-test-cell] (i) Setup(deps) が ok:false の run は validate_tests_not_run の文言に deps の note が載る', async () => {
  const note = 'pnpm install failed: EPERM .gitmodules';
  const { result } = await run({}, undefined, { args: devFlowArgs(1, { deps: { ok: false, note } }) });
  assert.equal(result?.merge_tier, 'HOLD');
  assert.ok(notRunCodes(result)[0]?.reason.includes('Setup(deps) ok:false: ' + note), tierFacts(result));
});

test("[summary-test-cell] (h) 返り値: Validate tests:'passed' → validate_tests:'passed' + test_green true", async () => {
  const { result } = await run({ 'test#1': { tests: 'passed', green: true, summary: '' } });
  assert.equal(result?.validate_tests, 'passed');
  assert.equal(result?.test_green, true);
  assert.equal(result?.final_test_green, null);
});

test('[summary-test-cell] (h) dev-flow SKILL.md に返り値 validate_tests / final_test_flaky の読み方が載っている', () => {
  const skillMd = readFileSync(join(here, '..', 'dev-flow', 'SKILL.md'), 'utf8');
  const section = skillMd.slice(skillMd.indexOf('## 完了後の返り値の読み方'));
  assert.ok(skillMd.includes('## 完了後の返り値の読み方'), '「完了後の返り値の読み方」節がある');
  assert.ok(skillMd.indexOf('## 完了後の返り値の読み方') > skillMd.indexOf('4. **Workflow 起動**'), '手順 4 の後に置く');
  for (const token of ['`validate_tests`', '`final_test_flaky`', '`validate_tests_not_run`', '`validate_test_red`']) {
    assert.ok(section.includes(token), `節に ${token} を含む`);
  }
});
