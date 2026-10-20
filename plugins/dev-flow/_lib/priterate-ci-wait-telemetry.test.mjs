// F2: CI ポーリング配線の検証テスト（TDD）。
// AC-1: CI の判定で pr-iterate が LGTM へ進む。
// AC-7: waited_seconds/poll_attempts が終端サマリー / return に反映される。
// issue #1046: 使った上限 ci_wait_ceiling_seconds と待ち秒数 ci_wait_seconds を、nested・単体起動とも
// return と journal telemetry の両方に載せる。
// issue #488: fetch は subagent の bare `gh pr checks`、check-ci.sh はその snapshot に対する
// 純変換。ポーリングは pr-iterate.js の script 側 ci-wait ループが持つ（issue #663）。
// dispatch された ci-check prompt の正負 grep は priterate-ci-failopen.test.mjs (c)（canonical との一致）と
// ci-check.test.mjs（canonical 本文）が持つ。
//
// harness は test-helpers/vm-sandbox.mjs の makePrIterateSandbox / prIterateRounds / runWorkflowCapture。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makePrIterateSandbox, prIterateRounds, runWorkflowCapture } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', '.claude/workflows/pr-iterate.js'), 'utf8');

// reviewer は常に approve、fix は applied、commit-ensure は「commit 対象なし」（未指定だと fail-safe で fix_failed。issue #437）
function makeSandbox({ ciResponses }) {
  const { ctx, calls } = makePrIterateSandbox({
    rounds: prIterateRounds({
      reviewer: () => ({ decision: 'approve', issues: [], summary: 'ok' }),
      fix: [{ applied: true, summary: 'fixed', files: [] }],
      ci: ciResponses,
      commitEnsure: { dirty: false, committed: false, pushed: false },
    }),
  });
  return { ctx, getAgentCalls: () => calls };
}

const runPrIterateCapture = (source, ctx) => runWorkflowCapture(source, ctx, '.claude/workflows/pr-iterate.js');

test('[ci-wait-telemetry] AC-1: failed -> fix -> passed で LGTM に進み、poll_attempts は script 側で 2 回積算・agent 報告の waited_seconds は積算しない', async () => {
  const { ctx, getAgentCalls } = makeSandbox({
    ciResponses: [
      { status: 'failed', passed: 0, failed: 1, pending: 0, skipped: 0, failed_checks: [{ name: 'bats', bucket: 'fail', state: 'FAILURE' }], waited_seconds: 30, poll_attempts: 3 },
      { status: 'passed', passed: 1, failed: 0, pending: 0, skipped: 0, failed_checks: [], waited_seconds: 10, poll_attempts: 2 },
    ],
  });

  const { result, error } = await runPrIterateCapture(src, ctx);
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`pr-iterate.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  assert.equal(result?.status, 'lgtm', `2 回目の CI check で passed になり LGTM へ進むべきだが '${result?.status}' だった`);
  assert.equal(result?.iterations, 2, `2 iteration（1回目 failed→fix、2回目 passed）で終端するべきだが ${result?.iterations} だった`);

  // script 側積算: wait 0 回 / poll 2 回（agent 報告値は読まない。issue #663）。
  assert.equal(result?.ci_wait_seconds, 0, `result.ci_wait_seconds は script 側積算で 0 であるべきだが ${result?.ci_wait_seconds} だった`);
  assert.equal(result?.ci_poll_attempts, 2, `result.ci_poll_attempts は script 側積算で 2 であるべきだが ${result?.ci_poll_attempts} だった`);

  // 終端サマリー投稿（post-summary）自体が行われたことは維持しつつ、本文の見出し文言ではなく
  // routing（terminal_path）で CI 待機経路の反映を検証する（issue #636: 自然言語 pin の除去）。
  // このシナリオは 2 回目の CI check で passed になり、review 経路のまま終端する
  // （CI-failed 分岐は各 iteration 冒頭で 'review' に戻すため、直近 iteration が CI-failed で
  // 終わっていない限り 'review' のまま — issue #601）。
  const postSummary = getAgentCalls().find((c) => c.label === 'post-summary');
  assert.ok(postSummary != null, 'label===post-summary の agent 呼び出しが存在するべき');
  assert.equal(result?.terminal_path, 'review', `result.terminal_path は 'review' であるべきだが '${result?.terminal_path}' だった`);
});

test('[ci-wait-telemetry] ci-check#1 が即 no_checks（poll 1 回・待機なし）で終端しても lgtm で、ci_wait_seconds=0 / ci_poll_attempts=1 を返す', async () => {
  const { ctx } = makeSandbox({
    ciResponses: [{ status: 'no_checks', passed: 0, failed: 0, pending: 0, skipped: 0, failed_checks: [], waited_seconds: 0, poll_attempts: 1 }],
  });

  const { result, error } = await runPrIterateCapture(src, ctx);
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`pr-iterate.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  assert.equal(result?.status, 'lgtm');
  assert.equal(result?.ci_wait_seconds, 0, `no_checks・poll 1 回でも waited_seconds=0 ならば累積 0 のはずだが ${result?.ci_wait_seconds} だった`);
  assert.equal(result?.ci_poll_attempts, 1, `poll_attempts=1 が累積されるべきだが ${result?.ci_poll_attempts} だった`);
});

// ---- 上限と待ち秒数を返り値と journal telemetry に残す（issue #1046） ----
// journal-log の prompt に載る handoff JSON（delimiter の間）の telemetry を読む。
function handoffTelemetry(calls) {
  const save = calls.find((c) => c.label === 'journal-log');
  assert.ok(save, `journal-log が呼ばれていない: ${calls.map((c) => c.label).join(', ')}`);
  const m = save.prompt.match(/<<<JOURNAL_HANDOFF_BODY_BEGIN>>>\n([\s\S]*?)\n<<<JOURNAL_HANDOFF_BODY_END>>>/);
  assert.ok(m, 'journal-log prompt に JOURNAL_HANDOFF_BODY delimiter が見つからない');
  return JSON.parse(m[1]).telemetry;
}

const NESTED = { cwd: '/tmp/wt', head_ref: 'feature/x', base_ref: 'main', repo: 'acme/skills' };
const pendingOnce = {
  'ci-check#1': { status: 'pending', passed: 0, failed: 0, pending: 1, skipped: 0, failed_checks: [] },
  'ci-wait-check#1.2': { slept: true, status: 'pending', passed: 0, failed: 0, pending: 1, skipped: 0, failed_checks: [] },
  'ci-wait-check#1.3': { slept: true, status: 'passed', passed: 1, failed: 0, pending: 0, skipped: 0, failed_checks: [] },
};

for (const [name, args] of [
  ['nested（dev-flow）', { pr: 5, ci_wait_ceiling_seconds: 515, nested: { ...NESTED, caller: 'dev-flow' } }],
  ['単体起動（standalone）', { pr: 5, ci_wait_ceiling_seconds: 515, nested: { ...NESTED, caller: 'standalone' } }],
]) {
  test(`[ci-wait-telemetry] ${name}: 使った上限 ci_wait_ceiling_seconds と待ち秒数 ci_wait_seconds が返り値と journal telemetry の両方に載る`, async () => {
    const { ctx, calls } = makePrIterateSandbox({ overrides: pendingOnce, args });
    const { result, error } = await runPrIterateCapture(src, ctx);
    assert.equal(error, null, `run が throw した: ${error?.message}`);
    assert.equal(result?.status, 'lgtm');
    assert.equal(result?.ci_wait_ceiling_seconds, 515);
    assert.equal(result?.ci_wait_seconds, 90);
    const telemetry = handoffTelemetry(calls);
    assert.equal(telemetry.ci_wait_ceiling_seconds, 515, `telemetry: ${JSON.stringify(telemetry)}`);
    assert.equal(telemetry.ci_wait_seconds, 90, `telemetry: ${JSON.stringify(telemetry)}`);
  });
}

test('[ci-wait-telemetry] 上限が渡されない run は ci_wait_ceiling_seconds=300 を返り値と journal telemetry に載せる', async () => {
  const { ctx, calls } = makePrIterateSandbox();
  const { result, error } = await runPrIterateCapture(src, ctx);
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  assert.equal(result?.ci_wait_ceiling_seconds, 300);
  const telemetry = handoffTelemetry(calls);
  assert.equal(telemetry.ci_wait_ceiling_seconds, 300);
  assert.equal(telemetry.ci_wait_seconds, result?.ci_wait_seconds);
});
