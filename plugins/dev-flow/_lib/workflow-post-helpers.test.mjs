// _lib/workflow-post-helpers.test.mjs
// Unit tests for workflow-post-helpers canonical.
//
// TDD-first: これらのテストが GREEN になることで canonical の仕様適合を保証する。
// node --test _lib/workflow-post-helpers.test.mjs で実行。

// issue #636 P2 pin 整理 (inventory 用):
// (削除) L56 'shell（echo/printf/heredoc 等）へ' — 唯一の assert だった test ごと削除
// (削除) L104 'shell（echo/printf/heredoc 等）へ' — 唯一の assert だった test ごと削除
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { bodySaveInstr, ghBareStepInstr, POST_RESULT } from './workflow-post-helpers.mjs';

const SAMPLE_BODY = '## PR サマリー\n\nこれはサンプル本文です。\n```js\nconst x = 1;\n```';
const BODY_FILE = '/wt/.devflow-tmp/dev-flow-summary.md';

// -----------------------------------------------------------------------
// bodySaveInstr: bodyFile モード（worktree の .devflow-tmp 固定パス）
// issue #712: mktemp で先に作ったファイルへの Write は「未 Read」で拒否され、agent が heredoc へ
// 逸れて投稿に失敗した。固定パスへ Write tool で新規作成させる。
// -----------------------------------------------------------------------

test('bodySaveInstr(bodyFile) — mktemp を指示しない', () => {
  const result = bodySaveInstr(SAMPLE_BODY, { bodyFile: BODY_FILE }, 'DEV_FLOW');
  assert.doesNotMatch(result, /mktemp/);
});

test('bodySaveInstr(bodyFile) — 固定パスを <BODY_FILE> とし Write tool で新規作成させる', () => {
  const result = bodySaveInstr(SAMPLE_BODY, { bodyFile: BODY_FILE }, 'DEV_FLOW');
  assert.ok(result.includes(`\`${BODY_FILE}\``), `固定パス ${BODY_FILE} が instruction に無い`);
  assert.ok(result.includes('以降 <BODY_FILE> はこのパスを指す'), '<BODY_FILE> と固定パスの対応が無い');
  assert.ok(result.includes('**Write tool** で新規作成する'), 'Write tool による新規作成の指示が無い');
  assert.ok(result.includes('Bash で事前に作らない'), 'Bash での事前作成禁止が無い');
});

test('bodySaveInstr(bodyFile) — 既存ファイル時のみ Read → Write で上書きさせる', () => {
  const result = bodySaveInstr(SAMPLE_BODY, { bodyFile: BODY_FILE }, 'DEV_FLOW');
  assert.ok(result.includes('既に存在する場合（前回の残り）のみ、先に **Read tool** で読んでから Write tool で上書きせよ'));
});

test('bodySaveInstr(bodyFile) — bodyFile モードは Bash を一切指示しない（パス解決不要）', () => {
  const result = bodySaveInstr(SAMPLE_BODY, { bodyFile: BODY_FILE }, 'DEV_FLOW');
  assert.doesNotMatch(result, /まず Bash で/);
});

test('bodySaveInstr(bodyFile) — DEV_FLOW delimiter で本文を verbatim に包む', () => {
  const result = bodySaveInstr(SAMPLE_BODY, { bodyFile: BODY_FILE }, 'DEV_FLOW');
  assert.ok(
    result.includes(`<<<DEV_FLOW_BODY_BEGIN>>>\n${SAMPLE_BODY}\n<<<DEV_FLOW_BODY_END>>>`),
    '<<<DEV_FLOW_BODY_BEGIN/END>>> delimiter が存在しない',
  );
});

test('bodySaveInstr(bodyFile) — PR_ITERATE delimiter を含む', () => {
  const result = bodySaveInstr(SAMPLE_BODY, { bodyFile: '/wt/.devflow-tmp/pr-iterate-summary-5.md' }, 'PR_ITERATE');
  assert.ok(
    result.includes(`<<<PR_ITERATE_BODY_BEGIN>>>\n${SAMPLE_BODY}\n<<<PR_ITERATE_BODY_END>>>`),
    '<<<PR_ITERATE_BODY_BEGIN/END>>> delimiter が存在しない',
  );
});

test('bodySaveInstr(bodyFile) — "Write tool" 安全文言を含む', () => {
  const result = bodySaveInstr(SAMPLE_BODY, { bodyFile: BODY_FILE }, 'DEV_FLOW');
  assert.ok(result.includes('Write tool の content 引数として渡す'), '"Write tool" という injection 対策文言が存在しない');
});

// -----------------------------------------------------------------------
// bodySaveInstr: saveDir + fileName モード（worktree を持たない呼び出し元）
// -----------------------------------------------------------------------

test('bodySaveInstr(saveDir) — mktemp を指示せず、固定ファイル名を単文 printf で解決させる', () => {
  const result = bodySaveInstr(SAMPLE_BODY, { saveDir: '${TMPDIR:-/tmp}/no-worktree', fileName: 'note-7.md' }, 'NO_WORKTREE');
  assert.doesNotMatch(result, /mktemp/);
  assert.ok(
    result.includes(`\`printf '%s\\n' "\${TMPDIR:-/tmp}/no-worktree/note-7.md"\` を 1 回だけ実行し`),
    `固定パスの解決指示が無い:\n${result.slice(0, 300)}`,
  );
  assert.ok(result.includes('**Write tool** で新規作成する'));
  assert.ok(result.includes(`<<<NO_WORKTREE_BODY_BEGIN>>>\n${SAMPLE_BODY}\n<<<NO_WORKTREE_BODY_END>>>`));
});

// -----------------------------------------------------------------------
// ghBareStepInstr: 投稿コマンドの起動形（closesReinjectPrompt と同一文言）
// -----------------------------------------------------------------------

test('ghBareStepInstr — コマンドを bare 単文 1 回・禁止句付きで指示する', () => {
  const cmd = 'gh pr comment 5 --repo acme/skills --body-file /wt/.devflow-tmp/x.md';
  assert.equal(
    ghBareStepInstr(cmd),
    `\`${cmd}\` を先頭トークンが gh の bare 単文で 1 回だけ実行せよ`
      + '（cd 前置・bash 前置・環境変数代入前置・&& 連結・パイプ・リダイレクト禁止）。\n',
  );
});

// -----------------------------------------------------------------------
// POST_RESULT schema
// -----------------------------------------------------------------------

test('POST_RESULT — type は "object"', () => {
  assert.equal(POST_RESULT.type, 'object');
});

test('POST_RESULT — required は ["posted"] のみ', () => {
  assert.deepEqual(POST_RESULT.required, ['posted']);
});

test('POST_RESULT — properties に posted がある', () => {
  assert.ok('posted' in POST_RESULT.properties, 'POST_RESULT.properties.posted が存在しない');
});

test('POST_RESULT — properties に method がある', () => {
  assert.ok('method' in POST_RESULT.properties, 'POST_RESULT.properties.method が存在しない');
});

test('POST_RESULT — properties に url がある', () => {
  assert.ok('url' in POST_RESULT.properties, 'POST_RESULT.properties.url が存在しない');
});
