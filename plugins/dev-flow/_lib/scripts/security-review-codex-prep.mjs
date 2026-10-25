// security-review-codex-prep.mjs - Codex 経路の security review（issue #1087）の入力を保存先に用意する CLI。
// bin/security-review-codex-prep（_shared/scripts/security-review-codex-prep.sh 経由）から呼ぶ。
// prompt・schema・起動形の規則は _lib/security-review.mjs の 1 か所に置き、ここは書き出すだけ。
//
// Usage:
//   node security-review-codex-prep.mjs <review_dir> <head_sha> <pr> <output_dir> [--verify-from <prev_nonce>]
//     review_dir: security-review-scope --save-diff が作った保存先（dev-flow-security-review-XXXXXX。pr.diff を持つ）
//     output_dir: codex が -o で結果ファイル（dev-flow-codex-result-<nonce>.json）を書く出力先（user 設定の "dev-flow".codex_output_dir）。
//       省略は未設定（output_dir_unset）。symlink でない実ディレクトリの絶対パスで、ここ（sandbox の中）からファイルを作れないこと —
//       作れる出力先では、sandbox の中の常駐プロセスが結果ファイルの名前に symlink を置き、sandbox の外で動く codex に任意のファイルを
//       上書きさせられる。作れてしまったら消してから output_dir_writable。出力先を作る・片付けるのは人で、この script はしない
//     --verify-from: 前回の Codex の review の nonce。出力先のその結果ファイルの critical/major を verify_items にする
//
// 書くもの: <review_dir>/prompt.md（codexSecurityReviewPrompt + diff）・<review_dir>/schema.json（strict 形）・
//   <review_dir>/prepared_at（prep 時刻の epoch ms）と、codex の -C に渡す新しい空の mkdtemp（os.tmpdir() 配下の
//   dev-flow-codex-cwd-XXXXXX）。これらか result.json が既にあれば書かない（前の結果を今の review と取り違えない）。
//   保存先と os.tmpdir() の祖先（自身を含む）に .git・AGENTS.md・AGENTS.override.md・CLAUDE.md があれば何も作らない（workspace_tainted）。
// stdout: JSON 1 行 {ok, review_dir, cwd_dir, nonce, error?}。error は固定の code だけ（stdout を写す agent へ PR 由来の文字列を渡さない）。
//   nonce は round ごとの乱数（CODEX_NONCE_RE）。保存先には書かない（sandbox の中から読める場所に置くと、先回りした result.json に
//   写せる）— workflow が codex の起動形の末尾の prompt と security-review-codex-result の引数にだけ渡す。
//   usage error だけ exit 2、それ以外は exit 0。
import { mkdtempSync, readFileSync, writeFileSync, lstatSync, existsSync, rmSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import {
  codexSecurityReviewPrompt, codexResultVerdict, codexResultPath, isCodexArgPath, CODEX_CWD_NAME_RE, CODEX_SECURITY_REVIEW_SCHEMA,
  SECURITY_REVIEW_DIR_NAME_RE, CODEX_PREPARED_AT_FILE, CODEX_NONCE_RE,
} from '../security-review.mjs'

const emit = (obj, code = 0) => {
  process.stdout.write(`${JSON.stringify(obj)}\n`)
  process.exit(code)
}
const fail = (error, code = 0) => emit({ ok: false, review_dir: null, cwd_dir: null, nonce: null, error }, code)

const argv = process.argv.slice(2)
let verifyFrom = null
const positional = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--verify-from' && i + 1 < argv.length && verifyFrom == null) verifyFrom = argv[++i]
  else positional.push(argv[i])
}
if (positional.length < 3 || positional.length > 4 || positional.some((a) => a.startsWith('-'))) fail('usage', 2)
const [reviewDir, headSha, pr, outputDir = null] = positional
if (!/^[0-9a-f]{40}$/i.test(headSha) || !/^[1-9][0-9]*$/.test(pr)) fail('usage', 2)

// 保存先は実在するディレクトリ（symlink でない）で、起動形に入れられる形のパス
const isRealDir = (p) => {
  try { return lstatSync(p).isDirectory() } catch { return false }
}
const isRealFile = (p) => {
  try { return lstatSync(p).isFile() } catch { return false }
}
if (!isCodexArgPath(reviewDir, SECURITY_REVIEW_DIR_NAME_RE) || !isRealDir(reviewDir)) fail('review_dir_invalid')
if (!isRealFile(join(reviewDir, 'pr.diff'))) fail('diff_unavailable')
if (['prompt.md', 'schema.json', 'result.json', CODEX_PREPARED_AT_FILE].some((f) => existsSync(join(reviewDir, f)))) fail('review_dir_not_fresh')

// 出力先は人が用意した、sandbox の中から書けない実ディレクトリだけ（ファイルを作れてしまったら消してから拒否する）
if (outputDir == null) fail('output_dir_unset')
if (!isCodexArgPath(outputDir) || !isRealDir(outputDir)) fail('output_dir_invalid')
const probe = join(outputDir, `.dev-flow-codex-write-probe-${randomBytes(8).toString('hex')}`)
let writable = false
try {
  writeFileSync(probe, '', { flag: 'wx' })
  writable = true
} catch {
  // 作れない（sandbox の中から書けない）出力先だけを使う
}
if (writable) {
  rmSync(probe, { force: true })
  fail('output_dir_writable')
}

// codex は作業ディレクトリから上へ .git・AGENTS.md 等を探して読む。-C の空ディレクトリ（tmpdir の配下）と保存先の祖先に
// 細工されたファイルがあれば、空の -C で指示ファイルを読ませない前提が崩れるので作業場所を作らない（run は Claude 経路に倒れる）
const TAINT_NAMES = ['.git', 'AGENTS.md', 'AGENTS.override.md', 'CLAUDE.md']
const existsNoFollow = (p) => {
  try { lstatSync(p); return true } catch { return false }
}
const taintedAncestor = (start) => {
  for (let d = resolve(start); ; d = dirname(d)) {
    if (TAINT_NAMES.some((n) => existsNoFollow(join(d, n)))) return true
    if (dirname(d) === d) return false
  }
}
if (taintedAncestor(reviewDir) || taintedAncestor(tmpdir())) fail('workspace_tainted')

let verifyItems = []
if (verifyFrom != null) {
  if (!CODEX_NONCE_RE.test(verifyFrom)) fail('verify_from_invalid')
  const prevPath = codexResultPath(outputDir, verifyFrom)
  if (!isRealFile(prevPath)) fail('verify_from_unreadable')
  let prev
  try {
    prev = JSON.parse(readFileSync(prevPath, 'utf8'))
  } catch {
    fail('verify_from_unreadable')
  }
  // 前回の reviewed_sha は今の head と違うので、件数の判定ではなく schema と前回の nonce の一致だけを見る（verify_items は prompt の
  // DATA 区間に入るだけで clear の根拠にならない）
  const v = codexResultVerdict(prev, prev?.reviewed_sha, verifyFrom)
  if (!v.ok) fail('verify_from_unreadable')
  verifyItems = v.issues.filter((x) => x.severity === 'critical' || x.severity === 'major')
}

let cwdDir = null
try {
  const diff = readFileSync(join(reviewDir, 'pr.diff'), 'utf8')
  writeFileSync(join(reviewDir, CODEX_PREPARED_AT_FILE), `${Date.now()}\n`, { flag: 'wx' })
  writeFileSync(join(reviewDir, 'schema.json'), `${JSON.stringify(CODEX_SECURITY_REVIEW_SCHEMA)}\n`, { flag: 'wx' })
  writeFileSync(join(reviewDir, 'prompt.md'), codexSecurityReviewPrompt({ pr, headSha, verifyItems, diff }), { flag: 'wx' })
  cwdDir = mkdtempSync(join(tmpdir(), 'dev-flow-codex-cwd-'))
} catch {
  fail('write_failed')
}
if (!isCodexArgPath(cwdDir, CODEX_CWD_NAME_RE)) {
  rmSync(cwdDir, { recursive: true, force: true })
  fail('cwd_dir_unsupported')
}
emit({ ok: true, review_dir: reviewDir, cwd_dir: cwdDir, nonce: randomBytes(16).toString('hex') })
