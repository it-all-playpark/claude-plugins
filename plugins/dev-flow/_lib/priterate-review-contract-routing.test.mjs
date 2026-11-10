// F3: pr-iterate の review 経路（blocking 件数）route ベース再構成の routing test（issue #321, #1283）
// classifyReviewRoute（_lib/review-normalize.mjs）ベースの分岐を pin する:
//   - blocking 0 件 → ci_gate（decision に依らず fix agent を起動しない）
//   - approve + blocking あり → 再 review せず fix loop へ（decision は表示・記録専用。history には approve のまま残る）
//   - minor findings は fix loop を起動しないが終端サマリーに保持される（issue #392 で per-round 投稿は廃止・終端 post-summary へ統合）
//   - 既存正常経路（approve→CI gate、request-changes→fix loop）は不変（AC-6 回帰）
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

/**
 * round 系 call の応答を label で分岐する rounds と、呼び出しの記録先 agentCalls を返す。
 * reviewerStub(label) -> review result（pr-reviewer 呼び出しごとに呼ばれる）
 * ciStub(label) -> CI status result（省略時は常に passed）
 * fixStub(label) -> fix result（省略時は常に applied:true）
 * commit-ensure（issue #437: fix 適用直後の commit 保証）は「commit 対象なし」で通す
 */
function buildAgentStub({ reviewerStub, ciStub, fixStub, agentCalls }) {
  const rounds = ({ label, agentType, prompt }) => {
    if (agentType === 'dev-flow:pr-reviewer') {
      return reviewerStub(label);
    }
    if (agentType === 'dev-flow:stdout-relay' && prompt.includes('check-ci --pr ')) {
      return ciStub ? ciStub(label) : { status: 'passed', passed: 1, failed: 0, pending: 0, skipped: 0, failed_checks: [] };
    }
    if (label.startsWith('fix#')) {
      return fixStub ? fixStub(label) : { applied: true, summary: 'fixed', files: [] };
    }
    if (label.startsWith('commit-ensure#')) {
      return { dirty: false, committed: false, pushed: false };
    }
    return undefined;
  };
  return { rounds, agentCalls };
}

// ---- (1) [AC-1] comment + minor 1 件のみ -> fix agent を起動せず CI gate へ進み lgtm ----
test('[AC-1] comment decision + minor 1 件のみ(blocking 0件) -> fix# 起動なし、ci-check 実行、lgtm', async () => {
  const agentCalls = [];
  const reviewerStub = () => ({
    decision: 'comment',
    issues: [{ severity: 'minor', topic: 'm1', file: 'a.ts', description: 'minor-desc-ac1', suggestion: 'minor-sugg-ac1' }],
    summary: 'ok',
  });
  const agentStub = buildAgentStub({ reviewerStub, agentCalls });
  const ctx = makeSandbox(agentStub);
  const { result, error } = await runPrIterate(ctx);
  assertNoCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

  const ciCalls = agentCalls.filter((c) => c.prompt.includes('check-ci --pr '));
  assert.ok(ciCalls.length > 0, 'ci-check（check-ci.sh）が呼ばれるべき');

  const fixCalls = agentCalls.filter((c) => c.label.startsWith('fix#'));
  assert.equal(fixCalls.length, 0, `fix# は 0 回であるべきだが ${fixCalls.length} 回呼ばれた`);

  assert.equal(result?.status, 'lgtm', `status は lgtm であるべきだが '${result?.status}' だった`);
});

// ---- (2) [AC-2] request-changes + issues:[] -> fix agent を起動せず CI gate へ進み lgtm ----
test('[AC-2] request-changes decision + issues:[](blocking 0件) -> fix# 起動なし、ci-check 実行、lgtm', async () => {
  const agentCalls = [];
  const reviewerStub = () => ({ decision: 'request-changes', issues: [], summary: 'ok-empty' });
  const agentStub = buildAgentStub({ reviewerStub, agentCalls });
  const ctx = makeSandbox(agentStub);
  const { result, error } = await runPrIterate(ctx);
  assertNoCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

  const ciCalls = agentCalls.filter((c) => c.prompt.includes('check-ci --pr '));
  assert.ok(ciCalls.length > 0, 'ci-check（check-ci.sh）が呼ばれるべき');

  const fixCalls = agentCalls.filter((c) => c.label.startsWith('fix#'));
  assert.equal(fixCalls.length, 0, `fix# は 0 回であるべきだが ${fixCalls.length} 回呼ばれた`);

  assert.equal(result?.status, 'lgtm', `status は lgtm であるべきだが '${result?.status}' だった`);
});

// ---- (3) approve + blocking の同居: 再 review せず blocking 件数だけで fix loop に送る（issue #1283）----
// review#1 = approve + major 1 件、fix 後の review#2 = approve + issues:[]
function approveWithMajorReviewer() {
  const majorIssue = { severity: 'major', topic: 't1', file: 'a.ts', description: 'd1', suggestion: 's1' };
  return (label) => {
    if (label === 'review#1') return { decision: 'approve', issues: [majorIssue], summary: 'approve-with-major' };
    if (label === 'review#2') return { decision: 'approve', issues: [], summary: 'ok-round2' };
    throw new Error(`unexpected pr-reviewer label: ${label}`);
  };
}

test('[#1283 AC-2] approve + major 1 件 -> 再 review せず fix#1 を 1 回起動し、fix 後の review#2 が approve + issues:[] なら lgtm', async () => {
  const agentCalls = [];
  const agentStub = buildAgentStub({ reviewerStub: approveWithMajorReviewer(), agentCalls });
  const ctx = makeSandbox(agentStub);
  const { result, error } = await runPrIterate(ctx);
  assertNoCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

  const reviewerLabels = agentCalls.filter((c) => c.agentType === 'dev-flow:pr-reviewer').map((c) => c.label);
  assert.deepEqual(reviewerLabels, ['review#1', 'review#2'], `iteration 1 の pr-reviewer 呼び出しは review#1 だけであるべき。labels: ${reviewerLabels.join(', ')}`);

  const fixLabels = agentCalls.filter((c) => c.label.startsWith('fix#')).map((c) => c.label);
  assert.deepEqual(fixLabels, ['fix#1'], `fix# は fix#1 の 1 回だけであるべき。labels: ${fixLabels.join(', ')}`);

  assert.equal(result?.status, 'lgtm', `result.status は lgtm であるべきだが '${result?.status}' だった`);
});

test('[#1283 AC-3] approve + major 1 件の round の history は reviewer が返した decision=approve を保持し blocking 1 件を残す', async () => {
  const agentCalls = [];
  const agentStub = buildAgentStub({ reviewerStub: approveWithMajorReviewer(), agentCalls });
  const ctx = makeSandbox(agentStub);
  const { result, error } = await runPrIterate(ctx);
  assertNoCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

  const round1 = (result?.history ?? []).find((h) => h.iteration === 1);
  assert.ok(round1 != null, `history に iteration 1 のエントリがあるべき。history: ${JSON.stringify(result?.history)}`);
  assert.equal(round1.decision, 'approve', `iteration 1 の decision は reviewer が返した approve のままであるべきだが '${round1.decision}' だった`);
  assert.equal(round1.blocking.length, 1, `iteration 1 の blocking は 1 件であるべきだが ${round1.blocking.length} 件だった`);
});

// ---- (5) [AC-5] minor findings は消えず終端サマリーに保持される（issue #392 で per-round 投稿は廃止・終端 post-summary へ統合）----
test('[AC-5] minor findings が終端 post-summary の本文に保持される（fix loop 対象外、per-round 投稿なし）', async () => {
  const agentCalls = [];
  const reviewerStub = () => ({
    decision: 'comment',
    issues: [{ severity: 'minor', topic: 'm1', file: 'a.ts', description: 'minor-desc-ac5-unique', suggestion: 'minor-sugg-ac5-unique' }],
    summary: 'ok',
  });
  const agentStub = buildAgentStub({ reviewerStub, agentCalls });
  const ctx = makeSandbox(agentStub);
  const { result, error } = await runPrIterate(ctx);
  assertNoCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);
  assert.equal(result?.status, 'lgtm', `前提: lgtm であるべきだが '${result?.status}' だった`);

  // per-round の post-review#i が無いこと（issue #392 AC-1）の否定検証は priterate-terminal-telemetry.test.mjs が持つ
  const postSummary = agentCalls.find((c) => c.label === 'post-summary');
  assert.ok(postSummary != null, 'post-summary の呼び出しが存在するべき');
  assert.ok(
    postSummary.prompt.includes('minor-desc-ac5-unique'),
    `post-summary の prompt に minor description が含まれるべき。先頭1200文字: ${postSummary.prompt.slice(0, 1200)}`,
  );
});

// ---- (6) [AC-6 回帰・その1] 通常 approve -> CI gate -> lgtm ----
test('[AC-6 回帰] approve + issues:[] + CI passed -> lgtm（既存正常経路不変）', async () => {
  const agentCalls = [];
  const reviewerStub = () => ({ decision: 'approve', issues: [], summary: 'ok' });
  const agentStub = buildAgentStub({ reviewerStub, agentCalls });
  const ctx = makeSandbox(agentStub);
  const { result, error } = await runPrIterate(ctx);
  assertNoCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

  assert.equal(result?.status, 'lgtm', `result.status は lgtm であるべきだが '${result?.status}' だった`);
});

// ---- (6b) [AC-6 回帰・その2] request-changes + blocking -> fix loop 継続（既存正常経路不変）----
test('[AC-6 回帰] request-changes + [major](topic毎回ユニーク) -> fix# 起動、applied:true で反復継続', async () => {
  const agentCalls = [];
  let round = 0;
  const reviewerStub = () => {
    round += 1;
    if (round === 1) {
      return {
        decision: 'request-changes',
        issues: [{ severity: 'major', topic: `t-round-${round}`, file: 'a.ts', description: `d${round}`, suggestion: `s${round}` }],
        summary: 'ng',
      };
    }
    return { decision: 'approve', issues: [], summary: 'ok' };
  };
  const agentStub = buildAgentStub({ reviewerStub, agentCalls });
  const ctx = makeSandbox(agentStub);
  const { result, error } = await runPrIterate(ctx);
  assertNoCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

  const fixCalls = agentCalls.filter((c) => c.label.startsWith('fix#'));
  assert.ok(fixCalls.length >= 1, `fix# が少なくとも 1 回呼ばれるべきだが ${fixCalls.length} 回だった`);
  assert.equal(result?.status, 'lgtm', `result.status は lgtm であるべきだが '${result?.status}' だった`);
  assert.equal(result?.fixes_applied, 1, `fixes_applied は 1 であるべきだが ${result?.fixes_applied} だった`);
});

// ---- (7) [AC-6 回帰・その3] approve + issues:[] だが CI failed -> CI fix agent は従来どおり起動する ----
test('[AC-6 回帰] approve + issues:[] だが CI failed -> CI gate 内の fix agent は従来どおり起動する', async () => {
  const agentCalls = [];
  const reviewerStub = () => ({ decision: 'approve', issues: [], summary: 'ok' });
  let ciCallCount = 0;
  const ciStub = () => {
    ciCallCount += 1;
    if (ciCallCount === 1) {
      return { status: 'failed', passed: 0, failed: 1, pending: 0, skipped: 0, failed_checks: [{ name: 'bats', bucket: 'test', state: 'failure' }] };
    }
    return { status: 'passed', passed: 1, failed: 0, pending: 0, skipped: 0, failed_checks: [] };
  };
  const agentStub = buildAgentStub({ reviewerStub, ciStub, agentCalls });
  const ctx = makeSandbox(agentStub);
  const { result, error } = await runPrIterate(ctx);
  assertNoCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

  const fixCalls = agentCalls.filter((c) => c.label.startsWith('fix#'));
  assert.ok(fixCalls.length >= 1, `CI failed の修正 fix# が少なくとも 1 回呼ばれるべきだが ${fixCalls.length} 回だった`);
  assert.equal(result?.status, 'lgtm', `result.status は lgtm であるべきだが '${result?.status}' だった`);
});

// ---- (8) [ci_gate 投稿] request-changes+blocking0+CI passed の終端投稿に --approve が含まれない（approve 捏造禁止。issue #392 で投稿は終端 post-summary 1 本に統合）----
test('[ci_gate 投稿] request-changes decision + blocking 0 + CI passed の post-summary prompt に --approve が含まれない', async () => {
  const agentCalls = [];
  const reviewerStub = () => ({ decision: 'request-changes', issues: [], summary: 'ok-empty' });
  const agentStub = buildAgentStub({ reviewerStub, agentCalls });
  const ctx = makeSandbox(agentStub);
  const { result, error } = await runPrIterate(ctx);
  assertNoCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);
  assert.equal(result?.status, 'lgtm', `前提: lgtm であるべきだが '${result?.status}' だった`);

  // per-round の post-review#i が無いこと（issue #392 AC-1）の否定検証は priterate-terminal-telemetry.test.mjs が持つ
  const postSummary = agentCalls.find((c) => c.label === 'post-summary');
  assert.ok(postSummary != null, 'post-summary の呼び出しが存在するべき');
  assert.ok(
    !postSummary.prompt.includes('--approve'),
    `post-summary の prompt に --approve を含めてはならない（reviewer が approve していないため blockingCount=0 でも terminalReviewAction は comment に落ちる）。先頭800文字: ${postSummary.prompt.slice(0, 800)}`,
  );
});
