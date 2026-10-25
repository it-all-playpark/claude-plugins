// security-review-workspace.mjs - security review の作業場所（保存先・codex の -C）を確かめる CLI 共通の処理（issue #1095）。
// security-review-codex-prep / security-review-codex-result / security-review-diff-check が import する（CLI ではない）。
//
// 保存先と -C は os.tmpdir() 配下にあり、sandbox の中の PR のコード（fix・test で走らせて残った常駐プロセス）からも書ける。
// review の入力（pr.diff・prompt.md・schema.json）は用意した時点の sha256 と statDigest を workflow に返し、review の後に同じファイルの
// 値を取り直して照合する（照合は script が行い、中継は argv を写すだけ）。
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export const sha256Hex = (data) => createHash('sha256').update(data).digest('hex')

// path が通常ファイル（symlink でない）ならその内容の sha256、そうでなければ null
export function sha256OfRegularFile(path) {
  try {
    if (!lstatSync(path).isFile()) return null
    return sha256Hex(readFileSync(path))
  } catch {
    return null
  }
}

// paths の各々を lstat した (dev, ino, ctime の ns, nlink) を並べた sha256（どれかを lstat できなければ null）。
// 内容の sha256 だけでは「差し替えて review の間だけ良性にし、後で元へ戻す」を検出できない。ctime は利用者が戻せないので、
// 書いた直後の値と review の後の値の完全一致で、間の書き換え・置き換え（rename で ino が変わる）・chmod を検出する。
// 読むだけ（atime の更新）では ctime は変わらない
export function statDigest(paths) {
  try {
    const lines = paths.map((p) => {
      const st = lstatSync(p, { bigint: true })
      return `${st.dev}:${st.ino}:${st.ctimeNs}:${st.nlink}`
    })
    return sha256Hex(lines.join('\n'))
  } catch {
    return null
  }
}

// codex は作業ディレクトリから上へ .git・AGENTS.md 等を探して読む。-C の空ディレクトリと保存先の祖先（自身を含む）に
// これらがあれば、空の -C で指示ファイルを読ませない前提が崩れる。dangling symlink も「ある」とみなす
const TAINT_NAMES = ['.git', 'AGENTS.md', 'AGENTS.override.md', 'CLAUDE.md']
const existsNoFollow = (p) => {
  try { lstatSync(p); return true } catch { return false }
}
export function taintedAncestor(start) {
  for (let d = resolve(start); ; d = dirname(d)) {
    if (TAINT_NAMES.some((n) => existsNoFollow(join(d, n)))) return true
    if (dirname(d) === d) return false
  }
}
