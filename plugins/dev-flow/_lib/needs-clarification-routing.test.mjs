// needs_clarification ルーティングの振る舞いを VM sandbox で pin するテスト。
//
// Analyze は args.setup.analyze（prerun の決定論 analyze）から REQ を組み、3 条件ゲート
// （AC 空 / comment_conflicts 非空 / uncertain 非空）で needs_clarification に倒す（issue #690）。
// Implement の NEEDS_CONTEXT は sonnet 再分析を挟まず、そのまま needs_clarification で人間へ返す。
//
//   T1: implementer が常に NEEDS_CONTEXT → 再分析なし（analyze 系 label 0）・dev-implementer 1 回・needs_clarification（source=implement）
//   T2: AC 空 → dev-implementer 0 回・needs_clarification（source=analyze）・isolation-probe 0 回
//   T3: 正常 path（DONE）→ analyze 系 0 回・dev-implementer 1 回・evaluator 1 回・pr 1 回・PR 完走
//   T4: BLOCKED path 不変 → analyze 系 0 回・dev-implementer 3 回・pr 1 回
//   T5: NEEDS_CONTEXT は再試行しない（dev-implementer は 1 回で終端。回復 path は存在しない）
//   T6: needs_clarification の返り値形状（status / source / issue / worktree / branch / missing_context / journal_log_status / note）
//   T7: uncertain 非空 → needs_clarification + missing_context に uncertain 文言 + dev-implementer 0 回
//   T8: comment_overrides のみ（ゲート非該当）→ PR まで完走
//   T9: 全 needs_clarification 経路で prompt に 'worktree remove' を含まない（worktree は保持）
//   T10: analyze-clarify が解釈の候補を返す → clarify_questions に載る（missing_context は変わらない）
//   T11: analyze-clarify が失敗 → clarify_questions は空・missing_context はゲート理由そのまま。analyze 以外の source も空
//   T12: 候補が 2〜4 件・上限内でない質問は interpretations を空にして文章の質問に倒す
//   T13: CLARIFY schema と analyze-clarify の prompt が解釈の候補を求める

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash, analyzeArgs } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const src = readFileSync(join(repoRoot, '.claude/workflows/dev-flow.js'), 'utf8');

const IMPL = (status, extra = {}) => ({ status, task_id: 'issue-1', files: ['src/x.ts', 'src/y.ts', 'src/z.ts'], summary: '', concerns: [], blocking_reason: null, missing_context: null, ...extra });
const NEEDS_CONTEXT = IMPL('NEEDS_CONTEXT', { files: [], missing_context: 'API 仕様が不明' });
const BLOCKED = IMPL('BLOCKED', { files: [], blocking_reason: { block_class: 'approach_mismatch', detail: '設計が成立しない' } });

async function run({ impl, analyze = {}, overrides = {} } = {}) {
  const workflowCalledRef = { called: false };
  const implOverrides = impl
    ? { 'impl:serial:issue-1': impl, 'reimpl-blocked#1:serial:issue-1': impl, 'reimpl-blocked#2:serial:issue-1': impl }
    : {};
  const { ctx, calls, logs } = makeDevFlowSandbox({
    overrides: { ...implOverrides, ...overrides },
    workflow: async () => { workflowCalledRef.called = true; return { status: 'lgtm', iterations: 1, fixes_applied: 0 }; },
    extra: { args: analyzeArgs(1, { issue_type: 'feat', acceptance_criteria: ['a', 'b', 'c'], ...analyze }) },
  });
  const { result, error } = await runWorkflowCapture(src, ctx);
  assertNoCrash(error, 'needs-clarification');
  assert.equal(error, null, `run が throw してはならないが: ${error?.message}`);
  return { calls, logs, result, workflowCalled: workflowCalledRef.called };
}

const analyzeCalls = (calls) => calls.filter((c) => c.label.startsWith('analyze') || c.label.startsWith('contract-probe') || c.label === 'issue-meta');
const implementerCalls = (calls) => calls.filter((c) => c.agentType === 'dev-flow:dev-implementer');
const prCalls = (calls) => calls.filter((c) => c.label.startsWith('pr'));

// ============================================================
// T1: implementer が常に NEEDS_CONTEXT → 再分析なしで needs_clarification（source=implement）
// ============================================================
test('[needs-clarification] T1: 常に NEEDS_CONTEXT → 再分析なし・dev-implementer 1 回・needs_clarification（source=implement）で PR を起動しない', async () => {
  const { calls, result, workflowCalled } = await run({ impl: NEEDS_CONTEXT });
  assert.equal(analyzeCalls(calls).length, 0, `T1: analyze 系呼び出しは 0 回のはずだが ${analyzeCalls(calls).map((c) => c.label).join(', ')}`);
  assert.equal(implementerCalls(calls).length, 1, `T1: dev-implementer は 1 回（再試行なし）のはずだが ${implementerCalls(calls).length} 回`);
  assert.equal(prCalls(calls).length, 0, 'T1: pr 系は 0 回');
  assert.equal(workflowCalled, false, 'T1: workflow() は呼ばれない');
  assert.equal(result?.status, 'needs_clarification');
  assert.equal(result?.source, 'implement');
  assert.deepEqual([...result.missing_context], ['API 仕様が不明']);
  assert.equal(result?.worktree, '/tmp/wt');
});

// ============================================================
// T2: AC 空 → dev-implementer 0 回・needs_clarification（source=analyze）
// ============================================================
test('[needs-clarification] T2: AC 空 → dev-implementer 0 回・isolation-probe 0 回・needs_clarification（source=analyze）', async () => {
  const { calls, result } = await run({ analyze: { acceptance_criteria: [] } });
  assert.equal(implementerCalls(calls).length, 0);
  assert.equal(calls.filter((c) => c.label === 'isolation-probe').length, 0);
  assert.equal(prCalls(calls).length, 0);
  assert.equal(result?.status, 'needs_clarification');
  assert.equal(result?.source, 'analyze');
  assert.ok(Array.isArray(result?.missing_context) && result.missing_context.length > 0);
  assert.ok(result.missing_context.some((m) => m.includes('acceptance_criteria が空')), `missing_context に AC 空の理由が無い: ${JSON.stringify(result.missing_context)}`);
});

// ============================================================
// T3: 正常 path
// ============================================================
test('[needs-clarification] T3: 正常 path（DONE）→ analyze 系 0 回・dev-implementer 1 回・evaluator 1 回・pr 1 回・PR 完走', async () => {
  const { calls, result, workflowCalled } = await run({ impl: IMPL('DONE') });
  assert.equal(analyzeCalls(calls).length, 0);
  assert.equal(implementerCalls(calls).length, 1);
  assert.equal(calls.filter((c) => c.agentType === 'dev-flow:evaluator').length, 1);
  assert.equal(prCalls(calls).length, 1);
  assert.equal(workflowCalled, true);
  assert.notEqual(result?.status, 'needs_clarification');
  assert.equal(result?.pr_url, 'http://x');
});

// ============================================================
// T4: BLOCKED path 不変
// ============================================================
test('[needs-clarification] T4: BLOCKED path 不変 → analyze 系 0 回・dev-implementer 3 回（初回 + BLOCK_MAX 2）・pr 1 回', async () => {
  const { calls, result } = await run({ impl: BLOCKED });
  assert.equal(analyzeCalls(calls).length, 0);
  assert.equal(implementerCalls(calls).length, 3, `T4: dev-implementer は 3 回のはずだが ${implementerCalls(calls).map((c) => c.label).join(', ')}`);
  assert.equal(prCalls(calls).length, 1);
  assert.notEqual(result?.status, 'needs_clarification');
});

// ============================================================
// T5: NEEDS_CONTEXT は再試行しない
// ============================================================
test('[needs-clarification] T5: NEEDS_CONTEXT → 再試行（reimpl-context）は存在せず dev-implementer 1 回で終端する', async () => {
  const { calls } = await run({ impl: NEEDS_CONTEXT });
  assert.equal(calls.filter((c) => c.label.startsWith('reimpl-context')).length, 0, 'reimpl-context が spawn されている');
  // dev-runner はゲート通過後の観測型の分類 agent（実装前）だけで、NEEDS_CONTEXT 後の再分析は無い
  const implIdx = calls.findIndex((c) => c.agentType === 'dev-flow:dev-implementer');
  assert.equal(calls.slice(implIdx).filter((c) => c.agentType === 'dev-flow:dev-runner').length, 0, 'NEEDS_CONTEXT で dev-runner（sonnet 再分析）が spawn されている');
  assert.equal(implementerCalls(calls).length, 1);
});

// ============================================================
// T6: 返り値形状
// ============================================================
test('[needs-clarification] T6: needs_clarification の返り値形状（analyze / implement の両経路で同形）', async () => {
  for (const [name, opts] of [['analyze', { analyze: { acceptance_criteria: [] } }], ['implement', { impl: NEEDS_CONTEXT }]]) {
    const { result } = await run(opts);
    assert.equal(result.status, 'needs_clarification', name);
    assert.equal(result.source, name);
    assert.equal(result.issue, '1', name);
    assert.equal(result.worktree, '/tmp/wt', name);
    assert.equal(result.branch, 'feature/issue-1', name);
    assert.ok(Array.isArray(result.missing_context) && result.missing_context.length > 0, name);
    assert.equal(result.journal_log_status, 'logged', name);
    assert.ok(typeof result.note === 'string' && result.note.includes('worktree は保持済み'), name);
  }
});

// ============================================================
// T7: uncertain 非空
// ============================================================
test('[needs-clarification] T7: uncertain 非空 → needs_clarification + missing_context に uncertain 文言 + dev-implementer 0 回', async () => {
  const uncertain = ['breaking_keyword_scan: 非互換変更 / migration の要否を Jev が低確信（p=0.55）で判定できない — issue に明記せよ'];
  const { calls, result } = await run({ analyze: { analyze_path: 'jev', jev_reasons: ['breaking_keyword_scan true'], uncertain } });
  assert.equal(result?.status, 'needs_clarification');
  assert.equal(implementerCalls(calls).length, 0);
  assert.ok(result.missing_context.some((m) => m.includes(uncertain[0])), `missing_context に uncertain が無い: ${JSON.stringify(result.missing_context)}`);
});

// ============================================================
// T8: comment_overrides のみはゲート非該当
// ============================================================
test('[needs-clarification] T8: comment_overrides のみ（conflicts / uncertain 空）→ ゲート通過し PR まで完走', async () => {
  const { calls, result, workflowCalled } = await run({ impl: IMPL('DONE'), analyze: { analyze_path: 'jev', jev_reasons: ['comments present (1)'], comment_count: 1, comment_overrides: ['override: comment #1 by reporter（NONE, t）: 訂正'] } });
  assert.notEqual(result?.status, 'needs_clarification');
  assert.equal(implementerCalls(calls).length, 1);
  assert.equal(prCalls(calls).length, 1);
  assert.equal(workflowCalled, true);
});

// ============================================================
// T9: worktree は保持
// ============================================================
test("[needs-clarification] T9: 全 needs_clarification 経路で prompt に 'worktree remove' を含まない", async () => {
  for (const opts of [{ analyze: { acceptance_criteria: [] } }, { impl: NEEDS_CONTEXT }, { analyze: { comment_conflicts: ['c'] } }]) {
    const { calls, result } = await run(opts);
    assert.equal(result?.status, 'needs_clarification');
    assert.equal(calls.filter((c) => c.prompt.includes('worktree remove')).length, 0);
  }
});

// ============================================================
// T10〜T13: 解釈の候補（clarify_questions。issue #1362）
// ============================================================
const CLARIFY_LABEL = 'analyze-clarify#1';
const INTERP = (label, extra = {}) => ({ label, description: `${label} として読む`, preview: 'in  -> out\n[a] -> [b]', ...extra });
const plain = (v) => JSON.parse(JSON.stringify(v));

test('[needs-clarification] T10: analyze-clarify が解釈の候補を返す → clarify_questions に載り missing_context は変わらない', async () => {
  const questions = [
    { question: '上限は件数か文字数か', interpretations: [INTERP('件数'), INTERP('文字数')] },
    { question: '受け入れ基準をどの見出しで書くか', interpretations: [] },
  ];
  const { result } = await run({ analyze: { acceptance_criteria: [] }, overrides: { [CLARIFY_LABEL]: { missing_context: ['上限は件数か文字数か'], questions } } });
  assert.equal(result?.status, 'needs_clarification');
  assert.equal(result?.source, 'analyze');
  assert.deepEqual(plain(result.clarify_questions), questions);
  assert.equal(result.missing_context[0], '上限は件数か文字数か');
  assert.ok(result.missing_context.some((m) => m.includes('acceptance_criteria が空')), 'missing_context の末尾にゲート理由が残っていない');
});

test('[needs-clarification] T11: analyze-clarify が失敗 → clarify_questions は空・missing_context はゲート理由そのまま。analyze 以外の source も空配列', async () => {
  const ok = await run({ analyze: { acceptance_criteria: [] } });
  const failed = await run({ analyze: { acceptance_criteria: [] }, overrides: { [CLARIFY_LABEL]: null } });
  assert.equal(failed.result?.status, 'needs_clarification');
  assert.equal(failed.result?.source, 'analyze');
  assert.deepEqual(plain(failed.result.clarify_questions), []);
  // 成功時の missing_context は [質問文, ...ゲート理由]。失敗時はゲート理由だけが今までどおり返る
  assert.deepEqual(plain(failed.result.missing_context), plain(ok.result.missing_context).slice(1));
  assert.ok(failed.result.missing_context.length > 0);

  const implement = await run({ impl: NEEDS_CONTEXT });
  assert.equal(implement.result?.source, 'implement');
  assert.deepEqual(plain(implement.result.clarify_questions), []);
});

test('[needs-clarification] T12: 候補が 2〜4 件・上限内でない質問は interpretations を空にして文章の質問に倒す', async () => {
  const five = ['a', 'b', 'c', 'd', 'e'].map((l) => INTERP(l));
  const questions = [
    { question: '候補 1 件', interpretations: [INTERP('A')] },
    { question: '候補 5 件', interpretations: five },
    { question: 'label 超過', interpretations: [INTERP('A'), INTERP('あ'.repeat(21))] },
    { question: 'description 超過', interpretations: [INTERP('A'), INTERP('B', { description: 'd'.repeat(81) })] },
    { question: 'preview 13 行', interpretations: [INTERP('A'), INTERP('B', { preview: Array(13).fill('x').join('\n') })] },
    { question: '上限ちょうど', interpretations: [INTERP('あ'.repeat(20), { description: 'd'.repeat(80), preview: Array(12).fill('x').join('\n') }), INTERP('B'), INTERP('C'), INTERP('D')] },
  ];
  const { result } = await run({ analyze: { acceptance_criteria: [] }, overrides: { [CLARIFY_LABEL]: { missing_context: ['q'], questions } } });
  const got = plain(result.clarify_questions);
  assert.deepEqual(got.map((q) => q.question), questions.map((q) => q.question));
  assert.deepEqual(got.map((q) => q.interpretations.length), [0, 0, 0, 0, 0, 4]);
});

test('[needs-clarification] T13: CLARIFY schema に questions があり、analyze-clarify の prompt が解釈の候補を求める', async () => {
  const { calls } = await run({ analyze: { acceptance_criteria: [] } });
  const call = calls.find((c) => c.label === CLARIFY_LABEL);
  assert.ok(call, 'analyze-clarify が spawn されていない');
  const schema = plain(call.opts.schema);
  assert.deepEqual(schema.properties.missing_context, { type: 'array', items: { type: 'string' } });
  const q = schema.properties.questions.items;
  assert.deepEqual(q.required, ['question', 'interpretations']);
  assert.equal(q.properties.interpretations.maxItems, 4);
  const i = q.properties.interpretations.items;
  assert.deepEqual(i.required, ['label', 'description', 'preview']);
  assert.equal(i.properties.label.maxLength, 20);
  assert.equal(i.properties.description.maxLength, 80);
  for (const s of ['具体的な読み方の違い', '2〜4 件', '20 字以内', '80 字以内', '12 行以内の ASCII', 'interpretations を空配列']) {
    assert.ok(call.prompt.includes(s), `analyze-clarify の prompt に「${s}」が無い`);
  }
});
