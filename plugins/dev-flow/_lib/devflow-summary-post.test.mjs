// AC#4 (F4): VM カウントテスト
// Merge tier phase 後に投稿用 dev-runner 呼び出しが 1 回発生すること、
// および投稿失敗 stub でも workflow が正常 return することを検証する。
//
// このテストファイルは TDD red として作成された。
// post-summary dev-runner-haiku 呼び出し実装完了後に green になる。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { devFlowArgs, makeDevFlowSandbox, runWorkflowCapture, assertNoCrash, devFlowResponder, makeWorkflowContext } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');

// ---- VM sandbox helpers ----

/**
 * post-summary 投稿検証専用の VM sandbox を組む。
 * agentStub は opts.label / opts.agentType を見て phase 別に最小スキーマを返す。
 * post-summary stub の戻り値は引数 postResult で切り替え可能。
 * resolved 値（return object）を捕捉できるよう runner も同型にしている。
 *
 * @param {object} postResult - post-summary stub が返すレスポンス（投稿成功/失敗を切り替え）
 * @returns {{ ctx: import('node:vm').Context, getPostSummaryCallCount: () => number }}
 */
function makeSandbox(postResult) {
  // post-summary 呼び出しカウンタ
  let postSummaryCallCount = 0;

  // agent() stub: opts.label / opts.agentType を見て phase 別に最小スキーマを返す
  const agentStub = async (prompt, opts) => {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';

    // Diff triage / Merge tier: danger-grep 系（label が 'danger-grep' で始まる）
    // → danger clean にして HOLD 要因を発生させない
    if (label.startsWith('danger-grep')) {
      return { ok: true, hits: [] };
    }
    // Validate: test runner（label が 'test' で始まる）
    if (label.startsWith('test')) {
      return { tests: 'no_tests', green: true, summary: '' };
    }
    // Evaluate: evaluator stub（最小 pass レスポンス）
    if (agentType === 'dev-flow:evaluator') {
      return {
        verdict: 'pass',
        total: 100,
        threshold: 80,
        feedback: [],
        feedback_level: 'implementation',
        ac_results: [
          { ac_index: 0, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
          { ac_index: 1, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
          { ac_index: 2, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
          { ac_index: 3, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
        ],
        security_clearance: [],
      };
    }
    // Merge tier: changed-files
    // → docs/test-only でないファイルを返す（AUTO 除外）
    // post-summary（dev-runner-haiku）: 呼び出しカウンタをインクリメントし postResult を返す
    if (label === 'post-summary' && agentType === 'dev-flow:dev-runner-haiku') {
      postSummaryCallCount += 1;
      return postResult;
    }
    // implementer その他
    if (agentType === 'dev-flow:dev-implementer') {
      return { status: 'DONE', task_id: 't', files: [], summary: '', concerns: [] };
    }
    // デフォルト
    return devFlowResponder({ 'commit-hook#1': null, 'isolation-probe': null, 'journal-log': null, 'merge-tier-facts': null, 'security-scope': null })({ label, agentType, prompt });
  };

  // pr-iterate stub: workflow() の呼び出し
  const workflowStub = async () => ({ status: 'lgtm', iterations: 1, fixes_applied: 0 });

  // sandbox object
  const ctx = makeWorkflowContext({
    agent: agentStub,
    workflow: workflowStub,
    args: devFlowArgs('1'),
  });
  return {
    ctx,
    getPostSummaryCallCount: () => postSummaryCallCount,
  };
}

// ============================================================
// テストケース
// ============================================================

const src = readFileSync(devFlowPath, 'utf8');

test('[summary-post] Merge tier phase 後に post-summary dev-runner-haiku 呼び出しが 1 回発生すること', async () => {
  const postResult = { posted: true, method: 'gh pr comment', url: 'http://x' };
  const { ctx, getPostSummaryCallCount } = makeSandbox(postResult);

  const { result, error } = await runWorkflowCapture(src, ctx);

  // ReferenceError / SyntaxError は構造的に壊れているので即 fail させる（sandbox クラッシュ検出）
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  // post-summary 呼び出しカウント === 1
  assert.equal(
    getPostSummaryCallCount(),
    1,
    `post-summary dev-runner-haiku の呼び出しは 1 回であるべきだが ${getPostSummaryCallCount()} 回だった`,
  );
});

test('[summary-post] post-summary stub が posted:false を返しても result.merge_tier が正常 return されること', async () => {
  // 投稿失敗をシミュレート: posted:false（F2 の「投稿失敗でも継続」仕様の回帰検出）
  const postResult = { posted: false };
  const { ctx } = makeSandbox(postResult);

  const { result, error } = await runWorkflowCapture(src, ctx);

  // ReferenceError / SyntaxError は構造的に壊れているので即 fail させる（sandbox クラッシュ検出）
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  // result が null でなく、throw されていない
  assert.ok(
    result !== null && result !== undefined,
    `投稿失敗（posted:false）でも workflow は return object を解決するべきだが null/undefined だった`,
  );

  // result.merge_tier が文字列（'HOLD'|'REVIEW'|'AUTO' のいずれか）として返ること
  assert.ok(
    typeof result?.merge_tier === 'string' && ['HOLD', 'REVIEW', 'AUTO'].includes(result.merge_tier),
    `投稿失敗でも result.merge_tier は 'HOLD'|'REVIEW'|'AUTO' のいずれかであるべきだが '${result?.merge_tier}' だった`,
  );
});

// ============================================================
// summary_posted（issue #712 AC-3）: 投稿失敗が fail-open の log 1 行で消えないよう、
// 返り値・終端 note に出す。
// ============================================================

async function runWithPost(postResult) {
  const { ctx } = makeDevFlowSandbox({ overrides: { 'post-summary': postResult } });
  const { result, error } = await runWorkflowCapture(src, ctx);
  assertNoCrash(error, 'summary_posted');
  assert.equal(error, null, `dev-flow run が throw した: ${error?.message}`);
  return { result };
}

for (const [name, postResult] of [
  ['posted:false', { posted: false }],
  ['null（agent が結果を返さない）', null],
]) {
  test(`[summary-post] post-summary が ${name} のとき summary_posted:false が返り値に載り note に「終端サマリ未投稿」が出る`, async () => {
    const { result } = await runWithPost(postResult);
    assert.equal(result.summary_posted, false);
    assert.ok(result.note.includes('終端サマリ未投稿'), `note に「終端サマリ未投稿」が無い: ${result.note}`);
  });
}

test('[summary-post] post-summary が posted:true のとき summary_posted:true で note に「終端サマリ未投稿」が出ない', async () => {
  const { result } = await runWithPost({ posted: true, method: 'gh', url: 'http://x', epoch: 2000 });
  assert.equal(result.summary_posted, true);
  assert.ok(!result.note.includes('終端サマリ未投稿'), `投稿成功なのに note に「終端サマリ未投稿」がある: ${result.note}`);
});
