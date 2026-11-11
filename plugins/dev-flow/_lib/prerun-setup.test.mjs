import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  PRERUN_MISSING_MSG,
  rejectLegacyBaseArg,
  validatePrerunSetup,
  summarizePrerunDeps,
  hasNextJs,
  normalizeCiVerify,
  normalizeLocalVerify,
  testDiscoveryNote,
} from './prerun-setup.mjs';

function validRaw(overrides = {}) {
  return {
    ok: true,
    issue: 641,
    repo: 'it-all-playpark/skills',
    base: 'main',
    base_source: 'default',
    worktree: '/repo/.claude/worktrees/df-641',
    branch: 'feature/issue-641',
    head: 'abc1234',
    worktree_status: 'ok',
    clean: { ok: true },
    deps: { ok: true, note: 'npm:installed' },
    stack: { frameworks: ['next', 'react'] },
    analyze: validAnalyze(),
    epoch: 1787000000,
    epoch_end: 1787000060,
    ci_wait_ceiling_seconds: 515,
    security_reviewer: 'claude',
    hooks_not_running: [],
    ...overrides,
  };
}

// prerun の analyze 段（prerun-analyze.sh）の ok:true 出力と同形
function validAnalyze(overrides = {}) {
  return {
    ok: true, analyze_path: 'contract', jev_reasons: [],
    issue_title: 'feat: add thing', issue_type: 'feat', acceptance_criteria: ['a', 'b'],
    breaking_keyword_scan: false, breaking_change: false, breaking_evidence: '',
    comment_count: 0, comment_overrides: [], comment_conflicts: [], uncertain: [],
    contract: 't1', ac_heading_near_miss: [], duration_seconds: 3,
    ...overrides,
  };
}

// ── validatePrerunSetup: 正常系 ──────────────────────────────────────────────

test('validatePrerunSetup: 正常な setup は各値をそのまま返し frameworks は string のみに絞る', () => {
  const raw = validRaw({ stack: { frameworks: ['next', 42, 'react', null] } });
  const result = validatePrerunSetup(raw, 641);
  assert.equal(result.base, 'main');
  assert.equal(result.worktree, '/repo/.claude/worktrees/df-641');
  assert.equal(result.branch, 'feature/issue-641');
  assert.equal(result.head, 'abc1234');
  assert.equal(result.repo, 'it-all-playpark/skills');
  assert.deepEqual(result.deps, { ok: true, note: 'npm:installed' });
  assert.deepEqual(result.frameworks, ['next', 'react']);
  assert.equal(result.epoch, 1787000000);
  assert.equal(result.epoch_end, 1787000060);
  assert.equal(result.ci_wait_ceiling_seconds, 515);
  assert.equal(result.security_reviewer, 'claude');
  assert.deepEqual(result.analyze, validAnalyze());
  assert.deepEqual(result.hooks_not_running, []);
});

test('validatePrerunSetup: hooks_not_running の event 名をそのまま返す', () => {
  assert.deepEqual(validatePrerunSetup(validRaw({ hooks_not_running: ['pre-commit', 'pre-push'] }), 641).hooks_not_running, ['pre-commit', 'pre-push']);
});

// ── validatePrerunSetup: security_reviewer（issue #1125）─────────────────────

const MISSING = Symbol('missing');

test('validatePrerunSetup: security_reviewer の claude / codex をそのまま返す', () => {
  assert.equal(validatePrerunSetup(validRaw({ security_reviewer: 'codex' }), 641).security_reviewer, 'codex');
  assert.equal(validatePrerunSetup(validRaw({ security_reviewer: 'claude' }), 641).security_reviewer, 'claude');
});

test.each([
  ['欠落', MISSING],
  ['null', null],
  ['out-of-enum("gemini")', 'gemini'],
  ['大文字("Codex")', 'Codex'],
  ['非文字列(1)', 1],
])('validatePrerunSetup: security_reviewer が %s なら "claude" に倒さず明示 error で throw する', (_name, value) => {
  const raw = validRaw();
  if (value === MISSING) delete raw.security_reviewer;
  else raw.security_reviewer = value;
  assert.throws(() => validatePrerunSetup(raw, 641), /必須キーが欠落\/型不正: security_reviewer（claude \| codex/);
});

// ── validatePrerunSetup: analyze（issue #690）────────────────────────────────

test('validatePrerunSetup: analyze 欠落は「必須キーが欠落/型不正: analyze」で throw する', () => {
  const raw = validRaw();
  delete raw.analyze;
  assert.throws(() => validatePrerunSetup(raw, 641), /必須キーが欠落\/型不正: analyze（/);
});

test('validatePrerunSetup: analyze が配列 / 非 object は throw する', () => {
  assert.throws(() => validatePrerunSetup(validRaw({ analyze: [] }), 641), /必須キーが欠落\/型不正: analyze（/);
  assert.throws(() => validatePrerunSetup(validRaw({ analyze: 'x' }), 641), /必須キーが欠落\/型不正: analyze（/);
});

test('validatePrerunSetup: analyze.ok が非 boolean は「必須キーが欠落/型不正: analyze.ok」で throw する', () => {
  assert.throws(() => validatePrerunSetup(validRaw({ analyze: { ok: 'true' } }), 641), /必須キーが欠落\/型不正: analyze\.ok（/);
});

test('validatePrerunSetup: analyze.ok:false は reason が非空 string なら throw せず verbatim で返す（Setup 末尾の analyze ゲートが needs_clarification に倒す）', () => {
  const analyze = { ok: false, reason: 'analyze-issue --contract failed: gh: not found', analyze_path: 'contract', duration_seconds: 1 };
  const result = validatePrerunSetup(validRaw({ analyze }), 641);
  assert.deepEqual(result.analyze, analyze);
});

test('validatePrerunSetup: analyze.ok:false で reason 欠落 / 空文字は「必須キーが欠落/型不正: analyze.reason」で throw する', () => {
  assert.throws(() => validatePrerunSetup(validRaw({ analyze: { ok: false } }), 641), /必須キーが欠落\/型不正: analyze\.reason（/);
  assert.throws(() => validatePrerunSetup(validRaw({ analyze: { ok: false, reason: '  ' } }), 641), /必須キーが欠落\/型不正: analyze\.reason（/);
});

// ── validatePrerunSetup: raw 自体が欠落/非object/配列 ───────────────────────

for (const [label, raw] of [
  ['undefined', undefined],
  ['null', null],
  ['string', 'str'],
  ['array', []],
]) {
  test(`validatePrerunSetup: raw が ${label} のとき PRERUN_MISSING_MSG で throw`, () => {
    assert.throws(() => validatePrerunSetup(raw, 641), (err) => {
      assert.equal(err.message, PRERUN_MISSING_MSG);
      return true;
    });
  });
}

// ── validatePrerunSetup: ok:false ────────────────────────────────────────────

test('validatePrerunSetup: ok:false のとき base_error/worktree_error/worktree_status を含めて throw する', () => {
  const raw = validRaw({
    ok: false,
    base_error: 'fetch failed',
    worktree_error: 'EPERM: denied',
    worktree_status: 'unwritable',
  });
  assert.throws(() => validatePrerunSetup(raw, 641), (err) => {
    assert.match(err.message, /^dev-flow: args\.setup\.ok が true でない/);
    assert.match(err.message, /base_error: fetch failed/);
    assert.match(err.message, /worktree_error: EPERM: denied/);
    assert.match(err.message, /worktree_status: unwritable/);
    return true;
  });
});

// ── validatePrerunSetup: 必須キーの型 ───────────────────────────────────────

// name, 入力（overrides。delete はキーを欠落させる）, 期待する欠落/型不正キー
const DELETE = Symbol('delete');
const REQUIRED_KEY_CASES = [
  ['base 欠落', { base: DELETE }, 'base'],
  ['worktree が相対パス', { worktree: 'relative/path' }, 'worktree'],
  ['head が空文字', { head: '' }, 'head'],
  ['deps.ok が非 boolean', { deps: { ok: 'true', note: 'x' } }, 'deps.ok'],
  ['deps.note が非 string', { deps: { ok: true, note: 123 } }, 'deps.note'],
  ['stack.frameworks が非配列', { stack: { frameworks: 'next' } }, 'stack.frameworks'],
  ['epoch が 0', { epoch: 0 }, 'epoch'],
  ['epoch が非整数(12.5)', { epoch: 12.5 }, 'epoch'],
  ['epoch が文字列("1000")', { epoch: '1000' }, 'epoch'],
  ['epoch_end が 0', { epoch_end: 0 }, 'epoch_end'],
  ['epoch_end 欠落', { epoch_end: DELETE }, 'epoch_end'],
  ['epoch_end が非整数(12.5)', { epoch_end: 12.5 }, 'epoch_end'],
  ['ci_wait_ceiling_seconds 欠落', { ci_wait_ceiling_seconds: DELETE }, 'ci_wait_ceiling_seconds'],
  ['ci_wait_ceiling_seconds が文字列("300")', { ci_wait_ceiling_seconds: '300' }, 'ci_wait_ceiling_seconds'],
  ['ci_wait_ceiling_seconds が 0', { ci_wait_ceiling_seconds: 0 }, 'ci_wait_ceiling_seconds'],
  ['hooks_not_running 欠落', { hooks_not_running: DELETE }, 'hooks_not_running'],
  ['hooks_not_running が文字列("pre-commit")', { hooks_not_running: 'pre-commit' }, 'hooks_not_running'],
  ['hooks_not_running が null', { hooks_not_running: null }, 'hooks_not_running'],
  ['hooks_not_running の要素が非文字列', { hooks_not_running: ['pre-commit', 1] }, 'hooks_not_running'],
];

test.each(REQUIRED_KEY_CASES)('validatePrerunSetup: %s は「必須キーが欠落/型不正: <key>」で throw する', (_name, overrides, key) => {
  const raw = validRaw();
  for (const [k, v] of Object.entries(overrides)) {
    if (v === DELETE) delete raw[k];
    else raw[k] = v;
  }
  const escaped = key.replace(/[.[\]]/g, '\\$&');
  assert.throws(() => validatePrerunSetup(raw, 641), new RegExp(`必須キーが欠落/型不正: ${escaped}`));
});

// ── validatePrerunSetup: issue 一致（stale setup の持ち込み防止） ──────────────

test('validatePrerunSetup: issue 欠落/非整数は必須キー欠落として throw', () => {
  const raw = validRaw();
  delete raw.issue;
  assert.throws(() => validatePrerunSetup(raw, 641), /必須キーが欠落\/型不正: issue/);
  assert.throws(() => validatePrerunSetup(validRaw({ issue: '641' }), 641), /必須キーが欠落\/型不正: issue/);
});

test('validatePrerunSetup: 別 issue の setup は fail-closed で throw（再 prerun を案内）', () => {
  assert.throws(() => validatePrerunSetup(validRaw({ issue: 640 }), 641), /args\.setup\.issue \(640\) が起動 issue \(641\) と一致しない/);
});

test('validatePrerunSetup: 起動 issue が文字列でも数値一致なら受理する', () => {
  assert.doesNotThrow(() => validatePrerunSetup(validRaw(), '641'));
});

// ── validatePrerunSetup: 任意キー ───────────────────────────────────────────

test('validatePrerunSetup: repo 欠落は null を返す', () => {
  const raw = validRaw();
  delete raw.repo;
  const result = validatePrerunSetup(raw, 641);
  assert.equal(result.repo, null);
});

test('validatePrerunSetup: branch 欠落は feature/issue-<issue> を返す', () => {
  const raw = validRaw();
  delete raw.branch;
  const result = validatePrerunSetup(raw, 641);
  assert.equal(result.branch, 'feature/issue-641');
});

test('validatePrerunSetup: branch_format を設定した setup は prerun の branch をそのまま使い、branch 欠落は feature/issue-<issue> に倒さず throw する', () => {
  const result = validatePrerunSetup(validRaw({ branch: 'issue-641-fix-login-timeout', branch_format: 'issue-{issue}-{slug}' }), 641);
  assert.equal(result.branch, 'issue-641-fix-login-timeout');
  const raw = validRaw({ branch_format: 'issue-{issue}-{slug}' });
  delete raw.branch;
  assert.throws(() => validatePrerunSetup(raw, 641), /必須キーが欠落\/型不正: branch/);
  assert.throws(() => validatePrerunSetup(validRaw({ branch: '', branch_format: 'issue-{issue}-{slug}' }), 641), /branch/);
});

// ── validatePrerunSetup: 未知キー ───────────────────────────────────────────

test('validatePrerunSetup: 未知キーがあっても throw しない', () => {
  const raw = validRaw({ unknown_extra_key: 'anything' });
  assert.doesNotThrow(() => validatePrerunSetup(raw, 641));
});

// ── rejectLegacyBaseArg ──────────────────────────────────────────────────────

test('rejectLegacyBaseArg: args.base があると throw する', () => {
  assert.throws(() => rejectLegacyBaseArg({ issue: '1', base: 'dev' }), /args\.base は受理しない/);
});

for (const [label, args] of [
  ['base キーなしの object', { issue: '1' }],
  ['string', '1'],
  ['undefined', undefined],
]) {
  test(`rejectLegacyBaseArg: ${label} は throw しない`, () => {
    assert.doesNotThrow(() => rejectLegacyBaseArg(args));
  });
}

// ── summarizePrerunDeps ──────────────────────────────────────────────────────

test('summarizePrerunDeps: ok:true note空は implNote null, logLine に Setup(deps) を含む', () => {
  const result = summarizePrerunDeps({ ok: true, note: '' });
  assert.equal(result.outcome, 'ok');
  assert.equal(result.implNote, null);
  assert.match(result.logLine, /Setup\(deps\)/);
});

// ---- ci_verify（issue #861）: repo の "dev-flow".ci_verify を検証・正規化する ----

const CI_VERIFY = { label: 'full-ci', checks: ['e2e'], commands: ['pnpm test:e2e:local', 'pnpm test:e2e'], wait_ceiling_seconds: 1500 };

test('validatePrerunSetup: ci_verify は正規化して返し、null / 欠落は未設定（null）', () => {
  assert.deepEqual(validatePrerunSetup(validRaw({ ci_verify: CI_VERIFY }), 641).ci_verify, CI_VERIFY);
  assert.equal(validatePrerunSetup(validRaw({ ci_verify: null }), 641).ci_verify, null);
  assert.equal(validatePrerunSetup(validRaw(), 641).ci_verify, null);
  assert.deepEqual(normalizeCiVerify({ ...CI_VERIFY, label: ' full-ci ', checks: [' e2e '] }).checks, ['e2e']);
});

test('validatePrerunSetup: ci_verify の形が不正なら fail-closed で throw（黙って無視しない）', () => {
  for (const [key, value] of [
    ['label', ''], ['checks', []], ['checks', ['e2e', '']], ['commands', 'pnpm test:e2e'], ['wait_ceiling_seconds', 0], ['wait_ceiling_seconds', '1500'],
  ]) {
    assert.throws(() => validatePrerunSetup(validRaw({ ci_verify: { ...CI_VERIFY, [key]: value } }), 641), new RegExp(`ci_verify\\.${key}`), `${key}=${JSON.stringify(value)}`);
  }
  assert.throws(() => validatePrerunSetup(validRaw({ ci_verify: ['full-ci'] }), 641), /ci_verify/);
});

test('normalizeCiVerify: stdout-relay の hook が deny する文字を含む check 名は throw（引用符は通す）', () => {
  for (const name of ['Build & Test', 'a | b', 'a; b', 'a < b', 'a > b', 'a `b`', 'a $b', 'a\nb']) {
    assert.throws(() => normalizeCiVerify({ ...CI_VERIFY, checks: ['e2e', name] }), /ci_verify\.checks/, JSON.stringify(name));
  }
  assert.deepEqual(normalizeCiVerify({ ...CI_VERIFY, checks: ["it's e2e (ubuntu)"] }).checks, ["it's e2e (ubuntu)"]);
});

// ---- local_verify（issue #863）: ci の AC をローカル実行で判定する宣言を検証・正規化する ----

const LOCAL_VERIFY = { command: 'pnpm test:e2e:local', db: { engine: 'postgres', version: '17' }, env: 'E2E_EXTERNAL_DATABASE_URL', timeout_seconds: 1500 };

test('validatePrerunSetup: local_verify は正規化して返し、null / 欠落は未設定（null）', () => {
  assert.deepEqual(validatePrerunSetup(validRaw({ local_verify: LOCAL_VERIFY }), 641).local_verify, LOCAL_VERIFY);
  assert.equal(validatePrerunSetup(validRaw({ local_verify: null }), 641).local_verify, null);
  assert.equal(validatePrerunSetup(validRaw(), 641).local_verify, null);
  assert.equal(normalizeLocalVerify({ ...LOCAL_VERIFY, command: ' pnpm test:e2e:local ' }).command, 'pnpm test:e2e:local');
});

test('validatePrerunSetup: local_verify の形が不正なら fail-closed で throw（黙って無視しない）', () => {
  for (const [key, value, re] of [
    ['command', '', /local_verify\.command/],
    ['db', null, /local_verify\.db/],
    ['db', { engine: 'mysql', version: '8' }, /local_verify\.db\.engine/],
    ['db', { engine: 'postgres', version: 17 }, /local_verify\.db\.version/],
    ['env', 'E2E-URL', /local_verify\.env/],
    ['timeout_seconds', 0, /local_verify\.timeout_seconds/],
    ['timeout_seconds', '1500', /local_verify\.timeout_seconds/],
  ]) {
    assert.throws(() => validatePrerunSetup(validRaw({ local_verify: { ...LOCAL_VERIFY, [key]: value } }), 641), re, `${key}=${JSON.stringify(value)}`);
  }
});

// ---- visual_snapshots（issue #1410）: prerun が検証済みの宣言をそのまま渡す ----

test('validatePrerunSetup: visual_snapshots は prerun の値をそのまま返し、null / 欠落は未設定（null）。workflow が読むキーの型が違えば throw', () => {
  const VISUAL_SNAPSHOTS = { ...LOCAL_VERIFY, command: 'pnpm test:visual', paths: ['tests/visual'] };
  assert.deepEqual(validatePrerunSetup(validRaw({ visual_snapshots: VISUAL_SNAPSHOTS }), 641).visual_snapshots, VISUAL_SNAPSHOTS);
  assert.equal(validatePrerunSetup(validRaw({ visual_snapshots: null }), 641).visual_snapshots, null);
  assert.equal(validatePrerunSetup(validRaw(), 641).visual_snapshots, null);
  for (const bad of ['pnpm test:visual', { ...VISUAL_SNAPSHOTS, paths: [] }, { ...VISUAL_SNAPSHOTS, paths: 'tests/visual' }, { ...VISUAL_SNAPSHOTS, command: '' }, { ...VISUAL_SNAPSHOTS, timeout_seconds: '900' }]) {
    assert.throws(() => validatePrerunSetup(validRaw({ visual_snapshots: bad }), 641), /visual_snapshots が不正/, JSON.stringify(bad));
  }
});

// ---- pr_title_format: commit subject（= PR タイトル）のテンプレートを検証する ----

test('validatePrerunSetup: pr_title_format は trim して返し、null / 欠落は未設定（null）', () => {
  assert.equal(validatePrerunSetup(validRaw({ pr_title_format: ' #{issue} {title} ' }), 641).pr_title_format, '#{issue} {title}');
  assert.equal(validatePrerunSetup(validRaw({ pr_title_format: '{prefix}: {title} [{type}/{scope}] (#{issue})' }), 641).pr_title_format, '{prefix}: {title} [{type}/{scope}] (#{issue})');
  assert.equal(validatePrerunSetup(validRaw({ pr_title_format: null }), 641).pr_title_format, null);
  assert.equal(validatePrerunSetup(validRaw(), 641).pr_title_format, null);
});

test('validatePrerunSetup: pr_title_format が不正なら fail-closed で throw（黙って既定に倒さない）', () => {
  for (const [value, re] of [
    ['', /空でない文字列でない/],
    [42, /空でない文字列でない/],
    ['#{issue}', /\{title\} が無い/],
    ['#{issue} {title}\nbody', /改行を含む/],
    ['#{number} {title}', /未知の差し込み \{number\}/],
  ]) {
    assert.throws(() => validatePrerunSetup(validRaw({ pr_title_format: value }), 641), re, JSON.stringify(value));
  }
});

test('summarizePrerunDeps: ok:true note非空は logLine に note を含む', () => {
  const result = summarizePrerunDeps({ ok: true, note: 'npm:installed' });
  assert.match(result.logLine, /npm:installed/);
});

test('summarizePrerunDeps: ok:false は implNote が「依存インストール警告」で始まり note を含み、logLine が「⚠️」で始まり「（fail-open で続行）」を含む', () => {
  const note = '依存インストールが failed で終了 — npm/npm (npm ci): failed';
  const result = summarizePrerunDeps({ ok: false, note });
  assert.match(result.implNote, /^依存インストール警告/);
  assert.ok(result.implNote.includes(note));
  assert.match(result.logLine, /^⚠️/);
  assert.match(result.logLine, /（fail-open で続行）/);
});

test('summarizePrerunDeps: ok:false かつ note 空でも implNote は非 null', () => {
  const result = summarizePrerunDeps({ ok: false, note: '' });
  assert.notEqual(result.implNote, null);
});

// ── hasNextJs ────────────────────────────────────────────────────────────────

test.each([
  ['next を含む配列は true', ['next'], true],
  ['next を含まない配列は false', ['react'], false],
  ['空配列は false', [], false],
  ['undefined は false', undefined, false],
])('hasNextJs: %s', (_name, frameworks, want) => {
  assert.equal(hasNextJs(frameworks), want);
});

// ── testDiscoveryNote ────────────────────────────────────────────────────────

// dev-flow-test-commands の返り値（_lib/test-commands.mjs の testCommandsResult）と同形
const COMMANDS_FILE = '/tmp/test-commands-x/commands.json';
const RESOLVER_COMMANDS = {
  source: 'resolver', status: 'resolved', commands: [{ dir: '.', full_command: 'uv run pytest', files_command: 'uv run pytest {files}' }],
  sources: ['.github/workflows/ci.yml', 'pyproject.toml'], commands_file: COMMANDS_FILE, error: null,
};
// 言語別の受理パターン（撤去した判定表が渡していた glob）
const LANGUAGE_GLOBS = ['test_*.py', '*_test.py', '*.test.', '*.spec.', '*.bats', '*_test.go', '*_spec.rb', '*Test.php', 'accept', 'exclude'];

test('testDiscoveryNote: resolver が解決したコマンドは files_command と解決元（根拠のファイル）を載せ、言語別の受理パターンを載せない', () => {
  const note = testDiscoveryNote(RESOLVER_COMMANDS);
  assert.ok(note.startsWith('test_discovery（'));
  assert.ok(note.includes('`uv run pytest {files}` の {files} に test_files を入れて実行する'), note);
  assert.ok(note.includes('解決元は resolver（根拠: .github/workflows/ci.yml, pyproject.toml）'), note);
  for (const g of LANGUAGE_GLOBS) assert.ok(!note.includes(g), `言語別の受理パターン ${g} が載っている: ${note}`);
  assert.ok(note.endsWith('\n'));
});

test('testDiscoveryNote: user 設定のコマンドは解決元を user 設定と書く', () => {
  const note = testDiscoveryNote({ ...RESOLVER_COMMANDS, source: 'user_config', commands: [{ dir: '.', full_command: 'pnpm exec vitest run', files_command: 'pnpm exec vitest run {files}' }], sources: [] });
  assert.ok(note.includes('解決元は user 設定。`pnpm exec vitest run {files}` の {files} に test_files を入れて実行する'), note);
});

test('testDiscoveryNote: サブディレクトリで起動するコマンドは dir ごとの files_command と、dir からの相対パスで実行することを載せる', () => {
  const note = testDiscoveryNote({
    ...RESOLVER_COMMANDS,
    commands: [
      { dir: 'packages/a', full_command: 'pnpm exec vitest run', files_command: 'pnpm exec vitest run {files}' },
      { dir: '.', full_command: 'uv run pytest', files_command: 'uv run pytest {files}' },
    ],
  });
  assert.ok(note.includes('packages/a → `pnpm exec vitest run {files}` / . → `uv run pytest {files}`'), note);
  assert.ok(note.includes('ディレクトリからの相対パス'), note);
  assert.ok(note.includes('解決元は resolver（根拠: .github/workflows/ci.yml, pyproject.toml）'), note);
});

test('testDiscoveryNote: 解決元が tests/run-*.sh なら script のパスと DEVFLOW_TEST_FILES での受け渡しを載せる', () => {
  const note = testDiscoveryNote({
    source: 'runners', status: 'resolved', commands: null,
    sources: ['tests/run-all-bats.sh', 'tests/run-node-tests.sh'], commands_file: COMMANDS_FILE, error: null,
  });
  assert.ok(note.includes('解決元は base の tests/run-*.sh（tests/run-all-bats.sh, tests/run-node-tests.sh）'), note);
  assert.ok(note.includes('DEVFLOW_TEST_FILES'), note);
  for (const g of LANGUAGE_GLOBS) assert.ok(!note.includes(g), `言語別の受理パターン ${g} が載っている: ${note}`);
});

test.each([
  ['unresolved', { source: 'resolver', status: 'unresolved', commands: null, sources: [], commands_file: COMMANDS_FILE, error: null }],
  ['工程の失敗（source / commands_file が null）', { source: null, status: 'unresolved', commands: null, sources: [], commands_file: null, error: 'x' }],
  ['resolved でもコマンドファイルが無い', { ...RESOLVER_COMMANDS, commands_file: null }],
  ['null', null],
])('testDiscoveryNote: %s は test_files を挙げず inspection にさせる', (_name, tc) => {
  const note = testDiscoveryNote(tc);
  assert.ok(note.includes('テストコマンド未解決'), note);
  assert.ok(note.includes('"inspection"'));
  assert.ok(!note.includes('{files}'));
});

// ── 静的検査: inline 制約（ESM import / require / Date.now / Math.random を含まない） ──

test('prerun-setup.mjs: import / require / Date.now / Math.random を含まない', () => {
  const path = fileURLToPath(new URL('./prerun-setup.mjs', import.meta.url));
  const code = readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  assert.doesNotMatch(code, /\bimport\s/);
  assert.doesNotMatch(code, /\brequire\(/);
  assert.doesNotMatch(code, /Date\.now/);
  assert.doesNotMatch(code, /Math\.random/);
});
