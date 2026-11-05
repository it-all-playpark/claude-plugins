// TDD red として作成。F2（runValidateLoop 抽出）までテスト 2・3 は fail する。
//
// このファイルは Validate ループ統合（構造重複排除・プロンプト byte 一致・concerns 伝搬・
// テスト弱体化監査注入・GREEN_MAX ループ）を VM sandbox で pin するテストである。
// empty-diff-evaluate-routing.test.mjs の makeCountingSandbox / runWorkflowCapture と同型で実装する。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { devFlowArgs, runWorkflowCapture, devFlowResponder, makeWorkflowContext } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');

/**
 * validate loop unification 専用の VM sandbox を組む。
 *
 * opts.gateEmpty: true → diff-gate が empty:true を返し retry 経路を発火させる
 *
 * test stub の挙動:
 *   opts.retryAlwaysFailed: false（default）
 *     - label が 'test#retry' で始まるか否かで本経路/retry 経路を独立カウント
 *     - 各 prefix の 1 回目だけ failed を返し 2 回目以降は passed を返す
 *     - summary は両方 'SAME_FAILURE_SUMMARY' で一致させる（テスト 3 の byte 一致用）
 *   opts.retryAlwaysFailed: true
 *     - 'test#retry' で始まるラベルは常に failed を返す（GREEN_MAX ループ pin 用）
 *     - 本経路 test は 1 回目 failed、2 回目 passed（本経路は通常終了）
 *
 * green-fix stub（agentType==='implementer' && label.startsWith('green-fix')）:
 *   - 常に { status:'DONE', task_id:'t', files:['src/foo.test.ts'], summary:'typo修正', concerns:['GF_CONCERN_MARKER'] }
 *   - 本経路・retry 経路とも同一（テスト 4・5 の GF_CONCERN_MARKER 到達 pin 用）
 *
 * diff-gate は opts.gateEmpty:true で retry 経路を発火させる。
 *
 * @param {object} [opts]
 * @param {boolean} [opts.gateEmpty=false]
 * @param {boolean} [opts.retryAlwaysFailed=false]
 * @param {boolean} [opts.mainTestThrowFirst=false] - true の場合、本経路 test（'test#N'）の
 *   1 回目呼び出しで EPERM 相当の Error を throw する（sandbox EPERM 起動失敗の再現）。
 *   2 回目以降は従来どおり passed を返す（1 回目 failed 分岐は throw が先行するため到達しない）。
 * @returns {{ ctx: import('node:vm').Context, calls: Array<{label: string, agentType: string, prompt: string}> }}
 */
function makeCountingSandbox(opts) {
  const {
    gateEmpty = false,
    retryAlwaysFailed = false,
    mainTestThrowFirst = false,
  } = opts || {};

  const calls = [];

  // 本経路（test#N）と retry 経路（test#retry-N）のカウンタを独立管理
  let mainTestCallCount = 0;
  let retryTestCallCount = 0;

  const agentStub = async (prompt, opts) => {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';
    calls.push({ label, agentType, prompt: String(prompt ?? '') });

    // Security / danger-grep
    if (label.startsWith('danger-grep')) return { ok: true, hits: [] };

    // diff-gate / diff-gate-retry
    if (label === 'diff-gate') return { hash: gateEmpty ? 'EMPTY' : 'H', empty: gateEmpty };

    // diff-hash 系（eval / pr）
    if (label.startsWith('diff-hash')) return { hash: 'H', empty: false };

    // Validate: test runner（label が 'test' で始まる）
    // 本経路（test#N）と retry 経路（test#retry-N）を prefix で分岐
    if (label.startsWith('test')) {
      const isRetryPath = label.startsWith('test#retry');
      if (isRetryPath) {
        retryTestCallCount += 1;
        if (retryAlwaysFailed) {
          // GREEN_MAX ループ pin 用: 常に failed を返す
          return { tests: 'failed', green: false, summary: 'SAME_FAILURE_SUMMARY' };
        }
        // 通常モード: 1 回目 failed、2 回目以降 passed
        if (retryTestCallCount === 1) {
          return { tests: 'failed', green: false, summary: 'SAME_FAILURE_SUMMARY' };
        }
        return { tests: 'passed', green: true, summary: '' };
      } else {
        mainTestCallCount += 1;
        if (mainTestThrowFirst && mainTestCallCount === 1) {
          throw new Error('EPERM: operation not permitted (vitest node_modules/.vite-temp)');
        }
        // 本経路: 1 回目 failed、2 回目以降 passed
        if (mainTestCallCount === 1) {
          return { tests: 'failed', green: false, summary: 'SAME_FAILURE_SUMMARY' };
        }
        return { tests: 'passed', green: true, summary: '' };
      }
    }

    // Validate: green-fix（implementer + green-fix label prefix）
    // GF_CONCERN_MARKER を concerns に含め、テスト 4・5 の pin を支える
    if (agentType === 'dev-flow:dev-implementer' && label.startsWith('green-fix')) {
      return {
        status: 'DONE',
        task_id: 't',
        files: ['src/foo.test.ts'],
        summary: 'typo修正',
        concerns: ['GF_CONCERN_MARKER'],
      };
    }

    // implementer（通常）
    if (agentType === 'dev-flow:dev-implementer') {
      return { status: 'DONE', task_id: 't', files: [], summary: '', concerns: [] };
    }

    // Evaluate
    if (agentType === 'dev-flow:evaluator') {
      return {
        verdict: 'pass',
        total: 100,
        threshold: 80,
        feedback: [],
        feedback_level: 'implementation',
        ac_results: [],
        security_clearance: [],
      };
    }

    return devFlowResponder({ 'commit-hook#1': null, 'commit-hook#2': null, 'commit-hook#retry-1': null, 'commit-hook#retry-2': null, 'commit-hook#retry-3': null, 'isolation-probe': null, 'journal-log': null, 'merge-tier-facts': null, 'post-summary': null, 'security-scope': null })({ label, agentType, prompt });
  };

  const ctx = makeWorkflowContext({
    agent: agentStub,
    workflow: async () => ({ status: 'LGTM' }),
    args: devFlowArgs('1'),
  });
  return { ctx, calls };
}

// ============================================================
// (1) crash guard — ReferenceError/SyntaxError で fail
// ============================================================

test('[validate-unify] (1) crash guard: dev-flow.js が sandbox で ReferenceError / SyntaxError を throw しない', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx } = makeCountingSandbox({ gateEmpty: false });
  const { error } = await runWorkflowCapture(src, ctx);
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }
});

// (2) 「function runValidateLoop が存在する」構造 pin は撤去した（issue #636）。単一化（重複排除）の
// 実質は本経路・retry 経路の prompt が byte 一致することを VM 実行で検証する (3) が保証する。
// 「テストスイートを実行し」「禁止文」の日本語プロンプト文言を回数で数える pin も同理由で撤去済み（AC-1）。

// ============================================================
// (3) プロンプト同一 pin（gateEmpty:true で retry 経路を発火）
//   - test#1 prompt === test#retry-1 prompt（byte 一致）
//   - green-fix#1 prompt === green-fix#retry-1 prompt（byte 一致）
// NOTE: F2（runValidateLoop 抽出）前は RED（retry 側の空白 drift で green-fix prompt 不一致）
// ============================================================

test('[validate-unify] (3) プロンプト同一 pin: test#1 と test#retry-1 のプロンプト byte 一致・green-fix#1 と green-fix#retry-1 のプロンプト byte 一致', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, calls } = makeCountingSandbox({ gateEmpty: true });
  const { error } = await runWorkflowCapture(src, ctx);
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  // test runner プロンプト: test#1 と test#retry-1
  const testMain1 = calls.find((c) => c.label === 'test#1');
  const testRetry1 = calls.find((c) => c.label === 'test#retry-1');

  assert.ok(testMain1 != null, `label === 'test#1' の call が見つからない (全 labels: ${calls.map((c) => c.label).join(', ')})`);
  assert.ok(testRetry1 != null, `label === 'test#retry-1' の call が見つからない (全 labels: ${calls.map((c) => c.label).join(', ')})`);

  assert.strictEqual(
    testMain1.prompt,
    testRetry1.prompt,
    `test#1 と test#retry-1 のプロンプトが byte 一致しない（空白 drift 等）。`
    + `\ntest#1 prompt（先頭200字）: ${testMain1.prompt.slice(0, 200)}`
    + `\ntest#retry-1 prompt（先頭200字）: ${testRetry1.prompt.slice(0, 200)}`,
  );

  // green-fix プロンプト: green-fix#1 と green-fix#retry-1
  const gfMain1 = calls.find((c) => c.label === 'green-fix#1');
  const gfRetry1 = calls.find((c) => c.label === 'green-fix#retry-1');

  assert.ok(gfMain1 != null, `label === 'green-fix#1' の call が見つからない (全 labels: ${calls.map((c) => c.label).join(', ')})`);
  assert.ok(gfRetry1 != null, `label === 'green-fix#retry-1' の call が見つからない (全 labels: ${calls.map((c) => c.label).join(', ')})`);

  assert.strictEqual(
    gfMain1.prompt,
    gfRetry1.prompt,
    `green-fix#1 と green-fix#retry-1 のプロンプトが byte 一致しない（空白 drift 等）。`
    + `\ngreen-fix#1 prompt（先頭300字）: ${gfMain1.prompt.slice(0, 300)}`
    + `\ngreen-fix#retry-1 prompt（先頭300字）: ${gfRetry1.prompt.slice(0, 300)}`,
  );
});

// ============================================================
// (4) concerns 伝搬同一 pin（gateEmpty:true で両経路発火）
//   - eval#1 の prompt に 'GF_CONCERN_MARKER' が含まれること
//   - 本経路 + retry 経路の green-fix concerns が evaluator focus_areas へ到達
// ============================================================

test('[validate-unify] (4) concerns 伝搬同一 pin: eval#1 の prompt に GF_CONCERN_MARKER が含まれること（本経路+retry 経路 green-fix concerns → evaluator）', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, calls } = makeCountingSandbox({ gateEmpty: true });
  const { error } = await runWorkflowCapture(src, ctx);
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  const eval1 = calls.find((c) => c.label === 'eval#1');
  assert.ok(
    eval1 != null,
    `label === 'eval#1' の call が見つからない (全 labels: ${calls.map((c) => c.label).join(', ')})`,
  );
  assert.ok(
    eval1.prompt.includes('GF_CONCERN_MARKER'),
    `eval#1 の prompt に 'GF_CONCERN_MARKER' が含まれていない。`
    + `\nprompt（先頭600字）:\n${eval1.prompt.slice(0, 600)}`,
  );
});

// ============================================================
// (5) green-fix データ echo 注入 pin（gateEmpty:true で両経路発火）
//   - eval#1 の prompt に 'src/foo.test.ts'（green-fix stub の files）が含まれること
//   （pushGreenFixAudit が両経路分を注入。「テスト弱体化」focus 語・「申告された根拠」の日本語
//    文言 pin は言い回し変更で落ちるため撤去した — issue #636 AC-1）
// ============================================================

test('[validate-unify] (5) green-fix データ echo 注入 pin: eval#1 の prompt に src/foo.test.ts が含まれること', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, calls } = makeCountingSandbox({ gateEmpty: true });
  const { error } = await runWorkflowCapture(src, ctx);
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  const eval1 = calls.find((c) => c.label === 'eval#1');
  assert.ok(
    eval1 != null,
    `label === 'eval#1' の call が見つからない (全 labels: ${calls.map((c) => c.label).join(', ')})`,
  );
  assert.ok(
    eval1.prompt.includes('src/foo.test.ts'),
    `eval#1 の prompt に 'src/foo.test.ts' が含まれていない。\nprompt（先頭600字）:\n${eval1.prompt.slice(0, 600)}`,
  );
});

// ============================================================
// (6) GREEN_MAX ループ pin（retry prefix 常時 failed モード、gateEmpty:true）
//   - label が 'test#retry' で始まる call がちょうど 3 件（GREEN_MAX=3）
//   - label が 'green-fix#retry' で始まる call がちょうど 2 件（GREEN_MAX-1）
// ============================================================

test('[validate-unify] (6) GREEN_MAX ループ pin: test#retry ちょうど 3 件・green-fix#retry ちょうど 2 件（retry 常時 failed モード）', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, calls } = makeCountingSandbox({ gateEmpty: true, retryAlwaysFailed: true });
  const { error } = await runWorkflowCapture(src, ctx);
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  const retryTestCalls = calls.filter((c) => c.label.startsWith('test#retry'));
  assert.strictEqual(
    retryTestCalls.length,
    3,
    `label が 'test#retry' で始まる call がちょうど 3 件（GREEN_MAX=3）であるべきだが ${retryTestCalls.length} 件。`
    + `\n全 labels: ${calls.map((c) => c.label).join(', ')}`,
  );

  const retryGfCalls = calls.filter((c) => c.label.startsWith('green-fix#retry'));
  assert.strictEqual(
    retryGfCalls.length,
    2,
    `label が 'green-fix#retry' で始まる call がちょうど 2 件（GREEN_MAX-1=2）であるべきだが ${retryGfCalls.length} 件。`
    + `\n全 labels: ${calls.map((c) => c.label).join(', ')}`,
  );
});

// ============================================================
// (7) 新文言 pin（AC-1/AC-2）: VALIDATE_TEST_PROMPT に bare 形優先実行・EPERM fail-safe 文言が
//     含まれること
// NOTE: F2（VALIDATE_TEST_PROMPT 書き換え）前は RED（新文言が存在しない）
// ============================================================

test('[validate-unify] (7) test#1 prompt に test スクリプト優先・EPERM fail-safe の識別トークンが含まれること', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, calls } = makeCountingSandbox({ gateEmpty: false });
  const { error } = await runWorkflowCapture(src, ctx);
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  const testMain1 = calls.find((c) => c.label === 'test#1');
  assert.ok(
    testMain1 != null,
    `label === 'test#1' の call が見つからない (全 labels: ${calls.map((c) => c.label).join(', ')})`,
  );

  // 識別子・トークンのみ pin する（日本語文言は言い回しの変更で落ちるため pin しない。issue #636 AC-1）。
  // スクリプト選択・起動失敗の分類は exec-proxy run-tests が持ち、prompt は bare 単文の転写だけ（issue #821）
  const requiredPhrases = [
    '\nrun-tests start /tmp/wt',
    'verbatim',
    'timeout: 600000',
    '"tests":"error"',
  ];
  for (const phrase of requiredPhrases) {
    assert.ok(
      testMain1.prompt.includes(phrase),
      `test#1 の prompt に '${phrase}' が含まれていない。`
      + `\nprompt（先頭400字）:\n${testMain1.prompt.slice(0, 400)}`,
    );
  }
});

// ============================================================
// (8) throw→red 継続 pin（AC-4）: 本経路 test の throw が run を殺さず、green-fix ループへ
//     継続すること
// NOTE: F2（try/catch fail-safe 変換）前は RED（throw が run 全体を abort させる）
// ============================================================

test('[validate-unify] (8) throw→red 継続 pin: 本経路 test の throw で run が死なず green-fix ループへ継続すること', async () => {
  const src = readFileSync(devFlowPath, 'utf8');
  const { ctx, calls } = makeCountingSandbox({ gateEmpty: false, mainTestThrowFirst: true });
  const { error } = await runWorkflowCapture(src, ctx);

  assert.equal(
    error,
    null,
    `(8) 本経路 test の throw で run 全体が abort してはならないが error が発生: ${error?.message}`,
  );
  assert.ok(
    calls.some((c) => c.label === 'green-fix#1'),
    `(8) label === 'green-fix#1' の call が見つからない（throw が red 扱いされていない）。`
    + `\n全 labels: ${calls.map((c) => c.label).join(', ')}`,
  );
  assert.ok(
    calls.some((c) => c.label === 'test#2'),
    `(8) label === 'test#2' の call が見つからない（ループ 2 周目未到達）。`
    + `\n全 labels: ${calls.map((c) => c.label).join(', ')}`,
  );
  assert.ok(
    calls.some((c) => c.label === 'eval#1'),
    `(8) label === 'eval#1' の call が見つからない（Validate を抜けて Evaluate へ未到達）。`
    + `\n全 labels: ${calls.map((c) => c.label).join(', ')}`,
  );
});
