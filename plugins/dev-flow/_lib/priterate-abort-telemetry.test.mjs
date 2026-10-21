// top-level abort handoff のルーティングテスト（issue #607）。
// pr-iterate.js にも dev-flow.js と同種の穴があった（handoff は終端 1 箇所のみで、isolation probe の
// fail-closed throw 等の handoff 到達前の例外で telemetry が全損する）ため、同機構
// （top-level try/catch + journal-log-abort）で同時に塞いだ。harness は test-helpers/vm-sandbox.mjs の
// makePrIterateSandbox（pr-iterate 単体起動の既定 responder）/ runWorkflowCapture を使い、
// isolation-probe と journal-log-abort の応答だけを上書きする。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makePrIterateSandbox, runWorkflowCapture } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', '.claude/workflows/pr-iterate.js'), 'utf8');

function makeSandbox({ isolationProbeResult, journalLogAbortThrows } = {}) {
  const overrides = {};
  if (isolationProbeResult) overrides['isolation-probe'] = isolationProbeResult;
  if (journalLogAbortThrows) overrides['journal-log-abort'] = () => { throw new Error('journal-log-abort boom'); };
  return makePrIterateSandbox({ overrides });
}

const runPrIterateCapture = (source, ctx) => runWorkflowCapture(source, ctx, '.claude/workflows/pr-iterate.js');

// ============================================================
// (1) isolation probe fail-closed
// ============================================================
test("[abort-telemetry] (1) isolation probe fail-closed（written:false）→ run が throw し abort entry 1 件", async () => {
  const { ctx, calls } = makeSandbox({
    isolationProbeResult: { written: false, error: "parent bg session hasn't isolated" },
  });

  const { result, error } = await runPrIterateCapture(src, ctx);

  assert.ok(error !== null, '(1) isolation probe fail-closed で run が throw すべきだが error が null だった');
  assert.ok(/isolation/i.test(String(error?.message ?? '')),
    `(1) error.message に isolation 系メッセージを含むべきだが: ${error?.message}`);

  assert.equal(calls.filter((c) => c.label === 'journal-save').length, 0, '(1) journal-save spawn は起動しない');
  const saveCalls = calls.filter((c) => c.label === 'journal-log-abort' && c.agentType === 'dev-flow:dev-runner-haiku');
  assert.equal(saveCalls.length, 1, `(1) journal-log-abort は 1 回のはずだが ${saveCalls.length} 回だった`);

  const savePrompt = saveCalls[0]?.prompt ?? '';
  for (const key of [
    '"skill":"pr-iterate"', '"outcome":"failure"', '"error_category":"abort"',
    '"error_msg":"abort@Iterate/isolation-probe: ', '"error_phase":"Iterate"',
    '"merge_tier":"PR_ITERATE"', '"review_model_config":"opus"',
    '"pr_number":5', '"args":"pr=5"', '"repo":"acme/skills"',
  ]) {
    assert.ok(savePrompt.includes(key),
      `(1) journal-log-abort prompt に '${key}' が含まれるべきだが含まれていなかった。prompt:\n${savePrompt.slice(0, 900)}`);
  }
  // label は error_msg に載る。telemetry には複製しない（残すキー以外を書かない）
  for (const key of ['"abort_label"', '"abort_phase"', '"iterate_rounds"', '"subagent_invocations"']) {
    assert.ok(!savePrompt.includes(key),
      `(1) journal-log-abort prompt に削除済み telemetry キー '${key}' が含まれていた。prompt:\n${savePrompt.slice(0, 900)}`);
  }
  assert.ok(savePrompt.includes('~/.claude/journal/pending/priterate-5-effect-'),
    `(1) journal-log-abort prompt に pending パスが含まれるべきだが含まれていなかった。prompt:\n${savePrompt.slice(0, 900)}`);
  assert.ok(!savePrompt.includes('.devflow-tmp'),
    `(1) journal-log-abort prompt は payload の一時ファイルを経由してはならない。prompt:\n${savePrompt.slice(0, 900)}`);

  const logCalls = calls.filter((c) => c.label === 'journal-log' && c.agentType === 'dev-flow:dev-runner-haiku');
  assert.equal(logCalls.length, 0, `(1) 通常終端の journal-log は 0 回のはずだが ${logCalls.length} 回だった`);
});

// ============================================================
// (2) fail-open: journal-log-abort 自体が throw しても元の例外は変わらない
// ============================================================
test('[abort-telemetry] (2) fail-open: journal-log-abort stub が throw しても元の isolation エラーを rethrow する', async () => {
  const { ctx, calls } = makeSandbox({
    isolationProbeResult: { written: false, error: "parent bg session hasn't isolated" },
    journalLogAbortThrows: true,
  });

  const { error } = await runPrIterateCapture(src, ctx);

  assert.ok(error !== null, '(2) error が null だった');
  assert.ok(/isolation/i.test(String(error?.message ?? '')),
    `(2) handoff 自体の失敗で元の例外が置き換わってはならないが: ${error?.message}`);

  const logAbortCalls = calls.filter((c) => c.label === 'journal-log-abort');
  assert.equal(logAbortCalls.length, 1, `(2) journal-log-abort は 1 回のはずだが ${logAbortCalls.length} 回だった`);
});

// ============================================================
// (3) lgtm 完走（回帰）
// ============================================================
test('[abort-telemetry] (3) lgtm 完走経路: journal-log-abort が 0 回・journal-log が 1 回・journal_log_status===logged', async () => {
  const { ctx, calls } = makeSandbox();

  const { result, error } = await runPrIterateCapture(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`pr-iterate.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  const logAbortCalls = calls.filter((c) => c.label === 'journal-log-abort');
  assert.equal(logAbortCalls.length, 0, `(3) lgtm 完走では journal-log-abort は 0 回のはずだが ${logAbortCalls.length} 回だった`);

  const logCalls = calls.filter((c) => c.label === 'journal-log' && c.agentType === 'dev-flow:dev-runner-haiku');
  assert.equal(logCalls.length, 1, `(3) journal-log は 1 回のはずだが ${logCalls.length} 回だった`);

  assert.equal(result?.journal_log_status, 'logged',
    `(3) lgtm 完走では result.journal_log_status は 'logged' のはずだが ${JSON.stringify(result?.journal_log_status)} だった`);
});

// (4) ABORT_CTX 宣言 / try 開始位置 / iterate_rounds 反映 / 末尾 catch+rethrow の静的 pin は撤去した（issue #636）。
// isolation probe 段の abort と rethrow は (1)(2) が VM 挙動で担保する。ループ内の call site は全て例外を
// 吸収するため iterate_rounds の abort 反映は現行コードでは観測経路が無い。
