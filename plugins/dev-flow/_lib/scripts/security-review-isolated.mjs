// security-review-isolated.mjs - 指示ファイルを変える PR（pr-iterate の security_review.stop_reason = reviewer_context_changed）の
// 敵対的 security review を、PR の worktree に一度も入らない別の `claude -p` プロセスで人が回す CLI（issue #1083）。
// bin/security-review-isolated（_shared/scripts/security-review-isolated.sh 経由）から呼ぶ。
//
// Usage: security-review-isolated <PR番号> [--repo owner/repo]   （repo の checkout の中で実行する）
//   1. gh pr view で PR の head sha と base を取る（git fetch origin で head を checkout に取り込む）。checkout の HEAD が
//      PR の commit を含む（PR の worktree・branch で実行した）ときは exit 2
//   2. security-review-scope <checkout> origin/<base> <head> --save-diff で diff を checkout の外に保存する
//   3. 新しく作った空のディレクトリ（checkout の外・保存先の祖先でない）を cwd にする
//   4. claude -p --agent dev-flow:security-reviewer に securityReviewPrompt を渡して起動する
//
// 起動するプロセスは EnterWorktree せず、PR の checkout / worktree を cwd にしない。subagent の指示ファイルは session の
// 起動時（と compaction 時）の cwd から読まれるので、中立なディレクトリで起動すれば PR が書いた CLAUDE.md 等が reviewer に届かない。
// workflow・exec-proxy・subagent からは呼ばない（sandbox が Anthropic API への通信を塞ぐ）。人が起動する。
//
// 結果は gate に戻さない — 記録ファイル・PR コメント・journal に書かず、stdout にだけ出す（fix agent も同じ場所・同じ gh
// アカウントに書けるので clear を偽造でき、指摘の本文を公開すると攻撃経路を公開することになる）。Merge tier は HOLD のまま。
//
// exit: 0 = clear（critical / major 0 件かつ reviewed_sha が head と一致）/ 1 = critical か major が残る /
//       2 = 判定できない（usage・取得の失敗・JSON を取り出せない・schema 不一致・reviewed_sha の不一致）。2 は clear と出さない
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SECURITY_REVIEW_SCHEMA, securityReviewPrompt, securityReviewVerdict } from '../security-review.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const SCOPE_BIN = join(here, '..', '..', 'bin', 'security-review-scope')
const AGENT = 'dev-flow:security-reviewer'
const NOTE = '注意: この結果は pr-iterate / dev-flow の gate に戻らない（Merge tier は HOLD のまま）。merge 判断の材料にする'

const out = (line = '') => process.stdout.write(`${line}\n`)
// 判定できない（exit 2）。clear とは出さない
const undetermined = (why) => {
  out(`判定: 判定できない（${why}）`)
  out(NOTE)
  process.exit(2)
}

// reviewer の文は PR の内容に誘導されうるので、端末を操作する制御文字（ESC 等）を落としてから出す（改行・タブは残す）
const clean = (s) => String(s ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '?')

// SECURITY_REVIEW_SCHEMA が使う範囲（type / required / properties / items / enum / maxLength）だけを確かめる
function conforms(value, schema) {
  if (schema.type === 'object') {
    if (value == null || typeof value !== 'object' || Array.isArray(value)) return false
    if ((schema.required ?? []).some((k) => !(k in value))) return false
    return Object.entries(schema.properties ?? {}).every(([k, s]) => value[k] === undefined || conforms(value[k], s))
  }
  if (schema.type === 'array') return Array.isArray(value) && value.every((v) => conforms(v, schema.items))
  if (schema.type === 'string') {
    if (typeof value !== 'string') return false
    if (schema.enum && !schema.enum.includes(value)) return false
    return schema.maxLength == null || value.length <= schema.maxLength
  }
  if (schema.type === 'number') return typeof value === 'number' && Number.isFinite(value)
  return false
}

// claude -p --output-format json の応答から review の JSON を取り出す（--json-schema の structured_output、無ければ result の本文）
function extractReview(stdout) {
  let envelope
  try { envelope = JSON.parse(stdout) } catch { return null }
  if (envelope == null || typeof envelope !== 'object' || envelope.is_error === true) return null
  if (envelope.structured_output != null && typeof envelope.structured_output === 'object') return envelope.structured_output
  if (typeof envelope.result !== 'string') return null
  const text = envelope.result.trim()
  const fenced = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/)
  try { return JSON.parse(fenced ? fenced[1] : text) } catch { return null }
}

const argv = process.argv.slice(2)
let pr = null
let repo = null
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--repo' && i + 1 < argv.length) repo = argv[++i]
  else if (pr == null && /^[1-9][0-9]*$/.test(argv[i])) pr = argv[i]
  else { pr = null; repo = null; break }
}
if (pr == null || (repo != null && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo))) {
  process.stderr.write('Usage: security-review-isolated <PR番号> [--repo owner/repo]\n')
  process.exit(2)
}

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...opts }).toString('utf8').trim()

let checkout
try {
  checkout = realpathSync(run('git', ['rev-parse', '--show-toplevel']))
} catch {
  undetermined('repo の checkout の中で実行していない')
}

// 1. PR の head sha と base
let headSha
let base
try {
  const view = JSON.parse(run('gh', ['pr', 'view', pr, ...(repo ? ['--repo', repo] : []), '--json', 'headRefOid,baseRefName']))
  headSha = String(view.headRefOid ?? '').toLowerCase()
  base = String(view.baseRefName ?? '')
} catch {
  undetermined(`gh pr view ${pr} が失敗した`)
}
if (!/^[0-9a-f]{40}$/.test(headSha)) undetermined('PR の head sha が 40 桁の hex でない')
try {
  run('git', ['check-ref-format', '--branch', base])
} catch {
  undetermined('PR の base が branch 名でない')
}
try {
  run('git', ['fetch', '--quiet', 'origin'])
} catch {
  process.stderr.write('warning: git fetch origin が失敗した — checkout にある origin の ref で続ける\n')
}
try {
  run('git', ['cat-file', '-e', `${headSha}^{commit}`])
} catch {
  undetermined(`PR head ${headSha} が checkout に無い（fork の PR なら head を fetch する。別 repo の PR なら --repo と cwd の repo を揃える）`)
}
// checkout が PR の commit を含む（PR の worktree・PR branch の checkout）なら止める。reviewer が checkout を読めると
// PR が書いた指示ファイルが判定者に届く。HEAD と PR head の merge-base が base に含まれないとき、HEAD は PR の commit を持つ
try {
  const mergeBase = run('git', ['merge-base', 'HEAD', headSha])
  try {
    run('git', ['merge-base', '--is-ancestor', mergeBase, `origin/${base}`])
  } catch {
    undetermined('checkout の HEAD が PR の変更を含む（PR の worktree・branch の外、base を checkout した repo で実行する）')
  }
} catch {
  undetermined('checkout の HEAD と PR head の関係を確かめられない')
}

// 2. diff を checkout の外に保存する
let scope
try {
  scope = JSON.parse(run('bash', [SCOPE_BIN, checkout, `origin/${base}`, headSha, '--save-diff']))
} catch {
  undetermined('security-review-scope が失敗した')
}
if (scope?.ok !== true || typeof scope.diff_path !== 'string' || typeof scope.review_dir !== 'string' || String(scope.head_sha).toLowerCase() !== headSha
  || dirname(scope.diff_path) !== scope.review_dir) {
  if (typeof scope?.review_dir === 'string') rmSync(scope.review_dir, { recursive: true, force: true })
  undetermined('PR の diff を保存できない')
}
const reviewDir = realpathSync(scope.review_dir)

// 3. 新しい空のディレクトリを cwd にする（checkout の外で、保存先の祖先でもない）
const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'dev-flow-security-review-cwd-')))
const cleanup = () => {
  rmSync(cwd, { recursive: true, force: true })
  rmSync(reviewDir, { recursive: true, force: true })
}
const inside = (child, parent) => {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}
if (inside(cwd, checkout) || inside(reviewDir, cwd) || inside(reviewDir, checkout)) {
  cleanup()
  undetermined('一時ディレクトリが checkout の中にある（TMPDIR を checkout の外に向ける）')
}

// 4. security-reviewer を別プロセスで起動する（prompt は stdin で渡す）
// 読み取りは prompt の文と read-scope hook に加えて起動引数でも保存先の配下に限る: tool は Read / Grep だけ
// （Glob は持たせない。diff_path は prompt で渡す）、許可は保存先の配下の Read（Grep も Read の rule に従う）だけ、それ以外は聞かずに拒否する（dontAsk）。
// project / local の設定は読まない（user 設定は plugin の有効化に要る）
const prompt = securityReviewPrompt({ pr, reviewDir, diffPath: join(reviewDir, 'pr.diff'), headSha, base, worktree: checkout })
out(`security-review-isolated: PR #${pr}（head ${headSha}）を ${AGENT} で review する`)
const res = spawnSync('claude', [
  '-p', '--agent', AGENT, '--output-format', 'json', '--json-schema', JSON.stringify(SECURITY_REVIEW_SCHEMA), '--add-dir', reviewDir,
  '--tools', 'Read,Grep', '--allowedTools', `Read(/${reviewDir}/**)`, '--permission-mode', 'dontAsk', '--setting-sources', 'user',
], { cwd, input: prompt, maxBuffer: 512 * 1024 * 1024, stdio: ['pipe', 'pipe', 'inherit'] })
cleanup()
if (res.error || res.status !== 0) undetermined(`claude が失敗した（exit ${res.status ?? 'なし'}）`)

const review = extractReview(res.stdout.toString('utf8'))
if (review == null) undetermined('reviewer の応答から JSON を取り出せない')
if (!conforms(review, SECURITY_REVIEW_SCHEMA)) undetermined('reviewer の応答が SECURITY_REVIEW_SCHEMA に合わない')

const verdict = securityReviewVerdict(review, headSha)
const { critical, major, minor } = verdict.counts
const label = verdict.cleared
  ? 'clear（critical / major 0 件）'
  : verdict.reason === 'blocking' ? '指摘あり（critical / major が残っている）' : '判定できない（reviewed_sha が PR head と一致しない — 古い diff を読んだ可能性）'
out(`判定: ${label}`)
out(`件数: critical ${critical} / major ${major} / minor ${minor}`)
out(`review した head: ${clean(review.reviewed_sha)}（PR head ${headSha}）`)
out(`summary: ${clean(review.summary)}`)
for (const [i, x] of review.issues.entries()) {
  out(`${i + 1}. [${x.severity}] ${clean(x.topic)} — ${clean(x.file)}${x.line != null ? `:${x.line}` : ''}`)
  out(`   ${clean(x.description)}`)
  out(`   提案: ${clean(x.suggestion)}`)
}
out(NOTE)
process.exit(verdict.cleared ? 0 : verdict.reason === 'blocking' ? 1 : 2)
