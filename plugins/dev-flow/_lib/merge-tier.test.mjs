import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  DANGER_CLASSES,
  seedSecurityLedger,
  reconcileDanger,
  isDocsOrTestOnly,
  classifyMergeTier,
  newlyUncheckedSecClasses,
  classifyMergeableState,
  HOLD_REASON_KINDS,
  HOLD_REASON_CODES,
  aggregateHoldKind,
  EVAL_STALENESS_VALUES,
  classifyCiChecks,
} from './merge-tier.mjs';
import { PR_CLOSES_STATUS_VALUES } from './pr-artifacts.mjs';
import { parseMergeTierFacts } from './merge-tier-facts.mjs';

// ---- Task 1: DANGER_CLASSES + seedSecurityLedger ----

test('DANGER_CLASSES は diff-risk-classify.sh の 7 クラスと一致', () => {
  assert.deepEqual(DANGER_CLASSES, [
    'auth', 'crypto', 'config', 'data-migration', 'public-api', 'exec-sink', 'dependency',
  ]);
});

test('seedSecurityLedger は 7 クラスを blocking seed item として返す', () => {
  const seeds = seedSecurityLedger();
  assert.equal(seeds.length, 7);
  for (const s of seeds) {
    assert.equal(s.source, 'seed');
    assert.equal(s.dimension, 'security');
    assert.equal(s.severity, 'major');           // source:'seed' で blocking。hit 時に critical へ raise
    assert.deepEqual(s.check, { kind: 'deterministic' });
    assert.ok(s.id.startsWith('SEC-'));
    assert.ok(s.text.length > 0);
  }
  assert.equal(seeds[0].id, 'SEC-AUTH');
  assert.equal(seeds[3].id, 'SEC-DATA-MIGRATION');
});

// ---- Task 2: reconcileDanger ----

function ledgerWithSeeds() {
  return {
    items: seedSecurityLedger().map((it) => ({ checked: false, evidence: null, floor: false, ...it })),
    round: 0,
  };
}

test('reconcileDanger: clean クラスは checked=true(evidence=grep clean)', () => {
  const out = reconcileDanger(ledgerWithSeeds(), { ok: true, hits: [] });
  for (const it of out.items) {
    assert.equal(it.checked, true);
    assert.match(it.evidence, /clean/);
    assert.equal(it.severity, 'major');
  }
});

test('reconcileDanger: hit クラスは critical へ raise + checked=false 据え置き', () => {
  const out = reconcileDanger(ledgerWithSeeds(), {
    ok: true,
    hits: [{ class: 'auth' }, { class: 'crypto' }],
  });
  const auth = out.items.find((it) => it.id === 'SEC-AUTH');
  assert.equal(auth.severity, 'critical');
  assert.equal(auth.floor, true);
  assert.equal(auth.checked, false);
  const cfg = out.items.find((it) => it.id === 'SEC-CONFIG');
  assert.equal(cfg.severity, 'major');
  assert.equal(cfg.checked, true);
});

test('reconcileDanger: 未知 hit クラスは無視(対応 seed なし)', () => {
  const out = reconcileDanger(ledgerWithSeeds(), { ok: true, hits: [{ class: 'bogus' }] });
  assert.ok(out.items.every((it) => it.checked === true));
});

test('reconcileDanger: checked=true(evaluator clearance 済み)の hit item を 2 度目に reconcile しても checked が保持される(HOLD 巻き戻し防止)', () => {
  // Step 1: 初回 reconcile — auth hit → critical/unchecked
  const step1 = reconcileDanger(ledgerWithSeeds(), { ok: true, hits: [{ class: 'auth' }] });
  const authAfterStep1 = step1.items.find((it) => it.id === 'SEC-AUTH');
  assert.equal(authAfterStep1.checked, false);
  assert.equal(authAfterStep1.severity, 'critical');

  // Step 2: evaluator が clearance → checked=true に
  const ledgerCleared = {
    ...step1,
    items: step1.items.map((it) =>
      it.id === 'SEC-AUTH' ? { ...it, checked: true, evidence: 'security cleared: no auth bypass' } : it,
    ),
  };
  const authCleared = ledgerCleared.items.find((it) => it.id === 'SEC-AUTH');
  assert.equal(authCleared.checked, true);

  // Step 3: 2 度目 reconcile(Merge tier phase) — auth は依然 hit だが checked を維持すべき
  const step3 = reconcileDanger(ledgerCleared, { ok: true, hits: [{ class: 'auth' }] });
  const authAfterStep3 = step3.items.find((it) => it.id === 'SEC-AUTH');
  assert.equal(authAfterStep3.checked, true, 'checked=true(clearance 済み)は 2 度目 reconcile で維持される');
  assert.equal(authAfterStep3.severity, 'critical', 'severity は引き続き critical のまま');

  // 非 hit クラスは依然 clean
  const cfgAfterStep3 = step3.items.find((it) => it.id === 'SEC-CONFIG');
  assert.equal(cfgAfterStep3.checked, true);
});

test('reconcileDanger: pr-iterate で新クラスが hit に増えた場合は unchecked(HOLD)', () => {
  // auth を先に clearance 済みにした ledger から出発
  const step1 = reconcileDanger(ledgerWithSeeds(), { ok: true, hits: [{ class: 'auth' }] });
  const ledgerCleared = {
    ...step1,
    items: step1.items.map((it) =>
      it.id === 'SEC-AUTH' ? { ...it, checked: true, evidence: 'security cleared: ok' } : it,
    ),
  };

  // pr-iterate 後に crypto も新たに hit
  const step2 = reconcileDanger(ledgerCleared, {
    ok: true,
    hits: [{ class: 'auth' }, { class: 'crypto' }],
  });
  const authAfter = step2.items.find((it) => it.id === 'SEC-AUTH');
  const cryptoAfter = step2.items.find((it) => it.id === 'SEC-CRYPTO');
  assert.equal(authAfter.checked, true, 'auth: clearance 済みは維持');
  assert.equal(cryptoAfter.checked, false, 'crypto: 新 hit は unchecked(HOLD を保つ)');
  assert.equal(cryptoAfter.severity, 'critical');
});

test('reconcileDanger: danger-grep error は全 SEC seed を unchecked のまま返す(fail-closed)', () => {
  const cleaned = reconcileDanger(ledgerWithSeeds(), { ok: true, hits: [] });
  assert.ok(cleaned.items.every((it) => it.checked === true), 'precondition: clean risk checks all SEC seeds');

  const out = reconcileDanger(cleaned, { ok: false, hits: [], error: 'script failed' });
  for (const it of out.items) {
    assert.equal(it.checked, false, `${it.id} should fail closed`);
    assert.match(it.evidence, /script failed/);
  }

  const mergeTier = classifyMergeTier({ iterateStatus: 'lgtm',
    shape: 'micro',
    converged: false,
    unresolvedDanger: false,
    breakingStructured: false, breakingKeyword: false,
    docsOrTestOnly: true,
    escalateCount: 0,
  });
  assert.equal(mergeTier.tier, 'HOLD');
});

// AC #3: ツール欠落(fail-closed) と danger 実検出の evidence 語彙が区別できること
test('reconcileDanger: risk.ok:false (tool 欠落/fail-closed) のとき evidence が tool-unavailable を示す語彙を含む', () => {
  // error あり: evidence に "unavailable" または "fail-closed" の語彙が含まれ、
  // "danger" 実検出と誤認できない形になること
  const outWithError = reconcileDanger(ledgerWithSeeds(), { ok: false, error: 'No such file or directory' });
  for (const it of outWithError.items) {
    assert.equal(it.checked, false, `${it.id} should be unchecked (fail-closed)`);
    // tool 欠落/fail-closed の文言を含む（"danger" 検出ではなく "unavailable" / "fail-closed" 語彙）
    assert.match(it.evidence, /unavailable|fail-closed/i,
      `fail-closed evidence should indicate tool unavailability, got: ${it.evidence}`);
    // danger 実検出の evidence 語彙 ("danger-grep clean", critical/floor raise) と
    // 混同できないよう、evidence が "danger-grep clean" や "danger detected" ではないことを確認
    assert.doesNotMatch(it.evidence, /^danger-grep clean$/,
      'fail-closed evidence must not say "danger-grep clean"');
  }
});

test('reconcileDanger: risk.ok:false かつ error なし (空/null) のとき evidence が tool-unavailable を示す', () => {
  // error フィールドなし
  const outNoError = reconcileDanger(ledgerWithSeeds(), { ok: false });
  for (const it of outNoError.items) {
    assert.equal(it.checked, false, `${it.id} should be unchecked (fail-closed)`);
    assert.match(it.evidence, /unavailable|fail-closed/i,
      `no-error fail-closed evidence should indicate tool unavailability, got: ${it.evidence}`);
  }
});

test('reconcileDanger: risk.ok:false と risk.ok:true(hit) の evidence 語彙が区別可能', () => {
  // fail-closed (tool 欠落)
  const failClosed = reconcileDanger(ledgerWithSeeds(), { ok: false, error: 'diff-risk-classify.sh not found' });
  const failEvidence = failClosed.items.find((it) => it.id === 'SEC-AUTH')?.evidence ?? '';
  assert.match(failEvidence, /unavailable|fail-closed/i, `fail-closed evidence: ${failEvidence}`);

  // danger 実検出 (risk.ok:true + hit)
  const hitResult = reconcileDanger(ledgerWithSeeds(), { ok: true, hits: [{ class: 'auth' }] });
  const authHit = hitResult.items.find((it) => it.id === 'SEC-AUTH');
  assert.equal(authHit.severity, 'critical', 'danger hit raises to critical');
  assert.equal(authHit.floor, true, 'danger hit sets floor=true');
  assert.equal(authHit.checked, false, 'danger hit is unchecked');
  // hit item の evidence はない（unchecked のまま）か、あっても "unavailable" ではない
  if (authHit.evidence !== null && authHit.evidence !== undefined) {
    assert.doesNotMatch(String(authHit.evidence), /unavailable|fail-closed/i,
      `danger hit evidence must not say "unavailable": ${authHit.evidence}`);
  }

  // clean item は "danger-grep clean" のまま
  const cleanItem = hitResult.items.find((it) => it.id === 'SEC-CONFIG');
  assert.match(cleanItem.evidence, /clean/, `clean evidence: ${cleanItem.evidence}`);
  assert.doesNotMatch(cleanItem.evidence, /unavailable|fail-closed/i,
    `clean evidence must not say "unavailable": ${cleanItem.evidence}`);
});

// ---- Task 3: isDocsOrTestOnly + classifyMergeTier ----

test('isDocsOrTestOnly: md/test/bats のみ → true', () => {
  assert.equal(isDocsOrTestOnly(['docs/a.md', 'README.md']), true);
  assert.equal(isDocsOrTestOnly(['_lib/foo.test.mjs', 'x/foo.bats']), true);
  for (const f of ['models/foo_spec.rb', 'models/foo_test.rb', 'Unit/FooTest.php']) {
    assert.equal(isDocsOrTestOnly([f]), true, f);
  }
  assert.equal(isDocsOrTestOnly(['src/foo.ts']), false);
  assert.equal(isDocsOrTestOnly(['app/foo.rb', 'app/Latest.php']), false);
  assert.equal(isDocsOrTestOnly([]), false);
});

test('classifyMergeTier: 未収束 → HOLD', () => {
  const r = classifyMergeTier({ iterateStatus: 'lgtm', shape: 'standard', converged: false, unresolvedDanger: false, breakingStructured: false, breakingKeyword: false, docsOrTestOnly: false, escalateCount: 0 });
  assert.equal(r.tier, 'HOLD');
  assert.ok(r.reasons.some((x) => /収束/.test(x)));
});

test('classifyMergeTier: 未解消 danger → HOLD', () => {
  const r = classifyMergeTier({ iterateStatus: 'lgtm', shape: 'micro', converged: true, unresolvedDanger: true, breakingStructured: false, breakingKeyword: false, docsOrTestOnly: true, escalateCount: 0 });
  assert.equal(r.tier, 'HOLD');
});

// breaking 検出は「analyze 構造化判定」と「issue title/body keyword scan」の 2 入力を
// 持つ（issue #278）。HOLD reason で由来を区別表示できることを origin ごとに担保する。

test('classifyMergeTier: breakingStructured のみ true → HOLD、reasons に構造化判定文言を含み keyword scan 文言を含まない', () => {
  const r = classifyMergeTier({ iterateStatus: 'lgtm', shape: 'complex', converged: true, unresolvedDanger: false, breakingStructured: true, breakingKeyword: false, docsOrTestOnly: false, escalateCount: 0 });
  assert.equal(r.tier, 'HOLD');
  assert.ok(r.reasons.some((x) => x.includes('構造化判定')), `reasons に構造化判定文言を含むべきだが: ${JSON.stringify(r.reasons)}`);
  assert.ok(!r.reasons.some((x) => x.includes('keyword scan')), `reasons に keyword scan 文言を含むべきでないが: ${JSON.stringify(r.reasons)}`);
});

test('classifyMergeTier: breakingKeyword のみ true(breakingStructured false) → REVIEW（keyword-alone は HOLD 不採用、可視化のみ。issue #364）', () => {
  const r = classifyMergeTier({ iterateStatus: 'lgtm', shape: 'standard', converged: true, unresolvedDanger: false, breakingStructured: false, breakingKeyword: true, docsOrTestOnly: false, escalateCount: 0 });
  assert.equal(r.tier, 'REVIEW');
  assert.ok(!r.reasons.some((x) => x.includes('breaking/migration 検出')), `reasons に breaking/migration 検出(HOLD)文言を含むべきでないが: ${JSON.stringify(r.reasons)}`);
  assert.ok(r.reasons.some((x) => x.includes('不採用') && x.includes('keyword')), `reasons に keyword-alone 可視化文言(不採用+keyword)を含むべきだが: ${JSON.stringify(r.reasons)}`);
});

test('classifyMergeTier: breakingStructured と breakingKeyword が両方 true → HOLD、reasons に構造化判定と keyword scan hit の両文言を含む単一要素が存在する', () => {
  const r = classifyMergeTier({ iterateStatus: 'lgtm', shape: 'complex', converged: true, unresolvedDanger: false, breakingStructured: true, breakingKeyword: true, docsOrTestOnly: false, escalateCount: 0 });
  assert.equal(r.tier, 'HOLD');
  const combinedReason = r.reasons.find((x) => x.includes('構造化判定') && x.includes('keyword scan hit'));
  assert.ok(combinedReason, `reasons に構造化判定+keyword scan hit を併記する単一要素を含むべきだが: ${JSON.stringify(r.reasons)}`);
});

test('classifyMergeTier: AC-1(issue #361 相当) micro + docs-only + keyword-alone(breakingStructured false) → AUTO、breaking 検出(HOLD)文言なし', () => {
  const r = classifyMergeTier({ iterateStatus: 'lgtm', shape: 'micro', docsOrTestOnly: true, converged: true, unresolvedDanger: false, breakingStructured: false, breakingKeyword: true, escalateCount: 0 });
  assert.equal(r.tier, 'AUTO');
  assert.ok(!r.reasons.some((x) => x.includes('breaking/migration 検出')), `reasons に breaking/migration 検出(HOLD)文言を含むべきでないが: ${JSON.stringify(r.reasons)}`);
});

test('classifyMergeTier: breakingStructured / breakingKeyword が両方 false → HOLD にならない（regression）', () => {
  const r = classifyMergeTier({ iterateStatus: 'lgtm', shape: 'standard', converged: true, unresolvedDanger: false, breakingStructured: false, breakingKeyword: false, docsOrTestOnly: false, escalateCount: 0 });
  assert.equal(r.tier, 'REVIEW');
  assert.ok(!r.reasons.some((x) => /breaking|構造化判定|keyword scan/.test(x)), `breaking 関連 reason が無いはずだが: ${JSON.stringify(r.reasons)}`);
});

test('classifyMergeTier: ESCALATE 項目あり → HOLD', () => {
  const r = classifyMergeTier({ iterateStatus: 'lgtm', shape: 'standard', converged: true, unresolvedDanger: false, breakingStructured: false, breakingKeyword: false, docsOrTestOnly: false, escalateCount: 2 });
  assert.equal(r.tier, 'HOLD');
});

test('classifyMergeTier: micro + docs/test-only + clean + 収束 → AUTO', () => {
  const r = classifyMergeTier({ iterateStatus: 'lgtm', shape: 'micro', converged: true, unresolvedDanger: false, breakingStructured: false, breakingKeyword: false, docsOrTestOnly: true, escalateCount: 0 });
  assert.equal(r.tier, 'AUTO');
});

test('classifyMergeTier: 収束済だが micro でない/コード変更 → REVIEW', () => {
  const r = classifyMergeTier({ iterateStatus: 'lgtm', shape: 'standard', converged: true, unresolvedDanger: false, breakingStructured: false, breakingKeyword: false, docsOrTestOnly: false, escalateCount: 0 });
  assert.equal(r.tier, 'REVIEW');
});

test('classifyMergeTier: micro だが docs/test-only でない → REVIEW', () => {
  const r = classifyMergeTier({ iterateStatus: 'lgtm', shape: 'micro', converged: true, unresolvedDanger: false, breakingStructured: false, breakingKeyword: false, docsOrTestOnly: false, escalateCount: 0 });
  assert.equal(r.tier, 'REVIEW');
});


test('classifyMergeTier: AC 未達(unsatisfiedAgentAc:true) → HOLD', () => {
  const r = classifyMergeTier({ iterateStatus: 'lgtm', shape: 'standard', converged: true, unresolvedDanger: false, breakingStructured: false, breakingKeyword: false, docsOrTestOnly: false, escalateCount: 0, unsatisfiedAgentAc: true });
  assert.equal(r.tier, 'HOLD');
  assert.ok(r.reasons.some((x) => /AC 未達/.test(x)));
});

test('classifyMergeTier: unsatisfiedAgentAc:false は既存 REVIEW 挙動不変', () => {
  const r = classifyMergeTier({ iterateStatus: 'lgtm', shape: 'standard', converged: true, unresolvedDanger: false, breakingStructured: false, breakingKeyword: false, docsOrTestOnly: false, escalateCount: 0, unsatisfiedAgentAc: false });
  assert.equal(r.tier, 'REVIEW');
});

test('classifyMergeTier: unsatisfiedAgentAc / unsatisfiedHumanAc 未指定なら REVIEW（フラグ省略時は false 扱い）', () => {
  const r = classifyMergeTier({ iterateStatus: 'lgtm', shape: 'standard', converged: true, unresolvedDanger: false, breakingStructured: false, breakingKeyword: false, docsOrTestOnly: false, escalateCount: 0 });
  assert.equal(r.tier, 'REVIEW');
});

// ---- issue #747: AC 未達の HOLD 理由を actor で分ける ----

test('classifyMergeTier: 人手 AC だけが未達 → HOLD 理由は ac_human_pending（人手 AC 待ち）のみ', () => {
  const r = classifyMergeTier({ ...standardBase(), iterateStatus: 'lgtm', evalStaleness: 'none', unsatisfiedHumanAc: true, unsatisfiedAgentAc: false });
  assert.equal(r.tier, 'HOLD');
  assert.deepEqual(r.holdReasons.map((x) => x.code), ['ac_human_pending']);
  assert.match(r.holdReasons[0].reason, /人手 AC 待ち/);
  assert.equal(r.holdKind, 'human_judgment');
});

test('classifyMergeTier: エージェント AC が未達 → HOLD 理由は ac_agent_unsatisfied（取りこぼし）で、人手 AC 待ちとは別 code', () => {
  const r = classifyMergeTier({ ...standardBase(), iterateStatus: 'lgtm', evalStaleness: 'none', unsatisfiedAgentAc: true });
  assert.equal(r.tier, 'HOLD');
  assert.deepEqual(r.holdReasons.map((x) => x.code), ['ac_agent_unsatisfied']);
  assert.match(r.holdReasons[0].reason, /エージェント AC 未達/);
  assert.ok(!r.reasons.some((x) => /人手 AC 待ち/.test(x)), `人手 AC 待ちの文言が混ざった: ${JSON.stringify(r.reasons)}`);
});

test('classifyMergeTier: 両方未達 → ac_agent_unsatisfied と ac_human_pending を 1 件ずつ積む', () => {
  const r = classifyMergeTier({ ...standardBase(), iterateStatus: 'lgtm', evalStaleness: 'none', unsatisfiedAgentAc: true, unsatisfiedHumanAc: true });
  assert.equal(r.tier, 'HOLD');
  assert.deepEqual(r.holdReasons.map((x) => x.code), ['ac_agent_unsatisfied', 'ac_human_pending']);
});

// ---- issue #861: ci の AC（ci_verify）が CI で success にならなかった ----

test('classifyMergeTier: ci の AC が未確定 → HOLD 理由は ac_ci_pending（CI 判定待ち）で、人手・エージェントの AC 未達とは別 code', () => {
  const r = classifyMergeTier({ ...standardBase(), iterateStatus: 'lgtm', evalStaleness: 'none', unsatisfiedCiAc: true });
  assert.equal(r.tier, 'HOLD');
  assert.deepEqual(r.holdReasons.map((x) => x.code), ['ac_ci_pending']);
  assert.match(r.holdReasons[0].reason, /CI 判定待ち/);
  assert.equal(classifyMergeTier({ ...standardBase(), iterateStatus: 'lgtm', evalStaleness: 'none', unsatisfiedCiAc: false }).tier, 'REVIEW');
  assert.throws(() => classifyMergeTier({ ...standardBase(), unsatisfiedCiAc: 'yes' }), /invalid unsatisfiedCiAc/);
});

test('classifyMergeTier: 旧キー unsatisfiedAc は actor を区別できないので明示 error', () => {
  assert.throws(() => classifyMergeTier({ ...standardBase(), iterateStatus: 'lgtm', unsatisfiedAc: true }), /unsatisfiedAc は廃止/);
});

test('classifyMergeTier: unsatisfiedAgentAc / unsatisfiedHumanAc が boolean 以外なら明示 error', () => {
  assert.throws(() => classifyMergeTier({ ...standardBase(), iterateStatus: 'lgtm', unsatisfiedAgentAc: 1 }), /invalid unsatisfiedAgentAc/);
  assert.throws(() => classifyMergeTier({ ...standardBase(), iterateStatus: 'lgtm', unsatisfiedHumanAc: 'yes' }), /invalid unsatisfiedHumanAc/);
});

test('classifyMergeTier: unsatisfiedAgentAc:true は AUTO 条件(micro+docs/test-only)でも HOLD に勝つ', () => {
  const r = classifyMergeTier({ iterateStatus: 'lgtm', shape: 'micro', converged: true, unresolvedDanger: false, breakingStructured: false, breakingKeyword: false, docsOrTestOnly: true, escalateCount: 0, unsatisfiedAgentAc: true });
  assert.equal(r.tier, 'HOLD');
});

// ---- evalSkipped フラグ（issue #233）----

test('classifyMergeTier: evalSkipped:true + micro AUTO → tier===AUTO かつ AC未検証文言を含む', () => {
  const r = classifyMergeTier({ iterateStatus: 'lgtm', shape: 'micro', converged: true, unresolvedDanger: false, breakingStructured: false, breakingKeyword: false, docsOrTestOnly: true, escalateCount: 0, evalSkipped: true });
  assert.equal(r.tier, 'AUTO');
  assert.ok(r.reasons.some((x) => x.includes('AC は未検証（micro eval skip）')), `reasons に AC未検証文言を含むべきだが: ${JSON.stringify(r.reasons)}`);
});

test('classifyMergeTier: evalSkipped:false + micro AUTO → tier===AUTO かつ AC未検証文言を含まない', () => {
  const r = classifyMergeTier({ iterateStatus: 'lgtm', shape: 'micro', converged: true, unresolvedDanger: false, breakingStructured: false, breakingKeyword: false, docsOrTestOnly: true, escalateCount: 0, evalSkipped: false });
  assert.equal(r.tier, 'AUTO');
  assert.ok(!r.reasons.some((x) => x.includes('AC は未検証（micro eval skip）')), `evalSkipped:false では AC未検証文言を含むべきでないが: ${JSON.stringify(r.reasons)}`);
});

test('classifyMergeTier: evalSkipped 未指定 + micro AUTO → 従来通り reasons 1 件のみ（既存挙動不変）', () => {
  const r = classifyMergeTier({ iterateStatus: 'lgtm', shape: 'micro', converged: true, unresolvedDanger: false, breakingStructured: false, breakingKeyword: false, docsOrTestOnly: true, escalateCount: 0 });
  assert.equal(r.tier, 'AUTO');
  assert.equal(r.reasons.length, 1, `evalSkipped 未指定時は reasons 1 件のはずだが: ${JSON.stringify(r.reasons)}`);
  assert.ok(!r.reasons.some((x) => x.includes('AC は未検証（micro eval skip）')), 'evalSkipped 未指定では AC未検証文言なし');
});

test('classifyMergeTier: evalSkipped:true + standard → REVIEW かつ AC未検証文言なし（非AUTO ゲート境界不変）', () => {
  const r = classifyMergeTier({ iterateStatus: 'lgtm', shape: 'standard', converged: true, unresolvedDanger: false, breakingStructured: false, breakingKeyword: false, docsOrTestOnly: false, escalateCount: 0, evalSkipped: true });
  assert.equal(r.tier, 'REVIEW');
  assert.ok(!r.reasons.some((x) => x.includes('AC は未検証（micro eval skip）')), `REVIEW tier では AC未検証文言なし: ${JSON.stringify(r.reasons)}`);
});

test('classifyMergeTier: evalSkipped:true + HOLD 条件(unsatisfiedAgentAc:true) → HOLD かつ AC未検証文言なし（非AUTO ゲート境界不変）', () => {
  const r = classifyMergeTier({ iterateStatus: 'lgtm', shape: 'micro', converged: true, unresolvedDanger: false, breakingStructured: false, breakingKeyword: false, docsOrTestOnly: true, escalateCount: 0, unsatisfiedAgentAc: true, evalSkipped: true });
  assert.equal(r.tier, 'HOLD');
  assert.ok(!r.reasons.some((x) => x.includes('AC は未検証（micro eval skip）')), `HOLD tier では AC未検証文言なし: ${JSON.stringify(r.reasons)}`);
});

// ---- fail_closed フラグ + dangerFailClosed HOLD reason（issue #271）----

test('reconcileDanger: fail-closed (risk.ok:false) では全 SEC seed item が fail_closed===true かつ checked===false', () => {
  const out = reconcileDanger(ledgerWithSeeds(), { ok: false, error: 'script failed' });
  for (const it of out.items) {
    assert.equal(it.fail_closed, true, `${it.id} should be fail_closed`);
    assert.equal(it.checked, false, `${it.id} should be unchecked`);
  }
});

test('reconcileDanger: fail-closed した ledger を clean で再 reconcile すると各 SEC item が fail_closed===false かつ checked===true に戻る(stale フラグ解消)', () => {
  const failClosed = reconcileDanger(ledgerWithSeeds(), { ok: false, error: 'script failed' });
  const recovered = reconcileDanger(failClosed, { ok: true, hits: [] });
  for (const it of recovered.items) {
    assert.equal(it.fail_closed, false, `${it.id} should have fail_closed cleared`);
    assert.equal(it.checked, true, `${it.id} should be checked (clean)`);
  }
});

test('reconcileDanger: 実 hit(risk.ok:true + hits) で reconcile した SEC item は fail_closed===false(実 hit は fail-closed でない)', () => {
  const out = reconcileDanger(ledgerWithSeeds(), { ok: true, hits: [{ class: 'auth' }] });
  const auth = out.items.find((it) => it.id === 'SEC-AUTH');
  assert.equal(auth.fail_closed, false, 'hit item も fail_closed は false(danger_hits とは別軸)');
  const cfg = out.items.find((it) => it.id === 'SEC-CONFIG');
  assert.equal(cfg.fail_closed, false, 'clean item も fail_closed は false');
});

test('classifyMergeTier: dangerFailClosed:true → tier===HOLD かつ reasons に fail-closed 文言を含む', () => {
  const r = classifyMergeTier({ iterateStatus: 'lgtm',
    shape: 'standard',
    converged: false,
    unresolvedDanger: false,
    breakingStructured: false, breakingKeyword: false,
    docsOrTestOnly: false,
    escalateCount: 0,
    dangerFailClosed: true,
  });
  assert.equal(r.tier, 'HOLD');
  assert.ok(r.reasons.some((x) => /fail-closed/.test(x)), `reasons に fail-closed 文言を含むべきだが: ${JSON.stringify(r.reasons)}`);
});

// ---- issue #746: merge-tier-facts の転記欠落は danger_fail_closed と別 code で出す ----

test('classifyMergeTier: dangerFailClosed:true + riskValueDropped:true → HOLD、code は merge_facts_dropped（danger-grep 実行不能 と書かない）', () => {
  const r = classifyMergeTier({ iterateStatus: 'lgtm', shape: 'standard', converged: false, unresolvedDanger: false, breakingStructured: false, breakingKeyword: false, docsOrTestOnly: false, escalateCount: 0, dangerFailClosed: true, riskValueDropped: true });
  assert.equal(r.tier, 'HOLD');
  const item = r.holdReasons.find((x) => x.code === 'merge_facts_dropped');
  assert.ok(item, `holdReasons に merge_facts_dropped を含むべきだが: ${JSON.stringify(r.holdReasons)}`);
  assert.match(item.reason, /merge-tier-facts の転記欠落/);
  assert.equal(item.kind, 'human_judgment');
  assert.ok(!r.holdReasons.some((x) => x.code === 'danger_fail_closed'), 'danger_fail_closed と二重に積まない');
  assert.ok(!r.reasons.some((x) => x.includes('danger-grep 実行不能')), `reasons に danger-grep 実行不能 が残っている: ${JSON.stringify(r.reasons)}`);
});

test('classifyMergeTier: riskValueDropped:false / 未指定 → 従来どおり danger_fail_closed', () => {
  for (const riskValueDropped of [false, undefined]) {
    const r = classifyMergeTier({ iterateStatus: 'lgtm', shape: 'standard', converged: false, unresolvedDanger: false, breakingStructured: false, breakingKeyword: false, docsOrTestOnly: false, escalateCount: 0, dangerFailClosed: true, riskValueDropped });
    assert.ok(r.holdReasons.some((x) => x.code === 'danger_fail_closed'));
    assert.ok(!r.holdReasons.some((x) => x.code === 'merge_facts_dropped'));
  }
});

test('classifyMergeTier: riskValueDropped:true でも dangerFailClosed でなければ reason を積まない', () => {
  const r = classifyMergeTier({ iterateStatus: 'lgtm', shape: 'standard', converged: true, unresolvedDanger: false, breakingStructured: false, breakingKeyword: false, docsOrTestOnly: false, escalateCount: 0, riskValueDropped: true });
  assert.equal(r.tier, 'REVIEW');
  assert.deepEqual(r.holdReasons, []);
});

test('classifyMergeTier: riskValueDropped が boolean 以外なら throw', () => {
  assert.throws(() => classifyMergeTier({ iterateStatus: 'lgtm', shape: 'standard', converged: true, dangerFailClosed: true, riskValueDropped: 'yes' }), /invalid riskValueDropped/);
});

test('classifyMergeTier: dangerFailClosed 未指定 → 従来通り(regression なし)', () => {
  const rNotConverged = classifyMergeTier({ iterateStatus: 'lgtm', shape: 'standard', converged: false, unresolvedDanger: false, breakingStructured: false, breakingKeyword: false, docsOrTestOnly: false, escalateCount: 0 });
  assert.equal(rNotConverged.tier, 'HOLD');
  assert.ok(!rNotConverged.reasons.some((x) => /fail-closed/.test(x)));

  const rBreaking = classifyMergeTier({ iterateStatus: 'lgtm', shape: 'complex', converged: true, unresolvedDanger: false, breakingStructured: true, breakingKeyword: true, docsOrTestOnly: false, escalateCount: 0 });
  assert.equal(rBreaking.tier, 'HOLD');
  assert.ok(!rBreaking.reasons.some((x) => /fail-closed/.test(x)));

  const rAuto = classifyMergeTier({ iterateStatus: 'lgtm', shape: 'micro', converged: true, unresolvedDanger: false, breakingStructured: false, breakingKeyword: false, docsOrTestOnly: true, escalateCount: 0 });
  assert.equal(rAuto.tier, 'AUTO');
  assert.ok(!rAuto.reasons.some((x) => /fail-closed/.test(x)));

  const rReview = classifyMergeTier({ iterateStatus: 'lgtm', shape: 'standard', converged: true, unresolvedDanger: false, breakingStructured: false, breakingKeyword: false, docsOrTestOnly: false, escalateCount: 0 });
  assert.equal(rReview.tier, 'REVIEW');
  assert.ok(!rReview.reasons.some((x) => /fail-closed/.test(x)));
});

// ---- reconcileDanger: stale evidence クリア（issue #299）----

test('reconcileDanger: checked=true(evidence="danger-grep clean")+floor=false の SEC item が hit に転じたとき evidence が null にクリアされる（自己矛盾 evidence を残さない）', () => {
  const clean = reconcileDanger(ledgerWithSeeds(), { ok: true, hits: [] });
  const authClean = clean.items.find((it) => it.id === 'SEC-AUTH');
  assert.equal(authClean.checked, true);
  assert.match(authClean.evidence, /clean/);
  assert.equal(authClean.floor, false);

  const hit = reconcileDanger(clean, { ok: true, hits: [{ class: 'auth' }] });
  const authHit = hit.items.find((it) => it.id === 'SEC-AUTH');
  assert.equal(authHit.checked, false);
  assert.equal(authHit.severity, 'critical');
  assert.equal(authHit.floor, true);
  assert.equal(authHit.evidence, null, 'stale "danger-grep clean" evidence は null にクリアされるべき');
});

test('reconcileDanger: checked=false のまま引き続き hit する SEC item も evidence が null にクリアされる', () => {
  const seeded = {
    items: seedSecurityLedger().map((it) => ({ checked: false, evidence: 'some stale text', floor: false, ...it })),
    round: 0,
  };
  const hit = reconcileDanger(seeded, { ok: true, hits: [{ class: 'auth' }] });
  const authHit = hit.items.find((it) => it.id === 'SEC-AUTH');
  assert.equal(authHit.checked, false);
  assert.equal(authHit.evidence, null);
});

test('reconcileDanger: floor=true+checked=true(evaluator clearance 済み)の SEC item が引き続き hit する場合は item 全体(evidence 含む)が据え置かれる', () => {
  const step1 = reconcileDanger(ledgerWithSeeds(), { ok: true, hits: [{ class: 'auth' }] });
  const cleared = {
    ...step1,
    items: step1.items.map((it) =>
      it.id === 'SEC-AUTH' ? { ...it, checked: true, evidence: 'security cleared: no auth bypass' } : it),
  };
  const step2 = reconcileDanger(cleared, { ok: true, hits: [{ class: 'auth' }] });
  const auth = step2.items.find((it) => it.id === 'SEC-AUTH');
  assert.equal(auth.checked, true);
  assert.equal(auth.floor, true);
  assert.equal(auth.evidence, 'security cleared: no auth bypass', 'clearance 済みの evidence は据え置かれる');
});

// ---- newlyUncheckedSecClasses（issue #299）----

function secItem(overrides) {
  return {
    id: `SEC-${(overrides.danger_class ?? 'auth').toUpperCase()}`,
    dimension: 'security',
    source: 'seed',
    checked: false,
    fail_closed: false,
    danger_class: 'auth',
    ...overrides,
  };
}

test('newlyUncheckedSecClasses: before で checked(danger-grep clean) → after で unchecked に転じた class が返る', () => {
  const before = { items: [secItem({ danger_class: 'auth', checked: true, evidence: 'danger-grep clean' })] };
  const after = { items: [secItem({ danger_class: 'auth', checked: false, floor: true, severity: 'critical', evidence: null })] };
  assert.deepEqual(newlyUncheckedSecClasses(before, after), ['auth']);
});

test('newlyUncheckedSecClasses: before から unchecked のままの class は返らない', () => {
  const before = { items: [secItem({ danger_class: 'auth', checked: false })] };
  const after = { items: [secItem({ danger_class: 'auth', checked: false })] };
  assert.deepEqual(newlyUncheckedSecClasses(before, after), []);
});

test('newlyUncheckedSecClasses: floor+checked 維持(clearance 済み)の class は返らない', () => {
  const before = { items: [secItem({ danger_class: 'auth', checked: true, floor: true, evidence: 'security cleared: ok' })] };
  const after = { items: [secItem({ danger_class: 'auth', checked: true, floor: true, evidence: 'security cleared: ok' })] };
  assert.deepEqual(newlyUncheckedSecClasses(before, after), []);
});

test('newlyUncheckedSecClasses: after で fail_closed:true の item は除外される', () => {
  const before = { items: [secItem({ danger_class: 'auth', checked: true, evidence: 'danger-grep clean' })] };
  const after = { items: [secItem({ danger_class: 'auth', checked: false, fail_closed: true, evidence: 'danger-grep unavailable (fail-closed)' })] };
  assert.deepEqual(newlyUncheckedSecClasses(before, after), []);
});

test('newlyUncheckedSecClasses: SEC seed 以外(source評価者やdimension eval)の item は無視される', () => {
  const before = {
    items: [
      secItem({ danger_class: 'auth', checked: true, evidence: 'danger-grep clean' }),
      { id: 'EV-1', dimension: 'eval', source: 'evaluator', checked: true },
    ],
  };
  const after = {
    items: [
      secItem({ danger_class: 'auth', checked: false, evidence: null }),
      { id: 'EV-1', dimension: 'eval', source: 'evaluator', checked: false },
    ],
  };
  assert.deepEqual(newlyUncheckedSecClasses(before, after), ['auth']);
});

test('newlyUncheckedSecClasses: before に同 id が無い item は対象外', () => {
  const before = { items: [] };
  const after = { items: [secItem({ danger_class: 'auth', checked: false })] };
  assert.deepEqual(newlyUncheckedSecClasses(before, after), []);
});

test('newlyUncheckedSecClasses: 複数 class が after.items の順序で返る', () => {
  const before = {
    items: [
      secItem({ danger_class: 'crypto', checked: true, evidence: 'danger-grep clean' }),
      secItem({ danger_class: 'auth', checked: true, evidence: 'danger-grep clean' }),
    ],
  };
  const after = {
    items: [
      secItem({ danger_class: 'auth', checked: false }),
      secItem({ danger_class: 'crypto', checked: false }),
    ],
  };
  assert.deepEqual(newlyUncheckedSecClasses(before, after), ['auth', 'crypto']);
});

test('newlyUncheckedSecClasses: 入力 ledger を mutate しない', () => {
  const before = { items: [secItem({ danger_class: 'auth', checked: true, evidence: 'danger-grep clean' })] };
  const after = { items: [secItem({ danger_class: 'auth', checked: false, evidence: null })] };
  const beforeSnapshot = JSON.parse(JSON.stringify(before));
  const afterSnapshot = JSON.parse(JSON.stringify(after));
  newlyUncheckedSecClasses(before, after);
  assert.deepEqual(before, beforeSnapshot);
  assert.deepEqual(after, afterSnapshot);
});

// ---- classifyMergeTier: finalReconcile / finalTestGreen（Final reconcile phase, issue #320）----
// issue #319 の iterateStatus/evalStaleness ゲートと直交させるため、各ケースは
// iterateStatus:'lgtm' + evalStaleness:'none'（clean 側）を明示して final 系入力のみを検証する。

test('classifyMergeTier: finalReconcile/finalTestGreen 未指定 → 既存挙動不変、reasons に final 関連文言なし', () => {
  const r = classifyMergeTier({
    shape: 'standard', converged: true, unresolvedDanger: false,
    breakingStructured: false, breakingKeyword: false,
    docsOrTestOnly: false, escalateCount: 0,
    iterateStatus: 'lgtm', evalStaleness: 'none',
  });
  assert.equal(r.tier, 'REVIEW');
  assert.ok(!r.reasons.some((x) => /final/i.test(x)), `reasons に final 関連文言を含むべきでないが: ${JSON.stringify(r.reasons)}`);
});

test('classifyMergeTier: finalReconcile:"skipped" + finalTestGreen:null → 既存挙動不変', () => {
  const r = classifyMergeTier({
    shape: 'standard', converged: true, unresolvedDanger: false,
    breakingStructured: false, breakingKeyword: false,
    docsOrTestOnly: false, escalateCount: 0,
    iterateStatus: 'lgtm', evalStaleness: 'none',
    finalReconcile: 'skipped', finalTestGreen: null,
  });
  assert.equal(r.tier, 'REVIEW');
  assert.ok(!r.reasons.some((x) => /final/i.test(x)), `reasons に final 関連文言を含むべきでないが: ${JSON.stringify(r.reasons)}`);
});

test('classifyMergeTier: finalReconcile:"reverified" + finalTestGreen:true → REVIEW のまま', () => {
  const r = classifyMergeTier({
    shape: 'standard', converged: true, unresolvedDanger: false,
    breakingStructured: false, breakingKeyword: false,
    docsOrTestOnly: false, escalateCount: 0,
    iterateStatus: 'lgtm', evalStaleness: 'none',
    finalReconcile: 'reverified', finalTestGreen: true,
  });
  assert.equal(r.tier, 'REVIEW');
  assert.ok(!r.reasons.some((x) => /final/i.test(x)), `reasons に final 関連文言を含むべきでないが: ${JSON.stringify(r.reasons)}`);
});

test('classifyMergeTier: finalReconcile:"reverified" + finalTestGreen:false → HOLD + reason に "final test red" を含む', () => {
  const r = classifyMergeTier({
    shape: 'standard', converged: true, unresolvedDanger: false,
    breakingStructured: false, breakingKeyword: false,
    docsOrTestOnly: false, escalateCount: 0,
    iterateStatus: 'lgtm', evalStaleness: 'none',
    finalReconcile: 'reverified', finalTestGreen: false,
  });
  assert.equal(r.tier, 'HOLD');
  assert.ok(r.reasons.some((x) => x.includes('final test red')), `reasons に 'final test red' を含むべきだが: ${JSON.stringify(r.reasons)}`);
});

test('classifyMergeTier: finalReconcile:"unavailable" → HOLD + reason に "Final reconcile 再検証不能" を含む', () => {
  const r = classifyMergeTier({
    shape: 'standard', converged: true, unresolvedDanger: false,
    breakingStructured: false, breakingKeyword: false,
    docsOrTestOnly: false, escalateCount: 0,
    iterateStatus: 'lgtm', evalStaleness: 'none',
    finalReconcile: 'unavailable',
  });
  assert.equal(r.tier, 'HOLD');
  assert.ok(r.reasons.some((x) => x.includes('Final reconcile 再検証不能')), `reasons に 'Final reconcile 再検証不能' を含むべきだが: ${JSON.stringify(r.reasons)}`);
});

test('classifyMergeTier: micro+docsOrTestOnly の AUTO ケースに finalReconcile:"reverified"+finalTestGreen:true を足しても AUTO のまま', () => {
  const r = classifyMergeTier({
    shape: 'micro', converged: true, unresolvedDanger: false,
    breakingStructured: false, breakingKeyword: false,
    docsOrTestOnly: true, escalateCount: 0,
    iterateStatus: 'lgtm', evalStaleness: 'none',
    finalReconcile: 'reverified', finalTestGreen: true,
  });
  assert.equal(r.tier, 'AUTO');
  assert.ok(!r.reasons.some((x) => /final/i.test(x)), `reasons に final 関連文言を含むべきでないが: ${JSON.stringify(r.reasons)}`);
});

test('classifyMergeTier: finalReconcile が out-of-enum（"bogus" / 撤去した "ci_verified"）→ throw', () => {
  for (const finalReconcile of ['bogus', 'ci_verified']) {
    assert.throws(() => classifyMergeTier({
      shape: 'standard', converged: true, unresolvedDanger: false,
      breakingStructured: false, breakingKeyword: false,
      docsOrTestOnly: false, escalateCount: 0,
      iterateStatus: 'lgtm', evalStaleness: 'none',
      finalReconcile,
    }), /invalid finalReconcile/, finalReconcile);
  }
});

// ---- issue #319: iterateStatus / evalStaleness ----

// AUTO 適格 base（micro + docs/test-only + danger clean + 収束）
function autoBase() {
  return {
    shape: 'micro',
    converged: true,
    unresolvedDanger: false,
    breakingStructured: false,
    breakingKeyword: false,
    docsOrTestOnly: true,
    escalateCount: 0,
  };
}

function standardBase() {
  return {
    shape: 'standard',
    converged: true,
    unresolvedDanger: false,
    breakingStructured: false,
    breakingKeyword: false,
    docsOrTestOnly: false,
    escalateCount: 0,
  };
}

// (a) AC-1/AC-4: 非 lgtm status は table-driven に HOLD + reasons に status 文字列を含む
test('classifyMergeTier: iterateStatus が lgtm 以外の既知終端値 → HOLD かつ reasons に status 文字列を含む', () => {
  const statuses = ['stuck', 'fix_failed', 'max_reached', 'ci_error', 'ci_pending', 'totally-unknown'];
  for (const status of statuses) {
    const r = classifyMergeTier({ ...autoBase(), iterateStatus: status, evalStaleness: 'none' });
    assert.equal(r.tier, 'HOLD', `status=${status} は HOLD になるべきだが: ${JSON.stringify(r)}`);
    const joined = r.reasons.join(' ');
    assert.ok(joined.includes(status), `reasons に status=${status} を含むべきだが: ${JSON.stringify(r.reasons)}`);
  }
});

// (b) AC-1: iterateStatus が null / undefined でも HOLD、reasons に 'null' の表記を含む
test('classifyMergeTier: iterateStatus:null → HOLD かつ reasons に null 表記を含む', () => {
  const r = classifyMergeTier({ ...autoBase(), iterateStatus: null, evalStaleness: 'none' });
  assert.equal(r.tier, 'HOLD');
  assert.ok(r.reasons.join(' ').includes('null'), `reasons に null 表記を含むべきだが: ${JSON.stringify(r.reasons)}`);
});

test('classifyMergeTier: iterateStatus 未指定(undefined) → HOLD かつ reasons に null 表記を含む', () => {
  const r = classifyMergeTier({ ...autoBase(), evalStaleness: 'none' });
  assert.equal(r.tier, 'HOLD');
  assert.ok(r.reasons.join(' ').includes('null'), `reasons に null 表記を含むべきだが: ${JSON.stringify(r.reasons)}`);
});

// (c) AC-2/AC-4: evalStaleness:'hash_mismatch' は AUTO 適格でも HOLD、reasons に hash mismatch を示す文言
test('classifyMergeTier: evalStaleness:hash_mismatch → HOLD かつ reasons に hash mismatch を示す文言を含む(AUTO 適格でも)', () => {
  const r = classifyMergeTier({ ...autoBase(), iterateStatus: 'lgtm', evalStaleness: 'hash_mismatch' });
  assert.equal(r.tier, 'HOLD');
  const hashReason = r.reasons.find((x) => /hash/i.test(x));
  assert.ok(hashReason, `reasons に hash 関連文言を含むべきだが: ${JSON.stringify(r.reasons)}`);
  assert.ok(/不一致|hash_mismatch/.test(hashReason), `reasons に不一致 or hash_mismatch を含むべきだが: ${hashReason}`);
});

// (d) 複合: iterateStatus:stuck + evalStaleness:hash_mismatch → HOLD かつ両方の reason が別要素として存在
test('classifyMergeTier: iterateStatus:stuck + evalStaleness:hash_mismatch → HOLD かつ非lgtm由来とhash_mismatch由来の reason が両方別要素として存在', () => {
  const r = classifyMergeTier({ ...autoBase(), iterateStatus: 'stuck', evalStaleness: 'hash_mismatch' });
  assert.equal(r.tier, 'HOLD');
  const nonLgtmReason = r.reasons.find((x) => x.includes('stuck'));
  const hashReason = r.reasons.find((x) => /hash/i.test(x));
  assert.ok(nonLgtmReason, `reasons に stuck 由来 reason を含むべきだが: ${JSON.stringify(r.reasons)}`);
  assert.ok(hashReason, `reasons に hash 由来 reason を含むべきだが: ${JSON.stringify(r.reasons)}`);
  assert.notEqual(nonLgtmReason, hashReason, '両 reason は別要素であるべき');
});

// (e) AC-3 回帰: iterateStatus:lgtm + evalStaleness:none で既存 tier 判定が変わらないこと
test('classifyMergeTier: iterateStatus:lgtm + evalStaleness:none → 既存 AUTO/REVIEW/HOLD 判定は不変(回帰なし)', () => {
  // (e-1) AUTO base
  const rAuto = classifyMergeTier({ ...autoBase(), iterateStatus: 'lgtm', evalStaleness: 'none' });
  assert.equal(rAuto.tier, 'AUTO');

  // (e-2) standard base
  const rReview = classifyMergeTier({ ...standardBase(), iterateStatus: 'lgtm', evalStaleness: 'none' });
  assert.equal(rReview.tier, 'REVIEW');

  // (e-3) standard + unsatisfiedAgentAc:true
  const rHold = classifyMergeTier({ ...standardBase(), iterateStatus: 'lgtm', evalStaleness: 'none', unsatisfiedAgentAc: true });
  assert.equal(rHold.tier, 'HOLD');
  assert.ok(rHold.reasons.some((x) => /AC 未達/.test(x)), `reasons に既存の AC 未達文言を含むべきだが: ${JSON.stringify(rHold.reasons)}`);
});

// (f) AC-3: evalStaleness:iterate_fixed は hash_mismatch 以外なので tier に影響しない
test('classifyMergeTier: iterateStatus:lgtm + evalStaleness:iterate_fixed → tier は不変(hash_mismatch 以外は影響しない)', () => {
  const rAuto = classifyMergeTier({ ...autoBase(), iterateStatus: 'lgtm', evalStaleness: 'iterate_fixed' });
  assert.equal(rAuto.tier, 'AUTO');

  const rReview = classifyMergeTier({ ...standardBase(), iterateStatus: 'lgtm', evalStaleness: 'iterate_fixed' });
  assert.equal(rReview.tier, 'REVIEW');
});

// (g) dev-flow.js 側の iterateStatus / evalStaleness 配線は empty-diff-evaluate-routing.test.mjs (P-3) が
// VM 挙動（fix_failed → HOLD / iterate_incomplete）で検証する（issue #636）。

// ---- issue #362: testsurfUncleared ----

test('classifyMergeTier: testsurfUncleared 非空 → HOLD reason に対象 id と test-weakening 文言を含む(converged:false と同時発生)', () => {
  const r = classifyMergeTier({
    shape: 'standard', converged: false, unresolvedDanger: false,
    breakingStructured: false, breakingKeyword: false,
    docsOrTestOnly: false, escalateCount: 0,
    iterateStatus: 'lgtm', evalStaleness: 'none',
    testsurfUncleared: ['TESTSURF-SKIP'],
  });
  assert.equal(r.tier, 'HOLD');
  const tsReason = r.reasons.find((x) => x.includes('test-weakening'));
  assert.ok(tsReason, `reasons に test-weakening 文言を含むべきだが: ${JSON.stringify(r.reasons)}`);
  assert.ok(tsReason.includes('TESTSURF-SKIP'), `reasons に対象 id TESTSURF-SKIP を含むべきだが: ${tsReason}`);
});

test('classifyMergeTier: testsurfUncleared 未指定/空 → 従来通り(regression なし、test-weakening 文言なし)', () => {
  const base = {
    shape: 'micro', converged: true, unresolvedDanger: false,
    breakingStructured: false, breakingKeyword: false,
    docsOrTestOnly: true, escalateCount: 0,
    iterateStatus: 'lgtm', evalStaleness: 'none',
  };
  const rUndefined = classifyMergeTier(base);
  assert.equal(rUndefined.tier, 'AUTO');
  assert.ok(!rUndefined.reasons.some((x) => /test-weakening/.test(x)));

  const rEmpty = classifyMergeTier({ ...base, testsurfUncleared: [] });
  assert.equal(rEmpty.tier, 'AUTO');
  assert.ok(!rEmpty.reasons.some((x) => /test-weakening/.test(x)));
});

// ---- issue #405: classifyMergeableState + classifyMergeTier conflict gate ----

test('classifyMergeableState: mergeable=MERGEABLE + mergeStateStatus=CLEAN → clean', () => {
  assert.equal(
    classifyMergeableState({ ok: true, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }),
    'clean',
  );
});

test('classifyMergeableState: mergeable=CONFLICTING → conflicting', () => {
  assert.equal(classifyMergeableState({ ok: true, mergeable: 'CONFLICTING' }), 'conflicting');
});

test('classifyMergeableState: mergeStateStatus=DIRTY(mergeable 未設定) → conflicting', () => {
  assert.equal(classifyMergeableState({ ok: true, mergeStateStatus: 'DIRTY' }), 'conflicting');
});

test('classifyMergeableState: mergeable=UNKNOWN → unknown(fail-open)', () => {
  assert.equal(classifyMergeableState({ ok: true, mergeable: 'UNKNOWN' }), 'unknown');
});

test('classifyMergeableState: ok:false → unknown(fail-open)', () => {
  assert.equal(classifyMergeableState({ ok: false }), 'unknown');
});

test('classifyMergeableState: null → unknown(fail-open)', () => {
  assert.equal(classifyMergeableState(null), 'unknown');
});

test('classifyMergeTier: mergeableState:"conflicting" → 本来 AUTO(micro+docs/test-only+収束)でも HOLD、reasons に conflict 文言を含む', () => {
  const r = classifyMergeTier({
    ...autoBase(), iterateStatus: 'lgtm', evalStaleness: 'none',
    mergeableState: 'conflicting',
  });
  assert.equal(r.tier, 'HOLD');
  assert.ok(r.reasons.some((x) => /conflict/.test(x)), `reasons に conflict 文言を含むべきだが: ${JSON.stringify(r.reasons)}`);
});

test('classifyMergeTier: mergeableState:"conflicting" → 本来 REVIEW(standard+収束済)でも HOLD', () => {
  const r = classifyMergeTier({
    ...standardBase(), iterateStatus: 'lgtm', evalStaleness: 'none',
    mergeableState: 'conflicting',
  });
  assert.equal(r.tier, 'HOLD');
  assert.ok(r.reasons.some((x) => /conflict/.test(x)), `reasons に conflict 文言を含むべきだが: ${JSON.stringify(r.reasons)}`);
});

test('classifyMergeTier: mergeableState:"clean" → tier に影響しない(AUTO/REVIEW とも従来通り)', () => {
  const rAuto = classifyMergeTier({
    ...autoBase(), iterateStatus: 'lgtm', evalStaleness: 'none',
    mergeableState: 'clean',
  });
  assert.equal(rAuto.tier, 'AUTO');
  assert.ok(!rAuto.reasons.some((x) => /conflict/.test(x)));

  const rReview = classifyMergeTier({
    ...standardBase(), iterateStatus: 'lgtm', evalStaleness: 'none',
    mergeableState: 'clean',
  });
  assert.equal(rReview.tier, 'REVIEW');
  assert.ok(!rReview.reasons.some((x) => /conflict/.test(x)));
});

test('classifyMergeTier: mergeableState 未指定(undefined) → 従来と完全同一 tier(regression なし、fail-open no-op)', () => {
  const rAuto = classifyMergeTier({ ...autoBase(), iterateStatus: 'lgtm', evalStaleness: 'none' });
  assert.equal(rAuto.tier, 'AUTO');
  assert.ok(!rAuto.reasons.some((x) => /conflict/.test(x)));

  const rReview = classifyMergeTier({ ...standardBase(), iterateStatus: 'lgtm', evalStaleness: 'none' });
  assert.equal(rReview.tier, 'REVIEW');
  assert.ok(!rReview.reasons.some((x) => /conflict/.test(x)));
});

test('classifyMergeTier: mergeableState:"unknown" → tier に影響しない(fail-open)', () => {
  const rAuto = classifyMergeTier({
    ...autoBase(), iterateStatus: 'lgtm', evalStaleness: 'none',
    mergeableState: 'unknown',
  });
  assert.equal(rAuto.tier, 'AUTO');
  assert.ok(!rAuto.reasons.some((x) => /conflict/.test(x)));
});

test('classifyMergeTier: mergeableState:"bogus"(out-of-enum) → throw', () => {
  assert.throws(() => classifyMergeTier({
    ...standardBase(), iterateStatus: 'lgtm', evalStaleness: 'none',
    mergeableState: 'bogus',
  }), /invalid mergeableState/);
});

// ---- issue #698: trust-layer kernel 撤去 — merge tier は trust 由来の入力を持たない ----

test('classifyMergeTier: trust 由来の gate 入力は存在しない（未知キーとして無視され tier / reasons / holdReasons に影響しない）', () => {
  const base = classifyMergeTier({ ...autoBase(), iterateStatus: 'lgtm', evalStaleness: 'none' });
  assert.equal(base.tier, 'AUTO');
  // 撤去前の HOLD 入力形 { blocking: true, verdict: 'fail' } を渡しても tier は変わらず、throw もしない
  const withStale = classifyMergeTier({
    ...autoBase(), iterateStatus: 'lgtm', evalStaleness: 'none',
    ['trust' + 'Gate']: { blocking: true, verdict: 'fail' },
  });
  assert.deepEqual(withStale, base);
  assert.ok(!HOLD_REASON_CODES.some((c) => /trust/.test(c)), `HOLD_REASON_CODES に trust 由来 code が残っている: ${HOLD_REASON_CODES}`);
  assert.ok(!classifyMergeTier.toString().includes('trust'), 'classifyMergeTier 本体に trust 参照が残っている');
});

// ---- issue #536: evalVerdictFail 開示専用 reason（keywordAloneDisclosure 同型）----

test('classifyMergeTier: evalVerdictFail:true + 収束済み standard → REVIEW かつ開示 reason を含む', () => {
  const r = classifyMergeTier({
    iterateStatus: 'lgtm', shape: 'standard', converged: true, unresolvedDanger: false,
    breakingStructured: false, breakingKeyword: false, docsOrTestOnly: false, escalateCount: 0,
    evalVerdictFail: true,
  });
  assert.equal(r.tier, 'REVIEW');
  assert.ok(r.reasons.some((x) => x.includes('evaluator verdict=fail')), `reasons に開示文言を含むべきだが: ${JSON.stringify(r.reasons)}`);
});

test('classifyMergeTier: evalVerdictFail 未指定/null/false は既存挙動と完全一致（pin）', () => {
  const baseInput = {
    iterateStatus: 'lgtm', shape: 'standard', converged: true, unresolvedDanger: false,
    breakingStructured: false, breakingKeyword: false, docsOrTestOnly: false, escalateCount: 0,
  };
  const withoutFlag = classifyMergeTier({ ...baseInput });
  assert.deepEqual(withoutFlag, {
    tier: 'REVIEW', reasons: ['標準 — 人間が LGTM して merge'], holdReasons: [], holdKind: null, disclosures: [],
  });

  const withNull = classifyMergeTier({ ...baseInput, evalVerdictFail: null });
  assert.deepEqual(withNull, withoutFlag);

  const withFalse = classifyMergeTier({ ...baseInput, evalVerdictFail: false });
  assert.deepEqual(withFalse, withoutFlag);
});

test('classifyMergeTier: evalVerdictFail に非 boolean(\'fail\'/1/{}) → throw', () => {
  const baseInput = {
    iterateStatus: 'lgtm', shape: 'standard', converged: true, unresolvedDanger: false,
    breakingStructured: false, breakingKeyword: false, docsOrTestOnly: false, escalateCount: 0,
  };
  for (const bad of ['fail', 1, {}]) {
    assert.throws(
      () => classifyMergeTier({ ...baseInput, evalVerdictFail: bad }),
      /classifyMergeTier: invalid evalVerdictFail/,
      `evalVerdictFail=${JSON.stringify(bad)} は throw すべき`,
    );
  }
});

test('classifyMergeTier: evalVerdictFail:true + HOLD 条件(unsatisfiedAgentAc:true) → HOLD のまま開示 reason が追記される', () => {
  const r = classifyMergeTier({
    iterateStatus: 'lgtm', shape: 'standard', converged: true, unresolvedDanger: false,
    breakingStructured: false, breakingKeyword: false, docsOrTestOnly: false, escalateCount: 0,
    unsatisfiedAgentAc: true, evalVerdictFail: true,
  });
  assert.equal(r.tier, 'HOLD');
  assert.ok(r.reasons.some((x) => x.includes('evaluator verdict=fail')), `HOLD reasons に開示文言を含むべきだが: ${JSON.stringify(r.reasons)}`);
});

test('classifyMergeTier: evalVerdictFail:true + micro AUTO 条件 → AUTO のまま開示 reason が追記される', () => {
  const r = classifyMergeTier({
    iterateStatus: 'lgtm', shape: 'micro', converged: true, unresolvedDanger: false,
    breakingStructured: false, breakingKeyword: false, docsOrTestOnly: true, escalateCount: 0,
    evalVerdictFail: true,
  });
  assert.equal(r.tier, 'AUTO');
  assert.ok(r.reasons.some((x) => x.includes('evaluator verdict=fail')), `AUTO reasons に開示文言を含むべきだが: ${JSON.stringify(r.reasons)}`);
});

// ---- classifyMergeTier: holdReasons / holdKind（issue #599）----
// 共通ベース入力（#320 セクションと同一の clean 側）。

function baseCleanInput(overrides) {
  return {
    shape: 'standard', converged: true, unresolvedDanger: false,
    breakingStructured: false, breakingKeyword: false,
    docsOrTestOnly: false, escalateCount: 0,
    iterateStatus: 'lgtm', evalStaleness: 'none',
    ...overrides,
  };
}

test('HOLD_REASON_KINDS は [\'deterministic_recheck\', \'human_judgment\'] と一致', () => {
  assert.deepEqual(HOLD_REASON_KINDS, ['deterministic_recheck', 'human_judgment']);
});

test('aggregateHoldKind: 空配列/非配列 → null', () => {
  assert.equal(aggregateHoldKind([]), null);
  assert.equal(aggregateHoldKind(null), null);
  assert.equal(aggregateHoldKind(undefined), null);
  assert.equal(aggregateHoldKind('not-an-array'), null);
});

test('aggregateHoldKind: 全件 deterministic_recheck → deterministic_recheck', () => {
  assert.equal(aggregateHoldKind([{ reason: 'a', kind: 'deterministic_recheck' }]), 'deterministic_recheck');
  assert.equal(aggregateHoldKind([
    { reason: 'a', kind: 'deterministic_recheck' },
    { reason: 'b', kind: 'deterministic_recheck' },
  ]), 'deterministic_recheck');
});

test('aggregateHoldKind: human_judgment が 1 件でも混在すれば human_judgment', () => {
  assert.equal(aggregateHoldKind([
    { reason: 'a', kind: 'deterministic_recheck' },
    { reason: 'b', kind: 'human_judgment' },
  ]), 'human_judgment');
  assert.equal(aggregateHoldKind([{ reason: 'a', kind: 'human_judgment' }]), 'human_judgment');
});

// PR の CI は PR head の workflow・スクリプトで動き PR 自身が書き換えられるため、CI の success の形をした
// 入力が来ても unavailable / tests:'error' の HOLD は外れない（issue #1168）。
const CI_SUCCESS_LIKE = { verified: true, reason: 'ok', kind: null, checkNames: ['Bats', 'Node'], headRefOid: 'a'.repeat(40) };

test('classifyMergeTier: finalReconcile:"unavailable" は CI の success の形をした入力があっても常に final_reconcile_unavailable（human_judgment）の HOLD', () => {
  for (const extra of [{}, { finalCi: CI_SUCCESS_LIKE }, { finalCi: CI_SUCCESS_LIKE, validateCi: CI_SUCCESS_LIKE }]) {
    const r = classifyMergeTier(baseCleanInput({ finalReconcile: 'unavailable', ...extra }));
    assert.equal(r.tier, 'HOLD', JSON.stringify(extra));
    assert.deepEqual(r.holdReasons.map((x) => [x.code, x.kind]), [['final_reconcile_unavailable', 'human_judgment']], JSON.stringify(extra));
    assert.ok(r.reasons[0].includes('Final reconcile 再検証不能') && r.reasons[0].endsWith('— 人間確認必須'), r.reasons[0]);
    assert.equal(r.holdKind, 'human_judgment');
    assert.ok(!r.reasons.some((x) => x.includes('CI')), `CI 委譲の文言を含むべきでないが: ${JSON.stringify(r.reasons)}`);
  }
});

test('classifyMergeTier: finalReconcile:"unavailable" + converged:false → holdReasons 2 件、holdKind human_judgment', () => {
  const r = classifyMergeTier(baseCleanInput({ converged: false, finalReconcile: 'unavailable' }));
  assert.equal(r.tier, 'HOLD');
  assert.equal(r.holdKind, 'human_judgment');
  assert.deepEqual(r.holdReasons.map((x) => x.code), ['ledger_unconverged', 'final_reconcile_unavailable']);
});

test('classifyMergeTier: 既存 HOLD/AUTO/REVIEW ケースで holdReasons/holdKind が期待どおり', () => {
  // HOLD（unsatisfiedAgentAc）
  const hold = classifyMergeTier(baseCleanInput({ unsatisfiedAgentAc: true }));
  assert.equal(hold.tier, 'HOLD');
  assert.equal(hold.holdReasons.length, hold.reasons.length);
  assert.equal(hold.holdKind, 'human_judgment');

  // AUTO
  const auto = classifyMergeTier(baseCleanInput({ shape: 'micro', docsOrTestOnly: true }));
  assert.equal(auto.tier, 'AUTO');
  assert.deepEqual(auto.holdReasons, []);
  assert.equal(auto.holdKind, null);

  // REVIEW
  const review = classifyMergeTier(baseCleanInput({}));
  assert.equal(review.tier, 'REVIEW');
  assert.deepEqual(review.holdReasons, []);
  assert.equal(review.holdKind, null);
});

// ---- issue #631: EVAL_STALENESS_VALUES / hash_mismatch 差分埋め込み / hash_reconverged ----

test('EVAL_STALENESS_VALUES は 5 値順で一致', () => {
  assert.deepEqual(EVAL_STALENESS_VALUES, [
    'none', 'hash_mismatch', 'hash_reconverged', 'iterate_incomplete', 'iterate_fixed',
  ]);
});

test('classifyMergeTier: hash_mismatch + staleDiffFiles 2件 → HOLD かつ reason に両 short hash と各 path と 差分件数 を含み 他 を含まない', () => {
  const r = classifyMergeTier(baseCleanInput({
    evalStaleness: 'hash_mismatch',
    evalDiffHash: '7d79f517aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    prDiffHash: 'be8e7f58bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    staleDiffFiles: [
      { path: 'docs/a.md', insertions: 0, deletions: 500 },
      { path: 'docs/b.md', insertions: 0, deletions: 360 },
    ],
  }));
  assert.equal(r.tier, 'HOLD');
  const hashReason = r.reasons.find((x) => /hash/i.test(x));
  assert.ok(hashReason, `reasons に hash 関連文言を含むべきだが: ${JSON.stringify(r.reasons)}`);
  assert.ok(hashReason.includes('7d79f517'), `short hash(eval) を含むべきだが: ${hashReason}`);
  assert.ok(hashReason.includes('be8e7f58'), `short hash(pr) を含むべきだが: ${hashReason}`);
  assert.ok(hashReason.includes('docs/a.md (+0/-500)'), `path(a) を含むべきだが: ${hashReason}`);
  assert.ok(hashReason.includes('docs/b.md (+0/-360)'), `path(b) を含むべきだが: ${hashReason}`);
  assert.ok(hashReason.includes('差分 2 件'), `差分件数を含むべきだが: ${hashReason}`);
  assert.ok(!hashReason.includes('他 '), `他 N 件 を含むべきでないが: ${hashReason}`);
});

test('classifyMergeTier: hash_mismatch + staleDiffFiles 12件 → 先頭10件を含み11/12件目を含まず 他 2件 を含む', () => {
  const files = Array.from({ length: 12 }, (_, i) => ({ path: `docs/f${i}.md`, insertions: 1, deletions: 1 }));
  const r = classifyMergeTier(baseCleanInput({
    evalStaleness: 'hash_mismatch',
    evalDiffHash: '1'.repeat(40),
    prDiffHash: '2'.repeat(40),
    staleDiffFiles: files,
  }));
  assert.equal(r.tier, 'HOLD');
  const hashReason = r.reasons.find((x) => /hash/i.test(x));
  for (let i = 0; i < 10; i++) {
    assert.ok(hashReason.includes(`docs/f${i}.md`), `先頭10件目 docs/f${i}.md を含むべきだが: ${hashReason}`);
  }
  assert.ok(!hashReason.includes('docs/f10.md'), `11件目は含まれないはずだが: ${hashReason}`);
  assert.ok(!hashReason.includes('docs/f11.md'), `12件目は含まれないはずだが: ${hashReason}`);
  assert.ok(hashReason.includes('他 2 件'), `'他 2 件' を含むべきだが: ${hashReason}`);
});

test('classifyMergeTier: hash_mismatch + staleDiffFiles:null → reason に両 hash 全文と git diff --stat コマンドと 手動確認 を含む', () => {
  const evalFull = '3'.repeat(40);
  const prFull = '4'.repeat(40);
  const r = classifyMergeTier(baseCleanInput({
    evalStaleness: 'hash_mismatch',
    evalDiffHash: evalFull,
    prDiffHash: prFull,
    staleDiffFiles: null,
  }));
  assert.equal(r.tier, 'HOLD');
  const hashReason = r.reasons.find((x) => /hash/i.test(x));
  assert.ok(hashReason.includes(evalFull), `eval hash 全文を含むべきだが: ${hashReason}`);
  assert.ok(hashReason.includes(prFull), `pr hash 全文を含むべきだが: ${hashReason}`);
  assert.ok(hashReason.includes(`git diff --stat ${evalFull} ${prFull}`), `git diff --stat コマンドを含むべきだが: ${hashReason}`);
  assert.ok(hashReason.includes('手動確認'), `'手動確認' を含むべきだが: ${hashReason}`);
});

test('classifyMergeTier: hash_mismatch + staleDiffFiles:[] → HOLD かつ 差分 0 件 を含む', () => {
  const r = classifyMergeTier(baseCleanInput({
    evalStaleness: 'hash_mismatch',
    evalDiffHash: '5'.repeat(40),
    prDiffHash: '6'.repeat(40),
    staleDiffFiles: [],
  }));
  assert.equal(r.tier, 'HOLD');
  const hashReason = r.reasons.find((x) => /hash/i.test(x));
  assert.ok(hashReason.includes('差分 0 件'), `'差分 0 件' を含むべきだが: ${hashReason}`);
});

test('classifyMergeTier: hash_mismatch + prHeadTreeOid → reason に PR head + short hash を含む', () => {
  const prHeadTreeOid = '7'.repeat(40);
  const r = classifyMergeTier(baseCleanInput({
    evalStaleness: 'hash_mismatch',
    evalDiffHash: '8'.repeat(40),
    prDiffHash: '9'.repeat(40),
    prHeadTreeOid,
    staleDiffFiles: [],
  }));
  assert.equal(r.tier, 'HOLD');
  const hashReason = r.reasons.find((x) => /hash/i.test(x));
  assert.ok(hashReason.includes('PR head ' + prHeadTreeOid.slice(0, 8)), `'PR head <short>' を含むべきだが: ${hashReason}`);
});

test('classifyMergeTier: evalStaleness:"hash_reconverged" → 他入力が同じなら "none" と tier/reasons/holdReasons/holdKind が deepEqual（AUTO base）', () => {
  const noneResult = classifyMergeTier({ ...autoBase(), iterateStatus: 'lgtm', evalStaleness: 'none' });
  const reconvergedResult = classifyMergeTier({ ...autoBase(), iterateStatus: 'lgtm', evalStaleness: 'hash_reconverged' });
  assert.deepEqual(reconvergedResult, noneResult);
  assert.equal(reconvergedResult.tier, 'AUTO');
  assert.deepEqual(reconvergedResult.holdReasons, []);
});

test('classifyMergeTier: evalStaleness:"hash_reconverged" → 他入力が同じなら "none" と deepEqual（standard base、REVIEW）', () => {
  const noneResult = classifyMergeTier({ ...standardBase(), iterateStatus: 'lgtm', evalStaleness: 'none' });
  const reconvergedResult = classifyMergeTier({ ...standardBase(), iterateStatus: 'lgtm', evalStaleness: 'hash_reconverged' });
  assert.deepEqual(reconvergedResult, noneResult);
  assert.equal(reconvergedResult.tier, 'REVIEW');
});

test('classifyMergeTier: evalStaleness:"hash_reconverged" + unsatisfiedAgentAc:true → HOLD だが reasons に hash 由来文言なし', () => {
  const r = classifyMergeTier({
    ...standardBase(), iterateStatus: 'lgtm', evalStaleness: 'hash_reconverged', unsatisfiedAgentAc: true,
  });
  assert.equal(r.tier, 'HOLD');
  assert.ok(!r.reasons.some((x) => /hash/i.test(x)), `hash 由来 reason を含むべきでないが: ${JSON.stringify(r.reasons)}`);
});

test('classifyMergeTier: evalStaleness:"bogus"(out-of-enum) → throw', () => {
  assert.throws(() => classifyMergeTier(baseCleanInput({ evalStaleness: 'bogus' })),
    /invalid evalStaleness/);
});

test('classifyMergeTier: evalStaleness:undefined/null → throw しない(従来どおり)', () => {
  const rUndefined = classifyMergeTier({ ...autoBase(), iterateStatus: 'lgtm' });
  assert.equal(rUndefined.tier, 'AUTO');

  const rNull = classifyMergeTier({ ...autoBase(), iterateStatus: 'lgtm', evalStaleness: null });
  assert.equal(rNull.tier, 'AUTO');
});

// ---- issue #658: HOLD_REASON_CODES + holdReasons[].code + disclosures ----

test('HOLD_REASON_CODES は 21 の閉じた enum と一致', () => {
  assert.deepEqual(HOLD_REASON_CODES, [
    'ledger_unconverged', 'danger_unresolved', 'breaking_structured', 'escalate',
    'ac_agent_unsatisfied', 'ac_human_pending', 'danger_fail_closed', 'final_reconcile_unavailable', 'final_test_red',
    'final_ac_unavailable', 'iterate_non_lgtm', 'hash_mismatch', 'testsurf_uncleared',
    'mergeable_conflicting', 'pr_closes_missing', 'merge_facts_dropped', 'ci_checks_failed', 'ac_ci_pending',
    'security_review_unresolved', 'validate_test_red', 'validate_tests_not_run',
  ]);
});

test('classifyMergeTier: securityReviewUnresolved:true → HOLD 理由 security_review_unresolved（human_judgment）。boolean 以外は明示 error', () => {
  const r = classifyMergeTier({ ...standardBase(), iterateStatus: 'lgtm', evalStaleness: 'none', securityReviewUnresolved: true });
  assert.equal(r.tier, 'HOLD');
  assert.deepEqual(r.holdReasons.map((x) => [x.code, x.kind]), [['security_review_unresolved', 'human_judgment']]);
  assert.equal(classifyMergeTier({ ...standardBase(), iterateStatus: 'lgtm', evalStaleness: 'none', securityReviewUnresolved: false }).tier, 'REVIEW');
  assert.throws(() => classifyMergeTier({ ...standardBase(), iterateStatus: 'lgtm', securityReviewUnresolved: 'yes' }), /invalid securityReviewUnresolved/);
});

test('classifyMergeTier: holdReasons[].code — escalate', () => {
  const r = classifyMergeTier({ ...standardBase(), iterateStatus: 'lgtm', evalStaleness: 'none', escalateCount: 2 });
  assert.equal(r.tier, 'HOLD');
  const item = r.holdReasons.find((x) => x.reason.includes('ESCALATE-TO-HUMAN'));
  assert.ok(item, `holdReasons に ESCALATE 由来要素を含むべきだが: ${JSON.stringify(r.holdReasons)}`);
  assert.equal(item.code, 'escalate');
  assert.ok(HOLD_REASON_CODES.includes(item.code));
});

test('classifyMergeTier: holdReasons[].code — ledger_unconverged', () => {
  const r = classifyMergeTier({ ...standardBase(), converged: false, iterateStatus: 'lgtm', evalStaleness: 'none' });
  assert.equal(r.tier, 'HOLD');
  const item = r.holdReasons.find((x) => x.reason.includes('収束'));
  assert.ok(item);
  assert.equal(item.code, 'ledger_unconverged');
  assert.ok(HOLD_REASON_CODES.includes(item.code));
});

test('classifyMergeTier: holdReasons[].code — ac_agent_unsatisfied', () => {
  const r = classifyMergeTier({ ...standardBase(), iterateStatus: 'lgtm', evalStaleness: 'none', unsatisfiedAgentAc: true });
  assert.equal(r.tier, 'HOLD');
  const item = r.holdReasons.find((x) => x.reason.includes('AC 未達'));
  assert.ok(item);
  assert.equal(item.code, 'ac_agent_unsatisfied');
  assert.ok(HOLD_REASON_CODES.includes(item.code));
});

test('classifyMergeTier: holdReasons[].code — ac_human_pending', () => {
  const r = classifyMergeTier({ ...standardBase(), iterateStatus: 'lgtm', evalStaleness: 'none', unsatisfiedHumanAc: true });
  assert.equal(r.tier, 'HOLD');
  const item = r.holdReasons.find((x) => x.reason.includes('AC 未達'));
  assert.ok(item);
  assert.equal(item.code, 'ac_human_pending');
  assert.ok(HOLD_REASON_CODES.includes(item.code));
});

test('classifyMergeTier: holdReasons[].code — final_reconcile_unavailable', () => {
  const r = classifyMergeTier(baseCleanInput({ finalReconcile: 'unavailable' }));
  assert.equal(r.tier, 'HOLD');
  const item = r.holdReasons.find((x) => x.reason.includes('Final reconcile 再検証不能'));
  assert.ok(item);
  assert.equal(item.code, 'final_reconcile_unavailable');
  assert.ok(HOLD_REASON_CODES.includes(item.code));
});

test('classifyMergeTier: holdReasons[].code — iterate_non_lgtm', () => {
  const r = classifyMergeTier({ ...autoBase(), iterateStatus: 'stuck', evalStaleness: 'none' });
  assert.equal(r.tier, 'HOLD');
  const item = r.holdReasons.find((x) => x.reason.includes('非LGTM終端'));
  assert.ok(item);
  assert.equal(item.code, 'iterate_non_lgtm');
  assert.ok(HOLD_REASON_CODES.includes(item.code));
});

test('classifyMergeTier: holdReasons[].code — hash_mismatch', () => {
  const r = classifyMergeTier(baseCleanInput({
    evalStaleness: 'hash_mismatch',
    evalDiffHash: 'a'.repeat(40),
    prDiffHash: 'b'.repeat(40),
    staleDiffFiles: [],
  }));
  assert.equal(r.tier, 'HOLD');
  const item = r.holdReasons.find((x) => /hash/i.test(x.reason));
  assert.ok(item);
  assert.equal(item.code, 'hash_mismatch');
  assert.ok(HOLD_REASON_CODES.includes(item.code));
});

test('classifyMergeTier: holdReasons[].code — mergeable_conflicting', () => {
  const r = classifyMergeTier(baseCleanInput({ mergeableState: 'conflicting' }));
  assert.equal(r.tier, 'HOLD');
  const item = r.holdReasons.find((x) => x.reason.includes('conflict'));
  assert.ok(item);
  assert.equal(item.code, 'mergeable_conflicting');
  assert.ok(HOLD_REASON_CODES.includes(item.code));
});

// ---- issue #661: prClosesStatus / pr_closes_missing ----

test('PR_CLOSES_STATUS_VALUES は 4 の閉じた enum と一致', () => {
  assert.deepEqual(PR_CLOSES_STATUS_VALUES, ['verified', 'reinjected', 'missing', 'unverified']);
});

test('classifyMergeTier: prClosesStatus:"missing" → HOLD、holdReasons に pr_closes_missing（kind=deterministic_recheck）', () => {
  const r = classifyMergeTier({
    ...standardBase(), iterateStatus: 'lgtm', evalStaleness: 'none', prClosesStatus: 'missing',
  });
  assert.equal(r.tier, 'HOLD');
  const item = r.holdReasons.find((x) => x.code === 'pr_closes_missing');
  assert.ok(item, `holdReasons に pr_closes_missing を含むべきだが: ${JSON.stringify(r.holdReasons)}`);
  assert.equal(item.kind, 'deterministic_recheck');
  assert.ok(HOLD_REASON_CODES.includes(item.code));
  // 他に human_judgment 理由が無いため holdKind は deterministic_recheck（aggregateHoldKind 準拠）。
  assert.equal(r.holdKind, 'deterministic_recheck');
});

test('classifyMergeTier: prClosesStatus が verified/reinjected/unverified/undefined → tier・reasons・holdReasons は未指定時と不変', () => {
  const baseline = classifyMergeTier(baseCleanInput({}));
  for (const status of ['verified', 'reinjected', 'unverified', undefined]) {
    const r = classifyMergeTier(baseCleanInput({ prClosesStatus: status }));
    assert.deepEqual(r, baseline, `prClosesStatus=${status} は未指定時と完全一致するべきだが: ${JSON.stringify(r)}`);
  }
});

test('classifyMergeTier: prClosesStatus が out-of-enum → throw', () => {
  assert.throws(() => classifyMergeTier(baseCleanInput({ prClosesStatus: 'bogus' })),
    /invalid prClosesStatus/);
});

test('classifyMergeTier: holdReasons の全要素は {code, reason, kind} のちょうど3キー', () => {
  const r = classifyMergeTier({
    ...standardBase(), converged: false, iterateStatus: 'lgtm', evalStaleness: 'none', unsatisfiedAgentAc: true,
  });
  assert.equal(r.tier, 'HOLD');
  assert.ok(r.holdReasons.length >= 2);
  for (const item of r.holdReasons) {
    assert.deepEqual(Object.keys(item).sort(), ['code', 'kind', 'reason']);
  }
});

// ---- disclosures（issue #658）: 可視化のみ項目は reasons と disclosures 両方に載る ----

test('disclosures: breakingKeyword のみ(keyword-alone) → HOLD/AUTO/REVIEW いずれも disclosures に開示 1 件、reasons 末尾にも同文が残る', () => {
  // HOLD（converged:false + keyword-alone）
  const hold = classifyMergeTier({
    ...standardBase(), converged: false, breakingKeyword: true, iterateStatus: 'lgtm', evalStaleness: 'none',
  });
  assert.equal(hold.tier, 'HOLD');
  assert.equal(hold.disclosures.length, 1);
  assert.ok(hold.disclosures[0].includes('breaking keyword hit'));
  assert.equal(hold.reasons[hold.reasons.length - 1], hold.disclosures[0]);

  // AUTO（micro + docs/test-only + keyword-alone）
  const auto = classifyMergeTier({ ...autoBase(), breakingKeyword: true, iterateStatus: 'lgtm', evalStaleness: 'none' });
  assert.equal(auto.tier, 'AUTO');
  assert.equal(auto.disclosures.length, 1);
  assert.ok(auto.disclosures[0].includes('breaking keyword hit'));
  assert.equal(auto.reasons[auto.reasons.length - 1], auto.disclosures[0]);

  // REVIEW（standard + keyword-alone）
  const review = classifyMergeTier({ ...standardBase(), breakingKeyword: true, iterateStatus: 'lgtm', evalStaleness: 'none' });
  assert.equal(review.tier, 'REVIEW');
  assert.equal(review.disclosures.length, 1);
  assert.ok(review.disclosures[0].includes('breaking keyword hit'));
  assert.equal(review.reasons[review.reasons.length - 1], review.disclosures[0]);
});

test('disclosures: evalVerdictFail:true → HOLD/AUTO/REVIEW いずれも disclosures に開示 1 件、reasons 末尾にも同文が残る', () => {
  const hold = classifyMergeTier({
    ...standardBase(), unsatisfiedAgentAc: true, evalVerdictFail: true, iterateStatus: 'lgtm', evalStaleness: 'none',
  });
  assert.equal(hold.tier, 'HOLD');
  assert.equal(hold.disclosures.length, 1);
  assert.ok(hold.disclosures[0].includes('evaluator verdict=fail'));
  assert.equal(hold.reasons[hold.reasons.length - 1], hold.disclosures[0]);

  const auto = classifyMergeTier({ ...autoBase(), evalVerdictFail: true, iterateStatus: 'lgtm', evalStaleness: 'none' });
  assert.equal(auto.tier, 'AUTO');
  assert.equal(auto.disclosures.length, 1);
  assert.ok(auto.disclosures[0].includes('evaluator verdict=fail'));
  assert.equal(auto.reasons[auto.reasons.length - 1], auto.disclosures[0]);

  const review = classifyMergeTier({ ...standardBase(), evalVerdictFail: true, iterateStatus: 'lgtm', evalStaleness: 'none' });
  assert.equal(review.tier, 'REVIEW');
  assert.equal(review.disclosures.length, 1);
  assert.ok(review.disclosures[0].includes('evaluator verdict=fail'));
  assert.equal(review.reasons[review.reasons.length - 1], review.disclosures[0]);
});

test('disclosures: 開示ゼロなら disclosures は []（HOLD/AUTO/REVIEW とも）', () => {
  const hold = classifyMergeTier({ ...standardBase(), unsatisfiedAgentAc: true, iterateStatus: 'lgtm', evalStaleness: 'none' });
  assert.equal(hold.tier, 'HOLD');
  assert.deepEqual(hold.disclosures, []);

  const auto = classifyMergeTier({ ...autoBase(), iterateStatus: 'lgtm', evalStaleness: 'none' });
  assert.equal(auto.tier, 'AUTO');
  assert.deepEqual(auto.disclosures, []);

  const review = classifyMergeTier({ ...standardBase(), iterateStatus: 'lgtm', evalStaleness: 'none' });
  assert.equal(review.tier, 'REVIEW');
  assert.deepEqual(review.disclosures, []);
});

// ---- issue #834: CI checks の fail を Merge tier が HOLD にする（ci_checks_failed） ----

// merge-tier-facts の stdout（checks サブ結果）→ parseMergeTierFacts → facts.checks を classifyMergeTier に渡す実経路と同じ形。
function factsChecks(checks) {
  return parseMergeTierFacts({ checks: checks === null ? { ok: false, error: 'checks data not provided' } : { ok: true, value: { checks } } }).checks;
}

test('classifyCiChecks: bucket を check-ci と同じ規則で分類する（fail / cancel / 未知値は failed、pending は pending）', () => {
  assert.equal(classifyCiChecks(factsChecks([{ name: 'a', bucket: 'pass' }, { name: 'b', bucket: 'skipping' }])).state, 'passed');
  assert.equal(classifyCiChecks(factsChecks([])).state, 'no_checks');
  assert.equal(classifyCiChecks(factsChecks([{ name: 'a', bucket: 'pass' }, { name: 'b', bucket: 'pending' }])).state, 'pending');
  for (const bucket of ['fail', 'cancel', 'weird', undefined]) {
    const r = classifyCiChecks(factsChecks([{ name: 'ok', bucket: 'pass' }, { name: 'x', bucket: 'pending' }, { name: 'bad', bucket }]));
    assert.equal(r.state, 'failed', `bucket=${bucket} は failed（pending より優先）になるべき`);
    assert.deepEqual(r.failedNames, ['bad']);
  }
  assert.equal(classifyCiChecks(factsChecks(null)).state, 'unavailable');
  assert.equal(classifyCiChecks(null).state, 'unavailable');
});

test('classifyMergeTier: checks に fail を含む facts → HOLD、holdReasons に ci_checks_failed（kind=human_judgment）', () => {
  const r = classifyMergeTier(baseCleanInput({
    ciChecks: factsChecks([{ name: 'Bats Tests', bucket: 'fail' }, { name: 'Vitest', bucket: 'pass' }]),
  }));
  assert.equal(r.tier, 'HOLD');
  const item = r.holdReasons.find((x) => x.code === 'ci_checks_failed');
  assert.ok(item, `holdReasons に ci_checks_failed を含むべきだが: ${JSON.stringify(r.holdReasons)}`);
  assert.equal(item.kind, 'human_judgment');
  assert.ok(item.reason.includes('Bats Tests'), item.reason);
  assert.ok(!item.reason.includes('Vitest'), 'pass の check 名は載せない');
  assert.equal(r.holdKind, 'human_judgment');
});

test('classifyMergeTier: cancel / 既知 5 値以外の bucket も ci_checks_failed で HOLD', () => {
  for (const bucket of ['cancel', 'stale']) {
    const r = classifyMergeTier(baseCleanInput({ ciChecks: factsChecks([{ name: 'build', bucket }]) }));
    assert.equal(r.tier, 'HOLD', `bucket=${bucket}`);
    assert.ok(r.holdReasons.some((x) => x.code === 'ci_checks_failed'), `bucket=${bucket}: ${JSON.stringify(r.holdReasons)}`);
  }
});

test('classifyMergeTier: ci_checks_failed は AUTO 適格（micro + docs/test-only）でも HOLD（軸A 不変）', () => {
  const r = classifyMergeTier({ ...autoBase(), iterateStatus: 'lgtm', evalStaleness: 'none', ciChecks: factsChecks([{ name: 'bats', bucket: 'fail' }]) });
  assert.equal(r.tier, 'HOLD');
  assert.ok(r.holdReasons.some((x) => x.code === 'ci_checks_failed'));
});

test('classifyMergeTier: checks が全 pass / no_checks なら HOLD にならず、未指定時と完全一致', () => {
  const baseline = classifyMergeTier(baseCleanInput({}));
  for (const checks of [[{ name: 'a', bucket: 'pass' }, { name: 'b', bucket: 'skipping' }], []]) {
    const r = classifyMergeTier(baseCleanInput({ ciChecks: factsChecks(checks) }));
    assert.deepEqual(r, baseline, `checks=${JSON.stringify(checks)}: ${JSON.stringify(r)}`);
  }
});

test('classifyMergeTier: checks が pending / 取得失敗なら HOLD にせず「CI 未完了」を disclosures に出す（fail-open）', () => {
  const pending = classifyMergeTier(baseCleanInput({ ciChecks: factsChecks([{ name: 'a', bucket: 'pass' }, { name: 'Bats Tests', bucket: 'pending' }]) }));
  assert.equal(pending.tier, 'REVIEW');
  assert.deepEqual(pending.holdReasons, []);
  assert.equal(pending.disclosures.length, 1);
  assert.ok(pending.disclosures[0].startsWith('CI 未完了'), pending.disclosures[0]);
  assert.ok(pending.disclosures[0].includes('Bats Tests'));

  const unavailable = classifyMergeTier(baseCleanInput({ ciChecks: factsChecks(null) }));
  assert.equal(unavailable.tier, 'REVIEW');
  assert.deepEqual(unavailable.holdReasons, []);
  assert.equal(unavailable.disclosures.length, 1);
  assert.ok(unavailable.disclosures[0].startsWith('CI 未完了'), unavailable.disclosures[0]);

  // AUTO 適格でも tier は変えない（開示のみ）
  const auto = classifyMergeTier({ ...autoBase(), iterateStatus: 'lgtm', evalStaleness: 'none', ciChecks: factsChecks(null) });
  assert.equal(auto.tier, 'AUTO');
  assert.ok(auto.disclosures.some((d) => d.startsWith('CI 未完了')));
});

test('classifyMergeTier: mergeStateStatus=UNSTABLE 単独では HOLD にしない（判定は checks の bucket だけ）', () => {
  const mergeableState = classifyMergeableState({ ok: true, mergeable: 'MERGEABLE', mergeStateStatus: 'UNSTABLE' });
  const r = classifyMergeTier(baseCleanInput({ mergeableState, ciChecks: factsChecks([{ name: 'a', bucket: 'pass' }]) }));
  assert.equal(r.tier, 'REVIEW');
  assert.deepEqual(r.holdReasons, []);
});

test('classifyMergeTier: ciChecks の契約外形状は明示 error', () => {
  assert.throws(() => classifyMergeTier(baseCleanInput({ ciChecks: 'failed' })), /invalid ciChecks/);
  assert.throws(() => classifyMergeTier(baseCleanInput({ ciChecks: { checks: [] } })), /invalid ciChecks/);
  assert.throws(() => classifyMergeTier(baseCleanInput({ ciChecks: { ok: true } })), /invalid ciChecks/);
});

// ---- finalTestFlaky（test#final の単体再実行が green、issue #865）----

const FLAKY = { files: ['plugins/x/a.bats'], logs: ['/tmp/run-tests-abc/0.log'] };

test('classifyMergeTier: finalTestFlaky は HOLD にせず、落ちたファイルと 1 回目のログを開示行に出す', () => {
  const r = classifyMergeTier(baseCleanInput({ finalReconcile: 'reverified', finalTestGreen: true, finalTestFlaky: FLAKY }));
  assert.equal(r.tier, 'REVIEW');
  assert.deepEqual(r.holdReasons, []);
  assert.equal(r.disclosures.length, 1);
  assert.ok(r.disclosures[0].startsWith('final test flake（単体再実行で green）'), r.disclosures[0]);
  assert.ok(r.disclosures[0].includes('plugins/x/a.bats') && r.disclosures[0].includes('/tmp/run-tests-abc/0.log'), r.disclosures[0]);
  assert.ok(r.reasons.includes(r.disclosures[0]));

  // 他の理由で HOLD の run でも final_test_red は積まず、開示行は reasons に残る
  const hold = classifyMergeTier(baseCleanInput({ finalReconcile: 'reverified', finalTestGreen: true, finalTestFlaky: FLAKY, iterateStatus: 'stuck' }));
  assert.equal(hold.tier, 'HOLD');
  assert.ok(!hold.holdReasons.some((x) => x.code === 'final_test_red'), JSON.stringify(hold.holdReasons));
  assert.ok(hold.reasons.some((x) => x.startsWith('final test flake')));
});

test('classifyMergeTier: finalTestFlaky の契約外形状・red のままの flake は明示 error', () => {
  const green = { finalReconcile: 'reverified', finalTestGreen: true };
  assert.throws(() => classifyMergeTier(baseCleanInput({ ...green, finalTestFlaky: { files: [], logs: [] } })), /invalid finalTestFlaky/);
  assert.throws(() => classifyMergeTier(baseCleanInput({ ...green, finalTestFlaky: { files: ['a.bats'] } })), /invalid finalTestFlaky/);
  assert.throws(() => classifyMergeTier(baseCleanInput({ finalReconcile: 'reverified', finalTestGreen: false, finalTestFlaky: FLAKY })), /requires finalTestGreen===true/);
});

// ---- validateResult（Final reconcile skipped の run の Validate red、issue #1086）----

const VALIDATE_RED = { tests: 'failed', green: false, summary: 'assert mismatch', failed_files: ['a.bats'] };
const codesOf = (r) => r.holdReasons.map((x) => x.code);

test('classifyMergeTier: finalReconcile skipped + Validate red（tests:failed / green:false）→ HOLD 理由 validate_test_red（human_judgment）', () => {
  for (const base of [baseCleanInput({}), { ...autoBase(), iterateStatus: 'lgtm', evalStaleness: 'none' }]) {
    const r = classifyMergeTier({ ...base, finalReconcile: 'skipped', validateResult: VALIDATE_RED });
    assert.equal(r.tier, 'HOLD', JSON.stringify(r));
    assert.deepEqual(r.holdReasons.map((x) => [x.code, x.kind]), [['validate_test_red', 'human_judgment']]);
    assert.equal(r.holdKind, 'human_judgment');
    assert.ok(r.reasons[0].startsWith('Validate test red'), r.reasons[0]);
  }
  // 他の HOLD 理由と並んでも積まれる
  const both = classifyMergeTier(baseCleanInput({ finalReconcile: 'skipped', validateResult: VALIDATE_RED, iterateStatus: 'stuck' }));
  assert.deepEqual(codesOf(both), ['validate_test_red', 'iterate_non_lgtm']);
});

test('classifyMergeTier: finalReconcile skipped で Validate が green / no_tests なら validate_test_red を出さず、未指定時と完全一致', () => {
  const cases = [
    ['REVIEW', baseCleanInput({ finalReconcile: 'skipped' })],
    ['AUTO', { ...autoBase(), iterateStatus: 'lgtm', evalStaleness: 'none', finalReconcile: 'skipped' }],
    ['HOLD（既存理由）', baseCleanInput({ finalReconcile: 'skipped', iterateStatus: 'stuck', unsatisfiedHumanAc: true })],
  ];
  const validates = [
    { tests: 'passed', green: true },
    // base でも落ちる既存失敗だけの red は Validate が green:true にして抜ける
    { tests: 'failed', green: true },
    { tests: 'no_tests', green: false },
  ];
  for (const [name, input] of cases) {
    const baseline = classifyMergeTier(input);
    for (const v of validates) {
      const r = classifyMergeTier({ ...input, validateResult: v });
      assert.deepEqual(r, baseline, `${name} / ${JSON.stringify(v)}`);
      assert.ok(!codesOf(r).includes('validate_test_red'));
    }
  }
  assert.equal(classifyMergeTier(cases[0][1]).tier, 'REVIEW');
  assert.equal(classifyMergeTier(cases[1][1]).tier, 'AUTO');
  assert.deepEqual(codesOf(classifyMergeTier(cases[2][1])), ['ac_human_pending', 'iterate_non_lgtm']);
});

test('classifyMergeTier: finalReconcile が reverified / unavailable なら Validate red でも validate_test_red を出さない（最終 tree の判定に任せる）', () => {
  const cases = [
    [{ finalReconcile: 'reverified', finalTestGreen: true }, []],
    [{ finalReconcile: 'reverified', finalTestGreen: false }, ['final_test_red']],
    [{ finalReconcile: 'unavailable' }, ['final_reconcile_unavailable']],
  ];
  for (const [fr, wantCodes] of cases) {
    const baseline = classifyMergeTier(baseCleanInput(fr));
    const r = classifyMergeTier(baseCleanInput({ ...fr, validateResult: VALIDATE_RED }));
    assert.deepEqual(r, baseline, JSON.stringify(fr));
    assert.deepEqual(codesOf(r), wantCodes, JSON.stringify(fr));
  }
});

test('classifyMergeTier: validateResult の契約外形状は明示 error', () => {
  for (const v of ['failed', { tests: 'failed' }, { tests: 'red', green: false }, { tests: 'failed', green: 'false' }]) {
    assert.throws(() => classifyMergeTier(baseCleanInput({ finalReconcile: 'skipped', validateResult: v })), /invalid validateResult/, JSON.stringify(v));
  }
});

// ---- validate_tests_not_run（Final reconcile skipped + Validate tests:error の run、issue #1117 / #1168）----

const VALIDATE_ERROR = { tests: 'error', green: false, summary: 'pnpm install failed — テストは 1 件も実行されていない' };
const DEPS_FAILED = { ok: false, note: 'pnpm install failed: EPERM .gitmodules' };

test('classifyMergeTier: finalReconcile skipped + Validate tests:error は CI の success の形をした入力があっても常に validate_tests_not_run（human_judgment）を 1 件積む', () => {
  for (const extra of [{}, { validateCi: CI_SUCCESS_LIKE }, { validateCi: CI_SUCCESS_LIKE, finalCi: CI_SUCCESS_LIKE }]) {
    for (const base of [baseCleanInput({}), { ...autoBase(), iterateStatus: 'lgtm', evalStaleness: 'none' }]) {
      const r = classifyMergeTier({ ...base, finalReconcile: 'skipped', validateResult: VALIDATE_ERROR, setupDeps: DEPS_FAILED, ...extra });
      assert.equal(r.tier, 'HOLD', `${JSON.stringify(extra)}: ${JSON.stringify(r)}`);
      assert.deepEqual(r.holdReasons.map((x) => [x.code, x.kind]), [['validate_tests_not_run', 'human_judgment']], JSON.stringify(extra));
      assert.ok(r.reasons[0].endsWith('— 人間確認必須'), r.reasons[0]);
      assert.equal(r.holdKind, 'human_judgment');
    }
  }
  // 他の HOLD 理由と並んでも積まれる
  const both = classifyMergeTier(baseCleanInput({ finalReconcile: 'skipped', validateResult: VALIDATE_ERROR, iterateStatus: 'stuck' }));
  assert.deepEqual(codesOf(both), ['validate_tests_not_run', 'iterate_non_lgtm']);
});

test('classifyMergeTier: validate_tests_not_run の文言は「テストが 1 件も実行されていない」で始まり、Setup(deps) が ok:false の run だけ note を含む', () => {
  const reasonOf = (setupDeps) => classifyMergeTier(baseCleanInput({ finalReconcile: 'skipped', validateResult: VALIDATE_ERROR, setupDeps }))
    .holdReasons.find((x) => x.code === 'validate_tests_not_run').reason;
  const failed = reasonOf(DEPS_FAILED);
  assert.ok(failed.startsWith('テストが 1 件も実行されていない'), failed);
  assert.ok(failed.includes('Setup(deps) ok:false: pnpm install failed: EPERM .gitmodules'), failed);
  assert.ok(reasonOf({ ok: false, note: '' }).includes('Setup(deps) ok:false: 依存インストール結果を確認できなかった'));
  for (const setupDeps of [{ ok: true, note: 'pnpm install 完了' }, undefined]) {
    const r = reasonOf(setupDeps);
    assert.ok(r.startsWith('テストが 1 件も実行されていない'), r);
    assert.ok(!r.includes('Setup(deps)'), r);
  }
});

test('classifyMergeTier: finalReconcile が skipped 以外 / Validate tests が error 以外なら setupDeps を見ず、未指定時と完全一致', () => {
  const inputs = [
    baseCleanInput({ finalReconcile: 'reverified', finalTestGreen: true, validateResult: VALIDATE_ERROR }),
    baseCleanInput({ finalReconcile: 'reverified', finalTestGreen: false, validateResult: VALIDATE_ERROR }),
    baseCleanInput({ finalReconcile: 'unavailable', validateResult: VALIDATE_ERROR }),
    baseCleanInput({ validateResult: VALIDATE_ERROR }),
    baseCleanInput({ finalReconcile: 'skipped', validateResult: { tests: 'passed', green: true } }),
    baseCleanInput({ finalReconcile: 'skipped', validateResult: { tests: 'no_tests', green: false } }),
    baseCleanInput({ finalReconcile: 'skipped', validateResult: VALIDATE_RED }),
    baseCleanInput({ finalReconcile: 'skipped' }),
  ];
  for (const input of inputs) {
    const baseline = classifyMergeTier(input);
    const r = classifyMergeTier({ ...input, setupDeps: DEPS_FAILED });
    assert.deepEqual(r, baseline, JSON.stringify(input));
    assert.ok(!codesOf(r).includes('validate_tests_not_run'), JSON.stringify(input));
  }
});

test('classifyMergeTier: setupDeps の契約外形状は明示 error', () => {
  const base = { finalReconcile: 'skipped', validateResult: VALIDATE_ERROR };
  for (const setupDeps of [{ ok: 'false', note: '' }, { ok: false }, { note: 'x' }]) {
    assert.throws(() => classifyMergeTier(baseCleanInput({ ...base, setupDeps })), /invalid setupDeps/, JSON.stringify(setupDeps));
  }
});

// ---- finalAcReconcile（Final AC reconcile phase, issue #331/F2）----
// s.finalAcReconcile（optional 'skipped'|'reverified'|'unavailable'）の enum 検証と、'unavailable' 時の HOLD reason 追加。
// 'reverified'/'skipped'/未指定は既存挙動（tier・reasons）を変えない。

const finalAcStandard = () => ({ ...standardBase(), iterateStatus: 'lgtm', evalStaleness: 'none' });
const finalAcAuto = () => ({ ...autoBase(), iterateStatus: 'lgtm', evalStaleness: 'none' });

test.each([
  ['REVIEW 相当条件', finalAcStandard],
  ['AUTO 相当条件（micro+docs/test-only。決定論 HOLD が AUTO に勝つ）', finalAcAuto],
])('classifyMergeTier: finalAcReconcile:"unavailable"（%s）→ tier===HOLD かつ reasons に "Final AC reconcile 判定不能" を含む', (_name, base) => {
  const r = classifyMergeTier({ ...base(), finalAcReconcile: 'unavailable' });
  assert.equal(r.tier, 'HOLD');
  assert.ok(
    r.reasons.some((x) => x.includes('Final AC reconcile 判定不能')),
    `reasons に 'Final AC reconcile 判定不能' を含むべきだが: ${JSON.stringify(r.reasons)}`,
  );
});

test.each([['reverified'], ['skipped'], [undefined]])('classifyMergeTier: finalAcReconcile:%s → REVIEW 相当条件の tier・reasons が未指定と同一（"Final AC reconcile" 文言なし）', (value) => {
  const withoutFlag = classifyMergeTier(finalAcStandard());
  const input = finalAcStandard();
  if (value !== undefined) input.finalAcReconcile = value;
  const r = classifyMergeTier(input);
  assert.equal(withoutFlag.tier, 'REVIEW');
  assert.equal(r.tier, withoutFlag.tier);
  assert.deepEqual(r.reasons, withoutFlag.reasons);
  assert.ok(!r.reasons.some((x) => /Final AC reconcile/.test(x)));
});

test('classifyMergeTier: finalAcReconcile:"stale"(out-of-enum) → throw with "invalid finalAcReconcile"', () => {
  assert.throws(
    () => classifyMergeTier({ ...finalAcStandard(), finalAcReconcile: 'stale' }),
    /invalid finalAcReconcile/,
  );
});
