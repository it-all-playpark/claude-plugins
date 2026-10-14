import type { EngineInterface, Register } from 'claude-code'

import { candidates, checkArgv, failure, fetchArgv, keygenArgv, keyPath, localPath, setupHint, splice } from './paste'
import type { Fetched, Rewrite, Word } from './paste'

type Setup = { host: string; dir: string; key: string }

// The host lives in this machine's plugin store, not in settings.json: it names
// the Mac this one is reached from, which is per machine, and settings files
// are often shared across machines or published (dotfiles).
async function loadSetup($: EngineInterface, configuredDir: string): Promise<Setup> {
  const home = (await $.env.get('HOME')) ?? ''
  const stored = await $.store.get('host')
  return {
    host: typeof stored === 'string' ? stored : '',
    // A per-user directory by default, never a shared one like /tmp.
    dir: configuredDir || `${home}/.cache/mosh-paste`,
    key: keyPath(home),
  }
}

// Replaces each path in `text` that is missing here with a local copy, fetching
// it unless a copy from an earlier fetch is already there; undefined when the
// text holds no such path.
async function localize($: EngineInterface, text: string, s: Setup): Promise<Rewrite | undefined> {
  const missing: Word[] = []
  for (const word of candidates(text)) {
    if (!(await $.fs.exists(word.value))) missing.push(word)
  }
  if (missing.length === 0) return undefined

  const results: Fetched[] = await Promise.all(
    missing.map(async word => {
      const dest = localPath(s.dir, word.value)
      if (await $.fs.exists(dest)) return { word, dest }
      const r = await $.process
        .run(fetchArgv(s.host, word.value, dest, s.key), { timeoutMs: 20_000 })
        .catch((err: unknown) => ({ exitCode: -1, stderr: String(err) }))
      return { word, dest, error: failure(r) }
    }),
  )
  return splice(text, results)
}

// Creates the key only when asked to (this command), then checks the host.
async function setup($: EngineInterface, args: string, configuredDir: string): Promise<string> {
  const s = await loadSetup($, configuredDir)
  const host = args.trim() || s.host
  if (host === '') {
    return '使い方: /mosh-paste-setup <手元の Mac の ssh 接続先>（例: /mosh-paste-setup my-mac.example.ts.net）'
  }
  await $.store.set('host', host)

  if (!(await $.fs.exists(s.key))) {
    const r = await $.process.run(keygenArgv(s.key))
    const error = failure(r)
    if (error !== undefined) return `鍵 ${s.key} を作れなかった (${error})`
  }

  const r = await $.process
    .run(checkArgv(host, s.key), { timeoutMs: 20_000 })
    .catch((err: unknown) => ({ exitCode: -1, stderr: String(err) }))
  const error = failure(r)
  if (error !== undefined) return setupHint(host, s.key, error)
  return `${host} に鍵で入れた。設定完了（このマシンにだけ保存）`
}

export const register: Register = (on, options) => {
  const configuredDir = String(options.dir ?? '').trim().replace(/\/+$/, '')

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'mosh-paste-setup',
      description: 'mosh-paste: 手元の Mac の ssh 接続先を設定し、専用の鍵を作って接続を確かめる',
    })
    return next(e)
  })

  on('command.run', { command: 'mosh-paste-setup' }, async ($, e) => ({
    text: await setup($, e.args, configuredDir),
  }))

  // At paste time: fetch and show the local path in the box. A paste (or a
  // burst folded into one edit) has no single key; a typed key never holds a
  // whole path, so it is passed through untouched.
  on('prompt.edit', async ($, e, next) => {
    if (e.key !== undefined || !e.inputText.includes('/')) return next(e)

    const s = await loadSetup($, configuredDir)
    if (s.host === '') return next(e)
    const r = await localize($, e.inputText, s)
    if (r === undefined) return next(e)

    if (r.failed.length > 0) {
      $.ui.toast(`mosh-paste: ${s.host} から取得できなかった (${r.failed[0].reason})。/mosh-paste-setup で確認できる`)
    } else {
      $.ui.toast(`mosh-paste: ${s.host} から ${r.fetched.length} 件を ${s.dir} に取得`)
    }
    return next({ ...e, inputText: r.text })
  })

  // At submit time: the box can be submitted before the paste's fetch lands,
  // and then the box keeps the client Mac's path. The copy fetched at paste
  // time is reused, so this only fetches what the paste did not.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind !== 'composer' || !e.text.includes('/')) return next(e)

    const s = await loadSetup($, configuredDir)
    if (s.host === '') return next(e)
    const r = await localize($, e.text, s)
    if (r === undefined) return next(e)

    if (r.failed.length > 0) {
      $.ui.toast(`mosh-paste: ${s.host} から取得できなかった (${r.failed[0].reason})。/mosh-paste-setup で確認できる`)
    }
    return next({ ...e, text: r.text })
  })
}
