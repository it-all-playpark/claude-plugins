// Issue #271: danger-grep fail-closed 時に Evaluate ループが EVAL_MAX まで空回りせず
// break すること・merge tier が HOLD になること・fail-closed が return で
// danger_hits とは別軸で判別できることを検証する workflow レベル統合テスト。
//
// _lib/eval-convergence.test.mjs の VM sandbox
// パターン（node:vm で dev-flow.js を読み込み、agent() を label/agentType で stub、
// evaluator 呼び出し回数を counter で記録）を踏襲する。
//
// このテストファイルは TDD red として作成された。
// F3 実装（fail-closed SEC seed をループ収束からのみ除外する isLoopConvergedUnderPolicy の新設 +
// classifyMergeTier への dangerFailClosed 引数追加 + telemetry/return への danger_fail_closed 露出）
// 完了後に green になる。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { devFlowArgs, mergeTierFacts, runWorkflowCapture, devFlowResponder, makeWorkflowContext } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');
const src = readFileSync(devFlowPath, 'utf8');

// ---- VM sandbox helpers（eval-convergence.test.mjs をベースに拡張）----

/**
 * danger-fail-closed 専用の VM sandbox を組む。
 * label 'danger-grep'（Diff triage。issue #544 統合呼び出し）は dangerGrepResponse を
 * risk フィールドに包んで返し、label 'merge-tier-facts'（Merge tier 統合呼び出し）は risk サブ結果に包んで
 * dangerGrepResponse をそのまま返す。evaluator 呼び出し回数と journal-log に渡された
 * prompt を捕捉する。
 *
 * @param {object} dangerGrepResponse - danger-grep / merge-tier-facts(risk) stub が返すレスポンス
 * @param {object} evaluatorResponse - evaluator stub が返すレスポンス（全 iteration で同一を返す）
 * @returns {{ ctx: import('node:vm').Context, counters: { evaluatorCalls: () => number } }}
 */
function makeSandbox(dangerGrepResponse, evaluatorResponse) {
  const evalCalls = [];

  // agent() stub: opts.label / opts.agentType を見て phase 別に最小スキーマを返す
  const agentStub = async (prompt, opts) => {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';

    // Diff triage の敵対的 security review の対象判定（issue #1063）: この test の関心外なので対象外を返す
    if (label === 'security-scope') return { ok: true, target: false, reasons: [] };
    // Diff triage: label 'danger-grep' は issue #544 で統合呼び出しへ変わった
    // （diff-triage.sh 経由の {risk, files, struct, diffhash} 応答）。dangerGrepResponse
    // を risk フィールドに包んで返す（fail-closed / clean を切り替え可能）。
    if (label === 'danger-grep') {
      return { risk: dangerGrepResponse, files: ['src/foo.ts'], struct: null, diffhash: null };
    }
    // Merge tier: label 'merge-tier-facts'（統合呼び出し）は dangerGrepResponse を risk サブ結果に包んで返す。
    if (label === 'merge-tier-facts') {
      return mergeTierFacts({ risk: dangerGrepResponse, files: ['src/foo.ts'] });
    }
    // Validate: test runner（label が 'test' で始まる）
    if (label.startsWith('test')) {
      return { tests: 'no_tests', green: true, summary: '' };
    }
    // Evaluate: evaluator stub が呼び出し回数を記録し、evaluatorResponse を返す
    if (agentType === 'dev-flow:evaluator') {
      evalCalls.push({ label, agentType });
      return evaluatorResponse;
    }
    // post-summary（dev-runner-haiku）: posted:true 固定
    if (label === 'post-summary' && agentType === 'dev-flow:dev-runner-haiku') {
      return { posted: true, method: 'gh pr comment', url: 'http://x' };
    }
    // journal-log (stage2): logged:true を返す
    if (label === 'journal-log' && agentType === 'dev-flow:dev-runner-haiku') {
      return { logged: true, summary: 'ok' };
    }
    // implementer その他
    if (agentType === 'dev-flow:dev-implementer') {
      return { status: 'DONE', task_id: 't', files: [], summary: '', concerns: [] };
    }
    // デフォルト
    return devFlowResponder({ 'commit-hook#1': null, 'isolation-probe': null })({ label, agentType, prompt });
  };

  // pr-iterate stub: workflow() の呼び出し
  const workflowStub = async () => ({ status: 'lgtm', iterations: 1, fixes_applied: 0 });

  const ctx = makeWorkflowContext({
    agent: agentStub,
    workflow: workflowStub,
    args: devFlowArgs('1'),
  });
  return {
    ctx,
    counters: {
      evaluatorCalls: () => evalCalls.length,
    },
  };
}

// ============================================================
// テストケース
// ============================================================

// danger-grep fail-closed stub（risk.ok !== true）。evidence 文字列は evidence 判別用。
const DANGER_FAIL_CLOSED = { ok: false, hits: [], error: 'stub fail-closed' };

// danger-grep clean stub（正常系の回帰対照用）。
const DANGER_CLEAN = { ok: true, hits: [] };

// evaluator stub: verdict='pass'・AC 全 satisfied:true・feedback:[]・critical なし・security_clearance:[]。
// danger-grep が fail-closed(dangerHits=[]) の場合、security_focus が prompt に載らないため
// evaluator は security_clearance を返す機会がない（issue #271 のバグの核心）。
const EVAL_RESPONSE_CLEAN = {
  verdict: 'pass',
  total: 100,
  threshold: 80,
  feedback: [],
  feedback_level: 'implementation',
  ac_results: [
    { ac_index: 0, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
    { ac_index: 1, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
  ],
  security_clearance: [],
};

test('[danger-fail-closed] AC#1: danger-grep fail-closed でも evaluator はちょうど 1 回で収束する（EVAL_MAX=10 まで空回りしない）', async () => {
  const { ctx, counters } = makeSandbox(DANGER_FAIL_CLOSED, EVAL_RESPONSE_CLEAN);
  const { result, error } = await runWorkflowCapture(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  assert.equal(
    counters.evaluatorCalls(),
    1,
    `danger-grep fail-closed 時、fail-closed な SEC seed item はループ収束判定から除外され evaluator は 1 回で収束すべきだが ${counters.evaluatorCalls()} 回呼ばれた（EVAL_MAX まで空回りしている疑い）`,
  );
});

test('[danger-fail-closed] AC#2: danger-grep fail-closed 時、merge tier は HOLD になる（軸A invariant: danger-grep の fail-closed は緩めない）', async () => {
  const { ctx } = makeSandbox(DANGER_FAIL_CLOSED, EVAL_RESPONSE_CLEAN);
  const { result, error } = await runWorkflowCapture(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  assert.equal(
    result?.merge_tier,
    'HOLD',
    `danger-grep fail-closed（Merge tier phase の merge-tier-facts risk も fail-closed）の場合、`
    + `merge tier 算出は fail-closed SEC seed を unchecked のまま含めて HOLD を強制すべきだが '${result?.merge_tier}' だった`,
  );
});

test('[danger-fail-closed] AC#4: return object で danger_fail_closed（真偽値）と danger_hits（実 hit クラス）が別軸で判別できる', async () => {
  const { ctx } = makeSandbox(DANGER_FAIL_CLOSED, EVAL_RESPONSE_CLEAN);
  const { result, error } = await runWorkflowCapture(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  // return object: danger_fail_closed:true と danger_hits:[] が両方成立する（別軸）
  assert.equal(
    result?.danger_fail_closed,
    true,
    `danger-grep fail-closed の場合、return object の danger_fail_closed は true であるべきだが ${JSON.stringify(result?.danger_fail_closed)} だった`,
  );
  assert.ok(
    Array.isArray(result?.danger_hits) && result.danger_hits.length === 0,
    `fail-closed 時は実 hit を検出していないため danger_hits は空配列であるべきだが ${JSON.stringify(result?.danger_hits)} だった`,
  );
});

test('[danger-fail-closed] AC#5 regression: danger-grep clean 時は evaluator 1 回で収束し、merge tier は danger 起因で HOLD にならず danger_fail_closed:false になる', async () => {
  const { ctx, counters } = makeSandbox(DANGER_CLEAN, EVAL_RESPONSE_CLEAN);
  const { result, error } = await runWorkflowCapture(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  assert.equal(
    counters.evaluatorCalls(),
    1,
    `danger-grep clean（正常系）では回帰なく evaluator は 1 回で収束すべきだが ${counters.evaluatorCalls()} 回呼ばれた`,
  );

  assert.notEqual(
    result?.merge_tier,
    'HOLD',
    `danger-grep clean + AC 全 satisfied + critical なしの場合、merge tier は danger 起因で HOLD になるべきでないが '${result?.merge_tier}' だった（reasons: ${JSON.stringify(result?.merge_tier_reasons)}）`,
  );

  assert.equal(
    result?.danger_fail_closed,
    false,
    `danger-grep clean の場合、danger_fail_closed は false であるべきだが ${JSON.stringify(result?.danger_fail_closed)} だった`,
  );
});
