import type { EngineInterface, Register } from 'claude-code'

import { candidates, failure, fetchArgv, localPath, splice } from './paste'
import type { Fetched, Rewrite, Word } from './paste'

// Replaces each path in `text` that is missing here with a local copy, fetching
// it unless a copy from an earlier fetch is already there; undefined when the
// text holds no such path.
async function localize(
  $: EngineInterface,
  text: string,
  host: string,
  dir: string,
): Promise<Rewrite | undefined> {
  const missing: Word[] = []
  for (const word of candidates(text)) {
    if (!(await $.fs.exists(word.value))) missing.push(word)
  }
  if (missing.length === 0) return undefined

  const results: Fetched[] = await Promise.all(
    missing.map(async word => {
      const dest = localPath(dir, word.value)
      if (await $.fs.exists(dest)) return { word, dest }
      const r = await $.process
        .run(fetchArgv(host, word.value, dest), { timeoutMs: 20_000 })
        .catch((err: unknown) => ({ exitCode: -1, stderr: String(err) }))
      return { word, dest, error: failure(r) }
    }),
  )
  return splice(text, results)
}

// A per-user directory by default, never a shared one like /tmp.
async function copyDir($: EngineInterface, configured: string): Promise<string> {
  return configured || `${await $.env.get('HOME')}/.cache/mosh-paste`
}

export const register: Register = (on, options) => {
  const host = String(options.host ?? '').trim()
  const configuredDir = String(options.dir ?? '').trim().replace(/\/+$/, '')

  // At paste time: fetch and show the local path in the box. A paste (or a
  // burst folded into one edit) has no single key; a typed key never holds a
  // whole path, so it is passed through untouched.
  on('prompt.edit', async ($, e, next) => {
    if (host === '' || e.key !== undefined || !e.inputText.includes('/')) return next(e)

    const dir = await copyDir($, configuredDir)
    const r = await localize($, e.inputText, host, dir)
    if (r === undefined) return next(e)

    if (r.failed.length > 0) {
      $.ui.toast(`mosh-paste: ${host} から取得できなかった (${r.failed[0].reason})`)
    } else {
      $.ui.toast(`mosh-paste: ${host} から ${r.fetched.length} 件を ${dir} に取得`)
    }
    return next({ ...e, inputText: r.text })
  })

  // At submit time: the box can be submitted before the paste's fetch lands,
  // and then the box keeps the client Mac's path. The copy fetched at paste
  // time is reused, so this only fetches what the paste did not.
  on('prompt.submit', async ($, e, next) => {
    if (host === '' || e.origin.kind !== 'composer' || !e.text.includes('/')) return next(e)

    const r = await localize($, e.text, host, await copyDir($, configuredDir))
    if (r === undefined) return next(e)

    if (r.failed.length > 0) {
      $.ui.toast(`mosh-paste: ${host} から取得できなかった (${r.failed[0].reason})`)
    }
    return next({ ...e, text: r.text })
  })
}
