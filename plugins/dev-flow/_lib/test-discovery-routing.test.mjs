// evaluator prompt の test_files 受理条件（test_discovery）は Setup が解決したテストコマンド（dev-flow-test-commands の
// 返り値。redgreen-verify が --commands で読むのと同じもの）から注入する（issue #1279）。
// dev-flow.js を VM で実行し、eval#1 の prompt に解決したコマンドと解決元が載り、言語別の受理 glob が載らないことを観測する。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash, testCommandsPrepareResponse } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', '.claude/workflows/dev-flow.js'), 'utf8');

async function evalPrompt(prepare, name) {
  const { ctx, calls } = makeDevFlowSandbox({ overrides: { 'resolve-test-commands': prepare } });
  const { error } = await runWorkflowCapture(src, ctx);
  assertNoCrash(error, name);
  const ev = calls.find((c) => c.label === 'eval#1');
  assert.ok(ev, 'eval#1 が呼ばれていない');
  return ev.prompt;
}

test('[test-discovery] eval#1 prompt に解決した files_command と解決元が注入され、言語別の受理 glob は載らない', async () => {
  const prompt = await evalPrompt(
    testCommandsPrepareResponse({ source: 'user_config', full_command: 'uv run pytest', files_command: 'uv run pytest {files}', sources: [] }),
    'user-config');
  assert.ok(prompt.includes('test_discovery（'));
  assert.ok(prompt.includes('解決元は user 設定。`uv run pytest {files}` の {files} に test_files を入れて実行する'), prompt);
  for (const g of ['*.test.mjs', '*.test.ts', '*.test.tsx', 'test_*.py', '*_test.py', '*.bats']) {
    assert.ok(!prompt.includes(g), `eval#1 prompt に受理 glob ${g} が載っている`);
  }
});

test('[test-discovery] 解決元が tests/run-*.sh なら eval#1 prompt は script のパスを載せる', async () => {
  const prompt = await evalPrompt(testCommandsPrepareResponse(), 'runners');
  assert.ok(prompt.includes('解決元は base の tests/run-*.sh（tests/run-unit.sh）'), prompt);
});

test('[test-discovery] テストコマンドが未解決なら eval#1 prompt は test_files を挙げず inspection にさせる', async () => {
  const prompt = await evalPrompt({ ok: false, error: 'origin/main を解決できない' }, 'unresolved');
  assert.ok(prompt.includes('test_discovery（'));
  assert.ok(prompt.includes('テストコマンド未解決'));
});
