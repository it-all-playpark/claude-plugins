import type { Engine, Register } from 'claude-code'

import { reportPathOf, statusText } from './status'

/** 日次の実行を見張るだけなので、数分おきに読み直せば足りる */
const POLL_MS = 5 * 60_000

/** 無い・読めないファイルは undefined（その部分を出さないだけ） */
async function readText($: Engine, path: string): Promise<string | undefined> {
  try {
    return await $.fs.read(path)
  } catch {
    return undefined
  }
}

async function reportOf($: Engine, log: string): Promise<string | undefined> {
  const text = await readText($, log)
  const path = text === undefined ? undefined : reportPathOf(text)
  return path === undefined ? undefined : readText($, path)
}

/** ログを読み直して status line を書き換える。読むのは $.fs.read だけで、何も書かない・起動しない */
async function refresh($: Engine): Promise<void> {
  try {
    const logs = `${await $.env.get('HOME')}/.claude/logs`
    const [daily, watch, runs] = await Promise.all([
      reportOf($, `${logs}/dev-flow-health.log`),
      reportOf($, `${logs}/dev-flow-health.watch-journal.log`),
      readText($, `${logs}/sandbox-tune/runs.jsonl`),
    ])
    $.ui.status(statusText({ reports: [daily, watch], runs, now: await $.clock.now() }))
  } catch {
    // 表示できないだけで、セッションは止めない
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    void refresh($)
    $.clock.every(POLL_MS, () => void refresh($))
    return next(e)
  })
}
