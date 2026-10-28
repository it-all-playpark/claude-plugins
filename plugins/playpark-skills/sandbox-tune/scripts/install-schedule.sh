#!/usr/bin/env bash
# install-schedule.sh - sandbox-tune の日次集計の launchd ジョブ登録（macOS）
#
# skills checkout 内の daily.sh を `--config <設定>` 付きで毎日 06:30（ローカル時刻）に実行する LaunchAgent を登録する。
# 既定では何も登録しない（このスクリプトを手で 1 回実行した場合だけ動く）。
#   - daily.sh は --repo の checkout 内のものを指す（版付きの plugin cache パスに固定しない —
#     plugin update で旧版のパスが消えても止まらず、checkout の pull に追随する）。
#   - launchd は `~` を展開しないので、--config は登録時に絶対パスにして plist に書く。
# launchd の PATH は最小なので、登録時の PATH を EnvironmentVariables に焼き込む
# （jq / git / claude を daily.sh・sandbox-tune.sh から解決するため）。
#
# Usage:
#   install-schedule.sh --print --repo DIR --config FILE     # plist を stdout に出力（登録しない・CI/テスト用）
#   install-schedule.sh --install --repo DIR --config FILE   # ~/Library/LaunchAgents へ書き込み + bootstrap
#   install-schedule.sh --uninstall                          # bootout + plist 削除
#
#   --repo     skills repo の git checkout（plugins/playpark-skills/sandbox-tune/scripts/daily.sh を含むこと）
#   --config   sandbox-tune.json（configRepo を書いたもの）。`~` は $HOME、相対パスは cwd 基準
set -euo pipefail

LABEL="com.playpark.sandbox-tune"
LOG_DIR="${HOME}/.claude/logs"
DAILY_REL="plugins/playpark-skills/sandbox-tune/scripts/daily.sh"
PLIST_PATH="${HOME}/Library/LaunchAgents/${LABEL}.plist"

usage() {
    echo "Usage: install-schedule.sh --print --repo DIR --config FILE | --install --repo DIR --config FILE | --uninstall" >&2
    exit 1
}

MODE=""
REPO_ARG=""
CONFIG_ARG=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --print|--install|--uninstall)
            [[ -z "$MODE" ]] || usage
            MODE="$1"; shift ;;
        --repo)
            [[ $# -ge 2 && -n "$2" ]] || usage
            REPO_ARG="$2"; shift 2 ;;
        --config)
            [[ $# -ge 2 && -n "$2" ]] || usage
            CONFIG_ARG="$2"; shift 2 ;;
        *) usage ;;
    esac
done
[[ -n "$MODE" ]] || usage
if [[ "$MODE" != "--uninstall" ]]; then
    [[ -n "$REPO_ARG" && -n "$CONFIG_ARG" ]] || usage
fi

# --repo を git checkout の top-level に解決し、daily.sh を含むことを確かめる
resolve_repo() {
    local top
    if ! top="$(git -C "$REPO_ARG" rev-parse --show-toplevel 2>/dev/null)"; then
        echo "error: --repo が git checkout ではありません: $REPO_ARG" >&2
        return 1
    fi
    if [[ ! -f "$top/$DAILY_REL" ]]; then
        echo "error: --repo に $DAILY_REL がありません（skills repo の checkout を指定してください）: $top" >&2
        return 1
    fi
    REPO="$top"
}

# --config を絶対パスにする（launchd は ~ も cwd 相対も解決しない）
resolve_config() {
    local f="$CONFIG_ARG"
    case "$f" in
        "~") f="$HOME" ;;
        "~/"*) f="$HOME/${f#\~/}" ;;
    esac
    if [[ ! -f "$f" ]]; then
        echo "error: --config のファイルがありません: $CONFIG_ARG" >&2
        return 1
    fi
    CONFIG="$(cd "$(dirname "$f")" && pwd)/$(basename "$f")"
}

print_plist() {
    resolve_repo
    resolve_config
    cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${REPO}/${DAILY_REL}</string>
    <string>--config</string>
    <string>${CONFIG}</string>
  </array>
  <key>WorkingDirectory</key><string>${REPO}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${PATH}</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>6</integer>
    <key>Minute</key><integer>30</integer>
  </dict>
  <key>StandardOutPath</key><string>${LOG_DIR}/sandbox-tune.log</string>
  <key>StandardErrorPath</key><string>${LOG_DIR}/sandbox-tune.err.log</string>
</dict>
</plist>
PLIST
}

case "$MODE" in
    --print)
        print_plist
        ;;
    --install)
        mkdir -p "${HOME}/Library/LaunchAgents" "$LOG_DIR"
        PLIST_CONTENT="$(print_plist)"
        printf '%s\n' "$PLIST_CONTENT" > "$PLIST_PATH"
        launchctl bootout "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null || true
        launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
        echo "installed: $PLIST_PATH"
        ;;
    --uninstall)
        launchctl bootout "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null || true
        rm -f "$PLIST_PATH"
        echo "uninstalled: $PLIST_PATH"
        ;;
esac
