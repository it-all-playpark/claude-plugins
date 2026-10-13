# playpark Claude Code plugins

**Production-ready Claude Code plugins** — workflows, agents, hooks and skills — distributed through the `playpark` marketplace.
Codex などほかの agent からも、前提（[ほかの agent から使う](#ほかの-agentcodex-等から使う)）を満たせば `playpark-skills` を使えます。

Dev workflow automation, SEO/marketing analytics, blog operations, Git workflow, image/video processing, Google Workspace integration — all in one repo.

Built and maintained by [playpark LLC](https://www.playpark.co.jp/) — an AI development studio specializing in agent-driven workflows and business process automation.

## Quick Start

本 repo は 6 つの Claude Code plugin（`playpark-core` / `dev-flow` / `playpark-skills` / `host-exec` / `meeting` / `bg-sessions`）に
分かれています。導入方法は用途によって 2 通りあります。

### 配布側インストール（copy mode）

他リポジトリで dev-flow だけ、あるいは全スキルを使いたい場合はこちら。marketplace 経由で
copy が install されます。各 plugin は `version` を持たないため git commit SHA が version になり、
main への commit がそのまま更新として配布されます（自動で追随させるには `/plugin` の
Marketplaces で auto-update を有効化。`DISABLE_AUTOUPDATER=1` 環境では `FORCE_AUTOUPDATE_PLUGINS=1`
も必要）。

```
/plugin marketplace add it-all-playpark/claude-plugins
/plugin install playpark-core@playpark    # 共有基盤（_lib/common.sh, bin/journal）
/plugin install dev-flow@playpark         # issue-to-LGTM ワークフロー（playpark-core は dependencies で自動解決）
/plugin install playpark-skills@playpark  # 個人用スキル一式（任意）
/plugin install host-exec@playpark        # sandbox 外での承認付き実行ツール（任意）
/plugin install meeting@playpark          # 会議の自動録音・ローカル文字起こし・議事録（macOS、任意）
/plugin install bg-sessions@playpark      # bg セッションの repo・worktree をプロンプト上に表示（任意）
```

`host-exec` は hooks module（`plugins/host-exec/hooks/register.ts`）で `mcp__host-exec__run` ツールを
追加します。sandbox で動かないコマンドを、拒否パターン（破壊的操作・資格情報の出力）の静的チェックと
実行承認を経てホスト上で実行し（続くコマンドは `steps` で 1 回の承認にまとめられ、「このセッションでは同じコマンドを
聞かない」を選んだものは完全に同じ呼び出しなら聞き直さない。Bash でも sandbox の外で動く `sandbox.excludedCommands`
の一致は Bash へ回す）、出力に秘密情報らしきものがあれば Claude に渡す前に止めてマスク / 非開示を
選ばせます。実行ファイルは許可リストで絞らず、承認ダイアログに PATH で解決した実体・argv・cwd をエスケープして
見せ、Claude が書き換えられる場所の実行ファイルや一時ディレクトリの cwd、スクリプトの中身を動かすコマンドには
警告を添えます。

`meeting` は macOS 専用です。会議アプリ（Zoom / Google Meet / Teams 等）がマイクを使い始めたら自動で録音し、
Whisper と pyannote でローカルに文字起こし・話者分離して `/meeting-notes` で議事録にします。常駐（launchd）は
`meeting install` を実行したときだけ登録され、録音バイナリは plugin の外の固定パスにビルドされます。
詳細は [`plugins/meeting/README.md`](plugins/meeting/README.md)。

`bg-sessions` は `claude --bg` で動いているセッションが、どの repo のどの worktree・branch にいるかを
プロンプトの上の 1 行に出します（実行中・入力待ち・放置の件数と、実行中の `repo/worktree`）。`/bg-sessions` で
状態・repo・worktree・branch・更新・名前の一覧を開きます（Esc で閉じる）。場所は `claude agents --json` の起動時 cwd ではなく
transcript の最終行の `cwd` / `gitBranch` から取るので、セッションが入った worktree が出ます。作業しておらず
3 日以上 transcript が更新されていないものは放置として件数だけにします。セッションの停止はしません。

設定 `zellij_switch`（既定 off。`/config` の plugin の行で切り替える）を on にすると、zellij の中で動いているときに
一覧の行を `1`〜`9` か Enter で選ぶと、その repo と同じ名前（`-` と `_` の違いは同一視）の zellij セッションへ
`zellij action switch-session` で移ります。存在しない名前で switch-session すると新しいセッションが作られて
しまうので、`zellij list-sessions` に無ければ移らずに toast で知らせます。

Use skills in Claude Code:

```
/dev-flow 123             # Issue → implementation → PR → LGTM (dynamic workflow)
/git-commit --all         # Smart commit with Conventional Commits
/sns-announce article.mdx # Generate social media posts
```

### 自分用インストール（link mode）

本 repo を手元で clone して開発し、編集を即座に反映させたい場合はこちら（dev-flow 開発者向け）。

1. **本 repo を指す symlink を外す**: 以前に `~/.claude/skills` / `~/.claude/workflows` /
   `~/.claude/agents` を本 repo（の clone）への symlink にしていた場合は外してください
   （残すと bare 名 workflow の解決先が plugin 経路と symlink 経路のどちらになるか不定になります）。

2. **ユーザー settings への登録**: 自分の Claude Code ユーザー settings.json
   （`~/.claude/settings.json` など、マシンごとの設定）で、`extraKnownMarketplaces` に
   command source（本 repo の clone の絶対パス）を `"mode": "link"` で登録し、`enabledPlugins` に
   `playpark-core` / `dev-flow` / `playpark-skills` の 3 件を並べます。clone の絶対パスは
   マシン固有なので、本 repo の git 管理ファイル（`.claude/settings.json` 等）には書きません。

   dev-flow 専用 hook（`stop-devflow-telemetry.sh` / `pretool-inline-edit-guard.sh` /
   `pretool-bash-inline-commit-gate.sh`）は `plugins/dev-flow/hooks/hooks.json`、全 skill 共通
   hook（journal hook-capture・track-skill・clear-skill-ctx / `validate-skill-frontmatter.sh` /
   `posttool-secret-mask.sh` / `pretool-context-guard.sh`）は `plugins/playpark-core/hooks/hooks.json` から、それぞれ
   `${CLAUDE_PLUGIN_ROOT}` 経由で発火します。同じ hook を settings.json に直接登録していた場合は
   そちらを削除してください（残すと二重に発火し、hook-capture が二重記録されます）。

3. **個別 install**: command source（link mode）の plugin は `dependencies` が自動解決されないため、
   3 plugin を個別に `/plugin install` してください。

4. **再起動して解決確認**: Claude Code を再起動したうえで、以下を確認します。

   ```bash
   command -v journal              # playpark-core の bin/journal が解決すること
   command -v secfloor-classify    # dev-flow の bin/ が解決すること
   ```

   `/dev-flow <issue>` を実行し、`dev-flow:dev-flow-run` が起動することを確認してください。

5. **即時反映の確認**: link mode では repo のファイル編集が再 install なしに反映されます。
   任意の SKILL.md を 1 語変更 → `/reload-plugins` → 反映を確認してください。

`dev-flow` plugin では skills（フラット構造）と `agents/` 配下の agent 定義が plugin として
認識されます。plugin の subagent は plugin root の `agents/` からのみ読み込まれるため、
agent 定義の実体は `plugins/dev-flow/agents/` に置き、`plugins/dev-flow/.claude/agents` は
そこへの symlink にしてあります（定義は 1 箇所だけで、コピーの同期は不要）。

この向きは意図的です。symlink は `core.symlinks=false` の環境（Developer Mode 無効の Windows 等）
では中身がパス文字列の通常ファイルとして checkout されるため、`agents/` 側を symlink にすると
plugin install が skill だけ読み込んで **agent が 0 件のまま成功したように見える**。実体を
`agents/` に置けば、そうした環境で影響を受けるのは `plugins/dev-flow/.claude/agents`（本 repo で
dev-flow を開発する場合のみ使う）だけで済みます。`tests/plugin-manifest.bats` がこの向きを pin します。

### ほかの agent（Codex 等）から使う

`dev-flow` plugin（dynamic workflow・subagent・hook）は Claude Code 専用です。ほかの agent から
使えるのは `playpark-skills` の skill だけで、clone した本 repo を symlink で参照させます。
skill とその script は Claude Code plugin の実行環境を前提に書かれているため、次の 2 つを
自分で用意してください。

- **PATH**: `plugins/playpark-core/bin` と `plugins/playpark-skills/bin` を PATH に通す。
  `_lib/common.sh` を使う script は PATH 上の `journal`（playpark-core の `bin/journal`）から
  `common.sh` を探すため、`plugins/playpark-core/bin` が無いと exit 127 で止まります。SKILL.md が
  呼ぶ `<skill>-<action>` 形式の bare 名コマンドは `plugins/playpark-skills/bin` にあります。
- **`${CLAUDE_PLUGIN_ROOT}`**: Claude Code が SKILL.md 読み込み時に plugin root へ展開する変数で、
  ほかの agent では展開されません。`<repo>/plugins/playpark-skills` を同名の環境変数として export
  してください。

```bash
# <repo> は本 repo の clone 先
ln -sf <repo>/plugins/playpark-skills ~/.<tool>/skills
export PATH="<repo>/plugins/playpark-core/bin:<repo>/plugins/playpark-skills/bin:$PATH"
export CLAUDE_PLUGIN_ROOT="<repo>/plugins/playpark-skills"
```

hook（secret mask・context guard 等）はほかの agent では動きません。

### External Skills Integration (skills.sh)

[skills.sh](https://skills.sh) で取得した外部スキルは `plugins/playpark-skills/.agents/skills/` に
配置し、`plugins/playpark-skills/` 直下へのシンボリックリンクで統合します。

```bash
# 復元（新規マシン）: lockfile と実体は plugin 配下にあるので CWD を移して実行する
cd plugins/playpark-skills && npx skills experimental_install

# Automated symlink management
plugins/playpark-core/_lib/infra/link-agent-skills.sh    # Create symlinks + update .gitignore
plugins/playpark-core/_lib/infra/unlink-agent-skills.sh  # Remove symlinks
```

実体を repo root の `.agents/` ではなく plugin 配下に置くのは、`claude plugin install`
（mode: link）が **plugin ディレクトリの外を指す top-level entry を見つけると install 自体を
拒否する**ためです。root に実体を置くと symlink が plugin の外へ脱出してこのガードに引っかかり、
`playpark-skills` が install できなくなります。実体を plugin 配下に移せば symlink が plugin 内で
完結し、実体は 1 箇所のまま（コピーによる二重管理なし）install が通ります。

なお `.agents/` は `.gitignore` されているため、外部スキルは plugin に同梱されません。GitHub
marketplace 経由の `/plugin install playpark-skills@playpark` では入らないので、必要なら上の
復元コマンドを別途実行してください。

## 設定（skill-config.json）

スキルの設定は **グローバル**（ユーザー共通）と **プロジェクト** の2階層で管理できます。プロジェクト設定がグローバル設定を deep merge で上書きします。

### 設定ファイルの配置

```
skill-config.json                              # プロジェクト設定（リポジトリルート）
~/.config/skills/config.json                    # グローバル設定（ツール非依存）
```

### マージ順序（後勝ち）

```
スキル内蔵デフォルト ← グローバル config ← プロジェクト skill-config.json[skill]
                        (グローバル)                         (プロジェクト: 最優先)
```

**設定の読み込み優先順位:**

1. `<project>/skill-config.json` の該当スキルセクション（最優先）
2. グローバル config（`$SKILL_CONFIG_PATH` > `~/.config/skills/config.json` > `~/.claude/skill-config.json`）
3. スキル内蔵のデフォルト値

### グローバル設定の例

ユーザー共通のプリファレンスを記述します: `cp skill-config.json ~/.config/skills/config.json`

```jsonc
// ~/.config/skills/config.json (or ~/.claude/skill-config.json)
{
  "sns-announce": {
    "default_lang": "ja",
    "platforms": {
      "x": { "enabled": true },
      "linkedin": { "enabled": true }
    }
  },
  "trends-analyzer": {
    "geo": "JP"
  }
}
```

### マージ動作例

```jsonc
// ~/.config/skills/config.json (or ~/.claude/skill-config.json) (グローバル)
{
  "sns-announce": {
    "default_lang": "ja",
    "platforms": { "x": { "enabled": true }, "linkedin": { "enabled": true } }
  }
}

// <project>/.claude/skill-config.json (プロジェクト)
{
  "sns-announce": {
    "base_url": "https://example.com",
    "platforms": { "linkedin": { "enabled": false } }
  }
}

// → マージ結果
{
  "sns-announce": {
    "default_lang": "ja",                   // グローバルから継承
    "base_url": "https://example.com",      // プロジェクトで追加
    "platforms": {
      "x": { "enabled": true },             // グローバルから継承
      "linkedin": { "enabled": false }      // プロジェクトで上書き
    }
  }
}
```

### 対応スキルと設定項目

#### ga-analyzer

| キー | 型 | 説明 |
|------|-----|------|
| `property_id` | string | GA4 プロパティID（必須） |

#### gsc

| キー | 型 | 説明 |
|------|-----|------|
| `site` | string | GSCサイトURL（例: `"sc-domain:example.com"`） |
| `default_days` | number | デフォルト分析日数 |
| `default_limit` | number | 取得件数上限 |
| `output_dir` | string | 出力先ディレクトリ |

#### sns-announce

| キー | 型 | 説明 |
|------|-----|------|
| `base_url` | string | 記事のベースURL |
| `url_pattern` | string | URLパターン（例: `"/blog/{slug}"`） |
| `default_lang` | string | 投稿言語（デフォルト: `"ja"`） |
| `platforms` | object | プラットフォーム別設定 |
| `platforms.<name>.enabled` | boolean | 有効/無効 |
| `platforms.<name>.char_limit` | number | 文字数上限 |
| `output` | object | 出力設定 |
| `output.dir` | string | 出力ディレクトリ |
| `output.pattern` | string | ファイル名パターン |
| `schedule.enabled` | boolean | 自動スケジュール有効/無効 |
| `schedule.mode` | string | スケジュールモード |

#### trends-analyzer

| キー | 型 | 説明 |
|------|-----|------|
| `geo` | string | 地域コード（デフォルト: `"JP"`） |
| `timeframe` | string | 分析期間（デフォルト: `"today 3-m"`） |
| `top_n` | number | 上位N件取得 |
| `title_strip_patterns` | string[] | タイトルから除去する正規表現 |

#### meeting-notes

| キー | 型 | 説明 |
|------|-----|------|
| `output_dir` | string | 議事録の保存先（デフォルト: `"meetings"`） |
| `transcripts_dir` | string | 全文の文字起こしの保存先（デフォルト: `"<output_dir>/transcripts"`。git 管理外にする） |
| `save_transcript` | boolean | 全文の文字起こしを保存するか（デフォルト: `true`） |

### 設定例

```jsonc
// <project-root>/skill-config.json
{
  "ga-analyzer": {
    "property_id": "123456789"
  },
  "sns-announce": {
    "base_url": "https://example.com",
    "url_pattern": "/blog/{slug}",
    "platforms": {
      "x": { "enabled": true },
      "linkedin": { "enabled": true }
    }
  }
}
```

### スクリプトからの利用

```bash
# Bash: playpark-core の _lib/common.sh を PATH 上の bin/journal 経由で解決する
# （plugin root は version+hash 付き cache パスなので相対 `../` では跨げない）
# → global + project の merged config が返る
_CORE_BIN="$(command -v journal)" || { echo "playpark-core plugin (bin/journal) not on PATH" >&2; exit 127; }
source "$(dirname "$_CORE_BIN")/../_lib/common.sh"
config=$(load_skill_config "ga-analyzer")
```

```python
# Python: playpark-skills の _lib/config.py を使う。_lib は package ではない（__init__.py が無い）ので、
# <skill>/scripts/ の script から _lib を sys.path に足してモジュール名 config で import する
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "_lib"))
from config import merge_config

config = merge_config({"property_id": None}, "ga-analyzer")  # defaults → global + project config
```

## スキル一覧

### 開発ワークフロー

| スキル | 説明 |
|--------|------|
| `dev-flow` | Issue → LGTM までのE2E開発フロー (dynamic workflow: `plugins/dev-flow/.claude/workflows/dev-flow.js`) |
| `dev-issue-analyze` | GitHub Issue分析・実装計画 |
| `dev-flow-health` | dev-flow の失敗を日次で型ごとに集計し、new / regressed の日だけ原因を推定して issue 化 |
| `dep-guardian` | 依存関係更新PRのトリアージ・テスト・バッチマージ |

> `dev-flow` の判断系 leaf (計画/レビュー/実装/評価) は subagent (`plugins/dev-flow/agents/`) として実装。
> 最終 PR レビューは `dev-flow:pr-iterate-run` workflow (`/pr-iterate <pr>` の wrapper skill で単体起動も可)。

📊 **[dev-flow Pipeline Atlas](docs/dev-flow-atlas.md)** — 8 phase のパイプライン・shape 判定・
`pr-iterate` ループ・merge tier 判定を mermaid 図で示した実装ベースの索引。
規約の正典は [`.claude/rules/dev-flow.md`](.claude/rules/dev-flow.md)。

### Git操作

| スキル | 説明 |
|--------|------|
| `git-commit` | 変更分析・Conventional Commits生成 |
| `git-pr` | GitHub PR作成 |

### PR/レビュー

| スキル | 説明 |
|--------|------|
| `pr-iterate` | LGTM取得までの review ⇄ fix 改善ループ (wrapper skill が `pr-iterate-prerun` で PR head の worktree を用意し dynamic workflow `pr-iterate-run` を起動) |

### ドキュメント

| スキル | 説明 |
|--------|------|
| `marp-slide` | Marpプレゼンテーションスライド生成 |

### 分析・思考

| スキル | 説明 |
|--------|------|
| `github-issue-orchestrator` | 議論からGitHub Issue作成（技術調査・レビュー付き） |

### SEO/マーケティング分析

| スキル | 説明 |
|--------|------|
| `ga-analyzer` | GA4データ分析・サイト改善アドバイス |
| `gsc` | Google Search Consoleクエリ・SEOデータ取得 🔗 |
| `trends-analyzer` | Google Trendsキーワードトレンド分析 |

### ブログ運用

| スキル | 説明 |
|--------|------|
| `zenn-publish` | Zennへの公開 |
| `qiita-publish` | Qiitaへの公開 |
| `generate-thumbnail` | Codex CLI built-in image_gen（gpt-image-2）によるブログサムネイル生成 |

### SNS・投稿スケジュール

| スキル | 説明 |
|--------|------|
| `sns-announce` | SNS告知文生成（X/LinkedIn/Facebook/Bluesky/Threads等） |
| `zernio` | Zernio CLIによるSNS投稿スケジュール・同期（post/sync） |

### Google Workspace

| スキル | 説明 |
|--------|------|
| `gmail-cleanup` | 古いプロモーション等を毎日ゴミ箱へ移す GAS を、repo の設定 JSON から各アカウントへデプロイ |
| `gmail-receipts` | 領収書ラベルのメールを毎日 Drive の YYYY/MM へ保存してアーカイブする GAS を、repo の設定 JSON から各アカウントへデプロイ |

### ビジネス・戦略

| スキル | 説明 |
|--------|------|
| `biz-card-to-sheet` | 名刺画像からスプレッドシートへ登録 |
| `biz-card-search` | 登録済み名刺データ検索 |

### 会議

| スキル | 説明 |
|--------|------|
| `meeting-notes` | `meeting` plugin が録音・文字起こしした会議（話者識別付き）から議事録を作成（要約・決定事項・TODO） |

### ユーティリティ

| スキル | 説明 |
|--------|------|
| `skill-creator` | 新規スキル作成ガイド（当リポジトリ規約版） |
| `mem-triage` | macOS のメモリをアプリ・端末から起動したもの・launchd の常駐の塊ごとに合算し、解放方法と「聞かずに消してよいか」を示す（kill はユーザーが実行） |
| `sandbox-tune` | transcript から sandbox 拒否・permission 拒否・人間への実行依頼を型ごとに集計し、設定 repo の git log と突き合わせて settings 修正の候補を根拠付きで出す（issue 化は `--issue` のときだけ） |
| `suica-to-csv` | モバイルSuica明細PDFをマネーフォワード経費CSVに変換 |
| `agent-browser` | ブラウザ自動操作（ページ操作/スクレイピング/テスト） 🔗 |

> 🔗 = skills.sh 由来の外部スキル（`plugins/playpark-skills/.agents/skills/` からシンボリックリンク。gitignored のため plugin には同梱されない）

## 使い方

Claude Code内で `/スキル名` を実行:

```
/git-commit --all
/dev-flow 123
/sns-announce
```

## 構造

本 repo は 5 plugin 構成です（`.claude-plugin/marketplace.json` に登録）。

```
skills/
├── plugins/
│   ├── playpark-core/                    # 共有基盤 plugin（skill なし。hooks と journal 基盤）
│   │   ├── _lib/
│   │   │   ├── common.sh                 # Bash共通関数（設定読み込み等）
│   │   │   └── infra/                    # リポジトリ基盤管理スクリプト
│   │   │       ├── link-agent-skills.sh    # 外部スキルのsymlink管理
│   │   │       └── unlink-agent-skills.sh  # symlink解除
│   │   ├── _shared/
│   │   │   └── references/subagent-dispatch.md  # Subagent dispatch 必須5要素
│   │   ├── bin/journal                   # core bare 名 wrapper
│   │   └── journal/                      # journal.sh（dev-flow telemetry・失敗記録）
│   ├── dev-flow/                         # issue-to-LGTM ワークフロー plugin（skills + agents + workflows）
│   │   ├── .claude/
│   │   │   ├── workflows/                # dynamic workflow js（dev-flow.js / pr-iterate.js 等）
│   │   │   └── agents -> ../agents       # symlink（plugin subagent 読み込み用）
│   │   ├── agents/                       # dev-flow agent 定義の実体
│   │   ├── _lib/                         # workflow のロジック本体・test
│   │   ├── _shared/scripts/              # dev-flow 共通スクリプト
│   │   ├── bin/                          # dev-flow bare 名 wrapper
│   │   └── dev-flow/, dev-flow-health/, dev-issue-analyze/,
│   │       git-commit/, git-pr/, github-issue-orchestrator/,
│   │       pr-iterate/（各 SKILL.md）
│   ├── playpark-skills/                  # 個人用スキル plugin（dependencies: playpark-core）
│   │   ├── bin/                          # playpark-skills bare 名 wrapper（<skill>-<action> 命名）
│   │   ├── _lib/config.py                # Python共通設定ローダー
│   │   ├── _shared/                      # スキル共通ユーティリティ・schemas・templates
│   │   ├── <skill-name>/                 # 各スキル（自作）
│   │   │   ├── SKILL.md                  # スキル定義（必須）
│   │   │   ├── scripts/                  # 実行スクリプト
│   │   │   ├── references/               # 参照ドキュメント
│   │   │   └── assets/                   # アセット
│   │   ├── <skill-name> -> .agents/skills/<name>  # 外部スキル（symlink・gitignored）
│   │   ├── .agents/skills/               # 外部スキル実体（gitignored）
│   │   └── skills-lock.json              # 外部スキルの lockfile（tracked）
│   ├── host-exec/                        # sandbox 外の承認付き実行ツール plugin（skill なし）
│   │   ├── hooks/register.ts             # ツール登録と 3 段のゲート
│   │   ├── types/index.d.ts              # $.state の型（承認を記憶したコマンド）
│   │   └── tests/host-exec.test.ts       # claude plugin test で実行
│   ├── meeting/                          # 会議の自動録音・文字起こし・議事録 plugin（macOS）
│   │   ├── bin/meeting                   # CLI（setup で固定パスにインストール）
│   │   ├── recorder/                     # Swift: ScreenCaptureKit 録音 + CoreAudio で会議検知
│   │   ├── transcribe/                   # Python: mlx-whisper + pyannote
│   │   └── meeting-notes/SKILL.md
│   └── bg-sessions/                      # bg セッションの repo・worktree 表示 plugin（skill なし）
│       ├── hooks/register.tsx            # 帯・/bg-sessions 一覧・15 秒ごとの取得
│       ├── hooks/sessions.ts             # agents --json と transcript 末尾の解釈
│       └── tests/bg-sessions.test.ts     # claude plugin test で実行
├── tools/                                 # sync-inlines.mjs 等 repo 全体ツール
├── tests/                                 # bats / vitest ランナーと横断テスト
├── docs/                                  # dev-flow-atlas.md 等ドキュメント
├── .claude/rules/                         # dev-flow.md（正典）
├── .claude-plugin/marketplace.json        # 5 plugin の登録
├── .gitignore                             # 外部スキルsymlink・実体を自動管理
└── README.md
```

## Contributing

Issues and Pull Requests are welcome. Each skill follows this structure:

```
<skill-name>/
├── SKILL.md             # Skill definition (required)
├── scripts/             # Execution scripts
├── references/          # Reference documents
└── assets/              # Assets
```

### テスト実行

`bash tests/run-all-bats.sh` / `bash tests/run-node-tests.sh` は `plugins/playpark-core/bin` と
`plugins/dev-flow/bin` を PATH 先頭へ自動で前置してから実行します（cross-plugin の
`_lib/common.sh` locator が PATH 上の `bin/journal` をアンカーに解決するため）。個別の `.bats`
ファイルを単体実行する場合は同じ前置を自分で行ってください。

```bash
PATH="<repo>/plugins/playpark-core/bin:<repo>/plugins/dev-flow/bin:$PATH" bats <file>
```

## veridelta dogfooding

本 repo は [veridelta](https://github.com/it-all-playpark/veridelta)（`vdelta` CLI）を
dev-flow の redgreen 判定フックにdogfooding導入している。`package.json` の devDependencies に `vdelta` があり
テストランナーが vitest のとき、redgreen-verify が vitest の実行を `vdelta run` で包み `vdelta compare` の verdict を
結果に載せる（専用の設定ファイルは無い）。

- **運用ルール**: vdelta の摩擦・バグ・欲しい機能に気づいたら
  [veridelta repo](https://github.com/it-all-playpark/veridelta) に issue を起票し、
  本 repo の issue [#356](https://github.com/it-all-playpark/claude-plugins/issues/356) にリンクを残すこと。
- **移行時実測値**（node --test → vitest 移行、2026-07-16）: `node --test` 1007 tests /
  `vitest` 1007 tests passed（総件数一致を確認済み）。
- **記録範囲**: vdelta の verdict（`vdelta compare --report json` の出力）は dev-flow
  telemetry handoff の pending JSON（`~/.claude/journal/pending/`）に書き出されるところまでが
  本 issue の記録範囲。journal 本体（`journal.sh log`）への反映は dev-flow plugin の Stop hook
  （`plugins/dev-flow/hooks/stop-devflow-telemetry.sh`）の jq whitelist 拡張が必要なため別 issue とする。

## About playpark LLC

AI開発を専門とするソフトウェア開発スタジオです。AIエージェントを活用した開発ワークフロー自動化、業務プロセスのAI化を得意としています。

- Web: [playpark.co.jp](https://www.playpark.co.jp/)
- Blog: [playpark.co.jp/blog](https://www.playpark.co.jp/blog/) — AI coding tools, agent workflows, and more
- Contact: [playpark.co.jp/contact](https://www.playpark.co.jp/contact/) — AI開発・業務自動化のご相談

## License

MIT License（[LICENSE](LICENSE)）。各 plugin（`playpark-core` / `dev-flow` / `playpark-skills`）の
`plugin.json` の `license` も MIT です。

外部スキル（`plugins/playpark-skills/skills-lock.json` に載る skills.sh 由来の skill）は本 repo に
同梱しておらず、MIT の対象外です。それぞれ取得元（lockfile の `source`）の上流 repo の license に従います。
