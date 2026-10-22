import { test } from 'vitest';
import assert from 'node:assert/strict';
import { parseSecfloorFields, lineStatsFor, isWellFormedRiskField, SECREVIEW_UNAVAILABLE_REASON } from './secfloor-unified.mjs';

// (1) null 入力 → risk.ok===false かつ hits===[]、files/struct/hash は null。hits フィールド欠落を
// clean と同一視しない fail-closed が要件。
test('null 入力 → risk fail-closed (hits=[]), files/struct/hash=null', () => {
  const result = parseSecfloorFields(null);
  assert.equal(result.risk.ok, false);
  assert.deepEqual(result.risk.hits, []);
  assert.equal(typeof result.risk.error, 'string');
  assert.equal(result.files, null);
  assert.equal(result.struct, null);
  assert.equal(result.hash, null);
});

// (2) 全フィールド正常入力 → 全て素通し
test('全フィールド正常 → risk/files/struct/hash がすべて素通し', () => {
  const unified = {
    risk: { ok: true, hits: [{ file: 'a.js', class: 'exec', severity: 'critical' }] },
    files: ['a.js', 'b.js'],
    struct: { ok: true, available: true, structural: ['a.js'], format_only: ['b.js'] },
    diffhash: { hash: 'abc123', empty: false },
  };
  const result = parseSecfloorFields(unified);
  assert.deepEqual(result.risk, unified.risk);
  assert.deepEqual(result.files, unified.files);
  assert.deepEqual(result.struct, unified.struct);
  assert.equal(result.hash, 'abc123');
});

// (3) risk のみ欠落/型不正（ok 非boolean・hits 非配列）→ risk fail-closed 合成だが
// files/struct/hash は正常値のまま（波及なし）
test('risk のみ型不正 → risk fail-closed だが他フィールドは無傷', () => {
  const unified = {
    risk: { ok: 'yes', hits: 'not-an-array' },
    files: ['a.js'],
    struct: { ok: true, available: true, structural: [], format_only: [] },
    diffhash: { hash: 'deadbeef', empty: false },
  };
  const result = parseSecfloorFields(unified);
  assert.equal(result.risk.ok, false);
  assert.deepEqual(result.risk.hits, []);
  assert.deepEqual(result.files, ['a.js']);
  assert.deepEqual(result.struct, unified.struct);
  assert.equal(result.hash, 'deadbeef');
});

test('risk 欠落フィールド（hits なし）→ risk fail-closed（hits 欠落を clean と同一視しない）', () => {
  const unified = {
    risk: { ok: true },
    files: [],
    struct: null,
    diffhash: { hash: 'x', empty: true },
  };
  const result = parseSecfloorFields(unified);
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
    struct: { ok: true, available: true, structural: [], format_only: [] },
    diffhash: { hash: 'x', empty: true },
  };
  const result = parseSecfloorFields(unified);
  assert.deepEqual(result.risk, { ok: true, hits: [] });
  assert.equal(result.files, null);
  assert.deepEqual(result.struct, unified.struct);
  assert.equal(result.hash, 'x');
});

test('files に非 string 要素混入 → files null（波及なし）', () => {
  const unified = {
    risk: { ok: true, hits: [] },
    files: ['a.js', 42, 'c.js'],
    struct: null,
    diffhash: null,
  };
  const result = parseSecfloorFields(unified);
  assert.equal(result.files, null);
  assert.deepEqual(result.risk, { ok: true, hits: [] });
});

// (5) struct のみ不正/available:false → struct null/採用なしだが他フィールド不変
test('struct.ok!==true → struct null だが他フィールドは無傷', () => {
  const unified = {
    risk: { ok: true, hits: [] },
    files: ['a.js'],
    struct: { ok: false, error: 'boom' },
    diffhash: { hash: 'x', empty: false },
  };
  const result = parseSecfloorFields(unified);
  assert.equal(result.struct, null);
  assert.deepEqual(result.risk, { ok: true, hits: [] });
  assert.deepEqual(result.files, ['a.js']);
  assert.equal(result.hash, 'x');
});

test('struct.available が boolean 以外 → struct null（波及なし）', () => {
  const unified = {
    risk: { ok: true, hits: [] },
    files: ['a.js'],
    struct: { ok: true, available: 'true', structural: [], format_only: [] },
    diffhash: { hash: 'x', empty: false },
  };
  const result = parseSecfloorFields(unified);
  assert.equal(result.struct, null);
  assert.deepEqual(result.files, ['a.js']);
});

test('struct.available===false (difft 未インストール) は object かつ配列が揃っていれば採用', () => {
  const unified = {
    risk: { ok: true, hits: [] },
    files: [],
    struct: { ok: true, available: false, structural: [], format_only: [], reason: 'difft_not_installed' },
    diffhash: null,
  };
  const result = parseSecfloorFields(unified);
  assert.deepEqual(result.struct, unified.struct);
});

// (6) diffhash.hash 非string → hash null のみ
test('diffhash.hash が非 string → hash null（波及なし）', () => {
  const unified = {
    risk: { ok: true, hits: [] },
    files: ['a.js'],
    struct: { ok: true, available: true, structural: [], format_only: [] },
    diffhash: { hash: 12345, empty: false },
  };
  const result = parseSecfloorFields(unified);
  assert.equal(result.hash, null);
  assert.deepEqual(result.risk, { ok: true, hits: [] });
  assert.deepEqual(result.files, ['a.js']);
  assert.deepEqual(result.struct, unified.struct);
});

test('diffhash 欠落 → hash null', () => {
  const unified = { risk: { ok: true, hits: [] }, files: [], struct: null };
  const result = parseSecfloorFields(unified);
  assert.equal(result.hash, null);
});

// (7) files:[] は [] のまま（null と区別）
test('files:[] は null と区別され [] のまま採用される', () => {
  const unified = {
    risk: { ok: true, hits: [] },
    files: [],
    struct: null,
    diffhash: null,
  };
  const result = parseSecfloorFields(unified);
  assert.deepEqual(result.files, []);
  assert.notEqual(result.files, null);
});

// non-object / 任意の不正値入力（number, string, array）でも risk fail-closed、他 null に落ちる
test('unified が非 object（number）→ risk fail-closed、files/struct/hash=null', () => {
  const result = parseSecfloorFields(42);
  assert.equal(result.risk.ok, false);
  assert.deepEqual(result.risk.hits, []);
  assert.equal(result.files, null);
  assert.equal(result.struct, null);
  assert.equal(result.hash, null);
});

test('unified が undefined → risk fail-closed、files/struct/hash=null', () => {
  const result = parseSecfloorFields(undefined);
  assert.equal(result.risk.ok, false);
  assert.equal(result.files, null);
  assert.equal(result.struct, null);
  assert.equal(result.hash, null);
  assert.equal(result.lines, null);
});

// ---- lines（file ごとの追加・削除行数、issue #740）: fail-safe = 不正なら null（shape は file 数判定に戻る）----

test('lines 正常 → 素通し、他フィールドは無傷', () => {
  const lines = [{ path: 'a.js', added: 3, deleted: 0 }, { path: 'b.md', added: 0, deleted: 12 }];
  const result = parseSecfloorFields({ risk: { ok: true, hits: [] }, files: ['a.js', 'b.md'], struct: null, diffhash: null, lines });
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
    const result = parseSecfloorFields({ risk: { ok: true, hits: [] }, files: ['a.js'], struct: null, diffhash: { hash: 'h' }, lines });
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
// (b) proxy が契約通りの形で ok:false を報告（secfloor-classify.sh 自体の失敗）の 2 通りがある。
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
    { risk: { ok: false, hits: [], error: 'secfloor-classify.sh exited 2' } },
    { ok: false, error: 'secfloor-classify.sh exited 2' }],
  ['述語 false のとき fail-closed を合成する',
    { struct: { risk: { ok: true, hits: [] } } },
    { ok: false, error: 'secfloor unified proxy unavailable (fail-closed)' }],
])('parseSecfloorFields(unified).risk: %s', (_name, unified, want) => {
  const { risk } = parseSecfloorFields(unified);
  assert.equal(risk.ok, want.ok);
  assert.equal(risk.error, want.error);
});

// ---- struct フィールドの fail-open（issue #350）----
// struct が null / ok!==true / available 非 boolean / format_only・structural 非配列のいずれでも struct=null
// （呼び出し元は formatOnlySet を空にして全ファイル structural 扱いへフォールバックする）。

test('parseSecfloorFields(unified).struct: 形の正しい struct は非 null で format_only を保持する', () => {
  const unified = { risk: { ok: true, hits: [] }, struct: { ok: true, available: true, format_only: ['a'], structural: [] } };
  const { struct } = parseSecfloorFields(unified);
  assert.notEqual(struct, null);
  assert.deepEqual(struct.format_only, ['a']);
});

test.each([
  ['ok!==true', { ok: false, available: true, format_only: [], structural: [] }],
  ['available が boolean でない', { ok: true, available: 'yes', format_only: [], structural: [] }],
  ['format_only が配列でない', { ok: true, available: true, format_only: 'x', structural: [] }],
  ['structural が配列でない', { ok: true, available: true, format_only: [], structural: 'x' }],
  ['struct が null', null],
  ['struct 欠落', undefined],
])('parseSecfloorFields(unified).struct: %s → null（fail-open）', (_name, struct) => {
  const unified = { risk: { ok: true, hits: [] } };
  if (struct !== undefined) unified.struct = struct;
  assert.equal(parseSecfloorFields(unified).struct, null);
});

// ---- secreview フィールドの fail-safe（issue #1063）----
// pr-iterate の security review の対象判定。形の正しい {target, reasons} だけを採り、欠落・型不正は対象に倒す
// （判定入力の不明を「信頼境界をまたがない」と同一視しない）。他フィールドの判定には波及しない。

test.each([
  ['対象', { target: true, reasons: ['path_write: bin/x.sh'] }],
  ['対象外', { target: false, reasons: [] }],
])('parseSecfloorFields(unified).secreview: 形の正しい %s はそのまま採る', (_name, secreview) => {
  const unified = { risk: { ok: true, hits: [] }, files: ['a.js'], secreview };
  const result = parseSecfloorFields(unified);
  assert.deepEqual(result.secreview, secreview);
  assert.deepEqual(result.files, ['a.js']);
});

test.each([
  ['欠落', undefined],
  ['null', null],
  ['target が boolean でない', { target: 'yes', reasons: [] }],
  ['reasons が配列でない', { target: false, reasons: 'x' }],
  ['reasons に string 以外', { target: false, reasons: [1] }],
])('parseSecfloorFields(unified).secreview: %s → 対象に倒す（fail-safe）、risk / files は不変', (_name, secreview) => {
  const unified = { risk: { ok: true, hits: [] }, files: ['a.js'] };
  if (secreview !== undefined) unified.secreview = secreview;
  const result = parseSecfloorFields(unified);
  assert.deepEqual(result.secreview, { target: true, reasons: [SECREVIEW_UNAVAILABLE_REASON] });
  assert.deepEqual(result.risk, { ok: true, hits: [] });
  assert.deepEqual(result.files, ['a.js']);
});
