// security-review-codex-workspace.mjs - Codex 経路の security review の作業場所に、codex が指示として読むファイルが無いかを確かめる。
// prep（codex の前。出力先とその祖先）と result script（codex の後。-C・保存先とその祖先）が使う。
import { lstatSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

// codex は作業ディレクトリから上へ .git（project root）・AGENTS.md 等を探して読む
export const WORKSPACE_TAINT_NAMES = ['.git', 'AGENTS.md', 'AGENTS.override.md', 'CLAUDE.md']

// start とその祖先のどれかに WORKSPACE_TAINT_NAMES があるか（dangling symlink も「ある」とみなす）
export function taintedAncestor(start) {
  const existsNoFollow = (p) => {
    try { lstatSync(p); return true } catch { return false }
  }
  for (let d = resolve(start); ; d = dirname(d)) {
    if (WORKSPACE_TAINT_NAMES.some((n) => existsNoFollow(join(d, n)))) return true
    if (dirname(d) === d) return false
  }
}
