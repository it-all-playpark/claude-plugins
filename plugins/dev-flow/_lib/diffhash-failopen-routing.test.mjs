// diffhash-failopen-routing: VM sandbox routing test for dev-flow の diff-hash 3 箇所
// （diff-hash-eval / diff-hash-pr / merge-tier-facts の diffhash）の fail-open 配線（issue #605）。
//
// 3 箇所とも `trackedAgent` 直呼びから `failOpenAgent`（`retryOnContractViolation: true`）経由へ
// 置換済みで、proxy agent が throw（StructuredOutput 未返却・実行失敗）しても run 全体が abort
// せず、既存の null 経路（stale-eval 検出 skip / Merge tier の risk・changed を facts で再判定）へ
// 合流して journal handoff まで完走することを実証する。
//
// ハーネスは _lib/merge-tier-diffhash-reuse-routing.test.mjs の createResponder / STANDARD_REQ を
// 踏襲し、_lib/test-helpers/vm-sandbox.mjs の makeRecordingSandbox / runDevFlowInSandbox を使う。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeRecordingSandbox, runDevFlowInSandbox, devFlowArgs, mergeTierFacts } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');
const devFlowSrc = readFileSync(devFlowPath, 'utf8');

function assertNoCrash(error, name) {
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`[${name}] dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }
}

// StructuredOutput 契約違反メッセージ（trackedAgent の retryOnContractViolation 判定文字列を含む）
const CV = 'agent({schema}): subagent completed without calling StructuredOutput';

// standard に落ちる req（count=3 ≤ 5, ac.length=2 ≤ 6, type=fix → floor='standard'）
const STANDARD_REQ = {
  summary: 's',
  acceptance_criteria: ['a', 'b'],
  issue_type: 'fix',
  scope: 'src',
  issue_number: 605,
  issue_title: 'stub-issue-title',
};

// ============================================================
// responder factory: merge-tier-diffhash-reuse-routing.test.mjs の createResponder を複製
// （danger-grep の diffhash が既定で SAMEHASH を返す — state.secDiffHash が non-null になり
// merge-tier-facts の diffhash が参照される条件を満たす）。
// ============================================================
function createResponder(overrides = {}) {
  return function ({ label, agentType, prompt }) {
    if (Object.prototype.hasOwnProperty.call(overrides, label)) {
      const v = overrides[label];
      if (typeof v === 'function') return v({ prompt, agentType, label });
      return v;
    }
    if (label === 'setup-base') return { ok: true, default_branch: 'main', dev_exists: true, requested_exists: false, worktree_exists: false, upstream_remote: '', upstream_merge: '' };
    if (label === 'worktree') return { worktree: '/tmp/wt', branch: 'feature/issue-605' };
    if (label.startsWith('analyze')) return STANDARD_REQ;
    if (label === 'danger-grep') {
      return { risk: { ok: true, hits: [] }, files: ['src/x.ts'], struct: null, diffhash: { hash: 'SAMEHASH', empty: false } };
    }
    if (agentType === 'dev-flow:evaluator') {
      return {
        verdict: 'pass', total: 100, threshold: 80, feedback: [],
        feedback_level: 'implementation',
        ac_results: [
          { ac_index: 0, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
          { ac_index: 1, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
        ],
        security_clearance: [], concern_resolutions: [],
      };
    }
    if (label.startsWith('pr')) return { pr_url: 'http://x', pr_number: 1, committed: true };
    if (label === 'merge-tier-facts') return mergeTierFacts({ hash: 'SAMEHASH', files: ['src/x.ts'] });
    if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) return { hash: 'H', empty: false };
    if (label === 'post-summary') return { posted: true, method: 'gh pr comment', url: 'http://x' };
    if (label === 'journal-log') return { saved: true, logged: true };
    if (agentType === 'dev-flow:dev-implementer') return { status: 'DONE', task_id: 't', files: ['src/x.ts'], summary: 's', concerns: [] };
    if (label.startsWith('test')) return { tests: 'passed', green: true, summary: '' };
    if (label === 'issue-meta') return { ok: true, number: 605, title: 'stub-issue-title' };
    return null;
  };
}

function makeSandbox({ overrides = {} } = {}) {
  const logs = [];
  const { ctx, calls } = makeRecordingSandbox(createResponder(overrides), {
    workflow: async () => ({ status: 'lgtm', iterations: 2, fixes_applied: 0 }),
    args: devFlowArgs('605'),
    log: (m) => logs.push(String(m)),
  });
  return { ctx, calls, logs };
}

// ============================================================
// (a) diff-hash-eval が契約違反で throw → 継続 + リトライ2回 + 警告ログ + Evaluate/handoff 到達
// ============================================================

test('[diffhash-failopen] (a) diff-hash-eval が契約違反で throw → run 完走・2 回呼ばれ吸収・警告 log・Evaluate/journal-log 到達', async () => {
  const { ctx, calls, logs } = makeSandbox({
    overrides: {
      'diff-hash-eval': () => { throw new Error(CV) },
    },
  });
  const err = await runDevFlowInSandbox(devFlowSrc, ctx);
  assertNoCrash(err, 'a');
  assert.equal(err, null, `(a) run は abort せず完走するはずだが error: ${err?.name}: ${err?.message}`);

  const dhEvalCalls = calls.filter((c) => c.label === 'diff-hash-eval');
  assert.equal(dhEvalCalls.length, 2, `(a) 契約違反リトライで diff-hash-eval は 2 回呼ばれるはずだが ${dhEvalCalls.length} 回`);

  assert.ok(logs.some((l) => l.includes('diff-hash-eval') && l.includes('fail-open')), '(a) diff-hash-eval の fail-open 警告 log が無い');
  assert.ok(logs.some((l) => l.includes('stale-eval 検出は skip')), '(a) stale-eval skip の警告 log が無い');

  assert.ok(calls.some((c) => c.agentType === 'dev-flow:evaluator'), '(a) Evaluate phase（evaluator 呼び出し）へ継続しているはず');
  assert.ok(calls.some((c) => c.label === 'journal-log'), '(a) journal-log まで到達しているはず（handoff 到達）');
});

// ============================================================
// (b) diff-hash-pr が契約違反以外の理由で throw → リトライなし 1 回のみ + 継続
// ============================================================

test('[diffhash-failopen] (b) diff-hash-pr が非契約違反エラーで throw → run 完走・1 回のみ呼ばれ吸収・警告 log・journal-log 到達', async () => {
  const { ctx, calls, logs } = makeSandbox({
    overrides: {
      'diff-hash-pr': () => { throw new Error('EPERM: operation not permitted') },
    },
  });
  const err = await runDevFlowInSandbox(devFlowSrc, ctx);
  assertNoCrash(err, 'b');
  assert.equal(err, null, `(b) run は abort せず完走するはずだが error: ${err?.name}: ${err?.message}`);

  const dhPrCalls = calls.filter((c) => c.label === 'diff-hash-pr');
  assert.equal(dhPrCalls.length, 1, `(b) 契約違反以外はリトライしないため diff-hash-pr は 1 回のみ呼ばれるはずだが ${dhPrCalls.length} 回`);

  assert.ok(logs.some((l) => l.includes('diff-hash-pr の取得に失敗 — stale-eval 検出は skip')), '(b) diff-hash-pr の fail-open 警告 log が無い');
  assert.ok(calls.some((c) => c.label === 'journal-log'), '(b) journal-log まで到達しているはず（handoff 到達）');
});

// ============================================================
// (c) merge-tier-facts が契約違反で throw → 継続 + リトライ2回 + risk fail-closed（HOLD）+ handoff 到達
// ============================================================

test('[diffhash-failopen] (c) merge-tier-facts が契約違反で throw → run 完走・2 回呼ばれ吸収・risk fail-closed で HOLD・journal-log 到達', async () => {
  const { ctx, calls, logs } = makeSandbox({
    overrides: {
      'merge-tier-facts': () => { throw new Error(CV) },
    },
  });
  const err = await runDevFlowInSandbox(devFlowSrc, ctx);
  assertNoCrash(err, 'c');
  assert.equal(err, null, `(c) run は abort せず完走するはずだが error: ${err?.name}: ${err?.message}`);

  const factCalls = calls.filter((c) => c.label === 'merge-tier-facts');
  assert.equal(factCalls.length, 2, `(c) 契約違反リトライで merge-tier-facts は 2 回呼ばれるはずだが ${factCalls.length} 回`);

  assert.ok(logs.some((l) => l.includes('diff-hash-merge') && l.includes('fail-safe')), '(c) diffhash 取得失敗 → Diff triage 結果の再利用 skip の警告 log が無い');
  assert.ok(logs.some((l) => l.includes('merge-tier-facts') && l.includes('fail-closed')), '(c) risk fail-closed の警告 log が無い');
  assert.ok(calls.some((c) => c.label === 'journal-log'), '(c) journal-log まで到達しているはず（handoff 到達）');
});

// ============================================================
// (c2) merge-tier-facts の diffhash サブ結果だけ失敗 → reuse skip し facts の risk で再判定（他サブ結果は無傷）
// ============================================================

test('[diffhash-failopen] (c2) merge-tier-facts の diffhash だけ ok:false → reuse skip・risk は facts の値で clean・run 完走', async () => {
  const { ctx, calls, logs } = makeSandbox({
    overrides: {
      'merge-tier-facts': mergeTierFacts({ hash: null, files: ['src/x.ts'] }),
    },
  });
  const err = await runDevFlowInSandbox(devFlowSrc, ctx);
  assertNoCrash(err, 'c2');
  assert.equal(err, null, `(c2) run は完走するはずだが error: ${err?.name}: ${err?.message}`);
  assert.ok(logs.some((l) => l.includes('diff-hash-merge の取得に失敗')), '(c2) diffhash 取得失敗の fail-safe 警告 log が無い');
  assert.ok(!logs.some((l) => l.includes('risk fail-closed')), '(c2) diffhash 失敗は risk に波及してはならない');
  assert.ok(calls.some((c) => c.label === 'journal-log'), '(c2) journal-log まで到達しているはず');
});

// ============================================================
// (d) diff-hash 3 箇所が契約違反リトライ opt-in（opts.retryOnContractViolation: true）で dispatch される
//     ことを VM の agent() 呼び出し opts で観測する（issue #636: ソース regex pin から置換）
// ============================================================

test('[diffhash-failopen] (d) diff-hash-eval / diff-hash-pr / merge-tier-facts の 3 dispatch すべてが retryOnContractViolation: true を持つ', async () => {
  const { ctx, calls } = makeSandbox();
  const err = await runDevFlowInSandbox(devFlowSrc, ctx);
  assertNoCrash(err, 'd');
  for (const label of ['diff-hash-eval', 'diff-hash-pr', 'merge-tier-facts']) {
    const dispatches = calls.filter((c) => c.label === label);
    assert.equal(dispatches.length, 1, `(d) ${label} は 1 回 dispatch されるはずだが ${dispatches.length} 回`);
    assert.equal(dispatches[0].opts?.retryOnContractViolation, true, `(d) ${label} の opts.retryOnContractViolation が true でない: ${JSON.stringify(dispatches[0].opts)}`);
    assert.equal(dispatches[0].agentType, 'dev-flow:dev-runner-haiku-ro', `(d) ${label} の agentType: ${dispatches[0].agentType}`);
  }
});

// ============================================================
// (e) 対照: override なし（全 diff-hash が hash を返す）→ 正常完走・stale-eval skip ログ無し
// ============================================================

test('[diffhash-failopen] (e) 対照: diff-hash 全て正常応答 → run 完走・stale-eval skip 警告なし', async () => {
  const { ctx, calls, logs } = makeSandbox();
  const err = await runDevFlowInSandbox(devFlowSrc, ctx);
  assertNoCrash(err, 'e');
  assert.equal(err, null, `(e) run は完走するはずだが error: ${err?.name}: ${err?.message}`);

  assert.ok(!logs.some((l) => l.includes('stale-eval 検出は skip')), '(e) 正常応答時は stale-eval skip 警告が出ないはず');
  assert.ok(calls.some((c) => c.label === 'journal-log'), '(e) journal-log まで到達しているはず（handoff 到達）');
});
