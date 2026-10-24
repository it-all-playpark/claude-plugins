// security-review-codex-result.mjs - Codex 経路の security review（issue #1087）の result.json を読んで判定する CLI。
// bin/security-review-codex-result（_shared/scripts/security-review-codex-result.sh 経由）から呼ぶ。
// 判定の規則は _lib/security-review.mjs の codexResultVerdict（schema 適合 + securityReviewVerdict と同じ規則）の 1 か所に置く。
//
// Usage: node security-review-codex-result.mjs <review_dir> <head_sha> [--issues]
//   review_dir: security-review-codex-prep が prompt.md・schema.json を書いた保存先（codex exec -o が result.json を書く）
//
// stdout: JSON 1 行
//   既定: {ok, cleared, reason, reviewed_sha, counts, error?} — 自由文を出さない（clear を決める中継に PR や Codex の文を
//     読ませない。reviewed_sha も 40 桁の hex でなければ null）。
//     ok:false（result.json が無い・symlink や通常ファイルでない・prep の prepared_at より前の mtime・JSON でない・schema に
//     適合しない）は判定できない — cleared は常に false。
//     cleared は critical/major 0 件かつ reviewed_sha が head_sha と一致したときだけ true。
//   --issues: {ok, issues, error?} — 指摘の本文（clear でなかった round の fix と verify_items 用）。
//   usage error だけ exit 2、それ以外は exit 0。
import { readFileSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { codexResultVerdict, isCodexArgPath, SECURITY_REVIEW_DIR_NAME_RE, CODEX_PREPARED_AT_FILE } from '../security-review.mjs'

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
if (!isCodexArgPath(reviewDir, SECURITY_REVIEW_DIR_NAME_RE)) fail('review_dir_invalid')

// result.json は保存先（symlink でない実ディレクトリ）の直下の通常ファイル（symlink でない）で、prep が記録した時刻より後に
// 書かれたものだけを読む（作業場所に先回りして置かれた結果や前の review の結果を clear の根拠にしない）
const resultPath = join(reviewDir, 'result.json')
let preparedAt
try {
  if (!lstatSync(reviewDir).isDirectory()) fail('review_dir_invalid')
} catch {
  fail('review_dir_invalid')
}
try {
  const raw = readFileSync(join(reviewDir, CODEX_PREPARED_AT_FILE), 'utf8').trim()
  if (!/^[1-9][0-9]*$/.test(raw)) fail('prepared_at_unreadable')
  preparedAt = Number(raw)
} catch {
  fail('prepared_at_unreadable')
}
let parsed
try {
  const st = lstatSync(resultPath)
  if (!st.isFile()) fail('result_unreadable')
  if (st.mtimeMs < preparedAt) fail('result_stale')
  parsed = JSON.parse(readFileSync(resultPath, 'utf8'))
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
