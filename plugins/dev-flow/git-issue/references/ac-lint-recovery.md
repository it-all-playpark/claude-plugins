# ac-lint non_compliant の救済手順

`ac-lint` が `non_compliant` を返したら、当てはまる手順を 1 つ適用して `ac-lint` を再実行する。

1. checkbox または箇条書きはあるが AC 見出しが無い: そのリストブロックの直上に
   `## 受け入れ基準（Acceptance Criteria）` を挿入する（既存項目の文言は一切変えない）
2. AC 項目自体が無い: Phase 3 に戻って検証可能な受け入れ基準を作り、本文を組み直す
3. 1・2 のどちらも当てはまらない: issue を作らず abort し、`ac-lint` が返した JSON verdict をそのまま
   ユーザーへ報告する
