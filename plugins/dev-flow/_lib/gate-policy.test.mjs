import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  GATE_POLICIES,
  DEFAULT_GATE_POLICY,
  resolveGatePolicy,
  gateLane,
  policyBlockingItems,
  policyAdvisoryItems,
  isConvergedUnderPolicy,
  isLoopConvergedUnderPolicy,
} from './gate-policy.mjs';

// ---- (1) resolveGatePolicy ----

test('GATE_POLICIES は llm-major-advisory / llm-major-blocking の 2 値配列', () => {
  assert.deepEqual(GATE_POLICIES, ['llm-major-advisory', 'llm-major-blocking']);
});

test('DEFAULT_GATE_POLICY は llm-major-advisory', () => {
  assert.equal(DEFAULT_GATE_POLICY, 'llm-major-advisory');
});

test('resolveGatePolicy: null → DEFAULT_GATE_POLICY', () => {
  assert.equal(resolveGatePolicy(null), DEFAULT_GATE_POLICY);
});

test('resolveGatePolicy: undefined → DEFAULT_GATE_POLICY', () => {
  assert.equal(resolveGatePolicy(undefined), DEFAULT_GATE_POLICY);
});

test('resolveGatePolicy: 空文字 → DEFAULT_GATE_POLICY', () => {
  assert.equal(resolveGatePolicy(''), DEFAULT_GATE_POLICY);
});

test('resolveGatePolicy: 有効な policy 値をそのまま返す', () => {
  for (const p of GATE_POLICIES) {
    assert.equal(resolveGatePolicy(p), p);
  }
});

test('resolveGatePolicy: 未知の値は throw', () => {
  assert.throws(
    () => resolveGatePolicy('unknown-policy'),
    /gate-policy: 未知の gate_policy "unknown-policy"/,
  );
  assert.throws(
    () => resolveGatePolicy('bogus'),
    /gate-policy: 未知の gate_policy "bogus".*許可/,
  );
});

test('resolveGatePolicy: 削除した deterministic-only / llm-autonomous は未知の値として throw', () => {
  assert.throws(
    () => resolveGatePolicy('deterministic-only'),
    /未知の gate_policy "deterministic-only"/,
  );
  assert.throws(
    () => resolveGatePolicy('llm-autonomous'),
    /未知の gate_policy "llm-autonomous"/,
  );
});

// ---- (2) 軸A invariant: deterministic / seed / critical は全 policy で blocking ----

const mkItem = (over = {}) => ({
  id: 'TEST-1', text: 'test item', dimension: 'test',
  severity: 'major', source: 'ac', checked: false,
  evidence: null, floor: false, check: null,
  ...over,
});

test('gateLane: critical item は全 policy で blocking', () => {
  const item = mkItem({ severity: 'critical' });
  for (const p of GATE_POLICIES) {
    assert.equal(gateLane(item, p), 'blocking', `policy=${p}`);
  }
});

test('gateLane: deterministic check 付き item は全 policy で blocking', () => {
  const item = mkItem({ severity: 'major', check: { kind: 'deterministic' } });
  for (const p of GATE_POLICIES) {
    assert.equal(gateLane(item, p), 'blocking', `policy=${p}`);
  }
});

test('gateLane: source=seed item は全 policy で blocking', () => {
  const item = mkItem({ severity: 'major', source: 'seed' });
  for (const p of GATE_POLICIES) {
    assert.equal(gateLane(item, p), 'blocking', `policy=${p}`);
  }
});

// ---- (3) default-equivalence: llm-major-advisory の挙動を明示 pin ----

test('gateLane default-equivalence: llm-major-advisory の lane を 6 item で直接 assert', () => {
  // critical → blocking
  assert.equal(
    gateLane(mkItem({ id: 'critical', severity: 'critical' }), 'llm-major-advisory'),
    'blocking',
    'critical should be blocking',
  );
  // deterministic check → blocking
  assert.equal(
    gateLane(mkItem({ id: 'deterministic', check: { kind: 'deterministic' }, severity: 'major' }), 'llm-major-advisory'),
    'blocking',
    'deterministic check should be blocking',
  );
  // seed source → blocking
  assert.equal(
    gateLane(mkItem({ id: 'seed', source: 'seed', severity: 'major' }), 'llm-major-advisory'),
    'blocking',
    'seed source should be blocking',
  );
  // LLM major (source: evaluator) → advisory
  assert.equal(
    gateLane(mkItem({ id: 'llm-major', severity: 'major', source: 'evaluator' }), 'llm-major-advisory'),
    'advisory',
    'LLM major (evaluator) should be advisory under llm-major-advisory',
  );
  // LLM minor → advisory
  assert.equal(
    gateLane(mkItem({ id: 'llm-minor', severity: 'minor', source: 'ac' }), 'llm-major-advisory'),
    'advisory',
    'LLM minor should be advisory',
  );
  // inspection major → advisory
  assert.equal(
    gateLane(mkItem({ id: 'inspection', check: { kind: 'inspection' }, severity: 'major', source: 'ac' }), 'llm-major-advisory'),
    'advisory',
    'inspection major should be advisory',
  );
});

// ---- (4) llm-major-blocking では LLM major が blocking に転じる ----

test('gateLane: llm-major-blocking で LLM major は blocking', () => {
  const item = mkItem({ severity: 'major', source: 'evaluator', check: null });
  assert.equal(gateLane(item, 'llm-major-blocking'), 'blocking');
});

test('gateLane: llm-major-advisory で LLM major は advisory', () => {
  const item = mkItem({ severity: 'major', source: 'evaluator', check: null });
  assert.equal(gateLane(item, 'llm-major-advisory'), 'advisory');
});

// ---- LLM minor は全 policy で advisory ----

test('gateLane: LLM minor は全 policy で advisory', () => {
  const item = mkItem({ severity: 'minor', source: 'ac', check: null });
  for (const p of GATE_POLICIES) {
    assert.equal(gateLane(item, p), 'advisory', `policy=${p}`);
  }
});

// ---- (5) isConvergedUnderPolicy ----

test('isConvergedUnderPolicy: blocking 全 checked で true', () => {
  const items = [
    { ...mkItem({ id: 'A', severity: 'critical' }), checked: true },
    { ...mkItem({ id: 'B', severity: 'minor' }), checked: false },
  ];
  const ledger = { items, round: 0 };
  assert.equal(isConvergedUnderPolicy(ledger, 'llm-major-advisory'), true);
});

test('isConvergedUnderPolicy: blocking 未 checked で false', () => {
  const items = [
    { ...mkItem({ id: 'A', severity: 'critical' }), checked: false },
    { ...mkItem({ id: 'B', severity: 'minor' }), checked: true },
  ];
  const ledger = { items, round: 0 };
  assert.equal(isConvergedUnderPolicy(ledger, 'llm-major-advisory'), false);
});

test('isConvergedUnderPolicy: llm-major-blocking で LLM major が blocking に入り未 checked → false', () => {
  const items = [
    { ...mkItem({ id: 'A', severity: 'major', source: 'evaluator', check: null }), checked: false },
  ];
  const ledger = { items, round: 0 };
  assert.equal(isConvergedUnderPolicy(ledger, 'llm-major-blocking'), false);
  assert.equal(isConvergedUnderPolicy(ledger, 'llm-major-advisory'), true);
});

test('isConvergedUnderPolicy: 空 ledger は true', () => {
  assert.equal(isConvergedUnderPolicy({ items: [], round: 0 }, 'llm-major-advisory'), true);
});

// ---- isLoopConvergedUnderPolicy（issue #271: Evaluate ループ収束専用）----

test('isLoopConvergedUnderPolicy: fail_closed SEC seed が唯一の unchecked blocking のとき true（isConvergedUnderPolicy とは分離）', () => {
  const items = [
    {
      ...mkItem({
        id: 'SEC-1',
        dimension: 'security',
        source: 'seed',
        severity: 'critical',
        check: { kind: 'deterministic' },
      }),
      checked: false,
      fail_closed: true,
    },
  ];
  const ledger = { items, round: 0 };
  assert.equal(isLoopConvergedUnderPolicy(ledger, 'llm-major-advisory'), true);
  assert.equal(isConvergedUnderPolicy(ledger, 'llm-major-advisory'), false);
});

test('isLoopConvergedUnderPolicy: 非 SEC blocking (critical) が unchecked なら false', () => {
  const items = [
    { ...mkItem({ id: 'AC-1', severity: 'critical' }), checked: false },
  ];
  const ledger = { items, round: 0 };
  assert.equal(isLoopConvergedUnderPolicy(ledger, 'llm-major-advisory'), false);
});

test('isLoopConvergedUnderPolicy: fail_closed を持たない実 hit SEC は除外されず false のまま', () => {
  const items = [
    {
      ...mkItem({
        id: 'SEC-2',
        dimension: 'security',
        source: 'seed',
        severity: 'critical',
        check: { kind: 'deterministic' },
        floor: true,
      }),
      checked: false,
      fail_closed: false,
    },
  ];
  const ledger = { items, round: 0 };
  assert.equal(isLoopConvergedUnderPolicy(ledger, 'llm-major-advisory'), false);
});

test('isLoopConvergedUnderPolicy: fail_closed 未定義の実 hit SEC も除外されず false のまま', () => {
  const items = [
    {
      ...mkItem({
        id: 'SEC-3',
        dimension: 'security',
        source: 'seed',
        severity: 'critical',
        check: { kind: 'deterministic' },
        floor: true,
      }),
      checked: false,
    },
  ];
  const ledger = { items, round: 0 };
  assert.equal(isLoopConvergedUnderPolicy(ledger, 'llm-major-advisory'), false);
});

test('isLoopConvergedUnderPolicy: 全 blocking checked なら true', () => {
  const items = [
    {
      ...mkItem({
        id: 'SEC-4',
        dimension: 'security',
        source: 'seed',
        severity: 'critical',
        check: { kind: 'deterministic' },
      }),
      checked: true,
      fail_closed: false,
    },
    { ...mkItem({ id: 'AC-2', severity: 'critical' }), checked: true },
  ];
  const ledger = { items, round: 0 };
  assert.equal(isLoopConvergedUnderPolicy(ledger, 'llm-major-advisory'), true);
  assert.equal(isConvergedUnderPolicy(ledger, 'llm-major-advisory'), true);
});

// ---- policyBlockingItems / policyAdvisoryItems ----

test('policyBlockingItems / policyAdvisoryItems: 分離が正しい', () => {
  const items = [
    { ...mkItem({ id: 'crit', severity: 'critical' }), checked: false },
    { ...mkItem({ id: 'llm-maj', severity: 'major', source: 'evaluator', check: null }), checked: false },
    { ...mkItem({ id: 'llm-min', severity: 'minor', source: 'ac', check: null }), checked: false },
  ];
  const ledger = { items, round: 0 };

  // llm-major-advisory: critical=blocking, llm-maj=advisory, llm-min=advisory
  const blocking = policyBlockingItems(ledger, 'llm-major-advisory');
  const advisory = policyAdvisoryItems(ledger, 'llm-major-advisory');
  assert.deepEqual(blocking.map((i) => i.id), ['crit']);
  assert.deepEqual(advisory.map((i) => i.id), ['llm-maj', 'llm-min']);

  // llm-major-blocking: critical=blocking, llm-maj=blocking, llm-min=advisory
  const blocking2 = policyBlockingItems(ledger, 'llm-major-blocking');
  const advisory2 = policyAdvisoryItems(ledger, 'llm-major-blocking');
  assert.deepEqual(blocking2.map((i) => i.id), ['crit', 'llm-maj']);
  assert.deepEqual(advisory2.map((i) => i.id), ['llm-min']);
});

// ---- F3: source='concern' CONCERN item のgating 挙動 characterization（回帰固定）----

// CONCERN item は source='concern', severity='major', check={kind:'inspection'} で append される。
// gateLane は source==='seed' のみ特別扱いするため、source='concern' への変更はgating 不変。
// このテストは characterization test — 既存挙動を pin して regression を防ぐ。
test('gateLane: source=concern の major/inspection item は llm-major-advisory で advisory（回帰固定）', () => {
  const item = mkItem({ severity: 'major', source: 'concern', check: { kind: 'inspection' } });
  assert.equal(
    gateLane(item, 'llm-major-advisory'),
    'advisory',
    'source=concern の CONCERN item は default policy で advisory（source=evaluator と同分類）',
  );
});

test('gateLane: source=concern は source=evaluator と同じ lane 分類になる（全 policy で一致）', () => {
  const base = { severity: 'major', check: { kind: 'inspection' } };
  const concern = mkItem({ ...base, source: 'concern' });
  const evaluator = mkItem({ ...base, source: 'evaluator' });
  for (const p of GATE_POLICIES) {
    assert.equal(
      gateLane(concern, p),
      gateLane(evaluator, p),
      `policy=${p} で source=concern と source=evaluator の lane が一致するべき`,
    );
  }
});

// CONCERN append が source: 'concern' を使うことは eval-concern-resolutions-routing.test.mjs が
// VM 挙動で検証する（source が 'evaluator' だと CONCERN-1 は evaluator prompt の未解消 concern 一覧に
// 載らず concern_resolutions でも解消できない）。ソース文字列 pin は置かない（issue #636）。
