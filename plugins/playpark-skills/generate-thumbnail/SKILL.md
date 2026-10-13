---
name: generate-thumbnail
description: |
  Generate blog thumbnail via Codex CLI built-in image_gen (gpt-image-2).
  Use when: (1) user wants to create thumbnail for blog article,
  (2) keywords like "サムネイル生成", "thumbnail", "OGP画像", "サムネ作成",
  (3) after /blog-publish or /seed-to-blog execution.
  Accepts args: MDX_PATH [--optimize]
user-invocable: true
context: fork
model: haiku
---

# Generate Thumbnail

Generate blog thumbnail from MDX frontmatter via Codex CLI built-in `image_gen` tool (gpt-image-2). API キー不要、Codex サブスクリプションの usage limit を消費する。

```bash
generate-thumbnail content/blog/<file>.mdx --optimize
```

Options: `--optimize` converts to WebP and deletes original PNG.

## 絶対に守る制約

**必ず bare 名 `generate-thumbnail` を先頭トークンにして単独で呼ぶ**（plugin の `bin/` が PATH に載っている）。
sandbox 除外は呼び出しコマンドの先頭トークンのテキスト一致で判定され、前提として `generate-thumbnail` /
`generate-thumbnail *` が `sandbox.excludedCommands` に入っている。`cd "$ROOT" && generate-thumbnail …`、
`VAR=… generate-thumbnail …`、`$(…)` で包む形は excludedCommands に一致せず sandbox 内実行に落ち、
内部の `codex exec` が app-server 初期化で `Operation not permitted` になって死ぬ。

- cwd は対象 project の git root でよい（`<mdx-path>` は git root 相対で渡せる）。`cd` を前置しない
- 素の `codex exec "echo hi"` が通ることは、この skill が動く証拠にならない（`codex:*` は先頭トークンが `codex` のときだけ除外される）

Requires: `codex` CLI（ログイン済み）, `python3`, `jq`. `--optimize` 使用時は `vips`, `rip` も必要。

## Config

`skill-config.json` の `generate-thumbnail` セクション:

```json
{
  "output_dir": "public/blog",
  "aspect_ratio": "16:9",
  "brand_prompt_path": "",
  "codex_model": "gpt-5.5",
  "codex_reasoning_effort": "low"
}
```

| Key | Description | Default |
|-----|-------------|---------|
| `output_dir` | 画像出力先（git root 相対） | `public/blog` |
| `aspect_ratio` | アスペクト比（プロンプトに渡す） | `16:9` |
| `brand_prompt_path` | ブランドプロンプトファイル（git root 相対） | `""`（デフォルト使用） |
| `codex_model` | Codex agent model | `gpt-5.5` |
| `codex_reasoning_effort` | Codex 推論深度（`low`/`medium`/`high`） | `low` |

画像モデル自体は Codex 内部で `gpt-image-2` 固定（agent モデル選択とは独立）。

### Brand Prompt

プロジェクト固有のブランドプロンプトを使用するには:
1. プロンプトファイルを作成（例: `.claude/brand-prompt.md`）
2. project `skill-config.json` で `brand_prompt_path` を設定

未設定時は `prompts/default-brand-prompt.md`（本 skill ディレクトリ内）を使用。

## 動作の補足

- Codex は画像を `$CODEX_HOME/generated_images/<session-id>/` 以下に保存後、エージェントが指定パスにコピーする
- `codex exec --skip-git-repo-check` を内部で使用。自動承認は `--approve-for-me`（codex 0.147.0 以降が前提）。sandbox-write を維持したままの自動承認で、書き込み範囲は `output_dir` のみを想定。sandbox を外す `--dangerously-bypass-approvals-and-sandbox` は使わない
- Codex usage limits は通常ターンより 3-5x 早く消費されるため、量産時は注意

## 失敗の見分け方

| 症状 | 意味と対処 |
| --- | --- |
| `could not create PATH aliases: Operation not permitted` / `failed to initialize in-process app-server client: Operation not permitted` | sandbox 内から実行している。bare 名 `generate-thumbnail` で呼んでいない（`cd … &&`・変数の前置・`$( )` で包むと excludedCommands に一致せず sandbox 内実行に落ちる）。**環境ブロッカーと断定せず、bare 名 `generate-thumbnail` で呼び直す**。素の `codex exec` が通ることは反証にならない |
| `codex model '<name>' is not available for this account.` | ChatGPT アカウントの Codex が提供終了モデルを 400 で拒否した。`skill-config.json` の `codex_model` を利用可能なモデルにする。未設定なら script の既定値が古いので既定値を更新する。一覧は `jq -r '.. \| .slug? // empty' ~/.codex/models_cache.json \| sort -u` |
| `Codex completed but output file not found` | codex は完走したが画像を書かなかった（agent がコピーを省いた等）。ログ末尾 30 行を確認する |
| `codex exec failed` + usage limit 系のメッセージ | Codex サブスクリプションの quota 切れ。時間を置いて再試行する |
