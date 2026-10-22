// merge-tier-diffhash-reuse-routing: VM sandbox routing test for dev-flow の Security floor ↔
// Merge tier 間の diff-hash 一致による danger-grep-final / changed-files 再利用（issue #377）。
//
// Security floor phase（execSecurityFloorPhase）は danger-grep 成功時（risk.ok===true）かつ
// files（旧 realized-diff）成功時のみ、統合呼び出し（issue #544, label 'danger-grep' 据え置き）の
// diffhash フィールドから tree OID を捕捉し state.secDiffHash に保持する。Merge tier phase 冒頭は
// label 'merge-tier-facts' の統合 exec-proxy（issue #637）を 1 回呼び、state.secDiffHash != null の
// ときのみその diffhash サブ結果と比較し、両ハッシュが文字列完全一致する場合のみ facts の risk / changed
// を使わず Security floor の risk/realized を再利用する（reuseSecFloor）。不一致・取得失敗・Security
// floor 側 fail-closed のときは facts の risk / changed で再判定し、security floor の fail-closed 性は
// 一切変えない。再利用の発火は「facts.risk に hit を仕込み、Security floor が clean なら REVIEW（再利用）/
// facts の risk が使われれば HOLD」で観測する。
//
// ハーネスは _lib/ci-checks-routing.test.mjs の createResponder パターン（overrides の
// hasOwnProperty 優先チェック）+ _lib/test-helpers/vm-sandbox.mjs の makeRecordingSandbox、
// 実行部分は _lib/final-reconcile-routing.test.mjs のローカル runDevFlowCapture
// （{result, error} を返す vm 実行）を踏襲する。
//
// テストケース:
//   (1) 再利用発火: danger-grep clean + realized valid + secfloor hash===facts hash →
//       facts.risk に hit があっても Security floor の clean risk が再利用され REVIEW、
//       'merge-tier-facts' は 1 回だけ呼ばれ、workflow は完走する
//   (2) 不一致: secfloor='A' / facts='B' → facts.risk（hit）で再判定され HOLD
//   (3) facts 側 diffhash 取得失敗（ok:false）→ 再判定（facts.risk の hit で HOLD）
//   (4) Security floor fail-closed: danger-grep が {ok:false,hits:[]} → secDiffHash null →
//       facts の diffhash は参照されず（reuse ログ無し）、facts.risk fail-closed で merge_tier が HOLD
//       （fail-closed 維持）
//   (5) 再利用発火 + Security floor hit: danger-grep が ok:true で危険クラス hit + 同一 hash →
//       再利用で facts.risk（clean）は使われず hit が残り merge_tier HOLD（unresolvedDanger 維持）

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { makeRecordingSandbox, devFlowArgs, mergeTierFacts } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');
const devFlowSrc = readFileSync(devFlowPath, 'utf8');

// ============================================================
// runDevFlowCapture: strip + wrap + vm 実行し {result, error} を返す
// （final-reconcile-routing.test.mjs / merge-tier-security-clearance-routing.test.mjs と同型）
// ============================================================
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

function assertNoCrash(error, name) {
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`[${name}] dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }
}

// standard に落ちる req（count=3 ≤ 5, ac.length=2 ≤ 6, type=fix → floor='standard'）
const STANDARD_REQ = {
  summary: 's',
  acceptance_criteria: ['a', 'b'],
  issue_type: 'fix',
  scope: 'src',
  issue_number: 377,
  issue_title: 'stub-issue-title',
};

// facts.risk に仕込む hit（再利用が発火しなければ SEC-CONFIG が unchecked に残り HOLD になる）
const FACTS_RISK_HIT = { ok: true, hits: [{ class: 'config', file: 'src/x.ts', pattern: 'p' }] };

// ============================================================
// responder factory: ci-checks-routing.test.mjs / final-reconcile-routing.test.mjs の
// createResponder パターンを踏襲。overrides は label 単位（関数なら
// ({prompt, agentType, label}) => ... として呼ばれる。throw も伝播）。
// ============================================================
function createResponder(overrides = {}) {
  return function ({ label, agentType, prompt }) {
    if (Object.prototype.hasOwnProperty.call(overrides, label)) {
      const v = overrides[label];
      if (typeof v === 'function') return v({ prompt, agentType, label });
      return v;
    }
    if (label === 'setup-base') return { ok: true, default_branch: 'main', dev_exists: true, requested_exists: false, worktree_exists: false, upstream_remote: '', upstream_merge: '' };
    if (label === 'worktree') return { worktree: '/tmp/wt', branch: 'feature/issue-377' };
    if (label.startsWith('analyze')) return STANDARD_REQ;
    // Security floor の敵対的 security review の対象判定（issue #1063）: この test の関心外なので対象外を返す
    if (label === 'security-scope') return { ok: true, target: false, reasons: [] };
    // label 'danger-grep'（Security floor。issue #544 統合呼び出し）は
    // {risk, files, struct, diffhash} を 1 応答で返す。diffhash は既定で secfloor/merge 同一
    // ハッシュ（再利用が発火する）。不一致にしたいテストは override で個別に上書きする。
    if (label === 'danger-grep') {
      return { risk: { ok: true, hits: [] }, files: ['src/x.ts'], struct: null, diffhash: { hash: 'SAMEHASH', empty: false } };
    }
    if (agentType === 'dev-flow:evaluator') {
      return {
        verdict: 'pass', total: 100, threshold: 80, feedback: [],
        feedback_level: 'implementation',
        ac_results: [
          { ac_index: 0, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
          { ac_index: 1, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
        ],
        security_clearance: [], concern_resolutions: [],
      };
    }
    if (label.startsWith('pr')) return { pr_url: 'http://x', pr_number: 1, committed: true };
    // merge-tier-facts（Merge tier 統合呼び出し）は既定で secfloor 側と同一ハッシュ（再利用が発火する）
    // かつ risk に hit を仕込む — 再利用が発火すれば hit は使われず REVIEW、facts の risk が使われれば HOLD
    // になるため、再利用の発火有無を merge_tier で観測できる。不一致にしたいテストは override で上書きする。
    if (label === 'merge-tier-facts') return mergeTierFacts({ hash: 'SAMEHASH', risk: FACTS_RISK_HIT, files: ['src/x.ts'] });
    if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) return { hash: 'H', empty: false };
    if (label === 'post-summary') return { posted: true, method: 'gh pr comment', url: 'http://x' };
    if (label === 'journal-log') return { logged: true, summary: 'ok' };
    if (agentType === 'dev-flow:dev-implementer') return { status: 'DONE', task_id: 't', files: ['src/x.ts'], summary: 's', concerns: [] };
    if (label.startsWith('test')) return { tests: 'passed', green: true, summary: '' };
    if (label === 'issue-meta') return { ok: true, number: 377, title: 'stub-issue-title' };
    return null;
  };
}

function makeSandbox({ overrides = {} } = {}) {
  // fixes_applied=0 固定: Final reconcile は zero-overhead で skip され、Merge tier phase の
  // diff-hash reuse ロジックの検証に専念できる（final-reconcile-routing.test.mjs のケース(a)と同型）。
  return makeRecordingSandbox(createResponder(overrides), {
    workflow: async () => ({ status: 'lgtm', iterations: 2, fixes_applied: 0 }),
    args: devFlowArgs('377'),
  });
}

// ============================================================
// (1) 再利用発火: 完全一致 → facts.risk（hit）は使われず Security floor の clean risk を再利用
// ============================================================

test('[diffhash-reuse] (1) 完全一致 → facts.risk の hit は使われず（再利用）REVIEW、merge-tier-facts は 1 回、workflow 完走', async () => {
  const { ctx, calls, logs } = makeSandbox();
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, '1');
  assert.ok(result !== null, '(1) workflow は return object を返すべきだが null だった');

  assert.equal(calls.filter((c) => c.label === 'merge-tier-facts').length, 1, "(1) 'merge-tier-facts' はちょうど 1 回呼ばれるはず（再利用可否の判定に必須）");
  assert.ok(logs.some((l) => l.includes('diff-hash 一致') && l.includes('再利用')), '(1) 再利用発火の log が無い');
  assert.equal(result?.merge_tier, 'REVIEW', `(1) danger clean（再利用）+ 収束済みなら merge_tier は REVIEW のはずだが ${JSON.stringify(result?.merge_tier)}（reasons: ${JSON.stringify(result?.merge_tier_reasons)}）`);
  assert.equal(JSON.stringify(result?.danger_hits), JSON.stringify([]), '(1) 再利用時は facts.risk の hit が danger_hits に現れてはならない');
});

// ============================================================
// (2) 不一致 → facts の risk で再判定
// ============================================================

test("[diffhash-reuse] (2) hash 不一致 → facts.risk（hit）で再判定され HOLD", async () => {
  const { ctx, logs } = makeSandbox({
    overrides: {
      'danger-grep': { risk: { ok: true, hits: [] }, files: ['src/x.ts'], struct: null, diffhash: { hash: 'A', empty: false } },
      'merge-tier-facts': mergeTierFacts({ hash: 'B', risk: FACTS_RISK_HIT, files: ['src/x.ts'] }),
    },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, '2');
  assert.ok(result !== null, '(2) workflow は return object を返すべきだが null だった');

  assert.ok(!logs.some((l) => l.includes('diff-hash 一致')), '(2) hash 不一致時に再利用 log が出てはならない');
  assert.equal(result?.merge_tier, 'HOLD', `(2) hash 不一致時は facts.risk の hit で HOLD のはずだが ${JSON.stringify(result?.merge_tier)}`);
  assert.equal(JSON.stringify(result?.danger_hits), JSON.stringify(['config']), '(2) facts.risk の hit が danger_hits に現れるはず');
});

// ============================================================
// (3) facts 側 diffhash 取得失敗 → 再判定
// ============================================================

test("[diffhash-reuse] (3) facts の diffhash が ok:false（取得失敗） → facts.risk で再判定される", async () => {
  const { ctx, logs } = makeSandbox({
    overrides: { 'merge-tier-facts': mergeTierFacts({ hash: null, risk: FACTS_RISK_HIT, files: ['src/x.ts'] }) },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, '3');
  assert.ok(result !== null, '(3) workflow は return object を返すべきだが null だった');

  assert.ok(logs.some((l) => l.includes('diff-hash-merge の取得に失敗')), '(3) diffhash 取得失敗の fail-safe log が無い');
  assert.equal(result?.merge_tier, 'HOLD', `(3) diffhash 取得失敗時は facts.risk の hit で HOLD のはずだが ${JSON.stringify(result?.merge_tier)}`);
  assert.equal(JSON.stringify(result?.danger_hits), JSON.stringify(['config']), '(3) facts.risk の hit が danger_hits に現れるはず（再利用 skip）');
});

// ============================================================
// (4) Security floor fail-closed → facts の diffhash 不参照 + facts.risk fail-closed + HOLD
// ============================================================

test("[diffhash-reuse] (4) Security floor fail-closed → 再利用 log 無し・facts.risk fail-closed で merge_tier HOLD（fail-closed 維持）", async () => {
  const { ctx, calls, logs } = makeSandbox({
    overrides: {
      'danger-grep': { risk: { ok: false, hits: [], error: 'sec floor stub fail' }, files: null, struct: null, diffhash: null },
      'merge-tier-facts': mergeTierFacts({ risk: { ok: false, hits: [], error: 'merge tier stub fail' }, files: ['src/x.ts'] }),
    },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, '4');
  assert.ok(result !== null, '(4) workflow は return object を返すべきだが null だった');

  assert.ok(!logs.some((l) => l.includes('diff-hash 一致')), "(4) Security floor fail-closed（secDiffHash null）のとき再利用 log が出てはならない");
  assert.ok(calls.some((c) => c.label === 'merge-tier-facts'), "(4) 'merge-tier-facts' は必ず呼ばれるはず（security floor の fail-closed 性は緩めない）");
  assert.equal(result?.merge_tier, 'HOLD', `(4) danger-grep が両段で fail-closed のため merge_tier は HOLD のはずだが ${JSON.stringify(result?.merge_tier)}`);
  assert.equal(result?.danger_fail_closed, true, '(4) danger_fail_closed:true のはず');
});

// ============================================================
// (5) 再利用発火 + Security floor hit → HOLD（unresolvedDanger 維持）
// ============================================================

test("[diffhash-reuse] (5) hash 一致 + Security floor で danger hit → 再利用で facts.risk（clean）は使われず hit が残り merge_tier HOLD", async () => {
  const { ctx, calls } = makeSandbox({
    overrides: {
      'danger-grep': {
        risk: { ok: true, hits: [{ class: 'config', file: 'src/x.ts', pattern: 'p' }] },
        files: ['src/x.ts'],
        struct: null,
        diffhash: { hash: 'SAMEHASH', empty: false },
      },
      'merge-tier-facts': mergeTierFacts({ hash: 'SAMEHASH', risk: { ok: true, hits: [] }, files: ['src/x.ts'] }),
    },
  });
  const { result, error } = await runDevFlowCapture(devFlowSrc, ctx);
  assertNoCrash(error, '5');
  assert.ok(result !== null, '(5) workflow は return object を返すべきだが null だった');

  assert.ok(calls.some((c) => c.label === 'merge-tier-facts'), "(5) 'merge-tier-facts' は呼ばれるはず");
  assert.equal(result?.merge_tier, 'HOLD', `(5) 再利用した risk に未解消の danger hit が残るため merge_tier は HOLD のはずだが ${JSON.stringify(result?.merge_tier)}`);
  assert.equal(JSON.stringify(result?.danger_hits), JSON.stringify(['config']), '(5) 再利用時は Security floor の hit が danger_hits に残るはず（facts の clean で上書きしない）');
});
