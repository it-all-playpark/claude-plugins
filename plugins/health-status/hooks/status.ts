/** 最終実行からこれ以上経った dev-flow-health は止まっているとみなす（日次の実行に 2 時間の遅れを許す） */
export const STALE_MS = 26 * 60 * 60 * 1000

export type HealthReport = { generatedAt: number; new: number; regressed: number }
export type SandboxRun = { ts: number; remaining: number } | { ts: number; error: string }

/** 1 行 1 JSON のログを object の行だけにする。壊れた行・空行は読み飛ばす */
function jsonLines(text: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line)
      if (row && typeof row === 'object' && !Array.isArray(row)) rows.push(row)
    } catch {
      // 書きかけ・壊れた行
    }
  }
  return rows
}

/** dev-flow-health のログ（`{"report":"<path>",...}` の行）の最終行が指す report のパス */
export function reportPathOf(log: string): string | undefined {
  const report = jsonLines(log).at(-1)?.report
  return typeof report === 'string' && report !== '' ? report : undefined
}

/** report JSON の generated_at と summary.new / summary.regressed。読めなければ undefined */
export function parseReport(text: string): HealthReport | undefined {
  try {
    const r = JSON.parse(text)
    const generatedAt = Date.parse(r?.generated_at)
    if (Number.isNaN(generatedAt)) return undefined
    return { generatedAt, new: Number(r.summary?.new) || 0, regressed: Number(r.summary?.regressed) || 0 }
  } catch {
    return undefined
  }
}

/** sandbox-tune の runs.jsonl の行。成功行は ts と remaining、失敗行は ts と error を持つ */
export function parseRuns(text: string): SandboxRun[] {
  const runs: SandboxRun[] = []
  for (const row of jsonLines(text)) {
    const ts = typeof row.ts === 'string' ? Date.parse(row.ts) : Number.NaN
    if (Number.isNaN(ts)) continue
    if (row.error !== undefined && row.error !== null) runs.push({ ts, error: String(row.error) })
    else if (typeof row.remaining === 'number') runs.push({ ts, remaining: row.remaining })
  }
  return runs
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return '今'
  if (s < 3600) return `${Math.floor(s / 60)}m前`
  if (s < 86400) return `${Math.floor(s / 3600)}h前`
  return `${Math.floor(s / 86400)}d前`
}

/** dev-flow-health の部分。最終実行は report の generated_at が新しい方で決める */
export function healthPart(reports: (HealthReport | undefined)[], now: number): string | undefined {
  const latest = reports.reduce<HealthReport | undefined>(
    (best, r) => (r && (!best || r.generatedAt > best.generatedAt) ? r : best),
    undefined,
  )
  if (!latest) return undefined
  const age = ago(now - latest.generatedAt)
  const found = [latest.new > 0 ? `new${latest.new}` : '', latest.regressed > 0 ? `regressed${latest.regressed}` : '']
    .filter(Boolean)
    .join(' ')
  if (found) return `health ⚠ ${found} ${age}`
  if (now - latest.generatedAt > STALE_MS) return `health ⚠ 止まっている? ${age}`
  return `health ✓ ${age}`
}

/** sandbox-tune の部分。残りの増減は直前の成功行と比べる */
export function sandboxPart(runs: SandboxRun[], now: number): string | undefined {
  const last = runs.at(-1)
  if (!last) return undefined
  const age = ago(now - last.ts)
  if ('error' in last) return `sbx ⚠ 失敗 ${age}`
  const prev = runs.slice(0, -1).findLast((r): r is { ts: number; remaining: number } => 'remaining' in r)
  if (!prev) return `sbx 残${last.remaining} ${age}`
  const d = last.remaining - prev.remaining
  return `sbx 残${last.remaining}(${d > 0 ? '+' : d < 0 ? '-' : '±'}${Math.abs(d)}) ${age}`
}

export type Inputs = {
  /** 2 つの dev-flow-health ログの最終行が指す report の中身。読めなかったものは undefined */
  reports: (string | undefined)[]
  /** runs.jsonl の中身。無ければ undefined */
  runs: string | undefined
  now: number
}

/** status line の 1 行。どちらも出すものが無ければ undefined（status を出さない） */
export function statusText({ reports, runs, now }: Inputs): string | undefined {
  const parts = [
    healthPart(reports.map(r => (r === undefined ? undefined : parseReport(r))), now),
    runs === undefined ? undefined : sandboxPart(parseRuns(runs), now),
  ].filter((p): p is string => p !== undefined)
  return parts.length > 0 ? parts.join(' · ') : undefined
}
