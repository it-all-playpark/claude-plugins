// 単体 pr-iterate の「再 review 中」コメント（issue #1065）を VM 実行で pin する。
//
// PR の最後の終端サマリー（dev-flow / pr-iterate）が今の head と別の head に対する結論のとき（pr-iterate-prerun の
// prior_summary.head_mismatch:true）、単体起動は review を始める前に「head <sha> で再 review 中。<URL> の結論はこの head に
// 当てはまらない」コメントを PR に足す。食い違いが無い・終端サマリーが無い PR では投稿しない。投稿失敗は review を止めない。
// 本文の組み立ては pr-comment-format.test.mjs（buildRereviewNoticeBody）、prior_summary の判定は pr-iterate-prerun.bats が見る。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makePrIterateSandbox, runWorkflowCapture } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', '.claude/workflows/pr-iterate.js'), 'utf8');

const HEAD = 'b'.repeat(40);
const OLD_HEAD = 'c'.repeat(40);
const PRIOR_URL = 'https://github.com/acme/skills/pull/5#issuecomment-2';
const PRERUN = { cwd: '/repo-wt/pr-5', head_ref: 'feature/x', head_sha: HEAD, base_ref: 'main', repo: 'acme/skills', epoch: 4242 };

async function run({ priorSummary, caller = 'standalone', overrides = {} }) {
  const args = { pr: 5, nested: { caller, ...PRERUN }, ...(priorSummary !== undefined ? { prior_summary: priorSummary } : {}) };
  const { ctx, calls } = makePrIterateSandbox({ args, overrides });
  const { result, error } = await runWorkflowCapture(src, ctx, '.claude/workflows/pr-iterate.js');
  return { result, error, calls };
}

const notices = (calls) => calls.filter((c) => c.label === 'post-rereview-notice');

test('[issue #1065] 最後の終端サマリーの head が食い違えば、最初の review の前に再 review 中コメントを gh pr comment --body-file で投稿する', async () => {
  const { result, error, calls } = await run({ priorSummary: { source: 'pr-iterate', url: PRIOR_URL, head_sha: OLD_HEAD, head_mismatch: true } });
  assert.equal(error, null, `error: ${error?.message}`);
  assert.equal(result?.status, 'lgtm');
  const posted = notices(calls);
  assert.equal(posted.length, 1, '再 review 中コメントを 1 回だけ投稿する');
  const noticeIdx = calls.indexOf(posted[0]);
  const reviewerIdx = calls.findIndex((c) => c.agentType === 'dev-flow:pr-reviewer');
  assert.ok(reviewerIdx > noticeIdx, `review を始める前に投稿する（notice=${noticeIdx}, review=${reviewerIdx}）`);
  const p = posted[0].prompt;
  assert.ok(p.includes(`head \`${HEAD}\` で再 review 中。${PRIOR_URL} の結論`), `今の head と古いサマリーの URL が無い: ${p.slice(0, 1500)}`);
  assert.ok(p.includes('この head に当てはまらない'), p.slice(0, 1500));
  assert.ok(p.includes('gh pr comment 5 --repo acme/skills --body-file /repo-wt/pr-5/.devflow-tmp/pr-iterate-rereview-5.md'), `起動形が gh の bare 単文 + --body-file でない: ${p.slice(0, 1500)}`);
  assert.ok(!/gh pr comment[^\n]*--edit-last|gh api/.test(p), '古いサマリーを編集しない（新しいコメントを足すだけ）');

  // 終端サマリーの marker には、この run が結論を出した head が載る
  const summary = calls.find((c) => c.label === 'post-summary');
  assert.ok(summary?.prompt.includes(`<!-- pr-iterate:lgtm:1 head=${HEAD} -->`), `終端サマリーの marker に head が無い: ${summary?.prompt.slice(-600)}`);
});

test('[issue #1065] head の無い marker（head_sha:null・head_mismatch:true）の dev-flow サマリーでも投稿する', async () => {
  const { error, calls } = await run({ priorSummary: { source: 'dev-flow', url: PRIOR_URL, head_sha: null, head_mismatch: true } });
  assert.equal(error, null, `error: ${error?.message}`);
  assert.equal(notices(calls).length, 1);
});

test('[issue #1065] 食い違いが無い・終端サマリーが無い PR では再 review 中コメントを投稿しない', async () => {
  for (const priorSummary of [{ source: 'pr-iterate', url: PRIOR_URL, head_sha: HEAD, head_mismatch: false }, null, undefined]) {
    const { result, error, calls } = await run({ priorSummary });
    assert.equal(error, null, `prior_summary=${JSON.stringify(priorSummary)}: ${error?.message}`);
    assert.equal(result?.status, 'lgtm');
    assert.equal(notices(calls).length, 0, `prior_summary=${JSON.stringify(priorSummary)} で投稿した`);
    assert.equal(calls.filter((c) => c.label === 'post-summary').length, 1, '終端サマリーは従来どおり投稿する');
  }
});

test('[issue #1065] dev-flow からの nested 起動は食い違いがあっても投稿しない（終端サマリーは dev-flow が投稿する）', async () => {
  const { error, calls } = await run({ caller: 'dev-flow', priorSummary: { source: 'pr-iterate', url: PRIOR_URL, head_sha: OLD_HEAD, head_mismatch: true } });
  assert.equal(error, null, `error: ${error?.message}`);
  assert.equal(notices(calls).length, 0);
});

test('[issue #1065] 再 review 中コメントの投稿失敗は review を止めない（advisory）', async () => {
  for (const response of [{ posted: false, method: '', url: '' }, null]) {
    const { result, error, calls } = await run({
      priorSummary: { source: 'pr-iterate', url: PRIOR_URL, head_sha: OLD_HEAD, head_mismatch: true },
      overrides: { 'post-rereview-notice': response },
    });
    assert.equal(error, null, `投稿失敗（${JSON.stringify(response)}）で throw した: ${error?.message}`);
    assert.equal(result?.status, 'lgtm');
    assert.ok(calls.some((c) => c.agentType === 'dev-flow:pr-reviewer'), 'review に進む');
  }
});

test('[issue #1065] 不正形の prior_summary は agent 起動前に throw する', async () => {
  const bads = [
    'x',
    { source: 'other', url: null, head_sha: null, head_mismatch: true },
    { source: 'dev-flow', url: 1, head_sha: null, head_mismatch: true },
    { source: 'dev-flow', url: null, head_sha: 1, head_mismatch: true },
    { source: 'dev-flow', url: null, head_sha: null, head_mismatch: 'true' },
  ];
  for (const bad of bads) {
    const { error, calls } = await run({ priorSummary: bad });
    assert.ok(error != null && /args\.prior_summary が不正形/.test(error.message), `不正な prior_summary ${JSON.stringify(bad)} で throw していない: ${error?.message}`);
    assert.equal(calls.length, 0, 'prior_summary 検証の throw は agent 起動前');
  }
});
