import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  isTestFilePath, classifyGreenFixDiff, isRecheckCandidate, recheckTargets, planRecheck, greenFixRecheckItems,
  RECHECK_RESOLUTIONS,
} from './post-eval-recheck.mjs';
import { GATE_POLICIES, gateLane } from './gate-policy.mjs';

const RISK_CLEAN = { ok: true, hits: [] };

test('isTestFilePath: テストファイルとそれ以外', () => {
  for (const p of ['tests/foo.sh', 'plugins/x/tests/run.bats', 'src/__tests__/a.ts', 'src/a.test.ts', 'src/a.spec.js', 'pkg/a_test.go', 'scripts/foo.bats', '_lib/x.test.mjs']) {
    assert.equal(isTestFilePath(p), true, p);
  }
  for (const p of ['src/a.ts', 'docs/testing.md', 'src/latest.ts', 'contest/a.ts', '', null]) {
    assert.equal(isTestFilePath(p), false, String(p));
  }
});

test('classifyGreenFixDiff: hit 0 かつテストファイルだけなら assert_only', () => {
  const r = classifyGreenFixDiff({ files: ['tests/a.test.ts', 'tests/b.bats'], truncated: false, risk: { ok: true, hits: [{ class: 'auth', file: 'src/other.ts' }] } });
  assert.deepEqual(r, { mode: 'assert_only', reason: 'test_only_clean', hits: [] });
});

test('classifyGreenFixDiff: 差分ファイルに hit（test-weakening / danger）があれば full', () => {
  const hit = { class: 'test-weakening', pattern: 'skip', file: 'tests/a.test.ts' };
  const r = classifyGreenFixDiff({ files: ['tests/a.test.ts'], risk: { ok: true, hits: [hit] } });
  assert.equal(r.mode, 'full');
  assert.equal(r.reason, 'hits');
  assert.deepEqual(r.hits, [hit]);
});

test('classifyGreenFixDiff: テストファイル以外を含めば full', () => {
  assert.equal(classifyGreenFixDiff({ files: ['tests/a.test.ts', 'src/a.ts'], risk: RISK_CLEAN }).reason, 'non_test_files');
});

test('classifyGreenFixDiff: 差分不明・打ち切り・risk 取得失敗は full（fail-safe）', () => {
  assert.equal(classifyGreenFixDiff({ files: null, risk: RISK_CLEAN }).reason, 'files_unknown');
  assert.equal(classifyGreenFixDiff({ files: [], risk: RISK_CLEAN }).reason, 'files_unknown');
  assert.equal(classifyGreenFixDiff({ files: ['tests/a.test.ts'], truncated: true, risk: RISK_CLEAN }).reason, 'files_truncated');
  assert.equal(classifyGreenFixDiff({ files: ['tests/a.test.ts'], risk: { ok: false, hits: [] } }).reason, 'risk_unavailable');
  assert.equal(classifyGreenFixDiff({ files: ['tests/a.test.ts'], risk: null }).mode, 'full');
});

const item = (over) => ({ id: 'X', text: 't', dimension: 'concern', severity: 'major', source: 'concern', checked: true, evidence: 'e', check: { kind: 'inspection' }, ...over });

test('isRecheckCandidate: LLM 判断で checked の evaluator / concern item だけ', () => {
  assert.equal(isRecheckCandidate(item()), true);
  assert.equal(isRecheckCandidate(item({ source: 'evaluator', severity: 'critical' })), true);
  assert.equal(isRecheckCandidate(item({ checked: false })), false);
  assert.equal(isRecheckCandidate(item({ source: 'seed', check: { kind: 'deterministic' } })), false);
  assert.equal(isRecheckCandidate(item({ source: 'ac', dimension: 'ac' })), false);
  assert.equal(isRecheckCandidate(item({ check: { kind: 'deterministic' } })), false);
  assert.equal(isRecheckCandidate(item({ escalate: true })), false);
  assert.equal(isRecheckCandidate(item({ dimension: 'environment' })), false);
});

test('recheckTargets: 変更ファイルがあれば、ファイル名に言及しない item も含め LLM 判断の解消済み item を全件返す', () => {
  const ledger = {
    round: 2,
    items: [
      item({ id: 'C1', evidence: 'generate_thumbnail.bats の変更を取り消し済み' }),
      item({ id: 'C2', text: '境界条件の扱い', evidence: '上限の判定を確認済み' }),
      item({ id: 'E1', source: 'evaluator', severity: 'critical', text: 'X', evidence: 'src/index.ts:3 で修正' }),
      item({ id: 'C4', evidence: 'generate_thumbnail.bats の件', checked: false }),
      item({ id: 'S1', source: 'seed', check: { kind: 'deterministic' }, evidence: 'generate_thumbnail.bats clean' }),
      item({ id: 'AC-1', source: 'ac', dimension: 'ac', evidence: 'generate_thumbnail.bats で確認' }),
      item({ id: 'ENV', dimension: 'environment', evidence: 'generate_thumbnail.bats' }),
      item({ id: 'ESC', escalate: true, evidence: 'generate_thumbnail.bats' }),
      item({ id: 'DET', check: { kind: 'deterministic' }, evidence: 'generate_thumbnail.bats' }),
    ],
  };
  const ids = recheckTargets(ledger, ['plugins/x/scripts/generate_thumbnail.bats']).map((it) => it.id);
  assert.deepEqual(ids, ['C1', 'C2', 'E1']);
});

test('recheckTargets: 変更ファイルが無ければ空', () => {
  assert.deepEqual(recheckTargets({ items: [item()] }, []), []);
  assert.deepEqual(recheckTargets({ items: [item()] }, null), []);
});

test('planRecheck: resolved + evidence は reconfirm、unresolved / 欠落 / 未返却 / enum 外は reopen', () => {
  const targets = [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }, { id: 'E' }];
  const p = planRecheck(targets, [
    { id: 'A', resolution: 'resolved', evidence: 'a.ts:1 で成立' },
    { id: 'B', resolution: 'unresolved', evidence: 'green-fix が再び入れた' },
    { id: 'C', resolution: 'resolved', evidence: '' },
    { id: 'E', resolution: 'triaged', evidence: 'x' },
    { id: 'A', resolution: 'unresolved', evidence: '重複は無視' },
    { id: 'Z', resolution: 'resolved', evidence: '対象外 id は無視' },
  ], 'T');
  assert.deepEqual(p.reconfirm, [{ id: 'A', evidence: 'T で再検証済み: a.ts:1 で成立' }]);
  assert.deepEqual(p.reopen.map((r) => r.id), ['B', 'C', 'D', 'E']);
  assert.equal(p.reopen[0].evidence, 'T で再検証し解消根拠が不成立: green-fix が再び入れた');
  assert.match(p.reopen[1].evidence, /^T で再検証できず/);
  assert.ok(RECHECK_RESOLUTIONS.includes('resolved') && RECHECK_RESOLUTIONS.includes('unresolved') && RECHECK_RESOLUTIONS.length === 2);
});

test('planRecheck: resolutions が null（再検証されていない）なら全件 reopen', () => {
  const p = planRecheck([{ id: 'A' }], null, 'T');
  assert.deepEqual(p.reconfirm, []);
  assert.deepEqual(p.reopen, [{ id: 'A', evidence: 'T で再検証できず — 解消根拠を取り下げ（要確認）' }]);
});

test('greenFixRecheckItems: critical だけを GF-RECHECK-<n> にし、どの gate_policy でも blocking', () => {
  const items = greenFixRecheckItems([
    { severity: 'major', topic: 'm', description: 'd' },
    { severity: 'critical', topic: 'assert 弱体化', description: 'toBe(3) を toBeTruthy() に緩めた' },
    null,
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 'GF-RECHECK-1');
  assert.equal(items[0].severity, 'critical');
  assert.equal(items[0].source, 'evaluator');
  assert.ok(!items[0].id.startsWith('EVAL-'), 'fix 後 test green の決定論 check（EVAL-*）に乗せない');
  assert.equal(items[0].text, 'post-eval green-fix: assert 弱体化 — toBe(3) を toBeTruthy() に緩めた');
  for (const p of GATE_POLICIES) assert.equal(gateLane(items[0], p), 'blocking', p);
});
