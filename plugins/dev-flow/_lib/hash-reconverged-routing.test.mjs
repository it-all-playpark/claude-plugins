// hash-reconverged-routing: VM sandbox routing test for dev-flow の hash_reconverged 判定
// （issue #631）。hash_mismatch 検出直後（PR phase）の tree-diff-numstat probe と、Merge tier
// phase の merge-tier-facts（pr.headRefOid / head_tree / diffhash サブ結果）+ 3 条件
// （evalStaleness==='hash_mismatch' && prHeadTreeOid===evalDiffHash && mergeDiffHash===evalDiffHash）
// による hash_reconverged への置換を検証する。
//
// ハーネスは _lib/merge-tier-diffhash-reuse-routing.test.mjs の makeRecordingSandbox（共有
// test-helpers/vm-sandbox.mjs）+ ローカル runDevFlowCapture / assertNoCrash / createResponder
// パターンを踏襲する。
//
// テストケース:
//   (a) 既定（3 条件成立）→ hash_reconverged、merge_tier=REVIEW、hash_mismatch reason なし、
//       tree-diff-numstat / merge-tier-facts とも 1 回
//   (b) facts.head_tree が evalDiffHash と不一致（prHeadTreeOid!==evalDiffHash、mergeDiffHash
//       ===evalDiffHash）→ hash_mismatch 維持・HOLD
//   (c) facts.diffhash が取得失敗（mergeDiffHash null）→ hash_mismatch 維持・HOLD（head_tree が
//       eval と一致していても mergeDiffHash null では再収束しない）
//   (c-2) (c) のとき facts.diffhash.error（script が添えた stderr 先頭）が hash_mismatch 維持 log に出る
//   (d) facts.pr に headRefOid が無い → hash_mismatch 維持・HOLD（head_tree が一致していても証人不在）
//   (d') facts.head_tree 自体が取得失敗 → hash_mismatch 維持・HOLD
//   (e) tree-diff-numstat が取得失敗しても hash_reconverged 判定は妨げられない。また (b) 相当の
//       不一致 + numstat 失敗で HOLD reason に手動確認コマンドが載る
//   (f) dispatch pin: tree-diff-numstat / merge-tier-facts の agentType・prompt（gh pr view の
//       headRefOid 込み --json、rev-parse は script 側なので prompt には現れない）
//   (g) hash 不一致なし（diff-hash-pr===diff-hash-eval）→ tree-diff-numstat 0 回、eval_staleness='none'、
//       merge-tier-facts は 1 回（Merge tier の他サブ結果に必要）
//   (h) fixes_applied>0 でも 3 条件成立なら hash_reconverged（判定は 3 条件のみ）

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
// （merge-tier-diffhash-reuse-routing.test.mjs と同型）
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

const HEAD_REF_OID = 'a'.repeat(40);

// standard に落ちる req（count=3 ≤ 5, ac.length=2 ≤ 6, type=fix → floor='standard'）
const STANDARD_REQ = {
  summary: 's',
  acceptance_criteria: ['a', 'b'],
  issue_type: 'fix',
  scope: 'src',
  issue_number: 631,
  issue_title: 'stub-issue-title',
};

// ============================================================
// responder factory: merge-tier-diffhash-reuse-routing.test.mjs の createResponder を踏襲。
// 既定で hash_mismatch を必ず発生させ（diff-hash-eval='AAA' / diff-hash-pr='BBB'）、
// merge-tier-facts の head_tree / diffhash を eval と一致させて 3 条件成立（hash_reconverged）を既定にする。
// ============================================================
function createResponder(overrides = {}) {
  return function ({ label, agentType, prompt }) {
    if (Object.prototype.hasOwnProperty.call(overrides, label)) {
      const v = overrides[label];
      if (typeof v === 'function') return v({ prompt, agentType, label });
      return v;
    }
    if (label === 'setup-base') return { ok: true, default_branch: 'main', dev_exists: true, requested_exists: false, worktree_exists: false, upstream_remote: '', upstream_merge: '' };
    if (label === 'worktree') return { worktree: '/tmp/wt', branch: 'feature/issue-631' };
    if (label.startsWith('analyze')) return STANDARD_REQ;
    // Diff triage の敵対的 security review の対象判定（issue #1063）: この test の関心外なので対象外を返す
    if (label === 'security-scope') return { ok: true, target: false, reasons: [] };
    if (label === 'danger-grep') {
      return { risk: { ok: true, hits: [] }, files: ['src/x.ts'], struct: null, diffhash: { hash: 'AAA', empty: false } };
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
    if (label === 'diff-hash-eval') return { hash: 'AAA', empty: false };
    if (label === 'diff-hash-pr') return { hash: 'BBB', empty: false };
    if (label === 'merge-tier-facts') return mergeTierFacts({ hash: 'AAA', tree: 'AAA', files: ['src/x.ts'], pr: { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', headRefOid: HEAD_REF_OID } });
    if (label === 'tree-diff-numstat') return { ok: true, lines: ['0\t500\tdocs/a.md', '0\t360\tdocs/b.md'] };
    if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) return { hash: 'H', empty: false };
    if (label === 'post-summary') return { posted: true, method: 'gh pr comment', url: 'http://x' };
    if (label === 'journal-log') return { logged: true, summary: 'ok' };
    if (agentType === 'dev-flow:dev-implementer') return { status: 'DONE', task_id: 't', files: ['src/x.ts'], summary: 's', concerns: [] };
    if (label.startsWith('test')) return { tests: 'passed', green: true, summary: '' };
    if (label === 'issue-meta') return { ok: true, number: 631, title: 'stub-issue-title' };
    return null;
  };
}

function makeSandbox({ overrides = {}, workflow } = {}) {
  return makeRecordingSandbox(createResponder(overrides), {
    workflow: workflow ?? (async () => ({ status: 'lgtm', iterations: 1, fixes_applied: 0 })),
    args: devFlowArgs('631'),
  });
}

// ============================================================
// (a) 既定（3 条件成立） → hash_reconverged
// ============================================================

test('[hash-reconverged] (a) 既定(3条件成立) → eval_staleness=hash_reconverged、merge_tier=REVIEW、hash_mismatch reason なし、probe 各1回', async () => {
  const { ctx, calls } = makeSandbox();
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'a');
  assert.ok(result !== null, '(a) workflow は return object を返すべきだが null だった');

  assert.equal(result?.eval_staleness, 'hash_reconverged', `(a) eval_staleness は hash_reconverged のはずだが ${JSON.stringify(result?.eval_staleness)}`);
  assert.equal(result?.merge_tier, 'REVIEW', `(a) merge_tier は REVIEW のはずだが ${JSON.stringify(result?.merge_tier)}`);
  assert.ok(
    !(result?.merge_tier_reasons ?? []).some((r) => r.includes('hash_mismatch')),
    `(a) merge_tier_reasons に hash_mismatch を含む要素があってはならない: ${JSON.stringify(result?.merge_tier_reasons)}`,
  );

  const numstatCalls = calls.filter((c) => c.label === 'tree-diff-numstat');
  const factCalls = calls.filter((c) => c.label === 'merge-tier-facts');
  assert.equal(numstatCalls.length, 1, `(a) tree-diff-numstat はちょうど 1 回のはずだが ${numstatCalls.length} 回`);
  assert.equal(factCalls.length, 1, `(a) merge-tier-facts はちょうど 1 回のはずだが ${factCalls.length} 回`);
  assert.equal(calls.filter((c) => c.label === 'head-tree-oid').length, 0, '(a) head tree の取得は merge-tier-facts に含まれ、専用 spawn は発行しない');

  const postSummary = calls.find((c) => c.label === 'post-summary');
  assert.ok(postSummary != null, '(a) post-summary が呼ばれていない');
});

// ============================================================
// (b) prHeadTreeOid !== evalDiffHash → hash_mismatch 維持
// ============================================================

test('[hash-reconverged] (b) facts.head_tree が evalDiffHash と不一致 → hash_mismatch 維持・HOLD・両hashと差分ファイルを含む', async () => {
  const { ctx, calls } = makeSandbox({
    overrides: { 'merge-tier-facts': mergeTierFacts({ hash: 'AAA', tree: 'BBB', files: ['src/x.ts'], pr: { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', headRefOid: HEAD_REF_OID } }) },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'b');
  assert.ok(result !== null, '(b) workflow は return object を返すべきだが null だった');

  assert.equal(result?.eval_staleness, 'hash_mismatch', `(b) eval_staleness は hash_mismatch のままのはずだが ${JSON.stringify(result?.eval_staleness)}`);
  assert.equal(result?.merge_tier, 'HOLD', `(b) merge_tier は HOLD のはずだが ${JSON.stringify(result?.merge_tier)}`);
  const reasons = result?.merge_tier_reasons ?? [];
  assert.ok(
    reasons.some((r) => r.includes('hash_mismatch') && r.includes('docs/a.md (+0/-500)') && r.includes('AAA') && r.includes('BBB')),
    `(b) merge_tier_reasons に hash_mismatch + docs/a.md (+0/-500) + AAA + BBB を含む要素が無い: ${JSON.stringify(reasons)}`,
  );

  assert.equal(calls.filter((c) => c.label === 'merge-tier-facts').length, 1, '(b) merge-tier-facts は 1 回呼ばれるはず');
});

// ============================================================
// (c) mergeDiffHash null → hash_mismatch 維持（head_tree が一致していても再収束しない）
// ============================================================

test('[hash-reconverged] (c) facts.diffhash が取得失敗(mergeDiffHash null) → head_tree が一致していても hash_mismatch 維持・HOLD', async () => {
  const { ctx, logs } = makeSandbox({
    overrides: { 'merge-tier-facts': mergeTierFacts({ hash: null, tree: 'AAA', files: ['src/x.ts'], pr: { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', headRefOid: HEAD_REF_OID } }) },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'c');
  assert.ok(result !== null, '(c) workflow は return object を返すべきだが null だった');

  assert.equal(result?.eval_staleness, 'hash_mismatch', `(c) eval_staleness は hash_mismatch のままのはずだが ${JSON.stringify(result?.eval_staleness)}`);
  assert.equal(result?.merge_tier, 'HOLD', `(c) merge_tier は HOLD のはずだが ${JSON.stringify(result?.merge_tier)}`);
  assert.ok(logs.some((l) => l.includes('mergeDiffHash=null')), '(c) mergeDiffHash null で hash_mismatch 維持の log が無い');
});

test('[hash-reconverged] (c-2) facts.diffhash の error（script が添えた stderr 先頭）が mergeDiffHash=null の hash_mismatch 維持 log に出る（issue #790）', async () => {
  const diffhashError = 'worktree-diff-hash.sh failed (exit 128): fatal: Unable to create index.lock: Operation not permitted';
  const facts = mergeTierFacts({ hash: null, tree: 'AAA', files: ['src/x.ts'], pr: { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', headRefOid: HEAD_REF_OID } });
  facts.diffhash = { ok: false, value: null, error: diffhashError };
  const { ctx, logs } = makeSandbox({ overrides: { 'merge-tier-facts': facts } });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'c-2');
  assert.ok(result !== null, '(c-2) workflow は return object を返すべきだが null だった');

  assert.equal(result?.eval_staleness, 'hash_mismatch', `(c-2) eval_staleness は hash_mismatch のままのはずだが ${JSON.stringify(result?.eval_staleness)}`);
  assert.ok(
    logs.some((l) => l.includes('mergeDiffHash=null') && l.includes(diffhashError) && l.includes('hash_mismatch 維持')),
    `(c-2) hash_mismatch 維持の log に diffhash の error 文が無い: ${JSON.stringify(logs.filter((l) => l.includes('mergeDiffHash=null')))}`,
  );
});

// ============================================================
// (d) headRefOid 欠落 → hash_mismatch 維持（head_tree が一致していても証人不在）
// ============================================================

test('[hash-reconverged] (d) facts.pr に headRefOid が無い → head_tree が一致していても hash_mismatch 維持・HOLD', async () => {
  const { ctx, logs } = makeSandbox({
    overrides: { 'merge-tier-facts': mergeTierFacts({ hash: 'AAA', tree: 'AAA', files: ['src/x.ts'], pr: { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' } }) },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'd');
  assert.ok(result !== null, '(d) workflow は return object を返すべきだが null だった');

  assert.equal(result?.eval_staleness, 'hash_mismatch', `(d) eval_staleness は hash_mismatch のままのはずだが ${JSON.stringify(result?.eval_staleness)}`);
  assert.equal(result?.merge_tier, 'HOLD', `(d) merge_tier は HOLD のはずだが ${JSON.stringify(result?.merge_tier)}`);
  assert.ok(logs.some((l) => l.includes('headRefOid を取得できず')), '(d) headRefOid 欠落の log が無い');
});

// ============================================================
// (d') head_tree 取得失敗 → hash_mismatch 維持
// ============================================================

test("[hash-reconverged] (d') facts.head_tree が取得失敗 → hash_mismatch 維持・HOLD", async () => {
  const { ctx } = makeSandbox({
    overrides: { 'merge-tier-facts': mergeTierFacts({ hash: 'AAA', tree: null, files: ['src/x.ts'], pr: { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', headRefOid: HEAD_REF_OID } }) },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, "d'");
  assert.ok(result !== null, "(d') workflow は return object を返すべきだが null だった");

  assert.equal(result?.eval_staleness, 'hash_mismatch', `(d') eval_staleness は hash_mismatch のままのはずだが ${JSON.stringify(result?.eval_staleness)}`);
  assert.equal(result?.merge_tier, 'HOLD', `(d') merge_tier は HOLD のはずだが ${JSON.stringify(result?.merge_tier)}`);
});

// ============================================================
// (e) tree-diff-numstat 失敗は hash_reconverged 判定を妨げない／不一致時は手動確認コマンドを出す
// ============================================================

test('[hash-reconverged] (e) tree-diff-numstat が null でも 3 条件成立なら hash_reconverged になる（差分取得失敗は再収束判定を妨げない）', async () => {
  const { ctx } = makeSandbox({
    overrides: { 'tree-diff-numstat': null },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'e-1');
  assert.ok(result !== null, '(e-1) workflow は return object を返すべきだが null だった');

  assert.equal(result?.eval_staleness, 'hash_reconverged', `(e-1) eval_staleness は hash_reconverged のはずだが ${JSON.stringify(result?.eval_staleness)}`);
});

test('[hash-reconverged] (e) tree-diff-numstat が null + facts.head_tree 不一致 → HOLD reason に git diff --stat と手動確認を含む', async () => {
  const { ctx } = makeSandbox({
    overrides: {
      'tree-diff-numstat': null,
      'merge-tier-facts': mergeTierFacts({ hash: 'AAA', tree: 'BBB', files: ['src/x.ts'], pr: { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', headRefOid: HEAD_REF_OID } }),
    },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'e-2');
  assert.ok(result !== null, '(e-2) workflow は return object を返すべきだが null だった');

  assert.equal(result?.eval_staleness, 'hash_mismatch', `(e-2) eval_staleness は hash_mismatch のままのはずだが ${JSON.stringify(result?.eval_staleness)}`);
  const reasons = result?.merge_tier_reasons ?? [];
  assert.ok(
    reasons.some((r) => r.includes('git diff --stat AAA BBB') && r.includes('手動確認')),
    `(e-2) merge_tier_reasons に手動確認コマンドが含まれていない: ${JSON.stringify(reasons)}`,
  );
});

// ============================================================
// (f) dispatch pin
// ============================================================

test('[hash-reconverged] (f) dispatch pin: tree-diff-numstat / merge-tier-facts の agentType・prompt', async () => {
  const { ctx, calls } = makeSandbox();
  const { error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'f');

  const numstatCall = calls.find((c) => c.label === 'tree-diff-numstat');
  assert.ok(numstatCall != null, '(f) tree-diff-numstat が呼ばれていない');
  assert.equal(numstatCall.agentType, 'dev-flow:dev-runner-haiku-ro', `(f) tree-diff-numstat の agentType が期待と不一致: ${numstatCall.agentType}`);
  assert.ok(
    numstatCall.prompt.includes('--numstat') && numstatCall.prompt.includes('AAA') && numstatCall.prompt.includes('BBB'),
    `(f) tree-diff-numstat の prompt に --numstat / AAA / BBB が含まれていない:\n${numstatCall.prompt}`,
  );

  const factCall = calls.find((c) => c.label === 'merge-tier-facts');
  assert.ok(factCall != null, '(f) merge-tier-facts が呼ばれていない');
  assert.equal(factCall.agentType, 'dev-flow:dev-runner-haiku-ro', `(f) merge-tier-facts の agentType が期待と不一致: ${factCall.agentType}`);
  assert.ok(
    factCall.prompt.includes('--json mergeable,mergeStateStatus,headRefOid'),
    `(f) merge-tier-facts の prompt に headRefOid 込みの gh pr view --json が含まれていない:\n${factCall.prompt}`,
  );
  assert.ok(
    factCall.prompt.includes('`merge-tier-facts --worktree /tmp/wt --base origin/main --pr-view-data'),
    `(f) merge-tier-facts の prompt に bare 名 call site が含まれていない:\n${factCall.prompt}`,
  );
  assert.ok(!factCall.prompt.includes('rev-parse'), '(f) PR head tree の rev-parse は script 側で行うため prompt には現れない');
});

// ============================================================
// (g) hash 不一致なし → probe 0 回・eval_staleness=none
// ============================================================

test('[hash-reconverged] (g) diff-hash-pr が diff-hash-eval と一致 → tree-diff-numstat 0 回・merge-tier-facts 1 回、eval_staleness=none', async () => {
  const { ctx, calls } = makeSandbox({
    overrides: { 'diff-hash-pr': { hash: 'AAA', empty: false } },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'g');
  assert.ok(result !== null, '(g) workflow は return object を返すべきだが null だった');

  assert.equal(result?.eval_staleness, 'none', `(g) eval_staleness は none のはずだが ${JSON.stringify(result?.eval_staleness)}`);
  assert.equal(calls.filter((c) => c.label === 'tree-diff-numstat').length, 0, '(g) hash 一致時は tree-diff-numstat が呼ばれてはならない');
  assert.equal(calls.filter((c) => c.label === 'merge-tier-facts').length, 1, '(g) hash 一致時も merge-tier-facts は 1 回（Merge tier の他サブ結果に必要）');
});

// ============================================================
// (h) fixes_applied>0 でも 3 条件成立なら hash_reconverged
// ============================================================

test('[hash-reconverged] (h) fixes_applied>0 でも 3 条件成立なら eval_staleness=hash_reconverged（merge_tier は assert しない）', async () => {
  const { ctx } = makeSandbox({
    workflow: async () => ({ status: 'lgtm', iterations: 2, fixes_applied: 1 }),
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'h');
  assert.ok(result !== null, '(h) workflow は return object を返すべきだが null だった');

  assert.equal(result?.eval_staleness, 'hash_reconverged', `(h) eval_staleness は hash_reconverged のはずだが ${JSON.stringify(result?.eval_staleness)}`);
});
