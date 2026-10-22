// _lib/review-delta.mjs（review#i（i ≥ 2）を fix delta に絞る純粋関数）の単体テスト + pr-iterate 配線 pin。
//
// 守っている不変条件:
//   - review#i（i ≥ 2）の prompt に `delta_range: <sha_prev>..<sha_now>` と delta 限定の指示が渡る
//   - sha は既存 probe（pr-meta / commit-ensure）の出力拡張で取得し、新規 agent spawn を増やさない
//   - sha_prev / sha_now が取得できない round は full にフォールバックし log に出す（fail-open。
//     delta を空扱いにして approve へ倒さない）
//   - 返り値 history[] の各 round に scope('full'|'delta') / delta_lines（full は null）が載る

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isDeltaSha, resolveReviewScope, reviewDeltaBlock, parseShortstatLines } from './review-delta.mjs';
import { makePrIterateSandbox, runWorkflowCapture, assertNoCrash } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const prIterateSrc = readFileSync(join(repoRoot, '.claude/workflows/pr-iterate.js'), 'utf8');

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);
const DELTA_INSTRUCTION = ' が fix delta。既出 findings が delta で解消されたかの確認と、delta 内の新規 critical/major のみ報告せよ。PR 全 diff の再読は不要';

// ============================================================
// 単体: isDeltaSha / resolveReviewScope
// ============================================================

test('[review-delta] isDeltaSha は 7〜40 桁 hex のみ真', () => {
  assert.equal(isDeltaSha(SHA_A), true);
  assert.equal(isDeltaSha('abc1234'), true);
  assert.equal(isDeltaSha(' ' + SHA_A + '\n'), true);
  assert.equal(isDeltaSha(''), false);
  assert.equal(isDeltaSha('fatal: not a git repository'), false);
  assert.equal(isDeltaSha(null), false);
  assert.equal(isDeltaSha(42), false);
});

test('[review-delta] iteration 1 は常に full（reason なし）', () => {
  assert.deepEqual(resolveReviewScope({ iteration: 1, shaPrev: SHA_A, shaNow: SHA_B }), { scope: 'full', range: null, reason: null });
});

test('[review-delta] iteration ≥ 2 で両 sha が揃えば delta', () => {
  assert.deepEqual(resolveReviewScope({ iteration: 2, shaPrev: SHA_A, shaNow: SHA_B }), { scope: 'delta', range: `${SHA_A}..${SHA_B}`, reason: null });
});

test('[review-delta] sha_prev 欠落は full にフォールバック（reason=sha_prev_unavailable）', () => {
  assert.deepEqual(resolveReviewScope({ iteration: 2, shaPrev: null, shaNow: SHA_B }), { scope: 'full', range: null, reason: 'sha_prev_unavailable' });
  assert.equal(resolveReviewScope({ iteration: 2, shaPrev: '', shaNow: SHA_B }).reason, 'sha_prev_unavailable');
});

test('[review-delta] sha_now 欠落は full にフォールバック（reason=sha_now_unavailable）', () => {
  assert.deepEqual(resolveReviewScope({ iteration: 3, shaPrev: SHA_A, shaNow: undefined }), { scope: 'full', range: null, reason: 'sha_now_unavailable' });
});

test('[review-delta] sha_prev === sha_now（fix が commit を積まなかった）は空 delta を approve の根拠にせず full', () => {
  assert.deepEqual(resolveReviewScope({ iteration: 2, shaPrev: SHA_A, shaNow: SHA_A.toUpperCase() }), { scope: 'full', range: null, reason: 'sha_unchanged' });
});

// ============================================================
// 単体: reviewDeltaBlock
// ============================================================

test('[review-delta] reviewDeltaBlock は delta_range 行と delta 限定指示を含み改行で終わる', () => {
  const block = reviewDeltaBlock({ shaPrev: SHA_A, shaNow: SHA_B });
  assert.ok(block.startsWith(`delta_range: ${SHA_A}..${SHA_B}\n`), block);
  assert.ok(block.includes(`\`git diff ${SHA_A}..${SHA_B}\`${DELTA_INSTRUCTION}`), block);
  assert.ok(block.endsWith('\n'));
  assert.equal(reviewDeltaBlock({ shaPrev: SHA_A, shaNow: SHA_B }), block, '決定論的であること');
});

test('[review-delta] reviewDeltaBlock は「必要なら全体も読め」の裁量を渡さない', () => {
  const block = reviewDeltaBlock({ shaPrev: SHA_A, shaNow: SHA_B });
  for (const phrase of ['必要に応じて全体', '必要なら全体', '全体を確認', '全体も読']) {
    assert.ok(!block.includes(phrase), `delta ブロックに裁量文言 "${phrase}" が含まれてはならない`);
  }
});

// ============================================================
// 単体: parseShortstatLines
// ============================================================

test('[review-delta] parseShortstatLines は insertions + deletions を返す', () => {
  assert.equal(parseShortstatLines(' 2 files changed, 7 insertions(+), 3 deletions(-)\n'), 10);
  assert.equal(parseShortstatLines('1 file changed, 1 insertion(+)'), 1);
  assert.equal(parseShortstatLines('1 file changed, 1 deletion(-)'), 1);
  assert.equal(parseShortstatLines('1 file changed'), 0, 'binary のみ等で行数が無い場合は 0');
});

test('[review-delta] parseShortstatLines: 空文字は 0、非文字列・不明文字列は null', () => {
  assert.equal(parseShortstatLines(''), 0);
  assert.equal(parseShortstatLines('   '), 0);
  assert.equal(parseShortstatLines(undefined), null);
  assert.equal(parseShortstatLines(null), null);
  assert.equal(parseShortstatLines('fatal: bad revision'), null);
});

// ============================================================
// 配線: pr-iterate.js（VM 挙動で観測）
// ============================================================

const BLOCKING_REVIEW = {
  decision: 'request-changes', summary: 'ng',
  issues: [{ severity: 'major', topic: 'logic-bug::a.js', file: 'a.js', line: 1, description: 'd', suggestion: 's' }],
};
const APPROVE_REVIEW = { decision: 'approve', issues: [], summary: 'ok' };
const PR_META_WITH_SHA = {
  url: 'https://github.com/acme/skills/pull/5', head_ref: 'feature/x', base_ref: 'main',
  cwd: '/tmp/wt', head_sha: SHA_A, epoch: 999,
};
const ENSURE_WITH_SHA = (headSha, shortstat = '2 files changed, 7 insertions(+), 3 deletions(-)') => ({
  dirty: false, committed: false, pushed: false, head_sha: headSha, delta_shortstat: shortstat,
});

async function runTwoRounds({ overrides = {}, args = '5' } = {}) {
  const { ctx, calls, logs } = makePrIterateSandbox({
    args,
    overrides: {
      'review#1': BLOCKING_REVIEW,
      'review#2': APPROVE_REVIEW,
      ...overrides,
    },
  });
  const { result, error } = await runWorkflowCapture(prIterateSrc, ctx, '.claude/workflows/pr-iterate.js');
  assertNoCrash(error, 'pr-iterate-delta');
  return { result, calls, logs };
}

test('[review-delta][AC-1] review#2 の prompt に delta_range と delta 限定指示が渡り、review#1 には渡らない', async () => {
  const { result, calls } = await runTwoRounds({
    overrides: { 'pr-meta': PR_META_WITH_SHA, 'commit-ensure#1': ENSURE_WITH_SHA(SHA_B) },
  });
  assert.equal(result?.status, 'lgtm', `2 round で lgtm になるべきだが ${result?.status}`);
  const r1 = calls.find((c) => c.label === 'review#1');
  const r2 = calls.find((c) => c.label === 'review#2');
  assert.ok(r1 && r2, 'review#1 / review#2 が dispatch されていない');
  assert.ok(!r1.prompt.includes('delta_range:'), 'review#1 は full review — delta_range を含んではならない');
  assert.ok(r1.prompt.includes('gh pr diff'), 'review#1 は PR 全 diff を読む');
  assert.ok(r2.prompt.includes(`delta_range: ${SHA_A}..${SHA_B}`), `review#2 prompt に delta_range が無い:\n${r2.prompt.slice(0, 600)}`);
  assert.ok(r2.prompt.includes(`\`git diff ${SHA_A}..${SHA_B}\`${DELTA_INSTRUCTION}`), `review#2 prompt に delta 限定指示が無い:\n${r2.prompt.slice(0, 600)}`);
  assert.ok(!r2.prompt.includes('gh pr diff で実 diff を確認'), 'delta round に PR 全 diff の再読指示が残っている');
  assert.ok(r2.prompt.includes('既出 findings'), 'delta round でも既出 findings は渡す');
});

test('[review-delta][AC-2] sha は pr-meta / commit-ensure の出力拡張で取得し、新規 agent spawn を増やさない', async () => {
  const { calls } = await runTwoRounds({
    overrides: { 'pr-meta': PR_META_WITH_SHA, 'commit-ensure#1': ENSURE_WITH_SHA(SHA_B) },
  });
  const prMeta = calls.find((c) => c.label === 'pr-meta');
  assert.ok(prMeta.prompt.includes('--json headRefOid'), 'pr-meta prompt が headRefOid を取得していない');
  assert.ok(prMeta.prompt.includes('head_sha'), 'pr-meta prompt の出力に head_sha が無い');
  assert.ok(prMeta.schema?.properties?.head_sha, 'PR_META schema に head_sha が無い');
  const ensure = calls.find((c) => c.label === 'commit-ensure#1');
  assert.ok(ensure.prompt.includes('rev-parse HEAD'), 'commit-ensure prompt が rev-parse HEAD を取得していない');
  assert.ok(ensure.prompt.includes(`diff --shortstat ${SHA_A}..HEAD`), 'commit-ensure prompt が sha_prev..HEAD の shortstat を取得していない');
  assert.ok(ensure.schema?.properties?.head_sha && ensure.schema?.properties?.delta_shortstat, 'COMMIT_ENSURE schema に head_sha / delta_shortstat が無い');
  const extra = calls.filter((c) => /sha|delta|numstat|shortstat/i.test(c.label));
  assert.deepEqual(extra.map((c) => c.label), [], `sha 取得用の新規 spawn が増えている: ${extra.map((c) => c.label).join(', ')}`);
  const labels = calls.map((c) => c.label);
  for (const expected of ['pr-meta', 'review#1', 'fix#1', 'commit-ensure#1', 'review#2']) {
    assert.ok(labels.includes(expected), `${expected} が dispatch されていない: ${labels.join(', ')}`);
  }
});

test('[review-delta][AC-3] pr-meta が head_sha を返さない round は full にフォールバックし log に出す', async () => {
  const { result, calls, logs } = await runTwoRounds({
    overrides: { 'commit-ensure#1': ENSURE_WITH_SHA(SHA_B) },  // 既定 pr-meta は head_sha 無し
  });
  assert.equal(result?.status, 'lgtm');
  const r2 = calls.find((c) => c.label === 'review#2');
  assert.ok(!r2.prompt.includes('delta_range:'), 'sha_prev 不明なのに delta review になっている');
  assert.ok(r2.prompt.includes('gh pr diff'), 'full フォールバックは PR 全 diff を読む');
  assert.ok(logs.some((l) => l.includes('review#2') && l.includes('sha_prev_unavailable') && l.includes('full review にフォールバック')), `fallback log が無い: ${logs.join(' | ')}`);
  const ensure = calls.find((c) => c.label === 'commit-ensure#1');
  assert.ok(!ensure.prompt.includes('--shortstat'), 'sha_prev 不明のとき commit-ensure に shortstat 手順を入れない');
});

test('[review-delta][AC-3] commit-ensure が head_sha を返さない round は full にフォールバックする', async () => {
  const { calls, logs } = await runTwoRounds({
    overrides: { 'pr-meta': PR_META_WITH_SHA },  // 既定 commit-ensure は head_sha 無し
  });
  const r2 = calls.find((c) => c.label === 'review#2');
  assert.ok(!r2.prompt.includes('delta_range:'));
  assert.ok(logs.some((l) => l.includes('review#2') && l.includes('sha_now_unavailable')), `fallback log が無い: ${logs.join(' | ')}`);
});

test('[review-delta][AC-3] HEAD が動いていない（sha_prev === sha_now）round は空 delta で approve へ倒さず full', async () => {
  const { calls, logs } = await runTwoRounds({
    overrides: { 'pr-meta': PR_META_WITH_SHA, 'commit-ensure#1': ENSURE_WITH_SHA(SHA_A, '') },
  });
  const r2 = calls.find((c) => c.label === 'review#2');
  assert.ok(!r2.prompt.includes('delta_range:'));
  assert.ok(logs.some((l) => l.includes('review#2') && l.includes('sha_unchanged')), `fallback log が無い: ${logs.join(' | ')}`);
});

test('[review-delta] nested 起動は args.nested.head_sha を review#1 時点の sha として使う（pr-meta 不起動）', async () => {
  const { result, calls } = await runTwoRounds({
    args: { pr: '5', nested: { caller: 'dev-flow', cwd: '/tmp/wt', head_ref: 'feature/x', head_sha: SHA_A, base_ref: 'main' } },
    overrides: { 'commit-ensure#1': ENSURE_WITH_SHA(SHA_B) },
  });
  assert.equal(result?.status, 'lgtm');
  assert.ok(!calls.some((c) => c.label === 'pr-meta'), 'nested 起動で pr-meta が起動している');
  const r2 = calls.find((c) => c.label === 'review#2');
  assert.ok(r2.prompt.includes(`delta_range: ${SHA_A}..${SHA_B}`), `nested 起動の review#2 に delta_range が無い:\n${r2.prompt.slice(0, 400)}`);
});

test('[review-delta] nested.head_sha が string 以外なら明示 throw（legacy fallback を作らない）', async () => {
  const { ctx } = makePrIterateSandbox({ args: { pr: '5', nested: { caller: 'dev-flow', cwd: '/tmp/wt', head_ref: 'feature/x', head_sha: 123 } } });
  const { error } = await runWorkflowCapture(prIterateSrc, ctx, '.claude/workflows/pr-iterate.js');
  assert.ok(error && /nested\.head_sha/.test(error.message), `head_sha 型違反で throw していない: ${error?.message}`);
});

test('[review-delta] 3 round: review#3 の delta は review#2 時点の head .. fix#2 後の head', async () => {
  const { result, calls } = await runTwoRounds({
    overrides: {
      'pr-meta': PR_META_WITH_SHA,
      // review#2 は別 topic の新規 blocking（同一 topic だと REVIEW_STUCK で stuck 終端する）
      'review#2': { ...BLOCKING_REVIEW, issues: [{ ...BLOCKING_REVIEW.issues[0], topic: 'regression::b.js', file: 'b.js' }] },
      'review#3': APPROVE_REVIEW,
      'commit-ensure#1': ENSURE_WITH_SHA(SHA_B),
      'commit-ensure#2': ENSURE_WITH_SHA(SHA_C, '1 file changed, 2 insertions(+)'),
    },
  });
  assert.equal(result?.status, 'lgtm', `3 round で lgtm になるべきだが ${result?.status}`);
  const r3 = calls.find((c) => c.label === 'review#3');
  assert.ok(r3.prompt.includes(`delta_range: ${SHA_B}..${SHA_C}`), `review#3 の delta_range が想定と違う:\n${r3.prompt.slice(0, 400)}`);
  const ensure2 = calls.find((c) => c.label === 'commit-ensure#2');
  assert.ok(ensure2.prompt.includes(`diff --shortstat ${SHA_B}..HEAD`), 'commit-ensure#2 の shortstat 起点が review#2 時点の head でない');
});

// history の round ごとの scope / delta_lines（VM の realm 差を避けるため JSON で本 realm へ写して比較）
const roundScopes = (result) => JSON.parse(JSON.stringify((result?.history ?? []).map((h) => ({ iteration: h.iteration, scope: h.scope, delta_lines: h.delta_lines }))));

test('[review-delta][AC-6] 返り値 history の各 round に scope / delta_lines が載る', async () => {
  const { result } = await runTwoRounds({
    overrides: { 'pr-meta': PR_META_WITH_SHA, 'commit-ensure#1': ENSURE_WITH_SHA(SHA_B) },
  });
  assert.deepEqual(roundScopes(result), [
    { iteration: 1, scope: 'full', delta_lines: null },
    { iteration: 2, scope: 'delta', delta_lines: 10 },
  ]);
});

test('[review-delta] delta round（review#2）の prompt は AC の新規未達探索を指示せず、full round（review#1）は指示する', async () => {
  const AC = ['AC_SENTINEL_A'];
  const { calls } = await runTwoRounds({
    args: { pr: '5', acceptance_criteria: AC },
    overrides: { 'pr-meta': PR_META_WITH_SHA, 'commit-ensure#1': ENSURE_WITH_SHA(SHA_B) },
  });
  const r1 = calls.find((c) => c.label === 'review#1');
  const r2 = calls.find((c) => c.label === 'review#2');
  assert.ok(r1 && r2, 'review#1 / review#2 が dispatch されていない');
  assert.ok(r1.prompt.includes('未達があれば issue として報告せよ'), `review#1（full）prompt に AC 新規未達探索の指示が無い:\n${r1.prompt.slice(-600)}`);
  assert.ok(!r2.prompt.includes('未達があれば issue として報告せよ'), `review#2（delta）prompt に delta 外の AC 未達探索を誘発する文言が残っている:\n${r2.prompt.slice(-600)}`);
  assert.ok(r2.prompt.includes('delta 外の AC 未達を新規 finding として報告するな'), `review#2（delta）prompt に delta 限定の AC 文言が無い:\n${r2.prompt.slice(-600)}`);
});

test('[review-delta][AC-6] full フォールバック round は scope:full / delta_lines:null で記録される', async () => {
  const { result } = await runTwoRounds({ overrides: { 'commit-ensure#1': ENSURE_WITH_SHA(SHA_B) } });
  assert.deepEqual(roundScopes(result).map((r) => [r.scope, r.delta_lines]), [['full', null], ['full', null]],
    `2 round とも scope:full / delta_lines:null であるべき: ${JSON.stringify(roundScopes(result))}`);
});
