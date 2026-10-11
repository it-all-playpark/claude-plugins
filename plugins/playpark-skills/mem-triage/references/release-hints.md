# 塊の正体と解放方法

mem-triage の `units[]` を表にするときに、正体と解放方法を書くための手がかり。ここに無い名前は `args`・`cwd` から推して書き、
推測なら推測と書く。

## process（端末やシェルから起動したもの、launchd 直下の常駐）

| 見分け方 | 正体 | 解放方法 |
|----------|------|----------|
| `name: nvim` で `top` に `language-server`・`--stdio` の node がいる | エディタ 1 つと、その LSP / Copilot | その端末で `:qa`。言語サーバーは nvim を閉じれば一緒に終わる |
| `flags` に `older_build` | 更新前の版のまま開きっぱなし | 新しい版で開き直してよいか本人に聞く |
| `flags` に `orphan_stdio` | 親（エディタ・Claude Code 等）が死んで残った stdio サーバー。誰にも繋がっていない | `kill <pid>`（聞かずに消してよい） |
| `role: claude-cli` | 対話中の Claude Code セッション（`top` の node 等は MCP server） | そのセッションを `/exit`。`current_session` なら触れない |
| `role: claude-agents` | `claude agents`（バックグラウンドセッションの一覧画面）を端末で開いたもの | 使っていないタブなら閉じてよい。bg セッション本体は `claude-daemon` の配下で動いていて、この画面の子ではない |
| `role: claude-print` | `claude -p` のジョブ（定期実行の可能性がある） | 実行中のジョブか本人に確かめてから |
| `role: claude-daemon` | バックグラウンドセッションの基盤。配下に動いている bg セッションと、予備の `bg-spare` / `bg-pty-host`（1 つ数百 MB）がいる | 止めない（動いている bg セッションごと止まる）。大きければ、終わった bg セッションを `claude agents` で片付けるよう勧める |
| `next dev` / `vite` / `pnpm dev` など | 開発サーバー | 起動した端末で Ctrl-C |
| `flags` に `detached`（上のどれでもない） | launchd の常駐か、親が死んだジョブ | `args` から何者かを示し、要るかを本人に聞く |

## app

| 名前 | 正体 | 解放方法 |
|------|------|----------|
| OrbStack / Docker | Linux VM とコンテナ。VM に割り当てたメモリをそのまま抱える | 使っていないコンテナ・マシンを止める（`docker ps` で確認）。全部不要ならアプリを終了 |
| ブラウザ（Chrome / Arc / Dia / Safari 等） | タブごとの renderer（`Helper (Renderer)`） | 使っていないタブを閉じる。重いタブは `top` の renderer で当たりを付ける |
| Claude（デスクトップ） | アプリ本体と、アプリが起動した Claude Code・MCP server | 使っていない会話を閉じる。不要ならアプリを終了 |
| Slack / Teams / Discord 等の Electron アプリ | 常駐チャット | 使っていなければ終了 |
| ターミナル（Ghostty / iTerm2 / WezTerm 等） | 端末本体だけ。中で動く nvim・claude は別の塊 | 中のプロセスを閉じる方が効く |
| 常駐ユーティリティが数 GB | リークの疑い（推測） | アプリを再起動して減るか見る |

## system / shell

- `system`（macOS 本体: WindowServer・Finder 等）と `shell`（シェル・login・tmux・zellij）は消さない。大きければ再起動の判断材料として伝えるだけ
- `shell` の `top` に tmux / zellij の server が複数いるときは、切り離したまま残っているセッションを疑う（`tmux ls` / `zellij ls`）。
  中で動く nvim や claude は別の塊として出ているので、セッションを閉じるとそれらも終わることを添える
