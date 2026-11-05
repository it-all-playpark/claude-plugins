// _lib/evaluator-prompt-trim.test.mjs
// evaluator.md を目的と理由で書いた簡素版に保つための静的 pin（命令語の太字・issue 番号を本文に持たせない）。
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const md = readFileSync(join(repoRoot, 'agents/evaluator.md'), 'utf8');
const body = md.replace(/^---\n[\s\S]*?\n---\n/, '');

test('evaluator.md: 太字の強調が無い', () => {
  assert.ok(!/\*\*[^*\n]+\*\*/.test(body), '太字の強調が残っている');
});

test('evaluator.md: issue 番号を本文に書かない', () => {
  assert.deepEqual(body.match(/#\d+/g) ?? [], []);
});
