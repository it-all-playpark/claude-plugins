// evaluator を回していない micro の run で classifyMergeTier に evalSkipped:true が渡り、変更ファイルの種類に
// 関わらず tier は REVIEW で、merge_tier_reasons と終端サマリーの理由の節に AC 未検証文言が載ることを
// VM sandbox で検証する（issue #233）。
// test-helpers/vm-sandbox.mjs の VM sandbox パターン（makeRecordingSandbox / runWorkflowCapture）を踏襲。
//
// テスト構成:
//   (A) micro + docs だけの run / micro + コード変更の run → REVIEW・AC 未検証文言あり・理由の節に出る・evaluator 0 件
//   (B) standard の run → REVIEW・文言なし（evaluator が走るので開示不要）
//   (C) micro だが Evaluate が強制実行された run（宣言外変更）→ REVIEW・文言なし（虚偽開示をしない）

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { devFlowArgs, mergeTierFacts, runWorkflowCapture, devFlowResponder, makeWorkflowContext } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');
const src = readFileSync(devFlowPath, 'utf8');

const AC_UNVERIFIED = 'AC は未検証（micro eval skip）';

/**
 * sandbox を構築する。
 * realizedFiles は diff 上の変更ファイル、declaredFiles は dev-implementer の申告（既定は realizedFiles と一致 =
 * 宣言外 0 件で micro Evaluate 強制（issue #272 F2）が誤発火しない）。
 */
function makeSandbox({ realizedFiles, declaredFiles = realizedFiles }) {
  const calls = [];
  const iterateResult = { status: 'lgtm', iterations: 1, fixes_applied: 0 };

  const agentStub = async (prompt, agentOpts) => {
    const label = agentOpts && agentOpts.label ? agentOpts.label : '';
    const agentType = agentOpts && agentOpts.agentType ? agentOpts.agentType : '';
    calls.push({ label, agentType, prompt: String(prompt || '') });

    // Diff triage の敵対的 security review の対象判定（issue #1063）: この test の関心外なので対象外を返す
    if (label === 'security-scope') return { ok: true, target: false, reasons: [] };
    // label 'danger-grep'（issue #544 統合呼び出し）: risk/files を 1 応答で返す
    // （files は旧 realized-diff 相当）。
    if (label === 'danger-grep') return { risk: { ok: true, hits: [] }, files: realizedFiles, struct: null, diffhash: null };
    if (label === 'merge-tier-facts') return mergeTierFacts({ files: realizedFiles });
    if (label.startsWith('test')) return { tests: 'no_tests', green: true, summary: '' };
    if (agentType === 'dev-flow:dev-implementer') return { status: 'DONE', task_id: 'issue-1', files: declaredFiles, summary: '', concerns: [] };
    return devFlowResponder({ 'commit-hook#1': null, 'isolation-probe': null, 'journal-log': null, 'post-summary': null })({ label, agentType, prompt });
  };

  const ctx = makeWorkflowContext({
    agent: agentStub,
    workflow: async () => iterateResult, args: devFlowArgs('1'),
  });
  return { ctx, calls };
}

async function run(opts) {
  const { ctx, calls } = makeSandbox(opts);
  const { error, result } = await runWorkflowCapture(src, ctx);
  if (error) assert.fail(`dev-flow.js が throw: ${error.name}: ${error.message}`);
  assert.ok(result !== null, 'return object を返すべき');
  const evaluatorCalls = calls.filter((c) => c.agentType === 'dev-flow:evaluator');
  const summaryPrompt = calls.find((c) => c.label === 'post-summary')?.prompt;
  assert.ok(summaryPrompt, '終端サマリーの投稿が走っていない');
  return { returned: result, evaluatorCalls, summaryPrompt };
}

// ============================================================
// (A) micro + evaluator 0 回の run は docs だけでもコード変更でも REVIEW + AC 未検証の開示
// ============================================================

test.each([
  ['docs だけ', ['docs/a.md']],
  ['コード変更', ['src/foo.ts']],
])('[micro-auto-ac-disclosure] (A) micro（%s）の run → merge_tier===REVIEW、AC未検証文言が reasons と終端サマリーの理由の節に出る', async (_name, files) => {
  const { returned, evaluatorCalls, summaryPrompt } = await run({ realizedFiles: files });
  assert.strictEqual(returned.shape, 'micro');
  assert.strictEqual(evaluatorCalls.length, 0, `evaluator は 0 件のはずだが ${evaluatorCalls.length} 件`);
  assert.strictEqual(returned.merge_tier, 'REVIEW', `merge_tier===REVIEW のはずだが: ${returned.merge_tier}`);
  assert.ok(
    returned.merge_tier_reasons.some((r) => r.includes(AC_UNVERIFIED)),
    `merge_tier_reasons に AC未検証文言を含むべきだが: ${JSON.stringify(returned.merge_tier_reasons)}`,
  );
  assert.ok(summaryPrompt.includes(`<!-- dev-flow:REVIEW`), '終端サマリーの marker が REVIEW');
  const reasonsAt = summaryPrompt.indexOf('**Merge tier 理由**:');
  assert.ok(reasonsAt >= 0, '理由の節が無い');
  assert.ok(summaryPrompt.slice(reasonsAt).includes(`- ${AC_UNVERIFIED}`), '理由の節に AC未検証文言が無い');
});

// ============================================================
// (B) standard の run → merge_tier===REVIEW かつ AC未検証文言なし
// ============================================================

test('[micro-auto-ac-disclosure] (B) standard の run → merge_tier===REVIEW、evaluator が走り AC未検証文言なし', async () => {
  const { returned, evaluatorCalls, summaryPrompt } = await run({ realizedFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'] });
  assert.strictEqual(returned.shape, 'standard');
  assert.ok(evaluatorCalls.length >= 1, 'standard は evaluator が走る');
  assert.strictEqual(returned.merge_tier, 'REVIEW', `merge_tier===REVIEW のはずだが: ${returned.merge_tier}`);
  assert.ok(
    returned.merge_tier_reasons.every((r) => !r.includes(AC_UNVERIFIED)),
    `AC未検証文言なしのはずだが: ${JSON.stringify(returned.merge_tier_reasons)}`,
  );
  assert.ok(!summaryPrompt.includes(AC_UNVERIFIED), '終端サマリーに AC未検証文言なし');
});

// ============================================================
// (C) micro だが Evaluate が強制実行された run → AC未検証文言なし
// ============================================================

test('[micro-auto-ac-disclosure] (C) micro + 宣言外変更で Evaluate 強制の run → evaluator が走り AC未検証文言なし', async () => {
  const { returned, evaluatorCalls, summaryPrompt } = await run({ realizedFiles: ['src/foo.ts', 'src/undeclared.ts'], declaredFiles: ['src/foo.ts'] });
  assert.strictEqual(returned.shape, 'micro');
  assert.ok(evaluatorCalls.length >= 1, '宣言外変更は Evaluate 強制');
  assert.ok(
    returned.merge_tier_reasons.every((r) => !r.includes(AC_UNVERIFIED)),
    `AC未検証文言なしのはずだが: ${JSON.stringify(returned.merge_tier_reasons)}`,
  );
  assert.ok(!summaryPrompt.includes(AC_UNVERIFIED), '終端サマリーに AC未検証文言なし');
});
