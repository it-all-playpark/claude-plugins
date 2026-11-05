// AC#1/AC#2: ESCALATE-TO-HUMAN producer 実経路テスト（issue #177）
//
// このテストファイルは TDD red として作成された。
// F2 実装（eval loop の escalate 転写 + EVAL schema 拡張）完了後に green になる。
//
// テスト 1（AC#1）: evaluator が escalate:true の major feedback を返す
//   → merge_tier === 'HOLD' かつ merge_tier_reasons に 'ESCALATE-TO-HUMAN 項目 1 件' を含む。
// テスト 2（AC#2）: 同条件で escalate キーなしの major feedback のみ
//   → merge_tier === 'REVIEW'（HOLD にならない = 従来挙動）。
// テスト 3: テスト 1 と同じ sandbox で post-summary prompt に 'ESCALATE-TO-HUMAN' を含む。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { devFlowArgs, mergeTierFacts, runWorkflowCapture, JS_GLOBALS, devFlowResponder, makeWorkflowContext } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');

// ---- VM sandbox helpers ----

/**
 * escalate-producer 検証専用の VM sandbox を組む。
 * evaluator stub が引数 evaluatorResponse を返すように改変。
 * post-summary の prompt を capture するために agentStub を拡張している。
 *
 * @param {object} evaluatorResponse - evaluator stub が返すレスポンス
 * @returns {{ ctx: vm.Context, getCapturedPostSummaryPrompt: () => string|null }}
 */
function makeSandbox(evaluatorResponse) {
  let capturedPostSummaryPrompt = null;

  // agent() stub: opts.label / opts.agentType を見て phase 別に最小スキーマを返す
  const agentStub = async (prompt, opts) => {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';

    // Diff triage の敵対的 security review の対象判定（issue #1063）: この test の関心外なので対象外を返す
    if (label === 'security-scope') return { ok: true, target: false, reasons: [] };
    // Diff triage / Merge tier: danger-grep 系（label が 'danger-grep' で始まる）
    // → danger clean にして HOLD 要因を escalate のみに絞る
    if (label.startsWith('danger-grep')) {
      return { ok: true, hits: [] };
    }
    // Validate: test runner（label が 'test' で始まる）
    if (label.startsWith('test')) {
      return { tests: 'no_tests', green: true, summary: '' };
    }
    // Evaluate: evaluator stub が引数 evaluatorResponse を返す
    if (agentType === 'dev-flow:evaluator') {
      return evaluatorResponse;
    }
    // post-summary: prompt を capture して投稿成功を返す
    if (label === 'post-summary') {
      capturedPostSummaryPrompt = prompt;
      return { posted: true, method: 'gh pr comment', url: 'http://x/1' };
    }
    // implementer その他
    if (agentType === 'dev-flow:dev-implementer') {
      return { status: 'DONE', task_id: 't', files: [], summary: '', concerns: [] };
    }
    // デフォルト
    return devFlowResponder({ 'commit-hook#1': null, 'isolation-probe': null, 'journal-log': null })({ label, agentType, prompt });
  };

  // pr-iterate stub: workflow() の呼び出し
  const workflowStub = async () => ({ status: 'lgtm', iterations: 1, fixes_applied: 0 });

  const ctx = makeWorkflowContext({
    agent: agentStub,
    workflow: workflowStub,
    args: devFlowArgs('1'),
  });
  return {
    ctx,
    getCapturedPostSummaryPrompt: () => capturedPostSummaryPrompt,
  };
}

// ============================================================
// テスト 1（AC#1）: escalate:true の major → merge_tier === 'HOLD'
// ============================================================
test('[escalate-producer] AC#1: escalate:true の major feedback → merge_tier === HOLD', async () => {
  const evaluatorResponse = {
    verdict: 'pass',
    total: 8,
    threshold: 7,
    feedback: [
      {
        severity: 'major',
        topic: 'naming preference in api',
        description: 'd',
        suggestion: 's',
        escalate: true,
        escalate_reason: 'preference',
      },
    ],
    feedback_level: 'implementation',
    ac_results: [
      { ac_index: 0, satisfied: true, evidence: 'e', verified_by: 'inspection' },
    ],
  };

  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx } = makeSandbox(evaluatorResponse);
  const { result, error } = await runWorkflowCapture(src, ctx);

  // ReferenceError / SyntaxError は構造的に壊れているので即 fail させる
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  // merge_tier が HOLD であることを assert
  assert.equal(
    result?.merge_tier,
    'HOLD',
    `escalate:true の major feedback がある場合、merge_tier は 'HOLD' であるべきだが '${result?.merge_tier}' だった`,
  );

  // merge_tier_reasons に 'ESCALATE-TO-HUMAN 項目 1 件' が含まれることを assert
  assert.ok(
    Array.isArray(result?.merge_tier_reasons)
      && result.merge_tier_reasons.some((x) => /ESCALATE-TO-HUMAN 項目 1 件/.test(x)),
    `merge_tier_reasons に 'ESCALATE-TO-HUMAN 項目 1 件' が含まれるべきだが含まれなかった: ${JSON.stringify(result?.merge_tier_reasons)}`,
  );
});

// ============================================================
// テスト 2（AC#2）: escalate なしの major → merge_tier === 'REVIEW'（従来挙動）
// ============================================================
test('[escalate-producer] AC#2: escalate なしの major feedback → merge_tier === REVIEW（従来挙動）', async () => {
  const evaluatorResponse = {
    verdict: 'pass',
    total: 8,
    threshold: 7,
    feedback: [
      {
        severity: 'major',
        topic: 'naming preference in api',
        description: 'd',
        suggestion: 's',
        // escalate キーなし（省略 = false 扱い）
      },
    ],
    feedback_level: 'implementation',
    ac_results: [
      { ac_index: 0, satisfied: true, evidence: 'e', verified_by: 'inspection' },
    ],
  };

  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx } = makeSandbox(evaluatorResponse);
  const { result, error } = await runWorkflowCapture(src, ctx);

  // ReferenceError / SyntaxError は構造的に壊れているので即 fail させる
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  // escalate なし major は advisory lane のみ → HOLD にならない
  assert.equal(
    result?.merge_tier,
    'REVIEW',
    `escalate なしの major feedback の場合、merge_tier は 'REVIEW' であるべきだが '${result?.merge_tier}' だった`,
  );
});

// ============================================================
// テスト 3: post-summary prompt が 'ESCALATE-TO-HUMAN' を含む（終端サマリー実経路確認）
// ============================================================
test('[escalate-producer] テスト3: escalate:true の major → post-summary prompt に ESCALATE-TO-HUMAN を含む', async () => {
  const evaluatorResponse = {
    verdict: 'pass',
    total: 8,
    threshold: 7,
    feedback: [
      {
        severity: 'major',
        topic: 'naming preference in api',
        description: 'd',
        suggestion: 's',
        escalate: true,
        escalate_reason: 'preference',
      },
    ],
    feedback_level: 'implementation',
    ac_results: [
      { ac_index: 0, satisfied: true, evidence: 'e', verified_by: 'inspection' },
    ],
  };

  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, getCapturedPostSummaryPrompt } = makeSandbox(evaluatorResponse);
  const { result, error } = await runWorkflowCapture(src, ctx);

  // ReferenceError / SyntaxError は構造的に壊れているので即 fail させる
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  const capturedPrompt = getCapturedPostSummaryPrompt();

  // post-summary が呼ばれたことを確認
  assert.ok(
    capturedPrompt !== null,
    'post-summary agent が呼ばれなかった（prompt が capture されなかった）',
  );

  // post-summary の prompt が 'ESCALATE-TO-HUMAN' を含むことを assert（buildDevflowSummaryBody 経由）
  assert.ok(
    capturedPrompt.includes('ESCALATE-TO-HUMAN'),
    `post-summary の prompt に 'ESCALATE-TO-HUMAN' が含まれるべきだが含まれなかった。\ncaptured: ${capturedPrompt?.slice(0, 500)}`,
  );
});

// ============================================================
// テスト 4: complex shape の iteration 2 以降で escalate が append される
// ============================================================
// complex shape では eval loop が最大 EVAL_MAX 回実行される。
// iteration 1 で critical feedback を出し、iteration 2 で critical を resolve しつつ
// 新規 escalate:true feedback を返す。
// canAppend の escalate bypass により、round>0 の新規 topic でも ledger に積まれ
// merge_tier === 'HOLD' になることを assert する。
test('[escalate-producer] テスト4: complex shape iteration 2 に初出 escalate:true → ledger に積まれ merge_tier === HOLD', async () => {
  // complex shape: danger-grep stub が旧形（files 無し）→ realized count 欠損 → classifyShape が complex に floor
  const complexAnalyzeReq = {
    summary: 'refactor auth module with new permission model',
    acceptance_criteria: ['Auth permission model enforced'],
    issue_type: 'feat',
    scope: 'src/auth',
    issue_number: 1,
    issue_title: 'stub-issue-title',
  };

  // evaluator stub: 呼び出し回数を追跡して iteration 別に挙動を変える
  let evaluatorCallCount = 0;

  // iteration 1 で返す critical feedback の topic
  const criticalTopic = 'missing auth check in api handler';
  // ID 生成ロジックと一致させる: `EVAL-${i}-${topic.slice(0,24)}`
  const criticalId = `EVAL-1-${criticalTopic.slice(0, 24)}`;

  function makeAgentStub() {
    return async (prompt, opts) => {
      const label = opts?.label ?? '';
      const agentType = opts?.agentType ?? '';

      if (label === 'worktree') {
        return { worktree: '/tmp/wt', branch: 'feature/issue-1' };
      }
      if (label.startsWith('analyze')) {
        return complexAnalyzeReq;
      }
      // Diff triage の敵対的 security review の対象判定（issue #1063）: この test の関心外なので対象外を返す
      if (label === 'security-scope') return { ok: true, target: false, reasons: [] };
      if (label.startsWith('danger-grep')) {
        return { ok: true, hits: [] };
      }
      if (label.startsWith('test')) {
        return { tests: 'no_tests', green: true, summary: '' };
      }
      if (agentType === 'dev-flow:evaluator') {
        evaluatorCallCount++;
        if (evaluatorCallCount === 1) {
          // iteration 1: critical を出す（差し戻しを起こす）
          return {
            verdict: 'fail',
            total: 5,
            threshold: 7,
            feedback: [
              {
                severity: 'critical',
                topic: criticalTopic,
                description: 'auth handler lacks permission check',
                suggestion: 'add permission gate',
              },
            ],
            feedback_level: 'implementation',
            ac_results: [
              { ac_index: 0, satisfied: false, evidence: 'none', verified_by: 'inspection' },
            ],
            critical_resolutions: [],
          };
        }
        // iteration 2: critical を resolve し、新規 escalate:true を返す
        return {
          verdict: 'pass',
          total: 8,
          threshold: 7,
          feedback: [
            {
              severity: 'major',
              topic: 'naming convention choice for permission enum',
              description: 'enum naming is preference-based, no issue spec',
              suggestion: 'human should decide',
              escalate: true,
              escalate_reason: 'preference',
            },
          ],
          feedback_level: 'implementation',
          ac_results: [
            { ac_index: 0, satisfied: true, evidence: 'auth.test.mjs::enforces permission', verified_by: 'inspection' },
          ],
          // iteration 1 の critical を解消
          critical_resolutions: [
            { id: criticalId, resolved: true, evidence: 'permission gate added in auth/handler.ts:42' },
          ],
        };
      }
      if (agentType === 'dev-flow:dev-runner-haiku' && label.startsWith('redgreen')) {
        return { red: false, green: false, reason: 'stub' };
      }
      if (label.startsWith('pr')) {
        return { pr_url: 'http://x', pr_number: 1, committed: true };
      }
      if (label === 'merge-tier-facts') {
        return mergeTierFacts({ files: ['src/auth/handler.ts'] });
      }
      if (label === 'post-summary') {
        return { posted: true, method: 'gh pr comment', url: 'http://x/1' };
      }
      if (agentType === 'dev-flow:dev-implementer') {
        return { status: 'DONE', task_id: 't', files: [], summary: '', concerns: [] };
      }
      // diff-gate / diff-hash（issue #215）: need() による throw の回避
      if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) return { hash: 'H', empty: false }
      return null;
    };
  }

  const workflowStub = async () => ({ status: 'lgtm', iterations: 1, fixes_applied: 0 });

  const sandbox = {
    phase: () => {},
    log: () => {},
    agent: makeAgentStub(),
    workflow: workflowStub,
    args: devFlowArgs('1'),
    ...JS_GLOBALS,
  };

  const ctx = vm.createContext(sandbox);
  const src = readFileSync(
    join(repoRoot, '.claude/workflows/dev-flow.js'),
    'utf8',
  );

  const { result, error } = await runWorkflowCapture(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  // evaluator が 2 回呼ばれたことを確認（iteration 2 が実行された）
  assert.ok(
    evaluatorCallCount >= 2,
    `evaluator は 2 回以上呼ばれるべきだが ${evaluatorCallCount} 回だった（complex shape iteration ループが動作していない可能性）`,
  );

  // iteration 2 で追加した escalate:true が ledger に積まれ merge_tier === 'HOLD' になる
  assert.equal(
    result?.merge_tier,
    'HOLD',
    `complex shape iteration 2 の escalate:true feedback がある場合、merge_tier は 'HOLD' であるべきだが '${result?.merge_tier}' だった`,
  );

  // merge_tier_reasons に ESCALATE-TO-HUMAN が含まれる
  assert.ok(
    Array.isArray(result?.merge_tier_reasons)
      && result.merge_tier_reasons.some((x) => /ESCALATE-TO-HUMAN/.test(x)),
    `merge_tier_reasons に 'ESCALATE-TO-HUMAN' が含まれるべきだが含まれなかった: ${JSON.stringify(result?.merge_tier_reasons)}`,
  );
});
