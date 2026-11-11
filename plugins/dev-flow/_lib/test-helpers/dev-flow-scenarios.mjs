/**
 * dev-flow-scenarios.mjs — dev-flow.js の各経路へ到達させる最小 override の共有定義
 *
 * exec-proxy-routing.test.mjs（label→agentType の網羅観測）と
 * tracked-agent-failure-policy.test.mjs（到達 label の失敗ポリシー分類）が同じ scenario 集合を
 * 使う。新しい exec-proxy label / 経路を dev-flow.js に足したら、ここに到達 scenario を足す
 * （exec-proxy-routing の「EXPECTED 全 label 到達」assert が未登録を検出する）。
 *
 * makeDevFlowSandbox は dev-flow.js と pr-iterate 後の工程の workflow（dev-flow-finalize.js）をつないで実行するので、
 * Final reconcile / Merge tier の label も同じ override で届く（chainStageWorkflows）。
 *
 * 各 scenario: { overrides, workflow?, extra?, expectError? }
 *   overrides   — makeDevFlowSandbox の label 単位 override
 *   workflow    — nested pr-iterate の workflow() stub（省略時は lgtm / fixes_applied:0）
 *   extra       — makeDevFlowSandbox の extra（args.setup.analyze を差し替える scenario が使う）
 *   expectError — run が throw で終端することを期待する scenario（abort / empty-diff）
 */

import { mergeTierFacts, STANDARD_FILES, shapeOverrides, analyzeArgs, devFlowArgs, prerunAnalyze } from './vm-sandbox.mjs';

// 実効 shape は realized diff の file 数で決まる（issue #676）: complex は shapeOverrides('complex')（realized 7 件）、
// micro（lite）は danger-grep の files を空にする。
const AC2 = [
  { ac_index: 0, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
  { ac_index: 1, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
];

// evaluator が test 実証 AC を返す（redgreen の経路に入る）
const REDGREEN_EVAL = {
  verdict: 'pass', total: 100, threshold: 80, feedback: [], feedback_level: 'implementation',
  ac_results: [
    { ac_index: 0, satisfied: true, verified_by: 'test', evidence: 'ok', test_files: ['t.test.mjs'], impl_files: ['src/x.ts'] },
    { ac_index: 1, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
  ],
  security_clearance: [], concern_resolutions: [],
};

const VISUAL_SNAPSHOTS = { command: 'pnpm test:visual', db: { engine: 'postgres', version: '17' }, env: 'E2E_EXTERNAL_DATABASE_URL', timeout_seconds: 900, paths: ['tests/visual'] };

export const DEV_FLOW_SCENARIOS = {
  baseline: {},
  // diff-gate が空 → diff-gate-retry
  'diff-gate-retry': {
    overrides: { 'diff-gate': { hash: 'H', empty: true }, 'diff-gate-retry': { hash: 'H2', empty: false } },
  },
  // eval hash と PR hash の不一致 → tree-diff-numstat（Merge tier は merge-tier-facts の head_tree が eval と一致で再収束）
  'hash-mismatch': {
    overrides: {
      'diff-hash-pr': { hash: 'BBB', empty: false },
      'tree-diff-numstat': { ok: true, files: ['docs/a.md (+0/-500)'] },
      'merge-tier-facts': mergeTierFacts({ tree: 'AAA' }),
    },
  },
  // Merge tier で merge-tier-facts の diffhash が diff-triage と不一致 → facts の risk / changed で再判定
  'merge-rescan': { overrides: { 'merge-tier-facts': mergeTierFacts({ hash: 'CCC' }) } },
  // pr-iterate が fix を適用 → Final reconcile 経路（reconcile-sync / test#final / *-final）
  'final-reconcile': {
    overrides: {
      'reconcile-sync': { ok: true, head: 'deadbeef' },
      'changed-files-final': { files: [...STANDARD_FILES] },
    },
    workflow: async () => ({ status: 'lgtm', iterations: 2, fixes_applied: 1 }),
  },
  // Validate が tests:'error'（起動失敗）+ fixes_applied=0（Final reconcile skipped）→ merge tier HOLD
  // （validate_tests_not_run）・終端サマリーのテスト欄は未実行・未検証（issue #707 / #1168）
  'validate-tests-error': {
    overrides: {
      'test#1': { tests: 'error', green: false, summary: 'pnpm failed to start. No tests executed.' },
      'pr#1': { pr_url: 'http://x', pr_number: 1, committed: true, head_sha: 'a'.repeat(40) },
    },
  },
  // evaluator が test 実証 AC を返す → redgreen（1 spawn バッチ。results[k].index は prompt のペア順）
  redgreen: {
    overrides: {
      'eval#1': REDGREEN_EVAL,
      redgreen: { results: [{ index: 0, red: true, green: true, reason: 'ok', testcmd_ran: true }] },
    },
  },
  // start が running → wait で結果（issue #1226。stop は呼ばない）
  'redgreen-wait': {
    overrides: {
      'eval#1': REDGREEN_EVAL,
      redgreen: { status: 'running', results: [] },
      'redgreen-wait#1': { results: [{ index: 0, red: true, green: true, reason: 'ok', testcmd_ran: true }] },
    },
  },
  // wait の応答が読めない → stop（issue #1226）
  'redgreen-stop': {
    overrides: {
      'eval#1': REDGREEN_EVAL,
      redgreen: { status: 'running', results: [] },
      'redgreen-wait#1': null,
      'redgreen-stop': { ok: true, stopped: true, was_running: true },
    },
  },
  // dev-implementer が CI で検証可能な環境事象を concern に返す → ENV item → merge-tier-facts の checks で CI 委譲
  'ci-checks': {
    overrides: {
      'impl:serial:issue-1': {
        status: 'DONE', task_id: 'issue-1', files: [...STANDARD_FILES], summary: 's',
        concerns: ['sandbox 内で next build が TurbopackInternalError で失敗した'],
      },
      'merge-tier-facts': mergeTierFacts({ checks: [{ name: 'build', bucket: 'pass' }] }),
    },
  },
  // complex（realized 7 files）: eval#1 critical → reimpl#1（dev-implementer へ fix_feedback 付き差し戻し）→ eval#2 pass
  'complex-fix': {
    overrides: {
      ...shapeOverrides('complex'),
      'eval#1': {
        verdict: 'fail', total: 5, threshold: 7,
        feedback: [{ severity: 'critical', topic: 'X', description: '重大欠陥', suggestion: '修正せよ' }],
        feedback_level: 'implementation', ac_results: AC2, security_clearance: [],
      },
      'eval#2': {
        verdict: 'pass', total: 9, threshold: 7, feedback: [], feedback_level: 'implementation',
        ac_results: AC2, security_clearance: [],
        critical_resolutions: [{ id: 'EVAL-1-X', resolved: true, evidence: 'src/x.ts で修正済み' }],
      },
    },
  },
  // complex-fix + reimpl 後の PR 前テストが red → green-fix#post-eval-1 → test#post-eval-2 green →
  // green-fix 差分の再評価（green-fix-classify → green-fix-numstat → eval-green-fix）。評価済み tree を BBB へ進める
  'post-eval-green-fix': {
    overrides: {
      ...shapeOverrides('complex'),
      'eval#1': {
        verdict: 'fail', total: 5, threshold: 7,
        feedback: [{ severity: 'critical', topic: 'X', description: '重大欠陥', suggestion: '修正せよ' }],
        feedback_level: 'implementation', ac_results: AC2, security_clearance: [],
      },
      'eval#2': {
        verdict: 'pass', total: 9, threshold: 7, feedback: [], feedback_level: 'implementation',
        ac_results: AC2, security_clearance: [],
        critical_resolutions: [{ id: 'EVAL-1-X', resolved: true, evidence: 'src/a.ts で修正済み' }],
      },
      'test#post-eval-1': { tests: 'failed', green: false, summary: 'foo.test が red' },
      'green-fix#post-eval-1': { status: 'DONE', task_id: 'issue-1', files: ['tests/foo.test.ts'], summary: 'テストの import 漏れを直した', concerns: [] },
      'green-fix-classify': { risk: { ok: true, hits: [] }, files: ['tests/foo.test.ts'], diffhash: { hash: 'BBB', empty: false } },
      'green-fix-numstat': { ok: true, lines: ['1\t0\ttests/foo.test.ts'] },
      'eval-green-fix': { findings: [], recheck_resolutions: [{ id: 'EVAL-1-X', resolution: 'resolved', evidence: 'src/a.ts:3 の修正は green-fix 後の tree にも残っている' }] },
      'diff-hash-pr': { hash: 'BBB', empty: false },
      'merge-tier-facts': mergeTierFacts({ hash: 'BBB', tree: 'BBB' }),
    },
  },
  // pr-iterate fix 適用 + LLM 判断の解消済み concern → fix-diff-numstat → Final AC reconcile で再検証
  'final-recheck': {
    overrides: {
      'impl:serial:issue-1': { status: 'DONE', task_id: 'issue-1', files: [...STANDARD_FILES], summary: 's', concerns: ['src/x.ts の境界条件が未確認'] },
      'eval#1': {
        verdict: 'pass', total: 100, threshold: 80, feedback: [], feedback_level: 'implementation',
        ac_results: AC2, security_clearance: [],
        concern_resolutions: [{ id: 'CONCERN-1', resolution: 'resolved', evidence: 'src/x.ts:10 で境界条件を確認済み' }],
      },
      'reconcile-sync': { ok: true, head: 'a'.repeat(40) },
      'changed-files-final': { files: [...STANDARD_FILES] },
      'fix-diff-numstat': { ok: true, lines: ['2\t1\tsrc/x.ts'] },
    },
    workflow: async () => ({ status: 'lgtm', iterations: 2, fixes_applied: 1 }),
  },
  // Validate red → green-fix#1 → test#2 green
  'green-fix': { overrides: { 'test#1': { tests: 'failed', green: false, summary: 'assert mismatch' } } },
  // Validate red（diff と無関係のテストファイル）→ validate-diff#1（diff 一覧）→ base-rerun#1（base でも同じように落ちる）
  // → ENV として green 要件から外し green-fix なしで Diff triage へ
  'base-failing': {
    overrides: {
      'test#1': { tests: 'failed', green: false, summary: 'plugins/x/scripts/a.bats が red', failed_files: ['plugins/x/scripts/a.bats'] },
      'validate-diff#1': { ok: true, lines: [...STANDARD_FILES] },
      'base-rerun#1': { results: [{ file: 'plugins/x/scripts/a.bats', ran: true, base_failed: true, same_failure: true, summary: 'same' }] },
    },
  },
  // Merge tier の merge-tier-facts が PR body の Closes 欠落を報告 → closes-reinject（再投入 + 同じ spawn で再取得。issue #824）
  'closes-reinject': {
    overrides: { 'merge-tier-facts': mergeTierFacts({ closes: false }) },
  },
  // clean micro lite route（realized 0 files → micro。pr-review-lite + ci-check-lite で lgtm 終端、nested pr-iterate 起動なし）
  lite: {
    overrides: {
      'danger-grep': { risk: { ok: true, hits: [] }, files: [], diffhash: null },
      'ci-check-lite': { status: 'passed', passed: 1, failed: 0, pending: 0, skipped: 0, failed_checks: [], waited_seconds: 0, poll_attempts: 0 },
    },
  },
  // Analyze のゲート（comment_conflicts 非空）→ analyze-clarify#1（dev-runner）1 spawn → needs_clarification
  // （isolation-probe / dev-implementer / PR は 0 件。writeFailureTelemetry 経由の failure handoff。issue #690）
  'analyze-clarify': {
    extra: { args: analyzeArgs(1, { analyze_path: 'jev', jev_reasons: ['comments present (1)'], comment_count: 1, comment_conflicts: ['conflict: comment #1 by alice（OWNER, 2026-01-01T00:00:00Z）: hmm'] }) },
  },
  // ci の AC + repo の local_verify 宣言 → Validate green 後に local-verify start / wait / stop（dev-runner-haiku。issue #863）
  'local-verify': {
    overrides: {
      'local-verify-start#1': { ok: true, status: 'running', log_path: '/tmp/wt/.devflow-tmp/local-verify/logs/command.log' },
      'local-verify-wait#1.1': { ok: true, status: 'passed', exit_code: 0, log_path: '/tmp/wt/.devflow-tmp/local-verify/logs/command.log', log_tail: 'ok', db_deleted: true },
      'local-verify-stop#1': { ok: true, stopped: false, was_running: false, db_deleted: true },
    },
    extra: {
      args: devFlowArgs(1, {
        analyze: prerunAnalyze({ acceptance_criteria: ['tenant ID を持たない query を拒否する', '`pnpm test:e2e:local` で tenant-isolation.spec.ts が通る'] }),
        ci_verify: { label: 'full-ci', checks: ['e2e'], commands: ['pnpm test:e2e:local'], wait_ceiling_seconds: 1500 },
        local_verify: { command: 'pnpm test:e2e:local', db: { engine: 'postgres', version: '17' }, env: 'E2E_EXTERNAL_DATABASE_URL', timeout_seconds: 1500 },
      }),
    },
  },
  // local-verify が 1 回失敗 → 差し戻し後は実行前に tree の hash を取り直す（diff-hash-local-verify#2）。
  // Final reconcile で最終 tree の hash を取り（diff-hash-local-verify-final）、exit 0 を出した tree と突き合わせる
  'local-verify-reimpl': {
    overrides: {
      'local-verify-start#1': { ok: true, status: 'running', log_path: '/tmp/wt/.devflow-tmp/local-verify/logs/command.log' },
      'local-verify-wait#1.1': { ok: false, status: 'failed', exit_code: 1, log_path: '/tmp/wt/.devflow-tmp/local-verify/logs/command.log', log_tail: 'fail', db_deleted: true },
      'local-verify-stop#1': { ok: true, stopped: false, was_running: false, db_deleted: true },
      'local-verify-start#2': { ok: true, status: 'running', log_path: '/tmp/wt/.devflow-tmp/local-verify/logs/command.log' },
      'local-verify-wait#2.1': { ok: true, status: 'passed', exit_code: 0, log_path: '/tmp/wt/.devflow-tmp/local-verify/logs/command.log', log_tail: 'ok', db_deleted: true },
      'local-verify-stop#2': { ok: true, stopped: false, was_running: false, db_deleted: true },
    },
    extra: {
      args: devFlowArgs(1, {
        analyze: prerunAnalyze({ acceptance_criteria: ['tenant ID を持たない query を拒否する', '`pnpm test:e2e:local` で tenant-isolation.spec.ts が通る'] }),
        ci_verify: { label: 'full-ci', checks: ['e2e'], commands: ['pnpm test:e2e:local'], wait_ceiling_seconds: 1500 },
        local_verify: { command: 'pnpm test:e2e:local', db: { engine: 'postgres', version: '17' }, env: 'E2E_EXTERNAL_DATABASE_URL', timeout_seconds: 1500 },
      }),
    },
  },
  // repo の visual_snapshots 宣言 → Evaluate の各評価の前に tree を取り（diff-hash-snapshot#1）、local-verify start / wait / stop で
  // 基準画像を撮り直す。評価の後に PR の差分で変わった PNG の一覧を取る（visual-snapshots-list。issue #1410）
  'visual-snapshots': {
    overrides: {
      'visual-snapshots-start#1': { ok: true, status: 'running', log_path: '/tmp/wt/.devflow-tmp/visual-snapshots/logs/command.log' },
      'visual-snapshots-wait#1.1': {
        ok: true, status: 'passed', exit_code: 0, log_path: '/tmp/wt/.devflow-tmp/visual-snapshots/logs/command.log', log_tail: 'ok', db_deleted: true,
        snapshot: { tree_before: 'AAA', tree: 'AAA', discarded: false, restored: null, outside: [], outside_count: 0 },
      },
      'visual-snapshots-stop#1': { ok: true, stopped: false, was_running: false, db_deleted: true },
      'visual-snapshots-list': { ok: true, lines: ['tests/visual/home.png'] },
    },
    extra: { args: devFlowArgs(1, { visual_snapshots: VISUAL_SNAPSHOTS }) },
  },
  // 撮影の応答に終了後の tree が無い（proxy の応答が無い）→ tree を取り直す（diff-hash-snapshot-after#1）
  'visual-snapshots-lost': {
    overrides: { 'visual-snapshots-list': { ok: true, lines: [] } },
    extra: { args: devFlowArgs(1, { visual_snapshots: VISUAL_SNAPSHOTS }) },
  },
  // cross-repo ラベル + 外部 repo の dirty 成果物 → graceful 終了（issue-labels / cross-repo-artifacts）
  'cross-repo': {
    overrides: {
      'diff-gate': { hash: 'EMPTY', empty: true },
      'issue-labels': { ok: true, labels: ['cross-repo'] },
      'impl:serial:issue-1': { status: 'DONE', task_id: 'issue-1', files: ['/tmp/other-repo/bar.ts'], summary: 's', concerns: [] },
      'cross-repo-artifacts': { ok: true, found: 1, artifacts: [{ path: '/tmp/other-repo/bar.ts', exists: true, repo_root: '/tmp/other-repo', dirty: true }] },
    },
  },
  // empty-diff で fail-fast → writeFailureTelemetry（journal-log-failure）
  'empty-diff': {
    overrides: { 'diff-gate': { hash: 'H', empty: true }, 'diff-gate-retry': { hash: 'H', empty: true }, 'issue-labels': null },
    expectError: true,
  },
  // PR phase で throw（need() 経由の非 fail-open call site）→ top-level abort handoff（journal-log-abort）。
  // Evaluate の throw は dev-flow-evaluate の throw として親が HOLD で受けるので abort にならない
  abort: { overrides: { 'pr#1': () => { throw new Error('injected'); } }, expectError: true },
};
