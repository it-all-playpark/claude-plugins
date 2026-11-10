// devflow-rules-hygiene.test.mjs
// `.claude/rules/dev-flow.md` の hygiene（サイズ上限・経緯記述ゼロ・references 一覧と実体の一致・
// 不変条件アンカー存在・paths frontmatter 不変）と、references/capability-bound.md の項目構成
// （4 欄・sunset トリガ・挙げた機構の実在）と、agents/ の節ごとの正当化クラス宣言を pin する静的テスト（issue #635）。
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
});

// agents/*.md の model: は別名で世代交代がファイルの差分に出ないので、dry-run の合図は dev-flow-health の
// model_changes（解決後の model ID の変化）で起票された issue にする。冒頭の 4 欄の定義がそれを指す
test('(g2) 冒頭の「sunset トリガ」欄の定義は dry-run の合図を dev-flow-health の model_changes で書く', () => {
  const head = capSrc.split('\n## 項目\n')[0];
  const def = head.split(/^- /m).find((item) => item.startsWith('**sunset トリガ**'));
  assert.ok(def, 'capability-bound.md 冒頭に "- **sunset トリガ**" の定義が無い');
  assert.ok(def.includes('`model_changes`'), `「sunset トリガ」の定義が model_changes を合図にしていない: ${def}`);
  assert.ok(def.includes('dev-flow-health'), `「sunset トリガ」の定義が dev-flow-health を指していない: ${def}`);
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

// pipeline.md / security-review.md / exec-proxy.md / telemetry.md も値の写しを持たず定数名・ファイルで指すので、同じ検査を掛ける
const pipelineSrc = readFileSync(join(REFERENCES_ABS, 'pipeline.md'), 'utf8');
const securityReviewSrc = readFileSync(join(REFERENCES_ABS, 'security-review.md'), 'utf8');
const execProxySrc = readFileSync(join(REFERENCES_ABS, 'exec-proxy.md'), 'utf8');
const telemetrySrc = readFileSync(join(REFERENCES_ABS, 'telemetry.md'), 'utf8');
const justificationSrc = readFileSync(join(REFERENCES_ABS, 'justification-classes.md'), 'utf8');
const NAMED_DOCS = [['rules', rulesSrc], ['capability-bound.md', capSrc], ['pipeline.md', pipelineSrc], ['security-review.md', securityReviewSrc], ['exec-proxy.md', execProxySrc], ['telemetry.md', telemetrySrc], ['justification-classes.md', justificationSrc]];

test('(h) rules と references（capability-bound.md / pipeline.md / security-review.md / exec-proxy.md / telemetry.md / justification-classes.md）が挙げる定数・識別子・パスはコードに実在し、値を書き写さない', () => {
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

// justification-classes.md: rules の正当化クラス節から移した機構の列挙。機構はクラスの節から動かさない
// （capability-bound に移すと sunset で撤去されうる）。rules と security-review.md 冒頭は列挙先としてここを指す
const JUSTIFICATION_MECHANISMS = {
  'incentive-structural': ['`evalSeen`', '`blockSeen`', '`reviewSeen`', '`EVAL_STUCK`', '`REVIEW_STUCK`', '`EVAL_MAX`', '`GREEN_MAX`', '`BLOCK_MAX`', '`DESIGN_REPLAN_MAX`', '`AGENT_AC_REIMPL_MAX`', 'guard_blocked の replan 除外', '`scrubBlockingDetail`', '`scrubReviewFindingText`',
    // CI 判定の中継の縛り。hook と bind のパスは (h) が実在を確かめる
    '`stdout-relay`', '`hooks/pretool-stdout-relay-guard.sh`', '`_lib/scripts/stdout-relay-bind.mjs`'],
  '指示の incentive-structural': ['self-judge 禁止', 'feedback 全件対応', 'self-contained 記述', 'topic 反復でアプローチ変更'],
  'blast-radius': ['human merge', 'critical/major-always-blocks', 'Final reconcile', 'TESTSURF seeding', '`health-report.sh`'],
};

test('(o) justification-classes.md がクラスごとの節に機構を全件持ち、rules と security-review.md 冒頭がそこを指す', () => {
  const sections = Object.fromEntries(justificationSrc.split(/^## /m).slice(1).map((block) => {
    const [title, ...rest] = block.split('\n');
    return [title.trim(), rest.join('\n')];
  }));
  for (const [cls, mechanisms] of Object.entries(JUSTIFICATION_MECHANISMS)) {
    assert.ok(sections[cls] !== undefined, `justification-classes.md に "## ${cls}" 節が無い`);
    for (const m of mechanisms) {
      assert.ok(sections[cls].includes(m), `justification-classes.md の "## ${cls}" 節に ${m} が無い`);
    }
  }
  assert.ok(rulesSrc.includes('`justification-classes.md`'), 'rules が機構の列挙先 justification-classes.md を指していない');
  assert.ok(securityReviewSrc.split('\n## ')[0].includes('`justification-classes.md`'), 'security-review.md 冒頭が justification-classes.md を指していない');
});

test('(i) capability-bound.md / pipeline.md / security-review.md / exec-proxy.md / telemetry.md / justification-classes.md に経緯記述（禁止辞書ヒット）が存在しない', () => {
  const hits = [['capability-bound.md', capSrc], ['pipeline.md', pipelineSrc], ['security-review.md', securityReviewSrc], ['exec-proxy.md', execProxySrc], ['telemetry.md', telemetrySrc], ['justification-classes.md', justificationSrc]].flatMap(([name, src]) =>
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

// exec-proxy.md は proxy ごとの失敗ポリシー表だけを持つ。label は workflow に実在し、agent の担当・tools・maxTurns は書き写さない
const EXEC_PROXY_MAX_BYTES = 30 * 1024;
const EXEC_PROXY_HEADER = '| proxy と label | 失敗の検出 | ポリシー | 理由 |';
const WORKFLOWS_ABS = join(PLUGIN_ROOT, '.claude', 'workflows');
const workflowSrc = readdirSync(WORKFLOWS_ABS)
  .filter((f) => f.endsWith('.js'))
  .map((f) => readFileSync(join(WORKFLOWS_ABS, f), 'utf8'))
  .join('\n');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function execProxyRows(src) {
  const lines = src.split('\n');
  const start = lines.indexOf(EXEC_PROXY_HEADER);
  assert.ok(start >= 0, `exec-proxy.md に表の見出し行 "${EXEC_PROXY_HEADER}" が無い`);
  return lines.slice(start + 2).filter((l) => l.startsWith('| ')).map((l) => l.split('|').slice(1, -1).map((c) => c.trim()));
}

// `<i>` 等の実行時の値は template literal の `${...}` に当たる
function labelInWorkflow(label) {
  const parts = label.split(/<[^>]+>/);
  if (parts.length === 1) return new RegExp(`['"\`]${escapeRe(label)}['"\`]`).test(workflowSrc);
  return new RegExp(`\`${parts.map(escapeRe).join('\\$\\{[^}]+\\}')}\``).test(workflowSrc);
}

test('(l) exec-proxy.md は 30KB 以下の失敗ポリシー表で、各行のポリシーが fail-closed / fail-safe / fail-open のどれかから始まる', () => {
  const size = Buffer.byteLength(execProxySrc, 'utf8');
  assert.ok(size <= EXEC_PROXY_MAX_BYTES, `exec-proxy.md が ${size} bytes（上限 ${EXEC_PROXY_MAX_BYTES} bytes）`);
  const rows = execProxyRows(execProxySrc);
  assert.ok(rows.length > 0, 'exec-proxy.md の失敗ポリシー表に行が無い');
  for (const cells of rows) {
    assert.equal(cells.length, 4, `列数が 4 でない行: ${cells[0]}`);
    assert.match(cells[2], /^fail-(closed|safe|open)/, `ポリシー列が fail-closed / fail-safe / fail-open で始まらない: ${cells[0]}`);
    assert.ok(cells[3].length > 0, `理由が空: ${cells[0]}`);
  }
});

test('(m) exec-proxy.md の表の label はすべて .claude/workflows/*.js に実在し、agent の tools・maxTurns を書き写さない', () => {
  const missing = [];
  for (const [first] of execProxyRows(execProxySrc)) {
    const seg = first.split('<br>').find((s) => s.startsWith('label:'));
    assert.ok(seg, `1 列目に "label:" の段が無い: ${first}`);
    const labels = [...seg.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    if (labels.length === 0) assert.equal(seg, 'label: なし', `label を backtick で挙げていない: ${seg}`);
    for (const label of labels) if (!labelInWorkflow(label)) missing.push(`${first.split('<br>')[0]}: ${label}`);
  }
  assert.deepEqual(missing, [], `workflow に無い label を挙げている:\n${missing.join('\n')}`);
  const copied = execProxySrc.match(/maxTurns\D{0,4}\d|tools:\s*\[|\[Bash\b/);
  assert.equal(copied, null, `exec-proxy.md に agent の frontmatter を書き写している: ${copied?.[0]}`);
  assert.ok(execProxySrc.includes('`agents/*.md` の frontmatter'), 'exec-proxy.md が agent の担当を agents/*.md の frontmatter で指していない');
});

test('(n) 起動形と GitHub I/O の規範は rules にだけ置き、exec-proxy.md はそれを指す', () => {
  const anchor = 'sandbox / excludedCommands / 特定パス起動の理由を書いてはならない';
  const holders = [['rules', rulesSrc], ...REFERENCE_FILES.map((f) => [f, readFileSync(join(REFERENCES_ABS, f), 'utf8')])]
    .filter(([, src]) => src.replace(/\n>?\s*/g, '').includes(anchor))
    .map(([name]) => name);
  assert.deepEqual(holders, ['rules'], `GitHub I/O の規範が rules 以外にもある: ${holders.join(', ')}`);
  const exec = rulesSrc.split('\n## exec-proxy')[1] ?? '';
  for (const s of ['push は `pr-push`（`git push origin HEAD`）', '`origin/<branch>`', 'index を書く git', 'prerun は repo の任意コードを実行しない', '`security-review-isolated`']) {
    assert.ok(exec.includes(s), `rules の exec-proxy 節に「${s}」が無い`);
  }
  assert.ok(execProxySrc.includes('`.claude/rules/dev-flow.md`'), 'exec-proxy.md が rules を指していない');
});

// GitHub I/O の段落は適用範囲と、スクリプトが持てる認証付き network I/O を列挙し尽くす。列挙の外に例外を書き足すと
// 「例外はない」と同じ段落で矛盾し、正当化の置き場所に実在しないファイルを挙げると規範の根拠を辿れない
test('(w) rules の exec-proxy 節の GitHub I/O の段落は適用範囲・許す network I/O の 2 つ・書き込み系 gh の置き場所・正当化の置き場所を書く', () => {
  const exec = (rulesSrc.split('\n## exec-proxy')[1] ?? '').split('\n## ')[0].replace(/\n>?\s*/g, '');
  const phrases = {
    '(a) 適用範囲': '適用範囲は workflow の subagent が起動する `bin/` のスクリプト',
    '(a) preflight は範囲の外': 'skill wrapper の preflight の `dev-flow-prerun`・`pr-iterate-prerun` は範囲の外',
    '(b) 読み取り専用の gh 1 回': '読み取り専用の gh を 1 回（snapshot 1 枚。失敗は error / ok:false に倒し成功を合成しない）',
    '(b) pr-push の push': '`pr-push` の push（`start` / `wait` / `stop` で切り離す',
    '(b) 2 つに限り例外はない': 'の 2 つに限り、その外に**例外はない**',
    '(c) 書き込み系の gh': '書き込み系の gh は subagent の bare 単文に置く',
    '(d) 正当化の置き場所': '設定の正当化は本ファイルにだけ置き',
  };
  for (const [name, s] of Object.entries(phrases)) {
    assert.ok(exec.includes(s), `rules の exec-proxy 節に ${name}「${s}」が無い`);
  }
  assert.ok(!exec.includes('AGENTS.md'), 'rules の exec-proxy 節が正当化の置き場所に AGENTS.md を挙げている');
});

// dev-flow.js の構造の規範は rules の 1 行にだけ置き、その行が名指す phase・起動 workflow を dev-flow.js と集合一致で照合する
// （片方向の包含では、工程の切り出しで dev-flow.js から消えた名前が rules に残っても通る）
const STRUCTURE_ANCHOR = 'に足してよいのは工程の起動・state の受け渡し・ゲートの分岐だけ';
const devFlowJsSrc = readFileSync(join(WORKFLOWS_ABS, 'dev-flow.js'), 'utf8');

function structureNames(src) {
  return [
    ...[...src.matchAll(/phase\('([^']+)'\)/g)].map((m) => `phase('${m[1]}')`),
    ...[...src.matchAll(/workflow\('dev-flow:([^']+)'/g)].map((m) => `workflow('dev-flow:${m[1]}')`),
  ];
}

// dev-flow.js の本文と rules の行の名前集合の差を返す（どちらも空なら一致）
function structureMismatch(devFlow, rulesLine) {
  const code = new Set(structureNames(devFlow));
  const doc = new Set(structureNames(rulesLine));
  return {
    onlyInRules: [...doc].filter((n) => !code.has(n)).sort(),
    onlyInDevFlow: [...code].filter((n) => !doc.has(n)).sort(),
  };
}

const structureLine = rulesSrc.split('\n').find((l) => l.includes(STRUCTURE_ANCHOR)) ?? '';

test('(p) dev-flow.js の構造の規範は rules にだけ置き、AGENTS.md・pipeline.md・atlas は rules を指す', () => {
  const docs = ['AGENTS.md', '.claude/rules/dev-flow.md', `${REFERENCES_DIR}pipeline.md`, 'docs/dev-flow-atlas.md', 'plugins/dev-flow/dev-flow/SKILL.md'];
  const holders = docs.filter((p) => readFileSync(join(REPO_ROOT, p), 'utf8').replace(/\n>?\s*/g, '').includes(STRUCTURE_ANCHOR));
  assert.deepEqual(holders, ['.claude/rules/dev-flow.md'], `dev-flow.js の構造の規範が rules 以外にもある: ${holders.join(', ')}`);
  for (const p of ['AGENTS.md', `${REFERENCES_DIR}pipeline.md`, 'docs/dev-flow-atlas.md']) {
    assert.ok(readFileSync(join(REPO_ROOT, p), 'utf8').includes('.claude/rules/dev-flow.md'), `${p} が .claude/rules/dev-flow.md を指していない`);
  }
});

test('(q) rules の構造の行が名指す phase・起動 workflow は dev-flow.js と集合として等しい', () => {
  assert.ok(structureLine, `rules に構造の anchor 句「${STRUCTURE_ANCHOR}」を含む行が無い`);
  assert.ok(structureNames(devFlowJsSrc).length > 0, 'dev-flow.js から phase・workflow を読めない');
  assert.deepEqual(structureMismatch(devFlowJsSrc, structureLine), { onlyInRules: [], onlyInDevFlow: [] },
    'rules の構造の行と dev-flow.js の phase・起動 workflow が食い違う — rules の行を直す');
});

test('(r) 工程の切り出し・phase の追加は rules の行を直さない限り不一致になる', () => {
  assert.ok(devFlowJsSrc.includes("phase('Implement')"), "dev-flow.js に phase('Implement') が無い");
  const extracted = devFlowJsSrc.replaceAll("phase('Implement')", '') + "\nworkflow('dev-flow:dev-flow-implement-run')";
  assert.deepEqual(structureMismatch(extracted, structureLine), {
    onlyInRules: ["phase('Implement')"],
    onlyInDevFlow: ["workflow('dev-flow:dev-flow-implement-run')"],
  });
  assert.deepEqual(structureMismatch(`${devFlowJsSrc}\nphase('Foo')`, structureLine), { onlyInRules: [], onlyInDevFlow: ["phase('Foo')"] });
});

const INVARIANT_ANCHORS = [
  STRUCTURE_ANCHOR,
  'merge は常に人間',
  '軸A',
  '1 issue = 1 PR',
  'sandbox / excludedCommands / 特定パス起動の理由を書いてはならない',
  '**例外はない**',
  'tools/sync-inlines.mjs --write',
  'Date.now',
  '--telemetry-json',
  'written:false',
  'verbatim 転写',
  'review-finding 決定論スクラバー',
  'モデル更新で撤去しない',
];

test('(d) 不変条件アンカーが全て rules に残っている', () => {
  const missing = INVARIANT_ANCHORS.filter((anchor) => !rulesSrc.includes(anchor));
  assert.equal(missing.length, 0, `不変条件アンカーが欠落している: ${JSON.stringify(missing)}`);
});

// reviewed_sha は渡した head_sha の写しかを見る出力の整合で、R2 を守るのは workflow の head 照合。
// 誤った根拠を incentive-structural（永続）に載せると撤去・変更の判断を誤らせる
test('(s) 敵対的 security review の incentive-structural は head 照合で clear を限り、reviewed_sha 一致を根拠に挙げない', () => {
  const line = rulesSrc.split('\n').find((l) => l.startsWith('- 敵対的 security review:'));
  assert.ok(line, 'rules に「敵対的 security review」の行が無い');
  assert.ok(line.includes('head 照合'), `敵対的 security review の行に head 照合が無い: ${line}`);
  assert.ok(!line.includes('`reviewed_sha` 一致で clear'), `敵対的 security review の行が reviewed_sha 一致を clear の根拠に挙げている: ${line}`);
});

// agent 指示の正当化クラス: evaluator・pr-reviewer・dev-implementer は各 `## ` 節（frontmatter と最初の `## ` より前を除く）に
// `正当化クラス: <class>` を書く。宣言が無い指示は sunset トリガが発火しても外してよいかを決められない
const AGENTS_ABS = join(PLUGIN_ROOT, 'agents');
const DECLARED_AGENT_FILES = ['evaluator.md', 'pr-reviewer.md', 'dev-implementer.md'];
const JUSTIFICATION_CLASSES = new Set(['contract', 'incentive-structural', 'blast-radius', 'capability-bound']);
const CLASS_DECL = /正当化クラス: ([^\s（()。、,）:]*)/g;
const agentSrc = Object.fromEntries(DECLARED_AGENT_FILES.map((f) => [f, readFileSync(join(AGENTS_ABS, f), 'utf8')]));

function agentSections(src) {
  const body = src.replace(/^---\n[\s\S]*?\n---\n/, '');
  return body.split(/^## /m).slice(1).map((block) => {
    const [heading, ...rest] = block.split('\n');
    return { heading: heading.trim(), body: rest.join('\n') };
  });
}

// 宣言の無い節と未知の class を返す（どちらも無ければ []）
function classDeclarationErrors(name, src) {
  const errors = [];
  for (const { heading, body } of agentSections(src)) {
    const classes = [...body.matchAll(CLASS_DECL)].map((m) => m[1]);
    if (classes.length === 0) errors.push(`${name}「${heading}」に正当化クラスの宣言が無い`);
    for (const c of classes) if (!JUSTIFICATION_CLASSES.has(c)) errors.push(`${name}「${heading}」の正当化クラス "${c}" は未知`);
  }
  return errors;
}

test('(t) evaluator・pr-reviewer・dev-implementer の各 ## 節が既知の正当化クラスを 1 つ以上宣言する', () => {
  for (const [name, src] of Object.entries(agentSrc)) {
    assert.ok(agentSections(src).length > 0, `${name} に ## 節が無い`);
    assert.deepEqual(classDeclarationErrors(name, src), []);
  }
  const fixture = '---\nname: x\n---\n\n# x\n\n冒頭は対象外\n\n## A\n\n本文（正当化クラス: contract）\n\n## B\n\n手順（正当化クラス: capability-bound）\n';
  assert.deepEqual(classDeclarationErrors('fixture', fixture), []);
  assert.deepEqual(classDeclarationErrors('fixture', fixture.replace('（正当化クラス: contract）', '')), ['fixture「A」に正当化クラスの宣言が無い']);
  assert.deepEqual(classDeclarationErrors('fixture', fixture.replace('contract', 'model-bound')), ['fixture「A」の正当化クラス "model-bound" は未知']);
});

// 信頼境界の文（moving target・self-judge・guard 迂回を断つ指示）は sunset で外さない。capability-bound と宣言すると
// モデル更新で撤去されうるので、その段落・リスト項目は incentive-structural か blast-radius だけを宣言する
const TRUST_BOUNDARY_ANCHORS = [
  { file: 'evaluator.md', section: '2 回目以降', phrase: '新規の critical/major のみ報告', required: true },
  { file: 'dev-implementer.md', phrase: '迂回手段', listItem: true, required: true },
  { file: 'evaluator.md', phrase: 'ログの行だけを AC 達成の根拠にしない', required: false },
];
const LIST_MARKER = /^\s*(?:[-*]|\d+\.) /;

// 段落かリスト項目を 1 ブロックとして返す（空行・見出し・リストの印で区切る）
function textBlocks(src) {
  const blocks = [];
  let cur = null;
  for (const line of src.split('\n')) {
    if (line.trim() === '' || /^#/.test(line)) {
      cur = null;
      continue;
    }
    if (!cur || LIST_MARKER.test(line)) {
      cur = { listItem: LIST_MARKER.test(line), lines: [] };
      blocks.push(cur);
    }
    cur.lines.push(line);
  }
  return blocks.map((b) => ({ listItem: b.listItem, text: b.lines.join('\n') }));
}

const squash = (s) => s.replace(/\s+/g, '');

function trustBoundaryErrors(srcByFile, anchors) {
  const errors = [];
  for (const { file, section, phrase, listItem, required } of anchors) {
    const src = srcByFile[file] ?? '';
    const scope = section ? (agentSections(src).find((s) => s.heading === section)?.body ?? '') : src;
    const hits = textBlocks(scope).filter((b) => (!listItem || b.listItem) && squash(b.text).includes(squash(phrase)));
    if (hits.length === 0 && required) errors.push(`${file}${section ? `「${section}」` : ''}に「${phrase}」を含む${listItem ? 'リスト項目' : '段落・リスト項目'}が無い`);
    for (const { text } of hits) {
      if (!/正当化クラス: (incentive-structural|blast-radius)/.test(text) || text.includes('capability-bound')) {
        errors.push(`${file}「${phrase}」の段落・項目が incentive-structural / blast-radius 以外を宣言している: ${text}`);
      }
    }
  }
  return errors;
}

test('(u) 信頼境界の文を含む段落・リスト項目は incentive-structural か blast-radius を宣言し、capability-bound を持たない', () => {
  assert.deepEqual(trustBoundaryErrors(agentSrc, TRUST_BOUNDARY_ANCHORS), []);
  const fixture = {
    'evaluator.md': '## 2 回目以降\n\n新規の critical/major のみ報告する（正当化クラス: incentive-structural）。\n\n## 進め方\n\n1. ログの行だけを AC 達成の\n   根拠にしない（正当化クラス: incentive-structural）\n',
    'dev-implementer.md': '## 返す JSON\n\n- **guard_blocked**: 拒否された\n  - 迂回手段を探索しない。正当化クラス: blast-radius\n',
  };
  assert.deepEqual(trustBoundaryErrors(fixture, TRUST_BOUNDARY_ANCHORS), []);
  const withoutOptional = { ...fixture, 'evaluator.md': fixture['evaluator.md'].split('## 進め方')[0] };
  assert.deepEqual(trustBoundaryErrors(withoutOptional, TRUST_BOUNDARY_ANCHORS), []);
  for (const [file, from] of [['evaluator.md', '報告する（正当化クラス: incentive-structural）'], ['dev-implementer.md', 'blast-radius'], ['evaluator.md', '根拠にしない（正当化クラス: incentive-structural）']]) {
    const bad = { ...fixture, [file]: fixture[file].replace(from, from.replace(/incentive-structural|blast-radius/, 'capability-bound')) };
    assert.equal(trustBoundaryErrors(bad, TRUST_BOUNDARY_ANCHORS).length, 1, `${file} の capability-bound が通った: ${from}`);
  }
  const missing = { ...fixture, 'evaluator.md': fixture['evaluator.md'].replace('新規の critical/major のみ報告', '新規の指摘だけ報告') };
  assert.deepEqual(trustBoundaryErrors(missing, TRUST_BOUNDARY_ANCHORS), ['evaluator.md「2 回目以降」に「新規の critical/major のみ報告」を含む段落・リスト項目が無い']);
  const notListItem = { ...fixture, 'dev-implementer.md': '## 返す JSON\n\n迂回手段を探索しない。正当化クラス: blast-radius\n' };
  assert.equal(trustBoundaryErrors(notListItem, TRUST_BOUNDARY_ANCHORS).length, 1);
});

// capability-bound と宣言した節は capability-bound.md の「agent 指示の capability-bound な部分」の「何をするか」に
// `agents/<file>` の「<見出し>」で挙げる（sunset で外す指示をここから特定する）。挙げた節は宣言と一致させる
const AGENT_CAP_ITEM = 'agent 指示の capability-bound な部分';

function declaredCapabilitySections(srcByFile) {
  return Object.entries(srcByFile).flatMap(([file, src]) => agentSections(src)
    .filter(({ body }) => body.includes('正当化クラス: capability-bound'))
    .map(({ heading }) => `${file}「${heading.replace(/\s+/g, ' ')}」`)).sort();
}

function listedCapabilitySections(items) {
  const what = items.find(({ title }) => title === AGENT_CAP_ITEM)?.fields['何をするか'] ?? '';
  return [...what.matchAll(/`agents\/([\w-]+\.md)` の((?:\s*「[^」]+」)+)/g)]
    .flatMap(([, file, headings]) => [...headings.matchAll(/「([^」]+)」/g)].map(([, h]) => `${file}「${h}」`)).sort();
}

test('(v) capability-bound と宣言した節は capability-bound.md の agent 指示の項目に「何をするか」で全件挙がる', () => {
  assert.ok(capItems.some(({ title }) => title === AGENT_CAP_ITEM), `capability-bound.md に「${AGENT_CAP_ITEM}」の項目が無い`);
  const declared = declaredCapabilitySections(agentSrc);
  assert.ok(declared.length > 0, 'capability-bound と宣言した節が 1 つも無い');
  assert.deepEqual(listedCapabilitySections(capItems), declared, 'capability-bound.md の一覧と agents/ の capability-bound 宣言が食い違う');
  const added = { ...agentSrc, 'dev-implementer.md': `${agentSrc['dev-implementer.md']}\n## 追加の手順\n\n細部（正当化クラス: capability-bound）\n` };
  assert.notDeepEqual(listedCapabilitySections(capItems), declaredCapabilitySections(added));
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

test('(e) frontmatter の paths 配列が現状と同一の 8 エントリを含む', () => {
  const frontmatterMatch = rulesSrc.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(frontmatterMatch, 'frontmatter が見つからない');
  const frontmatter = frontmatterMatch[1];
  for (const p of EXPECTED_PATHS) {
    assert.ok(frontmatter.includes(`"${p}"`), `frontmatter の paths に "${p}" が含まれない`);
  }
});
