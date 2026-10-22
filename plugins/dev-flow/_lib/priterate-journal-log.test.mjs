// F3: pr-iterate 終端の journal-log 呼び出し検証テスト（TDD）
// 終端サマリー投稿の後・return の前に journal-log (dev-runner-haiku) が
// 1 回呼び出されること、および logged:false でも正常 return することを検証する。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makePrIterateSandbox, runWorkflowCapture } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', '.claude/workflows/pr-iterate.js'), 'utf8');

// harness は test-helpers/vm-sandbox.mjs の makePrIterateSandbox。journal-log の応答だけを差し替える:
// payload を pending/ へ直接書く 1 spawn（issue #807）。journalResult が Error なら throw する
// （schema 不一致・proxy 実行失敗の再現）。pr-meta は repo probe（issue #309）の最小応答（epoch なし）。
function makeSandbox(journalResult) {
  const { ctx, calls } = makePrIterateSandbox({
    overrides: {
      'pr-meta': { url: 'https://github.com/acme/skills/pull/5', base_ref: 'main', cwd: '/tmp/wt' },
      'journal-log': () => {
        if (journalResult instanceof Error) throw journalResult;
        return journalResult;
      },
    },
  });
  const journalCalls = () => calls.filter((c) => c.label === 'journal-log' && c.agentType === 'dev-flow:dev-runner-haiku');
  return {
    ctx,
    getJournalCallCount: () => journalCalls().length,
    getCapturedPrompt: () => journalCalls().at(-1)?.prompt ?? null,
    getLabels: () => calls.map((c) => c.label),
  };
}

const runPrIterateCapture = (source, ctx) => runWorkflowCapture(source, ctx, '.claude/workflows/pr-iterate.js');

test('[journal-log] journalResult={saved:true, logged:true} で完走 → journal-log が 1 spawn だけ呼ばれ、payload と pending パスを含み、result.status === lgtm', async () => {
  const journalResult = { saved: true, logged: true };
  const { ctx, getJournalCallCount, getCapturedPrompt, getLabels } = makeSandbox(journalResult);

  const { result, error } = await runPrIterateCapture(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`pr-iterate.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  assert.equal(
    getJournalCallCount(),
    1,
    `journal-log dev-runner-haiku の呼び出しは 1 回であるべきだが ${getJournalCallCount()} 回だった`,
  );
  assert.ok(!getLabels().includes('journal-save'), `payload の一時ファイルを書く journal-save spawn は起動しない: ${getLabels().join(', ')}`);

  const capturedPrompt = getCapturedPrompt();
  const requiredKeys = [
    '"skill":"pr-iterate"',
    '"outcome":"success"',
    '"args":"pr=5"',
    '"repo":"acme/skills"',
    '"pr_number":5',
    '"merge_tier":"PR_ITERATE"',
    '"iterate_status":"lgtm"',
  ];
  for (const key of requiredKeys) {
    assert.ok(
      typeof capturedPrompt === 'string' && capturedPrompt.includes(key),
      `journal-log prompt に '${key}' が含まれるべきだが含まれない。prompt=${capturedPrompt}`,
    );
  }

  // journal-handoff.mjs は最終ファイル名に stable effect-ID（payload 由来の 16hex）を含む。
  // issue #526 で shell を外したため、pending パスは shell 展開式ではなく Write tool が展開する `~` 形。
  assert.ok(
    typeof capturedPrompt === 'string' && capturedPrompt.includes('~/.claude/journal/pending/priterate-5-effect-'),
    `journal-log prompt に pending パスが含まれるべきだが含まれない。prompt=${capturedPrompt}`,
  );
  assert.ok(
    typeof capturedPrompt === 'string' && !capturedPrompt.includes('.devflow-tmp'),
    `journal-log prompt は payload の一時ファイルを経由してはならない。prompt=${capturedPrompt}`,
  );
  assert.ok(
    typeof capturedPrompt === 'string' && !capturedPrompt.includes('journal log pr-iterate'),
    `journal-log prompt は direct journal 実行ではなく pending handoff であるべき。prompt=${capturedPrompt}`,
  );

  assert.equal(
    result?.status,
    'lgtm',
    `result.status は 'lgtm' であるべきだが '${result?.status}' だった`,
  );
  // journal-log が {saved:true, logged:true} を返すため result.journal_log_status は 3 値 closed enum のうち 'logged'
  assert.equal(
    result?.journal_log_status,
    'logged',
    `journal-log が logged:true を返す場合 result.journal_log_status は 'logged' のはずだが '${result?.journal_log_status}' だった`,
  );
});

test('[journal-log] journalResult={saved:true, logged:false} → result が non-null で result.status === lgtm・journal_log_status === log_failed（記録失敗でも正常 return）', async () => {
  const journalResult = { saved: true, logged: false };
  const { ctx } = makeSandbox(journalResult);

  const { result, error } = await runPrIterateCapture(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`pr-iterate.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  assert.ok(
    result !== null && result !== undefined,
    `journal 記録失敗（logged:false）でも workflow は return object を解決するべきだが null/undefined だった`,
  );
  assert.equal(
    result?.status,
    'lgtm',
    `journal 記録失敗でも result.status は 'lgtm' であるべきだが '${result?.status}' だった`,
  );
  // Write を試みて失敗した申告なので result.journal_log_status は 'log_failed'
  assert.equal(
    result?.journal_log_status,
    'log_failed',
    `journal-log が saved:true / logged:false を返す場合 result.journal_log_status は 'log_failed' のはずだが '${result?.journal_log_status}' だった`,
  );
});

test('[journal-log] journal-log が saved:false を返す場合 result.journal_log_status が save_failed になること', async () => {
  const journalResult = { saved: false, logged: false };
  const { ctx, getJournalCallCount } = makeSandbox(journalResult);

  const { result, error } = await runPrIterateCapture(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`pr-iterate.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  assert.equal(
    getJournalCallCount(),
    1,
    `journal-log の呼び出しは 1 回であるべきだが ${getJournalCallCount()} 回だった`,
  );
  assert.equal(
    result?.journal_log_status,
    'save_failed',
    `journal-log が saved:false を返す場合 result.journal_log_status は 'save_failed' のはずだが '${result?.journal_log_status}' だった`,
  );
});

// journal-log が throw した場合は Write 到達の申告が無いので journalLogStatus は初期値 'save_failed'
// のまま run が継続する（fail-open）。
test('[journal-log] journal-log が throw した場合 result.journal_log_status は save_failed のまま run 完走する（fail-open）', async () => {
  // issue #527/#533: trackedAgent のリトライは `opts.retryOnContractViolation === true` の
  // opt-in call site 限定で、journal-log の call site は opt-in していない
  // ため 'without calling StructuredOutput' を含む throw でもリトライされない。ここでは
  // 意図を明確にするため exec-proxy 実行失敗を示す別メッセージ（call count=1 想定に影響しない）を使う。
  const journalResult = new Error('exec-proxy 実行失敗: EPERM');
  const { ctx, getJournalCallCount } = makeSandbox(journalResult);

  const { result, error } = await runPrIterateCapture(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`pr-iterate.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  assert.equal(getJournalCallCount(), 1);
  assert.ok(result != null, 'journal-log の throw で workflow が落ちてはならない（fail-open）');
  assert.equal(
    result?.status,
    'lgtm',
    `journal-log throw でも result.status は 'lgtm' であるべきだが '${result?.status}' だった`,
  );
  assert.equal(
    result?.journal_log_status,
    'save_failed',
    `journal-log throw 時 result.journal_log_status は 'save_failed' のはずだが '${result?.journal_log_status}' だった`,
  );
});

// inline 区間外に journal handoff choreography の手写しが残っていないこと（否定 pin）は
// devflow-journal-log.test.mjs が dev-flow.js / pr-iterate.js の両方を test.each で見る。
