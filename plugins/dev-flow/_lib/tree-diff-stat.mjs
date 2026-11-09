// tree-diff-stat: `git diff --numstat A B` の stdout 行配列を解析する純粋関数。
// I/O なし、非決定性なし。同入力 -> byte 一致。
//
// INLINE COPY POLICY: workflow から参照される最上位宣言だけが tools/sync-inlines.mjs --write で inline 生成される。
// 直接 workflow 側を編集しない。一致は _lib/workflow-inlines.sync.test.mjs が検証する。

export const TREE_DIFF_STAT_MAX_FILES = 50;

/**
 * `git diff --numstat A B` の stdout 各行を解析する。
 * 各行は `<insertions>\t<deletions>\t<path>` 形式。binary 差分は insertions/deletions が
 * `-` になり 0 として扱う。50 件で打ち切り、超過分は truncated: true で示す。
 * @param {string[]} lines
 * @returns {{ files: Array<{path: string, insertions: number, deletions: number}>, truncated: boolean }}
 */
export function parseTreeDiffStat(lines) {
  if (!Array.isArray(lines)) return { files: [], truncated: false };

  const files = [];
  let truncated = false;

  for (const line of lines) {
    if (typeof line !== 'string') continue;
    if (line.trim() === '') continue;

    const parts = line.split('\t');
    if (parts.length < 3) continue;

    const [rawInsertions, rawDeletions, ...rest] = parts;
    let path = rest.join('\t');
    path = path.replace(/\r$/, '');
    if (path === '') continue;

    if (files.length >= TREE_DIFF_STAT_MAX_FILES) {
      truncated = true;
      continue;
    }

    const insertions = rawInsertions === '-' ? 0 : (Number.parseInt(rawInsertions, 10) || 0);
    const deletions = rawDeletions === '-' ? 0 : (Number.parseInt(rawDeletions, 10) || 0);

    files.push({ path, insertions, deletions });
  }

  return { files, truncated };
}
