// F1 (issue #449): pr-iterate.js の review loop 進入前に isolation-probe を配線する検証テスト（TDD）。
// dev-flow.js の Setup phase 配線（_lib/isolation-probe-wiring.test.mjs）と同型だが、pr-iterate では
// review loop 進入前（fix stage 不到達の保証）に probe を置く点が異なる。純関数
// （isolationProbePrompt/isolationFailureMessage）自体は _lib/isolation-probe.test.mjs でテスト済み。
//
// issue #636: 従来 (a) にあった pr-iterate.js ソース文字列の regex 走査（関数本体・行順序・schema
// 宣言・log 文言 pin）を、VM 実行による挙動検証（agentType/呼び出し順序/prompt データ echo/
// fail-open・fail-closed 分岐）へ置換した。inline 区間の全文整合は _lib/workflow-inlines.sync.test.mjs
// が別途保証するため本ファイルの対象外。
// 本ファイルは VM 実行による written:false→throw / written:true→lgtm 完走 / null→fail-open 完走の
// 3 分岐と、isolation-probe/isolation-cleanup/pr-meta の配線挙動を検証する。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ISOLATION_PROBE_CLEANUP_GLOB } from './isolation-probe.mjs';
import { makePrIterateSandbox, runWorkflowCapture } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', '.claude/workflows/pr-iterate.js'), 'utf8');

// ---- VM 実行 harness（test-helpers/vm-sandbox.mjs の makePrIterateSandbox）----
// isolation 系 3 call と journal-log の応答だけを上書きする。isolation-cleanup の既定は null（fail-open 経路）、
// pr-meta の既定は epoch なし（isoToken の PR 番号 fallback を見るため）。

function makeSandbox({ isolationProbeResult, journalResult, isolationCleanupResult, prMetaResult, args = '5' } = {}) {
  const { ctx, calls } = makePrIterateSandbox({
    args,
    overrides: {
      'isolation-probe': isolationProbeResult,
      'isolation-cleanup': isolationCleanupResult ?? null,
      'pr-meta': prMetaResult ?? { url: 'https://github.com/acme/skills/pull/5', head_ref: 'feature/x', base_ref: 'main', cwd: '/tmp/wt' },
      'journal-log': journalResult ?? { logged: true, summary: 'ok' },
    },
  });
  const count = (pred) => () => calls.filter(pred).length;
  return {
    ctx,
    calls,
    getReviewerCallCount: count((c) => c.agentType === 'dev-flow:pr-reviewer'),
    getFixCallCount: count((c) => c.label.startsWith('fix#')),
    getIsolationProbeCallCount: count((c) => c.label === 'isolation-probe'),
  };
}

const runPrIterateCapture = (source, ctx) => runWorkflowCapture(source, ctx, '.claude/workflows/pr-iterate.js');

// ---- (i) 呼び出し順序: pr-meta < isolation-cleanup < isolation-probe < 最初の pr-reviewer 呼び出し ----

test('[isolation-wiring] pr-meta → isolation-cleanup → isolation-probe → 最初の pr-reviewer 呼び出しの順に実行される', async () => {
  const { ctx, calls } = makeSandbox({ isolationProbeResult: { written: true } });
  const { result, error } = await runPrIterateCapture(src, ctx);

  assert.equal(error, null, `written:true では throw されるべきではないが error=${error?.message}`);
  assert.equal(result?.status, 'lgtm', `result.status は 'lgtm' であるべきだが '${result?.status}' だった`);

  const labels = calls.map((c) => c.label);
  const metaIdx = labels.indexOf('pr-meta');
  const cleanupIdx = labels.indexOf('isolation-cleanup');
  const probeIdx = labels.indexOf('isolation-probe');
  const reviewerIdx = calls.findIndex((c) => c.agentType === 'dev-flow:pr-reviewer');

  assert.notStrictEqual(metaIdx, -1, 'pr-meta 呼び出しが記録されていない');
  assert.notStrictEqual(cleanupIdx, -1, 'isolation-cleanup 呼び出しが記録されていない');
  assert.notStrictEqual(probeIdx, -1, 'isolation-probe 呼び出しが記録されていない');
  assert.notStrictEqual(reviewerIdx, -1, 'pr-reviewer 呼び出しが記録されていない');

  assert.ok(metaIdx < cleanupIdx, 'pr-meta は isolation-cleanup より前に呼ばれるべき');
  assert.ok(cleanupIdx < probeIdx, 'isolation-cleanup は isolation-probe より前に呼ばれるべき');
  assert.ok(probeIdx < reviewerIdx, 'isolation-probe は最初の pr-reviewer 呼び出しより前に呼ばれるべき（review loop 進入前）');
});

// ---- (ii) agentType が namespaced 形（dev-flow:<name>）で正しく割り当てられている ----

test('[isolation-wiring] isolation-probe/isolation-cleanup/pr-meta の agentType が期待どおりの namespaced id である', async () => {
  const { ctx, calls } = makeSandbox({ isolationProbeResult: { written: true } });
  const { error } = await runPrIterateCapture(src, ctx);
  assert.equal(error, null, `written:true では throw されるべきではないが error=${error?.message}`);

  const probeCall = calls.find((c) => c.label === 'isolation-probe');
  const cleanupCall = calls.find((c) => c.label === 'isolation-cleanup');
  const metaCall = calls.find((c) => c.label === 'pr-meta');

  assert.ok(probeCall, 'isolation-probe 呼び出しが記録されていない');
  assert.ok(cleanupCall, 'isolation-cleanup 呼び出しが記録されていない');
  assert.ok(metaCall, 'pr-meta 呼び出しが記録されていない');

  assert.equal(probeCall.agentType, 'dev-flow:dev-runner-haiku-wo', 'isolation-probe の agentType が期待と異なる');
  assert.equal(cleanupCall.agentType, 'dev-flow:dev-runner-haiku', 'isolation-cleanup の agentType が期待と異なる');
  assert.equal(metaCall.agentType, 'dev-flow:dev-runner-haiku-ro', 'pr-meta の agentType が期待と異なる');
});

// ---- (iii) isoToken: pr-meta の epoch → probe path token（fallback は PR 番号） ----

test('[isolation-wiring] pr-meta が epoch を返した場合、isolation-probe の prompt が同 epoch を token として含む', async () => {
  const { ctx, calls } = makeSandbox({
    isolationProbeResult: { written: true },
    prMetaResult: { url: 'https://github.com/acme/skills/pull/5', head_ref: 'feature/x', base_ref: 'main', cwd: '/tmp/wt', epoch: 999 },
  });
  const { error } = await runPrIterateCapture(src, ctx);
  assert.equal(error, null, `written:true では throw されるべきではないが error=${error?.message}`);

  const probeCall = calls.find((c) => c.label === 'isolation-probe');
  assert.ok(probeCall, 'isolation-probe 呼び出しが記録されていない');
  assert.ok(
    probeCall.prompt.includes('.isolation-probe-999'),
    `pr-meta の epoch(999) が isoToken として probe path に反映されるべき。prompt: ${probeCall.prompt.slice(0, 400)}`,
  );
});

test('[isolation-wiring] pr-meta が epoch を返さない場合、isolation-probe の prompt は PR 番号(5)へ fallback した token を含む', async () => {
  const { ctx, calls } = makeSandbox({
    isolationProbeResult: { written: true },
    prMetaResult: { url: 'https://github.com/acme/skills/pull/5', head_ref: 'feature/x', base_ref: 'main', cwd: '/tmp/wt' },
  });
  const { error } = await runPrIterateCapture(src, ctx);
  assert.equal(error, null, `written:true では throw されるべきではないが error=${error?.message}`);

  const probeCall = calls.find((c) => c.label === 'isolation-probe');
  assert.ok(probeCall, 'isolation-probe 呼び出しが記録されていない');
  assert.ok(
    probeCall.prompt.includes('.isolation-probe-5'),
    `pr-meta が epoch を返さない場合、isoToken は PR 番号(5)へ fallback するべき。prompt: ${probeCall.prompt.slice(0, 400)}`,
  );
});

// ---- (iv) isolation-cleanup の除去対象は ISOLATION_PROBE_CLEANUP_GLOB のみ（.devflow-tmp 全体ではない） ----

test('[isolation-wiring] isolation-cleanup prompt は ISOLATION_PROBE_CLEANUP_GLOB のみを対象にし、.devflow-tmp 全体は対象にしない', async () => {
  const { ctx, calls } = makeSandbox({ isolationProbeResult: { written: true } });
  const { error } = await runPrIterateCapture(src, ctx);
  assert.equal(error, null, `written:true では throw されるべきではないが error=${error?.message}`);

  const cleanupCall = calls.find((c) => c.label === 'isolation-cleanup');
  assert.ok(cleanupCall, 'isolation-cleanup 呼び出しが記録されていない');
  assert.ok(
    cleanupCall.prompt.includes(`git -C /tmp/wt clean -fdx -- ${ISOLATION_PROBE_CLEANUP_GLOB}`),
    `cleanup コマンドが ISOLATION_PROBE_CLEANUP_GLOB（${ISOLATION_PROBE_CLEANUP_GLOB}）を対象にするべき。prompt: ${cleanupCall.prompt.slice(0, 400)}`,
  );
  assert.ok(
    !cleanupCall.prompt.includes('clean -fdx -- .devflow-tmp`'),
    'pr-iterate の cleanup 対象は .devflow-tmp 全体になってはならない（glob 限定 — issue #555）',
  );
});

// ---- (v) isolation-cleanup の失敗は fail-open（probe に到達し lgtm 完走する） ----

test('[isolation-wiring] isolation-cleanup が {cleaned:false} を返しても fail-open で isolation-probe に到達し lgtm 完走する', async () => {
  const { ctx, getIsolationProbeCallCount } = makeSandbox({
    isolationProbeResult: { written: true },
    isolationCleanupResult: { cleaned: false, error: 'cleanup denied' },
  });
  const { result, error } = await runPrIterateCapture(src, ctx);

  assert.equal(error, null, 'isolation-cleanup 失敗（cleaned:false）で throw してはならない（fail-open）');
  assert.equal(getIsolationProbeCallCount(), 1, 'cleanup 失敗後も isolation-probe は 1 回呼ばれるべき');
  assert.equal(result?.status, 'lgtm', `result.status は 'lgtm' であるべきだが '${result?.status}' だった`);
});

test('[isolation-wiring] isolation-cleanup が null（agent 失敗）でも fail-open で isolation-probe に到達し lgtm 完走する', async () => {
  const { ctx, getIsolationProbeCallCount } = makeSandbox({
    isolationProbeResult: { written: true },
    isolationCleanupResult: null,
  });
  const { result, error } = await runPrIterateCapture(src, ctx);

  assert.equal(error, null, 'isolation-cleanup が null（agent 失敗）で throw してはならない（fail-open）');
  assert.equal(getIsolationProbeCallCount(), 1, 'cleanup 失敗後も isolation-probe は 1 回呼ばれるべき');
  assert.equal(result?.status, 'lgtm', `result.status は 'lgtm' であるべきだが '${result?.status}' だった`);
});

// ---- (vi) written:false の throw メッセージ contract（識別子・startRef） ----

test('[isolation-wiring] written:false の throw メッセージは pr-iterate-run / args(5) / EnterWorktree を含み dev-flow を指さない', async () => {
  const { ctx, getReviewerCallCount, getFixCallCount, getIsolationProbeCallCount } = makeSandbox({
    isolationProbeResult: { written: false, error: 'Write denied by bg-isolation guard' },
  });

  const { result, error } = await runPrIterateCapture(src, ctx);

  assert.equal(getIsolationProbeCallCount(), 1, 'isolation-probe は 1 回呼ばれるべき');
  assert.ok(error != null, 'written:false は throw で終端するべきだが error が null だった');
  const message = String(error?.message ?? '');
  assert.match(message, /pr-iterate-run/, 'throw メッセージに workflowName(pr-iterate-run) が含まれるべき');
  assert.match(message, /EnterWorktree/, 'throw メッセージに回避手順（EnterWorktree）の一部が含まれるべき');
  assert.match(
    message,
    /Workflow\(\{ name: "dev-flow:pr-iterate-run", args: "5" \}\)/,
    'throw メッセージの再実行手順は namespaced workflow 名 dev-flow:pr-iterate-run・PR 番号 args を指すべき（issue #455 / #828: 旧名・dev-flow 誤 workflow 名の再発防止）',
  );
  assert.doesNotMatch(message, /name: "dev-flow"/, 'throw メッセージが誤って dev-flow を再起動先として指示してはいけない');
  assert.equal(getReviewerCallCount(), 0, 'written:false 検知後は pr-reviewer に到達しないべき');
  assert.equal(getFixCallCount(), 0, 'written:false 検知後は fix stage に到達しないべき');
  assert.equal(result, null, 'throw で終端した場合 result は解決されない');
});

test('[isolation-wiring] written:false の throw メッセージは PR head 起点（origin/feature/x）を提示し base_ref 起点（origin/main）を提示しない', async () => {
  const { ctx } = makeSandbox({
    isolationProbeResult: { written: false, error: 'Write denied by bg-isolation guard' },
  });

  const { error } = await runPrIterateCapture(src, ctx);
  assert.ok(error != null, 'written:false は throw で終端するべきだが error が null だった');
  const message = String(error?.message ?? '');
  assert.match(
    message,
    /origin\/feature\/x/,
    'throw メッセージは PR head（origin/feature/x）を起点として提示するべき（PR の変更を含む worktree を再現する必要がある）',
  );
  assert.doesNotMatch(
    message,
    /origin\/main/,
    'throw メッセージが base_ref 起点（origin/main）を提示してはならない（PR の変更を含まない worktree になってしまう）',
  );
});

// ---- (vii) probe が null（未 stub のデフォルト）でも throw せず fail-open で完走する ----
// probe 自体の失敗（null）は fail-open。この分岐の log 文言は assert しない（既存 §(b) 相当）。

test('[isolation-probe] probe が null（未 stub のデフォルト）でも throw せず fail-open で完走する', async () => {
  const { ctx, getIsolationProbeCallCount } = makeSandbox({
    isolationProbeResult: null,
  });

  const { result, error } = await runPrIterateCapture(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`pr-iterate.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }
  assert.equal(error, null, `probe null は fail-open で続行するべきだが throw された: ${error?.message}`);
  assert.equal(getIsolationProbeCallCount(), 1, 'isolation-probe は 1 回呼ばれるべき');
  assert.equal(result?.status, 'lgtm', `result.status は 'lgtm' であるべきだが '${result?.status}' だった`);
});

// ---- (b) written:true → 既存挙動不変で lgtm 完走する（不変） ----

test('[isolation-probe] written:true → 既存挙動不変で lgtm 完走する', async () => {
  const { ctx, getIsolationProbeCallCount } = makeSandbox({
    isolationProbeResult: { written: true },
  });

  const { result, error } = await runPrIterateCapture(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`pr-iterate.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }
  assert.equal(error, null, `written:true で throw されるべきではないが error=${error?.message}`);
  assert.equal(getIsolationProbeCallCount(), 1, 'isolation-probe は 1 回呼ばれるべき');
  assert.equal(result?.status, 'lgtm', `result.status は 'lgtm' であるべきだが '${result?.status}' だった`);
});

// ---- (viii) /pr-iterate wrapper skill 経由の単体起動（issue #828）----
// wrapper は pr-iterate-prerun の出力を nested（caller:'standalone'）で渡す。pr-meta / isolation-cleanup は
// 起動せず、isolation-probe は prerun の worktree・epoch で走り（fail-closed 不変）、終端サマリーは投稿する。

const PRERUN = { cwd: '/repo-wt/pr-5', head_ref: 'feature/x', head_sha: 'b'.repeat(40), base_ref: 'main', repo: 'acme/skills', epoch: 4242 };
const standaloneArgs = (nested = {}) => ({ pr: 5, nested: { caller: 'standalone', ...PRERUN, ...nested } });

test('[isolation-wiring][standalone] nested caller:standalone → pr-meta / isolation-cleanup を起動せず、prerun の cwd・epoch で isolation-probe を走らせ lgtm 完走する', async () => {
  const { ctx, calls } = makeSandbox({ isolationProbeResult: { written: true }, args: standaloneArgs() });
  const { result, error } = await runPrIterateCapture(src, ctx);

  assert.equal(error, null, `standalone nested 起動は throw されるべきではないが error=${error?.message}`);
  assert.equal(result?.status, 'lgtm');
  const labels = calls.map((c) => c.label);
  assert.ok(!labels.includes('pr-meta'), `standalone nested 起動で pr-meta が起動した: ${labels.join(', ')}`);
  assert.ok(!labels.includes('isolation-cleanup'), `standalone nested 起動で isolation-cleanup が起動した: ${labels.join(', ')}`);
  const probeIdx = labels.indexOf('isolation-probe');
  const reviewerIdx = calls.findIndex((c) => c.agentType === 'dev-flow:pr-reviewer');
  assert.ok(probeIdx >= 0 && probeIdx < reviewerIdx, 'isolation-probe は残し、最初の pr-reviewer より前に走るべき');
  assert.ok(
    calls[probeIdx].prompt.includes('/repo-wt/pr-5/.devflow-tmp/.isolation-probe-4242'),
    `probe 対象は prerun の worktree と epoch であるべき: ${calls[probeIdx].prompt.slice(0, 300)}`,
  );
});

test('[isolation-wiring][standalone] caller:standalone は終端サマリーを投稿し、caller:dev-flow は投稿しない', async () => {
  const standalone = makeSandbox({ isolationProbeResult: { written: true }, args: standaloneArgs() });
  const r1 = await runPrIterateCapture(src, standalone.ctx);
  assert.equal(r1.error, null, `standalone: ${r1.error?.message}`);
  assert.equal(standalone.calls.filter((c) => c.label === 'post-summary').length, 1, '単体起動（caller:standalone）は終端サマリーを投稿するべき');

  const devflow = makeSandbox({ isolationProbeResult: { written: true }, args: { pr: 5, nested: { caller: 'dev-flow', ...PRERUN } } });
  const r2 = await runPrIterateCapture(src, devflow.ctx);
  assert.equal(r2.error, null, `dev-flow: ${r2.error?.message}`);
  assert.equal(devflow.calls.filter((c) => c.label === 'post-summary').length, 0, 'dev-flow からの起動は終端サマリーを投稿しない（dev-flow が投稿する）');
});

test('[isolation-wiring][standalone] args.prior_devflow が HOLD なら投稿する終端サマリーに回収状況が載り、不正形は agent 起動前に throw する（issue #930）', async () => {
  const prior = { tier: 'HOLD', codes: ['ac_human_pending'], url: 'https://github.com/acme/skills/pull/5#issuecomment-1' };
  const { ctx, calls } = makeSandbox({ isolationProbeResult: { written: true }, args: { ...standaloneArgs(), prior_devflow: prior } });
  const { result, error } = await runPrIterateCapture(src, ctx);
  assert.equal(error, null, `prior_devflow 付きの単体起動: ${error?.message}`);
  assert.equal(result?.status, 'lgtm');
  const post = calls.find((c) => c.label === 'post-summary');
  assert.ok(post, '終端サマリーを投稿するべき');
  assert.ok(post.prompt.includes('### dev-flow の HOLD 理由の回収状況'), `回収状況の節が無い: ${post.prompt.slice(0, 1500)}`);
  assert.ok(post.prompt.includes(prior.url), '元の dev-flow サマリーへのリンクが無い');
  assert.ok(!post.prompt.includes('🎉 LGTM'), 'ac_human_pending が未解消なのに 🎉 LGTM 見出しになっている');

  for (const bad of ['HOLD', { tier: 'HOLD', codes: 'x', url: null }, { tier: '', codes: [], url: null }, { tier: 'HOLD', codes: [], url: 1 }]) {
    const s = makeSandbox({ isolationProbeResult: { written: true }, args: { ...standaloneArgs(), prior_devflow: bad } });
    const r = await runPrIterateCapture(src, s.ctx);
    assert.ok(r.error != null && /args\.prior_devflow が不正形/.test(r.error.message), `不正な prior_devflow ${JSON.stringify(bad)} で throw していない: ${r.error?.message}`);
    assert.equal(s.calls.length, 0, 'prior_devflow 検証の throw は agent 起動前');
  }
});

test('[isolation-wiring][standalone] caller:standalone でも written:false は fail-closed で throw し、review に進まない', async () => {
  const { ctx, getReviewerCallCount, getFixCallCount } = makeSandbox({
    isolationProbeResult: { written: false, error: 'Write denied by bg-isolation guard' },
    args: standaloneArgs(),
  });
  const { error } = await runPrIterateCapture(src, ctx);

  assert.ok(error != null, 'written:false は caller に関係なく throw するべき');
  assert.match(String(error.message), /origin\/feature\/x/, '回避手順の起点は prerun の head_ref');
  assert.equal(getReviewerCallCount(), 0);
  assert.equal(getFixCallCount(), 0);
});

test('[isolation-wiring][nested] caller:dev-flow で nested.epoch 省略時は pr-meta / isolation-cleanup を起動せず、isoToken が PR 番号へ fallback する', async () => {
  const { ctx, calls } = makeSandbox({
    isolationProbeResult: { written: true },
    args: { pr: '7', nested: { caller: 'dev-flow', cwd: '/wt', head_ref: 'feature/issue-1', base_ref: 'main' } },
  });
  const { result, error } = await runPrIterateCapture(src, ctx);

  assert.equal(error, null, `nested 起動（epoch 省略）は throw されるべきではないが error=${error?.message}`);
  assert.equal(result?.status, 'lgtm', `result.status は 'lgtm' であるべきだが '${result?.status}' だった`);
  const labels = calls.map((c) => c.label);
  assert.ok(!labels.includes('pr-meta'), 'nested 起動では pr-meta が呼ばれてはいけない');
  assert.ok(!labels.includes('isolation-cleanup'), 'nested 起動では isolation-cleanup が呼ばれてはいけない');
  const probe = calls.find((c) => c.label === 'isolation-probe');
  assert.ok(probe, 'nested 起動でも isolation-probe は呼ばれるべき');
  assert.match(probe.prompt, /\.devflow-tmp\/\.isolation-probe-7/, 'nested.epoch 省略時、isoToken は PR 番号(7)へ fallback するべき');
});

test('[isolation-wiring][standalone] nested の非 object・cwd 欠落・caller の欠落 / out-of-enum・base_ref の型違反は明示 throw（legacy fallback を作らない）', async () => {
  for (const nested of [
    'not-an-object',
    { caller: 'dev-flow', head_ref: 'feature/issue-1' },
    { cwd: '/wt', head_ref: 'feature/x' },
    { caller: 'pr-iterate', cwd: '/wt', head_ref: 'feature/x' },
    { caller: 'standalone', cwd: '/wt', head_ref: 'feature/x', base_ref: 1 },
  ]) {
    const { ctx, calls } = makeSandbox({ isolationProbeResult: { written: true }, args: { pr: 5, nested } });
    const { error } = await runPrIterateCapture(src, ctx);
    assert.ok(error != null && /args\.nested(\.(caller|base_ref)| が不正形)/.test(error.message), `不正な nested ${JSON.stringify(nested)} で throw していない: ${error?.message}`);
    assert.equal(calls.length, 0, 'nested 検証の throw は agent 起動前');
  }
});
