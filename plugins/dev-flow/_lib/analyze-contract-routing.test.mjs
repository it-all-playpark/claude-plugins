// _lib/analyze-contract-routing.test.mjs
// Guard test: Setup 末尾の analyze ゲートの配線 pin（issue #690 / #695）。ゲートは prerun の script 段
// （analyze-issue --contract + Jev 有界判定）の結果 args.setup.analyze を whitelist 検証して REQ を組み、
// 3 条件ゲートだけを判定する（固有の phase は持たない）。
//
//   (a) 通常経路（AC 抽出成功・conflict 無し・uncertain 空）: analyze ゲートの agent spawn が 0 件、
//       旧 label（contract-probe# / analyze# / issue-meta / analyze-retrunc# / analyze-retry#）が 0 件、run は完走
//   (b) ゲート（AC 空 / comment_conflicts 非空 / uncertain 非空）: needs_clarification が isolation-probe より前に
//       確定し、isolation-probe / dev-implementer / pr の spawn が 0 件、ゲート後の sonnet spawn
//       （analyze-clarify#1, dev-runner）はちょうど 1 回
//   (c) analyze.ok:false（gh 到達不能 / JSON 不正）: needs_clarification（source=analyze_prerun）で sonnet も
//       isolation-probe も spawn しない
//   (d) clarify agent の null / throw は fail-open（ゲート理由をそのまま missing_context にする）
//   (e) 通常経路の isolation-probe は Analyze ゲート後・Implement 前に 1 回（needs_clarification 経路では 0 回）
//   (f) args.setup.analyze が ok:true だが whitelist 不合格 → fail-closed throw（推測で REQ を組まない）
//   (g) clarify prompt はゲート理由を verbatim で含み、issue は analyze-issue の直接実行（切断時は dump を Read）で読ませ、
//       issue 転写（gh の直接実行 / sandbox 語）を指示しない
//   (h) REQ が prerun の analyze から組まれる: breaking_change / issue_body / AC が dev-implementer prompt と shape に届く
//   (i) open な blocker（issue #744）: needs_clarification（source=blocked_by）で journal handoff 以外の spawn 0、
//       missing_context に未完了 issue を列挙。analyze ゲートより先に判定する。closed のみなら通常経路
//   (j) repo 内外が混ざった AC（issue #793）: needs_clarification（source=analyze）で Implement に進まず、
//       missing_context に分割を求める決定論の理由が載る。repo 外だけの AC はゲートを通り human AC に分類される
//
// Run: npx vitest run _lib/analyze-contract-routing.test.mjs
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash, analyzeArgs, devFlowArgs, prerunAnalyze } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const src = readFileSync(join(repoRoot, '.claude', 'workflows', 'dev-flow.js'), 'utf8');

const LEGACY_ANALYZE_LABELS = ['contract-probe#', 'analyze#', 'issue-meta', 'analyze-retrunc#', 'analyze-retry#'];

async function run({ overrides = {}, analyze = {}, args } = {}) {
  const { ctx, calls, logs } = makeDevFlowSandbox({ overrides, extra: { args: args ?? analyzeArgs(1, analyze) } });
  const { result, error } = await runWorkflowCapture(src, ctx);
  assertNoCrash(error, 'analyze-contract-routing');
  return { calls, logs, result, error };
}

// analyze ゲート由来の spawn（label が 'analyze' で始まる。通常経路では 0 件、ゲート後の analyze-clarify#N のみ）
function analyzeGateCalls(calls) {
  return calls.filter((c) => c.label.startsWith('analyze'));
}
function legacyCalls(calls) {
  return calls.filter((c) => LEGACY_ANALYZE_LABELS.some((p) => c.label === p || c.label.startsWith(p)));
}
function implementerCalls(calls) {
  return calls.filter((c) => c.agentType === 'dev-flow:dev-implementer');
}
function assertClarificationBeforeSpawn(calls, result, name) {
  assert.equal(result?.status, 'needs_clarification', `[${name}] status は needs_clarification のはずだが ${JSON.stringify(result?.status)}`);
  assert.equal(calls.filter((c) => c.label === 'isolation-probe').length, 0, `[${name}] needs_clarification 経路で isolation-probe が spawn されている`);
  assert.equal(implementerCalls(calls).length, 0, `[${name}] needs_clarification 経路で dev-implementer が spawn されている`);
  assert.equal(calls.filter((c) => c.label.startsWith('pr')).length, 0, `[${name}] needs_clarification 経路で pr 系が spawn されている`);
  assert.equal(legacyCalls(calls).length, 0, `[${name}] 旧 analyze 系 label が spawn されている: ${legacyCalls(calls).map((c) => c.label).join(', ')}`);
}

// ---- (a) 通常経路: analyze ゲートの spawn 0 ----
test('[analyze-routing] (a) 通常経路: analyze ゲートの agent spawn は 0 件、旧 analyze 系 label も 0 件で run が完走する', async () => {
  const { calls, result, error, logs } = await run();
  assert.equal(error, null, `run が throw してはならないが: ${error?.message}`);
  assert.equal(analyzeGateCalls(calls).length, 0, `analyze ゲートの spawn: ${analyzeGateCalls(calls).map((c) => c.label).join(', ')}`);
  assert.equal(legacyCalls(calls).length, 0, `旧 analyze 系 label: ${legacyCalls(calls).map((c) => c.label).join(', ')}`);
  assert.equal(calls.filter((c) => c.agentType === 'dev-flow:dev-runner').length, 0, '通常経路で dev-runner（sonnet）が spawn されている');
  assert.ok(result && typeof result === 'object' && result.status !== 'needs_clarification', `run は完走するはず: ${JSON.stringify(result?.status)}`);
  assert.ok(logs.some((l) => l.includes('analyze ゲートの spawn 0')), 'analyze ゲートの spawn 0 の log が無い');
});

test('[analyze-routing] (a2) jev 経路（comment_overrides のみ / breaking_change=true）も analyze ゲートの spawn は 0 で run が進む', async () => {
  const { calls, result, error, logs } = await run({
    analyze: { analyze_path: 'jev', jev_reasons: ['breaking_keyword_scan true', 'comments present (1)'], comment_count: 1, comment_overrides: ['override: comment #1 by reporter（NONE, t）: 訂正: 30 箇所'], breaking_change: true, breaking_evidence: 'Jev noul p=0.95' },
  });
  assert.equal(error, null, `run が throw してはならないが: ${error?.message}`);
  assert.equal(analyzeGateCalls(calls).length, 0);
  assert.ok(result?.status !== 'needs_clarification');
  assert.ok(logs.some((l) => l.includes('comment による body 訂正を採用（1 件）')), 'override 採用の log が無い');
  assert.ok(logs.some((l) => l.includes('breaking_change=true')), 'breaking_change の log が無い');
});

// ---- (b) ゲート 3 条件 → needs_clarification（probe / dev-implementer より前・sonnet 1 回）----
for (const [name, analyze] of [
  ['AC 空', { acceptance_criteria: [] }],
  ['comment_conflicts 非空', { analyze_path: 'jev', jev_reasons: ['comments present (1)'], comment_count: 1, comment_conflicts: ['conflict: comment #1 by alice（OWNER, t）: hmm'] }],
  ['uncertain 非空', { analyze_path: 'jev', jev_reasons: ['breaking_keyword_scan true'], uncertain: ['breaking_keyword_scan: Jev 応答なし'] }],
]) {
  test(`[analyze-routing] (b) ${name} → needs_clarification が isolation-probe / dev-implementer より前に確定し、sonnet（analyze-clarify#1）はちょうど 1 回`, async () => {
    const { calls, result, error } = await run({ analyze });
    assert.equal(error, null, `run が throw してはならないが: ${error?.message}`);
    assertClarificationBeforeSpawn(calls, result, name);
    assert.equal(result.source, 'analyze');
    const clarify = calls.filter((c) => c.label === 'analyze-clarify#1');
    assert.equal(clarify.length, 1, `analyze-clarify#1 は 1 回のはずだが ${clarify.length} 回`);
    assert.equal(clarify[0].agentType, 'dev-flow:dev-runner');
    assert.equal(clarify[0].opts.phase, 'Setup', 'analyze-clarify の phase 帰属は Setup（Analyze phase は issue #695 で撤去）');
    assert.equal(calls.filter((c) => c.agentType === 'dev-flow:dev-runner').length, 1, 'sonnet の spawn は analyze-clarify#1 の 1 回のみ');
    // missing_context は sonnet の質問文 + 決定論のゲート理由
    assert.ok(Array.isArray(result.missing_context) && result.missing_context.includes('stub-clarify-question'), `missing_context に sonnet の質問文が無い: ${JSON.stringify(result.missing_context)}`);
    assert.ok(result.missing_context.length >= 2, 'missing_context に決定論のゲート理由が付いていない');
    assert.equal(result.worktree, '/tmp/wt');
    assert.equal(result.journal_log_status, 'logged');
  });
}

test('[analyze-routing] (b2) 3 条件が同時でも sonnet は 1 回', async () => {
  const { calls, result, error } = await run({ analyze: { acceptance_criteria: [], comment_conflicts: ['c'], uncertain: ['u'] } });
  assert.equal(error, null);
  assertClarificationBeforeSpawn(calls, result, 'all-3');
  assert.equal(calls.filter((c) => c.label === 'analyze-clarify#1').length, 1);
});

// ---- (c) analyze.ok:false → needs_clarification（source=analyze_prerun）、spawn 0 ----
test('[analyze-routing] (c) analyze.ok:false → needs_clarification（source=analyze_prerun）で sonnet も isolation-probe も spawn しない', async () => {
  const { calls, result, error, logs } = await run({
    args: devFlowArgs(1, { analyze: { ok: false, reason: 'analyze-issue --contract failed: gh: HTTP 502', analyze_path: 'contract', duration_seconds: 2 } }),
  });
  assert.equal(error, null, `run が throw してはならないが: ${error?.message}`);
  assertClarificationBeforeSpawn(calls, result, 'ok-false');
  assert.equal(result.source, 'analyze_prerun');
  assert.equal(calls.filter((c) => c.label === 'analyze-clarify#1').length, 0, 'ok:false では sonnet を spawn しない');
  assert.equal(calls.filter((c) => c.agentType === 'dev-flow:dev-runner').length, 0);
  // journal handoff（journal-log-failure）以外の spawn が無い
  const nonJournal = calls.filter((c) => !c.label.startsWith('journal'));
  assert.deepEqual(nonJournal.map((c) => c.label), [], `ok:false 経路の spawn は journal handoff のみのはず: ${calls.map((c) => c.label).join(', ')}`);
  assert.ok(result.missing_context.some((m) => m.includes('HTTP 502')), `missing_context に prerun の reason が無い: ${JSON.stringify(result.missing_context)}`);
  assert.ok(logs.some((l) => l.includes('source=analyze_prerun')));
});

// ---- (d) clarify agent の失敗は fail-open ----
test('[analyze-routing] (d) analyze-clarify#1 が null / throw でもゲート理由をそのまま missing_context にして needs_clarification を返す', async () => {
  for (const [kind, override] of [['null', null], ['throw', () => { throw new Error('boom'); }]]) {
    const { calls, result, error } = await run({ analyze: { acceptance_criteria: [] }, overrides: { 'analyze-clarify#1': override } });
    assert.equal(error, null, `[${kind}] run が throw してはならないが: ${error?.message}`);
    assertClarificationBeforeSpawn(calls, result, `clarify-${kind}`);
    assert.equal(calls.filter((c) => c.label === 'analyze-clarify#1').length, 1, `[${kind}] sonnet は 1 回（再試行しない）`);
    assert.ok(result.missing_context.some((m) => m.includes('acceptance_criteria が空')), `[${kind}] 決定論のゲート理由が missing_context に無い: ${JSON.stringify(result.missing_context)}`);
    assert.ok(!result.missing_context.includes('stub-clarify-question'));
  }
});

// ---- (e) isolation-probe の位置: ゲート後・Implement 前 ----
test('[analyze-routing] (e) 通常経路の isolation-probe は Analyze ゲート後・dev-implementer 前に 1 回', async () => {
  const { calls, error } = await run();
  assert.equal(error, null);
  const probeIdx = calls.findIndex((c) => c.label === 'isolation-probe');
  const implIdx = calls.findIndex((c) => c.agentType === 'dev-flow:dev-implementer');
  assert.equal(calls.filter((c) => c.label === 'isolation-probe').length, 1);
  assert.ok(probeIdx >= 0 && implIdx > probeIdx, `isolation-probe(${probeIdx}) は dev-implementer(${implIdx}) より前のはず`);
  // probe より前の spawn は 0（Setup / Analyze は decision-only）
  assert.equal(probeIdx, 0, `isolation-probe より前に spawn がある: ${calls.slice(0, probeIdx).map((c) => c.label).join(', ')}`);
  assert.equal(calls[probeIdx].agentType, 'dev-flow:dev-runner-haiku-wo');
});

// ---- (f) whitelist 不合格 → fail-closed throw ----
test('[analyze-routing] (f) args.setup.analyze が ok:true だが whitelist 不合格（acceptance_criteria に空文字）→ throw、spawn 0', async () => {
  const { calls, error } = await run({ analyze: { acceptance_criteria: ['a', ''] } });
  assert.ok(error, 'whitelist 不合格で throw するはず');
  assert.match(error.message, /args\.setup\.analyze が whitelist 検証に不合格/);
  assert.equal(calls.filter((c) => !c.label.startsWith('journal')).length, 0, `throw 前に spawn がある: ${calls.map((c) => c.label).join(', ')}`);
});

test('[analyze-routing] (f2) analyze_path=sonnet は入力として不合格（sonnet はゲート後に Workflow が付ける値）→ throw', async () => {
  const { error } = await run({ analyze: { analyze_path: 'sonnet' } });
  assert.ok(error);
  assert.match(error.message, /whitelist 検証に不合格/);
});

// ---- (g) clarify prompt の契約 ----
test('[analyze-routing] (g) analyze-clarify#1 prompt はゲート理由を verbatim で含み、要件の推測・sandbox 語・gh 直接実行を指示しない', async () => {
  const conflict = 'conflict: comment #1 by alice（OWNER, 2026-01-01T00:00:00Z）: 30 箇所ではなく 20 箇所';
  const { calls } = await run({ analyze: { analyze_path: 'jev', jev_reasons: ['comments present (1)'], comment_count: 1, comment_conflicts: [conflict] } });
  const call = calls.find((c) => c.label === 'analyze-clarify#1');
  assert.ok(call);
  assert.ok(call.prompt.includes(conflict), 'ゲート理由が verbatim で prompt に無い');
  assert.ok(call.prompt.includes('missing_context'), 'missing_context の返却指示が無い');
  // issue は Skill を経由せず、exec-proxy analyze-issue を bare 名で直接実行して読む。切断時は dump を Read する
  assert.ok(call.prompt.includes('`analyze-issue 1 --depth comprehensive --dump-body "${TMPDIR:-/tmp}/issue-1-body.md"`'), 'analyze-issue を bare 名で直接実行する指示が無い');
  assert.ok(call.prompt.includes('body_dump_path が null でなければ、そのファイルを Read して'), 'body_dump_path の Read 指示が無い');
  assert.ok(!call.prompt.includes('Skill:'), 'issue の読み取りを Skill 経由で指示してはならない');
  assert.ok(call.prompt.includes('推測して埋めるな'), '要件推測の禁止が無い');
  assert.ok(call.prompt.includes('date +%s'), 'EPOCH_INSTRUCTION が無い');
  assert.ok(!/sandbox|excludedCommands/.test(call.prompt), 'prompt に sandbox / excludedCommands が含まれてはならない');
  assert.ok(!call.prompt.includes('gh issue view'), 'prompt に gh の直接実行指示が含まれてはならない');
  // schema は VM realm の Array なので deepEqual（prototype 比較）ではなく JSON で突合する
  assert.equal(JSON.stringify(call.schema?.required), JSON.stringify(['missing_context']));
});

// (g2) issue #728: 明記を求める語が analyze-issue の breaking キーワード判定に掛かると、指示に従うほどゲートが増える
test('[analyze-routing] (g2) analyze-clarify#1 prompt は互換性の明記を breaking キーワード抜きで求め、その語の使用を禁じる', async () => {
  const { calls } = await run({ analyze: { analyze_path: 'jev', jev_reasons: ['breaking_keyword_scan true'], uncertain: ['breaking_keyword_scan: Jev が低確信で判定できない'] } });
  const call = calls.find((c) => c.label === 'analyze-clarify#1');
  assert.ok(call);
  assert.ok(call.prompt.includes('後方互換を保たない API / 形式の変更の有無と既存データの変換の要否'), '互換性の明記の問い方が無い');
  assert.ok(!call.prompt.includes('非互換変更 / migration の有無'), 'キーワード判定に掛かる語で明記を求めてはならない');
  assert.ok(call.prompt.includes('breaking / incompatible / migration / 破壊的 / 非互換 の語を使うな'), 'キーワードの使用禁止が無い');
});

// ---- (h) REQ は prerun の analyze から組まれる ----
test('[analyze-routing] (h) prerun の analyze の issue_body / AC / issue_title が dev-implementer prompt に届き、breaking_change=true は shape=complex に倒す', async () => {
  const analyze = prerunAnalyze({ issue_title: 'feat: prerun analyze', issue_body: 'PRERUN-BODY-MARKER', acceptance_criteria: ['AC-ONE', 'AC-TWO'], breaking_change: true, breaking_evidence: 'title の breaking marker (!)' });
  const { calls, logs, error } = await run({ args: devFlowArgs(1, { analyze }) });
  assert.equal(error, null);
  const impl = calls.find((c) => c.agentType === 'dev-flow:dev-implementer');
  assert.ok(impl);
  assert.ok(impl.prompt.includes('PRERUN-BODY-MARKER'), 'issue_body が dev-implementer prompt に無い');
  assert.ok(impl.prompt.includes('AC-ONE') && impl.prompt.includes('AC-TWO'), 'AC が dev-implementer prompt に無い');
  assert.ok(impl.prompt.includes('feat: prerun analyze'), 'issue_title が dev-implementer prompt に無い');
  assert.ok(logs.some((l) => /shape=complex|floor=complex|breaking change detected/.test(l)), `breaking_change=true が shape に反映されていない: ${logs.filter((l) => l.includes('shape')).join(' | ')}`);
});

// ---- (i) blocked_by ゲート（issue #744）----
const OPEN_BLOCKER = { repo: 'acme/skills', number: 12, state: 'OPEN', source: 'api', url: 'https://github.com/acme/skills/issues/12' };
const OPEN_BODY_BLOCKER = { repo: 'other/lib', number: 5, state: 'OPEN', source: 'body', url: 'https://github.com/other/lib/issues/5' };
const CLOSED_BLOCKER = { repo: 'acme/skills', number: 13, state: 'CLOSED', source: 'body', url: 'https://github.com/acme/skills/issues/13' };

test('[analyze-routing] (i) open な blocker → needs_clarification（source=blocked_by）で sonnet / isolation-probe / dev-implementer を spawn せず、missing_context に未完了 issue を列挙', async () => {
  const { calls, result, error, logs } = await run({ analyze: { blockers: [OPEN_BLOCKER, CLOSED_BLOCKER, OPEN_BODY_BLOCKER] } });
  assert.equal(error, null, `run が throw してはならないが: ${error?.message}`);
  assertClarificationBeforeSpawn(calls, result, 'blocked_by');
  assert.equal(result.source, 'blocked_by');
  const nonJournal = calls.filter((c) => !c.label.startsWith('journal'));
  assert.deepEqual(nonJournal.map((c) => c.label), [], `blocked_by 経路の spawn は journal handoff のみのはず: ${calls.map((c) => c.label).join(', ')}`);
  assert.equal(result.missing_context.length, 2, `open の 2 件だけを列挙するはず: ${JSON.stringify(result.missing_context)}`);
  assert.ok(result.missing_context[0].includes('acme/skills#12') && result.missing_context[0].includes(OPEN_BLOCKER.url));
  assert.ok(result.missing_context[1].includes('other/lib#5') && result.missing_context[1].includes(OPEN_BODY_BLOCKER.url));
  assert.ok(!result.missing_context.some((m) => m.includes('#13')), 'closed の blocker を列挙してはならない');
  assert.equal(result.worktree, '/tmp/wt');
  assert.equal(result.journal_log_status, 'logged');
  assert.ok(logs.some((l) => l.includes('source=blocked_by')));
});

test('[analyze-routing] (i2) open な blocker と uncertain が同時 → blocked_by が先に終端し sonnet（analyze-clarify）は spawn しない', async () => {
  const { calls, result, error } = await run({ analyze: { analyze_path: 'jev', jev_reasons: ['breaking_keyword_scan true'], uncertain: ['breaking_keyword_scan: Jev 応答なし'], blockers: [OPEN_BLOCKER] } });
  assert.equal(error, null);
  assertClarificationBeforeSpawn(calls, result, 'blocked_by+uncertain');
  assert.equal(result.source, 'blocked_by');
  assert.equal(calls.filter((c) => c.label.startsWith('analyze-clarify')).length, 0);
});

test('[analyze-routing] (i3) closed の blocker のみ → 従来どおり isolation-probe → dev-implementer へ進む', async () => {
  const { calls, result, error, logs } = await run({ analyze: { blockers: [CLOSED_BLOCKER] } });
  assert.equal(error, null, `run が throw してはならないが: ${error?.message}`);
  assert.ok(result?.status !== 'needs_clarification', `closed のみで止まってはならない: ${JSON.stringify(result?.status)}`);
  assert.equal(calls.filter((c) => c.label === 'isolation-probe').length, 1);
  assert.ok(implementerCalls(calls).length >= 1, 'dev-implementer が spawn されていない');
  assert.ok(logs.some((l) => l.includes('acme/skills#13=CLOSED(body)')), 'closed blocker の log が無い');
});

// ---- (j) repo 内外が混ざった AC → needs_clarification（Implement に進まない）----
const MIXED_AC = '古い skill を参照するテスト・README・rules を削除し、dotfiles の excludedCommands から dev-flow-doctor を外す';
const EXTERNAL_AC = 'dotfiles の excludedCommands に dev-flow-health の起動形を足す';

test('[analyze-routing] (j1) repo 内外が混ざった AC を持つ issue → needs_clarification（source=analyze）で isolation-probe / dev-implementer より前に止まり、AC の分割を求める', async () => {
  const { calls, result, error, logs } = await run({ analyze: { acceptance_criteria: ['worker 数の上限を設定で変えられる', MIXED_AC] } });
  assert.equal(error, null, `run が throw してはならないが: ${error?.message}`);
  assertClarificationBeforeSpawn(calls, result, 'mixed-ac');
  assert.equal(result.source, 'analyze');
  const reason = result.missing_context.find((m) => m.startsWith('AC-2「'));
  assert.ok(reason, `missing_context に混在 AC の理由が無い: ${JSON.stringify(result.missing_context)}`);
  assert.ok(reason.includes(MIXED_AC));
  assert.match(reason, /repo 内の AC と repo 外の AC に分割/);
  const clarify = calls.filter((c) => c.label === 'analyze-clarify#1');
  assert.equal(clarify.length, 1);
  assert.ok(clarify[0].prompt.includes('AC-2「'), 'clarify prompt にゲート理由（混在 AC）が verbatim で無い');
  assert.ok(logs.some((l) => l.includes('repo 内外混在 AC=1')), 'ゲート log に混在 AC の件数が無い');
});

test('[analyze-routing] (j2) repo 外の作業だけを書いた AC はゲートを通り、人手 AC として Implement に進む', async () => {
  const { calls, result, error, logs } = await run({ analyze: { acceptance_criteria: ['worker 数の上限を設定で変えられる', EXTERNAL_AC] } });
  assert.equal(error, null, `run が throw してはならないが: ${error?.message}`);
  assert.ok(result?.status !== 'needs_clarification', `repo 外だけの AC で止まってはならない: ${JSON.stringify(result?.missing_context)}`);
  assert.equal(analyzeGateCalls(calls).length, 0, 'ゲートの spawn は 0 のまま');
  assert.ok(implementerCalls(calls).length >= 1, 'dev-implementer が spawn されていない');
  assert.ok(logs.some((l) => l.includes('人手 AC 1 件（AC-2）')), `repo 外だけの AC が人手 AC に分類されていない: ${logs.filter((l) => l.startsWith('analyze')).join(' | ')}`);
});

test('[analyze-routing] (j3) 対象 repo 以外の owner/repo#N と repo 内の作業が混ざった AC も止まる（対象 repo の参照は止めない）', async () => {
  const withRepo = (acs) => devFlowArgs(1, { repo: 'acme/skills', analyze: prerunAnalyze({ acceptance_criteria: acs }) });
  const mixed = await run({ args: withRepo(['acme/infra#12 の設定を変え、テストを足す']) });
  assert.equal(mixed.error, null);
  assertClarificationBeforeSpawn(mixed.calls, mixed.result, 'other-repo-mixed');
  const self = await run({ args: withRepo(['acme/skills#12 の再発をテストで防ぐ']) });
  assert.equal(self.error, null);
  assert.ok(self.result?.status !== 'needs_clarification', `対象 repo の参照で止まってはならない: ${JSON.stringify(self.result?.missing_context)}`);
});

test('[analyze-routing] (i4) blockers が whitelist 不合格（欠落）→ throw（推測で素通りさせない）', async () => {
  const analyze = prerunAnalyze();
  delete analyze.blockers;
  const { calls, error } = await run({ args: devFlowArgs(1, { analyze }) });
  assert.ok(error, 'blockers 欠落で throw するはず');
  assert.match(error.message, /whitelist 検証に不合格/);
  assert.equal(calls.filter((c) => !c.label.startsWith('journal')).length, 0);
});
