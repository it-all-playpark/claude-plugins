// _lib/analyze-comments-routing.test.mjs
// Guard test: issue comments の要件反映（issue #573 → #690 で prerun の Jev 判定へ移動）の配線 pin。
//
// comment の override / conflict 判定は prerun（prerun-analyze.sh: comment ごとに Jev choice、権限は
// gh JSON から決定論判定）で行われ、Workflow には args.setup.analyze.comment_overrides /
// comment_conflicts として届く。Workflow 側の責務は「conflicts 非空なら needs_clarification で終端し、
// overrides は採用として log に残す」だけ（LLM に黙って片方を採らせない）。
//
//   静的 pin:
//     analyze-issue.sh の gh --json フィールド列に comments / author が含まれる（contract 出力の comments[] /
//     issue_author の給電元）
//     prerun-analyze.sh は権限判定（issue 報告者本人 or OWNER/MEMBER/COLLABORATOR）を持ち、Jev を --redact 付きで呼ぶ
//   T1: comment_conflicts 非空 → needs_clarification かつ implementer 0 件・isolation-probe 0 件
//   T2: comment_overrides のみ非空（comment_conflicts 空） → implementer 呼び出し >= 1、採用 log あり
//   T3: 両方空 → implementer 呼び出し >= 1
//   T4: comment_conflicts の文言が needs_clarification の missing_context に verbatim で残る
//
// Run: npx vitest run _lib/analyze-comments-routing.test.mjs
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash, analyzeArgs } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const src = readFileSync(join(repoRoot, '.claude', 'workflows', 'dev-flow.js'), 'utf8');

async function run(analyze) {
  const { ctx, calls, logs } = makeDevFlowSandbox({ extra: { args: analyzeArgs(1, analyze) } });
  const { result, error } = await runWorkflowCapture(src, ctx);
  assertNoCrash(error, 'analyze-comments-routing');
  assert.equal(error, null, `run が throw してはならないが: ${error?.message}`);
  return { calls, logs, result };
}
const implCount = (calls) => calls.filter((c) => c.agentType === 'dev-flow:dev-implementer').length;

// ============================================================
// 静的 pin
// ============================================================

test('[analyze-comments-routing] analyze-issue.sh の gh --json フィールド列に comments / author が含まれる', () => {
  const scriptSrc = readFileSync(join(repoRoot, 'dev-flow', 'scripts', 'analyze-issue.sh'), 'utf8');
  const fieldsLine = scriptSrc.split('\n').find((l) => l.startsWith('GH_JSON_FIELDS='));
  assert.ok(fieldsLine, 'analyze-issue.sh に GH_JSON_FIELDS= 定義が無い');
  assert.ok(/state,comments/.test(fieldsLine), `gh --json フィールド列に comments が含まれていない: ${fieldsLine}`);
  assert.ok(/author/.test(fieldsLine), `gh --json フィールド列に author が含まれていない: ${fieldsLine}`);
  // contract 出力に comments[] / issue_author / title_breaking_marker が載る（prerun-analyze.sh の入力）
  for (const key of ['comments: $comments', 'issue_author: $issue_author', 'title_breaking_marker: $title_breaking_marker']) {
    assert.ok(scriptSrc.includes(key), `analyze-issue.sh の contract 出力に ${key} が無い`);
  }
});

test('[analyze-comments-routing] prerun-analyze.sh は権限判定（報告者本人 / OWNER・MEMBER・COLLABORATOR）を持ち、Jev を --redact 付きで呼ぶ', () => {
  const scriptSrc = readFileSync(join(repoRoot, 'dev-flow', 'scripts', 'prerun-analyze.sh'), 'utf8');
  assert.ok(scriptSrc.includes('"$C_AUTHOR" == "$ISSUE_AUTHOR"'), '報告者本人の判定が無い');
  assert.ok(/"OWNER" \|\| .*"MEMBER" \|\| .*"COLLABORATOR"/.test(scriptSrc), 'OWNER/MEMBER/COLLABORATOR の判定が無い');
  assert.ok(scriptSrc.includes('"$JEV_CLASSIFY" --redact --questions'), 'Jev 呼び出しに --redact が無い');
  assert.ok(scriptSrc.includes('${DEVFLOW_JEV_CLASSIFY:-jev-classify}'), 'Jev クライアントを PATH 上の jev-classify から引いていない');
  assert.ok(scriptSrc.includes('DEVFLOW_JEV_DISABLE'), 'DEVFLOW_JEV_DISABLE の opt-out が無い');
});

// ============================================================
// routing
// ============================================================

test('[analyze-comments-routing] T1: comment_conflicts 非空 → needs_clarification かつ implementer 0 件・isolation-probe 0 件', async () => {
  const { calls, result } = await run({ analyze_path: 'jev', jev_reasons: ['comments present (1)'], comment_count: 1, comment_conflicts: ['conflict: comment #1 by alice（OWNER, 2026-01-01T00:00:00Z）: 30 箇所ではなく 20 箇所'] });
  assert.equal(result?.status, 'needs_clarification');
  assert.equal(result?.source, 'analyze');
  assert.equal(implCount(calls), 0, 'comment_conflicts 非空で implementer が呼ばれた');
  assert.equal(calls.filter((c) => c.label === 'isolation-probe').length, 0);
});

test('[analyze-comments-routing] T2: comment_overrides のみ非空 → implementer 呼び出し >= 1（run は進む）、採用 log あり', async () => {
  const { calls, result, logs } = await run({ analyze_path: 'jev', jev_reasons: ['comments present (1)'], comment_count: 1, comment_overrides: ['override: comment #1 by reporter（NONE, 2026-01-01T00:00:00Z）: 訂正: 30 箇所'] });
  assert.notEqual(result?.status, 'needs_clarification');
  assert.ok(implCount(calls) >= 1, 'comment_overrides のみで implementer が呼ばれていない');
  assert.ok(logs.some((l) => l.includes('comment による body 訂正を採用（1 件）') && l.includes('訂正: 30 箇所')), `採用 log が無い: ${logs.filter((l) => l.includes('analyze')).join(' | ')}`);
});

test('[analyze-comments-routing] T3: 両方空 → implementer 呼び出し >= 1', async () => {
  const { calls, result } = await run({});
  assert.notEqual(result?.status, 'needs_clarification');
  assert.ok(implCount(calls) >= 1);
});

test('[analyze-comments-routing] T4: comment_conflicts の文言（権限なし override / 低確信）が missing_context に verbatim で残る', async () => {
  const conflicts = [
    'override（権限なし: author_association=NONE）: comment #1 by mallory（NONE, t）: X ではなく Y',
    'low-confidence（unrelated p=0.6）: comment #2 by alice（OWNER, t）: たぶん',
  ];
  const { result } = await run({ analyze_path: 'jev', jev_reasons: ['comments present (2)'], comment_count: 2, comment_conflicts: conflicts });
  assert.equal(result?.status, 'needs_clarification');
  for (const c of conflicts) {
    assert.ok(result.missing_context.some((m) => m.includes(c)), `missing_context に conflict が verbatim で無い: ${c}`);
  }
});
