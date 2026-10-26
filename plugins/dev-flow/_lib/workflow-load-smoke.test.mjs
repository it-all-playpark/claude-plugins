// Load-smoke tests: .claude/workflows/*.js が workflow runtime でロード時に即死しないことを保証する。
//
// 背景: dynamic workflow ローダーは独自の VM コンテキストで各 workflow ファイルを評価する。
// ローダーは require/process/Buffer/Date.now() 等の Node API を提供しない。
// module top-level でこれらを呼ぶとロード直後に ReferenceError で即死する。
// byte 一致テスト（sync.test.mjs）はこの退行を検出できないため、本テストを追加する。
//
// アプローチ:
//   1. 文字列 lint: ソースに module top-level の `require(` / `Date.now(` が出現しないことを検査。
//      （最低限の安全網。関数本体内は許可するが、top-level スコープでは禁止）
//   2. VM sandbox: 禁止グローバルを持たない最小コンテキスト（agent/parallel/phase/log/workflow/args
//      を stub）で runInNewContext を実行し、ReferenceError を投げないことを assert する。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { makeDevFlowSandbox, runDevFlowInSandbox, devFlowArgs } from './test-helpers/vm-sandbox.mjs';
import { DEV_FLOW_SCENARIOS } from './test-helpers/dev-flow-scenarios.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const workflowDir = join(repoRoot, '.claude/workflows');

// Discover all *.js workflow files
const workflowFiles = readdirSync(workflowDir)
  .filter((f) => f.endsWith('.js'))
  .map((f) => join(workflowDir, f));

// ---- 1. String lint: 禁止パターンが module top-level に存在しないことを検査 ------------------
//
// 戦略: インデントゼロ（top-level）の行に禁止パターンが出現するケースを検出する。
// `const xxx = require(` / `require(` の直接呼び出しを対象とする。

const FORBIDDEN_TOP_LEVEL = [
  // [pattern, label]
  [/^(?:const|let|var)\s+\S+\s*=\s*require\s*\(/, 'module top-level の require() 呼び出し'],
  [/^require\s*\(/, 'module top-level の require() 直接呼び出し'],
];

// Date.now() は関数本体内では許可するが、top-level の variable initializer では禁止
// 例: `const ts = Date.now()` を禁止
const FORBIDDEN_TOP_LEVEL_DATE = /^(?:const|let|var)\s+\S+\s*=.*\bDate\.now\s*\(/;

for (const filePath of workflowFiles) {
  const relPath = filePath.replace(repoRoot + '/', '');
  const src = readFileSync(filePath, 'utf8');
  const lines = src.split('\n');

  test(`[string-lint] ${relPath}: module top-level に require() が存在しない`, () => {
    const violations = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const [pattern, label] of FORBIDDEN_TOP_LEVEL) {
        if (pattern.test(line)) {
          violations.push(`line ${i + 1}: ${label} — ${line.trim()}`);
        }
      }
    }
    assert.deepEqual(
      violations,
      [],
      `${relPath} に禁止パターン（require）が含まれている:\n${violations.join('\n')}`,
    );
  });

  test(`[string-lint] ${relPath}: module top-level に Date.now() initializer が存在しない`, () => {
    const violations = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (FORBIDDEN_TOP_LEVEL_DATE.test(line)) {
        violations.push(`line ${i + 1}: top-level Date.now() — ${line.trim()}`);
      }
    }
    assert.deepEqual(
      violations,
      [],
      `${relPath} に禁止パターン（Date.now top-level initializer）が含まれている:\n${violations.join('\n')}`,
    );
  });
}

// ---- 2. VM sandbox load test: ReferenceError を投げないことを assert -------------------------
//
// workflow ローダーが提供する最小グローバルをスタブとして注入し、
// runInContext でファイルを評価する。
//
// 修正点（旧実装の2つの欠陥を解消）:
//   (a) クロスレルム instanceof 問題: vm.runInContext が投げる Error は VM コンテキスト側の
//       レルムに属するため、外側の `instanceof ReferenceError` は常に false になる。
//       `.name` 文字列比較（クロスレルム安全）を使う。
//   (b) top-level await の parse SyntaxError マスキング: workflow ファイルは top-level に
//       `await agent(...)` を持つため、裸の runInContext は parse 時点で SyntaxError を投げ、
//       require 行に到達できない。ソースを async IIFE `(async () => { ... })()` で包んで評価し、
//       Promise rejection も await して捕捉する。
//
// 注意: `export const meta = ...` は ESM 構文のため CJS sandbox では SyntaxError になる。
// ローダーと同様の最小変換として export キーワードを strip して評価する。

function makeWorkflowSandbox(extraGlobals = {}) {
  // workflow runtime が提供するグローバルをスタブ
  const sandbox = {
    // workflow 制御関数
    phase: () => {},
    log: () => {},
    agent: async () => null,
    parallel: async () => [],
    workflow: async () => null,
    // 引数（実 loader は args を注入する）
    args: devFlowArgs('1'),
    // JS 組み込み（vm.createContext はデフォルトで提供しないため明示注入）
    console,
    JSON,
    Math,
    String,
    Number,
    Boolean,
    Array,
    Object,
    Error,
    RegExp,
    Promise,
    Symbol,
    Map,
    Set,
    Date,
    // require / process / Buffer は意図的に注入しない（禁止グローバル）
    ...extraGlobals,
  };
  return vm.createContext(sandbox);
}

/**
 * workflow ソースを vm sandbox でロードし、発生したエラーを返す。
 * エラーがなければ null を返す。
 *
 * 2つの問題を同時に解消:
 *   (a) top-level await → async IIFE で包んで SyntaxError を回避
 *   (b) Promise rejection も await して捕捉（require は同期例外だが念のため）
 */
async function runWorkflowInSandbox(src, context, filename) {
  // ESM export 構文を strip
  const stripped = src
    .replace(/^export\s+const\s+/gm, 'const ')
    .replace(/^export\s+function\s+/gm, 'function ');

  // top-level await を許容するため async IIFE で包む
  const wrapped = `(async () => {\n${stripped}\n})();`;

  let caughtError = null;
  try {
    const result = vm.runInContext(wrapped, context, { filename });
    // async IIFE が返す Promise の rejection も捕捉
    if (result && typeof result.then === 'function') {
      await result.catch((e) => { caughtError = e; });
    }
  } catch (e) {
    caughtError = e;
  }
  return caughtError;
}

for (const filePath of workflowFiles) {
  const relPath = filePath.replace(repoRoot + '/', '');

  test(`[vm-load] ${relPath}: 禁止グローバルなし sandbox でロードして ReferenceError が出ない`, async () => {
    const rawSrc = readFileSync(filePath, 'utf8');
    const context = makeWorkflowSandbox();
    const caughtError = await runWorkflowInSandbox(rawSrc, context, relPath);

    // クロスレルム安全な .name 比較（instanceof は VM レルム越えで常に false になる）
    // ReferenceError は禁止グローバルの使用 → ロード時即死 → 修正必須
    if (caughtError && caughtError.name === 'ReferenceError') {
      assert.fail(
        `${relPath} がロード時に ReferenceError で即死: ${caughtError.message}\n`
        + `（禁止グローバル require/process/Buffer 等を module top-level で使用している可能性）`,
      );
    }

    // SyntaxError は構文不正 → やはり修正必須
    if (caughtError && caughtError.name === 'SyntaxError') {
      assert.fail(`${relPath} がロード時に SyntaxError: ${caughtError.message}`);
    }

    // その他のエラー（TypeError 等）は top-level コードの実行による場合がある。
    // スタブが null を返すため発生しうるが、これはロード時の即死ではなく実行時の問題のため
    // 警告に留めテストは pass させる（ReferenceError / SyntaxError のみをブロッキングとする）。
  });
}

// ---- 3. Negative test: vm-load が実際に機能していることを保証 ---------------------------------
//
// テスト自身が inert 化していないことを検証するための fixture テスト。
// 禁止グローバルを含む合成ソースに対して vm-load が fail を検出できることを確認する。
// これにより「本物の退行を挿入してもテストが pass してしまう」再発を防ぐ。

test('[vm-load][negative] top-level require を含む合成ソースは ReferenceError として検出される', async () => {
  // 本物の退行を模したソース（top-level の require + await を含む）
  const badSrc = `
const _fs = require('fs');
const PR = '1';
const x = await Promise.resolve('test');
`;
  const context = makeWorkflowSandbox();
  const caughtError = await runWorkflowInSandbox(badSrc, context, '[fixture]');

  // このテストは必ず ReferenceError を検出できなければならない
  assert.ok(
    caughtError && caughtError.name === 'ReferenceError',
    `negative fixture: require を含むソースで ReferenceError が検出されるべきだが`
    + ` caughtError=${JSON.stringify(caughtError?.name)} (${caughtError?.message})`,
  );
});

test('[vm-load][negative] top-level process 使用を含む合成ソースは ReferenceError として検出される', async () => {
  const badSrc = `
const pid = process.pid;
const x = await Promise.resolve('test');
`;
  const context = makeWorkflowSandbox();
  const caughtError = await runWorkflowInSandbox(badSrc, context, '[fixture]');

  assert.ok(
    caughtError && caughtError.name === 'ReferenceError',
    `negative fixture: process を含むソースで ReferenceError が検出されるべきだが`
    + ` caughtError=${JSON.stringify(caughtError?.name)} (${caughtError?.message})`,
  );
});

test('[vm-load][negative] top-level Buffer 使用を含む合成ソースは ReferenceError として検出される', async () => {
  const badSrc = `
const b = Buffer.from('hello');
const x = await Promise.resolve('test');
`;
  const context = makeWorkflowSandbox();
  const caughtError = await runWorkflowInSandbox(badSrc, context, '[fixture]');

  assert.ok(
    caughtError && caughtError.name === 'ReferenceError',
    `negative fixture: Buffer を含むソースで ReferenceError が検出されるべきだが`
    + ` caughtError=${JSON.stringify(caughtError?.name)} (${caughtError?.message})`,
  );
});

// ---- 4/5/6 (旧): REQ schema shape / triage consume(classifyShape) / W5 danger-grep 配線 は
// source-regex 走査だった（issue #636 で削除）。同じ挙動は shape-loop-routing.test.mjs /
// realized-shape-routing.test.mjs（realized diff からの EFFECTIVE_SHAPE 判定）と
// diff-triage-routing.test.mjs / merge-tier 系ルーティングテスト（danger-grep 配線・
// merge tier 算出）が VM 挙動として担う。

// ---- 7. issue #443 / #550 F1+F3: clock epoch 給電 prompt の VM 挙動検証 --------------------
//
// 専用 clock probe（dev-runner-haiku-ro の clockProbe() 呼び出し）は issue #550 F1/F3 で全廃され、
// 各 mark は隣接する既存 exec-proxy / agent 応答の optional epoch フィールドから feedClockMark()
// 経由で給電される。給電元 prompt は末尾に EPOCH_INSTRUCTION（`date +%s` を 1 回実行し epoch と
// して返せという指示）を追記している。この指示が silent に prompt から失われる退行を、実際に
// 組み立てられた prompt を VM 実行で観測して検出する（source anchor 走査は行わない）。

test('[epoch-instruction] 既定 run: 給電対象 call の prompt が date +%s 取得指示を含み、label が clock で始まる call は 0 件', async () => {
  const src = readFileSync(join(workflowDir, 'dev-flow.js'), 'utf8');
  const { ctx, calls } = makeDevFlowSandbox();
  const error = await runDevFlowInSandbox(src, ctx);
  assert.equal(error, null, `既定 run はエラーなく完走するべき: ${error?.message}`);

  // test#1 は対象外: 転写 agent は date を実行せず、epoch は exec-proxy run-tests が JSON に含めて返す
  // （run-tests.bats が epoch の存在を pin）。
  const epochFedLabels = ['impl:serial:issue-1', 'post-summary'];
  for (const label of epochFedLabels) {
    const call = calls.find((c) => c.label === label);
    assert.ok(call, `label '${label}' の call が見つからない`);
    assert.ok(
      call.prompt.includes('date +%s'),
      `label '${label}' の prompt に 'date +%s' 取得指示が含まれるべきだが含まれていなかった: ${call.prompt}`,
    );
  }

  const clockLabelCalls = calls.filter((c) => c.label?.startsWith('clock'));
  assert.equal(
    clockLabelCalls.length,
    0,
    `label が 'clock' で始まる call は 0 件であるべきだが ${clockLabelCalls.length} 件だった（専用 clock probe は撤去済み）`,
  );
});

// lite route（pr-review-lite）の reviewPromptLite も EPOCH_INSTRUCTION 給電対象（iterate_end mark の
// 給電元）。complex 経路の既定 run では到達しないため DEV_FLOW_SCENARIOS.lite で別 run を回す。
test('[epoch-instruction] lite route: pr-review-lite の prompt が date +%s 取得指示を含む', async () => {
  const src = readFileSync(join(workflowDir, 'dev-flow.js'), 'utf8');
  const { ctx, calls } = makeDevFlowSandbox({ overrides: DEV_FLOW_SCENARIOS.lite.overrides });
  const error = await runDevFlowInSandbox(src, ctx);
  assert.equal(error, null, `lite run はエラーなく完走するべき: ${error?.message}`);
  const lite = calls.find((c) => c.label === 'pr-review-lite');
  assert.ok(lite, `label 'pr-review-lite' の call が見つからない（lite route 不成立）: ${calls.map((c) => c.label).join(', ')}`);
  assert.ok(lite.prompt.includes('date +%s'), `pr-review-lite の prompt に 'date +%s' 取得指示が含まれるべきだが含まれていなかった`);
});
