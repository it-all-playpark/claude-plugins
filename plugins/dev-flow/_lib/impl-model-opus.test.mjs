// dev-implementer の既定 model が frontmatter の opus で、fable→opus fallback 機構が撤去されていることを
// 静的検査と dev-flow.js 全体の VM 実行で pin する（issue #705）。
//
//   (a) 静的: dev-flow.js と _lib 配下（本ファイルを除く）に fallback 機構のシンボルが無い。
//       references/capability-bound.md に fable→opus fallback と「既定 model fable」の記述が無い
//   (b) call site: Implement（impl）・BLOCKED 再実装（reimpl-blocked#b）・Evaluate 差し戻し（reimpl#i）・
//       empty-diff 差し戻し（reimpl-empty-diff）の dev-implementer call は opts に model キーを持たない
//       （frontmatter 既定で起動）。model を渡すのは green-fix#i / green-fix#retry-i の 'sonnet' だけ
//   (c) implementer の null は再試行されず 1 回で drop に計上される
//   (d) micro / standard / complex の spawn 数・Evaluate 回数が fallback 撤去前から journal handoff の 1 spawn 化分だけ減った値と一致する
//   (e) telemetry: impl_model_config は成功 / failure / abort の 3 経路で 'opus'、impl_model_fallback_label は載らない
//
// frontmatter 値（model: opus / effort: high）と impl_model_config リテラルの一致は review-model-frontmatter.test.mjs (d)。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, relative } from 'node:path';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash, analyzeArgs, MICRO_FILES, COMPLEX_FILES } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = join(here, '..');
const src = readFileSync(join(pluginRoot, '.claude', 'workflows', 'dev-flow.js'), 'utf8');
const SELF = basename(fileURLToPath(import.meta.url));

const IMPLEMENTER = 'dev-flow:dev-implementer';
const FORBIDDEN = ['fallbackModel', 'IMPL_FALLBACK_MODEL', 'IMPL_FALLBACK_LABEL', 'impl_model_fallback_label'];

function listFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

// ============================================================
// (a) 静的 pin
// ============================================================

test('[impl-model-opus] (a) dev-flow.js と _lib に fallback 機構のシンボルが残っていない', () => {
  const targets = [
    ['.claude/workflows/dev-flow.js', src],
    ...listFiles(here)
      .filter((p) => basename(p) !== SELF)
      .map((p) => [relative(pluginRoot, p), readFileSync(p, 'utf8')]),
  ];
  assert.ok(targets.length > 1, '_lib 配下のファイルが走査対象に入っていない');
  const hits = [];
  for (const [name, text] of targets) for (const tok of FORBIDDEN) if (text.includes(tok)) hits.push(`${name}: ${tok}`);
  assert.deepEqual(hits, [], 'fable→opus fallback 機構のシンボルが残っている');
});

test('[impl-model-opus] (a) references/capability-bound.md に fable→opus fallback と既定 model fable の記述が無い', () => {
  const forbiddenDoc = [...FORBIDDEN, 'impl-model-fallback', /fable\s*(→|->)\s*opus/, /frontmatter\s*`?fable/, /既定[^\n。]*(?<![-\w])fable(?![-\w])/, /fable \/ high/];
  // model の割り当ては capability-bound.md の「subagent の model・effort の割り当て」に置く
  const text = readFileSync(join(pluginRoot, 'dev-flow', 'references', 'capability-bound.md'), 'utf8');
  for (const pat of forbiddenDoc) {
    const hit = typeof pat === 'string' ? text.includes(pat) : pat.test(text);
    assert.equal(hit, false, `references/capability-bound.md に fallback / 既定 fable の記述が残っている: ${pat}`);
  }
});

// ============================================================
// (b)(c) call site の model 指定
// ============================================================

const IMPL_DONE = (files = ['src/x.ts']) => ({ status: 'DONE', task_id: 'issue-1', files: [...files], summary: 's', concerns: [] });
const BLOCKED = { status: 'BLOCKED', task_id: 'issue-1', files: [], summary: '', concerns: [], blocking_reason: { block_class: 'approach_mismatch', detail: 'R1: approach failed' } };
const EVAL_FAIL = { verdict: 'fail', total: 50, threshold: 80, feedback: [{ topic: 'arch-split', severity: 'critical', dimension: 'implementation', description: 'split', suggestion: 'x' }], feedback_level: 'implementation', ac_results: [], security_clearance: [], concern_resolutions: [] };
const EVAL_PASS = { verdict: 'pass', total: 100, threshold: 80, feedback: [], feedback_level: 'implementation', ac_results: [], security_clearance: [], concern_resolutions: [], critical_resolutions: [{ id: 'EVAL-1-arch-split', resolved: true, evidence: 'ok' }] };
const COMPLEX_ARGS = analyzeArgs(1, { acceptance_criteria: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], issue_type: 'feat' });

async function runFlow(overrides = {}, extra = {}) {
  const journalPrompts = [];
  const { ctx, calls, logs } = makeDevFlowSandbox({
    overrides: {
      'journal-log': ({ prompt }) => { journalPrompts.push(prompt); return { saved: true, logged: true }; },
      'journal-log-failure': ({ prompt }) => { journalPrompts.push(prompt); return { saved: true, logged: true }; },
      'journal-log-abort': ({ prompt }) => { journalPrompts.push(prompt); return { saved: true, logged: true }; },
      ...overrides,
    },
    extra,
  });
  const { result, error } = await runWorkflowCapture(src, ctx);
  assertNoCrash(error, 'impl-model-opus');
  return { calls, logs, result, error, journalPrompts };
}

const byLabel = (calls, label) => calls.filter((c) => c.label === label);
const implCalls = (calls) => calls.filter((c) => c.agentType === IMPLEMENTER);
const hasModelKey = (c) => 'model' in (c.opts ?? {});

// 各経路の implementer call を 1 run ずつ起こす（label → 起動条件）
const IMPL_ROUTES = {
  'impl:serial:issue-1': { overrides: {} },
  'reimpl-blocked#1:serial:issue-1': { overrides: { 'impl:serial:issue-1': BLOCKED, 'reimpl-blocked#1:serial:issue-1': IMPL_DONE() } },
  'reimpl#1:serial:issue-1': {
    overrides: {
      'impl:serial:issue-1': IMPL_DONE(COMPLEX_FILES),
      'reimpl#1:serial:issue-1': IMPL_DONE(COMPLEX_FILES),
      'danger-grep': { risk: { ok: true, hits: [] }, files: [...COMPLEX_FILES], struct: null, diffhash: { hash: 'AAA', empty: false } },
      'eval#1': EVAL_FAIL,
      'eval#2': EVAL_PASS,
    },
    extra: { args: COMPLEX_ARGS },
  },
  'reimpl-empty-diff:serial:issue-1': { overrides: { 'diff-gate': { hash: 'H', empty: true }, 'diff-gate-retry': { hash: 'H2', empty: false } } },
};

for (const [label, route] of Object.entries(IMPL_ROUTES)) {
  test(`[impl-model-opus] (b) ${label} は dev-implementer を model 指定なし（frontmatter 既定 opus）で spawn する`, async () => {
    const { calls, error } = await runFlow(route.overrides, route.extra ?? {});
    assert.equal(error, null, `run が throw した: ${error?.message}`);
    const hit = byLabel(calls, label);
    assert.equal(hit.length, 1, `${label} は 1 回のはず: ${implCalls(calls).map((c) => c.label).join(', ')}`);
    assert.equal(hit[0].agentType, IMPLEMENTER);
    assert.equal(hasModelKey(hit[0]), false, `${label} の opts に model キーがある: ${hit[0].model}`);
    const withModel = implCalls(calls).filter(hasModelKey);
    assert.deepEqual(withModel.map((c) => c.label), [], 'green-fix 以外の implementer call に model キーがある');
  });
}

test('[impl-model-opus] (b) green-fix#1 / green-fix#retry-1 だけが model:sonnet を明示する', async () => {
  const red = { tests: 'failed', green: false, summary: 'assert mismatch' };
  const first = await runFlow({ 'test#1': red, 'green-fix#1': IMPL_DONE() });
  assert.equal(first.error, null, `run が throw した: ${first.error?.message}`);
  const retry = await runFlow({ 'diff-gate': { hash: 'H', empty: true }, 'diff-gate-retry': { hash: 'H2', empty: false }, 'test#retry-1': red });
  assert.equal(retry.error, null, `run が throw した: ${retry.error?.message}`);
  for (const [calls, label] of [[first.calls, 'green-fix#1'], [retry.calls, 'green-fix#retry-1']]) {
    const gf = byLabel(calls, label);
    assert.equal(gf.length, 1, `${label} は 1 回のはず`);
    assert.equal(gf[0].agentType, IMPLEMENTER, `${label} の agent 定義は dev-implementer のはず`);
    assert.equal(gf[0].model, 'sonnet', `${label} は model:sonnet のはず`);
    const others = implCalls(calls).filter((c) => !c.label.startsWith('green-fix'));
    assert.ok(others.length >= 1, 'Implement の call が観測されない');
    assert.deepEqual(others.filter(hasModelKey).map((c) => c.label), [], `${label} の run で green-fix 以外の implementer call に model キーがある`);
  }
});

test('[impl-model-opus] (c) impl:serial:issue-1 の null は再試行されず 1 回で drop に計上される', async () => {
  const { calls, logs, error } = await runFlow({ 'impl:serial:issue-1': null });
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  const impl = byLabel(calls, 'impl:serial:issue-1');
  assert.equal(impl.length, 1, `impl:serial:issue-1 は 1 回のはず（fallback 再試行なし）: ${impl.length}`);
  assert.equal(hasModelKey(impl[0]), false);
  assert.ok(logs.some((l) => l.includes('impl: dev-implementer 1 件が失敗(null)')), 'drop の log が無い');
  assert.ok(logs.some((l) => l.includes('implement drop 1 件')), 'implDroppedCount=1 の log が無い');
});

// ============================================================
// (d) shape 別 spawn 数・Evaluate 回数（fallback 撤去前の実測値から、journal handoff の 1 spawn 化
// （issue #807: journal-save + journal-log → journal-log）で dev-runner-haiku が 1 減り、closes-check の
// merge-tier-facts 吸収（issue #824）で dev-runner-haiku-ro が 1 減り、Diff triage の敵対的 security review の
// 対象判定 security-scope（issue #1063）で dev-runner-haiku-ro が 1 増えた値）
// ============================================================

const SHAPES = {
  micro: {
    args: analyzeArgs(1, { acceptance_criteria: ['a', 'b'], issue_type: 'fix' }),
    overrides: {
      'impl:serial:issue-1': IMPL_DONE(MICRO_FILES),
      'danger-grep': { risk: { ok: true, hits: [] }, files: [...MICRO_FILES], struct: null, diffhash: { hash: 'AAA', empty: false } },
      'ci-check-lite': { status: 'passed', passed: 1, failed: 0, pending: 0, skipped: 0, failed_checks: [], waited_seconds: 0, poll_attempts: 0 },
    },
    total: 12,
    evals: 0,
    byType: { 'dev-flow:dev-runner-haiku-wo': 1, 'dev-flow:dev-implementer': 1, 'dev-flow:dev-runner-haiku': 4, 'dev-flow:dev-runner-haiku-ro': 5, 'dev-flow:pr-reviewer': 1 },
  },
  standard: {
    args: analyzeArgs(1, { acceptance_criteria: ['a', 'b', 'c', 'd'], issue_type: 'feat' }),
    overrides: {},
    total: 13,
    evals: 1,
    byType: { 'dev-flow:dev-runner-haiku-wo': 1, 'dev-flow:dev-implementer': 1, 'dev-flow:dev-runner-haiku': 4, 'dev-flow:dev-runner-haiku-ro': 6, 'dev-flow:evaluator': 1 },
  },
  complex: {
    args: COMPLEX_ARGS,
    overrides: {},
    total: 13,
    evals: 1,
    byType: { 'dev-flow:dev-runner-haiku-wo': 1, 'dev-flow:dev-implementer': 1, 'dev-flow:dev-runner-haiku': 4, 'dev-flow:dev-runner-haiku-ro': 6, 'dev-flow:evaluator': 1 },
  },
};

for (const [shape, exp] of Object.entries(SHAPES)) {
  test(`[impl-model-opus] (d) ${shape}: spawn 数 ${exp.total}・Evaluate ${exp.evals} 回`, async () => {
    const { ctx, calls } = makeDevFlowSandbox({ overrides: exp.overrides, extra: { args: exp.args } });
    const { result, error } = await runWorkflowCapture(src, ctx);
    assert.equal(error, null, `run が throw した: ${error?.message}`);
    assert.equal(result?.shape, shape, `実効 shape が ${shape} でない: ${result?.shape}`);
    const byType = {};
    for (const c of calls) byType[c.agentType] = (byType[c.agentType] ?? 0) + 1;
    assert.equal(calls.length, exp.total, `spawn 数: ${calls.map((c) => c.label).join(', ')}`);
    assert.equal(calls.filter((c) => /^eval#\d+$/.test(c.label)).length, exp.evals, 'Evaluate 回数');
    assert.deepEqual(byType, exp.byType, 'agentType 別 spawn 数');
    assert.deepEqual(calls.filter(hasModelKey).map((c) => c.label), [], 'model override を持つ call がある');
  });
}

// ============================================================
// (e) telemetry
// ============================================================

function lastTelemetry(journalPrompts) {
  const m = journalPrompts.at(-1)?.match(/<<<JOURNAL_HANDOFF_BODY_BEGIN>>>\n([\s\S]*?)\n<<<JOURNAL_HANDOFF_BODY_END>>>/);
  assert.ok(m, 'journal-log prompt に JOURNAL_HANDOFF_BODY が無い');
  return JSON.parse(m[1]);
}

const TELEMETRY_ROUTES = {
  success: { overrides: {}, throws: false },
  failure: { overrides: { 'diff-gate': { hash: 'H', empty: true }, 'diff-gate-retry': { hash: 'H', empty: true }, 'issue-labels': null }, throws: true },
  abort: { overrides: { 'eval#1': null }, throws: true },
};

for (const [route, cfg] of Object.entries(TELEMETRY_ROUTES)) {
  test(`[impl-model-opus] (e) ${route} run の telemetry: impl_model_config は opus、impl_model_fallback_label は載らない`, async () => {
    const { journalPrompts, error } = await runFlow(cfg.overrides);
    assert.equal(error != null, cfg.throws, `throw の有無が想定と違う: ${error?.message}`);
    const payload = lastTelemetry(journalPrompts);
    if (route === 'failure') assert.equal(payload.outcome, 'failure');
    if (route === 'abort') assert.equal(payload.error_category, 'abort');
    assert.equal(payload.telemetry.impl_model_config, 'opus');
    assert.equal('impl_model_fallback_label' in payload.telemetry, false, 'impl_model_fallback_label が載っている');
  });
}
