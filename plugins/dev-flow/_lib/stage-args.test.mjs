// stage-args.test.mjs — 工程の workflow に渡す引数の形の検証（_lib/stage-args.mjs）と、それを使う子
// （.claude/workflows/dev-flow-finalize.js）が欠けたキー・型違いの引数で throw することを pin する。
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateStageArgs, stageArgType } from './stage-args.mjs';
import { makeDevFlowSandbox, makeRecordingSandbox, devFlowResponder, runWorkflowCapture, FINALIZE_WORKFLOW } from './test-helpers/vm-sandbox.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const devFlowSrc = readFileSync(join(HERE, '..', '.claude', 'workflows', 'dev-flow.js'), 'utf8');
const finalizeSrc = readFileSync(join(HERE, '..', '.claude', 'workflows', 'dev-flow-finalize.js'), 'utf8');

const SPEC = { issue: 'string', repo: 'string|null', iterate: 'object|null', ids: 'array', pr_number: 'string|number' };
const VALID = { issue: '1', repo: null, iterate: { status: 'lgtm' }, ids: [0], pr_number: 1 };

test('[stage-args] spec どおりの値はそのまま返す（null を許す型・union・spec に無いキーは通す）', () => {
  const value = { ...VALID, extra: () => {} };
  assert.equal(validateStageArgs('t', value, SPEC), value);
  assert.doesNotThrow(() => validateStageArgs('t', { ...VALID, repo: 'acme/x', iterate: null, pr_number: '7' }, SPEC));
});

test('[stage-args] 必須のキーが欠けている（キーが無い・undefined）と、どのキーかを書いて throw する', () => {
  const { repo, ...missing } = VALID;
  assert.throws(() => validateStageArgs('dev-flow-finalize: args', missing, SPEC), /^Error: dev-flow-finalize: args: 必須のキー repo が無い$/);
  assert.throws(() => validateStageArgs('t', { ...VALID, ids: undefined }, SPEC), /必須のキー ids が無い/);
});

test('[stage-args] 型が違うと、期待した型と受けた型を書いて throw する（null を許さない型への null・array と object の取り違え）', () => {
  assert.throws(() => validateStageArgs('t', { ...VALID, issue: 1 }, SPEC), /キー issue の型が string でない（受信: number）/);
  assert.throws(() => validateStageArgs('t', { ...VALID, ids: null }, SPEC), /キー ids の型が array でない（受信: null）/);
  assert.throws(() => validateStageArgs('t', { ...VALID, iterate: [] }, SPEC), /キー iterate の型が object\|null でない（受信: array）/);
});

test('[stage-args] 引数が object でない・spec の型が不明なら throw する', () => {
  assert.throws(() => validateStageArgs('t', '{"issue":"1"}', SPEC), /object が必要（受信: string）/);
  assert.throws(() => validateStageArgs('t', null, SPEC), /object が必要（受信: null）/);
  assert.throws(() => validateStageArgs('t', VALID, { issue: 'str' }), /spec のキー issue の型 str/);
  assert.equal(stageArgType([]), 'array');
  assert.equal(stageArgType(null), 'null');
});

// dev-flow.js が実際に渡す args（connectFinalize:false の stub で受け取る）を基準に、1 キーだけ壊して子を起動する。
async function capturedFinalizeArgs() {
  let captured = null;
  const workflow = async (name, a) => {
    if (name === FINALIZE_WORKFLOW) { captured = JSON.parse(JSON.stringify(a)); return null; }
    return { status: 'lgtm', iterations: 1, fixes_applied: 0 };
  };
  const { ctx } = makeDevFlowSandbox({ workflow });
  const { error } = await runWorkflowCapture(devFlowSrc, ctx, '.claude/workflows/dev-flow.js', { connectFinalize: false });
  assert.equal(error, null, `dev-flow.js の run が throw した: ${error?.message}`);
  assert.ok(captured, 'dev-flow.js が dev-flow-finalize を起動していない');
  return captured;
}

async function runFinalize(args) {
  const { ctx, calls } = makeRecordingSandbox(devFlowResponder(), { args });
  const { result, error } = await runWorkflowCapture(finalizeSrc, ctx, '.claude/workflows/dev-flow-finalize.js');
  return { result, error, calls };
}

test('[stage-args] dev-flow-finalize.js は dev-flow.js が渡す args なら throw せず Merge tier まで進む', async () => {
  const { result, error, calls } = await runFinalize(await capturedFinalizeArgs());
  assert.equal(error, null, `正しい args で子が throw した: ${error?.message}`);
  assert.equal(result?.merge_tier, 'REVIEW');
  assert.ok(calls.some((c) => c.label === 'post-summary'), '子が終端サマリーを投稿していない');
});

test('[stage-args] dev-flow-finalize.js は必須のキーが欠けた args で agent を起動せずに throw する', async () => {
  const { pr_url, ...args } = await capturedFinalizeArgs();
  const { error, calls } = await runFinalize(args);
  assert.match(error?.message ?? '', /dev-flow-finalize: args: 必須のキー pr_url が無い/);
  assert.equal(calls.length, 0, `throw の前に agent を起動した: ${calls.map((c) => c.label).join(', ')}`);

  const withState = await capturedFinalizeArgs();
  delete withState.state.ledger;
  const nested = await runFinalize(withState);
  assert.match(nested.error?.message ?? '', /dev-flow-finalize: args\.state: 必須のキー ledger が無い/);
});

test('[stage-args] dev-flow-finalize.js は型の違う args で agent を起動せずに throw する', async () => {
  const args = await capturedFinalizeArgs();
  const { error, calls } = await runFinalize({ ...args, ci_ac_indexes: 'AC-1' });
  assert.match(error?.message ?? '', /dev-flow-finalize: args: キー ci_ac_indexes の型が array でない（受信: string）/);
  assert.equal(calls.length, 0, `throw の前に agent を起動した: ${calls.map((c) => c.label).join(', ')}`);
});
