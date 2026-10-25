// security-review-codex-result.mjs - Codex 経路の security review（issue #1087）の結果ファイルを読んで判定する CLI。
// bin/security-review-codex-result（_shared/scripts/security-review-codex-result.sh 経由）から呼ぶ。
// 判定の規則は _lib/security-review.mjs の codexResultVerdict（schema 適合 + securityReviewVerdict と同じ規則）の 1 か所に置く。
//
// Usage: node security-review-codex-result.mjs <review_dir> <head_sha> [--issues]
//   review_dir: security-review-codex-prep が prompt.md・schema.json・cwd/ を用意し、codex exec -o が result.json を書いた保存先
//
// stdout: JSON 1 行
//   既定: {ok, cleared, reason, reviewed_sha, counts, error?} — 自由文を出さない（clear を決める中継に PR や Codex の文を
//     読ませない。reviewed_sha も 40 桁の hex でなければ null）。
//     ok:false（result.json が無い・読めない・JSON でない・schema に適合しない）は判定できない — cleared は常に false。
//     cleared は critical/major 0 件かつ reviewed_sha が head_sha と一致したときだけ true。
//   --issues: {ok, issues, error?} — 指摘の本文（clear でなかった round の fix と verify_items 用）。
//   usage error だけ exit 2、それ以外は exit 0。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { codexResultVerdict, isCodexArgPath } from '../security-review.mjs'

const emit = (obj, code = 0) => {
  process.stdout.write(`${JSON.stringify(obj)}\n`)
  process.exit(code)
}
const argv = process.argv.slice(2)
const issuesMode = argv.length === 3 && argv[2] === '--issues'
const fail = (error, code = 0) => emit(issuesMode
  ? { ok: false, issues: [], error }
  : { ok: false, cleared: false, reason: null, reviewed_sha: null, counts: { critical: 0, major: 0, minor: 0 }, error }, code)

const positional = issuesMode ? argv.slice(0, 2) : argv
if (positional.length !== 2 || positional.some((a) => a.startsWith('-'))) fail('usage', 2)
const [reviewDir, headSha] = positional
if (!/^[0-9a-f]{40}$/i.test(headSha)) fail('usage', 2)
if (!isCodexArgPath(reviewDir)) fail('review_dir_invalid')

let parsed
try {
  parsed = JSON.parse(readFileSync(join(reviewDir, 'result.json'), 'utf8'))
} catch {
  fail('result_unreadable')
}
const verdict = codexResultVerdict(parsed, headSha)
if (!verdict.ok) fail(verdict.reason)
if (issuesMode) emit({ ok: true, issues: verdict.issues })
emit({
  ok: true, cleared: verdict.cleared, reason: verdict.reason,
  reviewed_sha: /^[0-9a-f]{40}$/i.test(verdict.reviewed_sha) ? verdict.reviewed_sha : null,
  counts: verdict.counts,
})
