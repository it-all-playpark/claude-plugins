import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash, shapeOverrides, mergeTierFacts, devFlowArgs } from './test-helpers/vm-sandbox.mjs';
import { DEV_FLOW_SCENARIOS } from './test-helpers/dev-flow-scenarios.mjs';

import {
  EVALUATOR_OPERATIONAL_CONTRACT, CONCERN_RESOLUTIONS, normalizeConcernResolution,
  EVAL_DESCRIPTION_MAX, EVAL_SUGGESTION_MAX, EVAL_EVIDENCE_MAX, AC_GIST_MAX, EVAL_FULL_SUITE,
  TEST_LOG_REUSE, TEST_LOG_EVIDENCE_LIMIT, validateResultPromptBlock, acceptedCriticalResolutions,
  DIAGRAM_CHECK_SCHEMA, DIAGRAM_MISMATCH_MAX, diagramCheckPromptBlock,
} from './evaluator-contract.mjs';
import { RESOLVED_CELL_MAX } from './devflow-summary-format.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');
const devFlowSrc = readFileSync(devFlowPath, 'utf8');
const prIterateSrc = readFileSync(join(repoRoot, '.claude/workflows/pr-iterate.js'), 'utf8');
const evaluatorMd = readFileSync(join(repoRoot, '.claude/agents/evaluator.md'), 'utf8');

// ============================================================
// VM harness: 共有 vm-sandbox.mjs の makeDevFlowSandbox / runWorkflowCapture / assertNoCrash を使い、
// dev-flow.js が実際に agent() へ渡す prompt を捕捉して canonical contract の verbatim 注入を検証する。
// 既定 responder に無い Final reconcile 系の応答のみ overrides で補う。
// ============================================================

const FINAL_RECONCILE_DEFAULTS = {
  'reconcile-sync': { ok: true, head: 'deadbeef' },
  'changed-files-final': { files: [] },
  'final-ac-reconcile': {
    ac_results: [
      { ac_index: 0, satisfied: true, evidence: 'e0', verified_by: 'inspection' },
      { ac_index: 1, satisfied: true, evidence: 'e1', verified_by: 'inspection' },
    ],
  },
};

function makeSandbox({ overrides = {}, fixesApplied = 0, extra = {} } = {}) {
  return makeDevFlowSandbox({
    overrides: { ...FINAL_RECONCILE_DEFAULTS, ...overrides },
    workflow: async () => ({ status: 'lgtm', iterations: 2, fixes_applied: fixesApplied }),
    extra,
  });
}

// 契約の全文は各起動の prompt に注入する（下の prompt 注入テストが pin）。evaluator.md の「入力」節は
// 各キーの役割だけを持ち、沈黙（返さない item）と evidence の無い解消を解消扱いにしないことを書く。
const inputSection = (() => {
  const start = evaluatorMd.indexOf('\n## 入力\n');
  assert.ok(start >= 0, 'evaluator.md に「## 入力」節が無い');
  return evaluatorMd.slice(start, evaluatorMd.indexOf('\n## ', start + 1)).replace(/\n +/g, '');
})();
const inputItem = (key) => inputSection.split('\n').find((l) => l.startsWith(`- \`${key}\``)) ?? '';

test('[evaluator-contract] evaluator.md の「入力」節は critical_resolutions / security_clearance / concern_resolutions の役割を書き、契約の細部は prompt に従わせる', () => {
  const critical = inputItem('未解消 critical 一覧');
  assert.ok(critical.includes('`critical_resolutions[]`') && critical.includes('返さない item は未解消のまま据え置かれ')
    && critical.includes('evidence の無い `resolved:true` は解消扱いにならない'), critical);
  const security = inputItem('security_focus');
  assert.ok(security.includes('`security_clearance[]`') && security.includes('evidence の無い `cleared:true` は解消扱いにならない'), security);
  const concern = inputItem('未解消 concern 一覧');
  assert.ok(concern.includes('`concern_resolutions[]`') && concern.includes('返さない item は未解消のまま据え置かれ')
    && concern.includes('evidence の無い resolved / triaged は解消扱いにならない'), concern);
  assert.ok(inputSection.includes('各キーの返し方の契約は、その入力と一緒に prompt に入る。契約の細部は prompt の指示に従う。'), inputSection);
});

// final_ac_reconcile 契約は dev-flow-finalize.js の final-ac-reconcile が prompt に注入する。
// 各起動が使う契約を prompt に注入するので agent 定義（evaluator.md）には置かない。
test('[evaluator-contract] evaluator.md does NOT carry the final_ac_reconcile contract (prompt-injection-only delivery, issue #331)', () => {
  assert.ok(
    !evaluatorMd.includes('final_ac_reconcile'),
    'final_ac_reconcile 契約は dev-flow-finalize.js の final-ac-reconcile prompt に注入する。各起動が使う契約を prompt に注入するので agent 定義（evaluator.md）には置かない',
  );
});

// issue #658 / #1168: final_ac_reconcile 契約に item_resolutions（ESCALATE/advisory item の fix 後 tree
// 再評価。resolved / unresolved の 2 値 enum）があり、最終 tree で確かめられない item は unresolved にすることを pin する。
test('[evaluator-contract][#1168] final_ac_reconcile 契約の item_resolutions は resolved / unresolved の 2 値で、確かめられない item は unresolved', () => {
  const contract = EVALUATOR_OPERATIONAL_CONTRACT.final_ac_reconcile;
  assert.ok(contract.includes('item_resolutions'), 'final_ac_reconcile 契約に item_resolutions の説明が必要です');
  assert.ok(contract.includes('resolved（指摘内容が最終 tree で解消されている — revert / 修正済み等）/ unresolved の 2 値のみ'), contract);
  assert.ok(contract.includes('最終 tree で確かめられない item（ローカルで実行できない build / compose / e2e 等）は unresolved にする'), contract);
});

// issue #1144: テストログに載っている AC 関連テストファイルはログの行を evidence に使ってよく、載っていないものは実行する。
// ログの行も実行結果も PR が書いたテストの出力なので、テストの本体と対象実装を読んで assert を確かめたときだけ根拠にする
const LOG_EVIDENCE = 'ログの該当行（テスト名と ok / not ok）を evidence にして';
const TEST_BODY_CHECK = '実行するかはテストの本体を読んで決め';
test('[evaluator-contract][#1144] TEST_LOG_REUSE と final_ac_reconcile 契約は、ログの行を使うか実行するかをテストの本体を読んで決めさせ、ログに無いものは実行させる', () => {
  for (const [name, text] of [['TEST_LOG_REUSE', TEST_LOG_REUSE], ['final_ac_reconcile', EVALUATOR_OPERATIONAL_CONTRACT.final_ac_reconcile]]) {
    assert.ok(text.includes(TEST_BODY_CHECK), `${name}: 実行するかをテストの本体で決める指示が無い`);
    assert.ok(text.includes(LOG_EVIDENCE) && text.includes('verified_by:"test"'), `${name}: ログの行を evidence にして verified_by:"test" とする指示が無い`);
    assert.ok(/ログに載っていない AC (に関係する|関連)テストファイルは実行/.test(text), `${name}: ログに無いものを実行する指示が無い`);
    // ログはテストが自由に書けるので、この diff が変更したファイルの、実行対象一覧とファイルの実体で裏を取れる行だけを根拠にする
    assert.ok(text.includes(TEST_LOG_EVIDENCE_LIMIT), `${name}: ログ行の裏取りの指示が無い`);
  }
  for (const s of ['「ログを根拠にできるテストファイル」（この diff が変更したファイル）に載るファイルだけ', 'ログに載っていても実行する',
    '集計行', '実行対象一覧', '評価対象の tree（working tree）のそのファイルに実在する',
    'ログの行だけを AC 達成の根拠にしない', 'テストの本体と対象実装を読み', '条件分岐で実行を避けていない・成功の行を自分で出力していない',
    '確かめられないテストはログの行も実行結果も verified_by:"test" の根拠にしない']) {
    assert.ok(TEST_LOG_EVIDENCE_LIMIT.includes(s), `${s}: ${TEST_LOG_EVIDENCE_LIMIT}`);
  }
  // 契約はテストログが渡されたときに限る（渡されない・読めないときは AC 関連テストを実行する）
  assert.ok(EVALUATOR_OPERATIONAL_CONTRACT.final_ac_reconcile.includes('テストログが渡されない・読めない場合は AC に関係するテストファイルを実行'));
});

// ログの行を根拠にしてよい条件の全文は TEST_LOG_REUSE / final_ac_reconcile として prompt に入る（上のテストが pin）。
// evaluator.md の「入力」節はテストログの役割と、その規則は prompt の指示に従うことだけを書く。
test('[evaluator-contract][#1144] evaluator.md の「入力」節はテストログの行を使うときの規則を prompt の指示に従わせる', () => {
  const testLog = inputItem('テストログ');
  assert.ok(testLog.includes('`ログを根拠にできるテストファイル` と対で渡る'), testLog);
  assert.ok(testLog.includes('ログの行を evidence に使うか実行するかの規則は prompt の指示に従う'), testLog);
});

// issue #1303: implementer は commit しないので、Evaluate 時点の実 diff は merge-base から working tree への二点 diff で取る
// （HEAD との差分は空になる）。git は隔離ガードに拒否されない単文で書き、prompt が取り方を指定したらそれに従う
// （final-ac-reconcile は fix が commit 済みなので三点 diff を指定する）。
test('[evaluator-contract][#1303] evaluator.md の「進め方」1 は merge-base・working tree 基準の二点 diff・untracked 列挙を単文で書き、prompt の指定に従う', () => {
  const steps = evaluatorMd.slice(evaluatorMd.indexOf('## 進め方'));
  const step1 = steps.slice(0, steps.indexOf('\n2. '));
  for (const cmd of ['`git merge-base HEAD origin/<base>`', '`git diff <sha>`', '`git status --porcelain --untracked-files=all`']) {
    assert.ok(step1.includes(cmd), `${cmd}: ${step1}`);
  }
  assert.ok(!step1.includes('..HEAD'), `HEAD 基準の diff は Evaluate 時点で空になる: ${step1}`);
  assert.ok(step1.includes('prompt が diff の取り方を指定したときはそれに従う'), step1);
});

// issue #1303: evaluator を起動する prompt に `cd` 前置や `$(…)` を書くと、evaluator.md が隔離ガードのために禁じた形と食い違う。
// eval#N の diff の取り方は evaluator.md の「進め方」1 に任せ、base 名だけを渡す。
const assertNoShellPrefix = (label, prompt) => {
  assert.ok(prompt != null, `label === '${label}' の call が見つからない`);
  assert.ok(!prompt.includes('cd '), `${label} の prompt に cd 前置がある: ${prompt.slice(0, 200)}`);
  assert.ok(!prompt.includes('$('), `${label} の prompt に $(…) がある`);
};

test('[evaluator-contract][#1303] eval#1 の prompt は cd・$(…)・diff 取得コマンドを含まず、base 名だけを渡す', async () => {
  const { ctx, calls } = makeSandbox();
  const { error } = await runWorkflowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'contract-eval1-diff');
  const prompt = calls.find((c) => c.label === 'eval#1')?.prompt;
  assertNoShellPrefix('eval#1', prompt);
  for (const cmd of ['git diff', 'git merge-base']) assert.ok(!prompt.includes(cmd), `eval#1 の prompt に ${cmd} がある（取り方は evaluator.md に任せる）`);
  assert.ok(prompt.includes('origin/main'), 'eval#1 の prompt に base 名（origin/${BASE}）が無い');
});

test('[evaluator-contract][#1303] eval-green-fix・final-ac-reconcile・security-clearance-final の prompt は cd・$(…) を含まない', async () => {
  const POST_EVAL = DEV_FLOW_SCENARIOS['post-eval-green-fix'];
  const greenFix = makeDevFlowSandbox({ overrides: POST_EVAL.overrides, workflow: POST_EVAL.workflow });
  assertNoCrash((await runWorkflowCapture(devFlowSrc, greenFix.ctx)).error, 'contract-eval-green-fix');
  assertNoShellPrefix('eval-green-fix', greenFix.calls.find((c) => c.label === 'eval-green-fix')?.prompt);

  const finalAc = makeSandbox({ fixesApplied: 1, overrides: { 'test#final': { tests: 'passed', green: true, summary: '' } } });
  assertNoCrash((await runWorkflowCapture(devFlowSrc, finalAc.ctx)).error, 'contract-final-ac-diff');
  const finalPrompt = finalAc.calls.find((c) => c.label === 'final-ac-reconcile')?.prompt;
  assertNoShellPrefix('final-ac-reconcile', finalPrompt);
  assert.ok(finalPrompt.includes('`git diff origin/main...HEAD`'), 'final-ac-reconcile は commit 済みの fix を三点 diff で見る指示を保つ');

  // merge-tier-security-clearance-routing.test.mjs のシナリオ 1: Evaluate 前は clean、Merge tier の最終 danger-grep で新規 hit
  const clearance = makeSandbox({
    overrides: {
      'merge-tier-facts': mergeTierFacts({ hash: 'H_MERGE', risk: { ok: true, hits: [{ class: 'config', file: 'x', pattern: 'p' }] } }),
      'security-clearance-final': { security_clearance: [{ danger_class: 'config', cleared: true, evidence: 'diff 精査: secret 平文なし' }] },
    },
  });
  assertNoCrash((await runWorkflowCapture(devFlowSrc, clearance.ctx)).error, 'contract-security-clearance');
  assertNoShellPrefix('security-clearance-final', clearance.calls.find((c) => c.label === 'security-clearance-final')?.prompt);
});

test('[evaluator-contract][#1144] validateResultPromptBlock はログと変更ファイルがあるときだけログパス・根拠にできるファイル・TEST_LOG_REUSE を入れる', () => {
  const scripts = [{ path: '/wt/tests/run-all-bats.sh', exit: 0, launch_failed: false, log: '/tmp/run-tests-q/0.log' }];
  const changed = ['plugins/x/a.bats', 'plugins/x/a.sh'];
  const withLogs = validateResultPromptBlock({ tests: 'passed', green: true, summary: 's', scripts }, changed);
  assert.ok(withLogs.includes('/tmp/run-tests-q/0.log') && withLogs.includes(TEST_LOG_REUSE), withLogs);
  assert.ok(withLogs.includes(`ログを根拠にできるテストファイル（この diff が変更したファイル。git から取った一覧）:\n${JSON.stringify(changed)}\n`), withLogs);
  for (const [name, val, files] of [
    ['scripts 無し', { tests: 'passed', green: true, summary: 's' }, changed],
    ['log 無し', { tests: 'passed', green: true, summary: 's', scripts: [{ path: '/wt/tests/run-all-bats.sh', exit: 0, launch_failed: false }] }, changed],
    ['tests:error', { tests: 'error', green: false, summary: 's', scripts }, changed],
    // 変更ファイルが取れない・空なら、ログを根拠にできるファイルが無いので再実行抑止の指示を入れない
    ['変更ファイル null', { tests: 'passed', green: true, summary: 's', scripts }, null],
    ['変更ファイル空', { tests: 'passed', green: true, summary: 's', scripts }, []],
    // red のまま Evaluate に進んだ Validate のログは渡さない
    ['Validate red', { tests: 'failed', green: false, summary: 'not ok 1 x', scripts }, changed],
  ]) {
    const block = validateResultPromptBlock(val, files);
    assert.ok(!block.includes(TEST_LOG_REUSE) && !block.includes('/tmp/run-tests-q/'), `${name}: ${block}`);
    assert.ok(block.includes(`${EVAL_FULL_SUITE}は走らせず、AC に関係するテストファイルだけを実行して根拠にせよ。`), `${name}: ${block}`);
  }
});

// concern_resolutions 契約は openConcerns.length>0（implementer concerns がある）ときにのみ
// eval#1 prompt へ注入される。standard shape の既定 responder は implementer concerns:[] を
// 返すため、この test だけ overrides で implementer concerns を与える。
test('[evaluator-contract] eval#1 prompt contains EVALUATOR_OPERATIONAL_CONTRACT.critical_resolutions / security_clearance / concern_resolutions verbatim', async () => {
  const { ctx, calls } = makeSandbox({
    overrides: {
      'danger-grep': {
        risk: { ok: true, hits: [{ file: 'src/x.ts', class: 'network-egress', severity: 'critical', pattern: 'fetch' }] },
        files: ['src/x.ts'],
        diffhash: { hash: 'H', empty: false },
      },
      'impl:serial:issue-1': { status: 'DONE_WITH_CONCERNS', task_id: 'issue-1', files: ['src/x.ts'], summary: 's', concerns: ['未検証の入力値がある'] },
    },
  });
  const { error } = await runWorkflowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'contract-eval1');
  const eval1 = calls.find((c) => c.label === 'eval#1');
  assert.ok(eval1 != null, `label === 'eval#1' の call が見つからない (labels: ${calls.map((c) => c.label).join(', ')})`);
  assert.ok(
    eval1.prompt.includes(EVALUATOR_OPERATIONAL_CONTRACT.security_clearance),
    'eval#1 の prompt に EVALUATOR_OPERATIONAL_CONTRACT.security_clearance が verbatim 含まれていない（danger-grep hit による security_focus 注入）',
  );
  assert.ok(
    eval1.prompt.includes(EVALUATOR_OPERATIONAL_CONTRACT.concern_resolutions),
    'eval#1 の prompt に EVALUATOR_OPERATIONAL_CONTRACT.concern_resolutions が verbatim 含まれていない（未解消 concern 一覧による注入）',
  );
});

const countOccurrences = (text, needle) => text.split(needle).length - 1;

// critical_resolutions 契約は dev-flow-evaluate.js の eval#i が「未解消 critical 一覧」（前 iteration の
// critical feedback）を渡すときだけ、一覧と一緒にちょうど 1 回注入する（eval#1 には prior state が無く注入されない）。
// complex shape の 2 iteration フィクスチャ（1 回目 critical → 2 回目解消）で eval#2 の prompt を検証する
// （_lib/eval-convergence.test.mjs の contract test と同じ理由）。
test('[evaluator-contract] eval#2 prompt contains EVALUATOR_OPERATIONAL_CONTRACT.critical_resolutions exactly once (issue #174)', async () => {
  const ac4 = [
    { ac_index: 0, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
    { ac_index: 1, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
    { ac_index: 2, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
    { ac_index: 3, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
  ];
  const { ctx, calls } = makeSandbox({
    overrides: {
      ...shapeOverrides('complex'),
      'eval#1': {
        verdict: 'fail', total: 5, threshold: 7,
        feedback: [{ severity: 'critical', topic: 'X', description: '重大欠陥', suggestion: '修正せよ' }],
        feedback_level: 'implementation', ac_results: ac4, security_clearance: [],
      },
      'eval#2': {
        verdict: 'pass', total: 9, threshold: 7, feedback: [],
        feedback_level: 'implementation', ac_results: ac4, security_clearance: [],
        critical_resolutions: [{ id: 'EVAL-1-X', resolved: true, evidence: 'src/x.ts の入力検証を追加し test で確認' }],
      },
    },
  });
  const { error } = await runWorkflowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'contract-eval2');
  const evalCalls = calls.filter((c) => c.agentType === 'dev-flow:evaluator');
  assert.equal(evalCalls.length, 2, `evaluator は 2 回呼ばれるはずだが ${evalCalls.length} 回だった (labels: ${calls.map((c) => c.label).join(', ')})`);
  assert.ok(evalCalls[1].prompt.includes('未解消 critical 一覧'), 'eval#2 の prompt に未解消 critical 一覧が無い');
  assert.equal(
    countOccurrences(evalCalls[1].prompt, EVALUATOR_OPERATIONAL_CONTRACT.critical_resolutions), 1,
    'eval#2 の prompt に EVALUATOR_OPERATIONAL_CONTRACT.critical_resolutions がちょうど 1 回 verbatim 含まれていない',
  );
});

test('[evaluator-contract] final-ac-reconcile prompt contains EVALUATOR_OPERATIONAL_CONTRACT.final_ac_reconcile verbatim', async () => {
  const { ctx, calls } = makeSandbox({
    fixesApplied: 1,
    overrides: { 'test#final': { tests: 'passed', green: true, summary: '' } },
  });
  const { error } = await runWorkflowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'contract-final-ac');
  const finalAc = calls.find((c) => c.label === 'final-ac-reconcile');
  assert.ok(finalAc != null, `label === 'final-ac-reconcile' の call が見つからない (labels: ${calls.map((c) => c.label).join(', ')})`);
  assert.ok(
    finalAc.prompt.includes(EVALUATOR_OPERATIONAL_CONTRACT.final_ac_reconcile),
    'final-ac-reconcile の prompt に EVALUATOR_OPERATIONAL_CONTRACT.final_ac_reconcile が verbatim 含まれていない',
  );
});

// testsurf_clearance 契約は dev-flow-evaluate.js の testsurf_focus が prompt に注入する。
// 各起動が使う契約を prompt に注入するので agent 定義（evaluator.md）には置かない。
test('[evaluator-contract] evaluator.md does NOT carry the testsurf_clearance contract (prompt-injection-only delivery, issue #362)', () => {
  assert.ok(
    !evaluatorMd.includes('testsurf_clearance'),
    'testsurf_clearance 契約は dev-flow-evaluate.js の testsurf_focus prompt に注入する。各起動が使う契約を prompt に注入するので agent 定義（evaluator.md）には置かない',
  );
});

test('[evaluator-contract] eval#1 prompt contains EVALUATOR_OPERATIONAL_CONTRACT.testsurf_clearance verbatim when danger-grep reports a test-weakening hit', async () => {
  const { ctx, calls } = makeSandbox({
    overrides: {
      'danger-grep': {
        risk: { ok: true, hits: [{ file: '_lib/foo.test.mjs', class: 'test-weakening', severity: 'critical', pattern: 'skip' }] },
        files: ['_lib/foo.test.mjs'],
        diffhash: { hash: 'H', empty: false },
      },
    },
  });
  const { error } = await runWorkflowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'contract-testsurf');
  const eval1 = calls.find((c) => c.label === 'eval#1');
  assert.ok(eval1 != null, `label === 'eval#1' の call が見つからない (labels: ${calls.map((c) => c.label).join(', ')})`);
  assert.ok(
    eval1.prompt.includes(EVALUATOR_OPERATIONAL_CONTRACT.testsurf_clearance),
    'eval#1 の prompt に EVALUATOR_OPERATIONAL_CONTRACT.testsurf_clearance が verbatim 含まれていない',
  );
});

// ---- issue #1312: evaluator.md の「判定」節は Evaluate の実装（execEvaluatePhase）と同じことを言う ----
// 差し戻しを決めるのは ac_results・critical・各 clearance（と llm-major-blocking の AC / CONCERN）で、verdict は表示専用。
// 記述と同じ挙動を下の VM テストで固定し、記述が実装とずれたら落ちるようにする。

const judgeSection = (() => {
  const start = evaluatorMd.indexOf('\n## 判定\n');
  assert.ok(start >= 0, 'evaluator.md に「## 判定」節が無い');
  const end = evaluatorMd.indexOf('\n## ', start + 1);
  return evaluatorMd.slice(start, end < 0 ? undefined : end);
})();

test('[evaluator-contract][#1312] 「判定」節は差し戻しを決める入力（ac_results・critical・clearance・llm-major-blocking の AC / CONCERN）を書く', () => {
  for (const s of ['ac_results', 'AGENT_AC_REIMPL_MAX', 'critical_resolutions', 'security_clearance', 'TESTSURF', 'llm-major-blocking', 'concern_resolutions']) {
    assert.ok(judgeSection.includes(s), `「判定」節に ${s} が無い: ${judgeSection}`);
  }
});

test('[evaluator-contract][#1312] 「判定」節の escalate の行に llm-major-blocking で差し戻しが続く行がある', () => {
  const escalateLines = judgeSection.split('\n').filter((l) => l.includes('escalate'));
  assert.ok(escalateLines.some((l) => l.includes('llm-major-blocking')), `escalate と llm-major-blocking を同じ行に書いた記述が無い: ${escalateLines.join('\n')}`);
});

test('[evaluator-contract][#1312] verdict は表示専用と書き、冒頭の段落は ac_results を workflow が使うと書く', () => {
  assert.ok(judgeSection.includes('verdict') && judgeSection.includes('表示専用'), judgeSection);
  const afterHeading = evaluatorMd.slice(evaluatorMd.indexOf('\n# evaluator\n') + '\n# evaluator\n'.length).replace(/^\n+/, '');
  const lead = afterHeading.slice(0, afterHeading.indexOf('\n\n'));
  assert.ok(lead.includes('ac_results'), `冒頭の段落に ac_results が無い: ${lead}`);
});

test('[evaluator-contract][#1312] feedback_level の design は方針で定義し計画本文に依らず、分類の帰結（回数上限）を見せない', () => {
  const lines = evaluatorMd.split('\n');
  const design = lines.find((l) => l.startsWith('- `design`: '));
  assert.ok(design, 'design の定義行が無い');
  assert.ok(design.includes('方針') && !design.includes('計画'), design);
  assert.ok(lines.some((l) => l.startsWith('- `implementation`: ')), 'implementation の定義行が無い');
  assert.ok(lines.some((l) => l.includes('迷ったら')), '「迷ったら implementation」が無い');
  assert.ok(!judgeSection.includes('回数上限'), `「判定」節に分類の帰結（回数上限）が残っている: ${judgeSection}`);
});

// complex shape（EVAL_PASSES=EVAL_MAX）で走らせる: standard は 1 pass で抜けるので、収束しないときに差し戻すかを見られない。
const AC2_SATISFIED = [
  { ac_index: 0, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
  { ac_index: 1, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
];
const MAJOR_TOPIC = 'naming-convention::public-api-endpoint';
const majorEval = ({ verdict, escalate }) => ({
  verdict, total: 5, threshold: 7, feedback_level: 'implementation',
  feedback: [{
    severity: 'major', topic: MAJOR_TOPIC, description: 'エンドポイント命名が issue に未指定', suggestion: '命名を決める',
    ...(escalate ? { escalate: true, escalate_reason: 'preference' } : {}),
  }],
  ac_results: AC2_SATISFIED, security_clearance: [], concern_resolutions: [],
});

async function runJudge(evalResponse, gatePolicy) {
  const { ctx, calls } = makeSandbox({
    overrides: { ...shapeOverrides('complex'), 'eval#1': evalResponse },
    extra: gatePolicy ? { args: { ...devFlowArgs(1), gate_policy: gatePolicy } } : {},
  });
  const { result, error } = await runWorkflowCapture(devFlowSrc, ctx);
  assertNoCrash(error, `judge-${gatePolicy ?? 'default'}`);
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  return { result, calls, reimpl: calls.filter((c) => c.label.startsWith('reimpl#')) };
}

test('[evaluator-contract][#1312] (i) 既定 policy: 全 AC satisfied・verdict fail・escalate なし major → 差し戻さず PR へ進む', async () => {
  const { calls, reimpl } = await runJudge(majorEval({ verdict: 'fail', escalate: false }));
  assert.equal(reimpl.length, 0, `verdict fail・escalate なし major で差し戻した: ${calls.map((c) => c.label).join(', ')}`);
  assert.ok(calls.some((c) => c.label === 'pr#1'), `PR phase に進まない: ${calls.map((c) => c.label).join(', ')}`);
});

test('[evaluator-contract][#1312] (ii) 既定 policy: escalate:true の major → 差し戻さず merge tier は HOLD', async () => {
  const { result, calls, reimpl } = await runJudge(majorEval({ verdict: 'pass', escalate: true }));
  assert.equal(reimpl.length, 0, `既定 policy の escalate major で差し戻した: ${calls.map((c) => c.label).join(', ')}`);
  assert.equal(result?.merge_tier, 'HOLD', JSON.stringify(result?.merge_tier_reasons));
  assert.ok((result?.merge_tier_reasons ?? []).some((r) => r.includes('ESCALATE-TO-HUMAN')), JSON.stringify(result?.merge_tier_reasons));
});

test('[evaluator-contract][#1312] (iii) llm-major-blocking: escalate:true の major → reimpl#1 が走り fix_feedback にその topic が載る', async () => {
  const { calls, reimpl } = await runJudge(majorEval({ verdict: 'pass', escalate: true }), 'llm-major-blocking');
  const first = reimpl.find((c) => c.label.startsWith('reimpl#1:'));
  assert.ok(first, `llm-major-blocking の escalate major で差し戻さない: ${calls.map((c) => c.label).join(', ')}`);
  const fb = first.prompt.slice(first.prompt.indexOf('fix_feedback'));
  assert.ok(first.prompt.includes('fix_feedback') && fb.includes(MAJOR_TOPIC), `reimpl#1 の fix_feedback に ${MAJOR_TOPIC} が無い: ${fb.slice(0, 400)}`);
});

// 既出 feedback はあるが未解消 critical が無い回（1 回目が major だけ）は、critical_resolutions 契約を注入しない
// （契約は「未解消 critical 一覧」と一緒にだけ入る）。既出 feedback と「新規の critical/major のみ報告」は残す。
test('[evaluator-contract] 1 回目が major だけの eval#2 prompt は既出 feedback と新規のみ報告を含み、critical_resolutions 契約を含まない', async () => {
  const { calls } = await runJudge(majorEval({ verdict: 'fail', escalate: true }), 'llm-major-blocking');
  const eval2 = calls.find((c) => c.label === 'eval#2');
  assert.ok(eval2, `eval#2 が走らない: ${calls.map((c) => c.label).join(', ')}`);
  assert.ok(eval2.prompt.includes('既出 feedback') && eval2.prompt.includes(MAJOR_TOPIC), `eval#2 の prompt に既出 feedback（${MAJOR_TOPIC}）が無い`);
  assert.ok(eval2.prompt.includes('**新規の critical/major のみ報告**'), 'eval#2 の prompt に「新規の critical/major のみ報告」が無い');
  assert.ok(!eval2.prompt.includes('未解消 critical 一覧'), 'major だけのフィクスチャで未解消 critical 一覧が渡っている');
  assert.ok(
    !eval2.prompt.includes(EVALUATOR_OPERATIONAL_CONTRACT.critical_resolutions),
    '未解消 critical が無い eval#2 の prompt に EVALUATOR_OPERATIONAL_CONTRACT.critical_resolutions が入っている',
  );
});

test('[evaluator-contract] evaluator.md output example does not include schema-less score field', () => {
  assert.ok(!evaluatorMd.includes('"score"'), 'EVAL schema に無い score を evaluator.md の例に載せない');
});

test('[evaluator-contract] CONCERN_RESOLUTIONS is the closed 3-value enum', () => {
  assert.deepEqual(CONCERN_RESOLUTIONS, ['resolved', 'triaged', 'unresolved']);
});

test('[evaluator-contract] concern_resolutions contract mentions all 3 resolution values and {id, resolution, evidence}, not the legacy {id, resolved, evidence}', () => {
  const contract = EVALUATOR_OPERATIONAL_CONTRACT.concern_resolutions;
  for (const value of CONCERN_RESOLUTIONS) {
    assert.ok(contract.includes(value), `concern_resolutions 契約に '${value}' の説明が必要です`);
  }
  assert.ok(contract.includes('{id, resolution, evidence}'));
  assert.ok(!contract.includes('{id, resolved, evidence}'));
});

test('[normalizeConcernResolution] normalizes a well-formed triaged item', () => {
  const result = normalizeConcernResolution({ id: 'CONCERN-1', resolution: 'triaged', evidence: 'e' });
  assert.deepEqual(result, { id: 'CONCERN-1', resolution: 'triaged', evidence: 'e' });
});

test('[normalizeConcernResolution] missing evidence normalizes to null', () => {
  const result = normalizeConcernResolution({ id: 'CONCERN-1', resolution: 'unresolved' });
  assert.deepEqual(result, { id: 'CONCERN-1', resolution: 'unresolved', evidence: null });
});

test('[normalizeConcernResolution] legacy boolean key resolved throws', () => {
  assert.throws(
    () => normalizeConcernResolution({ id: 'CONCERN-1', resolved: true, evidence: 'e' }),
    /resolved/,
  );
});

test('[normalizeConcernResolution] out-of-enum resolution throws', () => {
  assert.throws(
    () => normalizeConcernResolution({ id: 'CONCERN-1', resolution: 'maybe', evidence: 'e' }),
    /out-of-enum/,
  );
});

test('[normalizeConcernResolution] missing id throws', () => {
  assert.throws(
    () => normalizeConcernResolution({ resolution: 'resolved', evidence: 'e' }),
  );
});

test('[normalizeConcernResolution] null input throws', () => {
  assert.throws(() => normalizeConcernResolution(null));
});

test('[normalizeConcernResolution] array input throws', () => {
  assert.throws(() => normalizeConcernResolution(['CONCERN-1', 'resolved', 'e']));
});

// ---- issue #1267: critical_resolutions の採用規則（Evaluate と Final AC reconcile が共有）----

const EVAL_A = { id: 'EVAL-1-authz-missing', source: 'evaluator', severity: 'critical', checked: false };
const EVAL_B = { id: 'EVAL-1-summary-format', source: 'evaluator', severity: 'critical', checked: false };
const CRIT_ITEMS = [
  EVAL_A, EVAL_B,
  { id: 'EVAL-1-already-done', source: 'evaluator', severity: 'critical', checked: true },
  { id: 'SEC-SECRETS', source: 'seed', dimension: 'security', severity: 'critical', checked: false },
  { id: 'TESTSURF-SKIP', source: 'seed', dimension: 'test-integrity', severity: 'critical', checked: false },
  { id: 'AC-FINAL-1', source: 'evaluator', dimension: 'ac', severity: 'critical', checked: false },
];
const ALL_IDS = CRIT_ITEMS.map((it) => it.id);

test('[acceptedCriticalResolutions] 渡した未 checked の EVAL-* に resolved:true + evidence → evidence 付きで採用', () => {
  const r = acceptedCriticalResolutions([{ id: EVAL_A.id, resolved: true, evidence: 'src/api.ts:12 で認可チェックを追加' }], [EVAL_A.id], CRIT_ITEMS);
  assert.deepEqual(r, [{ id: EVAL_A.id, evidence: 'src/api.ts:12 で認可チェックを追加' }]);
});

test('[acceptedCriticalResolutions] 渡していない id は resolved:true + evidence でも採用しない', () => {
  const r = acceptedCriticalResolutions([{ id: EVAL_B.id, resolved: true, evidence: 'src/s.ts:3' }], [EVAL_A.id], CRIT_ITEMS);
  assert.deepEqual(r, []);
});

test('[acceptedCriticalResolutions] evidence の無い resolved:true（欠落・空文字・空白のみ・非 string）は採用しない', () => {
  for (const evidence of [undefined, '', '   ', 42]) {
    const r = acceptedCriticalResolutions([{ id: EVAL_A.id, resolved: true, evidence }], [EVAL_A.id], CRIT_ITEMS);
    assert.deepEqual(r, [], `evidence=${JSON.stringify(evidence)}`);
  }
});

test('[acceptedCriticalResolutions] resolved:false は evidence があっても採用しない', () => {
  const r = acceptedCriticalResolutions([{ id: EVAL_A.id, resolved: false, evidence: '認可チェックがまだ無い' }], [EVAL_A.id], CRIT_ITEMS);
  assert.deepEqual(r, []);
});

test('[acceptedCriticalResolutions] SEC / TESTSURF / AC-FINAL-* / checked 済み / ledger に無い id は渡されていても採用しない', () => {
  const ids = ['SEC-SECRETS', 'TESTSURF-SKIP', 'AC-FINAL-1', 'EVAL-1-already-done', 'EVAL-9-unknown'];
  const r = acceptedCriticalResolutions(ids.map((id) => ({ id, resolved: true, evidence: 'ok' })), [...ALL_IDS, 'EVAL-9-unknown'], CRIT_ITEMS);
  assert.deepEqual(r, []);
});

test('[acceptedCriticalResolutions] 同じ id は最初に採用した 1 件だけ・入力順・null や配列でない入力は空', () => {
  const r = acceptedCriticalResolutions([
    null,
    { id: EVAL_B.id, resolved: true, evidence: 'b1' },
    { id: EVAL_A.id, resolved: true, evidence: 'a1' },
    { id: EVAL_B.id, resolved: true, evidence: 'b2' },
  ], ALL_IDS, CRIT_ITEMS);
  assert.deepEqual(r, [{ id: EVAL_B.id, evidence: 'b1' }, { id: EVAL_A.id, evidence: 'a1' }]);
  for (const input of [null, undefined, {}]) assert.deepEqual(acceptedCriticalResolutions(input, ALL_IDS, CRIT_ITEMS), []);
});

test('[acceptedCriticalResolutions] 入力を mutate しない', () => {
  const items = CRIT_ITEMS.map((it) => ({ ...it }));
  const resolutions = [{ id: EVAL_A.id, resolved: true, evidence: 'e' }];
  const before = JSON.stringify({ items, resolutions });
  acceptedCriticalResolutions(resolutions, [EVAL_A.id], items);
  assert.equal(JSON.stringify({ items, resolutions }), before);
});

test('[schema] pr-iterate REVIEW.issues enforces stable stuck-detection fields', () => {
  assert.match(
    prIterateSrc,
    /issues:\s*\{\s*type:\s*'array',\s*items:\s*\{\s*type:\s*'object',\s*required:\s*\['severity', 'topic', 'file', 'description', 'suggestion'\]/s,
    'pr-iterate REVIEW.issues は item schema と topic/file/description を required にする必要があります',
  );
});

// ---- issue #842: evaluator 出力の自然文欄は schema の maxLength で書き手に収めさせる ----

test('[evaluator-contract][#842] 自然文欄の字数上限は description 300 / suggestion 200 / evidence 200', () => {
  assert.deepEqual(
    { description: EVAL_DESCRIPTION_MAX, suggestion: EVAL_SUGGESTION_MAX, evidence: EVAL_EVIDENCE_MAX },
    { description: 300, suggestion: 200, evidence: 200 },
  );
});

test('[evaluator-contract][#842] evidence 上限は終端サマリーの解消済み折りたたみ表のセル上限（RESOLVED_CELL_MAX）以下', () => {
  assert.ok(EVAL_EVIDENCE_MAX <= RESOLVED_CELL_MAX,
    `EVAL_EVIDENCE_MAX ${EVAL_EVIDENCE_MAX} > RESOLVED_CELL_MAX ${RESOLVED_CELL_MAX} — 上限いっぱいの evidence が表で切られる`);
});

test('[evaluator-contract][#842] eval#i の EVAL schema と final-ac-reconcile の item_resolutions に maxLength が付く', async () => {
  const { ctx, calls } = makeSandbox({
    fixesApplied: 1,
    overrides: { 'test#final': { tests: 'passed', green: true, summary: '' } },
  });
  const { error } = await runWorkflowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'contract-eval-maxlength');
  const evalSchema = calls.find((c) => c.label === 'eval#1')?.schema;
  assert.ok(evalSchema, 'eval#1 の schema が取れない');
  const p = evalSchema.properties;
  const item = (k) => p[k].items.properties;
  assert.equal(item('feedback').description.maxLength, EVAL_DESCRIPTION_MAX);
  assert.equal(item('feedback').suggestion.maxLength, EVAL_SUGGESTION_MAX);
  for (const k of ['ac_results', 'security_clearance', 'testsurf_clearance', 'critical_resolutions', 'concern_resolutions']) {
    assert.equal(item(k).evidence.maxLength, EVAL_EVIDENCE_MAX, `${k}[].evidence`);
  }
  const finalSchema = calls.find((c) => c.label === 'final-ac-reconcile')?.schema;
  assert.ok(finalSchema, 'final-ac-reconcile の schema が取れない');
  assert.equal(finalSchema.properties.item_resolutions.items.properties.evidence.maxLength, EVAL_EVIDENCE_MAX);
  // resolution の enum は FINAL_ITEM_RESOLUTIONS（resolved / unresolved の 2 値。issue #1168）
  assert.equal(JSON.stringify(finalSchema.properties.item_resolutions.items.properties.resolution.enum), JSON.stringify(['resolved', 'unresolved']));
});

// ---- issue #1365: ac_results の各要素は AC の要旨 gist（必須・40 字以内）を持つ ----

test('[evaluator-contract][#1365] eval#i の EVAL schema と final-ac-reconcile の FINAL_AC schema で ac_results[].gist が required かつ maxLength 40', async () => {
  assert.equal(AC_GIST_MAX, 40);
  const { ctx, calls } = makeSandbox({
    fixesApplied: 1,
    overrides: { 'test#final': { tests: 'passed', green: true, summary: '' } },
  });
  const { error } = await runWorkflowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'contract-ac-gist');
  for (const label of ['eval#1', 'final-ac-reconcile']) {
    const items = calls.find((c) => c.label === label)?.schema?.properties?.ac_results?.items;
    assert.ok(items, `${label} の schema の ac_results.items が取れない`);
    assert.ok(items.required.includes('gist'), `${label}: gist が required でない（${JSON.stringify(items.required)}）`);
    assert.equal(items.properties.gist?.type, 'string', `${label}: gist の type`);
    assert.equal(items.properties.gist?.maxLength, 40, `${label}: gist の maxLength`);
  }
  // Final reconcile の evidence 必須は変えない
  assert.ok(calls.find((c) => c.label === 'final-ac-reconcile').schema.properties.ac_results.items.required.includes('evidence'));
});

test('[evaluator-contract][#1365] evaluator.md の ac_results の説明と final_ac_reconcile 契約に gist の書き方がある', () => {
  const section = evaluatorMd.slice(evaluatorMd.indexOf('## AC ごとの判定（ac_results）'), evaluatorMd.indexOf('## 書き方'));
  assert.match(section, new RegExp(`\`gist\`（必須）: その AC が何を求めているかの要旨を日本語 ${AC_GIST_MAX} 字以内で書く`));
  assert.match(section, /判定結果や根拠は書かない/);
  const example = evaluatorMd.slice(evaluatorMd.indexOf('## 出力 JSON'));
  assert.equal((example.match(/"gist": "/g) ?? []).length, (example.match(/"ac_index": /g) ?? []).length, '出力例の ac_results は全要素が gist を持つ');
  assert.ok(EVALUATOR_OPERATIONAL_CONTRACT.final_ac_reconcile.includes(`gist は AC の要旨（その AC が何を求めているか）を日本語 ${AC_GIST_MAX} 字以内で書く`));
});

test('[evaluator-contract][#842] evaluator.md の「書き方」の字数は schema の maxLength と一致する', () => {
  const section = evaluatorMd.slice(evaluatorMd.indexOf('## 書き方'), evaluatorMd.indexOf('## 出力 JSON'));
  assert.ok(section.includes(`\`description\` ${EVAL_DESCRIPTION_MAX} 字`), section);
  assert.ok(section.includes(`\`suggestion\` ${EVAL_SUGGESTION_MAX} 字`), section);
  assert.ok(section.includes(`各 \`evidence\` ${EVAL_EVIDENCE_MAX} 字`), section);
  assert.ok(section.includes(`\`gist\` ${AC_GIST_MAX} 字`), section);
  assert.ok(!section.includes('200 字程度'), '上限ではない目安の字数が残っている');
});

test('[evaluator-contract][#842] evaluator.md の「進め方」2 は validate_result があれば全件スイートを走らせず AC に関係するテストだけを走らせる', () => {
  const steps = evaluatorMd.slice(evaluatorMd.indexOf('## 進め方'), evaluatorMd.indexOf('## 判定'));
  const step2 = steps.slice(steps.indexOf('\n2. '), steps.indexOf('\n3. '));
  assert.ok(step2.includes('`validate_result`'), step2);
  assert.ok(step2.includes(`${EVAL_FULL_SUITE}は走らせず、AC に関係するテストファイルだけを実行して根拠にする`), step2);
});

// ---- issue #1366: 構成の変化の図を realized diff と照合した結果（diagram_check） ----

const DIAGRAM_STUB = { kind: 'flowchart', before: 'flowchart LR\n  A --> B', after: 'flowchart LR\n  A --> B\n  C --> B' };
const implWithDiagram = (diagram) => ({ status: 'DONE', task_id: 'issue-1', files: ['src/x.ts', 'src/y.ts', 'src/z.ts'], summary: 's', concerns: [], diagram });

async function evalCall(overrides = {}) {
  const { ctx, calls } = makeSandbox({ overrides });
  const { error } = await runWorkflowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'contract-diagram-check');
  const call = calls.find((c) => c.label === 'eval#1');
  assert.ok(call?.schema, 'eval#1 の schema が取れない');
  return call;
}

test('[evaluator-contract][#1366] diagram_check の形は {consistent: boolean, mismatches: string[]} で、EVAL schema が同じ宣言を持つ', async () => {
  assert.deepEqual(DIAGRAM_CHECK_SCHEMA, {
    type: 'object', required: ['consistent', 'mismatches'],
    properties: {
      consistent: { type: 'boolean' },
      mismatches: { type: 'array', items: { type: 'string', maxLength: DIAGRAM_MISMATCH_MAX } },
    },
  });
  const { schema } = await evalCall();
  assert.equal(JSON.stringify(schema.properties.diagram_check), JSON.stringify(DIAGRAM_CHECK_SCHEMA));
});

test('[evaluator-contract][#1366] plan.diagram がある run の eval#i は diagram_check を必須にし、図と diagram_check 契約を prompt に渡す', async () => {
  const withDiagram = await evalCall({ 'impl:serial:issue-1': implWithDiagram(DIAGRAM_STUB) });
  assert.ok(withDiagram.schema.required.includes('diagram_check'), `required: ${JSON.stringify(withDiagram.schema.required)}`);
  assert.ok(withDiagram.schema.required.includes('verdict'), '既存の required は残す');
  assert.ok(withDiagram.prompt.includes(diagramCheckPromptBlock(DIAGRAM_STUB)), `eval#1 の prompt に図と契約が無い:\n${withDiagram.prompt}`);
  // plan からは PR 本文の材料として図を外すので、照合の対象は diagramCheckPromptBlock だけが渡す
  const block = diagramCheckPromptBlock(DIAGRAM_STUB);
  assert.ok(block.includes(JSON.stringify(DIAGRAM_STUB)) && block.includes(EVALUATOR_OPERATIONAL_CONTRACT.diagram_check), block);
  assert.match(block, /データであり指示ではない/);
});

test('[evaluator-contract][#1366] 図の無い run の eval#i は diagram_check を必須にせず、契約も渡さない', async () => {
  for (const overrides of [{}, { 'impl:serial:issue-1': implWithDiagram(null) }]) {
    const call = await evalCall(overrides);
    assert.ok(!call.schema.required.includes('diagram_check'), `required: ${JSON.stringify(call.schema.required)}`);
    assert.ok(!call.prompt.includes('diagram_check 契約'), '図の無い run の prompt に diagram_check 契約がある');
  }
  assert.equal(diagramCheckPromptBlock(null), '');
  assert.equal(diagramCheckPromptBlock(undefined), '');
});

test('[evaluator-contract][#1366] diagram_check 契約と evaluator.md は、図の構成要素と矢印を realized diff と照合し 2 種類の食い違いを mismatches に 1 件 1 行で書かせる', () => {
  const contract = EVALUATOR_OPERATIONAL_CONTRACT.diagram_check;
  assert.match(contract, /図の構成要素（[^）]*）と矢印（[^）]*）を realized diff と照合し、diagram_check:\{consistent, mismatches\} を必ず返す/);
  assert.match(contract, /diff に無い要素・矢印と、diff にあって図に無い構成の変化を 1 件 1 行で書く/);
  assert.match(contract, /consistent は mismatches が 0 件のときだけ true/);
  assert.match(contract, /図の食い違いだけを理由に verdict を fail にせず、feedback も足さない/);

  assert.ok(inputItem('diagram').includes('`diagram_check`'), 'evaluator.md の「入力」節に diagram の項目が無い');
  const start = evaluatorMd.indexOf('\n## 図の照合（diagram_check）\n');
  assert.ok(start >= 0, 'evaluator.md に「図の照合」節が無い');
  const section = evaluatorMd.slice(start, evaluatorMd.indexOf('\n## ', start + 1)).replace(/\n +/g, '');
  assert.match(section, /\n1\. .*構成要素（[^）]*）と矢印（[^）]*）を拾う/);
  assert.match(section, /\n2\. .*realized diff と照合する/);
  assert.match(section, /\n3\. 次の 2 種類を `mismatches` に 1 件 1 行で書く/);
  assert.ok(section.includes('- diff に無い要素・矢印') && section.includes('- diff にあって図に無い構成の変化'), section);
  assert.match(section, /\n4\. `mismatches` が 0 件なら `consistent:true`、1 件でもあれば `consistent:false`/);
  assert.match(section, /差し戻しの理由にならない/);
  const writing = evaluatorMd.slice(evaluatorMd.indexOf('## 書き方'), evaluatorMd.indexOf('## 出力 JSON'));
  assert.ok(writing.includes(`\`mismatches\` の 1 件 ${DIAGRAM_MISMATCH_MAX} 字`), writing);
  assert.match(evaluatorMd.slice(evaluatorMd.indexOf('## 出力 JSON')), /"diagram_check": \{"consistent": false, "mismatches": \["/);
});
