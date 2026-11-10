// _lib/redgreen-runner-docs.test.mjs
// redgreen-verify のテストの実行の形は Setup が解決したテストコマンドだけが決める（issue #1279）。evaluator.md と
// exec-proxy.md の redgreen 行に固定の受理 glob を書き戻して実行の形と drift させない。
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const evaluatorMd = readFileSync(join(repoRoot, 'agents/evaluator.md'), 'utf8');
const execProxyMd = readFileSync(join(repoRoot, 'dev-flow/references/exec-proxy.md'), 'utf8');

const FIXED_GLOBS = ['`*.test.mjs`', '`*.bats`', '`*.test.ts`', '`*.test.tsx`'];

test('evaluator.md: test_files の受理条件は prompt の test_discovery を参照し、固定の 4 glob を持たない', () => {
  const line = evaluatorMd.split('\n').find((l) => /test_files は prompt の test_discovery/.test(l));
  assert.ok(line, 'test_files の受理条件が test_discovery を参照していない');
  for (const g of FIXED_GLOBS) assert.ok(!evaluatorMd.includes(g), `evaluator.md に固定 glob ${g} が残っている`);
});

test('exec-proxy.md: redgreen 行が入力エラーにテストコマンド未解決と base と違う tests/run-*.sh を挙げ、固定の受理 glob を持たない', () => {
  const match = execProxyMd.match(/^\| redgreen.*$/m);
  assert.ok(match, 'redgreen 行が見つからない');
  const line = match[0];
  assert.ok(line.includes('テストコマンド未解決'));
  assert.ok(line.includes('`tests/run-*.sh` が base と違う'));
  assert.ok(!line.includes('受理 glob'));
  assert.ok(line.split('|')[3].trim().startsWith('fail-safe'), 'redgreen 行のポリシーが fail-safe でない');
});
