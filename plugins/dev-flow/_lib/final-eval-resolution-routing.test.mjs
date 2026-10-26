// final-eval-resolution-routing: VM sandbox routing test for dev-flow の Final reconcile における
// EVAL-* blocking item の決定論解消（issue #720）。standard shape（Evaluate 1 パス）で evaluator が
// critical を出し、pr-iterate が fix を適用した run で、fix 後の最終 tree に対する決定論の検証
// （test#final green @ head sha）が成立したときだけ EVAL-* が checked になり、
// ledger_unconverged の HOLD が外れることを pin する。
//
// テストケース:
//   (a) fixes=1 + test#final green → EVAL-* checked（evidence `test#final green @ <sha>`）+ ledger 収束 +
//       ledger_unconverged で HOLD にならない
//   (b) fixes=1 + test#final tests:'error'（unavailable）→ EVAL-* 未 checked + final_reconcile_unavailable と
//       ledger_unconverged の HOLD（PR の CI の success では解消しない。issue #1138）
//   (c) fixes=1 + test#final red → EVAL-* 未 checked + ledger_unconverged の HOLD
//   (d) fixes=1 + test#final null（unavailable）→ EVAL-* 未 checked + ledger_unconverged の HOLD
//   (e) fixes=0 → EVAL-* 未 checked + ledger_unconverged の HOLD（解消経路を適用しない）
//   (f) fixes=1 + test#final green でも Final AC reconcile が AC 不成立 → AC-FINAL-* は未 checked で HOLD
//       （EVAL-* は checked になるが AC-FINAL-* はこの経路で解消しない）

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowSrc = readFileSync(join(repoRoot, '.claude/workflows/dev-flow.js'), 'utf8');

const SHA40 = 'c'.repeat(40);

// eval#1（standard は 1 パス）が critical を 1 件返す → EVAL-1-* が blocking lane に未 checked で残ったまま PR へ進む
const EVAL_CRITICAL = {
  verdict: 'fail', total: 40, threshold: 80,
  feedback: [{ severity: 'critical', topic: 'vitest regression in summary format', description: 'summary の整形が壊れている', dimension: 'correctness' }],
  feedback_level: 'implementation',
  ac_results: [
    { ac_index: 0, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
    { ac_index: 1, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
  ],
  security_clearance: [], concern_resolutions: [], critical_resolutions: [],
};

async function runScenario({ fixesApplied, overrides = {} }) {
  const { ctx, calls, logs } = makeDevFlowSandbox({
    overrides: {
      'eval#1': EVAL_CRITICAL,
      'reconcile-sync': { ok: true, head: SHA40 },
      'changed-files-final': { files: [] },
      ...overrides,
    },
    workflow: async () => ({ status: 'lgtm', iterations: 2, fixes_applied: fixesApplied }),
  });
  const { result, error } = await runWorkflowCapture(devFlowSrc, ctx);
  return { result, error, calls, logs };
}

const holdCodes = (result) => (result?.merge_tier_hold_reasons ?? []).map((r) => r.code);
const evalCheckedLogs = (logs) => logs.filter((l) => /^EVAL-1-/.test(l) && l.includes('checked（issue #720）'));

function assertEvalStillOpen(result, logs, name) {
  assert.equal(result?.shape, 'standard', `(${name}) 前提: shape は standard のはずだが ${result?.shape}`);
  assert.equal(evalCheckedLogs(logs).length, 0, `(${name}) EVAL-* は checked になってはならない: ${JSON.stringify(evalCheckedLogs(logs))}`);
  assert.equal(result?.ledger_converged, false, `(${name}) ledger は未収束のはず`);
  assert.equal(result?.merge_tier, 'HOLD', `(${name}) merge_tier は HOLD のはずだが ${result?.merge_tier}`);
  assert.ok(holdCodes(result).includes('ledger_unconverged'), `(${name}) hold reason に ledger_unconverged が無い: ${JSON.stringify(holdCodes(result))}`);
}

test('[final-eval-resolution] (a) fixes=1 + test#final green → EVAL-* を test#final green @ sha で checked + ledger_unconverged にならない', async () => {
  const { result, error, logs } = await runScenario({ fixesApplied: 1, overrides: { 'test#final': { tests: 'passed', green: true, summary: '' } } });
  assertNoCrash(error, 'a');
  assert.equal(error, null, `(a) run は完走するはず: ${error?.message}`);
  assert.equal(result?.shape, 'standard');
  assert.equal(result?.final_reconcile, 'reverified');
  const checked = evalCheckedLogs(logs);
  assert.equal(checked.length, 1, `(a) EVAL-* が 1 件 checked になるはず: ${JSON.stringify(logs.filter((l) => l.includes('EVAL-')))}`);
  assert.ok(checked[0].includes(`test#final green @ ${SHA40}`), `(a) evidence に test#final green @ <head sha> が無い: ${checked[0]}`);
  assert.equal(result?.ledger_converged, true, '(a) EVAL-* が唯一の未収束要因なので ledger は収束するはず');
  assert.ok(!holdCodes(result).includes('ledger_unconverged'), `(a) ledger_unconverged で HOLD になってはならない: ${JSON.stringify(holdCodes(result))}`);
  assert.equal(result?.merge_tier, 'REVIEW', `(a) merge_tier は REVIEW のはずだが ${result?.merge_tier}（${JSON.stringify(result?.merge_tier_reasons)}）`);
});

test("[final-eval-resolution] (b) fixes=1 + test#final tests:'error'（unavailable）→ EVAL-* 未 checked のまま final_reconcile_unavailable と ledger_unconverged の HOLD", async () => {
  const { result, error, logs } = await runScenario({
    fixesApplied: 1,
    overrides: { 'test#final': { tests: 'error', green: false, summary: 'EPERM — テストは 1 件も実行されていない' } },
  });
  assertNoCrash(error, 'b');
  assert.equal(error, null, `(b) run は完走するはず: ${error?.message}`);
  assert.equal(result?.final_reconcile, 'unavailable');
  assertEvalStillOpen(result, logs, 'b');
  assert.ok(holdCodes(result).includes('final_reconcile_unavailable'), `(b) hold reason に final_reconcile_unavailable が無い: ${JSON.stringify(holdCodes(result))}`);
});


test('[final-eval-resolution] (c) fixes=1 + test#final red → EVAL-* 未 checked のまま ledger_unconverged の HOLD', async () => {
  const { result, error, logs } = await runScenario({ fixesApplied: 1, overrides: { 'test#final': { tests: 'failed', green: false, summary: '1 failed' } } });
  assertNoCrash(error, 'c');
  assert.equal(result?.final_reconcile, 'reverified');
  assert.equal(result?.final_test_green, false);
  assertEvalStillOpen(result, logs, 'c');
});

test('[final-eval-resolution] (d) fixes=1 + test#final null（unavailable）→ EVAL-* 未 checked のまま ledger_unconverged の HOLD', async () => {
  const { result, error, logs } = await runScenario({ fixesApplied: 1, overrides: { 'test#final': null } });
  assertNoCrash(error, 'd');
  assert.equal(result?.final_reconcile, 'unavailable');
  assertEvalStillOpen(result, logs, 'd');
});

test('[final-eval-resolution] (e) fixes=0 → 解消経路を適用せず EVAL-* 未 checked のまま ledger_unconverged の HOLD', async () => {
  const { result, error, logs, calls } = await runScenario({ fixesApplied: 0 });
  assertNoCrash(error, 'e');
  assert.equal(result?.final_reconcile, 'skipped');
  assert.ok(!calls.some((c) => c.label === 'test#final'), '(e) fixes=0 で test#final は呼ばれない');
  assertEvalStillOpen(result, logs, 'e');
});

test('[final-eval-resolution] (f) fixes=1 + test#final green でも AC-FINAL-* はこの経路で checked にならず HOLD', async () => {
  const { result, error, logs } = await runScenario({
    fixesApplied: 1,
    overrides: {
      'test#final': { tests: 'passed', green: true, summary: '' },
      'final-ac-reconcile': {
        ac_results: [
          { ac_index: 0, satisfied: false, verified_by: 'inspection', evidence: 'fix で退行' },
          { ac_index: 1, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
        ],
      },
    },
  });
  assertNoCrash(error, 'f');
  assert.equal(result?.final_ac_reconcile, 'reverified');
  assert.equal(evalCheckedLogs(logs).length, 1, '(f) EVAL-* 自体は checked になるはず');
  assert.ok(logs.some((l) => l.startsWith('AC-FINAL-1:')), `(f) 前提: AC-FINAL-1 が append されていない: ${JSON.stringify(logs.filter((l) => l.includes('AC-FINAL')))}`);
  assert.ok(!logs.some((l) => /^AC-FINAL-.*checked（issue #720）/.test(l)), '(f) AC-FINAL-* はこの経路で checked になってはならない');
  assert.equal(result?.ledger_converged, false, '(f) AC-FINAL-1 が未 checked のため ledger は未収束のはず');
  assert.equal(result?.merge_tier, 'HOLD');
  assert.ok(holdCodes(result).includes('ledger_unconverged'), `(f) hold reason に ledger_unconverged が無い: ${JSON.stringify(holdCodes(result))}`);
});
