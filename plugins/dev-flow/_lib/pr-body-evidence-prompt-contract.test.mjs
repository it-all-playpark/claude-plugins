// _lib/pr-body-evidence-prompt-contract.test.mjs
// 「PR 本文に書く」型の AC を evaluator が本文テキストで判定するための prompt 契約を VM 実行で pin する（issue #815）。
//   (a) Evaluate（eval#1）の prompt は buildPrBody の出力（PR 作成前のプレビュー）を含み、plan の本文材料
//       （pr_notes / architecture_decisions / pr_sections / out_of_scope / behavior_changes / review_points）の生 JSON を
//       含まない。プレビューは PR phase と同じ builder で組まれ、PR phase が作る本文と受入条件の結果の表・AC checkbox 以外で一致する
//       （見える部分の要約と <details> の判定材料という構成も同じ。issue #928）
//   (b) final-ac-reconcile の prompt は PR に載せた本文（pr#1 の PR body）そのものを含み、plan.pr_notes の生 JSON を含まない

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', '.claude/workflows/dev-flow.js'), 'utf8');

const STANDARD = ['src/x.ts', 'src/y.ts', 'src/z.ts'];
const NOTE = '512Mi で worker 4 本: app 全体の RSS 合計 380Mi（ローカル計測）';
const DECISION = 'worker 上限は 4';
const TABLE = ['| # | 項目 | 状態 |', '|---|---|---|', ...Array.from({ length: 40 }, (_, i) => `| ${i + 1} | item-${i + 1} | 移植済み |`)].join('\n');
const OOS = 'dotfiles の excludedCommands 更新（worktree 外）';
const CHANGE = 'worker の同時実行数が 4 本までになる';
const REVIEW = '512Mi 以外のノードでは未計測';
const impl = () => ({
  status: 'DONE', task_id: 'issue-1', files: [...STANDARD], summary: 's', concerns: [],
  behavior_changes: [CHANGE],
  review_points: [REVIEW],
  pr_notes: [{ section: 'measurement', text: NOTE }],
  design_decisions: [{ title: DECISION, rationale: '512Mi に収まる最大数' }],
  pr_sections: [{ heading: '落とした項目が無いことの対応表', markdown: TABLE }],
  out_of_scope: [OOS],
});
const RAW_KEYS = ['"pr_notes"', '"architecture_decisions"', '"pr_sections"', '"out_of_scope"', '"behavior_changes"', '"review_points"'];

function between(text, begin, end) {
  const i = text.indexOf(begin);
  assert.ok(i >= 0, `${begin} が無い`);
  const j = text.indexOf(end, i + begin.length);
  assert.ok(j >= 0, `${end} が無い`);
  return text.slice(i + begin.length, j);
}

const prBodyOf = (calls) => between(calls.find((c) => c.label === 'pr#1').prompt, '<<<PR_BODY_BEGIN>>>\n', '<<<PR_BODY_END>>>');
const previewOf = (prompt) => between(prompt, '<<<PR_BODY_PREVIEW_BEGIN>>>\n', '<<<PR_BODY_PREVIEW_END>>>');
// Evaluate の判定で変わる部分（受入条件の結果の表のデータ行・AC checkbox）を揃える。
const uncheck = (body) => body.replace(/^- \[x\] /gm, '- [ ] ').replace(/^\| AC-(\d+) \| .*$/gm, '| AC-$1 |');
const AC_TABLE_INSTR = /本文の「受入条件の結果」の表は未確定であり、AC の充足・未達の根拠にするな/;

test('[pr-body-evidence] (a) eval#1 の prompt は buildPrBody のプレビューを含み、plan の本文材料の生 JSON を含まない', async () => {
  const { ctx, calls } = makeDevFlowSandbox({ overrides: { 'impl:serial:issue-1': impl() } });
  const { error } = await runWorkflowCapture(src, ctx);
  assertNoCrash(error, 'pr-body-evidence eval');
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  const ev = calls.find((c) => c.label === 'eval#1');
  assert.ok(ev, 'eval#1 が走っていない');
  const preview = previewOf(ev.prompt);
  assert.equal(uncheck(preview), uncheck(prBodyOf(calls)), 'プレビューは PR phase の本文と受入条件の結果の表・AC checkbox 以外で一致する');
  assert.ok(preview.includes(`\n\n## 何が変わるか\n- ${CHANGE}\n\n## 人間に見てほしい点\n- ${REVIEW}\n\n## この PR に含めなかったもの\n- ${OOS}\n\n## 受入条件の結果\n| AC | 要旨 | 結果 | 根拠 |\n|---|---|---|---|\n| AC-1 | — | ⚠️ 未検証 | — |\n| AC-2 | — | ⚠️ 未検証 | — |\n\n<details><summary>受入条件</summary>\n`), `見える部分の要約が <details> の前に並ぶ: ${preview}`);
  assert.ok(preview.includes(`<details><summary>設計判断</summary>\n\n- ${DECISION} — 512Mi に収まる最大数\n\n</details>`), preview);
  assert.ok(preview.includes(`- 計測: ${NOTE}\n\n</details>`), '検証の <details> に pr_notes が載る');
  assert.ok(preview.includes(`\n\n${TABLE}\n\n</details>`), '対応表が改行を保ってプレビューに載る');
  assert.ok(preview.trimEnd().endsWith('Closes #1'));
  assert.match(ev.prompt, /「PR 本文に書く」型の AC は、この本文テキストに該当内容があるかで判定せよ/);
  assert.ok(preview.includes('- [ ] '), '前提: プレビューの受入条件は未チェック');
  assert.match(ev.prompt, /受入条件」のチェックボックス（- \[ \] \/ - \[x\]）は未確定であり、AC の充足・未達の根拠にするな/);
  assert.match(ev.prompt, AC_TABLE_INSTR);
  for (const k of RAW_KEYS) assert.ok(!ev.prompt.includes(k), `eval#1 prompt に plan の生 JSON ${k} が残っている`);
  assert.ok(ev.prompt.includes('plan: {"summary":'), 'plan（本文材料を除いたもの）は引き続き渡す');
});

test('[pr-body-evidence] (b) final-ac-reconcile の prompt は PR に載せた本文そのものを含み、plan.pr_notes の生 JSON を含まない', async () => {
  const { ctx, calls } = makeDevFlowSandbox({
    workflow: async () => ({ status: 'lgtm', iterations: 2, fixes_applied: 1 }),
    overrides: {
      'impl:serial:issue-1': impl(),
      'reconcile-sync': { ok: true, head: 'a'.repeat(40) },
      'test#final': { tests: 'passed', green: true, summary: '' },
    },
  });
  const { result, error } = await runWorkflowCapture(src, ctx);
  assertNoCrash(error, 'pr-body-evidence final');
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  const fac = calls.filter((c) => c.label === 'final-ac-reconcile');
  assert.equal(fac.length, 1, `fixes_applied>0 で final-ac-reconcile が 1 回走る: ${calls.map((c) => c.label).join(', ')}`);
  assert.equal(previewOf(fac[0].prompt), prBodyOf(calls), 'PR に載せた本文と一字一句同じ');
  assert.match(fac[0].prompt, /「PR 本文に書く」型の AC は、この本文テキストに該当内容があるかで判定せよ/);
  assert.match(fac[0].prompt, /チェックボックス（- \[ \] \/ - \[x\]）は未確定であり、AC の充足・未達の根拠にするな/);
  // PR に載せた本文の表は修正前の Evaluate の ✅ を持つ — 再検証の根拠にさせない
  assert.ok(previewOf(fac[0].prompt).includes('| ✅ |'), '前提: PR に載せた本文の表に Evaluate の結果がある');
  assert.match(fac[0].prompt, AC_TABLE_INSTR);
  for (const k of RAW_KEYS) assert.ok(!fac[0].prompt.includes(k), `final-ac-reconcile prompt に plan の生 JSON ${k} が残っている`);
  assert.equal(result?.final_ac_reconcile, 'reverified');
});
