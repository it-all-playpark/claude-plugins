// security-review-codex-prep.mjs - Codex 経路の security review（issue #1087）の入力を保存先に用意する CLI。
// bin/security-review-codex-prep（_shared/scripts/security-review-codex-prep.sh 経由）から呼ぶ。
// prompt・schema・起動形の規則は _lib/security-review.mjs の 1 か所に置き、ここは書き出すだけ。
//
// Usage:
//   node security-review-codex-prep.mjs <review_dir> <head_sha> <pr> <diff_sha256> <output_dir> [--verify-from <prev_nonce> <prev_binding>]
//     review_dir: security-review-scope --save-diff が作った保存先（dev-flow-security-review-XXXXXX。pr.diff を持つ）
//     diff_sha256: security-review-scope が返した diff_sha256。読んだ pr.diff の sha256 が違えば何も書かず diff_mismatch
//       （保存先は sandbox の中から書けるので、prep の時だけ差し替えて後で戻した pr.diff から prompt.md を作らない — 作ると binding も
//       差し替え後の中身になり、result 側の再照合では見分けられない）
//     output_dir: codex が -o で結果ファイル（dev-flow-codex-result-<nonce>-<binding>.json）を書く出力先（user 設定の "dev-flow".codex_output_dir）。
//       省略は未設定（output_dir_unset）。realpath が自身と一致する（祖先にも symlink を含まない）実ディレクトリの絶対パスで、
//       出力先と全祖先のどこにも、ここ（sandbox の中）からファイルを作れないこと — 作れる出力先では、sandbox の中の常駐プロセスが
//       結果ファイルの名前に symlink を置き、作れる祖先では出力先を symlink に差し替えて、sandbox の外で動く codex に任意のファイルを
//       上書きさせられる。作れてしまったら消してから output_dir_writable。出力先を作る・片付けるのは人で、この script はしない
//     --verify-from: 前回の Codex の review の nonce と binding。出力先のその結果ファイルの critical/major を verify_items にする
//
// 書くもの: <review_dir>/prompt.md（codexSecurityReviewPrompt + diff）・<review_dir>/schema.json（strict 形）・
//   <review_dir>/prepared_at（prep 時刻の epoch ms）。これらか result.json が既にあれば書かない
//   （前の結果を今の review と取り違えない）。codex の -C（<output_dir>/dev-flow-codex-cwd-<nonce>-<binding>）は hook が binding の
//   照合の後に作る — 保存先（sandbox の中から書ける）の配下に置くと、常駐プロセスが .git・AGENTS.md を置いて codex に指示として
//   読ませられる。出力先の祖先（自身を含む）に .git・AGENTS.md・AGENTS.override.md・CLAUDE.md があれば何も作らない（workspace_tainted）。
// stdout: JSON 1 行 {ok, review_dir, nonce, binding, prompt_sha256, schema_sha256, error?}。error は固定の code だけ（stdout を写す agent へ
//   PR 由来の文字列を渡さない）。prompt_sha256 / schema_sha256 は書いた prompt.md・schema.json の sha256 で、security-review-codex-result が
//   引数で受け取り、codex の後に出力先の複製と保存先の 2 つを再照合する（hook の照合は起動の直前の 1 回だけ）。
//   nonce は round ごとの乱数（CODEX_NONCE_RE）。保存先には書かない（sandbox の中から読める場所に置くと、先回りした結果ファイルに
//   写せる）— workflow が codex の起動形の末尾の prompt と security-review-codex-result の引数にだけ渡す。
//   binding は保存先のパスと書いた prompt.md・schema.json の中身の sha256（codexBinding）。hook は出力先へ複製した 2 つから同じ値を
//   計算できたときだけ codex を通し、結果ファイルの名前にも入る（書いた後に保存先の 2 つを書き換えられても、その中身の review は
//   workflow が渡す binding の名前の結果にならない）。
//   usage error だけ exit 2、それ以外は exit 0。
import { readFileSync, writeFileSync, lstatSync, existsSync, rmSync, realpathSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join, dirname } from 'node:path'
import {
  codexSecurityReviewPrompt, codexResultVerdict, codexResultPath, isCodexArgPath, CODEX_SECURITY_REVIEW_SCHEMA,
  SECURITY_REVIEW_DIR_NAME_RE, CODEX_PREPARED_AT_FILE, CODEX_NONCE_RE, CODEX_BINDING_RE, SHA256_RE,
} from '../security-review.mjs'
import { codexBinding, sha256Hex } from './security-review-codex-binding.mjs'
import { taintedAncestor } from './security-review-codex-workspace.mjs'

const emit = (obj, code = 0) => {
  process.stdout.write(`${JSON.stringify(obj)}\n`)
  process.exit(code)
}
const fail = (error, code = 0) => emit({ ok: false, review_dir: null, nonce: null, binding: null, prompt_sha256: null, schema_sha256: null, error }, code)

const argv = process.argv.slice(2)
let verifyFrom = null
const positional = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--verify-from' && i + 2 < argv.length && verifyFrom == null) {
    verifyFrom = { nonce: argv[i + 1], binding: argv[i + 2] }
    i += 2
  } else positional.push(argv[i])
}
if (positional.length < 4 || positional.length > 5 || positional.some((a) => a.startsWith('-'))) fail('usage', 2)
const [reviewDir, headSha, pr, diffSha256, outputDir = null] = positional
if (!/^[0-9a-f]{40}$/i.test(headSha) || !/^[1-9][0-9]*$/.test(pr) || !SHA256_RE.test(diffSha256)) fail('usage', 2)

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

// 出力先は人が用意した、sandbox の中から書けない実ディレクトリだけ。codex は終了時に -o を書くので、hook が確かめた後に
// 出力先かその祖先を rename して symlink に差し替えられると、結果ファイルは差し替え先に書かれる。祖先に symlink を含まない
// （realpath が自身と一致する）ことと、出力先と全祖先のどこにもファイルを作れないことを確かめる（作れたら消してから拒否する）
if (outputDir == null) fail('output_dir_unset')
if (!isCodexArgPath(outputDir) || !isRealDir(outputDir)) fail('output_dir_invalid')
let outputReal = null
try { outputReal = realpathSync(outputDir) } catch { /* 下で拒否 */ }
if (outputReal !== outputDir) fail('output_dir_invalid')
const writableDir = (dir) => {
  const probe = join(dir, `.dev-flow-codex-write-probe-${randomBytes(8).toString('hex')}`)
  try {
    writeFileSync(probe, '', { flag: 'wx' })
  } catch {
    return false
  }
  rmSync(probe, { force: true })
  return true
}
for (let d = outputDir; ; d = dirname(d)) {
  if (writableDir(d)) fail('output_dir_writable')
  if (dirname(d) === d) break
}

// codex は作業ディレクトリから上へ .git・AGENTS.md 等を探して読む。-C の空ディレクトリ（出力先の直下）の祖先に
// これらがあれば、空の -C で指示ファイルを読ませない前提が崩れるので入力を作らない（run は Claude 経路に倒れる）
if (taintedAncestor(outputDir)) fail('workspace_tainted')

let verifyItems = []
if (verifyFrom != null) {
  if (!CODEX_NONCE_RE.test(verifyFrom.nonce) || !CODEX_BINDING_RE.test(verifyFrom.binding)) fail('verify_from_invalid')
  const prevPath = codexResultPath(outputDir, verifyFrom.nonce, verifyFrom.binding)
  if (!isRealFile(prevPath)) fail('verify_from_unreadable')
  let prev
  try {
    prev = JSON.parse(readFileSync(prevPath, 'utf8'))
  } catch {
    fail('verify_from_unreadable')
  }
  // 前回の reviewed_sha は今の head と違うので、件数の判定ではなく schema と前回の nonce の一致だけを見る（verify_items は prompt の
  // DATA 区間に入るだけで clear の根拠にならない）
  const v = codexResultVerdict(prev, prev?.reviewed_sha, verifyFrom.nonce)
  if (!v.ok) fail('verify_from_unreadable')
  verifyItems = v.issues.filter((x) => x.severity === 'critical' || x.severity === 'major')
}

let diffBuf
try {
  diffBuf = readFileSync(join(reviewDir, 'pr.diff'))
} catch {
  fail('diff_unavailable')
}
if (sha256Hex(diffBuf) !== diffSha256) fail('diff_mismatch')

let binding = null
let promptSha256 = null
let schemaSha256 = null
try {
  const diff = diffBuf.toString('utf8')
  const schema = `${JSON.stringify(CODEX_SECURITY_REVIEW_SCHEMA)}\n`
  const prompt = codexSecurityReviewPrompt({ pr, headSha, verifyItems, diff })
  writeFileSync(join(reviewDir, CODEX_PREPARED_AT_FILE), `${Date.now()}\n`, { flag: 'wx' })
  writeFileSync(join(reviewDir, 'schema.json'), schema, { flag: 'wx' })
  writeFileSync(join(reviewDir, 'prompt.md'), prompt, { flag: 'wx' })
  // binding と sha256 は書いた後のファイルではなく、書いた値から作る（書いた直後に差し替えられた中身を照合の基準にしない）
  const promptBuf = Buffer.from(prompt, 'utf8')
  const schemaBuf = Buffer.from(schema, 'utf8')
  binding = codexBinding(reviewDir, promptBuf, schemaBuf)
  promptSha256 = sha256Hex(promptBuf)
  schemaSha256 = sha256Hex(schemaBuf)
} catch {
  fail('write_failed')
}
emit({ ok: true, review_dir: reviewDir, nonce: randomBytes(16).toString('hex'), binding, prompt_sha256: promptSha256, schema_sha256: schemaSha256 })
