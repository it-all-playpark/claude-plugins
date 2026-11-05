// F3: pr-iterate の終端 dirty 検出（AC-2）と fix 適用直後の commit 保証（AC-3）の routing test（issue #437）
//   - fix 適用（applied:true）直後、ensure-committed.sh を exec-proxy で実行し worktree の未コミット変更を
//     検証する。dirty:false は no-op で継続、dirty:true で commit+push が成功すれば継続（回収カウンタ加算）、
//     null/schema 不一致/回収失敗（committed&&pushed でない）は fail-safe で terminal:'fix_failed'。
//   - status !== 'lgtm' の終端でのみ、worktree-dirty-check（--check-only）の advisory probe を実行する。
//     probe 失敗は fail-open（'unknown' + 警告のみ）。lgtm 終端では probe しない（agent 呼び出し追加ゼロ）。
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
import { makePrIterateSandbox, runWorkflowCapture, assertNoCrash } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', '.claude/workflows/pr-iterate.js'), 'utf8');

/** buildAgentStub の戻り値（rounds と記録先 agentCalls）から pr-iterate.js の vm context を作る。 */
function makeSandbox({ rounds, agentCalls }) {
  return makePrIterateSandbox({ rounds, calls: agentCalls }).ctx;
}

const runPrIterate = (ctx) => runWorkflowCapture(src, ctx, '.claude/workflows/pr-iterate.js');

// commit-ensure の回収の add: 基準線に無い porcelain 行（新規行）のパスだけを stage する（worktree 全体の `.` は stage しない）。
// パスは commit-ensure-status#i（既定は ` M a.ts`）から workflow が単一引用符の引数に組み立て、pathspec magic を無効にする
const DEFAULT_LEFTOVER = { exit_code: 0, porcelain: [' M a.ts'] };
const CLEAN_BASELINE = { exit_code: 0, porcelain: [] };
const ADD_NEW_PATHS ="`git --literal-pathspecs add --ignore-removal -- 'a.ts'`";

/**
 * round 系 call の応答を label で分岐する rounds と、呼び出しの記録先 agentCalls を返す。
 * reviewerStub(label) -> review result（pr-reviewer 呼び出しごとに呼ばれる）
 * ciStub(label) -> CI status result（省略時は常に passed）
 * fixStub(label) -> fix result（省略時は常に applied:true）
 * commitEnsureStub(label) -> commit-ensure（--pr --iteration）result（省略時は { dirty: false, committed: false, pushed: false }）
 * dirtyCheckStub(label) -> worktree-dirty-check（--check-only）result（省略時は未 stub 扱い＝null、fail-open）
 * baselineStub(label) -> fix-baseline#i（fix 前の porcelain 行）result（省略時は CLEAN_BASELINE ＝ fix 前は clean）
 * statusStub(label) -> commit-ensure-status#i（fix 後の porcelain 行）result（省略時は DEFAULT_LEFTOVER）
 */
function buildAgentStub({ reviewerStub, ciStub, fixStub, commitEnsureStub, dirtyCheckStub, baselineStub, statusStub, agentCalls }) {
  const rounds = ({ label, agentType, prompt }) => {
    if (label.startsWith('fix-baseline#')) {
      return baselineStub ? baselineStub(label) : CLEAN_BASELINE;
    }
    if (label.startsWith('commit-ensure-status#')) {
      return statusStub ? statusStub(label) : DEFAULT_LEFTOVER;
    }
    if (agentType === 'dev-flow:pr-reviewer') {
      return reviewerStub(label);
    }
    if (agentType === 'dev-flow:dev-runner-haiku-ro' && prompt.includes('check-ci --checks-data')) {
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

// ---- D1 [AC-3]: commit-ensure が dirty:false（正常ケース）-> no-op で継続、lgtm ----
test('[D1][AC-3] fix applied:true + commit-ensure dirty:false -> commit-ensure#1 が --pr --iteration 1 で呼ばれ、no-op で lgtm', async () => {
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
  assert.ok(
    commitEnsurePrompt.includes('git') && commitEnsurePrompt.includes('status --porcelain'),
    `commit-ensure#1 の prompt に 'git' と 'status --porcelain' を含むべき。先頭400文字: ${commitEnsurePrompt.slice(0, 400)}`,
  );
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
  // add / commit / push は cwd で実行する bare 単文。worktree は upstream を持たない（起動元 repo の .git/config は
  // sandbox 内から書けない）ので、push は remote と HEAD を明示し、push 済みの判定は origin/<head_ref> と比べる
  const gitCmds = commitEnsurePrompt.match(/`git [^`]*`/g) ?? [];
  assert.ok(
    gitCmds.includes(ADD_NEW_PATHS) && commitEnsurePrompt.includes('`git commit -m "fix(pr-5)')
      && gitCmds.includes('`git push origin HEAD`'),
    `commit-ensure#1 の prompt は bare ${ADD_NEW_PATHS} / \`git commit\` / \`git push origin HEAD\` を含むべき: ${gitCmds.join(' | ')}`,
  );
  // 未ステージの削除を stage する add（-A / --all / -u 等）も worktree 全体（.）の add も使わない（issue #875 / #1201）
  assert.deepEqual(gitCmds.filter((c) => / add /.test(c)), [ADD_NEW_PATHS],
    `commit-ensure#1 の add は新規行のパスだけを stage する ${ADD_NEW_PATHS} だけ: ${gitCmds.join(' | ')}`);
  assert.deepEqual([...new Set(gitCmds.filter((c) => c.includes(' push')))], ['`git push origin HEAD`'],
    `commit-ensure#1 の push は \`git push origin HEAD\` だけ（-u を付けない）: ${gitCmds.join(' | ')}`);
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

// ---- D5 [AC-2]: stuck 終端 + worktree-dirty-check dirty:true -> result.worktree_dirty='dirty' ----
test('[D5][AC-2] stuck 終端 + worktree-dirty-check dirty:true -> result.worktree_dirty=dirty', async () => {
  const agentCalls = [];
  const majorIssue = { severity: 'major', topic: 't1', file: 'a.ts', description: 'd1', suggestion: 's1' };
  const reviewerStub = () => ({ decision: 'request-changes', issues: [majorIssue], summary: 'still-ng' });
  const commitEnsureStub = () => ({ dirty: false, committed: false, pushed: false });
  const dirtyCheckStub = () => ({ dirty: true, files: 2 });
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

// ---- D8〜D11 (issue #742): git status --porcelain の dirty 判定は porcelain 行の有無で行う ----
// sandbox 内では読めないファイル（.env.example 等）について git が `<path>: Operation not permitted` を
// stderr に出し、agent の Bash 出力では stdout と混ざる。「出力が空か」で判定すると警告行だけの clean な
// worktree を dirty と読み、commit-ensure が fix_failed で終端する。

function stepLine(prompt, n) {
  const m = prompt.match(new RegExp(`(?:^|\\n)${n}\\. ([^\\n]*)`));
  return m ? m[1] : '';
}

function assertPorcelainRule(prompt, where) {
  assert.ok(prompt.includes('porcelain 行'), `${where} の prompt は porcelain 行で判定すべき: ${prompt.slice(0, 600)}`);
  assert.ok(
    prompt.includes('先頭 2 文字が状態コード') && prompt.includes('3 文字目が空白'),
    `${where} の prompt は porcelain 行の形（先頭 2 文字が状態コード＋空白）を明記すべき: ${prompt.slice(0, 600)}`,
  );
  assert.ok(
    prompt.includes('Operation not permitted') && prompt.includes('数えない'),
    `${where} の prompt は \`: Operation not permitted\` 等の警告行を数えないと明記すべき: ${prompt.slice(0, 600)}`,
  );
  assert.ok(
    /警告行だけが出ていて porcelain 行が 0 行なら[^。]*clean/.test(prompt),
    `${where} の prompt は警告行だけのとき clean と明記すべき: ${prompt.slice(0, 600)}`,
  );
  assert.ok(
    /porcelain 行が 1 行以上あれば[^。]*dirty/.test(prompt),
    `${where} の prompt は porcelain 行が 1 行以上なら dirty と明記すべき: ${prompt.slice(0, 600)}`,
  );
  assert.ok(
    /exit 非0[^。]*dirty/.test(prompt),
    `${where} の prompt は exit 非0 を dirty 側に倒すべき（fail-safe）: ${prompt.slice(0, 600)}`,
  );
  for (const forbidden of ['出力が空なら', '出力が空でなければ', '出力が非空なら', '非空行数']) {
    assert.ok(!prompt.includes(forbidden), `${where} の prompt に「${forbidden}」基準が残っている: ${prompt.slice(0, 600)}`);
  }
}

test('[D8][#742 AC-3] commit-ensure prompt: 手順 1 / 3 の dirty 判定が porcelain 行の有無で、警告行は数えない', async () => {
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
  assertPorcelainRule(prompt, 'commit-ensure#1');
  const s1 = stepLine(prompt, 1);
  const s2 = stepLine(prompt, 2);
  const s3 = stepLine(prompt, 3);
  assert.ok(
    s1.includes('status --porcelain') && /新規行が 0 行[^。]*dirty:false/.test(s1),
    `手順 1 は新規行（基準線に無い porcelain 行）0 行で dirty:false とすべき: ${s1}`,
  );
  assert.ok(
    /新規行が 1 行以上/.test(s2) && s2.includes('dirty:true') && s2.includes(ADD_NEW_PATHS),
    `手順 2 は新規行 1 行以上で dirty:true とし、新規行のパスの commit/push で回収すべき: ${s2}`,
  );
  assert.ok(
    s3.includes('status --porcelain') && s3.includes('手順 1 と同じ判定基準')
      && /新規行が 0 行[^。]*committed:true/.test(s3) && /dirty なので committed:false/.test(s3),
    `手順 3 は手順 1 と同じ基準で committed を判定すべき: ${s3}`,
  );
  // commit-ensure の prompt は sandbox 回避の指示と読まれないよう 'sandbox' を含めない（D1 と同じ制約）
  assert.ok(!prompt.includes('sandbox'), 'commit-ensure#1 の prompt は sandbox を含んではならない');
});

test('[D9][#742 AC-1] 警告行だけの clean worktree（commit-ensure dirty:false）-> review#2 に進み lgtm、fix_failed にしない', async () => {
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

test('[D10][#742 AC-2 fail-safe] porcelain 行が残り回収できない（dirty:true+committed:false）-> fix_failed、review#2 は呼ばれない', async () => {
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

test('[D11][#742 AC-3] 終端の worktree-dirty-check prompt も porcelain 行の有無で判定し、files は porcelain 行数', async () => {
  const agentCalls = [];
  const majorIssue = { severity: 'major', topic: 't1', file: 'a.ts', description: 'd1', suggestion: 's1' };
  const reviewerStub = () => ({ decision: 'request-changes', issues: [majorIssue], summary: 'still-ng' });
  const dirtyCheckStub = () => ({ dirty: false, files: 0 });
  const agentStub = buildAgentStub({ reviewerStub, dirtyCheckStub, agentCalls });
  const { result, error } = await runPrIterate(makeSandbox(agentStub));
  assertNoCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

  assert.equal(result?.status, 'stuck', `result.status は stuck であるべきだが '${result?.status}' だった`);
  assert.equal(result?.worktree_dirty, 'clean');
  const prompt = agentCalls.find((c) => c.label === 'worktree-dirty-check')?.prompt ?? '';
  assertPorcelainRule(prompt, 'worktree-dirty-check');
  assert.ok(prompt.includes('<新規行の行数>'), `files は新規行（基準線に無い porcelain 行）の行数を返すべき: ${prompt.slice(0, 600)}`);
});

// ---- D12 (issue #875 / #1201): 手順 2 の add / commit を実 git で走らせる ----
// 部分 checkout の worktree（取り出していないパスが ` D` で残る）で `git add -A` を走らせると、PR branch に
// 全削除の commit が push される。worktree 全体（.）を stage すると、環境が置いた未追跡ファイルも PR に入る。
// 一時 repo の基準線と fix 後の status を fix-baseline#1 / commit-ensure-status#1 の応答にして workflow を回し、
// commit-ensure#1 の手順 2 の add / commit をそのままシェルで実行して確かめる。

/** commit-ensure#1 の prompt の手順 2 から add / commit を取り出す（基準線と fix 後の porcelain 行を応答に使う）。 */
async function commitEnsureStep2Cmds(baselineLines, afterLines) {
  const agentCalls = [];
  const majorIssue = { severity: 'major', topic: 't1', file: 'a.ts', description: 'd1', suggestion: 's1' };
  const reviewerStub = (label) => (label === 'review#1'
    ? { decision: 'request-changes', issues: [majorIssue], summary: 'ng' }
    : { decision: 'approve', issues: [], summary: 'ok' });
  const { error } = await runPrIterate(makeSandbox(buildAgentStub({
    reviewerStub,
    baselineStub: () => ({ exit_code: 0, porcelain: baselineLines }),
    statusStub: () => ({ exit_code: 0, porcelain: afterLines }),
    agentCalls,
  })));
  assertNoCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);
  const s2 = stepLine(agentCalls.find((c) => c.label === 'commit-ensure#1')?.prompt ?? '', 2);
  const cmds = [...s2.matchAll(/`(git (?:--literal-pathspecs add|commit)[^`]*)`/g)].map((m) => m[1]);
  assert.equal(cmds.length, 2, `手順 2 は add と commit を 1 つずつ持つべき: ${s2}`);
  return cmds;
}

/**
 * 一時 repo を作り、setup（fix の前の状態）→ 基準線の status → fix（fix の変更）→ fix 後の status から組み立てた
 * 手順 2 をシェルで実行し、実行後の HEAD と status（probe に挙げた名前のファイルの有無）を返す。
 */
async function step2Result({ setup, fix }, probe = []) {
  const dir = mkdtempSync(join(tmpdir(), 'commit-ensure-'));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const sh = (cmd) => execFileSync('sh', ['-c', cmd], { cwd: dir, env, encoding: 'utf8' });
  const statusLines = () => sh('git status --porcelain --untracked-files=all').split('\n').filter(Boolean);
  try {
    sh('git init -q && git config user.name t && git config user.email t@example.com');
    writeFileSync(join(dir, 'kept.txt'), 'kept\n');
    writeFileSync(join(dir, 'fixed.txt'), 'before\n');
    sh('git add -A && git commit -q -m init');
    setup(dir, sh);
    const baseline = new Set(statusLines());
    fix(dir, sh);
    const cmds = await commitEnsureStep2Cmds([...baseline], statusLines());
    for (const cmd of cmds) sh(cmd);
    return {
      tree: sh('git ls-tree -r -z --name-only HEAD').split('\0').filter(Boolean),
      fixed: sh('git show HEAD:fixed.txt'),
      status: statusLines(),
      baseline,
      present: Object.fromEntries(probe.map((n) => [n, existsSync(join(dir, n))])),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('[D12][#875 AC-3] 基準線に無い未ステージの削除: 手順 2 の add / commit は削除を commit せず、status に新規行が残る', async () => {
  const r = await step2Result({
    setup: () => {},
    fix: (dir) => {
      unlinkSync(join(dir, 'kept.txt'));               // 取り出していないパス（未ステージの削除）
      writeFileSync(join(dir, 'fixed.txt'), 'after\n'); // fix の未コミット変更
    },
  });
  assert.ok(r.tree.includes('kept.txt'), '未ステージの削除が commit された');
  assert.equal(r.fixed, 'after\n', 'fix の変更は commit で回収されるべき');
  assert.deepEqual(r.status, [' D kept.txt'], '削除は未ステージのまま status に残るべき（手順 3 で dirty → committed:false）');
});

test('[D12b][#1201 AC-3] 基準線にある未追跡ファイル・未ステージの削除: 手順 2 は新規行のパスだけを commit し、基準線の行は status に残る', async () => {
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
  assert.equal(r.fixed, 'after\n', 'fix の変更は commit で回収されるべき');
  assert.ok(r.status.length > 0 && r.status.every((l) => r.baseline.has(l)),
    `回収後の status は基準線の行だけになるべき（手順 3 で committed:true）: ${JSON.stringify(r.status)}`);
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
});

test('[D12e][#1201 AC-3] status の probe は未追跡ファイルを個別に列挙させ、ディレクトリの行（?? d/）は回収の add に並べない', async () => {
  const agentCalls = [];
  const { error } = await runPrIterate(makeSandbox(buildAgentStub({
    reviewerStub: (label) => (label === 'review#1'
      ? { decision: 'request-changes', issues: [{ severity: 'major', topic: 't1', file: 'a.ts', description: 'd1', suggestion: 's1' }], summary: 'ng' }
      : { decision: 'approve', issues: [], summary: 'ok' }),
    baselineStub: () => ({ exit_code: 0, porcelain: ['?? d/secret.env'] }),
    statusStub: () => ({ exit_code: 0, porcelain: ['?? d/', ' M fixed.txt'] }),
    agentCalls,
  })));
  assertNoCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);
  for (const label of ['fix-baseline#1', 'commit-ensure-status#1', 'commit-ensure#1']) {
    const p = agentCalls.find((c) => c.label === label)?.prompt ?? '';
    assert.ok(p.includes('status --porcelain --untracked-files=all'), `${label} は --untracked-files=all で status を取るべき`);
    assert.ok(!/status --porcelain(?! --untracked-files=all)/.test(p), `${label} に --untracked-files=all の無い status がある`);
  }
  const s2 = stepLine(agentCalls.find((c) => c.label === 'commit-ensure#1')?.prompt ?? '', 2);
  const add = s2.match(/`(git --literal-pathspecs add[^`]*)`/)?.[1] ?? '';
  assert.ok(add.includes("'fixed.txt'") && !add.includes("'d/'"), `ディレクトリの行を add に並べてはならない: ${add}`);
});

test('[D12f][#1201 AC-3] rename の宛先が引用内に ` -> ` を含んでも、基準線の未追跡ファイルを add に並べない（rename / copy 行は並べない）', async () => {
  const agentCalls = [];
  const { error } = await runPrIterate(makeSandbox(buildAgentStub({
    reviewerStub: (label) => (label === 'review#1'
      ? { decision: 'request-changes', issues: [{ severity: 'major', topic: 't1', file: 'a.ts', description: 'd1', suggestion: 's1' }], summary: 'ng' }
      : { decision: 'approve', issues: [], summary: 'ok' }),
    baselineStub: () => ({ exit_code: 0, porcelain: ['?? secret.env"'] }),
    statusStub: () => ({ exit_code: 0, porcelain: ['?? secret.env"', 'RM old -> "x -> secret.env"', ' M fixed.txt'] }),
    agentCalls,
  })));
  assertNoCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);
  const s2 = stepLine(agentCalls.find((c) => c.label === 'commit-ensure#1')?.prompt ?? '', 2);
  const add = s2.match(/`(git --literal-pathspecs add[^`]*)`/)?.[1] ?? '';
  assert.ok(add.includes("'fixed.txt'"), `新規行の通常のパスは add に並べるべき: ${add}`);
  assert.ok(!add.includes('secret.env') && !add.includes("'old'"), `rename / copy 行のパスを add に並べてはならない: ${add}`);
});

// ---- D13〜D17 (issue #1201): fix#i の前の porcelain 行を基準線にし、基準線に無い行だけを fix の残りと数える ----
const ENV_FILE = '?? .worktreeinclude';
const majorIssue1201 = { severity: 'major', topic: 't1', file: 'a.ts', description: 'd1', suggestion: 's1' };
const reviewOnceThenApprove = (label) => (label === 'review#1'
  ? { decision: 'request-changes', issues: [majorIssue1201], summary: 'ng' }
  : { decision: 'approve', issues: [], summary: 'ok' });
const reviewers = (calls) => calls.filter((c) => c.agentType === 'dev-flow:pr-reviewer').map((c) => c.label);

test('[D13][#1201 AC-1/AC-6] 基準線と fix 後の porcelain がどちらも ?? .worktreeinclude で fix が commit・push 済み -> commit_unensured で止めず review#2 へ', async () => {
  const agentCalls = [];
  const agentStub = buildAgentStub({
    reviewerStub: reviewOnceThenApprove,
    baselineStub: () => ({ exit_code: 0, porcelain: [ENV_FILE] }),
    // 基準線を使わない判定の返り値（fix の後の porcelain 行 1 行で dirty、回収の add 後も同じ行が残る）
    commitEnsureStub: () => ({ dirty: true, committed: false, pushed: true, porcelain: [ENV_FILE], porcelain_after: [ENV_FILE] }),
    agentCalls,
  });
  const { result, error } = await runPrIterate(makeSandbox(agentStub));
  assertNoCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

  // AC-1: fix#1 の spawn 前に読み取り専用 proxy で基準線を取り、commit-ensure#1 に渡す
  const labels = agentCalls.map((c) => c.label);
  const baselineCall = agentCalls.find((c) => c.label === 'fix-baseline#1');
  assert.ok(baselineCall, `fix-baseline#1 が dispatch されていない: ${labels.join(', ')}`);
  assert.equal(baselineCall.agentType, 'dev-flow:dev-runner-haiku-ro', 'fix-baseline は読み取り専用 proxy で取る');
  assert.ok(labels.indexOf('fix-baseline#1') < labels.indexOf('fix#1'), `fix-baseline#1 は fix#1 の前: ${labels.join(', ')}`);
  assert.ok(baselineCall.prompt.includes('status --porcelain'), 'fix-baseline は git status --porcelain を読む');
  assertPorcelainRule(baselineCall.prompt, 'fix-baseline#1');
  const ensurePrompt = agentCalls.find((c) => c.label === 'commit-ensure#1')?.prompt ?? '';
  assert.ok(ensurePrompt.includes(JSON.stringify([ENV_FILE])), `commit-ensure#1 の prompt に基準線の行が無い: ${ensurePrompt.slice(0, 900)}`);

  // AC-2 / AC-6
  assert.ok(reviewers(agentCalls).includes('review#2'), `review#2 に進むべき: ${JSON.stringify(reviewers(agentCalls))}`);
  assert.notEqual(result?.fix_terminal_reason, 'commit_unensured', 'commit_unensured で止めてはならない');
  assert.equal(result?.status, 'lgtm', `result.status は lgtm であるべきだが '${result?.status}' だった`);
  assert.equal(result?.fix_uncommitted_recovered, 0, '基準線の行しか無い round は回収に数えない');
});

test('[D14][#1201 AC-7 回収] 基準線に無い行が fix 後に増え、回収後は基準線の行だけが残る -> 回収して review#2 へ', async () => {
  const agentCalls = [];
  const agentStub = buildAgentStub({
    reviewerStub: reviewOnceThenApprove,
    baselineStub: () => ({ exit_code: 0, porcelain: [ENV_FILE] }),
    commitEnsureStub: () => ({ dirty: true, committed: false, pushed: true, porcelain: [ENV_FILE, ' M a.ts'], porcelain_after: [ENV_FILE] }),
    agentCalls,
  });
  const { result, error } = await runPrIterate(makeSandbox(agentStub));
  assertNoCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

  assert.ok(reviewers(agentCalls).includes('review#2'), `review#2 に進むべき: ${JSON.stringify(reviewers(agentCalls))}`);
  assert.equal(result?.status, 'lgtm');
  assert.equal(result?.fix_uncommitted_recovered, 1, '新規行を回収した round は回収に数える');
});

test('[D15][#1201 AC-7 fail-safe] 基準線に無い行が回収後も残る -> fix_failed（commit_unensured）、review#2 は呼ばれない', async () => {
  const agentCalls = [];
  const agentStub = buildAgentStub({
    reviewerStub: reviewOnceThenApprove,
    baselineStub: () => ({ exit_code: 0, porcelain: [ENV_FILE] }),
    commitEnsureStub: () => ({ dirty: true, committed: false, pushed: true, porcelain: [ENV_FILE, ' D kept.txt'], porcelain_after: [ENV_FILE, ' D kept.txt'] }),
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
  ['exit 非0', () => ({ exit_code: 128, porcelain: [ENV_FILE] })],
  ['throw', () => { throw new Error('StructuredOutput 未返却'); }],
]) {
  test(`[D16][#1201 AC-4 fail-safe] 基準線を取れない（${name}）-> fix 後の全 porcelain 行で判定し commit_unensured で止める`, async () => {
    const agentCalls = [];
    const agentStub = buildAgentStub({
      reviewerStub: reviewOnceThenApprove,
      baselineStub,
      commitEnsureStub: () => ({ dirty: true, committed: false, pushed: true, porcelain: [ENV_FILE], porcelain_after: [ENV_FILE] }),
      agentCalls,
    });
    const { result, error } = await runPrIterate(makeSandbox(agentStub));
    assertNoCrash(error);
    if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

    const ensurePrompt = agentCalls.find((c) => c.label === 'commit-ensure#1')?.prompt ?? '';
    assert.ok(ensurePrompt.includes('porcelain 行はすべて新規行'), `基準線なしの commit-ensure は全 porcelain 行を新規行にする: ${ensurePrompt.slice(0, 900)}`);
    assert.deepEqual(reviewers(agentCalls), ['review#1']);
    assert.equal(result?.status, 'fix_failed');
    assert.equal(result?.fix_terminal_reason, 'commit_unensured');
  });
}

// 基準線が null なら add が fix の前からある未追跡ファイルも stage し、基準線に stage 済みの行があれば commit が index ごと
// fix の前の変更を PR に入れる。どちらの round も add・commit・push を指示せず、agent が回収済みと申告しても止める
for (const [name, baselineStub] of [
  ['基準線なし', () => null],
  ['基準線に stage 済みの行', () => ({ exit_code: 0, porcelain: ['A  secret.env', ENV_FILE] })],
]) {
  test(`[D18][#1201 AC-4] ${name} -> 回収の add・commit・push を指示せず、新規行があれば commit_unensured で止める`, async () => {
    const agentCalls = [];
    const agentStub = buildAgentStub({
      reviewerStub: reviewOnceThenApprove,
      baselineStub,
      commitEnsureStub: () => ({ dirty: true, committed: true, pushed: true, porcelain: [' M a.ts'], porcelain_after: [] }),
      agentCalls,
    });
    const { result, error } = await runPrIterate(makeSandbox(agentStub));
    assertNoCrash(error);
    if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

    const s2 = stepLine(agentCalls.find((c) => c.label === 'commit-ensure#1')?.prompt ?? '', 2);
    assert.ok(!/`git (?:[^`]* )?(?:add|commit|push)[ `]/.test(s2), `手順 2 に回収の git コマンドがある: ${s2}`);
    assert.deepEqual(reviewers(agentCalls), ['review#1']);
    assert.equal(result?.status, 'fix_failed');
    assert.equal(result?.fix_terminal_reason, 'commit_unensured');
  });
}

test('[D17][#1201 AC-5] 終端の worktree-dirty-check は run の最初の fix の前の基準線にある行を dirty に数えない', async () => {
  // round ごとに別 topic の指摘を返し（stuck にしない）、fix#2 が applied:false で fix_failed 終端にする
  const runTwoFixes = async (dirtyPorcelain) => {
    const agentCalls = [];
    let n = 0;
    const agentStub = buildAgentStub({
      reviewerStub: () => ({ decision: 'request-changes', issues: [{ ...majorIssue1201, topic: `t${++n}` }], summary: 'ng' }),
      fixStub: (label) => (label === 'fix#1' ? { applied: true, summary: 'fixed', files: [] } : { applied: false, summary: 'cannot', files: [] }),
      // 2 回目の基準線には前の round の残り（' M a.ts'）が入りうる。終端は最初の基準線だけを使う
      baselineStub: (label) => ({ exit_code: 0, porcelain: label === 'fix-baseline#1' ? [ENV_FILE] : [ENV_FILE, ' M a.ts'] }),
      dirtyCheckStub: () => ({ dirty: true, files: dirtyPorcelain.length, porcelain: dirtyPorcelain }),
      agentCalls,
    });
    const { result, error } = await runPrIterate(makeSandbox(agentStub));
    assertNoCrash(error);
    if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);
    assert.equal(result?.status, 'fix_failed');
    assert.deepEqual(agentCalls.filter((c) => c.label.startsWith('fix-baseline#')).map((c) => c.label), ['fix-baseline#1', 'fix-baseline#2'], '基準線は fix ごとに取る');
    const prompt = agentCalls.find((c) => c.label === 'worktree-dirty-check')?.prompt ?? '';
    assert.ok(prompt.includes(JSON.stringify([ENV_FILE])), `worktree-dirty-check の prompt に最初の基準線が無い: ${prompt.slice(0, 900)}`);
    return result;
  };
  assert.equal((await runTwoFixes([ENV_FILE])).worktree_dirty, 'clean', '最初の基準線にある行だけなら clean');
  assert.equal((await runTwoFixes([ENV_FILE, ' M a.ts'])).worktree_dirty, 'dirty', '最初の基準線に無い行が残れば dirty');
});
