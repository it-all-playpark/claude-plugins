// _lib/review-confidence-parity.test.mjs
// issue #561: EVAL/REVIEW schema の optional confidence invariant を pin する。
//
// schema は agent() の opts.schema として VM sandbox が記録する（makeRecordingSandbox の calls[].schema）ため、
// dev-flow.js / pr-iterate.js を実行して実際に dispatch された schema object を検証する
// （issue #636: `const EVAL = {` 等のソース切り出し + 文字列 pin から置換）。
//
// - AC-1: dev-flow.js の evaluator dispatch（eval#1）の schema が confidence を宣言する。
// - AC-2: dev-flow.js（lite route の pr-review-lite）と pr-iterate.js（review#1）の pr-reviewer dispatch の
//   schema が両方同一の confidence を宣言する（片方のみの追加を drift として fail させる）。
// - AC-3 前提: 上記 3 schema の required 配列に 'confidence' が含まれない
//   （StructuredOutput 契約違反 abort を起こさない optional 契約であること）。
// - AC-8: confidence は merge tier / gate policy / goal ledger のいずれの判定入力にもならない
//   （gate 非入力の静的 pin。_lib の純関数ソースに対する否定 pin）。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, makePrIterateSandbox, runWorkflowCapture, assertNoCrash } from './test-helpers/vm-sandbox.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const devFlowSrc = readFileSync(join(repoRoot, '.claude/workflows/dev-flow.js'), 'utf8');
const prIterateSrc = readFileSync(join(repoRoot, '.claude/workflows/pr-iterate.js'), 'utf8');

const CONFIDENCE_DECL = { type: 'number', minimum: 0, maximum: 1 };

// VM realm 越しの deepEqual は reference 比較で落ちるため JSON で比較する
function assertConfidenceOptional(schema, where) {
  assert.ok(schema && typeof schema === 'object', `${where}: schema が記録されていない`);
  assert.equal(
    JSON.stringify(schema.properties?.confidence),
    JSON.stringify(CONFIDENCE_DECL),
    `${where}: schema.properties.confidence が ${JSON.stringify(CONFIDENCE_DECL)} でない: ${JSON.stringify(schema.properties?.confidence)}`,
  );
  const required = Array.from(schema.required ?? []);
  assert.ok(!required.includes('confidence'), `${where}: required に confidence が含まれてはならない: ${JSON.stringify(required)}`);
}

// clean-micro-lite が成立する analyzeReq（lite-route-routing.test.mjs と同型）
const CLEAN_MICRO_REQ = {
  summary: 'clean micro fix', acceptance_criteria: ['a', 'b'], issue_type: 'fix', scope: 'src',
  breaking_change: false, breaking_keyword_scan: false,
  issue_number: 1, issue_title: 'stub-issue-title',
};

test('[review-confidence-parity] AC-1/AC-3: dev-flow.js の evaluator dispatch schema が optional confidence[0,1] を宣言する', async () => {
  const { ctx, calls } = makeDevFlowSandbox();
  const { error } = await runWorkflowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'eval');
  const ev = calls.find((c) => c.label === 'eval#1');
  assert.ok(ev, 'eval#1 が dispatch されていない');
  assertConfidenceOptional(ev.schema, 'dev-flow.js EVAL');
});

test('[review-confidence-parity] AC-2/AC-3: dev-flow.js（pr-review-lite）と pr-iterate.js（review#1）の pr-reviewer dispatch schema が同一の optional confidence[0,1] を宣言する', async () => {
  const df = makeDevFlowSandbox({
    overrides: {
      'analyze#1': CLEAN_MICRO_REQ,
      'plan#micro': { summary: 'p', serial: [] },
      'danger-grep': { risk: { ok: true, hits: [] }, files: [], struct: null, diffhash: null, secreview: { target: false, reasons: [] } },
      'ci-check-lite': { status: 'passed', passed: 1, failed: 0, pending: 0, skipped: 0, failed_checks: [], waited_seconds: 0, poll_attempts: 0 },
    },
  });
  const dfRun = await runWorkflowCapture(devFlowSrc, df.ctx);
  assertNoCrash(dfRun.error, 'lite');
  const lite = df.calls.find((c) => c.agentType === 'dev-flow:pr-reviewer');
  assert.ok(lite, `dev-flow.js で pr-reviewer が dispatch されていない（lite route 不成立）: ${df.calls.map((c) => c.label).join(', ')}`);
  assertConfidenceOptional(lite.schema, 'dev-flow.js REVIEW');

  const pi = makePrIterateSandbox();
  const piRun = await runWorkflowCapture(prIterateSrc, pi.ctx, '.claude/workflows/pr-iterate.js');
  assertNoCrash(piRun.error, 'pr-iterate');
  const review = pi.calls.find((c) => c.agentType === 'dev-flow:pr-reviewer');
  assert.ok(review, 'pr-iterate.js で pr-reviewer が dispatch されていない');
  assertConfidenceOptional(review.schema, 'pr-iterate.js REVIEW');

  assert.equal(
    JSON.stringify(lite.schema.properties.confidence),
    JSON.stringify(review.schema.properties.confidence),
    'dev-flow.js と pr-iterate.js の REVIEW schema の confidence 宣言が一致しない（drift）',
  );
});

test('[review-confidence-parity] AC-8: confidence は merge-tier / gate-policy / goal-ledger の判定入力（gate）に一切出現しない', () => {
  const gateFiles = ['_lib/merge-tier.mjs', '_lib/gate-policy.mjs', '_lib/goal-ledger.mjs'];
  for (const relPath of gateFiles) {
    const src = readFileSync(join(repoRoot, relPath), 'utf8');
    assert.doesNotMatch(
      src,
      /confidence/,
      `${relPath} に 'confidence' トークンが出現している（confidence は記録専用であり gate 判定入力になってはならない）`,
    );
  }
});
