import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { stripComments } from '../../../tools/sync-inlines.mjs';
import { makePrIterateSandbox, runWorkflowCapture } from './test-helpers/vm-sandbox.mjs';
import { neutralizeRegexLiterals } from './test-helpers/source-scan.mjs';

/**
 * subagent-invocations-routing.test.mjs — agent() 起動が trackedAgent wrapper を経由することを検証する
 * （issue #445、issue #636 で挙動ベースへ書き換え、issue #789 で dev-flow の telemetry 計上を撤去）。
 *
 *   (0) 否定 pin — dev-flow.js / pr-iterate.js の bare `agent(` 呼び出しは trackedAgent wrapper 内の
 *       2 箇所（初回 + 契約違反リトライ、issue #527）のみ。wrapper は ABORT_CTX（abort handoff の
 *       phase/label）と pr-iterate の起動数計上を担うため、wrapper を経由しない call site が 1 つでも
 *       増えると abort entry の label がずれ・計上漏れになる。call site の追加そのものを静的に拒否する
 *       （VM 実行はそれぞれの scenario で到達した call site しか観測できないため、未到達 call site は
 *       この否定 pin でしか検出できない）。
 *   (c) pr-iterate.js 単体起動の返り値 subagent_invocations.total が実 agent() 起動数と一致する。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const DEV_FLOW_PATH = join(HERE, '..', '.claude', 'workflows', 'dev-flow.js');
const PR_ITERATE_PATH = join(HERE, '..', '.claude', 'workflows', 'pr-iterate.js');
const devFlowSrc = readFileSync(DEV_FLOW_PATH, 'utf8');
const prIterateSrc = readFileSync(PR_ITERATE_PATH, 'utf8');
const finalizeSrc = readFileSync(join(HERE, '..', '.claude', 'workflows', 'dev-flow-finalize.js'), 'utf8');

// ============================================================
// (0) 否定 pin: bare agent( は trackedAgent wrapper 内の 2 箇所のみ
// ============================================================

// stripComments（tools/sync-inlines.mjs）は regex literal を regex context として解釈しない既知の制約が
// あるため、前段で test-helpers/source-scan.mjs の neutralizeRegexLiterals を通して迂回する。

for (const [name, rawSrc] of [['dev-flow.js', devFlowSrc], ['dev-flow-finalize.js', finalizeSrc], ['pr-iterate.js', prIterateSrc]]) {
  test(`${name}: bare agent( 呼び出しは trackedAgent wrapper 内の 2 箇所のみ（wrapper 外の call site は禁止）`, () => {
    const strippedSrc = stripComments(neutralizeRegexLiterals(rawSrc));
    const bareAgentCallRe = /(?<![A-Za-z0-9_$])agent\s*\(/g;
    const matches = [...strippedSrc.matchAll(bareAgentCallRe)];
    assert.equal(matches.length, 2, `bare agent( の総出現数が 2 件ではない（${matches.length} 件）。新規 agent() call site は trackedAgent() 経由で呼ぶこと`);

    const wrapperMarker = 'async function trackedAgent(prompt, opts) {';
    const wrapperStart = strippedSrc.indexOf(wrapperMarker);
    assert.ok(wrapperStart !== -1, 'trackedAgent wrapper 定義が見つからない');
    const nextFnIdx = strippedSrc.indexOf('async function', wrapperStart + wrapperMarker.length);
    const wrapperEnd = nextFnIdx === -1 ? strippedSrc.length : nextFnIdx;
    for (const m of matches) {
      assert.ok(m.index >= wrapperStart && m.index < wrapperEnd, `bare agent( 呼び出し（index ${m.index}）が trackedAgent wrapper 本体の外にある — call site は trackedAgent() 経由で呼ぶこと`);
    }
  });
}

// ============================================================
// (c) pr-iterate.js 単体起動
// ============================================================
test('pr-iterate.js: 単体起動時の result.subagent_invocations.total は calls.length と完全一致する（journal-log 完了後に再計算されるため）', async () => {
  const { ctx, calls } = makePrIterateSandbox({ args: '5' });
  const { result, error } = await runWorkflowCapture(prIterateSrc, ctx, '.claude/workflows/pr-iterate.js');
  assert.equal(error, null, `既定 run はエラーなく完走するべき: ${error?.message}`);
  assert.ok(result.subagent_invocations, 'result.subagent_invocations が無い');
  assert.equal(
    result.subagent_invocations.total,
    calls.length,
    `result.subagent_invocations.total(${result.subagent_invocations.total}) が calls.length(${calls.length}) と一致しない`,
  );
  const byTypeSum = Object.values(result.subagent_invocations.by_type).reduce((a, b) => a + b, 0);
  assert.equal(byTypeSum, result.subagent_invocations.total, 'by_type の合計が total と一致しない');
  for (const key of Object.keys(result.subagent_invocations.by_type)) {
    assert.ok(!key.includes(':'), `by_type キー '${key}' に namespace プレフィックスが混入している`);
  }
});
