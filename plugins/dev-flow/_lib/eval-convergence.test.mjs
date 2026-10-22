// AC#1: 収束判定の一本化テスト（eval-convergence）
// complex 経路で evaluator が verdict=fail かつ minor のみ（critical なし、AC 全 satisfied）を返すとき、
// isConvergedUnderPolicy が true → evaluator 呼び出し 1 回で exit することを検証する。
//
// このテストファイルは TDD red として作成された。
// F1 実装（isConvergedUnderPolicy && ev.verdict === 'pass' → isConvergedUnderPolicy のみ）完了後に green になる。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { EVALUATOR_OPERATIONAL_CONTRACT } from './evaluator-contract.mjs';
import { devFlowArgs, mergeTierFacts } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');

// ---- VM sandbox helpers ----

/**
 * eval-convergence 専用の VM sandbox を組む。
 * evaluator stub は呼び出し回数を記録し、responses 配列の index に応じた応答を返す。
 *
 * @param {object} analyzeReq - analyze フェーズの agent が返す req オブジェクト（SHAPE を決定する）
 * @param {object[]} responses - evaluator stub が順に返すレスポンス配列
 * @returns {{ ctx: vm.Context, counters: { evaluatorCalls: () => number } }}
 */
function makeSandbox(analyzeReq, responses) {
  const evalCalls = [];
  const evalPrompts = [];

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
    // Security floor の敵対的 security review の対象判定（issue #1063）: この test の関心外なので対象外を返す
    if (label === 'security-scope') return { ok: true, target: false, reasons: [] };
    // Security floor / Merge tier: danger-grep 系（label が 'danger-grep' で始まる）
    // → danger clean にして HOLD 要因を絞る
    if (label.startsWith('danger-grep')) {
      return { ok: true, hits: [] };
    }
    // Validate: test runner（label が 'test' で始まる）
    if (label.startsWith('test')) {
      return { tests: 'no_tests', green: true, summary: '' };
    }
    // Evaluate: evaluator stub が呼び出し回数を記録し、responses 配列に応じた応答を返す
    if (agentType === 'dev-flow:evaluator') {
      evalCalls.push({ label, agentType });
      evalPrompts.push(prompt);
      const idx = Math.min(evalCalls.length - 1, responses.length - 1);
      return responses[idx];
    }
    // redgreen-verify は呼ばれないはずだが念のため（verified_by:'inspection' で回避）
    if (agentType === 'dev-flow:dev-runner-haiku' && label.startsWith('redgreen')) {
      return { red: false, green: false, reason: 'stub' };
    }
    // realized-diff（Security floor）: dev-runner-haiku, label='realized-diff', CHANGED schema
    if (agentType === 'dev-flow:dev-runner-haiku-ro' && label === 'realized-diff') {
      return { files: ['src/foo.ts'] };
    }
    // declared-path-check（Validate）: dev-runner-haiku, label='declared-path-check', CHANGED schema
    if (agentType === 'dev-flow:dev-runner-haiku' && label === 'declared-path-check') {
      return { files: ['src/foo.ts'] };
    }
    // PR: label が 'pr' で始まる
    if (label.startsWith('pr')) {
      return { pr_url: 'http://x', pr_number: 1, committed: true };
    }
    // Merge tier: merge-tier-facts（changed）
    // → docs/test-only でないファイルを返す（AUTO 除外。HOLD 要因を絞る）
    if (label === 'merge-tier-facts') {
      return mergeTierFacts({ files: ['src/foo.ts'] });
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
    // JS 組み込み（shape-loop-routing.test.mjs と同一セット）
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
      evaluatorPrompts: () => evalPrompts,
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

test('[eval-convergence] AC#1: complex 経路・minor のみ feedback・AC 全 satisfied → evaluator 1 回で収束 + merge_tier !== HOLD', async () => {
  // complex に落ちる req（count=7 → floor=complex → EVAL_PASSES=EVAL_MAX=10 のループ経路）
  const analyzeReq = {
    summary: 's',
    acceptance_criteria: ['a', 'b', 'c', 'd'],
    issue_type: 'feat',
    scope: 'src',
    issue_number: 1,
    issue_title: 'stub-issue-title',
  };

  // evaluator stub: 全呼び出しで verdict=fail を返すが、minor のみ・critical なし・AC 全 satisfied。
  // ledger は全 blocking checked → isConvergedUnderPolicy = true になるはず。
  // 現実装（&& ev.verdict === 'pass'）では verdict=fail のため収束しない → 10 回呼ばれて fail する（= red）。
  // 修正後（isConvergedUnderPolicy のみ）は 1 回で収束する（= green）。
  const evalResponse = {
    verdict: 'fail',
    total: 5,
    threshold: 7,
    feedback: [
      {
        severity: 'minor',
        topic: 'nitpick',
        description: '軽微',
        suggestion: '任意',
      },
    ],
    feedback_level: 'implementation',
    ac_results: [
      { ac_index: 0, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
      { ac_index: 1, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
      { ac_index: 2, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
      { ac_index: 3, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
    ],
    security_clearance: [],
  };

  // responses 配列: 全 iteration で同じレスポンスを返す
  const responses = [evalResponse];

  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, counters } = makeSandbox(analyzeReq, responses);
  const { result, error } = await runDevFlowCapture(src, ctx);

  // ReferenceError / SyntaxError は構造的に壊れているので即 fail させる
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  // assert (1): evaluator 呼び出し回数 === 1（収束で追加 iteration を回さない）
  assert.equal(
    counters.evaluatorCalls(),
    1,
    `evaluator は収束で 1 回のみ呼ばれるべきだが ${counters.evaluatorCalls()} 回呼ばれた`,
  );

  // assert (2): merge_tier !== 'HOLD'（converged 扱い。complex + 非 docs-only なら REVIEW を期待）
  assert.notEqual(
    result?.merge_tier,
    'HOLD',
    `ledger 全 blocking checked で収束した場合、merge_tier は 'HOLD' であるべきでないが 'HOLD' だった`,
  );
});

test('[eval-convergence] AC#2: 沈黙 critical → EVAL_MAX(10 回)まで差し戻し → HOLD + ledger 未収束', async () => {
  const analyzeReq = {
    summary: 's',
    acceptance_criteria: ['a', 'b', 'c', 'd'],
    issue_type: 'feat',
    scope: 'src',
    issue_number: 1,
    issue_title: 'stub-issue-title',
  };

  const ac4 = [
    { ac_index: 0, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
    { ac_index: 1, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
    { ac_index: 2, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
    { ac_index: 3, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
  ];

  const firstResponse = {
    verdict: 'fail',
    total: 5,
    threshold: 7,
    feedback: [
      { severity: 'critical', topic: 'X', description: '重大欠陥', suggestion: '修正せよ' },
    ],
    feedback_level: 'implementation',
    ac_results: ac4,
    security_clearance: [],
  };

  const silentResponse = {
    verdict: 'pass',
    total: 9,
    threshold: 7,
    feedback: [],
    feedback_level: 'implementation',
    ac_results: ac4,
    security_clearance: [],
  };

  const responses = [firstResponse, silentResponse];

  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, counters } = makeSandbox(analyzeReq, responses);
  const { result, error } = await runDevFlowCapture(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  assert.equal(
    counters.evaluatorCalls(),
    10,
    `沈黙 critical で EVAL_MAX=10 回まで差し戻しが続くべきだが ${counters.evaluatorCalls()} 回だった`,
  );

  assert.equal(
    result?.merge_tier,
    'HOLD',
    `ledger 未収束で HOLD になるべきだが ${result?.merge_tier} だった`,
  );

  const reasons = result?.merge_tier_reasons ?? [];
  const hasLedgerUnconverged = reasons.some((r) => /ledger 未収束/.test(r));
  assert.ok(
    hasLedgerUnconverged,
    `merge_tier_reasons に "ledger 未収束" を含む要素があるべきだが見つからなかった: ${JSON.stringify(reasons)}`,
  );
});

test('[eval-convergence] AC#3: critical_resolutions {resolved:true, evidence} → 2 回で収束・非 HOLD', async () => {
  const analyzeReq = {
    summary: 's',
    acceptance_criteria: ['a', 'b', 'c', 'd'],
    issue_type: 'feat',
    scope: 'src',
    issue_number: 1,
    issue_title: 'stub-issue-title',
  };

  const ac4 = [
    { ac_index: 0, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
    { ac_index: 1, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
    { ac_index: 2, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
    { ac_index: 3, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
  ];

  const firstResponse = {
    verdict: 'fail',
    total: 5,
    threshold: 7,
    feedback: [
      { severity: 'critical', topic: 'X', description: '重大欠陥', suggestion: '修正せよ' },
    ],
    feedback_level: 'implementation',
    ac_results: ac4,
    security_clearance: [],
  };

  const secondResponse = {
    verdict: 'pass',
    total: 9,
    threshold: 7,
    feedback: [],
    feedback_level: 'implementation',
    ac_results: ac4,
    security_clearance: [],
    critical_resolutions: [
      {
        id: 'EVAL-1-X',
        resolved: true,
        evidence: 'src/foo.ts の入力検証を追加し test で確認',
      },
    ],
  };

  const responses = [firstResponse, secondResponse];

  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, counters } = makeSandbox(analyzeReq, responses);
  const { result, error } = await runDevFlowCapture(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  assert.equal(
    counters.evaluatorCalls(),
    2,
    `critical_resolutions 明示解消で 2 回で収束すべきだが ${counters.evaluatorCalls()} 回だった`,
  );

  assert.notEqual(
    result?.merge_tier,
    'HOLD',
    `critical_resolutions で解消 → 収束 → HOLD でないべきだが 'HOLD' だった`,
  );
});

// バグ1（verdict AND 条件）・バグ2（沈黙=解消の自動 checkItem）が存在しないことは、上記
// AC#1〜AC#3（verdict と収束の独立、critical_resolutions のみで解消）が VM 挙動として既に
// 検証済みのためここでは重複させない。
//
// critical_resolutions 契約は「未解消 critical 一覧」（前 iteration の critical feedback）または
// 「既出 feedback」（priorFeedback）が prompt に渡る場合にのみ注入される（dev-flow.js の実装。
// runValidateLoop 同様、初回 eval#1 には prior state が無いため注入されない）。そのため
// AC#3 と同じ 2 iteration フィクスチャ（1 回目 critical → 2 回目解消）を使い、注入が実際に
// 起きる eval#2 の prompt で検証する。
test('[eval-convergence] contract: eval#2 prompt に EVALUATOR_OPERATIONAL_CONTRACT.critical_resolutions が verbatim 含まれる（issue #174。収束契約は dev-flow.js prompt が唯一の operative contract。evaluator.md は sandbox 保護で workflow から編集不可）', async () => {
  const analyzeReq = {
    summary: 's',
    acceptance_criteria: ['a', 'b', 'c', 'd'],
    issue_type: 'feat',
    scope: 'src',
    issue_number: 1,
    issue_title: 'stub-issue-title',
  };

  const ac4 = [
    { ac_index: 0, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
    { ac_index: 1, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
    { ac_index: 2, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
    { ac_index: 3, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
  ];

  const firstResponse = {
    verdict: 'fail',
    total: 5,
    threshold: 7,
    feedback: [
      { severity: 'critical', topic: 'X', description: '重大欠陥', suggestion: '修正せよ' },
    ],
    feedback_level: 'implementation',
    ac_results: ac4,
    security_clearance: [],
  };

  const secondResponse = {
    verdict: 'pass',
    total: 9,
    threshold: 7,
    feedback: [],
    feedback_level: 'implementation',
    ac_results: ac4,
    security_clearance: [],
    critical_resolutions: [
      { id: 'EVAL-1-X', resolved: true, evidence: 'src/foo.ts の入力検証を追加し test で確認' },
    ],
  };

  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, counters } = makeSandbox(analyzeReq, [firstResponse, secondResponse]);
  const { error } = await runDevFlowCapture(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  const prompts = counters.evaluatorPrompts();
  assert.equal(prompts.length, 2, `evaluator は 2 回呼ばれるはずだが ${prompts.length} 回だった`);
  assert.ok(
    prompts[1].includes(EVALUATOR_OPERATIONAL_CONTRACT.critical_resolutions),
    'eval#2 の prompt に EVALUATOR_OPERATIONAL_CONTRACT.critical_resolutions が verbatim 含まれていない',
  );
  assert.ok(
    prompts[1].includes('critical_resolutions'),
    'eval#2 の prompt に critical_resolutions キーが含まれていない',
  );

  // evaluator.md 側: 同期文言（issue #227 で同期済み）— critical_resolutions / security_clearance の
  // 出力契約が記載され、「新規のみ報告」指示が維持され、沈黙=解消の旧記述が存在しないこと。
  // evaluator.md は agent 定義文書であり agent() prompt ではないため AC-1 対象外（現状維持）。
  const agentMd = readFileSync(new URL('../.claude/agents/evaluator.md', import.meta.url), 'utf8');
  assert.ok(agentMd.includes('critical_resolutions'), 'evaluator.md に critical_resolutions 契約が記載されていること（issue #227）');
  assert.ok(agentMd.includes('security_clearance'), 'evaluator.md に security_clearance 契約が記載されていること（issue #227）');
  assert.ok(agentMd.includes('新規の critical/major のみ報告'));
  assert.ok(!agentMd.includes('解消とみなす'), '沈黙=解消の旧記述が存在しないこと');
});
