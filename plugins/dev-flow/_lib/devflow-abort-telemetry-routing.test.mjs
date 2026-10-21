// top-level abort handoff のルーティングテスト（issue #607）。
// dev-flow.js の run 本体を包む top-level try/catch が、handoff 到達前の throw（plan-review /
// evaluate / Setup 段の agent throw、および empty-diff throw との二重記録回避）で
// buildAbortHandoffPayload の単一形（outcome:'failure' + error_category:'abort'）の journal entry
// を 1 件残し、fail-open（handoff 自体の失敗が元の例外の rethrow を妨げない）であることを
// VM sandbox で検証する。makeSandbox / runDevFlowInSandbox は devflow-failure-telemetry-routing
// test.mjs の パターンを踏襲し、throwAt / journalLogAbortThrows / journal-log-abort stub を追加する。
// PR phase の失敗（pr#<issue> の中断応答）は abort にせず、throw しない failure 終端
// （error_category: pr_phase_failed）で返り値と journal に成果物・所要時間・回収手順を残す（(8)、issue #823）。

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

// ---- VM sandbox helpers ----

const REALIZED_FILES = ['src/a.ts', 'src/b.ts', 'src/c.ts'];

function makeSandbox({
  analyzeReq, implementerFn, diffGateConfig, throwAt, journalLogAbortThrows, journalLogAbortResult,
  workflowThrows, args, prResponse,
} = {}) {
  const calls = [];
  let implementerCallIndex = 0;
  const { gateEmpty = false, retryEmpty = false } = diffGateConfig || {};

  const agentStub = async (prompt, opts) => {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';
    calls.push({ label, agentType, prompt: String(prompt ?? '') });

    if (throwAt && label === throwAt.label) throw throwAt.error;

    if (label === 'issue-meta') return { ok: true, number: 1, title: analyzeReq?.issue_title ?? 'stub-issue-title' };
    if (label.startsWith('analyze')) return analyzeReq;
    // Security floor 統合 exec-proxy: realized 3 件（dev-implementer の申告と一致 → 宣言外 0 件）。
    // 実効 shape は realized 3 件 + AC 数で決まる（issue #676）: AC 2 → standard、AC 7 → complex。
    if (label.startsWith('danger-grep')) return { risk: { ok: true, hits: [] }, files: [...REALIZED_FILES], struct: null, diffhash: null };
    if (label === 'changed-files') return { files: ['src/foo.ts'] };
    if (label.startsWith('test')) return { tests: 'no_tests', green: true, summary: '' };
    if (label.startsWith('redgreen')) return { red: false, green: false, reason: 'stub' };
    if (agentType === 'dev-flow:evaluator') {
      return {
        verdict: 'pass', total: 100, threshold: 80,
        feedback: [], feedback_level: 'implementation', ac_results: [], security_clearance: [],
      };
    }
    if (label === 'pr#1' && prResponse !== undefined) return prResponse;
    if (label.startsWith('pr')) return { pr_url: 'http://x', pr_number: 1, committed: true };
    if (label === 'post-summary') return { posted: true, method: 'gh pr comment', url: 'http://x' };
    if (label === 'journal-log' && agentType === 'dev-flow:dev-runner-haiku') return { saved: true, logged: true };
    if (label === 'journal-log-failure') return { saved: true, logged: true };
    if (label === 'journal-log-abort') {
      if (journalLogAbortThrows) throw new Error('journal-log-abort boom');
      return journalLogAbortResult !== undefined ? journalLogAbortResult : { saved: true, logged: true };
    }
    if (label === 'diff-gate') return { hash: gateEmpty ? 'EMPTY' : 'H', empty: gateEmpty };
    if (label === 'diff-gate-retry') return { hash: retryEmpty ? 'EMPTY' : 'H', empty: retryEmpty };
    if (label.startsWith('diff-hash')) return { hash: 'H', empty: false };
    if (agentType === 'dev-flow:dev-implementer') {
      const fn = implementerFn ?? (() => ({
        status: 'DONE', task_id: 'issue-1', files: [...REALIZED_FILES], summary: '', concerns: [],
        blocking_reason: null, missing_context: null,
      }));
      const result = fn(implementerCallIndex);
      implementerCallIndex++;
      return result;
    }
    return null;
  };

  const parallelStub = async (fns) => Promise.all((fns || []).map((f) => f()));
  const workflowStub = async (name) => {
    calls.push({ label: `workflow:${name}`, agentType: '', prompt: '' });
    if (workflowThrows) throw workflowThrows;
    return { status: 'lgtm', iterations: 1, fixes_applied: 0 };
  };

  const sandbox = {
    phase: () => {}, log: () => {}, agent: agentStub, parallel: parallelStub,
    pipeline: async (items, cb) => Promise.all((items || []).map(async (item, i) => { try { const r = await cb(item, i); return r === undefined ? null : r; } catch { return null; } })),
    workflow: workflowStub, args: args ?? devFlowArgs('1'),
    console, JSON, Math, String, Number, Boolean, Array, Object, Error,
    RegExp, Promise, Symbol, Map, Set, Date,
  };

  const ctx = vm.createContext(sandbox);
  return { ctx, calls };
}

async function runDevFlowInSandbox(src, ctx) {
  const stripped = src
    .replace(/^export\s+const\s+/gm, 'const ')
    .replace(/^export\s+function\s+/gm, 'function ');
  const wrapped = `(async () => {\n${stripped}\n})();`;

  let caughtError = null;
  let result = null;
  try {
    const promise = vm.runInContext(wrapped, ctx, { filename: '.claude/workflows/dev-flow.js' });
    if (promise && typeof promise.then === 'function') {
      result = await promise.catch((e) => { caughtError = e; return null; });
    }
  } catch (e) {
    caughtError = e;
  }
  return { error: caughtError, result };
}

const src = readFileSync(devFlowPath, 'utf8');

// AC 7 件 → realized 数に関わらず complex
const COMPLEX_ANALYZE_REQ = {
  summary: 's',
  acceptance_criteria: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
  issue_type: 'feat',
  scope: 'src',
  issue_number: 1,
  issue_title: 'stub-issue-title',
};

// AC 2 件 + realized 3 件（REALIZED_FILES）→ standard
const STANDARD_ANALYZE_REQ = {
  summary: 's',
  acceptance_criteria: ['ac1', 'ac2'],
  issue_type: 'feat',
  scope: 'src',
  issue_number: 1,
  issue_title: 'stub-issue-title',
};

// ============================================================
// (1) Validate（need() で包まれた diff-gate proxy）で throw
// ============================================================
test('[abort-telemetry] (1) Validate で diff-gate proxy が throw → abort entry 1 件（diff-gate / shape キー欠落（実効 shape 確定前））', async () => {
  const { ctx, calls } = makeSandbox({
    analyzeReq: COMPLEX_ANALYZE_REQ,
    throwAt: { label: 'diff-gate', error: new Error('proxy boom') },
  });
  const { error } = await runDevFlowInSandbox(src, ctx);

  assert.ok(error !== null, '(1) diff-gate throw で workflow が abort すべきだが error が null だった');
  assert.ok(String(error?.message ?? '').includes('proxy boom'),
    `(1) error.message に 'proxy boom' を含むべきだが: ${error?.message}`);

  // abort handoff は payload を pending/ へ直接書く journal-log-abort の 1 spawn（issue #807）。
  assert.equal(calls.filter((c) => c.label === 'journal-save').length, 0, '(1) journal-save spawn は起動しない');
  const saveCalls = calls.filter((c) => c.label === 'journal-log-abort' && c.agentType === 'dev-flow:dev-runner-haiku');
  assert.equal(saveCalls.length, 1, `(1) journal-log-abort は 1 回のはずだが ${saveCalls.length} 回だった`);

  const savePrompt = saveCalls[0]?.prompt ?? '';
  for (const key of [
    '"skill":"dev-flow"', '"outcome":"failure"', '"error_category":"abort"',
    '"error_msg":"abort@Validate/diff-gate: proxy boom"', '"error_phase":"Validate"',
    '"plugin_version"', '"eval_model_config":"opus"',
  ]) {
    assert.ok(savePrompt.includes(key),
      `(1) journal-log-abort prompt に '${key}' が含まれるべきだが含まれていなかった。prompt:\n${savePrompt.slice(0, 800)}`);
  }
  // phase/label は error_phase と error_msg に載る。telemetry には複製しない（残すキー以外を書かない）。
  for (const key of ['"abort_phase"', '"abort_label"', '"eval_iter"', '"gate_policy"', '"subagent_invocations"']) {
    assert.ok(!savePrompt.includes(key),
      `(1) journal-log-abort prompt に削除済み telemetry キー '${key}' が含まれていた。prompt:\n${savePrompt.slice(0, 800)}`);
  }
  // 実効 shape は Security floor（realized diff 取得後）で確定する（issue #676）。Validate の abort は確定前なので
  // shape キーを載せない。
  assert.ok(!savePrompt.includes('"shape"'),
    `(1) 実効 shape 確定前の abort では journal-log-abort prompt に '"shape"' キーを含むべきではないが含まれていた。prompt:\n${savePrompt.slice(0, 800)}`);
  assert.ok(savePrompt.includes('~/.claude/journal/pending/devflow-1-effect-'),
    `(1) journal-log-abort prompt に pending パスが含まれるべきだが含まれていなかった。prompt:\n${savePrompt.slice(0, 800)}`);
  assert.ok(!savePrompt.includes('.devflow-tmp'),
    `(1) journal-log-abort prompt は payload の一時ファイルを経由してはならない。prompt:\n${savePrompt.slice(0, 800)}`);

  const failureCalls = calls.filter((c) => c.label === 'journal-log-failure');
  assert.equal(failureCalls.length, 0, `(1) journal-log-failure は 0 回のはずだが ${failureCalls.length} 回だった`);
});

// ============================================================
// (2) Evaluate で evaluator が throw
// ============================================================
test('[abort-telemetry] (2) Evaluate で evaluator が throw → abort entry 1 件（eval#1 / shape:standard（実効））', async () => {
  const { ctx, calls } = makeSandbox({
    analyzeReq: STANDARD_ANALYZE_REQ,
    throwAt: { label: 'eval#1', error: new Error('evaluator boom') },
  });
  const { error } = await runDevFlowInSandbox(src, ctx);

  assert.ok(error !== null, '(2) evaluator throw で workflow が abort すべきだが error が null だった');
  assert.ok(String(error?.message ?? '').includes('evaluator boom'),
    `(2) error.message に 'evaluator boom' を含むべきだが: ${error?.message}`);

  const saveCalls = calls.filter((c) => c.label === 'journal-log-abort' && c.agentType === 'dev-flow:dev-runner-haiku');
  assert.equal(saveCalls.length, 1, `(2) journal-log-abort は 1 回のはずだが ${saveCalls.length} 回だった`);

  const savePrompt = saveCalls[0]?.prompt ?? '';
  for (const key of [
    '"error_msg":"abort@Evaluate/eval#1: evaluator boom"', '"error_phase":"Evaluate"',
    '"shape":"standard"',
  ]) {
    assert.ok(savePrompt.includes(key),
      `(2) journal-log-abort prompt に '${key}' が含まれるべきだが含まれていなかった。prompt:\n${savePrompt.slice(0, 800)}`);
  }
});

// ============================================================
// (3) Setup（WT 未確定）で worktree agent が throw
// ============================================================
test('[abort-telemetry] (3) Setup で args.setup.ok が false → WT 未確定でも pending/ へ直接書き shape キー欠落', async () => {
  const { ctx, calls } = makeSandbox({
    analyzeReq: STANDARD_ANALYZE_REQ,
    args: devFlowArgs(1, { ok: false, base_error: 'prerun boom' }),
  });
  const { error } = await runDevFlowInSandbox(src, ctx);

  assert.ok(error !== null, '(3) args.setup.ok:false で workflow が abort すべきだが error が null だった');

  const saveCalls = calls.filter((c) => c.label === 'journal-log-abort' && c.agentType === 'dev-flow:dev-runner-haiku');
  assert.equal(saveCalls.length, 1, `(3) journal-log-abort は 1 回のはずだが ${saveCalls.length} 回だった`);

  // 書き込み先は worktree に依存しない pending/ パスなので、WT 未確定でも退避先を別に用意しない。
  const savePrompt = saveCalls[0]?.prompt ?? '';
  assert.ok(savePrompt.includes('~/.claude/journal/pending/devflow-1-effect-'),
    `(3) journal-log-abort prompt に pending パスが含まれるべきだが含まれていなかった。prompt:\n${savePrompt.slice(0, 800)}`);
  assert.ok(!savePrompt.includes('abort-payload'),
    `(3) journal-log-abort prompt は payload の退避ファイルを経由してはならない。prompt:\n${savePrompt.slice(0, 800)}`);
  assert.ok(savePrompt.includes('abort@Setup/prerun-setup: dev-flow: args.setup.ok が true でない'),
    `(3) journal-log-abort prompt に error_msg が含まれるべきだが含まれていなかった。prompt:\n${savePrompt.slice(0, 800)}`);
  assert.ok(!savePrompt.includes('"shape"'),
    `(3) shape 未確定のため journal-log-abort prompt に '"shape"' キーを含むべきではないが含まれていた。prompt:\n${savePrompt.slice(0, 800)}`);
  assert.ok(savePrompt.includes('"plugin_version"'),
    `(3) journal-log-abort prompt に '"plugin_version"' が含まれるべきだが含まれていなかった。prompt:\n${savePrompt.slice(0, 800)}`);
});

// ============================================================
// (4) fail-open: journal-log-abort 自体が throw しても元の例外は変わらない
// ============================================================
test('[abort-telemetry] (4) fail-open: journal-log-abort stub が throw しても元の例外(proxy boom)を rethrow する', async () => {
  const { ctx, calls } = makeSandbox({
    analyzeReq: COMPLEX_ANALYZE_REQ,
    throwAt: { label: 'diff-gate', error: new Error('proxy boom') },
    journalLogAbortThrows: true,
  });
  const { error } = await runDevFlowInSandbox(src, ctx);

  assert.ok(error !== null, '(4) error が null だった');
  assert.ok(String(error?.message ?? '').includes('proxy boom'),
    `(4) handoff 自体の失敗で元の例外が置き換わってはならないが: ${error?.message}`);

  const logCalls = calls.filter((c) => c.label === 'journal-log-abort');
  assert.equal(logCalls.length, 1, `(4) journal-log-abort は 1 回のはずだが ${logCalls.length} 回だった`);
});

// ============================================================
// (5) 二重記録なし: empty_diff 経路（writeFailureTelemetry 後に throw）
// ============================================================
test('[abort-telemetry] (5) empty_diff throw は writeFailureTelemetry が記録済みのため abort entry を二重記録しない', async () => {
  const { ctx, calls } = makeSandbox({
    analyzeReq: { ...STANDARD_ANALYZE_REQ, issue_type: 'fix' },
    diffGateConfig: { gateEmpty: true, retryEmpty: true },
  });
  const { error } = await runDevFlowInSandbox(src, ctx);

  assert.ok(error !== null, '(5) empty-diff gate で throw すべきだが error が null だった');
  assert.ok(String(error?.message ?? '').includes('empty-diff gate'),
    `(5) error.message に 'empty-diff gate' を含むべきだが: ${error?.message}`);

  const logAbortCalls = calls.filter((c) => c.label === 'journal-log-abort');
  assert.equal(logAbortCalls.length, 0, `(5) journal-log-abort は 0 回のはずだが ${logAbortCalls.length} 回だった`);

  const logFailureCalls = calls.filter((c) => c.label === 'journal-log-failure');
  assert.equal(logFailureCalls.length, 1, `(5) journal-log-failure は 1 回のはずだが ${logFailureCalls.length} 回だった`);
});

// ============================================================
// (6) 完走経路（回帰）
// ============================================================
test('[abort-telemetry] (6) 完走経路: journal-log-abort が 0 回・journal-log が 1 回・journal_log_status===logged', async () => {
  const { ctx, calls } = makeSandbox({ analyzeReq: { ...STANDARD_ANALYZE_REQ, acceptance_criteria: ['ac1', 'ac2', 'ac3'] } });
  const { error, result } = await runDevFlowInSandbox(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  const logAbortCalls = calls.filter((c) => c.label === 'journal-log-abort');
  assert.equal(logAbortCalls.length, 0, `(6) 完走経路では journal-log-abort は 0 回のはずだが ${logAbortCalls.length} 回だった`);

  const logCalls = calls.filter((c) => c.label === 'journal-log' && c.agentType === 'dev-flow:dev-runner-haiku');
  assert.equal(logCalls.length, 1, `(6) journal-log は 1 回のはずだが ${logCalls.length} 回だった`);

  assert.equal(result?.journal_log_status, 'logged',
    `(6) 完走経路では result.journal_log_status は 'logged' のはずだが ${JSON.stringify(result?.journal_log_status)} だった`);
});

// ============================================================
// (7) nested pr-iterate（workflow('dev-flow:pr-iterate-run')）が throw
// ============================================================
test('[abort-telemetry] (7) nested workflow(pr-iterate) が throw → abort entry の error_msg / error_phase は直前 trackedAgent でなく pr-iterate を指す', async () => {
  const { ctx, calls } = makeSandbox({
    analyzeReq: { ...STANDARD_ANALYZE_REQ, acceptance_criteria: ['ac1', 'ac2', 'ac3'] },
    workflowThrows: new Error('pr-iterate boom'),
  });
  const { error } = await runDevFlowInSandbox(src, ctx);

  assert.ok(error !== null, '(7) nested workflow throw で dev-flow run が abort すべきだが error が null だった');
  assert.ok(String(error?.message ?? '').includes('pr-iterate boom'),
    `(7) error.message に 'pr-iterate boom' を含むべきだが: ${error?.message}`);

  const saveCalls = calls.filter((c) => c.label === 'journal-log-abort' && c.agentType === 'dev-flow:dev-runner-haiku');
  assert.equal(saveCalls.length, 1, `(7) journal-log-abort は 1 回のはずだが ${saveCalls.length} 回だった`);

  const savePrompt = saveCalls[0]?.prompt ?? '';
  for (const key of [
    '"error_msg":"abort@PR/pr-iterate: pr-iterate boom"', '"error_phase":"PR"',
  ]) {
    assert.ok(savePrompt.includes(key),
      `(7) journal-log-abort prompt に '${key}' が含まれるべきだが含まれていなかった（直前 trackedAgent の label が残っている可能性）。prompt:\n${savePrompt.slice(0, 800)}`);
  }
});

// ============================================================
// (8) PR phase 失敗（issue #823）: pr#1 の中断応答は throw せず failure 終端で run を終える
// ============================================================
function handoffPayload(prompt) {
  const m = prompt.match(/<<<JOURNAL_HANDOFF_BODY_BEGIN>>>\n([\s\S]*?)\n<<<JOURNAL_HANDOFF_BODY_END>>>/);
  assert.ok(m, `journal handoff prompt に delimiter が無い:\n${prompt.slice(0, 500)}`);
  return JSON.parse(m[1]);
}

const PUSH_REASON = "error: failed to push some refs to 'github.com:o/r.git'";
const PR_PUSH_FAILED = {
  pr_url: '', pr_number: 0, committed: true, head_sha: 'b'.repeat(40),
  failed_step: 'push', failure_reason: PUSH_REASON, push_header: 'pr-push: exit=1 log=/tmp/wt/.devflow-tmp/push-output.log', epoch: 1300,
};

test('[abort-telemetry] (8) PR phase 失敗: throw せず、返り値に error_category / failed_step / failure_reason / committed / head_sha / branch / phase_durations / shape / eval_verdict が載る', async () => {
  const { ctx } = makeSandbox({ analyzeReq: STANDARD_ANALYZE_REQ, prResponse: PR_PUSH_FAILED });
  const { error, result } = await runDevFlowInSandbox(src, ctx);

  assert.equal(error, null, `(8) PR phase 失敗で run が throw した: ${error?.message}`);
  assert.equal(result?.status, 'pr_phase_failed');
  assert.equal(result.error_category, 'pr_phase_failed');
  assert.equal(result.failed_step, 'push');
  assert.equal(result.failure_reason, PUSH_REASON);
  assert.equal(result.committed, true);
  assert.equal(result.head_sha, 'b'.repeat(40));
  assert.equal(result.branch, 'feature/issue-1');
  assert.equal(result.worktree, '/tmp/wt');
  assert.equal(result.push_log, '/tmp/wt/.devflow-tmp/push-output.log');
  assert.equal(result.shape, 'standard');
  assert.equal(result.eval_verdict, 'pass');
  // start=1000（args.setup.epoch）・setup_end=1050・pr_end=end=1300（pr#1 の epoch）
  assert.equal(JSON.stringify(result.phase_durations), JSON.stringify({ pr: 250 }));
  assert.equal(result.duration_seconds, 300);
  assert.equal(result.journal_log_status, 'logged');
});

test('[abort-telemetry] (8) PR phase 失敗: 回収コマンドは committed に応じて決まり、issue コメント本文に失敗段・理由・回収コマンドが載る', async () => {
  const { ctx } = makeSandbox({ analyzeReq: STANDARD_ANALYZE_REQ, prResponse: PR_PUSH_FAILED });
  const { result } = await runDevFlowInSandbox(src, ctx);
  const cmds = result.recovery_commands;
  assert.equal(cmds[0], 'git push origin HEAD', `push 失敗（commit 済み）は push から: ${JSON.stringify(cmds)}`);
  assert.ok(cmds[1].startsWith('gh pr create --draft --body-file .devflow-tmp/pr-body.md --base main --head feature/issue-1 --title "'), cmds[1]);
  assert.equal(cmds[2], '/pr-iterate <N>');
  assert.equal(cmds.length, 3);
  for (const s of ['step: push', PUSH_REASON, '/tmp/wt/.devflow-tmp/push-output.log', 'git push origin HEAD', '/pr-iterate <N>', '.devflow-tmp/pr-body.md', 'b'.repeat(40)]) {
    assert.ok(result.issue_comment.includes(s), `issue_comment に '${s}' が無い:\n${result.issue_comment}`);
  }

  const { ctx: ctx2 } = makeSandbox({
    analyzeReq: STANDARD_ANALYZE_REQ,
    prResponse: { pr_url: '', pr_number: 0, committed: false, head_sha: '', failed_step: 'commit', failure_reason: 'fatal: index.lock' },
  });
  const { error: error2, result: result2 } = await runDevFlowInSandbox(src, ctx2);
  assert.equal(error2, null, `(8) commit 失敗で run が throw した: ${error2?.message}`);
  assert.equal(result2.failed_step, 'commit');
  assert.equal(result2.committed, false);
  assert.ok(!('head_sha' in result2), `head_sha が取れなかった run に head_sha キーがある: ${result2.head_sha}`);
  assert.ok(!('push_log' in result2), 'commit 失敗に push_log が載っている');
  assert.deepEqual([...result2.recovery_commands.slice(0, 3)], ['git add -A', 'git commit -F .devflow-tmp/commit-msg.txt', 'git push origin HEAD']);
});

test('[abort-telemetry] (8) PR phase 失敗: abort entry ではなく outcome=failure / error_category=pr_phase_failed の handoff を 1 件書き、nested pr-iterate・Merge tier・終端サマリは実行しない', async () => {
  const { ctx, calls } = makeSandbox({ analyzeReq: STANDARD_ANALYZE_REQ, prResponse: PR_PUSH_FAILED });
  await runDevFlowInSandbox(src, ctx);

  assert.equal(calls.filter((c) => c.label === 'journal-log-abort').length, 0, '(8) abort entry が書かれた');
  const failureCalls = calls.filter((c) => c.label === 'journal-log-failure');
  assert.equal(failureCalls.length, 1, `(8) journal-log-failure は 1 回のはずだが ${failureCalls.length} 回だった`);
  const payload = handoffPayload(failureCalls[0].prompt);
  assert.equal(payload.skill, 'dev-flow');
  assert.equal(payload.outcome, 'failure');
  assert.equal(payload.error_category, 'pr_phase_failed');
  assert.equal(payload.error_phase, 'PR');
  assert.ok(payload.error_msg.startsWith(`dev-flow: PR phase 失敗（step: push、reason: ${PUSH_REASON}、push 出力全文: /tmp/wt/.devflow-tmp/push-output.log）`), payload.error_msg);
  assert.equal(payload.telemetry.shape, 'standard');
  assert.equal(payload.telemetry.eval_verdict, 'pass');
  assert.deepEqual(payload.telemetry.phase_durations, { pr: 250 });
  assert.equal(payload.telemetry.duration_seconds, 300);

  for (const label of ['closes-reinject', 'workflow:dev-flow:pr-iterate-run', 'merge-tier-facts', 'post-summary', 'journal-log']) {
    assert.equal(calls.filter((c) => c.label === label).length, 0, `(8) PR 失敗後に ${label} が呼ばれた`);
  }
  // push / PR 作成は pr#1 の 1 spawn だけで、run 内で再試行しない（#804 / #819）
  assert.equal(calls.filter((c) => c.label.startsWith('pr#')).length, 1, '(8) pr#<issue> が再 spawn された');
});

// (9) ABORT_CTX 宣言 / try 開始位置 / failure_recorded / 末尾 catch+rethrow の静的 pin は撤去した（issue #636）。
// Setup 段の abort は (3)、failure_recorded による二重記録防止は (5)、rethrow は (1)(4) が VM 挙動で担保する。
