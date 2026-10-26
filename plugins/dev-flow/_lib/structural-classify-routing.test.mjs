// Guard test: structural-classify (struct フィールド) の fail-open / i===1 gating / realizedCount
// exclusion / schema fail-open tolerance (issue #350, task F2; issue #544 S2 で統合呼び出し経由へ更新;
// issue #636 で source regex 走査から共有 vm-sandbox.mjs による VM 挙動検証 + 純関数検証へ移行)。
//
// Background:
//   dev-flow.js の Diff triage phase はもともと F1 の決定論 script
//   `_shared/scripts/structural-classify.sh` を専用 label 'structural-classify' の
//   dev-runner-haiku-ro exec-proxy 経由で個別に呼んでいたが、issue #544 (S1) で
//   danger-grep(risk) / realized-diff(files) / structural-classify(struct) / diff-hash-triage(hash)
//   の 4 呼び出しが統合スクリプト `_shared/scripts/diff-triage.sh` 経由の単一呼び出し
//   （label 'danger-grep' 据え置き）へ集約された。struct 分類データはその応答の `struct` フィールド
//   として得られ、`_lib/diff-triage.mjs` の `parseDiffTriageFields`（dev-flow.js へ inline 生成
//   済み）が per-field 独立に fail-open 検証する: struct が null / ok!==true / available 非boolean /
//   format_only・structural 非配列のいずれでも struct=null（呼び出し元は formatOnlySet を空にして
//   現行動作 = 全ファイル structural 扱い相当へフォールバックする）。
//
// routing / try-catch pin（label が dev-runner-haiku-ro へ routing される・try/catch で包まれる等）は
// _lib/diff-triage-routing.test.mjs の [A1]/[A5] で検証済みのため、ここでは重複検証しない。
// struct 専用の fail-open 純関数 parseDiffTriageFields(unified).struct の挙動は diff-triage.test.mjs が持つ。
// 本ファイルは (2) evaluator prompt への diff_classification 注入が i===1 に限定されること、(3) formatOnlySet に
// よる realizedCount 除外（実効 shape への影響）を VM 挙動として検証する。
//
// Run: npx vitest run _lib/structural-classify-routing.test.mjs
// Full CI: bash tests/run-node-tests.sh --strict

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash, analyzeArgs } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude', 'workflows', 'dev-flow.js');
const devFlowSrc = readFileSync(devFlowPath, 'utf8');

// ---- (1) struct フィールドの fail-open 純関数検証（parseDiffTriageFields(unified).struct）は
// diff-triage.test.mjs が表駆動で持つ ----

// ---- (2) diff_classification prompt injection is gated by i === 1 (VM 挙動) ----
//
// shape を complex にし（acceptance_criteria 7 件 → AC 数の floor で complex）、
// danger-grep が非空 struct.format_only を返す run で、eval#1 で verdict='fail'（critical feedback
// 1 件）→ eval#2 で AC 全件 satisfied の 'pass' を返させる。eval#1 prompt にのみ
// 'diff_classification' token が現れることを確認する。

test('[structural-classify-routing] diff_classification prompt injection is gated by i === 1 (present in eval#1, absent in eval#2)', async () => {
  const overrides = {
    'danger-grep': () => ({
      risk: { ok: true, hits: [] },
      files: ['src/x.ts', 'src/y.ts'],
      struct: { ok: true, available: true, format_only: ['src/x.ts'], structural: ['src/y.ts'] },
      diffhash: { hash: 'AAA', empty: false },
    }),
    'eval#1': () => ({
      verdict: 'fail', total: 50, threshold: 80,
      feedback: [{ severity: 'critical', dimension: 'x', text: 'bad', topic: 't1' }],
      feedback_level: 'implementation',
      ac_results: [{ ac_index: 0, satisfied: false, verified_by: 'inspection', evidence: 'no' }],
      security_clearance: [], concern_resolutions: [],
    }),
    'eval#2': () => ({
      verdict: 'pass', total: 100, threshold: 80, feedback: [], feedback_level: 'implementation',
      ac_results: Array.from({ length: 7 }, (_, idx) => ({ ac_index: idx, satisfied: true, verified_by: 'inspection', evidence: 'ok' })),
      security_clearance: [], concern_resolutions: [],
      critical_resolutions: [{ id: 'EVAL-1-t1', resolved: true, evidence: 'fixed' }],
    }),
  };
  const { ctx, calls } = makeDevFlowSandbox({ overrides, extra: { args: analyzeArgs(1, { acceptance_criteria: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], issue_type: 'feat' }) } });
  const { error } = await runWorkflowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'diff-classification-gating');
  assert.equal(error, null);

  const eval1 = calls.find((c) => c.label === 'eval#1');
  const eval2 = calls.find((c) => c.label === 'eval#2');
  assert.ok(eval1, "label 'eval#1' の呼び出しが見つからない");
  assert.ok(eval2, "label 'eval#2' の呼び出しが見つからない（evaluator が 2 iteration 走っていない）");
  assert.ok(eval1.prompt.includes('diff_classification'), 'eval#1（i===1）の prompt に diff_classification が注入されるべき');
  assert.ok(!eval2.prompt.includes('diff_classification'), 'eval#2（i===2）の prompt は stale な classification を再利用してはならない');
});

// ---- (3) realizedCount computation excludes format_only files via formatOnlySet (VM 挙動) ----
//
// danger-grep files が 4 件、struct.format_only が 3 件のとき realizedCount=1 → shape micro。
// format_only を空にすると realizedCount=4 → shape standard（classifyShape の閾値: count<=2 micro /
// count<=5 standard。_lib/triviality.mjs 準拠）。plan の file_changes に全 4 ファイルを宣言し、
// 宣言外除外の影響を排除する。

const ONE_AC_ARGS = { args: analyzeArgs(1, { acceptance_criteria: ['a'], issue_type: 'fix' }) };
function formatOnlyOverrides(formatOnly) {
  return {
    'impl:serial:issue-1': () => ({ status: 'DONE', task_id: 'issue-1', files: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'], summary: 's', concerns: [] }),
    'danger-grep': () => ({
      risk: { ok: true, hits: [] },
      files: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'],
      struct: { ok: true, available: true, format_only: formatOnly, structural: [] },
      diffhash: { hash: 'AAA', empty: false },
    }),
  };
}

test('[structural-classify-routing] formatOnlySet excludes format-only files from realizedCount: 3-of-4 excluded → realizedCount 1 → shape micro', async () => {
  const { ctx, calls } = makeDevFlowSandbox({ overrides: formatOnlyOverrides(['src/b.ts', 'src/c.ts', 'src/d.ts']), extra: ONE_AC_ARGS });
  const { result, error } = await runWorkflowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'formatOnlySet-3-of-4');
  assert.equal(error, null);
  assert.equal(result.shape, 'micro');
  assert.equal(result.realized_file_count, 1);
  const js = calls.find((c) => c.label === 'journal-log');
  assert.ok(js.prompt.includes('"shape":"micro"'));
});

test('[structural-classify-routing] formatOnlySet excludes format-only files from realizedCount: empty format_only counts all 4 files → shape standard', async () => {
  const { ctx, calls } = makeDevFlowSandbox({ overrides: formatOnlyOverrides([]), extra: ONE_AC_ARGS });
  const { result, error } = await runWorkflowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'formatOnlySet-empty');
  assert.equal(error, null);
  assert.equal(result.shape, 'standard');
  assert.equal(result.realized_file_count, 4);
  const js = calls.find((c) => c.label === 'journal-log');
  assert.ok(js.prompt.includes('"shape":"standard"'));
});
