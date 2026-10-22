// dev-flow-canary.js の VM sandbox routing test（TDD red として先に作成）。
//
// dev-flow-canary.js はまだ存在しない（このテストが先に red になることを確認してから実装する）。
// shape-loop-routing.test.mjs / workflow-load-smoke.test.mjs と同型の VM sandbox パターンで、
// agent()/parallel()/workflow() を stub し、workflow 本体の戻り値（report）を検証する。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const canaryPath = join(repoRoot, '.claude/workflows/dev-flow-canary.js');

const EXPECTED_CAPABILITY_IDS = [
  'agent_schema',
  'model_routing',
  'effort_routing',
  'agent_opts_effort_accepted',
  'agent_opts_cwd_applied',
  'parallel_fanout',
  'pipeline_fanout',
  'pipeline_failure_semantics',
  'nested_workflow',
  'pause_resume',
  'direct_fs',
  'direct_shell',
  'direct_import',
];

// ---- agent() stub 生成 -----------------------------------------------------------------------
//
// label ごとの既定 happy-path 応答 + overrideMap による上書き（null や別 shape を注入できる）。

function defaultAgentReturn(label, opts) {
  if (label === 'canary:version') {
    return { ok: true, version: '2.1.99', timestamp_utc: '2026-07-13T00:00:00Z', epoch: '1756700000' };
  }
  if (label === 'canary:model-report') {
    return { model_id: 'claude-haiku-4-5' };
  }
  if (label === 'canary:effort-opts') {
    return { ok: true, token: 'EFFORT-OPTS' };
  }
  if (label === 'canary:agent-cwd') {
    // harness が opts.cwd を agent の作業ディレクトリに適用した場合の応答
    return { ok: true, cwd: opts?.cwd ?? '/repo/worktree' };
  }
  if (label.startsWith('canary:par:')) {
    const token = label.slice('canary:par:'.length);
    return { ok: true, token };
  }
  if (label === 'canary:pipe:null') {
    return { ok: true, token: 'N' };
  }
  if (label.startsWith('canary:pipe:')) {
    const token = label.slice('canary:pipe:'.length);
    return { ok: true, token };
  }
  if (label === 'canary:report-write') {
    return { ok: true, path: '/home/u/.claude/logs/dev-flow-canary/canary-1756700000.json' };
  }
  return null;
}

function makeAgentStub(overrideMap = {}) {
  const calls = [];
  const stub = async (prompt, opts) => {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';
    calls.push({ label, agentType, opts, prompt });
    if (Object.prototype.hasOwnProperty.call(overrideMap, label)) {
      const v = overrideMap[label];
      return typeof v === 'function' ? v(prompt, opts) : v;
    }
    return defaultAgentReturn(label, opts);
  };
  return { stub, calls };
}

/**
 * dev-flow-canary 専用の VM sandbox を組む。
 * require/process/Buffer/globalThis.pause 等は意図的に注入しない
 * （direct_fs/direct_shell/direct_import/pause_resume が unsupported になることを確認するため）。
 *
 * @param {object} opts
 * @param {object} [opts.agentOverrides] - label -> 返り値（または (prompt,opts)=>値 の関数）
 * @param {Function} [opts.workflowImpl] - workflow() stub（既定は nested child の happy-path）
 * @param {Function} [opts.pipelineImpl] - pipeline() stub（既定は逐次 for-loop 実装）
 * @param {boolean} [opts.omitPipeline] - true の場合 sandbox に pipeline キー自体を入れない（typeof undefined 経路の検証用）
 */
function makeCanarySandbox({ agentOverrides = {}, workflowImpl, pipelineImpl, omitPipeline = false } = {}) {
  const { stub: agentStub, calls } = makeAgentStub(agentOverrides);
  const parallelStub = async (fns) => Promise.all((fns || []).map((f) => f()));
  const defaultWorkflow = async () => ({ child_ok: true, echo: 'canary-nested-probe' });
  const workflowStub = workflowImpl ?? defaultWorkflow;
  const defaultPipeline = async (items, cb) => {
    const out = [];
    for (const it of items) out.push(await cb(it));
    return out;
  };
  const pipelineStub = pipelineImpl ?? defaultPipeline;

  const sandbox = {
    phase: () => {},
    log: () => {},
    agent: agentStub,
    parallel: parallelStub,
    workflow: workflowStub,
    args: '',
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
  if (!omitPipeline) {
    sandbox.pipeline = pipelineStub;
  }

  const ctx = vm.createContext(sandbox);
  return { ctx, calls };
}

/**
 * dev-flow-canary.js ソースを strip して async IIFE でラップし vm sandbox で実行する。
 * IIFE の resolve 値（= workflow の `return report`）を捕捉する。
 *
 * @returns {Promise<{result: any, error: Error|null}>}
 */
async function runCanaryInSandbox(src, ctx) {
  const stripped = src
    .replace(/^export\s+const\s+/gm, 'const ')
    .replace(/^export\s+function\s+/gm, 'function ');
  const wrapped = `(async () => {\n${stripped}\n})();`;

  let result = null;
  let error = null;
  try {
    const p = vm.runInContext(wrapped, ctx, { filename: '.claude/workflows/dev-flow-canary.js' });
    if (p && typeof p.then === 'function') {
      result = await p.catch((e) => {
        error = e;
        return null;
      });
    } else {
      result = p;
    }
  } catch (e) {
    error = e;
  }
  return { result, error };
}

function assertNoStructuralError(error) {
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`dev-flow-canary.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }
}

function findCap(report, id) {
  return report.capabilities.find((c) => c.id === id);
}

// ============================================================
// 1. Happy path
// ============================================================

test('[canary] happy path: 10 capability が全て enum 内・agent/model/parallel/nested/opts受理=pass・direct系/pause/effort=unsupported', async () => {
  const src = readFileSync(canaryPath, 'utf8');
  const { ctx } = makeCanarySandbox();
  const { result, error } = await runCanaryInSandbox(src, ctx);

  assertNoStructuralError(error);
  assert.ok(result, 'report が return されること');

  const report = result;

  assert.equal(report.canary_version, '1.2.0');
  assert.equal(report.claude_code_version, '2.1.99');

  assert.ok(Array.isArray(report.capabilities));
  assert.equal(report.capabilities.length, 13, 'capabilities は正確に13件であること');

  // report.capabilities は vm sandbox（別 realm）内で生成された配列のため、.map()/.sort() を
  // そのまま呼ぶと結果が sandbox realm の Array のままになり、deepStrictEqual が
  // prototype 不一致で false 判定してしまう。Array.from（host realm の Array を明示的に呼ぶ）で
  // host realm の配列へ変換してから比較する。
  const actualIds = Array.from(report.capabilities, (c) => c.id).sort();
  const expectedIds = Array.from(EXPECTED_CAPABILITY_IDS).sort();
  assert.deepEqual(actualIds, expectedIds, 'capability id set が期待の13個と一致すること');

  for (const c of report.capabilities) {
    assert.ok(['pass', 'fail', 'unsupported'].includes(c.status), `id=${c.id} の status が enum 内であること (got ${c.status})`);
    assert.equal(typeof c.detail, 'string', `id=${c.id} の detail が string であること`);
  }

  assert.equal(findCap(report, 'agent_schema').status, 'pass');
  assert.equal(findCap(report, 'model_routing').status, 'pass');
  assert.equal(findCap(report, 'parallel_fanout').status, 'pass');
  assert.equal(findCap(report, 'pipeline_fanout').status, 'pass');
  assert.equal(findCap(report, 'pipeline_failure_semantics').status, 'pass');
  assert.match(findCap(report, 'pipeline_failure_semantics').detail, /null item/);
  assert.match(findCap(report, 'pipeline_failure_semantics').detail, /callback throw/);
  assert.equal(findCap(report, 'nested_workflow').status, 'pass');
  assert.equal(findCap(report, 'effort_routing').status, 'unsupported');
  assert.equal(findCap(report, 'direct_fs').status, 'unsupported');
  assert.equal(findCap(report, 'direct_shell').status, 'unsupported');
  assert.equal(findCap(report, 'direct_import').status, 'unsupported');
  assert.equal(findCap(report, 'pause_resume').status, 'unsupported');

  const optsAccepted = findCap(report, 'agent_opts_effort_accepted');
  assert.equal(optsAccepted.status, 'pass');
  assert.match(optsAccepted.detail, /受理されたことしか判定できない/);

  assert.equal(report.bridge_sunset.exec_proxy_removable, false);
  assert.equal(report.bridge_sunset.inline_generator_removable, false);
  assert.equal(report.bridge_sunset.verdict, 'keep-bridges');
  assert.equal(
    report.bridge_sunset.note,
    'capability report only — bridge 撤去は別 issue + human review でのみ実施',
  );

  assert.equal(report.report_path, '/home/u/.claude/logs/dev-flow-canary/canary-1756700000.json');
});

// ============================================================
// 2. 全 stub null（load-smoke 同等）— throw せず report が返る
// ============================================================

test('[canary] 全 stub null: throw せず report が return され、主要 capability が fail・claude_code_version=unknown・report_path=null', async () => {
  const src = readFileSync(canaryPath, 'utf8');
  const { ctx } = makeCanarySandbox({
    agentOverrides: {
      'canary:version': null,
      'canary:model-report': null,
      'canary:par:A': null,
      'canary:par:B': null,
      'canary:report-write': null,
    },
    workflowImpl: async () => null,
  });
  const { result, error } = await runCanaryInSandbox(src, ctx);

  assertNoStructuralError(error);
  assert.ok(result, 'null stub でも report が return されること（throw しない）');

  const report = result;
  assert.equal(findCap(report, 'agent_schema').status, 'fail');
  assert.equal(findCap(report, 'model_routing').status, 'fail');
  assert.equal(findCap(report, 'parallel_fanout').status, 'fail');
  assert.equal(findCap(report, 'nested_workflow').status, 'fail');
  assert.equal(report.claude_code_version, 'unknown');
  assert.equal(report.report_path, null);
});

// ============================================================
// 3. workflow() が throw する → nested_workflow=unsupported
// ============================================================

test('[canary] workflow() が throw する場合 nested_workflow=unsupported', async () => {
  const src = readFileSync(canaryPath, 'utf8');
  const { ctx } = makeCanarySandbox({
    workflowImpl: async () => {
      throw new Error('nested workflow not supported in this harness');
    },
  });
  const { result, error } = await runCanaryInSandbox(src, ctx);

  assertNoStructuralError(error);
  assert.ok(result);
  assert.equal(findCap(result, 'nested_workflow').status, 'unsupported');
  assert.match(findCap(result, 'nested_workflow').detail, /threw/);
});

// ============================================================
// 4. model_id が haiku 系でない場合 model_routing=fail
// ============================================================

test('[canary] model-report が非haiku model_id を返すと model_routing=fail', async () => {
  const src = readFileSync(canaryPath, 'utf8');
  const { ctx } = makeCanarySandbox({
    agentOverrides: {
      'canary:model-report': { model_id: 'claude-sonnet-4-5' },
    },
  });
  const { result, error } = await runCanaryInSandbox(src, ctx);

  assertNoStructuralError(error);
  assert.ok(result);
  assert.equal(findCap(result, 'model_routing').status, 'fail');
});

// ============================================================
// 4b. agent() が opts.effort 指定で throw する → agent_opts_effort_accepted=unsupported
// ============================================================

test('[canary] agent() が opts.effort 指定で throw する場合 agent_opts_effort_accepted=unsupported かつ他 capability・report 生成に影響しない', async () => {
  const src = readFileSync(canaryPath, 'utf8');
  const { ctx } = makeCanarySandbox({
    agentOverrides: {
      'canary:effort-opts': () => { throw new Error('unknown option: effort'); },
    },
  });
  const { result, error } = await runCanaryInSandbox(src, ctx);

  assertNoStructuralError(error);
  assert.ok(result, 'opts probe が throw しても report が return されること');

  const report = result;
  assert.equal(findCap(report, 'agent_opts_effort_accepted').status, 'unsupported');
  assert.match(findCap(report, 'agent_opts_effort_accepted').detail, /throw/);

  // 他 capability は happy path 相当のまま
  assert.equal(findCap(report, 'agent_schema').status, 'pass');
  assert.equal(findCap(report, 'model_routing').status, 'pass');
  assert.equal(findCap(report, 'parallel_fanout').status, 'pass');
  assert.equal(findCap(report, 'nested_workflow').status, 'pass');
  assert.equal(report.report_path, '/home/u/.claude/logs/dev-flow-canary/canary-1756700000.json');
  assert.equal(report.capabilities.length, 13);
});

// ============================================================
// 4b2. agent() opts.cwd probe — 1 回 spawn・repo 外の一時ディレクトリを渡す・pass / fail / unsupported
// ============================================================

test('[canary] agent() に opts.cwd（repo 外の一時ディレクトリ）を渡して 1 回 spawn し、報告された作業ディレクトリが一致すれば agent_opts_cwd_applied=pass', async () => {
  const src = readFileSync(canaryPath, 'utf8');
  const { ctx, calls } = makeCanarySandbox();
  const { result, error } = await runCanaryInSandbox(src, ctx);

  assertNoStructuralError(error);
  assert.ok(result);

  const cwdCalls = calls.filter((c) => c.opts && Object.prototype.hasOwnProperty.call(c.opts, 'cwd'));
  assert.equal(cwdCalls.length, 1, 'opts.cwd を渡す agent 呼び出しは 1 回だけであること');
  assert.equal(cwdCalls[0].label, 'canary:agent-cwd');
  const passedCwd = cwdCalls[0].opts.cwd;
  assert.equal(typeof passedCwd, 'string');
  assert.ok(passedCwd.startsWith('/'), `opts.cwd は絶対パスであること (got ${passedCwd})`);
  const repoTop = join(repoRoot, '..', '..');
  assert.ok(passedCwd !== repoTop && !passedCwd.startsWith(repoTop + '/'), `opts.cwd は repo の外であること (got ${passedCwd})`);
  assert.match(passedCwd, /^\/(private\/)?tmp(\/|$)/, 'opts.cwd は一時ディレクトリであること');

  const cap = findCap(result, 'agent_opts_cwd_applied');
  assert.equal(cap.status, 'pass');
  assert.ok(cap.detail.includes(passedCwd), 'detail に渡した cwd が記録されること');
});

test('[canary] macOS で /tmp の実パス /private/tmp が報告された場合も agent_opts_cwd_applied=pass', async () => {
  const src = readFileSync(canaryPath, 'utf8');
  const { ctx } = makeCanarySandbox({
    agentOverrides: {
      'canary:agent-cwd': (_prompt, opts) => ({ ok: true, cwd: `/private${opts.cwd}\n` }),
    },
  });
  const { result, error } = await runCanaryInSandbox(src, ctx);

  assertNoStructuralError(error);
  assert.ok(result);
  assert.equal(findCap(result, 'agent_opts_cwd_applied').status, 'pass');
});

test('[canary] agent が報告した作業ディレクトリが opts.cwd と一致しない（throw せず無視された）場合 agent_opts_cwd_applied=fail', async () => {
  const src = readFileSync(canaryPath, 'utf8');
  const { ctx } = makeCanarySandbox({
    agentOverrides: {
      'canary:agent-cwd': { ok: true, cwd: '/home/u/repo/.claude/worktrees/x' },
    },
  });
  const { result, error } = await runCanaryInSandbox(src, ctx);

  assertNoStructuralError(error);
  assert.ok(result);
  const cap = findCap(result, 'agent_opts_cwd_applied');
  assert.equal(cap.status, 'fail');
  assert.ok(cap.detail.includes('/home/u/repo/.claude/worktrees/x'), 'detail に報告された作業ディレクトリが記録されること');
});

test('[canary] cwd probe agent が null を返す場合 agent_opts_cwd_applied=fail', async () => {
  const src = readFileSync(canaryPath, 'utf8');
  const { ctx } = makeCanarySandbox({ agentOverrides: { 'canary:agent-cwd': null } });
  const { result, error } = await runCanaryInSandbox(src, ctx);

  assertNoStructuralError(error);
  assert.ok(result);
  assert.equal(findCap(result, 'agent_opts_cwd_applied').status, 'fail');
});

test('[canary] agent() が opts.cwd 指定で throw する場合 agent_opts_cwd_applied=unsupported かつ他 capability・report 生成に影響しない', async () => {
  const src = readFileSync(canaryPath, 'utf8');
  const { ctx } = makeCanarySandbox({
    agentOverrides: {
      'canary:agent-cwd': () => { throw new Error('unknown option: cwd'); },
    },
  });
  const { result, error } = await runCanaryInSandbox(src, ctx);

  assertNoStructuralError(error);
  assert.ok(result, 'cwd probe が throw しても report が return されること');

  const report = result;
  const cap = findCap(report, 'agent_opts_cwd_applied');
  assert.equal(cap.status, 'unsupported');
  assert.match(cap.detail, /unknown option: cwd/);

  assert.equal(findCap(report, 'agent_schema').status, 'pass');
  assert.equal(findCap(report, 'agent_opts_effort_accepted').status, 'pass');
  assert.equal(findCap(report, 'parallel_fanout').status, 'pass');
  assert.equal(findCap(report, 'nested_workflow').status, 'pass');
  assert.equal(report.bridge_sunset.verdict, 'keep-bridges');
  assert.equal(report.report_path, '/home/u/.claude/logs/dev-flow-canary/canary-1756700000.json');
  assert.equal(report.capabilities.length, 13);
});

test('[canary] cwd probe は read-only agent（dev-runner-haiku-ro）に pwd だけを許し、ファイル作成・変更・git/gh を禁じる', async () => {
  const src = readFileSync(canaryPath, 'utf8');
  const { ctx, calls } = makeCanarySandbox();
  const { result, error } = await runCanaryInSandbox(src, ctx);

  assertNoStructuralError(error);
  assert.ok(result);

  const cwdCalls = calls.filter((c) => c.label === 'canary:agent-cwd');
  assert.equal(cwdCalls.length, 1);
  const { agentType, prompt } = cwdCalls[0];
  // 書き込み可能な dev-runner-haiku（Write を持つ）ではなく read-only バリアントで spawn する
  assert.equal(agentType, 'dev-flow:dev-runner-haiku-ro');

  const toolsSection = prompt.split('## Tools')[1].split('## ')[0];
  const allowedCommands = [...toolsSection.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  assert.deepEqual(allowedCommands, ['pwd'], 'Tools 節で許すコマンドは pwd だけであること');
  assert.match(toolsSection, /他のコマンド・他の tool は一切使わない/);
  assert.doesNotMatch(prompt, /\bWrite\b|\bEdit\b/, 'cwd probe prompt が Write/Edit tool を指示しないこと');

  const boundary = prompt.split('## Boundary')[1].split('## ')[0];
  assert.match(boundary, /ファイルの作成・変更/);
  assert.match(boundary, /git 操作/);
  assert.match(boundary, /gh コマンド/);
  assert.match(boundary, /禁止/);
});

// ============================================================
// 4c. pipeline 未定義（omitPipeline） → pipeline_fanout/pipeline_failure_semantics=unsupported、
//     bare 参照 ReferenceError は起きず他 capability は happy path 相当のまま（AC-2 pin）
// ============================================================

test('[canary] pipeline が未定義の場合 pipeline_fanout/pipeline_failure_semantics=unsupported かつ他 capability・report 生成に影響しない', async () => {
  const src = readFileSync(canaryPath, 'utf8');
  const { ctx } = makeCanarySandbox({ omitPipeline: true });
  const { result, error } = await runCanaryInSandbox(src, ctx);

  assertNoStructuralError(error);
  assert.ok(result, 'pipeline 未定義でも report が return されること（ReferenceError で落ちない）');

  const report = result;
  assert.equal(findCap(report, 'pipeline_fanout').status, 'unsupported');
  assert.equal(findCap(report, 'pipeline_failure_semantics').status, 'unsupported');

  // 他 10 capability は happy path 相当のまま
  assert.equal(findCap(report, 'agent_schema').status, 'pass');
  assert.equal(findCap(report, 'model_routing').status, 'pass');
  assert.equal(findCap(report, 'parallel_fanout').status, 'pass');
  assert.equal(findCap(report, 'nested_workflow').status, 'pass');
  assert.equal(findCap(report, 'agent_opts_effort_accepted').status, 'pass');
  assert.equal(findCap(report, 'effort_routing').status, 'unsupported');
  assert.equal(findCap(report, 'direct_fs').status, 'unsupported');
  assert.equal(findCap(report, 'direct_shell').status, 'unsupported');
  assert.equal(findCap(report, 'direct_import').status, 'unsupported');
  assert.equal(findCap(report, 'pause_resume').status, 'unsupported');

  assert.equal(report.capabilities.length, 13, 'capabilities は正確に13件であること');
});

// ============================================================
// 4d. pipeline() が結果を順序反転で返す → pipeline_fanout=fail
// ============================================================

test('[canary] pipeline() の結果順序がずれる場合 pipeline_fanout=fail', async () => {
  const src = readFileSync(canaryPath, 'utf8');
  const { ctx } = makeCanarySandbox({
    pipelineImpl: async (items, cb) => {
      const out = [];
      for (const it of items) out.push(await cb(it));
      return out.reverse();
    },
  });
  const { result, error } = await runCanaryInSandbox(src, ctx);

  assertNoStructuralError(error);
  assert.ok(result);
  assert.equal(findCap(result, 'pipeline_fanout').status, 'fail');
});

// ============================================================
// 4e. pipeline probe の agent 呼び出し budget（AC-10 pin）
// ============================================================

test('[canary] pipeline probe の agent 呼び出しは canary:pipe:A / canary:pipe:B / canary:pipe:null の3件のみで、全て dev-runner-haiku-ro', async () => {
  const src = readFileSync(canaryPath, 'utf8');
  const { ctx, calls } = makeCanarySandbox();
  const { result, error } = await runCanaryInSandbox(src, ctx);

  assertNoStructuralError(error);
  assert.ok(result);

  const pipeCalls = calls.filter((c) => c.label.startsWith('canary:pipe:'));
  const pipeLabels = pipeCalls.map((c) => c.label).sort();
  assert.deepEqual(
    pipeLabels,
    ['canary:pipe:A', 'canary:pipe:B', 'canary:pipe:null'].sort(),
    'pipeline probe の agent 呼び出しは A/B/null の3件ちょうどであること（throw probe は agent を呼ばない）',
  );
  for (const c of pipeCalls) {
    assert.equal(c.agentType, 'dev-flow:dev-runner-haiku-ro', `label=${c.label} の agentType が dev-flow:dev-runner-haiku-ro であること`);
  }
});

// ============================================================
// 4f. pipeline() が callback の throw をそのまま reject として伝播する（既定 stub と同一挙動）場合、
//     pipeline_failure_semantics の detail に reject 観測が verbatim 記録される
// ============================================================

test('[canary] pipeline() が callback throw を reject として伝播する場合 pipeline_failure_semantics=pass かつ detail に reject 観測が記録される', async () => {
  const src = readFileSync(canaryPath, 'utf8');
  const { ctx } = makeCanarySandbox({
    pipelineImpl: async (items, cb) => {
      const out = [];
      for (const it of items) out.push(await cb(it));
      return out;
    },
  });
  const { result, error } = await runCanaryInSandbox(src, ctx);

  assertNoStructuralError(error);
  assert.ok(result);

  const cap = findCap(result, 'pipeline_failure_semantics');
  assert.equal(cap.status, 'pass');
  assert.match(cap.detail, /callback throw: pipeline\(\) が reject/);
});

// ============================================================
// 4g. epoch 欠落 → report-write agent を起動せず write skip（report_path=null, throw なし）
// ============================================================

test('[canary] version probe が epoch を返さない場合 report-write agent は起動されず report_path=null（write skip, throw なし）', async () => {
  const src = readFileSync(canaryPath, 'utf8');
  const { ctx, calls } = makeCanarySandbox({
    agentOverrides: {
      'canary:version': { ok: true, version: '2.1.99', timestamp_utc: '2026-07-13T00:00:00Z' },
    },
  });
  const { result, error } = await runCanaryInSandbox(src, ctx);

  assertNoStructuralError(error);
  assert.ok(result, 'epoch 欠落でも report が return されること（throw しない）');

  const report = result;
  assert.equal(report.claude_code_version, '2.1.99');
  assert.equal(report.report_path, null);

  const writeCalls = calls.filter((c) => c.label === 'canary:report-write');
  assert.equal(writeCalls.length, 0, 'epoch 無効時は report-write agent が起動されないこと');
});

// ============================================================
// 4h. epoch 非数字 → 同上（write skip）
// ============================================================

test('[canary] version probe の epoch が非数字の場合 report-write agent は起動されず report_path=null（write skip）', async () => {
  const src = readFileSync(canaryPath, 'utf8');
  const { ctx, calls } = makeCanarySandbox({
    agentOverrides: {
      'canary:version': { ok: true, version: '2.1.99', timestamp_utc: '2026-07-13T00:00:00Z', epoch: 'abc' },
    },
  });
  const { result, error } = await runCanaryInSandbox(src, ctx);

  assertNoStructuralError(error);
  assert.ok(result);

  const report = result;
  assert.equal(report.report_path, null);

  const writeCalls = calls.filter((c) => c.label === 'canary:report-write');
  assert.equal(writeCalls.length, 0, 'epoch 非数字時は report-write agent が起動されないこと');
});

// ============================================================
// 4i. timestamp_utc のみ欠落（epoch は有効） → 書き出しは実行され timestamp_utc='unknown'
// ============================================================

test('[canary] timestamp_utc のみ欠落しepochが有効な場合、書き出しは実行され timestamp_utc=unknown で report_path が期待パスになる', async () => {
  const src = readFileSync(canaryPath, 'utf8');
  const { ctx, calls } = makeCanarySandbox({
    agentOverrides: {
      'canary:version': { ok: true, version: '2.1.99', epoch: '1756700000' },
    },
  });
  const { result, error } = await runCanaryInSandbox(src, ctx);

  assertNoStructuralError(error);
  assert.ok(result);

  const report = result;
  assert.equal(report.timestamp_utc, 'unknown');
  assert.equal(report.report_path, '/home/u/.claude/logs/dev-flow-canary/canary-1756700000.json');

  const writeCalls = calls.filter((c) => c.label === 'canary:report-write');
  assert.equal(writeCalls.length, 1, 'epoch 有効時は report-write agent が1回起動されること');
});

// ============================================================
// 4j. report-write agent の申告 path が期待 suffix と不一致 → report_path=null
// ============================================================

test('[canary] report-write agent の申告 path が期待 suffix と不一致の場合 report_path=null', async () => {
  const src = readFileSync(canaryPath, 'utf8');
  const { ctx } = makeCanarySandbox({
    agentOverrides: {
      'canary:report-write': { ok: true, path: '/tmp/evil.json' },
    },
  });
  const { result, error } = await runCanaryInSandbox(src, ctx);

  assertNoStructuralError(error);
  assert.ok(result);
  assert.equal(result.report_path, null);
});

// ============================================================
// 4k. report-write prompt の検証（Write tool 指示・禁止構文不在・固定パス verbatim・report_path:null 埋め込み）
// ============================================================

test('[canary] report-write prompt が Write tool のみを指示し、禁止構文（$( / && / << / bash code fence）を含まず、固定パスと report_path:null が verbatim で埋め込まれる', async () => {
  const src = readFileSync(canaryPath, 'utf8');
  let capturedPrompt = null;
  const { ctx } = makeCanarySandbox({
    agentOverrides: {
      'canary:report-write': (prompt) => {
        capturedPrompt = prompt;
        return { ok: true, path: '/home/u/.claude/logs/dev-flow-canary/canary-1756700000.json' };
      },
    },
  });
  const { result, error } = await runCanaryInSandbox(src, ctx);

  assertNoStructuralError(error);
  assert.ok(result);
  assert.equal(typeof capturedPrompt, 'string', 'report-write prompt が捕捉されていること');

  assert.ok(
    capturedPrompt.includes('~/.claude/logs/dev-flow-canary/canary-1756700000.json'),
    'prompt に固定パスが verbatim で含まれること',
  );
  assert.ok(!capturedPrompt.includes('$('), 'prompt にコマンド置換 $( が含まれないこと');
  assert.ok(!capturedPrompt.includes(' && '), 'prompt に複合コマンド && が含まれないこと');
  assert.ok(!capturedPrompt.includes('<<'), 'prompt に heredoc << が含まれないこと');
  assert.ok(!capturedPrompt.includes('```bash'), 'prompt に bash code fence が含まれないこと');
  assert.match(capturedPrompt, /Write/, 'prompt が Write tool を指示すること');
  assert.ok(
    capturedPrompt.includes('"report_path": null'),
    'prompt に埋め込む JSON 本文に report_path:null が含まれること',
  );
});

// ============================================================
// 4l. version probe agent の呼び出し数（epoch 相乗りで agent 数不変の pin）
// ============================================================

test('[canary] happy path で canary:version label の agent 呼び出しは正確に1件のみ（epoch 相乗りで専用 agent が増えないこと）', async () => {
  const src = readFileSync(canaryPath, 'utf8');
  const { ctx, calls } = makeCanarySandbox();
  const { result, error } = await runCanaryInSandbox(src, ctx);

  assertNoStructuralError(error);
  assert.ok(result);

  const versionCalls = calls.filter((c) => c.label === 'canary:version');
  assert.equal(versionCalls.length, 1, 'canary:version label の agent 呼び出しは1件のみであること');
});

// ============================================================
// 5. source lint（read-only 保証 / agentType 制限 / top-level require 不在）
// ============================================================

test('[canary][lint] mutating git/gh コマンドが source に存在しない', () => {
  const src = readFileSync(canaryPath, 'utf8');
  assert.ok(!/git +(commit|push|add|worktree)/.test(src), 'mutating git コマンドが含まれないこと');
  assert.ok(!/\bgh (pr|issue|api)/.test(src), 'gh pr/issue/api コマンドが含まれないこと');
});

test('[canary][lint] agentType は dev-flow:dev-runner-haiku-ro / dev-flow:dev-runner-haiku のみ', () => {
  const src = readFileSync(canaryPath, 'utf8');
  const matches = [...src.matchAll(/agentType:\s*'([^']+)'/g)].map((m) => m[1]);
  assert.ok(matches.length > 0, '少なくとも1つの agentType 指定があること');
  for (const at of matches) {
    // canary は inline bridge 非依存（self-contained）のため nsAgentOpts() を使わず
    // namespaced id を直接書く。bare 名は harness が解決できず run が abort する。
    assert.ok(
      at === 'dev-flow:dev-runner-haiku-ro' || at === 'dev-flow:dev-runner-haiku',
      `想定外の agentType が使われている: ${at}`,
    );
  }
});

test('[canary][lint] module top-level に require() が存在しない', () => {
  const src = readFileSync(canaryPath, 'utf8');
  const lines = src.split('\n');
  const violations = lines.filter((l) => /^(?:const|let|var)\s+\S+\s*=\s*require\s*\(/.test(l) || /^require\s*\(/.test(l));
  assert.deepEqual(violations, [], 'module top-level に require() が存在しないこと');
});

test('[canary][lint] module top-level に Date.now() initializer が存在しない', () => {
  const src = readFileSync(canaryPath, 'utf8');
  const lines = src.split('\n');
  const violations = lines.filter((l) => /^(?:const|let|var)\s+\S+\s*=.*\bDate\.now\s*\(/.test(l));
  assert.deepEqual(violations, [], 'module top-level に Date.now() initializer が存在しないこと');
});

test('[canary][lint] report 書き出しの heredoc/command-substitution 方式（禁止構文）が source に再混入していない', () => {
  const src = readFileSync(canaryPath, 'utf8');
  assert.ok(!src.includes('buildCanaryReportWriteCommand'), 'buildCanaryReportWriteCommand が source に存在しないこと');
  assert.ok(!/<<'?CANARY_EOF/.test(src), 'CANARY_EOF heredoc マーカーが source に存在しないこと');
  assert.ok(!/cat >/.test(src), 'cat > が source に存在しないこと');
  assert.ok(!/mkdir -p/.test(src), 'mkdir -p が source に存在しないこと');
  assert.ok(!/\$\(date/.test(src), '$(date コマンド置換が source に存在しないこと');
});
