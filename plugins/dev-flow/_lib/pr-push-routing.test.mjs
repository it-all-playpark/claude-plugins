// pr-push-routing.test.mjs — PR phase の push を切り離して待つ経路（prPhaseJob）を dev-flow.js 全体の VM 実行で見る。
// push が最初の wait で終わる run は pr#<issue> の 1 spawn。running のときだけ wait と gh pr create の spawn が増える。
// 待機の累計上限・応答が読めない・spawn の throw では pr-push stop を呼ぶ。failure_reason は proxy に作文させない。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash } from './test-helpers/vm-sandbox.mjs';
import {
  PR_PUSH_MAX_WAIT_SEC,
  PR_PUSH_NOT_INVOKED_REASON,
  PR_PUSH_TAIL_UNAVAILABLE,
  PR_PUSH_WAIT_CAPPED_REASON,
  PR_PUSH_WAIT_SEC,
} from './pr-artifacts.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', '.claude', 'workflows', 'dev-flow.js'), 'utf8');

const PUSH_LOG = '/tmp/wt/.devflow-tmp/push-output.log';
const HEAD = 'c'.repeat(40);
const result = (status, exitCode, tail = '') => ({ status, exit_code: exitCode, log: PUSH_LOG, tail, epoch: 1200 });
const RUNNING = result('running', null);
const PASSED = result('passed', 0, 'To origin\n * [new branch] HEAD -> feature/issue-1');
const FAILED_TAIL = '❌ Pre-push checks failed\nerror: failed to push some refs';
const FAILED = result('failed', 1, FAILED_TAIL);
const STOPPED = { ok: true, stopped: true, was_running: true };
const PR_RUNNING = { pr_url: '', pr_number: 0, committed: true, head_sha: HEAD, failed_step: '', failure_reason: '', push_result: RUNNING, epoch: 1100 };
const PR_DONE = { pr_url: 'http://x/pull/7', pr_number: 7, committed: true, head_sha: HEAD, failed_step: '', failure_reason: '', push_result: PASSED, epoch: 1100 };
const CREATED = { pr_url: 'http://x/pull/7', pr_number: 7, committed: true, head_sha: HEAD, failed_step: '', failure_reason: '', epoch: 1300 };
// 最初の wait は pr#1 の中なので、workflow が spawn する wait は累計上限 / 1 回の待機 - 1 回
const WAIT_SPAWNS = PR_PUSH_MAX_WAIT_SEC / PR_PUSH_WAIT_SEC - 1;
const WAIT_LABELS = Array.from({ length: WAIT_SPAWNS }, (_, i) => `pr#1.wait-${i + 1}`);

async function runFlow(overrides) {
  const workflowCalls = [];
  const { ctx, calls } = makeDevFlowSandbox({
    overrides,
    workflow: async (name, opts) => { workflowCalls.push({ name, opts }); return { status: 'lgtm', iterations: 1, fixes_applied: 0 }; },
  });
  const { result: res, error } = await runWorkflowCapture(src, ctx);
  assertNoCrash(error, 'pr-push-routing');
  return { calls, result: res, error, workflowCalls, prLabels: calls.map((c) => c.label).filter((l) => l.startsWith('pr#')) };
}

const prompts = (calls, label) => calls.filter((c) => c.label === label).map((c) => c.prompt);

test('[pr-push] AC-4: push が最初の wait で終わる run の PR phase の spawn は pr#1 の 1 回で、その spawn が commit・push の start と wait・gh pr create まで行う', async () => {
  const { calls, error, prLabels, workflowCalls } = await runFlow({ 'pr#1': PR_DONE });
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  assert.deepEqual(prLabels, ['pr#1']);
  const [prompt] = prompts(calls, 'pr#1');
  for (const step of ['`git commit -F ', `\`pr-push start ${PUSH_LOG}\``, `\`pr-push wait ${PUSH_LOG} --wait-sec ${PR_PUSH_WAIT_SEC}\``, '`gh pr create ']) {
    assert.ok(prompt.includes(step), `pr#1 の prompt に ${step} が無い`);
  }
  assert.equal(workflowCalls[0].opts?.pr, 7);
});

test('[pr-push] AC-4: running のときだけ wait の spawn と、その後の gh pr create の spawn が増え、PR 番号と create の head_sha・epoch が後段へ渡る', async () => {
  const { calls, error, prLabels, workflowCalls } = await runFlow({
    'pr#1': PR_RUNNING, 'pr#1.wait-1': RUNNING, 'pr#1.wait-2': PASSED, 'pr#1.create': CREATED,
  });
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  assert.deepEqual(prLabels, ['pr#1', 'pr#1.wait-1', 'pr#1.wait-2', 'pr#1.create']);
  for (const label of prLabels) {
    assert.equal(calls.find((c) => c.label === label).agentType, 'dev-flow:dev-runner-haiku', label);
  }
  assert.ok(prompts(calls, 'pr#1.wait-1')[0].endsWith(`\npr-push wait ${PUSH_LOG} --wait-sec ${PR_PUSH_WAIT_SEC}`));
  const [create] = prompts(calls, 'pr#1.create');
  assert.ok(/`gh pr create .*--draft .*--body-file \/tmp\/wt\/\.devflow-tmp\/pr-body\.md`/.test(create), create);
  assert.ok(!create.includes('pr-push') && !create.includes('git commit'), `create の prompt が push / commit を再実行させる: ${create}`);
  const nested = workflowCalls[0].opts;
  assert.equal(nested.pr, 7);
  assert.equal(nested.nested.head_sha, HEAD);
  assert.equal(nested.nested.epoch, 1300);
});

test('[pr-push] AC-3: wait が running を返し続けると累計上限で pr-push stop を呼び、failed_step:"push" の pr_phase_failed で終わる', async () => {
  const overrides = { 'pr#1': PR_RUNNING, 'pr#1.stop': STOPPED };
  for (let k = 1; k <= WAIT_SPAWNS + 2; k++) overrides[`pr#1.wait-${k}`] = RUNNING;
  const { calls, result: res, error, prLabels, workflowCalls } = await runFlow(overrides);
  assert.equal(PR_PUSH_MAX_WAIT_SEC, 3600);
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  assert.deepEqual(prLabels, ['pr#1', ...WAIT_LABELS, 'pr#1.stop']);
  assert.ok(prompts(calls, 'pr#1.stop')[0].endsWith(`\npr-push stop ${PUSH_LOG}`));
  assert.equal(res.status, 'pr_phase_failed');
  assert.equal(res.error_category, 'pr_phase_failed');
  assert.equal(res.failed_step, 'push');
  assert.equal(res.failure_reason, PR_PUSH_WAIT_CAPPED_REASON);
  assert.equal(res.committed, true);
  assert.equal(res.head_sha, HEAD);
  assert.equal(res.push_log, PUSH_LOG);
  assert.equal(workflowCalls.length, 0, 'nested pr-iterate へ進んだ');
});

test('[pr-push] AC-3: lock の待ち上限は 1800 秒で、切り離した push の打ち切りは workflow の待機の累計上限より長い', () => {
  const script = readFileSync(join(here, '..', 'dev-flow', 'scripts', 'pr-push.sh'), 'utf8');
  assert.equal(script.match(/PR_PUSH_LOCK_WAIT_SECONDS:-(\d+)/)?.[1], '1800');
  assert.ok(Number(script.match(/PR_PUSH_TIMEOUT_SEC:-(\d+)/)?.[1]) > PR_PUSH_MAX_WAIT_SEC);
});

test('[pr-push] AC-7: push の記述がある文書は新しい起動形と上限に揃い、bg-job.sh は pr-push だけが認証付き network I/O の例外だと書く', () => {
  const repoRoot = join(here, '..', '..', '..');
  const read = (...p) => readFileSync(join(...p), 'utf8');
  const docs = {
    'exec-proxy.md': read(here, '..', 'dev-flow', 'references', 'exec-proxy.md'),
    'pipeline.md': read(here, '..', 'dev-flow', 'references', 'pipeline.md'),
    'SKILL.md': read(here, '..', 'dev-flow', 'SKILL.md'),
    '.claude/rules/dev-flow.md': read(repoRoot, '.claude', 'rules', 'dev-flow.md'),
    'bg-job.sh': read(here, 'scripts', 'bg-job.sh').split('\n').filter((l) => l.startsWith('#')).join('\n'),
  };
  for (const [name, text] of Object.entries(docs)) {
    assert.ok(/start( |`).*wait/.test(text) && text.includes('pr-push'), `${name} に pr-push の start / wait が無い`);
    for (const limit of ['1800', '3600']) assert.ok(text.includes(limit), `${name} に上限 ${limit} が無い`);
  }
  assert.ok(docs['exec-proxy.md'].includes('`pr-push stop`') && docs['pipeline.md'].includes('`pr-push stop`') && docs['SKILL.md'].includes('`pr-push stop <log>`'));
  assert.ok(/認証付きの network I\/O は[\s\S]{0,40}pr-push[\s\S]*?だけが例外/.test(docs['bg-job.sh']), docs['bg-job.sh'].slice(0, 800));
});

test('[pr-push] AC-5: proxy が pr-push を経ずに push した応答は PR_PUSH_NOT_INVOKED_REASON になり、proxy の文も push log も載らない', async () => {
  for (const response of [
    { failure_reason: 'hook が失敗したようです' },
    { failure_reason: 'x', push_result: { status: 'failed' } },
    { failure_reason: 'x', push_result: { status: 'done', log: PUSH_LOG } },
  ]) {
    const { result: res, prLabels } = await runFlow({ 'pr#1': { pr_url: '', pr_number: 0, committed: true, failed_step: 'push', ...response }, 'pr#1.stop': STOPPED });
    assert.equal(res.failed_step, 'push');
    assert.equal(res.failure_reason, PR_PUSH_NOT_INVOKED_REASON, JSON.stringify(response));
    assert.ok(!('push_log' in res), `push_log が載っている: ${res.push_log}`);
    // start だけ済んでいる形もあるので止める
    assert.deepEqual(prLabels, ['pr#1', 'pr#1.stop']);
  }
});

test('[pr-push] AC-5: failure_reason は pr-push の末尾行の verbatim で、proxy の文を使わない（最初の wait・wait の spawn のどちらで失敗しても同じ）', async () => {
  const first = await runFlow({ 'pr#1': { pr_url: '', pr_number: 0, committed: true, head_sha: HEAD, failed_step: 'push', failure_reason: 'proxy が作文した理由', push_result: FAILED } });
  assert.equal(first.result.failure_reason, FAILED_TAIL);
  assert.equal(first.result.push_log, PUSH_LOG);
  assert.deepEqual(first.prLabels, ['pr#1']);

  const waited = await runFlow({ 'pr#1': PR_RUNNING, 'pr#1.wait-1': FAILED });
  assert.equal(waited.result.status, 'pr_phase_failed');
  assert.equal(waited.result.failed_step, 'push');
  assert.equal(waited.result.failure_reason, FAILED_TAIL);
  assert.equal(waited.result.head_sha, HEAD);
  assert.deepEqual(waited.prLabels, ['pr#1', 'pr#1.wait-1'], 'push が終わった run で stop も create も呼ばない');
});

test('[pr-push] AC-5: proxy が failed_step を付け忘れても、失敗の結果があれば push の失敗として末尾行を載せる', async () => {
  const { result: res } = await runFlow({ 'pr#1': { pr_url: '', pr_number: 0, committed: true, failed_step: '', failure_reason: '', push_result: FAILED } });
  assert.equal(res.failed_step, 'push');
  assert.equal(res.failure_reason, FAILED_TAIL);
});

test('[pr-push] wait の JSON が読めない: 繰り返しをやめて pr-push stop を呼び、固定文言の failed_step:"push" で終わる（push を通ったとみなさない）', async () => {
  for (const bad of [null, { status: 'passed' }, { status: 'done', log: PUSH_LOG }, result('error', null)]) {
    const { result: res, prLabels } = await runFlow({ 'pr#1': PR_RUNNING, 'pr#1.wait-1': bad, 'pr#1.wait-2': PASSED, 'pr#1.stop': STOPPED });
    assert.deepEqual(prLabels, ['pr#1', 'pr#1.wait-1', 'pr#1.stop'], JSON.stringify(bad));
    assert.equal(res.failed_step, 'push');
    assert.equal(res.failure_reason, PR_PUSH_TAIL_UNAVAILABLE);
    assert.equal(res.push_log, PUSH_LOG);
  }
});

test('[pr-push] AC-5: 最初の wait の JSON を受け取れず proxy が固定 JSON を返した: pr-push stop を呼び、固定文言で終わる', async () => {
  const { result: res, prLabels } = await runFlow({
    'pr#1': { pr_url: '', pr_number: 0, committed: true, head_sha: HEAD, failed_step: 'push', failure_reason: '', push_result: { status: 'error', exit_code: null, log: PUSH_LOG, tail: '' } },
    'pr#1.stop': STOPPED,
  });
  assert.deepEqual(prLabels, ['pr#1', 'pr#1.stop']);
  assert.equal(res.failure_reason, PR_PUSH_TAIL_UNAVAILABLE);
  assert.equal(res.push_log, PUSH_LOG);
});

const THROW = () => { throw new Error('injected'); };

test('[pr-push] AC-6: PR phase の spawn が throw した経路でも pr-push stop を呼んで投げ直し、abort の記録先は落ちた spawn のまま', async () => {
  for (const [overrides, expected, failedLabel] of [
    [{ 'pr#1': THROW }, ['pr#1', 'pr#1.stop'], 'pr#1'],
    [{ 'pr#1': PR_RUNNING, 'pr#1.wait-1': THROW }, ['pr#1', 'pr#1.wait-1', 'pr#1.stop'], 'pr#1.wait-1'],
    [{ 'pr#1': PR_RUNNING, 'pr#1.wait-1': PASSED, 'pr#1.create': THROW }, ['pr#1', 'pr#1.wait-1', 'pr#1.create', 'pr#1.stop'], 'pr#1.create'],
  ]) {
    const { calls, error, prLabels, workflowCalls } = await runFlow({ 'pr#1.stop': STOPPED, ...overrides });
    assert.ok(error?.message.includes('injected'), `${failedLabel}: throw が投げ直されない: ${error?.message}`);
    assert.deepEqual(prLabels, expected);
    assert.ok(prompts(calls, 'pr#1.stop')[0].endsWith(`\npr-push stop ${PUSH_LOG}`));
    assert.equal(workflowCalls.length, 0);
    const abortLog = calls.find((c) => c.label === 'journal-log-abort');
    assert.ok(abortLog?.prompt.includes(`abort@PR/${failedLabel}: injected`), `abort の記録先が ${failedLabel} でない:\n${abortLog?.prompt.slice(0, 600)}`);
  }
});

test('[pr-push] AC-6: stop の spawn 自体が throw しても元の throw を投げ直す', async () => {
  const { error, prLabels } = await runFlow({ 'pr#1': THROW, 'pr#1.stop': () => { throw new Error('stop failed'); } });
  assert.ok(error?.message.includes('injected'), error?.message);
  assert.deepEqual(prLabels, ['pr#1', 'pr#1.stop']);
});

test('[pr-push] pr#1 が null: pr-push stop を呼び、従来どおり need が abort にする', async () => {
  const { error, prLabels } = await runFlow({ 'pr#1': null, 'pr#1.stop': STOPPED });
  assert.ok(error?.message.includes('PR が結果を返しませんでした'), error?.message);
  assert.deepEqual(prLabels, ['pr#1', 'pr#1.stop']);
});

test('[pr-push] commit で止まった run・pr-create で止まった run は stop しない（push は走っていない）', async () => {
  const commit = await runFlow({ 'pr#1': { pr_url: '', pr_number: 0, committed: false, failed_step: 'commit', failure_reason: 'x' } });
  assert.deepEqual(commit.prLabels, ['pr#1']);
  const create = await runFlow({ 'pr#1': { pr_url: '', pr_number: 0, committed: true, failed_step: 'pr-create', failure_reason: 'gh failed', push_result: PASSED } });
  assert.deepEqual(create.prLabels, ['pr#1']);
  assert.equal(create.result.failed_step, 'pr-create');
  assert.equal(create.result.failure_reason, 'gh failed');
});

test('[pr-push] wait の後の gh pr create の失敗は failed_step:"pr-create" で、push から始めない回収コマンドになる', async () => {
  const { result: res, prLabels } = await runFlow({
    'pr#1': PR_RUNNING, 'pr#1.wait-1': PASSED,
    'pr#1.create': { pr_url: '', pr_number: 0, committed: true, head_sha: HEAD, failed_step: 'pr-create', failure_reason: 'GraphQL: base branch not found' },
  });
  assert.deepEqual(prLabels, ['pr#1', 'pr#1.wait-1', 'pr#1.create']);
  assert.equal(res.failed_step, 'pr-create');
  assert.equal(res.failure_reason, 'GraphQL: base branch not found');
  assert.ok(res.recovery_commands[0].startsWith('gh pr create '), res.recovery_commands[0]);
});
