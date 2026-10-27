// priterate-hold-test-facts.test.mjs — dev-flow が final_test_red で HOLD にした PR の単体回収で、終端サマリーの前に
// HOLD 時の head → 終端 head の変更ファイル一覧（hold-test-diff）と最終 tree の全件テスト（hold-test-run）を 1 回ずつ取り、
// 条件に当たらない run では起動しないこと（issue #1180）。VM 実行で agent 呼び出しの label を見る。
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makePrIterateSandbox, runWorkflowCapture } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', '.claude/workflows/pr-iterate.js'), 'utf8');

const HOLD_HEAD = 'a'.repeat(40);
const END_HEAD = 'b'.repeat(40);  // review#1 が approve で fix 無し → 終端 head は prerun の head_sha のまま
const WT = '/repo-wt/pr-5';
const PRERUN = { cwd: WT, head_ref: 'feature/x', head_sha: END_HEAD, base_ref: 'main', repo: 'acme/skills', epoch: 4242 };
const PRIOR = { tier: 'HOLD', codes: ['escalate', 'final_test_red'], url: 'https://github.com/acme/skills/pull/5#issuecomment-1', head_sha: HOLD_HEAD };
const HOLD_LABELS = ['hold-test-diff', 'hold-test-run'];

async function run({ prior = PRIOR, caller = 'standalone', overrides = {} } = {}) {
  const { ctx, calls } = makePrIterateSandbox({ args: { pr: 5, nested: { caller, ...PRERUN }, prior_devflow: prior }, overrides });
  const { result, error } = await runWorkflowCapture(src, ctx, '.claude/workflows/pr-iterate.js');
  return { result, error, calls };
}

test('[hold-test-facts] HOLD + final_test_red + head が違う単体起動は、終端サマリーの前に hold-test-diff（ro）と hold-test-run（run-tests 全件）を 1 回ずつ起動し、事実を投稿する', async () => {
  const { result, error, calls } = await run({
    overrides: {
      'hold-test-diff': { ok: true, outside: 0, files: ['src/x.js', 'tests/a.bats'] },
      'hold-test-run': { tests: 'failed', green: false, summary: 'x', failed_files: ['tests/a.bats'] },
    },
  });
  assert.equal(error, null, error?.message);
  assert.equal(result?.status, 'lgtm');
  const labels = calls.map((c) => c.label);
  for (const l of HOLD_LABELS) assert.equal(labels.filter((x) => x === l).length, 1, `${l} は 1 回だけ: ${labels.join(', ')}`);
  assert.ok(labels.indexOf('hold-test-run') < labels.indexOf('post-summary') && labels.indexOf('hold-test-diff') < labels.indexOf('post-summary'), labels.join(', '));

  const diff = calls.find((c) => c.label === 'hold-test-diff');
  assert.equal(diff.agentType, 'dev-flow:dev-runner-haiku-ro');
  assert.ok(diff.prompt.includes(`git -C ${WT} rev-list --count ${END_HEAD}..${HOLD_HEAD}`), diff.prompt);
  assert.ok(diff.prompt.includes(`diff --no-renames --name-only ${HOLD_HEAD}..${END_HEAD}`), diff.prompt);

  const testRun = calls.find((c) => c.label === 'hold-test-run');
  assert.equal(testRun.agentType, 'dev-flow:dev-runner-haiku');
  assert.ok(testRun.prompt.endsWith(`run-tests ${WT} --base origin/main`), testRun.prompt);
  // 落ちたファイルだけの単体再実行・2 回目の全件実行はしない
  assert.equal(calls.filter((c) => /run-tests /.test(String(c.prompt)) && c.label !== 'post-summary').length, 1, labels.join(', '));
  assert.ok(!calls.some((c) => String(c.prompt).includes('--files ')), 'run-tests --files の再実行をしない');

  const post = calls.find((c) => c.label === 'post-summary').prompt;
  assert.ok(post.includes('`final_test_red` — ❌ 未解消（HOLD は外さない — 下の事実で確認範囲を絞って人が確認する）'), post);
  assert.ok(post.includes('あり 1 件 — `tests/a.bats`'), post);
  assert.ok(post.includes(`git diff ${HOLD_HEAD}..${END_HEAD} -- tests/a.bats`), post);
  assert.ok(post.includes('最終 tree の全件テスト（run-tests 1 回）: failed — 失敗ファイル: `tests/a.bats`'), post);
  assert.ok(post.includes('HOLD 理由 2 件が未解消'), post);
});

test('[hold-test-facts] hold-test-diff / hold-test-run が throw しても run は続き、「不明」「実行できなかった」と出して未解消のまま', async () => {
  const boom = () => { throw new Error('injected'); };
  const { result, error, calls } = await run({ overrides: { 'hold-test-diff': boom, 'hold-test-run': boom } });
  assert.equal(error, null, error?.message);
  assert.equal(result?.status, 'lgtm');
  const post = calls.find((c) => c.label === 'post-summary').prompt;
  assert.ok(post.includes('テスト関連の変更（テストとテストの実行を変えうる設定）: 不明'), post);
  assert.ok(post.includes('最終 tree の全件テスト（run-tests 1 回）: 実行できなかった'), post);
  assert.ok(post.includes('HOLD 理由 2 件が未解消'), post);
});

test('[hold-test-facts] 条件に当たらない run（head_sha null・終端 head と同じ・final_test_red なし・HOLD でない・dev-flow からの nested 起動）は hold-test-diff / hold-test-run を起動しない', async () => {
  for (const [name, opts, factInPost] of [
    ['head_sha null', { prior: { ...PRIOR, head_sha: null } }, 'HOLD 時の head 不明'],
    ['終端 head と同じ', { prior: { ...PRIOR, head_sha: END_HEAD } }, 'HOLD 時と同じ head（`bbbbbbb`）'],
    ['final_test_red なし', { prior: { ...PRIOR, codes: ['escalate', 'validate_test_red'] } }, null],
    ['HOLD でない', { prior: { ...PRIOR, tier: 'REVIEW', codes: [] } }, null],
    ['dev-flow からの nested 起動', { caller: 'dev-flow' }, null],
  ]) {
    const { error, calls } = await run(opts);
    assert.equal(error, null, `${name}: ${error?.message}`);
    const labels = calls.map((c) => c.label);
    for (const l of HOLD_LABELS) assert.ok(!labels.includes(l), `${name}: ${l} を起動した: ${labels.join(', ')}`);
    assert.ok(!calls.some((c) => /run-tests /.test(String(c.prompt)) && c.label !== 'post-summary'), `${name}: run-tests を起動した`);
    if (factInPost) {
      const post = calls.find((c) => c.label === 'post-summary').prompt;
      assert.ok(post.includes(factInPost), `${name}: ${post}`);
    }
  }
});
