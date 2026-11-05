// validate-tests-error-skip-routing: VM sandbox routing test for dev-flow の Validate phase
// （issue #627 F1）。TDD red として作成: `runValidateLoop` の break 条件に `tests:'error'`
// （dev-runner-haiku 自己申告の起動失敗）が含まれることを label 列で pin する。実装
// （dev-flow.js への `if (v.tests === 'error') { ...; break }` 追加）は F2 で行う。
//
// 現状（F1 時点）の break 条件は `if (v.green || v.tests === 'no_tests') break` のみのため、
// `tests:'error'` でも green-fix（implementer）が GREEN_MAX=3 回まで回ってしまう欠陥がある。
// 本ファイルはこの欠陥を pin し、F2 実装後に green へ転じることを確認するためのハーネス。
//
// ハーネス: makeRecordingSandbox / runWorkflowCapture（_lib/test-helpers/vm-sandbox.mjs）。
//
// テストケース:
//   (0) crash guard: 3 シナリオとも error が ReferenceError / SyntaxError でないこと
//   (1) AC1 本経路 error: test#1 で green-fix 0 回・test#2 なし・eval#1 到達（F1 時点で red）
//   (2) AC2 本経路 failed: test#1 → green-fix#1 → test#2 の順で存在・green-fix#2 は無し
//   (3) AC3 retry 経路 error: test#retry-1 で green-fix#retry 0 回・test#retry-2 なし・eval#1 到達
//       （F1 時点で red）
//   (4) AC4 状態保持: result.test_green===false かつ merge_tier_reasons に 'tests=error' を含まない
//   (5) 専用 log: 'tests=error' + 'green-fix をスキップ' を含む log が出る（F1 時点で red）。
//       GREEN_MAX 到達 log（'回試行しても test green にならず'）は出ない
//   (6) 構造 pin（静的）: runValidateLoop 本体で `v.tests === 'error'` の判定が
//       green-fix#retry-i 呼び出しより前に出現する（F1 時点で red）

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeRecordingSandbox, devFlowArgs, runWorkflowCapture } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');
const devFlowSrc = readFileSync(devFlowPath, 'utf8');

// ============================================================
// responder factory
// ============================================================

function createResponder({ mode, gateEmpty }) {
  let mainCount = 0;
  let retryCount = 0;
  return function ({ label, agentType }) {
    if (label.startsWith('danger-grep')) return { ok: true, hits: [] };
    if (label === 'diff-gate') return { hash: gateEmpty ? 'EMPTY' : 'H', empty: !!gateEmpty };
    if (label === 'diff-gate-retry') return { hash: 'H', empty: false };
    if (label.startsWith('diff-hash')) return { hash: 'H', empty: false };
    if (label.startsWith('test')) {
      const isRetryLabel = label.startsWith('test#retry');
      if (mode === 'error-main') {
        if (!isRetryLabel) {
          mainCount += 1;
          return { tests: 'error', green: false, summary: 'pnpm install failed: invalid peer certificate — テストは 1 件も実行されていない' };
        }
        return { tests: 'passed', green: true, summary: '' };
      }
      if (mode === 'failed-main') {
        if (!isRetryLabel) {
          mainCount += 1;
          if (mainCount === 1) return { tests: 'failed', green: false, summary: 'assert mismatch' };
          return { tests: 'passed', green: true, summary: '' };
        }
        return { tests: 'passed', green: true, summary: '' };
      }
      if (mode === 'error-retry') {
        if (!isRetryLabel) {
          // 本経路は空 tree で trivially green
          return { tests: 'passed', green: true, summary: '' };
        }
        retryCount += 1;
        return { tests: 'error', green: false, summary: 'pnpm install failed: invalid peer certificate' };
      }
      return { tests: 'passed', green: true, summary: '' };
    }
    if (agentType === 'dev-flow:dev-implementer' && label.startsWith('green-fix')) {
      return { status: 'DONE', task_id: 't', files: ['src/foo.test.ts'], summary: 'fix', concerns: [] };
    }
    if (agentType === 'dev-flow:dev-implementer') {
      return { status: 'DONE', task_id: 't', files: ['src/foo.ts'], summary: '', concerns: [] };
    }
    if (agentType === 'dev-flow:evaluator') {
      return {
        verdict: 'pass', total: 100, threshold: 80, feedback: [],
        feedback_level: 'implementation', ac_results: [], security_clearance: [],
      };
    }
    if (label.startsWith('pr')) return { pr_url: 'http://x', pr_number: 1, committed: true };
    // それ以外（issue-labels 含む）→ null（非 cross-repo 扱い → 差し戻し1回 → retry 経路へ）
    return null;
  };
}

// ============================================================
// シナリオごとに 1 回だけ実行してキャッシュする
// ============================================================

const scenarioCache = new Map();

async function runScenario({ mode, gateEmpty }) {
  const key = `${mode}:${!!gateEmpty}`;
  if (scenarioCache.has(key)) return scenarioCache.get(key);
  const logs = [];
  const { ctx, calls } = makeRecordingSandbox(createResponder({ mode, gateEmpty }), {
    log: (m) => logs.push(String(m)),
    args: devFlowArgs('627'),
  });
  const { result, error } = await runWorkflowCapture(devFlowSrc, ctx);
  const out = { calls, logs, result, error };
  scenarioCache.set(key, out);
  return out;
}

function labelsOf(calls) {
  return calls.map((c) => c.label).join(', ');
}

// ============================================================
// (0) crash guard
// ============================================================

test('[validate-tests-error-skip] (0) crash guard: 3 シナリオとも ReferenceError / SyntaxError を throw しない', async () => {
  const scenarios = [
    { mode: 'error-main', gateEmpty: false },
    { mode: 'failed-main', gateEmpty: false },
    { mode: 'error-retry', gateEmpty: true },
  ];
  for (const s of scenarios) {
    const { error } = await runScenario(s);
    if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
      assert.fail(`[${s.mode}] dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
    }
  }
});

// ============================================================
// (1) AC1 本経路 error
// ============================================================

test("[validate-tests-error-skip] (1) AC1: 本経路 tests:'error' で green-fix 0 回・test#2 なし・eval#1 到達", async () => {
  const { calls } = await runScenario({ mode: 'error-main', gateEmpty: false });
  const labels = labelsOf(calls);
  assert.ok(calls.some((c) => c.label === 'test#1'), `test#1 が見つからない (labels: ${labels})`);
  const greenFixCalls = calls.filter((c) => c.label.startsWith('green-fix'));
  assert.equal(greenFixCalls.length, 0, `green-fix は 0 回のはずだが ${greenFixCalls.length} 回だった (labels: ${labels})`);
  assert.equal(calls.some((c) => c.label === 'test#2'), false, `test#2 は起動されないはずだが起動された (labels: ${labels})`);
  assert.ok(calls.some((c) => c.label === 'eval#1'), `eval#1 に到達するはずだが到達しない (labels: ${labels})`);
});

// ============================================================
// (2) AC2 本経路 failed（従来どおり）
// ============================================================

test("[validate-tests-error-skip] (2) AC2: 本経路 tests:'failed' は test#1 → green-fix#1 → test#2 の順で進み green-fix#2 は無い", async () => {
  const { calls } = await runScenario({ mode: 'failed-main', gateEmpty: false });
  const labels = calls.map((c) => c.label);
  const idxTest1 = labels.indexOf('test#1');
  const idxGf1 = labels.indexOf('green-fix#1');
  const idxTest2 = labels.indexOf('test#2');
  const labelsStr = labels.join(', ');
  assert.ok(idxTest1 !== -1, `test#1 が見つからない (labels: ${labelsStr})`);
  assert.ok(idxGf1 !== -1, `green-fix#1 が見つからない (labels: ${labelsStr})`);
  assert.ok(idxTest2 !== -1, `test#2 が見つからない (labels: ${labelsStr})`);
  assert.ok(idxTest1 < idxGf1 && idxGf1 < idxTest2, `順序が test#1 < green-fix#1 < test#2 でない (labels: ${labelsStr})`);
  assert.equal(labels.includes('green-fix#2'), false, `green-fix#2 は存在しないはずだが存在した (labels: ${labelsStr})`);
});

// ============================================================
// (3) AC3 retry 経路 error
// ============================================================

test("[validate-tests-error-skip] (3) AC3: retry 経路 tests:'error' でも AC1 と同じ挙動（green-fix#retry 0 回・test#retry-2 なし・eval#1 到達）", async () => {
  const { calls } = await runScenario({ mode: 'error-retry', gateEmpty: true });
  const labels = labelsOf(calls);
  assert.ok(calls.some((c) => c.label === 'diff-gate-retry'), `retry 経路に入っていない: diff-gate-retry が見つからない (labels: ${labels})`);
  assert.ok(calls.some((c) => c.label === 'test#retry-1'), `test#retry-1 が見つからない (labels: ${labels})`);
  const greenFixRetryCalls = calls.filter((c) => c.label.startsWith('green-fix#retry'));
  assert.equal(greenFixRetryCalls.length, 0, `green-fix#retry は 0 回のはずだが ${greenFixRetryCalls.length} 回だった (labels: ${labels})`);
  assert.equal(calls.some((c) => c.label === 'test#retry-2'), false, `test#retry-2 は起動されないはずだが起動された (labels: ${labels})`);
  assert.ok(calls.some((c) => c.label === 'eval#1'), `eval#1 に到達するはずだが到達しない (labels: ${labels})`);
});

// ============================================================
// (4) AC4 状態保持
// ============================================================

test("[validate-tests-error-skip] (4) AC4: tests:'error' で break した run の result.test_green===false かつ merge_tier_reasons に 'tests=error' を含まない", async () => {
  const { result, calls } = await runScenario({ mode: 'error-main', gateEmpty: false });
  assert.ok(result !== null, `result が null (labels: ${labelsOf(calls)})`);
  assert.equal(result.test_green, false, `test_green は false のはずだが ${JSON.stringify(result.test_green)} (labels: ${labelsOf(calls)})`);
  const reasons = result.merge_tier_reasons ?? [];
  assert.ok(
    !reasons.some((r) => String(r).includes('tests=error')),
    `merge_tier_reasons に 'tests=error' を含んではならないが含んでいた: ${JSON.stringify(reasons)} (labels: ${labelsOf(calls)})`,
  );
});

// ============================================================
// (5) 専用 log
// ============================================================

test("[validate-tests-error-skip] (5) 専用 log: 本経路 error で 'tests=error' + 'green-fix をスキップ' を含む log が出る（GREEN_MAX 到達 log は出ない）", async () => {
  const { logs, calls } = await runScenario({ mode: 'error-main', gateEmpty: false });
  assert.ok(
    logs.some((l) => l.includes('tests=error') && l.includes('green-fix をスキップ')),
    `専用 log（'tests=error' かつ 'green-fix をスキップ' を含む）が見つからない (logs: ${JSON.stringify(logs)}) (labels: ${labelsOf(calls)})`,
  );
  assert.equal(
    logs.some((l) => l.includes('回試行しても test green にならず')),
    false,
    `GREEN_MAX 到達 log が出てはならないが出た (logs: ${JSON.stringify(logs)})`,
  );
});

test("[validate-tests-error-skip] (5) 専用 log: retry 経路 error でも同じ 2 条件を満たす", async () => {
  const { logs, calls } = await runScenario({ mode: 'error-retry', gateEmpty: true });
  assert.ok(
    logs.some((l) => l.includes('tests=error') && l.includes('green-fix をスキップ')),
    `専用 log（'tests=error' かつ 'green-fix をスキップ' を含む）が見つからない (logs: ${JSON.stringify(logs)}) (labels: ${labelsOf(calls)})`,
  );
  assert.equal(
    logs.some((l) => l.includes('回試行しても test green にならず')),
    false,
    `GREEN_MAX 到達 log が出てはならないが出た (logs: ${JSON.stringify(logs)})`,
  );
});

// (6) 「runValidateLoop 内で v.tests === 'error' の判定が green-fix#retry-i 呼び出しより前に出現する」
// 静的 pin は撤去した（issue #636）。判定順の実質は (1)(3) が VM 実行で「tests:'error' で green-fix /
// green-fix#retry が 0 回」として担保する。
