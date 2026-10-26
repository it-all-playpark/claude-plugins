// Validate / post-eval / test#final の test 実行 prompt を VM run で実際に各 spawn へ渡る prompt として捕捉し、
// exec-proxy `run-tests <WT>` の stdout 転写契約になっていることを pin する（issue #821）。
//
// テストスクリプトの選択・起動失敗の分類・failed_files の抽出・green 判定は run-tests（_shared/scripts/run-tests.sh、
// run-tests.bats が exit 0 / 1 / 126 / run-*.sh 無しの fixture で pin）が exit code から決める。prompt 側に残るのは
// 「次を実行して stdout の JSON 1 行だけを verbatim で返せ」だけで、規約文（3 分岐・起動失敗ルール等）が戻っていないことを
// 否定側で見る。tests:'error' / tests:'failed' で green-fix ルーティングが分岐する挙動は
// _lib/validate-tests-error-skip-routing.test.mjs が VM sandbox で担っているため、本ファイルでは重複させない。
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeRecordingSandbox, runDevFlowInSandbox, devFlowArgs } from './test-helpers/vm-sandbox.mjs';
import { runTestsPrompt } from './run-tests-prompt.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');
const devFlowSrc = readFileSync(devFlowPath, 'utf8');

function responder({ label, agentType }) {
  if (label === 'setup-base') {
    return {
      ok: true, default_branch: 'main', dev_exists: false, requested_exists: false,
      worktree_exists: false, upstream_remote: '', upstream_merge: '',
    };
  }
  if (label === 'worktree') return { worktree: '/tmp/wt', branch: 'feature/issue-553' };
  if (label.startsWith('analyze')) {
    return {
      summary: 's',
      acceptance_criteria: ['a', 'b'],
      issue_type: 'fix',
      scope: 'src',
      issue_number: 553,
      issue_title: 'stub-issue-title',
    };
  }
  if (label.startsWith('danger-grep')) return { ok: true, hits: [] };
  if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) return { hash: 'H', empty: false };
  if (label.startsWith('test')) return { tests: 'passed', green: true, summary: '' };
  if (agentType === 'dev-flow:dev-implementer') return { status: 'DONE', task_id: 't', files: [], summary: '', concerns: [] };
  if (agentType === 'dev-flow:evaluator') {
    return {
      verdict: 'pass', total: 100, threshold: 80, feedback: [],
      feedback_level: 'implementation', ac_results: [], security_clearance: [],
    };
  }
  if (label === 'realized-diff' || label === 'declared-path-check' || label === 'changed-files') return { files: [] };
  if (label.startsWith('pr')) return { pr_url: 'http://x', pr_number: 1, committed: true };
  if (label === 'issue-meta') return { ok: true, number: 553, title: 'stub-issue-title' };
  return null;
}

let sharedCalls = null;
let sharedError = null;

async function ensureSharedRun() {
  if (sharedCalls !== null) return;
  const { ctx, calls } = makeRecordingSandbox(responder, { args: devFlowArgs('553') });
  const error = await runDevFlowInSandbox(devFlowSrc, ctx);
  sharedCalls = calls;
  sharedError = error;
}

function test1Call() {
  const c = sharedCalls.find((x) => x.label === 'test#1');
  assert.ok(
    c != null,
    `label === 'test#1' の call が見つからない (labels: ${sharedCalls.map((x) => x.label).join(', ')})`,
  );
  return c;
}

test('[validate-test-prompt] crash guard: dev-flow.js が sandbox で ReferenceError / SyntaxError を throw しない', async () => {
  await ensureSharedRun();
  if (sharedError && (sharedError.name === 'ReferenceError' || sharedError.name === 'SyntaxError')) {
    assert.fail(`dev-flow.js が sandbox でクラッシュ: ${sharedError.name}: ${sharedError.message}`);
  }
});

test('[validate-test-prompt] test#1 は dev-runner-haiku に GREEN schema（tests / green 必須）で渡る', async () => {
  await ensureSharedRun();
  const c = test1Call();
  assert.equal(c.agentType, 'dev-flow:dev-runner-haiku', `test#1 の agentType: ${c.agentType}`);
  // schema は VM realm の配列なので host realm の配列に写してから比べる
  assert.deepEqual([...(c.schema?.required ?? [])], ['tests', 'green'], `test#1 の schema が GREEN ではない: ${JSON.stringify(c.schema)}`);
});

test('[validate-test-prompt] test#1 prompt は runTestsPrompt(WT, origin/<base>) と byte 一致する（canonical から inline 生成された転写契約）', async () => {
  await ensureSharedRun();
  assert.equal(test1Call().prompt, runTestsPrompt('/tmp/wt', 'origin/main'));
});

test('[validate-test-prompt] --base は PRERUN.base（origin/<base>）に追従し、test#1 / test#final が同じ ref を渡す', async () => {
  const { ctx, calls } = makeRecordingSandbox(
    (c) => (c.label === 'reconcile-sync' ? { ok: true, head: 'a'.repeat(40) } : responder(c)),
    { args: devFlowArgs('553', { base: 'dev' }), workflow: async () => ({ status: 'lgtm', iterations: 2, fixes_applied: 1 }) },
  );
  await runDevFlowInSandbox(devFlowSrc, ctx);
  for (const label of ['test#1', 'test#final']) {
    const c = calls.find((x) => x.label === label);
    assert.ok(c != null, `${label} の call が見つからない (labels: ${calls.map((x) => x.label).join(', ')})`);
    assert.equal(c.prompt.split('\n').at(-1), 'run-tests /tmp/wt --base origin/dev', `${label} の実行コマンド行: ${c.prompt.split('\n').at(-1)}`);
  }
});

test('[validate-test-prompt] 転写契約: 最終行が bare 単文 `run-tests <WT> --base <ref>` で、stdout の JSON 1 行を verbatim で返させる', () => {
  const prompt = runTestsPrompt('/tmp/wt', 'origin/main');
  const lines = prompt.split('\n');
  assert.equal(lines.at(-1), 'run-tests /tmp/wt --base origin/main', `実行コマンド行が bare 単文の run-tests ではない: ${lines.at(-1)}`);
  assert.ok(prompt.includes('1 回だけ実行') && prompt.includes('再実行しない'), '1 回だけ実行の指示が無い');
  assert.ok(prompt.includes('stdout の JSON 1 行だけ'), 'stdout の JSON 1 行だけを返させる指示が無い');
  assert.ok(prompt.includes('verbatim'), 'verbatim 転写の指示が無い');
  assert.ok(prompt.includes('timeout: 600000') && prompt.includes('run_in_background'), 'timeout 明示と background 禁止の指示が無い');
  // JSON が返らなかった場合の応答は固定文字列（agent に結果を組み立てさせない）。green:true は現れない
  assert.ok(prompt.includes('{"tests":"error","green":false,"summary":"run-tests did not return JSON"}'), '無応答時の固定 JSON が無い');
  assert.ok(!prompt.includes('"green":true') && !prompt.includes('green:true'), 'prompt に green:true を返させる余地がある');
});

test('[validate-test-prompt] 規約文（スクリプト選択・3 分岐・起動失敗ルール・failed_files 抽出・prebuild 分岐）が prompt に戻っていない', async () => {
  await ensureSharedRun();
  const prompt = test1Call().prompt;
  for (const legacy of [
    'ls -l /tmp/wt/tests',
    'tests/run-*.sh',
    'workspace-prebuild',
    'tests:"passed"',
    'tests:"failed"',
    'tests:"error"',
    'EPERM',
    '原因調査',
    'フォールバック',
    'failed_files',
    'StructuredOutput',
    'Turbopack',
  ]) {
    assert.ok(!prompt.includes(legacy), `test#1 prompt に規約文の断片 '${legacy}' が残っている:\n${prompt}`);
  }
});

// post-eval（test#post-eval-1）と test#1 の prompt 一致は post-eval-validate-routing.test.mjs が pin する
test('[validate-test-prompt] Final reconcile の test#final は Validate の test#1 と同一 prompt・同一 schema', async () => {
  const { ctx, calls } = makeRecordingSandbox(
    (c) => (c.label === 'reconcile-sync' ? { ok: true, head: 'a'.repeat(40) } : responder(c)),
    { args: devFlowArgs('553'), workflow: async () => ({ status: 'lgtm', iterations: 2, fixes_applied: 1 }) },
  );
  await runDevFlowInSandbox(devFlowSrc, ctx);
  const t1 = calls.find((x) => x.label === 'test#1');
  const tf = calls.find((x) => x.label === 'test#final');
  assert.ok(t1 && tf, `test#1 / test#final の call が揃っていない (labels: ${calls.map((x) => x.label).join(', ')})`);
  assert.equal(tf.prompt, t1.prompt, 'test#final の prompt が test#1 と一致しない');
  assert.equal(tf.agentType, 'dev-flow:dev-runner-haiku');
  assert.deepEqual([...(tf.schema?.required ?? [])], ['tests', 'green'], 'test#final の schema が GREEN ではない');
});

// 変数の契約（名前・形式・未設定 = 全件）は repo 側のランナーが読む唯一の仕様なので、reference の記述を pin する
test('[validate-test-prompt] pipeline.md の run-tests 説明に DEVFLOW_CHANGED_FILES / DEVFLOW_BASE の契約がある', () => {
  const pipelineMd = readFileSync(join(repoRoot, 'dev-flow/references/pipeline.md'), 'utf8');
  const pipelinePara = pipelineMd.split('\n\n').find((p) => p.includes('run-tests <WT>'));
  assert.ok(pipelinePara, 'pipeline.md に run-tests の段落が無い');
  for (const token of ['--base', 'DEVFLOW_CHANGED_FILES', 'DEVFLOW_BASE', '絶対パス', '1 行 1 件', '全件', 'untracked']) {
    assert.ok(pipelinePara.includes(token), `pipeline.md の run-tests 説明に '${token}' が無い`);
  }
});
