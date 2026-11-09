// 観測型 AC（実行して出力・記録を観測しないと確かめられない AC）の Evaluate / Final reconcile / Merge tier 経路を
// VM 実行で pin する（issue #844）。
//   (A) inspection の satisfied:true → checked にせず、差し戻さず、merge tier は ac_human_pending の HOLD。
//       終端サマリーの対応欄は「実行して AC の主張を確認する」で、どの AC が観測型かが分かる
//   (B) verified_by:test + redgreen で red→green 実証（deterministic 昇格）→ checked、HOLD しない
//   (C) verified_by:test でも red→green 不成立 → (A) と同じく人手 AC 待ち（差し戻さない）
//   (D) Final reconcile の inspection pass（final reconcile pass）でも観測型 AC を checked にしない
//   (E) Evaluate で red→green 実証済みの観測型 AC は Final reconcile 後も達成のまま
// Final reconcile の redgreen-final（issue #1146。Evaluate で実証できず pr-iterate の fix がテストを直した run）:
//   (H) final evaluator が verified_by:test を返した観測型 AC → 最終 tree の red→green 実証で deterministic 昇格、HOLD しない
//   (I) red→green 不成立・vdelta deny・spawn 失敗・results 欠落 → 昇格せず ac_human_pending の HOLD
//   (H2) start が running → wait の結果で昇格 / (I2) 待機の上限・wait の読めない応答 → stop して昇格せず HOLD（issue #1226）
//   (J) inspection の観測型 AC / (K) Evaluate で昇格済みの AC → redgreen-final を spawn しない
// テストファイルを inline code で名指しした観測型 AC（issue #1147。actor agent）:
//   (L) inspection の satisfied:true → 未達に倒れて dev-implementer へ差し戻し、上限後も未達なら ac_agent_unsatisfied の HOLD
// 観測型判定の確定（issue #1259。analyze ゲート通過後に全 AC を分類 agent に 1 回で渡す）:
//   (M) AC 3 件の issue で分類 agent は 1 回だけ呼ばれ、渡る index は 0・1・2
//   (N) agent が null を返した AC・応答に無い AC・agent 自体が失敗した run では、その AC を観測型（true）として扱う
//   (F) 回帰（acme/webapp）: 全 AC を title と AC 文面で 1 回渡し、確定値が evaluator と actor に効く
//       （観測型 AC の検証コマンドが無ければ human のままなことは (A) で見る）
//   (G) 分類 agent の失敗は全 AC を観測型に倒す

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash, devFlowArgs, prerunAnalyze, acObservationalResponse, acObservationalPromptIndexes } from './test-helpers/vm-sandbox.mjs';
import { APP_REPO_REGRESSION_ACS } from './test-helpers/observational-ac-controls.mjs';
import { AGENT_AC_REIMPL_MAX } from './ac-actor.mjs';
import { REDGREEN_WAIT_POLLS } from './redgreen-targets.mjs';

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
// 分類 agent の prompt に載る AC の項目の先頭（ac_index と AC の文面。inline code の候補配列は ac-actor.test.mjs が固定する）
const acItemHead = (i, ac) => `{"ac_index":${i},"ac":${JSON.stringify(ac)},`;

// 分類 agent の応答は既定で AC-1 だけ観測型（opts.acObs で差し替える。overrides に 'ac-observational#1' があればそれを使う）
async function run(overrides, opts = {}) {
  const analyze = opts.analyze ?? prerunAnalyze({ acceptance_criteria: [OBS_AC, CODE_AC] });
  const { ctx, calls, logs } = makeDevFlowSandbox({
    ...(opts.workflow ? { workflow: opts.workflow } : {}),
    overrides: { 'ac-observational#1': 'acObs' in opts ? opts.acObs : acObservationalResponse([true, false]), ...overrides },
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
  // 分類 agent は全 AC を 1 回で受け取る（issue #1259）。verify_command が無ければ観測型 AC の actor は human のまま
  const obs = acObsCalls(calls);
  assert.equal(obs.length, 1, `分類 agent は 1 回: ${calls.map((c) => c.label).join(', ')}`);
  assert.ok(obs[0].prompt.includes(acItemHead(0, OBS_AC)), obs[0].prompt);
  assert.ok(obs[0].prompt.includes(acItemHead(1, CODE_AC)), obs[0].prompt);
  assert.ok(!calls.some((c) => c.label.startsWith('ac-verify-')), 'verify_command が無ければ AC コマンドを実行しない');
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

// Final reconcile の redgreen-final（issue #1146）: Evaluate では red→green 不成立（テストが弱かった）、pr-iterate の fix で
// テストを直した run。final evaluator が verified_by:test + test_files / impl_files を返した観測型 AC だけ最終 tree で実証する。
const RG_DENY = { results: [{ index: 0, red: true, green: true, verdict: { comparability: 'exact', transitions: { repaired_with_test_change: ['t1'] }, verification_surface: { status: 'changed' } } }] };
const rgFinalCalls = (calls) => calls.filter((c) => c.label === 'redgreen-final');
const runFinalRedgreen = (finalAc, rgFinal, evalAc = [byTest(0), inspection(1)], evalRg = RG_NOT_RED) => run({
  'eval#1': evalWith(evalAc),
  redgreen: evalRg,
  ...FINAL_OK,
  'final-ac-reconcile': { ac_results: finalAc },
  ...(rgFinal === undefined ? {} : { 'redgreen-final': rgFinal }),
}, { workflow: FIXED_ITERATE });

test('[observational-ac] (H) fix 後の final evaluator が test で確かめた観測型 AC は最終 tree の redgreen-final（1 spawn・--base origin/main）で red→green 実証 → deterministic 昇格で HOLD しない', async () => {
  const { result, calls, logs } = await runFinalRedgreen([byTest(0), inspection(1)], RG_PROVEN);
  const rg = rgFinalCalls(calls);
  assert.equal(rg.length, 1, `redgreen-final が 1 回走らない: ${calls.map((c) => c.label).join(', ')}`);
  assert.equal(rg[0].agentType, 'dev-flow:dev-runner-haiku');
  assert.equal(rg[0].prompt.split('\n')[1], "redgreen-verify start --state-dir /tmp/rg-state --base origin/main /tmp/wt 'src/x.test.ts' 'src/x.ts'");
  // Evaluate と Final reconcile で同じ state dir を使う（同じ dir の start が前の実行の残りを止める）
  assert.equal(calls.filter((c) => c.label === 'rg-state-dir').length, 1);
  // final evaluator に観測型 AC の扱いと test_files の受理条件を渡す
  const fa = calls.find((c) => c.label === 'final-ac-reconcile');
  assert.ok(fa.prompt.includes('観測型 AC（ac_index [0]。'), fa.prompt);
  assert.ok(logs.some((l) => l.includes('AC-1: 観測型 AC を最終 tree で red→green 実証 → deterministic 昇格 + checked')), logs.join('\n'));
  assert.equal(result?.final_ac_reconcile, 'reverified');
  assert.equal(result?.merge_tier, 'REVIEW', `最終 tree で red→green 実証済みなので HOLD しない: ${JSON.stringify(result?.merge_tier_hold_reasons)}`);
  assert.deepEqual(plain(result.final_unsatisfied_ac_by_actor), { agent: [], human: [], ci: [] });
});

for (const [name, rgFinal] of [
  ['red→green 不成立', RG_NOT_RED],
  ['vdelta deny', RG_DENY],
  ['spawn が null', null],
  ['spawn が throw', () => { throw new Error('injected'); }],
  ['results 欠落', { results: [] }],
]) {
  test(`[observational-ac] (I) redgreen-final が ${name} → 昇格せず ac_human_pending の HOLD のまま`, async () => {
    const { result, calls } = await runFinalRedgreen([byTest(0), inspection(1)], rgFinal);
    assert.equal(rgFinalCalls(calls).length, 1);
    assert.equal(reimplCalls(calls).length, 0);
    assert.equal(result?.final_ac_reconcile, 'reverified');
    assert.equal(result?.merge_tier, 'HOLD');
    assert.deepEqual(plain(result.merge_tier_hold_reasons.map((r) => r.code)), ['ac_human_pending']);
    assert.deepEqual(plain(result.final_unsatisfied_ac_by_actor), { agent: [], human: [0], ci: [] });
  });
}

// redgreen-final の start → wait（issue #1226）: 結果は wait から受け取り、上限・読めない応答では stop して昇格しない
const FINAL_RUNNING = { status: 'running', results: [] };
const runFinalRedgreenWait = (overrides) => run({
  'eval#1': evalWith([byTest(0), inspection(1)]),
  redgreen: RG_NOT_RED,
  ...FINAL_OK,
  'final-ac-reconcile': { ac_results: [byTest(0), inspection(1)] },
  'redgreen-final': FINAL_RUNNING,
  ...overrides,
}, { workflow: FIXED_ITERATE });

test('[observational-ac] (H2) redgreen-final が running → wait で結果 → 昇格して HOLD せず、stop は呼ばない', async () => {
  const { result, calls } = await runFinalRedgreenWait({ 'redgreen-final-wait#1': FINAL_RUNNING, 'redgreen-final-wait#2': RG_PROVEN });
  const labels = calls.map((c) => c.label).filter((l) => l.startsWith('redgreen-final'));
  assert.deepEqual(labels, ['redgreen-final', 'redgreen-final-wait#1', 'redgreen-final-wait#2']);
  assert.equal(calls.find((c) => c.label === 'redgreen-final-wait#1').prompt.split('\n')[1], 'redgreen-verify wait --state-dir /tmp/rg-state --wait-sec 450');
  assert.equal(result?.merge_tier, 'REVIEW', JSON.stringify(result?.merge_tier_hold_reasons));
});

const finalWaitCapped = {};
for (let k = 1; k <= REDGREEN_WAIT_POLLS + 2; k++) finalWaitCapped[`redgreen-final-wait#${k}`] = FINAL_RUNNING;
for (const [name, overrides, waits] of [
  ['上限まで running', finalWaitCapped, REDGREEN_WAIT_POLLS],
  ['wait が null', { 'redgreen-final-wait#1': null }, 1],
  ['wait が schema に合わない', { 'redgreen-final-wait#1': { status: 'passed', results: [{ index: 0, red: true, green: true }] } }, 1],
]) {
  test(`[observational-ac] (I2) redgreen-final の ${name} → stop して昇格せず ac_human_pending の HOLD のまま`, async () => {
    const { result, calls } = await runFinalRedgreenWait(overrides);
    assert.equal(calls.filter((c) => c.label.startsWith('redgreen-final-wait#')).length, waits);
    assert.equal(calls.filter((c) => c.label === 'redgreen-final-stop').length, 1);
    assert.equal(result?.merge_tier, 'HOLD');
    assert.deepEqual(plain(result.merge_tier_hold_reasons.map((r) => r.code)), ['ac_human_pending']);
    assert.deepEqual(plain(result.final_unsatisfied_ac_by_actor), { agent: [], human: [0], ci: [] });
  });
}

test('[observational-ac] (J) final evaluator が inspection で返した観測型 AC は redgreen-final を spawn せず人手 AC 待ち', async () => {
  const { result, calls } = await runFinalRedgreen([inspection(0), inspection(1)], RG_PROVEN);
  assert.equal(rgFinalCalls(calls).length, 0, `inspection の観測型 AC で redgreen-final が走った: ${calls.map((c) => c.label).join(', ')}`);
  assert.equal(result?.merge_tier, 'HOLD');
  assert.deepEqual(plain(result.merge_tier_hold_reasons.map((r) => r.code)), ['ac_human_pending']);
});

test('[observational-ac] (K) Evaluate で red→green 実証済みの観測型 AC は final evaluator が test で返しても redgreen-final を spawn しない', async () => {
  const { result, calls } = await runFinalRedgreen([byTest(0), inspection(1)], RG_NOT_RED, [byTest(0), inspection(1)], RG_PROVEN);
  assert.equal(rgFinalCalls(calls).length, 0, `昇格済みの AC で redgreen-final が走った: ${calls.map((c) => c.label).join(', ')}`);
  assert.equal(result?.merge_tier, 'REVIEW', JSON.stringify(result?.merge_tier_hold_reasons));
  assert.ok(!calls.find((c) => c.label === 'final-ac-reconcile').prompt.includes('観測型 AC（ac_index'), '昇格済みの AC を未実証として final evaluator に渡している');
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

test('[observational-ac] (L) テストファイルを名指しした観測型 AC の inspection 判定 → 差し戻し、上限後も未達なら ac_agent_unsatisfied の HOLD（人手 AC 待ちにしない）', async () => {
  const TEST_OBS_AC = '`journal.bats` に足すテストで、実 run の journal に `duration_seconds` が記録されることを確かめる';
  const evals = Object.fromEntries(Array.from({ length: AGENT_AC_REIMPL_MAX + 1 }, (_, k) => [`eval#${k + 1}`, evalWith([inspection(0), inspection(1)])]));
  const { result, calls } = await run(evals, { analyze: prerunAnalyze({ acceptance_criteria: [TEST_OBS_AC, CODE_AC] }) });
  const reimpl = reimplCalls(calls);
  assert.equal(reimpl.length, AGENT_AC_REIMPL_MAX, `差し戻しは上限 ${AGENT_AC_REIMPL_MAX} 回: ${calls.map((c) => c.label).join(', ')}`);
  assert.match(reimpl[0].prompt, /AC-1 未達/);
  assert.equal(result?.merge_tier, 'HOLD');
  assert.deepEqual(plain(result.merge_tier_hold_reasons.map((r) => r.code)), ['ac_agent_unsatisfied']);
  assert.deepEqual(plain(result.final_unsatisfied_ac_by_actor), { agent: [0], human: [], ci: [] });
  const prCall = calls.find((c) => c.label === 'pr#1');
  assert.ok(prCall.prompt.includes(`- [ ] ${TEST_OBS_AC}`), `PR 本文で red→green 実証の無い観測型 AC が checked になった: ${prCall.prompt}`);
});

// AC 3 件の issue（issue #1259）。AC-1 は旧来の正規表現の絞り込みが取りこぼした観測型 AC（plugin の install）
const ACS3 = ['plugin を install すると skill 一覧に出る', CODE_AC, '`launchctl` に登録され、翌朝 07:00 に起動する'];
const EVAL3 = { 'eval#1': evalWith(ACS3.map((_, i) => inspection(i))) };
const run3 = (acObs) => run(EVAL3, { analyze: prerunAnalyze({ acceptance_criteria: ACS3 }), acObs });
const reqObservational = (calls) => evalCalls(calls)[0].prompt.match(/"ac_observational":(\[[^\]]*\])/)?.[1];

test('[observational-ac] (M) AC 3 件の issue で分類 agent は 1 回だけ呼ばれ、全 AC（index 0・1・2）を受け取る', async () => {
  const { calls } = await run3(acObservationalResponse([true, false, true]));
  const obs = acObsCalls(calls);
  assert.equal(obs.length, 1, `分類 agent は 1 回: ${calls.map((c) => c.label).join(', ')}`);
  assert.deepEqual(acObservationalPromptIndexes(obs[0].prompt), [0, 1, 2]);
  for (const [i, ac] of ACS3.entries()) assert.ok(obs[0].prompt.includes(acItemHead(i, ac)), obs[0].prompt);
  assert.equal(reqObservational(calls), '[true,false,true]', '分類 agent の boolean をそのまま採る');
});

for (const [name, acObs, observational, human] of [
  ['agent が null を返した AC', acObservationalResponse([null, false, false]), '[true,false,false]', [0]],
  ['agent の応答に無い AC', acObservationalResponse([false, false]), '[false,false,true]', [2]],
  ['agent が失敗（null）した run', null, '[true,true,true]', [0, 1, 2]],
  ['agent が throw した run', () => { throw new Error('injected'); }, '[true,true,true]', [0, 1, 2]],
]) {
  test(`[observational-ac] (N) ${name} → その AC を観測型（true）として扱い、inspection の達成は人手 AC 待ちに倒す`, async () => {
    const { result, calls } = await run3(acObs);
    assert.equal(acObsCalls(calls).length, 1);
    assert.equal(reqObservational(calls), observational, evalCalls(calls)[0].prompt.slice(0, 2000));
    assert.equal(reimplCalls(calls).length, 0);
    assert.equal(result?.merge_tier, 'HOLD');
    assert.deepEqual(plain(result.final_unsatisfied_ac_by_actor), { agent: [], human, ci: [] });
  });
}

// 回帰（issue #859）: acme/webapp の AC。分類 agent の応答は observational-ac-controls.mjs の正しい観測型判定と同じ値
const REG_ACS = APP_REPO_REGRESSION_ACS.map((r) => r.ac);
const REG_TITLE = 'test(video): テストの件数の直書きを整理する';
const REG_ANALYZE = prerunAnalyze({ issue_title: REG_TITLE, acceptance_criteria: REG_ACS });
const REG_EVAL = { 'eval#1': evalWith(REG_ACS.map((_, i) => inspection(i))) };

test('[observational-ac] (F) 回帰: 全 AC を AC 文面 + title で分類 agent に 1 回渡し、#104 AC#2 は観測型にせず HOLD は観測型の AC だけ', async () => {
  const { result, calls } = await run(REG_EVAL, { analyze: REG_ANALYZE, acObs: acObservationalResponse(APP_REPO_REGRESSION_ACS.map((r) => r.observational)) });
  const obs = acObsCalls(calls);
  assert.equal(obs.length, 1, `分類 agent は 1 回: ${calls.map((c) => c.label).join(', ')}`);
  assert.equal(obs[0].agentType, 'dev-flow:dev-runner');
  assert.ok(obs[0].prompt.includes(JSON.stringify(REG_TITLE)), `title が渡っていない: ${obs[0].prompt}`);
  for (const [i, ac] of REG_ACS.entries()) assert.ok(obs[0].prompt.includes(acItemHead(i, ac)), `AC-${i + 1} が渡っていない: ${obs[0].prompt}`);
  assert.ok(!obs[0].prompt.includes('issue-body.md'), 'issue 本文のファイルを読ませている');
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

test('[observational-ac] (G) 分類 agent が失敗（null）なら全 AC を観測型（true）として人手 AC 待ちに回す', async () => {
  const { result, calls } = await run({ ...REG_EVAL, 'ac-observational#1': null }, { analyze: REG_ANALYZE });
  assert.equal(acObsCalls(calls).length, 1);
  assert.equal(reimplCalls(calls).length, 0);
  assert.equal(result?.merge_tier, 'HOLD');
  assert.deepEqual(plain(result.final_unsatisfied_ac_by_actor), { agent: [], human: [0, 1, 2, 3, 4], ci: [] });
});

// pipeline が実行したテストの入口だけを inline code に書いた観測型 AC（issue #1297）: 最終 tree を検証した run の結果と入口の変更有無を
// 終端サマリーのその AC の行に開示するだけで、ac_human_pending の HOLD と AC の未達は変えない。
//   (O) fix なしの run は Validate（state.val）の結果を開示する
//   (P) fix 適用 run は test#final の結果だけを開示し、Validate の green は出さない
const ENTRY_AC = '`bash tests/run-all-bats.sh` と `bash tests/run-node-tests.sh` が green';
const ENTRY_SCRIPTS = (exit) => ['tests/run-all-bats.sh', 'tests/run-node-tests.sh'].map((p, i) => ({ path: `/tmp/wt/${p}`, exit, launch_failed: false, log: `/tmp/run-tests-x/${i}.log` }));
const ENTRY_VALIDATE_GREEN = { 'test#1': { tests: 'passed', green: true, summary: 'passed', scripts: ENTRY_SCRIPTS(0) } };
const ENTRY_LIST = '入口 `tests/run-all-bats.sh`・`tests/run-node-tests.sh` を実行して';
const ENTRY_TAIL = '— 選択実行の可能性があり全件実行とは限らない。人手確認の材料（AC の達成判定には使っていない）';
const runEntryAc = (overrides, opts = {}) => run({ 'eval#1': evalWith([inspection(0), inspection(1)]), ...ENTRY_VALIDATE_GREEN, ...overrides }, { analyze: prerunAnalyze({ acceptance_criteria: [ENTRY_AC, CODE_AC] }), ...opts });
const entryAcRow = (calls) => {
  const summary = calls.find((c) => c.label === 'post-summary');
  assert.ok(summary, 'post-summary が走る');
  return summary.prompt.split('\n').find((l) => l.startsWith('| ❌ 未達 | AC#1（観測型） |')) ?? '';
};
const assertEntryAcStillPending = (result, calls) => {
  assert.equal(result?.merge_tier, 'HOLD');
  assert.ok(plain(result.merge_tier_hold_reasons.map((r) => r.code)).includes('ac_human_pending'), JSON.stringify(result.merge_tier_hold_reasons));
  assert.deepEqual(plain(result.final_unsatisfied_ac_by_actor), { agent: [], human: [0], ci: [] });
  assert.ok(calls.find((c) => c.label === 'pr#1').prompt.includes(`- [ ] ${ENTRY_AC}`), '入口の green で AC を達成扱いにした');
};

test('[observational-ac] (O) テストの入口だけの観測型 AC は ac_human_pending の HOLD のまま、行に Validate の green と入口の変更有無を開示する', async () => {
  const { result, calls } = await runEntryAc({});
  assertEntryAcStillPending(result, calls);
  assert.deepEqual(plain(result.merge_tier_hold_reasons.map((r) => r.code)), ['ac_human_pending']);
  const row = entryAcRow(calls);
  assert.ok(row.includes(`pipeline の Validate（run: validate）が${ENTRY_LIST} green（PR はこの入口を変更していない）${ENTRY_TAIL}`), row);
});

test('[observational-ac] (P) fix 適用 run で test#final が red なら、Validate が green でも行には test#final の red だけを開示し、HOLD は外さない', async () => {
  const { result, calls } = await runEntryAc({
    'reconcile-sync': { ok: true, head: 'a'.repeat(40) },
    'test#final': { tests: 'failed', green: false, summary: 'not ok 1 x', failed_files: [], scripts: ENTRY_SCRIPTS(1) },
  }, { workflow: FIXED_ITERATE });
  assertEntryAcStillPending(result, calls);
  assert.ok(plain(result.merge_tier_hold_reasons.map((r) => r.code)).includes('final_test_red'), JSON.stringify(result.merge_tier_hold_reasons));
  const row = entryAcRow(calls);
  assert.ok(row.includes(`pipeline の Final reconcile の test#final（run: test_final）が${ENTRY_LIST} red（PR はこの入口を変更していない）${ENTRY_TAIL}`), row);
  assert.ok(!row.includes('Validate'), `最終 tree と異なる tree の Validate の結果を開示した: ${row}`);
  assert.ok(!row.includes(' green（'), row);
});
