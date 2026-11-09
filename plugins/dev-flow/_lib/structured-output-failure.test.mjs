import { test } from 'vitest';
import assert from 'node:assert/strict';
import { isStructuredOutputFailure } from './structured-output-failure.mjs';

test('isStructuredOutputFailure: StructuredOutput を呼ばずに終わった失敗は true', () => {
  assert.equal(isStructuredOutputFailure(new Error('agent({schema}): subagent completed without calling StructuredOutput (after in-conversation nudge)')), true);
  assert.equal(isStructuredOutputFailure('Agent completed without calling StructuredOutput'), true);
});

test('isStructuredOutputFailure: StructuredOutput の retry cap 超過は true', () => {
  assert.equal(isStructuredOutputFailure(new Error('agent({schema}): StructuredOutput retry cap (5) exceeded')), true);
  assert.equal(isStructuredOutputFailure('agent({schema}): StructuredOutput retry cap (7) exceeded'), true);
});

test('isStructuredOutputFailure: 他の失敗・null・undefined は false', () => {
  assert.equal(isStructuredOutputFailure(new Error('guard rejected this command')), false);
  assert.equal(isStructuredOutputFailure(new Error('isolation guard denied')), false);
  assert.equal(isStructuredOutputFailure('agent type not found'), false);
  assert.equal(isStructuredOutputFailure(null), false);
  assert.equal(isStructuredOutputFailure(undefined), false);
});
