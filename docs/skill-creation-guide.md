# Skill Creation Guide

Claude Code Skills のベストプラクティス集。

## Skill ディレクトリ構造

```
skill-name/
├── SKILL.md              # Frontmatter + ワークフロー（必須）
├── scripts/              # 決定論的処理（bash/python）
│   └── *.sh / *.py
└── references/           # Progressive disclosure 用の詳細ドキュメント
    └── *.md
```

## SKILL.md Frontmatter

```yaml
---
name: skill-name                    # slash-command 識別子
description: |                      # 常にコンテキスト注入される（簡潔に）
  One-line summary.
  Use when: (1) trigger condition, (2) another condition,
  (3) keywords: keyword1, keyword2, keyword3
  Accepts args: <required> [--optional value]
allowed-tools:                      # 許可ツール（省略時はデフォルト）
  - Bash
  - Skill
  - Task
model: sonnet                       # 実行モデル（省略可）
effort: max                         # 推論深度（省略時 session 設定を継承）
context: fork                       # fork で別コンテキスト（省略可）
agent: general-purpose              # context:fork 時のエージェント型（省略可）
disable-model-invocation: false     # true で自動呼び出し禁止
user-invocable: true                # false でメニュー非表示（background knowledge 専用）
---
```

### Frontmatter 全15フィールド

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | 表示名・slash-command 識別子（小文字・数字・ハイフン、最大 64 文字。省略時はディレクトリ名） |
| `description` | Yes | autocomplete・auto-discovery に使用。**常にコンテキスト消費**するため簡潔に。`when_to_use` と合算して **1,536 文字で truncate** される（`description` 単体の上限は無い） |
| `when_to_use` | No | `description` の補足。トリガーフレーズや使用例を記載（合算 1,536 文字制限あり） |
| `argument-hint` | No | autocomplete に表示する引数の型ヒント（例: `[issue-number]`, `<file> [--dry-run]`） |
| `arguments` | No | named positional 引数の宣言（例: `[issue, branch]`）。skill 本文で `$issue` / `$branch` として参照可能 |
| `paths` | No | glob リスト。指定パス配下でのみ自動呼び出し有効化（省略時は全パス） |
| `shell` | No | SKILL.md 本文中の `` !`command` `` 実行ブロックのシェル（`bash`（既定）/ `powershell`） |
| `allowed-tools` | No | 許可ツールリスト |
| `model` | No | 実行モデル指定。`/model` と同じ値か `inherit`: エイリアス（`default` / `best` / `fable` / `sonnet` / `opus` / `haiku` / `sonnet[1m]` / `opus[1m]` / `opusplan`）または完全な model ID（例: `claude-opus-5-5`） |
| `effort` | No | 推論深度（`low` / `medium` / `high` / `xhigh` / `max`）。session 設定を override |
| `context` | No | `fork` で分離サブエージェント |
| `agent` | No | `context:fork` 時のサブエージェントタイプ |
| `hooks` | No | ライフサイクルフック |
| `disable-model-invocation` | No | `true` で自動呼び出し禁止（危険スキル向け） |
| `user-invocable` | No | `false` でメニュー非表示（background knowledge 専用） |

参照: [Skills frontmatter reference](https://code.claude.com/docs/en/skills#frontmatter-reference)

### effort の選び方

`effort` は skill 実行時の推論深度（reasoning depth）を指定する。省略時は session の
`effortLevel`（settings.json）を継承。Opus 4.7 は 5 段階全対応、Opus 4.6 / Sonnet 4.6 は
`xhigh` 非対応で fallback する。

| 値 | 用途 | 例 |
|---|------|-----|
| `low` | 決定論的処理・CLI wrapper・フォーマット変換 | `suica-to-csv` |
| `medium` | 軽度の判断を伴う処理 | `blog-fact-check` |
| `high` | 標準的なコード生成・通常ワークフロー / 計画・レビュー・批判的分析（A/B 実測で max と精度同等） | デフォルト推奨。dev-flow の pr-reviewer と dev-implementer はこれ（evaluator は medium） |
| `xhigh` | 長時間 agentic / 大規模コーディング（Opus 4.7 限定） | 複雑な実装タスク |
| `max` | 熟考・長大推論が必要な処理（quality-gate agent の effort 固定には通常 high を推奨） | `seo-strategy` |

**判断基準**: 推論の質が出力品質を決定する skill（planning, review, critique, strategy）は `high` が品質標準ライン（A/B 実測で max と精度同等・より高速）。
決定論的 tool wrapper は `low`。迷ったら省略して session 設定に委ねる。

参照: [Claude Code docs — effort](https://code.claude.com/docs/en/skills#frontmatter-reference) /
[model-config](https://code.claude.com/docs/en/model-config#adjust-effort-level)

### description の書き方

description は**常にコンテキストに注入される**。`when_to_use` と合算して
**1,536 文字で truncate** されるため簡潔に書く。なお session 全体の skill metadata
合計は `descriptionCharacterBudget`（デフォルト 15,000 文字）で別途制限される。

```yaml
# Good: トリガー条件・キーワード・引数を含む簡潔な記述
description: |
  Generate SNS posts from blog content.
  Use when: (1) SNS告知文が必要, (2) keywords: SNS告知, 投稿文, announce
  Accepts args: <source> [--platforms LIST]

# Bad: 長すぎる説明、実装詳細の記述
description: |
  This skill reads MDX files, extracts metadata, generates platform-specific
  posts for X (280 chars), LinkedIn (1300 chars), and Facebook (1500 chars),
  with hashtag optimization and scheduling support...

# Bad: 一人称 / 動詞だけ / undertrigger（控えめすぎる表現）
description: |
  I help with PDFs.              # ❌ 一人称（"I" / "this skill" 禁止）
  Handles documents.             # ❌ 動詞だけ・"document" は汎用すぎ
  For when you need it.          # ❌ undertrigger（push 気味に書く）
```

**ルール（[T1 agent-skills/best-practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)）**:

- third-person 命令形で書く（`Extracts ...`, `Converts ...`, `Generates ...`）
- `Use when:` には具体トリガ語を列挙する（"document" のような汎用語を避け、"PDF form 抽出" 等まで具体化）
- "I" / "this skill" などの一人称は使わない
- 控えめに書くと Claude が呼ばない。push 気味に書く

## SKILL.md 本文構造

```markdown
# Skill Title

One-line description.

## Usage

```
/skill-name <required> [--optional value]
```

## Args

| Arg | Default | Description |
|-----|---------|-------------|
| `<required>` | required | 説明 |
| `--optional` | `default` | 説明 |

## Workflow

```
Step 1 → Step 2 → Step 3
```

## Step N: Title

具体的な手順。スクリプト呼び出しは `${CLAUDE_PLUGIN_ROOT}/skill-name/scripts/` を使用
（bin/ に bare 名がある決定論スクリプトはそちらを優先する）。`references/*.md` からの呼び出しは
`${CLAUDE_PLUGIN_ROOT}` が展開されず素読みされるため、必ず bin/ の bare 名
（`<skill>-<action>`、`plugins/playpark-skills/bin/` に 3 行 exec wrapper を追加）を使う。

## References

- [Detail Doc](references/detail.md) - 詳細説明
```

### Progressive Disclosure パターン

SKILL.md はワークフロー概要のみ。詳細は `references/` に分離。

```markdown
## Step Summary

| Step | Action | Complete When |
|------|--------|---------------|
| 1 | `Skill: analyze` | Analysis done |
| 2 | `scripts/process.sh` | Output generated |

Details: [Step Details](references/step-detail.md)
```

## Testing (bats)

決定論的スクリプトには bats (`*.bats`) でユニットテストを書く。

```
skill-name/scripts/foo.sh       # 実装
skill-name/scripts/foo.bats     # テスト (隣接配置)
```

実行:

```bash
# 単体
bats skill-name/scripts/foo.bats

# 全 bats を一括 (bats 未インストール時は graceful skip / --strict で fail)
tests/run-all-bats.sh
tests/run-all-bats.sh --strict   # CI 用
```

bats が見つからない環境でも `tests/run-all-bats.sh` は exit 0 を返すため、
ローカル開発を阻害しない。CI からは `--strict` を渡して bats のインストール
漏れを検出する。bats のインストール:

```bash
# macOS
brew install bats-core

# Ubuntu / Debian
apt-get install bats
```

## Scripts ディレクトリ

決定論的処理（LLM に任せるべきでない処理）はスクリプトに抽出する。

```bash
# スクリプト呼び出しパターン（bin/ に bare 名がある決定論スクリプトはそちらを優先する）
${CLAUDE_PLUGIN_ROOT}/skill-name/scripts/script-name.sh [args]
```

`references/*.md` からの呼び出しは `${CLAUDE_PLUGIN_ROOT}` が展開されないため、必ず bin/ の bare 名
（`<skill>-<action>`、`plugins/playpark-skills/bin/` に 3 行 exec wrapper を追加）を使う。

### スクリプト化すべき処理

- ファイル検索・パターンマッチング
- JSON/YAML の読み書き
- git 操作
- API 呼び出し（curl ベース）
- 状態管理（state ファイルの読み書き）

### スクリプト化すべきでない処理

- 文脈を考慮した判断
- コード生成・レビュー
- 自然言語の生成・分析

## 共有リソース

新規 skill は `plugins/playpark-skills/<name>/` に作る。共有リソースは plugin 内の
`_shared/` / `_lib/` に置く。plugin を跨ぐ共有（`_lib/common.sh` 等）は playpark-core
plugin が持ち、他 plugin からは PATH 上の `bin/journal` を起点にした locator
（`_CORE_BIN="$(command -v journal)" && source "$(dirname "$_CORE_BIN")/../_lib/common.sh"`）
経由で参照する。plugin root は version+hash 付き cache パスなので相対 `../` は plugin
境界を跨げない。

```
plugins/playpark-core/            # 共有基盤 plugin
├── _shared/references/           # 共有ドキュメント
└── _lib/
    ├── common.sh                 # 共有 bash ユーティリティ（locator 経由で参照）
    └── infra/                    # 共有インフラスクリプト

plugins/playpark-skills/          # 個人用スキル plugin
├── _shared/scripts/              # スキル共通スクリプト
└── _lib/
    ├── config.py                 # 共有 Python 設定
    └── templates/                # 共有テンプレート
```

## Skill / Agent / Command の使い分け

| 種別 | 用途 | 自動呼び出し | コンテキスト |
|------|------|-------------|-------------|
| **Skill** | 再利用可能手順、progressive disclosure | Yes | inline |
| **Agent** | 自律マルチステップ、永続メモリ | Yes（別コンテキスト） | fork |
| **Command** | オーケストレーション、ユーザー起動 | No | inline |

**優先順位**: Skill（最軽量）> Agent（別コンテキスト）> Command（自動不可）

### オーケストレーションパターン

```
User triggers /command
  → Command orchestrates
  → Command invokes Agent (別コンテキスト)
    → Agent uses preloaded Skill (ドメイン知識)
  → Command invokes Skill (inline 出力生成)
```

## 設計原則

1. **機能特化**: 汎用ロール（QA engineer 等）ではなく機能特化スキルを作る
2. **Progressive Disclosure**: description は簡潔に、詳細は references/ に分離
3. **決定論的処理の分離**: LLM に任せるべきでない処理はスクリプトに抽出
4. **Namespace 命名**: `dev-*`, `blog-*`, `git-*` 等のプレフィックスで整理
5. **小タスクは vanilla**: 小さいタスクは素の Claude Code の方が優秀
6. **破壊的・大量変更系は `disable-model-invocation: true` を検討**:
   ファイル大量移動・worktree 大量生成・外部公開を伴う skill は LLM の自動起動を禁じ、
   ユーザー明示起動（`/skill-name`）のみに限定する。
   候補例: `qiita-publish`, `zenn-publish`
7. **「毎回確定実行」したい挙動は skill ではなく hook で実装**:
   format / test / secret 検査のように LLM の判断を介さず必ず走らせたい処理は、
   skill 化すると呼び出し漏れが起きる。hook での実装を検討すること。
   hook 実装は各 plugin の `hooks/hooks.json`（`${CLAUDE_PLUGIN_ROOT}` 経由で `hooks/*.sh` を起動。
   例: plugins/playpark-core/hooks/）を参照。マシン固有の hook（通知・ブランチ保護等）のみ
   dotfiles repo の `claude-code/hooks/`
8. **後方互換 scaffolding を作らない**:
   内製スキルは外部公開ライブラリではなく本 repo 内で完結するため、schema 変更や
   dispatch 仕様変更時の **legacy fallback / version enum / dual-path 実装は禁止**。
   旧形式を返す呼び出し元は merge 前に存在せず、互換マッピングの実用上の必要性がない。
   逆に SKILL.md / scripts / tests に rollout 期間の説明を入れると常時コンテキスト消費・
   複雑性のオーバーヘッドになる。
   - schema 変更時は **新形式のみ受理**。out-of-enum は `unknown` バケット →
     `journal failure --error-category schema_error` で顕在化させる
   - 「version >= X.Y.Z なら新方式、未満なら legacy」のような分岐を作らない。
     未満は明確な error で abort、要件として「>= X.Y.Z 必須」と明示する
   - JSON schema や config の version enum は最新版 `const` で固定
   - 「クリティカルな問題があったら修正すればいい」原則 — 移行コストよりメンテ
     コストの方が高い場合は移行を即実行
   - **例外**: 外部 API / 公開フォーマット（GitHub Action input、blog MDX 等の
     ユーザー所有データ、SemVer 公開している lib）の互換性は維持する
   - 過去事例: PR #80 / PR #94 で `detect-worker.sh` dual-path や
     `legacy_success` / `legacy_fail` / `legacy_mapped` を入れて指摘・全削除
   - 例: `flow.schema.json` の `version: "2.0.0"` const を使い、`"1.0.0"` 受信時は明示 error
   - 例: dev-kickoff `--task-id` のような廃止フラグは `die_json` で即時 error

### Architectural pattern: 並列実装は task 単位（issue 分割しない）

1 issue 内で並列化できる箇所は、計画段階で `{serial, parallel}` に分解し、**単一 worktree 内**で
`parallel()` を使って fan-out する。parallel に置く task は file_changes が互いに disjoint であること。
**1 issue = 1 PR**。任意 DAG (depends_on) / child-issue 分割 / integration branch は使わない。

詳細は [`AGENTS.md`](../AGENTS.md) の「並列実装は task 単位 (issue 分割しない)」節を参照。

## Subagent Dispatch Rules

Skill が `Task` / `Agent` tool 経由で subagent を呼び出す場合、以下の規約を**必ず遵守**する。
[Anthropic: Multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) によれば delegation の品質で +90% が決まる。曖昧な委譲は重複作業・過剰呼び出し・誤った tool 選択を招く。

### 必須5要素

Subagent を呼び出すプロンプトには、以下5要素を**必ず含める**：

1. **Objective** — 単一の明確なゴール（「X を調べる」ではなく「Y が A か B かを判定する」）
2. **Output format** — 期待する構造（JSON schema / Markdown section 構成 / 語数上限）
3. **Tools** — 使用可能 tool と禁止 tool を明示
4. **Boundary** — 触ってはいけないファイル / commit 禁止 / ネットワーク禁止 等
5. **Token cap** — 「1500 語以内で」「上位 10 件まで」等の計測可能な上限

```markdown
Task(
  subagent_type: "general-purpose",
  prompt: """
  ## Objective
  [単一の明確なゴール]

  ## Output format
  [JSON schema / Markdown section / 語数上限]

  ## Tools
  - 使用可: Read, Grep, Glob
  - 禁止: Bash, Write, Edit

  ## Boundary
  - 除外: vendor/, node_modules/
  - 禁止: commit, git 操作, ネットワーク

  ## Token cap
  - 1500 語以内、最大 20 ファイル
  """
)
```

### Routing Rule Table

タスク性質に応じて subagent 種別を選択する：

| タスク性質 | 推奨 subagent | model | 理由 |
|------------|--------------|-------|------|
| 探索 heavy（Read/Grep/Glob 多用、summary のみ欲しい） | `Explore` agent / Haiku 系 | haiku | token-heavy な探索をメイン context から隔離 |
| 実装系（コード生成・編集・リファクタ） | `general-purpose` | sonnet | バランス型、tool 制約が緩い |
| plan 系（設計・計画立案） | `Plan` agent | opus | 推論品質重視 |
| review 系（コードレビュー・critique） | `code-reviewer` agent | opus | 批判的観点の品質 |
| 並列調査（複数仮説検証） | `general-purpose` × N（並列） | sonnet | 独立タスクの並列化 |

**判断基準**: 出力が大きい → Explore/Haiku、副作用あり → general-purpose/sonnet、推論深度重要 → Plan/opus または code-reviewer/opus。

### 参照

- **詳細規約・呼び出しテンプレート・失敗モード**: [`plugins/playpark-core/_shared/references/subagent-dispatch.md`](../plugins/playpark-core/_shared/references/subagent-dispatch.md)
- **チェックリスト**: 新規 skill で `Task` / `Agent` を呼ぶ前に 5要素 + routing を確認すること

## skill-config.json

スキル固有の設定は `skill-config.json`（リポジトリルート）に集約。

```json
{
  "skill-name": {
    "setting_key": "value"
  }
}
```

### Config 解決順序

**グローバル**: `$SKILL_CONFIG_PATH` > `~/.config/skills/config.json` > `~/.claude/skill-config.json`

**プロジェクト**: `$git_root/skill-config.json` > `$git_root/.claude/skill-config.json`

スクリプトからは playpark-core の `_lib/common.sh` を locator（PATH 上の `bin/journal` を
アンカーに `source "$(dirname "$(command -v journal)")/../_lib/common.sh"`）経由で source し、
`load_skill_config` / `merge_config` を使用。
LLM からは Read ツールで `skill-config.json` を直接読み取る。
