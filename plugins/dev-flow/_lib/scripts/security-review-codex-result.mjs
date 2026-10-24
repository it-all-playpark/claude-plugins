// security-review-codex-result.mjs - Codex 経路の security review（issue #1087）の result.json を読んで判定する CLI。
// bin/security-review-codex-result（_shared/scripts/security-review-codex-result.sh 経由）から呼ぶ。
// 判定の規則は _lib/security-review.mjs の codexResultVerdict（schema 適合 + securityReviewVerdict と同じ規則）の 1 か所に置く。
//
// Usage: node security-review-codex-result.mjs <review_dir> <head_sha>
//   review_dir: security-review-codex-prep が prompt.md・schema.json を書いた保存先（codex exec -o が result.json を書く）
//
// stdout: JSON 1 行 {ok, cleared, reason, reviewed_sha, counts, issues, error?}
//   ok:false（result.json が無い・JSON でない・schema に適合しない）は判定できない — cleared は常に false。
//   cleared は critical/major 0 件かつ reviewed_sha が head_sha と一致したときだけ true。
//   usage error だけ exit 2、それ以外は exit 0。
import { readFileSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { codexResultVerdict, isCodexArgPath, SECURITY_REVIEW_DIR_NAME_RE } from '../security-review.mjs'

const emit = (obj, code = 0) => {
  process.stdout.write(`${JSON.stringify(obj)}\n`)
  process.exit(code)
}
const fail = (error, code = 0) => emit({ ok: false, cleared: false, reason: null, reviewed_sha: null, counts: { critical: 0, major: 0, minor: 0 }, issues: [], error }, code)

const argv = process.argv.slice(2)
if (argv.length !== 2 || argv.some((a) => a.startsWith('-'))) fail('usage', 2)
const [reviewDir, headSha] = argv
if (!/^[0-9a-f]{40}$/i.test(headSha)) fail('usage', 2)
if (!isCodexArgPath(reviewDir, SECURITY_REVIEW_DIR_NAME_RE)) fail('review_dir_invalid')

const resultPath = join(reviewDir, 'result.json')
let parsed
try {
  if (!lstatSync(resultPath).isFile()) fail('result_unreadable')
  parsed = JSON.parse(readFileSync(resultPath, 'utf8'))
} catch {
  fail('result_unreadable')
}
const verdict = codexResultVerdict(parsed, headSha)
if (!verdict.ok) fail(verdict.reason)
emit(verdict)
