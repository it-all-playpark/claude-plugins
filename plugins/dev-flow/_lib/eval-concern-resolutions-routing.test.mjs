// issue #296 (F4): concern-classify 導入後の dev-flow.js 配線回帰テスト。
//
// AC-1/2/3/4 を VM sandbox 実行で固定する:
//   - implementer が返す concerns のうち既知 4 パターンにマッチする文字列は ENV-* item に
//     分類され、eval#1 prompt の「未解消 concern 一覧」（CONCERN-* のみ対象）に現れない。
//   - 同一パターン key の concern は 1 件の ENV item に dedup され、発生件数が注記される。
//   - 非該当の concern は従来どおり CONCERN-* として要対応に残る。
//   - evaluator の concern_resolutions で resolution:'resolved' かつ evidence 付きの CONCERN-* は
//     checked になり要対応から消える。ENV-*/不明 id への指定は無視される。
//
// AC-5 は gate-policy.mjs の gateLane を直接呼び出す純関数ユニットとして固定する
// （environment/concern とも既定 policy 'llm-major-advisory' で advisory lane のまま、
// 収束判定が unchecked のまま true になる = W7 軸A 不変）。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeRecordingSandbox, runWorkflowCapture, mergeTierFacts } from './test-helpers/vm-sandbox.mjs';
import { gateLane, isConvergedUnderPolicy, DEFAULT_GATE_POLICY } from './gate-policy.mjs';
import { makeLedger, appendItem } from './goal-ledger.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');

// ============================================================
// responder: concern classify routing 専用の agent 応答
// implementer が Turbopack 系 concern ×3（同一パターン key） + 非該当 concern ×1 を返す。
// evaluator は concern_resolutions で CONCERN-1 / CONCERN-99（不明 id）/ ENV-TURBOPACK-SANDBOX
// （dimension 相違で無視される）を resolved:true として返す。
// ============================================================

function createResponder() {
  return function({ label, agentType }) {
    // Setup(worktree)
    // Setup(setup-base): base 解決 + 既存 worktree 起点検証 統合 probe（issue #550 案1）
    if (label === 'setup-base') {
      return { ok: true, default_branch: 'main', dev_exists: true, requested_exists: false, worktree_exists: false, upstream_remote: '', upstream_merge: '' };
    }
    if (label === 'worktree') {
      return { worktree: '/tmp/wt', branch: 'feature/issue-296' };
    }
    // Analyze: 必ず standard（micro だと Evaluate が skip され eval#1 が発生しない）
    if (label.startsWith('analyze')) {
      return {
        summary: 's',
        acceptance_criteria: ['a', 'b', 'c', 'd'],
        issue_type: 'fix',
        scope: 'src',
        issue_number: 1,
        issue_title: 'stub-issue-title',
      };
    }
    // Security floor の敵対的 security review の対象判定（issue #1063）: この test の関心外なので対象外を返す
    if (label === 'security-scope') return { ok: true, target: false, reasons: [] };
    // Security floor / danger-grep 系
    if (label.startsWith('danger-grep')) {
      return { ok: true, hits: [] };
    }
    // Validate: test runner
    if (label.startsWith('test')) {
      return { tests: 'passed', green: true, summary: '' };
    }
    // Evaluate: evaluator（concern_resolutions で CONCERN-1 を解消。CONCERN-99/ENV-* は無視される想定）
    if (agentType === 'dev-flow:evaluator') {
      return {
        verdict: 'pass',
        total: 100,
        threshold: 80,
        feedback: [],
        feedback_level: 'implementation',
        ac_results: [
          { ac_index: 0, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
          { ac_index: 1, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
          { ac_index: 2, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
          { ac_index: 3, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
        ],
        security_clearance: [],
        concern_resolutions: [
          { id: 'CONCERN-1', resolution: 'resolved', evidence: 'src/x.ts:10 で検証追加' },
          { id: 'CONCERN-2', resolution: 'triaged', evidence: 'lib/y.ts:20 の shorthand 判定は未変更。advisory で実害なし、修正不要と判断' },
          { id: 'CONCERN-99', resolution: 'resolved', evidence: 'x' },
          { id: 'ENV-TURBOPACK-SANDBOX', resolution: 'resolved', evidence: 'x' },
        ],
      };
    }
    // realized-diff / declared-path-check / changed-files → files: [] で undeclared を発生させない
    if (label === 'realized-diff' || label === 'declared-path-check') {
      return { files: [] };
    }
    if (label === 'merge-tier-facts') return mergeTierFacts({ files: [] });
    // PR 系
    if (label.startsWith('pr')) {
      return { pr_url: 'http://x', pr_number: 1, committed: true };
    }
    // diff-gate / diff-hash
    if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) {
      return { hash: 'H', empty: false };
    }
    // post-summary（dev-runner-haiku）
    if (label === 'post-summary' && agentType === 'dev-flow:dev-runner-haiku') {
      return { posted: true, method: 'gh pr comment', url: 'http://x' };
    }
    // implementer（本経路の main call。concerns に既知 4 パターン系 ×3 + 非該当 ×1）
    if (agentType === 'dev-flow:dev-implementer') {
      return {
        status: 'DONE_WITH_CONCERNS',
        task_id: 't1',
        files: ['src/x.ts'],
        summary: 's',
        concerns: [
          'sandbox 内で next build が TurbopackInternalError で失敗した',
          'next build 実行時に TurbopackInternalError が再発した（再現性あり）',
          'CI と異なり sandbox では next build が TurbopackInternalError を吐く',
          'CONCERN マーカー: ORDER BY 検証が未実装',
          'CONCERN マーカー: shorthand 判定の重複が残る',
        ],
      };
    }
    // issue-meta（issue #451）: analyze provenance 突合 probe
    if (label === 'issue-meta') return { ok: true, number: 1, title: 'stub-issue-title' };
    // デフォルト
    return null;
  };
}

// ============================================================
// 共有実行（複数テストが同じ sandbox 実行結果を参照する）
// ============================================================

let sharedCalls = null;
let sharedErr = null;
let sharedResult = null;

async function ensureSharedRun() {
  if (sharedCalls !== null) return;
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, calls } = makeRecordingSandbox(createResponder());
  const { result, error } = await runWorkflowCapture(src, ctx);
  sharedCalls = calls;
  sharedErr = error;
  sharedResult = result;
}

test('[eval-concern-resolutions] crash guard: dev-flow.js が sandbox で ReferenceError / SyntaxError を throw しない', async () => {
  await ensureSharedRun();
  if (sharedErr && (sharedErr.name === 'ReferenceError' || sharedErr.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${sharedErr.name}: ${sharedErr.message}`);
  }
});

test('[eval-concern-resolutions] AC-1/3: eval#1 prompt の未解消 concern 一覧に CONCERN-1 は含まれ ENV-TURBOPACK-SANDBOX は含まれない', async () => {
  await ensureSharedRun();
  const eval1 = sharedCalls.find((c) => c.label === 'eval#1');
  assert.ok(
    eval1 != null,
    `label === 'eval#1' の call が見つからない (全 labels: ${sharedCalls.map((c) => c.label).join(', ')})`,
  );
  assert.ok(
    eval1.prompt.includes('CONCERN-1'),
    `eval#1 の prompt に CONCERN-1 が含まれていない`,
  );
  assert.ok(
    !eval1.prompt.includes('ENV-TURBOPACK-SANDBOX'),
    `eval#1 の未解消 concern 一覧は CONCERN-* のみが対象のはずが ENV-TURBOPACK-SANDBOX を含んでいる`,
  );
});

// post-summary は環境ノートの件数（グループ数）と、解消済み ledger item の <details> 表
// （| 区分 | 内容 | 解消根拠 |）を出す。本文の見出し・表形式は devflow-summary-format.test.mjs（純関数出力テスト）が
// 担うため、本ファイルの routing test は concern の分類・解消が post-summary に届くことを検証する。

function postSummaryPrompt(calls) {
  const post = calls.find((c) => c.label === 'post-summary');
  assert.ok(
    post != null,
    `label === 'post-summary' の call が見つからない (全 labels: ${calls.map((c) => c.label).join(', ')})`,
  );
  return post.prompt;
}
// 解消済み証跡の <details> 表の行（区分セルが blocking / advisory / AC / security の行）
function resolvedRows(prompt) {
  const start = prompt.indexOf('**解消済み証跡');
  assert.ok(start >= 0, `post-summary に解消済み証跡セクションが無い:\n${prompt.slice(0, 2000)}`);
  const end = prompt.indexOf('</details>', start);
  return prompt.slice(start, end < 0 ? undefined : end).split('\n').filter((l) => /^\| (blocking|advisory|AC|security) \|/.test(l));
}

test('[eval-concern-resolutions] AC-2: turbopack-sandbox の concern 3 件は環境ノート 1 件に dedup され、解消済み表に ENV-* 行は出ない', async () => {
  await ensureSharedRun();
  const prompt = postSummaryPrompt(sharedCalls);
  assert.ok(
    prompt.includes('🏗 環境ノート 1 件'),
    `post-summary に「🏗 環境ノート 1 件」（3 件の dedup 結果）が無い:\n${prompt.slice(0, 2000)}`,
  );
  // ENV item（dimension:'environment'）は環境ノート経路にのみ載り、解消済み表には入らない
  assert.ok(
    !resolvedRows(prompt).some((l) => l.includes('TurbopackInternalError')),
    `解消済み表に ENV item の行が混入している: ${JSON.stringify(resolvedRows(prompt))}`,
  );
});

test('[eval-concern-resolutions] AC-4: CONCERN-1 は evaluator の concern_resolutions で resolve され、post-summary の解消済み表に evidence 付きで載る', async () => {
  await ensureSharedRun();
  const rows = resolvedRows(postSummaryPrompt(sharedCalls));
  const row = rows.find((l) => l.includes('ORDER BY 検証が未実装'));
  assert.ok(row != null, `解消済み表に CONCERN-1 の行が無い（resolved として checked になっていない）: ${JSON.stringify(rows)}`);
  assert.ok(row.startsWith('| advisory |'), `CONCERN-1 は advisory lane の行のはず: ${row}`);
  assert.ok(
    row.includes('src/x.ts:10 で検証追加'),
    `CONCERN-1 の解消根拠が evaluator の concern_resolutions で返した文字列を含まない: ${row}`,
  );
});

// ============================================================
// AC-5: environment/concern とも既定 policy で advisory lane のまま、収束判定が不変であること
// （gate-policy.mjs の gateLane / isConvergedUnderPolicy を直接検証。W7 軸A 不変）
// ============================================================

test('[eval-concern-resolutions][AC-5] ENV item (severity minor) と CONCERN item (severity major) は既定 policy で共に advisory', () => {
  const envItem = {
    id: 'ENV-TURBOPACK-SANDBOX', text: 't', dimension: 'environment', severity: 'minor',
    source: 'concern', check: { kind: 'inspection' }, checked: false,
  };
  const concernItem = {
    id: 'CONCERN-1', text: 'c', dimension: 'concern', severity: 'major',
    source: 'concern', check: { kind: 'inspection' }, checked: false,
  };
  assert.equal(gateLane(envItem, DEFAULT_GATE_POLICY), 'advisory');
  assert.equal(gateLane(concernItem, DEFAULT_GATE_POLICY), 'advisory');
});

test('[eval-concern-resolutions][AC-5] 両 item が unchecked のまま isConvergedUnderPolicy は true（advisory は収束を block しない）', () => {
  let ledger = makeLedger();
  ledger = appendItem(ledger, {
    id: 'ENV-TURBOPACK-SANDBOX', text: 't', dimension: 'environment', severity: 'minor',
    source: 'concern', check: { kind: 'inspection' },
  }).ledger;
  ledger = appendItem(ledger, {
    id: 'CONCERN-1', text: 'c', dimension: 'concern', severity: 'major',
    source: 'concern', check: { kind: 'inspection' },
  }).ledger;
  assert.equal(isConvergedUnderPolicy(ledger, DEFAULT_GATE_POLICY), true);
});

// ============================================================
// issue #614: triaged resolution の routing 回帰
// ============================================================

test('[eval-concern-resolutions][#626] CONCERN-2 は triaged として解消済み表に含まれず、post-summary prompt に merge_tier marker + triaged evidence（evaluator データの echo）が現れる', async () => {
  await ensureSharedRun();
  const post = sharedCalls.find((c) => c.label === 'post-summary');
  assert.ok(post != null, `label === 'post-summary' の call が見つからない`);
  assert.ok(
    post.prompt.includes('<!-- dev-flow:REVIEW -->'),
    `post-summary の prompt に <!-- dev-flow:REVIEW --> marker が無い:\nprompt(先頭2000):\n${post.prompt.slice(0, 2000)}`,
  );
  assert.ok(
    !post.prompt.includes('<!-- dev-flow:HOLD'),
    `CONCERN-2 が triaged advisory のみのため <!-- dev-flow:HOLD --> は出ないはず:\nprompt(先頭2000):\n${post.prompt.slice(0, 2000)}`,
  );
  assert.ok(
    post.prompt.includes('lib/y.ts:20 の shorthand 判定は未変更。advisory で実害なし、修正不要と判断'),
    `post-summary の prompt に CONCERN-2 の triaged evidence（evaluator が concern_resolutions で返したデータの echo）が無い:\nprompt(先頭2000):\n${post.prompt.slice(0, 2000)}`,
  );
  const rows = resolvedRows(post.prompt);
  assert.ok(
    !rows.some((l) => l.includes('shorthand 判定の重複が残る')),
    `CONCERN-2 は triaged（checked のまま変わらない）のため解消済み表に含まれるべきでない: ${JSON.stringify(rows)}`,
  );
});

test('[eval-concern-resolutions][#614] triaged は ledger 収束を変えない（result.merge_tier と journal-log prompt の "merge_tier" が一致し HOLD にならない）', async () => {
  await ensureSharedRun();
  assert.ok(sharedResult !== null, '#614 return object を返すべき');
  assert.notEqual(sharedResult?.merge_tier, 'HOLD', `#614 triaged concern は advisory のため merge_tier は HOLD にならないはずだが ${JSON.stringify(sharedResult?.merge_tier)}`);
  const journalCall = sharedCalls.find((c) => c.label === 'journal-log');
  assert.ok(journalCall !== undefined, '#614 journal-log の agent 呼び出しが存在すべき');
  assert.ok(
    journalCall.prompt.includes(`"merge_tier":"${sharedResult.merge_tier}"`),
    `#614 journal-log prompt の "merge_tier" が result.merge_tier(${sharedResult.merge_tier}) と一致しない:\n${journalCall.prompt.slice(0, 500)}`,
  );
});

// ============================================================
// (Q) CONCERN routing: resolution 値による merge_tier 差異が無いこと（reviewer 指摘の代替ケース）
// ============================================================

function createSingleConcernResponder(concernResolutions) {
  return function ({ label, agentType }) {
    if (label === 'setup-base') {
      return { ok: true, default_branch: 'main', dev_exists: true, requested_exists: false, worktree_exists: false, upstream_remote: '', upstream_merge: '' };
    }
    if (label === 'worktree') return { worktree: '/tmp/wt', branch: 'feature/issue-296-q' };
    if (label.startsWith('analyze')) {
      return {
        summary: 's', acceptance_criteria: ['a'], issue_type: 'fix', scope: 'src',
        issue_number: 1, issue_title: 'stub-issue-title',
      };
    }
    // Security floor の敵対的 security review の対象判定（issue #1063）: この test の関心外なので対象外を返す
    if (label === 'security-scope') return { ok: true, target: false, reasons: [] };
    if (label.startsWith('danger-grep')) return { ok: true, hits: [] };
    if (label.startsWith('test')) return { tests: 'passed', green: true, summary: '' };
    if (agentType === 'dev-flow:evaluator') {
      return {
        verdict: 'pass', total: 100, threshold: 80, feedback: [], feedback_level: 'implementation',
        ac_results: [{ ac_index: 0, satisfied: true, verified_by: 'inspection', evidence: 'ok' }],
        security_clearance: [],
        concern_resolutions: concernResolutions,
      };
    }
    if (label === 'realized-diff' || label === 'declared-path-check') return { files: [] };
    if (label === 'merge-tier-facts') return mergeTierFacts({ files: [] });
    if (label.startsWith('pr')) return { pr_url: 'http://x', pr_number: 1, committed: true };
    if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) return { hash: 'H', empty: false };
    if (label === 'post-summary' && agentType === 'dev-flow:dev-runner-haiku') return { posted: true, method: 'gh pr comment', url: 'http://x' };
    if (agentType === 'dev-flow:dev-implementer') {
      return {
        status: 'DONE_WITH_CONCERNS', task_id: 't1', files: ['src/x.ts'], summary: 's',
        concerns: ['CONCERN マーカー: 単一の未分類 concern'],
      };
    }
    if (label === 'issue-meta') return { ok: true, number: 1, title: 'stub-issue-title' };
    return null;
  };
}

async function runSingleConcernScenario(concernResolutions) {
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx } = makeRecordingSandbox(createSingleConcernResponder(concernResolutions));
  return runWorkflowCapture(src, ctx);
}

test('[eval-concern-resolutions][Q] concern が unresolved のままでも merge_tier は HOLD にならない（advisory lane、既定 gate_policy）', async () => {
  const { result, error } = await runSingleConcernScenario([]);
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) assert.fail(`dev-flow.js crash: ${error.name}: ${error.message}`);
  if (error) assert.fail(`[Q-unresolved] 想定外エラー: ${error.message}`);
  assert.ok(result !== null, '[Q-unresolved] return object を返すべき');
  assert.notEqual(
    result?.merge_tier,
    'HOLD',
    `[Q-unresolved] concern が unresolved のままでも advisory lane のため merge_tier は HOLD にならないはずだが ${JSON.stringify(result?.merge_tier)}`,
  );
});

test('[eval-concern-resolutions][Q] concern の resolution が resolved / triaged で merge_tier が同一', async () => {
  const resolvedRun = await runSingleConcernScenario([{ id: 'CONCERN-1', resolution: 'resolved', evidence: 'x' }]);
  const triagedRun = await runSingleConcernScenario([{ id: 'CONCERN-1', resolution: 'triaged', evidence: 'x' }]);
  if (resolvedRun.error && (resolvedRun.error.name === 'ReferenceError' || resolvedRun.error.name === 'SyntaxError')) assert.fail(`dev-flow.js crash: ${resolvedRun.error.name}: ${resolvedRun.error.message}`);
  if (triagedRun.error && (triagedRun.error.name === 'ReferenceError' || triagedRun.error.name === 'SyntaxError')) assert.fail(`dev-flow.js crash: ${triagedRun.error.name}: ${triagedRun.error.message}`);
  if (resolvedRun.error) assert.fail(`[Q-resolved] 想定外エラー: ${resolvedRun.error.message}`);
  if (triagedRun.error) assert.fail(`[Q-triaged] 想定外エラー: ${triagedRun.error.message}`);
  assert.equal(
    resolvedRun.result?.merge_tier,
    triagedRun.result?.merge_tier,
    `resolution=resolved と triaged で merge_tier が異なる: resolved=${resolvedRun.result?.merge_tier} triaged=${triagedRun.result?.merge_tier}`,
  );
});
