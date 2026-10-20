// pr-iterate.js の終端情報（terminal_path / fix_terminal_reason / history）が返り値に載り、
// telemetry（journal-log payload）は merge_tier / iterate_status / review_model_config /
// plugin_version / plugin_commit だけを書くことの検証テスト。issue #601 / #789。
// telemetryHandoff（journal-log prompt に verbatim 転写される payload）は
// <<<JOURNAL_HANDOFF_BODY_BEGIN>>> / <<<JOURNAL_HANDOFF_BODY_END>>> の間を JSON.parse して検証する。
//
// CI-failed ラウンドは per-round 投稿なし（issue #392 で post-review#i を廃止し終端の post-summary 1 回に統合）で
// 返り値 history と終端 post-summary（反復履歴・全 blocking 詳細の <details>）に反映される。
//
// harness は test-helpers/vm-sandbox.mjs の makePrIterateSandbox / prIterateRounds / runWorkflowCapture。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PLUGIN_VERSION } from './plugin-version.mjs';
import { makePrIterateSandbox, prIterateRounds, runWorkflowCapture } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', '.claude/workflows/pr-iterate.js'), 'utf8');

function extractJournalPayload(prompt) {
  const body = prompt.split('<<<JOURNAL_HANDOFF_BODY_BEGIN>>>')[1].split('<<<JOURNAL_HANDOFF_BODY_END>>>')[0].trim();
  return JSON.parse(body);
}

// commit-ensure は既定で「commit 対象なし」（未指定だと fail-safe で fix_failed になる。issue #437）
function makeSandbox({ reviewerStub, fixSequence = [], commitEnsureResult, ciResponses = [] }) {
  const { ctx, calls } = makePrIterateSandbox({
    rounds: prIterateRounds({
      reviewer: reviewerStub,
      fix: fixSequence,
      ci: ciResponses,
      commitEnsure: commitEnsureResult === undefined ? { dirty: false, committed: false, pushed: false } : commitEnsureResult,
    }),
  });
  return { ctx, getAgentCalls: () => calls };
}

const runPrIterateCapture = (source, ctx) => runWorkflowCapture(source, ctx, '.claude/workflows/pr-iterate.js');

function assertNoCrash(error) {
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`pr-iterate.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }
}

test('[terminal-telemetry] CI 経路 applied_false: fix_terminal_reason=applied_false / terminal_path=ci', async () => {
  const { ctx } = makeSandbox({
    reviewerStub: () => ({ decision: 'approve', issues: [], summary: 'ok' }),
    ciResponses: [{ status: 'failed', passed: 0, failed: 1, pending: 0, skipped: 0, failed_checks: [{ name: 'bats', bucket: 'fail', state: 'FAILURE' }], waited_seconds: 0, poll_attempts: 1 }],
    fixSequence: [{ applied: false, summary: 'no' }],
  });

  const { result, error } = await runPrIterateCapture(src, ctx);
  assertNoCrash(error);

  assert.equal(result?.status, 'fix_failed', `status は fix_failed であるべきだが '${result?.status}' だった`);
  assert.equal(result.fix_terminal_reason, 'applied_false');
  assert.equal(result.terminal_path, 'ci');
});

test('[terminal-telemetry] review 経路 null_after_retry: fix_terminal_reason=null_after_retry / terminal_path=review', async () => {
  const { ctx } = makeSandbox({
    reviewerStub: () => ({ decision: 'request-changes', issues: [{ severity: 'major', topic: 't1', description: 'd', suggestion: 's' }], summary: 'ng' }),
    fixSequence: [null, null],
  });

  const { result, error } = await runPrIterateCapture(src, ctx);
  assertNoCrash(error);

  assert.equal(result?.status, 'fix_failed', `status は fix_failed であるべきだが '${result?.status}' だった`);
  assert.equal(result.fix_terminal_reason, 'null_after_retry');
  assert.equal(result.terminal_path, 'review');
});

test('[terminal-telemetry] review 経路 commit_unensured: fix_terminal_reason=commit_unensured / terminal_path=review', async () => {
  const { ctx } = makeSandbox({
    reviewerStub: () => ({ decision: 'request-changes', issues: [{ severity: 'major', topic: 't1', description: 'd', suggestion: 's' }], summary: 'ng' }),
    fixSequence: [{ applied: true, summary: 'fixed', files: [] }],
    commitEnsureResult: null,
  });

  const { result, error } = await runPrIterateCapture(src, ctx);
  assertNoCrash(error);

  assert.equal(result?.status, 'fix_failed', `status は fix_failed であるべきだが '${result?.status}' だった`);
  assert.equal(result.fix_terminal_reason, 'commit_unensured');
  assert.equal(result.terminal_path, 'review');
});

test('[terminal-telemetry] 即 lgtm: fix_terminal_reason null / terminal_path=review / history 1 round、telemetry は merge_tier / iterate_status / ci_wait_ceiling_seconds / ci_wait_seconds / review_model_config / plugin_version / plugin_commit だけ', async () => {
  const { ctx, getAgentCalls } = makeSandbox({
    reviewerStub: () => ({ decision: 'approve', issues: [], summary: 'ok' }),
    ciResponses: [{ status: 'passed', passed: 1, failed: 0, pending: 0, skipped: 0, failed_checks: [], waited_seconds: 0, poll_attempts: 1 }],
  });

  const { result, error } = await runPrIterateCapture(src, ctx);
  assertNoCrash(error);

  assert.equal(result?.status, 'lgtm', `status は lgtm であるべきだが '${result?.status}' だった`);
  assert.equal(result.fix_terminal_reason, null, 'lgtm 終端では fix_terminal_reason は null');
  assert.equal(result.terminal_path, 'review');
  assert.ok(Array.isArray(result.history) && result.history.length === 1, 'history は length 1 の配列であるべき');
  assert.equal(result.history[0].decision, 'approve');
  assert.deepEqual(JSON.parse(JSON.stringify(result.history[0].blocking)), []);

  const journalCall = getAgentCalls().find((c) => c.label === 'journal-log');
  assert.ok(journalCall != null, 'label===journal-log の agent 呼び出しが存在するべき');
  const telemetry = extractJournalPayload(journalCall.prompt).telemetry;
  assert.deepEqual(
    Object.keys(telemetry).sort(),
    ['ci_wait_ceiling_seconds', 'ci_wait_seconds', 'iterate_status', 'merge_tier', 'plugin_commit', 'plugin_version', 'review_model_config'],
    `pr-iterate の成功 telemetry キーが想定外: ${JSON.stringify(telemetry)}`,
  );
  assert.equal(telemetry.ci_wait_ceiling_seconds, 300, '上限未指定の run は既定 300 秒');
  assert.equal(telemetry.ci_wait_seconds, 0, 'CI が初回 poll で passed なら待機 0 秒');
  assert.equal(telemetry.merge_tier, 'PR_ITERATE');
  assert.equal(telemetry.iterate_status, 'lgtm');
  assert.equal(telemetry.review_model_config, 'opus', 'pr-reviewer は override 無し → frontmatter の opus');
  assert.equal(telemetry.plugin_version, PLUGIN_VERSION);
  assert.equal(telemetry.plugin_commit, null, '単体起動は prerun を経ないので plugin_commit は null');
});

test('[terminal-telemetry] CI failed→fix→passed の 2 round: history に synthetic ci:: finding / terminal_path=review、per-round 投稿なしで終端 post-summary に反映される', async () => {
  const { ctx, getAgentCalls } = makeSandbox({
    reviewerStub: () => ({ decision: 'approve', issues: [], summary: 'ok' }),
    ciResponses: [
      { status: 'failed', passed: 0, failed: 1, pending: 0, skipped: 0, failed_checks: [{ name: 'bats', bucket: 'fail', state: 'FAILURE' }], waited_seconds: 0, poll_attempts: 1 },
      { status: 'passed', passed: 1, failed: 0, pending: 0, skipped: 0, failed_checks: [], waited_seconds: 0, poll_attempts: 1 },
    ],
    fixSequence: [{ applied: true, summary: 'fixed', files: [] }],
  });

  const { result, error } = await runPrIterateCapture(src, ctx);
  assertNoCrash(error);

  assert.equal(result?.status, 'lgtm', `status は lgtm であるべきだが '${result?.status}' だった`);
  assert.equal(result.iterations, 2, `result.iterations は 2 であるべきだが ${result?.iterations} だった`);

  const history = result.history;
  assert.equal(history.length, 2, 'history は 2 round であるべき');
  assert.ok(history[0].blocking.length >= 1, '1 round 目の blocking は 1 件以上であるべき');
  assert.ok(history[0].blocking[0].topic.startsWith('ci::'), '1 round 目の blocking topic は ci:: で始まるべき');
  assert.equal(history[0].blocking[0].severity, 'critical');
  assert.equal(history[1].blocking.length, 0);
  assert.equal(result.terminal_path, 'review', '最終 iteration は CI passed による lgtm なので terminal_path は review であるべき');
  // CI-failed round の synthetic topic は responder が返した check 名 'bats' を含む
  const historyTopics = history.flatMap((h) => (h.blocking ?? []).map((b) => b.topic));
  assert.ok(historyTopics.includes('ci::bats'), `返り値 history に synthetic topic "ci::bats" が含まれるべき: ${JSON.stringify(history)}`);

  const agentCalls = getAgentCalls();
  // per-round の post-review#i 投稿は廃止済み（issue #392 AC-1）— 否定検証はここ 1 か所に置く
  assert.equal(
    agentCalls.find((c) => c.label === 'post-review#1'),
    undefined,
    `label==='post-review#1' の agent 呼び出しは存在しないはずだが見つかった。呼び出しラベル一覧: ${agentCalls.map((c) => c.label).join(', ')}`,
  );
  // 終端 post-summary に反復履歴の iter 1 / 2 行（データ echo）と全 blocking 詳細の 'CI check failed: bats' が載る
  const postSummary = agentCalls.find((c) => c.label === 'post-summary');
  assert.ok(postSummary != null, `label==='post-summary' の agent 呼び出しが存在するべき。呼び出しラベル一覧: ${agentCalls.map((c) => c.label).join(', ')}`);
  for (const needle of ['| 1 |', '| 2 |', 'CI check failed: bats']) {
    assert.ok(postSummary.prompt.includes(needle), `post-summary の prompt に '${needle}' が含まれるべきだが含まれない。\nprompt の先頭1000文字: ${postSummary.prompt.slice(0, 1000)}`);
  }
});
