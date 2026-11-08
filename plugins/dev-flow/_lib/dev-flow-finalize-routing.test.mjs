// dev-flow.js（orchestrator）と pr-iterate 後の工程の workflow（dev-flow-finalize.js）の境界の routing test（issue #1262）。
//   - 親は workflow('dev-flow:dev-flow-finalize-run') を 1 回起動し、子の返り値の result を自分の返り値にする
//   - 子が throw した・返り値の形が不正・引数の形が不正（子が throw）なら、親は merge tier を HOLD にし、終端サマリー未投稿の
//     注記を返り値と log に出す
//   - journal handoff は子が成功・throw・不正な返り値のどれでも親が run ごとにちょうど 1 回行う（子は handoff しない）
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, runWorkflowCapture } from './test-helpers/vm-sandbox.mjs';
import { FINALIZE_ARGS_SPEC, stageShapeErrors } from './stage-contract.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const devFlowSrc = readFileSync(join(here, '..', '.claude', 'workflows', 'dev-flow.js'), 'utf8');
const FINALIZE = 'dev-flow:dev-flow-finalize-run';

// 既定 run（standard・pr-iterate は lgtm / fixes_applied:0）。stage(name, wargs, chained) で工程の workflow の起動を差し替える。
async function runWith(stage) {
  const { ctx, calls, logs } = makeDevFlowSandbox();
  const chained = ctx.workflow;
  const stageCalls = [];
  ctx.workflow = async (name, wargs) => {
    if (name !== FINALIZE) return chained(name, wargs);
    stageCalls.push(wargs);
    return stage(wargs, (a) => chained(name, a));
  };
  const { result, error } = await runWorkflowCapture(devFlowSrc, ctx);
  return { result, error, calls, logs, stageCalls };
}

function journalPayloads(calls) {
  return calls.filter((c) => c.label.startsWith('journal-')).map((c) => {
    const m = c.prompt.match(/<<<JOURNAL_HANDOFF_BODY_BEGIN>>>\n([\s\S]*?)\n<<<JOURNAL_HANDOFF_BODY_END>>>/);
    assert.ok(m, `${c.label} の prompt に handoff の本文が無い`);
    return { label: c.label, payload: JSON.parse(m[1]) };
  });
}

test('[finalize] 成功: 工程の workflow を 1 回起動し、その result に journal_log_status を足して返す。handoff は 1 回', async () => {
  let childReturn = null;
  const { result, error, calls, stageCalls } = await runWith(async (wargs, run) => {
    childReturn = await run(wargs);
    return childReturn;
  });
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  assert.equal(stageCalls.length, 1);
  assert.deepEqual(stageShapeErrors(JSON.parse(JSON.stringify(stageCalls[0])), FINALIZE_ARGS_SPEC), [], '親が渡す引数が FINALIZE_ARGS_SPEC を満たさない');
  assert.deepEqual(JSON.parse(JSON.stringify(result)), JSON.parse(JSON.stringify({ ...childReturn.result, journal_log_status: 'logged' })));
  assert.equal(result.merge_tier, 'REVIEW');
  assert.ok(calls.some((c) => c.label === 'post-summary'), '子が終端サマリーを投稿していない');

  const handoffs = journalPayloads(calls);
  assert.deepEqual(handoffs.map((h) => h.label), ['journal-log']);
  const [{ payload }] = handoffs;
  assert.equal(payload.skill, 'dev-flow');
  assert.equal(payload.outcome, 'success');
  assert.equal(payload.telemetry.merge_tier, childReturn.handoff.merge_tier);
  // handoff は post-summary（子）の後に親が 1 回
  assert.ok(calls.findIndex((c) => c.label === 'journal-log') > calls.findIndex((c) => c.label === 'post-summary'));
});

function assertFinalizeHold({ result, error, calls, logs }, errorPattern) {
  assert.equal(error, null, `工程の workflow の失敗で dev-flow が abort した: ${error?.message}`);
  assert.equal(result.merge_tier, 'HOLD');
  assert.equal(result.summary_posted, false);
  assert.match(result.finalize_error, errorPattern);
  assert.match(result.note, /終端サマリー未投稿/);
  assert.ok(result.merge_tier_reasons.some((r) => errorPattern.test(r)), JSON.stringify(result.merge_tier_reasons));
  assert.ok(logs.some((l) => /終端サマリー未投稿/.test(l) && errorPattern.test(l)), `log に終端サマリー未投稿の注記が無い: ${logs.filter((l) => l.includes('finalize')).join(' | ')}`);

  const handoffs = journalPayloads(calls);
  assert.deepEqual(handoffs.map((h) => h.label), ['journal-log'], 'handoff は親が 1 回だけ（abort handoff を足さない）');
  const [{ payload }] = handoffs;
  assert.equal(payload.skill, 'dev-flow');
  assert.equal(payload.outcome, 'failure');
  assert.equal(payload.error_category, 'finalize_failed');
  assert.equal(payload.error_phase, 'Final reconcile');
  assert.equal(payload.telemetry.merge_tier, 'HOLD');
  assert.equal(payload.telemetry.shape, result.shape);
  assert.equal(payload.telemetry.route, result.route);
}

test('[finalize] 子が throw: merge tier を HOLD にし、終端サマリー未投稿の注記を返り値と log に出す。handoff は親が 1 回', async () => {
  const run = await runWith(async () => { throw new Error('injected finalize crash'); });
  assertFinalizeHold(run, /injected finalize crash/);
});

test('[finalize] 子の返り値の形が不正: throw と同じく HOLD・終端サマリー未投稿・handoff 1 回', async () => {
  const run = await runWith(async () => ({ result: { merge_tier: 'REVIEW' } }));
  assertFinalizeHold(run, /返り値の形が不正/);
  assert.match(run.result.finalize_error, /handoff: 欠落/);
});

test('[finalize] 子が引数の欠落で throw（validateStageArgs）: 親は HOLD で返し、handoff は 1 回', async () => {
  const run = await runWith(async (wargs, chained) => {
    const { state: _dropped, ...rest } = wargs;
    return chained(rest);
  });
  assertFinalizeHold(run, /引数の形が不正 — state: 欠落/);
});

test('[finalize] 子が引数の型違いで throw（validateStageArgs）: 親は HOLD で返し、handoff は 1 回', async () => {
  const run = await runWith(async (wargs, chained) => chained({ ...wargs, issue: Number(wargs.issue) }));
  assertFinalizeHold(run, /引数の形が不正 — issue: string が必要（受信: number）/);
});
