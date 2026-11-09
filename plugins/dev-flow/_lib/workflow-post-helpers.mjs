// workflow-post-helpers: PR/Issue コメント投稿・ジャーナル記録用の共通スキーマ・ヘルパー。
// I/O なし。bodySaveInstr / ghBareStepInstr は agent 向け instruction 文字列を生成する純粋関数。
//
// INLINE COPY POLICY: workflow から参照される最上位宣言だけが tools/sync-inlines.mjs --write で inline 生成される。
// 直接 workflow 側を編集しない。一致は _lib/workflow-inlines.sync.test.mjs が検証する。

export const POST_RESULT = {
  type: 'object',
  required: ['posted'],
  properties: {
    posted: { type: 'boolean' },
    method: { type: 'string' },
    url: { type: 'string' },
  },
}

export const JOURNAL_RESULT = {
  type: 'object',
  required: ['logged'],
  properties: {
    logged: { type: 'boolean' },
    summary: { type: 'string' },
  },
}

/**
 * PR/Issue コメント本文保存の agent 向け instruction を生成する。
 * 本文は事前に作られていない固定パスへ Write tool で新規作成させる。一時ファイルを shell で先に
 * 作らせると、その既存ファイルへの Write が「未 Read」として Write tool に拒否され、agent が
 * shell 書き出し（heredoc 等）へ逸れる。固定パスは前回の残りがありうるので、既存時のみ Read → Write。
 * @param {string} body - 保存する本文
 * @param {{bodyFile?: string, saveDir?: string, fileName?: string}} target
 *   bodyFile: 保存先の絶対パス（worktree の `.devflow-tmp/<prefix>-<用途>.md`）。
 *   saveDir + fileName: worktree を持たない呼び出し元用。saveDir は shell 展開で
 *   解決する（例: `${TMPDIR:-/tmp}/<用途>`）。
 * @param {string} delimName - delimiter 名（例: 'DEV_FLOW', 'PR_ITERATE'）
 */
export function bodySaveInstr(body, { bodyFile, saveDir, fileName }, delimName) {
  const resolve = bodyFile
    ? `保存先は固定パス \`${bodyFile}\` とし、以降 <BODY_FILE> はこのパスを指す。\n`
    : `まず Bash で \`printf '%s\\n' "${saveDir}/${fileName}"\` を 1 回だけ実行し、出力された絶対パスを <BODY_FILE> とする。\n`
  return `## 本文の保存\n`
    + resolve
    + `<BODY_FILE> は Bash で事前に作らない（空ファイルの作成も禁止）。**Write tool** で新規作成する。\n`
    + `<BODY_FILE> が既に存在する場合（前回の残り）のみ、先に **Read tool** で読んでから Write tool で上書きせよ。\n`
    + `**Write tool** を使い、下記 delimiter 内の本文を\n`
    + `**一字一句そのまま** <BODY_FILE> へ書き出せ。本文は絶対に shell（echo/printf/heredoc 等）へ\n`
    + `渡さず、必ず Write tool の content 引数として渡すこと。backtick やコードフェンスを\n`
    + `エスケープ・改変しないこと。以降のコマンドの \`--body-file\` には <BODY_FILE> を指定する。\n`
    + `<<<${delimName}_BODY_BEGIN>>>\n${body}\n<<<${delimName}_BODY_END>>>\n\n`
}

/**
 * gh の投稿コマンドを bare 単文で 1 回だけ実行させる instruction 行を生成する
 * （起動形の文言は dev-flow.js の closesReinjectPrompt と同一）。
 * @param {string} cmd - 先頭トークンが gh のコマンド全文（`--repo <REPO>` 付き）
 */
export function ghBareStepInstr(cmd) {
  return `\`${cmd}\` を先頭トークンが gh の bare 単文で 1 回だけ実行せよ`
    + `（cd 前置・bash 前置・環境変数代入前置・&& 連結・パイプ・リダイレクト禁止）。\n`
}
