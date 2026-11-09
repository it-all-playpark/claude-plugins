// _lib/ci-check.mjs（ci-check / ci-wait-check / ci-verify の定数 / schema / prompt の canonical）の単体テスト。
//
// 守っている不変条件:
//   - どの prompt も Bash は最終行の check-ci 1 単文（待機は check-ci --wait）なので、1 spawn の必要 turn
//     （check-ci 1 + StructuredOutput 1 + margin = 5）が stdout-relay の maxTurns を超えない（agent md を実読して pin）
//   - 既定の上限 CI_WAIT_CEILING_SECONDS=300, CI_POLL_SECONDS=45。poll 回数の上限は待機上限から導く（ciMaxPolls）。
//     args.ci_wait_ceiling_seconds は正の整数だけ受け、未指定は既定値（ciWaitCeiling）
//   - prompt にループ指示が無い（1 spawn = 1 判定。ci-check は待機もしない）
//   - CI_STATUS の status enum は closed（'error' が欠けると gh fetch 失敗を green と誤認しうる）
//   - prompt の最終行は check-ci を先頭トークンにした bare 単文（hook がこの行と完全一致する Bash だけを通す）で、
//     head_sha・slept を agent に足させる手順を持たず、示す失敗時の JSON は export した定数と同じ
//     （hook はその定数との一致で返り値を通す）
//   - ciEffectiveStatus は null を error にし、それ以外（件数と status が食い違う応答を含む）はそのまま返す
//     （返り値は hook が check-ci の実 stdout に縛る）
//   - CI_WAIT_CHECK は slept を required に持つ（実待機不成立の判別に使う）
//   - 並列 ci-check の採否（ciHeadRejectReason）は 40 桁 sha の一致だけを採用にする
//
// prompt 本文が dev-flow.js / pr-iterate.js の inline 区間と全文一致することは
// _lib/workflow-inlines.sync.test.mjs（sync-inlines --check 相当）が保証するため、ここでは扱わない。
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CI_POLL_SECONDS, CI_WAIT_CEILING_SECONDS, ciWaitCeiling, ciMaxPolls, CI_TURN_MARGIN, CI_STATUS, CI_WAIT_CHECK, ciCheckPrompt, ciWaitCheckPrompt, checkCiCommand, ciHeadRejectReason, isFullCommitSha, ciEffectiveStatus, CI_VERIFY_POLL_SECONDS, CI_VERIFY_CHECK, ciVerifyPrompt, ciVerifyVerdict, CI_RELAY_FAILED, CI_WAIT_RELAY_FAILED } from './ci-check.mjs';

// ============================================================
// 定数
// ============================================================

// turn 会計の純関数（式は _lib/ci-check.mjs のコメントと一致させる）
// check-ci 1（待機する prompt も check-ci --wait の 1 単文）+ StructuredOutput 1 + margin
function ciRelayTurns(margin) {
  return 1 + 1 + margin;
}
function readMaxTurns() {
  const p = join(dirname(fileURLToPath(import.meta.url)), '..', 'agents', 'stdout-relay.md');
  const src = readFileSync(p, 'utf8');
  const m = src.match(/^maxTurns:\s*(\d+)\s*$/m);
  assert.ok(m, `${p} の frontmatter に maxTurns が無い`);
  return Number(m[1]);
}
// check-ci が --wait に受ける秒数の上限（check-ci.sh を実読して pin）
function readCheckCiWaitMax() {
  const p = join(dirname(fileURLToPath(import.meta.url)), '..', 'pr-iterate', 'scripts', 'check-ci.sh');
  const m = readFileSync(p, 'utf8').match(/^WAIT_SECONDS_MAX=(\d+)\s*$/m);
  assert.ok(m, `${p} に WAIT_SECONDS_MAX が無い`);
  return Number(m[1]);
}

// prompt の最終行（hook が Bash と照合する行）
const lastLine = (p) => p.split('\n').at(-1);
// prompt が示す失敗時の JSON（`{"` で始まる 1 行の JSON object を全部拾う）
const failedJsonsOf = (p) => (p.match(/\{"[^{}\n]*\}/g) ?? []).map((s) => JSON.parse(s));

const RELAY_PROMPTS = [
  ['ciCheckPrompt', ciCheckPrompt({ pr: 7, repo: 'o/n' }), CI_RELAY_FAILED],
  ['ciCheckPrompt（exclude）', ciCheckPrompt({ pr: 7, repo: 'o/n', exclude: ['e2e', "it's"] }), CI_RELAY_FAILED],
  ['ciCheckPrompt（repo なし）', ciCheckPrompt({ pr: 7, repo: null }), CI_RELAY_FAILED],
  ['ciWaitCheckPrompt', ciWaitCheckPrompt({ pr: 7, repo: 'o/n', seconds: CI_POLL_SECONDS }), CI_WAIT_RELAY_FAILED],
  ['ciWaitCheckPrompt（exclude）', ciWaitCheckPrompt({ pr: 7, repo: 'o/n', seconds: CI_POLL_SECONDS, exclude: ['e2e'] }), CI_WAIT_RELAY_FAILED],
  ['ciVerifyPrompt（待機なし）', ciVerifyPrompt({ pr: 7, repo: 'o/n', checks: ['e2e'], seconds: 0 }), CI_RELAY_FAILED],
  ['ciVerifyPrompt（待機あり）', ciVerifyPrompt({ pr: 7, repo: 'o/n', checks: ['e2e'], seconds: CI_VERIFY_POLL_SECONDS }), CI_WAIT_RELAY_FAILED],
];

test('[ci-check] 1 spawn の必要 turn（check-ci + StructuredOutput + margin = 5）が stdout-relay の maxTurns を超えない', () => {
  const maxTurns = readMaxTurns();
  assert.equal(ciRelayTurns(CI_TURN_MARGIN), 5);
  assert.ok(ciRelayTurns(CI_TURN_MARGIN) <= maxTurns, `必要 turn ${ciRelayTurns(CI_TURN_MARGIN)} が maxTurns ${maxTurns} を超えている`);
});

for (const [name, p, failed] of RELAY_PROMPTS) {
  test(`[ci-check] ${name}: 最終行は先頭トークンが check-ci の bare 単文 1 本（| && ; リダイレクトを含まない）で、Bash はその 1 本だけ`, () => {
    const line = lastLine(p);
    assert.equal(line.split(' ')[0], 'check-ci', `最終行の先頭トークンが check-ci でない: ${line}`);
    assert.doesNotMatch(line, /[|;&<>`]|\$\(/, `最終行に shell の記号がある: ${line}`);
    assert.ok(!/^\s|\s$/.test(line), `最終行の前後に空白がある: ${JSON.stringify(line)}`);
    // 最終行の他に、実行させるコマンド（backtick の bare 単文）を持たない（turn 会計の前提）
    const body = p.slice(0, p.length - line.length);
    assert.deepEqual((body.match(/`(check-ci|ci-wait|gh|sleep)\b[^`]*`/g) ?? []), [], `最終行の他に実行させるコマンドがある: ${body}`);
  });

  test(`[ci-check] ${name}: 示す失敗時の JSON は export した定数と同じで、head_sha・slept を足させる手順が無い`, () => {
    assert.deepEqual(failedJsonsOf(p), [failed], `prompt が示す失敗時の JSON が定数と食い違う: ${p}`);
    const withoutFailed = p.split(JSON.stringify(failed)).join('');
    for (const key of ['head_sha', 'slept']) {
      assert.ok(!withoutFailed.includes(key), `prompt が ${key} を agent に扱わせている: ${withoutFailed}`);
    }
  });
}

test('[ci-check] 待機する prompt は最終行の check-ci に --wait を付け、待機しない prompt は付けない', () => {
  assert.equal(lastLine(ciWaitCheckPrompt({ pr: 7, repo: 'o/n', seconds: 45 })), 'check-ci --pr 7 --repo o/n --wait 45');
  assert.equal(lastLine(ciVerifyPrompt({ pr: 7, repo: 'o/n', checks: ['e2e'], seconds: 90 })), "check-ci --pr 7 --repo o/n --only 'e2e' --wait 90");
  assert.equal(lastLine(ciVerifyPrompt({ pr: 7, repo: 'o/n', checks: ['e2e'], seconds: 0 })), "check-ci --pr 7 --repo o/n --only 'e2e'");
  assert.equal(lastLine(ciCheckPrompt({ pr: 7, repo: 'o/n' })), 'check-ci --pr 7 --repo o/n');
});

test('[ci-check] 失敗時の JSON は status:error（待機する prompt は slept:false も）で、CI_STATUS / CI_WAIT_CHECK の required を満たす', () => {
  assert.equal(CI_RELAY_FAILED.status, 'error');
  assert.equal(CI_WAIT_RELAY_FAILED.status, 'error');
  assert.equal(CI_WAIT_RELAY_FAILED.slept, false);
  for (const k of CI_STATUS.required) assert.ok(k in CI_RELAY_FAILED, `CI_RELAY_FAILED に ${k} が無い`);
  for (const k of CI_WAIT_CHECK.required) assert.ok(k in CI_WAIT_RELAY_FAILED, `CI_WAIT_RELAY_FAILED に ${k} が無い`);
});

test('[ci-check] CI_TURN_MARGIN は 3（実測: 文書化 worst case 8 に対し 10 tool call で StructuredOutput 未達）', () => {
  assert.equal(CI_TURN_MARGIN, 3);
});

test('[ci-check] script 側ループの定数: 既定の上限 CI_WAIT_CEILING_SECONDS=300 / CI_POLL_SECONDS=45 / ciMaxPolls(300)=7', () => {
  assert.equal(CI_WAIT_CEILING_SECONDS, 300);
  assert.equal(CI_POLL_SECONDS, 45);
  assert.equal(ciMaxPolls(CI_WAIT_CEILING_SECONDS), 7);
});

test('[ci-check] ciMaxPolls: poll 回数の上限は待機上限から導き、待機の合計は上限を超えない', () => {
  for (const [ceiling, polls] of [[300, 7], [515, 12], [600, 14], [900, 21]]) {
    assert.equal(ciMaxPolls(ceiling), polls, `ciMaxPolls(${ceiling})`);
    assert.ok(CI_POLL_SECONDS * (ciMaxPolls(ceiling) - 1) <= ceiling, `ceiling ${ceiling} の待機合計が上限を超える`);
  }
});

test('[ci-check] ciWaitCeiling: 未指定は既定 300、正の整数はそのまま、それ以外は明示 throw', () => {
  assert.equal(ciWaitCeiling(undefined), CI_WAIT_CEILING_SECONDS);
  assert.equal(ciWaitCeiling(null), CI_WAIT_CEILING_SECONDS);
  assert.equal(ciWaitCeiling(600), 600);
  for (const bad of [0, -300, 450.5, '600', true, {}]) {
    assert.throws(() => ciWaitCeiling(bad), /args\.ci_wait_ceiling_seconds は正の整数/, `${JSON.stringify(bad)} を受理した`);
  }
});

// ============================================================
// schema
// ============================================================

test('[ci-check] CI_STATUS の status enum は 5 値の closed enum', () => {
  assert.deepEqual(
    CI_STATUS.properties.status.enum,
    ['passed', 'failed', 'pending', 'no_checks', 'error'],
  );
});

test('[ci-check] CI_STATUS は status と check-ci の件数（passed / failed / pending / skipped）を required に持つ', () => {
  assert.deepEqual(CI_STATUS.required, ['status', 'passed', 'failed', 'pending', 'skipped']);
  for (const k of ['passed', 'failed', 'pending', 'skipped']) {
    assert.equal(CI_STATUS.properties[k].type, 'integer', `${k} は整数`);
    assert.equal(CI_STATUS.properties[k].minimum, 0, `${k} は非負`);
  }
  for (const k of ['slept', 'status', 'passed', 'failed', 'pending', 'skipped']) {
    assert.ok(CI_WAIT_CHECK.required.includes(k), `CI_WAIT_CHECK は ${k} を required に持つべき`);
  }
});

// ============================================================
// ciEffectiveStatus（null だけを error にする。返り値は hook が check-ci の実 stdout に縛る）
// ============================================================

const counts = (passed, failed, pending, skipped) => ({ passed, failed, pending, skipped });

test('[ci-check] ciEffectiveStatus: null は status:error を合成する', () => {
  assert.deepEqual(ciEffectiveStatus(null), { status: 'error', failed_checks: [] });
  assert.deepEqual(ciEffectiveStatus(undefined), { status: 'error', failed_checks: [] });
});

test('[ci-check] ciEffectiveStatus: null 以外は件数と status が食い違っても count_mismatch を付けずにそのまま返す', () => {
  for (const ci of [
    { status: 'passed', ...counts(2, 0, 0, 1), failed_checks: [], head_sha: 'a'.repeat(40), epoch: 1 },
    { status: 'passed', ...counts(5, 0, 2, 0), failed_checks: [] },
    { status: 'no_checks', ...counts(1, 0, 0, 0) },
    { status: 'pending', ...counts(1, 0, 0, 0) },
    { status: 'error', ...counts(0, 0, 0, 0), message: 'x' },
    CI_RELAY_FAILED,
    CI_WAIT_RELAY_FAILED,
  ]) {
    const r = ciEffectiveStatus(ci);
    assert.equal(r, ci, `応答をそのまま返すべき: ${JSON.stringify(ci)}`);
    assert.ok(!('count_mismatch' in r), `count_mismatch を付けてはならない: ${JSON.stringify(r)}`);
  }
});

test('[ci-check] CI_STATUS の failed_checks 要素は {name, bucket, state}', () => {
  const props = CI_STATUS.properties.failed_checks.items.properties;
  assert.deepEqual(Object.keys(props).sort(), ['bucket', 'name', 'state']);
});

test('[ci-check] CI_STATUS は並列 ci-check の照合用に optional head_sha（string）を持つ', () => {
  assert.equal(CI_STATUS.properties.head_sha.type, 'string');
  assert.ok(!CI_STATUS.required.includes('head_sha'), 'head_sha は optional でなければならない（取得失敗は省略 → 不採用で直列に倒す）');
});

test('[ci-check] CI_STATUS は clock telemetry 給電用の optional epoch を持つ', () => {
  assert.equal(CI_STATUS.properties.epoch.type, 'number');
  assert.ok(!CI_STATUS.required.includes('epoch'), 'epoch は optional でなければならない');
});

test('[ci-check] CI_WAIT_CHECK schema は slept（boolean）を required に持ち、status 以下は CI_STATUS と同じ', () => {
  assert.ok(CI_WAIT_CHECK.required.includes('slept'), 'slept は required でなければならない');
  assert.ok(CI_WAIT_CHECK.required.includes('status'), 'status は required でなければならない');
  assert.equal(CI_WAIT_CHECK.properties.slept.type, 'boolean');
  for (const [k, v] of Object.entries(CI_STATUS.properties)) {
    assert.deepEqual(CI_WAIT_CHECK.properties[k], v, `CI_WAIT_CHECK.properties.${k} は CI_STATUS と一致するべき`);
  }
});

// ============================================================
// prompt
// ============================================================

test('[ci-check] ciCheckPrompt は決定論的（同入力 -> 同出力）', () => {
  const a = ciCheckPrompt({ pr: 123, repo: 'owner/name' });
  const b = ciCheckPrompt({ pr: 123, repo: 'owner/name' });
  assert.equal(a, b);
});

test('[ci-check] repo 指定ありなら check-ci に --repo フラグを付け、null なら付けない', () => {
  assert.equal(lastLine(ciCheckPrompt({ pr: 123, repo: 'owner/name' })), 'check-ci --pr 123 --repo owner/name');
  const p = ciCheckPrompt({ pr: 123, repo: null });
  assert.equal(lastLine(p), 'check-ci --pr 123');
  assert.ok(!p.includes('--repo'), '--repo は出力されてはならない');
});

// 3 proxy の prompt は rollup の取得・転写を agent に持たせない: check-ci が gh pr view を 1 回実行して head sha と rollup を
// 同じ応答から取る。agent が gh の stdout を argv に転写すると、引用符の崩れで CI が全 pass でも ci_error になる。
test('[ci-check] ci-check / ci-wait-check / ci-verify の prompt は rollup の gh コマンド・--checks-data・--fetch-error-data・headRefOid の個別取得・ci-wait を持たない', () => {
  for (const [name, p] of RELAY_PROMPTS) {
    for (const banned of ['statusCheckRollup', '--checks-data', '--fetch-error-data', 'headRefOid', '--jq', 'ci-wait ']) {
      assert.ok(!p.includes(banned), `${name} に ${banned} が残っている: ${p}`);
    }
    assert.ok(lastLine(p).startsWith('check-ci --pr 7'), `${name} の最終行が check-ci --pr でない: ${lastLine(p)}`);
  }
  assert.equal(lastLine(RELAY_PROMPTS[1][1]), checkCiCommand({ pr: 7, repo: 'o/n', exclude: ['e2e', "it's"] }));
  assert.equal(lastLine(RELAY_PROMPTS[4][1]), "check-ci --pr 7 --repo o/n --exclude 'e2e' --wait 45");
});

test('[ci-check] pr が文字列でも同じ prompt になる（dev-flow は number, pr-iterate は string 由来）', () => {
  assert.equal(ciCheckPrompt({ pr: 123, repo: null }), ciCheckPrompt({ pr: '123', repo: null }));
  assert.equal(ciWaitCheckPrompt({ pr: 123, repo: 'o/n', seconds: 45 }), ciWaitCheckPrompt({ pr: '123', repo: 'o/n', seconds: 45 }));
});

test('[ci-check] ciCheckPrompt にループ・sleep 指示が無い（1 spawn = 1 判定）', () => {
  const p = ciCheckPrompt({ pr: 1, repo: 'o/n' });
  assert.ok(!/\battempt\b/i.test(p), 'attempt という語を含んではならない');
  assert.ok(!p.includes('--max-attempts'), '--max-attempts を含んではならない');
  assert.ok(!p.includes('--poll-seconds'), '--poll-seconds を含んではならない');
  assert.ok(!p.includes('--attempt '), '--attempt を含んではならない');
  assert.ok(!p.includes('--wait'), '待機しない prompt は --wait を含んではならない');
  assert.ok(!/\bsleep\b/i.test(p), 'sleep という語を含んではならない');
  assert.ok(!p.includes('繰り返'), '繰り返し指示を含んではならない');
  assert.ok(!p.includes('next_action'), 'next_action への言及を含んではならない');
});

test('ciCheckPrompt: check-ci を plugin bin/ の bare 名（先頭トークン）で呼び、skills 絶対パスと bash 前置を含まない', () => {
  for (const [name, p] of RELAY_PROMPTS) {
    assert.ok(!p.includes('check-ci.sh'), `${name}: 拡張子付き名を含まない`);
    assert.ok(!p.includes(['~/.claude', 'skills/'].join('/')), `${name}: skills 絶対パスを含まない`);
    assert.ok(!p.includes('bash check-ci'), `${name}: bash 前置を付けない`);
    assert.ok(!/`sleep \d+`/.test(p), `${name}: bare sleep 単文を含まない`);
  }
});

test('[ci-check] ciWaitCheckPrompt はループ・再取得を指示しない', () => {
  const w = ciWaitCheckPrompt({ pr: 1, repo: null, seconds: 45 });
  assert.ok(!w.includes('--repo'), 'repo null なら --repo を出さない');
  assert.ok(!/\battempt\b/i.test(w), 'attempt という語を含んではならない');
  assert.ok(!w.includes('繰り返'), '繰り返し指示を含んではならない');
  assert.ok(!w.includes('--max-attempts'), '--max-attempts を含んではならない');
});

// ============================================================
// docs
// ============================================================

test('[ci-check] capability-bound.md は「1 spawn = 1 判定・ループは script 側」で、sleep を別 exec-proxy と書かない（issue #805）', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const refs = join(here, '..', 'dev-flow', 'references');
  const cap = readFileSync(join(refs, 'capability-bound.md'), 'utf8');
  assert.ok(cap.includes('1 spawn = 1 判定・ループは'), 'capability-bound.md に「1 spawn = 1 判定・ループは script 側」の記述が無い');
  assert.ok(cap.includes('ci-wait-check'), 'capability-bound.md に ci-wait-check の記述が無い');
  for (const name of ['exec-proxy.md', 'capability-bound.md']) {
    const flat = readFileSync(join(refs, name), 'utf8').replace(/\n>\s?/g, '');
    assert.ok(!/sleep は[^。]*別 exec-proxy/.test(flat), `${name} に「sleep は別 exec-proxy」の旧記述が残っている`);
  }
});

test('[ci-check] exec-proxy.md の ci-wait-check 行は slept が true でない応答を fail-closed で ci_pending 終端にする', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const md = readFileSync(join(here, '..', 'dev-flow', 'references', 'exec-proxy.md'), 'utf8');
  const row = md.split('\n').find((l) => l.startsWith('| ci-wait-check<br>'));
  assert.ok(row, 'exec-proxy.md に ci-wait-check の行が無い');
  const [, , detect, policy] = row.split('|').map((c) => c.trim());
  assert.ok(detect.includes('`slept`'), `ci-wait-check 行の失敗検出が slept を見ていない: ${detect}`);
  assert.ok(policy.startsWith('fail-closed') && policy.includes('`ci_pending`'), `ci-wait-check 行のポリシーが fail-closed の ci_pending 終端でない: ${policy}`);
});

test('[ci-check] CI 取得を書く docs とスクリプトの先頭コメントは statusCheckRollup を入力に挙げる', () => {
  const plugin = join(dirname(fileURLToPath(import.meta.url)), '..');
  const read = (rel) => readFileSync(join(plugin, rel), 'utf8');
  const headComment = (rel) => read(rel).split(/^set -euo pipefail$/m)[0];
  const rowOf = (rel, prefix) => read(rel).split('\n').find((l) => l.startsWith(prefix)) ?? '';
  const targets = {
    'exec-proxy.md の ci-checks 行': rowOf('dev-flow/references/exec-proxy.md', '| ci-checks（ENV'),
    'dev-runner-haiku-ro.md の ci-checks 行': rowOf('agents/dev-runner-haiku-ro.md', '| `ci-checks`'),
    'stdout-relay.md の本文': read('agents/stdout-relay.md').replace(/^---\n[\s\S]*?\n---\n/, ''),
    'check-ci.sh の先頭コメント': headComment('pr-iterate/scripts/check-ci.sh'),
    'merge-tier-facts.sh の先頭コメント': headComment('_shared/scripts/merge-tier-facts.sh'),
  };
  for (const [name, text] of Object.entries(targets)) {
    assert.ok(/--json [\w,]*statusCheckRollup/.test(text), `${name} が CI の入力に statusCheckRollup を挙げていない: ${text.slice(0, 300)}`);
  }
});

// ============================================================
// head sha（並列 ci-check の照合。issue #806）
// ============================================================

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

test('[ci-check] ciHeadRejectReason: 40 桁 sha が一致するときだけ採用（null）。大文字小文字・前後空白は同一視する', () => {
  assert.equal(ciHeadRejectReason({ ci: { status: 'passed', head_sha: SHA_A }, expectedSha: SHA_A }), null);
  assert.equal(ciHeadRejectReason({ ci: { status: 'failed', head_sha: ` ${SHA_A.toUpperCase()}\n` }, expectedSha: SHA_A }), null);
});

test('[ci-check] ciHeadRejectReason: 不一致・null・head_sha 欠落・短縮 sha・review 側 head 不明はすべて不採用', () => {
  assert.equal(ciHeadRejectReason({ ci: { status: 'passed', head_sha: SHA_B }, expectedSha: SHA_A }), 'head_mismatch');
  assert.equal(ciHeadRejectReason({ ci: null, expectedSha: SHA_A }), 'ci_null');
  assert.equal(ciHeadRejectReason({ ci: { status: 'passed' }, expectedSha: SHA_A }), 'ci_head_missing');
  assert.equal(ciHeadRejectReason({ ci: { status: 'passed', head_sha: '' }, expectedSha: SHA_A }), 'ci_head_missing');
  assert.equal(ciHeadRejectReason({ ci: { status: 'passed', head_sha: SHA_A.slice(0, 7) }, expectedSha: SHA_A }), 'ci_head_missing');
  assert.equal(ciHeadRejectReason({ ci: { status: 'passed', head_sha: SHA_A }, expectedSha: null }), 'review_head_unknown');
  assert.equal(ciHeadRejectReason({ ci: { status: 'passed', head_sha: SHA_A }, expectedSha: SHA_A.slice(0, 12) }), 'review_head_unknown');
});

test('[ci-check] isFullCommitSha は 40 桁 hex だけを真にする', () => {
  assert.equal(isFullCommitSha(SHA_A), true);
  assert.equal(isFullCommitSha(` ${SHA_A}\n`), true);
  assert.equal(isFullCommitSha(SHA_A.slice(0, 7)), false);
  assert.equal(isFullCommitSha('g'.repeat(40)), false);
  assert.equal(isFullCommitSha(null), false);
  assert.equal(isFullCommitSha(undefined), false);
});

// ============================================================
// ci-verify（ci_verify.checks の LGTM 後の待ち。issue #861）
// ============================================================

test('[ci-check] exclude は check-ci に --exclude で渡し、空なら prompt を変えない', () => {
  assert.equal(ciCheckPrompt({ pr: 7, repo: 'o/n', exclude: [] }), ciCheckPrompt({ pr: 7, repo: 'o/n' }));
  assert.equal(ciWaitCheckPrompt({ pr: 7, repo: 'o/n', seconds: 45, exclude: [] }), ciWaitCheckPrompt({ pr: 7, repo: 'o/n', seconds: 45 }));
  assert.ok(lastLine(ciCheckPrompt({ pr: 7, repo: 'o/n', exclude: ['e2e', "it's"] })).endsWith(`--exclude 'e2e' --exclude 'it'\\''s'`));
});

test('[ci-check] ci-verify prompt の最終行は check-ci --only（待つときだけ --wait）で、待機は Bash tool の既定 timeout に収まる', () => {
  const waited = ciVerifyPrompt({ pr: 7, repo: 'o/n', checks: ['e2e'], seconds: CI_VERIFY_POLL_SECONDS });
  assert.equal(lastLine(waited), checkCiCommand({ pr: 7, repo: 'o/n', only: ['e2e'], wait: CI_VERIFY_POLL_SECONDS }));
  assert.equal(lastLine(ciVerifyPrompt({ pr: 7, repo: 'o/n', checks: ['e2e'], seconds: 0 })), checkCiCommand({ pr: 7, repo: 'o/n', only: ['e2e'] }));
  // check-ci --wait は待機 + 取得が Bash tool の既定 timeout（120 秒）に収まる秒数（WAIT_SECONDS_MAX 以下）しか受けない
  const waitMax = readCheckCiWaitMax();
  assert.ok(CI_VERIFY_POLL_SECONDS <= waitMax, `CI_VERIFY_POLL_SECONDS=${CI_VERIFY_POLL_SECONDS} が check-ci の WAIT_SECONDS_MAX=${waitMax} を超える`);
  assert.ok(CI_POLL_SECONDS <= waitMax, `CI_POLL_SECONDS=${CI_POLL_SECONDS} が check-ci の WAIT_SECONDS_MAX=${waitMax} を超える`);
  assert.ok(CI_VERIFY_CHECK.required.every((k) => CI_STATUS.required.includes(k)));
});

test('[ci-check] ciVerifyVerdict: no_checks（label 直後で job 未登録）は pending、passed / failed / error はそのまま', () => {
  assert.equal(ciVerifyVerdict({ status: 'no_checks' }), 'pending');
  assert.equal(ciVerifyVerdict({ status: 'pending' }), 'pending');
  assert.equal(ciVerifyVerdict({ status: 'passed' }), 'passed');
  assert.equal(ciVerifyVerdict({ status: 'failed' }), 'failed');
  assert.equal(ciVerifyVerdict({ status: 'error' }), 'error');
});
