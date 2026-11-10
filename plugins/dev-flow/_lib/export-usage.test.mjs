// _lib/export-usage.test.mjs
// 逆参照の検査: _lib/*.mjs の各 export が、実行経路（テスト以外）のどこかから使われていることを確かめる。
// 最後の呼び出し元を消した変更・テストからしか参照されない export を足した変更を red にする。
//
// 「使われている」= 自モジュール内に定義以外の出現がある、または plugins/ 配下の他の非テストファイルに語として現れる。
// workflow（.claude/workflows/*.js）の inline 区間は _lib の写しなので、そのモジュール自身の区間は数えない
// （数えると、inline されただけで誰も呼ばない export が「使われている」になる）。
// README・docs・.claude/rules・tests/ は plugins/ の外なので参照に数えない（説明だけが残った孤立を見逃さないため）。
// 判定は語単位の文字列一致（識別子の token 化）で、コメント内の言及も出現に数える。
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';

const pluginsRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// 孤立のまま残す export。載せてよいのは、削除すると壊れる理由があるものだけ
// （「テストが参照している」は理由にしない — そのテストごと消す）。
// 形: { module: '<name>.mjs', name: '<export 名>', reason: '<削除すると何が壊れるか>' }
const ALLOWLIST = [];

const EXPORT_RE = /^export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/;
const IDENT_RE = /[A-Za-z_$][\w$]*/g;
const BEGIN_INLINE_RE = /^\/\/ ==== BEGIN inline: (\S+)/;
const END_INLINE_RE = /^\/\/ ==== END inline: (\S+) ====/;

function isTestPath(rel) {
  const parts = rel.split(sep);
  const base = parts[parts.length - 1];
  if (base.endsWith('.bats') || base.endsWith('.test.mjs') || base.endsWith('.test.sh')) return true;
  return parts.slice(0, -1).some(p => p === 'test-helpers' || p === 'tests');
}

function listFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name !== 'node_modules' && ent.name !== '.git') walk(p);
      } else if (ent.isFile()) {
        out.push(p);
      }
    }
  };
  walk(root);
  return out.sort();
}

function identCounts(src) {
  const counts = new Map();
  for (const m of src.matchAll(IDENT_RE)) counts.set(m[0], (counts.get(m[0]) || 0) + 1);
  return counts;
}

// 行頭 `export ` のうち EXPORT_RE で名前を取れない行（`export { a, b }`・`export default` 等）。
// 取れない形は検査をすり抜けるので、呼び出し側で 0 件を確かめる。
function exportLines(src) {
  const names = [];
  const unsupported = [];
  for (const line of src.split('\n')) {
    if (!/^export\b/.test(line)) continue;
    const m = line.match(EXPORT_RE);
    if (m) names.push(m[1]);
    else unsupported.push(line);
  }
  return { names, unsupported };
}

// workflow のソースを「inline 区間の外」と「区間ごと（canonical のパス別）」に分ける。
function splitInlineZones(src) {
  const outside = [];
  const zones = new Map();
  let open = null;
  for (const line of src.split('\n')) {
    const begin = line.match(BEGIN_INLINE_RE);
    if (open === null && begin) {
      open = begin[1];
      if (!zones.has(open)) zones.set(open, []);
      continue;
    }
    if (open !== null) {
      const end = line.match(END_INLINE_RE);
      if (end && end[1] === open) open = null;
      else zones.get(open).push(line);
      continue;
    }
    outside.push(line);
  }
  return { outside: outside.join('\n'), zones };
}

// plugins root を受け取り、<root>/dev-flow/_lib/*.mjs の export のうち孤立しているものを
// [{ module, name }] で返す。unsupported は名前を取れなかった export 行。
function scanExportUsage(root) {
  const libDir = join(root, 'dev-flow', '_lib');
  const wfDir = join(root, 'dev-flow', '.claude', 'workflows');
  const sources = listFiles(root)
    .filter(p => !isTestPath(relative(root, p)))
    .map((p) => {
      const src = readFileSync(p, 'utf8');
      if (dirname(p) === wfDir && p.endsWith('.js')) {
        const { outside, zones } = splitInlineZones(src);
        return {
          path: p,
          idents: identCounts(outside),
          zones: [...zones].map(([source, lines]) => ({ source, idents: identCounts(lines.join('\n')) })),
        };
      }
      return { path: p, idents: identCounts(src), zones: [] };
    });

  const orphans = [];
  const unsupported = [];
  let total = 0;
  for (const self of sources) {
    if (dirname(self.path) !== libDir || !self.path.endsWith('.mjs')) continue;
    const module = relative(libDir, self.path);
    const exported = exportLines(readFileSync(self.path, 'utf8'));
    for (const line of exported.unsupported) unsupported.push({ module, line });
    for (const name of exported.names) {
      total++;
      if ((self.idents.get(name) || 0) > 1) continue;
      const usedElsewhere = sources.some(other => other !== self && (
        other.idents.has(name)
        || other.zones.some(z => z.source !== `_lib/${module}` && z.idents.has(name))
      ));
      if (!usedElsewhere) orphans.push({ module, name });
    }
  }
  return { orphans, unsupported, total };
}

// 許可リストと孤立の一覧を突き合わせ、問題を文字列の配列で返す（空なら問題なし）。
function exportUsageProblems(orphans, allowlist) {
  const key = e => `${e.module}:${e.name}`;
  const problems = [];
  for (const e of allowlist) {
    if (typeof e.module !== 'string' || e.module === '' || typeof e.name !== 'string' || e.name === '') {
      problems.push(`許可リストのエントリに module / name が無い: ${JSON.stringify(e)}`);
      continue;
    }
    if (typeof e.reason !== 'string' || e.reason.trim() === '') {
      problems.push(`許可リストの理由が空: ${key(e)}`);
    }
    if (!orphans.some(o => key(o) === key(e))) {
      problems.push(`許可リストにあるが孤立していない（エントリを消す）: ${key(e)}`);
    }
  }
  const allowed = new Set(allowlist.map(key));
  for (const o of orphans) {
    if (!allowed.has(key(o))) {
      problems.push(`実行経路から使われていない export（削除するか、削除すると壊れる理由を許可リストに書く）: ${key(o)}`);
    }
  }
  return problems;
}

// -----------------------------------------------------------------------------
// 実 tree
// -----------------------------------------------------------------------------
const real = scanExportUsage(pluginsRoot);

test('_lib/*.mjs の export は名前を取れる形（export function / const / class）だけで書かれている', () => {
  assert.ok(real.total > 0, '_lib の export を 1 個も読めていない');
  assert.deepEqual(real.unsupported, []);
});

test('_lib/*.mjs の各 export は自モジュール内か plugins/ 配下の他の非テストファイルから使われている（許可リストを除く）', () => {
  assert.deepEqual(exportUsageProblems(real.orphans, ALLOWLIST), []);
});

// -----------------------------------------------------------------------------
// fixture
// -----------------------------------------------------------------------------
function withFixture(files, fn) {
  const root = mkdtempSync(join(tmpdir(), 'export-usage-'));
  try {
    for (const [rel, body] of Object.entries(files)) {
      const p = join(root, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, body);
    }
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const FIXTURE = {
  'dev-flow/_lib/a.mjs': [
    'export const TEST_ONLY = 1;',
    'export function inlineOnly() { return 1; }',
    'export const SELF_USED = 2;',
    'export function usesSelf() { return SELF_USED; }',
    'export async function usedByOther() { return 3; }',
    '',
  ].join('\n'),
  'dev-flow/_lib/b.mjs': [
    "import { usedByOther } from './a.mjs';",
    'export function entry() { return usedByOther(); }',
    '',
  ].join('\n'),
  'dev-flow/_lib/a.test.mjs': "import { TEST_ONLY } from './a.mjs';\n",
  'dev-flow/_lib/test-helpers/h.mjs': "import { TEST_ONLY } from '../a.mjs';\n",
  'dev-flow/tests/t.sh': 'echo TEST_ONLY\n',
  'dev-flow/scripts/x.bats': '# TEST_ONLY\n',
  'dev-flow/scripts/x.test.sh': '# TEST_ONLY\n',
  'dev-flow/.claude/workflows/wf.js': [
    '// ==== BEGIN inline: _lib/a.mjs (生成区間) ====',
    'function inlineOnly() { return 1; }',
    'function usesSelf() { return SELF_USED; }',
    '// ==== END inline: _lib/a.mjs ====',
    '// ==== BEGIN inline: _lib/b.mjs (生成区間) ====',
    'function entry() { return usedByOther(); }',
    '// ==== END inline: _lib/b.mjs ====',
    'usesSelf(); entry();',
    '',
  ].join('\n'),
};

test('fixture: テストファイルからだけ参照される export と、自モジュールの inline 区間にだけ現れる export を孤立にする', () => {
  const { orphans, unsupported } = withFixture(FIXTURE, scanExportUsage);
  assert.deepEqual(unsupported, []);
  assert.deepEqual(orphans, [
    { module: 'a.mjs', name: 'TEST_ONLY' },
    { module: 'a.mjs', name: 'inlineOnly' },
  ]);
});

test('fixture: 他モジュールの inline 区間・inline 区間の外・他の非テストファイルからの参照が 1 つあれば孤立にしない', () => {
  const orphansWith = extra => withFixture({ ...FIXTURE, ...extra }, scanExportUsage).orphans.map(o => o.name);
  assert.deepEqual(orphansWith({
    'dev-flow/.claude/workflows/wf.js': FIXTURE['dev-flow/.claude/workflows/wf.js'] + 'inlineOnly();\n',
  }), ['TEST_ONLY']);
  assert.deepEqual(orphansWith({
    'dev-flow/.claude/workflows/wf.js': FIXTURE['dev-flow/.claude/workflows/wf.js'].replace(
      'function entry() { return usedByOther(); }',
      'function entry() { return usedByOther() + inlineOnly(); }',
    ),
  }), ['TEST_ONLY']);
  assert.deepEqual(orphansWith({ 'playpark-core/scripts/run.sh': 'echo TEST_ONLY\n' }), ['inlineOnly']);
  // 語単位: 名前を含むだけの別の識別子は参照に数えない
  assert.deepEqual(orphansWith({ 'playpark-core/scripts/run.sh': 'echo TEST_ONLY_X inlineOnlyX\n' }), ['TEST_ONLY', 'inlineOnly']);
});

test('fixture: 名前を取れない export の形（export { ... }）は unsupported に出す', () => {
  const { unsupported } = withFixture({ 'dev-flow/_lib/c.mjs': 'const x = 1;\nexport { x };\n' }, scanExportUsage);
  assert.deepEqual(unsupported, [{ module: 'c.mjs', line: 'export { x };' }]);
});

test('許可リスト: 理由付きで載った孤立は通し、載っていない孤立は名前を出して落とす', () => {
  const orphans = [{ module: 'a.mjs', name: 'TEST_ONLY' }, { module: 'a.mjs', name: 'inlineOnly' }];
  assert.deepEqual(exportUsageProblems(orphans, [
    { module: 'a.mjs', name: 'TEST_ONLY', reason: '外部の skill が import する' },
    { module: 'a.mjs', name: 'inlineOnly', reason: '外部の skill が import する' },
  ]), []);
  const problems = exportUsageProblems(orphans, [{ module: 'a.mjs', name: 'TEST_ONLY', reason: '外部の skill が import する' }]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /a\.mjs:inlineOnly/);
});

test('許可リスト: 理由が空・空白だけ・無いエントリがあると落とす', () => {
  const orphans = [{ module: 'a.mjs', name: 'TEST_ONLY' }];
  for (const reason of ['', '   ', undefined]) {
    const problems = exportUsageProblems(orphans, [{ module: 'a.mjs', name: 'TEST_ONLY', reason }]);
    assert.equal(problems.length, 1, String(reason));
    assert.match(problems[0], /理由が空: a\.mjs:TEST_ONLY/);
  }
});

test('許可リスト: module / name が無いエントリがあると落とす', () => {
  for (const entry of [{ name: 'X', reason: 'r' }, { module: 'a.mjs', reason: 'r' }]) {
    const problems = exportUsageProblems([], [entry]);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /module \/ name が無い/);
  }
});

test('許可リスト: 載っているのに孤立でなくなったエントリがあると落とす', () => {
  const problems = exportUsageProblems([], [{ module: 'a.mjs', name: 'SELF_USED', reason: '外部の skill が import する' }]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /孤立していない.*a\.mjs:SELF_USED/);
});
