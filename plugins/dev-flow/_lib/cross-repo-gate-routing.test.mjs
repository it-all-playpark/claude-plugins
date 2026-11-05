// cross-repo-gate の empty-diff gate 配線ルーティングテスト（issue #432）。
// _lib/empty-diff-evaluate-routing.test.mjs の makeCountingSandbox / runWorkflowCapture
// パターンを踏襲し、dhGate.empty===true 時の lazy issue-labels probe / cross-repo-artifacts
// 検証 / __earlyReturn 配線を VM sandbox で検証する。
//
// analyzeReq は acceptance_criteria あり・issue_type:'fix'（実効 shape は realized diff から決まる、
// issue_type:'fix'）で runEval を成立させる。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { devFlowArgs, JS_GLOBALS, runWorkflowCapture } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');

function makeCountingSandbox(analyzeReq, config) {
  const calls = [];
  const {
    gateEmpty = false,
    retryEmpty = false,
    issueLabelsRes = { ok: true, labels: [] },
    crossRepoArtifactsRes = { ok: true, found: 0, artifacts: [] },
    implementerFiles = [],
  } = config || {};

  const agentStub = async (prompt, opts) => {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';
    calls.push({ label, agentType, prompt: String(prompt ?? ''), phase: opts?.phase ?? null });

    if (label === 'diff-gate') return { hash: gateEmpty ? 'EMPTY' : 'H', empty: gateEmpty };
    if (label === 'diff-gate-retry') return { hash: retryEmpty ? 'EMPTY' : 'H', empty: retryEmpty };
    if (label === 'diff-hash-eval') return { hash: 'H', empty: false };
    if (label === 'diff-hash-pr') return { hash: 'H', empty: false };
    if (label === 'issue-labels') return issueLabelsRes;
    if (label === 'cross-repo-artifacts') return crossRepoArtifactsRes;
    if (label === 'worktree') return { worktree: '/tmp/wt', branch: 'feature/issue-1', repo: 'acme/skills' };
    if (label.startsWith('analyze')) return analyzeReq;
    if (label.startsWith('danger-grep')) return { ok: true, hits: [] };
    if (label === 'realized-diff') return { files: ['src/foo.ts'] };
    if (label === 'declared-path-check') return { files: [] };
    if (label.startsWith('test')) return { tests: 'no_tests', green: true, summary: '' };
    if (label.startsWith('redgreen')) return { red: false, green: false, reason: 'stub' };
    if (agentType === 'dev-flow:evaluator') return { verdict: 'pass', total: 100, threshold: 80, feedback: [], feedback_level: 'implementation', ac_results: [], security_clearance: [] };
    if (label.startsWith('pr')) return { pr_url: 'http://x', pr_number: 1, committed: true };
    if (label === 'journal-log-failure') return null;
    if (label === 'journal-log' && agentType === 'dev-flow:dev-runner-haiku') return { saved: true, logged: true };
    if (label === 'post-summary') return { posted: true, method: 'gh pr comment', url: 'http://x' };
    if (agentType === 'dev-flow:dev-implementer') {
      return { status: 'DONE', task_id: 'T1', files: implementerFiles, summary: '', concerns: [], blocking_reason: null, missing_context: null };
    }
    return null;
  };

  const parallelStub = async (fns) => Promise.all((fns || []).map((f) => f()));
  const sandbox = {
    phase: () => {}, log: () => {}, agent: agentStub, parallel: parallelStub,
    pipeline: async (items, cb) => Promise.all((items || []).map(async (item, i) => { try { const r = await cb(item, i); return r === undefined ? null : r; } catch { return null; } })),
    workflow: async () => ({ status: 'lgtm', iterations: 1, fixes_applied: 0 }), args: devFlowArgs('1'),
    ...JS_GLOBALS,
  };
  const ctx = vm.createContext(sandbox);
  return { ctx, calls };
}

const STANDARD_REQ = {
  summary: 's',
  acceptance_criteria: ['ac1', 'ac2'],
  issue_type: 'fix',
  scope: 'src',
  issue_number: 1,
  issue_title: 'stub-issue-title',
};

const src = readFileSync(devFlowPath, 'utf8');

// (1) diff-gate empty=true + cross-repo ラベル + found=1 → throw なし・reimpl-empty-diff 無し・
//     status==='cross_repo_artifact'・journal-log-failure prompt に 'cross_repo' を含み 'empty_diff' を含まない
test('[cross-repo-gate] (1) label=cross-repo かつ found>=1 → graceful 終了・status=cross_repo_artifact', async () => {
  const { ctx, calls } = makeCountingSandbox(STANDARD_REQ, {
    gateEmpty: true,
    issueLabelsRes: { ok: true, labels: ['cross-repo'] },
    crossRepoArtifactsRes: { ok: true, found: 1, artifacts: [{ path: '/tmp/other-repo/bar.ts', exists: true, repo_root: '/tmp/other-repo', dirty: true }] },
    implementerFiles: ['/tmp/other-repo/bar.ts'],
  });
  const { error, result: returned } = await runWorkflowCapture(src, ctx);
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) assert.fail(`dev-flow.js crash: ${error.name}: ${error.message}`);
  if (error) assert.fail(`(1) 想定外エラー: ${error.message}`);

  const reimplCalls = calls.filter((c) => c.label.startsWith('reimpl-empty-diff'));
  assert.strictEqual(reimplCalls.length, 0, `(1) cross-repo 成立時は reimpl-empty-diff 0 件のはずだが ${reimplCalls.length} 件`);

  assert.ok(returned !== null, '(1) return object を返すべき');
  assert.strictEqual(returned?.status, 'cross_repo_artifact', `(1) status は 'cross_repo_artifact' のはずだが ${JSON.stringify(returned?.status)}`);

  // 結論値リテラル（error_category 等）は payload として journal-log-failure の prompt に載る（issue #807: 1 spawn）。
  const failureCalls = calls.filter((c) => c.label === 'journal-log-failure' && c.agentType === 'dev-flow:dev-runner-haiku');
  assert.strictEqual(failureCalls.length, 1, `(1) journal-log-failure は 1 回のはずだが ${failureCalls.length} 回`);
  const savePrompt = failureCalls[0]?.prompt ?? '';
  assert.ok(savePrompt.includes('cross_repo'), `(1) journal-log-failure prompt に 'cross_repo' を含むべきだが:\n${savePrompt.slice(0, 500)}`);
  assert.ok(!savePrompt.includes('"error_category":"empty_diff"'), `(1) journal-log-failure prompt に empty_diff を含むべきでないが:\n${savePrompt.slice(0, 500)}`);
});

// (2) empty=true + ラベルあり + found=0 → 既存挙動（reimpl-empty-diff → diff-gate-retry empty=true → throw、error_category empty_diff）
test('[cross-repo-gate] (2) label=cross-repo だが found=0 → 既存 fail-closed 経路のまま throw', async () => {
  const { ctx, calls } = makeCountingSandbox(STANDARD_REQ, {
    gateEmpty: true,
    retryEmpty: true,
    issueLabelsRes: { ok: true, labels: ['cross-repo'] },
    crossRepoArtifactsRes: { ok: true, found: 0, artifacts: [] },
    implementerFiles: ['/tmp/other-repo/bar.ts'],
  });
  const { error } = await runWorkflowCapture(src, ctx);
  assert.ok(error !== null, '(2) found=0 なら従来通り throw すべきだが error が null だった');
  assert.ok(typeof error?.message === 'string' && error.message.includes('empty-diff gate'), `(2) error.message に 'empty-diff gate' を含むべきだが: ${error?.message}`);

  const reimplCalls = calls.filter((c) => c.label.startsWith('reimpl-empty-diff'));
  assert.ok(reimplCalls.length >= 1, `(2) reimpl-empty-diff は >= 1 件のはずだが ${reimplCalls.length} 件`);

  const failureCalls = calls.filter((c) => c.label === 'journal-log-failure' && c.agentType === 'dev-flow:dev-runner-haiku');
  assert.strictEqual(failureCalls.length, 1, `(2) journal-log-failure は 1 回のはずだが ${failureCalls.length} 回`);
  const savePrompt = failureCalls[0]?.prompt ?? '';
  assert.ok(savePrompt.includes('"error_category":"empty_diff"'), `(2) journal-log-failure prompt に empty_diff を含むべきだが:\n${savePrompt.slice(0, 500)}`);
});

// (3) empty=true + labels=[] → issue-labels probe 1 回のみで既存挙動維持
test('[cross-repo-gate] (3) labels=[] → issue-labels probe 1 回のみ・cross-repo-artifacts は呼ばれない・既存 throw 挙動', async () => {
  const { ctx, calls } = makeCountingSandbox(STANDARD_REQ, {
    gateEmpty: true,
    retryEmpty: true,
    issueLabelsRes: { ok: true, labels: [] },
  });
  const { error } = await runWorkflowCapture(src, ctx);
  assert.ok(error !== null, '(3) labels=[] なら従来通り throw すべきだが error が null だった');

  const labelCalls = calls.filter((c) => c.label === 'issue-labels');
  assert.strictEqual(labelCalls.length, 1, `(3) issue-labels probe は 1 回のはずだが ${labelCalls.length} 回`);
  const artifactCalls = calls.filter((c) => c.label === 'cross-repo-artifacts');
  assert.strictEqual(artifactCalls.length, 0, `(3) cross-repo-artifacts は 0 回のはずだが ${artifactCalls.length} 回`);
});

// (4) empty=true + issue-labels が null/ok:false → fail-safe で既存挙動
test('[cross-repo-gate] (4) issue-labels が ok:false → fail-safe で既存 throw 挙動・cross-repo-artifacts 0 回', async () => {
  const { ctx, calls } = makeCountingSandbox(STANDARD_REQ, {
    gateEmpty: true,
    retryEmpty: true,
    issueLabelsRes: { ok: false, error: 'gh not found' },
  });
  const { error } = await runWorkflowCapture(src, ctx);
  assert.ok(error !== null, '(4) issue-labels 失敗時も従来通り throw すべきだが error が null だった');
  assert.ok(typeof error?.message === 'string' && error.message.includes('empty-diff gate'), `(4) error.message に 'empty-diff gate' を含むべきだが: ${error?.message}`);

  const artifactCalls = calls.filter((c) => c.label === 'cross-repo-artifacts');
  assert.strictEqual(artifactCalls.length, 0, `(4) cross-repo-artifacts は 0 回のはずだが ${artifactCalls.length} 回`);
});

// (4b) issue-labels が null を返す場合も fail-safe
test('[cross-repo-gate] (4b) issue-labels が null → fail-safe で既存 throw 挙動', async () => {
  const { ctx } = makeCountingSandbox(STANDARD_REQ, {
    gateEmpty: true,
    retryEmpty: true,
    issueLabelsRes: null,
  });
  const { error } = await runWorkflowCapture(src, ctx);
  assert.ok(error !== null, '(4b) issue-labels null 時も従来通り throw すべきだが error が null だった');
  assert.ok(typeof error?.message === 'string' && error.message.includes('empty-diff gate'), `(4b) error.message に 'empty-diff gate' を含むべきだが: ${error?.message}`);
});

// (5) empty=false → issue-labels / cross-repo-artifacts の呼び出しが 0 回
test('[cross-repo-gate] (5) diff-gate empty=false → issue-labels / cross-repo-artifacts は呼ばれない', async () => {
  const { ctx, calls } = makeCountingSandbox(STANDARD_REQ, { gateEmpty: false });
  const { error, result: returned } = await runWorkflowCapture(src, ctx);
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) assert.fail(`dev-flow.js crash: ${error.name}: ${error.message}`);
  if (error) assert.fail(`(5) 想定外エラー: ${error.message}`);
  assert.ok(returned !== null, '(5) return object を返すべき');

  const labelCalls = calls.filter((c) => c.label === 'issue-labels');
  assert.strictEqual(labelCalls.length, 0, `(5) issue-labels は 0 回のはずだが ${labelCalls.length} 回`);
  const artifactCalls = calls.filter((c) => c.label === 'cross-repo-artifacts');
  assert.strictEqual(artifactCalls.length, 0, `(5) cross-repo-artifacts は 0 回のはずだが ${artifactCalls.length} 回`);
});

// (6) cross-repo ラベルはあるが implementer の申告ファイルが worktree 外に無い（候補 0 件）→ cross-repo-artifacts は呼ばれず既存 fail-closed 経路
test('[cross-repo-gate] (6) label=cross-repo だが候補パス 0 件 → cross-repo-artifacts は呼ばれず既存 throw 挙動', async () => {
  const { ctx, calls } = makeCountingSandbox(STANDARD_REQ, {
    gateEmpty: true,
    retryEmpty: true,
    issueLabelsRes: { ok: true, labels: ['cross-repo'] },
    implementerFiles: [],
  });
  const { error } = await runWorkflowCapture(src, ctx);
  assert.ok(error !== null, '(6) 候補パス 0 件なら従来通り throw すべきだが error が null だった');

  const artifactCalls = calls.filter((c) => c.label === 'cross-repo-artifacts');
  assert.strictEqual(artifactCalls.length, 0, `(6) cross-repo-artifacts は 0 回のはずだが ${artifactCalls.length} 回`);
});
