import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  PRERUN_SETUP_REQUIRED,
  PRERUN_MISSING_MSG,
  rejectLegacyBaseArg,
  validatePrerunSetup,
  summarizePrerunDeps,
  hasNextJs,
  normalizeCiVerify,
  normalizeLocalVerify,
  testDiscoveryNote,
} from './prerun-setup.mjs';

// detect-test-runner.sh の runners 要素と同形
const PYTEST_RUNNER = { runner: 'pytest', accept: ['test_*.py', '*_test.py'], exclude: [], command: 'uv run pytest <files>' };
const BATS_RUNNER = { runner: 'bats', accept: ['*.bats'], exclude: [], command: 'bats <files>' };

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
    stack: { frameworks: ['next', 'react'], test_runners: [PYTEST_RUNNER, BATS_RUNNER] },
    analyze: validAnalyze(),
    epoch: 1787000000,
    epoch_end: 1787000060,
    ci_wait_ceiling_seconds: 515,
    ...overrides,
  };
}

// prerun の analyze 段（prerun-analyze.sh）の ok:true 出力と同形
function validAnalyze(overrides = {}) {
  return {
    ok: true, analyze_path: 'contract', jev_reasons: [],
    issue_title: 'feat: add thing', issue_type: 'feat', acceptance_criteria: ['a', 'b'],
    scope: 'src', scope_truncated: false, scope_total_chars: 3,
    issue_body: 'body', issue_body_truncated: false,
    breaking_keyword_scan: false, breaking_change: false, breaking_evidence: '',
    comment_count: 0, comment_overrides: [], comment_conflicts: [], uncertain: [],
    contract: 't1', ac_heading_near_miss: [], duration_seconds: 3,
    ...overrides,
  };
}

// ── validatePrerunSetup: 正常系 ──────────────────────────────────────────────

test('validatePrerunSetup: 正常な setup は各値をそのまま返し frameworks は string のみに絞る', () => {
  const raw = validRaw({ stack: { frameworks: ['next', 42, 'react', null], test_runners: [PYTEST_RUNNER, BATS_RUNNER] } });
  const result = validatePrerunSetup(raw, 641);
  assert.equal(result.base, 'main');
  assert.equal(result.worktree, '/repo/.claude/worktrees/df-641');
  assert.equal(result.branch, 'feature/issue-641');
  assert.equal(result.head, 'abc1234');
  assert.equal(result.repo, 'it-all-playpark/skills');
  assert.deepEqual(result.deps, { ok: true, note: 'npm:installed' });
  assert.deepEqual(result.frameworks, ['next', 'react']);
  assert.deepEqual(result.testRunners, [PYTEST_RUNNER, BATS_RUNNER]);
  assert.equal(result.epoch, 1787000000);
  assert.equal(result.epoch_end, 1787000060);
  assert.equal(result.ci_wait_ceiling_seconds, 515);
  assert.deepEqual(result.analyze, validAnalyze());
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
  ['stack.test_runners 欠落', { stack: { frameworks: [] } }, 'stack.test_runners'],
  ['stack.test_runners の要素に accept が無い', { stack: { frameworks: [], test_runners: [{ runner: 'pytest', exclude: [], command: 'pytest <files>' }] } }, 'stack.test_runners[0]'],
  ['stack.test_runners の要素の runner が空', { stack: { frameworks: [], test_runners: [BATS_RUNNER, { ...PYTEST_RUNNER, runner: '' }] } }, 'stack.test_runners[1]'],
  ['epoch が 0', { epoch: 0 }, 'epoch'],
  ['epoch が非整数(12.5)', { epoch: 12.5 }, 'epoch'],
  ['epoch が文字列("1000")', { epoch: '1000' }, 'epoch'],
  ['epoch_end が 0', { epoch_end: 0 }, 'epoch_end'],
  ['epoch_end 欠落', { epoch_end: DELETE }, 'epoch_end'],
  ['epoch_end が非整数(12.5)', { epoch_end: 12.5 }, 'epoch_end'],
  ['ci_wait_ceiling_seconds 欠落', { ci_wait_ceiling_seconds: DELETE }, 'ci_wait_ceiling_seconds'],
  ['ci_wait_ceiling_seconds が文字列("300")', { ci_wait_ceiling_seconds: '300' }, 'ci_wait_ceiling_seconds'],
  ['ci_wait_ceiling_seconds が 0', { ci_wait_ceiling_seconds: 0 }, 'ci_wait_ceiling_seconds'],
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

// ── validatePrerunSetup: 未知キー ───────────────────────────────────────────

test('validatePrerunSetup: 未知キーがあっても throw しない', () => {
  const raw = validRaw({ unknown_extra_key: 'anything' });
  assert.doesNotThrow(() => validatePrerunSetup(raw, 641));
});

// ── PRERUN_SETUP_REQUIRED ───────────────────────────────────────────────────

test('PRERUN_SETUP_REQUIRED: 必須キー一覧を定義する', () => {
  assert.deepEqual(PRERUN_SETUP_REQUIRED, ['ok', 'issue', 'base', 'worktree', 'head', 'deps', 'stack', 'analyze', 'epoch', 'epoch_end', 'ci_wait_ceiling_seconds']);
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

test('testDiscoveryNote: 判定した runners を verbatim で載せ、accept / exclude に限る受理条件の文にする', () => {
  const note = testDiscoveryNote([PYTEST_RUNNER, BATS_RUNNER]);
  assert.ok(note.startsWith('test_discovery（'));
  assert.ok(note.includes('accept に一致し exclude に一致しないファイルに限れ'));
  assert.ok(note.includes(JSON.stringify([PYTEST_RUNNER, BATS_RUNNER])));
  assert.ok(note.endsWith('\n'));
});

test('testDiscoveryNote: runners が空なら test_files を挙げず inspection にさせる', () => {
  const note = testDiscoveryNote([]);
  assert.ok(note.includes('ランナー検出なし'));
  assert.ok(note.includes('"inspection"'));
  assert.ok(!note.includes('accept'));
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
