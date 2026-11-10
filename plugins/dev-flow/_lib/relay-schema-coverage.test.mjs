// hook で実 stdout に縛った中継（stdout-relay・security-codex-relay）の返り値 schema が、中継が実行するスクリプトの
// stdout を表せることの検査（issue #1372）。
//
// 守っている不変条件:
//   - 中継の prompt の最終行のコマンド（check-ci / security-review-scope / security-review-codex-prep /
//     security-review-codex-result）を実際に実行した stdout は、どの分岐でも、その prompt に渡す schema に
//     どの深さのキーも宣言され、型が一致する。exit 0 の stdout（中継がそのまま返す）は required も満たす。exit 非0 の stdout は
//     hook が返り値として通さず、中継は失敗時の JSON（CI_RELAY_FAILED 等）を返すので、required は見ない
//   - schema から宣言を 1 つ外すと、どれかの分岐の stdout がその schema から外れる（宣言はすべて実出力に対応する）
//
// なぜ: hook（_lib/scripts/stdout-relay-bind.mjs / security-relay-bind.mjs）は返り値を実 stdout との完全一致に縛る。
// schema に宣言の無いキーを中継が落とす・別の型で渡すと返り値が拒否され、CI が通っていても ci_error（security は判定不能）になる。
// 手書きの出力例ではなくスクリプトの実出力を照らすのは、出力例がスクリプトとずれると同じ食い違いを見逃すため。
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CI_POLL_SECONDS, CI_STATUS, CI_VERIFY_CHECK, CI_VERIFY_POLL_SECONDS, CI_WAIT_CHECK, ciCheckPrompt, ciVerifyPrompt, ciWaitCheckPrompt,
} from './ci-check.mjs';
import {
  SECURITY_CODEX_ISSUES_SCHEMA, SECURITY_CODEX_PREP_SCHEMA, SECURITY_CODEX_RESULT_SCHEMA, codexIssuesPrompt, codexPrepPrompt, codexVerdictPrompt,
} from './security-review.mjs';
import { SECURITY_SCOPE_SCHEMA, securityScopePrompt } from './security-scope.mjs';
import { CHECK_CI_STUB_HEAD_SHA, runCheckCiWithRollup } from './test-helpers/check-ci-gh-stub.mjs';

const TIMEOUT = 120_000;
const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// ============================================================
// 検査: 値が schema に「閉じた形」で適合するか（宣言の無いキー・items の無い配列の要素も食い違いにする）
// ============================================================

const TYPE_TESTS = {
  null: (v) => v === null,
  string: (v) => typeof v === 'string',
  integer: (v) => Number.isInteger(v),
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  boolean: (v) => typeof v === 'boolean',
  array: (v) => Array.isArray(v),
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
};

// 食い違いの一覧（空なら適合）。path は `$.failed_checks[].link` の形。required: false なら required の欠けは数えない。
function schemaGaps(value, schema, { required = true } = {}, path = '$') {
  if (schema == null || typeof schema !== 'object') return [`${path}: schema に宣言が無い`];
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!types.some((t) => TYPE_TESTS[t]?.(value))) return [`${path}: 型 ${JSON.stringify(schema.type)} に合わない値 ${JSON.stringify(value)}`];
  const gaps = [];
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) gaps.push(`${path}: enum ${JSON.stringify(schema.enum)} に無い値 ${JSON.stringify(value)}`);
  if (typeof value === 'number' && typeof schema.minimum === 'number' && value < schema.minimum) gaps.push(`${path}: minimum ${schema.minimum} 未満の値 ${value}`);
  if (Array.isArray(value)) {
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) gaps.push(`${path}: maxItems ${schema.maxItems} を超える`);
    value.forEach((v) => gaps.push(...schemaGaps(v, schema.items, { required }, `${path}[]`)));
  } else if (TYPE_TESTS.object(value)) {
    const props = schema.properties ?? {};
    if (required) for (const k of schema.required ?? []) if (!Object.hasOwn(value, k)) gaps.push(`${path}.${k}: required が無い`);
    for (const [k, v] of Object.entries(value)) gaps.push(...schemaGaps(v, Object.hasOwn(props, k) ? props[k] : undefined, { required }, `${path}.${k}`));
  }
  return gaps;
}

// schema が宣言する全キーの path（segment の配列。配列の要素は '[]'）
function declaredPaths(schema, prefix = []) {
  if (schema == null || typeof schema !== 'object') return [];
  const own = Object.entries(schema.properties ?? {}).flatMap(([k, s]) => [[...prefix, k], ...declaredPaths(s, [...prefix, k])]);
  return [...own, ...declaredPaths(schema.items, [...prefix, '[]'])];
}

// path の宣言を 1 つ外した schema の写し
function withoutDeclaration(schema, path) {
  const clone = structuredClone(schema);
  let node = clone;
  for (const seg of path.slice(0, -1)) node = seg === '[]' ? node.items : node.properties[seg];
  delete node.properties[path.at(-1)];
  return clone;
}

// runs: [{ branch, out, exit }]。全分岐が schema に適合し、宣言を 1 つ外すとどれかの分岐が外れることを確かめる。
function assertSchemaCoversRuns(name, schema, runs) {
  for (const { branch, out, exit } of runs) {
    assert.deepEqual(schemaGaps(out, schema, { required: exit === 0 }), [], `${name} / ${branch}: stdout が schema から外れている: ${JSON.stringify(out)}`);
  }
  for (const path of declaredPaths(schema)) {
    const mutated = withoutDeclaration(schema, path);
    assert.ok(
      runs.some(({ out }) => schemaGaps(out, mutated, { required: false }).length > 0),
      `${name}: ${path.join('.')} の宣言を外してもどの分岐の stdout も外れない（その分岐を実行していないか、スクリプトが出さないキー）`,
    );
  }
}

const lastLine = (p) => p.split('\n').at(-1);
// prompt の最終行（中継が実行するコマンド）を argv に分ける。check 名の単一引用符は外す（空白を含む引数は使わない）
function commandArgs(prompt, bin) {
  const tokens = lastLine(prompt).split(' ').map((t) => t.replace(/^'(.*)'$/, '$1'));
  assert.equal(tokens[0], bin, `prompt の最終行の先頭トークンが ${bin} でない: ${lastLine(prompt)}`);
  return tokens.slice(1);
}
const parseStdout = (r, label) => {
  let out;
  assert.doesNotThrow(() => { out = JSON.parse(r.stdout); }, `${label}: stdout が JSON でない: ${JSON.stringify(r.stdout)} / stderr: ${r.stderr}`);
  return out;
};

// ============================================================
// check-ci（stdout-relay。ci-check / ci-wait-check / ci-verify）
// ============================================================

const run = (name, conclusion, extra = {}) => ({
  __typename: 'CheckRun', name, workflowName: 'ci', status: conclusion ? 'COMPLETED' : 'IN_PROGRESS', conclusion: conclusion ?? '',
  startedAt: '2026-01-01T00:00:00Z', detailsUrl: `https://example.com/acme/skills/runs/${name}`, ...extra,
});
// 分岐ごとの rollup。check 名 e2e は ci-verify（--only 'e2e'）の対象で、どの分岐でも status が分岐名と同じになる
const ROLLUPS = {
  passed: [run('build', 'SUCCESS'), run('e2e', 'SUCCESS'), run('docs', 'SKIPPED')],
  failed: [run('build', 'FAILURE'), run('e2e', 'FAILURE'), run('lint', null)],
  pending: [run('build', 'SUCCESS'), run('e2e', null)],
  no_checks: null,
};
const STUB_OK = '#!/usr/bin/env bash\nexit 0\n';
const STUB_FAIL = '#!/usr/bin/env bash\necho "HTTP 502: Bad Gateway" >&2\nexit 1\n';

// 1 つの prompt のコマンドを全分岐で実行する。waits は待機する prompt（check-ci --wait）か
function checkCiRuns(prompt, { waits }) {
  const args = commandArgs(prompt, 'check-ci');
  assert.equal(args.includes('--wait'), waits, `prompt の --wait の有無が想定と違う: ${lastLine(prompt)}`);
  // 待機は sleep のスタブで即時に成立させる（check-ci --wait は ci-wait.sh の sleep の連結）
  const sleepOk = waits ? { sleep: STUB_OK } : {};
  const runs = [];
  const add = (branch, rollup, stubs, check) => {
    const r = runCheckCiWithRollup(JSON.stringify(rollup), args, stubs);
    const out = parseStdout(r, branch);
    check(out, r);
    runs.push({ branch, out, exit: r.status });
  };
  for (const [status, rollup] of Object.entries(ROLLUPS)) {
    add(status, rollup, sleepOk, (out, r) => {
      assert.equal(r.status, 0, r.stderr);
      assert.equal(out.status, status);
      assert.equal(out.head_sha, CHECK_CI_STUB_HEAD_SHA);
      assert.equal(out.slept, waits ? true : undefined, 'slept は --wait のときだけ true で出る');
    });
  }
  add('error（gh の取得失敗）', [], { ...sleepOk, gh: STUB_FAIL }, (out, r) => {
    assert.equal(r.status, 1);
    assert.equal(out.status, 'error');
    assert.match(out.message, /gh pr view: exit 1/);
  });
  add('epoch:null（date の失敗）', ROLLUPS.passed, { ...sleepOk, date: STUB_FAIL }, (out) => {
    assert.equal(out.status, 'passed');
    assert.equal(out.epoch, null);
  });
  if (waits) {
    add('slept:false（待機の不成立）', ROLLUPS.passed, { sleep: STUB_FAIL }, (out, r) => {
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(out, { slept: false, status: 'pending', passed: 0, failed: 0, pending: 0, skipped: 0 });
    });
  }
  return runs;
}

const CI_TARGET = { pr: 1, repo: 'acme/skills' };

test('[relay-schema] ci-check: check-ci の全分岐の stdout を CI_STATUS が宣言し、宣言を 1 つ外すと外れる', () => {
  const runs = checkCiRuns(ciCheckPrompt({ ...CI_TARGET, exclude: ['docs'] }), { waits: false });
  assertSchemaCoversRuns('CI_STATUS', CI_STATUS, runs);
}, TIMEOUT);

test('[relay-schema] ci-wait-check: check-ci --wait の全分岐（slept:true / slept:false）の stdout を CI_WAIT_CHECK が宣言し、宣言を 1 つ外すと外れる', () => {
  const runs = checkCiRuns(ciWaitCheckPrompt({ ...CI_TARGET, seconds: CI_POLL_SECONDS }), { waits: true });
  assertSchemaCoversRuns('CI_WAIT_CHECK', CI_WAIT_CHECK, runs);
}, TIMEOUT);

test('[relay-schema] ci-verify: check-ci --only（待機なし / --wait）の全分岐の stdout を CI_VERIFY_CHECK が宣言し、宣言を 1 つ外すと外れる', () => {
  const noWait = checkCiRuns(ciVerifyPrompt({ ...CI_TARGET, checks: ['e2e'], seconds: 0 }), { waits: false });
  const wait = checkCiRuns(ciVerifyPrompt({ ...CI_TARGET, checks: ['e2e'], seconds: CI_VERIFY_POLL_SECONDS }), { waits: true });
  const passed = noWait.find((r) => r.branch === 'passed').out;
  assert.deepEqual(passed.passed_checks.map((c) => c.name), ['e2e'], '--only は passed_checks を出す');
  assertSchemaCoversRuns('CI_VERIFY_CHECK', CI_VERIFY_CHECK, [
    ...noWait.map((r) => ({ ...r, branch: `待機なし / ${r.branch}` })),
    ...wait.map((r) => ({ ...r, branch: `--wait / ${r.branch}` })),
  ]);
}, TIMEOUT);

// ============================================================
// security-codex-relay が bin/ のスクリプトの stdout を返す中継（security-scope / prep / verdict / issues）
// ============================================================

const HEAD = 'a'.repeat(40);
const which = (name) => execFileSync('bash', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim();
// node の無い PATH（wrapper が要る bash と dirname だけ）。wrapper は node が無いとき固定の JSON を出す
function pathWithoutNode() {
  const dir = mkdtempSync(join(tmpdir(), 'relay-schema-nonode-'));
  for (const name of ['bash', 'dirname']) symlinkSync(which(name), join(dir, name));
  return dir;
}
// bin/<name> を実行して { out: stdout の JSON, exit } を返す。noNode は node の無い PATH で実行する
function runBin(name, args, { noNode = false } = {}) {
  const r = spawnSync(which('bash'), [join(pluginRoot, 'bin', name), ...args], {
    encoding: 'utf8', env: noNode ? { ...process.env, PATH: pathWithoutNode() } : process.env,
  });
  return { out: parseStdout(r, `${name} ${args.join(' ')}`), exit: r.status };
}

// main に README.md、branch pr に src/a.js を足した commit、作業ツリーに未コミットの変更を持つ一時 repo
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'relay-schema-repo-'));
  const g = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8').trim();
  g('init', '-q', '-b', 'main');
  for (const [k, v] of [['user.name', 't'], ['user.email', 't@example.com'], ['commit.gpgsign', 'false'], ['core.hooksPath', '/dev/null']]) g('config', k, v);
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'init');
  g('checkout', '-q', '-b', 'pr');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'a.js'), 'x\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'pr');
  const head = g('rev-parse', 'HEAD');
  writeFileSync(join(dir, 'src', 'b.js'), 'y\n');
  return { dir, head };
}

// security-review-codex-prep / -result が受ける保存先（名前は dev-flow-security-review-XXXXXX、symlink を含まない実パス）
function makeReviewDir(result) {
  const base = execFileSync('pwd', ['-P'], { cwd: mkdtempSync(join(tmpdir(), 'relay-schema-codex-')), encoding: 'utf8' }).trim();
  const reviewDir = mkdtempSync(join(base, 'dev-flow-security-review-'));
  writeFileSync(join(reviewDir, 'pr.diff'), 'diff --git a/x b/x\n');
  if (result !== undefined) writeFileSync(join(reviewDir, 'result.json'), typeof result === 'string' ? result : JSON.stringify(result));
  return reviewDir;
}
const issue = (severity, line) => ({ severity, topic: `t-${severity}`, file: 'src/x.sh', line, description: 'd', suggestion: 's' });
const resultOf = (issues, reviewedSha = HEAD) => ({ reviewed_sha: reviewedSha, issues, summary: 'ok' });

test('[relay-schema] security-scope: security-review-scope の全分岐（成功・取得失敗・usage・node なし）の stdout を SECURITY_SCOPE_SCHEMA が宣言し、宣言を 1 つ外すと外れる', () => {
  const repo = makeRepo();
  const BIN = 'security-review-scope';
  const prompt = (opts) => commandArgs(securityScopePrompt({ worktree: repo.dir, base: 'main', ...opts }), BIN);
  const runs = [];
  const add = (branch, args, check, opts) => {
    const { out, exit } = runBin(BIN, args, opts);
    check(out);
    runs.push({ branch, out, exit });
  };
  add('成功（--working-tree）', prompt({}), (o) => assert.deepEqual([o.ok, o.head_sha, o.file_count], [true, null, 2]));
  add('成功（head）', prompt({ head: repo.head }), (o) => assert.deepEqual([o.ok, o.head_sha, o.review_dir], [true, repo.head, null]));
  add('成功（head --save-diff）', prompt({ head: repo.head, saveDiff: true }), (o) => {
    assert.equal(o.ok, true, o.error);
    assert.equal(typeof o.review_dir, 'string');
    assert.equal(typeof o.diff_path, 'string');
  });
  add('取得失敗（git_failed）', commandArgs(securityScopePrompt({ worktree: repo.dir, base: 'no-such-base', head: repo.head }), BIN),
    (o) => assert.deepEqual([o.ok, o.target, o.error], [false, true, 'git_failed']));
  add('usage', [repo.dir], (o) => assert.deepEqual([o.ok, o.target, o.error], [false, true, 'usage']));
  add('node なし', prompt({ head: repo.head }), (o) => assert.deepEqual([o.ok, o.target, o.reasons], [false, true, ['scope_unavailable']]), { noNode: true });
  assertSchemaCoversRuns('SECURITY_SCOPE_SCHEMA', SECURITY_SCOPE_SCHEMA, runs);
}, TIMEOUT);

test('[relay-schema] security-codex-prep: security-review-codex-prep の全分岐（成功・失敗・usage・node なし）の stdout を SECURITY_CODEX_PREP_SCHEMA が宣言し、宣言を 1 つ外すと外れる', () => {
  const BIN = 'security-review-codex-prep';
  const reviewDir = makeReviewDir();
  const args = commandArgs(codexPrepPrompt({ reviewDir, headSha: HEAD, pr: 5 }), BIN);
  const runs = [];
  const add = (branch, argv, expected, opts) => {
    const { out, exit } = runBin(BIN, argv, opts);
    assert.deepEqual(out, expected, branch);
    runs.push({ branch, out, exit });
  };
  add('成功', args, { ok: true });
  add('失敗（保存先に前の入力が残っている）', args, { ok: false, error: 'review_dir_not_fresh' });
  add('失敗（保存先の形が不正）', commandArgs(codexPrepPrompt({ reviewDir: '/tmp/x', headSha: HEAD, pr: 5 }), BIN), { ok: false, error: 'review_dir_invalid' });
  add('usage', [reviewDir], { ok: false, error: 'usage' });
  add('node なし', args, { ok: false, error: 'node_unavailable' }, { noNode: true });
  assertSchemaCoversRuns('SECURITY_CODEX_PREP_SCHEMA', SECURITY_CODEX_PREP_SCHEMA, runs);
}, TIMEOUT);

test('[relay-schema] security-codex-verdict: security-review-codex-result の全分岐（clear・blocking・sha 不一致・判定不能・usage・node なし）の stdout を SECURITY_CODEX_RESULT_SCHEMA が宣言し、宣言を 1 つ外すと外れる', () => {
  const BIN = 'security-review-codex-result';
  const args = (reviewDir) => commandArgs(codexVerdictPrompt({ reviewDir, headSha: HEAD }), BIN);
  const runs = [];
  const add = (branch, argv, check, opts) => {
    const { out, exit } = runBin(BIN, argv, opts);
    check(out);
    runs.push({ branch, out, exit });
  };
  const verdict = (o) => [o.ok, o.cleared, o.reason, o.reviewed_sha, o.error];
  add('clear', args(makeReviewDir(resultOf([issue('minor', null)]))), (o) => {
    assert.deepEqual(verdict(o), [true, true, null, HEAD, undefined]);
    assert.deepEqual(o.counts, { critical: 0, major: 0, minor: 1 });
  });
  add('blocking', args(makeReviewDir(resultOf([issue('critical', 3)]))), (o) => assert.deepEqual(verdict(o), [true, false, 'blocking', HEAD, undefined]));
  add('sha 不一致（40 桁 hex でない reviewed_sha は null）', args(makeReviewDir(resultOf([], 'not-a-sha'))),
    (o) => assert.deepEqual(verdict(o), [true, false, 'sha_mismatch', null, undefined]));
  add('判定不能（result.json が無い）', args(makeReviewDir()), (o) => assert.deepEqual(verdict(o), [false, false, null, null, 'result_unreadable']));
  add('判定不能（schema に適合しない result.json）', args(makeReviewDir({})), (o) => assert.deepEqual(verdict(o), [false, false, null, null, 'schema_mismatch']));
  add('判定不能（保存先の形が不正）', args('/tmp/x'), (o) => assert.deepEqual(verdict(o), [false, false, null, null, 'review_dir_invalid']));
  add('usage', ['/tmp/x'], (o) => assert.deepEqual(verdict(o), [false, false, null, null, 'usage']));
  add('node なし', args(makeReviewDir()), (o) => {
    assert.deepEqual(verdict(o), [false, false, null, null, 'node_unavailable']);
    assert.deepEqual(o.issues, [], 'node が無いときの wrapper は判定の形に issues:[] も出す');
  }, { noNode: true });
  assertSchemaCoversRuns('SECURITY_CODEX_RESULT_SCHEMA', SECURITY_CODEX_RESULT_SCHEMA, runs);
}, TIMEOUT);

test('[relay-schema] security-codex-issues: security-review-codex-result --issues の全分岐（指摘あり・0 件・判定不能・usage・node なし）の stdout を SECURITY_CODEX_ISSUES_SCHEMA が宣言し、宣言を 1 つ外すと外れる', () => {
  const BIN = 'security-review-codex-result';
  const args = (reviewDir) => commandArgs(codexIssuesPrompt({ reviewDir, headSha: HEAD }), BIN);
  const runs = [];
  const add = (branch, argv, check, opts) => {
    const { out, exit } = runBin(BIN, argv, opts);
    check(out);
    runs.push({ branch, out, exit });
  };
  add('指摘あり（line あり / line:null は省かれる）', args(makeReviewDir(resultOf([issue('critical', 3), issue('minor', null)]))), (o) => {
    assert.equal(o.ok, true, o.error);
    assert.deepEqual(o.issues.map((x) => [x.severity, x.line]), [['critical', 3], ['minor', undefined]]);
  });
  add('0 件', args(makeReviewDir(resultOf([]))), (o) => assert.deepEqual(o, { ok: true, issues: [] }));
  add('判定不能（result.json が無い）', args(makeReviewDir()), (o) => assert.deepEqual(o, { ok: false, issues: [], error: 'result_unreadable' }));
  add('usage', ['/tmp/x', 'not-a-sha', '--issues'], (o) => assert.deepEqual(o, { ok: false, issues: [], error: 'usage' }));
  add('node なし', args(makeReviewDir()), (o) => {
    assert.deepEqual([o.ok, o.error], [false, 'node_unavailable']);
    assert.deepEqual(o.counts, { critical: 0, major: 0, minor: 0 }, 'node が無いときの wrapper は issues の形に判定のキーも出す');
  }, { noNode: true });
  assertSchemaCoversRuns('SECURITY_CODEX_ISSUES_SCHEMA', SECURITY_CODEX_ISSUES_SCHEMA, runs);
}, TIMEOUT);
