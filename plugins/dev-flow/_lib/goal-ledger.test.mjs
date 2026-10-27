import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  makeLedger, topicKey, canAppend, appendItem,
  checkItem, nextRound, setCheck, triageItem, setFinalResolution, reopenItem,
} from './goal-ledger.mjs';
import { gateLane, DEFAULT_GATE_POLICY } from './gate-policy.mjs';

const ac = (over = {}) => ({ id: 'AC-1', text: 'returns 200', dimension: 'ac', severity: 'major', source: 'ac', ...over });

test('topicKey: dimension + 正規化 text', () => {
  assert.equal(topicKey({ dimension: 'security', text: '  No  SQL Injection ' }), 'security::no sql injection');
});

test('canAppend: round 0 は何でも可', () => {
  const l = makeLedger();
  assert.equal(canAppend(l, ac({ severity: 'minor' })), true);
});
test('canAppend: round>=1 は既出 topic か critical のみ', () => {
  let { ledger } = appendItem(makeLedger(), ac({ id: 'A', text: 'foo', dimension: 'd', severity: 'major' }));
  ledger = nextRound(ledger);
  assert.equal(canAppend(ledger, ac({ id: 'B', text: 'foo', dimension: 'd', severity: 'minor' })), true);
  assert.equal(canAppend(ledger, ac({ id: 'C', text: 'bar', dimension: 'd', severity: 'minor' })), false);
  assert.equal(canAppend(ledger, ac({ id: 'D', text: 'baz', dimension: 'd', severity: 'critical' })), true);
});

test('appendItem: 受理で accepted:true、新規は default 補完', () => {
  const { ledger, accepted } = appendItem(makeLedger(), ac({ id: 'A' }));
  assert.equal(accepted, true);
  assert.equal(ledger.items.length, 1);
  assert.equal(ledger.items[0].checked, false);
  assert.equal(ledger.items[0].floor, false);
});
test('appendItem: 単調性違反は accepted:false で ledger 不変', () => {
  let { ledger } = appendItem(makeLedger(), ac({ id: 'A', text: 'foo', dimension: 'd' }));
  ledger = nextRound(ledger);
  const res = appendItem(ledger, ac({ id: 'C', text: 'bar', dimension: 'd', severity: 'minor' }));
  assert.equal(res.accepted, false);
  assert.equal(res.ledger.items.length, 1);
});
test('appendItem: 既出 topic は id を保ったまま更新', () => {
  let { ledger } = appendItem(makeLedger(), ac({ id: 'A', text: 'foo', dimension: 'd', severity: 'minor' }));
  ledger = nextRound(ledger);
  const { ledger: l2 } = appendItem(ledger, ac({ id: 'IGNORED', text: 'foo', dimension: 'd', severity: 'critical' }));
  assert.equal(l2.items.length, 1);
  assert.equal(l2.items[0].id, 'A');
  assert.equal(l2.items[0].severity, 'critical');
});

test('checkItem: id で checked + evidence', () => {
  const { ledger } = appendItem(makeLedger(), ac({ id: 'A' }));
  const l2 = checkItem(ledger, 'A', 'test passed');
  assert.equal(l2.items[0].checked, true);
  assert.equal(l2.items[0].evidence, 'test passed');
});
test('checkItem: 未知 id は throw', () => {
  assert.throws(() => checkItem(makeLedger(), 'X', 'e'), /未知の item id/);
});

test('appendItem: round 0 は同一 topicKey でも別 item として積む（distinct AC を合流させない）', () => {
  let { ledger } = appendItem(makeLedger(), { id: 'AC-1', text: 'same', dimension: 'ac', severity: 'major', source: 'ac' });
  ({ ledger } = appendItem(ledger, { id: 'AC-2', text: 'same', dimension: 'ac', severity: 'major', source: 'ac' }));
  assert.equal(ledger.items.length, 2);
  assert.deepEqual(ledger.items.map((i) => i.id), ['AC-1', 'AC-2']);
});
test('setCheck: 既存 item の check 種別を更新（inspection→deterministic で blocking 昇格）', () => {
  let { ledger } = appendItem(makeLedger(), { id: 'AC-1', text: 'x', dimension: 'ac', severity: 'major', source: 'ac', check: { kind: 'inspection' } });
  assert.equal(gateLane(ledger.items[0], DEFAULT_GATE_POLICY), 'advisory');
  ledger = setCheck(ledger, 'AC-1', { kind: 'deterministic' });
  assert.equal(ledger.items[0].check.kind, 'deterministic');
  assert.equal(gateLane(ledger.items[0], DEFAULT_GATE_POLICY), 'blocking');
});
test('setCheck: 未知 id は throw', () => {
  assert.throws(() => setCheck(makeLedger(), 'X', { kind: 'deterministic' }), /未知の item id/);
});
test('appendItem: check は shallow-clone され caller mutation の影響を受けない', () => {
  const check = { kind: 'inspection' };
  const { ledger } = appendItem(makeLedger(), { id: 'A', text: 'x', dimension: 'd', severity: 'major', source: 'ac', check });
  check.kind = 'deterministic';                       // caller が後から変更
  assert.equal(ledger.items[0].check.kind, 'inspection'); // ledger 側は不変
});

// issue #614: triaged は表示専用で checked/evidence を変えない
test('triageItem: triaged + triaged_evidence を付け checked/evidence は不変', () => {
  const { ledger } = appendItem(makeLedger(), ac({ id: 'A' }));
  const l2 = triageItem(ledger, 'A', 'why');
  assert.equal(l2.items[0].triaged, true);
  assert.equal(l2.items[0].triaged_evidence, 'why');
  assert.equal(l2.items[0].checked, false);
  assert.equal(l2.items[0].evidence, null);
});
test('triageItem: 未知 id は throw', () => {
  assert.throws(() => triageItem(makeLedger(), 'X', 'e'), /未知の item id/);
});
test('triageItem: 元 ledger を mutate しない', () => {
  const { ledger } = appendItem(makeLedger(), ac({ id: 'A' }));
  triageItem(ledger, 'A', 'why');
  assert.equal(ledger.items[0].triaged, undefined);
});
test('triageItem 後の checkItem は checked:true になり triaged も残る', () => {
  const { ledger } = appendItem(makeLedger(), ac({ id: 'A' }));
  const l2 = triageItem(ledger, 'A', 'why');
  const l3 = checkItem(l2, 'A', 'evidence text');
  assert.equal(l3.items[0].checked, true);
  assert.equal(l3.items[0].evidence, 'evidence text');
  assert.equal(l3.items[0].triaged, true);
  assert.equal(l3.items[0].triaged_evidence, 'why');
});

// issue #444: deterministic 昇格 + checked 済み item への再昇格操作は ledger 上の no-op である
// （skip した AC の ledger 状態が skip しない場合と同一であることの純関数レベル回帰固定）
test('U1: 昇格済み AC への再昇格は skip と同値（no-op 性）', () => {
  let { ledger } = appendItem(makeLedger(), { id: 'AC-1', text: 'a', dimension: 'ac', severity: 'major', source: 'ac', check: { kind: 'inspection' } });
  ledger = setCheck(ledger, 'AC-1', { kind: 'deterministic' });
  const l1 = checkItem(ledger, 'AC-1', 'red→green 実証: t.test.mjs');

  const item1 = l1.items.find((i) => i.id === 'AC-1');
  assert.equal(item1.checked, true);
  assert.deepEqual(item1.check, { kind: 'deterministic' });
  assert.equal(item1.evidence, 'red→green 実証: t.test.mjs');

  let l2 = setCheck(l1, 'AC-1', { kind: 'deterministic' });
  l2 = checkItem(l2, 'AC-1', 'red→green 実証: t.test.mjs');
  const item2 = l2.items.find((i) => i.id === 'AC-1');

  assert.deepEqual(item2, item1); // skip == 再実行の同値性
});

// issue #658: final_resolution/final_evidence は表示専用で checked/evidence/triaged を変えない
test('setFinalResolution: final_resolution + final_evidence を付け checked/evidence/triaged は不変', () => {
  const { ledger } = appendItem(makeLedger(), ac({ id: 'A' }));
  const triaged = triageItem(ledger, 'A', 'triage理由');
  const l2 = setFinalResolution(triaged, 'A', 'resolved', 'commit abc123 で revert 済み');
  assert.equal(l2.items[0].final_resolution, 'resolved');
  assert.equal(l2.items[0].final_evidence, 'commit abc123 で revert 済み');
  assert.equal(l2.items[0].checked, false);
  assert.equal(l2.items[0].evidence, null);
  assert.equal(l2.items[0].triaged, true);
  assert.equal(l2.items[0].triaged_evidence, 'triage理由');
});
test('setFinalResolution: evidence 省略時は final_evidence が null に正規化される', () => {
  const { ledger } = appendItem(makeLedger(), ac({ id: 'A' }));
  const l2 = setFinalResolution(ledger, 'A', 'unresolved');
  assert.equal(l2.items[0].final_resolution, 'unresolved');
  assert.equal(l2.items[0].final_evidence, null);
});
test('setFinalResolution: 元 ledger を mutate しない', () => {
  const { ledger } = appendItem(makeLedger(), ac({ id: 'A' }));
  setFinalResolution(ledger, 'A', 'resolved', 'commit abc で修正');
  assert.equal(ledger.items[0].final_resolution, undefined);
});
test('setFinalResolution: 未知 id は throw', () => {
  assert.throws(() => setFinalResolution(makeLedger(), 'X', 'resolved', 'e'), /未知の item id/);
});
test('setFinalResolution: enum 外 resolution（撤去した ci_delegated を含む）は throw', () => {
  const { ledger } = appendItem(makeLedger(), ac({ id: 'A' }));
  for (const resolution of ['partially', 'ci_delegated']) {
    assert.throws(() => setFinalResolution(ledger, 'A', resolution, 'e'), /不正な final_resolution/, resolution);
  }
});

test('U2: 単調不可逆性（決定論 item の checked を true→false に戻す経路が無い）', () => {
  let { ledger } = appendItem(makeLedger(), { id: 'AC-1', text: 'a', dimension: 'ac', severity: 'major', source: 'ac', check: { kind: 'inspection' } });
  ledger = setCheck(ledger, 'AC-1', { kind: 'deterministic' });
  const l1 = checkItem(ledger, 'AC-1', 'red→green 実証: t.test.mjs');
  assert.throws(() => reopenItem(l1, 'AC-1', 'x'), /決定論 item "AC-1" は reopen しない/);

  // checkItem を別 evidence で再適用しても checked/check.kind は保持され evidence のみ変わる
  const l1b = checkItem(l1, 'AC-1', '別の evidence');
  const item1b = l1b.items.find((i) => i.id === 'AC-1');
  assert.equal(item1b.checked, true);
  assert.equal(item1b.check.kind, 'deterministic');
  assert.equal(item1b.evidence, '別の evidence');

  // appendItem の merge 経路（同一 topicKey の item を round>0 で上書き）でも
  // item 側に checked が明示されない限り既存の checked は保持される
  const roundedLedger = nextRound(l1);
  const { ledger: l3 } = appendItem(roundedLedger, { id: 'X', text: 'a', dimension: 'ac', severity: 'critical', source: 'evaluator', check: { kind: 'inspection' } });
  const item3 = l3.items.find((i) => i.id === 'AC-1');
  assert.equal(item3.checked, true); // merge しても checked は false に戻らない
});

test('reopenItem: LLM 判断で checked の item を未解消に戻し、evidence を差し替える（元 ledger は不変）', () => {
  let { ledger } = appendItem(makeLedger(), { id: 'EVAL-1-X', text: 'x', dimension: 'quality', severity: 'critical', source: 'evaluator', check: { kind: 'inspection' } });
  ledger = checkItem(ledger, 'EVAL-1-X', '取り消し済み');
  const reopened = reopenItem(ledger, 'EVAL-1-X', '再検証で不成立');
  const it = reopened.items.find((i) => i.id === 'EVAL-1-X');
  assert.equal(it.checked, false);
  assert.equal(it.evidence, '再検証で不成立');
  assert.equal(ledger.items[0].checked, true);
  // critical は reopen 後もどの policy でも blocking（未 checked のため収束しない）
  assert.equal(gateLane(it, DEFAULT_GATE_POLICY), 'blocking');
});

test('reopenItem: seed（SEC / TESTSURF）は reopen しない（throw）', () => {
  let { ledger } = appendItem(makeLedger(), { id: 'SEC-AUTH', text: 'auth', dimension: 'security', severity: 'critical', source: 'seed', check: { kind: 'deterministic' } });
  ledger = checkItem(ledger, 'SEC-AUTH', 'clean');
  assert.throws(() => reopenItem(ledger, 'SEC-AUTH', 'x'), /決定論 item "SEC-AUTH" は reopen しない/);
  assert.throws(() => reopenItem(ledger, 'NOPE', 'x'), /未知の item id "NOPE"/);
});
