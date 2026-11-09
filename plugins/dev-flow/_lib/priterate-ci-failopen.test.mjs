// F2: pr-iterate.js の ci-check exec-proxy を throw-safe 化する（failOpenAgent）ことを pin する
// テスト（tdd）。issue #499。
//
// (a) ci-check#i の agent stub が throw する harness ケースで run が throw せず完走し
//     terminal が ci_error（status に反映）になること
// (b) ci-check#i stub が null（schema 未返却）でも同様に ci_error 終端になること
// (c) VM で実際に dispatch された ci-check prompt に 'check-ci --pr' が含まれ '--checks-data' / '--checks-json' /
//     '$TMPDIR/ci-checks' / 'リダイレクト' が含まれないこと（canonical ciCheckPrompt との一致で
//     呼び出し側が独自 prompt を書いていないことも観測する）。ci-check prompt の正負 grep は
//     pr-iterate 側ではここ 1 か所に置く（canonical 側は ci-check.test.mjs）
// (d) hygiene: 実際に dispatch された ci-check / post-summary / journal 系 prompt に guard / sandbox /
//     ガード / サンドボックス が含まれないこと
// (f) ci_error 終端の log が原因を auth/network と断定せず、実 PR 番号を埋めた gh pr checks 確認
//     手順を含むこと（issue #621）
// （issue #636: (c)(d)(f) のソース regex 走査と (e) の failOpenAgent ソース抽出を VM 観測へ置換。
//   (e) は (a) が ci-check 経路で throw→null→ci_error を挙動として担保する）
//
// harness は test-helpers/vm-sandbox.mjs の makePrIterateSandbox / runWorkflowCapture（ci-check#1 だけ上書き）。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ciCheckPrompt } from './ci-check.mjs';
import { makePrIterateSandbox, runWorkflowCapture, assertNoCrash } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', '.claude/workflows/pr-iterate.js'), 'utf8');

const CI_PASSED = { status: 'passed', passed: 1, failed: 0, pending: 0, skipped: 0, failed_checks: [] };

async function runWithCi(ciStub) {
  const { ctx, calls, logs } = makePrIterateSandbox({ overrides: { 'ci-check#1': ciStub } });
  const { result, error } = await runWorkflowCapture(src, ctx, '.claude/workflows/pr-iterate.js');
  assertNoCrash(error, 'priterate-ci-failopen');
  return { result, error, calls, logs };
}

// ---- (a) ci-check#i throw -> run 完走、terminal=ci_error ----
test('[failopen-a] ci-check#1 が throw -> run が throw せず完走し status=ci_error', async () => {
  const { result, error } = await runWithCi(() => { throw new Error('exec-proxy 例外（StructuredOutput 未返却）'); });
  assert.equal(error, null, `run 全体が例外終了してはならないが error が発生: ${error?.name}: ${error?.message}`);
  assert.equal(result?.status, 'ci_error', `ci-check#1 throw 時は status=ci_error であるべきだが '${result?.status}' だった`);
});

// ---- (b) ci-check#i null -> 同様に ci_error 終端 ----
test('[failopen-b] ci-check#1 が null(schema 未返却) -> status=ci_error', async () => {
  const { result, error } = await runWithCi(null);
  assert.equal(error, null, `run 全体が例外終了してはならないが error が発生: ${error?.name}: ${error?.message}`);
  assert.equal(result?.status, 'ci_error', `ci-check#1 null 時は status=ci_error であるべきだが '${result?.status}' だった`);
});

// ---- (c) prompt が argv データ渡し形（実際に dispatch された prompt を観測）----
// prompt 本文は canonical `_lib/ci-check.mjs` にあり両 workflow へ inline 生成される（issue #543）。
// 呼び出し側が canonical を使わず独自 prompt を書き始める退行は、dispatch された prompt と canonical の
// 生成文字列の完全一致で捕まえる。
test('[failopen-c] dispatch された ci-check prompt が canonical ciCheckPrompt と一致し、check-ci --pr を使い --checks-data・--checks-json/$TMPDIR/ci-checks/リダイレクトを含まない', async () => {
  const { calls } = await runWithCi(CI_PASSED);
  const ci = calls.find((c) => c.label === 'ci-check#1');
  assert.ok(ci, 'ci-check#1 が dispatch されていない');
  assert.equal(ci.prompt, ciCheckPrompt({ pr: 5, repo: 'acme/skills' }), 'ci-check の呼び出し側は canonical の ciCheckPrompt() をそのまま使うべき（独自 prompt を書かない）');
  assert.ok(ci.prompt.endsWith('\ncheck-ci --pr 5 --repo acme/skills'), 'ci-check prompt の最終行は check-ci --pr の単文であるべき');
  assert.ok(!ci.prompt.includes('--checks-data'), 'ci-check prompt に旧 --checks-data が残っているべきでない');
  assert.ok(!ci.prompt.includes('--checks-json'), 'ci-check prompt に旧 --checks-json が残っているべきでない');
  assert.ok(!ci.prompt.includes('$TMPDIR/ci-checks'), 'ci-check prompt に $TMPDIR/ci-checks への言及が残っているべきでない');
  assert.ok(!/[>]\s*\$TMPDIR/.test(ci.prompt), 'ci-check prompt に $TMPDIR へのリダイレクト構文が残っているべきでない');
});

// ---- (d) hygiene: guard/sandbox 語が dispatch された prompt に含まれない ----
test('[failopen-d] dispatch された ci-check / post-summary / journal 系 prompt に guard/sandbox 系の語が含まれない', async () => {
  const forbidden = ['guard', 'sandbox', 'ガード', 'サンドボックス'];
  const { calls } = await runWithCi(CI_PASSED);
  for (const label of ['ci-check#1', 'post-summary', 'journal-log']) {
    const c = calls.find((x) => x.label === label);
    assert.ok(c, `${label} が dispatch されていない`);
    const p = c.prompt.toLowerCase();
    for (const word of forbidden) {
      assert.ok(!p.includes(word.toLowerCase()), `${label} prompt に禁止語 '${word}' が含まれているべきでない`);
    }
  }
});

// ---- (f) ci_error の log 文言が原因を断定せず gh pr checks の確認手順を含む（issue #621） ----
test('[failopen-f] ci_error 終端の log は auth/network を断定せず、実 PR 番号を埋めた gh pr checks 確認手順を含む', async () => {
  const { result, logs } = await runWithCi(null);
  assert.equal(result?.status, 'ci_error');
  const line = logs.find((l) => l.includes('CI check returned error'));
  assert.ok(line, `ci_error の log が出ていない: ${JSON.stringify(logs.slice(-5))}`);
  assert.ok(!line.includes('auth/network'), 'log は原因を auth/network と断定しない');
  assert.ok(!line.includes('gh API failed'), 'log は gh API 失敗と断定しない');
  assert.ok(line.includes('gh pr checks 5'), '実 PR 番号を埋めた gh pr checks 確認手順を含む');
});
