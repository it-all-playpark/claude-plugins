// no-tests-hold-routing: run-tests が tests:'no_tests'（実行対象のテストが 0 本・green:false）を返した run の経路（issue #1276）。
// dev-flow.js（と chain される dev-flow-finalize.js）を VM で動かし、
//   - Validate のループが no_tests を通過扱いにせず、green-fix にも回さずに抜けること
//   - Validate / Final reconcile の test#final の no_tests が merge tier の no_tests_run で HOLD になること
// を label 列と返り値で見る。理由の文言・gate_policy に依らないことは merge-tier.test.mjs が見る。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, runWorkflowCapture } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const devFlowSrc = readFileSync(join(here, '..', '.claude/workflows/dev-flow.js'), 'utf8');

// run-tests.sh が実行対象 0 本のときに返す形（status passed・tests no_tests・green false）
const NO_TESTS = { status: 'passed', tests: 'no_tests', green: false, summary: 'no tests/run-*.sh and no fallback test runner', scripts: [], failed_files: [] };
const PASSED = { status: 'passed', tests: 'passed', green: true, summary: 'passed: x', scripts: [], failed_files: [] };
const SYNC_OK = { 'reconcile-sync': { ok: true, head: 'a'.repeat(40) }, 'changed-files-final': { files: [] } };

async function runFlow(overrides, { fixesApplied = 0 } = {}) {
  const logs = [];
  const { ctx, calls } = makeDevFlowSandbox({
    overrides,
    workflow: async () => ({ status: 'lgtm', iterations: 1, fixes_applied: fixesApplied }),
    extra: { log: (m) => logs.push(String(m)) },
  });
  const { result, error } = await runWorkflowCapture(devFlowSrc, ctx);
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  return { result, logs, labels: calls.map((c) => c.label) };
}

const noTestsHolds = (result) => (result.merge_tier_hold_reasons ?? []).filter((r) => r.code === 'no_tests_run');

test('[no-tests-hold] Validate の tests:no_tests は通過扱いにせず green-fix も起動せずにループを抜け、merge tier は no_tests_run で HOLD', async () => {
  const { result, logs, labels } = await runFlow({ 'test#1': NO_TESTS });
  assert.ok(labels.includes('test#1'), labels.join(', '));
  assert.ok(!labels.some((l) => l.startsWith('green-fix')), labels.join(', '));
  assert.ok(!labels.includes('test#2'), labels.join(', '));
  assert.ok(logs.some((l) => l.includes('tests=no_tests') && l.includes('green-fix もスキップ')), JSON.stringify(logs));
  assert.ok(!logs.some((l) => l.includes('回試行しても test green にならず')), JSON.stringify(logs));
  // green:true に読み替えない
  assert.equal(result.validate_tests, 'no_tests');
  assert.equal(result.test_green, false);
  assert.equal(result.final_reconcile, 'skipped');
  assert.equal(result.merge_tier, 'HOLD');
  assert.equal(noTestsHolds(result).map((r) => r.kind).join(','), 'human_judgment', JSON.stringify(result.merge_tier_hold_reasons));
});

test('[no-tests-hold] Validate が passed の run は no_tests_run を積まない', async () => {
  const { result } = await runFlow({ 'test#1': PASSED });
  assert.equal(result.validate_tests, 'passed');
  assert.equal(noTestsHolds(result).length, 0, JSON.stringify(result.merge_tier_hold_reasons));
});

test('[no-tests-hold] Final reconcile の test#final が tests:no_tests なら reverified のまま no_tests_run で HOLD（passed なら積まない）', async () => {
  const noTests = await runFlow({ 'test#1': PASSED, ...SYNC_OK, 'test#final': NO_TESTS }, { fixesApplied: 1 });
  assert.ok(noTests.labels.includes('test#final'), noTests.labels.join(', '));
  assert.equal(noTests.result.final_reconcile, 'reverified');
  assert.equal(noTests.result.merge_tier, 'HOLD');
  const holds = noTestsHolds(noTests.result);
  assert.equal(holds.length, 1, JSON.stringify(noTests.result.merge_tier_hold_reasons));
  assert.ok(holds[0].reason.includes('test#final'), holds[0].reason);

  const passed = await runFlow({ 'test#1': PASSED, ...SYNC_OK, 'test#final': PASSED }, { fixesApplied: 1 });
  assert.equal(passed.result.final_reconcile, 'reverified');
  assert.equal(noTestsHolds(passed.result).length, 0, JSON.stringify(passed.result.merge_tier_hold_reasons));
});
