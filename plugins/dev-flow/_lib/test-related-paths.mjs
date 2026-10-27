// test-related-paths: dev-flow が final_test_red で HOLD にした PR を /pr-iterate 単体で回収したとき、HOLD を付けた head から
// 終端 head までの変更ファイルのうち「テスト関連」（テストの実行・結果を変えうるパス）を決める純関数。I/O なし、非決定性なし。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。
//
// isTestFilePath は _lib/post-eval-recheck.mjs のもの（同じ workflow に先に inline される）。
// 「テスト関連の変更なし」は人が PR 全体を読み直さずに判断する根拠になるので、判定は安全側に倒す:
// - 判定に迷うパス（テストの補助ファイル・テストの実行を変えうる設定）はテスト関連にする
// - 変更ファイル一覧が取れない・HOLD 時の head が終端 head の祖先でないときは unknown にする（none にしない）
// HOLD は外さない — この結果は final_test_red の確認範囲の開示にだけ使う。

// テストの実行を変えうる設定とテストの補助ファイル（どのディレクトリにあっても当てる — monorepo の package 単位の設定を含む）
const TEST_RELATED_RES = [
  /(^|\/)package\.json$/,
  /(^|\/)[^/]+\.config\.(js|mjs|cjs|ts|mts|cts)$/,
  /(^|\/)(pyproject\.toml|setup\.cfg|tox\.ini|pytest\.ini|conftest\.py)$/,
  /(^|\/)(GNUmakefile|[Mm]akefile)$/,
  /(^|\/)\.github\/workflows\//,
  /(^|\/)(fixtures?|__fixtures__|__mocks__|__snapshots__|testdata|test-helpers?|e2e)\//i,
  /\.snap$/i,
];

export function isTestRelatedPath(p) {
  return isTestFilePath(p) || (typeof p === 'string' && TEST_RELATED_RES.some((re) => re.test(p)));
}

/**
 * HOLD 時の head → 終端 head の変更ファイル一覧（exec-proxy hold-test-diff の応答）からテスト関連の変更を決める。
 * outside は `git rev-list --count <終端 head>..<HOLD 時の head>`（HOLD 時の head にあって終端 head に無い commit 数）。
 * 0 のときだけ HOLD 時の head が終端 head の祖先で、変更ファイル一覧がその間の変更を表す。
 * @param {{ok?: boolean, outside?: unknown, files?: unknown}|null|undefined} res
 * @returns {{status: 'none'|'changed'|'unknown', files: string[]}}
 */
export function testRelatedChanges(res) {
  if (res == null || res.ok !== true || res.outside !== 0 || !Array.isArray(res.files)) return { status: 'unknown', files: [] };
  const files = [];
  for (const raw of res.files) {
    if (typeof raw !== 'string') return { status: 'unknown', files: [] };
    const p = raw.trim();
    if (p !== '' && isTestRelatedPath(p) && !files.includes(p)) files.push(p);
  }
  return { status: files.length > 0 ? 'changed' : 'none', files };
}
