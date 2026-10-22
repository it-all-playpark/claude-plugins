// final-item-resolutions-routing: VM sandbox routing test for dev-flow の Final AC reconcile
// item_resolutions 配線（issue #658）。evaluator（eval#1）が escalate feedback を返し、pr-iterate
// が fix を適用して LGTM 終端し、Final AC reconcile が fix 後の最終 PR tree で当該 ESCALATE item を
// resolved と再評価したとき、その結果が checked/merge tier を変えず（軸A 不変 — ESCALATE は HOLD の
// まま）、終端サマリーの「現状」欄にのみ反映されることを実証する。
//
// ハーネスは _lib/final-ac-reconcile-routing.test.mjs の構造（makeRecordingSandbox + devFlowArgs +
// mergeTierFacts、ローカル runDevFlowCapture + assertNoCrash、responder で label ごとに応答を返す）
// を丸ごと踏襲する。
//
// テストケース:
//   (a) final-ac-reconcile の prompt に 'final 再評価対象 item 一覧' と当該 topic が含まれる
//   (b) post-summary prompt（body）に '✅ 解消済み' / '修正作業は不要です' / 'HOLD になった理由と現状' /
//       'あなたがやること' が含まれる
//   (c) result.merge_tier === 'HOLD'（軸A pin: 解消表示でも ESCALATE は HOLD）
//   (d) item_resolutions を返さないと post-summary body に '⚠️ 要判断' が出て '✅ 解消済み' は出ない
//   (e) escalate なし・fixes=0 → final-ac-reconcile 不発 かつ post-summary body に '結論:' と
//       'あなたがやること' が含まれ merge_tier 'REVIEW'
//   (f) item_resolutions に未知 id を含めても crash せず（fail-open）accepted 0 で要判断のまま

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
// runDevFlowCapture: strip + wrap + vm 実行し {result, error} を返す
// （_lib/final-ac-reconcile-routing.test.mjs と同型のローカル copy）
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
  issue_number: 658,
  issue_title: 'stub-issue-title',
};

const ESCALATE_TOPIC = 'base image floating tag';
const ESCALATE_FEEDBACK = {
  severity: 'major',
  topic: ESCALATE_TOPIC,
  description: 'Dockerfile base image が浮動タグに変更された',
  dimension: 'infra',
  escalate: true,
  escalate_reason: 'blast-radius',
};

// final-ac-reconcile の prompt から「final 再評価対象 item 一覧」JSON 内の EVAL- id を取り出す。
function extractEvalItemId(prompt) {
  const m = prompt.match(/"id":"(EVAL-[^"]+)"/);
  return m ? m[1] : null;
}

// ============================================================
// responder factory: _lib/final-ac-reconcile-routing.test.mjs の createResponder パターンを踏襲。
// evaluator（eval#1）が escalate feedback を返す既定応答を持つ。
// ============================================================
function createResponder(overrides = {}) {
  return function ({ label, agentType, prompt }) {
    if (Object.prototype.hasOwnProperty.call(overrides, label)) {
      const v = overrides[label];
      if (typeof v === 'function') return v({ prompt, agentType, label });
      return v;
    }
    if (label === 'setup-base') return { ok: true, default_branch: 'main', dev_exists: true, requested_exists: false, worktree_exists: false, upstream_remote: '', upstream_merge: '' };
    if (label === 'worktree') return { worktree: '/tmp/wt', branch: 'feature/issue-658' };
    if (label === 'isolation-probe') return { written: true };
    if (label.startsWith('analyze')) return STANDARD_REQ;
    if (agentType === 'dev-flow:dev-implementer') return { status: 'DONE', task_id: 't1', files: ['src/x.ts'], summary: 's', concerns: [] };
    // Security floor の敵対的 security review の対象判定（issue #1063）: この test の関心外なので対象外を返す
    if (label === 'security-scope') return { ok: true, target: false, reasons: [] };
    if (label.startsWith('danger-grep')) return { ok: true, hits: [] };
    if (label === 'realized-diff') return { files: ['src/x.ts'] };
    if (agentType === 'dev-flow:evaluator' && label === 'eval#1') {
      return {
        verdict: 'pass', total: 100, threshold: 80,
        feedback: [ESCALATE_FEEDBACK],
        feedback_level: 'implementation',
        ac_results: [
          { ac_index: 0, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
          { ac_index: 1, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
        ],
        security_clearance: [], concern_resolutions: [],
      };
    }
    if (label === 'final-ac-reconcile') {
      const id = extractEvalItemId(prompt);
      return {
        ac_results: [
          { ac_index: 0, satisfied: true, evidence: 'e0', verified_by: 'inspection' },
          { ac_index: 1, satisfied: true, evidence: 'e1', verified_by: 'inspection' },
        ],
        item_resolutions: id ? [{ id, resolution: 'resolved', evidence: 'fix commit で revert 済み' }] : [],
      };
    }
    if (label.startsWith('pr')) return { pr_url: 'http://x', pr_number: 1, committed: true };
    if (label === 'merge-tier-facts') return mergeTierFacts({ files: ['src/x.ts'] });
    if (label === 'changed-files-final') return { files: [] };
    if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) return { hash: 'H', empty: false };
    if (label === 'post-summary') return { posted: true, method: 'gh pr comment', url: 'http://x' };
    if (label === 'journal-save') return { saved: true, path: '/tmp/wt/.devflow-tmp/payload-test.json' };
    if (label === 'journal-log') return { logged: true, summary: 'ok' };
    if (label === 'reconcile-sync') return { ok: true, head: 'deadbeef' };
    if (label.startsWith('test')) return { tests: 'passed', green: true, summary: '' };
    if (label === 'issue-meta') return { ok: true, number: 658, title: 'stub-issue-title' };
    return null;
  };
}

function makeSandbox({ overrides = {}, fixesApplied = 0 } = {}) {
  return makeRecordingSandbox(createResponder(overrides), {
    workflow: async () => ({ status: 'lgtm', iterations: 2, fixes_applied: fixesApplied }),
    args: devFlowArgs('658'),
  });
}

// ============================================================
// (a)(b)(c) escalate + fix + item_resolutions:resolved
//   → prompt に対象 item 一覧、post-summary に解消済み表示、merge_tier は HOLD のまま
// ============================================================

test('[final-item-resolutions] (a)(b)(c) escalate + fix 後 resolved → prompt に再評価対象 item 一覧 + 解消済み表示 + merge_tier HOLD', async () => {
  const { ctx, calls } = makeSandbox({
    fixesApplied: 1,
    overrides: { 'test#final': { tests: 'passed', green: true, summary: '' } },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'a-b-c');
  assert.ok(result !== null, '(a)(b)(c) workflow は return object を返すべきだが null だった');

  // (a) final-ac-reconcile の prompt に対象 item 一覧
  const facCall = calls.find((c) => c.label === 'final-ac-reconcile');
  assert.ok(facCall, "(a) 'final-ac-reconcile' の呼び出しが存在すること");
  assert.ok(facCall.prompt.includes('final 再評価対象 item 一覧'), "(a) final-ac-reconcile prompt に 'final 再評価対象 item 一覧' が含まれること");
  assert.ok(facCall.prompt.includes(ESCALATE_TOPIC), `(a) final-ac-reconcile prompt に topic '${ESCALATE_TOPIC}' が含まれること`);

  // (b) post-summary の body に解消済み表示 + 定型セクションが含まれる
  const postCall = calls.find((c) => c.label === 'post-summary');
  assert.ok(postCall, "(b) 'post-summary' の呼び出しが存在すること");
  assert.ok(postCall.prompt.includes('✅ 解消済み'), "(b) post-summary prompt(body) に '✅ 解消済み' が含まれること");
  assert.ok(postCall.prompt.includes('修正作業は不要です'), "(b) post-summary prompt(body) に '修正作業は不要です' が含まれること");
  assert.ok(postCall.prompt.includes('HOLD になった理由と現状'), "(b) post-summary prompt(body) に 'HOLD になった理由と現状' が含まれること");
  assert.ok(postCall.prompt.includes('あなたがやること'), "(b) post-summary prompt(body) に 'あなたがやること' が含まれること");

  // (c) 軸A pin: 解消表示でも ESCALATE は HOLD のまま
  assert.equal(result?.merge_tier, 'HOLD', `(c) merge_tier は HOLD のはずだが ${JSON.stringify(result?.merge_tier)}`);
});

// ============================================================
// (d) item_resolutions を返さない → post-summary body に '⚠️ 要判断' + '✅ 解消済み' は出ない
// ============================================================

test("[final-item-resolutions] (d) item_resolutions 無し → post-summary body は '⚠️ 要判断' のまま", async () => {
  const { ctx, calls } = makeSandbox({
    fixesApplied: 1,
    overrides: {
      'test#final': { tests: 'passed', green: true, summary: '' },
      'final-ac-reconcile': {
        ac_results: [
          { ac_index: 0, satisfied: true, evidence: 'e0', verified_by: 'inspection' },
          { ac_index: 1, satisfied: true, evidence: 'e1', verified_by: 'inspection' },
        ],
        // item_resolutions を返さない
      },
    },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'd');
  assert.ok(result !== null, '(d) workflow は return object を返すべきだが null だった');

  const postCall = calls.find((c) => c.label === 'post-summary');
  assert.ok(postCall, "(d) 'post-summary' の呼び出しが存在すること");
  assert.ok(postCall.prompt.includes('⚠️ 要判断'), "(d) post-summary prompt(body) に '⚠️ 要判断' が含まれること");
  assert.ok(!postCall.prompt.includes('✅ 解消済み'), "(d) post-summary prompt(body) に '✅ 解消済み' が含まれてはならない");
  assert.equal(result?.merge_tier, 'HOLD', `(d) merge_tier は HOLD のはずだが ${JSON.stringify(result?.merge_tier)}`);
});

// ============================================================
// (e) escalate なし・fixes=0 → final-ac-reconcile 不発 + post-summary body に '結論:' / 'あなたがやること'
//     + merge_tier REVIEW
// ============================================================

test("[final-item-resolutions] (e) escalate なし + fixes=0 → final-ac-reconcile 不発 + 結論行/あなたがやること + merge_tier REVIEW", async () => {
  const { ctx, calls } = makeSandbox({
    fixesApplied: 0,
    overrides: {
      'eval#1': {
        verdict: 'pass', total: 100, threshold: 80, feedback: [],
        feedback_level: 'implementation',
        ac_results: [
          { ac_index: 0, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
          { ac_index: 1, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
        ],
        security_clearance: [], concern_resolutions: [],
      },
    },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'e');
  assert.ok(result !== null, '(e) workflow は return object を返すべきだが null だった');

  assert.ok(!calls.some((c) => c.label === 'final-ac-reconcile'), "(e) fixes_applied=0 では 'final-ac-reconcile' が呼ばれてはならない");
  const postCall = calls.find((c) => c.label === 'post-summary');
  assert.ok(postCall, "(e) 'post-summary' の呼び出しが存在すること");
  assert.ok(postCall.prompt.includes('結論:'), "(e) post-summary prompt(body) に '結論:' が含まれること");
  assert.ok(postCall.prompt.includes('あなたがやること'), "(e) post-summary prompt(body) に 'あなたがやること' が含まれること");
  assert.equal(result?.merge_tier, 'REVIEW', `(e) merge_tier は REVIEW のはずだが ${JSON.stringify(result?.merge_tier)}`);
});

// ============================================================
// (f) item_resolutions に未知 id を含めても crash せず（fail-open）accepted 0 で要判断のまま
// ============================================================

test('[final-item-resolutions] (f) item_resolutions 未知 id → crash せず fail-open で要判断のまま', async () => {
  const { ctx, calls } = makeSandbox({
    fixesApplied: 1,
    overrides: {
      'test#final': { tests: 'passed', green: true, summary: '' },
      'final-ac-reconcile': {
        ac_results: [
          { ac_index: 0, satisfied: true, evidence: 'e0', verified_by: 'inspection' },
          { ac_index: 1, satisfied: true, evidence: 'e1', verified_by: 'inspection' },
        ],
        item_resolutions: [{ id: 'EVAL-999-nonexistent', resolution: 'resolved', evidence: 'bogus' }],
      },
    },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'f');
  assert.ok(result !== null, '(f) workflow は return object を返すべきだが null だった（未知 id で crash した可能性）');
  assert.equal(error, null, `(f) 未知 id を含めても throw してはならないが error=${error}`);

  const postCall = calls.find((c) => c.label === 'post-summary');
  assert.ok(postCall, "(f) 'post-summary' の呼び出しが存在すること");
  assert.ok(postCall.prompt.includes('⚠️ 要判断'), "(f) 未知 id は accepted されないため post-summary prompt(body) に '⚠️ 要判断' が含まれること");
  assert.ok(!postCall.prompt.includes('✅ 解消済み'), "(f) 未知 id は accepted されないため post-summary prompt(body) に '✅ 解消済み' が含まれてはならない");
  assert.equal(result?.merge_tier, 'HOLD', `(f) merge_tier は HOLD のはずだが ${JSON.stringify(result?.merge_tier)}`);
});
