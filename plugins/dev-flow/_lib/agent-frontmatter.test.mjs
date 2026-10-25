// Guard test: dev-flow の agent 定義（.claude/agents/*.md）の YAML frontmatter を
// {name, model, effort, tools, maxTurns} の表で pin する。
//
// - exec-proxy は capability 別に 3 agent へ分離する（issue #323）:
//     dev-runner-haiku-ro: read-only 決定論 proxy 専任。tools は [Bash, Read] のみ（least privilege）
//     dev-runner-haiku:    write/Skill 系 proxy 専任。tools は [Bash, Read, Write, Skill] のみ。Write は
//                          post-comment 系 proxy（post-review#i / post-summary）の一時ファイル保存に必要（issue #372）
//     dev-runner:          判断寄り（analyze-clarify / ac-observational）の sonnet agent。tools から TodoWrite のみ除去
// - pr-iterate の fix（fix#i / fix#i-retry）は専用の pr-fixer（opus / medium / maxTurns 100。tools は dev-runner と同じ）。
//   maxTurns は agent() の opts で変えられないので frontmatter で持つ。dev-runner（maxTurns 50）は fix と分けて据え置く
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
 * model / maxTurns: 指定した行だけ検査する（maxTurns: 'finite' は有限の正の整数、数値はその値と一致）
 * tools.exact: 集合として完全一致 / tools.include: 必ず含む / tools.exclude: 含まない
 */
// dev-runner と pr-fixer の tools（pr-fixer は dev-runner から fix を切り出した agent なので同じ集合）
const RUNNER_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Skill'];
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
    name: 'dev-runner', model: 'sonnet', effort: 'high', maxTurns: 50,
    tools: { exact: RUNNER_TOOLS, exclude: ['TodoWrite'] },
  },
  {
    name: 'pr-fixer', model: 'opus', effort: 'medium', maxTurns: 100,
    tools: { exact: RUNNER_TOOLS, exclude: ['TodoWrite'] },
  },
  {
    name: 'dev-runner-haiku-wo', effort: ADOPTED_EFFORT,
    tools: { exact: ['Write'], exclude: ['Bash', 'Read', 'Skill', 'Edit'] },
  },
  { name: 'evaluator', effort: 'medium' },
  { name: 'pr-reviewer', effort: 'high' },
  // security-reviewer は読み取りだけ（PR の内容を攻撃者が書ける — コマンド実行・書き込みの tool を持たせない）。
  // Glob も持たせない（差し替えた保存先で自己整合した名前のファイルを見つけて読めるため。diff_path は prompt で渡す）
  {
    name: 'security-reviewer', model: 'opus', effort: 'high', maxTurns: 'finite',
    tools: { exact: ['Read', 'Grep'], exclude: ['Bash', 'Write', 'Edit', 'Skill', 'TodoWrite', 'Glob'] },
  },
  // security-codex-relay は Bash だけ（Read を持つと result.json の description 等の自由文を読める。Bash は hook が固定形に限る）
  {
    name: 'security-codex-relay', model: 'haiku', effort: ADOPTED_EFFORT, maxTurns: 'finite',
    tools: { exact: ['Bash'], exclude: ['Read', 'Write', 'Edit', 'Skill', 'TodoWrite', 'Glob', 'Grep'] },
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
    } else if (typeof spec.maxTurns === 'number') {
      assert.equal(frontmatterField(fm, 'maxTurns'), String(spec.maxTurns), `${spec.name}.md frontmatter should declare maxTurns:${spec.maxTurns}, but found:\n${fm}`);
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

// Static pin: effort は frontmatter で決める（pr-iterate の fix も pr-fixer の frontmatter で medium）。
// dev-flow.js / pr-iterate.js のコメント以外の行は `effort:` を渡さない。
test('[agent-frontmatter][opts-pin] dev-flow.js / pr-iterate.js の agent() call site は opts で effort を渡さない', () => {
  const workflowsDir = join(repoRoot, '.claude', 'workflows');
  const effortLines = (file) =>
    readFileSync(join(workflowsDir, file), 'utf8')
      .split('\n')
      .filter((l) => !l.trim().startsWith('//') && /\beffort:/.test(l));
  assert.deepEqual(effortLines('dev-flow.js'), [], 'dev-flow.js の agent() call site は effort を渡さない');
  assert.deepEqual(effortLines('pr-iterate.js'), [], 'pr-iterate.js の agent() call site は effort を渡さない');
});

// fix は pr-fixer が担う。dev-runner の description（harness が agent 選択に使う）に PR fix の役割を残さない
test('[agent-frontmatter][description] dev-runner の description は PR fix を挙げず、pr-fixer の description が fix#i を挙げる', () => {
  const description = (fm) => fm.slice(fm.indexOf('description:'), fm.indexOf('\nmodel:'));
  const runner = description(loadFrontmatter('dev-runner'));
  assert.ok(!/\bfix/i.test(runner), `dev-runner の description に fix の記述が残っている:\n${runner}`);
  assert.match(runner, /analyze-clarify/);
  assert.match(description(loadFrontmatter('pr-fixer')), /fix#i/);
});

// 抽出器が inert（常に null / 固定値）だと表の検査が素通りするので、合成入力で抽出結果を pin する。
test('[agent-frontmatter][negative] frontmatterField / extractToolsList extract values from a synthetic source', () => {
  const fm = extractFrontmatter('---\nname: x\neffort: max\nmodel: opus\ntools:\n  - Bash\n  - Write\n---\nbody effort: low');
  assert.equal(frontmatterField(fm, 'effort'), 'max');
  assert.equal(frontmatterField(fm, 'model'), 'opus');
  assert.deepEqual(extractToolsList(fm), ['Bash', 'Write']);
});
