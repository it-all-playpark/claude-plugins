// pr-iterate の LGTM 確定前の base conflict 自動解消（issue #916）の経路を VM 挙動で pin する。
//
// [routing] CI gate 通過後に mergeable が CONFLICTING → conflict-resolve（fetch → conflict-autoresolve → pr-push）→
//           次 iteration の review（remerge-diff の範囲）→ CI gate → mergeable 再確認 → lgtm の順に進む
// [unresolved] 自動解消できない conflict では lgtm 確定経路が conflict の無い run と同じで、dev-flow の Merge tier は
//           mergeable_conflicting で HOLD になり、HOLD 理由の横に止めたファイルと型が出る
// [nested]  dev-flow から nested 起動した pr-iterate が自動解消した run は Final reconcile が skipped にならない
// [mergeable] UNKNOWN・取得失敗では conflict-resolve を起動しない
//
// conflict-autoresolve スクリプト自体の型判定は _shared/scripts/conflict-autoresolve.bats が pin する。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makePrIterateSandbox, makeDevFlowSandbox, runWorkflowCapture, assertNoCrash, ciCounts, mergeTierFacts } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const prIterateSrc = readFileSync(join(here, '..', '.claude', 'workflows', 'pr-iterate.js'), 'utf8');
const devFlowSrc = readFileSync(join(here, '..', '.claude', 'workflows', 'dev-flow.js'), 'utf8');

const HEAD1 = '1'.repeat(40);
const MERGE = '3'.repeat(40);
const NESTED = { caller: 'dev-flow', cwd: '/tmp/wt', head_ref: 'feature/x', base_ref: 'main', head_sha: HEAD1, repo: 'acme/skills' };

const ci = (status, head_sha) => ({ status, ...ciCounts(status), failed_checks: [], ...(head_sha ? { head_sha } : {}) });
const CONFLICTING = { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' };
const MERGEABLE = { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' };
const resolved = (files) => ({
  fetched: true, pushed: true,
  result: { status: 'resolved', reason: '', base_ref: 'origin/main', head_before: HEAD1, head_after: MERGE, restored: false, files },
});
const ABORTED = {
  fetched: true, pushed: false,
  result: {
    status: 'aborted', reason: 'unsupported_conflict', base_ref: 'origin/main', head_before: HEAD1, head_after: HEAD1, restored: true,
    files: [{ path: 'README.md', type: 'A' }, { path: 'tests/a.bats', type: 'content' }],
  },
};

// 自動解消して push する run の応答（iteration 1 で CONFLICTING → 解消、iteration 2 で MERGEABLE）
const RESOLVE_RUN = {
  'ci-check#1': ci('passed', HEAD1),
  'mergeable-check#1': CONFLICTING,
  'conflict-resolve#1': resolved([{ path: 'README.md', type: 'A' }]),
  'ci-check#2': ci('passed', MERGE),
  'mergeable-check#2': MERGEABLE,
};

async function runPrIterate(overrides, args = { pr: 5, nested: NESTED }) {
  const { ctx, calls, logs } = makePrIterateSandbox({ overrides, args });
  const { result, error } = await runWorkflowCapture(prIterateSrc, ctx, '.claude/workflows/pr-iterate.js');
  assertNoCrash(error, 'priterate-conflict-autoresolve');
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  return { result: JSON.parse(JSON.stringify(result)), calls, logs, labels: calls.map((c) => c.label) };
}

const ROUND_LABEL = /^(review#|ci-check#|ci-wait-check#|mergeable-check#|conflict-resolve#|fix#|commit-ensure#)/;

// ---- [routing] ----
test('[routing] CI gate 通過後に mergeable が CONFLICTING なら conflict-resolve で解消・push し、次 iteration の review（remerge-diff）→ CI gate → mergeable 再確認を経て lgtm', async () => {
  const { result, calls, labels } = await runPrIterate(RESOLVE_RUN);

  assert.deepEqual(
    labels.filter((l) => ROUND_LABEL.test(l)),
    ['review#1', 'ci-check#1', 'mergeable-check#1', 'conflict-resolve#1', 'review#2', 'ci-check#2', 'mergeable-check#2'],
    `spawn の順序が想定と異なる: ${JSON.stringify(labels)}`,
  );
  const mg = calls.find((c) => c.label === 'mergeable-check#1');
  assert.equal(mg.agentType, 'dev-flow:dev-runner-haiku-ro');
  assert.ok(mg.prompt.includes('gh pr view 5 --repo acme/skills --json mergeable,mergeStateStatus'), mg.prompt);

  const resolve = calls.find((c) => c.label === 'conflict-resolve#1');
  assert.equal(resolve.agentType, 'dev-flow:dev-runner-haiku');
  for (const step of ['`git fetch origin main`', '`conflict-autoresolve --worktree /tmp/wt --base-ref origin/main`', '`pr-push start /tmp/wt/.devflow-tmp/push-output.log`']) {
    assert.ok(resolve.prompt.includes(step), `conflict-resolve#1 の prompt に ${step} が無い:\n${resolve.prompt}`);
  }

  const review2 = calls.find((c) => c.label === 'review#2');
  assert.ok(review2.prompt.includes(`git show --remerge-diff ${MERGE}`), `review#2 が remerge-diff の範囲に絞られていない:\n${review2.prompt}`);
  assert.ok(!review2.prompt.includes('gh pr diff'), 'review#2 に PR 全 diff を読ませている');
  assert.ok(!labels.includes('ci-check#2-serial'), 'merge commit の head で取った並列 ci-check#2 を採用できるはず');

  assert.equal(result.status, 'lgtm');
  assert.equal(result.iterations, 2);
  assert.equal(result.fixes_applied, 1, '自動解消の merge commit を fixes_applied に数える');
  assert.deepEqual(result.history.map((h) => [h.iteration, h.scope]), [[1, 'full'], [2, 'remerge']]);
  assert.deepEqual(result.conflict_autoresolve, [{ iteration: 1, status: 'resolved', reason: '', files: [{ path: 'README.md', type: 'A' }], merge_sha: MERGE }]);
});

test('[routing] 単体起動の終端サマリーに自動解消の型とファイルが出る', async () => {
  const args = { pr: 5, nested: { ...NESTED, caller: 'standalone' } };
  const { calls } = await runPrIterate(RESOLVE_RUN, args);
  const post = calls.find((c) => c.label === 'post-summary');
  assert.ok(post, 'post-summary が起動されていない');
  assert.ok(post.prompt.includes('base との conflict の自動解消'), post.prompt);
  assert.ok(post.prompt.includes('`README.md`（型 A）'), `終端サマリーに解消した型とファイルが無い:\n${post.prompt}`);
});

// ---- [unresolved] ----
test('[unresolved] 自動解消できない conflict では lgtm 確定経路が conflict の無い run と同じ（review は 1 回・push なし・fixes_applied 0）', async () => {
  const baseline = await runPrIterate({ 'ci-check#1': ci('passed', HEAD1), 'mergeable-check#1': MERGEABLE });
  const { result, labels } = await runPrIterate({ 'ci-check#1': ci('passed', HEAD1), 'mergeable-check#1': CONFLICTING, 'conflict-resolve#1': ABORTED });

  assert.deepEqual(labels.filter((l) => ROUND_LABEL.test(l)), ['review#1', 'ci-check#1', 'mergeable-check#1', 'conflict-resolve#1']);
  for (const key of ['status', 'iterations', 'fixes_applied', 'last_decision', 'history', 'terminal_path', 'fix_terminal_reason']) {
    assert.deepEqual(result[key], baseline.result[key], `${key} が conflict の無い run と異なる`);
  }
  assert.equal(result.status, 'lgtm');
  assert.equal(result.conflict_autoresolve[0].status, 'aborted');
});

test('[unresolved] 解けなかった conflict は dev-flow の Merge tier で mergeable_conflicting の HOLD になり、HOLD 理由の横に止めたファイルと型が出る', async () => {
  const { result: iterate } = await runPrIterate({ 'ci-check#1': ci('passed', HEAD1), 'mergeable-check#1': CONFLICTING, 'conflict-resolve#1': ABORTED });
  const { ctx, calls } = makeDevFlowSandbox({
    workflow: async () => iterate,
    overrides: { 'merge-tier-facts': mergeTierFacts({ pr: { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', headRefOid: 'a'.repeat(40) } }) },
  });
  const { result, error } = await runWorkflowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'dev-flow');

  assert.equal(result?.merge_tier, 'HOLD');
  assert.ok(result.merge_tier_hold_reasons.some((r) => r.code === 'mergeable_conflicting'), JSON.stringify(result.merge_tier_hold_reasons));
  const post = calls.find((c) => c.label === 'post-summary');
  const row = post.prompt.split('\n').find((l) => l.includes('base branch と conflict（自動解消せず'));
  assert.ok(row, `HOLD 理由の行に自動解消しなかった旨が無い:\n${post.prompt}`);
  assert.ok(row.includes('`tests/a.bats`（content）'), `止めたファイルと型が HOLD 理由の行に無い: ${row}`);
  assert.ok(!row.includes('README.md'), `型 A のファイルは止めたファイルに含めない: ${row}`);
});

// ---- [nested] ----
test('[nested] dev-flow から nested 起動した pr-iterate が自動解消した run は Final reconcile が skipped にならない', async () => {
  const iterateArgs = [];
  const { ctx, calls } = makeDevFlowSandbox({
    workflow: async (_name, wfArgs) => {
      const args = JSON.parse(JSON.stringify(wfArgs));
      iterateArgs.push(args);
      return (await runPrIterate({ ...RESOLVE_RUN, 'ci-check#1': ci('passed') }, args)).result;
    },
    overrides: { 'reconcile-sync': { ok: true, head: MERGE } },
  });
  const { result, error } = await runWorkflowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'dev-flow nested');

  assert.equal(iterateArgs[0]?.nested?.base_ref, 'main', 'dev-flow は base branch 名を nested.base_ref で渡す');
  const labels = calls.map((c) => c.label);
  assert.ok(labels.includes('reconcile-sync') && labels.includes('test#final'), `Final reconcile が走っていない: ${JSON.stringify(labels)}`);
  assert.notEqual(result?.final_reconcile, 'skipped');
  assert.equal(result?.final_reconcile, 'reverified');
  const post = calls.find((c) => c.label === 'post-summary');
  assert.ok(post.prompt.includes('base との conflict を自動解消した（pr-iterate 反復 1・merge commit `3333333`）: `README.md`（型 A）'), post.prompt);
});

// ---- [mergeable] ----
for (const [name, response] of [['UNKNOWN', { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }], ['null', null], ['throw', () => { throw new Error('stub'); }]]) {
  test(`[mergeable] mergeable-check が ${name} なら conflict-resolve を起動せず lgtm`, async () => {
    const { result, labels } = await runPrIterate({ 'ci-check#1': ci('passed', HEAD1), 'mergeable-check#1': response });
    assert.ok(labels.includes('mergeable-check#1'));
    assert.ok(!labels.some((l) => l.startsWith('conflict-resolve#')), JSON.stringify(labels));
    assert.equal(result.status, 'lgtm');
    assert.deepEqual(result.conflict_autoresolve, []);
  });
}

test('[mergeable] 解消した merge commit を push できなければ lgtm にせず fix_failed で終える', async () => {
  const { result, labels } = await runPrIterate({
    'ci-check#1': ci('passed', HEAD1), 'mergeable-check#1': CONFLICTING,
    'conflict-resolve#1': { ...resolved([{ path: 'README.md', type: 'A' }]), pushed: false },
  });
  assert.ok(!labels.includes('review#2'));
  assert.equal(result.status, 'fix_failed');
  assert.equal(result.fix_terminal_reason, 'commit_unensured');
  assert.equal(result.conflict_autoresolve[0].status, 'push_failed');
});
