import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { candidates, checkArgv, failure, fetchArgv, keygenArgv, keyPath, localPath, setupHint, splice, words } from '../hooks/paste'

const KEY = keyPath('/Users/x')

const SHOT = '/Users/x/Desktop/スクリーンショット 2026-10-14 10.23.45.png'
const SHOT_PASTED = '/Users/x/Desktop/スクリーンショット\\ 2026-10-14\\ 10.23.45.png'
const DEST = '/tmp/mosh-paste/スクリーンショット_2026-10-14_10.23.45.png'

test('a dropped screenshot path is one candidate with its unescaped value', () => {
  const [w, ...rest] = candidates(`${SHOT_PASTED} `)
  expect(rest).toEqual([])
  expect(w).toEqual({ start: 0, end: SHOT_PASTED.length, value: SHOT })
  expect(localPath('/tmp/mosh-paste', w.value)).toBe(DEST)
})

test('relative paths and non-file paths are not candidates', () => {
  expect(candidates('see /usr/local/bin/foo and src/a.png')).toEqual([])
})

test('the fetch command hands host, quoted remote path, dest and the mod key to ssh', () => {
  const argv = fetchArgv('macbook', "/Users/x/it's.png", '/tmp/mosh-paste/it\'s.png', KEY)
  expect(argv.slice(3)).toEqual(['mosh-paste', 'macbook', `'/Users/x/it'\\''s.png'`, "/tmp/mosh-paste/it's.png", KEY])
  expect(argv[2]).toContain('ssh -i "$4" -o IdentitiesOnly=yes -o BatchMode=yes')
})

// The setup command, run as the person would type it; beneath the plugin the
// test stands for HOME, the plugin store, the key file and ssh.
type World = { keyExists: boolean; check: { exitCode: number; stderr: string }; stored?: string }

function world(on: On, w: World) {
  const runs: (readonly string[])[] = []
  const store = new Map<string, unknown>(w.stored === undefined ? [] : [['host', w.stored]])
  // Beneath the plugin, a `$` call's answer is `{ value }`.
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? '/Users/x' : undefined }))
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('fs.exists', ($, e) => ({ value: e.path === KEY ? w.keyExists : false }))
  on('process.run', ($, e) => {
    runs.push(e.argv)
    const out = e.argv[0] === 'ssh' ? w.check : { exitCode: 0, stderr: '' }
    return { value: { ...out, stdout: '' } }
  })
  return { runs, store }
}

test('the setup hint sends a refused key to ssh-copy-id and an unreachable sshd to Remote Login', () => {
  const refused = setupHint('m', KEY, 'naramoto@m: Permission denied (publickey,password,keyboard-interactive).')
  expect(refused).toContain(`ssh-copy-id -o IdentitiesOnly=yes -i ${KEY}.pub m`)
  expect(refused).not.toContain('リモートログイン')

  const unreachable = setupHint('m', KEY, 'ssh: connect to host m port 22: Connection refused')
  expect(unreachable).toContain('リモートログイン')
  expect(unreachable).not.toContain('ssh-copy-id')
})

test('setup without a host asks for one and runs nothing', async ($, on) => {
  const { runs } = world(on, { keyExists: false, check: { exitCode: 0, stderr: '' } })
  const r = await $.command.run({ command: 'mosh-paste-setup', args: '' })
  expect(r.text).toContain('使い方: /mosh-paste-setup')
  expect(runs).toEqual([])
})

test('setup stores the host, makes the key and hands over the one ssh-copy-id line when the key is not in yet', async ($, on) => {
  const { runs, store } = world(on, {
    keyExists: false,
    check: { exitCode: 255, stderr: 'Received disconnect from 100.64.0.1 port 22:2: Too many authentication failures\n' },
  })
  const r = await $.command.run({ command: 'mosh-paste-setup', args: ' my-mac.example.ts.net ' })
  expect(store.get('host')).toBe('my-mac.example.ts.net')
  expect(runs[0]).toEqual(keygenArgv(KEY))
  expect(runs[1]).toEqual(checkArgv('my-mac.example.ts.net', KEY))
  expect(r.text).toContain(`ssh-copy-id -o IdentitiesOnly=yes -i ${KEY}.pub my-mac.example.ts.net`)
  expect(r.text).toContain('Too many authentication failures')
})

test('setup again with the stored host and a working key reports done without making a key', async ($, on) => {
  const { runs } = world(on, { keyExists: true, check: { exitCode: 0, stderr: '' }, stored: 'my-mac.example.ts.net' })
  const r = await $.command.run({ command: 'mosh-paste-setup', args: '' })
  expect(runs).toEqual([checkArgv('my-mac.example.ts.net', KEY)])
  expect(r.text).toContain('設定完了')
})

test('a successful fetch replaces the path with the escaped local copy', () => {
  const [word] = candidates(`${SHOT_PASTED} `)
  const r = splice(`${SHOT_PASTED} `, [{ word, dest: DEST }])
  expect(r.text).toBe(`${DEST} `)
  expect(r.fetched).toEqual([DEST])
  expect(r.failed).toEqual([])
})

test('a failed fetch keeps the original spelling and reports ssh\'s reason', () => {
  const [word] = candidates(SHOT_PASTED)
  const error = failure({ exitCode: 255, stderr: 'ssh: connect to host macbook port 22: Connection refused\n' })
  const r = splice(SHOT_PASTED, [{ word, dest: DEST, error }])
  expect(r.text).toBe(SHOT_PASTED)
  expect(r.failed).toEqual([{ path: SHOT, reason: 'ssh: connect to host macbook port 22: Connection refused' }])
  expect(failure({ exitCode: 0, stderr: 'warning' })).toBe(undefined)
})

test('several paths among prose are each replaced in place, in any result order', () => {
  const text = "look '/Users/x/it'\\''s a.png' /Users/x/c.JPG ok"
  const [a, c] = candidates(text)
  const r = splice(text, [
    { word: c, dest: localPath('/tmp/m', c.value) },
    { word: a, dest: localPath('/tmp/m', a.value) },
  ])
  expect(r.text).toBe("look /tmp/m/it\\'s_a.png /tmp/m/c.JPG ok")
  expect(r.fetched).toEqual(["/tmp/m/it's_a.png", '/tmp/m/c.JPG'])
})

test('words honours backslash escapes and both quotes', () => {
  expect(words(`a\\ b 'c d' "e\\"f"`).map(w => w.value)).toEqual(['a b', 'c d', 'e"f'])
})
