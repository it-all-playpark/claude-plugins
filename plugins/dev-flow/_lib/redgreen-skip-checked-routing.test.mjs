// Issue #444: Evaluate ループ内 per-AC redgreen-verify 起動ガードに、deterministic 昇格済み
// AC への skip 条件を追加する回帰テスト。
//
// VM sandbox で dev-flow.js を読み込み、agent() を label/agentType で stub、log() 捕捉、journal-log prompt から
// telemetry handoff JSON を抽出する makeSandbox パターンと、_lib/eval-convergence.test.mjs（shape:'complex' で
// evaluator 応答を呼び出し回数 index で切り替える responses 配列パターン）を組み合わせる。
//
// このテストファイルは TDD red として作成された。dev-flow.js の W4 ac_results ループ先頭ガードに
// 「acItem.checked === true && acItem.check?.kind === 'deterministic' なら skip」条件を追加する
// 実装完了後に green になる。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { devFlowArgs, runWorkflowCapture, assertNoCrash, devFlowResponder, makeWorkflowContext } from './test-helpers/vm-sandbox.mjs';
import { isRedgreenCall, redgreenBatchResponse } from './test-helpers/redgreen-batch.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');
const src = readFileSync(devFlowPath, 'utf8');

// ---- VM sandbox helper ----

/**
 * redgreen-skip 専用の VM sandbox を組む。
 * evaluator 応答を呼び出し回数の index で切り替え、redgreen-verify.sh バッチ呼び出し（label 'redgreen'、
 * 1 spawn に全 AC ペア）の prompt に載った AC ごとに、ac_index・当該 AC の呼び出し回数（1始まり）別に
 * 記録・応答を切り替える。
 *
 * @param {object[]} evaluatorResponses - evaluator stub が呼び出し回数 index に応じて順に返す応答配列
 * @param {(acIndex:number, callNumber:number) => object} redgreenResponseFor - ac_index(0始まり)・
 *   当該 AC の呼び出し回数(1始まり) を受け取り redgreen stub の返り値を返す
 */
function makeSandbox(evaluatorResponses, redgreenResponseFor) {
  const logs = [];
  const evalCalls = [];
  const redgreenCalls = [];
  const acCallCounts = {};

  const agentStub = async (prompt, opts) => {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';

    if (label.startsWith('danger-grep')) {
      return { ok: true, hits: [] };
    }
    if (label.startsWith('test')) {
      return { tests: 'no_tests', green: true, summary: '' };
    }
    if (agentType === 'dev-flow:evaluator') {
      evalCalls.push({ label, agentType });
      const idx = Math.min(evalCalls.length - 1, evaluatorResponses.length - 1);
      return evaluatorResponses[idx];
    }
    if (isRedgreenCall(agentType, label)) {
      // バッチ呼び出しの prompt に載った AC ペアごとに「当該 AC の呼び出し回数」を数える
      // （skip された AC は prompt に載らないので数えない）。
      const idx = Math.min(evalCalls.length - 1, evaluatorResponses.length - 1);
      return redgreenBatchResponse(prompt, evaluatorResponses[idx].ac_results, (acIndex) => {
        acCallCounts[acIndex] = (acCallCounts[acIndex] ?? 0) + 1;
        const callNumber = acCallCounts[acIndex];
        redgreenCalls.push({ acIndex, callNumber });
        return redgreenResponseFor(acIndex, callNumber);
      });
    }
    if (label === 'post-summary' && agentType === 'dev-flow:dev-runner-haiku') {
      return { posted: true, method: 'gh pr comment', url: 'http://x' };
    }
    if (label === 'journal-log' && agentType === 'dev-flow:dev-runner-haiku') {
      return { logged: true, summary: 'ok' };
    }
    if (agentType === 'dev-flow:dev-implementer') {
      return { status: 'DONE', task_id: 't', files: [], summary: '', concerns: [] };
    }
    return devFlowResponder({ 'commit-hook#1': null, 'commit-hook#post-eval-1': null, 'isolation-probe': null, 'merge-tier-facts': null, 'security-scope': null })({ label, agentType, prompt });
  };

  const workflowStub = async () => ({ status: 'lgtm', iterations: 1, fixes_applied: 0 });

  const ctx = makeWorkflowContext({
    log: (m) => logs.push(String(m)),
    agent: agentStub,
    workflow: workflowStub,
    args: devFlowArgs('1'),
  });
  return {
    ctx,
    counters: {
      evaluatorCalls: () => evalCalls.length,
      logs: () => logs,
      redgreenCalls: () => redgreenCalls,
    },
  };
}

// ============================================================
// フィクスチャ
// ============================================================

const CLEAN_VERDICT = { comparability: 'exact', transitions: {}, verification_surface: { status: 'intact' } };

const AC1_TEST_VERIFIED = { ac_index: 0, satisfied: true, verified_by: 'test', test_files: ['t0.test.mjs'], impl_files: ['impl0.mjs'] };

function criticalFirstIter() {
  return {
    verdict: 'needs_work',
    total: 60,
    feedback: [{ severity: 'critical', topic: 'X', dimension: 'eval', description: '重大欠陥', suggestion: '修正せよ' }],
    feedback_level: 'implementation',
    ac_results: [AC1_TEST_VERIFIED],
    security_clearance: [],
    testsurf_clearance: [],
  };
}

function resolvedSecondIter() {
  return {
    verdict: 'pass',
    total: 90,
    feedback: [],
    feedback_level: 'implementation',
    ac_results: [AC1_TEST_VERIFIED],
    security_clearance: [],
    testsurf_clearance: [],
    critical_resolutions: [{ id: 'EVAL-1-X', resolved: true, evidence: 'fixed' }],
  };
}

// ============================================================
// テストケース
// ============================================================

test('[redgreen-skip] T1: deterministic 昇格 + checked 済み AC は iteration2 で redgreen 再起動されない', async () => {
  const responses = [criticalFirstIter(), resolvedSecondIter()];
  const redgreenResponseFor = () => ({ red: true, green: true, verdict: CLEAN_VERDICT });

  const { ctx, counters } = makeSandbox(responses, redgreenResponseFor);
  const { error } = await runWorkflowCapture(src, ctx);
  assertNoCrash(error);

  assert.equal(
    counters.redgreenCalls().length,
    1,
    `redgreen は AC-1 deterministic 昇格後は再実行されないべきだが ${counters.redgreenCalls().length} 回呼ばれた: ${JSON.stringify(counters.redgreenCalls())}`,
  );
  assert.equal(
    counters.evaluatorCalls(),
    2,
    `critical_resolutions 明示解消 + AC-1 skip で 2 回で収束すべきだが ${counters.evaluatorCalls()} 回だった`,
  );

  const logs = counters.logs();
  assert.ok(
    logs.some((l) => l.includes('AC-1: deterministic 昇格 + checked 済み → redgreen-verify skip（issue #444）')),
    `iteration2 で skip ログが出るべきだが: ${JSON.stringify(logs.filter((l) => l.includes('AC-1')))}`,
  );
});

test('[redgreen-skip] T3: inspection 据え置き AC（checked だが kind!==deterministic）は従来どおり再実行される', async () => {
  const responses = [criticalFirstIter(), resolvedSecondIter()];
  const redgreenResponseFor = (acIndex, callNumber) => (
    callNumber === 1 ? { red: false, green: true, reason: 'no red' } : { red: true, green: true }
  );

  const { ctx, counters } = makeSandbox(responses, redgreenResponseFor);
  const { error } = await runWorkflowCapture(src, ctx);
  assertNoCrash(error);

  assert.equal(
    counters.redgreenCalls().length,
    2,
    `checked=true でも check.kind が deterministic でなければ再実行されるべきだが ${counters.redgreenCalls().length} 回だった: ${JSON.stringify(counters.redgreenCalls())}`,
  );

  const logs = counters.logs();
  assert.ok(
    logs.some((l) => l.includes('AC-1: red→green 実証 → deterministic 昇格 + checked')),
    `iteration2 で red→green 実証・昇格ログが出るべきだが: ${JSON.stringify(logs.filter((l) => l.includes('AC-1')))}`,
  );
});

test('[redgreen-skip] T4: 未 checked AC は従来どおり起動される', async () => {
  const firstIter = {
    verdict: 'needs_work',
    total: 60,
    feedback: [{ severity: 'critical', topic: 'X', dimension: 'eval', description: '重大欠陥', suggestion: '修正せよ' }],
    feedback_level: 'implementation',
    ac_results: [{ ac_index: 0, satisfied: false, verified_by: 'none', evidence: '' }],
    security_clearance: [],
    testsurf_clearance: [],
  };
  const responses = [firstIter, resolvedSecondIter()];
  const redgreenResponseFor = () => ({ red: true, green: true, verdict: CLEAN_VERDICT });

  const { ctx, counters } = makeSandbox(responses, redgreenResponseFor);
  const { error } = await runWorkflowCapture(src, ctx);
  assertNoCrash(error);

  assert.equal(
    counters.redgreenCalls().length,
    1,
    `未 checked AC は iteration2 の 1 回のみ起動されるべきだが ${counters.redgreenCalls().length} 回だった: ${JSON.stringify(counters.redgreenCalls())}`,
  );
  assert.equal(counters.evaluatorCalls(), 2);
});
