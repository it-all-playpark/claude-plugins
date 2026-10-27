// Validate の各回（runValidateLoop の commit-hook#<iter>）で対象 repo の pre-commit hook を実行する exec-proxy の
// prompt・schema と、応答から green-fix に渡す失敗を取り出す純関数の canonical。issue #1188。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。
//
// hook の実行・stage 内容（PR phase と同じ add -A → .devflow-tmp を外す。一時 index）・hook の有無の判定は
// `pre-commit-hook`（_shared/scripts/pre-commit-hook.sh）が行う。agent の仕事は stdout の verbatim 転写だけ。
// hook の失敗（hook:'failed'）だけがその回の Validate を green にしない。none / passed / error / 転写の失敗（null）は
// 何も足さない — hook は Validate の green 条件に足すだけで、hook が回らなかったことを red に倒すと hook を
// 起動できない環境（古い git 等）で全 run が green-fix を使い切る。PR phase の commit は今どおり同じ hook を通るので、
// ここで拾えなかった失敗はそこで止まる。hook の passed を HOLD を外す・テストを省く根拠には使わない（hook は PR が
// 書き換えられる対象 repo のコード）。

export const PRE_COMMIT_HOOK_SCHEMA = {
  type: 'object', required: ['hook'],
  properties: {
    hook: { type: 'string', enum: ['none', 'passed', 'failed', 'error'] },
    exit: { type: ['number', 'null'] },
    tail: { type: 'string' },
    log: { type: 'string' },
    error: { type: 'string' },
  },
};

/**
 * @param {string} wt worktree の絶対パス
 * @returns {string}
 */
export function preCommitHookPrompt(wt) {
  return `cd ${wt} で作業。次のコマンドを **先頭トークンが pre-commit-hook の bare 単文** で 1 回だけ実行し、`
    + `exit code に関わらず **stdout の JSON 1 行だけ** を verbatim で返せ（判定や脚色をしない。キーの追加・削除・値の書き換えをしない）。`
    + `argv は一字一句そのまま実行する — which による絶対パス解決・絶対パスへの書き換え・cd 前置・\`bash\` 前置・環境変数代入前置・&& 連結・引数の追加は禁止。`
    + `Bash tool の \`timeout: 600000\` を指定して実行し、\`run_in_background\` は使わない（禁止）。再実行しない（timeout に達した場合も含む）。`
    + `timeout に達した・stdout に JSON 1 行が無い場合だけは、`
    + `{"hook":"error","error":"pre-commit-hook did not return JSON"} を一字一句そのまま返せ:\n`
    + `pre-commit-hook ${wt}`;
}

/**
 * hook が exit 非 0 で終わった応答だけを green-fix の材料にする。それ以外は null。
 * @param {unknown} res commit-hook#<iter> の応答
 * @returns {{exit: number|null, tail: string, log: string}|null}
 */
export function preCommitHookFailure(res) {
  if (res == null || typeof res !== 'object' || res.hook !== 'failed') return null;
  return {
    exit: Number.isFinite(res.exit) ? res.exit : null,
    tail: typeof res.tail === 'string' ? res.tail : '',
    log: typeof res.log === 'string' ? res.log : '',
  };
}

// green-fix prompt に足す hook の失敗の節。hook の出力（末尾）は対象 repo の hook が出した文字列なので、テストの
// 失敗内容と同じくデータとして渡す。hook は stage した全ファイルを検査するため、diff が触っていない既存行の指摘も
// そのファイルを変更する限り直す必要がある。hook 自体・hook の設定を緩めて通すのはテスト弱体化と同じ扱いで禁じる。
/**
 * @param {{exit: number|null, tail: string, log: string}} failure preCommitHookFailure の戻り値
 * @returns {string}
 */
export function preCommitHookFixNote(failure) {
  return `pre-commit hook が exit ${failure.exit ?? '?'} で失敗した（PR phase の commit と同じ stage 内容 = \`git add -A\` のあと .devflow-tmp を外したもの、に対して実行）。`
    + `hook は stage したファイル全体を検査する — 指摘が今回変更していない既存行にあっても、そのファイルを変更に含める限り直せ。`
    + `hook のスクリプト・hook が読む設定を緩めて通すこと、hook を飛ばす・無効化することは禁止（テスト弱体化と同じ扱い）。\n`
    + `hook の出力（末尾）:\n<<<PRE_COMMIT_HOOK_OUTPUT_BEGIN>>>\n${failure.tail}\n<<<PRE_COMMIT_HOOK_OUTPUT_END>>>\n`
    + (failure.log ? `hook の出力全文: ${failure.log}\n` : '');
}
