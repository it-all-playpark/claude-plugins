// issue #703: review が blocking を返す round でも CI を 1 回確認して fix に合流させ、
// 全終端で「最後に観測した CI 状態」を返り値と終端サマリに載せることを VM 挙動で pin する。
//
// base（blocking round が CI を見ない実装）では:
//   (a)(d) blocking round で ci-check#1 が dispatch されず fix#1 prompt に ci::<name> も CI 手順も無い → red
//   (b)    ci-wait は元々呼ばれないが ci_last_status が undefined → red
//   (c)    stuck 終端の返り値に ci_last_status が無く、post-summary に「最終 CI 状態」行が無い → red
//   (e)    ci::<name> が reviewSeen に乗らず、review topic が毎 round 変わる限り stuck にならない → red
//
// AC-1: blocking round で fix 前に ci-check を 1 回（ci-wait なし）。failed → ci::<name> critical を review の
//       blocking と同じ fix prompt に合流。pending / no_checks / passed / error は finding を足さない。
//       ci::<name> は reviewSeen に register され REVIEW_STUCK に乗る
// AC-2: 返り値 ci_last_status / ci_last_failed_checks、終端サマリの「最終 CI 状態」行（全終端）
// AC-3: CI failure を含む fix prompt（ciFixPrompt / 合流 prompt）に失敗ログ取得と base merge 再現の指示
// AC-4: 本ファイル（makeRecordingSandbox 形式）

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makePrIterateSandbox, runWorkflowCapture, assertNoCrash } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const prIteratePath = join(here, '..', '.claude', 'workflows', 'pr-iterate.js');
const src = readFileSync(prIteratePath, 'utf8');

const REVIEW_DESC = 'null を返す経路で例外を握りつぶしている';
const blockingReview = (topic = 't1') => ({
  decision: 'request-changes',
  issues: [{ severity: 'major', topic, file: 'src/a.js', line: 12, description: REVIEW_DESC, suggestion: 'throw に戻す' }],
  summary: 'ng',
});
const CI_FAILED = { status: 'failed', passed: 0, failed: 1, pending: 0, skipped: 0, failed_checks: [{ name: 'bats', bucket: 'fail', state: 'FAILURE' }] };

async function run(overrides) {
  const { ctx, calls } = makePrIterateSandbox({ overrides });
  const { result, error } = await runWorkflowCapture(src, ctx, '.claude/workflows/pr-iterate.js');
  assertNoCrash(error, 'priterate-blocking-ci-routing');
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  return { result, calls };
}

// AC-3 の文言 pin（ciFixPrompt / 合流 prompt の両方に同じ helper で入る）
function assertCiFixGuidance(prompt, label) {
  assert.ok(prompt.includes('`gh pr checks 5`'), `${label} prompt に \`gh pr checks 5\` の指示が無い。prompt: ${prompt}`);
  assert.ok(prompt.includes('--log-failed'), `${label} prompt に \`gh run view <run-id> --log-failed\` の指示が無い。prompt: ${prompt}`);
  assert.ok(prompt.includes('失敗ログを取得'), `${label} prompt に失敗ログ取得の指示が無い。prompt: ${prompt}`);
  assert.ok(prompt.includes('マージ結果を検証'), `${label} prompt に「CI は base とのマージ結果を検証している」前提が無い。prompt: ${prompt}`);
  assert.ok(prompt.includes('`git merge origin/main`'), `${label} prompt に origin/<base> の merge 指示が無い（pr-meta の base_ref=main）。prompt: ${prompt}`);
  assert.ok(prompt.includes('再現を確認'), `${label} prompt に base merge 後の再現確認の指示が無い。prompt: ${prompt}`);
}

// ---- (a) review blocking + ci-check failed → fix prompt に review blocking と ci::<name> の両方 ----
test('[AC-1a] review blocking + ci-check#1 failed → fix#1 prompt に review 指摘と ci::bats の両方が載り、ci-check は fix より前に 1 回だけ呼ばれる', async () => {
  const { result, calls } = await run({
    'review#1': blockingReview(),
    'ci-check#1': CI_FAILED,
    'review#2': { decision: 'approve', issues: [], summary: 'ok' },
    'ci-check#2': { status: 'passed', passed: 1, failed: 0, pending: 0, skipped: 0, failed_checks: [] },
  });

  const fix1 = calls.find((c) => c.label === 'fix#1');
  assert.ok(fix1, 'fix#1 が dispatch されていない');
  assert.ok(fix1.prompt.includes(REVIEW_DESC), `fix#1 prompt に review の blocking が無い。prompt: ${fix1.prompt}`);
  assert.ok(fix1.prompt.includes('ci::bats'), `fix#1 prompt に ci::bats が無い。prompt: ${fix1.prompt}`);
  assert.ok(fix1.prompt.includes('[critical]'), `ci finding は critical として載るべき。prompt: ${fix1.prompt}`);
  assert.ok(fix1.prompt.includes('CI check failed: bats'), `fix#1 prompt に CI 失敗の説明が無い。prompt: ${fix1.prompt}`);

  const labels = calls.map((c) => c.label);
  const ciIdx = labels.indexOf('ci-check#1');
  const fixIdx = labels.indexOf('fix#1');
  assert.ok(ciIdx >= 0, 'blocking round で ci-check#1 が dispatch されるべき');
  assert.ok(ciIdx < fixIdx, `ci-check#1（${ciIdx}）は fix#1（${fixIdx}）より前に呼ばれるべき`);
  const ci1 = calls[ciIdx];
  assert.equal(ci1.agentType, 'dev-flow:stdout-relay', `ci-check#1 の agentType が想定と異なる: ${ci1.agentType}`);
  assert.ok(ci1.prompt.includes('check-ci --pr '), 'ci-check#1 は既存の ci-check exec-proxy prompt であるべき');
  const round1Ci = calls.filter((c) => c.label.startsWith('ci-check#1'));
  assert.equal(round1Ci.length, 1, `blocking round の ci-check は 1 回だけであるべきだが ${round1Ci.length} 回だった`);

  assert.equal(result?.status, 'lgtm', `fix 後 approve + passed で lgtm へ進むべきだが '${result?.status}' だった`);
  assert.equal(result?.ci_last_status, 'passed', `最後の観測は ci_gate の passed であるべきだが '${result?.ci_last_status}' だった`);
  assert.deepEqual([...(result?.ci_last_failed_checks ?? [null])], [], 'passed のとき failed_checks は空');
});

// ---- (b) review blocking + ci-check pending → ci-wait を呼ばず、fix prompt に ci finding が無い ----
test('[AC-1b] review blocking + ci-check#1 pending → ci-wait は 0 回、fix#1 prompt に ci finding が無く、ci_last_status は pending を観測する', async () => {
  const { result, calls } = await run({
    'review#1': blockingReview(),
    'ci-check#1': { status: 'pending', passed: 0, failed: 0, pending: 1, skipped: 0, failed_checks: [] },
    'fix#1': { applied: false, files: [], summary: 'cannot' },
  });

  const ciWaitCalls = calls.filter((c) => c.label.startsWith('ci-wait-check#'));
  assert.equal(ciWaitCalls.length, 0, `blocking round では ci-wait を挟まないべきだが ${ciWaitCalls.length} 回呼ばれた`);
  const ciCheckCalls = calls.filter((c) => c.label.startsWith('ci-check#'));
  assert.equal(ciCheckCalls.length, 1, `pending でも再取得せず 1 回だけであるべきだが ${ciCheckCalls.length} 回だった`);

  const fix1 = calls.find((c) => c.label === 'fix#1');
  assert.ok(fix1, 'fix#1 が dispatch されていない（pending は fix を止めない）');
  assert.ok(!fix1.prompt.includes('ci::'), `pending では fix prompt に ci finding を足さないべき。prompt: ${fix1.prompt}`);
  assert.ok(!fix1.prompt.includes('--log-failed'), `pending では CI 修正手順を足さないべき。prompt: ${fix1.prompt}`);

  assert.equal(result?.status, 'fix_failed');
  assert.equal(result?.ci_last_status, 'pending', `観測した pending が返り値に載るべきだが '${result?.ci_last_status}' だった`);
  assert.equal(result?.ci_wait_seconds, 0, 'blocking round は待機しない');
});

test('[AC-1b] review blocking + ci-check#1 が null（fail-open）→ finding を足さず fix へ進み、ci_last_status は error', async () => {
  const { result, calls } = await run({
    'review#1': blockingReview(),
    'ci-check#1': null,
    'fix#1': { applied: false, files: [], summary: 'cannot' },
  });
  const fix1 = calls.find((c) => c.label === 'fix#1');
  assert.ok(fix1, 'ci-check が null でも fix#1 は dispatch されるべき（fail-open）');
  assert.ok(!fix1.prompt.includes('ci::'), `error では fix prompt に ci finding を足さないべき。prompt: ${fix1.prompt}`);
  assert.equal(result?.status, 'fix_failed');
  assert.equal(result?.ci_last_status, 'error', `null 応答は error として観測されるべきだが '${result?.ci_last_status}' だった`);
});

// ---- (c) review blocking が続いて stuck 終端 → 返り値 ci_last_status:'failed' と終端サマリの最終 CI 状態行 ----
test('[AC-2c] review blocking 同一 topic が続き stuck 終端 → ci_last_status:\'failed\' / ci_last_failed_checks:[\'bats\'] と post-summary の「最終 CI 状態」行に bats', async () => {
  const { result, calls } = await run({
    'review#1': blockingReview('t1'),
    'ci-check#1': CI_FAILED,
    'review#2': blockingReview('t1'),
    'ci-check#2': CI_FAILED,
  });

  assert.equal(result?.status, 'stuck', `同一 topic 2 回で stuck 終端すべきだが '${result?.status}' だった`);
  assert.equal(result?.ci_last_status, 'failed', `stuck 終端でも最後に観測した failed が返るべきだが '${result?.ci_last_status}' だった`);
  assert.deepEqual([...(result?.ci_last_failed_checks ?? [null])], ['bats'], `failed の check 名が返るべきだが ${JSON.stringify(result?.ci_last_failed_checks)} だった`);

  const post = calls.find((c) => c.label === 'post-summary');
  assert.ok(post, 'post-summary が dispatch されていない');
  assert.ok(post.prompt.includes('**最終 CI 状態**'), `終端サマリに「最終 CI 状態」行が無い。prompt: ${post.prompt.slice(0, 1500)}`);
  assert.ok(/\*\*最終 CI 状態\*\*: .*failed.*`bats`/.test(post.prompt), `終端サマリの最終 CI 状態行に failed と check 名 bats が列挙されるべき。prompt: ${post.prompt.slice(0, 1500)}`);
});

// ---- (e) ci::<name> が reviewSeen に乗る: review topic が毎 round 変わっても CI が同じ check で失敗し続ければ stuck ----
test('[AC-1e] review topic が毎 round 変わっても ci::bats が 2 round 続けば REVIEW_STUCK で stuck 終端する', async () => {
  const { result, calls } = await run({
    'review#1': blockingReview('t1'),
    'ci-check#1': CI_FAILED,
    'review#2': blockingReview('t2'),
    'ci-check#2': CI_FAILED,
    'review#3': blockingReview('t3'),
  });

  assert.equal(result?.status, 'stuck', `ci::bats の反復で stuck 終端すべきだが '${result?.status}' だった`);
  assert.equal(result?.iterations, 2, `2 round 目で stuck すべきだが ${result?.iterations} round だった`);
  const fixCalls = calls.filter((c) => c.label.startsWith('fix#'));
  assert.equal(fixCalls.length, 1, `stuck round では fix を呼ばないべき（fix#1 のみ）だが ${fixCalls.length} 回だった`);
  assert.equal(result?.ci_last_status, 'failed');
});

// ---- (d) AC-3 の文言: 合流 prompt と既存 ciFixPrompt（ci_gate 経路）の両方 ----
test('[AC-3d] 合流 prompt（review blocking + CI failed）に失敗ログ取得と origin/<base> merge 再現の指示が含まれる', async () => {
  const { calls } = await run({
    'review#1': blockingReview(),
    'ci-check#1': CI_FAILED,
    'fix#1': { applied: false, files: [], summary: 'cannot' },
  });
  const fix1 = calls.find((c) => c.label === 'fix#1');
  assert.ok(fix1, 'fix#1 が dispatch されていない');
  assertCiFixGuidance(fix1.prompt, 'fix#1（合流）');
});

test('[AC-3d] 既存 ciFixPrompt（approve + ci_gate failed）にも同じ失敗ログ取得と origin/<base> merge 再現の指示が含まれる', async () => {
  const { result, calls } = await run({
    'ci-check#1': CI_FAILED,
    'ci-check#2': { status: 'passed', passed: 1, failed: 0, pending: 0, skipped: 0, failed_checks: [] },
  });
  const fix1 = calls.find((c) => c.label === 'fix#1');
  assert.ok(fix1, 'ci_gate failed で fix#1 が dispatch されるべき');
  assert.ok(fix1.prompt.includes('ci::bats'), `ciFixPrompt にも ci::bats が載るべき。prompt: ${fix1.prompt}`);
  assertCiFixGuidance(fix1.prompt, 'fix#1（ciFixPrompt）');
  assert.equal(result?.status, 'lgtm');
});

test('[AC-3d] base_ref を取得できない（pr-meta の base_ref 空）ときは base 名を gh pr view で確認する指示に落ちる', async () => {
  const { calls } = await run({
    'pr-meta': { url: 'https://github.com/acme/skills/pull/5', head_ref: 'feature/x', base_ref: '', cwd: '/tmp/wt', epoch: 999 },
    'review#1': blockingReview(),
    'ci-check#1': CI_FAILED,
    'fix#1': { applied: false, files: [], summary: 'cannot' },
  });
  const fix1 = calls.find((c) => c.label === 'fix#1');
  assert.ok(fix1, 'fix#1 が dispatch されていない');
  assert.ok(fix1.prompt.includes('--log-failed'), 'base 不明でも失敗ログ取得の指示は入る');
  assert.ok(fix1.prompt.includes('`git merge origin/<base branch>`'), `base 不明時は origin/<base branch> のプレースホルダで merge を指示すべき。prompt: ${fix1.prompt}`);
  assert.ok(fix1.prompt.includes('--json baseRefName'), `base 不明時は gh pr view --json baseRefName で確認する指示が要る。prompt: ${fix1.prompt}`);
});

// ---- AC-2: 全終端で「最終 CI 状態」行（lgtm / 未観測の review_contract_error を代表で pin。7 終端の網羅は pr-comment-format.test.mjs）----
test('[AC-2] lgtm 終端でも返り値 ci_last_status:\'passed\' と終端サマリの「最終 CI 状態」行が出る', async () => {
  const { result, calls } = await run({});
  assert.equal(result?.status, 'lgtm');
  assert.equal(result?.ci_last_status, 'passed');
  assert.deepEqual([...(result?.ci_last_failed_checks ?? [null])], []);
  const post = calls.find((c) => c.label === 'post-summary');
  assert.ok(post, 'post-summary が dispatch されていない');
  assert.ok(/\*\*最終 CI 状態\*\*: .*passed/.test(post.prompt), `lgtm の終端サマリに最終 CI 状態 passed が無い。prompt: ${post.prompt.slice(0, 1500)}`);
});

test('[AC-2] CI を一度も判定しない終端（review_contract_error）では ci_last_status:null と「未観測」の行が出る', async () => {
  const { result, calls } = await run({
    'review#1': null,
    'review#1-schema-retry': null,
  });
  assert.equal(result?.status, 'review_contract_error');
  assert.equal(result?.ci_last_status, null, `未観測は null であるべきだが '${result?.ci_last_status}' だった`);
  assert.deepEqual([...(result?.ci_last_failed_checks ?? [null])], []);
  const post = calls.find((c) => c.label === 'post-summary');
  assert.ok(post, 'post-summary が dispatch されていない');
  assert.ok(/\*\*最終 CI 状態\*\*: 未観測/.test(post.prompt), `未観測の終端サマリに「最終 CI 状態: 未観測」が無い。prompt: ${post.prompt.slice(0, 1500)}`);
});
