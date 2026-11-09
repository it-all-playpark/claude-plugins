// porcelain-verdict.mjs - cwd の worktree（root）で `git status --porcelain --untracked-files=all` を 1 回だけ実行し、
// _lib/porcelain-verdict.mjs の規則で判定した JSON 1 行を stdout に出す CLI。bin/porcelain-verdict
// （_shared/scripts/porcelain-verdict.sh 経由）から呼ぶ。add・commit・push・network I/O は持たない
// （commit は agent の bare 単文に残し、PreToolUse の inline-commit-gate が検知できるようにする）。
//
// Usage:
//   porcelain-verdict baseline
//     → porcelain 行を基準線ファイル（<cwd>/.devflow-tmp/porcelain-baseline/<sha256>）に書き、
//       {"exit_code":0,"baseline_digest":"<sha256>"} を出す（status 失敗・書き込み失敗は baseline_digest:null）
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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { baselineContent, parseBaselineContent, porcelainLines, porcelainVerdict, PORCELAIN_BASELINE_DIR } from '../../_lib/porcelain-verdict.mjs'

const STATUS_ARGS = ['status', '--porcelain', '--untracked-files=all']
const DIGEST_RE = /^[0-9a-f]{64}$/

const emit = (obj, code = 0) => {
  process.stdout.write(`${JSON.stringify(obj)}\n`)
  process.exit(code)
}
const sha256 = (s) => createHash('sha256').update(s).digest('hex')

const [mode, ...rest] = process.argv.slice(2)
if (!((mode === 'baseline' && rest.length === 0) || (mode === 'check' && rest.length <= 1))) {
  process.stderr.write('Usage: porcelain-verdict baseline | porcelain-verdict check [<baseline_digest>]\n')
  process.exit(2)
}

const status = spawnSync('git', STATUS_ARGS, {
  encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
})
const exitCode = typeof status.status === 'number' ? status.status : 1
const output = status.stdout ?? ''

if (mode === 'baseline') {
  if (exitCode !== 0) emit({ exit_code: exitCode, baseline_digest: null })
  const content = baselineContent(porcelainLines(output))
  const digest = sha256(content)
  try {
    mkdirSync(PORCELAIN_BASELINE_DIR, { recursive: true })
    writeFileSync(join(PORCELAIN_BASELINE_DIR, digest), content)
  } catch {
    emit({ exit_code: exitCode, baseline_digest: null })
  }
  emit({ exit_code: exitCode, baseline_digest: digest })
}

const digest = rest[0]
let baseline = null
let mismatch = false
if (digest != null) {
  let content = null
  if (DIGEST_RE.test(digest)) {
    try { content = readFileSync(join(PORCELAIN_BASELINE_DIR, digest), 'utf8') } catch { content = null }
  }
  if (content != null && sha256(content) === digest) baseline = parseBaselineContent(content)
  else mismatch = true
}
emit(porcelainVerdict({ output, exitCode, baseline, mismatch }))
