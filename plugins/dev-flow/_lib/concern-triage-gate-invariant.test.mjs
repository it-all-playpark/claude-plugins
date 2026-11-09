// issue #614 AC3: triaged (表示専用フラグ) の有無で
// isConvergedUnderPolicy / isLoopConvergedUnderPolicy / policyBlockingItems / policyAdvisoryItems /
// gateLane / classifyMergeTier の返り値が一切変化しないことを pin する。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { makeLedger, appendItem, triageItem } from './goal-ledger.mjs';
import {
  GATE_POLICIES, gateLane, isConvergedUnderPolicy, isLoopConvergedUnderPolicy,
  policyBlockingItems, policyAdvisoryItems,
} from './gate-policy.mjs';
import { classifyMergeTier, partitionUncheckedBlocking } from './merge-tier.mjs';

function buildLedger() {
  let { ledger } = appendItem(makeLedger(), {
    id: 'AC-1', text: 'returns 200', dimension: 'ac', severity: 'major', source: 'ac', check: { kind: 'inspection' },
  });
  ({ ledger } = appendItem(ledger, {
    id: 'CONCERN-1', text: '[plan:major] a: b', dimension: 'concern', severity: 'major', source: 'concern', check: { kind: 'inspection' },
  }));
  ({ ledger } = appendItem(ledger, {
    id: 'CONCERN-2', text: 'c', dimension: 'concern', severity: 'minor', source: 'concern', check: { kind: 'inspection' },
  }));
  return ledger;
}

function withTriage(ledger) {
  let l = triageItem(ledger, 'CONCERN-1', 'e1');
  l = triageItem(l, 'CONCERN-2', 'e2');
  return l;
}

test('AC3: 全 gate_policy で isConvergedUnderPolicy / isLoopConvergedUnderPolicy / blocking・advisory件数 / gateLane が triaged の有無で不変', () => {
  const plain = buildLedger();
  const triaged = withTriage(plain);

  for (const policy of GATE_POLICIES) {
    assert.equal(
      isConvergedUnderPolicy(triaged, policy),
      isConvergedUnderPolicy(plain, policy),
      `isConvergedUnderPolicy が policy=${policy} で不変であるべき`,
    );
    assert.equal(
      isLoopConvergedUnderPolicy(triaged, policy),
      isLoopConvergedUnderPolicy(plain, policy),
      `isLoopConvergedUnderPolicy が policy=${policy} で不変であるべき`,
    );
    assert.equal(
      policyBlockingItems(triaged, policy).length,
      policyBlockingItems(plain, policy).length,
      `policyBlockingItems の件数が policy=${policy} で不変であるべき`,
    );
    assert.equal(
      policyAdvisoryItems(triaged, policy).length,
      policyAdvisoryItems(plain, policy).length,
      `policyAdvisoryItems の件数が policy=${policy} で不変であるべき`,
    );
    for (const item of plain.items) {
      const triagedItem = triaged.items.find((it) => it.id === item.id);
      assert.equal(
        gateLane(triagedItem, policy),
        gateLane(item, policy),
        `gateLane(${item.id}) が policy=${policy} で不変であるべき`,
      );
    }
  }
});

test('AC3/AC5: llm-major-blocking では triaged にしても CONCERN-1(major) の収束は false のまま（triaged は checked の代替にならない）', () => {
  const plain = buildLedger();
  const triaged = withTriage(plain);

  assert.equal(isConvergedUnderPolicy(plain, 'llm-major-blocking'), false);
  assert.equal(isConvergedUnderPolicy(triaged, 'llm-major-blocking'), false);
});

function mergeTierInput(ledger) {
  return {
    ledgerUnconverged: partitionUncheckedBlocking(policyBlockingItems(ledger, 'llm-major-advisory'), { dangerFailClosed: false, riskValueDropped: false }).ledger_unconverged,
    unresolvedDanger: false,
    breakingStructured: false,
    breakingKeyword: false,
    escalateCount: 0,
    iterateStatus: 'lgtm',
    evalStaleness: 'none',
  };
}

test('AC3: classifyMergeTier の返り値が triaged の有無で一致する', () => {
  const plain = buildLedger();
  const triaged = withTriage(plain);

  const resultPlain = classifyMergeTier(mergeTierInput(plain));
  const resultTriaged = classifyMergeTier(mergeTierInput(triaged));
  assert.deepEqual(resultTriaged, resultPlain);
});

test('triageItem 後も checked===false かつ evidence===null で、triaged_evidence に evidence が入る', () => {
  const plain = buildLedger();
  const triaged = withTriage(plain);

  const c1 = triaged.items.find((it) => it.id === 'CONCERN-1');
  assert.equal(c1.checked, false);
  assert.equal(c1.evidence, null);
  assert.equal(c1.triaged, true);
  assert.equal(c1.triaged_evidence, 'e1');

  const c2 = triaged.items.find((it) => it.id === 'CONCERN-2');
  assert.equal(c2.checked, false);
  assert.equal(c2.evidence, null);
  assert.equal(c2.triaged, true);
  assert.equal(c2.triaged_evidence, 'e2');
});
