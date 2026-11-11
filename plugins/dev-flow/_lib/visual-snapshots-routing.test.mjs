// repo が "dev-flow".visual_snapshots を宣言した run で、dev-flow-evaluate が Evaluate の各評価の前に基準画像を撮り直す経路を
// VM 実行で pin する（issue #1410）。
//
// worktree は一時の git repo で、撮影に関わる exec-proxy（worktree-diff-hash / local-verify start・wait・stop / PNG の一覧の
// git diff）は prompt の最終行のコマンドをその repo に対して実際に実行する。宣言コマンドは stub の shell コマンド
// （src/x.ts の中身を基準画像に写す — source が変わったときだけ PNG が変わる）、pg-broker は LOCAL_VERIFY_PG_BROKER の stub。
// 実装（dev-implementer）の変更は、stub が repo のファイルを書き換えて表す。それ以外の proxy は既定の応答のまま。
//   (C)  宣言のある run は eval#1 の前に撮影し、PNG は評価される tree に入る。PR 直前の diff hash の照合は一致する
//   (R)  評価の差し戻しで tree が変わったら次の評価の前に撮り直す (S) 変わらなければ撮らない
//   (N)  宣言の無い run は撮らない
//   (O)  コマンドが paths の外を書き換えたら、それも PNG も評価される tree と PR に入れず、理由を「画面の変化」に出す
//   (F*) コマンドの失敗（exit 非 0・timeout・DB を確保できない）は表示だけ。PNG を入れず、評価と PR は続け、merge tier は変えない
//   (G)  shape の判定の glob（_lib/diff-triage.mjs）と、撮影の後始末・PNG の一覧が使う git の pathspec が同じファイルに一致する

import { test, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash, devFlowArgs } from './test-helpers/vm-sandbox.mjs';
import { withoutVisualSnapshotPngs } from './diff-triage.mjs';
import { PR_BODY_VISUAL_HEADING } from './pr-artifacts.mjs';
import { VISUAL_SNAPSHOTS_UNRESTORED_NOTE, visualSnapshotsOutcome, visualSnapshotsReport } from './visual-snapshots.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = join(here, '..');
const src = readFileSync(join(pluginRoot, '.claude/workflows/dev-flow.js'), 'utf8');
const TIMEOUT = 120_000;

const tmpDirs = [];
afterAll(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

const git = (wt, ...argv) => execFileSync('git', ['-C', wt, ...argv], { encoding: 'utf8' }).trim();
const read = (wt, rel) => readFileSync(join(wt, rel), 'utf8');

// base（origin/main）に src/x.ts と基準画像 tests/visual/home.png を持つ worktree。.devflow-tmp は prerun と同じく info/exclude に置く
function makeWorktree() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'visual-snapshots-')));
  tmpDirs.push(root);
  const wt = join(root, 'wt');
  mkdirSync(join(wt, 'src'), { recursive: true });
  mkdirSync(join(wt, 'tests/visual'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', wt]);
  git(wt, 'config', 'user.name', 'Test');
  git(wt, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(wt, 'src/x.ts'), 'screen v1\n');
  writeFileSync(join(wt, 'tests/visual/home.png'), 'screen v1\n');
  git(wt, 'add', '-A');
  git(wt, 'commit', '-q', '-m', 'init');
  git(wt, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  writeFileSync(join(wt, '.git/info/exclude'), '.devflow-tmp\n');
  // pg-broker の stub（STUB_BROKER_DOWN があれば DB を確保できない）
  const broker = join(root, 'pg-broker');
  writeFileSync(broker, '#!/usr/bin/env bash\ncase "$1" in\n  create) [ -z "${STUB_BROKER_DOWN:-}" ] || { echo "pg-broker: cannot reach broker.sock" >&2; exit 1; }\n    echo \'{"id":"db1","database_url":"postgresql://app@localhost/app"}\' ;;\n  delete) echo \'{"deleted":true}\' ;;\nesac\n');
  chmodSync(broker, 0o755);
  return { root, wt, broker };
}

// source の中身を基準画像に写す撮影コマンド（source が変わったときだけ PNG が変わる）
const CAPTURE = 'mkdir -p tests/visual && cp src/x.ts tests/visual/home.png';
const declaration = (command = CAPTURE, o = {}) => ({
  command, db: { engine: 'postgres', version: '17' }, env: 'E2E_EXTERNAL_DATABASE_URL', timeout_seconds: 60, paths: ['tests/visual'], ...o,
});

// AC-1（agent の AC）を未達と返す eval（差し戻しを 1 回起こす）
const EVAL_AC1_UNSATISFIED = {
  verdict: 'fail', total: 50, threshold: 80, feedback: [], feedback_level: 'implementation',
  ac_results: [{ ac_index: 0, satisfied: false, verified_by: 'inspection', evidence: '未実装' }, { ac_index: 1, satisfied: true, verified_by: 'inspection', evidence: 'ok' }],
  security_clearance: [], concern_resolutions: [],
};

async function run({ visualSnapshots = declaration(), overrides = {}, env = {}, setup = () => {} } = {}) {
  const fx = makeWorktree();
  const { wt } = fx;
  // Implement: 実装が source を書き換えた（未コミット）
  writeFileSync(join(wt, 'src/x.ts'), 'screen v2\n');
  setup(fx);
  const procEnv = {
    ...process.env, ...env,
    PATH: `${join(pluginRoot, '..', 'playpark-core', 'bin')}:${join(pluginRoot, 'bin')}:${process.env.PATH}`,
    LOCAL_VERIFY_PG_BROKER: fx.broker, LOCAL_VERIFY_POLL_SEC: '0.1',
  };
  // prompt の最終行のコマンドを worktree に対して実際に実行する
  const exec = ({ prompt }) => spawnSync('bash', ['-c', prompt.split('\n').at(-1)], { encoding: 'utf8', env: procEnv, timeout: TIMEOUT });
  const execJson = (call) => {
    const r = exec(call);
    try { return JSON.parse(r.stdout.trim().split('\n').at(-1)); } catch { assert.fail(`${call.label}: stdout が JSON でない: ${JSON.stringify(r.stdout)} / stderr: ${r.stderr}`); }
    return null;
  };
  const execLines = (call) => {
    const r = exec(call);
    return r.status === 0 ? { ok: true, lines: r.stdout.split('\n').filter(Boolean) } : { ok: false, error: r.stderr };
  };
  const trees = {};
  const tree = (key) => (call) => { const out = execJson(call); (trees[key] ??= []).push(out.hash); return out; };
  const real = { 'diff-hash-eval': tree('eval'), 'diff-hash-pr': tree('pr'), 'visual-snapshots-list': execLines };
  for (let n = 1; n <= 4; n++) {
    real[`diff-hash-snapshot#${n}`] = tree('before');
    real[`diff-hash-snapshot-after#${n}`] = tree('after');
    real[`visual-snapshots-start#${n}`] = execJson;
    real[`visual-snapshots-stop#${n}`] = execJson;
    for (let k = 1; k <= 3; k++) real[`visual-snapshots-wait#${n}.${k}`] = execJson;
  }
  const { ctx, calls, logs } = makeDevFlowSandbox({
    overrides: { ...real, ...overrides },
    extra: { args: devFlowArgs(1, { worktree: wt, ...(visualSnapshots ? { visual_snapshots: visualSnapshots } : {}) }) },
  });
  const { result, error } = await runWorkflowCapture(src, ctx);
  assertNoCrash(error, 'visual-snapshots-routing');
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  const labels = calls.map((c) => c.label);
  const at = (label) => labels.indexOf(label);
  const prBody = calls.find((c) => c.label === 'pr#1')?.prompt ?? '';
  // PR に入る tree（phase PR の git add -A が stage するもの）= PR 直前の worktree の tree と origin/main の差分
  const prTree = trees.pr?.at(-1) ?? null;
  const prFiles = prTree ? git(wt, 'diff', '--name-only', 'origin/main', prTree).split('\n').filter(Boolean) : null;
  return { ...fx, result, calls, logs, labels, at, trees, prBody, prTree, prFiles };
}

const captureStarts = (labels) => labels.filter((l) => l.startsWith('visual-snapshots-start#'));
const visualSection = (prBody) => {
  const start = prBody.indexOf(`${PR_BODY_VISUAL_HEADING}\n`);
  return start < 0 ? null : prBody.slice(start, prBody.indexOf('\n\n', start));
};
const holdCodes = (result) => JSON.stringify(result.merge_tier_hold_reasons ?? []);

test('[visual-snapshots-routing] (C) 宣言のある run は eval#1 の前に撮影し、変わった PNG は評価される tree に入る。PR 直前の diff hash の照合は一致し HOLD にならない', async () => {
  const r = await run();
  assert.deepEqual(captureStarts(r.labels), ['visual-snapshots-start#1']);
  // tree を取る → 撮影（start → wait → stop）→ 評価の diff hash → eval#1 の順
  assert.ok(r.at('diff-hash-snapshot#1') < r.at('visual-snapshots-start#1') && r.at('visual-snapshots-stop#1') < r.at('diff-hash-eval') && r.at('diff-hash-eval') < r.at('eval#1'), r.labels.join(', '));
  // start には Setup で検証した宣言を渡し、head の worktree で実行する
  const start = r.calls.find((c) => c.label === 'visual-snapshots-start#1');
  assert.ok(start.prompt.split('\n').at(-1).startsWith(`local-verify start --worktree '${r.wt}' --state-dir '${r.wt}/.devflow-tmp/visual-snapshots' `), start.prompt);
  assert.equal(start.agentType, 'dev-flow:dev-runner-haiku');

  // 撮影が書き換えた PNG は worktree に残り、評価された tree（撮影前の tree とは別）に入っている
  assert.equal(read(r.wt, 'tests/visual/home.png'), 'screen v2\n');
  assert.notEqual(r.trees.eval[0], r.trees.before[0], '評価される tree が撮影前の tree のまま');
  assert.deepEqual(git(r.wt, 'diff', '--name-only', r.trees.before[0], r.trees.eval[0]).split('\n'), ['tests/visual/home.png']);

  // Evaluate と PR の間の diff hash の照合はそのまま成り立つ
  assert.equal(r.prTree, r.trees.eval.at(-1), 'PR 直前の tree が評価された tree と一致しない');
  assert.equal(r.result.eval_staleness, 'none');
  assert.ok(!holdCodes(r.result).includes('hash_mismatch'), holdCodes(r.result));
  assert.deepEqual(r.prFiles, ['src/x.ts', 'tests/visual/home.png']);

  // evaluator には、paths の下の PNG がパイプラインの撮り直した基準画像であることを伝える（宣言外変更として指摘させない）
  assert.ok(r.calls.find((c) => c.label === 'eval#1').prompt.includes('visual_snapshots: realized diff のうち ["tests/visual"] の下の PNG は、パイプラインが評価の前に撮影コマンドで撮り直した基準画像'), 'eval#1 の prompt に注記が無い');

  // PR 本文の「画面の変化」に PR の差分で変わった PNG を出す
  assert.ok(visualSection(r.prBody)?.includes('- `tests/visual/home.png`'), r.prBody);
  assert.ok(!visualSection(r.prBody).includes('⚠️'), visualSection(r.prBody));
}, TIMEOUT);

test('[visual-snapshots-routing] (R) 評価の差し戻しで tree が変わったら、次の評価の前に撮り直す（PNG は差し戻し後の source を写す）', async () => {
  let wt = null;
  const r = await run({
    setup: (fx) => { wt = fx.wt; },
    overrides: {
      'eval#1': EVAL_AC1_UNSATISFIED,
      // 差し戻しの実装が source を書き換える
      'reimpl#1:serial:issue-1': () => { writeFileSync(join(wt, 'src/x.ts'), 'screen v3\n'); return { status: 'DONE', task_id: 'issue-1', files: ['src/x.ts', 'src/y.ts', 'src/z.ts'], summary: 's', concerns: [] }; },
    },
  });
  assert.deepEqual(captureStarts(r.labels), ['visual-snapshots-start#1', 'visual-snapshots-start#2']);
  assert.ok(r.at('eval#1') < r.at('reimpl#1:serial:issue-1') && r.at('reimpl#1:serial:issue-1') < r.at('visual-snapshots-start#2') && r.at('visual-snapshots-stop#2') < r.at('eval#2'), r.labels.join(', '));
  assert.equal(read(r.wt, 'tests/visual/home.png'), 'screen v3\n');
  assert.equal(r.prTree, r.trees.eval.at(-1));
  assert.equal(r.result.eval_staleness, 'none');
  assert.deepEqual(r.prFiles, ['src/x.ts', 'tests/visual/home.png']);
}, TIMEOUT);

test('[visual-snapshots-routing] (S) 評価の差し戻しで tree が変わらなければ撮り直さない', async () => {
  const r = await run({ overrides: { 'eval#1': EVAL_AC1_UNSATISFIED } });
  assert.ok(r.labels.includes('reimpl#1:serial:issue-1') && r.labels.includes('eval#2'), r.labels.join(', '));
  // eval#2 の前にも tree は取るが、最後に撮影した tree と同じなので撮らない
  assert.ok(r.labels.includes('diff-hash-snapshot#2'), r.labels.join(', '));
  assert.equal(r.trees.before[1], r.trees.eval[0], '撮影後に tree が変わっている');
  assert.deepEqual(captureStarts(r.labels), ['visual-snapshots-start#1']);
  assert.ok(r.logs.some((l) => l.includes('eval#2 — tree が最後に撮影した tree と同じ（撮り直さない）')), r.logs.join('\n'));
}, TIMEOUT);

test('[visual-snapshots-routing] (N) 宣言の無い run は撮らない（tree も取らず、「画面の変化」も出さない）', async () => {
  const r = await run({ visualSnapshots: null });
  assert.deepEqual(r.labels.filter((l) => l.startsWith('visual-snapshots-') || l.startsWith('diff-hash-snapshot')), []);
  assert.equal(read(r.wt, 'tests/visual/home.png'), 'screen v1\n');
  assert.equal(visualSection(r.prBody), null);
  assert.ok(!r.calls.find((c) => c.label === 'eval#1').prompt.includes('visual_snapshots'));
}, TIMEOUT);

// 撮影の成否で merge tier・HOLD 理由が変わらないことを、同じ run の「撮影が通った」結果と比べて確かめる
async function baseline() {
  const r = await run();
  return { merge_tier: r.result.merge_tier, hold: holdCodes(r.result) };
}

test('[visual-snapshots-routing] (O) コマンドが paths の外のファイルを書き換えたら、それも PNG も評価される tree と PR に入れず、変わったパスを添えた理由を「画面の変化」に出す', async () => {
  const r = await run({ visualSnapshots: declaration(`${CAPTURE} && echo injected >> src/x.ts && echo y > extra.txt && echo n > tests/visual/notes.md`) });
  assert.deepEqual(captureStarts(r.labels), ['visual-snapshots-start#1']);

  // worktree は撮影前の状態に戻っている（PNG も、paths の外も、paths の下の PNG でないファイルも）
  assert.equal(read(r.wt, 'src/x.ts'), 'screen v2\n');
  assert.equal(read(r.wt, 'tests/visual/home.png'), 'screen v1\n');
  assert.ok(!existsSync(join(r.wt, 'extra.txt')) && !existsSync(join(r.wt, 'tests/visual/notes.md')));
  // 評価される tree と PR に入る tree は撮影前の tree のまま
  assert.equal(r.trees.eval[0], r.trees.before[0]);
  assert.equal(r.prTree, r.trees.before[0]);
  assert.deepEqual(r.prFiles, ['src/x.ts']);
  assert.equal(r.result.eval_staleness, 'none');

  // 評価と PR は続け、理由を「画面の変化」に出す
  assert.ok(r.labels.includes('eval#1') && r.labels.includes('pr#1'), r.labels.join(', '));
  const section = visualSection(r.prBody);
  assert.ok(section?.includes('⚠️ 撮影のコマンドが paths の下の PNG 以外を変えたため、この撮影の結果をすべて捨てた: '), r.prBody);
  for (const p of ['src/x.ts', 'extra.txt', 'tests/visual/notes.md']) assert.ok(section.includes(p), `${p} が理由に無い: ${section}`);
  assert.ok(!section.includes('- `tests/visual/home.png`') && !section.includes(VISUAL_SNAPSHOTS_UNRESTORED_NOTE), section);
  // 同じ tree では評価のたびに撮り直さない・merge tier は撮影が通った run と同じ
  assert.deepEqual({ merge_tier: r.result.merge_tier, hold: holdCodes(r.result) }, await baseline());
}, TIMEOUT);

test('[visual-snapshots-routing] (F1) コマンドが exit 非 0 → その撮影の PNG は入れず、評価と PR は続ける。理由を「画面の変化」に 1 行出し、merge tier・HOLD 理由は変えない', async () => {
  const r = await run({ visualSnapshots: declaration(`${CAPTURE}; exit 7`), overrides: { 'eval#1': EVAL_AC1_UNSATISFIED } });
  assert.equal(read(r.wt, 'tests/visual/home.png'), 'screen v1\n');
  assert.equal(r.trees.eval[0], r.trees.before[0]);
  assert.deepEqual(r.prFiles, ['src/x.ts']);
  assert.ok(r.labels.includes('eval#1') && r.labels.includes('eval#2') && r.labels.includes('pr#1'), r.labels.join(', '));
  // 失敗した tree は変わらないので、次の評価の前に同じコマンドを繰り返さない
  assert.deepEqual(captureStarts(r.labels), ['visual-snapshots-start#1']);
  const notes = visualSection(r.prBody)?.split('\n').filter((l) => l.startsWith('⚠️'));
  assert.deepEqual(notes, ['⚠️ 撮影のコマンドが exit 7 で失敗したため、この撮影の PNG は入れていない'], r.prBody);
  // 差し戻しにも使わない（差し戻しは eval#1 の AC 未達の 1 回だけ）
  assert.equal(r.labels.filter((l) => /^reimpl/.test(l)).length, 1, r.labels.join(', '));
  const ok = await run({ overrides: { 'eval#1': EVAL_AC1_UNSATISFIED } });
  assert.deepEqual({ merge_tier: r.result.merge_tier, hold: holdCodes(r.result) }, { merge_tier: ok.result.merge_tier, hold: holdCodes(ok.result) });
}, TIMEOUT);

test('[visual-snapshots-routing] (F2) コマンドが上限時間を超えた → 止めて PNG は入れず、評価と PR は続ける', async () => {
  const r = await run({ visualSnapshots: declaration(`${CAPTURE}; sleep 300`, { timeout_seconds: 1 }) });
  assert.equal(read(r.wt, 'tests/visual/home.png'), 'screen v1\n');
  assert.deepEqual(r.prFiles, ['src/x.ts']);
  assert.ok(r.labels.includes('eval#1') && r.labels.includes('pr#1'), r.labels.join(', '));
  assert.ok(visualSection(r.prBody)?.includes('⚠️ 撮影のコマンドが上限時間（1 秒）を超えて止められたため、この撮影の PNG は入れていない'), r.prBody);
  assert.deepEqual({ merge_tier: r.result.merge_tier, hold: holdCodes(r.result) }, await baseline());
}, TIMEOUT);

test('[visual-snapshots-routing] (F3) 使い捨て DB を確保できない → コマンドを実行せず、評価と PR は続ける', async () => {
  const r = await run({ env: { STUB_BROKER_DOWN: '1' } });
  assert.equal(read(r.wt, 'tests/visual/home.png'), 'screen v1\n');
  assert.deepEqual(r.prFiles, ['src/x.ts']);
  assert.ok(r.labels.includes('eval#1') && r.labels.includes('pr#1'), r.labels.join(', '));
  assert.ok(visualSection(r.prBody)?.includes('⚠️ 使い捨ての DB を確保できなかったため撮影できなかった（pg-broker: cannot reach broker.sock）'), r.prBody);
  assert.deepEqual({ merge_tier: r.result.merge_tier, hold: holdCodes(r.result) }, await baseline());
}, TIMEOUT);

test('[visual-snapshots-routing] (F4) proxy の応答が無い・戻し切れていない撮影は、その旨を理由に足す（評価と PR は続ける）', async () => {
  // local-verify の応答が取れない（null）。worktree は撮影前のまま
  const lost = await run({ overrides: { 'visual-snapshots-start#1': null } });
  assert.ok(lost.labels.includes('visual-snapshots-stop#1') && lost.labels.includes('eval#1') && lost.labels.includes('pr#1'), lost.labels.join(', '));
  assert.ok(visualSection(lost.prBody)?.includes('⚠️ 撮影の結果を取得できなかったため、この撮影の PNG は入れていない'), lost.prBody);
  // 終了後の tree を取り直して撮影前と比べ、同じなら「戻し切れていない」とは書かない
  assert.deepEqual(lost.trees.after, [lost.trees.before[0]]);
  assert.ok(!visualSection(lost.prBody).includes(VISUAL_SNAPSHOTS_UNRESTORED_NOTE));
  // 取り直した tree が撮影前と違えば、戻し切れていない旨を足す
  const dirty = await run({ overrides: { 'visual-snapshots-start#1': null, 'diff-hash-snapshot-after#1': { hash: 'f'.repeat(40), empty: false } } });
  assert.ok(visualSection(dirty.prBody)?.includes(`この撮影の PNG は入れていない（proxy の応答が無い・形が不正）${VISUAL_SNAPSHOTS_UNRESTORED_NOTE}`), dirty.prBody);
  assert.ok(dirty.labels.includes('eval#1') && dirty.labels.includes('pr#1'), dirty.labels.join(', '));

  // 判定の純関数: 結果を捨てたのに戻せなかった（restored:false）は restored を返し、呼び出し側が注記を足す
  const failed = { ok: false, status: 'failed', exit_code: 1, snapshot: { tree_before: 'A', tree: 'B', discarded: true, restored: false, outside: [], outside_count: 0 } };
  assert.deepEqual(visualSnapshotsOutcome(failed, 'failed', 60), { captured: false, tree: 'B', restored: false, note: '撮影のコマンドが exit 1 で失敗したため、この撮影の PNG は入れていない' });
  assert.deepEqual(visualSnapshotsOutcome({ ok: true, status: 'passed', exit_code: 0, snapshot: { tree_before: 'A', tree: 'B', discarded: false, restored: null, outside: [], outside_count: 0 } }, 'passed', 60), { captured: true, tree: 'B', restored: null, note: null });
  // paths の外のパスは先頭 5 件を並べ、残りは件数にする
  const many = { ok: false, status: 'failed', exit_code: 0, snapshot: { tree_before: 'A', tree: 'A', discarded: true, restored: true, outside: ['a', 'b', 'c', 'd', 'e', 'f'], outside_count: 30 } };
  assert.equal(visualSnapshotsOutcome(many, 'failed', 60).note, '撮影のコマンドが paths の下の PNG 以外を変えたため、この撮影の結果をすべて捨てた: a, b, c, d, e ほか 25 件');
  // 一覧が取れなかった run は、その旨を理由に足す
  assert.deepEqual(visualSnapshotsReport(null, null), { changed: [], notes: ['変わった基準画像の一覧を取得できなかった（Files changed で確かめる）'] });
  assert.deepEqual(visualSnapshotsReport({ ok: true, lines: ['a.png', 'a.png', ''] }, null), { changed: ['a.png'], notes: [] });
}, TIMEOUT);

test('[visual-snapshots-routing] (G) shape の判定の glob と、撮影の後始末・PNG の一覧が使う git の pathspec（:(glob)<path>/**/*.png）は同じファイルに一致する', () => {
  const { wt } = makeWorktree();
  const files = [
    'tests/visual/home.png', 'tests/visual/a/b/deep.png', 'tests/visual/notes.md', 'tests/visual/x.PNG', 'tests/visual/.hidden/h.png',
    'apps/web/e2e/__screenshots__/a.png', 'apps/admin/e2e/__screenshots__/chromium/b.png', 'apps/web/src/e2e/__screenshots__/c.png',
    'packages/ui/src/__screenshots__/d.png', '__screenshots__/e.png', 'shots.v1/f.png', 'shotsXv1/g.png', 'shots[1]/h.png', 'top.png',
  ];
  for (const f of files) {
    mkdirSync(dirname(join(wt, f)), { recursive: true });
    writeFileSync(join(wt, f), 'x');
  }
  git(wt, 'add', '-A');
  const tracked = git(wt, '-c', 'core.quotePath=false', 'ls-files').split('\n');
  for (const paths of [['tests/visual'], ['tests/visual/'], ['apps/*/e2e/__screenshots__'], ['**/__screenshots__'], ['packages/**'], ['shots.v1'], ['shots?v1'], ['shots[.X]v1'], ['tests/**', 'apps/web']]) {
    const byGit = git(wt, '-c', 'core.quotePath=false', 'ls-files', '--', ...paths.map((p) => `:(top,glob)${p.replace(/\/+$/, '')}/**/*.png`)).split('\n').filter(Boolean).sort();
    const kept = withoutVisualSnapshotPngs(tracked, paths);
    assert.deepEqual(tracked.filter((f) => !kept.includes(f)).sort(), byGit, `paths ${JSON.stringify(paths)}`);
  }
});
