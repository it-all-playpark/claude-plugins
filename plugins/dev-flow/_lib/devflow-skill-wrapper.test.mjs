// Regression test: dev-flow/SKILL.md（起動 wrapper skill）が isolation preflight 手順を
// 呼び出し元セッションへ届けることを保証する。
//
// 背景: bg 起動セッションが isolation preflight を踏まずに Workflow('dev-flow-run') を直接叩くと、
// Setup 直後の isolation probe が written:false で fail-closed abort する（AGENTS.md /
// .claude/rules/dev-flow.md 参照）。dev-flow/SKILL.md は (1) base 解決、(2) worktree 作成/再利用、
// (3) EnterWorktree、(4) Workflow('dev-flow-run') 起動の 4 手順を明記し、直列複数 issue 実行時の
// worktree 切替も記述する必要がある。
//
// このテストは SKILL.md の存在と必須内容を source-string で assert する（決定論的 pin）。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const skillPath = join(repoRoot, 'dev-flow/SKILL.md');

// (a) dev-flow/SKILL.md が存在する
test('[devflow-skill-wrapper] dev-flow/SKILL.md が存在する', () => {
  assert.ok(existsSync(skillPath), 'dev-flow/SKILL.md が存在しない');
});

const src = readFileSync(skillPath, 'utf8');

// (b) dev-flow-run を含む（Workflow 起動が新名称）
test('[devflow-skill-wrapper] dev-flow-run（Workflow の新名称）を含む', () => {
  assert.ok(
    src.includes('dev-flow-run'),
    'dev-flow/SKILL.md に dev-flow-run が含まれない（Workflow 起動は新名称を使うこと）',
  );
});

// (c) EnterWorktree を含む
test('[devflow-skill-wrapper] EnterWorktree を含む', () => {
  assert.ok(
    src.includes('EnterWorktree'),
    'dev-flow/SKILL.md に EnterWorktree が含まれない（preflight 手順3）',
  );
});

// (d) dev-flow-prerun と df- を含む（preflight 手順2 + 命名規約）
test('[devflow-skill-wrapper] dev-flow-prerun と df- 命名規約を含む', () => {
  assert.ok(
    src.includes('dev-flow-prerun'),
    'dev-flow/SKILL.md に `dev-flow-prerun` が含まれない（preflight 手順2）',
  );
  assert.ok(
    src.includes('df-'),
    'dev-flow/SKILL.md に `df-` worktree 命名規約が含まれない',
  );
});

// (e) worktree 切替の明記（EnterWorktree が2回以上出現、または「切り替え」を含む）
test('[devflow-skill-wrapper] 直列複数 issue 実行時の worktree 切替を明記する', () => {
  const enterWorktreeCount = (src.match(/EnterWorktree/g) || []).length;
  assert.ok(
    enterWorktreeCount >= 2 || src.includes('切り替え'),
    'dev-flow/SKILL.md に直列複数 issue 実行時の worktree 切替（EnterWorktree 複数回言及 or「切り替え」）が明記されていない',
  );
});

// (f) 旧名での起動記述（Workflow({ name: 'dev-flow', ）を含まない
test('[devflow-skill-wrapper] 旧名 Workflow({ name: \'dev-flow\', を含まない', () => {
  assert.ok(
    !src.includes(`Workflow({ name: 'dev-flow',`),
    'dev-flow/SKILL.md に旧名での起動記述 `Workflow({ name: \'dev-flow\',` が残存している（dev-flow-run を使うこと）',
  );
});

// (g) namespaced Workflow 名（plugin 由来 nested workflow は namespaced 名でしか解決しない）
test('[devflow-skill-wrapper] namespaced 名 dev-flow:dev-flow-run で起動する', () => {
  assert.ok(
    src.includes("name: 'dev-flow:dev-flow-run'"),
    'dev-flow/SKILL.md に namespaced 起動記述 `name: \'dev-flow:dev-flow-run\'` が見つからない',
  );
});

// (h) 自前の git worktree add 記述が残存していない（worktree 作成は dev-flow-prerun に吸収済み）
test('[devflow-skill-wrapper] git worktree add を含まない（prerun に吸収済み）', () => {
  assert.ok(
    !src.includes('git worktree add'),
    'dev-flow/SKILL.md に `git worktree add` が残存している（worktree 作成は dev-flow-prerun に一本化すること）',
  );
});

// (i) args.setup 転記と unwritable 退避分岐を明記する
test('[devflow-skill-wrapper] args.setup 転記と unwritable 退避分岐を明記する', () => {
  assert.ok(
    src.includes('setup:'),
    'dev-flow/SKILL.md に `args.setup` への転記記述（`setup:`）が見つからない',
  );
  assert.ok(
    src.includes('unwritable'),
    'dev-flow/SKILL.md に worktree_status:"unwritable" の退避分岐が見つからない',
  );
  assert.ok(
    src.includes('--worktree'),
    'dev-flow/SKILL.md に `--worktree` オプションの記述が見つからない',
  );
});

// (k) needs_clarification 再起動で前回 setup を使い回す記述が無い
//     isolation probe の token は setup.epoch 固定で run 内に前回 probe の cleanup が無い。
//     同じ setup で再起動すると Write-only agent が既存 probe ファイルへの上書きで written:false →
//     fail-closed abort する。再起動は dev-flow-prerun を再実行して新 epoch を得る経路のみ許す。
test('[devflow-skill-wrapper] needs_clarification 再起動で setup を再利用してよいと書かない', () => {
  const section = src.slice(src.indexOf('## needs_clarification'));
  assert.ok(section.length > 0, 'dev-flow/SKILL.md に `## needs_clarification` 節が無い');
  for (const banned of ['そのまま再利用してよく', '再実行は不要']) {
    assert.ok(
      !section.includes(banned),
      `dev-flow/SKILL.md needs_clarification 節に「${banned}」が残存している（前回 setup の使い回しは probe token 衝突で abort する。dev-flow-prerun を再実行して新 epoch を渡すこと）`,
    );
  }
  assert.ok(
    section.includes('dev-flow-prerun') && section.includes('epoch'),
    'dev-flow/SKILL.md needs_clarification 節に dev-flow-prerun 再実行（新 epoch）の指示が無い',
  );
});

// (m) issue #868: deps install は prerun（repo の任意コードを実行しない）の子ではなく、wrapper が別の Bash 呼び出しで
//     `ensure-worktree-deps --setup <worktree>/.devflow-tmp/prerun-setup.json` として回し、その stdout を setup に渡す。
//     needs_clarification の再起動でも同じ段を通す（prerun 出力は deps / epoch_end を持たない）。
test('[devflow-skill-wrapper] deps install は手順2b の別 Bash 呼び出し（ensure-worktree-deps --setup）で回し、その stdout を setup に渡す', () => {
  const cmd = 'ensure-worktree-deps --setup <prerun 出力の worktree>/.devflow-tmp/prerun-setup.json';
  const step2b = src.slice(src.indexOf('2b. **deps install**'), src.indexOf('3. **EnterWorktree**'));
  assert.ok(step2b.includes(cmd), `dev-flow/SKILL.md 手順2b に \`${cmd}\` が無い`);
  assert.ok(step2b.includes('別の'), 'dev-flow/SKILL.md 手順2b に「手順2 とは別の Bash 呼び出し」の指示が無い');
  const step4 = src.slice(src.indexOf('4. **Workflow 起動**'));
  assert.ok(step4.includes('setup: <手順2bの'), 'dev-flow/SKILL.md 手順4 の setup が手順2b の stdout になっていない');
  const section = src.slice(src.indexOf('## needs_clarification'));
  assert.ok(section.includes('ensure-worktree-deps --setup'), 'needs_clarification 節の再起動手順に deps 段（手順2b）が無い');
});

// (n) issue #898: Jev の要否・効かないときの挙動・設定方法を、作者環境（jev-broker / Keychain）に依らず書く。
//     設定は作者の jev-classify の経路選択順（AI_GATEWAY_API_KEY → JEV_BROKER_SOCKET → Keychain service）に揃え、
//     AI_GATEWAY_API_KEY を第一の方法に、jev-broker は任意と明記する。クライアントは plugin に同梱しないので、
//     インターフェースの理由の先頭語は prerun-analyze.sh が見出しを付け分ける先頭語と一致させる。
test('[devflow-skill-wrapper] Jev 節に要否・効かないときの needs_clarification・AI_GATEWAY_API_KEY 第一の設定方法を書く', () => {
  const start = src.indexOf('## Jev');
  assert.ok(start >= 0, 'dev-flow/SKILL.md に `## Jev` 節が無い');
  const section = src.slice(start, src.indexOf('\n## ', start + 1));
  for (const s of ['必須ではない', 'needs_clarification', 'DEVFLOW_JEV_DISABLE=1', 'jev-broker（**任意**）']) {
    assert.ok(section.includes(s), `dev-flow/SKILL.md「Jev」節に '${s}' が無い`);
  }
  const order = ['AI_GATEWAY_API_KEY', 'JEV_BROKER_SOCKET', 'vercel-ai-gateway'].map((s) => section.indexOf(s));
  assert.ok(order.every((i) => i >= 0), `dev-flow/SKILL.md「Jev」節に設定経路の名前が欠けている: ${JSON.stringify(order)}`);
  assert.ok(order[0] < order[1] && order[1] < order[2], 'dev-flow/SKILL.md「Jev」節の設定方法が AI_GATEWAY_API_KEY → broker → Keychain の順になっていない');
  const analyzeSrc = readFileSync(join(repoRoot, 'dev-flow/scripts/prerun-analyze.sh'), 'utf8');
  const prefixes = [...analyzeSrc.matchAll(/^\s+"([a-zA-Z ]+)"\*\) label=/gm)].map((m) => m[1]).filter((p) => p !== 'not installed');
  assert.ok(prefixes.length >= 8, `prerun-analyze.sh から理由の先頭語を読めない: ${JSON.stringify(prefixes)}`);
  for (const p of prefixes) {
    assert.ok(section.includes(`\`${p}\``), `dev-flow/SKILL.md「Jev」節のインターフェースに理由の先頭語 '${p}' が無い（prerun-analyze.sh とずれている）`);
  }
  // 第三者が jev-classify を自作できるよう、questions / answers の形も prerun-analyze.sh が実際に送る・読むものと揃える
  const readKeys = [...analyzeSrc.matchAll(/\.answers(?:\.(\w+)|\[\$q\])\.(\w+)/g)].map((m) => [m[1] ?? 'ac_<n>', m[2]]);
  assert.ok(readKeys.length >= 4, `prerun-analyze.sh から読む answers のキーを取れない: ${JSON.stringify(readKeys)}`);
  for (const [id, field] of readKeys) {
    assert.ok(section.includes(`\`${id}\``), `dev-flow/SKILL.md「Jev」節に質問 id '${id}' が無い（prerun-analyze.sh とずれている）`);
    assert.ok(section.includes(`"${field}"`), `dev-flow/SKILL.md「Jev」節に応答のキー '${field}' が無い（prerun-analyze.sh とずれている）`);
  }
  const qTypes = new Set([...analyzeSrc.matchAll(/"type":"(\w+)"|type: "(\w+)"/g)].map((m) => m[1] ?? m[2]));
  assert.ok(qTypes.size >= 2, `prerun-analyze.sh から質問の型を取れない: ${JSON.stringify([...qTypes])}`);
  for (const t of qTypes) {
    assert.ok(section.includes(`"type":"${t}"`), `dev-flow/SKILL.md「Jev」節に質問の型 '${t}' が無い（prerun-analyze.sh とずれている）`);
  }
  const choices = Object.keys(JSON.parse(analyzeSrc.match(/COMMENT_Q='(.*)'$/m)[1]).kind.criteria);
  for (const c of choices) {
    assert.ok(section.includes(`\`${c}\``), `dev-flow/SKILL.md「Jev」節に選択肢 '${c}' が無い（prerun-analyze.sh とずれている）`);
  }
});

// (j) args.base を渡す旧形式が残存していない（base は dev-flow-prerun が解決する）
test('[devflow-skill-wrapper] Workflow args に旧形式 base を渡さない', () => {
  assert.ok(
    !src.includes("base: '<base>'"),
    'dev-flow/SKILL.md に旧形式 `args: { issue: <N>, base: \'<base>\' }` が残存している（base は dev-flow-prerun が解決するので渡さない）',
  );
});

// (l) PR phase 失敗（issue #823）: run は throw せず error_category=pr_phase_failed で返る。wrapper は返り値の
//     issue_comment を Write で .devflow-tmp に保存し、top-level の bare `gh issue comment --body-file` で issue に投稿する。
//     回収コマンドは .devflow-tmp に保存済みの commit message / PR body を使い、wrapper は push / PR 作成を再試行しない。
test('[devflow-skill-wrapper] PR phase 失敗（pr_phase_failed）は issue_comment を bare gh issue comment で issue に投稿し、push / PR 作成を再試行しない', () => {
  const start = src.indexOf('## PR phase 失敗の扱い');
  assert.ok(start >= 0, 'dev-flow/SKILL.md に `## PR phase 失敗の扱い` 節が無い');
  const section = src.slice(start, src.indexOf('\n## ', start + 1));
  for (const s of [
    'pr_phase_failed', 'issue_comment', 'Write tool', '.devflow-tmp/pr-phase-failure-comment.md',
    'bare 単文 `gh issue comment <issue> --repo <repo> --body-file', 'committed', 'failed_step',
    'git push origin HEAD', 'gh pr create --draft --body-file .devflow-tmp/pr-body.md', '/pr-iterate <N>',
    '.devflow-tmp/commit-msg.txt', '再生成しない', '再試行せず',
  ]) {
    assert.ok(section.includes(s), `dev-flow/SKILL.md「PR phase 失敗の扱い」節に '${s}' が無い`);
  }
});
