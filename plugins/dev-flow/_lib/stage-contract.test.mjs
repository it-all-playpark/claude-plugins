import { test } from 'vitest';
import assert from 'node:assert/strict';
import { stageShapeErrors, validateStageArgs } from './stage-contract.mjs';

const SPEC = { issue: 'string', repo: 'string|null', pr: { pr_number: 'string|number' }, iterate: 'object|null', list: 'array' };
const OK = { issue: '1', repo: null, pr: { pr_number: 5 }, iterate: { status: 'lgtm' }, list: [] };

test('[stage-contract] spec を満たす引数はそのまま返す（spec に無いキーは見ない）', () => {
  const args = { ...OK, extra: 1 };
  assert.equal(validateStageArgs('stage-x', args, SPEC), args);
  assert.deepEqual(stageShapeErrors(args, SPEC), []);
});

test('[stage-contract] 必須のキーが欠けていれば throw する（入れ子・undefined も欠落）', () => {
  const { repo: _r, ...missing } = OK;
  assert.throws(() => validateStageArgs('stage-x', missing, SPEC), /^Error: stage-x: 引数の形が不正 — repo: 欠落$/);
  assert.throws(() => validateStageArgs('stage-x', { ...OK, pr: {} }, SPEC), /pr\.pr_number: 欠落/);
  assert.throws(() => validateStageArgs('stage-x', { ...OK, iterate: undefined }, SPEC), /iterate: 欠落/);
});

test('[stage-contract] 型が違えば throw する（null・配列・object を区別する）', () => {
  assert.throws(() => validateStageArgs('stage-x', { ...OK, issue: 1 }, SPEC), /issue: string が必要（受信: number）/);
  assert.throws(() => validateStageArgs('stage-x', { ...OK, list: {} }, SPEC), /list: array が必要（受信: object）/);
  assert.throws(() => validateStageArgs('stage-x', { ...OK, iterate: [] }, SPEC), /iterate: object\|null が必要（受信: array）/);
  assert.throws(() => validateStageArgs('stage-x', { ...OK, pr: null }, SPEC), /pr: object が必要（受信: null）/);
  assert.throws(() => validateStageArgs('stage-x', null, SPEC), /\(root\): object が必要（受信: null）/);
});

test('[stage-contract] 違反は全部まとめて返す', () => {
  assert.deepEqual(stageShapeErrors({ ...OK, issue: 1, list: undefined }, SPEC), ['issue: string が必要（受信: number）', 'list: 欠落']);
});
