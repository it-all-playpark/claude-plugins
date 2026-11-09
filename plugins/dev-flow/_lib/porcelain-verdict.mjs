// porcelain-verdict.mjs — pr-iterate の fix-baseline・commit-ensure・worktree-dirty-check が使う
// `git status --porcelain --untracked-files=all` の判定（純関数）。status の実行・基準線ファイルの読み書き・digest は
// bin/porcelain-verdict（_shared/scripts/porcelain-verdict.mjs）が持ち、規則はこのファイルの 1 か所に置く。
//
// status は常に `--untracked-files=all` で取る。既定では未追跡ファイルがディレクトリ（`?? dir/`）にまとまり、
// fix が同じディレクトリの追跡ファイルを消すと基準線の `?? dir/secret.env` が新規行 `?? dir/` に化け、
// 回収の add がディレクトリごと（基準線の未追跡ファイルまで）stage する。
// 「出力が空か」では判定しない: 読めないファイル（.env.example 等）について git が出す
// `<path>: Operation not permitted` や `warning:` の行だけで clean な worktree を dirty と読み、commit-ensure が
// fix_failed で終端する。exit 非0 は判定不能として dirty 側に倒す（clean 側に倒すと未コミット変更を見逃して
// 次 iteration へ進み、fail-safe が崩れる）。

// 基準線ファイルの置き場（worktree root 相対）。ファイル名は内容の sha256。基準線ファイル自体は porcelain 行に数えない
export const PORCELAIN_BASELINE_DIR = '.devflow-tmp/porcelain-baseline'

// porcelain 行: 先頭 2 文字が状態コードで 3 文字目が空白の行。それ以外（警告行）は数えない
const PORCELAIN_LINE_RE = /^[ MTADRCU?!]{2} ./

/** status の生の出力から、基準線ファイルを除いた porcelain 行を出力順に返す。 */
export function porcelainLines(output) {
  return String(output ?? '')
    .split('\n')
    .filter((l) => PORCELAIN_LINE_RE.test(l) && !l.slice(3).startsWith(`${PORCELAIN_BASELINE_DIR}/`))
}

/** 基準線ファイルの内容（1 行 1 porcelain 行）。digest はこの文字列の sha256。 */
export function baselineContent(lines) {
  return lines.map((l) => `${l}\n`).join('')
}

/** 基準線ファイルの内容を porcelain 行の配列に戻す。 */
export function parseBaselineContent(content) {
  return String(content).split('\n').filter((l) => l !== '')
}

// 回収の stage コマンドの組み立て。パスは PR が名付けたファイル名（外部入力）なので、agent に
// シェルコマンドへ転記させない（`$(...)` 等のコマンド置換が走る）。各パスは単一引用符で囲んだリテラルな引数にし、
// `--literal-pathspecs` で `:!x` 等の pathspec magic を無効にする（除外 pathspec だけだと基準線の未追跡ファイルまで stage する）。
// 対象は新規行のうち 2 文字目が空白でない行（2 文字目が空白の行は stage 済み）。rename / copy の行（1・2 文字目に R / C）は
// 並べない: `old -> new` の区切りは引用されたパスの中にも現れ、分割すると宛先を別のパス（基準線の未追跡ファイル等）に
// 取り違える。C 形式で引用されたパス（空白・非 ASCII 等を含む名前。`"` で囲まれる）は戻してから引用する。戻せないパスと、
// 制御文字・backtick を含むパスと、`/` で終わるパス（ディレクトリ。add すると中の基準線の未追跡ファイルまで stage する）は
// 並べない（stage されずに commit-ensure の手順 3 の判定に残り committed:false → fix_failed で止まる。fail-safe）。
// 未 stage の削除は `--ignore-removal` で stage しない（部分 checkout の取り出せなかったパスと区別できない）。
const shellQuote = (s) => "'" + s.split("'").join("'\\''") + "'"
const C_ESCAPES = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 }

/** porcelain の C 形式で引用されたパスを戻す（引用されていなければそのまま。戻せなければ null）。 */
export function unquotePorcelainPath(p) {
  if (!p.startsWith('"')) return p
  if (p.length < 2 || !p.endsWith('"')) return null
  const bytes = []
  const body = p.slice(1, -1)
  for (let k = 0; k < body.length; k++) {
    const c = body[k]
    if (c !== '\\') {
      if (c === '"') return null
      for (const b of encodeURIComponent(c).match(/%[0-9A-F]{2}|[^%]/g)) bytes.push(b.length === 3 ? parseInt(b.slice(1), 16) : b.charCodeAt(0))
      continue
    }
    const e = body[++k]
    if (e != null && /[0-7]/.test(e) && /^[0-7]{3}$/.test(body.slice(k, k + 3))) { bytes.push(parseInt(body.slice(k, k + 3), 8)); k += 2 }
    else if (e != null && Object.prototype.hasOwnProperty.call(C_ESCAPES, e)) bytes.push(C_ESCAPES[e])
    else return null
  }
  return decodeURIComponent(bytes.map((b) => `%${b.toString(16).padStart(2, '0')}`).join(''))
}

/** 新規行から回収の add コマンドを組み立てる（並べるパスが無ければ null = add しない）。 */
export function leftoverAddCommand(newLines) {
  const paths = newLines
    .filter((l) => l[1] !== ' ' && !/[RC]/.test(l.slice(0, 2)))
    .map((l) => { try { return unquotePorcelainPath(l.slice(3)) } catch { return null } })
    .filter((p) => p != null && p !== '' && !p.endsWith('/') && !/[\x00-\x1f\x7f\x60]/.test(p))
  if (paths.length === 0) return null
  return `git --literal-pathspecs add --ignore-removal -- ${paths.map(shellQuote).join(' ')}`
}

/**
 * status の生の出力・exit code・基準線から判定する。
 * baseline: fix の前の porcelain 行（null = 基準線なし。全 porcelain 行を新規行として扱う）。
 * mismatch: workflow が保持した digest と基準線ファイルが一致しない（ファイルが無い・書き換えられた）。基準線を null と
 *   して扱い、dirty にする（fix の後に基準線を書き換えられた round は回収も clean 扱いもしない）。
 * 回収（add・commit・push）は基準線があり、基準線に stage 済みの行（1 文字目が空白・`?`・`!` 以外）が無いときだけ:
 * 基準線が無ければ add は fix の前からある未追跡ファイルも新規行として stage し、stage 済みの行があれば commit が index ごと
 * fix の前からある変更を PR に入れる。
 *
 * @returns {{exit_code: number, baseline: 'ok'|'none'|'mismatch', dirty: boolean, new_lines: string[], recoverable: boolean, add_command: string|null}}
 */
export function porcelainVerdict({ output, exitCode, baseline = null, mismatch = false }) {
  const lines = porcelainLines(output)
  const base = mismatch ? null : baseline
  const known = base == null ? null : new Set(base)
  const newLines = known == null ? lines : lines.filter((l) => !known.has(l))
  const ok = exitCode === 0
  const recoverable = ok && base != null && base.every((l) => l[0] === ' ' || l[0] === '?' || l[0] === '!')
  return {
    exit_code: exitCode,
    baseline: mismatch ? 'mismatch' : base == null ? 'none' : 'ok',
    dirty: !ok || mismatch || newLines.length > 0,
    new_lines: newLines,
    recoverable,
    add_command: recoverable ? leftoverAddCommand(newLines) : null,
  }
}
