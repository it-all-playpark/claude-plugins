// Evaluate の prompt に Validate の結果（validate_result）を渡す経路を VM 実行で pin する（issue #842）。
//   - tree が Validate と同じ eval#1（diff-gate と diff-hash-eval の hash が一致）: validate_result と全件スイート
//     を走らせない指示が入り、値は Validate が返した green / tests / summary そのまま
//   - tree が変わった eval#2（reimpl 後に diff-hash-eval の hash が変わる）: どちらも入らない
//   - Validate 終了時の hash と eval 直前の hash が最初から食い違う / 取れない: eval#1 にも入らない

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash, shapeOverrides, devFlowArgs, prerunAnalyze } from './test-helpers/vm-sandbox.mjs';
import { EVAL_FULL_SUITE } from './evaluator-contract.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', '.claude/workflows/dev-flow.js'), 'utf8');

const NO_FULL_SUITE = `${EVAL_FULL_SUITE}は走らせず、AC に関係するテストファイルだけを実行して根拠にせよ。`;
const VAL = { tests: 'passed', green: true, summary: 'bats 3 files / vitest 412 passed' };

async function run(overrides, extra = {}) {
  const { ctx, calls } = makeDevFlowSandbox({ overrides: { 'test#1': VAL, ...overrides }, extra });
  const { error } = await runWorkflowCapture(src, ctx);
  assertNoCrash(error, 'eval-validate-result');
  return calls.filter((c) => c.agentType === 'dev-flow:evaluator' && /^eval#\d+$/.test(c.label));
}

// diff-hash-eval を呼ばれた順に hashes で返す（尽きたら最後の値）
function evalHashes(...hashes) {
  let n = 0;
  return () => ({ hash: hashes[Math.min(n++, hashes.length - 1)], empty: false });
}

test('[eval-validate-result] tree が Validate と同じ eval#1 には validate_result と全件スイートを走らせない指示が入る', async () => {
  const evals = await run({ 'diff-gate': { hash: 'AAA', empty: false }, 'diff-hash-eval': evalHashes('AAA') });
  assert.equal(evals.length, 1, `standard は eval#1 のみ: ${evals.map((c) => c.label).join(', ')}`);
  const p = evals[0].prompt;
  assert.ok(p.includes('validate_result'), 'eval#1 に validate_result が無い');
  assert.ok(p.includes(JSON.stringify({ green: VAL.green, tests: VAL.tests, summary: VAL.summary })), 'Validate の green / tests / summary がそのまま渡っていない');
  assert.ok(p.includes(NO_FULL_SUITE), 'eval#1 に全件スイートを走らせない指示が無い');
  // Validate は変更に関係するテストだけを回すことがあるので「全件 green」と断定しない
  assert.ok(!p.includes('全件 green'), '「全件 green」と断定する文が入っている');
});

test('[eval-validate-result] reimpl で tree が変わった eval#2 には validate_result も全件スイートの禁止も入らない', async () => {
  const ac4 = [0, 1, 2, 3].map((i) => ({ ac_index: i, satisfied: true, verified_by: 'inspection', evidence: 'ok' }));
  const evals = await run({
    ...shapeOverrides('complex'),
    'diff-gate': { hash: 'AAA', empty: false },
    'diff-hash-eval': evalHashes('AAA', 'BBB'),
    'eval#1': {
      verdict: 'fail', feedback: [{ severity: 'critical', topic: 'X', description: '重大欠陥', suggestion: '修正せよ' }],
      feedback_level: 'implementation', ac_results: ac4, security_clearance: [],
    },
    'eval#2': {
      verdict: 'pass', feedback: [], feedback_level: 'implementation', ac_results: ac4, security_clearance: [],
      critical_resolutions: [{ id: 'EVAL-1-X', resolved: true, evidence: 'src/x.ts で修正を確認' }],
    },
  }, { args: devFlowArgs(1, { analyze: prerunAnalyze({ acceptance_criteria: ['a', 'b', 'c', 'd'], issue_type: 'feat' }) }) });
  assert.equal(evals.length, 2, `eval#1 / eval#2 が呼ばれるはず: ${evals.map((c) => c.label).join(', ')}`);
  assert.ok(evals[0].prompt.includes('validate_result') && evals[0].prompt.includes(NO_FULL_SUITE), 'eval#1（同じ tree）には入るはず');
  assert.ok(!evals[1].prompt.includes('validate_result'), 'tree が変わった eval#2 に validate_result が入っている');
  assert.ok(!evals[1].prompt.includes(NO_FULL_SUITE), 'tree が変わった eval#2 に全件スイートの禁止が入っている');
});

test('[eval-validate-result] Validate 終了時と eval 直前の hash が食い違う・取れないときは eval#1 にも入らない', async () => {
  for (const [name, overrides] of [
    ['hash 不一致', { 'diff-gate': { hash: 'AAA', empty: false }, 'diff-hash-eval': evalHashes('CCC') }],
    ['eval 直前の hash 取得失敗', { 'diff-gate': { hash: 'AAA', empty: false }, 'diff-hash-eval': null }],
  ]) {
    const evals = await run(overrides);
    assert.equal(evals.length, 1, name);
    assert.ok(!evals[0].prompt.includes('validate_result'), `${name}: validate_result が入っている`);
    assert.ok(!evals[0].prompt.includes(NO_FULL_SUITE), `${name}: 全件スイートの禁止が入っている`);
  }
});
