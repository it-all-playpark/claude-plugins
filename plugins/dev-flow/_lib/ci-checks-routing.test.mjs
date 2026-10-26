// issue #297 (F4): CI checks 委譲 auto-close の dev-flow.js 配線回帰テスト。
//
// F3 で追加した Merge tier phase の ci-checks exec-proxy（classifyMergeTier() の後・
// buildDevflowSummaryBody() の前）を VM sandbox で固定する:
//   (a) green auto-close: build 系 check 全 pass なら turbopack-sandbox ENV item が
//       checkItem され、post-summary の環境ノートに「CI で確認済み（check名列挙）」が現れる。
//   (b) fail-open: ci-checks 呼び出し失敗（ok:false）でも workflow は完走し、
//       ENV item は据え置き（「CI で確認済み」を含まない）。
//   (c) allowlist 外は未呼出: npm-cache-eperm 等 build 検証系でない ENV key は
//       ci-checks を呼ばず、ENV item 自体は生成される（vacuous pass 防止の positive assert）。
//   (d) merge tier 不変: auto-close の有無で merge tier 判定・収束判定（軸A 不変）が変わらない。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeRecordingSandbox, runDevFlowInSandbox, mergeTierFacts } from './test-helpers/vm-sandbox.mjs';
import { gateLane, isConvergedUnderPolicy, DEFAULT_GATE_POLICY } from './gate-policy.mjs';
import { makeLedger, appendItem, checkItem } from './goal-ledger.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');
const devFlowSrc = readFileSync(devFlowPath, 'utf8');

// ============================================================
// responder factory: concerns と ci-checks 応答だけをシナリオ別に差し替える
// （ハーネスは _lib/eval-concern-resolutions-routing.test.mjs の createResponder を土台にする）
// ============================================================

function createResponder({ concerns, ciChecksResponse }) {
  return function ({ label, agentType }) {
    // Setup(worktree)
    // Setup(setup-base): base 解決 + 既存 worktree 起点検証 統合 probe（issue #550 案1）
    if (label === 'setup-base') {
      return { ok: true, default_branch: 'main', dev_exists: true, requested_exists: false, worktree_exists: false, upstream_remote: '', upstream_merge: '' };
    }
    if (label === 'worktree') {
      return { worktree: '/tmp/wt', branch: 'feature/issue-297' };
    }
    // Analyze: 必ず standard（micro だと Evaluate が skip され Merge tier phase の前提が崩れる）
    if (label.startsWith('analyze')) {
      return {
        summary: 's',
        acceptance_criteria: ['a'],
        issue_type: 'fix',
        scope: 'src',
        issue_number: 1,
        issue_title: 'stub-issue-title',
      };
    }
    // Diff triage / danger-grep 系
    if (label === 'danger-grep') {
      return { ok: true, hits: [] };
    }
    // Validate: test runner（test#0 等）
    if (label.startsWith('test')) {
      return { tests: 'passed', green: true, summary: '' };
    }
    // Evaluate: evaluator。item_updates フィールドは契約に存在しないため使わない
    // （AC の checkItem は ac_results の satisfied:true 経由のみ）
    if (agentType === 'dev-flow:evaluator') {
      return {
        verdict: 'pass',
        total: 100,
        threshold: 80,
        feedback: [],
        feedback_level: 'implementation',
        ac_results: [
          { ac_index: 0, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
        ],
        security_clearance: [],
        concern_resolutions: [],
      };
    }
    // realized-diff / declared-path-check → files: [] で undeclared を発生させない
    if (label === 'realized-diff' || label === 'declared-path-check') {
      return { files: [] };
    }
    // merge-tier-facts（dev-runner-haiku-ro）: checks サブ結果はシナリオ別の応答（{ok,checks} 形 → サブ結果へ写す）
    if (label === 'merge-tier-facts') {
      return mergeTierFacts({ files: [], checks: ciChecksResponse?.ok === true ? ciChecksResponse.checks : null });
    }
    // PR 系
    if (label.startsWith('pr')) {
      return { pr_url: 'http://x', pr_number: 1, committed: true };
    }
    // diff-gate / diff-hash 系
    if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) {
      return { hash: 'H', empty: false };
    }
    // post-summary（dev-runner-haiku）
    if (label === 'post-summary') {
      return { posted: true, method: 'gh pr comment', url: 'http://x' };
    }
    // implementer（本経路の main call。concerns はシナリオ別）
    if (agentType === 'dev-flow:dev-implementer') {
      return {
        status: 'DONE_WITH_CONCERNS',
        task_id: 't1',
        files: ['src/x.ts'],
        summary: 's',
        concerns,
      };
    }
    // issue-meta（issue #451）: analyze provenance 突合 probe
    if (label === 'issue-meta') return { ok: true, number: 1, title: 'stub-issue-title' };
    // デフォルト（worktree-deps 等）
    return null;
  };
}

async function runScenario({ concerns, ciChecksResponse }) {
  const { ctx, calls, logs } = makeRecordingSandbox(createResponder({ concerns, ciChecksResponse }));
  const err = await runDevFlowInSandbox(devFlowSrc, ctx);
  return { calls, logs, err };
}

function assertNoCrash(err, scenarioName) {
  if (err && (err.name === 'ReferenceError' || err.name === 'SyntaxError')) {
    assert.fail(`[${scenarioName}] dev-flow.js が sandbox でクラッシュ: ${err.name}: ${err.message}`);
  }
}

// post-summary の環境ノートはグループ件数のみを表示する。env_key ごとの auto-close / 据え置きは
// ci-checks の log 行（`ci-checks: <env_key> 系 check 全 pass（…）` / `ci-checks: <env_key> → <reason> … 据え置き`）
// で観測する。
function ciCheckLogs(logs) {
  return logs.filter((l) => l.includes('ci-checks:'));
}
function envNoteCountLine(calls, n) {
  const post = calls.find((c) => c.label === 'post-summary');
  assert.ok(post != null, `label === 'post-summary' の call が見つからない (全 labels: ${calls.map((c) => c.label).join(', ')})`);
  assert.ok(
    post.prompt.includes(`🏗 環境ノート ${n} 件`),
    `post-summary に「🏗 環境ノート ${n} 件」が無い（ENV item 生成の positive 確認 失敗。vacuous pass の疑い）:\n${post.prompt.slice(0, 2000)}`,
  );
  return post;
}

const TURBOPACK_CONCERNS = [
  'sandbox 内で next build が TurbopackInternalError で失敗した',
  'next build 実行時に TurbopackInternalError が再発した（再現性あり）',
];

const NPM_CACHE_CONCERNS = [
  'npm install が EPERM で失敗（cache folder contains root-owned files）',
];

const BATS_CONCERNS = [
  'sandbox 環境に bats がインストールされていないため bats テストは CI に委譲した',
];

// ============================================================
// (a) green auto-close
// ============================================================

let sharedGreen = null;
async function ensureGreenRun() {
  if (sharedGreen !== null) return;
  sharedGreen = await runScenario({
    concerns: TURBOPACK_CONCERNS,
    ciChecksResponse: { ok: true, checks: [{ name: 'Vercel', bucket: 'pass' }, { name: 'build', bucket: 'pass' }] },
  });
}

test('[ci-checks][a] crash guard: green auto-close シナリオが sandbox でクラッシュしない', async () => {
  await ensureGreenRun();
  assertNoCrash(sharedGreen.err, 'a-green');
});

test('[ci-checks][AC-1][a] merge-tier-facts 呼び出しが 1 回発生し gh pr checks コマンドを prompt に含む（checks 専用 spawn は発行しない）', async () => {
  await ensureGreenRun();
  const { calls } = sharedGreen;
  const factCalls = calls.filter((c) => c.label === 'merge-tier-facts');
  assert.equal(
    factCalls.length, 1,
    `label === 'merge-tier-facts' の call は 1 件のはず (全 labels: ${calls.map((c) => c.label).join(', ')})`,
  );
  assert.ok(
    factCalls[0].prompt.includes('gh pr checks 1 --json name,bucket'),
    `merge-tier-facts の prompt に gh pr checks コマンドが含まれていない:\n${factCalls[0].prompt}`,
  );
  assert.equal(calls.filter((c) => c.label === 'ci-checks').length, 0, 'checks 専用の exec-proxy spawn は発行しない');
});

test('[ci-checks][AC-1][a] post-summary の環境ノートに件数行が現れ、turbopack-sandbox ENV item が CI 確認済み（check名列挙）で auto-close される', async () => {
  await ensureGreenRun();
  const { calls, logs } = sharedGreen;
  envNoteCountLine(calls, 1);
  const lines = ciCheckLogs(logs);
  assert.ok(
    lines.some((l) => l.includes('ci-checks: turbopack-sandbox 系 check 全 pass（Vercel, build）') && l.includes('CI 委譲で解消')),
    `turbopack-sandbox の auto-close log（check 名 Vercel, build）が無い: ${JSON.stringify(lines)}`,
  );
});

// ============================================================
// (b) fail-open
// ============================================================

let sharedFailOpen = null;
async function ensureFailOpenRun() {
  if (sharedFailOpen !== null) return;
  sharedFailOpen = await runScenario({
    concerns: TURBOPACK_CONCERNS,
    ciChecksResponse: { ok: false, error: 'x' },
  });
}

test('[ci-checks][b] crash guard: fail-open シナリオが sandbox でクラッシュしない', async () => {
  await ensureFailOpenRun();
  assertNoCrash(sharedFailOpen.err, 'b-fail-open');
});

test('[ci-checks][AC-2][b] ci-checks 失敗でも workflow は完走し(post-summary 呼び出し有り)、環境ノートに CI 確認済みは現れず turbopack-sandbox env note は checked:false のまま据え置かれる', async () => {
  await ensureFailOpenRun();
  const { calls } = sharedFailOpen;
  const post = calls.find((c) => c.label === 'post-summary');
  assert.ok(
    post != null,
    `label === 'post-summary' の call が見つからない (全 labels: ${calls.map((c) => c.label).join(', ')})。workflow が完走していない可能性`,
  );
  assert.ok(
    !post.prompt.includes('CI で確認済み'),
    `ci-checks 失敗時は fail-open で ENV item を据え置くはずが「CI で確認済み」が現れている:\n${post.prompt.slice(0, 2000)}`,
  );
  envNoteCountLine(calls, 1);
  const lines = ciCheckLogs(sharedFailOpen.logs);
  assert.ok(
    lines.some((l) => l.includes('ci-checks: checks 取得失敗') && l.includes('据え置き（fail-open）')),
    `ci-checks 失敗時の fail-open 据え置き log が無い: ${JSON.stringify(lines)}`,
  );
  assert.ok(
    !lines.some((l) => l.includes('CI 委譲で解消')),
    `ci-checks 失敗時に ENV item が解消されている: ${JSON.stringify(lines)}`,
  );
});

// ============================================================
// (c) allowlist 外は未呼出
// ============================================================

let sharedAllowlist = null;
async function ensureAllowlistRun() {
  if (sharedAllowlist !== null) return;
  sharedAllowlist = await runScenario({
    concerns: NPM_CACHE_CONCERNS,
    ciChecksResponse: { ok: true, checks: [{ name: 'Vercel', bucket: 'pass' }] },
  });
}

test('[ci-checks][c] crash guard: allowlist 外シナリオが sandbox でクラッシュしない', async () => {
  await ensureAllowlistRun();
  assertNoCrash(sharedAllowlist.err, 'c-allowlist');
});

test('[ci-checks][AC-3][c] ENV-NPM-CACHE-EPERM は環境ノートに現れ(positive assert)、ci-checks の判定対象にならず、merge-tier-facts 以外の checks spawn は発生しない', async () => {
  await ensureAllowlistRun();
  const { calls, logs } = sharedAllowlist;
  envNoteCountLine(calls, 1);
  assert.deepEqual(
    ciCheckLogs(logs), [],
    `npm-cache-eperm は allowlist 外のため ci-checks の判定 log は出ないはず: ${JSON.stringify(ciCheckLogs(logs))}`,
  );
  const ciCalls = calls.filter((c) => c.label === 'ci-checks');
  assert.equal(
    ciCalls.length,
    0,
    `label === 'ci-checks' の call は 0 件のはずが ${ciCalls.length} 件発生している（checks は merge-tier-facts の 1 spawn に含まれ、専用 spawn は発行しない）`,
  );
  assert.equal(calls.filter((c) => c.label === 'merge-tier-facts').length, 1, 'merge-tier-facts は allowlist 外 ENV item のみでも 1 回（Merge tier の他の事実取得に必要）');
});

// ============================================================
// (d) merge tier 不変
// ============================================================

test('[ci-checks][AC-4][d] green auto-close と fail-open で Merge tier テーブルの値行が一致する', async () => {
  await ensureGreenRun();
  await ensureFailOpenRun();
  const extractMergeTierRow = (calls) => {
    const post = calls.find((c) => c.label === 'post-summary');
    assert.ok(post != null);
    const lines = post.prompt.split('\n');
    const headerIdx = lines.findIndex((l) => l.includes('| Merge tier |'));
    assert.ok(headerIdx >= 0, `Merge tier テーブルのヘッダ行が見つからない`);
    // ヘッダ行の次は区切り行(|---|...)、その次が値行
    const valueRow = lines[headerIdx + 2];
    assert.ok(valueRow != null && valueRow.trim().length > 0, `Merge tier テーブルの値行が見つからない`);
    return valueRow;
  };
  const greenRow = extractMergeTierRow(sharedGreen.calls);
  const failOpenRow = extractMergeTierRow(sharedFailOpen.calls);
  assert.equal(
    greenRow,
    failOpenRow,
    `auto-close の有無で Merge tier テーブルの値行が変わっている（AC-4 違反）:\ngreen: ${greenRow}\nfail-open: ${failOpenRow}`,
  );
});

test('[ci-checks][AC-4][d] gate-policy: checked/unchecked な ENV item(minor, inspection) は共に advisory lane で、isConvergedUnderPolicy は checkItem 前後で同値', () => {
  const envItemBase = {
    id: 'ENV-TURBOPACK-SANDBOX',
    text: 't',
    dimension: 'environment',
    severity: 'minor',
    source: 'concern',
    check: { kind: 'inspection' },
  };

  // gateLane は checked の有無に関わらず lane 分類（dimension/severity/source/check.kind）で決まる
  const uncheckedItem = { ...envItemBase, checked: false };
  const checkedItem = { ...envItemBase, checked: true };
  assert.equal(gateLane(uncheckedItem, DEFAULT_GATE_POLICY), 'advisory');
  assert.equal(gateLane(checkedItem, DEFAULT_GATE_POLICY), 'advisory');

  // isConvergedUnderPolicy: checkItem 前後で同値（advisory は収束を block しないため元々 true のまま）
  let ledger = makeLedger();
  ledger = appendItem(ledger, envItemBase).ledger;
  const convergedBefore = isConvergedUnderPolicy(ledger, DEFAULT_GATE_POLICY);
  ledger = checkItem(ledger, 'ENV-TURBOPACK-SANDBOX', 'CI で確認済み（Vercel, build）');
  const convergedAfter = isConvergedUnderPolicy(ledger, DEFAULT_GATE_POLICY);
  assert.equal(convergedBefore, true);
  assert.equal(convergedAfter, true);
  assert.equal(convergedBefore, convergedAfter);
});

// ============================================================
// (e) bats green auto-close
// ============================================================

let sharedBatsGreen = null;
async function ensureBatsGreenRun() {
  if (sharedBatsGreen !== null) return;
  sharedBatsGreen = await runScenario({
    concerns: BATS_CONCERNS,
    ciChecksResponse: {
      ok: true,
      checks: [
        { name: 'Bats Tests (issue #93 helpers)', bucket: 'pass' },
        { name: 'Node Unit Tests (workflow arg resolver)', bucket: 'pass' },
      ],
    },
  });
}

test('[ci-checks][e] crash guard: bats green auto-close シナリオが sandbox でクラッシュしない', async () => {
  await ensureBatsGreenRun();
  assertNoCrash(sharedBatsGreen.err, 'e-bats-green');
});

test('[ci-checks][AC-2][e] bats check pass で ENV-BATS-SANDBOX が auto-close される（bats 不含の Node Unit Tests は evidence に含めない）', async () => {
  await ensureBatsGreenRun();
  const { calls, logs } = sharedBatsGreen;
  envNoteCountLine(calls, 1);
  const lines = ciCheckLogs(logs);
  const closed = lines.find((l) => l.includes('ci-checks: bats-sandbox 系 check 全 pass'));
  assert.ok(closed != null, `bats-sandbox の auto-close log が無い: ${JSON.stringify(lines)}`);
  assert.ok(
    closed.includes('全 pass（Bats Tests (issue #93 helpers)）'),
    `bats-sandbox の auto-close log に bats check 名が列挙されていない: ${closed}`,
  );
  assert.ok(
    !closed.includes('Node Unit Tests (workflow arg resolver)'),
    `bats を含まない汎用 test check（Node Unit Tests）が evidence に含まれている（regex が /bats/i に絞られていない疑い）: ${closed}`,
  );
});

// ============================================================
// (f) bats pending 据え置き
// ============================================================

let sharedBatsPending = null;
async function ensureBatsPendingRun() {
  if (sharedBatsPending !== null) return;
  sharedBatsPending = await runScenario({
    concerns: BATS_CONCERNS,
    ciChecksResponse: {
      ok: true,
      checks: [
        { name: 'Bats Tests (issue #93 helpers)', bucket: 'pending' },
        { name: 'Node Unit Tests (workflow arg resolver)', bucket: 'pass' },
      ],
    },
  });
}

test('[ci-checks][f] crash guard: bats pending 据え置きシナリオが sandbox でクラッシュしない', async () => {
  await ensureBatsPendingRun();
  assertNoCrash(sharedBatsPending.err, 'f-bats-pending');
});

test('[ci-checks][AC-3][f] bats/test 系 check が pending のとき ENV-BATS-SANDBOX は据え置かれる(positive assert)', async () => {
  await ensureBatsPendingRun();
  const { calls, logs } = sharedBatsPending;
  envNoteCountLine(calls, 1);
  const lines = ciCheckLogs(logs);
  assert.ok(
    lines.some((l) => l.includes('ci-checks: bats-sandbox → ') && l.includes('据え置き（fail-open）')),
    `bats check が pending のときの据え置き log が無い: ${JSON.stringify(lines)}`,
  );
  assert.ok(
    !lines.some((l) => l.includes('CI 委譲で解消')),
    `bats check が pending なのに ENV item が解消されている: ${JSON.stringify(lines)}`,
  );
});

// ============================================================
// (g) per-key 独立性
// ============================================================

let sharedPerKey = null;
async function ensurePerKeyRun() {
  if (sharedPerKey !== null) return;
  sharedPerKey = await runScenario({
    concerns: [...TURBOPACK_CONCERNS, ...BATS_CONCERNS],
    ciChecksResponse: {
      ok: true,
      checks: [
        { name: 'build', bucket: 'pass' },
        { name: 'Vercel', bucket: 'pass' },
        { name: 'Bats Tests (issue #93 helpers)', bucket: 'fail' },
      ],
    },
  });
}

test('[ci-checks][g] crash guard: per-key 独立性シナリオが sandbox でクラッシュしない', async () => {
  await ensurePerKeyRun();
  assertNoCrash(sharedPerKey.err, 'g-per-key');
});

test('[ci-checks][AC-4][g] turbopack-sandbox は auto-close、bats-sandbox は据え置きの per-key 独立判定', async () => {
  await ensurePerKeyRun();
  const { calls, logs } = sharedPerKey;
  envNoteCountLine(calls, 2);
  const lines = ciCheckLogs(logs);
  assert.ok(
    lines.some((l) => l.includes('ci-checks: turbopack-sandbox 系 check 全 pass') && l.includes('CI 委譲で解消')),
    `build/Vercel が pass なのに turbopack-sandbox が auto-close されていない: ${JSON.stringify(lines)}`,
  );
  assert.ok(
    lines.some((l) => l.includes('ci-checks: bats-sandbox → ') && l.includes('据え置き（fail-open）')),
    `bats check が fail なのに bats-sandbox が据え置かれていない: ${JSON.stringify(lines)}`,
  );
  assert.ok(
    !lines.some((l) => l.includes('ci-checks: bats-sandbox 系 check 全 pass')),
    `bats check が fail なのに bats-sandbox が解消されている: ${JSON.stringify(lines)}`,
  );
});
