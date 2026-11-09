// F2: review agent（review#i）が StructuredOutput 契約違反で throw / null を
// 返した場合の pr-iterate 側リカバリを pin する（issue #437）。
//   - throw も null も同一の「契約失敗」として扱い、同一 prompt で 1 回だけ schema-retry する
//   - retry で成功すれば通常経路へ完全合流する
//   - retry 後も失敗（throw/null）なら run 全体を落とさず status:'review_contract_error' で graceful 終了
//
// harness は test-helpers/vm-sandbox.mjs の makePrIterateSandbox / runWorkflowCapture。round 系 call の応答だけを
// buildAgentStub の rounds で返し、それ以外は pr-iterate 単体起動の既定 responder に任せる。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makePrIterateSandbox, runWorkflowCapture, assertNoCrash } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', '.claude/workflows/pr-iterate.js'), 'utf8');

/** buildAgentStub の戻り値（rounds と記録先 agentCalls）から pr-iterate.js の vm context を作る。 */
function makeSandbox({ rounds, agentCalls }) {
  return makePrIterateSandbox({ rounds, calls: agentCalls }).ctx;
}

const runPrIterate = (ctx) => runWorkflowCapture(src, ctx, '.claude/workflows/pr-iterate.js');

// reviewerStub(label) は throw も返す（契約違反の模擬）。commit-ensure は未応答（null）のまま。
function buildAgentStub({ reviewerStub, ciStub, fixStub, agentCalls }) {
  const rounds = ({ label, agentType, prompt }) => {
    if (agentType === 'dev-flow:pr-reviewer') {
      return reviewerStub(label);
    }
    if (agentType === 'dev-flow:dev-runner-haiku-ro' && prompt.includes('check-ci --pr ')) {
      return ciStub ? ciStub(label) : { status: 'passed', passed: 1, failed: 0, pending: 0, skipped: 0, failed_checks: [] };
    }
    if (label.startsWith('fix#')) {
      return fixStub ? fixStub(label) : { applied: true, summary: 'fixed', files: [] };
    }
    if (label.startsWith('commit-ensure#')) {
      return null;
    }
    return undefined;
  };
  return { rounds, agentCalls };
}

// ---- T1: review#1 が throw、schema-retry が成功 -> 通常経路合流、review_null_retries=1 ----
test('[T1] review#1 throw -> review#1-schema-retry 成功 -> pr-reviewer 2回、lgtm、review_null_retries=1', async () => {
  const agentCalls = [];
  const reviewerStub = (label) => {
    if (label === 'review#1') throw new Error('StructuredOutput 契約違反');
    if (label === 'review#1-schema-retry') return { decision: 'approve', issues: [], summary: 'ok' };
    throw new Error(`unexpected pr-reviewer label: ${label}`);
  };
  const agentStub = buildAgentStub({ reviewerStub, agentCalls });
  const ctx = makeSandbox(agentStub);
  const { result, error } = await runPrIterate(ctx);
  assertNoCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

  const reviewerCalls = agentCalls.filter((c) => c.agentType === 'dev-flow:pr-reviewer');
  assert.equal(reviewerCalls.length, 2, `pr-reviewer 呼び出しは 2 回（review#1 + schema-retry）であるべきだが ${reviewerCalls.length} 回だった`);
  assert.ok(reviewerCalls.some((c) => c.label === 'review#1'), 'review#1 が呼ばれるべき');
  assert.ok(reviewerCalls.some((c) => c.label === 'review#1-schema-retry'), 'review#1-schema-retry が呼ばれるべき');

  assert.equal(result?.status, 'lgtm', `result.status は lgtm であるべきだが '${result?.status}' だった`);
  assert.equal(result?.review_null_retries, 1, `review_null_retries は 1 であるべきだが ${result?.review_null_retries} だった`);
});

// ---- T2: review#1 が throw、schema-retry も throw -> graceful 終了（無限ループ・run 例外終了なし）----
test('[T2] review#1 throw -> review#1-schema-retry も throw -> error null、pr-reviewer 2回のみ、status:review_contract_error', async () => {
  const agentCalls = [];
  const reviewerStub = (label) => {
    if (label === 'review#1' || label === 'review#1-schema-retry') {
      throw new Error('StructuredOutput 契約違反');
    }
    throw new Error(`unexpected pr-reviewer label (should not go past schema-retry): ${label}`);
  };
  const agentStub = buildAgentStub({ reviewerStub, agentCalls });
  const ctx = makeSandbox(agentStub);
  const { result, error } = await runPrIterate(ctx);
  assertNoCrash(error);
  assert.equal(error, null, `run 全体が例外終了してはならないが error が発生: ${error?.name}: ${error?.message}`);

  const reviewerCalls = agentCalls.filter((c) => c.agentType === 'dev-flow:pr-reviewer');
  assert.equal(reviewerCalls.length, 2, `pr-reviewer 呼び出しはちょうど 2 回（無限ループしない）であるべきだが ${reviewerCalls.length} 回だった`);

  const fixCalls = agentCalls.filter((c) => c.label.startsWith('fix#'));
  assert.equal(fixCalls.length, 0, `fix# は 0 回であるべきだが ${fixCalls.length} 回だった`);

  const ciCalls = agentCalls.filter((c) => c.prompt.includes('check-ci --pr '));
  assert.equal(ciCalls.length, 0, `ci-check は 0 回であるべきだが ${ciCalls.length} 回だった`);

  assert.equal(result?.status, 'review_contract_error', `result.status は review_contract_error であるべきだが '${result?.status}' だった`);

  const postSummary = agentCalls.find((c) => c.label === 'post-summary');
  assert.ok(postSummary != null, 'post-summary の呼び出しが存在するべき（graceful 終了でも終端投稿は行われる）');

  const journalLog = agentCalls.find((c) => c.label === 'journal-log');
  assert.ok(journalLog != null, 'journal-log の呼び出しが存在するべき（graceful 終了でも telemetry は記録される）');
});

// ---- T3: review#1 が null を返し続ける（throw ではなく null）-> T2 と同じ graceful 経路 ----
// pr-reviewer は model override を渡さないため trackedAgent の quality model fallback（`opts.model` 付き
// call のみ）は通らず、null は callReviewAgent の schema-retry（別 label）だけで再試行される。
// pr-reviewer は review#1 / review#1-schema-retry の 2 回で打ち切られる。
test('[T3] review#1 が null を返し続ける(throwでなくnull) -> schema-retry 1 回で graceful 終了、status:review_contract_error', async () => {
  const agentCalls = [];
  const reviewerStub = () => null;
  const agentStub = buildAgentStub({ reviewerStub, agentCalls });
  const ctx = makeSandbox(agentStub);
  const { result, error } = await runPrIterate(ctx);
  assertNoCrash(error);
  assert.equal(error, null, `run 全体が例外終了してはならないが error が発生: ${error?.name}: ${error?.message}`);

  const reviewerCalls = agentCalls.filter((c) => c.agentType === 'dev-flow:pr-reviewer');
  assert.deepEqual(
    reviewerCalls.map((c) => c.label),
    ['review#1', 'review#1-schema-retry'],
    `pr-reviewer 呼び出しは review#1 + schema-retry の 2 回（model fallback の同一 label 再試行は無い・無限ループしない）であるべきだが ${JSON.stringify(reviewerCalls.map((c) => c.label))} だった`,
  );

  assert.equal(result?.status, 'review_contract_error', `result.status は review_contract_error であるべきだが '${result?.status}' だった`);
});

// ---- T5 回帰: 正常経路（throw/null なし）で schema-retry ラベル呼び出し 0 回、review_null_retries=0 ----
test('[T5 回帰] 正常経路(review#1 approve+issues:[])では schema-retry 呼び出し 0 回、review_null_retries=0', async () => {
  const agentCalls = [];
  const reviewerStub = () => ({ decision: 'approve', issues: [], summary: 'ok' });
  const agentStub = buildAgentStub({ reviewerStub, agentCalls });
  const ctx = makeSandbox(agentStub);
  const { result, error } = await runPrIterate(ctx);
  assertNoCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

  const schemaRetryCalls = agentCalls.filter((c) => c.label.includes('schema-retry'));
  assert.equal(schemaRetryCalls.length, 0, `schema-retry 呼び出しは 0 回であるべきだが ${schemaRetryCalls.length} 回だった`);

  assert.equal(result?.status, 'lgtm', `result.status は lgtm であるべきだが '${result?.status}' だった`);
  assert.equal(result?.review_null_retries, 0, `review_null_retries は 0 であるべきだが ${result?.review_null_retries} だった`);
});
