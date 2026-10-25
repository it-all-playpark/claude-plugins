// security-review-codex-prep.mjs - Codex 経路の security review（issue #1087）の入力を保存先に用意する CLI。
// bin/security-review-codex-prep（_shared/scripts/security-review-codex-prep.sh 経由）から呼ぶ。
// prompt・schema・起動形の規則は _lib/security-review.mjs の 1 か所に置き、ここは書き出すだけ。
//
// Usage:
//   node security-review-codex-prep.mjs <review_dir> <head_sha> <pr> [--verify-from <prev_review_dir>/<prev_out_name>]
//     review_dir: security-review-scope --save-diff が作った保存先（dev-flow-security-review-XXXXXX。pr.diff だけを持つ）
//     --verify-from: 前回の Codex の review の結果の置き場（保存先/out_name）。その result.json の critical/major を verify_items にする
//
// 書くもの: <review_dir>/prompt.md（codexSecurityReviewPrompt + diff）・<review_dir>/schema.json（strict 形）・
//   <review_dir>/prepared_at（prep 時刻の epoch ms）・codex の -o の置き場 <review_dir>/<out_name>（乱数名、mode 0300）と、
//   codex の -C に渡す新しい空の mkdtemp（os.tmpdir() 配下の dev-flow-codex-cwd-XXXXXX）。保存先に pr.diff 以外があれば書かない
//   （前の結果を今の review と取り違えない）。書いた後に保存先を mode 0300 にする（一覧を取れない — out_name を知らない者は
//   result.json の場所が分からない。chmod で戻すと保存先の ctime が変わり stat_sha256 で検出する）。
//   保存先と os.tmpdir() の祖先（自身を含む）に .git・AGENTS.md・AGENTS.override.md・CLAUDE.md があれば何も作らない（workspace_tainted）。
// stdout: JSON 1 行 {ok, review_dir, cwd_dir, out_name, nonce, diff_sha256, diff_stat_sha256, fallback_diff_stat_sha256, prompt_sha256, schema_sha256, stat_sha256, error?}。
//   error は固定の code だけ（stdout を写す agent へ PR 由来の文字列を渡さない）。
//   nonce・out_name は round ごとの乱数（CODEX_NONCE_RE / CODEX_OUT_NAME_RE）。nonce は保存先に書かず、out_name は一覧を取れない
//   保存先にだけ置く（sandbox の中から読める場所に置くと、result.json を見つけて nonce を写した JSON で上書きできる）—
//   workflow が codex の起動形と security-review-codex-result の引数にだけ渡す。
//   diff_sha256 / diff_stat_sha256 は読んだ pr.diff の sha256 と書く前の保存先・pr.diff の statDigest、fallback_diff_stat_sha256 は
//   書いた後の保存先・pr.diff の statDigest（prep が保存先を書き換えるので、Codex から Claude 経路に倒れた round の
//   security-review-diff-check にはこの値を渡す）、prompt_sha256 / schema_sha256 は書いた内容の
//   sha256、stat_sha256 は書いた後の保存先・pr.diff・prompt.md・schema.json・prepared_at・-C の statDigest（dev・ino・ctime・nlink）。
//   workflow は diff_sha256 / diff_stat_sha256 を security-review-scope の値と照合し、prompt_sha256 / schema_sha256 / stat_sha256 を
//   security-review-codex-result に渡して codex の後に照合させる（保存先は sandbox の中から書けるので、codex が読む前に差し替えた
//   入力で clear にしない。ctime は戻せないので、差し替えて codex の後に戻した入力も検出する）。
//   usage error だけ exit 2、それ以外は exit 0。
import { mkdtempSync, mkdirSync, chmodSync, readFileSync, readdirSync, writeFileSync, lstatSync, rmSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
  codexSecurityReviewPrompt, codexResultVerdict, isCodexArgPath, CODEX_CWD_NAME_RE, CODEX_SECURITY_REVIEW_SCHEMA,
  SECURITY_REVIEW_DIR_NAME_RE, CODEX_PREPARED_AT_FILE, CODEX_OUT_NAME_RE,
} from '../security-review.mjs'
import { diffStatDigest, sha256Hex, statDigest, taintedAncestor } from './security-review-workspace.mjs'

const emit = (obj, code = 0) => {
  process.stdout.write(`${JSON.stringify(obj)}\n`)
  process.exit(code)
}
const fail = (error, code = 0) => emit({
  ok: false, review_dir: null, cwd_dir: null, out_name: null, nonce: null, diff_sha256: null, diff_stat_sha256: null,
  fallback_diff_stat_sha256: null, prompt_sha256: null, schema_sha256: null, stat_sha256: null, error,
}, code)

const argv = process.argv.slice(2)
let verifyFrom = null
const positional = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--verify-from' && i + 1 < argv.length && verifyFrom == null) verifyFrom = argv[++i]
  else positional.push(argv[i])
}
if (positional.length !== 3 || positional.some((a) => a.startsWith('-'))) fail('usage', 2)
const [reviewDir, headSha, pr] = positional
if (!/^[0-9a-f]{40}$/i.test(headSha) || !/^[1-9][0-9]*$/.test(pr)) fail('usage', 2)

// 保存先は実在するディレクトリ（symlink でない）で、起動形に入れられる形のパス
const isRealDir = (p) => {
  try { return lstatSync(p).isDirectory() } catch { return false }
}
const isRealFile = (p) => {
  try { return lstatSync(p).isFile() } catch { return false }
}
if (!isCodexArgPath(reviewDir, SECURITY_REVIEW_DIR_NAME_RE) || !isRealDir(reviewDir)) fail('review_dir_invalid')
const diffPath = join(reviewDir, 'pr.diff')
if (!isRealFile(diffPath)) fail('diff_unavailable')
// scope が作ったままの保存先（pr.diff だけ）。一覧を取れない（前の prep が mode 0300 にした）保存先も fresh でない
let entries
try {
  entries = readdirSync(reviewDir)
} catch {
  fail('review_dir_not_fresh')
}
if (entries.length !== 1 || entries[0] !== 'pr.diff') fail('review_dir_not_fresh')

// -C の空ディレクトリ（tmpdir の配下）と保存先の祖先に細工されたファイルがあれば作業場所を作らない（run は Claude 経路に倒れる）
if (taintedAncestor(reviewDir) || taintedAncestor(tmpdir())) fail('workspace_tainted')

let verifyItems = []
if (verifyFrom != null) {
  const prevDir = dirname(verifyFrom)
  if (!CODEX_OUT_NAME_RE.test(basename(verifyFrom)) || !isCodexArgPath(prevDir, SECURITY_REVIEW_DIR_NAME_RE)
    || !isRealDir(prevDir) || !isRealDir(verifyFrom) || prevDir === reviewDir) fail('verify_from_invalid')
  let prev
  try {
    prev = JSON.parse(readFileSync(join(verifyFrom, 'result.json'), 'utf8'))
  } catch {
    fail('verify_from_unreadable')
  }
  // 前回の reviewed_sha・nonce は今の round と違うので、件数の判定ではなく schema の適合だけを見る（verify_items は prompt の
  // DATA 区間に入るだけで clear の根拠にならない）
  const v = codexResultVerdict(prev, prev?.reviewed_sha, prev?.nonce)
  if (!v.ok) fail('verify_from_unreadable')
  verifyItems = v.issues.filter((x) => x.severity === 'critical' || x.severity === 'major')
}

let cwdDir = null
let out
try {
  const diffStatSha256 = diffStatDigest(reviewDir)
  const diffBuf = readFileSync(diffPath)
  const schema = `${JSON.stringify(CODEX_SECURITY_REVIEW_SCHEMA)}\n`
  const prompt = codexSecurityReviewPrompt({ pr, headSha, verifyItems, diff: diffBuf.toString('utf8') })
  writeFileSync(join(reviewDir, CODEX_PREPARED_AT_FILE), `${Date.now()}\n`, { flag: 'wx' })
  writeFileSync(join(reviewDir, 'schema.json'), schema, { flag: 'wx' })
  writeFileSync(join(reviewDir, 'prompt.md'), prompt, { flag: 'wx' })
  // 一覧を取れなくしてから乱数名の置き場を作る（作った名前を保存先の一覧から読ませない）
  chmodSync(reviewDir, 0o300)
  const outName = randomBytes(16).toString('hex')
  mkdirSync(join(reviewDir, outName), { mode: 0o300 })
  chmodSync(join(reviewDir, outName), 0o300)
  cwdDir = mkdtempSync(join(tmpdir(), 'dev-flow-codex-cwd-'))
  const statSha256 = statDigest([reviewDir, diffPath, join(reviewDir, 'prompt.md'), join(reviewDir, 'schema.json'), join(reviewDir, CODEX_PREPARED_AT_FILE), cwdDir])
  const fallbackDiffStatSha256 = diffStatDigest(reviewDir)
  if (diffStatSha256 == null || statSha256 == null || fallbackDiffStatSha256 == null) throw new Error('stat')
  out = {
    out_name: outName, diff_sha256: sha256Hex(diffBuf), diff_stat_sha256: diffStatSha256,
    fallback_diff_stat_sha256: fallbackDiffStatSha256,
    prompt_sha256: sha256Hex(prompt), schema_sha256: sha256Hex(schema), stat_sha256: statSha256,
  }
} catch {
  if (cwdDir) rmSync(cwdDir, { recursive: true, force: true })
  fail('write_failed')
}
if (!isCodexArgPath(cwdDir, CODEX_CWD_NAME_RE)) {
  rmSync(cwdDir, { recursive: true, force: true })
  fail('cwd_dir_unsupported')
}
emit({ ok: true, review_dir: reviewDir, cwd_dir: cwdDir, out_name: out.out_name, nonce: randomBytes(16).toString('hex'), ...out })
