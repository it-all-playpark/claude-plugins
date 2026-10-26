# Project overview

claude-plugins — Claude Code plugin（`playpark` marketplace）のモノレポ。cross-vendor の coding agent
で共通の project context を提供する。

This file follows the [agents.md](https://agents.md) standard (Linux Foundation AAIF, 2025-12).
Subdirectory `AGENTS.md` files take precedence over this root file for their respective paths.

## Setup commands

```bash
# テスト実行
bash tests/run-all-bats.sh           # ローカル開発 (bats 未インストール時は graceful skip)
bash tests/run-all-bats.sh --strict  # CI 用 (bats 未インストールを error 扱い)
```

plugin の install 手順（marketplace / link mode）は README.md を参照。

新規スキル作成は `/skill-creator` を使用。新規 skill は `plugins/playpark-skills/<name>/` に作る。
共有処理は plugin 内の `_shared/` か `_lib/` に配置し、plugin を跨ぐ共有は playpark-core
(`_lib/common.sh` は locator経由、実行物は `bin/` の bare 名) を使う。

## Code style

- **SKILL.md の description は簡潔に** — 常にコンテキスト消費される (15,000 文字 budget)
- **決定論的処理はスクリプトに抽出** — ファイル検索・JSON操作・git操作・API呼び出し
- **Progressive Disclosure** — SKILL.md は概要、詳細は `references/` に分離
- **Namespace 命名** — `dev-*`, `blog-*`, `git-*`, `sns-*` 等でグループ化
- **既存パターンに従う** — 新規スキルは同カテゴリの既存スキルを参考にする
- **共有処理は plugin 内の `_shared/` か `_lib/`** — スキル間で重複するロジックは共有化。
  plugin を跨ぐ共有は playpark-core（`_lib/common.sh` は PATH 上の `bin/journal` 経由の
  locator で解決。実行物は `bin/` の bare 名で呼ぶ）
- **後方互換 scaffolding を作らない** — schema 変更で legacy fallback / version enum / dual-path を入れない。新形式のみ受理
- **「なぜ」は残し「経緯」は書かない** — 判別基準は「次にこのファイルを触る agent の判断を変えるか」。
  不変条件・sunset トリガ・fail-closed の理由は残す (理由なきルールは圧力下で合理化して破られる)。
  比較検討テーブル・不採用案・旧仕様の解説は書かない (腐って現行 invariant と逆を指示する)。追跡は git log / issue
- **LLM が後で読む・判定に使う成果物は書き手が要点を選ぶ** — PR 本文・handoff・evaluator への入力などは
  全文を転写せず、上限は実測か要件から決めた必要量にする。超えたら機械的に切らず、中身を知る書き手
  (implementer 等) に要約を差し戻す (長い文脈は判定を歪め、黙った clip は必要な行を落とす)

SKILL.md description は third-person 命令形で書く (`Extracts ...`, `Converts ...`)。
`Use when:` には具体トリガ語を列挙する。`"I"` / `"this skill"` 等の一人称は禁止。
控えめに書くと Claude が呼ばない — push 気味に書く。

## Public repo

本 repo は public。第三者が clone して読み、plugin として install する前提で書く。

- **個人の絶対パス・メールアドレス・private org / repo 名・内部 ID を書かない** — 例には `acme/...` と
  placeholder（`/Users/x/`・`<user>`・`me@example.com` 等）を使う
- **分析レポート・計測結果・セッションのメモは repo に入れない** — repo root の `claudedocs` は gitignore 済み。
  経緯は issue に残す
- **実行時に本 repo・作者のパス・作者の環境（dotfiles、jev-broker など）を前提にしない** — 必要なものは
  前提条件として書き、可能なら設定や引数で受け取る
- **plugin の hook は既定で状態を変えない** — プロセスの kill・ファイル削除・外部送信は opt-in にする
  （lint では判定できないので規約で持つ）

機械的に検出できる部分（ホームディレクトリの絶対パス・メールアドレス・private org の参照・内部メモと
transcript パス・plugins/ の実行経路での本 repo のハードコード）は `tests/public-repo-hygiene.bats` が
全追跡ファイルを走査して CI で強制する。placeholder の例外はそのテストの許可リストに理由付きで足す。

## Testing instructions

決定論的スクリプトには bats (`*.bats`) でユニットテストを書く。テストファイルは実装スクリプトの隣に配置:

```
skill-name/scripts/foo.sh      # 実装
skill-name/scripts/foo.bats    # テスト (隣接配置)
```

bats が見つからない環境でも `tests/run-all-bats.sh` は exit 0 を返すため、
ローカル開発を阻害しない。CI からは `--strict` を渡して bats のインストール漏れを検出する。

`skill-name/scripts/foo.bats` のように単体 `bats` を直接呼ぶ場合は、cross-plugin の
`_lib/common.sh` locator が解決できるよう `PATH="<repo>/plugins/playpark-core/bin:<repo>/plugins/dev-flow/bin:$PATH"`
を前置すること（`tests/run-all-bats.sh` はこの前置を自動で行う）。

## Architectural guardrails

### dev-flow / pr-iterate / dev-flow-health

`/dev-flow` は skill wrapper (`dev-flow/SKILL.md`) が isolation preflight（worktree 作成 →
`EnterWorktree`）を行い、orchestration 本体は dynamic workflow `dev-flow-run`
(`plugins/dev-flow/.claude/workflows/dev-flow.js`) が持つ。phase 遷移 / 各ループは workflow script が
JS で保持し、中間 state は script 変数に持つ (外部 state JSON は持たない)。

```
/dev-flow <issue>   → [wrapper preflight] → Setup(末尾で決定論 analyze ゲート)
                      → Implement(dev-implementer 1 spawn) → Validate(test green)
                      → Diff triage(realized diff から shape 判定) → Evaluate → PR → workflow('dev-flow:pr-iterate-run')
                      → Final reconcile(fixes_applied>0 のみ) → Merge tier
/pr-iterate <pr>    → [wrapper preflight: pr-iterate-prerun → EnterWorktree] → Workflow('dev-flow:pr-iterate-run') で
                      review ⇄ fix loop (LGTM まで, 上限10)。dev-flow からは nested 起動
日次 launchd         → [macOS のみ。dev-flow-health/scripts/install-schedule.sh --install --repo <skills checkout> を
                      手動で 1 回実行して登録した場合だけ動く]
                      → dev-flow-health/scripts/daily.sh: 失敗の型を決定論で集計（new / ongoing / resolved / regressed + 候補 commit）
                      → new / regressed がある日だけ /dev-flow-health が原因を推定して self-improve issue を起票
```

不変条件 (どのモデル世代でも緩めない):

- **merge は常に人間** (LGTM 後にユーザーが merge)。全 tier で例外なし。
- **軸A invariant** — deterministic oracle / seed / critical アイテムは全 `gate_policy` で blocking。
  danger-grep の fail-closed（失敗は全 SEC seed unchecked → HOLD）と決定論ゲートを policy で緩めない。
- **1 issue = 1 PR**。Implement は全 shape で `dev-implementer`（plan+impl 統合）を単一 worktree に 1 spawn する（planner ⇄ reviewer ループ・parallel fan-out は持たない）。
- **後方互換 scaffolding を作らない** — out-of-enum 値は明示 error (legacy fallback / version 分岐なし)。
- `plugins/dev-flow/.claude/workflows/*.js` の `// ==== BEGIN inline: <path> ====` 〜
  `// ==== END inline: <path> ====` 区間は**生成物であり直接編集禁止**。編集は `_lib` の
  canonical 側で行い `tools/sync-inlines.mjs --write`（repo root、既定 root は
  `plugins/dev-flow`）で再生成する。
- Claude 専用 (workflow 依存)。cross-vendor portability は dev-flow / pr-iterate のみ放棄する例外扱い。

不変条件（fail-closed の理由・sunset トリガ・起動形の制約）は
[`.claude/rules/dev-flow.md`](.claude/rules/dev-flow.md) を参照。dev-flow 本体
(`plugins/dev-flow/.claude/workflows/` / `plugins/dev-flow/agents/` / `plugins/dev-flow/_lib/` /
`tools/`) を触るときに自動で読み込まれる。経路・enum・telemetry キー一覧・W7 表・失敗ポリシー表・
inline 生成の詳細は `plugins/dev-flow/dev-flow/references/` を参照。

### 設計原則 (要約)

Code style に加えて:

1. **機能特化** — 汎用ロール (QA engineer 等) ではなく機能特化スキルを作る
2. **小タスクは vanilla** — 小さいタスクは素の Claude Code の方が優秀
3. **破壊的・大量変更系は `disable-model-invocation: true`** を検討
4. **「毎回確定実行」したい挙動は skill ではなく hook で実装**

### Subagent dispatch — 必須 5 要素

Skill が `Task` / `Agent` tool 経由で subagent を呼び出す場合、以下 5 要素を**必ず含める**:

1. **Objective** — 単一の明確なゴール
2. **Output format** — 期待する構造 (JSON schema / Markdown section / 語数上限)
3. **Tools** — 使用可能 tool と禁止 tool を明示
4. **Boundary** — 触ってはいけないファイル / commit 禁止 / ネットワーク禁止 等
5. **Token cap** — 計測可能な上限

詳細: [`plugins/playpark-core/_shared/references/subagent-dispatch.md`](plugins/playpark-core/_shared/references/subagent-dispatch.md)

## Commit / PR conventions

Conventional Commits 形式:

```
feat(skill-name):    新規スキル / 機能追加
fix(skill-name):     バグ修正
refactor(skills):    リファクタリング
chore(skill-name):   設定・ドキュメント等
```

dev-flow v2 の PR 運用: child PR は **draft** で作成 (CI suppress)、最終 `integration → main` PR は non-draft で full CI。

新規スキル作成の詳細な規約は [`docs/skill-creation-guide.md`](docs/skill-creation-guide.md) を参照
(`/skill-creator` が読み込む)。
