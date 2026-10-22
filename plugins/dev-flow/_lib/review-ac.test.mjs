// _lib/review-ac.mjs（pr-reviewer への AC 注入ブロック）の単体テスト + 両経路の配線 pin。
//
// 守っている不変条件:
//   - AC が取得できない経路（単体起動の /pr-iterate）では空文字を返し、prompt が従来どおりになる
//     （fail-open。AC 取得のために gh 呼び出しを増やさない設計）
//   - pr-iterate（review#i）と dev-flow lite route（pr-review-lite）の**両方**が注入する
//     （片側だけだと 2 経路で reviewer の見るものが食い違う）
//   - ゲート境界を変えない: 本 issue は pr-reviewer への入力追加のみで、AC 未達の blocking 判定は
//     既存の merge tier HOLD が担う。prompt が severity 引き上げを指示していないことを pin する。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { acceptanceCriteriaBlock } from './review-ac.mjs';
import { makeDevFlowSandbox, makePrIterateSandbox, runWorkflowCapture, assertNoCrash, analyzeArgs } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowSrc = readFileSync(join(repoRoot, '.claude/workflows/dev-flow.js'), 'utf8');
const prIterateSrc = readFileSync(join(repoRoot, '.claude/workflows/pr-iterate.js'), 'utf8');

// ============================================================
// fail-open: AC が無い経路では注入しない
// ============================================================

test('[review-ac] undefined は空文字（単体起動の /pr-iterate 経路）', () => {
  assert.equal(acceptanceCriteriaBlock(undefined), '');
});

test('[review-ac] null / 非配列は空文字', () => {
  assert.equal(acceptanceCriteriaBlock(null), '');
  assert.equal(acceptanceCriteriaBlock('AC1'), '');
  assert.equal(acceptanceCriteriaBlock({ 0: 'AC1' }), '');
});

test('[review-ac] 空配列は空文字', () => {
  assert.equal(acceptanceCriteriaBlock([]), '');
});

test('[review-ac] 空白のみ / 非文字列だけの配列は空文字', () => {
  assert.equal(acceptanceCriteriaBlock(['', '   ', '\n']), '');
  assert.equal(acceptanceCriteriaBlock([null, 42, {}]), '');
});

// ============================================================
// 注入内容
// ============================================================

test('[review-ac] AC を 1 始まりで番号付けする', () => {
  const block = acceptanceCriteriaBlock(['first', 'second']);
  assert.ok(block.includes('1. first'), block);
  assert.ok(block.includes('2. second'), block);
});

test('[review-ac] 非文字列・空要素は除外したうえで採番し直す', () => {
  const block = acceptanceCriteriaBlock(['first', '', null, 'second']);
  assert.ok(block.includes('1. first'), block);
  assert.ok(block.includes('2. second'), block);
  assert.ok(!block.includes('3.'), '除外した要素の分だけ番号が飛んではならない');
});

test('[review-ac] 各要素は trim される', () => {
  assert.ok(acceptanceCriteriaBlock(['  padded  ']).includes('1. padded'));
});

test('[review-ac] 決定論的（同入力 -> 同出力）', () => {
  const input = ['a', 'b'];
  assert.equal(acceptanceCriteriaBlock(input), acceptanceCriteriaBlock(input));
});

test('[review-ac] 末尾は改行で終わる（後続 prompt と結合しても崩れない）', () => {
  assert.ok(acceptanceCriteriaBlock(['a']).endsWith('\n'));
});

// ============================================================
// ゲート境界: severity の引き上げを指示しない
// ============================================================

test('[review-ac] AC 未達を理由に critical へ引き上げないことを prompt で明示する', () => {
  const block = acceptanceCriteriaBlock(['a']);
  assert.ok(
    block.includes('critical へ引き上げない'),
    'AC 未達だけを理由に severity を上げない旨が prompt に含まれるべき（ゲート境界を変えない）',
  );
});

// ============================================================
// scope='delta': fix delta round は AC の新規未達探しを指示しない
// ============================================================

test("[review-ac] scope 省略時は既定 'full' と同一出力（後方互換）", () => {
  assert.equal(acceptanceCriteriaBlock(['a']), acceptanceCriteriaBlock(['a'], { scope: 'full' }));
});

test("[review-ac] scope='full' は「未達があれば issue として報告せよ」を含む", () => {
  const block = acceptanceCriteriaBlock(['a'], { scope: 'full' });
  assert.ok(block.includes('未達があれば issue として報告せよ'), block);
});

test("[review-ac] scope='delta' は「未達があれば issue として報告せよ」を含まない（delta 外の AC 未達探索を誘発しない）", () => {
  const block = acceptanceCriteriaBlock(['a'], { scope: 'delta' });
  assert.ok(!block.includes('未達があれば issue として報告せよ'), `delta round の prompt に新規 AC 未達探索の指示が残っている: ${block}`);
});

test("[review-ac] scope='delta' は既出 findings 中の AC 未達解消確認にだけ限定する文言を含む", () => {
  const block = acceptanceCriteriaBlock(['a'], { scope: 'delta' });
  assert.ok(block.includes('既出 findings'), block);
  assert.ok(block.includes('delta で解消されたか'), block);
  assert.ok(block.includes('delta 外の AC 未達を新規 finding として報告するな'), block);
});

test("[review-ac] scope='delta' でも severity 引き上げ禁止の文言は残す（ゲート境界を変えない）", () => {
  const block = acceptanceCriteriaBlock(['a'], { scope: 'delta' });
  assert.ok(block.includes('critical へ引き上げない'), block);
});

test('[review-ac] AC が空のときは scope に関わらず空文字（fail-open）', () => {
  assert.equal(acceptanceCriteriaBlock([], { scope: 'delta' }), '');
  assert.equal(acceptanceCriteriaBlock(undefined, { scope: 'delta' }), '');
});

// ============================================================
// 配線: 両経路が注入している（VM 挙動で観測。issue #636 でソース regex から置換）
// ============================================================

const AC = ['AC_SENTINEL_A', 'AC_SENTINEL_B'];
// REQ は args.setup.analyze（prerun の analyze 段）から組まれる — AC を sentinel に差し替える
const AC_ARGS = { args: analyzeArgs(1, { acceptance_criteria: AC }) };
// clean-micro-lite が成立する override（lite-route-routing.test.mjs と同型。realized 0 files → micro）
const LITE_OVERRIDES = {
  'plan#micro': { summary: 'p', serial: [] },
  'danger-grep': { risk: { ok: true, hits: [] }, files: [], struct: null, diffhash: null, secreview: { target: false, reasons: [] } },
};
const BLOCKING_REVIEW = { decision: 'request_changes', issues: [{ severity: 'major', topic: 't', file: 'a.js', line: 1, description: 'd', suggestion: null }], summary: 'ng' };

function makeWorkflowRecorder() {
  const launches = [];
  const workflow = async (name, args) => {
    launches.push({ name, args });
    return { status: 'lgtm', iterations: 1, fixes_applied: 0 };
  };
  return { workflow, launches };
}

test('[review-ac] pr-iterate: args.acceptance_criteria を review prompt に注入する', async () => {
  const { ctx, calls } = makePrIterateSandbox({ args: { pr: '5', acceptance_criteria: AC } });
  const { error } = await runWorkflowCapture(prIterateSrc, ctx, '.claude/workflows/pr-iterate.js');
  assertNoCrash(error, 'pr-iterate-ac');
  const review = calls.find((c) => c.label === 'review#1');
  assert.ok(review, 'review#1 が dispatch されていない');
  assert.ok(review.prompt.includes('1. AC_SENTINEL_A') && review.prompt.includes('2. AC_SENTINEL_B'), `review#1 prompt に採番済み AC が注入されていない:\n${review.prompt.slice(-600)}`);
});

test('[review-ac] pr-iterate 単体起動（AC なし）: review prompt に AC ブロックを注入しない（fail-open）', async () => {
  const { ctx, calls } = makePrIterateSandbox();
  const { error } = await runWorkflowCapture(prIterateSrc, ctx, '.claude/workflows/pr-iterate.js');
  assertNoCrash(error, 'pr-iterate-noac');
  const review = calls.find((c) => c.label === 'review#1');
  assert.ok(review, 'review#1 が dispatch されていない');
  assert.ok(!review.prompt.includes('acceptance criteria'), '単体起動なのに review#1 prompt に AC ブロックが注入されている');
});

test('[review-ac] dev-flow lite route: pr-review-lite prompt に analyze の AC を注入する', async () => {
  const { ctx, calls } = makeDevFlowSandbox({ overrides: { ...LITE_OVERRIDES }, extra: AC_ARGS });
  const { error } = await runWorkflowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'lite-ac');
  const lite = calls.find((c) => c.label === 'pr-review-lite');
  assert.ok(lite, `pr-review-lite が dispatch されていない（lite route 不成立）: ${calls.map((c) => c.label).join(', ')}`);
  assert.ok(lite.prompt.includes('1. AC_SENTINEL_A') && lite.prompt.includes('2. AC_SENTINEL_B'), 'pr-review-lite prompt に採番済み AC が注入されていない');
});

// nested pr-iterate 起動は 3 経路（full route / lite の review escalate / lite の CI 非 green）あり、
// いずれも同一の args（acceptance_criteria を含む）で起動する（issue #550 案3: 1 本の変数組み立てへ統合）。
const NESTED_LAUNCH_SCENARIOS = {
  'full route': {},
  'lite review escalate': { ...LITE_OVERRIDES, 'pr-review-lite': BLOCKING_REVIEW },
  'lite CI 非 green': { ...LITE_OVERRIDES, 'ci-check-lite': { status: 'failed', passed: 0, failed: 1, pending: 0, skipped: 0, failed_checks: ['build'], waited_seconds: 0, poll_attempts: 1 } },
};

for (const [name, overrides] of Object.entries(NESTED_LAUNCH_SCENARIOS)) {
  test(`[review-ac] dev-flow nested pr-iterate 起動（${name}）が acceptance_criteria を args で渡す`, async () => {
    const { workflow, launches } = makeWorkflowRecorder();
    const { ctx, calls } = makeDevFlowSandbox({ overrides, workflow, extra: AC_ARGS });
    const { error } = await runWorkflowCapture(devFlowSrc, ctx);
    assertNoCrash(error, name);
    const wentLite = calls.some((c) => c.label === 'pr-review-lite');
    assert.equal(wentLite, name.startsWith('lite'), `${name}: lite route の通過有無が想定と異なる（pr-review-lite ${wentLite ? 'あり' : 'なし'}）`);
    const nested = launches.filter((l) => l.name === 'dev-flow:pr-iterate-run');
    assert.equal(nested.length, 1, `${name}: nested pr-iterate は 1 回起動されるはずだが ${nested.length} 回`);
    assert.equal(JSON.stringify(nested[0].args?.acceptance_criteria), JSON.stringify(AC), `${name}: nested 起動 args の acceptance_criteria が analyze の AC と一致しない: ${JSON.stringify(nested[0].args)}`);
    assert.equal(nested[0].args?.nested?.caller, 'dev-flow');
  });
}
