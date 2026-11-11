import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseDiffTriageFields, lineStatsFor, isWellFormedRiskField, withoutVisualSnapshotPngs } from './diff-triage.mjs';
import { makeDevFlowSandbox, runWorkflowCapture, devFlowArgs, STANDARD_FILES } from './test-helpers/vm-sandbox.mjs';

// (1) null 入力 → risk.ok===false かつ hits===[]、files/hash/lines は null。hits フィールド欠落を
// clean と同一視しない fail-closed が要件。
test('null 入力 → risk fail-closed (hits=[]), files/hash/lines=null', () => {
  const result = parseDiffTriageFields(null);
  assert.equal(result.risk.ok, false);
  assert.deepEqual(result.risk.hits, []);
  assert.equal(typeof result.risk.error, 'string');
  assert.equal(result.files, null);
  assert.equal(result.hash, null);
  assert.equal(result.lines, null);
});

// (2) 全フィールド正常入力 → 全て素通し。返すキーは risk/files/hash/lines の 4 つ
test('全フィールド正常 → risk/files/hash/lines がすべて素通し', () => {
  const lines = [{ path: 'a.js', added: 1, deleted: 0 }, { path: 'b.js', added: 2, deleted: 3 }];
  const unified = {
    risk: { ok: true, hits: [{ file: 'a.js', class: 'exec', severity: 'critical' }] },
    files: ['a.js', 'b.js'],
    diffhash: { hash: 'abc123', empty: false },
    lines,
  };
  const result = parseDiffTriageFields(unified);
  assert.deepEqual(Object.keys(result), ['risk', 'files', 'hash', 'lines']);
  assert.deepEqual(result.risk, unified.risk);
  assert.deepEqual(result.files, unified.files);
  assert.equal(result.hash, 'abc123');
  assert.deepEqual(result.lines, lines);
});

// (3) risk のみ欠落/型不正（ok 非boolean・hits 非配列）→ risk fail-closed 合成だが
// files/hash は正常値のまま（波及なし）
test('risk のみ型不正 → risk fail-closed だが他フィールドは無傷', () => {
  const unified = {
    risk: { ok: 'yes', hits: 'not-an-array' },
    files: ['a.js'],
    diffhash: { hash: 'deadbeef', empty: false },
  };
  const result = parseDiffTriageFields(unified);
  assert.equal(result.risk.ok, false);
  assert.deepEqual(result.risk.hits, []);
  assert.deepEqual(result.files, ['a.js']);
  assert.equal(result.hash, 'deadbeef');
});

test('risk 欠落フィールド（hits なし）→ risk fail-closed（hits 欠落を clean と同一視しない）', () => {
  const unified = {
    risk: { ok: true },
    files: [],
    diffhash: { hash: 'x', empty: true },
  };
  const result = parseDiffTriageFields(unified);
  assert.equal(result.risk.ok, false);
  assert.deepEqual(result.risk.hits, []);
  assert.deepEqual(result.files, []);
  assert.equal(result.hash, 'x');
});

// (4) files のみ不正（非配列・string 混入なし要素）→ files null だが risk は正常のまま（波及なし）
test('files のみ非配列 → files null だが risk は無傷', () => {
  const unified = {
    risk: { ok: true, hits: [] },
    files: 'not-an-array',
    diffhash: { hash: 'x', empty: true },
  };
  const result = parseDiffTriageFields(unified);
  assert.deepEqual(result.risk, { ok: true, hits: [] });
  assert.equal(result.files, null);
  assert.equal(result.hash, 'x');
});

test('files に非 string 要素混入 → files null（波及なし）', () => {
  const unified = {
    risk: { ok: true, hits: [] },
    files: ['a.js', 42, 'c.js'],
    diffhash: null,
  };
  const result = parseDiffTriageFields(unified);
  assert.equal(result.files, null);
  assert.deepEqual(result.risk, { ok: true, hits: [] });
});

// (5) diffhash.hash 非string → hash null のみ
test('diffhash.hash が非 string → hash null（波及なし）', () => {
  const unified = {
    risk: { ok: true, hits: [] },
    files: ['a.js'],
    diffhash: { hash: 12345, empty: false },
  };
  const result = parseDiffTriageFields(unified);
  assert.equal(result.hash, null);
  assert.deepEqual(result.risk, { ok: true, hits: [] });
  assert.deepEqual(result.files, ['a.js']);
});

test('diffhash 欠落 → hash null', () => {
  const unified = { risk: { ok: true, hits: [] }, files: [] };
  const result = parseDiffTriageFields(unified);
  assert.equal(result.hash, null);
});

// (6) files:[] は [] のまま（null と区別）
test('files:[] は null と区別され [] のまま採用される', () => {
  const unified = {
    risk: { ok: true, hits: [] },
    files: [],
    diffhash: null,
  };
  const result = parseDiffTriageFields(unified);
  assert.deepEqual(result.files, []);
  assert.notEqual(result.files, null);
});

// non-object / 任意の不正値入力（number, string, array）でも risk fail-closed、他 null に落ちる
test('unified が非 object（number）→ risk fail-closed、files/hash=null', () => {
  const result = parseDiffTriageFields(42);
  assert.equal(result.risk.ok, false);
  assert.deepEqual(result.risk.hits, []);
  assert.equal(result.files, null);
  assert.equal(result.hash, null);
});

test('unified が undefined → risk fail-closed、files/hash/lines=null', () => {
  const result = parseDiffTriageFields(undefined);
  assert.equal(result.risk.ok, false);
  assert.equal(result.files, null);
  assert.equal(result.hash, null);
  assert.equal(result.lines, null);
});

// ---- lines（file ごとの追加・削除行数、issue #740）: fail-safe = 不正なら null（shape は file 数判定に戻る）----

test('lines 正常 → 素通し、他フィールドは無傷', () => {
  const lines = [{ path: 'a.js', added: 3, deleted: 0 }, { path: 'b.md', added: 0, deleted: 12 }];
  const result = parseDiffTriageFields({ risk: { ok: true, hits: [] }, files: ['a.js', 'b.md'], diffhash: null, lines });
  assert.deepEqual(result.lines, lines);
  assert.deepEqual(result.files, ['a.js', 'b.md']);
  assert.equal(result.risk.ok, true);
});

for (const [label, lines] of [
  ['欠落', undefined],
  ['非配列', { path: 'a.js', added: 1, deleted: 0 }],
  ['added が文字列', [{ path: 'a.js', added: '1', deleted: 0 }]],
  ['deleted が負', [{ path: 'a.js', added: 1, deleted: -1 }]],
  ['path 欠落', [{ added: 1, deleted: 0 }]],
  ['null 要素', [null]],
]) {
  test(`lines ${label} → lines=null だが risk/files は無傷`, () => {
    const result = parseDiffTriageFields({ risk: { ok: true, hits: [] }, files: ['a.js'], diffhash: { hash: 'h' }, lines });
    assert.equal(result.lines, null);
    assert.deepEqual(result.risk, { ok: true, hits: [] });
    assert.deepEqual(result.files, ['a.js']);
    assert.equal(result.hash, 'h');
  });
}

test('lineStatsFor: files の順で行数を組み、files に無い lines の要素は使わない', () => {
  const lines = [{ path: 'old.txt', added: 0, deleted: 9 }, { path: 'b.ts', added: 2, deleted: 1 }, { path: 'a.ts', added: 5, deleted: 0 }];
  assert.deepEqual(lineStatsFor(['a.ts', 'b.ts'], lines), [
    { path: 'a.ts', added: 5, deleted: 0 },
    { path: 'b.ts', added: 2, deleted: 1 },
  ]);
  assert.deepEqual(lineStatsFor([], lines), []);
});

test('lineStatsFor: 行数の無い file（binary 等）が 1 件でもあれば null', () => {
  assert.equal(lineStatsFor(['a.ts', 'blob.bin'], [{ path: 'a.ts', added: 1, deleted: 0 }]), null);
});

test('lineStatsFor: files / lines のどちらかが null なら null', () => {
  assert.equal(lineStatsFor(null, []), null);
  assert.equal(lineStatsFor(['a.ts'], null), null);
});

// ---- isWellFormedRiskField: fail-closed の 2 原因を呼び出し側が区別するための述語 (issue #617) ----
//
// risk.ok!==true には (a) 形状不一致（top-level risk 欠落 → parseRiskField が合成）と
// (b) proxy が契約通りの形で ok:false を報告（diff-triage.sh 自体の失敗）の 2 通りがある。
// 述語は「採用されたか合成されたか」を返し、診断 log の文言・出力値の出し分けに使う。

test.each([
  ['契約通り（ok:true）', { risk: { ok: true, hits: [] } }, true],
  ['proxy が契約通りの形で失敗を報告（ok:false でも形状は正しい）', { risk: { ok: false, hits: [], error: 'boom' } }, true],
  ['null', null, false],
  ['undefined', undefined, false],
  ['top-level risk 欠落', {}, false],
  ['payload が struct にネストされた #614 実測形状', { struct: { risk: { ok: true, hits: [] } } }, false],
  ['ok が boolean でない', { risk: { ok: 'true', hits: [] } }, false],
  ['hits 欠落', { risk: { ok: true } }, false],
  ['hits が配列でない', { risk: { ok: true, hits: 'x' } }, false],
])('isWellFormedRiskField: %s → %s', (_name, unified, want) => {
  assert.equal(isWellFormedRiskField(unified), want);
});

test.each([
  // 述語 true: 契約通りの失敗報告では proxy の error がそのまま残り、診断値として log できる
  ['述語 true のとき proxy の risk をそのまま採用する（error も保持）',
    { risk: { ok: false, hits: [], error: 'diff-triage.sh exited 2' } },
    { ok: false, error: 'diff-triage.sh exited 2' }],
  ['述語 false のとき fail-closed を合成する',
    { struct: { risk: { ok: true, hits: [] } } },
    { ok: false, error: 'diff-triage unified proxy unavailable (fail-closed)' }],
])('parseDiffTriageFields(unified).risk: %s', (_name, unified, want) => {
  const { risk } = parseDiffTriageFields(unified);
  assert.equal(risk.ok, want.ok);
  assert.equal(risk.error, want.error);
});

// ---- issue #1410: shape の判定に数える変わったファイルから、宣言 visual_snapshots の paths の下の PNG を外す ----

test('withoutVisualSnapshotPngs: paths の下の PNG だけを外し、paths の下でも PNG でないファイル・paths の外の PNG は残す', () => {
  const files = [
    'src/app.ts',
    'tests/visual/home.png',
    'tests/visual/login/form.png',
    'tests/visual/README.md',
    'tests/visual/home.png.orig',
    'tests/visual/meta.json',
    'docs/images/logo.png',
    'tests/visual-old/home.png',
    'home.png',
  ];
  assert.deepEqual(withoutVisualSnapshotPngs(files, ['tests/visual']), [
    'src/app.ts', 'tests/visual/README.md', 'tests/visual/home.png.orig', 'tests/visual/meta.json',
    'docs/images/logo.png', 'tests/visual-old/home.png', 'home.png',
  ]);
  // 末尾の / は付いていても同じ。複数の paths はどれかに一致すれば外す
  assert.deepEqual(withoutVisualSnapshotPngs(files, ['tests/visual/', 'docs/images']), [
    'src/app.ts', 'tests/visual/README.md', 'tests/visual/home.png.orig', 'tests/visual/meta.json', 'tests/visual-old/home.png', 'home.png',
  ]);
});

test('withoutVisualSnapshotPngs: paths は glob（* と ? は / をまたがず、segment 全体の ** は 0 個以上のディレクトリ）', () => {
  const files = [
    'apps/web/e2e/__screenshots__/a.png',
    'apps/admin/e2e/__screenshots__/chromium/b.png',
    'apps/web/src/e2e/__screenshots__/c.png',
    'packages/ui/__screenshots__/d.png',
    'packages/ui/src/button/__screenshots__/e.png',
    '__screenshots__/f.png',
    'apps/web/e2e/__screenshots__x/g.png',
    'shots.v1/h.png',
    'shotsXv1/i.png',
  ];
  assert.deepEqual(withoutVisualSnapshotPngs(files, ['apps/*/e2e/__screenshots__']), files.filter((f) => !['apps/web/e2e/__screenshots__/a.png', 'apps/admin/e2e/__screenshots__/chromium/b.png'].includes(f)));
  assert.deepEqual(withoutVisualSnapshotPngs(files, ['**/__screenshots__']), ['apps/web/e2e/__screenshots__x/g.png', 'shots.v1/h.png', 'shotsXv1/i.png']);
  assert.deepEqual(withoutVisualSnapshotPngs(files, ['packages/**']), files.filter((f) => !f.startsWith('packages/')));
  // . は任意の 1 文字でなく . にだけ一致する
  assert.deepEqual(withoutVisualSnapshotPngs(['shots.v1/h.png', 'shotsXv1/i.png'], ['shots.v1']), ['shotsXv1/i.png']);
  assert.deepEqual(withoutVisualSnapshotPngs(['shots.v1/h.png', 'shotsXv1/i.png'], ['shots?v1']), []);
});

test('withoutVisualSnapshotPngs: 宣言が無い・paths が空ならそのまま返し、取得失敗の null を空配列にしない', () => {
  const files = ['tests/visual/home.png', 'src/app.ts'];
  for (const paths of [undefined, null, []]) assert.equal(withoutVisualSnapshotPngs(files, paths), files);
  assert.equal(withoutVisualSnapshotPngs(null, ['tests/visual']), null);
});

// Diff triage の配線: 宣言のある run は、paths の下の PNG を realized count（shape の判定）から外す。
const devFlowSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '.claude/workflows/dev-flow.js'), 'utf8');
const VISUAL_SNAPSHOTS = { command: 'pnpm test:visual', db: { engine: 'postgres', version: '17' }, env: 'E2E_EXTERNAL_DATABASE_URL', timeout_seconds: 900, paths: ['tests/visual'] };

async function shapeOf(files, { declared = true } = {}) {
  const impl = { status: 'DONE', task_id: 'issue-1', files: [...files], summary: 's', concerns: [] };
  const { ctx, logs } = makeDevFlowSandbox({
    overrides: { 'impl:serial:issue-1': impl, 'danger-grep': { risk: { ok: true, hits: [] }, files: [...files], diffhash: { hash: 'AAA', empty: false } } },
    extra: { args: devFlowArgs(1, declared ? { visual_snapshots: VISUAL_SNAPSHOTS } : {}) },
  });
  const { result, error } = await runWorkflowCapture(devFlowSrc, ctx);
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  assert.ok(result, 'run が結果を返さない');
  // 実効 shape は Diff triage の log（`shape: <shape> — <理由>`）で見る
  const line = logs.find((l) => l.startsWith('shape: '));
  return { shape: line?.split(' ')[1], logs };
}

test('[diff-triage] 宣言の paths の下の PNG は shape の判定に数えない（PNG 10 枚を足しても standard のまま）。宣言が無ければ数える', async () => {
  const pngs = Array.from({ length: 10 }, (_, i) => `tests/visual/page-${i}.png`);
  const withDecl = await shapeOf([...STANDARD_FILES, ...pngs]);
  assert.equal(withDecl.shape, 'standard', withDecl.logs.filter((l) => l.includes('shape') || l.includes('realized')).join('\n'));
  assert.ok(withDecl.logs.some((l) => l.includes('visual_snapshots の paths の下の PNG 10 件を file count から除外')), withDecl.logs.join('\n'));
  assert.equal((await shapeOf([...STANDARD_FILES, ...pngs], { declared: false })).shape, 'complex');
});

test('[diff-triage] 宣言の paths の下でも PNG でないファイルは shape の判定に数える', async () => {
  const notPng = ['tests/visual/a.json', 'tests/visual/b.md', 'tests/visual/c.jpg', 'tests/visual/d.png.bak'];
  assert.equal((await shapeOf([...STANDARD_FILES, ...notPng])).shape, 'complex');
});
