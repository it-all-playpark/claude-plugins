// pr-reviewer-delta-contract.test.mjs
// `plugins/dev-flow/agents/pr-reviewer.md` の「反復レビュー」節が fix delta 前提で書かれていること、
// および lockfile / inline 生成区間の読み飛ばし規則があることを source-pin する静的テスト。
//
// 守っている不変条件:
//   - review#i（i ≥ 2）は `git diff <sha_prev>..<sha_now>` の delta のみを読む。「必要に応じて全体を確認」
//     等の裁量文言を残すと指示ベースの churn 対策に戻るため、文言の不在を pin する
//   - lockfile / `// ==== BEGIN inline:` 区間は CI が生成物一致を保証しているため読まない（理由つき）

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const MD_PATH = path.join(REPO_ROOT, 'plugins', 'dev-flow', 'agents', 'pr-reviewer.md');
const src = readFileSync(MD_PATH, 'utf8');

// 見出しから次の同レベル以上の見出しまでを切り出す
function section(text, headingFragment) {
  const idx = text.indexOf(headingFragment);
  assert.ok(idx >= 0, `pr-reviewer.md に見出し "${headingFragment}" が見つからない`);
  const start = text.lastIndexOf('\n', idx) + 1;
  const rest = text.slice(start);
  const next = rest.indexOf('\n## ', 1);
  return next >= 0 ? rest.slice(0, next) : rest;
}

const iterSection = section(src, '## 反復レビュー');

// ============================================================
// AC-4: 反復レビュー節は delta 前提
// ============================================================

test('[pr-reviewer-delta] 反復レビュー節に delta_range と git diff <sha_prev>..<sha_now> の手順がある', () => {
  assert.ok(iterSection.includes('delta_range'), `反復レビュー節に delta_range が無い:\n${iterSection.slice(0, 600)}`);
  assert.ok(iterSection.includes('git diff <sha_prev>..<sha_now>'), '反復レビュー節に `git diff <sha_prev>..<sha_now>` の手順が無い');
});

test('[pr-reviewer-delta] 反復レビュー節の手順: 既出 findings の解消確認 → delta 内 regression', () => {
  const resolvedIdx = iterSection.indexOf('解消されたか');
  const regressionIdx = iterSection.indexOf('regression');
  assert.ok(resolvedIdx >= 0, '既出 findings が delta で解消されたかの確認手順が無い');
  assert.ok(regressionIdx > resolvedIdx, 'delta 内 regression の手順が解消確認の後に無い');
  assert.ok(iterSection.includes('新規 critical/major'), 'delta 内の新規 critical/major のみ報告する指示が無い');
});

test('[pr-reviewer-delta] 「全 PR diff を再レビューするため」の前提文が削られている', () => {
  assert.ok(!src.includes('全 PR diff を再レビューするため'), '全 diff 再読を前提とする文が残っている');
});

test('[pr-reviewer-delta] 反復レビュー節に「必要に応じて全体を確認」等の裁量文言を含まない', () => {
  for (const phrase of ['必要に応じて全体', '必要なら全体', '全体を確認', '全体も確認', '全体も読', '全 diff も読', '判断で全体']) {
    assert.ok(!iterSection.includes(phrase), `反復レビュー節に裁量文言 "${phrase}" が含まれている`);
  }
});

test('[pr-reviewer-delta] delta 外の regression は CI / Final reconcile が担当と明記し、範囲を sha で機械的に決める', () => {
  assert.ok(iterSection.includes('delta 外'), 'delta 外の扱いが書かれていない');
  assert.ok(iterSection.includes('CI') && iterSection.includes('Final reconcile'), 'delta 外の regression の担当（CI / Final reconcile）が書かれていない');
  assert.ok(iterSection.includes('範囲を広げない'), 'reviewer の判断で範囲を広げない旨が無い');
});

test('[pr-reviewer-delta] 反復レビュー節と pipeline.md の pr-iterate 節に、full review の critical 後は full review に戻る条件がある', () => {
  const pipelineMd = readFileSync(path.join(REPO_ROOT, 'plugins', 'dev-flow', 'dev-flow', 'references', 'pipeline.md'), 'utf8');
  const start = pipelineMd.indexOf('\n## pr-iterate\n');
  assert.ok(start >= 0, 'pipeline.md に pr-iterate 節が無い');
  const next = pipelineMd.indexOf('\n## ', start + 1);
  const pipeline = next >= 0 ? pipelineMd.slice(start, next) : pipelineMd.slice(start);
  for (const [name, text] of [['pr-reviewer.md 反復レビュー節', iterSection], ['pipeline.md pr-iterate 節', pipeline]]) {
    assert.ok(/full review[^\n]*が critical を 1 件以上返したら/.test(text), `${name} に「full review が critical を返したら」の条件が無い`);
    assert.ok(text.includes('critical を返さない full review を経るまで'), `${name} に full review へ戻す期間（critical を返さない full review を経るまで）が無い`);
    assert.ok(text.includes('delta review が approve しただけでは LGTM にならない'), `${name} に delta review の approve だけでは LGTM にならない旨が無い`);
  }
});

test('[pr-reviewer-delta] 反復レビュー節と「蒸し返さない」の項に、critical 後の full review round では critical に上乗せ禁止を掛けない旨がある', () => {
  const itemStart = src.indexOf('- **蒸し返さない**');
  assert.ok(itemStart >= 0, '「蒸し返さない」の項が無い');
  const itemEnd = src.indexOf('\n- ', itemStart + 1);
  const noRehashItem = itemEnd >= 0 ? src.slice(itemStart, itemEnd) : src.slice(itemStart);
  for (const [name, text] of [['反復レビュー節', iterSection], ['「蒸し返さない」の項', noRehashItem]]) {
    assert.ok(text.includes('critical 後の full review round'), `${name} に critical 後の full review round の扱いが無い`);
    assert.ok(text.includes('critical に上乗せ禁止を掛けない'), `${name} に critical に上乗せ禁止を掛けない旨が無い`);
  }
  assert.ok(iterSection.includes('major の蒸し返し・別観点の上乗せの禁止') && iterSection.includes('topic 再利用はこの round でも変わらない'),
    '反復レビュー節に、critical 後の full review round でも major の禁止と topic 再利用が残る旨が無い');
});

test('[pr-reviewer-delta] 入力節に delta_range が定義されている', () => {
  const inputSection = section(src, '## 入力');
  assert.ok(inputSection.includes('delta_range: <sha_prev>..<sha_now>'), '入力節に delta_range の定義が無い');
});

// ============================================================
// AC-5: lockfile / inline 生成区間は読まない（理由つき）
// ============================================================

test('[pr-reviewer-delta] diff 確認手順に lockfile と inline 生成区間の読み飛ばし規則がある', () => {
  const stepSection = section(src, '## Step 1-2');
  for (const name of ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'flake.lock']) {
    assert.ok(stepSection.includes(name), `読み飛ばし規則に ${name} が無い`);
  }
  assert.ok(stepSection.includes('// ==== BEGIN inline:') && stepSection.includes('END inline'), '読み飛ばし規則に inline 生成区間が無い');
  assert.ok(stepSection.includes('読まない'), '「読まない」の指示が無い');
});

test('[pr-reviewer-delta] 読み飛ばし規則に理由（CI が一致を保証 / 読んでも finding にならず読む量だけ増える）がある', () => {
  const stepSection = section(src, '## Step 1-2');
  assert.ok(stepSection.includes('CI が一致を保証') || stepSection.includes('CI で byte 一致を保証'), '生成物一致を CI が保証している旨が無い');
  assert.ok(stepSection.includes('finding にならず') && stepSection.includes('読む量だけ増える'), '読み飛ばしの理由（finding にならず読む量だけ増える）が無い');
  assert.ok(stepSection.includes('workflow-inlines.sync.test.mjs'), '保証元テストの参照が無い');
});
