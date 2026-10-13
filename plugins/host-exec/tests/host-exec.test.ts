import { describe, expect, mock, test } from 'claude-code/testing'

const TOOL = 'mcp__host-exec__run'

/** 各質問で先頭（カーソルが乗る既定）に置かれた選択肢 */
let firstOptions: string[] = []

/** AskUserQuestion への回答を、質問ごとに順番に返すスタブ */
function answer(on: any, labels: string[], asked: string[]) {
  on('tool.call', { tool: 'AskUserQuestion' }, async ($: any, e: any) => {
    const q = e.questions[0].question as string
    asked.push(q)
    firstOptions.push(e.questions[0].options[0].label)
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
  '/opt/homebrew/bin/bash': '/opt/homebrew/bin/bash',
  '/usr/bin/perl': '/usr/bin/perl',
  '/var/folders/xx/T/x/git': '/private/var/folders/xx/T/x/git',
}

function host(on: any) {
  mock.env(on, { PATH: '/usr/bin:/opt/homebrew/bin', TMPDIR: '/var/folders/xx/T', HOME: '/w' })
  on('session.cwd', async () => ({ value: '/w/repo' }))
  on('session.root', async () => ({ value: '/w/repo' }))
  on('fs.stat', async ($: any, e: any) => {
    const p = e.path as string
    const kind = p in DIRS ? 'dir' : p in FILES ? 'file' : undefined
    if (!kind) return { deny: `ENOENT: ${p}` }
    return { value: { kind, size: 0, mtimeMs: 0, isLink: false, realPath: DIRS[p] ?? FILES[p] } }
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
    expect(asked[0].startsWith('Claude: plan を確認する\n  $ terraform plan\n')).toBe(true)
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

  test('PATH に無い実行ファイルは承認を聞かずに拒否', async ($, on) => {
    const asked: string[] = []
    host(on)
    answer(on, [], asked)
    const r: any = await $.tool.call({ tool: TOOL, argv: ['kubectl', 'get', 'pods'], reason: 'x' } as any)
    expect(String(r.deny ?? r.text)).toContain('not found on PATH')
    expect(asked.length).toBe(0)
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
    expect(asked[0]).toContain('Claude: a\\nb\n  $ gh pr comment')
    expect(ran[0]?.[5]).toBe(body)
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
    answer(on, ['拒否', '拒否', '拒否', '拒否', '拒否', '拒否', '拒否'], asked)
    await $.tool.call({ tool: TOOL, argv: ['node', '--no-warnings', 'scripts/deploy.js'], reason: 'x' } as any)
    await $.tool.call({ tool: TOOL, argv: ['pnpm', 'dev'], reason: 'x' } as any)
    await $.tool.call({ tool: TOOL, argv: ['pnpm', 'outdated'], reason: 'x' } as any)
    await $.tool.call({ tool: TOOL, argv: ['node', '-e', 'console.log(1)'], reason: 'x' } as any)
    await $.tool.call({ tool: TOOL, argv: ['bash', '-e', './deploy.sh'], reason: 'x' } as any)
    await $.tool.call({ tool: TOOL, argv: ['perl', '-p', 'x.pl'], reason: 'x' } as any)
    await $.tool.call({ tool: TOOL, argv: ['bash', '-c', 'echo 1'], reason: 'x' } as any)
    expect(asked[0]).toContain('scripts/deploy.js の中身が実行されます。この画面には中身が出ない')
    expect(asked[1]).toContain('package.json の scripts や、依存パッケージの install スクリプトが実行されます')
    expect(asked[2]).not.toContain('⚠')
    expect(asked[3]).not.toContain('⚠')
    expect(asked[4]).toContain('./deploy.sh の中身が実行されます。この画面には中身が出ない')
    expect(asked[5]).toContain('x.pl の中身が実行されます。この画面には中身が出ない')
    expect(asked[6]).not.toContain('⚠')
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
})
