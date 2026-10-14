// Pure parts of mosh-paste: parsing a paste, naming the local copy, building the
// fetch command and splicing the result. Every `$` call lives in register.ts.

// Files worth fetching: what a screenshot or a dragged attachment is. Plain
// paths in pasted logs never trigger an ssh round-trip.
const EXT = /\.(png|jpe?g|gif|webp|heic|tiff?|pdf)$/i

// Only ASCII blanks separate words: macOS puts U+202F inside screenshot names
// ("10.23.45 PM") and terminals do not escape it.
const SEP = /[ \t\r\n]/

export type Word = { start: number; end: number; value: string }

export type Fetched = { word: Word; dest: string; error?: string }

export type Rewrite = {
  text: string
  fetched: string[]
  failed: { path: string; reason: string }[]
}

// Splits pasted text into shell words the way a terminal quotes a dropped
// file: `\ ` escapes, '...' and "..." quoting.
export function words(text: string): Word[] {
  const out: Word[] = []
  let i = 0
  while (i < text.length) {
    while (i < text.length && SEP.test(text[i])) i++
    if (i >= text.length) break
    const start = i
    let value = ''
    let quote: string | null = null
    while (i < text.length) {
      const c = text[i]
      if (quote !== null) {
        if (c === quote) {
          quote = null
        } else if (c === '\\' && quote === '"' && i + 1 < text.length) {
          value += text[++i]
        } else {
          value += c
        }
        i++
        continue
      }
      if (SEP.test(c)) break
      if (c === "'" || c === '"') {
        quote = c
      } else if (c === '\\' && i + 1 < text.length) {
        value += text[++i]
      } else {
        value += c
      }
      i++
    }
    out.push({ start, end: i, value })
  }
  return out
}

// Absolute paths to fetchable files; whether each exists here is the caller's check.
export function candidates(text: string): Word[] {
  return words(text).filter(w => w.value.startsWith('/') && EXT.test(w.value))
}

export function localPath(dir: string, remote: string): string {
  const base = remote.slice(remote.lastIndexOf('/') + 1)
  return `${dir}/${base.replace(/[\s\u202f\u00a0]+/g, '_')}`
}

// The terminal's own spelling of a path, so the rewritten paste reads like a drop.
export function escapePath(path: string): string {
  return path.replace(/([ \t'"\\()&;|<>$`!*?[\]{}#~])/g, '\\$1')
}

// Quoted for the client Mac's login shell, which runs ssh's remote command.
function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`
}

// The copy directory must be this user's own real directory: in a shared or
// pre-created one another user could plant a symlink that the write follows.
// Writing to a mktemp file and renaming it never follows a name in the way.
const FETCH = [
  'umask 077; d="$(dirname "$3")";',
  '{ mkdir -p "$d" && [ -d "$d" ] && [ ! -L "$d" ] && [ -O "$d" ]; } || { echo "mosh-paste: $d is not a directory owned by this user" >&2; exit 1; };',
  't="$(mktemp "$d/.part.XXXXXX")" || exit 1;',
  'if ssh -i "$4" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=5 "$1" "cat -- $2" > "$t"; then mv -f "$t" "$3"; else rm -f "$t"; exit 1; fi',
].join(' ')

// The mod's own key, so nothing in ~/.ssh/config is needed: IdentitiesOnly
// keeps ssh from offering every other key first and hitting the server's
// MaxAuthTries ("Too many authentication failures").
export function keyPath(home: string): string {
  return `${home}/.ssh/mosh-paste_ed25519`
}

// BatchMode: a password prompt would hang the paste, so key auth or nothing.
export function fetchArgv(host: string, remote: string, dest: string, key: string): string[] {
  return ['/bin/sh', '-c', FETCH, 'mosh-paste', host, shellQuote(remote), dest, key]
}

export function checkArgv(host: string, key: string): string[] {
  return ['ssh', '-i', key, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', host, 'true']
}

// ~/.ssh is made private first: ssh-keygen does not create its directory.
export function keygenArgv(key: string): string[] {
  const dir = key.slice(0, key.lastIndexOf('/'))
  return ['/bin/sh', '-c', 'umask 077; mkdir -p "$1" && ssh-keygen -q -t ed25519 -N "" -C mosh-paste -f "$2"', 'mosh-paste', dir, key]
}

// What /mosh-paste-setup tells the person when the check fails: the one
// command that needs their password (and the first host key prompt).
export function setupHint(host: string, key: string, reason: string): string {
  return [
    `mosh-paste: ${host} に鍵で入れなかった (${reason})`,
    '',
    '手元の Mac の「リモートログイン」をオンにしてから、このマシンの端末で次を 1 回実行し、',
    `終わったらもう一度 /mosh-paste-setup を実行する（手元の Mac のログインパスワードを聞かれる）:`,
    '',
    `  ssh-copy-id -o IdentitiesOnly=yes -i ${key}.pub ${host}`,
  ].join('\n')
}

// undefined on success, else the last stderr line (ssh's own reason).
export function failure(r: { exitCode: number; stderr: string }): string | undefined {
  if (r.exitCode === 0) return undefined
  return r.stderr.trim().split('\n').at(-1) || `exit ${r.exitCode}`
}

export function splice(text: string, results: readonly Fetched[]): Rewrite {
  const rewrite: Rewrite = { text, fetched: [], failed: [] }
  // From the end, so the earlier words' offsets still hold.
  for (const { word, dest, error } of [...results].sort((a, b) => b.word.start - a.word.start)) {
    if (error !== undefined) {
      rewrite.failed.unshift({ path: word.value, reason: error })
      continue
    }
    rewrite.text = rewrite.text.slice(0, word.start) + escapePath(dest) + rewrite.text.slice(word.end)
    rewrite.fetched.unshift(dest)
  }
  return rewrite
}
