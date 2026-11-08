// issue #614: concern_resolutions[] の旧 resolved boolean キー / out-of-enum resolution が
// dev-flow の実行経路で silent 無視されず明示 error になることを VM sandbox で固定する。
//
// normalizeConcernResolution（_lib/evaluator-contract.mjs）が throw する 2 パターンを、
// Evaluate（dev-flow-evaluate.js）の CONCERN ledger 反映ループが素通ししないことを回帰させる。
// 子の throw は親（dev-flow.js）が受け、評価を通ったものとして扱わずに PR を作らない HOLD で終える。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeRecordingSandbox, runWorkflowCapture } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');

function baseResponder(concernResolutions) {
  return function({ label, agentType }) {
    if (label === 'worktree') {
      return { worktree: '/tmp/wt', branch: 'feature/issue-614' };
    }
    if (label.startsWith('analyze')) {
      return {
        summary: 's',
        acceptance_criteria: ['a', 'b'],
        issue_type: 'fix',
        scope: 'src',
        issue_number: 1,
        issue_title: 'stub-issue-title',
      };
    }
    if (label.startsWith('danger-grep')) {
      return { ok: true, hits: [] };
    }
    if (label.startsWith('test')) {
      return { tests: 'passed', green: true, summary: '' };
    }
    if (agentType === 'dev-flow:evaluator') {
      return {
        verdict: 'pass',
        total: 100,
        threshold: 80,
        feedback: [],
        feedback_level: 'implementation',
        ac_results: [
          { ac_index: 0, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
          { ac_index: 1, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
        ],
        security_clearance: [],
        concern_resolutions: concernResolutions,
      };
    }
    if (label === 'realized-diff' || label === 'declared-path-check' || label === 'changed-files') {
      return { files: [] };
    }
    if (label.startsWith('pr')) {
      return { pr_url: 'http://x', pr_number: 1, committed: true };
    }
    if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) {
      return { hash: 'H', empty: false };
    }
    if (label === 'post-summary' && agentType === 'dev-flow:dev-runner-haiku') {
      return { posted: true, method: 'gh pr comment', url: 'http://x' };
    }
    if (agentType === 'dev-flow:dev-implementer') {
      return {
        status: 'DONE_WITH_CONCERNS',
        task_id: 't1',
        files: ['src/x.ts'],
        summary: 's',
        concerns: ['CONCERN マーカー: ORDER BY 検証が未実装'],
      };
    }
    return null;
  };
}

async function runWith(concernResolutions) {
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, calls } = makeRecordingSandbox(baseResponder(concernResolutions));
  const { result, error } = await runWorkflowCapture(src, ctx);
  assert.equal(error, null, `dev-flow-evaluate の throw は親が HOLD で受けるはずが abort した: ${error?.message}`);
  assert.equal(result?.status, 'evaluate_failed', '明示 error で評価を確定できず HOLD で終わるはずが、評価を通った（silent 無視されている）');
  assert.equal(result?.merge_tier, 'HOLD');
  assert.ok(!calls.some((c) => /^pr#/.test(c.label)), '評価できなかった run で PR を作ろうとした');
  assert.doesNotMatch(result.evaluate_error, /is not defined|SyntaxError/, `想定外のクラッシュ: ${result.evaluate_error}`);
  return result.evaluate_error;
}

test('[eval-concern-resolutions][#614] 旧 boolean キー resolved は明示 error で評価を確定できず HOLD になる', async () => {
  const err = await runWith([{ id: 'CONCERN-1', resolved: true, evidence: 'x' }]);
  assert.match(err, /resolved/, `evaluate_error に旧キー resolved への言及が無い: ${err}`);
});

test('[eval-concern-resolutions][#614] out-of-enum resolution は明示 error で評価を確定できず HOLD になる', async () => {
  const err = await runWith([{ id: 'CONCERN-1', resolution: 'maybe', evidence: 'x' }]);
  assert.match(err, /out-of-enum|resolution/, `evaluate_error が enum 外を示していない: ${err}`);
});
