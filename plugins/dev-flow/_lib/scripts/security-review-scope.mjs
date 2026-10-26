// security-review-scope.mjs - PR の diff を取り、敵対的 security review の対象かを _lib/security-review-scope.mjs で
// 決める CLI（issue #1063）。bin/security-review-scope（_shared/scripts/security-review-scope.sh 経由）から呼ぶ。
// 規則は security-review-scope.mjs の 1 か所に置き、shell 側に写しを持たない。
//
// Usage:
//   node security-review-scope.mjs <worktree> <base-ref> [<head-ref>] [--save-diff]
//     → `<base-ref>...<head-ref>`（既定 HEAD）の diff を判定する（PR の commit 済みの diff）
//   node security-review-scope.mjs <worktree> <base-ref> --working-tree
//     → merge-base(<base-ref>, HEAD) と作業ツリー（未コミット・untracked を含む。一時 index で tree を作り、
//       実 index は触らない）の diff を判定する（dev-flow の Diff triage。implementer は commit しない）
//   --save-diff: diff 全文を worktree の外の新しい一時ディレクトリ（os.tmpdir() 配下の dev-flow-security-review-XXXXXX）の
//     pr.diff に書き、review_dir / diff_path を返す（pr-iterate の security-reviewer・Codex 経路の prep が読む）
//
// stdout: JSON 1 行 {ok, target, reasons, file_count, head_sha, reviewer_context_changed, review_dir, diff_path, error?}
//   reasons は固定の code と件数（`not_allowlisted:3` 等。_lib の reasonCodeCounts）だけで、ファイルパス・diff 由来の
//   文字列を出さない（stdout を写す agent へ PR が決めた文字列を渡すと、判定を書き換える文を混ぜられる）。error も
//   固定の code（`usage` / `git_failed`）だけで、git の stderr は stdout にも stderr にも出さない（同じ理由）。
//   reviewer_context_changed: diff が security-reviewer の session に自動で読み込まれる指示ファイルを含むか
//   （_lib の isReviewerContextPath と、base / head の指示ファイルが `@<path>` で import するファイル。取得に失敗したときは true）。
//   ok:false（取得・判定に失敗）のときも target:true を出す（fail-closed）。usage error だけ exit 2、それ以外は exit 0。
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isReviewerContextPath, reviewerImportClosure, securityReviewScope, SECURITY_SCOPE_DIFF_ARGS, SECURITY_SCOPE_GIT_CONFIG,
} from '../security-review-scope.mjs'

const emit = (obj, code = 0) => {
  process.stdout.write(`${JSON.stringify(obj)}\n`)
  process.exit(code)
}
const failClosed = (error) => ({ ok: false, target: true, reasons: ['scope_unavailable:1'], file_count: null, head_sha: null, reviewer_context_changed: true, review_dir: null, diff_path: null, error })

const argv = process.argv.slice(2)
const saveDiff = argv.includes('--save-diff')
const workingTree = argv.includes('--working-tree')
const positional = argv.filter((a) => a !== '--save-diff' && a !== '--working-tree')
if (positional.length < 2 || positional.length > 3 || (workingTree && positional.length === 3) || positional.some((a) => a.startsWith('-'))) {
  emit(failClosed('usage'), 2)
}
const [worktree, base, head = 'HEAD'] = positional

const git = (args, env = {}) => execFileSync('git', ['-C', worktree, ...SECURITY_SCOPE_GIT_CONFIG, ...args], {
  env: { ...process.env, ...env }, maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
})
const gitText = (args, env) => git(args, env).toString('utf8').trim()

let tmpIndexDir = null
let result
try {
  let range
  let headSha = null
  let revs
  if (workingTree) {
    tmpIndexDir = mkdtempSync(join(tmpdir(), 'dev-flow-scope-index-'))
    const env = { GIT_INDEX_FILE: join(tmpIndexDir, 'index') }
    git(['read-tree', 'HEAD'], env)
    // .devflow-tmp/ は dev-flow の run 専用 scratch（PR に入らない）。gitignore していない repo でも数えない
    git(['add', '-A'], env)
    git(['rm', '--cached', '-r', '-q', '--ignore-unmatch', '--', '.devflow-tmp'], env)
    const tree = gitText(['write-tree'], env)
    const mergeBase = gitText(['merge-base', base, 'HEAD'])
    range = [mergeBase, tree]
    revs = [mergeBase, tree]
  } else {
    headSha = gitText(['rev-parse', '--verify', `${head}^{commit}`])
    range = [`${base}...${headSha}`]
    revs = [gitText(['merge-base', base, headSha]), headSha]
  }
  const patchBuf = git(['diff', ...SECURITY_SCOPE_DIFF_ARGS, ...range])
  const names = git(['diff', ...SECURITY_SCOPE_DIFF_ARGS, '--name-only', '-z', ...range]).toString('utf8').split('\u0000').filter((x) => x !== '')
  // base / head の指示ファイル（isReviewerContextPath）から `@<path>` import を再帰的にたどる。import 先を PR が変えると
  // security-reviewer の session に攻撃者の文が指示として届くので、文書の拡張子でも対象にする
  const root = gitText(['rev-parse', '--show-toplevel'])
  const imports = revs.flatMap((rev) => {
    // `<mode> <type> <oid>\t<path>`。import は大文字小文字を区別しない FS で解決されるので、小文字のキーで tree の実パスを引く
    const entries = new Map()
    for (const rec of git(['ls-tree', '-r', '-z', rev]).toString('utf8').split('\u0000')) {
      const m = rec.match(/^(\d{6}) (\w+) ([0-9a-f]+)\t(.+)$/s)
      if (m) entries.set(m[4].toLowerCase(), { mode: m[1], oid: m[3], path: m[4] })
    }
    const roots = [...entries.values()].map((e) => e.path).filter(isReviewerContextPath)
    // 無いパスは null。ある筈の blob を読めなければ git が throw し、全体が git_failed（対象）に倒れる
    // 途中のディレクトリが symlink（`docs` → `real` で `@docs/x.md`）なら、その symlink を link として返し、
    // closure 側が symlink の先 + 残りのパスとしてたどり直す
    const read = (p) => {
      const segs = String(p).split('/')
      for (let k = 1; k < segs.length; k++) {
        const d = entries.get(segs.slice(0, k).join('/').toLowerCase())
        if (d?.mode === '120000') {
          const target = git(['cat-file', 'blob', d.oid]).toString('utf8').replace(/\/+$/, '')
          // closure は link を p のディレクトリから解決するので、symlink の親ディレクトリまで `..` で戻す
          const up = target.startsWith('/') ? [] : Array(segs.length - k).fill('..')
          return { link: [...up, target, ...segs.slice(k)].join('/') }
        }
      }
      const e = entries.get(String(p).toLowerCase())
      if (e == null || e.mode === '160000') return null
      const body = git(['cat-file', 'blob', e.oid]).toString('utf8')
      return e.mode === '120000' ? { link: body } : { text: body }
    }
    // path をディレクトリとする配下のファイル（ディレクトリへの symlink の先を closure が展開する）
    const list = (p) => {
      const prefix = `${String(p).toLowerCase()}/`
      return [...entries.entries()].filter(([k]) => k.startsWith(prefix)).map(([, e]) => e.path)
    }
    return reviewerImportClosure(roots, read, root, list)
  })
  const scope = securityReviewScope({ patch: patchBuf.toString('utf8'), names, imports })
  let reviewDir = null
  let diffPath = null
  if (saveDiff) {
    reviewDir = mkdtempSync(join(tmpdir(), 'dev-flow-security-review-'))
    diffPath = join(reviewDir, 'pr.diff')
    writeFileSync(diffPath, patchBuf, { flag: 'wx' })
  }
  result = { ok: true, target: scope.target, reasons: scope.codes, file_count: names.length, head_sha: headSha, reviewer_context_changed: scope.reviewer_context_changed, review_dir: reviewDir, diff_path: diffPath }
} catch {
  result = failClosed('git_failed')
}
if (tmpIndexDir) rmSync(tmpIndexDir, { recursive: true, force: true })
emit(result)
