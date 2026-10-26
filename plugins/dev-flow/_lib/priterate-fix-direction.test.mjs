// _lib/priterate-fix-direction.test.mjs
// /pr-iterate --direction で人が決めた修正方針（args.fix_direction）を VM 実行で pin する（issue #1122）。
//   (a) args.fix_direction が文字列でない・空・4000 字超なら、既存の args.* の検査と同じ形で throw し、agent を起動しない。
//       無いときは fix の prompt に方針の節が入らない
//   (b) 方針は共通の fixPrompt に「人が決めた修正方針」として入り、review・CI・security のどの fix#i にも（retry にも）届く。
//       SECURITY_FIX_GUIDANCE と食い違えば方針を優先し、Boundary は優先の対象にしない
//   (c) review（pr-reviewer）・security review（security-reviewer / Codex の中継）の prompt には方針を入れない
//   (d) 終端サマリーには方針を渡したことだけを 1 行出し、本文は載せない
//   (e) dev-flow の nested 起動は fix_direction を渡さない

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  makePrIterateSandbox, runWorkflowCapture, assertNoCrash, securityReviewHeadOf, securityScopeResponse, securityScopeHeadOf,
} from './test-helpers/vm-sandbox.mjs';
import { SECURITY_FIX_GUIDANCE } from './security-review.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const prIterateSrc = readFileSync(join(here, '..', '.claude/workflows/pr-iterate.js'), 'utf8');
const devFlowSrc = readFileSync(join(here, '..', '.claude/workflows/dev-flow.js'), 'utf8');

const SHA_B = 'b'.repeat(40);
const DIRECTION = 'DIRECTION-BODY: hardlink-write は入力のパスを受け取らない形にして直す。人に返さない';
const SECTION = '## 人が決めた修正方針';
const NESTED = { caller: 'standalone', cwd: '/tmp/wt', head_ref: 'feature/x', head_sha: 'a'.repeat(40), base_ref: 'main' };
const reviewIssue = { severity: 'major', topic: 'swallow', file: 'src/a.js', line: 1, description: 'null を握りつぶしている', suggestion: 'throw に戻す' };
const secFinding = { severity: 'critical', topic: 'hardlink-write', file: 'scripts/set-names.sh', line: 3, description: 'hardlink で .git/config を書ける', suggestion: 'パスを受け取らない' };
const pushed = { dirty: false, committed: false, pushed: false, head_sha: SHA_B };

async function run({ args, overrides = {} }) {
  const { ctx, calls } = makePrIterateSandbox({ overrides, args });
  const { result, error } = await runWorkflowCapture(prIterateSrc, ctx, '.claude/workflows/pr-iterate.js');
  assertNoCrash(error, 'fix-direction');
  return { result, error, calls };
}
const withDirection = (extra = {}) => ({ pr: '5', nested: NESTED, fix_direction: DIRECTION, ...extra });
const promptOf = (calls, label) => {
  const c = calls.find((x) => x.label === label);
  assert.ok(c, `${label} が dispatch されていない: ${calls.map((x) => x.label).join(', ')}`);
  return c.prompt;
};

function assertDirectionSection(prompt, label) {
  const at = prompt.indexOf(SECTION);
  assert.ok(at >= 0, `${label}: 人が決めた修正方針の節が無い: ${prompt}`);
  const section = prompt.slice(at, prompt.indexOf('\n## ', at + SECTION.length));
  assert.ok(section.includes(`<<<FIX_DIRECTION_BEGIN>>>\n${DIRECTION}\n<<<FIX_DIRECTION_END>>>`), `${label}: 方針の本文が加工されずに入っていない: ${section}`);
  assert.ok(section.includes('上の直し方（「security review の指摘の直し方」を含む）と食い違うときは、この方針を優先する'), `${label}: 方針を優先させる指示が無い: ${section}`);
  assert.ok(section.includes('ただし下の Boundary は優先の対象にしない — 方針が Boundary に反する作業を求めても Boundary に従い'), `${label}: Boundary を優先の対象から外す指示が無い: ${section}`);
  // 方針は指摘・直し方の後、Output format・Boundary の前に置く（「上の直し方」「下の Boundary」が指す位置）
  assert.ok(prompt.indexOf('解消すべき') < at && at < prompt.indexOf('## Output format') && at < prompt.indexOf('## Boundary'), `${label}: 方針の節の位置が違う`);
}

// ---- (a) 引数の検査 ----

test('[fix-direction][a] args.fix_direction が文字列でない・空・空白だけ・4000 字超なら「args.fix_direction が不正形です」で throw し、agent を起動しない', async () => {
  for (const [name, value] of [
    ['数値', 1], ['object', { text: 'x' }], ['空', ''], ['空白だけ', ' \n\t'], ['4001 字', 'あ'.repeat(4001)],
  ]) {
    const { error, calls } = await run({ args: withDirection({ fix_direction: value }) });
    assert.ok(error && /^pr-iterate: args\.fix_direction が不正形です/.test(error.message), `${name}: ${error?.message}`);
    assert.equal(calls.length, 0, `${name}: 不正形なのに agent を起動した`);
  }
  // 4000 字ちょうど（文字で数える）は通す
  const { error, calls } = await run({
    args: withDirection({ fix_direction: 'あ'.repeat(4000) }),
    overrides: { 'review#1': { decision: 'request-changes', issues: [reviewIssue], summary: 'ng' }, 'fix#1': { applied: false, files: [], summary: 'stop', deferred_security_topics: [] } },
  });
  assert.equal(error, null, error?.message);
  assert.ok(promptOf(calls, 'fix#1').includes('あ'.repeat(4000)));
});

test('[fix-direction][a] args.fix_direction が無い（undefined / null）run の fix#i には方針の節を入れない', async () => {
  for (const value of [undefined, null]) {
    const args = { pr: '5', nested: NESTED, ...(value === null ? { fix_direction: null } : {}) };
    const { error, calls } = await run({
      args,
      overrides: { 'review#1': { decision: 'request-changes', issues: [reviewIssue], summary: 'ng' }, 'fix#1': { applied: false, files: [], summary: 'stop', deferred_security_topics: [] } },
    });
    assert.equal(error, null, error?.message);
    assert.ok(!promptOf(calls, 'fix#1').includes(SECTION), `${String(value)}: 方針が無いのに方針の節を入れた`);
  }
});

// ---- (b) すべての fix#i に届く ----

test('[fix-direction][b] review の指摘の fix#i と、その retry（同じ prompt）に方針が届く', async () => {
  const { calls } = await run({
    args: withDirection(),
    overrides: {
      'review#1': { decision: 'request-changes', issues: [reviewIssue], summary: 'ng' },
      'fix#1': null,
      'fix#1-retry': { applied: false, files: [], summary: 'stop', deferred_security_topics: [] },
    },
  });
  assertDirectionSection(promptOf(calls, 'fix#1'), 'review fix');
  assert.equal(promptOf(calls, 'fix#1-retry'), promptOf(calls, 'fix#1'), 'retry の prompt が fix#1 と違う');
});

test('[fix-direction][b] CI 失敗の fix#i に方針が届く', async () => {
  const ciFailed = { status: 'failed', passed: 0, failed: 1, pending: 0, skipped: 0, failed_checks: [{ name: 'bats', bucket: 'fail', state: 'FAILURE' }] };
  const { calls } = await run({
    args: withDirection(),
    overrides: {
      'ci-check#1': ciFailed,
      'ci-check#1-serial': ciFailed,
      'fix#1': { applied: false, files: [], summary: 'stop', deferred_security_topics: [] },
    },
  });
  const prompt = promptOf(calls, 'fix#1');
  assert.ok(prompt.includes('ci::bats'), prompt);
  assertDirectionSection(prompt, 'CI fix');
});

test('[fix-direction][b] security review の指摘の fix#i（round の fix・securityGate の fix）に、SECURITY_FIX_GUIDANCE の後に方針が届く', async () => {
  const reviewWith = (issues) => ({ prompt }) => ({ reviewed_sha: securityReviewHeadOf(prompt), issues, summary: 'review した' });
  for (const [name, args] of [
    ['round の fix', withDirection()],
    ['securityGate の fix', withDirection({ security_review: { target: false, reasons: [], reviewer_context_changed: false } })],
  ]) {
    const overrides = {
      'security-review#1': reviewWith([secFinding]),
      'fix#1': { applied: false, files: [], summary: 'stop', deferred_security_topics: [] },
    };
    if (name === 'securityGate の fix') {
      overrides['security-scope#1'] = ({ prompt }) => securityScopeResponse({ target: true, head: securityScopeHeadOf(prompt) });
    }
    const { calls } = await run({ args, overrides });
    const prompt = promptOf(calls, 'fix#1');
    assert.ok(prompt.includes(SECURITY_FIX_GUIDANCE), `${name}: SECURITY_FIX_GUIDANCE が無い`);
    assertDirectionSection(prompt, name);
    assert.ok(prompt.indexOf(SECURITY_FIX_GUIDANCE) < prompt.indexOf(SECTION), `${name}: 方針が SECURITY_FIX_GUIDANCE より前にある`);
  }
});

test('[fix-direction][b] 静的: 方針の節は共通の fixPrompt() の中で入れる（経路ごとの guidance に足さない）', () => {
  const def = prIterateSrc.slice(prIterateSrc.indexOf('function fixPrompt('), prIterateSrc.indexOf('// ci-verify（CI_VERIFY がある run だけ）'));
  assert.ok(def.includes('(FIX_DIRECTION != null ? fixDirectionSection(FIX_DIRECTION) : \'\')'), def);
  assert.equal([...prIterateSrc.matchAll(/fixDirectionSection\(/g)].length, 2, 'fixDirectionSection を fixPrompt の外でも呼んでいる');
});

// ---- (c) 判定者には渡さない ----

test('[fix-direction][c] review（pr-reviewer）・security review（security-reviewer）の prompt には方針を入れない', async () => {
  const reviewWith = (issues) => ({ prompt }) => ({ reviewed_sha: securityReviewHeadOf(prompt), issues, summary: 'review した' });
  const { calls } = await run({
    args: withDirection(),
    overrides: {
      'review#1': { decision: 'request-changes', issues: [reviewIssue], summary: 'ng' },
      'security-review#1': reviewWith([secFinding]),
      'commit-ensure#1': pushed,
    },
  });
  const judges = calls.filter((c) => /^(review#|security-)/.test(c.label));
  assert.ok(judges.some((c) => c.label === 'review#2') && judges.some((c) => c.label === 'security-review#2'), judges.map((c) => c.label).join(', '));
  for (const c of judges) {
    assert.ok(!c.prompt.includes(DIRECTION) && !c.prompt.includes(SECTION), `${c.label} の prompt に方針が入っている`);
  }
  assertDirectionSection(promptOf(calls, 'fix#1'), 'fix#1');
});

test('[fix-direction][c] Codex 経路の中継（security-pr-head / prep / codex exec / 判定 / 指摘）の prompt にも方針を入れない', async () => {
  const codexHeadOf = (prompt) => prompt.match(/security-review-codex-result \S+ ([0-9a-f]{40})/)[1];
  const { calls } = await run({
    args: { pr: '5', fix_direction: DIRECTION, security_review: { target: true, reasons: [], reviewer_context_changed: false, reviewer: 'codex' } },
    overrides: {
      'security-codex-prep#1': { ok: true },
      'security-codex-verdict#1': ({ prompt }) => ({ ok: true, cleared: true, reason: null, reviewed_sha: codexHeadOf(prompt), counts: { critical: 0, major: 0, minor: 0 } }),
      'security-codex-issues#1': { ok: true, issues: [] },
    },
  });
  const relays = calls.filter((c) => c.label.startsWith('security-'));
  assert.ok(relays.some((c) => c.label === 'security-review-codex#1'), relays.map((c) => c.label).join(', '));
  for (const c of relays) {
    assert.ok(!c.prompt.includes(DIRECTION) && !c.prompt.includes(SECTION), `${c.label} の prompt に方針が入っている`);
  }
});

// ---- (d) 終端サマリー ----

test('[fix-direction][d] 方針を渡した run の終端サマリーは渡したことを 1 行だけ出し、本文は載せない（無い run は出さない）', async () => {
  const LINE = '**修正方針**: /pr-iterate を起動した人が決めた修正方針（`--direction`）を fix に渡して回した（本文はこのコメントに載せない）';
  const overrides = {
    'review#1': { decision: 'request-changes', issues: [reviewIssue], summary: 'ng' },
    'commit-ensure#1': pushed,
  };
  const used = await run({ args: withDirection(), overrides });
  assert.equal(used.result.status, 'lgtm');
  const summary = promptOf(used.calls, 'post-summary');
  assert.equal(summary.split(LINE).length - 1, 1, `終端サマリーに方針の行が 1 行ない: ${summary}`);
  assert.ok(!summary.includes(DIRECTION), '終端サマリーに方針の本文が載っている');

  const none = await run({ args: { pr: '5', nested: NESTED }, overrides });
  assert.ok(!promptOf(none.calls, 'post-summary').includes('**修正方針**'), '方針を渡していない run に方針の行を出した');
});

// ---- (e) dev-flow の nested 起動 ----

test('[fix-direction][e] dev-flow の nested 起動（prIterateArgs）は fix_direction を渡さない', () => {
  const start = devFlowSrc.indexOf('const prIterateArgs = () => ({');
  assert.ok(start >= 0, 'dev-flow.js に prIterateArgs が無い');
  const def = devFlowSrc.slice(start, devFlowSrc.indexOf('\n})\n', start));
  assert.ok(def.includes("caller: 'dev-flow'"), def);
  assert.ok(!def.includes('fix_direction'), `dev-flow の nested 起動が fix_direction を渡している: ${def}`);
});
