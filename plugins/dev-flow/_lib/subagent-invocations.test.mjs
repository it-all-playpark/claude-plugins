import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  recordSubagentInvocation,
  buildSubagentInvocations,
} from './subagent-invocations.mjs';

// ---- recordSubagentInvocation ----

test('recordSubagentInvocation: 通常カウント — 同じ agentType を複数回 +1', () => {
  let counts = {};
  counts = recordSubagentInvocation(counts, 'implementer');
  counts = recordSubagentInvocation(counts, 'implementer');
  counts = recordSubagentInvocation(counts, 'evaluator');
  assert.deepEqual(counts, { implementer: 2, evaluator: 1 });
});

test('recordSubagentInvocation: agentType 欠落（undefined）→ unknown へ計上', () => {
  const counts = recordSubagentInvocation({}, undefined);
  assert.deepEqual(counts, { unknown: 1 });
});

test('recordSubagentInvocation: agentType が空文字 → unknown へ計上', () => {
  const counts = recordSubagentInvocation({}, '');
  assert.deepEqual(counts, { unknown: 1 });
});

test('recordSubagentInvocation: agentType が空白のみ文字列 → unknown へ計上', () => {
  const counts = recordSubagentInvocation({}, '   ');
  assert.deepEqual(counts, { unknown: 1 });
});

test('recordSubagentInvocation: agentType が非 string（数値等）→ unknown へ計上', () => {
  const counts = recordSubagentInvocation({}, 42);
  assert.deepEqual(counts, { unknown: 1 });
});

test('recordSubagentInvocation: 返り値は渡した counts と同一 object', () => {
  const counts = {};
  const result = recordSubagentInvocation(counts, 'dev-planner');
  assert.equal(result, counts);
});

// ---- buildSubagentInvocations ----

test('buildSubagentInvocations: total は counts 全値の合計', () => {
  const counts = { implementer: 3, evaluator: 2, 'pr-reviewer': 1 };
  const result = buildSubagentInvocations(counts);
  assert.equal(result.total, 6);
});

test('buildSubagentInvocations: counts 空 → total=0, by_type={}', () => {
  const result = buildSubagentInvocations({});
  assert.deepEqual(result, { total: 0, by_type: {} });
});

test('buildSubagentInvocations: by_type はキーを sort した新 object', () => {
  const counts = { 'pr-reviewer': 1, 'dev-planner': 2, evaluator: 3 };
  const result = buildSubagentInvocations(counts);
  assert.deepEqual(Object.keys(result.by_type), ['dev-planner', 'evaluator', 'pr-reviewer']);
  assert.deepEqual(result.by_type, { 'dev-planner': 2, evaluator: 3, 'pr-reviewer': 1 });
});

test('buildSubagentInvocations: 渡した counts を mutate しない', () => {
  const counts = { 'pr-reviewer': 1, 'dev-planner': 2 };
  const before = JSON.stringify(counts);
  buildSubagentInvocations(counts);
  assert.equal(JSON.stringify(counts), before);
});

test('buildSubagentInvocations: by_type は counts と別 object 参照', () => {
  const counts = { implementer: 1 };
  const result = buildSubagentInvocations(counts);
  assert.notEqual(result.by_type, counts);
});
