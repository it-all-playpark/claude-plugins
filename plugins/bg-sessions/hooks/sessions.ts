import type { BgSession } from '../types'

export const STALE_MS = 3 * 24 * 60 * 60 * 1000

/** `claude agents --json` の 1 行のうち使う項目 */
export type AgentRow = {
  id: string
  sessionId: string
  cwd: string
  kind: string
  state: string
  name: string
  startedAt: number
}

/** 形が合わない行は捨てる（一覧全体を壊さない） */
export function parseAgents(json: string): AgentRow[] {
  const value: unknown = JSON.parse(json)
  if (!Array.isArray(value)) return []
  return value.flatMap(r =>
    r && typeof r.id === 'string' && typeof r.sessionId === 'string' && typeof r.cwd === 'string'
      ? [{
          id: r.id,
          sessionId: r.sessionId,
          cwd: r.cwd,
          kind: String(r.kind ?? ''),
          state: String(r.state ?? ''),
          name: typeof r.name === 'string' ? r.name : '',
          startedAt: typeof r.startedAt === 'number' ? r.startedAt : 0,
        }]
      : [],
  )
}

/**
 * cwd → `~/.claude/projects` 配下のディレクトリ名。英数字以外は '-' になる。
 * worktree に入ったセッションの transcript は worktree の cwd の名前の下に移るので、
 * 起動時の cwd の名前を前方一致の鍵にして探す。
 */
export function projectDirName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-')
}

export function isProjectDirOf(dir: string, cwd: string): boolean {
  const base = projectDirName(cwd)
  return dir === base || dir.startsWith(`${base}-`)
}

/** transcript の末尾行から、最後に記録された cwd と gitBranch を取る */
export function lastLocation(tail: string): { cwd?: string; branch?: string } {
  const lines = tail.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    let row: any
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (row && typeof row.cwd === 'string') {
      return { cwd: row.cwd, branch: typeof row.gitBranch === 'string' && row.gitBranch ? row.gitBranch : undefined }
    }
  }
  return {}
}

/** `<repo>/.claude/worktrees/<name>` なら repo と worktree 名、それ以外は cwd の末尾を repo とする */
export function placeOf(cwd: string): { repo: string; worktree: string | null } {
  const m = cwd.match(/^(.*)\/\.claude\/worktrees\/([^/]+)/)
  const root = (m ? m[1] : cwd).replace(/\/+$/, '')
  return { repo: root.slice(root.lastIndexOf('/') + 1) || root, worktree: m ? m[2] : null }
}

export function toSession(
  row: AgentRow,
  loc: { cwd?: string; branch?: string },
  updatedAt: number,
  now: number,
): BgSession {
  // 起動した場所の中（その repo の worktree・サブディレクトリ）にいるときだけ最後の cwd を使う。
  // Bash で別の repo に cd しただけでも transcript の cwd は移るので、外なら起動した場所を出す
  const inside = loc.cwd !== undefined && (loc.cwd === row.cwd || loc.cwd.startsWith(`${row.cwd.replace(/\/+$/, '')}/`))
  const cwd = inside ? loc.cwd! : row.cwd
  const { repo, worktree } = placeOf(cwd)
  const status = row.state === 'working' ? 'running' : now - updatedAt >= STALE_MS ? 'stale' : 'waiting'
  return { id: row.id, name: row.name, status, repo, worktree, branch: loc.branch ?? null, cwd, updatedAt }
}

const ORDER = { running: 0, waiting: 1, stale: 2 } as const

/** 実行中 → 入力待ち → 放置、同じ状態の中は新しい順 */
export function sortSessions(list: BgSession[]): BgSession[] {
  return [...list].sort((a, b) => ORDER[a.status] - ORDER[b.status] || b.updatedAt - a.updatedAt)
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

/**
 * repo に対応する zellij セッション名。同名を優先し、無ければ '-' と '_' を同一視して探す
 * （zellij はセッション名の '-' を '_' にして作ることがある）。見つからなければ null。
 * 存在しない名前で switch-session すると、その名前の新しいセッションが作られて移動してしまうので、
 * 一覧に無い名前は返さない。
 */
export function zellijSessionFor(repo: string, listed: string): string | null {
  const names = listed.split('\n').map(l => l.trim()).filter(Boolean)
  if (names.includes(repo)) return repo
  const loose = (s: string) => s.replace(/[-_]/g, '-')
  return names.find(n => loose(n) === loose(repo)) ?? null
}

export function where(s: BgSession): string {
  return s.worktree ? `${s.repo}/${s.worktree}` : s.repo
}

/** 等幅で揃える。長い値は末尾を … にする */
export function pad(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width)
}
