// issue #405: Merge tier phase の gh pr view 配線（merge-tier-facts の pr サブ結果 →
// classifyMergeableState → classifyMergeTier）の VM sandbox 統合テスト。
//
// _lib/merge-tier.test.mjs は classifyMergeableState / classifyMergeTier という pure 関数のみを
// pin しており、dev-flow.js 側の実際の agent() dispatch（agentType/schema/label/phase）や
// conflict→HOLD / clean・unknown→no-op の end-to-end 伝播は未検証だった（PR #406 レビュー指摘）。
// 本ファイルは _lib/merge-tier-security-clearance-routing.test.mjs / _lib/ci-checks-routing.test.mjs
// と同じ VM sandbox パターン（node:vm で .claude/workflows/dev-flow.js を読み込み、agent() を
// label/agentType で stub）で以下を pin する:
//
//   (1) dispatch pin: label==='merge-tier-facts' の呼び出しが agentType:'dev-runner-haiku-ro'・
//       phase:'Merge tier'・schema（MERGE_FACTS: required ['risk'], properties.pr は required [ok, value]）・prompt に
//       `gh pr view <pr番号> --json mergeable,mergeStateStatus,headRefOid` を含むことを検証する
//       （headRefOid は hash_reconverged 判定の証人、issue #631）。
//   (2) conflicting(mergeable=CONFLICTING) → merge_tier HOLD、reasons に conflict 文言。
//   (3) conflicting(mergeStateStatus=DIRTY, mergeable 未設定) → merge_tier HOLD。
//   (4) clean(mergeable=MERGEABLE) → merge_tier は conflict 起因で HOLD にならない（no-op）。
//   (5) unknown(pr サブ結果 ok:false / 取得失敗) → fail-open、merge_tier は conflict 起因で HOLD にならない。
//   (6) merge-tier-facts は shape/danger 状態によらず Merge tier phase で必ず 1 回呼ばれる（無条件 dispatch）。

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
const devFlowSrc = readFileSync(devFlowPath, 'utf8');

// standard に落ちる req（count=3 ≤ 5, ac.length=1, type=fix → floor='standard'。danger clean +
// AC satisfied + breaking なしで、gh-pr-view が clean/unknown を返す限り baseline は REVIEW になる）。
const STANDARD_REQ = {
  summary: 's',
  acceptance_criteria: ['a'],
  issue_type: 'fix',
  scope: 'src',
  issue_number: 405,
  issue_title: 'stub-issue-title',
};

function createResponder(prMetaResponse) {
  return function (prompt, opts) {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';
    if (label === 'setup-base') {
      return { ok: true, default_branch: 'main', dev_exists: true, requested_exists: false, worktree_exists: false, upstream_remote: '', upstream_merge: '' };
    }
    if (label === 'worktree') {
      return { worktree: '/tmp/wt', branch: 'feature/issue-405' };
    }
    if (label.startsWith('analyze')) return STANDARD_REQ;
    // Security floor の敵対的 security review の対象判定（issue #1063）: この test の関心外なので対象外を返す
    if (label === 'security-scope') return { ok: true, target: false, reasons: [] };
    if (label === 'danger-grep') return { ok: true, hits: [] };
    if (label.startsWith('test')) return { tests: 'passed', green: true, summary: '' };
    if (agentType === 'dev-flow:evaluator') {
      return {
        verdict: 'pass', total: 100, threshold: 80, feedback: [],
        feedback_level: 'implementation',
        ac_results: [{ ac_index: 0, satisfied: true, verified_by: 'inspection', evidence: 'ok' }],
        security_clearance: [], concern_resolutions: [],
      };
    }
    if (label === 'realized-diff' || label === 'declared-path-check') {
      return { files: ['src/x.ts'] };
    }
    if (label.startsWith('pr')) return { pr_url: 'http://x', pr_number: 405, committed: true };
    if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) return { hash: 'H', empty: false };
    if (label === 'post-summary') return { posted: true, method: 'gh pr comment', url: 'http://x' };
    if (label === 'journal-log') return { logged: true, summary: 'ok' };
    if (agentType === 'dev-flow:dev-implementer') return { status: 'DONE', task_id: 't1', files: ['src/x.ts'], summary: 's', concerns: [] };
    // merge-tier-facts の pr サブ結果 (issue #405): シナリオ別の応答。
    // prMetaResponse は {ok, mergeable?, mergeStateStatus?, headRefOid?} 形（ok:false / null は取得失敗）を
    // pr サブ結果へ写す。
    if (label === 'merge-tier-facts') {
      const pr = prMetaResponse?.ok === true
        ? { mergeable: prMetaResponse.mergeable ?? null, mergeStateStatus: prMetaResponse.mergeStateStatus ?? null, headRefOid: prMetaResponse.headRefOid ?? null }
        : null;
      return mergeTierFacts({ pr, files: ['src/x.ts'] });
    }
    if (label === 'issue-meta') return { ok: true, number: 405, title: 'stub-issue-title' };
    return null;
  };
}

function makeSandbox(prMetaResponse) {
  const calls = [];
  const agent = async (prompt, opts) => {
    calls.push({ label: opts?.label ?? '', agentType: opts?.agentType ?? '', phase: opts?.phase ?? '', schema: opts?.schema, prompt: prompt ?? '' });
    const result = createResponder(prMetaResponse)(prompt, opts);
    return result === undefined ? null : result;
  };
  const parallel = async (fns) => Promise.all((fns || []).map((f) => f()));
  const pipeline = async (items, cb) => Promise.all((items || []).map(async (item, i) => { try { const r = await cb(item, i); return r === undefined ? null : r; } catch { return null; } }));
  const workflow = async () => ({ status: 'lgtm', iterations: 1, fixes_applied: 0 });

  const sandbox = {
    phase: () => {},
    log: () => {},
    agent,
    parallel,
    pipeline,
    workflow,
    args: devFlowArgs('405'),
    console, JSON, Math, String, Number, Boolean, Array, Object, Error, RegExp, Promise, Symbol, Map, Set, Date,
  };
  const ctx = vm.createContext(sandbox);
  return { ctx, calls };
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

function assertNoCrash(error, name) {
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`[${name}] dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }
}

// ============================================================
// (1) dispatch pin
// ============================================================

test('[gh-pr-view][1] dispatch: merge-tier-facts が agentType=dev-runner-haiku-ro, phase=Merge tier, schema(MERGE_FACTS), prompt に gh pr view コマンドを含む', async () => {
  const { ctx, calls } = makeSandbox({ ok: true, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' });
  const { error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, '1');

  const factCalls = calls.filter((c) => c.label === 'merge-tier-facts');
  assert.equal(factCalls.length, 1, `label==='merge-tier-facts' の呼び出しはちょうど 1 回のはずだが ${factCalls.length} 回だった`);
  assert.equal(calls.filter((c) => c.label === 'gh-pr-view').length, 0, 'gh pr view 専用の exec-proxy spawn は発行しない');
  const c = factCalls[0];
  assert.equal(c.agentType, 'dev-flow:dev-runner-haiku-ro', `merge-tier-facts の agentType は 'dev-flow:dev-runner-haiku-ro' のはずだが '${c.agentType}' だった`);
  assert.equal(c.phase, 'Merge tier', `merge-tier-facts の phase は 'Merge tier' のはずだが '${c.phase}' だった`);
  assert.ok(c.schema != null, 'merge-tier-facts の schema (MERGE_FACTS) が undefined/null になっている');
  // c.schema は vm sandbox（別 realm）内で生成された配列を含むため、assert/strict の
  // deepEqual は prototype 不一致で reference-equal 判定に落ちて誤 fail する
  // （values same but not reference-equal）。JSON.stringify での構造比較に落として realm 差異を吸収する。
  assert.equal(JSON.stringify(c.schema.required), JSON.stringify(['risk']), `MERGE_FACTS.required は ['risk'] のはずだが ${JSON.stringify(c.schema.required)}`);
  assert.ok(
    'pr' in c.schema.properties && 'risk' in c.schema.properties && 'head_tree' in c.schema.properties,
    `MERGE_FACTS.properties に pr/risk/head_tree が揃っていない: ${JSON.stringify(Object.keys(c.schema.properties ?? {}))}`,
  );
  // value 欠落を契約違反にする（issue #746）。
  assert.equal(JSON.stringify(c.schema.properties.pr.required), JSON.stringify(['ok', 'value']), 'pr サブ結果 schema の required は [ok, value]');
  assert.ok(
    c.prompt.includes('gh pr view 405 --json mergeable,mergeStateStatus,headRefOid'),
    `merge-tier-facts の prompt に headRefOid を含む gh pr view コマンドが含まれていない（issue #631）:\n${c.prompt}`,
  );
  assert.ok(c.prompt.includes('--pr-view-data'), 'gh pr view の stdout を --pr-view-data で merge-tier-facts へ転写する指示が無い');
});

// ============================================================
// (2) conflicting(mergeable=CONFLICTING) → HOLD
// ============================================================

test('[gh-pr-view][2] mergeable=CONFLICTING → merge_tier=HOLD、reasons に conflict 文言', async () => {
  const { ctx } = makeSandbox({ ok: true, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, '2');

  assert.equal(result?.merge_tier, 'HOLD', `mergeable=CONFLICTING の場合 merge_tier は HOLD のはずだが '${result?.merge_tier}' だった`);
  assert.ok(
    (result?.merge_tier_reasons ?? []).some((r) => r.includes('base branch と conflict')),
    `merge_tier_reasons に conflict 文言が含まれていない: ${JSON.stringify(result?.merge_tier_reasons)}`,
  );
});

// ============================================================
// (3) conflicting(mergeStateStatus=DIRTY のみ) → HOLD
// ============================================================

test('[gh-pr-view][3] mergeStateStatus=DIRTY(mergeable 未設定) → merge_tier=HOLD', async () => {
  const { ctx } = makeSandbox({ ok: true, mergeStateStatus: 'DIRTY' });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, '3');

  assert.equal(result?.merge_tier, 'HOLD', `mergeStateStatus=DIRTY の場合 merge_tier は HOLD のはずだが '${result?.merge_tier}' だった`);
});

// ============================================================
// (4) clean(mergeable=MERGEABLE) → no-op（回帰）
// ============================================================

test('[gh-pr-view][4] regression: mergeable=MERGEABLE(clean) → merge_tier は conflict 起因で HOLD にならない', async () => {
  const { ctx } = makeSandbox({ ok: true, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, '4');

  assert.equal(result?.merge_tier, 'REVIEW', `clean 状態(standard shape, 収束済)なら merge_tier は REVIEW のはずだが '${result?.merge_tier}' だった（reasons: ${JSON.stringify(result?.merge_tier_reasons)}）`);
  assert.ok(
    !(result?.merge_tier_reasons ?? []).some((r) => r.includes('conflict')),
    `clean 状態なのに merge_tier_reasons に conflict 文言が含まれている: ${JSON.stringify(result?.merge_tier_reasons)}`,
  );
});

// ============================================================
// (5) unknown(ok:false / proxy 失敗) → fail-open no-op
// ============================================================

test('[gh-pr-view][5] fail-open: pr サブ結果が ok:false(gh pr view 失敗) → merge_tier は conflict 起因で HOLD にならない', async () => {
  const { ctx } = makeSandbox({ ok: false, error: 'stub: gh pr view failed' });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, '5-ok-false');

  assert.equal(result?.merge_tier, 'REVIEW', `proxy 失敗(ok:false)は fail-open のため merge_tier は REVIEW のはずだが '${result?.merge_tier}' だった（reasons: ${JSON.stringify(result?.merge_tier_reasons)}）`);
  assert.ok(
    !(result?.merge_tier_reasons ?? []).some((r) => r.includes('conflict')),
    `proxy 失敗なのに merge_tier_reasons に conflict 文言が含まれている: ${JSON.stringify(result?.merge_tier_reasons)}`,
  );
});

test('[gh-pr-view][5] fail-open: pr サブ結果が null(取得失敗) → merge_tier は conflict 起因で HOLD にならない', async () => {
  const { ctx } = makeSandbox(null);
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, '5-null');

  assert.equal(result?.merge_tier, 'REVIEW', `pr サブ結果が null の場合も fail-open のため merge_tier は REVIEW のはずだが '${result?.merge_tier}' だった（reasons: ${JSON.stringify(result?.merge_tier_reasons)}）`);
});

test('[gh-pr-view][5] merge-tier-facts 全体が null(agent throw 等) → conflict 起因ではなく risk fail-closed 起因で HOLD（pr は fail-open のまま）', async () => {
  const { ctx, calls } = makeSandbox(null);
  // responder を丸ごと null に差し替える: makeSandbox の agent は createResponder を都度呼ぶため、
  // calls 記録後に label を見て null を返す wrapper を ctx.agent に上書きする
  const origAgent = ctx.agent;
  ctx.agent = async (prompt, opts) => (opts?.label === 'merge-tier-facts' ? (calls.push({ label: 'merge-tier-facts', agentType: opts.agentType, phase: opts.phase, schema: opts.schema, prompt }), null) : origAgent(prompt, opts));
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, '5-facts-null');

  assert.equal(result?.merge_tier, 'HOLD', `facts 全体が null なら risk fail-closed で HOLD のはずだが '${result?.merge_tier}'`);
  assert.equal(result?.danger_fail_closed, true, 'facts null は danger_fail_closed:true');
  assert.ok(
    !(result?.merge_tier_reasons ?? []).some((r) => r.includes('conflict')),
    `pr 取得不能は fail-open のため conflict 文言は出ない: ${JSON.stringify(result?.merge_tier_reasons)}`,
  );
});

// ============================================================
// (6) mergeable=UNKNOWN(GitHub 側 mergeability 未計算) → fail-open no-op
// ============================================================

test('[gh-pr-view][6] fail-open: mergeable=UNKNOWN(GitHub 側未計算) → merge_tier は conflict 起因で HOLD にならない', async () => {
  const { ctx } = makeSandbox({ ok: true, mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, '6');

  assert.equal(result?.merge_tier, 'REVIEW', `mergeable=UNKNOWN は fail-open のため merge_tier は REVIEW のはずだが '${result?.merge_tier}' だった（reasons: ${JSON.stringify(result?.merge_tier_reasons)}）`);
});
