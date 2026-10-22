// 信頼境界をまたぐ PR の security review 段（issue #1063）の routing を、review 結果を stub した VM 実行で pin する。
//
// pr-iterate.js（単体起動 caller:'standalone' と dev-flow からの nested caller:'dev-flow' の両方）:
//   (1) 対象の PR は security-reviewer が critical/major 0 件を返すまで status:'lgtm' にしない
//   (2) security review の critical/major は fix に回り、fix 後の security review は delta ではなく PR 全 diff を読む新しい spawn
//   (3) security review の上限（SECURITY_REVIEW_MAX）まで critical/major が残れば status:'security_unresolved'（lgtm 以外）
//   (4) 対象外の PR（target:false / args.security_review 未指定）は spawn する agent と回数が変わらない
//   (5) security-reviewer の出力 schema は pr-reviewer と同じ REVIEW（severity / topic）、agent 定義は脅威モデルを持つ
// dev-flow.js:
//   (6) Security floor の secreview を args.security_review で nested pr-iterate へ渡し、対象の micro run は lite に入らない
//   (7) nested pr-iterate が security_unresolved で返った run は merge tier HOLD（code security_review_unresolved）

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makePrIterateSandbox, makeDevFlowSandbox, runWorkflowCapture, shapeOverrides, MICRO_FILES } from './test-helpers/vm-sandbox.mjs';
import { SECURITY_REVIEW_MAX, SECURITY_UNRESOLVED_STATUS } from './security-review.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = join(here, '..');
const prIterateSrc = readFileSync(join(pluginRoot, '.claude/workflows/pr-iterate.js'), 'utf8');
const devFlowSrc = readFileSync(join(pluginRoot, '.claude/workflows/dev-flow.js'), 'utf8');
const securityReviewerMd = readFileSync(join(pluginRoot, 'agents/security-reviewer.md'), 'utf8');

const SEC = 'dev-flow:security-reviewer';
const REVIEWER = 'dev-flow:pr-reviewer';
const TARGET = { target: true, reasons: ['sandbox_boundary: plugins/meeting/scripts/meeting.sh', 'path_write: plugins/meeting/scripts/meeting.sh'] };
const NESTED = { cwd: '/tmp/wt', head_ref: 'feature/x', base_ref: 'main', repo: 'acme/skills', head_sha: 'a'.repeat(40) };
const CALLERS = [['単体 /pr-iterate（standalone）', 'standalone'], ['/dev-flow の nested pr-iterate', 'dev-flow']];

const finding = (k) => ({ severity: 'critical', topic: `hardlink-write::scripts/m${k}.sh`, file: `scripts/m${k}.sh`, line: 10, description: `hardlink 経由で保存先の外を書ける ${k}`, suggestion: 'st_nlink を確かめる' });
const blockingReview = (k) => ({ decision: 'request-changes', issues: [finding(k)], summary: `ng ${k}` });
const cleanReview = { decision: 'approve', issues: [], summary: 'ok' };

/**
 * security-reviewer の n 回目（1 始まり）の応答を secReview(n) で返す pr-iterate run。pr-reviewer は既定で approve、
 * CI は passed。commit-ensure は fix のたびに新しい head sha を返す（次 round の pr-reviewer は fix delta を読む）。
 */
async function runPrIterate({ args, secReview = () => cleanReview, reviewer = null }) {
  let sec = 0;
  let reviews = 0;
  let commits = 0;
  const { ctx, calls } = makePrIterateSandbox({
    args,
    rounds: ({ label, agentType }) => {
      if (agentType === SEC) return secReview(++sec);
      if (reviewer && agentType === REVIEWER) return reviewer(++reviews);
      if (label.startsWith('commit-ensure#')) return { dirty: false, committed: false, pushed: false, head_sha: String(++commits).repeat(40).slice(0, 40), delta_shortstat: ' 1 file changed, 2 insertions(+)' };
      return undefined;
    },
  });
  const { result, error } = await runWorkflowCapture(prIterateSrc, ctx, '.claude/workflows/pr-iterate.js');
  assert.equal(error, null, `pr-iterate が throw した: ${error?.name}: ${error?.message}`);
  return { result, calls };
}

// vm の realm で作られた値を node 側の deepEqual で比べるための正規化
const plain = (v) => JSON.parse(JSON.stringify(v));
const argsFor = (caller, extra = {}) => ({ pr: 5, nested: { ...NESTED, caller }, ...extra });
const secCalls = (calls) => calls.filter((c) => c.agentType === SEC && !c.label.endsWith('-schema-retry'));

// ---- (1)(2) 対象の PR: critical/major が 0 件になるまで LGTM にしない・fix 後は全 diff の新しい spawn ----

for (const [name, caller] of CALLERS) {
  test(`[security-review] ${name}: security review が critical を返す間は LGTM にせず fix に回し、0 件になった round で lgtm`, async () => {
    const { result, calls } = await runPrIterate({
      args: argsFor(caller, { security_review: TARGET }),
      secReview: (n) => (n <= 2 ? blockingReview(n) : cleanReview),
    });
    assert.equal(result.status, 'lgtm');
    const sec = secCalls(calls);
    assert.deepEqual(sec.map((c) => c.label), ['security-review#1', 'security-review#2', 'security-review#3']);
    // critical を返した 2 回はそれぞれ fix に回る（security review の指摘が fix prompt に載る）
    const fixes = calls.filter((c) => c.label.startsWith('fix#'));
    assert.deepEqual(fixes.map((c) => c.label), ['fix#1', 'fix#2']);
    assert.ok(fixes[0].prompt.includes('hardlink 経由で保存先の外を書ける 1'), fixes[0].prompt);
    assert.ok(fixes[1].prompt.includes('hardlink 経由で保存先の外を書ける 2'), fixes[1].prompt);
    assert.equal(result.fixes_applied, 2);
    // security の round は blocking 1 → 1 → 0。LGTM の round（history の最後）は clean な security review と同じ iteration
    const secRounds = plain(result.history).filter((r) => r.scope === 'security');
    assert.deepEqual(secRounds.map((r) => r.blocking.length), [1, 1, 0]);
    assert.equal(result.history[result.history.length - 1].iteration, secRounds[2].iteration);
    assert.deepEqual(plain(result.security_review), { target: true, reasons: TARGET.reasons, rounds: 3, open: [] });
  });

  test(`[security-review] ${name}: fix 後の security review は delta ではなく PR 全 diff を読む新しい spawn（前 round の指摘を渡さない）`, async () => {
    const { calls } = await runPrIterate({
      args: argsFor(caller, { security_review: TARGET }),
      secReview: (n) => (n === 1 ? blockingReview(1) : cleanReview),
    });
    const sec = secCalls(calls);
    assert.equal(sec.length, 2, '新しい spawn（別の agent 呼び出し）で取り直す');
    for (const c of sec) {
      assert.ok(c.prompt.includes('gh pr diff 5 --repo acme/skills'), c.prompt);
      assert.ok(c.prompt.includes('PR 全 diff'), c.prompt);
      assert.ok(!c.prompt.includes('delta_range'), `security review に delta を渡している: ${c.prompt}`);
      assert.ok(!c.prompt.includes('既出 findings'), `security review に既出 findings を渡している: ${c.prompt}`);
      assert.ok(c.prompt.includes('sandbox_boundary: plugins/meeting/scripts/meeting.sh'), '決定論判定の箇所を渡す');
    }
    assert.ok(!sec[1].prompt.includes('hardlink-write::scripts/m1.sh'), '前 round の指摘の topic を渡していない');
    // 対照: 同じ run の pr-reviewer は fix 後の round で fix delta だけを読む
    const review2 = calls.find((c) => c.label === 'review#2');
    assert.ok(review2 && review2.prompt.includes('delta_range'), `review#2 は fix delta を読むはず: ${review2?.prompt}`);
    // 順序: security-review#1 → fix#1 → commit-ensure#1 → review#2 → … → security-review#2
    const order = calls.map((c) => c.label).filter((l) => /^(security-review#|fix#|commit-ensure#|review#)\d+$/.test(l));
    assert.deepEqual(order, ['review#1', 'security-review#1', 'fix#1', 'commit-ensure#1', 'review#2', 'security-review#2']);
  });

  // ---- (3) 上限まで critical/major が残る → security_unresolved ----

  test(`[security-review] ${name}: security review が上限 ${SECURITY_REVIEW_MAX} 回まで critical を返したら lgtm 以外の security_unresolved で終える`, async () => {
    const { result, calls } = await runPrIterate({
      args: argsFor(caller, { security_review: TARGET }),
      secReview: (n) => blockingReview(n),
    });
    assert.equal(result.status, SECURITY_UNRESOLVED_STATUS);
    assert.equal(result.status, 'security_unresolved');
    assert.equal(secCalls(calls).length, SECURITY_REVIEW_MAX);
    // 上限回目の指摘は直した結果を確かめる spawn が残らないので fix に回さない
    assert.equal(calls.filter((c) => c.label.startsWith('fix#')).length, SECURITY_REVIEW_MAX - 1);
    assert.deepEqual(plain(result.security_review.open.map((f) => f.topic)), [`hardlink-write::scripts/m${SECURITY_REVIEW_MAX}.sh`]);
    assert.equal(result.security_review.rounds, SECURITY_REVIEW_MAX);
  });

  test(`[security-review] ${name}: security review が worktree の外を指す critical を返したら fix できないので LGTM にせず security_unresolved で終える`, async () => {
    const outsideFinding = { ...finding(1), topic: 'settings-escape::~/.claude/settings.json', file: '~/.claude/settings.json' };
    const { result, calls } = await runPrIterate({
      args: argsFor(caller, { security_review: TARGET }),
      secReview: () => ({ decision: 'request-changes', issues: [outsideFinding], summary: 'ng' }),
    });
    assert.equal(result.status, SECURITY_UNRESOLVED_STATUS);
    assert.equal(secCalls(calls).length, 1);
    assert.equal(calls.filter((c) => c.label.startsWith('fix#')).length, 0);
    assert.deepEqual(plain(result.security_review.open.map((f) => f.file)), ['~/.claude/settings.json']);
    assert.deepEqual(plain(result.human_followups.map((f) => f.file)), ['~/.claude/settings.json']);
  });
}

test('[security-review] security review が schema-retry 後も結果を返さなければ LGTM にしない（review_contract_error）', async () => {
  const { result } = await runPrIterate({ args: argsFor('standalone', { security_review: TARGET }), secReview: () => null });
  assert.equal(result.status, 'review_contract_error');
});

test('[security-review] security_review の不正形は明示 throw', async () => {
  const { ctx } = makePrIterateSandbox({ args: { pr: 5, security_review: { target: 'yes', reasons: [] } } });
  const { error } = await runWorkflowCapture(prIterateSrc, ctx, '.claude/workflows/pr-iterate.js');
  assert.match(error?.message ?? '', /args\.security_review が不正形/);
});

// ---- (4) 対象外の PR は review 経路が変わらない ----

const route = (calls) => calls.map((c) => `${c.agentType} ${c.label}`);

for (const [name, caller] of CALLERS) {
  test(`[security-review] ${name}: 対象外（target:false）の PR は spawn する agent と回数が security_review 未指定の run と同じで、security-reviewer を起動しない`, async () => {
    // pr-reviewer が 1 回 blocking を返して fix → 次 round で approve、の典型経路で比べる
    const reviewer = (n) => (n === 1 ? blockingReview(9) : cleanReview);
    const withArg = await runPrIterate({ args: argsFor(caller, { security_review: { target: false, reasons: [] } }), reviewer });
    const without = await runPrIterate({ args: argsFor(caller), reviewer });
    assert.equal(withArg.result.status, 'lgtm');
    assert.deepEqual(route(withArg.calls), route(without.calls));
    assert.deepEqual(plain(withArg.result.subagent_invocations), plain(without.result.subagent_invocations));
    assert.ok(!withArg.calls.some((c) => c.agentType === SEC), 'security-reviewer を起動している');
    assert.deepEqual(plain(withArg.result.security_review), { target: false, reasons: [], rounds: 0, open: [] });
    assert.ok(!('security_review' in without.result), 'args.security_review 未指定の run は返り値にも載せない');
  });
}

// ---- (5) schema と agent 定義 ----

test('[security-review] security-reviewer の出力 schema は pr-reviewer と同じ REVIEW（severity enum / topic 必須）', async () => {
  const { calls } = await runPrIterate({ args: argsFor('standalone', { security_review: TARGET }) });
  const sec = calls.find((c) => c.agentType === SEC);
  const rev = calls.find((c) => c.agentType === REVIEWER);
  assert.ok(sec && rev);
  assert.deepEqual(plain(sec.schema), plain(rev.schema), 'security-reviewer は pr-reviewer と同じ REVIEW schema で呼ぶ');
  const item = plain(sec.schema).properties.issues.items;
  assert.deepEqual(item.properties.severity.enum, ['critical', 'major', 'minor']);
  for (const k of ['severity', 'topic', 'file', 'description', 'suggestion']) assert.ok(item.required.includes(k), k);
  assert.ok(!('model' in sec.opts), '品質ゲート agent に model override を渡さない');
});

test('[security-review] agents/security-reviewer.md は脅威モデル（攻撃者が握る入力・守る資産・sandbox の内外）を持ち、PR 全 diff を読み、REVIEW と同じ出力を返す', () => {
  for (const h of ['## 脅威モデル', '### 攻撃者が握る入力', '### 守る資産', '### sandbox の内外']) {
    assert.ok(securityReviewerMd.includes(h), `security-reviewer.md に「${h}」が無い`);
  }
  assert.ok(securityReviewerMd.includes('`gh pr diff <pr>` で **PR 全 diff** を読む'));
  assert.ok(securityReviewerMd.includes('## 出力 JSON（REVIEW schema。pr-reviewer と同じ形）'));
  const fm = securityReviewerMd.match(/^---\n([\s\S]*?)\n---/)[1];
  assert.match(fm, /^name: security-reviewer$/m);
  assert.match(fm, /^model: opus$/m);
});

// ---- (6)(7) dev-flow.js ----

function workflowRecorder(result) {
  const launches = [];
  const workflow = async (name, args) => {
    launches.push({ name, args });
    return result;
  };
  return { workflow, launches };
}

const microTarget = () => {
  const o = shapeOverrides('micro');
  return { ...o, 'danger-grep': { ...o['danger-grep'], secreview: TARGET } };
};

test('[security-review] dev-flow: Security floor の secreview が対象なら micro でも lite に入らず、nested pr-iterate に security_review を渡す', async () => {
  const { workflow, launches } = workflowRecorder({ status: 'lgtm', iterations: 1, fixes_applied: 0 });
  const { ctx, calls } = makeDevFlowSandbox({ overrides: microTarget(), workflow });
  const { result, error } = await runWorkflowCapture(devFlowSrc, ctx);
  assert.equal(error, null, error?.message);
  assert.equal(result.shape, 'micro');
  assert.ok(!calls.some((c) => c.label === 'pr-review-lite'), 'security review の対象は lite に入らない');
  assert.equal(launches.length, 1);
  assert.equal(launches[0].name, 'dev-flow:pr-iterate-run');
  assert.deepEqual(plain(launches[0].args.security_review), TARGET);
  assert.equal(launches[0].args.nested.caller, 'dev-flow');
});

test('[security-review] dev-flow: 対象外の micro run は従来どおり lite（security_review は渡すが pr-iterate を起動しない）', async () => {
  const { workflow, launches } = workflowRecorder({ status: 'lgtm', iterations: 1, fixes_applied: 0 });
  const { ctx, calls } = makeDevFlowSandbox({ overrides: shapeOverrides('micro'), workflow });
  const { result, error } = await runWorkflowCapture(devFlowSrc, ctx);
  assert.equal(error, null, error?.message);
  assert.equal(result.route, 'lite');
  assert.ok(calls.some((c) => c.label === 'pr-review-lite'));
  assert.equal(launches.length, 0);
  assert.deepEqual(plain(result.security_review), { target: false, reasons: [] });
});

test('[security-review] dev-flow: secfloor の secreview が欠落したら対象に倒し（fail-safe）、nested pr-iterate に target:true を渡す', async () => {
  const o = shapeOverrides('micro');
  const { secreview: _dropped, ...dangerGrep } = o['danger-grep'];
  const { workflow, launches } = workflowRecorder({ status: 'lgtm', iterations: 1, fixes_applied: 0 });
  const { ctx } = makeDevFlowSandbox({ overrides: { ...o, 'danger-grep': dangerGrep }, workflow });
  const { error } = await runWorkflowCapture(devFlowSrc, ctx);
  assert.equal(error, null, error?.message);
  assert.equal(launches.length, 1);
  assert.equal(launches[0].args.security_review.target, true);
  assert.match(launches[0].args.security_review.reasons[0], /^unavailable:/);
});

test('[security-review] dev-flow: nested pr-iterate が security_unresolved で返った run は merge tier HOLD（code security_review_unresolved）', async () => {
  const open = [finding(1)];
  const { workflow } = workflowRecorder({
    status: 'security_unresolved', iterations: 3, fixes_applied: 2,
    security_review: { target: true, reasons: TARGET.reasons, rounds: SECURITY_REVIEW_MAX, open },
  });
  const o = shapeOverrides('micro');
  const { ctx } = makeDevFlowSandbox({
    overrides: {
      ...o,
      'danger-grep': { ...o['danger-grep'], files: [...MICRO_FILES], secreview: TARGET },
      'reconcile-sync': { ok: true, head: 'a'.repeat(40) },
      'test#final': { tests: 'passed', green: true, summary: '' },
    },
    workflow,
  });
  const { result, error } = await runWorkflowCapture(devFlowSrc, ctx);
  assert.equal(error, null, error?.message);
  assert.equal(result.iterate_status, 'security_unresolved');
  assert.equal(result.merge_tier, 'HOLD');
  const codes = result.merge_tier_hold_reasons.map((r) => r.code);
  assert.ok(codes.includes('security_review_unresolved'), JSON.stringify(codes));
  assert.deepEqual(plain(result.security_review.open), open);
});
