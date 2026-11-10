// porcelain-verdict.mjs - cwd の worktree（root）で `git status --porcelain --untracked-files=all` を実行し、
// _lib/porcelain-verdict.mjs の規則で判定した JSON 1 行を stdout に出す CLI。bin/porcelain-verdict
// （_shared/scripts/porcelain-verdict.sh 経由）から呼ぶ。status のほかに起動する git は読み取りだけ（HEAD の sha・
// 基準線の HEAD で追跡されていたパスの問い合わせ）で、add・commit・push・network I/O は持たない
// （commit は agent の bare 単文に残し、PreToolUse の inline-commit-gate が検知できるようにする）。
//
// Usage:
//   porcelain-verdict baseline
//     → HEAD の sha と porcelain 行を基準線ファイル（<cwd>/.devflow-tmp/porcelain-baseline/<sha256>）に書き、
//       {"exit_code":0,"baseline_digest":"<sha256>"} を出す（git の失敗・書き込み失敗は baseline_digest:null）
//   porcelain-verdict check [<baseline_digest>]
//     → {"exit_code","baseline","dirty","new_lines","recoverable","add_command"} を出す。digest は workflow が
//       baseline の応答から JS 変数に保持した値。基準線ファイルを読み直し、sha256 が digest と一致しない・ファイルが無い
//       ときは baseline:"mismatch"（dirty・回収不可）。digest を渡さなければ baseline:"none"（全 porcelain 行が新規行）
//
// 基準線の行は agent に転記させない（fix の前の状態を、fix を走らせる側が書き換えられない形で残す）。正しさの根拠は
// fix agent が走る前に workflow が取った digest で、基準線ファイルは fix agent が書き換えられるので digest で検証する。
// usage error だけ exit 2、それ以外は exit 0（git status の失敗は exit_code に載せる）。
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { baselineContent, newUntrackedPaths, parseBaselineContent, porcelainLines, porcelainVerdict, PORCELAIN_BASELINE_DIR } from '../../_lib/porcelain-verdict.mjs'

const STATUS_ARGS = ['status', '--porcelain', '--untracked-files=all']
const HEAD_ARGS = ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']
const TREE_ARGS = ['ls-tree', '-r', '-z', '--name-only']
const DIGEST_RE = /^[0-9a-f]{64}$/

const emit = (obj, code = 0) => {
  process.stdout.write(`${JSON.stringify(obj)}\n`)
  process.exit(code)
}
const sha256 = (s) => createHash('sha256').update(s).digest('hex')

// 基準線のパスは PR が追跡ファイル（symlink）として持ち込める。symlink を辿ると PR が指した worktree の外のファイルを
// 切り詰め・読まされるので辿らない: 親ディレクトリは実ディレクトリだけを受け付け（symlink なら失敗＝基準線 null）、
// ファイルは O_EXCL で一時名に作ってから rename で置き換える（rename は symlink 自体を置き換え、指す先に書かない）。
const ensureRealDir = (dir) => {
  if (dir === '.') return
  ensureRealDir(dirname(dir))
  let st = null
  try { st = lstatSync(dir) } catch (e) { if (e.code !== 'ENOENT') throw e }
  if (st == null) mkdirSync(dir)
  else if (!st.isDirectory()) throw new Error(`${dir} is not a directory`)
}
const readNoFollow = (path) => {
  ensureRealDir(dirname(path))
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { return readFileSync(fd, 'utf8') } finally { closeSync(fd) }
}

const [mode, ...rest] = process.argv.slice(2)
if (!((mode === 'baseline' && rest.length === 0) || (mode === 'check' && rest.length <= 1))) {
  process.stderr.write('Usage: porcelain-verdict baseline | porcelain-verdict check [<baseline_digest>]\n')
  process.exit(2)
}

// 子プロセスは git だけで、index・HEAD を書かないサブコマンド（*_ARGS）だけを GIT_OPTIONAL_LOCKS=0 で起動する。
const git = (args) => {
  const r = spawnSync('git', args, {
    encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  return { exitCode: typeof r.status === 'number' ? r.status : 1, output: r.stdout ?? '' }
}

const status = git(STATUS_ARGS)
const output = status.output
let exitCode = status.exitCode

if (mode === 'baseline') {
  if (exitCode !== 0) emit({ exit_code: exitCode, baseline_digest: null })
  // fix の前の HEAD が取れない（commit の無い repo 等）なら基準線は取れなかった扱いにする
  const head = git(HEAD_ARGS)
  if (head.exitCode !== 0) emit({ exit_code: head.exitCode, baseline_digest: null })
  const content = baselineContent(head.output.trim(), porcelainLines(output))
  const digest = sha256(content)
  try {
    ensureRealDir(PORCELAIN_BASELINE_DIR)
    const file = join(PORCELAIN_BASELINE_DIR, digest)
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, content, { flag: 'wx' })
    renameSync(tmp, file)
  } catch {
    emit({ exit_code: exitCode, baseline_digest: null })
  }
  emit({ exit_code: exitCode, baseline_digest: digest })
}

const digest = rest[0]
let baseline = null
let head = null
let mismatch = false
if (digest != null) {
  let content = null
  if (DIGEST_RE.test(digest)) {
    try { content = readNoFollow(join(PORCELAIN_BASELINE_DIR, digest)) } catch { content = null }
  }
  const parsed = content != null && sha256(content) === digest ? parseBaselineContent(content) : null
  if (parsed != null) {
    baseline = parsed.lines
    head = parsed.head
  } else mismatch = true
}

// 基準線に無い `??` 行のうち、基準線の HEAD で追跡されていたパス（fix が追跡をやめて worktree に残したファイル）を
// 判定から外す。問い合わせの失敗は判定不能として exit_code に載せ、dirty・回収不可に倒す。
let untrackedByFix = []
if (exitCode === 0 && baseline != null) {
  const candidates = newUntrackedPaths(output, baseline)
  if (candidates.length > 0) {
    const tree = git([...TREE_ARGS, head])
    if (tree.exitCode !== 0) exitCode = tree.exitCode
    else {
      const tracked = new Set(tree.output.split('\0'))
      untrackedByFix = candidates.filter((p) => tracked.has(p))
    }
  }
}
emit(porcelainVerdict({ output, exitCode, baseline, mismatch, untrackedByFix }))
