// F3: pr-iterate の終端 dirty 検出（AC-2）と fix 適用直後の commit 保証（AC-3）の routing test（issue #437）
//   - fix 適用（applied:true）直後、commit-ensure#i が worktree の未コミット変更を検証する。dirty:false は no-op で継続、
//     dirty:true で commit+push が成功すれば継続（回収カウンタ加算）、null/schema 不一致/回収失敗（committed&&pushed でない）は
//     fail-safe で terminal:'fix_failed'。
//   - status !== 'lgtm' の終端でのみ、worktree-dirty-check の advisory probe を実行する。
//     probe 失敗は fail-open（'unknown' + 警告のみ）。lgtm 終端では probe しない（agent 呼び出し追加ゼロ）。
//   - porcelain 行の選別・基準線との差分・dirty・回収可否・add コマンドは bin/porcelain-verdict が判定する。
//     fix-baseline#i・commit-ensure-status#i・worktree-dirty-check の応答はスクリプトの stdout を stub する
//     （判定の規則そのものは porcelain-verdict.test.mjs）。
//
// harness は test-helpers/vm-sandbox.mjs の makePrIterateSandbox / runWorkflowCapture。round 系 call の応答だけを
// buildAgentStub の rounds で返し、それ以外は pr-iterate 単体起動の既定 responder に任せる。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  makePrIterateSandbox, runWorkflowCapture, assertNoCrash,
  PORCELAIN_BASELINE_DIGEST, porcelainBaselineResponse, porcelainVerdictResponse,
} from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', '.claude/workflows/pr-iterate.js'), 'utf8');
const BIN = join(here, '..', 'bin', 'porcelain-verdict');

/** buildAgentStub の戻り値（rounds と記録先 agentCalls）から pr-iterate.js の vm context を作る。 */
function makeSandbox({ rounds, agentCalls }) {
  return makePrIterateSandbox({ rounds, calls: agentCalls }).ctx;
}

const runPrIterate = (ctx) => runWorkflowCapture(src, ctx, '.claude/workflows/pr-iterate.js');

const DIGEST = PORCELAIN_BASELINE_DIGEST;
const CHECK = `\`porcelain-verdict check ${DIGEST}\``;
// commit-ensure の回収の add: 基準線に無い porcelain 行（新規行）のパスだけを stage する（worktree 全体の `.` は stage しない）。
// commit-ensure-status#i（既定は fix の前が clean で fix の後に ` M a.ts`）の判定からスクリプトが組み立てた add を手順 2 に置く
const DEFAULT_LEFTOVER = porcelainVerdictResponse([' M a.ts'], []);
const ADD_NEW_PATHS = "`git --literal-pathspecs add --ignore-removal -- 'a.ts'`";

/**
 * round 系 call の応答を label で分岐する rounds と、呼び出しの記録先 agentCalls を返す。
 * reviewerStub(label) -> review result（pr-reviewer 呼び出しごとに呼ばれる）
 * ciStub(label) -> CI status result（省略時は常に passed）
 * fixStub(label) -> fix result（省略時は常に applied:true）
 * commitEnsureStub(label) -> commit-ensure#i result（省略時は { dirty: false, committed: false, pushed: false }）
 * dirtyCheckStub(label) -> worktree-dirty-check result（省略時は未 stub 扱い＝null、fail-open）
 * baselineStub(label) -> fix-baseline#i（`porcelain-verdict baseline`）result（省略時は digest を返す）
 * statusStub(label) -> commit-ensure-status#i（`porcelain-verdict check <digest>`）result（省略時は DEFAULT_LEFTOVER）
 */
function buildAgentStub({ reviewerStub, ciStub, fixStub, commitEnsureStub, dirtyCheckStub, baselineStub, statusStub, agentCalls }) {
  const rounds = ({ label, agentType, prompt }) => {
    if (label.startsWith('fix-baseline#')) {
      return baselineStub ? baselineStub(label) : porcelainBaselineResponse();
    }
    if (label.startsWith('commit-ensure-status#')) {
      return statusStub ? statusStub(label) : DEFAULT_LEFTOVER;
    }
    if (agentType === 'dev-flow:pr-reviewer') {
      return reviewerStub(label);
    }
    if (agentType === 'dev-flow:stdout-relay' && prompt.includes('check-ci --pr ')) {
      return ciStub ? ciStub(label) : { status: 'passed', passed: 1, failed: 0, pending: 0, skipped: 0, failed_checks: [] };
    }
    if (label.startsWith('fix#')) {
      return fixStub ? fixStub(label) : { applied: true, summary: 'fixed', files: [] };
    }
    if (label.startsWith('commit-ensure#')) {
      return commitEnsureStub ? commitEnsureStub(label) : { dirty: false, committed: false, pushed: false };
    }
    if (label === 'worktree-dirty-check') {
      return dirtyCheckStub ? dirtyCheckStub(label) : null;
    }
    return undefined;
  };
  return { rounds, agentCalls };
}

/** commit-ensure#i の agent が手順どおりに返す応答（手順 1 / 3 の `porcelain-verdict check` の dirty を写す）。 */
const ensureFrom = (before, after, pushed = true) => (before.dirty
  ? { dirty: true, committed: after.dirty === false, pushed }
  : { dirty: false, committed: false, pushed: false });

// ---- D1 [AC-3]: commit-ensure が dirty:false（正常ケース）-> no-op で継続、lgtm ----
test('[D1][AC-3] fix applied:true + commit-ensure dirty:false -> commit-ensure#1 が判定スクリプトと回収手順を持ち、no-op で lgtm', async () => {
  const agentCalls = [];
  const majorIssue = { severity: 'major', topic: 't1', file: 'a.ts', description: 'd1', suggestion: 's1' };
  let round = 0;
  const reviewerStub = () => {
    round += 1;
    if (round === 1) return { decision: 'request-changes', issues: [majorIssue], summary: 'ng' };
    return { decision: 'approve', issues: [], summary: 'ok' };
  };
  const commitEnsureStub = () => ({ dirty: false, committed: false, pushed: false });
  const agentStub = buildAgentStub({ reviewerStub, commitEnsureStub, agentCalls });
  const ctx = makeSandbox(agentStub);
  const { result, error } = await runPrIterate(ctx);
  assertNoCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

  const commitEnsureCalls = agentCalls.filter((c) => c.label.startsWith('commit-ensure#'));
  assert.equal(commitEnsureCalls.length, 1, `commit-ensure# は 1 回であるべきだが ${commitEnsureCalls.length} 回だった`);
  const commitEnsurePrompt = commitEnsureCalls[0].prompt;
  assert.ok(commitEnsurePrompt.includes(CHECK), `commit-ensure#1 の prompt に ${CHECK} を含むべき。先頭400文字: ${commitEnsurePrompt.slice(0, 400)}`);
  assert.ok(
    commitEnsurePrompt.includes('fix(pr-5)'),
    `commit-ensure#1 の prompt に 'fix(pr-5)' コミットメッセージを含むべき。先頭400文字: ${commitEnsurePrompt.slice(0, 400)}`,
  );
  for (const forbidden of ['ensure-committed.sh', ['~/.claude', 'skills'].join('/'), 'sandbox', 'excludedCommands']) {
    assert.ok(
      !commitEnsurePrompt.includes(forbidden),
      `commit-ensure#1 の prompt は '${forbidden}' を含んではならない。先頭400文字: ${commitEnsurePrompt.slice(0, 400)}`,
    );
  }
  // add / commit / pr-push は cwd で実行する bare 単文。worktree は upstream を持たない（起動元 repo の .git/config は
  // sandbox 内から書けない）ので、push 済みの判定は origin/<head_ref> と比べる
  const gitCmds = commitEnsurePrompt.match(/`git [^`]*`/g) ?? [];
  assert.ok(
    gitCmds.includes(ADD_NEW_PATHS) && commitEnsurePrompt.includes('`git commit -m "fix(pr-5)')
      && commitEnsurePrompt.includes('`pr-push start /tmp/wt/.devflow-tmp/push-output.log`'),
    `commit-ensure#1 の prompt は bare ${ADD_NEW_PATHS} / \`git commit\` / \`pr-push start\` を含むべき: ${gitCmds.join(' | ')}`,
  );
  // 未ステージの削除を stage する add（-A / --all / -u 等）も worktree 全体（.）の add も使わない（issue #875 / #1201）
  assert.deepEqual(gitCmds.filter((c) => / add /.test(c)), [ADD_NEW_PATHS],
    `commit-ensure#1 の add は新規行のパスだけを stage する ${ADD_NEW_PATHS} だけ: ${gitCmds.join(' | ')}`);
  assert.deepEqual(gitCmds.filter((c) => c.includes(' push')), [], `commit-ensure#1 の push は pr-push だけで行う: ${gitCmds.join(' | ')}`);
  assert.ok(
    commitEnsurePrompt.includes('`git -C /tmp/wt rev-list "origin/feature/x"..HEAD --count`'),
    `commit-ensure#1 の push 済み判定は origin/<head_ref> と比べるべき: ${gitCmds.join(' | ')}`,
  );

  assert.equal(result?.status, 'lgtm', `result.status は lgtm であるべきだが '${result?.status}' だった`);
  assert.equal(result?.fix_uncommitted_recovered, 0, `fix_uncommitted_recovered は 0 であるべきだが ${result?.fix_uncommitted_recovered} だった`);
});

// ---- D2 [AC-3 回収]: commit-ensure が dirty:true+committed+pushed -> 継続して lgtm、回収カウンタ加算 ----
test('[D2][AC-3 回収] commit-ensure dirty:true+committed:true+pushed:true -> 継続して lgtm、fix_uncommitted_recovered=1', async () => {
  const agentCalls = [];
  const majorIssue = { severity: 'major', topic: 't1', file: 'a.ts', description: 'd1', suggestion: 's1' };
  let round = 0;
  const reviewerStub = () => {
    round += 1;
    if (round === 1) return { decision: 'request-changes', issues: [majorIssue], summary: 'ng' };
    return { decision: 'approve', issues: [], summary: 'ok' };
  };
  const commitEnsureStub = () => ({ dirty: true, committed: true, pushed: true });
  const agentStub = buildAgentStub({ reviewerStub, commitEnsureStub, agentCalls });
  const ctx = makeSandbox(agentStub);
  const { result, error } = await runPrIterate(ctx);
  assertNoCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

  assert.equal(result?.status, 'lgtm', `result.status は lgtm であるべきだが '${result?.status}' だった`);
  assert.equal(result?.fix_uncommitted_recovered, 1, `fix_uncommitted_recovered は 1 であるべきだが ${result?.fix_uncommitted_recovered} だった`);
});

// ---- D3 [AC-3 fail-safe]: commit-ensure が null -> fix_failed、review#2 は呼ばれない ----
test('[D3][AC-3 fail-safe] commit-ensure が null -> status:fix_failed、review#2 は呼ばれない（pr-reviewer 呼び出し1回）', async () => {
  const agentCalls = [];
  const majorIssue = { severity: 'major', topic: 't1', file: 'a.ts', description: 'd1', suggestion: 's1' };
  const reviewerStub = (label) => {
    if (label === 'review#1') return { decision: 'request-changes', issues: [majorIssue], summary: 'ng' };
    throw new Error(`unexpected pr-reviewer label (review#2 should not run): ${label}`);
  };
  const commitEnsureStub = () => null;
  const agentStub = buildAgentStub({ reviewerStub, commitEnsureStub, agentCalls });
  const ctx = makeSandbox(agentStub);
  const { result, error } = await runPrIterate(ctx);
  assertNoCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

  const reviewerCalls = agentCalls.filter((c) => c.agentType === 'dev-flow:pr-reviewer');
  assert.equal(reviewerCalls.length, 1, `pr-reviewer 呼び出しは 1 回であるべきだが ${reviewerCalls.length} 回だった`);
  assert.equal(result?.status, 'fix_failed', `result.status は fix_failed であるべきだが '${result?.status}' だった`);
});

// ---- D4 [AC-3 fail-safe]: commit-ensure が dirty:true+committed:true+pushed:false（push 失敗）-> fix_failed ----
test('[D4][AC-3 fail-safe] commit-ensure dirty:true+committed:true+pushed:false -> status:fix_failed', async () => {
  const agentCalls = [];
  const majorIssue = { severity: 'major', topic: 't1', file: 'a.ts', description: 'd1', suggestion: 's1' };
  const reviewerStub = (label) => {
    if (label === 'review#1') return { decision: 'request-changes', issues: [majorIssue], summary: 'ng' };
    throw new Error(`unexpected pr-reviewer label: ${label}`);
  };
  const commitEnsureStub = () => ({ dirty: true, committed: true, pushed: false });
  const agentStub = buildAgentStub({ reviewerStub, commitEnsureStub, agentCalls });
  const ctx = makeSandbox(agentStub);
  const { result, error } = await runPrIterate(ctx);
  assertNoCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

  assert.equal(result?.status, 'fix_failed', `result.status は fix_failed であるべきだが '${result?.status}' だった`);
});

// ---- D5 [AC-2]: stuck 終端 + worktree-dirty-check の判定が dirty -> result.worktree_dirty='dirty' ----
test('[D5][AC-2] stuck 終端 + worktree-dirty-check の判定が dirty -> result.worktree_dirty=dirty', async () => {
  const agentCalls = [];
  const majorIssue = { severity: 'major', topic: 't1', file: 'a.ts', description: 'd1', suggestion: 's1' };
  const reviewerStub = () => ({ decision: 'request-changes', issues: [majorIssue], summary: 'still-ng' });
  const commitEnsureStub = () => ({ dirty: false, committed: false, pushed: false });
  const dirtyCheckStub = () => porcelainVerdictResponse([' M a.ts', '?? b.ts'], []);
  const agentStub = buildAgentStub({ reviewerStub, commitEnsureStub, dirtyCheckStub, agentCalls });
  const ctx = makeSandbox(agentStub);
  const { result, error } = await runPrIterate(ctx);
  assertNoCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

  assert.equal(result?.status, 'stuck', `result.status は stuck であるべきだが '${result?.status}' だった`);
  assert.equal(result?.worktree_dirty, 'dirty', `result.worktree_dirty は dirty であるべきだが '${result?.worktree_dirty}' だった`);
  assert.equal(agentCalls.filter((c) => c.label === 'worktree-dirty-check').length, 1, 'stuck 終端では worktree-dirty-check が 1 回呼ばれるべき');
});

// ---- D6 [AC-2 fail-open]: stuck 終端 + worktree-dirty-check probe が null -> worktree_dirty='unknown'、落ちない ----
test('[D6][AC-2 fail-open] stuck 終端 + worktree-dirty-check probe が null -> status:stuck（落ちない）、worktree_dirty=unknown', async () => {
  const agentCalls = [];
  const majorIssue = { severity: 'major', topic: 't1', file: 'a.ts', description: 'd1', suggestion: 's1' };
  const reviewerStub = () => ({ decision: 'request-changes', issues: [majorIssue], summary: 'still-ng' });
  const commitEnsureStub = () => ({ dirty: false, committed: false, pushed: false });
  const dirtyCheckStub = () => null;
  const agentStub = buildAgentStub({ reviewerStub, commitEnsureStub, dirtyCheckStub, agentCalls });
  const ctx = makeSandbox(agentStub);
  const { result, error } = await runPrIterate(ctx);
  assertNoCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

  assert.equal(result?.status, 'stuck', `result.status は stuck であるべきだが '${result?.status}' だった`);
  assert.equal(result?.worktree_dirty, 'unknown', `result.worktree_dirty は unknown であるべきだが '${result?.worktree_dirty}' だった`);
});

// ---- D7 [AC-2 lgtm 非実施]: 正常 lgtm 経路 -> worktree-dirty-check は呼ばれず、worktree_dirty=null ----
test('[D7][AC-2 lgtm 非実施] 正常 lgtm 経路 -> worktree-dirty-check 呼び出し0回、result.worktree_dirty=null', async () => {
  const agentCalls = [];
  const reviewerStub = () => ({ decision: 'approve', issues: [], summary: 'ok' });
  const agentStub = buildAgentStub({ reviewerStub, agentCalls });
  const ctx = makeSandbox(agentStub);
  const { result, error } = await runPrIterate(ctx);
  assertNoCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

  assert.equal(result?.status, 'lgtm', `result.status は lgtm であるべきだが '${result?.status}' だった`);

  const dirtyCheckCalls = agentCalls.filter((c) => c.label === 'worktree-dirty-check');
  assert.equal(dirtyCheckCalls.length, 0, `worktree-dirty-check の呼び出しは 0 回であるべきだが ${dirtyCheckCalls.length} 回だった`);
  assert.equal(result?.worktree_dirty, null, `result.worktree_dirty は null であるべきだが '${result?.worktree_dirty}' だった`);
});

// ---- D8〜D11 / AC-4 (issue #742 / #1284): status の判定は porcelain-verdict が行い、prompt は判定規則を持たない ----
// 警告行（`<path>: Operation not permitted` 等）の除外・基準線との差分・exit 非0 の扱いはスクリプトの規則で、prompt に
// 状態コード表や基準線の行を書くと agent が判定し直し、workflow が同じ判定を数え直す二重化に戻る。

function stepLine(prompt, n) {
  const m = prompt.match(new RegExp(`(?:^|\\n)${n}\\. ([^\\n]*)`));
  return m ? m[1] : '';
}

/** prompt が `porcelain-verdict` を先頭トークンとする bare 単文を指示し、porcelain 行の判定規則を持たないこと。 */
function assertVerdictPrompt(prompt, where, command) {
  assert.ok(prompt.includes(`\`${command}\``), `${where} の prompt は \`${command}\` を指示すべき: ${prompt.slice(0, 600)}`);
  assert.ok(/bare 単文（先頭トークンが porcelain-verdict[。・]/.test(prompt), `${where} の prompt は porcelain-verdict を先頭トークンとする bare 単文を指示すべき: ${prompt.slice(0, 600)}`);
  for (const forbidden of [
    '先頭 2 文字が状態コード', '3 文字目が空白', 'Operation not permitted', '【dirty 判定基準】', '【基準線】',
    '一字一句そのまま porcelain', '先頭の空白を含めて', 'status --porcelain', '"porcelain"', 'porcelain_after',
  ]) {
    assert.ok(!prompt.includes(forbidden), `${where} の prompt に判定規則「${forbidden}」が残っている: ${prompt.slice(0, 600)}`);
  }
}

test('[D8][#742 AC-3] commit-ensure prompt: 手順 1 / 3 は判定スクリプトの dirty で決め、手順 2 で回収する', async () => {
  const agentCalls = [];
  const majorIssue = { severity: 'major', topic: 't1', file: 'a.ts', description: 'd1', suggestion: 's1' };
  let round = 0;
  const reviewerStub = () => {
    round += 1;
    if (round === 1) return { decision: 'request-changes', issues: [majorIssue], summary: 'ng' };
    return { decision: 'approve', issues: [], summary: 'ok' };
  };
  const agentStub = buildAgentStub({ reviewerStub, agentCalls });
  const { error } = await runPrIterate(makeSandbox(agentStub));
  assertNoCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

  const prompt = agentCalls.find((c) => c.label === 'commit-ensure#1')?.prompt ?? '';
  assertVerdictPrompt(prompt, 'commit-ensure#1', `porcelain-verdict check ${DIGEST}`);
  const s1 = stepLine(prompt, 1);
  const s2 = stepLine(prompt, 2);
  const s3 = stepLine(prompt, 3);
  assert.ok(s1.includes(CHECK) && /dirty が false なら dirty:false/.test(s1), `手順 1 は判定スクリプトの dirty:false で dirty:false とすべき: ${s1}`);
  assert.ok(/dirty が true/.test(s2) && s2.includes('dirty:true') && s2.includes(ADD_NEW_PATHS), `手順 2 は dirty:true で新規行のパスの commit/push で回収すべき: ${s2}`);
  assert.ok(s3.includes(CHECK) && /dirty が false なら committed:true/.test(s3) && s3.includes('committed:false'), `手順 3 は判定スクリプトの再実行で committed を決めるべき: ${s3}`);
  // commit-ensure の prompt は sandbox 回避の指示と読まれないよう 'sandbox' を含めない（D1 と同じ制約）
  assert.ok(!prompt.includes('sandbox'), 'commit-ensure#1 の prompt は sandbox を含んではならない');
});

test('[D9][#742 AC-1] 判定スクリプトが clean（commit-ensure dirty:false）-> review#2 に進み lgtm、fix_failed にしない', async () => {
  const agentCalls = [];
  const majorIssue = { severity: 'major', topic: 't1', file: 'a.ts', description: 'd1', suggestion: 's1' };
  const reviewerStub = (label) => {
    if (label === 'review#1') return { decision: 'request-changes', issues: [majorIssue], summary: 'ng' };
    return { decision: 'approve', issues: [], summary: 'ok' };
  };
  const commitEnsureStub = () => ({ dirty: false, committed: false, pushed: false });
  const fixStub = () => ({ applied: true, summary: 'PR 本文を追記', files: [] });
  const agentStub = buildAgentStub({ reviewerStub, fixStub, commitEnsureStub, agentCalls });
  const { result, error } = await runPrIterate(makeSandbox(agentStub));
  assertNoCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

  const reviewLabels = agentCalls.filter((c) => c.agentType === 'dev-flow:pr-reviewer').map((c) => c.label);
  assert.ok(reviewLabels.includes('review#2'), `review#2 に進むべきだが review 呼び出しは ${JSON.stringify(reviewLabels)}`);
  assert.equal(result?.status, 'lgtm', `result.status は lgtm であるべきだが '${result?.status}' だった`);
  assert.equal(result?.fix_uncommitted_recovered, 0);
});

test('[D10][#742 AC-2 fail-safe] 新規行が残り回収できない（dirty:true+committed:false）-> fix_failed、review#2 は呼ばれない', async () => {
  const agentCalls = [];
  const majorIssue = { severity: 'major', topic: 't1', file: 'a.ts', description: 'd1', suggestion: 's1' };
  const reviewerStub = (label) => {
    if (label === 'review#1') return { decision: 'request-changes', issues: [majorIssue], summary: 'ng' };
    throw new Error(`unexpected pr-reviewer label (review#2 should not run): ${label}`);
  };
  const commitEnsureStub = () => ({ dirty: true, committed: false, pushed: true });
  const agentStub = buildAgentStub({ reviewerStub, commitEnsureStub, agentCalls });
  const { result, error } = await runPrIterate(makeSandbox(agentStub));
  assertNoCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

  const reviewerCalls = agentCalls.filter((c) => c.agentType === 'dev-flow:pr-reviewer');
  assert.equal(reviewerCalls.length, 1, `pr-reviewer 呼び出しは 1 回であるべきだが ${reviewerCalls.length} 回だった`);
  assert.equal(result?.status, 'fix_failed', `result.status は fix_failed であるべきだが '${result?.status}' だった`);
  assert.equal(result?.fix_uncommitted_recovered, 0);
});

test('[D11][#742 AC-3] 終端の worktree-dirty-check は判定スクリプトの stdout を返させ、clean なら clean', async () => {
  const agentCalls = [];
  const majorIssue = { severity: 'major', topic: 't1', file: 'a.ts', description: 'd1', suggestion: 's1' };
  const reviewerStub = () => ({ decision: 'request-changes', issues: [majorIssue], summary: 'still-ng' });
  const dirtyCheckStub = () => porcelainVerdictResponse([], []);
  const agentStub = buildAgentStub({ reviewerStub, dirtyCheckStub, agentCalls });
  const { result, error } = await runPrIterate(makeSandbox(agentStub));
  assertNoCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

  assert.equal(result?.status, 'stuck', `result.status は stuck であるべきだが '${result?.status}' だった`);
  assert.equal(result?.worktree_dirty, 'clean');
});

test('[AC-4] fix-baseline#i・commit-ensure-status#i・commit-ensure#i・worktree-dirty-check は porcelain-verdict の bare 単文を指示し、判定規則・基準線の行・porcelain 行の転記を含まない', async () => {
  const agentCalls = [];
  const majorIssue = { severity: 'major', topic: 't1', file: 'a.ts', description: 'd1', suggestion: 's1' };
  const { error } = await runPrIterate(makeSandbox(buildAgentStub({
    reviewerStub: () => ({ decision: 'request-changes', issues: [majorIssue], summary: 'still-ng' }),
    // 基準線にある行（環境が置く未追跡ファイル）。workflow はこの行を知らず、prompt に載せない
    statusStub: () => porcelainVerdictResponse(['?? .worktreeinclude', ' M a.ts'], ['?? .worktreeinclude']),
    dirtyCheckStub: () => porcelainVerdictResponse(['?? .worktreeinclude'], ['?? .worktreeinclude']),
    agentCalls,
  })));
  assertNoCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

  for (const [label, command] of [
    ['fix-baseline#1', 'porcelain-verdict baseline'],
    ['commit-ensure-status#1', `porcelain-verdict check ${DIGEST}`],
    ['commit-ensure#1', `porcelain-verdict check ${DIGEST}`],
    ['worktree-dirty-check', `porcelain-verdict check ${DIGEST}`],
  ]) {
    const call = agentCalls.find((c) => c.label === label);
    assert.ok(call, `${label} が dispatch されていない: ${agentCalls.map((c) => c.label).join(', ')}`);
    assertVerdictPrompt(call.prompt, label, command);
    assert.ok(!call.prompt.includes('.worktreeinclude'), `${label} の prompt に基準線の行が列挙されている`);
  }
  for (const label of ['fix-baseline#1', 'commit-ensure-status#1', 'worktree-dirty-check']) {
    assert.equal(agentCalls.find((c) => c.label === label).agentType, 'dev-flow:dev-runner-haiku-ro', `${label} は読み取り専用 proxy で実行する`);
  }
  // 判定の数え直し（porcelain 行の正規表現・基準線との突き合わせ）を workflow に残さない
  for (const name of ['PORCELAIN_LINE_RE', 'porcelainLinesOf', 'onlyBaselineLines', 'PORCELAIN_DIRTY_RULE', 'porcelainBaselineRule', 'leftoverAddCommand']) {
    assert.ok(!src.includes(name), `pr-iterate.js に ${name} が残っている`);
  }
});

// ---- AC-7: commit は agent の bare 単文に残し、push は pr-push。porcelain-verdict は add・commit・push を実行しない ----
test('[AC-7] commit-ensure#1 の手順 2 は `git commit -m` を bare 単文で持ち、push は pr-push で行う', async () => {
  const agentCalls = [];
  const { error } = await runPrIterate(makeSandbox(buildAgentStub({ reviewerStub: reviewOnceThenApprove, agentCalls })));
  assertNoCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);
  const prompt = agentCalls.find((c) => c.label === 'commit-ensure#1')?.prompt ?? '';
  const s2 = stepLine(prompt, 2);
  assert.ok(s2.includes('`git commit -m "fix(pr-5): commit leftover review fixes (iteration 1)"`'), `手順 2 に git commit -m の bare 単文が無い: ${s2}`);
  assert.ok(s2.includes('`pr-push start /tmp/wt/.devflow-tmp/push-output.log`'), `手順 2 の push は pr-push で行う: ${s2}`);
  assert.ok(/bare 単文（先頭トークンが porcelain-verdict・git・pr-push のいずれか/.test(prompt), `commit-ensure#1 の bare 単文の先頭トークンに git が無い: ${prompt.slice(0, 600)}`);
  assert.doesNotMatch(prompt, /`git (?:[^`]* )?push[ `]/, 'commit-ensure#1 に git push がある');
});

test('[AC-7] porcelain-verdict は git status を 1 回実行するだけで、add・commit・push を実行しない', () => {
  const cli = readFileSync(join(here, '..', '_shared', 'scripts', 'porcelain-verdict.mjs'), 'utf8');
  assert.ok(cli.includes("const STATUS_ARGS = ['status', '--porcelain', '--untracked-files=all']"), 'status の引数が --untracked-files=all でない');
  const calls = cli.match(/\b(?:spawnSync|spawn|execFileSync|execFile|execSync|exec)\(/g) ?? [];
  assert.deepEqual(calls, ['spawnSync('], `子プロセスの起動は status の 1 回だけ: ${calls.join(', ')}`);
  assert.ok(cli.includes("spawnSync('git', STATUS_ARGS, {"), 'spawnSync が status 以外を実行している');
  assert.ok(cli.includes("GIT_OPTIONAL_LOCKS: '0'"), 'status は GIT_OPTIONAL_LOCKS=0 で実行する');
  for (const file of [join(here, '..', 'bin', 'porcelain-verdict'), join(here, '..', '_shared', 'scripts', 'porcelain-verdict.sh')]) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), /\bgit (?:add|commit|push)\b|\bgh\b/, `${file} が add・commit・push・gh を実行している`);
  }
});

// ---- D12 (issue #875 / #1201): 手順 2 の add / commit を実 git で走らせる ----
// 部分 checkout の worktree（取り出していないパスが ` D` で残る）で `git add -A` を走らせると、PR branch に
// 全削除の commit が push される。worktree 全体（.）を stage すると、環境が置いた未追跡ファイルも PR に入る。
// 一時 repo で bin/porcelain-verdict の baseline と check の stdout を fix-baseline#1 / commit-ensure-status#1 の応答にして
// workflow を回し、commit-ensure#1 の手順 2 の add / commit をそのままシェルで実行し、手順 3 の check で確かめる。

/** commit-ensure#1 の prompt の手順 2 から add / commit を取り出す（スクリプトの baseline / check の stdout を応答に使う）。 */
async function commitEnsureStep2Cmds(baselineOut, statusOut) {
  const agentCalls = [];
  const { error } = await runPrIterate(makeSandbox(buildAgentStub({
    reviewerStub: reviewOnceThenApprove,
    baselineStub: () => baselineOut,
    statusStub: () => statusOut,
    agentCalls,
  })));
  assertNoCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);
  const prompt = agentCalls.find((c) => c.label === 'commit-ensure#1')?.prompt ?? '';
  assert.ok(prompt.includes(`\`porcelain-verdict check ${baselineOut.baseline_digest}\``), '手順 1 / 3 は基準線の digest で判定する');
  const s2 = stepLine(prompt, 2);
  const cmds = [...s2.matchAll(/`(git (?:--literal-pathspecs add|commit)[^`]*)`/g)].map((m) => m[1]);
  assert.equal(cmds.length, 2, `手順 2 は add と commit を 1 つずつ持つべき: ${s2}`);
  return cmds;
}

/**
 * 一時 repo を作り、setup（fix の前の状態）→ `porcelain-verdict baseline` → fix（fix の変更）→ `porcelain-verdict check`
 * の stdout から組み立てた手順 2 をシェルで実行し、実行後の HEAD・手順 3 の check・status（基準線ファイルを除く）・
 * probe に挙げた名前のファイルの有無を返す。
 */
async function step2Result({ setup, fix }, probe = []) {
  const dir = mkdtempSync(join(tmpdir(), 'commit-ensure-'));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const sh = (cmd) => execFileSync('sh', ['-c', cmd], { cwd: dir, env, encoding: 'utf8' });
  const verdictCli = (...args) => JSON.parse(execFileSync('bash', [BIN, ...args], { cwd: dir, env, encoding: 'utf8' }));
  try {
    sh('git init -q && git config user.name t && git config user.email t@example.com');
    writeFileSync(join(dir, 'kept.txt'), 'kept\n');
    writeFileSync(join(dir, 'fixed.txt'), 'before\n');
    sh('git add -A && git commit -q -m init');
    setup(dir, sh);
    const baseline = verdictCli('baseline');
    fix(dir, sh);
    const cmds = await commitEnsureStep2Cmds(baseline, verdictCli('check', baseline.baseline_digest));
    for (const cmd of cmds) sh(cmd);
    return {
      tree: sh('git ls-tree -r -z --name-only HEAD').split('\0').filter(Boolean),
      fixed: sh('git show HEAD:fixed.txt'),
      after: verdictCli('check', baseline.baseline_digest),
      status: sh('git status --porcelain --untracked-files=all').split('\n').filter((l) => l && !l.includes('.devflow-tmp/')),
      present: Object.fromEntries(probe.map((n) => [n, existsSync(join(dir, n))])),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('[D12][#875 AC-3] 基準線に無い未ステージの削除: 手順 2 の add / commit は削除を commit せず、手順 3 の判定に新規行が残る', async () => {
  const r = await step2Result({
    setup: () => {},
    fix: (dir) => {
      unlinkSync(join(dir, 'kept.txt'));               // 取り出していないパス（未ステージの削除）
      writeFileSync(join(dir, 'fixed.txt'), 'after\n'); // fix の未コミット変更
    },
  });
  assert.ok(r.tree.includes('kept.txt'), '未ステージの削除が commit された');
  assert.equal(r.fixed, 'after\n', 'fix の変更は commit で回収されるべき');
  assert.deepEqual(r.status, [' D kept.txt'], '削除は未ステージのまま status に残るべき');
  assert.deepEqual([r.after.dirty, r.after.new_lines], [true, [' D kept.txt']], '手順 3 の判定は dirty（committed:false）');
});

test('[D12b][#1201 AC-3] 基準線にある未追跡ファイル・未ステージの削除: 手順 2 は新規行のパスだけを commit し、手順 3 の判定は clean', async () => {
  const r = await step2Result({
    setup: (dir) => {
      writeFileSync(join(dir, '.worktreeinclude'), 'env\n'); // 環境が worktree に置く未追跡ファイル
      unlinkSync(join(dir, 'kept.txt'));                     // 部分 checkout の未ステージの削除
    },
    fix: (dir) => {
      writeFileSync(join(dir, 'fixed.txt'), 'after\n');
      writeFileSync(join(dir, 'added.txt'), 'new\n');
    },
  });
  assert.ok(!r.tree.includes('.worktreeinclude'), '基準線にある未追跡ファイルが PR ブランチに commit された');
  assert.ok(r.tree.includes('kept.txt'), '基準線にある未ステージの削除が commit された');
  assert.ok(r.tree.includes('added.txt'), 'fix が足した未追跡ファイルは commit で回収されるべき');
  assert.ok(!r.tree.some((p) => p.startsWith('.devflow-tmp/')), `基準線ファイルが commit された: ${r.tree.join(', ')}`);
  assert.equal(r.fixed, 'after\n', 'fix の変更は commit で回収されるべき');
  assert.deepEqual(new Set(r.status), new Set(['?? .worktreeinclude', ' D kept.txt']), `回収後の status は基準線の行だけになるべき: ${JSON.stringify(r.status)}`);
  assert.equal(r.after.dirty, false, `手順 3 の判定は clean（committed:true）: ${JSON.stringify(r.after)}`);
});

test('[D12c][#1201 AC-3] PR が名付けたファイル名はシェルでも pathspec でも解釈されず、リテラルなパスとして stage される', async () => {
  const injected = '$(touch pwned).md';
  const r = await step2Result({
    setup: (dir) => writeFileSync(join(dir, 'secret.env'), 'TOKEN=x\n'), // 基準線にある未追跡ファイル
    fix: (dir) => {
      writeFileSync(join(dir, 'fixed.txt'), 'after\n');
      writeFileSync(join(dir, injected), 'x\n');   // コマンド置換を含む名前
      writeFileSync(join(dir, ':!x.md'), 'x\n');   // 除外 pathspec の形の名前
      writeFileSync(join(dir, "it's.md"), 'x\n');  // 単一引用符を含む名前
      writeFileSync(join(dir, '日本 語.md'), 'x\n');  // status が C 形式（8 進）で引用する名前
    },
  }, ['pwned']);
  assert.equal(r.present.pwned, false, 'ファイル名のコマンド置換が実行された');
  assert.ok(!r.tree.includes('secret.env'), '基準線にある未追跡ファイルが pathspec magic で stage された');
  for (const name of [injected, ':!x.md', "it's.md", '日本 語.md']) assert.ok(r.tree.includes(name), `${name} が commit で回収されていない: ${r.tree.join(', ')}`);
  assert.equal(r.fixed, 'after\n', 'fix の変更は commit で回収されるべき');
  assert.deepEqual(r.status, ['?? secret.env'], `回収後の status は基準線の行だけになるべき: ${JSON.stringify(r.status)}`);
  assert.equal(r.after.dirty, false);
});

test('[D12d][#1201 AC-3] 基準線の未追跡ファイルと同じディレクトリで fix が追跡ファイルを消して未追跡ファイルを足しても、基準線のファイルは stage されない', async () => {
  const r = await step2Result({
    setup: (dir, sh) => {
      mkdirSync(join(dir, 'd'));
      writeFileSync(join(dir, 'd', 'tracked.txt'), 't\n');
      sh('git add d/tracked.txt && git commit -q -m d');
      writeFileSync(join(dir, 'd', 'secret.env'), 'TOKEN=x\n'); // 基準線にある未追跡ファイル
    },
    fix: (dir, sh) => {
      sh('git rm -q d/tracked.txt');                       // 追跡ファイルの削除を stage
      writeFileSync(join(dir, 'd', 'new.txt'), 'n\n');      // 同じディレクトリに未追跡の置換ファイル
      writeFileSync(join(dir, 'fixed.txt'), 'after\n');
    },
  });
  assert.ok(!r.tree.includes('d/secret.env'), `基準線にある未追跡ファイルがディレクトリごと stage された: ${r.tree.join(', ')}`);
  assert.ok(r.tree.includes('d/new.txt') && !r.tree.includes('d/tracked.txt'), `fix の変更が回収されていない: ${r.tree.join(', ')}`);
  assert.deepEqual(r.status, ['?? d/secret.env'], `回収後の status は基準線の行だけになるべき: ${JSON.stringify(r.status)}`);
  assert.equal(r.after.dirty, false);
});

// ---- D13〜D18 (issue #1201 / #1284): fix#i の前の基準線（digest）に無い行だけを fix の残りと数える ----
const ENV_FILE = '?? .worktreeinclude';
const majorIssue1201 = { severity: 'major', topic: 't1', file: 'a.ts', description: 'd1', suggestion: 's1' };
function reviewOnceThenApprove(label) {
  return label === 'review#1'
    ? { decision: 'request-changes', issues: [majorIssue1201], summary: 'ng' }
    : { decision: 'approve', issues: [], summary: 'ok' };
}
const reviewers = (calls) => calls.filter((c) => c.agentType === 'dev-flow:pr-reviewer').map((c) => c.label);

test('[D13][#1201 AC-1/AC-6] fix の前後の porcelain 行がどちらも基準線の行だけ -> ensured で review#2 へ（回収に数えない）', async () => {
  const agentCalls = [];
  const before = porcelainVerdictResponse([ENV_FILE], [ENV_FILE]);
  const agentStub = buildAgentStub({
    reviewerStub: reviewOnceThenApprove,
    statusStub: () => before,
    commitEnsureStub: () => ensureFrom(before, before),
    agentCalls,
  });
  const { result, error } = await runPrIterate(makeSandbox(agentStub));
  assertNoCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

  // fix#1 の spawn 前に読み取り専用 proxy で基準線を取り、その digest で commit-ensure#1 が判定する
  const labels = agentCalls.map((c) => c.label);
  const baselineCall = agentCalls.find((c) => c.label === 'fix-baseline#1');
  assert.ok(baselineCall, `fix-baseline#1 が dispatch されていない: ${labels.join(', ')}`);
  assert.equal(baselineCall.agentType, 'dev-flow:dev-runner-haiku-ro', 'fix-baseline は読み取り専用 proxy で取る');
  assert.ok(labels.indexOf('fix-baseline#1') < labels.indexOf('fix#1'), `fix-baseline#1 は fix#1 の前: ${labels.join(', ')}`);

  assert.ok(reviewers(agentCalls).includes('review#2'), `review#2 に進むべき: ${JSON.stringify(reviewers(agentCalls))}`);
  assert.notEqual(result?.fix_terminal_reason, 'commit_unensured', 'commit_unensured で止めてはならない');
  assert.equal(result?.status, 'lgtm', `result.status は lgtm であるべきだが '${result?.status}' だった`);
  assert.equal(result?.fix_uncommitted_recovered, 0, '基準線の行しか無い round は回収に数えない');
});

test('[D14][#1201 AC-7 回収] 基準線に無い行が fix 後に増え、回収後は基準線の行だけが残る -> 回収して review#2 へ', async () => {
  const agentCalls = [];
  const before = porcelainVerdictResponse([ENV_FILE, ' M a.ts'], [ENV_FILE]);
  const after = porcelainVerdictResponse([ENV_FILE], [ENV_FILE]);
  const agentStub = buildAgentStub({
    reviewerStub: reviewOnceThenApprove,
    statusStub: () => before,
    commitEnsureStub: () => ensureFrom(before, after),
    agentCalls,
  });
  const { result, error } = await runPrIterate(makeSandbox(agentStub));
  assertNoCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

  assert.ok(stepLine(agentCalls.find((c) => c.label === 'commit-ensure#1')?.prompt ?? '', 2).includes(ADD_NEW_PATHS), '新規行のパスだけを add する');
  assert.ok(reviewers(agentCalls).includes('review#2'), `review#2 に進むべき: ${JSON.stringify(reviewers(agentCalls))}`);
  assert.equal(result?.status, 'lgtm');
  assert.equal(result?.fix_uncommitted_recovered, 1, '新規行を回収した round は回収に数える');
});

test('[D15][#1201 AC-7 fail-safe] 基準線に無い行が回収後も残る -> fix_failed（commit_unensured）、review#2 は呼ばれない', async () => {
  const agentCalls = [];
  const before = porcelainVerdictResponse([ENV_FILE, ' D kept.txt'], [ENV_FILE]);
  const agentStub = buildAgentStub({
    reviewerStub: reviewOnceThenApprove,
    statusStub: () => before,
    commitEnsureStub: () => ensureFrom(before, before),
    agentCalls,
  });
  const { result, error } = await runPrIterate(makeSandbox(agentStub));
  assertNoCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

  assert.deepEqual(reviewers(agentCalls), ['review#1']);
  assert.equal(result?.status, 'fix_failed');
  assert.equal(result?.fix_terminal_reason, 'commit_unensured');
});

for (const [name, baselineStub] of [
  ['null', () => null],
  ['exit 非0', () => ({ exit_code: 128, baseline_digest: null })],
  ['throw', () => { throw new Error('StructuredOutput 未返却'); }],
]) {
  test(`[D16][#1201 AC-4 fail-safe] 基準線を取れない（${name}）-> digest を渡さず全 porcelain 行で判定し、回収せず commit_unensured で止める`, async () => {
    const agentCalls = [];
    const noBaseline = porcelainVerdictResponse([ENV_FILE], null);
    const agentStub = buildAgentStub({
      reviewerStub: reviewOnceThenApprove,
      baselineStub,
      commitEnsureStub: () => ensureFrom(noBaseline, noBaseline),
      agentCalls,
    });
    const { result, error } = await runPrIterate(makeSandbox(agentStub));
    assertNoCrash(error);
    if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

    const ensurePrompt = agentCalls.find((c) => c.label === 'commit-ensure#1')?.prompt ?? '';
    assert.ok(stepLine(ensurePrompt, 1).includes('`porcelain-verdict check`'), `基準線なしの commit-ensure は digest を渡さない: ${stepLine(ensurePrompt, 1)}`);
    assert.ok(!agentCalls.some((c) => c.label === 'commit-ensure-status#1'), '基準線を取れない round は回収の判定を読まない');
    assert.deepEqual(reviewers(agentCalls), ['review#1']);
    assert.equal(result?.status, 'fix_failed');
    assert.equal(result?.fix_terminal_reason, 'commit_unensured');
  });
}

// 基準線が null なら add が fix の前からある未追跡ファイルも stage し、基準線に stage 済みの行があれば commit が index ごと
// fix の前の変更を PR に入れる。基準線ファイルが digest と一致しない round は fix の後に基準線を書き換えられている。
// どの round も add・commit・push を指示せず、agent が回収済みと申告しても止める
const MISMATCH = porcelainVerdictResponse([' M a.ts'], [], { mismatch: true });
for (const [name, baselineStub, statusStub] of [
  ['基準線なし', () => null, undefined],
  ['基準線に stage 済みの行', undefined, () => porcelainVerdictResponse([' M a.ts', 'A  secret.env', ENV_FILE], ['A  secret.env', ENV_FILE])],
  ['digest 不一致（基準線 null）', undefined, () => MISMATCH],
  ['digest 不一致なのに recoverable:true と転記', undefined, () => ({ ...MISMATCH, recoverable: true, add_command: "git --literal-pathspecs add --ignore-removal -- 'a.ts'" })],
]) {
  test(`[D18][#1201 AC-4 / #1284 AC-8] ${name} -> 回収の add・commit・push を指示せず、新規行があれば commit_unensured で止める`, async () => {
    const agentCalls = [];
    const agentStub = buildAgentStub({
      reviewerStub: reviewOnceThenApprove,
      baselineStub,
      statusStub,
      commitEnsureStub: () => ({ dirty: true, committed: true, pushed: true }),
      agentCalls,
    });
    const { result, error } = await runPrIterate(makeSandbox(agentStub));
    assertNoCrash(error);
    if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

    const s2 = stepLine(agentCalls.find((c) => c.label === 'commit-ensure#1')?.prompt ?? '', 2);
    assert.ok(!/`git (?:[^`]* )?(?:add|commit|push)[ `]/.test(s2), `手順 2 に回収の git コマンドがある: ${s2}`);
    assert.ok(!s2.includes('pr-push'), `手順 2 に push がある: ${s2}`);
    assert.deepEqual(reviewers(agentCalls), ['review#1']);
    assert.equal(result?.status, 'fix_failed');
    assert.equal(result?.fix_terminal_reason, 'commit_unensured');
  });
}

test('[D19] 判定スクリプトの add_command が引用の外に文字を持つ形なら add を指示しない', async () => {
  const agentCalls = [];
  const tampered = { ...DEFAULT_LEFTOVER, add_command: "git --literal-pathspecs add --ignore-removal -- 'a.ts'; touch pwned" };
  const { error } = await runPrIterate(makeSandbox(buildAgentStub({ reviewerStub: reviewOnceThenApprove, statusStub: () => tampered, agentCalls })));
  assertNoCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);
  const s2 = stepLine(agentCalls.find((c) => c.label === 'commit-ensure#1')?.prompt ?? '', 2);
  assert.ok(!s2.includes('pwned') && !/`git [^`]*add/.test(s2), `引用の外に文字を持つ add を指示した: ${s2}`);
  assert.ok(s2.includes('add は実行しない'), s2);
});

test('[D17][#1201 AC-5 / #1284 AC-8] 基準線の digest は fix-baseline の応答だけから取り、終端の worktree-dirty-check は run の最初の基準線で判定する', async () => {
  const D1 = '1'.repeat(64);
  const D2 = '2'.repeat(64);
  const FIXER = 'f'.repeat(64);
  // round ごとに別 topic の指摘を返し（stuck にしない）、fix#2 が applied:false で fix_failed 終端にする
  const runTwoFixes = async (dirtyPorcelain) => {
    const agentCalls = [];
    let n = 0;
    const agentStub = buildAgentStub({
      reviewerStub: () => ({ decision: 'request-changes', issues: [{ ...majorIssue1201, topic: `t${++n}` }], summary: 'ng' }),
      // fix agent が返り値に digest を載せても使わない
      fixStub: (label) => (label === 'fix#1'
        ? { applied: true, summary: 'fixed', files: [], baseline_digest: FIXER }
        : { applied: false, summary: 'cannot', files: [], baseline_digest: FIXER }),
      baselineStub: (label) => porcelainBaselineResponse(label === 'fix-baseline#1' ? D1 : D2),
      // スクリプトは最初の基準線（D1 の行 = ENV_FILE）と突き合わせて判定する
      dirtyCheckStub: () => porcelainVerdictResponse(dirtyPorcelain, [ENV_FILE]),
      agentCalls,
    });
    const { result, error } = await runPrIterate(makeSandbox(agentStub));
    assertNoCrash(error);
    if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);
    assert.equal(result?.status, 'fix_failed');
    assert.deepEqual(agentCalls.filter((c) => c.label.startsWith('fix-baseline#')).map((c) => c.label), ['fix-baseline#1', 'fix-baseline#2'], '基準線は fix ごとに取る');
    const promptOf = (label) => agentCalls.find((c) => c.label === label)?.prompt ?? '';
    for (const label of ['commit-ensure-status#1', 'commit-ensure#1']) {
      assert.ok(promptOf(label).includes(`\`porcelain-verdict check ${D1}\``), `${label} は fix-baseline#1 の digest で判定する`);
    }
    // 2 回目の基準線には前の round の残りが入りうる。終端は最初の基準線だけを使う
    assert.ok(promptOf('worktree-dirty-check').includes(`\`porcelain-verdict check ${D1}\``), `worktree-dirty-check は最初の基準線の digest で判定する: ${promptOf('worktree-dirty-check').slice(0, 600)}`);
    assert.ok(!agentCalls.some((c) => c.prompt.includes(FIXER)), 'fix agent の返り値の digest が prompt に渡った');
    return result;
  };
  assert.equal((await runTwoFixes([ENV_FILE])).worktree_dirty, 'clean', '最初の基準線にある行だけなら clean');
  assert.equal((await runTwoFixes([ENV_FILE, ' M a.ts'])).worktree_dirty, 'dirty', '最初の基準線に無い行が残れば dirty');
});

test('[#1284 AC-8] workflow は digest を fix-baseline#i の応答からだけ取り、worktree 内の基準線ファイルを読ませない', () => {
  const assigns = (name) => [...src.matchAll(new RegExp(`(?<!let )\\b${name} = [^\\n]*`, 'g'))].map((m) => m[0]);
  assert.deepEqual(assigns('fixBaselineDigest'), ['fixBaselineDigest = await takeFixBaseline(i)']);
  assert.deepEqual(assigns('runBaselineDigest'), ['runBaselineDigest = fixBaselineDigest']);
  assert.ok(!src.includes('.devflow-tmp/porcelain-baseline'), 'workflow が基準線ファイルのパスを参照している');
  const fn = src.slice(src.indexOf('async function takeFixBaseline('), src.indexOf('const porcelainVerdictCommand'));
  assert.ok(fn.includes("label: `fix-baseline#${i}`") && fn.includes('r.baseline_digest'), 'takeFixBaseline は fix-baseline#i の応答の baseline_digest を返す');
});
