// dev-flow.js の phase() 実呼び出し順と diff-gate 系の phase 配線を VM 挙動テストで検証する
// （issue #636: meta.phases の title 一覧はソース regex 抽出でしか観測できず、実 phase() 呼び出し
// 順のみが実挙動を担保するため source-regex による meta.phases title pin は削除した）。
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, runDevFlowInSandbox } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');
const src = readFileSync(devFlowPath, 'utf8');

const EXPECTED_PHASES = [
  'Setup',
  'Implement',
  'Validate',
  'Diff triage',
  'Evaluate',
  'PR',
  'Final reconcile',
  'Merge tier',
];

test('phase() 呼び出し順が既定 run（fixes_applied:0）で期待する 8 phase と完全一致する（issue #678 で Plan phase、#695 で Analyze phase 撤去）', async () => {
  const { ctx, phases } = makeDevFlowSandbox();
  const error = await runDevFlowInSandbox(src, ctx);
  assert.equal(error, null, `既定 run はエラーなく完走するべき: ${error?.message}`);
  assert.deepEqual(phases, EXPECTED_PHASES);
});

test("label 'diff-gate' の全 call が opts.phase === 'Validate' を持つ", async () => {
  const { ctx, calls } = makeDevFlowSandbox();
  await runDevFlowInSandbox(src, ctx);

  const diffGateCalls = calls.filter((c) => c.label === 'diff-gate');
  assert.ok(diffGateCalls.length > 0, "label 'diff-gate' の call が見つからない");
  for (const call of diffGateCalls) {
    assert.equal(call.opts.phase, 'Validate');
  }
});

test("label 'diff-gate-retry' の call が opts.phase === 'Validate' を持つ（empty-diff で到達させる）", async () => {
  const { ctx, calls } = makeDevFlowSandbox({
    overrides: { 'diff-gate': { hash: 'H', empty: true } },
  });
  await runDevFlowInSandbox(src, ctx);

  const retryCalls = calls.filter((c) => c.label === 'diff-gate-retry');
  assert.ok(retryCalls.length > 0, "label 'diff-gate-retry' の call が見つからない");
  for (const call of retryCalls) {
    assert.equal(call.opts.phase, 'Validate');
  }
});

// empty-diff gate の throw と journal-log の error_category:empty_diff / phase:Validate は
// devflow-failure-telemetry-routing.test.mjs (3) の共有 run が検査する。

test("全 run で calls に label 'declared-path-check' が存在しない（F3 porcelain 統合済み）", async () => {
  const { ctx, calls } = makeDevFlowSandbox();
  await runDevFlowInSandbox(src, ctx);
  assert.ok(!calls.some((c) => c.label === 'declared-path-check'));
});
