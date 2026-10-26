// issue #371 F2 / issue #443 F7: dev-flow.js の duration telemetry 配線を検証する実行ベース統合テスト。
// devflow-journal-log.test.mjs の makeSandbox / runDevFlowCapture / ANALYZE_REQ を同型コピーし
// (repo precedent はテストごとの helper 複製)、agentStub に専用 clock# probe 分岐と
// 給電（feedClockMark）対象 label への optional epoch 付与を追加する。
//
// issue #443: 専用 clock probe は当初 clockProbe('start') / clockProbe('end') の 2 回のみに削減され、
// 残りの mark（setup_end/implement_end/validate_end/evaluate_end/pr_end/iterate_end/final_end）は
// prerun 応答（setup_end = args.setup.epoch_end）と隣接する既存 exec-proxy / agent 応答の optional `epoch`
// フィールドから feedClockMark() 経由で給電される（recordClockMark の fail-open 契約は不変）。
//
// issue #550 F1/F3（2 段更新の最終段）: clockProbe('start') は F1 で、clockProbe('end') は F3 で
// それぞれ廃止された。専用 clock probe は 0 回になり、start mark は Setup 冒頭の setup-base probe
// の optional epoch、end mark は Merge tier 末尾の post-summary 応答の optional epoch から
// feedClockMark() 経由で給電される。
//
// epochMode='ok'   : clock# probe と、給電対象の各 stub 応答が epoch を単調増加で返す
//                     → journal-log prompt に duration_seconds/phase_durations が現れる。
// epochMode='fail' : clock# probe は null、他 stub は epoch フィールドを省略する（fail-open）
//                     → journal-log prompt に duration_seconds/phase_durations が現れず、
//                       result.merge_tier は正常に返る（AC-3 fail-open 検証）。

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

// ---- VM sandbox helpers（devflow-journal-log.test.mjs の makeSandbox / runDevFlowCapture と同型）----

/**
 * duration telemetry 検証専用の VM sandbox を組む。
 * epochMode='ok' なら clock# probe と給電対象 stub 応答に epoch を単調増加で付与する。
 * epochMode='fail' なら clock# probe は null、他 stub は epoch を省略する（fail-open 経路）。
 *
 * @param {object} analyzeReq - analyze フェーズの agent が返す req オブジェクト（SHAPE を決定する）
 * @param {'ok'|'fail'} epochMode - epoch 給電モード
 * @returns {{ ctx: vm.Context, getJournalPrompts: () => string[], getClockCalls: () => string[] }}
 */
function makeSandbox(analyzeReq, epochMode) {
  const journalPrompts = [];
  const clockCalls = []; // clock# probe の起動 label を発火順に記録（AC-1 の決定論検証用）
  const implEpochs = []; // implementer 応答に付与した epoch（implement_end の給電値）
  // devFlowArgs（vm-sandbox.mjs）の args.setup.epoch_end=1050 より後から単調増加させる
  // （setup_end は PRERUN.epoch_end から給電されるため、それ以降の給電値が setup_end
  // より小さいと phase_durations.implement が負の diff で欠落する）。
  let epoch = 1050;

  // 給電対象 stub 応答へ epoch を単調増加で付与する（fail モードでは何もしない = epoch 省略）。
  function withEpoch(obj) {
    if (epochMode === 'fail') return obj;
    epoch += 10;
    return { ...obj, epoch };
  }

  const agentStub = async (prompt, opts) => {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';

    // clock#*（issue #443 / #550 F1+F3）: 専用 clock probe は 0 回になった
    // （clock#start は F1 で、clock#end は F3 で撤去済み — start mark は setup-base probe
    // （issue #550 案1: resolve-base + worktree-base-check 統合 probe）、end mark は post-summary
    // 応答の optional epoch からそれぞれ給電される）。この分岐は防御的に残すが到達しないはずで、
    // AC-1 は getClockCalls() が常に空配列であることを検証する。
    if (label.startsWith('clock#')) {
      clockCalls.push(label);
      if (epochMode === 'fail') return null;
      epoch += 10;
      return { ok: true, epoch };
    }
    // Setup(setup-base): base 解決 + 既存 worktree 起点検証 統合 probe（issue #298, #517, #550 案1）。
    // start mark の給電元（専用 clock#start probe は廃止、epoch は optional）。
    if (label === 'setup-base') {
      return withEpoch({
        ok: true, default_branch: 'main', dev_exists: true, requested_exists: false,
        worktree_exists: false, upstream_remote: '', upstream_merge: '',
      });
    }
    if (label === 'worktree') {
      return { worktree: '/tmp/wt', branch: 'feature/issue-1', repo: 'acme/skills' };
    }
    // worktree-deps: 旧 analyze 開始 mark の給電元（issue #443。issue #641 で撤去済み、防御的に残す）
    if (label === 'worktree-deps') {
      return withEpoch({ status: 'no_dependencies' });
    }
    // Setup 末尾の analyze ゲートは args.setup.analyze から REQ を組み spawn しない（issue #690）。
    // setup_end は args.setup.epoch_end から給電され implement 区間の起点になる（issue #695）。
    // implement_end は dev-implementer 呼び出しの epoch から給電される。
    // Diff triage / Merge tier: danger-grep 系（label が 'danger-grep' で始まる）
    // → danger clean にして HOLD 要因を発生させない（給電対象ではない）
    if (label.startsWith('danger-grep')) {
      return { ok: true, hits: [] };
    }
    // Validate: test runner（label が 'test' で始まる。validate_end の給電元候補）
    if (label.startsWith('test')) {
      return withEpoch({ tests: 'no_tests', green: true, summary: '' });
    }
    // Evaluate: evaluator stub（evaluate_end の給電元）
    if (agentType === 'dev-flow:evaluator') {
      return withEpoch({
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
      });
    }
    // redgreen-verify は呼ばれないはずだが念のため（verified_by:'inspection' で回避）
    if (agentType === 'dev-flow:dev-runner-haiku' && label.startsWith('redgreen')) {
      return { red: false, green: false };
    }
    // PR: label が 'pr' で始まる（pr_end の給電元）
    if (label.startsWith('pr')) {
      return withEpoch({ pr_url: 'https://github.com/acme/skills/pull/1', pr_number: 1, committed: true });
    }
    // Merge tier: changed-files
    // → docs/test-only でないファイルを返す（AUTO 除外。給電対象ではない）
    if (label === 'changed-files') {
      return { files: ['src/foo.ts'] };
    }
    // post-summary（issue #550 F3）: posted:true 固定 + end mark の給電元
    // （専用 clock#end probe 撤去に伴い、post-summary 応答の optional epoch から
    // feedClockMark('end', ...) へ給電される）。
    if (label === 'post-summary') {
      return withEpoch({ posted: true, method: 'gh pr comment', url: 'http://x' });
    }
    // journal-log: 実際の telemetry payload はここに載る（issue #807: pending/ へ直接書く 1 spawn）。
    // prompt を捕捉し {saved:true, logged:true} を返す。
    if (label === 'journal-log' && agentType === 'dev-flow:dev-runner-haiku') {
      journalPrompts.push(prompt);
      return { saved: true, logged: true };
    }
    // implementer（implement_end の給電元）。給電した epoch を記録し、phase_durations.implement の
    // 起点が setup_end（args.setup.epoch_end）であることを検証する（issue #695）。
    if (agentType === 'dev-flow:dev-implementer') {
      const res = withEpoch({ status: 'DONE', task_id: 't', files: [], summary: '', concerns: [] });
      if (typeof res.epoch === 'number') implEpochs.push(res.epoch);
      return res;
    }
    // diff-gate / diff-hash（issue #215）: need() による throw の回避（validate_end の給電元候補）
    if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) {
      return withEpoch({ hash: 'H', empty: false });
    }
    // reconcile-sync / test#final は fixes_applied=0（本テストの workflowStub）では Final reconcile
    // 自体が skip されるため呼ばれない想定だが、final_end 給電網羅性のため epoch を用意しておく。
    if (label === 'reconcile-sync') {
      return withEpoch({ ok: true, head: 'deadbeef' });
    }
    // デフォルト: 未知の label は null を返す
    return null;
  };

  const parallelStub = async (fns) => Promise.all((fns || []).map((f) => f()));
  // workflowStub: dev-flow.js の nested workflow('pr-iterate') 呼び出し（iterate_end の給電元）。
  // fixes_applied:0 で Final reconcile を skip させ（issue #443 の edge case: final キー欠落を検証）、
  // end_epoch から iterate_end を feedClockMark() へ給電する。
  const workflowStub = async () => {
    if (epochMode === 'fail') return { status: 'lgtm', fixes_applied: 0 };
    epoch += 10;
    return { status: 'lgtm', fixes_applied: 0, end_epoch: epoch };
  };

  const logLines = []; // recordClockMark の fail-open 警告（⚠️ clock#<mark>）を検出するため log を捕捉
  const sandbox = {
    phase: () => {},
    log: (msg) => { logLines.push(String(msg)); },
    agent: agentStub,
    parallel: parallelStub,
    pipeline: async (items, cb) => Promise.all((items || []).map(async (item, i) => { try { const r = await cb(item, i); return r === undefined ? null : r; } catch { return null; } })),
    workflow: workflowStub,
    args: devFlowArgs('1'),
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
    getJournalPrompts: () => journalPrompts,
    getClockCalls: () => clockCalls,
    getLogLines: () => logLines,
    getImplEpochs: () => implEpochs,
  };
}

// journal-log prompt（handoff JSON を含む）から phase_durations object を取り出す（無ければ null）。
function extractPhaseDurations(prompt) {
  const m = /"phase_durations":(\{[^}]*\})/.exec(prompt);
  return m ? JSON.parse(m[1]) : null;
}

/**
 * dev-flow.js ソースを strip して async IIFE でラップし vm sandbox で実行する。
 * devflow-journal-log.test.mjs の runDevFlowCapture と同型。
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

// standard 経路に落ちる req（count=3, ac=4件, type='feat' → floor='standard'）
// Merge tier phase まで到達させる（Evaluate も実行される）
const ANALYZE_REQ = {
  summary: 's',
  acceptance_criteria: ['a', 'b', 'c', 'd'],
  issue_type: 'feat',
  scope: 'src',
  issue_number: 1,
  issue_title: 'stub-issue-title',
};

const src = readFileSync(devFlowPath, 'utf8');

test('[duration-telemetry] epochMode=ok: clock# 専用 probe は 0 件起動、journal-log prompt に duration_seconds/phase_durations が含まれる（final キーは fixes_applied=0 の Final reconcile skip で欠落する）', async () => {
  const { ctx, getJournalPrompts, getClockCalls, getLogLines, getImplEpochs } = makeSandbox(ANALYZE_REQ, 'ok');

  const { result, error } = await runDevFlowCapture(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }
  assert.ok(result !== null && result !== undefined, `workflow は正常 return するべきだが null/undefined だった（error: ${error?.name}: ${error?.message}）`);

  // start は args.setup.epoch、setup_end は args.setup.epoch_end（いずれも dev-flow-prerun 応答）
  // から給電されるので、epoch 給電が成立するモードでは fail-open 警告が出てはならない。
  // isolation-probe（Write-only agent、epoch なし）から給電すると毎 run 警告 + null になる
  // regression を pin する。
  const clockWarnings = getLogLines().filter((l) => /clock#(start|setup_end)/.test(l));
  assert.deepEqual(
    clockWarnings,
    [],
    `start / setup_end の clock mark は prerun epoch から給電されるべきだが警告が出た: ${JSON.stringify(clockWarnings)}`,
  );

  // AC-1（issue #550 F1+F3 最終更新）: 専用 clock probe（label が 'clock#' で始まる subagent 起動）は
  // 0 件であること。start mark は setup-base probe、end mark は post-summary 応答の optional epoch
  // からそれぞれ feedClockMark() 経由で給電される（専用 probe 呼び出しなし）。
  const clockCalls = getClockCalls();
  assert.equal(
    clockCalls.length,
    0,
    `専用 clock probe（label が 'clock#' で始まる起動）は 0 件であるべきだが ${clockCalls.length} 回だった: ${JSON.stringify(clockCalls)}`,
  );

  const capturedPrompt = getJournalPrompts()[0] ?? '';
  assert.ok(
    /"duration_seconds":\d+/.test(capturedPrompt),
    `journal-log prompt に "duration_seconds":<number> が含まれるべきだが含まれていなかった。prompt:\n${capturedPrompt}`,
  );
  assert.ok(
    capturedPrompt.includes('"phase_durations"'),
    `journal-log prompt に "phase_durations" が含まれるべきだが含まれていなかった。prompt:\n${capturedPrompt}`,
  );
  const phaseDurations = extractPhaseDurations(capturedPrompt);
  assert.ok(phaseDurations, `journal-log prompt から phase_durations を抽出できなかった。prompt:\n${capturedPrompt}`);
  // issue #695: Analyze phase 撤去後、phase_durations に analyze / plan キーは出ない
  for (const key of ['analyze', 'plan']) {
    assert.ok(!(key in phaseDurations), `phase_durations に撤去済みの "${key}" キーが含まれている: ${JSON.stringify(phaseDurations)}`);
  }
  assert.ok(
    Number.isInteger(phaseDurations.implement),
    `journal-log prompt の phase_durations に "implement":<number> が含まれるべきだが含まれていなかった（implement_end は implementer 応答から給電される）。prompt:\n${capturedPrompt}`,
  );
  // issue #695: implement の起点は setup_end = args.setup.epoch_end（devFlowArgs の 1050）。
  // start（args.setup.epoch = 1000）起点だと deps install 相当の 50 秒が implement に混入する。
  const implEnd = Math.max(...getImplEpochs());
  assert.equal(
    phaseDurations.implement,
    implEnd - 1050,
    `phase_durations.implement は implement_end(${implEnd}) − epoch_end(1050) であるべき（start=1000 起点で deps install 時間が混入していないか）: ${JSON.stringify(phaseDurations)}`,
  );
  // Final reconcile は fixes_applied=0（本テストの workflowStub）で skip されるため final_end は
  // 給電されず、phase_durations に 'final' キー自体が欠落する（issue #443 の edge case）。
  assert.ok(
    !capturedPrompt.includes('"final":'),
    `fixes_applied=0（Final reconcile skip）では phase_durations に "final" キーが現れないべきだが含まれていた。prompt:\n${capturedPrompt}`,
  );
});

test('[duration-telemetry] epochMode=fail: clock# 専用 probe は null を返し、他の給電元 stub も epoch を省略する（fail-open）ため journal-log prompt に duration_seconds/phase_durations が現れず、result.merge_tier は正常に返る', async () => {
  const { ctx, getJournalPrompts, getClockCalls } = makeSandbox(ANALYZE_REQ, 'fail');

  const { result, error } = await runDevFlowCapture(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  assert.ok(
    result !== null && result !== undefined,
    `clock probe / 給電元 stub 全滅（fail-open）でも workflow は return object を解決するべきだが null/undefined だった（error: ${error?.name}: ${error?.message}）`,
  );
  assert.ok(
    typeof result?.merge_tier === 'string' && ['HOLD', 'REVIEW', 'AUTO'].includes(result.merge_tier),
    `clock probe / 給電元 stub 全滅でも result.merge_tier は 'HOLD'|'REVIEW'|'AUTO' のいずれかであるべきだが '${result?.merge_tier}' だった`,
  );

  // 専用 clock probe の起動回数自体は epoch 給電の成否に関わらず不変（構造的に 0 件。
  // issue #550 F1+F3 最終更新）。
  const clockCalls = getClockCalls();
  assert.equal(
    clockCalls.length,
    0,
    `epochMode=fail でも専用 clock probe（label が 'clock#' で始まる起動）は 0 件であるべきだが ${clockCalls.length} 回だった: ${JSON.stringify(clockCalls)}`,
  );

  const capturedPrompt = getJournalPrompts()[0] ?? '';
  assert.ok(
    !capturedPrompt.includes('"duration_seconds"'),
    `clock probe / 給電元 stub 全滅時は journal-log prompt に "duration_seconds" が含まれないべきだが含まれていた。prompt:\n${capturedPrompt}`,
  );
  // start / setup_end は args.setup（必須キー）から給電されるが、どちらも phase の終端 mark ではないため
  // phase_durations は空 object になり handoff からキー自体が欠落する（issue #695 で常時 0 の analyze キーを撤去）
  assert.ok(
    !capturedPrompt.includes('"phase_durations"'),
    `clock probe / 給電元 stub 全滅時は journal-log prompt に "phase_durations" が含まれないべきだが含まれていた。prompt:\n${capturedPrompt}`,
  );
});
