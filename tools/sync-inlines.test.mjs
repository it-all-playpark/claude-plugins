// tools/sync-inlines.test.mjs
// node:test fixture-based tests for tools/sync-inlines.mjs
//
// Fixtures are generated at runtime in a tmpdir; never committed.
// Cleanup is done in finally blocks to ensure removal even on failure.

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import {
  stripComments,
  dropComments,
  checkForbiddenTokens,
  transformCanonical,
  scanMarkers,
  syncRepo,
  collectTopLevelDeclNames,
  insertMarkerPair,
  removeMarkerPair,
  selectReferencedDecls,
  splitTopLevelStatements,
} from './sync-inlines.mjs';

const SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), 'sync-inlines.mjs');

// Helper: create a minimal fixture repo in a tmpdir
// extraCanonicals: { 'fake2.mjs': content, ... } — written to _lib/ alongside fake.mjs
function makeFixtureRepo(canonicalContent, workflowContent, { multiWf = false, secondWfContent = null, extraCanonicals = {} } = {}) {
  const tmp = mkdtempSync(join(os.tmpdir(), 'sync-inlines-'));
  mkdirSync(join(tmp, '_lib'), { recursive: true });
  mkdirSync(join(tmp, '.claude', 'workflows'), { recursive: true });
  writeFileSync(join(tmp, '_lib', 'fake.mjs'), canonicalContent, 'utf8');
  writeFileSync(join(tmp, '.claude', 'workflows', 'wf.js'), workflowContent, 'utf8');
  if (multiWf && secondWfContent !== null) {
    writeFileSync(join(tmp, '.claude', 'workflows', 'wf2.js'), secondWfContent, 'utf8');
  }
  for (const [name, content] of Object.entries(extraCanonicals)) {
    writeFileSync(join(tmp, '_lib', name), content, 'utf8');
  }
  return tmp;
}

// Helper: run CLI via spawnSync
function runCli(args) {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...args], { encoding: 'utf8' });
}

// ─────────────────────────────────────────────────────────────────────────────
// Test (1): export prefix stripping — all variants
// ─────────────────────────────────────────────────────────────────────────────

test('transformCanonical strips export function', () => {
  const src = `export function foo() {\n  return 1;\n}\n`;
  const result = transformCanonical(src, 'test');
  assert.equal(result, `function foo() {\n  return 1;\n}\n`);
});

test('transformCanonical strips export const', () => {
  const src = `export const FOO = 42;\n`;
  assert.equal(transformCanonical(src, 'test'), `const FOO = 42;\n`);
});

test('transformCanonical strips export let', () => {
  const src = `export let bar = 'x';\n`;
  assert.equal(transformCanonical(src, 'test'), `let bar = 'x';\n`);
});

test('transformCanonical strips export class', () => {
  const src = `export class MyClass {}\n`;
  assert.equal(transformCanonical(src, 'test'), `class MyClass {}\n`);
});

test('transformCanonical strips export async function', () => {
  const src = `export async function doThing() {}\n`;
  assert.equal(transformCanonical(src, 'test'), `async function doThing() {}\n`);
});

test('transformCanonical drops comments', () => {
  const src = `// This exports something\nexport const X = 1; // why\n\n/**\n * doc\n */\nexport function f() {}\n// end\n`;
  assert.equal(transformCanonical(src, 'test'), `const X = 1;\n\nfunction f() {}\n`);
});

// ─────────────────────────────────────────────────────────────────────────────
// dropComments: literal content must survive byte-for-byte (the output is executed)
// ─────────────────────────────────────────────────────────────────────────────

test('dropComments keeps comment-like text inside string literals', () => {
  const src = `const a = 'http://x'; // c\nconst b = "/* not */";\n`;
  assert.equal(dropComments(src), `const a = 'http://x';\nconst b = "/* not */";\n`);
});

test('dropComments keeps template literal lines that look like comments, including nested ${ }', () => {
  const src = 'const t = `\n// kept\n${ x ? `/* in */` : { a: 1 }.a } // also kept\n`; // dropped\n';
  assert.equal(dropComments(src), 'const t = `\n// kept\n${ x ? `/* in */` : { a: 1 }.a } // also kept\n`;\n');
});

test('dropComments keeps regex literals containing slashes and quotes', () => {
  const src = `const r = /^\\/\\/ ['"]/g; // c\nconst s = x.replace(/[/*]/, '');\nreturn /\\/\\//.test(y);\n`;
  assert.equal(dropComments(src), `const r = /^\\/\\/ ['"]/g;\nconst s = x.replace(/[/*]/, '');\nreturn /\\/\\//.test(y);\n`);
});

test('dropComments treats / after an expression as division', () => {
  const src = `const q = (a) / b / c; // half\nconst w = arr[0] / 2;\n`;
  assert.equal(dropComments(src), `const q = (a) / b / c;\nconst w = arr[0] / 2;\n`);
});

test('dropComments turns an inline block comment into a space and keeps block-comment newlines', () => {
  assert.equal(dropComments(`a/**/b\n`), `a b\n`);
  // The newline inside the comment is a line terminator for ASI: `x = 1 \n y()` must stay 2 statements.
  assert.equal(dropComments(`x = 1 /* a\n b */ y()\n`), `x = 1 \n y()\n`);
});

test('dropComments drops comment-only lines but keeps originally blank lines', () => {
  const src = `a();\n\n  // gone\n/*\n * gone\n */\nb();\n`;
  assert.equal(dropComments(src), `a();\n\nb();\n`);
});

test('transformCanonical normalizes trailing newline to exactly one', () => {
  const src = `export const A = 1;\n\n\n`;
  const result = transformCanonical(src, 'test');
  assert.ok(result.endsWith('\n'));
  assert.ok(!result.endsWith('\n\n'));
});

test('transformCanonical errors on export default', () => {
  const src = `export default function() {}\n`;
  assert.throws(() => transformCanonical(src, 'test'), /export default/i);
});

test('transformCanonical errors on export { }', () => {
  const src = `export { foo, bar };\n`;
  assert.throws(() => transformCanonical(src, 'test'), /export/i);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test (2): --write then --check exit codes
// ─────────────────────────────────────────────────────────────────────────────

test('--write then --check exits 0 (no drift)', () => {
  const canonical = `export const VALUE = 99;\n`;
  const markerBegin = `// ==== BEGIN inline: _lib/fake.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====`;
  const markerEnd = `// ==== END inline: _lib/fake.mjs ====`;
  const wf = `${markerBegin}\n// old content\n${markerEnd}\nuse(VALUE);\n`;
  const tmp = makeFixtureRepo(canonical, wf);
  try {
    const writeResult = runCli(['--write', '--root', tmp]);
    assert.equal(writeResult.status, 0, `--write failed: ${writeResult.stderr}`);
    const checkResult = runCli(['--check', '--root', tmp]);
    assert.equal(checkResult.status, 0, `--check should be 0 after --write, got: ${checkResult.stderr}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('--check exits 1 when inline section has 1-byte drift', () => {
  const canonical = `export const VALUE = 99;\n`;
  const markerBegin = `// ==== BEGIN inline: _lib/fake.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====`;
  const markerEnd = `// ==== END inline: _lib/fake.mjs ====`;
  // After transform, inline should be: `const VALUE = 99;\n`
  // We put a 1-byte drift: `const VALUE = 98;\n`
  const wf = `${markerBegin}\nconst VALUE = 98;\n${markerEnd}\nuse(VALUE);\n`;
  const tmp = makeFixtureRepo(canonical, wf);
  try {
    const checkResult = runCli(['--check', '--root', tmp]);
    assert.equal(checkResult.status, 1, `--check should be 1 on drift, got: ${checkResult.status}`);
    assert.ok(checkResult.stderr.includes('fake.mjs') || checkResult.stderr.length > 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Test (3): forbidden token guard
// ─────────────────────────────────────────────────────────────────────────────

test('stripComments removes // line comments', () => {
  const src = `// import foo from 'bar'\nconst x = 1;\n`;
  const stripped = stripComments(src);
  assert.ok(!stripped.includes('import'));
  assert.ok(stripped.includes('const x = 1;'));
});

test('stripComments removes /* block */ comments', () => {
  const src = `/* Date.now() here */\nconst y = 2;\n`;
  const stripped = stripComments(src);
  assert.ok(!stripped.includes('Date.now'));
  assert.ok(stripped.includes('const y = 2;'));
});

test('stripComments preserves string literals containing //', () => {
  const src = `const s = "foo // bar";\n`;
  const stripped = stripComments(src);
  assert.ok(stripped.includes('foo // bar'));
});

test('stripComments preserves template literals containing //', () => {
  const src = 'const s = `foo // bar`;\n';
  const stripped = stripComments(src);
  assert.ok(stripped.includes('foo // bar'));
});

test('checkForbiddenTokens: comment-only import does NOT error', () => {
  // gate-policy.mjs has 'import' in its header comment - must not error
  const src = `// INLINE COPY POLICY: ESM import を使えないため inline コピー\nexport const X = 1;\n`;
  // Should not throw
  assert.doesNotThrow(() => checkForbiddenTokens(src, 'test'));
});

test('checkForbiddenTokens: comment-only Date.now does NOT error', () => {
  const src = `// Date.now() の語を含む comment\nexport const X = 1;\n`;
  assert.doesNotThrow(() => checkForbiddenTokens(src, 'test'));
});

test('checkForbiddenTokens: code-level import statement errors', () => {
  const src = `import x from 'y';\nexport const X = 1;\n`;
  assert.throws(() => checkForbiddenTokens(src, 'test'), /import/i);
});

// Dynamic import is not necessarily line-initial. Each of these forms would previously slip
// past the line-anchored statement check, get inlined verbatim into .claude/workflows/*.js,
// and make that workflow unlaunchable (the harness rejects import expressions at parse time).
test('checkForbiddenTokens: mid-line `await import()` in code errors', () => {
  const src = `export function f() {\n  const m = await import('node:fs');\n  return m;\n}\n`;
  assert.throws(() => checkForbiddenTokens(src, 'test'), /import/i);
});

test('checkForbiddenTokens: assigned dynamic import in code errors', () => {
  const src = `export const p = import('node:fs');\n`;
  assert.throws(() => checkForbiddenTokens(src, 'test'), /import/i);
});

test('checkForbiddenTokens: returned dynamic import in code errors', () => {
  const src = `export function g() { return import('node:fs'); }\n`;
  assert.throws(() => checkForbiddenTokens(src, 'test'), /import/i);
});

test('checkForbiddenTokens: comment-only dynamic import does NOT error', () => {
  const src = `// import('node:fs') は parse 時に拒否される\nexport const X = 1;\n`;
  assert.doesNotThrow(() => checkForbiddenTokens(src, 'test'));
});

test('checkForbiddenTokens: the bare word "import" in code does NOT error (no false positive)', () => {
  const src = `export const MSG = 'import 式は使えない';\n`;
  assert.doesNotThrow(() => checkForbiddenTokens(src, 'test'));
});

test('checkForbiddenTokens: require() in code errors', () => {
  const src = `const m = require('mod');\nexport const X = 1;\n`;
  assert.throws(() => checkForbiddenTokens(src, 'test'), /require/i);
});

test('checkForbiddenTokens: Date.now() in code errors', () => {
  const src = `export const ts = Date.now();\n`;
  assert.throws(() => checkForbiddenTokens(src, 'test'), /Date\.now/i);
});

test('checkForbiddenTokens: Math.random() in code errors', () => {
  const src = `export const r = Math.random();\n`;
  assert.throws(() => checkForbiddenTokens(src, 'test'), /Math\.random/i);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test (4): export default errors
// ─────────────────────────────────────────────────────────────────────────────

test('syncRepo errors on canonical with export default', () => {
  const canonical = `export default function() {}\n`;
  const markerBegin = `// ==== BEGIN inline: _lib/fake.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====`;
  const markerEnd = `// ==== END inline: _lib/fake.mjs ====`;
  const wf = `${markerBegin}\n${markerEnd}\n`;
  const tmp = makeFixtureRepo(canonical, wf);
  try {
    assert.throws(() => syncRepo(tmp, { write: false }), /export/i);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Test (5): marker integrity errors
// ─────────────────────────────────────────────────────────────────────────────

test('scanMarkers errors on BEGIN without END', () => {
  const src = `// ==== BEGIN inline: _lib/fake.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====\ncode\n`;
  assert.throws(() => scanMarkers(src, 'wf.js'), /END.*missing|no matching END/i);
});

test('scanMarkers errors on END without preceding BEGIN', () => {
  const src = `// ==== END inline: _lib/fake.mjs ====\n`;
  assert.throws(() => scanMarkers(src, 'wf.js'), /BEGIN.*missing|unexpected END/i);
});

test('scanMarkers errors on BEGIN/END path mismatch', () => {
  const src = [
    `// ==== BEGIN inline: _lib/fake.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====`,
    `code`,
    `// ==== END inline: _lib/other.mjs ====`,
    ``,
  ].join('\n');
  assert.throws(() => scanMarkers(src, 'wf.js'), /mismatch|path/i);
});

test('syncRepo errors on duplicate inline of same canonical in one workflow', () => {
  const canonical = `export const X = 1;\n`;
  const markerBegin = `// ==== BEGIN inline: _lib/fake.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====`;
  const markerEnd = `// ==== END inline: _lib/fake.mjs ====`;
  const wf = `${markerBegin}\nconst X = 1;\n${markerEnd}\n${markerBegin}\nconst X = 1;\n${markerEnd}\n`;
  const tmp = makeFixtureRepo(canonical, wf);
  try {
    assert.throws(() => syncRepo(tmp, { write: false }), /duplicate/i);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('syncRepo errors when canonical file does not exist', () => {
  const markerBegin = `// ==== BEGIN inline: _lib/nonexistent.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====`;
  const markerEnd = `// ==== END inline: _lib/nonexistent.mjs ====`;
  const wf = `${markerBegin}\ncode\n${markerEnd}\n`;
  const tmp = mkdtempSync(join(os.tmpdir(), 'sync-inlines-'));
  mkdirSync(join(tmp, '_lib'), { recursive: true });
  mkdirSync(join(tmp, '.claude', 'workflows'), { recursive: true });
  writeFileSync(join(tmp, '.claude', 'workflows', 'wf.js'), wf, 'utf8');
  try {
    assert.throws(() => syncRepo(tmp, { write: false }), /not found|ENOENT|exist/i);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Test (6): same canonical inlined into two different workflow files
// ─────────────────────────────────────────────────────────────────────────────

test('syncRepo regenerates inline in both workflow files when canonical shared', () => {
  const canonical = `export const SHARED = 'hello';\n`;
  const markerBegin = `// ==== BEGIN inline: _lib/fake.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====`;
  const markerEnd = `// ==== END inline: _lib/fake.mjs ====`;
  const wf1 = `before\n${markerBegin}\nold content 1\n${markerEnd}\nuse(SHARED);\n`;
  const wf2 = `before\n${markerBegin}\nold content 2\n${markerEnd}\nuse(SHARED);\n`;
  const tmp = makeFixtureRepo(canonical, wf1, { multiWf: true, secondWfContent: wf2 });
  try {
    const result = syncRepo(tmp, { write: true });
    // Both files should be in results and changed
    const changedFiles = result.results.filter(r => r.changed).map(r => r.file);
    assert.ok(changedFiles.some(f => f.includes('wf.js')), 'wf.js should be changed');
    assert.ok(changedFiles.some(f => f.includes('wf2.js')), 'wf2.js should be changed');
    // Verify the written content
    const wf1Written = readFileSync(join(tmp, '.claude', 'workflows', 'wf.js'), 'utf8');
    const wf2Written = readFileSync(join(tmp, '.claude', 'workflows', 'wf2.js'), 'utf8');
    const expected = `const SHARED = 'hello';\n`;
    assert.ok(wf1Written.includes(expected), `wf.js should contain transformed content`);
    assert.ok(wf2Written.includes(expected), `wf2.js should contain transformed content`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Test (7): workflow file with zero markers passes through unchanged
// ─────────────────────────────────────────────────────────────────────────────

test('syncRepo leaves workflow file with no markers unchanged', () => {
  const canonical = `export const X = 1;\n`;
  const wf = `// just a regular workflow file\nconst a = 1;\n`;
  const tmp = makeFixtureRepo(canonical, wf);
  try {
    const result = syncRepo(tmp, { write: false });
    const wfResult = result.results.find(r => r.file.includes('wf.js'));
    // Either not in results or changed=false
    if (wfResult) {
      assert.equal(wfResult.changed, false);
    }
    // File content unchanged
    const written = readFileSync(join(tmp, '.claude', 'workflows', 'wf.js'), 'utf8');
    assert.equal(written, wf);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Only the declarations the workflow references are generated (issue #1268)
// ─────────────────────────────────────────────────────────────────────────────

test('--write generates only the declarations reachable from the hand-written part, in canonical order', () => {
  const canonical = [
    '// header comment',
    'export function used() { return helper(); }',
    '',
    'export function unused() { return 2; }',
    '',
    'export function helper() { return 1; }',
    '',
  ].join('\n');
  const markerBegin = `// ==== BEGIN inline: _lib/fake.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====`;
  const markerEnd = `// ==== END inline: _lib/fake.mjs ====`;
  const wf = `const r = used();\n${markerBegin}\n${markerEnd}\n`;
  const tmp = makeFixtureRepo(canonical, wf);
  try {
    const writeResult = runCli(['--write', '--root', tmp]);
    assert.equal(writeResult.status, 0, `--write failed: ${writeResult.stderr}`);
    const written = readFileSync(join(tmp, '.claude', 'workflows', 'wf.js'), 'utf8');
    assert.equal(
      written,
      `const r = used();\n${markerBegin}\nfunction used() { return helper(); }\n\nfunction helper() { return 1; }\n${markerEnd}\n`,
    );
    const checkResult = runCli(['--check', '--root', tmp]);
    assert.equal(checkResult.status, 0, `--check should pass after --write: ${checkResult.stderr}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('--check fails when a declaration nothing references is added to an inline region by hand', () => {
  const canonical = `export const USED = 1;\n\nexport const UNUSED = 2;\n`;
  const markerBegin = `// ==== BEGIN inline: _lib/fake.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====`;
  const markerEnd = `// ==== END inline: _lib/fake.mjs ====`;
  const wf = `${markerBegin}\nconst USED = 1;\n\nconst UNUSED = 2;\n${markerEnd}\nuse(USED);\n`;
  const tmp = makeFixtureRepo(canonical, wf);
  try {
    const checkResult = runCli(['--check', '--root', tmp]);
    assert.equal(checkResult.status, 1, `--check should report drift: ${checkResult.stderr}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('selectReferencedDecls counts identifiers inside string and template literals', () => {
  const regions = [{
    source: '_lib/fake.mjs',
    transformed: [
      'function fromString() { return 1; }',
      'function fromTemplate() { return `${viaNested()}`; }',
      'function viaNested() { return 2; }',
      'function dropped() { return 3; }',
      '',
    ].join('\n'),
  }];
  const [region] = selectReferencedDecls("const a = 'fromString';\nconst b = `x ${fromTemplate()}`;\n", regions);
  assert.equal(
    region.body,
    'function fromString() { return 1; }\nfunction fromTemplate() { return `${viaNested()}`; }\nfunction viaNested() { return 2; }\n',
  );
});

test('selectReferencedDecls always keeps statements whose declared name cannot be decided, and follows them', () => {
  const regions = [{
    source: '_lib/fake.mjs',
    transformed: [
      'const [first] = [seed()];',
      'const a = 1, b = 2;',
      'function seed() { return 0; }',
      'function dropped() { return 3; }',
      '',
    ].join('\n'),
  }];
  const [region] = selectReferencedDecls('run();\n', regions);
  assert.equal(region.body, 'const [first] = [seed()];\nconst a = 1, b = 2;\nfunction seed() { return 0; }\n');
});

test('selectReferencedDecls follows references across inline regions of the same workflow', () => {
  const regions = [
    { source: '_lib/a.mjs', transformed: 'function outer() { return inner(); }\nfunction notUsed() {}\n' },
    { source: '_lib/b.mjs', transformed: 'function inner() { return 1; }\nfunction alsoNotUsed() {}\n' },
  ];
  const result = selectReferencedDecls('outer();\n', regions);
  assert.deepEqual(result, [
    { source: '_lib/a.mjs', body: 'function outer() { return inner(); }\n' },
    { source: '_lib/b.mjs', body: 'function inner() { return 1; }\n' },
  ]);
});

test('splitTopLevelStatements keeps multi-line literals and nested blocks inside one statement', () => {
  const src = [
    'const T = `',
    'function notTopLevel() {}',
    '`;',
    'const C = `continued\\',
    'function alsoNotTopLevel() {}`;',
    '',
    'const O = {',
    'x: 1,',
    '};',
    'function f() {',
    '  return /}/.test(T);',
    '}',
    '',
  ].join('\n');
  const stmts = splitTopLevelStatements(src);
  assert.deepEqual(stmts.map(s => s.name), ['T', 'C', 'O', 'f']);
  assert.equal(stmts.flatMap(s => s.lines).join('\n'), src);
});

test('--write / --check exit non-zero naming the workflow and canonical when a region keeps no declaration, and suggest --remove', () => {
  const canonical = `export const NOBODY_USES_THIS = 1;\n`;
  const markerBegin = `// ==== BEGIN inline: _lib/fake.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====`;
  const markerEnd = `// ==== END inline: _lib/fake.mjs ====`;
  const wf = `${markerBegin}\nconst NOBODY_USES_THIS = 1;\n${markerEnd}\nrun();\n`;
  const tmp = makeFixtureRepo(canonical, wf);
  try {
    for (const mode of ['--write', '--check']) {
      const result = runCli([mode, '--root', tmp]);
      assert.notEqual(result.status, 0, `${mode} should fail on an empty region`);
      assert.match(result.stderr, /wf\.js/, `${mode}: workflow name missing: ${result.stderr}`);
      assert.match(result.stderr, /_lib\/fake\.mjs/, `${mode}: canonical path missing: ${result.stderr}`);
      assert.match(result.stderr, /--remove _lib\/fake\.mjs --from wf\.js/, `${mode}: --remove hint missing: ${result.stderr}`);
    }
    const written = readFileSync(join(tmp, '.claude', 'workflows', 'wf.js'), 'utf8');
    assert.equal(written, wf, '--write must leave the workflow unchanged');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Test: CLI usage errors
// ─────────────────────────────────────────────────────────────────────────────

test('CLI exits 2 with no flags', () => {
  const result = runCli([]);
  assert.equal(result.status, 2);
});

test('CLI exits 2 with both --write and --check', () => {
  const result = runCli(['--write', '--check']);
  assert.equal(result.status, 2);
});

test('CLI exits 2 with unknown flag', () => {
  const result = runCli(['--unknown-flag']);
  assert.equal(result.status, 2);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test (t1-t3): collectTopLevelDeclNames unit tests
// ─────────────────────────────────────────────────────────────────────────────

test('collectTopLevelDeclNames extracts function, async function, const, let, var, class', () => {
  const src = `function foo(){}\nasync function bar(){}\nconst A = 1;\nlet b = 2;\nvar c = 3;\nclass D {}\n`;
  const names = collectTopLevelDeclNames(src);
  assert.deepEqual(names.sort(), ['A', 'D', 'b', 'bar', 'c', 'foo'].sort());
});

test('collectTopLevelDeclNames excludes indented nested declarations', () => {
  const src = `function outer() {\n  const inner = 1;\n}\n`;
  const names = collectTopLevelDeclNames(src);
  assert.ok(names.includes('outer'), 'should include outer');
  assert.ok(!names.includes('inner'), 'should NOT include inner (indented)');
});

test('collectTopLevelDeclNames excludes declarations in comments', () => {
  const src = `// const ghost = 1;\nconst real = 2;\n`;
  const names = collectTopLevelDeclNames(src);
  assert.ok(names.includes('real'), 'should include real');
  assert.ok(!names.includes('ghost'), 'should NOT include ghost (in comment)');
});

// ─────────────────────────────────────────────────────────────────────────────
// Test (t4): function declaration collision between two canonicals
// ─────────────────────────────────────────────────────────────────────────────

test('syncRepo throws on function declaration collision between two canonicals', () => {
  const canonical1 = `export function topicKey(x) { return x; }\n`;
  const canonical2 = `export function topicKey(y) { return y; }\n`;
  const markerBegin1 = `// ==== BEGIN inline: _lib/fake.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====`;
  const markerEnd1 = `// ==== END inline: _lib/fake.mjs ====`;
  const markerBegin2 = `// ==== BEGIN inline: _lib/fake2.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====`;
  const markerEnd2 = `// ==== END inline: _lib/fake2.mjs ====`;
  const wf = `${markerBegin1}\n${markerEnd1}\n${markerBegin2}\n${markerEnd2}\nuse(topicKey);\n`;
  const tmp = makeFixtureRepo(canonical1, wf, { extraCanonicals: { 'fake2.mjs': canonical2 } });
  try {
    assert.throws(() => syncRepo(tmp, { write: false }), /collision/i);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Test (t5): const collision between two canonicals — explicit message, not SyntaxError
// ─────────────────────────────────────────────────────────────────────────────

test('syncRepo throws on const collision between two canonicals with explicit collision message', () => {
  const canonical1 = `export const topicKey = 1;\n`;
  const canonical2 = `export const topicKey = 2;\n`;
  const markerBegin1 = `// ==== BEGIN inline: _lib/fake.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====`;
  const markerEnd1 = `// ==== END inline: _lib/fake.mjs ====`;
  const markerBegin2 = `// ==== BEGIN inline: _lib/fake2.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====`;
  const markerEnd2 = `// ==== END inline: _lib/fake2.mjs ====`;
  const wf = `${markerBegin1}\n${markerEnd1}\n${markerBegin2}\n${markerEnd2}\nuse(topicKey);\n`;
  const tmp = makeFixtureRepo(canonical1, wf, { extraCanonicals: { 'fake2.mjs': canonical2 } });
  try {
    assert.throws(() => syncRepo(tmp, { write: false }), /collision/i);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Test (t6): syntax error canonical throws with 'syntax' in message
// ─────────────────────────────────────────────────────────────────────────────

test('syncRepo throws with /syntax/i on canonical with syntax error', () => {
  const canonical = `export const X = ;\n`;
  const markerBegin = `// ==== BEGIN inline: _lib/fake.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====`;
  const markerEnd = `// ==== END inline: _lib/fake.mjs ====`;
  const wf = `${markerBegin}\n${markerEnd}\nuse(X);\n`;
  const tmp = makeFixtureRepo(canonical, wf);
  try {
    assert.throws(() => syncRepo(tmp, { write: false }), /syntax/i);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Test (t7): non-colliding two canonicals in one workflow — normal case
// ─────────────────────────────────────────────────────────────────────────────

test('syncRepo succeeds when two canonicals have no collision', () => {
  const canonical1 = `export const A = 1;\n`;
  const canonical2 = `export const B = 2;\n`;
  const markerBegin1 = `// ==== BEGIN inline: _lib/fake.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====`;
  const markerEnd1 = `// ==== END inline: _lib/fake.mjs ====`;
  const markerBegin2 = `// ==== BEGIN inline: _lib/fake2.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====`;
  const markerEnd2 = `// ==== END inline: _lib/fake2.mjs ====`;
  const wf = `${markerBegin1}\n// old A\n${markerEnd1}\n${markerBegin2}\n// old B\n${markerEnd2}\nuse(A, B);\n`;
  const tmp = makeFixtureRepo(canonical1, wf, { extraCanonicals: { 'fake2.mjs': canonical2 } });
  try {
    assert.doesNotThrow(() => syncRepo(tmp, { write: true }));
    const written = readFileSync(join(tmp, '.claude', 'workflows', 'wf.js'), 'utf8');
    assert.ok(written.includes('const A = 1;'), 'should contain A');
    assert.ok(written.includes('const B = 2;'), 'should contain B');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Test (t8): same canonical in two different workflow files — per-file scope guard
// (guard: collision detection is per workflow file, not global)
// ─────────────────────────────────────────────────────────────────────────────

test('syncRepo does NOT collision-error when same canonical is inlined in two different workflow files', () => {
  const canonical = `export function topicKey(x) { return x; }\n`;
  const markerBegin = `// ==== BEGIN inline: _lib/fake.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====`;
  const markerEnd = `// ==== END inline: _lib/fake.mjs ====`;
  const wf1 = `${markerBegin}\n// old 1\n${markerEnd}\nuse(topicKey);\n`;
  const wf2 = `${markerBegin}\n// old 2\n${markerEnd}\nuse(topicKey);\n`;
  const tmp = makeFixtureRepo(canonical, wf1, { multiWf: true, secondWfContent: wf2 });
  try {
    assert.doesNotThrow(() => syncRepo(tmp, { write: true }));
    const wf1Written = readFileSync(join(tmp, '.claude', 'workflows', 'wf.js'), 'utf8');
    const wf2Written = readFileSync(join(tmp, '.claude', 'workflows', 'wf2.js'), 'utf8');
    assert.ok(wf1Written.includes('function topicKey'), 'wf.js should contain topicKey');
    assert.ok(wf2Written.includes('function topicKey'), 'wf2.js should contain topicKey');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Test (bare): bare-form execution (no `node` prefix — direct execve of the
// script path, matching exec-proxy Bash invocation). Requires shebang +
// executable bit + realpath-aware isMain.
// ─────────────────────────────────────────────────────────────────────────────

test('script file starts with a node shebang line', () => {
  const src = readFileSync(SCRIPT_PATH, 'utf8');
  const firstLine = src.split('\n')[0];
  assert.equal(firstLine, '#!/usr/bin/env node');
});

test('script file has the executable bit set on disk', () => {
  const mode = statSync(SCRIPT_PATH).mode;
  assert.notEqual(mode & 0o111, 0, `expected executable bit set, got mode ${mode.toString(8)}`);
});

test('bare-form spawnSync (no node prefix) runs --check successfully against a fixture repo', () => {
  const canonical = `export const A = 1;\n`;
  const markerBegin = `// ==== BEGIN inline: _lib/fake.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====`;
  const markerEnd = `// ==== END inline: _lib/fake.mjs ====`;
  const wf = `${markerBegin}\nconst A = 1;\n${markerEnd}\nuse(A);\n`;
  const tmp = makeFixtureRepo(canonical, wf);
  try {
    const result = spawnSync(SCRIPT_PATH, ['--check', '--root', tmp], { encoding: 'utf8' });
    assert.equal(result.error, undefined, `spawnSync errored: ${result.error}`);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('bare-form spawnSync via a symlink to the script also runs main (realpath-aware isMain)', () => {
  const canonical = `export const A = 1;\n`;
  const markerBegin = `// ==== BEGIN inline: _lib/fake.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====`;
  const markerEnd = `// ==== END inline: _lib/fake.mjs ====`;
  const wf = `${markerBegin}\nconst A = 1;\n${markerEnd}\nuse(A);\n`;
  const tmp = makeFixtureRepo(canonical, wf);
  const symlinkDir = mkdtempSync(join(os.tmpdir(), 'sync-inlines-symlink-'));
  const symlinkPath = join(symlinkDir, 'sync-inlines-link.mjs');
  symlinkSync(SCRIPT_PATH, symlinkPath);
  try {
    const result = spawnSync(symlinkPath, ['--check', '--root', tmp], { encoding: 'utf8' });
    assert.equal(result.error, undefined, `spawnSync errored: ${result.error}`);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(symlinkDir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// insertMarkerPair(wfSrc, source, anchor, wfLabel): unit tests (issue #453)
// ─────────────────────────────────────────────────────────────────────────────

test('insertMarkerPair inserts a BEGIN/END marker pair immediately after a unique anchor line', () => {
  const wfSrc = `line1\nconst anchor = 1;\nline3\n`;
  const result = insertMarkerPair(wfSrc, '_lib/foo.mjs', 'const anchor = 1;', 'wf.js');
  const lines = result.split('\n');
  assert.equal(lines[0], 'line1');
  assert.equal(lines[1], 'const anchor = 1;');
  assert.ok(/^\/\/ ==== BEGIN inline: _lib\/foo\.mjs .*====$/.test(lines[2]), `unexpected BEGIN line: ${lines[2]}`);
  assert.equal(lines[3], '// ==== END inline: _lib/foo.mjs ====');
  assert.equal(lines[4], 'line3');
});

test('insertMarkerPair throws when anchor matches zero lines', () => {
  const wfSrc = `line1\nline2\n`;
  assert.throws(() => insertMarkerPair(wfSrc, '_lib/foo.mjs', 'nonexistent', 'wf.js'), /anchor/i);
});

test('insertMarkerPair throws when anchor matches multiple lines', () => {
  const wfSrc = `dup\ndup\n`;
  assert.throws(() => insertMarkerPair(wfSrc, '_lib/foo.mjs', 'dup', 'wf.js'), /anchor/i);
});

test('insertMarkerPair throws when anchor is inside an existing BEGIN..END region', () => {
  const markerBegin = `// ==== BEGIN inline: _lib/fake.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====`;
  const markerEnd = `// ==== END inline: _lib/fake.mjs ====`;
  const wfSrc = `${markerBegin}\nconst inside = 1;\n${markerEnd}\n`;
  assert.throws(
    () => insertMarkerPair(wfSrc, '_lib/other.mjs', 'const inside = 1;', 'wf.js'),
    /nested|inside/i,
  );
});

test('insertMarkerPair allows anchoring on the END line of an existing region (insert right after)', () => {
  const markerBegin = `// ==== BEGIN inline: _lib/fake.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====`;
  const markerEnd = `// ==== END inline: _lib/fake.mjs ====`;
  const wfSrc = `${markerBegin}\nconst inside = 1;\n${markerEnd}\nnext\n`;
  const result = insertMarkerPair(wfSrc, '_lib/other.mjs', markerEnd, 'wf.js');
  const lines = result.split('\n');
  assert.equal(lines[2], markerEnd);
  assert.ok(/^\/\/ ==== BEGIN inline: _lib\/other\.mjs .*====$/.test(lines[3]), `unexpected BEGIN line: ${lines[3]}`);
  assert.equal(lines[4], '// ==== END inline: _lib/other.mjs ====');
  assert.equal(lines[5], 'next');
});

// ─────────────────────────────────────────────────────────────────────────────
// CLI --add mode: end-to-end integration (issue #453 AC1/AC3)
//
// AC3 evidence: this whole suite (including the CLI --add flow below) never
// shells out to `git` — the entire "new marker pair" flow runs through
// insertMarkerPair + syncWorkflowSource on a tmpdir fixture, exercised only via
// spawnSync(process.execPath, ...) / direct function calls. No hash-object /
// update-index / checkout-index / apply / checkout FETCH_HEAD anywhere in this
// file.
// ─────────────────────────────────────────────────────────────────────────────

test('--add inserts a new inline region, fills it, and --check passes afterwards', () => {
  const anchor = 'const anchor = 1;';
  const wfContent = `// header\n${anchor}\nuse(NEW_VALUE);\n`;
  const unusedCanonical = `export const UNUSED = 0;\n`;
  const newCanonical = `export const NEW_VALUE = 42;\n`;
  const tmp = makeFixtureRepo(unusedCanonical, wfContent, { extraCanonicals: { 'fake2.mjs': newCanonical } });
  try {
    const addResult = runCli(['--add', '_lib/fake2.mjs', '--into', 'wf.js', '--after', anchor, '--root', tmp]);
    assert.equal(addResult.status, 0, `--add failed: ${addResult.stderr}`);
    assert.ok(addResult.stdout.includes('added: wf.js (_lib/fake2.mjs)'), `unexpected stdout: ${addResult.stdout}`);

    const written = readFileSync(join(tmp, '.claude', 'workflows', 'wf.js'), 'utf8');
    assert.ok(written.includes('BEGIN inline: _lib/fake2.mjs'), 'BEGIN marker should be present');
    assert.ok(written.includes('END inline: _lib/fake2.mjs'), 'END marker should be present');
    assert.ok(written.includes('const NEW_VALUE = 42;'), 'canonical body should be filled in verbatim');

    const checkResult = runCli(['--check', '--root', tmp]);
    assert.equal(checkResult.status, 0, `--check should pass after --add, got: ${checkResult.stderr}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('--add and --write cannot be combined (exit 2)', () => {
  const result = runCli(['--add', '_lib/foo.mjs', '--into', 'wf.js', '--after', 'x', '--write']);
  assert.equal(result.status, 2);
});

test('--add exits 2 when canonical path does not start with _lib/', () => {
  const result = runCli(['--add', 'scripts/foo.mjs', '--into', 'wf.js', '--after', 'x']);
  assert.equal(result.status, 2);
});

test('--add exits 2 when canonical path does not end with .mjs', () => {
  const result = runCli(['--add', '_lib/foo.js', '--into', 'wf.js', '--after', 'x']);
  assert.equal(result.status, 2);
});

test('--add exits 2 when canonical path contains a .. segment (traversal)', () => {
  const result = runCli(['--add', '_lib/../evil.mjs', '--into', 'wf.js', '--after', 'x']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /'\.\.' path segments/);
});

test('--add exits 2 on a .. segment that stays inside _lib/ (rejected before fs access)', () => {
  const result = runCli(['--add', '_lib/sub/../foo.mjs', '--into', 'wf.js', '--after', 'x']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /'\.\.' path segments/);
});

test('--add exits 2 when --into contains a slash', () => {
  const result = runCli(['--add', '_lib/foo.mjs', '--into', 'sub/wf.js', '--after', 'x']);
  assert.equal(result.status, 2);
});

test('--add exits 1 and leaves workflow unchanged when canonical file does not exist', () => {
  const anchor = 'const anchor = 1;';
  const wfContent = `// header\n${anchor}\n// footer\n`;
  const unusedCanonical = `export const UNUSED = 0;\n`;
  const tmp = makeFixtureRepo(unusedCanonical, wfContent);
  try {
    const result = runCli(['--add', '_lib/does-not-exist.mjs', '--into', 'wf.js', '--after', anchor, '--root', tmp]);
    assert.equal(result.status, 1, `expected exit 1, got ${result.status}: ${result.stderr}`);
    const written = readFileSync(join(tmp, '.claude', 'workflows', 'wf.js'), 'utf8');
    assert.equal(written, wfContent, 'workflow file must remain unchanged');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('--add exits 1 and leaves workflow unchanged when the target workflow file does not exist', () => {
  const unusedCanonical = `export const UNUSED = 0;\n`;
  const newCanonical = `export const NEW_VALUE = 42;\n`;
  const tmp = makeFixtureRepo(unusedCanonical, `// header\n`, { extraCanonicals: { 'fake2.mjs': newCanonical } });
  try {
    const result = runCli(['--add', '_lib/fake2.mjs', '--into', 'nonexistent-wf.js', '--after', 'x', '--root', tmp]);
    assert.equal(result.status, 1, `expected exit 1, got ${result.status}: ${result.stderr}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('--add exits 1 and leaves workflow unchanged when canonical is already inlined in the target workflow (duplicate)', () => {
  const canonical = `export const VALUE = 1;\n`;
  const markerBegin = `// ==== BEGIN inline: _lib/fake.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====`;
  const markerEnd = `// ==== END inline: _lib/fake.mjs ====`;
  const anchor = 'const anchor = 1;';
  const wfContent = `${markerBegin}\nconst VALUE = 1;\n${markerEnd}\n${anchor}\n`;
  const tmp = makeFixtureRepo(canonical, wfContent);
  try {
    const result = runCli(['--add', '_lib/fake.mjs', '--into', 'wf.js', '--after', anchor, '--root', tmp]);
    assert.equal(result.status, 1, `expected exit 1, got ${result.status}: ${result.stderr}`);
    assert.ok(/duplicate/i.test(result.stderr), `expected duplicate error, got: ${result.stderr}`);
    const written = readFileSync(join(tmp, '.claude', 'workflows', 'wf.js'), 'utf8');
    assert.equal(written, wfContent, 'workflow file must remain unchanged on duplicate error');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('--add exits 1 and leaves workflow unchanged when canonical contains a forbidden token', () => {
  const anchor = 'const anchor = 1;';
  const wfContent = `// header\n${anchor}\n// footer\n`;
  const unusedCanonical = `export const UNUSED = 0;\n`;
  const badCanonical = `export const BAD = Date.now();\n`;
  const tmp = makeFixtureRepo(unusedCanonical, wfContent, { extraCanonicals: { 'fake2.mjs': badCanonical } });
  try {
    const result = runCli(['--add', '_lib/fake2.mjs', '--into', 'wf.js', '--after', anchor, '--root', tmp]);
    assert.equal(result.status, 1, `expected exit 1, got ${result.status}: ${result.stderr}`);
    assert.ok(/Date\.now/i.test(result.stderr), `expected forbidden-token error, got: ${result.stderr}`);
    const written = readFileSync(join(tmp, '.claude', 'workflows', 'wf.js'), 'utf8');
    assert.equal(written, wfContent, 'workflow file must remain unchanged on validation failure');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// removeMarkerPair(wfSrc, source, wfLabel): unit tests (issue #507)
// ─────────────────────────────────────────────────────────────────────────────

test('removeMarkerPair removes only the targeted region; other regions and hand-written code are byte-unchanged', () => {
  const markerBeginA = `// ==== BEGIN inline: _lib/fake.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====`;
  const markerEndA = `// ==== END inline: _lib/fake.mjs ====`;
  const markerBeginB = `// ==== BEGIN inline: _lib/fake2.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====`;
  const markerEndB = `// ==== END inline: _lib/fake2.mjs ====`;
  const wfSrc = [
    `// header hand-written`,
    `const before = 1;`,
    markerBeginA,
    `const A = 1;`,
    markerEndA,
    `const between = 2;`,
    markerBeginB,
    `const B = 2;`,
    markerEndB,
    `const after = 3;`,
  ].join('\n') + '\n';

  const result = removeMarkerPair(wfSrc, '_lib/fake.mjs', 'wf.js');

  assert.ok(!result.includes('BEGIN inline: _lib/fake.mjs'), 'removed region BEGIN marker must be gone');
  assert.ok(!result.includes('END inline: _lib/fake.mjs'), 'removed region END marker must be gone');
  assert.ok(!result.includes('const A = 1;'), 'removed region body must be gone');

  // Other region and hand-written lines must be byte-unchanged (still present verbatim).
  assert.ok(result.includes('// header hand-written'));
  assert.ok(result.includes('const before = 1;'));
  assert.ok(result.includes('const between = 2;'));
  assert.ok(result.includes(markerBeginB));
  assert.ok(result.includes('const B = 2;'));
  assert.ok(result.includes(markerEndB));
  assert.ok(result.includes('const after = 3;'));

  const expected = [
    `// header hand-written`,
    `const before = 1;`,
    `const between = 2;`,
    markerBeginB,
    `const B = 2;`,
    markerEndB,
    `const after = 3;`,
  ].join('\n') + '\n';
  assert.equal(result, expected);
});

test('removeMarkerPair throws when the target region does not exist', () => {
  const wfSrc = `// header\nconst x = 1;\n`;
  assert.throws(
    () => removeMarkerPair(wfSrc, '_lib/does-not-exist.mjs', 'wf.js'),
    /not found|no.*region|nothing to remove/i,
  );
});

test('removeMarkerPair throws on a second removal of an already-removed region', () => {
  const markerBegin = `// ==== BEGIN inline: _lib/fake.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====`;
  const markerEnd = `// ==== END inline: _lib/fake.mjs ====`;
  const wfSrc = `// header\n${markerBegin}\nconst A = 1;\n${markerEnd}\n// footer\n`;
  const removedOnce = removeMarkerPair(wfSrc, '_lib/fake.mjs', 'wf.js');
  assert.throws(
    () => removeMarkerPair(removedOnce, '_lib/fake.mjs', 'wf.js'),
    /not found|no.*region|nothing to remove/i,
  );
});

test('removeMarkerPair round-trips with insertMarkerPair: insert then remove restores the original source', () => {
  const original = `line1\nconst anchor = 1;\nline3\n`;
  const inserted = insertMarkerPair(original, '_lib/foo.mjs', 'const anchor = 1;', 'wf.js');
  assert.notEqual(inserted, original, 'sanity: insertMarkerPair must actually change the source');
  const restored = removeMarkerPair(inserted, '_lib/foo.mjs', 'wf.js');
  assert.equal(restored, original);
});
