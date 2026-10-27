// test-related-paths.test.mjs — final_test_red の確認範囲に出す「テスト関連の変更」の判定（issue #1180）。
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { isTestFilePath } from './post-eval-recheck.mjs';
import { isTestRelatedPath, testRelatedChanges } from './test-related-paths.mjs';
// workflow では post-eval-recheck.mjs が同じ script に inline されて isTestFilePath が見える（md-cell と同じ形）
globalThis.isTestFilePath = isTestFilePath;

test('isTestRelatedPath: isTestFilePath に当たるパスはテスト関連', () => {
  for (const p of ['tests/run-all.sh', 'src/__tests__/a.js', 'src/a.test.ts', 'src/a.spec.js', 'pkg/a_test.go', 'x/foo.bats', 'spec/models/user_spec.rb']) {
    assert.equal(isTestFilePath(p), true, p);
    assert.equal(isTestRelatedPath(p), true, p);
  }
});

test('isTestRelatedPath: テストの実行を変えうる設定はどのディレクトリにあってもテスト関連', () => {
  for (const p of [
    'package.json', 'packages/web/package.json',
    'vitest.config.js', 'vitest.config.mjs', 'jest.config.cjs', 'playwright.config.ts', 'apps/x/vite.config.mts', 'a.config.cts',
    'pyproject.toml', 'setup.cfg', 'tox.ini', 'pytest.ini', 'conftest.py', 'src/pkg/conftest.py',
    '.github/workflows/ci.yml', '.github/workflows/nested/x.yaml',
    'Makefile', 'makefile', 'GNUmakefile', 'sub/Makefile',
  ]) {
    assert.equal(isTestFilePath(p), false, `isTestFilePath だけでは当たらない前提: ${p}`);
    assert.equal(isTestRelatedPath(p), true, p);
  }
});

test('isTestRelatedPath: テストの補助ファイル（fixture・mock・snapshot 等）は迷う側としてテスト関連', () => {
  for (const p of ['src/fixtures/a.json', 'fixture/b.txt', 'src/__mocks__/fs.js', 'src/__snapshots__/a.snap', 'a/b.snap', 'go/testdata/x', 'lib/test-helpers/h.js', 'e2e/login.ts']) {
    assert.equal(isTestRelatedPath(p), true, p);
  }
});

test('isTestRelatedPath: 実装・文書・テスト設定でない設定はテスト関連でない', () => {
  for (const p of ['src/index.ts', 'README.md', 'docs/package.md', 'src/config.ts', 'tsconfig.json', 'src/makefile.ts', '.github/CODEOWNERS', 'package.json.bak', '', null, undefined, 1]) {
    assert.equal(isTestRelatedPath(p), false, String(p));
  }
});

test('testRelatedChanges: 祖先（outside 0）で一覧が取れたらテスト関連だけを重複なく返し、無ければ none', () => {
  assert.deepEqual(
    testRelatedChanges({ ok: true, outside: 0, files: ['src/a.ts', 'tests/a.bats', ' package.json ', 'tests/a.bats', ''] }),
    { status: 'changed', files: ['tests/a.bats', 'package.json'] },
  );
  assert.deepEqual(testRelatedChanges({ ok: true, outside: 0, files: ['src/a.ts', 'README.md'] }), { status: 'none', files: [] });
  assert.deepEqual(testRelatedChanges({ ok: true, outside: 0, files: [] }), { status: 'none', files: [] });
});

test('testRelatedChanges: 一覧が取れない・HOLD 時の head が祖先でない・形が崩れた応答は unknown（none にしない）', () => {
  for (const res of [
    null, undefined,
    { ok: false },
    { ok: true, outside: 2, files: [] },          // HOLD 時の head が終端 head の祖先でない（force push 等）
    { ok: true, outside: '0', files: [] },        // 転写で型が崩れた
    { ok: true, files: ['src/a.ts'] },            // 祖先判定が無い
    { ok: true, outside: 0 },                     // 一覧が無い
    { ok: true, outside: 0, files: 'src/a.ts' },
    { ok: true, outside: 0, files: ['src/a.ts', 1] },
  ]) {
    assert.deepEqual(testRelatedChanges(res), { status: 'unknown', files: [] }, JSON.stringify(res));
  }
});
