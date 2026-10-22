// classifySecurityReviewTarget（_lib/security-review-target.mjs）と CLI（_lib/scripts/security-review-target.mjs）の
// 決定論判定を pin する（issue #1063）。
//
// fixture（test-fixtures/security-review-target/）:
//   pr-1058.diff           — #1058 の squash merge（main の 920f25d）とその親の diff（`git diff 920f25d^ 920f25d`）。
//                            sandbox の外で動かす入口（meeting set-names）を足し、議事録の frontmatter で決まるパスを書き換える
//   pr-1058-docs-only.diff — 同じ diff の docs（README.md / SKILL.md）だけ。excludedCommands の設定例を含むが docs は実行されない

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { classifySecurityReviewTarget, SECURITY_REVIEW_REASONS_MAX } from './security-review-target.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(here, 'test-fixtures', 'security-review-target', name), 'utf8');
const CLI = join(here, 'scripts', 'security-review-target.mjs');

const fileDiff = (path, added, { newFile = false } = {}) => [
  `diff --git a/${path} b/${path}`,
  ...(newFile ? ['new file mode 100644', '--- /dev/null'] : [`--- a/${path}`]),
  `+++ b/${path}`,
  `@@ -1,1 +1,${added.length + 1} @@`,
  ' context',
  ...added.map((l) => `+${l}`),
].join('\n');

test('[security-review-target] #1058（920f25d とその親の diff）は対象: sandbox の外の入口と、frontmatter で決まるパスへの書き込み', () => {
  const r = classifySecurityReviewTarget(fixture('pr-1058.diff'));
  assert.equal(r.target, true);
  assert.deepEqual(r.reasons, [
    'sandbox_boundary: plugins/meeting/scripts/meeting.sh',
    'path_write: plugins/meeting/scripts/meeting.sh',
  ]);
});

test('[security-review-target] docs だけの diff（#1058 の README / SKILL.md。excludedCommands の設定例を含む）は対象外', () => {
  const diff = fixture('pr-1058-docs-only.diff');
  assert.match(diff, /excludedCommands/, 'fixture が docs の sandbox 設定例を含まない — fixture を見直す');
  assert.deepEqual(classifySecurityReviewTarget(diff), { target: false, reasons: [] });
});

test('[security-review-target] CLI は stdin の diff を同じ判定にかけて JSON 1 行を出す', () => {
  for (const name of ['pr-1058.diff', 'pr-1058-docs-only.diff']) {
    const out = execFileSync('node', [CLI], { input: fixture(name), encoding: 'utf8' });
    assert.equal(out.split('\n').filter(Boolean).length, 1);
    assert.deepEqual(JSON.parse(out), classifySecurityReviewTarget(fixture(name)), name);
  }
});

test.each([
  ['.claude/settings.json の変更', fileDiff('.claude/settings.json', ['"x": 1']), 'permission_config: .claude/settings.json'],
  ['plugin の hook script', fileDiff('plugins/x/hooks/guard.sh', ['echo ok']), 'permission_config: plugins/x/hooks/guard.sh'],
  ['.githooks の hook', fileDiff('.githooks/pre-commit', ['exit 0']), 'permission_config: .githooks/pre-commit'],
  ['.mcp.json の変更', fileDiff('.mcp.json', ['"command": "npx"']), 'permission_config: .mcp.json'],
  ['plugin manifest の変更', fileDiff('plugins/x/.claude-plugin/plugin.json', ['"version": "1.0.1"']), 'permission_config: plugins/x/.claude-plugin/plugin.json'],
  ['mcpServers に触れるコード', fileDiff('src/setup.ts', ['cfg.mcpServers[name] = spec']), 'sandbox_boundary: src/setup.ts'],
  ['excludedCommands に触れるコード', fileDiff('src/setup.ts', ['cfg.sandbox.excludedCommands.push(cmd)']), 'sandbox_boundary: src/setup.ts'],
  ['Python の書き込みモードの open', fileDiff('scripts/a.py', ['with open(path, "w") as f:']), 'path_write: scripts/a.py'],
  ['Node の writeFileSync', fileDiff('lib/b.mjs', ['writeFileSync(target, body)']), 'path_write: lib/b.mjs'],
  ['shell の変数パスへのリダイレクト', fileDiff('bin/c.sh', ['printf "%s" "$x" > "$out"']), 'path_write: bin/c.sh'],
  ['shell の ln', fileDiff('bin/d.sh', ['ln -s "$src" "$dst"']), 'path_write: bin/d.sh'],
  ['新規 file（git diff --no-index /dev/null の形）', fileDiff('bin/new.sh', ['cp "$a" "$b"'], { newFile: true }), 'path_write: bin/new.sh'],
])('[security-review-target] 対象: %s', (_name, diff, reason) => {
  assert.deepEqual(classifySecurityReviewTarget(diff), { target: true, reasons: [reason] });
});

test.each([
  ['読み取りだけのコード', fileDiff('scripts/a.py', ['text = open(path, "r").read()', 'data = json.load(f)'])],
  ['/dev/null へのリダイレクト', fileDiff('bin/c.sh', ['cmd >/dev/null 2>&1'])],
  ['テストファイルの書き込み', fileDiff('bin/c.bats', ['echo x > "$BATS_TEST_TMPDIR/f"'])],
  ['test.mjs の writeFileSync', fileDiff('lib/b.test.mjs', ['writeFileSync(p, s)'])],
  ['docs/ 配下の sandbox の説明', fileDiff('docs/guide.txt', ['sandbox.excludedCommands に足す'])],
  ['空の diff', ''],
])('[security-review-target] 対象外: %s', (_name, diff) => {
  assert.deepEqual(classifySecurityReviewTarget(diff), { target: false, reasons: [] });
});

const removedDiff = (path, removed) => [
  `diff --git a/${path} b/${path}`,
  `--- a/${path}`,
  `+++ b/${path}`,
  `@@ -1,${removed.length + 1} +1,1 @@`,
  ' context',
  ...removed.map((l) => `-${l}`),
].join('\n');

test('[security-review-target] core.quotePath で quote された非 ASCII のパスも戻して判定する', () => {
  // git が `scripts/議事録.sh` を出す形（UTF-8 のバイトを 8 進でエスケープ）
  const q = '"b/scripts/\\350\\255\\260\\344\\272\\213\\351\\214\\262.sh"';
  const diff = [
    `diff --git "a/scripts/\\350\\255\\260\\344\\272\\213\\351\\214\\262.sh" ${q}`,
    '--- "a/scripts/\\350\\255\\260\\344\\272\\213\\351\\214\\262.sh"',
    `+++ ${q}`,
    '@@ -1,1 +1,2 @@',
    ' context',
    '+mv "$a" "$b"',
  ].join('\n');
  assert.deepEqual(classifySecurityReviewTarget(diff), { target: true, reasons: ['path_write: scripts/議事録.sh'] });
});

test('[security-review-target] quote された docs のパスは戻したうえで docs として対象外', () => {
  const diff = [
    'diff --git "a/docs/\\346\\211\\213\\351\\240\\206.md" "b/docs/\\346\\211\\213\\351\\240\\206.md"',
    '--- "a/docs/\\346\\211\\213\\351\\240\\206.md"',
    '+++ "b/docs/\\346\\211\\213\\351\\240\\206.md"',
    '@@ -1,1 +1,2 @@',
    ' context',
    '+手順',
  ].join('\n');
  assert.deepEqual(classifySecurityReviewTarget(diff), { target: false, reasons: [] });
});

test('[security-review-target] パスを読めない diff ヘッダは対象に倒す', () => {
  const diff = ['diff --git "a/broken\\q" "b/broken\\q"', '+mv x y'].join('\n');
  const r = classifySecurityReviewTarget(diff);
  assert.equal(r.target, true);
  assert.equal(r.reasons.length, 1);
  assert.match(r.reasons[0], /^unparsed_path: diff --git /);
});

test.each([
  ['excludedCommands を消す変更（deny の削除も境界を動かす）', removedDiff('src/setup.ts', ['denyWrite: ["~/.ssh"],']), 'sandbox_boundary: src/setup.ts'],
  ['agents/*.md の tools を変える変更', fileDiff('plugins/x/agents/runner.md', ['tools: Bash, Write']), 'permission_config: plugins/x/agents/runner.md'],
  ['SKILL.md の allowed-tools を消す変更', removedDiff('plugins/x/foo/SKILL.md', ['allowed-tools: Read']), 'permission_config: plugins/x/foo/SKILL.md'],
  ['hooks/ 配下の .md（docs の除外より先に権限設定として見る）', fileDiff('plugins/x/hooks/README.md', ['x']), 'permission_config: plugins/x/hooks/README.md'],
])('[security-review-target] 対象（削除行・定義ファイル）: %s', (_name, diff, reason) => {
  assert.deepEqual(classifySecurityReviewTarget(diff), { target: true, reasons: [reason] });
});

test('[security-review-target] agents/*.md の権限キーに触れない本文の変更は対象外', () => {
  assert.deepEqual(classifySecurityReviewTarget(fileDiff('plugins/x/agents/runner.md', ['diff を読んで要約する'])), { target: false, reasons: [] });
});

test('[security-review-target] reasons は重複なしで上限件数まで', () => {
  const many = Array.from({ length: SECURITY_REVIEW_REASONS_MAX + 5 }, (_, k) => fileDiff(`bin/s${k}.sh`, ['mv "$a" "$b"', 'mv "$c" "$d"'])).join('\n');
  const r = classifySecurityReviewTarget(many);
  assert.equal(r.target, true);
  assert.equal(r.reasons.length, SECURITY_REVIEW_REASONS_MAX);
  assert.equal(new Set(r.reasons).size, r.reasons.length);
});
