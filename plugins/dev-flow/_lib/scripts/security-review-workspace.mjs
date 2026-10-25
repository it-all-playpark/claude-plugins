// security-review-workspace.mjs - security review の作業場所（保存先・codex の -C）を確かめる CLI 共通の処理（issue #1095）。
// security-review-codex-prep / security-review-codex-result / security-review-diff-check が import する（CLI ではない）。
//
// 保存先と -C は os.tmpdir() 配下にあり、sandbox の中の PR のコード（fix・test で走らせて残った常駐プロセス）からも書ける。
// review の入力（pr.diff・prompt.md・schema.json）は用意した時点の sha256 を workflow に返し、review の後に同じファイルの
// sha256 を取り直して照合する（照合は script が行い、中継は argv を写すだけ）。
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
