// Issue #617: Diff triage 統合 exec-proxy 呼び出しの schema 契約強化。
//
// (1) DIFF_TRIAGE schema を required:['risk']（risk は ok:boolean / hits:array 必須）に締める
//     — 部分応答ネスト等の契約外形状を StructuredOutput の schema 契約違反として検知できるように
//     する（struct / files / diffhash は引き続き required に含めず fail-open / fail-safe を維持）。
// (2) execDiffTriagePhase の統合呼び出しに retryOnContractViolation:true を付け、契約違反時に
//     trackedAgent の 1 回リトライ機会を与える。
// (3) retry 後も不正形（もしくは throw）なら risk fail-closed に維持され、fail-closed 時は
//     danger-grep call の回数・run の継続・merge_tier HOLD・返り値 danger_fail_closed
//     という「挙動」で検証する（issue #636: ソース regex pin から VM 挙動 pin へ移行）。
//
// harness は共有 vm-sandbox.mjs（makeDevFlowSandbox/runWorkflowCapture）を使う。VM 内の既定値は
// WT='/tmp/wt', BASE='dev'（devFlowResponder の setup-base 既定応答 dev_exists:true による解決）。
//
// Run: npx vitest run _lib/diff-triage-schema-contract-routing.test.mjs
// Full CI: bash tests/run-node-tests.sh --strict

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseDiffTriageFields, isWellFormedRiskField } from './diff-triage.mjs';
import { reconcileDanger, seedSecurityLedger, classifyMergeTier } from './merge-tier.mjs';
import { policyBlockingItems, DEFAULT_GATE_POLICY } from './gate-policy.mjs';
import { makeLedger, appendItem } from './goal-ledger.mjs';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash, mergeTierFacts } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude', 'workflows', 'dev-flow.js');
const devFlowSrc = readFileSync(devFlowPath, 'utf8');

// ---- helpers ----

// 最小 JSON-schema チェッカ: type / required / properties(再帰) のみサポート。
// 入力は VM 実行で観測した danger-grep call の opts.schema（deep clone）— ソース regex 抽出はしない。
function checkSchema(schema, value, path = '$') {
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const matches = types.some((t) => {
      if (t === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
      if (t === 'array') return Array.isArray(value);
      if (t === 'null') return value === null;
      return typeof value === t;
    });
    if (!matches) return { ok: false, error: `${path}: type` };
  }
  if (schema.required) {
    for (const key of schema.required) {
      if (value == null || typeof value !== 'object' || !(key in value)) {
        return { ok: false, error: `${path}: missing ${key}` };
      }
    }
  }
  if (schema.properties) {
    for (const key of Object.keys(schema.properties)) {
      if (value != null && typeof value === 'object' && key in value) {
        const res = checkSchema(schema.properties[key], value[key], `${path}.${key}`);
        if (!res.ok) return res;
      }
    }
  }
  return { ok: true };
}

// 既定 run（override 無し）の danger-grep call を取得する。opts（schema・agentType・
// retryOnContractViolation・prompt）はすべてこの call から読む — ソース抽出はしない。
async function dangerGrepCallFromDefaultRun() {
  const { ctx, calls } = makeDevFlowSandbox({});
  const { error } = await runWorkflowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'default-run');
  const call = calls.find((c) => c.label === 'danger-grep');
  assert.ok(call, "既定 run に label 'danger-grep' の呼び出しが見つからない");
  return call;
}

function cloneSchema(call) {
  return JSON.parse(JSON.stringify(call.opts.schema));
}

// diff-triage-routing.test.mjs の reconcileAndClassify と同じ実装
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

// ============================================================
// AC1: DIFF_TRIAGE schema shape（VM 内で観測した opts.schema の構造）
// ============================================================

test('[diff-triage-schema-contract][AC1] DIFF_TRIAGE requires risk (ok:boolean, hits:array); struct/files/diffhash stay optional', async () => {
  const call = await dangerGrepCallFromDefaultRun();
  const schema = cloneSchema(call);
  assert.deepEqual(schema.required, ['risk']);
  assert.equal(schema.properties.risk.type, 'object');
  assert.deepEqual(schema.properties.risk.required, ['ok', 'hits']);
  assert.equal(schema.properties.risk.properties.ok.type, 'boolean');
  assert.equal(schema.properties.risk.properties.hits.type, 'array');

  assert.ok(!schema.required.includes('files'), 'files が required に含まれてはならない');
  assert.ok(!schema.required.includes('struct'), 'struct が required に含まれてはならない');
  assert.ok(!schema.required.includes('diffhash'), 'diffhash が required に含まれてはならない');
  assert.deepEqual(schema.properties.files.type, ['array', 'null']);
  assert.deepEqual(schema.properties.struct.type, ['object', 'null']);
  assert.deepEqual(schema.properties.diffhash.type, ['object', 'null']);
});

// ============================================================
// AC2: retryOnContractViolation:true on the danger-grep call site
// ============================================================

test("[diff-triage-schema-contract][AC2] label 'danger-grep' call site has retryOnContractViolation:true, agentType dev-runner-haiku-ro, and diff-triage prompt token", async () => {
  const call = await dangerGrepCallFromDefaultRun();
  assert.equal(call.opts.retryOnContractViolation, true);
  assert.equal(call.agentType, 'dev-flow:dev-runner-haiku-ro');
  assert.ok(
    call.prompt.includes('diff-triage /tmp/wt origin/main'),
    `danger-grep prompt に diff-triage の argv token が無い: ${call.prompt}`,
  );
});

// ============================================================
// AC3: nested payload rejected by schema contract（checkSchema は不変ロジック、入力元だけ VM 由来へ）
// ============================================================

test('[diff-triage-schema-contract][AC3] nested {struct:{risk:...}} response fails schema (missing top-level risk)', async () => {
  const call = await dangerGrepCallFromDefaultRun();
  const schema = cloneSchema(call);

  const nested = checkSchema(schema, { struct: { risk: { ok: true, hits: [] } } });
  assert.equal(nested.ok, false);
  assert.match(nested.error, /missing risk/);

  const flat = checkSchema(schema, { risk: { ok: true, hits: [] } });
  assert.equal(flat.ok, true);

  const flatWithNulls = checkSchema(schema, {
    risk: { ok: true, hits: [] }, files: null, struct: null, diffhash: null,
  });
  assert.equal(flatWithNulls.ok, true);

  const missingHits = checkSchema(schema, { risk: { ok: true } });
  assert.equal(missingHits.ok, false);

  const badOkType = checkSchema(schema, { risk: { ok: 'yes', hits: [] } });
  assert.equal(badOkType.ok, false);
});

// ============================================================
// AC4: retry-then-still-invalid keeps risk fail-closed / all SEC seeds unchecked / HOLD
//
// merge_tier=HOLD を実際に成立させるには、Diff triage（label 'danger-grep'）と Merge tier
// （label 'merge-tier-facts' の risk サブ結果）の両方が fail-closed である必要がある — Merge tier は自分の
// tree に対して danger-grep を独立に再判定し、それが clean を返すと ledger は
// reconcile され直して converge してしまう（Diff triage 側の fail-closed は Merge tier の
// 判定に自動継承されない）。したがって merge-tier-facts の risk も一貫して失敗するよう override する。
// ============================================================

test('[diff-triage-schema-contract][AC4] retry after two StructuredOutput throws keeps risk fail-closed and all SEC seeds unchecked / HOLD', async () => {
  const overrides = {
    'danger-grep': () => { throw new Error('Agent completed without calling StructuredOutput'); },
    'merge-tier-facts': () => mergeTierFacts({ risk: { ok: false, hits: [], error: 'boom-final' } }),
  };
  const { ctx, calls } = makeDevFlowSandbox({ overrides });
  const { result, error } = await runWorkflowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'AC4-throw-twice');
  assert.equal(error, null, 'run は abort しない（fail-closed へ倒れて継続する）');

  const dgCalls = calls.filter((c) => c.label === 'danger-grep');
  assert.equal(dgCalls.length, 2, 'retry 機会があるので 2 回呼ばれるはず');

  assert.equal(result.merge_tier, 'HOLD');
  assert.equal(result.danger_fail_closed, true);

  // 純関数レベルでも同じ fail-closed 状態が再現できることを確認する（AC4 の意図: risk fail-closed
  // → 全 SEC seed unchecked → HOLD）
  const { risk } = parseDiffTriageFields(null);
  const { secItems, converged, tier } = reconcileAndClassify(risk);
  assert.ok(secItems.length > 0);
  for (const it of secItems) {
    assert.notEqual(it.checked, true);
    assert.equal(it.fail_closed, true);
  }
  assert.equal(converged, false);
  assert.equal(tier, 'HOLD');
});

test('[diff-triage-schema-contract][AC4] retry after throw then a nested (schema-invalid-shaped) response also keeps risk fail-closed / HOLD', async () => {
  let n = 0;
  const overrides = {
    'danger-grep': () => {
      n += 1;
      if (n === 1) throw new Error('Agent completed without calling StructuredOutput');
      return { struct: { risk: { ok: true, hits: [{ file: 'a', class: 'exec-sink', severity: 'critical' }] } } };
    },
    'merge-tier-facts': () => mergeTierFacts({ risk: { ok: false, hits: [], error: 'boom-final' } }),
  };
  const { ctx, calls } = makeDevFlowSandbox({ overrides });
  const { result, error } = await runWorkflowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'AC4-throw-then-nested');
  assert.equal(error, null);

  const dgCalls = calls.filter((c) => c.label === 'danger-grep');
  assert.equal(dgCalls.length, 2);
  assert.equal(result.merge_tier, 'HOLD');
  assert.equal(result.danger_fail_closed, true);
});

test('[diff-triage-schema-contract][AC4] a well-formed contract failure (ok:false, no StructuredOutput-violation message) is not retried', async () => {
  const overrides = {
    'danger-grep': () => ({ risk: { ok: false, hits: [], error: 'boom' } }),
    'merge-tier-facts': () => mergeTierFacts({ risk: { ok: false, hits: [], error: 'boom-final' } }),
  };
  const { ctx, calls } = makeDevFlowSandbox({ overrides });
  const { result, error } = await runWorkflowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'AC4-contract-ok-false');
  assert.equal(error, null);

  const dgCalls = calls.filter((c) => c.label === 'danger-grep');
  assert.equal(dgCalls.length, 1, '契約通りの ok:false 応答は契約違反ではないため retry されない');
  assert.equal(result.merge_tier, 'HOLD');
  assert.equal(result.danger_fail_closed, true);
});

// ============================================================
// AC5: isWellFormedRiskField / parseDiffTriageFields の risk 採用条件は同一である（fixture 集合による
// 純関数の同値性検証）。加えて、fail-closed 挙動が実際に log へ現れること（label 識別子のみを
// assert し、文言は pin しない）を VM run（上記 AC4 throw-twice ケース）で確認する。
// ============================================================

test('[diff-triage-schema-contract][AC5] isWellFormedRiskField and parseDiffTriageFields(...).risk share the same well-formed / fail-closed-default condition', () => {
  const FAIL_CLOSED_ERROR = 'diff-triage unified proxy unavailable (fail-closed)';
  const fixtures = [
    null,
    {},
    { risk: null },
    { risk: { ok: true } },
    { risk: { ok: true, hits: [] } },
    { risk: { ok: 'yes', hits: [] } },
    { struct: { risk: { ok: true, hits: [] } } },
  ];
  for (const fx of fixtures) {
    const wellFormed = isWellFormedRiskField(fx);
    const { risk } = parseDiffTriageFields(fx);
    const parsedAsFailClosedDefault = risk.ok === false
      && risk.error === FAIL_CLOSED_ERROR
      && Array.isArray(risk.hits) && risk.hits.length === 0;
    assert.equal(
      wellFormed, !parsedAsFailClosedDefault,
      `fixture ${JSON.stringify(fx)}: isWellFormedRiskField=${wellFormed} と parseDiffTriageFields の`
      + ` fail-closed 既定合成状態(${parsedAsFailClosedDefault})が矛盾している`,
    );
  }
});

test('[diff-triage-schema-contract][AC5] fail-closed path is observable in logs by label identifier only (wording not pinned)', async () => {
  const overrides = {
    'danger-grep': () => { throw new Error('Agent completed without calling StructuredOutput'); },
    'merge-tier-facts': () => mergeTierFacts({ risk: { ok: false, hits: [], error: 'boom-final' } }),
  };
  const { ctx, logs } = makeDevFlowSandbox({ overrides });
  const { error } = await runWorkflowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'AC5-log-observability');
  assert.ok(logs.some((l) => l.includes('danger-grep')), 'fail-closed 経路の log に danger-grep 識別子が現れない');
});
