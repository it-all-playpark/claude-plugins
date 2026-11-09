// check-ci.sh を PATH 先頭の gh スタブ経由で走らせる test helper。check-ci は内部で
// `gh pr view <N> --json headRefOid,statusCheckRollup` を 1 回実行するので、スタブはその応答として
// {"headRefOid": <40 桁 sha>, "statusCheckRollup": <rollup>} を返す。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHECK_CI = join(pluginRoot, 'pr-iterate', 'scripts', 'check-ci.sh');
const CORE_BIN = join(pluginRoot, '..', 'playpark-core', 'bin');
export const CHECK_CI_STUB_HEAD_SHA = '0123456789abcdef0123456789abcdef01234567';

/**
 * gh スタブが rollup を返す状態で check-ci.sh を 1 回実行し、spawnSync の結果を返す。
 * rollup は JSON 文字列のまま応答に埋めるので、rollup として読めない値（'not json' 等）もそのまま渡せる。
 *
 * @param {string} rollupText - 応答の statusCheckRollup に埋める文字列
 * @param {string[]} [args] - check-ci に足す引数（--only / --exclude 等）
 * @returns {import('node:child_process').SpawnSyncReturns<string>}
 */
export function runCheckCiWithRollup(rollupText, args = []) {
  const dir = mkdtempSync(join(tmpdir(), 'check-ci-gh-stub-'));
  try {
    const response = join(dir, 'response.json');
    writeFileSync(response, `{"headRefOid":"${CHECK_CI_STUB_HEAD_SHA}","statusCheckRollup":${rollupText}}`);
    writeFileSync(join(dir, 'gh'), '#!/usr/bin/env bash\ncat "$CHECK_CI_GH_STUB_RESPONSE"\n', { mode: 0o755 });
    return spawnSync('bash', [CHECK_CI, '--pr', '1', ...args], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${CORE_BIN}:${process.env.PATH}`, CHECK_CI_GH_STUB_RESPONSE: response },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
