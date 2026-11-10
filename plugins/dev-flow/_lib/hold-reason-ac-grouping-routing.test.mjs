// 同じ AC に紐づく ledger 未収束・ESCALATE・AC 未達を終端サマリーで 1 行にまとめる経路を VM 実行で pin する（issue #794）。
//   PR #788 型: evaluator が AC#2 に紐づく escalate feedback（ac_index: 1）を返し、pr-iterate の fix 後に
//   Final AC reconcile が AC#2 を不成立と判定 → AC-FINAL-2（critical）+ escalate + エージェント AC 未達の 3 理由で HOLD。
//   (A) HOLD 理由表・要対応表とも AC#2 の 1 行にまとまり、元の reason code が内訳に残る。merge tier と code 集合は不変
//   (B) feedback に ac_index が無い / 範囲外なら escalate は AC に紐づかず、従来どおりの escalate 行で出る

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash, devFlowArgs, prerunAnalyze } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', '.claude/workflows/dev-flow.js'), 'utf8');

const ACS = ['worker 数の上限を設定で変えられる', '上限を超えたら明示エラーを返す'];
const ESCALATE = {
  severity: 'major', topic: 'limit-overflow-behavior', dimension: 'ac',
  description: '上限超過時に待たせるか落とすかは issue に指定がない',
  escalate: true, escalate_reason: 'preference',
};
const HOLD_CODES = ['ledger_unconverged', 'escalate', 'ac_agent_unsatisfied'];

const plain = (v) => JSON.parse(JSON.stringify(v));

async function run(escalateFeedback) {
  const { ctx, calls } = makeDevFlowSandbox({
    workflow: async () => ({ status: 'lgtm', iterations: 2, fixes_applied: 1 }),
    overrides: {
      'eval#1': {
        verdict: 'pass', total: 100, threshold: 80, feedback: [escalateFeedback], feedback_level: 'implementation',
        ac_results: [0, 1].map((i) => ({ ac_index: i, satisfied: true, verified_by: 'inspection', evidence: 'ok' })),
        security_clearance: [], concern_resolutions: [],
      },
      'reconcile-sync': { ok: true, head: 'a'.repeat(40) },
      'test#final': { tests: 'passed', green: true, summary: '' },
      'final-ac-reconcile': {
        ac_results: [
          { ac_index: 0, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
          { ac_index: 1, satisfied: false, verified_by: 'inspection', evidence: '超過時に例外を握りつぶしている' },
        ],
      },
    },
    extra: { args: devFlowArgs(1, { analyze: prerunAnalyze({ acceptance_criteria: ACS }) }) },
  });
  const { result, error } = await runWorkflowCapture(src, ctx);
  assertNoCrash(error, 'hold-reason-ac-grouping');
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  const post = calls.find((c) => c.label === 'post-summary');
  assert.ok(post, 'post-summary が呼ばれる');
  return { result, body: post.prompt };
}

// heading 直後から次の節（見出し / 太字の節名 / <details>）までの表の行（'| ' 始まり、ヘッダーと区切りを除く）
function tableRows(body, heading) {
  const start = body.indexOf(heading);
  assert.ok(start >= 0, `${heading} を含む`);
  const rest = body.slice(start + heading.length);
  const ends = ['\n### ', '\n**', '\n<details>'].map((m) => rest.indexOf(m)).filter((i) => i >= 0);
  return rest.slice(0, ends.length > 0 ? Math.min(...ends) : rest.length).split('\n')
    .filter((l) => l.startsWith('| ') && !l.startsWith('| 理由 |') && !l.startsWith('| 状態 |'));
}

test('[hold-reason-ac-grouping] (A) 同じ AC に紐づく ledger 未収束・escalate・AC 未達は HOLD 理由表と要対応表で 1 行にまとまり、code が内訳に残る', async () => {
  const { result, body } = await run({ ...ESCALATE, ac_index: 1 });
  assert.equal(result?.merge_tier, 'HOLD');
  assert.deepEqual(plain(result.merge_tier_hold_reasons.map((r) => r.code)), HOLD_CODES, 'merge tier の code 集合は変わらない');

  const hold = tableRows(body, '### HOLD になった理由と現状');
  assert.equal(hold.length, 1, `HOLD 理由は AC#2 の 1 行: ${hold.join('\n')}`);
  assert.ok(hold[0].startsWith('| AC#2 未達 — ledger 未収束・ESCALATE・AC 未達（エージェント） を 1 行にまとめた（内訳: ledger_unconverged / escalate / ac_agent_unsatisfied） |'), hold[0]);

  const required = tableRows(body, '### ⚠️ 要対応');
  assert.equal(required.length, 1, `要対応は AC#2 の 1 行: ${required.join('\n')}`);
  assert.ok(required[0].startsWith('| ❌ 未解消 | 必須（AC#2 未達 に紐づく 3 件 — 内訳: ledger_unconverged / escalate / ac_agent_unsatisfied） | ac |'), required[0]);
  assert.ok(required[0].includes('超過時に例外を握りつぶしている'), 'AC 未達の根拠を残す');
  assert.ok(required[0].includes('limit-overflow-behavior — 上限超過時に待たせるか落とすかは issue に指定がない'), 'escalate の内容を残す');
  assert.ok(required[0].endsWith('| 修正が必要・要判断（preference） |'), required[0]);
});

test('[hold-reason-ac-grouping] (B) ac_index の無い / 範囲外の escalate は AC に紐づかず、従来どおりの escalate 行で出る', async () => {
  for (const feedback of [ESCALATE, { ...ESCALATE, ac_index: 9 }]) {
    const { result, body } = await run(feedback);
    assert.equal(result?.merge_tier, 'HOLD');
    assert.deepEqual(plain(result.merge_tier_hold_reasons.map((r) => r.code)), HOLD_CODES, 'merge tier の code 集合は変わらない');

    const hold = tableRows(body, '### HOLD になった理由と現状');
    assert.ok(hold.includes('| ESCALATE-TO-HUMAN 項目 1 件 | 人が確かめる | ESCALATE 1 件中 0 件は fix 後 tree で解消確認済み | 要判断 1 件（下表 ⚠️ 行） |'), `escalate 行は従来どおり: ${hold.join('\n')}`);
    assert.ok(hold.some((l) => l.includes('（内訳: ledger_unconverged / ac_agent_unsatisfied）')), `AC-FINAL-2 と AC#2 未達は 1 行: ${hold.join('\n')}`);
    assert.equal(hold.length, 2);

    const required = tableRows(body, '### ⚠️ 要対応');
    assert.ok(required.includes('| ⚠️ 要判断 | 要判断（advisory ESCALATE） | ac | limit-overflow-behavior — 上限超過時に待たせるか落とすかは issue に指定がない | 未判断 | 要判断（preference） |'), `escalate 行は従来どおり（現状の既定は「未判断」— issue #829）: ${required.join('\n')}`);
  }
});
