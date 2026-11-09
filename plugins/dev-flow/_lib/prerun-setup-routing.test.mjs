// _lib/prerun-setup-routing.test.mjs（issue #641。setup-deps-routing.test.mjs の後継として改名・全面
// 書き直し）
//
// dev-flow.js の Setup phase が args.setup（dev-flow-prerun の stdout JSON）駆動になったことを
// VM sandbox で pin する。旧 setup-base / worktree / isolation-cleanup / worktree-deps の 4 spawn は
// 撤去され、Setup の agent() 呼び出しは isolation-probe 1 回のみになる。
//
// テストケース:
//   (a) 既定 args → Setup の spawn は isolation-probe 1 回のみ。4 label は run 全体で 0 件
//   (b) args.setup 欠落 → fail-closed throw（args.setup が無い）
//   (c) args.setup.ok:false → fail-closed throw（エラー詳細を含む）
//   (d) args.setup 必須キー欠落（epoch）→ fail-closed throw
//   (e) args.setup.worktree が相対パス → fail-closed throw
//   (f) args.base（旧形式）→ phase 前に即 throw（agent call 0 件）
//   (g) args.setup.deps.ok:false → implementer prompt に依存インストール警告が注入される
//   (h) 既定（deps ok）→ implementer prompt に依存インストール警告が注入されない
//   (i) args.setup.repo → journal-log prompt に "repo" キーが載る（既定は省略）
//   (j) args.setup.epoch → isolation-probe prompt の token に反映される

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash, devFlowArgs } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const devFlowPath = join(here, '..', '.claude/workflows/dev-flow.js');
const src = readFileSync(devFlowPath, 'utf8');

const DEAD_LABELS = ['setup-base', 'worktree', 'isolation-cleanup', 'worktree-deps'];

// ── (a) Setup の spawn は観測型の分類 agent・isolation-probe・テストコマンドの解決の 1 回ずつ ──

test('[prerun-setup-routing] (a) 既定 args → Setup の spawn は観測型の分類 agent・isolation-probe・テストコマンドの解決の 1 回ずつ、旧 4 label は 0 件', async () => {
  const { ctx, calls } = makeDevFlowSandbox();
  const { error } = await runWorkflowCapture(src, ctx);
  assertNoCrash(error, 'a');
  assert.equal(error, null, `run は完走するはずだが throw した: ${error?.message}`);

  // Setup / Analyze ゲートは args.setup 駆動で spawn せず、ゲート通過後に観測型の分類 agent、続けて isolation-probe、
  // テストコマンドの解決（dev-flow-test-commands。既定は base に tests/run-*.sh があり resolver を起動しない）が Implement の前
  const implIdx = calls.findIndex((c) => c.agentType === 'dev-flow:dev-implementer');
  assert.notStrictEqual(implIdx, -1, 'dev-implementer の call が見つからない');
  const beforeImpl = calls.slice(0, implIdx);
  assert.deepEqual(
    beforeImpl.map((c) => ({ label: c.label, agentType: c.agentType })),
    [
      { label: 'ac-observational#1', agentType: 'dev-flow:dev-runner' },
      { label: 'isolation-probe', agentType: 'dev-flow:dev-runner-haiku-wo' },
      { label: 'resolve-test-commands', agentType: 'dev-flow:dev-runner-haiku' },
    ],
    `Implement より前の call は ac-observational#1・isolation-probe・resolve-test-commands の 3 件のはずだが: ${JSON.stringify(beforeImpl.map((c) => c.label))}`,
  );

  for (const label of DEAD_LABELS) {
    assert.ok(!calls.some((c) => c.label === label), `label '${label}' の call が run 全体で観測された（撤去されたはずの spawn）`);
  }
});

// ── (b)-(e) fail-closed abort 共通アサート ──

async function assertAbort(args, msgSubstrs) {
  const { ctx, calls } = makeDevFlowSandbox({ extra: { args } });
  const { error } = await runWorkflowCapture(src, ctx);
  assert.ok(error, `args=${JSON.stringify(args)} で throw されるべきだが完走した`);
  for (const s of msgSubstrs) {
    assert.ok(String(error.message).includes(s), `error.message に '${s}' が含まれない: ${error.message}`);
  }
  const nonJournal = calls.filter((c) => c.label !== 'journal-log-abort');
  assert.equal(nonJournal.length, 0, `journal-log-abort 以外の call が観測された: ${JSON.stringify(nonJournal.map((c) => c.label))}`);

  const save = calls.find((c) => c.label === 'journal-log-abort');
  assert.ok(save, 'journal-log-abort が呼ばれていない');
  assert.ok(
    save.prompt.includes('~/.claude/journal/pending/devflow-1-effect-'),
    `journal-log-abort prompt に pending パスが含まれない: ${save.prompt.slice(0, 400)}`,
  );
  assert.ok(
    save.prompt.includes('abort@Setup/prerun-setup:'),
    `journal-log-abort prompt に 'abort@Setup/prerun-setup:' が含まれない: ${save.prompt.slice(0, 400)}`,
  );
  return { error };
}

test('[prerun-setup-routing] (b) args.setup 欠落 → fail-closed throw（args.setup が無い）', async () => {
  await assertAbort({ issue: '1' }, ["args.setup が無い", "ensure-worktree-deps --setup"]);
});

test('[prerun-setup-routing] (c) args.setup.ok:false → fail-closed throw', async () => {
  await assertAbort(devFlowArgs(1, { ok: false, worktree_error: 'boom' }), ['boom']);
});

test('[prerun-setup-routing] (d) args.setup 必須キー欠落（epoch）→ fail-closed throw', async () => {
  await assertAbort(devFlowArgs(1, { epoch: undefined }), ['必須キーが欠落/型不正: epoch']);
});

test('[prerun-setup-routing] (e) args.setup.worktree が相対パス → fail-closed throw', async () => {
  await assertAbort(devFlowArgs(1, { worktree: 'relative/wt' }), ['worktree']);
});

// ── (f) args.base（旧形式）→ phase 前に即 throw、agent call 0 件 ──

test('[prerun-setup-routing] (f) args.base（旧形式）→ phase 前に即 throw、agent call 0 件', async () => {
  const { ctx, calls } = makeDevFlowSandbox({ extra: { args: { ...devFlowArgs(1), base: 'dev' } } });
  const { error } = await runWorkflowCapture(src, ctx);
  assert.ok(error, 'args.base 指定で throw されるべきだが完走した');
  assert.ok(String(error.message).includes('args.base は受理しない'), `error.message に 'args.base は受理しない' が含まれない: ${error.message}`);
  assert.equal(calls.length, 0, `agent call が 0 件のはずだが ${calls.length} 件observedされた: ${JSON.stringify(calls.map((c) => c.label))}`);
});

// ── (g)(h) deps advisory 警告の implementer prompt 注入 ──

test('[prerun-setup-routing] (g) args.setup.deps.ok:false → implementer prompt に依存インストール警告が注入される', async () => {
  const { ctx, calls } = makeDevFlowSandbox({ extra: { args: devFlowArgs(1, { deps: { ok: false, note: 'npm/npm (npm ci): failed' } }) } });
  const { error } = await runWorkflowCapture(src, ctx);
  assertNoCrash(error, 'g');
  assert.equal(error, null, `run は完走するはずだが throw した: ${error?.message}`);

  const implCalls = calls.filter((c) => c.agentType === 'dev-flow:dev-implementer');
  assert.ok(implCalls.length >= 1, 'implementer が呼ばれていない');
  for (const c of implCalls) {
    assert.ok(c.prompt.includes('依存インストール警告'), `implementer prompt (label=${c.label}) に '依存インストール警告' が含まれない`);
    assert.ok(c.prompt.includes('npm ci'), `implementer prompt (label=${c.label}) に 'npm ci' が含まれない`);
  }
});

test('[prerun-setup-routing] (h) 既定（deps ok）→ implementer prompt に依存インストール警告が注入されない', async () => {
  const { ctx, calls } = makeDevFlowSandbox();
  const { error } = await runWorkflowCapture(src, ctx);
  assertNoCrash(error, 'h');
  assert.equal(error, null, `run は完走するはずだが throw した: ${error?.message}`);

  const implCalls = calls.filter((c) => c.agentType === 'dev-flow:dev-implementer');
  assert.ok(implCalls.length >= 1, 'implementer が呼ばれていない');
  for (const c of implCalls) {
    assert.ok(!c.prompt.includes('依存インストール警告'), `implementer prompt (label=${c.label}) に依存インストール警告が含まれてはいけない`);
  }
});

// ── (i) repo の journal handoff payload への反映 ──

test('[prerun-setup-routing] (i) args.setup.repo → journal-log prompt に "repo" キーが載る', async () => {
  const { ctx, calls } = makeDevFlowSandbox({ extra: { args: devFlowArgs(1, { repo: 'acme/skills' }) } });
  const { error } = await runWorkflowCapture(src, ctx);
  assertNoCrash(error, 'i-with-repo');
  assert.equal(error, null, `run は完走するはずだが throw した: ${error?.message}`);
  const save = calls.find((c) => c.label === 'journal-log');
  assert.ok(save, 'journal-log が呼ばれていない');
  assert.ok(save.prompt.includes('"repo":"acme/skills"'), `journal-log prompt に "repo":"acme/skills" が含まれない: ${save.prompt.slice(0, 400)}`);
});

test('[prerun-setup-routing] (i) repo 無し（既定）→ journal-log prompt に "repo" キーを含まない', async () => {
  const { ctx, calls } = makeDevFlowSandbox();
  const { error } = await runWorkflowCapture(src, ctx);
  assertNoCrash(error, 'i-without-repo');
  assert.equal(error, null, `run は完走するはずだが throw した: ${error?.message}`);
  const save = calls.find((c) => c.label === 'journal-log');
  assert.ok(save, 'journal-log が呼ばれていない');
  assert.ok(!save.prompt.includes('"repo"'), `journal-log prompt に "repo" キーが含まれてはいけない: ${save.prompt.slice(0, 400)}`);
});

// ── (j) epoch の isolation-probe token への反映 ──

test('[prerun-setup-routing] (j) args.setup.epoch → isolation-probe prompt に .isolation-probe-<epoch> が含まれる', async () => {
  const { ctx, calls } = makeDevFlowSandbox({ extra: { args: devFlowArgs(1, { epoch: 4321 }) } });
  const { error } = await runWorkflowCapture(src, ctx);
  assertNoCrash(error, 'j');
  assert.equal(error, null, `run は完走するはずだが throw した: ${error?.message}`);
  const probe = calls.find((c) => c.label === 'isolation-probe');
  assert.ok(probe, 'isolation-probe が呼ばれていない');
  assert.match(probe.prompt, /\.isolation-probe-4321/, `isolation-probe prompt に .isolation-probe-4321 が含まれない: ${probe.prompt}`);
});
