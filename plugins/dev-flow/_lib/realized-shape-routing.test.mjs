// 実効 shape が realized diff の file 数だけで決まることを VM sandbox で pin する（issue #676）。
// Analyze 由来の事前見積もり（req.shape / req.estimated_change_file_count）は decision に効かず、
// EFFECTIVE_SHAPE は Diff triage で classifyShape(req, realizedCount, lineStats) が 1 回で決める。
//
// テストケース:
//   (A) realized 6 件（全件宣言）→ shape=complex + evaluator >= 1 回 + shape_reason が realized ベース
//   (B) realized 6 件 + eval#1 fail → reimpl → eval#2 pass（EVAL_PASSES=EVAL_MAX の full ループ）
//   (C) realized 1 件（宣言済み）→ shape=micro + evaluator 0 回 + lite route
//   (D) danger-grep の files が null（count 欠損）→ shape=complex + evaluator >= 1 回
//   (E) breaking_change=true + realized 1 件 → shape=complex + evaluator >= 1 回
//   (F) realized 4 docs/test-only + changed-files docs-only → shape=standard → merge_tier=REVIEW（AUTO 禁止）
//   (G) realized 1 docs + changed-files docs-only → shape=micro → merge_tier=AUTO
//   (H) req.shape='complex' + estimated 7 でも realized 1 件なら micro（LLM raise は無い）
//   (I) return object / journal telemetry に事前見積もり由来のキー（effective_shape / shape_refloored /
//       triviality / estimated_file_count）が無い
//   (J) 3 shape の spawn 構造（dev-implementer 回数 / evaluator 回数 / route）が shape 別経路の期待と一致する
//   (K) 静的 pin: dev-flow.js（inline 生成区間含む）に refloorShape / mergeShape / 事前見積もりキーが無い
//   (L) acme/webapp#101 相当 + diff-triage の lines → 重み・削除主体の補正で micro、shape_reason に補正前の shape（issue #740）
//   (M) 同じ files で lines 無し → file 数判定の complex（補正なし）
//   (N) counted file の 1 件に行数が無い → 補正なし
//   (O) 宣言外 file の行数は補正に使わない

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash, mergeTierFacts, COMPLEX_FILES, MICRO_FILES, analyzeArgs } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', '.claude/workflows/dev-flow.js'), 'utf8');

// REQ は args.setup.analyze（prerun の analyze 段）から組まれる。既定（prerunAnalyze）は AC 2 件 / type fix / breaking なし。
// REQ を変える test は run(overrides, analyzeOverrides) の第 2 引数で setup.analyze を差し替える。

// realized files と dev-implementer の申告 files を揃える override（宣言外 0 件で shape だけを動かす）
function filesOverrides(files, { declared = files, changed = files, lines = undefined } = {}) {
  const impl = { status: 'DONE', task_id: 'issue-1', files: [...declared], summary: 's', concerns: [] };
  return {
    'impl:serial:issue-1': impl,
    'reimpl#1:serial:issue-1': impl,
    'danger-grep': {
      risk: { ok: true, hits: [] }, files: files === null ? null : [...files], struct: null, diffhash: { hash: 'AAA', empty: false },
      ...(lines !== undefined ? { lines } : {}),
    },
    'merge-tier-facts': mergeTierFacts({ files: changed === null ? ['src/x.ts'] : [...changed] }),
    'ci-check-lite': { status: 'passed', passed: 1, failed: 0, pending: 0, skipped: 0, failed_checks: [], waited_seconds: 0, poll_attempts: 0 },
  };
}

async function run(overrides, analyze = {}) {
  const { ctx, calls } = makeDevFlowSandbox({ overrides, extra: { args: analyzeArgs(1, analyze) } });
  const { result, error } = await runWorkflowCapture(src, ctx);
  assertNoCrash(error, 'realized-shape');
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  return { calls, returned: result };
}

function journalTelemetry(calls) {
  const save = calls.find((c) => c.label === 'journal-log');
  assert.ok(save, 'journal-log が呼ばれていない');
  const begin = '<<<JOURNAL_HANDOFF_BODY_BEGIN>>>';
  const b = save.prompt.indexOf(begin);
  const e = save.prompt.indexOf('<<<JOURNAL_HANDOFF_BODY_END>>>');
  return JSON.parse(save.prompt.slice(b + begin.length, e).trim()).telemetry;
}

const evaluatorCalls = (calls) => calls.filter((c) => c.agentType === 'dev-flow:evaluator');

test('[realized-shape] (A) realized 6 files（全件宣言）→ shape=complex、evaluator >= 1 回、shape_reason が realized ベース', async () => {
  const six = COMPLEX_FILES.slice(0, 6);
  const { calls, returned } = await run({ ...filesOverrides(six) });
  assert.ok(evaluatorCalls(calls).length >= 1, `evaluator は >= 1 回のはずだが ${evaluatorCalls(calls).length} 回`);
  assert.equal(returned.shape, 'complex');
  assert.equal(returned.realized_file_count, 6);
  assert.match(returned.shape_reason, /realized 6 file\(s\), 2 AC, type=fix → shape=complex/);
});

test('[realized-shape] (B) realized 6 files + eval#1 fail → reimpl#1 → eval#2 pass（evaluator 2 回 = EVAL_PASSES が EVAL_MAX）', async () => {
  const six = COMPLEX_FILES.slice(0, 6);
  const ACR = [0, 1].map((i) => ({ ac_index: i, satisfied: true, verified_by: 'inspection', evidence: 'ok' }));
  const { calls, returned } = await run({
    ...filesOverrides(six),
    'eval#1': {
      verdict: 'fail', total: 50, threshold: 80,
      feedback: [{ topic: 'test-issue', severity: 'critical', dimension: 'implementation', description: 'fix needed', suggestion: 'fix it' }],
      feedback_level: 'implementation', ac_results: ACR, security_clearance: [],
    },
    'eval#2': {
      verdict: 'pass', total: 100, threshold: 80, feedback: [], feedback_level: 'implementation', ac_results: ACR, security_clearance: [],
      critical_resolutions: [{ id: 'EVAL-1-test-issue', resolved: true, evidence: 'fixed' }],
    },
  });
  assert.equal(evaluatorCalls(calls).length, 2, `evaluator は 2 回（fail → 差し戻し → pass）のはずだが ${evaluatorCalls(calls).length} 回`);
  assert.equal(calls.filter((c) => c.label === 'reimpl#1:serial:issue-1').length, 1);
  assert.equal(returned.shape, 'complex');
});

test('[realized-shape] (C) realized 1 file（宣言済み）→ shape=micro、evaluator 0 回、lite route', async () => {
  const { calls, returned } = await run({ ...filesOverrides(MICRO_FILES) });
  assert.equal(evaluatorCalls(calls).length, 0, `micro clean は evaluator 0 回のはずだが ${evaluatorCalls(calls).length} 回`);
  assert.equal(returned.shape, 'micro');
  assert.equal(returned.route, 'lite');
  assert.match(returned.shape_reason, /realized 1 file\(s\), 2 AC, type=fix → shape=micro/);
});

test('[realized-shape] (D) danger-grep の files が null（count 欠損）→ shape=complex、evaluator >= 1 回', async () => {
  const { calls, returned } = await run({ ...filesOverrides(null, { declared: [], changed: null }) });
  assert.ok(evaluatorCalls(calls).length >= 1, `count 欠損は complex 安全弁で evaluator >= 1 回のはずだが ${evaluatorCalls(calls).length} 回`);
  assert.equal(returned.shape, 'complex');
  assert.match(returned.shape_reason, /safe floor=complex/);
});

test('[realized-shape] (E) breaking_change=true + realized 1 file → shape=complex、evaluator >= 1 回', async () => {
  const { calls, returned } = await run(
    { ...filesOverrides(MICRO_FILES) },
    { breaking_change: true, breaking_keyword_scan: false, breaking_evidence: 'schema 変更' },
  );
  assert.ok(evaluatorCalls(calls).length >= 1, `breaking は complex floor で evaluator >= 1 回のはずだが ${evaluatorCalls(calls).length} 回`);
  assert.equal(returned.shape, 'complex');
  assert.match(returned.shape_reason, /breaking change detected/);
});

test('[realized-shape] (F) realized 4 docs/test-only + changed-files docs-only → shape=standard → merge_tier=REVIEW（AUTO 禁止）', async () => {
  const docsTestFiles = ['docs/a.md', 'docs/b.md', 'README.md', '_lib/foo.test.mjs'];
  const { returned } = await run({ ...filesOverrides(docsTestFiles) });
  assert.equal(returned.shape, 'standard');
  assert.equal(returned.merge_tier, 'REVIEW', `4 files は standard なので docs-only でも AUTO にしない（got ${returned.merge_tier}）`);
});

test('[realized-shape] (G) realized 1 docs + changed-files docs-only → shape=micro → merge_tier=AUTO', async () => {
  const { returned } = await run({ ...filesOverrides(['docs/a.md']) });
  assert.equal(returned.shape, 'micro');
  assert.equal(returned.merge_tier, 'AUTO', `genuine micro + docs-only は AUTO（got ${returned.merge_tier}: ${(returned.merge_tier_reasons ?? []).join(' / ')}）`);
});

test("[realized-shape] (H) req.shape='complex' + estimated_change_file_count=7 でも realized 1 file なら micro（LLM raise 廃止）", async () => {
  const { calls, returned } = await run(
    { ...filesOverrides(MICRO_FILES) },
    { shape: 'complex', estimated_change_file_count: 7 },
  );
  assert.equal(returned.shape, 'micro');
  assert.equal(evaluatorCalls(calls).length, 0);
});

test('[realized-shape] (I) return object / journal telemetry に事前見積もり由来のキーが無い', async () => {
  const { calls, returned } = await run({});
  const telemetry = journalTelemetry(calls);
  for (const k of ['effective_shape', 'shape_refloored', 'triviality', 'triviality_reason', 'estimated_file_count']) {
    assert.equal(Object.prototype.hasOwnProperty.call(returned, k), false, `returned.${k} は廃止`);
    assert.equal(Object.prototype.hasOwnProperty.call(telemetry, k), false, `telemetry.${k} は廃止`);
  }
  assert.equal(returned.shape, 'standard');
  assert.equal(telemetry.shape, 'standard');
});

test('[realized-shape] (J) micro / standard / complex の spawn 構造: implement 1/1/2・evaluator 0/1/2・route lite/full/full', async () => {
  const implCount = (calls) => calls.filter((c) => c.agentType === 'dev-flow:dev-implementer').length;
  const micro = await run({ ...filesOverrides(MICRO_FILES) });
  assert.equal(micro.returned.shape, 'micro');
  assert.deepEqual([implCount(micro.calls), evaluatorCalls(micro.calls).length, micro.returned.route], [1, 0, 'lite']);

  const standard = await run({});
  assert.equal(standard.returned.shape, 'standard');
  assert.deepEqual([implCount(standard.calls), evaluatorCalls(standard.calls).length, standard.returned.route], [1, 1, 'full']);

  const ACR = [0, 1].map((i) => ({ ac_index: i, satisfied: true, verified_by: 'inspection', evidence: 'ok' }));
  const complex = await run({
    ...filesOverrides(COMPLEX_FILES),
    'eval#1': {
      verdict: 'fail', total: 50, threshold: 80,
      feedback: [{ topic: 'X', severity: 'critical', dimension: 'implementation', description: 'fix needed', suggestion: 'fix it' }],
      feedback_level: 'implementation', ac_results: ACR, security_clearance: [],
    },
    'eval#2': {
      verdict: 'pass', total: 100, threshold: 80, feedback: [], feedback_level: 'implementation', ac_results: ACR, security_clearance: [],
      critical_resolutions: [{ id: 'EVAL-1-X', resolved: true, evidence: 'fixed' }],
    },
  });
  assert.equal(complex.returned.shape, 'complex');
  assert.deepEqual([implCount(complex.calls), evaluatorCalls(complex.calls).length, complex.returned.route], [2, 2, 'full']);
});

test('[realized-shape] (K) 静的 pin: dev-flow.js（inline 生成区間含む）に refloorShape / mergeShape / 事前見積もりキーが残っていない', () => {
  for (const token of ['refloorShape', 'mergeShape', 'SHAPE_RANK', 'estimated_change_file_count', 'shape_refloored', 'effective_shape', 'triviality_reason', 'estimated_file_count']) {
    assert.ok(!src.includes(token), `dev-flow.js に '${token}' が残っている`);
  }
  // 実効 shape は classifyShape(req, realizedCount, lineStats) の 1 呼び出しで決まる
  assert.match(src, /const triage = classifyShape\(req, realizedCount, lineStats\)\n\s*const EFFECTIVE_SHAPE = triage\.shape/);
  assert.equal((src.match(/classifyShape\(/g) ?? []).length - 1, 1, 'classifyShape の呼び出しは Diff triage の 1 箇所のみ（-1 は関数定義）');
});

// ---- 差分の中身による補正（issue #740）: diff-triage の lines が classifyShape に届く ----

// acme/webapp#101 相当: docs 2 + 本番 2（うち削除だけ 1）+ テスト 2、+24/-128
const WEBAPP_101_LINES = [
  { path: 'docs/DOMAIN_PATTERNS_GUIDE.md', added: 4, deleted: 14 },
  { path: 'docs/UBIQUITOUS_LANGUAGE.md', added: 4, deleted: 14 },
  { path: 'src/domain/planning-constraints.ts', added: 0, deleted: 36 },
  { path: 'src/domain/constraint-violation.service.ts', added: 2, deleted: 1 },
  { path: 'src/domain/planning-constraints.test.ts', added: 6, deleted: 40 },
  { path: 'src/solver/solve-month.objectives.test.ts', added: 8, deleted: 23 },
];
const WEBAPP_101_FILES = WEBAPP_101_LINES.map((l) => l.path);
const WEBAPP_101_REQ = { issue_type: 'chore', acceptance_criteria: ['a', 'b', 'c'] };

test('[realized-shape] (L) acme/webapp#101 相当（6 files, +24/-128, AC 3, chore）+ lines → micro、shape_reason に補正前 complex と根拠が載る', async () => {
  const { calls, returned } = await run({ ...filesOverrides(WEBAPP_101_FILES, { lines: WEBAPP_101_LINES }) }, WEBAPP_101_REQ);
  assert.ok(['micro', 'standard'].includes(returned.shape), `micro か standard のはずだが ${returned.shape}`);
  assert.equal(returned.shape, 'micro');
  assert.equal(returned.realized_file_count, 6);
  assert.match(returned.shape_reason, /realized 6 file\(s\) → weighted 3（docs 2 \/ 対応本番ありの test 1 を除外）, \+10\/-60 lines, 3 AC, type=chore/);
  assert.match(returned.shape_reason, /file 数判定 complex/);
  assert.match(returned.shape_reason, /1 段下げ → shape=micro$/);
  const telemetry = journalTelemetry(calls);
  assert.equal(telemetry.shape, 'micro');
});

test('[realized-shape] (M) 同じ 6 files で lines が無い（diff-triage が lines を返さない）→ file 数判定の complex（補正なし）', async () => {
  const { calls, returned } = await run({ ...filesOverrides(WEBAPP_101_FILES) }, WEBAPP_101_REQ);
  assert.equal(returned.shape, 'complex');
  assert.equal(returned.shape_reason, 'realized 6 file(s), 3 AC, type=chore → shape=complex');
  assert.equal(journalTelemetry(calls).shape, 'complex');
});

test('[realized-shape] (N) counted file の 1 件に行数が無い（binary 等）→ 補正なしの file 数判定', async () => {
  const lines = WEBAPP_101_LINES.filter((l) => l.path !== 'src/domain/planning-constraints.ts');
  const { returned } = await run({ ...filesOverrides(WEBAPP_101_FILES, { lines }) }, WEBAPP_101_REQ);
  assert.equal(returned.shape, 'complex');
  assert.equal(returned.shape_reason, 'realized 6 file(s), 3 AC, type=chore → shape=complex');
});

test('[realized-shape] (O) 宣言外 file の行数は補正に使わない（lineStats は realized count に数えた file だけ）', async () => {
  // 宣言外 3 件は大量追加だが realized count から除外されるので、宣言済み 3 件（削除主体）だけで判定する
  const declared = ['src/a.ts', 'src/b.ts', 'src/c.ts'];
  const undeclared = ['src/u1.ts', 'src/u2.ts', 'src/u3.ts'];
  const lines = [
    ...declared.map((path) => ({ path, added: 1, deleted: 30 })),
    ...undeclared.map((path) => ({ path, added: 500, deleted: 0 })),
  ];
  const { returned } = await run({ ...filesOverrides([...declared, ...undeclared], { declared, lines }) });
  assert.equal(returned.realized_file_count, 3);
  assert.match(returned.shape_reason, /weighted 3（docs 0 \/ 対応本番ありの test 0 を除外）, \+3\/-90 lines/);
  assert.equal(returned.shape, 'micro');
});
