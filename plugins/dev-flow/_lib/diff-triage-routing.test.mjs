// Issue #550 (S2): Diff triage 統合 exec-proxy (danger-grep / realized-diff /
// structural-classify / diff-hash-triage の 4→1 統合) の routing / 挙動 pin。
//
// (A) 挙動 pin（issue #636: dev-flow.js の raw ソース regex 走査から、共有 vm-sandbox.mjs
//     （agent() mock）による VM 挙動検証へ移行）:
//   A1. label 'danger-grep'（Diff triage）は VM 内で agentType:'dev-flow:dev-runner-haiku-ro'
//       として観測され、opts.schema（clone）は required:['risk']
//   A2. 既定 run の calls に label 'realized-diff' / 'structural-classify' / 'diff-hash-triage'
//       が 0 件（4→1 の統合を run 全体の呼び出し集合で実測）
//   A3. 既定 run の全 calls の prompt に '--out' 文字列が含まれない（証跡書き込み撤去。AC1）
//   A4. label 'merge-tier-facts'（Merge tier）は agentType:'dev-flow:dev-runner-haiku-ro'
//   A5. 統合呼び出しは try/catch で包まれ need() では包まれない —
//       契約違反ではない単なる throw（'without calling StructuredOutput' を含まないメッセージ）で
//       run が abort せず継続することを VM で確認する（retry 対象外の throw 経路）
//   A6. 統合呼び出しの prompt が diff-triage を参照する（argv token）
//
// (B) 挙動 pin（AC3/AC4/軸A。_lib canonical を直接 import して検証。不変）:
//   (a) unified=null（agent drop 相当）→ parseDiffTriageFields → risk.ok===false →
//       seedSecurityLedger 済み ledger に reconcileDanger を適用すると SEC seed 全件
//       unchecked（fail-closed）で、classifyMergeTier 相当の判定が HOLD になる
//   (b) throw 経路の fail-closed HOLD は diff-triage-schema-contract-routing AC4 が VM で pin する
//   (c) risk 正常 + files 欠落 → dangerHits は正常算出されつつ realizedCount 相当が NaN →
//       classifyShape が complex（安全弁）
//   (d) risk 欠落 + files 正常 → SEC fail-closed だが files は正常配列のまま（独立性）
//   (e) 全フィールド正常 + hits 空 → SEC seed が 'danger-grep clean' で自動 check され
//       blocking 未 checked 0 件（現行 blocking 判定と一致 — 軸A 非抵触 pin）
//   (f) testsurf: risk.ok:false 時に reconcileTestsurf が既存 TESTSURF item 据え置き・
//       新規 seed なしの現行ポリシーのままであること
//
// Run: npx vitest run _lib/diff-triage-routing.test.mjs
// Full CI: bash tests/run-node-tests.sh --strict

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseDiffTriageFields } from './diff-triage.mjs';
import { reconcileDanger, seedSecurityLedger, classifyMergeTier } from './merge-tier.mjs';
import { policyBlockingItems, DEFAULT_GATE_POLICY } from './gate-policy.mjs';
import { makeLedger, appendItem } from './goal-ledger.mjs';
import { secHitsOf, reconcileTestsurf } from './testsurf.mjs';
import { classifyShape } from './triviality.mjs';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash, mergeTierFacts } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude', 'workflows', 'dev-flow.js');
const devFlowSrc = readFileSync(devFlowPath, 'utf8');

async function defaultRun() {
  const { ctx, calls, logs } = makeDevFlowSandbox({});
  const { result, error } = await runWorkflowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'diff-triage-routing-default-run');
  return { result, error, calls, logs };
}

// ============================================================
// (A) VM 挙動 pin
// ============================================================

test("[diff-triage-routing][A1] label 'danger-grep'（Diff triage）は agentType:'dev-flow:dev-runner-haiku-ro' かつ opts.schema.required===['risk']", async () => {
  const { calls } = await defaultRun();
  const call = calls.find((c) => c.label === 'danger-grep');
  assert.ok(call, "label 'danger-grep' の agent() call が見つからない");
  assert.equal(call.agentType, 'dev-flow:dev-runner-haiku-ro');
  const schema = JSON.parse(JSON.stringify(call.opts.schema));
  assert.deepEqual(schema.required, ['risk']);
});

test("[diff-triage-routing][A2] 既定 run に label 'realized-diff' / 'structural-classify' / 'diff-hash-triage' が存在しない（4→1 統合。AC2）", async () => {
  const { calls } = await defaultRun();
  for (const label of ['realized-diff', 'structural-classify', 'diff-hash-triage']) {
    const count = calls.filter((c) => c.label === label).length;
    assert.equal(count, 0, `label '${label}' は統合により消滅しているはずだが ${count} 件見つかった`);
  }
});

test("[diff-triage-routing][A3] 既定 run の全 calls の prompt に '--out' 文字列が含まれない（AC1: 証跡書き込み撤去）", async () => {
  const { calls } = await defaultRun();
  for (const call of calls) {
    assert.ok(!call.prompt.includes('--out'), `label '${call.label}' の prompt に '--out' が残っている`);
  }
});

test("[diff-triage-routing][A4] label 'merge-tier-facts'（Merge tier）は agentType:'dev-flow:dev-runner-haiku-ro'（AC1: agentType 復帰）", async () => {
  // Merge tier の danger-grep 再判定は merge-tier-facts の risk サブ結果で行う。reuse（secDiffHash===mergeDiffHash）
  // が発火しても spawn 自体は 1 回発生する（pr / checks 等の他サブ結果に必要）。
  const { ctx, calls } = makeDevFlowSandbox({
    overrides: { 'merge-tier-facts': () => mergeTierFacts({ hash: 'BBB' }) },
  });
  const { error } = await runWorkflowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'A4-merge-tier-facts');
  const call = calls.find((c) => c.label === 'merge-tier-facts');
  assert.ok(call, "label 'merge-tier-facts' の agent() call が見つからない");
  assert.equal(call.agentType, 'dev-flow:dev-runner-haiku-ro');
});

test('[diff-triage-routing][A5] 統合呼び出しは try/catch で包まれ need() では包まれない（契約違反ではない throw でも run は abort しない）', async () => {
  const overrides = {
    'danger-grep': () => { throw new Error('boom'); },
  };
  const { ctx, calls } = makeDevFlowSandbox({ overrides });
  const { result, error } = await runWorkflowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'A5-plain-throw');
  assert.equal(error, null, 'need() で包まれていたら run は throw で abort するはずだが、継続している');
  const dgCalls = calls.filter((c) => c.label === 'danger-grep');
  assert.equal(dgCalls.length, 1, '契約違反メッセージでないため retry されない');
  assert.ok(result, 'run は最後まで完走し結果を返す');
});

test('[diff-triage-routing][A6] 統合呼び出しの prompt が diff-triage を argv token として参照する', async () => {
  const { calls } = await defaultRun();
  const call = calls.find((c) => c.label === 'danger-grep');
  assert.ok(
    call.prompt.includes('diff-triage /tmp/wt origin/main'),
    'execDiffTriagePhase の統合呼び出し prompt が diff-triage の argv token を含んでいない',
  );
});

// ============================================================
// (B) 挙動 pin — 純関数レベルで per-field 独立性と fail-closed → HOLD を検証
// ============================================================

// (a)/(b) 共通ヘルパー: SEC seed ledger を作り reconcileDanger を適用して blocking 未 checked /
// classifyMergeTier の tier を返す
function reconcileAndClassify(risk) {
  let ledger = makeLedger();
  for (const seed of seedSecurityLedger()) ledger = appendItem(ledger, seed).ledger;
  ledger = reconcileDanger(ledger, risk);
  const secItems = ledger.items.filter((it) => it.source === 'seed' && it.dimension === 'security');
  const blocking = policyBlockingItems(ledger, DEFAULT_GATE_POLICY);
  const converged = blocking.every((it) => it.checked);
  const { tier } = classifyMergeTier({ converged, shape: 'micro', docsOrTestOnly: false });
  return { secItems, converged, tier };
}

test('[diff-triage-routing][B-a] unified=null（agent drop）→ risk fail-closed → SEC seed 全 unchecked + HOLD', () => {
  const { risk } = parseDiffTriageFields(null);
  assert.equal(risk.ok, false);

  const { secItems, converged, tier } = reconcileAndClassify(risk);
  assert.ok(secItems.length > 0, 'SEC seed が 1 件も存在しない（seedSecurityLedger の配線が壊れている）');
  for (const it of secItems) {
    assert.notEqual(it.checked, true, `SEC item ${it.id} は unchecked のはずだが checked=${it.checked}`);
    assert.equal(it.fail_closed, true, `SEC item ${it.id} は fail_closed:true のはずだが ${it.fail_closed}`);
  }
  assert.equal(converged, false, 'fail-closed 時は blocking item が全 checked にならず converged=false のはず');
  assert.equal(tier, 'HOLD', `fail-closed 時は classifyMergeTier が HOLD を返すべきだが '${tier}'`);
});

test('[diff-triage-routing][B-c] risk 正常 + files 欠落 → dangerHits は正常算出されつつ realizedCount 相当は NaN → classifyShape が complex', () => {
  const unified = {
    risk: { ok: true, hits: [{ file: 'src/auth.ts', class: 'auth', severity: 'critical' }] },
    files: 'not-an-array',
    struct: null,
    diffhash: null,
  };
  const { risk, files } = parseDiffTriageFields(unified);
  assert.equal(risk.ok, true);
  const dangerHits = [...new Set(secHitsOf(risk).map((h) => h.class))];
  assert.deepEqual(dangerHits, ['auth'], 'risk 正常時は SEC hit クラスが正しく算出されるべき');

  assert.equal(files, null, 'files 型不正は null（fail-safe）に落ちるべき');
  // dev-flow.js execDiffTriagePhase と同型のパターン: realized?.files ? .length : NaN
  const realized = files == null ? null : { files };
  const realizedCount = realized?.files ? realized.files.length : NaN;
  assert.ok(Number.isNaN(realizedCount), 'files 欠落時の realizedCount は NaN であるべき（?? [] で 0 に潰さない）');

  const triage = classifyShape({ acceptance_criteria: ['a'], issue_type: 'fix' }, realizedCount);
  assert.equal(triage.shape, 'complex', `files 欠落（NaN）は complex 安全弁へ倒れるべきだが '${triage.shape}'`);
  assert.match(triage.reason, /safe floor=complex/);
});

test('[diff-triage-routing][B-d] risk 欠落 + files 正常 → SEC fail-closed だが files は正常配列のまま（独立性）', () => {
  const unified = { files: ['src/foo.ts', 'src/bar.ts'], struct: null, diffhash: null };
  const { risk, files } = parseDiffTriageFields(unified);
  assert.equal(risk.ok, false, 'risk 欠落時は fail-closed であるべき');
  assert.deepEqual(files, ['src/foo.ts', 'src/bar.ts'], 'risk の欠落が files フィールドへ波及してはならない');
});

test("[diff-triage-routing][B-e] 全フィールド正常 + hits 空 → SEC seed は 'danger-grep clean' で自動 check、blocking 未 checked 0 件（軸A 非抵触）", () => {
  const unified = {
    risk: { ok: true, hits: [] },
    files: [],
    struct: { ok: true, available: true, structural: [], format_only: [] },
    diffhash: { hash: 'H', empty: false },
  };
  const { risk } = parseDiffTriageFields(unified);
  let ledger = makeLedger();
  for (const seed of seedSecurityLedger()) ledger = appendItem(ledger, seed).ledger;
  ledger = reconcileDanger(ledger, risk);
  const secItems = ledger.items.filter((it) => it.source === 'seed' && it.dimension === 'security');
  for (const it of secItems) {
    assert.equal(it.checked, true, `hit 無しの clean 時は自動 check されるべきだが SEC item ${it.id} が unchecked`);
    assert.equal(it.evidence, 'danger-grep clean');
  }
  const blocking = policyBlockingItems(ledger, DEFAULT_GATE_POLICY);
  assert.equal(
    blocking.filter((it) => !it.checked).length,
    0,
    'danger-grep clean 時は blocking 未 checked が 0 件であるべき（現行 blocking 判定と一致）',
  );
});

test('[diff-triage-routing][B-f] risk.ok:false 時、reconcileTestsurf は既存 TESTSURF item を据え置き・新規 seed なし', () => {
  const { risk } = parseDiffTriageFields(null);
  assert.equal(risk.ok, false);

  let ledger = makeLedger();
  ledger = appendItem(ledger, {
    id: 'TESTSURF-SKIP', text: 't', dimension: 'test-integrity', severity: 'critical',
    source: 'seed', check: { kind: 'deterministic' }, checked: false,
  }).ledger;
  const before = ledger;
  const after = reconcileTestsurf(ledger, risk);
  assert.deepEqual(after, before, 'risk.ok!==true 時、reconcileTestsurf は ledger を一切 touch しないはず（既存据え置き）');
  assert.equal(after.items.length, before.items.length, '新規 TESTSURF seed が発生してはならない');
});

// isWellFormedRiskField（fail-closed の 2 原因を区別する述語）と parseDiffTriageFields の risk 採用 / 合成の
// 純関数検証は diff-triage.test.mjs が表駆動で持つ。
