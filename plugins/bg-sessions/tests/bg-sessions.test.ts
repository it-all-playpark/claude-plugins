import { describe, expect, mock, test } from 'claude-code/testing'

const NOW = 1_800_000_000_000
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const PROJECTS = '/Users/x/.claude/projects'

type Agent = { id: string; cwd: string; state: string; kind?: string; name?: string }
/** transcript: project ディレクトリ名・最終更新・末尾行の cwd と gitBranch */
type Transcript = { dir: string; mtimeMs: number; cwd: string; branch: string }

type WorldOptions = {
  agentsExit?: number
  registerDeny?: string
  env?: Record<string, string>
  /** `zellij list-sessions --short` が返すセッション名 */
  zellij?: string[]
  /** 実行した zellij の argv を記録する */
  ran?: string[][]
  toasts?: string[]
  /** $.ui.open に渡された引数を記録する */
  opened?: any[]
}

/**
 * claude agents --json・projects ディレクトリ・transcript の末尾・zellij を返す世界。
 * sessionId は `<id>-sid`、transcript は `<dir>/<sessionId>.jsonl` に置く。
 */
function world(on: any, agents: Agent[], transcripts: Record<string, Transcript>, opts: WorldOptions = {}) {
  mock.env(on, { HOME: '/Users/x', ...opts.env })
  const clock = mock.clock(on, { now: NOW })
  on('session.id', async () => ({ value: 'self-sid' }))
  on('session.start', async ($: any, e: any) => e)
  on('command.register', async () => (opts.registerDeny ? { deny: opts.registerDeny } : { value: undefined }))
  on('ui.toast', async ($: any, e: any) => {
    opts.toasts?.push(e.text)
    return { value: undefined }
  })
  on('ui.open', async ($: any, e: any) => {
    opts.opened?.push(e)
    return { value: { isPlaced: true } }
  })
  on('ui.close', async () => ({ value: undefined }))
  const files: Record<string, Transcript> = {}
  for (const [id, t] of Object.entries(transcripts)) files[`${PROJECTS}/${t.dir}/${id}-sid.jsonl`] = t
  on('process.run', async ($: any, e: any) => {
    const [cmd, ...args] = e.argv as string[]
    if (cmd === 'claude') {
      const json = agents.map(a => ({
        id: a.id,
        sessionId: a.id === 'self' ? 'self-sid' : `${a.id}-sid`,
        cwd: a.cwd,
        kind: a.kind ?? 'background',
        state: a.state,
        name: a.name ?? `task ${a.id}`,
        startedAt: NOW - 10 * DAY,
      }))
      return { value: { exitCode: opts.agentsExit ?? 0, stdout: JSON.stringify(json), stderr: opts.agentsExit ? 'boom' : '' } }
    }
    if (cmd === 'tail') {
      const t = files[args[args.length - 1]]
      const lines = [
        JSON.stringify({ type: 'user', cwd: '/Users/x/elsewhere', gitBranch: 'old' }),
        JSON.stringify({ type: 'assistant', cwd: t.cwd, gitBranch: t.branch }),
        '{"type":"summary"}',
      ]
      return { value: { exitCode: 0, stdout: lines.join('\n') + '\n', stderr: '' } }
    }
    if (cmd === 'zellij') {
      opts.ran?.push([...e.argv])
      const stdout = args[0] === 'list-sessions' ? (opts.zellij ?? []).join('\n') + '\n' : ''
      return { value: { exitCode: 0, stdout, stderr: '' } }
    }
    return { deny: `unexpected ${cmd}` }
  })
  on('fs.list', async () => ({
    value: [...new Set(Object.values(transcripts).map(t => t.dir)), '-Users-x-unrelated'].map(name => ({
      name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false,
    })),
  }))
  on('fs.stat', async ($: any, e: any) => {
    const t = files[e.path]
    if (!t) return { deny: `ENOENT: ${e.path}` }
    return { value: { kind: 'file', size: 1, mtimeMs: t.mtimeMs, isLink: false } }
  })
  return clock
}

async function start($: any, clock: any) {
  await $.session.start({ cwd: '/Users/x/ghq/acme/app' } as any)
  // session.start が投げた初回の取得を待つ
  await clock.advance(0)
}

function band($: any, bodyColumns = 120) {
  return $.ui.mount({
    plugin: 'bg-sessions', surface: 'terminal', component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns } as any,
  })
}

async function list($: any) {
  await $.command.run({ command: 'bg-sessions', args: '' } as any)
  return $.ui.mount({
    plugin: 'bg-sessions', surface: 'terminal', component: 'Pane', requestId: 'bg-sessions',
    props: { title: 'bg sessions', isFocused: true, bodyColumns: 120, placement: 'dock' } as any,
  })
}

const APP = '/Users/x/ghq/acme/app'
const AGENTS: Agent[] = [
  { id: 'self', cwd: '/Users/x/ghq/acme/mine', state: 'working' },
  { id: 'front', cwd: '/Users/x/ghq/acme/front', state: 'working', kind: 'interactive' },
  { id: 'wt', cwd: APP, state: 'working', name: 'dev-flow issue 12' },
  { id: 'api', cwd: '/Users/x/ghq/acme/api', state: 'blocked' },
  { id: 'old', cwd: '/Users/x/ghq/acme/old', state: 'blocked' },
]
const TRANSCRIPTS: Record<string, Transcript> = {
  // worktree に入ったセッションは worktree の cwd の名前の下に transcript がある
  wt: { dir: '-Users-x-ghq-acme-app--claude-worktrees-df-12', mtimeMs: NOW - 2 * 60_000, cwd: `${APP}/.claude/worktrees/df-12`, branch: 'feature/issue-12' },
  api: { dir: '-Users-x-ghq-acme-api', mtimeMs: NOW - HOUR, cwd: '/Users/x/ghq/acme/api', branch: 'main' },
  old: { dir: '-Users-x-ghq-acme-old', mtimeMs: NOW - 4 * DAY, cwd: '/Users/x/ghq/acme/old', branch: 'main' },
}

describe('bg-sessions', () => {
  test('帯に実行中・入力待ち・放置の件数と、実行中の repo/worktree を transcript の最終行から出す', async ($, on) => {
    const clock = world(on, AGENTS, TRANSCRIPTS)
    await start($, clock)
    const ui = await band($)
    const text = (await ui.find({ key: 'bg-band' }))?.text ?? ''
    expect(text).toContain('1 実行中')
    expect(text).toContain('app/df-12')
    expect(text).toContain('1 入力待ち')
    expect(text).toContain('1 放置')
    // 自分自身と対話セッションは数えない
    expect(text).not.toContain('mine')
    expect(text).not.toContain('front')
  })

  test('作業していないセッションは最終更新から 3 日経つと放置に入る', async ($, on) => {
    const clock = world(on, [
      { id: 'fresh', cwd: '/Users/x/ghq/acme/a', state: 'blocked' },
      { id: 'edge', cwd: '/Users/x/ghq/acme/b', state: 'blocked' },
      { id: 'busy', cwd: '/Users/x/ghq/acme/c', state: 'working' },
    ], {
      fresh: { dir: '-Users-x-ghq-acme-a', mtimeMs: NOW - 3 * DAY + 60_000, cwd: '/Users/x/ghq/acme/a', branch: 'main' },
      edge: { dir: '-Users-x-ghq-acme-b', mtimeMs: NOW - 3 * DAY, cwd: '/Users/x/ghq/acme/b', branch: 'main' },
      // 作業中なら古くても実行中のまま
      busy: { dir: '-Users-x-ghq-acme-c', mtimeMs: NOW - 5 * DAY, cwd: '/Users/x/ghq/acme/c', branch: 'main' },
    })
    await start($, clock)
    const text = (await (await band($)).find({ key: 'bg-band' }))?.text ?? ''
    expect(text).toContain('1 実行中')
    expect(text).toContain('1 入力待ち')
    expect(text).toContain('1 放置')
  })

  test('ctrl+x tab で帯にフォーカスすると「一覧」に乗り、押すと /bg-sessions と同じペインがフォーカス付きで開く', async ($, on) => {
    const opened: any[] = []
    const clock = world(on, AGENTS, TRANSCRIPTS, { opened })
    await start($, clock)
    const ui = await band($)
    const open = await ui.find({ key: 'bg-open' })
    expect(open?.props.autoFocus).toBe(true)
    // 帯に数字の hotkey を付けない（空の composer で数字を打つと押されるため）
    expect((await ui.findAll({ type: 'Button' })).every(b => !/^[0-9]$/.test(String(b.props.hotkey ?? '')))).toBe(true)

    await ui.press({ key: 'bg-open' })
    expect(opened).toContainEqual(expect.objectContaining({ id: 'bg-sessions', focus: true }))
  })

  test('コマンド名の登録を拒否されても帯は出る', async ($, on) => {
    const clock = world(on, AGENTS, TRANSCRIPTS, { registerDeny: '"/bg-sessions" refused: it is a built-in' })
    await start($, clock)
    const text = (await (await band($)).find({ key: 'bg-band' }))?.text ?? ''
    expect(text).toContain('1 実行中')
  })

  test('放置しかないときは帯を出さない', async ($, on) => {
    const clock = world(on, [AGENTS[4]], { old: TRANSCRIPTS.old })
    // plugin が譲ったときに engine が描く既定の帯
    on('ui.render', { component: 'AbovePrompt' }, async ($: any, e: any) => h($.ui.resolve(e).Text, { key: 'engine-band' }, 'engine'))
    await start($, clock)
    const ui = await band($)
    expect(await ui.find({ key: 'bg-band' })).toBeUndefined()
    expect(await ui.find({ text: 'engine' })).toBeDefined()
  })

  test('/bg-sessions の一覧は repo・worktree・branch を並べ、放置は s で表示する', async ($, on) => {
    const clock = world(on, AGENTS, TRANSCRIPTS)
    await start($, clock)
    const ui = await list($)

    const row = await ui.find({ key: 'wt' })
    expect(row?.text).toContain('df-12')
    expect(row?.text).toContain('feature/issue-12')
    expect((await ui.find({ key: 'api' }))?.text).toContain('api')
    expect(await ui.find({ key: 'old' })).toBeUndefined()
    // 押せるのは放置の開閉だけ
    expect((await ui.findAll({ type: 'Button' })).map(b => b.key)).toEqual(['bg-stale'])

    await ui.press({ key: 'bg-stale' })
    expect((await ui.find({ key: 'old' }))?.text).toContain('old')
  })

  test('claude agents --json が失敗したら一覧に理由を出す', async ($, on) => {
    const clock = world(on, AGENTS, TRANSCRIPTS, { agentsExit: 1 })
    await start($, clock)
    const ui = await list($)
    expect((await ui.find({ text: /boom/ }))).toBeDefined()
  })

  describe('zellij_switch', () => {
    const ON = { options: { zellij_switch: true } }
    const IN_ZELLIJ = { ZELLIJ: '0', ZELLIJ_SESSION_NAME: 'mine' }

    test('行を 1〜9 で選ぶと repo と同じ名前の zellij セッションへ移り、無ければ移らずに知らせる', ON, async ($, on) => {
      const ran: string[][] = []
      const toasts: string[] = []
      const clock = world(on, AGENTS, TRANSCRIPTS, { env: IN_ZELLIJ, zellij: ['mine', 'app'], ran, toasts })
      await start($, clock)
      const ui = await list($)
      expect((await ui.find({ key: 'wt' }))?.props.hotkey).toBe('1')
      expect((await ui.find({ key: 'api' }))?.props.hotkey).toBe('2')
      // 開いた直後の Enter で先頭の行を選べる
      expect((await ui.find({ key: 'wt' }))?.props.autoFocus).toBe(true)
      expect((await ui.find({ key: 'api' }))?.props.autoFocus).toBeUndefined()

      await ui.press({ key: 'wt' })
      expect(ran).toContainEqual(['zellij', 'action', 'switch-session', 'app'])

      // api のセッションは無い: switch-session すると新しいセッションが作られるので呼ばない
      ran.length = 0
      await ui.press({ key: 'api' })
      expect(ran.some(a => a[1] === 'action')).toBe(false)
      expect(toasts.some(t => t.includes('api'))).toBe(true)
    })

    test("repo 名とセッション名の '-' と '_' の違いは同じものとして扱う", ON, async ($, on) => {
      const ran: string[][] = []
      const clock = world(on, [{ id: 'bo', cwd: '/Users/x/ghq/acme/back-office', state: 'blocked' }], {
        bo: { dir: '-Users-x-ghq-acme-back-office', mtimeMs: NOW - HOUR, cwd: '/Users/x/ghq/acme/back-office', branch: 'main' },
      }, { env: IN_ZELLIJ, zellij: ['back_office'], ran })
      await start($, clock)
      await (await list($)).press({ key: 'bo' })
      expect(ran).toContainEqual(['zellij', 'action', 'switch-session', 'back_office'])
    })

    test('zellij の外では zellij を呼ばずに知らせる', ON, async ($, on) => {
      const ran: string[][] = []
      const toasts: string[] = []
      const clock = world(on, AGENTS, TRANSCRIPTS, { zellij: ['app'], ran, toasts })
      await start($, clock)
      await (await list($)).press({ key: 'wt' })
      expect(ran).toEqual([])
      expect(toasts.some(t => t.includes('zellij'))).toBe(true)
    })
  })
})
