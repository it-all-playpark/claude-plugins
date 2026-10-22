// final-reconcile-routing: VM sandbox routing test for dev-flow の Final reconcile phase
// （issue #320 F4）。pr-iterate が fix を適用した run（fixes_applied>0）のみ、worktree を
// PR 最終 HEAD へ ff-sync → test suite 一発再実行 → 最終 changed-files から
// 宣言外パスを再判定し、classifyMergeTier / summary / telemetry /
// return へ配線されることを pin する。
//
// ハーネスは makeRecordingSandbox（_lib/test-helpers/vm-sandbox.mjs）を使い、
// ci-checks-routing.test.mjs の createResponder パターンを踏襲する。ただし return object
// を検証する必要があるため、実行部分は merge-tier-security-clearance-routing.test.mjs
// と同型のローカル runDevFlowCapture（{result, error} を返す）を使う
// （vm-sandbox.mjs の共有 runDevFlowInSandbox は error のみを返すため）。
//
// テストケース:
//   (a) fixes_applied=0 → Final reconcile の agent は一切呼ばれず final_reconcile==='skipped'
//       + merge_tier は従来どおり（AC-1 cost regression）
//   (b) fixes=1 + sync ok + test#final green → final_reconcile==='reverified' + final_test_green===true
//       + merge_tier==='REVIEW'（AC-2）
//   (c) fixes=1 + test#final red → merge_tier==='HOLD' + reasons に 'final test red'（AC-3）
//   (d) fixes=1 + test#final null → final_reconcile==='unavailable' + HOLD + reasons に
//       'Final reconcile 再検証不能'（AC-3）
//   (e) fixes=1 + reconcile-sync 失敗 → unavailable + HOLD + calls に 'test#final' が現れない
//   (h) calls 配列で 'merge-tier-facts'（Merge tier）が 'reconcile-sync' より後（AC-5）
//   (i) fixes=1 + changed-files-final null → final_reconcile==='reverified' のまま（fail-open）
//   (j) fixes=1 + test#final throw(EPERM) → error===null（run 完走）+ unavailable + HOLD +
//       reasons に 'Final reconcile 再検証不能'（AC-4 throw fail-safe）
//   (l) fixes=1 + test#final tests:'error'（起動失敗・1 件も実行されず）→ final_reconcile==='unavailable'
//       + final_test_green が return に現れない（null）+ HOLD + reasons に 'Final reconcile 再検証不能'
//       + 'final test red' を含まない + changed-files-final は呼ばれる（issue #619）
//   (m) fixes=1 + test#final tests:'failed'（本物の red）→ final_reconcile==='reverified' + final_test_green===false
//       + HOLD + reasons に 'final test red'（issue #619 回帰: 'error' 分離後も failed 経路は不変）
//   (n) test#final red + failed_files の単体再実行（test#final-rerun）green → flake: final_test_green true・
//       final_test_flaky 記録・final_test_red なし・サマリーのテスト欄が flake で「修正が必要」なし（issue #865）
//   (o) 単体再実行も red / null / throw / error → final_test_red で HOLD（issue #865）
//   (p) failed_files が空・欠落・安全に渡せないパスの red → 再実行せず final_test_red で HOLD（issue #865）

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
// runDevFlowCapture: strip + wrap + vm 実行し {result, error} を返す（merge-tier-security-
// clearance-routing.test.mjs と同型のローカル copy）
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

// ============================================================
// responder factory: ci-checks-routing.test.mjs の createResponder パターンを踏襲。
// overrides は label 単位（関数なら ({prompt, agentType, label}) => ... として呼ばれる。throw も伝播）。
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
    if (label === 'changed-files-final') return { files: [] };
    // merge-tier-facts の diffhash のみ別ハッシュを返す（issue #377 diff-hash reuse）。この test 群は
    // fixes_applied>0（Final reconcile で tree が変化）を想定しており、Security floor 時点
    // (diff-hash-secfloor) と Merge tier 時点 (merge-tier-facts.diffhash) のハッシュ不一致が意味的に正しい。
    // 一致させると reuse が発火し、Merge tier の risk / changed 再判定が facts を使わなくなる（特に case (h)）。
    if (label === 'merge-tier-facts') return mergeTierFacts({ hash: 'H_MERGE', files: ['src/x.ts'] });
    if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) return { hash: 'H', empty: false };
    if (label === 'post-summary') return { posted: true, method: 'gh pr comment', url: 'http://x' };
    // journal-save (stage1, issue #494): 実際の telemetry payload はここに載る
    if (label === 'journal-save') return { saved: true, path: '/tmp/wt/.devflow-tmp/payload-test.json' };
    if (label === 'journal-log') return { logged: true, summary: 'ok' };
    if (agentType === 'dev-flow:dev-implementer') return { status: 'DONE', task_id: 't', files: ['src/x.ts'], summary: 's', concerns: [] };
    if (label === 'reconcile-sync') return { ok: true, head: 'deadbeef' };
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

// ============================================================
// (a) fixes_applied=0 → Final reconcile は zero-overhead（AC-1）
// ============================================================

test('[final-reconcile] (a) fixes_applied=0 → 新規 agent 呼び出しゼロ + final_reconcile===skipped + merge tier 不変', async () => {
  const { ctx, calls } = makeSandbox({ fixesApplied: 0 });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'a');
  assert.ok(result !== null, '(a) workflow は return object を返すべきだが null だった');

  const finalLabels = ['reconcile-sync', 'test#final', 'changed-files-final', 'ci-final'];
  for (const l of finalLabels) {
    assert.ok(!calls.some((c) => c.label === l), `(a) fixes_applied=0 では label==='${l}' の呼び出しが存在してはならない`);
  }
  assert.equal(result?.final_reconcile, 'skipped', `(a) final_reconcile は 'skipped' のはずだが ${JSON.stringify(result?.final_reconcile)}`);
  assert.equal(result?.merge_tier, 'REVIEW', `(a) merge tier は従来どおり REVIEW のはずだが ${JSON.stringify(result?.merge_tier)}`);
});

// ============================================================
// (b) fixes=1 + sync ok + test#final green → reverified + final_test_green:true + REVIEW（AC-2）
// ============================================================

test('[final-reconcile] (b) fixes=1 + test green → reverified + final_test_green:true + merge_tier REVIEW', async () => {
  let syncPrompt = null;
  const { ctx, calls } = makeSandbox({
    fixesApplied: 1,
    overrides: {
      'test#final': { tests: 'passed', green: true, summary: '' },
      'reconcile-sync': ({ prompt }) => { syncPrompt = prompt; return { ok: true, head: 'deadbeef' }; },
    },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'b');
  assert.ok(result !== null, '(b) workflow は return object を返すべきだが null だった');

  assert.ok(calls.some((c) => c.label === 'reconcile-sync'), "(b) 'reconcile-sync' が呼ばれるはず");
  // fetch / merge は cwd（WT）で実行する bare 単文
  assert.ok(syncPrompt?.includes('git fetch origin ') && syncPrompt?.includes('git merge --ff-only FETCH_HEAD'),
    `(b) reconcile-sync の prompt は bare の git fetch / git merge を含むべき: ${syncPrompt}`);
  // cd 前置の複合形（`cd <WT> && git fetch …`）へ誘導しない: 「cd <WT> で作業」を置かず bare 単文と cd 前置禁止を明示する
  assert.ok(!/cd \S+ で作業/.test(syncPrompt ?? ''), `(b) reconcile-sync の prompt は「cd <WT> で作業」を含んではならない: ${syncPrompt?.slice(0, 200)}`);
  assert.ok(syncPrompt?.includes('bare 単文') && syncPrompt?.includes('cd 前置'), `(b) reconcile-sync の prompt は bare 単文・cd 前置禁止を指示すべき: ${syncPrompt?.slice(0, 200)}`);
  // issue #700: fetch/merge は cwd のみで対象が決まる。手順 0 で cwd の branch を
  // 照合し、不一致なら fetch/merge を実行せず ok:false で中断する指示を持つべき
  assert.ok(syncPrompt?.includes('git rev-parse --abbrev-ref HEAD'), `(b) reconcile-sync の prompt は手順 0 の branch 確認コマンドを含むべき: ${syncPrompt}`);
  assert.ok(syncPrompt?.includes('cwd branch mismatch'), `(b) reconcile-sync の prompt は cwd branch mismatch での中断を指示すべき: ${syncPrompt}`);
  assert.ok(syncPrompt?.indexOf('git rev-parse --abbrev-ref HEAD') < syncPrompt?.indexOf('git fetch origin'),
    `(b) branch 確認（手順 0）は git fetch（手順 1）より前に置かれるべき: ${syncPrompt}`);
  assert.ok(calls.some((c) => c.label === 'test#final'), "(b) 'test#final' が呼ばれるはず");
  assert.equal(result?.final_reconcile, 'reverified', `(b) final_reconcile は 'reverified' のはずだが ${JSON.stringify(result?.final_reconcile)}`);
  assert.equal(result?.final_test_green, true, `(b) final_test_green は true のはずだが ${JSON.stringify(result?.final_test_green)}`);
  assert.equal(result?.merge_tier, 'REVIEW', `(b) merge_tier は REVIEW のはずだが ${JSON.stringify(result?.merge_tier)}`);
});

// ============================================================
// (c) fixes=1 + test#final red → HOLD + reasons に 'final test red'（AC-3）
// ============================================================

test("[final-reconcile] (c) fixes=1 + test#final red → merge_tier HOLD + reasons に 'final test red'", async () => {
  const { ctx } = makeSandbox({
    fixesApplied: 1,
    overrides: { 'test#final': { tests: 'failed', green: false, summary: 'boom' } },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'c');
  assert.ok(result !== null, '(c) workflow は return object を返すべきだが null だった');

  assert.equal(result?.final_test_green, false, `(c) final_test_green は false のはずだが ${JSON.stringify(result?.final_test_green)}`);
  assert.equal(result?.merge_tier, 'HOLD', `(c) merge_tier は HOLD のはずだが ${JSON.stringify(result?.merge_tier)}`);
  assert.ok(
    (result?.merge_tier_reasons ?? []).some((r) => r.includes('final test red')),
    `(c) merge_tier_reasons に 'final test red' が含まれるはずだが ${JSON.stringify(result?.merge_tier_reasons)}`,
  );
});

// ============================================================
// (d) fixes=1 + test#final null → unavailable + HOLD + reasons に 'Final reconcile 再検証不能'（AC-3）
// ============================================================

test("[final-reconcile] (d) fixes=1 + test#final null → final_reconcile unavailable + HOLD", async () => {
  const { ctx, calls } = makeSandbox({
    fixesApplied: 1,
    overrides: { 'test#final': null },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'd');
  assert.ok(result !== null, '(d) workflow は return object を返すべきだが null だった');

  assert.equal(result?.final_reconcile, 'unavailable', `(d) final_reconcile は 'unavailable' のはずだが ${JSON.stringify(result?.final_reconcile)}`);
  assert.equal(result?.merge_tier, 'HOLD', `(d) merge_tier は HOLD のはずだが ${JSON.stringify(result?.merge_tier)}`);
  assert.ok(
    (result?.merge_tier_reasons ?? []).some((r) => r.includes('Final reconcile 再検証不能')),
    `(d) merge_tier_reasons に 'Final reconcile 再検証不能' が含まれるはずだが ${JSON.stringify(result?.merge_tier_reasons)}`,
  );
  // issue #600 レビュー指摘: Step3（changed-files-final）は test#final の成否に依らず
  // sync 成功時に実行されるはず（test#final null でも宣言外再監査は skip しない）。
  assert.ok(calls.some((c) => c.label === 'changed-files-final'), "(d) test#final が null でも 'changed-files-final' は呼ばれるはず");
});

// ============================================================
// (e) fixes=1 + reconcile-sync 失敗 → unavailable + HOLD + 'test#final' 不発
// ============================================================

test("[final-reconcile] (e) fixes=1 + reconcile-sync 失敗(non-ff) → unavailable + HOLD + test#final 不発", async () => {
  const { ctx, calls } = makeSandbox({
    fixesApplied: 1,
    overrides: { 'reconcile-sync': { ok: false, error: 'non-ff' } },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'e');
  assert.ok(result !== null, '(e) workflow は return object を返すべきだが null だった');

  assert.equal(result?.final_reconcile, 'unavailable', `(e) final_reconcile は 'unavailable' のはずだが ${JSON.stringify(result?.final_reconcile)}`);
  assert.equal(result?.merge_tier, 'HOLD', `(e) merge_tier は HOLD のはずだが ${JSON.stringify(result?.merge_tier)}`);
  assert.ok(!calls.some((c) => c.label === 'test#final'), "(e) sync 失敗時は 'test#final' が呼ばれないはず");
});

// ============================================================
// (e2) fixes=1 + reconcile-sync が cwd branch mismatch を返す → unavailable + HOLD + 'test#final' 不発（issue #700）
// ============================================================

test("[final-reconcile] (e2) fixes=1 + reconcile-sync が cwd branch mismatch を返す → unavailable + HOLD + test#final 不発", async () => {
  const { ctx, calls } = makeSandbox({
    fixesApplied: 1,
    overrides: { 'reconcile-sync': { ok: false, error: 'cwd branch mismatch: expected feature/issue-700, got main' } },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'e2');
  assert.ok(result !== null, '(e2) workflow は return object を返すべきだが null だった');

  assert.equal(result?.final_reconcile, 'unavailable', `(e2) final_reconcile は 'unavailable' のはずだが ${JSON.stringify(result?.final_reconcile)}`);
  assert.equal(result?.merge_tier, 'HOLD', `(e2) merge_tier は HOLD のはずだが ${JSON.stringify(result?.merge_tier)}`);
  assert.ok(!calls.some((c) => c.label === 'test#final'), "(e2) sync が cwd branch mismatch を返したときは 'test#final' が呼ばれないはず");
});

// ============================================================
// (h) calls 順序: 'merge-tier-facts'（Merge tier の danger-grep / changed-files 再判定）は 'reconcile-sync' より後（AC-5）
// ============================================================

test("[final-reconcile] (h) calls 順序: Merge tier の 'merge-tier-facts' は 'reconcile-sync' より後", async () => {
  const { ctx, calls } = makeSandbox({ fixesApplied: 1 });
  const { error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'h');

  const idxSync = calls.findIndex((c) => c.label === 'reconcile-sync');
  const idxFacts = calls.findIndex((c) => c.label === 'merge-tier-facts');
  // Merge tier が使う changed files には 2 経路がある（issue #542）:
  //   (1) Final reconcile の 'changed-files-final' を再利用する（取得できた場合）
  //   (2) merge-tier-facts の changed サブ結果を使う（再利用不可の場合 — テスト (i) が担当）
  // AC-5 が守るのは「reconcile-sync より後の tree を対象にすること」であって呼び出しラベルでは
  // ないため、実際に採用された側の取得呼び出しが reconcile-sync より後であることを検証する。
  const idxChangedFinal = calls.findIndex((c) => c.label === 'changed-files-final');
  const idxChangedUsed = idxChangedFinal >= 0 ? idxChangedFinal : idxFacts;

  assert.ok(idxSync >= 0, "(h) 'reconcile-sync' の呼び出しが見つからない");
  assert.ok(idxFacts >= 0, "(h) 'merge-tier-facts' の呼び出しが見つからない");
  assert.ok(idxChangedUsed >= 0, "(h) Merge tier が使う changed files の取得呼び出し（'changed-files-final' の再利用元、または 'merge-tier-facts'）が見つからない");
  assert.ok(idxFacts > idxSync, "(h) 'merge-tier-facts' は 'reconcile-sync' より後であるべき（Final reconcile 完了後の tree を対象にする、AC-5）");
  assert.ok(idxChangedUsed > idxSync, "(h) Merge tier が使う changed files は 'reconcile-sync' より後に取得されるべき（AC-5）");
});

// ============================================================
// (h2) Merge tier の read-only 事実取得は 'merge-tier-facts' 1 spawn のみ
//      （changed-files / danger-grep-final 等の個別 spawn を再発行しない）
// ============================================================

test("[final-reconcile] (h2) Merge tier の read-only 事実取得は 'merge-tier-facts' 1 回のみで個別 spawn を発行しない", async () => {
  const { ctx, calls } = makeSandbox({ fixesApplied: 1 });
  const { error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'h2');

  const changedFinalCalls = calls.filter((c) => c.label === 'changed-files-final');
  const factCalls = calls.filter((c) => c.label === 'merge-tier-facts');
  const mergeTierRo = calls.filter((c) => c.opts?.phase === 'Merge tier' && c.agentType === 'dev-flow:dev-runner-haiku-ro');

  assert.equal(
    changedFinalCalls.length, 1,
    `(h2) 前提: 'changed-files-final' は 1 回呼ばれるはずだが ${changedFinalCalls.length} 回だった`,
  );
  assert.equal(factCalls.length, 1, `(h2) 'merge-tier-facts' は 1 回のはずだが ${factCalls.length} 回`);
  assert.equal(
    mergeTierRo.length, 1,
    `(h2) Merge tier の read-only exec-proxy は merge-tier-facts の 1 spawn のみのはずだが ${mergeTierRo.map((c) => c.label).join(', ')}`,
  );
});

// ============================================================
// (i) fixes=1 + changed-files-final null → reverified のまま（fail-open）
// ============================================================

test('[final-reconcile] (i) fixes=1 + changed-files-final null → reverified 維持（fail-open）', async () => {
  const { ctx } = makeSandbox({
    fixesApplied: 1,
    overrides: { 'changed-files-final': null },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'i');
  assert.ok(result !== null, '(i) workflow は return object を返すべきだが null だった');

  assert.equal(result?.final_reconcile, 'reverified', `(i) changed-files-final 取得失敗でも final_reconcile は 'reverified' のままのはずだが ${JSON.stringify(result?.final_reconcile)}`);
});

// ============================================================
// (j) fixes=1 + test#final throw(EPERM) → run 完走 + unavailable + HOLD（AC-4 throw fail-safe）
// ============================================================

test("[final-reconcile] (j) fixes=1 + test#final throw(EPERM) → run 完走 + final_reconcile unavailable + HOLD", async () => {
  const { ctx, calls } = makeSandbox({
    fixesApplied: 1,
    overrides: {
      'test#final': () => { throw new Error('EPERM: operation not permitted (vitest node_modules/.vite-temp)'); },
    },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);

  assert.equal(error, null, `(j) test#final の throw で run 全体が abort してはならないが error が発生: ${error?.message}`);
  assert.ok(result !== null, '(j) workflow は return object を返すべきだが null だった（run 全体が死んだことを示す）');
  assert.equal(result?.final_reconcile, 'unavailable', `(j) final_reconcile は 'unavailable' のはずだが ${JSON.stringify(result?.final_reconcile)}`);
  assert.equal(result?.merge_tier, 'HOLD', `(j) merge_tier は HOLD のはずだが ${JSON.stringify(result?.merge_tier)}`);
  assert.ok(
    (result?.merge_tier_reasons ?? []).some((r) => r.includes('Final reconcile 再検証不能')),
    `(j) merge_tier_reasons に 'Final reconcile 再検証不能' が含まれるはずだが ${JSON.stringify(result?.merge_tier_reasons)}`,
  );
  // issue #600 レビュー指摘: test#final の throw でも Step3 は skip しない。
  assert.ok(calls.some((c) => c.label === 'changed-files-final'), "(j) test#final が throw しても 'changed-files-final' は呼ばれるはず");
});

// ============================================================
// (l) fixes=1 + test#final tests:'error'（起動失敗） → unavailable + final_test_green null + HOLD
//     （'final test red' を含まない）（issue #619）
// ============================================================

test("[final-reconcile] (l) fixes=1 + test#final tests:'error'（起動失敗）→ unavailable + final_test_green null + HOLD（'final test red' を含まない）", async () => {
  const { ctx, calls } = makeSandbox({
    fixesApplied: 1,
    overrides: { 'test#final': { tests: 'error', green: false, summary: 'pnpm: command not found — テストは 1 件も実行されていない' } },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'l');
  assert.equal(error, null, `(l) run 全体が abort してはならないが error が発生: ${error?.message}`);
  assert.ok(result !== null, '(l) workflow は return object を返すべきだが null だった');

  assert.ok(calls.some((c) => c.label === 'test#final'), "(l) 'test#final' が呼ばれるはず");
  assert.equal(result?.final_reconcile, 'unavailable', `(l) final_reconcile は 'unavailable' のはずだが ${JSON.stringify(result?.final_reconcile)}`);
  assert.equal(result?.final_test_green, null, `(l) final_test_green は null のはずだが ${JSON.stringify(result?.final_test_green)}`);
  assert.equal(result?.merge_tier, 'HOLD', `(l) merge_tier は HOLD のはずだが ${JSON.stringify(result?.merge_tier)}`);
  assert.ok(
    (result?.merge_tier_reasons ?? []).some((r) => r.includes('Final reconcile 再検証不能')),
    `(l) merge_tier_reasons に 'Final reconcile 再検証不能' が含まれるはずだが ${JSON.stringify(result?.merge_tier_reasons)}`,
  );
  assert.ok(
    !(result?.merge_tier_reasons ?? []).some((r) => r.includes('final test red')),
    `(l) 起動失敗は本物の red ではないため merge_tier_reasons に 'final test red' を含んではならないが ${JSON.stringify(result?.merge_tier_reasons)}`,
  );
  // Step3（changed-files-final）は test#final の成否に依らず sync 成功時に実行される（issue #600）
  assert.ok(calls.some((c) => c.label === 'changed-files-final'), "(l) tests:'error' でも 'changed-files-final' は呼ばれるはず");
});

// ============================================================
// (m) fixes=1 + test#final tests:'failed'（本物の red） → reverified + final_test_green false + HOLD
//     （回帰: 'error' 分離後も failed 経路は不変, issue #619）
// ============================================================

test("[final-reconcile] (m) fixes=1 + test#final tests:'failed'（本物の red）→ reverified + final_test_green false + HOLD + 'final test red'（回帰）", async () => {
  const { ctx, calls } = makeSandbox({
    fixesApplied: 1,
    overrides: { 'test#final': { tests: 'failed', green: false, summary: '3 tests failed' } },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'm');
  assert.ok(result !== null, '(m) workflow は return object を返すべきだが null だった');

  assert.equal(result?.final_reconcile, 'reverified', `(m) final_reconcile は 'reverified' のはずだが ${JSON.stringify(result?.final_reconcile)}`);
  assert.equal(result?.final_test_green, false, `(m) final_test_green は false のはずだが ${JSON.stringify(result?.final_test_green)}`);
  assert.equal(result?.merge_tier, 'HOLD', `(m) merge_tier は HOLD のはずだが ${JSON.stringify(result?.merge_tier)}`);
  assert.ok(
    (result?.merge_tier_reasons ?? []).some((r) => r.includes('final test red')),
    `(m) merge_tier_reasons に 'final test red' が含まれるはずだが ${JSON.stringify(result?.merge_tier_reasons)}`,
  );
  assert.ok(!calls.some((c) => c.label === 'ci-final'), "(m) 本物の red（reverified 経路）では CI 委譲 'ci-final' を起動してはならない（fail-closed 維持）");
});

// ============================================================
// (n)〜(p) test#final の red を落ちたファイルだけの単体再実行で flake と本物の red に分ける（issue #865）
// ============================================================

const FLAKY_FIRST = {
  tests: 'failed', green: false,
  summary: 'failed: /tmp/wt/tests/run-all-bats.sh (exit 1, log: /tmp/run-tests-x/0.log)\n--- /tmp/wt/tests/run-all-bats.sh\nnot ok 7 TW-i jq-absent fallback',
  failed_files: ['plugins/dev-flow/_shared/scripts/diff-risk-classify.bats'],
};

function summaryBodyOf(calls) {
  const post = calls.find((c) => c.label === 'post-summary');
  assert.ok(post, "'post-summary' が呼ばれるはず");
  return post.prompt.slice(post.prompt.indexOf('<<<DEV_FLOW_BODY_BEGIN>>>'), post.prompt.indexOf('<<<DEV_FLOW_BODY_END>>>'));
}

test("[final-reconcile] (n) test#final red + failed_files の単体再実行 green → flake: final_test_red なし・final_test_flaky 記録・サマリーに「修正が必要」なし", async () => {
  const { ctx, calls } = makeSandbox({
    fixesApplied: 1,
    overrides: {
      'test#final': FLAKY_FIRST,
      'test#final-rerun': { tests: 'passed', green: true, summary: 'passed' },
    },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'n');
  assert.equal(error, null, `(n) run は完走するはずだが ${error?.message}`);

  // 再実行は落ちたファイルだけを渡す run-tests --files の 1 回（全件の再実行はしない）
  const reruns = calls.filter((c) => c.label === 'test#final-rerun');
  assert.equal(reruns.length, 1, `(n) test#final-rerun は 1 回だけ呼ばれるはずだが ${reruns.length} 回`);
  assert.equal(reruns[0].agentType, 'dev-flow:dev-runner-haiku');
  assert.equal(reruns[0].prompt.split('\n').at(-1), 'run-tests /tmp/wt --files plugins/dev-flow/_shared/scripts/diff-risk-classify.bats');
  assert.equal(calls.filter((c) => c.label === 'test#final').length, 1, '(n) test#final 自体は 1 回のまま');

  assert.equal(result?.final_reconcile, 'reverified');
  assert.equal(result?.final_test_green, true, `(n) final_test_green は true のはずだが ${JSON.stringify(result?.final_test_green)}`);
  assert.deepEqual(JSON.parse(JSON.stringify(result?.final_test_flaky)), {
    files: ['plugins/dev-flow/_shared/scripts/diff-risk-classify.bats'],
    logs: ['/tmp/run-tests-x/0.log'],
  });
  assert.equal(result?.merge_tier, 'REVIEW', `(n) merge_tier は REVIEW のはずだが ${JSON.stringify(result?.merge_tier_reasons)}`);
  assert.ok(!(result?.merge_tier_hold_reasons ?? []).some((r) => r.code === 'final_test_red'), JSON.stringify(result?.merge_tier_hold_reasons));
  assert.ok(!(result?.merge_tier_reasons ?? []).some((r) => r.includes('final test red')), JSON.stringify(result?.merge_tier_reasons));

  // 終端サマリー: 結論行・HOLD 理由欄に「修正が必要」が出ず、テスト欄が flake を示す
  const body = summaryBodyOf(calls);
  const conclusion = body.split('\n').find((l) => l.startsWith('**結論: '));
  assert.ok(conclusion && !conclusion.includes('修正作業が必要'), `(n) 結論行: ${conclusion}`);
  assert.ok(!body.includes('修正が必要'), `(n) サマリーに「修正が必要」が出てはならない:\n${body}`);
  const glance = body.split('\n').find((l) => l.startsWith('| ') && /\*\*(HOLD|REVIEW|AUTO)\*\*/.test(l));
  assert.equal(glance.split('|').slice(1, -1).map((s) => s.trim())[2], '⚠️ flake（単体再実行で green）');
  assert.ok(body.includes('final test flake（単体再実行で green）: plugins/dev-flow/_shared/scripts/diff-risk-classify.bats'), '(n) 参考に flake の開示行（ファイル）が出る');

  // telemetry: flake の run だけ final_test_flaky を載せる
  const handoff = calls.find((c) => c.label === 'journal-log');
  const m = handoff?.prompt.match(/<<<JOURNAL_HANDOFF_BODY_BEGIN>>>\n([\s\S]*?)\n<<<JOURNAL_HANDOFF_BODY_END>>>/);
  assert.ok(m, "(n) 'journal-log' の handoff body が見つからない");
  assert.deepEqual(JSON.parse(m[1]).telemetry?.final_test_flaky, {
    files: ['plugins/dev-flow/_shared/scripts/diff-risk-classify.bats'],
    logs: ['/tmp/run-tests-x/0.log'],
  });
});

test("[final-reconcile] (o) 単体再実行でも red / 応答なし / throw → 従来どおり final_test_red で HOLD", async () => {
  const variants = {
    red: { tests: 'failed', green: false, summary: 'still red', failed_files: FLAKY_FIRST.failed_files },
    null: null,
    throw: () => { throw new Error('EPERM'); },
    error: { tests: 'error', green: false, summary: 'run-tests did not return JSON' },
  };
  for (const [name, rerun] of Object.entries(variants)) {
    const { ctx, calls } = makeSandbox({
      fixesApplied: 1,
      overrides: { 'test#final': FLAKY_FIRST, 'test#final-rerun': rerun },
    });
    const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
    assertNoCrash(error, `o-${name}`);
    assert.equal(error, null, `(o-${name}) run は完走するはずだが ${error?.message}`);
    assert.equal(calls.filter((c) => c.label === 'test#final-rerun').length, 1, `(o-${name}) 再実行は 1 回だけ`);
    assert.equal(result?.final_test_green, false, `(o-${name}) final_test_green は false のはず`);
    assert.equal(result?.final_test_flaky, null, `(o-${name}) final_test_flaky は null のはず`);
    assert.equal(result?.merge_tier, 'HOLD', `(o-${name}) merge_tier は HOLD のはず`);
    assert.ok((result?.merge_tier_hold_reasons ?? []).some((r) => r.code === 'final_test_red'), `(o-${name}) ${JSON.stringify(result?.merge_tier_hold_reasons)}`);
    assert.ok(summaryBodyOf(calls).includes('修正が必要'), `(o-${name}) final_test_red の HOLD は「修正が必要」のまま`);
  }
});

test("[final-reconcile] (p) failed_files が空（ビルド失敗・結び付かない失敗）/ 安全に渡せないパスの red は再実行せず final_test_red で HOLD", async () => {
  for (const [name, failed_files] of Object.entries({ empty: [], missing: undefined, unsafe: ['a.bats', 'b c.bats'] })) {
    const first = { tests: 'failed', green: false, summary: 'workspace build failed', ...(failed_files ? { failed_files } : {}) };
    const { ctx, calls } = makeSandbox({ fixesApplied: 1, overrides: { 'test#final': first } });
    const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
    assertNoCrash(error, `p-${name}`);
    assert.ok(!calls.some((c) => c.label === 'test#final-rerun'), `(p-${name}) test#final-rerun を呼んではならない`);
    assert.equal(result?.final_test_green, false);
    assert.equal(result?.final_test_flaky, null);
    assert.equal(result?.merge_tier, 'HOLD');
    assert.ok((result?.merge_tier_hold_reasons ?? []).some((r) => r.code === 'final_test_red'), `(p-${name}) ${JSON.stringify(result?.merge_tier_hold_reasons)}`);
  }
});
