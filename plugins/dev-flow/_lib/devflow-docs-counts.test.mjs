// _lib/devflow-docs-counts.test.mjs
// issue #697: README / agent 定義に書かれた数・役割が実装とずれないことを pin する。
// 期待値は実装（dev-flow.js の meta.phases・agents/ の実体・workflow の agentType 実呼び出し）から導出する。
//
// Run: npx vitest run _lib/devflow-docs-counts.test.mjs
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(pluginRoot, '..', '..');

const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8');
const devFlowSrc = readFileSync(join(pluginRoot, '.claude/workflows/dev-flow.js'), 'utf8');

test('README: Atlas 紹介の phase 数が dev-flow.js の meta.phases と一致する', () => {
  const metaPhases = devFlowSrc.slice(devFlowSrc.indexOf('phases: ['), devFlowSrc.indexOf('],', devFlowSrc.indexOf('phases: [')));
  const count = (metaPhases.match(/\{ title: '/g) ?? []).length;
  assert.ok(count > 0, 'meta.phases が読めない');
  const m = readme.match(/dev-flow Pipeline Atlas\]\(docs\/dev-flow-atlas\.md\)\*\* — (\d+) phase/);
  assert.ok(m, 'README に Atlas 紹介の phase 数が無い');
  assert.equal(Number(m[1]), count);
});

test('atlas: 概観図の phase ノード番号・1.x 節見出し・phase 数が dev-flow.js の meta.phases と一致し、Analyze ノード / 節が無い', () => {
  const atlas = readFileSync(join(repoRoot, 'docs/dev-flow-atlas.md'), 'utf8');
  const start = devFlowSrc.indexOf('phases: [');
  const titles = [...devFlowSrc.slice(start, devFlowSrc.indexOf('],', start)).matchAll(/\{ title: '([^']+)' \}/g)].map((m) => m[1]);
  assert.ok(titles.length > 0, 'meta.phases が読めない');

  // 1.1 概観の mermaid ノード `X["<n>. <title>"]` が meta.phases の順・番号と完全一致する
  const overview = atlas.slice(atlas.indexOf('### 1.1 '), atlas.indexOf('### 1.2 '));
  const nodes = [...overview.matchAll(/\["(\d+)\. ([^"]+)"\]/g)].map((m) => [Number(m[1]), m[2]]);
  assert.deepEqual(nodes, titles.map((t, i) => [i + 1, t]), '概観図の phase ノードが meta.phases とずれている');

  // 1.2 以降の節見出しが 1 phase 1 節で meta.phases の順に並ぶ
  const headings = [...atlas.matchAll(/^### 1\.(\d+) (.+)$/gm)]
    .map((m) => [Number(m[1]), m[2].trim()])
    .filter(([n]) => n >= 2);
  assert.deepEqual(headings, titles.map((t, i) => [i + 2, t]), '1.x 節見出しが meta.phases とずれている');

  for (const re of [/(\d+) phase で駆動する/, /続いて (\d+) phase を/]) {
    const m = atlas.match(re);
    assert.ok(m, `atlas に phase 数の記述が無い: ${re}`);
    assert.equal(Number(m[1]), titles.length);
  }

  assert.ok(!/\bAnalyze\b/.test(atlas), 'atlas に撤去済み Analyze phase の表記が残っている（Setup 末尾の analyze ゲートと書く）');
});

// README は skill / agent / bin wrapper の件数を書かない（tests/readme-facts.bats が pin）。
// agent 数は plugin-manifest.bats が manifest の description と実体を照合する。
test('README / plugin.json / marketplace.json: dev-flow の skill 数が実体と一致し、撤去した doctor / improve を載せない', () => {
  const skills = readdirSync(pluginRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(pluginRoot, d.name, 'SKILL.md')))
    .map((d) => d.name);
  assert.ok(skills.includes('dev-flow-health'), `dev-flow-health が skill として無い: ${skills.join(', ')}`);
  for (const removed of ['dev-flow-doctor', 'dev-flow-improve']) {
    assert.ok(!existsSync(join(pluginRoot, removed)), `${removed}/ が残っている`);
  }
  assert.ok(!existsSync(join(pluginRoot, '.claude/workflows/dev-improve.js')), 'dev-improve.js が残っている');
  assert.ok(!existsSync(join(pluginRoot, 'agents/improve-miner.md')), 'improve-miner.md が残っている');

  assert.ok(!/dev-flow-doctor|dev-flow-improve/.test(readme), 'README に撤去した doctor / improve が残っている');

  const manifests = [
    JSON.parse(readFileSync(join(pluginRoot, '.claude-plugin/plugin.json'), 'utf8')).description,
    JSON.parse(readFileSync(join(repoRoot, '.claude-plugin/marketplace.json'), 'utf8')).plugins.find((p) => p.name === 'dev-flow').description,
  ];
  for (const desc of manifests) {
    assert.match(desc, new RegExp(`\\b${skills.length} skills\\b`), `description の skill 数が実体（${skills.length}）と一致しない: ${desc}`);
    assert.ok(!/dev-improve/.test(desc), `description に撤去した dev-improve が残っている: ${desc}`);
  }
});

test('journal.sh: prune の既定 keep 一覧は dev-flow plugin に実在する skill だけで、dev-flow / pr-iterate を含む', () => {
  const journalSh = readFileSync(join(repoRoot, 'plugins/playpark-core/journal/scripts/journal.sh'), 'utf8');
  const m = journalSh.match(/^PRUNE_KEEP_DEFAULT="([^"]*)"/m);
  assert.ok(m, 'journal.sh に PRUNE_KEEP_DEFAULT が無い');
  const keep = m[1].split(',');
  assert.ok(keep.includes('dev-flow') && keep.includes('pr-iterate'), `dev-flow-health が読む dev-flow / pr-iterate が keep に無い: ${m[1]}`);
  for (const skill of keep) {
    assert.ok(existsSync(join(pluginRoot, skill, 'SKILL.md')), `PRUNE_KEEP_DEFAULT の ${skill} は dev-flow plugin の skill として実在しない: ${m[1]}`);
  }
});

test("dev-runner.md: 役割記述が agentType: 'dev-runner' の実呼び出し（analyze-clarify）に合う", () => {
  const md = readFileSync(join(pluginRoot, 'agents/dev-runner.md'), 'utf8');
  const description = md.slice(md.indexOf('description:'), md.indexOf('model:'));
  assert.ok(!/test-green|issue analysis/.test(description), `description にテスト実行 / issue 分析が残っている:\n${description}`);
  assert.match(description, /analyze-clarify/);
  // analyze-clarify は clarifyPrompt（dev-flow.js）と同じく exec-proxy analyze-issue を直接実行する
  assert.match(description, /analyze-issue/, `description が analyze-issue の直接実行を指していない:\n${description}`);
  const clarifyRow = md.split('\n').find((l) => l.startsWith('| analyze-clarify'));
  assert.ok(clarifyRow, 'dev-runner.md に analyze-clarify の行が無い');
  assert.ok(clarifyRow.includes('`analyze-issue <n> [--repo R] --depth comprehensive --dump-body <path>`'), `analyze-clarify の行が analyze-issue の直接実行を指していない: ${clarifyRow}`);
  assert.ok(!/dev-improve/.test(md), 'dev-runner.md に撤去した dev-improve の役割が残っている');
  assert.ok(!md.includes('| test green 確認 |'), 'テスト実行は dev-runner-haiku が担う');
  assert.ok(!md.includes('| issue 分析 |'), '通常経路の issue 分析は prerun の script が担う');
  const src = readFileSync(join(pluginRoot, '.claude/workflows/dev-flow.js'), 'utf8');
  assert.ok(
    /agentType: 'dev-runner', schema: \w+, label: `analyze-clarify#/.test(src),
    '.claude/workflows/dev-flow.js の dev-runner 呼び出し（analyze-clarify#）が見つからない — dev-runner.md の役割記述を見直す',
  );
});

test('references/analyze-issue.md: 判定できないときの fail-closed の扱いと理由を書き、値は写さず analyze-issue.sh / prerun-analyze.sh を指す', () => {
  const sh = readFileSync(join(pluginRoot, 'dev-flow/scripts/analyze-issue.sh'), 'utf8');
  const prerunAnalyzeSh = readFileSync(join(pluginRoot, 'dev-flow/scripts/prerun-analyze.sh'), 'utf8');
  const md = readFileSync(join(pluginRoot, 'dev-flow/references/analyze-issue.md'), 'utf8');
  const flat = md.replace(/\n/g, '');

  // 値の正は script。md はそこを指す
  for (const script of ['analyze-issue.sh', 'prerun-analyze.sh']) {
    assert.ok(md.includes(`\`${script}\``), `analyze-issue.md が ${script} を指していない`);
  }
  // 写しを持たない: 切断上限・切断マーカーの文言・Jev の閾値・comment の分類（script から導出した値が md に現れない）
  const maxChars = sh.match(/^SCOPE_MAX_CHARS=(\d+)$/m)?.[1];
  assert.ok(maxChars, 'analyze-issue.sh に SCOPE_MAX_CHARS が無い');
  assert.ok(!md.includes(maxChars), `analyze-issue.md が切断上限 ${maxChars} を書き写している`);
  assert.ok(sh.includes('[TRUNCATED: '), 'analyze-issue.sh に切断マーカーが無い');
  assert.ok(!md.includes('[TRUNCATED:'), 'analyze-issue.md が切断マーカーの文言を書き写している');
  const confMin = prerunAnalyzeSh.match(/^JEV_CONF_MIN="([\d.]+)"$/m)?.[1];
  assert.ok(confMin, 'prerun-analyze.sh に JEV_CONF_MIN が無い');
  assert.ok(!md.includes(confMin), `analyze-issue.md が Jev の閾値 ${confMin} を書き写している`);
  const criteria = prerunAnalyzeSh.match(/"criteria":\{(.*?)\}\}\}'/)?.[1];
  const choices = [...(criteria ?? '').matchAll(/"(\w+)":"/g)].map((m) => m[1]);
  assert.ok(choices.includes('override') && choices.includes('resolved'), `prerun-analyze.sh の comment 分類が読めない: ${choices.join(', ')}`);
  assert.ok(!choices.every((c) => md.includes(c)), `analyze-issue.md が comment の分類（${choices.join(' / ')}）を書き写している`);

  // fail-closed の扱いと理由
  const failClosed = sectionOf(md, '## 判定できないときの fail-closed').replace(/\n/g, '');
  for (const s of ['AC 空', '`comment_conflicts` 非空', '`uncertain` 非空', 'needs_clarification', '`ok:false`']) {
    assert.ok(failClosed.includes(s), `fail-closed の節に ${s} が無い`);
  }
  assert.ok(failClosed.includes('LLM に黙って片方を採らせると'), 'fail-closed の節に理由が無い');
  const override = sectionOf(md, '## comment の override 判定に使う');
  assert.ok(override.includes('`author_association`') && override.includes('`issue_author`') && override.includes('fail-closed'), 'override 判定の fail-closed の理由が無い');
  assert.ok(flat.includes('「comment 0 件」と同一視せず'), 'comments 欠落を comment 0 件と同一視しない fail-closed が無い');
  const truncation = sectionOf(md, '## 本文の切断').replace(/\n/g, '');
  assert.ok(truncation.includes('切断は黙って行わない') && truncation.includes('`body_dump_path`'), '本文の切断を黙って行わない扱いが無い');
});

test('references: prerun が Jev に回す理由は analyze-issue.md の 1 か所に書き、exec-proxy.md の analyze 行はそこを指す', () => {
  const refDir = join(pluginRoot, 'dev-flow/references');
  const md = readFileSync(join(refDir, 'analyze-issue.md'), 'utf8');
  const reason = sectionOf(md, '## prerun が Jev に回す理由').replace(/\n/g, '');
  const anchor = 'Jev は有界な確率だけを返す';
  assert.ok(reason.includes(anchor), `analyze-issue.md の Jev に回す理由の節に「${anchor}」が無い`);
  const holders = readdirSync(refDir)
    .filter((f) => f.endsWith('.md'))
    .filter((f) => readFileSync(join(refDir, f), 'utf8').replace(/\n/g, '').includes(anchor));
  assert.deepEqual(holders, ['analyze-issue.md'], `Jev に回す理由が analyze-issue.md 以外にもある: ${holders.join(', ')}`);
  const row = readFileSync(join(refDir, 'exec-proxy.md'), 'utf8').split('\n').find((l) => l.startsWith('| analyze（prerun'));
  assert.ok(row, 'exec-proxy.md に analyze の行が無い');
  assert.ok(row.includes('Jev に回す理由') && row.includes('`analyze-issue.md`'), `exec-proxy.md の analyze 行が analyze-issue.md の Jev に回す理由を指していない: ${row}`);
});

// issue #897: atlas / pipeline / rules / SKILL.md / AGENTS.md の記述を実装に合わせて pin する。
// 期待値は実装ソース（prerun.sh・merge-tier.mjs・dev-flow.js・pr-iterate.js・agents/）から導出する。
const atlasSrc = readFileSync(join(repoRoot, 'docs/dev-flow-atlas.md'), 'utf8');
const pipelineMd = readFileSync(join(pluginRoot, 'dev-flow/references/pipeline.md'), 'utf8');
const prerunSh = readFileSync(join(pluginRoot, 'dev-flow/scripts/prerun.sh'), 'utf8');
const prerunCode = prerunSh.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
const sectionOf = (src, heading) => {
  const start = src.indexOf(heading);
  assert.notEqual(start, -1, `見出し ${heading} が無い`);
  const next = src.slice(start + heading.length).search(/^#{2,3} /m);
  return next === -1 ? src.slice(start) : src.slice(start, start + heading.length + next);
};

test('atlas: prerun の段列は prerun.sh と同じく deps install を含まず analyze ‖ stack を並列に描き、deps は ensure-worktree-deps が回す', () => {
  // 実装: prerun は deps install をせず、analyze をバックグラウンドで起動して detect-stack の後に join する
  assert.ok(!/ensure-worktree-deps|pnpm install|npm (ci|install)/.test(prerunCode), 'prerun.sh が deps install を行っている — atlas の段列を見直す');
  const launched = prerunCode.indexOf('ANALYZE_PID=$!');
  const stack = prerunCode.indexOf('detect-stack.sh');
  const joined = prerunCode.indexOf('wait "$ANALYZE_PID"');
  assert.ok(launched !== -1 && launched < stack && stack < joined, 'prerun.sh で analyze と detect-stack が並列になっていない — atlas の段列を見直す');

  const chains = atlasSrc.split('\n').filter((l) => l.includes('base → worktree → clean'));
  assert.ok(chains.length > 0, 'atlas に prerun の段列が無い');
  for (const line of chains) {
    assert.ok(line.includes('analyze ‖ stack'), `prerun の段列が analyze ‖ stack になっていない: ${line}`);
    assert.ok(line.includes('ensure-worktree-deps --setup'), `deps install を ensure-worktree-deps に描いていない: ${line}`);
    const prerunPart = line.slice(line.indexOf('base → worktree → clean'), line.indexOf('ensure-worktree-deps'));
    assert.ok(!/deps/.test(prerunPart), `prerun の段列に deps が入っている: ${line}`);
  }
});

test('atlas: 再利用 worktree の起点検証は実装と同じく --no-track 作成 + reflog の作成記録で書く', () => {
  const checkout = readFileSync(join(pluginRoot, '_shared/scripts/worktree-checkout.sh'), 'utf8');
  assert.match(checkout, /^\s*[^#\n]*worktree add --no-track/m, 'worktree-checkout.sh が --no-track で worktree を作っていない — atlas を見直す');
  assert.ok(prerunCode.includes('branch: Created from '), 'prerun.sh が reflog の作成記録で起点を判定していない — atlas を見直す');
  const setup = sectionOf(atlasSrc, '### 1.2 Setup');
  assert.ok(setup.includes('`--no-track`'), 'atlas Setup に --no-track 作成が無い');
  assert.ok(setup.includes('`branch: Created from <ref>`'), 'atlas Setup に reflog の作成記録による起点検証が無い');
});

test('atlas: HOLD 理由表の code が merge-tier.mjs の pushBlocking の code と一致し、件数を書かない', () => {
  const mergeTierSrc = readFileSync(join(pluginRoot, '_lib/merge-tier.mjs'), 'utf8');
  const impl = [...new Set([...mergeTierSrc.matchAll(/pushBlocking\(\s*'([a-z_]+)'/g)].map((m) => m[1]))].sort();
  assert.ok(impl.includes('hash_mismatch') && impl.length > 1, `pushBlocking の code が読めない: ${impl.join(', ')}`);
  const table = sectionOf(atlasSrc, '### HOLD 理由');
  const documented = [...table.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]);
  assert.deepEqual([...documented].sort(), impl, 'atlas の HOLD 理由表が merge-tier.mjs の HOLD code とずれている');
  assert.equal(new Set(documented).size, documented.length, 'HOLD 理由表に code の重複がある');
  const merge = sectionOf(atlasSrc, '## 4. merge tier 判定');
  assert.ok(!/\d+\s*(条件|種)/.test(merge), 'merge tier 判定の節に HOLD 条件の件数が書かれている（表を正とする）');
});

test('atlas: pr-iterate の終端 status 表が pr-iterate.js の STATUS_HEADLINE と一致する', () => {
  const prIterateSrc = readFileSync(join(pluginRoot, '.claude/workflows/pr-iterate.js'), 'utf8');
  const start = prIterateSrc.indexOf('const STATUS_HEADLINE = {');
  assert.notEqual(start, -1, 'pr-iterate.js に STATUS_HEADLINE が無い');
  const body = prIterateSrc.slice(start, prIterateSrc.indexOf('\n};', start));
  const impl = [...body.matchAll(/^\s*'([a-z_]+)':/gm)].map((m) => m[1]).sort();
  assert.ok(impl.length > 0, 'STATUS_HEADLINE の key が読めない');
  const table = sectionOf(atlasSrc, '### 終端 status');
  const documented = [...table.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]).sort();
  assert.deepEqual(documented, impl, 'atlas の終端 status 表が STATUS_HEADLINE とずれている');
});

test('atlas / pipeline.md: LITE 条件が dev-flow.js の const LITE と一致する（ci の AC を持つ run は lite に入らない）', () => {
  const m = devFlowSrc.match(/^const LITE = (.+)$/m);
  assert.ok(m, 'dev-flow.js に const LITE が無い');
  const expr = m[1].trim();
  assert.ok(pipelineMd.includes(`\`${expr}\``), `pipeline.md の micro lite route 条件が dev-flow.js と一致しない: ${expr}`);
  assert.ok(expr.includes('CI_AC_INDEXES.length === 0'), 'LITE 条件から ci の AC が外れた — atlas の LITE ノードを見直す');
  const lite = atlasSrc.split('\n').find((l) => l.includes('R4{"LITE ?'));
  assert.ok(lite, 'atlas に LITE 判定ノードが無い');
  for (const cond of ['micro', 'runEval=false', 'danger clean', 'ci の AC なし']) {
    assert.ok(lite.includes(cond), `atlas の LITE 判定ノードに「${cond}」が無い: ${lite}`);
  }
});

test('atlas / rules / SKILL.md: Setup で起動する dev-runner の label をすべて挙げる', () => {
  const labels = [...devFlowSrc.matchAll(/agentType: 'dev-runner', schema: \w+, label: `([a-z-]+)#\$\{ISSUE\}`, phase: 'Setup'/g)].map((x) => x[1]);
  assert.deepEqual([...labels].sort(), ['ac-observational', 'analyze-clarify'], `dev-flow.js の Setup の dev-runner 呼び出しが変わった: ${labels.join(', ')}`);
  const docs = [
    ['docs/dev-flow-atlas.md', atlasSrc],
    ['.claude/rules/dev-flow.md', readFileSync(join(repoRoot, '.claude/rules/dev-flow.md'), 'utf8')],
    ['plugins/dev-flow/dev-flow/SKILL.md', readFileSync(join(pluginRoot, 'dev-flow/SKILL.md'), 'utf8')],
  ];
  for (const [name, src] of docs) {
    for (const label of labels) {
      assert.ok(src.includes(`${label}#N`), `${name} に Setup の spawn ${label}#N が無い`);
    }
  }
});

test('pipeline.md: 判断系 leaf の subagent 一覧が agents/ の実体と一致する', () => {
  const m = pipelineMd.match(/\*\*判断系 leaf は subagent\*\* \(`\.claude\/agents\/\{([^}]+)\}\.md`\)/);
  assert.ok(m, 'pipeline.md に判断系 leaf の一覧が無い');
  const documented = m[1].split(',').map((s) => s.trim()).sort();
  const actual = readdirSync(join(pluginRoot, 'agents')).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, '')).sort();
  assert.deepEqual(documented, actual);
});

test('pipeline.md: 混在 AC の説明は mixedScopeAcReasons と同じく repo 外の作業を human-task issue に切り出させ、依存の向きを書く', () => {
  // 日本語の折り返しは空白なしで繋がるので改行を除いて照合する
  const flat = pipelineMd.replace(/\n/g, '');
  assert.ok(flat.includes('`mixed` で、repo 外の作業を `human-task` ラベルの別 issue に切り出し、実装 issue の AC を repo 内で検証できるものだけにするよう求める'), 'pipeline.md の混在 AC の説明が human-task issue への切り出しを求めていない');
  assert.ok(flat.includes('merge 前に人がやる作業なら実装 issue に`Blocked by #<human issue>`、merge 後に確認する作業なら human issue に `Blocked by #<実装 issue>`'), 'pipeline.md に依存の向きが無い');
});

test('AGENTS.md: 日次 launchd は install-schedule.sh --install の手動登録が前提であると書く', () => {
  const installer = readFileSync(join(pluginRoot, 'dev-flow-health/scripts/install-schedule.sh'), 'utf8');
  assert.match(installer, /--install\)/, 'install-schedule.sh に --install が無い — AGENTS.md を見直す');
  const agentsMd = readFileSync(join(repoRoot, 'AGENTS.md'), 'utf8');
  const block = agentsMd.slice(agentsMd.indexOf('日次 launchd'), agentsMd.indexOf('```', agentsMd.indexOf('日次 launchd')));
  assert.ok(block.includes('macOS のみ'), `AGENTS.md の日次 launchd 行に macOS 限定が無い:\n${block}`);
  assert.ok(block.includes('install-schedule.sh --install'), `AGENTS.md の日次 launchd 行に有効化手順が無い:\n${block}`);
});

test('evaluator.md: concern_resolutions の boolean キー不受理を現行仕様として書く', () => {
  const md = readFileSync(join(pluginRoot, 'agents/evaluator.md'), 'utf8');
  assert.ok(md.includes('boolean キーは受理しない（error）'));
  assert.ok(!md.includes('旧 resolved:true/false'));
});
