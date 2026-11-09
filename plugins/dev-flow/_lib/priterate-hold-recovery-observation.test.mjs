// priterate-hold-recovery-observation.test.mjs — pr-iterate.js が CI・ci_verify・mergeable・security review の観測を head と組で
// 終端サマリーへ渡し、回収状況が「この run が終端 head で観測したこと」だけで決まること。VM 実行で投稿する本文を見る。
// 状態の写像そのものは pr-comment-format.test.mjs が持ち、ここでは workflow の配線（どの head と組になるか）を持つ。
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makePrIterateSandbox, runWorkflowCapture, assertNoCrash, ciCounts, securityScopeResponse } from './test-helpers/vm-sandbox.mjs';
import { mergeableObservation, mergeableAfterAttempt, mergeableCheckPrompt } from './conflict-autoresolve.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', '.claude/workflows/pr-iterate.js'), 'utf8');

const HEAD1 = '1'.repeat(40);
const HEAD2 = '2'.repeat(40);
const MERGE = '3'.repeat(40);
const NESTED = { caller: 'standalone', cwd: '/tmp/wt', head_ref: 'feature/x', base_ref: 'main', head_sha: HEAD1, repo: 'acme/skills', epoch: 4242 };
// round 1 の前の判定（security-scope#0）が対象外（run の既定）。target:true の run は sandbox の既定の応答（対象）を使う
const NOT_TARGET = { 'security-scope#0': securityScopeResponse({ target: false, head: HEAD1 }) };

const ci = (status, head_sha = HEAD1) => ({ status, ...ciCounts(status), failed_checks: status === 'failed' ? [{ name: 'bats', bucket: 'fail', state: 'FAILURE' }] : [], head_sha });
const mergeable = (state, headRefOid = HEAD1) => ({ mergeable: state, mergeStateStatus: state === 'CONFLICTING' ? 'DIRTY' : 'CLEAN', headRefOid });
const BLOCKING = { decision: 'request-changes', issues: [{ severity: 'major', topic: 't1', file: 'src/a.js', line: 1, description: 'x', suggestion: 'y' }], summary: 'ng' };
const ENSURED_HEAD2 = { dirty: false, committed: true, pushed: true, head_sha: HEAD2 };

async function run(codes, overrides, args = {}, { target = false } = {}) {
  const { ctx, calls } = makePrIterateSandbox({
    overrides: target ? overrides : { ...NOT_TARGET, ...overrides },
    args: { pr: 5, nested: NESTED, prior_devflow: { tier: 'HOLD', codes, url: 'https://github.com/acme/skills/pull/5#issuecomment-1', head_sha: null }, ...args },
  });
  const { result, error } = await runWorkflowCapture(src, ctx, '.claude/workflows/pr-iterate.js');
  assertNoCrash(error, 'priterate-hold-recovery-observation');
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  const post = calls.find((c) => c.label === 'post-summary')?.prompt ?? '';
  return { result, post, rows: post.split('\n').filter((l) => l.startsWith('- `')) };
}

test('[hold-recovery] 同じ head で CI passed・conflict なし・対象外を観測した LGTM はすべて解消', async () => {
  const { result, post, rows } = await run(['iterate_non_lgtm', 'ci_checks_failed', 'mergeable_conflicting', 'security_review_unresolved'], {
    'ci-check#1': ci('passed'), 'mergeable-check#1': mergeable('MERGEABLE'), 'security-scope#1': securityScopeResponse({ target: false, head: HEAD1 }),
  });
  assert.equal(result.status, 'lgtm');
  assert.deepEqual(rows, [
    '- `iterate_non_lgtm` — ✅ 解消 — この run の終了状態: lgtm',
    '- `ci_checks_failed` — ✅ 解消 — 最終 CI 状態: passed',
    '- `mergeable_conflicting` — ✅ 解消 — conflict なしを観測',
    '- `security_review_unresolved` — ✅ 解消 — この run の security review: not_target',
  ]);
  assert.ok(post.includes('### 🎉 LGTM — dev-flow の HOLD 理由はすべて解消'), post);
});

test('[hold-recovery] 対象の run の security review は clear を観測した head と組になり、終端 head と同じなら解消', async () => {
  const { rows } = await run(['security_review_unresolved'], { 'ci-check#1': ci('passed'), 'mergeable-check#1': mergeable('MERGEABLE') }, {}, { target: true });
  assert.deepEqual(rows, ['- `security_review_unresolved` — ✅ 解消 — この run の security review: cleared']);
});

test('[hold-recovery] reviewed_sha が別の head の security review は critical があっても未解消と書かず、未確認にする', async () => {
  const { result, rows } = await run(['security_review_unresolved'], {
    'ci-check#1': ci('passed'), 'mergeable-check#1': mergeable('MERGEABLE'),
    'security-review#1': { reviewed_sha: HEAD2, issues: [{ severity: 'critical', topic: 's1', file: 'src/a.js', line: 1, description: 'x', suggestion: 'y' }], summary: 'ng' },
  }, {}, { target: true });
  assert.equal(result.status, 'security_unresolved');
  assert.deepEqual(rows, ['- `security_review_unresolved` — ❔ 未確認 — この run の security review: unresolved — 観測した head が終端 head と同じか確かめられない']);
});

test('[hold-recovery] fix の後の LGTM の round で security-scope が対象外なら、その head の判定として解消にする', async () => {
  const { result, rows } = await run(['security_review_unresolved'], {
    'review#1': BLOCKING, 'ci-check#1': ci('failed'), 'commit-ensure#1': ENSURED_HEAD2,
    'ci-check#2': ci('passed', HEAD2), 'mergeable-check#2': mergeable('MERGEABLE', HEAD2), 'security-scope#2': securityScopeResponse({ target: false, head: HEAD2 }),
  });
  assert.equal(result.status, 'lgtm');
  assert.deepEqual(rows, ['- `security_review_unresolved` — ✅ 解消 — この run の security review: not_target']);
});

test('[hold-recovery] fix の後に上限で終えた run は、fix 前の head の CI・対象外の判定を未確認にし、最終 CI 状態の行に古い head と出す', async () => {
  const { result, post, rows } = await run(['ci_checks_failed', 'security_review_unresolved'], {
    'review#1': BLOCKING, 'ci-check#1': ci('failed'), 'commit-ensure#1': ENSURED_HEAD2,
  }, { max_iterations: 1 });
  assert.equal(result.status, 'max_reached');
  assert.deepEqual(rows, [
    '- `ci_checks_failed` — ❔ 未確認 — 最終 CI 状態: failed — head `1111111` の観測で、終端 head `2222222` では確かめていない',
    '- `security_review_unresolved` — ❔ 未確認 — この run の security review: not_target — head `1111111` の観測で、終端 head `2222222` では確かめていない',
  ]);
  assert.ok(post.includes('**最終 CI 状態**: 🔴 failed — `bats` — ⚠️ 古い head `1111111` の観測（終端 head `2222222` の CI は確かめていない'), post);
  assert.ok(post.includes('**dev-flow の HOLD 理由 2 件が未確認**'), post);
  assert.ok(!post.includes('未解消'), post);
});

test('[hold-recovery] fix の後に再び CI を観測した run は新しい head の観測で判定する', async () => {
  const { rows, post } = await run(['ci_checks_failed'], {
    'review#1': BLOCKING, 'ci-check#1': ci('failed'), 'commit-ensure#1': ENSURED_HEAD2,
    'ci-check#2': ci('passed', HEAD2), 'mergeable-check#2': mergeable('MERGEABLE', HEAD2),
  });
  assert.deepEqual(rows, ['- `ci_checks_failed` — ✅ 解消 — 最終 CI 状態: passed']);
  assert.ok(!post.includes('古い head'), post);
});

test('[hold-recovery] 応答に head が無い ci-wait-check はこの run が知る今の head と組にする', async () => {
  const { rows } = await run(['ci_checks_failed'], {
    'ci-check#1': ci('pending'),
    'ci-wait-check#1.2': { slept: true, ...ciCounts('passed'), status: 'passed', failed_checks: [] },
    'mergeable-check#1': mergeable('MERGEABLE'),
  });
  assert.deepEqual(rows, ['- `ci_checks_failed` — ✅ 解消 — 最終 CI 状態: passed']);
});

test('[hold-recovery] fix が適用されずに終えた run（fix_failed）は head を確かめていないので、fix 前の観測を未確認にする', async () => {
  const { result, rows, post } = await run(['ci_checks_failed'], {
    'review#1': BLOCKING, 'ci-check#1': ci('passed'), 'fix#1': { applied: false, files: [], summary: 'x', deferred_security_ids: [] },
  });
  assert.equal(result.status, 'fix_failed');
  assert.deepEqual(rows, ['- `ci_checks_failed` — ❔ 未確認 — 最終 CI 状態: passed — 観測した head が終端 head と同じか確かめられない']);
  // marker の head は従来どおり
  assert.ok(post.includes(`<!-- pr-iterate:fix_failed:1 head=${HEAD1} -->`), post);
});

test('[hold-recovery] ci_pending で終えた run は conflict の確認に到達しておらず、未解消と書かずに再実行を案内する', async () => {
  const { result, rows, post } = await run(['iterate_non_lgtm', 'ci_checks_failed', 'mergeable_conflicting'], {
    'ci-check#1': ci('pending'),
    'ci-wait-check#1.2': { slept: false, status: 'pending', passed: 0, failed: 0, pending: 0, skipped: 0 },
  });
  assert.equal(result.status, 'ci_pending');
  assert.deepEqual(rows, [
    '- `iterate_non_lgtm` — ❔ 未確認 — この run の終了状態: ci_pending — CI の確定前に終わり、LGTM に届くか確かめられなかった',
    '- `ci_checks_failed` — ❔ 未確認 — 最終 CI 状態: pending — check が完了していない',
    '- `mergeable_conflicting` — ❔ 未確認 — conflict の確認に到達していない（conflict の自動解消: 試行なし）',
  ]);
  assert.ok(post.includes('CI の確定後に `/pr-iterate 5` を再実行すると判定が確定する'), post);
  assert.ok(!post.includes('未解消'), post);
});

test('[hold-recovery] ac_ci_pending は ci_verify の観測で決まり、渡さない run は未実行で未確認', async () => {
  const CI_VERIFY = { label: 'full-ci', checks: ['e2e'], wait_ceiling_seconds: 1500 };
  const passed = { ...ciCounts('passed'), status: 'passed', failed_checks: [], passed_checks: [] };
  const failed = await run(['ac_ci_pending'], {
    'ci-check#1': ci('passed'), 'ci-verify#1.1': { ...ciCounts('failed'), status: 'failed', failed_checks: [{ name: 'e2e', bucket: 'fail', state: 'FAILURE' }], passed_checks: [] },
    'fix#1': { applied: true, files: [], summary: 'x', deferred_security_ids: [] }, 'commit-ensure#1': ENSURED_HEAD2,
  }, { ci_verify: CI_VERIFY, max_iterations: 1 });
  assert.deepEqual(failed.rows, ['- `ac_ci_pending` — ❔ 未確認 — ci_verify: failed — head `1111111` の観測で、終端 head `2222222` では確かめていない']);

  const ok = await run(['ac_ci_pending'], { 'ci-check#1': ci('passed'), 'ci-verify#1.1': passed, 'mergeable-check#1': mergeable('MERGEABLE') }, { ci_verify: CI_VERIFY });
  assert.deepEqual(ok.rows, ['- `ac_ci_pending` — ✅ 解消 — ci_verify: passed']);

  const none = await run(['ac_ci_pending'], { 'ci-check#1': ci('passed'), 'mergeable-check#1': mergeable('MERGEABLE') });
  assert.deepEqual(none.rows, ['- `ac_ci_pending` — ❔ 未確認 — ci_verify: 未実行 — この run は ci_verify の check の完了を確かめていない']);
});

test('[hold-recovery] mergeable_conflicting は mergeable-check の観測と自動解消の結果で決まる', async () => {
  const ABORTED = { fetched: true, pushed: false, result: { status: 'aborted', reason: 'unsupported_conflict', files: [] } };
  const conflict = await run(['mergeable_conflicting'], { 'ci-check#1': ci('passed'), 'mergeable-check#1': mergeable('CONFLICTING'), 'conflict-resolve#1': ABORTED });
  assert.deepEqual(conflict.rows, ['- `mergeable_conflicting` — ❌ 未解消 — conflict が残ると観測（conflict の自動解消: aborted）']);

  const unknown = await run(['mergeable_conflicting'], { 'ci-check#1': ci('passed'), 'mergeable-check#1': mergeable('UNKNOWN') });
  assert.deepEqual(unknown.rows, ['- `mergeable_conflicting` — ❔ 未確認 — mergeable が UNKNOWN か取得失敗で、conflict の有無を確かめられない']);

  const failed = await run(['mergeable_conflicting'], { 'ci-check#1': ci('passed'), 'mergeable-check#1': null });
  assert.equal(failed.rows.length, 1);
  assert.ok(failed.rows[0].includes('❔ 未確認'), failed.rows[0]);

  // 自動解消の merge commit の head でも、push 直後の UNKNOWN で解消の観測を消さない
  const resolved = await run(['mergeable_conflicting'], {
    'ci-check#1': ci('passed'), 'mergeable-check#1': mergeable('CONFLICTING'),
    'conflict-resolve#1': { fetched: true, pushed: true, result: { status: 'resolved', reason: '', head_after: MERGE, files: [] } },
    'ci-check#2': ci('passed', MERGE), 'mergeable-check#2': mergeable('UNKNOWN', MERGE),
  });
  assert.deepEqual(resolved.rows, ['- `mergeable_conflicting` — ✅ 解消 — conflict の自動解消: resolved']);

  // 自動解消の push に失敗した run は head を確かめていない
  const pushFailed = await run(['mergeable_conflicting'], {
    'ci-check#1': ci('passed'), 'mergeable-check#1': mergeable('CONFLICTING'),
    'conflict-resolve#1': { fetched: true, pushed: false, result: { status: 'resolved', reason: '', head_after: MERGE, files: [] } },
  });
  assert.deepEqual(pushFailed.rows, ['- `mergeable_conflicting` — ❔ 未確認 — conflict の確認: conflicting — 観測した head が終端 head と同じか確かめられない']);
});

test('[hold-recovery] mergeable-check#i の prompt は同じ gh pr view で head も読む', () => {
  const prompt = mergeableCheckPrompt({ pr: 5, repo: 'acme/skills' });
  assert.ok(prompt.includes('`gh pr view 5 --repo acme/skills --json mergeable,mergeStateStatus,headRefOid`'), prompt);
  assert.ok(prompt.includes('"headRefOid": string'), prompt);
});

test('[hold-recovery] mergeableObservation / mergeableAfterAttempt の写像', () => {
  assert.deepEqual(mergeableObservation(mergeable('MERGEABLE')), { state: 'clean', head: HEAD1 });
  assert.deepEqual(mergeableObservation(mergeable('CONFLICTING')), { state: 'conflicting', head: HEAD1 });
  assert.deepEqual(mergeableObservation({ mergeable: 'UNKNOWN', mergeStateStatus: 'DIRTY', headRefOid: HEAD1 }), { state: 'conflicting', head: HEAD1 });
  assert.deepEqual(mergeableObservation(mergeable('UNKNOWN')), { state: 'unknown', head: HEAD1 });
  assert.deepEqual(mergeableObservation(null), { state: 'unknown', head: null });
  assert.deepEqual(mergeableObservation({ mergeable: '', mergeStateStatus: '', headRefOid: '' }), { state: 'unknown', head: null });
  assert.deepEqual(mergeableObservation({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }), { state: 'clean', head: null });

  const prev = { state: 'resolved', head: MERGE };
  assert.deepEqual(mergeableObservation(mergeable('UNKNOWN', MERGE), prev), prev);
  assert.deepEqual(mergeableObservation(null, prev), prev);
  // 別の head の UNKNOWN・同じ head の conflict は解消の観測を引き継がない
  assert.deepEqual(mergeableObservation(mergeable('UNKNOWN', HEAD2), prev), { state: 'unknown', head: HEAD2 });
  assert.deepEqual(mergeableObservation(mergeable('CONFLICTING', MERGE), prev), { state: 'conflicting', head: MERGE });

  const seen = { state: 'conflicting', head: HEAD1 };
  assert.deepEqual(mergeableAfterAttempt(seen, { status: 'resolved', merge_sha: MERGE }), { state: 'resolved', head: MERGE });
  assert.deepEqual(mergeableAfterAttempt(seen, { status: 'no_conflict', merge_sha: null }), { state: 'clean', head: HEAD1 });
  for (const status of ['aborted', 'error', 'push_failed']) assert.deepEqual(mergeableAfterAttempt(seen, { status, merge_sha: null }), seen, status);
});
