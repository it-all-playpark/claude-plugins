// run-tests-prompt.test.mjs — run-tests の start → wait（繰り返し）→ 結果（issue #1225）。
// 前半は偽の spawn で runTestsJob の待機・打ち切り・応答の検証を見る。後半は dev-flow.js / pr-iterate.js を VM で動かし、
// テスト実行の各 spawn がこの形で待つこと・null / schema 不一致が tests:'error' で HOLD に流れることを見る。
// 繰り返しそのものは bg-job-wait.test.mjs、run-tests 自身の start / wait / stop は run-tests.bats が見る。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { waitBgJob } from './bg-job-wait.mjs';
import {
  RUN_TESTS_MAX_WAIT_SEC, RUN_TESTS_STOP_SCHEMA, RUN_TESTS_WAIT_SEC,
  runTestsJob, runTestsPrompt, runTestFilesPrompt, runTestsStopPrompt, runTestsWaitPrompt,
} from './run-tests-prompt.mjs';
import { makeDevFlowSandbox, makePrIterateSandbox, runWorkflowCapture } from './test-helpers/vm-sandbox.mjs';
import { DEV_FLOW_SCENARIOS } from './test-helpers/dev-flow-scenarios.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const devFlowSrc = readFileSync(join(here, '..', '.claude/workflows/dev-flow.js'), 'utf8');
const prIterateSrc = readFileSync(join(here, '..', '.claude/workflows/pr-iterate.js'), 'utf8');

const SCHEMA = {
  type: 'object', required: ['tests', 'green'],
  properties: {
    status: { type: 'string', enum: ['running', 'passed', 'failed', 'error'] },
    tests: { type: 'string', enum: ['running', 'passed', 'failed', 'no_tests', 'error'] },
    green: { type: 'boolean' },
    summary: { type: 'string' },
  },
};
const RUNNING = { status: 'running', tests: 'running', green: false, summary: '', log_path: '/wt/log' };
const PASSED = { status: 'passed', tests: 'passed', green: true, summary: 'passed: x', scripts: [], failed_files: [], epoch: 1 };
const FAILED = { status: 'failed', tests: 'failed', green: false, summary: 'failed: x', scripts: [], failed_files: ['a.bats'], epoch: 1 };
const STOPPED = { ok: true, stopped: true, was_running: true };
const POLLS = RUN_TESTS_MAX_WAIT_SEC / RUN_TESTS_WAIT_SEC;

// label → 応答（関数なら throw も含めて実行）。呼ばれた label と prompt を残す偽の spawn で runTestsJob を走らせる。
async function job(responses) {
  const calls = [];
  const respond = async (prompt, opts) => {
    calls.push({ label: opts.label, prompt, schema: opts.schema });
    const v = responses[opts.label];
    return typeof v === 'function' ? v() : v;
  };
  const run = runTestsJob({ wt: '/wt', startPrompt: 'START', label: 'test#1', schema: SCHEMA, waitJob: waitBgJob, spawn: respond, spawnStop: respond });
  return { calls, run };
}

// ---- 偽の spawn ----

test('[run-tests-prompt] prompt は start / wait / stop の bare 単文で、wait は 1 回の Bash に収まる秒数だけ待つ', () => {
  assert.equal(runTestsPrompt('/wt', 'origin/main').split('\n').at(-1), 'run-tests start /wt --base origin/main');
  assert.equal(runTestFilesPrompt('/wt', 'origin/main', ['a.bats', 'b.bats']).split('\n').at(-1), 'run-tests start /wt --base origin/main --files a.bats b.bats');
  assert.equal(runTestsWaitPrompt('/wt').split('\n').at(-1), `run-tests wait /wt --wait-sec ${RUN_TESTS_WAIT_SEC}`);
  assert.equal(runTestsStopPrompt('/wt').split('\n').at(-1), 'run-tests stop /wt');
  assert.ok(RUN_TESTS_WAIT_SEC < 600, '1 回の wait は Bash の上限 600 秒より短い');
  assert.equal(RUN_TESTS_MAX_WAIT_SEC, 3600);
  // 固定 JSON は stop の schema の必須キーを持つ
  assert.ok(runTestsStopPrompt('/wt').includes('{"ok":false,"error":"run-tests did not return JSON"}'));
  assert.ok(!runTestsStopPrompt('/wt').includes('"tests":"error"'));
});

test('[run-tests-prompt] start が running なら wait を繰り返し、結果の JSON をそのまま返す（stop は呼ばない）', async () => {
  const { calls, run } = await job({ 'test#1': RUNNING, 'test#1.wait-1': RUNNING, 'test#1.wait-2': FAILED });
  assert.equal(await run, FAILED);
  assert.deepEqual(calls.map((c) => c.label), ['test#1', 'test#1.wait-1', 'test#1.wait-2']);
  assert.equal(calls[0].prompt, 'START');
  assert.equal(calls[1].prompt, runTestsWaitPrompt('/wt'));
  assert.equal(calls[1].schema, SCHEMA);
});

test('[run-tests-prompt] 待機の累計が上限に達したら stop を呼び tests:error で終わる（wait は上限 / 1 回の秒数の回数まで）', async () => {
  const responses = { 'test#1': RUNNING, 'test#1.stop': STOPPED };
  for (let k = 1; k <= POLLS + 2; k++) responses[`test#1.wait-${k}`] = RUNNING;
  const { calls, run } = await job(responses);
  const res = await run;
  assert.equal(res.tests, 'error');
  assert.equal(res.green, false);
  assert.ok(res.summary.includes(`${RUN_TESTS_MAX_WAIT_SEC} 秒`), res.summary);
  assert.ok(!res.summary.includes('停止を確認できない'), res.summary);
  const labels = calls.map((c) => c.label);
  assert.equal(labels.filter((l) => l.startsWith('test#1.wait-')).length, POLLS);
  assert.equal(labels.at(-1), 'test#1.stop');
  assert.equal(calls.at(-1).prompt, runTestsStopPrompt('/wt'));
  assert.equal(calls.at(-1).schema, RUN_TESTS_STOP_SCHEMA);
});

test('[run-tests-prompt] 上限で stop の応答が無くても tests:error で終わり、止まったと書かない', async () => {
  const responses = { 'test#1': RUNNING, 'test#1.stop': null };
  for (let k = 1; k <= POLLS; k++) responses[`test#1.wait-${k}`] = RUNNING;
  const { run } = await job(responses);
  const res = await run;
  assert.equal(res.tests, 'error');
  assert.ok(res.summary.includes('停止を確認できない'), res.summary);
});

const MALFORMED = [
  null,
  undefined,
  'passed',
  ['running'],
  {},
  { status: 'passed' },
  { tests: 'passed' },
  { green: true },
  { tests: 'done', green: true },
  { tests: 'passed', green: 'true' },
  { status: 'done', tests: 'passed', green: true },
  // running の形なのに status が無い応答は結果として読まない
  { tests: 'running', green: false },
];

test('[run-tests-prompt] start が null・schema に合わない応答: wait せず stop を呼び tests:error（通ったとみなさない）', async () => {
  for (const bad of MALFORMED) {
    const { calls, run } = await job({ 'test#1': bad, 'test#1.wait-1': PASSED, 'test#1.stop': STOPPED });
    const res = await run;
    assert.equal(res.tests, 'error', JSON.stringify(bad));
    assert.equal(res.green, false, JSON.stringify(bad));
    assert.deepEqual(calls.map((c) => c.label), ['test#1', 'test#1.stop'], JSON.stringify(bad));
  }
});

test('[run-tests-prompt] wait が null・schema に合わない応答: 繰り返しをやめて stop を呼び tests:error', async () => {
  for (const bad of MALFORMED) {
    const { calls, run } = await job({ 'test#1': RUNNING, 'test#1.wait-1': bad, 'test#1.wait-2': PASSED, 'test#1.stop': STOPPED });
    const res = await run;
    assert.equal(res.tests, 'error', JSON.stringify(bad));
    assert.equal(res.green, false, JSON.stringify(bad));
    assert.deepEqual(calls.map((c) => c.label), ['test#1', 'test#1.wait-1', 'test#1.stop'], JSON.stringify(bad));
  }
});

test('[run-tests-prompt] proxy の固定 JSON（status の無い tests:error）は stop を呼んでそのまま返す。run-tests 自身の tests:error は stop しない', async () => {
  const noJson = { tests: 'error', green: false, summary: 'run-tests did not return JSON' };
  const a = await job({ 'test#1': RUNNING, 'test#1.wait-1': noJson, 'test#1.stop': STOPPED });
  assert.equal(await a.run, noJson);
  assert.equal(a.calls.at(-1).label, 'test#1.stop');

  const launchFailed = { status: 'error', tests: 'error', green: false, summary: 'launch failed' };
  const b = await job({ 'test#1': RUNNING, 'test#1.wait-1': launchFailed });
  assert.equal(await b.run, launchFailed);
  assert.equal(b.calls.at(-1).label, 'test#1.wait-1');
});

test('[run-tests-prompt] start / wait の spawn の throw: stop を呼んで投げ直す（throw の扱いは呼び出し側）', async () => {
  const boom = () => { throw new Error('injected'); };
  for (const responses of [{ 'test#1': boom }, { 'test#1': RUNNING, 'test#1.wait-1': boom }]) {
    const { calls, run } = await job({ ...responses, 'test#1.stop': STOPPED });
    await assert.rejects(run, /injected/);
    assert.equal(calls.at(-1).label, 'test#1.stop');
  }
});

// ---- dev-flow.js の配線 ----

async function runFlow(overrides, { fixesApplied = 0 } = {}) {
  const { ctx, calls } = makeDevFlowSandbox({
    overrides,
    workflow: async () => ({ status: 'lgtm', iterations: 1, fixes_applied: fixesApplied }),
  });
  const { result, error } = await runWorkflowCapture(devFlowSrc, ctx);
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  return { result, calls, labels: calls.map((c) => c.label) };
}

const SYNC_OK = { 'reconcile-sync': { ok: true, head: 'a'.repeat(40) }, 'changed-files-final': { files: [] } };
const RED_FILE = { ...FAILED, failed_files: ['a.bats'] };

// 上限まで wait が running を返す overrides（`${label}.wait-<k>`）
function capped(label) {
  const o = { [label]: RUNNING, [`${label}.stop`]: STOPPED };
  for (let k = 1; k <= POLLS + 2; k++) o[`${label}.wait-${k}`] = RUNNING;
  return o;
}

// Validate が tests:'error' で終わった run（Final reconcile は skip）は validate_tests_not_run の HOLD
function assertValidateTestsNotRun(result) {
  assert.equal(result.validate_tests, 'error');
  assert.equal(result.merge_tier, 'HOLD');
  assert.ok(result.merge_tier_hold_reasons.some((r) => r.code === 'validate_tests_not_run'), JSON.stringify(result.merge_tier_hold_reasons));
}

test('[run-tests-prompt] test#i: start の spawn 1 回のあと wait を繰り返し、最後の結果で Validate を判定する', async () => {
  const { result, calls, labels } = await runFlow({ 'test#1': RUNNING, 'test#1.wait-1': RUNNING, 'test#1.wait-2': PASSED });
  assert.deepEqual(labels.filter((l) => l.startsWith('test#')), ['test#1', 'test#1.wait-1', 'test#1.wait-2']);
  assert.equal(calls.find((c) => c.label === 'test#1').prompt.split('\n').at(-1), `run-tests start /tmp/wt --base origin/main`);
  const w = calls.find((c) => c.label === 'test#1.wait-1');
  assert.equal(w.prompt, runTestsWaitPrompt('/tmp/wt'));
  assert.equal(w.agentType, 'dev-flow:dev-runner-haiku');
  assert.deepEqual([...w.schema.required], ['tests', 'green']);
  assert.equal(result.validate_tests, 'passed');
  assert.ok(!(result.merge_tier_hold_reasons ?? []).some((r) => r.code === 'validate_tests_not_run'), JSON.stringify(result.merge_tier_hold_reasons));
});

test('[run-tests-prompt] test#i: 待機の上限に達したら stop を呼び tests:error（green-fix せず validate_tests_not_run の HOLD）', async () => {
  const { result, labels } = await runFlow(capped('test#1'));
  assert.equal(labels.filter((l) => l.startsWith('test#1.wait-')).length, POLLS);
  assert.ok(labels.includes('test#1.stop'), labels.join(', '));
  assert.ok(!labels.includes('green-fix#1'), labels.join(', '));
  assertValidateTestsNotRun(result);
});

test('[run-tests-prompt] test#i: start / wait が null・schema に合わない応答なら tests:error で HOLD（通ったとみなさない）', async () => {
  for (const overrides of [
    { 'test#1': null, 'test#1.stop': STOPPED },
    { 'test#1': { green: true }, 'test#1.stop': STOPPED },
    { 'test#1': RUNNING, 'test#1.wait-1': null, 'test#1.stop': STOPPED },
    { 'test#1': RUNNING, 'test#1.wait-1': { tests: 'passed' }, 'test#1.stop': STOPPED },
  ]) {
    const { result, labels } = await runFlow(overrides);
    assert.ok(labels.includes('test#1.stop'), labels.join(', '));
    assert.ok(!labels.includes('green-fix#1'), labels.join(', '));
    assertValidateTestsNotRun(result);
  }
});

test('[run-tests-prompt] test#retry-i / test#post-eval-i も start → wait で待つ', async () => {
  // empty-diff gate の差し戻しで test#retry-1 に入る
  const retry = await runFlow({
    'diff-gate': { hash: 'EMPTY', empty: true }, 'diff-gate-retry': { hash: 'AAA', empty: false },
    'test#retry-1': RUNNING, 'test#retry-1.wait-1': PASSED,
  });
  assert.ok(retry.labels.includes('test#retry-1') && retry.labels.includes('test#retry-1.wait-1'), retry.labels.join(', '));

  // Evaluate の差し戻しで test#post-eval-1 に入る
  const postEval = await runFlow({
    ...DEV_FLOW_SCENARIOS['complex-fix'].overrides,
    'test#post-eval-1': RUNNING, 'test#post-eval-1.wait-1': PASSED,
  });
  assert.ok(postEval.labels.includes('test#post-eval-1') && postEval.labels.includes('test#post-eval-1.wait-1'), postEval.labels.join(', '));
});

test('[run-tests-prompt] test#final: start → wait で待ち、結果の green で reverified にする', async () => {
  const { result, labels } = await runFlow({ ...SYNC_OK, 'test#final': RUNNING, 'test#final.wait-1': PASSED }, { fixesApplied: 1 });
  assert.ok(labels.includes('test#final.wait-1'), labels.join(', '));
  assert.equal(result.final_reconcile, 'reverified');
  assert.equal(result.final_test_green, true);
});

test('[run-tests-prompt] test#final: 待機の上限・null・schema に合わない応答は final_reconcile unavailable の HOLD', async () => {
  for (const overrides of [
    capped('test#final'),
    { 'test#final': null, 'test#final.stop': STOPPED },
    { 'test#final': RUNNING, 'test#final.wait-1': { tests: 'passed' }, 'test#final.stop': STOPPED },
  ]) {
    const { result, labels } = await runFlow({ ...SYNC_OK, ...overrides }, { fixesApplied: 1 });
    assert.ok(labels.includes('test#final.stop'), labels.join(', '));
    assert.equal(result.final_reconcile, 'unavailable');
    assert.equal(result.final_test_green, null);
    assert.equal(result.merge_tier, 'HOLD');
  }
});

test('[run-tests-prompt] test#final-rerun / test#validate-rerun: start → wait で待ち、green のときだけ flake 候補にする（HOLD は外さない）', async () => {
  const final = await runFlow({
    ...SYNC_OK, 'test#final': RED_FILE,
    'test#final-rerun': RUNNING, 'test#final-rerun.wait-1': RUNNING, 'test#final-rerun.wait-2': PASSED,
  }, { fixesApplied: 1 });
  assert.ok(final.labels.includes('test#final-rerun.wait-2'), final.labels.join(', '));
  assert.ok(final.result.final_test_flaky?.files?.includes('a.bats'), JSON.stringify(final.result.final_test_flaky));
  assert.equal(final.result.merge_tier, 'HOLD');

  const validate = await runFlow({
    'test#1': { ...RED_FILE }, 'test#2': { ...RED_FILE }, 'test#3': { ...RED_FILE }, 'test#4': { ...RED_FILE }, 'test#5': { ...RED_FILE },
    'test#validate-rerun': RUNNING, 'test#validate-rerun.wait-1': PASSED,
  });
  assert.ok(validate.labels.includes('test#validate-rerun.wait-1'), validate.labels.join(', '));
  assert.ok(validate.result.final_test_flaky?.files?.includes('a.bats'), JSON.stringify(validate.result.final_test_flaky));
  assert.equal(validate.result.merge_tier, 'HOLD');
});

test('[run-tests-prompt] 再実行が上限・応答なしなら flake 候補にしない', async () => {
  for (const overrides of [capped('test#final-rerun'), { 'test#final-rerun': null, 'test#final-rerun.stop': STOPPED }]) {
    const { result } = await runFlow({ ...SYNC_OK, 'test#final': RED_FILE, ...overrides }, { fixesApplied: 1 });
    assert.equal(result.final_test_flaky ?? null, null);
    assert.equal(result.merge_tier, 'HOLD');
  }
});

// ---- references ----

test('[run-tests-prompt] pipeline.md の Validate / Final reconcile と exec-proxy.md のテスト実行の proxy は start / wait に分けた形を書く', () => {
  const references = join(here, '..', 'dev-flow/references');
  const pipeline = readFileSync(join(references, 'pipeline.md'), 'utf8');
  const validate = pipeline.slice(pipeline.indexOf('## Validate'), pipeline.indexOf('## Diff triage'));
  for (const token of ['`run-tests start <WT> --base origin/<base>`', '`run-tests wait <WT>`', '`runTestsJob`', 'stop']) {
    assert.ok(validate.includes(token), `pipeline.md の Validate に ${token} が無い`);
  }
  const finalReconcile = pipeline.slice(pipeline.indexOf('## Final reconcile'));
  assert.ok(finalReconcile.includes('Validate と同じ start / wait'), 'pipeline.md の Final reconcile が start / wait の形でない');

  const execProxy = readFileSync(join(references, 'exec-proxy.md'), 'utf8').split('\n');
  const validateRow = execProxy.find((l) => l.startsWith('| validate-test'));
  for (const token of ['`run-tests start`', '`wait`', '`<label>.wait-<k>`', '`<label>.stop`', '`RUN_TESTS_MAX_WAIT_SEC`']) {
    assert.ok(validateRow.includes(token), `exec-proxy.md の validate-test に ${token} が無い`);
  }
  assert.ok(execProxy.find((l) => l.startsWith('| final-reconcile')).includes('validate-test と同じ形'), 'exec-proxy.md の final-reconcile が validate-test を指していない');
});

// ---- pr-iterate.js の終端 head の全件テスト ----

const HOLD_HEAD = 'a'.repeat(40);
const END_HEAD = 'b'.repeat(40);

async function runHold(overrides) {
  const { ctx, calls } = makePrIterateSandbox({
    args: {
      pr: 5,
      nested: { caller: 'standalone', cwd: '/repo-wt/pr-5', head_ref: 'feature/x', head_sha: END_HEAD, base_ref: 'main', repo: 'acme/skills', epoch: 4242 },
      prior_devflow: { tier: 'HOLD', codes: ['final_test_red'], url: 'https://github.com/acme/skills/pull/5#issuecomment-1', head_sha: HOLD_HEAD },
    },
    overrides: { 'hold-test-diff': { ok: true, outside: 0, files: ['tests/a.bats'] }, ...overrides },
  });
  const { error } = await runWorkflowCapture(prIterateSrc, ctx, '.claude/workflows/pr-iterate.js');
  assert.equal(error, null, error?.message);
  return { calls, labels: calls.map((c) => c.label), post: calls.find((c) => c.label === 'post-summary').prompt };
}

test('[run-tests-prompt] hold-test-run: start → wait で待ち、結果を終端サマリーに載せる', async () => {
  const { labels, calls, post } = await runHold({ 'hold-test-run': RUNNING, 'hold-test-run.wait-1': RUNNING, 'hold-test-run.wait-2': PASSED });
  assert.deepEqual(labels.filter((l) => l.startsWith('hold-test-run')), ['hold-test-run', 'hold-test-run.wait-1', 'hold-test-run.wait-2']);
  assert.equal(calls.find((c) => c.label === 'hold-test-run.wait-1').prompt, runTestsWaitPrompt('/repo-wt/pr-5'));
  assert.ok(post.includes('最終 tree の全件テスト（run-tests 1 回）: passed'), post);
});

test('[run-tests-prompt] hold-test-run: 待機の上限・null・schema に合わない応答・throw は stop を呼び「実行できなかった」と出す', async () => {
  const boom = () => { throw new Error('injected'); };
  for (const overrides of [
    capped('hold-test-run'),
    { 'hold-test-run': null, 'hold-test-run.stop': STOPPED },
    { 'hold-test-run': boom, 'hold-test-run.stop': STOPPED },
    { 'hold-test-run': RUNNING, 'hold-test-run.wait-1': { tests: 'passed' }, 'hold-test-run.stop': STOPPED },
  ]) {
    const { labels, post } = await runHold(overrides);
    assert.ok(labels.includes('hold-test-run.stop'), labels.join(', '));
    assert.ok(post.includes('最終 tree の全件テスト（run-tests 1 回）: 実行できなかった'), post);
  }
});
