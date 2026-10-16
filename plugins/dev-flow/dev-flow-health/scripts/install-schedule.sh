#!/usr/bin/env bash
# install-schedule.sh - dev-flow ヘルスレポートの launchd ジョブ登録（macOS）
#
# skills checkout 内の daily.sh を `--repo <checkout>` 付きで実行する LaunchAgent を登録する。2 種類あり、
# 別の Label なので両方を登録できる（daily.sh の lock と窓の繋ぎで、重複も取りこぼしも出ない）:
#   - 日次ジョブ（既定）: 毎日 07:00（ローカル時刻）に起動する。即時トリガの取りこぼしを拾う網
#   - 即時トリガ（--watch-journal）: journal ディレクトリ（$CLAUDE_JOURNAL_DIR、未設定なら ~/.claude/journal）を
#     WatchPaths で監視し、entry が書かれるたびに起動する。daily.sh には監視するディレクトリを --journal-dir で渡す
#   - --repo は必須。plugin の install（~/.claude/plugins/cache/...）は git ではないので、既定の
#     「スクリプトを含む checkout」では候補 commit が常に repo_unavailable になる。
#   - daily.sh も --repo の checkout 内のものを指す（版付きの plugin cache パスに固定しない —
#     plugin update で旧版のパスが消えても止まらず、checkout の pull に追随する）。
# launchd の PATH は最小なので、登録時の PATH を EnvironmentVariables に焼き込む
# （jq / git / claude を daily.sh から解決するため）。
#
# Usage:
#   install-schedule.sh --print --repo DIR [--watch-journal]     # plist を stdout に出力（登録しない・CI/テスト用）
#   install-schedule.sh --install --repo DIR [--watch-journal]   # ~/Library/LaunchAgents へ書き込み + bootstrap
#   install-schedule.sh --uninstall [--watch-journal]            # bootout + plist 削除
#
#   --repo            skills repo の git checkout（plugins/dev-flow/dev-flow-health/scripts/daily.sh を含むこと）
#   --watch-journal   日次ジョブの代わりに即時トリガを対象にする
set -euo pipefail

DAILY_LABEL="com.playpark.dev-flow-health"
WATCH_LABEL="com.playpark.dev-flow-health.watch-journal"
LOG_DIR="${HOME}/.claude/logs"
DAILY_REL="plugins/dev-flow/dev-flow-health/scripts/daily.sh"
JOURNAL_DIR="${CLAUDE_JOURNAL_DIR:-$HOME/.claude/journal}"

usage() {
    echo "Usage: install-schedule.sh --print --repo DIR [--watch-journal] | --install --repo DIR [--watch-journal] | --uninstall [--watch-journal]" >&2
    exit 1
}

MODE=""
REPO_ARG=""
WATCH=false
while [[ $# -gt 0 ]]; do
    case "$1" in
        --print|--install|--uninstall)
            [[ -z "$MODE" ]] || usage
            MODE="$1"; shift ;;
        --repo)
            [[ $# -ge 2 && -n "$2" ]] || usage
            REPO_ARG="$2"; shift 2 ;;
        --watch-journal) WATCH=true; shift ;;
        *) usage ;;
    esac
done
[[ -n "$MODE" ]] || usage

if [[ "$WATCH" == true ]]; then
    LABEL="$WATCH_LABEL"
    LOG_NAME="dev-flow-health.watch-journal"
else
    LABEL="$DAILY_LABEL"
    LOG_NAME="dev-flow-health"
fi
PLIST_PATH="${HOME}/Library/LaunchAgents/${LABEL}.plist"

# --repo を git checkout の top-level に解決し、daily.sh を含むことを確かめる
resolve_repo() {
    if [[ -z "$REPO_ARG" ]]; then
        echo "error: --repo <skills checkout> が必要です（候補 commit の列挙に git checkout が要る）" >&2
        return 1
    fi
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

print_plist() {
    resolve_repo
    if ! command -v claude >/dev/null 2>&1; then
        echo "error: claude CLI が PATH に見つかりません（new / regressed がある実行で daily.sh が呼ぶ）" >&2
        return 1
    fi
    local extra_args="" trigger
    if [[ "$WATCH" == true ]]; then
        extra_args="
    <string>--journal-dir</string>
    <string>${JOURNAL_DIR}</string>"
        trigger="  <key>WatchPaths</key>
  <array>
    <string>${JOURNAL_DIR}</string>
  </array>"
    else
        trigger="  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>7</integer>
    <key>Minute</key><integer>0</integer>
  </dict>"
    fi
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
    <string>--repo</string>
    <string>${REPO}</string>${extra_args}
  </array>
  <key>WorkingDirectory</key><string>${REPO}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${PATH}</string>
  </dict>
${trigger}
  <key>StandardOutPath</key><string>${LOG_DIR}/${LOG_NAME}.log</string>
  <key>StandardErrorPath</key><string>${LOG_DIR}/${LOG_NAME}.err.log</string>
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
