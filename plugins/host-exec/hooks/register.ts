import type { Register } from 'claude-code'

import type { HostExecApproved } from '../types'

// ─────────────────────────────────────────────────────────────
// host-exec
// sandbox で動かないコマンドを、Claude が人間に「これ実行して」と
// 頼む代わりに呼べるツール `mcp__host-exec__run` を追加する。
// 続くコマンドは `steps` で 1 回の承認にまとめ、順に実行して失敗したところで止める。
//
//   ゲート1: 拒否パターン（静的チェック。全ステップ）
//   ゲート2: 実行承認（ダイアログ）。人間が「このセッションでは同じコマンドを聞かない」を
//            選んだものだけ、実行ファイル実パス・argv・cwd 実パスが完全に同じ呼び出しを
//            そのセッションでは聞き直さない。警告が出るコマンドは記憶しない（プロジェクト外の cwd の警告だけなら記憶する）
//   ゲート3: 出力の機密チェック → 引っかかったら Claude に渡す前に停止（記憶済みでも毎回）
// sandbox.excludedCommands に一致して Bash でも sandbox の外で動くコマンドは、承認を取らずに
// Bash へ回す（一致すると確実に言える形だけを拾い、それ以外は今まで通りダイアログを出す）。
// 起動元がホストの環境変数 HOST_EXEC_ENV で渡した変更（sandbox 用に Claude 本体へ入れた proxy などを
// 外す・上書きする）を、host-exec で動かすコマンドにだけ掛ける。
//
// 比べる相手は sandbox ではなく「人間がコピペして実行する」運用。実行ファイルを
// 許可リストで絞らないのは、コピペでも動くものを止めると結局コピペに戻るから。
// その代わり、承認が人間の判断として成り立つように
//   - 実行されるもの（解決した実行ファイル・argv・cwd）をエスケープして正確に見せる
//   - Claude が書き換えられるコードを動かす兆候があれば、止めずに警告を添える
// どのゲートも「判断できない・答えがない」ときは渡さない側に倒す（fail closed）。
// ─────────────────────────────────────────────────────────────

/**
 * 渡されたファイルやモジュールの中身を実行するインタプリタと、そのインライン実行フラグ。
 * インライン実行は argv に見えるので警告しない。同じ文字でも意味はインタプリタごとに違う
 * （bash の -e は errexit、perl の -p はループ）ので、インタプリタ単位で持つ。
 */
const NODE_INLINE = ['-e', '-p', '--eval', '--print']
const SHELL_INLINE = ['-c']
const INLINE_CODE_FLAGS = new Map<string, ReadonlySet<string>>([
  ...(['node', 'deno', 'bun', 'tsx', 'ts-node'].map(b => [b, new Set(NODE_INLINE)] as const)),
  ['python', new Set(['-c'])],
  ['python3', new Set(['-c'])],
  ['ruby', new Set(['-e', '-E'])],
  ['perl', new Set(['-e', '-E'])],
  ['php', new Set(['-r'])],
  ...(['bash', 'sh', 'zsh', 'fish'].map(b => [b, new Set(SHELL_INLINE)] as const)),
])

/** npm で package.json のスクリプトや依存の install スクリプトを動かすサブコマンド。 */
const NPM_SCRIPT_SUBCOMMANDS = new Set([
  'run', 'run-script', 'rum', 'urn', 'test', 't', 'tst', 'start', 'restart', 'stop',
  'install', 'i', 'in', 'add', 'ci', 'install-test', 'it', 'rebuild', 'rb', 'exec', 'x', 'create', 'init',
])
/** pnpm / yarn / bun は未知のサブコマンドをスクリプト名として実行するので、スクリプトを動かさないものを列挙する。 */
const PM_NO_SCRIPT_SUBCOMMANDS = new Set([
  'list', 'ls', 'll', 'outdated', 'why', 'view', 'info', 'config', 'audit', 'licenses',
  'store', 'whoami', 'root', 'bin', 'help', 'pm', 'cache', 'search', 'publish', 'pack',
  'login', 'logout', 'version', '--version', '-v', '--help', '-h',
])
/** レシピファイルの中身を実行するタスクランナー。 */
const TASK_RUNNERS: Readonly<Record<string, string>> = {
  make: 'Makefile', just: 'justfile', task: 'Taskfile',
}

/** 実行前に拒否するもの（argv を空白で連結した文字列に当てる）。正当な用途がほぼ無いものだけを置く。 */
const DENY_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/i, '再帰的な強制削除'],
  [/\bgit\s+push\b.*(\s--force\b|\s-f\b|\s--force-with-lease\b)/, 'force push'],
  [/\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f)/, '作業ツリーの破棄'],
  [/\bprisma\s+(migrate\s+reset|db\s+push\b.*--force-reset)/, 'DB のリセット'],
  [/\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA)\b/i, '破壊的 SQL'],
  [/\bgcloud\b.*\s(delete|remove-iam-policy-binding)\b/, 'GCP リソースの削除'],
  [/\bdocker\s+(system|volume|image)\s+prune\b/, 'Docker の一括削除'],
  // 実行するとほぼ確実に秘密情報を出力するもの
  [/\bgcloud\s+auth\s+(print-access-token|print-identity-token|application-default\s+print-access-token)\b/, 'アクセストークンの出力'],
  [/\bgcloud\s+secrets\s+versions\s+access\b/, 'Secret Manager の値の出力'],
  [/\bgcloud\s+iam\s+service-accounts\s+keys\s+create\b/, 'サービスアカウント鍵の発行'],
  [/\bgh\s+auth\s+token\b/, 'GitHub トークンの出力'],
  [/\bgh\s+auth\s+status\b.*\s(--show-token|-t)\b/, 'GitHub トークンの出力'],
  [/\bcurl\b.*\s(-d|--data|--data-binary|-F|--form|-T|--upload-file)\b/, 'curl でのデータ送信'],
]

/** 出力に含まれていたら Claude に渡す前に止める秘密情報のパターン。 */
const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '秘密鍵'],
  [/"private_key(_id)?"\s*:\s*"[^"]+"/g, 'サービスアカウント鍵 (JSON)'],
  [/\bya29\.[0-9A-Za-z_-]{20,}/g, 'Google OAuth アクセストークン'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, 'Google API キー'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AWS アクセスキー'],
  [/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}/g, 'GitHub トークン'],
  [/\bsk-(ant-)?[A-Za-z0-9_-]{20,}/g, 'API キー (sk-)'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, 'Slack トークン'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, 'JWT'],
  [/\b(postgres(ql)?|mysql|mongodb(\+srv)?|redis|amqp):\/\/[^:\s/@]+:[^@\s]+@/gi, 'パスワード入り接続文字列'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g, 'Bearer トークン'],
  [/\b[A-Z0-9_]*(PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|PRIVATE_KEY)[A-Z0-9_]*\s*[=:]\s*["']?[^\s"']{6,}/g, '秘密っぽい環境変数'],
]

/**
 * Bash の失敗が sandbox に拒否されたものだと分かる印。Claude Code の system prompt は
 * 「ユーザーに `!` で実行してもらう」を常に勧めるので、この失敗のときだけ host-exec を思い出させる。
 */
const SANDBOX_DENIAL_MARKERS = ['Operation not permitted', 'sandbox_violations', 'EPERM']
const SANDBOX_HINT =
  'This Bash failure comes from the sandbox. Before asking the user to run the command themselves with `!`, ' +
  'run it with the mcp__host-exec__run tool (it runs outside the sandbox after the user approves).'

/**
 * worktree に隔離された session で、Claude Code の組み込みガードが Bash を実行前に拒否したときの文面の印。
 * sandbox の拒否ではないので、sandbox の外で動かしても意味がない。拒否されるのは書き方なので、書き直しを促す。
 */
const WORKTREE_GUARD_MARKER = 'This session is isolated in the worktree'
const WORKTREE_GUARD_HINT =
  'This Bash command was refused by the worktree-isolation guard before it ran, not by the sandbox, ' +
  'so running it outside the sandbox does not help: do not use mcp__host-exec__run for it. ' +
  'Rewrite it in a form the guard can verify: one plain command per call, absolute paths instead of cd, ' +
  'variables in double quotes, no $(…). To read files, use the Read / Grep tools; for longer logic, ' +
  'write a script under $TMPDIR and run that.'

// host-exec の失敗のあと、Claude が同じ呼び出しを繰り返して承認ダイアログを出し直さないよう、結果に添える次の手。
// 判定には使わず、stdout / stderr / exit code の中身も書き換えない（結果の後ろに足すだけ）。

/** $.process.run は時間切れのとき `aborted: still running after <ms>ms` で reject する（起動失敗・中断は別の文面） */
const TIMEOUT_MARKER = 'still running after'
const timeoutHint = (sec: number) =>
  `host-exec: the command timed out at timeoutSec ${sec}. Re-running it with the same timeoutSec will time out the same way: ` +
  `raise timeoutSec (max ${MAX_TIMEOUT_SEC}), or, for a command that does not exit on its own (a server, a watcher, a recorder), ` +
  'use another way instead of mcp__host-exec__run.'
/** macOS キーチェーンに対話なしで届かないときの印。host-exec の子プロセスからは何度やっても届かない */
const KEYCHAIN_DENIAL_MARKERS = ['-25308', 'errSecInteractionNotAllowed', 'User interaction is not allowed']
const KEYCHAIN_HINT =
  'host-exec: the macOS keychain is not reachable from this session (-25308 errSecInteractionNotAllowed), ' +
  'so do not re-run this with mcp__host-exec__run: ask the user to run the command themselves with `!`.'

/** コマンド文字列を引数で受け取って実行するシェル。host-exec はシェルを通さないので、-c は渡させない。 */
const SHELLS = new Set(['bash', 'sh', 'zsh', 'fish', 'dash', 'ksh'])

/** argv がシェルの -c（-lc / -ec のように束ねたものを含む）でコマンド文字列を渡しているか。スクリプト名より後ろの -c はスクリプトへの引数なので数えない。 */
function isShellInline(argv: readonly string[]): boolean {
  if (!SHELLS.has(basename(argv[0] ?? ''))) return false
  const rest = argv.slice(1)
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!
    if (a === '--' || !/^[-+]/.test(a)) return false
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(a)) return true
    // 値を取るオプション（-o pipefail / -euo pipefail / +O extglob / --rcfile f）は次の引数を値として読み飛ばす
    if (/^[-+][A-Za-z]*[oO][A-Za-z]*$/.test(a) || a === '--rcfile' || a === '--init-file') i++
  }
  return false
}

const MAX_TIMEOUT_SEC = 600
const DECLINE = '拒否'
const RUN = '実行する'
const RUN_REMEMBER = '実行して、このセッションでは同じコマンドを聞かない'
const PASS_MASKED = 'マスクして渡す'
const WITHHOLD = '渡さない'
const PASS_RAW = 'そのまま渡す'

/** 承認時に記憶したコマンド（キー → 実行した回数）。session スコープなので次のセッションでは聞き直す。 */
const APPROVED = { plugin: 'host-exec', key: 'approved' } as const

type Finding = { kind: string; count: number }

function scan(text: string): Finding[] {
  const found: Finding[] = []
  for (const [re, kind] of SECRET_PATTERNS) {
    const n = (text.match(new RegExp(re.source, re.flags)) ?? []).length
    if (n > 0) found.push({ kind, count: n })
  }
  return found
}

function mask(text: string): string {
  let out = text
  for (const [re, kind] of SECRET_PATTERNS) {
    out = out.replace(new RegExp(re.source, re.flags), `[REDACTED: ${kind}]`)
  }
  return out
}

function basename(p: string): string {
  return p.split('/').pop() ?? p
}

/** 改行・制御文字・不可視文字・双方向制御をエスケープして、ダイアログで見えたとおりに読めるようにする。 */
function visible(s: string): string {
  return JSON.stringify(s).replace(
    /[\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g,
    c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
}

function isUnder(path: string, dirs: readonly string[]): boolean {
  return dirs.some(d => path === d || path.startsWith(d.endsWith('/') ? d : `${d}/`))
}

function joinPath(base: string, p: string): string {
  return p.startsWith('/') ? p : `${base.replace(/\/+$/, '')}/${p}`
}

type Stat = { kind: string; realPath?: string }

/** 引数をシェルで打つ形で見せる。空白・引用符・制御文字などを含む引数だけ "…" で囲んでエスケープするので、区切りは誤読できない。 */
function shellish(arg: string): string {
  return /^[A-Za-z0-9_./:=@%+,-]+$/.test(arg) ? arg : visible(arg)
}

const REASON_MAX = 200

/** Claude の説明を 1 行に収める。空白の連続は 1 つに畳み、長すぎれば切り詰める（空白で詰めた偽の「$ …」を折り返しでコマンド行に見せたり、長文で本物の $ 行を表示域外へ押し出したりさせない）。 */
function shownReason(reason: string): string {
  const s = visible(reason).slice(1, -1).replace(/\s+/g, ' ').trim()
  const chars = [...s]
  return chars.length > REASON_MAX ? `${chars.slice(0, REASON_MAX).join('')}…` : s
}

function shownCommand(argv: readonly string[]): string {
  return argv.map(shellish).join(' ')
}

const OUTSIDE_CWD = 'プロジェクトの外で実行します。この場所で実行してよいか確認してください'

const NOT_SHOWN = 'この画面には中身が出ないので、確認していなければ「拒否」して内容を見せてもらってください'

/** argv（[0] を除く）から、この画面に中身が出ないコードを実行する兆候を拾い、何が起きるかとどうすればいいかを返す。 */
function codeRunWarnings(bin: string, args: readonly string[]): string[] {
  const positional = args.filter(a => !a.startsWith('-'))
  const sub = positional[0]
  const inlineFlags = INLINE_CODE_FLAGS.get(bin)
  if (inlineFlags) {
    for (let i = 0; i < args.length; i++) {
      const a = args[i] ?? ''
      if (inlineFlags.has(a)) return []
      if (a === '-m') return [`モジュール ${shellish(args[i + 1] ?? '')} の中身が実行されます。${NOT_SHOWN}`]
      if (!a.startsWith('-')) return [`${shellish(a)} の中身が実行されます。${NOT_SHOWN}`]
    }
    return []
  }
  const fetchAndRun = 'npm レジストリからパッケージを取得して、そのコードを実行します。名前が意図したパッケージか確認してください'
  const pkgScripts = `package.json の scripts や、依存パッケージの install スクリプトが実行されます。${NOT_SHOWN}`
  if (bin === 'npx' || bin === 'bunx' || bin === 'pnpx') return [fetchAndRun]
  if (bin === 'npm' && sub !== undefined && NPM_SCRIPT_SUBCOMMANDS.has(sub)) return [pkgScripts]
  if ((bin === 'pnpm' || bin === 'yarn' || bin === 'bun') && !(sub !== undefined && PM_NO_SCRIPT_SUBCOMMANDS.has(sub))) {
    return [bin === 'pnpm' && sub === 'dlx' ? fetchAndRun : pkgScripts]
  }
  const recipe = TASK_RUNNERS[bin]
  if (recipe) return [`${recipe} に書かれたコマンドが実行されます。${NOT_SHOWN}`]
  if (bin === 'cargo' && sub !== undefined && ['run', 'build', 'b', 'test', 't', 'bench', 'install', 'check', 'c'].includes(sub)) {
    return ['build.rs など、ビルド時に動くコードが実行されます（依存クレートの build.rs も含みます）']
  }
  if (bin === 'go' && sub !== undefined && ['run', 'generate', 'test'].includes(sub)) {
    return ['repo の Go コード（go:generate の指示を含む）が実行されます']
  }
  return []
}

/**
 * sandbox.excludedCommands の 1 エントリを、argv を空白で連結した文字列に当てる正規表現にする。
 * Claude Code 本体の一致規則と同じかは確かめていないので、確実に一致すると言える形だけを拾う:
 * 先頭の `~/` `$HOME/` は HOME に展開、末尾 ` *` は前方一致、`*` を含まなければ完全一致、
 * パスの 1 階層まるごとの `*`（1 階層）と `**`（複数階層）だけを glob として読む。
 * それ以外（`codex:*` など）は undefined で一致させない。一致しなければダイアログが出るだけなので安全側。
 */
function excludedPattern(entry: string, home: string | undefined): RegExp | undefined {
  let e = entry
  if (e.startsWith('~/') || e.startsWith('$HOME/')) {
    if (!home) return undefined
    e = `${home.replace(/\/+$/, '')}/${e.slice(e.indexOf('/') + 1)}`
  }
  const isPrefix = e.endsWith(' *')
  const parts = (isPrefix ? e.slice(0, -1) : e).split(/(\*+)/)
  let src = ''
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? ''
    if (i % 2 === 0) {
      src += part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      continue
    }
    const after = parts[i + 1] ?? ''
    if (part.length > 2 || !(parts[i - 1] ?? '').endsWith('/') || !/^(|[/ ].*)$/s.test(after)) return undefined
    src += part === '**' ? '\\S+' : '[^/\\s]+'
  }
  return new RegExp(`^${src}${isPrefix ? '' : '$'}`)
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
/** $.process.run の init.env は上書きしかできないので、外す変数は env -u で子プロセスに渡る前に取り除く */
const ENV_BIN = '/usr/bin/env'

/** HOST_EXEC_ENV から読んだ、host-exec のコマンドに掛ける環境の変更 */
type EnvChange = { unset: string[]; set: Array<[string, string]> }

/**
 * HOST_EXEC_ENV（`{"<名前>": null | "<値>"}`）を読む。null の名前は外し、文字列の名前はその値に上書きする。
 * 読めなければ、何が不正かを返す（呼び出し側は何も実行せずに拒否する）。
 */
function parseEnvChange(raw: string): EnvChange | string {
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return 'not valid JSON'
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return 'not a JSON object'
  const change: EnvChange = { unset: [], set: [] }
  for (const [name, value] of Object.entries(v)) {
    if (!ENV_NAME.test(name)) return `${visible(name)} is not a valid environment variable name`
    if (value === null) change.unset.push(name)
    else if (typeof value === 'string') change.set.push([name, value])
    else return `the value of ${name} is neither null nor a string`
  }
  return change
}

function format(argv: readonly string[], r: { exitCode: number; stdout: string; stderr: string }): string {
  return [
    `$ ${shownCommand(argv)}`,
    `exit code: ${r.exitCode}`,
    '--- stdout ---',
    r.stdout || '(empty)',
    '--- stderr ---',
    r.stderr || '(empty)',
  ].join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'run',
      description: [
        'Run a command on the user\'s host machine, OUTSIDE the sandbox, after the user approves it.',
        'Use this instead of asking the user to run a command themselves and paste the output back,',
        'whenever a command fails or cannot run because of the sandbox (network, gcloud/docker auth, sockets, etc.).',
        'Pass a command as an argument vector `argv` (no shell: no pipes, redirects, globs, && or env-var expansion),',
        'or several as `steps` (one argv each): they run in order after one approval and stop at the first that fails.',
        'When commands follow one another (check → act → check), plan them first and pass them together as one `steps` call, so one approval covers them all.',
        'argv[0] is resolved on the user\'s PATH and shown to the user with the full argv and cwd before anything runs.',
        'Destructive commands, commands that print credentials, and shell -c (bash -c "…") are refused.',
        'Do not use it to read files or transcripts: those are readable inside the sandbox with the Read / Grep tools.',
        'Commands that the Bash tool already runs outside the sandbox (sandbox.excludedCommands) are refused: run them with Bash.',
        'If the output contains secrets, the user may mask or withhold it; do not try to obtain the secret another way.',
        `Long-running commands (builds, docker, recording, etc.) need timeoutSec from the first call: the default is 30s, max ${MAX_TIMEOUT_SEC}.`,
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          argv: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'One command, e.g. ["gcloud","run","services","list","--region","asia-northeast1"]. Pass either argv or steps' },
          steps: {
            type: 'array',
            items: { type: 'array', items: { type: 'string' }, minItems: 1 },
            minItems: 1,
            description: 'Several commands run in order, e.g. [["gh","pr","view","1"],["gh","pr","merge","1"]]. Pass either argv or steps',
          },
          cwd: { type: 'string', description: 'Working directory; defaults to the session\'s' },
          reason: { type: 'string', description: 'One sentence, in Japanese, on what this is run for' },
          timeoutSec: { type: 'number', description: `Per step. Default 30, max ${MAX_TIMEOUT_SEC}` },
        },
        required: ['reason'],
      },
      // deferred だと ToolSearch で読み込むまで description（人間に頼む代わりに使え）が見えない
      isDeferred: false,
    })
    return next(e)
  })

  on('tool.call', { tool: 'mcp__host-exec__run' }, async ($, e) => {
    const input = e as unknown as { argv?: unknown; steps?: unknown; cwd?: unknown; reason?: unknown; timeoutSec?: unknown }
    if ((input.argv == null) === (input.steps == null)) {
      return { deny: 'host-exec: pass exactly one of argv (one command) or steps (several commands).' }
    }
    const toArgv = (a: unknown) => (Array.isArray(a) ? a.map(String) : [])
    const steps = input.argv != null ? [toArgv(input.argv)] : Array.isArray(input.steps) ? input.steps.map(toArgv) : []
    if (steps.length === 0 || steps.some(s => s.length === 0)) {
      return { deny: 'host-exec: argv must be a non-empty array of strings, and steps a non-empty array of such argv.' }
    }
    const isMulti = steps.length > 1
    /** 拒否理由でどのステップかを示す（1 つだけなら付けない） */
    const at = (i: number) => (isMulti ? ` at step ${i + 1}` : '')
    const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : undefined
    const reason = typeof input.reason === 'string' ? input.reason : '(理由なし)'
    const timeoutSec = Math.min(
      Math.max(typeof input.timeoutSec === 'number' ? input.timeoutSec : 30, 1),
      MAX_TIMEOUT_SEC,
    )

    // ── ゲート1: 静的チェック（1 つでも当たれば何も実行しない） ──
    for (const [i, argv] of steps.entries()) {
      const line = argv.join(' ')
      for (const [re, why] of DENY_PATTERNS) {
        if (re.test(line)) {
          return { deny: `host-exec: refused (${why})${at(i)}. Nothing was run. Do not retry this command another way; explain to the user what you wanted to do and let them decide.` }
        }
      }
      if (isShellInline(argv)) {
        return {
          deny:
            `host-exec: refused (shell -c: host-exec does not run a shell)${at(i)}. Nothing was run. ` +
            'Do pipes, redirects and variables with the Bash tool inside the sandbox; to read files, use the Read / Grep tools. ' +
            'Pass only a command that cannot run inside the sandbox, as argv (or steps for several), one command each.',
        }
      }
    }

    // ── Bash でも sandbox の外で動くものは承認を取らずに Bash へ回す ──
    const home = await $.env.get('HOME')
    const settings = await $.settings.read().catch(() => ({}) as Record<string, unknown>)
    const sandbox = settings['sandbox'] as { excludedCommands?: unknown } | undefined
    const excluded = (Array.isArray(sandbox?.excludedCommands) ? sandbox.excludedCommands : [])
      .filter((x): x is string => typeof x === 'string')
      .flatMap(x => excludedPattern(x, home) ?? [])
    if (excluded.length > 0 && steps.every(argv => excluded.some(re => re.test(argv.join(' '))))) {
      return { deny: 'host-exec: このコマンドは Bash で実行すれば sandbox の外で動く（sandbox.excludedCommands に一致）ので、Bash ツールで実行してください。' }
    }

    // ── 起動元が渡した環境の変更（ホストのプロセス環境からだけ読む。読めなければ何も実行しない） ──
    const rawEnvChange = await $.env.get('HOST_EXEC_ENV')
    const envChange: EnvChange | string = rawEnvChange === undefined ? { unset: [], set: [] } : parseEnvChange(rawEnvChange)
    if (typeof envChange === 'string') {
      return {
        deny:
          `host-exec: HOST_EXEC_ENV is invalid (${envChange}), so nothing was run. ` +
          'It is set by whoever launched Claude Code and must be a JSON object mapping environment variable names to null (remove) or a string (override). ' +
          'Do not retry; tell the user that HOST_EXEC_ENV needs fixing.',
      }
    }

    // ── 実行されるものを確定する（ダイアログに出すものと実際に動かすものを一致させる） ──
    const stat = (p: string): Promise<Stat | undefined> =>
      $.fs.stat(p, { resolve: true }).catch(() => undefined)
    const realOf = async (p: string) => (await stat(p))?.realPath ?? p

    const cwdAbs = joinPath(await $.session.cwd(), cwd ?? '.')
    const cwdStat = await stat(cwdAbs)
    if (cwdStat?.kind !== 'dir' || !cwdStat.realPath) {
      return { deny: `host-exec: cwd ${visible(cwdAbs)} is not a directory.` }
    }
    const cwdReal = cwdStat.realPath

    const pathDirs = ((await $.env.get('PATH')) ?? '').split(':').filter(d => d.startsWith('/'))
    const resolved: Array<{ argv: string[]; exe: string; exeReal: string }> = []
    for (const [i, argv] of steps.entries()) {
      const argv0 = argv[0] ?? ''
      let exe: string | undefined
      let exeStat: Stat | undefined
      if (argv0.includes('/')) {
        exe = joinPath(cwdReal, argv0)
        exeStat = await stat(exe)
      } else {
        for (const d of pathDirs) {
          const candidate = joinPath(d, argv0)
          const s = await stat(candidate)
          if (s?.kind === 'file') {
            exe = candidate
            exeStat = s
            break
          }
        }
      }
      if (exe === undefined || exeStat?.kind !== 'file') {
        const bare = argv0.includes('/')
          ? ''
          : ' on PATH. Commands that a plugin provides by bare name in its bin/ are on the Bash tool\'s PATH only, so run them with the Bash tool'
        return { deny: `host-exec: executable ${visible(argv0)}${at(i)} was not found${bare}. Nothing was run.` }
      }
      // env は = を含む引数を代入として読むので、= を含む実行ファイルを渡すと次の引数が実行ファイルとして動いてしまう
      if (envChange.unset.length > 0 && exe.includes('=')) {
        return { deny: `host-exec: executable ${visible(exe)}${at(i)} contains "=", so it cannot be run with the variables HOST_EXEC_ENV removes. Nothing was run.` }
      }
      resolved.push({ argv, exe, exeReal: exeStat.realPath ?? exe })
    }

    // ── 危険の兆候（止めずにダイアログで目を引く。何が起きるかと、どうすればいいかを書く） ──
    const tmpDir = await $.env.get('TMPDIR')
    const tempDirs = await Promise.all(['/tmp', '/var/folders', ...(tmpDir ? [tmpDir] : [])].map(realOf))
    const root = await realOf(await $.session.root())
    const warnings: string[] = []
    for (const [i, { argv, exeReal }] of resolved.entries()) {
      const step = isMulti ? `${i + 1}: ` : ''
      if (isUnder(exeReal, tempDirs)) {
        warnings.push(`${step}この実行ファイルは一時ディレクトリにあり、Claude が作ったものかもしれません。普段使っているツールのパスか確認してください`)
      } else if (isUnder(exeReal, [root])) {
        warnings.push(`${step}この実行ファイルはプロジェクト内にあり、Claude が書き換えられます。中身を確認していなければ「拒否」してください`)
      }
      warnings.push(...codeRunWarnings(basename(argv[0] ?? ''), argv.slice(1)).map(w => `${step}${w}`))
    }
    if (isUnder(cwdReal, tempDirs)) {
      warnings.push('一時ディレクトリで実行します。Claude が置いた設定ファイル（.git/config など）が読み込まれる可能性があります')
    } else if (!isUnder(cwdReal, [root])) {
      warnings.push(OUTSIDE_CWD)
    }

    // ── ゲート2: 実行承認 ──
    const shownPath = (p: string) => {
      const s = shellish(p)
      return home && s.startsWith(`${home}/`) ? `~${s.slice(home.length)}` : s
    }
    const commandLines = isMulti
      ? resolved.map(({ argv }, i) => `  ${i + 1}  $ ${shownCommand(argv)}`)
      : resolved.map(({ argv }) => `  $ ${shownCommand(argv)}`)
    // 警告が出るものは記憶しない（中身が変わっても同じキーで通ってしまうため）。キーは実行されるものそのもの。
    // プロジェクト外の cwd だけは中身の話ではなく場所の確認で、その場所（cwd 実パス）がキーに入るので記憶してよい
    const key = warnings.every(w => w === OUTSIDE_CWD)
      ? JSON.stringify([cwdReal, ...resolved.map(({ argv, exeReal }) => [exeReal, ...argv])])
      : undefined
    const approved: HostExecApproved = key === undefined ? {} : ((await $.state.get(APPROVED)).value ?? {})
    const runs = key === undefined ? undefined : approved[key]
    if (key !== undefined && runs !== undefined) {
      // 人間が「このセッションでは同じコマンドを聞かない」を選んだものと完全に同じなので聞き直さない
      await $.state.set(APPROVED, { ...approved, [key]: runs + 1 })
      $.ui.toast(`承認済みのコマンドを再実行: ${shownCommand(steps[0] ?? [])}（${runs + 1} 回目）`)
    } else {
      const runLabel = isMulti ? `${steps.length} 個とも実行する` : RUN
      // 毎回同じ定型文は置かない（読み飛ばす癖がつき、条件付きの警告まで読まれなくなる）。
      // 警告は出たときだけ先頭に。Claude の説明は未検証の文なので、言い分とやることを
      // ひと目で突き合わせられるようコマンドの直前に置く。接頭辞は外さない（無いと Claude の文が
      // host-exec 自身の表示に見え、「安全確認済み」などと書かれると見分けられない）
      const shown = [
        ...(warnings.length > 0 ? [`⚠ 注意（${warnings.length} 件）`, ...warnings.map(w => `・${w}`), ''] : []),
        `目的: ${shownReason(reason)}`,
        ...commandLines,
        '',
        ...resolved.map(({ exe, exeReal }, i) => {
          const label = i === 0 ? '  実行ファイル  ' : ' '.repeat(16)
          return `${label}${isMulti ? `${i + 1}  ` : ''}${shownPath(exe)}${exeReal !== exe ? ` → ${shownPath(exeReal)}` : ''}`
        }),
        `  場所          ${shownPath(cwdReal)}`,
        ...(envChange.unset.length > 0 ? [`  外す環境変数  ${envChange.unset.join(' ')}`] : []),
        ...(envChange.set.length > 0 ? [`  上書き        ${envChange.set.map(([n, v]) => `${n}=${shellish(v)}`).join(' ')}`] : []),
        ...(isMulti ? ['  失敗したらそこで止めます'] : []),
      ].join('\n')
      let approval = ''
      try {
        // 先頭の選択肢にカーソルが乗るので、Enter の押し間違いで実行・開示されない側を先頭に置く
        const options = key === undefined ? [DECLINE, runLabel] : [DECLINE, runLabel, RUN_REMEMBER]
        approval = await $.ui.ask(shown, { options, header: 'sandbox 外で実行' })
      } catch {
        return {
          deny:
            'host-exec: nobody approved the command (dialog dismissed or unavailable). Nothing was run. ' +
            'Do not call mcp__host-exec__run again, for this command or any other, until the user replies in the conversation. ' +
            'Tell the user what you wanted to run and why.',
        }
      }
      if (approval === RUN_REMEMBER && key !== undefined) {
        await $.state.set(APPROVED, { ...approved, [key]: 1 })
      } else if (approval !== runLabel) {
        // 「その他」に書かれた自由記述は指示として Claude に返す
        const note = approval && approval !== DECLINE ? ` The user said: ${approval}` : ''
        return { deny: `host-exec: the user declined to run this command.${note}` }
      }
    }

    // ── 実行（失敗・起動失敗・タイムアウトで止め、残りは実行しない） ──
    const sections: string[] = []
    const outcomes: string[] = []
    /** 結果の後ろに足す次の手。出力を渡さないときも足す（秘密情報は含まない） */
    const hints = new Set<string>()
    let stoppedAt: number | undefined
    const unsetArgs = envChange.unset.length > 0 ? [ENV_BIN, ...envChange.unset.flatMap(n => ['-u', n])] : []
    const envInit = envChange.set.length > 0 ? { env: Object.fromEntries(envChange.set) } : {}
    for (const [i, { argv, exe }] of resolved.entries()) {
      try {
        const r = await $.process.run([...unsetArgs, exe, ...argv.slice(1)], { cwd: cwdReal, timeoutMs: timeoutSec * 1000, ...envInit })
        sections.push(format(argv, r))
        outcomes.push(`exit code ${r.exitCode}`)
        if (KEYCHAIN_DENIAL_MARKERS.some(m => r.stdout.includes(m) || r.stderr.includes(m))) hints.add(KEYCHAIN_HINT)
        if (r.exitCode !== 0) stoppedAt = i
      } catch (err) {
        const timedOut = String(err).includes(TIMEOUT_MARKER)
        sections.push(`$ ${shownCommand(argv)}\nhost-exec: the command ${timedOut ? `timed out after ${timeoutSec}s` : 'could not start'}: ${String(err)}`)
        outcomes.push(timedOut ? 'timed out' : 'could not start')
        if (timedOut) hints.add(timeoutHint(timeoutSec))
        stoppedAt = i
      }
      if (stoppedAt !== undefined) break
    }
    for (const { argv } of resolved.slice(sections.length)) {
      sections.push(`$ ${shownCommand(argv)}\n未実行（ステップ ${(stoppedAt ?? 0) + 1} で止まったため、実行していません）`)
      outcomes.push('未実行')
    }
    const text = sections.join('\n\n')
    const withHints = (s: string) => (hints.size > 0 ? `${s}\n\n${[...hints].join('\n')}` : s)

    // ── ゲート3: 出力の機密チェック（全ステップの出力をまとめて 1 回） ──
    const findings = scan(text)
    if (findings.length === 0) return { result: withHints(text) }

    const detected = findings.map(f => `${f.kind} ×${f.count}`).join('、')
    let choice = ''
    try {
      // $.ui.ask の選択肢には説明を付けられないので、各選択肢で何が起きるかは質問文に書く
      choice = await $.ui.ask(
        [
          '出力に秘密情報らしきものがあったので、Claude に渡す前に止めました。',
          '',
          ...commandLines,
          `  検出: ${detected}`,
          '',
          'Claude に渡すと会話の記録に残り、その後の作業に使われる可能性があります。',
          `・${WITHHOLD}        実行できたことと終了コードだけを伝えます`,
          `・${PASS_MASKED}  該当部分を [REDACTED] に置き換えて渡します`,
          `・${PASS_RAW}    秘密情報を含む全文を渡します`,
          '',
          'どうしますか？',
        ].join('\n'),
        { options: [WITHHOLD, PASS_MASKED, PASS_RAW], header: 'secrets' },
      )
    } catch {
      choice = WITHHOLD
    }

    if (choice === PASS_RAW) return { result: withHints(text) }
    if (choice === PASS_MASKED) {
      $.ui.toast(`host-exec: ${findings.length} 種類の秘密情報をマスクして渡しました`)
      return { result: withHints(mask(text) + '\n\n[host-exec: secrets in this output were redacted by the user\'s choice]') }
    }
    // 渡さない（既定）: 実行結果の事実だけ返す
    return {
      result: withHints(
        `host-exec: the command ran (${isMulti ? outcomes.map((o, i) => `step ${i + 1}: ${o}`).join(', ') : outcomes[0]}), but its output was withheld because it contained: ` +
        findings.map(f => f.kind).join(', ') +
        '. Do not try to read these values another way. Ask the user for the specific non-secret information you need.',
      ),
    }
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: 'host-exec: its guard failed, so the command was not run.' },
  )

  // 結果は変えず、sandbox に拒否された失敗のときだけ host-exec を使うよう context を添える。
  // worktree の隔離ガードの拒否は sandbox ではないので、host-exec ではなく書き直しを促す
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const r = await next(e)
    const out = r as unknown as { isError?: boolean; text?: unknown; context?: string[] }
    const text = typeof out.text === 'string' ? out.text : ''
    if (out.isError !== true) return r
    const hint = text.includes(WORKTREE_GUARD_MARKER)
      ? WORKTREE_GUARD_HINT
      : SANDBOX_DENIAL_MARKERS.some(m => text.includes(m)) ? SANDBOX_HINT : undefined
    if (hint === undefined) return r
    return { ...r, context: [...(out.context ?? []), hint] }
  })
}
