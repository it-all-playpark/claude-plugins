// mdCell: Markdown テーブルセルの値をエスケープする純粋関数。
// I/O なし、非決定性なし。同入力 -> byte 一致。
//
// INLINE COPY POLICY: workflow から参照される最上位宣言だけが tools/sync-inlines.mjs --write で inline 生成される。
// 直接 workflow 側を編集しない。一致は _lib/workflow-inlines.sync.test.mjs が検証する。

/**
 * Markdown テーブルセルの値をエスケープする。
 * パイプ文字を \| に、改行を <br> に変換する。
 * @param {*} v
 * @returns {string}
 */
export function mdCell(v) {
  if (v == null) return '';
  return String(v).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}
