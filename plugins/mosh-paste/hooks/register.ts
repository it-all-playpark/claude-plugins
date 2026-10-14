import type { Register } from 'claude-code'

import { candidates, failure, fetchArgv, localPath, splice } from './paste'
import type { Fetched, Word } from './paste'

export const register: Register = (on, options) => {
  const host = String(options.host ?? '').trim()
  const configuredDir = String(options.dir ?? '').trim().replace(/\/+$/, '')

  // A paste (or a burst folded into one edit) has no single key; a typed key
  // never holds a whole path, so it is passed through untouched.
  on('prompt.edit', async ($, e, next) => {
    if (host === '' || e.key !== undefined || !e.inputText.includes('/')) return next(e)

    // A per-user directory by default, never a shared one like /tmp.
    const dir = configuredDir || `${await $.env.get('HOME')}/.cache/mosh-paste`
    const missing: Word[] = []
    for (const word of candidates(e.inputText)) {
      if (!(await $.fs.exists(word.value))) missing.push(word)
    }
    if (missing.length === 0) return next(e)

    const results: Fetched[] = await Promise.all(
      missing.map(async word => {
        const dest = localPath(dir, word.value)
        const r = await $.process
          .run(fetchArgv(host, word.value, dest), { timeoutMs: 20_000 })
          .catch((err: unknown) => ({ exitCode: -1, stderr: String(err) }))
        return { word, dest, error: failure(r) }
      }),
    )
    const r = splice(e.inputText, results)

    if (r.failed.length > 0) {
      $.ui.toast(`mosh-paste: ${host} から取得できなかった (${r.failed[0].reason})`)
    } else {
      $.ui.toast(`mosh-paste: ${host} から ${r.fetched.length} 件を ${dir} に取得`)
    }
    return next({ ...e, inputText: r.text })
  })
}
