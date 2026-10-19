import { describe, expect, mock, test } from 'claude-code/testing'

const TOOL = 'mcp__host-exec__run'

/** 各質問で先頭（カーソルが乗る既定）に置かれた選択肢 */
let firstOptions: string[] = []

/** AskUserQuestion への回答を、質問ごとに順番に返すスタブ。options を渡すと各質問の選択肢を記録する */
function answer(on: any, labels: string[], asked: string[], options?: string[][]) {
  on('tool.call', { tool: 'AskUserQuestion' }, async ($: any, e: any) => {
    const q = e.questions[0].question as string
    asked.push(q)
    firstOptions.push(e.questions[0].options[0].label)
    options?.push(e.questions[0].options.map((o: any) => o.label))
    const label = labels.shift() ?? '拒否'
    return { result: { questions: e.questions, answers: { [q]: label } } }
  })
}

function stubProcess(on: any, out: { stdout: string; stderr?: string; exitCode?: number }, ran: string[][]) {
  on('process.run', async ($: any, e: any) => {
    ran.push([...e.argv])
    return { value: { exitCode: out.exitCode ?? 0, stdout: out.stdout, stderr: out.stderr ?? '' } }
  })
}

/**
 * ホストのファイルシステム・PATH・セッションのディレクトリ。
 * macOS と同じく /tmp と /var/folders は /private 配下へのリンクとして置く。
 */
const DIRS: Record<string, string> = {
  '/w/repo': '/w/repo',
  '/w/repo/sub': '/w/repo/sub',
  '/w/other': '/w/other',
  '/tmp': '/private/tmp',
  '/tmp/evil': '/private/tmp/evil',
  '/var/folders': '/private/var/folders',
  '/var/folders/xx/T': '/private/var/folders/xx/T',
}
const FILES: Record<string, string> = {
  '/opt/homebrew/bin/gcloud': '/opt/homebrew/bin/gcloud',
  '/opt/homebrew/bin/gh': '/opt/homebrew/bin/gh',
  '/opt/homebrew/bin/terraform': '/opt/homebrew/Cellar/terraform/1.9.0/bin/terraform',
  '/opt/homebrew/bin/node': '/opt/homebrew/bin/node',
  '/opt/homebrew/bin/pnpm': '/opt/homebrew/bin/pnpm',
  '/usr/bin/printf': '/usr/bin/printf',
  '/usr/bin/pgrep': '/usr/bin/pgrep',
  '/opt/homebrew/bin/bash': '/opt/homebrew/bin/bash',
  '/usr/bin/perl': '/usr/bin/perl',
  '/var/folders/xx/T/x/git': '/private/var/folders/xx/T/x/git',
}

/**
 * excludedCommands は settings の sandbox.excludedCommands として返す。
 * 返す files はこのテストだけのコピーで、書き換えると以降の呼び出しの実行ファイル解決が変わる。
 */
function host(on: any, opts: { excludedCommands?: string[] } = {}) {
  const files = { ...FILES }
  mock.env(on, { PATH: '/usr/bin:/opt/homebrew/bin', TMPDIR: '/var/folders/xx/T', HOME: '/w' })
  on('session.cwd', async () => ({ value: '/w/repo' }))
  on('session.root', async () => ({ value: '/w/repo' }))
  on('settings.read', async () => ({ value: { sandbox: { excludedCommands: opts.excludedCommands ?? [] } } }))
  on('fs.stat', async ($: any, e: any) => {
    const p = e.path as string
    const kind = p in DIRS ? 'dir' : p in files ? 'file' : undefined
    if (!kind) return { deny: `ENOENT: ${p}` }
    return { value: { kind, size: 0, mtimeMs: 0, isLink: false, realPath: DIRS[p] ?? files[p] } }
  })
  return { files }
}

/** n 回目（1 始まり）の呼び出しに exitCodes[n-1] の終了コードと stdout(n) を返し、実行した argv を ran に記録するスタブ */
function stubExits(on: any, exitCodes: number[], ran: string[][], stdout = (n: number) => `out${n}`) {
  on('process.run', async ($: any, e: any) => {
    ran.push([...e.argv])
    return { value: { exitCode: exitCodes[ran.length - 1] ?? 0, stdout: stdout(ran.length), stderr: '' } }
  })
}

function recordToasts(on: any, toasts: string[]) {
  on('ui.toast', async ($: any, e: any) => {
    toasts.push(e.text)
    return { value: undefined }
  })
}

/** Bash の実行結果を返すスタブ。text はエンジンがモデルに渡す文字列で、host-exec はこれを読む */
function stubBash(on: any, out: { result: unknown; text: string; isError?: boolean }) {
  on('tool.call', { tool: 'Bash' }, async () => out)
}

describe('host-exec', () => {
  test('ツールは deferred にせず、schema と description を常に prompt に載せる', async ($, on) => {
    const specs: any[] = []
    on('tool.register', async ($: any, e: any) => {
      specs.push(e)
      return { value: undefined }
    })
    on('session.start', async ($: any, e: any) => e)
    await $.session.start({ cwd: '/w/repo' } as any)
    expect(specs.length).toBe(1)
    expect(specs[0].name).toBe('run')
    expect(specs[0].isDeferred).toBe(false)
    expect(specs[0].description).toContain('Long-running commands (builds, docker, recording, etc.) need timeoutSec from the first call')
  })

  for (const [mark, text] of [
    ['Operation not permitted', 'ls: /Users/x/.ssh: Operation not permitted'],
    ['sandbox_violations', 'curl: (56) CONNECT tunnel failed\n<sandbox_violations>\napi.example.com denied\n</sandbox_violations>'],
    ['EPERM', 'Error: EPERM: operation not permitted, open \'/Users/x/.config/app.json\''],
  ]) {
    test(`sandbox に拒否された Bash の失敗（${mark}）には、結果を変えずに host-exec を使う context を 1 件添える`, async ($, on) => {
      const out = { result: { stdout: '', stderr: text, interrupted: false }, text, isError: true }
      stubBash(on, out)
      const r: any = await $.tool.call({ tool: 'Bash', command: 'x' } as any)
      expect(r.result).toEqual(out.result)
      expect(r.text).toBe(text)
      expect(r.isError).toBe(true)
      expect(r.context.length).toBe(1)
      expect(r.context[0]).toContain(TOOL)
    })
  }

  test('worktree の隔離ガードに実行前に拒否された Bash には、sandbox ではないので書き方を直すよう context を 1 件だけ添える', async ($, on) => {
    const text =
      'This session is isolated in the worktree /w/repo/.claude/worktrees/x, but this command names git in a form too complex to verify ' +
      'that it stays inside the worktree. Refusing to run it — a worktree-isolated session\'s git operations must target its own worktree.'
    const out = { result: { stdout: '', stderr: text, interrupted: false }, text, isError: true }
    stubBash(on, out)
    const r: any = await $.tool.call({ tool: 'Bash', command: 'x' } as any)
    expect(r.result).toEqual(out.result)
    expect(r.text).toBe(text)
    expect(r.context.length).toBe(1)
    expect(r.context[0]).toContain('not by the sandbox')
    expect(r.context[0]).toContain(`do not use ${TOOL}`)
  })

  for (const [kind, out] of [
    ['成功', { result: { stdout: 'a.txt', stderr: '', interrupted: false }, text: 'a.txt' }],
    ['sandbox と無関係な失敗', { result: { stdout: '', stderr: 'zsh: command not found: kubectl', interrupted: false }, text: 'zsh: command not found: kubectl', isError: true }],
  ] as const) {
    test(`Bash の${kind}には context を足さず、結果もそのまま返す`, async ($, on) => {
      stubBash(on, out)
      const r: any = await $.tool.call({ tool: 'Bash', command: 'x' } as any)
      expect(r).toEqual(out)
      expect(r.context).toBeUndefined()
    })
  }

  test('許可リストの無い任意の実行ファイルも、PATH で解決したパスを見せて承認後に実行する', async ($, on) => {
    const asked: string[] = []
    const ran: string[][] = []
    host(on)
    answer(on, ['実行する'], asked)
    stubProcess(on, { stdout: 'No changes.' }, ran)
    const r: any = await $.tool.call({ tool: TOOL, argv: ['terraform', 'plan'], reason: 'plan を確認する' } as any)
    expect(asked.length).toBe(1)
    expect(asked[0].startsWith('目的: plan を確認する\n  $ terraform plan\n')).toBe(true)
    expect(asked[0]).not.toContain('Claude: ')
    expect(asked[0]).toContain('実行ファイル  /opt/homebrew/bin/terraform → /opt/homebrew/Cellar/terraform/1.9.0/bin/terraform')
    expect(asked[0]).toContain('場所          ~/repo')
    expect(asked[0]).not.toContain('⚠')
    expect(ran).toEqual([['/opt/homebrew/bin/terraform', 'plan']])
    expect(JSON.stringify(r)).toContain('No changes.')
  })

  test('トークン出力系・再帰的な強制削除は承認を聞かずに拒否', async ($, on) => {
    const asked: string[] = []
    host(on)
    answer(on, [], asked)
    for (const argv of [['gcloud', 'auth', 'print-access-token'], ['rm', '-rf', '/w/repo'], ['gh', 'auth', 'status', '--show-token']]) {
      const r: any = await $.tool.call({ tool: TOOL, argv, reason: 'x' } as any)
      expect(String(r.deny ?? r.text)).toContain('refused')
    }
    expect(asked.length).toBe(0)
  })

  test('PATH に無い実行ファイルは承認を聞かずに拒否し、plugin の bin/ のコマンドは Bash で実行するよう返す', async ($, on) => {
    const asked: string[] = []
    host(on)
    answer(on, [], asked)
    const r: any = await $.tool.call({ tool: TOOL, argv: ['kubectl', 'get', 'pods'], reason: 'x' } as any)
    expect(String(r.deny ?? r.text)).toContain('not found on PATH')
    expect(String(r.deny ?? r.text)).toContain('Commands that a plugin provides by bare name in its bin/ are on the Bash tool\'s PATH only, so run them with the Bash tool')
    expect(asked.length).toBe(0)
  })

  test('承認ダイアログが閉じられた・使えなかったら実行せず、ユーザーが返事をするまで host-exec を呼ばないよう返す', async ($, on) => {
    const ran: string[][] = []
    host(on)
    on('tool.call', { tool: 'AskUserQuestion' }, async () => ({ deny: 'dismissed' }))
    stubProcess(on, { stdout: 'ok' }, ran)
    const r: any = await $.tool.call({ tool: TOOL, argv: ['gh', 'repo', 'view'], reason: 'x' } as any)
    const s = String(r.deny)
    expect(s).toContain('dialog dismissed or unavailable')
    expect(s).toContain(`Do not call ${TOOL} again, for this command or any other, until the user replies in the conversation`)
    expect(s).toContain('Tell the user what you wanted to run and why')
    expect(ran.length).toBe(0)
  })

  test('時間切れには使った timeoutSec と、同じ値で再実行せず上げるか別の方法を使う案内を添え、起動失敗には添えない', async ($, on) => {
    const asked: string[] = []
    host(on)
    answer(on, ['実行する', '実行する'], asked)
    const errors = ['aborted: still running after 45000ms', 'spawn EACCES']
    on('process.run', async () => ({ deny: errors.shift() }))
    const timedOut: any = await $.tool.call({ tool: TOOL, argv: ['gh', 'run', 'watch'], reason: 'x', timeoutSec: 45 } as any)
    const t = String(timedOut.result)
    expect(t).toContain('timed out after 45s')
    expect(t).toContain('timed out at timeoutSec 45. Re-running it with the same timeoutSec will time out the same way')
    expect(t).toContain('raise timeoutSec (max 600)')
    expect(t).toContain('for a command that does not exit on its own')

    const failed: any = await $.tool.call({ tool: TOOL, argv: ['gh', 'run', 'watch'], reason: 'x', timeoutSec: 45 } as any)
    const f = String(failed.result)
    expect(f).toContain('could not start')
    expect(f).toContain('spawn EACCES')
    expect(f).not.toContain('timeoutSec')
    expect(f).not.toContain('timed out')
  })

  for (const mark of ['-25308', 'errSecInteractionNotAllowed', 'User interaction is not allowed']) {
    test(`出力に macOS キーチェーンの拒否（${mark}）があれば、出力はそのままで host-exec で再実行せず \`!\` で頼む案内を添える`, async ($, on) => {
      const asked: string[] = []
      const ran: string[][] = []
      host(on)
      answer(on, ['実行する'], asked)
      const stderr = `security: SecKeychainSearchCopyNext: ${mark}`
      stubProcess(on, { stdout: '', stderr, exitCode: 36 }, ran)
      const r: any = await $.tool.call({ tool: TOOL, argv: ['gh', 'auth', 'login'], reason: 'x' } as any)
      const s = String(r.result)
      expect(s).toContain(`exit code: 36\n--- stdout ---\n(empty)\n--- stderr ---\n${stderr}`)
      expect(s).toContain(`the macOS keychain is not reachable from this session (-25308 errSecInteractionNotAllowed), so do not re-run this with ${TOOL}: ask the user to run the command themselves with \`!\``)
    })
  }

  test('キーチェーンの拒否は、秘密情報で出力を「渡さない」ときの結果にも添え、印が無ければ添えない', async ($, on) => {
    const asked: string[] = []
    const ran: string[][] = []
    host(on)
    answer(on, ['実行する', '渡さない', '実行する'], asked)
    stubExits(on, [1, 0], ran, n => (n === 1 ? 'AKIAABCDEFGHIJKLMNOP\nerrSecInteractionNotAllowed' : 'ok'))
    const withheld: any = await $.tool.call({ tool: TOOL, argv: ['gh', 'api', 'user'], reason: 'x' } as any)
    expect(String(withheld.result)).toContain('withheld')
    expect(String(withheld.result)).not.toContain('AKIAABCDEFGHIJKLMNOP')
    expect(String(withheld.result)).toContain('the macOS keychain is not reachable from this session')
    const plain: any = await $.tool.call({ tool: TOOL, argv: ['gh', 'api', 'user'], reason: 'x' } as any)
    expect(String(plain.result)).toContain('--- stdout ---\nok')
    expect(String(plain.result)).not.toContain('keychain')
  })

  test('ユーザーが拒否したら実行しない', async ($, on) => {
    const asked: string[] = []
    const ran: string[][] = []
    host(on)
    answer(on, ['拒否'], asked)
    stubProcess(on, { stdout: 'ok' }, ran)
    const r: any = await $.tool.call({ tool: TOOL, argv: ['gcloud', 'run', 'services', 'list'], reason: 'x' } as any)
    expect(String(r.deny ?? r.text)).toContain('declined')
    expect(ran.length).toBe(0)
  })

  test('承認・機密なしなら出力をそのまま返す', async ($, on) => {
    const asked: string[] = []
    const ran: string[][] = []
    host(on)
    answer(on, ['実行する'], asked)
    stubProcess(on, { stdout: 'SERVICE  REGION\napi  asia-northeast1' }, ran)
    const r: any = await $.tool.call({ tool: TOOL, argv: ['gcloud', 'run', 'services', 'list'], reason: 'x' } as any)
    expect(ran.length).toBe(1)
    expect(asked.length).toBe(1)
    expect(JSON.stringify(r)).toContain('asia-northeast1')
  })

  test('改行・双方向制御文字はダイアログでエスケープして見せ、実行する argv はそのまま渡す', async ($, on) => {
    const asked: string[] = []
    const ran: string[][] = []
    host(on)
    answer(on, ['実行する'], asked)
    stubProcess(on, { stdout: 'ok' }, ran)
    const body = 'line1\nline2\u202eevil'
    await $.tool.call({ tool: TOOL, argv: ['gh', 'pr', 'comment', '1', '--body', body], reason: 'a\nb' } as any)
    expect(asked[0]).toContain('"line1\\nline2\\u202eevil"')
    expect(asked[0]).not.toContain('line1\nline2')
    expect(asked[0]).not.toContain('\u202e')
    expect(asked[0]).toContain('$ gh pr comment 1 --body "line1')
    expect(asked[0]).toContain('目的: a\\nb\n  $ gh pr comment')
    expect(ran[0]?.[5]).toBe(body)
  })

  test('Claude の説明は空白を畳み長文を切り詰めて、本物のコマンド行が独立した行として残る', async ($, on) => {
    const asked: string[] = []
    host(on)
    answer(on, ['拒否', '拒否'], asked)
    await $.tool.call({ tool: TOOL, argv: ['terraform', 'plan'], reason: `x${' '.repeat(300)}$ gh pr list` } as any)
    await $.tool.call({ tool: TOOL, argv: ['terraform', 'plan'], reason: 'あ'.repeat(5000) } as any)
    expect(asked[0]).toContain('目的: x $ gh pr list\n  $ terraform plan\n')
    const lines = asked[1].split('\n')
    const claudeLine = lines.find(l => l.startsWith('目的: ')) ?? ''
    expect(claudeLine).toBe(`目的: ${'あ'.repeat(200)}…`)
    expect(lines[lines.indexOf(claudeLine) + 1]).toBe('  $ terraform plan')
  })

  test('Claude が書ける場所の実行ファイル・一時ディレクトリの cwd は、止めずに警告を添えて聞く', async ($, on) => {
    const asked: string[] = []
    const ran: string[][] = []
    host(on)
    answer(on, ['実行する', '実行する', '実行する'], asked)
    stubProcess(on, { stdout: 'ok' }, ran)
    await $.tool.call({ tool: TOOL, argv: ['/var/folders/xx/T/x/git', 'status'], reason: 'x' } as any)
    await $.tool.call({ tool: TOOL, argv: ['gh', 'repo', 'view'], cwd: '/tmp/evil', reason: 'x' } as any)
    await $.tool.call({ tool: TOOL, argv: ['gh', 'repo', 'view'], cwd: '/w/other', reason: 'x' } as any)
    expect(asked[0]).toMatch(/^⚠ 注意（1 件）\n・この実行ファイルは一時ディレクトリにあり/)
    expect(asked[0]).toContain('この実行ファイルは一時ディレクトリにあり、Claude が作ったものかもしれません')
    expect(asked[1]).toContain('一時ディレクトリで実行します。Claude が置いた設定ファイル')
    expect(asked[1]).toContain('場所          /private/tmp/evil')
    expect(asked[2]).toContain('プロジェクトの外で実行します')
    expect(ran).toEqual([
      ['/var/folders/xx/T/x/git', 'status'],
      ['/opt/homebrew/bin/gh', 'repo', 'view'],
      ['/opt/homebrew/bin/gh', 'repo', 'view'],
    ])
  })

  test('ファイルやスクリプトの中身を実行するコマンドには警告、中身が argv に見えるインライン実行には出さない', async ($, on) => {
    const asked: string[] = []
    host(on)
    answer(on, ['拒否', '拒否', '拒否', '拒否', '拒否', '拒否'], asked)
    await $.tool.call({ tool: TOOL, argv: ['node', '--no-warnings', 'scripts/deploy.js'], reason: 'x' } as any)
    await $.tool.call({ tool: TOOL, argv: ['pnpm', 'dev'], reason: 'x' } as any)
    await $.tool.call({ tool: TOOL, argv: ['pnpm', 'outdated'], reason: 'x' } as any)
    await $.tool.call({ tool: TOOL, argv: ['node', '-e', 'console.log(1)'], reason: 'x' } as any)
    await $.tool.call({ tool: TOOL, argv: ['bash', '-e', './deploy.sh'], reason: 'x' } as any)
    await $.tool.call({ tool: TOOL, argv: ['perl', '-p', 'x.pl'], reason: 'x' } as any)
    expect(asked[0]).toContain('scripts/deploy.js の中身が実行されます。この画面には中身が出ない')
    expect(asked[1]).toContain('package.json の scripts や、依存パッケージの install スクリプトが実行されます')
    expect(asked[2]).not.toContain('⚠')
    expect(asked[3]).not.toContain('⚠')
    expect(asked[4]).toContain('./deploy.sh の中身が実行されます。この画面には中身が出ない')
    expect(asked[5]).toContain('x.pl の中身が実行されます。この画面には中身が出ない')
  })

  test('shell の -c でコマンド文字列を渡すものは承認を聞かずに拒否し、sandbox 内の Bash か Read / Grep を使うよう返す', async ($, on) => {
    const asked: string[] = []
    const ran: string[][] = []
    host(on)
    answer(on, [], asked)
    stubProcess(on, { stdout: '' }, ran)
    for (const argv of [['bash', '-c', 'ls | head'], ['/opt/homebrew/bin/bash', '-c', 'echo 1'], ['bash', '-lc', 'x'], ['bash', '-e', '-c', 'x'], ['bash', '-o', 'pipefail', '-c', 'x'], ['bash', '-euo', 'pipefail', '-c', 'x'], ['bash', '+O', 'extglob', '-c', 'x'], ['bash', '--rcfile', 'f', '-c', 'x']]) {
      const r: any = await $.tool.call({ tool: TOOL, argv, reason: 'x' } as any)
      expect(String(r.deny)).toContain('refused (shell')
      expect(String(r.deny)).toContain('Read / Grep')
    }
    const multi: any = await $.tool.call({ tool: TOOL, steps: [['gh', 'repo', 'view'], ['bash', '-c', 'x']], reason: 'x' } as any)
    expect(String(multi.deny)).toContain('at step 2')
    expect(asked.length).toBe(0)
    expect(ran.length).toBe(0)
  })

  test('shell の -c がスクリプト名より後ろにあるもの（スクリプトへの引数）は拒否せず承認を聞く', async ($, on) => {
    const asked: string[] = []
    host(on)
    answer(on, ['拒否'], asked)
    const r: any = await $.tool.call({ tool: TOOL, argv: ['bash', './deploy.sh', '-c', 'prod'], reason: 'x' } as any)
    expect(asked.length).toBe(1)
    expect(String(r.deny)).toContain('declined')
  })

  test('機密を含む出力は止めて、マスクを選べばマスク済みで返す', async ($, on) => {
    const asked: string[] = []
    firstOptions = []
    const ran: string[][] = []
    host(on)
    answer(on, ['実行する', 'マスクして渡す'], asked)
    stubProcess(on, { stdout: 'DATABASE_URL=postgresql://app:s3cretPass@10.0.0.3:5432/app\nok' }, ran)
    const r: any = await $.tool.call({ tool: TOOL, argv: ['gcloud', 'run', 'services', 'describe', 'api'], reason: 'x' } as any)
    const s = JSON.stringify(r)
    expect(asked.length).toBe(2)
    expect(firstOptions).toEqual(['拒否', '渡さない'])
    expect(asked[1]).toContain('検出: パスワード入り接続文字列 ×1')
    expect(asked[1]).toContain('・渡さない        実行できたことと終了コードだけを伝えます')
    expect(asked[1]).toContain('・マスクして渡す  該当部分を [REDACTED] に置き換えて渡します')
    expect(s).not.toContain('s3cretPass')
    expect(s).toContain('REDACTED')
  })

  test('機密の質問と Claude に返す結果でも argv はエスケープして見せる', async ($, on) => {
    const asked: string[] = []
    const ran: string[][] = []
    host(on)
    answer(on, ['実行する', 'マスクして渡す'], asked)
    stubProcess(on, { stdout: 'AKIAABCDEFGHIJKLMNOP' }, ran)
    const r: any = await $.tool.call({ tool: TOOL, argv: ['printf', '%s%s\n', 'AKIA', 'ABCDEFGHIJKLMNOP'], reason: 'x' } as any)
    const shown = '$ printf "%s%s\\n" AKIA ABCDEFGHIJKLMNOP'
    expect(asked[1]).toContain(shown)
    expect(asked[1]).not.toContain('%s%s\n')
    expect(JSON.stringify(r)).toContain(JSON.stringify(shown).slice(1, -1))
    expect(JSON.stringify(r)).not.toContain('AKIAABCDEFGHIJKLMNOP')
  })

  test('機密を含む出力で「渡さない」なら値を一切返さない', async ($, on) => {
    const asked: string[] = []
    const ran: string[][] = []
    host(on)
    answer(on, ['実行する', '渡さない'], asked)
    stubProcess(on, { stdout: '{"private_key": "-----BEGIN PRIVATE KEY-----\\nMIIabc\\n-----END PRIVATE KEY-----"}' }, ran)
    const r: any = await $.tool.call({ tool: TOOL, argv: ['gcloud', 'iam', 'service-accounts', 'list'], reason: 'x' } as any)
    const s = JSON.stringify(r)
    expect(s).toContain('withheld')
    expect(s).not.toContain('MIIabc')
  })

  test('2回目の質問に答えがなければ（AFK・自由記述など）渡さない', async ($, on) => {
    const asked: string[] = []
    const ran: string[][] = []
    host(on)
    answer(on, ['実行する', 'あとで見る'], asked)
    stubProcess(on, { stdout: 'token: ghp_abcdefghijklmnopqrstuvwxyz0123456789' }, ran)
    const r: any = await $.tool.call({ tool: TOOL, argv: ['gh', 'api', 'user'], reason: 'x' } as any)
    const s = JSON.stringify(r)
    expect(s).toContain('withheld')
    expect(s).not.toContain('ghp_abcdef')
  })

  test('steps は 1 回の承認で順に実行し、終了コードが 0 以外のステップで止めて残りを「未実行」と返す', async ($, on) => {
    const asked: string[] = []
    const ran: string[][] = []
    host(on)
    answer(on, ['3 個とも実行する', '3 個とも実行する'], asked)
    stubExits(on, [0, 0, 0, 0, 1], ran)
    const steps = [['gh', 'pr', 'view', '1'], ['gh', 'pr', 'checks', '1'], ['gh', 'pr', 'merge', '1']]
    const ok: any = await $.tool.call({ tool: TOOL, steps, reason: 'x' } as any)
    expect(asked.length).toBe(1)
    expect(ran.map(a => a.slice(1).join(' '))).toEqual(['pr view 1', 'pr checks 1', 'pr merge 1'])
    expect(String(ok.result)).toContain('$ gh pr merge 1\nexit code: 0\n--- stdout ---\nout3')
    expect(String(ok.result)).not.toContain('未実行')

    const r: any = await $.tool.call({ tool: TOOL, steps, reason: 'x' } as any)
    expect(asked.length).toBe(2)
    expect(ran.map(a => a.slice(1).join(' ')).slice(3)).toEqual(['pr view 1', 'pr checks 1'])
    const s = String(r.deny ?? r.result)
    expect(s).toContain('$ gh pr view 1\nexit code: 0\n--- stdout ---\nout4')
    expect(s).toContain('$ gh pr checks 1\nexit code: 1\n--- stdout ---\nout5')
    expect(s).toContain('$ gh pr merge 1\n未実行')
  })

  test('steps の 1 つでも拒否パターンに当たる・見つからなければ、承認を聞かずに拒否して何も実行しない', async ($, on) => {
    const asked: string[] = []
    const ran: string[][] = []
    host(on)
    answer(on, [], asked)
    stubExits(on, [], ran)
    const denied: any = await $.tool.call({ tool: TOOL, steps: [['gh', 'repo', 'view'], ['git', 'push', '--force'], ['gh', 'repo', 'view']], reason: 'x' } as any)
    expect(String(denied.deny)).toContain('refused (force push) at step 2')
    const missing: any = await $.tool.call({ tool: TOOL, steps: [['gh', 'repo', 'view'], ['kubectl', 'get', 'pods']], reason: 'x' } as any)
    expect(String(missing.deny)).toContain('"kubectl" at step 2 was not found on PATH')
    expect(asked.length).toBe(0)
    expect(ran.length).toBe(0)
  })

  test('argv と steps を両方渡す・どちらも渡さないと拒否する', async ($, on) => {
    const asked: string[] = []
    const ran: string[][] = []
    host(on)
    answer(on, [], asked)
    stubExits(on, [], ran)
    for (const input of [{ argv: ['gh', 'repo', 'view'], steps: [['gh', 'repo', 'view']] }, {}]) {
      const r: any = await $.tool.call({ tool: TOOL, ...input, reason: 'x' } as any)
      expect(String(r.deny)).toContain('exactly one of argv')
    }
    expect(asked.length).toBe(0)
    expect(ran.length).toBe(0)
  })

  test('複数ステップの承認画面は番号付きのコマンド・実行ファイル・警告を出し、実行ボタンは「N 個とも実行する」', async ($, on) => {
    const asked: string[] = []
    const options: string[][] = []
    host(on)
    answer(on, ['拒否'], asked, options)
    await $.tool.call({ tool: TOOL, steps: [['gh', 'repo', 'view'], ['pnpm', 'dev']], reason: 'dev を起動する' } as any)
    expect(asked[0]).toMatch(/^⚠ 注意（1 件）\n・2: package\.json の scripts/)
    expect(asked[0]).toContain('\n目的: dev を起動する\n  1  $ gh repo view\n  2  $ pnpm dev\n\n')
    expect(asked[0]).toContain('  実行ファイル  1  /opt/homebrew/bin/gh\n                2  /opt/homebrew/bin/pnpm\n  場所          ~/repo\n  失敗したらそこで止めます')
    expect(asked[0]).not.toContain('Claude: ')
    expect(options[0]).toEqual(['拒否', '2 個とも実行する'])
  })

  test('Bash でも sandbox の外で動く excludedCommands に一致するコマンドは、承認を聞かずに Bash を使うよう返す', async ($, on) => {
    const asked: string[] = []
    const ran: string[][] = []
    host(on, { excludedCommands: ['/usr/bin/pgrep *', '~/bin/*', 'codex:*'] })
    answer(on, ['拒否', '拒否'], asked)
    stubExits(on, [], ran)
    for (const steps of [[['/usr/bin/pgrep', '-lf', 'x']], [['/usr/bin/pgrep', '-l', 'a'], ['/w/bin/tool']]]) {
      const r: any = await $.tool.call({ tool: TOOL, steps, reason: 'x' } as any)
      expect(String(r.deny ?? r.result)).toContain('Bash ツールで実行してください')
    }
    expect(asked.length).toBe(0)
    // 一致しないもの（PATH 解決前の名前・1 階層より深い・`:*`）は今まで通り
    for (const argv of [['/w/bin/sub/tool'], ['codex:x']]) {
      const r: any = await $.tool.call({ tool: TOOL, argv, reason: 'x' } as any)
      expect(String(r.deny ?? r.result)).toContain('was not found')
    }
    await $.tool.call({ tool: TOOL, argv: ['pgrep', '-lf', 'x'], reason: 'x' } as any)
    await $.tool.call({ tool: TOOL, steps: [['/usr/bin/pgrep', '-lf', 'x'], ['gh', 'repo', 'view']], reason: 'x' } as any)
    expect(asked.length).toBe(2)
    expect(asked[0]).toContain('$ pgrep -lf x')
    expect(ran.length).toBe(0)
  })

  test('「このセッションでは同じコマンドを聞かない」で承認したものは聞き直さずに実行して知らせ、実行ファイル・argv・cwd が違えば聞く', async ($, on) => {
    const asked: string[] = []
    const options: string[][] = []
    const ran: string[][] = []
    const toasts: string[] = []
    const { files } = host(on)
    answer(on, ['実行して、このセッションでは同じコマンドを聞かない', '拒否', '拒否', '拒否'], asked, options)
    stubExits(on, [], ran)
    recordToasts(on, toasts)
    const call = (input: object) => $.tool.call({ tool: TOOL, reason: 'x', ...input } as any) as Promise<any>
    await call({ argv: ['gh', 'repo', 'view'] })
    expect(options[0]).toEqual(['拒否', '実行する', '実行して、このセッションでは同じコマンドを聞かない'])
    const again = await call({ argv: ['gh', 'repo', 'view'] })
    await call({ argv: ['gh', 'repo', 'view'], cwd: '/w/repo' })
    expect(asked.length).toBe(1)
    expect(ran.length).toBe(3)
    expect(String(again.result)).toContain('$ gh repo view\nexit code: 0')
    expect(toasts).toEqual(['承認済みのコマンドを再実行: gh repo view（2 回目）', '承認済みのコマンドを再実行: gh repo view（3 回目）'])

    await call({ argv: ['gh', 'repo', 'view', '--web'] })
    await call({ argv: ['gh', 'repo', 'view'], cwd: 'sub' })
    files['/opt/homebrew/bin/gh'] = '/opt/homebrew/Cellar/gh/2.0/bin/gh'
    await call({ argv: ['gh', 'repo', 'view'] })
    expect(asked.length).toBe(4)
    expect(ran.length).toBe(3)
    expect(toasts.length).toBe(2)
  })

  test('警告が出るコマンドには「このセッションでは同じコマンドを聞かない」を出さない', async ($, on) => {
    const asked: string[] = []
    const options: string[][] = []
    host(on)
    answer(on, ['拒否', '拒否', '拒否'], asked, options)
    await $.tool.call({ tool: TOOL, argv: ['pnpm', 'dev'], reason: 'x' } as any)
    await $.tool.call({ tool: TOOL, argv: ['/var/folders/xx/T/x/git', 'status'], reason: 'x' } as any)
    await $.tool.call({ tool: TOOL, argv: ['gh', 'repo', 'view'], cwd: '/w/other', reason: 'x' } as any)
    expect(asked.every(q => q.startsWith('⚠'))).toBe(true)
    expect(options).toEqual([['拒否', '実行する'], ['拒否', '実行する'], ['拒否', '実行する']])
  })

  test('記憶済みのコマンドでも、出力に秘密情報があれば渡す前に聞く', async ($, on) => {
    const asked: string[] = []
    const ran: string[][] = []
    const toasts: string[] = []
    host(on)
    answer(on, ['実行して、このセッションでは同じコマンドを聞かない', 'マスクして渡す'], asked)
    stubExits(on, [], ran, n => (n === 1 ? 'ok' : 'AKIAABCDEFGHIJKLMNOP'))
    recordToasts(on, toasts)
    await $.tool.call({ tool: TOOL, argv: ['gh', 'api', 'user'], reason: 'x' } as any)
    const r: any = await $.tool.call({ tool: TOOL, argv: ['gh', 'api', 'user'], reason: 'x' } as any)
    expect(ran.length).toBe(2)
    expect(toasts[0]).toBe('承認済みのコマンドを再実行: gh api user（2 回目）')
    expect(asked.length).toBe(2)
    expect(asked[1]).toContain('検出: AWS アクセスキー ×1')
    expect(JSON.stringify(r)).not.toContain('AKIAABCDEFGHIJKLMNOP')
  })
})
