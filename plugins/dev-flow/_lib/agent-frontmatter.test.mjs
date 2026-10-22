// Guard test: dev-flow の agent 定義（.claude/agents/*.md）の YAML frontmatter を
// {name, model, effort, tools, maxTurns} の表で pin する。
//
// - exec-proxy は capability 別に 3 agent へ分離する（issue #323）:
//     dev-runner-haiku-ro: read-only 決定論 proxy 専任。tools は [Bash, Read] のみ（least privilege）
//     dev-runner-haiku:    write/Skill 系 proxy 専任。tools は [Bash, Read, Write, Skill] のみ。Write は
//                          post-comment 系 proxy（post-review#i / post-summary）の一時ファイル保存に必要（issue #372）
//     dev-runner:          判断寄り（fix / analyze-clarify）の sonnet agent。tools から TodoWrite のみ除去
//   mechanical exec-proxy の effort は A/B 実測（issue #323）の
//   adopted_effort（low）。maxTurns は全 exec-proxy に有限値（runtime が honor するかは frontmatter からは
//   検証できないため有限性のみを見る）
// - dev-runner-haiku-wo は tools を [Write] に限る（issue #521）: Bash が使えると isolation probe が
//   Bash リダイレクトの fallback で成功し得る。prompt での禁止は決定論的でない
// - 品質ゲート agent（evaluator / pr-reviewer / dev-implementer）の effort
//
// Run: npx vitest run _lib/agent-frontmatter.test.mjs
// Full CI: bash tests/run-node-tests.sh --strict

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const agentsDir = join(repoRoot, '.claude', 'agents');

// exec-proxy の adopted_effort（mechanical exec-proxy: dev-runner-haiku-ro / dev-runner-haiku / dev-runner-haiku-wo）
const ADOPTED_EFFORT = 'low';

/** frontmatter 本文（--- 区切りの間）を返す。無ければ null。 */
function extractFrontmatter(source) {
  const m = source.match(/^---\n([\s\S]*?)\n---/);
  return m ? m[1] : null;
}

/** frontmatter の `<key>: <value>` の値（1 トークン）を返す。無ければ null。 */
function frontmatterField(frontmatter, key) {
  const m = frontmatter.match(new RegExp(`^${key}:\\s*(\\S+)\\s*$`, 'm'));
  return m ? m[1] : null;
}

/** frontmatter の `tools:` YAML list を返す（無ければ []）。 */
function extractToolsList(frontmatter) {
  const m = frontmatter.match(/^tools:\n((?:[ \t]*-[ \t]*\S+\n?)+)/m);
  if (!m) return [];
  return m[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('-'))
    .map((line) => line.replace(/^-\s*/, '').trim());
}

/**
 * name: agent 名（.claude/agents/<name>.md）
 * model / maxTurns: 指定した行だけ検査する（maxTurns: 'finite' は有限の正の整数）
 * tools.exact: 集合として完全一致 / tools.include: 必ず含む / tools.exclude: 含まない
 */
const AGENTS = [
  {
    name: 'dev-runner-haiku-ro', model: 'haiku', effort: ADOPTED_EFFORT, maxTurns: 'finite',
    tools: { exact: ['Bash', 'Read'], exclude: ['Write', 'Edit', 'Skill', 'TodoWrite', 'Glob', 'Grep'] },
  },
  {
    name: 'dev-runner-haiku', model: 'haiku', effort: ADOPTED_EFFORT, maxTurns: 'finite',
    tools: { exact: ['Bash', 'Read', 'Skill', 'Write'], exclude: ['Edit', 'TodoWrite', 'Glob', 'Grep'] },
  },
  {
    name: 'dev-runner', model: 'sonnet', effort: 'high', maxTurns: 'finite',
    tools: { include: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Skill'], exclude: ['TodoWrite'] },
  },
  {
    name: 'dev-runner-haiku-wo', effort: ADOPTED_EFFORT,
    tools: { exact: ['Write'], exclude: ['Bash', 'Read', 'Skill', 'Edit'] },
  },
  { name: 'evaluator', effort: 'medium' },
  { name: 'pr-reviewer', effort: 'high' },
  // security-reviewer は読み取りだけ（PR の内容を攻撃者が書ける — コマンド実行・書き込みの tool を持たせない）
  {
    name: 'security-reviewer', model: 'opus', effort: 'high', maxTurns: 'finite',
    tools: { exact: ['Read', 'Grep', 'Glob'], exclude: ['Bash', 'Write', 'Edit', 'Skill', 'TodoWrite'] },
  },
  { name: 'dev-implementer', effort: 'high' },
];

function loadFrontmatter(name) {
  const path = join(agentsDir, `${name}.md`);
  assert.ok(existsSync(path), `Expected agent definition to exist at ${path}`);
  const frontmatter = extractFrontmatter(readFileSync(path, 'utf8'));
  assert.ok(frontmatter !== null, `${path} must have a YAML frontmatter block`);
  return frontmatter;
}

for (const spec of AGENTS) {
  const parts = [
    spec.model && `model:${spec.model}`,
    `effort:${spec.effort}`,
    spec.tools && 'tools',
    spec.maxTurns && 'maxTurns',
  ].filter(Boolean).join(' / ');

  test(`[agent-frontmatter] ${spec.name}.md: ${parts}`, () => {
    const fm = loadFrontmatter(spec.name);
    if (spec.model) {
      assert.equal(frontmatterField(fm, 'model'), spec.model, `${spec.name}.md frontmatter should declare model:${spec.model}, but found:\n${fm}`);
    }
    assert.equal(frontmatterField(fm, 'effort'), spec.effort, `${spec.name}.md frontmatter should declare effort:${spec.effort}, but found:\n${fm}`);
    if (spec.maxTurns === 'finite') {
      assert.match(fm, /^maxTurns:\s*[1-9]\d*\s*$/m, `${spec.name}.md frontmatter should declare a finite positive maxTurns, but found:\n${fm}`);
    }
    if (spec.tools) {
      const tools = extractToolsList(fm);
      if (spec.tools.exact) {
        assert.deepEqual([...tools].sort(), [...spec.tools.exact].sort(), `${spec.name}.md tools should be exactly ${JSON.stringify(spec.tools.exact)}, but found: ${JSON.stringify(tools)}`);
      }
      for (const required of spec.tools.include ?? []) {
        assert.ok(tools.includes(required), `${spec.name}.md tools should include ${required}, but found: ${JSON.stringify(tools)}`);
      }
      for (const forbidden of spec.tools.exclude ?? []) {
        assert.ok(!tools.includes(forbidden), `${spec.name}.md tools must NOT include ${forbidden}, but found: ${JSON.stringify(tools)}`);
      }
    }
  });
}

// Static pin (issue #725): the only agent() call sites that override effort via opts are pr-iterate's
// fix#i / fix#i-retry (FIX_EFFORT = 'medium'). Every other agent keeps its frontmatter effort, so no
// other non-comment line in dev-flow.js / pr-iterate.js may pass `effort:`.
test('[agent-frontmatter][opts-pin] only pr-iterate fix#i / fix#i-retry pass effort (FIX_EFFORT = medium) via agent opts', () => {
  const workflowsDir = join(repoRoot, '.claude', 'workflows');
  const effortLines = (file) =>
    readFileSync(join(workflowsDir, file), 'utf8')
      .split('\n')
      .filter((l) => !l.trim().startsWith('//') && /\beffort:/.test(l));
  assert.deepEqual(effortLines('dev-flow.js'), [], 'dev-flow.js の agent() call site は effort を渡さない');

  const prIterateSrc = readFileSync(join(workflowsDir, 'pr-iterate.js'), 'utf8');
  assert.match(prIterateSrc, /^const FIX_EFFORT = 'medium'$/m, "pr-iterate.js の FIX_EFFORT は 'medium'");
  const prLines = effortLines('pr-iterate.js');
  assert.equal(prLines.length, 2, `pr-iterate.js で effort を渡すのは fix#i / fix#i-retry の 2 箇所のみ: ${JSON.stringify(prLines)}`);
  assert.ok(prLines[0].includes('label: `fix#${i}`,') && prLines[0].includes('effort: FIX_EFFORT'), `fix#i が FIX_EFFORT を渡していない: ${prLines[0]}`);
  assert.ok(prLines[1].includes('label: `fix#${i}-retry`') && prLines[1].includes('effort: FIX_EFFORT'), `fix#i-retry が FIX_EFFORT を渡していない: ${prLines[1]}`);
});

// 抽出器が inert（常に null / 固定値）だと表の検査が素通りするので、合成入力で抽出結果を pin する。
test('[agent-frontmatter][negative] frontmatterField / extractToolsList extract values from a synthetic source', () => {
  const fm = extractFrontmatter('---\nname: x\neffort: max\nmodel: opus\ntools:\n  - Bash\n  - Write\n---\nbody effort: low');
  assert.equal(frontmatterField(fm, 'effort'), 'max');
  assert.equal(frontmatterField(fm, 'model'), 'opus');
  assert.deepEqual(extractToolsList(fm), ['Bash', 'Write']);
});
