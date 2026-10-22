// Unit tests for _lib/test-helpers/vm-sandbox.mjs and _lib/test-helpers/dev-flow-markers.mjs
// TDD: このファイルを先に書き、モジュール未作成の状態で red → モジュール実装後 green になることを確認する。
//
// Placement: _lib 直下フラット配置（AC#3 の `node --test _lib/*.test.mjs` glob に乗せるため）

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');

import {
  makeRecordingSandbox, runDevFlowInSandbox, JS_GLOBALS,
  runWorkflowCapture, devFlowResponder, makeDevFlowSandbox, makePrIterateSandbox,
  devFlowArgs, STANDARD_FILES,
} from './test-helpers/vm-sandbox.mjs';
import { greenFixAuditEcho } from './test-helpers/dev-flow-markers.mjs';

const prIteratePath = join(repoRoot, '.claude/workflows/pr-iterate.js');

// ============================================================
// makeRecordingSandbox: calls 記録 / responder 委譲
// ============================================================

test('[test-helpers] makeRecordingSandbox: {ctx, calls} を返すこと', () => {
  const responder = () => ({ result: 'ok' });
  const { ctx, calls } = makeRecordingSandbox(responder);
  assert.ok(ctx != null, 'ctx が返されること');
  assert.ok(Array.isArray(calls), 'calls が配列であること');
});

test('[test-helpers] makeRecordingSandbox: agent() 呼び出しが calls に記録されること', async () => {
  const responder = ({ label, agentType, prompt }) => ({ label, agentType, prompt });
  const { ctx, calls } = makeRecordingSandbox(responder);

  // ctx 経由で agent を呼ぶ — vm.runInContext で呼び出す
  const script = new vm.Script(`agent('P', { label: 'x', agentType: 'y' })`);
  const resultPromise = script.runInContext(ctx);
  await resultPromise;

  assert.equal(calls.length, 1, 'calls に 1 件記録されること');
  assert.equal(calls[0].label, 'x');
  assert.equal(calls[0].agentType, 'y');
  assert.equal(calls[0].prompt, 'P');
});

test('[test-helpers] makeRecordingSandbox: responder の返り値が agent() の返り値になること', async () => {
  const responder = () => ({ status: 'DONE', task_id: 't1' });
  const { ctx } = makeRecordingSandbox(responder);

  const script = new vm.Script(`agent('prompt', { label: 'impl', agentType: 'implementer' })`);
  const result = await script.runInContext(ctx);

  assert.deepEqual(result, { status: 'DONE', task_id: 't1' });
});

test('[test-helpers] makeRecordingSandbox: responder が undefined を返したら agent() は null を返すこと', async () => {
  const responder = () => undefined;
  const { ctx } = makeRecordingSandbox(responder);

  const script = new vm.Script(`agent('p', {})`);
  const result = await script.runInContext(ctx);

  assert.equal(result, null);
});

test('[test-helpers] makeRecordingSandbox: opts が省略されても calls に空文字列で記録されること', async () => {
  const responder = () => null;
  const { ctx, calls } = makeRecordingSandbox(responder);

  const script = new vm.Script(`agent('hello')`);
  await script.runInContext(ctx);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].label, '');
  assert.equal(calls[0].agentType, '');
  assert.equal(calls[0].prompt, 'hello');
});

// ============================================================
// makeRecordingSandbox: JS_GLOBALS と control fns の expose
// ============================================================

test('[test-helpers] makeRecordingSandbox: ctx に JSON が expose されていること', () => {
  const { ctx } = makeRecordingSandbox(() => null);
  // vm.runInContext で JSON.stringify が使えることを確認
  const result = vm.runInContext(`JSON.stringify({a:1})`, ctx);
  assert.equal(result, '{"a":1}');
});

test('[test-helpers] makeRecordingSandbox: ctx に Math が expose されていること', () => {
  const { ctx } = makeRecordingSandbox(() => null);
  const result = vm.runInContext(`Math.max(1, 2)`, ctx);
  assert.equal(result, 2);
});

test('[test-helpers] makeRecordingSandbox: ctx に control fns (phase/log/workflow/args) が expose されていること', () => {
  const { ctx } = makeRecordingSandbox(() => null);

  // phase, log は呼び出せる（void 関数）
  vm.runInContext(`phase('step1')`, ctx);
  vm.runInContext(`log('msg')`, ctx);

  // workflow は async 関数
  const wfType = vm.runInContext(`typeof workflow`, ctx);
  assert.equal(wfType, 'function');

  // args は {issue, setup} object 形
  const argsType = vm.runInContext(`typeof args`, ctx);
  assert.equal(argsType, 'object');
  const argsIssue = vm.runInContext(`args.issue`, ctx);
  assert.equal(argsIssue, '1');
  const setupOk = vm.runInContext(`args.setup.ok`, ctx);
  assert.equal(setupOk, true);
  const setupWorktree = vm.runInContext(`args.setup.worktree`, ctx);
  assert.equal(setupWorktree, '/tmp/wt');
});

test('[test-helpers] makeRecordingSandbox: extraSandbox で上書きできること', () => {
  const { ctx } = makeRecordingSandbox(() => null, { args: devFlowArgs('999') });
  const result = vm.runInContext(`args.issue`, ctx);
  assert.equal(result, '999');
});

// ============================================================
// devFlowArgs: dev-flow.js 用 args の既定形（{issue, setup}）
// ============================================================

test('[test-helpers] devFlowArgs: 既定で issue:"1", setup.repo キー無し, setup.epoch===1000 であること', () => {
  const args = devFlowArgs();
  assert.equal(args.issue, '1');
  assert.equal(Object.prototype.hasOwnProperty.call(args.setup, 'repo'), false, 'setup.repo キーが無いこと');
  assert.equal(args.setup.epoch, 1000);
});

test('[test-helpers] devFlowArgs: overrides で issue:"7", setup.branch/repo/epoch が上書きされること', () => {
  const args = devFlowArgs(7, { repo: 'acme/skills', epoch: 1234 });
  assert.equal(args.issue, '7');
  assert.equal(args.setup.branch, 'feature/issue-7');
  assert.equal(args.setup.repo, 'acme/skills');
  assert.equal(args.setup.epoch, 1234);
});

test('[test-helpers] devFlowArgs: devFlowArgs("999") の args.issue が "999" であること', () => {
  const args = devFlowArgs('999');
  assert.equal(args.issue, '999');
});

// ============================================================
// makeRecordingSandbox: parallel() / pipeline() は sandbox に置かない（issue #673）。
// dev-flow.js の Implement は dev-implementer の単一 serial spawn で fan-out を持たないため、
// stub があると「production が pipeline() を呼んでも完走する」偽陽性になる。
// ============================================================

test('[test-helpers] makeRecordingSandbox: parallel() / pipeline() が sandbox に注入されないこと', () => {
  const { ctx } = makeRecordingSandbox(() => null);
  assert.equal(typeof ctx.parallel, 'undefined', 'parallel() stub が sandbox に残っている');
  assert.equal(typeof ctx.pipeline, 'undefined', 'pipeline() stub が sandbox に残っている');
});

// ============================================================
// JS_GLOBALS: エクスポートされた定数の確認
// ============================================================

test('[test-helpers] JS_GLOBALS: 15 個の組み込みが含まれること', () => {
  const expected = ['console', 'JSON', 'Math', 'String', 'Number', 'Boolean', 'Array', 'Object', 'Error', 'RegExp', 'Promise', 'Symbol', 'Map', 'Set', 'Date'];
  for (const key of expected) {
    assert.ok(key in JS_GLOBALS, `JS_GLOBALS に ${key} が含まれること`);
  }
  assert.equal(Object.keys(JS_GLOBALS).length, expected.length, `JS_GLOBALS のキーが正確に ${expected.length} 個であること`);
});

// ============================================================
// runDevFlowInSandbox: 最小擬似ソースの strip 実行
// ============================================================

test('[test-helpers] runDevFlowInSandbox: 最小擬似ソースを ReferenceError/SyntaxError なく実行できること', async () => {
  // 最小擬似ソース: export const を含む変数宣言と agent 呼び出し
  const minimalSrc = `export const X = 1;\nawait agent('p', {label:'worktree'});\n`;
  const responder = () => ({ worktree: '/tmp/wt', branch: 'feature/test' });
  const { ctx } = makeRecordingSandbox(responder);

  const err = await runDevFlowInSandbox(minimalSrc, ctx);

  if (err && (err.name === 'ReferenceError' || err.name === 'SyntaxError')) {
    assert.fail(`runDevFlowInSandbox が ${err.name} を throw した: ${err.message}`);
  }
});

test('[test-helpers] runDevFlowInSandbox: export function を strip して関数が呼び出せること', async () => {
  const src = `export function greet() { return 'hello'; }\nconst r = greet();\n`;
  const { ctx } = makeRecordingSandbox(() => null);

  const err = await runDevFlowInSandbox(src, ctx);

  if (err && (err.name === 'ReferenceError' || err.name === 'SyntaxError')) {
    assert.fail(`runDevFlowInSandbox が ${err.name} を throw した: ${err.message}`);
  }
});

test('[test-helpers] runDevFlowInSandbox: 実際の dev-flow.js ソースを ReferenceError/SyntaxError なく実行できること', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  // 最小限のレスポンダー（全 label に対して適切な応答）
  const responder = ({ label, agentType }) => {
    if (label === 'worktree') return { worktree: '/tmp/wt', branch: 'feature/issue-1' };
    if (label.startsWith('analyze')) return { summary: 's', acceptance_criteria: ['a'], issue_type: 'fix', scope: 'src' };
    if (label.startsWith('danger-grep')) return { ok: true, hits: [] };
    if (label.startsWith('test')) return { tests: 'passed', green: true, summary: '' };
    if (agentType === 'dev-flow:evaluator') return { verdict: 'pass', total: 100, threshold: 80, feedback: [], feedback_level: 'implementation', ac_results: [], security_clearance: [] };
    if (label === 'realized-diff' || label === 'declared-path-check' || label === 'changed-files') return { files: [] };
    if (label.startsWith('pr')) return { pr_url: 'http://x', pr_number: 1, committed: true };
    if (agentType === 'dev-flow:dev-implementer') return { status: 'DONE', task_id: 't', files: [], summary: '', concerns: [] };
    if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) return { hash: 'H', empty: false };
    return null;
  };
  const { ctx } = makeRecordingSandbox(responder);

  const err = await runDevFlowInSandbox(src, ctx);

  if (err && (err.name === 'ReferenceError' || err.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${err.name}: ${err.message}`);
  }
});

// ============================================================
// greenFixAuditEcho: green-fix 監査 concern の構造 echo（`[#n] <summary>`）
// ============================================================

test('[test-helpers] greenFixAuditEcho: 番号付き echo 文字列を返すこと', () => {
  assert.equal(greenFixAuditEcho(1, 'typo修正'), '[#1] typo修正');
  assert.equal(greenFixAuditEcho(2, ''), '[#2] ');
});

// ============================================================
// (a) calls[].opts / calls[].schema の記録
// ============================================================

test('[test-helpers] (a) calls[0].opts.schema が agent() に渡した schema と同一参照であること、calls[0].opts.label が "x" であること', async () => {
  const schema = { type: 'object', required: ['ok'] };
  const { ctx, calls } = makeRecordingSandbox(() => ({ ok: true }));

  const script = new vm.Script(`agent('P', { label: 'x', agentType: 'y', schema: SCHEMA })`);
  // SCHEMA を ctx に注入して参照同一性を検証する
  Object.assign(ctx, { SCHEMA: schema });
  await script.runInContext(ctx);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.label, 'x');
  assert.equal(calls[0].schema, schema, 'calls[0].schema は agent() に渡した schema と同一参照であること');
  assert.equal(calls[0].opts.schema, schema, 'calls[0].opts.schema も同一参照であること');
});

// ============================================================
// (b) logs/phases 既定記録・extraSandbox 上書き
// ============================================================

test('[test-helpers] (b) 既定の log/phase が logs/phases に記録されること', async () => {
  const { ctx, logs, phases } = makeRecordingSandbox(() => null);

  vm.runInContext(`log('hello')`, ctx);
  vm.runInContext(`phase('Setup')`, ctx);

  assert.deepEqual(logs, ['hello']);
  assert.deepEqual(phases, ['Setup']);
});

test('[test-helpers] (b) extraSandbox.log を渡すとそれが使われ logs は空のままであること', async () => {
  const seen = [];
  const { ctx, logs } = makeRecordingSandbox(() => null, { log: (m) => seen.push(m) });

  vm.runInContext(`log('hello')`, ctx);

  assert.deepEqual(seen, ['hello']);
  assert.deepEqual(logs, [], 'extraSandbox.log が使われた場合、既定 logs 配列には記録されないこと');
});

// ============================================================
// (c) runWorkflowCapture: {result, error} を返す
// ============================================================

test('[test-helpers] (c) runWorkflowCapture: 最小ソースで {result, error:null} を返すこと', async () => {
  const src = `export const X = 1;\nreturn { ok: 1 };\n`;
  const { ctx } = makeRecordingSandbox(() => null);

  const { result, error } = await runWorkflowCapture(src, ctx);

  assert.equal(error, null);
  // result は vm context 内で生成されたオブジェクト（別 realm）のため、
  // deepEqual ではなく JSON round-trip 経由で構造のみ比較する。
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: 1 });
});

test('[test-helpers] (c) runWorkflowCapture: throw するソースで error が非 null になること', async () => {
  const src = `throw new Error('boom');\n`;
  const { ctx } = makeRecordingSandbox(() => null);

  const { result, error } = await runWorkflowCapture(src, ctx);

  assert.equal(result, null);
  assert.ok(error != null);
  assert.equal(error.message, 'boom');
});

// ============================================================
// (d) devFlowResponder: overrides の関数/値/null の 3 形、既定 'danger-grep' 形状
// ============================================================

test('[test-helpers] (d) devFlowResponder: overrides が関数の場合 {label,agentType,prompt,opts} で呼ばれその返り値が使われること', () => {
  const received = [];
  const responder = devFlowResponder({
    'my-label': (ctxArg) => { received.push(ctxArg); return { custom: true }; },
  });

  const result = responder({ label: 'my-label', agentType: 'y', prompt: 'p', opts: { foo: 1 } });

  assert.deepEqual(result, { custom: true });
  assert.equal(received.length, 1);
  assert.deepEqual(received[0], { label: 'my-label', agentType: 'y', prompt: 'p', opts: { foo: 1 } });
});

test('[test-helpers] (d) devFlowResponder: overrides が値の場合そのまま返ること', () => {
  const responder = devFlowResponder({ 'my-label': { fixed: 1 } });
  const result = responder({ label: 'my-label', agentType: 'y', prompt: 'p' });
  assert.deepEqual(result, { fixed: 1 });
});

test('[test-helpers] (d) devFlowResponder: overrides が null の場合 null が返ること', () => {
  const responder = devFlowResponder({ 'setup-base': null });
  const result = responder({ label: 'setup-base', agentType: 'y', prompt: 'p' });
  assert.equal(result, null);
});

test('[test-helpers] (d) devFlowResponder: 既定の "danger-grep" 応答が仕様どおりの形状であること（files は STANDARD_FILES 3 件 → 実効 shape standard）', () => {
  const responder = devFlowResponder();
  const result = responder({ label: 'danger-grep', agentType: 'dev-runner-haiku-ro', prompt: 'p' });
  assert.deepEqual(result, {
    risk: { ok: true, hits: [] },
    files: ['src/x.ts', 'src/y.ts', 'src/z.ts'],
    struct: null,
    diffhash: { hash: 'AAA', empty: false },
    secreview: { target: false, reasons: [] },
  });
  assert.deepEqual(STANDARD_FILES, ['src/x.ts', 'src/y.ts', 'src/z.ts']);
  // dev-implementer 既定応答も同じ 3 件を申告する（宣言外 0 件で shape だけが standard になる）
  const impl = responder({ label: 'impl:serial:issue-1', agentType: 'dev-flow:dev-implementer', prompt: 'p' });
  assert.deepEqual(impl.files, STANDARD_FILES);
});

// ============================================================
// (e) makeDevFlowSandbox: dev-flow.js 実 run smoke
// ============================================================

test('[test-helpers] (e) makeDevFlowSandbox: dev-flow.js 実 run が error===null かつ merge_tier が REVIEW/HOLD で完走すること', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx } = makeDevFlowSandbox({ issue: 636 });

  const { result, error } = await runWorkflowCapture(src, ctx, '.claude/workflows/dev-flow.js');

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }
  assert.equal(error, null, `error は null であるべきだが: ${error?.stack ?? error}`);
  assert.ok(
    result?.merge_tier === 'REVIEW' || result?.merge_tier === 'HOLD',
    `merge_tier は 'REVIEW' か 'HOLD' であるべきだが '${result?.merge_tier}' だった`,
  );
});

// ============================================================
// (f) makePrIterateSandbox: pr-iterate.js 実 run smoke
// ============================================================

test('[test-helpers] (f) makePrIterateSandbox: pr-iterate.js 実 run（args "5"）が result.status==="lgtm" で完走すること', async () => {
  const src = readFileSync(prIteratePath, 'utf8');
  const { ctx } = makePrIterateSandbox({ args: '5' });

  const { result, error } = await runWorkflowCapture(src, ctx, '.claude/workflows/pr-iterate.js');

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`pr-iterate.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }
  assert.equal(error, null, `error は null であるべきだが: ${error?.stack ?? error}`);
  assert.equal(result?.status, 'lgtm', `result.status は 'lgtm' であるべきだが '${result?.status}' だった`);
});
