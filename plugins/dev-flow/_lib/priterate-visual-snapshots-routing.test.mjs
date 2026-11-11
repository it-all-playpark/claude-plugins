// repo が "dev-flow".visual_snapshots を宣言した run で、pr-iterate が各 review の前に基準画像を撮り直す経路を VM 実行で pin する
// （issue #1412）。
//
// worktree は一時の git repo（origin/main と PR の head branch feature/x）。tree の取得（worktree-diff-hash）・撮影
// （local-verify start / wait / stop）・PNG の一覧（git diff）は prompt の最終行のコマンドをその repo に対して実際に実行する。
// 宣言コマンドは stub の shell コマンド（src/x.ts の中身を基準画像に写す — source が変わったときだけ PNG が変わる）。
// 撮り直しの commit（visual-snapshots-commit#i）と取り消し（visual-snapshots-revert#i）は、prompt に書かれた git コマンドを
// stub がそのまま実行する（push は origin/feature/x の ref を進めることで表す）。pr-fixer の修正と conflict の自動解決は、
// stub が source を書き換えて commit する。
//   (F)  pr-fixer の修正の後: 次の review の前に撮り直して push する (C) conflict の自動解決の後も同じ
//   (S)  tree が変わらないラウンドは撮らない (N) 宣言の無い run は tree も取らない
//   (1)  単体起動の最初（撮影した tree が無い）は撮影する。PR 本文は書き換えず、終了レポートに一覧を出す
//   (H)  撮り直しの commit を push した後の review・ci-check・security review は、その commit を含む head を対象にする
//   (X*) 撮影・commit・push の失敗は表示だけ（fail-open）。撮り直しの前に戻し、status は変えない
//   (M)  最後の修正の push の後に上限で終わった run は撮り直さず、「最終の画面は撮り直せていない」と出す
//   (D)  dev-flow は宣言と Evaluate が最後に撮影した tree を pr-iterate に渡し、作り直す PR 本文に最終の一覧を載せる

import { test, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makePrIterateSandbox, makeDevFlowSandbox, runWorkflowCapture, assertNoCrash, ciCounts } from './test-helpers/vm-sandbox.mjs';
import { DEV_FLOW_SCENARIOS } from './test-helpers/dev-flow-scenarios.mjs';
import { VISUAL_SNAPSHOTS_STALE_NOTE, VISUAL_SNAPSHOTS_COMMIT_SUBJECT } from './visual-snapshots.mjs';
import { PR_BODY_VISUAL_HEADING } from './pr-artifacts.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = join(here, '..');
const prIterateSrc = readFileSync(join(pluginRoot, '.claude/workflows/pr-iterate.js'), 'utf8');
const devFlowSrc = readFileSync(join(pluginRoot, '.claude/workflows/dev-flow.js'), 'utf8');
const TIMEOUT = 120_000;

const tmpDirs = [];
afterAll(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

const git = (wt, ...argv) => execFileSync('git', ['-C', wt, ...argv], { encoding: 'utf8' }).trim();
const read = (wt, rel) => readFileSync(join(wt, rel), 'utf8');
const PNG = 'tests/visual/home.png';

// source の中身を基準画像に写す撮影コマンド（source が変わったときだけ PNG が変わる）
const CAPTURE = 'mkdir -p tests/visual && cp src/x.ts tests/visual/home.png';
const declaration = (command = CAPTURE) => ({
  command, db: { engine: 'postgres', version: '17' }, env: 'E2E_EXTERNAL_DATABASE_URL', timeout_seconds: 60, paths: ['tests/visual'],
});

// origin/main に src/x.ts と基準画像（どちらも v1）、PR の head branch feature/x は source を v2 にした commit を持つ worktree。
// captured:true なら基準画像も v2（Evaluate が撮り直して PR に入れた）、false なら v1 のまま（撮影していない PR）。
function makeWorktree({ captured }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'priterate-visual-')));
  tmpDirs.push(root);
  const wt = join(root, 'wt');
  mkdirSync(join(wt, 'src'), { recursive: true });
  mkdirSync(join(wt, 'tests/visual'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', wt]);
  git(wt, 'config', 'user.name', 'Test');
  git(wt, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(wt, 'src/x.ts'), 'screen v1\n');
  writeFileSync(join(wt, PNG), 'screen v1\n');
  git(wt, 'add', '-A');
  git(wt, 'commit', '-q', '-m', 'init');
  git(wt, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(wt, 'checkout', '-q', '-b', 'feature/x');
  writeFileSync(join(wt, 'src/x.ts'), 'screen v2\n');
  if (captured) writeFileSync(join(wt, PNG), 'screen v2\n');
  git(wt, 'add', '-A');
  git(wt, 'commit', '-q', '-m', 'feat: screen v2');
  git(wt, 'update-ref', 'refs/remotes/origin/feature/x', 'HEAD');
  writeFileSync(join(wt, '.git/info/exclude'), '.devflow-tmp\n');
  const broker = join(root, 'pg-broker');
  writeFileSync(broker, '#!/usr/bin/env bash\ncase "$1" in\n  create) echo \'{"id":"db1","database_url":"postgresql://app@localhost/app"}\' ;;\n  delete) echo \'{"deleted":true}\' ;;\nesac\n');
  chmodSync(broker, 0o755);
  return { root, wt, broker };
}

const BLOCKING = { decision: 'request-changes', issues: [{ severity: 'major', topic: 'screen-copy', file: 'src/x.ts', description: '文言が違う', suggestion: '直す' }], summary: '要修正' };
const APPROVE = { decision: 'approve', issues: [], summary: 'ok' };

async function run({ captured = true, caller = 'dev-flow', decl = declaration(), passTree = caller === 'dev-flow', overrides = () => ({}), args = {}, baseRef = 'main' } = {}) {
  const fx = makeWorktree({ captured });
  const { wt } = fx;
  const procEnv = {
    ...process.env,
    PATH: `${join(pluginRoot, '..', 'playpark-core', 'bin')}:${join(pluginRoot, 'bin')}:${process.env.PATH}`,
    LOCAL_VERIFY_PG_BROKER: fx.broker, LOCAL_VERIFY_POLL_SEC: '0.1',
  };
  const head = () => git(wt, 'rev-parse', 'HEAD');
  const sh = (command) => spawnSync('bash', ['-c', command], { cwd: wt, encoding: 'utf8', env: procEnv, timeout: TIMEOUT });
  // prompt の最終行のコマンドを worktree に対して実際に実行する
  const execJson = (call) => {
    const r = sh(call.prompt.split('\n').at(-1));
    try { return JSON.parse(r.stdout.trim().split('\n').at(-1)); } catch { assert.fail(`${call.label}: stdout が JSON でない: ${JSON.stringify(r.stdout)} / stderr: ${r.stderr}`); }
    return null;
  };
  const execLines = (call) => {
    const r = sh(call.prompt.split('\n').at(-1));
    return r.status === 0 ? { ok: true, lines: r.stdout.split('\n').filter(Boolean) } : { ok: false, error: r.stderr };
  };
  const treeNow = () => JSON.parse(sh(`worktree-diff-hash '${wt}' HEAD`).stdout.trim()).hash;
  // 実装・自動解決が source を書き換えて commit し、push する（origin/feature/x を進める）
  const commitSource = (content, message) => {
    writeFileSync(join(wt, 'src/x.ts'), content);
    git(wt, 'commit', '-q', '-am', message);
    git(wt, 'update-ref', 'refs/remotes/origin/feature/x', 'HEAD');
    return head();
  };
  // 撮り直しの commit: prompt に書かれた git add / git commit をそのまま実行する。pushed:false は push の失敗（origin を進めない）
  const commitSnapshots = ({ pushed = true } = {}) => ({ prompt }) => {
    const head_before = head();
    const commands = [...prompt.matchAll(/`(git (?:add|commit) [^`]*)`/g)].map((m) => m[1]);
    assert.equal(commands.length, 2, `撮り直しの commit の prompt に git add と git commit が 1 つずつ無い:\n${prompt}`);
    for (const command of commands) {
      if (sh(command).status !== 0) return { head_before, committed: false, pushed: false, head_sha: head() };
    }
    if (pushed) git(wt, 'update-ref', 'refs/remotes/origin/feature/x', 'HEAD');
    return {
      head_before, committed: true, pushed, head_sha: head(),
      push_result: { status: pushed ? 'passed' : 'failed', exit_code: pushed ? 0 : 1, log: `${wt}/.devflow-tmp/push-output.log`, tail: pushed ? '' : 'pre-push hook failed' },
    };
  };
  // 取り消し: prompt に書かれた git reset / git restore をそのまま実行する
  const revertSnapshots = ({ prompt }) => {
    const commands = [...prompt.matchAll(/`(git (?:reset|restore) [^`]*)`/g)].map((m) => m[1]);
    assert.equal(commands.length, 2, `取り消しの prompt に git reset と git restore が 1 つずつ無い:\n${prompt}`);
    for (const command of commands) {
      const r = sh(command);
      if (r.status !== 0) return { ok: false, error: r.stderr };
    }
    return { ok: true };
  };
  const tools = { wt, head, treeNow, commitSource, commitSnapshots, revertSnapshots };
  const real = { 'diff-hash-snapshot-final': execJson, 'visual-snapshots-list': execLines };
  for (let n = 1; n <= 4; n++) {
    real[`diff-hash-snapshot#${n}`] = execJson;
    real[`diff-hash-snapshot-after#${n}`] = execJson;
    real[`diff-hash-snapshot-reverted#${n}`] = execJson;
    real[`visual-snapshots-start#${n}`] = execJson;
    real[`visual-snapshots-stop#${n}`] = execJson;
    for (let k = 1; k <= 3; k++) real[`visual-snapshots-wait#${n}.${k}`] = execJson;
    real[`visual-snapshots-changed#${n}`] = execLines;
    real[`visual-snapshots-commit#${n}`] = commitSnapshots();
    real[`visual-snapshots-revert#${n}`] = revertSnapshots;
    // fix の後の commit 保証: fix の stub が commit・push 済みなので clean。head は実際の HEAD
    real[`commit-ensure#${n}`] = () => ({ dirty: false, committed: false, pushed: false, head_sha: head() });
    // 並列の ci-check は、起動した時点の PR head の結果を返す
    real[`ci-check#${n}`] = () => ({ status: 'passed', ...ciCounts('passed'), failed_checks: [], head_sha: head() });
  }
  const headAtStart = head();
  const treeAtStart = treeNow();
  const { ctx, calls, logs } = makePrIterateSandbox({
    overrides: { ...real, ...overrides(tools) },
    args: {
      pr: 5,
      nested: { caller, cwd: wt, head_ref: 'feature/x', base_ref: baseRef, head_sha: headAtStart, repo: 'acme/skills' },
      ...(decl ? { visual_snapshots: decl } : {}),
      ...(decl && passTree ? { visual_snapshots_tree: treeAtStart } : {}),
      ...args,
    },
  });
  const { result, error } = await runWorkflowCapture(prIterateSrc, ctx, '.claude/workflows/pr-iterate.js');
  assertNoCrash(error, 'priterate-visual-snapshots-routing');
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  const labels = calls.map((c) => c.label);
  return {
    ...fx, ...tools, headAtStart, treeAtStart, calls, logs, labels,
    result: JSON.parse(JSON.stringify(result)),
    at: (label) => labels.indexOf(label),
    prompt: (label) => calls.find((c) => c.label === label)?.prompt ?? '',
    originHead: () => git(wt, 'rev-parse', 'refs/remotes/origin/feature/x'),
  };
}

const captureStarts = (labels) => labels.filter((l) => l.startsWith('visual-snapshots-start#'));
const snapshotCommits = (labels) => labels.filter((l) => /^visual-snapshots-commit#\d+$/.test(l));
// 撮り直しの commit（HEAD）が「画面の変化（撮り直し）」の commit で、変えたのは基準画像の PNG だけであること
function assertSnapshotCommit(r, sha) {
  assert.ok(git(r.wt, 'log', '-1', '--format=%s', sha).includes(VISUAL_SNAPSHOTS_COMMIT_SUBJECT), git(r.wt, 'log', '-1', '--format=%s', sha));
  assert.deepEqual(git(r.wt, 'diff', '--name-only', `${sha}~1`, sha).split('\n'), [PNG]);
  assert.equal(r.originHead(), sha, '撮り直しの commit が PR ブランチに push されていない');
}

test('[priterate-visual-snapshots] (F) pr-fixer の修正の後: 次の review の前に、修正後の tree で撮り直し、変わった PNG を「画面の変化（撮り直し）」の commit として push する', async () => {
  const r = await run({
    overrides: ({ commitSource }) => ({
      'review#1': BLOCKING,
      'fix#1': () => { commitSource('screen v3\n', 'fix: screen v3'); return { applied: true, files: ['src/x.ts'], summary: 'fixed', deferred_security_ids: [] }; },
    }),
  });
  assert.equal(r.result.status, 'lgtm');
  // round 1 は Evaluate が撮影した tree のままなので撮らない。round 2 の review の前にだけ撮り直す
  assert.deepEqual(captureStarts(r.labels), ['visual-snapshots-start#1']);
  assert.deepEqual(snapshotCommits(r.labels), ['visual-snapshots-commit#2']);
  assert.ok(r.at('diff-hash-snapshot#1') < r.at('review#1'), r.labels.join(', '));
  assert.ok(r.at('fix#1') < r.at('diff-hash-snapshot#2') && r.at('diff-hash-snapshot#2') < r.at('visual-snapshots-start#1')
    && r.at('visual-snapshots-stop#1') < r.at('visual-snapshots-commit#2') && r.at('visual-snapshots-commit#2') < r.at('review#2'), r.labels.join(', '));
  // 撮影は head の worktree に対して、渡された宣言で実行する
  const start = r.prompt('visual-snapshots-start#1').split('\n').at(-1);
  assert.ok(start.startsWith(`local-verify start --worktree '${r.wt}' --state-dir '${r.wt}/.devflow-tmp/visual-snapshots' `), start);
  // tree と一覧は read-only の proxy、撮影と commit は書き込める proxy に渡す
  const agentOf = (label) => r.calls.find((c) => c.label === label)?.agentType;
  for (const label of ['diff-hash-snapshot#2', 'diff-hash-snapshot-final', 'visual-snapshots-list']) assert.equal(agentOf(label), 'dev-flow:dev-runner-haiku-ro', label);
  for (const label of ['visual-snapshots-start#1', 'visual-snapshots-commit#2']) assert.equal(agentOf(label), 'dev-flow:dev-runner-haiku', label);

  // PR head は撮り直しの commit で、基準画像は修正後の source を写している
  const head = r.head();
  assertSnapshotCommit(r, head);
  assert.equal(read(r.wt, PNG), 'screen v3\n');
  assert.equal(git(r.wt, 'status', '--porcelain'), '');
  // 撮り直しの commit も fixes_applied に数える（dev-flow が最終 tree の test を取り直し、PR 本文を作り直す）
  assert.equal(r.result.fixes_applied, 2);
  // 一覧は最終の head の PR の差分から作る。最後に撮影した tree は最終の tree なので、撮り直せていない旨は出さない
  assert.deepEqual(r.result.visual_snapshots, { changed: [PNG], notes: [] });
}, TIMEOUT);

test('[priterate-visual-snapshots] (P) 宣言の paths の一部に PNG が無くても、撮り直しの commit・push と取り消しは PNG の変わった path だけで行う', async () => {
  const decl = { ...declaration(), paths: ['tests/visual', 'tests/none'] };
  const fixToV3 = ({ commitSource }) => ({
    'review#1': BLOCKING,
    'fix#1': () => { commitSource('screen v3\n', 'fix: screen v3'); return { applied: true, files: ['src/x.ts'], summary: 'fixed', deferred_security_ids: [] }; },
  });
  const r = await run({ decl, overrides: fixToV3 });
  assert.equal(r.result.status, 'lgtm');
  assert.deepEqual(snapshotCommits(r.labels), ['visual-snapshots-commit#2']);
  assert.ok(r.at('visual-snapshots-stop#1') < r.at('visual-snapshots-changed#2') && r.at('visual-snapshots-changed#2') < r.at('visual-snapshots-commit#2'), r.labels.join(', '));
  const commitPrompt = r.prompt('visual-snapshots-commit#2');
  assert.ok(!commitPrompt.includes('tests/none'), commitPrompt);
  // PR の head branch 名は単一引用符で 1 引数に閉じる（ブランチ名の $(…) をシェルに展開させない）
  assert.ok(commitPrompt.includes(`rev-list 'origin/feature/x..HEAD' --count`), commitPrompt);
  assertSnapshotCommit(r, r.head());
  assert.equal(read(r.wt, PNG), 'screen v3\n');
  assert.deepEqual(r.result.visual_snapshots, { changed: [PNG], notes: [] });

  // push に失敗した commit の取り消しも、PNG の無い path に阻まれずに撮り直しの前へ戻す
  let fixSha = null;
  const x = await run({
    decl,
    overrides: (tools) => ({
      ...fixToV3(tools),
      'fix#1': () => { fixSha = tools.commitSource('screen v3\n', 'fix: screen v3'); return { applied: true, files: ['src/x.ts'], summary: 'fixed', deferred_security_ids: [] }; },
      'visual-snapshots-commit#2': tools.commitSnapshots({ pushed: false }),
    }),
  });
  assert.ok(x.labels.includes('visual-snapshots-revert#2'), x.labels.join(', '));
  assert.ok(!x.prompt('visual-snapshots-revert#2').includes('tests/none'), x.prompt('visual-snapshots-revert#2'));
  assert.equal(x.head(), fixSha);
  assert.equal(read(x.wt, PNG), 'screen v2\n');
  assert.equal(git(x.wt, 'status', '--porcelain'), '');
}, TIMEOUT);

test('[priterate-visual-snapshots] (Q) 終了時の一覧取得は PR の base branch 名を単一引用符で 1 引数に閉じ、名前の $(…) をシェルに展開させない', async () => {
  const marker = join(mkdtempSync(join(tmpdir(), 'vs-base-')), 'pwn');
  const base = `base/$(touch${'${IFS}'}${marker})`;
  const r = await run({ baseRef: base });
  assert.ok(r.labels.includes('visual-snapshots-list'), r.labels.join(', '));
  assert.ok(!existsSync(marker), 'base branch 名の $(…) が実行された');
  assert.ok(r.prompt('visual-snapshots-list').includes(`'origin/${base}'`), r.prompt('visual-snapshots-list'));
}, TIMEOUT);

test('[priterate-visual-snapshots] (C) conflict の自動解決の後: 次の review の前に撮り直して push し、review には merge commit に加えて撮り直しの commit も読ませる', async () => {
  let mergeSha = null;
  const r = await run({
    overrides: ({ commitSource, head }) => ({
      'mergeable-check#1': { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' },
      'conflict-resolve#1': () => {
        const before = head();
        mergeSha = commitSource('screen merged\n', 'merge: origin/main');
        return { fetched: true, pushed: true, result: { status: 'resolved', reason: '', base_ref: 'origin/main', head_before: before, head_after: mergeSha, restored: false, files: [{ path: 'src/x.ts', type: 'A' }] } };
      },
      'mergeable-check#2': { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' },
    }),
  });
  assert.equal(r.result.status, 'lgtm');
  assert.deepEqual(captureStarts(r.labels), ['visual-snapshots-start#1']);
  assert.deepEqual(snapshotCommits(r.labels), ['visual-snapshots-commit#2']);
  assert.ok(r.at('conflict-resolve#1') < r.at('visual-snapshots-start#1') && r.at('visual-snapshots-commit#2') < r.at('review#2'), r.labels.join(', '));
  const head = r.head();
  assert.notEqual(head, mergeSha);
  assertSnapshotCommit(r, head);
  assert.equal(read(r.wt, PNG), 'screen merged\n');
  // remerge の範囲（merge commit）だけでは撮り直しの commit が review の対象から外れるので、その commit も読ませる
  const review2 = r.prompt('review#2');
  assert.ok(review2.includes(`git show --remerge-diff ${mergeSha}`), review2);
  assert.ok(review2.includes(`git show --stat ${head}`), `review#2 が撮り直しの commit を読む範囲に入れていない:\n${review2}`);
  assert.deepEqual(r.result.visual_snapshots, { changed: [PNG], notes: [] });
}, TIMEOUT);

test('[priterate-visual-snapshots] (S) tree が最後に撮影した tree から変わらないラウンドは撮らない（commit も push もしない）', async () => {
  const r = await run();
  assert.equal(r.result.status, 'lgtm');
  assert.ok(r.labels.includes('diff-hash-snapshot#1'), r.labels.join(', '));
  assert.deepEqual(captureStarts(r.labels), []);
  assert.deepEqual(snapshotCommits(r.labels), []);
  assert.ok(r.logs.some((l) => l.includes('review#1 — tree が最後に撮影した tree と同じ（撮り直さない）')), r.logs.join('\n'));
  assert.equal(r.head(), r.headAtStart);
  assert.equal(r.result.fixes_applied, 0);
  // 一覧は PR の差分（Evaluate が撮り直した PNG）から作る
  assert.deepEqual(r.result.visual_snapshots, { changed: [PNG], notes: [] });

  // 修正が画面を変えなかった（撮影しても PNG が変わらない）round は、撮影はするが commit しない
  const same = await run({
    overrides: ({ wt, head }) => ({
      'review#1': BLOCKING,
      'fix#1': () => {
        writeFileSync(join(wt, 'README.md'), 'docs\n');
        git(wt, 'add', '-A');
        git(wt, 'commit', '-q', '-m', 'docs');
        git(wt, 'update-ref', 'refs/remotes/origin/feature/x', head());
        return { applied: true, files: ['README.md'], summary: 'fixed', deferred_security_ids: [] };
      },
    }),
  });
  assert.equal(same.result.status, 'lgtm');
  assert.deepEqual(captureStarts(same.labels), ['visual-snapshots-start#1']);
  assert.deepEqual(snapshotCommits(same.labels), []);
  assert.equal(same.result.fixes_applied, 1);
  assert.deepEqual(same.result.visual_snapshots, { changed: [PNG], notes: [] });
}, TIMEOUT);

test('[priterate-visual-snapshots] (N) 宣言の無い run は撮り直しも commit・push もしない（tree も取らず、返り値の visual_snapshots は null）', async () => {
  const r = await run({ decl: null, captured: false });
  assert.equal(r.result.status, 'lgtm');
  assert.deepEqual(r.labels.filter((l) => l.startsWith('visual-snapshots-') || l.startsWith('diff-hash-snapshot')), []);
  assert.equal(r.result.visual_snapshots, null);
  assert.equal(r.head(), r.headAtStart);
  assert.equal(read(r.wt, PNG), 'screen v1\n');
}, TIMEOUT);

test('[priterate-visual-snapshots] (1) 単体起動の最初（最後に撮影した tree が無い）は今の head の tree で撮影する。PR 本文は書き換えず、終了レポートに同じ一覧を出す', async () => {
  const r = await run({ caller: 'standalone', captured: false });
  assert.equal(r.result.status, 'lgtm');
  assert.deepEqual(captureStarts(r.labels), ['visual-snapshots-start#1']);
  assert.deepEqual(snapshotCommits(r.labels), ['visual-snapshots-commit#1']);
  assert.ok(r.at('visual-snapshots-commit#1') < r.at('review#1'), r.labels.join(', '));
  assertSnapshotCommit(r, r.head());
  assert.equal(read(r.wt, PNG), 'screen v2\n');
  assert.deepEqual(r.result.visual_snapshots, { changed: [PNG], notes: [] });
  // 終了レポート（PR コメント）に一覧を出す。PR 本文を書き換える gh は起動しない
  const post = r.prompt('post-summary');
  assert.ok(post.includes('### 🖼 画面の変化') && post.includes(`- \`${PNG}\``), post);
  assert.ok(!post.includes('⚠️ 最終の画面は'), post);
  assert.ok(!r.calls.some((c) => /gh pr edit/.test(c.prompt)), 'PR 本文を書き換える gh pr edit を起動している');

  // 既に最終の画面を写している PR は、撮影しても PNG が変わらないので commit しない（撮り直せていない旨も出さない）
  const same = await run({ caller: 'standalone', captured: true });
  assert.deepEqual(captureStarts(same.labels), ['visual-snapshots-start#1']);
  assert.deepEqual(snapshotCommits(same.labels), []);
  assert.equal(same.head(), same.headAtStart);
  assert.deepEqual(same.result.visual_snapshots, { changed: [PNG], notes: [] });
}, TIMEOUT);

test('[priterate-visual-snapshots] (H) 撮り直しの commit を push した後の review・ci-check・security review は、その commit を含む head を対象にする', async () => {
  let fixSha = null;
  const r = await run({
    overrides: ({ commitSource }) => ({
      'review#1': BLOCKING,
      'fix#1': () => { fixSha = commitSource('screen v3\n', 'fix: screen v3'); return { applied: true, files: ['src/x.ts'], summary: 'fixed', deferred_security_ids: [] }; },
    }),
  });
  const snapshotSha = r.head();
  assert.notEqual(snapshotSha, fixSha);
  // review#2 の delta の範囲は前の review の head から撮り直しの commit まで（fix の commit で止めない）
  const review2 = r.prompt('review#2');
  assert.ok(review2.includes(`${r.headAtStart}..${snapshotSha}`), `review#2 の範囲が撮り直しの commit を含まない:\n${review2}`);
  assert.ok(!review2.includes(`..${fixSha}`), review2);
  assert.ok(review2.includes(`基準画像を撮り直した commit ${snapshotSha}`), review2);
  // 並列の ci-check#2 は撮り直しの commit の head で照合して採る（直列に取り直さない）
  assert.ok(r.labels.includes('ci-check#2') && !r.labels.includes('ci-check#2-serial'), r.labels.join(', '));
  // security review は撮り直しの commit を head にした diff を読み、その head で clear になる
  assert.ok(r.prompt('security-scope#2').includes(` ${snapshotSha} --save-diff`), r.prompt('security-scope#2'));
  assert.ok(r.prompt('security-review#2').includes(snapshotSha), r.prompt('security-review#2'));
  assert.ok(!r.prompt('security-review#2').includes(fixSha), 'security-review#2 が撮り直しの前の head を対象にしている');
  assert.equal(r.result.status, 'lgtm');
  assert.deepEqual({ target: r.result.security_review.target, status: r.result.security_review.status }, { target: true, status: 'cleared' });
  // 単体起動の終了レポートの marker の head も撮り直しの commit
  const standalone = await run({ caller: 'standalone', captured: false });
  assert.ok(standalone.prompt('post-summary').includes(`head=${standalone.head()} -->`), standalone.prompt('post-summary'));
}, TIMEOUT);

test('[priterate-visual-snapshots] (X1) 撮り直しの push の失敗は fail-open: commit を取り消して worktree と PR head を撮り直しの前に戻し、理由と「撮り直せていない」を出して review を続ける', async () => {
  const ok = await run({ caller: 'standalone', captured: false });
  const r = await run({
    caller: 'standalone', captured: false,
    overrides: ({ commitSnapshots }) => ({ 'visual-snapshots-commit#1': commitSnapshots({ pushed: false }) }),
  });
  assert.ok(r.at('visual-snapshots-commit#1') < r.at('visual-snapshots-revert#1') && r.at('visual-snapshots-revert#1') < r.at('review#1'), r.labels.join(', '));
  // worktree と PR head は撮り直しの前のまま（commit は残らず、PNG も戻る）
  assert.equal(r.head(), r.headAtStart);
  assert.equal(r.originHead(), r.headAtStart);
  assert.equal(read(r.wt, PNG), 'screen v1\n');
  assert.equal(git(r.wt, 'status', '--porcelain'), '');
  assert.equal(r.treeNow(), r.treeAtStart);
  // review は撮り直しの前の head を対象に続き、status・security review は撮り直せた run と同じ
  assert.ok(r.prompt('security-scope#1').includes(` ${r.headAtStart} --save-diff`), r.prompt('security-scope#1'));
  assert.equal(r.result.status, 'lgtm');
  assert.equal(r.result.status, ok.result.status);
  assert.deepEqual(r.result.security_review, ok.result.security_review);
  assert.equal(r.result.fixes_applied, 0);
  assert.deepEqual(r.result.visual_snapshots, {
    changed: [],
    notes: ['撮り直した基準画像の commit・push に失敗したため、撮り直しの前の状態に戻した', VISUAL_SNAPSHOTS_STALE_NOTE],
  });
  const post = r.prompt('post-summary');
  assert.ok(post.includes('### 🖼 画面の変化') && post.includes(`⚠️ ${VISUAL_SNAPSHOTS_STALE_NOTE}`), post);
}, TIMEOUT);

test('[priterate-visual-snapshots] (X2) 撮影コマンドの失敗は fail-open: PNG を入れず、同じ tree で繰り返さず、理由と「撮り直せていない」を出す。status は変えない', async () => {
  const r = await run({
    caller: 'standalone', captured: false, decl: declaration(`${CAPTURE}; exit 7`),
    // review#1 の指摘を tree を変えずに直した扱いにして 2 round 回す（同じ tree で撮影を繰り返さないことを見る）
    overrides: () => ({ 'review#1': BLOCKING }),
  });
  assert.equal(r.result.status, 'lgtm');
  assert.equal(r.result.iterations, 2);
  assert.deepEqual(captureStarts(r.labels), ['visual-snapshots-start#1']);
  assert.deepEqual(snapshotCommits(r.labels), []);
  assert.equal(r.head(), r.headAtStart);
  assert.equal(read(r.wt, PNG), 'screen v1\n');
  assert.deepEqual(r.result.visual_snapshots, {
    changed: [],
    notes: ['撮影のコマンドが exit 7 で失敗したため、この撮影の PNG は入れていない', VISUAL_SNAPSHOTS_STALE_NOTE],
  });
}, TIMEOUT);

test('[priterate-visual-snapshots] (M) 最後の修正の push の後に上限で終わった run は、撮り直しも push もせず「最終の画面は撮り直せていない」と出す', async () => {
  let fixSha = null;
  const r = await run({
    args: { max_iterations: 1 },
    overrides: ({ commitSource }) => ({
      'review#1': BLOCKING,
      'fix#1': () => { fixSha = commitSource('screen v3\n', 'fix: screen v3'); return { applied: true, files: ['src/x.ts'], summary: 'fixed', deferred_security_ids: [] }; },
    }),
  });
  assert.equal(r.result.status, 'max_reached');
  // 終わるときには撮影も commit・push もしない（review を通していない head を作らない）
  assert.deepEqual(captureStarts(r.labels), []);
  assert.deepEqual(snapshotCommits(r.labels), []);
  assert.equal(r.head(), fixSha);
  assert.equal(r.originHead(), fixSha);
  assert.equal(read(r.wt, PNG), 'screen v2\n');
  assert.ok(r.at('fix#1') < r.at('diff-hash-snapshot-final'), r.labels.join(', '));
  // 一覧は最終の head の PR の差分（PNG は fix の前の tree のもの）で、その旨を 1 行出す
  assert.deepEqual(r.result.visual_snapshots, { changed: [PNG], notes: [VISUAL_SNAPSHOTS_STALE_NOTE] });
}, TIMEOUT);

test('[priterate-visual-snapshots] 引数: 不正な visual_snapshots / visual_snapshots_tree は明示 throw（推測で撮影コマンドを実行しない）', async () => {
  const nested = { caller: 'standalone', cwd: '/tmp/wt', head_ref: 'feature/x', base_ref: 'main', head_sha: '1'.repeat(40), repo: 'acme/skills' };
  for (const [bad, re] of [
    [{ visual_snapshots: { command: 'x', timeout_seconds: 60, paths: [] } }, /args\.visual_snapshots が不正形/],
    [{ visual_snapshots: { command: 'x', timeout_seconds: 60, paths: ['../out'] } }, /args\.visual_snapshots が不正形/],
    [{ visual_snapshots: 'pnpm test:visual' }, /args\.visual_snapshots が不正形/],
    [{ visual_snapshots: declaration(), visual_snapshots_tree: 'HEAD' }, /args\.visual_snapshots_tree は tree OID/],
  ]) {
    const { ctx } = makePrIterateSandbox({ args: { pr: 5, nested, ...bad } });
    const { error } = await runWorkflowCapture(prIterateSrc, ctx, '.claude/workflows/pr-iterate.js');
    assert.match(String(error?.message), re, JSON.stringify(bad));
  }
});

// ---- (D) dev-flow からの nested 起動 ----
// Evaluate の撮影が通った dev-flow の run（撮影の後の tree は EVAL_TREE、PR 作成時の一覧は tests/visual/home.png）
const EVAL_TREE = 'e'.repeat(40);
const SCENARIO = DEV_FLOW_SCENARIOS['visual-snapshots'];
const CAPTURED = {
  extra: SCENARIO.extra,
  overrides: {
    ...SCENARIO.overrides,
    'visual-snapshots-wait#1.1': { ...SCENARIO.overrides['visual-snapshots-wait#1.1'], snapshot: { tree_before: 'd'.repeat(40), tree: EVAL_TREE, discarded: false, restored: null, outside: [], outside_count: 0 } },
  },
};
const section = (body) => {
  const start = body.indexOf(`${PR_BODY_VISUAL_HEADING}\n`);
  return start < 0 ? null : body.slice(start, body.indexOf('\n\n', start));
};

test('[priterate-visual-snapshots] (D) dev-flow は宣言と Evaluate が最後に撮影した tree を pr-iterate に渡し、作り直す PR 本文には pr-iterate が最終の head から作った一覧を載せる（PR 作成時の一覧は再掲しない）', async () => {
  const iterateArgs = [];
  const finalList = { changed: ['tests/visual/after-fix.png'], notes: [VISUAL_SNAPSHOTS_STALE_NOTE] };
  const { ctx, calls } = makeDevFlowSandbox({
    workflow: async (_name, wfArgs) => {
      iterateArgs.push(JSON.parse(JSON.stringify(wfArgs)));
      return { status: 'max_reached', iterations: 2, fixes_applied: 1, visual_snapshots: finalList };
    },
    overrides: { ...CAPTURED.overrides, 'reconcile-sync': { ok: true, head: 'b'.repeat(40) } },
    extra: CAPTURED.extra,
  });
  const { result, error } = await runWorkflowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'dev-flow nested');
  assert.equal(error, null, `run が throw した: ${error?.message}`);

  // 宣言は Setup で検証した値、tree は Evaluate の撮影の後の tree（local-verify の snapshot.tree）
  assert.deepEqual(iterateArgs[0]?.visual_snapshots, CAPTURED.extra.args.setup.visual_snapshots);
  assert.equal(iterateArgs[0]?.visual_snapshots_tree, EVAL_TREE);

  // PR 作成時の本文は Evaluate の時点の一覧
  assert.ok(section(calls.find((c) => c.label === 'pr#1').prompt)?.includes('- `tests/visual/home.png`'));
  // pr-iterate の後に作り直す本文は最終の head の一覧と「撮り直せていない」の 1 行で、PR 作成時の一覧は載せない
  const sync = calls.find((c) => c.label === 'ac-checkbox-sync');
  assert.ok(sync, `PR 本文を作り直していない: ${calls.map((c) => c.label).join(', ')}`);
  const final = section(sync.prompt);
  assert.ok(final?.includes('- `tests/visual/after-fix.png`') && final.includes(`⚠️ ${VISUAL_SNAPSHOTS_STALE_NOTE}`), sync.prompt);
  assert.ok(!final.includes('tests/visual/home.png'), final);
  // 表示だけ: 「撮り直せていない」は HOLD 理由にしない
  assert.ok(!JSON.stringify(result.merge_tier_hold_reasons ?? []).includes('撮り直'), JSON.stringify(result.merge_tier_hold_reasons));
}, TIMEOUT);

test('[priterate-visual-snapshots] (D) 最後の撮影に失敗した・tree が tree OID の形でない Evaluate は tree を渡さない（pr-iterate の最初の review の前に撮り直す）', async () => {
  const treeArg = async (wait) => {
    const iterateArgs = [];
    const { ctx } = makeDevFlowSandbox({
      workflow: async (_name, wfArgs) => { iterateArgs.push(JSON.parse(JSON.stringify(wfArgs))); return { status: 'lgtm', iterations: 1, fixes_applied: 0, visual_snapshots: { changed: ['tests/visual/home.png'], notes: [] } }; },
      overrides: { ...CAPTURED.overrides, 'visual-snapshots-wait#1.1': wait },
      extra: CAPTURED.extra,
    });
    const { error } = await runWorkflowCapture(devFlowSrc, ctx);
    assertNoCrash(error, 'dev-flow nested');
    assert.equal(error, null, `run が throw した: ${error?.message}`);
    assert.deepEqual(iterateArgs[0]?.visual_snapshots, CAPTURED.extra.args.setup.visual_snapshots);
    return iterateArgs[0]?.visual_snapshots_tree;
  };
  const snapshot = { tree_before: EVAL_TREE, tree: EVAL_TREE, discarded: true, restored: true, outside: [], outside_count: 0 };
  assert.equal(await treeArg({ ok: false, status: 'failed', exit_code: 7, snapshot }), null);
  // 中継が tree OID でない値を返した run は null にする（pr-iterate を引数の検証で止めない）
  assert.equal(await treeArg({ ...CAPTURED.overrides['visual-snapshots-wait#1.1'], snapshot: { ...snapshot, discarded: false, restored: null, tree: 'AAA' } }), null);
}, TIMEOUT);

test('[priterate-visual-snapshots] (D) head が変わらなくても「画面の変化」の材料が PR 作成時と違えば（撮り直しの失敗）、PR 本文の「画面の変化」だけを最終の一覧に差し替える', async () => {
  const failed = '撮影のコマンドが exit 7 で失敗したため、この撮影の PNG は入れていない';
  const runWith = async (iterate) => {
    const { ctx, calls } = makeDevFlowSandbox({ workflow: async () => iterate, overrides: CAPTURED.overrides, extra: CAPTURED.extra });
    const { result, error } = await runWorkflowCapture(devFlowSrc, ctx);
    assertNoCrash(error, 'dev-flow nested');
    assert.equal(error, null, `run が throw した: ${error?.message}`);
    return { result, calls, labels: calls.map((c) => c.label) };
  };
  const stale = await runWith({ status: 'lgtm', iterations: 1, fixes_applied: 0, visual_snapshots: { changed: ['tests/visual/home.png'], notes: [failed, VISUAL_SNAPSHOTS_STALE_NOTE] } });
  const sync = stale.calls.find((c) => c.label === 'visual-snapshots-body-sync');
  assert.ok(sync, `PR 本文の「画面の変化」を差し替えていない: ${stale.labels.join(', ')}`);
  assert.ok(section(sync.prompt)?.includes(`⚠️ ${failed}`) && section(sync.prompt).includes(`⚠️ ${VISUAL_SNAPSHOTS_STALE_NOTE}`), sync.prompt);
  // fix は無いので、受入条件の結果は PR 作成時のまま（「修正後に未再評価」にしない）。Final reconcile も走らせない
  assert.ok(!stale.labels.includes('ac-checkbox-sync') && !stale.labels.includes('test#final'), stale.labels.join(', '));
  const prBody = stale.calls.find((c) => c.label === 'pr#1').prompt;
  const bodyOf = (prompt) => prompt.slice(prompt.lastIndexOf('<<<PR_BODY_BEGIN>>>\n'), prompt.lastIndexOf('<<<PR_BODY_END>>>'));
  assert.equal(bodyOf(sync.prompt).replace(section(sync.prompt), ''), bodyOf(prBody).replace(section(prBody), ''), '「画面の変化」以外が PR 作成時の本文と違う');

  // 一覧が PR 作成時と同じ run・pr-iterate を通らない run（返り値に visual_snapshots が無い）は本文を書き換えない
  const same = await runWith({ status: 'lgtm', iterations: 1, fixes_applied: 0, visual_snapshots: { changed: ['tests/visual/home.png'], notes: [] } });
  const none = await runWith({ status: 'lgtm', iterations: 1, fixes_applied: 0 });
  for (const r of [same, none]) assert.ok(!r.labels.includes('visual-snapshots-body-sync') && !r.labels.includes('ac-checkbox-sync'), r.labels.join(', '));
  // 表示だけ: merge tier・HOLD 理由は撮り直せた run と同じ
  assert.equal(stale.result.merge_tier, same.result.merge_tier);
  assert.equal(JSON.stringify(stale.result.merge_tier_hold_reasons ?? []), JSON.stringify(same.result.merge_tier_hold_reasons ?? []));
}, TIMEOUT);
