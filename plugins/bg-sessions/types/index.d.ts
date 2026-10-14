/**
 * running: 作業中 / waiting: 入力待ちなど作業していない / done: 作業を終えて止まっている（agents の state が done）/
 * stale: 作業しておらず 3 日以上 transcript が更新されていない
 */
export type BgStatus = 'running' | 'waiting' | 'done' | 'stale'

export type BgSession = {
  id: string
  name: string
  status: BgStatus
  repo: string
  /** `.claude/worktrees/<name>` にいるときの name。repo の root なら null */
  worktree: string | null
  branch: string | null
  /** transcript の最終行の cwd。読めなければ起動時の cwd */
  cwd: string
  /** transcript の最終更新（ms）。transcript が無ければ起動時刻 */
  updatedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'bg-sessions': {
      /** null は未取得 */
      sessions: BgSession[] | null
      /** 取得した時刻（ms）。「更新」列の経過時間の基準 */
      checkedAt: number
      showStale: boolean
      /** このセッション自身が bg セッション（attach して見ている）ならその id と起動時の cwd、対話セッションなら null */
      selfBackground: { id: string; cwd: string } | null
      /** `claude agents --json` が失敗したときの理由 */
      error: string | null
    }
  }
}
