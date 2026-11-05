// micro AUTO run で classifyMergeTier に evalSkipped:true が渡り、
// merge_tier_reasons に AC未検証文言が含まれることを VM sandbox で検証する（issue #233）。
// post-summary prompt 本文への転記は devflow-summary-format.test.mjs（純関数出力テスト）が担うため
// ここでは扱わない（issue #636 AC-1）。
// test-helpers/vm-sandbox.mjs の VM sandbox パターン（makeRecordingSandbox / runWorkflowCapture）を踏襲。
//
// テスト構成:
//   (A) micro AUTO run → merge_tier===AUTO かつ reasons に AC未検証文言 かつ evaluator 0 件
//   (B) standard shape run → merge_tier===REVIEW かつ文言なし（evaluator が走るので開示不要）
//   (C) micro AUTO run で evaluator が 0 件であること（開示文言の前提確認）

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { devFlowArgs, mergeTierFacts, JS_GLOBALS, runWorkflowCapture, devFlowResponder } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');
const src = readFileSync(devFlowPath, 'utf8');

/**
 * sandbox を構築する。
 * shape に応じて realized-diff / changed-files の stub を切り替える。
 */
function makeSandbox(opts) {
  const calls = [];
  const {
    realizedFiles = ['docs/a.md'],
    changedFiles = ['docs/a.md'],
    iterateResult = { status: 'lgtm', iterations: 1, fixes_applied: 0 },
  } = opts || {};

  const agentStub = async (prompt, agentOpts) => {
    const label = agentOpts && agentOpts.label ? agentOpts.label : '';
    const agentType = agentOpts && agentOpts.agentType ? agentOpts.agentType : '';
    calls.push({ label, agentType, prompt: String(prompt || '') });

    // Diff triage の敵対的 security review の対象判定（issue #1063）: この test の関心外なので対象外を返す
    if (label === 'security-scope') return { ok: true, target: false, reasons: [] };
    // file_changes は既定 realizedFiles（docs/a.md）と一致させ、宣言外扱いによる
    // micro Evaluate 強制（issue #272 F2）が誤発火しないようにする。
    // label 'danger-grep'（issue #544 統合呼び出し）: risk/files を 1 応答で返す
    // （files は旧 realized-diff 相当）。
    if (label === 'danger-grep') return { risk: { ok: true, hits: [] }, files: realizedFiles, struct: null, diffhash: null };
    if (label === 'merge-tier-facts') return mergeTierFacts({ files: changedFiles });
    if (label.startsWith('test')) return { tests: 'no_tests', green: true, summary: '' };
    if (agentType === 'dev-flow:dev-implementer') return { status: 'DONE', task_id: 'issue-1', files: realizedFiles, summary: '', concerns: [] };
    return devFlowResponder({ 'commit-hook#1': null, 'isolation-probe': null, 'journal-log': null, 'post-summary': null })({ label, agentType, prompt });
  };

  const sandbox = {
    phase: () => {}, log: () => {}, agent: agentStub,
    workflow: async () => iterateResult, args: devFlowArgs('1'),
    ...JS_GLOBALS,
  };
  const ctx = vm.createContext(sandbox);
  return { ctx, calls };
}

// ============================================================
// (A) micro AUTO run → merge_tier===AUTO + AC未検証文言あり + post-summary に文言あり
// ============================================================

test('[micro-auto-ac-disclosure] (A) micro AUTO run → merge_tier===AUTO かつ AC未検証文言を含む', async () => {
  const { ctx, calls } = makeSandbox({
    realizedFiles: ['docs/a.md'],
    changedFiles: ['docs/a.md'],
  });
  const { error, result: returned } = await runWorkflowCapture(src, ctx);
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }
  if (error) assert.fail(`(A) 想定外エラー: ${error.message}`);
  assert.ok(returned !== null, '(A) return object を返すべき');
  assert.strictEqual(returned.merge_tier, 'AUTO', `(A) micro AUTO run なら merge_tier===AUTO のはずだが: ${returned.merge_tier}`);
  assert.ok(
    returned.merge_tier_reasons.some((r) => r.includes('AC は未検証（micro eval skip）')),
    `(A) merge_tier_reasons に AC未検証文言を含むべきだが: ${JSON.stringify(returned.merge_tier_reasons)}`,
  );
  // post-summary prompt 本文への同文言の転記は devflow-summary-format.test.mjs（純関数出力テスト）が
  // 担う。ここでは返り値 routing（merge_tier_reasons）のみを検証する。
});

// ============================================================
// (B) standard shape run → merge_tier===REVIEW かつ AC未検証文言なし
// ============================================================

test('[micro-auto-ac-disclosure] (B) standard run → merge_tier===REVIEW かつ AC未検証文言なし', async () => {
  const { ctx, calls } = makeSandbox({
    realizedFiles: ['src/foo.ts'],
    changedFiles: ['src/foo.ts'],
  });
  const { error, result: returned } = await runWorkflowCapture(src, ctx);
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }
  if (error) assert.fail(`(B) 想定外エラー: ${error.message}`);
  assert.ok(returned !== null, '(B) return object を返すべき');
  assert.strictEqual(returned.merge_tier, 'REVIEW', `(B) standard run なら merge_tier===REVIEW のはずだが: ${returned.merge_tier}`);
  assert.ok(
    returned.merge_tier_reasons.every((r) => !r.includes('AC は未検証（micro eval skip）')),
    `(B) REVIEW tier では AC未検証文言なし: ${JSON.stringify(returned.merge_tier_reasons)}`,
  );
});

// ============================================================
// (C) micro AUTO run で evaluator が 0 件
// ============================================================

test('[micro-auto-ac-disclosure] (C) micro AUTO run → evaluator が 0 件（AC未検証開示の前提確認）', async () => {
  const { ctx, calls } = makeSandbox({
    realizedFiles: ['docs/a.md'],
    changedFiles: ['docs/a.md'],
  });
  const { error } = await runWorkflowCapture(src, ctx);
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }
  const evaluatorCalls = calls.filter((c) => c.agentType === 'dev-flow:evaluator');
  assert.strictEqual(
    evaluatorCalls.length, 0,
    `(C) micro AUTO run では evaluator は 0 件のはずだが ${evaluatorCalls.length} 件`
    + ` (全 agentTypes: ${calls.map((c) => c.agentType).filter(Boolean).join(', ')})`,
  );
});
