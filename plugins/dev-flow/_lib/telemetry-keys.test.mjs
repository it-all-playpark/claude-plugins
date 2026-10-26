// telemetry-keys.test.mjs — dev-flow.js / pr-iterate.js が journal handoff に書く telemetry キーの集合を pin する（issue #789）。
//
// telemetry の読み手は dev-flow-health だけで、残すキーは dev-flow/references/telemetry.md の 23 個。
// それ以外のキーを書くと、読まれない値を計算・転記するコードが再び増える。
//
//   (1) 静的 pin: 両 workflow の inline 生成区間の外にある `telemetry: { … }` object literal を全部拾い、
//       直下のキーと spread（`...(cond ? { k: v } : {})`）内のキーが 23 キーの部分集合であること。
//       成功・失敗（writeFailureTelemetry）・abort の各組み立て口が literal として存在すること、
//       telemetry を literal 以外（変数・shorthand）で渡す箇所が無いことも pin する。
//   (2) 挙動 pin: DEV_FLOW_SCENARIOS（成功 / lite / abort / empty-diff / cross-repo / needs_clarification …）と
//       pr-iterate.js の成功・abort を VM 実行し、journal handoff payload の telemetry キーが 23 キーの部分集合であること。
//   (3) telemetry.md のキー一覧が 23 キーと一致すること。entry 列が (1) の literal と、読み手列が health-report.sh が
//       実際に読むキーと一致し、表すもの列が 1〜2 文で、signature にする値の列挙・要素の形を写していないこと。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { stripComments } from '../../../tools/sync-inlines.mjs';
import { neutralizeRegexLiterals, blankStringLiterals } from './test-helpers/source-scan.mjs';
import { makeDevFlowSandbox, makePrIterateSandbox, runWorkflowCapture, assertNoCrash, devFlowArgs, prerunAnalyze } from './test-helpers/vm-sandbox.mjs';
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
  'hold_reason_codes', 'hold_ac_human_judged',
  'security_review_target', 'security_review_rounds',
  'security_review_status', 'security_review_stop_reason', 'fix_terminal_reason', 'iterate_caller',
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
  test(`[telemetry-keys] 静的: ${name} の telemetry object literal のキーは残す 23 キーの部分集合`, () => {
    const literals = telemetryLiterals(src);
    // dev-flow.js: 成功 handoff / writeFailureTelemetry / abort、pr-iterate.js: 成功 / abort
    assert.ok(literals.length >= minLiterals, `${name}: telemetry literal が ${literals.length} 件しか見つからない（成功・失敗・abort の組み立て口が literal でない可能性）`);
    for (const { line, keys } of literals) {
      const extra = keys.filter((k) => !KEPT_TELEMETRY_KEYS.includes(k));
      assert.deepEqual(extra, [], `${name} line ~${line}: 残す 23 キー以外の telemetry キー ${JSON.stringify(extra)}`);
    }
  });

  test(`[telemetry-keys] 静的: ${name} は telemetry を object literal 以外（変数・shorthand・spread）で渡さない`, () => {
    const code = workflowBodyCode(src);
    const nonLiteral = [...code.matchAll(/\btelemetry\s*:(?!\s*\{)|[{,]\s*telemetry\s*[,}]|\.\.\.\s*telemetry\b/g)];
    assert.deepEqual(nonLiteral.map((m) => code.slice(m.index, m.index + 40)), [], `${name}: telemetry を literal 以外で渡している箇所がある`);
  });
}

test('[telemetry-keys] 静的: 走査器は 23 キー外のキー（直下・条件付き spread 内）と literal 以外の渡し方を検出する', () => {
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
  test(`[telemetry-keys] 挙動: dev-flow.js[${name}] の journal handoff telemetry キーは残す 23 キーの部分集合`, async () => {
    const { ctx, calls } = makeDevFlowSandbox({ overrides: sc.overrides ?? {}, workflow: sc.workflow, extra: sc.extra ?? {} });
    const { error } = await runWorkflowCapture(devFlowSrc, ctx);
    assertNoCrash(error, name);
    const telemetry = handoffTelemetry(calls);
    assert.ok(telemetry, `[${name}] journal handoff が呼ばれていない: ${calls.map((c) => c.label).join(', ')}`);
    const extra = Object.keys(telemetry).filter((k) => !KEPT_TELEMETRY_KEYS.includes(k));
    assert.deepEqual(extra, [], `[${name}] 残す 23 キー以外の telemetry キー: ${JSON.stringify(telemetry)}`);
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

// HOLD 理由（hold_reason_codes）と、人手 AC 待ちに文面以外（観測型・unreachable_env）で人手になった AC があるか
// （hold_ac_human_judged）は HOLD の run だけに載る。dev-flow-health の health-report.sh が HOLD 由来の signature にする入力。
const HOLD_ACS = ['実 run の journal に `duration_seconds` が記録される', '（人手）staging で動作を確認する'];
const holdRun = (acResults) => makeDevFlowSandbox({
  overrides: {
    'eval#1': {
      verdict: 'pass', total: 100, threshold: 80, feedback: [], feedback_level: 'implementation',
      ac_results: acResults, security_clearance: [], concern_resolutions: [],
    },
  },
  extra: { args: devFlowArgs(1, { analyze: prerunAnalyze({ acceptance_criteria: HOLD_ACS, ac_observational: [true, false], ac_observational_evidence: ['Jev 観測型 p=0.97', '正規表現の絞り込みに当たらない'] }) }) },
});
const acResult = (i, satisfied) => ({ ac_index: i, satisfied, verified_by: 'inspection', evidence: satisfied ? 'ok' : '未達' });

for (const [name, acResults, judged] of [
  ['観測型 AC の未達（文面は agent）', [acResult(0, true), acResult(1, true)], true],
  ['観測型 AC と（人手）staging の AC がともに未達', [acResult(0, true), acResult(1, false)], true],
]) {
  test(`[telemetry-keys] 挙動: HOLD の run[${name}] は hold_reason_codes と hold_ac_human_judged を載せる`, async () => {
    const { ctx, calls } = holdRun(acResults);
    const { result, error } = await runWorkflowCapture(devFlowSrc, ctx);
    assert.equal(error, null, `run が throw した: ${error?.message}`);
    assert.equal(result.merge_tier, 'HOLD');
    const telemetry = handoffTelemetry(calls);
    assert.deepEqual(telemetry.hold_reason_codes, JSON.parse(JSON.stringify(result.merge_tier_hold_reasons.map((r) => r.code))));
    assert.ok(telemetry.hold_reason_codes.includes('ac_human_pending'), JSON.stringify(telemetry));
    assert.equal(telemetry.hold_ac_human_judged, judged);
  });
}

test('[telemetry-keys] 挙動: 文面で人手になった AC だけが未達の HOLD は hold_ac_human_judged:false', async () => {
  // 観測型 AC は red→green 実証済み（deterministic 昇格）で達成、（人手）staging の AC だけが未達
  const { ctx, calls } = makeDevFlowSandbox({
    overrides: {
      'eval#1': {
        verdict: 'pass', total: 100, threshold: 80, feedback: [], feedback_level: 'implementation',
        ac_results: [
          { ac_index: 0, satisfied: true, verified_by: 'test', evidence: 'test green', test_files: ['src/x.test.ts'], impl_files: ['src/x.ts'] },
          acResult(1, false),
        ],
        security_clearance: [], concern_resolutions: [],
      },
      redgreen: { results: [{ index: 0, red: true, green: true }] },
    },
    extra: { args: devFlowArgs(1, { analyze: prerunAnalyze({ acceptance_criteria: HOLD_ACS, ac_observational: [true, false], ac_observational_evidence: ['Jev 観測型 p=0.97', '正規表現の絞り込みに当たらない'] }) }) },
  });
  const { result, error } = await runWorkflowCapture(devFlowSrc, ctx);
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  assert.equal(result.merge_tier, 'HOLD');
  assert.deepEqual(JSON.parse(JSON.stringify(result.final_unsatisfied_ac_by_actor)), { agent: [], human: [1], ci: [] });
  const telemetry = handoffTelemetry(calls);
  assert.deepEqual(telemetry.hold_reason_codes, ['ac_human_pending']);
  assert.equal(telemetry.hold_ac_human_judged, false);
});

test('[telemetry-keys] 挙動: HOLD でない run は hold_reason_codes / hold_ac_human_judged を載せない', async () => {
  const { ctx, calls } = makeDevFlowSandbox();
  const { result, error } = await runWorkflowCapture(devFlowSrc, ctx);
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  assert.notEqual(result.merge_tier, 'HOLD');
  const telemetry = handoffTelemetry(calls);
  assert.ok(!('hold_reason_codes' in telemetry) && !('hold_ac_human_judged' in telemetry), JSON.stringify(telemetry));
});

// nested pr-iterate の fix の終わり方と security review の結果は dev-flow entry にも載る（dev-flow-health が HOLD の
// signature の細目にする）。nested が返さない値は null のまま handoff に載り、Stop hook が落とす
for (const [name, iterate, expected] of [
  ['security_unresolved', { status: 'security_unresolved', fix_terminal_reason: null, security_review: { target: true, status: 'unresolved', stop_reason: 'reviewer_context_changed', rounds: 1, critical: 0, major: 0, minor: 0, deferred: 0 } },
    { fix_terminal_reason: null, security_review_status: 'unresolved', security_review_stop_reason: 'reviewer_context_changed' }],
  ['fix_failed', { status: 'fix_failed', fix_terminal_reason: 'applied_false', security_review: { target: false, status: 'not_target', stop_reason: null, rounds: 0, critical: 0, major: 0, minor: 0, deferred: 0 } },
    { fix_terminal_reason: 'applied_false', security_review_status: 'not_target', security_review_stop_reason: null }],
  ['security_review を返さない nested', { status: 'lgtm', iterations: 1, fixes_applied: 0 },
    { fix_terminal_reason: null, security_review_status: null, security_review_stop_reason: null }],
]) {
  test(`[telemetry-keys] 挙動: dev-flow.js は nested pr-iterate[${name}] の fix_terminal_reason / security_review_status / security_review_stop_reason を載せる`, async () => {
    const { ctx, calls } = makeDevFlowSandbox({ workflow: async () => iterate });
    const { error } = await runWorkflowCapture(devFlowSrc, ctx);
    assert.equal(error, null, `run が throw した: ${error?.message}`);
    const telemetry = handoffTelemetry(calls);
    for (const [k, v] of Object.entries(expected)) {
      assert.ok(k in telemetry, `${k} が handoff の telemetry に無い: ${JSON.stringify(telemetry)}`);
      assert.equal(telemetry[k], v, `${k}: ${JSON.stringify(telemetry)}`);
    }
  });
}

for (const [name, overrides] of [
  ['lgtm', {}],
  ['abort（isolation probe fail-closed）', { 'isolation-probe': { written: false } }],
]) {
  test(`[telemetry-keys] 挙動: pr-iterate.js[${name}] の journal handoff telemetry キーは残す 23 キーの部分集合`, async () => {
    const { ctx, calls } = makePrIterateSandbox({ overrides });
    const { error } = await runWorkflowCapture(prIterateSrc, ctx, '.claude/workflows/pr-iterate.js');
    assertNoCrash(error, `pr-iterate ${name}`);
    const telemetry = handoffTelemetry(calls);
    assert.ok(telemetry, `journal handoff が呼ばれていない: ${calls.map((c) => c.label).join(', ')}`);
    const extra = Object.keys(telemetry).filter((k) => !KEPT_TELEMETRY_KEYS.includes(k));
    assert.deepEqual(extra, [], `残す 23 キー以外の telemetry キー: ${JSON.stringify(telemetry)}`);
    assert.equal(telemetry.merge_tier, 'PR_ITERATE');
  });
}

// ---- ドキュメント ----

test('[telemetry-keys] telemetry.md のキー一覧が残す 23 キーと一致する', () => {
  const md = readFileSync(TELEMETRY_MD, 'utf8');
  const section = md.split(/^## /m).find((s) => s.startsWith('キー一覧'));
  assert.ok(section, 'telemetry.md に「## キー一覧」節が無い');
  const listed = [...section.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]);
  assert.deepEqual([...listed].sort(), [...KEPT_TELEMETRY_KEYS].sort(), `telemetry.md のキー一覧: ${JSON.stringify(listed)}`);
});

const HEALTH_REPORT = join(HERE, '..', 'dev-flow-health', 'scripts', 'health-report.sh');
const READER_SCRIPT = '`health-report.sh` が読む';
const READER_MANUAL = 'dev-flow-health の手読みだけ';

// キー一覧の表の行を { key, entry, reader, meaning } で返す
function telemetryTableRows(md) {
  const section = md.split(/^## /m).find((s) => s.startsWith('キー一覧'));
  assert.ok(section, 'telemetry.md に「## キー一覧」節が無い');
  const lines = section.split('\n');
  const header = lines.indexOf('| キー | entry | 読み手 | 表すもの |');
  assert.ok(header >= 0, 'キー一覧の表の見出しが「| キー | entry | 読み手 | 表すもの |」でない');
  return lines.slice(header + 2).filter((l) => l.startsWith('| `')).map((l) => {
    const [key, entry, reader, meaning] = l.split(' | ').map((c) => c.replace(/^\| |\s*\|$/g, '').trim());
    return { key: key.replace(/`/g, ''), entry, reader, meaning };
  });
}

test('[telemetry-keys] telemetry.md の entry 列は workflow の telemetry literal が書くキーと一致する', () => {
  const rows = telemetryTableRows(readFileSync(TELEMETRY_MD, 'utf8'));
  const writers = [['dev-flow', devFlowSrc], ['pr-iterate', prIterateSrc]].map(([name, src]) => [name, new Set(telemetryLiterals(src).flatMap((l) => l.keys))]);
  for (const { key, entry } of rows) {
    const expected = writers.filter(([, keys]) => keys.has(key)).map(([name]) => name).join(' / ');
    assert.equal(entry, expected, `${key} の entry 列`);
  }
});

test('[telemetry-keys] telemetry.md の読み手列は health-report.sh が読むキーと一致し、それ以外は手読みだけ', () => {
  const rows = telemetryTableRows(readFileSync(TELEMETRY_MD, 'utf8'));
  for (const { key, reader } of rows) assert.ok([READER_SCRIPT, READER_MANUAL].includes(reader), `${key} の読み手列が 2 値のどちらでもない: ${reader}`);
  const readByScript = new Set([...readFileSync(HEALTH_REPORT, 'utf8').matchAll(/\.telemetry\.([a-z_]+)/g)].map((m) => m[1]));
  assert.ok(readByScript.size > 0, 'health-report.sh から .telemetry.<key> の読み取りを拾えない');
  const listedAsScript = rows.filter((r) => r.reader === READER_SCRIPT).map((r) => r.key).sort();
  assert.deepEqual(listedAsScript, [...readByScript].sort(), '読み手列が health-report.sh の読むキーと食い違う');
});

test('[telemetry-keys] telemetry.md の表すもの列は 1〜2 文で、signature にする値の列挙・要素の形を写さない', () => {
  const md = readFileSync(TELEMETRY_MD, 'utf8');
  for (const { key, meaning } of telemetryTableRows(md)) {
    const sentences = meaning.split('。').filter((s) => s.trim());
    assert.ok(sentences.length >= 1 && sentences.length <= 2, `${key} の表すもの列が 1〜2 文でない: ${meaning}`);
  }
  // health-report.sh の signature 用の値の一覧（HOLD 理由の code・iterate_status）は定数名で指し、値を写さない
  const hr = readFileSync(HEALTH_REPORT, 'utf8');
  const values = ['HOLD_SIGNATURE_CODES', 'HOLD_SIGNATURE_ITERATE_STATUSES'].flatMap((name) => {
    const m = hr.match(new RegExp(`^${name}='(\\[[^']*\\])'`, 'm'));
    assert.ok(m, `health-report.sh に ${name} の定義が無い`);
    return JSON.parse(m[1]);
  });
  const copied = values.filter((v) => md.includes(`\`${v}\``));
  assert.deepEqual(copied, [], 'telemetry.md が signature にする値を書き写している');
  const shape = md.match(/`\{[^`]*\}`/);
  assert.equal(shape, null, `telemetry.md が要素の形を書き写している: ${shape?.[0]}`);
});

test('[telemetry-keys] telemetry.md は Stop hook の転送と clock の給電元をそれぞれ 1 つの節にだけ書く', () => {
  const sections = readFileSync(TELEMETRY_MD, 'utf8').split(/^##+ /m);
  for (const term of ['hooks/stop-devflow-telemetry.sh', '給電']) {
    const holders = sections.filter((s) => s.includes(term)).map((s) => s.split('\n')[0]);
    assert.equal(holders.length, 1, `「${term}」を書いた節が 1 つでない: ${JSON.stringify(holders)}`);
  }
});
