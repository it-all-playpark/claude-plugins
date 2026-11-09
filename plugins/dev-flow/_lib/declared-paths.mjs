// declared-paths: plan の file_changes と realized diff を突合する純粋関数群（normalizePath /
// diffDeclaredPaths / isEphemeralPath / filterEphemeralPaths）。宣言外変更の検出と ephemeral path の除外に使う。
//
// INLINE COPY POLICY: workflow から参照される最上位宣言だけが tools/sync-inlines.mjs --write で inline 生成される。
// 直接 workflow 側を編集しない。一致は _lib/workflow-inlines.sync.test.mjs が検証する。

/**
 * normalizePath: file_changes エントリを正規化したパス文字列に変換する。
 * - ':' で分割した先頭要素を取る（'src/foo.ts: 新規作成' → 'src/foo.ts'）
 * - trim して先頭の './' を1回除去する（'./src/foo.ts' → 'src/foo.ts'、'  src/bar.ts  ' → 'src/bar.ts'）
 *
 * @param {string} s - file_changes の1エントリ
 * @returns {string} 正規化されたパス文字列
 */
export function normalizePath(s) {
  const base = s.split(':')[0].trim();
  return base.startsWith('./') ? base.slice(2) : base;
}

/**
 * diffDeclaredPaths: plan の全 task の file_changes と git status の変更ファイルを突合し、
 * 宣言外の変更ファイルパスの配列を返す純粋関数。
 *
 * normalizePath を共用して表記ゆれ（'path: 説明' / './' プレフィックス / 空白）を正規化する。
 *
 * @param {Array<{id: string, file_changes?: string[]}>} planTasks - plan.serial の全 task 配列
 * @param {string[]} changedFiles - `git status --porcelain` の変更ファイル一覧（正規化済みパスを期待する）
 * @returns {string[]} 宣言外変更ファイルパスの配列（changedFiles の正規化値が基準）
 */
export function diffDeclaredPaths(planTasks, changedFiles) {
  // plan の全 task の file_changes を正規化した宣言パス集合を構築
  const declaredSet = new Set();
  for (const task of planTasks) {
    for (const fc of (task.file_changes ?? [])) {
      declaredSet.add(normalizePath(fc));
    }
  }

  // changedFiles のうち宣言集合に含まれないものを宣言外として抽出
  const undeclared = [];
  for (const f of changedFiles) {
    const normalized = normalizePath(f);
    if (!declaredSet.has(normalized)) {
      undeclared.push(f);
    }
  }
  return undeclared;
}

/**
 * isEphemeralPath: git status --porcelain 由来の raw パス文字列が ephemeral（一時）ファイルか判定する。
 * - '.devflow-tmp' ディレクトリまたはその配下のファイル
 * - basename に '.staged.' を含むファイル（例: evaluator.staged.md, plan.staged.json）
 * - basename が /^fm_.*\.txt$/ に一致するファイル（例: fm_3821.txt）
 *
 * @param {string} p - git status --porcelain 由来の raw パス文字列
 * @returns {boolean} ephemeral なら true、それ以外 false
 */
export function isEphemeralPath(p) {
  const trimmed = p.trim();
  const base = trimmed.startsWith('./') ? trimmed.slice(2) : trimmed;
  // (b) .devflow-tmp ディレクトリまたはその配下
  if (base === '.devflow-tmp' || base.startsWith('.devflow-tmp/')) {
    return true;
  }
  // basename（最後の '/' 以降）を取得
  const slashIdx = base.lastIndexOf('/');
  const basename = slashIdx === -1 ? base : base.slice(slashIdx + 1);
  // (c) basename に '.staged.' を含む
  if (basename.includes('.staged.')) {
    return true;
  }
  // (d) basename が /^fm_.*\.txt$/ に一致
  if (/^fm_.*\.txt$/.test(basename)) {
    return true;
  }
  return false;
}

/**
 * filterEphemeralPaths: ファイルパス配列から ephemeral ファイルを除いた配列を返す。
 * isEphemeralPath を使って各エントリをフィルタする。
 *
 * @param {string[]|null|undefined} files - フィルタ対象のファイルパス配列
 * @returns {string[]} ephemeral でないパスのみを順序維持で返す配列
 */
export function filterEphemeralPaths(files) {
  return (files ?? []).filter((f) => !isEphemeralPath(f));
}
