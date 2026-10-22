// F5: pr-iterate.js の返り値に optional end_epoch を追加する検証テスト（TDD）。
// dev-flow.js は workflow('pr-iterate') 復帰直後に隣接する agent 呼び出しを持たないため、
// pr-iterate の返り値自体に最後の ci-check 応答の epoch を end_epoch として載せる（issue #443）。
// harness は test-helpers/vm-sandbox.mjs の makePrIterateSandbox / prIterateRounds / runWorkflowCapture。
// ci-check 以外の応答には epoch を載せない（pr-meta・post-summary は epoch なし）— 既定 responder の
// epoch が end_epoch に混ざると「ci-check が epoch を返さない run」を作れないため。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makePrIterateSandbox, prIterateRounds, runWorkflowCapture } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', '.claude/workflows/pr-iterate.js'), 'utf8');

function makeSandbox({ ciResponses }) {
  const { ctx, calls } = makePrIterateSandbox({
    overrides: {
      // base_ref は LGTM の前の security review の diff に要る（epoch は載せない）
      'pr-meta': { url: 'https://github.com/acme/skills/pull/5', head_ref: 'feature/x', base_ref: 'main', cwd: '/tmp/wt' },
      'post-summary': { posted: true, method: 'gh', url: 'http://x' },
    },
    rounds: prIterateRounds({
      reviewer: () => ({ decision: 'approve', issues: [], summary: 'ok' }),
      fix: [{ applied: true, summary: 'fixed', files: [] }],
      ci: ciResponses,
      commitEnsure: { dirty: false, committed: false, pushed: false },
    }),
  });
  return { ctx, getAgentCalls: () => calls };
}

const runPrIterateCapture = (source, ctx) => runWorkflowCapture(source, ctx, '.claude/workflows/pr-iterate.js');

test('[end-epoch] ci-check が epoch を返す run では返り値に end_epoch が数値で含まれる', async () => {
  const { ctx } = makeSandbox({
    ciResponses: [{ status: 'passed', passed: 1, failed: 0, pending: 0, skipped: 0, failed_checks: [], waited_seconds: 0, poll_attempts: 1, epoch: 1753900000 }],
  });

  const { result, error } = await runPrIterateCapture(src, ctx);
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`pr-iterate.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  assert.equal(result?.status, 'lgtm', `passed で LGTM へ進むべきだが '${result?.status}' だった`);
  assert.equal(
    result?.end_epoch,
    1753900000,
    `ci-check が epoch を返した場合、返り値 end_epoch にその値が数値で反映されるべきだが ${JSON.stringify(result?.end_epoch)} だった`,
  );
});

test('[end-epoch] ci-check が epoch を返さない run では返り値に end_epoch キーが無い', async () => {
  const { ctx } = makeSandbox({
    ciResponses: [{ status: 'passed', passed: 1, failed: 0, pending: 0, skipped: 0, failed_checks: [], waited_seconds: 0, poll_attempts: 1 }],
  });

  const { result, error } = await runPrIterateCapture(src, ctx);
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`pr-iterate.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  assert.equal(result?.status, 'lgtm');
  assert.ok(
    !Object.prototype.hasOwnProperty.call(result ?? {}, 'end_epoch'),
    `ci-check が epoch を返さない場合、返り値に end_epoch キーが存在してはいけない（fail-open）が ${JSON.stringify(result)} だった`,
  );
});

test('[end-epoch] 返り値の既存キー（status/fixes_applied/subagent_invocations）は epoch 追加の有無に関わらず不変', async () => {
  const withEpoch = makeSandbox({
    ciResponses: [{ status: 'passed', passed: 1, failed: 0, pending: 0, skipped: 0, failed_checks: [], waited_seconds: 0, poll_attempts: 1, epoch: 1753900000 }],
  });
  const withoutEpoch = makeSandbox({
    ciResponses: [{ status: 'passed', passed: 1, failed: 0, pending: 0, skipped: 0, failed_checks: [], waited_seconds: 0, poll_attempts: 1 }],
  });

  const { result: r1, error: e1 } = await runPrIterateCapture(src, withEpoch.ctx);
  const { result: r2, error: e2 } = await runPrIterateCapture(src, withoutEpoch.ctx);
  for (const e of [e1, e2]) {
    if (e && (e.name === 'ReferenceError' || e.name === 'SyntaxError')) {
      assert.fail(`pr-iterate.js が sandbox でクラッシュ: ${e.name}: ${e.message}`);
    }
  }

  for (const result of [r1, r2]) {
    assert.equal(result?.status, 'lgtm');
    assert.equal(result?.fixes_applied, 0);
    assert.ok(result?.subagent_invocations != null, 'subagent_invocations は常時出力されるべき');
    assert.equal(typeof result.subagent_invocations.total, 'number');
    assert.ok(result.subagent_invocations.by_type != null);
  }
});
