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

cwd は対象 project の git root（`<mdx-path>` は git root 相対で渡せる）。Claude Code の sandbox の中でそのまま動く。

Requires: `codex` CLI（`CODEX_HOME` でログイン済み）, `python3`, `jq`. `--optimize` 使用時は `vips`, `rip` も必要。
sandbox の中で動かすときは `CODEX_HOME` を sandbox から書ける場所にし、ChatGPT / OpenAI API のホストを sandbox の通信許可に入れておく。

## Config

`skill-config.json` の `generate-thumbnail` セクション:

```json
{
  "output_dir": "public/blog",
  "aspect_ratio": "16:9",
  "brand_prompt_path": "",
  "codex_model": "gpt-6-luna",
  "codex_reasoning_effort": "low"
}
```

| Key | Description | Default |
|-----|-------------|---------|
| `output_dir` | 画像出力先（git root 相対） | `public/blog` |
| `aspect_ratio` | アスペクト比（プロンプトに渡す） | `16:9` |
| `brand_prompt_path` | ブランドプロンプトファイル（git root 相対） | `""`（デフォルト使用） |
| `codex_model` | Codex agent model | `gpt-6-luna` |
| `codex_reasoning_effort` | Codex 推論深度（`low`/`medium`/`high`） | `low` |

画像モデル自体は Codex 内部で `gpt-image-2` 固定（agent モデル選択とは独立）。

### Brand Prompt

プロジェクト固有のブランドプロンプトを使用するには:
1. プロンプトファイルを作成（例: `.claude/brand-prompt.md`）
2. project `skill-config.json` で `brand_prompt_path` を設定

未設定時は `prompts/default-brand-prompt.md`（本 skill ディレクトリ内）を使用。

## 動作の補足

- Codex は `-s read-only --disable shell_tool --disable unified_exec` で起動する。Codex 自身の sandbox は Claude Code の sandbox の中で入れ子にできず shell が動かないので、shell を切って画像生成だけをさせる
- image_gen は画像を `$CODEX_HOME/generated_images/<thread_id>/` に保存する。script が `--json` の `thread.started` から thread_id を取り、そこから `output_dir` にコピーする
- Codex usage limits は通常ターンより 3-5x 早く消費されるため、量産時は注意

## 失敗の見分け方

| 症状 | 意味と対処 |
| --- | --- |
| `could not create PATH aliases: Operation not permitted` / `failed to initialize in-process app-server client: Operation not permitted` | `CODEX_HOME` が sandbox から書けない場所（既定の `~/.codex` 等）を指している。sandbox から書ける `CODEX_HOME` を設定する |
| `codex model '<name>' is not available for this account.` | ChatGPT アカウントの Codex が提供終了モデルを 400 で拒否した。`skill-config.json` の `codex_model` を利用可能なモデルにする。未設定なら script の既定値が古いので既定値を更新する。一覧は `jq -r '.. \| .slug? // empty' ~/.codex/models_cache.json \| sort -u` |
| `Codex completed but no generated image found` | codex は完走したが image_gen を呼ばなかった。ログ末尾 30 行を確認する |
| `codex exec failed` + usage limit 系のメッセージ | Codex サブスクリプションの quota 切れ。時間を置いて再試行する |
