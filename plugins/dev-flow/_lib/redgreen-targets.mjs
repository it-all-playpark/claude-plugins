// redgreen-verify（Evaluate の label 'redgreen'、1 iteration 1 spawn / Final reconcile の 'redgreen-final'）に渡す
// ペアの構築・結果の配布・exec-proxy prompt の canonical。issue #822。
//
// INLINE COPY POLICY: workflow から参照される最上位宣言だけが tools/sync-inlines.mjs --write で inline 生成される。
// 直接 workflow 側を編集しない。一致は _lib/workflow-inlines.sync.test.mjs が検証する。
//
// dedupe: evaluator は AC ごとに (test_files, impl_files) を申告するため、複数 AC が同じ組を指すことが多い
// （1 本のテストファイルで全 AC を守る形）。redgreen-verify はペアごとに impl を退避して red → 復元して green を
// 走らせるので、同じ組を AC の数だけ渡すと同一の red/green を AC 数倍実行するだけになる。よって組を
// 順序正規化（重複除去 + sort）したキーで dedupe し、一意なペアだけを渡して結果を同じ組の全 AC に配る。
// deterministic 昇格・checked の判定は呼び出し側が AC ごとに行う（ここは配布まで）。
// argv に載せるファイル列は最初に現れた AC の申告順のまま — 組が全部異なる run の prompt は dedupe 前と同じ byte 列。
//
// start / wait / stop: 全ペアの red/green は 1 回の Bash の上限（600 秒）を超えうるので、start で切り離して起動し、
// wait の spawn を繰り返して待つ（_lib/bg-job-wait.mjs の waitBgJob。dev-flow.js の runRedgreenVerify）。
// 待機の累計が REDGREEN_WAIT_CAP_SEC に達したら stop で止め、results 空（JSON が返らなかったときと同じ結果）で終わる。
//
// state dir: results.json が判定の入力になるので、テストが既知のパスで書ける worktree の中に置かない。mktemp を workflow では
// 呼べないので redgreen-verify state-dir の spawn で作り、そのパスを start / wait / stop に渡す。start の前に作るのは、
// start の応答が読めなくても stop できるようにするため（応答でパスを受け取ると、起動済みの実行を止める手段が無くなる）。
//
// timeout / background: start / wait の 1 回は 600 秒に収まるが、Bash tool の既定 timeout（120 秒）は超える。
// timeout 未指定だと background に回され、agent が待った後に同じコマンドを再発行する（start の再発行は実行をやり直す）ので、
// timeout: 600000 を明示し background 化・再発行を禁じる。JSON が返らなかった場合の応答は固定文字列にして
// agent に結果を組み立てさせない（results 空は全ペア欠落 = inspection 据え置きの fail-safe 経路）。
//
// INLINE 制約: ESM import / require / Date.now / Math.random を含めない。export function / export const のみ。

// wait 1 回あたりの待機秒数（1 回の Bash 呼び出し＝600 秒に収まり、上限を割り切れる値）と、待機の累計の上限。
export const REDGREEN_WAIT_SEC = 450;
export const REDGREEN_WAIT_CAP_SEC = 3600;
export const REDGREEN_WAIT_POLLS = Math.ceil(REDGREEN_WAIT_CAP_SEC / REDGREEN_WAIT_SEC);

/**
 * (test_files, impl_files) の組を順序正規化したキー。
 *
 * @param {string[]} testFiles
 * @param {string[]} implFiles
 * @returns {string}
 */
export function redgreenPairKey(testFiles, implFiles) {
  const norm = (xs) => [...new Set(xs)].sort();
  return JSON.stringify([norm(testFiles), norm(implFiles)]);
}

/**
 * rgTargets（[{r, acId}]。r は evaluator の ac_results 要素）から redgreen-verify に渡す一意なペアを作る。
 * pairIndex[i] は rgTargets[i] が使うペアの添字（= redgreen-verify の results[k].index）。
 *
 * @param {Array<{r: {test_files: string[], impl_files: string[]}}>} targets
 * @returns {{pairs: Array<{test_files: string[], impl_files: string[]}>, pairIndex: number[]}}
 */
export function buildRedgreenPairs(targets) {
  const pairs = [];
  const pairIndex = [];
  const indexByKey = new Map();
  for (const { r } of targets) {
    const key = redgreenPairKey(r.test_files, r.impl_files);
    let k = indexByKey.get(key);
    if (k === undefined) {
      k = pairs.length;
      indexByKey.set(key, k);
      pairs.push({ test_files: r.test_files, impl_files: r.impl_files });
    }
    pairIndex.push(k);
  }
  return { pairs, pairIndex };
}

/**
 * redgreen-verify の results（index = ペアの添字）を rgTargets の各要素に配る。
 * 欠落したペアを使う target は null（呼び出し側で inspection 据え置き）。
 *
 * @param {number[]} pairIndex buildRedgreenPairs の pairIndex
 * @param {unknown} results redgreen-verify の results
 * @returns {Array<object|null>} rgTargets と同じ長さ・同じ順
 */
export function distributeRedgreenResults(pairIndex, results) {
  const list = Array.isArray(results) ? results : [];
  return pairIndex.map((k) => list.find((x) => x && x.index === k) ?? null);
}

/**
 * start / wait の最後の応答（waitBgJob の戻り値）から結果を取り出す。結果と読めるのは status の無い応答の results だけ —
 * 上限まで running（wait_capped）・読めない応答（status:'error'）・null は全ペア欠落の [] にする。
 *
 * @param {unknown} res
 * @returns {object[]}
 */
export function redgreenResults(res) {
  return res && res.status == null && Array.isArray(res.results) ? res.results : [];
}

/**
 * 実行が全ペアの結果を残して終わったと言えるか。言えなければ（上限・読めない応答・results の欠落。proxy が {"results":[]} を
 * 返した場合を含む）実行が残っているかもしれず、impl を退避したまま以降の phase に進まないよう呼び出し側が stop する。
 *
 * @param {unknown} res
 * @param {number} pairCount
 * @returns {boolean}
 */
export function redgreenJobSettled(res, pairCount) {
  return redgreenResults(res).length === pairCount;
}

function redgreenProxyPrompt(cmd, fallback) {
  return `次のコマンドを 1 回だけ実行して **stdout の JSON 1 行だけ** を verbatim で返せ(判定や脚色をしない)。`
    + `Bash tool の \`timeout: 600000\` を指定して実行し、\`run_in_background\` は使わない（禁止）。& や nohup を足さない（常駐化はコマンド自身が行う）。`
    + `コマンドを再発行しない（timeout・background 化した場合も含む）。`
    + `timeout に達した・stdout に JSON 1 行が無い場合だけは、${fallback} を一字一句そのまま返せ:\n${cmd}`;
}

export function redgreenStateDirPrompt(wt) {
  return redgreenProxyPrompt('redgreen-verify state-dir', '{"state_dir":""}');
}

/**
 * state-dir の応答からパスを取り出す。後続のコマンド行に載せるので、絶対パスで空白・メタ文字の無い値だけを受け取る。
 *
 * @param {unknown} res
 * @returns {string|null} 受け取れなければ null（呼び出し側は起動せず全ペア欠落にする）
 */
export function redgreenStateDirFrom(res) {
  const dir = res?.state_dir;
  return typeof dir === 'string' && /^\/[\w./-]+$/.test(dir) ? dir : null;
}

/**
 * base を渡すと `--base <base>` を付け、HEAD と base の merge-base まで impl を戻して red を測らせる
 * （Final reconcile の commit 済み tree 用。Evaluate は未 commit の変更なので省略 = HEAD 基準）。
 * commandsFile は Setup で解決したテストコマンドのファイル（dev-flow-test-commands の commands_file。run-tests の --commands と
 * 同じもの）で、redgreen-verify はその形でだけテストを実行する。null なら --commands を付けない（全ペアが入力エラーになる）。
 *
 * @param {string} wt worktree の絶対パス
 * @param {string} stateDir redgreen-verify state-dir が作ったパス
 * @param {Array<{test_files: string[], impl_files: string[]}>} pairs buildRedgreenPairs の pairs
 * @param {string|null} [base] 比較先の ref（例 `origin/main`）
 * @param {string|null} [commandsFile] 解決したテストコマンドのファイル
 * @returns {string}
 */
export function redgreenStartPrompt(wt, stateDir, pairs, base = null, commandsFile = null) {
  return redgreenProxyPrompt(
    `redgreen-verify start --state-dir ${stateDir} ${base ? `--base ${base} ` : ''}${commandsFile ? `--commands ${commandsFile} ` : ''}${wt} `
      + pairs.map((p) => `'${p.test_files.join(',')}' '${p.impl_files.join(',')}'`).join(' '),
    '{"results":[]}');
}

export function redgreenWaitPrompt(wt, stateDir) {
  return redgreenProxyPrompt(`redgreen-verify wait --state-dir ${stateDir} --wait-sec ${REDGREEN_WAIT_SEC}`, '{"results":[]}');
}

export function redgreenStopPrompt(wt, stateDir) {
  return redgreenProxyPrompt(`redgreen-verify stop --state-dir ${stateDir}`, '{"ok":false}');
}
