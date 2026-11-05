// issue #614: concern_resolutions[] の旧 resolved boolean キー / out-of-enum resolution が
// dev-flow.js の実行経路で silent 無視されず run abort（明示 error）になることを VM sandbox で固定する。
//
// normalizeConcernResolution（_lib/evaluator-contract.mjs）が throw する 2 パターンを、
// dev-flow.js の CONCERN ledger 反映ループが素通ししないことを回帰させる。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeRecordingSandbox, runDevFlowInSandbox } from './test-helpers/vm-sandbox.mjs';

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
  const { ctx } = makeRecordingSandbox(baseResponder(concernResolutions));
  return runDevFlowInSandbox(src, ctx);
}

test('[eval-concern-resolutions][#614] 旧 boolean キー resolved は run abort（明示 error）になる', async () => {
  const err = await runWith([{ id: 'CONCERN-1', resolved: true, evidence: 'x' }]);
  assert.ok(err != null, '旧 resolved boolean キーは明示 error で run abort するはずが err が null（silent 無視されている）');
  assert.notEqual(err.name, 'ReferenceError', `err が ReferenceError（想定外のクラッシュ）: ${err.message}`);
  assert.notEqual(err.name, 'SyntaxError', `err が SyntaxError（想定外のクラッシュ）: ${err.message}`);
  assert.match(err.message, /resolved/, `err.message に旧キー resolved への言及が無い: ${err.message}`);
});

test('[eval-concern-resolutions][#614] out-of-enum resolution は run abort（明示 error）になる', async () => {
  const err = await runWith([{ id: 'CONCERN-1', resolution: 'maybe', evidence: 'x' }]);
  assert.ok(err != null, 'out-of-enum resolution は明示 error で run abort するはずが err が null（silent 無視されている）');
  assert.notEqual(err.name, 'ReferenceError', `err が ReferenceError（想定外のクラッシュ）: ${err.message}`);
  assert.notEqual(err.name, 'SyntaxError', `err が SyntaxError（想定外のクラッシュ）: ${err.message}`);
  assert.match(err.message, /out-of-enum|resolution/, `err.message が enum 外を示していない: ${err.message}`);
});
