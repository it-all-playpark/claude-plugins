// pr-iterate.js の ci-verify（issue #861）: dev-flow が args.ci_verify を渡した run は、ci_verify.checks を review ⇄ fix の
// round の CI 判定から外し（check-ci --exclude）、LGTM 後に別ループ（ci-verify#i.k、check-ci --only）で
// wait_ceiling_seconds まで完了を待つ。check の結果ごとに:
//   - success → LGTM。返り値 ci_verify.status='passed' と check run の URL（dev-flow が AC を satisfied にする根拠）
//   - failure → 失敗した job の link とログ取得手順を fix に渡して直させ、次 iteration でもう一度待つ（pr-iterate の上限 MAX に含める）
//   - 上限まで未完了 → LGTM のまま ci_verify.status='pending'（dev-flow が ac_ci_pending で HOLD にする）
// ci_verify を渡さない run（単体起動・ci の AC が無い dev-flow run）は ci-verify を起動せず、round の CI 判定も従来どおり。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makePrIterateSandbox, runWorkflowCapture, assertNoCrash } from './test-helpers/vm-sandbox.mjs';
import { runCheckCiWithRollup } from './test-helpers/check-ci-gh-stub.mjs';
import { CI_RELAY_STDOUT, ciVerifyPrompt, checkCiCommand, CI_VERIFY_POLL_SECONDS } from './ci-check.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', '.claude', 'workflows', 'pr-iterate.js'), 'utf8');

const CI_VERIFY = { label: 'full-ci', checks: ['e2e'], wait_ceiling_seconds: 1500 };
const E2E_LINK = 'https://github.com/acme/skills/actions/runs/77/job/88';

const verifyPending = (slept) => ({ ...(slept ? { slept: true } : {}), status: 'pending', passed: 0, failed: 0, pending: 1, skipped: 0, failed_checks: [], passed_checks: [] });
const verifyPassed = (slept) => ({ ...(slept ? { slept: true } : {}), status: 'passed', passed: 1, failed: 0, pending: 0, skipped: 0, failed_checks: [], passed_checks: [{ name: 'e2e', bucket: 'pass', state: 'SUCCESS', link: E2E_LINK }] });
const verifyFailed = (slept) => ({ ...(slept ? { slept: true } : {}), status: 'failed', passed: 0, failed: 1, pending: 0, skipped: 0, failed_checks: [{ name: 'e2e', bucket: 'fail', state: 'FAILURE', link: E2E_LINK }], passed_checks: [] });

async function run(overrides, args = { pr: 5, ci_verify: CI_VERIFY }) {
  const { ctx, calls, logs } = makePrIterateSandbox({ overrides, args });
  const { result, error } = await runWorkflowCapture(src, ctx, '.claude/workflows/pr-iterate.js');
  assertNoCrash(error, 'priterate-ci-verify');
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  return { result, calls, logs };
}

const verifyCalls = (calls) => calls.filter((c) => c.label.startsWith('ci-verify#'));

test('[ci-verify] success: round の CI 判定から e2e を外し、LGTM 後の待ちで e2e が success → lgtm・ci_verify.status=passed と check run の URL', async () => {
  const { result, calls } = await run({
    'ci-verify#1.1': verifyPending(false),
    'ci-verify#1.2': verifyPassed(true),
  });
  assert.equal(result.status, 'lgtm');
  assert.equal(result.ci_verify.status, 'passed');
  assert.deepEqual(JSON.parse(JSON.stringify(result.ci_verify.urls)), [E2E_LINK]);
  assert.equal(result.ci_verify.waited_seconds, CI_VERIFY_POLL_SECONDS);
  assert.equal(result.ci_verify.poll_attempts, 2);

  const roundCi = calls.find((c) => c.label === 'ci-check#1');
  assert.ok(roundCi.prompt.includes(`--exclude 'e2e'`), `round の CI 判定は e2e を外す: ${roundCi.prompt}`);
  const v = verifyCalls(calls);
  assert.deepEqual(v.map((c) => c.label), ['ci-verify#1.1', 'ci-verify#1.2']);
  assert.equal(v[0].prompt, ciVerifyPrompt({ pr: 5, repo: 'acme/skills', checks: ['e2e'], seconds: 0 }));
  assert.equal(v[1].prompt, ciVerifyPrompt({ pr: 5, repo: 'acme/skills', checks: ['e2e'], seconds: CI_VERIFY_POLL_SECONDS }));
  assert.ok(v[1].prompt.endsWith(`\n${checkCiCommand({ pr: 5, repo: 'acme/skills', only: ['e2e'], wait: CI_VERIFY_POLL_SECONDS })}`), v[1].prompt);
  assert.ok(v[0].prompt.endsWith(`\n${checkCiCommand({ pr: 5, repo: 'acme/skills', only: ['e2e'] })}`), '1 回目の poll は待たない');
  for (const c of v) assert.equal(JSON.stringify(c.schema), JSON.stringify(CI_RELAY_STDOUT), `${c.label} の schema は canonical の CI_RELAY_STDOUT であるべき`);
  assert.equal(calls.filter((c) => c.label.startsWith('fix#')).length, 0);
});

test('[ci-verify] failure: 失敗した job の link とログ取得手順を fix に渡し、次 iteration でもう一度待つ（success → lgtm）', async () => {
  const { result, calls } = await run({
    'ci-verify#1.1': verifyFailed(false),
    'ci-verify#2.1': verifyPassed(false),
  });
  const fix = calls.find((c) => c.label === 'fix#1');
  assert.ok(fix, `fix#1 が dispatch されていない: ${calls.map((c) => c.label).join(', ')}`);
  assert.ok(fix.prompt.includes('ci::e2e') && fix.prompt.includes(E2E_LINK), `fix に失敗した check と link を渡す: ${fix.prompt}`);
  assert.ok(fix.prompt.includes('gh run view <run-id> --log-failed --job <job-id>'), `fix に失敗ログの取得手順を渡す: ${fix.prompt}`);
  assert.ok(calls.some((c) => c.label === 'review#2'), '再修正の後は次 iteration で再 review する');
  assert.deepEqual(verifyCalls(calls).map((c) => c.label), ['ci-verify#1.1', 'ci-verify#2.1']);
  assert.equal(result.status, 'lgtm');
  assert.equal(result.fixes_applied, 1);
  assert.equal(result.ci_verify.status, 'passed');
});

test('[ci-verify] failure の再修正は pr-iterate の上限に含める（max_iterations=1 なら fix 後に max_reached、ci_verify.status=failed）', async () => {
  const { result, calls } = await run({ 'ci-verify#1.1': verifyFailed(false) }, { pr: 5, max_iterations: 1, ci_verify: CI_VERIFY });
  assert.ok(calls.some((c) => c.label === 'fix#1'));
  assert.equal(calls.filter((c) => c.label.startsWith('review#2')).length, 0);
  assert.equal(result.status, 'max_reached');
  assert.equal(result.ci_verify.status, 'failed');
});

test('[ci-verify] 上限超過: wait_ceiling_seconds まで pending → lgtm のまま ci_verify.status=pending（fix に回さない）', async () => {
  const overrides = { 'ci-verify#1.1': verifyPending(false) };
  for (let k = 2; k <= 10; k++) overrides[`ci-verify#1.${k}`] = verifyPending(true);
  const { result, calls } = await run(overrides, { pr: 5, ci_verify: { ...CI_VERIFY, wait_ceiling_seconds: 200 } });
  assert.equal(result.status, 'lgtm');
  assert.equal(result.ci_verify.status, 'pending');
  // 0s → 90s → 180s で判定し、次の 90s を足すと 200s を超えるので打ち切る
  assert.equal(verifyCalls(calls).length, 3);
  assert.equal(result.ci_verify.waited_seconds, 180);
  assert.equal(calls.filter((c) => c.label.startsWith('fix#')).length, 0);
});

// label が無い event の run で skipped になった e2e（`if: contains(labels,'full-ci')`）は success の根拠にならない。
// 実物の check-ci --only の出力をそのまま ci-verify の応答に使い、passed / URL 採取に倒れないことを pin する。
function checkCiOnly(snapshot, name) {
  const r = runCheckCiWithRollup(JSON.stringify(snapshot), ['--only', name]);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('[ci-verify] skipped の e2e は passed にならない: check-ci --only の実出力で pending のまま上限 → ci_verify.status=pending・URL なし', async () => {
  const skipped = checkCiOnly([
    { name: 'lint', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-01-01T00:00:00Z' },
    { name: 'e2e', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SKIPPED', startedAt: '2026-01-01T00:00:00Z', detailsUrl: E2E_LINK },
  ], 'e2e');
  assert.equal(skipped.status, 'pending');
  assert.deepEqual(skipped.passed_checks, []);
  const overrides = { 'ci-verify#1.1': skipped };
  for (let k = 2; k <= 10; k++) overrides[`ci-verify#1.${k}`] = { ...skipped, slept: true };
  const { result, calls } = await run(overrides, { pr: 5, ci_verify: { ...CI_VERIFY, wait_ceiling_seconds: 200 } });
  assert.equal(result.status, 'lgtm');
  assert.equal(result.ci_verify.status, 'pending');
  assert.deepEqual(JSON.parse(JSON.stringify(result.ci_verify.urls ?? [])), []);
  assert.equal(calls.filter((c) => c.label.startsWith('fix#')).length, 0);
});

for (const [name, response] of [
  ['null', null],
  ['{"stdout": ""}', { stdout: '' }],
  ['slept:false の stdout', { stdout: JSON.stringify({ slept: false, status: 'pending', passed: 0, failed: 0, pending: 0, skipped: 0 }) }],
]) {
  test(`[ci-verify] 待機の不成立（${name}）は積算せず pending で打ち切る`, async () => {
    const { result, calls } = await run({ 'ci-verify#1.1': verifyPending(false), 'ci-verify#1.2': response });
    assert.equal(result.status, 'lgtm');
    assert.equal(result.ci_verify.status, 'pending');
    assert.equal(result.ci_verify.waited_seconds, 0);
    assert.equal(verifyCalls(calls).length, 2);
  });
}

test('[ci-verify] ci_verify を渡さない run は ci-verify を起動せず、round の CI 判定も check を外さない', async () => {
  const { result, calls } = await run({}, '5');
  assert.equal(result.status, 'lgtm');
  assert.equal(verifyCalls(calls).length, 0);
  assert.equal('ci_verify' in result, false);
  const roundCi = calls.find((c) => c.label === 'ci-check#1');
  assert.ok(!roundCi.prompt.includes('--exclude'), roundCi.prompt);
});

// dev-flow が ci の AC を PR 前のローカル実行（local-verify。issue #863）で決着させた run は wait:false を渡す。
test('[ci-verify] wait:false: round の CI 判定から e2e を外したまま、LGTM 後の完了待ちに入らない（ci_verify.status=not_run）', async () => {
  const { result, calls } = await run({}, { pr: 5, ci_verify: { ...CI_VERIFY, wait: false } });
  assert.equal(result.status, 'lgtm');
  assert.equal(verifyCalls(calls).length, 0);
  assert.equal(result.ci_verify.status, 'not_run');
  const roundCi = calls.find((c) => c.label === 'ci-check#1');
  assert.ok(roundCi.prompt.includes(`--exclude 'e2e'`), roundCi.prompt);
});

test('[ci-verify] args.ci_verify の不正形は明示 throw', async () => {
  for (const ciVerify of [
    { label: 'full-ci', checks: [], wait_ceiling_seconds: 1500 },
    { ...CI_VERIFY, wait: 'false' },
  ]) {
    const { ctx } = makePrIterateSandbox({ args: { pr: 5, ci_verify: ciVerify } });
    const { error } = await runWorkflowCapture(src, ctx, '.claude/workflows/pr-iterate.js');
    assert.match(String(error?.message), /args\.ci_verify が不正形/, JSON.stringify(ciVerify));
  }
});
