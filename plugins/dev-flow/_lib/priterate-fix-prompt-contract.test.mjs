// _lib/priterate-fix-prompt-contract.test.mjs
// pr-iterate の fix agent prompt（review 指摘の fix_loop と CI 失敗の ci_gate の両経路）が subagent dispatch の
// 必須 5 要素（Objective / Output format / Tools / Boundary / Token cap）を持ち、Boundary が worktree の外・他 repo への
// 書き込み、ブランチ作成、gh api での変更を禁止していることを pin する（issue #793）。Output format は全経路で
// deferred_security_topics を返させる（issue #1121）。
//   (a) fix_loop の fix#1 prompt（VM で実 prompt を観測）
//   (b) ci_gate の fix#1 prompt（同上）
//   (c) 静的: callFixAgent に渡す prompt は fixPrompt() で組んだものだけ（5 要素を持たない prompt を足させない）
//   (d)(e) fix#1 / commit-ensure#1 の push は timeout: 600000 指定・run_in_background 禁止・再発行禁止（issue #804）

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makePrIterateSandbox, runWorkflowCapture, assertNoCrash } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const prIterateSrc = readFileSync(join(here, '..', '.claude/workflows/pr-iterate.js'), 'utf8');

const SECTIONS = ['## Objective', '## Output format', '## Tools', '## Boundary', '## Token cap'];

async function fixPromptOf(overrides) {
  const { ctx, calls } = makePrIterateSandbox({ overrides });
  const { error } = await runWorkflowCapture(prIterateSrc, ctx, '.claude/workflows/pr-iterate.js');
  assertNoCrash(error, 'fix-prompt-contract');
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  const fix = calls.find((c) => c.label === 'fix#1');
  assert.ok(fix, `fix#1 が dispatch されていない: ${calls.map((c) => c.label).join(', ')}`);
  return fix.prompt;
}

function sectionOf(prompt, heading) {
  const start = prompt.indexOf(heading);
  const next = prompt.indexOf('\n## ', start + heading.length);
  return prompt.slice(start, next === -1 ? undefined : next);
}

function assertFiveElements(prompt, label) {
  for (const h of SECTIONS) assert.ok(prompt.includes(`${h}\n`), `${label}: ${h} が無い。prompt: ${prompt}`);
  const order = SECTIONS.map((h) => prompt.indexOf(h));
  assert.deepEqual([...order].sort((a, b) => a - b), order, `${label}: 5 要素の順序が崩れている`);
  const output = sectionOf(prompt, '## Output format');
  assert.match(output, /"applied": boolean/);
  // security の指摘が無い fix（CI だけの fix を含む）にも deferred_security_topics を返させ、空の配列にさせる（issue #1121）
  assert.ok(output.includes('"deferred_security_topics": string[]'), `${label}: Output format に deferred_security_topics が無い: ${output}`);
  assert.ok(output.includes('security review の指摘が無い fix・全部直した fix では空の配列 [] にする（省略しない）'), `${label}: 空の配列にさせる指示が無い: ${output}`);
  assert.match(sectionOf(prompt, '## Tools'), /使用可:/);
  assert.match(sectionOf(prompt, '## Token cap'), /summary は \d+ 字以内/);
  const boundary = sectionOf(prompt, '## Boundary');
  assert.ok(boundary.includes('worktree（/tmp/wt）の中だけ'), `${label}: Boundary に worktree の絶対パスが無い: ${boundary}`);
  assert.match(boundary, /他 repo/);
  assert.match(boundary, /ブランチを作らない/);
  assert.match(boundary, /git worktree add/);
  assert.match(boundary, /`gh api` で GitHub 上の状態を変更しない/);
  assert.match(boundary, /worktree の外の変更が要る指摘は直さず/);
}

test('[fix-prompt-contract] (a) fix_loop の fix#1 prompt は必須 5 要素を持ち、Boundary で worktree 外・他 repo・ブランチ作成・gh api を禁止する', async () => {
  const prompt = await fixPromptOf({
    'review#1': { decision: 'request-changes', issues: [{ severity: 'major', topic: 't', file: 'src/a.js', line: 1, description: 'null を握りつぶしている', suggestion: '' }], summary: 'ng' },
    'fix#1': { applied: false, files: [], summary: 'stop' },
  });
  assertFiveElements(prompt, 'fix_loop');
  assert.match(sectionOf(prompt, '## Objective'), /PR #5 のレビュー指摘を修正/);
  assert.ok(prompt.includes('null を握りつぶしている'), '指摘本文が prompt に届いていない');
});

test('[fix-prompt-contract] (b) ci_gate の fix#1 prompt も同じ 5 要素と Boundary を持つ', async () => {
  const prompt = await fixPromptOf({
    'ci-check#1': { status: 'failed', passed: 0, failed: 1, pending: 0, skipped: 0, failed_checks: [{ name: 'bats', bucket: 'fail', state: 'FAILURE' }] },
    'fix#1': { applied: false, files: [], summary: 'stop' },
  });
  assertFiveElements(prompt, 'ci_gate');
  assert.match(sectionOf(prompt, '## Objective'), /PR #5 の CI 失敗を修正/);
  assert.ok(prompt.includes('ci::bats'), 'CI 失敗が prompt に届いていない');
});

// push は Bash timeout: 600000 指定・run_in_background 禁止・再発行禁止（issue #804）
function assertPushRule(prompt, label) {
  assert.ok(prompt.includes('Bash tool の `timeout: 600000` を指定して実行'), `${label}: push の timeout: 600000 指定が無い: ${prompt}`);
  assert.ok(prompt.includes('`run_in_background` は使わない（禁止）'), `${label}: run_in_background 禁止が無い`);
  assert.ok(prompt.includes('push の結果が返るまで次の手順を実行しない'), `${label}: push 完了待ちの指示が無い`);
  assert.ok(prompt.includes('push を再発行しない（timeout・background 化した場合も含む）'), `${label}: push 再発行禁止が無い`);
  assert.ok(prompt.includes('600 秒の timeout に達した場合もリトライしない'), `${label}: timeout 到達時のリトライ禁止が無い`);
}

test('[fix-prompt-contract] (d) fix_loop / ci_gate の fix#1 prompt は push に timeout: 600000 を指定させ、background 化・再発行を禁じ、timeout は applied:false で中断させる', async () => {
  const prompts = {
    fix_loop: await fixPromptOf({
      'review#1': { decision: 'request-changes', issues: [{ severity: 'major', topic: 't', file: 'src/a.js', line: 1, description: 'd', suggestion: '' }], summary: 'ng' },
      'fix#1': { applied: false, files: [], summary: 'stop' },
    }),
    ci_gate: await fixPromptOf({
      'ci-check#1': { status: 'failed', passed: 0, failed: 1, pending: 0, skipped: 0, failed_checks: [{ name: 'bats', bucket: 'fail', state: 'FAILURE' }] },
      'fix#1': { applied: false, files: [], summary: 'stop' },
    }),
  };
  for (const [label, prompt] of Object.entries(prompts)) {
    const steps = sectionOf(prompt, '## Steps');
    assertPushRule(steps, label);
    assert.ok(steps.indexOf('`git push origin HEAD`') < steps.indexOf('timeout: 600000'), `${label}: push 規約が git push 手順の後に無い`);
    // 作業ツリーは PR head の branch で用意済み。checkout させず（.git/config に追跡設定を書く）、そのまま修正させる
    assert.ok(steps.includes('作業ツリー（/tmp/wt）は PR ブランチ（`feature/x`）を checkout 済み。branch を切り替えずに、(1) 下記の'), `${label}: checkout 済み前提の手順になっていない: ${steps}`);
    assert.doesNotMatch(prompt, /gh pr checkout/, `${label}: fix prompt が gh pr checkout を指示している`);
    assert.ok(steps.includes('timeout に達した場合はそこで中断し、applied:false とし、summary に timeout に達した旨と push の stderr 末尾を書く'), `${label}: timeout 到達時の報告指示が無い: ${steps}`);
  }
});

test('[fix-prompt-contract] (e) commit-ensure#1 prompt の push も timeout: 600000 指定・background 化と再発行の禁止を持ち、失敗・timeout でも再発行しない', async () => {
  const { ctx, calls } = makePrIterateSandbox({
    overrides: {
      'review#1': { decision: 'request-changes', issues: [{ severity: 'major', topic: 't', file: 'src/a.js', line: 1, description: 'd', suggestion: '' }], summary: 'ng' },
    },
  });
  const { error } = await runWorkflowCapture(prIterateSrc, ctx, '.claude/workflows/pr-iterate.js');
  assertNoCrash(error, 'fix-prompt-contract commit-ensure');
  const ensure = calls.find((c) => c.label === 'commit-ensure#1');
  assert.ok(ensure, `commit-ensure#1 が dispatch されていない: ${calls.map((c) => c.label).join(', ')}`);
  const steps = sectionOf(ensure.prompt, '## Steps');
  assertPushRule(steps, 'commit-ensure');
  assert.ok(steps.includes('`git push origin HEAD`（失敗・timeout でも再発行せず手順 3 へ進む）'), `commit-ensure: push 失敗・timeout 時に再発行しない指示が無い: ${steps}`);
});

test('[fix-prompt-contract] (c) 静的: callFixAgent に渡す prompt は fixPrompt() で組んだ 2 つだけ', () => {
  const callSites = [...prIterateSrc.matchAll(/await callFixAgent\((\w+), i\)/g)].map((m) => m[1]);
  assert.deepEqual(callSites.sort(), ['ciFixPrompt', 'reviewFixPrompt']);
  for (const name of callSites) {
    assert.match(prIterateSrc, new RegExp(`const ${name} = fixPrompt\\(\\{`), `${name} が fixPrompt() で組まれていない`);
  }
  const def = prIterateSrc.slice(prIterateSrc.indexOf('function fixPrompt('), prIterateSrc.indexOf('const reviewSeen ='));
  for (const h of SECTIONS) assert.ok(def.includes(h), `fixPrompt() の定義に ${h} が無い`);
});
