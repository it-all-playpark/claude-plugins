// _lib/pre-commit-hook.test.mjs
// Validate の各回の pre-commit hook（commit-hook#<iter> → pre-commit-hook <WT>）を検査する。
//
//   - 経路: runValidateLoop の各回で test の前に commit-hook#<iter> が 1 回呼ばれ、hook の失敗（hook:'failed'）は
//     その回を green にせず、hook の出力の末尾が同じ回の green-fix prompt に渡る（VM で dev-flow.js を実行）
//   - hook が無い（hook:'none'）・応答が取れない（null）ときは Validate の結果・green-fix が hook 無しの run と同じ
//   - stage 内容: script は PR phase の stage（PR_STAGE_COMMANDS）と同じ git 操作を一時 index に対して行う
//   - 実行は hook を飛ばす・無効化する手段を含まない（prompt と script と bin wrapper）
//
// script 自体の挙動（exit code・HEAD が動かない等）は _shared/scripts/pre-commit-hook.bats が検査する。
//
// Run: npx vitest run _lib/pre-commit-hook.test.mjs
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash } from './test-helpers/vm-sandbox.mjs';
import { preCommitHookPrompt, preCommitHookFailure, preCommitHookFixNote, PRE_COMMIT_HOOK_SCHEMA } from './pre-commit-hook.mjs';
import { PR_STAGE_COMMANDS } from './pr-artifacts.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = join(here, '..');
const devFlowSrc = readFileSync(join(pluginRoot, '.claude/workflows/dev-flow.js'), 'utf8');
const scriptSrc = readFileSync(join(pluginRoot, '_shared/scripts/pre-commit-hook.sh'), 'utf8');
const wrapperSrc = readFileSync(join(pluginRoot, 'bin/pre-commit-hook'), 'utf8');

const HOOK_TAIL = 'tests/foo.bats line 12:\n  grep -q \'$x\' f\n  ^-- SC2016 (info): Expressions don\'t expand in single quotes';
const HOOK_FAILED = { hook: 'failed', exit: 123, tail: HOOK_TAIL, log: '/tmp/pre-commit-hook-x/hook.log' };
const HOOK_NONE = { hook: 'none', exit: null, tail: '', log: '' };
const HOOK_MARKER = '<<<PRE_COMMIT_HOOK_OUTPUT_BEGIN>>>';

const SCENARIOS = {
  // 1 回目だけ hook が落ちる（test は green）→ green-fix#1 → 2 回目は hook passed で green
  'fail-once': {
    'commit-hook#1': HOOK_FAILED,
    'commit-hook#2': { hook: 'passed', exit: 0, tail: '', log: '/tmp/l' },
  },
  // hook が毎回落ちる（test は毎回 green）→ GREEN_MAX まで green-fix し、Validate は green にならない
  'fail-always': {
    'commit-hook#1': HOOK_FAILED, 'commit-hook#2': HOOK_FAILED, 'commit-hook#3': HOOK_FAILED,
  },
  // test は no_tests（従来は即 break）でも hook の失敗は green-fix に回す
  'fail-no-tests': {
    'commit-hook#1': HOOK_FAILED,
    'test#1': { tests: 'no_tests', green: false, summary: 'no tests' },
  },
  // test と hook が同じ回に両方落ちる → 1 回の green-fix に test の失敗内容と hook の出力の両方を渡す
  'fail-with-red': {
    'commit-hook#1': HOOK_FAILED,
    'test#1': { tests: 'failed', green: false, summary: 'TEST_RED_SUMMARY_MARKER' },
  },
  // hook 無し（既定）。test が 1 回 red → green-fix#1 → green
  'none-red-once': {
    'test#1': { tests: 'failed', green: false, summary: 'TEST_RED_SUMMARY_MARKER' },
  },
  // hook の応答が取れない（proxy 失敗）。none と同じ結果になる
  'null-red-once': {
    'commit-hook#1': null, 'commit-hook#2': null,
    'test#1': { tests: 'failed', green: false, summary: 'TEST_RED_SUMMARY_MARKER' },
  },
  // hook 無し（既定）・test green
  'none-green': {},
  // hook の応答が取れない・test green
  'null-green': { 'commit-hook#1': null },
};

const runs = new Map();
function run(name) {
  if (!runs.has(name)) {
    runs.set(name, (async () => {
      const { ctx, calls, logs } = makeDevFlowSandbox({ overrides: SCENARIOS[name] });
      const { result, error } = await runWorkflowCapture(devFlowSrc, ctx);
      assertNoCrash(error, `pre-commit-hook/${name}`);
      assert.equal(error, null, `${name}: run が throw した: ${error?.message}`);
      return { calls, logs, result };
    })());
  }
  return runs.get(name);
}

const labels = (calls) => calls.map((c) => c.label);
const validateLabels = (calls) => labels(calls).filter((l) => /^(commit-hook|test|green-fix)#\d+$/.test(l));
const callOf = (calls, label) => calls.find((c) => c.label === label);

// ---- 経路: 各回で test の前に 1 回、PR phase と同じ起動形の prompt で呼ぶ ----

test('[pre-commit-hook] Validate の各回で test の前に commit-hook#<iter> を 1 回呼ぶ', async () => {
  const { calls } = await run('fail-once');
  assert.deepEqual(validateLabels(calls), ['commit-hook#1', 'test#1', 'green-fix#1', 'commit-hook#2', 'test#2']);
  const hook = callOf(calls, 'commit-hook#1');
  assert.equal(hook.agentType, 'dev-flow:dev-runner-haiku');
  assert.equal(hook.prompt, preCommitHookPrompt('/tmp/wt'));
  // VM の realm の object なので JSON で比べる
  assert.equal(JSON.stringify(hook.schema), JSON.stringify(PRE_COMMIT_HOOK_SCHEMA));
});

// ---- hook の失敗: その回は green にならず、hook の出力の末尾が green-fix に渡る ----

test('[pre-commit-hook] hook が exit 非 0 なら test が green でも green-fix を起動し、hook の出力の末尾を verbatim で渡す', async () => {
  const { calls } = await run('fail-once');
  const gf = callOf(calls, 'green-fix#1');
  assert.ok(gf, `green-fix#1 が呼ばれていない (labels: ${labels(calls).join(', ')})`);
  assert.ok(gf.prompt.includes(`${HOOK_MARKER}\n${HOOK_TAIL}\n<<<PRE_COMMIT_HOOK_OUTPUT_END>>>`), 'green-fix#1 の prompt に hook の出力（末尾）が verbatim で入っていない');
  assert.ok(gf.prompt.includes('exit 123'), 'green-fix#1 の prompt に hook の終了コードが無い');
  assert.ok(gf.prompt.includes(HOOK_FAILED.log), 'green-fix#1 の prompt に hook の出力全文のパスが無い');
});

test('[pre-commit-hook] hook が毎回落ちれば GREEN_MAX まで green-fix し、Validate は green にならない', async () => {
  const { calls, result } = await run('fail-always');
  assert.deepEqual(validateLabels(calls), [
    'commit-hook#1', 'test#1', 'green-fix#1',
    'commit-hook#2', 'test#2', 'green-fix#2',
    'commit-hook#3', 'test#3',
  ]);
  assert.equal(result?.test_green, false, 'hook が落ちたままの Validate は test_green=false で返るべき');
});

test('[pre-commit-hook] test が no_tests でも hook の失敗は green-fix に回す', async () => {
  const { calls } = await run('fail-no-tests');
  const gf = callOf(calls, 'green-fix#1');
  assert.ok(gf, `green-fix#1 が呼ばれていない (labels: ${labels(calls).join(', ')})`);
  assert.ok(gf.prompt.includes(HOOK_MARKER));
});

test('[pre-commit-hook] test と hook が同じ回に落ちれば 1 回の green-fix に両方を渡す', async () => {
  const { calls } = await run('fail-with-red');
  const gfs = calls.filter((c) => c.label === 'green-fix#1');
  assert.equal(gfs.length, 1);
  assert.ok(gfs[0].prompt.includes('TEST_RED_SUMMARY_MARKER'), 'test の失敗内容が green-fix#1 に無い');
  assert.ok(gfs[0].prompt.includes(HOOK_MARKER), 'hook の出力が green-fix#1 に無い');
});

// ---- hook が無い・応答が取れない: hook 無しの run と同じ結果 ----

for (const name of ['none-green', 'null-green']) {
  test(`[pre-commit-hook] ${name}: Validate は test#1 だけで green になり green-fix を起動しない`, async () => {
    const { calls, result } = await run(name);
    assert.deepEqual(validateLabels(calls), ['commit-hook#1', 'test#1']);
    assert.equal(result?.test_green, true);
    assert.equal(result?.validate_tests, 'passed');
  });
}

for (const name of ['none-red-once', 'null-red-once']) {
  test(`[pre-commit-hook] ${name}: test の red は hook の節を足さない green-fix に回り、2 回目で green`, async () => {
    const { calls, result } = await run(name);
    assert.deepEqual(validateLabels(calls), ['commit-hook#1', 'test#1', 'green-fix#1', 'commit-hook#2', 'test#2']);
    const gf = callOf(calls, 'green-fix#1');
    assert.ok(gf.prompt.includes('テストが失敗している'));
    assert.ok(gf.prompt.includes('失敗内容: TEST_RED_SUMMARY_MARKER'));
    assert.ok(!gf.prompt.includes('pre-commit hook'), 'hook が失敗していないのに green-fix prompt に hook の節がある');
    assert.equal(result?.test_green, true);
  });
}

test('[pre-commit-hook] hook 無しと応答が取れない run は green-fix の prompt まで同じ', async () => {
  const a = callOf((await run('none-red-once')).calls, 'green-fix#1');
  const b = callOf((await run('null-red-once')).calls, 'green-fix#1');
  assert.equal(a.prompt, b.prompt);
});

// ---- 純関数 ----

test('[pre-commit-hook] preCommitHookFailure は hook:failed だけを失敗として取り出す', () => {
  assert.deepEqual(preCommitHookFailure(HOOK_FAILED), { exit: 123, tail: HOOK_TAIL, log: HOOK_FAILED.log });
  for (const res of [HOOK_NONE, { hook: 'passed', exit: 0 }, { hook: 'error', error: 'x' }, null, undefined, 'failed', {}]) {
    assert.equal(preCommitHookFailure(res), null, `${JSON.stringify(res)} を失敗として扱った`);
  }
});

test('[pre-commit-hook] preCommitHookFixNote は hook の出力の末尾を区切り付きで verbatim に入れる', () => {
  const note = preCommitHookFixNote(preCommitHookFailure(HOOK_FAILED));
  assert.ok(note.includes(`${HOOK_MARKER}\n${HOOK_TAIL}\n<<<PRE_COMMIT_HOOK_OUTPUT_END>>>`));
});

// ---- stage 内容: PR phase の stage と同じ git 操作を一時 index に対して行う ----

test('[pre-commit-hook] script は PR_STAGE_COMMANDS と同じ git 操作を一時 index（GIT_INDEX_FILE）で行い、git hook run で起動する', () => {
  for (const cmd of PR_STAGE_COMMANDS) {
    assert.ok(scriptSrc.includes(`GIT_INDEX_FILE="$INDEX" ${cmd}`), `script に一時 index での \`${cmd}\` が無い`);
  }
  assert.ok(scriptSrc.includes('GIT_INDEX_FILE="$INDEX" git hook run pre-commit'), 'hook を一時 index で git hook run から起動していない');
});

// ---- 実行が hook を飛ばす・無効化する手段を含まない ----

const BYPASS_PATTERNS = [
  ['--no-verify', /--no-verify/],
  ['git commit（-n を含む）', /\bgit\s+(-\S+\s+)*commit\b/],
  ['core.hooksPath の上書き', /core\.hooksPath/i],
  ['git -c による設定の上書き', /\bgit\s+-c\b/],
  ['GIT_CONFIG_* による設定の上書き', /GIT_CONFIG_(COUNT|KEY|VALUE|PARAMETERS)/],
  ['HUSKY による無効化', /HUSKY/],
  ['pre-commit framework の SKIP', /\bSKIP=/],
];

for (const [what, src] of [
  ['commit-hook prompt', preCommitHookPrompt('/tmp/wt')],
  ['pre-commit-hook.sh', scriptSrc],
  ['bin/pre-commit-hook', wrapperSrc],
]) {
  test(`[pre-commit-hook] ${what} は hook を飛ばす・無効化する手段を含まない`, () => {
    for (const [name, re] of BYPASS_PATTERNS) {
      assert.ok(!re.test(src), `${what} に ${name} が含まれる`);
    }
  });
}

test('[pre-commit-hook] commit-hook prompt の実行コマンドは引数を足さない pre-commit-hook <WT> の 1 行', () => {
  const lines = preCommitHookPrompt('/tmp/wt').split('\n');
  assert.equal(lines[lines.length - 1], 'pre-commit-hook /tmp/wt');
});
