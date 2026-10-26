// _lib/ci-check.mjs（ci-check / ci-wait-check の定数 / schema / prompt の canonical）の単体テスト。
//
// 守っている不変条件:
//   - ci-check 1 spawn（head sha 1 + gh 1 + 変換 1 + StructuredOutput 1 + margin = 7）と ci-wait-check 1 spawn
//     （待機 1 + gh 1 + 変換 1 + StructuredOutput 1 + margin = 7）が dev-runner-haiku-ro の maxTurns を超えない
//     （agent md を実読して pin。issue #663 / #805 / #806）
//   - 既定の上限 CI_WAIT_CEILING_SECONDS=300, CI_POLL_SECONDS=45。poll 回数の上限は待機上限から導く（ciMaxPolls）。
//     args.ci_wait_ceiling_seconds は正の整数だけ受け、未指定は既定値（ciWaitCeiling。issue #1046）
//   - prompt にループ指示が無い（1 spawn = 1 判定。ci-check は待機もしない。issue #663）
//   - CI_STATUS の status enum は closed（'error' が欠けると gh fetch 失敗を green と誤認しうる）
//   - CI_STATUS は check-ci の件数を required に持ち、ciEffectiveStatus は件数から導いた status と食い違う
//     proxy の status を error に倒す（pending:2 を passed と転記した実例。issue #834）
//   - CI_WAIT_CHECK は slept を required に持つ（実待機不成立の判別に使う。issue #805）
//   - prompt が決定論的で、repo 指定の有無で --repo フラグが正しく出し分けられる
//   - ci-check は head sha を checks より先に取り、応答に head_sha を含める。並列 ci-check の採否
//     （ciHeadRejectReason）は 40 桁 sha の一致だけを採用にする（issue #806）
//
// prompt 本文が dev-flow.js / pr-iterate.js の inline 区間と全文一致することは
// _lib/workflow-inlines.sync.test.mjs（sync-inlines --check 相当）が保証するため、ここでは扱わない。
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CI_POLL_SECONDS, CI_WAIT_CEILING_SECONDS, ciWaitCeiling, ciMaxPolls, CI_TURN_MARGIN, CI_STATUS, CI_WAIT_CHECK, ciCheckPrompt, ciWaitCheckPrompt, ciFetchSteps, ciHeadRejectReason, isFullCommitSha, ciStatusFromCounts, ciEffectiveStatus, CI_VERIFY_POLL_SECONDS, CI_VERIFY_CHECK, ciVerifyPrompt, ciVerifyVerdict } from './ci-check.mjs';

// ============================================================
// 定数
// ============================================================

// turn 会計の純関数（式は _lib/ci-check.mjs のコメントと一致させる）
// head sha fetch 1 + gh fetch 1 + 変換（check-ci）1 + StructuredOutput 1 + margin
function ciCheckTurns(margin) {
  return 1 + 1 + 1 + 1 + margin;
}
// 待機（ci-wait）1 + gh fetch 1 + 変換（check-ci）1 + StructuredOutput 1 + margin
function ciWaitCheckTurns(margin) {
  return 1 + 1 + 1 + 1 + margin;
}
function readMaxTurns() {
  const p = join(dirname(fileURLToPath(import.meta.url)), '..', 'agents', 'dev-runner-haiku-ro.md');
  const src = readFileSync(p, 'utf8');
  const m = src.match(/^maxTurns:\s*(\d+)\s*$/m);
  assert.ok(m, `${p} の frontmatter に maxTurns が無い`);
  return Number(m[1]);
}

test('[ci-check] ci-check 1 spawn の必要 turn（head sha + gh fetch + check-ci + StructuredOutput + margin = 7）が dev-runner-haiku-ro の maxTurns を超えない', () => {
  const maxTurns = readMaxTurns();
  assert.equal(ciCheckTurns(CI_TURN_MARGIN), 7);
  assert.ok(ciCheckTurns(CI_TURN_MARGIN) <= maxTurns, `必要 turn ${ciCheckTurns(CI_TURN_MARGIN)} が maxTurns ${maxTurns} を超えている`);
});

test('[ci-check] ci-wait-check 1 spawn の必要 turn（待機 + gh fetch + check-ci + StructuredOutput + margin = 7）が dev-runner-haiku-ro の maxTurns を超えない', () => {
  const maxTurns = readMaxTurns();
  assert.equal(ciWaitCheckTurns(CI_TURN_MARGIN), 7);
  assert.ok(ciWaitCheckTurns(CI_TURN_MARGIN) <= maxTurns, `必要 turn ${ciWaitCheckTurns(CI_TURN_MARGIN)} が maxTurns ${maxTurns} を超えている`);
});

test('[ci-check] ci-wait-check prompt の Bash 手順は ci-wait / gh / check-ci の 3 単文だけ（turn 会計の前提）', () => {
  const p = ciWaitCheckPrompt({ pr: 123, repo: 'owner/name', seconds: 45 });
  const steps = p.slice(p.indexOf('## Steps'), p.indexOf('## Output format'));
  const bashSteps = steps.match(/^\d+\. `[^`]+`/gm) ?? [];
  assert.deepEqual(
    bashSteps.map((s) => s.replace(/^\d+\. `/, '').split(' ')[0]),
    ['ci-wait', 'gh', 'check-ci'],
    `Bash 単文の手順が想定と異なる: ${JSON.stringify(bashSteps)}`,
  );
});

test('[ci-check] ci-check prompt の Bash 手順は gh（head sha）/ gh（checks）/ check-ci の 3 単文だけ（turn 会計の前提）', () => {
  const p = ciCheckPrompt({ pr: 123, repo: 'owner/name' });
  const steps = p.slice(p.indexOf('## Steps'), p.indexOf('## Output format'));
  const bashSteps = steps.match(/^\d+\. `[^`]+`/gm) ?? [];
  assert.deepEqual(
    bashSteps.map((s) => s.replace(/^\d+\. `/, '').match(/^(gh pr \w+|\S+)/)[1]),
    ['gh pr view', 'gh pr checks', 'check-ci'],
    `Bash 単文の手順が想定と異なる: ${JSON.stringify(bashSteps)}`,
  );
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

test('[ci-check] CI_STATUS は status と check-ci の件数（passed / failed / pending / skipped）を required に持つ（issue #834）', () => {
  assert.deepEqual(CI_STATUS.required, ['status', 'passed', 'failed', 'pending', 'skipped']);
  for (const k of ['passed', 'failed', 'pending', 'skipped']) {
    assert.equal(CI_STATUS.properties[k].type, 'integer', `${k} は整数`);
    assert.equal(CI_STATUS.properties[k].minimum, 0, `${k} は非負`);
  }
  for (const k of ['slept', 'status', 'passed', 'failed', 'pending', 'skipped']) {
    assert.ok(CI_WAIT_CHECK.required.includes(k), `CI_WAIT_CHECK は ${k} を required に持つべき`);
  }
});

test('[ci-check] ci-check / ci-wait-check の prompt は件数を一字一句転記させ、Output format に件数キーを含む', () => {
  for (const p of [ciCheckPrompt({ pr: 1, repo: 'o/n' }), ciWaitCheckPrompt({ pr: 1, repo: 'o/n', seconds: 45 })]) {
    assert.ok(p.includes('"passed": number, "failed": number, "pending": number, "skipped": number'), p);
    assert.ok(p.includes('`passed` / `failed` / `pending` / `skipped` の件数は stdout の値を一字一句そのまま写せ'), p);
  }
});

// ============================================================
// 件数からの status 導出（issue #834）
// ============================================================

const counts = (passed, failed, pending, skipped) => ({ passed, failed, pending, skipped });

test('[ci-check] ciStatusFromCounts: failed>0 → failed、pending>0 → pending、件数 0 → no_checks、それ以外 → passed', () => {
  assert.equal(ciStatusFromCounts(counts(3, 1, 2, 0)), 'failed');
  assert.equal(ciStatusFromCounts(counts(3, 0, 2, 0)), 'pending');
  assert.equal(ciStatusFromCounts(counts(0, 0, 0, 0)), 'no_checks');
  assert.equal(ciStatusFromCounts(counts(3, 0, 0, 1)), 'passed');
});

test('[ci-check] ciStatusFromCounts: 件数の欠落・非整数・負数は導出不能（null）', () => {
  assert.equal(ciStatusFromCounts({ passed: 1, failed: 0, pending: 0 }), null);
  assert.equal(ciStatusFromCounts(counts(1, 0, '0', 0)), null);
  assert.equal(ciStatusFromCounts(counts(1.5, 0, 0, 0)), null);
  assert.equal(ciStatusFromCounts(counts(1, -1, 0, 0)), null);
  assert.equal(ciStatusFromCounts(null), null);
});

test('[ci-check] ciEffectiveStatus: 件数 pending:2 と status:"passed" の食い違いは passed を採らず error（fail-closed）', () => {
  const r = ciEffectiveStatus({ status: 'passed', ...counts(5, 0, 2, 0), failed_checks: [] });
  assert.equal(r.status, 'error');
  assert.deepEqual(r.count_mismatch, { reported: 'passed', derived: 'pending' });
});

test('[ci-check] ciEffectiveStatus: 件数と一致する status はそのまま採る（応答の他キーも保持）', () => {
  for (const [status, c] of [['passed', counts(2, 0, 0, 1)], ['failed', counts(1, 1, 0, 0)], ['pending', counts(1, 0, 1, 0)], ['no_checks', counts(0, 0, 0, 0)]]) {
    const ci = { status, ...c, failed_checks: [], head_sha: 'a'.repeat(40), epoch: 1 };
    assert.equal(ciEffectiveStatus(ci), ci, `status=${status} は採るべき`);
  }
});

test('[ci-check] ciEffectiveStatus: 件数欠落・件数と食い違う status（failed 件数ありの passed 等）はすべて error', () => {
  assert.equal(ciEffectiveStatus({ status: 'passed', failed_checks: [] }).status, 'error');
  assert.equal(ciEffectiveStatus({ status: 'passed', ...counts(1, 1, 0, 0) }).status, 'error');
  assert.equal(ciEffectiveStatus({ status: 'no_checks', ...counts(1, 0, 0, 0) }).status, 'error');
  assert.equal(ciEffectiveStatus({ status: 'pending', ...counts(1, 0, 0, 0) }).status, 'error');
});

test('[ci-check] ciEffectiveStatus: proxy の error は件数と照合せず error のまま、null は error を合成', () => {
  const e = { status: 'error', ...counts(0, 0, 0, 0), message: 'x' };
  assert.equal(ciEffectiveStatus(e), e);
  assert.deepEqual(ciEffectiveStatus(null), { status: 'error', failed_checks: [] });
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

test('[ci-check] repo 指定ありなら --repo フラグを含む', () => {
  const p = ciCheckPrompt({ pr: 123, repo: 'owner/name' });
  assert.ok(p.includes('gh pr checks 123 --repo owner/name --json name,state,bucket'), p.slice(0, 400));
});

test('[ci-check] repo が null なら --repo フラグを含まない', () => {
  const p = ciCheckPrompt({ pr: 123, repo: null });
  assert.ok(p.includes('gh pr checks 123 --json name,state,bucket'), p.slice(0, 400));
  assert.ok(!p.includes('--repo'), '--repo は出力されてはならない');
});

test('[ci-check] pr が文字列でも同じ prompt になる（dev-flow は number, pr-iterate は string 由来）', () => {
  assert.equal(ciCheckPrompt({ pr: 123, repo: null }), ciCheckPrompt({ pr: '123', repo: null }));
});

test('[ci-check] ciCheckPrompt にループ・sleep 指示が無い（1 spawn = 1 判定）', () => {
  const p = ciCheckPrompt({ pr: 1, repo: 'o/n' });
  assert.ok(!/\battempt\b/i.test(p), 'attempt という語を含んではならない');
  assert.ok(!p.includes('--max-attempts'), '--max-attempts を含んではならない');
  assert.ok(!p.includes('--poll-seconds'), '--poll-seconds を含んではならない');
  assert.ok(!p.includes('--attempt '), '--attempt を含んではならない');
  // script 内ポーリング（--wait-seconds）は撤去済み。復活は exec-proxy 内 network I/O の再導入を意味する
  assert.ok(!p.includes('--wait-seconds'), '--wait-seconds を含んではならない');
  assert.ok(!/\bsleep\b/i.test(p), 'sleep という語を含んではならない');
  assert.ok(!p.includes('繰り返'), '繰り返し指示を含んではならない');
  assert.ok(!p.includes('next_action'), 'next_action への言及を含んではならない');
  assert.ok(p.includes('"poll_attempts": number'), 'Output format の poll_attempts キーは残す');
});

test('ciCheckPrompt: check-ci を plugin bin/ の bare 名（先頭トークン）で呼び、skills 絶対パスと bash 前置を含まない（issue #569）', () => {
  const p = ciCheckPrompt({ pr: 123, repo: 'owner/name' });
  assert.ok(p.includes('`check-ci --checks-data'), 'bare 名 check-ci --checks-data を含む');
  assert.ok(!p.includes('check-ci.sh'), '拡張子付き名を含まない');
  assert.ok(!p.includes(['~/.claude', 'skills/'].join('/')), 'skills 絶対パスを含まない');
  assert.ok(!p.includes('bash check-ci'), 'bash 前置を付けない');
});

test('[ci-check] ciWaitCheckPrompt は ci-wait → gh pr checks → check-ci の順に 1 spawn で実行させ、bare sleep を含まない', () => {
  const w = ciWaitCheckPrompt({ pr: 123, repo: 'owner/name', seconds: 45 });
  const iWait = w.indexOf('`ci-wait 45`');
  const iGh = w.indexOf('`gh pr checks 123 --repo owner/name --json name,state,bucket`');
  const iCheck = w.indexOf('`check-ci --checks-data');
  assert.ok(iWait >= 0, 'ci-wait 45 を bare 単文として含む');
  assert.ok(iGh > iWait, 'gh pr checks は ci-wait の後');
  assert.ok(iCheck > iGh, 'check-ci は gh pr checks の後');
  assert.ok(!/`sleep \d+`/.test(w), 'bare sleep 単文を含まない');
  assert.ok(!w.includes('check-ci.sh'), '拡張子付き名を含まない');
  assert.ok(w.includes('"slept": boolean'), 'Output format に slept を含む');
  assert.equal(w, ciWaitCheckPrompt({ pr: '123', repo: 'owner/name', seconds: 45 }), '決定論的で pr の型に依存しない');
});

test('[ci-check] ciWaitCheckPrompt は slept:true でなければ取得へ進ませず、ループ・再取得を指示しない', () => {
  const w = ciWaitCheckPrompt({ pr: 1, repo: null, seconds: 45 });
  assert.ok(w.includes('`{ "slept": false, "status": "pending", "passed": 0, "failed": 0, "pending": 0, "skipped": 0 }`'), '実待機不成立時の応答形を含む（件数は required なので 0 を入れる）');
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

test('[ci-check] ci-check と ci-wait-check は gh fetch → check-ci の手順本文を ciFetchSteps で共有する', () => {
  const c = ciCheckPrompt({ pr: 7, repo: 'o/n' });
  const w = ciWaitCheckPrompt({ pr: 7, repo: 'o/n', seconds: 45 });
  assert.ok(c.includes(ciFetchSteps({ pr: 7, repo: 'o/n', n: 2 })), 'ci-check は手順 2〜3 に共通本文を持つ（手順 1 は head sha）');
  assert.ok(w.includes(ciFetchSteps({ pr: 7, repo: 'o/n', n: 2 })), 'ci-wait-check は手順 2〜3 に共通本文を持つ');
});

// ============================================================
// head sha（並列 ci-check の照合。issue #806）
// ============================================================

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

test('[ci-check] ciCheckPrompt は head sha（gh pr view --json headRefOid）を checks より先に取り、応答に head_sha を加えさせる', () => {
  const p = ciCheckPrompt({ pr: 123, repo: 'owner/name' });
  const iSha = p.indexOf('`gh pr view 123 --repo owner/name --json headRefOid -q .headRefOid`');
  const iChecks = p.indexOf('`gh pr checks 123 --repo owner/name --json name,state,bucket`');
  assert.ok(iSha >= 0, `head sha 取得の bare 単文が無い: ${p.slice(0, 600)}`);
  assert.ok(iChecks > iSha, 'head sha は checks より先に取る（sha が一致すれば checks も同じ head のもの）');
  assert.ok(p.includes('"head_sha": string'), 'Output format に head_sha を含む');
  assert.ok(p.includes('`"head_sha"` を加えて返せ'), 'check-ci の JSON に head_sha を加える指示を含む');
  const local = ciCheckPrompt({ pr: 123, repo: null });
  assert.ok(local.includes('`gh pr view 123 --json headRefOid -q .headRefOid`'), 'repo null なら --repo を付けない');
});

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
  assert.ok(ciCheckPrompt({ pr: 7, repo: 'o/n', exclude: ['e2e', "it's"] }).includes(`--exclude 'e2e' --exclude 'it'\\''s'\``));
});

test('[ci-check] ci-verify prompt の Bash 手順は（待つときだけ ci-wait）/ gh / check-ci --only で、turn 会計は ci-wait-check と同じ', () => {
  const bashOf = (p) => (p.slice(p.indexOf('## Steps'), p.indexOf('## Output format')).match(/^\d+\. `[^`]+`/gm) ?? []).map((s) => s.replace(/^\d+\. `/, '').split(' ')[0]);
  const waited = ciVerifyPrompt({ pr: 7, repo: 'o/n', checks: ['e2e'], seconds: CI_VERIFY_POLL_SECONDS });
  assert.deepEqual(bashOf(waited), ['ci-wait', 'gh', 'check-ci']);
  assert.deepEqual(bashOf(ciVerifyPrompt({ pr: 7, repo: 'o/n', checks: ['e2e'], seconds: 0 })), ['gh', 'check-ci']);
  assert.ok(waited.includes('`gh pr checks 7 --repo o/n --json name,state,bucket,link`') && waited.includes(`--only 'e2e'`), waited);
  assert.ok(ciWaitCheckTurns(CI_TURN_MARGIN) <= readMaxTurns());
  // ci-wait は Bash tool の既定 timeout（120 秒）に収まる長さ
  assert.ok(CI_VERIFY_POLL_SECONDS < 120);
  assert.ok(CI_VERIFY_CHECK.required.every((k) => CI_STATUS.required.includes(k)));
});

test('[ci-check] ciVerifyVerdict: no_checks（label 直後で job 未登録）は pending、passed / failed / error はそのまま', () => {
  assert.equal(ciVerifyVerdict({ status: 'no_checks' }), 'pending');
  assert.equal(ciVerifyVerdict({ status: 'pending' }), 'pending');
  assert.equal(ciVerifyVerdict({ status: 'passed' }), 'passed');
  assert.equal(ciVerifyVerdict({ status: 'failed' }), 'failed');
  assert.equal(ciVerifyVerdict({ status: 'error' }), 'error');
});
