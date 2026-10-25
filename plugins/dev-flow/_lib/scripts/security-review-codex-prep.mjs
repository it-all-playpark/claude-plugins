// security-review-codex-prep.mjs - Codex 経路の security review（issue #1087）の入力を保存先に用意する CLI。
// bin/security-review-codex-prep（_shared/scripts/security-review-codex-prep.sh 経由）から呼ぶ。
// prompt・schema・起動形の規則は _lib/security-review.mjs の 1 か所に置き、ここは書き出すだけ。
//
// Usage:
//   node security-review-codex-prep.mjs <review_dir> <head_sha> <pr> [--verify-from <prev_review_dir>]
//     review_dir: security-review-scope --save-diff が作った保存先（dev-flow-security-review-XXXXXX。pr.diff を持つ）
//     --verify-from: 前回の Codex の review の保存先。その result.json の critical/major を verify_items にする
//
// 書くもの: <review_dir>/prompt.md（codexSecurityReviewPrompt + diff）・<review_dir>/schema.json（strict 形）・空の <review_dir>/cwd/
//   （codex の -C。cwd の AGENTS.md を読ませない）。どれかか result.json が既にあれば何も書かない（前の結果を今の review と取り違えない）。
// stdout: JSON 1 行 {ok, error?}。error は固定の code だけ（stdout を写す agent へ PR 由来の文字列を渡さない）。
//   usage error だけ exit 2、それ以外は exit 0。
import { readFileSync, writeFileSync, mkdirSync, lstatSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { codexSecurityReviewPrompt, codexResultVerdict, isCodexArgPath, CODEX_SECURITY_REVIEW_SCHEMA } from '../security-review.mjs'

const emit = (obj, code = 0) => {
  process.stdout.write(`${JSON.stringify(obj)}\n`)
  process.exit(code)
}
const fail = (error, code = 0) => emit({ ok: false, error }, code)

const argv = process.argv.slice(2)
const vi = argv.indexOf('--verify-from')
const verifyFrom = vi >= 0 ? argv[vi + 1] : null
const positional = vi >= 0 ? [...argv.slice(0, vi), ...argv.slice(vi + 2)] : argv
if (positional.length !== 3 || positional.some((a) => a.startsWith('-')) || (vi >= 0 && verifyFrom == null)) fail('usage', 2)
const [reviewDir, headSha, pr] = positional
if (!/^[0-9a-f]{40}$/i.test(headSha) || !/^[1-9][0-9]*$/.test(pr)) fail('usage', 2)

const isRealDir = (p) => {
  try { return lstatSync(p).isDirectory() } catch { return false }
}
if (!isCodexArgPath(reviewDir) || !isRealDir(reviewDir)) fail('review_dir_invalid')
if (['prompt.md', 'schema.json', 'result.json', 'cwd'].some((f) => existsSync(join(reviewDir, f)))) fail('review_dir_not_fresh')

let verifyItems = []
if (verifyFrom != null) {
  if (!isCodexArgPath(verifyFrom)) fail('verify_from_invalid')
  let prev
  try {
    prev = JSON.parse(readFileSync(join(verifyFrom, 'result.json'), 'utf8'))
  } catch {
    fail('verify_from_unreadable')
  }
  // 前回の reviewed_sha は今の head と違うので、件数の判定ではなく schema の適合だけを見る（verify_items は prompt の
  // DATA 区間に入るだけで clear の根拠にならない）
  const v = codexResultVerdict(prev, prev?.reviewed_sha)
  if (!v.ok) fail('verify_from_unreadable')
  verifyItems = v.issues.filter((x) => x.severity === 'critical' || x.severity === 'major')
}

let diff
try {
  diff = readFileSync(join(reviewDir, 'pr.diff'), 'utf8')
} catch {
  fail('diff_unavailable')
}

try {
  writeFileSync(join(reviewDir, 'schema.json'), `${JSON.stringify(CODEX_SECURITY_REVIEW_SCHEMA)}\n`, { flag: 'wx' })
  writeFileSync(join(reviewDir, 'prompt.md'), codexSecurityReviewPrompt({ pr, headSha, verifyItems, diff }), { flag: 'wx' })
  mkdirSync(join(reviewDir, 'cwd'))
} catch {
  fail('write_failed')
}
emit({ ok: true })
