// post-eval-validate-routing.test.mjs — Evaluate 差し戻し（reimpl#i）後の PR 前フルテスト再実行（issue #714）
//
// Evaluate 内で走るのは AC ごとの redgreen-verify だけで、reimpl が AC 対象外のテストを壊しても
// Validate（Implement 直後の 1 回きり）では捕まらない。reimpl ≥1 の run に限り PR 前に
// test#post-eval-i を 1 回走らせ、red なら Validate と同じ green-fix ループ（GREEN_MAX）へ差し戻す。
// reimpl 0 回の run は追加の test spawn を発生させない。
//
// ハーネス: makeDevFlowSandbox + DEV_FLOW_SCENARIOS['complex-fix']（eval#1 critical → reimpl#1 → eval#2 pass）。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash, mergeTierFacts } from './test-helpers/vm-sandbox.mjs';
import { DEV_FLOW_SCENARIOS } from './test-helpers/dev-flow-scenarios.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', '.claude/workflows/dev-flow.js'), 'utf8');

const RED = { tests: 'failed', green: false, summary: 'reimpl が AC 対象外の foo.test を壊した' };
const ERR = { tests: 'error', green: false, summary: 'pnpm failed to start. No tests executed.' };
const GF_POST_EVAL = { status: 'DONE', task_id: 'issue-1', files: ['src/post-eval-fix.ts'], summary: 'post-eval 修正: foo の境界条件を戻した', concerns: [] };

async function run({ overrides = {}, withReimpl = true } = {}) {
  const base = withReimpl ? DEV_FLOW_SCENARIOS['complex-fix'].overrides : {};
  const { ctx, calls, logs } = makeDevFlowSandbox({ overrides: { ...base, ...overrides } });
  const { result, error } = await runWorkflowCapture(src, ctx);
  assertNoCrash(error, 'post-eval-validate');
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  const labels = calls.map((c) => c.label);
  return { calls, logs, result, labels };
}

const testLabels = (labels) => labels.filter((l) => l.startsWith('test#'));
// テストの実行回数（start の spawn。wait / stop の `.wait-<k>` / `.stop` は数えない）
const postEvalTests = (labels) => labels.filter((l) => /^test#post-eval-\d+$/.test(l));
const postEvalGreenFix = (labels) => labels.filter((l) => l.startsWith('green-fix#post-eval'));

test('[post-eval-validate] reimpl ≥1 の run は最後の eval の後・PR 作成前にフルテストがちょうど 1 回走る', async () => {
  const { labels, calls } = await run();
  const s = labels.join(', ');
  assert.ok(labels.includes('reimpl#1:serial:issue-1'), `前提: reimpl#1 が走っていない (labels: ${s})`);
  assert.deepEqual(postEvalTests(labels), ['test#post-eval-1'], `PR 前のフルテストはちょうど 1 回 (labels: ${s})`);
  assert.deepEqual(postEvalGreenFix(labels), [], `green なら green-fix は走らない (labels: ${s})`);
  assert.deepEqual(testLabels(labels), ['test#1', 'test#post-eval-1'], `test spawn は Validate 1 回 + post-eval 1 回 (labels: ${s})`);
  const idx = labels.indexOf('test#post-eval-1');
  assert.ok(labels.lastIndexOf('eval#2') < idx, `test#post-eval-1 は最後の eval の後 (labels: ${s})`);
  assert.ok(idx < labels.indexOf('diff-hash-pr') && idx < labels.indexOf('pr#1'), `test#post-eval-1 は PR 前 (labels: ${s})`);
  // Validate と同じ test prompt（VALIDATE_TEST_PROMPT）を共有する
  const p1 = calls.find((c) => c.label === 'test#1');
  const pe = calls.find((c) => c.label === 'test#post-eval-1');
  assert.equal(pe.prompt, p1.prompt, 'test#post-eval-1 の prompt が test#1 と byte 一致しない');
  assert.equal(pe.agentType, p1.agentType);
});

test('[post-eval-validate] reimpl 0 回の run では追加のテスト spawn が発生しない', async () => {
  const { labels } = await run({ withReimpl: false });
  const s = labels.join(', ');
  assert.equal(labels.some((l) => l.startsWith('reimpl#')), false, `前提: reimpl が走っている (labels: ${s})`);
  assert.ok(labels.includes('eval#1'), `前提: Evaluate が走っていない (labels: ${s})`);
  assert.deepEqual(postEvalTests(labels), [], `reimpl 0 回で test#post-eval が走った (labels: ${s})`);
  assert.deepEqual(testLabels(labels), ['test#1'], `test spawn は Validate の 1 回のみ (labels: ${s})`);
});

test('[post-eval-validate] PR 前のテストが red なら green-fix に差し戻し、green 化後に PR へ進む（green-fix 再評価が取れなければ hash_mismatch HOLD で人間へ）', async () => {
  // green-fix#post-eval が tree を変えたら PR 直前の diff hash が Evaluate 時点と変わる。
  // green-fix 再評価の起点（green-fix-classify）が null だと評価済み tree を進めないので hash_mismatch で HOLD になる
  // （run 内で再評価できたときの経路は post-eval-recheck-routing.test.mjs）
  let fixed = false;
  const { labels, calls, logs, result } = await run({
    overrides: {
      'test#post-eval-1': RED,
      'green-fix-classify': null,
      'green-fix#post-eval-1': () => { fixed = true; return GF_POST_EVAL; },
      'diff-hash-pr': () => ({ hash: fixed ? 'BBB' : 'AAA', empty: false }),
      'tree-diff-numstat': { ok: true, lines: ['3\t1\tsrc/post-eval-fix.ts'] },
      // PR head の tree は green-fix 後の tree（Evaluate 時点の AAA へは戻らない）
      'merge-tier-facts': mergeTierFacts({ tree: 'BBB' }),
    },
  });
  const s = labels.join(', ');
  const t1 = labels.indexOf('test#post-eval-1');
  const gf1 = labels.indexOf('green-fix#post-eval-1');
  const t2 = labels.indexOf('test#post-eval-2');
  assert.ok(t1 !== -1 && gf1 !== -1 && t2 !== -1, `test#post-eval-1 → green-fix#post-eval-1 → test#post-eval-2 が揃わない (labels: ${s})`);
  assert.ok(t1 < gf1 && gf1 < t2 && t2 < labels.indexOf('pr#1'), `順序が test → green-fix → test → PR でない (labels: ${s})`);
  assert.deepEqual(postEvalGreenFix(labels), ['green-fix#post-eval-1'], `green 化後の green-fix は 1 回のみ (labels: ${s})`);
  // green-fix は Validate と同じ agent・model・禁止文付き prompt
  const gf = calls.find((c) => c.label === 'green-fix#post-eval-1');
  assert.equal(gf.agentType, 'dev-flow:dev-implementer');
  assert.equal(gf.model, 'sonnet');
  assert.ok(gf.prompt.includes(RED.summary), 'green-fix prompt に失敗内容が渡っていない');
  assert.ok(logs.some((l) => l.includes('post-eval validate: green-fix 1 回') && l.includes('src/post-eval-fix.ts')), `green-fix 計上 log が無い (logs: ${JSON.stringify(logs)})`);
  // 再評価できなかった green-fix は hash_mismatch で HOLD になり、差分ファイルが人間に示される
  assert.equal(labels.includes('eval-green-fix'), false, `green-fix-classify が null なら evaluator は呼ばない (labels: ${s})`);
  assert.equal(result.eval_staleness, 'hash_mismatch');
  assert.equal(result.merge_tier, 'HOLD');
  assert.ok(result.merge_tier_reasons.some((r) => r.includes('src/post-eval-fix.ts')), `HOLD 理由に green-fix の差分ファイルが無い: ${JSON.stringify(result.merge_tier_reasons)}`);
  assert.equal(result.test_green, true, `最新の test 結果（green）が test_green に反映されていない: ${result.test_green}`);
});

test('[post-eval-validate] red のまま GREEN_MAX に達したら Validate と同じく red のまま PR へ進む', async () => {
  const { labels, logs, result } = await run({
    overrides: { 'test#post-eval-1': RED, 'test#post-eval-2': RED, 'test#post-eval-3': RED },
  });
  const s = labels.join(', ');
  assert.deepEqual(postEvalTests(labels), ['test#post-eval-1', 'test#post-eval-2', 'test#post-eval-3'], `GREEN_MAX=3 回で止まらない (labels: ${s})`);
  assert.deepEqual(postEvalGreenFix(labels), ['green-fix#post-eval-1', 'green-fix#post-eval-2'], `green-fix は GREEN_MAX-1 回 (labels: ${s})`);
  assert.ok(labels.includes('pr#1'), `GREEN_MAX 到達後も PR へ進むべき (labels: ${s})`);
  assert.ok(logs.some((l) => l.includes('回試行しても test green にならず')), 'GREEN_MAX 到達 log が無い');
  assert.equal(result.test_green, false, `red のままの結果が test_green に反映されていない: ${result.test_green}`);
});

test("[post-eval-validate] tests:'error'（起動失敗）は green-fix をせず PR へ進む", async () => {
  const { labels, result } = await run({ overrides: { 'test#post-eval-1': ERR } });
  const s = labels.join(', ');
  assert.deepEqual(postEvalTests(labels), ['test#post-eval-1'], `error で再テストしてはならない (labels: ${s})`);
  assert.deepEqual(postEvalGreenFix(labels), [], `error で green-fix してはならない (labels: ${s})`);
  assert.ok(labels.includes('pr#1'), `PR へ進むべき (labels: ${s})`);
  assert.equal(result.test_green, false, `起動失敗の結果が test_green に反映されていない: ${result.test_green}`);
});
