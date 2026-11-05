// _lib/implementer-naming-invariant.test.mjs
// 実装 agent・宣言パス突合 module・routing test のファイル名と dev-flow.js の識別子が、モデル名や撤去済みの
// parallel fan-out ではなく中身を名乗っていることを静的に pin する（issue #762）。agent は中身を読む前に名前で
// 調査対象を選ぶため、名前が実態とずれると誤誘導される。
//
// 禁止トークンは join で組み立てる — 本ファイル自身が (b) の tracked file 走査に入るため、literal を書くと
// 自分で invariant を破る。
//
// Run: npx vitest run _lib/implementer-naming-invariant.test.mjs
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = join(here, '..');
const repoRoot = join(pluginRoot, '..', '..');

const OLD_AGENT = ['dev', 'implement', 'fable'].join('-');
const OLD_LIB = ['parallel', 'disjoint'].join('-');
const OLD_ROUTING_TEST = ['devflow', 'implement', 'fable', 'routing.test.mjs'].join('-');

const devFlowSrc = readFileSync(join(pluginRoot, '.claude', 'workflows', 'dev-flow.js'), 'utf8');

function frontmatter(md, label) {
  const m = md.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(m, `${label}: frontmatter が無い`);
  const field = (key) => (m[1].match(new RegExp(`^${key}:\\s*(\\S+)\\s*$`, 'm')) ?? [])[1];
  return { name: field('name'), model: field('model'), effort: field('effort') };
}

// ---- (a) agent 定義: dev-implementer.md（model / effort は opus / high のまま）----

test('[implementer-naming] (a) agents/dev-implementer.md の name・見出しが dev-implementer で、model opus / effort high', () => {
  assert.ok(!existsSync(join(pluginRoot, 'agents', `${OLD_AGENT}.md`)), `agents/${OLD_AGENT}.md が残っている`);
  const md = readFileSync(join(pluginRoot, 'agents', 'dev-implementer.md'), 'utf8');
  const fm = frontmatter(md, 'dev-implementer.md');
  assert.equal(fm.name, 'dev-implementer');
  assert.equal(fm.model, 'opus');
  assert.equal(fm.effort, 'high');
  assert.ok(/^# dev-implementer$/m.test(md), 'dev-implementer.md の見出しが # dev-implementer でない');
});

// ---- (b) repo 全体の tracked file に旧 agent 名の参照が無い ----

test('[implementer-naming] (b) repo の tracked file に旧 agent 名の参照が無い', () => {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' }).split('\0').filter(Boolean);
  assert.ok(files.includes('AGENTS.md'), `git ls-files の root が repo root でない（${files.length} 件）`);
  const hits = files.filter((f) => {
    const p = join(repoRoot, f);
    return existsSync(p) && statSync(p).isFile() && readFileSync(p, 'utf8').includes(OLD_AGENT);
  });
  assert.deepEqual(hits, [], `旧 agent 名の参照が残っている: ${hits.join(', ')}`);
});

// ---- (c) dev-flow.js の実装経路の識別子・コメントがモデル非依存 ----
// 合成 plan オブジェクトの consumer（adoptReportedFiles 以下）のシグネチャもここ 1 か所で pin する。

test('[implementer-naming] (c) dev-flow.js の実装経路の識別子がモデル非依存の名前で、Fable 前提の語が無い', () => {
  for (const decl of [
    "const IMPL_AGENT = 'dev-implementer'",
    'function synthesizeImplPlan(req, issue)',
    'function isImplTask(t)',
    'function isImplPlan(p)',
    'function implPrompt(t, ',
    'const implFeedback = ',
    'function adoptReportedFiles(plan, results)',
    'function diffDeclaredPaths(planTasks, changedFiles)',
    'function buildCommitMessage({ issue, req, plan, titleFormat = null })',
    'function buildPrBody({ issue, req, plan,',
  ]) {
    assert.ok(devFlowSrc.includes(decl), `dev-flow.js に ${decl} が無い`);
  }
  const fableWords = devFlowSrc.match(/fable/gi) ?? [];
  assert.deepEqual(fableWords, [], 'dev-flow.js に fable の語が残っている');
});

// ---- (d) 宣言パス突合 module は declared-paths（inline marker・import も追従）----

test('[implementer-naming] (d) _lib/declared-paths.mjs / .test.mjs にリネームされ、inline marker と import が追従している', () => {
  for (const f of [`${OLD_LIB}.mjs`, `${OLD_LIB}.test.mjs`]) {
    assert.ok(!existsSync(join(here, f)), `_lib/${f} が残っている`);
  }
  const lib = readFileSync(join(here, 'declared-paths.mjs'), 'utf8');
  assert.ok(lib.startsWith('// declared-paths: '), 'declared-paths.mjs の先頭コメントが追従していない');
  const libTest = readFileSync(join(here, 'declared-paths.test.mjs'), 'utf8');
  assert.ok(libTest.includes("from './declared-paths.mjs'"), 'declared-paths.test.mjs の import が追従していない');
  assert.ok(devFlowSrc.includes('// ==== BEGIN inline: _lib/declared-paths.mjs '), 'dev-flow.js に declared-paths の BEGIN marker が無い');
  assert.ok(devFlowSrc.includes('// ==== END inline: _lib/declared-paths.mjs ===='), 'dev-flow.js に declared-paths の END marker が無い');
  assert.ok(!devFlowSrc.includes(OLD_LIB), `dev-flow.js に ${OLD_LIB} が残っている`);
});

// ---- (e) Implement 経路の routing test のファイル名 ----

test('[implementer-naming] (e) Implement 経路の routing test は devflow-implementer-routing.test.mjs', () => {
  assert.ok(!existsSync(join(here, OLD_ROUTING_TEST)), `_lib/${OLD_ROUTING_TEST} が残っている`);
  assert.ok(existsSync(join(here, 'devflow-implementer-routing.test.mjs')), '_lib/devflow-implementer-routing.test.mjs が無い');
});

// ---- (f) model / effort を述べるコメントが agent frontmatter と一致する ----

test('[implementer-naming] (f) dev-flow.js の model / effort コメントが frontmatter と一致する', () => {
  const evaluator = frontmatter(readFileSync(join(pluginRoot, 'agents', 'evaluator.md'), 'utf8'), 'evaluator.md');
  const reviewer = frontmatter(readFileSync(join(pluginRoot, 'agents', 'pr-reviewer.md'), 'utf8'), 'pr-reviewer.md');
  const implDesc = `（evaluator は ${evaluator.model} / ${evaluator.effort}、pr-reviewer / dev-implementer は ${reviewer.model} / ${reviewer.effort}。`;
  assert.ok(devFlowSrc.includes(implDesc), `dev-flow.js の trackedAgent コメントが frontmatter と一致しない（期待: ${implDesc}）`);
});
