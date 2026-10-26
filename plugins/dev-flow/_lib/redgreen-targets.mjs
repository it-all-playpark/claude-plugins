// redgreen-verify（Evaluate の label 'redgreen'、1 iteration 1 spawn / Final reconcile の 'redgreen-final'）に渡す
// ペアの構築・結果の配布・exec-proxy prompt の canonical。issue #822。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。
//
// dedupe: evaluator は AC ごとに (test_files, impl_files) を申告するため、複数 AC が同じ組を指すことが多い
// （1 本のテストファイルで全 AC を守る形）。redgreen-verify はペアごとに impl を退避して red → 復元して green を
// 走らせるので、同じ組を AC の数だけ渡すと同一の red/green を AC 数倍実行するだけになる。よって組を
// 順序正規化（重複除去 + sort）したキーで dedupe し、一意なペアだけを渡して結果を同じ組の全 AC に配る。
// deterministic 昇格・checked・vdelta deny の判定は呼び出し側が AC ごとに行う（ここは配布まで）。
// argv に載せるファイル列は最初に現れた AC の申告順のまま — 組が全部異なる run の prompt は dedupe 前と同じ byte 列。
//
// timeout / background: 全ペアの red/green を 1 回の Bash で走らせるため Bash tool の既定 timeout（120 秒）を超える。
// timeout 未指定だと background に回され、agent が待った後に同じコマンドを再発行して impl の退避・復元が二重に走るので、
// timeout: 600000 を明示し background 化・再発行を禁じる。JSON が返らなかった場合の応答は固定文字列にして
// agent に結果を組み立てさせない（results 空は全ペア欠落 = inspection 据え置きの fail-safe 経路）。

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
 * base を渡すと `--base <base>` を付け、HEAD と base の merge-base まで impl を戻して red を測らせる
 * （Final reconcile の commit 済み tree 用。Evaluate は未 commit の変更なので省略 = HEAD 基準）。
 *
 * @param {string} wt worktree の絶対パス
 * @param {Array<{test_files: string[], impl_files: string[]}>} pairs buildRedgreenPairs の pairs
 * @param {string|null} [base] 比較先の ref（例 `origin/main`）
 * @returns {string}
 */
export function redgreenVerifyPrompt(wt, pairs, base = null) {
  return `cd ${wt} で作業。次のコマンドを 1 回だけ実行して **stdout の JSON 1 行だけ** を verbatim で返せ(判定や脚色をしない)。`
    + `Bash tool の \`timeout: 600000\` を指定して実行し、\`run_in_background\` は使わない（禁止）。`
    + `コマンドを再発行しない（timeout・background 化した場合も含む）。`
    + `timeout に達した・stdout に JSON 1 行が無い場合だけは、{"results":[]} を一字一句そのまま返せ:\n`
    + `redgreen-verify ${base ? `--base ${base} ` : ''}${wt} `
    + pairs.map((p) => `'${p.test_files.join(',')}' '${p.impl_files.join(',')}'`).join(' ');
}
