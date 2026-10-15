// _lib/skills-script-path-routing.test.mjs
// skills 内部 script のパス解決を VM 挙動で固定する（issue #484 task F1、issue #636 で VM 化）。
//
// dev-flow.js はかつて skills リポジトリ内部にのみ存在する script 群（analyze-issue.sh /
// journal.sh）を `${WT}/...`（WT=対象 repo の worktree）相対で subagent prompt / journal handoff
// payload に埋め込んでいた。対象 repo が skills 自身でない場合これらは WT 配下に存在せず Exit 127
// で落ちる。期待状態は plugin bin/ の bare 名（issue #569）を使うこと。
//
// 検証は (a) の一部を dev-flow.js / pr-iterate.js 全文に対する静的否定 assert で、
// 残りを dev-flow.js を VM で実行し agent() に実際に渡った prompt を観測することで行う
// （WT は既定 responder の '/tmp/wt'）:
//   (a-static) devFlowSrc / prIterateSrc 全文のどこにも `${WT}/dev-flow/scripts/`
//       `${WT}/journal/` という禁止パターン（テンプレートリテラル埋め込み）が無い
//       — success run 1 本の prompt 観測だけでは未到達分岐（abort / empty-diff 等）への
//       再混入を検出できないため、VM 観測とは独立に全文走査で pin する
//   (a-vm) success run で実際に agent() へ渡った prompt にも同パターンが現れない
//   (b) contract-probe の prompt に bare 名 `analyze-issue <ISSUE> --contract`
//       が現れる。journal handoff payload の journal_sh は 3 call site（Merge tier success handoff /
//       writeFailureTelemetry / top-level abort handoff、issue #607）すべてで bare 名 'journal'
//   (c) 負の対照: 対象 repo 自身のテストランナー `/tmp/wt/tests/run-tests.sh` は WT 相対のまま
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const workflowDir = join(here, '..', '.claude', 'workflows');
const devFlowSrc = readFileSync(join(workflowDir, 'dev-flow.js'), 'utf8');
const prIterateSrc = readFileSync(join(workflowDir, 'pr-iterate.js'), 'utf8');

// 3 call site に対応する run: success / empty-diff failure（writeFailureTelemetry）/ abort
const RUNS = {
  success: { overrides: {}, expectError: false },
  'empty-diff': {
    overrides: { 'diff-gate': { hash: 'H', empty: true }, 'diff-gate-retry': { hash: 'H', empty: true }, 'issue-labels': null },
    expectError: true,
  },
  abort: { overrides: { 'eval#1': () => { throw new Error('injected'); } }, expectError: true },
};

async function run(name) {
  const { ctx, calls } = makeDevFlowSandbox({ overrides: RUNS[name].overrides });
  const { error } = await runWorkflowCapture(devFlowSrc, ctx);
  assertNoCrash(error, name);
  assert.equal(error !== null, RUNS[name].expectError, `${name} run の throw 有無が想定と異なる: ${error?.message}`);
  return calls;
}

// ---- (a) 禁止パターン不在: WT 相対で skills 内部 script を呼んではならない ----

// (a-static): success run 1 本の prompt 観測だけでは未到達分岐（abort / empty-diff 等）への
// 再混入を検出できないため、devFlowSrc / prIterateSrc 全文に対する静的否定 assert を
// VM 観測とは独立に並置する。
test('[skills-script-path-routing] (a-static) devFlowSrc / prIterateSrc 全文に `${WT}/dev-flow/scripts/` `${WT}/journal/` という禁止パターンが無い', () => {
  for (const [name, src] of [['dev-flow.js', devFlowSrc], ['pr-iterate.js', prIterateSrc]]) {
    for (const forbidden of ['${WT}/dev-flow/scripts/', '${WT}/journal/']) {
      assert.ok(!src.includes(forbidden), `${name} に禁止パターン ${forbidden} が静的に含まれる（対象 repo が skills 以外だと Exit 127）`);
    }
  }
});

test('[skills-script-path-routing] (a-vm) どの agent() prompt にも `${WT}/dev-flow/scripts/` `${WT}/journal/` が現れない', async () => {
  const calls = await run('success');
  for (const forbidden of ['/tmp/wt/dev-flow/scripts/', '/tmp/wt/journal/']) {
    const hit = calls.find((c) => c.prompt.includes(forbidden));
    assert.ok(!hit, `${hit?.label} の prompt に禁止パターン ${forbidden} が含まれる（対象 repo が skills 以外だと Exit 127）`);
  }
});

// ---- (b) bare 名で呼ぶ ----

test('[skills-script-path-routing] (b) analyze-issue --contract は prerun（prerun-analyze.sh）が呼び、Workflow の prompt には現れない', async () => {
  const calls = await run('success');
  assert.equal(calls.filter((c) => c.label.startsWith('contract-probe')).length, 0, 'contract-probe が spawn されている（Analyze は prerun の script 段へ移動済み）');
  assert.ok(!calls.some((c) => c.prompt.includes('analyze-issue 1 --contract')), 'Workflow の prompt に analyze-issue --contract の実行指示が残っている');
  const prerunAnalyzeSrc = readFileSync(join(here, '..', 'dev-flow', 'scripts', 'prerun-analyze.sh'), 'utf8');
  assert.ok(prerunAnalyzeSrc.includes('ANALYZE_ISSUE="$PLUGIN_ROOT/dev-flow/scripts/analyze-issue.sh"'), 'prerun-analyze.sh が analyze-issue.sh を plugin 内パスで呼んでいない');
  assert.ok(existsSync(join(here, '..', 'dev-flow', 'scripts', 'analyze-issue.sh')), 'prerun-analyze.sh の ANALYZE_ISSUE が指す dev-flow/scripts/analyze-issue.sh が無い');
});

for (const name of Object.keys(RUNS)) {
  test(`[skills-script-path-routing] (b) ${name} run の journal handoff payload は journal_sh が bare 名 'journal'`, async () => {
    const calls = await run(name);
    const journalSave = calls.find((c) => c.label.startsWith('journal-log'));
    assert.ok(journalSave, `${name} run に journal handoff が無い`);
    assert.ok(journalSave.prompt.includes('"journal_sh":"journal"'), `${name} run の payload に "journal_sh":"journal" が無い:\n${journalSave.prompt.slice(0, 800)}`);
    assert.ok(!journalSave.prompt.includes('"journal_sh":"/tmp/wt/'), `${name} run の payload が journal_sh を WT 相対で渡している`);
  });
}

// ---- (c) 負の対照（誤爆防止）: 対象 repo 自身のファイルを指す WT 相対パスは修正対象外 ----

test('[skills-script-path-routing] (c) test 実行 prompt は対象 repo の worktree を WT 絶対パスで run-tests に渡す', async () => {
  const calls = await run('success');
  const t = calls.find((c) => c.label === 'test#1');
  assert.ok(t, 'test#1 が無い');
  // 対象 repo の tests/run-*.sh の列挙・実行は exec-proxy run-tests が <WT>/tests から行う。
  // prompt には WT 絶対パスだけを渡す（WT 相対にすると exec-proxy が別 cwd で探してしまう）。
  assert.ok(t.prompt.includes('\nrun-tests /tmp/wt'), 'test#1 prompt に `run-tests ${WT}`（WT 絶対パス）が無い（修正対象外の WT 相対パスまで書き換えた可能性）');
});
