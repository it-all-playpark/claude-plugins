import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mdCell } from './md-cell.mjs';
import { buildDevflowSummaryBody } from './devflow-summary-format.mjs';
import { classifyMergeTier, seedSecurityLedger, reconcileDanger } from './merge-tier.mjs';

globalThis.mdCell = mdCell;

// ─── 共通テストデータ ───────────────────────────────────────────────────────────

const BASE_INPUT = {
  pr: 42,
  mergeTier: 'REVIEW',
  mergeTierReasons: ['LLM judge advisory'],
  gatePolicy: 'llm-major-advisory',
  blockingItems: [],
  advisoryItems: [],
  ledgerConverged: true,
  acResults: undefined,
  dangerHits: [],
  shape: 'standard',
  testGreen: true,
  evalVerdict: 'pass',
};

// SEC seed ledger item ヘルパー（merge-tier.mjs の seedDangerLedgerItems 形状に合わせる）。
// blockingItems の source:'seed' && dimension:'security' && floor:true item から
// buildDevflowSummaryBody が Security clearance セクションを導出する。
function secLedgerItem(dangerClass, { checked = false, evidence = null, floor = true, failClosed } = {}) {
  const item = {
    id: `SEC-${dangerClass.toUpperCase()}`,
    text: `danger-grep detected ${dangerClass}`,
    dimension: 'security',
    severity: 'critical',
    source: 'seed',
    floor,
    checked,
    evidence,
    danger_class: dangerClass,
  };
  if (failClosed !== undefined) item.fail_closed = failClosed;
  return item;
}

// TESTSURF seed ledger item ヘルパー（SEC seed item と同型。issue #362）。
// blockingItems の source:'seed' && id が 'TESTSURF-' 始まりの item から
// buildDevflowSummaryBody が TESTSURF セクションを導出する。
function testsurfLedgerItem(pattern, { checked = false, evidence = null } = {}) {
  return {
    id: `TESTSURF-${pattern.toUpperCase()}`,
    text: `test-weakening detected: ${pattern}`,
    dimension: 'test-integrity',
    severity: 'critical',
    source: 'seed',
    floor: true,
    checked,
    evidence,
  };
}

// ─── at-a-glance テーブル絵文字 ──────────────────────────────────────────────

test('at-a-glance テーブルにヘッダー行を含む', () => {
  const body = buildDevflowSummaryBody({ ...BASE_INPUT });
  assert.ok(body.includes('| Merge tier | shape | テスト | 評価 | 台帳 (Ledger) | AC | 危険検出 |'), 'ヘッダー行を含む');
});

const SIX_SATISFIED_AC = Array.from({ length: 6 }, (_, i) => (
  { ac_index: i, satisfied: true, evidence: `ok${i + 1}`, verified_by: 'evaluator' }
));

// name: 入力の上書き / input: BASE_INPUT への上書き / want: at-a-glance テーブルに含む表示
const AT_A_GLANCE_CASES = [
  { name: 'mergeTier=HOLD', input: { mergeTier: 'HOLD', mergeTierReasons: ['danger hit detected'] }, want: '🔶 **HOLD**' },
  { name: 'mergeTier=REVIEW', input: { mergeTier: 'REVIEW' }, want: '🔷 **REVIEW**' },
  { name: 'mergeTier=AUTO', input: { mergeTier: 'AUTO', mergeTierReasons: [] }, want: '✅ **AUTO**' },
  { name: 'testGreen=true', input: { testGreen: true }, want: '✅ green' },
  { name: 'testGreen=false', input: { testGreen: false }, want: '❌ red' },
  { name: 'testGreen=null', input: { testGreen: null }, want: '不明' },
  { name: 'evalVerdict=pass', input: { evalVerdict: 'pass' }, want: '✅ pass' },
  { name: 'evalVerdict=fail', input: { evalVerdict: 'fail' }, want: '❌ fail' },
  { name: 'evalVerdict=null', input: { evalVerdict: null }, want: '不明' },
  { name: 'ledgerConverged=true', input: { ledgerConverged: true }, want: '✅ 収束' },
  { name: 'ledgerConverged=false', input: { ledgerConverged: false }, want: '⚠️ 未収束' },
  { name: 'dangerHits 2件', input: { dangerHits: ['SQL_INJECTION', 'PATH_TRAVERSAL'] }, want: '⚠️ 2 クラス' },
  { name: 'dangerHits 0件', input: { dangerHits: [] }, want: '✅ clean' },
  { name: 'acResults 6件全 satisfied', input: { acResults: SIX_SATISFIED_AC }, want: '✅ 6/6' },
  { name: 'acResults undefined', input: { acResults: undefined }, want: '—' },
  { name: 'shape=complex', input: { shape: 'complex' }, want: 'complex' },
  { name: 'shape=null', input: { shape: null }, want: '不明' },
];

test.each(AT_A_GLANCE_CASES)('$name -> at-a-glance テーブルに「$want」を含む', ({ input, want }) => {
  const body = buildDevflowSummaryBody({ ...BASE_INPUT, ...input });
  assert.ok(body.includes(want), `「${want}」を含む`);
});

// ─── gatePolicy ───────────────────────────────────────────────────────────────

test('issue #829: gatePolicy は本文の行に出さず、末尾マーカー直前の HTML コメントに出る', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    gatePolicy: 'llm-major-advisory',
  });
  const lines = body.split('\n');
  assert.ok(!lines.some(l => l.startsWith('gate_policy:')), '本文に gate_policy 行を出さない');
  assert.ok(!body.includes('`llm-major-advisory`'), '本文にバッククォート付きの gate_policy を出さない');
  assert.deepEqual(lines.slice(-2), ['<!-- gate_policy: llm-major-advisory -->', '<!-- dev-flow:REVIEW -->'], '末尾マーカー直前の HTML コメント');
});

// ─── dangerHits 検出クラス ────────────────────────────────────────────────────

test('dangerHits 2件 -> 「検出クラス: SQL_INJECTION, PATH_TRAVERSAL」行を含む', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    dangerHits: ['SQL_INJECTION', 'PATH_TRAVERSAL'],
  });
  assert.ok(body.includes('検出クラス: SQL_INJECTION, PATH_TRAVERSAL'), '検出クラス行を含む');
});

test('dangerHits 0件 -> 「検出クラス:」行を含まない', () => {
  const body = buildDevflowSummaryBody({ ...BASE_INPUT, dangerHits: [] });
  assert.ok(!body.includes('検出クラス:'), '検出クラス行を含まない');
});

// ─── Merge tier 理由 ──────────────────────────────────────────────────────────

test('mergeTierReasons が空の場合、HOLD（holdReasons なしのフォールバック）は「理由記載なし」を出し、AUTO / REVIEW は理由の節を出さない', () => {
  const hold = buildDevflowSummaryBody({
    ...BASE_INPUT,
    mergeTier: 'HOLD',
    mergeTierReasons: [],
  });
  assert.ok(hold.includes('理由記載なし'), 'HOLD は reasons 空時も理由の節を残す');
  for (const tier of ['AUTO', 'REVIEW']) {
    const body = buildDevflowSummaryBody({ ...BASE_INPUT, mergeTier: tier, mergeTierReasons: [] });
    assert.ok(!body.includes('**Merge tier 理由**'), `${tier}: 理由の節を出さない`);
    assert.ok(!body.includes('理由記載なし'), `${tier}: 情報ゼロの定型行を出さない`);
  }
});

test('mergeTierReasons が複数件の場合はすべてを含む', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    mergeTier: 'HOLD',
    mergeTierReasons: ['reason A', 'reason B', 'reason C'],
  });
  assert.ok(body.includes('reason A'), '1件目を含む');
  assert.ok(body.includes('reason B'), '2件目を含む');
  assert.ok(body.includes('reason C'), '3件目を含む');
});

test('Merge tier 理由セクションは常時可視（details 前）', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    mergeTier: 'REVIEW',
    mergeTierReasons: ['advisory item present'],
    blockingItems: [
      { id: 'B1', text: 'check this', severity: 'critical', checked: false, dimension: 'security' },
    ],
  });
  const countHeadingIdx = body.indexOf('**解消済み証跡');
  const reasonIdx = body.indexOf('advisory item present');
  if (countHeadingIdx >= 0) {
    assert.ok(reasonIdx < countHeadingIdx, 'Merge tier 理由は件数見出しより前');
  } else {
    assert.ok(reasonIdx >= 0, 'Merge tier 理由を含む');
  }
});

// ─── 常時可視 invariant (AC-2) ────────────────────────────────────────────────

test('常時可視 invariant: unchecked blocking item が details より前に出る', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    blockingItems: [
      { id: 'B1', text: 'unchecked blocking text', severity: 'critical', checked: false, dimension: 'security' },
    ],
    advisoryItems: [
      { id: 'A1', text: 'checked advisory', severity: 'minor', checked: true, dimension: 'style', escalate: false },
    ],
  });
  const countHeadingIdx = body.indexOf('**解消済み証跡');
  const blockingIdx = body.indexOf('unchecked blocking text');
  assert.ok(blockingIdx >= 0, 'blocking text を含む');
  if (countHeadingIdx >= 0) {
    assert.ok(blockingIdx < countHeadingIdx, 'unchecked blocking が件数見出しより前');
  }
});

test('常時可視 invariant: 未達 AC が details より前に出る', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    acResults: [
      { ac_index: 0, satisfied: false, evidence: 'failed evidence', verified_by: 'evaluator' },
      { ac_index: 1, satisfied: true, evidence: 'passed', verified_by: 'evaluator' },
    ],
  });
  const countHeadingIdx = body.indexOf('**解消済み証跡');
  const failedIdx = body.indexOf('AC#1');
  assert.ok(failedIdx >= 0, '未達 AC を含む');
  if (countHeadingIdx >= 0) {
    assert.ok(failedIdx < countHeadingIdx, '未達 AC が件数見出しより前');
  }
});

test('常時可視 invariant: 未確認 clearance が details より前に出る', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    blockingItems: [
      secLedgerItem('XSS', { checked: false, evidence: '' }),
      secLedgerItem('SQL_INJECTION', { checked: true, evidence: 'ok' }),
    ],
  });
  const countHeadingIdx = body.indexOf('**解消済み証跡');
  const unclearedIdx = body.indexOf('XSS');
  assert.ok(unclearedIdx >= 0, '未確認 clearance を含む');
  if (countHeadingIdx >= 0) {
    assert.ok(unclearedIdx < countHeadingIdx, '未確認 clearance が件数見出しより前');
  }
});

// ─── 要対応セクション (AC-2) ──────────────────────────────────────────────────

test('要対応ゼロ -> 「### ✅ 要対応事項なし」を含み「### ⚠️ 要対応」を含まない', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    blockingItems: [
      { id: 'B1', text: 'resolved', severity: 'major', checked: true, dimension: 'quality' },
      secLedgerItem('SQL_INJECTION', { checked: true, evidence: 'safe' }),
    ],
    advisoryItems: [
      { id: 'A1', text: 'resolved advisory', severity: 'minor', checked: true, dimension: 'style', escalate: false },
    ],
    acResults: [
      { ac_index: 0, satisfied: true, evidence: 'ok', verified_by: 'evaluator' },
    ],
  });
  assert.ok(body.includes('### ✅ 要対応事項なし'), '要対応事項なしを含む');
  assert.ok(!body.includes('### ⚠️ 要対応'), '⚠️ 要対応を含まない');
});

test('unchecked blocking item あり -> 「### ⚠️ 要対応」を含む', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    blockingItems: [
      { id: 'B1', text: 'unresolved', severity: 'critical', checked: false, dimension: 'security' },
    ],
  });
  assert.ok(body.includes('### ⚠️ 要対応'), '要対応を含む');
  assert.ok(!body.includes('### ✅ 要対応事項なし'), '要対応事項なしを含まない');
});

test('未達 AC あり -> 「### ⚠️ 要対応」を含む', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    acResults: [
      { ac_index: 0, satisfied: false, evidence: 'fail', verified_by: 'evaluator' },
    ],
  });
  assert.ok(body.includes('### ⚠️ 要対応'), '要対応を含む');
});

test('escalate=true かつ checked=true の advisory item が要対応テーブルに出る', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    advisoryItems: [
      { id: 'A1', text: 'escalated but checked', severity: 'major', checked: true, dimension: 'quality', escalate: true, escalate_reason: 'human needed' },
    ],
  });
  assert.ok(body.includes('### ⚠️ 要対応'), '要対応を含む（escalate checked でも常時可視）');
  assert.ok(body.includes('要判断（advisory ESCALATE）'), '要判断（advisory ESCALATE）lane を含む');
  const detailsIdx = body.indexOf('<details>');
  const escalateIdx = body.indexOf('escalated but checked');
  assert.ok(escalateIdx >= 0, 'escalate item text を含む');
  if (detailsIdx >= 0) {
    assert.ok(escalateIdx < detailsIdx, 'escalate item が details より前');
  }
});

test('ledger 未解消テーブルに「❌ 未解消」状態を含む', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    blockingItems: [
      { id: 'B1', text: 'blocking text', severity: 'critical', checked: false, dimension: 'security' },
    ],
  });
  assert.ok(body.includes('❌ 未解消'), '未解消状態を含む');
});

test('escalate=true checked=true -> テーブルに「⚠️ 要判断」状態を含む', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    advisoryItems: [
      { id: 'A1', text: 'escalated checked', severity: 'major', checked: true, dimension: 'quality', escalate: true },
    ],
  });
  assert.ok(body.includes('⚠️ 要判断'), '要判断状態を含む');
});

test('ledger テーブルに | 状態 | 区分 | 観点 | 内容 | ヘッダーを含む（id 列なし）', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    blockingItems: [
      { id: 'B1', text: 'check', severity: 'critical', checked: false, dimension: 'security' },
    ],
  });
  assert.ok(body.includes('| 状態 | 区分 | 観点 | 内容 |'), 'ledger テーブルヘッダーを含む');
  assert.ok(!body.includes('| B1 |'), 'id セルを含まない');
});

test('blocking item の区分が「必須（blocking）」', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    blockingItems: [
      { id: 'B1', text: 'blocking item', severity: 'critical', checked: false, dimension: 'security' },
    ],
  });
  const lines = body.split('\n');
  const itemLine = lines.find(l => l.includes('blocking item'));
  assert.ok(itemLine, 'blocking item 行を含む');
  assert.ok(itemLine.includes('| 必須（blocking） |'), '必須（blocking）区分を含む');
});

test('advisory item の区分が「助言（advisory）」', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    advisoryItems: [
      { id: 'A1', text: 'advisory item', severity: 'minor', checked: false, dimension: 'style', escalate: false },
    ],
  });
  const lines = body.split('\n');
  const itemLine = lines.find(l => l.includes('advisory item'));
  assert.ok(itemLine, 'advisory item 行を含む');
  assert.ok(itemLine.includes('| 助言（advisory） |'), '助言（advisory）区分を含む');
});

test('escalate advisory item の区分が「要判断（advisory ESCALATE）」', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    advisoryItems: [
      { id: 'A1', text: 'escalated advisory', severity: 'major', checked: false, dimension: 'quality', escalate: true },
    ],
  });
  const lines = body.split('\n');
  const itemLine = lines.find(l => l.includes('escalated advisory'));
  assert.ok(itemLine, 'escalated advisory 行を含む');
  assert.ok(itemLine.includes('| 要判断（advisory ESCALATE） |'), '要判断（advisory ESCALATE）区分を含む');
});

test('ledger item に escalate_reason があれば対応列に「要判断（...）」で反映される（issue #658）', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    advisoryItems: [
      { id: 'A1', text: 'escalated', severity: 'major', checked: false, dimension: 'quality', escalate: true, escalate_reason: 'needs human review' },
    ],
  });
  assert.ok(body.includes('要判断（needs human review）'), 'escalate_reason が対応列の要判断（...）に反映される');
});

test('未達 AC テーブルに | 状態 | AC | 検証 | 根拠 | ヘッダーを含む', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    acResults: [
      { ac_index: 0, satisfied: false, evidence: 'fail', verified_by: 'evaluator' },
    ],
  });
  assert.ok(body.includes('| 状態 | AC | 検証 | 根拠 |'), 'AC テーブルヘッダーを含む');
});

test('未確認 clearance テーブルに | 状態 | danger class | 根拠 | ヘッダーを含む', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    blockingItems: [
      secLedgerItem('XSS', { checked: false, evidence: '' }),
    ],
  });
  assert.ok(body.includes('| 状態 | danger class | 根拠 |'), 'clearance テーブルヘッダーを含む');
});

// ─── エスケープ (AC-4) ────────────────────────────────────────────────────────

test('text に | を含む item でセルが \\\\| にエスケープされる', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    blockingItems: [
      { id: 'B1', text: 'text with | pipe', severity: 'critical', checked: false, dimension: 'security' },
    ],
  });
  assert.ok(body.includes('text with \\| pipe'), 'パイプがエスケープされる');
});

test('evidence に \\n を含む item でセルが <br> に変換される', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    blockingItems: [
      { id: 'B1', text: 'item', severity: 'critical', checked: false, dimension: 'security', evidence: 'line1\nline2' },
    ],
  });
  assert.ok(body.includes('line1<br>line2'), '改行が <br> に変換される');
});

// ─── 30 item + 件数縮約 (AC-3, issue #603) ───────────────────────────────────

test('checked item 30件 + unchecked 1件 -> 解消済みは折りたたみ内に 1 行ずつ・unchecked は全文で常時可視', () => {
  const blockingItems = [];
  for (let i = 0; i < 30; i++) {
    blockingItems.push({
      id: `B${i + 1}`,
      text: `checked item ${i + 1}`,
      severity: 'major',
      checked: true,
      dimension: 'quality',
      evidence: `evidence ${i + 1}`,
    });
  }
  blockingItems.push({
    id: 'B31',
    text: 'unchecked item 31',
    severity: 'critical',
    checked: false,
    dimension: 'security',
  });

  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    blockingItems,
  });

  // 件数行は折りたたみのサマリ行（issue #707）
  assert.ok(body.includes('<details><summary>✅ Goal Ledger 解消済み 30 件</summary>'), 'サマリ行に 30 件を含む');
  const countHeadingIdx = body.indexOf('**解消済み証跡');
  assert.ok(countHeadingIdx >= 0, '件数見出しを含む');

  // unchecked item は件数見出しより前に全文で出る
  const uncheckedIdx = body.indexOf('unchecked item 31');
  assert.ok(uncheckedIdx >= 0, 'unchecked item を含む');
  assert.ok(uncheckedIdx < countHeadingIdx, 'unchecked item が件数見出しより前');

  // checked item は折りたたみ内に 区分 / 内容 / 解消根拠 で 1 行ずつ出る（issue #707）
  const detailsRegion = body.slice(body.indexOf('<details>'), body.indexOf('</details>'));
  for (let i = 0; i < 30; i++) {
    assert.ok(detailsRegion.includes(`| blocking | checked item ${i + 1} | evidence ${i + 1} |`), `checked item ${i + 1} の行を含む`);
  }
});

// ─── satisfied AC 件数行 (AC-3, issue #603) ──────────────────────────────────

test('acResults 6件全 satisfied -> 「受け入れ基準 (AC) 6/6 達成」件数行を含み全文 evidence は出ない', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    acResults: [
      { ac_index: 0, satisfied: true, evidence: 'ok1', verified_by: 'evaluator' },
      { ac_index: 1, satisfied: true, evidence: 'ok2', verified_by: 'evaluator' },
      { ac_index: 2, satisfied: true, evidence: 'ok3', verified_by: 'evaluator' },
      { ac_index: 3, satisfied: true, evidence: 'ok4', verified_by: 'evaluator' },
      { ac_index: 4, satisfied: true, evidence: 'ok5', verified_by: 'evaluator' },
      { ac_index: 5, satisfied: true, evidence: 'ok6', verified_by: 'evaluator' },
    ],
  });
  assert.ok(body.includes('受け入れ基準 (AC) 6/6 達成'), '件数行を含む');
  assert.ok(!body.includes('<details>'), '<details> を含まない');
  for (const ok of ['ok1', 'ok2', 'ok3', 'ok4', 'ok5', 'ok6']) {
    assert.ok(!body.includes(ok), `${ok} の全文 evidence を含まない`);
  }
});

// ─── securityClearance 件数行 (AC-3, issue #603) ─────────────────────────────

test('securityClearance 未確認 1件 + cleared 6件 -> 未確認は全文で常時可視・cleared は折りたたみ内に security 区分で出る', () => {
  const blockingItems = [];
  for (let i = 0; i < 6; i++) {
    blockingItems.push(secLedgerItem(`SAFE_CLASS_${i}`, { checked: true, evidence: `evidence ${i}` }));
  }
  blockingItems.push(secLedgerItem('UNCLEARED_CLASS', { checked: false, evidence: '' }));

  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    blockingItems,
    dangerHits: ['UNCLEARED_CLASS'],
  });

  const countHeadingIdx = body.indexOf('**解消済み証跡');
  assert.ok(countHeadingIdx >= 0, '件数見出しを含む');
  const unclearedIdx = body.indexOf('| ❌ 未確認 | UNCLEARED_CLASS |');
  assert.ok(unclearedIdx >= 0, '未確認クラスの全文行を含む');
  assert.ok(unclearedIdx < countHeadingIdx, '未確認が件数見出しより前');
  assert.ok(body.includes('セキュリティ確認 (Security clearance) 6/7 済'), 'clearance 件数行を含む');
  const detailsStart = body.indexOf('<details>');
  assert.ok(detailsStart > unclearedIdx, '折りたたみは未確認行より後');
  for (let i = 0; i < 6; i++) {
    assert.ok(body.indexOf(`| security | danger-grep detected SAFE_CLASS_${i} | evidence ${i} |`) > detailsStart, `cleared ${i} は折りたたみ内の security 行`);
  }
});

// ─── PR #16 型表示矛盾の再現 / fail-closed 空状態行 (issue #299) ─────────────────

test('PR#16 再現: dangerHits あり + SEC seed item unchecked -> 検出クラス行と未確認テーブルは出るが clean/cleared 表示は出ない', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    mergeTier: 'HOLD',
    mergeTierReasons: ['danger hit unresolved'],
    dangerHits: ['config'],
    blockingItems: [
      secLedgerItem('config', { checked: false, evidence: null }),
    ],
  });
  assert.ok(body.includes('検出クラス: config'), '検出クラス行を含む');
  assert.ok(body.includes('| ❌ 未確認 | config | —'), '未確認 clearance テーブル行を含む');
  assert.ok(!body.includes('Security clearance: danger-grep clean（clearance 不要）'), 'clean 表示は出ない');
  assert.ok(!body.includes('✅ セキュリティ確認 (Security clearance)'), 'cleared details は出ない');
});

test('one-shot clearance 後: SEC seed item checked -> 「✅ セキュリティ確認 (Security clearance) 1/1 済」件数行と折りたたみ内の evidence のみで未確認テーブルは出ない', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    mergeTier: 'REVIEW',
    dangerHits: ['config'],
    blockingItems: [
      secLedgerItem('config', { checked: true, evidence: 'security cleared (merge-tier one-shot): safe change' }),
    ],
  });
  assert.ok(body.includes('✅ セキュリティ確認 (Security clearance) 1/1 済'), 'cleared 件数行を含む');
  assert.ok(body.indexOf('security cleared (merge-tier one-shot)') > body.indexOf('<details>'), 'evidence は折りたたみ内にのみ出る');
  assert.ok(!body.includes('| 状態 | danger class | 根拠 |'), '未確認 clearance テーブルは出ない');
});

test('fail_closed:true の SEC item のみ -> 「Security clearance: danger-grep 実行不能（fail-closed — security 未検証）」を含む', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    blockingItems: [
      secLedgerItem('config', { checked: false, evidence: null, floor: false, failClosed: true }),
    ],
  });
  assert.ok(body.includes('Security clearance: danger-grep 実行不能（fail-closed — security 未検証）'), 'fail-closed 空状態行を含む');
  assert.ok(!body.includes('Security clearance: danger-grep clean（clearance 不要）'), 'clean 表示は出ない');
});

test('issue #746: merge_facts_dropped HOLD では「danger-grep 実行不能」ではなく転記欠落として表示する', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    mergeTier: 'HOLD',
    mergeTierReasons: ['merge-tier-facts の転記欠落'],
    holdReasons: [{ code: 'merge_facts_dropped', reason: 'merge-tier-facts の転記欠落', kind: 'human_judgment' }],
    holdKind: 'human_judgment',
    blockingItems: [
      secLedgerItem('config', { checked: false, evidence: null, floor: false, failClosed: true }),
    ],
  });
  assert.ok(body.includes('merge-tier-facts の転記欠落（danger-grep 結果を受け取れず security 未検証）'), 'HOLD 理由テーブルの現状列');
  assert.ok(body.includes('Security clearance: merge-tier-facts の転記欠落（fail-closed — danger-grep 結果を受け取れず security 未検証）'), 'fail-closed 空状態行');
  assert.ok(!body.includes('danger-grep 実行不能'), `danger-grep 実行不能 が出ている: ${body}`);
});

// ─── 解消済み証跡の折りたたみ (issue #707) ──────────────────────────────────

test('issue #707: 解消済み 4 種すべて非空の入力では件数行がサマリ行になった <details> がちょうど 1 回出る', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    blockingItems: [
      { id: 'B1', text: 'resolved', severity: 'major', checked: true, dimension: 'quality' },
      secLedgerItem('SAFE_CLASS', { checked: true, evidence: 'safe' }),
    ],
    advisoryItems: [
      { id: 'ENV-1', text: 'env note', dimension: 'environment', severity: 'minor', checked: false, evidence: null, env_key: 'foo', env_count: 1 },
    ],
    acResults: [
      { ac_index: 0, satisfied: true, evidence: 'ok', verified_by: 'evaluator' },
    ],
  });
  assert.equal((body.match(/<details>/g) || []).length, 1, '<details> はちょうど 1 回');
  assert.equal((body.match(/<\/details>/g) || []).length, 1, '</details> はちょうど 1 回');
  assert.ok(
    body.includes('<details><summary>✅ Goal Ledger 解消済み 2 件 / 🏗 環境ノート 1 件（sandbox 環境事象 — 人間の対応は通常不要） / ✅ 受け入れ基準 (AC) 1/1 達成 / ✅ セキュリティ確認 (Security clearance) 1/1 済</summary>'),
    '件数行が / 区切りのサマリ行になる',
  );
});

test('issue #707 AC6: 解消済み項目は折りたたみ内に 区分（blocking/advisory/AC/security）・内容・解消根拠で 1 行ずつ出る', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    blockingItems: [
      { id: 'B1', text: 'null guard missing', severity: 'major', checked: true, dimension: 'correctness', source: 'evaluator', evidence: 'src/a.ts:10 に guard 追加（fix commit abc1234）' },
      { id: 'AC-1', text: 'AC-1: CLI が --json を受け付ける', severity: 'critical', checked: true, dimension: 'ac', source: 'ac', evidence: 'cli.test.mjs で検証' },
      secLedgerItem('config', { checked: true, evidence: 'secret 代入なし' }),
    ],
    advisoryItems: [
      { id: 'A1', text: 'naming nit', severity: 'minor', checked: true, dimension: 'style', escalate: false, evidence: 'rename 済み' },
      { id: 'A2', text: 'retry が無い', severity: 'major', checked: false, dimension: 'robustness', final_resolution: 'resolved', final_evidence: 'pr-iterate fix で retry 追加' },
    ],
  });
  const detailsStart = body.indexOf('<details><summary>✅ Goal Ledger 解消済み 4 件');
  const detailsEnd = body.indexOf('</details>', detailsStart);
  assert.ok(detailsStart >= 0 && detailsEnd > detailsStart, '解消済み証跡の <details> を含む');
  const region = body.slice(detailsStart, detailsEnd);
  const rows = region.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| 区分'));
  assert.deepEqual(rows, [
    '| blocking | null guard missing | src/a.ts:10 に guard 追加（fix commit abc1234） |',
    '| AC | AC-1: CLI が --json を受け付ける | cli.test.mjs で検証 |',
    '| security | danger-grep detected config | secret 代入なし |',
    '| advisory | naming nit | rename 済み |',
    '| advisory | retry が無い | fix 後 tree で確認: pr-iterate fix で retry 追加 |',
  ]);
  assert.ok(region.includes('| 区分 | 内容 | 解消根拠 |'), '表ヘッダを含む');
  // <summary> 直後と </details> 直前の空行（GFM が details 内の table をレンダリングする条件）
  assert.ok(region.includes('</summary>\n\n| 区分'), 'summary 直後に空行');
  assert.ok(body.slice(0, detailsEnd).endsWith('\n\n'), '</details> 直前に空行');
});

test('issue #707: 解消済み行のセルは空白を畳んで 200 文字で切り、行数は 30 で打ち切ってコメント上限を超えない', () => {
  const long = 'x'.repeat(5000);
  const blockingItems = [];
  for (let i = 0; i < 200; i++) {
    blockingItems.push({ id: `B${i}`, text: `item ${i}\n${long}`, severity: 'major', checked: true, dimension: 'quality', evidence: `a|b\n${long}` });
  }
  const body = buildDevflowSummaryBody({ ...BASE_INPUT, blockingItems });
  const region = body.slice(body.indexOf('<details>'), body.indexOf('</details>'));
  const rows = region.split('\n').filter((l) => l.startsWith('| blocking |'));
  assert.equal(rows.length, 30, '行は 30 件で打ち切る');
  assert.ok(region.includes('他 170 件は省略'), '打ち切り件数を示す');
  const firstCells = rows[0].split(' | ');
  assert.ok(firstCells[1].startsWith('item 0 xxx'), '改行は空白に畳まれる');
  assert.equal(Array.from(firstCells[1]).length, 200, '内容セルは 200 文字');
  assert.ok(firstCells[1].endsWith('…'), '切り詰めは … で示す');
  assert.ok(rows[0].includes('a\\|b xxx'), '| は escape される');
  assert.ok(!rows[0].includes('<br>'), '行内に改行を持ち込まない');
  assert.ok(body.length < 65536, `本文長 ${body.length} は GitHub コメント上限未満`);
});

// ─── 空状態の常時可視行 ────────────────────────────────────────────────────────

test('blockingItems も advisoryItems も空 -> 「Goal Ledger: item なし」を含む', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    blockingItems: [],
    advisoryItems: [],
  });
  assert.ok(body.includes('Goal Ledger: item なし'), 'Goal Ledger item なしを含む');
});

test('acResults undefined -> 「AC 判定なし（evaluator 未実行 or AC 欠落）」を常時可視領域に含む', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    acResults: undefined,
  });
  assert.ok(body.includes('AC 判定なし（evaluator 未実行 or AC 欠落）'), 'AC 判定なしを含む');
  const detailsIdx = body.indexOf('<details>');
  const acNoneIdx = body.indexOf('AC 判定なし');
  if (detailsIdx >= 0) {
    assert.ok(acNoneIdx < detailsIdx, 'AC 判定なしが details より前');
  }
});

test('acResults null -> 「AC 判定なし」を含む', () => {
  const body = buildDevflowSummaryBody({ ...BASE_INPUT, acResults: null });
  assert.ok(body.includes('AC 判定なし'), 'AC 判定なしを含む');
});

test('acResults 空配列 -> 「AC 判定なし」を含む', () => {
  const body = buildDevflowSummaryBody({ ...BASE_INPUT, acResults: [] });
  assert.ok(body.includes('AC 判定なし'), '空配列時も AC 判定なしを含む');
});

test('blockingItems に SEC seed item が無い -> 「Security clearance: danger-grep clean（clearance 不要）」を含む', () => {
  const body = buildDevflowSummaryBody({ ...BASE_INPUT, blockingItems: [] });
  assert.ok(body.includes('Security clearance: danger-grep clean（clearance 不要）'), 'clearance clean を含む');
});

test('blockingItems に非 SEC item のみ含まれる -> 「Security clearance: danger-grep clean（clearance 不要）」を含む', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    blockingItems: [
      { id: 'B1', text: 'non-security blocking item', severity: 'critical', checked: false, dimension: 'quality' },
    ],
  });
  assert.ok(body.includes('Security clearance: danger-grep clean（clearance 不要）'), '非 SEC item のみ -> clean を含む');
});

// ─── 末尾マーカー (AC-5) ──────────────────────────────────────────────────────

test('末尾マーカーが /<!-- dev-flow:(REVIEW|AUTO) -->$/ で末尾一致', () => {
  for (const tier of ['REVIEW', 'AUTO']) {
    const body = buildDevflowSummaryBody({ ...BASE_INPUT, mergeTier: tier, mergeTierReasons: [] });
    const pattern = new RegExp(`<!-- dev-flow:${tier} -->$`);
    assert.match(body, pattern, `${tier} のマーカーが末尾一致`);
  }
});

test('issue #930: HOLD の末尾マーカーは merge tier の holdReasons の code を順に並べた <!-- dev-flow:HOLD codes=... -->', () => {
  const mt = classifyMergeTier({
    shape: 'standard', converged: true, unresolvedDanger: false, breakingStructured: false, breakingKeyword: false,
    docsOrTestOnly: false, escalateCount: 0, evalStaleness: 'none', unsatisfiedAgentAc: false,
    iterateStatus: 'stuck', unsatisfiedHumanAc: true, ciChecks: { ok: true, checks: [{ name: 'Bats Tests', bucket: 'fail' }] },
  });
  assert.equal(mt.tier, 'HOLD');
  const codes = mt.holdReasons.map((hr) => hr.code);
  assert.deepEqual(codes, ['ac_human_pending', 'iterate_non_lgtm', 'ci_checks_failed'], 'fixture の holdReasons');
  const body = buildDevflowSummaryBody({ ...BASE_INPUT, mergeTier: mt.tier, mergeTierReasons: mt.reasons, holdReasons: mt.holdReasons, holdKind: mt.holdKind });
  assert.equal(body.split('\n').at(-1), `<!-- dev-flow:HOLD codes=${codes.join(',')} -->`);
});

test('issue #1065: 末尾マーカーに結論を出した head sha が head=<sha> で載る（HOLD は codes の後）。40 桁 hex 以外は載せない', () => {
  const sha = 'ABCDEF0123456789abcdef0123456789ABCDEF01';
  const review = buildDevflowSummaryBody({ ...BASE_INPUT, headSha: sha });
  assert.equal(review.split('\n').at(-1), `<!-- dev-flow:REVIEW head=${sha.toLowerCase()} -->`);
  const hold = buildDevflowSummaryBody({
    ...BASE_INPUT, mergeTier: 'HOLD', headSha: sha,
    holdReasons: [{ code: 'iterate_non_lgtm', reason: 'r', kind: 'deterministic_recheck' }, { code: 'ci_checks_failed', reason: 'r', kind: 'deterministic_recheck' }],
  });
  assert.equal(hold.split('\n').at(-1), `<!-- dev-flow:HOLD codes=iterate_non_lgtm,ci_checks_failed head=${sha.toLowerCase()} -->`);
  for (const bad of [null, undefined, '', 'abc1234', 'z'.repeat(40)]) {
    const body = buildDevflowSummaryBody({ ...BASE_INPUT, headSha: bad });
    assert.equal(body.split('\n').at(-1), '<!-- dev-flow:REVIEW -->', `headSha=${JSON.stringify(bad)} は marker に head を載せない`);
  }
});

test('末尾に --- 区切り線を含む', () => {
  const body = buildDevflowSummaryBody({ ...BASE_INPUT });
  assert.ok(body.includes('---'), '区切り線を含む');
});

test('末尾に自動生成コメントを含む', () => {
  const body = buildDevflowSummaryBody({ ...BASE_INPUT });
  assert.ok(body.includes('dev-flow により自動生成'), '自動生成コメントを含む');
});

// ─── 見出し ────────────────────────────────────────────────────────────────────

test('見出しに PR 番号を含む', () => {
  const body = buildDevflowSummaryBody({ ...BASE_INPUT, pr: 99 });
  assert.ok(body.includes('PR #99'), 'PR 番号を含む');
});

// ─── 決定性 ───────────────────────────────────────────────────────────────────

test('決定性: 同入力 -> 2回呼んで byte 完全一致', () => {
  const input = {
    pr: 77,
    mergeTier: 'HOLD',
    mergeTierReasons: ['danger hit', 'security unresolved'],
    gatePolicy: 'llm-major-advisory',
    blockingItems: [
      { id: 'B1', text: 'critical issue', severity: 'critical', checked: false, dimension: 'security' },
      secLedgerItem('SQL_INJECTION', { checked: true, evidence: 'parameterized' }),
    ],
    advisoryItems: [
      { id: 'A1', text: 'style', severity: 'minor', checked: false, dimension: 'style', escalate: false },
      { id: 'A2', text: 'perf', severity: 'major', checked: true, dimension: 'perf', escalate: true },
    ],
    ledgerConverged: false,
    acResults: [
      { ac_index: 0, satisfied: true, evidence: 'passed', verified_by: 'evaluator' },
      { ac_index: 1, satisfied: false, evidence: '', verified_by: undefined },
    ],
    dangerHits: ['SQL_INJECTION'],
    shape: 'complex',
    testGreen: true,
    evalVerdict: 'pass',
  };
  const first = buildDevflowSummaryBody(input);
  const second = buildDevflowSummaryBody(input);
  assert.equal(first, second, '同入力 -> バイト完全一致');
});

// ─── 箇条書きスタイル ──────────────────────────────────────────────────────────

test('箇条書きは「- 」始まりで「・」を使わない', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    mergeTierReasons: ['reason X'],
  });
  assert.ok(!body.includes('・'), '「・」を使わない');
});

// ─── CONCERN-* ledger item ────────────────────────────────────────────────────

// CONCERN-* ledger item ヘルパー。dev-flow.js は implement concerns の文字列を無加工で text にして
// {id:'CONCERN-<i>', text, dimension:'concern', severity:'major', source:'concern'} を seed し、
// evaluator の concern_resolutions で checked/evidence を更新する（本ファイル冒頭コメント参照）。
function concernItem(text, { checked = false, evidence = null, triaged, triaged_evidence, id = 'CONCERN-1' } = {}) {
  const item = {
    id,
    text,
    dimension: 'concern',
    severity: 'major',
    source: 'concern',
    checked,
    evidence,
  };
  if (triaged !== undefined) item.triaged = triaged;
  if (triaged_evidence !== undefined) item.triaged_evidence = triaged_evidence;
  return item;
}

test('checked:true の CONCERN-* item は「解消済み証跡」件数行（✅ Goal Ledger 解消済み N 件）に数えられる', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    advisoryItems: [
      concernItem('[plan:major] topicA: descA', { checked: true, evidence: 'concern resolved: verified' }),
    ],
  });
  assert.ok(body.includes('<summary>✅ Goal Ledger 解消済み 1 件</summary>'), '解消済み件数行（折りたたみのサマリ行）を含む');
  assert.ok(body.includes('### ✅ 要対応事項なし'), '要対応事項なしを含む');
});

// ─── undefined が文字列に含まれない ──────────────────────────────────────────

test('undefined が文字列に展開されない', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    acResults: undefined,
    blockingItems: [],
  });
  assert.ok(!body.includes('undefined'), 'undefined が含まれない');
});

// ─── 空状態行の直前行が空行であること (GFM テーブル・bullet 崩壊防止) ──────────

test('要対応テーブルあり + securityClearance 空 -> Security clearance 空状態行の直前行が空行', () => {
  // ケース(a): HOLD + danger clean の典型。unchecked blocking item あり（テーブル行末）、
  // acResults は非空（AC 空状態行は出ない）、SEC seed item なし（clearance 空状態行が出る）。
  // 要対応テーブルの最終行（| ... |）直後に空行なしで空状態行が push されると
  // GFM がテーブル行として吸収し壊れる。直前行が空行であることを assert する。
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    mergeTier: 'HOLD',
    mergeTierReasons: ['blocking item unresolved'],
    blockingItems: [
      { id: 'B1', text: 'unresolved item', severity: 'critical', checked: false, dimension: 'security' },
    ],
    acResults: [
      { ac_index: 0, satisfied: true, evidence: 'ok', verified_by: 'evaluator' },
    ],
  });
  const lines = body.split('\n');
  const secIdx = lines.findIndex(l => l.includes('Security clearance: danger-grep clean'));
  assert.ok(secIdx >= 0, 'Security clearance 空状態行が存在する');
  assert.equal(lines[secIdx - 1], '', `Security clearance 空状態行の直前行（index ${secIdx - 1}）が空行`);
});

// ─── eval_staleness 4分岐 (issue #288) ───────────────────────────────────────

const STALE_WARNINGS = [
  { evalStaleness: 'hash_mismatch', warning: 'Evaluate は古い tree に対して実行された' },
  { evalStaleness: 'iterate_incomplete', warning: 'pr-iterate が LGTM 以外で終端' },
];

test.each(STALE_WARNINGS)('evalStaleness=$evalStaleness -> ⚠️ blockquote で「$warning」を含む', ({ evalStaleness, warning }) => {
  const body = buildDevflowSummaryBody({ ...BASE_INPUT, evalStaleness });
  const lines = body.split('\n');
  const warnIdx = lines.findIndex(l => l.includes(warning));
  assert.ok(warnIdx >= 0, `${evalStaleness} 警告文字列を含む`);
  assert.ok(lines[warnIdx].startsWith('> ⚠️'), '警告行は ⚠️ blockquote');
});

test('evalStaleness=hash_mismatch -> 警告行が「あなたがやること」より前、at-a-glance テーブルより後に位置する', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    evalStaleness: 'hash_mismatch',
  });
  const lines = body.split('\n');
  const tableRowIdx = lines.findIndex(l => l.startsWith('| ') && l.includes('\u{1F537} **REVIEW**'));
  const warnIdx = lines.findIndex(l => l.includes('Evaluate は古い tree に対して実行された'));
  const youDoIdx = lines.indexOf('### あなたがやること');
  assert.ok(tableRowIdx >= 0, 'at-a-glance テーブル行が存在する');
  assert.ok(warnIdx >= 0, '警告行が存在する');
  assert.ok(youDoIdx >= 0, '「あなたがやること」見出しが存在する');
  assert.ok(warnIdx > tableRowIdx, '警告はテーブル行より後');
  assert.ok(warnIdx < youDoIdx, '警告は「あなたがやること」より前');
});

test('evalStaleness=hash_mismatch -> テーブル最終行と警告の間に空行があり GFM テーブルが壊れない', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    evalStaleness: 'hash_mismatch',
  });
  const lines = body.split('\n');
  // at-a-glance テーブルの最終データ行（| tier | shape | ... | の行）を探す
  const tableDataIdx = lines.findIndex(l => l.startsWith('| ') && l.includes('\u{1F537} **REVIEW**'));
  assert.ok(tableDataIdx >= 0, 'テーブルデータ行が存在する');
  // その直後の行が空行であること
  assert.equal(lines[tableDataIdx + 1], '', `テーブル最終行（index ${tableDataIdx}）の直後行（index ${tableDataIdx + 1}）が空行`);
});

test('evalStaleness=iterate_fixed, iterateFixesApplied=2 -> ℹ️ blockquote で件数・担保済み・fix 前 tree 基準を含み stale ⚠️ は出ない', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    evalStaleness: 'iterate_fixed',
    iterateFixesApplied: 2,
  });
  const lines = body.split('\n');
  const infoIdx = lines.findIndex(l => l.includes('2 件の fix'));
  assert.ok(infoIdx >= 0, 'fix 件数を含む情報行が存在する');
  assert.ok(lines[infoIdx].startsWith('> ℹ️'), '情報行は ℹ️ blockquote');
  assert.ok(body.includes('pr-reviewer の再レビューで担保済み'), '担保済み文言を含む');
  assert.ok(body.includes('fix 前 tree 基準'), 'fix 前 tree 基準文言を含む');
  assert.ok(!body.includes('Evaluate は古い tree に対して実行された'), 'hash_mismatch 警告は出ない（AC-1）');
  assert.ok(!body.includes('pr-iterate が LGTM 以外で終端'), 'iterate_incomplete 警告は出ない（AC-1）');
});

test('evalStaleness=iterate_fixed, iterateFixesApplied=null -> 件数部分が崩れず情報行自体は出る', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    evalStaleness: 'iterate_fixed',
    iterateFixesApplied: null,
  });
  const lines = body.split('\n');
  const infoIdx = lines.findIndex(l => l.startsWith('> ℹ️'));
  assert.ok(infoIdx >= 0, 'ℹ️ 情報行が存在する');
  assert.ok(lines[infoIdx].includes('件の fix を適用して LGTM 終端'), '情報行の文言が崩れていない');
});

test.each([
  ['none', { evalStaleness: 'none' }],
  ['未指定', {}],
  ['null', { evalStaleness: null }],
])('evalStaleness=%s -> stale 系文字列をいずれも含まない', (_name, input) => {
  const body = buildDevflowSummaryBody({ ...BASE_INPUT, ...input });
  assert.ok(!body.includes('Evaluate は古い tree に対して実行された'), 'hash_mismatch 警告を含まない');
  assert.ok(!body.includes('pr-iterate が LGTM 以外で終端'), 'iterate_incomplete 警告を含まない');
  assert.ok(!body.includes('件の fix を適用して LGTM 終端'), 'iterate_fixed 情報行を含まない');
});

// out-of-enum は validation error（evalStaleness は hash_reconverged を足した後も閉じた enum のまま）
test.each([
  { field: 'evalStaleness', value: 'bogus' },
  { field: 'finalReconcile', value: 'bogus' },
  { field: 'finalReconcile', value: 'bogus2' },
  { field: 'finalAcReconcile', value: 'stale' },
])('$field=$value -> out-of-enum は validation error', ({ field, value }) => {
  assert.throws(() => {
    buildDevflowSummaryBody({ ...BASE_INPUT, [field]: value });
  }, new RegExp(`invalid ${field}`));
});

// ─── issue #631 ────────────────────────────────────────────────────────────

function make12StaleDiffFiles() {
  return Array.from({ length: 12 }, (_, i) => ({
    path: `docs/f${String(i + 1).padStart(2, '0')}.md`,
    insertions: 0,
    deletions: 10,
  }));
}

test('evalStaleness=hash_mismatch + staleDiffFiles 12件 -> 両 short hash・差分12件・先頭10件+他2件を含み、警告行直後が差分行・その次が空行', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    evalStaleness: 'hash_mismatch',
    evalDiffHash: '7d79f517' + 'a'.repeat(32),
    prDiffHash: 'be8e7f58' + 'b'.repeat(32),
    staleDiffFiles: make12StaleDiffFiles(),
  });
  const lines = body.split('\n');
  assert.ok(body.includes('eval 7d79f517 / PR 直前 be8e7f58'), 'short hash を含む');
  assert.ok(body.includes('差分 12 件'), '件数を含む');
  assert.ok(body.includes('docs/f01.md (+0/-10)'), '先頭ファイルを含む');
  assert.ok(body.includes('docs/f10.md (+0/-10)'), '10件目を含む');
  assert.ok(!body.includes('docs/f11.md'), '11件目は含まない');
  assert.ok(!body.includes('docs/f12.md'), '12件目は含まない');
  assert.ok(body.includes('他 2 件'), '残数を含む');
  assert.ok(body.includes('Evaluate は古い tree に対して実行された'), '既存文字列を含む');
  const warnIdx = lines.findIndex(l => l.includes('Evaluate は古い tree に対して実行された'));
  assert.ok(lines[warnIdx].startsWith('> ⚠️'), '警告行は ⚠️ blockquote');
  assert.ok(lines[warnIdx + 1].startsWith('> '), '差分行は警告行の直後で blockquote 継続');
  assert.equal(lines[warnIdx + 2], '', 'その次は空行');
});

test('evalStaleness=hash_mismatch + staleDiffFiles=null -> 両 hash 全文と手動確認コマンドを含む', () => {
  const evalFull = '7d79f517' + 'a'.repeat(32);
  const prFull = 'be8e7f58' + 'b'.repeat(32);
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    evalStaleness: 'hash_mismatch',
    evalDiffHash: evalFull,
    prDiffHash: prFull,
    staleDiffFiles: null,
  });
  assert.ok(body.includes(evalFull), 'eval hash 全文を含む');
  assert.ok(body.includes(prFull), 'PR hash 全文を含む');
  assert.ok(body.includes(`git diff --stat ${evalFull} ${prFull}`), '手動確認コマンドを含む');
  assert.ok(body.includes('手動確認'), '手動確認文言を含む');
});

test('evalStaleness=hash_mismatch + staleDiffFiles=[] -> 差分 0 件を含む', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    evalStaleness: 'hash_mismatch',
    evalDiffHash: '7d79f517' + 'a'.repeat(32),
    prDiffHash: 'be8e7f58' + 'b'.repeat(32),
    staleDiffFiles: [],
  });
  assert.ok(body.includes('差分 0 件'), '0 件表記を含む');
});

test('evalStaleness=hash_reconverged -> ℹ️ 行に PR head short hash を含み、⚠️ 警告・stale 文言は出ず一時差分件数を含む', () => {
  const sameHash = '7d79f517' + 'a'.repeat(32);
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    evalStaleness: 'hash_reconverged',
    evalDiffHash: sameHash,
    prDiffHash: 'be8e7f58' + 'b'.repeat(32),
    prHeadTreeOid: sameHash,
    staleDiffFiles: [
      { path: 'docs/a.md', insertions: 1, deletions: 0 },
      { path: 'docs/b.md', insertions: 0, deletions: 1 },
    ],
  });
  const lines = body.split('\n');
  const infoIdx = lines.findIndex(l => l.includes('PR head tree は評価済み tree と一致'));
  assert.ok(infoIdx >= 0, 'ℹ️ 行が存在する');
  assert.ok(lines[infoIdx].startsWith('> ℹ️'), 'ℹ️ blockquote で始まる');
  assert.ok(lines[infoIdx].includes('PR head 7d79f517'), 'PR head short hash を含む');
  assert.ok(!body.includes('Evaluate は古い tree に対して実行された'), 'hash_mismatch 警告は出ない');
  const tableRowIdx = lines.findIndex(l => l.startsWith('| ') && l.includes('\u{1F537} **REVIEW**'));
  const youDoIdx = lines.indexOf('### あなたがやること');
  const noWarnInRange = lines.slice(tableRowIdx + 1, youDoIdx).every(l => !l.startsWith('> ⚠️'));
  assert.ok(noWarnInRange, '2b 節の範囲に ⚠️ 行が無い');
  assert.ok(body.includes('一時差分 2 件'), '一時差分件数を含む');
});

test('evalStaleness=hash_reconverged -> 警告行が at-a-glance テーブルより後・「あなたがやること」より前、テーブル末尾との間に空行がある', () => {
  const sameHash = '7d79f517' + 'a'.repeat(32);
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    evalStaleness: 'hash_reconverged',
    evalDiffHash: sameHash,
    prDiffHash: 'be8e7f58' + 'b'.repeat(32),
    prHeadTreeOid: sameHash,
    staleDiffFiles: [{ path: 'docs/a.md', insertions: 1, deletions: 0 }],
  });
  const lines = body.split('\n');
  const tableRowIdx = lines.findIndex(l => l.startsWith('| ') && l.includes('\u{1F537} **REVIEW**'));
  const infoIdx = lines.findIndex(l => l.includes('PR head tree は評価済み tree と一致'));
  const youDoIdx = lines.indexOf('### あなたがやること');
  assert.ok(tableRowIdx >= 0 && infoIdx >= 0 && youDoIdx >= 0, '各行が存在する');
  assert.ok(infoIdx > tableRowIdx, 'ℹ️ 行はテーブル行より後');
  assert.ok(infoIdx < youDoIdx, 'ℹ️ 行は「あなたがやること」より前');
  assert.equal(lines[tableRowIdx + 1], '', 'テーブル直後は空行');
});

test('evalStaleness=hash_reconverged は enum 検証で throw しない', () => {
  assert.doesNotThrow(() => {
    buildDevflowSummaryBody({
      ...BASE_INPUT,
      evalStaleness: 'hash_reconverged',
    });
  });
});

// ─── 環境ノート (issue #296) ──────────────────────────────────────────────────

test('environment item は「⚠️ 要対応」テーブルから除外され「🏗 環境ノート 1 件」件数行のみで現れる（全文は非表示）', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    advisoryItems: [
      {
        id: 'ENV-TURBOPACK-SANDBOX',
        text: 'Turbopack が sandbox 内で失敗した',
        dimension: 'environment',
        severity: 'minor',
        checked: false,
        evidence: 'os error 1',
        env_key: 'turbopack-sandbox',
        env_count: 3,
      },
    ],
  });
  // 要対応テーブルには出ない
  assert.ok(!body.includes('### ⚠️ 要対応'), 'environment のみでは要対応セクションが出ない');
  assert.ok(!body.includes('<details>'), '<details> を含まない');
  assert.ok(!body.includes('turbopack-sandbox'), 'pattern (env_key) の全文を含まない');
  assert.ok(!body.includes('Turbopack が sandbox 内で失敗した'), '内容の全文を含まない');
  assert.ok(!body.includes('os error 1'), 'evidence の全文を含まない');
  assert.ok(body.includes('🏗 環境ノート 1 件'), '環境ノート件数行を含む');
  assert.ok(body.includes('sandbox 環境事象 — 人間の対応は通常不要'), '環境ノート説明文を含む');
});

test('environment item のみ + 他に未解消なし -> 「### ✅ 要対応事項なし」と環境ノートが両方出る', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    advisoryItems: [
      {
        id: 'ENV-NPM-CACHE-EPERM',
        text: 'npm cache EPERM',
        dimension: 'environment',
        severity: 'minor',
        checked: false,
        evidence: null,
        env_key: 'npm-cache-eperm',
        env_count: 1,
      },
    ],
  });
  assert.ok(body.includes('### ✅ 要対応事項なし'), '要対応事項なしを含む');
  assert.ok(!body.includes('### ⚠️ 要対応'), '要対応を含まない');
  assert.ok(body.includes('🏗 環境ノート 1 件'), '環境ノートを含む');
});

test('非 environment の advisory concern item は従来どおり要対応テーブルに残る（回帰なし）', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    advisoryItems: [
      {
        id: 'CONCERN-1',
        text: '本物のコード欠陥concern',
        dimension: 'concern',
        severity: 'minor',
        checked: false,
        evidence: null,
      },
      {
        id: 'ENV-TURBOPACK-SANDBOX',
        text: 'Turbopack sandbox 失敗',
        dimension: 'environment',
        severity: 'minor',
        checked: false,
        evidence: null,
        env_key: 'turbopack-sandbox',
        env_count: 2,
      },
    ],
  });
  // advisory のみなので見出しは「任意の確認事項」（issue #707）
  assert.ok(body.includes('### ℹ️ 任意の確認事項'), '任意の確認事項セクションを含む');
  const lines = body.split('\n');
  const concernLine = lines.find(l => l.includes('本物のコード欠陥concern'));
  assert.ok(concernLine, 'concern 行が要対応テーブルに存在する');
  assert.ok(!lines.some(l => l.includes('Turbopack sandbox 失敗') && l.includes('| 助言（advisory） |')), 'ENV item は要対応テーブルには出ない');
  assert.ok(body.includes('🏗 環境ノート 1 件'), '環境ノートに ENV item が出る');
});

test('environment item が 0 件なら「環境ノート」セクション自体を出力しない', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    advisoryItems: [
      { id: 'A1', text: 'style concern', severity: 'minor', checked: false, dimension: 'style', escalate: false },
    ],
  });
  assert.ok(!body.includes('環境ノート'), '環境ノートセクションが出ない');
  assert.ok(!body.includes('🏗'), '🏗 絵文字が出ない');
});

test('env_key/env_count 欠落時も件数行のみ表示され pattern/件数の全文は出ない', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    advisoryItems: [
      {
        id: 'ENV-EDIT-WRITE-ISOLATION',
        text: 'edit write isolation エラー',
        dimension: 'environment',
        severity: 'minor',
        checked: false,
        evidence: null,
      },
    ],
  });
  assert.ok(!body.includes('edit write isolation エラー'), 'ENV item の内容全文を含まない');
  assert.ok(body.includes('🏗 環境ノート 1 件'), '環境ノート件数行を含む');
});

test('checked=true の environment item は「Goal Ledger 解消済み」件数行にカウントされず環境ノート件数行のみに出る', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    advisoryItems: [
      {
        id: 'ENV-SANDBOX-DENIED',
        text: 'sandbox denied エラー',
        dimension: 'environment',
        severity: 'minor',
        checked: true,
        evidence: 'denied evidence',
        env_key: 'sandbox-denied',
        env_count: 1,
      },
    ],
  });
  assert.ok(!body.includes('✅ Goal Ledger 解消済み'), 'checked env item のみでは Goal Ledger 解消済み件数行が出ない');
  assert.ok(body.includes('🏗 環境ノート 1 件'), '環境ノート件数行に ENV item がカウントされる');
  assert.ok(!body.includes('sandbox denied エラー'), 'ENV item の内容全文を含まない');
});

// ─── 環境ノート CI 確認済み表示 (issue #297, #603) ───────────────────────────

test('checked=true + evidence 有りの ENV item でも「✅ CI確認済」セル・evidence 文言は本文に出ない（件数のみ）', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    advisoryItems: [
      {
        id: 'ENV-TURBOPACK-SANDBOX',
        text: 'Turbopack が sandbox 内で失敗した',
        dimension: 'environment',
        severity: 'minor',
        checked: true,
        evidence: 'CI で確認済み（Vercel, build）',
        env_key: 'turbopack-sandbox',
        env_count: 3,
      },
    ],
  });
  assert.ok(!body.includes('✅ CI確認済'), '✅ CI確認済 セルを含まない');
  assert.ok(!body.includes('CI で確認済み（Vercel, build）'), 'evidence 文言の全文を含まない');
  assert.ok(body.includes('🏗 環境ノート 1 件'), '環境ノート件数行を含む');
});

test('checked=false の ENV item は状態セル「—」・「CI で確認済み」文言を含まないが環境ノート件数行には含まれる', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    advisoryItems: [
      {
        id: 'ENV-TURBOPACK-SANDBOX',
        text: 'Turbopack が sandbox 内で失敗した',
        dimension: 'environment',
        severity: 'minor',
        checked: false,
        evidence: null,
        env_key: 'turbopack-sandbox',
        env_count: 3,
      },
    ],
  });
  assert.ok(!body.includes('CI で確認済み'), 'CI で確認済み を含まない');
  assert.ok(body.includes('🏗 環境ノート 1 件'), '環境ノート件数行に ENV item がカウントされる');
});

test('checked=true の ENV item でも「### ⚠️ 要対応」テーブルにも「✅ Goal Ledger 解消済み」件数行にも現れない（環境ノート専用の回帰固定）', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    advisoryItems: [
      {
        id: 'ENV-TURBOPACK-SANDBOX',
        text: 'Turbopack が sandbox 内で失敗した',
        dimension: 'environment',
        severity: 'minor',
        checked: true,
        evidence: 'CI で確認済み（Vercel, build）',
        env_key: 'turbopack-sandbox',
        env_count: 3,
      },
    ],
  });
  assert.ok(!body.includes('### ⚠️ 要対応'), 'checked ENV item のみでは要対応セクションが出ない');
  assert.ok(!body.includes('✅ Goal Ledger 解消済み'), 'checked ENV item のみでは解消済み details が出ない');
  assert.ok(body.includes('🏗 環境ノート 1 件'), '環境ノートに ENV item が出る');
});

// ─── Final reconcile 表示 (issue #320) ───────────────────────────────────────

const finalReconcileLine = (body) => body.split('\n').find(l => l.startsWith('- Final reconcile'));

test.each([
  ['未指定（既存 BASE_INPUT）', {}],
  ['skipped', { finalReconcile: 'skipped', finalTestGreen: null }],
])('finalReconcile %s -> 本文に「Final reconcile」文字列を含まない', (_name, input) => {
  const body = buildDevflowSummaryBody({ ...BASE_INPUT, ...input });
  assert.ok(!body.includes('Final reconcile'), 'Final reconcile 行を出さない');
});

// finalReconcile × finalTestGreen ごとに「- Final reconcile」行が含む / 含まない表示
test.each([
  { finalReconcile: 'reverified', finalTestGreen: true, includes: ['reverified', '✅ green'], excludes: [] },
  { finalReconcile: 'reverified', finalTestGreen: false, includes: ['❌ red'], excludes: [] },
  // issue #865 / #1138: 単体再実行で green は red のまま flake 候補を添える
  { finalReconcile: 'reverified', finalTestGreen: false, finalTestFlaky: { files: ['a.bats'], logs: [] }, includes: ['❌ red（単体再実行は green — flake 候補）'], excludes: ['✅ green'] },
  { finalReconcile: 'unavailable', finalTestGreen: null, includes: ['不明'], excludes: [] },
])('finalReconcile=$finalReconcile, finalTestGreen=$finalTestGreen -> 「- Final reconcile」行の表示', ({ finalReconcile, finalTestGreen, finalTestFlaky, includes, excludes }) => {
  const line = finalReconcileLine(buildDevflowSummaryBody({ ...BASE_INPUT, finalReconcile, finalTestGreen, finalTestFlaky }));
  assert.ok(line, 'Final reconcile 行を含む');
  for (const s of includes) assert.ok(line.includes(s), `「${s}」を含む: ${line}`);
  for (const s of excludes) assert.ok(!line.includes(s), `「${s}」を含まない: ${line}`);
});

// （finalReconcile の out-of-enum は上の validation error 表）

// ─── Final AC reconcile 表示 (issue #331) ─────────

test.each([
  { finalReconcile: 'reverified', finalTestGreen: true },
])('finalReconcile=$finalReconcile, finalAcReconcile=reverified -> 「, final AC: reverified」と再検証済み注記を含み stale 注記は出ない', ({ finalReconcile, finalTestGreen }) => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    finalReconcile,
    finalTestGreen,
    finalAcReconcile: 'reverified',
    acResults: [
      { ac_index: 0, satisfied: true, evidence: 'ok', verified_by: 'evaluator' },
    ],
  });
  const line = finalReconcileLine(body);
  assert.ok(line, 'Final reconcile 行を含む');
  assert.ok(line.includes(', final AC: reverified'), 'final AC 部分を含む');
  assert.ok(body.includes('✅ AC は最終 PR tree で再検証済み'), '再検証済み注記を含む');
  assert.ok(!body.includes('⚠️ AC 判定は stale'), 'stale 注記は出ない');
});

test('finalReconcile=reverified, finalAcReconcile=skipped + acResults 有り -> stale 注記を含み再検証済み注記は含まない', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    finalReconcile: 'reverified',
    finalTestGreen: true,
    finalAcReconcile: 'skipped',
    acResults: [
      { ac_index: 0, satisfied: true, evidence: 'ok', verified_by: 'evaluator' },
    ],
  });
  assert.ok(body.includes('⚠️ AC 判定は stale（fix 適用後の最終 tree に対する AC 再検証が未実施/判定不能 — AC テーブルは Evaluate 時点（fix 前 tree）基準であり final ではない）'), 'stale 注記を含む');
  assert.ok(!body.includes('✅ AC は最終 PR tree で再検証済み'), '再検証済み注記は出ない');
});

test('finalReconcile=reverified, finalAcReconcile=skipped + acResults:null -> stale 注記は出ず既存 AC 空状態行のみ', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    finalReconcile: 'reverified',
    finalTestGreen: true,
    finalAcReconcile: 'skipped',
    acResults: null,
  });
  assert.ok(!body.includes('⚠️ AC 判定は stale'), 'stale 注記は出ない');
  assert.ok(!body.includes('✅ AC は最終 PR tree で再検証済み'), '再検証済み注記も出ない');
  assert.ok(body.includes('Acceptance Criteria: AC 判定なし（evaluator 未実行 or AC 欠落）'), '既存の AC 空状態行のみ出る');
});

test('finalReconcile 未指定（fix 非適用）+ finalAcReconcile=skipped -> 「final AC:」を含まない', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    finalReconcile: null,
    finalAcReconcile: 'skipped',
  });
  assert.ok(!body.includes('final AC:'), 'finalReconcile null 時は final AC: を含まない');
  assert.ok(!body.includes('⚠️ AC 判定は stale'), 'stale 注記も出ない');
  assert.ok(!body.includes('✅ AC は最終 PR tree で再検証済み'), '再検証済み注記も出ない');
});

// （finalAcReconcile の out-of-enum は上の validation error 表）

// ─── TESTSURF (test-weakening) 表示 (issue #362) ─────────────────────────────

test('testsurfHits=["skip"] + ledger に TESTSURF-SKIP unchecked -> TESTSURF セクション + 要人間確認文言を含む', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    testsurfHits: ['skip'],
    blockingItems: [testsurfLedgerItem('skip', { checked: false, evidence: null })],
  });
  assert.ok(body.includes('### 🧪 TESTSURF（test-weakening 検出）'), 'TESTSURF セクション見出しを含む');
  assert.ok(body.includes('検出パターン (test-weakening): skip'), '検出パターン行を含む');
  assert.ok(body.includes('| ❌ 未解消 | SKIP |'), '未解消行を含む');
  assert.ok(body.includes('**要人間確認**: committed test の skip/削除/tautology 化の疑い'), '要人間確認文言を含む');
});

test('TESTSURF-SKIP checked（evidence "testsurf cleared: ..."） -> cleared 表示を含み要人間確認は出ない', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    testsurfHits: ['skip'],
    blockingItems: [
      testsurfLedgerItem('skip', { checked: true, evidence: 'testsurf cleared: renamed skip helper, not a real skip' }),
    ],
  });
  assert.ok(body.includes('| ✅ cleared | SKIP | testsurf cleared: renamed skip helper, not a real skip |'), 'cleared 行を含む');
  assert.ok(!body.includes('要人間確認'), 'cleared 時は要人間確認文言が出ない');
});

test('testsurfHits 空 かつ TESTSURF ledger item なし -> 出力に「TESTSURF」文字列を含まない（regression）', () => {
  const body = buildDevflowSummaryBody({ ...BASE_INPUT, testsurfHits: [] });
  assert.ok(!body.includes('TESTSURF'), 'TESTSURF 文字列を含まない');
  assert.ok(!body.includes('検出パターン'), '検出パターン行も出ない');
});

test('testsurfHits 未指定（既存呼び出し互換） -> 出力に「TESTSURF」文字列を含まない（regression）', () => {
  const body = buildDevflowSummaryBody({ ...BASE_INPUT });
  assert.ok(!body.includes('TESTSURF'), 'TESTSURF 文字列を含まない');
});

test('複数 pattern（skip 未解消 + only cleared） -> 両方が TESTSURF テーブルに列挙される', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    testsurfHits: ['skip', 'only'],
    blockingItems: [
      testsurfLedgerItem('skip', { checked: false, evidence: null }),
      testsurfLedgerItem('only', { checked: true, evidence: 'testsurf cleared: intentional focus during WIP, reverted before merge' }),
    ],
  });
  assert.ok(body.includes('検出パターン (test-weakening): skip, only'), '検出パターン 2件を含む');
  assert.ok(body.includes('| ❌ 未解消 | SKIP |'), 'skip 未解消行を含む');
  assert.ok(body.includes('| ✅ cleared | ONLY |'), 'only cleared行を含む');
});

test('TESTSURF セクションは dangerHits/Security clearance と独立して表示される', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    dangerHits: [],
    testsurfHits: ['tautology'],
    blockingItems: [testsurfLedgerItem('tautology', { checked: false, evidence: null })],
  });
  assert.ok(body.includes('✅ clean'), 'danger は clean のまま');
  assert.ok(body.includes('Security clearance: danger-grep clean（clearance 不要）'), 'Security clearance は clean のまま');
  assert.ok(body.includes('### 🧪 TESTSURF（test-weakening 検出）'), 'TESTSURF セクションは独立して出る');
});

test('決定性: TESTSURF 込み入力でも 2回呼んで byte 完全一致', () => {
  const input = {
    ...BASE_INPUT,
    testsurfHits: ['skip', 'xdescribe'],
    blockingItems: [
      testsurfLedgerItem('skip', { checked: false, evidence: null }),
      testsurfLedgerItem('xdescribe', { checked: true, evidence: 'testsurf cleared: renamed suite, no logic removed' }),
    ],
  };
  const body1 = buildDevflowSummaryBody(input);
  const body2 = buildDevflowSummaryBody(input);
  assert.equal(body1, body2, 'TESTSURF 込みでも byte 完全一致');
});

// ─── liteReview 統合表示 (issue #392 AC-6) ───────────────────────────────────

test('liteReview あり -> 「### lite レビュー（pr-iterate 起動なし）」セクションに decision / CI / 総評を含む', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    liteReview: { decision: 'lgtm', ci: 'passed', summary: 'looks good, no blocking findings' },
  });
  assert.ok(body.includes('### lite レビュー（pr-iterate 起動なし）'), 'lite レビュー見出しを含む');
  assert.ok(body.includes('- **decision**: lgtm'), 'decision 行を含む');
  assert.ok(body.includes('- **CI**: passed'), 'CI 行を含む');
  assert.ok(body.includes('- **総評**: looks good, no blocking findings'), '総評行を含む');
});

test('liteReview.decision=null -> decision セルが「n/a」で表示される', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    liteReview: { decision: null, ci: 'pending', summary: null },
  });
  assert.ok(body.includes('- **decision**: n/a'), 'decision n/a を含む');
  assert.ok(body.includes('- **CI**: pending'), 'CI 行を含む');
  assert.ok(!body.includes('- **総評**:'), 'summary null 時は総評行を出さない');
});

test('liteReview.summary が空文字 -> 総評行を出さない', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    liteReview: { decision: 'lgtm', ci: 'passed', summary: '' },
  });
  assert.ok(!body.includes('- **総評**:'), 'summary 空文字時は総評行を出さない');
});

test('liteReview.summary に | と改行を含む -> mdCell でエスケープされる', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    liteReview: { decision: 'lgtm', ci: 'passed', summary: 'summary with | pipe\nand newline' },
  });
  assert.ok(body.includes('summary with \\| pipe<br>and newline'), 'summary が mdCell でエスケープされる');
});

test('liteReview=null -> 「lite レビュー」セクションを一切含まず、liteReview 省略時と byte 完全一致する（回帰保証）', () => {
  const withNull = buildDevflowSummaryBody({ ...BASE_INPUT, liteReview: null });
  const omitted = buildDevflowSummaryBody({ ...BASE_INPUT });
  assert.ok(!withNull.includes('lite レビュー'), 'liteReview=null 時は lite レビューセクションを含まない');
  assert.equal(withNull, omitted, 'liteReview=null は省略時と byte 完全一致');
});

test('liteReview=undefined -> 「lite レビュー」セクションを一切含まない', () => {
  const body = buildDevflowSummaryBody({ ...BASE_INPUT, liteReview: undefined });
  assert.ok(!body.includes('lite レビュー'), 'liteReview=undefined 時は lite レビューセクションを含まない');
});

test('決定性: liteReview 込み入力でも 2回呼んで byte 完全一致', () => {
  const input = {
    ...BASE_INPUT,
    liteReview: { decision: 'lgtm', ci: 'passed', summary: 'all good' },
  };
  const body1 = buildDevflowSummaryBody(input);
  const body2 = buildDevflowSummaryBody(input);
  assert.equal(body1, body2, 'liteReview 込みでも byte 完全一致');
});

// ─── pr-iterate 未解消の指摘 (issue #602) ─────────────────────────────────────

const F_A = { severity: 'critical', topic: 'null-deref', file: 'src/a.js', line: 12, description: 'null 参照の可能性', suggestion: 'optional chain にする' };
const F_B = { severity: 'major', topic: 'missing-test', file: 'src/b.js', description: 'テスト欠落', suggestion: 'b.test.mjs を追加' };
const F_CI = { severity: 'critical', topic: 'ci::lint', description: 'CI check failed: lint (failure)', suggestion: 'CI を green にする' };
const HIST_2 = [
  { iteration: 1, decision: 'request-changes', summary: 'r1', blocking: [F_A, F_B], minor: [] },
  { iteration: 2, decision: 'request-changes', summary: 'r2', blocking: [F_B], minor: [] },
];

test('iterateStatus=lgtm -> history/iterations 込みでも 3 引数省略時の出力と byte 完全一致（AC1）', () => {
  const withLgtm = buildDevflowSummaryBody({
    ...BASE_INPUT,
    iterateStatus: 'lgtm',
    iterateHistory: HIST_2,
    iterateIterations: 2,
  });
  const omitted = buildDevflowSummaryBody({ ...BASE_INPUT });
  assert.equal(withLgtm, omitted, 'lgtm 終端は 3 引数省略時と byte 完全一致');
});

test('iterateStatus=lgtm -> 「pr-iterate 未解消の指摘」を含まない', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    iterateStatus: 'lgtm',
    iterateHistory: HIST_2,
    iterateIterations: 2,
  });
  assert.ok(!body.includes('pr-iterate 未解消の指摘'), 'lgtm では未解消セクションを含まない');
});

test('iterateStatus=fix_failed -> 見出し・severity・file・指摘・提案を含み、解消済み round の finding は含まない（AC2, AC3）', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    iterateStatus: 'fix_failed',
    iterateHistory: HIST_2,
    iterateIterations: 2,
  });
  assert.ok(body.includes('### 🔁 pr-iterate 未解消の指摘（1 件 — status: fix_failed、最終反復 2 の review 時点）'), '見出し行を含む');
  assert.ok(body.includes('🟠 major — `src/b.js`'), 'severity+file 行を含む');
  assert.ok(body.includes('   - 指摘: テスト欠落'), '指摘行を含む');
  assert.ok(body.includes('   - 提案: b.test.mjs を追加'), '提案行を含む');
  assert.ok(!body.includes('null 参照の可能性'), '解消済み round(1) の finding は含まない');
});

test('iterateStatus=stuck -> line 付き finding が `file:line` 形式で描画される', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    iterateStatus: 'stuck',
    iterateHistory: [{ iteration: 1, decision: 'request-changes', summary: 'r1', blocking: [F_A], minor: [] }],
    iterateIterations: 1,
  });
  assert.ok(body.includes('🔴 critical — `src/a.js:12`'), 'line 付き finding 行を含む');
});

test('iterateStatus=fix_failed + file 欠落の CI synthetic finding -> 「場所指定なし」で描画される', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    iterateStatus: 'fix_failed',
    iterateHistory: [{ iteration: 1, decision: 'approve', summary: 'ok', blocking: [F_CI], minor: [] }],
    iterateIterations: 1,
  });
  assert.ok(body.includes('🔴 critical — 場所指定なし'), 'file 欠落は場所指定なしで描画される');
  assert.ok(body.includes('CI check failed: lint (failure)'), 'CI synthetic finding の description を含む');
});

test('iterateStatus=ci_pending + 末尾 round が終端 round でない -> 「pr-iterate 未解消の指摘」を含まない（AC3）', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    iterateStatus: 'ci_pending',
    iterateHistory: HIST_2,
    iterateIterations: 3,
  });
  assert.ok(!body.includes('pr-iterate 未解消の指摘'), '末尾 round の iteration が iterations と不一致なら省略する');
});

test('iterateIterations=null -> 末尾 round を終端 round として採用する', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    iterateStatus: 'fix_failed',
    iterateHistory: HIST_2,
    iterateIterations: null,
  });
  assert.ok(body.includes('pr-iterate 未解消の指摘'), 'iterations 不明時は末尾 round を採用してセクションを描画する');
  assert.ok(body.includes('（1 件'), '末尾 round(iteration 2) の blocking 1 件を反映する');
});

// issue #658: iterateStatus が非 'lgtm' であること自体が結論行・あなたがやること の fixRequired
// 判定に寄与するため（未解消指摘セクションの有無に関わらず）、iterateStatus を伴う呼び出しはもはや
// 「3 引数完全省略」の呼び出しとは byte 一致しない。history 表現の違い（undefined/null/[]/blocking
// 空 round）が互いに同値であることを、同一 iterateStatus の呼び出し同士で検証する。
test('iterateHistory が undefined/null/[] -> いずれも同一 iterateStatus の呼び出しで byte 完全一致（AC4）', () => {
  const bodies = [undefined, null, []].map((hist) => buildDevflowSummaryBody({
    ...BASE_INPUT,
    iterateStatus: 'fix_failed',
    iterateHistory: hist,
    iterateIterations: 1,
  }));
  assert.equal(bodies[0], bodies[1], 'undefined と null が byte 完全一致');
  assert.equal(bodies[1], bodies[2], 'null と [] が byte 完全一致');
  assert.ok(!bodies[0].includes('pr-iterate 未解消の指摘'), '未解消指摘セクションを含まない');
});

test('終端 round の blocking が空 -> セクション自体を省略し history 省略時と byte 完全一致', () => {
  const withoutHistory = buildDevflowSummaryBody({
    ...BASE_INPUT,
    iterateStatus: 'fix_failed',
    iterateHistory: undefined,
    iterateIterations: 1,
  });
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    iterateStatus: 'fix_failed',
    iterateHistory: [{ iteration: 1, decision: 'approve', summary: 'ok', blocking: [], minor: [] }],
    iterateIterations: 1,
  });
  assert.equal(body, withoutHistory, '終端 round の blocking が空なら history 省略時と byte 完全一致');
  assert.ok(!body.includes('pr-iterate 未解消の指摘'), '未解消指摘セクションを含まない');
});

test('iterateStatus 未指定/null -> history 込みでも「pr-iterate 未解消の指摘」を含まない', () => {
  for (const status of [undefined, null]) {
    const body = buildDevflowSummaryBody({
      ...BASE_INPUT,
      iterateStatus: status,
      iterateHistory: HIST_2,
    });
    assert.ok(!body.includes('pr-iterate 未解消の指摘'), `iterateStatus=${status} ではセクションを含まない`);
  }
});

test('配置: 見出しは「要対応事項なし」より後・「Goal Ledger: item なし」より前で、前後に空行を伴う', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    iterateStatus: 'fix_failed',
    iterateHistory: HIST_2,
    iterateIterations: 2,
  });
  const lines = body.split('\n');
  const noneIdx = lines.findIndex(l => l.includes('### ✅ 要対応事項なし'));
  const headingIdx = lines.findIndex(l => l.includes('### 🔁 pr-iterate 未解消の指摘'));
  const ledgerIdx = lines.findIndex(l => l.includes('Goal Ledger: item なし'));
  assert.ok(noneIdx >= 0, '要対応事項なし見出しが存在する');
  assert.ok(headingIdx >= 0, '未解消の指摘見出しが存在する');
  assert.ok(ledgerIdx >= 0, 'Goal Ledger 空状態行が存在する');
  assert.ok(headingIdx > noneIdx, '見出しは要対応事項なしより後');
  assert.ok(headingIdx < ledgerIdx, '見出しは Goal Ledger より前');
  assert.equal(lines[headingIdx - 1], '', '見出し直前が空行');
  assert.equal(lines[headingIdx + 1], '', '見出し直後が空行');
  assert.equal(lines[ledgerIdx - 1], '', 'Goal Ledger 空状態行の直前が空行');
});

test('既存セクション不変: 新セクションを取り除いた行配列が同一 iterateStatus・history なしの行配列と一致する（AC5）', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    iterateStatus: 'fix_failed',
    iterateHistory: HIST_2,
    iterateIterations: 2,
  });
  // issue #658: iterateStatus 自体が結論行・あなたがやること に寄与するため、比較基準は
  // 「3 引数完全省略」ではなく「同一 iterateStatus・history なし」にする（AC5 の趣旨である
  // 『未解消指摘セクションだけを増分として持つ』ことの検証は変わらない）。
  const omitted = buildDevflowSummaryBody({
    ...BASE_INPUT,
    iterateStatus: 'fix_failed',
    iterateHistory: undefined,
    iterateIterations: 2,
  });
  const lines = body.split('\n');
  const headingIdx = lines.findIndex(l => l.includes('### 🔁 pr-iterate 未解消の指摘'));
  assert.ok(headingIdx >= 0, '見出しが存在する');
  // ブロックは headingIdx-1 の空行から始まり、見出し・空行・findings 行（'N. ' / '   - ' 始まり）が続く。
  let end = headingIdx + 1; // heading 直後の空行
  while (end < lines.length && (/^\d+\. /.test(lines[end]) || /^   - /.test(lines[end]) || lines[end] === '')) {
    if (lines[end] === '' && end > headingIdx + 1) {
      // 空行が続いた場合、次の行が findings 継続でなければブロック終端とみなして直前で止める
      const next = lines[end + 1];
      if (!(next != null && (/^\d+\. /.test(next) || /^   - /.test(next)))) break;
    }
    end++;
  }
  const stripped = [...lines.slice(0, headingIdx - 1), ...lines.slice(end)];
  const omittedLines = omitted.split('\n');
  assert.deepEqual(stripped, omittedLines, '新セクション除去後は省略時の出力と一致する');
});

test('決定性: pr-iterate 未解消セクション込みで 2回呼んで byte 完全一致', () => {
  const input = {
    ...BASE_INPUT,
    iterateStatus: 'fix_failed',
    iterateHistory: HIST_2,
    iterateIterations: 2,
  };
  const body1 = buildDevflowSummaryBody(input);
  const body2 = buildDevflowSummaryBody(input);
  assert.equal(body1, body2, 'pr-iterate 未解消セクション込みでも byte 完全一致');
});

test('description に | と改行を含む finding -> mdCell でエスケープされる', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    iterateStatus: 'fix_failed',
    iterateHistory: [{
      iteration: 1,
      decision: 'approve',
      summary: 'ok',
      blocking: [{ severity: 'minor', topic: 't', file: 'x.js', description: 'a|b\nc', suggestion: null }],
      minor: [],
    }],
    iterateIterations: 1,
  });
  assert.ok(body.includes('   - 指摘: a\\|b<br>c'), 'description が mdCell でエスケープされる');
});

// 呼び出し側（dev-flow.js）の iterateStatus / iterateHistory / iterateIterations 配線は
// empty-diff-evaluate-routing.test.mjs (P-3) が VM 挙動で検証する（issue #636）。

// ─── 解消済み証跡の件数縮約 (issue #603) ─────────────────────────────────────

function deepFreeze(obj) {
  if (obj !== null && typeof obj === 'object' && !Object.isFrozen(obj)) {
    for (const key of Object.getOwnPropertyNames(obj)) {
      deepFreeze(obj[key]);
    }
    Object.freeze(obj);
  }
  return obj;
}

test('AC2 golden pin: 要対応セクション全文は件数縮約後も pre-change 出力と byte 一致（後退しない証拠）', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    blockingItems: [
      { id: 'B1', text: 'unchecked blocking text', severity: 'critical', checked: false, dimension: 'security', evidence: 'ev-b1' },
      secLedgerItem('XSS', { checked: false, evidence: '' }),
      secLedgerItem('SQLI', { checked: true, evidence: 'safe' }),
    ],
    advisoryItems: [
      { id: 'A1', text: 'needs human', severity: 'major', checked: true, dimension: 'design', escalate: true, escalate_reason: 'preference' },
    ],
    acResults: [
      { ac_index: 0, satisfied: false, evidence: 'failed evidence', verified_by: 'evaluator' },
      { ac_index: 1, satisfied: true, evidence: 'passed', verified_by: 'evaluator' },
    ],
  });
  // issue #658 で要対応表に「現状/対応」列が追加された。evidence/escalate_reason は内容列から
  // 外れ、それぞれ現状/対応列に移った（現行実装から採取した literal。この配置・列構成が
  // regression しないことを保証する）。issue #829 で ESCALATE の現状の既定は「未判断」になった
  // （「未解消」は blocking の行にだけ使う）。
  const expected = "### ⚠️ 要対応\n\n| 状態 | 区分 | 観点 | 内容 | 現状 | 対応 |\n|---|---|---|---|---|---|\n| ❌ 未解消 | 必須（blocking） | security | unchecked blocking text | ev-b1 | 修正が必要 |\n| ❌ 未解消 | 必須（blocking） | security | danger-grep detected XSS | 未解消 | 修正が必要 |\n| ⚠️ 要判断 | 要判断（advisory ESCALATE） | design | needs human | 未判断 | 要判断（preference） |\n\n| 状態 | AC | 検証 | 根拠 |\n|---|---|---|---|\n| ❌ 未達 | AC#1 | evaluator | failed evidence |\n\n| 状態 | danger class | 根拠 |\n|---|---|---|\n| ❌ 未確認 | XSS | — |\n\n\n";
  const start = body.indexOf('### ⚠️ 要対応');
  const end = body.indexOf('**解消済み証跡');
  assert.ok(start >= 0 && end > start, '要対応セクションと件数見出しの両方を含む');
  assert.equal(body.slice(start, end), expected, '要対応セクション全文が pre-change 出力と byte 一致');
});

test('AC5 pin: unchecked SEC seed 混在時、未確認行が全文で常時可視・cleared は折りたたみ内のみで clean 表示は出ない', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    blockingItems: [
      secLedgerItem('CLEARED_A', { checked: true, evidence: 'safe a' }),
      secLedgerItem('CLEARED_B', { checked: true, evidence: 'safe b' }),
      secLedgerItem('UNCLEARED_C', { checked: false, evidence: '' }),
    ],
    dangerHits: ['UNCLEARED_C'],
  });
  assert.ok(!body.includes('Security clearance: danger-grep clean（clearance 不要）'), 'clean 表示は出ない');
  const unclearedIdx = body.indexOf('| ❌ 未確認 | UNCLEARED_C |');
  assert.ok(unclearedIdx >= 0, '未確認行が全文で出る');
  const countHeadingIdx = body.indexOf('**解消済み証跡');
  assert.ok(countHeadingIdx >= 0, '件数見出しを含む');
  assert.ok(unclearedIdx < countHeadingIdx, '未確認行が件数見出しより前（常時可視）');
  assert.ok(body.includes('セキュリティ確認 (Security clearance) 2/3 済'), 'cleared 件数行を含む');
  assert.ok(body.indexOf('safe a') > body.indexOf('<details>'), 'cleared item A の evidence は折りたたみ内のみ');
  assert.ok(body.indexOf('safe b') > body.indexOf('<details>'), 'cleared item B の evidence は折りたたみ内のみ');
});

test('AC4 不変性 pin: 再帰 freeze した入力で throw せず、各 tier で末尾マーカー・at-a-glance・入力不変を保つ', () => {
  for (const tier of ['HOLD', 'REVIEW', 'AUTO']) {
    const blockingItems = deepFreeze([
      { id: 'B1', text: 'unresolved', severity: 'critical', checked: false, dimension: 'security', evidence: 'e1' },
      { id: 'B2', text: 'resolved', severity: 'major', checked: true, dimension: 'quality', evidence: 'e2' },
    ]);
    const advisoryItems = deepFreeze([
      { id: 'A1', text: 'env note', dimension: 'environment', severity: 'minor', checked: false, evidence: null, env_key: 'foo', env_count: 1 },
      { id: 'A2', text: 'resolved advisory', severity: 'minor', checked: true, dimension: 'style', escalate: false },
    ]);
    const acResults = deepFreeze([
      { ac_index: 0, satisfied: false, evidence: 'fail', verified_by: 'evaluator' },
      { ac_index: 1, satisfied: true, evidence: 'ok', verified_by: 'evaluator' },
    ]);
    const snapshot = {
      blockingItems: structuredClone(blockingItems),
      advisoryItems: structuredClone(advisoryItems),
      acResults: structuredClone(acResults),
    };
    let body;
    assert.doesNotThrow(() => {
      body = buildDevflowSummaryBody({
        ...BASE_INPUT,
        mergeTier: tier,
        mergeTierReasons: [`${tier} reason`],
        blockingItems,
        advisoryItems,
        acResults,
      });
    }, `${tier}: freeze 済み入力で throw しない`);
    const pattern = new RegExp(`<!-- dev-flow:${tier}${tier === 'HOLD' ? ' codes=' : ''} -->$`);
    assert.match(body, pattern, `${tier}: 末尾マーカーが一致`);
    assert.ok(body.includes(`**${tier}**`), `${tier}: at-a-glance に tier を含む`);
    assert.deepEqual(blockingItems, snapshot.blockingItems, `${tier}: blockingItems が不変`);
    assert.deepEqual(advisoryItems, snapshot.advisoryItems, `${tier}: advisoryItems が不変`);
    assert.deepEqual(acResults, snapshot.acResults, `${tier}: acResults が不変`);
  }
});

// ─── triaged（issue #614 → #626 で要対応から除外・折りたたみ化） ──────────────

test('issue #626 AC1: 残る unchecked が triaged advisory 1 件のみなら件数付き見出しが出て「### ⚠️ 要対応」は出ない', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    advisoryItems: [
      {
        ...concernItem('[plan:major] A: a'),
        triaged: true,
        triaged_evidence: 'lib/y.ts:20 は未変更。advisory で実害なし',
      },
    ],
  });
  assert.ok(body.includes('### ✅ 要対応事項なし（トリアージ済み 1 件）'), '件数付き見出しを含む');
  assert.ok(!body.includes('### ⚠️ 要対応'), '要対応見出しを含まない');
  assert.ok(!body.includes('🔹 トリアージ済み |'), '表の状態列に🔹は出ない');
});

test('issue #626 AC2: triaged advisory は <details> に 観点/内容/triaged_evidence が全文で残る', () => {
  const evidence = 'tofu validate は registry.opentofu.org が sandbox で Forbidden のため未実施（apply 前にオペレータが実施）';
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    advisoryItems: [
      {
        ...concernItem('[plan:major] A: a'),
        triaged: true,
        triaged_evidence: evidence,
      },
    ],
  });
  assert.ok(body.includes('<details><summary>🔹 トリアージ済み 1 件（evaluator 判断 — 誤トリアージ検算用）</summary>'), 'details summary を含む');
  assert.ok(body.includes('</details>'), 'details 終端を含む');
  const detailsStart = body.indexOf('<details>');
  const detailsEnd = body.indexOf('</details>') + '</details>'.length;
  const detailsRegion = body.slice(detailsStart, detailsEnd);
  assert.ok(detailsRegion.includes(`| concern | [plan:major] A: a | ${evidence} |`), 'details 内テーブルに全文が残る');
});

test('issue #626 AC2: text/triaged_evidence の | と改行は details 内テーブルで \\| / <br> にエスケープされ全文が残る', () => {
  const text = '[plan:major] esc|A: a\nline2';
  const evidence = 'evidence|with|pipes\nand newline';
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    advisoryItems: [
      {
        ...concernItem(text),
        triaged: true,
        triaged_evidence: evidence,
      },
    ],
  });
  const detailsStart = body.indexOf('<details>');
  const detailsEnd = body.indexOf('</details>') + '</details>'.length;
  const detailsRegion = body.slice(detailsStart, detailsEnd);
  assert.ok(detailsRegion.includes(mdCell(text)), 'text がエスケープされて全文残る');
  assert.ok(detailsRegion.includes(mdCell(evidence)), 'evidence がエスケープされて全文残る');
});

test('issue #626 AC3: triaged advisory と本物の未解消 advisory が混在する場合、要対応表には未解消のみ、<details> には triaged のみが出る', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    advisoryItems: [
      {
        ...concernItem('[plan:major] A: a'),
        triaged: true,
        triaged_evidence: 'lib/y.ts:20 は未変更。advisory で実害なし',
      },
      concernItem('[plan:major] B: b', { id: 'CONCERN-2' }),
    ],
  });
  // 残る未解消は advisory のみなので見出しは「任意の確認事項」（issue #707）
  assert.ok(body.includes('### ℹ️ 任意の確認事項'), '任意の確認事項見出しを含む');
  const tableStart = body.indexOf('### ℹ️ 任意の確認事項');
  const detailsStart = body.indexOf('<details>');
  const actionTable = body.slice(tableStart, detailsStart);
  assert.ok(actionTable.includes('| ℹ️ 未確認 | 助言（advisory） | concern | [plan:major] B: b |'), '未解消行を含む');
  assert.ok(!actionTable.includes('[plan:major] A: a'), '要対応表に triaged text を含まない');
  const detailsEnd = body.indexOf('</details>') + '</details>'.length;
  const detailsRegion = body.slice(detailsStart, detailsEnd);
  assert.ok(detailsRegion.includes('[plan:major] A: a'), 'details に triaged text を含む');
  assert.ok(!detailsRegion.includes('B: b'), 'details に非 triaged text を含まない');
  assert.ok(body.includes('<summary>🔹 トリアージ済み 1 件'), 'summary はトリアージ済み1件');
});

test('issue #614 AC5 (#626 AC4): blocking lane の item は triaged が付いていても状態列・内容列が triaged 無し版と byte 一致し、<details> も出ない', () => {
  const triagedItem = {
    ...concernItem('[plan:major] A: a'),
    triaged: true,
    triaged_evidence: 'lib/y.ts:20 は未変更。advisory で実害なし',
  };
  const plainItem = concernItem('[plan:major] A: a');
  const bodyTriaged = buildDevflowSummaryBody({
    ...BASE_INPUT,
    gatePolicy: 'llm-major-blocking',
    blockingItems: [triagedItem],
  });
  const bodyPlain = buildDevflowSummaryBody({
    ...BASE_INPUT,
    gatePolicy: 'llm-major-blocking',
    blockingItems: [plainItem],
  });
  assert.equal(bodyTriaged, bodyPlain, 'triaged の有無で blocking lane の出力が byte 一致する');
  assert.ok(bodyTriaged.includes('❌ 未解消'), 'blocking lane は ❌ 未解消 のまま');
  assert.ok(!bodyTriaged.includes('🔹'), 'blocking lane に 🔹 は出ない');
  assert.ok(!bodyTriaged.includes('<details>'), 'blocking lane の triaged では details も出ない');
});

test('issue #626: triaged advisory 2 件 -> 見出し・summary・details テーブル行数が 2 件で一致する', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    advisoryItems: [
      { ...concernItem('[plan:major] A: a', { id: 'CONCERN-1' }), triaged: true, triaged_evidence: 'evidence A' },
      { ...concernItem('[plan:major] B: b', { id: 'CONCERN-2' }), triaged: true, triaged_evidence: 'evidence B' },
    ],
  });
  assert.ok(body.includes('### ✅ 要対応事項なし（トリアージ済み 2 件）'), '件数2件の見出し');
  assert.ok(body.includes('<summary>🔹 トリアージ済み 2 件'), '件数2件のsummary');
  const detailsStart = body.indexOf('<details>');
  const detailsEnd = body.indexOf('</details>') + '</details>'.length;
  const detailsRegion = body.slice(detailsStart, detailsEnd);
  const rowCount = (detailsRegion.match(/\| concern \|/g) || []).length;
  assert.equal(rowCount, 2, 'details テーブルの行数が2件');
});

test('issue #614 AC2: triaged_evidence が空文字/null/未定義の advisory item は ℹ️ 未確認 のままで 🔹・<details> を含まない', () => {
  for (const [label, triaged_evidence] of [['空文字', ''], ['null', null], ['未定義', undefined]]) {
    const item = {
      ...concernItem(`[plan:major] evidence-${label}: x`, { id: `CONCERN-${label}` }),
      triaged: true,
    };
    if (triaged_evidence !== undefined) item.triaged_evidence = triaged_evidence;
    const body = buildDevflowSummaryBody({
      ...BASE_INPUT,
      advisoryItems: [item],
    });
    assert.ok(body.includes('| ℹ️ 未確認 | 助言（advisory） |'), `${label}: ℹ️ 未確認 のまま`);
    assert.ok(!body.includes('🔹'), `${label}: 🔹 を含まない`);
    assert.ok(!body.includes('<details>'), `${label}: <details> を含まない`);
  }
});

test('issue #614: escalate:true の advisory item は triaged が付いていても ⚠️ 要判断のまま（escalate 優先）で <details> も出ない', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    advisoryItems: [
      { id: 'A1', text: 'escalated concern', severity: 'major', checked: false, dimension: 'quality', escalate: true, triaged: true, triaged_evidence: 'e' },
    ],
  });
  // issue #658: escalate 行は checked 有無に関わらず ⚠️ 要判断（未解消）/ ✅ 解消済み の2値。
  // この item は final_resolution が無いため未解消 = ⚠️ 要判断（❌ 未解消 にはならない）。
  assert.ok(body.includes('⚠️ 要判断'), 'escalate item は ⚠️ 要判断 のまま');
  assert.ok(!body.includes('🔹'), 'escalate item に 🔹 は出ない');
  assert.ok(!body.includes('<details>'), 'escalate item は details に入らない');
  assert.ok(body.includes('### ⚠️ 要対応'), '要対応見出しは出る');
});

test('issue #614, #626: triaged item は箇条書きに出ず、details に全文が残る', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    advisoryItems: [
      {
        ...concernItem('[plan:major] A: a'),
        triaged: true,
        triaged_evidence: 'lib/y.ts:20 は未変更。advisory で実害なし',
      },
    ],
  });
  assert.ok(!body.includes('- [plan:major] A: a'), '箇条書き行を含まない');
  const detailsStart = body.indexOf('<details>');
  const detailsEnd = body.indexOf('</details>') + '</details>'.length;
  const detailsRegion = body.slice(detailsStart, detailsEnd);
  assert.ok(detailsRegion.includes('[plan:major] A: a'), 'details に text が残る');
});

test('issue #614: triaged item は「✅ Goal Ledger 解消済み」件数に含まれない', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    advisoryItems: [
      {
        ...concernItem('[plan:major] A: a'),
        triaged: true,
        triaged_evidence: 'lib/y.ts:20 は未変更。advisory で実害なし',
      },
    ],
  });
  assert.ok(!body.includes('✅ Goal Ledger 解消済み'), 'triaged item は解消済み件数に含まれない');
});

test('issue #626: triaged 表示を含む出力は <details>/</details> がちょうど1回ずつ出現する', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    advisoryItems: [
      {
        ...concernItem('[plan:major] A: a'),
        triaged: true,
        triaged_evidence: 'lib/y.ts:20 は未変更。advisory で実害なし',
      },
    ],
  });
  const openCount = (body.match(/<details>/g) || []).length;
  const closeCount = (body.match(/<\/details>/g) || []).length;
  assert.equal(openCount, 1, '<details> はちょうど1回');
  assert.equal(closeCount, 1, '</details> はちょうど1回');
});

test('issue #626: 配置は 要対応事項なし(トリアージ済み件数) < <details> < pr-iterate 未解消の指摘 の順で、details の前後に空行がある', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    advisoryItems: [
      {
        ...concernItem('[plan:major] A: a'),
        triaged: true,
        triaged_evidence: 'lib/y.ts:20 は未変更。advisory で実害なし',
      },
    ],
    iterateStatus: 'fix_failed',
    iterateHistory: HIST_2,
    iterateIterations: 2,
  });
  const lines = body.split('\n');
  const headingIdx = lines.indexOf('### ✅ 要対応事項なし（トリアージ済み 1 件）');
  const detailsIdx = lines.findIndex((l) => l.startsWith('<details>'));
  const iterateIdx = lines.findIndex((l) => l.startsWith('### 🔁 pr-iterate 未解消の指摘'));
  assert.ok(headingIdx >= 0 && detailsIdx > headingIdx, '見出し < details');
  assert.ok(iterateIdx > detailsIdx, 'details < pr-iterate 未解消の指摘');
  assert.equal(lines[detailsIdx - 1], '', 'details 直前は空行');
  const detailsCloseIdx = lines.findIndex((l) => l === '</details>');
  assert.equal(lines[detailsCloseIdx + 1], '', 'details 直後は空行');
});

test('issue #626: dimension:environment の triaged item は環境ノート経路のまま（件数のみ、details なし）', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    advisoryItems: [
      { id: 'ENV-X', text: 't', dimension: 'environment', severity: 'minor', checked: false, triaged: true, triaged_evidence: 'e' },
    ],
  });
  assert.ok(body.includes('### ✅ 要対応事項なし'), '要対応事項なし見出し');
  assert.ok(!body.includes('（トリアージ済み'), '件数サフィックスは付かない');
  assert.ok(!body.includes('<details>'), 'details は出ない');
  assert.ok(body.includes('🏗 環境ノート 1 件'), '環境ノート件数行を含む');
});

// ─── at-a-glance 表は最終状態を出す (issue #625) ───────────────────────────────────

function glanceRow(body) {
  const lines = body.split('\n');
  const i = lines.indexOf('|---|---|---|---|---|---|---|');
  assert.ok(i >= 0, 'at-a-glance 区切り行を含む');
  return lines[i + 1];
}
function glanceCells(body) {
  // 先頭/末尾の空セルを除いた 7 セル。[0]=tier [1]=shape [2]=テスト [3]=評価 [4]=台帳 [5]=AC [6]=危険検出
  return glanceRow(body).split('|').slice(1, -1).map((s) => s.trim());
}

// テスト列（glanceCells[2]）の表示を finalReconcile × finalTestGreen × testGreen の表で見る:
//   AC2: finalReconcile='reverified' は finalTestGreen（最終 tree の再検証結果）を優先する
//        （finalTestGreen=null は 5c の Final reconcile 行と同じ「不明」）。skipped / unavailable / 未指定は testGreen そのまま
test.each([
  { name: 'AC2: reverified, finalTestGreen=true, testGreen=false', input: { finalReconcile: 'reverified', finalTestGreen: true, testGreen: false }, want: '✅ green' },
  { name: 'AC2: reverified, finalTestGreen=false, testGreen=true', input: { finalReconcile: 'reverified', finalTestGreen: false, testGreen: true }, want: '❌ red' },
  { name: 'AC2: reverified, finalTestGreen=null, testGreen=true', input: { finalReconcile: 'reverified', finalTestGreen: null, testGreen: true }, want: '不明' },
  // issue #865 / #1138: test#final の単体再実行で green は red のまま flake 候補を添える（green 扱いにしない）
  { name: '#1138: reverified, finalTestGreen=false + finalTestFlaky', input: { finalReconcile: 'reverified', finalTestGreen: false, finalTestFlaky: { files: ['a.bats'], logs: [] } }, want: '❌ red（単体再実行は green — flake 候補）' },
  { name: '#865: reverified, finalTestGreen=false + finalTestFlaky.files 空', input: { finalReconcile: 'reverified', finalTestGreen: false, finalTestFlaky: { files: [], logs: [] } }, want: '❌ red' },
  { name: 'AC2: skipped, testGreen=false', input: { finalReconcile: 'skipped', testGreen: false }, want: '❌ red' },
  // issue #1138: Final reconcile が skip の run の Validate red は単体再実行で green でも red のまま flake 候補を添える
  { name: '#1138: skipped, Validate failed + finalTestFlaky', input: { finalReconcile: 'skipped', validateTests: 'failed', testGreen: false, finalTestFlaky: { files: ['a.bats'], logs: [] } }, want: '❌ red（単体再実行は green — flake 候補）' },
  { name: '#1138: skipped, Validate failed + finalTestFlaky なし', input: { finalReconcile: 'skipped', validateTests: 'failed', testGreen: false, finalTestFlaky: null }, want: '❌ red' },
  { name: 'AC2: skipped, testGreen=true', input: { finalReconcile: 'skipped', testGreen: true }, want: '✅ green' },
  { name: 'AC2: unavailable, finalTestGreen=null, testGreen=false', input: { finalReconcile: 'unavailable', finalTestGreen: null, testGreen: false }, want: '❌ red' },
  { name: 'AC2: unavailable, finalTestGreen=null, testGreen=true', input: { finalReconcile: 'unavailable', finalTestGreen: null, testGreen: true }, want: '✅ green' },
  { name: 'AC2: unavailable, finalTestGreen=null, testGreen=null', input: { finalReconcile: 'unavailable', finalTestGreen: null, testGreen: null }, want: '不明' },
  { name: '未指定（既存挙動不変）, testGreen=false', input: { testGreen: false }, want: '❌ red' },
])('issue #625 $name → テスト列は $want', ({ input, want }) => {
  const body = buildDevflowSummaryBody({ ...BASE_INPUT, ...input });
  assert.equal(glanceCells(body)[2], want);
});

// AC3: evalVerdict='fail' は evalStaleness/iterateStatus/finalAcReconcile の 4 条件 AND が
// 揃ったときのみ「✅ pass (fix 後 LGTM)」に反転する。
test('issue #625 AC3: 4 条件揃うと ✅ pass (fix 後 LGTM)', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    evalVerdict: 'fail',
    evalStaleness: 'iterate_fixed',
    iterateStatus: 'lgtm',
    finalAcReconcile: 'reverified',
    iterateFixesApplied: 1,
  });
  assert.equal(glanceCells(body)[3], '✅ pass (fix 後 LGTM)');
});

test('issue #625 AC3: 4 条件のいずれか 1 つでも欠けると ❌ fail のまま', () => {
  const variants = [
    { evalStaleness: 'none' },
    { iterateStatus: 'fix_failed' },
    { finalAcReconcile: 'skipped' },
    { evalStaleness: 'iterate_incomplete' },
    { iterateStatus: null },
    { finalAcReconcile: null },
    { finalAcReconcile: 'unavailable' },
  ];
  for (const override of variants) {
    const body = buildDevflowSummaryBody({
      ...BASE_INPUT,
      evalVerdict: 'fail',
      evalStaleness: 'iterate_fixed',
      iterateStatus: 'lgtm',
      finalAcReconcile: 'reverified',
      iterateFixesApplied: 1,
      ...override,
    });
    assert.equal(glanceCells(body)[3], '❌ fail', `override=${JSON.stringify(override)}`);
  }
});

test('issue #625 AC3: evalVerdict=pass は 4 条件の有無に関係なく ✅ pass', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    evalVerdict: 'pass',
    evalStaleness: 'iterate_fixed',
    iterateStatus: 'lgtm',
    finalAcReconcile: 'reverified',
  });
  assert.equal(glanceCells(body)[3], '✅ pass');
});

test('issue #625: evalCell 反転後も iterate_fixed 注記行は残る（確定仕様1）', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    evalVerdict: 'fail',
    evalStaleness: 'iterate_fixed',
    iterateStatus: 'lgtm',
    finalAcReconcile: 'reverified',
    iterateFixesApplied: 1,
  });
  assert.ok(body.includes('pr-iterate が 1 件の fix を適用して LGTM 終端'));
});

// 確定仕様5（理由欄は消さない）+ AC4（merge tier 不変・byte 一致）。
test('issue #625 確定仕様5+AC4: merge tier は不変のまま at-a-glance 表示のみ最終状態を反映する', () => {
  const tierInput = {
    shape: 'standard', converged: true, unresolvedDanger: false,
    breakingStructured: false, breakingKeyword: false,
    docsOrTestOnly: false, escalateCount: 0,
    iterateStatus: 'lgtm', evalStaleness: 'iterate_fixed', evalVerdictFail: true,
    finalReconcile: 'reverified', finalTestGreen: true, finalAcReconcile: 'reverified',
  };
  const r = classifyMergeTier(tierInput);
  // 実装前（F1 時点）に実測した literal。merge-tier.mjs は F1〜F3 のいずれでも変更しないため
  // この値は変更前後で不変であるはずのものを固定している。
  assert.equal(r.tier, 'REVIEW');
  assert.deepEqual(r.holdReasons, []);
  assert.deepEqual(r.reasons, [
    '標準 — 人間が LGTM して merge',
    'evaluator verdict=fail のまま PR へ進行 — 未解消 findings は ledger/HOLD 条件が別途担保するため tier 判定は不変（可視化のみ。issue #536）',
  ]);

  const frozenReasons = Object.freeze([...r.reasons]);
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    mergeTier: r.tier,
    mergeTierReasons: frozenReasons,
    testGreen: false,
    evalVerdict: 'fail',
    evalStaleness: 'iterate_fixed',
    iterateFixesApplied: 1,
    iterateStatus: 'lgtm',
    finalReconcile: 'reverified',
    finalTestGreen: true,
    finalAcReconcile: 'reverified',
    acResults: [{ ac_index: 0, satisfied: true, evidence: 'ok', verified_by: 'evaluator' }],
  });

  assert.equal(glanceCells(body)[2], '✅ green');
  assert.equal(glanceCells(body)[3], '✅ pass (fix 後 LGTM)');

  // issue #658: Final reconcile 行は「参考」セクションへ移動したため、Merge tier 理由の直後には
  // 隣接しなくなった。理由欄は次の空行までの範囲で byte そのまま echo されることのみを検証する。
  const start = body.indexOf('**Merge tier 理由**:');
  const end = body.indexOf('\n\n', start);
  assert.equal(
    body.slice(start, end),
    '**Merge tier 理由**:\n' + frozenReasons.map((x) => '- ' + x).join('\n'),
    '理由欄は byte そのまま echo される（消えない）',
  );

  assert.ok(body.includes('**参考（可視化のみ — merge tier 判定に不使用）**:'), '参考セクション見出しを含む');
  assert.ok(body.includes('- Final reconcile (pr-iterate fix 後の最終 tree 再検証): reverified — final test: ✅ green, final AC: reverified'));
  assert.ok(body.includes('- ✅ AC は最終 PR tree で再検証済み'));
});

test('issue #625: 決定性 — 確定仕様5+AC4 と同一入力で 2 回呼んでも byte 一致', () => {
  const tierInput = {
    shape: 'standard', converged: true, unresolvedDanger: false,
    breakingStructured: false, breakingKeyword: false,
    docsOrTestOnly: false, escalateCount: 0,
    iterateStatus: 'lgtm', evalStaleness: 'iterate_fixed', evalVerdictFail: true,
    finalReconcile: 'reverified', finalTestGreen: true, finalAcReconcile: 'reverified',
  };
  const r = classifyMergeTier(tierInput);
  const frozenReasons = Object.freeze([...r.reasons]);
  const input = {
    ...BASE_INPUT,
    mergeTier: r.tier,
    mergeTierReasons: frozenReasons,
    testGreen: false,
    evalVerdict: 'fail',
    evalStaleness: 'iterate_fixed',
    iterateFixesApplied: 1,
    iterateStatus: 'lgtm',
    finalReconcile: 'reverified',
    finalTestGreen: true,
    finalAcReconcile: 'reverified',
    acResults: [{ ac_index: 0, satisfied: true, evidence: 'ok', verified_by: 'evaluator' }],
  };
  const body1 = buildDevflowSummaryBody(input);
  const body2 = buildDevflowSummaryBody(input);
  assert.equal(body1, body2);
});

test('issue #625: 既存表示の回帰なし — 未指定と null 明示は byte 一致', () => {
  const bodyImplicit = buildDevflowSummaryBody({ ...BASE_INPUT });
  const bodyExplicit = buildDevflowSummaryBody({
    ...BASE_INPUT,
    finalReconcile: null,
    finalTestGreen: null,
    finalAcReconcile: null,
    iterateStatus: null,
    evalStaleness: null,
  });
  assert.equal(bodyImplicit, bodyExplicit);
});

// ─── issue #658: 結論行 / あなたがやること / HOLD 理由と現状 / 要対応表の現状・対応列 / 参考 ───

test('issue #658 AC-1: 結論行が見出し直後・at-a-glance 表より前にあり、HOLD+ESCALATE 全件解消で「修正作業は不要です」になる', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    mergeTier: 'HOLD',
    mergeTierReasons: ['legacy reason unused'],
    holdReasons: [{ code: 'escalate', reason: 'ESCALATE-TO-HUMAN 項目 1 件', kind: 'human_judgment' }],
    holdKind: 'human_judgment',
    advisoryItems: [
      { id: 'A1', text: 'needs escalation', severity: 'major', checked: true, dimension: 'design', escalate: true, final_resolution: 'resolved', final_evidence: 'verified in fix tree' },
    ],
    finalReconcile: 'reverified', finalTestGreen: true,
  });
  const headingIdx = body.indexOf('## dev-flow 終端サマリー');
  const conclusionIdx = body.indexOf('**結論:');
  const tableIdx = body.indexOf('| Merge tier |');
  assert.ok(headingIdx === 0 && conclusionIdx > headingIdx && conclusionIdx < tableIdx, '結論行は見出し直後・at-a-glance 表より前');
  assert.ok(body.includes('**結論: 自動マージ対象外（HOLD）。修正作業は不要です。**'), '結論行の全文（行動指示は「あなたがやること」にだけ書く。issue #829）');
});

test('issue #658 AC-2: HOLD+ESCALATE 全件解消 -> 要対応表の escalate 行が ✅ 解消済み / 対応 不要 になり見出しは要対応事項なしになる（final_evidence 空なら ⚠️ 要判断 のまま）', () => {
  const resolvedItem = {
    id: 'A1', text: 'needs escalation', severity: 'major', checked: true, dimension: 'design',
    escalate: true, final_resolution: 'resolved', final_evidence: 'verified in fix tree',
  };
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    mergeTier: 'HOLD',
    holdReasons: [{ code: 'escalate', reason: 'ESCALATE-TO-HUMAN 項目 1 件', kind: 'human_judgment' }],
    holdKind: 'human_judgment',
    advisoryItems: [resolvedItem],
    finalReconcile: 'reverified', finalTestGreen: true,
  });
  assert.ok(body.includes('### ✅ 要対応事項なし'), '見出しは要対応事項なし');
  assert.ok(!body.includes('### ⚠️ 要対応'), '⚠️ 要対応見出しは出ない');
  assert.ok(
    body.includes('| ✅ 解消済み | 要判断（advisory ESCALATE） | design | needs escalation | fix 後 tree で確認: verified in fix tree | 不要 |'),
    '解消済み escalate 行が現状/対応付きで表示される',
  );

  const bodyEmptyEvidence = buildDevflowSummaryBody({
    ...BASE_INPUT,
    advisoryItems: [{ ...resolvedItem, final_evidence: '' }],
  });
  assert.ok(bodyEmptyEvidence.includes('⚠️ 要判断'), 'final_evidence が空なら ⚠️ 要判断 のまま');
  assert.ok(!bodyEmptyEvidence.includes('✅ 解消済み'), 'final_evidence が空なら解消済み表示にならない');
});

test('issue #658 / #1138: final_resolution=ci_delegated は PR の CI の success を根拠にするので解消扱いにしない', () => {
  const item = {
    id: 'A1', text: 'ci delegated item', severity: 'major', checked: false, dimension: 'design',
    escalate: true, final_resolution: 'ci_delegated', final_evidence: 'CI check X success',
  };
  for (const fr of ['reverified', null, 'unavailable', 'skipped']) {
    const body = buildDevflowSummaryBody({ ...BASE_INPUT, advisoryItems: [item], finalReconcile: fr });
    assert.ok(body.includes('⚠️ 要判断'), `finalReconcile=${fr} では未解消のまま`);
    assert.ok(!body.includes('✅ 解消済み'), `finalReconcile=${fr} では解消済み表示にならない`);
  }
});

test('issue #658: blocking lane の final_resolution は無視される（byte 一致）', () => {
  const withResolution = buildDevflowSummaryBody({
    ...BASE_INPUT,
    blockingItems: [{ id: 'B1', text: 'blocked', severity: 'critical', checked: false, dimension: 'security', final_resolution: 'resolved', final_evidence: 'should be ignored' }],
  });
  const withoutResolution = buildDevflowSummaryBody({
    ...BASE_INPUT,
    blockingItems: [{ id: 'B1', text: 'blocked', severity: 'critical', checked: false, dimension: 'security' }],
  });
  assert.equal(withResolution, withoutResolution, 'blocking lane では final_resolution が無視され byte 一致');
  assert.ok(withResolution.includes('❌ 未解消'), 'blocking item は ❌ 未解消 のまま');
});

test('issue #658 AC-3: HOLD 理由と現状テーブルに holdReasons の reason が verbatim で並び、code ごとの現状/対応が写像される（未知 code は fail-safe）', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    mergeTier: 'HOLD',
    mergeTierReasons: ['legacy reason unused'],
    holdReasons: [
      { code: 'escalate', reason: 'ESCALATE-TO-HUMAN 項目 1 件', kind: 'human_judgment' },
      { code: 'unknown_future_code', reason: 'some future reason', kind: 'human_judgment' },
    ],
    holdKind: 'human_judgment',
    advisoryItems: [
      { id: 'A1', text: 'needs escalation', severity: 'major', checked: true, dimension: 'design', escalate: true, final_resolution: 'resolved', final_evidence: 'verified' },
    ],
    finalReconcile: 'reverified', finalTestGreen: true,
  });
  assert.ok(body.includes('### HOLD になった理由と現状'), 'HOLD 理由テーブル見出しを含む');
  assert.ok(body.includes('| 理由 | 現状 | 対応 |'), 'HOLD 理由テーブルヘッダーを含む');
  assert.ok(
    body.includes('| ESCALATE-TO-HUMAN 項目 1 件 | ESCALATE 1 件中 1 件は fix 後 tree で解消確認済み | 不要（マージ可否の判断のみ） |'),
    'escalate 行の現状/対応を含む',
  );
  assert.ok(body.includes('| some future reason | — | 人が確認する |'), '未知 code は fail-safe 表示（throw しない）');
  assert.ok(!body.includes('**Merge tier 理由**:'), 'holdReasons があるときは従来の箇条書きに落ちない');
});

test('issue #658: holdReasons が null で mergeTier=HOLD -> 従来の Merge tier 理由 箇条書きにフォールバックする（fail-safe）', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    mergeTier: 'HOLD',
    mergeTierReasons: ['danger hit detected'],
    holdReasons: null,
  });
  assert.ok(body.includes('**Merge tier 理由**:'), 'Merge tier 理由の箇条書きにフォールバックする');
  assert.ok(body.includes('- danger hit detected'), '理由文字列を含む');
  assert.ok(!body.includes('### HOLD になった理由と現状'), 'HOLD 理由テーブルは出ない');
});

test('PR#662 レビュー: mergeable_conflicting 単独 HOLD でも結論行が「修正作業が必要です」になる（HOLD 理由テーブルの対応列と矛盾しない）', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    mergeTier: 'HOLD',
    mergeTierReasons: ['base branch と conflict'],
    holdReasons: [{ code: 'mergeable_conflicting', reason: 'base branch と conflict', kind: 'human_judgment' }],
    holdKind: 'human_judgment',
  });
  assert.ok(
    body.includes('**結論: 自動マージ対象外（HOLD）。修正作業が必要です。**'),
    '結論行は修正作業が必要です',
  );
  assert.ok(body.includes('| base branch と conflict | base branch と conflict | conflict を解消して push する |'), 'HOLD 理由テーブルの対応列');
});

test('issue #661: pr_closes_missing 単独 HOLD で現状/対応表示と gh pr edit の再投入手順が出る（結論行は修正作業が必要）', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    mergeTier: 'HOLD',
    mergeTierReasons: ['PR body に `Closes #<issue>` 行が無い'],
    holdReasons: [{ code: 'pr_closes_missing', reason: 'PR body に Closes 行が無い', kind: 'deterministic_recheck' }],
    holdKind: 'deterministic_recheck',
  });
  assert.ok(
    body.includes('PR body に Closes 行が無い（merge しても issue が自動 close されない）'),
    '現状列に Closes 欠落の説明が出る',
  );
  assert.ok(
    body.includes('`gh pr edit 42 --body-file <本文ファイル>` で Closes 行を含む本文を再投入する'),
    '対応列に gh pr edit の再投入手順が出る（pr 番号は入力値）',
  );
  assert.ok(!body.includes('修正作業は不要'), '結論行は「修正作業は不要」ではない');
});

test('issue #834: ci_checks_failed 単独 HOLD で現状/対応に CI 失敗と gh pr checks の確認手順が出る（結論行は修正作業が必要）', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    mergeTier: 'HOLD',
    mergeTierReasons: ['CI checks 失敗（Bats Tests）'],
    holdReasons: [{ code: 'ci_checks_failed', reason: 'CI checks 失敗（Bats Tests）', kind: 'human_judgment' }],
    holdKind: 'human_judgment',
  });
  assert.ok(body.includes('| CI checks 失敗（Bats Tests） | PR head の CI checks が失敗（fail / cancel） | `gh pr checks 42` で失敗した check を確認し、修正して push する |'), body);
  assert.ok(body.includes('修正作業が必要です'), '結論行は修正作業が必要');
});

test('issue #1086: validate_test_red 単独 HOLD は final_test_red と同じく修正が必要な HOLD で、現状/対応に Validate red の説明と対処が出る', () => {
  const REASON = 'Validate test red（green-fix の上限後も diff 起因のテスト失敗が残ったまま PR へ進行）';
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    mergeTier: 'HOLD',
    mergeTierReasons: [REASON],
    holdReasons: [{ code: 'validate_test_red', reason: REASON, kind: 'human_judgment' }],
    holdKind: 'human_judgment',
  });
  assert.ok(body.includes(`| ${REASON} | Validate のテスト失敗が残ったまま PR へ進行（pr-iterate の fix 0 件で最終 tree の再検証なし） | 修正が必要（落ちたテストを直して push する） |`), body);
  assert.ok(body.includes('修正作業が必要です'), '結論行は修正作業が必要');
  assert.ok(!body.includes('修正作業は不要'), '結論行は「修正作業は不要」ではない');
});

test('issue #1117: validate_tests_not_run 単独 HOLD は現状に「テストが 1 件も実行されていない」、対応は手元実行か CI 確認', () => {
  const REASON = 'テストが 1 件も実行されていない（Validate tests:error = テスト起動失敗）';
  const row = buildDevflowSummaryBody({
    ...BASE_INPUT,
    mergeTier: 'HOLD',
    mergeTierReasons: [REASON],
    holdReasons: [{ code: 'validate_tests_not_run', reason: REASON, kind: 'human_judgment' }],
    holdKind: 'human_judgment',
  }).split('\n').find((l) => l.startsWith(`| ${REASON} |`));
  assert.equal(row, `| ${REASON} | テストが 1 件も実行されていない（ローカルは起動失敗） | テストを手元で実行するか、CI の test 結果を確認する |`);
});

test('issue #1082: security_review_unresolved は stop_reason=reviewer_context_changed なら「自動 review をしていない」と変わった指示ファイルを一覧する固定コマンド、それ以外は従来の文面', () => {
  const REASON = '敵対的 security review が今の PR head で clear になっていない';
  const rowOf = (securityReview) => buildDevflowSummaryBody({
    ...BASE_INPUT,
    mergeTier: 'HOLD',
    mergeTierReasons: [REASON],
    holdReasons: [{ code: 'security_review_unresolved', reason: REASON, kind: 'human_judgment' }],
    holdKind: 'human_judgment',
    securityReview,
  }).split('\n').find((l) => l.startsWith(`| ${REASON} |`));
  const changed = rowOf({ target: true, status: 'unresolved', stop_reason: 'reviewer_context_changed', rounds: 0, critical: 0, major: 0, minor: 0 });
  // 対応列: 変わった指示ファイルの一覧コマンドと、隔離した security review（issue #1083）の実行案内
  const ISOLATED = 'Anthropic API に通信できるシェル（plugin の bin/ が PATH に載る Claude Code のセッション等）で `security-review-isolated 42` を実行すると、PR の worktree に入らない別プロセスで security review を回せる（結果は gate に戻らない — merge 判断の材料）';
  assert.equal(changed, `| ${REASON} | 指示ファイルを変える PR なので自動 review をしていない（review 0 回） | \`gh pr diff 42 --name-only \\| grep -iE '(^\\|/)(claude(\\.local)?\\|agents)\\.md$\\|^\\.claude/'\` で変わった指示ファイルを一覧し、人が中身と diff を確認する（\`@\` import 先も確かめる）。${ISOLATED} |`);
  for (const want of ['自動 review をしていない', '指示ファイルを変える PR', 'review 0 回']) assert.ok(changed.includes(want), want);
  for (const want of ['`security-review-isolated 42`', 'Anthropic API に通信できるシェル', 'plugin の bin/ が PATH に載る Claude Code のセッション', 'gate に戻らない', 'merge 判断の材料']) assert.ok(changed.includes(want), want);
  assert.ok(!changed.includes('clear になっていない（'), '現状に「clear になっていない」を出さない');
  // 確認コマンドと実行案内は固定で、差し込むのは PR 番号だけ（PR が決めた文字列 — ファイル名・branch 名 — は入らない）
  const other = buildDevflowSummaryBody({
    ...BASE_INPUT, pr: 7, mergeTier: 'HOLD', mergeTierReasons: [REASON],
    holdReasons: [{ code: 'security_review_unresolved', reason: REASON, kind: 'human_judgment' }], holdKind: 'human_judgment',
    securityReview: { target: true, status: 'unresolved', stop_reason: 'reviewer_context_changed', rounds: 0 },
  }).split('\n').find((l) => l.startsWith(`| ${REASON} |`));
  assert.equal(other, changed.replace('gh pr diff 42 ', 'gh pr diff 7 ').replace('`security-review-isolated 42`', '`security-review-isolated 7`'));

  // review を実行して critical / major が残った・review 前の別の前提チェックで止めた・review に到達しなかった run は従来の文面
  const ACTION = '`/pr-iterate 42` で回収するか、人が diff を確認する（指摘の本文は公開コメントに載せない）';
  assert.equal(rowOf({ target: true, status: 'unresolved', stop_reason: null, rounds: 2, critical: 1, major: 2, minor: 0 }),
    `| ${REASON} | security review が今の PR head で clear になっていない（敵対的 review 2 回・最終 critical 1 / major 2） | ${ACTION} |`);
  assert.equal(rowOf({ target: true, status: 'unresolved', stop_reason: 'diff_unavailable', rounds: 0, critical: 0, major: 0, minor: 0 }),
    `| ${REASON} | security review が今の PR head で clear になっていない（敵対的 review 0 回・最終 critical 0 / major 0） | ${ACTION} |`);
  assert.equal(rowOf({ target: true, status: 'not_run', stop_reason: null, rounds: 0, critical: 0, major: 0, minor: 0 }),
    `| ${REASON} | security review が今の PR head で clear になっていない（LGTM の前の review に到達していない） | ${ACTION} |`);
  // fix が直さずに人の判断に返した指摘は件数だけを出す（issue #1121）
  assert.equal(rowOf({ target: true, status: 'unresolved', stop_reason: null, rounds: 1, critical: 1, major: 1, minor: 0, deferred: 2 }),
    `| ${REASON} | security review が今の PR head で clear になっていない（敵対的 review 1 回・最終 critical 1 / major 1）— security の指摘 2 件を fix が直さずに人の判断に返した | ${ACTION} |`);
});

test('issue #834: 「CI 未完了」の開示（disclosures）は REVIEW の終端サマリの参考に出る', () => {
  const line = 'CI 未完了（pending: Bats Tests）— Merge tier は CI の完了を待たない（fail-open。HOLD 理由にしない）。merge 前に gh pr checks で結果を確認する';
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    mergeTier: 'REVIEW',
    mergeTierReasons: ['標準 — 人間が LGTM して merge', line],
    disclosures: [line],
  });
  assert.ok(body.includes(`- ${line}`), body);
});

test('issue #662: changedFiles に .github/workflows/ 配下のファイルが含まれる場合、あなたがやること に workflow 初回実行確認行が出る（finalReconcile 非依存）', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    mergeTier: 'REVIEW',
    changedFiles: ['plugins/dev-flow/_lib/foo.mjs', '.github/workflows/ci.yml'],
    finalReconcile: null,
  });
  assert.ok(body.includes('マージ後: 対象 workflow の初回実行を確認する'), 'workflow 変更検知行が出る');

  const bodyNoWorkflow = buildDevflowSummaryBody({
    ...BASE_INPUT,
    mergeTier: 'REVIEW',
    changedFiles: ['plugins/dev-flow/_lib/foo.mjs'],
    finalReconcile: null,
  });
  assert.ok(!bodyNoWorkflow.includes('マージ後: 対象 workflow の初回実行を確認する'), 'workflow 変更が無ければ出ない');
});

test('issue #658 AC-3: disclosures は Merge tier 理由から除外され「参考」セクションへ回る（1 行もなければ参考自体が出ない）', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    mergeTier: 'REVIEW',
    mergeTierReasons: ['LLM judge advisory', 'breaking keyword hit (可視化のみ)'],
    disclosures: ['breaking keyword hit (可視化のみ)'],
  });
  const reasonStart = body.indexOf('**Merge tier 理由**:');
  const reasonEnd = body.indexOf('\n\n', reasonStart);
  const reasonSection = body.slice(reasonStart, reasonEnd);
  assert.ok(!reasonSection.includes('breaking keyword hit'), '可視化のみの理由は Merge tier 理由から除外される');
  assert.ok(reasonSection.includes('LLM judge advisory'), 'HOLD 判定に寄与する理由は残る');
  assert.ok(body.includes('**参考（可視化のみ — merge tier 判定に不使用）**:'), '参考セクション見出しを含む');
  assert.ok(body.includes('- breaking keyword hit (可視化のみ)'), '参考セクションに disclosures が箇条書きで出る');

  const bodyNoRef = buildDevflowSummaryBody({ ...BASE_INPUT });
  assert.ok(!bodyNoRef.includes('**参考（可視化のみ'), 'disclosures/Final reconcile が無ければ参考セクション自体が出ない');
});

test('issue #658 AC-4: あなたがやること に danger class 由来のマージ後確認が入力順・重複除去で並び、未知 class は汎用文になる', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    mergeTier: 'REVIEW',
    dangerHits: ['data-migration', 'dependency', 'data-migration', 'unknown-future-class'],
  });
  const youDoLines = body.split('\n').filter(l => l.includes('マージ後:'));
  assert.equal(youDoLines.length, 3, 'data-migration / dependency / unknown-future-class の計3行（重複除去）');
  assert.ok(youDoLines[0].includes('migration を含む'), '1件目は data-migration の定型文（入力順）');
  assert.ok(youDoLines[1].includes('依存関係の変更を含む'), '2件目は dependency の定型文');
  assert.ok(youDoLines[2].includes('danger class "unknown-future-class" の変更箇所の初回動作を確認する'), '未知 class は汎用文');
});

// ─── issue #858: security clearance で cleared の danger class は未解決の危険として出さない ─────

const PUBLIC_API_NOTICE = 'マージ後: 公開 API の変更を含む';

test('issue #858: public-api 検出 + SEC seed cleared -> マージ後の告知行が無く、危険検出セルは ✅ cleared、検出クラス行に（cleared）が付く', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    dangerHits: ['public-api'],
    blockingItems: [secLedgerItem('public-api', { checked: true, evidence: 'security cleared: 公開 API の追加・変更は diff に無い' })],
  });
  assert.ok(!body.includes(PUBLIC_API_NOTICE), 'cleared クラスのマージ後の告知行は出ない');
  assert.equal(glanceCells(body)[6], '✅ cleared（1 クラス）', '危険検出セルは cleared 表示');
  assert.ok(body.includes('検出クラス: public-api（cleared）'), '検出クラス行は残し cleared と分かる形');
});

test('issue #858: public-api 検出 + SEC seed unchecked -> 従来どおり告知行と ⚠️ が出る', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    mergeTier: 'HOLD',
    dangerHits: ['public-api'],
    blockingItems: [secLedgerItem('public-api', { checked: false, evidence: null })],
  });
  assert.ok(body.includes(PUBLIC_API_NOTICE), '未確認クラスのマージ後の告知行は出る');
  assert.equal(glanceCells(body)[6], '⚠️ 1 クラス', '危険検出セルは ⚠️');
  assert.ok(body.split('\n').includes('検出クラス: public-api'), '未確認クラスに（cleared）は付かない');
});

test('issue #858: 2 クラス検出で片方だけ cleared -> cleared でない方だけマージ後の行が出て、セルは ⚠️ のまま', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    mergeTier: 'HOLD',
    dangerHits: ['public-api', 'data-migration'],
    blockingItems: [
      secLedgerItem('public-api', { checked: true, evidence: 'security cleared: 既存 export の import のみ' }),
      secLedgerItem('data-migration', { checked: false, evidence: null }),
    ],
  });
  const postMerge = body.split('\n').filter(l => l.includes('マージ後:'));
  assert.equal(postMerge.length, 1, 'マージ後の行は cleared でない 1 クラス分だけ');
  assert.ok(postMerge[0].includes('migration を含む'), 'data-migration の定型文');
  assert.ok(!body.includes(PUBLIC_API_NOTICE), 'cleared の public-api は出ない');
  assert.equal(glanceCells(body)[6], '⚠️ 2 クラス', 'cleared でないクラスが残るので ⚠️');
  assert.ok(body.includes('検出クラス: public-api（cleared）, data-migration'), 'cleared の方だけ（cleared）が付く');
});

test('issue #658 AC-4: HOLD kind ごとに「あなたがやること」の定型文が切り替わる', () => {
  const bodyFixRequired = buildDevflowSummaryBody({
    ...BASE_INPUT,
    mergeTier: 'HOLD',
    blockingItems: [{ id: 'B1', text: 'blocked', severity: 'critical', checked: false, dimension: 'security' }],
  });
  assert.ok(bodyFixRequired.includes('下記「要対応」の ❌ 項目を修正して push する'), 'fixRequired=true の定型文');

  const bodyDeterministic = buildDevflowSummaryBody({
    ...BASE_INPUT,
    mergeTier: 'HOLD',
    holdKind: 'deterministic_recheck',
  });
  assert.ok(bodyDeterministic.includes('CI 完了 / 再取得を待って'), 'holdKind=deterministic_recheck の定型文');

  const bodyHuman = buildDevflowSummaryBody({
    ...BASE_INPUT,
    mergeTier: 'HOLD',
    holdKind: 'human_judgment',
  });
  assert.ok(bodyHuman.includes('下記「HOLD になった理由と現状」を確認し'), 'holdKind=human_judgment（fixRequired=false）の定型文');
});

test('issue #658 AC-5: 解消済み証跡セクションが要対応セクションより下にあり、fix 後解消確認の件数行が末尾に追加される', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    blockingItems: [{ id: 'B1', text: 'resolved', severity: 'major', checked: true, dimension: 'quality' }],
    advisoryItems: [
      { id: 'A1', text: 'needs escalation', severity: 'major', checked: true, dimension: 'design', escalate: true, final_resolution: 'resolved', final_evidence: 'verified' },
    ],
  });
  const actionIdx = body.indexOf('### ⚠️ 要対応');
  const noneIdx = body.indexOf('### ✅ 要対応事項なし');
  const headingIdx = actionIdx >= 0 ? actionIdx : noneIdx;
  const resolvedIdx = body.indexOf('**解消済み証跡');
  assert.ok(headingIdx >= 0 && resolvedIdx > headingIdx, '解消済み証跡セクションは要対応セクションより下にある');
  assert.ok(body.includes(' / ✅ fix 後 tree で解消確認 1 件（advisory / ESCALATE — checked は不変）</summary>'), 'fix 後解消確認の件数行をサマリ行の末尾に含む');
});

test('決定性: issue #658 の新フィールド込み入力でも 2回呼んで byte 完全一致', () => {
  const input = {
    ...BASE_INPUT,
    mergeTier: 'HOLD',
    mergeTierReasons: ['legacy reason unused'],
    holdReasons: [{ code: 'escalate', reason: 'ESCALATE-TO-HUMAN 項目 1 件', kind: 'human_judgment' }],
    holdKind: 'human_judgment',
    disclosures: ['breaking keyword hit (可視化のみ)'],
    dangerHits: ['data-migration'],
    advisoryItems: [
      { id: 'A1', text: 'needs escalation', severity: 'major', checked: true, dimension: 'design', escalate: true, final_resolution: 'resolved', final_evidence: 'verified', escalate_description: 'detail text' },
    ],
    finalReconcile: 'reverified',
    finalTestGreen: true,
  };
  const body1 = buildDevflowSummaryBody(input);
  const body2 = buildDevflowSummaryBody(input);
  assert.equal(body1, body2);
});

// ─── issue #707: テスト欄の未実行/未検証・見出しの必須/任意の分離 ─────────────

function conclusionLine(body) {
  return body.split('\n').find((l) => l.startsWith('**結論: '));
}

test("issue #707 AC1: Validate tests:'error' → テスト欄は ❌ red ではなく未実行/未検証、結論行で CI 確認を促す", () => {
  for (const finalReconcile of ['skipped', 'unavailable', undefined]) {
    const body = buildDevflowSummaryBody({ ...BASE_INPUT, testGreen: false, validateTests: 'error', finalReconcile });
    const cell = glanceCells(body)[2];
    assert.equal(cell, '⚠️ 未実行（環境）・未検証', `finalReconcile=${finalReconcile}`);
    assert.ok(!cell.includes('❌'), 'テスト欄に ❌ を含まない');
    assert.ok(conclusionLine(body).includes('CI の test 結果を確認してからマージ'), '結論行に CI 確認を含む');
  }
});

test("issue #707 AC3: 実際にテストが失敗した場合（tests:'failed'）は従来どおり ❌ red", () => {
  const body = buildDevflowSummaryBody({ ...BASE_INPUT, testGreen: false, validateTests: 'failed', finalReconcile: 'skipped' });
  assert.equal(glanceCells(body)[2], '❌ red');
  assert.ok(!conclusionLine(body).includes('CI の test 結果を確認してから'), 'red は未検証扱いしない');
  // Final reconcile の reverified red は Validate の tests:'error' より優先（最終状態）
  const bodyFinalRed = buildDevflowSummaryBody({ ...BASE_INPUT, testGreen: false, validateTests: 'error', finalReconcile: 'reverified', finalTestGreen: false });
  assert.equal(glanceCells(bodyFinalRed)[2], '❌ red');
  // validateTests 未指定の既定出力は tests:'failed' 指定時と同じ（❌ red）
  assert.equal(glanceCells(buildDevflowSummaryBody({ ...BASE_INPUT, testGreen: false }))[2], '❌ red');
  assert.equal(glanceCells(buildDevflowSummaryBody({ ...BASE_INPUT, testGreen: true, validateTests: 'passed' }))[2], '✅ green');
});

test('issue #707: validateTests の enum 外は明示 error', () => {
  assert.throws(() => buildDevflowSummaryBody({ ...BASE_INPUT, validateTests: 'fail' }), /invalid validateTests/);
});

test('issue #707 AC4: advisory のみのとき見出しは「ℹ️ 任意の確認事項」で「⚠️ 要対応」にならず、結論行の「助言 N 件は任意」と一致する', () => {
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    mergeTier: 'REVIEW',
    advisoryItems: [
      { id: 'A1', text: 'naming nit', severity: 'minor', checked: false, dimension: 'style', escalate: false, evidence: null },
    ],
  });
  assert.ok(!body.includes('⚠️ 要対応'), '⚠️ 要対応を含まない');
  assert.ok(body.includes('### ℹ️ 任意の確認事項'), '任意の確認事項見出しを含む');
  assert.ok(!body.includes('### ✅ 要対応事項なし'), '要対応事項なし見出しとも重ならない');
  assert.ok(conclusionLine(body).includes('必須の修正作業はありません（助言 1 件は任意）'), '結論行は助言 1 件は任意');
  const headingIdx = body.indexOf('### ℹ️ 任意の確認事項');
  assert.ok(body.indexOf('| ℹ️ 未確認 | 助言（advisory） | style | naming nit |') > headingIdx, '助言行は任意の確認事項の下に出る');
  assert.ok(body.includes('| 任意（助言） |'), '対応列は任意（助言）');
});

test('issue #707 AC5: 必須項目があれば advisory が混在していても従来どおり「⚠️ 要対応」', () => {
  const advisory = { id: 'A1', text: 'naming nit', severity: 'minor', checked: false, dimension: 'style', escalate: false };
  const cases = {
    'unchecked blocking': { blockingItems: [{ id: 'B1', text: 'bug', severity: 'critical', checked: false, dimension: 'correctness' }] },
    'escalate 未解消': { advisoryItems: [advisory, { id: 'E1', text: 'needs human', severity: 'major', checked: false, dimension: 'design', escalate: true }] },
    'AC 未達': { acResults: [{ ac_index: 0, satisfied: false, evidence: 'ng', verified_by: 'evaluator' }] },
    'security 未クリア': { blockingItems: [secLedgerItem('config', { checked: false })] },
    'testsurf 未クリア': { blockingItems: [testsurfLedgerItem('SKIP_ADDED', { checked: false })], testsurfHits: ['SKIP_ADDED'] },
    'fixRequired な HOLD reason': { mergeTier: 'HOLD', holdReasons: [{ code: 'mergeable_conflicting', reason: 'base と conflict', kind: 'human_judgment' }] },
  };
  for (const [name, extra] of Object.entries(cases)) {
    const body = buildDevflowSummaryBody({ ...BASE_INPUT, advisoryItems: [advisory], ...extra });
    assert.ok(body.includes('### ⚠️ 要対応'), `${name}: ⚠️ 要対応を含む`);
    // 混在する助言は「⚠️ 要対応」の後ろの別節に出る（issue #738）
    assert.ok(body.indexOf('### ℹ️ 任意の確認事項') > body.indexOf('### ⚠️ 要対応'), `${name}: 助言は要対応の後ろの任意の確認事項に出る`);
  }
  // 表が直下に出ない必須項目（HOLD reason のみ）は参照先を示す
  const bodyHoldOnly = buildDevflowSummaryBody({ ...BASE_INPUT, ...cases['fixRequired な HOLD reason'] });
  assert.ok(bodyHoldOnly.includes('「HOLD になった理由と現状」・TESTSURF・pr-iterate 未解消の指摘 の未解消行を対応する'), '参照先行を含む');
});

// ─── issue #738: 必須と助言の分離・助言の状態表示・観点 ac の二重表示 ─────────────

// heading から次の見出し / <details> までの本文を返す（heading が無ければ null）
function sectionOf(body, heading) {
  const start = body.indexOf(heading);
  if (start < 0) return null;
  const rest = body.slice(start + heading.length);
  const ends = ['\n### ', '\n<details>', '\n---'].map((m) => rest.indexOf(m)).filter((i) => i >= 0);
  return rest.slice(0, ends.length > 0 ? Math.min(...ends) : rest.length);
}

// PR #1510 型: blocking 未解消 + 未達 AC#4/#5 + 同じ AC を指す観点 ac の advisory + 通常の助言
const MIXED_738 = {
  ...BASE_INPUT,
  mergeTier: 'HOLD',
  holdReasons: [{ code: 'ac_agent_unsatisfied', reason: 'AC 未達 2 件', kind: 'human_judgment' }],
  blockingItems: [{ id: 'B1', text: 'null deref', severity: 'critical', checked: false, dimension: 'correctness', evidence: 'src/a.ts:10' }],
  advisoryItems: [
    { id: 'A1', text: 'naming nit', severity: 'minor', checked: false, dimension: 'style', escalate: false },
    { id: 'AC-4', text: 'staging で実測する（人手）', severity: 'major', checked: false, dimension: 'ac', escalate: false },
    { id: 'AC-FINAL-5', text: '[final-reconcile 不成立] pnpm precheck が green', severity: 'critical', checked: false, dimension: 'ac', escalate: false },
  ],
  ledgerConverged: false,
  acResults: [0, 1, 2, 3, 4].map((i) => ({ ac_index: i, satisfied: i < 3, evidence: `ev${i}`, verified_by: 'evaluator' })),
  evalVerdict: 'fail',
};

test('issue #738 AC1: 必須と未解消の助言が両方あるとき、助言は「⚠️ 要対応」の表に入らず「ℹ️ 任意の確認事項」の節に出る', () => {
  const body = buildDevflowSummaryBody(MIXED_738);
  const required = sectionOf(body, '### ⚠️ 要対応');
  const optional = sectionOf(body, '### ℹ️ 任意の確認事項');
  assert.ok(required != null, '⚠️ 要対応 を含む');
  assert.ok(optional != null, 'ℹ️ 任意の確認事項 を含む');
  assert.ok(body.indexOf('### ℹ️ 任意の確認事項') > body.indexOf('### ⚠️ 要対応'), '任意の確認事項は要対応の後ろ');
  assert.ok(required.includes('| ❌ 未解消 | 必須（blocking） | correctness | null deref |'), '要対応に blocking 行');
  assert.ok(required.includes('| ❌ 未達 | AC#4 |') && required.includes('| ❌ 未達 | AC#5 |'), '要対応に未達 AC 表');
  assert.ok(!required.includes('助言（advisory）'), '要対応に助言の行を含まない');
  assert.ok(!required.includes('任意（助言）'), '要対応に「任意（助言）」を含まない');
  assert.ok(optional.includes('| ℹ️ 未確認 | 助言（advisory） | style | naming nit |'), '助言は任意の確認事項に出る');
  assert.ok(!optional.includes('必須（blocking）'), '任意の確認事項に blocking 行を含まない');
});

test('issue #738 AC2: 助言の行の状態に ❌ を使わない（必須と混在 / 助言のみ の両方）', () => {
  const bodies = {
    mixed: buildDevflowSummaryBody(MIXED_738),
    advisoryOnly: buildDevflowSummaryBody({
      ...BASE_INPUT,
      advisoryItems: [{ id: 'A1', text: 'naming nit', severity: 'minor', checked: false, dimension: 'style', escalate: false }],
    }),
  };
  for (const [name, body] of Object.entries(bodies)) {
    const advisoryLines = body.split('\n').filter((l) => l.includes('| 助言（advisory） |'));
    assert.ok(advisoryLines.length > 0, `${name}: 助言の行がある`);
    for (const l of advisoryLines) {
      assert.ok(!l.includes('❌'), `${name}: 助言の行に ❌ を含まない: ${l}`);
      assert.ok(l.startsWith('| ℹ️ 未確認 |'), `${name}: 助言の未解消は ℹ️ 未確認: ${l}`);
    }
  }
});

test('issue #738 AC3: 未達 AC と同じ AC を指す観点 ac の未解消 advisory は「任意（助言）」として出ず、未達 AC 表にだけ出る', () => {
  const body = buildDevflowSummaryBody(MIXED_738);
  for (const text of ['staging で実測する（人手）', 'pnpm precheck が green']) {
    assert.ok(!body.includes(text), `${text}: 助言の行として出ない`);
  }
  assert.ok(!body.split('\n').some((l) => l.includes('| ac |') && l.includes('任意（助言）')), '観点 ac の行が任意（助言）で出ない');
  const acRows = body.split('\n').filter((l) => l.startsWith('| ❌ 未達 | AC#'));
  assert.deepEqual(acRows.map((l) => l.split('|')[2].trim()), ['AC#4', 'AC#5'], '未達 AC 表には AC#4 / AC#5 が 1 回ずつ');
  // 助言の件数からも外れる（結論行の件数と任意の確認事項の行数が一致）
  assert.ok(conclusionLine(body).includes('（助言 1 件は任意）'), '結論行の助言件数は ac 重複を除いた 1 件');

  // 達成済み AC を指す観点 ac の advisory は重ならないので、従来どおり助言として残る
  const bodySatisfied = buildDevflowSummaryBody({
    ...MIXED_738,
    advisoryItems: [{ id: 'AC-1', text: 'AC one', severity: 'major', checked: false, dimension: 'ac', escalate: false }],
  });
  assert.ok(sectionOf(bodySatisfied, '### ℹ️ 任意の確認事項').includes('| ℹ️ 未確認 | 助言（advisory） | ac | AC one |'), '達成済み AC の advisory は任意の確認事項に残る');
});

test('issue #738 AC5: 結論行・「あなたがやること」が指す「要対応」の ❌ は必須の項目だけで、任意の確認事項には ❌ が無い', () => {
  const body = buildDevflowSummaryBody(MIXED_738);
  assert.ok(
    conclusionLine(body) === '**結論: 自動マージ対象外（HOLD）。修正作業が必要です（助言 1 件は任意）。**',
    `結論行: ${conclusionLine(body)}`,
  );
  assert.ok(body.includes('1. 下記「要対応」の ❌ 項目を修正して push する'), 'あなたがやることは要対応の ❌ を指す');
  assert.ok(!sectionOf(body, '### ℹ️ 任意の確認事項').includes('❌'), '任意の確認事項に ❌ を含まない');
  // 必須が escalate だけ（修正不要）のときは「必須の修正作業はありません（助言 N 件は任意）」のまま
  const bodyEscalate = buildDevflowSummaryBody({
    ...BASE_INPUT,
    advisoryItems: [
      { id: 'A1', text: 'naming nit', severity: 'minor', checked: false, dimension: 'style', escalate: false },
      { id: 'E1', text: 'needs human', severity: 'major', checked: false, dimension: 'design', escalate: true },
    ],
  });
  assert.ok(conclusionLine(bodyEscalate).includes('必須の修正作業はありません（助言 1 件は任意）'), 'escalate のみなら修正不要');
  assert.ok(!sectionOf(bodyEscalate, '### ⚠️ 要対応').includes('助言（advisory）'), 'escalate と並ぶ助言も要対応に入らない');
  assert.ok(sectionOf(bodyEscalate, '### ℹ️ 任意の確認事項').includes('| ℹ️ 未確認 | 助言（advisory） | style | naming nit |'), '助言は任意の確認事項に出る');
});

test('issue #747 AC4: HOLD 理由の表でエージェント AC 未達（取りこぼし）と人手 AC 待ちが別の現状・対応で出る', () => {
  const mt = classifyMergeTier({
    iterateStatus: 'lgtm', shape: 'standard', converged: true, unresolvedDanger: false, breakingStructured: false,
    breakingKeyword: false, docsOrTestOnly: false, escalateCount: 0, evalStaleness: 'none',
    unsatisfiedAgentAc: true, unsatisfiedHumanAc: true,
  });
  const body = buildDevflowSummaryBody({
    ...BASE_INPUT,
    mergeTier: mt.tier,
    mergeTierReasons: mt.reasons,
    holdReasons: mt.holdReasons,
    holdKind: mt.holdKind,
    acResults: [{ ac_index: 0, satisfied: false, evidence: 'コメントのみ', verified_by: 'inspection' }, { ac_index: 1, satisfied: false, evidence: 'staging 未実施', verified_by: 'inspection' }],
  });
  const hold = sectionOf(body, '### HOLD になった理由と現状');
  assert.ok(hold != null, 'HOLD 理由テーブルを含む');
  assert.ok(hold.includes('エージェントで満たせる AC が差し戻し後も未達（ループの取りこぼし） | 修正が必要'), `取りこぼし行: ${hold}`);
  assert.ok(hold.includes('人手作業を要する AC が未達（人手 AC 待ち） | 人手で実施して AC を確認する'), `人手待ち行: ${hold}`);
});

test('baseFailingTests: テスト欄の green に除外件数を添え、参考セクションに「base でも失敗する既存の失敗」としてファイルを列挙する', () => {
  const body = buildDevflowSummaryBody({ ...BASE_INPUT, baseFailingTests: ['p/a.bats', 'p/b.bats'] });
  assert.equal(glanceCells(body)[2], '✅ green（base でも失敗する既存の失敗 2 件を除く）');
  const ref = sectionOf(body, '**参考（可視化のみ — merge tier 判定に不使用）**:');
  assert.ok(ref != null && ref.includes('- base でも失敗する既存の失敗 2 件（diff と無関係のため green 要件から除外）: `p/a.bats`, `p/b.bats`'), `参考セクション: ${ref}`);
});

test('baseFailingTests: 空・未指定ならテスト欄も参考セクションも変わらない', () => {
  for (const baseFailingTests of [undefined, null, []]) {
    const body = buildDevflowSummaryBody({ ...BASE_INPUT, baseFailingTests });
    assert.equal(body, buildDevflowSummaryBody(BASE_INPUT));
    assert.ok(!body.includes('base でも失敗する既存の失敗'));
  }
});

// issue #793: 範囲外にした作業（out_of_scope）と人間側 follow-up（pr-iterate が worktree 外として fix から外した指摘）
test('outOfScope: 非空なら「この PR に含めなかったもの」節に各項目をそのまま出し、空・欠落なら byte 一致', () => {
  const body = buildDevflowSummaryBody({ ...BASE_INPUT, outOfScope: ['telemetry キーの削除（AC 外）', '  ', 'a|b'] });
  assert.ok(body.includes('### この PR に含めなかったもの\n\n- telemetry キーの削除（AC 外）\n- a\\|b'), body);
  for (const outOfScope of [undefined, null, [], ['']]) {
    assert.equal(buildDevflowSummaryBody({ ...BASE_INPUT, outOfScope }), buildDevflowSummaryBody(BASE_INPUT));
  }
});

test('humanFollowups: 非空なら「人間側 follow-up」節に severity・場所・指摘・提案を出し、空・欠落なら byte 一致', () => {
  const body = buildDevflowSummaryBody({ ...BASE_INPUT, humanFollowups: [
    { iter: 1, severity: 'major', topic: 'out', file: '~/dotfiles/settings.json', line: 4, description: '許可が無い', suggestion: '人間が足す' },
  ] });
  assert.ok(body.includes('### 👤 人間側 follow-up（worktree の外を指す指摘 — 自動修正の対象外・1 件）\n\n1. 🟠 major — `~/dotfiles/settings.json:4`\n   - 指摘: 許可が無い\n   - 提案: 人間が足す'), body);
  for (const humanFollowups of [undefined, null, []]) {
    assert.equal(buildDevflowSummaryBody({ ...BASE_INPUT, humanFollowups }), buildDevflowSummaryBody(BASE_INPUT));
  }
});

// ─── issue #794: 同じ AC に紐づく ledger 未収束・ESCALATE・AC 未達を 1 行にまとめる ───

const AC4_FINAL_794 = { id: 'AC-FINAL-4', text: '[final-reconcile 不成立] dotfiles 側に起動形を足す', severity: 'critical', checked: false, dimension: 'ac', source: 'evaluator' };
const AC4_ESC_794 = { id: 'EVAL-1-ac4-dotfiles', text: 'ac4-dotfiles', severity: 'major', checked: false, dimension: 'ac', source: 'evaluator', escalate: true, escalate_reason: 'blast-radius', escalate_description: 'dotfiles 側は worktree の外', ac_index: 3 };
const UNLINKED_B_794 = { id: 'B1', text: 'null deref', severity: 'critical', checked: false, dimension: 'correctness', evidence: 'src/a.ts:10' };
const UNLINKED_E_794 = { id: 'E1', text: 'naming', severity: 'major', checked: false, dimension: 'design', escalate: true, escalate_reason: 'preference' };

function input794({ blockingItems = [AC4_FINAL_794], advisoryItems = [AC4_ESC_794], agent = [3], human = [] } = {}) {
  const mt = classifyMergeTier({
    iterateStatus: 'lgtm', shape: 'standard', converged: false, unresolvedDanger: false, breakingStructured: false,
    breakingKeyword: false, docsOrTestOnly: false, escalateCount: advisoryItems.filter((it) => it.escalate === true).length,
    evalStaleness: 'none', unsatisfiedAgentAc: agent.length > 0, unsatisfiedHumanAc: human.length > 0,
  });
  return {
    ...BASE_INPUT,
    mergeTier: mt.tier, mergeTierReasons: mt.reasons, holdReasons: mt.holdReasons, holdKind: mt.holdKind,
    blockingItems, advisoryItems, ledgerConverged: false,
    acResults: [0, 1, 2, 3].map((i) => ({ ac_index: i, satisfied: i !== 3, evidence: i === 3 ? 'dotfiles 側が未変更' : `ev${i}`, verified_by: 'inspection' })),
    unsatisfiedAcByActor: { agent, human },
  };
}

// 節（見出し / 太字の節名 / <details> まで）の表の本文行
function rows794(body, heading) {
  const sec = sectionOf(body, heading);
  assert.ok(sec != null, `${heading} を含む`);
  const end = sec.indexOf('\n**');
  return (end >= 0 ? sec.slice(0, end) : sec).split('\n')
    .filter((l) => l.startsWith('| ') && !l.startsWith('| 理由 |') && !l.startsWith('| 状態 |'));
}

test('issue #794 AC1: 同じ AC に紐づく ledger 未収束・ESCALATE・AC 未達は HOLD 理由表と要対応表で 1 行にまとまり、reason code が内訳に残る', () => {
  const input = input794();
  assert.deepEqual(input.holdReasons.map((r) => r.code), ['ledger_unconverged', 'escalate', 'ac_agent_unsatisfied']);
  const body = buildDevflowSummaryBody(input);
  assert.deepEqual(rows794(body, '### HOLD になった理由と現状'), [
    '| AC#4 未達 — ledger 未収束・ESCALATE・AC 未達（エージェント） を 1 行にまとめた（内訳: ledger_unconverged / escalate / ac_agent_unsatisfied） | 未 checked blocking 1 件・ESCALATE 1 件中 0 件は fix 後 tree で解消確認済み・AC 判定 satisfied:false | 修正が必要・要判断（blast-radius）（下表 AC#4 未達 行） |',
  ]);
  assert.deepEqual(rows794(body, '### ⚠️ 要対応'), [
    '| ❌ 未解消 | 必須（AC#4 未達 に紐づく 3 件 — 内訳: ledger_unconverged / escalate / ac_agent_unsatisfied） | ac | AC#4 未達: [final-reconcile 不成立] dotfiles 側に起動形を足す / ac4-dotfiles — dotfiles 側は worktree の外 | 未解消 / AC 判定 satisfied:false（inspection）: dotfiles 側が未変更 / ESCALATE: 未判断 | 修正が必要・要判断（blast-radius） |',
  ]);
  assert.ok(!body.includes('| ❌ 未達 | AC#4 |'), '未達 AC 表に AC#4 を重ねて出さない');
  // 結論行は変わらない（修正必須の HOLD のまま）
  assert.ok(conclusionLine(body).includes('修正作業が必要です'), conclusionLine(body));
});

test('issue #794 AC1: 人手 AC 待ちの AC にまとめた行は対応が「人手で実施して AC を確認する」になる', () => {
  const body = buildDevflowSummaryBody(input794({ agent: [], human: [3] }));
  const hold = rows794(body, '### HOLD になった理由と現状');
  assert.equal(hold.length, 1, hold.join('\n'));
  assert.ok(hold[0].includes('（内訳: ledger_unconverged / escalate / ac_human_pending）'), hold[0]);
  assert.ok(hold[0].endsWith('| 人手で実施して AC を確認する・要判断（blast-radius）（下表 AC#4 未達 行） |'), hold[0]);
});

test('issue #794 AC3: AC に紐づかない項目が同じ code に残るときは、その code の従来の行と AC に紐づかない項目の行をそのまま出す', () => {
  const body = buildDevflowSummaryBody(input794({
    blockingItems: [UNLINKED_B_794, AC4_FINAL_794],
    advisoryItems: [UNLINKED_E_794, AC4_ESC_794],
  }));
  assert.deepEqual(rows794(body, '### HOLD になった理由と現状'), [
    '| AC#4 未達 — ledger 未収束・ESCALATE・AC 未達（エージェント） を 1 行にまとめた（内訳: ledger_unconverged / escalate / ac_agent_unsatisfied） | 未 checked blocking 1 件・ESCALATE 1 件中 0 件は fix 後 tree で解消確認済み・AC 判定 satisfied:false | 修正が必要・要判断（blast-radius）（下表 AC#4 未達 行） |',
    '| ledger 未収束（未 checked blocking 残） | 未 checked blocking 2 件 | 修正が必要（下表 ❌ 行） |',
    '| ESCALATE-TO-HUMAN 項目 2 件 | ESCALATE 2 件中 0 件は fix 後 tree で解消確認済み | 要判断 2 件（下表 ⚠️ 行） |',
  ], 'ac_agent_unsatisfied は AC#4 だけなので行を消し、紐づかない項目が残る code は従来の行のまま');
  const required = rows794(body, '### ⚠️ 要対応');
  assert.equal(required.length, 3, required.join('\n'));
  assert.ok(required[0].startsWith('| ❌ 未解消 | 必須（AC#4 未達 に紐づく 3 件'), required[0]);
  assert.equal(required[1], '| ❌ 未解消 | 必須（blocking） | correctness | null deref | src/a.ts:10 | 修正が必要 |');
  assert.equal(required[2], '| ⚠️ 要判断 | 要判断（advisory ESCALATE） | design | naming | 未判断 | 要判断（preference） |');
});

test('issue #794 AC3: AC への紐付けが 1 系統だけ・どこにも紐づかないときは従来の表示と byte 一致', () => {
  // escalate だけが AC#2（達成済み）を指す: まとめる相手が無い
  const onlyEscalate = {
    ...BASE_INPUT,
    mergeTier: 'HOLD',
    holdReasons: [{ code: 'escalate', reason: 'ESCALATE-TO-HUMAN 項目 1 件', kind: 'human_judgment' }],
    holdKind: 'human_judgment',
    advisoryItems: [{ ...UNLINKED_E_794, ac_index: 1 }],
    acResults: [0, 1].map((i) => ({ ac_index: i, satisfied: true, evidence: 'ok', verified_by: 'inspection' })),
  };
  assert.equal(buildDevflowSummaryBody(onlyEscalate), buildDevflowSummaryBody({ ...onlyEscalate, advisoryItems: [UNLINKED_E_794] }));
  // AC に紐づかない blocking / escalate と未達 AC: unsatisfiedAcByActor を渡しても渡さなくても同じ
  const unlinked = input794({ blockingItems: [UNLINKED_B_794], advisoryItems: [UNLINKED_E_794] });
  const body = buildDevflowSummaryBody(unlinked);
  assert.equal(body, buildDevflowSummaryBody({ ...unlinked, unsatisfiedAcByActor: undefined }));
  assert.ok(body.includes('| ❌ 未達 | AC#4 | inspection | dotfiles 側が未変更 |'));
  assert.ok(!body.includes('1 行にまとめた'));
});

// ─── issue #844: 観測型 AC の未達は対応欄を「実行して確かめる」にし、どの AC が観測型かを出す ───

const OBS_ACTION_844 = '実行して AC の主張を確認する（例: merge 後の実 run・計測）';

function input844({ human = [0], observational = [0] } = {}) {
  const mt = classifyMergeTier({
    iterateStatus: 'lgtm', shape: 'standard', converged: true, unresolvedDanger: false, breakingStructured: false,
    breakingKeyword: false, docsOrTestOnly: false, escalateCount: 0, evalStaleness: 'none',
    unsatisfiedAgentAc: false, unsatisfiedHumanAc: human.length > 0,
  });
  return {
    ...BASE_INPUT,
    mergeTier: mt.tier, mergeTierReasons: mt.reasons, holdReasons: mt.holdReasons, holdKind: mt.holdKind,
    acResults: [0, 1, 2].map((i) => (human.includes(i)
      ? { ac_index: i, satisfied: false, verified_by: 'inspection', evidence: observational.includes(i) ? '観測型 AC — test の red→green 実証が無い' : 'staging 未確認', ...(observational.includes(i) ? { observational: true } : {}) }
      : { ac_index: i, satisfied: true, verified_by: 'inspection', evidence: 'ok' })),
    unsatisfiedAcByActor: { agent: [], human },
  };
}

test('issue #844: 観測型 AC だけが未達なら HOLD 理由表の対応欄は実行による確認で、現状と未達表に観測型の AC 番号が出る', () => {
  const body = buildDevflowSummaryBody(input844());
  const hold = rows794(body, '### HOLD になった理由と現状');
  assert.equal(hold.length, 1, hold.join('\n'));
  assert.ok(hold[0].endsWith(`| 観測型 AC（AC#1）は実行しないと確かめられず、test の red→green 実証が無い | ${OBS_ACTION_844}（下表 ❌ 未達 行） |`), hold[0]);
  assert.ok(body.includes('| ❌ 未達 | AC#1（観測型） | inspection | 観測型 AC — test の red→green 実証が無い |'), body);
});

test('issue #844: 観測型と通常の人手 AC が両方未達なら、対応欄に人手の実施と実行による確認を両方出す', () => {
  const body = buildDevflowSummaryBody(input844({ human: [0, 2], observational: [2] }));
  const hold = rows794(body, '### HOLD になった理由と現状');
  assert.ok(hold[0].endsWith(`| 人手作業を要する AC が未達（人手 AC 待ち）・観測型 AC（AC#3）は実行しないと確かめられず、test の red→green 実証が無い | 人手で実施して AC を確認する・${OBS_ACTION_844}（下表 ❌ 未達 行） |`), hold[0]);
  assert.ok(body.includes('| ❌ 未達 | AC#1 | inspection | staging 未確認 |'), body);
  assert.ok(body.includes('| ❌ 未達 | AC#3（観測型） | inspection |'), body);
});

test('issue #844: 観測型でない人手 AC 待ちの表示は変えない', () => {
  const body = buildDevflowSummaryBody(input844({ human: [0], observational: [] }));
  const hold = rows794(body, '### HOLD になった理由と現状');
  assert.ok(hold[0].endsWith('| 人手作業を要する AC が未達（人手 AC 待ち） | 人手で実施して AC を確認する（下表 ❌ 未達 行） |'), hold[0]);
  assert.ok(!body.includes('観測型'), body);
});

test('issue #844: 同じ AC にまとめた行でも、観測型 AC は対応が実行による確認になり、見出しに観測型と出る', () => {
  const input = input794({ agent: [], human: [3] });
  input.acResults = input.acResults.map((a) => (a.ac_index === 3 ? { ...a, observational: true } : a));
  const body = buildDevflowSummaryBody(input);
  const hold = rows794(body, '### HOLD になった理由と現状');
  assert.equal(hold.length, 1, hold.join('\n'));
  assert.ok(hold[0].startsWith('| AC#4 未達（観測型） — '), hold[0]);
  assert.ok(hold[0].endsWith(`| ${OBS_ACTION_844}・要判断（blast-radius）（下表 AC#4 未達（観測型） 行） |`), hold[0]);
});

// ─── issue #829: 終端サマリの定型行・二重掲載・矛盾する注記を formatter で消す ───────────
// 直近の dev-flow 製 PR の終端サマリに出ていた形（REVIEW の fix 適用後 reverified・REVIEW の fix なし・
// AUTO の micro docs・HOLD の security hit + 未解消混在）を formatter の入力として再構成した fixture。
// SEC seed は seedSecurityLedger → reconcileDanger、Merge tier の理由は classifyMergeTier の返り値を
// そのまま渡す（workflow と同じ経路で作るので、既定文や clean の evidence が変わればここで落ちる）。

const CLASSIFY_BASE_829 = {
  iterateStatus: 'lgtm', shape: 'standard', converged: true, unresolvedDanger: false, breakingStructured: false,
  breakingKeyword: false, docsOrTestOnly: false, escalateCount: 0, evalStaleness: 'none',
  unsatisfiedAgentAc: false, unsatisfiedHumanAc: false,
};

function secItems829(hits = []) {
  return reconcileDanger({ items: seedSecurityLedger() }, { ok: true, hits: hits.map((c) => ({ class: c })) }).items;
}

function fixture829({ classify = {}, ...rest }) {
  const mt = classifyMergeTier({ ...CLASSIFY_BASE_829, ...classify });
  return {
    ...BASE_INPUT,
    gatePolicy: 'llm-major-advisory',
    mergeTier: mt.tier,
    mergeTierReasons: mt.reasons,
    holdReasons: mt.holdReasons,
    holdKind: mt.holdKind,
    disclosures: mt.disclosures,
    ...rest,
  };
}

const AC_ALL_OK_829 = [0, 1, 2].map((i) => ({ ac_index: i, satisfied: true, evidence: `test ${i} pass`, verified_by: 'test' }));
const CHECKED_AC_ITEMS_829 = [0, 1, 2].map((i) => ({ id: `AC-${i + 1}`, text: `AC ${i + 1} の本文`, severity: 'major', checked: true, dimension: 'ac', source: 'ac', evidence: `test ${i} pass` }));
const RESOLVED_ADVISORY_829 = { id: 'EVAL-1-cache-key', text: 'cache key に shape が入っていない', severity: 'minor', checked: false, dimension: 'design', escalate: false, final_resolution: 'resolved', final_evidence: 'fix 後 tree で cache key に shape を追加済み（src/cache.mjs:12）' };
const OPEN_ADVISORY_829 = { id: 'EVAL-1-naming', text: '関数名が既存の命名と揃っていない', severity: 'minor', checked: false, dimension: 'style', escalate: false };
const STILL_OPEN_ADVISORY_829 = { id: 'CONCERN-1', text: 'テストが 1 ケースしかない', severity: 'minor', checked: false, dimension: 'test', escalate: false, final_resolution: 'unresolved', final_evidence: 'fix 後 tree でもケースは 1 つ' };
const AUTH_CLEARANCE_829 = '認可は既存 middleware 経由のまま（src/auth.ts:42）';
const BLOCKING_OPEN_829 = { id: 'EVAL-1-null', text: 'null 参照の可能性', severity: 'critical', checked: false, dimension: 'correctness', source: 'evaluator', evidence: 'src/a.ts:10' };
const ESCALATE_OPEN_829 = { id: 'EVAL-1-limit', text: '上限超過時の挙動', severity: 'major', checked: false, dimension: 'design', escalate: true, escalate_reason: 'preference' };

const FIXTURES_829 = {
  // REVIEW: pr-iterate が fix を適用して LGTM・最終 tree で test / AC を再検証済み・助言の一部は fix 後 tree で解消
  reviewFixedReverified: fixture829({
    classify: { evalStaleness: 'iterate_fixed', finalReconcile: 'reverified', finalTestGreen: true, finalAcReconcile: 'reverified' },
    blockingItems: [...secItems829(), ...CHECKED_AC_ITEMS_829],
    advisoryItems: [RESOLVED_ADVISORY_829, OPEN_ADVISORY_829, STILL_OPEN_ADVISORY_829],
    acResults: AC_ALL_OK_829,
    evalStaleness: 'iterate_fixed',
    iterateFixesApplied: 2,
    iterateStatus: 'lgtm',
    finalReconcile: 'reverified',
    finalTestGreen: true,
    finalAcReconcile: 'reverified',
  }),
  // REVIEW: fix なし・助言が 1 件残る
  reviewPlain: fixture829({
    blockingItems: [...secItems829(), ...CHECKED_AC_ITEMS_829],
    advisoryItems: [OPEN_ADVISORY_829],
    acResults: AC_ALL_OK_829,
    iterateStatus: 'lgtm',
  }),
  // AUTO: micro の docs only
  autoMicro: fixture829({
    classify: { shape: 'micro', docsOrTestOnly: true },
    shape: 'micro',
    blockingItems: secItems829(),
    iterateStatus: 'lgtm',
  }),
  // HOLD: auth が hit して evaluator が evidence で clear・blocking 未解消・ESCALATE 未判断・AC 未達・
  // fix 後の Final AC reconcile が判定不能（バナーは fix 前 tree 基準のまま）
  holdMixed: fixture829({
    classify: { converged: false, escalateCount: 1, unsatisfiedAgentAc: true, evalStaleness: 'iterate_fixed', finalReconcile: 'reverified', finalTestGreen: true, finalAcReconcile: 'unavailable' },
    blockingItems: [
      ...secItems829(['auth']).map((it) => (it.danger_class === 'auth' ? { ...it, checked: true, evidence: AUTH_CLEARANCE_829 } : it)),
      ...CHECKED_AC_ITEMS_829.slice(0, 1),
      BLOCKING_OPEN_829,
    ],
    advisoryItems: [ESCALATE_OPEN_829, OPEN_ADVISORY_829, RESOLVED_ADVISORY_829],
    ledgerConverged: false,
    acResults: [
      { ac_index: 0, satisfied: true, evidence: 'test 0 pass', verified_by: 'test' },
      { ac_index: 1, satisfied: false, evidence: '上限超過で例外を握りつぶしている', verified_by: 'test' },
    ],
    unsatisfiedAcByActor: { agent: [1], human: [] },
    dangerHits: ['auth'],
    evalVerdict: 'fail',
    evalStaleness: 'iterate_fixed',
    iterateFixesApplied: 1,
    iterateStatus: 'lgtm',
    finalReconcile: 'reverified',
    finalTestGreen: true,
    finalAcReconcile: 'unavailable',
  }),
};
const NON_HOLD_829 = ['reviewFixedReverified', 'reviewPlain', 'autoMicro'];

// 表の行をセルに分ける（fixture のセルは | を含まない）
function cells829(row) {
  return row.split('|').slice(1, -1).map((c) => c.trim());
}

function countOf(body, s) {
  return body.split(s).length - 1;
}

test('issue #829 fixture: Merge tier は意図した tier になる（formatter の入力が workflow と同じ経路で作れている）', () => {
  assert.equal(FIXTURES_829.reviewFixedReverified.mergeTier, 'REVIEW');
  assert.equal(FIXTURES_829.reviewPlain.mergeTier, 'REVIEW');
  assert.equal(FIXTURES_829.autoMicro.mergeTier, 'AUTO');
  assert.equal(FIXTURES_829.holdMixed.mergeTier, 'HOLD');
  assert.deepEqual(FIXTURES_829.holdMixed.holdReasons.map((r) => r.code), ['ledger_unconverged', 'escalate', 'ac_agent_unsatisfied', 'final_ac_unavailable']);
});

test('issue #829 AC1: danger-grep clean の SEC seed は 7 行ではなく「Security: 7 クラスとも danger-grep clean」の 1 行になる', () => {
  for (const name of NON_HOLD_829) {
    const body = buildDevflowSummaryBody(FIXTURES_829[name]);
    assert.equal(countOf(body, 'Security: 7 クラスとも danger-grep clean'), 1, `${name}: 集約行がちょうど 1 回`);
    assert.equal(countOf(body, 'danger-grep clean'), 1, `${name}: clean の語は集約行の 1 回だけ（クラスごとの行・clearance 不要の定型行は出ない）`);
    assert.ok(!body.split('\n').some((l) => l.startsWith('| security |')), `${name}: 解消済み表に security の行が無い`);
  }
  const reverified = buildDevflowSummaryBody(FIXTURES_829.reviewFixedReverified);
  assert.ok(reverified.includes('✅ Goal Ledger 解消済み 3 件'), 'Goal Ledger の解消済み件数に clean の SEC seed を数えない');
});

test('issue #829 AC1: LLM の evidence で clear した SEC は今どおり 1 行ずつ出し、残りの clean クラスは 1 行にまとめる', () => {
  const body = buildDevflowSummaryBody(FIXTURES_829.holdMixed);
  const authText = seedSecurityLedger().find((it) => it.danger_class === 'auth').text;
  assert.equal(countOf(body, `| security | ${authText} | ${AUTH_CLEARANCE_829} |`), 1, 'LLM で clear した auth は解消済み表に 1 行');
  assert.ok(body.includes('Security: 6 クラス（crypto, config, data-migration, public-api, exec-sink, dependency）は danger-grep clean'), 'clean の 6 クラスは 1 行');
  assert.equal(countOf(body, 'danger-grep clean'), 1, 'clean の語は集約行の 1 回だけ');
  assert.ok(body.includes('✅ セキュリティ確認 (Security clearance) 1/1 済'), 'LLM clearance の件数は今どおり');
});

test('issue #829 AC2: fix 後 tree で解消確認済みの advisory は「要対応」「任意の確認事項」の表に出ず、折りたたみの解消済み表にだけ出る', () => {
  for (const name of ['reviewFixedReverified', 'holdMixed']) {
    const body = buildDevflowSummaryBody(FIXTURES_829[name]);
    assert.equal(countOf(body, RESOLVED_ADVISORY_829.text), 1, `${name}: 解消済みの助言は 1 回だけ出る`);
    const at = body.indexOf(RESOLVED_ADVISORY_829.text);
    assert.ok(at > body.indexOf('**解消済み証跡**:') && at > body.indexOf('<details><summary>'), `${name}: 出る場所は折りたたみの解消済み表`);
    assert.ok(body.includes(`| advisory | ${RESOLVED_ADVISORY_829.text} | fix 後 tree で確認: ${RESOLVED_ADVISORY_829.final_evidence} |`), `${name}: 解消根拠つきの行`);
    for (const heading of ['### ⚠️ 要対応', '### ℹ️ 任意の確認事項']) {
      const sec = sectionOf(body, heading);
      assert.ok(sec == null || !sec.includes(RESOLVED_ADVISORY_829.text), `${name}: ${heading} に出ない`);
    }
  }
  const body = buildDevflowSummaryBody(FIXTURES_829.reviewFixedReverified);
  assert.ok(conclusionLine(body).includes('（助言 2 件は任意）'), '結論行の助言件数は解消済みを数えない');
});

test('issue #829 AC3: finalAcReconcile=reverified のバナーは「AC は最終 tree で再検証済み」と書き、AC を fix 前 tree 基準とは書かない', () => {
  const body = buildDevflowSummaryBody(FIXTURES_829.reviewFixedReverified);
  const banner = body.split('\n').find((l) => l.startsWith('> ℹ️ **pr-iterate が 2 件の fix を適用して LGTM 終端**'));
  assert.ok(banner, 'fix 適用のバナーがある');
  assert.ok(banner.includes('AC は最終 tree で再検証済み。security clearance は fix 前 tree 基準'), banner);
  assert.ok(!body.includes('eval/AC テーブル'), 'eval/AC テーブルを fix 前 tree 基準とは書かない');
  assert.ok(body.includes('AC テーブルは final snapshot'), '参考の final snapshot 注記と並んでも矛盾しない');

  // 最終 tree の AC 再検証が無い run は従来どおり fix 前 tree 基準と書く
  const unverified = buildDevflowSummaryBody(FIXTURES_829.holdMixed);
  assert.ok(unverified.includes('下記の eval/AC テーブル・security clearance は fix 前 tree 基準'), 'reverified でなければ従来の文言');
  assert.ok(!unverified.includes('final snapshot'), 'final snapshot とは書かない');
});

test('issue #829 AC4: 「未解消」は blocking の行にだけ使い、advisory の現状列は「未対応（任意）」になる', () => {
  for (const name of NON_HOLD_829) {
    assert.equal(countOf(buildDevflowSummaryBody(FIXTURES_829[name]), '未解消'), 0, `${name}: REVIEW / AUTO に「未解消」の語が無い`);
  }
  for (const name of ['reviewFixedReverified', 'reviewPlain', 'holdMixed']) {
    const body = buildDevflowSummaryBody(FIXTURES_829[name]);
    const advisoryRows = body.split('\n').filter((l) => l.startsWith('| ') && l.includes('| 助言（advisory） |'));
    assert.ok(advisoryRows.length > 0, `${name}: 助言の行がある`);
    for (const row of advisoryRows) {
      assert.ok(cells829(row)[4].startsWith('未対応（任意）'), `${name}: 助言の現状列: ${row}`);
    }
    for (const line of body.split('\n').filter((l) => l.includes('未解消'))) {
      assert.ok(line.startsWith('| ❌ 未解消 | 必須（blocking） |'), `${name}: 「未解消」は blocking の行だけ: ${line}`);
    }
  }
  const reverified = buildDevflowSummaryBody(FIXTURES_829.reviewFixedReverified);
  assert.ok(reverified.includes(`| 未対応（任意）— fix 後 tree でも残る: ${STILL_OPEN_ADVISORY_829.final_evidence} |`), 'fix 後 tree でも残る助言も未対応（任意）');
  const hold = buildDevflowSummaryBody(FIXTURES_829.holdMixed);
  assert.ok(hold.includes(`| ⚠️ 要判断 | 要判断（advisory ESCALATE） | design | ${ESCALATE_OPEN_829.text} | 未判断 | 要判断（preference） |`), 'ESCALATE は「任意」にせず未判断');
});

test('issue #829 AC5: REVIEW / AUTO で理由が既定文だけなら理由の節を出さず、gate_policy は末尾の HTML コメントに置き、結論行に行動指示を書かない', () => {
  assert.deepEqual(FIXTURES_829.reviewPlain.mergeTierReasons, ['標準 — 人間が LGTM して merge'], 'REVIEW の既定文');
  for (const name of NON_HOLD_829) {
    const input = FIXTURES_829[name];
    const body = buildDevflowSummaryBody(input);
    const lines = body.split('\n');
    assert.ok(!body.includes('**Merge tier 理由**'), `${name}: 理由の節を出さない`);
    for (const r of input.mergeTierReasons) assert.ok(!body.includes(r), `${name}: 既定文「${r}」を出さない`);
    assert.ok(!lines.some((l) => l.startsWith('gate_policy:')), `${name}: 本文に gate_policy 行が無い`);
    assert.deepEqual(lines.slice(-2), ['<!-- gate_policy: llm-major-advisory -->', `<!-- dev-flow:${input.mergeTier} -->`], `${name}: 末尾の HTML コメント`);
    const conclusion = conclusionLine(body);
    assert.ok(!conclusion.includes('してください') && !conclusion.includes('diff') && !conclusion.includes('マージして'), `${name}: 結論行に行動指示が無い: ${conclusion}`);
    assert.ok(body.includes(`\`gh pr ready ${input.pr}\``), `${name}: 行動指示は「あなたがやること」にある`);
  }
  // 既定文以外の理由（AUTO の AC 未検証開示）があれば理由の節は残る
  const mt = classifyMergeTier({ ...CLASSIFY_BASE_829, shape: 'micro', docsOrTestOnly: true, evalSkipped: true });
  const body = buildDevflowSummaryBody({ ...FIXTURES_829.autoMicro, mergeTierReasons: mt.reasons });
  assert.ok(body.includes('**Merge tier 理由**:'), '既定文以外があれば理由の節を出す');
  assert.ok(body.includes('- AC は未検証（micro eval skip）'), '既定文以外の理由を出す');
});

test('issue #829 AC5: HOLD の結論行も行動指示を「あなたがやること」と重ねない', () => {
  const body = buildDevflowSummaryBody(FIXTURES_829.holdMixed);
  assert.equal(conclusionLine(body), '**結論: 自動マージ対象外（HOLD）。修正作業が必要です（助言 1 件は任意）。**');
  assert.ok(body.includes('1. 下記「要対応」の ❌ 項目を修正して push する'), '行動指示は「あなたがやること」にだけある');
  assert.ok(body.split('\n').slice(-2)[0] === '<!-- gate_policy: llm-major-advisory -->', 'HOLD でも gate_policy は HTML コメント');
});

test('issue #829 AC6: HOLD の理由・blocking・ESCALATE・未達 AC は 1 件も消えない', () => {
  const input = FIXTURES_829.holdMixed;
  const body = buildDevflowSummaryBody(input);
  const holdRows = sectionOf(body, '### HOLD になった理由と現状').split('\n')
    .filter((l) => l.startsWith('| ') && !l.startsWith('| 理由 |') && !l.startsWith('|---'));
  assert.equal(holdRows.length, input.holdReasons.length, 'HOLD 理由の行数は holdReasons と同じ');
  for (const hr of input.holdReasons) assert.ok(body.includes(`| ${mdCell(hr.reason)} |`), `HOLD 理由が残る: ${hr.code}`);
  assert.ok(body.includes(`| ❌ 未解消 | 必須（blocking） | correctness | ${BLOCKING_OPEN_829.text} | ${BLOCKING_OPEN_829.evidence} | 修正が必要 |`), 'blocking の行が残る');
  assert.ok(body.includes(`| ${ESCALATE_OPEN_829.text} |`), 'ESCALATE の行が残る');
  assert.ok(body.includes('| ❌ 未達 | AC#2 | test | 上限超過で例外を握りつぶしている |'), '未達 AC の行が残る');
  // auth は evaluator が clear 済みなので、検出クラス行には cleared と分かる形で残り、マージ後確認は出ない（issue #858）
  assert.ok(body.includes('検出クラス: auth（cleared）'), 'danger の検出クラスが残る');
  assert.ok(!body.includes('マージ後: 認証・認可経路の変更を含む'), 'cleared の danger class 由来のマージ後確認は出ない');

  // holdReasons が無い HOLD のフォールバックでも mergeTierReasons は全件残る
  const fallback = buildDevflowSummaryBody({ ...input, holdReasons: null });
  for (const r of input.mergeTierReasons) assert.ok(fallback.includes(`- ${r}`), `フォールバックの理由が残る: ${r}`);
});

test('issue #829: summary の既定理由文は classifyMergeTier の REVIEW / AUTO の既定文と一致する（重複定義の同値性 pin）', () => {
  const review = classifyMergeTier({ ...CLASSIFY_BASE_829 });
  const auto = classifyMergeTier({ ...CLASSIFY_BASE_829, shape: 'micro', docsOrTestOnly: true });
  for (const mt of [review, auto]) {
    assert.equal(mt.reasons.length, 1, `${mt.tier}: 既定文だけ`);
    const body = buildDevflowSummaryBody({ ...BASE_INPUT, mergeTier: mt.tier, mergeTierReasons: mt.reasons });
    assert.ok(!body.includes(mt.reasons[0]), `${mt.tier}: 既定文「${mt.reasons[0]}」を既定として扱う`);
  }
});
