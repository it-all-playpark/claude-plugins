import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  TESTSURF_PATTERNS,
  testsurfHitsOf,
  secHitsOf,
  testsurfPatternsOf,
  reconcileTestsurf,
} from './testsurf.mjs';
import { GATE_POLICIES, gateLane } from './gate-policy.mjs';

// ---- TESTSURF_PATTERNS ----

test('TESTSURF_PATTERNS は spike #361 採用の 6 content パターン固定順', () => {
  assert.deepEqual(TESTSURF_PATTERNS, ['skip', 'only', 'todo', 'xfail', 'tautology', 'exclude-cfg']);
});

// ---- testsurfHitsOf / secHitsOf ----

test('testsurfHitsOf: risk null は空配列', () => {
  assert.deepEqual(testsurfHitsOf(null), []);
});

test('testsurfHitsOf: risk.ok!==true は空配列', () => {
  assert.deepEqual(testsurfHitsOf({ ok: false, hits: [{ class: 'test-weakening', pattern: 'skip' }] }), []);
});

test('testsurfHitsOf: class===test-weakening の hit のみ抽出', () => {
  const risk = {
    ok: true,
    hits: [
      { file: 'a.test.js', class: 'test-weakening', pattern: 'skip' },
      { file: 'b.js', class: 'auth' },
    ],
  };
  assert.deepEqual(testsurfHitsOf(risk), [{ file: 'a.test.js', class: 'test-weakening', pattern: 'skip' }]);
});

test('secHitsOf: class!==test-weakening の hit のみ抽出（danger_hits/dangerHits への test-weakening 混入防止）', () => {
  const risk = {
    ok: true,
    hits: [
      { file: 'a.test.js', class: 'test-weakening', pattern: 'skip' },
      { file: 'b.js', class: 'auth' },
      { file: 'c.js', class: 'crypto' },
    ],
  };
  assert.deepEqual(secHitsOf(risk), [{ file: 'b.js', class: 'auth' }, { file: 'c.js', class: 'crypto' }]);
});

test('secHitsOf: risk null / ok!==true は空配列', () => {
  assert.deepEqual(secHitsOf(null), []);
  assert.deepEqual(secHitsOf({ ok: false, hits: [{ class: 'auth' }] }), []);
});

// ---- testsurfPatternsOf ----

test('testsurfPatternsOf: pattern を dedup した配列を返す', () => {
  const risk = {
    ok: true,
    hits: [
      { file: 'a.test.js', class: 'test-weakening', pattern: 'skip' },
      { file: 'b.test.js', class: 'test-weakening', pattern: 'skip' },
      { file: 'c.test.js', class: 'test-weakening', pattern: 'only' },
    ],
  };
  assert.deepEqual(testsurfPatternsOf(risk), ['skip', 'only']);
});

test('testsurfPatternsOf: pattern 欠落は unknown にバケット', () => {
  const risk = { ok: true, hits: [{ file: 'a.test.js', class: 'test-weakening' }] };
  assert.deepEqual(testsurfPatternsOf(risk), ['unknown']);
});

// ---- reconcileTestsurf ----

function emptyLedger() {
  return { items: [], round: 0 };
}

test('(a) hit -> TESTSURF-SKIP が critical/seed/floor:true/checked:false/test-integrity/deterministic で seed される', () => {
  const risk = { ok: true, hits: [{ file: 'a.test.js', class: 'test-weakening', pattern: 'skip' }] };
  const out = reconcileTestsurf(emptyLedger(), risk);
  assert.equal(out.items.length, 1);
  const item = out.items[0];
  assert.equal(item.id, 'TESTSURF-SKIP');
  assert.equal(item.severity, 'critical');
  assert.equal(item.source, 'seed');
  assert.equal(item.floor, true);
  assert.equal(item.checked, false);
  assert.equal(item.dimension, 'test-integrity');
  assert.deepEqual(item.check, { kind: 'deterministic' });
  assert.equal(item.evidence, null);
  assert.match(item.text, /skip/);
  assert.match(item.text, /a\.test\.js/);
});

test('(b) 複数 pattern -> 複数 item、同一 pattern 複数ファイルは 1 item に file 一覧', () => {
  const risk = {
    ok: true,
    hits: [
      { file: 'a.test.js', class: 'test-weakening', pattern: 'skip' },
      { file: 'b.test.js', class: 'test-weakening', pattern: 'skip' },
      { file: 'c.test.js', class: 'test-weakening', pattern: 'only' },
    ],
  };
  const out = reconcileTestsurf(emptyLedger(), risk);
  assert.equal(out.items.length, 2);
  const skipItem = out.items.find((it) => it.id === 'TESTSURF-SKIP');
  const onlyItem = out.items.find((it) => it.id === 'TESTSURF-ONLY');
  assert.ok(skipItem);
  assert.ok(onlyItem);
  assert.match(skipItem.text, /a\.test\.js/);
  assert.match(skipItem.text, /b\.test\.js/);
  assert.match(onlyItem.text, /c\.test\.js/);
});

test('(c) pattern 欠落 hit -> TESTSURF-UNKNOWN', () => {
  const risk = { ok: true, hits: [{ file: 'a.test.js', class: 'test-weakening' }] };
  const out = reconcileTestsurf(emptyLedger(), risk);
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].id, 'TESTSURF-UNKNOWN');
});

test('exclude-cfg パターンは TESTSURF-EXCLUDE-CFG になる', () => {
  const risk = { ok: true, hits: [{ file: 'vitest.config.mjs', class: 'test-weakening', pattern: 'exclude-cfg' }] };
  const out = reconcileTestsurf(emptyLedger(), risk);
  assert.equal(out.items[0].id, 'TESTSURF-EXCLUDE-CFG');
});

test('(d) risk.ok:false -> ledger 完全不変(deep-equal)', () => {
  const ledger = {
    items: [{ id: 'TESTSURF-SKIP', dimension: 'test-integrity', source: 'seed', checked: false, floor: true, evidence: null, severity: 'critical', text: 'x', check: { kind: 'deterministic' } }],
    round: 3,
  };
  const before = JSON.parse(JSON.stringify(ledger));
  const out = reconcileTestsurf(ledger, { ok: false, hits: [] });
  assert.deepEqual(out, before);
});

test('(e) risk null -> ledger 完全不変(deep-equal)', () => {
  const ledger = {
    items: [{ id: 'TESTSURF-SKIP', dimension: 'test-integrity', source: 'seed', checked: false, floor: true, evidence: null, severity: 'critical', text: 'x', check: { kind: 'deterministic' } }],
    round: 3,
  };
  const before = JSON.parse(JSON.stringify(ledger));
  const out = reconcileTestsurf(ledger, null);
  assert.deepEqual(out, before);
});

test('(f) clearance 済み(checked:true, floor:true) item は同 pattern 再 hit でも checked 維持', () => {
  const ledger = {
    items: [{
      id: 'TESTSURF-SKIP', dimension: 'test-integrity', source: 'seed', checked: true, floor: true,
      evidence: 'evaluator clearance: refactor confirmed safe', severity: 'critical', text: 'test-surface 縮小検出(skip): a.test.js',
      check: { kind: 'deterministic' },
    }],
    round: 5,
  };
  const risk = { ok: true, hits: [{ file: 'a.test.js', class: 'test-weakening', pattern: 'skip' }] };
  const out = reconcileTestsurf(ledger, risk);
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].checked, true);
  assert.equal(out.items[0].floor, true);
  assert.equal(out.items[0].evidence, 'evaluator clearance: refactor confirmed safe');
});

test('(g) clean 自動解決済み(checked:true, floor:false) item の再 hit -> unchecked 復活', () => {
  const ledger = {
    items: [{
      id: 'TESTSURF-SKIP', dimension: 'test-integrity', source: 'seed', checked: true, floor: false,
      evidence: 'testsurf clean (pattern no longer detected)', severity: 'critical', text: 'test-surface 縮小検出(skip): a.test.js',
      check: { kind: 'deterministic' },
    }],
    round: 6,
  };
  const risk = { ok: true, hits: [{ file: 'a.test.js', class: 'test-weakening', pattern: 'skip' }] };
  const out = reconcileTestsurf(ledger, risk);
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].checked, false);
  assert.equal(out.items[0].floor, true);
  assert.equal(out.items[0].evidence, null);
});

test('(h) hit 消滅 -> checked:true + testsurf clean evidence（floor は touch しない）', () => {
  const ledger = {
    items: [{
      id: 'TESTSURF-SKIP', dimension: 'test-integrity', source: 'seed', checked: false, floor: true,
      evidence: null, severity: 'critical', text: 'test-surface 縮小検出(skip): a.test.js',
      check: { kind: 'deterministic' },
    }],
    round: 7,
  };
  const out = reconcileTestsurf(ledger, { ok: true, hits: [] });
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].checked, true);
  assert.equal(out.items[0].floor, true); // untouched
  assert.match(out.items[0].evidence, /testsurf clean/);
});

test('(i) SEC-* item や AC-* item を一切 touch しない', () => {
  const ledger = {
    items: [
      { id: 'SEC-AUTH', dimension: 'security', source: 'seed', checked: false, floor: false, evidence: null, severity: 'major', text: 'x', check: { kind: 'deterministic' }, danger_class: 'auth' },
      { id: 'AC-1', dimension: 'ac', source: 'ac', checked: false, evidence: null, severity: 'major', text: 'y' },
    ],
    round: 2,
  };
  const before = JSON.parse(JSON.stringify(ledger));
  const risk = { ok: true, hits: [{ file: 'a.test.js', class: 'test-weakening', pattern: 'skip' }] };
  const out = reconcileTestsurf(ledger, risk);
  assert.deepEqual(out.items[0], before.items[0]);
  assert.deepEqual(out.items[1], before.items[1]);
  // 新規 TESTSURF item は追加される
  assert.equal(out.items.length, 3);
  assert.ok(out.items.some((it) => it.id === 'TESTSURF-SKIP'));
});

test('(j) 入力 ledger を mutate しない', () => {
  const ledger = {
    items: [{
      id: 'TESTSURF-SKIP', dimension: 'test-integrity', source: 'seed', checked: false, floor: true,
      evidence: null, severity: 'critical', text: 'test-surface 縮小検出(skip): a.test.js',
      check: { kind: 'deterministic' },
    }],
    round: 1,
  };
  const snapshot = JSON.parse(JSON.stringify(ledger));
  reconcileTestsurf(ledger, { ok: true, hits: [] });
  assert.deepEqual(ledger, snapshot);
});

test('(k) 既存 TESTSURF id への重複 append なし（単調性）', () => {
  const ledger = {
    items: [{
      id: 'TESTSURF-SKIP', dimension: 'test-integrity', source: 'seed', checked: false, floor: true,
      evidence: null, severity: 'critical', text: 'test-surface 縮小検出(skip): a.test.js',
      check: { kind: 'deterministic' },
    }],
    round: 1,
  };
  const risk = { ok: true, hits: [{ file: 'a.test.js', class: 'test-weakening', pattern: 'skip' }] };
  const out = reconcileTestsurf(ledger, risk);
  assert.equal(out.items.filter((it) => it.id === 'TESTSURF-SKIP').length, 1);
});

test('gateLane 連携: TESTSURF seed item は全 policy で blocking lane になる', () => {
  const risk = { ok: true, hits: [{ file: 'a.test.js', class: 'test-weakening', pattern: 'skip' }] };
  const out = reconcileTestsurf(emptyLedger(), risk);
  for (const p of GATE_POLICIES) {
    assert.equal(gateLane(out.items[0], p), 'blocking', `policy=${p}`);
  }
});
