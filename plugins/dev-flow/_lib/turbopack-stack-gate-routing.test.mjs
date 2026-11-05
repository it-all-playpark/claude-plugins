// Setup(stack) routing test: dev-flow.js の Setup phase が読む args.setup.stack.frameworks
// （dev-flow-prerun の detect-stack 出力）に基づき、Turbopack fallback 規約（TURBOPACK_NOTE 経由）が
// implementer / evaluator prompt へ注入されるか否か（test prompt へは常に注入しない）を VM sandbox で pin する。
// test-helpers/vm-sandbox.mjs の makeRecordingSandbox / runDevFlowInSandbox を使い、
// args.setup.stack.frameworks だけをテストケースごとに差し替える。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeRecordingSandbox, runDevFlowInSandbox, devFlowArgs, assertNoCrash } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');

const src = readFileSync(devFlowPath, 'utf8');

function createResponder() {
  return function ({ label, agentType }) {
    if (label.startsWith('analyze')) {
      return {
        summary: 's',
        acceptance_criteria: ['a', 'b', 'c', 'd'],
        issue_type: 'fix',
        scope: 'src',
        issue_number: 1,
        issue_title: 'stub-issue-title',
      };
    }
    if (label.startsWith('danger-grep')) {
      return { ok: true, hits: [] };
    }
    if (label === 'realized-diff' || label === 'declared-path-check' || label === 'changed-files') {
      return { files: [] };
    }
    if (label.startsWith('test')) {
      return { tests: 'no_tests', green: true, summary: '' };
    }
    if (agentType === 'dev-flow:evaluator') {
      return {
        verdict: 'pass',
        total: 100,
        threshold: 80,
        feedback: [],
        feedback_level: 'implementation',
        ac_results: [],
        security_clearance: [],
      };
    }
    if (label.startsWith('pr')) {
      return { pr_url: 'http://x', pr_number: 1, committed: true };
    }
    if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) {
      return { hash: 'H', empty: false };
    }
    if (agentType === 'dev-flow:dev-implementer') {
      return { status: 'DONE', task_id: 'T1', files: ['src/a.ts'], summary: 'done', concerns: [] };
    }
    // 未処理の label（issue-meta 等）は undefined を返し、makeRecordingSandbox の既定応答へ委譲する。
    return undefined;
  };
}

async function run(frameworks) {
  const { ctx, calls } = makeRecordingSandbox(createResponder(), { args: devFlowArgs(1, { stack: { frameworks, test_runners: [] } }) });
  const error = await runDevFlowInSandbox(src, ctx);
  return { error, calls };
}

function groupPrompts(calls) {
  const implCalls = calls.filter((c) => c.agentType === 'dev-flow:dev-implementer');
  const evalCalls = calls.filter((c) => c.agentType === 'dev-flow:evaluator');
  const testCalls = calls.filter((c) => c.label.startsWith('test'));
  return { implCalls, evalCalls, testCalls };
}

// (a) frameworks: ['next'] → 注入あり
// test prompt は exec-proxy run-tests の stdout 転写だけで、転写 agent はテストを実行し直さないため
// Next.js でも規約を注入しない（issue #821）。
test('[turbopack-stack-gate] (a) frameworks:["next"] → run 完走 & implementer/evaluator prompt に Turbopack 規約が注入され、test prompt には注入されない', async () => {
  const { error, calls } = await run(['next']);
  assertNoCrash(error);
  assert.equal(error, null, `run が完走しない: ${error?.message}`);

  const { implCalls, evalCalls, testCalls } = groupPrompts(calls);
  assert.ok(implCalls.length >= 1, 'implementer が呼ばれていない');
  assert.ok(evalCalls.length >= 1, 'evaluator が呼ばれていない');
  assert.ok(testCalls.length >= 1, 'test runner が呼ばれていない');

  // 規約の識別トークン（error 名 TurbopackInternalError と fallback コマンド next build --webpack）が verbatim 到達する
  for (const c of [...implCalls, ...evalCalls]) {
    assert.ok(c.prompt.includes('TurbopackInternalError'), `prompt (label=${c.label}) に 'TurbopackInternalError' が含まれない`);
    assert.ok(c.prompt.includes('next build --webpack'), `prompt (label=${c.label}) に 'next build --webpack' が含まれない`);
    assert.ok(!/context7/i.test(c.prompt), `prompt (label=${c.label}) に 'context7' が含まれてはいけない`);
  }
  for (const c of testCalls) {
    assert.ok(!c.prompt.includes('Turbopack'), `test prompt (label=${c.label}) に 'Turbopack' が含まれてはいけない`);
    assert.ok(!c.prompt.includes('next build --webpack'), `test prompt (label=${c.label}) に 'next build --webpack' が含まれてはいけない`);
  }
});

// (b) frameworks: ['react']（Vite 相当）→ 注入なし
test('[turbopack-stack-gate] (b) frameworks:["react"] → implementer/evaluator/test prompt に Turbopack 規約が注入されない', async () => {
  const { error, calls } = await run(['react']);
  assertNoCrash(error);
  assert.equal(error, null, `run が完走しない: ${error?.message}`);

  const { implCalls, evalCalls, testCalls } = groupPrompts(calls);
  assert.ok(implCalls.length >= 1, 'implementer が呼ばれていない');
  assert.ok(evalCalls.length >= 1, 'evaluator が呼ばれていない');
  assert.ok(testCalls.length >= 1, 'test runner が呼ばれていない');

  for (const c of [...implCalls, ...evalCalls, ...testCalls]) {
    assert.ok(!c.prompt.includes('Turbopack'), `prompt (label=${c.label}) に 'Turbopack' が含まれてはいけない`);
    assert.ok(!/context7/i.test(c.prompt), `prompt (label=${c.label}) に 'context7' が含まれてはいけない`);
    assert.ok(!c.prompt.includes('TurbopackInternalError'), `prompt (label=${c.label}) に 'TurbopackInternalError' が含まれてはいけない`);
  }
});

// (c) frameworks: [] → 注入されない（frameworks 欠落は validatePrerunSetup が throw するため
// fail-open ケースは存在しない。空配列が Next.js 非検出の唯一の負ケース）
test('[turbopack-stack-gate] (c) frameworks:[] → 注入されない', async () => {
  const { error, calls } = await run([]);
  assertNoCrash(error);
  assert.equal(error, null, `run が完走しない: ${error?.message}`);

  const { implCalls, evalCalls, testCalls } = groupPrompts(calls);
  assert.ok(implCalls.length >= 1, 'implementer が呼ばれていない');
  assert.ok(evalCalls.length >= 1, 'evaluator が呼ばれていない');
  assert.ok(testCalls.length >= 1, 'test runner が呼ばれていない');

  for (const c of [...implCalls, ...evalCalls, ...testCalls]) {
    assert.ok(!c.prompt.includes('Turbopack'), `prompt (label=${c.label}) に 'Turbopack' が含まれてはいけない`);
    assert.ok(!/context7/i.test(c.prompt), `prompt (label=${c.label}) に 'context7' が含まれてはいけない`);
  }
});
