// pr-iterate/SKILL.md（/pr-iterate 単体起動の wrapper skill。issue #828）が isolation preflight を
// prerun → EnterWorktree → Workflow 起動の順で呼び出し元セッションへ届けることを source-string で pin する。
//
// 背景: 単体起動で Workflow を直接起動すると、pr-iterate.js が haiku に gh pr view を転写させる pr-meta と
// isolation-cleanup を毎回 spawn し、isolation probe が written:false なら人間に worktree 作成と EnterWorktree を
// やらせていた。wrapper は pr-iterate-prerun（決定論）で worktree を用意し、その値を nested
// （caller:'standalone'）で渡して pr-iterate.js の NESTED 分岐に乗せる。nested を受けた workflow の挙動は
// priterate-isolation-wiring.test.mjs / priterate-outside-worktree-routing.test.mjs が VM 実行で pin する。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = join(here, '..');
const skillPath = join(pluginRoot, 'pr-iterate/SKILL.md');

test('[priterate-skill-wrapper] pr-iterate/SKILL.md が存在し、skill 名は pr-iterate（workflow 名 pr-iterate-run と衝突しない）', () => {
  assert.ok(existsSync(skillPath), 'pr-iterate/SKILL.md が存在しない');
  const src = readFileSync(skillPath, 'utf8');
  assert.match(src, /^---\nname: pr-iterate\n/, 'frontmatter の name が pr-iterate でない');
});

const src = existsSync(skillPath) ? readFileSync(skillPath, 'utf8') : '';
const steps = src.slice(src.indexOf('## Preflight 手順'));

test('[priterate-skill-wrapper] prerun → EnterWorktree → Workflow 起動の順に実行する', () => {
  const prerun = steps.indexOf('`pr-iterate-prerun <PR>`');
  const enter = steps.indexOf("EnterWorktree({ path: '<prerun 出力の worktree>' })");
  const launch = steps.indexOf("Workflow({ name: 'dev-flow:pr-iterate-run'");
  assert.ok(prerun >= 0, 'prerun（bare 名 pr-iterate-prerun <PR>）の手順が無い');
  assert.ok(enter >= 0, 'EnterWorktree の手順が無い');
  assert.ok(launch >= 0, "namespaced 名 dev-flow:pr-iterate-run での Workflow 起動が無い");
  assert.ok(prerun < enter && enter < launch, `順序が prerun → EnterWorktree → Workflow でない: ${prerun}, ${enter}, ${launch}`);
});

test('[priterate-skill-wrapper] Workflow の nested に prerun の値（cwd, head_ref, head_sha, repo, epoch）と caller:standalone を渡す', () => {
  const launch = steps.slice(steps.indexOf("Workflow({ name: 'dev-flow:pr-iterate-run'"));
  const nested = launch.slice(launch.indexOf('nested: {'), launch.indexOf('}', launch.indexOf('nested: {')));
  for (const key of ["caller: 'standalone'", 'cwd: <worktree>', 'head_ref: <head_ref>', 'head_sha: <head_sha>', 'repo: <repo>', 'epoch: <epoch>']) {
    assert.ok(nested.includes(key), `nested に '${key}' が無い: ${nested}`);
  }
});

test('[priterate-skill-wrapper] Workflow の args に prerun の prior_devflow を渡す（issue #930）', () => {
  const launch = steps.slice(steps.indexOf("Workflow({ name: 'dev-flow:pr-iterate-run'"));
  const args = launch.slice(0, launch.indexOf('} })'));
  assert.ok(args.includes('prior_devflow: <prior_devflow>'), `Workflow の args に prior_devflow が無い: ${args}`);
});

test('[priterate-skill-wrapper] Workflow の args に prerun の prior_summary を渡し、再 review 中コメントの意味を書く（issue #1065）', () => {
  const launch = steps.slice(steps.indexOf("Workflow({ name: 'dev-flow:pr-iterate-run'"));
  const args = launch.slice(0, launch.indexOf('} })'));
  assert.ok(args.includes('prior_summary: <prior_summary>'), `Workflow の args に prior_summary が無い: ${args}`);
  assert.ok(steps.includes('の結論はこの head に当てはまらない') && steps.includes('merge の根拠にしない'), '再 review 中コメントの意味が書かれていない');
});

test('[priterate-skill-wrapper] Workflow の args に prerun の ci_wait_ceiling_seconds を渡す（単体起動も base の CI 所要時間から決めた上限で待つ。issue #1046）', () => {
  const launch = steps.slice(steps.indexOf("Workflow({ name: 'dev-flow:pr-iterate-run'"));
  const args = launch.slice(0, launch.indexOf('} })'));
  assert.ok(args.includes('ci_wait_ceiling_seconds: <ci_wait_ceiling_seconds>'), `Workflow の args に ci_wait_ceiling_seconds が無い: ${args}`);
});

test('[priterate-skill-wrapper] 旧名 pr-iterate での Workflow 起動・自前の git worktree add・前回 prerun 出力の使い回しを書かない', () => {
  assert.doesNotMatch(src, /Workflow\(\{ name: '(dev-flow:)?pr-iterate'/, '旧名 pr-iterate での起動記述が残っている（alias は作らない）');
  assert.ok(!src.includes('git worktree add'), 'worktree 作成は pr-iterate-prerun に一本化する');
  const rerun = src.slice(src.indexOf('## 再実行'));
  assert.ok(rerun.includes('手順1 からやり直す') && rerun.includes('epoch'), '再実行で prerun をやり直す（新しい epoch）指示が無い');
});

test('[priterate-skill-wrapper] ok:false は error を人間に報告して停止し、worktree を自動削除しない', () => {
  assert.ok(steps.includes('(b) `ok:false` → `error` を verbatim で人間に報告して停止する'), 'ok:false の停止分岐が無い');
  assert.ok(src.includes('worktree は削除しない'), '単体起動の worktree を残す記述が無い');
});
