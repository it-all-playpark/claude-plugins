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
//   (f) Validate red（failed_files 非空）+ fixes_applied=0 + 単体再実行（test#validate-rerun）green → final_test_flaky に記録・
//       validate_test_red の HOLD は不変・テスト欄は '❌ red（単体再実行は green — flake 候補）'（issue #1138）
//   (g) Validate red でもファイルが空・安全に渡せないパス・再実行の throw / null / red は記録しない（HOLD 不変）
//   (h) Validate red の落ちたファイル・diff の一覧・base 再実行の結果が validate_test_red の行の件数と対応列に届く
//       （証拠あり → 修正が必要 / 証拠なし → 原因未確定。issue #1248）

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
const VALIDATE_RED_CURRENT = '| Validate のテスト失敗が残ったまま PR へ進行（pr-iterate の fix 0 件で最終 tree の再検証なし）';
const RED_UNKNOWN = '原因未確定 — 人が確認して判断する';
// validate-diff#N の既定応答は null（diff 一覧の取得失敗）— base 再実行をせず、落ちたファイルはすべて base で確かめていない
const noDiffNote = (files) => ` — 落ちたテストファイル ${files.length} 件: diff との照合なし（一覧の取得失敗）・`
  + `base 再実行で base では同じように落ちなかった 0 件・base でも同じように落ちた 0 件・base で確かめていない ${files.length} 件`
  + `（落ちたファイル: ${files.map((f) => `\`${f}\``).join(', ')}）`;

async function run(overrides = {}, workflow, extra) {
  const { ctx, calls } = makeDevFlowSandbox({ overrides: { ...SCENARIO.overrides, ...overrides }, workflow, extra });
  const { result, error } = await runWorkflowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'summary-test-cell');
  assert.equal(error, null, `run は完走するはずだが ${error?.message}`);
  const post = calls.find((c) => c.label === 'post-summary');
  assert.ok(post, 'post-summary が呼ばれるはず');
  const body = post.prompt.slice(post.prompt.indexOf('<<<DEV_FLOW_BODY_BEGIN>>>'), post.prompt.indexOf('<<<DEV_FLOW_BODY_END>>>'));
  const glance = body.split('\n').find((l) => l.startsWith('| ') && /\*\*(HOLD|REVIEW)\*\*/.test(l));
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
  const { result, testCell, body } = await run({ 'test#1': red, 'test#2': red, 'test#3': red });
  // failed_files が取れない red は落ちたファイルを特定できなかったと書き、原因未確定にする（issue #1248）
  assert.ok(body.includes(`${VALIDATE_RED_CURRENT} — 落ちたテストファイルを特定できなかった（failed_files が空） | ${RED_UNKNOWN} |`), body);
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

// (f)〜(g) Final reconcile skipped の run の Validate red は、落ちたファイルだけを 1 回流し直して flake 候補を
// validate_test_red の HOLD に添える（HOLD は外さない。issue #1138）
const VALIDATE_RED_FILES = {
  tests: 'failed', green: false,
  summary: 'failed: /tmp/wt/tests/run-all-bats.sh (exit 1, log: /tmp/run-tests-v/0.log)\nnot ok 3 ready-set',
  failed_files: ['plugins/dev-flow/_lib/ready-set.bats'],
};
const validateRedRun = (first, rerun) => {
  // green-fix 後も red のまま（GREEN_MAX 到達）にする
  const o = { 'test#1': first, 'test#2': first, 'test#3': first };
  if (rerun !== undefined) o['test#validate-rerun'] = rerun;
  return run(o);
};
const validateReruns = (calls) => calls.filter((c) => c.label === 'test#validate-rerun');

test('[summary-test-cell] (f) Validate red + 単体再実行 green → final_test_flaky に記録、validate_test_red の HOLD は変えずテスト欄は red に flake 候補を添える', async () => {
  const { result, calls, body, testCell } = await validateRedRun(VALIDATE_RED_FILES, { tests: 'passed', green: true, summary: 'passed' });
  assert.equal(result?.final_reconcile, 'skipped');
  const reruns = validateReruns(calls);
  assert.equal(reruns.length, 1, `test#validate-rerun は 1 回だけ: ${reruns.length}`);
  assert.equal(reruns[0].agentType, 'dev-flow:dev-runner-haiku');
  assert.equal(reruns[0].prompt.split('\n').at(-1), 'run-tests start /tmp/wt --base origin/main --files plugins/dev-flow/_lib/ready-set.bats');
  assert.ok(!calls.some((c) => c.label === 'test#final' || c.label === 'test#final-rerun'), 'skip の run は test#final を回さない');
  assert.deepEqual(JSON.parse(JSON.stringify(result?.final_test_flaky)), {
    files: ['plugins/dev-flow/_lib/ready-set.bats'],
    logs: ['/tmp/run-tests-v/0.log'],
  });
  assert.equal(result?.merge_tier, 'HOLD', tierFacts(result));
  assert.deepEqual(holdOf(result, 'validate_test_red').map((r) => r.kind).join(','), 'human_judgment', tierFacts(result));
  assert.equal(testCell, '❌ red（単体再実行は green — flake 候補）');
  assert.ok(body.includes('test flake 候補（単体再実行は green）: plugins/dev-flow/_lib/ready-set.bats'), '参考に flake 候補の開示行が出る');
  assert.ok(body.includes('HOLD は解除しない（validate_test_red のまま'), '開示行に HOLD を解除しない旨が出る');
  // validate_test_red の行の「現状」に Validate の全件実行の failed_files が出る（単体再実行の green で消さない。issue #1181）。
  // 単体再実行の green は原因の証拠にも反証にもしない（issue #1248）
  assert.ok(body.includes(`${VALIDATE_RED_CURRENT}${noDiffNote(VALIDATE_RED_FILES.failed_files)} | ${RED_UNKNOWN} |`), body);
});

test('[summary-test-cell] (g) Validate red でもファイルが空・安全に渡せないパス・再実行の throw / null / red は記録せず、validate_test_red の HOLD のまま', async () => {
  const variants = {
    empty: { first: { ...VALIDATE_RED_FILES, failed_files: [] }, rerun: undefined, reruns: 0, note: ' — 落ちたテストファイルを特定できなかった（failed_files が空）' },
    unsafe: { first: { ...VALIDATE_RED_FILES, failed_files: ['a.bats', 'b c.bats'] }, rerun: undefined, reruns: 0, note: noDiffNote(['a.bats', 'b c.bats']) },
    throw: { first: VALIDATE_RED_FILES, rerun: () => { throw new Error('EPERM'); }, reruns: 1, note: noDiffNote(VALIDATE_RED_FILES.failed_files) },
    null: { first: VALIDATE_RED_FILES, rerun: null, reruns: 1, note: noDiffNote(VALIDATE_RED_FILES.failed_files) },
    // 再実行の failed_files に別のファイルが混ざっても validate_test_red の行は Validate の failed_files のまま（issue #1181）
    red: { first: VALIDATE_RED_FILES, rerun: { tests: 'failed', green: false, summary: 'still red', failed_files: [...VALIDATE_RED_FILES.failed_files, 'tests/rerun-only.bats'] }, reruns: 1, note: noDiffNote(VALIDATE_RED_FILES.failed_files) },
  };
  for (const [name, { first, rerun, reruns, note }] of Object.entries(variants)) {
    const { result, calls, testCell, body } = await validateRedRun(first, rerun);
    assert.ok(body.includes(`${VALIDATE_RED_CURRENT}${note} | ${RED_UNKNOWN} |`), `(g-${name}) ${body}`);
    assert.equal(validateReruns(calls).length, reruns, `(g-${name}) test#validate-rerun の回数`);
    assert.equal(result?.final_test_flaky, null, `(g-${name}) final_test_flaky は null のはず`);
    assert.equal(result?.merge_tier, 'HOLD', `(g-${name}) ${tierFacts(result)}`);
    assert.deepEqual(holdOf(result, 'validate_test_red').map((r) => r.kind).join(','), 'human_judgment', `(g-${name}) ${tierFacts(result)}`);
    assert.equal(testCell, '❌ red', `(g-${name})`);
  }
  // Validate が red でない run（tests:'error'）は再実行しない
  const { calls } = await run(CI_GREEN);
  assert.equal(validateReruns(calls).length, 0, 'Validate tests:error の run は test#validate-rerun を呼ばない');
});

// (h) Validate の最後の全件実行の落ちたファイル・diff の一覧・base 再実行の結果が validate_test_red の行に届き、
// diff が触れたか base では同じように落ちなかったファイルがあるときだけ「修正が必要」になる（issue #1248）
const validateTriageRun = (failedFiles, baseResults, diffLines = ['src/x.ts', 'src/y.ts', 'src/z.ts']) => {
  const red = { tests: 'failed', green: false, summary: 'red', failed_files: failedFiles };
  const o = { 'test#validate-rerun': { tests: 'failed', green: false, summary: 'still red', failed_files: failedFiles } };
  for (const i of [1, 2, 3]) {
    o[`test#${i}`] = red;
    o[`validate-diff#${i}`] = { ok: true, lines: diffLines };
    o[`base-rerun#${i}`] = { results: baseResults };
  }
  return run(o);
};

test('[summary-test-cell] (h) 証拠あり: diff が触れたテスト対象のソース・base 再実行で base では同じように落ちなかったファイルを validate_test_red の行に数え、「修正が必要」・結論行は修正作業が必要', async () => {
  const { result, body, conclusion } = await validateTriageRun(
    ['src/x.test.ts', 'tests/other.bats', 'tests/base.bats', 'tests/unrun.bats'],
    [
      { file: 'tests/other.bats', ran: true, base_failed: false, same_failure: false, summary: 'base では pass' },
      { file: 'tests/base.bats', ran: true, base_failed: true, same_failure: true, summary: 'same' },
      { file: 'tests/unrun.bats', ran: false, base_failed: false, same_failure: false, summary: 'D に無い' },
    ],
  );
  // src/x.test.ts は diff の src/x.ts のテスト（isTestSubjectOf）。tests/other.bats は前の回の base 再実行の結果を引き継ぐ
  assert.ok(body.includes(`${VALIDATE_RED_CURRENT} — 落ちたテストファイル 4 件: diff が触れた 1 件・base 再実行で base では同じように落ちなかった 1 件・`
    + 'base でも同じように落ちた 1 件・base で確かめていない 1 件（落ちたファイル: `src/x.test.ts`, `tests/other.bats`, `tests/base.bats`, `tests/unrun.bats`） | 修正が必要（落ちたテストを直して push する） |'), body);
  assert.equal(conclusion, '**結論: 自動マージ対象外（HOLD）。修正作業が必要です（助言 1 件は任意）。**'); // 助言は green-fix のテスト弱体化監査
  assert.equal(result?.merge_tier, 'HOLD', tierFacts(result));
  assert.equal(holdOf(result, 'validate_test_red').map((r) => r.kind).join(','), 'human_judgment', tierFacts(result));
});

test('[summary-test-cell] (h) 証拠なし: diff が触れず base でも同じように落ちるか base で確かめていないファイルだけの red は原因未確定・結論行は人の確認が必要', async () => {
  const { result, body, conclusion } = await validateTriageRun(
    ['tests/base.bats', 'tests/unrun.bats'],
    [
      { file: 'tests/base.bats', ran: true, base_failed: true, same_failure: true, summary: 'same' },
      { file: 'tests/unrun.bats', ran: false, base_failed: false, same_failure: false, summary: '起動失敗' },
    ],
  );
  assert.ok(body.includes(`${VALIDATE_RED_CURRENT} — 落ちたテストファイル 2 件: diff が触れた 0 件・base 再実行で base では同じように落ちなかった 0 件・`
    + `base でも同じように落ちた 1 件・base で確かめていない 1 件（落ちたファイル: \`tests/base.bats\`, \`tests/unrun.bats\`） | ${RED_UNKNOWN} |`), body);
  assert.equal(conclusion, '**結論: 自動マージ対象外（HOLD）。原因未確定の失敗があり、人の確認が必要です（助言 1 件は任意）。**'); // 助言は green-fix のテスト弱体化監査
  assert.equal(result?.merge_tier, 'HOLD', tierFacts(result));
  assert.equal(holdOf(result, 'validate_test_red').map((r) => r.kind).join(','), 'human_judgment', tierFacts(result));
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
