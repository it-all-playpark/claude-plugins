// docs/dev-flow-atlas.md の「ループ上限」表が実装ソースの定数と一致することを検証する。
//
// なぜ必要か: atlas は実装から起こした図であり、ソース側の定数だけ変えて図を放置すると
// 「腐って現行 invariant と逆を指示するドキュメント」になる（AGENTS.md の禁止形）。
// 図の構造（phase 遷移・分岐）は機械検証できないが、数値は照合できるので silent な腐りを
// ここで CI failure に変える。
//
// 表は docs/dev-flow-atlas.md の atlas:loop-constants マーカー区間から読む。
// マーカー・行の欠落・余剰はすべて failure にする（行を消せば通る vacuous なテストにしない）。
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const atlasPath = join(REPO_ROOT, 'docs/dev-flow-atlas.md');
const devFlowPath = join(repoRoot, '.claude/workflows/dev-flow.js');
const evaluatePath = join(repoRoot, '.claude/workflows/dev-flow-evaluate.js');
const prIteratePath = join(repoRoot, '.claude/workflows/pr-iterate.js');

const BEGIN = '<!-- atlas:loop-constants:begin -->';
const END = '<!-- atlas:loop-constants:end -->';

// 定数名 → 宣言が存在すべきソースファイル。
// ここに列挙した集合と表の行集合が完全一致することを検証するため、
// 片方だけに定数を足しても落ちる（新規定数の記載漏れ・表の余剰行の両方を検出する）。
const EXPECTED_SOURCE = {
  EVAL_MAX: evaluatePath,
  EVAL_STUCK: evaluatePath,
  DESIGN_REPLAN_MAX: evaluatePath,
  GREEN_MAX: devFlowPath,
  BLOCK_MAX: devFlowPath,
  AGENT_AC_REIMPL_MAX: devFlowPath,
  REVIEW_STUCK: prIteratePath,
  CI_WAIT_CEILING_SECONDS: prIteratePath,
};

function readAtlasTable() {
  const src = readFileSync(atlasPath, 'utf8');
  const begin = src.indexOf(BEGIN);
  const end = src.indexOf(END);
  assert.notStrictEqual(begin, -1, `${BEGIN} が docs/dev-flow-atlas.md に見つからない`);
  assert.notStrictEqual(end, -1, `${END} が docs/dev-flow-atlas.md に見つからない`);
  assert.ok(begin < end, 'atlas:loop-constants のマーカー順序が begin → end になっていない');

  const block = src.slice(begin + BEGIN.length, end);
  const rows = new Map();
  // | `NAME` | 12 | 説明 |
  for (const m of block.matchAll(/^\|\s*`([A-Z_]+)`\s*\|\s*(\d+)\s*\|/gm)) {
    assert.ok(!rows.has(m[1]), `表に ${m[1]} の行が重複している`);
    rows.set(m[1], Number(m[2]));
  }
  return rows;
}

function readSourceConstant(path, name) {
  const src = readFileSync(path, 'utf8');
  const matches = [...src.matchAll(new RegExp(`^const ${name} = (\\d+)`, 'gm'))];
  assert.strictEqual(
    matches.length, 1,
    `${path} に \`const ${name} = <数値>\` がちょうど 1 つ見つからなかった（${matches.length} 件）`,
  );
  return Number(matches[0][1]);
}

test('atlas のループ上限表がマーカー区間から読め、行が 1 つ以上ある', () => {
  const rows = readAtlasTable();
  assert.ok(rows.size > 0, 'atlas:loop-constants 区間に `NAME` | 値 形式の行が 1 つも無い');
});

test('atlas のループ上限表の行集合が期待する定数集合と完全一致する', () => {
  const rows = readAtlasTable();
  const inTable = [...rows.keys()].sort();
  const expected = Object.keys(EXPECTED_SOURCE).sort();
  assert.deepStrictEqual(
    inTable, expected,
    '表の定数名が期待集合と一致しない（定数を追加/削除したら表と EXPECTED_SOURCE の両方を更新すること）',
  );
});

for (const [name, path] of Object.entries(EXPECTED_SOURCE)) {
  test(`atlas の ${name} が実装ソースの値と一致する`, () => {
    const rows = readAtlasTable();
    const documented = rows.get(name);
    assert.notStrictEqual(
      documented, undefined,
      `docs/dev-flow-atlas.md のループ上限表に ${name} の行が無い`,
    );
    const actual = readSourceConstant(path, name);
    assert.strictEqual(
      documented, actual,
      `${name}: atlas は ${documented} と書いているがソースは ${actual}`
        + `（${path.replace(repoRoot + '/', '')} を変えたら docs/dev-flow-atlas.md も更新すること）`,
    );
  });
}
