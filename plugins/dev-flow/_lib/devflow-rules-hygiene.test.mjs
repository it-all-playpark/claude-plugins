// devflow-rules-hygiene.test.mjs
// `.claude/rules/dev-flow.md` の hygiene（サイズ上限・経緯記述ゼロ・references 一覧と実体の一致・
// 不変条件アンカー存在・paths frontmatter 不変）と、references/capability-bound.md の項目構成
// （4 欄・sunset トリガ・挙げた機構の実在）を pin する静的テスト（issue #635）。
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { findHistoryTerms } from './test-helpers/history-terms.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const rulesPath = join(REPO_ROOT, '.claude', 'rules', 'dev-flow.md');
const rulesSrc = readFileSync(rulesPath, 'utf8');

test('(a) .claude/rules/dev-flow.md は 10240 bytes 以下', () => {
  const size = Buffer.byteLength(rulesSrc, 'utf8');
  assert.ok(size <= 10240, `.claude/rules/dev-flow.md が ${size} bytes（上限 10240 bytes）`);
});

test('(b) .claude/rules/dev-flow.md に経緯記述（禁止辞書ヒット）が存在しない', () => {
  const lines = rulesSrc.split('\n');
  const hits = [];
  lines.forEach((line, i) => {
    const terms = findHistoryTerms(line);
    if (terms.length > 0) {
      hits.push(`${i + 1}: ${line} (${terms.join(',')})`);
    }
  });
  assert.equal(hits.length, 0, `経緯記述を含む行が見つかった:\n${hits.join('\n')}`);
});

const REFERENCES_DIR = 'plugins/dev-flow/dev-flow/references/';
const REFERENCES_ABS = join(REPO_ROOT, REFERENCES_DIR);
const REFERENCE_FILES = readdirSync(REFERENCES_ABS).filter((f) => f.endsWith('.md')).sort();

test('(c) rules の references 一覧が references ディレクトリの .md と一致する', () => {
  assert.ok(
    rulesSrc.includes(REFERENCES_DIR),
    `rules に "${REFERENCES_DIR}" への言及が見つからない`,
  );
  const listed = [...rulesSrc.matchAll(/^- `([\w.-]+\.md)` — /gm)].map((m) => m[1]).sort();
  assert.ok(REFERENCE_FILES.includes('capability-bound.md'), 'references/capability-bound.md が存在しない');
  assert.ok(REFERENCE_FILES.includes('security-review.md'), 'references/security-review.md が存在しない');
  assert.deepEqual(listed, REFERENCE_FILES, 'rules の references 一覧（"- `x.md` — 説明"）とディレクトリの実体が食い違う');
});

// capability-bound.md: モデル性能・harness の能力しだいで見直す判断の置き場。各項目（"## 項目" 配下の "### "）は
// 4 欄を持ち、sunset トリガはコードにある信号（dev-flow-canary の probe）か major モデルリリースごとの dry-run で書く。
const capPath = join(REFERENCES_ABS, 'capability-bound.md');
const capSrc = readFileSync(capPath, 'utf8');
const CAP_FIELDS = ['何をするか', 'なぜ', 'sunset トリガ', '次のモデル世代での測り直し方'];
const DRY_RUN = 'major モデルリリースごとの dry-run';

function capabilityItems(src) {
  const body = src.split('\n## 項目\n')[1];
  assert.ok(body, 'capability-bound.md に "## 項目" 節が無い');
  return body.split(/^### /m).slice(1).map((block) => {
    const [title, ...rest] = block.split('\n');
    const fields = {};
    for (const part of rest.join('\n').split(/^- \*\*/m).slice(1)) {
      const m = part.match(/^([^*]+)\*\*:([\s\S]*)$/);
      if (m) fields[m[1]] = m[2].replace(/\s+/g, ' ').trim();
    }
    return { title: title.trim(), fields };
  });
}

const capItems = capabilityItems(capSrc);

test('(f) capability-bound.md の各項目が 何をするか / なぜ / sunset トリガ / 測り直し方 を非空で持つ', () => {
  assert.ok(capItems.length > 0, 'capability-bound.md に項目（### 見出し）が無い');
  for (const { title, fields } of capItems) {
    for (const f of CAP_FIELDS) {
      assert.ok(fields[f], `capability-bound.md「${title}」に "- **${f}**:" 欄が無いか空`);
    }
  }
});

const canarySrc = readFileSync(join(REPO_ROOT, 'plugins/dev-flow/.claude/workflows/dev-flow-canary.js'), 'utf8');
const CANARY_PROBES = new Set([...canarySrc.matchAll(/\{ id: '([a-z_]+)'/g)].map((m) => m[1]));

test('(g) sunset トリガは実在する dev-flow-canary の probe か major モデルリリースごとの dry-run で書く', () => {
  assert.ok(CANARY_PROBES.size > 0, 'dev-flow-canary.js から probe id を読めない');
  for (const { title, fields } of capItems) {
    const trigger = fields['sunset トリガ'] ?? '';
    const probes = [...trigger.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((m) => m[1]);
    for (const p of probes) {
      assert.ok(CANARY_PROBES.has(p), `「${title}」の sunset トリガが dev-flow-canary に無い probe "${p}" を引いている`);
    }
    assert.ok(
      trigger.includes(DRY_RUN) || probes.length > 0,
      `「${title}」の sunset トリガがコードの信号でも "${DRY_RUN}" でもない: ${trigger}`,
    );
  }
  for (const [name, src] of [['rules', rulesSrc], ['capability-bound.md', capSrc]]) {
    assert.ok(!/calibration monitor/i.test(src), `${name} がコードに無い calibration monitor を前提にしている`);
  }
});

// rules と capability-bound.md が backtick で挙げる定数・識別子・パスはコードに実在し、値は書き写さない。
function collectFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) collectFiles(p, out);
    else if (/\.(mjs|js|sh)$/.test(e.name)) out.push(p);
  }
  return out;
}
const PLUGIN_ROOT = join(REPO_ROOT, 'plugins', 'dev-flow');
const codeSrc = [...collectFiles(PLUGIN_ROOT), ...collectFiles(join(REPO_ROOT, 'tools'))]
  .map((p) => readFileSync(p, 'utf8'))
  .join('\n');

// pipeline.md / security-review.md も値の写しを持たず定数名・ファイルで指すので、同じ検査を掛ける
const pipelineSrc = readFileSync(join(REFERENCES_ABS, 'pipeline.md'), 'utf8');
const securityReviewSrc = readFileSync(join(REFERENCES_ABS, 'security-review.md'), 'utf8');
const NAMED_DOCS = [['rules', rulesSrc], ['capability-bound.md', capSrc], ['pipeline.md', pipelineSrc], ['security-review.md', securityReviewSrc]];

test('(h) rules と references（capability-bound.md / pipeline.md / security-review.md）が挙げる定数・識別子・パスはコードに実在し、値を書き写さない', () => {
  const missing = [];
  for (const [name, src] of NAMED_DOCS) {
    for (const [, raw] of src.matchAll(/`([^`\n]+)`/g)) {
      const tok = raw.trim().split(/\s+/)[0].replace(/\(\)$/, '');
      if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(tok)) {
        // 定数（const 宣言）か、script が値を代入する環境変数（`X=`）
        if (!new RegExp(`\\bconst ${tok}\\b|\\b${tok}=`).test(codeSrc)) missing.push(`${name}: 定数 ${tok}`);
      } else if (/^[a-z]+[A-Z]\w*$/.test(tok)) {
        if (!new RegExp(`\\b${tok}\\b`).test(codeSrc)) missing.push(`${name}: 識別子 ${tok}`);
      } else if (tok.includes('/') && /\.(mjs|js|sh|md|json)$/.test(tok) && !/[<*]/.test(tok)) {
        if (!existsSync(join(REPO_ROOT, tok)) && !existsSync(join(PLUGIN_ROOT, tok))) missing.push(`${name}: パス ${tok}`);
      }
    }
    const copied = src.match(/(maxTurns|\b[A-Z][A-Z0-9]*_(?:MAX|SECONDS|MARGIN|STUCK|BYTES|PASSES))`?\s*[=:：]?\s*\d+/);
    assert.equal(copied, null, `${name} に定数の値が書き写されている: ${copied?.[0]}`);
  }
  assert.deepEqual(missing, [], `コードに実在しないものを挙げている:\n${missing.join('\n')}`);
});

test('(i) capability-bound.md / pipeline.md / security-review.md に経緯記述（禁止辞書ヒット）が存在しない', () => {
  const hits = [['capability-bound.md', capSrc], ['pipeline.md', pipelineSrc], ['security-review.md', securityReviewSrc]].flatMap(([name, src]) =>
    src.split('\n').flatMap((line, i) => {
      const terms = findHistoryTerms(line);
      return terms.length > 0 ? [`${name}:${i + 1}: ${line} (${terms.join(',')})`] : [];
    }));
  assert.equal(hits.length, 0, `経緯記述を含む行が見つかった:\n${hits.join('\n')}`);
});

test('(j) pipeline.md は model・effort の選定根拠を書かず、model の割り当ては capability-bound.md の項目に置く', () => {
  const rationale = pipelineSrc.match(/replay|盲検|paired|A\/B|完走[0-9 ]|同等|劣後|コストが/);
  assert.equal(rationale, null, `pipeline.md に model・effort の選定根拠が残っている: ${rationale?.[0]}`);
  const item = capItems.find(({ title }) => title.includes('model') && title.includes('effort'));
  assert.ok(item, 'capability-bound.md に subagent の model・effort の項目が無い');
  assert.ok(item.fields['何をするか']?.includes('green-fix'), 'capability-bound.md の model・effort の項目が green-fix の override を書いていない');
  assert.ok(pipelineSrc.includes('`capability-bound.md`'), 'pipeline.md が capability-bound.md を指していない');
});

test('(k) pipeline.md の effort は「frontmatter で決め、call site は opts で渡さない」だけを書き、harness の扱いを書かない', () => {
  const lines = pipelineSrc.split('\n').filter((l) => /effort/.test(l));
  assert.ok(
    lines.some((l) => l.includes('effort は frontmatter で決め、call site は opts で渡さない（`_lib/agent-frontmatter.test.mjs` が pin）')),
    `pipeline.md に effort の決め方が無い:\n${lines.join('\n')}`,
  );
  assert.ok(!/opts\.effort|実効値|agent_opts_effort_accepted/.test(pipelineSrc), 'pipeline.md が harness の opts.effort の扱いを書いている');
});

const INVARIANT_ANCHORS = [
  'merge は常に人間',
  '軸A',
  '1 issue = 1 PR',
  'sandbox / excludedCommands / 特定パス起動の理由を書いてはならない',
  '**例外はない**',
  'tools/sync-inlines.mjs --write',
  'Date.now',
  '--telemetry-json',
  'written:false',
];

test('(d) 不変条件アンカーが全て rules に残っている', () => {
  const missing = INVARIANT_ANCHORS.filter((anchor) => !rulesSrc.includes(anchor));
  assert.equal(missing.length, 0, `不変条件アンカーが欠落している: ${JSON.stringify(missing)}`);
});

const EXPECTED_PATHS = [
  'plugins/dev-flow/.claude/workflows/**',
  'plugins/dev-flow/agents/**',
  'plugins/dev-flow/.claude/agents/**',
  'plugins/dev-flow/_lib/**',
  'plugins/dev-flow/_shared/**',
  'plugins/dev-flow/dev-flow/**',
  'plugins/dev-flow/dev-flow-health/**',
  'tools/**',
];

test('(e) frontmatter の paths 配列が現状と同一の 8 エントリを含み、撤去した doctor / improve を含まない', () => {
  const frontmatterMatch = rulesSrc.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(frontmatterMatch, 'frontmatter が見つからない');
  const frontmatter = frontmatterMatch[1];
  for (const p of EXPECTED_PATHS) {
    assert.ok(frontmatter.includes(`"${p}"`), `frontmatter の paths に "${p}" が含まれない`);
  }
  assert.ok(!/dev-flow-doctor|dev-flow-improve|dev-improve/.test(rulesSrc), 'rules に撤去した doctor / improve への言及が残っている');
});
