import { test } from 'vitest';
import assert from 'node:assert/strict';
import { EVALUATE_ARGS_SPEC, EVALUATE_RESULT_SPEC, stageShapeErrors, validateStageArgs } from './stage-contract.mjs';

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

// dev-flow-evaluate.js（Diff triage・Evaluate）の受け渡し。子は引数を validateStageArgs で、親は返り値を stageShapeErrors で確かめる。
const EVALUATE_ARGS = {
  issue: '1', repo: 'acme/app', base: 'main', worktree: '/tmp/wt', gate_policy: 'llm-major-advisory',
  state: {
    req: { acceptance_criteria: ['a'] }, plan: { serial: [] }, setup: { branch: 'feature/issue-1' }, concerns: [],
    val: { tests: 'passed', green: true }, validateDiffHash: null, dhPrompt: 'worktree-diff-hash /tmp/wt origin/main',
    greenFixCount: 0, greenFixIterations: [], implDroppedCount: 0,
    baseFailing: { env: [], ran: [] }, acVerify: [], localVerifyReimplCount: 0, acVerifyReimplCount: 0,
  },
  ci_ac_indexes: [],
  notes: { deletion: '', deps: '', turbopack: '', test_discovery: '' },
  test_commands: {
    source: 'runners', status: 'resolved', commands: null, sources: ['tests/run-unit.sh'],
    commands_file: '/tmp/test-commands-x/commands.json', error: null,
  },
  visual_snapshots: null,
};
const EVALUATE_RESULT = {
  state: {
    plan: { serial: [] }, ledger: { items: [] }, risk: { ok: true, hits: [] }, dangerHits: [], testsurfHits: [], testsurfPatterns: [],
    securityReview: { target: false, reasons: [], reviewer_context_changed: false },
    triage: { shape: 'standard', reason: 'r' }, EFFECTIVE_SHAPE: 'standard', evalForced: false,
    evalResult: { verdict: 'pass' }, evalDiffHash: 'H', secDiffHash: null,
    unsatisfiedAcByActor: { agent: [], human: [], ci: [] }, val: null, greenFixCount: 0, concerns: [],
    visualSnapshots: null,
  },
  redgreen_state_dir: null,
};

test('[stage-contract] EVALUATE_ARGS_SPEC: Validate までの state と注記を満たす引数は通し、欠けたキー・型違いは throw する', () => {
  assert.equal(validateStageArgs('dev-flow-evaluate', EVALUATE_ARGS, EVALUATE_ARGS_SPEC), EVALUATE_ARGS);
  const { dhPrompt: _d, ...stateWithoutDh } = EVALUATE_ARGS.state;
  assert.throws(() => validateStageArgs('dev-flow-evaluate', { ...EVALUATE_ARGS, state: stateWithoutDh }, EVALUATE_ARGS_SPEC),
    /^Error: dev-flow-evaluate: 引数の形が不正 — state\.dhPrompt: 欠落$/);
  assert.throws(() => validateStageArgs('dev-flow-evaluate', { ...EVALUATE_ARGS, state: { ...EVALUATE_ARGS.state, baseFailing: { env: [] } } }, EVALUATE_ARGS_SPEC),
    /state\.baseFailing\.ran: 欠落/);
  assert.throws(() => validateStageArgs('dev-flow-evaluate', { ...EVALUATE_ARGS, notes: { ...EVALUATE_ARGS.notes, deletion: null } }, EVALUATE_ARGS_SPEC),
    /notes\.deletion: string が必要（受信: null）/);
  assert.throws(() => validateStageArgs('dev-flow-evaluate', { ...EVALUATE_ARGS, ci_ac_indexes: {} }, EVALUATE_ARGS_SPEC),
    /ci_ac_indexes: array が必要（受信: object）/);
  const { commands_file: _c, ...tcWithoutFile } = EVALUATE_ARGS.test_commands;
  assert.throws(() => validateStageArgs('dev-flow-evaluate', { ...EVALUATE_ARGS, test_commands: tcWithoutFile }, EVALUATE_ARGS_SPEC),
    /test_commands\.commands_file: 欠落/);
  // visual_snapshots は宣言（object）か未設定（null）。欠落は未設定と同じに扱わない
  validateStageArgs('dev-flow-evaluate', { ...EVALUATE_ARGS, visual_snapshots: { command: 'pnpm test:visual', paths: ['tests/visual'] } }, EVALUATE_ARGS_SPEC);
  const { visual_snapshots: _v, ...withoutSnapshots } = EVALUATE_ARGS;
  assert.throws(() => validateStageArgs('dev-flow-evaluate', withoutSnapshots, EVALUATE_ARGS_SPEC), /visual_snapshots: 欠落/);
});

test('[stage-contract] EVALUATE_RESULT_SPEC: PR 工程が読む state と redgreen の state dir を検証し、欠けたキー・型違いを全部返す', () => {
  assert.deepEqual(stageShapeErrors(EVALUATE_RESULT, EVALUATE_RESULT_SPEC), []);
  const { redgreen_state_dir: _r, ...withoutDir } = EVALUATE_RESULT;
  assert.deepEqual(stageShapeErrors(withoutDir, EVALUATE_RESULT_SPEC), ['redgreen_state_dir: 欠落']);
  const broken = { ...EVALUATE_RESULT, state: { ...EVALUATE_RESULT.state, evalForced: 'yes', securityReview: { target: false, reasons: [] } } };
  assert.deepEqual(stageShapeErrors(broken, EVALUATE_RESULT_SPEC), [
    'state.securityReview.reviewer_context_changed: 欠落',
    'state.evalForced: boolean が必要（受信: string）',
  ]);
  const { visualSnapshots: _v, ...stateWithoutSnapshots } = EVALUATE_RESULT.state;
  assert.deepEqual(stageShapeErrors({ ...EVALUATE_RESULT, state: stateWithoutSnapshots }, EVALUATE_RESULT_SPEC), ['state.visualSnapshots: 欠落']);
  // runEval は evalForced の代わりにならない
  const { evalForced: _e, ...stateWithoutForced } = EVALUATE_RESULT.state;
  assert.deepEqual(stageShapeErrors({ ...EVALUATE_RESULT, state: { ...stateWithoutForced, runEval: true } }, EVALUATE_RESULT_SPEC), ['state.evalForced: 欠落']);
});
