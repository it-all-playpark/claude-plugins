// _lib/devflow-security-review-routing.test.mjs
// dev-flow の敵対的 security review の配線（issue #1063）を VM 実行で pin する。
//   (a) Diff triage の対象判定は nested pr-iterate へ渡さない（pr-iterate が security-codex-relay で取る。issue #1307）
//   (b) 対象の run で pr-iterate が今の head で clear にしない（critical/major が上限まで残る・worktree の外を指す・
//       review に到達しない）と、Merge tier は専用の hold code security_review_unresolved で HOLD
//   (c) 対象で clear・対象外の run はこの code を積まない（clear なら pr-iterate の終端 status に依らない。
//       LGTM 以外の終端は iterate_non_lgtm が HOLD にする — issue #1171）
//   (d) 公開の終端サマリーには security review の件数だけが載る
//   (e) pr-iterate が review 前に止めた理由（security_review.stop_reason）を引き継ぎ、終端サマリーを出し分ける（issue #1082）
//   (f) fix が人の判断に返した security の指摘の件数（security_review.deferred）を引き継ぎ、終端サマリーに件数を出す（issue #1121）
//   (g) prerun が読んだ security review の CLI の opt-in（args.setup.security_reviewer）を args.security_reviewer で渡す（issue #1125）

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash, securityScopeResponse, devFlowArgs } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const devFlowSrc = readFileSync(join(here, '..', '.claude/workflows/dev-flow.js'), 'utf8');

const TARGET = { 'security-scope': securityScopeResponse({ target: true, head: null }) };
const sr = (status, counts = {}) => ({ target: true, status, rounds: 2, critical: 1, major: 0, minor: 0, ...counts });

async function run({ overrides = TARGET, iterate, setup = {} } = {}) {
  const workflowCalls = [];
  const { ctx, calls } = makeDevFlowSandbox({
    overrides,
    workflow: async (name, opts) => { workflowCalls.push({ name, opts }); return iterate; },
    extra: { args: devFlowArgs(1, setup) },
  });
  const { result, error } = await runWorkflowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'devflow-security-review');
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  return { result, calls, workflowCalls };
}
const codes = (result) => JSON.parse(JSON.stringify(result.merge_tier_hold_reasons.map((r) => r.code)));

test('[devflow-security-review] (a)(g) nested pr-iterate には Diff triage の対象判定を渡さず（pr-iterate が security-codex-relay で取る）、args.setup.security_reviewer を args.security_reviewer で渡す', async () => {
  // Diff triage の対象・対象外・指示ファイルを変える diff・取得失敗のどれでも、判定は渡さずに opt-in の値だけを渡す
  for (const [reviewer, scope] of [
    ['claude', TARGET['security-scope']],
    ['codex', TARGET['security-scope']],
    ['claude', securityScopeResponse({ target: false, head: null })],
    ['codex', securityScopeResponse({ target: true, head: null, contextChanged: true })],
    ['claude', null],
  ]) {
    const name = `${reviewer} / ${JSON.stringify(scope)}`;
    const { workflowCalls } = await run({ setup: { security_reviewer: reviewer }, overrides: { 'security-scope': scope }, iterate: { status: 'lgtm', fixes_applied: 0, security_review: sr('cleared', { critical: 0 }) } });
    assert.equal(workflowCalls.length, 1, name);
    const opts = workflowCalls[0].opts;
    assert.ok(!('security_review' in opts), `${name}: nested pr-iterate に security_review を渡した: ${JSON.stringify(opts.security_review)}`);
    assert.equal(opts.security_reviewer, reviewer, name);
  }
  // Diff triage の対象判定は lite route の入口と Merge tier が読む（exec-proxy の起動形は変えない）
  const { calls } = await run({ iterate: { status: 'lgtm', fixes_applied: 0, security_review: sr('cleared', { critical: 0 }) } });
  const scope = calls.find((c) => c.label === 'security-scope');
  assert.equal(scope.agentType, 'dev-flow:dev-runner-haiku-ro');
  assert.ok(scope.prompt.endsWith('\nsecurity-review-scope /tmp/wt origin/main --working-tree'), scope.prompt);
});

test('[devflow-security-review] (b) 対象の run で pr-iterate が clear にしないまま終われば、どの status でも security_review_unresolved で HOLD', async () => {
  for (const [status, review] of [
    ['max_reached', sr('unresolved')],
    ['stuck', sr('unresolved')],
    ['security_unresolved', sr('unresolved')],
    ['ci_pending', sr('not_run', { rounds: 0, critical: 0 })],
    ['ci_error', sr('not_run', { rounds: 0, critical: 0 })],
    ['fix_failed', sr('unresolved')],
  ]) {
    const { result } = await run({ iterate: { status, iterations: 2, fixes_applied: 1, security_review: review } });
    assert.equal(result.merge_tier, 'HOLD', status);
    assert.ok(codes(result).includes('security_review_unresolved'), `${status}: ${JSON.stringify(codes(result))}`);
    assert.equal(result.security_review.target, true);
  }
});

test('[devflow-security-review] (b) Diff triage が対象外でも pr-iterate が run 中に対象と判定して clear にしなければ HOLD、security_review を返さない pr-iterate も HOLD', async () => {
  const turned = await run({ overrides: {}, iterate: { status: 'security_unresolved', fixes_applied: 0, security_review: sr('unresolved') } });
  assert.ok(codes(turned.result).includes('security_review_unresolved'));
  const missing = await run({ iterate: { status: 'lgtm', fixes_applied: 0 } });
  assert.equal(missing.result.merge_tier, 'HOLD');
  assert.deepEqual(codes(missing.result), ['security_review_unresolved'], `Diff triage が対象で pr-iterate の clear が無い: ${JSON.stringify(codes(missing.result))}`);
});

test('[devflow-security-review] (c) 対象で clear、または対象外の run は security_review_unresolved を積まない', async () => {
  const cleared = await run({ iterate: { status: 'lgtm', fixes_applied: 0, security_review: sr('cleared', { critical: 0 }) } });
  assert.equal(cleared.result.merge_tier, 'REVIEW');
  const notTarget = await run({ overrides: {}, iterate: { status: 'lgtm', fixes_applied: 0, security_review: { target: false, status: 'not_target', rounds: 0, critical: 0, major: 0, minor: 0 } } });
  assert.equal(notTarget.result.merge_tier, 'REVIEW');
  assert.equal(notTarget.result.security_review.target, false);
});

test('[devflow-security-review] (c) 対象で今の head が clear なら、pr-iterate が LGTM 以外で終わっても security_review_unresolved を積まず、iterate_non_lgtm で HOLD のまま', async () => {
  for (const status of ['stuck', 'max_reached']) {
    const { result } = await run({ iterate: { status, iterations: 2, fixes_applied: 0, security_review: sr('cleared', { critical: 0 }) } });
    assert.equal(result.merge_tier, 'HOLD', status);
    assert.ok(!codes(result).includes('security_review_unresolved'), `${status}: ${JSON.stringify(codes(result))}`);
    assert.ok(codes(result).includes('iterate_non_lgtm'), `${status}: ${JSON.stringify(codes(result))}`);
    assert.equal(result.security_review.status, 'cleared', status);
  }
});

test('[devflow-security-review] (e) securityReviewFinal は nested pr-iterate の security_review.stop_reason を引き継ぎ、HOLD 理由の「現状」を出し分ける', async () => {
  const changed = await run({ iterate: { status: 'security_unresolved', iterations: 1, fixes_applied: 0, security_review: sr('unresolved', { stop_reason: 'reviewer_context_changed', rounds: 0, critical: 0 }) } });
  assert.equal(changed.result.security_review.stop_reason, 'reviewer_context_changed');
  assert.equal(changed.result.merge_tier, 'HOLD', 'stop_reason があっても security_review_unresolved の HOLD は変えない');
  assert.ok(codes(changed.result).includes('security_review_unresolved'));
  const body = changed.calls.find((c) => c.label === 'post-summary').prompt;
  assert.ok(body.includes('指示ファイルを変える PR なので自動 review をしていない（review 0 回）'), body.slice(0, 3000));
  // 返さない pr-iterate（stop_reason の無い返り値）は null
  const none = await run({ iterate: { status: 'max_reached', iterations: 2, fixes_applied: 1, security_review: sr('unresolved') } });
  assert.equal(none.result.security_review.stop_reason, null);
});

test('[devflow-security-review] (d) 終端サマリーの HOLD 理由には security review の回数と件数だけを出す', async () => {
  const { calls } = await run({ iterate: { status: 'max_reached', iterations: 10, fixes_applied: 3, security_review: sr('unresolved', { rounds: 3, critical: 1, major: 2 }) } });
  const body = calls.find((c) => c.label === 'post-summary').prompt;
  assert.ok(body.includes('security review が今の PR head で clear になっていない（敵対的 review 3 回・最終 critical 1 / major 2）'), body.slice(0, 3000));
  assert.ok(body.includes('codes=') && body.includes('security_review_unresolved'), 'HOLD marker に code が無い');
});

test('[devflow-security-review] (f) securityReviewFinal は nested pr-iterate の security_review.deferred（fix が人の判断に返した指摘の件数）を受け取り、HOLD 理由の「現状」に件数を出す', async () => {
  const deferred = await run({ iterate: { status: 'security_unresolved', iterations: 1, fixes_applied: 1, security_review: sr('unresolved', { rounds: 1, critical: 1, deferred: 1 }) } });
  assert.equal(deferred.result.security_review.deferred, 1);
  assert.equal(deferred.result.merge_tier, 'HOLD');
  assert.ok(codes(deferred.result).includes('security_review_unresolved'));
  const body = deferred.calls.find((c) => c.label === 'post-summary').prompt;
  assert.ok(body.includes('security review が今の PR head で clear になっていない（敵対的 review 1 回・最終 critical 1 / major 0）— security の指摘 1 件を fix が直さずに人の判断に返した'), body.slice(0, 3000));
  // deferred の無い返り値は 0
  const none = await run({ iterate: { status: 'max_reached', iterations: 2, fixes_applied: 1, security_review: sr('unresolved') } });
  assert.equal(none.result.security_review.deferred, 0);
});
