// _lib/hooks-not-running-routing.test.mjs
// args.setup.hooks_not_running（対象 repo が追跡している git hook のうち worktree で動かない event）が人間に届く経路と、
// 開示だけで判定を変えないことを VM 実行で pin する。
//   (a) 非空の run: 投稿する終端サマリーに event 名と core.hooksPath の直し方が載る
//   (b) 空の run: 載らない
//   (c) merge tier（REVIEW / HOLD）・理由は空の run と変わらず、サマリーの差はその 1 行だけ

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash, devFlowArgs, mergeTierFacts } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', '.claude/workflows/dev-flow.js'), 'utf8');

const NOT_RUNNING = ['pre-commit', 'commit-msg', 'pre-push'];

async function run(hooksNotRunning, overrides = {}) {
  const { ctx, calls } = makeDevFlowSandbox({
    overrides,
    extra: { args: devFlowArgs(1, { hooks_not_running: hooksNotRunning }) },
  });
  const { result, error } = await runWorkflowCapture(src, ctx);
  assertNoCrash(error, 'hooks-not-running');
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  const summaryPrompt = calls.find((c) => c.label === 'post-summary')?.prompt;
  assert.ok(summaryPrompt, '終端サマリーの投稿が走っていない');
  return { result, summaryPrompt };
}

test('[hooks-not-running] (a) 非空の run は投稿する終端サマリーに event 名と core.hooksPath の直し方が載る', async () => {
  const { summaryPrompt } = await run(NOT_RUNNING);
  assert.ok(summaryPrompt.includes('動いていない git hook: `pre-commit`, `commit-msg`, `pre-push`'), summaryPrompt);
  assert.ok(summaryPrompt.includes('メイン checkout 側の絶対パスを `core.hooksPath` に設定すれば worktree からも解決される'), summaryPrompt);
});

test('[hooks-not-running] (b) 空の run は載らない', async () => {
  const { summaryPrompt } = await run([]);
  assert.ok(!summaryPrompt.includes('動いていない git hook'), summaryPrompt);
  assert.ok(!summaryPrompt.includes('core.hooksPath'), summaryPrompt);
});

test.each([
  ['REVIEW', {}],
  ['HOLD', { 'merge-tier-facts': mergeTierFacts({ pr: { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', headRefOid: 'a'.repeat(40) } }) }],
])('[hooks-not-running] (c) %s の run は非空でも merge tier・理由が変わらず、サマリーの差は開示の 1 行だけ', async (tier, overrides) => {
  const without = await run([], overrides);
  const withHooks = await run(NOT_RUNNING, overrides);
  assert.equal(without.result.merge_tier, tier);
  assert.equal(withHooks.result.merge_tier, tier);
  assert.deepEqual([...withHooks.result.merge_tier_reasons], [...without.result.merge_tier_reasons]);
  assert.ok(withHooks.summaryPrompt.includes(`<!-- dev-flow:${tier}`), withHooks.summaryPrompt);
  const dropDisclosure = (s) => s.split('\n').filter((l) => !l.includes('動いていない git hook')).join('\n');
  assert.equal(dropDisclosure(withHooks.summaryPrompt), without.summaryPrompt);
});
