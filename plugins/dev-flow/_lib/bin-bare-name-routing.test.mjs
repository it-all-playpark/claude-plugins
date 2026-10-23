// _lib/bin-bare-name-routing.test.mjs
// dev-flow 実行経路（.claude/workflows/*.js / _lib/*.mjs）から skills 実体固定の絶対パスを
// 全廃し、plugin bin/ 経由の bare 名（拡張子なし）呼び出しへ移行したことを pin する（issue #569）。
//
// AC1: 絶対パス literal が 0 箇所。
// AC2: workflow が使う call site が bare 名で配線されている。
// [first-token]: bash 前置の bare 名呼び出しや拡張子付き呼び出しの残存が無い。
// [bin]: workflow / wrapper skill が使う bare 名は全て bin/ に存在し、bin/ は core 1 本 + dev-flow 25 本（人が起動する CLI を含む）に分割一致する。
//
// AC1 の検査文字列自体が禁止パターンの literal を含むと自己矛盾するため、
// join() で組み立てる（_lib/*.mjs は本テストファイル自身も走査対象に含むため）。
//
// Run: npx vitest run _lib/bin-bare-name-routing.test.mjs
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, makePrIterateSandbox, runWorkflowCapture, assertNoCrash } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const workflowsDir = join(repoRoot, '.claude', 'workflows');
const libDir = join(repoRoot, '_lib');
const binDir = join(repoRoot, 'bin');

const ABS_TILDE = ['~/.claude', 'skills/'].join('/');
const ABS_HOME = ['$HOME/.claude', 'skills/'].join('/');

const BARE = [
  'cross-repo-artifacts',
  'detect-and-install',
  'diff-risk-classify',
  'ensure-worktree-deps',
  'redgreen-verify',
  'secfloor-classify',
  'structural-classify',
  'worktree-diff-hash',
  'worktree-teardown',
  'journal',
  'check-ci',
  'analyze-issue',
  'detect-stack',
  'ac-lint',
  'dev-flow-prerun',
  'dev-flow-ready-set',
  'merge-tier-facts',
  'ci-wait',
  'pr-push',
  'workspace-prebuild',
  'run-tests',
  'pr-iterate-prerun',
  'local-verify',
  'conflict-autoresolve',
  'security-review-scope',
];

function listFiles(dir, ext) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(ext))
    .map((f) => join(dir, f));
}

const workflowFiles = listFiles(workflowsDir, '.js');
const libFiles = listFiles(libDir, '.mjs');

// ---- [AC1] .claude/workflows/*.js と _lib/*.mjs に skills 絶対パスが 0 箇所 ----

test('[bin-bare-name-routing][AC1] .claude/workflows/*.js に skills 絶対パスが 0 箇所', () => {
  for (const file of workflowFiles) {
    const src = readFileSync(file, 'utf8');
    assert.ok(!src.includes(ABS_TILDE), `${file} に禁止パターン '${ABS_TILDE}' が残っている`);
    assert.ok(!src.includes(ABS_HOME), `${file} に禁止パターン '${ABS_HOME}' が残っている`);
  }
});

test('[bin-bare-name-routing][AC1] _lib/*.mjs に skills 絶対パスが 0 箇所', () => {
  for (const file of libFiles) {
    const src = readFileSync(file, 'utf8');
    assert.ok(!src.includes(ABS_TILDE), `${file} に禁止パターン '${ABS_TILDE}' が残っている`);
    assert.ok(!src.includes(ABS_HOME), `${file} に禁止パターン '${ABS_HOME}' が残っている`);
  }
});

// ---- [AC2] 各 call site が bare 名で配線されている（dev-flow.js / pr-iterate.js は VM 挙動で観測、issue #636）----
//
// dev-flow.js / pr-iterate.js を VM で実行し、agent() に実際に渡った prompt に bare 名 call site
// （WT='/tmp/wt'・BASE='dev' で展開済み）が現れることを label ごとに確認する。到達させるための
// scenario は label 単位の override で最小に絞る。

const devFlowSrc = readFileSync(join(workflowsDir, 'dev-flow.js'), 'utf8');
const prIterateSrc = readFileSync(join(workflowsDir, 'pr-iterate.js'), 'utf8');

const PASS_EVAL_TEST_AC = {
  verdict: 'pass', total: 100, threshold: 80, feedback: [], feedback_level: 'implementation',
  ac_results: [
    { ac_index: 0, satisfied: true, verified_by: 'test', evidence: 'ok', test_files: ['t.test.mjs'], impl_files: ['src/x.ts'] },
    { ac_index: 1, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
  ],
  security_clearance: [], concern_resolutions: [],
};

// [label prefix, 期待 needle（展開済み）, scenario overrides]
const DEV_FLOW_CALL_SITES = [
  ['diff-hash-eval', 'worktree-diff-hash /tmp/wt origin/main', {}],
  ['danger-grep', 'secfloor-classify /tmp/wt origin/main', {}],
  ['security-scope', '\nsecurity-review-scope /tmp/wt origin/main --working-tree', {}],
  ['merge-tier-facts', '`merge-tier-facts --worktree /tmp/wt --base origin/main --pr-view-data ', {}],
  ['test#1', '\nrun-tests /tmp/wt', {}],
  ['pr#', '`pr-push /tmp/wt/.devflow-tmp/push-output.log`', {}],
  ['redgreen', "redgreen-verify /tmp/wt 't.test.mjs' 'src/x.ts'", { 'eval#1': PASS_EVAL_TEST_AC, redgreen: { results: [{ index: 0, red: true, green: true }] } }],
  ['cross-repo-artifacts', 'cross-repo-artifacts /tmp/wt ', {
    'diff-gate': { hash: 'EMPTY', empty: true },
    'issue-labels': { ok: true, labels: ['cross-repo'] },
    'impl:serial:issue-1': { status: 'DONE', task_id: 'issue-1', files: ['/tmp/other-repo/bar.ts'], summary: 's', concerns: [] },
    'cross-repo-artifacts': { ok: true, found: 1, artifacts: [{ path: '/tmp/other-repo/bar.ts', exists: true, repo_root: '/tmp/other-repo', dirty: true }] },
  }],
];

const runCache = new Map();
async function callsFor(overrides) {
  // 値まで含めてキー化する（キー集合が同じで値だけ異なる scenario の誤共有を防ぐ。関数値は toString）
  const key = JSON.stringify(overrides, (_k, v) => (typeof v === 'function' ? v.toString() : v));
  if (!runCache.has(key)) {
    const { ctx, calls } = makeDevFlowSandbox({ overrides });
    const { error } = await runWorkflowCapture(devFlowSrc, ctx);
    assertNoCrash(error, key);
    runCache.set(key, calls);
  }
  return runCache.get(key);
}

let lastOverrides = {};
for (const [labelPrefix, needle, overrides] of DEV_FLOW_CALL_SITES) {
  if (overrides !== null) lastOverrides = overrides;
  const scenario = lastOverrides;
  test(`[bin-bare-name-routing][AC2] dev-flow.js の '${labelPrefix}' prompt が bare 名 '${needle}' を含む`, async () => {
    const calls = await callsFor(scenario);
    const hit = calls.filter((c) => c.label.startsWith(labelPrefix));
    assert.ok(hit.length >= 1, `label '${labelPrefix}' の call が観測されない（scenario の到達条件を見直す）`);
    assert.ok(hit.some((c) => c.prompt.includes(needle)), `'${labelPrefix}' の prompt に bare 名 call site '${needle}' が無い:\n${hit[0].prompt.slice(0, 600)}`);
  });
}

test("[bin-bare-name-routing][AC2] dev-flow.js の journal handoff payload は journal_sh:'journal'（3 call site: success / writeFailureTelemetry / abort）", async () => {
  const runs = {
    success: {},
    failure: { 'diff-gate': { hash: 'H', empty: true }, 'diff-gate-retry': { hash: 'H', empty: true }, 'issue-labels': null },
    abort: { 'eval#1': () => { throw new Error('injected'); } },
  };
  for (const [name, overrides] of Object.entries(runs)) {
    const { ctx, calls } = makeDevFlowSandbox({ overrides });
    const { error } = await runWorkflowCapture(devFlowSrc, ctx);
    assertNoCrash(error, name);
    const save = calls.find((c) => c.label.startsWith('journal-log'));
    assert.ok(save, `${name} run に journal handoff が無い`);
    assert.ok(save.prompt.includes('"journal_sh":"journal"'), `${name} run の payload に "journal_sh":"journal" が無い`);
  }
});

test("[bin-bare-name-routing][AC2] pr-iterate.js の ci-check prompt が bare 名 '`check-ci --checks-data' を含む", async () => {
  const { ctx, calls } = makePrIterateSandbox();
  const { error } = await runWorkflowCapture(prIterateSrc, ctx, '.claude/workflows/pr-iterate.js');
  assertNoCrash(error, 'pr-iterate');
  const ci = calls.find((c) => c.label.startsWith('ci-check'));
  assert.ok(ci, 'pr-iterate.js で ci-check が観測されない');
  assert.ok(ci.prompt.includes('`check-ci --checks-data'), `ci-check prompt に bare 名 call site が無い:\n${ci.prompt.slice(0, 600)}`);
});

// ---- [first-token] bash 前置・.sh 拡張子残存が無い ----

const bashPrefixRe = new RegExp('\\bbash (' + BARE.join('|') + ')(\\s|`)');
const dotShRe = new RegExp('(' + BARE.join('|') + ')\\.sh (\\$\\{|origin/|--|start |stop |<)');

for (const [name, src] of [
  ['dev-flow.js', devFlowSrc],
  ['pr-iterate.js', prIterateSrc],
]) {
  test(`[bin-bare-name-routing][first-token] ${name} に bash 前置の bare 名呼び出しが残っていない`, () => {
    assert.doesNotMatch(src, bashPrefixRe, `${name} に 'bash <bare名>' 前置が残っている`);
  });
  test(`[bin-bare-name-routing][first-token] ${name} に .sh 拡張子付き呼び出しが残っていない`, () => {
    assert.doesNotMatch(src, dotShRe, `${name} に '<bare名>.sh' 拡張子付き呼び出しが残っている`);
  });
}

// ---- [bin] workflow / wrapper skill が使う bare 名は全て bin/ に存在し、bin/ は core 1 本 + dev-flow 25 本（人が起動する CLI を含む）に分割一致する ----

// 人が起動する CLI（workflow・exec-proxy・subagent からは呼ばない）。BARE には入れない
const HUMAN_ONLY = ['security-review-isolated'];

test('[bin-bare-name-routing][bin] plugins/dev-flow/bin は BARE から journal を除いた 24 名 + 人が起動する CLI 1 名に完全一致する', () => {
  const actual = readdirSync(binDir).sort();
  const expected = [...BARE.filter((name) => name !== 'journal'), ...HUMAN_ONLY].sort();
  assert.deepEqual(actual, expected, `plugins/dev-flow/bin の内容が期待 25 名と一致しない: actual=${JSON.stringify(actual)}`);
});

test("[bin-bare-name-routing][bin] plugins/playpark-core/bin は ['journal'] に完全一致する", () => {
  const coreBinDir = join(repoRoot, '..', 'playpark-core', 'bin');
  const actual = readdirSync(coreBinDir).sort();
  assert.deepEqual(actual, ['journal'], `plugins/playpark-core/bin の内容が ['journal'] と一致しない: actual=${JSON.stringify(actual)}`);
});
