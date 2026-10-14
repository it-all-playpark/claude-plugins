// _lib/removed-phase-invariant.test.mjs
// 撤去済み phase の旧シンボルが再登場しないことを静的に pin する:
//   - Analyze phase（issue #695）: phase マーカー・analyze の開始/終了 clock mark・常に 0 だった
//     phase_durations の analyze 列・doctor の analyze/plan 列。決定論ゲートは Setup 末尾に吸収した
//   - Plan phase（issue #678）: phase マーカー・常時 0/null の plan iteration / plan verdict telemetry・
//     plan 終端の clock mark・summary の plan concerns 配線
//   - plan.parallel（issue #697）: parallel fan-out 撤去後に残った常に空の plan.parallel と参照ゼロの schema。
//     plan は serial のみを持つ（synthesizeImplPlan の出力。値を積む経路は serial だけ）
//
// 対象外（生きている）: Analyze ゲート本体（buildReqFromContract / analyzeGateReasons / clarifyPrompt /
// analyze-clarify spawn / needs_clarification の source: 'analyze' | 'analyze_prerun' | 'blocked_by'）と
// telemetry の analyze_path / analyze_ineligible_reason / prerun_durations.analyze。`plan` オブジェクト
// （synthesizeImplPlan の出力）は Implement の spawn 単位・報告キャリアとして生きている — その consumer の
// 関数シグネチャは implementer-naming-invariant.test.mjs (c) が pin する。
//
// 禁止トークンは join で組み立てる — 本ファイル自身が plugins/dev-flow 配下の *.mjs であり、
// (c) の grep 相当スキャンの対象に入るため、literal を書くと自分で invariant を破る。
//
// Run: npx vitest run _lib/removed-phase-invariant.test.mjs
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, extname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = join(here, '..');
const pluginsRoot = join(pluginRoot, '..');

const PLAN_ITER = ['plan', 'iter'].join('_');
const PLAN_VERDICT = ['plan', 'verdict'].join('_');

// phase ごとの撤去済みトークン（Analyze: #695 AC-1 の 6 文字列 / Plan: #678 AC-1 の 7 文字列）
const FORBIDDEN_BY_PHASE = {
  Analyze: [
    ['phase(', "'Analyze')"].join(''),
    ['title: ', "'Analyze'"].join(''),
    ['analyze', 'start'].join('_'),
    ['analyze', 'end'].join('_'),
    ['phase: ', "'Analyze'"].join(''),
    ['ABORT_CTX.phase = ', "'Analyze'"].join(''),
  ],
  Plan: [
    ['phase(', "'Plan')"].join(''),
    ['plan', 'Verdict'].join(''),
    ['plan', 'Concerns'].join(''),
    ['plan', 'Iters'].join(''),
    ['plan', 'end'].join('_'),
    PLAN_ITER,
    PLAN_VERDICT,
  ],
};

const TARGETS = [
  '.claude/workflows/dev-flow.js',
  '_lib/devflow-durations.mjs',
];

const devFlowSrc = readFileSync(join(pluginRoot, '.claude/workflows/dev-flow.js'), 'utf8');

// ---- (a) 静的 pin: dev-flow.js / devflow-durations.mjs ----

for (const rel of TARGETS) {
  for (const [phaseName, forbidden] of Object.entries(FORBIDDEN_BY_PHASE)) {
    test(`[removed-phase] (a) ${rel} に ${phaseName} phase 由来の ${forbidden.length} トークンが出現しない`, () => {
      const src = readFileSync(join(pluginRoot, rel), 'utf8');
      const hits = forbidden.filter((tok) => src.includes(tok));
      assert.deepEqual(hits, [], `${rel} に撤去済みトークンが残っている: ${hits.join(', ')}`);
    });
  }
}

// ---- (b) 構造 pin ----

test("[removed-phase] (b) Analyze: dev-flow.js のゲート本体（buildReqFromContract / analyzeGateReasons / analyze-clarify / needs_clarification 2 経路）は phase('Setup') と phase('Implement') の間に残る", () => {
  const src = devFlowSrc;
  const setup = src.indexOf("phase('Setup')");
  const impl = src.indexOf("phase('Implement')");
  assert.ok(setup >= 0, "phase('Setup') が無い");
  assert.ok(impl > setup, "phase('Implement') が phase('Setup') の後に無い");
  for (const marker of [
    'const req = buildReqFromContract(ANALYZE, ISSUE)',
    'const gateReasons = analyzeGateReasons(req)',
    'label: `analyze-clarify#${ISSUE}`',
    "source: 'analyze_prerun'",
    "source: 'blocked_by'",
    "source: 'analyze'",
    "feedClockMark('setup_end', { ok: true, epoch: PRERUN.epoch_end })",
  ]) {
    const idx = src.indexOf(marker);
    assert.ok(idx >= 0, `ゲート本体が変わっている: ${marker}`);
    assert.ok(idx > setup && idx < impl, `${marker} が Setup 末尾（phase('Setup')〜phase('Implement')）の外にある`);
  }
  // ゲート経路の失敗 telemetry / clarify spawn の phase 帰属は 'Setup'
  const gateSlice = src.slice(setup, impl);
  assert.ok(gateSlice.includes("label: `analyze-clarify#${ISSUE}`, phase: 'Setup'"), 'analyze-clarify spawn の phase 帰属が Setup になっていない');
  assert.equal((gateSlice.match(/error_category: 'needs_clarification'[^\n]*phase: 'Setup'/g) || []).length, 3, 'needs_clarification の writeFailureTelemetry 3 経路（analyze_prerun / blocked_by / analyze）の phase 帰属が Setup になっていない');
});

test("[removed-phase] (b) Plan: dev-flow.js の meta.phases に Plan が無く、合成 plan は phase('Implement') より前で作られる", () => {
  assert.ok(!devFlowSrc.includes("{ title: 'Plan' }"), 'meta.phases に Plan が残っている');
  const synth = devFlowSrc.indexOf('let plan = synthesizeImplPlan(req, ISSUE)');
  const impl = devFlowSrc.indexOf("phase('Implement')");
  assert.ok(synth >= 0, 'synthesizeImplPlan(req, ISSUE) の呼び出しが無い（plan オブジェクトは削除対象外）');
  assert.ok(impl >= 0, "phase('Implement') が無い");
  assert.ok(synth < impl, '合成 plan は Implement phase より前に作られるべき');
});

// ---- (b) plan.parallel: dev-flow.js と _lib/*.mjs（test 除く）に plan.parallel の参照が無い ----

const FORBIDDEN_PARALLEL = ['plan.parallel', 'plan?.parallel', 'parallel: []', '.parallel ??'];

const parallelTargets = [
  '.claude/workflows/dev-flow.js',
  ...readdirSync(here)
    .filter((n) => n.endsWith('.mjs') && !n.endsWith('.test.mjs'))
    .map((n) => `_lib/${n}`),
];

test('[removed-phase] (b) plan.parallel: dev-flow.js と _lib canonical のどれにも plan.parallel の参照が無い', () => {
  assert.ok(parallelTargets.includes('.claude/workflows/dev-flow.js'));
  assert.ok(parallelTargets.includes('_lib/pr-artifacts.mjs'), '_lib の走査 root が違う');
  assert.ok(parallelTargets.length > 20, `スキャン対象が少なすぎる（${parallelTargets.length} 件）`);
  const hits = parallelTargets.flatMap((rel) => {
    const src = readFileSync(join(pluginRoot, rel), 'utf8');
    return FORBIDDEN_PARALLEL.filter((tok) => src.includes(tok)).map((tok) => `${rel}: ${tok}`);
  });
  assert.deepEqual(hits, [], `撤去済みの plan.parallel 参照が残っている:\n${hits.join('\n')}`);
});

// ---- (b) plan.parallel: 合成 plan と plan を読む側は serial のみを扱う ----

test('[removed-phase] (b) plan.parallel: synthesizeImplPlan は serial のみを返し、isImplPlan / adoptReportedFiles / planPaths は serial だけを読む', () => {
  const synthStart = devFlowSrc.indexOf('function synthesizeImplPlan(req, issue)');
  assert.ok(synthStart >= 0, 'synthesizeImplPlan が無い');
  const synthBody = devFlowSrc.slice(synthStart, devFlowSrc.indexOf('\n}\n', synthStart));
  assert.ok(synthBody.includes('serial: ['), synthBody);
  assert.ok(!synthBody.includes('parallel'), `synthesizeImplPlan に parallel が残っている:\n${synthBody}`);
  assert.ok(devFlowSrc.includes('function isImplPlan(p) { return (p?.serial ?? []).some(isImplTask) }'));
  assert.ok(devFlowSrc.includes('return { ...plan, serial: (plan.serial ?? []).map(adopt) }'));
  const prArtifacts = readFileSync(join(here, 'pr-artifacts.mjs'), 'utf8');
  assert.ok(prArtifacts.includes('for (const t of arr(plan?.serial)) {'), 'planPaths は plan.serial だけを走査する');
});

// ---- (c) telemetry 経路: plugins/dev-flow / plugins/playpark-core 配下の *.sh / *.mjs / *.json / *.bats に
// phase_durations / phase_latency の analyze・plan 列、PHASE_NAMES の analyze・plan、Plan の iteration / verdict キーが無い ----

const SCAN_EXT = new Set(['.sh', '.mjs', '.json', '.bats']);
const SKIP_DIRS = new Set(['node_modules', '.git']);

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (SCAN_EXT.has(extname(name))) out.push(p);
  }
  return out;
}

const PD_ANALYZE = ['phase_durations', 'analyze'].join('.');
const PD_PLAN = ['phase_durations', 'plan'].join('.');
const PL_ANALYZE = ['phase_latency', 'analyze'].join('.');
const PL_PLAN = ['phase_latency', 'plan'].join('.');

const REMOVED_TOKENS = [PD_ANALYZE, PD_PLAN, PL_ANALYZE, PL_PLAN, PLAN_ITER, PLAN_VERDICT];
const REMOVED_PHASES = ['analyze', 'plan'];
const PHASE_PARENTS = ['phase_latency', 'phase_durations'];

// JSON 値を任意の深さまで辿り、phase_latency / phase_durations object の直下キーに analyze / plan が
// あればそのパスを返す。値が入れ子 object のとき 2 番目以降のキーも取りこぼさないよう、文字列の
// 正規表現ではなく parse 後の Object.keys で判定する。
function findRemovedPhaseKeys(value, path = '$') {
  if (Array.isArray(value)) return value.flatMap((v, i) => findRemovedPhaseKeys(v, `${path}[${i}]`));
  if (value === null || typeof value !== 'object') return [];
  const found = [];
  for (const [key, child] of Object.entries(value)) {
    if (PHASE_PARENTS.includes(key) && child !== null && typeof child === 'object' && !Array.isArray(child)) {
      for (const k of Object.keys(child)) {
        if (REMOVED_PHASES.includes(k)) found.push(`${path}.${key}.${k}`);
      }
    }
    found.push(...findRemovedPhaseKeys(child, `${path}.${key}`));
  }
  return found;
}

// shell の PHASE_NAMES= 行から配列要素を取り出す。JSON 文字列形（PHASE_NAMES='["a","b"]'）と
// bash 配列形（PHASE_NAMES=(a b)）の両方を扱い、要素の位置に依らず analyze / plan を検出する。
function findRemovedPhaseNames(src) {
  const found = [];
  for (const m of src.matchAll(/^\s*(?:export\s+|local\s+|readonly\s+)?PHASE_NAMES=(.*)$/gm)) {
    const names = m[1]
      .replace(/[[\]()'"]/g, ' ')
      .split(/[\s,]+/)
      .filter(Boolean);
    for (const name of REMOVED_PHASES) {
      if (names.includes(name)) found.push(`PHASE_NAMES に ${name}`);
    }
  }
  return found;
}

// 非 JSON ファイル（heredoc / inline fixture）の JSON 断片用。parse できないため文字列で見る。
function findRemovedPhaseKeysInText(src) {
  const found = [];
  for (const parent of PHASE_PARENTS) {
    const re = new RegExp(`"${parent}":\\s*\\{[^}]*"(analyze|plan)"\\s*:`);
    if (re.test(src)) found.push(`"${parent}" object に analyze/plan キー`);
  }
  return found;
}

function scanFile(rel, src) {
  const hits = [];
  for (const tok of REMOVED_TOKENS) {
    if (src.includes(tok)) hits.push(`${rel}: ${tok}`);
  }
  const ext = extname(rel);
  if (ext === '.json') {
    // parse できない JSON は検査をすり抜けるので hit として落とす（fail-closed）
    let parsed;
    try {
      parsed = JSON.parse(src);
    } catch (e) {
      return [...hits, `${rel}: JSON.parse 失敗（${e.message}）`];
    }
    for (const p of findRemovedPhaseKeys(parsed)) hits.push(`${rel}: ${p}`);
  } else {
    for (const h of findRemovedPhaseKeysInText(src)) hits.push(`${rel}: ${h}`);
  }
  if (ext === '.sh' || ext === '.bats') {
    for (const h of findRemovedPhaseNames(src)) hits.push(`${rel}: ${h}`);
  }
  return hits;
}

test(`[removed-phase] (c) plugins/dev-flow / plugins/playpark-core 配下の *.sh / *.mjs / *.json / *.bats に ${PD_ANALYZE} / ${PD_PLAN} / phase_latency の analyze・plan 列 / PHASE_NAMES の analyze・plan / ${PLAN_ITER} / ${PLAN_VERDICT} の参照が無い`, () => {
  const files = [
    ...walk(pluginRoot, []),
    ...walk(join(pluginsRoot, 'playpark-core'), []),
  ];
  assert.ok(files.length > 50, `スキャン対象が少なすぎる（${files.length} 件）— walk の root が違う`);
  assert.ok(files.some((f) => extname(f) === '.json'), 'スキャン対象に *.json が無い — JSON.parse 経路が空振りしている');
  assert.ok(files.some((f) => f.startsWith(join(pluginsRoot, 'playpark-core'))), 'スキャン対象に playpark-core が無い');
  const hits = files.flatMap((f) => scanFile(relative(pluginsRoot, f), readFileSync(f, 'utf8')));
  assert.deepEqual(hits, [], `telemetry 経路に撤去済みキーの参照が残っている:\n${hits.join('\n')}`);
});

// ---- (c) positive control: 検出器が red になる入力で pin する（検出器を弱めると (c) が vacuous に通るため） ----

test('[removed-phase] (c) positive control: phase_latency / phase_durations の入れ子 object で 2 番目以降のキーにある analyze / plan を *.json から検出する', () => {
  const nested = {
    phase_latency: {
      implement: { count: 2, p50: 150, p95: 195 },
      analyze: { count: 2, p50: 150, p95: 195 },
    },
    runs: [
      { telemetry: { phase_durations: { implement: { seconds: 10 }, validate: 5, plan: 3 } } },
    ],
  };
  assert.deepEqual(scanFile('fixture.json', JSON.stringify(nested, null, 2)), [
    `fixture.json: $.${PL_ANALYZE}`,
    `fixture.json: $.runs[0].telemetry.${PD_PLAN}`,
  ]);
  // 撤去済みでない phase だけなら hit しない（negative control）
  const clean = { phase_latency: { implement: { count: 1 }, validate: { count: 1 } } };
  assert.deepEqual(scanFile('clean.json', JSON.stringify(clean)), []);
});

test('[removed-phase] (c) positive control: parse できない *.json は hit として落ちる', () => {
  const hits = scanFile('broken.json', '{ "phase_latency": ');
  assert.equal(hits.length, 1);
  assert.match(hits[0], /^broken\.json: JSON\.parse 失敗/);
});

test('[removed-phase] (c) positive control: PHASE_NAMES 配列の先頭以外にある analyze / plan を *.sh から検出する', () => {
  const key = ['PHASE', 'NAMES'].join('_');
  assert.deepEqual(scanFile('x.sh', `${key}='["implement","validate","analyze"]'\n`), ['x.sh: PHASE_NAMES に analyze']);
  assert.deepEqual(scanFile('x.sh', `${key}='["implement", "plan", "validate"]'\n`), ['x.sh: PHASE_NAMES に plan']);
  assert.deepEqual(scanFile('x.sh', `  local ${key}=(implement analyze plan)\n`), [
    'x.sh: PHASE_NAMES に analyze',
    'x.sh: PHASE_NAMES に plan',
  ]);
  // analyze_path のような部分一致は phase 名ではないので hit しない（negative control）
  assert.deepEqual(scanFile('x.sh', `${key}='["implement","analyze_path","validate"]'\n`), []);
});

test('[removed-phase] (c) positive control: plan iteration / plan verdict の telemetry キーを *.mjs / *.bats から検出する', () => {
  assert.deepEqual(scanFile('x.mjs', `telemetry.${PLAN_ITER} = 0\n`), [`x.mjs: ${PLAN_ITER}`]);
  assert.deepEqual(scanFile('x.bats', `jq -e '.telemetry.${PLAN_VERDICT} == null'\n`), [`x.bats: ${PLAN_VERDICT}`]);
  // plan オブジェクト自体（生きている）は hit しない（negative control）
  assert.deepEqual(scanFile('x.mjs', 'const plan = synthesizeImplPlan(req, issue)\n'), []);
});

// ---- (d) 表記: 撤去済み phase 名としての「Analyze」をコメントに残さない ----
// ゲートは「Setup 末尾の analyze ゲート」と書く。"Analyze dev-flow ..." は動詞なので除外する。

const PHASE_WORDING_TARGETS = [
  '_lib/final-ac-reconcile.mjs',
  '_lib/triviality.mjs',
];

function findAnalyzePhaseWording(src) {
  return src
    .split('\n')
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => /\bAnalyze\b(?! dev-flow)/.test(line))
    .map(([n, line]) => `${n}: ${line.trim()}`);
}

for (const rel of PHASE_WORDING_TARGETS) {
  test(`[removed-phase] (d) ${rel} に phase 名としての Analyze 表記が残っていない`, () => {
    const hits = findAnalyzePhaseWording(readFileSync(join(pluginRoot, rel), 'utf8'));
    assert.deepEqual(hits, [], `${rel} に Analyze phase 前提の表記が残っている:\n${hits.join('\n')}`);
  });
}

test('[removed-phase] (d) positive control: phase 名の Analyze は検出し、動詞の "Analyze dev-flow" と小文字の analyze ゲートは検出しない', () => {
  assert.deepEqual(findAnalyzePhaseWording('# x\n// Analyze で freeze した AC\n'), ['2: // Analyze で freeze した AC']);
  assert.deepEqual(findAnalyzePhaseWording('sonnet は Analyze ゲート後'), ['1: sonnet は Analyze ゲート後']);
  assert.deepEqual(findAnalyzePhaseWording('# x.sh - Analyze dev-flow / pr-iterate journal telemetry\n'), []);
  assert.deepEqual(findAnalyzePhaseWording('sonnet は analyze ゲート（Setup 末尾）後'), []);
});
