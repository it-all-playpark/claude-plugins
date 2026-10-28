import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, makePrIterateSandbox, runWorkflowCapture, mergeTierFacts, analyzeArgs } from './test-helpers/vm-sandbox.mjs';
import { DEV_FLOW_SCENARIOS } from './test-helpers/dev-flow-scenarios.mjs';

/**
 * tracked-agent-failure-policy.test.mjs — trackedAgent( 呼び出しの 3 分類強制（issue #605）を
 * vm-sandbox 共有 harness による throw 注入マトリクスの挙動テストで検証する。
 *
 * dev-flow.js / pr-iterate.js の trackedAgent( call site は必ず以下いずれかに属する:
 *   1. need() 内                — throw は中断（run abort）。null も中断（既存 need() 契約）。
 *   2. failOpenAgent wrapper 内 — throw を吸収し null へ倒す（fail-open、continue）。
 *   3. ローカル try{}/pipeline() 包囲 — throw を吸収し継続する bare 呼び出し（fail-safe、continue）。
 *   4. 上記いずれでもない bare 呼び出し — throw は吸収されず run 全体の安全網 try まで伝播し abort する
 *      （fail-closed「据え置き」）。
 *
 * 各 label に対し実際に agent() を throw させて run を実行し、continue（error===null）/
 * abort（error!==null かつ abort handoff が発火）/ needs_clarification のいずれになるかを
 * EXPECTED テーブルと突合する。
 *
 * **カバレッジの範囲**: 「未分類 label 検出」test が観測する label は `DEV_FLOW_SCENARIOS`
 * （`test-helpers/dev-flow-scenarios.mjs`）の全 scenario + 本ファイル固有の baseline 設定
 * （DF_B1〜DF_B5 / DF_DANGER）が到達する範囲に限る — dev-flow.js 中の bare trackedAgent( 出現を
 * 静的に全走査するわけではない。新しい scenario を dev-flow-scenarios.mjs に足せば新規 call site も
 * ここへ到達し、EXPECTED_DEV_FLOW 未登録なら red になる（scenario 集合を経由した分類強制）。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const DEV_FLOW_PATH = join(HERE, '..', '.claude', 'workflows', 'dev-flow.js');
const PR_ITERATE_PATH = join(HERE, '..', '.claude', 'workflows', 'pr-iterate.js');
const devFlowSrc = readFileSync(DEV_FLOW_PATH, 'utf8');
const prIterateSrc = readFileSync(PR_ITERATE_PATH, 'utf8');

const THROW = () => { throw new Error('injected'); };

// ============================================================
// dev-flow.js baseline 設定
// ============================================================
// 各 label は到達に必要な前提が異なる。baseline ごとに最小限の override で到達経路を作る。

// B1: 既定 run（fixes_applied:0、shape=standard）。最も多くの label がここで到達する。
const DF_B1 = { overrides: {} };
// ANALYZE_GATE: Analyze の 3 条件ゲートを引く（AC 空）— analyze-clarify#1（ゲート後の sonnet 1 spawn）へ到達させる
const DF_ANALYZE_GATE = { overrides: {}, extra: { args: analyzeArgs(1, { acceptance_criteria: [] }) } };
// AC_OBS: prerun で観測型判定が確定しない（null の）AC を持つ — ac-observational#1（ゲート通過後の 1 spawn）へ到達させる
const DF_AC_OBS = { overrides: {}, extra: { args: analyzeArgs(1, { ac_observational: [false, null], ac_observational_evidence: ['正規表現の絞り込みに当たらない', 'Jev 応答なし'] }) } };
// B2: pr-iterate fix 適用後の Final reconcile 系（reconcile-sync 成功・test#final 既定 pass）。
const DF_B2 = {
  workflow: async () => ({ status: 'lgtm', iterations: 2, fixes_applied: 1 }),
  overrides: { 'reconcile-sync': { ok: true, head: 'a'.repeat(40) } },
};
// B5: Merge tier の merge-tier-facts が Diff triage と異なる hash（reuse miss）かつ risk に新規 hit
// （auth）を報告 → one-shot security-clearance-final へ到達する。
const DF_B5 = {
  workflow: async () => ({ status: 'lgtm', iterations: 2, fixes_applied: 1 }),
  overrides: {
    'reconcile-sync': { ok: true, head: 'a'.repeat(40) },
    'test#final': { tests: 'passed', green: true, summary: '' },
    'merge-tier-facts': mergeTierFacts({ hash: 'BBB', risk: { ok: true, hits: [{ class: 'auth', file: 'src/x.ts' }] } }),
  },
};
// DANGER: danger-grep（Diff triage）throw に加え、merge-tier-facts（Merge tier）の risk も fail-closed
// を返す複合 override。Merge tier は Diff triage の結果を独立に再取得するため、danger-grep 単体の
// throw だけでは Merge tier 側の再取得で「clean」に復元されてしまい HOLD を再現できない
// （fail-closed が Diff triage と Merge tier の両方で持続する現実的なシナリオとして構成する）。
const DF_DANGER = { overrides: { 'merge-tier-facts': mergeTierFacts({ risk: { ok: false, hits: [], error: 'still down' } }) } };
// CLOSES: merge-tier-facts の closes サブ結果が Closes 欠落を報告し closes-reinject へ到達させる。
const DF_CLOSES = { overrides: { 'merge-tier-facts': mergeTierFacts({ closes: false }) } };

// ── DEV_FLOW_SCENARIOS 由来の baseline（issue #605 review。exec-proxy-routing と同じ
// scenario 集合を参照し、到達する label の分類を強制する）──
const DF_DIFF_GATE_RETRY = DEV_FLOW_SCENARIOS['diff-gate-retry'];
const DF_HASH_MISMATCH = DEV_FLOW_SCENARIOS['hash-mismatch'];
const DF_REDGREEN = DEV_FLOW_SCENARIOS['redgreen'];
const DF_CI_CHECKS = DEV_FLOW_SCENARIOS['ci-checks'];
const DF_COMPLEX_FIX = DEV_FLOW_SCENARIOS['complex-fix'];
const DF_GREEN_FIX = DEV_FLOW_SCENARIOS['green-fix'];
const DF_BASE_FAILING = DEV_FLOW_SCENARIOS['base-failing'];
const DF_POST_EVAL_GREEN_FIX = DEV_FLOW_SCENARIOS['post-eval-green-fix'];
const DF_FINAL_RECHECK = DEV_FLOW_SCENARIOS['final-recheck'];
const DF_LITE = DEV_FLOW_SCENARIOS['lite'];
const DF_CROSS_REPO = DEV_FLOW_SCENARIOS['cross-repo'];
const DF_LOCAL_VERIFY = DEV_FLOW_SCENARIOS['local-verify'];
const DF_LOCAL_VERIFY_REIMPL = DEV_FLOW_SCENARIOS['local-verify-reimpl'];
// journal-log-abort は top-level abort catch 内でのみ呼ばれる — DEV_FLOW_SCENARIOS['abort'] の
// トリガ throw message が THROW 定数と同じ 'injected' のため使うと自身の throw が吸収されたのか
// 元の abort が伝播したのか区別できない。message を変えた専用 base で「元の error message が
// そのまま残る（＝journal-log-abort 自身の throw は吸収された）」ことを検証する。
const DF_JOURNAL_ABORT_BASE = { overrides: { 'eval#1': () => { throw new Error('outer-trigger') } } };

async function runDevFlowBaseline(config) {
  const { ctx, calls } = makeDevFlowSandbox({ issue: 1, overrides: config.overrides, workflow: config.workflow, extra: config.extra ?? {} });
  const { result, error } = await runWorkflowCapture(devFlowSrc, ctx);
  return { result, error, calls };
}

async function runDevFlowThrow(config, label) {
  const overrides = { ...(config.overrides ?? {}), [label]: THROW };
  const { ctx, calls } = makeDevFlowSandbox({ issue: 1, overrides, workflow: config.workflow, extra: config.extra ?? {} });
  const { result, error } = await runWorkflowCapture(devFlowSrc, ctx);
  return { result, error, calls };
}

// ============================================================
// EXPECTED_DEV_FLOW: label → { config, policy, reason, extra? }
// ============================================================
const EXPECTED_DEV_FLOW = {
  'isolation-probe': { config: DF_B1, policy: 'abort', reason: 'bare据え置き。bg-isolation検知はfail-closed設計で回避手順を提示するthrowを伝播させる' },
  'analyze-clarify#1': {
    config: DF_ANALYZE_GATE,
    policy: 'needs_clarification',
    reason: 'failOpenAgent経由。ゲート後のmissing_context生成が失敗しても決定論のゲート理由でneeds_clarificationに終端する',
  },
  'ac-observational#1': {
    config: DF_AC_OBS,
    policy: 'continue',
    reason: 'failOpenAgent経由。観測型の分類agentが失敗しても未確定のACを観測型(true)に倒して継続する',
  },
  'impl:serial:issue-1': { config: DF_B1, policy: 'continue', reason: 'failOpenAgent経由。dev-implementer失敗はnullとしてdropし継続する' },
  'test#1': {
    config: DF_B1,
    policy: 'continue',
    reason: 'try/catchで合成redへ変換しgreen-fixループへ継続する既存のfail-safe経路',
    extra: async ({ calls }) => {
      assert.ok(calls.some((c) => c.label === 'green-fix#1'), "test#1 throw 後に label 'green-fix#1' の call が見つからない");
    },
  },
  'diff-gate': { config: DF_B1, policy: 'abort', reason: 'need()包み。empty-diff gate判定不能のまま先へ進めない致命契約' },
  'danger-grep': {
    config: DF_DANGER,
    policy: 'continue',
    reason: 'try/catchで吸収しunified=nullのper-fieldフォールバック（risk fail-closed）へ倒す',
    extra: async ({ result }) => {
      assert.equal(result?.merge_tier, 'HOLD', 'danger-grep と merge-tier-facts の risk が共に fail-closed の場合 merge_tier は HOLD になるべき');
    },
  },
  'security-scope': {
    config: DF_B1,
    policy: 'continue',
    reason: 'failOpenAgent経由。throw/nullは敵対的security reviewの対象として扱い（fail-closed）、pr-iterateがcleared を返さなければHOLD',
    extra: async ({ result }) => {
      assert.equal(result?.security_review?.target, true, 'security-scope throw は対象（fail-closed）になるべき');
      assert.equal(result?.merge_tier, 'HOLD', 'nested pr-iterate が cleared を返さない対象の run は HOLD になるべき');
      assert.ok(result?.merge_tier_hold_reasons?.some((r) => r.code === 'security_review_unresolved'), JSON.stringify(result?.merge_tier_hold_reasons));
    },
  },
  'diff-hash-eval': { config: DF_B1, policy: 'continue', reason: 'failOpenAgent経由。stale検出をskipするだけのadvisory信号' },
  'eval#1': { config: DF_B1, policy: 'abort', reason: 'need()包み。評価取得不能のままPRへ進めない致命契約' },
  'diff-hash-pr': { config: DF_B1, policy: 'continue', reason: 'failOpenAgent経由。stale検出をskipするだけのadvisory信号' },
  'pr#1': { config: DF_B1, policy: 'abort', reason: 'need()包み。PR作成失敗のまま継続しない致命契約' },
  'merge-tier-facts': {
    config: DF_B1,
    policy: 'continue',
    reason: 'try/catchで吸収しfacts=nullのper-fieldフォールバック（risk fail-closed → HOLD、他はfail-open）へ倒す。abortは終端サマリとjournal entryを失うためHOLDで人間へ返す',
    extra: async ({ result }) => {
      assert.equal(result?.merge_tier, 'HOLD', 'merge-tier-facts throw は risk fail-closed で merge_tier HOLD になるべき');
      assert.equal(result?.danger_fail_closed, true, 'merge-tier-facts throw は danger_fail_closed:true になるべき');
    },
  },
  'post-summary': { config: DF_B1, policy: 'abort', reason: 'bare据え置き。投稿失敗の吸収整備は別issueの検討対象' },
  'journal-log': {
    config: DF_B1,
    policy: 'continue',
    reason: 'runJournalHandoff内のtry/catchで吸収しsave_failedを返すfail-open経路（Write到達の申告なし）',
    extra: async ({ result }) => {
      assert.equal(result?.journal_log_status, 'save_failed', "journal-log throw 時は journal_log_status が 'save_failed' になるべき");
    },
  },
  'reconcile-sync': { config: DF_B2, policy: 'abort', reason: 'bare据え置き。worktree同期不能のままFinal reconcileを進めない' },
  'test#final': { config: DF_B2, policy: 'continue', reason: 'try/catchで吸収しunavailable扱い（merge tier HOLD）へ倒すfail-safe経路' },
  'changed-files-final': { config: DF_B2, policy: 'abort', reason: 'bare据え置き。最終changed-files取得失敗のfail-open化は別issueの検討対象' },
  'final-ac-reconcile': { config: DF_B2, policy: 'abort', reason: 'bare据え置き。最終AC再検証不能のままmerge tierを確定しない契約' },
  'security-clearance-final': { config: DF_B5, policy: 'abort', reason: 'bare据え置き。security clearance不能をclearと同一視しない契約' },
  'closes-reinject': {
    config: DF_CLOSES,
    policy: 'continue',
    reason: 'failOpenAgent経由。再投入失敗はmissingへ倒しmerge tierをHOLDにする決定論経路',
    extra: async ({ result }) => {
      assert.equal(result?.merge_tier, 'HOLD', 'closes-reinject throw で pr_closes_status=missing のため merge_tier は HOLD になるべき');
      assert.equal(result?.pr_closes_status, 'missing', 'closes-reinject throw 後の pr_closes_status は missing になるべき');
    },
  },
  'ac-checkbox-sync': {
    config: DF_B2,
    policy: 'continue',
    reason: 'failOpenAgent経由。checkbox同期失敗は表示専用のためfalseで継続するfail-open経路',
    extra: async ({ result }) => {
      assert.equal(result?.pr_body_synced, false, 'ac-checkbox-sync throw 後の pr_body_synced は false になるべき');
    },
  },

  // ── 以下は issue #605 review（PR #645）: DEV_FLOW_SCENARIOS 経由で新規到達する 30 label ──
  'issue-labels': { config: DF_DIFF_GATE_RETRY, policy: 'abort', reason: 'bare据え置き。cross-repoラベル取得不能のままempty-diff判定を進めない' },
  'reimpl-empty-diff:serial:issue-1': { config: DF_DIFF_GATE_RETRY, policy: 'continue', reason: 'failOpenAgent経由。empty-diff差し戻しのserial実装失敗はnullとしてdropし継続する' },
  'diff-gate-retry': { config: DF_DIFF_GATE_RETRY, policy: 'abort', reason: 'need()包み。差し戻し後のdiff再取得不能のまま先へ進めない致命契約' },
  'test#retry-1': {
    config: DF_DIFF_GATE_RETRY,
    policy: 'continue',
    reason: 'try/catchで合成redへ変換しgreen-fixループへ継続する既存のfail-safe経路（retry経路）',
  },
  'test#post-eval-1': {
    config: DF_COMPLEX_FIX,
    policy: 'continue',
    reason: 'try/catchで合成redへ変換しgreen-fixループへ継続するfail-safe経路（post-eval経路）',
  },
  'tree-diff-numstat': { config: DF_HASH_MISMATCH, policy: 'continue', reason: 'failOpenAgent経由。hash_mismatch時の差分一覧取得失敗はHOLD理由の可読性補助を欠くのみ' },
  'green-fix#post-eval-1': { config: DF_POST_EVAL_GREEN_FIX, policy: 'abort', reason: 'bare据え置き。green-fix実装呼び出しはtry/catchで吸収されずrunを中断させる（post-eval経路）' },
  'test#post-eval-2': {
    config: DF_POST_EVAL_GREEN_FIX,
    policy: 'continue',
    reason: 'try/catchで合成redへ変換しgreen-fixループへ継続するfail-safe経路（post-eval経路の2周目）',
  },
  'green-fix-classify': {
    config: DF_POST_EVAL_GREEN_FIX,
    policy: 'continue',
    reason: 'try/catchで吸収しhash不明として再評価せず、評価済みtreeを進めないfail-safe経路（PR直前のhash_mismatchでHOLD）',
    extra: async ({ result }) => {
      assert.equal(result?.eval_staleness, 'hash_mismatch', 'green-fix-classify throw では評価済み tree を進めず hash_mismatch になるべき');
      assert.equal(result?.merge_tier, 'HOLD', 'green-fix-classify throw では merge_tier は HOLD になるべき');
    },
  },
  'green-fix-numstat': { config: DF_POST_EVAL_GREEN_FIX, policy: 'continue', reason: 'failOpenAgent経由。green-fix差分一覧の取得失敗は申告ファイルで代替しfullモードで再評価する' },
  'eval-green-fix': {
    config: DF_POST_EVAL_GREEN_FIX,
    policy: 'continue',
    reason: 'try/catchで吸収し再評価不能として評価済みtreeを進めないfail-safe経路（PR直前のhash_mismatchでHOLD）',
    extra: async ({ result }) => {
      assert.equal(result?.eval_staleness, 'hash_mismatch', 'eval-green-fix throw では評価済み tree を進めず hash_mismatch になるべき');
      assert.equal(result?.merge_tier, 'HOLD', 'eval-green-fix throw では merge_tier は HOLD になるべき');
    },
  },
  'fix-diff-numstat': { config: DF_FINAL_RECHECK, policy: 'continue', reason: 'failOpenAgent経由。fix差分の取得失敗は最終diff全体で再検証対象を選ぶ（多めに確かめる側）' },
  'local-verify-start#1': { config: DF_LOCAL_VERIFY, policy: 'continue', reason: 'failOpenAgent経由。ローカル実行の起動結果が無ければfail-openでCIのcheck待ちに回す' },
  'local-verify-wait#1.1': { config: DF_LOCAL_VERIFY, policy: 'continue', reason: 'failOpenAgent経由。ローカル実行の結果が無ければfail-openでCIのcheck待ちに回す' },
  'local-verify-stop#1': { config: DF_LOCAL_VERIFY, policy: 'continue', reason: 'failOpenAgent経由。停止確認の失敗はlogのみでDBの削除はlocal-verifyのtrapに委ねる' },
  'diff-hash-local-verify-final': {
    config: DF_LOCAL_VERIFY,
    policy: 'continue',
    reason: 'failOpenAgent経由。最終treeのhashが取れなければexit 0をstaleにしてac_ci_pendingでHOLDに倒す',
    extra: async ({ result }) => {
      assert.equal(result?.local_verify?.status, 'stale', 'diff-hash-local-verify-final throw では passed を最終 tree の根拠にしない');
      assert.equal(result?.merge_tier, 'HOLD');
    },
  },
  'diff-hash-local-verify#2': { config: DF_LOCAL_VERIFY_REIMPL, policy: 'continue', reason: 'failOpenAgent経由。実行treeのhashが取れなければnullとしFinal reconcileで最終treeでの再実行に倒す' },
  'reimpl-local-verify#1:serial:issue-1': { config: DF_LOCAL_VERIFY_REIMPL, policy: 'continue', reason: 'failOpenAgent経由。local-verify差し戻しのdev-implementer失敗はnullとしてdropし再実行で判定する' },
  'test#local-verify-1': { config: DF_LOCAL_VERIFY_REIMPL, policy: 'continue', reason: 'try/catchで合成redへ変換しgreen-fixループへ継続する既存のfail-safe経路（local-verify差し戻し後）' },
  // Validate の各回の pre-commit hook（commit-hook#<iter>）。failOpenAgent 経由で、取れない応答は green 条件に何も足さない
  'commit-hook#1': {
    config: DF_B1,
    policy: 'continue',
    reason: 'failOpenAgent経由。hookの結果が取れなければgreen条件に足さずtestの結果だけで判定する（PR phaseのcommitが同じhookを通る）',
    extra: async ({ calls }) => {
      assert.ok(calls.some((c) => c.label === 'test#1'), 'commit-hook#1 throw 後も test#1 を実行すべき');
      assert.ok(!calls.some((c) => c.label === 'green-fix#1'), 'commit-hook#1 throw だけで green-fix#1 を起動してはならない');
    },
  },
  'commit-hook#2': { config: DF_GREEN_FIX, policy: 'continue', reason: 'failOpenAgent経由。green-fix後の回でhookの結果が取れなければgreen条件に足さず継続する' },
  'commit-hook#retry-1': { config: DF_DIFF_GATE_RETRY, policy: 'continue', reason: 'failOpenAgent経由。empty-diff差し戻し後の回でhookの結果が取れなければgreen条件に足さず継続する' },
  'commit-hook#post-eval-1': { config: DF_COMPLEX_FIX, policy: 'continue', reason: 'failOpenAgent経由。Evaluate差し戻し後の回でhookの結果が取れなければgreen条件に足さず継続する' },
  'commit-hook#post-eval-2': { config: DF_POST_EVAL_GREEN_FIX, policy: 'continue', reason: 'failOpenAgent経由。post-evalの2周目でhookの結果が取れなければgreen条件に足さず継続する' },
  'commit-hook#local-verify-1': { config: DF_LOCAL_VERIFY_REIMPL, policy: 'continue', reason: 'failOpenAgent経由。local-verify差し戻し後の回でhookの結果が取れなければgreen条件に足さず継続する' },
  'local-verify-start#2': { config: DF_LOCAL_VERIFY_REIMPL, policy: 'continue', reason: 'failOpenAgent経由。差し戻し後のローカル実行の起動結果が無ければfail-openでCIのcheck待ちに回す' },
  'local-verify-wait#2.1': { config: DF_LOCAL_VERIFY_REIMPL, policy: 'continue', reason: 'failOpenAgent経由。差し戻し後のローカル実行の結果が無ければfail-openでCIのcheck待ちに回す' },
  'local-verify-stop#2': { config: DF_LOCAL_VERIFY_REIMPL, policy: 'continue', reason: 'failOpenAgent経由。停止確認の失敗はlogのみでDBの削除はlocal-verifyのtrapに委ねる（差し戻し後）' },
  'redgreen': { config: DF_REDGREEN, policy: 'abort', reason: 'bare据え置き。red→green実証呼び出し自体の例外は吸収されずrunを中断させる' },
  'reimpl#1:serial:issue-1': { config: DF_COMPLEX_FIX, policy: 'continue', reason: 'failOpenAgent経由。evaluator差し戻しのdev-implementer失敗はnullとしてdropし継続する' },
  'eval#2': { config: DF_COMPLEX_FIX, policy: 'abort', reason: 'need()包み。2周目の評価取得不能のままPRへ進めない致命契約' },
  'green-fix#1': { config: DF_GREEN_FIX, policy: 'abort', reason: 'bare据え置き。green-fix実装呼び出しはtry/catchで吸収されずrunを中断させる' },
  'test#2': {
    config: DF_GREEN_FIX,
    policy: 'continue',
    reason: 'try/catchで合成redへ変換しgreen-fixループへ継続する既存のfail-safe経路',
  },
  'validate-diff#1': {
    config: DF_BASE_FAILING,
    policy: 'continue',
    reason: 'failOpenAgent経由。diff一覧が取れなければbase再実行をせず失敗をすべてgreen-fixの対象にする',
    extra: async ({ calls }) => {
      assert.ok(!calls.some((c) => c.label.startsWith('base-rerun#')), 'validate-diff#1 throw 後に base-rerun へ進んではならない');
      assert.ok(calls.some((c) => c.label === 'green-fix#1'), 'validate-diff#1 throw 後は green-fix#1 へ進むべき');
    },
  },
  'base-rerun#1': {
    config: DF_BASE_FAILING,
    policy: 'continue',
    reason: 'failOpenAgent経由。base再実行の結果が無ければENVにせずgreen-fixの対象に残す（green要件を緩めない）',
    extra: async ({ calls }) => {
      assert.ok(calls.some((c) => c.label === 'green-fix#1'), 'base-rerun#1 throw 後は green-fix#1 へ進むべき');
    },
  },
  'pr-review-lite': { config: DF_LITE, policy: 'abort', reason: 'bare据え置き。lite経路のレビュー呼び出し失敗は吸収機構がない' },
  'ci-check-lite': { config: DF_LITE, policy: 'continue', reason: 'failOpenAgent経由。lite経路のCI状態取得失敗はフルpr-iterateへ委譲するのみ' },
  'cross-repo-artifacts': { config: DF_CROSS_REPO, policy: 'abort', reason: 'bare据え置き。cross-repo成果物検証失敗のfail-open化は別issueの検討対象' },
  'journal-log-failure': {
    config: DF_CROSS_REPO,
    policy: 'continue',
    reason: 'runJournalHandoff内のtry/catchで吸収しsave_failedを返すfail-open経路（failure telemetry）',
    extra: async ({ result }) => {
      assert.equal(result?.status, 'cross_repo_artifact', "journal-log-failure throw 後の result.status が cross_repo_artifact でない");
      assert.equal(result?.journal_log_status, 'save_failed', "journal-log-failure throw 時は journal_log_status が 'save_failed' になるべき");
    },
  },
  'journal-log-abort': {
    config: DF_JOURNAL_ABORT_BASE,
    policy: 'continue-in-abort',
    reason: 'runJournalHandoff内のtry/catchで吸収し元のabortエラーをそのまま再throwするfail-open経路',
  },
};

for (const [label, spec] of Object.entries(EXPECTED_DEV_FLOW)) {
  test(`dev-flow.js: label '${label}' の agent throw は ${spec.policy}`, async () => {
    assert.ok(spec.reason.length >= 20, `EXPECTED_DEV_FLOW['${label}'].reason が 20 字未満`);
    const { result, error, calls } = await runDevFlowThrow(spec.config, label);
    assert.ok(calls.some((c) => c.label === label), `label '${label}' が config で到達していない（throw 注入が空振り — config か EXPECTED の stale entry を見直す）`);
    if (spec.policy === 'continue') {
      assert.equal(error, null, `label '${label}' の throw は継続するべきだが run が abort した: ${error?.message}`);
      assert.equal(typeof result, 'object', `label '${label}' 継続後の result が object でない`);
    } else if (spec.policy === 'abort') {
      assert.ok(error, `label '${label}' の throw は run を abort させるべきだが継続した`);
      assert.match(error.message, /injected/, `label '${label}' の abort error message に 'injected' が含まれない: ${error?.message}`);
      const thrownIdx = calls.findIndex((c) => c.label === label);
      assert.ok(thrownIdx !== -1, `label '${label}' の call 自体が記録されていない`);
      assert.ok(
        calls.slice(thrownIdx + 1).some((c) => c.label?.startsWith('journal-')),
        `label '${label}' の throw 後に abort handoff（label が 'journal-' で始まる call）が見つからない`,
      );
    } else if (spec.policy === 'needs_clarification') {
      assert.equal(error, null, `label '${label}' は throw を吸収し needs_clarification で終端するべき: ${error?.message}`);
      assert.equal(result?.status, 'needs_clarification', `label '${label}' throw 後の result.status が needs_clarification でない: ${result?.status}`);
      assert.ok(!calls.some((c) => c.label?.startsWith('plan#')), `label '${label}' throw 後に plan# 系 call が呼ばれている（needs_clarification で中断されていない）`);
    } else if (spec.policy === 'continue-in-abort') {
      // journal-log-abort 専用: 呼び出し元は既に abort 中（config 自体が別要因で throw する）。
      // このラベル自身の throw が「元の abort error」を上書きせず（runJournalHandoff の
      // try/catch で吸収される）、config 側の throw message がそのまま表面化することを検証する。
      assert.ok(error, `label '${label}' は abort 中の base 設定を前提とするため error が必要`);
      assert.ok(
        !/injected/.test(error.message),
        `label '${label}' 自身の throw（'injected'）が abort error として表面化した（fail-open で吸収されるべき）: ${error.message}`,
      );
    } else {
      assert.fail(`未知の policy: ${spec.policy}`);
    }
    if (spec.extra) await spec.extra({ result, error, calls });
  });
}

// ── 未分類 label 検出（新規 call site の分類強制。issue #605）────────────
// configs は本ファイル固有の baseline（DF_B1〜DF_B5 / DF_DANGER）に加え、
// DEV_FLOW_SCENARIOS（exec-proxy-routing と共有する到達 scenario
// 集合）の全 scenario を含める（issue #605 review, PR #645）。観測範囲はこの configs 集合が
// 到達する label に限られる — dev-flow.js の bare trackedAgent( 出現を静的に全走査するわけではない。
test('dev-flow.js: 本ファイルの baseline + DEV_FLOW_SCENARIOS 全 scenario で観測される label は EXPECTED_DEV_FLOW に登録されている', async () => {
  const configs = [DF_B1, DF_B2, DF_B5, DF_DANGER, DF_CLOSES, ...Object.values(DEV_FLOW_SCENARIOS)];
  const observed = new Set();
  for (const config of configs) {
    const { calls } = await runDevFlowBaseline(config);
    for (const c of calls) observed.add(c.label);
  }
  const missing = [...observed].filter((l) => !(l in EXPECTED_DEV_FLOW));
  assert.equal(
    missing.length,
    0,
    `未分類の label が ${missing.length} 件: ${JSON.stringify(missing)}。\n` +
    `新規 call site は以下いずれかで解消すること:\n` +
    `  1. need() で包む（契約 null/throw は run を中断）\n` +
    `  2. failOpenAgent(...) 経由にする（throw を fail-open で吸収）\n` +
    `  3. この EXPECTED_DEV_FLOW に policy と reason（20 字以上）を登録する`,
  );
});

// ── 参照 sanity（走査ズレ検出）────────────────────────────────────
test("dev-flow.js baseline（B1）に 'isolation-probe' / 'impl:serial:issue-1' / 'post-summary' が含まれる（走査ズレ検出）", async () => {
  const { calls } = await runDevFlowBaseline(DF_B1);
  const labels = calls.map((c) => c.label);
  assert.ok(labels.includes('isolation-probe'), "baseline に 'isolation-probe' が無い");
  // Plan phase は無く、合成 plan のみ（issue #673 / #678）— Implement の spawn label 'impl:serial:issue-1' で走査ズレを検出する。
  assert.ok(labels.includes('impl:serial:issue-1'), "baseline に 'impl:serial:issue-1' が無い");
  assert.ok(labels.includes('post-summary'), "baseline に 'post-summary' が無い");
});

// ============================================================
// pr-iterate.js baseline 設定
// ============================================================
// B1: 既定 run（review#1 が approve を返し 1 round で lgtm）。
const PR_B1 = { overrides: {} };
// B2: review#1 が request-changes → fix#1 → commit-ensure#1 → review#2 が approve で lgtm。
const PR_B2 = {
  overrides: {
    'review#1': () => ({ decision: 'request-changes', issues: [{ severity: 'critical', description: 'x', suggestion: 'y' }], summary: 'nope' }),
    'review#2': { decision: 'approve', issues: [], summary: 'ok now' },
  },
};
// B3: fix#1 が null → fix-null-retry（fix#1-retry）が applied を返して commit-ensure#1 → review#2 approve。
const PR_B3 = {
  overrides: {
    ...PR_B2.overrides,
    'fix#1': null,
    'fix#1-retry': { applied: true, files: [], summary: 'fixed on retry' },
  },
};
// B4: review#1 が null → schema-retry（review#1-schema-retry）が approve を返して lgtm。
const PR_B4 = {
  overrides: {
    'review#1': null,
    'review#1-schema-retry': { decision: 'approve', issues: [], summary: 'ok on schema retry' },
  },
};
// B5: fix#1 / fix#1-retry とも null → fix_failed 終端 → worktree-dirty-check（非 lgtm 終端の advisory probe）。
const PR_B5 = {
  overrides: {
    'review#1': PR_B2.overrides['review#1'],
    'fix#1': null,
    'fix#1-retry': null,
    'worktree-dirty-check': { dirty: false, files: 0 },
  },
};
// B6: review#1 が approve（既定）→ ci_gate で ci-check#1 が pending → script 側 poll ループが
// ci-wait-check#1.2（待機 + 再判定の 1 spawn。slept:true）で passed になり lgtm。
const PR_B6 = {
  overrides: {
    'ci-check#1': { status: 'pending', passed: 0, failed: 0, pending: 1, skipped: 0, failed_checks: [] },
    'ci-wait-check#1.2': { slept: true, status: 'passed', passed: 1, failed: 0, pending: 0, skipped: 0, failed_checks: [] },
  },
};
// B7: review 開始時の head（pr-meta の head_sha）が分かる round で review#1 と並列に起動した ci-check#1 の
// head_sha が不一致 → 結果を採らず review の後に ci-check#1-serial を直列で起動し直す（issue #806）。
const PR_B7 = {
  overrides: {
    'pr-meta': {
      url: 'https://github.com/acme/skills/pull/5', head_ref: 'feature/x', base_ref: 'main',
      cwd: '/tmp/wt', epoch: 999, head_sha: 'a'.repeat(40),
    },
    'ci-check#1': { status: 'passed', passed: 1, failed: 0, pending: 0, skipped: 0, failed_checks: [], head_sha: 'b'.repeat(40) },
  },
};

// B8: LGTM 前の mergeable が CONFLICTING → conflict-resolve#1（自動解消できず merge 前に戻す）→ lgtm（issue #916）。
const PR_B8 = {
  overrides: {
    'mergeable-check#1': { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' },
    'conflict-resolve#1': { fetched: true, pushed: false, result: { status: 'aborted', reason: 'unsupported_conflict', files: [{ path: 'a.txt', type: 'content' }] } },
  },
};

async function runPrIterateBaseline(config) {
  const { ctx, calls } = makePrIterateSandbox({ args: '5', overrides: config.overrides });
  const { result, error } = await runWorkflowCapture(prIterateSrc, ctx, '.claude/workflows/pr-iterate.js');
  return { result, error, calls };
}

async function runPrIterateThrow(config, label) {
  const overrides = { ...(config.overrides ?? {}), [label]: THROW };
  const { ctx, calls } = makePrIterateSandbox({ args: '5', overrides });
  const { result, error } = await runWorkflowCapture(prIterateSrc, ctx, '.claude/workflows/pr-iterate.js');
  return { result, error, calls };
}

// pr-iterate.js の全 bare trackedAgent( call site はローカル try/catch 包囲（issue #437/#520）。
// failOpenAgent 経由の呼び出しと合わせ、throw 起因の abort は無い（need() 包みが 0 件のため）。
const EXPECTED_PR_ITERATE = {
  'pr-meta': { config: PR_B1, policy: 'continue', reason: 'failOpenAgent経由。cwd/epoch取得失敗はfallbackするadvisory信号' },
  'isolation-cleanup': { config: PR_B1, policy: 'continue', reason: 'failOpenAgent経由。cleanup失敗はprobe成立に影響しないfail-open' },
  'isolation-probe': { config: PR_B1, policy: 'continue', reason: 'failOpenAgent経由。probe自体の失敗はfail-open（診断できないだけ）' },
  'review#1': { config: PR_B1, policy: 'continue', reason: 'callReviewAgent内try/catchで吸収しschema-retryへ倒すfail-safe経路' },
  'ci-check#1': { config: PR_B1, policy: 'continue', reason: 'failOpenAgent経由。throw/nullはstatus:errorに合成しci_errorへ流す' },
  'post-summary': { config: PR_B1, policy: 'continue', reason: 'failOpenAgent経由。投稿失敗はfail-openでgate判定に影響しない' },
  'journal-log': { config: PR_B1, policy: 'continue', reason: 'runJournalHandoff内try/catchで吸収するfail-open経路' },
  'fix#1': { config: PR_B2, policy: 'continue', reason: 'callFixAgent内try/catchで吸収しnull-retryへ倒すfail-safe経路' },
  'commit-ensure#1': { config: PR_B2, policy: 'continue', reason: 'try/catchで吸収しfix_failedエスカレーションへ倒すfail-safe経路' },
  'review#2': { config: PR_B2, policy: 'continue', reason: 'callReviewAgent内try/catchで吸収しschema-retryへ倒すfail-safe経路' },
  'ci-check#2': { config: PR_B2, policy: 'continue', reason: 'failOpenAgent経由。throw/nullはstatus:errorに合成しci_errorへ流す' },
  // ── issue #605 review（PR #645）: retry 系 / 非 lgtm 終端の call site ──
  'fix#1-retry': { config: PR_B3, policy: 'continue', reason: 'callFixAgent内try/catchで吸収しnullとしてfix_failed終端へ倒すfail-safe経路（fix-null-retry）' },
  'review#1-schema-retry': { config: PR_B4, policy: 'continue', reason: 'callReviewAgent内try/catchで吸収しnullとしてreview_contract_error終端へ倒すfail-safe経路' },
  'worktree-dirty-check': { config: PR_B5, policy: 'continue', reason: 'failOpenAgent経由。非lgtm終端のdirty検出はadvisory telemetryでunknownへ倒すfail-open' },
  // ── issue #663 / #805: CI gate の script 側 poll ループ（2 回目以降は待機 + 判定の 1 spawn）──
  'ci-wait-check#1.2': { config: PR_B6, policy: 'continue', reason: 'failOpenAgent経由。待機+再判定 proxy の throw/null は slept:true 不成立として積算せず ci_pending 終端へ流す（run は abort しない）' },
  // ── issue #806: review と並列に取った ci-check を採れなかった round の直列再取得 ──
  'ci-check#1-serial': { config: PR_B7, policy: 'continue', reason: 'failOpenAgent経由。throw/nullはstatus:errorに合成しci_errorへ流す（ci-check#1 と同じ fail-open）' },
  // ── issue #916: LGTM 前の base conflict の確認と自動解消 ──
  'mergeable-check#1': { config: PR_B1, policy: 'continue', reason: 'failOpenAgent経由。throw/nullはconflict不明として自動解消を試みずlgtmへ進むfail-open' },
  'mergeable-check#2': { config: PR_B2, policy: 'continue', reason: 'failOpenAgent経由。throw/nullはconflict不明として自動解消を試みずlgtmへ進むfail-open' },
  'conflict-resolve#1': { config: PR_B8, policy: 'continue', reason: 'failOpenAgent経由。throw/nullはproxy_failedとして記録し自動解消せずlgtmへ（Merge tierがconflictをHOLD）' },
  // ── issue #1063: LGTM 前の敵対的 security review（対象判定 + security-reviewer）──
  'security-scope#1': { config: PR_B1, policy: 'continue', reason: 'failOpenAgent経由。throw/nullは対象として扱い、diffが無いのでreviewできずsecurity_unresolvedで終端（LGTMにしない）' },
  'security-scope#2': { config: PR_B2, policy: 'continue', reason: 'failOpenAgent経由。throw/nullは対象として扱い、diffが無いのでreviewできずsecurity_unresolvedで終端（LGTMにしない）' },
  'security-review#1': { config: PR_B1, policy: 'continue', reason: 'securityGate内try/catchで吸収し結果なし（no_result）としてsecurity_unresolvedで終端（LGTMにしない）' },
  'security-review#2': { config: PR_B2, policy: 'continue', reason: 'securityGate内try/catchで吸収し結果なし（no_result）としてsecurity_unresolvedで終端（LGTMにしない）' },
};

for (const [label, spec] of Object.entries(EXPECTED_PR_ITERATE)) {
  test(`pr-iterate.js: label '${label}' の agent throw は ${spec.policy}`, async () => {
    assert.ok(spec.reason.length >= 20, `EXPECTED_PR_ITERATE['${label}'].reason が 20 字未満`);
    const { result, error, calls } = await runPrIterateThrow(spec.config, label);
    assert.ok(calls.some((c) => c.label === label), `label '${label}' が config で到達していない（throw 注入が空振り — config か EXPECTED の stale entry を見直す）`);
    assert.equal(error, null, `label '${label}' の throw は継続するべきだが run が abort した: ${error?.message}`);
    assert.equal(typeof result, 'object', `label '${label}' 継続後の result が object でない`);
  });
}

test('pr-iterate.js: 全 baseline で観測される label は EXPECTED_PR_ITERATE に登録されている', async () => {
  const configs = [PR_B1, PR_B2, PR_B3, PR_B4, PR_B5, PR_B6, PR_B7, PR_B8];
  const observed = new Set();
  for (const config of configs) {
    const { calls } = await runPrIterateBaseline(config);
    for (const c of calls) observed.add(c.label);
  }
  const missing = [...observed].filter((l) => !(l in EXPECTED_PR_ITERATE));
  assert.equal(
    missing.length,
    0,
    `未分類の label が ${missing.length} 件: ${JSON.stringify(missing)}。\n` +
    `新規 call site は以下いずれかで解消すること:\n` +
    `  1. need() で包む（契約 null/throw は run を中断）\n` +
    `  2. failOpenAgent(...) 経由にする（throw を fail-open で吸収）\n` +
    `  3. この EXPECTED_PR_ITERATE に policy と reason（20 字以上）を登録する`,
  );
});

test("pr-iterate.js baseline に 'pr-meta' / 'isolation-probe' が含まれる（走査ズレ検出）", async () => {
  const { calls } = await runPrIterateBaseline(PR_B1);
  const labels = calls.map((c) => c.label);
  assert.ok(labels.includes('pr-meta'), "baseline に 'pr-meta' が無い");
  assert.ok(labels.includes('isolation-probe'), "baseline に 'isolation-probe' が無い");
});

// ── fail-closed（throw ではない）行: isolation-probe が written:false を返す ──
test("pr-iterate.js: isolation-probe が {written:false} を返すと throw し message に isoWt（pr-meta の cwd）を含む", async () => {
  const { ctx } = makePrIterateSandbox({ args: '5', overrides: { 'isolation-probe': { written: false, error: 'x' } } });
  const { result, error } = await runWorkflowCapture(prIterateSrc, ctx, '.claude/workflows/pr-iterate.js');
  assert.equal(result, null, 'isolation-probe written:false は run を abort させるべき');
  assert.ok(error, 'isolation-probe written:false は throw するべき');
  assert.ok(error.message.includes('/tmp/wt'), `throw message に isoWt（pr-meta の既定 cwd '/tmp/wt'）が含まれない: ${error.message}`);
});

// ── drift pin: dev-flow/references/exec-proxy.md の diff-hash 行 ↔ 実装 ──────
test('dev-flow/references/exec-proxy.md の diff-hash 行は失敗検出に agent throw を挙げ、fail-open にする', () => {
  const rulesPath = join(HERE, '..', 'dev-flow', 'references', 'exec-proxy.md');
  const rulesSrc = readFileSync(rulesPath, 'utf8');
  const diffHashLine = rulesSrc.split('\n').find((line) => line.startsWith('| diff-hash<br>'));
  assert.ok(diffHashLine, 'dev-flow/references/exec-proxy.md に `| diff-hash<br>` で始まる行が見つからない');
  const cols = diffHashLine.split('|').map((c) => c.trim());
  // cols[0] は空文字（先頭 `|` の前）、cols[1] は proxy と label、cols[2] が失敗検出セル、cols[3] がポリシー
  const failureDetectionCell = cols[2];
  assert.ok(
    failureDetectionCell && failureDetectionCell.includes('agent throw'),
    `diff-hash 行の失敗検出セルに 'agent throw' が含まれない: ${JSON.stringify(failureDetectionCell)}`,
  );
  assert.ok(cols[3]?.startsWith('fail-open'), `diff-hash 行のポリシーが fail-open でない: ${JSON.stringify(cols[3])}`);
});
