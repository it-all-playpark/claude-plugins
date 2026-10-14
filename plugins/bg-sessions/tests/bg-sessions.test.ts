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
  /** $.session.surfaces() の答え。既定は対話セッションの ['terminal']、bg セッション（誰も attach していない）は [] */
  surfaces?: string[]
  /** claude agents --json を呼んだ回数を数える */
  agentsCalls?: { n: number }
  env?: Record<string, string>
  /** `zellij list-sessions --short` が返すセッション名 */
  zellij?: string[]
  /** 実行した zellij の argv を記録する */
  ran?: string[][]
  toasts?: string[]
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
  on('session.surfaces', async () => ({ value: opts.surfaces ?? ['terminal'] }))
  on('command.register', async () => (opts.registerDeny ? { deny: opts.registerDeny } : { value: undefined }))
  on('ui.toast', async ($: any, e: any) => {
    opts.toasts?.push(e.text)
    return { value: undefined }
  })
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('ui.close', async () => ({ value: undefined }))
  const files: Record<string, Transcript> = {}
  for (const [id, t] of Object.entries(transcripts)) files[`${PROJECTS}/${t.dir}/${id}-sid.jsonl`] = t
  on('process.run', async ($: any, e: any) => {
    const [cmd, ...args] = e.argv as string[]
    if (cmd === 'claude') {
      if (opts.agentsCalls) opts.agentsCalls.n++
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
  test('帯に実行中・入力待ちのセッションを repo/worktree（transcript の最終行から）で並べ、放置は件数だけ出す', async ($, on) => {
    const clock = world(on, AGENTS, TRANSCRIPTS)
    await start($, clock)
    const ui = await band($)
    const text = (await ui.find({ key: 'bg-band' }))?.text ?? ''
    expect(text).toContain('app/df-12')
    expect(text).toContain('api')
    expect(text).toContain('1 放置')
    expect(text).not.toContain('old')
    // 自分自身と対話セッションは出さない
    expect(text).not.toContain('mine')
    expect(text).not.toContain('front')
    // select_action が off（既定）なら押せるものは無い
    expect(await ui.findAll({ type: 'Button' })).toEqual([])
  })

  test('作業を終えたセッション（done）は入力待ちと別の印で、入力待ちの後に出す', async ($, on) => {
    const clock = world(on, [
      { id: 'fin', cwd: '/Users/x/ghq/acme/fin', state: 'done' },
      { id: 'ask', cwd: '/Users/x/ghq/acme/ask', state: 'blocked' },
    ], {
      fin: { dir: '-Users-x-ghq-acme-fin', mtimeMs: NOW - 60_000, cwd: '/Users/x/ghq/acme/fin', branch: 'main' },
      ask: { dir: '-Users-x-ghq-acme-ask', mtimeMs: NOW - HOUR, cwd: '/Users/x/ghq/acme/ask', branch: 'main' },
    })
    await start($, clock)
    const text = (await (await band($)).find({ key: 'bg-band' }))?.text ?? ''
    expect(text).toContain('◐ ask')
    expect(text).toContain('✓ fin')
    // 完了の方が新しくても入力待ちが先
    expect(text.indexOf('ask')).toBeLessThan(text.indexOf('fin'))
  })

  test('Bash で別の repo に cd しただけのセッションは、起動した repo で出す', async ($, on) => {
    const clock = world(on, [{ id: 'trip', cwd: '/Users/x/ghq/acme/notes', state: 'done' }], {
      // transcript は起動した repo の下に残り、最後の cwd だけがよその repo に移っている
      trip: { dir: '-Users-x-ghq-acme-notes', mtimeMs: NOW - HOUR, cwd: '/Users/x/ghq/acme/pipeline', branch: 'feature/elsewhere-7' },
    })
    await start($, clock)
    const text = (await (await band($)).find({ key: 'bg-band' }))?.text ?? ''
    expect(text).toContain('notes')
    expect(text).not.toContain('pipeline')
    // 一覧の branch 列にも cd 先の repo の branch を出さない
    const row = (await (await list($)).find({ key: 'trip' }))?.text ?? ''
    expect(row).toContain('notes')
    expect(row).not.toContain('feature/elsewhere-7')
  })

  test('作業していないセッションは最終更新から 3 日経つと放置に入る', async ($, on) => {
    const clock = world(on, [
      { id: 'fresh', cwd: '/Users/x/ghq/acme/fresh', state: 'blocked' },
      { id: 'edge', cwd: '/Users/x/ghq/acme/edge', state: 'blocked' },
      { id: 'busy', cwd: '/Users/x/ghq/acme/busy', state: 'working' },
    ], {
      fresh: { dir: '-Users-x-ghq-acme-fresh', mtimeMs: NOW - 3 * DAY + 60_000, cwd: '/Users/x/ghq/acme/fresh', branch: 'main' },
      edge: { dir: '-Users-x-ghq-acme-edge', mtimeMs: NOW - 3 * DAY, cwd: '/Users/x/ghq/acme/edge', branch: 'main' },
      // 作業中なら古くても実行中のまま
      busy: { dir: '-Users-x-ghq-acme-busy', mtimeMs: NOW - 5 * DAY, cwd: '/Users/x/ghq/acme/busy', branch: 'main' },
    })
    await start($, clock)
    const text = (await (await band($)).find({ key: 'bg-band' }))?.text ?? ''
    expect(text).toContain('fresh')
    expect(text).toContain('busy')
    expect(text).not.toContain('edge')
    expect(text).toContain('1 放置')
  })

  test('描く画面が無いセッション（attach されていない bg セッション）は一覧を取りに行かない', async ($, on) => {
    const bg = { n: 0 }
    const clock = world(on, AGENTS, TRANSCRIPTS, { surfaces: [], agentsCalls: bg })
    await start($, clock)
    await clock.advance(60_000)
    expect(bg.n).toBe(0)
  })

  test('画面のあるセッションは 15 秒ごとに一覧を取り直す', async ($, on) => {
    const calls = { n: 0 }
    const clock = world(on, AGENTS, TRANSCRIPTS, { agentsCalls: calls })
    await start($, clock)
    expect(calls.n).toBe(1)
    await clock.advance(30_000)
    expect(calls.n).toBe(3)
  })

  test('コマンド名の登録を拒否されても帯は出る', async ($, on) => {
    const clock = world(on, AGENTS, TRANSCRIPTS, { registerDeny: '"/bg-sessions" refused: it is a built-in' })
    await start($, clock)
    const text = (await (await band($)).find({ key: 'bg-band' }))?.text ?? ''
    expect(text).toContain('app/df-12')
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

  test('/bg-sessions の一覧は repo・worktree・branch を並べ、放置は z で表示する', async ($, on) => {
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
    expect((await ui.find({ key: 'bg-stale' }))?.props.hotkey).toBe('z')

    await ui.press({ key: 'bg-stale' })
    expect((await ui.find({ key: 'old' }))?.text).toContain('old')
  })

  test('claude agents --json が失敗したら一覧に理由を出す', async ($, on) => {
    const clock = world(on, AGENTS, TRANSCRIPTS, { agentsExit: 1 })
    await start($, clock)
    const ui = await list($)
    expect((await ui.find({ text: /boom/ }))).toBeDefined()
  })

  describe('select_action: zellij-session', () => {
    const ON = { options: { select_action: 'zellij-session' } }
    const IN_ZELLIJ = { ZELLIJ: '0', ZELLIJ_SESSION_NAME: 'mine' }

    test('帯は各セッションに a s d … を割り当て、ctrl+x tab の直後は先頭に乗る。数字の hotkey は付けない', ON, async ($, on) => {
      const ran: string[][] = []
      const clock = world(on, AGENTS, TRANSCRIPTS, { env: IN_ZELLIJ, zellij: ['mine', 'app'], ran })
      await start($, clock)
      const ui = await band($)
      const buttons = await ui.findAll({ type: 'Button' })
      expect(buttons.map(b => [b.key, b.props.hotkey])).toEqual([['band-wt', 'a'], ['band-api', 's']])
      // 帯の数字 hotkey は空の composer で数字を打つと押されるので使わない
      expect(buttons.every(b => !/^[0-9]$/.test(String(b.props.hotkey)))).toBe(true)
      expect(buttons[0]?.props.autoFocus).toBe(true)
      expect(buttons[1]?.props.autoFocus).toBeUndefined()

      await ui.press({ key: 'band-wt' })
      expect(ran).toContainEqual(['zellij', 'action', 'switch-session', 'app'])
    })

    test('一覧の行も帯と同じ英字で選べ、repo と同じ名前の zellij セッションへ移り、無ければ移らずに知らせる', ON, async ($, on) => {
      const ran: string[][] = []
      const toasts: string[] = []
      const clock = world(on, AGENTS, TRANSCRIPTS, { env: IN_ZELLIJ, zellij: ['mine', 'app'], ran, toasts })
      await start($, clock)
      const ui = await list($)
      expect((await ui.find({ key: 'wt' }))?.props.hotkey).toBe('a')
      expect((await ui.find({ key: 'api' }))?.props.hotkey).toBe('s')
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

    test('今いる zellij セッションへは移らず、すでにいることを知らせる', ON, async ($, on) => {
      const ran: string[][] = []
      const toasts: string[] = []
      const clock = world(on, AGENTS, TRANSCRIPTS, { env: { ZELLIJ: '0', ZELLIJ_SESSION_NAME: 'app' }, zellij: ['app'], ran, toasts })
      await start($, clock)
      await (await band($)).press({ key: 'band-wt' })
      expect(ran.some(a => a[1] === 'action')).toBe(false)
      expect(toasts.some(t => t.includes('すでに app'))).toBe(true)
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

  describe('select_action: attach', () => {
    const ATTACH = { options: { select_action: 'attach' } }
    // このセッションの PATH（claude に届く）を pane に渡す。zellij run の pane は zellij サーバーの環境で起動するため
    const SESSION_PATH = '/Users/x/.local/bin:/usr/bin'
    const IN_ZELLIJ = { ZELLIJ: '0', ZELLIJ_SESSION_NAME: 'mine', PATH: SESSION_PATH }
    const runOf = (id: string, where: string) =>
      ['zellij', 'run', '--in-place', '--close-on-exit', '--name', `bg ${where}`, '--', 'env', `PATH=${SESSION_PATH}`, 'claude', 'attach', id]

    test('帯でも一覧でも、選んだセッションそのものを今の pane と入れ替えて claude attach で開く', ATTACH, async ($, on) => {
      const ran: string[][] = []
      // 同じ repo のセッションが 2 つあっても、選んだ方の id で開く
      const twins: Agent[] = [...AGENTS, { id: 'wt2', cwd: APP, state: 'blocked' }]
      const clock = world(on, twins, {
        ...TRANSCRIPTS,
        wt2: { dir: '-Users-x-ghq-acme-app', mtimeMs: NOW - HOUR, cwd: APP, branch: 'main' },
      }, { env: IN_ZELLIJ, ran })
      await start($, clock)

      const ui = await band($)
      expect((await ui.findAll({ type: 'Button' })).map(b => b.props.hotkey)).toEqual(['a', 's', 'd'])
      await ui.press({ key: 'band-wt2' })
      expect(ran).toEqual([runOf('wt2', 'app')])

      ran.length = 0
      await (await list($)).press({ key: 'wt' })
      expect(ran).toEqual([runOf('wt', 'app/df-12')])
    })

    test('zellij の外では zellij を呼ばずに知らせる', ATTACH, async ($, on) => {
      const ran: string[][] = []
      const toasts: string[] = []
      const clock = world(on, AGENTS, TRANSCRIPTS, { ran, toasts })
      await start($, clock)
      await (await band($)).press({ key: 'band-wt' })
      expect(ran).toEqual([])
      expect(toasts.some(t => t.includes('zellij'))).toBe(true)
    })
  })
})
