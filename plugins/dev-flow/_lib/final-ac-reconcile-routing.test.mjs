// final-ac-reconcile-routing: VM sandbox routing test for dev-flow の targeted Final AC
// reconcile phase（issue #331 G2）。pr-iterate が fix を適用した run（fixes_applied>0）かつ
// Final reconcile の final test が green/no_tests のときのみ、Analyze で freeze した既存
// acceptance_criteria を最終 PR tree に対し one-shot で再検証する targeted evaluator を起動し、
// classifyMergeTier / summary / telemetry / return が最終 AC snapshot（state.finalAcResults /
// state.finalUnsatisfiedAc）を参照することを pin する。
//
// ハーネスは _lib/final-reconcile-routing.test.mjs の構造（makeRecordingSandbox +
// createResponder + ローカル runDevFlowCapture + assertNoCrash + STANDARD_REQ + makeSandbox）
// を丸ごと踏襲する。
//
// テストケース:
//   (r1) fixes=0 → 'final-ac-reconcile' 不発 + final_ac_reconcile==='skipped' + merge_tier==='REVIEW'
//   (r2) fixes=1 + test#final green → 'final-ac-reconcile' が 1 回だけ呼ばれ reverified + REVIEW
//   (r3) fixes=1 + ac_results:null → unavailable + HOLD + reasons に 'Final AC reconcile 判定不能'
//   (r4) fixes=1 + ac_results で ac_index 重複 → unavailable + HOLD
//   (r5) fixes=1 + ac_index:1 が satisfied:false → reverified + HOLD + reasons に 'AC 未達'
//        + result.final_unsatisfied_ac===true + critical AC-FINAL-2 append が reasons の
//        'ledger 未収束' に反映
//   (r6) fixes=1 + test#final red → 'final-ac-reconcile' 不発 + skipped + HOLD（'final test red'）

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { makeRecordingSandbox, devFlowArgs, mergeTierFacts, prerunAnalyze } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');
const devFlowSrc = readFileSync(devFlowPath, 'utf8');

// ============================================================
// runDevFlowCapture: strip + wrap + vm 実行し {result, error} を返す
// （_lib/final-reconcile-routing.test.mjs と同型のローカル copy）
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
  issue_number: 331,
  issue_title: 'stub-issue-title',
};

// ============================================================
// responder factory: _lib/final-reconcile-routing.test.mjs の createResponder パターンを踏襲。
// 'final-ac-reconcile' 専用 default を agentType==='evaluator' fallback より前に置く。
// ============================================================
function createResponder(overrides = {}) {
  return function ({ label, agentType, prompt }) {
    if (Object.prototype.hasOwnProperty.call(overrides, label)) {
      const v = overrides[label];
      if (typeof v === 'function') return v({ prompt, agentType, label });
      return v;
    }
    if (label === 'setup-base') return { ok: true, default_branch: 'main', dev_exists: true, requested_exists: false, worktree_exists: false, upstream_remote: '', upstream_merge: '' };
    if (label === 'worktree') return { worktree: '/tmp/wt', branch: 'feature/issue-331' };
    // Diff triage の敵対的 security review の対象判定（issue #1063）: この test の関心外なので対象外を返す
    if (label === 'security-scope') return { ok: true, target: false, reasons: [] };
    if (label.startsWith('danger-grep')) return { ok: true, hits: [] };
    if (label === 'realized-diff') return { files: ['src/x.ts'] };
    if (label === 'final-ac-reconcile') {
      return {
        ac_results: [
          { ac_index: 0, satisfied: true, evidence: 'e0', verified_by: 'inspection' },
          { ac_index: 1, satisfied: true, evidence: 'e1', verified_by: 'inspection' },
        ],
      };
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
    if (label === 'merge-tier-facts') return mergeTierFacts({ files: ['src/x.ts'] });
    if (label === 'changed-files-final') return { files: [] };
    if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) return { hash: 'H', empty: false };
    if (label === 'post-summary') return { posted: true, method: 'gh pr comment', url: 'http://x' };
    // journal-save (stage1, issue #494): 実際の telemetry payload はここに載る
    if (label === 'journal-save') return { saved: true, path: '/tmp/wt/.devflow-tmp/payload-test.json' };
    if (label === 'journal-log') return { logged: true, summary: 'ok' };
    if (agentType === 'dev-flow:dev-implementer') return { status: 'DONE', task_id: 't', files: ['src/x.ts'], summary: 's', concerns: [] };
    if (label === 'reconcile-sync') return { ok: true, head: 'deadbeef' };
    if (label.startsWith('test')) return { tests: 'passed', green: true, summary: '' };
    return null;
  };
}

function makeSandbox({ overrides = {}, fixesApplied = 0, analyze = {} } = {}) {
  return makeRecordingSandbox(createResponder(overrides), {
    workflow: async () => ({ status: 'lgtm', iterations: 2, fixes_applied: fixesApplied }),
    // REQ は args.setup.analyze から組まれる（Analyze phase は spawn しない）。STANDARD_REQ と同じ AC / type
    args: devFlowArgs('331', { analyze: prerunAnalyze({ acceptance_criteria: STANDARD_REQ.acceptance_criteria, issue_type: STANDARD_REQ.issue_type, ...analyze }) }),
  });
}

// ============================================================
// (r1) fixes_applied=0 → 'final-ac-reconcile' 不発 + skipped + merge_tier REVIEW
// ============================================================

test('[final-ac-reconcile] (r1) fixes_applied=0 → final-ac-reconcile 不発 + final_ac_reconcile===skipped + merge_tier REVIEW', async () => {
  const { ctx, calls } = makeSandbox({ fixesApplied: 0 });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'r1');
  assert.ok(result !== null, '(r1) workflow は return object を返すべきだが null だった');

  assert.ok(!calls.some((c) => c.label === 'final-ac-reconcile'), "(r1) fixes_applied=0 では 'final-ac-reconcile' の呼び出しが存在してはならない");
  assert.equal(result?.final_ac_reconcile, 'skipped', `(r1) final_ac_reconcile は 'skipped' のはずだが ${JSON.stringify(result?.final_ac_reconcile)}`);
  assert.equal(result?.merge_tier, 'REVIEW', `(r1) merge_tier は REVIEW のはずだが ${JSON.stringify(result?.merge_tier)}`);
});

// ============================================================
// (r2) fixes=1 + test#final green → final-ac-reconcile が1回だけ + reverified + REVIEW
// ============================================================

test('[final-ac-reconcile] (r2) fixes=1 + test#final green → final-ac-reconcile 1回 + reverified + merge_tier REVIEW', async () => {
  const { ctx, calls } = makeSandbox({
    fixesApplied: 1,
    overrides: { 'test#final': { tests: 'passed', green: true, summary: '' } },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'r2');
  assert.ok(result !== null, '(r2) workflow は return object を返すべきだが null だった');

  const facCalls = calls.filter((c) => c.label === 'final-ac-reconcile');
  assert.equal(facCalls.length, 1, `(r2) 'final-ac-reconcile' はちょうど1回呼ばれるはずだが ${facCalls.length} 回だった`);
  assert.equal(result?.final_ac_reconcile, 'reverified', `(r2) final_ac_reconcile は 'reverified' のはずだが ${JSON.stringify(result?.final_ac_reconcile)}`);
  assert.equal(result?.merge_tier, 'REVIEW', `(r2) merge_tier は REVIEW のはずだが ${JSON.stringify(result?.merge_tier)}`);
});

// ============================================================
// (r3) fixes=1 + final-ac-reconcile が null → unavailable + HOLD + 'Final AC reconcile 判定不能'
// ============================================================

test("[final-ac-reconcile] (r3) fixes=1 + final-ac-reconcile null → unavailable + HOLD + 'Final AC reconcile 判定不能'", async () => {
  const { ctx } = makeSandbox({
    fixesApplied: 1,
    overrides: { 'final-ac-reconcile': null },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'r3');
  assert.ok(result !== null, '(r3) workflow は return object を返すべきだが null だった');

  assert.equal(result?.final_ac_reconcile, 'unavailable', `(r3) final_ac_reconcile は 'unavailable' のはずだが ${JSON.stringify(result?.final_ac_reconcile)}`);
  assert.equal(result?.merge_tier, 'HOLD', `(r3) merge_tier は HOLD のはずだが ${JSON.stringify(result?.merge_tier)}`);
  assert.ok(
    (result?.merge_tier_reasons ?? []).some((r) => r.includes('Final AC reconcile 判定不能')),
    `(r3) merge_tier_reasons に 'Final AC reconcile 判定不能' が含まれるはずだが ${JSON.stringify(result?.merge_tier_reasons)}`,
  );
});

// ============================================================
// (r4) fixes=1 + ac_index 重複 → unavailable + HOLD
// ============================================================

test('[final-ac-reconcile] (r4) fixes=1 + ac_index 重複 → unavailable + HOLD', async () => {
  const { ctx } = makeSandbox({
    fixesApplied: 1,
    overrides: {
      'final-ac-reconcile': {
        ac_results: [
          { ac_index: 0, satisfied: true, evidence: 'x' },
          { ac_index: 0, satisfied: true, evidence: 'y' },
        ],
      },
    },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'r4');
  assert.ok(result !== null, '(r4) workflow は return object を返すべきだが null だった');

  assert.equal(result?.final_ac_reconcile, 'unavailable', `(r4) final_ac_reconcile は 'unavailable' のはずだが ${JSON.stringify(result?.final_ac_reconcile)}`);
  assert.equal(result?.merge_tier, 'HOLD', `(r4) merge_tier は HOLD のはずだが ${JSON.stringify(result?.merge_tier)}`);
});

// ============================================================
// (r5) fixes=1 + ac_index:1 satisfied:false → reverified + HOLD + 'AC 未達'
//      + post-summary prompt に 'AC-FINAL-2' + result.final_unsatisfied_ac===true
// ============================================================

test("[final-ac-reconcile] (r5) fixes=1 + AC-2 不成立 → reverified + HOLD + 'AC 未達' + AC-FINAL-2 append + final_unsatisfied_ac", async () => {
  const { ctx, calls } = makeSandbox({
    fixesApplied: 1,
    overrides: {
      'final-ac-reconcile': {
        ac_results: [
          { ac_index: 0, satisfied: true, evidence: 'ok0' },
          { ac_index: 1, satisfied: false, evidence: 'fail1' },
        ],
      },
    },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'r5');
  assert.ok(result !== null, '(r5) workflow は return object を返すべきだが null だった');

  assert.equal(result?.final_ac_reconcile, 'reverified', `(r5) final_ac_reconcile は 'reverified' のはずだが ${JSON.stringify(result?.final_ac_reconcile)}`);
  assert.equal(result?.merge_tier, 'HOLD', `(r5) merge_tier は HOLD のはずだが ${JSON.stringify(result?.merge_tier)}`);
  assert.ok(
    (result?.merge_tier_reasons ?? []).some((r) => r.includes('AC 未達')),
    `(r5) merge_tier_reasons に 'AC 未達' が含まれるはずだが ${JSON.stringify(result?.merge_tier_reasons)}`,
  );
  assert.equal(result?.final_unsatisfied_ac, true, `(r5) final_unsatisfied_ac は true のはずだが ${JSON.stringify(result?.final_unsatisfied_ac)}`);

  // critical append の実証: AC-FINAL-2 ledger item（critical, unchecked）が classifyMergeTier の
  // convergence 判定に反映され 'ledger 未収束（未 checked blocking 残）' reason として返り値に現れる
  assert.ok(
    (result?.merge_tier_reasons ?? []).some((r) => r.includes('ledger 未収束')),
    `(r5) merge_tier_reasons に 'ledger 未収束' を含む要素（critical AC-FINAL append の証拠）が含まれるはずだが ${JSON.stringify(result?.merge_tier_reasons)}`,
  );
});

// ============================================================
// (r6) fixes=1 + test#final red → final-ac-reconcile 不発 + skipped + HOLD('final test red')
//      + post-summary prompt に 'AC 判定は stale'
// ============================================================

test("[final-ac-reconcile] (r6) fixes=1 + test#final red → final-ac-reconcile 不発 + skipped + HOLD + post-summary に 'AC 判定は stale'", async () => {
  const { ctx, calls } = makeSandbox({
    fixesApplied: 1,
    overrides: { 'test#final': { tests: 'failed', green: false, summary: 'boom' } },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'r6');
  assert.ok(result !== null, '(r6) workflow は return object を返すべきだが null だった');

  assert.ok(!calls.some((c) => c.label === 'final-ac-reconcile'), "(r6) final test red のとき 'final-ac-reconcile' が呼ばれてはならない");
  assert.equal(result?.final_ac_reconcile, 'skipped', `(r6) final_ac_reconcile は 'skipped' のはずだが ${JSON.stringify(result?.final_ac_reconcile)}`);
  assert.equal(result?.merge_tier, 'HOLD', `(r6) merge_tier は HOLD のはずだが ${JSON.stringify(result?.merge_tier)}`);
  assert.ok(
    (result?.merge_tier_reasons ?? []).some((r) => r.includes('final test red')),
    `(r6) merge_tier_reasons に 'final test red' が含まれるはずだが ${JSON.stringify(result?.merge_tier_reasons)}`,
  );

  // AC 判定が stale であることの証拠: final test red により final-ac-reconcile 自体が不発
  // （返り値 final_ac_reconcile:'skipped'）+ 返り値 merge_tier===HOLD（上で確認済み）
});
