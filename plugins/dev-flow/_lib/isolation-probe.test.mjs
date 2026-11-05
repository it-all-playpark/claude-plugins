// issue #636 P2 pin 整理 (inventory 用):
// (置換) L49 '使用可: Write のみ。他の tool は使用禁止' — /\bWrite\b/ の tool 名 pin へ置換
// (削除) L54 '他の手段でファイルを作成しようと試みるな' — test ごと削除（言い回し pin、代替なし）
// (削除) L61 '例外を投げずに' — 同 test の "written": true/false, "error" pin は残置
// (削除) L268 '`.devflow-tmp` 以外のパスには触れるな' — 唯一の assert だった test ごと削除
// (削除) L277 '`.devflow-tmp/.isolation-probe` 以外のパスには触れるな' — 同 test の git -C clean match / 否定側 pin は残置
// (削除) L284 '存在しない場合もこのコマンドは成功する' — 唯一の assert だった test ごと削除
// (削除) L291 '例外を投げずに' — 同 test の "cleaned": true/false, "error" pin は残置
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  isolationCleanupPrompt,
  isolationProbePrompt,
  isolationErrorKind,
  isolationFailureMessage,
  ISOLATION_PROBE_CLEANUP_GLOB,
} from './isolation-probe.mjs';

// glob→RegExp 変換: `*` 以外の正規表現メタ文字をエスケープし `*` を `[^/]*` に変換する。
// probe token は isolationProbePrompt 内で `[^A-Za-z0-9._-]` を `-` に正規化済みのため `/` を
// 含まず、この変換は git pathspec wildmatch と本 pattern において等価。
function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`);
}

// isolationProbePrompt の出力から backtick 括りの probe 絶対パスを抽出する。
function probePathFrom(prompt) {
  const m = prompt.match(/`([^`]*\.isolation-probe-[^`]+)`/);
  assert.ok(m, `isolationProbePrompt の出力から probe パスを抽出できない:\n${prompt}`);
  return m[1];
}

// ── isolationProbePrompt ────────────────────────────────────────────────────

test('isolationProbePrompt: token がファイル名に入り、絶対パスとして明示される', () => {
  const prompt = isolationProbePrompt('/path/to/worktree', '1787000000');
  assert.match(prompt, /\/path\/to\/worktree\/\.devflow-tmp\/\.isolation-probe-1787000000/);
});

test('isolationProbePrompt: 異なる token は異なる probe パスを生成する', () => {
  const a = isolationProbePrompt('/path/to/worktree', '1000');
  const b = isolationProbePrompt('/path/to/worktree', '2000');
  assert.match(a, /\.isolation-probe-1000/);
  assert.match(b, /\.isolation-probe-2000/);
  assert.doesNotMatch(a, /\.isolation-probe-2000/);
  assert.doesNotMatch(b, /\.isolation-probe-1000/);
});

test('isolationProbePrompt: token 中の記号は "-" に正規化される', () => {
  const prompt = isolationProbePrompt('/wt', 'pr/455:2000');
  assert.match(prompt, /\.isolation-probe-pr-455-2000/);
});

test('isolationProbePrompt: Tools を Write のみに限定する指示を含む', () => {
  const prompt = isolationProbePrompt('/wt', '1000');
  assert.match(prompt, /\bWrite\b/);
});

test('isolationProbePrompt: 成功/失敗の verbatim 報告指示を含む', () => {
  const prompt = isolationProbePrompt('/wt', '1000');
  assert.match(prompt, /"written": true/);
  assert.match(prompt, /"written": false/);
  assert.match(prompt, /"error"/);
});

test('isolationProbePrompt: Write tool 以外の言及がない（Bash 等のフォールバック手段を示唆しない）', () => {
  const prompt = isolationProbePrompt('/wt', '1000');
  assert.doesNotMatch(prompt, /Bash/);
  assert.doesNotMatch(prompt, /Read tool/);
});

// ── isolationErrorKind ──────────────────────────────────────────────────────

test('isolationErrorKind: Write tool の未 Read 上書き拒否シグネチャは overwrite_refused', () => {
  assert.equal(
    isolationErrorKind('File has not been read yet. Read it first before writing to it.'),
    'overwrite_refused',
  );
});

test('isolationErrorKind: bg-isolation guard シグネチャは isolation', () => {
  assert.equal(isolationErrorKind("parent bg session hasn't isolated"), 'isolation');
  assert.equal(isolationErrorKind('parent bg session hasnt isolated'), 'isolation');
});

test('isolationErrorKind: 空/undefined/その他は unknown', () => {
  assert.equal(isolationErrorKind(''), 'unknown');
  assert.equal(isolationErrorKind(undefined), 'unknown');
  assert.equal(isolationErrorKind('some other error'), 'unknown');
});

test('isolationErrorKind: 両方にマッチしうる場合は overwrite_refused を優先する', () => {
  assert.equal(
    isolationErrorKind('File has not been read yet. Read it first before writing to it. (bg-isolation guard)'),
    'overwrite_refused',
  );
});

// ── isolationFailureMessage ─────────────────────────────────────────────────

test('isolationFailureMessage: worktree/branch/startRef/workflow 名/args を含む復旧手順を返す', () => {
  const msg = isolationFailureMessage({
    worktree: '/repo/.claude/worktrees/df-123', branch: 'feature/issue-123', startRef: 'origin/main',
    workflowName: 'dev-flow', workflowArgs: '123', error: 'some other error',
  });
  assert.match(msg, /\/repo\/\.claude\/worktrees\/df-123/);
  assert.match(msg, /feature\/issue-123/);
  assert.match(msg, /origin\/main/);
  assert.match(msg, /Workflow\(\{ name: "dev-flow", args: "123" \}\)/);
});

test('isolationFailureMessage: kind=isolation の見出しは bg-isolation guard に言及する', () => {
  const msg = isolationFailureMessage({
    worktree: '/repo', branch: 'feature/issue-1', startRef: 'origin/main',
    workflowName: 'pr-iterate', workflowArgs: '455', error: "parent bg session hasn't isolated",
  });
  assert.match(msg, /^pr-iterate: worktree isolation エラー/);
  assert.match(msg, /implementer が \/repo に書き込めません/);
  assert.match(msg, /bg-isolation guard の可能性/);
  assert.match(msg, /pr-iterate を再起動してください/);
  assert.match(msg, /Workflow\(\{ name: "pr-iterate", args: "455" \}\)/);
});

test('isolationFailureMessage: kind=overwrite_refused の見出しは上書き拒否・別原因を明示する', () => {
  const msg = isolationFailureMessage({
    worktree: '/repo', branch: 'feature/issue-1', startRef: 'origin/main',
    workflowName: 'dev-flow', workflowArgs: '1',
    error: 'File has not been read yet. Read it first before writing to it.',
  });
  assert.match(msg, /^dev-flow: isolation probe 書き込み失敗 — 既存 probe ファイルの上書き拒否/);
  assert.match(msg, /isolation 不成立とは別原因/);
  assert.match(msg, /前 run の残置物が同名パスに残っている可能性/);
});

test('isolationFailureMessage: kind=unknown の見出しは原因不明として fail-closed する', () => {
  const msg = isolationFailureMessage({
    worktree: '/repo', branch: 'feature/issue-1', startRef: 'origin/main',
    workflowName: 'dev-flow', workflowArgs: '1', error: '',
  });
  assert.match(msg, /^dev-flow: isolation probe 書き込み失敗 — 原因を特定できず/);
  assert.match(msg, /isolation 不成立の可能性を含む/);
});

for (const [label, error] of [
  ['isolation', "parent bg session hasn't isolated"],
  ['overwrite_refused', 'File has not been read yet. Read it first before writing to it.'],
  ['unknown', 'some other error'],
]) {
  test(`isolationFailureMessage: kind=${label} でも復旧 3 手順を番号付きで含む`, () => {
    const msg = isolationFailureMessage({
      worktree: '/repo/.claude/worktrees/df-1', branch: 'feature/issue-1', startRef: 'origin/dev',
      workflowName: 'dev-flow', workflowArgs: '1', error,
    });
    assert.match(msg, /1\. git worktree add -b feature\/issue-1/);
    assert.match(msg, /2\. EnterWorktree\(/);
    assert.match(msg, /3\. Workflow\(/);
    assert.match(msg, /新しい worktree には前 run の残置物が無い/);
  });
}

test('isolationFailureMessage: EnterWorktree の path は .claude/worktrees/ 以降の相対パスに変換される', () => {
  const msg = isolationFailureMessage({
    worktree: '/Users/x/ghq/github.com/o/r/.claude/worktrees/df-42', branch: 'feature/issue-42', startRef: 'origin/main',
    workflowName: 'dev-flow', workflowArgs: '42', error: '',
  });
  assert.match(msg, /EnterWorktree\(\{ path: "\.claude\/worktrees\/df-42" \}\)/);
  assert.doesNotMatch(msg, /path: "\/Users\/x\/ghq/);
});

test('isolationFailureMessage: .claude/worktrees/ を含まない worktree パスはそのまま使われる', () => {
  const msg = isolationFailureMessage({
    worktree: '/tmp/some-other-wt', branch: 'feature/issue-9', startRef: 'origin/main',
    workflowName: 'dev-flow', workflowArgs: '9', error: '',
  });
  assert.match(msg, /EnterWorktree\(\{ path: "\/tmp\/some-other-wt" \}\)/);
});

test('isolationFailureMessage: repo 外 <repo>-wt/df-<N> レイアウトは絶対パスのまま EnterWorktree/git worktree add に提示される（issue #528）', () => {
  const msg = isolationFailureMessage({
    worktree: '/Users/x/ghq/github.com/o/r-wt/df-528', branch: 'feature/issue-528', startRef: 'origin/main',
    workflowName: 'dev-flow-run', workflowArgs: '528', targetPath: '/Users/x/ghq/github.com/o/r-wt/df-528', error: '',
  });
  assert.match(msg, /EnterWorktree\(\{ path: "\/Users\/x\/ghq\/github\.com\/o\/r-wt\/df-528" \}\)/);
  assert.match(msg, /git worktree add -b feature\/issue-528 \/Users\/x\/ghq\/github\.com\/o\/r-wt\/df-528 origin\/main/);
  assert.doesNotMatch(msg, /path: "\.claude\/worktrees/);
});

test('isolationFailureMessage: targetPath 指定時は worktree（書き込み失敗先）と異なる先を回避手順に提示する', () => {
  const msg = isolationFailureMessage({
    worktree: '/repo', branch: 'feature/issue-455', startRef: 'origin/main',
    workflowName: 'pr-iterate', workflowArgs: '455', error: "parent bg session hasn't isolated",
    targetPath: '/repo/.claude/worktrees/pr-455',
  });
  assert.match(msg, /implementer が \/repo に書き込めません/);
  assert.match(msg, /1\. git worktree add -b feature\/issue-455 \/repo\/\.claude\/worktrees\/pr-455/);
  assert.match(msg, /EnterWorktree\(\{ path: "\.claude\/worktrees\/pr-455" \}\)/);
  assert.doesNotMatch(msg, /git worktree add -b feature\/issue-455 \/repo origin/);
});

test('isolationFailureMessage: branch 既存時の代替コマンドを案内する（pr-iterate では head_ref がローカル既存になりやすい）', () => {
  const msg = isolationFailureMessage({
    worktree: '/repo', branch: 'feature/issue-449', startRef: 'origin/feature/issue-449',
    workflowName: 'pr-iterate', workflowArgs: '455', error: '',
    targetPath: '/repo/.claude/worktrees/pr-455',
  });
  assert.match(msg, /git worktree add \/repo\/\.claude\/worktrees\/pr-455 feature\/issue-449/);
  assert.match(msg, /worktree \/repo\/\.claude\/worktrees\/pr-455 自体が既存なら本手順ごと不要/);
  // branch が他 worktree で checkout 済み（実測 #417 の「cwd が df-<issue> のまま未 isolate」）だと
  // 上記フォールバックも already checked out で拒否されるため --force 版まで案内する。
  assert.match(msg, /git worktree add --force \/repo\/\.claude\/worktrees\/pr-455 feature\/issue-449/);
});

test('isolationFailureMessage: startRef は verbatim で使われる（関数側で origin/ を補わない）', () => {
  const msg = isolationFailureMessage({
    worktree: '/repo/.claude/worktrees/df-7', branch: 'feature/issue-7', startRef: 'upstream/release-1.x',
    workflowName: 'dev-flow', workflowArgs: '7', error: '',
  });
  assert.match(msg, /git worktree add -b feature\/issue-7 \/repo\/\.claude\/worktrees\/df-7 upstream\/release-1\.x/);
  assert.doesNotMatch(msg, /origin\/upstream/);
});

test('isolationFailureMessage: pr-iterate は PR head 起点を提示できる（base 起点だと PR の変更を含まない）', () => {
  const msg = isolationFailureMessage({
    worktree: '/repo', branch: 'feature/issue-449', startRef: 'origin/feature/issue-449',
    workflowName: 'pr-iterate', workflowArgs: '455', error: '',
    targetPath: '/repo/.claude/worktrees/pr-455',
  });
  assert.match(msg, /1\. git worktree add -b feature\/issue-449 \/repo\/\.claude\/worktrees\/pr-455 origin\/feature\/issue-449/);
  assert.doesNotMatch(msg, /origin\/main/);
});

test('isolationFailureMessage: error が非空なら probe error を末尾に含む', () => {
  const msg = isolationFailureMessage({
    worktree: '/wt', branch: 'b', startRef: 'origin/main', workflowName: 'dev-flow', workflowArgs: '1', error: 'EPERM: denied',
  });
  assert.match(msg, /probe error: EPERM: denied/);
});

test('isolationFailureMessage: error が空文字なら probe error 行を含まない', () => {
  const msg = isolationFailureMessage({
    worktree: '/wt', branch: 'b', startRef: 'origin/main', workflowName: 'dev-flow', workflowArgs: '1', error: '',
  });
  assert.doesNotMatch(msg, /probe error:/);
});

// ── issue #493: stale 残置物の除去は cleanup へ分離し probe prompt を最小契約に戻す ─────
//
// issue #482 は「stale な .devflow-tmp/.isolation-probe があると Write が拒否され written:false →
// fail-closed abort する」問題に対し probe prompt 側の Read-then-Write 冪等化で対処していた。
// issue #493 で除去自体を probe 実行前の cleanup（gitignored な .devflow-tmp/ 限定の git clean）へ
// 移したため、probe prompt からは冪等化手順を落とす。issue #521 でさらに probe 対象パスを run 毎に
// 一意な token 付きにし、成立自体を cleanup 成功に依存させない（#482 の再発を構造的に防ぐ）。

test('isolationCleanupPrompt: worktree 直下の .devflow-tmp を git clean で除去させる', () => {
  const prompt = isolationCleanupPrompt('/repo/.claude/worktrees/df-493', '.devflow-tmp');
  assert.match(prompt, /git -C \/repo\/\.claude\/worktrees\/df-493 clean -fdx -- \.devflow-tmp/);
  assert.match(prompt, /gitignored/);
});

// nested 起動（dev-flow → workflow('pr-iterate')）では worktree が実行中 run のものになるため、
// pr-iterate は probe artifact 単体に絞れる必要がある（.devflow-tmp 全体を消すと当該 run の trust
// 証跡を run 途中で失う）。target は verbatim で使われ、関数側が範囲を広げないことを pin する。
test('isolationCleanupPrompt: target は verbatim で使われる（呼び出し元が範囲を決める）', () => {
  const prompt = isolationCleanupPrompt('/wt', '.devflow-tmp/.isolation-probe');
  assert.match(prompt, /git -C \/wt clean -fdx -- \.devflow-tmp\/\.isolation-probe/);
  // `.devflow-tmp` 全体を対象にする記述へ勝手に広げない
  assert.doesNotMatch(prompt, /clean -fdx -- \.devflow-tmp\s/);
});

test('isolationCleanupPrompt: 失敗時は例外を投げず cleaned:false + error で報告させる', () => {
  const prompt = isolationCleanupPrompt('/wt', '.devflow-tmp');
  assert.match(prompt, /"cleaned": true/);
  assert.match(prompt, /"cleaned": false/);
  assert.match(prompt, /"error"/);
});

// ── ISOLATION_PROBE_CLEANUP_GLOB: probe 生成パス vs cleanup glob の意味論マッチ (issue #555) ──
//
// pr-iterate の isolation-cleanup は probe が実際に書くパス（.isolation-probe-<token>）を
// 除去できる target を使わねばならない。文字列一致 pin ではなく、isolationProbePrompt の
// 出力から抽出した実パスに対する glob マッチ判定で検証する。

test('ISOLATION_PROBE_CLEANUP_GLOB: isolationProbePrompt(token 形) が生成する相対パスにマッチする', () => {
  const worktree = '/wt';
  const prompt = isolationProbePrompt(worktree, '1787000000');
  const absPath = probePathFrom(prompt);
  assert.ok(absPath.startsWith(`${worktree}/`), `probe path が worktree 配下でない: ${absPath}`);
  const relPath = absPath.slice(worktree.length + 1);
  assert.match(relPath, globToRegExp(ISOLATION_PROBE_CLEANUP_GLOB));
});

test('ISOLATION_PROBE_CLEANUP_GLOB: legacy 無 token 形 .devflow-tmp/.isolation-probe にもマッチする', () => {
  assert.match('.devflow-tmp/.isolation-probe', globToRegExp(ISOLATION_PROBE_CLEANUP_GLOB));
});

test('ISOLATION_PROBE_CLEANUP_GLOB: 記号入り token（正規化後）の生成パスにもマッチする', () => {
  const worktree = '/wt';
  const prompt = isolationProbePrompt(worktree, 'pr/455:2000');
  const absPath = probePathFrom(prompt);
  const relPath = absPath.slice(worktree.length + 1);
  assert.equal(relPath, '.devflow-tmp/.isolation-probe-pr-455-2000');
  assert.match(relPath, globToRegExp(ISOLATION_PROBE_CLEANUP_GLOB));
});
