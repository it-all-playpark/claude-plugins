// security-review-codex-result.mjs - Codex 経路の security review（issue #1087）の結果ファイルを読んで判定する CLI。
// bin/security-review-codex-result（_shared/scripts/security-review-codex-result.sh 経由）から呼ぶ。
// 判定の規則は _lib/security-review.mjs の codexResultVerdict（schema 適合 + securityReviewVerdict と同じ規則）の 1 か所に置く。
//
// Usage: node security-review-codex-result.mjs <review_dir> <head_sha> <nonce> <binding> <output_dir> [--issues]
//   review_dir: security-review-codex-prep が prompt.md・schema.json・prepared_at を書いた保存先
//   nonce: prep が stdout で返した round の nonce（保存先には無い。codex の起動形の prompt にだけ渡る）
//   binding: prep が stdout で返した binding（保存先のパスと prep が書いた prompt.md・schema.json の中身の sha256）
//   output_dir: codex exec -o が結果ファイル <output_dir>/dev-flow-codex-result-<nonce>-<binding>.json を書く出力先。hook が同じ名前で
//     保存先の prompt.md・schema.json を複製している
//
// 結果ファイルを読むのは、引数の review_dir と出力先の複製（dev-flow-codex-{prompt,schema}-<nonce>-<binding>）の中身から計算した
// binding が引数の binding と一致したときだけ（binding_mismatch）。別の保存先や書き換えた中身で起動した codex の結果は、prep が返した
// binding の名前にならない。
//
// stdout: JSON 1 行
//   既定: {ok, cleared, reason, reviewed_sha, counts, error?} — 自由文を出さない（clear を決める中継に PR や Codex の文を
//     読ませない。reviewed_sha も 40 桁の hex でなければ null）。
//     ok:false（複製が無い・binding が一致しない・結果ファイルが無い・symlink や通常ファイルでない・出力先が symlink・prep の
//     prepared_at より前の mtime・JSON でない・schema に適合しない・nonce が一致しない）は判定できない — cleared は常に false。
//     nonce を知らない者（PR のコードが残した常駐プロセス等）が置いた・上書きした結果ファイルは nonce で弾く。
//     cleared は critical/major 0 件かつ reviewed_sha が head_sha と一致したときだけ true。
//   --issues: {ok, issues, error?} — 指摘の本文（clear でなかった round の fix と verify_items 用）。
//   usage error だけ exit 2、それ以外は exit 0。
import { readFileSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import {
  codexResultVerdict, codexResultPath, codexPromptCopyPath, codexSchemaCopyPath, isCodexArgPath, SECURITY_REVIEW_DIR_NAME_RE,
  CODEX_PREPARED_AT_FILE, CODEX_NONCE_RE, CODEX_BINDING_RE,
} from '../security-review.mjs'
import { codexBinding } from './security-review-codex-binding.mjs'

const emit = (obj, code = 0) => {
  process.stdout.write(`${JSON.stringify(obj)}\n`)
  process.exit(code)
}
const argv = process.argv.slice(2)
const issuesMode = argv.length === 6 && argv[5] === '--issues'
const fail = (error, code = 0) => emit(issuesMode
  ? { ok: false, issues: [], error }
  : { ok: false, cleared: false, reason: null, reviewed_sha: null, counts: { critical: 0, major: 0, minor: 0 }, error }, code)

const positional = issuesMode ? argv.slice(0, 5) : argv
if (positional.length !== 5 || positional.some((a) => a.startsWith('-'))) fail('usage', 2)
const [reviewDir, headSha, nonce, binding, outputDir] = positional
if (!/^[0-9a-f]{40}$/i.test(headSha) || !CODEX_NONCE_RE.test(nonce) || !CODEX_BINDING_RE.test(binding)) fail('usage', 2)
if (!isCodexArgPath(reviewDir, SECURITY_REVIEW_DIR_NAME_RE)) fail('review_dir_invalid')
if (!isCodexArgPath(outputDir)) fail('output_dir_invalid')

// 結果ファイルは出力先（symlink でない実ディレクトリ）の直下の通常ファイル（symlink でない）で、prep が保存先に記録した時刻より後に
// 書かれたものだけを読む（先回りして置かれた結果や前の review の結果を clear の根拠にしない）
const resultPath = codexResultPath(outputDir, nonce, binding)
let preparedAt
try {
  if (!lstatSync(reviewDir).isDirectory()) fail('review_dir_invalid')
} catch {
  fail('review_dir_invalid')
}
try {
  if (!lstatSync(outputDir).isDirectory()) fail('output_dir_invalid')
} catch {
  fail('output_dir_invalid')
}
// codex が読んだ複製（出力先の直下の通常ファイル）と引数の保存先から binding を計算し直す
const readCopy = (p) => {
  try {
    if (!lstatSync(p).isFile()) fail('copy_unreadable')
    return readFileSync(p)
  } catch {
    return fail('copy_unreadable')
  }
}
const promptCopy = readCopy(codexPromptCopyPath(outputDir, nonce, binding))
const schemaCopy = readCopy(codexSchemaCopyPath(outputDir, nonce, binding))
if (codexBinding(reviewDir, promptCopy, schemaCopy) !== binding) fail('binding_mismatch')
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
const verdict = codexResultVerdict(parsed, headSha, nonce)
if (!verdict.ok) fail(verdict.reason)
if (issuesMode) emit({ ok: true, issues: verdict.issues })
emit({
  ok: true, cleared: verdict.cleared, reason: verdict.reason,
  reviewed_sha: /^[0-9a-f]{40}$/i.test(verdict.reviewed_sha) ? verdict.reviewed_sha : null,
  counts: verdict.counts,
})
