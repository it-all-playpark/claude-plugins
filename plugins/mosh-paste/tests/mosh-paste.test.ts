import { expect, test } from 'claude-code/testing'

import { candidates, failure, fetchArgv, localPath, splice, words } from '../hooks/paste'

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

test('the fetch command hands host, quoted remote path and dest to ssh', () => {
  const argv = fetchArgv('macbook', "/Users/x/it's.png", '/tmp/mosh-paste/it\'s.png')
  expect(argv.slice(3)).toEqual(['mosh-paste', 'macbook', `'/Users/x/it'\\''s.png'`, "/tmp/mosh-paste/it's.png"])
  expect(argv[2]).toContain('BatchMode=yes')
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
