// _lib/devflow-security-review-routing.test.mjs
// dev-flow の敵対的 security review の配線（issue #1063）を VM 実行で pin する。
//   (a) Security floor の対象判定を nested pr-iterate へ args.security_review で渡す
//   (b) 対象の run で pr-iterate が今の head で clear にしない（critical/major が上限まで残る・worktree の外を指す・
//       LGTM 以外で終わる）と、Merge tier は専用の hold code security_review_unresolved で HOLD
//   (c) 対象で clear・対象外の run はこの code を積まない
//   (d) 公開の終端サマリーには security review の件数だけが載る

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash, securityScopeResponse } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const devFlowSrc = readFileSync(join(here, '..', '.claude/workflows/dev-flow.js'), 'utf8');

const TARGET = { 'security-scope': securityScopeResponse({ target: true, head: null }) };
const sr = (status, counts = {}) => ({ target: true, status, rounds: 2, critical: 1, major: 0, minor: 0, ...counts });

async function run({ overrides = TARGET, iterate } = {}) {
  const workflowCalls = [];
  const { ctx, calls } = makeDevFlowSandbox({
    overrides,
    workflow: async (name, opts) => { workflowCalls.push({ name, opts }); return iterate; },
  });
  const { result, error } = await runWorkflowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'devflow-security-review');
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  return { result, calls, workflowCalls };
}
const codes = (result) => JSON.parse(JSON.stringify(result.merge_tier_hold_reasons.map((r) => r.code)));

test('[devflow-security-review] (a) Security floor の対象判定を nested pr-iterate の args.security_review で渡す', async () => {
  const { workflowCalls, calls } = await run({ iterate: { status: 'lgtm', fixes_applied: 0, security_review: sr('cleared', { critical: 0 }) } });
  assert.equal(workflowCalls.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(workflowCalls[0].opts.security_review)), { target: true, reasons: ['not_allowlisted:1'] });
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

test('[devflow-security-review] (b) Security floor が対象外でも pr-iterate が run 中に対象と判定して clear にしなければ HOLD、security_review を返さない pr-iterate も HOLD', async () => {
  const turned = await run({ overrides: {}, iterate: { status: 'security_unresolved', fixes_applied: 0, security_review: sr('unresolved') } });
  assert.ok(codes(turned.result).includes('security_review_unresolved'));
  const missing = await run({ iterate: { status: 'lgtm', fixes_applied: 0 } });
  assert.equal(missing.result.merge_tier, 'HOLD');
  assert.deepEqual(codes(missing.result), ['security_review_unresolved'], `Security floor が対象で pr-iterate の clear が無い: ${JSON.stringify(codes(missing.result))}`);
});

test('[devflow-security-review] (c) 対象で clear、または対象外の run は security_review_unresolved を積まない', async () => {
  const cleared = await run({ iterate: { status: 'lgtm', fixes_applied: 0, security_review: sr('cleared', { critical: 0 }) } });
  assert.equal(cleared.result.merge_tier, 'REVIEW');
  const notTarget = await run({ overrides: {}, iterate: { status: 'lgtm', fixes_applied: 0, security_review: { target: false, status: 'not_target', rounds: 0, critical: 0, major: 0, minor: 0 } } });
  assert.equal(notTarget.result.merge_tier, 'REVIEW');
  assert.equal(notTarget.result.security_review.target, false);
});

test('[devflow-security-review] (d) 終端サマリーの HOLD 理由には security review の回数と件数だけを出す', async () => {
  const { calls } = await run({ iterate: { status: 'max_reached', iterations: 10, fixes_applied: 3, security_review: sr('unresolved', { rounds: 3, critical: 1, major: 2 }) } });
  const body = calls.find((c) => c.label === 'post-summary').prompt;
  assert.ok(body.includes('security review が今の PR head で clear になっていない（敵対的 review 3 回・最終 critical 1 / major 2）'), body.slice(0, 3000));
  assert.ok(body.includes('codes=') && body.includes('security_review_unresolved'), 'HOLD marker に code が無い');
});
