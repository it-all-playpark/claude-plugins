// pr-body-sync-routing.test.mjs — PR body の Closes 行検証 / 再投入 / merge tier HOLD と
// Final AC reconcile 後の AC checkbox 同期を dev-flow.js を VM 実行して観測する（issue #661 F3）。
// Closes 有無は Merge tier の merge-tier-facts の closes サブ結果（スクリプトが本文を true / false に畳んだ値）で
// 判定し、PR phase の closes-check / closes-recheck spawn は持たない（issue #824）。
//
// pr-artifacts.test.mjs 末尾の routing test（PR body verbatim 転写）と同型: dev-flow.js を strip して
// vm sandbox で実行し、agent() に実際に渡った {label, agentType, prompt, opts} を観測する。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash, mergeTierFacts } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const devFlowSrc = readFileSync(join(here, '..', '.claude', 'workflows', 'dev-flow.js'), 'utf8');

async function run(overrides = {}, workflow) {
  const { ctx, calls } = makeDevFlowSandbox({ overrides, workflow });
  const { result, error } = await runWorkflowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'pr-body-sync-routing');
  assert.equal(error, null, `dev-flow run が throw した: ${error?.message}`);
  return { result, calls };
}

const FACTS_CMD = '`merge-tier-facts --worktree /tmp/wt --base origin/main --pr 1 --issue 1`';
const CLOSES_CHECK = '`pr-closes-check --pr 1 --issue 1`';
const closesMissing = { 'merge-tier-facts': mergeTierFacts({ closes: false }) };

// ---- 1. 既定 run: closes サブ結果 present → 'verified'、Closes 専用 spawn なし ----

test('[pr-body-sync-routing] 既定 run: closes-check / closes-recheck / closes-reinject の spawn は無く、merge-tier-facts の closes で pr_closes_status=verified', async () => {
  const { result, calls } = await run();

  for (const label of ['closes-check', 'closes-recheck', 'closes-reinject']) {
    assert.equal(calls.filter((c) => c.label === label).length, 0, `${label} は呼ばれないはず`);
  }
  // PR phase の spawn は diff-hash-pr と PR 作成 proxy だけで、PR body を読み直す spawn を持たない
  const prPhase = calls.filter((c) => c.opts?.phase === 'PR');
  assert.deepEqual(prPhase.map((c) => c.label), ['diff-hash-pr', 'pr#1'], `PR phase の spawn: ${prPhase.map((c) => c.label).join(', ')}`);
  assert.ok(!prPhase.some((c) => c.prompt.includes('--json body')), 'PR phase に gh pr view --json body が残っている');

  const facts = calls.filter((c) => c.label === 'merge-tier-facts');
  assert.equal(facts.length, 1);
  assert.equal(facts[0].opts.phase, 'Merge tier');
  // Closes の判定に要る issue 番号は --issue で渡し、本文の読み取りと判定はスクリプトが行う（issue #1311）
  assert.ok(facts[0].prompt.includes(FACTS_CMD), `merge-tier-facts prompt に --pr / --issue の bare 単文が無い:\n${facts[0].prompt}`);
  for (const banned of ['--jq', '--closes-data', '--json body']) {
    assert.ok(!facts[0].prompt.includes(banned), `merge-tier-facts prompt に ${banned} が残っている`);
  }

  assert.equal(result?.pr_closes_status, 'verified');
  assert.notEqual(result?.merge_tier, 'HOLD');
});

// ---- 2. Closes 欠落 → Merge tier の closes-reinject で再投入 + 同じ spawn で再取得 → 'reinjected' ----

test('[pr-body-sync-routing] Closes 欠落 → Merge tier の closes-reinject 1 spawn で再投入・再取得 → pr_closes_status=reinjected', async () => {
  const { result, calls } = await run(closesMissing);

  const reinject = calls.filter((c) => c.label === 'closes-reinject');
  assert.equal(reinject.length, 1, `closes-reinject は 1 回のはずだが ${reinject.length} 回`);
  assert.equal(reinject[0].agentType, 'dev-flow:dev-runner-haiku');
  assert.equal(reinject[0].opts.phase, 'Merge tier');
  assert.ok(calls.indexOf(reinject[0]) > calls.findIndex((c) => c.label === 'merge-tier-facts'), 'closes-reinject は merge-tier-facts の後');
  assert.ok(reinject[0].prompt.includes('gh pr edit 1'), 'closes-reinject prompt に gh pr edit 1 が無い');
  assert.ok(reinject[0].prompt.includes('--body-file /tmp/wt/.devflow-tmp/pr-body-reinject.md'), 'closes-reinject prompt に --body-file 指示が無い');
  assert.ok(reinject[0].prompt.includes('<<<PR_BODY_BEGIN>>>'), 'closes-reinject prompt に PR_BODY delimiter が無い');
  assert.ok(reinject[0].prompt.includes('Closes #1\n<<<PR_BODY_END>>>'), 'closes-reinject prompt の本文が Closes #1 で終わらない');
  assert.ok(reinject[0].prompt.includes(CLOSES_CHECK), `再投入後の Closes 再確認（pr-closes-check）が同じ spawn に無い:\n${reinject[0].prompt}`);
  assert.ok(!reinject[0].prompt.includes('--jq'), 'closes-reinject prompt に --jq が残っている');

  assert.equal(calls.filter((c) => c.label === 'closes-recheck').length, 0, 'closes-recheck は呼ばれないはず');
  assert.equal(result?.pr_closes_status, 'reinjected');
  assert.notEqual(result?.merge_tier, 'HOLD');
});

// ---- 3. Closes 欠落 + 再投入失敗（edited:false）→ 'missing' → HOLD ----

test('[pr-body-sync-routing] Closes 欠落 + 再投入失敗 → pr_closes_status=missing、merge_tier=HOLD（pr_closes_missing）', async () => {
  const { result } = await run({ ...closesMissing, 'closes-reinject': { edited: false } });

  assert.equal(result?.pr_closes_status, 'missing');
  assert.equal(result?.merge_tier, 'HOLD');
  assert.ok(
    Array.isArray(result?.merge_tier_hold_reasons) && result.merge_tier_hold_reasons.some((r) => r.code === 'pr_closes_missing'),
    `merge_tier_hold_reasons に pr_closes_missing が無い: ${JSON.stringify(result?.merge_tier_hold_reasons)}`,
  );
});

// ---- 4. Closes 欠落 + 再投入成功だが再取得でも依然欠落 → 'missing' → HOLD ----

test('[pr-body-sync-routing] 再投入後も Closes 欠落のまま → pr_closes_status=missing、merge_tier=HOLD', async () => {
  const { result } = await run({ ...closesMissing, 'closes-reinject': { edited: true, closes: 'false' } });

  assert.equal(result?.pr_closes_status, 'missing');
  assert.equal(result?.merge_tier, 'HOLD');
});

// ---- 4b. 再投入は通ったが再取得に失敗 → 'unverified'（再取得の失敗を欠落と同一視しない） ----

test('[pr-body-sync-routing] 再投入成功 + 再取得失敗 → pr_closes_status=unverified、HOLD にならない', async () => {
  const { result } = await run({ ...closesMissing, 'closes-reinject': { edited: true } });

  assert.equal(result?.pr_closes_status, 'unverified');
  assert.notEqual(result?.merge_tier, 'HOLD');
});

// ---- 5. closes サブ結果の取得失敗 → 再投入せず 'unverified'、HOLD にしない（fail-open） ----

test('[pr-body-sync-routing] closes サブ結果の取得失敗 → closes-reinject 未呼出、pr_closes_status=unverified、HOLD にならない', async () => {
  const { result, calls } = await run({ 'merge-tier-facts': mergeTierFacts({ closes: null }) });

  assert.equal(calls.filter((c) => c.label === 'closes-reinject').length, 0, 'closes-reinject は呼ばれないはず');
  assert.equal(result?.pr_closes_status, 'unverified');
  assert.notEqual(result?.merge_tier, 'HOLD');
});

// ---- 5b. Final reconcile が本文を組み直した run の再投入は組み直した本文を使う ----

test('[pr-body-sync-routing] ac-checkbox-sync 後に Closes 欠落 → 再投入本文は Final AC reconcile 結果の本文', async () => {
  const { calls } = await run(
    {
      ...closesMissing,
      'reconcile-sync': { ok: true, head: 'a'.repeat(40) },
      'final-ac-reconcile': {
        ac_results: [
          { ac_index: 0, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
          { ac_index: 1, satisfied: false, verified_by: 'inspection', evidence: 'ng' },
        ],
        item_resolutions: [],
      },
    },
    async () => ({ status: 'lgtm', iterations: 2, fixes_applied: 1 }),
  );

  const reinject = calls.find((c) => c.label === 'closes-reinject');
  assert.ok(reinject, 'closes-reinject が呼ばれていない');
  assert.ok(reinject.prompt.includes('- [x] a\n- [ ] b'), `再投入本文が Final AC reconcile 結果を反映していない:\n${reinject.prompt}`);
});

// ---- 6. AC checkbox 同期: fix 適用 + lgtm 終端 + Final AC reconcile reverified ----

test('[pr-body-sync-routing] fix 適用 + lgtm + Final AC reconcile reverified → ac-checkbox-sync が PR body を再生成して gh pr edit', async () => {
  const { result, calls } = await run(
    {
      'reconcile-sync': { ok: true, head: 'a'.repeat(40) },
      'final-ac-reconcile': {
        ac_results: [
          { ac_index: 0, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
          { ac_index: 1, satisfied: false, verified_by: 'inspection', evidence: 'ng' },
        ],
        item_resolutions: [],
      },
    },
    async () => ({ status: 'lgtm', iterations: 2, fixes_applied: 1 }),
  );

  const sync = calls.filter((c) => c.label === 'ac-checkbox-sync');
  assert.equal(sync.length, 1, `ac-checkbox-sync は 1 回のはずだが ${sync.length} 回`);
  assert.equal(sync[0].agentType, 'dev-flow:dev-runner-haiku');
  assert.equal(sync[0].opts.phase, 'Final reconcile');
  assert.ok(sync[0].prompt.includes('- [x] a\n- [ ] b'), `ac-checkbox-sync prompt に AC checkbox の充足状況が反映されていない:\n${sync[0].prompt}`);
  assert.ok(sync[0].prompt.includes('gh pr edit 1'), 'ac-checkbox-sync prompt に gh pr edit 1 が無い');
  assert.ok(sync[0].prompt.includes('--body-file /tmp/wt/.devflow-tmp/pr-body-final.md'), 'ac-checkbox-sync prompt に --body-file 指示が無い');
  assert.ok(sync[0].prompt.includes('Closes #1'), 'ac-checkbox-sync prompt の本文に Closes #1 が無い');

  assert.equal(result?.pr_body_synced, true);
});

// ---- 7. AC checkbox 同期が起動しないケース ----

test('[pr-body-sync-routing] fixes_applied=0（既定 run）では ac-checkbox-sync は呼ばれず pr_body_synced=null', async () => {
  const { result, calls } = await run();
  assert.equal(calls.filter((c) => c.label === 'ac-checkbox-sync').length, 0);
  assert.equal(result?.pr_body_synced, null);
});

test('[pr-body-sync-routing] fixes_applied>0 でも Final AC reconcile が unavailable なら ac-checkbox-sync は呼ばれない', async () => {
  const { result, calls } = await run(
    {
      'reconcile-sync': { ok: true, head: 'a'.repeat(40) },
      'final-ac-reconcile': null,
    },
    async () => ({ status: 'lgtm', iterations: 2, fixes_applied: 1 }),
  );
  assert.equal(calls.filter((c) => c.label === 'ac-checkbox-sync').length, 0);
  assert.equal(result?.pr_body_synced, null);
});

// ---- 8. ac-checkbox-sync 失敗は fail-open ----

test('[pr-body-sync-routing] ac-checkbox-sync が edited:false を返しても run は throw せず merge_tier は HOLD にならない', async () => {
  const { result } = await run(
    {
      'reconcile-sync': { ok: true, head: 'a'.repeat(40) },
      'final-ac-reconcile': {
        ac_results: [
          { ac_index: 0, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
          { ac_index: 1, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
        ],
        item_resolutions: [],
      },
      'ac-checkbox-sync': { edited: false },
    },
    async () => ({ status: 'lgtm', iterations: 2, fixes_applied: 1 }),
  );

  assert.equal(result?.pr_body_synced, false);
  assert.notEqual(result?.merge_tier, 'HOLD');
});
