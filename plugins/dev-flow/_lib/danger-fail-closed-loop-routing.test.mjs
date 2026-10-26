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
import vm from 'node:vm';
import { devFlowArgs, mergeTierFacts } from './test-helpers/vm-sandbox.mjs';

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
 * @param {object} analyzeReq - analyze フェーズの agent が返す req オブジェクト（SHAPE を決定する）
 * @param {object} dangerGrepResponse - danger-grep / merge-tier-facts(risk) stub が返すレスポンス
 * @param {object} evaluatorResponse - evaluator stub が返すレスポンス（全 iteration で同一を返す）
 * @returns {{ ctx: vm.Context, counters: { evaluatorCalls: () => number, journalPrompts: () => string[] } }}
 */
function makeSandbox(analyzeReq, dangerGrepResponse, evaluatorResponse) {
  const evalCalls = [];
  const journalPrompts = [];

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
    // Diff triage の敵対的 security review の対象判定（issue #1063）: この test の関心外なので対象外を返す
    if (label === 'security-scope') return { ok: true, target: false, reasons: [] };
    // Diff triage: label 'danger-grep' は issue #544 で統合呼び出しへ変わった
    // （diff-triage.sh 経由の {risk, files, struct, diffhash} 応答）。dangerGrepResponse
    // を risk フィールドに包んで返す（fail-closed / clean を切り替え可能）。
    if (label === 'danger-grep') {
      return { risk: dangerGrepResponse, files: ['src/foo.ts'], struct: null, diffhash: null };
    }
    // Merge tier: label 'merge-tier-facts'（統合呼び出し）は dangerGrepResponse を risk サブ結果に包んで返す。
    // changed は docs/test-only でないファイル（AUTO 除外。HOLD 要因を danger のみに絞る）
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
    // redgreen-verify は呼ばれないはずだが念のため（verified_by:'inspection' で回避）
    if (agentType === 'dev-flow:dev-runner-haiku' && label.startsWith('redgreen')) {
      return { red: false, green: false, reason: 'stub' };
    }
    // PR: label が 'pr' で始まる
    if (label.startsWith('pr')) {
      return { pr_url: 'http://x', pr_number: 1, committed: true };
    }
    // post-summary（dev-runner-haiku）: posted:true 固定
    if (label === 'post-summary' && agentType === 'dev-flow:dev-runner-haiku') {
      return { posted: true, method: 'gh pr comment', url: 'http://x' };
    }
    // journal-save (stage1, issue #494): 実際の telemetry payload はここに載る（journal-log は
    // stage2 でファイルパスのみを扱うため payload literal を含まない）。prompt を捕捉し
    // saved:true を返して journal-log (stage2) へ進めさせる。
    if (label === 'journal-save' && agentType === 'dev-flow:dev-runner-haiku') {
      journalPrompts.push(prompt);
      return { saved: true, path: '/tmp/wt/.devflow-tmp/payload-test.json' };
    }
    // journal-log (stage2): logged:true を返す
    if (label === 'journal-log' && agentType === 'dev-flow:dev-runner-haiku') {
      return { logged: true, summary: 'ok' };
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
    // JS 組み込み（eval-convergence.test.mjs と同一セット）
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
    counters: {
      evaluatorCalls: () => evalCalls.length,
      journalPrompts: () => journalPrompts,
    },
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

// complex に落ちる req（count=7 → floor=complex → EVAL_PASSES=EVAL_MAX=10 のループ経路）。
// acceptance_criteria は 1-2 件に絞る（AC 未達要因を混入させないため）。
const ANALYZE_REQ_COMPLEX = {
  summary: 's',
  acceptance_criteria: ['a', 'b'],
  issue_type: 'feat',
  scope: 'src',
  issue_number: 1,
  issue_title: 'stub-issue-title',
};

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
  const { ctx, counters } = makeSandbox(ANALYZE_REQ_COMPLEX, DANGER_FAIL_CLOSED, EVAL_RESPONSE_CLEAN);
  const { result, error } = await runDevFlowCapture(src, ctx);

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
  const { ctx } = makeSandbox(ANALYZE_REQ_COMPLEX, DANGER_FAIL_CLOSED, EVAL_RESPONSE_CLEAN);
  const { result, error } = await runDevFlowCapture(src, ctx);

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
  const { ctx } = makeSandbox(ANALYZE_REQ_COMPLEX, DANGER_FAIL_CLOSED, EVAL_RESPONSE_CLEAN);
  const { result, error } = await runDevFlowCapture(src, ctx);

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
  const { ctx, counters } = makeSandbox(ANALYZE_REQ_COMPLEX, DANGER_CLEAN, EVAL_RESPONSE_CLEAN);
  const { result, error } = await runDevFlowCapture(src, ctx);

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
