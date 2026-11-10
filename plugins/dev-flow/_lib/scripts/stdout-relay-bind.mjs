// stdout-relay-bind.mjs - CI 判定の中継（dev-flow:stdout-relay）の Bash と返り値を、その spawn の transcript にある
// workflow の prompt と実 stdout に縛る判定。hooks/pretool-stdout-relay-guard.sh が PreToolUse の入力を stdin に渡して呼ぶ。
//
// 中継は PR の worktree を cwd に起動するので、PR が変えた CLAUDE.md 等を指示として受け取り得る。check-ci の stdout を写す
// 中継が誘導されて件数ごと整った status:'passed' を返しても、workflow の事後の検査では止められないので、workflow が書いた
// prompt と harness が記録した実行結果を正にする:
//   - Bash: command が prompt（computed task の枠の後）の最終行（harness の 2 字下げを外したもの）と完全に一致し、
//     その行の先頭トークンが check-ci のときだけ通す
//   - StructuredOutput: 値が、直前にそのコマンドを実行した Bash の実 stdout の JSON か、prompt が定める失敗時の JSON
//     （_lib/ci-check.mjs の CI_RELAY_FAILED / CI_WAIT_RELAY_FAILED。Bash を実行していなくてよい）と一致するときだけ通す
// 判定の方式（枠の後の最終行・tool_result の stdout・固定の失敗時の JSON）は security の中継の bind
// （security-relay-bind.mjs）と同じ。transcript の読み取りは共有しない — CI の変更で security の gate を外せる中継の判定を
// 動かさないため。
// prompt と stdout は harness が書く subagent の transcript（`<transcript_path から .jsonl を除いたもの>/subagents/` 配下の
// `agent-<agent_id>.jsonl`）から読む。transcript は Claude Code の設定ディレクトリの下にあり、sandbox の中の中継や PR のプロセスからは
// 書けない（hook 用に別の記録を書かない — 書いた場所が sandbox から書けるなら、そこが偽造の入口になる）。
// transcript・prompt が見つからない・枠の形が想定と違う・コマンド行が取れない・行が JSON でないときは deny（fail-closed）。
// 分類: incentive-structural（中継が PR の文を読める限り誘導を否定できない。sunset しない）。
//
// stdin: PreToolUse の入力 JSON（tool_name・tool_input・transcript_path・agent_id）
// stdout: JSON 1 行 {allow: true} / {allow: false, reason}。reason は固定の文で、入力由来の文字列を含めない
//   （中継の session に入力由来の文字列を返さない）。exit 0。想定外で落ちたときは呼び出し側が deny にする。
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { CI_RELAY_FAILED, CI_WAIT_RELAY_FAILED } from '../ci-check.mjs'

// harness が workflow の prompt を載せる枠（この行の後に prompt の各行を 2 字下げして続ける）
const FRAME_HEAD = '[Workflow harness — computed task] '
const FRAME_TAIL = 'The computed task text follows:'
const INDENT = '  '
// subagents/ 配下で transcript を探す深さ（実測は subagents/workflows/<runId>/agent-<id>.jsonl）
const MAX_DEPTH = 4

const decide = (allow, reason = null) => {
  process.stdout.write(`${JSON.stringify(allow ? { allow: true } : { allow: false, reason })}\n`)
  process.exit(0)
}
const deny = (reason) => decide(false, reason)

// 枠の行（行頭が FRAME_HEAD）を含む最初の type:"user" 行（content が文字列）の、枠の後の最終行（2 字下げを外したもの）。
// harness はその前に user request の枠の行（依頼文は 2 字下げなので行頭に FRAME_HEAD は来ない）を置くことがあるので、
// 最初の user 行とは限らない
function promptCommand(entries) {
  const first = entries.find((e) => e?.type === 'user' && typeof e?.message?.content === 'string'
    && e.message.content.split('\n').some((l) => l.startsWith(FRAME_HEAD)))
  if (first == null) return { error: 'transcript に workflow の prompt が無い' }
  const lines = first.message.content.split('\n')
  const frames = lines.flatMap((l, i) => (l.startsWith(FRAME_HEAD) ? [i] : []))
  if (frames.length !== 1 || !lines[frames[0]].endsWith(FRAME_TAIL)) return { error: 'workflow の prompt の枠が想定の形でない' }
  const body = lines.slice(frames[0] + 1)
  if (body.length === 0 || !body.every((l) => l.startsWith(INDENT))) return { error: 'workflow の prompt の枠が想定の形でない' }
  const command = body[body.length - 1].slice(INDENT.length)
  if (command === '' || /^\s/.test(command)) return { error: 'workflow の prompt からコマンド行を取れない' }
  return { command }
}

// prompt のコマンドが定める失敗時の JSON（check-ci 以外は null）。--wait は checkCiCommand が末尾に置く
function failedOutputOf(command) {
  if (!command.startsWith('check-ci ')) return null
  return / --wait [0-9]+$/.test(command) ? CI_WAIT_RELAY_FAILED : CI_RELAY_FAILED
}

// command を実行した最後の Bash の実 stdout の 1 行目の JSON object（実行していない・失敗した・JSON でなければ null）。
// tool_result の本文は stdout の後に stderr が続くので、1 行目だけを stdout として読む（check-ci は JSON 1 行を stdout に出す）
function stdoutJsonOf(entries, command) {
  let id = null
  for (const e of entries) {
    if (e?.type !== 'assistant' || !Array.isArray(e?.message?.content)) continue
    for (const c of e.message.content) {
      if (c?.type === 'tool_use' && c.name === 'Bash' && c.input?.command === command && typeof c.id === 'string') id = c.id
    }
  }
  if (id == null) return null
  let result = null
  for (const e of entries) {
    if (e?.type !== 'user' || !Array.isArray(e?.message?.content)) continue
    for (const c of e.message.content) {
      if (c?.type === 'tool_result' && c.tool_use_id === id) result = c
    }
  }
  if (result == null || result.is_error === true) return null
  const text = typeof result.content === 'string' ? result.content
    : Array.isArray(result.content) ? result.content.filter((x) => x?.type === 'text' && typeof x.text === 'string').map((x) => x.text).join('\n')
    : null
  if (text == null) return null
  try {
    const v = JSON.parse(text.split('\n')[0])
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null
  } catch {
    return null
  }
}

// key の順に依らない JSON の一致
const canonical = (v) => (Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
  : v !== null && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
  : JSON.stringify(v))
const sameJson = (a, b) => canonical(a) === canonical(b)

// <root> の配下（symlink はたどらない）で name のファイルを探す
function findFiles(root, name, depth = 0) {
  let dirents
  try {
    dirents = readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  return dirents.flatMap((d) => {
    if (d.isFile() && d.name === name) return [join(root, d.name)]
    if (d.isDirectory() && depth < MAX_DEPTH) return findFiles(join(root, d.name), name, depth + 1)
    return []
  })
}

let input
try {
  input = JSON.parse(readFileSync(0, 'utf8'))
} catch {
  deny('hook の入力を読めない')
}
const tool = input?.tool_name
const tp = input?.transcript_path
const agentId = input?.agent_id
if (tool !== 'Bash' && tool !== 'StructuredOutput') deny('stdout-relay は Bash と返り値の他の tool を使えない')
if (typeof tp !== 'string' || !tp.startsWith('/') || !tp.endsWith('.jsonl')) deny('transcript の場所が分からない')
if (typeof agentId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(agentId)) deny('transcript の場所が分からない')

const found = findFiles(join(tp.slice(0, -'.jsonl'.length), 'subagents'), `agent-${agentId}.jsonl`)
if (found.length !== 1) deny('中継の transcript が見つからない')
let entries
try {
  entries = readFileSync(found[0], 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l))
} catch {
  deny('中継の transcript を読めない')
}

const prompt = promptCommand(entries)
if (prompt.error) deny(prompt.error)
const failed = failedOutputOf(prompt.command)
if (failed == null) deny('workflow の prompt のコマンドが check-ci でない')

if (tool === 'Bash') {
  // 一致するコマンドでも sandbox の外では実行させない（PR の指示を受けた中継が sandbox を外せてしまう）
  if (input?.tool_input?.dangerouslyDisableSandbox === true) deny('stdout-relay は sandbox の外でコマンドを実行しない')
  if (input?.tool_input?.command === prompt.command) decide(true)
  deny('stdout-relay は workflow の prompt の最終行のコマンドを一字一句そのまま実行する')
}

const output = input?.tool_input
const allowed = [failed]
const stdout = stdoutJsonOf(entries, prompt.command)
if (stdout != null) allowed.push(stdout)
if (allowed.some((a) => sameJson(a, output))) decide(true)
deny('stdout-relay の返り値は、実行したコマンドの stdout の JSON か prompt が定める失敗時の JSON に限る')
