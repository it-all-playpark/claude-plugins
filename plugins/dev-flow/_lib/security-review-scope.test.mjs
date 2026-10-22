// security-review-scope.test.mjs — 敵対的 security review の対象判定（issue #1063）。
//
// (1) 許可リスト: 対象外は「ファイル 1 件以上・全ファイルが許可リスト（mode 100644 の .md/.mdx/.rst のうち指示ファイル
//     でないもの、*.test.* / *.spec.* / .bats）」のときだけ。指示ファイルは大文字小文字を区別しない
// (2) #1058 の squash merge（main の 920f25d とその親）の diff は対象、その README だけの diff は対象外。
//     CI の checkout は shallow なので、diff は同じ引数で取った fixture（test-helpers/fixtures/pr-1058-squash.diff）で持つ
// (3) diff の取得（_lib/scripts/security-review-scope.mjs）: color.ui=always・diff.external・textconv・-diff 属性を
//     設定した repo と、空白・非 ASCII を含むパスで、取得失敗・空・binary・mode 120000 / 160000・mode だけの変更・
//     .gitattributes / .gitmodules の変更が対象になる
//
// Run: npx vitest run _lib/security-review-scope.test.mjs
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isInstructionPath, isSecurityReviewExemptPath, parseScopePatch, securityReviewScope,
  SECURITY_SCOPE_DIFF_ARGS, SECURITY_SCOPE_GIT_CONFIG,
} from './security-review-scope.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, 'scripts', 'security-review-scope.mjs');
const WRAPPER = join(here, '..', 'bin', 'security-review-scope');

// 1 file の patch（mode 100644 の内容変更）
function filePatch(path, { mode = '100644', added = 'new line' } = {}) {
  return [
    `diff --git a/${path} b/${path}`,
    `index 1111111..2222222 ${mode}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1 +1,2 @@',
    ' old line',
    `+${added}`,
  ].join('\n') + '\n';
}
const scopeOf = (paths, opts) => securityReviewScope({ patch: paths.map((p) => filePatch(p, opts)).join(''), names: paths });

// ---- (1) 許可リスト ----

test('[scope][AC1] 許可リストに当たるファイルだけの diff は対象外（.md / .mdx / .rst / *.test.* / *.spec.* / .bats。拡張子は大文字小文字を区別しない）', () => {
  for (const paths of [
    ['README.md'], ['docs/guide.mdx'], ['docs/x.rst'], ['Docs/NOTES.MD'],
    ['src/a.test.ts'], ['src/a.spec.js'], ['tests/x.bats'],
    ['README.md', 'docs/guide.mdx', 'src/a.test.mjs', 'plugins/p/scripts/x.bats'],
  ]) {
    const r = scopeOf(paths);
    assert.equal(r.target, false, `${paths.join(', ')} は対象外のはず: ${JSON.stringify(r.reasons)}`);
    assert.deepEqual(r.reasons, []);
  }
});

test('[scope][AC1] 指示ファイル（CLAUDE.md・AGENTS.md・SKILL.md・.claude/・references/・output-styles/・agents/・commands/ 配下）は大文字小文字を区別せず対象', () => {
  for (const p of [
    'CLAUDE.md', 'claude.md', 'sub/Claude.MD', 'AGENTS.md', 'pkg/agents.md', 'x/SKILL.md', 'x/skill.md',
    '.claude/rules/x.md', 'a/.CLAUDE/x.md', 'x/references/y.md', 'a/b/References/y.md',
    'output-styles/z.md', 'p/Output-Styles/z.mdx', 'plugins/p/agents/q.md', 'plugins/p/AGENTS/q.rst',
    'commands/ns/z.md', 'x/Commands/deep/ns/z.md', '.claude/hooks/x.test.sh', 'agents/x.bats',
  ]) {
    assert.equal(isInstructionPath(p) || !isSecurityReviewExemptPath(p), true, p);
    const r = scopeOf(['README.md', p]);
    assert.equal(r.target, true, `${p} を含む diff は対象のはず`);
    assert.ok(r.reasons.some((x) => x.includes(p)), `${p} が理由に無い: ${JSON.stringify(r.reasons)}`);
  }
});

test('[scope][AC1] 許可リスト外のファイル・mode 100644 以外・ファイル 0 件は対象', () => {
  for (const p of ['src/x.ts', 'requirements.txt', 'docs/x.py', 'tests/x.sh', '.github/workflows/ci.yml', 'Makefile', '.test.js', '.md']) {
    assert.equal(scopeOf(['README.md', p]).target, true, p);
  }
  assert.equal(scopeOf(['README.md'], { mode: '100755' }).target, true, 'mode 100755 の .md は対象');
  assert.equal(scopeOf(['src/a.test.ts'], { mode: '100755' }).target, true, 'mode 100755 のテストは対象');
  assert.deepEqual(securityReviewScope({ patch: 'x', names: [] }).target, true);
  assert.deepEqual(securityReviewScope({ patch: '', names: [] }).reasons, ['diff_empty']);
});

// ---- (2) #1058 ----

const PR_1058 = readFileSync(join(here, 'test-helpers', 'fixtures', 'pr-1058-squash.diff'), 'utf8');
const PR_1058_NAMES = [
  'plugins/meeting/README.md', 'plugins/meeting/meeting-notes/SKILL.md',
  'plugins/meeting/scripts/meeting.bats', 'plugins/meeting/scripts/meeting.sh',
];
// fixture の file ごとの区切り（`diff --git` 行で始まる塊）
const PR_1058_SECTIONS = PR_1058.split(/(?=^diff --git )/m);

test('[scope][AC2] #1058 の squash merge（920f25d とその親）の diff は対象', () => {
  const r = securityReviewScope({ patch: PR_1058, names: PR_1058_NAMES });
  assert.equal(r.target, true);
  assert.ok(r.reasons.includes('not_allowlisted: plugins/meeting/scripts/meeting.sh'), JSON.stringify(r.reasons));
  assert.ok(r.reasons.includes('not_allowlisted: plugins/meeting/meeting-notes/SKILL.md'), JSON.stringify(r.reasons));
});

test('[scope][AC2] その diff の plugins/meeting/README.md だけの diff は対象外', () => {
  const readme = PR_1058_SECTIONS.find((s) => s.startsWith('diff --git a/plugins/meeting/README.md '));
  assert.ok(readme, 'fixture に README.md の塊が無い');
  const r = securityReviewScope({ patch: readme, names: ['plugins/meeting/README.md'] });
  assert.deepEqual(r, { target: false, reasons: [], files: ['plugins/meeting/README.md'] });
});

test('[scope][AC2] CLAUDE.md / .claude/rules/x.md / x/references/y.md / commands/ns/z.md / requirements.txt / docs/x.py / tests/x.sh を含む diff は対象', () => {
  const readme = PR_1058_SECTIONS.find((s) => s.startsWith('diff --git a/plugins/meeting/README.md '));
  for (const p of ['CLAUDE.md', '.claude/rules/x.md', 'x/references/y.md', 'commands/ns/z.md', 'requirements.txt', 'docs/x.py', 'tests/x.sh']) {
    const r = securityReviewScope({ patch: readme + filePatch(p), names: ['plugins/meeting/README.md', p] });
    assert.equal(r.target, true, `${p} を含む diff は対象のはず`);
    assert.ok(r.reasons.some((x) => x.endsWith(p)), `${p}: ${JSON.stringify(r.reasons)}`);
  }
});

// ---- (3) 取得（patch の読み方と CLI）----

test('[scope][AC3] diff の取得は --no-renames --no-color --no-ext-diff --no-textconv --text と core.quotePath=false で行う', () => {
  for (const flag of ['--no-renames', '--no-color', '--no-ext-diff', '--no-textconv', '--text']) {
    assert.ok(SECURITY_SCOPE_DIFF_ARGS.includes(flag), flag);
  }
  assert.deepEqual(SECURITY_SCOPE_GIT_CONFIG, ['-c', 'core.quotePath=false']);
  const cli = readFileSync(CLI, 'utf8');
  assert.match(cli, /git\(\['diff', \.\.\.SECURITY_SCOPE_DIFF_ARGS, \.\.\.range\]\)/);
  assert.match(cli, /git\(\['diff', \.\.\.SECURITY_SCOPE_DIFF_ARGS, '--name-only', '-z', \.\.\.range\]\)/);
  assert.match(cli, /\['-C', worktree, \.\.\.SECURITY_SCOPE_GIT_CONFIG/);
});

test('[scope][AC3] ファイル一覧（--name-only -z）との件数・集合の不一致、読めない patch、引用符付きパス、hunk の行数の嘘は対象', () => {
  const two = filePatch('README.md') + filePatch('docs/a.md');
  assert.match(securityReviewScope({ patch: two, names: ['README.md'] }).reasons[0], /^file_count_mismatch/);
  assert.match(securityReviewScope({ patch: two, names: ['README.md', 'docs/b.md'] }).reasons[0], /^file_list_mismatch/);
  assert.equal(securityReviewScope({ patch: two, names: null }).target, true);
  assert.equal(securityReviewScope({ patch: null, names: ['README.md'] }).target, true);
  assert.match(securityReviewScope({ patch: 'hello\n', names: ['README.md'] }).reasons[0], /^diff_unreadable/);
  const quoted = 'diff --git "a/docs/a\\tb.md" "b/docs/a\\tb.md"\nindex 1..2 100644\n';
  assert.match(securityReviewScope({ patch: quoted, names: ['docs/a\tb.md'] }).reasons[0], /^diff_unreadable/);
  // hunk が @@ の行数より長い（次の行がヘッダでも hunk でもない）
  const lying = filePatch('README.md').replace('@@ -1 +1,2 @@', '@@ -1 +1 @@');
  assert.match(securityReviewScope({ patch: lying, names: ['README.md'] }).reasons[0], /^diff_unreadable/);
});

test('[scope][AC3] hunk の中の `+++ b/...` / `--- a/...` 行はヘッダと取り違えない', () => {
  const patch = [
    'diff --git a/README.md b/README.md',
    'index 1111111..2222222 100644',
    '--- a/README.md',
    '+++ b/README.md',
    '@@ -1,3 +1,4 @@',
    ' a',
    '+++ b/evil.sh',
    '--- a/evil.sh',
    ' b',
    '+c',
  ].join('\n') + '\n';
  const parsed = parseScopePatch(patch);
  assert.equal(parsed.ok, true, parsed.error);
  assert.deepEqual(parsed.files.map((f) => f.path), ['README.md']);
  assert.equal(securityReviewScope({ patch, names: ['README.md'] }).target, false);
});

// 一時 repo: color.ui=always・diff.external・textconv（*.md）・-diff 属性（*.rst）を設定し、main に README.md を置く
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'scope-repo-'));
  const g = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8').trim();
  g('init', '-q', '-b', 'main');
  for (const [k, v] of [
    ['user.name', 't'], ['user.email', 't@example.com'], ['commit.gpgsign', 'false'], ['core.hooksPath', '/dev/null'],
    ['color.ui', 'always'], ['color.diff', 'always'], ['core.quotePath', 'true'], ['diff.noprefix', 'true'],
  ]) g('config', k, v);
  const hooks = mkdtempSync(join(tmpdir(), 'scope-hooks-'));
  writeFileSync(join(hooks, 'ext.sh'), '#!/bin/sh\necho EXTERNAL-DIFF-OUTPUT\n');
  writeFileSync(join(hooks, 'conv.sh'), '#!/bin/sh\necho TEXTCONV-OUTPUT\n');
  chmodSync(join(hooks, 'ext.sh'), 0o755);
  chmodSync(join(hooks, 'conv.sh'), 0o755);
  g('config', 'diff.external', join(hooks, 'ext.sh'));
  g('config', 'diff.evil.textconv', join(hooks, 'conv.sh'));
  mkdirSync(join(dir, '.git', 'info'), { recursive: true });
  writeFileSync(join(dir, '.git', 'info', 'attributes'), '*.md diff=evil\n*.rst -diff\n');
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'init');
  const write = (rel, content) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  };
  const commit = (msg = 'c', { stage = true } = {}) => { if (stage) g('add', '-A'); g('commit', '-q', '--allow-empty', '-m', msg); return g('rev-parse', 'HEAD'); };
  const branch = (name) => g('checkout', '-q', '-f', '-b', name, 'main');
  return { dir, g, write, commit, branch };
}

const runCli = (args) => JSON.parse(execFileSync('bash', [WRAPPER, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8'));

test('[scope][AC3] color.ui=always / diff.external / textconv / -diff を設定した repo でも、空白と非 ASCII を含む文書だけの PR は対象外で、diff 全文は生の内容', () => {
  const repo = makeRepo();
  repo.branch('docs');
  repo.write('docs/設計 メモ.md', '# 設計\n本文\n');
  repo.write('docs/notes file.rst', 'notes\n');
  repo.write('README.md', 'hello\nworld\n');
  const head = repo.commit('docs');
  const r = runCli([repo.dir, 'main', head, '--save-diff']);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.target, false, JSON.stringify(r.reasons));
  assert.equal(r.file_count, 3);
  assert.equal(r.head_sha, head);
  assert.ok(!r.review_dir.startsWith(repo.dir), 'diff の保存先は worktree の外');
  const saved = readFileSync(r.diff_path, 'utf8');
  assert.ok(saved.includes('diff --git a/docs/設計 メモ.md b/docs/設計 メモ.md'), 'core.quotePath=false で非 ASCII のパスがそのまま出る');
  assert.ok(saved.includes('+本文') && saved.includes('+notes'), 'textconv / -diff 属性を打ち消した生の内容');
  assert.ok(!saved.includes('EXTERNAL-DIFF-OUTPUT') && !saved.includes('TEXTCONV-OUTPUT') && !saved.includes('\u001b['), 'diff.external / textconv / 色を使っていない');
});

test('[scope][AC3] 取得の失敗・空の diff・binary・mode 120000 / 160000・mode だけの変更・.gitattributes / .gitmodules の変更は対象', () => {
  const repo = makeRepo();
  const cases = [];
  const add = (name, setup, opts) => {
    repo.branch(name);
    setup();
    cases.push([name, repo.commit(name, opts)]);
  };
  add('binary', () => repo.write('docs/bin 画像.md', Buffer.from([0x61, 0x00, 0x62, 0x0a])));
  add('symlink', () => { mkdirSync(join(repo.dir, 'docs'), { recursive: true }); symlinkSync('../README.md', join(repo.dir, 'docs/link メモ.md')); });
  add('gitlink', () => repo.g('update-index', '--add', '--cacheinfo', `160000,${repo.g('rev-parse', 'main')},docs/sub.md`), { stage: false });
  add('mode-only', () => repo.g('update-index', '--chmod=+x', 'README.md'), { stage: false });
  add('gitattributes', () => repo.write('.gitattributes', '*.sh text\n'));
  add('gitmodules', () => repo.write('.gitmodules', '[submodule "x"]\n\tpath = x\n\turl = ../x\n'));
  const expected = {
    binary: /^binary: docs\/bin 画像\.md$/,
    symlink: /^mode: docs\/link メモ\.md \(120000\)$/,
    gitlink: /^mode: docs\/sub\.md \(160000\)$/,
    'mode-only': /^mode_change: README\.md$/,
    gitattributes: /^git_metadata: \.gitattributes$/,
    gitmodules: /^git_metadata: \.gitmodules$/,
  };
  for (const [name, head] of cases) {
    const r = runCli([repo.dir, 'main', head]);
    assert.equal(r.ok, true, `${name}: ${r.error}`);
    assert.equal(r.target, true, `${name} は対象のはず`);
    assert.ok(r.reasons.some((x) => expected[name].test(x)), `${name}: ${JSON.stringify(r.reasons)}`);
  }
  const empty = runCli([repo.dir, 'main', 'main']);
  assert.deepEqual([empty.ok, empty.target, empty.reasons], [true, true, ['diff_empty']]);
  const missing = runCli([repo.dir, 'no-such-base', 'HEAD']);
  assert.deepEqual([missing.ok, missing.target], [false, true]);
  const notRepo = runCli([mkdtempSync(join(tmpdir(), 'scope-norepo-')), 'main']);
  assert.deepEqual([notRepo.ok, notRepo.target], [false, true]);
});

test('[scope] --working-tree は merge-base と作業ツリー（untracked を含み .devflow-tmp/ を除く）を比べ、実 index を触らない', () => {
  const repo = makeRepo();
  repo.branch('wip');
  repo.write('docs/新規 文書.md', 'x\n');
  repo.write('.devflow-tmp/prerun-setup.json', '{}\n');
  const docsOnly = runCli([repo.dir, 'main', '--working-tree']);
  assert.deepEqual([docsOnly.ok, docsOnly.target, docsOnly.file_count], [true, false, 1], JSON.stringify(docsOnly));
  repo.write('scripts/run.sh', 'echo hi\n');
  const withScript = runCli([repo.dir, 'main', '--working-tree']);
  assert.equal(withScript.target, true);
  assert.ok(withScript.reasons.includes('not_allowlisted: scripts/run.sh'), JSON.stringify(withScript.reasons));
  assert.equal(repo.g('diff', '--cached', '--name-only'), '', '実 index に stage していない');
});
