// check-ci.sh / merge-tier-facts.sh を PATH 先頭の gh スタブ経由で走らせる test helper。どちらも内部で
// `gh pr view <N> --json ...` を 1 回実行するので、スタブはその応答として
// {"headRefOid": <40 桁 sha>, "statusCheckRollup": <rollup>} を返す（同じ rollup を両方に渡せる）。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHECK_CI = join(pluginRoot, 'pr-iterate', 'scripts', 'check-ci.sh');
const MERGE_TIER_FACTS = join(pluginRoot, '_shared', 'scripts', 'merge-tier-facts.sh');
const CORE_BIN = join(pluginRoot, '..', 'playpark-core', 'bin');
export const CHECK_CI_STUB_HEAD_SHA = '0123456789abcdef0123456789abcdef01234567';

// gh スタブが rollup を返す状態で script を 1 回実行する。rollup は JSON 文字列のまま応答に埋めるので、
// rollup として読めない値（'not json' 等）もそのまま渡せる。
function runWithRollupStub(script, args, rollupText) {
  const dir = mkdtempSync(join(tmpdir(), 'check-ci-gh-stub-'));
  try {
    const response = join(dir, 'response.json');
    writeFileSync(response, `{"headRefOid":"${CHECK_CI_STUB_HEAD_SHA}","statusCheckRollup":${rollupText}}`);
    writeFileSync(join(dir, 'gh'), '#!/usr/bin/env bash\ncat "$CHECK_CI_GH_STUB_RESPONSE"\n', { mode: 0o755 });
    return spawnSync('bash', [script, ...args], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${CORE_BIN}:${process.env.PATH}`, CHECK_CI_GH_STUB_RESPONSE: response },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * gh スタブが rollup を返す状態で check-ci.sh を 1 回実行し、spawnSync の結果を返す。
 *
 * @param {string} rollupText - 応答の statusCheckRollup に埋める文字列
 * @param {string[]} [args] - check-ci に足す引数（--only / --exclude 等）
 * @returns {import('node:child_process').SpawnSyncReturns<string>}
 */
export function runCheckCiWithRollup(rollupText, args = []) {
  return runWithRollupStub(CHECK_CI, ['--pr', '1', ...args], rollupText);
}

/**
 * gh スタブが rollup を返す状態で merge-tier-facts.sh を 1 回実行し、spawnSync の結果を返す。
 *
 * @param {string} rollupText - 応答の statusCheckRollup に埋める文字列
 * @param {string} worktree - --worktree に渡す絶対パス（checks サブ結果だけを見るなら git repo でなくてよい）
 * @returns {import('node:child_process').SpawnSyncReturns<string>}
 */
export function runMergeTierFactsWithRollup(rollupText, worktree) {
  return runWithRollupStub(MERGE_TIER_FACTS, ['--worktree', worktree, '--base', 'origin/main', '--pr', '1', '--issue', '1'], rollupText);
}
