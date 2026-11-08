// implementer-git-rm-deletion: tracked ファイルの削除手段（git rm・削除後に unstage しない）の pin。
//   (a) agents/dev-implementer.md に削除手段が書かれている（静的）
//   (b) isDeletionGuardBlock: 削除を理由にした guard_blocked の判定
//   (c) 削除を理由に guard_blocked で止まった run は、以降の実装 spawn（reimpl#i）の prompt に同じ手段が渡る。
//       最初の Implement と、削除以外の理由の guard_blocked の run には渡らない（VM sandbox）

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isDeletionGuardBlock } from './block-routing.mjs';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash, mergeTierFacts, COMPLEX_FILES } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = join(here, '..');
const implementerMd = readFileSync(join(pluginRoot, 'agents', 'dev-implementer.md'), 'utf8');
const src = readFileSync(join(pluginRoot, '.claude/workflows/dev-flow.js'), 'utf8');

test('(a) dev-implementer.md: tracked ファイルの削除は git rm、削除後に unstage しない', () => {
  const lines = implementerMd.split('\n');
  const start = lines.findIndex((l) => l.includes('tracked ファイルの削除は `git rm'));
  assert.ok(start >= 0, 'dev-implementer.md に「tracked ファイルの削除は `git rm <path>`」の項目が無い');
  const bullet = lines.slice(start, start + 6).join('\n');
  assert.match(bullet, /`rm` \/ `rip` は deny/, '`rm` / `rip` が deny されることを書く');
  assert.match(bullet, /削除後に unstage しない/, '削除後に unstage しないことを書く');
  assert.match(bullet, /git ls-files/, 'unstage すると git ls-files を数えるテストが落ちる理由を書く');
});

test('(b) isDeletionGuardBlock: 削除を理由にした detail だけ true', () => {
  for (const d of ['tracked ファイルを Bash で削除できない', 'rm が sandbox に deny された', 'rip が拒否された', 'cannot delete file', 'Remove denied by hook']) {
    assert.equal(isDeletionGuardBlock(d), true, d);
  }
  for (const d of ['dev-flow.js の生成マーカー区間を含む Edit が deny された', 'sandbox EPERM on .git/index.lock', '', null, undefined]) {
    assert.equal(isDeletionGuardBlock(d), false, String(d));
  }
});

const ACR = [0, 1].map((i) => ({ ac_index: i, satisfied: true, verified_by: 'inspection', evidence: 'ok' }));

async function runGuardBlocked(detail) {
  const files = [...COMPLEX_FILES];
  const { ctx, calls, logs } = makeDevFlowSandbox({
    overrides: {
      'impl:serial:issue-1': {
        status: 'BLOCKED', task_id: 'issue-1', files, summary: '', concerns: [],
        blocking_reason: { block_class: 'guard_blocked', guard_id: 'sandbox-deny', detail },
      },
      'reimpl#1:serial:issue-1': { status: 'DONE', task_id: 'issue-1', files, summary: 's', concerns: [] },
      'danger-grep': { risk: { ok: true, hits: [] }, files, diffhash: { hash: 'AAA', empty: false } },
      'merge-tier-facts': mergeTierFacts({ files }),
      'eval#1': {
        verdict: 'fail', total: 50, threshold: 80,
        feedback: [{ topic: 'X', severity: 'critical', dimension: 'implementation', description: '削除が未実施', suggestion: '削除する' }],
        feedback_level: 'implementation', ac_results: ACR, security_clearance: [],
      },
      'eval#2': {
        verdict: 'pass', total: 100, threshold: 80, feedback: [], feedback_level: 'implementation', ac_results: ACR, security_clearance: [],
        critical_resolutions: [{ id: 'EVAL-1-X', resolved: true, evidence: 'fixed' }],
      },
    },
  });
  const { error } = await runWorkflowCapture(src, ctx);
  assertNoCrash(error, 'implementer-git-rm-deletion');
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  return { calls, logs };
}

const HINT_RE = /`git rm <path>` で削除せよ/;

test('(c) 削除を理由に guard_blocked で止まった run は reimpl#1 の prompt に git rm・unstage しない を渡す', async () => {
  const { calls } = await runGuardBlocked('tracked ファイルを Bash で削除できない（rm / rip が deny）');
  const impl = calls.find((c) => c.label === 'impl:serial:issue-1');
  const reimpl = calls.find((c) => c.label === 'reimpl#1:serial:issue-1');
  assert.ok(reimpl, 'Evaluate の差し戻しで reimpl#1 が起動するはず');
  assert.equal(HINT_RE.test(impl.prompt), false, '最初の Implement には渡さない（agent 定義に同じ内容がある）');
  assert.match(reimpl.prompt, HINT_RE);
  assert.match(reimpl.prompt, /削除後に unstage（git restore --staged \/ git reset）するな/);
  assert.equal(reimpl.prompt.includes('rm / rip が deny'), false, 'blocking_reason の detail は prompt に転記しない');
});

test('(c) 削除以外の理由の guard_blocked では削除手段を渡さない', async () => {
  const { calls } = await runGuardBlocked('dev-flow.js の生成マーカー区間を含む Edit が inline-edit-guard hook に deny された');
  const reimpl = calls.find((c) => c.label === 'reimpl#1:serial:issue-1');
  assert.ok(reimpl, 'Evaluate の差し戻しで reimpl#1 が起動するはず');
  assert.equal(HINT_RE.test(reimpl.prompt), false);
});
