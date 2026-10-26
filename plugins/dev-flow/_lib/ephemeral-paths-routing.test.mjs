// ephemeral-paths-routing: VM sandbox routing test for ephemeral path filter behavior.
//
// realized count（実効 shape の入力。issue #676）は filterEphemeralPaths 後の一覧のうち
// plan file_changes に宣言済みの件数のみで数える（diffDeclaredPaths で宣言外を除外）。
// 宣言外の non-ephemeral 変更は shape（size 信号）には混ぜず、
// 「micro でも Evaluate 強制 + 宣言外 concern を evaluator prompt へ注入」という
// 監査経路で扱う（宣言外は size 信号ではなく監査信号）。
//
// Tests:
//   (A) realized-diff が ephemeral 込みファイル一覧を返す → shape===micro かつ evaluator 0 回
//       (ephemeral を除外した non-ephemeral 2 件を dev-implementer stub の files に申告させ、宣言外 0 件にする
//        → classifyShape(req, 2) → micro → ephemeral による誤判定なし・undeclared=0 で Evaluate 強制もかからない)
//   (B) realized-diff が ephemeral 込み 8 件（non-ephemeral 6 件）→ shape==='complex'
//       (non-ephemeral 6 件を dev-implementer stub の files に申告させ、宣言外 0 件にする
//        → declared count=6 → classifyShape(req, 6) → complex)
//   (C) AC 5 件（standard）+ realized-diff stub が宣言外 ['u1.ts','u2.ts','u3.ts'] を返す
//       → evaluator#1 の prompt に集約パス列が 2 回出現（focus_areas + CONCERN-1）かつ u1.ts/u2.ts/u3.ts が全部その item 内に含まれる
//       (porcelain 統合後: realized-diff スナップショットが declared-path-check と同一参照。
//        AC 5 件は realized count に関わらず standard 以上で常に Evaluate を実行する。
//        issue #296 (F4) 以降: focus_areas の raw dump に加え、CONCERN-* item は未解消 concern 一覧
//        （concern_resolutions による resolve-with-evidence 経路）にも eval#1 から載るため、
//        同一 item のテキストが focus_areas / 未解消 concern 一覧の 2 箇所に出現し出現回数は 1→2 になる)
//   (D) realized-diff stub が ephemeral のみ ['evaluator.staged.md'] を返す
//       → filter 後 0 件 → 宣言外なし → '宣言外変更' が evaluator prompt に出現しない
//   (E) porcelain 取得 1 回ピン: realized-diff が 1 回 / declared-path-check が 0 回
//   (F) non-ephemeral 宣言外 1 件のみ → shape===micro（declared count=0）
//       だが evaluator >= 1 回・evaluator prompt に宣言外 concern が含まれる
//       (宣言外は size 信号ではなく監査信号であることの pin)

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { devFlowArgs, prerunAnalyze } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');
const src = readFileSync(devFlowPath, 'utf8');

// ---- VM sandbox helpers ----

/**
 * ephemeral-paths-routing 専用の VM sandbox を組む。
 * realized-shape-routing.test.mjs と同じく realized files / 申告 files を分けて渡す。
 * 相違点: calls 配列に { label, agentType, prompt } を記録する（prompt も記録するよう拡張）。
 *
 * porcelain 統合（F3, issue #219）後、さらに issue #544 (S1) で danger-grep(risk) /
 * realized-diff(files) / structural-classify(struct) / diff-hash-triage(hash) の 4 呼び出しが
 * diff-triage.sh 経由の単一呼び出し（label 'danger-grep' 据え置き）へ統合された。
 * files（旧 realized-diff・declared-path-check スナップショット）はその応答の files フィールドで得る。
 *
 * dev-implementer stub の files を declaredFiles で差し替え可能にする。
 * realized count は宣言済み変更のみで数えるため、shape を realized 件数で動かしたいシナリオ（A/B）では
 * realizedFiles の non-ephemeral 分をそのまま declaredFiles に渡す必要がある。
 * 省略時（デフォルト []）は従来どおり全て宣言外になる（C/D/E の宣言外監査シナリオ用）。
 *
 * @param {object} analyzeReq - analyze フェーズの agent が返す req オブジェクト（SHAPE を決定する）
 * @param {string[]} realizedFiles - label 'danger-grep' stub が files フィールドとして返すファイル一覧
 * @param {string[]} [declaredFiles] - dev-implementer stub が files として申告するファイル一覧
 * @returns {{ ctx: vm.Context, calls: Array<{label: string, agentType: string, prompt: string}> }}
 */
function makeCountingSandbox(analyzeReq, realizedFiles, declaredFiles = []) {
  const calls = [];

  const agentStub = async (prompt, opts) => {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';
    calls.push({ label, agentType, prompt: String(prompt) });

    // Setup(setup-base): base 解決 + 既存 worktree 起点検証 統合 probe（issue #550 案1）
    if (label === 'setup-base') {
      return { ok: true, default_branch: 'main', dev_exists: true, requested_exists: false, worktree_exists: false, upstream_remote: '', upstream_merge: '' };
    }
    if (label === 'worktree') {
      return { worktree: '/tmp/wt', branch: 'feature/issue-1' };
    }
    // label 'danger-grep'（issue #544 統合呼び出し）は risk/files を 1 応答で返す
    // （files は旧 realized-diff 相当のスナップショット）。
    if (label === 'danger-grep') {
      return { risk: { ok: true, hits: [] }, files: realizedFiles, struct: null, diffhash: null };
    }
    if (label === 'danger-grep-final') {
      return { ok: true, hits: [] };
    }
    if (label.startsWith('test')) {
      return { tests: 'no_tests', green: true, summary: '' };
    }
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
    if (label.startsWith('pr')) {
      return { pr_url: 'http://x', pr_number: 1, committed: true };
    }
    if (label === 'changed-files') {
      return { files: ['src/foo.ts'] };
    }
    if (agentType === 'dev-flow:dev-implementer') {
      return { status: 'DONE', task_id: 'issue-1', files: declaredFiles, summary: '', concerns: [] };
    }
    if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) {
      return { hash: 'H', empty: false };
    }
    return null;
  };

  const parallelStub = async (fns) => Promise.all((fns || []).map((f) => f()));

  const sandbox = {
    phase: () => {},
    log: () => {},
    agent: agentStub,
    parallel: parallelStub,
    pipeline: async (items, cb) => Promise.all((items || []).map(async (item, i) => { try { const r = await cb(item, i); return r === undefined ? null : r; } catch { return null; } })),
    workflow: async () => ({ status: 'lgtm', iterations: 1, fixes_applied: 0 }),
    // REQ は args.setup.analyze から組まれる（Analyze phase は spawn しない）
    args: devFlowArgs('1', { analyze: prerunAnalyze({ acceptance_criteria: analyzeReq.acceptance_criteria, issue_type: analyzeReq.issue_type }) }),
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
  return { ctx, calls };
}

/**
 * dev-flow.js ソースを strip して async IIFE でラップし vm sandbox で実行する。
 * return object を解決して返す。
 */
async function runDevFlowInSandbox(src, ctx) {
  const stripped = src
    .replace(/^export\s+const\s+/gm, 'const ')
    .replace(/^export\s+function\s+/gm, 'function ');
  const wrapped = '(async () => {\n' + stripped + '\n})();';

  let caughtError = null;
  let returned = null;
  try {
    const result = vm.runInContext(wrapped, ctx, { filename: '.claude/workflows/dev-flow.js' });
    if (result && typeof result.then === 'function') {
      returned = await result.catch((e) => {
        caughtError = e;
        return null;
      });
    }
  } catch (e) {
    caughtError = e;
  }
  return { error: caughtError, returned };
}

// ============================================================
// (A) realized-diff が ephemeral 込みファイル一覧を返す
//     → shape===micro かつ evaluator 0 回（ephemeral による shape 誤判定が再現しない — AC 2）
// ============================================================

test('[ephemeral-paths-routing] (A) realized ephemeral 3 件 non-ephemeral 2 件 → shape===micro evaluator 0 回', async () => {
  const microReq = {
    summary: 's',
    acceptance_criteria: ['a', 'b'],
    issue_type: 'fix',
    scope: 'src',
    issue_number: 1,
    issue_title: 'stub-issue-title',
  };

  const realizedFiles = [
    'a.md',
    'b.md',
    'evaluator.staged.md',
    'fm_3821.txt',
    '.devflow-tmp/handoff.json',
  ];

  // non-ephemeral 2 件（a.md, b.md）を plan file_changes に宣言する。
  // 宣言しないと宣言外（size 信号ではなく Evaluate 強制）で undeclared.length>0 になり
  // evaluator 0 回の assert が壊れる。
  const declaredFiles = ['a.md', 'b.md'];

  const { ctx, calls } = makeCountingSandbox(microReq, realizedFiles, declaredFiles);
  const { error, returned } = await runDevFlowInSandbox(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail('dev-flow.js が sandbox でクラッシュ: ' + error.name + ': ' + error.message);
  }

  const evaluatorCalls = calls.filter((c) => c.agentType === 'dev-flow:evaluator');
  assert.equal(
    evaluatorCalls.length,
    0,
    '(A) micro + ephemeral 3 件 + 宣言済み non-ephemeral 2 件: evaluator は 0 回のはずだが ' + evaluatorCalls.length + ' 回'
      + ' (ephemeral filter 後 non-ephemeral=2・宣言済みで undeclared=0 → classifyShape(req,2) → micro → runEval=false)',
  );

  assert.ok(returned !== null, '(A) workflow は return object を返すべきだが null だった');
  assert.strictEqual(
    returned && returned.shape,
    'micro',
    "(A) returned.shape は 'micro' のはずだが " + JSON.stringify(returned && returned.shape) + ' だった',
  );
  assert.strictEqual(returned && returned.realized_file_count, 2, '(A) ephemeral 3 件は realized count から除外される');
});

// ============================================================
// (B) realized-diff が ephemeral 込み 8 件（non-ephemeral 6 件）→ shape==='complex'
// ============================================================

test('[ephemeral-paths-routing] (B) realized ephemeral 2 件 non-ephemeral 6 件 → shape===complex', async () => {
  const microReq = {
    summary: 's',
    acceptance_criteria: ['a', 'b'],
    issue_type: 'fix',
    scope: 'src',
    issue_number: 1,
    issue_title: 'stub-issue-title',
  };

  const realizedFiles = [
    'src/a.ts',
    'src/b.ts',
    'src/c.ts',
    'src/d.ts',
    'src/e.ts',
    'src/f.ts',
    'evaluator.staged.md',
    'fm_9999.txt',
  ];

  // non-ephemeral 6 件を全て plan file_changes に宣言する。
  // 宣言しないと declared count=0 になり classifyShape(req,0)→micro のままで
  // complex にならない（この test の pin が壊れる）。
  const declaredFiles = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts', 'src/f.ts'];

  const { ctx, calls } = makeCountingSandbox(microReq, realizedFiles, declaredFiles);
  const { error, returned } = await runDevFlowInSandbox(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail('dev-flow.js が sandbox でクラッシュ: ' + error.name + ': ' + error.message);
  }

  const evaluatorCalls = calls.filter((c) => c.agentType === 'dev-flow:evaluator');
  assert.ok(
    evaluatorCalls.length >= 1,
    '(B) micro + 宣言済み non-ephemeral 6 件: evaluator は >= 1 回のはずだが ' + evaluatorCalls.length + ' 回'
      + ' (ephemeral filter 後・宣言済みで undeclared=0 → declared count=6 → classifyShape(req,6) → complex → runEval=true)',
  );

  assert.ok(returned !== null, '(B) workflow は return object を返すべきだが null だった');
  assert.strictEqual(
    returned && returned.shape,
    'complex',
    "(B) returned.shape は 'complex' のはずだが " + JSON.stringify(returned && returned.shape) + ' だった',
  );
  assert.strictEqual(returned && returned.realized_file_count, 6, '(B) ephemeral 2 件は realized count から除外される');
});

// ============================================================
// (C) AC 5 件（standard）+ realized-diff stub が宣言外 ['u1.ts','u2.ts','u3.ts'] を返す
//     → eval#1 の prompt に集約パス列が 2 回（focus_areas + CONCERN-1）/ u1.ts/u2.ts/u3.ts が全部含まれる
//     (porcelain 統合後: realized-diff スナップショットが declared-path-check と同一参照)
// ============================================================

test('[ephemeral-paths-routing] (C) standard + realized-diff 宣言外 3 件 → evaluator prompt に集約パス列が 2 回（focus_areas + 未解消 concern 一覧 CONCERN-1） + 全パス含む', async () => {
  const standardReq = {
    summary: 's',
    acceptance_criteria: ['a', 'b', 'c', 'd', 'e'],
    issue_type: 'feat',
    scope: 'src',
    issue_number: 1,
    issue_title: 'stub-issue-title',
  };

  // realized-diff が宣言外 3 件を返す（declaredFiles を省略 → dev-implementer stub の files は
  // 空のまま → diffDeclaredPaths で全て宣言外判定になる）。AC 5 件は realized count に関わらず
  // standard 以上で常に Evaluate を実行する。
  const realizedFiles = ['u1.ts', 'u2.ts', 'u3.ts'];

  const { ctx, calls } = makeCountingSandbox(standardReq, realizedFiles);
  const { error } = await runDevFlowInSandbox(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail('dev-flow.js が sandbox でクラッシュ: ' + error.name + ': ' + error.message);
  }

  const eval1Call = calls.find((c) => c.label === 'eval#1');
  assert.ok(eval1Call != null, '(C) evaluator eval#1 が呼ばれていない');

  const prompt1 = eval1Call.prompt;

  // 宣言外 3 件は 1 item に集約され、focus_areas と未解消 concern 一覧（CONCERN-1）の 2 箇所に載る
  // （issue #296）。文言ではなく、集約されたパス列（構造トークン）の出現回数と ledger id で観測する。
  const pathList = realizedFiles.join(', ');
  const matchCount = prompt1.split(pathList).length - 1;
  assert.equal(
    matchCount,
    2,
    '(C) evaluator eval#1 prompt の宣言外パス列 "' + pathList + '" の出現回数は 2 回のはずだが ' + matchCount + ' 回だった'
      + ' (1 item に集約された上で focus_areas + 未解消 concern 一覧の2箇所に載る。issue #296)',
  );
  assert.ok(prompt1.includes('CONCERN-1'), '(C) 宣言外 concern が CONCERN-1 として未解消 concern 一覧に載っていない');
  assert.ok(!prompt1.includes('CONCERN-2'), '(C) 宣言外 3 件が 1 item に集約されず複数 CONCERN になっている');

  for (const p of ['u1.ts', 'u2.ts', 'u3.ts']) {
    assert.ok(
      prompt1.includes(p),
      '(C) evaluator eval#1 prompt に ' + p + ' が含まれるはずだが見つからなかった',
    );
  }
});

// ============================================================
// (D) realized-diff stub が ephemeral のみ ['evaluator.staged.md'] を返す
//     → filter 後 0 件 → realized count 0 だが AC 5 件で standard → Evaluate 実行・宣言外なし
//     → '宣言外変更' が evaluator prompt に出現しない
// ============================================================

test('[ephemeral-paths-routing] (D) realized-diff が ephemeral のみ → "宣言外変更" が evaluator prompt に出現しない', async () => {
  const standardReq = {
    summary: 's',
    acceptance_criteria: ['a', 'b', 'c', 'd', 'e'],
    issue_type: 'feat',
    scope: 'src',
    issue_number: 1,
    issue_title: 'stub-issue-title',
  };

  // realized-diff が ephemeral のみを返す → filterEphemeralPaths 後 0 件 → 宣言外なし
  const realizedFiles = ['evaluator.staged.md'];

  const { ctx, calls } = makeCountingSandbox(standardReq, realizedFiles);
  const { error } = await runDevFlowInSandbox(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail('dev-flow.js が sandbox でクラッシュ: ' + error.name + ': ' + error.message);
  }

  const evalCalls = calls.filter((c) => c.agentType === 'dev-flow:evaluator');
  assert.ok(evalCalls.length >= 1, '(D) AC 5 件は standard なので evaluator が >= 1 回呼ばれるはず（0 回だと以下の検証が空振りする）');
  for (const c of evalCalls) {
    assert.ok(
      !c.prompt.includes('宣言外変更'),
      "(D) evaluator prompt に '宣言外変更' が出現してはいけないが含まれていた"
        + " (ephemeral のみ ['evaluator.staged.md'] は filter 後 0 件になるはず)",
    );
  }
});

// ============================================================
// (E) porcelain 取得 1 回ピン:
//     - label 'danger-grep'（issue #544 統合呼び出し）が 1 回だけ呼ばれる
//       （shape 判定 + declared-path 監査の両方が同一応答の files フィールドを参照）
//     - danger-grep が宣言外ファイルを返すと evaluator prompt に '宣言外変更' が出現する
//       （= shape 判定と宣言外監査が同一スナップショットを参照している実証）
// ============================================================

test('[ephemeral-paths-routing] (E) porcelain 取得 1 回ピン: danger-grep=1 / 宣言外ファイル→evaluator prompt に出現', async () => {
  const standardReq = {
    summary: 's',
    acceptance_criteria: ['a', 'b', 'c', 'd', 'e'],
    issue_type: 'feat',
    scope: 'src',
    issue_number: 1,
    issue_title: 'stub-issue-title',
  };

  // realized-diff が宣言外 1 件を返す（declaredFiles を省略 → dev-implementer stub の files は
  // 空のまま → diffDeclaredPaths で全て宣言外判定になる）
  const realizedFiles = ['undeclared-file.ts'];

  const { ctx, calls } = makeCountingSandbox(standardReq, realizedFiles);
  const { error } = await runDevFlowInSandbox(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail('dev-flow.js が sandbox でクラッシュ: ' + error.name + ': ' + error.message);
  }

  // porcelain 呼び出し 1 回ピン（issue #544 統合後は label 'danger-grep' が唯一の呼び出し）
  const dangerGrepCalls = calls.filter((c) => c.label === 'danger-grep');
  assert.equal(
    dangerGrepCalls.length,
    1,
    '(E) danger-grep は 1 回のはずだが ' + dangerGrepCalls.length + ' 回だった',
  );

  // danger-grep が宣言外ファイルを返すと evaluator prompt に宣言外ファイル名が出現する
  // （データ echo: shape 判定と宣言外監査が同一スナップショットを参照している実証。
  // 「宣言外変更」という日本語文言そのものの pin は言い回し変更で落ちるため撤去した — issue #636 AC-1）
  const eval1Call = calls.find((c) => c.label === 'eval#1');
  assert.ok(eval1Call != null, '(E) evaluator eval#1 が呼ばれていない');
  assert.ok(
    eval1Call.prompt.includes('undeclared-file.ts'),
    '(E) evaluator prompt に undeclared-file.ts が含まれるはずだが見つからなかった',
  );
});

// ============================================================
// (F) non-ephemeral 宣言外 1 件のみ
//     → shape===micro（declared count=0）だが
//       evaluator >= 1 回・evaluator prompt に宣言外 concern が含まれる
//     (宣言外は size 信号ではなく監査信号であることの pin — 原因(3) の中核)
// ============================================================

test('[ephemeral-paths-routing] (F) non-ephemeral 宣言外 1 件 → shape===micro だが evaluator >= 1 回 + 宣言外 concern を注入', async () => {
  const microReq = {
    summary: 's',
    acceptance_criteria: ['a', 'b'],
    issue_type: 'fix',
    scope: 'src',
    issue_number: 1,
    issue_title: 'stub-issue-title',
  };

  // non-ephemeral 宣言外 1 件のみ（declaredFiles を省略 → dev-implementer stub の files は
  // 空のまま → diffDeclaredPaths で全て宣言外判定になる → declared count=0 で micro だが、
  // undeclared.length>0 により micro でも Evaluate を強制する）
  const realizedFiles = ['leftover-handoff.md'];

  const { ctx, calls } = makeCountingSandbox(microReq, realizedFiles);
  const { error, returned } = await runDevFlowInSandbox(src, ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail('dev-flow.js が sandbox でクラッシュ: ' + error.name + ': ' + error.message);
  }

  assert.ok(returned !== null, '(F) workflow は return object を返すべきだが null だった');
  assert.strictEqual(
    returned && returned.shape,
    'micro',
    "(F) returned.shape は 'micro' のはずだが " + JSON.stringify(returned && returned.shape) + ' だった'
      + ' (declared count=0 → classifyShape(req,0) → micro。宣言外は size 信号にしない)',
  );

  const evaluatorCalls = calls.filter((c) => c.agentType === 'dev-flow:evaluator');
  assert.ok(
    evaluatorCalls.length >= 1,
    '(F) micro + 宣言外 non-ephemeral 1 件: evaluator は >= 1 回のはずだが ' + evaluatorCalls.length + ' 回'
      + ' (undeclared.length>0 → runEval=true で micro でも Evaluate を強制)',
  );

  // 宣言外は size 信号ではなく監査信号 — shape には混ぜず Evaluate 強制 + concern 注入で扱う
  // （データ echo で確認。「宣言外変更」という日本語文言そのものの pin は言い回し変更で落ちるため
  // 撤去した — issue #636 AC-1）
  const eval1Call = calls.find((c) => c.label === 'eval#1');
  assert.ok(eval1Call != null, '(F) evaluator eval#1 が呼ばれていない');
  assert.ok(
    eval1Call.prompt.includes('leftover-handoff.md'),
    '(F) evaluator prompt に leftover-handoff.md が含まれるはずだが見つからなかった',
  );
});
