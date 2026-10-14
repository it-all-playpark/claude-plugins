import { atom, read, update } from 'claude-code'
import type { Engine, Register } from 'claude-code'

import type { BgSession } from '../types'
import {
  type AgentRow,
  STALE_MS,
  ago,
  isProjectDirOf,
  lastLocation,
  pad,
  parseAgents,
  showsSession,
  sortSessions,
  toSession,
  where,
  zellijSessionFor,
} from './sessions'

const PANE = 'bg-sessions'
const POLL_MS = 15_000

const sessions = atom({ plugin: 'bg-sessions', key: 'sessions' } as const, null)
const checkedAt = atom({ plugin: 'bg-sessions', key: 'checkedAt' } as const, 0)
const showStale = atom({ plugin: 'bg-sessions', key: 'showStale' } as const, false)
const error = atom({ plugin: 'bg-sessions', key: 'error' } as const, null)
const selfBackground = atom({ plugin: 'bg-sessions', key: 'selfBackground' } as const, null)

let refreshing = false

async function projectsDir($: Engine): Promise<string> {
  const config = await $.env.get('CLAUDE_CONFIG_DIR')
  return `${config ?? `${await $.env.get('HOME')}/.claude`}/projects`
}

/** 起動時の cwd とその worktree の project ディレクトリから、いちばん新しい transcript を探す */
async function newestTranscript($: Engine, projects: string, dirs: string[], row: AgentRow) {
  let best: { path: string; mtimeMs: number } | null = null
  for (const dir of dirs) {
    if (!isProjectDirOf(dir, row.cwd)) continue
    const path = `${projects}/${dir}/${row.sessionId}.jsonl`
    try {
      const st = await $.fs.stat(path)
      if (st.kind === 'file' && (!best || st.mtimeMs > best.mtimeMs)) best = { path, mtimeMs: st.mtimeMs }
    } catch {
      // このディレクトリには無い
    }
  }
  return best
}

async function locate($: Engine, projects: string, dirs: string[], row: AgentRow, now: number): Promise<BgSession> {
  const found = await newestTranscript($, projects, dirs, row)
  const updatedAt = found?.mtimeMs ?? row.startedAt
  // 放置中のものは場所を読み直さない（件数しか出さないので）
  if (!found || (row.state !== 'working' && now - updatedAt >= STALE_MS)) return toSession(row, {}, updatedAt, now)
  try {
    const tail = await $.process.run(['tail', '-n', '50', found.path], { timeoutMs: 5000 })
    return toSession(row, lastLocation(tail.stdout), updatedAt, now)
  } catch {
    return toSession(row, {}, updatedAt, now)
  }
}

async function refresh($: Engine): Promise<void> {
  if (refreshing) return
  refreshing = true
  try {
    const listed = await $.process.run(['claude', 'agents', '--json'], { timeoutMs: 15_000 })
    if (listed.exitCode !== 0) {
      await update($, error, () => listed.stderr.trim() || `claude agents --json: exit ${listed.exitCode}`)
      return
    }
    const self = await $.session.id()
    const all = parseAgents(listed.stdout)
    const rows = all.filter(r => r.kind === 'background' && r.sessionId !== self)
    const me = all.find(r => r.kind === 'background' && r.sessionId === self)
    await update($, selfBackground, () => (me ? { id: me.id, cwd: me.cwd } : null))
    const projects = await projectsDir($)
    let dirs: string[] = []
    try {
      dirs = (await $.fs.list(projects)).filter(d => d.kind === 'dir').map(d => d.name)
    } catch {
      // transcript が無い環境でも一覧は出す
    }
    const now = await $.clock.now()
    const list = await Promise.all(rows.map(r => locate($, projects, dirs, r, now)))
    await update($, sessions, () => sortSessions(list))
    await update($, checkedAt, () => now)
    await update($, error, () => null)
  } catch (err) {
    await update($, error, () => String(err))
  } finally {
    refreshing = false
  }
}

/**
 * bg セッションを表示している client がいる zellij セッション。bg セッションは daemon が起動していて zellij の外で動き、
 * 環境の ZELLIJ_SESSION_NAME も daemon 起動時の古い値なので、全セッションの client 一覧から見ている側を探す。
 * 一致の最も強いセッションを返す（候補が無ければ空、最上位が複数なら全部。どちらも呼び出し側で宛先を決めない）
 */
async function viewerSessions($: Engine, self: { id: string; cwd: string }): Promise<string[]> {
  const listed = await $.process.run(['zellij', 'list-sessions', '--short', '--no-formatting'], { timeoutMs: 5000 })
  if (listed.exitCode !== 0) return []
  const names = listed.stdout.split('\n').map(l => l.trim()).filter(Boolean)
  const strength = await Promise.all(names.map(async name => {
    try {
      const clients = await $.process.run(['zellij', '--session', name, 'action', 'list-clients'], { timeoutMs: 3000 })
      // 終了済み（EXITED）のセッションは失敗する
      return clients.exitCode === 0 ? showsSession(clients.stdout, self) : 0
    } catch {
      return 0
    }
  }))
  const best = Math.max(0, ...strength)
  return best === 0 ? [] : names.filter((_, i) => strength[i] === best)
}

/**
 * zellij の action を送る宛先。対話セッションは自分のいる zellij。bg セッションは自分を表示している zellij で、
 * 外から送るので --session で宛先を決める（宛先でフォーカスしている client・pane に効く）。見つからなければ知らせて null
 */
async function zellijHome($: Engine): Promise<{ session: string | undefined; argv: string[] } | null> {
  const bg = await read($, selfBackground)
  if (!bg) {
    if (await $.env.get('ZELLIJ')) return { session: await $.env.get('ZELLIJ_SESSION_NAME'), argv: [] }
    $.ui.toast('bg-sessions: zellij の中で動いていません')
    return null
  }
  const found = await viewerSessions($, bg)
  if (found.length === 1) return { session: found[0], argv: ['--session', found[0]] }
  $.ui.toast(
    found.length === 0
      ? 'bg-sessions: このセッションを表示している zellij が見つかりません'
      : `bg-sessions: このセッションを表示している zellij を 1 つに決められません: ${found.join(', ')}`,
  )
  return null
}

/** repo と同じ名前の zellij セッションへ移る。zellij の外・同名セッションが無いときは toast だけで何もしない */
async function switchTo($: Engine, s: BgSession): Promise<void> {
  try {
    const home = await zellijHome($)
    if (!home) return
    const listed = await $.process.run(['zellij', 'list-sessions', '--short', '--no-formatting'], { timeoutMs: 5000 })
    const target = listed.exitCode === 0 ? zellijSessionFor(s.repo, listed.stdout) : null
    if (!target) {
      $.ui.toast(`bg-sessions: ${s.repo} の zellij セッションがありません`)
      return
    }
    // 今いるセッションへの switch-session は何も変わらず、押しても反応しないように見える
    if (target === home.session) {
      $.ui.toast(`bg-sessions: すでに ${target} にいます`)
      return
    }
    const moved = await $.process.run(['zellij', ...home.argv, 'action', 'switch-session', target], { timeoutMs: 5000 })
    if (moved.exitCode !== 0) {
      $.ui.toast(`bg-sessions: ${target} へ移動できませんでした: ${moved.stderr.trim() || `exit ${moved.exitCode}`}`)
      return
    }
    await $.ui.close({ id: PANE })
  } catch (err) {
    $.ui.toast(`bg-sessions: zellij を実行できませんでした: ${String(err)}`)
  }
}

/**
 * 今の zellij pane と一時的に入れ替えて claude attach で開く。attach から抜けると（← で agent view に戻ってから閉じる
 * など）コマンドが終わり、--close-on-exit で pane が閉じて元の Claude に戻る。bg セッション自体は動き続ける
 */
async function attachHere($: Engine, s: BgSession): Promise<void> {
  // zellij run の pane は zellij サーバーの環境で起動し、その PATH では claude に届かないことがある（届かないと
  // --close-on-exit で pane が即閉じて何も起きないように見える）。claude を実行できているこのセッションの PATH を渡す
  const path = await $.env.get('PATH')
  const attach = [...(path ? ['env', `PATH=${path}`] : []), 'claude', 'attach', s.id]
  try {
    const home = await zellijHome($)
    if (!home) return
    const opened = await $.process.run(
      ['zellij', ...home.argv, 'run', '--in-place', '--close-on-exit', '--name', `bg ${where(s)}`, '--', ...attach],
      { timeoutMs: 5000 },
    )
    if (opened.exitCode !== 0) {
      $.ui.toast(`bg-sessions: ${s.id} を開けませんでした: ${opened.stderr.trim() || `exit ${opened.exitCode}`}`)
      return
    }
    await $.ui.close({ id: PANE })
  } catch (err) {
    $.ui.toast(`bg-sessions: zellij を実行できませんでした: ${String(err)}`)
  }
}

/** 設定 select_action に応じて、選んだセッションを開くか repo の zellij セッションへ移る */
async function select($: Engine, s: BgSession, action: string): Promise<void> {
  if (action === 'attach') return attachHere($, s)
  if (action === 'zellij-session') return switchTo($, s)
}

/**
 * 描く画面（surface）が無いセッションでは取りに行かない。plugin を入れると bg セッション自身も読み込むので、
 * 絞らないと N 本の bg セッションがそれぞれ 15 秒ごとに claude agents --json と tail を起動する。
 * attach されれば画面が付くので、そこから取り始める
 */
async function refreshIfDrawn($: Engine): Promise<void> {
  if ((await $.session.surfaces()).length === 0) return
  await refresh($)
}

async function openList($: Engine): Promise<void> {
  void refresh($)
  await $.ui.open({ id: PANE, title: 'bg sessions', focus: true, closeOnEscape: true })
}

/**
 * 放置以外（実行中・入力待ち・完了）のセッションに先頭から割り当てる hotkey（vim のホームポジション）。帯と一覧で同じ割り当て。
 * 数字にしないのは、帯の Button の数字 hotkey は空の composer で数字を打っただけで押されるため（英字は帯か
 * ペインがフォーカスを持つときだけ効く）。
 */
const KEYS = ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'] as const
const hotkeyOf = (list: BgSession[], s: BgSession): string | undefined =>
  s.status === 'stale' ? undefined : KEYS[list.filter(x => x.status !== 'stale').indexOf(s)]

const LABEL = { running: '実行中  ', waiting: '入力待ち', done: '完了    ', stale: '放置    ' } as const
const MARK = { running: '●', waiting: '◐', done: '✓', stale: '○' } as const
const COLOR = { running: 'success', waiting: 'warning', done: 'suggestion', stale: 'inactive' } as const

export const register: Register = (on, options) => {
  const action = String(options.select_action ?? 'off')
  const selectable = action === 'attach' || action === 'zellij-session'

  on('session.start', async ($, e, next) => {
    void refreshIfDrawn($)
    $.clock.every(POLL_MS, () => void refreshIfDrawn($))
    // /bg は組み込みの /background の別名で拒否される。登録に失敗しても帯は動かし続ける
    try {
      await $.command.register({ name: 'bg-sessions', description: 'bg で動いている Claude セッションの repo・worktree・branch を一覧する' })
    } catch (err) {
      $.ui.toast(`bg-sessions: /bg-sessions を登録できませんでした: ${String(err)}`)
    }
    return next(e)
  })

  on('command.run', { command: 'bg-sessions' }, async $ => {
    try {
      await openList($)
      return { text: '' }
    } catch (err) {
      return { text: `bg sessions を開けませんでした: ${String(err)}` }
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const list = await read($, sessions)
    if (!list) return next(e)
    const active = list.filter(s => s.status !== 'stale')
    const staleCount = list.length - active.length
    // 放置しかないときは出さない
    if (active.length === 0) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const shown = active.slice(0, KEYS.length)
    const label = (s: BgSession) => [<Text color={COLOR[s.status]}>{MARK[s.status]}</Text>, ` ${where(s)}`]
    // ctrl+x tab で帯にフォーカスすると先頭に乗り、英字 hotkey か Enter で select_action（attach / zellij-session）を実行する
    return (
      <Box key="bg-band" flexDirection="row" flexWrap="wrap" columnGap={2}>
        <Text dimColor>bg</Text>
        {shown.map((s, i) =>
          selectable ? (
            <Button
              key={`band-${s.id}`}
              plain
              hotkey={KEYS[i]}
              {...(i === 0 ? { autoFocus: true as const } : {})}
              onPress={() => select($, s, action)}
            >
              {label(s)}
            </Button>
          ) : (
            <Text>{label(s)}</Text>
          ),
        )}
        {active.length > shown.length && <Text dimColor>+{active.length - shown.length}</Text>}
        {staleCount > 0 && <Text dimColor>○ {staleCount} 放置</Text>}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await read($, sessions)
    const failed = await read($, error)
    if (!list) return <Text dimColor>{failed ? `取得できません: ${failed}` : '読み込み中…'}</Text>

    const now = await read($, checkedAt)
    const withStale = await read($, showStale)
    const staleCount = list.filter(s => s.status === 'stale').length
    const shown = list.filter(s => withStale || s.status !== 'stale')
    const wide = e.props.bodyColumns >= 90

    return (
      <Box flexDirection="column">
        {failed && <Text color="error">更新に失敗しました: {failed}</Text>}
        {shown.length === 0 && <Text dimColor>bg で動いているセッションはありません。</Text>}
        {shown.map(s => {
          const hotkey = hotkeyOf(list, s)
          const cells = [
            <Text color={COLOR[s.status]}>{MARK[s.status]} {wide ? LABEL[s.status] : ''}</Text>,
            ` ${pad(s.repo, 16)} ${pad(s.worktree ?? '—', 12)} `,
            wide ? <Text dimColor>{pad(s.branch ?? '', 22)} </Text> : '',
            <Text dimColor>{pad(ago(now - s.updatedAt), 5)}</Text>,
            wide ? ` ${s.name}` : '',
          ]
          return selectable ? (
            <Button
              key={s.id}
              plain
              {...(hotkey ? { hotkey } : {})}
              {...(hotkey === KEYS[0] ? { autoFocus: true as const } : {})}
              onPress={() => select($, s, action)}
            >
              {cells}
            </Button>
          ) : (
            <Box key={s.id}>
              <Text wrap="truncate-end">{cells}</Text>
            </Box>
          )
        })}
        {staleCount > 0 && (
          <Button
            key="bg-stale"
            hotkey="z"
            plain
            dimColor
            label={withStale ? '放置を隠す' : `放置 ${staleCount} 件（3 日以上更新なし）を表示`}
            onPress={() => update($, showStale, v => !v)}
          />
        )}
      </Box>
    )
  })
}
