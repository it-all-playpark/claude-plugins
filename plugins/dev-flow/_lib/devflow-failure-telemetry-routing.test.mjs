// failure telemetry handoff のルーティングテスト（issue #225, 1-spawn handoff issue #807）。
// dev-flow.js の 4 つの失敗経路（analyze provenance / analyze ambiguity / implement
// NEEDS_CONTEXT / cross-repo graceful 終了。empty-diff throw も含む）に writeFailureTelemetry
// helper が呼ばれ、Merge tier 成功経路と同じく payload を pending/ へ直接書く journal-log-failure
// の 1 spawn が発生することを VM sandbox で検証する。結論値リテラル（outcome/error_category 等）は
// payload としてその prompt に載る。
//
// needs-clarification-routing.test.mjs / empty-diff-evaluate-routing.test.mjs /
// devflow-journal-log.test.mjs の makeSandbox / VM 実行パターンを踏襲する。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { devFlowArgs, prerunAnalyze, makeDevFlowSandbox, runWorkflowCapture } from './test-helpers/vm-sandbox.mjs';
import { PLUGIN_VERSION } from './plugin-version.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');

// ---- VM sandbox helpers ----

function makeSandbox({ analyzeReq, implementerFn, diffGateConfig, journalLogFailureResult } = {}) {
  const calls = [];
  let implementerCallIndex = 0;
  const { gateEmpty = false, retryEmpty = false } = diffGateConfig || {};

  const agentStub = async (prompt, opts) => {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';
    calls.push({ label, agentType, prompt: String(prompt ?? '') });

    if (label === 'setup-base') return { ok: true, default_branch: 'main', dev_exists: true, requested_exists: false, worktree_exists: false, upstream_remote: '', upstream_merge: '' };
    if (label === 'worktree') return { worktree: '/tmp/wt', branch: 'feature/issue-1', repo: 'acme/skills' };
    if (label.startsWith('danger-grep')) return { ok: true, hits: [] };
    if (label === 'realized-diff') return { files: ['src/foo.ts'] };
    if (label === 'declared-path-check') return { files: [] };
    if (label === 'changed-files') return { files: ['src/foo.ts'] };
    if (label.startsWith('test')) return { tests: 'no_tests', green: true, summary: '' };
    if (label.startsWith('redgreen')) return { red: false, green: false, reason: 'stub' };
    if (agentType === 'dev-flow:evaluator') {
      return {
        verdict: 'pass', total: 100, threshold: 80,
        feedback: [], feedback_level: 'implementation', ac_results: [], security_clearance: [],
      };
    }
    if (label.startsWith('pr')) return { pr_url: 'http://x', pr_number: 1, committed: true };
    if (label === 'post-summary') return { posted: true, method: 'gh pr comment', url: 'http://x' };
    if (label === 'journal-log' && agentType === 'dev-flow:dev-runner-haiku') return { saved: true, logged: true };
    // journal-log-failure: 既定は null を返す（null 容認設計を確認するため）。
    // journalLogFailureResult でケースごとに上書き可能。
    if (label === 'journal-log-failure') return journalLogFailureResult !== undefined ? journalLogFailureResult : null;
    if (label === 'diff-gate') return { hash: gateEmpty ? 'EMPTY' : 'H', empty: gateEmpty };
    if (label === 'diff-gate-retry') return { hash: retryEmpty ? 'EMPTY' : 'H', empty: retryEmpty };
    if (label.startsWith('diff-hash')) return { hash: 'H', empty: false };
    if (agentType === 'dev-flow:dev-implementer') {
      const fn = implementerFn ?? (() => ({
        status: 'DONE', task_id: 'T1', files: [], summary: '', concerns: [],
        blocking_reason: null, missing_context: null,
      }));
      const result = fn(implementerCallIndex);
      implementerCallIndex++;
      return result;
    }
    return null;
  };

  const parallelStub = async (fns) => Promise.all((fns || []).map((f) => f()));
  const workflowStub = async () => ({ status: 'lgtm', iterations: 1, fixes_applied: 0 });

  const sandbox = {
    phase: () => {}, log: () => {}, agent: agentStub, parallel: parallelStub,
    pipeline: async (items, cb) => Promise.all((items || []).map(async (item, i) => { try { const r = await cb(item, i); return r === undefined ? null : r; } catch { return null; } })),
    // REQ は args.setup.analyze から組まれる（Analyze phase は spawn しない）
    workflow: workflowStub, args: devFlowArgs('1', { repo: 'acme/skills', analyze: prerunAnalyze({ acceptance_criteria: analyzeReq.acceptance_criteria, issue_type: analyzeReq.issue_type }) }),
    console, JSON, Math, String, Number, Boolean, Array, Object, Error,
    RegExp, Promise, Symbol, Map, Set, Date,
  };

  const ctx = vm.createContext(sandbox);
  return { ctx, calls };
}

async function runDevFlowInSandbox(src, ctx) {
  const stripped = src
    .replace(/^export\s+const\s+/gm, 'const ')
    .replace(/^export\s+function\s+/gm, 'function ');
  const wrapped = `(async () => {\n${stripped}\n})();`;

  let caughtError = null;
  let result = null;
  try {
    const promise = vm.runInContext(wrapped, ctx, { filename: '.claude/workflows/dev-flow.js' });
    if (promise && typeof promise.then === 'function') {
      result = await promise.catch((e) => { caughtError = e; return null; });
    }
  } catch (e) {
    caughtError = e;
  }
  return { error: caughtError, result };
}

const src = readFileSync(devFlowPath, 'utf8');

// ============================================================
// ケース (1): analyze 経路（AC 空 → needs_clarification）
// - journal-log-failure が 1 回発生し prompt に結論値の必須キーと pending パスを含む
// - workflow の返り値が status:'needs_clarification' / source:'analyze' / journal_log_status
//   （journal-log-failure が null を返すため 'save_failed'）
// ============================================================
test('[failure-telemetry] (1) analyze 経路: AC 空 → journal-log-failure の 1 spawn が発生し新契約に従う', async () => {
  const analyzeReq = {
    summary: 's',
    acceptance_criteria: [],
    issue_type: 'feat',
    scope: 'src',
    issue_number: 1,
    issue_title: 'stub-issue-title',
  };

  const { ctx, calls } = makeSandbox({ analyzeReq });
  const { error, result } = await runDevFlowInSandbox(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  assert.equal(calls.filter((c) => c.label === 'journal-save').length, 0, '(1) journal-save spawn は起動しない');
  const saveCalls = calls.filter((c) => c.label === 'journal-log-failure' && c.agentType === 'dev-flow:dev-runner-haiku');
  assert.equal(saveCalls.length, 1,
    `(1) journal-log-failure は 1 回のはずだが ${saveCalls.length} 回だった (labels: ${calls.map((c) => c.label).join(', ')})`);

  const savePrompt = saveCalls[0]?.prompt ?? '';
  for (const key of ['"outcome":"failure"', '"error_category":"needs_clarification"', '"repo":"acme/skills"']) {
    assert.ok(savePrompt.includes(key),
      `(1) journal-log-failure prompt に '${key}' が含まれるべきだが含まれていなかった。prompt:\n${savePrompt.slice(0, 500)}`);
  }
  assert.ok(!savePrompt.includes('"pr_number"'),
    `(1) failure 経路は PR 作成前のため journal-log-failure prompt に '"pr_number"' を含むべきではない。prompt:\n${savePrompt.slice(0, 500)}`);
  assert.ok(savePrompt.includes('~/.claude/journal/pending/devflow-1-effect-'),
    `(1) journal-log-failure prompt に pending パスが含まれるべきだが含まれていなかった。prompt:\n${savePrompt.slice(0, 500)}`);

  assert.equal(result?.status, 'needs_clarification',
    `(1) result.status は 'needs_clarification' のはずだが ${JSON.stringify(result?.status)} だった`);
  assert.equal(result?.source, 'analyze',
    `(1) result.source は 'analyze' のはずだが ${JSON.stringify(result?.source)} だった`);
  // journal-log-failure スタブは null を返す（既定）ため Write 到達の申告が無い → 'save_failed'
  assert.equal(result?.journal_log_status, 'save_failed',
    `(1) journal-log-failure が null を返す場合 result.journal_log_status は 'save_failed' のはずだが ${JSON.stringify(result?.journal_log_status)} だった`);
});

// ============================================================
// ケース (2): implement 経路（NEEDS_CONTEXT 解消不能 → needs_clarification）
// - journal-log-failure が 1 回発生し prompt に plugin_version を含む（shape は実効 shape 確定前なのでキー欠落。issue #676）
// - journal-log-failure が {saved:true, logged:true} を返すとき result.journal_log_status === 'logged'
// - result.source === 'implement'
// ============================================================
test('[failure-telemetry] (2) implement 経路: NEEDS_CONTEXT 解消不能 → journal-log-failure が新契約に従い journal_log_status が配線される', async () => {
  const analyzeReq = {
    summary: 's',
    acceptance_criteria: ['ac1', 'ac2'],
    issue_type: 'feat',
    scope: 'src',
    issue_number: 1,
    issue_title: 'stub-issue-title',
  };

  const implementerFn = () => ({
    status: 'NEEDS_CONTEXT', task_id: 'T1', files: [], summary: '', concerns: [],
    blocking_reason: null, missing_context: 'API 仕様が不明',
  });

  const { ctx, calls } = makeSandbox({ analyzeReq, implementerFn, journalLogFailureResult: { saved: true, logged: true } });
  const { error, result } = await runDevFlowInSandbox(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  const saveCalls = calls.filter((c) => c.label === 'journal-log-failure' && c.agentType === 'dev-flow:dev-runner-haiku');
  assert.equal(saveCalls.length, 1,
    `(2) journal-log-failure は 1 回のはずだが ${saveCalls.length} 回だった`);

  const savePrompt = saveCalls[0]?.prompt ?? '';
  for (const key of ['"outcome":"failure"', '"error_category":"needs_clarification"', '"plugin_version"', '"repo":"acme/skills"']) {
    assert.ok(savePrompt.includes(key),
      `(2) journal-log-failure prompt に '${key}' が含まれるべきだが含まれていなかった。prompt:\n${savePrompt.slice(0, 500)}`);
  }
  // 実効 shape は Diff triage（realized diff 取得後）で確定する（issue #676）。Implement の失敗 telemetry は
  // 確定前なので shape キーを載せない。
  assert.ok(!savePrompt.includes('"shape"'),
    `(2) 実効 shape 確定前の failure telemetry に '"shape"' キーを含むべきではないが含まれていた。prompt:\n${savePrompt.slice(0, 500)}`);
  assert.ok(!savePrompt.includes('"pr_number"'),
    `(2) failure 経路は PR 作成前のため journal-log-failure prompt に '"pr_number"' を含むべきではない。prompt:\n${savePrompt.slice(0, 500)}`);

  assert.equal(result?.status, 'needs_clarification',
    `(2) result.status は 'needs_clarification' のはずだが ${JSON.stringify(result?.status)} だった`);
  assert.equal(result?.source, 'implement',
    `(2) result.source は 'implement' のはずだが ${JSON.stringify(result?.source)} だった`);
  assert.equal(result?.journal_log_status, 'logged',
    `(2) journal-log-failure が logged:true を返す場合 result.journal_log_status は 'logged' のはずだが ${JSON.stringify(result?.journal_log_status)} だった`);
});

// ============================================================
// ケース (3): empty-diff 経路（diff-gate + diff-gate-retry 両方 empty:true → throw）
// empty-diff の journal 実行はここ 1 か所だけで行い（1 run を共有）、journal-log-failure の prompt に
// 載るべき / 載ってはいけないキーを表で検査する。各キーを pin する理由:
//   outcome / error_category / repo / pr_number 不在: failure handoff の結論値（PR 作成前）
//   skill:"dev-flow": meta.name を dev-flow-run に改名しても集計連続性のため変えない
//   eval / impl / review_model_config・plugin_version・plugin_commit: 失敗 entry でも model / version 帰属を残す
//   quality_model_*: 撤去済みキー
// ============================================================

const EMPTY_DIFF_COMMIT = '1ef2e0ab6254';

let emptyDiffRun = null;
function runEmptyDiff() {
  emptyDiffRun ??= (async () => {
    const { ctx, calls } = makeDevFlowSandbox({
      overrides: {
        'diff-gate': { hash: 'H', empty: true },
        'diff-gate-retry': { hash: 'H', empty: true },
        'issue-labels': null,
      },
      extra: { args: devFlowArgs(1, { repo: 'acme/skills', plugin_commit: EMPTY_DIFF_COMMIT }) },
    });
    const { error } = await runWorkflowCapture(src, ctx);
    const failureCalls = calls.filter((c) => c.label === 'journal-log-failure' && c.agentType === 'dev-flow:dev-runner-haiku');
    return { error, calls, failureCalls, prompt: failureCalls[0]?.prompt ?? '' };
  })();
  return emptyDiffRun;
}

test('[failure-telemetry] (3) empty-diff 経路: 両方 empty:true → throw し、throw 前に journal-log-failure が 1 回だけ phase Validate で発生する', async () => {
  const { error, calls, failureCalls } = await runEmptyDiff();
  assert.ok(error !== null, '(3) 両方 empty:true なら workflow が throw すべきだが error が null だった');
  assert.match(error.message, /empty-diff gate/, `(3) error.message に 'empty-diff gate' を含むべきだが: ${error?.message}`);
  assert.equal(failureCalls.length, 1, `(3) journal-log-failure は 1 回のはずだが ${failureCalls.length} 回だった (labels: ${calls.map((c) => c.label).join(', ')})`);
  // writeFailureTelemetry は payload に "phase" キーを含めない（opts.phase のみで観測される）
  const journalCalls = calls.filter((c) => c.label?.startsWith('journal-log'));
  assert.ok(journalCalls.length > 0, "label 'journal-log*' の call が見つからない");
  for (const call of journalCalls) assert.equal(call.opts.phase, 'Validate', `${call.label} の opts.phase`);
});

const EMPTY_DIFF_REQUIRED_KEYS = [
  '"outcome":"failure"',
  '"error_category":"empty_diff"',
  '"repo":"acme/skills"',
  '"skill":"dev-flow"',
  '"eval_model_config":"opus"',
  '"impl_model_config":"opus"',
  '"review_model_config":"opus"',
  `"plugin_version":"${PLUGIN_VERSION}"`,
  `"plugin_commit":"${EMPTY_DIFF_COMMIT}"`,
];

const EMPTY_DIFF_FORBIDDEN_KEYS = ['"pr_number"', '"quality_model_config"', '"quality_model_fallback_label"'];

test.each(EMPTY_DIFF_REQUIRED_KEYS)('[failure-telemetry] (3) empty-diff 経路: journal-log-failure prompt に %s が載る', async (key) => {
  const { prompt } = await runEmptyDiff();
  assert.ok(prompt.includes(key), `(3) journal-log-failure prompt に '${key}' が含まれるべきだが含まれていなかった。prompt:\n${prompt.slice(0, 500)}`);
});

test.each(EMPTY_DIFF_FORBIDDEN_KEYS)('[failure-telemetry] (3) empty-diff 経路: journal-log-failure prompt に %s が載らない', async (key) => {
  const { prompt } = await runEmptyDiff();
  assert.ok(!prompt.includes(key), `(3) journal-log-failure prompt に '${key}' を含むべきではない。prompt:\n${prompt.slice(0, 500)}`);
});

// ============================================================
// ケース (4): 完走経路（全 stub 正常）
// - journal-log-failure が 0 回
// - journal-log（success）が 1 回・prompt に '"outcome":"success"' を含む
// - result.journal_log_status === 'logged'（journal-log が logged:true を返すため）
// ============================================================
test('[failure-telemetry] (4) 完走経路: journal-log-failure が 0 回・journal-log(success) が 1 回・outcome:success を含み journal_log_status が logged', async () => {
  const analyzeReq = {
    summary: 's',
    acceptance_criteria: ['ac1', 'ac2', 'ac3'],
    issue_type: 'feat',
    scope: 'src',
    issue_number: 1,
    issue_title: 'stub-issue-title',
  };

  const { ctx, calls } = makeSandbox({ analyzeReq });
  const { error, result } = await runDevFlowInSandbox(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  const failureCalls = calls.filter((c) => c.label === 'journal-log-failure');
  assert.equal(failureCalls.length, 0,
    `(4) 完走経路では journal-log-failure は 0 回のはずだが ${failureCalls.length} 回だった`);

  const successCalls = calls.filter(
    (c) => c.label === 'journal-log' && c.agentType === 'dev-flow:dev-runner-haiku',
  );
  assert.equal(successCalls.length, 1,
    `(4) journal-log(success) は 1 回のはずだが ${successCalls.length} 回だった`);

  const successPrompt = successCalls[0]?.prompt ?? '';
  assert.ok(successPrompt.includes('"outcome":"success"'),
    `(4) journal-log(success) prompt に '"outcome":"success"' が含まれるべきだが:\n${successPrompt.slice(0, 500)}`);

  assert.ok(result?.pr_url != null,
    `(4) 完走経路では result.pr_url が存在するべきだが ${JSON.stringify(result?.pr_url)} だった`);
  assert.equal(result?.journal_log_status, 'logged',
    `(4) journal-log が logged:true を返す完走経路では result.journal_log_status は 'logged' のはずだが ${JSON.stringify(result?.journal_log_status)} だった`);
});
