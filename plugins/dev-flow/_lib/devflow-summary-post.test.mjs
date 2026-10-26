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
import vm from 'node:vm';
import { devFlowArgs, makeDevFlowSandbox, runWorkflowCapture, assertNoCrash } from './test-helpers/vm-sandbox.mjs';

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
 * @param {object} analyzeReq - analyze フェーズの agent が返す req オブジェクト（SHAPE を決定する）
 * @param {object} postResult - post-summary stub が返すレスポンス（投稿成功/失敗を切り替え）
 * @returns {{ ctx: vm.Context, getPostSummaryCallCount: () => number }}
 */
function makeSandbox(analyzeReq, postResult) {
  // post-summary 呼び出しカウンタ
  let postSummaryCallCount = 0;

  // agent() stub: opts.label / opts.agentType を見て phase 別に最小スキーマを返す
  const agentStub = async (prompt, opts) => {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';

    // Setup(worktree)
    // Setup(setup-base): base 解決 + 既存 worktree 起点検証 統合 probe（issue #550 案1）
    if (label === 'setup-base') {
      return { ok: true, default_branch: 'main', dev_exists: true, requested_exists: false, worktree_exists: false, upstream_remote: '', upstream_merge: '' };
    }
    if (label === 'worktree') {
      return { worktree: '/tmp/wt', branch: 'feature/issue-1' };
    }
    // Analyze: label が 'analyze' で始まる
    if (label.startsWith('analyze')) {
      return analyzeReq;
    }
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
    // redgreen-verify は呼ばれないはずだが念のため（verified_by:'inspection' で回避）
    if (agentType === 'dev-flow:dev-runner-haiku' && label.startsWith('redgreen')) {
      return { red: false, green: false };
    }
    // PR: label が 'pr' で始まる
    if (label.startsWith('pr')) {
      return { pr_url: 'http://x', pr_number: 1, committed: true };
    }
    // Merge tier: changed-files
    // → docs/test-only でないファイルを返す（AUTO 除外）
    if (label === 'changed-files') {
      return { files: ['src/foo.ts'] };
    }
    // post-summary（dev-runner-haiku）: 呼び出しカウンタをインクリメントし postResult を返す
    if (label === 'post-summary' && agentType === 'dev-flow:dev-runner-haiku') {
      postSummaryCallCount += 1;
      return postResult;
    }
    // implementer その他
    if (agentType === 'dev-flow:dev-implementer') {
      return { status: 'DONE', task_id: 't', files: [], summary: '', concerns: [] };
    }
    // diff-gate / diff-hash（issue #215）: need() による throw の回避
    if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) return { hash: 'H', empty: false }
    // issue-meta（issue #451）: analyze provenance 突合 probe
    if (label === 'issue-meta') return { ok: true, number: 1, title: 'stub-issue-title' };
    // デフォルト
    return null;
  };

  // parallel() stub: runImplement が parallel(par) を呼ぶため（par が空なら []）
  const parallelStub = async (fns) => Promise.all((fns || []).map((f) => f()));

  // pr-iterate stub: workflow() の呼び出し
  const workflowStub = async () => ({ status: 'lgtm', iterations: 1, fixes_applied: 0 });

  // sandbox object
  const sandbox = {
    // workflow 制御関数
    phase: () => {},
    log: () => {},
    agent: agentStub,
    parallel: parallelStub,
    pipeline: async (items, cb) => Promise.all((items || []).map(async (item, i) => { try { const r = await cb(item, i); return r === undefined ? null : r; } catch { return null; } })),
    workflow: workflowStub,
    // 引数（ISSUE 解決用）
    args: devFlowArgs('1'),
    // JS 組み込み
    console,
    JSON,
    Math,
    String,
    Number,
    Boolean,
    Array,
    Object,
    Error,
    RegExp,
    Promise,
    Symbol,
    Map,
    Set,
    Date,
  };

  const ctx = vm.createContext(sandbox);
  return {
    ctx,
    getPostSummaryCallCount: () => postSummaryCallCount,
  };
}

/**
 * dev-flow.js ソースを strip して async IIFE でラップし vm sandbox で実行する。
 * IIFE の **resolved 値（return object）を捕捉して返す**。
 *
 * @param {string} src - dev-flow.js の raw ソース
 * @param {vm.Context} ctx - vm コンテキスト
 * @returns {Promise<{ result: object|null, error: Error|null }>}
 */
async function runDevFlowCapture(src, ctx) {
  const stripped = src
    .replace(/^export\s+const\s+/gm, 'const ')
    .replace(/^export\s+function\s+/gm, 'function ');
  const wrapped = `(async () => {\n${stripped}\n})();`;

  let caughtError = null;
  let resolvedResult = null;
  try {
    const resultPromise = vm.runInContext(wrapped, ctx, { filename: '.claude/workflows/dev-flow.js' });
    if (resultPromise && typeof resultPromise.then === 'function') {
      resolvedResult = await resultPromise.catch((e) => {
        caughtError = e;
        return null;
      });
    }
  } catch (e) {
    caughtError = e;
  }
  return { result: resolvedResult, error: caughtError };
}

// ============================================================
// テストケース
// ============================================================

// standard 経路に落ちる req（count=3, ac=4件, type='feat' → floor='standard'）
// Merge tier phase まで到達させる
const ANALYZE_REQ = {
  summary: 's',
  acceptance_criteria: ['a', 'b', 'c', 'd'],
  issue_type: 'feat',
  scope: 'src',
  issue_number: 1,
  issue_title: 'stub-issue-title',
};

const src = readFileSync(devFlowPath, 'utf8');

test('[summary-post] Merge tier phase 後に post-summary dev-runner-haiku 呼び出しが 1 回発生すること', async () => {
  const postResult = { posted: true, method: 'gh pr comment', url: 'http://x' };
  const { ctx, getPostSummaryCallCount } = makeSandbox(ANALYZE_REQ, postResult);

  const { result, error } = await runDevFlowCapture(src, ctx);

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
  const { ctx } = makeSandbox(ANALYZE_REQ, postResult);

  const { result, error } = await runDevFlowCapture(src, ctx);

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
