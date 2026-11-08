// finalize-stage-routing.test.mjs — dev-flow.js が pr-iterate 後の工程を nested workflow（dev-flow-finalize.js）に任せる
// 境界を pin する。
//   (1) 子は workflow('dev-flow:dev-flow-finalize-run') で 1 回だけ起動され、親は子の返り値を自分の返り値に使う
//   (2) 子が throw した・返り値の形が不正な run は merge tier HOLD・終端サマリ未投稿の注記を返り値と log に出す
//   (3) journal handoff は親が run ごとにちょうど 1 回（成功・子の throw・不正な返り値のどれでも）。子は handoff しない
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { stripComments } from '../../../tools/sync-inlines.mjs';
import { neutralizeRegexLiterals, blankStringLiterals } from './test-helpers/source-scan.mjs';
import { makeDevFlowSandbox, runWorkflowCapture, FINALIZE_WORKFLOW } from './test-helpers/vm-sandbox.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const devFlowSrc = readFileSync(join(HERE, '..', '.claude', 'workflows', 'dev-flow.js'), 'utf8');
const finalizeSrc = readFileSync(join(HERE, '..', '.claude', 'workflows', 'dev-flow-finalize.js'), 'utf8');

const ITERATE = { status: 'lgtm', iterations: 1, fixes_applied: 0 };

function handoffs(calls) {
  return calls.filter((c) => c.label.startsWith('journal-log')).map((c) => {
    const m = c.prompt.match(/<<<JOURNAL_HANDOFF_BODY_BEGIN>>>\n([\s\S]*?)\n<<<JOURNAL_HANDOFF_BODY_END>>>/);
    assert.ok(m, `${c.label} の prompt に handoff payload が無い`);
    return { label: c.label, payload: JSON.parse(m[1]) };
  });
}

// connectFinalize:false の run 用: 子の返り値・throw を stub が決め、起動の回数と args を記録する
function stubbedWorkflow(finalize) {
  const launches = [];
  const workflow = async (name, a) => {
    launches.push({ name, args: a });
    if (name === FINALIZE_WORKFLOW) return finalize(a);
    return ITERATE;
  };
  return { workflow, launches };
}

async function runStubbed(finalize) {
  const { workflow, launches } = stubbedWorkflow(finalize);
  const { ctx, calls, logs } = makeDevFlowSandbox({ workflow });
  const { result, error } = await runWorkflowCapture(devFlowSrc, ctx, '.claude/workflows/dev-flow.js', { connectFinalize: false });
  return { result, error, calls, logs, launches };
}

function assertFinalizeHold({ result, error, calls, logs }, why) {
  assert.equal(error, null, `${why}: 子の失敗で run が abort した: ${error?.message}`);
  assert.equal(result?.merge_tier, 'HOLD', `${why}: merge tier が HOLD でない: ${result?.merge_tier}`);
  assert.equal(result?.summary_posted, false, `${why}: summary_posted が false でない`);
  assert.match(result?.note ?? '', /終端サマリ未投稿/, `${why}: 返り値の note に終端サマリ未投稿の注記が無い: ${result?.note}`);
  assert.ok(logs.some((l) => l.includes('dev-flow-finalize が失敗') && l.includes('終端サマリ未投稿')), `${why}: log に子の失敗と終端サマリ未投稿の注記が無い`);
  assert.ok(result?.merge_tier_reasons?.some((r) => r.includes('dev-flow-finalize が失敗')), `${why}: merge_tier_reasons に子の失敗が無い`);
  const hs = handoffs(calls);
  assert.deepEqual(hs.map((h) => h.label), ['journal-log'], `${why}: journal handoff は親の 1 回のはず`);
  const { payload } = hs[0];
  assert.equal(payload.skill, 'dev-flow');
  assert.equal(payload.outcome, 'failure');
  assert.equal(payload.error_category, 'abort');
  assert.equal(payload.error_phase, 'Final reconcile');
  assert.match(payload.error_msg, /^abort@Final reconcile\/dev-flow-finalize: /);
  assert.equal(payload.telemetry.merge_tier, 'HOLD');
  assert.deepEqual(payload.telemetry.hold_reason_codes, []);
}

test('[finalize-stage] 成功: 子を 1 回起動し、親は子の返り値を返り値に使い、journal handoff は親の 1 回だけ', async () => {
  const childResult = {
    merge_tier: 'REVIEW', merge_tier_reasons: ['stub-reason'], merge_tier_hold_reasons: [], merge_tier_hold_kind: null,
    hold_ac_human_judged: null, eval_staleness: 'none', ledger_blocking: 0, ledger_advisory: 3, ledger_converged: true,
    danger_hits: [], danger_fail_closed: false, testsurf_hits: [], final_reconcile: 'skipped', final_test_green: null,
    final_test_flaky: null, final_ac_reconcile: 'skipped', final_unsatisfied_ac: false,
    final_unsatisfied_ac_by_actor: { agent: [], human: [], ci: [] }, ci_verify: null, local_verify: null,
    security_review: { target: false, status: 'not_target' }, pr_closes_status: 'verified', pr_body_synced: null,
    summary_posted: true, final_end_epoch: null, end_epoch: 2000, note: 'stub-note',
  };
  const run = await runStubbed(() => childResult);
  assert.equal(run.error, null, `run が throw した: ${run.error?.message}`);
  assert.deepEqual(run.launches.map((l) => l.name), ['dev-flow:pr-iterate-run', FINALIZE_WORKFLOW]);
  for (const [k, v] of Object.entries(childResult)) {
    if (k === 'hold_ac_human_judged' || k === 'final_end_epoch' || k === 'end_epoch') continue;
    assert.deepEqual(run.result[k], v, `返り値の ${k} が子の値でない`);
  }
  const hs = handoffs(run.calls);
  assert.deepEqual(hs.map((h) => h.label), ['journal-log']);
  assert.equal(hs[0].payload.outcome, 'success');
  assert.equal(hs[0].payload.telemetry.merge_tier, 'REVIEW');
  // 子に渡す args は JSON の値だけ（workflow() の境界を越えられない関数・undefined を含めない）
  const args = run.launches[1].args;
  const nonJson = (v, path) => {
    if (v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) return [];
    if (Array.isArray(v)) return v.flatMap((x, i) => nonJson(x, `${path}[${i}]`));
    if (typeof v === 'object') return Object.entries(v).flatMap(([k, x]) => nonJson(x, `${path}.${k}`));
    return [`${path}: ${typeof v}`];
  };
  assert.deepEqual(nonJson(args, 'args'), []);
  assert.equal(args.issue, '1');
  assert.equal(args.worktree, '/tmp/wt');
});

test('[finalize-stage] 子の実行（connect）でも journal handoff は親の 1 回だけで、子の agent は Final reconcile / Merge tier の phase で走る', async () => {
  const { ctx, calls, phases } = makeDevFlowSandbox();
  const { result, error } = await runWorkflowCapture(devFlowSrc, ctx);
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  assert.equal(result?.merge_tier, 'REVIEW');
  assert.equal(result?.summary_posted, true);
  assert.deepEqual(phases.slice(-2), ['Final reconcile', 'Merge tier']);
  const hs = handoffs(calls);
  assert.deepEqual(hs.map((h) => h.label), ['journal-log']);
  assert.equal(hs[0].payload.outcome, 'success');
  assert.equal(hs[0].payload.telemetry.merge_tier, result.merge_tier);
  const post = calls.findIndex((c) => c.label === 'post-summary');
  const journal = calls.findIndex((c) => c.label === 'journal-log');
  assert.ok(post !== -1 && post < journal, '終端サマリーの投稿（子）の後に親が handoff するはず');
});

test('[finalize-stage] 子の agent が throw（connect: post-summary）→ HOLD・終端サマリ未投稿の注記・handoff は親の 1 回', async () => {
  const { ctx, calls, logs } = makeDevFlowSandbox({ overrides: { 'post-summary': () => { throw new Error('injected'); } } });
  const { result, error } = await runWorkflowCapture(devFlowSrc, ctx);
  assertFinalizeHold({ result, error, calls, logs }, 'post-summary throw');
  assert.match(handoffs(calls)[0].payload.error_msg, /injected/);
});

test('[finalize-stage] workflow() が throw → HOLD・終端サマリ未投稿の注記・handoff は親の 1 回', async () => {
  const run = await runStubbed(() => { throw new Error('child exploded'); });
  assertFinalizeHold(run, 'workflow throw');
  assert.equal(run.launches.filter((l) => l.name === FINALIZE_WORKFLOW).length, 1, '子の throw の後に再起動してはならない');
  assert.match(handoffs(run.calls)[0].payload.error_msg, /child exploded/);
});

test('[finalize-stage] 子の返り値の形が不正（必須キー欠落・型違い・null）→ HOLD・終端サマリ未投稿の注記・handoff は親の 1 回', async () => {
  for (const [why, ret, re] of [
    ['必須キー欠落', { merge_tier: 'REVIEW' }, /必須のキー merge_tier_reasons が無い/],
    ['型違い', { merge_tier: 'REVIEW', merge_tier_reasons: 'ok' }, /キー merge_tier_reasons の型が array でない/],
    ['null', null, /object が必要（受信: null）/],
  ]) {
    const run = await runStubbed(() => ret);
    assertFinalizeHold(run, why);
    assert.match(run.result.merge_tier_reasons[0], re, `${why}: HOLD 理由に検証の失敗が無い`);
  }
});

// 子は handoff しない・workflow() を呼ばない（nested は 1 段）。inline 区間（journal-handoff の canonical）は除いて見る。
test('[finalize-stage] 静的: dev-flow-finalize.js の手書き部分は journal handoff も workflow() も呼ばず、dev-flow.js は子を 1 か所で起動する', () => {
  const body = (src) => blankStringLiterals(stripComments(neutralizeRegexLiterals(
    src.replace(/\/\/ ==== BEGIN inline: [^\n]*\n[\s\S]*?\/\/ ==== END inline: [^\n]*\n?/g, ''))));
  const child = body(finalizeSrc);
  for (const re of [/\brunJournalHandoff\s*\(/, /\bbuildJournalHandoffPayload\s*\(/, /\bbuildAbortHandoffPayload\s*\(/, /(?<![\w$.])workflow\s*\(/]) {
    assert.doesNotMatch(child, re, `dev-flow-finalize.js の手書き部分に ${re} がある`);
  }
  assert.equal(devFlowSrc.split(`workflow('${FINALIZE_WORKFLOW}'`).length - 1, 1, 'dev-flow.js は dev-flow-finalize を 1 か所で起動するはず');
});

// Validate / Evaluate（dev-flow.js）と Final reconcile（dev-flow-finalize.js）は同じ exec-proxy を同じ手順で起動する。
// 副作用の無い schema は _lib/stage-schemas.mjs の inline で共有し、agent を起動する helper は両ファイルの定義が
// byte 一致することをここで pin する（片方だけ直すと Final reconcile が Validate とずれる）。
// trackedAgent は親だけが ABORT_CTX を持つので対象外。
const SHARED_HELPERS = [
  'failOpenAgent', 'RECHECK_RESOLUTIONS_SCHEMA', 'TEST_RUN_PROMPT', 'runTestsAgent', 'runRedgreenVerify',
  'runLocalVerifyOnce', 'runAcVerifyOnce', 'acVerifyOutcome', 'recordAcVerify', 'localVerifyTreeHash', 'treeDiffNumstatPrompt',
];
function topLevelDefinition(src, name) {
  const lines = src.replace(/\/\/ ==== BEGIN inline: [^\n]*\n[\s\S]*?\/\/ ==== END inline: [^\n]*\n?/g, '').split('\n');
  const head = new RegExp(`^(?:async function|function|const|let) ${name}\\b`);
  const starts = lines.flatMap((l, i) => (head.test(l) ? [i] : []));
  assert.equal(starts.length, 1, `${name} の top-level 定義が 1 つでない（${starts.length} 件）`);
  const i = starts[0];
  if (!lines[i].endsWith('{')) return lines[i];
  const end = lines.findIndex((l, k) => k > i && /^}/.test(l));
  return lines.slice(i, end + 1).join('\n');
}

test('[finalize-stage] 静的: Validate と Final reconcile が共有する helper は dev-flow.js と dev-flow-finalize.js で byte 一致する', () => {
  for (const name of SHARED_HELPERS) {
    assert.equal(topLevelDefinition(finalizeSrc, name), topLevelDefinition(devFlowSrc, name), `${name} の定義が dev-flow.js と dev-flow-finalize.js でずれている`);
  }
});
