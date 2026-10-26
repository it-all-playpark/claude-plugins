// Issue #746: merge-tier-facts の haiku 転記で各サブ結果の value が落ち、偽の danger_fail_closed で HOLD になる。
//
// (1) MERGE_FACTS schema はサブ結果ごとに value を required にし、value の中身にも required を与える
//     — value 欠落を StructuredOutput の schema 契約違反として検知させる（retryOnContractViolation の対象）。
// (2) 再試行しても value が得られない場合、HOLD reason は danger_fail_closed（danger-grep 実行不能）ではなく
//     merge_facts_dropped（merge-tier-facts の転記欠落）で出る。
// (3) PR body の danger-grep 行は Diff triage の hit を {class, file} 単位で出し、`unknown: \`?\`` を出さない。
//
// harness は共有 vm-sandbox.mjs（makeDevFlowSandbox/runWorkflowCapture）。VM 内の既定値は WT='/tmp/wt'。
//
// Run: npx vitest run _lib/merge-facts-value-contract-routing.test.mjs

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash, mergeTierFacts, STANDARD_FILES } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const devFlowSrc = readFileSync(join(here, '..', '.claude', 'workflows', 'dev-flow.js'), 'utf8');

// acme/webapp#103 の run で StructuredOutput に渡った実測形（6 サブ結果すべてで value が落ちている）。
const DROPPED = {
  changed: { ok: true }, checks: { ok: true }, diffhash: { ok: true },
  head_tree: { ok: true }, pr: { ok: true }, risk: { ok: true }, epoch: 1790000000,
};

// 最小 JSON-schema チェッカ: type / required / properties(再帰) / items のみ。required / properties は
// JSON Schema と同じく object のときだけ効く（ok:false の value:null を通すため）。
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
  const isObj = value !== null && typeof value === 'object' && !Array.isArray(value);
  if (schema.required && isObj) {
    for (const key of schema.required) {
      if (!(key in value)) return { ok: false, error: `${path}: missing ${key}` };
    }
  }
  if (schema.properties && isObj) {
    for (const key of Object.keys(schema.properties)) {
      if (key in value) {
        const res = checkSchema(schema.properties[key], value[key], `${path}.${key}`);
        if (!res.ok) return res;
      }
    }
  }
  if (schema.items && Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const res = checkSchema(schema.items, value[i], `${path}[${i}]`);
      if (!res.ok) return res;
    }
  }
  return { ok: true };
}

async function run(overrides = {}) {
  const { ctx, calls, logs } = makeDevFlowSandbox({ overrides });
  const { result, error } = await runWorkflowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'merge-facts-value-contract');
  assert.equal(error, null, `dev-flow run が throw した: ${error?.message}`);
  return { result, calls, logs };
}

async function mergeFactsSchema() {
  const { calls } = await run();
  const call = calls.find((c) => c.label === 'merge-tier-facts');
  assert.ok(call, "既定 run に label 'merge-tier-facts' の呼び出しが見つからない");
  return { call, schema: JSON.parse(JSON.stringify(call.opts.schema)) };
}

// ============================================================
// AC-1: value 欠落は schema 契約違反になり、retryOnContractViolation の対象になる
// ============================================================

test('[merge-facts-value][AC-1] value が落ちた実測応答は MERGE_FACTS schema 違反になる', async () => {
  const { call, schema } = await mergeFactsSchema();
  assert.equal(call.opts.retryOnContractViolation, true);

  const dropped = checkSchema(schema, DROPPED);
  assert.equal(dropped.ok, false, 'value 欠落が schema を通ってしまう');
  assert.match(dropped.error, /missing value/);

  // サブ結果 1 つだけ value が落ちても違反になる
  for (const key of ['diffhash', 'risk', 'changed', 'pr', 'head_tree', 'checks']) {
    const facts = mergeTierFacts();
    delete facts[key].value;
    assert.equal(checkSchema(schema, facts).ok, false, `${key}.value 欠落が schema を通ってしまう`);
  }

  // value の中身が空 object 化されても違反になる
  const emptyRisk = { ...mergeTierFacts(), risk: { ok: true, value: {} } };
  assert.equal(checkSchema(schema, emptyRisk).ok, false, 'risk.value={} が schema を通ってしまう');
  const riskNoHits = { ...mergeTierFacts(), risk: { ok: true, value: { ok: true } } };
  assert.equal(checkSchema(schema, riskNoHits).ok, false, 'risk.value.hits 欠落が schema を通ってしまう');
});

test('[merge-facts-value][AC-1] スクリプトが出す正常形・ok:false 形・prompt の失敗時 fallback 形は schema を通る', async () => {
  const { schema } = await mergeFactsSchema();
  assert.deepEqual(schema.required, ['risk'], 'top-level required は fail-closed の risk のみ（他は fail-open のまま）');

  assert.equal(checkSchema(schema, mergeTierFacts({ checks: [{ name: 'build', bucket: 'pass' }] })).ok, true);
  // merge-tier-facts.sh の emit_degrade / err_result は ok:false + value:null
  const degraded = {};
  for (const key of ['diffhash', 'risk', 'changed', 'pr', 'head_tree', 'checks']) degraded[key] = { ok: false, value: null, error: 'jq_not_installed' };
  assert.equal(checkSchema(schema, { ...degraded, epoch: 1 }).ok, true);
  // mergeTierFactsPrompt の手順 3 失敗時 fallback
  assert.equal(checkSchema(schema, { risk: { ok: false, value: null, error: 'x' } }).ok, true);
  // pr の値欠落は null で出る（スクリプトの `// null`）
  assert.equal(checkSchema(schema, mergeTierFacts({ pr: { mergeable: null, mergeStateStatus: null, headRefOid: null } })).ok, true);
});

test('[merge-facts-value][AC-1] StructuredOutput 契約違反で 1 回目が失敗 → 同一 prompt で再試行し、2 回目の正常応答で fail-closed にならない', async () => {
  let n = 0;
  const { result, calls } = await run({
    'merge-tier-facts': () => {
      n += 1;
      if (n === 1) throw new Error('Agent completed without calling StructuredOutput');
      return mergeTierFacts({ hash: 'BBB' });
    },
  });
  const mf = calls.filter((c) => c.label === 'merge-tier-facts');
  assert.equal(mf.length, 2, '契約違反時は 1 回だけ再試行する');
  assert.equal(mf[0].prompt, mf[1].prompt);
  assert.equal(result.danger_fail_closed, false);
  assert.ok(!(result.merge_tier_hold_reasons ?? []).some((r) => r.code === 'danger_fail_closed' || r.code === 'merge_facts_dropped'));
});

// ============================================================
// AC-2: 再試行しても value が得られない → fail-closed 理由は「merge-tier-facts の転記欠落」
// ============================================================

test('[merge-facts-value][AC-2] value 欠落応答のまま → HOLD reason は merge_facts_dropped、danger-grep 実行不能 とは書かない', async () => {
  const { result, logs } = await run({ 'merge-tier-facts': () => ({ ...DROPPED }) });
  assert.equal(result.merge_tier, 'HOLD');
  assert.equal(result.danger_fail_closed, true, 'security 未検証なので fail-closed（HOLD）は維持する');
  const codes = (result.merge_tier_hold_reasons ?? []).map((r) => r.code);
  assert.ok(codes.includes('merge_facts_dropped'), `merge_facts_dropped が無い: ${JSON.stringify(codes)}`);
  assert.ok(!codes.includes('danger_fail_closed'), `danger_fail_closed が残っている: ${JSON.stringify(codes)}`);
  const dropped = result.merge_tier_hold_reasons.find((r) => r.code === 'merge_facts_dropped');
  assert.match(dropped.reason, /merge-tier-facts の転記欠落/);
  assert.ok(!(result.merge_tier_reasons ?? []).some((r) => r.includes('danger-grep 実行不能')), `merge_tier_reasons: ${JSON.stringify(result.merge_tier_reasons)}`);
  assert.ok(logs.some((l) => l.includes('転記欠落')), 'log に転記欠落の診断が出ない');
});

// 実行時の経路: value 欠落は schema 違反 → StructuredOutput 未返却の throw になり、再試行後も続くと
// trackedAgent が throw を伝播して mergeFacts=null になる。この場合も転記欠落として区別する。
test('[merge-facts-value][AC-2] StructuredOutput 契約違反が再試行後も続く → HOLD reason は merge_facts_dropped', async () => {
  let n = 0;
  const { result, calls, logs } = await run({
    'merge-tier-facts': () => {
      n += 1;
      throw new Error('Agent completed without calling StructuredOutput');
    },
  });
  assert.equal(calls.filter((c) => c.label === 'merge-tier-facts').length, 2, '契約違反時は 1 回だけ再試行する');
  assert.equal(n, 2);
  assert.equal(result.merge_tier, 'HOLD');
  assert.equal(result.danger_fail_closed, true, 'security 未検証なので fail-closed（HOLD）は維持する');
  const codes = (result.merge_tier_hold_reasons ?? []).map((r) => r.code);
  assert.ok(codes.includes('merge_facts_dropped'), `merge_facts_dropped が無い: ${JSON.stringify(codes)}`);
  assert.ok(!codes.includes('danger_fail_closed'), `danger_fail_closed が残っている: ${JSON.stringify(codes)}`);
  assert.ok(!(result.merge_tier_reasons ?? []).some((r) => r.includes('danger-grep 実行不能')), `merge_tier_reasons: ${JSON.stringify(result.merge_tier_reasons)}`);
  assert.ok(logs.some((l) => l.includes('再試行後も StructuredOutput 契約違反')), 'log に契約違反の診断が出ない');
});

test('[merge-facts-value][AC-2] 契約違反以外の例外で facts=null → 従来どおり danger_fail_closed', async () => {
  const { result } = await run({
    'merge-tier-facts': () => { throw new Error('isolation guard denied'); },
  });
  assert.equal(result.merge_tier, 'HOLD');
  const codes = (result.merge_tier_hold_reasons ?? []).map((r) => r.code);
  assert.ok(codes.includes('danger_fail_closed'), `danger_fail_closed が無い: ${JSON.stringify(codes)}`);
  assert.ok(!codes.includes('merge_facts_dropped'));
});

test('[merge-facts-value][AC-2] スクリプト自身が risk ok:false を報告した場合は従来どおり danger_fail_closed', async () => {
  const { result } = await run({ 'merge-tier-facts': () => mergeTierFacts({ hash: null, risk: null }) });
  assert.equal(result.merge_tier, 'HOLD');
  const codes = (result.merge_tier_hold_reasons ?? []).map((r) => r.code);
  assert.ok(codes.includes('danger_fail_closed'), `danger_fail_closed が無い: ${JSON.stringify(codes)}`);
  assert.ok(!codes.includes('merge_facts_dropped'));
});

// ============================================================
// AC-3: PR 本文の danger-grep 行に `unknown: \`?\`` を出さない
// ============================================================

test('[merge-facts-value][AC-3] Diff triage の hit は PR body に class: `file` で出て、unknown: `?` を出さない', async () => {
  const hits = [
    { file: 'src/x.ts', class: 'public-api', severity: 'critical' },
    { file: 'src/y.ts', class: 'auth', severity: 'critical' },
  ];
  const { calls } = await run({
    'danger-grep': { risk: { ok: true, hits }, files: [...STANDARD_FILES], struct: null, diffhash: { hash: 'AAA', empty: false } },
  });
  const prCall = calls.find((c) => c.label === 'pr#1');
  assert.ok(prCall, "label 'pr#1' の呼び出しが見つからない");
  assert.ok(prCall.prompt.includes('- danger-grep: 2 件（public-api: `src/x.ts`、auth: `src/y.ts`）'), `danger-grep 行: ${prCall.prompt}`);
  assert.ok(!prCall.prompt.includes('unknown: `?`'), 'PR body に unknown: `?` が出ている');
  for (const c of calls.filter((x) => x.label === 'ac-checkbox-sync')) {
    assert.ok(!c.prompt.includes('unknown: `?`'), 'ac-checkbox-sync の PR body に unknown: `?` が出ている');
  }
});
