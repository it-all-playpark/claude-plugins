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
    const rows = parseAgents(listed.stdout).filter(r => r.kind === 'background' && r.sessionId !== self)
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

/** repo と同じ名前の zellij セッションへ移る。zellij の外・同名セッションが無いときは toast だけで何もしない */
async function switchTo($: Engine, s: BgSession): Promise<void> {
  if (!(await $.env.get('ZELLIJ'))) {
    $.ui.toast('bg-sessions: zellij の中で動いていないので移動できません')
    return
  }
  try {
    const listed = await $.process.run(['zellij', 'list-sessions', '--short', '--no-formatting'], { timeoutMs: 5000 })
    const target = listed.exitCode === 0 ? zellijSessionFor(s.repo, listed.stdout) : null
    if (!target) {
      $.ui.toast(`bg-sessions: ${s.repo} の zellij セッションがありません`)
      return
    }
    const moved = await $.process.run(['zellij', 'action', 'switch-session', target], { timeoutMs: 5000 })
    if (moved.exitCode !== 0) {
      $.ui.toast(`bg-sessions: ${target} へ移動できませんでした: ${moved.stderr.trim() || `exit ${moved.exitCode}`}`)
      return
    }
    await $.ui.close({ id: PANE })
  } catch (err) {
    $.ui.toast(`bg-sessions: zellij を実行できませんでした: ${String(err)}`)
  }
}

async function openList($: Engine): Promise<void> {
  void refresh($)
  await $.ui.open({ id: PANE, title: 'bg sessions', focus: true, closeOnEscape: true })
}

const LABEL = { running: '実行中  ', waiting: '入力待ち', stale: '放置    ' } as const
const MARK = { running: '●', waiting: '◐', stale: '○' } as const
const COLOR = { running: 'success', waiting: 'warning', stale: 'inactive' } as const

export const register: Register = (on, options) => {
  const zellijSwitch = options.zellij_switch === true

  on('session.start', async ($, e, next) => {
    void refresh($)
    $.clock.every(POLL_MS, () => void refresh($))
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
    const running = list.filter(s => s.status === 'running')
    const waiting = list.filter(s => s.status === 'waiting')
    const stale = list.filter(s => s.status === 'stale')
    // 放置しかないときは出さない
    if (running.length + waiting.length === 0) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const wide = e.props.bodyColumns >= 80
    return (
      <Box key="bg-band" flexDirection="row" gap={2}>
        <Text wrap="truncate-end">
          <Text dimColor>bg </Text>
          <Text color="success">● {wide ? `${running.length} 実行中` : running.length}</Text>
          {wide && running.length > 0 ? ` ${running.map(where).join(' · ')}` : ''}
          {'  '}
          <Text color="warning">◐ {wide ? `${waiting.length} 入力待ち` : waiting.length}</Text>
          {'  '}
          <Text dimColor>○ {wide ? `${stale.length} 放置` : stale.length}</Text>
        </Text>
        {/* ctrl+x tab で帯にフォーカスしたら Enter で一覧が開くよう、ここに初期フォーカスを置く */}
        <Button key="bg-open" label="一覧" hotkey="b" plain autoFocus onPress={() => openList($)} />
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
        {shown.map((s, i) => {
          const cells = [
            <Text color={COLOR[s.status]}>{MARK[s.status]} {wide ? LABEL[s.status] : ''}</Text>,
            ` ${pad(s.repo, 16)} ${pad(s.worktree ?? '—', 12)} `,
            wide ? <Text dimColor>{pad(s.branch ?? '', 22)} </Text> : '',
            <Text dimColor>{pad(ago(now - s.updatedAt), 5)}</Text>,
            wide ? ` ${s.name}` : '',
          ]
          // 数字の hotkey はフォーカスを取るこのペインだけに付ける（帯に付けると空の composer で数字を打つと押される）
          return zellijSwitch ? (
            <Button
              key={s.id}
              plain
              {...(i < 9 ? { hotkey: String(i + 1) } : {})}
              {...(i === 0 ? { autoFocus: true as const } : {})}
              onPress={() => switchTo($, s)}
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
            hotkey="s"
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
