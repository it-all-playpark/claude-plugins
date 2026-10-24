// _lib/pr-body-language-routing.test.mjs
// PR 本文の 1 行要約欄に日本語を含まない項目を返した run の経路を VM 実行で pin する（issue #1090）。
//   (a) Evaluate より前に dev-implementer へ日本語での書き直しを 1 回だけ差し戻し、なお残っても run は止めず本文に載せて警告する
//   (b) 差し戻しで implementer が書き直した項目が前回分を置き換える
//   (c) Evaluate 差し戻し（reimpl）の後にも同じ差し戻しを 1 回行う

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash, devFlowArgs, prerunAnalyze } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', '.claude/workflows/dev-flow.js'), 'utf8');

const STANDARD = ['src/x.ts', 'src/y.ts', 'src/z.ts'];
const impl = (extra = {}) => ({ status: 'DONE', task_id: 'issue-1', files: [...STANDARD], summary: 's', concerns: [], ...extra });
const EN = 'Builder now rejects English items';
const JA = '英語の項目を builder が差し戻すようになる';

const evalWith = (sat) => ({
  verdict: 'pass', total: 100, threshold: 80, feedback: [], feedback_level: 'implementation',
  ac_results: sat.map((s, i) => ({ ac_index: i, satisfied: s, verified_by: 'inspection', evidence: s ? 'ok' : 'ng' })),
  security_clearance: [], concern_resolutions: [],
});

async function run(overrides) {
  const { ctx, calls, logs } = makeDevFlowSandbox({
    overrides,
    extra: { args: devFlowArgs(1, { analyze: prerunAnalyze({ acceptance_criteria: ['worker 数の上限を設定で変えられる', '上限超過は 429 を返す'] }) }) },
  });
  const { error } = await runWorkflowCapture(src, ctx);
  assertNoCrash(error, 'pr-body-language');
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  const prPrompt = calls.find((c) => c.label === 'pr#1')?.prompt;
  assert.ok(prPrompt, 'PR phase が走っていない');
  return { calls, logs, prPrompt };
}

test('[pr-body-language] (a) 日本語でない項目は Evaluate より前に 1 回だけ差し戻し、なお残っても本文に載せて警告する', async () => {
  const { prPrompt, calls, logs } = await run({ 'impl:serial:issue-1': impl({ behavior_changes: [EN] }) });
  const rewrite = calls.filter((c) => c.label.startsWith('lang-rewrite'));
  assert.equal(rewrite.length, 1, `書き直しの差し戻しは 1 回だけ: ${calls.map((c) => c.label).join(', ')}`);
  assert.equal(rewrite[0].label, 'lang-rewrite:serial:issue-1');
  assert.ok(rewrite[0].prompt.includes(`"pr_body_not_japanese":{"items":[{"field":"behavior_changes[0]","text":"${EN}"}]}`), rewrite[0].prompt);
  assert.ok(calls.indexOf(rewrite[0]) < calls.findIndex((c) => c.label.startsWith('eval')), 'Evaluate より前に差し戻す');
  assert.ok(prPrompt.includes(`- ${EN}`), '差し戻し後も残った項目は本文に載る');
  assert.ok(logs.some((l) => l.includes('差し戻し後も PR 本文の項目 1 件が日本語でない')), logs.join('\n'));
});

test('[pr-body-language] (b) 差し戻しで書き直した項目が前回分を置き換え、日本語だけなら差し戻さない', async () => {
  const { prPrompt, logs } = await run({
    'impl:serial:issue-1': impl({ behavior_changes: [EN] }),
    'lang-rewrite:serial:issue-1': impl({ behavior_changes: [JA] }),
  });
  assert.ok(prPrompt.includes(`- ${JA}`), '書き直した項目が載る');
  assert.ok(!prPrompt.includes(EN), '英語の前回分は載らない');
  assert.ok(!logs.some((l) => l.includes('差し戻し後も')), logs.join('\n'));

  const { calls } = await run({ 'impl:serial:issue-1': impl({ behavior_changes: [JA] }) });
  assert.ok(!calls.some((c) => c.label.startsWith('lang-rewrite')), '日本語だけなら差し戻さない');
});

test('[pr-body-language] (c) Evaluate 差し戻し（reimpl）の後にも書き直しを 1 回差し戻す', async () => {
  const { calls } = await run({
    'impl:serial:issue-1': impl({ behavior_changes: [JA] }),
    'eval#1': evalWith([false, true]),
    'reimpl#1:serial:issue-1': impl({ review_points: [EN] }),
    'lang-rewrite#1:serial:issue-1': impl({ review_points: ['英語の判定を確認する'] }),
    'eval#2': evalWith([true, true]),
  });
  assert.ok(calls.some((c) => c.label === 'reimpl#1:serial:issue-1'), '差し戻しが走っていない');
  const rewrite = calls.filter((c) => c.label.startsWith('lang-rewrite'));
  assert.deepEqual(rewrite.map((c) => c.label), ['lang-rewrite#1:serial:issue-1'], calls.map((c) => c.label).join(', '));
  assert.ok(rewrite[0].prompt.includes(`{"field":"review_points[0]","text":"${EN}"}`), rewrite[0].prompt);
});
