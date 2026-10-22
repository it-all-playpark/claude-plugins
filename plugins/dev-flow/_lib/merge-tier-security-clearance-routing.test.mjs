// Issue #299: Evaluate 時点で danger-grep clean だった PR が、pr-iterate 後の Merge tier
// phase の最終 danger-grep 再実行で新規に danger class を hit した場合、one-shot security
// clearance が呼ばれ、cleared:true + 非空 evidence のみ該当 SEC ledger item を checked にして
// HOLD を回避することを検証する workflow レベル統合テスト（PR #16 相当の再現）。
//
// _lib/danger-fail-closed-loop-routing.test.mjs の VM sandbox パターン（node:vm で
// .claude/workflows/dev-flow.js を読み込み、agent() を label/agentType で stub）を踏襲する。
// 本テストは Security floor（Evaluate 前, label:'danger-grep'）と Merge tier（label:
// 'merge-tier-facts' の risk サブ結果）に**別々**の danger-grep レスポンスを注入できるようにし、
// 'security-clearance-final' の呼び出し回数・prompt、'journal-log'/'post-summary' の
// prompt（merge_tier / summary body）を捕捉する。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { devFlowArgs, mergeTierFacts } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');
const src = readFileSync(devFlowPath, 'utf8');

// ---- VM sandbox helpers ----

/**
 * @param {object} analyzeReq - analyze フェーズの agent が返す req オブジェクト（SHAPE を決定する）
 * @param {object} dangerGrepPre - Security floor（Evaluate 前, label:'danger-grep'）の stub レスポンス
 * @param {object} dangerGrepFinal - Merge tier（label:'merge-tier-facts' の risk サブ結果）の stub レスポンス
 * @param {object} evaluatorResponse - Evaluate 本体（label:'eval#N'）の stub レスポンス（全 iteration 同一）
 * @param {object|null} clearanceResponse - 'security-clearance-final' の stub レスポンス（null 可）
 */
function makeSandbox(analyzeReq, dangerGrepPre, dangerGrepFinal, evaluatorResponse, clearanceResponse) {
  const evalCalls = [];
  const clearanceCalls = [];
  const journalPrompts = [];
  const summaryPrompts = [];

  const agentStub = async (prompt, opts) => {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';

    if (label === 'setup-base') {
      return { ok: true, default_branch: 'main', dev_exists: true, requested_exists: false, worktree_exists: false, upstream_remote: '', upstream_merge: '' };
    }
    if (label === 'worktree') {
      return { worktree: '/tmp/wt', branch: 'feature/issue-1' };
    }
    if (label.startsWith('analyze')) {
      return analyzeReq;
    }
    // Security floor の敵対的 security review の対象判定（issue #1063）: この test の関心外なので対象外を返す
    if (label === 'security-scope') return { ok: true, target: false, reasons: [] };
    // Security floor（Evaluate 前）の danger-grep（issue #544 統合呼び出し。dangerGrepPre を
    // risk フィールドへ包む。diffhash は Merge tier 側（'H_MERGE'）と意図的に異なる値にして
    // reuse を発火させない — シナリオが pre/final の乖離を前提にしているため）。
    if (label === 'danger-grep') {
      return { risk: dangerGrepPre, files: ['src/foo.ts'], struct: null, diffhash: { hash: 'H', empty: false } };
    }
    // Merge tier の最終 danger-grep は merge-tier-facts の risk サブ結果。diffhash は Security floor 側（'H'）と
    // 意図的に異なる値（'H_MERGE'）にして reuse を発火させない — 本 test はシナリオごとに Security floor と
    // Merge tier で異なる danger-grep 応答を注入するため、両段の diff-hash を同一にすると reuse が発火し
    // facts の risk が使われなくなってシナリオの前提（pre/final の乖離）が壊れる。
    if (label === 'merge-tier-facts') {
      return mergeTierFacts({ hash: 'H_MERGE', risk: dangerGrepFinal, files: ['src/foo.ts'] });
    }
    if (label.startsWith('test')) {
      return { tests: 'no_tests', green: true, summary: '' };
    }
    // one-shot security clearance（Merge tier）。agentType==='evaluator' だが label で区別する。
    if (agentType === 'dev-flow:evaluator' && label === 'security-clearance-final') {
      clearanceCalls.push({ prompt });
      return clearanceResponse;
    }
    // Evaluate 本体（label='eval#N'）
    if (agentType === 'dev-flow:evaluator') {
      evalCalls.push({ label, agentType });
      return evaluatorResponse;
    }
    if (agentType === 'dev-flow:dev-runner-haiku' && label.startsWith('redgreen')) {
      return { red: false, green: false, reason: 'stub' };
    }
    if (label.startsWith('pr')) {
      return { pr_url: 'http://x', pr_number: 16, committed: true };
    }
    if (label === 'post-summary' && agentType === 'dev-flow:dev-runner-haiku') {
      summaryPrompts.push(prompt);
      return { posted: true, method: 'gh pr comment', url: 'http://x' };
    }
    // journal-log: 実際の telemetry payload はここに載る（issue #807: pending/ へ直接書く 1 spawn）
    if (label === 'journal-log' && agentType === 'dev-flow:dev-runner-haiku') {
      journalPrompts.push(prompt);
      return { saved: true, logged: true };
    }
    if (agentType === 'dev-flow:dev-implementer') {
      return { status: 'DONE', task_id: 't', files: [], summary: '', concerns: [] };
    }
    if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) return { hash: 'H', empty: false };
    if (label === 'issue-meta') return { ok: true, number: 16, title: 'stub-issue-title' };
    return null;
  };

  const parallelStub = async (fns) => Promise.all((fns || []).map((f) => f()));
  const workflowStub = async () => ({ status: 'lgtm', iterations: 1, fixes_applied: 0 });

  const sandbox = {
    phase: () => {},
    log: () => {},
    agent: agentStub,
    parallel: parallelStub,
    pipeline: async (items, cb) => Promise.all((items || []).map(async (item, i) => { try { const r = await cb(item, i); return r === undefined ? null : r; } catch { return null; } })),
    workflow: workflowStub,
    args: devFlowArgs('16'),
    console,
    JSON,
    Math,
    String,
    Number,
    Boolean,
    Array,
    Object,
    Error,
    RegExp,
    Promise,
    Symbol,
    Map,
    Set,
    Date,
  };

  const ctx = vm.createContext(sandbox);
  return {
    ctx,
    counters: {
      evaluatorCalls: () => evalCalls.length,
      clearanceCalls: () => clearanceCalls.length,
      clearancePrompts: () => clearanceCalls.map((c) => c.prompt),
      journalPrompts: () => journalPrompts,
      summaryPrompts: () => summaryPrompts,
    },
  };
}

async function runDevFlowCapture(src, ctx) {
  const stripped = src
    .replace(/^export\s+const\s+/gm, 'const ')
    .replace(/^export\s+function\s+/gm, 'function ');
  const wrapped = `(async () => {\n${stripped}\n})();`;

  let caughtError = null;
  let resolvedResult = null;
  try {
    const resultPromise = vm.runInContext(wrapped, ctx, { filename: '.claude/workflows/dev-flow.js' });
    if (resultPromise && typeof resultPromise.then === 'function') {
      resolvedResult = await resultPromise.catch((e) => {
        caughtError = e;
        return null;
      });
    }
  } catch (e) {
    caughtError = e;
  }
  return { result: resolvedResult, error: caughtError };
}

function assertNoCrash(error) {
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }
}

// ============================================================
// 固定データ
// ============================================================

// complex に落ちる req（AC 満たし済みで danger 以外の HOLD 要因を混入させない）。
const ANALYZE_REQ = {
  summary: 's',
  acceptance_criteria: ['a'],
  issue_type: 'feat',
  scope: 'src',
  issue_number: 16,
  issue_title: 'stub-issue-title',
};

const DANGER_CLEAN = { ok: true, hits: [] };
const DANGER_HIT_CONFIG = { ok: true, hits: [{ class: 'config', file: 'x', pattern: 'p' }] };
const DANGER_FAIL_CLOSED = { ok: false, hits: [], error: 'stub fail-closed' };

const EVAL_RESPONSE_CLEAN = {
  verdict: 'pass',
  total: 100,
  threshold: 80,
  feedback: [],
  feedback_level: 'implementation',
  ac_results: [
    { ac_index: 0, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
  ],
  security_clearance: [],
};

// ============================================================
// シナリオ 1: PR #16 再現 — Evaluate 前 clean、Merge tier 最終 danger-grep で新規 hit。
// clearance が cleared:true + 非空 evidence を返す → checked → HOLD 回避。
// ============================================================
test('[merge-tier-sec-clearance] シナリオ1: PR#16 再現 — cleared:true+evidence で HOLD 回避し footer が一致する', async () => {
  const clearanceResponse = {
    security_clearance: [{ danger_class: 'config', cleared: true, evidence: 'diff 精査: secret 平文なし' }],
  };
  const { ctx, counters } = makeSandbox(ANALYZE_REQ, DANGER_CLEAN, DANGER_HIT_CONFIG, EVAL_RESPONSE_CLEAN, clearanceResponse);
  const { result, error } = await runDevFlowCapture(src, ctx);
  assertNoCrash(error);

  assert.equal(
    counters.clearanceCalls(),
    1,
    `新規 danger hit があるため security-clearance-final はちょうど 1 回呼ばれるべきだが ${counters.clearanceCalls()} 回だった`,
  );
  assert.notEqual(
    result?.merge_tier,
    'HOLD',
    `cleared:true + 非空 evidence の one-shot clearance で SEC-CONFIG が解消されるため merge tier は HOLD にならないはずだが '${result?.merge_tier}' だった（reasons: ${JSON.stringify(result?.merge_tier_reasons)}）`,
  );

  const journalPrompts = counters.journalPrompts();
  assert.equal(journalPrompts.length, 1, `journal-log は 1 回呼ばれるべきだが ${journalPrompts.length} 回だった`);
  assert.ok(
    !journalPrompts[0].includes('"merge_tier":"HOLD"'),
    `journal-log prompt の merge_tier は HOLD であってはならない。prompt:\n${journalPrompts[0]}`,
  );

  const summaryPrompts = counters.summaryPrompts();
  assert.equal(summaryPrompts.length, 1, `post-summary は 1 回呼ばれるべきだが ${summaryPrompts.length} 回だった`);
  assert.ok(
    !summaryPrompts[0].includes('❌ 未確認 | config'),
    `post-summary body に未確認 clearance テーブル行 '❌ 未確認 | config' が含まれてはならない。body:\n${summaryPrompts[0]}`,
  );
  // clearance 解消の返り値 routing 側の証拠: post-summary prompt の tier marker が REVIEW
  // （HOLD ではない）+ journal-log prompt の telemetry JSON の merge_tier が返り値と一致
  assert.ok(
    summaryPrompts[0].includes(`<!-- dev-flow:REVIEW head=${'a'.repeat(40)} -->`),
    `post-summary prompt に '<!-- dev-flow:REVIEW -->' marker が含まれるべき。body:\n${summaryPrompts[0]}`,
  );
  assert.ok(
    !summaryPrompts[0].includes('<!-- dev-flow:HOLD'),
    `post-summary prompt に '<!-- dev-flow:HOLD -->' marker が含まれてはならない。body:\n${summaryPrompts[0]}`,
  );
  assert.ok(
    journalPrompts[0].includes(`"merge_tier":"${result?.merge_tier}"`),
    `journal-log prompt の telemetry JSON の merge_tier は返り値 '${result?.merge_tier}' と一致するべき。prompt:\n${journalPrompts[0]}`,
  );
});

// ============================================================
// シナリオ 2: clearance が cleared:false を返す → SEC item unchecked のまま HOLD。
// ============================================================
test('[merge-tier-sec-clearance] シナリオ2: cleared:false — SEC-CONFIG unchecked のまま HOLD になる', async () => {
  const clearanceResponse = {
    security_clearance: [{ danger_class: 'config', cleared: false, evidence: '' }],
  };
  const { ctx, counters } = makeSandbox(ANALYZE_REQ, DANGER_CLEAN, DANGER_HIT_CONFIG, EVAL_RESPONSE_CLEAN, clearanceResponse);
  const { result, error } = await runDevFlowCapture(src, ctx);
  assertNoCrash(error);

  assert.equal(counters.clearanceCalls(), 1, `security-clearance-final は 1 回呼ばれるべきだが ${counters.clearanceCalls()} 回だった`);
  assert.equal(
    result?.merge_tier,
    'HOLD',
    `cleared:false の場合 SEC-CONFIG は unchecked のまま据え置かれ HOLD になるべきだが '${result?.merge_tier}' だった`,
  );
});

// ============================================================
// シナリオ 3: clearance が null を返す → SEC item unchecked のまま HOLD。workflow は完走する。
// security-clearance-final は model override を渡さない call site なので、null でも再試行しない（計 1 回）。
// ============================================================
test('[merge-tier-sec-clearance] シナリオ3: clearance null — HOLD かつ workflow は完走する', async () => {
  const { ctx, counters } = makeSandbox(ANALYZE_REQ, DANGER_CLEAN, DANGER_HIT_CONFIG, EVAL_RESPONSE_CLEAN, null);
  const { result, error } = await runDevFlowCapture(src, ctx);
  assertNoCrash(error);

  assert.equal(counters.clearanceCalls(), 1, `security-clearance-final は null でも再試行せず 1 回だけ呼ばれるべきだが ${counters.clearanceCalls()} 回だった`);
  assert.equal(
    result?.merge_tier,
    'HOLD',
    `clearance が null の場合 SEC-CONFIG は unchecked のまま据え置かれ HOLD になるべきだが '${result?.merge_tier}' だった`,
  );
  assert.ok(result != null, 'clearance が null でも workflow は throw せず完走し、return object を返すべき');
});

// ============================================================
// シナリオ 4: merge-tier-facts の risk が fail-closed → one-shot clearance を試みず、
// 全 SEC seed unchecked で HOLD を強制する（security floor 不変）。
// ============================================================
test('[merge-tier-sec-clearance] シナリオ4: merge-tier-facts risk fail-closed — clearance は呼ばれず HOLD 強制', async () => {
  const clearanceResponse = {
    security_clearance: [{ danger_class: 'config', cleared: true, evidence: 'should not be called' }],
  };
  const { ctx, counters } = makeSandbox(ANALYZE_REQ, DANGER_CLEAN, DANGER_FAIL_CLOSED, EVAL_RESPONSE_CLEAN, clearanceResponse);
  const { result, error } = await runDevFlowCapture(src, ctx);
  assertNoCrash(error);

  assert.equal(
    counters.clearanceCalls(),
    0,
    `merge-tier-facts の risk が fail-closed の場合 security-clearance-final は呼ばれないはずだが ${counters.clearanceCalls()} 回呼ばれた`,
  );
  assert.equal(
    result?.merge_tier,
    'HOLD',
    `merge-tier-facts risk fail-closed の場合、merge tier は HOLD を強制すべきだが '${result?.merge_tier}' だった`,
  );
});

// ============================================================
// シナリオ 5: 両方 clean（回帰） — clearance は呼ばれず、danger 起因の HOLD にならない。
// ============================================================
test('[merge-tier-sec-clearance] シナリオ5 regression: Evaluate 前・Merge tier 最終ともに clean — clearance 呼び出しなし、HOLD にならない', async () => {
  const { ctx, counters } = makeSandbox(ANALYZE_REQ, DANGER_CLEAN, DANGER_CLEAN, EVAL_RESPONSE_CLEAN, null);
  const { result, error } = await runDevFlowCapture(src, ctx);
  assertNoCrash(error);

  assert.equal(
    counters.clearanceCalls(),
    0,
    `danger-grep が Evaluate 前・Merge tier 最終ともに clean の場合、SEC item は newly-unchecked にならず clearance は呼ばれないはずだが ${counters.clearanceCalls()} 回呼ばれた`,
  );
  assert.notEqual(
    result?.merge_tier,
    'HOLD',
    `danger が両方 clean の場合、merge tier は danger 起因で HOLD になるべきでないが '${result?.merge_tier}' だった（reasons: ${JSON.stringify(result?.merge_tier_reasons)}）`,
  );
});
