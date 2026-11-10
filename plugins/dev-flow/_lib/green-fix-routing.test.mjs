// _lib/green-fix-routing.test.mjs
// Validate の green-fix（test 1 回目 red → green-fix#1 → test 2 回目 green）が Evaluate に届ける内容を、
// 3 シナリオの共有 run で検査する。各シナリオは 1 回だけ sandbox 実行し、検査ごとに test を分ける。
//
//   standard: green-fix の申告（files / summary / concerns）が eval#1 の prompt に echo される
//             （state→prompt のデータ echo。本経路 green-fix concerns → evaluator focus_areas 到達）
//   micro:    実効 shape micro でも green-fix が 1 回あれば Evaluate の強制条件になり、
//             evaluator prompt に green-fix 監査 concern（`[#n] <summary>` と files の echo）が入る
//             （evalForced の `|| greenFixCount > 0` 分岐の regression guard）
//   zero:     green-fix 0 回の負の制御群 — evaluator prompt に green-fix 監査 concern が注入されない
//
// 「テスト弱体化」等の日本語文言は言い回し変更で落ちるため pin しない（issue #636 AC-1）。
// 観測は greenFixAuditEcho（test-helpers/dev-flow-markers.mjs）の構造的な echo で行う。
//
// Run: npx vitest run _lib/green-fix-routing.test.mjs
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, runDevFlowInSandbox, assertNoCrash, shapeOverrides } from './test-helpers/vm-sandbox.mjs';
import { greenFixAuditEcho } from './test-helpers/dev-flow-markers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const devFlowSrc = readFileSync(join(here, '..', '.claude/workflows/dev-flow.js'), 'utf8');

const GREEN_FIX_FILE = 'src/foo.test.ts';
const CONCERN_MARKER = 'GREEN_FIX_CONCERN_MARKER';

const failOnce = { 'test#1': { tests: 'failed', green: false, summary: 'assert mismatch in foo.test' } };
const greenFix = (summary, concerns = []) => ({
  'green-fix#1': { status: 'DONE', task_id: 'issue-1', files: [GREEN_FIX_FILE], summary, concerns },
});

const SCENARIOS = {
  standard: {
    ...failOnce,
    ...greenFix('typo修正: 期待値が古いAPIを参照していた', [`${CONCERN_MARKER}: retry ロジックに未検証の race が残る`]),
  },
  micro: { ...shapeOverrides('micro'), ...failOnce, ...greenFix('typo修正') },
  zero: {},
};

const runs = new Map();

async function run(name) {
  if (!runs.has(name)) {
    runs.set(name, (async () => {
      const { ctx, calls, logs } = makeDevFlowSandbox({ overrides: SCENARIOS[name] });
      const error = await runDevFlowInSandbox(devFlowSrc, ctx);
      return { calls, logs, error };
    })());
  }
  return runs.get(name);
}

const labels = (calls) => calls.map((c) => c.label).join(', ');
const evaluatorCalls = (calls) => calls.filter((c) => c.agentType === 'dev-flow:evaluator');

// ---- 全シナリオ: crash guard と green-fix 回数の sanity ----

for (const [name, expectGreenFix] of [['standard', true], ['micro', true], ['zero', false]]) {
  test(`[green-fix-routing] ${name}: dev-flow.js が sandbox で ReferenceError / SyntaxError を throw しない`, async () => {
    assertNoCrash((await run(name)).error, `green-fix-routing/${name}`);
  });

  test(`[green-fix-routing] ${name}: green-fix call が${expectGreenFix ? ' 1 回以上' : ' 0 件'}発生する`, async () => {
    const { calls } = await run(name);
    const greenFixCalls = calls.filter((c) => c.label.startsWith('green-fix'));
    if (expectGreenFix) {
      assert.ok(greenFixCalls.length >= 1, `green-fix label の call が 1 回以上発生すべきだが ${greenFixCalls.length} 回だった (全 labels: ${labels(calls)})`);
    } else {
      assert.equal(greenFixCalls.length, 0, `green-fix label の call が 0 件であるべきだが ${greenFixCalls.length} 件あった (全 labels: ${labels(calls)})`);
    }
  });

  test(`[green-fix-routing] ${name}: evaluator が 1 回以上呼ばれる`, async () => {
    const { calls } = await run(name);
    assert.ok(evaluatorCalls(calls).length >= 1, `evaluator は 1 回以上呼ばれるべきだが 0 回だった (全 labels: ${labels(calls)})`);
  });
}

// ---- standard: eval#1 の prompt への echo ----

test('[green-fix-routing] standard: eval#1 の prompt に green-fix が変更したファイル・summary が含まれる（state→prompt データ echo）', async () => {
  const { calls } = await run('standard');
  const eval1 = calls.find((c) => c.label === 'eval#1');
  assert.ok(eval1 != null, `label === 'eval#1' の call が見つからない (全 labels: ${labels(calls)})`);
  assert.ok(eval1.prompt.includes(GREEN_FIX_FILE), `eval#1 の prompt に green-fix が変更したファイル '${GREEN_FIX_FILE}' が含まれていない。\nprompt (先頭600文字):\n${eval1.prompt.slice(0, 600)}`);
  assert.ok(eval1.prompt.includes('typo修正'), `eval#1 の prompt に green-fix の summary テキスト 'typo修正' が含まれていない。\nprompt (先頭600文字):\n${eval1.prompt.slice(0, 600)}`);
});

test('[green-fix-routing] standard: eval#1 の prompt に green-fix の concerns（GREEN_FIX_CONCERN_MARKER）が含まれる（本経路 green-fix concerns → evaluator focus_areas 到達）', async () => {
  const { calls } = await run('standard');
  const eval1 = calls.find((c) => c.label === 'eval#1');
  assert.ok(eval1 != null, `label === 'eval#1' の call が見つからない (全 labels: ${labels(calls)})`);
  assert.ok(eval1.prompt.includes(CONCERN_MARKER), `eval#1 の prompt に '${CONCERN_MARKER}' が含まれていない。\nprompt (先頭600文字):\n${eval1.prompt.slice(0, 600)}`);
});

// ---- micro: green-fix による Evaluate 強制と監査 concern の注入 ----

test('[green-fix-routing] micro: 実効 shape が micro で、green-fix 1 回が Evaluate の強制条件になり lite route に入らない', async () => {
  const { logs, calls } = await run('micro');
  assert.equal(calls.filter((c) => c.label === 'pr-review-lite').length, 0, `green-fix のある micro は lite route に入らないはず: ${labels(calls)}`);
  assert.ok(logs.some((l) => l.startsWith('shape: micro')), `実効 shape が micro になっていない:\n${logs.filter((l) => l.startsWith('shape:')).join('\n')}`);
});

test('[green-fix-routing] micro: evaluator の prompt に green-fix 監査 concern（files / summary の echo）が注入される', async () => {
  const { calls } = await run('micro');
  const evals = evaluatorCalls(calls);
  const echo = greenFixAuditEcho(1, 'typo修正');
  const withFocus = evals.filter((c) => c.prompt.includes(echo) && c.prompt.includes(GREEN_FIX_FILE));
  assert.ok(
    withFocus.length >= 1,
    `micro + green-fix 発生時: evaluator の prompt に green-fix 監査 concern（'${echo}' と変更ファイル ${GREEN_FIX_FILE} の echo）が含まれるべきだが含まれていない`
      + `\nevaluator prompt (先頭600文字):\n${evals[0]?.prompt.slice(0, 600) ?? ''}`,
  );
});

// ---- zero: 負の制御群 ----

test('[green-fix-routing] zero: green-fix 0 回経路では evaluator の prompt に green-fix 監査 concern が注入されない', async () => {
  const { calls } = await run('zero');
  const withAuditFocus = evaluatorCalls(calls).filter((c) => c.prompt.includes(greenFixAuditEcho(1, '')));
  assert.equal(
    withAuditFocus.length,
    0,
    `green-fix 0 回経路: evaluator の prompt に green-fix 監査 concern が含まれてはいけないが ${withAuditFocus.length} 件含まれていた`
      + `\n最初の該当 prompt (先頭300文字):\n${withAuditFocus[0]?.prompt.slice(0, 300) ?? ''}`,
  );
});
