// security-review-codex-prep.bats 専用: prep を sandbox の中で動かしたときの書き込み拒否を真似る（NODE_OPTIONS=--import で読む）。
// FAKE_SANDBOX_WRITABLE（: 区切りの絶対パス）の配下でないディレクトリへの writeFileSync を EPERM にする。
// テストを動かす環境（CI の /tmp 等）では出力先の祖先が実際に書けてしまうので、prep の祖先 probe を sandbox と同じ条件で確かめるのに使う。
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { dirname, resolve, sep } from 'node:path'

const roots = (process.env.FAKE_SANDBOX_WRITABLE ?? '').split(':').filter(Boolean).map((r) => fs.realpathSync(r))
const original = fs.writeFileSync
fs.writeFileSync = function writeFileSync(p, ...rest) {
  if (typeof p === 'string') {
    let dir = null
    try { dir = fs.realpathSync(dirname(resolve(p))) } catch { /* 実在しないディレクトリは元の writeFileSync に失敗させる */ }
    if (dir != null && !roots.some((r) => dir === r || dir.startsWith(r === sep ? r : r + sep))) {
      const e = new Error(`EPERM: operation not permitted, open '${p}'`)
      e.code = 'EPERM'
      throw e
    }
  }
  return original.call(this, p, ...rest)
}
syncBuiltinESMExports()
