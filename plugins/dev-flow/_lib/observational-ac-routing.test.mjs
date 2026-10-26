// 観測型 AC（実行して出力・記録を観測しないと確かめられない AC）の Evaluate / Final reconcile / Merge tier 経路を
// VM 実行で pin する（issue #844）。
//   (A) inspection の satisfied:true → checked にせず、差し戻さず、merge tier は ac_human_pending の HOLD。
//       終端サマリーの対応欄は「実行して AC の主張を確認する」で、どの AC が観測型かが分かる
//   (B) verified_by:test + redgreen で red→green 実証（deterministic 昇格）→ checked、HOLD しない
//   (C) verified_by:test でも red→green 不成立 → (A) と同じく人手 AC 待ち（差し戻さない）
//   (D) Final reconcile の inspection pass（final reconcile pass）でも観測型 AC を checked にしない
//   (E) Evaluate で red→green 実証済みの観測型 AC は Final reconcile 後も達成のまま
// 観測型判定の確定（issue #859。prerun の ac_observational が null の AC だけを分類 agent に回す）:
//   (F) 回帰（acme/webapp）: null の AC だけを title と AC 文面で 1 回渡し、確定値が evaluator と actor に効く
//       （prerun が全 AC を確定していれば spawn しないことは (A) で見る）
//   (G) 分類 agent の失敗は未確定の AC を観測型に倒す

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash, devFlowArgs, prerunAnalyze } from './test-helpers/vm-sandbox.mjs';
import { APP_REPO_REGRESSION_ACS } from './test-helpers/observational-ac-controls.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', '.claude/workflows/dev-flow.js'), 'utf8');

const OBS_AC = '実 run の journal に `duration_seconds` が記録される';
const CODE_AC = 'worker 数の上限を設定で変えられる';
const OBS_ACTION = '実行して AC の主張を確認する（例: merge 後の実 run・計測）';

const inspection = (i, satisfied = true) => ({ ac_index: i, satisfied, verified_by: 'inspection', evidence: satisfied ? 'コードを読んで確認' : '未達' });
const byTest = (i) => ({ ac_index: i, satisfied: true, verified_by: 'test', evidence: 'test green', test_files: ['src/x.test.ts'], impl_files: ['src/x.ts'] });
const evalWith = (acResults) => ({
  verdict: 'pass', total: 100, threshold: 80, feedback: [], feedback_level: 'implementation',
  ac_results: acResults, security_clearance: [], concern_resolutions: [],
});
const RG_PROVEN = { results: [{ index: 0, red: true, green: true }] };
const RG_NOT_RED = { results: [{ index: 0, red: false, green: true, reason: 'impl を外しても green' }] };

// VM context の配列・object は prototype が別 realm なので、deepStrictEqual の前に JSON で本 realm へ写す
const plain = (v) => JSON.parse(JSON.stringify(v));
const reimplCalls = (calls) => calls.filter((c) => /^reimpl#\d+:serial:issue-1$/.test(c.label));
const evalCalls = (calls) => calls.filter((c) => c.agentType === 'dev-flow:evaluator' && c.label.startsWith('eval#'));
const acObsCalls = (calls) => calls.filter((c) => c.label.startsWith('ac-observational#'));

async function run(overrides, opts = {}) {
  const analyze = opts.analyze ?? prerunAnalyze({ acceptance_criteria: [OBS_AC, CODE_AC], ac_observational: [true, false], ac_observational_evidence: ['Jev noul 観測型 p=0.97', '正規表現の絞り込みに当たらない'] });
  const { ctx, calls, logs } = makeDevFlowSandbox({
    ...(opts.workflow ? { workflow: opts.workflow } : {}),
    overrides,
    extra: { args: devFlowArgs(1, { analyze }) },
  });
  const { result, error } = await runWorkflowCapture(src, ctx);
  assertNoCrash(error, 'observational-ac');
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  return { result, calls, logs };
}

const FIXED_ITERATE = async () => ({ status: 'lgtm', iterations: 2, fixes_applied: 1 });
const FINAL_OK = { 'reconcile-sync': { ok: true, head: 'a'.repeat(40) }, 'test#final': { tests: 'passed', green: true, summary: '' } };

test('[observational-ac] (A) inspection の satisfied:true → checked にせず差し戻さず、ac_human_pending の HOLD。サマリーの対応欄は実行による確認', async () => {
  const { result, calls } = await run({ 'eval#1': evalWith([inspection(0), inspection(1)]) });
  assert.equal(reimplCalls(calls).length, 0, `観測型 AC で差し戻した: ${calls.map((c) => c.label).join(', ')}`);
  assert.equal(evalCalls(calls).length, 1);
  assert.equal(acObsCalls(calls).length, 0, 'prerun が全 AC を確定していれば分類 agent を spawn しない');
  assert.equal(result?.merge_tier, 'HOLD');
  assert.deepEqual(plain(result.merge_tier_hold_reasons.map((r) => r.code)), ['ac_human_pending']);
  assert.deepEqual(plain(result.final_unsatisfied_ac_by_actor), { agent: [], human: [0], ci: [] });
  const prCall = calls.find((c) => c.label === 'pr#1');
  assert.ok(prCall.prompt.includes(`- [ ] ${OBS_AC}`), `PR 本文で観測型 AC が checked になった: ${prCall.prompt}`);
  const summary = calls.find((c) => c.label === 'post-summary');
  assert.ok(summary, 'post-summary が走る');
  assert.ok(summary.prompt.includes(OBS_ACTION), `対応欄が実行による確認になっていない: ${summary.prompt}`);
  assert.ok(summary.prompt.includes('観測型 AC（AC#1）'), `どの AC が観測型か分からない: ${summary.prompt}`);
  assert.ok(summary.prompt.includes('| ❌ 未達 | AC#1（観測型） |'), `未達表に観測型の印が無い: ${summary.prompt}`);
});

test('[observational-ac] (B) verified_by:test + redgreen で red→green 実証 → deterministic 昇格で checked、HOLD しない', async () => {
  const { result, calls } = await run({ 'eval#1': evalWith([byTest(0), inspection(1)]), redgreen: RG_PROVEN });
  assert.equal(calls.filter((c) => c.label === 'redgreen').length, 1);
  assert.equal(reimplCalls(calls).length, 0);
  assert.equal(result?.merge_tier, 'REVIEW', `red→green 実証済みなので HOLD しない: ${JSON.stringify(result?.merge_tier_reasons)}`);
  assert.deepEqual(plain(result.final_unsatisfied_ac_by_actor), { agent: [], human: [], ci: [] });
  const prCall = calls.find((c) => c.label === 'pr#1');
  assert.ok(prCall.prompt.includes(`- [x] ${OBS_AC}`), `PR 本文で観測型 AC が checked にならない: ${prCall.prompt}`);
});

test('[observational-ac] (C) verified_by:test でも red→green 不成立 → checked にせず差し戻さず ac_human_pending の HOLD', async () => {
  const { result, calls } = await run({ 'eval#1': evalWith([byTest(0), inspection(1)]), redgreen: RG_NOT_RED });
  assert.equal(reimplCalls(calls).length, 0, `観測型 AC で差し戻した: ${calls.map((c) => c.label).join(', ')}`);
  assert.equal(result?.merge_tier, 'HOLD');
  assert.deepEqual(plain(result.merge_tier_hold_reasons.map((r) => r.code)), ['ac_human_pending']);
  assert.deepEqual(plain(result.final_unsatisfied_ac_by_actor), { agent: [], human: [0], ci: [] });
});

test('[observational-ac] (D) Final reconcile の inspection pass でも観測型 AC を checked にせず、ac_human_pending の HOLD のまま', async () => {
  const { result, calls } = await run({
    'eval#1': evalWith([inspection(0, false), inspection(1)]),
    ...FINAL_OK,
    'final-ac-reconcile': { ac_results: [inspection(0), inspection(1)] },
  }, { workflow: FIXED_ITERATE });
  assert.equal(calls.filter((c) => c.label === 'final-ac-reconcile').length, 1, `final-ac-reconcile が走らない: ${calls.map((c) => c.label).join(', ')}`);
  assert.equal(reimplCalls(calls).length, 0);
  assert.equal(result?.final_ac_reconcile, 'reverified');
  assert.equal(result?.merge_tier, 'HOLD');
  assert.deepEqual(plain(result.merge_tier_hold_reasons.map((r) => r.code)), ['ac_human_pending']);
  assert.deepEqual(plain(result.final_unsatisfied_ac_by_actor), { agent: [], human: [0], ci: [] });
});

test('[observational-ac] (E) Evaluate で red→green 実証済みの観測型 AC は Final reconcile 後も達成のまま', async () => {
  const { result } = await run({
    'eval#1': evalWith([byTest(0), inspection(1)]),
    redgreen: RG_PROVEN,
    ...FINAL_OK,
    'final-ac-reconcile': { ac_results: [inspection(0), inspection(1)] },
  }, { workflow: FIXED_ITERATE });
  assert.equal(result?.final_ac_reconcile, 'reverified');
  assert.equal(result?.merge_tier, 'REVIEW', `red→green 実証済みなので HOLD しない: ${JSON.stringify(result?.merge_tier_reasons)}`);
  assert.deepEqual(plain(result.final_unsatisfied_ac_by_actor), { agent: [], human: [], ci: [] });
});

// 回帰（issue #859）: acme/webapp の AC。prerun の判定は prerun-analyze.bats の Jev スタブと同じ値
// （本番コード… = 絞り込みに当たらず false / ログの件数表示 = Jev p=0.04 で false / エラー件数… = Jev 低確信で null /
// 実行ログに 1 件以上 = Jev p=0.96 で true / #104 AC#2 = Jev p=0.03 で false）。
const REG_ACS = APP_REPO_REGRESSION_ACS.map((r) => r.ac);
const REG_TITLE = 'test(video): テストの件数の直書きを整理する';
const REG_ANALYZE = prerunAnalyze({
  issue_title: REG_TITLE,
  acceptance_criteria: REG_ACS,
  ac_observational: [false, false, null, true, false],
  ac_observational_evidence: ['正規表現の絞り込みに当たらない', 'Jev noul 観測型 p=0.04', 'Jev が低確信（観測型 p=0.5）', 'Jev noul 観測型 p=0.96', 'Jev noul 観測型 p=0.03'],
});
const REG_EVAL = { 'eval#1': evalWith(REG_ACS.map((_, i) => inspection(i))) };

test('[observational-ac] (F) 回帰: null の AC だけを AC 文面 + title で分類 agent に 1 回渡し、#104 AC#2 は観測型にせず HOLD は観測型の AC だけ', async () => {
  const { result, calls } = await run({
    ...REG_EVAL,
    'ac-observational#1': { results: [{ ac_index: 2, observational: false }] },
  }, { analyze: REG_ANALYZE });
  const obs = acObsCalls(calls);
  assert.equal(obs.length, 1, `分類 agent は 1 回: ${calls.map((c) => c.label).join(', ')}`);
  assert.equal(obs[0].agentType, 'dev-flow:dev-runner');
  assert.ok(obs[0].prompt.includes(JSON.stringify(REG_TITLE)), `title が渡っていない: ${obs[0].prompt}`);
  assert.ok(obs[0].prompt.includes(JSON.stringify({ ac_index: 2, ac: REG_ACS[2] })), `null の AC が渡っていない: ${obs[0].prompt}`);
  for (const i of [0, 1, 3, 4]) assert.ok(!obs[0].prompt.includes(REG_ACS[i]), `prerun で確定した AC-${i + 1} を渡している: ${obs[0].prompt}`);
  assert.ok(!obs[0].prompt.includes('stub-issue-body'), 'issue 本文を渡している');
  // diff・evaluator の結果が存在する前（isolation-probe・実装・評価より前）に 1 回だけ走る
  const at = (pred) => calls.findIndex(pred);
  assert.ok(at((c) => c.label.startsWith('ac-observational#')) < at((c) => c.label === 'isolation-probe'), 'isolation-probe より後に走った');
  assert.ok(at((c) => c.label.startsWith('ac-observational#')) < at((c) => c.agentType === 'dev-flow:dev-implementer'));
  // 確定した判定が evaluator の requirements と actor に効く
  assert.ok(evalCalls(calls)[0].prompt.includes('"ac_observational":[false,false,false,true,false]'), evalCalls(calls)[0].prompt.slice(0, 2000));
  assert.equal(result?.merge_tier, 'HOLD');
  assert.deepEqual(plain(result.merge_tier_hold_reasons.map((r) => r.code)), ['ac_human_pending']);
  assert.deepEqual(plain(result.final_unsatisfied_ac_by_actor), { agent: [], human: [3], ci: [] }, '#104 AC#2（AC-5）・件数の AC は観測型にしない');
  const prCall = calls.find((c) => c.label === 'pr#1');
  assert.ok(prCall.prompt.includes(`- [x] ${REG_ACS[4]}`), `#104 AC#2 が達成扱いにならない: ${prCall.prompt}`);
});

test('[observational-ac] (G) 分類 agent が失敗（null）なら未確定の AC は観測型（true）として人手 AC 待ちに回す', async () => {
  const { result, calls } = await run({ ...REG_EVAL, 'ac-observational#1': null }, { analyze: REG_ANALYZE });
  assert.equal(acObsCalls(calls).length, 1);
  assert.equal(reimplCalls(calls).length, 0);
  assert.equal(result?.merge_tier, 'HOLD');
  assert.deepEqual(plain(result.final_unsatisfied_ac_by_actor), { agent: [], human: [2, 3], ci: [] });
});
