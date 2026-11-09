// test-runner-changed-routing: run-tests が changed_runners（中身が base と違う・base に無い tests/run-*.sh）を返した run の経路
// （issue #1277）。dev-flow.js（と chain される dev-flow-finalize.js）を VM で動かし、Validate の test#i と Final reconcile の
// test#final のどちらの changed_runners も merge tier の test_runner_changed で HOLD になることを返り値で見る。
// 理由の文言・gate_policy に依らないことは merge-tier.test.mjs、changed_runners を出す条件は run-tests.bats が見る。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, runWorkflowCapture } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const devFlowSrc = readFileSync(join(here, '..', '.claude/workflows/dev-flow.js'), 'utf8');

const PASSED = { status: 'passed', tests: 'passed', green: true, summary: 'passed: x', scripts: [], failed_files: [] };
const withChanged = (paths) => ({ ...PASSED, changed_runners: paths });
const SYNC_OK = { 'reconcile-sync': { ok: true, head: 'a'.repeat(40) }, 'changed-files-final': { files: [] } };

async function runFlow(overrides, { fixesApplied = 0 } = {}) {
  const { ctx } = makeDevFlowSandbox({
    overrides,
    workflow: async () => ({ status: 'lgtm', iterations: 1, fixes_applied: fixesApplied }),
  });
  const { result, error } = await runWorkflowCapture(devFlowSrc, ctx);
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  return result;
}

const runnerHolds = (result) => (result.merge_tier_hold_reasons ?? []).filter((r) => r.code === 'test_runner_changed');

test('[test-runner-changed] Validate の changed_runners は green でも merge tier の test_runner_changed で HOLD し、reason にパスを載せる', async () => {
  const result = await runFlow({ 'test#1': withChanged(['tests/run-new.sh']) });
  assert.equal(result.test_green, true);
  assert.equal(result.merge_tier, 'HOLD');
  const holds = runnerHolds(result);
  assert.equal(holds.map((r) => r.kind).join(','), 'human_judgment', JSON.stringify(result.merge_tier_hold_reasons));
  assert.ok(holds[0].reason.includes('tests/run-new.sh'), holds[0].reason);
});

test('[test-runner-changed] Final reconcile の test#final の changed_runners も Validate の分と合わせて 1 件の HOLD に載せる', async () => {
  const result = await runFlow(
    { 'test#1': withChanged(['tests/run-a.sh']), ...SYNC_OK, 'test#final': withChanged(['tests/run-b.sh', 'tests/run-a.sh']) },
    { fixesApplied: 1 },
  );
  assert.equal(result.final_reconcile, 'reverified');
  const holds = runnerHolds(result);
  assert.equal(holds.length, 1, JSON.stringify(result.merge_tier_hold_reasons));
  assert.ok(holds[0].reason.includes('tests/run-a.sh, tests/run-b.sh'), holds[0].reason);

  const finalOnly = await runFlow({ 'test#1': PASSED, ...SYNC_OK, 'test#final': withChanged(['tests/run-b.sh']) }, { fixesApplied: 1 });
  assert.equal(finalOnly.merge_tier, 'HOLD');
  assert.ok(runnerHolds(finalOnly)[0]?.reason.includes('tests/run-b.sh'), JSON.stringify(finalOnly.merge_tier_hold_reasons));
});

test('[test-runner-changed] changed_runners の無い run は test_runner_changed を積まない', async () => {
  const result = await runFlow({ 'test#1': PASSED, ...SYNC_OK, 'test#final': PASSED }, { fixesApplied: 1 });
  assert.equal(runnerHolds(result).length, 0, JSON.stringify(result.merge_tier_hold_reasons));
});
