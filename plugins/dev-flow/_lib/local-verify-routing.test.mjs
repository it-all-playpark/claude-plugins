// ci の AC（ci_verify で CI の check が判定する AC。issue #861）を、repo が "dev-flow".local_verify を宣言した run では
// PR の前に pg-broker の DB でローカル実行して判定する経路を VM 実行で pin する（issue #863）。
// pg-broker と宣言コマンドは local-verify の exec-proxy 応答（start / wait / stop の stdout JSON）でスタブにする。
//   (P) exit 0 → ci の AC を satisfied（根拠は log_path と exit code）。PR に label は付けるが pr-iterate は check を待たない
//   (F) 失敗 → log_tail を付けて dev-implementer に差し戻し（AGENT_AC_REIMPL_MAX を Evaluate と共有）、上限後は ac_agent_unsatisfied
//   (U) pg-broker に届かない → #861 の CI 待ちの経路（pr-iterate に wait 無しの ci_verify）。理由を終端サマリーに出す
//   (N) local_verify が無い repo・ci の AC が無い run は local-verify を起動しない
// AC コマンド（issue #1208。観測型 AC が inline code で指定したコマンドを、analyze ゲートで凍結して local-verify で実行する）:
//   (AV-*) 判定の純関数（最終 tree で passed → 開示だけで proven にしない・tree が異なる passed → 再実行・failed → 差し戻し・
//          error → 人手 AC のまま）
//   (AP) exit 0 → 人手 AC（ac_human_pending の HOLD）のまま終端サマリーに開示 (AT) 最終 tree が異なれば再実行
//   (AF) 失敗 → log_tail 付きで差し戻し、上限後は ac_agent_unsatisfied (AE) error → 人手 AC 待ちのまま

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash, devFlowArgs, prerunAnalyze, acObservationalResponse } from './test-helpers/vm-sandbox.mjs';
import { AGENT_AC_REIMPL_MAX } from './ac-actor.mjs';
import { localVerifyConfigArg, AC_VERIFY_TIMEOUT_SEC, acVerifyValidateAction, acVerifyFinalAction, acVerifyDisclosures, applyAcVerifyResults, mergeAcVerifyGaps } from './local-verify.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', '.claude/workflows/dev-flow.js'), 'utf8');

const CI_VERIFY = { label: 'full-ci', checks: ['e2e'], commands: ['pnpm test:e2e:local'], wait_ceiling_seconds: 1500 };
const LOCAL_VERIFY = { command: 'pnpm test:e2e:local', db: { engine: 'postgres', version: '17' }, env: 'E2E_EXTERNAL_DATABASE_URL', timeout_seconds: 1500 };
const CODE_AC = 'tenant ID を持たない query を repository 層で拒否する';
const E2E_AC = '`pnpm test:e2e:local` で `tenant-isolation.spec.ts` が通ることを確認する';
const LOG_PATH = '/tmp/wt/.devflow-tmp/local-verify/logs/command.log';
const E2E_LINK = 'https://github.com/acme/webapp/actions/runs/77/job/88';

const running = { ok: true, status: 'running', log_path: LOG_PATH };
const passed = { ok: true, status: 'passed', exit_code: 0, log_path: LOG_PATH, log_tail: '1 passed', db_deleted: true };
const failed = { ok: false, status: 'failed', exit_code: 1, log_path: LOG_PATH, log_tail: 'tenant-isolation.spec.ts: expected 403, got 200', db_deleted: true };
const stopped = { ok: true, stopped: false, was_running: false, db_deleted: true };

const plain = (v) => JSON.parse(JSON.stringify(v));

async function run({ acs = [CODE_AC, E2E_AC], ciVerify = CI_VERIFY, localVerify = LOCAL_VERIFY, overrides = {}, iterate = {} } = {}) {
  const iterateArgs = [];
  const { ctx, calls } = makeDevFlowSandbox({
    overrides,
    workflow: async (_name, a) => { iterateArgs.push(plain(a)); return { status: 'lgtm', iterations: 1, fixes_applied: 0, ...iterate }; },
    extra: { args: devFlowArgs(1, { analyze: prerunAnalyze({ acceptance_criteria: acs }), ...(ciVerify ? { ci_verify: ciVerify } : {}), ...(localVerify ? { local_verify: localVerify } : {}) }) },
  });
  const { result, error } = await runWorkflowCapture(src, ctx);
  assertNoCrash(error, 'local-verify-routing');
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  const summary = calls.find((c) => c.label === 'post-summary')?.prompt ?? '';
  return { result, calls, iterateArgs, summary };
}

const localVerifyCalls = (calls) => calls.filter((c) => c.label.startsWith('local-verify-'));
const localReimplCalls = (calls) => calls.filter((c) => /^reimpl-local-verify#\d+:serial:issue-1$/.test(c.label));

test('[local-verify-routing] (P) exit 0 → ci の AC を satisfied（HOLD しない）。PR に label は付け、pr-iterate は check を待たない（wait:false）', async () => {
  const { result, calls, iterateArgs, summary } = await run({
    overrides: { 'local-verify-start#1': running, 'local-verify-wait#1.1': passed, 'local-verify-stop#1': stopped },
  });
  assert.deepEqual(localVerifyCalls(calls).map((c) => c.label), ['local-verify-start#1', 'local-verify-wait#1.1', 'local-verify-stop#1']);
  // Validate（test#1）が green になった後・Evaluate（eval#1）の前に実行する
  const at = (label) => calls.findIndex((c) => c.label === label);
  assert.ok(at('test#1') < at('local-verify-start#1') && at('local-verify-stop#1') < at('eval#1'), calls.map((c) => c.label).join(', '));
  assert.equal(localReimplCalls(calls).length, 0);

  assert.equal(result.merge_tier, 'REVIEW', JSON.stringify(result.merge_tier_hold_reasons));
  assert.deepEqual(plain(result.final_unsatisfied_ac_by_actor), { agent: [], human: [], ci: [] });
  // tree_hash は Validate の diff-gate の hash（最後に test を走らせた tree）。最終 tree と一致するので再実行しない
  assert.deepEqual(plain(result.local_verify), { status: 'passed', command: 'pnpm test:e2e:local', label: 'full-ci', exit_code: 0, log_path: LOG_PATH, reimpl_count: 0, tree_hash: 'AAA' });
  assert.ok(calls.some((c) => c.label === 'diff-hash-local-verify-final'), '最終 tree の hash を取って突き合わせる');
  // start には Setup 時に検証した宣言を渡す（worktree の宣言を読み直させない）
  assert.ok(calls.find((c) => c.label === 'local-verify-start#1').prompt.endsWith(` --config-pct ${localVerifyConfigArg(LOCAL_VERIFY)}`));
  assert.equal(result.ci_verify, null);

  assert.ok(calls.find((c) => c.label === 'pr#1').prompt.includes('--label "full-ci"'), 'ローカルで satisfied でも PR に label は付ける');
  assert.equal(iterateArgs.length, 1);
  assert.deepEqual(iterateArgs[0].ci_verify, { label: 'full-ci', checks: ['e2e'], wait_ceiling_seconds: 1500, wait: false });

  assert.ok(summary.includes('ローカル実行（pnpm test:e2e:local）が exit 0: ' + LOG_PATH), '根拠は log_path と exit code');
  assert.ok(summary.includes('マージ前: PR の CI（`full-ci` ラベルで走る build / docker-build / 全 unit テスト等）の結果を確認する'), summary);
});

test(`[local-verify-routing] (F) 失敗 → log_tail 付きで dev-implementer に差し戻し、${AGENT_AC_REIMPL_MAX} 回後も失敗なら ac_agent_unsatisfied で HOLD（Evaluate の差し戻しと上限を共有）`, async () => {
  const overrides = {
    // Evaluate は agent の AC（AC-1）も未達と返す — 上限を local-verify で使い切っているので差し戻さない
    'eval#1': {
      verdict: 'pass', total: 100, threshold: 80, feedback: [], feedback_level: 'implementation',
      ac_results: [{ ac_index: 0, satisfied: false, verified_by: 'inspection', evidence: '未実装' }, { ac_index: 1, satisfied: true, verified_by: 'inspection', evidence: 'ok' }],
      security_clearance: [], concern_resolutions: [],
    },
  };
  for (let k = 1; k <= AGENT_AC_REIMPL_MAX + 1; k++) {
    overrides[`local-verify-start#${k}`] = running;
    overrides[`local-verify-wait#${k}.1`] = failed;
    overrides[`local-verify-stop#${k}`] = stopped;
  }
  const { result, calls, iterateArgs, summary } = await run({ overrides });

  const reimpl = localReimplCalls(calls);
  assert.equal(reimpl.length, AGENT_AC_REIMPL_MAX, calls.map((c) => c.label).join(', '));
  for (const c of reimpl) {
    assert.ok(c.prompt.includes('tenant-isolation.spec.ts: expected 403, got 200'), `差し戻しに log_tail を付ける: ${c.prompt}`);
    assert.ok(c.prompt.includes(LOG_PATH), c.prompt);
  }
  // 差し戻しの後は unit テストを確かめてからローカル実行をやり直す
  assert.ok(calls.some((c) => c.label === 'test#local-verify-1'));
  assert.equal(localVerifyCalls(calls).filter((c) => c.label.startsWith('local-verify-start#')).length, AGENT_AC_REIMPL_MAX + 1);
  assert.equal(calls.filter((c) => /^reimpl#\d+:serial:/.test(c.label)).length, 0, 'Evaluate は上限を使い切っているので差し戻さない');

  assert.equal(result.merge_tier, 'HOLD');
  assert.deepEqual(plain(result.merge_tier_hold_reasons.map((r) => r.code)), ['ac_agent_unsatisfied']);
  assert.deepEqual(plain(result.final_unsatisfied_ac_by_actor), { agent: [0, 1], human: [], ci: [] });
  assert.equal(result.local_verify.status, 'failed');
  assert.equal(iterateArgs[0].ci_verify.wait, false, 'ローカルで決着した run は CI の check を待たない');
  assert.ok(summary.includes(`exit 1（差し戻し ${AGENT_AC_REIMPL_MAX} 回後も失敗。log: ${LOG_PATH}）`), summary);
});

// (T) exit 0 を出した tree と最終 tree（Evaluate の差し戻し・pr-iterate の fix 後）が異なる run
const passedOnce = { 'local-verify-start#1': running, 'local-verify-wait#1.1': passed, 'local-verify-stop#1': stopped };

test('[local-verify-routing] (T1) pr-iterate の fix で最終 tree が変わった → 最終 tree で再実行し、その exit 0 で ci の AC を satisfied にする', async () => {
  const { result, calls } = await run({
    overrides: {
      ...passedOnce,
      'reconcile-sync': { ok: true, head: 'a'.repeat(40) },
      'diff-hash-local-verify-final': { hash: 'BBB', empty: false },
      'local-verify-start#final': running, 'local-verify-wait#final.1': passed, 'local-verify-stop#final': stopped,
    },
    iterate: { fixes_applied: 1 },
  });
  assert.deepEqual(localVerifyCalls(calls).map((c) => c.label), ['local-verify-start#1', 'local-verify-wait#1.1', 'local-verify-stop#1', 'local-verify-start#final', 'local-verify-wait#final.1', 'local-verify-stop#final']);
  const at = (label) => calls.findIndex((c) => c.label === label);
  assert.ok(at('reconcile-sync') < at('diff-hash-local-verify-final') && at('diff-hash-local-verify-final') < at('local-verify-start#final'), calls.map((c) => c.label).join(', '));
  assert.equal(localReimplCalls(calls).length, 0, '最終 tree の再実行では差し戻さない');
  assert.equal(result.local_verify.status, 'passed');
  assert.equal(result.local_verify.tree_hash, 'BBB');
  assert.ok(!result.merge_tier_hold_reasons.some((r) => ['ac_ci_pending', 'ac_agent_unsatisfied'].includes(r.code)), JSON.stringify(result.merge_tier_hold_reasons));
  assert.deepEqual(plain(result.final_unsatisfied_ac_by_actor).ci, []);
});

test('[local-verify-routing] (T2) 最終 tree が変わり再実行の結果が取れない → exit 0 を捨てて stale、ci の AC は ac_ci_pending で HOLD', async () => {
  const reason = 'pg-broker: cannot reach broker.sock';
  const { result, calls, summary } = await run({
    overrides: {
      ...passedOnce,
      'diff-hash-local-verify-final': { hash: 'BBB', empty: false },
      'local-verify-start#final': { ok: false, status: 'unavailable', reason }, 'local-verify-stop#final': stopped,
    },
  });
  assert.ok(calls.some((c) => c.label === 'local-verify-start#final'));
  assert.equal(result.local_verify.status, 'stale');
  assert.equal(result.merge_tier, 'HOLD');
  assert.ok(result.merge_tier_hold_reasons.some((r) => r.code === 'ac_ci_pending'), JSON.stringify(result.merge_tier_hold_reasons));
  assert.deepEqual(plain(result.final_unsatisfied_ac_by_actor).ci, [1]);
  const line = summary.split('\n').find((l) => l.startsWith('- ローカル検証 (local_verify):')) ?? '';
  assert.ok(line.includes('の exit 0 は最終 tree の結果ではない') && line.includes(reason), line);
});

test('[local-verify-routing] (T3) fix 後の worktree を最終 HEAD に同期できない → 再実行せず stale、ci の AC は ac_ci_pending で HOLD', async () => {
  const { result, calls } = await run({
    overrides: { ...passedOnce, 'reconcile-sync': { ok: false, error: 'not fast-forward' } },
    iterate: { fixes_applied: 1 },
  });
  assert.ok(!calls.some((c) => c.label === 'diff-hash-local-verify-final' || c.label === 'local-verify-start#final'));
  assert.equal(result.local_verify.status, 'stale');
  assert.equal(result.merge_tier, 'HOLD');
  assert.ok(result.merge_tier_hold_reasons.some((r) => r.code === 'ac_ci_pending'), JSON.stringify(result.merge_tier_hold_reasons));
});

test('[local-verify-routing] (U) pg-broker に届かない → #861 の CI 待ち（wait 無しの ci_verify）で判定し、理由をサマリーに 1 行出す', async () => {
  const reason = 'pg-broker: cannot reach /Users/x/.local/state/pg-broker/broker.sock: [Errno 2] No such file or directory';
  const { result, calls, iterateArgs, summary } = await run({
    overrides: { 'local-verify-start#1': { ok: false, status: 'unavailable', reason }, 'local-verify-stop#1': stopped },
    iterate: { ci_verify: { status: 'passed', checks: ['e2e'], urls: [E2E_LINK] } },
  });
  assert.deepEqual(localVerifyCalls(calls).map((c) => c.label), ['local-verify-start#1', 'local-verify-stop#1']);
  assert.equal(localReimplCalls(calls).length, 0);
  assert.deepEqual(iterateArgs[0].ci_verify, { label: 'full-ci', checks: ['e2e'], wait_ceiling_seconds: 1500 });
  assert.equal(result.local_verify.status, 'unavailable');
  assert.equal(result.ci_verify.status, 'passed');
  assert.equal(result.merge_tier, 'REVIEW', JSON.stringify(result.merge_tier_hold_reasons));
  const line = summary.split('\n').filter((l) => l.startsWith('- ローカル検証 (local_verify):'));
  assert.equal(line.length, 1, summary);
  assert.ok(line[0].includes(`pg-broker に届かない（${reason}） — ci の AC は CI の check の結果で判定した`), line[0]);
});

test('[local-verify-routing] (N) local_verify が無い repo・ci の AC が無い run は local-verify を起動せず、ci_verify も従来どおり', async () => {
  const noLocal = await run({ localVerify: null, iterate: { ci_verify: { status: 'passed', checks: ['e2e'], urls: [E2E_LINK] } } });
  assert.equal(localVerifyCalls(noLocal.calls).length, 0);
  assert.deepEqual(noLocal.iterateArgs[0].ci_verify, { label: 'full-ci', checks: ['e2e'], wait_ceiling_seconds: 1500 });
  assert.equal(noLocal.result.local_verify, null);
  assert.ok(!noLocal.summary.includes('ローカル検証'), noLocal.summary);

  const noCiAc = await run({ acs: [CODE_AC, 'vitest で tenant 分離のテストを追加する'] });
  assert.equal(localVerifyCalls(noCiAc.calls).length, 0);
  assert.equal('ci_verify' in noCiAc.iterateArgs[0], false);
  assert.equal(noCiAc.result.local_verify, null);
});

// ---- AC コマンド（issue #1208） ----

const BUILD_CMD = 'timeout 300 pnpm --filter @acme/landing build';
const BUILD_PATHS = ['packages/landing/out/index.html', 'packages/landing/out/404.html'];
const BUILD_AC = `sandbox 内で \`${BUILD_CMD}\` が exit 0 で終わり、\`${BUILD_PATHS[0]}\` と \`${BUILD_PATHS[1]}\` が生成される`;
const AC_LOG = '/tmp/wt/.devflow-tmp/ac-verify/ac-1/logs/command.log';
const acPassed = { ok: true, status: 'passed', exit_code: 0, log_path: AC_LOG, log_tail: 'built', db_deleted: null };
const acFailed = { ok: false, status: 'failed', exit_code: 0, reason: `command は exit 0 だが expect_paths が worktree に無い: ${BUILD_PATHS[1]}`, log_path: AC_LOG, log_tail: 'Error: page /404 failed to render', db_deleted: null };
const entry = (status, extra = {}) => ({ ac_index: 0, command: BUILD_CMD, expect_paths: BUILD_PATHS, status, exit_code: 0, log_path: AC_LOG, tree_hash: 'AAA', ...extra });
// 終端サマリーのその AC の行に載る開示（devflow-summary-format の acVerify）
const AC_DISCLOSURE = `AC のコマンド \`${BUILD_CMD}\` は最終 tree で exit 0（log: ${AC_LOG}）— 人手確認の材料（AC の達成判定には使っていない）`;

test('[local-verify-routing] (AV-1) 判定の純関数: 最終 tree で passed → 開示だけ（proven にしない）、tree が異なる passed → 再実行、failed → 差し戻し（上限後は未達）、error → 人手 AC のまま', () => {
  // Final reconcile（acVerifyFinalAction）
  assert.equal(acVerifyFinalAction(entry('passed'), 'AAA'), 'disclose');
  assert.equal(acVerifyFinalAction(entry('passed'), 'BBB'), 'rerun');
  assert.equal(acVerifyFinalAction(entry('passed'), null), 'rerun', '最終 tree の hash が取れなければ突き合わせられないので再実行');
  assert.equal(acVerifyFinalAction(entry('failed'), 'AAA'), 'failed');
  for (const status of ['error', 'unavailable', 'skipped', 'stale']) assert.equal(acVerifyFinalAction(entry(status), 'AAA'), 'human', status);
  // Validate green 後の 1 回（acVerifyValidateAction。差し戻し回数は ci の AC・Evaluate と共有）
  assert.equal(acVerifyValidateAction('passed', 0, AGENT_AC_REIMPL_MAX), 'passed');
  assert.equal(acVerifyValidateAction('failed', AGENT_AC_REIMPL_MAX - 1, AGENT_AC_REIMPL_MAX), 'reimpl');
  assert.equal(acVerifyValidateAction('failed', AGENT_AC_REIMPL_MAX, AGENT_AC_REIMPL_MAX), 'failed');
  for (const verdict of ['error', 'unavailable', 'running']) assert.equal(acVerifyValidateAction(verdict, 0, AGENT_AC_REIMPL_MAX), 'human', verdict);
  // 開示は passed の記録だけ（コマンド・exit code・log_path）
  assert.deepEqual(acVerifyDisclosures([entry('passed'), { ...entry('error'), ac_index: 1 }, { ...entry('failed'), ac_index: 2 }, { ...entry('stale'), ac_index: 3 }]),
    [{ ac_index: 0, command: BUILD_CMD, exit_code: 0, log_path: AC_LOG }]);
  assert.deepEqual(acVerifyDisclosures(undefined), []);
});

test('[local-verify-routing] (AV-2) applyAcVerifyResults / mergeAcVerifyGaps: 判定を変えるのは上限後も失敗した記録（agent の未達）だけで、passed・error は人手 AC のまま', () => {
  const demoted = [
    { ac_index: 0, satisfied: false, verified_by: 'inspection', evidence: '観測型 AC — test の red→green 実証が無い', observational: true },
    { ac_index: 1, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
  ];
  // passed・確かめられなかった記録は ac_results を変えない（exit 0 で達成にしない）
  for (const status of ['passed', 'error', 'unavailable', 'skipped', 'stale']) assert.equal(applyAcVerifyResults(demoted, [entry(status)]), demoted, status);
  const failed = applyAcVerifyResults(demoted, [entry('failed', { reason: acFailed.reason })]);
  assert.deepEqual({ satisfied: failed[0].satisfied, verified_by: failed[0].verified_by, unreachable_env: failed[0].unreachable_env, observational: failed[0].observational }, { satisfied: false, verified_by: 'local', unreachable_env: false, observational: true });
  assert.ok(failed[0].evidence.includes(BUILD_PATHS[1]) && failed[0].evidence.includes(AC_LOG), failed[0].evidence);
  assert.equal(failed[1], demoted[1], 'AC コマンドの無い AC は変えない');
  // 結果の無い AC は足す・非配列はそのまま
  assert.deepEqual(applyAcVerifyResults([demoted[1]], [entry('failed')]).map((r) => r.ac_index), [0, 1]);
  assert.equal(applyAcVerifyResults(null, [entry('failed')]), null);

  const gaps = { agent: [1], human: [0], ci: [3] };
  for (const status of ['passed', 'error', 'unavailable', 'skipped', 'stale']) assert.deepEqual(mergeAcVerifyGaps(gaps, [entry(status)]), gaps, status);
  assert.deepEqual(mergeAcVerifyGaps(gaps, [entry('failed')]), { agent: [0, 1], human: [], ci: [3] });
});

async function runAc({ overrides = {}, iterate = {}, acObs = acObservationalResponse([true, false], { 0: { verify_command_index: 0, expect_path_indexes: [1, 2] } }) } = {}) {
  const { ctx, calls, logs } = makeDevFlowSandbox({
    overrides: { 'ac-observational#1': acObs, ...overrides },
    workflow: async () => ({ status: 'lgtm', iterations: 1, fixes_applied: 0, ...iterate }),
    extra: { args: devFlowArgs(1, { analyze: prerunAnalyze({ acceptance_criteria: [BUILD_AC, CODE_AC] }) }) },
  });
  const { result, error } = await runWorkflowCapture(src, ctx);
  assertNoCrash(error, 'local-verify-routing(ac-verify)');
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  const summary = calls.find((c) => c.label === 'post-summary')?.prompt ?? '';
  return { result, calls, logs, summary };
}

const acVerifyCalls = (calls) => calls.filter((c) => c.label.startsWith('ac-verify-'));
const acReimplCalls = (calls) => calls.filter((c) => /^reimpl-ac-verify#\d+:serial:issue-1$/.test(c.label));
const acPassedOnce = { 'ac-verify-start#AC-1.1': running, 'ac-verify-wait#AC-1.1.1': acPassed, 'ac-verify-stop#AC-1.1': stopped };
const acRow = (summary) => summary.split('\n').find((l) => l.startsWith('| ❌ 未達 | AC#1（観測型） |')) ?? '';

test('[local-verify-routing] (AP) AC コマンドが exit 0 → 人手 AC（ac_human_pending の HOLD）のまま、終端サマリーのその AC の行にコマンド・exit code・log_path を載せる。宣言は凍結した AC の inline code（db 無し）だけ', async () => {
  const { result, calls, summary } = await runAc({ overrides: acPassedOnce });
  assert.deepEqual(acVerifyCalls(calls).map((c) => c.label), ['ac-verify-start#AC-1.1', 'ac-verify-wait#AC-1.1.1', 'ac-verify-stop#AC-1.1']);
  const at = (label) => calls.findIndex((c) => c.label === label);
  assert.ok(at('test#1') < at('ac-verify-start#AC-1.1') && at('ac-verify-stop#AC-1.1') < at('eval#1'), calls.map((c) => c.label).join(', '));
  const start = calls.find((c) => c.label === 'ac-verify-start#AC-1.1').prompt;
  assert.ok(start.endsWith(` --config-pct ${localVerifyConfigArg({ command: BUILD_CMD, expect_paths: BUILD_PATHS, timeout_seconds: AC_VERIFY_TIMEOUT_SEC })}`), start);
  assert.ok(start.includes("--state-dir '/tmp/wt/.devflow-tmp/ac-verify/ac-1'"), start);
  assert.ok(calls.some((c) => c.label === 'diff-hash-ac-verify-final'), '最終 tree の hash を取って突き合わせる');
  assert.equal(acReimplCalls(calls).length, 0);
  // evaluator が inspection で satisfied:true を返し、AC コマンドも exit 0 でも proven にしない
  assert.equal(result.merge_tier, 'HOLD');
  assert.deepEqual(plain(result.merge_tier_hold_reasons.map((r) => r.code)), ['ac_human_pending']);
  assert.deepEqual(plain(result.final_unsatisfied_ac_by_actor), { agent: [], human: [0], ci: [] });
  assert.ok(!calls.find((c) => c.label === 'pr#1').prompt.includes(`- [x] ${BUILD_AC}`), 'PR 本文で AC コマンドの AC を checked にしない');
  assert.ok(acRow(summary).includes(AC_DISCLOSURE), `${acRow(summary)}\n---\n${summary}`);
});

test('[local-verify-routing] (AT) exit 0 を出した tree と最終 tree が異なる → 最終 tree で再実行し、passed なら開示、結果が取れなければ開示しない（どちらも人手 AC のまま）', async () => {
  const rerunPassed = await runAc({ overrides: {
    ...acPassedOnce,
    'diff-hash-ac-verify-final': { hash: 'BBB', empty: false },
    'ac-verify-start#AC-1.final': running, 'ac-verify-wait#AC-1.final.1': acPassed, 'ac-verify-stop#AC-1.final': stopped,
  } });
  assert.deepEqual(acVerifyCalls(rerunPassed.calls).map((c) => c.label).slice(3), ['ac-verify-start#AC-1.final', 'ac-verify-wait#AC-1.final.1', 'ac-verify-stop#AC-1.final']);
  assert.equal(acReimplCalls(rerunPassed.calls).length, 0, '最終 tree の再実行では差し戻さない');
  assert.deepEqual(plain(rerunPassed.result.merge_tier_hold_reasons.map((r) => r.code)), ['ac_human_pending']);
  assert.ok(acRow(rerunPassed.summary).includes(AC_DISCLOSURE), acRow(rerunPassed.summary));

  // tree が一致すれば再実行しない
  const same = await runAc({ overrides: acPassedOnce });
  assert.ok(!same.calls.some((c) => c.label === 'ac-verify-start#AC-1.final'), '最終 tree が exit 0 を出した tree と同じなら再実行しない');

  const rerunError = await runAc({ overrides: {
    ...acPassedOnce,
    'diff-hash-ac-verify-final': { hash: 'BBB', empty: false },
    'ac-verify-start#AC-1.final': { ok: false, status: 'error', error: 'local-verify が起動していない' }, 'ac-verify-stop#AC-1.final': stopped,
  } });
  assert.equal(rerunError.result.merge_tier, 'HOLD');
  assert.deepEqual(plain(rerunError.result.merge_tier_hold_reasons.map((r) => r.code)), ['ac_human_pending']);
  assert.deepEqual(plain(rerunError.result.final_unsatisfied_ac_by_actor), { agent: [], human: [0], ci: [] });
  assert.ok(!rerunError.summary.includes('AC のコマンド `'), '最終 tree の結果ではない exit 0 を開示しない');
});

test(`[local-verify-routing] (AF) AC コマンドが失敗 → log_tail 付きで差し戻し、${AGENT_AC_REIMPL_MAX} 回後も失敗なら ac_agent_unsatisfied で HOLD（Evaluate と上限を共有）`, async () => {
  const overrides = {};
  for (let k = 1; k <= AGENT_AC_REIMPL_MAX + 1; k++) {
    overrides[`ac-verify-start#AC-1.${k}`] = running;
    overrides[`ac-verify-wait#AC-1.${k}.1`] = acFailed;
    overrides[`ac-verify-stop#AC-1.${k}`] = stopped;
  }
  const { result, calls, summary } = await runAc({ overrides });
  const reimpl = acReimplCalls(calls);
  assert.equal(reimpl.length, AGENT_AC_REIMPL_MAX, calls.map((c) => c.label).join(', '));
  for (const c of reimpl) {
    assert.ok(c.prompt.includes('Error: page /404 failed to render'), `差し戻しに log_tail を付ける: ${c.prompt}`);
    assert.ok(c.prompt.includes(BUILD_PATHS[1]) && c.prompt.includes(AC_LOG), c.prompt);
  }
  assert.ok(calls.some((c) => c.label === 'test#ac-verify-1'), '差し戻しの後は unit テストを確かめてから再実行する');
  assert.equal(calls.filter((c) => c.label.startsWith('ac-verify-start#')).length, AGENT_AC_REIMPL_MAX + 1);
  assert.equal(calls.filter((c) => /^reimpl#\d+:serial:/.test(c.label)).length, 0, 'Evaluate は上限を使い切っているので差し戻さない');
  assert.equal(result.merge_tier, 'HOLD');
  assert.deepEqual(plain(result.merge_tier_hold_reasons.map((r) => r.code)), ['ac_agent_unsatisfied']);
  assert.deepEqual(plain(result.final_unsatisfied_ac_by_actor), { agent: [0], human: [], ci: [] });
  assert.ok(!summary.includes('人手確認の材料'), '失敗した AC コマンドを確認材料として開示しない');
});

test('[local-verify-routing] (AE) AC コマンドを確かめられない（error）・verify_command が凍結されない → 差し戻さず開示もせず、人手 AC 待ちのまま', async () => {
  const errored = await runAc({ overrides: { 'ac-verify-start#AC-1.1': { ok: false, status: 'error', error: 'local_verify の宣言が不正' }, 'ac-verify-stop#AC-1.1': stopped } });
  assert.equal(acReimplCalls(errored.calls).length, 0);
  assert.equal(errored.calls.filter((c) => /^reimpl#\d+:serial:/.test(c.label)).length, 0);
  assert.equal(errored.result.merge_tier, 'HOLD');
  assert.deepEqual(plain(errored.result.merge_tier_hold_reasons.map((r) => r.code)), ['ac_human_pending']);
  assert.deepEqual(plain(errored.result.final_unsatisfied_ac_by_actor), { agent: [], human: [0], ci: [] });
  assert.ok(!errored.summary.includes('人手確認の材料'), errored.summary);

  // 分類 agent が AC の inline code に無い番号（範囲外の index）を返した・旧形式の文字列（AC と完全一致するコマンドでも）を返した
  // → 凍結されず、AC コマンドを実行しない（従来どおり人手 AC 待ち）
  for (const [name, acObs] of [
    ['範囲外の index', acObservationalResponse([true, false], { 0: { verify_command_index: 3, expect_path_indexes: [1, 2] } })],
    ['旧形式の文字列', { results: [
      { ac_index: 0, observational: true, verify_command: BUILD_CMD, expect_paths: [...BUILD_PATHS] },
      { ac_index: 1, observational: false, verify_command: null, expect_paths: [] },
    ] }],
  ]) {
    const rewritten = await runAc({ acObs });
    assert.equal(acVerifyCalls(rewritten.calls).length, 0, name);
    assert.equal(rewritten.result.merge_tier, 'HOLD', name);
    assert.deepEqual(plain(rewritten.result.merge_tier_hold_reasons.map((c) => c.code)), ['ac_human_pending'], name);
    assert.deepEqual(plain(rewritten.result.final_unsatisfied_ac_by_actor), { agent: [], human: [0], ci: [] }, name);
  }
});
