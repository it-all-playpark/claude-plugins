// pr-iterate.js の各 round で review#i と ci-check#i を parallel() で同時に起動し、ci-check の応答 head_sha が
// review 開始時の head と一致するときだけ結果を使うことを VM 挙動で pin する（issue #806）。
//
// AC-1: review#i と ci-check#i が同じ parallel() 呼び出しで起動される
// AC-2: head_sha 一致のときだけ採用。不一致・null・throw・head_sha 欠落は review の後に直列の
//       ci-check#i-serial を起動し直す（review 開始時の head が不明な round は並列にせず直列の ci-check#i 1 本）
// AC-3: blocking round は並列で得た ci-check をそのまま 1 回判定に使う（failed のときだけ ci::<name> を合流）
// AC-4: LGTM round は並列で得た ci-check を CI gate の 1 回目の poll に使い、pending なら待機ループへ。
//       ci_poll_attempts は 1 回分（不採用で捨てた並列分は数えない）
// AC-5: review と ci-check の片方が失敗しても、もう片方の結果は失われない
// AC-6: 1 round の spawn 数は直列（head 不明で並列にしない round）と同じ

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makePrIterateSandbox, runWorkflowCapture, assertNoCrash, ciCounts } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const prIteratePath = join(here, '..', '.claude', 'workflows', 'pr-iterate.js');
const src = readFileSync(prIteratePath, 'utf8');

const HEAD1 = '1'.repeat(40);
const HEAD2 = '2'.repeat(40);
const STALE = 'f'.repeat(40);

const PR_META = {
  url: 'https://github.com/acme/skills/pull/5', head_ref: 'feature/x', base_ref: 'main',
  cwd: '/tmp/wt', epoch: 999, head_sha: HEAD1,
};
const REVIEW_DESC = 'null を返す経路で例外を握りつぶしている';
const blockingReview = (topic = 't1') => ({
  decision: 'request-changes',
  issues: [{ severity: 'major', topic, file: 'src/a.js', line: 12, description: REVIEW_DESC, suggestion: 'throw に戻す' }],
  summary: 'ng',
});
const ci = (status, head_sha, extra = {}) => ({ status, ...ciCounts(status), failed_checks: [], ...(head_sha ? { head_sha } : {}), ...extra });
const CI_FAILED_AT = (head_sha) => ci('failed', head_sha, { failed_checks: [{ name: 'bats', bucket: 'fail', state: 'FAILURE' }] });

// parallel() 呼び出しごとに、その呼び出しで起動された agent の label を記録する。
// agent stub は呼び出し開始時に同期で calls へ push するので、thunk を全部起動した直後の calls 差分が
// 同じ parallel() で同時に起動された spawn になる。
async function run(overrides, { headKnown = true } = {}) {
  const { ctx, calls, logs } = makePrIterateSandbox({
    overrides: { 'pr-meta': headKnown ? PR_META : { ...PR_META, head_sha: '' }, ...overrides },
  });
  const groups = [];
  ctx.parallel = async (fns) => {
    const start = calls.length;
    const pending = (fns || []).map((f) => f());
    groups.push(calls.slice(start).map((c) => c.label));
    return Promise.all(pending);
  };
  const { result, error } = await runWorkflowCapture(src, ctx, '.claude/workflows/pr-iterate.js');
  assertNoCrash(error, 'priterate-ci-parallel');
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  return { result, calls, logs, groups, labels: calls.map((c) => c.label) };
}

// ---- AC-1 / AC-4: LGTM round ----
test('[AC-1][AC-4] review#1 と ci-check#1 は同じ parallel() で起動され、一致した passed を CI gate の 1 回目の poll に使って lgtm（直列の再起動なし、ci_poll_attempts=1）', async () => {
  const { result, groups, labels } = await run({ 'ci-check#1': ci('passed', HEAD1) });

  // security review の対象の run（args.security_review の無い単体起動）なので security-scope#1 も同じ group で起動する
  assert.deepEqual(groups, [['review#1', 'ci-check#1', 'security-scope#1']], `parallel() の起動 group が想定と異なる: ${JSON.stringify(groups)}`);
  assert.equal(result?.status, 'lgtm');
  assert.ok(!labels.includes('ci-check#1-serial'), `採用できたのに直列で起動し直している: ${JSON.stringify(labels)}`);
  assert.equal(labels.filter((l) => l.startsWith('ci-check#')).length, 1, `ci-check は 1 本だけであるべき: ${JSON.stringify(labels)}`);
  assert.equal(result?.ci_poll_attempts, 1, 'ci_poll_attempts は 1 回分');
  assert.equal(result?.ci_wait_seconds, 0);
  assert.equal(result?.ci_last_status, 'passed');
});

test('[AC-4] LGTM round: 並列で得た pending は 1 回目の poll として扱い、ci-wait-check#1.2 の待機ループへ進む（ci_poll_attempts=2）', async () => {
  const { result, labels } = await run({
    'ci-check#1': ci('pending', HEAD1),
    'ci-wait-check#1.2': { slept: true, status: 'passed', ...ciCounts('passed'), failed_checks: [] },
  });

  assert.equal(result?.status, 'lgtm');
  assert.deepEqual(labels.filter((l) => l.startsWith('ci-')), ['ci-check#1', 'ci-wait-check#1.2'], `CI 判定の spawn 列が想定と異なる: ${JSON.stringify(labels)}`);
  assert.equal(result?.ci_poll_attempts, 2, '並列分 1 + ci-wait-check 1');
  assert.equal(result?.ci_wait_seconds, 45);
});

// ---- AC-2: 不一致・null・throw・head_sha 欠落は直列で起動し直す ----
test('[AC-2] head_sha 不一致: 並列の passed（旧 head）は採らず、review の後に ci-check#1-serial を起動してその結果で判定する（捨てた並列分は poll に数えない）', async () => {
  const { result, labels, logs } = await run({
    'ci-check#1': ci('passed', STALE),
    'ci-check#1-serial': ci('pending'),
    'ci-wait-check#1.2': { slept: true, status: 'passed', ...ciCounts('passed'), failed_checks: [] },
  });

  const iReview = labels.indexOf('review#1');
  const iSerial = labels.indexOf('ci-check#1-serial');
  assert.ok(iSerial > iReview, `直列の ci-check#1-serial が review#1 の後に起動されるべき: ${JSON.stringify(labels)}`);
  assert.ok(labels.includes('ci-wait-check#1.2'), '直列の pending を 1 回目の poll として待機ループへ進むべき（旧 head の passed で lgtm にしない）');
  assert.equal(result?.status, 'lgtm');
  assert.equal(result?.ci_poll_attempts, 2, '直列 1 + ci-wait-check 1（不採用の並列分は数えない）');
  assert.ok(logs.some((l) => l.includes('head_mismatch')), `不採用理由 head_mismatch が log に出るべき: ${JSON.stringify(logs)}`);
});

test('[AC-2][AC-4] LGTM round: 並列で得た no_checks（head 一致でも新 head の check 未登録の可能性）は採らず、review の後に ci-check#1-serial を取り直してその結果で判定する', async () => {
  const { result, labels, logs } = await run({
    'ci-check#1': ci('no_checks', HEAD1),
    'ci-check#1-serial': ci('pending', HEAD1),
    'ci-wait-check#1.2': { slept: true, status: 'passed', ...ciCounts('passed'), failed_checks: [] },
  });

  const iReview = labels.indexOf('review#1');
  const iSerial = labels.indexOf('ci-check#1-serial');
  assert.ok(iSerial > iReview, `並列の no_checks を採らず ci-check#1-serial を review#1 の後に起動すべき: ${JSON.stringify(labels)}`);
  assert.ok(labels.includes('ci-wait-check#1.2'), '直列の pending で待機ループへ進むべき（並列の no_checks で lgtm にしない）');
  assert.equal(result?.status, 'lgtm');
  assert.equal(result?.ci_last_status, 'passed');
  assert.equal(result?.ci_poll_attempts, 2, '直列 1 + ci-wait-check 1（採らなかった並列分は数えない）');
  assert.ok(logs.some((l) => l.includes('no_checks')), `no_checks を採らない旨が log に出るべき: ${JSON.stringify(logs)}`);
});

test('[AC-4] LGTM round: 直列で取り直しても no_checks なら CI 未設定として lgtm（従来の no_checks=passing を維持）', async () => {
  const { result, labels } = await run({
    'ci-check#1': ci('no_checks', HEAD1),
    'ci-check#1-serial': ci('no_checks', HEAD1),
  });

  assert.ok(labels.includes('ci-check#1-serial'), `直列で取り直すべき: ${JSON.stringify(labels)}`);
  assert.equal(result?.status, 'lgtm');
  assert.equal(result?.ci_last_status, 'no_checks');
  assert.equal(result?.ci_poll_attempts, 1);
});

for (const [name, response] of [
  ['null', null],
  ['throw', () => { throw new Error('stub: StructuredOutput 未返却'); }],
  ['head_sha 欠落', ci('passed')],
]) {
  test(`[AC-2] 並列 ci-check#1 が ${name}: 直列の ci-check#1-serial を起動し、その failed で fix へ進む`, async () => {
    const { result, labels, calls } = await run({
      'ci-check#1': response,
      'ci-check#1-serial': CI_FAILED_AT(HEAD1),
      'fix#1': { applied: false, files: [], summary: 'cannot' },
    });

    assert.ok(labels.includes('ci-check#1-serial'), `直列で起動し直すべき: ${JSON.stringify(labels)}`);
    assert.equal(result?.status, 'fix_failed', '直列の failed は CI gate の fix へ流れる');
    const fix1 = calls.find((c) => c.label === 'fix#1');
    assert.ok(fix1?.prompt.includes('ci::bats'), `直列の failed が fix#1 prompt に載るべき: ${fix1?.prompt}`);
    assert.equal(result?.ci_poll_attempts, 1);
  });
}

test('[AC-2][AC-6] review 開始時の head sha が不明な round は parallel() を使わず、review の後に直列の ci-check#1 を 1 本だけ起動する', async () => {
  const { result, groups, labels } = await run({ 'ci-check#1': ci('passed') }, { headKnown: false });

  // 並列の group は review#1 と security review（対象の run）だけで、ci-check は入らない
  assert.deepEqual(groups, [['review#1', 'security-scope#1']], `照合できない round で並列 ci-check を起動している: ${JSON.stringify(groups)}`);
  assert.deepEqual(labels.filter((l) => l.startsWith('review#') || l.startsWith('ci-check#')), ['review#1', 'ci-check#1']);
  assert.equal(result?.status, 'lgtm');
  assert.equal(result?.ci_poll_attempts, 1);
});

// ---- AC-3: blocking round ----
test('[AC-3] blocking round: 並列で得た failed をそのまま 1 回判定に使い、ci::bats を review 指摘と同じ fix prompt に合流させる（直列の再起動なし）', async () => {
  const { result, calls, labels } = await run({
    'review#1': blockingReview(),
    'ci-check#1': CI_FAILED_AT(HEAD1),
    'commit-ensure#1': { dirty: false, committed: false, pushed: true, head_sha: HEAD2 },
    'ci-check#2': ci('passed', HEAD2),
  });

  const fix1 = calls.find((c) => c.label === 'fix#1');
  assert.ok(fix1, 'fix#1 が dispatch されていない');
  assert.ok(fix1.prompt.includes(REVIEW_DESC), 'fix#1 prompt に review の blocking が無い');
  assert.ok(fix1.prompt.includes('ci::bats'), `fix#1 prompt に ci::bats が無い: ${fix1.prompt}`);
  assert.ok(!labels.some((l) => l.endsWith('-serial')), `採用できた round で直列に起動し直している: ${JSON.stringify(labels)}`);
  assert.equal(labels.filter((l) => l.startsWith('ci-wait-check#1')).length, 0, 'blocking round は待機しない');
  assert.equal(result?.status, 'lgtm', 'round 2 は fix 後 head（HEAD2）の passed を採用して lgtm');
  assert.equal(result?.ci_poll_attempts, 2, 'round ごとに 1 回分');
});

test('[AC-3] blocking round: 並列で得た pending は finding を足さず、fix prompt に ci:: が載らない', async () => {
  const { result, calls } = await run({
    'review#1': blockingReview(),
    'ci-check#1': ci('pending', HEAD1),
    'fix#1': { applied: false, files: [], summary: 'cannot' },
  });

  const fix1 = calls.find((c) => c.label === 'fix#1');
  assert.ok(fix1 && !fix1.prompt.includes('ci::'), `pending では ci finding を足さないべき: ${fix1?.prompt}`);
  assert.equal(result?.ci_last_status, 'pending');
  assert.equal(result?.ci_poll_attempts, 1);
});

// ---- AC-5: 片方の失敗でもう片方の結果を失わない ----
test('[AC-5] review が schema-retry 後も null でも、並列で得た ci-check の failed は最終 CI 状態として残る（review_contract_error 終端）', async () => {
  const { result, labels } = await run({
    'review#1': null,
    'review#1-schema-retry': null,
    'ci-check#1': CI_FAILED_AT(HEAD1),
  });

  assert.equal(result?.status, 'review_contract_error');
  assert.equal(result?.ci_last_status, 'failed', '並列 ci-check の結果が失われている');
  assert.deepEqual([...(result?.ci_last_failed_checks ?? [])], ['bats']);
  assert.equal(result?.ci_poll_attempts, 1);
  assert.ok(!labels.some((l) => l.endsWith('-serial')), 'CI 判定に進まない終端で直列 ci-check を起動しない');
});

test('[AC-5] review が throw → schema-retry で回復しても並列 ci-check の結果を使う（review 側の retry が ci-check を道連れにしない）', async () => {
  const { result, labels } = await run({
    'review#1': () => { throw new Error('stub: review StructuredOutput 未返却'); },
    'review#1-schema-retry': { decision: 'approve', issues: [], summary: 'ok' },
    'ci-check#1': ci('passed', HEAD1),
  });

  assert.equal(result?.status, 'lgtm');
  assert.ok(!labels.includes('ci-check#1-serial'), `並列 ci-check を採用できるのに直列で起動し直している: ${JSON.stringify(labels)}`);
  assert.equal(result?.ci_poll_attempts, 1);
});

test('[AC-5] ci-check が throw しても review の blocking は失われず fix#1 へ渡る（ci-check は fail-open で直列再起動）', async () => {
  const { result, calls, labels } = await run({
    'review#1': blockingReview(),
    'ci-check#1': () => { throw new Error('stub: ci-check StructuredOutput 未返却'); },
    'ci-check#1-serial': null,
    'fix#1': { applied: false, files: [], summary: 'cannot' },
  });

  const fix1 = calls.find((c) => c.label === 'fix#1');
  assert.ok(fix1?.prompt.includes(REVIEW_DESC), `review の blocking が fix#1 に渡っていない: ${fix1?.prompt}`);
  assert.ok(labels.includes('ci-check#1-serial'), 'throw は直列で起動し直す');
  assert.equal(result?.status, 'fix_failed');
  assert.equal(result?.ci_last_status, 'error', '直列も null なら fail-open で error として観測');
});

// ---- AC-6: spawn 数 ----
test('[AC-6] 1 round の spawn 数は並列化しても増えない（head 既知で並列 = head 不明で直列、LGTM round / blocking round とも）', async () => {
  const roundSpawns = (labels) => labels.filter((l) => /^(review|ci-check|ci-wait-check|fix|commit-ensure)#1\b/.test(l)).length;

  const lgtmPar = await run({ 'ci-check#1': ci('passed', HEAD1) });
  const lgtmSer = await run({ 'ci-check#1': ci('passed') }, { headKnown: false });
  assert.equal(roundSpawns(lgtmPar.labels), 2, `LGTM round（並列）の spawn: ${JSON.stringify(lgtmPar.labels)}`);
  assert.equal(roundSpawns(lgtmPar.labels), roundSpawns(lgtmSer.labels), 'LGTM round の spawn 数が直列と異なる');
  assert.equal(lgtmPar.calls.length, lgtmSer.calls.length, 'run 全体の spawn 数が直列と異なる');

  const blockPar = await run({
    'review#1': blockingReview(),
    'ci-check#1': CI_FAILED_AT(HEAD1),
    'fix#1': { applied: false, files: [], summary: 'cannot' },
  });
  const blockSer = await run({
    'review#1': blockingReview(),
    'ci-check#1': CI_FAILED_AT(null),
    'fix#1': { applied: false, files: [], summary: 'cannot' },
  }, { headKnown: false });
  assert.equal(roundSpawns(blockPar.labels), 3, `blocking round（並列）の spawn: ${JSON.stringify(blockPar.labels)}`);
  assert.equal(roundSpawns(blockPar.labels), roundSpawns(blockSer.labels), 'blocking round の spawn 数が直列と異なる');
  assert.equal(blockPar.result?.subagent_invocations?.total, blockSer.result?.subagent_invocations?.total, 'subagent_invocations.total が直列と異なる');
});
