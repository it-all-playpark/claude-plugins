import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  classifyReviewRoute,
  REVIEW_ROUTE_CI_GATE,
  REVIEW_ROUTE_FIX_LOOP,
  isOutsideWorktree,
  excludeOutsideWorktree,
} from './review-normalize.mjs';

test('approve + issues:[] → ci_gate / blocking 0 / minor 0', () => {
  const result = classifyReviewRoute({ decision: 'approve', issues: [] });
  assert.equal(result.route, REVIEW_ROUTE_CI_GATE);
  assert.deepEqual(result.blocking, []);
  assert.deepEqual(result.minor, []);
});

test('comment + minor のみ 2 件 → ci_gate / minor 2 件がそのまま返る', () => {
  const minorA = { severity: 'minor', description: 'a' };
  const minorB = { severity: 'minor', description: 'b' };
  const result = classifyReviewRoute({ decision: 'comment', issues: [minorA, minorB] });
  assert.equal(result.route, REVIEW_ROUTE_CI_GATE);
  assert.deepEqual(result.blocking, []);
  assert.deepEqual(result.minor, [minorA, minorB]);
});

test('request-changes + issues:[] → ci_gate', () => {
  const result = classifyReviewRoute({ decision: 'request-changes', issues: [] });
  assert.equal(result.route, REVIEW_ROUTE_CI_GATE);
  assert.deepEqual(result.blocking, []);
});

test('approve + [major] → fix_loop / blocking 1（decision は route に効かない）', () => {
  const major = { severity: 'major', description: 'm' };
  const result = classifyReviewRoute({ decision: 'approve', issues: [major] });
  assert.equal(result.route, REVIEW_ROUTE_FIX_LOOP);
  assert.deepEqual(result.blocking, [major]);
});

test('approve + [critical, minor] → fix_loop / blocking 1 / minor 1（decision は route に効かない）', () => {
  const critical = { severity: 'critical', description: 'c' };
  const minor = { severity: 'minor', description: 'n' };
  const result = classifyReviewRoute({ decision: 'approve', issues: [critical, minor] });
  assert.equal(result.route, REVIEW_ROUTE_FIX_LOOP);
  assert.deepEqual(result.blocking, [critical]);
  assert.deepEqual(result.minor, [minor]);
});

test('request-changes + [major, minor] → fix_loop / blocking 1 / minor 1', () => {
  const major = { severity: 'major', description: 'm' };
  const minor = { severity: 'minor', description: 'n' };
  const result = classifyReviewRoute({ decision: 'request-changes', issues: [major, minor] });
  assert.equal(result.route, REVIEW_ROUTE_FIX_LOOP);
  assert.deepEqual(result.blocking, [major]);
  assert.deepEqual(result.minor, [minor]);
});

test('comment + [critical] → fix_loop', () => {
  const critical = { severity: 'critical', description: 'c' };
  const result = classifyReviewRoute({ decision: 'comment', issues: [critical] });
  assert.equal(result.route, REVIEW_ROUTE_FIX_LOOP);
  assert.deepEqual(result.blocking, [critical]);
});

test('issues が undefined / review が null → ci_gate / 空配列（throw しない）', () => {
  const resultUndefinedIssues = classifyReviewRoute({ decision: 'approve' });
  assert.equal(resultUndefinedIssues.route, REVIEW_ROUTE_CI_GATE);
  assert.deepEqual(resultUndefinedIssues.blocking, []);
  assert.deepEqual(resultUndefinedIssues.minor, []);

  const resultNullReview = classifyReviewRoute(null);
  assert.equal(resultNullReview.route, REVIEW_ROUTE_CI_GATE);
  assert.deepEqual(resultNullReview.blocking, []);
  assert.deepEqual(resultNullReview.minor, []);
});

test('critical と major の混在が両方 blocking に入る', () => {
  const critical = { severity: 'critical', description: 'c' };
  const major = { severity: 'major', description: 'm' };
  const result = classifyReviewRoute({ decision: 'request-changes', issues: [critical, major] });
  assert.equal(result.route, REVIEW_ROUTE_FIX_LOOP);
  assert.deepEqual(result.blocking, [critical, major]);
});

// ---- isOutsideWorktree / excludeOutsideWorktree（issue #793）----
const WT = '/Users/u/skills/.claude/worktrees/df-1';

test('isOutsideWorktree: URL・~・.. で出る相対パス・worktree 配下でない絶対パスは外、repo 相対パスと worktree 配下の絶対パスは内', () => {
  for (const f of [
    '~/ghq/github.com/acme/dotfiles/claude-code/settings.json',
    '~',
    '../dotfiles/claude-code/settings.json',
    'a/../../x.js',
    '/Users/u/dotfiles/claude-code/settings.json',
    '/Users/u/skills/.claude/worktrees/df-10/a.js',
    'https://github.com/acme/dotfiles/blob/main/x',
  ]) assert.equal(isOutsideWorktree(f, WT), true, f);
  for (const f of [
    'plugins/dev-flow/_lib/a.mjs',
    './src/a.js',
    'a/../b.js',
    `${WT}/plugins/a.mjs`,
    `${WT}/`,
    '',
    undefined,
  ]) assert.equal(isOutsideWorktree(f, WT), false, String(f));
});

test('isOutsideWorktree: worktree が絶対パスでないときは絶対パスを外とみなさない（fix に渡す側に倒す）', () => {
  assert.equal(isOutsideWorktree('/Users/u/dotfiles/x', '.'), false);
  assert.equal(isOutsideWorktree('~/dotfiles/x', '.'), true);
});

test('excludeOutsideWorktree: 外を指す blocking を outside に分け、残りが 0 件なら ci_gate、残りがあれば route を保つ', () => {
  const inside = { severity: 'major', file: 'src/a.js', description: 'in' };
  const outside = { severity: 'major', file: '~/dotfiles/x.json', description: 'out' };
  const mixed = excludeOutsideWorktree(classifyReviewRoute({ decision: 'request-changes', issues: [inside, outside] }), WT);
  assert.equal(mixed.outcome.route, REVIEW_ROUTE_FIX_LOOP);
  assert.deepEqual(mixed.outcome.blocking, [inside]);
  assert.deepEqual(mixed.outside, [outside]);

  const onlyOutside = excludeOutsideWorktree(classifyReviewRoute({ decision: 'request-changes', issues: [outside] }), WT);
  assert.equal(onlyOutside.outcome.route, REVIEW_ROUTE_CI_GATE);
  assert.deepEqual(onlyOutside.outcome.blocking, []);

  const approveOutside = excludeOutsideWorktree(classifyReviewRoute({ decision: 'approve', issues: [outside] }), WT);
  assert.equal(approveOutside.outcome.route, REVIEW_ROUTE_CI_GATE, 'approve + 外の blocking だけなら fix loop にしない');

  const none = classifyReviewRoute({ decision: 'request-changes', issues: [inside] });
  const r = excludeOutsideWorktree(none, WT);
  assert.equal(r.outcome, none);
  assert.deepEqual(r.outside, []);
});
