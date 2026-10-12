---
name: mem-triage
description: >-
  Finds what is eating memory on macOS and how to free it: totals the memory of every app, every program
  launched from a terminal (nvim with its language servers, claude with its MCP servers, dev servers) and
  every launchd job, flags orphaned stdio servers that are safe to kill without asking, and marks instances
  still running an older build. Never kills anything; hands the user the kill commands.
  Use when: (1) the Mac is slow, swapping, or under memory pressure, (2) user asks which app or process is
  using memory or what to close, (3) cleaning up stale Claude Code / nvim / language-server / MCP processes,
  (4) keywords: メモリ, メモリ圧迫, メモリ不足, 重い, スワップ, memory pressure, swap, 何がメモリ食ってる,
  プロセス掃除, ゾンビ, zombie, 残ってない？
  Accepts args: [--top N]
allowed-tools:
  - Bash
  - Read
---

# Mem Triage

macOS のメモリを「塊」（アプリ / 端末から起動したもの / launchd の常駐）ごとに合算し、何を閉じればどれだけ空くか、
聞かずに消してよいかを示す。プロセスは止めない（止めるのはユーザー）。

## Usage

```
/mem-triage [--top N]
```

## Args

| Arg | Default | Description |
|-----|---------|-------------|
| `--top` | `15` | 出す塊の数（メモリの大きい順） |

## Workflow

```
Step 1: 集計（スクリプト） → Step 2: 塊ごとに正体・解放方法・判断を表にする → Step 3: kill コマンドをユーザーに渡す
```

## Step 1: 集計する

```bash
bash ${CLAUDE_PLUGIN_ROOT}/mem-triage/scripts/mem-triage.sh [--top N]
```

- **この形のまま単独で実行する**。プロセス一覧（ps / top / lsof）は sandbox 内では読めないため、plugin cache 配下の
  スクリプトとして sandbox の外で動かす。パイプ・リダイレクト・`cd … &&`・変数代入の前置を付けると sandbox 内に戻り exit 3 になる
- 前提条件: sandbox を有効にしている環境では、plugin cache（`~/.claude/plugins/cache/<marketplace>/*`）を `bash` 付きで
  `sandbox.excludedCommands` に入れておく。exit 3 が出たらこれをユーザーに案内する（自分で回避しない）
- macOS 専用（それ以外は exit 2）

出力は 1 行の JSON:

| キー | 中身 |
|------|------|
| `summary` | `used` / `wired` / `compressor` / `unused`（top の PhysMem）、`swap_used` / `swap_total`、`free_percent`（memory_pressure）、`processes`、`units` |
| `units[]` | 塊。`id` / `kind`（`app` / `process` / `system` / `shell` / `webkit`）/ `name` / `mem` / `procs` / `top`（重い 3 プロセス）/ `current_session` |
| `units[]`（`kind: process` のみ） | `root`（`pid` / `tty` / `age` / `cwd` / `args`）、`flags`、`role`、`safe_kill`、`kill` |
| `safe_kill[]` | 聞かずに消してよいもの（`--top` の外も含む全件） |

- `flags`: `orphan_stdio`（launchd 直下・端末なしの stdio サーバー。親が死んで誰も使っていない）、`detached`（launchd 直下・端末なしの
  それ以外。常駐か、親が死んだか）、`older_build`（同じプログラムの新しい版が別に動いている。更新前から開きっぱなし）
- `role`（claude のみ）: `claude-daemon` / `claude-agents` / `claude-print` / `claude-cli`
- `current_session: true` の塊は、いまこの集計を走らせている Claude Code のセッション自身か、その起動元（シェル・端末アプリ）
- `mem` は top の MEM（圧縮分を含む物理フットプリント）。共有メモリの数え方が違うので塊の合計は PhysMem と一致しない。順位の目安として読む

## Step 2: 表にする

`summary` を 1 行（使用量・compressor・swap・空き %）で示し、`units` をメモリ順に表にする:

| 塊 | メモリ | 正体 | 解放方法 | 判断 |
|----|--------|------|----------|------|

正体と解放方法は [release-hints.md](references/release-hints.md) を読んで書く。判断は次の 3 つのどれかにする:

- **消してよい**: `safe_kill: true` のものだけ
- **要確認**: それ以外の `process` と `app`、`webkit`。作業中かどうかは本人にしか分からないので、`older_build`・`age`・`cwd`・`tty` を判断材料として添える
- **消さない**: `system`・`shell`・`role: claude-daemon`・`current_session: true`

## Step 3: 解放をユーザーに渡す

- **kill は自分で実行しない**。ユーザーが選んだものを `! kill <pid>` の形で示す（`消してよい` はまとめて 1 行: `! kill 130 131`）
- `process` の塊は根の pid（`kill` フィールド）を止めれば子も終わる。未保存の作業がありうるもの（nvim 等）は、まずその端末で閉じることを勧める
- アプリは終了（⌘Q）を案内する
- 解放後に確かめたいと言われたら Step 1 を再実行し、前回との差を示す

## References

- [Release Hints](references/release-hints.md) - 塊の正体と解放方法
