// security-review-diff-check.mjs - Claude 経路の security review（issue #1095）の後に、保存先の pr.diff が
// security-review-scope --save-diff の書いたものかを照合する CLI。bin/security-review-diff-check
// （_shared/scripts/security-review-diff-check.sh 経由）から呼ぶ。
//
// 保存先（os.tmpdir() 配下）は sandbox の中の PR のコード（fix・test で走らせて残った常駐プロセス）からも書けるので、
// security-reviewer が読む前に pr.diff を良性の diff に差し替えられる。workflow は scope が返した sha256 と保存先・pr.diff の
// statDigest（dev・ino・ctime の ns・nlink。Codex 経路から倒れた round は prep が書いた後の値）をここへ argv で渡し、照合は script が
// 行う（中継は stdout を写すだけ）。内容の sha256 だけでは差し替えて review の後に元へ戻した pr.diff を見分けられないので、利用者が
// 戻せない ctime を含む statDigest の一致も求める。保存先自身も含めるのは、保存先ごと rename で退避して良性の pr.diff を持つ同名の
// ディレクトリと review の間だけ入れ替えて戻すと、pr.diff の ino・ctime・nlink・内容はどれも変わらないため。
//
// Usage: node security-review-diff-check.mjs <review_dir> <diff_sha256> <diff_stat_sha256>
// stdout: JSON 1 行 {ok, matched, error?}。matched は pr.diff（保存先の直下の通常ファイル。symlink でない）の sha256 が
//   diff_sha256 と、保存先・pr.diff の statDigest が diff_stat_sha256 と一致したときだけ true。ok:false（保存先の形でない・symlink・pr.diff が
//   通常ファイルでない）は照合できない — matched は常に false。error は固定の code だけ。usage error だけ exit 2、それ以外は exit 0。
import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { isCodexArgPath, SECURITY_REVIEW_DIR_NAME_RE, SHA256_HEX_RE } from '../security-review.mjs'
import { diffStatDigest, sha256OfRegularFile } from './security-review-workspace.mjs'

const emit = (obj, code = 0) => {
  process.stdout.write(`${JSON.stringify(obj)}\n`)
  process.exit(code)
}
const fail = (error, code = 0) => emit({ ok: false, matched: false, error }, code)

const argv = process.argv.slice(2)
if (argv.length !== 3 || !SHA256_HEX_RE.test(argv[1]) || !SHA256_HEX_RE.test(argv[2])) fail('usage', 2)
const [reviewDir, expected, expectedStat] = argv
if (!isCodexArgPath(reviewDir, SECURITY_REVIEW_DIR_NAME_RE)) fail('review_dir_invalid')
try {
  if (!lstatSync(reviewDir).isDirectory()) fail('review_dir_invalid')
} catch {
  fail('review_dir_invalid')
}
const diffPath = join(reviewDir, 'pr.diff')
const actual = sha256OfRegularFile(diffPath)
if (actual == null) fail('diff_unavailable')
emit({ ok: true, matched: actual === expected && diffStatDigest(reviewDir) === expectedStat })
