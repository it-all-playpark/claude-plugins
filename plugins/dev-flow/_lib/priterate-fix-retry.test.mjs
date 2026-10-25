// pr-iterate の fix agent 呼び出し（callFixAgent）と fixes_applied カウンタを fixSequence の表で pin する。
//   - fix の技術的失敗（null / throw = StructuredOutput 契約違反等の harness 例外）は同一 findings・同一 prompt で
//     1 回だけ retry し（fix#i-retry）、retry 後も失敗なら run を abort させず status:'fix_failed' で終わる
//     （issue #347 null / #520 throw。callReviewAgent と対称）
//   - fix.applied===false（agent の明示判断）は retry せず即時 fix_failed。throw の retry が applied:false を返しても再 retry しない
//   - fixes_applied は fix.applied===true の累積回数（dev-flow が stale-eval 警告の判定に使う。issue #233）
//   - fix#i / fix#i-retry は専用 agent pr-fixer で起動し、opts で model / effort を渡さない（frontmatter の
//     opus / medium / maxTurns 100 で決める。frontmatter は agent-frontmatter.test.mjs が pin）
//
// harness は test-helpers/vm-sandbox.mjs の makePrIterateSandbox / prIterateRounds / runWorkflowCapture。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makePrIterateSandbox, prIterateRounds, runWorkflowCapture, assertNoCrash } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const src = readFileSync(join(repoRoot, '.claude/workflows/pr-iterate.js'), 'utf8');

const MAJOR = { decision: 'request-changes', issues: [{ severity: 'major', topic: 't1', description: 'd', suggestion: 's' }], summary: 'ng' };
const APPROVE = { decision: 'approve', issues: [], summary: 'ok' };
const REVIEWERS = {
  approve: () => APPROVE,
  // round 1 だけ request-changes、round 2 以降 approve
  once: (round) => (round === 1 ? MAJOR : APPROVE),
  always: () => MAJOR,
};
const CI_FAIL_ONCE = [
  { status: 'failed', passed: 0, failed: 1, pending: 0, skipped: 0, failed_checks: [{ name: 'bats', bucket: 'fail', state: 'failure' }] },
  { status: 'passed', passed: 1, failed: 0, pending: 0, skipped: 0, failed_checks: [] },
];
const THROW = () => { throw new Error('agent finished without calling StructuredOutput'); };
const APPLIED = { applied: true, summary: 'fixed' };
const NOT_APPLIED = { applied: false, summary: 'no' };
const EXPECTED_FIX_OPTS = [
  { label: 'fix#1', agentType: 'dev-flow:pr-fixer', hasModel: false, hasEffort: false },
  { label: 'fix#1-retry', agentType: 'dev-flow:pr-fixer', hasModel: false, hasEffort: false },
];

// name, reviewer, ci（省略時は常に passed）, fixSequence, 期待値
//   fixCalls: fix agent の label 列 / fixes / retries: fixes_applied / fix_null_retries / iterations /
//   retried: history の iteration 1 の fix_retried / fixOpts: fix agent の opts（label / agentType / model・effort キーの有無）
const CASES = [
  { name: '(A) round 1 approve → fix なし', reviewer: 'approve', fix: [],
    want: { status: 'lgtm', iterations: 1, fixes: 0, fixCalls: [] } },
  { name: '(B) round 1 request-changes → fix applied → round 2 approve', reviewer: 'once', fix: [APPLIED],
    want: { status: 'lgtm', iterations: 2, fixes: 1, fixCalls: ['fix#1'] } },
  { name: '(1) review 分岐: fix null → retry 成功', reviewer: 'once', fix: [null, APPLIED],
    want: { status: 'lgtm', fixes: 1, retries: 1, fixCalls: ['fix#1', 'fix#1-retry'], retried: true, fixOpts: EXPECTED_FIX_OPTS } },
  { name: '(2) review 分岐: fix null → retry も null → retry 上限 1 回で fix_failed', reviewer: 'always', fix: [null, null],
    want: { status: 'fix_failed', fixes: 0, retries: 1, fixCalls: ['fix#1', 'fix#1-retry'] } },
  { name: '(3) review 分岐: fix applied:false → retry なし即時 fix_failed', reviewer: 'always', fix: [NOT_APPLIED],
    want: { status: 'fix_failed', fixes: 0, retries: 0, fixCalls: ['fix#1'] } },
  { name: '(4) CI-failed 分岐: fix null → retry 成功', reviewer: 'approve', ci: CI_FAIL_ONCE, fix: [null, APPLIED],
    want: { status: 'lgtm', retries: 1, fixCalls: ['fix#1', 'fix#1-retry'] } },
  { name: '(T1) fix throw → retry 成功', reviewer: 'once', fix: [THROW, APPLIED],
    want: { status: 'lgtm', fixes: 1, retries: 1, fixCalls: ['fix#1', 'fix#1-retry'], retried: true, fixOpts: EXPECTED_FIX_OPTS } },
  { name: '(T2) fix throw → retry も throw → 無限 retry せず fix_failed', reviewer: 'always', fix: [THROW, THROW],
    want: { status: 'fix_failed', fixes: 0, retries: 1, fixCalls: ['fix#1', 'fix#1-retry'] } },
  { name: '(T5) fix throw → retry が applied:false → 再 retry せず fix_failed', reviewer: 'always', fix: [THROW, NOT_APPLIED],
    want: { status: 'fix_failed', retries: 1, fixCalls: ['fix#1', 'fix#1-retry'] } },
];

test.each(CASES)('[fix-retry] $name', async ({ reviewer, ci, fix, want }) => {
  const { ctx, calls } = makePrIterateSandbox({
    rounds: prIterateRounds({
      reviewer: REVIEWERS[reviewer],
      fix,
      ci,
      // fix 適用直後の commit 保証（issue #437）は「commit 対象なし」で通す
      commitEnsure: { dirty: false, committed: false, pushed: false },
    }),
  });
  const { result, error } = await runWorkflowCapture(src, ctx, '.claude/workflows/pr-iterate.js');
  assertNoCrash(error, 'priterate-fix-retry');
  assert.equal(error, null, `run 全体が例外終了してはならないが error が発生: ${error?.name}: ${error?.message}`);

  const fixCallsMade = calls.filter((c) => c.label.startsWith('fix#'));
  assert.equal(result?.status, want.status, `status は ${want.status} であるべきだが '${result?.status}' だった`);
  assert.deepEqual(fixCallsMade.map((c) => c.label), want.fixCalls, `fix agent の呼び出し列が想定と違う`);
  if ('iterations' in want) assert.equal(result?.iterations, want.iterations, `iterations は ${want.iterations} であるべきだが ${result?.iterations} だった`);
  if ('fixes' in want) assert.equal(result?.fixes_applied, want.fixes, `fixes_applied は ${want.fixes} であるべきだが ${result?.fixes_applied} だった`);
  if ('retries' in want) assert.equal(result?.fix_null_retries, want.retries, `fix_null_retries は ${want.retries} であるべきだが ${result?.fix_null_retries} だった`);
  if ('retried' in want) {
    const iter1 = result?.history?.find((h) => h.iteration === 1);
    assert.ok(iter1, 'history に iteration 1 のエントリが存在するべき');
    assert.equal(iter1?.fix_retried, want.retried, `iteration 1 の history エントリの fix_retried は ${want.retried} であるべきだが ${iter1?.fix_retried} だった`);
  }
  if ('fixOpts' in want) {
    const fixOpts = fixCallsMade.map((c) => ({ label: c.label, agentType: c.agentType, hasModel: 'model' in c.opts, hasEffort: 'effort' in c.opts }));
    assert.deepEqual(fixOpts, want.fixOpts, `fix agent の opts が想定と違う: ${JSON.stringify(fixOpts)}`);
  }
});
