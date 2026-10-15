---
name: zernio
description: |
  Zernio CLI wrapper for SNS scheduling and sync.
  Use when: (1) scheduling or posting to SNS platforms (X, LinkedIn, Facebook, Google Business, Threads, Bluesky, Instagram, YouTube, TikTok),
  (2) syncing local JSON files with Zernio API,
  (3) after /sns-announce to schedule generated posts,
  (4) keywords: "SNS投稿", "予約投稿", "schedule post", "Zernio同期", "sync Zernio", "SNS同期".
  Accepts args: post|sync [OPTIONS]
user-invocable: true
argument-hint: post|sync [OPTIONS]
---

# Zernio

> **CRITICAL**: zernio CLI を直接呼び出さないでください。必ず `/zernio` スキル経由で実行してください。
> スキルが `scripts/resolve-config.sh`（共有ローダー `load_skill_config`）で `sync_dirs`, `profile_id` を自動解決します。
> 直接CLIを叩くと `sync_dirs` が欠落し、**投稿が削除される危険**があります。

Zernio CLI wrapper for SNS scheduling and sync.

## Usage

```
/zernio post [OPTIONS]
/zernio sync [OPTIONS]
```

## Workflow

```
0. Resolve binary path (zernio CLI の場所を確定)
1. Resolve Profile ID
2. Execute command (post or sync)
3. Verify result
```

## Step 0: Resolve Binary Path

**CRITICAL**: `zernio` が PATH に無いまま subagent から呼ぶと、外部 API 待ちで stall する。必ず最初に解決する。

前提条件: zernio CLI は本 skill に同梱されない。別途 install して PATH（または `~/.cargo/bin`）に置いておく必要がある。

優先順:
1. `command -v zernio` (PATH)
2. `~/.cargo/bin/zernio` (cargo install)

いずれも無ければ「zernio CLI を別途 install してください」と伝えてエラー終了。

詳細・resolver スニペット: [Environment](references/environment.md)

## Step 1: Resolve Profile ID

**CRITICAL**: Always resolve `--profile-id` before running any `zernio` command.

Resolution order:
1. User explicitly passes `--profile-id` → use as-is
2. `skill-config` の `zernio.profile_id`（グローバル設定 → git root のプロジェクト設定を merge した結果。プロジェクトが勝つ）→ pass as `--profile-id`
3. `ZERNIO_PROFILE_ID` env var → used automatically by CLI
4. None found → **WARN the user** that commands will affect ALL profiles

`resolve-config.sh` は cwd がサブディレクトリでも git root の設定を読み、1 行 JSON
`{"profile_id": <string|null>, "sync_dirs": [<絶対パス>...]}` を出す（相対の `sync_dirs` は git root 基準で絶対パス化済み）。

```bash
ZCFG=$(bash ${CLAUDE_PLUGIN_ROOT}/zernio/scripts/resolve-config.sh)
PROFILE_ID=$(jq -r '.profile_id // empty' <<< "$ZCFG")
PROFILE_ARGS=()
[[ -n "$PROFILE_ID" ]] && PROFILE_ARGS=(--profile-id "$PROFILE_ID")
```

Then append `"${PROFILE_ARGS[@]}"` to every `zernio` command (skip when the user passed `--profile-id` explicitly).

## Step 2: Execute Command

### post — Create or schedule SNS posts

```bash
# Batch from JSON (most common — sns-announce output)
zernio post --json posts.json [--dry-run]

# Text post
zernio post --text "投稿内容" --platforms x,linkedin --schedule "2026-03-20 09:00"

# Media post
zernio post --media video.mp4 --caption "Caption" --platforms instagram --media-type reel
```

Full options: [CLI Reference](references/cli-reference.md)

### sync — Sync local JSON with Zernio API

**IMPORTANT**: Before running sync, build one `--dir` per `sync_dirs` entry from the Step 1 output (`$ZCFG`):

```bash
SYNC_ARGS=()
while IFS= read -r d; do
  [[ -n "$d" ]] && SYNC_ARGS+=(--dir "$d")
done <<< "$(jq -r '.sync_dirs[]' <<< "$ZCFG")"
```

If `sync_dirs` is configured, ALWAYS use ALL directories. Never pass fewer `--dir` values than `sync_dirs` specifies — missing directories cause their posts to be **DELETED** from the API.

```bash
# When sync_dirs is configured (e.g. ["./post/blog", "./post/bip"]):
zernio sync "${SYNC_ARGS[@]}" "${PROFILE_ARGS[@]}" --from 2026-04-01 --execute

# Single dir example (only when sync_dirs is not configured):
zernio sync --dir ./post/blog --from 2026-04-01 --execute
```

Full options: [CLI Reference](references/cli-reference.md)

## Execution

This skill calls `zernio` CLI directly. Do NOT use the old TypeScript scripts.

### Pipeline Example

```bash
# Generate posts → schedule
/sns-announce content/blog/2026-03-20-article.mdx --format json
zernio post --json post/2026-03-20-article.json

# Sync after date changes (uses sync_dirs from config)
zernio sync "${SYNC_ARGS[@]}" "${PROFILE_ARGS[@]}" --from 2026-03-20 --execute
```

## References

- [CLI Reference](references/cli-reference.md) - 全コマンド・オプション詳細
- [Platforms](references/platforms.md) - プラットフォームエイリアス一覧
- [Environment](references/environment.md) - 環境変数・Profile ID Resolution 詳細
