import { describe, expect, mock, test } from 'claude-code/testing'

import { statusText } from '../hooks/status'

const NOW = Date.parse('2026-10-19T12:00:00Z')
const HOUR = 60 * 60 * 1000
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')

const LOGS = '/Users/x/.claude/logs'
const DAILY_LOG = `${LOGS}/dev-flow-health.log`
const WATCH_LOG = `${LOGS}/dev-flow-health.watch-journal.log`
const RUNS = `${LOGS}/sandbox-tune/runs.jsonl`

/** health-report.sh が書く report JSON（使うのは generated_at と summary だけ） */
const report = (hoursAgo: number, summary: Partial<Record<'new' | 'regressed' | 'ongoing' | 'resolved', number>> = {}) =>
  JSON.stringify({ generated_at: iso(NOW - hoursAgo * HOUR), summary: { new: 0, regressed: 0, ongoing: 3, resolved: 1, ...summary } })
/** daily.sh が dev-flow-health のログに追記する 1 行 */
const logLine = (path: string) => JSON.stringify({ report: path, needs_llm: false, llm_invoked: false })
const run = (hoursAgo: number, row: { remaining: number } | { error: string }) => JSON.stringify({ ts: iso(NOW - hoursAgo * HOUR), ...row })
const jsonl = (...rows: string[]) => rows.join('\n') + '\n'

describe('statusText', () => {
  test('dev-flow-health が新しく new / regressed も無ければ ✓ と経過時間', () => {
    expect(statusText({ reports: [report(2)], runs: undefined, now: NOW })).toBe('health ✓ 2h前')
  })

  test('最終実行が 26 時間より古ければ警告にする（26 時間ちょうどまでは ✓）', () => {
    expect(statusText({ reports: [report(26)], runs: undefined, now: NOW })).toBe('health ✓ 1d前')
    expect(statusText({ reports: [report(27)], runs: undefined, now: NOW })).toBe('health ⚠ 止まっている? 1d前')
  })

  test('summary.new か summary.regressed が 1 以上なら警告と件数', () => {
    expect(statusText({ reports: [report(2, { new: 1 })], runs: undefined, now: NOW })).toBe('health ⚠ new1 2h前')
    expect(statusText({ reports: [report(2, { regressed: 3 })], runs: undefined, now: NOW })).toBe('health ⚠ regressed3 2h前')
    expect(statusText({ reports: [report(2, { new: 2, regressed: 1 })], runs: undefined, now: NOW })).toBe('health ⚠ new2 regressed1 2h前')
  })

  test('2 つのログが指す report のうち generated_at が新しい方で決める', () => {
    const fresh = report(2)
    const old = report(30, { new: 4 })
    expect(statusText({ reports: [fresh, old], runs: undefined, now: NOW })).toBe('health ✓ 2h前')
    expect(statusText({ reports: [old, fresh], runs: undefined, now: NOW })).toBe('health ✓ 2h前')
  })

  test('sandbox-tune の最終行が remaining を持てば残りと、直前の成功行からの増減', () => {
    const runs = jsonl(run(50, { remaining: 3 }), run(26, { error: 'boom' }), run(3, { remaining: 5 }))
    expect(statusText({ reports: [], runs, now: NOW })).toBe('sbx 残5(+2) 3h前')
    expect(statusText({ reports: [], runs: jsonl(run(5, { remaining: 4 }), run(3, { remaining: 1 })), now: NOW })).toBe('sbx 残1(-3) 3h前')
    expect(statusText({ reports: [], runs: jsonl(run(5, { remaining: 4 }), run(3, { remaining: 4 })), now: NOW })).toBe('sbx 残4(±0) 3h前')
    // 比べる成功行が無ければ増減は出さない
    expect(statusText({ reports: [], runs: jsonl(run(3, { remaining: 5 })), now: NOW })).toBe('sbx 残5 3h前')
  })

  test('sandbox-tune の最終行が error を持てば警告', () => {
    const runs = jsonl(run(26, { remaining: 5 }), run(3, { error: 'claude exited 1' }))
    expect(statusText({ reports: [], runs, now: NOW })).toBe('sbx ⚠ 失敗 3h前')
  })

  test('両方あれば health・sbx の順に 1 行に並べる', () => {
    expect(statusText({ reports: [report(2)], runs: jsonl(run(26, { remaining: 3 }), run(3, { remaining: 5 })), now: NOW }))
      .toBe('health ✓ 2h前 · sbx 残5(+2) 3h前')
  })

  test('片方だけあればその部分だけを出す', () => {
    expect(statusText({ reports: [report(2), undefined], runs: undefined, now: NOW })).toBe('health ✓ 2h前')
    expect(statusText({ reports: [undefined, undefined], runs: jsonl(run(3, { remaining: 5 })), now: NOW })).toBe('sbx 残5 3h前')
  })

  test('両方とも無ければ status を出さない（undefined）', () => {
    expect(statusText({ reports: [undefined, undefined], runs: undefined, now: NOW })).toBeUndefined()
    expect(statusText({ reports: [], runs: '', now: NOW })).toBeUndefined()
  })

  test('壊れた report・runs.jsonl の壊れた行は例外を投げずにその部分を出さない', () => {
    expect(statusText({ reports: ['{not json', JSON.stringify({ summary: {} })], runs: '{"ts":', now: NOW })).toBeUndefined()
    // 書きかけの最終行は読み飛ばし、その前の行で出す
    expect(statusText({ reports: [], runs: jsonl(run(3, { remaining: 5 }), '{"ts":"2026-'), now: NOW })).toBe('sbx 残5 3h前')
  })
})

type World = { files: Record<string, string>; statuses: (string | undefined)[]; effects: string[]; clock: any }

/** HOME・時計・読めるファイルを決め、status line への書き込みとそれ以外の副作用を記録する世界 */
function world(on: any, files: Record<string, string>): World {
  mock.env(on, { HOME: '/Users/x' })
  const w: World = { files, statuses: [], effects: [], clock: mock.clock(on, { now: NOW }) }
  on('session.start', async ($: any, e: any) => e)
  on('fs.read', async ($: any, e: any) => (e.path in w.files ? { value: w.files[e.path] } : { deny: `ENOENT: ${e.path}` }))
  on('ui.status', async ($: any, e: any) => {
    w.statuses.push(e.text)
    return { value: undefined }
  })
  for (const effect of ['process.run', 'fs.write', 'http.fetch', 'ui.toast', 'store.set']) {
    on(effect, async () => {
      w.effects.push(effect)
      return { deny: `${effect} is not allowed` }
    })
  }
  return w
}

async function start($: any, w: World) {
  await $.session.start({ cwd: '/Users/x/ghq/acme/app' } as any)
  // session.start が投げた初回の読み込みを待つ
  await w.clock.advance(0)
}

describe('health-status', () => {
  test('session.start で HOME の下のログを読み、status line に出す', async ($, on) => {
    const w = world(on, {
      [DAILY_LOG]: jsonl(logLine('/Users/x/r/old.json'), logLine('/Users/x/r/daily.json')),
      '/Users/x/r/old.json': report(50),
      '/Users/x/r/daily.json': report(2),
      [RUNS]: jsonl(run(26, { remaining: 3 }), run(3, { remaining: 5 })),
    })
    await start($, w)
    expect(w.statuses.at(-1)).toBe('health ✓ 2h前 · sbx 残5(+2) 3h前')
    expect(w.effects).toEqual([])
  })

  test('2 つのログの最終行が指す report のうち generated_at が新しい方を出す（新旧を入れ替えても同じ）', async ($, on) => {
    const reports = { '/Users/x/r/a.json': report(1), '/Users/x/r/b.json': report(30, { regressed: 2 }) }
    const w = world(on, { ...reports, [DAILY_LOG]: jsonl(logLine('/Users/x/r/a.json')), [WATCH_LOG]: jsonl(logLine('/Users/x/r/b.json')) })
    await start($, w)
    expect(w.statuses.at(-1)).toBe('health ✓ 1h前')

    w.files[DAILY_LOG] = jsonl(logLine('/Users/x/r/b.json'))
    w.files[WATCH_LOG] = jsonl(logLine('/Users/x/r/a.json'))
    await w.clock.advance(5 * 60_000)
    expect(w.statuses.at(-1)).toBe('health ✓ 1h前')

    // 新しい方が警告を持てばそれを出す
    w.files['/Users/x/r/a.json'] = report(1, { new: 1 })
    await w.clock.advance(5 * 60_000)
    expect(w.statuses.at(-1)).toBe('health ⚠ new1 1h前')
  })

  test('runs.jsonl が無ければ dev-flow-health の部分だけを出す', async ($, on) => {
    const w = world(on, { [WATCH_LOG]: jsonl(logLine('/Users/x/r/w.json')), '/Users/x/r/w.json': report(2) })
    await start($, w)
    expect(w.statuses.at(-1)).toBe('health ✓ 2h前')
  })

  test('どのファイルも無ければ status を出さない', async ($, on) => {
    const w = world(on, {})
    await start($, w)
    expect(w.statuses).toEqual([undefined])
    expect(w.effects).toEqual([])
  })

  test('5 分ごとに読み直して status を更新し、読む以外の副作用を持たない', async ($, on) => {
    const w = world(on, { [DAILY_LOG]: jsonl(logLine('/Users/x/r/d.json')), '/Users/x/r/d.json': report(2) })
    await start($, w)
    expect(w.statuses).toEqual(['health ✓ 2h前'])

    // 5 分経つまでは読み直さない
    await w.clock.advance(4 * 60_000)
    expect(w.statuses).toHaveLength(1)

    w.files[RUNS] = jsonl(run(0, { error: 'boom' }))
    await w.clock.advance(60_000)
    expect(w.statuses).toEqual(['health ✓ 2h前', 'health ✓ 2h前 · sbx ⚠ 失敗 5m前'])
    expect(w.effects).toEqual([])
  })
})
