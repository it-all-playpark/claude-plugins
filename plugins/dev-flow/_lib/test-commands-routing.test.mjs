// テストコマンドの解決（issue #1278）の routing test。dev-flow.js / pr-iterate.js と工程の workflow dev-flow-test-commands.js を
// VM で動かし、agent 呼び出しの label・prompt・工程の起動と引数を見る。解決元の判定と束の中身（origin/<base> の tree だけを読む・
// worktree だけにある tests/run-*.sh では runners にならない）は test-commands-prepare.bats、コマンドファイルの読み方と
// exit code からの判定は run-tests.bats が見る。
//   - 解決元が user 設定・tests/run-*.sh なら resolver を起動しない。どちらも無いときだけ resolver を 1 回起動する
//   - resolver は dev-implementer と別の agent 定義で、実装より前に 1 回だけ起動する。返り値の形が不正なら unresolved に倒し、
//     コマンドファイルを書かない
//   - 解決したコマンドは run-tests の argv で運ばず、コマンドファイルのパス（--commands）だけを渡す
//   - dev-flow は解決の工程を run で 1 回だけ起動し、結果を pr-iterate と finalize に引数で渡す。単体起動の pr-iterate は
//     テストを実行するときに同じ工程を 1 回だけ起動する
//   - 終端サマリーに実行したテストコマンドと解決元が出る
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  makeDevFlowSandbox, makePrIterateSandbox, runWorkflowCapture, testCommandsPrepareResponse, TEST_COMMANDS_FILE,
} from './test-helpers/vm-sandbox.mjs';
import {
  testCommandResolverPrompt, validateResolvedTestCommands, TEST_COMMAND_PREFIXES, TEST_COMMAND_RUNNERS,
} from './test-commands.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const workflowDir = join(here, '..', '.claude', 'workflows');
const devFlowSrc = readFileSync(join(workflowDir, 'dev-flow.js'), 'utf8');
const prIterateSrc = readFileSync(join(workflowDir, 'pr-iterate.js'), 'utf8');
const TEST_COMMANDS = 'dev-flow:dev-flow-test-commands-run';
const PR_ITERATE = 'dev-flow:pr-iterate-run';
const FINALIZE = 'dev-flow:dev-flow-finalize-run';
const RESOLVER = 'dev-flow:test-command-resolver';
const BUNDLE = '/tmp/test-commands-Stub01/bundle.md';

const ROOT_ENTRY = { dir: '.', full_command: 'uv run pytest', files_command: 'uv run pytest {files}' };
const PREPARE_USER_CONFIG = testCommandsPrepareResponse({ source: 'user_config', commands: [ROOT_ENTRY], sources: [] });
const PREPARE_RESOLVER = testCommandsPrepareResponse({ source: 'resolver', status: 'unresolved', sources: [], bundle_file: BUNDLE, bundle_files: ['.github/workflows/ci.yml', 'pyproject.toml'] });
const RESOLVED = { status: 'resolved', commands: [ROOT_ENTRY], sources: ['.github/workflows/ci.yml', 'pyproject.toml'] };
// RESOLVED の entry の一部を差し替えた返り値
const withEntry = (patch) => ({ ...RESOLVED, commands: [{ ...ROOT_ENTRY, ...patch }] });

// dev-flow を 1 run 動かし、工程の workflow の起動（名前と引数）を記録する
async function runDevFlow(overrides = {}) {
  const prIterateArgs = [];
  const { ctx, calls, logs } = makeDevFlowSandbox({
    overrides: { 'resolve-test-commands-write': { written: true }, ...overrides },
    workflow: async (name, wargs) => {
      if (name === PR_ITERATE) prIterateArgs.push(JSON.parse(JSON.stringify(wargs)));
      return { status: 'lgtm', iterations: 1, fixes_applied: 0 };
    },
  });
  const chained = ctx.workflow;
  const stages = [];
  ctx.workflow = async (name, wargs) => {
    stages.push({ name, wargs: JSON.parse(JSON.stringify(wargs)) });
    return chained(name, wargs);
  };
  const { result, error } = await runWorkflowCapture(devFlowSrc, ctx);
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  const labels = calls.map((c) => c.label);
  const lastLine = (label) => calls.find((c) => c.label === label)?.prompt.split('\n').at(-1);
  const summary = calls.find((c) => c.label === 'post-summary')?.prompt ?? '';
  return { result, calls, logs, labels, stages, prIterateArgs, lastLine, summary };
}

const resolverCalls = (calls) => calls.filter((c) => c.agentType === RESOLVER);

test('[test-commands] 解決元が tests/run-*.sh（既定）・user 設定なら resolver を起動せず、test#1 には --commands でファイルのパスだけを渡す', async () => {
  for (const prepare of [testCommandsPrepareResponse(), PREPARE_USER_CONFIG]) {
    const { calls, labels, lastLine } = await runDevFlow({ 'resolve-test-commands': prepare });
    assert.deepEqual(resolverCalls(calls), [], `source ${prepare.source} で resolver が起動した`);
    assert.ok(!labels.includes('resolve-test-commands-write'), 'コマンドファイルは prepare が書くので書き込みの spawn をしない');
    const prepareCall = calls.find((c) => c.label === 'resolve-test-commands');
    assert.equal(prepareCall.agentType, 'dev-flow:dev-runner-haiku');
    assert.equal(prepareCall.prompt.split('\n').at(-1), 'test-commands-prepare /tmp/wt --base main');
    assert.equal(lastLine('test#1'), `run-tests start /tmp/wt --base origin/main --commands ${TEST_COMMANDS_FILE}`);
    assert.ok(!calls.find((c) => c.label === 'test#1').prompt.includes('uv run pytest'), 'コマンドを argv で運んでいる');
  }
});

test('[test-commands] 解決元が resolver なら、dev-implementer と別の agent を実装より前に 1 回だけ起動し、束のパスだけを読ませ、検証した結果をファイルに書く', async () => {
  const { calls, labels, lastLine } = await runDevFlow({ 'resolve-test-commands': PREPARE_RESOLVER, 'resolve-test-commands-agent': RESOLVED });
  const resolver = resolverCalls(calls);
  assert.equal(resolver.length, 1, labels.join(', '));
  assert.equal(resolver[0].label, 'resolve-test-commands-agent');
  assert.notEqual(resolver[0].agentType, 'dev-flow:dev-implementer');
  assert.ok(labels.indexOf('resolve-test-commands-agent') < labels.indexOf('impl:serial:issue-1'), labels.join(', '));
  assert.ok(resolver[0].prompt.includes(`\`${BUNDLE}\` を Read tool で読め`), resolver[0].prompt);
  assert.ok(!resolver[0].prompt.includes('/tmp/wt'), 'resolver の prompt に worktree のパスがある');
  assert.deepEqual([...resolver[0].opts.schema.required], ['status', 'commands', 'sources']);
  assert.deepEqual([...resolver[0].opts.schema.properties.commands.items.required], ['dir', 'full_command', 'files_command']);

  const write = calls.find((c) => c.label === 'resolve-test-commands-write');
  assert.ok(write, labels.join(', '));
  assert.ok(write.prompt.includes(`\`${TEST_COMMANDS_FILE}\` へ書け`), write.prompt);
  const body = write.prompt.match(/<<<TEST_COMMANDS_BEGIN>>>\n(.*)\n<<<TEST_COMMANDS_END>>>/)[1];
  assert.deepEqual(JSON.parse(body), { source: 'resolver', ...RESOLVED });
  assert.equal(lastLine('test#1'), `run-tests start /tmp/wt --base origin/main --commands ${TEST_COMMANDS_FILE}`);
});

test('[test-commands] resolver の返り値の区切りが空白類（改行等）でも、コマンドファイルには照合した許可リストの語を半角空白で join した値を書く', async () => {
  const ret = withEntry({ dir: './', full_command: 'node\n--test', files_command: 'node\t--test\n{files}' });
  const { calls, labels } = await runDevFlow({ 'resolve-test-commands': PREPARE_RESOLVER, 'resolve-test-commands-agent': ret });
  const write = calls.find((c) => c.label === 'resolve-test-commands-write');
  assert.ok(write, labels.join(', '));
  const body = JSON.parse(write.prompt.match(/<<<TEST_COMMANDS_BEGIN>>>\n(.*)\n<<<TEST_COMMANDS_END>>>/)[1]);
  assert.deepEqual(body.commands, [{ dir: '.', full_command: 'node --test', files_command: 'node --test {files}' }]);
});

// 形が不正な返り値（どれも unresolved に倒し、コマンドファイルを書かない。ファイルが無いので run-tests は no_tests）
const INVALID_RETURNS = {
  null: null,
  throw: () => { throw new Error('injected'); },
  'status が enum 外': { ...RESOLVED, status: 'ok' },
  '{files} が無い': withEntry({ files_command: 'uv run pytest' }),
  '{files} が 2 回': withEntry({ files_command: 'uv run pytest {files} {files}' }),
  '{files} が独立した語でない': withEntry({ files_command: 'uv run pytest --x={files}' }),
  'package.json の scripts 経由（npm test）': withEntry({ full_command: 'npm test' }),
  'package.json の scripts 経由（pnpm run）': withEntry({ files_command: 'pnpm run test {files}' }),
  'Makefile のターゲット経由': withEntry({ full_command: 'make test' }),
  'shell でスクリプト起動（bash scripts/test.sh）': withEntry({ full_command: 'bash scripts/test.sh' }),
  'repo 内のパスを直接起動（./scripts/test.sh）': withEntry({ full_command: './scripts/test.sh' }),
  'インタプリタでスクリプト起動（python scripts/run_tests.py）': withEntry({ full_command: 'python scripts/run_tests.py' }),
  'uv run の後の Makefile 経由（uv run make test）': withEntry({ full_command: 'uv run make test' }),
  'bundle exec の後の Rakefile 経由（bundle exec rake test）': withEntry({ full_command: 'bundle exec rake test' }),
  'poetry run の後の Taskfile 経由（poetry run task test）': withEntry({ full_command: 'poetry run task test' }),
  'pnpm exec の後の repo 内のパス（pnpm exec ./scripts/test.sh）': withEntry({ full_command: 'pnpm exec ./scripts/test.sh' }),
  'hatch の scripts 経由（hatch run test）': withEntry({ full_command: 'hatch run test' }),
  'pdm の scripts 経由（pdm run test）': withEntry({ full_command: 'pdm run test' }),
  'npm exec が option を飲み込む（npm exec node --test）': withEntry({ full_command: 'npm exec node --test', files_command: 'npm exec node --test {files}' }),
  '前置と別エコシステムのランナー（bun x rspec）': withEntry({ full_command: 'bun x rspec', files_command: 'bun x rspec {files}' }),
  '前置と別エコシステムのランナー（uv run jest）': withEntry({ full_command: 'uv run jest', files_command: 'uv run jest {files}' }),
  'shell の記号': withEntry({ full_command: 'uv sync && uv run pytest' }),
  'テストを実行しないコマンド（true）': withEntry({ full_command: 'true', files_command: 'true {files}' }),
  'ランナーに option を足す（--collect-only）': withEntry({ full_command: 'uv run pytest --collect-only' }),
  'full_command と files_command で前置が違う': withEntry({ files_command: 'poetry run pytest {files}' }),
  'package.json の scripts 経由（pnpm test）': withEntry({ full_command: 'pnpm test', files_command: 'pnpm test {files}' }),
  'workspace の filter 経由（pnpm --filter x test）': withEntry({ full_command: 'pnpm --filter x test', files_command: 'pnpm --filter x test {files}' }),
  '束にファイルの無いディレクトリ': withEntry({ dir: 'packages/a' }),
  '束のファイルの祖先でしかないディレクトリ（.github）': withEntry({ dir: '.github' }),
  '.. を含む dir': withEntry({ dir: '.github/workflows/../..' }),
  '/ 始まりの dir': withEntry({ dir: '/tmp/wt' }),
  'dir が無い': { ...RESOLVED, commands: [{ full_command: ROOT_ENTRY.full_command, files_command: ROOT_ENTRY.files_command }] },
  '同じ dir が 2 回': { ...RESOLVED, commands: [ROOT_ENTRY, ROOT_ENTRY] },
  'commands が空': { ...RESOLVED, commands: [] },
  '最上位に full_command を持つ旧形式': { status: 'resolved', full_command: 'uv run pytest', files_command: 'uv run pytest {files}', sources: RESOLVED.sources },
  'commands に加えて最上位にも full_command': { ...RESOLVED, full_command: 'uv run pytest', files_command: 'uv run pytest {files}' },
  'sources が束の外': { ...RESOLVED, sources: ['/tmp/wt/pyproject.toml'] },
  'resolved なのに sources が空': { ...RESOLVED, sources: [] },
};

for (const [name, ret] of Object.entries(INVALID_RETURNS)) {
  test(`[test-commands] resolver の返り値が不正（${name}）なら unresolved として扱い、コマンドファイルを書かない`, async () => {
    const { calls, labels, logs, stages, prIterateArgs } = await runDevFlow({ 'resolve-test-commands': PREPARE_RESOLVER, 'resolve-test-commands-agent': ret });
    assert.equal(resolverCalls(calls).length, 1);
    assert.ok(!labels.includes('resolve-test-commands-write'), labels.join(', '));
    assert.ok(logs.some((l) => l.includes('テストコマンド: resolver の返り値が不正')), logs.filter((l) => l.includes('テストコマンド')).join(' | '));
    const finalize = stages.find((s) => s.name === FINALIZE);
    assert.equal(finalize.wargs.test_commands.status, 'unresolved');
    assert.equal(finalize.wargs.test_commands.commands, null);
    assert.equal(prIterateArgs[0].test_commands.status, 'unresolved');
  });
}

test('[test-commands] resolver が unresolved を返したら、コマンドファイルを書かずに終端サマリーに解決できなかったことを出す', async () => {
  const { labels, summary } = await runDevFlow({
    'resolve-test-commands': PREPARE_RESOLVER,
    'resolve-test-commands-agent': { status: 'unresolved', commands: [], sources: ['pyproject.toml'] },
  });
  assert.ok(!labels.includes('resolve-test-commands-write'), labels.join(', '));
  assert.ok(summary.includes('- テストコマンド: 解決できなかった（解決元: resolver（根拠: `pyproject.toml`）'), summary);
});

test('[test-commands] 工程の workflow の throw・形の不正な返り値は解決できなかったものとして扱い、test#1 に --commands を付けない', async () => {
  for (const broken of [
    async () => { throw new Error('injected stage crash'); },
    async () => ({ source: 'runners' }),
  ]) {
    const { ctx, calls, logs } = makeDevFlowSandbox();
    const chained = ctx.workflow;
    ctx.workflow = async (name, wargs) => (name === TEST_COMMANDS ? broken() : chained(name, wargs));
    const { error } = await runWorkflowCapture(devFlowSrc, ctx);
    assert.equal(error, null, error?.message);
    assert.equal(calls.find((c) => c.label === 'test#1').prompt.split('\n').at(-1), 'run-tests start /tmp/wt --base origin/main');
    assert.ok(logs.some((l) => l.includes('テストコマンドを解決できなかった')), logs.join(' | '));
  }
});

test('[test-commands] dev-flow は解決の工程を 1 回だけ起動し、同じ結果を pr-iterate・finalize（と evaluate）に引数で渡す', async () => {
  const { stages, prIterateArgs, calls } = await runDevFlow({ 'resolve-test-commands': PREPARE_RESOLVER, 'resolve-test-commands-agent': RESOLVED });
  const resolves = stages.filter((s) => s.name === TEST_COMMANDS);
  assert.equal(resolves.length, 1, stages.map((s) => s.name).join(', '));
  assert.deepEqual(resolves[0].wargs, { worktree: '/tmp/wt', base: 'main' });
  const expected = { source: 'resolver', ...RESOLVED, commands_file: TEST_COMMANDS_FILE, error: null };
  for (const name of ['dev-flow:dev-flow-evaluate-run', FINALIZE]) {
    assert.deepEqual(stages.find((s) => s.name === name).wargs.test_commands, expected, name);
  }
  assert.equal(prIterateArgs.length, 1);
  assert.deepEqual(prIterateArgs[0].test_commands, expected);
  assert.equal(resolverCalls(calls).length, 1, 'resolver は run で 1 回だけ');
});

test('[test-commands] 終端サマリーに実行したテストコマンドと解決元（tests/run-*.sh / user 設定 / resolver と根拠）が出る', async () => {
  const runners = await runDevFlow();
  assert.ok(runners.summary.includes('- テストコマンド: `tests/run-unit.sh`（解決元: base の tree の tests/run-*.sh）'), runners.summary);
  const user = await runDevFlow({ 'resolve-test-commands': PREPARE_USER_CONFIG });
  assert.ok(user.summary.includes('- テストコマンド: `uv run pytest`（落ちたファイルの再実行: `uv run pytest {files}`。解決元: user 設定'), user.summary);
  const resolver = await runDevFlow({ 'resolve-test-commands': PREPARE_RESOLVER, 'resolve-test-commands-agent': RESOLVED });
  assert.ok(resolver.summary.includes('- テストコマンド: `uv run pytest`（落ちたファイルの再実行: `uv run pytest {files}`。解決元: resolver（根拠: `.github/workflows/ci.yml`, `pyproject.toml`））'), resolver.summary);
});

// ---- dir 付きの commands（サブディレクトリで起動する repo）----

const MONOREPO_BUNDLE = ['packages/a/package.json', 'packages/a/vitest.config.ts', 'services/api/pyproject.toml'];
const MONOREPO_COMMANDS = [
  { dir: 'packages/a', full_command: 'pnpm exec vitest run', files_command: 'pnpm exec vitest run {files}' },
  { dir: 'services/api', full_command: 'uv run pytest', files_command: 'uv run pytest {files}' },
];

test('[test-commands] validateResolvedTestCommands: 束のファイルがあるディレクトリの entry は resolved になり、record は commands だけを持つ', () => {
  const res = validateResolvedTestCommands({
    status: 'resolved',
    commands: [{ ...MONOREPO_COMMANDS[0], dir: './packages/a/' }, MONOREPO_COMMANDS[1]],
    sources: ['packages/a/vitest.config.ts', 'services/api/pyproject.toml'],
  }, MONOREPO_BUNDLE);
  assert.deepEqual(res, {
    ok: true,
    record: { source: 'resolver', status: 'resolved', commands: MONOREPO_COMMANDS, sources: ['packages/a/vitest.config.ts', 'services/api/pyproject.toml'] },
  });
});

test('[test-commands] validateResolvedTestCommands: 束に無いディレクトリ・.. を含む dir・scripts 経由・旧形式は ok:false', () => {
  const sources = ['packages/a/package.json'];
  const entry = MONOREPO_COMMANDS[0];
  const cases = {
    '束に無いディレクトリ': { status: 'resolved', commands: [{ ...entry, dir: 'packages/b' }], sources },
    '束のファイルの祖先でしかないディレクトリ': { status: 'resolved', commands: [{ ...entry, dir: 'packages' }], sources },
    '.. を含む dir': { status: 'resolved', commands: [{ ...entry, dir: 'packages/a/../a' }], sources },
    '.. で worktree の外': { status: 'resolved', commands: [{ ...entry, dir: '../outside' }], sources },
    '/ 始まり': { status: 'resolved', commands: [{ ...entry, dir: '/packages/a' }], sources },
    'pnpm test': { status: 'resolved', commands: [{ dir: 'packages/a', full_command: 'pnpm test', files_command: 'pnpm test {files}' }], sources },
    'pnpm --filter x test': { status: 'resolved', commands: [{ dir: '.', full_command: 'pnpm --filter x test', files_command: 'pnpm --filter x test {files}' }], sources },
    '最上位に full_command を持つ旧形式': { status: 'resolved', full_command: entry.full_command, files_command: entry.files_command, sources },
  };
  for (const [name, ret] of Object.entries(cases)) {
    assert.equal(validateResolvedTestCommands(ret, MONOREPO_BUNDLE).ok, false, name);
  }
});

test('[test-commands] resolver が dir 付きの commands を返したら、その形のままコマンドファイルと工程の返り値・終端サマリーに載る', async () => {
  const prepare = testCommandsPrepareResponse({ source: 'resolver', status: 'unresolved', sources: [], bundle_file: BUNDLE, bundle_files: MONOREPO_BUNDLE });
  const ret = { status: 'resolved', commands: MONOREPO_COMMANDS, sources: ['packages/a/vitest.config.ts'] };
  const { calls, stages, summary } = await runDevFlow({ 'resolve-test-commands': prepare, 'resolve-test-commands-agent': ret });
  const body = JSON.parse(calls.find((c) => c.label === 'resolve-test-commands-write').prompt.match(/<<<TEST_COMMANDS_BEGIN>>>\n(.*)\n<<<TEST_COMMANDS_END>>>/)[1]);
  assert.deepEqual(body, { source: 'resolver', ...ret });
  assert.deepEqual(stages.find((s) => s.name === FINALIZE).wargs.test_commands.commands, MONOREPO_COMMANDS);
  assert.ok(summary.includes('- テストコマンド: `packages/a` で `pnpm exec vitest run`、`services/api` で `uv run pytest`（落ちたファイルの再実行: `packages/a` で `pnpm exec vitest run {files}`、`services/api` で `uv run pytest {files}`。解決元: resolver（根拠: `packages/a/vitest.config.ts`））'), summary);
});

test('[test-commands] testCommandResolverPrompt は dir 付きの commands の形と dir の決め方を示し、書ける「前置 + ランナー」を許可表から並べる', () => {
  const prompt = testCommandResolverPrompt(BUNDLE);
  assert.ok(prompt.includes('{status: "resolved"|"unresolved", commands: [{dir, full_command, files_command}], sources}'), prompt);
  assert.ok(prompt.includes('dir に選べるのは `.` か、束の「## ファイル: <path>」の path があるディレクトリ'), prompt);
  assert.ok(prompt.includes('dir からの相対パス'), prompt);
  let forms = 0;
  for (const p of TEST_COMMAND_PREFIXES) {
    for (const r of TEST_COMMAND_RUNNERS.filter((x) => p.runners.includes(x.name))) {
      forms += 1;
      assert.ok(prompt.includes(`\`${[...p.words, ...r.full].join(' ')}\``), `${p.words.join(' ')} + ${r.name} が prompt に無い`);
    }
  }
  assert.ok(forms > TEST_COMMAND_RUNNERS.length, '前置付きの形を数えていない');
  for (const r of TEST_COMMAND_RUNNERS) assert.ok(prompt.includes(`\`${r.files.join(' ')}\``), r.name);
});

// ---- pr-iterate ----

const HOLD_HEAD = 'a'.repeat(40);
const PR_WT = '/repo-wt/pr-5';
const NESTED = { cwd: PR_WT, head_ref: 'feature/x', head_sha: 'b'.repeat(40), base_ref: 'main', repo: 'acme/skills', epoch: 4242 };
const PRIOR_FINAL_RED = { tier: 'HOLD', codes: ['final_test_red'], url: 'https://github.com/acme/skills/pull/5#issuecomment-1', head_sha: HOLD_HEAD };

async function runPrIterate(args) {
  const { ctx, calls } = makePrIterateSandbox({
    args: { pr: 5, ...args },
    overrides: { 'hold-test-diff': { ok: true, outside: 0, files: [] }, 'hold-test-run': { tests: 'passed', green: true, summary: 'ok' } },
  });
  const chained = ctx.workflow;
  const stages = [];
  ctx.workflow = async (name, wargs) => {
    stages.push({ name, wargs: JSON.parse(JSON.stringify(wargs)) });
    return chained(name, wargs);
  };
  const { result, error } = await runWorkflowCapture(prIterateSrc, ctx, '.claude/workflows/pr-iterate.js');
  assert.equal(error, null, error?.message);
  return { result, calls, stages };
}

test('[test-commands] 単体起動の pr-iterate はテストを実行するときに解決の工程を 1 回だけ起動し、その commands_file を run-tests に渡す', async () => {
  const { calls, stages } = await runPrIterate({ nested: { caller: 'standalone', ...NESTED }, prior_devflow: PRIOR_FINAL_RED });
  const resolves = stages.filter((s) => s.name === TEST_COMMANDS);
  assert.equal(resolves.length, 1, stages.map((s) => s.name).join(', '));
  assert.deepEqual(resolves[0].wargs, { worktree: PR_WT, base: 'main' });
  const labels = calls.map((c) => c.label);
  assert.ok(labels.indexOf('resolve-test-commands') < labels.indexOf('hold-test-run'), labels.join(', '));
  assert.ok(calls.find((c) => c.label === 'hold-test-run').prompt.endsWith(`run-tests start ${PR_WT} --base origin/main --commands ${TEST_COMMANDS_FILE}`));
});

test('[test-commands] pr-iterate は test_commands を受け取ったら解決し直さず、テストを実行しない run では解決の工程を起動しない', async () => {
  const given = { source: 'user_config', status: 'resolved', commands: [{ dir: '.', full_command: 'cargo test', files_command: 'cargo test {files}' }], sources: [], commands_file: '/tmp/test-commands-Given/commands.json', error: null };
  const withArg = await runPrIterate({ nested: { caller: 'standalone', ...NESTED }, prior_devflow: PRIOR_FINAL_RED, test_commands: given });
  assert.deepEqual(withArg.stages.filter((s) => s.name === TEST_COMMANDS), []);
  assert.ok(!withArg.calls.some((c) => c.label.startsWith('resolve-test-commands')));
  assert.ok(withArg.calls.find((c) => c.label === 'hold-test-run').prompt.endsWith(`run-tests start ${PR_WT} --base origin/main --commands ${given.commands_file}`));

  for (const args of [
    { nested: { caller: 'dev-flow', ...NESTED }, test_commands: given },
    { nested: { caller: 'standalone', ...NESTED } },
  ]) {
    const { stages, calls } = await runPrIterate(args);
    assert.deepEqual(stages.filter((s) => s.name === TEST_COMMANDS), [], args.nested.caller);
    assert.ok(!calls.some((c) => c.label.startsWith('resolve-test-commands')), args.nested.caller);
  }
});

test('[test-commands] pr-iterate の args.test_commands が不正形なら明示 throw する', async () => {
  const { ctx } = makePrIterateSandbox({ args: { pr: 5, nested: { caller: 'dev-flow', ...NESTED }, test_commands: { source: 'runners' } } });
  const { error } = await runWorkflowCapture(prIterateSrc, ctx, '.claude/workflows/pr-iterate.js');
  assert.match(error?.message ?? '', /args\.test_commands が不正形/);
});
