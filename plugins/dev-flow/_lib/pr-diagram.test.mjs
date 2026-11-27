// @vitest-environment jsdom
// 構成の変化の図（issue #1448）: buildPrBody が構造化データから組み立てた Mermaid の本文を、devDependency の mermaid の parser に
// 通して確かめる。mermaid は DOM を要るので jsdom の上で動かす（plugin の実行時は mermaid を使わない）。
import { test } from 'vitest';
import assert from 'node:assert/strict';
import mermaid from 'mermaid';
import { buildPrBody, PR_DIAGRAM_KINDS } from './pr-artifacts.mjs';

mermaid.initialize({ startOnLoad: false });

// PR 本文の mermaid フェンスの中身（before・after の順）。
function fencesOf(diagram) {
  const body = buildPrBody({ issue: 1, req: { acceptance_criteria: [] }, plan: { diagram }, testsurfHits: [], dangerHits: [] });
  return [...body.matchAll(/^(`{3,})mermaid\n([\s\S]*?)\n\1$/gm)].map((m) => m[2]);
}

// mermaid が parse した図のラベル。mermaid はエンティティ記法（`#<code point>;`）を parse の前に内部の印（ﬂ°°<code point>¶ß）へ
// 置き換え、描画の最後に文字へ戻す。ここでは同じ印を文字へ戻して、描画で見える文字列にする。
const shown = (s) => s.replace(/ﬂ°°(\d+)¶ß/g, (_, n) => String.fromCodePoint(Number(n)));
async function parsedLabels(kind, src) {
  const { db } = await mermaid.mermaidAPI.getDiagramFromText(src);
  if (kind === 'flowchart') {
    return {
      nodes: Object.fromEntries([...db.getVertices().values()].map((v) => [v.id, shown(v.text)])),
      edges: db.getEdges().map((e) => ({ from: e.start, to: e.end, label: shown(e.text) })),
    };
  }
  if (kind === 'sequence') {
    return {
      nodes: Object.fromEntries([...db.getActors().values()].map((a) => [a.name, shown(a.description)])),
      edges: db.getMessages().map((m) => ({ from: m.from, to: m.to, label: shown(m.message) })),
    };
  }
  const entities = [...db.getEntities().values()];
  const outputId = (entityId) => entities.find((e) => e.id === entityId).label;
  return {
    nodes: Object.fromEntries(entities.map((e) => [e.label, shown(e.alias)])),
    edges: db.getRelationships().map((r) => ({ from: outputId(r.entityA), to: outputId(r.entityB), label: shown(r.roleA) })),
  };
}

const ANCHORS = [{ node: 'call', ref: 'src/page.tsx:confirm' }];

test('[pr-diagram] 出力のノード ID は入力の ID・ラベルに依らず n1, n2, … で、before と after で同じ入力 ID には同じ出力 ID を振る', () => {
  const [before, after] = fencesOf({
    kind: 'flowchart',
    before: {
      nodes: [{ id: 'click', label: '確定ボタンを押す' }, { id: 'call', label: '確定の API を呼ぶ' }, { id: 'retry', label: 'もう一度の文言を出す' }],
      edges: [{ from: 'click', to: 'call' }, { from: 'call', to: 'retry', label: '失敗の種類を問わない' }],
    },
    after: {
      // after にだけあるノード（kind・invalid）を先に並べても、before と共通の入力 ID は before で振った出力 ID のまま
      nodes: [
        { id: 'kind', label: '400 で使えないリンクの文言がある', shape: 'decision' }, { id: 'invalid', label: 'このリンクは使えませんを出す' },
        { id: 'retry', label: '時間をおいてもう一度の文言を出す' }, { id: 'call', label: '確定の API を呼ぶ' }, { id: 'click', label: '確定ボタンを押す' },
      ],
      edges: [{ from: 'click', to: 'call' }, { from: 'call', to: 'kind', label: '失敗' }, { from: 'kind', to: 'invalid', label: 'はい' }, { from: 'kind', to: 'retry', label: 'いいえ' }],
    },
    anchors: ANCHORS,
  });
  assert.equal(before, [
    'flowchart LR',
    '  n1["確定ボタンを押す"]',
    '  n2["確定の API を呼ぶ"]',
    '  n3["もう一度の文言を出す"]',
    '  n1 --> n2',
    '  n2 -->|"失敗の種類を問わない"| n3',
  ].join('\n'));
  assert.equal(after, [
    'flowchart LR',
    '  n4{"400 で使えないリンクの文言がある"}',
    '  n5["このリンクは使えませんを出す"]',
    '  n3["時間をおいてもう一度の文言を出す"]',
    '  n2["確定の API を呼ぶ"]',
    '  n1["確定ボタンを押す"]',
    '  n1 --> n2',
    '  n2 -->|"失敗"| n4',
    '  n4 -->|"はい"| n5',
    '  n4 -->|"いいえ"| n3',
  ].join('\n'));
});

// 描画でそのまま見えるべき記号を含むラベル（" < > ` # と、mermaid が HTML・エンティティ・アイコンとして読みうる書き方）
const SYMBOL_LABEL = 'a "q" <b>x</b> `m` #35; &lt; fa:fa-x # 100%';
const SYMBOL_DIAGRAMS = {
  flowchart: {
    nodes: [{ id: 'a', label: `ノード ${SYMBOL_LABEL}` }, { id: 'b', label: `条件 ${SYMBOL_LABEL}`, shape: 'decision' }],
    edges: [{ from: 'a', to: 'b', label: `辺 ${SYMBOL_LABEL}` }],
  },
  sequence: {
    nodes: [{ id: 'a', label: `参加者 ${SYMBOL_LABEL}` }, { id: 'b', label: `相手 ${SYMBOL_LABEL}` }],
    edges: [{ from: 'a', to: 'b', label: `メッセージ ${SYMBOL_LABEL}` }],
  },
  er: {
    nodes: [{ id: 'a', label: `エンティティ ${SYMBOL_LABEL}` }, { id: 'b', label: `相手 ${SYMBOL_LABEL}` }],
    edges: [{ from: 'a', to: 'b', label: `関係 ${SYMBOL_LABEL}`, cardinality: 'one_to_many' }],
  },
};

for (const kind of PR_DIAGRAM_KINDS) {
  test(`[pr-diagram] ${kind}: " < > \` # を含むラベルはエンティティ記法でエスケープされ、mermaid が読んだラベルは入力の文字列へ戻る`, async () => {
    const side = SYMBOL_DIAGRAMS[kind];
    const fences = fencesOf({ kind, before: side, after: side, anchors: ANCHORS });
    assert.equal(fences.length, 2);
    for (const src of fences) {
      // 本文には記号をそのまま置かない（ラベルの記号はすべて #<code point>; になっている）
      for (const raw of ['<b>', '`m`', '"q"', '&lt;', 'fa:fa-x']) assert.ok(!src.includes(raw), `${raw} がエスケープされていない:\n${src}`);
      assert.ok(src.includes('#34;q#34; #60;b#62;x#60;#47;b#62; #96;m#96; #35;35#59; #38;lt#59;'), src);
      const parsed = await parsedLabels(kind, src);
      assert.deepEqual(parsed.nodes, { n1: side.nodes[0].label, n2: side.nodes[1].label });
      assert.deepEqual(parsed.edges, [{ from: 'n1', to: 'n2', label: side.edges[0].label }]);
    }
  });
}

// 入力の ID・ラベルに置く予約語と記号。ID は anchors の node と同じ 64 字までなので、記号の列は ID 用とラベル用に分ける
const RESERVED = ['call', 'end', 'click', 'graph', 'style', 'subgraph', 'class', 'default'];
const HOSTILE_ID = 'end "[]{}()|;#<>`-->\n x';
const HOSTILE_LABEL = 'call end "x" [a] {b} (c) |d| ; # <br/> `m` --> a\nb\r\nc style';
const hostileSide = (kind, extraNodes = []) => ({
  nodes: [
    ...RESERVED.map((w) => ({ id: w, label: w, ...(kind === 'flowchart' && w === 'end' ? { shape: 'decision' } : {}) })),
    {
      id: HOSTILE_ID, label: HOSTILE_LABEL,
      ...(kind === 'er' ? { attributes: [{ name: 'PK', type: 'end' }, { name: '1 a-b', type: 'FK名' }, { name: HOSTILE_LABEL, type: HOSTILE_LABEL }] } : {}),
    },
    ...extraNodes,
  ],
  edges: [
    ...RESERVED.map((w, i) => ({ from: w, to: RESERVED[(i + 1) % RESERVED.length], label: w, cardinality: 'one_to_many' })),
    { from: HOSTILE_ID, to: 'end', label: HOSTILE_LABEL, cardinality: 'many_to_many' },
    { from: 'end', to: 'end', label: HOSTILE_ID, cardinality: 'one_to_one' },
    ...(kind === 'flowchart' ? [{ from: 'call', to: HOSTILE_ID }] : []),
  ],
});

for (const kind of PR_DIAGRAM_KINDS) {
  test(`[pr-diagram] ${kind}: 入力の ID・ラベルが予約語と記号・改行を含んでも、PR 本文の mermaid フェンスはすべて mermaid の parser を通る`, async () => {
    const fences = fencesOf({
      kind, before: hostileSide(kind), after: hostileSide(kind, [{ id: 'graph TD', label: 'subgraph end' }]),
      anchors: [{ node: 'call', ref: 'src/a.mjs:call' }],
    });
    assert.equal(fences.length, 2, 'before / after の 2 つのフェンスが出ていない');
    for (const src of fences) {
      // parse は構文エラーで reject する
      assert.deepEqual(await mermaid.parse(src), { diagramType: { flowchart: 'flowchart-v2', sequence: 'sequence', er: 'er' }[kind], config: {} }, src);
      const parsed = await parsedLabels(kind, src);
      assert.deepEqual(Object.keys(parsed.nodes).slice(0, 9), ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8', 'n9']);
      // 改行・連続空白は 1 空白に畳まれ、他の文字は入力のまま
      assert.equal(parsed.nodes.n9, 'call end "x" [a] {b} (c) |d| ; # <br/> `m` --> a b c style');
      assert.deepEqual(RESERVED.map((_, i) => parsed.nodes[`n${i + 1}`]), RESERVED);
    }
  });
}

test('[pr-diagram] 入力の ID をそのまま Mermaid の文に置いた図は parser を通らない（parser が予約語を構文エラーにすることの確認）', async () => {
  await assert.rejects(mermaid.parse('flowchart LR\n  call[確定の API を呼ぶ] --> end[終わり]'));
});
