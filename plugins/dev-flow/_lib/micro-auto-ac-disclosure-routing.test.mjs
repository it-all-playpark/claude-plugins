// micro の run でも evaluator が AC を判定し、変更ファイルの種類に関わらず tier は REVIEW で、merge_tier_reasons が
// 既定文だけ（AC 未検証の開示行なし）になり、終端サマリーに理由の節が出ないことを VM sandbox で検証する。
// test-helpers/vm-sandbox.mjs の VM sandbox パターン（makeRecordingSandbox / runWorkflowCapture）を踏襲。

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

const DEFAULT_REVIEW_REASON = '標準 — 人間が LGTM して merge';

/**
 * sandbox を構築する。
 * realizedFiles は diff 上の変更ファイルで、dev-implementer の申告も同じにする（宣言外 0 件）。
 */
function makeSandbox({ realizedFiles }) {
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
    if (label === 'danger-grep') return { risk: { ok: true, hits: [] }, files: realizedFiles, diffhash: null };
    if (label === 'merge-tier-facts') return mergeTierFacts({ files: realizedFiles });
    if (label.startsWith('test')) return { tests: 'passed', green: true, summary: '' };
    if (agentType === 'dev-flow:dev-implementer') return { status: 'DONE', task_id: 'issue-1', files: realizedFiles, summary: '', concerns: [] };
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
// (A) micro の run は docs だけでもコード変更でも evaluator が AC を判定し、REVIEW の理由は既定文だけ
// ============================================================

test.each([
  ['docs だけ', ['docs/a.md']],
  ['コード変更', ['src/foo.ts']],
])('[micro-auto-ac-disclosure] (A) micro（%s）の run → evaluator 1 回、merge_tier===REVIEW で reasons に AC 未検証の行が無い', async (_name, files) => {
  const { returned, evaluatorCalls, summaryPrompt } = await run({ realizedFiles: files });
  assert.strictEqual(returned.shape, 'micro');
  assert.strictEqual(evaluatorCalls.length, 1, `evaluator は 1 件のはずだが ${evaluatorCalls.length} 件`);
  assert.strictEqual(returned.merge_tier, 'REVIEW', `merge_tier===REVIEW のはずだが: ${returned.merge_tier}`);
  // CI の checks を返さない stub なので CI 未完了の開示が 1 行付く。AC 未検証の行は付かない
  assert.deepStrictEqual([...returned.merge_tier_reasons].filter((r) => !r.startsWith('CI 未完了')), [DEFAULT_REVIEW_REASON]);
  assert.ok(summaryPrompt.includes(`<!-- dev-flow:REVIEW`), '終端サマリーの marker が REVIEW');
});
