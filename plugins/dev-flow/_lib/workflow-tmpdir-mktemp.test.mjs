// Regression test (issue #712): コメント投稿 prompt が mktemp を指示せず、固定パスへの Write と
// gh の bare 単文 1 回実行（--repo 付き）を指示することを VM 挙動で保証する。
//
// 問題: bodySaveInstr が `mktemp` → Write tool を指示していたため、mktemp が作った既存ファイルへの
//       Write が「未 Read」で必ず拒否され、agent が heredoc へ逸れた上に `gh pr comment ... && echo`
//       と連結して投稿に失敗した（PR #711）。posted:false は fail-open の log 1 行だけで人間が気づけない。
//
// 検証:
//   (a-static) bodySaveInstr の canonical に `mktemp` が現れない（2 workflow の全呼び出し元をまとめて pin）。
//       2 workflow 全文に旧形式 `mktemp /tmp/` も現れない
//   (b) 投稿 prompt 2 箇所（dev-flow post-summary / pr-iterate post-summary）が
//       mktemp を含まず、bare 単文の禁止句と `--repo <REPO>` 付きの gh コマンドを渡す
//   (c) dev-flow / pr-iterate は worktree の `.devflow-tmp/` 固定パスへ保存させる

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  makeDevFlowSandbox, makePrIterateSandbox, runWorkflowCapture, assertNoCrash,
} from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const workflowDir = join(here, '..', '.claude/workflows');
const devFlowSrc = readFileSync(join(workflowDir, 'dev-flow.js'), 'utf8');
const prIterateSrc = readFileSync(join(workflowDir, 'pr-iterate.js'), 'utf8');
const postHelpersSrc = readFileSync(join(here, 'workflow-post-helpers.mjs'), 'utf8');

const BARE_RULE = '先頭トークンが gh の bare 単文で 1 回だけ実行せよ（cd 前置・bash 前置・環境変数代入前置・&& 連結・パイプ・リダイレクト禁止）';

async function runDevFlow(overrides = {}) {
  const { ctx, calls } = makeDevFlowSandbox({
    // pr_url を github URL にして --repo の解決元を pr_url に固定する
    overrides: { 'pr#1': { pr_url: 'https://github.com/acme/skills/pull/1', pr_number: 1, committed: true }, ...overrides },
  });
  const { result, error } = await runWorkflowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'dev-flow');
  assert.equal(error, null, `dev-flow run が throw した: ${error?.message}`);
  return { calls, result };
}

async function runPrIterate() {
  const { ctx, calls } = makePrIterateSandbox();
  const { error } = await runWorkflowCapture(prIterateSrc, ctx, '.claude/workflows/pr-iterate.js');
  assertNoCrash(error, 'pr-iterate');
  assert.equal(error, null, `pr-iterate run が throw した: ${error?.message}`);
  return calls;
}

// (a-static) bodySaveInstr の canonical（2 workflow の inline 区間がここから生成される）に mktemp が無い。
// 未到達分岐の prompt も canonical 経由なので、ここで全呼び出し元をまとめて pin できる。
test('[comment-post] (a-static) _lib/workflow-post-helpers.mjs（2 workflow の inline 元）に mktemp が無い', () => {
  assert.ok(!postHelpersSrc.includes('mktemp'), 'workflow-post-helpers.mjs に mktemp が残存している（固定パスへの Write tool 新規作成に置き換えること）');
});

// (a-static) 旧形式 `mktemp /tmp/`（sandbox で /tmp 直書きが拒否される）が 2 workflow 全文に無い
test('[comment-post] (a-static) dev-flow.js / pr-iterate.js 全文に `mktemp /tmp/` という旧形式が無い', () => {
  for (const [name, src] of [['dev-flow.js', devFlowSrc], ['pr-iterate.js', prIterateSrc]]) {
    assert.ok(!src.includes('mktemp /tmp/'), `${name} に \`mktemp /tmp/\` という旧形式が静的に残存している`);
  }
});

// (b)(c) dev-flow post-summary
test('[comment-post] dev-flow.js post-summary: mktemp 不在・.devflow-tmp 固定パス・bare 単文・--repo 付き gh pr comment', async () => {
  const { calls } = await runDevFlow();
  const post = calls.find((c) => c.label === 'post-summary');
  assert.ok(post, 'post-summary が呼ばれていない');
  assert.doesNotMatch(post.prompt, /mktemp/);
  assert.ok(post.prompt.includes('保存先は固定パス `/tmp/wt/.devflow-tmp/dev-flow-summary.md`'), `固定パス指示が無い:\n${post.prompt.slice(0, 400)}`);
  assert.ok(
    post.prompt.includes(`\`gh pr comment 1 --repo acme/skills --body-file /tmp/wt/.devflow-tmp/dev-flow-summary.md\` を${BARE_RULE}`),
    `--repo 付き bare 単文の gh pr comment 指示が無い:\n${post.prompt}`,
  );
});

// (b)(c) pr-iterate post-summary
test('[comment-post] pr-iterate.js post-summary: mktemp 不在・.devflow-tmp 固定パス・bare 単文・--repo 付き gh pr comment', async () => {
  const post = (await runPrIterate()).find((c) => c.label === 'post-summary');
  assert.ok(post, 'post-summary が呼ばれていない');
  assert.doesNotMatch(post.prompt, /mktemp/);
  assert.ok(post.prompt.includes('保存先は固定パス `/tmp/wt/.devflow-tmp/pr-iterate-summary-5.md`'), `固定パス指示が無い:\n${post.prompt.slice(0, 400)}`);
  assert.ok(
    post.prompt.includes(`\`gh pr comment 5 --repo acme/skills --body-file /tmp/wt/.devflow-tmp/pr-iterate-summary-5.md\` を${BARE_RULE}`),
    `--repo 付き bare 単文の gh pr comment 指示が無い:\n${post.prompt}`,
  );
});
