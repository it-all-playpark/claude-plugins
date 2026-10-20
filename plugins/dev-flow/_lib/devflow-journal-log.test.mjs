// AC#1 / AC#3 (F2): journal-log VM カウントテスト（issue #203: handoff 方式）
// Merge tier phase 末尾に journal-log dev-runner-haiku 呼び出しが 1 回発生すること、
// prompt が telemetry handoff JSON を pending dir へ書き出す方式（CLI フラグ方式ではない）であること、
// および logged:false stub でも workflow が正常 return することを検証する。
//
// handoff 方式: JS 側で JSON.stringify した telemetry を
// ~/.claude/journal/pending/devflow-<issue>-<ts>.json へ書き出す。
// dotfiles の Stop hook (stop-devflow-telemetry.sh) が journal.sh log へ flush する。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { devFlowArgs } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');

// ---- VM sandbox helpers（devflow-summary-post.test.mjs の makeSandbox / runDevFlowCapture と同型）----

/**
 * journal-log 呼び出し検証専用の VM sandbox を組む。
 * agentStub は opts.label / opts.agentType を見て phase 別に最小スキーマを返す。
 * journal-log stub の戻り値は引数 journalResult で切り替え可能。
 * resolved 値（return object）を捕捉できるよう runner も同型にしている。
 *
 * @param {object} analyzeReq - analyze フェーズの agent が返す req オブジェクト（SHAPE を決定する）
 * @param {object} journalResult - journal-log stub が返すレスポンス（ログ成功/失敗を切り替え）
 * @returns {{ ctx: vm.Context, getJournalCallCount: () => number, getJournalPrompts: () => string[] }}
 */
function makeSandbox(analyzeReq, journalResult, evaluatorOverrides) {
  // journal-log 呼び出しカウンタ（issue #807: payload を pending/ へ直接書く 1 spawn）
  let journalCallCount = 0;
  const journalPrompts = [];

  // agent() stub: opts.label / opts.agentType を見て phase 別に最小スキーマを返す
  const agentStub = async (prompt, opts) => {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';

    // Setup(worktree)
    // Setup(setup-base): base 解決 + 既存 worktree 起点検証 統合 probe（issue #550 案1）
    if (label === 'setup-base') {
      return { ok: true, default_branch: 'main', dev_exists: true, requested_exists: false, worktree_exists: false, upstream_remote: '', upstream_merge: '' };
    }
    if (label === 'worktree') {
      return { worktree: '/tmp/wt', branch: 'feature/issue-1', repo: 'acme/skills' };
    }
    // Analyze: label が 'analyze' で始まる
    if (label.startsWith('analyze')) {
      return analyzeReq;
    }
    // Security floor / Merge tier: danger-grep 系（label が 'danger-grep' で始まる）
    // → danger clean にして HOLD 要因を発生させない
    if (label.startsWith('danger-grep')) {
      return { ok: true, hits: [] };
    }
    // Validate: test runner（label が 'test' で始まる）
    if (label.startsWith('test')) {
      return { tests: 'no_tests', green: true, summary: '' };
    }
    // Evaluate: evaluator stub（最小 pass レスポンス）
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
        ...(evaluatorOverrides ?? {}),
      };
    }
    // redgreen-verify は呼ばれないはずだが念のため（verified_by:'inspection' で回避）
    if (agentType === 'dev-flow:dev-runner-haiku' && label.startsWith('redgreen')) {
      return { red: false, green: false };
    }
    // PR: label が 'pr' で始まる
    if (label.startsWith('pr')) {
      return { pr_url: 'https://github.com/acme/skills/pull/1', pr_number: 1, committed: true };
    }
    // Merge tier: changed-files
    // → docs/test-only でないファイルを返す（AUTO 除外）
    if (label === 'changed-files') {
      return { files: ['src/foo.ts'] };
    }
    // post-summary（dev-runner-haiku）: posted:true 固定
    if (label === 'post-summary' && agentType === 'dev-flow:dev-runner-haiku') {
      return { posted: true, method: 'gh pr comment', url: 'http://x' };
    }
    // journal-log: 実際の telemetry payload はここに載る。呼び出しカウンタをインクリメントし
    // journalResult を返す。journalResult が Error なら throw する（schema 不一致・proxy 実行失敗の再現）。
    if (label === 'journal-log' && agentType === 'dev-flow:dev-runner-haiku') {
      journalCallCount += 1;
      journalPrompts.push(prompt);
      if (journalResult instanceof Error) throw journalResult;
      return journalResult;
    }
    // implementer その他
    if (agentType === 'dev-flow:dev-implementer') {
      return { status: 'DONE', task_id: 't', files: [], summary: '', concerns: [] };
    }
    // diff-gate / diff-hash（issue #215）: need() による throw の回避
    if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) return { hash: 'H', empty: false }
    // issue-meta（issue #451）: analyze provenance 突合 probe
    if (label === 'issue-meta') return { ok: true, number: 1, title: 'stub-issue-title' };
    // デフォルト: 未知の label は null を返す（journal-log が need() で包まれないことを前提）
    return null;
  };

  // parallel() stub: runImplement が parallel(par) を呼ぶため（par が空なら []）
  const parallelStub = async (fns) => Promise.all((fns || []).map((f) => f()));

  // pr-iterate stub: workflow() の呼び出し
  const workflowStub = async () => ({ status: 'lgtm', iterations: 1, fixes_applied: 0 });

  // sandbox object（devflow-summary-post.test.mjs と同一セット）
  const sandbox = {
    // workflow 制御関数
    phase: () => {},
    log: () => {},
    agent: agentStub,
    parallel: parallelStub,
    pipeline: async (items, cb) => Promise.all((items || []).map(async (item, i) => { try { const r = await cb(item, i); return r === undefined ? null : r; } catch { return null; } })),
    workflow: workflowStub,
    // 引数（ISSUE 解決用）
    args: devFlowArgs('1', { repo: 'acme/skills' }),
    // JS 組み込み（devflow-summary-post.test.mjs と同一セット）
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
    getJournalCallCount: () => journalCallCount,
    getJournalPrompts: () => journalPrompts,
  };
}

/**
 * dev-flow.js ソースを strip して async IIFE でラップし vm sandbox で実行する。
 * devflow-summary-post.test.mjs の runDevFlowCapture と同型：
 * IIFE の **resolved 値（return object）を捕捉して返す**。
 *
 * @param {string} src - dev-flow.js の raw ソース
 * @param {vm.Context} ctx - vm コンテキスト
 * @returns {Promise<{ result: object|null, error: Error|null }>}
 */
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

// ============================================================
// テストケース
// ============================================================

// Merge tier phase まで到達させる req（実効 shape は realized diff から決まる。issue #676）
const ANALYZE_REQ = {
  summary: 's',
  acceptance_criteria: ['a', 'b', 'c', 'd'],
  issue_type: 'feat',
  scope: 'src',
  issue_number: 1,
  issue_title: 'stub-issue-title',
};

const src = readFileSync(devFlowPath, 'utf8');

test('[journal-log] AC#1 (issue #807): Merge tier phase 後に journal-log が 1 spawn だけ発生し、その prompt に handoff JSON キーと pending パスが含まれること', async () => {
  const journalResult = { saved: true, logged: true };
  const { ctx, getJournalCallCount, getJournalPrompts } = makeSandbox(ANALYZE_REQ, journalResult);

  const { result, error } = await runDevFlowCapture(src, ctx);

  // ReferenceError / SyntaxError は構造的に壊れているので即 fail させる（sandbox クラッシュ検出）
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  // journal-log 呼び出しカウント === 1（payload の一時ファイルを書く journal-save spawn は無い）
  assert.equal(
    getJournalCallCount(),
    1,
    `journal-log dev-runner-haiku の呼び出しは 1 回であるべきだが ${getJournalCallCount()} 回だった`,
  );

  const savePrompt = getJournalPrompts()[0] ?? '';
  const requiredKeys = [
    '"merge_tier"',
    '"shape"',
    '"route"',
    '"plugin_version"',
    '"skill":"dev-flow"',
    '"outcome":"success"',
    '"journal_sh"',
    '"repo":"acme/skills"',
    '"pr_number":1',
  ];
  for (const key of requiredKeys) {
    assert.ok(
      savePrompt.includes(key),
      `journal-log prompt に '${key}' が含まれるべきだが含まれていなかった。prompt:\n${savePrompt}`,
    );
  }
  assert.ok(
    savePrompt.includes('.claude/journal/pending/devflow-1-effect-'),
    `journal-log prompt に pending パスが含まれるべきだが含まれていなかった。prompt:\n${savePrompt}`,
  );
  // journal-log が {saved:true, logged:true} を返すため result.journal_log_status は 3 値 closed enum のうち 'logged'
  assert.equal(
    result?.journal_log_status,
    'logged',
    `journal-log が logged:true を返す場合 result.journal_log_status は 'logged' のはずだが '${result?.journal_log_status}' だった`,
  );
});

test('[journal-log] AC#3: journal-log stub が saved:true / logged:false を返しても result.merge_tier が正常 return され journal_log_status が log_failed になること', async () => {
  // ログ失敗をシミュレート: Write を試みたが失敗（「記録失敗でも workflow return 成功」仕様の回帰検出）
  const journalResult = { saved: true, logged: false };
  const { ctx } = makeSandbox(ANALYZE_REQ, journalResult);

  const { result, error } = await runDevFlowCapture(src, ctx);

  // ReferenceError / SyntaxError は構造的に壊れているので即 fail させる（sandbox クラッシュ検出）
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  // result が null でなく、throw されていない
  assert.ok(
    result !== null && result !== undefined,
    `ログ失敗（logged:false）でも workflow は return object を解決するべきだが null/undefined だった`,
  );

  // result.merge_tier が文字列（'HOLD'|'REVIEW'|'AUTO' のいずれか）として返ること
  assert.ok(
    typeof result?.merge_tier === 'string' && ['HOLD', 'REVIEW', 'AUTO'].includes(result.merge_tier),
    `ログ失敗でも result.merge_tier は 'HOLD'|'REVIEW'|'AUTO' のいずれかであるべきだが '${result?.merge_tier}' だった`,
  );
  // journal-log が logged:false を返すため result.journal_log_status は 'log_failed'
  assert.equal(
    result?.journal_log_status,
    'log_failed',
    `journal-log が logged:false を返す場合 result.journal_log_status は 'log_failed' のはずだが '${result?.journal_log_status}' だった`,
  );
});

test('[journal-log] AC#4: journal-log が saved:false を返す場合 result.journal_log_status が save_failed になること', async () => {
  const journalResult = { saved: false, logged: false };
  const { ctx, getJournalCallCount } = makeSandbox(ANALYZE_REQ, journalResult);

  const { result, error } = await runDevFlowCapture(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  assert.equal(
    getJournalCallCount(),
    1,
    `journal-log の呼び出しは 1 回であるべきだが ${getJournalCallCount()} 回だった`,
  );
  assert.equal(
    result?.journal_log_status,
    'save_failed',
    `journal-log が saved:false を返す場合 result.journal_log_status は 'save_failed' のはずだが '${result?.journal_log_status}' だった`,
  );
});

// 帰属テスト: journal-log が throw（StructuredOutput 未返却・schema 不一致等）した場合は Write 到達の
// 申告が無いので save_failed に倒れ、run は落ちない（fail-open）。
test('[journal-log] journal-log が throw した場合 run は完走し result.journal_log_status は save_failed（Write 到達の申告なし）', async () => {
  // issue #527/#533: trackedAgent のリトライは `opts.retryOnContractViolation === true` の
  // opt-in call site 限定で、journal-log の call site は opt-in していない
  // ため 'without calling StructuredOutput' を含む throw でもリトライされない。ここでは
  // 意図を明確にするため exec-proxy 実行失敗を示す別メッセージ（call count=1 想定に影響しない）を使う。
  const journalResult = new Error('exec-proxy 実行失敗: EPERM');
  const { ctx, getJournalCallCount } = makeSandbox(ANALYZE_REQ, journalResult);

  const { result, error } = await runDevFlowCapture(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  assert.equal(getJournalCallCount(), 1);
  // fail-open: journal-log の throw は workflow を落とさない
  assert.ok(result != null, 'journal-log の throw で workflow が落ちてはならない（fail-open）');
  assert.equal(
    result?.journal_log_status,
    'save_failed',
    `journal-log throw 時 result.journal_log_status は 'save_failed' のはずだが '${result?.journal_log_status}' だった`,
  );
});

// inline 区間整合: journal handoff の choreography は canonical（_lib/journal-handoff.mjs）の inline 区間にのみ
// 存在し、call site 側に手写しが残っていないこと（否定 pin）。call site の label（journal-log /
// journal-log-failure / journal-log-abort）と handoff の挙動は各 workflow の VM テスト
// （本ファイル / priterate-journal-log.test.mjs）と exec-proxy-routing.test.mjs が観測する。
test.each(['dev-flow.js', 'pr-iterate.js'])('[journal-log] inline 整合: %s の inline 区間外に journal handoff choreography の手写しが残っていない', (file) => {
  const workflowSrc = readFileSync(join(repoRoot, '.claude/workflows', file), 'utf8');
  const anchor = workflowSrc.indexOf('==== END inline: _lib/journal-handoff.mjs ====');
  assert.ok(anchor >= 0, `${file}: journal-handoff inline END marker が見つからない`);
  assert.equal(workflowSrc.indexOf("let journalLogStatus = 'save_failed'", anchor + 1), -1, `${file}: inline 区間外に手写し choreography（journalLogStatus 初期化）が残っている`);
});

// issue #561 AC-3: evaluator が confidence を返すケース/省略するケースの両方で run が abort しない。
// confidence は telemetry に書かない（残す 15 キーに含まれない）。
test('[journal-log] issue #561: evaluator が confidence:0.8 を返す run は abort せず、journal-log prompt に eval_confidence を書かない', async () => {
  const journalResult = { saved: true, logged: true };
  const { ctx, getJournalPrompts } = makeSandbox(ANALYZE_REQ, journalResult, { confidence: 0.8 });

  const { result, error } = await runDevFlowCapture(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }
  assert.ok(result != null, 'evaluator confidence あり run は abort してはならない');

  const savePrompt = getJournalPrompts()[0] ?? '';
  assert.ok(savePrompt.includes('"merge_tier"'), `journal-log prompt に handoff payload が無い。prompt:\n${savePrompt}`);
  assert.ok(
    !savePrompt.includes('"eval_confidence"'),
    `journal-log prompt に削除済み telemetry キー '"eval_confidence"' が含まれていた。prompt:\n${savePrompt}`,
  );
});

test('[journal-log] issue #561: evaluator が confidence を省略する run は abort しない', async () => {
  const journalResult = { saved: true, logged: true };
  const { ctx, getJournalPrompts } = makeSandbox(ANALYZE_REQ, journalResult);

  const { result, error } = await runDevFlowCapture(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }
  assert.ok(result != null, 'evaluator confidence 省略 run は abort してはならない（optional 契約）');
  assert.equal(getJournalPrompts().length, 1, 'confidence 省略 run でも journal-log は 1 回呼ばれる');
});
