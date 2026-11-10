// dev-implementer.md / evaluator.md / dev-runner*.md は sandbox write-deny のため、Turbopack fallback
// 規約は dev-flow.js が全 implementer/evaluator/dev-runner spawn prompt に注入する（issue #292）。
//
// 注入可否は Setup が args.setup.stack.frameworks（prerun の detect-stack）で決定論的に決め、
// 対象 repo が Next.js（frameworks に 'next'）のときのみ TURBOPACK_NOTE に本文をセットする（issue #635。
// LLM に適用可否を判定させない）。Next.js 判定そのものと標準経路（implementer / evaluator。test は注入しない）の
// 注入有無は turbopack-stack-gate-routing.test.mjs が担う。
//
// このテストは dev-flow.js を VM で実行し、分岐経路（Validate red→green-fix / Evaluate implementation 差し戻し
// fix#i）でも規約の識別トークン（error 名 `TurbopackInternalError` と fallback コマンド `next build --webpack`）が
// verbatim 到達し、Next.js 非検出時はどの経路にも現れないことで観測する
// （issue #636: 識別子出現回数・区間切り出し・定義文字列のキーワード pin を VM 挙動へ置換）。
// 標準経路（implementer / eval#1 に含まれ test#1 には含まれない。issue #821）は turbopack-stack-gate-routing.test.mjs (a)。
//   (2) Next.js 検出: green-fix#1 の prompt にトークンが含まれる
//   (3) Next.js 検出: fix#1 の prompt にトークンが含まれる
//   (2')(3') Next.js 非検出: green-fix#1 / fix#1 の prompt にトークンが含まれない
//   (4) 定義が inline 生成区間外（最後の END inline マーカーより後）にあること（inline 区間整合）

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash, devFlowArgs, shapeOverrides } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', '.claude/workflows/dev-flow.js'), 'utf8');

const TOKENS = ['TurbopackInternalError', 'next build --webpack'];
const NEXT_FRAMEWORKS = ['next'];
const REACT_FRAMEWORKS = ['react'];

function assertTokens(call, label, expected) {
  assert.ok(call != null, `label === '${label}' の call が見つからない`);
  for (const t of TOKENS) {
    assert.equal(
      call.prompt.includes(t),
      expected,
      `${label} の prompt に Turbopack fallback 規約のトークン '${t}' が${expected ? '含まれない（Next.js 検出時は注入されるべき）' : '含まれている（Next.js 非検出時は注入しない）'}`,
    );
  }
}

const GREEN_FIX = { 'test#1': { tests: 'failed', green: false, summary: 'assert mismatch' } };
const AC2 = [
  { ac_index: 0, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
  { ac_index: 1, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
];
// complex 経路（realized 7 件）で eval#1 critical → reimpl#1 → eval#2 収束
const EVAL_FIX = {
  'analyze#1': {
    summary: 's', acceptance_criteria: ['a', 'b'], issue_type: 'feat', scope: 'src',
    issue_number: 1, issue_title: 'stub-issue-title',
  },
  ...shapeOverrides('complex'),
  'eval#1': {
    verdict: 'fail', total: 5, threshold: 7,
    feedback: [{ severity: 'critical', topic: 'X', description: '重大欠陥', suggestion: '修正せよ' }],
    feedback_level: 'implementation', ac_results: AC2, security_clearance: [],
  },
  'eval#2': {
    verdict: 'pass', total: 9, threshold: 7, feedback: [], feedback_level: 'implementation',
    ac_results: AC2, security_clearance: [],
    critical_resolutions: [{ id: 'EVAL-1-X', resolved: true, evidence: 'src/x.ts で修正済み' }],
  },
};

async function run(overrides, frameworks, name) {
  const { ctx, calls } = makeDevFlowSandbox({ overrides, extra: { args: devFlowArgs(1, { stack: { frameworks } }) } });
  const { error } = await runWorkflowCapture(src, ctx);
  assertNoCrash(error, name);
  return calls;
}

// (2)(2') Validate red→green-fix 経路
test('[turbopack-fallback] green-reimpl#1 prompt: Next.js 検出時は規約トークンが含まれ、非検出時は含まれない', async () => {
  const next = await run(GREEN_FIX, NEXT_FRAMEWORKS, 'next-greenfix');
  assertTokens(next.find((c) => c.label === 'green-fix#1'), 'green-fix#1', true);
  const react = await run(GREEN_FIX, REACT_FRAMEWORKS, 'react-greenfix');
  assertTokens(react.find((c) => c.label === 'green-fix#1'), 'green-fix#1', false);
});

// (3)(3') Evaluate implementation 差し戻し経路
test('[turbopack-fallback] reimpl#1 prompt: Next.js 検出時は規約トークンが含まれ、非検出時は含まれない', async () => {
  const next = await run(EVAL_FIX, NEXT_FRAMEWORKS, 'next-fix');
  assertTokens(next.find((c) => c.label === 'reimpl#1:serial:issue-1'), 'reimpl#1:serial:issue-1', true);
  const react = await run(EVAL_FIX, REACT_FRAMEWORKS, 'react-fix');
  assertTokens(react.find((c) => c.label === 'reimpl#1:serial:issue-1'), 'reimpl#1:serial:issue-1', false);
});

// (4) 定義が inline 生成区間外にあること（inline 生成区間の整合 — sync-inlines が上書きする区間に
//     手書き定数を置くと次回 --write で消える）
test('[turbopack-fallback] 定数定義が inline 生成区間外（最後の END inline マーカーより後）にある', () => {
  const defIndex = src.indexOf('const TURBOPACK_FALLBACK_CONVENTION');
  assert.ok(defIndex !== -1, 'TURBOPACK_FALLBACK_CONVENTION の定義が見つからない');
  const lastEndIdx = src.lastIndexOf('// ==== END inline:');
  assert.ok(lastEndIdx !== -1, 'dev-flow.js に END inline マーカーが見つからない');
  assert.ok(defIndex > lastEndIdx, `TURBOPACK_FALLBACK_CONVENTION の定義（index ${defIndex}）が最後の END inline マーカー（index ${lastEndIdx}）より前にある — inline 生成区間内への誤配置の疑い`);
});
