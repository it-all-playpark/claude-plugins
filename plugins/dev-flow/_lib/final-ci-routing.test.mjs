// final-ci-routing: VM sandbox routing test for dev-flow の Final reconcile CI 委譲（issue #599）。
// `finalReconcile === 'unavailable'`（reconcile-sync 成功 + test#final null/red 等でローカル再検証不能）
// のとき、PR head sha に pin した CI check を `ci-final`（dev-runner-haiku-ro）で 1 回読み、
// finalCiVerdict（決定論・純関数）が sha 一致 + 全 success を返した場合のみ final_reconcile を
// 'ci_verified' へ昇格し merge tier HOLD を解除することを pin する。
//
// ハーネスは _lib/final-reconcile-routing.test.mjs と同型（makeRecordingSandbox + ローカル
// runDevFlowCapture + createResponder(overrides) の default 応答を複製）。
//
// テストケース:
//   (a) sha 一致 + 全 success → ci_verified + merge_tier REVIEW + hold_reasons=[] + hold_kind=null
//   (b) headRefOid が期待 sha と不一致 → unavailable + HOLD + reason=sha-mismatch + kind=human_judgment
//   (c) 1 件 pending（IN_PROGRESS） → HOLD + reason=pending + kind=deterministic_recheck
//   (d) 1 件 failure（FAILURE） → HOLD + reason=failure + kind=human_judgment
//   (e) ci-final 取得失敗（ok:false） → HOLD + reason=fetch-failed + kind=deterministic_recheck
//   (e2) ci-final throw → run 完走 + HOLD + reason=fetch-failed
//   (f) statusCheckRollup が空配列 → HOLD + reason=no-checks + kind=human_judgment
//   (g) reconcile-sync 失敗（期待 sha 無し） → ci-final 不発 + HOLD + reason=no-expected-sha
//   (h) test#final green（reverified 経路） → ci-final 不発 + final_reconcile=reverified
//   (i) fixesApplied=0 → ci-final 不発 + final_reconcile=skipped
//   (j) (a) の条件 + evaluator あり → final-ac-reconcile が起動する（ci_verified を reverified 同等に扱う）
//       / (g) では final-ac-reconcile は起動しない
//   (l) dev-flow.js の ci-final 呼び出し周辺に禁止語が含まれない
//   （(k) FINAL_CI_KIND_* と HOLD_REASON_KINDS の同値性・finalCiPrompt 出力の禁止語は final-ci.test.mjs）
//   (m) note の文言が hold_kind に応じて変わる
//   (n) test#final tests:'error'（起動失敗）+ sha 一致 + 全 success → ci_verified + REVIEW + final_test_green null
//       + reasons に 'final test red' 不含 + final-ac-reconcile 起動（issue #619）
//   (o) tests:'error' + 1 件 pending → unavailable + HOLD + reason=pending（fail-closed 維持）
//   (p) tests:'error' + 1 件 failure → unavailable + HOLD + reason=failure
//   (q) tests:'error' + sha 不一致 → unavailable + HOLD + reason=sha-mismatch
//   (r) tests:'failed'（本物の red）+ sha 一致 + 全 success → reverified + HOLD + 'final test red' + ci-final 不発
//       （CI 委譲の発火条件を reverified+red へ広げない）

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { makeRecordingSandbox, devFlowArgs, mergeTierFacts } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');
const devFlowSrc = readFileSync(devFlowPath, 'utf8');

// ============================================================
// runDevFlowCapture: final-reconcile-routing.test.mjs と同型のローカル copy
// ============================================================
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

function assertNoCrash(error, name) {
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`[${name}] dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }
}

// standard に落ちる req（count=3 ≤ 5, ac.length=2 ≤ 6, type=fix → floor='standard'）
const STANDARD_REQ = {
  summary: 's',
  acceptance_criteria: ['a', 'b'],
  issue_type: 'fix',
  scope: 'src',
  issue_number: 320,
  issue_title: 'stub-issue-title',
};

const SHA40 = 'a'.repeat(40);
const SHA40_B = 'b'.repeat(40);

const ROLLUP_OK = [
  { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
  { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' },
  { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
];

// ============================================================
// responder factory: final-reconcile-routing.test.mjs の createResponder と同一の default 応答を複製。
// 差分: 'reconcile-sync' は 40hex head を返す（sync 成功前提を作る）。
// ============================================================
function createResponder(overrides = {}) {
  return function ({ label, agentType, prompt }) {
    if (Object.prototype.hasOwnProperty.call(overrides, label)) {
      const v = overrides[label];
      if (typeof v === 'function') return v({ prompt, agentType, label });
      return v;
    }
    if (label === 'setup-base') return { ok: true, default_branch: 'main', dev_exists: true, requested_exists: false, worktree_exists: false, upstream_remote: '', upstream_merge: '' };
    if (label === 'worktree') return { worktree: '/tmp/wt', branch: 'feature/issue-320' };
    if (label.startsWith('analyze')) return STANDARD_REQ;
    // Security floor の敵対的 security review の対象判定（issue #1063）: この test の関心外なので対象外を返す
    if (label === 'security-scope') return { ok: true, target: false, reasons: [] };
    if (label.startsWith('danger-grep')) return { ok: true, hits: [] };
    if (label === 'realized-diff') return { files: ['src/x.ts'] };
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
    if (label === 'merge-tier-facts') return mergeTierFacts({ hash: 'H_MERGE', files: ['src/x.ts'] });
    if (label === 'changed-files-final') return { files: [] };
    if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) return { hash: 'H', empty: false };
    if (label === 'post-summary') return { posted: true, method: 'gh pr comment', url: 'http://x' };
    if (label === 'journal-save') return { saved: true, path: '/tmp/wt/.devflow-tmp/payload-test.json' };
    if (label === 'journal-log') return { logged: true, summary: 'ok' };
    if (agentType === 'dev-flow:dev-implementer') return { status: 'DONE', task_id: 't', files: ['src/x.ts'], summary: 's', concerns: [] };
    if (label === 'reconcile-sync') return { ok: true, head: SHA40 };
    if (label.startsWith('test')) return { tests: 'passed', green: true, summary: '' };
    if (label === 'issue-meta') return { ok: true, number: 320, title: 'stub-issue-title' };
    return null;
  };
}

function makeSandbox({ overrides = {}, fixesApplied = 0 } = {}) {
  return makeRecordingSandbox(createResponder(overrides), {
    workflow: async () => ({ status: 'lgtm', iterations: 2, fixes_applied: fixesApplied }),
    args: devFlowArgs('320'),
  });
}

// unavailable を作るための共通 override: test#final が null（Final reconcile がローカル再検証不能）。
const UNAVAILABLE_BASE = { 'test#final': null };

// tests:'error' = テストが 1 件も実行されなかった起動失敗（issue #619）。unavailable 経路に乗る。
const ERROR_BASE = { 'test#final': { tests: 'error', green: false, summary: 'pnpm: command not found — テストは 1 件も実行されていない' } };

// ============================================================
// (a) sha 一致 + 全 success → ci_verified + merge_tier REVIEW
// ============================================================

test('[final-ci] (a) sha 一致 + 全 success → final_reconcile=ci_verified + merge_tier REVIEW + hold_reasons=[] + hold_kind=null', async () => {
  const { ctx, calls } = makeSandbox({
    fixesApplied: 1,
    overrides: {
      ...UNAVAILABLE_BASE,
      'ci-final': { ok: true, headRefOid: SHA40, statusCheckRollup: ROLLUP_OK },
    },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'a');
  assert.equal(error, null, `(a) error は null のはずだが ${error?.message}`);
  assert.ok(result !== null, '(a) workflow は return object を返すべきだが null だった');

  assert.equal(result?.final_reconcile, 'ci_verified', `(a) final_reconcile は 'ci_verified' のはずだが ${JSON.stringify(result?.final_reconcile)}`);
  assert.equal(result?.merge_tier, 'REVIEW', `(a) merge_tier は REVIEW のはずだが ${JSON.stringify(result?.merge_tier)}`);
  // ci_verified 昇格時は disclosure 文言に「ローカル再検証不能」を含むが（CI 委譲で代替した事実の開示）、
  // HOLD 判定に使う「CI 委譲も不成立」フレーズは含まないはず（HOLD reason ではなく REVIEW の開示行）。
  assert.ok(
    !(result?.merge_tier_reasons ?? []).some((r) => r.includes('CI 委譲も不成立')),
    `(a) merge_tier_reasons に 'CI 委譲も不成立' を含む要素は無いはずだが ${JSON.stringify(result?.merge_tier_reasons)}`,
  );
  // vm 実行結果の配列は別 realm の Array のため assert.deepEqual は cross-realm 判定で
  // reference-equal でないと fail する（"same structure but not reference-equal"）。
  // 構造比較は Array.isArray + length + JSON.stringify で行う。
  assert.ok(Array.isArray(result?.merge_tier_hold_reasons), `(a) merge_tier_hold_reasons は配列のはずだが ${JSON.stringify(result?.merge_tier_hold_reasons)}`);
  assert.equal(result?.merge_tier_hold_reasons.length, 0, `(a) merge_tier_hold_reasons は空配列のはずだが ${JSON.stringify(result?.merge_tier_hold_reasons)}`);
  assert.equal(result?.merge_tier_hold_kind, null, `(a) merge_tier_hold_kind は null のはずだが ${JSON.stringify(result?.merge_tier_hold_kind)}`);
  assert.equal(result?.final_test_green, null, `(a) final_test_green は null のはずだが ${JSON.stringify(result?.final_test_green)}`);

  const ciFinalCalls = calls.filter((c) => c.label === 'ci-final');
  assert.equal(ciFinalCalls.length, 1, `(a) 'ci-final' は 1 回呼ばれるはずだが ${ciFinalCalls.length} 回だった`);
  assert.equal(ciFinalCalls[0].agentType, 'dev-flow:dev-runner-haiku-ro', `(a) 'ci-final' の agentType は 'dev-flow:dev-runner-haiku-ro' のはずだが '${ciFinalCalls[0].agentType}'`);
  assert.ok(ciFinalCalls[0].prompt.includes('gh pr view 1 --json headRefOid,statusCheckRollup'), "(a) 'ci-final' の prompt に `gh pr view 1 --json headRefOid,statusCheckRollup` が含まれるはず");

  const idxSync = calls.findIndex((c) => c.label === 'reconcile-sync');
  const idxCiFinal = calls.findIndex((c) => c.label === 'ci-final');
  assert.ok(idxSync >= 0 && idxCiFinal >= 0 && idxCiFinal > idxSync, "(a) 'ci-final' は 'reconcile-sync' より後に呼ばれるはず");
});

// ============================================================
// (b) headRefOid 不一致 → unavailable + HOLD + sha-mismatch + human_judgment
// ============================================================

test('[final-ci] (b) headRefOid が期待 sha と不一致 → unavailable + HOLD + reason=sha-mismatch + hold_kind=human_judgment', async () => {
  const { ctx } = makeSandbox({
    fixesApplied: 1,
    overrides: {
      ...UNAVAILABLE_BASE,
      'ci-final': { ok: true, headRefOid: SHA40_B, statusCheckRollup: ROLLUP_OK },
    },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'b');
  assert.equal(result?.final_reconcile, 'unavailable', `(b) final_reconcile は 'unavailable' のはずだが ${JSON.stringify(result?.final_reconcile)}`);
  assert.equal(result?.merge_tier, 'HOLD', `(b) merge_tier は HOLD のはずだが ${JSON.stringify(result?.merge_tier)}`);
  assert.ok(
    (result?.merge_tier_reasons ?? []).some((r) => r.includes('reason=sha-mismatch')),
    `(b) merge_tier_reasons に 'reason=sha-mismatch' が含まれるはずだが ${JSON.stringify(result?.merge_tier_reasons)}`,
  );
  assert.equal(result?.merge_tier_hold_kind, 'human_judgment', `(b) merge_tier_hold_kind は 'human_judgment' のはずだが ${JSON.stringify(result?.merge_tier_hold_kind)}`);
});

// ============================================================
// (c) pending → HOLD + deterministic_recheck
// ============================================================

test('[final-ci] (c) 1 件 pending(IN_PROGRESS) → HOLD + reason=pending + hold_kind=deterministic_recheck + hold_reasons 1件', async () => {
  const { ctx } = makeSandbox({
    fixesApplied: 1,
    overrides: {
      ...UNAVAILABLE_BASE,
      'ci-final': {
        ok: true, headRefOid: SHA40,
        statusCheckRollup: [{ __typename: 'CheckRun', name: 'build', status: 'IN_PROGRESS' }],
      },
    },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'c');
  assert.equal(result?.merge_tier, 'HOLD', `(c) merge_tier は HOLD のはずだが ${JSON.stringify(result?.merge_tier)}`);
  assert.ok(
    (result?.merge_tier_reasons ?? []).some((r) => r.includes('reason=pending')),
    `(c) merge_tier_reasons に 'reason=pending' が含まれるはずだが ${JSON.stringify(result?.merge_tier_reasons)}`,
  );
  assert.equal(result?.merge_tier_hold_kind, 'deterministic_recheck', `(c) merge_tier_hold_kind は 'deterministic_recheck' のはずだが ${JSON.stringify(result?.merge_tier_hold_kind)}`);
  assert.equal(result?.merge_tier_hold_reasons?.length, 1, `(c) merge_tier_hold_reasons は 1 件のはずだが ${JSON.stringify(result?.merge_tier_hold_reasons)}`);
  assert.equal(result?.merge_tier_hold_reasons?.[0]?.kind, 'deterministic_recheck', `(c) merge_tier_hold_reasons[0].kind は 'deterministic_recheck' のはずだが ${JSON.stringify(result?.merge_tier_hold_reasons)}`);
});

// ============================================================
// (d) failure → HOLD + human_judgment
// ============================================================

test('[final-ci] (d) 1 件 conclusion=FAILURE → HOLD + reason=failure + hold_kind=human_judgment', async () => {
  const { ctx } = makeSandbox({
    fixesApplied: 1,
    overrides: {
      ...UNAVAILABLE_BASE,
      'ci-final': {
        ok: true, headRefOid: SHA40,
        statusCheckRollup: [{ __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'FAILURE' }],
      },
    },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'd');
  assert.equal(result?.merge_tier, 'HOLD', `(d) merge_tier は HOLD のはずだが ${JSON.stringify(result?.merge_tier)}`);
  assert.ok(
    (result?.merge_tier_reasons ?? []).some((r) => r.includes('reason=failure')),
    `(d) merge_tier_reasons に 'reason=failure' が含まれるはずだが ${JSON.stringify(result?.merge_tier_reasons)}`,
  );
  assert.equal(result?.merge_tier_hold_kind, 'human_judgment', `(d) merge_tier_hold_kind は 'human_judgment' のはずだが ${JSON.stringify(result?.merge_tier_hold_kind)}`);
});

// ============================================================
// (e) 取得失敗（ok:false） → HOLD + fetch-failed + deterministic_recheck
// ============================================================

test("[final-ci] (e) ci-final 取得失敗(ok:false) → HOLD + reason=fetch-failed + hold_kind=deterministic_recheck", async () => {
  const { ctx } = makeSandbox({
    fixesApplied: 1,
    overrides: {
      ...UNAVAILABLE_BASE,
      'ci-final': { ok: false, error: 'x' },
    },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'e');
  assert.equal(result?.merge_tier, 'HOLD', `(e) merge_tier は HOLD のはずだが ${JSON.stringify(result?.merge_tier)}`);
  assert.ok(
    (result?.merge_tier_reasons ?? []).some((r) => r.includes('reason=fetch-failed')),
    `(e) merge_tier_reasons に 'reason=fetch-failed' が含まれるはずだが ${JSON.stringify(result?.merge_tier_reasons)}`,
  );
  assert.equal(result?.merge_tier_hold_kind, 'deterministic_recheck', `(e) merge_tier_hold_kind は 'deterministic_recheck' のはずだが ${JSON.stringify(result?.merge_tier_hold_kind)}`);
});

// ============================================================
// (e2) ci-final throw → run 完走 + HOLD + fetch-failed
// ============================================================

test("[final-ci] (e2) ci-final throw(EPERM) → run 完走 + HOLD + reason=fetch-failed", async () => {
  const { ctx } = makeSandbox({
    fixesApplied: 1,
    overrides: {
      ...UNAVAILABLE_BASE,
      'ci-final': () => { throw new Error('EPERM: operation not permitted'); },
    },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assert.equal(error, null, `(e2) ci-final の throw で run 全体が abort してはならないが error が発生: ${error?.message}`);
  assert.ok(result !== null, '(e2) workflow は return object を返すべきだが null だった（run 全体が死んだことを示す）');
  assert.equal(result?.merge_tier, 'HOLD', `(e2) merge_tier は HOLD のはずだが ${JSON.stringify(result?.merge_tier)}`);
  assert.ok(
    (result?.merge_tier_reasons ?? []).some((r) => r.includes('reason=fetch-failed')),
    `(e2) merge_tier_reasons に 'reason=fetch-failed' が含まれるはずだが ${JSON.stringify(result?.merge_tier_reasons)}`,
  );
});

// ============================================================
// (f) statusCheckRollup 空配列 → HOLD + no-checks + human_judgment
// ============================================================

test('[final-ci] (f) statusCheckRollup=[] → HOLD + reason=no-checks + hold_kind=human_judgment', async () => {
  const { ctx } = makeSandbox({
    fixesApplied: 1,
    overrides: {
      ...UNAVAILABLE_BASE,
      'ci-final': { ok: true, headRefOid: SHA40, statusCheckRollup: [] },
    },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'f');
  assert.equal(result?.merge_tier, 'HOLD', `(f) merge_tier は HOLD のはずだが ${JSON.stringify(result?.merge_tier)}`);
  assert.ok(
    (result?.merge_tier_reasons ?? []).some((r) => r.includes('reason=no-checks')),
    `(f) merge_tier_reasons に 'reason=no-checks' が含まれるはずだが ${JSON.stringify(result?.merge_tier_reasons)}`,
  );
  assert.equal(result?.merge_tier_hold_kind, 'human_judgment', `(f) merge_tier_hold_kind は 'human_judgment' のはずだが ${JSON.stringify(result?.merge_tier_hold_kind)}`);
});

// ============================================================
// (g) reconcile-sync 失敗（期待 sha 無し） → ci-final 不発 + HOLD + no-expected-sha
// ============================================================

test("[final-ci] (g) reconcile-sync 失敗(non-ff) → 'ci-final' 不発 + HOLD + reason=no-expected-sha", async () => {
  const { ctx, calls } = makeSandbox({
    fixesApplied: 1,
    overrides: {
      ...UNAVAILABLE_BASE,
      'reconcile-sync': { ok: false, error: 'non-ff' },
    },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'g');
  assert.ok(!calls.some((c) => c.label === 'ci-final'), "(g) reconcile-sync 失敗時は 'ci-final' が呼ばれないはず");
  assert.equal(result?.merge_tier, 'HOLD', `(g) merge_tier は HOLD のはずだが ${JSON.stringify(result?.merge_tier)}`);
  assert.ok(
    (result?.merge_tier_reasons ?? []).some((r) => r.includes('reason=no-expected-sha')),
    `(g) merge_tier_reasons に 'reason=no-expected-sha' が含まれるはずだが ${JSON.stringify(result?.merge_tier_reasons)}`,
  );
});

// ============================================================
// (h) test#final green（reverified 経路） → ci-final 不発
// ============================================================

test("[final-ci] (h) test#final green（reverified） → 'ci-final' 不発 + final_reconcile=reverified", async () => {
  const { ctx, calls } = makeSandbox({
    fixesApplied: 1,
    overrides: { 'test#final': { tests: 'passed', green: true, summary: '' } },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'h');
  assert.ok(!calls.some((c) => c.label === 'ci-final'), "(h) reverified 経路では 'ci-final' が呼ばれないはず");
  assert.equal(result?.final_reconcile, 'reverified', `(h) final_reconcile は 'reverified' のはずだが ${JSON.stringify(result?.final_reconcile)}`);
});

// ============================================================
// (i) fixesApplied=0 → ci-final 不発 + skipped
// ============================================================

test("[final-ci] (i) fixesApplied=0 → 'ci-final' 不発 + final_reconcile=skipped", async () => {
  const { ctx, calls } = makeSandbox({ fixesApplied: 0 });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'i');
  assert.ok(!calls.some((c) => c.label === 'ci-final'), "(i) fixesApplied=0 では 'ci-final' が呼ばれないはず");
  assert.equal(result?.final_reconcile, 'skipped', `(i) final_reconcile は 'skipped' のはずだが ${JSON.stringify(result?.final_reconcile)}`);
});

// ============================================================
// (j) ci_verified でも final-ac-reconcile が起動する（shouldRunFinalAcReconcile が ci_verified を受理）
//     / (g) の no-expected-sha（unavailable のまま）では起動しない
// ============================================================

test('[final-ci] (j) ci_verified の run では final-ac-reconcile が起動する（shouldRunFinalAcReconcile が ci_verified を受理）', async () => {
  const { ctx, calls } = makeSandbox({
    fixesApplied: 1,
    overrides: {
      ...UNAVAILABLE_BASE,
      'ci-final': { ok: true, headRefOid: SHA40, statusCheckRollup: ROLLUP_OK },
    },
  });
  const { error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'j');
  assert.ok(calls.some((c) => c.label === 'final-ac-reconcile'), "(j) ci_verified では 'final-ac-reconcile' が起動するはず");
});

test("[final-ci] (j2) unavailable のまま（no-expected-sha）では final-ac-reconcile は起動しない", async () => {
  const { ctx, calls } = makeSandbox({
    fixesApplied: 1,
    overrides: {
      ...UNAVAILABLE_BASE,
      'reconcile-sync': { ok: false, error: 'non-ff' },
    },
  });
  const { error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'j2');
  assert.ok(!calls.some((c) => c.label === 'final-ac-reconcile'), "(j2) unavailable のままでは 'final-ac-reconcile' が起動しないはず");
});

// (k) FINAL_CI_KIND_* と HOLD_REASON_KINDS の同値性は final-ci.test.mjs が持つ。

// ============================================================
// (l) 禁止語チェック: ci-final 呼び出し周辺コメントに迂回/実行制御語を含まない
// （finalCiPrompt 出力の禁止語は final-ci.test.mjs が上位集合の語彙で見る）
// ============================================================

const FORBIDDEN_RE = /sandbox|excludedCommands|permission|EPERM|迂回|代替手順/i;

test("[final-ci] (l) dev-flow.js の label:'ci-final' 呼び出し周辺（前後30行）に禁止語を含まない", () => {
  const stripped = devFlowSrc.replace(/\/\/.*$/gm, '');
  const lines = devFlowSrc.split('\n');
  const idx = lines.findIndex((l) => l.includes("label: 'ci-final'"));
  assert.ok(idx >= 0, "dev-flow.js に label: 'ci-final' の行が見つからない");
  const windowLines = lines.slice(Math.max(0, idx - 30), idx + 30).join('\n');
  assert.ok(!FORBIDDEN_RE.test(windowLines), `(l) ci-final 呼び出し周辺に禁止語を含んではならないが検出: ${windowLines.match(FORBIDDEN_RE)}`);
  void stripped;
});

// ============================================================
// (m) note の文言が hold_kind に応じて変わる
// ============================================================

test("[final-ci] (m) note は deterministic_recheck の HOLD で '決定論再チェック' を含む", async () => {
  const { ctx } = makeSandbox({
    fixesApplied: 1,
    overrides: {
      ...UNAVAILABLE_BASE,
      'ci-final': {
        ok: true, headRefOid: SHA40,
        statusCheckRollup: [{ __typename: 'CheckRun', name: 'build', status: 'IN_PROGRESS' }],
      },
    },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'm-c');
  assert.ok(result?.note?.includes('決定論再チェック'), `(m) note に '決定論再チェック' が含まれるはずだが ${JSON.stringify(result?.note)}`);
});

test("[final-ci] (m2) note は human_judgment の HOLD で '人間判断必須' を含む", async () => {
  const { ctx } = makeSandbox({
    fixesApplied: 1,
    overrides: {
      ...UNAVAILABLE_BASE,
      'ci-final': { ok: true, headRefOid: SHA40_B, statusCheckRollup: ROLLUP_OK },
    },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'm2-b');
  assert.ok(result?.note?.includes('人間判断必須'), `(m2) note に '人間判断必須' が含まれるはずだが ${JSON.stringify(result?.note)}`);
});

// ============================================================
// (n) test#final tests:'error'（起動失敗）+ sha 一致 + 全 success → ci_verified + REVIEW
//     + final_test_green null + 'final test red' 不含 + final-ac-reconcile 起動（issue #619）
// ============================================================

test("[final-ci] (n) test#final tests:'error' + sha 一致 + 全 success → ci_verified + REVIEW + final_test_green null + 'final test red' 不含 + final-ac-reconcile 起動", async () => {
  const { ctx, calls } = makeSandbox({
    fixesApplied: 1,
    overrides: { ...ERROR_BASE, 'ci-final': { ok: true, headRefOid: SHA40, statusCheckRollup: ROLLUP_OK } },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'n');
  assert.equal(error, null, `(n) error は null のはずだが ${error?.message}`);
  assert.ok(result !== null, '(n) workflow は return object を返すべきだが null だった');

  assert.equal(result?.final_reconcile, 'ci_verified', `(n) final_reconcile は 'ci_verified' のはずだが ${JSON.stringify(result?.final_reconcile)}`);
  assert.equal(result?.merge_tier, 'REVIEW', `(n) merge_tier は REVIEW のはずだが ${JSON.stringify(result?.merge_tier)}`);
  assert.equal(result?.final_test_green, null, `(n) final_test_green は null のはずだが ${JSON.stringify(result?.final_test_green)}`);
  assert.ok(
    !(result?.merge_tier_reasons ?? []).some((r) => r.includes('final test red')),
    `(n) merge_tier_reasons に 'final test red' を含んではならないが ${JSON.stringify(result?.merge_tier_reasons)}`,
  );
  assert.ok(Array.isArray(result?.merge_tier_hold_reasons) && result.merge_tier_hold_reasons.length === 0, `(n) merge_tier_hold_reasons は空配列のはずだが ${JSON.stringify(result?.merge_tier_hold_reasons)}`);
  assert.equal(result?.merge_tier_hold_kind, null, `(n) merge_tier_hold_kind は null のはずだが ${JSON.stringify(result?.merge_tier_hold_kind)}`);
  assert.equal(calls.filter((c) => c.label === 'ci-final').length, 1, "(n) 'ci-final' は 1 回呼ばれるはず");
  assert.ok(calls.some((c) => c.label === 'final-ac-reconcile'), "(n) ci_verified では 'final-ac-reconcile' が起動し AC が最終 tree で再検証されるはず");
});

// ============================================================
// (o)/(p)/(q) tests:'error' + CI が pending / failure / sha 不一致 → unavailable のまま HOLD（fail-closed 維持）
// ============================================================

test("[final-ci] (o) tests:'error' + 1 件 pending → unavailable + HOLD + reason=pending（fail-closed 維持）", async () => {
  const { ctx } = makeSandbox({
    fixesApplied: 1,
    overrides: {
      ...ERROR_BASE,
      'ci-final': {
        ok: true, headRefOid: SHA40,
        statusCheckRollup: [{ __typename: 'CheckRun', name: 'build', status: 'IN_PROGRESS' }],
      },
    },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'o');
  assert.ok(result !== null, '(o) workflow は return object を返すべきだが null だった');
  assert.equal(result?.final_reconcile, 'unavailable', `(o) final_reconcile は 'unavailable' のはずだが ${JSON.stringify(result?.final_reconcile)}`);
  assert.equal(result?.merge_tier, 'HOLD', `(o) merge_tier は HOLD のはずだが ${JSON.stringify(result?.merge_tier)}`);
  assert.ok(
    (result?.merge_tier_reasons ?? []).some((r) => r.includes('reason=pending')),
    `(o) merge_tier_reasons に 'reason=pending' が含まれるはずだが ${JSON.stringify(result?.merge_tier_reasons)}`,
  );
  assert.equal(result?.merge_tier_hold_kind, 'deterministic_recheck', `(o) merge_tier_hold_kind は 'deterministic_recheck' のはずだが ${JSON.stringify(result?.merge_tier_hold_kind)}`);
  assert.equal(result?.final_test_green, null, `(o) final_test_green は null のはずだが ${JSON.stringify(result?.final_test_green)}`);
});

test("[final-ci] (p) tests:'error' + 1 件 failure → unavailable + HOLD + reason=failure", async () => {
  const { ctx } = makeSandbox({
    fixesApplied: 1,
    overrides: {
      ...ERROR_BASE,
      'ci-final': {
        ok: true, headRefOid: SHA40,
        statusCheckRollup: [{ __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'FAILURE' }],
      },
    },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'p');
  assert.ok(result !== null, '(p) workflow は return object を返すべきだが null だった');
  assert.equal(result?.final_reconcile, 'unavailable', `(p) final_reconcile は 'unavailable' のはずだが ${JSON.stringify(result?.final_reconcile)}`);
  assert.equal(result?.merge_tier, 'HOLD', `(p) merge_tier は HOLD のはずだが ${JSON.stringify(result?.merge_tier)}`);
  assert.ok(
    (result?.merge_tier_reasons ?? []).some((r) => r.includes('reason=failure')),
    `(p) merge_tier_reasons に 'reason=failure' が含まれるはずだが ${JSON.stringify(result?.merge_tier_reasons)}`,
  );
  assert.equal(result?.merge_tier_hold_kind, 'human_judgment', `(p) merge_tier_hold_kind は 'human_judgment' のはずだが ${JSON.stringify(result?.merge_tier_hold_kind)}`);
});

test("[final-ci] (q) tests:'error' + sha 不一致 → unavailable + HOLD + reason=sha-mismatch", async () => {
  const { ctx } = makeSandbox({
    fixesApplied: 1,
    overrides: {
      ...ERROR_BASE,
      'ci-final': { ok: true, headRefOid: SHA40_B, statusCheckRollup: ROLLUP_OK },
    },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'q');
  assert.ok(result !== null, '(q) workflow は return object を返すべきだが null だった');
  assert.equal(result?.final_reconcile, 'unavailable', `(q) final_reconcile は 'unavailable' のはずだが ${JSON.stringify(result?.final_reconcile)}`);
  assert.equal(result?.merge_tier, 'HOLD', `(q) merge_tier は HOLD のはずだが ${JSON.stringify(result?.merge_tier)}`);
  assert.ok(
    (result?.merge_tier_reasons ?? []).some((r) => r.includes('reason=sha-mismatch')),
    `(q) merge_tier_reasons に 'reason=sha-mismatch' が含まれるはずだが ${JSON.stringify(result?.merge_tier_reasons)}`,
  );
  assert.equal(result?.merge_tier_hold_kind, 'human_judgment', `(q) merge_tier_hold_kind は 'human_judgment' のはずだが ${JSON.stringify(result?.merge_tier_hold_kind)}`);
});

// ============================================================
// (r) tests:'failed'（本物の red）+ CI 全 success → reverified + HOLD + 'final test red' + 'ci-final' 不発
//     （委譲条件を広げない回帰）
// ============================================================

test("[final-ci] (r) test#final tests:'failed'（本物の red）+ CI 全 success → reverified + HOLD + 'final test red' + 'ci-final' 不発（委譲条件を広げない）", async () => {
  const { ctx, calls } = makeSandbox({
    fixesApplied: 1,
    overrides: {
      'test#final': { tests: 'failed', green: false, summary: '3 tests failed' },
      'ci-final': { ok: true, headRefOid: SHA40, statusCheckRollup: ROLLUP_OK },
    },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'r');
  assert.ok(result !== null, '(r) workflow は return object を返すべきだが null だった');
  assert.equal(result?.final_reconcile, 'reverified', `(r) final_reconcile は 'reverified' のはずだが ${JSON.stringify(result?.final_reconcile)}`);
  assert.equal(result?.final_test_green, false, `(r) final_test_green は false のはずだが ${JSON.stringify(result?.final_test_green)}`);
  assert.equal(result?.merge_tier, 'HOLD', `(r) merge_tier は HOLD のはずだが ${JSON.stringify(result?.merge_tier)}`);
  assert.ok((result?.merge_tier_reasons ?? []).some((r) => r.includes('final test red')), `(r) merge_tier_reasons に 'final test red' が含まれるはずだが ${JSON.stringify(result?.merge_tier_reasons)}`);
  assert.ok(!calls.some((c) => c.label === 'ci-final'), "(r) reverified 経路では 'ci-final' が呼ばれないはず");
});
