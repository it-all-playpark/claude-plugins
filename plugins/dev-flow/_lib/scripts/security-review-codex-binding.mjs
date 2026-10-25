// security-review-codex-binding.mjs - Codex 経路の security review の binding（保存先のパスと prompt.md・schema.json の中身を結ぶ
// sha256 の hex）を計算する。prep（書いた中身から）と result script（出力先の複製から）が使い、hooks/pretool-codex-invocation-guard.sh
// は同じ式を shell で計算する — 式を変えるときは 3 か所を同時に変える。
import { createHash } from 'node:crypto'

// sha256 の小文字 hex（data は Buffer か文字列）。prep が返し result script が再照合する prompt.md・schema.json の sha256 も同じ関数で作る
export const sha256Hex = (data) => createHash('sha256').update(data).digest('hex')

// `${保存先}\n${sha256(prompt.md)}\n${sha256(schema.json)}\n` の sha256（prompt / schema は Buffer か文字列）
export function codexBinding(reviewDir, prompt, schema) {
  return sha256Hex(`${reviewDir}\n${sha256Hex(prompt)}\n${sha256Hex(schema)}\n`)
}
