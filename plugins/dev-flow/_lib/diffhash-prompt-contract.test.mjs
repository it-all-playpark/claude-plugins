// _lib/diffhash-prompt-contract.test.mjs
// dhPrompt（diff-hash exec-proxy prompt。diff-hash-eval / diff-hash-pr / diff-hash-merge が共有する
// state.dhPrompt）の argv 転写契約を、実際に agent() へ渡る prompt を VM run で捕捉して検証する
// （issue #636 P3b）。
//
// 旧版は dev-flow.js から dhPrompt のソース block を readFileSync + slice で抽出し、
// 'bare 単文' / '先頭トークンが…' 等の日本語の指示文・規約文を部分一致で pin していた。
// これらは言い回し変更のみで落ちる pin だったため、VM sandbox で実際に diff-hash* call に渡る
// prompt を捕捉し、argv token（(a)）・否定側（(b)(c)）・agentType（(d)）で検証する形に置換した。
//
// Run: npx vitest run _lib/diffhash-prompt-contract.test.mjs
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeRecordingSandbox, runWorkflowCapture, assertNoCrash } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');
const devFlowSrc = readFileSync(devFlowPath, 'utf8');

// standard に落ちる req（count=3 ≤ 5, ac.length=2 ≤ 6, type=fix → floor='standard'）
const STANDARD_REQ = {
  summary: 's',
  acceptance_criteria: ['a', 'b'],
  issue_type: 'fix',
  scope: 'src',
  issue_number: 1,
  issue_title: 'stub-issue-title',
};

// ============================================================
// responder: hash-reconverged-routing.test.mjs の createResponder パターンを踏襲。
// diff-hash-eval / diff-hash-pr / diff-hash-merge の 3 call を全て発火させるため、
// danger-grep は diffhash フィールドを返し（state.secDiffHash を非 null にする）、
// evaluator は AC 全 satisfied で 1 パス収束、test は常時 passed にする。
// ============================================================
function createResponder() {
  return function ({ label, agentType }) {
    if (label === 'worktree') return { worktree: '/tmp/wt', branch: 'feature/issue-1' };
    if (label.startsWith('analyze')) return STANDARD_REQ;
    if (label === 'danger-grep') return { risk: { ok: true, hits: [] }, files: ['src/x.ts'], struct: null, diffhash: { hash: 'H', empty: false } };
    if (agentType === 'dev-flow:evaluator') {
      return {
        verdict: 'pass', total: 100, threshold: 80, feedback: [],
        feedback_level: 'implementation',
        ac_results: [
          { ac_index: 0, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
          { ac_index: 1, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
        ],
        security_clearance: [],
      };
    }
    if (label.startsWith('pr')) return { pr_url: 'http://x', pr_number: 1, committed: true };
    if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) return { hash: 'H', empty: false };
    if (agentType === 'dev-flow:dev-implementer') return { status: 'DONE', task_id: 't', files: ['src/x.ts'], summary: 's', concerns: [] };
    if (label.startsWith('test')) return { tests: 'passed', green: true, summary: '' };
    if (label === 'post-summary') return { posted: true, method: 'gh pr comment', url: 'http://x' };
    if (label === 'journal-log') return { logged: true, summary: 'ok' };
    return null;
  };
}

// ============================================================
// 共有実行（全テストが同じ sandbox 実行結果を参照するため）
// ============================================================

let sharedCalls = null;
let sharedError = null;

async function ensureSharedRun() {
  if (sharedCalls !== null) return;
  const { ctx, calls } = makeRecordingSandbox(createResponder());
  const { error } = await runWorkflowCapture(devFlowSrc, ctx);
  sharedCalls = calls;
  sharedError = error;
}

test('[diffhash-prompt-contract] crash guard: dev-flow.js が sandbox で ReferenceError / SyntaxError を throw しない', async () => {
  await ensureSharedRun();
  assertNoCrash(sharedError);
});

test('[diffhash-prompt-contract] sanity: label が diff-hash で始まる call が 1 回以上発生する', async () => {
  await ensureSharedRun();
  const diffHashCalls = sharedCalls.filter((c) => c.label.startsWith('diff-hash'));
  assert.ok(
    diffHashCalls.length >= 1,
    `diff-hash* の call が 0 件だった (全 labels: ${sharedCalls.map((c) => c.label).join(', ')})`,
  );
});

test('[diffhash-prompt-contract] (a) diff-hash* prompt は argv 行 "worktree-diff-hash /tmp/wt origin/main" を verbatim 含む', async () => {
  await ensureSharedRun();
  const diffHashCalls = sharedCalls.filter((c) => c.label.startsWith('diff-hash'));
  assert.ok(diffHashCalls.length >= 1, 'diff-hash* call が見つからない');
  for (const c of diffHashCalls) {
    assert.ok(
      c.prompt.includes('worktree-diff-hash /tmp/wt origin/main'),
      `${c.label} の prompt に argv 行 "worktree-diff-hash /tmp/wt origin/main" が見つからない。\nprompt: ${c.prompt}`,
    );
  }
});

test('[diffhash-prompt-contract] (c) diff-hash* prompt は禁止語 sandbox / excludedCommands / permission / 迂回 を含まない', async () => {
  await ensureSharedRun();
  const diffHashCalls = sharedCalls.filter((c) => c.label.startsWith('diff-hash'));
  assert.ok(diffHashCalls.length >= 1, 'diff-hash* call が見つからない');
  for (const c of diffHashCalls) {
    assert.doesNotMatch(c.prompt, /sandbox/i, `${c.label} の prompt に "sandbox" が含まれている`);
    assert.doesNotMatch(c.prompt, /excludedCommands/i, `${c.label} の prompt に "excludedCommands" が含まれている`);
    assert.doesNotMatch(c.prompt, /permission/i, `${c.label} の prompt に "permission" が含まれている`);
    assert.doesNotMatch(c.prompt, /迂回/, `${c.label} の prompt に "迂回" が含まれている`);
  }
});

test('[diffhash-prompt-contract] (d) diff-hash* call の agentType は dev-flow:dev-runner-haiku-ro', async () => {
  await ensureSharedRun();
  const diffHashCalls = sharedCalls.filter((c) => c.label.startsWith('diff-hash'));
  assert.ok(diffHashCalls.length >= 1, 'diff-hash* call が見つからない');
  for (const c of diffHashCalls) {
    assert.equal(
      c.agentType,
      'dev-flow:dev-runner-haiku-ro',
      `${c.label} の agentType は 'dev-flow:dev-runner-haiku-ro' のはずだが '${c.agentType}' だった`,
    );
  }
});
