// issue #640 / #676 / #690 / #789: 実効 shape が journal telemetry（journal-log prompt の handoff JSON）の
// shape に載り、判定根拠（shape_reason）・realized file 数は返り値に載ることを VM sandbox で固定する。
// shape は realized diff の file 数から classifyShape が決めた実効値。analyze 経路は args.setup.analyze
// （prerun の analyze 段）から決まり、Workflow 側（Setup 末尾の analyze ゲート）は spawn しない。
//
//   (a) contract 経路（既定）: analyze ゲートの spawn 0、telemetry.shape と返り値の shape が一致、
//       shape_reason / realized_file_count は返り値だけに載り telemetry には書かない
//   (b) jev 経路: analyze ゲートの spawn 0、log に path=jev と Jev に回した理由が出る
//   (d) realized count 欠損（danger-grep の files が null）: shape=complex、shape_reason は safe floor 文
//   (e) 宣言外パスの除外: realized_file_count は classifyShape 入力（除外後）で shape は standard
//   (f) ゲート後の needs_clarification: sonnet を 1 spawn、failure telemetry に shape を載せない
//   (g) telemetry は merge tier の入力にならない（merge_tier が contract / jev で同一）

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash, analyzeArgs } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowSrc = readFileSync(join(repoRoot, '.claude/workflows/dev-flow.js'), 'utf8');

function extractTelemetry(calls) {
  const journalSave = calls.find((c) => c.label.startsWith('journal-log'));
  assert.ok(journalSave != null, `label 'journal-log*' の call が見つからない (全 labels: ${calls.map((c) => c.label).join(', ')})`);
  const begin = '<<<JOURNAL_HANDOFF_BODY_BEGIN>>>';
  const beginIdx = journalSave.prompt.indexOf(begin);
  const endIdx = journalSave.prompt.indexOf('<<<JOURNAL_HANDOFF_BODY_END>>>');
  assert.ok(beginIdx >= 0 && endIdx > beginIdx, 'journal-log prompt に JOURNAL_HANDOFF_BODY delimiter が見つからない');
  const payload = JSON.parse(journalSave.prompt.slice(beginIdx + begin.length, endIdx).trim());
  assert.ok(payload.telemetry && typeof payload.telemetry === 'object', 'payload.telemetry が無い');
  return payload.telemetry;
}

async function runScenario({ overrides = {}, extra = {} } = {}) {
  const { ctx, calls, logs } = makeDevFlowSandbox({ overrides, extra });
  const { result, error } = await runWorkflowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'shape-calibration-telemetry');
  assert.equal(error, null, `run が throw で終端した: ${error?.message}`);
  return { calls, logs, result, telemetry: extractTelemetry(calls) };
}

// 判定根拠・analyze 経路は返り値 / log に載り、telemetry には書かない（残すキーに含まれない）
const NOT_IN_TELEMETRY = [
  'shape_reason', 'shape_uncorrected', 'realized_file_count', 'realized_file_count_raw', 'ac_count',
  'analyze_path', 'analyze_ineligible_reason', 'prerun_durations',
  'estimated_file_count', 'shape_refloored', 'effective_shape', 'triviality', 'triviality_reason',
];

test('[shape-calibration] (a) contract 経路（既定）: telemetry.shape は返り値の shape と一致し、判定根拠は返り値だけに載る', async () => {
  const { telemetry, calls, result } = await runScenario();
  assert.equal(calls.filter((c) => c.label.startsWith('analyze')).length, 0, '通常経路の analyze ゲートで agent が spawn されている');
  assert.equal(telemetry.shape, 'standard');
  assert.equal(result.shape, 'standard');
  assert.equal(result.shape_reason, 'realized 3 file(s), 2 AC, type=fix → shape=standard');
  assert.equal(result.realized_file_count, 3);
  for (const k of NOT_IN_TELEMETRY) {
    assert.equal(Object.prototype.hasOwnProperty.call(telemetry, k), false, `${k} は telemetry に載せない`);
  }
  assert.ok(!telemetry.phase_durations || !('analyze' in telemetry.phase_durations), `phase_durations に analyze キーが残っている: ${JSON.stringify(telemetry.phase_durations)}`);
});

test('[shape-calibration] (b) jev 経路: analyze ゲートの spawn 0、log に path=jev と Jev に回した理由が出る', async () => {
  const { calls, logs, telemetry } = await runScenario({
    extra: { args: analyzeArgs(1, { analyze_path: 'jev', jev_reasons: ['breaking_keyword_scan true', 'comments present (2)'], comment_count: 2, comment_overrides: ['override: comment #1 by reporter（NONE, t）: 訂正'], duration_seconds: 42 }) },
  });
  assert.equal(calls.filter((c) => c.label.startsWith('analyze')).length, 0, 'jev 経路でも analyze ゲートの spawn は 0');
  assert.ok(
    logs.some((l) => l.includes('path=jev / jev: breaking_keyword_scan true; comments present (2)') && l.includes('prerun analyze 42s')),
    `analyze の採用 log に jev 経路と理由が無い: ${JSON.stringify(logs.filter((l) => l.startsWith('analyze:')))}`,
  );
  assert.equal(Object.prototype.hasOwnProperty.call(telemetry, 'analyze_path'), false);
});

test('[shape-calibration] (d) realized count 欠損（files=null）: shape=complex、shape_reason は safe floor 文', async () => {
  const { telemetry, result } = await runScenario({
    overrides: {
      'danger-grep': { risk: { ok: true, hits: [] }, files: null, struct: null, diffhash: { hash: 'AAA', empty: false } },
    },
  });
  assert.equal(telemetry.shape, 'complex');
  assert.equal(result.shape, 'complex');
  assert.match(result.shape_reason, /safe floor=complex/);
});

test('[shape-calibration] (e) 宣言外パス除外: realized_file_count は classifyShape 入力（除外後）で shape は standard', async () => {
  const files = ['src/x.ts', 'src/y.ts', 'src/z.ts', 'src/u1.ts', 'src/u2.ts', 'src/u3.ts'];
  const { telemetry, result } = await runScenario({
    overrides: {
      'danger-grep': { risk: { ok: true, hits: [] }, files, struct: null, diffhash: { hash: 'AAA', empty: false } },
    },
  });
  // plan は STANDARD_FILES 3 件のみ宣言 → 3 件が宣言外で realized count から除外され、shape は standard（raw 6 なら complex）
  assert.equal(result.realized_file_count, 3);
  assert.equal(telemetry.shape, 'standard');
  assert.equal(result.shape_reason, 'realized 3 file(s), 2 AC, type=fix → shape=standard');
});

test('[shape-calibration] (f) ゲート後の needs_clarification: sonnet を 1 spawn し、failure telemetry に shape / analyze 経路を載せない', async () => {
  const { ctx, calls } = makeDevFlowSandbox({
    extra: { args: analyzeArgs(1, { analyze_path: 'jev', jev_reasons: ['comments present (1)'], comment_count: 1, comment_conflicts: ['conflict: comment #1 by alice（OWNER, t）: hmm'] }) },
  });
  const { result, error } = await runWorkflowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'shape-calibration-telemetry-f');
  assert.equal(error, null, `run が throw で終端した: ${error?.message}`);
  assert.equal(result?.status, 'needs_clarification');
  const telemetry = extractTelemetry(calls);
  for (const k of ['shape', 'analyze_path', 'analyze_ineligible_reason']) {
    assert.equal(Object.prototype.hasOwnProperty.call(telemetry, k), false, `failure telemetry に ${k} が載っている`);
  }
  assert.equal(calls.filter((c) => c.label === 'analyze-clarify#1' && c.agentType === 'dev-flow:dev-runner').length, 1, 'ゲート後の sonnet spawn は 1 回');
});

test('[shape-calibration] (g) telemetry は merge tier の入力にならない（contract / jev で tier 同一）', async () => {
  const a = await runScenario();
  const b = await runScenario({ extra: { args: analyzeArgs(1, { analyze_path: 'jev', jev_reasons: ['breaking_keyword_scan true'] }) } });
  assert.equal(a.telemetry.merge_tier, b.telemetry.merge_tier);
  assert.deepEqual(JSON.parse(JSON.stringify(a.result.merge_tier_reasons)), JSON.parse(JSON.stringify(b.result.merge_tier_reasons)));
});
