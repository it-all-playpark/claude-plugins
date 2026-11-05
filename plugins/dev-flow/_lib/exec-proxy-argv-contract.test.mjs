// Guard test: exec-proxy argv 転写契約 (issue #606, task F1).
//
// Background:
//   dev-runner 系 agent（dev-runner / dev-runner-haiku / dev-runner-haiku-ro）は決定論スクリプトへの
//   exec-proxy であり、呼び出し側 workflow が渡す argv（bare 名の決定論スクリプト + 引数）を
//   一字一句そのまま実行する verbatim 転写契約を負う（cwd 依存の回避は呼び出し側が argv に
//   worktree 絶対パスを引数として含めることで成立しており、agent 側で cwd を作らない）。
//
//   dev-implementer.md の「Bash は毎回この cwd から始める」指示は exec-proxy ではなく
//   implementer（判断系 leaf、Read/Edit/Write で直接コードを書く）に対するものであり、本 issue の
//   スコープ外。誤ってスコープを dev-implementer.md まで拡大していないことを負の対照で pin する。
//
// Run: npx vitest run _lib/exec-proxy-argv-contract.test.mjs
// Full CI: bash tests/run-node-tests.sh --strict

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const agentsDir = join(here, '..', 'agents');

const TARGETS = ['dev-runner.md', 'dev-runner-haiku.md', 'dev-runner-haiku-ro.md'];

function loadAgent(fileName) {
  const path = join(agentsDir, fileName);
  const source = readFileSync(path, 'utf8');
  return { path, source };
}

for (const fileName of TARGETS) {
  test(`[exec-proxy-argv-contract] ${fileName} declares the argv verbatim transcription core phrase`, () => {
    const { source, path } = loadAgent(fileName);
    assert.ok(
      source.includes('一字一句そのまま実行'),
      `${path} must declare the argv verbatim transcription core phrase '一字一句そのまま実行'`,
    );
  });

  test(`[exec-proxy-argv-contract] ${fileName} enumerates the forbidden argv rewrites`, () => {
    const { source, path } = loadAgent(fileName);
    for (const needle of [
      'which による絶対パス解決',
      '絶対パスへの書き換え',
      '変数代入の前置',
      'cd X &&',
    ]) {
      assert.ok(
        source.includes(needle),
        `${path} must enumerate forbidden argv rewrite '${needle}'`,
      );
    }
  });

  test(`[exec-proxy-argv-contract] ${fileName} states the reason as verbatim transcription contract / breakage`, () => {
    const { source, path } = loadAgent(fileName);
    assert.ok(
      source.includes('verbatim 転写契約'),
      `${path} must state the reason using 'verbatim 転写契約'`,
    );
    assert.ok(
      source.includes('転写の破壊'),
      `${path} must state the reason using '転写の破壊'`,
    );
  });

  test(`[exec-proxy-argv-contract] ${fileName} defers to caller-instructed cd`, () => {
    const { source, path } = loadAgent(fileName);
    assert.ok(
      source.includes('呼び出し側 prompt が cd を指示している場合はその指示に従う'),
      `${path} must state that caller-instructed cd is followed (only agent-initiated prefixing is forbidden)`,
    );
  });

  test(`[exec-proxy-argv-contract] ${fileName} declares justification class: contract`, () => {
    const { source, path } = loadAgent(fileName);
    assert.ok(
      source.includes('正当化クラス: contract'),
      `${path} must declare '正当化クラス: contract'`,
    );
  });

  test(`[exec-proxy-argv-contract] ${fileName} does not justify the contract by naming execution-control mechanisms`, () => {
    const { source, path } = loadAgent(fileName);
    assert.doesNotMatch(source, /sandbox/i, `${path} must not mention 'sandbox' as a reason`);
    assert.doesNotMatch(
      source,
      /excludedCommands/i,
      `${path} must not mention 'excludedCommands' as a reason`,
    );
    assert.doesNotMatch(
      source,
      /permission/i,
      `${path} must not mention 'permission' as a reason`,
    );
    assert.doesNotMatch(source, /迂回/, `${path} must not mention '迂回' as a reason`);
  });
}

test('[exec-proxy-argv-contract] dev-runner-haiku-ro.md replaces the shared-rule summary with argv 転写', () => {
  const { source, path } = loadAgent('dev-runner-haiku-ro.md');
  assert.ok(
    source.includes('argv 転写、verbatim 返却、schema 厳守'),
    `${path} must summarize the shared rule as 'argv 転写、verbatim 返却、schema 厳守'`,
  );
});

// Negative control (scope pin): dev-implementer.md is NOT an exec-proxy and is out of scope for this
// issue. Its per-call cwd reset instruction must remain untouched — if this assertion goes red, scope
// was accidentally expanded to dev-implementer.md.
test('[exec-proxy-argv-contract] dev-implementer.md (non exec-proxy, out of scope) still contains the cwd reset instruction', () => {
  const path = join(agentsDir, 'dev-implementer.md');
  const source = readFileSync(path, 'utf8');
  assert.ok(
    source.includes('Bash は毎回この cwd から始める'),
    `${path} is out of scope for issue #606 (not an exec-proxy) and must still contain the cwd reset instruction`,
  );
});
