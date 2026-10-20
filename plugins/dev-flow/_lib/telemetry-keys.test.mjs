// telemetry-keys.test.mjs — dev-flow.js / pr-iterate.js が journal handoff に書く telemetry キーの集合を pin する（issue #789）。
//
// telemetry の読み手は dev-flow-health だけで、残すキーは dev-flow/references/telemetry.md の 15 個。
// それ以外のキーを書くと、読まれない値を計算・転記するコードが再び増える。
//
//   (1) 静的 pin: 両 workflow の inline 生成区間の外にある `telemetry: { … }` object literal を全部拾い、
//       直下のキーと spread（`...(cond ? { k: v } : {})`）内のキーが 15 キーの部分集合であること。
//       成功・失敗（writeFailureTelemetry）・abort の各組み立て口が literal として存在すること、
//       telemetry を literal 以外（変数・shorthand）で渡す箇所が無いことも pin する。
//   (2) 挙動 pin: DEV_FLOW_SCENARIOS（成功 / lite / abort / empty-diff / cross-repo / needs_clarification …）と
//       pr-iterate.js の成功・abort を VM 実行し、journal handoff payload の telemetry キーが 15 キーの部分集合であること。
//   (3) telemetry.md のキー一覧が 15 キーと一致すること。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { stripComments } from '../../../tools/sync-inlines.mjs';
import { neutralizeRegexLiterals, blankStringLiterals } from './test-helpers/source-scan.mjs';
import { makeDevFlowSandbox, makePrIterateSandbox, runWorkflowCapture, assertNoCrash } from './test-helpers/vm-sandbox.mjs';
import { DEV_FLOW_SCENARIOS } from './test-helpers/dev-flow-scenarios.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEV_FLOW_PATH = join(HERE, '..', '.claude', 'workflows', 'dev-flow.js');
const PR_ITERATE_PATH = join(HERE, '..', '.claude', 'workflows', 'pr-iterate.js');
const TELEMETRY_MD = join(HERE, '..', 'dev-flow', 'references', 'telemetry.md');
const devFlowSrc = readFileSync(DEV_FLOW_PATH, 'utf8');
const prIterateSrc = readFileSync(PR_ITERATE_PATH, 'utf8');

const KEPT_TELEMETRY_KEYS = [
  'plugin_commit', 'plugin_version', 'shape', 'route', 'duration_seconds', 'phase_durations',
  'merge_tier', 'iterate_status', 'eval_verdict', 'eval_model_config', 'impl_model_config', 'review_model_config',
  'final_test_flaky', 'ci_wait_ceiling_seconds', 'ci_wait_seconds',
];

// ---- 静的走査 ----

// inline 生成区間（canonical の写し）を除いた workflow 本体のコード。文字列・コメント・regex の中身は消す。
function workflowBodyCode(src) {
  const withoutInline = src.replace(/\/\/ ==== BEGIN inline: [^\n]*\n[\s\S]*?\/\/ ==== END inline: [^\n]*\n?/g, '');
  return blankStringLiterals(stripComments(neutralizeRegexLiterals(withoutInline)));
}

const OPEN = { '{': '}', '(': ')', '[': ']' };

// code[start] が開き括弧のとき、対応する閉じ括弧の index を返す
function matchClose(code, start) {
  const stack = [];
  for (let i = start; i < code.length; i++) {
    const c = code[i];
    if (OPEN[c]) stack.push(OPEN[c]);
    else if (c === '}' || c === ')' || c === ']') {
      assert.equal(c, stack.pop(), `括弧の対応が崩れている（index ${i}）`);
      if (stack.length === 0) return i;
    }
  }
  throw new Error(`閉じ括弧が見つからない（index ${start}）`);
}

// top-level（括弧の外）の ',' で区切る
function splitTopLevel(body) {
  const parts = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (OPEN[c]) depth++;
    else if (c === '}' || c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) { parts.push(body.slice(from, i)); from = i + 1; }
  }
  parts.push(body.slice(from));
  return parts.map((p) => p.trim()).filter(Boolean);
}

// object literal の本文（`{` と `}` の内側）から書かれうるキーを集める。
// spread は `...(cond ? { k: v } : {})` 形の条件付き object literal だけを許し、その中のキーも集める。
function objectLiteralKeys(body, where) {
  const keys = [];
  for (const part of splitTopLevel(body)) {
    if (part.startsWith('...')) {
      const expr = part.slice(3).trim();
      const literals = [...expr.matchAll(/[?:(]\s*\{/g)].map((m) => m.index + m[0].length - 1);
      assert.ok(literals.length > 0, `${where}: spread が object literal を含まない（${expr}）— telemetry は literal で書く`);
      for (const open of literals) keys.push(...objectLiteralKeys(expr.slice(open + 1, matchClose(expr, open)), where));
      continue;
    }
    const m = part.match(/^([A-Za-z_$][\w$]*)\s*(:|$)/);
    assert.ok(m, `${where}: キーを読めない property（${part.slice(0, 80)}）`);
    keys.push(m[1]);
  }
  return keys;
}

function telemetryLiterals(src) {
  const code = workflowBodyCode(src);
  return [...code.matchAll(/\btelemetry\s*:\s*\{/g)].map((m) => {
    const open = m.index + m[0].length - 1;
    const close = matchClose(code, open);
    const line = code.slice(0, m.index).split('\n').length;
    return { line, keys: objectLiteralKeys(code.slice(open + 1, close), `telemetry literal (line ~${line})`) };
  });
}

for (const [name, src, minLiterals] of [['dev-flow.js', devFlowSrc, 3], ['pr-iterate.js', prIterateSrc, 2]]) {
  test(`[telemetry-keys] 静的: ${name} の telemetry object literal のキーは残す 15 キーの部分集合`, () => {
    const literals = telemetryLiterals(src);
    // dev-flow.js: 成功 handoff / writeFailureTelemetry / abort、pr-iterate.js: 成功 / abort
    assert.ok(literals.length >= minLiterals, `${name}: telemetry literal が ${literals.length} 件しか見つからない（成功・失敗・abort の組み立て口が literal でない可能性）`);
    for (const { line, keys } of literals) {
      const extra = keys.filter((k) => !KEPT_TELEMETRY_KEYS.includes(k));
      assert.deepEqual(extra, [], `${name} line ~${line}: 残す 15 キー以外の telemetry キー ${JSON.stringify(extra)}`);
    }
  });

  test(`[telemetry-keys] 静的: ${name} は telemetry を object literal 以外（変数・shorthand・spread）で渡さない`, () => {
    const code = workflowBodyCode(src);
    const nonLiteral = [...code.matchAll(/\btelemetry\s*:(?!\s*\{)|[{,]\s*telemetry\s*[,}]|\.\.\.\s*telemetry\b/g)];
    assert.deepEqual(nonLiteral.map((m) => code.slice(m.index, m.index + 40)), [], `${name}: telemetry を literal 以外で渡している箇所がある`);
  });
}

test('[telemetry-keys] 静的: 走査器は 15 キー外のキー（直下・条件付き spread 内）と literal 以外の渡し方を検出する', () => {
  const fake = [
    'const a = buildJournalHandoffPayload({ telemetry: { merge_tier: x, gate_policy: y, ...(c ? { guard_id: z } : {}), route } })',
    'const b = buildAbortHandoffPayload({ telemetry: someVar })',
  ].join('\n');
  const [lit] = telemetryLiterals(fake);
  assert.deepEqual(lit.keys, ['merge_tier', 'gate_policy', 'guard_id', 'route']);
  assert.match(workflowBodyCode(fake), /\btelemetry\s*:(?!\s*\{)/);
});

// ---- 挙動（VM 実行） ----

// journal handoff は journal-log / journal-log-failure / journal-log-abort の 1 spawn（issue #807）。
function handoffTelemetry(calls) {
  const save = calls.find((c) => c.label.startsWith('journal-log'));
  if (!save) return null;
  const m = save.prompt.match(/<<<JOURNAL_HANDOFF_BODY_BEGIN>>>\n([\s\S]*?)\n<<<JOURNAL_HANDOFF_BODY_END>>>/);
  assert.ok(m, `journal-log prompt に JOURNAL_HANDOFF_BODY delimiter が見つからない:\n${save.prompt.slice(0, 500)}`);
  return JSON.parse(m[1]).telemetry ?? {};
}

for (const [name, sc] of Object.entries(DEV_FLOW_SCENARIOS)) {
  test(`[telemetry-keys] 挙動: dev-flow.js[${name}] の journal handoff telemetry キーは残す 15 キーの部分集合`, async () => {
    const { ctx, calls } = makeDevFlowSandbox({ overrides: sc.overrides ?? {}, workflow: sc.workflow, extra: sc.extra ?? {} });
    const { error } = await runWorkflowCapture(devFlowSrc, ctx);
    assertNoCrash(error, name);
    const telemetry = handoffTelemetry(calls);
    assert.ok(telemetry, `[${name}] journal handoff が呼ばれていない: ${calls.map((c) => c.label).join(', ')}`);
    const extra = Object.keys(telemetry).filter((k) => !KEPT_TELEMETRY_KEYS.includes(k));
    assert.deepEqual(extra, [], `[${name}] 残す 15 キー以外の telemetry キー: ${JSON.stringify(telemetry)}`);
    assert.ok('plugin_version' in telemetry && 'plugin_commit' in telemetry, `[${name}] 世代キーが無い: ${JSON.stringify(telemetry)}`);
  });
}

test('[telemetry-keys] 挙動: dev-flow.js 成功 run の telemetry は merge_tier / shape / route / 3 model / 世代キーを持つ', async () => {
  const { ctx, calls } = makeDevFlowSandbox();
  const { result, error } = await runWorkflowCapture(devFlowSrc, ctx);
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  const telemetry = handoffTelemetry(calls);
  for (const k of ['merge_tier', 'shape', 'route', 'iterate_status', 'eval_verdict', 'eval_model_config', 'impl_model_config', 'review_model_config', 'plugin_version', 'plugin_commit']) {
    assert.ok(k in telemetry, `成功 telemetry に ${k} が無い: ${JSON.stringify(telemetry)}`);
  }
  assert.equal(telemetry.merge_tier, result.merge_tier);
  assert.equal(telemetry.shape, result.shape);
  assert.equal(telemetry.route, result.route);
});

for (const [name, overrides] of [
  ['lgtm', {}],
  ['abort（isolation probe fail-closed）', { 'isolation-probe': { written: false } }],
]) {
  test(`[telemetry-keys] 挙動: pr-iterate.js[${name}] の journal handoff telemetry キーは残す 15 キーの部分集合`, async () => {
    const { ctx, calls } = makePrIterateSandbox({ overrides });
    const { error } = await runWorkflowCapture(prIterateSrc, ctx, '.claude/workflows/pr-iterate.js');
    assertNoCrash(error, `pr-iterate ${name}`);
    const telemetry = handoffTelemetry(calls);
    assert.ok(telemetry, `journal handoff が呼ばれていない: ${calls.map((c) => c.label).join(', ')}`);
    const extra = Object.keys(telemetry).filter((k) => !KEPT_TELEMETRY_KEYS.includes(k));
    assert.deepEqual(extra, [], `残す 15 キー以外の telemetry キー: ${JSON.stringify(telemetry)}`);
    assert.equal(telemetry.merge_tier, 'PR_ITERATE');
  });
}

// ---- ドキュメント ----

test('[telemetry-keys] telemetry.md のキー一覧が残す 15 キーと一致する', () => {
  const md = readFileSync(TELEMETRY_MD, 'utf8');
  const section = md.split(/^## /m).find((s) => s.startsWith('キー一覧'));
  assert.ok(section, 'telemetry.md に「## キー一覧」節が無い');
  const listed = [...section.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]);
  assert.deepEqual([...listed].sort(), [...KEPT_TELEMETRY_KEYS].sort(), `telemetry.md のキー一覧: ${JSON.stringify(listed)}`);
});
