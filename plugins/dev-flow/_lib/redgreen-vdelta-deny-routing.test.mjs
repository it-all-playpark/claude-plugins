// Issue #362: redgreen R1↔R2 vdelta verdict による deny-only チェックの workflow レベル統合テスト。
//
// _lib/danger-fail-closed-loop-routing.test.mjs の VM sandbox パターン（node:vm で dev-flow.js を
// 読み込み、agent() を label/agentType で stub、log() 出力を捕捉して deterministic 昇格 / deny を
// 判別、journal-log prompt を捕捉して telemetry handoff JSON を assert）を踏襲する。
//
// このテストファイルは TDD red として作成された。F4 実装（dev-flow.js への redgreen deny 配線）
// 完了後に green になる。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { devFlowArgs, prerunAnalyze } from './test-helpers/vm-sandbox.mjs';
import { isRedgreenCall, redgreenBatchResponse } from './test-helpers/redgreen-batch.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');

// ---- VM sandbox helper ----

/**
 * redgreen/vdelta 専用の VM sandbox を組む。
 * evaluator の ac_results に対応する redgreen-verify.sh バッチ呼び出し（label 'redgreen'、1 spawn に
 * 全 AC ペア）の応答を acIndex 別に切り替え可能にし、log() 出力・journal-log prompt を捕捉する。
 *
 * @param {object} analyzeReq
 * @param {object} evaluatorResponse
 * @param {(acIndex:number) => object} redgreenResponseFor - ac_index(0始まり) を受け取り redgreen stub の返り値を返す
 */
function makeSandbox(analyzeReq, evaluatorResponse, redgreenResponseFor) {
  const logs = [];
  const journalPrompts = [];
  const evalCalls = [];
  const redgreenCalls = [];

  const agentStub = async (prompt, opts) => {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';

    if (label === 'setup-base') {
      return { ok: true, default_branch: 'main', dev_exists: true, requested_exists: false, worktree_exists: false, upstream_remote: '', upstream_merge: '' };
    }
    if (label === 'worktree') {
      return { worktree: '/tmp/wt', branch: 'feature/issue-1' };
    }
    if (label.startsWith('danger-grep')) {
      return { ok: true, hits: [] };
    }
    if (label.startsWith('test')) {
      return { tests: 'no_tests', green: true, summary: '' };
    }
    if (agentType === 'dev-flow:evaluator') {
      evalCalls.push({ label, agentType });
      return evaluatorResponse;
    }
    if (label === 'rg-state-dir') return { state_dir: '/tmp/rg-state' };
    if (isRedgreenCall(agentType, label)) {
      redgreenCalls.push({ label, prompt });
      return redgreenBatchResponse(prompt, evaluatorResponse.ac_results, (acIndex) => redgreenResponseFor(acIndex));
    }
    if (agentType === 'dev-flow:dev-runner-haiku-ro' && label === 'realized-diff') {
      return { files: ['_lib/foo.test.mjs'] };
    }
    if (agentType === 'dev-flow:dev-runner-haiku' && label === 'declared-path-check') {
      return { files: ['_lib/foo.test.mjs'] };
    }
    if (label.startsWith('pr')) {
      return { pr_url: 'http://x', pr_number: 1, committed: true };
    }
    if (label === 'changed-files') {
      return { files: ['_lib/foo.test.mjs'] };
    }
    if (label === 'post-summary' && agentType === 'dev-flow:dev-runner-haiku') {
      return { posted: true, method: 'gh pr comment', url: 'http://x' };
    }
    // journal-save (stage1, issue #494): 実際の telemetry payload はここに載る
    if (label === 'journal-save' && agentType === 'dev-flow:dev-runner-haiku') {
      journalPrompts.push(prompt);
      return { saved: true, path: '/tmp/wt/.devflow-tmp/payload-test.json' };
    }
    if (label === 'journal-log' && agentType === 'dev-flow:dev-runner-haiku') {
      return { logged: true, summary: 'ok' };
    }
    if (agentType === 'dev-flow:dev-implementer') {
      return { status: 'DONE', task_id: 't', files: [], summary: '', concerns: [] };
    }
    if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) return { hash: 'H', empty: false };
    return null;
  };

  const parallelStub = async (fns) => Promise.all((fns || []).map((f) => f()));
  const workflowStub = async () => ({ status: 'lgtm', iterations: 1, fixes_applied: 0 });

  const sandbox = {
    phase: () => {},
    log: (m) => logs.push(String(m)),
    agent: agentStub,
    parallel: parallelStub,
    pipeline: async (items, cb) => Promise.all((items || []).map(async (item, i) => { try { const r = await cb(item, i); return r === undefined ? null : r; } catch { return null; } })),
    workflow: workflowStub,
    // REQ は args.setup.analyze から組まれる（Analyze phase は spawn しない）。AC 数を analyzeReq から給電する
    args: devFlowArgs('1', { analyze: prerunAnalyze({ acceptance_criteria: analyzeReq.acceptance_criteria, issue_type: analyzeReq.issue_type }) }),
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
      redgreenCalls: () => redgreenCalls,
      logs: () => logs,
      journalPrompts: () => journalPrompts,
    },
  };
}

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

function assertNoCrash(error) {
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }
}

// ============================================================
// フィクスチャ
// ============================================================

const ANALYZE_REQ_1AC = {
  summary: 's',
  acceptance_criteria: ['a'],
  issue_type: 'feat',
  scope: 'src',
  issue_number: 1,
  issue_title: 'stub-issue-title',
};

const ANALYZE_REQ_2AC = {
  summary: 's',
  acceptance_criteria: ['a', 'b'],
  issue_type: 'feat',
  scope: 'src',
  issue_number: 1,
  issue_title: 'stub-issue-title',
};

function evalTestVerified(acCount) {
  return {
    verdict: 'pass',
    total: 100,
    feedback: [],
    feedback_level: 'implementation',
    ac_results: Array.from({ length: acCount }, (_, i) => ({
      ac_index: i,
      satisfied: true,
      verified_by: 'test',
      test_files: [`t${i}.test.mjs`],
      impl_files: [`impl${i}.mjs`],
    })),
    security_clearance: [],
    testsurf_clearance: [],
  };
}

// ============================================================
// テストケース
// ============================================================

test('[redgreen-vdelta] (a) verdict 無し（{red:true,green:true}のみ）→ 素の昇格（deterministic 昇格 + checked ログ）', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, counters } = makeSandbox(ANALYZE_REQ_1AC, evalTestVerified(1), () => ({ red: true, green: true }));
  const { error } = await runDevFlowCapture(src, ctx);
  assertNoCrash(error);

  const logs = counters.logs();
  assert.ok(
    logs.some((l) => l.includes('AC-1: red→green 実証 → deterministic 昇格 + checked')),
    `verdict 無しなら素の昇格ログが出るべきだが: ${JSON.stringify(logs.filter((l) => l.includes('AC-1')))}`,
  );
});

test('[redgreen-vdelta] (b) verdict clean object → 昇格（deterministic 昇格 + checked ログ）', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const cleanVerdict = { comparability: 'exact', transitions: {}, verification_surface: { status: 'intact' } };
  const { ctx, counters } = makeSandbox(ANALYZE_REQ_1AC, evalTestVerified(1), () => ({ red: true, green: true, verdict: cleanVerdict }));
  const { error } = await runDevFlowCapture(src, ctx);
  assertNoCrash(error);

  const logs = counters.logs();
  assert.ok(
    logs.some((l) => l.includes('AC-1: red→green 実証 → deterministic 昇格 + checked')),
    `verdict clean なら昇格ログが出るべきだが: ${JSON.stringify(logs.filter((l) => l.includes('AC-1')))}`,
  );
});

test('[redgreen-vdelta] (c) verdict deny 対象（repaired_with_test_change + surface changed）→ 昇格不発 + vdelta deny ログ', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const denyVerdict = {
    comparability: 'exact',
    transitions: { repaired_with_test_change: ['t1'] },
    verification_surface: { status: 'changed' },
  };
  const { ctx, counters } = makeSandbox(ANALYZE_REQ_1AC, evalTestVerified(1), () => ({ red: true, green: true, verdict: denyVerdict }));
  const { error } = await runDevFlowCapture(src, ctx);
  assertNoCrash(error);

  const logs = counters.logs();
  assert.ok(
    !logs.some((l) => l.includes('AC-1: red→green 実証 → deterministic 昇格 + checked')),
    `deny 対象なら deterministic 昇格ログは出ないべきだが: ${JSON.stringify(logs.filter((l) => l.includes('AC-1')))}`,
  );
  assert.ok(
    logs.some((l) => l.includes('AC-1') && l.includes('vdelta deny')),
    `deny 対象なら vdelta deny ログが出るべきだが: ${JSON.stringify(logs.filter((l) => l.includes('AC-1')))}`,
  );
});

test('[redgreen-vdelta] (d) verdict が不正 JSON 文字列 → fail-open で昇格', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, counters } = makeSandbox(ANALYZE_REQ_1AC, evalTestVerified(1), () => ({ red: true, green: true, verdict: 'not-json{' }));
  const { error } = await runDevFlowCapture(src, ctx);
  assertNoCrash(error);

  const logs = counters.logs();
  assert.ok(
    logs.some((l) => l.includes('AC-1: red→green 実証 → deterministic 昇格 + checked')),
    `verdict が不正 JSON でも fail-open で昇格するべきだが: ${JSON.stringify(logs.filter((l) => l.includes('AC-1')))}`,
  );
});

test('[redgreen-vdelta] (e) AC 2 件 → AC ごとの verdict で両 AC とも昇格する（per-AC 判定）', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const verdictFor = (i) => ({ comparability: 'exact', transitions: {}, verification_surface: { status: 'intact' }, note: `v${i}` });
  const { ctx, counters } = makeSandbox(
    ANALYZE_REQ_2AC,
    evalTestVerified(2),
    (acIndex) => ({ red: true, green: true, verdict: verdictFor(acIndex) }),
  );
  const { error } = await runDevFlowCapture(src, ctx);
  assertNoCrash(error);

  const logs = counters.logs();
  for (const ac of ['AC-1', 'AC-2']) {
    assert.ok(
      logs.some((l) => l.includes(`${ac}: red→green 実証 → deterministic 昇格 + checked`)),
      `${ac} が昇格ログを出すべきだが: ${JSON.stringify(logs.filter((l) => l.includes(ac)))}`,
    );
  }
});

// redgreen のバッチ集約（AC 3 件 → 1 spawn・引数順・results の index 突合・欠落ペアの据え置き）は
// redgreen-targets.test.mjs が持つ。
