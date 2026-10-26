// Validate（test#i / test#retry-i）・post-eval（test#post-eval-i）・Final reconcile（test#final）が共有する
// テスト実行 exec-proxy prompt の canonical。issue #821。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。
//
// テストスクリプトの選択・起動失敗の分類・failed_files の抽出・green 判定はすべて `run-tests`
// （_shared/scripts/run-tests.sh。出力は GREEN schema の必須キー tests / green を含む JSON 1 行）が exit code から
// 決める。agent の仕事は stdout の verbatim 転写だけにする — 規約文を渡して agent に判定させると、1 本の省略・
// 独断の環境操作・起動失敗の誤分類が偽 red / 再検証不能の HOLD になるため。
// 全 test spawn が同じ byte 列を使う（経路ごとの複製は空白 drift を生む）。
//
// timeout / background: 全テストを 1 回の Bash で走らせるため Bash tool の既定 timeout（120 秒）を超える repo がある。
// timeout 未指定だと background に回され、agent が待った後に同じコマンドを再発行して二重実行になるので、
// timeout: 600000 を明示し background 化・再実行を禁じる。JSON が返らなかった場合の応答は固定文字列にして
// agent に結果を組み立てさせない（tests:"error" は green-fix を回さず Final reconcile では CI 委譲へ進む経路）。
//
// --base: run-tests は merge-base からの変更ファイル一覧を DEVFLOW_CHANGED_FILES / DEVFLOW_BASE で tests/run-*.sh に渡す
// （issue #835）。何を回すかは repo 側のランナーが決める。全 test spawn・全 shape・全 gate_policy で同じ ref を渡す。

/**
 * @param {string} wt worktree の絶対パス
 * @param {string} base 変更ファイルの起点 ref（`origin/<base branch>`）
 * @returns {string}
 */
export function runTestsPrompt(wt, base) {
  return runTestsCommandPrompt(wt, `run-tests ${wt} --base ${base}`);
}

// Final reconcile の test#final-rerun（issue #865）: test#final が落ちたファイルだけを 1 回流し直す。
// 全件を再実行しない — 並列負荷による flake は全件を回すと再発する。files は呼び出し側（finalTestRerunFiles）が
// シェルで分割・展開されない文字だけのパスに絞ってから渡す。転写の契約は runTestsPrompt と同じ。
/**
 * @param {string} wt worktree の絶対パス
 * @param {string[]} files 再実行するテストファイル（WT 相対）
 * @returns {string}
 */
export function runTestFilesPrompt(wt, files) {
  return runTestsCommandPrompt(wt, `run-tests ${wt} --files ${files.join(' ')}`);
}

function runTestsCommandPrompt(wt, command) {
  return `cd ${wt} で作業。次のコマンドを **先頭トークンが run-tests の bare 単文** で 1 回だけ実行し、`
    + `**stdout の JSON 1 行だけ** を verbatim で返せ（判定や脚色をしない。キーの追加・削除・値の書き換えをしない）。`
    + `argv は一字一句そのまま実行する — which による絶対パス解決・絶対パスへの書き換え・cd 前置・\`bash\` 前置・環境変数代入前置・&& 連結は禁止。`
    + `Bash tool の \`timeout: 600000\` を指定して実行し、\`run_in_background\` は使わない（禁止）。再実行しない（timeout に達した場合も含む）。`
    + `timeout に達した・stdout に JSON 1 行が無い場合だけは、`
    + `{"tests":"error","green":false,"summary":"run-tests did not return JSON"} を一字一句そのまま返せ:\n`
    + command;
}
