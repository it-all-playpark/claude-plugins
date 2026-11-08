// dev-flow.js（orchestrator）と Diff triage・Evaluate の工程の workflow（dev-flow-evaluate.js）の境界の routing test（issue #1263）。
//   - 親は workflow('dev-flow:dev-flow-evaluate-run') を 1 回起動し、子の返り値の state で PR 工程に進む
//   - 子が throw した・返り値の形が不正・引数の形が不正（子が throw）なら、親は評価を通ったものとして扱わず、PR を作らずに
//     HOLD で終え、評価できなかったことを返り値と log に出す
//   - journal handoff は子が失敗した run でも親が 1 回だけ行う（子は handoff しない。abort handoff も書かない）
//   - Validate と共有する実装 spawn・test ⇄ green-fix ループは両方の workflow が同じ canonical を inline する
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, runWorkflowCapture, STANDARD_FILES } from './test-helpers/vm-sandbox.mjs';
import { scanMarkers } from '../../../tools/sync-inlines.mjs';
import { EVALUATE_ARGS_SPEC, stageShapeErrors } from './stage-contract.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const workflowDir = join(here, '..', '.claude', 'workflows');
const devFlowSrc = readFileSync(join(workflowDir, 'dev-flow.js'), 'utf8');
const EVALUATE = 'dev-flow:dev-flow-evaluate-run';
const FINALIZE = 'dev-flow:dev-flow-finalize-run';

// stage(wargs, chained) で Diff triage・Evaluate の工程の workflow の起動を差し替える。他の workflow() は既定のまま（つないで実行）。
async function runWith(stage, opts = {}) {
  const { ctx, calls, logs, phases } = makeDevFlowSandbox(opts);
  const chained = ctx.workflow;
  const stageCalls = [];
  const finalizeCalls = [];
  ctx.workflow = async (name, wargs) => {
    if (name === FINALIZE) finalizeCalls.push(JSON.parse(JSON.stringify(wargs)));
    if (name !== EVALUATE) return chained(name, wargs);
    stageCalls.push(wargs);
    return stage(wargs, (a) => chained(name, a));
  };
  const { result, error } = await runWorkflowCapture(devFlowSrc, ctx);
  return { result, error, calls, logs, phases, stageCalls, finalizeCalls };
}

// implement_end の給電（setup_end = args.setup.epoch_end 1050 から 50 秒）。評価できなかった run の handoff にも Implement までの
// phase_durations が載ることを見る
const IMPL_EPOCH = { overrides: { 'impl:serial:issue-1': { status: 'DONE', task_id: 'issue-1', files: [...STANDARD_FILES], summary: 's', concerns: [], epoch: 1100 } } };

function journalPayloads(calls) {
  return calls.filter((c) => c.label.startsWith('journal-')).map((c) => {
    const m = c.prompt.match(/<<<JOURNAL_HANDOFF_BODY_BEGIN>>>\n([\s\S]*?)\n<<<JOURNAL_HANDOFF_BODY_END>>>/);
    assert.ok(m, `${c.label} の prompt に handoff の本文が無い`);
    return { label: c.label, payload: JSON.parse(m[1]) };
  });
}

test('[evaluate] 成功: 工程の workflow を 1 回起動し、返り値の state で PR 工程に進む（shape・評価・security review の対象は子の判定）', async () => {
  let childReturn = null;
  const { result, error, calls, phases, stageCalls, finalizeCalls } = await runWith(async (wargs, run) => {
    childReturn = await run(wargs);
    return childReturn;
  }, { overrides: { 'rg-state-dir': { state_dir: '/tmp/rg-state' } } });
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  assert.equal(stageCalls.length, 1);
  assert.deepEqual(stageShapeErrors(JSON.parse(JSON.stringify(stageCalls[0])), EVALUATE_ARGS_SPEC), [], '親が渡す引数が EVALUATE_ARGS_SPEC を満たさない');
  assert.deepEqual(phases, ['Setup', 'Implement', 'Validate', 'Diff triage', 'Evaluate', 'PR', 'Final reconcile', 'Merge tier']);

  // PR 工程・終端は子の返り値の state を使う
  assert.ok(calls.some((c) => c.label === 'pr#1'), '子の成功後に PR を作っていない');
  assert.equal(result.shape, childReturn.state.EFFECTIVE_SHAPE);
  assert.equal(result.eval_verdict, childReturn.state.evalResult.verdict);
  assert.equal(finalizeCalls.length, 1);
  assert.deepEqual(finalizeCalls[0].state.ledger, JSON.parse(JSON.stringify(childReturn.state.ledger)), 'Final reconcile に渡す ledger が子の返り値と違う');
  assert.equal(finalizeCalls[0].redgreen_state_dir, childReturn.redgreen_state_dir, 'redgreen の state dir を Final reconcile へ渡していない');
  assert.deepEqual(journalPayloads(calls).map((h) => h.label), ['journal-log']);
});

function assertEvaluateHold({ result, error, calls, logs }, errorPattern) {
  assert.equal(error, null, `工程の workflow の失敗で dev-flow が abort した: ${error?.message}`);
  assert.equal(result.status, 'evaluate_failed');
  assert.equal(result.merge_tier, 'HOLD');
  assert.equal(result.pr_url, null);
  assert.match(result.evaluate_error, errorPattern);
  assert.ok(result.merge_tier_reasons.some((r) => errorPattern.test(r)), JSON.stringify(result.merge_tier_reasons));
  assert.match(result.note, /評価できなかった/);
  assert.ok(logs.some((l) => /評価できなかった/.test(l) && errorPattern.test(l)), `log に評価できなかった旨が無い: ${logs.filter((l) => l.includes('evaluate')).join(' | ')}`);
  assert.ok(!calls.some((c) => /^pr#/.test(c.label) || c.label === 'diff-hash-pr'), '評価できなかった run で PR 工程に進んだ');

  const handoffs = journalPayloads(calls);
  assert.deepEqual(handoffs.map((h) => h.label), ['journal-log-failure'], 'handoff は親が 1 回だけ（abort handoff を足さない）');
  const [{ payload }] = handoffs;
  assert.equal(payload.skill, 'dev-flow');
  assert.equal(payload.outcome, 'failure');
  assert.equal(payload.error_category, 'evaluate_failed');
  assert.equal(payload.error_phase, 'Diff triage');
  assert.equal(payload.telemetry.merge_tier, 'HOLD');
  assert.equal(payload.telemetry.phase_durations?.implement, 50, `Implement の所要時間（phase_durations）が載っていない: ${JSON.stringify(payload.telemetry)}`);
}

test('[evaluate] 子が throw: 評価を通ったものとして扱わず、PR を作らずに HOLD。handoff は親が 1 回', async () => {
  const run = await runWith(async () => { throw new Error('injected evaluate crash'); }, IMPL_EPOCH);
  assertEvaluateHold(run, /injected evaluate crash/);
});

test('[evaluate] 子の返り値の形が不正: throw と同じく PR を作らずに HOLD・handoff 1 回', async () => {
  const run = await runWith(async (wargs, chained) => {
    const { state, redgreen_state_dir } = await chained(wargs);
    const { evalResult: _dropped, ...rest } = state;
    return { state: rest, redgreen_state_dir };
  }, IMPL_EPOCH);
  assertEvaluateHold(run, /返り値の形が不正/);
  assert.match(run.result.evaluate_error, /state\.evalResult: 欠落/);
});

test('[evaluate] 子が引数の欠落で throw（validateStageArgs）: 親は PR を作らずに HOLD で返し、handoff は 1 回', async () => {
  const run = await runWith(async (wargs, chained) => {
    const { notes: _dropped, ...rest } = wargs;
    return chained(rest);
  }, IMPL_EPOCH);
  assertEvaluateHold(run, /引数の形が不正 — notes: 欠落/);
});

test('[evaluate] 子が引数の型違いで throw（validateStageArgs）: 親は PR を作らずに HOLD で返し、handoff は 1 回', async () => {
  const run = await runWith(async (wargs, chained) => chained({ ...wargs, state: { ...wargs.state, greenFixCount: String(wargs.state.greenFixCount) } }), IMPL_EPOCH);
  assertEvaluateHold(run, /引数の形が不正 — state\.greenFixCount: number が必要（受信: string）/);
});

test('[evaluate] Validate と共有する実装 spawn・test ⇄ green-fix ループは両方の workflow が _lib/implement-loop.mjs の inline 区間から使う', () => {
  const evaluateSrc = readFileSync(join(workflowDir, 'dev-flow-evaluate.js'), 'utf8');
  for (const [name, src] of [['dev-flow.js', devFlowSrc], ['dev-flow-evaluate.js', evaluateSrc]]) {
    const region = scanMarkers(src, name).find((m) => m.source === '_lib/implement-loop.mjs');
    assert.ok(region, `${name} に _lib/implement-loop.mjs の inline 区間が無い`);
    const lines = src.split('\n');
    const decl = lines.findIndex((l) => /^function makeImplementLoop\(/.test(l));
    assert.ok(decl > region.beginLine && decl < region.endLine, `${name} の makeImplementLoop が inline 区間の外にある（手で複製しない）`);
    assert.ok(/= makeImplementLoop\(\{/.test(src), `${name} が makeImplementLoop で runImplement / runValidateLoop を組んでいない`);
  }
});
