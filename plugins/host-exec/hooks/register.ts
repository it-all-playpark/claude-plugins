import type { Register } from 'claude-code'

// ─────────────────────────────────────────────────────────────
// host-exec
// sandbox で動かないコマンドを、Claude が人間に「これ実行して」と
// 頼む代わりに呼べるツール `mcp__host-exec__run` を追加する。
//
//   ゲート1: 拒否パターン（静的チェック）
//   ゲート2: 毎回の実行承認（ダイアログ）
//   ゲート3: 出力の機密チェック → 引っかかったら Claude に渡す前に停止
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

const MAX_TIMEOUT_SEC = 600
const RUN = '実行する'
const PASS_MASKED = 'マスクして渡す'
const WITHHOLD = '渡さない'
const PASS_RAW = 'そのまま渡す'

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

function shownCommand(argv: readonly string[]): string {
  return argv.map(shellish).join(' ')
}

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
        'Pass the command as an argument vector (no shell: no pipes, redirects, globs, && or env-var expansion).',
        'argv[0] is resolved on the user\'s PATH and shown to the user with the full argv and cwd before anything runs.',
        'Destructive commands and commands that print credentials are refused.',
        'If the output contains secrets, the user may mask or withhold it; do not try to obtain the secret another way.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          argv: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'e.g. ["gcloud","run","services","list","--region","asia-northeast1"]' },
          cwd: { type: 'string', description: 'Working directory; defaults to the session\'s' },
          reason: { type: 'string', description: 'One sentence, in Japanese, on why this needs to run outside the sandbox' },
          timeoutSec: { type: 'number', description: `Default 30, max ${MAX_TIMEOUT_SEC}` },
        },
        required: ['argv', 'reason'],
      },
      // deferred だと ToolSearch で読み込むまで description（人間に頼む代わりに使え）が見えない
      isDeferred: false,
    })
    return next(e)
  })

  on('tool.call', { tool: 'mcp__host-exec__run' }, async ($, e) => {
    const input = e as unknown as { argv?: unknown; cwd?: unknown; reason?: unknown; timeoutSec?: unknown }
    const argv = Array.isArray(input.argv) ? input.argv.map(String) : []
    if (argv.length === 0) return { deny: 'argv must be a non-empty array of strings.' }
    const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : undefined
    const reason = typeof input.reason === 'string' ? input.reason : '(理由なし)'
    const timeoutSec = Math.min(
      Math.max(typeof input.timeoutSec === 'number' ? input.timeoutSec : 30, 1),
      MAX_TIMEOUT_SEC,
    )
    const line = argv.join(' ')

    // ── ゲート1: 静的チェック ──
    for (const [re, why] of DENY_PATTERNS) {
      if (re.test(line)) {
        return { deny: `host-exec: refused (${why}). Do not retry this command another way; explain to the user what you wanted to do and let them decide.` }
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

    const argv0 = argv[0] ?? ''
    let exe: string | undefined
    let exeStat: Stat | undefined
    if (argv0.includes('/')) {
      exe = joinPath(cwdReal, argv0)
      exeStat = await stat(exe)
    } else {
      const dirs = ((await $.env.get('PATH')) ?? '').split(':').filter(d => d.startsWith('/'))
      for (const d of dirs) {
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
      return { deny: `host-exec: executable ${visible(argv0)} was not found${argv0.includes('/') ? '' : ' on PATH'}.` }
    }
    const exeReal = exeStat.realPath ?? exe

    // ── 危険の兆候（止めずにダイアログで目を引く。何が起きるかと、どうすればいいかを書く） ──
    const tmpDir = await $.env.get('TMPDIR')
    const tempDirs = await Promise.all(['/tmp', '/var/folders', ...(tmpDir ? [tmpDir] : [])].map(realOf))
    const root = await realOf(await $.session.root())
    const warnings: string[] = []
    if (isUnder(exeReal, tempDirs)) {
      warnings.push('この実行ファイルは一時ディレクトリにあり、Claude が作ったものかもしれません。普段使っているツールのパスか確認してください')
    } else if (isUnder(exeReal, [root])) {
      warnings.push('この実行ファイルはプロジェクト内にあり、Claude が書き換えられます。中身を確認していなければ「拒否」してください')
    }
    if (isUnder(cwdReal, tempDirs)) {
      warnings.push('一時ディレクトリで実行します。Claude が置いた設定ファイル（.git/config など）が読み込まれる可能性があります')
    } else if (!isUnder(cwdReal, [root])) {
      warnings.push('プロジェクトの外で実行します。この場所で実行してよいか確認してください')
    }
    warnings.push(...codeRunWarnings(basename(argv0), argv.slice(1)))

    // ── ゲート2: 実行承認 ──
    const home = await $.env.get('HOME')
    const shownPath = (p: string) => {
      const s = shellish(p)
      return home && s.startsWith(`${home}/`) ? `~${s.slice(home.length)}` : s
    }
    // 毎回同じ定型文は置かない（読み飛ばす癖がつき、条件付きの警告まで読まれなくなる）。
    // 警告は出たときだけ先頭に。Claude の説明は未検証の文なので、言い分とやることを
    // ひと目で突き合わせられるようコマンドの直前に置く
    const shown = [
      ...(warnings.length > 0 ? [`⚠ 注意（${warnings.length} 件）`, ...warnings.map(w => `・${w}`), ''] : []),
      visible(reason).slice(1, -1),
      `  $ ${shownCommand(argv)}`,
      '',
      `  実行ファイル  ${shownPath(exe)}${exeReal !== exe ? ` → ${shownPath(exeReal)}` : ''}`,
      `  場所          ${shownPath(cwdReal)}`,
    ].join('\n')
    let approval = ''
    try {
      // 先頭の選択肢にカーソルが乗るので、Enter の押し間違いで実行・開示されない側を先頭に置く
      approval = await $.ui.ask(shown, { options: ['拒否', RUN], header: 'sandbox 外で実行' })
    } catch {
      return { deny: 'host-exec: nobody approved the command (dialog dismissed or unavailable). Wait for the user.' }
    }
    if (approval !== RUN) {
      // 「その他」に書かれた自由記述は指示として Claude に返す
      const note = approval && approval !== '拒否' ? ` The user said: ${approval}` : ''
      return { deny: `host-exec: the user declined to run this command.${note}` }
    }

    // ── 実行 ──
    let r: { exitCode: number; stdout: string; stderr: string }
    try {
      r = await $.process.run([exe, ...argv.slice(1)], { cwd: cwdReal, timeoutMs: timeoutSec * 1000 })
    } catch (err) {
      return { result: `host-exec: the command could not start or timed out after ${timeoutSec}s: ${String(err)}` }
    }
    const text = format(argv, r)

    // ── ゲート3: 出力の機密チェック ──
    const findings = scan(text)
    if (findings.length === 0) return { result: text }

    const detected = findings.map(f => `${f.kind} ×${f.count}`).join('、')
    let choice = ''
    try {
      // $.ui.ask の選択肢には説明を付けられないので、各選択肢で何が起きるかは質問文に書く
      choice = await $.ui.ask(
        [
          '出力に秘密情報らしきものがあったので、Claude に渡す前に止めました。',
          '',
          `  $ ${shownCommand(argv)}`,
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

    if (choice === PASS_RAW) return { result: text }
    if (choice === PASS_MASKED) {
      $.ui.toast(`host-exec: ${findings.length} 種類の秘密情報をマスクして渡しました`)
      return { result: mask(text) + '\n\n[host-exec: secrets in this output were redacted by the user\'s choice]' }
    }
    // 渡さない（既定）: 実行結果の事実だけ返す
    return {
      result:
        `host-exec: the command ran (exit code ${r.exitCode}), but its output was withheld because it contained: ` +
        findings.map(f => f.kind).join(', ') +
        '. Do not try to read these values another way. Ask the user for the specific non-secret information you need.',
    }
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: 'host-exec: its guard failed, so the command was not run.' },
  )

  // 結果は変えず、sandbox に拒否された失敗のときだけ host-exec を使うよう context を添える
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const r = await next(e)
    const out = r as unknown as { isError?: boolean; text?: unknown; context?: string[] }
    const text = typeof out.text === 'string' ? out.text : ''
    if (out.isError !== true || !SANDBOX_DENIAL_MARKERS.some(m => text.includes(m))) return r
    return { ...r, context: [...(out.context ?? []), SANDBOX_HINT] }
  })
}
