// priterate-push-routing.test.mjs — pr-iterate の push（fix・commit-ensure・conflict-resolve）を pr-push の start / wait で行う経路を
// pr-iterate.js 全体の VM 実行で見る。
// push が最初の wait で終わる round の spawn は増えない。commit-ensure・conflict-resolve は running のときだけ workflow が wait の spawn を
// 繰り返し、待機の累計上限で pr-push stop を呼ぶ。spawn が throw・null・push 未完了の応答で終わったら pr-push stop を呼んでから次へ進む。
// wait の値と log のパスは PR phase（_lib/pr-artifacts.mjs）と同じ。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  makePrIterateSandbox, runWorkflowCapture, assertNoCrash, ciCounts, porcelainBaselineResponse, porcelainVerdictResponse,
} from './test-helpers/vm-sandbox.mjs';
import { PR_PUSH_MAX_WAIT_SEC, PR_PUSH_WAIT_SEC, prPushLogPath } from './pr-artifacts.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', '.claude', 'workflows', 'pr-iterate.js'), 'utf8');

const HEAD1 = '1'.repeat(40);
const HEAD2 = '2'.repeat(40);
const MERGE = '3'.repeat(40);
const NESTED = { caller: 'dev-flow', cwd: '/tmp/wt', head_ref: 'feature/x', base_ref: 'main', head_sha: HEAD1, repo: 'acme/skills' };
const PUSH_LOG = prPushLogPath('/tmp/wt');
const WAIT_COMMAND = `pr-push wait ${PUSH_LOG} --wait-sec ${PR_PUSH_WAIT_SEC}`;
// 最初の wait は push を起動した spawn の中なので、workflow が spawn する wait は累計上限 / 1 回の待機 - 1 回
const WAIT_SPAWNS = PR_PUSH_MAX_WAIT_SEC / PR_PUSH_WAIT_SEC - 1;

const pushResult = (status, exitCode, tail = '') => ({ status, exit_code: exitCode, log: PUSH_LOG, tail, epoch: 1200 });
const RUNNING = pushResult('running', null);
const PASSED = pushResult('passed', 0, 'To origin');
const FAILED = pushResult('failed', 1, 'error: failed to push some refs');
const THROW = () => { throw new Error('injected'); };

const ISSUE = { severity: 'major', topic: 't1', file: 'a.ts', line: 1, description: 'd1', suggestion: 's1' };
const CI_PASSED = { status: 'passed', ...ciCounts('passed'), failed_checks: [] };
const CONFLICTING = { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' };
const MERGEABLE = { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' };

// round 1 の review が指摘 → fix#1 → commit-ensure#1 が未コミット変更を回収して push する → round 2 で LGTM
const FIX_ROUND = {
  'review#1': { decision: 'request-changes', issues: [ISSUE], summary: 'ng' },
  'fix-baseline#1': porcelainBaselineResponse(),
  'commit-ensure-status#1': porcelainVerdictResponse([' M a.ts'], []),
};
const ensureResponse = (fields) => ({ dirty: true, committed: true, pushed: false, head_sha: HEAD2, ...fields });

// round 1 で CONFLICTING → conflict-resolve#1 が解消して push する → round 2 で LGTM
const CONFLICT_ROUND = {
  'ci-check#1': CI_PASSED,
  'mergeable-check#1': CONFLICTING,
  'mergeable-check#2': MERGEABLE,
};
const resolveResponse = (fields) => ({
  fetched: true,
  pushed: false,
  result: { status: 'resolved', reason: '', base_ref: 'origin/main', head_before: HEAD1, head_after: MERGE, restored: false, files: [{ path: 'README.md', type: 'A' }] },
  ...fields,
});

const ROUND_LABEL = /^(review#|ci-check#|mergeable-check#|conflict-resolve#|fix-baseline#|fix#|commit-ensure-status#|commit-ensure#)/;

async function run(overrides) {
  const { ctx, calls } = makePrIterateSandbox({ overrides, args: { pr: 5, nested: NESTED } });
  const { result, error } = await runWorkflowCapture(src, ctx, '.claude/workflows/pr-iterate.js');
  assertNoCrash(error, 'priterate-push-routing');
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  const labels = calls.map((c) => c.label);
  // ci-check#i-serial は既定の ci-check 応答が head_sha を持たないときの取り直しで、push の経路と無関係
  return { result: JSON.parse(JSON.stringify(result)), calls, labels, round: labels.filter((l) => ROUND_LABEL.test(l) && !l.endsWith('-serial')) };
}

const from = (round, label) => round.slice(round.indexOf(label));
const promptOf = (calls, label) => calls.find((c) => c.label === label)?.prompt ?? '';
const waitLabels = (prefix, n) => Array.from({ length: n }, (_, k) => `${prefix}.wait-${k + 1}`);

function assertStopPrompt(calls, label) {
  const call = calls.find((c) => c.label === label);
  assert.ok(call, `${label} が spawn されていない: ${calls.map((c) => c.label).join(', ')}`);
  assert.equal(call.agentType, 'dev-flow:dev-runner-haiku');
  assert.ok(call.prompt.endsWith(`\npr-push stop ${PUSH_LOG}`), call.prompt);
}

// ---- AC-2: push が最初の wait で終わる round の spawn は増えない ----

test('[AC-2] commit-ensure の push が最初の wait で終わる round の spawn の label 列は fix と commit-ensure の後に次の round へ進むだけ', async () => {
  const { result, round, calls } = await run({ ...FIX_ROUND, 'commit-ensure#1': ensureResponse({ pushed: true, push_result: PASSED }), 'mergeable-check#2': MERGEABLE });
  assert.deepEqual(round, [
    'review#1', 'ci-check#1', 'fix-baseline#1', 'fix#1', 'commit-ensure-status#1', 'commit-ensure#1',
    'review#2', 'ci-check#2', 'mergeable-check#2',
  ]);
  assert.equal(result.status, 'lgtm');
  assert.equal(result.fix_uncommitted_recovered, 1);
  // 値は PR phase と同じ（待機の上限・log のパスが経路ごとにずれない）
  const prompt = promptOf(calls, 'commit-ensure#1');
  assert.ok(prompt.includes(`\`pr-push start ${PUSH_LOG}\` → \`${WAIT_COMMAND}\``), prompt);
  assert.equal(calls.find((c) => c.label === 'commit-ensure#1').agentType, 'dev-flow:dev-runner-haiku');
});

test('[AC-2] conflict-resolve の push が最初の wait で終わる round の spawn の label 列は conflict-resolve の後に次の round へ進むだけ', async () => {
  const { result, round } = await run({ ...CONFLICT_ROUND, 'conflict-resolve#1': resolveResponse({ pushed: true, push_result: PASSED }) });
  assert.deepEqual(round, ['review#1', 'ci-check#1', 'mergeable-check#1', 'conflict-resolve#1', 'review#2', 'ci-check#2', 'mergeable-check#2']);
  assert.equal(result.status, 'lgtm');
  assert.equal(result.conflict_autoresolve[0].status, 'resolved');
});

test('[AC-2] fix が applied:true で返る round は pr-push stop を呼ばない', async () => {
  const { labels } = await run({ ...FIX_ROUND, 'commit-ensure#1': { dirty: false, committed: false, pushed: false, head_sha: HEAD2 }, 'mergeable-check#2': MERGEABLE });
  assert.deepEqual(labels.filter((l) => /\.(stop|wait-\d+)$/.test(l)), []);
});

// ---- AC-3a: running は workflow が wait を繰り返し、累計上限で stop ----

test('[AC-3a] commit-ensure の push が running: wait の spawn で passed になれば push 済みとして次の round へ進む', async () => {
  const { result, round, calls } = await run({
    ...FIX_ROUND,
    'commit-ensure#1': ensureResponse({ push_result: RUNNING }),
    'commit-ensure#1.wait-1': RUNNING,
    'commit-ensure#1.wait-2': PASSED,
    'mergeable-check#2': MERGEABLE,
  });
  assert.deepEqual(from(round, 'commit-ensure#1').slice(0, 4), ['commit-ensure#1', 'commit-ensure#1.wait-1', 'commit-ensure#1.wait-2', 'review#2']);
  assert.equal(result.status, 'lgtm');
  assert.equal(result.fix_uncommitted_recovered, 1);
  assert.ok(promptOf(calls, 'commit-ensure#1.wait-1').endsWith(`\n${WAIT_COMMAND}`));
  assert.equal(calls.find((c) => c.label === 'commit-ensure#1.wait-1').agentType, 'dev-flow:dev-runner-haiku');
});

test('[AC-3a] commit-ensure の wait が累計上限まで running: pr-push stop を呼び、push 未完了の fix_failed（commit_unensured）で終わる', async () => {
  assert.equal(PR_PUSH_MAX_WAIT_SEC, 3600);
  const overrides = { ...FIX_ROUND, 'commit-ensure#1': ensureResponse({ push_result: RUNNING }) };
  for (let k = 1; k <= WAIT_SPAWNS + 2; k++) overrides[`commit-ensure#1.wait-${k}`] = RUNNING;
  const { result, round, calls } = await run(overrides);
  assert.deepEqual(from(round, 'commit-ensure#1'), ['commit-ensure#1', ...waitLabels('commit-ensure#1', WAIT_SPAWNS), 'commit-ensure#1.stop']);
  assertStopPrompt(calls, 'commit-ensure#1.stop');
  assert.equal(result.status, 'fix_failed');
  assert.equal(result.fix_terminal_reason, 'commit_unensured');
});

test('[AC-3a] conflict-resolve の push が running: wait の spawn で passed になれば push 済みとして次の round へ進む', async () => {
  const { result, round } = await run({
    ...CONFLICT_ROUND,
    'conflict-resolve#1': resolveResponse({ push_result: RUNNING }),
    'conflict-resolve#1.wait-1': PASSED,
  });
  assert.deepEqual(from(round, 'conflict-resolve#1').slice(0, 3), ['conflict-resolve#1', 'conflict-resolve#1.wait-1', 'review#2']);
  assert.equal(result.status, 'lgtm');
  assert.equal(result.conflict_autoresolve[0].status, 'resolved');
  assert.equal(result.conflict_autoresolve[0].merge_sha, MERGE);
});

test('[AC-3a] conflict-resolve の wait が累計上限まで running: pr-push stop を呼び、pushed:false の push_failed → fix_failed で終わる', async () => {
  const overrides = { ...CONFLICT_ROUND, 'conflict-resolve#1': resolveResponse({ push_result: RUNNING }) };
  for (let k = 1; k <= WAIT_SPAWNS + 2; k++) overrides[`conflict-resolve#1.wait-${k}`] = RUNNING;
  const { result, round, calls } = await run(overrides);
  assert.deepEqual(from(round, 'conflict-resolve#1'), ['conflict-resolve#1', ...waitLabels('conflict-resolve#1', WAIT_SPAWNS), 'conflict-resolve#1.stop']);
  assertStopPrompt(calls, 'conflict-resolve#1.stop');
  assert.equal(result.status, 'fix_failed');
  assert.equal(result.fix_terminal_reason, 'commit_unensured');
  assert.equal(result.conflict_autoresolve[0].status, 'push_failed');
});

test('[AC-3a] push が失敗で終わったら stop を呼ばず（push は走っていない）、今の push 失敗と同じ終端になる', async () => {
  const ensure = await run({ ...FIX_ROUND, 'commit-ensure#1': ensureResponse({ push_result: RUNNING }), 'commit-ensure#1.wait-1': FAILED });
  assert.deepEqual(from(ensure.round, 'commit-ensure#1'), ['commit-ensure#1', 'commit-ensure#1.wait-1']);
  assert.equal(ensure.result.status, 'fix_failed');
  assert.equal(ensure.result.fix_terminal_reason, 'commit_unensured');

  const first = await run({ ...FIX_ROUND, 'commit-ensure#1': ensureResponse({ push_result: FAILED }) });
  assert.deepEqual(from(first.round, 'commit-ensure#1'), ['commit-ensure#1']);
  assert.equal(first.result.status, 'fix_failed');

  const conflict = await run({ ...CONFLICT_ROUND, 'conflict-resolve#1': resolveResponse({ push_result: FAILED }) });
  assert.deepEqual(from(conflict.round, 'conflict-resolve#1'), ['conflict-resolve#1']);
  assert.equal(conflict.result.conflict_autoresolve[0].status, 'push_failed');
});

test('[AC-3a] 最初の push_result が passed でも手順 4 の rev-list が pushed:false なら push 未完了の終端になる（走っていた push に合流して新しい commit が未 push）', async () => {
  const { result, round } = await run({ ...FIX_ROUND, 'commit-ensure#1': ensureResponse({ pushed: false, push_result: PASSED }) });
  assert.deepEqual(from(round, 'commit-ensure#1'), ['commit-ensure#1']);
  assert.equal(result.status, 'fix_failed');
  assert.equal(result.fix_terminal_reason, 'commit_unensured');
  assert.equal(result.fix_uncommitted_recovered, 0);
});

for (const [name, bad] of [['null', null], ['throw', THROW], ['schema に合わない応答', { status: 'done', log: PUSH_LOG }], ['proxy の固定 JSON', pushResult('error', null)]]) {
  test(`[AC-3a] wait が ${name}: 繰り返しをやめて pr-push stop を呼び、push を通ったとみなさない`, async () => {
    const { result, round, calls } = await run({
      ...FIX_ROUND,
      'commit-ensure#1': ensureResponse({ push_result: RUNNING }),
      'commit-ensure#1.wait-1': bad,
      'commit-ensure#1.wait-2': PASSED,
    });
    assert.deepEqual(from(round, 'commit-ensure#1'), ['commit-ensure#1', 'commit-ensure#1.wait-1', 'commit-ensure#1.stop']);
    assertStopPrompt(calls, 'commit-ensure#1.stop');
    assert.equal(result.status, 'fix_failed');
  });
}

// ---- AC-3b: throw・null・push 未完了の応答は stop してから次へ ----

for (const [name, response] of [['throw', THROW], ['null', null]]) {
  test(`[AC-3b] fix#1 が ${name}: pr-push stop を呼んでから fix#1-retry へ進む`, async () => {
    const { result, round, calls } = await run({
      ...FIX_ROUND,
      'fix#1': response,
      'fix#1-retry': { applied: true, files: [], summary: 'fixed', deferred_security_ids: [] },
      'commit-ensure#1': { dirty: false, committed: false, pushed: false, head_sha: HEAD2 },
      'mergeable-check#2': MERGEABLE,
    });
    assert.deepEqual(from(round, 'fix#1').slice(0, 3), ['fix#1', 'fix#1.stop', 'fix#1-retry']);
    assert.ok(!round.includes('fix#1-retry.stop'), 'applied:true の retry は stop しない');
    assertStopPrompt(calls, 'fix#1.stop');
    assert.equal(result.status, 'lgtm');
  });

  test(`[AC-3b] fix#1-retry も ${name}: pr-push stop を呼んでから fix_failed で終わる`, async () => {
    const { result, round, calls } = await run({ ...FIX_ROUND, 'fix#1': response, 'fix#1-retry': response });
    assert.deepEqual(from(round, 'fix#1'), ['fix#1', 'fix#1.stop', 'fix#1-retry', 'fix#1-retry.stop']);
    assertStopPrompt(calls, 'fix#1-retry.stop');
    assert.equal(result.status, 'fix_failed');
    assert.equal(result.fix_terminal_reason, 'null_after_retry');
  });

  test(`[AC-3b] commit-ensure#1 が ${name}: pr-push stop を呼んでから fix_failed で終わる`, async () => {
    const { result, round, calls } = await run({ ...FIX_ROUND, 'commit-ensure#1': response });
    assert.deepEqual(from(round, 'commit-ensure#1'), ['commit-ensure#1', 'commit-ensure#1.stop']);
    assertStopPrompt(calls, 'commit-ensure#1.stop');
    assert.equal(result.status, 'fix_failed');
    assert.equal(result.fix_terminal_reason, 'commit_unensured');
  });

  test(`[AC-3b] conflict-resolve#1 が ${name}: pr-push stop を呼んでから、自動解消しなかった run として LGTM へ進む`, async () => {
    const { result, round, calls } = await run({ ...CONFLICT_ROUND, 'conflict-resolve#1': response });
    assert.deepEqual(from(round, 'conflict-resolve#1'), ['conflict-resolve#1', 'conflict-resolve#1.stop']);
    assertStopPrompt(calls, 'conflict-resolve#1.stop');
    assert.equal(result.status, 'lgtm');
    assert.equal(result.conflict_autoresolve[0].status, 'error');
  });
}

test('[AC-3b] fix#1 が applied:false（push 未完了の応答）: pr-push stop を呼んでから fix_failed で終わる', async () => {
  const { result, round, calls } = await run({ ...FIX_ROUND, 'fix#1': { applied: false, files: [], summary: 'push が終わらない', deferred_security_ids: [] } });
  assert.deepEqual(from(round, 'fix#1'), ['fix#1', 'fix#1.stop']);
  assertStopPrompt(calls, 'fix#1.stop');
  assert.equal(result.status, 'fix_failed');
  assert.equal(result.fix_terminal_reason, 'applied_false');
});

test('[AC-3b] push_result の無い push 未完了の応答: commit-ensure・conflict-resolve とも pr-push stop を呼んでから今の push 失敗と同じ終端になる', async () => {
  const ensure = await run({ ...FIX_ROUND, 'commit-ensure#1': ensureResponse({}) });
  assert.deepEqual(from(ensure.round, 'commit-ensure#1'), ['commit-ensure#1', 'commit-ensure#1.stop']);
  assert.equal(ensure.result.status, 'fix_failed');
  assert.equal(ensure.result.fix_terminal_reason, 'commit_unensured');

  const conflict = await run({ ...CONFLICT_ROUND, 'conflict-resolve#1': resolveResponse({}) });
  assert.deepEqual(from(conflict.round, 'conflict-resolve#1'), ['conflict-resolve#1', 'conflict-resolve#1.stop']);
  assert.equal(conflict.result.status, 'fix_failed');
  assert.equal(conflict.result.conflict_autoresolve[0].status, 'push_failed');
});

test('[AC-3b] stop の spawn 自体が throw しても run は同じ終端へ進む', async () => {
  const { result, round } = await run({ ...FIX_ROUND, 'commit-ensure#1': null, 'commit-ensure#1.stop': THROW });
  assert.deepEqual(from(round, 'commit-ensure#1'), ['commit-ensure#1', 'commit-ensure#1.stop']);
  assert.equal(result.status, 'fix_failed');
  assert.equal(result.fix_terminal_reason, 'commit_unensured');
});

test('[AC-3b] push を指示しない応答は stop しない（dirty:false の commit-ensure・自動解消しなかった conflict-resolve）', async () => {
  const clean = await run({ ...FIX_ROUND, 'commit-ensure#1': { dirty: false, committed: false, pushed: false, head_sha: HEAD2 }, 'mergeable-check#2': MERGEABLE });
  assert.ok(!clean.labels.includes('commit-ensure#1.stop'), clean.labels.join(', '));
  const aborted = await run({
    ...CONFLICT_ROUND,
    'conflict-resolve#1': { fetched: true, pushed: false, result: { status: 'aborted', reason: 'unsupported_conflict', base_ref: 'origin/main', head_before: HEAD1, head_after: HEAD1, restored: true, files: [] } },
  });
  assert.ok(!aborted.labels.includes('conflict-resolve#1.stop'), aborted.labels.join(', '));
  assert.equal(aborted.result.status, 'lgtm');
});

// ---- AC-5: pr-iterate の push の記述は新しい起動形に揃う ----

test('[AC-5] pr-iterate の push の記述がある文書は pr-push の start / wait と stop の経路を書く', () => {
  const read = (...p) => readFileSync(join(here, '..', ...p), 'utf8');
  const execProxy = read('dev-flow', 'references', 'exec-proxy.md');
  const row = execProxy.split('\n').find((l) => l.startsWith('| commit-ensure・pr-iterate の push の待機'));
  assert.ok(row?.includes('`pr-push start` → `wait`') && row.includes('`pr-push stop`') && row.includes('`settlePush`'), row);
  const pipeline = read('dev-flow', 'references', 'pipeline.md');
  assert.ok(pipeline.includes('- push — fix・commit-ensure・conflict-resolve も `pr-push start` → `wait`'), 'pipeline.md');
  assert.ok(pipeline.includes('その spawn の throw・null・push 未完了・待機累計 3600 秒は `pr-push stop`'), 'pipeline.md');
  const skill = read('pr-iterate', 'SKILL.md');
  assert.ok(skill.includes('fix・commit-ensure・conflict-resolve の push は `pr-push start <log>` → `pr-push wait <log> --wait-sec <n>`'), 'pr-iterate/SKILL.md');
  assert.ok(skill.includes('待機の累計 3600 秒で `pr-push stop`'), 'pr-iterate/SKILL.md');
  const rules = readFileSync(join(here, '..', '..', '..', '.claude', 'rules', 'dev-flow.md'), 'utf8');
  assert.ok(rules.includes('push は `pr-push`（') && rules.includes('`pr-push` — `start` / `wait` / `stop` で切り離す'), '.claude/rules/dev-flow.md');
});
