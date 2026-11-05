// dev-flow-canary-child workflow の単体テスト（TDD）。
//
// dev-flow-canary-child.js は dev-flow-canary から workflow('dev-flow:dev-flow-canary-child', {token})
// で 1 段 nested 呼び出しされる echo probe workflow（read-only, agent 呼び出しゼロ）。
//
// _lib/workflow-load-smoke.test.mjs の makeWorkflowSandbox / runWorkflowInSandbox と同型の
// VM sandbox helper をこのファイル内に持つ（返り値 Promise を await して resolve 値を取得する版）。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { JS_GLOBALS } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const workflowPath = join(repoRoot, '.claude/workflows/dev-flow-canary-child.js');
const rawSrc = readFileSync(workflowPath, 'utf8');

// ---- VM sandbox helper（workflow-load-smoke.test.mjs と同型。返り値取得版） ----------------

function makeWorkflowSandbox(extraGlobals = {}) {
  const sandbox = {
    phase: () => {},
    log: () => {},
    agent: async () => null,
    parallel: async () => [],
    workflow: async () => null,
    args: null,
    ...JS_GLOBALS,
    ...extraGlobals,
  };
  return vm.createContext(sandbox);
}

/**
 * workflow ソースを vm sandbox でロード・実行し、返り値（resolve 値）を取得する。
 * ソース末尾の `return {...}` を IIFE の返り値として拾えるよう、strip 後のソースを
 * async 関数の body としてラップする（top-level return を許容するため）。
 */
async function runWorkflowAndGetResult(src, context, filename) {
  const stripped = src
    .replace(/^export\s+const\s+/gm, 'const ')
    .replace(/^export\s+function\s+/gm, 'function ');

  const wrapped = `(async () => {\n${stripped}\n})();`;

  let resolved = vm.runInContext(wrapped, context, { filename });
  // 本体は async IIFE のため vm.runInContext は即座に Promise を返す。resolve 値を得るため await する。
  if (resolved && typeof resolved.then === 'function') {
    resolved = await resolved;
  }
  // VM sandbox の返り値はホストと別レルムの Object のため、そのまま assert.deepEqual に
  // 渡すと（node:assert/strict の deepStrictEqual は prototype/realm も検査するため）
  // 値が等しくても reference-equal 判定で失敗する。JSON round-trip でホストレルムの
  // plain object に正規化してから比較する。
  return JSON.parse(JSON.stringify(resolved));
}

// ---- (1) args={token:'canary-x'} → {child_ok:true, echo:'canary-x'} ------------------------

test('args={token:"canary-x"} は {child_ok:true, echo:"canary-x"} を返す', async () => {
  const context = makeWorkflowSandbox({ args: { token: 'canary-x' } });
  const result = await runWorkflowAndGetResult(rawSrc, context, 'dev-flow-canary-child.js');
  assert.deepEqual(result, { child_ok: true, echo: 'canary-x' });
});

// ---- (2) args='1'（load-smoke 互換の bare string）→ {child_ok:true, echo:'1'} で throw しない ----

test('args="1"（bare string）は throw せず {child_ok:true, echo:"1"} を返す', async () => {
  const context = makeWorkflowSandbox({ args: '1' });
  const result = await runWorkflowAndGetResult(rawSrc, context, 'dev-flow-canary-child.js');
  assert.deepEqual(result, { child_ok: true, echo: '1' });
});

// ---- (3) args=undefined → echo:null ---------------------------------------------------------

test('args=undefined は {child_ok:true, echo:null} を返す', async () => {
  const context = makeWorkflowSandbox({ args: undefined });
  const result = await runWorkflowAndGetResult(rawSrc, context, 'dev-flow-canary-child.js');
  assert.deepEqual(result, { child_ok: true, echo: null });
});

// ---- (4) source string-lint ------------------------------------------------------------------

test('[string-lint] module top-level に require( が存在しない', () => {
  const lines = rawSrc.split('\n');
  const violations = lines.filter((l) => /^(?:const|let|var)\s+\S+\s*=\s*require\s*\(/.test(l) || /^require\s*\(/.test(l));
  assert.deepEqual(violations, []);
});

test('[string-lint] module top-level に Date.now() initializer が存在しない', () => {
  const lines = rawSrc.split('\n');
  const violations = lines.filter((l) => /^(?:const|let|var)\s+\S+\s*=.*\bDate\.now\s*\(/.test(l));
  assert.deepEqual(violations, []);
});

test('[string-lint] mutating git/gh コマンド文字列が source に存在しない（read-only 保証）', () => {
  assert.doesNotMatch(rawSrc, /git\s+(commit|push|add|worktree)/);
  assert.doesNotMatch(rawSrc, /['"`]gh\s/);
});

test('[string-lint] agent()/parallel() を呼ばない（agent 呼び出しゼロ）', () => {
  assert.doesNotMatch(rawSrc, /\bagent\s*\(/);
  assert.doesNotMatch(rawSrc, /\bparallel\s*\(/);
});
