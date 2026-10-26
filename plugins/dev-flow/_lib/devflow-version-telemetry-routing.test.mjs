// F4: dev-flow.js / pr-iterate.js の成功 handoff・失敗 handoff（writeFailureTelemetry）の
// journal-log prompt に eval_model_config / review_model_config / plugin_version の telemetry キーが
// 実際に埋め込まれること、旧 quality_model_config / quality_model_fallback_label が載らないことを
// VM 挙動テストで検証する（issue #636: source anchor 走査から移行）。
// PLUGIN_VERSION 宣言のマーカー存在・plugin.json 一致は _lib/plugin-version.sync.test.mjs が
// 別途 pin する（本ファイルからは削除済み）。
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  devFlowArgs,
  makeDevFlowSandbox,
  makePrIterateSandbox,
  runWorkflowCapture,
} from './test-helpers/vm-sandbox.mjs';
import { PLUGIN_VERSION, normalizePluginCommit } from './plugin-version.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowSrc = readFileSync(join(repoRoot, '.claude/workflows/dev-flow.js'), 'utf8');
const prIterateSrc = readFileSync(join(repoRoot, '.claude/workflows/pr-iterate.js'), 'utf8');

// evaluator / pr-reviewer / dev-implementer は override を渡さないので frontmatter の 'opus'（値の一致は review-model-frontmatter.test.mjs が pin）。
// eval_model_config / impl_model_config は evaluator / dev-implementer を spawn する dev-flow 側の entry にのみ載る。
function assertJournalSaveHasKeys(calls, contextLabel, { evalModel }) {
  const journalHandoffCalls = calls.filter((c) => c.label?.startsWith('journal-log'));
  assert.ok(journalHandoffCalls.length > 0, `${contextLabel}: label 'journal-log*' の call が見つからない`);
  const has = (needle) => journalHandoffCalls.some((c) => c.prompt.includes(needle));
  if (evalModel) {
    assert.ok(has('"eval_model_config":"opus"'), `${contextLabel}: journal-log prompt に "eval_model_config":"opus" を含む call が見つからない`);
    assert.ok(has('"impl_model_config":"opus"'), `${contextLabel}: journal-log prompt に "impl_model_config":"opus" を含む call が見つからない`);
  } else {
    assert.ok(!has('"eval_model_config"'), `${contextLabel}: journal-log prompt に eval_model_config が載っている（evaluator を spawn しない workflow）`);
    assert.ok(!has('"impl_model_config"'), `${contextLabel}: journal-log prompt に impl_model_config が載っている（implementer を spawn しない workflow）`);
  }
  assert.ok(has('"review_model_config":"opus"'), `${contextLabel}: journal-log prompt に "review_model_config":"opus" を含む call が見つからない`);
  assert.ok(has(`"plugin_version":"${PLUGIN_VERSION}"`), `${contextLabel}: journal-log prompt に "plugin_version":"${PLUGIN_VERSION}" を含む call が見つからない`);
  for (const stale of ['"quality_model_config"', '"quality_model_fallback_label"']) {
    assert.ok(!has(stale), `${contextLabel}: journal-log prompt に撤去済みキー ${stale} が載っている`);
  }
}

test('dev-flow.js 成功 run の journal-log prompt が eval_model_config / review_model_config / plugin_version を含む', async () => {
  const { ctx, calls } = makeDevFlowSandbox();
  const { error } = await runWorkflowCapture(devFlowSrc, ctx, '.claude/workflows/dev-flow.js');
  assert.equal(error, null, `成功 run はエラーなく完走するべき: ${error?.message}`);
  assertJournalSaveHasKeys(calls, 'dev-flow success', { evalModel: true });
});

// empty-diff 失敗 run の model config / plugin_version / plugin_commit は
// devflow-failure-telemetry-routing.test.mjs (3) の共有 run が必須キー表で検査する。

test('dev-flow.js abort run（eval#1 null）の journal-log prompt が eval_model_config / review_model_config / plugin_version を含む', async () => {
  const { ctx, calls } = makeDevFlowSandbox({ overrides: { 'eval#1': null } });
  const { error } = await runWorkflowCapture(devFlowSrc, ctx, '.claude/workflows/dev-flow.js');
  assert.ok(error, 'eval#1 null は need() で abort するべき（model fallback による再試行は無い）');
  const evalCalls = calls.filter((c) => c.label === 'eval#1');
  assert.equal(evalCalls.length, 1, 'eval#1 は 1 回だけ呼ばれる（null でも再試行しない）');
  assertJournalSaveHasKeys(calls, 'dev-flow abort', { evalModel: true });
});

test('pr-iterate.js 単体起動 run の journal-log prompt が review_model_config / plugin_version を含み eval_model_config を含まない', async () => {
  const { ctx, calls } = makePrIterateSandbox();
  const { error } = await runWorkflowCapture(prIterateSrc, ctx, '.claude/workflows/pr-iterate.js');
  assert.equal(error, null, `pr-iterate 単体起動はエラーなく完走するべき: ${error?.message}`);
  assertJournalSaveHasKeys(calls, 'pr-iterate standalone', { evalModel: false });
});

// ── plugin_commit（issue #785）──────────────────────────────────────────────
// dev-flow-prerun が args.setup.plugin_commit で渡す plugin の commit（12 桁 hex / null）を dev-flow /
// pr-iterate の journal entry の telemetry.plugin_commit に載せる。plugin_version は集計の連続性のため併記を続ける。
const COMMIT = '1ef2e0ab6254';

function journalHandoffPrompts(calls) {
  return calls.filter((c) => c.label?.startsWith('journal-log')).map((c) => c.prompt);
}

function assertPluginCommit(calls, expected, contextLabel) {
  const prompts = journalHandoffPrompts(calls);
  assert.ok(prompts.length > 0, `${contextLabel}: label 'journal-log*' の call が見つからない`);
  const needle = `"plugin_commit":${JSON.stringify(expected)}`;
  assert.ok(prompts.some((p) => p.includes(needle)), `${contextLabel}: journal-log prompt に ${needle} が見つからない`);
  assert.ok(prompts.some((p) => p.includes(`"plugin_version":"${PLUGIN_VERSION}"`)), `${contextLabel}: plugin_version が消えている`);
}

function devFlowSandboxWithCommit(setupOverrides, { overrides = {} } = {}) {
  const workflowCalls = [];
  const sandbox = makeDevFlowSandbox({
    overrides,
    workflow: async (name, a) => {
      workflowCalls.push({ name, args: a });
      return { status: 'lgtm', iterations: 1, fixes_applied: 0 };
    },
    extra: { args: devFlowArgs(1, setupOverrides) },
  });
  return { ...sandbox, workflowCalls };
}

test('normalizePluginCommit は 12 桁 hex だけを通し、それ以外は null に倒す', () => {
  assert.equal(normalizePluginCommit(COMMIT), COMMIT);
  for (const bad of [null, undefined, '', '0.3.0', '1EF2E0AB6254', '1ef2e0ab625', '1ef2e0ab62545', 'a'.repeat(40), 123456789012, {}]) {
    assert.equal(normalizePluginCommit(bad), null, `${JSON.stringify(bad)} は null になるべき`);
  }
});

test('dev-flow.js 成功 run: args.setup.plugin_commit が journal entry と nested pr-iterate の args に載る', async () => {
  const { ctx, calls, workflowCalls } = devFlowSandboxWithCommit({ plugin_commit: COMMIT });
  const { error } = await runWorkflowCapture(devFlowSrc, ctx, '.claude/workflows/dev-flow.js');
  assert.equal(error, null, `成功 run はエラーなく完走するべき: ${error?.message}`);
  assertPluginCommit(calls, COMMIT, 'dev-flow success');
  assert.ok(workflowCalls.length > 0, 'nested workflow(pr-iterate) が起動されていない（full route 不成立）');
  for (const w of workflowCalls) {
    assert.equal(w.args?.plugin_commit, COMMIT, `nested ${w.name} の args.plugin_commit に prerun の値を渡すべき`);
  }
});

// 失敗 run（empty-diff）の plugin_commit は devflow-failure-telemetry-routing.test.mjs (3) が検査する
test('dev-flow.js abort run（eval#1 null）の journal entry にも plugin_commit が載る', async () => {
  const abort = devFlowSandboxWithCommit({ plugin_commit: COMMIT }, { overrides: { 'eval#1': null } });
  const r2 = await runWorkflowCapture(devFlowSrc, abort.ctx, '.claude/workflows/dev-flow.js');
  assert.ok(r2.error, 'eval#1 null は abort するべき');
  assertPluginCommit(abort.calls, COMMIT, 'dev-flow abort');
});

test('dev-flow.js: plugin_commit が取得できない（null / 欠落 / 不正形）でも run は止まらず plugin_commit:null を記録する', async () => {
  for (const setupOverrides of [{ plugin_commit: null }, {}, { plugin_commit: 'not-a-sha' }]) {
    const { ctx, calls } = devFlowSandboxWithCommit(setupOverrides);
    const { error } = await runWorkflowCapture(devFlowSrc, ctx, '.claude/workflows/dev-flow.js');
    assert.equal(error, null, `${JSON.stringify(setupOverrides)}: 成功 run はエラーなく完走するべき: ${error?.message}`);
    assertPluginCommit(calls, null, `dev-flow ${JSON.stringify(setupOverrides)}`);
  }
});

test('dev-flow.js: plugin_commit は gate の入力にしない（値の有無で agent 起動列と merge tier が変わらない）', async () => {
  const runOnce = async (setupOverrides) => {
    const { ctx, calls } = devFlowSandboxWithCommit(setupOverrides);
    const { result, error } = await runWorkflowCapture(devFlowSrc, ctx, '.claude/workflows/dev-flow.js');
    assert.equal(error, null, `成功 run はエラーなく完走するべき: ${error?.message}`);
    return { labels: calls.map((c) => c.label), merge_tier: result?.merge_tier, test_green: result?.test_green };
  };
  const withCommit = await runOnce({ plugin_commit: COMMIT });
  const withoutCommit = await runOnce({ plugin_commit: null });
  assert.deepEqual(withCommit, withoutCommit);
});

test('pr-iterate.js: 受けた args.plugin_commit（dev-flow の nested・単体起動の wrapper）を journal entry に載せ、未指定の直接起動は null', async () => {
  const nested = makePrIterateSandbox({ args: { pr: 5, plugin_commit: COMMIT } });
  const r1 = await runWorkflowCapture(prIterateSrc, nested.ctx, '.claude/workflows/pr-iterate.js');
  assert.equal(r1.error, null, `pr-iterate はエラーなく完走するべき: ${r1.error?.message}`);
  assertPluginCommit(nested.calls, COMMIT, 'pr-iterate with plugin_commit');

  // 単体起動: wrapper が pr-iterate-prerun の plugin_commit を nested（caller:'standalone'）と一緒に渡す
  const standalone = makePrIterateSandbox({ args: { pr: 5, plugin_commit: COMMIT, nested: { caller: 'standalone', cwd: '/tmp/wt', head_ref: 'feature/x', base_ref: 'main' } } });
  const r2 = await runWorkflowCapture(prIterateSrc, standalone.ctx, '.claude/workflows/pr-iterate.js');
  assert.equal(r2.error, null, `pr-iterate 単体起動はエラーなく完走するべき: ${r2.error?.message}`);
  assertPluginCommit(standalone.calls, COMMIT, 'pr-iterate standalone');

  const direct = makePrIterateSandbox();
  const r3 = await runWorkflowCapture(prIterateSrc, direct.ctx, '.claude/workflows/pr-iterate.js');
  assert.equal(r3.error, null, `pr-iterate 直接起動はエラーなく完走するべき: ${r3.error?.message}`);
  assertPluginCommit(direct.calls, null, 'pr-iterate direct');
});

test('pr-iterate.js abort run の journal entry にも plugin_commit が載る', async () => {
  const { ctx, calls } = makePrIterateSandbox({ args: { pr: 5, plugin_commit: COMMIT }, overrides: { 'review#1': null } });
  await runWorkflowCapture(prIterateSrc, ctx, '.claude/workflows/pr-iterate.js');
  const prompts = journalHandoffPrompts(calls);
  assert.ok(prompts.some((p) => p.includes(`"plugin_commit":"${COMMIT}"`)), `pr-iterate の journal-log prompt に plugin_commit が無い: ${prompts.length} 件`);
});
