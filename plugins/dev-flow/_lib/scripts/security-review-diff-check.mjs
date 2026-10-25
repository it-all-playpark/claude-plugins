// security-review-diff-check.mjs - security review の保存先の pr.diff が、security-review-scope --save-diff が書いた diff のままかを
// 照合する CLI（issue #1095）。bin/security-review-diff-check（_shared/scripts/security-review-diff-check.sh 経由）から呼ぶ。
//
// 保存先（os.tmpdir() 配下）は sandbox の中に残った PR のプロセスからも書けるので、security-reviewer が読む前に pr.diff を良性の diff に
// 差し替えられる。pr-iterate は clear になりそうな round で review の後にこの CLI を走らせ、matched:true でなければ clear にしない。
// 照合はここで行い、中継（LLM）は argv を写して stdout を返すだけ（sha256 の一致を中継に判定させない）。
//
// Usage: node security-review-diff-check.mjs <review_dir> <diff_sha256>
//   review_dir: security-review-scope --save-diff が作った保存先（dev-flow-security-review-XXXXXX）
//   diff_sha256: security-review-scope が返した diff_sha256（64 桁の小文字 hex）
// stdout: JSON 1 行 {ok, matched, error?}。matched は <review_dir>/pr.diff（symlink でない通常ファイル）の sha256 が引数と一致したとき
//   だけ true。保存先・pr.diff を読めなければ ok:false（error は固定の code だけ）。usage error だけ exit 2、それ以外は exit 0。
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isCodexArgPath, SECURITY_REVIEW_DIR_NAME_RE, SHA256_RE } from '../security-review.mjs'

const emit = (obj, code = 0) => {
  process.stdout.write(`${JSON.stringify(obj)}\n`)
  process.exit(code)
}
const fail = (error, code = 0) => emit({ ok: false, matched: false, error }, code)

const argv = process.argv.slice(2)
if (argv.length !== 2 || !SHA256_RE.test(argv[1])) fail('usage', 2)
const [reviewDir, expected] = argv
if (!isCodexArgPath(reviewDir, SECURITY_REVIEW_DIR_NAME_RE)) fail('review_dir_invalid')
try {
  if (!lstatSync(reviewDir).isDirectory()) fail('review_dir_invalid')
} catch {
  fail('review_dir_invalid')
}
let diff
try {
  const p = join(reviewDir, 'pr.diff')
  if (!lstatSync(p).isFile()) fail('diff_unavailable')
  diff = readFileSync(p)
} catch {
  fail('diff_unavailable')
}
emit({ ok: true, matched: createHash('sha256').update(diff).digest('hex') === expected })
