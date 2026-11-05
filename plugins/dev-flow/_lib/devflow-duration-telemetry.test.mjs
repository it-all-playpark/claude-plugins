// issue #371 F2 / issue #443 F7: dev-flow.js の duration telemetry 配線を検証する実行ベース統合テスト。
// devflow-journal-log.test.mjs の makeSandbox / runWorkflowCapture を同型コピーし
// (repo precedent はテストごとの helper 複製)、agentStub に
// 給電（feedClockMark）対象 label への optional epoch 付与を追加する。
//
// clock mark は prerun 応答（start = args.setup.epoch、setup_end = args.setup.epoch_end）と、隣接する
// 既存 exec-proxy / agent 応答の optional `epoch` フィールド（end は Merge tier 末尾の post-summary 応答）
// から feedClockMark() 経由で給電される（recordClockMark の fail-open 契約は不変）。
//
// epochMode='ok'   : 給電対象の各 stub 応答が epoch を単調増加で返す
//                     → journal-log prompt に duration_seconds/phase_durations が現れる。
// epochMode='fail' : 給電対象の各 stub 応答が epoch フィールドを省略する（fail-open）
//                     → journal-log prompt に duration_seconds/phase_durations が現れず、
//                       result.merge_tier は正常に返る（AC-3 fail-open 検証）。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { devFlowArgs, runWorkflowCapture, devFlowResponder, makeWorkflowContext } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');

// ---- VM sandbox helpers（devflow-journal-log.test.mjs の makeSandbox / runWorkflowCapture と同型）----

/**
 * duration telemetry 検証専用の VM sandbox を組む。
 * epochMode='ok' なら給電対象 stub 応答に epoch を単調増加で付与する。
 * epochMode='fail' なら給電対象 stub 応答の epoch を省略する（fail-open 経路）。
 *
 * @param {'ok'|'fail'} epochMode - epoch 給電モード
 * @returns {{ ctx: import('node:vm').Context, getJournalPrompts: () => string[] }}
 */
function makeSandbox(epochMode) {
  const journalPrompts = [];
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
    // PR: label が 'pr' で始まる（pr_end の給電元）
    if (label.startsWith('pr')) {
      return withEpoch({ pr_url: 'https://github.com/acme/skills/pull/1', pr_number: 1, committed: true });
    }
    // Merge tier: changed-files
    // → docs/test-only でないファイルを返す（AUTO 除外。給電対象ではない）
    // post-summary（issue #550 F3）: posted:true 固定 + end mark の給電元
    // （post-summary 応答の optional epoch から feedClockMark('end', ...) へ給電される）。
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
    // 未知の label は devFlowResponder の既定に委譲する
    return devFlowResponder({ 'commit-hook#1': null, 'isolation-probe': null, 'merge-tier-facts': null, 'security-scope': null })({ label, agentType, prompt });
  };

  // workflowStub: dev-flow.js の nested workflow('pr-iterate') 呼び出し（iterate_end の給電元）。
  // fixes_applied:0 で Final reconcile を skip させ（issue #443 の edge case: final キー欠落を検証）、
  // end_epoch から iterate_end を feedClockMark() へ給電する。
  const workflowStub = async () => {
    if (epochMode === 'fail') return { status: 'lgtm', fixes_applied: 0 };
    epoch += 10;
    return { status: 'lgtm', fixes_applied: 0, end_epoch: epoch };
  };

  const logLines = []; // recordClockMark の fail-open 警告（⚠️ clock#<mark>）を検出するため log を捕捉
  const ctx = makeWorkflowContext({
    log: (msg) => { logLines.push(String(msg)); },
    agent: agentStub,
    workflow: workflowStub,
    args: devFlowArgs('1'),
  });
  return {
    ctx,
    getJournalPrompts: () => journalPrompts,
    getLogLines: () => logLines,
    getImplEpochs: () => implEpochs,
  };
}

// journal-log prompt（handoff JSON を含む）から phase_durations object を取り出す（無ければ null）。
function extractPhaseDurations(prompt) {
  const m = /"phase_durations":(\{[^}]*\})/.exec(prompt);
  return m ? JSON.parse(m[1]) : null;
}

// ============================================================
// テストケース
// ============================================================

// standard 経路に落ちる req（count=3, ac=4件, type='feat' → floor='standard'）
// Merge tier phase まで到達させる（Evaluate も実行される）

const src = readFileSync(devFlowPath, 'utf8');

test('[duration-telemetry] epochMode=ok: journal-log prompt に duration_seconds/phase_durations が含まれる（final キーは fixes_applied=0 の Final reconcile skip で欠落する）', async () => {
  const { ctx, getJournalPrompts, getLogLines, getImplEpochs } = makeSandbox('ok');

  const { result, error } = await runWorkflowCapture(src, ctx);

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

test('[duration-telemetry] epochMode=fail: 給電元 stub が epoch を省略する（fail-open）ため journal-log prompt に duration_seconds/phase_durations が現れず、result.merge_tier は正常に返る', async () => {
  const { ctx, getJournalPrompts } = makeSandbox('fail');

  const { result, error } = await runWorkflowCapture(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  assert.ok(
    result !== null && result !== undefined,
    `給電元 stub 全滅（fail-open）でも workflow は return object を解決するべきだが null/undefined だった（error: ${error?.name}: ${error?.message}）`,
  );
  assert.ok(
    typeof result?.merge_tier === 'string' && ['HOLD', 'REVIEW', 'AUTO'].includes(result.merge_tier),
    `給電元 stub 全滅でも result.merge_tier は 'HOLD'|'REVIEW'|'AUTO' のいずれかであるべきだが '${result?.merge_tier}' だった`,
  );

  const capturedPrompt = getJournalPrompts()[0] ?? '';
  assert.ok(
    !capturedPrompt.includes('"duration_seconds"'),
    `給電元 stub 全滅時は journal-log prompt に "duration_seconds" が含まれないべきだが含まれていた。prompt:\n${capturedPrompt}`,
  );
  // start / setup_end は args.setup（必須キー）から給電されるが、どちらも phase の終端 mark ではないため
  // phase_durations は空 object になり handoff からキー自体が欠落する（issue #695 で常時 0 の analyze キーを撤去）
  assert.ok(
    !capturedPrompt.includes('"phase_durations"'),
    `給電元 stub 全滅時は journal-log prompt に "phase_durations" が含まれないべきだが含まれていた。prompt:\n${capturedPrompt}`,
  );
});
