import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  LOCAL_VERIFY_WAIT_SEC, LOCAL_VERIFY_TAIL_MAX,
  localVerifyWaitPolls, localVerifyVerdict, localVerifyFeedback, localVerifyCiOutcome, localVerifyConfigArg,
  AC_VERIFY_TIMEOUT_SEC, acVerifyConfig, acVerifyFeedback,
} from './local-verify.mjs';

test('[local-verify] localVerifyVerdict: passed は exit_code 0 が揃ったときだけ。timeout は failed、応答なし・未知の status は error', () => {
  assert.equal(localVerifyVerdict({ status: 'passed', exit_code: 0 }), 'passed');
  assert.equal(localVerifyVerdict({ status: 'passed', exit_code: 1 }), 'error');
  assert.equal(localVerifyVerdict({ status: 'passed' }), 'error');
  assert.equal(localVerifyVerdict({ status: 'failed', exit_code: 1 }), 'failed');
  assert.equal(localVerifyVerdict({ status: 'timeout', exit_code: 143 }), 'failed');
  assert.equal(localVerifyVerdict({ status: 'unavailable', reason: 'x' }), 'unavailable');
  assert.equal(localVerifyVerdict({ status: 'running' }), 'running');
  for (const res of [null, undefined, 'passed', { status: 'stopped' }, { status: 'error' }]) assert.equal(localVerifyVerdict(res), 'error', JSON.stringify(res));
});

test('[local-verify] localVerifyWaitPolls: timeout_seconds を 1 回の待機秒数で割った回数 + 1', () => {
  assert.equal(localVerifyWaitPolls(1500), Math.ceil(1500 / LOCAL_VERIFY_WAIT_SEC) + 1);
  assert.equal(localVerifyWaitPolls(LOCAL_VERIFY_WAIT_SEC), 2);
  assert.equal(localVerifyWaitPolls(null), 1);
});

test('[local-verify] localVerifyFeedback: ci の AC ごとに log_path と log の末尾（上限で切る）を添える', () => {
  const tail = 'x'.repeat(LOCAL_VERIFY_TAIL_MAX) + 'END';
  const fb = localVerifyFeedback({
    result: { status: 'failed', exit_code: 1, log_path: '/wt/log', log_tail: tail },
    command: 'pnpm test:e2e:local', acIndexes: [1], acceptanceCriteria: ['a', 'e2e が通る'],
  });
  assert.equal(fb.length, 1);
  assert.equal(fb[0].topic, 'AC-2 未達');
  assert.equal(fb[0].ac_index, 1);
  assert.match(fb[0].description, /AC-2「e2e が通る」のローカル実行（`pnpm test:e2e:local`.*）が exit 1 で失敗した/);
  assert.equal(fb[0].log_path, '/wt/log');
  assert.equal(fb[0].log_tail.length, LOCAL_VERIFY_TAIL_MAX);
  assert.ok(fb[0].log_tail.endsWith('END'));
  const timeout = localVerifyFeedback({ result: { status: 'timeout', exit_code: 143 }, command: 'c', acIndexes: [0], acceptanceCriteria: ['a'] });
  assert.match(timeout[0].description, /timeout_seconds を超えて止められた/);
});

test('[local-verify] localVerifyCiOutcome: passed / failed で決着した run だけ source:local の判定を作る', () => {
  const lv = { status: 'passed', command: 'pnpm test:e2e:local', exit_code: 0, log_path: '/wt/log', reimpl_count: 0 };
  assert.deepEqual(localVerifyCiOutcome(lv), { source: 'local', status: 'passed', command: 'pnpm test:e2e:local', exit_code: 0, log_path: '/wt/log' });
  assert.equal(localVerifyCiOutcome({ ...lv, status: 'failed', exit_code: 2 }).status, 'failed');
  for (const status of ['unavailable', 'error', 'skipped']) assert.equal(localVerifyCiOutcome({ status, reason: 'x' }), null, status);
  assert.equal(localVerifyCiOutcome(null), null);
});

test('[local-verify] localVerifyConfigArg: shell のクォートが要らない 1 トークンになり、戻すと宣言そのものになる', () => {
  const cfg = { command: `pnpm test:e2e:local -- --grep 'tenant (a)' && echo "!~*" ; true`, db: { engine: 'postgres', version: '17' }, env: 'E2E_URL', timeout_seconds: 1500 };
  const arg = localVerifyConfigArg(cfg);
  assert.match(arg, /^[A-Za-z0-9._%-]+$/);
  assert.deepEqual(JSON.parse(decodeURIComponent(arg)), cfg);
});

test('[local-verify] acVerifyConfig: 凍結した AC コマンドを db の無い宣言（command / expect_paths / timeout_seconds だけ）にする', () => {
  const cfg = acVerifyConfig({ verify_command: 'timeout 300 pnpm --filter @acme/landing build', expect_paths: ['packages/landing/out/index.html'] });
  assert.deepEqual(cfg, { command: 'timeout 300 pnpm --filter @acme/landing build', expect_paths: ['packages/landing/out/index.html'], timeout_seconds: AC_VERIFY_TIMEOUT_SEC });
  assert.equal('db' in cfg || 'env' in cfg, false, 'pg-broker を呼ばない');
  assert.ok(localVerifyWaitPolls(AC_VERIFY_TIMEOUT_SEC) >= 2);
  assert.deepEqual(acVerifyConfig({ verify_command: 'make', expect_paths: null }).expect_paths, []);
});

test('[local-verify] acVerifyFeedback: AC 番号・本文・コマンド・失敗の理由と log の末尾（上限で切る）を添える', () => {
  const fb = acVerifyFeedback({
    result: { status: 'failed', exit_code: 0, reason: 'expect_paths が worktree に無い: out/404.html', log_path: '/wt/log', log_tail: 'x'.repeat(LOCAL_VERIFY_TAIL_MAX) + 'END' },
    command: 'make site', acIndex: 1, acceptanceCriteria: ['a', '`make site` で out/404.html が生成される'],
  });
  assert.equal(fb.topic, 'AC-2 未達');
  assert.equal(fb.ac_index, 1);
  assert.match(fb.description, /AC-2「`make site` で out\/404\.html が生成される」が指定したコマンド（`make site`）を worktree で実行したら exit 0 で失敗した（expect_paths が worktree に無い: out\/404\.html）/);
  assert.match(fb.suggestion, /AC のコマンドや期待するファイルを変えて通さない/);
  assert.equal(fb.log_path, '/wt/log');
  assert.equal(fb.log_tail.length, LOCAL_VERIFY_TAIL_MAX);
  assert.ok(fb.log_tail.endsWith('END'));
  assert.match(acVerifyFeedback({ result: { status: 'timeout' }, command: 'c', acIndex: 0, acceptanceCriteria: ['a'] }).description, /timeout_seconds を超えて止められた/);
});
