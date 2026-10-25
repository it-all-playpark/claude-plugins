// security-review-codex-result.mjs - Codex 経路の security review（issue #1087）の result.json を読んで判定する CLI。
// bin/security-review-codex-result（_shared/scripts/security-review-codex-result.sh 経由）から呼ぶ。
// 判定の規則は _lib/security-review.mjs の codexResultVerdict（schema 適合 + securityReviewVerdict と同じ規則）の 1 か所に置く。
//
// Usage: node security-review-codex-result.mjs <review_dir> <head_sha> <nonce> <cwd_dir> <prompt_sha256> <schema_sha256> [--issues]
//   review_dir: security-review-codex-prep が prompt.md・schema.json を書いた保存先（codex exec -o が result.json を書く）
//   nonce: prep が stdout で返した round の nonce（保存先には無い。codex の起動形の prompt にだけ渡る）
//   cwd_dir / prompt_sha256 / schema_sha256: prep が stdout で返した codex の -C と、書いた prompt.md・schema.json の sha256
//
// codex の後に入力を照合する（issue #1095）: prompt.md・schema.json の sha256 が prep の値と一致し、-C が空の実ディレクトリで、
//   -C と保存先の祖先（自身を含む）に .git・AGENTS.md・AGENTS.override.md・CLAUDE.md が無いときだけ result.json を読む。
//   保存先と -C は sandbox の中から書けるので、codex が読む前に差し替えた diff・schema・指示ファイルで clear にしない
//   （hook の検査は起動直前の 1 回だけ）。書き換えて codex の後に戻す経路は検出できない。
//
// stdout: JSON 1 行
//   既定: {ok, cleared, reason, reviewed_sha, counts, error?} — 自由文を出さない（clear を決める中継に PR や Codex の文を
//     読ませない。reviewed_sha も 40 桁の hex でなければ null）。
//     ok:false（入力が prep の後に変わった・result.json が無い・symlink や通常ファイルでない・prep の prepared_at より前の mtime・
//     JSON でない・schema に適合しない・nonce が一致しない）は判定できない — cleared は常に false。保存先は sandbox の中から
//     書けるので、nonce を知らない者（PR のコードが残した常駐プロセス等）が置いた・上書きした result.json は nonce で弾く。
//     cleared は critical/major 0 件かつ reviewed_sha が head_sha と一致したときだけ true。
//   --issues: {ok, issues, error?} — 指摘の本文（clear でなかった round の fix と verify_items 用）。
//   usage error だけ exit 2、それ以外は exit 0。
import { readFileSync, readdirSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import {
  codexResultVerdict, isCodexArgPath, SECURITY_REVIEW_DIR_NAME_RE, CODEX_CWD_NAME_RE, CODEX_PREPARED_AT_FILE, CODEX_NONCE_RE,
  SHA256_HEX_RE,
} from '../security-review.mjs'
import { sha256OfRegularFile, taintedAncestor } from './security-review-workspace.mjs'

const emit = (obj, code = 0) => {
  process.stdout.write(`${JSON.stringify(obj)}\n`)
  process.exit(code)
}
const argv = process.argv.slice(2)
const issuesMode = argv.length === 7 && argv[6] === '--issues'
const fail = (error, code = 0) => emit(issuesMode
  ? { ok: false, issues: [], error }
  : { ok: false, cleared: false, reason: null, reviewed_sha: null, counts: { critical: 0, major: 0, minor: 0 }, error }, code)

const positional = issuesMode ? argv.slice(0, 6) : argv
if (positional.length !== 6 || positional.some((a) => a.startsWith('-'))) fail('usage', 2)
const [reviewDir, headSha, nonce, cwdDir, promptSha, schemaSha] = positional
if (!/^[0-9a-f]{40}$/i.test(headSha) || !CODEX_NONCE_RE.test(nonce) || !SHA256_HEX_RE.test(promptSha) || !SHA256_HEX_RE.test(schemaSha)) fail('usage', 2)
if (!isCodexArgPath(reviewDir, SECURITY_REVIEW_DIR_NAME_RE)) fail('review_dir_invalid')
if (!isCodexArgPath(cwdDir, CODEX_CWD_NAME_RE)) fail('cwd_dir_invalid')

const isRealDir = (p) => {
  try { return lstatSync(p).isDirectory() } catch { return false }
}
if (!isRealDir(reviewDir)) fail('review_dir_invalid')
if (!isRealDir(cwdDir)) fail('cwd_dir_invalid')
// codex が読んだ入力が prep の書いたものか（schema を maxItems:0 にする・prompt.md の diff を空にする差し替えで clear にしない）
if (sha256OfRegularFile(join(reviewDir, 'prompt.md')) !== promptSha || sha256OfRegularFile(join(reviewDir, 'schema.json')) !== schemaSha) {
  fail('input_changed')
}
// -C に置いた指示ファイル（AGENTS.md 等）を codex に読ませた round を clear にしない
let cwdEntries
try {
  cwdEntries = readdirSync(cwdDir)
} catch {
  fail('cwd_dir_invalid')
}
if (cwdEntries.length > 0) fail('cwd_not_empty')
if (taintedAncestor(cwdDir) || taintedAncestor(reviewDir)) fail('workspace_tainted')

// result.json は保存先（symlink でない実ディレクトリ）の直下の通常ファイル（symlink でない）で、prep が記録した時刻より後に
// 書かれたものだけを読む（作業場所に先回りして置かれた結果や前の review の結果を clear の根拠にしない）
const resultPath = join(reviewDir, 'result.json')
let preparedAt
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
