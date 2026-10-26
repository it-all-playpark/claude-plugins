// _lib/tracked-agent-so-retry.test.mjs
// dev-flow.js / pr-iterate.js の workflow ローカル関数 trackedAgent に対する、
// StructuredOutput 契約違反限定の同一 prompt 1 回リトライ（issue #527 B-2）を検証する。
//
// issue #641: Setup phase の 4 spawn（setup-base 含む）が撤去されたため、opt-in call site の
// 駆動を残存する 'danger-grep'（Diff triage、retryOnContractViolation:true・try/catch で
// throw を吸収し run は継続する）に置換した。未 opt-in の対照は 'diff-gate'（need() 包み、throw は
// そのまま伝播する。issue #690 で Analyze の spawn が 0 になり analyze#1 は存在しない）で取る。
//
// テストケース:
//   (a) リトライ成功 — danger-grep 1 回目 StructuredOutput 契約違反 throw、2 回目正常応答 → 後続へ進む
//   (a2) 未 opt-in call site（diff-gate）は StructuredOutput 契約違反 throw でも呼び出し1回で即伝播する
//   (b) 契約違反以外は即 throw（リトライしない）が、danger-grep 自体は try/catch で吸収し run は継続する
//   (c) リトライ 1 回で打ち切り（2 回目も契約違反なら rethrow、danger-grep の try/catch で吸収され run は継続）
//   (d) null 応答はリトライ対象外（契約外形状として risk fail-closed へ倒れる）
//   (e) pr-iterate.js — 未 opt-in call site（fix#1）の契約違反 throw は即伝播

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, makePrIterateSandbox, runWorkflowCapture } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude', 'workflows', 'dev-flow.js');
const prIteratePath = join(repoRoot, '.claude', 'workflows', 'pr-iterate.js');
const devFlowSrc = readFileSync(devFlowPath, 'utf8');
const prIterateSrc = readFileSync(prIteratePath, 'utf8');

const CONTRACT_VIOLATION_MSG =
  "agent({schema}): subagent completed without calling StructuredOutput (after in-conversation nudge)";

const DANGER_GREP_OK = { risk: { ok: true, hits: [] }, files: ['src/x.ts'], struct: null, diffhash: { hash: 'AAA', empty: false } };

// ── (a) リトライ成功 ─────────────────────────────────────────────────────

test('[tracked-agent-so-retry] (a) danger-grep が 1 回目 StructuredOutput 契約違反 → 2 回目成功で後続へ進む', async () => {
  let callCount = 0;
  const { ctx, calls, logs } = makeDevFlowSandbox({
    overrides: {
      'danger-grep': () => {
        callCount += 1;
        if (callCount === 1) throw new Error(CONTRACT_VIOLATION_MSG);
        return DANGER_GREP_OK;
      },
    },
  });
  const { error } = await runWorkflowCapture(devFlowSrc, ctx);

  assert.equal(error, null, `run は完走するはずだが throw した: ${error?.message}`);
  const dangerCalls = calls.filter((c) => c.label === 'danger-grep');
  assert.equal(dangerCalls.length, 2, 'danger-grep の呼び出し回数がちょうど 2 件ではない');
  assert.ok(
    logs.some((l) => l.includes('契約違反で失敗 — 同一 prompt で 1 回だけリトライ')),
    'リトライ log が出ていない',
  );
});

// ── (a2) 未 opt-in call site は StructuredOutput 契約違反でもリトライしない ──
// diff-gate は opts.retryOnContractViolation を opt-in していない need() 包みの call site。
// 同じ契約違反メッセージでも即座に throw を伝播すること（issue #533 review）を検証する。

test('[tracked-agent-so-retry] (a2) 未 opt-in call site（diff-gate）は StructuredOutput 契約違反 throw でも呼び出し1回で即伝播する', async () => {
  const { ctx, calls } = makeDevFlowSandbox({
    overrides: {
      'diff-gate': () => { throw new Error(CONTRACT_VIOLATION_MSG); },
    },
  });
  const { error } = await runWorkflowCapture(devFlowSrc, ctx);

  assert.ok(error, '未 opt-in call site の契約違反 throw で run がエラーなく完走した');
  assert.match(String(error?.message ?? error), /without calling StructuredOutput/);

  const gateCalls = calls.filter((c) => c.label === 'diff-gate');
  assert.equal(
    gateCalls.length,
    1,
    `diff-gate の呼び出し回数が 1 件ではない（未 opt-in call site なのにリトライされた）`,
  );
});

// ── (b) 契約違反以外はリトライしない。danger-grep の try/catch で吸収され run は継続する ──

test('[tracked-agent-so-retry] (b) danger-grep が契約違反以外の throw → リトライせず即伝播するが try/catch で吸収され run は継続', async () => {
  const { ctx, calls, logs } = makeDevFlowSandbox({
    overrides: {
      'danger-grep': () => { throw new Error('guard rejected this command'); },
    },
  });
  const { error } = await runWorkflowCapture(devFlowSrc, ctx);

  assert.equal(error, null, 'danger-grep の throw は execDiffTriagePhase の try/catch で吸収され run は継続するはず');
  const dangerCalls = calls.filter((c) => c.label === 'danger-grep');
  assert.equal(dangerCalls.length, 1, 'danger-grep の呼び出し回数が 1 件ではない（リトライされてしまった）');
  assert.ok(
    logs.some((l) => l.includes('diff-triage 呼び出しが例外')),
    'diff-triage 呼び出しが例外 log が出ていない',
  );
});

// ── (c) リトライ 1 回で打ち切り ──────────────────────────────────────────

test('[tracked-agent-so-retry] (c) danger-grep が 2 回とも契約違反 → 2 回で打ち切り、try/catch で吸収され run は継続', async () => {
  const { ctx, calls, logs } = makeDevFlowSandbox({
    overrides: {
      'danger-grep': () => { throw new Error(CONTRACT_VIOLATION_MSG); },
    },
  });
  const { error } = await runWorkflowCapture(devFlowSrc, ctx);

  assert.equal(error, null, '2 回連続契約違反でも danger-grep の try/catch で吸収され run は継続するはず');
  const dangerCalls = calls.filter((c) => c.label === 'danger-grep');
  assert.equal(dangerCalls.length, 2, 'danger-grep の呼び出し回数がちょうど 2 件ではない（無限リトライ or 打ち切り漏れ）');
  assert.ok(logs.some((l) => l.includes('呼び出しが例外')), '呼び出しが例外 log が出ていない');
});

// ── (d) null 応答はリトライ対象外（契約外形状として risk fail-closed へ倒れる） ──

test('[tracked-agent-so-retry] (d) danger-grep が null → リトライせず契約外形状として risk fail-closed へ倒れる', async () => {
  const { ctx, calls, logs } = makeDevFlowSandbox({
    overrides: { 'danger-grep': null },
  });
  const { error } = await runWorkflowCapture(devFlowSrc, ctx);

  assert.equal(error, null, 'danger-grep null 応答で run が throw してはならない');
  const dangerCalls = calls.filter((c) => c.label === 'danger-grep');
  assert.equal(dangerCalls.length, 1, 'danger-grep の呼び出し回数が 1 件ではない（null 応答なのにリトライされた）');
  assert.ok(logs.some((l) => l.includes('契約外形状')), '契約外形状 log が出ていない');
});

// ── (e) pr-iterate.js の trackedAgent も同じ契約（未 opt-in call site は契約違反でも同一 label で再呼び出ししない）──
// pr-iterate.js には現在 retryOnContractViolation を opt-in した call site が無く、全 call site が
// 例外を catch するため伝播では観測できない。fix#1（未 opt-in）を契約違反で throw させ、trackedAgent が
// 同一 label で再呼び出しせず（fix#1 は 1 回）、契約違反リトライの log も出ないことで観測する
// （issue #636 でソース pin から置換。opt-in call site が増えたら (a) と同型のテストを足す）。

test('[tracked-agent-so-retry] (e) pr-iterate.js: 未 opt-in の fix#1 が契約違反で throw → 同一 label の再呼び出し無し・リトライ log 無し', async () => {
  const { ctx, calls, logs } = makePrIterateSandbox({
    overrides: {
      'review#1': { decision: 'request_changes', issues: [{ severity: 'major', topic: 't', file: 'a.js', line: 1, description: 'd', suggestion: null }], summary: 'ng' },
      'fix#1': () => { throw new Error(CONTRACT_VIOLATION_MSG); },
    },
  });
  const { error } = await runWorkflowCapture(prIterateSrc, ctx, '.claude/workflows/pr-iterate.js');
  assert.equal(error, null, `fix#1 の throw は callFixAgent が吸収するはずだが run が throw した: ${error?.message}`);
  assert.equal(calls.filter((c) => c.label === 'fix#1').length, 1, 'fix#1 が同一 label で再呼び出しされた（未 opt-in call site でリトライが発火している）');
  assert.equal(calls.filter((c) => c.label === 'fix#1-retry').length, 1, 'fix-null-retry（別 label）は 1 回走るはず');
  assert.ok(!logs.some((l) => l.includes('契約違反で失敗 — 同一 prompt で 1 回だけリトライ')), '未 opt-in call site なのに契約違反リトライの log が出ている');
});
