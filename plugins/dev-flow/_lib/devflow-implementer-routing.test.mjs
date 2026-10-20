// Implement 経路が全 shape で dev-implementer 一本であることを dev-flow.js 全体の VM 実行で
// pin する（issue #668 / #670 / #673）。planner 経路（dev-planner ⇄ plan-reviewer → implementer）と
// IMPLEMENT_MODE は #673 で削除済み — ロールバックは git revert（定数切替の scaffolding は残さない）。
//
//   AC-1: dev-flow.js に planner 経路のシンボル・PLAN/VERDICT schema・dev-planner / plan-reviewer /
//         implementer の agentType 文字列が残っていない（静的 pin）
//   AC-3: 全 shape で Analyze 直後に合成 plan のみ（implement#synth-plan log）。Implement は
//         dev-implementer の単一 serial spawn（impl:serial:issue-<N>）で、parallel / pipeline を
//         sandbox に置かなくても完走する。返却 null は implDroppedCount に 1 として計上される
//   AC-5: Evaluate 差し戻し（reimpl#i、fix_feedback 付き）が dev-implementer に渡る
//   AC-6: Validate green-fix（green-fix#i / green-fix#retry-i）が dev-implementer で spawn され、
//         テスト弱体化禁止・失敗内容・STAGING_CONVENTION が prompt に残る
//   AC-7: PR phase の pr.head_sha が workflow('dev-flow:pr-iterate-run') の nested.head_sha へ渡る
//         （review#2 以降の fix delta 起点。nested 起動のみが本番経路で pr-meta probe を通らないため）。
//         pr.head_sha が空文字・欠落のときは nested に head_sha キー自体を含めない
//   PR 失敗 (#682/#823): pr#<issue> の中断応答（committed:false / pr_url 空 / pr_number 非正）は
//         nested pr-iterate・Merge tier へ流さず、throw せず failed_step / failure_reason を返り値に載せて
//         終端し、failure handoff（error_category: pr_phase_failed）を書く。正常系は従来どおり nested pr-iterate まで進む
//   prompt: issue_body + acceptance_criteria + task_id + 配置規約を含み、AC テスト契約は含まない
//
// BLOCKED 再実装（reimpl-blocked#b）は blocked-replan-history.test.mjs / guard-blocked-routing.test.mjs。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { stripComments } from '../../../tools/sync-inlines.mjs';
import { neutralizeRegexLiterals } from './test-helpers/source-scan.mjs';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash, MICRO_FILES, analyzeArgs } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', '.claude', 'workflows', 'dev-flow.js'), 'utf8');

const IMPLEMENTER = 'dev-flow:dev-implementer';
const GONE_AGENTS = ['dev-planner', 'plan-reviewer', 'implementer'];

const ISSUE_BODY = '## 背景\n本文の一段落。\n\n## 受け入れ基準\n- [ ] a\n- [ ] b';
const AC = ['ac-one', 'ac-two', 'ac-three', 'ac-four'];

// REQ は args.setup.analyze（prerun の analyze 段）から組まれるため、shape 別の analyze を setup に注入する。
// 実効 shape は realized diff の file 数 + AC 数で決まる（issue #676）: micro は realized 1 件 / AC 2、
// standard は既定の 3 件 / AC 4、complex は AC 7 件（realized 数に関わらず complex）。
function analyzeOf(shape, overrides = {}) {
  const base = { issue_body: ISSUE_BODY, issue_body_truncated: false };
  if (shape === 'micro') return { ...base, acceptance_criteria: ['a', 'b'], issue_type: 'fix', ...overrides };
  if (shape === 'complex') return { ...base, acceptance_criteria: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], issue_type: 'feat', ...overrides };
  return { ...base, acceptance_criteria: AC, issue_type: 'feat', ...overrides };
}
function argsOf(shape, overrides = {}) {
  const args = analyzeArgs(1, analyzeOf(shape, overrides));
  for (const k of Object.keys(overrides)) if (overrides[k] === undefined) delete args.setup.analyze[k];
  return args;
}
function filesOf(shape) {
  if (shape === 'micro') {
    return {
      'impl:serial:issue-1': { status: 'DONE', task_id: 'issue-1', files: [...MICRO_FILES], summary: 's', concerns: [] },
      'danger-grep': { risk: { ok: true, hits: [] }, files: [...MICRO_FILES], struct: null, diffhash: { hash: 'AAA', empty: false } },
      'ci-check-lite': { status: 'passed', passed: 1, failed: 0, pending: 0, skipped: 0, failed_checks: [], waited_seconds: 0, poll_attempts: 0 },
    };
  }
  return {};
}

async function runFlow(shape, overrides = {}, extra = {}, analyzeOverrides = {}) {
  const { ctx, calls, logs } = makeDevFlowSandbox({ overrides: { ...filesOf(shape), ...overrides }, extra: { args: argsOf(shape, analyzeOverrides), ...extra } });
  const { result, error } = await runWorkflowCapture(src, ctx);
  assertNoCrash(error, shape);
  return { calls, logs, result, error, ctx };
}

const byType = (calls, t) => calls.filter((c) => c.agentType === t);
const goneCalls = (calls) => calls.filter((c) => GONE_AGENTS.some((g) => c.agentType === `dev-flow:${g}`));

// journal handoff prompt から JOURNAL_HANDOFF_BODY 区間の JSON を抽出する
function parseJournalHandoffPayload(prompt) {
  const match = prompt.match(/<<<JOURNAL_HANDOFF_BODY_BEGIN>>>\n([\s\S]*?)\n<<<JOURNAL_HANDOFF_BODY_END>>>/);
  assert.ok(match, `journal handoff prompt に JOURNAL_HANDOFF_BODY delimiter が見つからない。prompt:\n${prompt}`);
  return JSON.parse(match[1]);
}

// ============================================================
// AC-1: 静的 pin — planner 経路のシンボルと agentType 文字列が 0 件
// ============================================================
test('[implementer] AC-1 静的 pin: dev-flow.js に planner 経路のシンボル・schema・agentType 文字列が残っていない', () => {
  const code = stripComments(neutralizeRegexLiterals(src));
  // 識別子は語境界で照合する（DESIGN_REPLAN_MAX が PLAN_MAX の部分文字列として誤検知されないように）
  const forbiddenSymbols = [
    'IMPLEMENT_MODE', 'PLAN_SOLO', 'soloPlanPrompt', 'planConverged', 'findingsToConcerns',
    'PLAN_MAX', 'PLAN_STUCK', 'planSeen', 'PLANNER_TEST_PLAN_RULE', 'PLANNER_HANDOFF_RULE',
    'AC_TEST_CONTRACT', 'applyDisjoint', 'countPlanDrops', 'pipeline',
  ];
  for (const sym of forbiddenSymbols) {
    assert.ok(!new RegExp(`\\b${sym}\\b`).test(code), `dev-flow.js に planner 経路のシンボル '${sym}' が残っている`);
  }
  for (const schema of ['PLAN', 'VERDICT']) {
    assert.ok(!new RegExp(`\\bconst ${schema}\\b`).test(code), `dev-flow.js に ${schema} schema 定義が残っている`);
    assert.ok(!new RegExp(`schema: ${schema}\\b`).test(code), `dev-flow.js に schema: ${schema} の call site が残っている`);
  }
  for (const agent of GONE_AGENTS) {
    const hits = code.match(new RegExp(`'${agent}'`, 'g')) ?? [];
    assert.equal(hits.length, 0, `dev-flow.js に agentType 文字列 '${agent}' が ${hits.length} 件残っている`);
  }
  assert.ok(!/typeof pipeline/.test(code), 'dev-flow.js に pipeline() の存在チェック（fail-fast）が残っている');
});

// ============================================================
// AC-3: 全 shape で合成 plan → dev-implementer 1 spawn（parallel / pipeline なし）
// ============================================================
for (const shape of ['micro', 'standard', 'complex']) {
  test(`[implementer] AC-3 ${shape}: planner 系 agent 0 回・dev-implementer 1 回（impl:serial:issue-1）・implement#synth-plan・sandbox に parallel/pipeline 不在で完走`, async () => {
    const { calls, logs, error, ctx } = await runFlow(shape);
    assert.equal(error, null, `run が throw した: ${error?.message}`);
    assert.equal(typeof ctx.pipeline, 'undefined', 'sandbox に pipeline() が注入されている（削除済みのはず）');
    assert.equal(typeof ctx.parallel, 'undefined', 'sandbox に parallel() が注入されている（削除済みのはず）');
    assert.equal(goneCalls(calls).length, 0, `planner 系 agent が起動した: ${goneCalls(calls).map((c) => `${c.agentType}:${c.label}`).join(', ')}`);
    const impl = byType(calls, IMPLEMENTER);
    assert.deepEqual(impl.map((c) => c.label), ['impl:serial:issue-1'], `dev-implementer は Implement で 1 回のはず: ${impl.map((c) => c.label).join(', ')}`);
    assert.equal(calls.filter((c) => c.label.includes(':par:')).length, 0, 'parallel fan-out の label（:par:）が観測された');
    assert.ok(logs.some((l) => l.includes('implement#synth-plan')), 'implement#synth-plan の log が無い');
  });
}

test('[implementer] AC-3: dev-implementer が null を返すと drop 1 として log され、micro でも evaluator が強制される', async () => {
  const { calls, logs, error } = await runFlow('micro', { 'impl:serial:issue-1': null });
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  assert.ok(logs.some((l) => l.includes('impl: dev-implementer 1 件が失敗(null)')), `drop の log が無い: ${logs.filter((l) => l.includes('失敗')).join(' | ')}`);
  assert.ok(logs.some((l) => l.includes('implement drop 1 件')), `implDroppedCount=1 で Evaluate 強制の log が無い: ${logs.filter((l) => l.includes('drop')).join(' | ')}`);
  assert.ok(byType(calls, 'dev-flow:evaluator').length >= 1, 'drop 発生時は micro でも evaluator が起動するはず');
});

// ============================================================
// prompt: issue_body / acceptance_criteria / task_id / 配置規約を含み、AC テスト契約は含まない
// ============================================================
test('[implementer] dev-implementer の prompt に issue_body・acceptance_criteria・task_id・配置規約が含まれ、AC テスト契約は含まれない', async () => {
  const { calls } = await runFlow('standard');
  const [call] = byType(calls, IMPLEMENTER);
  assert.ok(call, 'dev-implementer の call が無い');
  assert.ok(call.prompt.includes(ISSUE_BODY), 'prompt に issue_body（req.issue_body）が含まれない');
  assert.ok(call.prompt.includes(JSON.stringify(AC)), 'prompt に acceptance_criteria が含まれない');
  assert.ok(call.prompt.includes('task_id: issue-1'), 'prompt に合成 task の task_id が含まれない');
  assert.ok(call.prompt.includes('一時/handoff ファイルの配置規約'), 'prompt に STAGING_CONVENTION が含まれない');
  assert.ok(!call.prompt.includes('AC テスト契約'), 'prompt に AC テスト契約（red→green 自己実証）が含まれている');
  assert.ok(!call.prompt.includes('次の task を実装せよ'), 'prompt が手順書型になっている');
  assert.ok(!call.prompt.includes('前回実装が BLOCKED になった'), '初回 Implement の prompt に BLOCKED 再実装の文言が含まれている');
});

test('[implementer] issue_body_truncated:true → prompt に切詰め注記が付く / issue_body 欠落 → 本文なし注記', async () => {
  const truncated = await runFlow('standard', {}, {}, { issue_body_truncated: true });
  const [t] = byType(truncated.calls, IMPLEMENTER);
  assert.ok(t.prompt.includes('切詰め済み'), 'issue_body_truncated:true の注記が無い');
  const missing = await runFlow('standard', {}, {}, { issue_body: undefined, issue_body_truncated: undefined });
  const [m] = byType(missing.calls, IMPLEMENTER);
  assert.ok(m.prompt.includes('issue 本文: analyze 出力に含まれていない'), 'issue_body 欠落時の注記が無い');
});

test('[implementer] 返却 files（src/x.ts）が宣言として取り込まれ、宣言外変更 concern が出ない', async () => {
  const { logs } = await runFlow('standard');
  assert.ok(logs.some((l) => l.includes('宣言外変更なし')), `declared-path-check が宣言外なしにならない: ${logs.filter((l) => l.includes('宣言外')).join(' | ')}`);
  assert.ok(!logs.some((l) => l.includes('件が plan の file_changes に無い')), '宣言外変更 concern が注入された（返却 files が宣言として取り込まれていない）');
});

// ============================================================
// micro の LITE（clean）と realized 6 files（complex）
// ============================================================
async function runMicro(overrides = {}) {
  const workflowCalls = [];
  const { ctx, calls, logs } = makeDevFlowSandbox({
    overrides: { ...filesOf('micro'), ...overrides },
    workflow: async (name, opts) => { workflowCalls.push({ name, opts }); return { status: 'lgtm', iterations: 1, fixes_applied: 0 }; },
    extra: { args: argsOf('micro') },
  });
  const { result, error } = await runWorkflowCapture(src, ctx);
  assertNoCrash(error, 'micro');
  return { calls, logs, result, error, workflowCalls };
}

const implementerStubWith = (files) => ({ prompt }) => {
  const m = prompt.match(/task_id: (\S+?)（/);
  return { status: 'DONE', task_id: m ? m[1] : 'unknown', files, summary: 's', concerns: [] };
};

test('[implementer] micro（clean, docs-only）: LITE 経路 — pr-review-lite 1 回・workflow(pr-iterate) 0 回・merge_tier AUTO に AC 未検証開示', async () => {
  const DOCS = ['docs/x.md'];
  const { calls, result, error, workflowCalls } = await runMicro({
    'impl:serial:issue-1': implementerStubWith(DOCS),
    'pr-review-lite': { decision: 'approve', issues: [], summary: 'ok' },
    'ci-check-lite': { status: 'passed', passed: 1, failed: 0, pending: 0, skipped: 0, failed_checks: [], waited_seconds: 0, poll_attempts: 0 },
    'danger-grep': { risk: { ok: true, hits: [] }, files: DOCS, struct: null, diffhash: { hash: 'AAA', empty: false } },
  });
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  assert.deepEqual(byType(calls, IMPLEMENTER).map((c) => c.label), ['impl:serial:issue-1'], 'dev-implementer は Implement で 1 回のはず');
  assert.equal(byType(calls, 'dev-flow:evaluator').length, 0, 'clean micro は evaluator 0 回のはず');
  const reviewers = byType(calls, 'dev-flow:pr-reviewer');
  assert.equal(reviewers.length, 1, `pr-reviewer は lite 1 回のはず: ${reviewers.map((c) => c.label).join(', ')}`);
  assert.ok(/lite/i.test(reviewers[0].label), `pr-reviewer の label が lite 経路でない: ${reviewers[0].label}`);
  assert.equal(workflowCalls.length, 0, `clean micro で workflow('pr-iterate') が呼ばれた: ${workflowCalls.map((w) => w.name).join(', ')}`);
  assert.equal(result?.merge_tier, 'AUTO', `merge_tier は AUTO のはず: ${result?.merge_tier} (${JSON.stringify(result?.merge_tier_reasons)})`);
  assert.ok((result?.merge_tier_reasons ?? []).some((r) => r.includes('AC は未検証')), `AUTO の理由に AC 未検証開示が無い: ${JSON.stringify(result?.merge_tier_reasons)}`);
  assert.equal(result?.shape, 'micro', `clean micro の実効 shape が micro でない: ${result?.shape}`);
});

test('[implementer] AC 2 件 + realized 6 files（adoptReportedFiles 由来の宣言 6 件）: 実効 shape complex で evaluator が起動する（LITE を通らない）', async () => {
  const SIX = ['a', 'b', 'c', 'd', 'e', 'f'];
  const { calls, result, error } = await runMicro({
    'impl:serial:issue-1': implementerStubWith(SIX),
    'danger-grep': { risk: { ok: true, hits: [] }, files: SIX, struct: null, diffhash: { hash: 'AAA', empty: false } },
  });
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  assert.equal(result?.shape, 'complex', `realized 6 files で complex になっていない: ${JSON.stringify({ shape: result?.shape, reason: result?.shape_reason })}`);
  assert.ok(byType(calls, 'dev-flow:evaluator').length >= 1, 'complex は evaluator が起動するはず');
  assert.equal(byType(calls, 'dev-flow:pr-reviewer').filter((c) => /lite/i.test(c.label)).length, 0, 'complex で lite review が走った');
  assert.equal(goneCalls(calls).length, 0, 'complex でも planner 系 agent は起動しないはず');
});

// ============================================================
// AC-5: Evaluate 差し戻し（reimpl#i）— design / implementation どちらも dev-implementer へ
// ============================================================
const CRITICAL = (dimension) => [{ topic: 'arch-split', severity: 'critical', dimension, description: 'split the module boundary', suggestion: 'move x to y' }];
const EVAL_FAIL = (level) => ({ verdict: 'fail', total: 50, threshold: 80, feedback: CRITICAL(level), feedback_level: level, ac_results: [], security_clearance: [], concern_resolutions: [] });
const EVAL_PASS = { verdict: 'pass', total: 100, threshold: 80, feedback: [], feedback_level: 'implementation', ac_results: [], security_clearance: [], concern_resolutions: [], critical_resolutions: [{ id: 'EVAL-1-arch-split', resolved: true, evidence: 'boundary split and verified' }] };

for (const level of ['design', 'implementation']) {
  test(`[implementer] AC-5 complex / feedback_level=${level}: reimpl#1 が fix_feedback 付きで dev-implementer に渡り、planner 系 agent は起動しない`, async () => {
    const echoed = [];
    const stub = ({ prompt }) => {
      const m = prompt.match(/task_id: (\S+?)（/);
      echoed.push(m ? m[1] : null);
      return { status: 'DONE', task_id: m ? m[1] : 'unknown', files: ['src/x.ts'], summary: 's', concerns: [] };
    };
    const { calls, logs, error } = await runFlow('complex', {
      'impl:serial:issue-1': stub,
      'reimpl#1:serial:issue-1': stub,
      'eval#1': EVAL_FAIL(level),
      'eval#2': EVAL_PASS,
    });
    assert.equal(error, null, `run が throw した: ${error?.message}`);
    const reimpl = calls.filter((c) => c.label === 'reimpl#1:serial:issue-1');
    assert.equal(reimpl.length, 1, `reimpl#1:serial:issue-1 は 1 回のはず: ${calls.filter((c) => c.label.startsWith('reimpl')).map((c) => c.label).join(', ')}`);
    assert.equal(reimpl[0].agentType, IMPLEMENTER, `reimpl#1 の agentType が ${reimpl[0].agentType}`);
    assert.ok(reimpl[0].prompt.includes('fix_feedback'), 'reimpl#1 prompt に fix_feedback が無い');
    assert.ok(reimpl[0].prompt.includes('split the module boundary'), 'reimpl#1 prompt に evaluator feedback の本文が無い');
    assert.equal(calls.filter((c) => /^fix#\d+$/.test(c.label)).length, 0, 'implementer 向け fix#i が起動した');
    assert.equal(calls.filter((c) => /^replan#\d+$/.test(c.label)).length, 0, 'dev-planner 向け replan#i が起動した');
    assert.equal(goneCalls(calls).length, 0, `差し戻しで planner 系 agent が起動した: ${goneCalls(calls).map((c) => c.label).join(', ')}`);
    assert.deepEqual(echoed, ['issue-1', 'issue-1'], `Implement / reimpl の両 prompt が合成 task id を渡すはず: ${JSON.stringify(echoed)}`);
    assert.ok(logs.some((l) => l.includes('replan#1: 実装 agent 経路')), 'replan#1: 実装 agent 経路 の log が無い');
  });
}

test('[implementer] AC-5 AC 4 件 + realized 6 files（complex）: reimpl#1 が dev-implementer に渡る', async () => {
  const SIX = ['a', 'b', 'c', 'd', 'e', 'f'];
  const { calls, error } = await runFlow('standard', {
    'impl:serial:issue-1': implementerStubWith(SIX),
    'reimpl#1:serial:issue-1': implementerStubWith(SIX),
    'danger-grep': { risk: { ok: true, hits: [] }, files: SIX, struct: null, diffhash: { hash: 'AAA', empty: false } },
    'eval#1': EVAL_FAIL('design'),
    'eval#2': EVAL_PASS,
  });
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  const reimpl = calls.filter((c) => c.label === 'reimpl#1:serial:issue-1');
  assert.equal(reimpl.length, 1, `reimpl#1:serial:issue-1 は 1 回のはず: ${calls.filter((c) => c.label.startsWith('reimpl')).map((c) => c.label).join(', ')}`);
  assert.equal(reimpl[0].agentType, IMPLEMENTER);
  assert.equal(goneCalls(calls).length, 0, 'planner 系 agent が起動した');
});

// ============================================================
// AC-6: Validate green-fix（green-fix#i / green-fix#retry-i）を dev-implementer で spawn する
// ============================================================
function assertGreenFixPrompt(call, label) {
  assert.ok(call, `${label} の call が無い`);
  assert.equal(call.agentType, IMPLEMENTER, `${label} の agentType が ${call.agentType}（dev-implementer のはず）`);
  assert.ok(call.prompt.includes('テストの期待値・assert を弱めて green にすることは禁止'), `${label} prompt にテスト弱体化禁止の指示が無い`);
  assert.ok(call.prompt.includes('失敗内容: assert mismatch'), `${label} prompt に失敗内容が無い`);
  assert.ok(call.prompt.includes('一時/handoff ファイルの配置規約'), `${label} prompt に STAGING_CONVENTION が無い`);
  assert.ok(call.prompt.includes('git add / commit はするな'), `${label} prompt に commit 禁止が無い`);
}

test('[implementer] AC-6: test#1 red → green-fix#1 が dev-implementer で spawn され、prompt 文言は現行のまま', async () => {
  const { calls, error } = await runFlow('standard', {
    'test#1': { tests: 'failed', green: false, summary: 'assert mismatch' },
    'green-fix#1': { status: 'DONE', task_id: 'issue-1', files: ['src/x.ts'], summary: 'fixed', concerns: ['gf-concern'] },
  });
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  assertGreenFixPrompt(calls.find((c) => c.label === 'green-fix#1'), 'green-fix#1');
  assert.equal(goneCalls(calls).length, 0, 'green-fix で planner 系 agent が起動した');
  const ev = calls.find((c) => c.agentType === 'dev-flow:evaluator');
  assert.ok(ev && ev.prompt.includes('gf-concern'), 'green-fix の concerns が evaluator prompt に伝搬していない');
});

test('[implementer] AC-6: empty-diff retry 後の test#retry-1 red → green-fix#retry-1 が dev-implementer で spawn される', async () => {
  const { calls, error } = await runFlow('standard', {
    'diff-gate': { hash: 'H', empty: true },
    'diff-gate-retry': { hash: 'H2', empty: false },
    'test#retry-1': { tests: 'failed', green: false, summary: 'assert mismatch' },
  });
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  assert.equal(calls.find((c) => c.label === 'reimpl-empty-diff:serial:issue-1')?.agentType, IMPLEMENTER, 'empty-diff の差し戻しが dev-implementer に渡っていない');
  assertGreenFixPrompt(calls.find((c) => c.label === 'green-fix#retry-1'), 'green-fix#retry-1');
});

// ============================================================
// AC-7: PR phase の pr.head_sha → workflow('dev-flow:pr-iterate-run') の nested.head_sha 受け渡し
// （nested 起動は pr-meta probe を通らない本番経路。ここが切れると review#2 以降が黙って
//   全件 full review にフォールバックする — fail-open のため run 結果には出ない）
// ============================================================
async function runStandardWithWorkflowCapture(overrides = {}, setupOverrides = {}) {
  const workflowCalls = [];
  const args = argsOf('standard');
  Object.assign(args.setup, setupOverrides);
  const { ctx, calls, logs } = makeDevFlowSandbox({
    overrides: { ...overrides },
    workflow: async (name, opts) => { workflowCalls.push({ name, opts }); return { status: 'lgtm', iterations: 1, fixes_applied: 0 }; },
    extra: { args },
  });
  const { result, error } = await runWorkflowCapture(src, ctx);
  assertNoCrash(error, 'standard-workflow-capture');
  return { calls, logs, result, error, workflowCalls };
}

test('[implementer] AC-7: pr.head_sha が workflow(pr-iterate) の nested.head_sha に渡る', async () => {
  const HEAD_SHA = 'a'.repeat(40);
  const { workflowCalls, error } = await runStandardWithWorkflowCapture({
    'pr#1': { pr_url: 'http://x', pr_number: 1, committed: true, head_sha: HEAD_SHA },
  });
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  assert.equal(workflowCalls.length, 1, `workflow('dev-flow:pr-iterate-run') は 1 回のはず: ${workflowCalls.map((w) => w.name).join(', ')}`);
  assert.equal(workflowCalls[0].name, 'dev-flow:pr-iterate-run');
  assert.equal(workflowCalls[0].opts?.nested?.head_sha, HEAD_SHA, `nested.head_sha が pr.head_sha と一致しない: ${JSON.stringify(workflowCalls[0].opts?.nested)}`);
});

test('[implementer] args.setup.ci_wait_ceiling_seconds（prerun が base の CI 所要時間から決めた上限）が workflow(pr-iterate) の args にそのまま渡る（issue #1046）', async () => {
  const { workflowCalls, error } = await runStandardWithWorkflowCapture(
    { 'pr#1': { pr_url: 'http://x', pr_number: 1, committed: true, head_sha: 'a'.repeat(40) } },
    { ci_wait_ceiling_seconds: 600 },
  );
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  assert.equal(workflowCalls.length, 1);
  assert.equal(workflowCalls[0].opts?.ci_wait_ceiling_seconds, 600, `args: ${JSON.stringify(workflowCalls[0].opts)}`);
});

test('[implementer] AC-7: pr.head_sha が空文字のとき nested に head_sha キーが含まれない', async () => {
  const { workflowCalls, error } = await runStandardWithWorkflowCapture({
    'pr#1': { pr_url: 'http://x', pr_number: 1, committed: true, head_sha: '' },
  });
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  assert.equal(workflowCalls.length, 1, `workflow('dev-flow:pr-iterate-run') は 1 回のはず: ${workflowCalls.map((w) => w.name).join(', ')}`);
  assert.ok(!Object.prototype.hasOwnProperty.call(workflowCalls[0].opts?.nested ?? {}, 'head_sha'), `head_sha が空文字でも nested にキーが残っている: ${JSON.stringify(workflowCalls[0].opts?.nested)}`);
});

// ============================================================
// PR phase 失敗（issue #682 / #823）: pr#<issue> の中断応答（committed:false / pr_url 空 / pr_number 非正）
// は nested pr-iterate・Merge tier へ流さず、throw もせず、failed_step / failure_reason を返り値に載せた
// failure 終端（error_category: pr_phase_failed）で run を終える。journal は abort entry ではなく
// error_category=pr_phase_failed の failure entry（error_msg は pr-iterate の引数検証文でなく proxy の失敗文）。
// ============================================================
const PR_FAILURE_REASON = "fatal: Unable to create '.git/index.lock': Operation not permitted";
const PR_FAILED_RESPONSE = { pr_url: '', pr_number: 0, committed: false, failed_step: 'commit', failure_reason: PR_FAILURE_REASON };

test('[implementer] PR phase 失敗 (#682/#823): pr#1 が committed:false / pr_number:0 を返すと run は throw せず、返り値に failed_step / failure_reason が載り、closes-reinject と workflow(pr-iterate) は呼ばれない', async () => {
  const { calls, workflowCalls, error, result } = await runStandardWithWorkflowCapture({ 'pr#1': PR_FAILED_RESPONSE });
  assert.equal(error, null, `pr#1 の中断応答で run が throw した: ${error?.message}`);
  assert.equal(result.error_category, 'pr_phase_failed');
  assert.equal(result.failed_step, 'commit');
  assert.equal(result.failure_reason, PR_FAILURE_REASON);
  assert.equal(result.committed, false);
  assert.equal(workflowCalls.length, 0, `workflow('dev-flow:pr-iterate-run') が呼ばれた: ${workflowCalls.map((w) => `${w.name}(pr=${w.opts?.pr})`).join(', ')}`);
  const closes = calls.filter((c) => c.label.startsWith('closes-'));
  assert.equal(closes.length, 0, `closes 系が呼ばれた: ${closes.map((c) => c.label).join(', ')}`);
  assert.ok(calls.some((c) => c.label === 'pr#1'), 'pr#1 自体は呼ばれているはず');
});

test('[implementer] PR phase 失敗 (#682/#823): failure handoff の error_category が pr_phase_failed・error_phase が PR で、error_msg に PR phase 失敗文と proxy の生の値が載る', async () => {
  const { calls } = await runStandardWithWorkflowCapture({ 'pr#1': PR_FAILED_RESPONSE });
  assert.equal(calls.filter((c) => c.label === 'journal-log-abort').length, 0, 'abort entry が書かれた');
  const save = calls.find((c) => c.label === 'journal-log-failure');
  assert.ok(save, 'failure handoff の journal-log-failure が呼ばれていない');
  const payload = parseJournalHandoffPayload(save.prompt);
  assert.equal(payload.outcome, 'failure');
  assert.equal(payload.error_category, 'pr_phase_failed');
  assert.equal(payload.error_phase, 'PR');
  assert.ok(payload.error_msg.startsWith('dev-flow: PR phase 失敗（step: commit、reason: ' + PR_FAILURE_REASON + '）'), `error_msg に PR phase 失敗文が無い: ${payload.error_msg}`);
  assert.ok(payload.error_msg.includes('pr_url=""') && payload.error_msg.includes('pr_number=0') && payload.error_msg.includes('committed=false'), `error_msg に proxy の生の値が無い: ${payload.error_msg}`);
  assert.ok(!payload.error_msg.includes('正の整数が必要です'), `pr-iterate の引数検証文で落ちている（従来経路）: ${payload.error_msg}`);
});

// push 失敗（issue #819）: 返り値の push_log と handoff の error_msg に、pr-push が出力全文を残した
// `.devflow-tmp/push-output.log` のパスが載る（人間が transcript を掘らずに失敗した段を見られる）。
test('[implementer] PR push 失敗 (#819/#823): pr#1 が failed_step:push を返すと、返り値の push_log と failure handoff の error_msg に push log のパスが載り、pr#1 の prompt は同じパスを pr-push に渡す', async () => {
  const reason = '❌ Pre-push checks failed\nerror: failed to push some refs to \'github.com:o/r.git\'';
  const { calls, workflowCalls, error, result } = await runStandardWithWorkflowCapture({
    'pr#1': { pr_url: '', pr_number: 0, committed: true, failed_step: 'push', failure_reason: reason, push_header: 'pr-push: exit=1 log=/tmp/wt/.devflow-tmp/push-output.log' },
  });
  assert.equal(error, null, `push 失敗応答で run が throw した: ${error?.message}`);
  const pushLog = '/tmp/wt/.devflow-tmp/push-output.log';
  assert.equal(result.failed_step, 'push');
  assert.equal(result.push_log, pushLog);
  assert.ok(result.issue_comment.includes(pushLog), `issue_comment に push log のパスが無い:\n${result.issue_comment}`);
  assert.equal(workflowCalls.length, 0, 'push 失敗後に nested pr-iterate が呼ばれた');
  const pr = calls.find((c) => c.label === 'pr#1');
  assert.ok(pr.prompt.includes(`3. \`pr-push ${pushLog}\``), `pr#1 の prompt が同じ push log を pr-push に渡していない:\n${pr.prompt.slice(0, 400)}`);
  const save = calls.find((c) => c.label === 'journal-log-failure');
  const payload = parseJournalHandoffPayload(save.prompt);
  assert.ok(payload.error_msg.includes(`step: push、reason: ${reason}、push 出力全文: ${pushLog}）`), `failure handoff の error_msg に push log のパスが無い: ${payload.error_msg}`);
});

test('[implementer] PR fail-closed (#682): 正常系（committed:true, pr_number:1）は従来どおり nested pr-iterate → Merge tier まで進む', async () => {
  const { calls, workflowCalls, error } = await runStandardWithWorkflowCapture({
    'pr#1': { pr_url: 'http://x', pr_number: 1, committed: true, failed_step: '', failure_reason: '' },
  });
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  assert.ok(calls.some((c) => c.label === 'merge-tier-facts'), 'merge-tier-facts が呼ばれていない');
  assert.equal(workflowCalls.length, 1, `workflow('dev-flow:pr-iterate-run') は 1 回のはず: ${workflowCalls.map((w) => w.name).join(', ')}`);
  assert.equal(workflowCalls[0].name, 'dev-flow:pr-iterate-run');
  assert.equal(workflowCalls[0].opts?.pr, 1);
});
