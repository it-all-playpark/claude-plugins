// pr-body-sync-routing.test.mjs — PR body の Closes 行検証 / 再投入 / merge tier HOLD と
// pr-iterate の修正後の PR 本文の作り直し（受入条件の結果の表と AC checkbox）を dev-flow.js を VM 実行して観測する（issue #661 F3）。
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
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash, mergeTierFacts, STANDARD_FILES } from './test-helpers/vm-sandbox.mjs';
import { PR_BODY_STALE_NOTE, PR_BODY_STALE_NOTE_WITH_DIAGRAM } from './devflow-summary-format.mjs';
import { PR_BODY_DIAGRAM_UNVERIFIED, PR_BODY_DIAGRAM_MISMATCH } from './pr-artifacts.mjs';

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

// prompt に verbatim で埋めた PR 本文。
function bodyOf(call) {
  const m = call.prompt.match(/<<<PR_BODY_BEGIN>>>\n([\s\S]*?)<<<PR_BODY_END>>>/);
  assert.ok(m, `${call.label} の prompt に PR 本文が無い`);
  return m[1];
}

// `## 受入条件の結果` の表のデータ行（最初の <details> より前にあること込みで取る）。
function acTable(body) {
  const head = '## 受入条件の結果\n| AC | 要旨 | 結果 | 根拠 |\n|---|---|---|---|\n';
  const i = body.indexOf(head);
  assert.ok(i >= 0 && i < body.indexOf('<details>'), `受入条件の結果の表が見える部分に無い:\n${body}`);
  const rows = [];
  for (const l of body.slice(i + head.length).split('\n')) {
    if (!l.startsWith('| ')) break;
    rows.push(l);
  }
  return rows;
}

const EVAL_AC = {
  verdict: 'pass', feedback: [], feedback_level: 'implementation', security_clearance: [], concern_resolutions: [],
  ac_results: [
    { ac_index: 0, gist: 'a の要旨', satisfied: true, verified_by: 'inspection', evidence: 'src/a.mjs:1' },
    { ac_index: 1, gist: 'b の要旨', satisfied: true, verified_by: 'inspection', evidence: 'src/b.mjs:2' },
  ],
};
const STALE_ROWS = ['| AC-1 | a の要旨 | ⚠️ 修正後に未再評価 | — |', '| AC-2 | b の要旨 | ⚠️ 修正後に未再評価 | — |'];

// ---- 0. PR phase: Evaluate の ac_results が PR 本文の受入条件の結果の表に出る（issue #1365） ----

test('[pr-body-sync-routing] PR phase の本文は Evaluate の ac_results を受入条件の結果の表に出す（satisfied の AC は ✅）', async () => {
  const { calls } = await run({ 'eval#1': EVAL_AC });
  const body = bodyOf(calls.find((c) => c.label === 'pr#1'));
  assert.deepEqual(acTable(body), ['| AC-1 | a の要旨 | ✅ | src/a.mjs:1 |', '| AC-2 | b の要旨 | ✅ | src/b.mjs:2 |']);
  assert.ok(body.includes('- [x] a\n- [x] b'), `<details> の checkbox が表と同じ結果になっていない:\n${body}`);
});

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
  // 表は修正前の Evaluate（既定応答は両 AC satisfied）ではなく finalAcResults で作る
  assert.deepEqual(acTable(bodyOf(sync[0])), ['| AC-1 | — | ✅ | ok |', '| AC-2 | — | ❌ | ng |']);

  assert.equal(result?.pr_body_synced, true);
  assert.ok(!calls.find((c) => c.label === 'post-summary').prompt.includes(PR_BODY_STALE_NOTE), '本文を更新できた run の終端サマリーに「修正前のまま」の行を出さない');
});

// ---- 7. AC checkbox 同期が起動しないケース ----

test('[pr-body-sync-routing] fixes_applied=0（既定 run）では ac-checkbox-sync は呼ばれず pr_body_synced=null', async () => {
  const { result, calls } = await run();
  assert.equal(calls.filter((c) => c.label === 'ac-checkbox-sync').length, 0);
  assert.equal(calls.filter((c) => c.prompt.includes('gh pr edit')).length, 0, 'PR 本文を書き換える spawn が無い');
  assert.equal(result?.pr_body_synced, null);
  assert.ok(!calls.find((c) => c.label === 'post-summary').prompt.includes(PR_BODY_STALE_NOTE));
});

// ---- 7b. 修正が入ったが AC を再検証していない run: 終了状態に依らず作り直し、結果を「修正後に未再評価」にする（issue #1365） ----

test('[pr-body-sync-routing] fixes_applied>0 + lgtm + Final AC reconcile unavailable → 作り直した本文の結果の列は ⚠️ 修正後に未再評価 だけ', async () => {
  const { result, calls } = await run(
    {
      'eval#1': EVAL_AC,
      'reconcile-sync': { ok: true, head: 'a'.repeat(40) },
      'final-ac-reconcile': null,
    },
    async () => ({ status: 'lgtm', iterations: 2, fixes_applied: 1 }),
  );
  assert.equal(result?.final_ac_reconcile, 'unavailable');
  const sync = calls.filter((c) => c.label === 'ac-checkbox-sync');
  assert.equal(sync.length, 1, `ac-checkbox-sync は 1 回のはずだが ${sync.length} 回`);
  const body = bodyOf(sync[0]);
  assert.deepEqual(acTable(body), STALE_ROWS);
  assert.ok(body.includes('- [ ] a\n- [ ] b'), `修正前の checkbox が残っている:\n${body}`);
  assert.ok(!body.includes('✅') && !body.includes('❌'), `修正前の ✅ / ❌ が残っている:\n${body}`);
  assert.ok(sync[0].prompt.includes('gh pr edit 1'));
  assert.equal(result?.pr_body_synced, true);
});

test('[pr-body-sync-routing] fixes_applied>0 + max_reached + Final AC reconcile skipped → 作り直した本文の結果の列は ⚠️ 修正後に未再評価 だけ', async () => {
  const { result, calls } = await run(
    { 'eval#1': EVAL_AC, 'reconcile-sync': { ok: false } },
    async () => ({ status: 'max_reached', iterations: 10, fixes_applied: 3 }),
  );
  assert.equal(result?.iterate_status, 'max_reached');
  assert.equal(result?.final_ac_reconcile, 'skipped');
  const sync = calls.filter((c) => c.label === 'ac-checkbox-sync');
  assert.equal(sync.length, 1, `ac-checkbox-sync は 1 回のはずだが ${sync.length} 回`);
  const body = bodyOf(sync[0]);
  assert.deepEqual(acTable(body), STALE_ROWS);
  assert.ok(body.includes('- [ ] a\n- [ ] b'), `修正前の checkbox が残っている:\n${body}`);
  assert.ok(!body.includes('✅') && !body.includes('❌'), `修正前の ✅ / ❌ が残っている:\n${body}`);
  assert.equal(result?.pr_body_synced, true);
});

// ---- 8. ac-checkbox-sync 失敗は fail-open ----

test('[pr-body-sync-routing] ac-checkbox-sync が edited:false を返しても run は throw せず merge_tier は HOLD にならず、終端サマリーに本文が修正前のままである旨を出す', async () => {
  const { result, calls } = await run(
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
  // 判断カードの「あなたが確かめること」（at-a-glance 表より前）に 1 行出る
  const summary = calls.find((c) => c.label === 'post-summary').prompt;
  const card = summary.slice(summary.indexOf('### あなたが確かめること'), summary.indexOf('| Merge tier |'));
  assert.ok(card.split('\n').includes(`- ${PR_BODY_STALE_NOTE}`), `「あなたが確かめること」に PR 本文が修正前のままである旨が無い:\n${card}`);
  assert.match(PR_BODY_STALE_NOTE, /PR 本文.*受入条件の結果.*修正前のまま/);
});

// ---- 9. 構成の変化の図: Evaluate の diagram_check を PR phase と修正後の作り直しまで渡す（issue #1366） ----

const DIAGRAM = { kind: 'flowchart', before: 'flowchart LR\n  A --> B', after: 'flowchart LR\n  A --> B\n  C --> B' };
const IMPL_DIAGRAM = { 'impl:serial:issue-1': { status: 'DONE', task_id: 'issue-1', files: [...STANDARD_FILES], summary: 's', concerns: [], diagram: DIAGRAM } };
const withDiagramCheck = (diagram_check) => ({ ...IMPL_DIAGRAM, 'eval#1': { ...EVAL_AC, diagram_check } });
const CONSISTENT = { consistent: true, mismatches: [] };
const MISMATCHED = { consistent: false, mismatches: ['after の C --> B は diff に無い'] };
const MERMAID_FENCE = '```mermaid';
const FIGURES = `**before**\n\n${MERMAID_FENCE}\n${DIAGRAM.before}\n\`\`\`\n\n**after**\n\n${MERMAID_FENCE}\n${DIAGRAM.after}\n\`\`\``;
const FIXED_RUNS = {
  lgtm: [
    {
      'reconcile-sync': { ok: true, head: 'a'.repeat(40) },
      'final-ac-reconcile': {
        ac_results: [
          { ac_index: 0, gist: 'a の要旨', satisfied: true, verified_by: 'inspection', evidence: 'ok' },
          { ac_index: 1, gist: 'b の要旨', satisfied: true, verified_by: 'inspection', evidence: 'ok' },
        ],
        item_resolutions: [],
      },
    },
    async () => ({ status: 'lgtm', iterations: 2, fixes_applied: 1 }),
  ],
  max_reached: [
    { 'reconcile-sync': { ok: false } },
    async () => ({ status: 'max_reached', iterations: 10, fixes_applied: 3 }),
  ],
};

function assertNoFigure(body) {
  assert.ok(!body.includes(MERMAID_FENCE), `食い違った図のフェンスが本文にある:\n${body}`);
  assert.ok(body.includes(`## 構成の変化\n${PR_BODY_DIAGRAM_MISMATCH}\n- ${MISMATCHED.mismatches[0]}\n\n`), `食い違いの表示が無い:\n${body}`);
  assert.equal(PR_BODY_DIAGRAM_MISMATCH, '⚠️ 図は diff と食い違ったため載せていない');
}

test('[pr-body-sync-routing] PR phase: Evaluate の diagram_check が一致なら本文に図のフェンスを出し、未照合・食い違いの注記を付けない', async () => {
  const { calls } = await run(withDiagramCheck(CONSISTENT));
  const body = bodyOf(calls.find((c) => c.label === 'pr#1'));
  assert.ok(body.includes(`## 構成の変化\n${FIGURES}\n\n`), `一致した図が本文に無い:\n${body}`);
  assert.ok(!body.includes('⚠️ 図は'), `一致した図に注記が付いている:\n${body}`);
});

test('[pr-body-sync-routing] PR phase: Evaluate の diagram_check が食い違いなら本文に図のフェンスを出さず、食い違いを出す', async () => {
  const { calls } = await run(withDiagramCheck(MISMATCHED));
  assertNoFigure(bodyOf(calls.find((c) => c.label === 'pr#1')));
});

for (const [status, [overrides, workflow]] of Object.entries(FIXED_RUNS)) {
  test(`[pr-body-sync-routing] fixes_applied>0 + ${status}: Evaluate で一致した図は、作り直した本文では ⚠️ 図は diff と未照合 を付けて出す`, async () => {
    const { result, calls } = await run({ ...withDiagramCheck(CONSISTENT), ...overrides }, workflow);
    assert.equal(result?.iterate_status, status);
    // PR 作成時の本文は照合済みの図（注記なし）
    assert.ok(!bodyOf(calls.find((c) => c.label === 'pr#1')).includes(PR_BODY_DIAGRAM_UNVERIFIED));
    const body = bodyOf(calls.find((c) => c.label === 'ac-checkbox-sync'));
    assert.ok(body.includes(`## 構成の変化\n${PR_BODY_DIAGRAM_UNVERIFIED}\n\n${FIGURES}\n\n`), `修正後の本文の図が未照合になっていない:\n${body}`);
    assert.equal(PR_BODY_DIAGRAM_UNVERIFIED, '⚠️ 図は diff と未照合');
  });

  test(`[pr-body-sync-routing] fixes_applied>0 + ${status}: Evaluate で食い違った図は、作り直した本文でも出さない`, async () => {
    const { calls } = await run({ ...withDiagramCheck(MISMATCHED), ...overrides }, workflow);
    assertNoFigure(bodyOf(calls.find((c) => c.label === 'ac-checkbox-sync')));
  });
}

test('[pr-body-sync-routing] 本文の作り直しが失敗し PR 本文に図がある run は、終端サマリーの 1 行に図も修正前のままであることを含める', async () => {
  const [overrides, workflow] = FIXED_RUNS.lgtm;
  const cardOf = async (diagramCheck) => {
    const { result, calls } = await run({ ...withDiagramCheck(diagramCheck), ...overrides, 'ac-checkbox-sync': { edited: false } }, workflow);
    assert.equal(result?.pr_body_synced, false);
    const summary = calls.find((c) => c.label === 'post-summary').prompt;
    return summary.slice(summary.indexOf('### あなたが確かめること'), summary.indexOf('| Merge tier |')).split('\n');
  };
  const card = await cardOf(CONSISTENT);
  assert.ok(card.includes(`- ${PR_BODY_STALE_NOTE_WITH_DIAGRAM}`), `図も修正前のままである旨が無い:\n${card.join('\n')}`);
  assert.ok(!card.includes(`- ${PR_BODY_STALE_NOTE}`), '図がある run で図に触れない行を重ねて出さない');
  assert.match(PR_BODY_STALE_NOTE_WITH_DIAGRAM, /PR 本文.*受入条件の結果.*構成の変化.*図.*修正前のまま/);
  // 食い違いで図を載せなかった run の本文に図は無いので、図に触れない行のままにする
  const noFigure = await cardOf(MISMATCHED);
  assert.ok(noFigure.includes(`- ${PR_BODY_STALE_NOTE}`) && !noFigure.includes(`- ${PR_BODY_STALE_NOTE_WITH_DIAGRAM}`), noFigure.join('\n'));
});
