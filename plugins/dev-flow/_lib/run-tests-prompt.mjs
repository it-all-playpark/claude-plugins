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
// 転写された scripts[].log（各 script の出力ログのパス）は、同じ tree を判定する evaluator に渡る（testLogsPromptBlock）。
//
// start / wait / stop: テストの所要時間は Bash 1 回の上限（600 秒）を超えうるので、start で切り離して起動し、wait の spawn を
// 繰り返して待つ（runTestsJob）。1 回の Bash は RUN_TESTS_WAIT_SEC で返るので、timeout: 600000 に収まる。
// timeout 未指定だと background に回され、agent が待った後に同じコマンドを再発行して二重実行になるので、
// timeout: 600000 を明示し background 化・再実行を禁じる。JSON が返らなかった場合の応答は固定文字列にして
// agent に結果を組み立てさせない（tests:"error" は green-fix を回さず merge tier で HOLD になる経路）。
//
// --base: run-tests は merge-base からの変更ファイル一覧を DEVFLOW_CHANGED_FILES / DEVFLOW_BASE で tests/run-*.sh に渡す
// （issue #835）。何を回すかは repo 側のランナーが決める。全 test spawn・全 shape・全 gate_policy で同じ ref を渡す。

// wait 1 回の待機秒数（1 回の Bash に収まる値）と、wait の待機の累計の上限（秒）。上限まで待っても終わらないテストは
// 止めて tests:"error" にする（HOLD に流れる）。run-tests 側の打ち切りはこれより長い（上限で止めるのは workflow）。
export const RUN_TESTS_WAIT_SEC = 450
export const RUN_TESTS_MAX_WAIT_SEC = 3600

/**
 * @param {string} wt worktree の絶対パス
 * @param {string} base 変更ファイルの起点 ref（`origin/<base branch>`）
 * @returns {string}
 */
export function runTestsPrompt(wt, base) {
  return runTestsCommandPrompt(wt, `run-tests start ${wt} --base ${base}`);
}

// Final reconcile の test#final-rerun / test#validate-rerun: 全件実行（test#final / skip の run の Validate）が落ちた
// ファイルだけを 1 回流し直す。結果は flake 候補の開示にだけ使う（HOLD は外さない）。
// 全件を再実行しない — 並列負荷による flake は全件を回すと再発する。files は呼び出し側（finalTestRerunFiles）が
// シェルで分割・展開されない文字だけのパスに絞ってから渡す。転写の契約は runTestsPrompt と同じ。
/**
 * @param {string} wt worktree の絶対パス
 * @param {string[]} files 再実行するテストファイル（WT 相対）
 * @returns {string}
 */
export function runTestFilesPrompt(wt, files) {
  return runTestsCommandPrompt(wt, `run-tests start ${wt} --files ${files.join(' ')}`);
}

/**
 * @param {string} wt worktree の絶対パス
 * @returns {string}
 */
export function runTestsWaitPrompt(wt) {
  return runTestsCommandPrompt(wt, `run-tests wait ${wt} --wait-sec ${RUN_TESTS_WAIT_SEC}`);
}

/**
 * @param {string} wt worktree の絶対パス
 * @returns {string}
 */
export function runTestsStopPrompt(wt) {
  return runTestsCommandPrompt(wt, `run-tests stop ${wt}`, '{"ok":false,"error":"run-tests did not return JSON"}');
}

function runTestsCommandPrompt(wt, command, noJson = '{"tests":"error","green":false,"summary":"run-tests did not return JSON"}') {
  return `cd ${wt} で作業。次のコマンドを **先頭トークンが run-tests の bare 単文** で 1 回だけ実行し、`
    + `**stdout の JSON 1 行だけ** を verbatim で返せ（判定や脚色をしない。キーの追加・削除・値の書き換えをしない）。`
    + `argv は一字一句そのまま実行する — which による絶対パス解決・絶対パスへの書き換え・cd 前置・\`bash\` 前置・環境変数代入前置・&& 連結は禁止。`
    + `Bash tool の \`timeout: 600000\` を指定して実行し、\`run_in_background\` は使わない（禁止）。& や nohup を足さない（常駐化はコマンド自身が行う）。再実行しない（timeout に達した場合も含む）。`
    + `timeout に達した・stdout に JSON 1 行が無い場合だけは、`
    + `${noJson} を一字一句そのまま返せ:\n`
    + command;
}

// run-tests stop の応答の schema。結果は使わない（止まらなくても run-tests 側の打ち切りで止まる）。
export const RUN_TESTS_STOP_SCHEMA = {
  type: 'object', required: ['ok'],
  properties: { ok: { type: 'boolean' }, stopped: { type: 'boolean' }, was_running: { type: 'boolean' }, error: { type: 'string' } },
}

/**
 * テスト 1 回分を start → wait（waitJob で繰り返す）で実行し、run-tests の結果の JSON を返す。
 * label が start の spawn、`<label>.wait-<k>` が wait、`<label>.stop` が stop の spawn。
 *   - 待機の累計が RUN_TESTS_MAX_WAIT_SEC に達した・null や schema に合わない応答・結果の形でない応答:
 *     stop を呼び、tests:'error' を返す（テストが通ったとみなさない）。
 *   - proxy が固定 JSON（status の無い tests:'error'）を返した: テストがまだ走っているかもしれないので stop を呼び、応答はそのまま返す。
 *   - spawn の throw: stop を呼んで投げ直す（throw の扱いは呼び出し側が持つ）。
 * @param {{wt: string, startPrompt: string, label: string, schema: object,
 *   waitJob: Function, spawn: (prompt: string, opts: object) => Promise<unknown>,
 *   spawnStop: (prompt: string, opts: object) => Promise<unknown>}} opts
 *   schema: start / wait の応答の schema / waitJob: bg-job-wait.mjs の waitBgJob（inline 先で共有するので引数で受ける）
 *   / spawn: start / wait の spawn / spawnStop: stop の spawn（throw しない経路を渡す）
 * @returns {Promise<object>}
 */
export async function runTestsJob({ wt, startPrompt, label, schema, waitJob, spawn, spawnStop }) {
  const stop = () => spawnStop(runTestsStopPrompt(wt), { schema: RUN_TESTS_STOP_SCHEMA, label: `${label}.stop` });
  const stoppedError = async (why) => {
    const stopped = await stop();
    return { tests: 'error', green: false, summary: `${why}${stopped?.ok === true ? '' : '（テストの停止を確認できない）'}` };
  };
  let res;
  try {
    res = await waitJob({
      start: await spawn(startPrompt, { schema, label }),
      wait: (k) => spawn(runTestsWaitPrompt(wt), { schema, label: `${label}.wait-${k}` }),
      maxPolls: Math.ceil(RUN_TESTS_MAX_WAIT_SEC / RUN_TESTS_WAIT_SEC),
      schema,
    });
  } catch (e) {
    await stop();
    throw e;
  }
  if (res.wait_capped === true) return stoppedError(`テストが待機の上限（${RUN_TESTS_MAX_WAIT_SEC} 秒）までに終わらなかった`);
  if (!['passed', 'failed', 'no_tests', 'error'].includes(res.tests)) return stoppedError('run-tests の応答が無い・形が不正');
  if (res.tests === 'error' && res.status == null) await stop();
  return res;
}
