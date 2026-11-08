// dev-flow.js の workflow meta.name rename ('dev-flow' -> 'dev-flow-run') を検証する。
//
// 背景: dev-flow.js の meta.name は skill 名（dev-flow/SKILL.md）と衝突しないよう
//       'dev-flow-run' へ改名する。一方、journal telemetry のキー `skill: 'dev-flow',` は
//       集計の連続性のため絶対に変更しない（不変条件）。
//
// このテストは:
//   (a) meta.name === 'dev-flow-run'（`export const meta` はハーネスが読む pure literal で VM 返り値に
//       現れないため、リテラル本体を vm で評価し declared name を観測する。issue #636）
//   (b) 旧 meta 名 `name: 'dev-flow',`（完全一致文字列）が存在しないこと（否定 pin）
//   (c) VM 挙動: success / abort の 2 run（empty-diff failure は devflow-failure-telemetry-routing.test.mjs (3)）で journal-log 系 prompt の
//       telemetry JSON が `"skill":"dev-flow"` を含む（集計連続性 invariant を挙動で pin。
//       abort run はさらに `"error_category":"abort"` も含む）
//   (d) .claude/workflows/ 配下の全 *.js に workflow('dev-flow') 形式の nested 呼び出しが
//       存在しないこと（rename 漏れ検出。識別子の完全一致 pin として残置）
// を assert する。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const workflowDir = join(repoRoot, '.claude/workflows');

const devFlowPath = join(workflowDir, 'dev-flow.js');
const devFlowSrc = readFileSync(devFlowPath, 'utf8');

// (a) 新 meta 名: `export const meta = {...}` の pure literal をハーネスと同様に評価して観測する
function loadWorkflowMeta(src) {
  const start = src.indexOf('export const meta = {');
  assert.ok(start >= 0, 'export const meta = { が見つからない');
  const end = src.indexOf('\n}\n', start);
  assert.ok(end > start, 'meta literal の終端が見つからない');
  return vm.runInNewContext('(' + src.slice(start + 'export const meta = '.length, end + 2) + ')');
}

test('[workflow-name] dev-flow.js: meta.name が dev-flow-run である', () => {
  const meta = loadWorkflowMeta(devFlowSrc);
  assert.equal(meta.name, 'dev-flow-run', 'meta.name の rename が未適用');
});

// (b) 旧 meta 名が存在しない
test('[workflow-name] dev-flow.js: 旧 meta 名 name: \'dev-flow\', が残存しない', () => {
  assert.ok(
    !devFlowSrc.includes("name: 'dev-flow',"),
    "dev-flow.js に旧 meta 名 name: 'dev-flow', が残存している（rename 漏れ）",
  );
});

// (c) telemetry の skill:'dev-flow' 集計連続性 invariant を、3 call site（Merge tier success handoff /
// writeFailureTelemetry / top-level abort handoff、issue #607）に対応する 3 run で挙動確認する。
// journal-log 系 prompt に埋め込まれる telemetry JSON（JSON.stringify 出力、空白なし）を対象にする。

test('[workflow-name] VM: 成功 run の journal-log prompt JSON が "skill":"dev-flow" を含む', async () => {
  const { ctx, calls } = makeDevFlowSandbox();
  const { error } = await runWorkflowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'workflow-name-success');
  if (error) assert.fail(`成功 run が想定外に throw した: ${error.message}`);

  const journalSave = calls.find((c) => c.label.startsWith('journal-log'));
  assert.ok(journalSave != null, '成功 run に journal-log の call が見つからない');
  assert.ok(
    journalSave.prompt.includes('"skill":"dev-flow"'),
    `成功 run の journal-log prompt に '"skill":"dev-flow"' が含まれない。\nprompt (先頭800文字): ${journalSave.prompt.slice(0, 800)}`,
  );
});

// empty-diff 失敗 run（writeFailureTelemetry）の "skill":"dev-flow" は
// devflow-failure-telemetry-routing.test.mjs (3) の共有 run が検査する。

test('[workflow-name] VM: abort run の journal-log 系 prompt JSON が "skill":"dev-flow" かつ "error_category":"abort" を含む', async () => {
  // need() で包まれた PR phase の proxy（'pr#1'）の throw は top-level catch で abort handoff 後に rethrow される。
  const { ctx, calls } = makeDevFlowSandbox({
    overrides: { 'pr#1': () => { throw new Error('injected') } },
  });
  const { error } = await runWorkflowCapture(devFlowSrc, ctx);
  assert.ok(error !== null, 'pr#1 の throw は top-level catch で abort handoff 後に rethrow されるはずだが error が null だった');

  const journalSave = calls.find((c) => c.label.startsWith('journal-log'));
  assert.ok(journalSave != null, 'abort run に journal-log の call が見つからない');
  assert.ok(
    journalSave.prompt.includes('"skill":"dev-flow"'),
    `abort run の journal-log prompt に '"skill":"dev-flow"' が含まれない。\nprompt (先頭800文字): ${journalSave.prompt.slice(0, 800)}`,
  );
  assert.ok(
    journalSave.prompt.includes('"error_category":"abort"'),
    `abort run の journal-log prompt に '"error_category":"abort"' が含まれない。\nprompt (先頭800文字): ${journalSave.prompt.slice(0, 800)}`,
  );
});

// (e) pr-iterate.js の meta.name は skill 名（pr-iterate/SKILL.md の wrapper）と衝突しない 'pr-iterate-run'
//     （dev-flow-run と対称。issue #828）。旧名の alias は作らないので、旧 namespaced 名での nested 起動も無い。
//     telemetry の skill:'pr-iterate' は集計連続性のため変えない（priterate-abort-telemetry.test.mjs が pin）
test('[workflow-name] pr-iterate.js: meta.name が pr-iterate-run で、旧名 workflow(\'dev-flow:pr-iterate\') の呼び出しが残らない', () => {
  const prIterateSrc = readFileSync(join(workflowDir, 'pr-iterate.js'), 'utf8');
  assert.equal(loadWorkflowMeta(prIterateSrc).name, 'pr-iterate-run', 'pr-iterate.js の meta.name の rename が未適用');
  assert.match(devFlowSrc, /workflow\('dev-flow:pr-iterate-run', prIterateArgs\(\)\)/, 'dev-flow.js の nested 起動が新名でない');
  for (const file of readdirSync(workflowDir).filter((f) => f.endsWith('.js'))) {
    const src = readFileSync(join(workflowDir, file), 'utf8');
    assert.doesNotMatch(src, /[Ww]orkflow\(\s*\{?\s*(name:\s*)?['"](dev-flow:)?pr-iterate['"]/, `${file} に旧名 pr-iterate での workflow 起動が残っている`);
  }
});

// (d) .claude/workflows/*.js に workflow('dev-flow') 形式の nested 呼び出しが無い
test('[workflow-name] .claude/workflows/*.js に workflow(\'dev-flow\') 形式の nested 呼び出しが存在しない', () => {
  const files = readdirSync(workflowDir).filter((f) => f.endsWith('.js'));
  assert.ok(files.length > 0, '.claude/workflows/ 配下に *.js が見つからない');

  const nestedCallPattern = /[Ww]orkflow\(\s*\{?\s*(name:\s*)?['"]dev-flow['"](?!-run)/;

  for (const file of files) {
    const filePath = join(workflowDir, file);
    const src = readFileSync(filePath, 'utf8');
    assert.doesNotMatch(
      src,
      nestedCallPattern,
      `${file} に workflow('dev-flow') 形式の nested 呼び出しが残存している（rename 漏れ）`,
    );
  }
});
