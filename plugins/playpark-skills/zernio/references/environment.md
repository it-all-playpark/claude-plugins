# Environment & Profile ID Resolution

## Environment Variables

- `ZERNIO_API_KEY` — API key (global)
- `ZERNIO_PROFILE_ID` — Profile ID (optional, for project isolation)

## Prerequisites

zernio CLI は本 skill に同梱されない。利用者が別途 install し、PATH 上（または `~/.cargo/bin`）に置いておく必要がある。
skill 側は install を行わず、見つからなければエラー終了する。

## Binary Resolution

**CRITICAL**: `zernio` バイナリが PATH に無いと、subagent が外部API待ちで stall する。必ず最初に解決する。

Resolution order (最初に見つかった実行可能ファイルを使う):

1. `command -v zernio` → PATH 上に存在すればそれを使う
2. `~/.cargo/bin/zernio` → `cargo install` 経由のグローバルインストール
3. いずれも無ければ **エラー終了**: 「zernio CLI が見つかりません。別途 install してください」

### Resolver スニペット

```bash
resolve_zernio() {
  local candidates=(
    "$(command -v zernio 2>/dev/null)"
    "$HOME/.cargo/bin/zernio"
  )
  for c in "${candidates[@]}"; do
    [[ -n "$c" && -x "$c" ]] && { echo "$c"; return 0; }
  done
  echo "Error: zernio binary not found. zernio CLI must be installed separately (put it on PATH or ~/.cargo/bin)." >&2
  return 1
}

ZERNIO_BIN=$(resolve_zernio) || exit 1
"$ZERNIO_BIN" --version
```

### 疎通確認

```bash
$ZERNIO_BIN --version
# zernio 0.1.0
```

## Profile ID Resolution

**CRITICAL**: Always resolve `--profile-id` before running any `zernio` command.

Resolution order:
1. User explicitly passes `--profile-id` → use as-is
2. `skill-config` の `zernio.profile_id`（グローバル設定 → プロジェクト設定を merge した結果。プロジェクトが勝つ）→ pass as `--profile-id`
3. `ZERNIO_PROFILE_ID` env var → used automatically by CLI
4. None found → **WARN the user** that commands will affect ALL profiles

`skill-config` は共有ローダー `load_skill_config` で読む（他 skill と同じ解決）:
- グローバル: `$SKILL_CONFIG_PATH` > `~/.config/skills/config.json` > `~/.claude/skill-config.json`
- プロジェクト: cwd の git root の `skill-config.json` > `.claude/skill-config.json`（サブディレクトリから呼んでも git root を読む）

`zernio/scripts/resolve-config.sh`（SKILL.md Step 1 で plugin root 起点に実行する）が 1 行 JSON
`{"profile_id": <string|null>, "sync_dirs": [<絶対パス>...]}` を出す。相対の `sync_dirs` は git root 基準の絶対パスに解決済み。
その出力 `$ZCFG` から引数を組み立てる:

```bash
PROFILE_ID=$(jq -r '.profile_id // empty' <<< "$ZCFG")
PROFILE_ARGS=()
[[ -n "$PROFILE_ID" ]] && PROFILE_ARGS=(--profile-id "$PROFILE_ID")

# sync: sync_dirs の全件を --dir で渡す（欠けたディレクトリの投稿は API から削除される）
SYNC_ARGS=()
while IFS= read -r d; do
  [[ -n "$d" ]] && SYNC_ARGS+=(--dir "$d")
done <<< "$(jq -r '.sync_dirs[]' <<< "$ZCFG")"
```

Then append `"${PROFILE_ARGS[@]}"` to every `zernio` command (skip when the user passed `--profile-id` explicitly).
