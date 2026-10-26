// Evaluate の redgreen-verify に渡すペアの dedupe・結果の配布・prompt 文言を pin する（issue #822）。
//
// 純関数（_lib/redgreen-targets.mjs）の単体テストに加え、dev-flow.js を VM sandbox で実行して
// 実際に redgreen spawn へ渡る prompt のペア数と、AC ごとの deterministic 昇格 / vdelta deny / inspection 据え置きの
// ログを確かめる（配線が _lib の純関数を経由していることの確認）。
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  redgreenPairKey, buildRedgreenPairs, distributeRedgreenResults, redgreenVerifyPrompt,
} from './redgreen-targets.mjs';
import {
  makeRecordingSandbox, runDevFlowInSandbox, devFlowResponder, analyzeArgs, assertNoCrash,
} from './test-helpers/vm-sandbox.mjs';
import { isRedgreenCall, parseRedgreenPairs } from './test-helpers/redgreen-batch.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const devFlowSrc = readFileSync(join(here, '..', '.claude/workflows/dev-flow.js'), 'utf8');

const target = (acIndex, testFiles, implFiles) => ({
  r: { ac_index: acIndex, satisfied: true, verified_by: 'test', test_files: testFiles, impl_files: implFiles },
  acId: `AC-${acIndex + 1}`,
});

// ---- 純関数 ----

test('[redgreen-targets] redgreenPairKey はファイル列の順序と重複を正規化する', () => {
  assert.equal(redgreenPairKey(['b.bats', 'a.bats'], ['y.py', 'x.py']), redgreenPairKey(['a.bats', 'b.bats', 'a.bats'], ['x.py', 'y.py']));
  assert.notEqual(redgreenPairKey(['a.bats'], ['x.py']), redgreenPairKey(['a.bats'], ['y.py']));
  // test 側と impl 側を入れ替えた組は別ペア
  assert.notEqual(redgreenPairKey(['a'], ['b']), redgreenPairKey(['b'], ['a']));
});

test('[redgreen-targets] 7 AC が同一ペア → redgreen 引数は 1 ペア、7 AC すべてに同じ結果が入る', () => {
  const targets = Array.from({ length: 7 }, (_, i) => (i % 2 === 0
    ? target(i, ['sample_case.bats'], ['sample_case.py'])
    : target(i, ['sample_case.bats', 'sample_case.bats'], ['sample_case.py'])));
  const { pairs, pairIndex } = buildRedgreenPairs(targets);
  assert.deepEqual(pairs, [{ test_files: ['sample_case.bats'], impl_files: ['sample_case.py'] }]);
  assert.deepEqual(pairIndex, [0, 0, 0, 0, 0, 0, 0]);

  const prompt = redgreenVerifyPrompt('/tmp/wt', pairs);
  assert.deepEqual(parseRedgreenPairs(prompt), [{ test_csv: 'sample_case.bats', impl_csv: 'sample_case.py' }]);

  const result = { index: 0, red: true, green: true, reason: 'ok' };
  const dist = distributeRedgreenResults(pairIndex, [result]);
  assert.equal(dist.length, 7);
  for (const rg of dist) assert.deepEqual(rg, result);
});

test('[redgreen-targets] ペアが異なる場合は従来どおり（AC ごとに 1 ペア・引数順・results[k] が k 番目の AC へ）', () => {
  const targets = [
    target(0, ['t0.test.mjs'], ['impl0.mjs']),
    target(1, ['t1.test.mjs', 't1b.test.mjs'], ['impl1.mjs']),
    target(2, ['t2.test.mjs'], ['impl2.mjs', 'impl0.mjs']),
  ];
  const { pairs, pairIndex } = buildRedgreenPairs(targets);
  assert.deepEqual(pairs, targets.map(({ r }) => ({ test_files: r.test_files, impl_files: r.impl_files })));
  assert.deepEqual(pairIndex, [0, 1, 2]);
  // argv は dedupe 前の形（申告順・AC 順）と同じ byte 列
  const prompt = redgreenVerifyPrompt('/tmp/wt', pairs);
  assert.ok(prompt.endsWith("\nredgreen-verify /tmp/wt 't0.test.mjs' 'impl0.mjs' 't1.test.mjs,t1b.test.mjs' 'impl1.mjs' 't2.test.mjs' 'impl2.mjs,impl0.mjs'"), prompt);

  const results = [
    { index: 2, red: false, green: true, reason: 'no red' },
    { index: 0, red: true, green: true },
    { index: 1, red: true, green: false },
  ];
  assert.deepEqual(distributeRedgreenResults(pairIndex, results), [results[1], results[2], results[0]]);
});

test('[redgreen-targets] 一部が同じ組のときは組ごとに 1 ペア・最初に現れた AC の申告順で渡し、欠落ペアは null を配る', () => {
  const targets = [
    target(0, ['a.bats'], ['x.sh', 'y.sh']),
    target(1, ['b.bats'], ['z.sh']),
    target(2, ['a.bats'], ['y.sh', 'x.sh']),
  ];
  const { pairs, pairIndex } = buildRedgreenPairs(targets);
  assert.deepEqual(pairs, [{ test_files: ['a.bats'], impl_files: ['x.sh', 'y.sh'] }, { test_files: ['b.bats'], impl_files: ['z.sh'] }]);
  assert.deepEqual(pairIndex, [0, 1, 0]);
  const r0 = { index: 0, red: true, green: true };
  assert.deepEqual(distributeRedgreenResults(pairIndex, [r0]), [r0, null, r0]);
  assert.deepEqual(distributeRedgreenResults(pairIndex, null), [null, null, null]);
});

// ---- prompt 文言 ----

test('[redgreen-targets] prompt は Bash timeout: 600000 指定・run_in_background 禁止・再発行禁止を明記し、timeout 時は固定 JSON を返させる', () => {
  const p = redgreenVerifyPrompt('/tmp/wt', [{ test_files: ['t.test.mjs'], impl_files: ['src/x.ts'] }]);
  assert.ok(p.startsWith('cd /tmp/wt で作業。'), p);
  assert.ok(p.includes('Bash tool の `timeout: 600000` を指定して実行し、`run_in_background` は使わない（禁止）。'), p);
  assert.ok(p.includes('コマンドを再発行しない（timeout・background 化した場合も含む）。'), p);
  assert.ok(p.includes('timeout に達した・stdout に JSON 1 行が無い場合だけは、{"results":[]} を一字一句そのまま返せ'), p);
  assert.ok(p.includes('**stdout の JSON 1 行だけ** を verbatim で返せ'), p);
  // 規約はコマンド行より前に置き、コマンドは最終行の bare 単文
  const lines = p.split('\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[1], "redgreen-verify /tmp/wt 't.test.mjs' 'src/x.ts'");
  assert.ok(lines[0].includes('timeout: 600000'));
});

test('[redgreen-targets] base を渡すとコマンド行に --base <base> を worktree の前に付け、ペアの解釈は変わらない', () => {
  const pairs = [{ test_files: ['t.test.mjs'], impl_files: ['src/x.ts'] }];
  const p = redgreenVerifyPrompt('/tmp/wt', pairs, 'origin/main');
  assert.equal(p.split('\n')[1], "redgreen-verify --base origin/main /tmp/wt 't.test.mjs' 'src/x.ts'");
  assert.deepEqual(parseRedgreenPairs(p), [{ test_csv: 't.test.mjs', impl_csv: 'src/x.ts' }]);
});

// ---- dev-flow.js 配線（VM sandbox） ----

function evalResponse(acResults) {
  return {
    verdict: 'pass', total: 100, threshold: 80, feedback: [], feedback_level: 'implementation',
    ac_results: acResults, security_clearance: [], concern_resolutions: [],
  };
}

async function runWith(acResults, redgreenResultsFor) {
  const base = devFlowResponder();
  const redgreenPrompts = [];
  const responder = (c) => {
    if (c.agentType === 'dev-flow:evaluator') return evalResponse(acResults);
    if (isRedgreenCall(c.agentType, c.label)) {
      redgreenPrompts.push(c.prompt);
      const pairs = parseRedgreenPairs(c.prompt);
      return { results: pairs.map((p, k) => redgreenResultsFor(p, k)).filter((x) => x != null) };
    }
    return base(c);
  };
  const acCount = acResults.length;
  const { ctx, logs } = makeRecordingSandbox(responder, {
    args: analyzeArgs(1, { acceptance_criteria: Array.from({ length: acCount }, (_, i) => `ac${i}`) }),
  });
  const error = await runDevFlowInSandbox(devFlowSrc, ctx);
  assertNoCrash(error, 'redgreen-targets');
  return { redgreenPrompts, logs };
}

const sameAc = (i, testFiles = ['sample_case.bats'], implFiles = ['sample_case.py']) => ({
  ac_index: i, satisfied: true, verified_by: 'test', evidence: 'ok', test_files: testFiles, impl_files: implFiles,
});

test('[redgreen-targets] dev-flow: 7 AC が同一ペア → redgreen spawn は 1 回・引数 1 ペア、7 AC すべて deterministic 昇格', async () => {
  const acResults = Array.from({ length: 7 }, (_, i) => sameAc(i));
  const { redgreenPrompts, logs } = await runWith(acResults, () => ({ index: 0, red: true, green: true, reason: 'ok' }));
  assert.equal(redgreenPrompts.length, 1, `redgreen spawn が 1 回でない: ${redgreenPrompts.length}`);
  assert.deepEqual(parseRedgreenPairs(redgreenPrompts[0]), [{ test_csv: 'sample_case.bats', impl_csv: 'sample_case.py' }]);
  for (let i = 1; i <= 7; i++) {
    assert.ok(logs.some((l) => l.includes(`AC-${i}: red→green 実証 → deterministic 昇格 + checked`)), `AC-${i} が昇格していない`);
  }
  assert.ok(logs.some((l) => l.includes('AC 7 件を一意な (test_files, impl_files) 1 ペアに集約')));
  assert.ok(!logs.some((l) => l.includes('redgreen-verify の results が')), '集約後の期待件数（1）で欠落判定していない');
});

test('[redgreen-targets] dev-flow: 共有ペアの vdelta deny は共有する全 AC で昇格せず inspection 据え置き', async () => {
  const denyVerdict = {
    comparability: 'exact',
    transitions: { repaired_with_test_change: ['t1'] },
    verification_surface: { status: 'changed' },
  };
  const acResults = [sameAc(0), sameAc(1), sameAc(2)];
  const { redgreenPrompts, logs } = await runWith(acResults, () => ({ index: 0, red: true, green: true, verdict: denyVerdict }));
  assert.equal(parseRedgreenPairs(redgreenPrompts[0]).length, 1);
  for (let i = 1; i <= 3; i++) {
    assert.ok(!logs.some((l) => l.includes(`AC-${i}: red→green 実証 → deterministic 昇格`)), `AC-${i} が deny なのに昇格した`);
    assert.ok(logs.some((l) => l.includes(`AC-${i}: red→green 実証だが vdelta deny`)), `AC-${i} の deny ログが無い`);
  }
});

test('[redgreen-targets] dev-flow: 異なるペアは従来どおり別ペアで渡し（同じ組だけ 1 ペアに集約）、結果はペア単位で AC に入る', async () => {
  const acResults = [
    sameAc(0, ['t0.test.mjs'], ['impl0.mjs']),
    sameAc(1, ['t1.test.mjs'], ['impl1.mjs']),
    sameAc(2, ['t0.test.mjs'], ['impl0.mjs']),
  ];
  const { redgreenPrompts, logs } = await runWith(acResults, (p, k) => (p.test_csv === 't0.test.mjs'
    ? { index: k, red: true, green: true }
    : { index: k, red: false, green: true, reason: 'test passed without impl' }));
  assert.deepEqual(parseRedgreenPairs(redgreenPrompts[0]), [
    { test_csv: 't0.test.mjs', impl_csv: 'impl0.mjs' },
    { test_csv: 't1.test.mjs', impl_csv: 'impl1.mjs' },
  ]);
  assert.ok(logs.some((l) => l.includes('AC-1: red→green 実証 → deterministic 昇格 + checked')));
  assert.ok(logs.some((l) => l.includes('AC-3: red→green 実証 → deterministic 昇格 + checked')));
  assert.ok(logs.some((l) => l.includes('AC-2: red→green 未成立(test passed without impl)→ inspection 据え置き')));
});

const distinctAcs = (n) => Array.from({ length: n }, (_, i) => sameAc(i, [`t${i}.test.mjs`], [`impl${i}.mjs`]));

test('[redgreen-targets] dev-flow: test 実証 AC 3 件（別ペア）→ redgreen spawn は 1 回で prompt に 3 ペアが引数順に並び、results の index 突合で全 AC が昇格する', async () => {
  const { redgreenPrompts, logs } = await runWith(distinctAcs(3), (p, k) => ({ index: k, red: true, green: true }));
  assert.equal(redgreenPrompts.length, 1, `redgreen は AC 数に関わらず 1 iteration 1 spawn であるべきだが ${redgreenPrompts.length} 回`);
  assert.ok(
    redgreenPrompts[0].includes("redgreen-verify /tmp/wt 't0.test.mjs' 'impl0.mjs' 't1.test.mjs' 'impl1.mjs' 't2.test.mjs' 'impl2.mjs'"),
    `prompt に 3 ペアが引数順で並ぶべきだが: ${redgreenPrompts[0]}`,
  );
  for (const ac of ['AC-1', 'AC-2', 'AC-3']) {
    assert.ok(logs.some((l) => l.includes(`${ac}: red→green 実証 → deterministic 昇格 + checked`)), `${ac} が昇格するべきだが: ${JSON.stringify(logs.filter((l) => l.includes(ac)))}`);
  }
});

test('[redgreen-targets] dev-flow: results の欠落ペア（script 側の入力エラー等で index が返らない）は当該 AC だけ inspection 据え置きで他 AC は昇格し、欠落を log に出す', async () => {
  // AC-2（ペア index 1）だけ results から落とす
  const { logs } = await runWith(distinctAcs(3), (p, k) => (k === 1 ? null : { index: k, red: true, green: true }));
  assert.ok(logs.some((l) => l.includes('AC-1: red→green 実証 → deterministic 昇格 + checked')));
  assert.ok(logs.some((l) => l.includes('AC-3: red→green 実証 → deterministic 昇格 + checked')));
  assert.ok(
    logs.some((l) => l.includes('AC-2: red→green 未成立(null)→ inspection 据え置き')),
    `欠落ペアの AC-2 は inspection 据え置きであるべきだが: ${JSON.stringify(logs.filter((l) => l.includes('AC-2')))}`,
  );
  assert.ok(
    logs.some((l) => l.includes('redgreen-verify の results が 2 件（期待 3 件）')),
    `欠落は log で可視化されるべきだが: ${JSON.stringify(logs.filter((l) => l.includes('results')))}`,
  );
});

test('[redgreen-targets] dev-flow: redgreen の prompt は redgreenVerifyPrompt と同一 byte 列', async () => {
  const acResults = [sameAc(0), sameAc(1)];
  const { redgreenPrompts } = await runWith(acResults, () => ({ index: 0, red: true, green: true }));
  assert.equal(redgreenPrompts[0], redgreenVerifyPrompt('/tmp/wt', [{ test_files: ['sample_case.bats'], impl_files: ['sample_case.py'] }]));
});
