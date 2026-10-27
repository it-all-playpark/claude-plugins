// 全件実行が red のとき（Final reconcile の test#final、または Final reconcile skipped の run の Validate の最終結果）、
// 落ちたテストファイルだけを 1 回流し直して flake 候補を記録する純関数。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。
//
// 記録は開示にだけ使い、final_test_red / validate_test_red の HOLD は外さない — 単体再実行の green は PR が書いた
// テストの出力で、全件実行のときだけ落ちるテストを書けば決定的な失敗でも単体では green になる。
// 判定は run-tests が exit code から写した tests / green だけで決める（LLM に判断させない）。
// - 再実行は 1 回だけ、落ちたファイルだけ。全件は流し直さない — 並列負荷による flake は全件を回すと再発する。
// - failed_files が空（ビルド失敗・ファイルに結び付かない失敗）は再実行しない。一部のファイルだけを流し直して
//   green と言うと、ファイルに結び付かなかった失敗を見落とす。1 件でも安全に渡せないパスがあれば同じ扱いにする。
// - 再実行が tests:'passed' かつ green:true のときだけ flake 候補。red・起動失敗・no_tests・応答なしは記録しない。
// run-tests.sh の「リトライしない」は起動失敗（環境要因）についての規約で、この再実行は Final reconcile 側の判断。
// Validate の途中の red（test#i）は green-fix に回る別経路なので対象にしない。

// 再実行の argv にそのまま並べるため、シェルで分割・展開されない文字だけのパスに限る（先頭 '-' はオプションと
// 取り違えるので不可）。
export const FINAL_TEST_RERUN_PATH_RE = /^[A-Za-z0-9_.@+][A-Za-z0-9_.@+\/-]*$/;

/**
 * 全件実行（test#final / Validate）の結果から再実行するテストファイル（WT 相対・重複なし）を返す。再実行しないときは空配列。
 * @param {{tests?:string, failed_files?:unknown}|null|undefined} ft
 * @returns {string[]}
 */
export function finalTestRerunFiles(ft) {
  if (!ft || ft.tests !== 'failed' || !Array.isArray(ft.failed_files)) return [];
  const files = [];
  for (const raw of ft.failed_files) {
    const p = typeof raw === 'string' ? raw.trim().replace(/^\.\//, '') : '';
    if (!FINAL_TEST_RERUN_PATH_RE.test(p) || p.split('/').some((s) => s === '' || s === '.' || s === '..')) return [];
    if (!files.includes(p)) files.push(p);
  }
  return files;
}

/**
 * 単体再実行の結果から flake 候補の記録を返す。flake 候補でなければ null。
 * logs は 1 回目（test#final / Validate）の run-tests summary に載る `log: <path>`（落ちたランナーの出力）。
 * @param {{summary?:string}|null|undefined} first 1 回目（全件実行）の結果
 * @param {{tests?:string, green?:boolean}|null|undefined} rerun test#final-rerun / test#validate-rerun の結果
 * @param {string[]} files 再実行したテストファイル
 * @returns {{files:string[], logs:string[]}|null}
 */
export function finalTestRerunVerdict(first, rerun, files) {
  if (!rerun || rerun.tests !== 'passed' || rerun.green !== true) return null;
  const logs = [];
  for (const m of String(first?.summary ?? '').matchAll(/\(exit \d+, log: ([^)\s]+)\)/g)) {
    if (!logs.includes(m[1])) logs.push(m[1]);
  }
  return { files: [...files], logs };
}
