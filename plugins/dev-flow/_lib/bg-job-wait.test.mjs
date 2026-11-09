// bg-job-wait.test.mjs — 切り離し実行の proxy を待つ共有ループ waitBgJob（issue #1224）。
// 前半は偽の spawn で繰り返し・打ち切り・応答の検証を見る。後半は dev-flow.js を VM で動かし、
// local-verify の各経路（Validate 後の ci の AC・AC コマンド・Final reconcile）がこの関数で待つことを見る。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { waitBgJob } from './bg-job-wait.mjs';
import { localVerifyVerdict, localVerifyWaitPolls, AC_VERIFY_TIMEOUT_SEC } from './local-verify.mjs';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash, devFlowArgs, prerunAnalyze, acObservationalResponse } from './test-helpers/vm-sandbox.mjs';

const SCHEMA = {
  type: 'object',
  required: ['ok', 'status'],
  properties: {
    ok: { type: 'boolean' },
    status: { type: 'string', enum: ['running', 'passed', 'failed', 'timeout', 'stopped', 'unavailable', 'error'] },
    exit_code: { type: ['number', 'null'] },
    log_path: { type: 'string' },
  },
};
const running = { ok: true, status: 'running', log_path: '/wt/log' };
const passed = { ok: true, status: 'passed', exit_code: 0, log_path: '/wt/log' };

// responses を順に返す偽の wait spawn。呼ばれた k を calls に残す。
function fakeWait(responses) {
  const calls = [];
  return { calls, wait: async (k) => { calls.push(k); return responses[calls.length - 1]; } };
}

test('[bg-job-wait] running を N 回返してから結果を返す spawn: 最後の結果がそのまま返り、wait はちょうど N+1 回呼ばれる', async () => {
  for (const n of [0, 1, 3]) {
    const { calls, wait } = fakeWait([...Array(n).fill(running), passed]);
    const res = await waitBgJob({ start: running, wait, maxPolls: n + 1, schema: SCHEMA });
    assert.equal(res, passed, `N=${n}`);
    assert.deepEqual(calls, Array.from({ length: n + 1 }, (_, i) => i + 1), `N=${n}`);
  }
});

test('[bg-job-wait] start が running でなければ wait せず、その応答をそのまま返す', async () => {
  for (const start of [passed, { ok: false, status: 'unavailable', reason: 'x' }, { ok: false, status: 'error', error: 'x' }]) {
    const { calls, wait } = fakeWait([]);
    assert.equal(await waitBgJob({ start, wait, maxPolls: 3, schema: SCHEMA }), start);
    assert.equal(calls.length, 0);
  }
});

test('[bg-job-wait] 上限まで running: wait を上限回数で打ち切り、打ち切りが分かる結果を返す（通過扱いにしない）', async () => {
  const last = { ok: false, status: 'running', log_path: '/wt/last' };
  const { calls, wait } = fakeWait([running, running, last, passed]);
  const res = await waitBgJob({ start: running, wait, maxPolls: 3, schema: SCHEMA });
  assert.equal(calls.length, 3);
  assert.deepEqual(res, { ...last, wait_capped: true });
  assert.equal(localVerifyVerdict(res), 'running');
});

test('[bg-job-wait] 上限が数でなければ wait せず打ち切る（無限に待たない）', async () => {
  const { calls, wait } = fakeWait([passed]);
  const res = await waitBgJob({ start: running, wait, maxPolls: undefined, schema: SCHEMA });
  assert.equal(calls.length, 0);
  assert.equal(res.wait_capped, true);
});

const MALFORMED = [
  null,
  undefined,
  'passed',
  ['running'],
  {},
  { ok: true },
  { status: 'passed', exit_code: 0 },
  { ok: 'true', status: 'passed', exit_code: 0 },
  { ok: true, status: 'done' },
  { ok: true, status: 'running', log_path: 42 },
];

test('[bg-job-wait] start が null・schema に合わない応答: wait せず error の結果を返す', async () => {
  for (const start of MALFORMED) {
    const { calls, wait } = fakeWait([passed]);
    const res = await waitBgJob({ start, wait, maxPolls: 3, schema: SCHEMA });
    assert.equal(calls.length, 0, JSON.stringify(start));
    assert.equal(res.ok, false, JSON.stringify(start));
    assert.equal(res.status, 'error', JSON.stringify(start));
    assert.equal(typeof res.error, 'string', JSON.stringify(start));
    assert.equal(localVerifyVerdict(res), 'error', JSON.stringify(start));
  }
});

test('[bg-job-wait] wait が null・schema に合わない応答: 繰り返しをやめて error の結果を返す', async () => {
  for (const bad of MALFORMED) {
    const { calls, wait } = fakeWait([running, bad, passed]);
    const res = await waitBgJob({ start: running, wait, maxPolls: 5, schema: SCHEMA });
    assert.equal(calls.length, 2, JSON.stringify(bad));
    assert.equal(res.status, 'error', JSON.stringify(bad));
    assert.equal(localVerifyVerdict(res), 'error', JSON.stringify(bad));
  }
});

// ---- local-verify の経路 ----

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', '.claude/workflows/dev-flow.js'), 'utf8');

const CI_VERIFY = { label: 'full-ci', checks: ['e2e'], commands: ['pnpm test:e2e:local'], wait_ceiling_seconds: 1500 };
const LOCAL_VERIFY = { command: 'pnpm test:e2e:local', db: { engine: 'postgres', version: '17' }, env: 'E2E_EXTERNAL_DATABASE_URL', timeout_seconds: 1500 };
const CODE_AC = 'tenant ID を持たない query を repository 層で拒否する';
const E2E_AC = '`pnpm test:e2e:local` で `tenant-isolation.spec.ts` が通ることを確認する';
const BUILD_CMD = 'timeout 300 pnpm --filter @acme/landing build';
const BUILD_AC = `sandbox 内で \`${BUILD_CMD}\` が exit 0 で終わる`;
const stopped = { ok: true, stopped: false, was_running: false, db_deleted: true };
// LOCALVERIFY schema の required（ok）を欠く running。読めない応答なので wait に進まない
const noOk = { status: 'running', log_path: '/wt/log' };

async function runFlow(setup, overrides) {
  const { ctx, calls } = makeDevFlowSandbox({
    overrides,
    workflow: async () => ({ status: 'lgtm', iterations: 1, fixes_applied: 0 }),
    extra: { args: devFlowArgs(1, setup) },
  });
  const { result, error } = await runWorkflowCapture(src, ctx);
  assertNoCrash(error, 'bg-job-wait');
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  return { result, labels: calls.map((c) => c.label) };
}

const runCi = (overrides) => runFlow(
  { analyze: prerunAnalyze({ acceptance_criteria: [CODE_AC, E2E_AC] }), ci_verify: CI_VERIFY, local_verify: LOCAL_VERIFY },
  overrides,
);
const runAc = (overrides) => runFlow(
  { analyze: prerunAnalyze({ acceptance_criteria: [BUILD_AC, CODE_AC] }) },
  { 'ac-observational#1': acObservationalResponse([true, false], { 0: { verify_command_index: 0 } }), ...overrides },
);

test('[bg-job-wait] Validate 後の ci の AC: 上限回数（localVerifyWaitPolls）まで wait し、終わらなければ打ち切って fail-open', async () => {
  const polls = localVerifyWaitPolls(LOCAL_VERIFY.timeout_seconds);
  const overrides = { 'local-verify-start#1': running, 'local-verify-stop#1': stopped };
  for (let k = 1; k <= polls + 2; k++) overrides[`local-verify-wait#1.${k}`] = running;
  const { result, labels } = await runCi(overrides);
  assert.equal(labels.filter((l) => l.startsWith('local-verify-wait#1.')).length, polls);
  assert.equal(result.local_verify.status, 'error');
  assert.ok(result.local_verify.reason.includes(`${LOCAL_VERIFY.timeout_seconds}s を過ぎても終わらない`), result.local_verify.reason);
});

test('[bg-job-wait] Validate 後の ci の AC: start / wait の schema に合わない応答で繰り返しをやめ、error で fail-open（stop は呼ぶ）', async () => {
  const atStart = await runCi({ 'local-verify-start#1': noOk, 'local-verify-wait#1.1': passed, 'local-verify-stop#1': stopped });
  assert.ok(!atStart.labels.includes('local-verify-wait#1.1'), atStart.labels.join(', '));
  assert.ok(atStart.labels.includes('local-verify-stop#1'));
  assert.equal(atStart.result.local_verify.status, 'error');
  assert.ok(atStart.result.local_verify.reason.includes('proxy の応答が無い・形が不正'), atStart.result.local_verify.reason);

  const atWait = await runCi({ 'local-verify-start#1': running, 'local-verify-wait#1.1': noOk, 'local-verify-wait#1.2': passed, 'local-verify-stop#1': stopped });
  assert.ok(!atWait.labels.includes('local-verify-wait#1.2'), atWait.labels.join(', '));
  assert.equal(atWait.result.local_verify.status, 'error');
});

test('[bg-job-wait] AC コマンド: 上限で打ち切り、schema に合わない応答では wait せず、どちらも人手 AC のまま', async () => {
  const polls = localVerifyWaitPolls(AC_VERIFY_TIMEOUT_SEC);
  const capped = { 'ac-verify-start#AC-1.1': running, 'ac-verify-stop#AC-1.1': stopped };
  for (let k = 1; k <= polls + 2; k++) capped[`ac-verify-wait#AC-1.1.${k}`] = running;
  const cappedRun = await runAc(capped);
  assert.equal(cappedRun.labels.filter((l) => l.startsWith('ac-verify-wait#AC-1.1.')).length, polls);
  assert.deepEqual(JSON.parse(JSON.stringify(cappedRun.result.final_unsatisfied_ac_by_actor)), { agent: [], human: [0], ci: [] });

  const malformed = await runAc({ 'ac-verify-start#AC-1.1': noOk, 'ac-verify-wait#AC-1.1.1': passed, 'ac-verify-stop#AC-1.1': stopped });
  assert.ok(!malformed.labels.includes('ac-verify-wait#AC-1.1.1'), malformed.labels.join(', '));
  assert.deepEqual(JSON.parse(JSON.stringify(malformed.result.final_unsatisfied_ac_by_actor)), { agent: [], human: [0], ci: [] });
});

test('[bg-job-wait] Final reconcile の再実行: schema に合わない応答では wait せず stale にする（exit 0 を最終 tree の根拠にしない）', async () => {
  const { result, labels } = await runCi({
    'local-verify-start#1': running, 'local-verify-wait#1.1': passed, 'local-verify-stop#1': stopped,
    'diff-hash-local-verify-final': { hash: 'BBB', empty: false },
    'local-verify-start#final': noOk, 'local-verify-wait#final.1': passed, 'local-verify-stop#final': stopped,
  });
  assert.ok(labels.includes('local-verify-start#final'), labels.join(', '));
  assert.ok(!labels.includes('local-verify-wait#final.1'), labels.join(', '));
  assert.equal(result.local_verify.status, 'stale');
  assert.equal(result.merge_tier, 'HOLD');
});
