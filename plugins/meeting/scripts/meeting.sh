#!/usr/bin/env bash
# meeting — 会議の録音 → 文字起こし/話者分離 → 議事録 をまとめて回す CLI (macOS / Apple Silicon)
#
#   meeting setup                       plugin のソースからビルドし $MEETING_PREFIX にインストール
#   meeting install                     自動録音を常駐登録 (ログイン時に起動, launchd)
#   meeting uninstall                   常駐を解除
#   meeting status | log                常駐の状態 / ログ
#   meeting skip                        今の会議を録音しない (録音中なら破棄)
#   meeting watch                       自動録音をフォアグラウンドで実行 (動作確認用)
#   meeting rec [タイトル] [rec opts]   手動で録音開始。Ctrl-C で停止 → 自動で文字起こし
#   meeting transcribe [DIR] [opts]     文字起こし + 話者分離だけやり直す
#   meeting notes [DIR]                 Claude Code の /meeting-notes で議事録を作成
#   meeting ls                          録音一覧
#
# 環境変数:
#   MEETING_HOME          録音の保存先 (default: ~/Meetings)
#   MEETING_NOTES_DIR     議事録を置くリポジトリ / vault。notes と自動議事録はここで claude を起動する
#   MEETING_AUTO_NOTES=1  文字起こし後に議事録作成まで自動実行 (MEETING_NOTES_DIR が必要)
#   MEETING_APPS          検知対象の上書き "us.zoom.=Zoom,com.microsoft.teams=Teams"
#   MEETING_PREFIX        インストール先 (default: ${XDG_DATA_HOME:-~/.local/share}/meeting-rec)
#   MEETING_BIN_DIR       meeting コマンドの symlink 先 (default: ~/.local/bin)
set -euo pipefail

SELF="$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || echo "${BASH_SOURCE[0]}")"
SRC="$(cd "$(dirname "$SELF")/.." && pwd)"  # plugin から実行したときは plugin root
PREFIX="${MEETING_PREFIX:-${XDG_DATA_HOME:-$HOME/.local/share}/meeting-rec}"
BIN_DIR="${MEETING_BIN_DIR:-$HOME/.local/bin}"
MEETING_HOME="${MEETING_HOME:-$HOME/Meetings}"
REC_BIN="$PREFIX/bin/meeting-rec"
INSTALLED="$PREFIX/bin/meeting"
TRANSCRIBE="$PREFIX/transcribe/transcribe.py"
LABEL="jp.co.playpark.meeting-watch"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
WATCH_LOG="$MEETING_HOME/.watch.log"

die() { echo "meeting: $*" >&2; exit 1; }
notify() { osascript -e "display notification \"${1//\"/\\\"}\" with title \"meeting\"" >/dev/null 2>&1 || true; }
need_install() { [[ -x "$REC_BIN" && -f "$TRANSCRIBE" ]] || die "未インストールです。Claude Code から meeting setup を実行してください"; }

latest_dir() {
  local d
  d="$(ls -1d "$MEETING_HOME"/*/ 2>/dev/null | sort | tail -1)"
  [[ -n "$d" ]] || die "録音がありません ($MEETING_HOME)"
  echo "${d%/}"
}

# launchd / TCC (マイク・画面収録の許可) は実行ファイルのパスと署名に紐づく。plugin の install 先は
# 更新ごとに変わるので、ビルド成果物は固定の $PREFIX に置き、中身が変わったときだけ差し替える
cmd_setup() {
  [[ -f "$SRC/recorder/Package.swift" ]] || die "ソースがありません。plugin 側の meeting (Claude Code の Bash) から setup を実行してください"
  [[ "$(uname -s)" == Darwin ]] || die "macOS 専用です"
  command -v swift >/dev/null || die "swift がありません (xcode-select --install)"
  command -v ffmpeg >/dev/null || die "ffmpeg がありません"
  command -v uv >/dev/null || die "uv がありません"

  swift build -c release --package-path "$SRC/recorder" --scratch-path "$PREFIX/build"
  mkdir -p "$PREFIX/bin" "$PREFIX/transcribe" "$BIN_DIR"
  local built="$PREFIX/build/release/meeting-rec"
  if cmp -s "$built" "$REC_BIN"; then
    echo "= meeting-rec は変更なし (権限はそのまま)"
  else
    install -m 755 "$built" "$REC_BIN"
    echo "✓ meeting-rec を更新しました (常駐中なら権限の再許可が必要になることがあります)"
  fi
  install -m 644 "$SRC/transcribe/align.py" "$SRC/transcribe/transcribe.py" "$PREFIX/transcribe/"
  install -m 755 "$SELF" "$INSTALLED"
  ln -sf "$INSTALLED" "$BIN_DIR/meeting"
  echo "✓ インストール先: $PREFIX"
  echo "✓ $BIN_DIR/meeting (PATH に $BIN_DIR を入れてください)"

  # 依存とモデル (数 GB) をここで取得しておく。自動録音の後処理で初めて取得すると、ダウンロード失敗が
  # 「文字起こしに失敗」の通知になってその会議の文字起こしが残らない
  if uv run --script "$TRANSCRIBE" --prefetch; then
    echo "✓ 文字起こし・話者分離のモデルを取得しました"
  else
    echo "! モデルを取得できませんでした。話者分離は https://huggingface.co/pyannote/speaker-diarization-community-1 で"
    echo "  規約同意後に \`uvx --from huggingface_hub hf auth login\` が必要です。ダウンロード自体が失敗する場合は"
    echo "  HF_HUB_DISABLE_XET=1 を付けて meeting setup をやり直してください"
  fi
  if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
    launchctl kickstart -k "gui/$(id -u)/$LABEL"
    echo "✓ 常駐を再起動しました"
  fi
}

# launchd はログインシェルの PATH を持たないので、今の PATH (ffmpeg, uv, claude) を引き継ぐ
cmd_print_plist() {
  python3 - "$LABEL" "$REC_BIN" "$MEETING_HOME" "$INSTALLED" "$WATCH_LOG" <<'PY'
import os, plistlib, sys
label, rec, home, selfp, logp = sys.argv[1:]
env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "MEETING_HOME": home, "HOME": os.environ["HOME"], "LANG": "ja_JP.UTF-8"}
for k in ("MEETING_AUTO_NOTES", "MEETING_NOTES_DIR", "MEETING_APPS", "MEETING_PREFIX", "MEETING_ASR_MODEL", "MEETING_DIAR_MODEL"):
    if os.environ.get(k):
        env[k] = os.environ[k]
sys.stdout.buffer.write(plistlib.dumps({
    "Label": label,
    "ProgramArguments": [rec, "--watch", "--home", home, "--on-stop", selfp],
    "EnvironmentVariables": env,
    "RunAtLoad": True,
    "KeepAlive": True,
    "ProcessType": "Interactive",
    "StandardOutPath": logp,
    "StandardErrorPath": logp,
}))
PY
}

cmd_install() {
  need_install
  mkdir -p "$MEETING_HOME" "$(dirname "$PLIST")"
  cmd_print_plist > "$PLIST"
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  echo "✓ 常駐登録しました: $PLIST"
  echo "  会議アプリがマイクを使い始めると自動で録音します。ログ: meeting log"
  echo "  これから出るダイアログで「画面収録とシステムオーディオ録音」「マイク」を meeting-rec に許可してください"
  echo "  (ダイアログが出ない場合: システム設定 > プライバシーとセキュリティ で $REC_BIN を追加)"
}

cmd_uninstall() {
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "✓ 常駐を解除しました"
}

cmd_status() {
  launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -E '^\s*(state|pid) =' || echo "常駐していません (meeting install)"
  if [[ -f "$WATCH_LOG" ]]; then echo "--- 最近のログ"; tail -5 "$WATCH_LOG"; fi
}

cmd_skip() {
  launchctl kill SIGUSR1 "gui/$(id -u)/$LABEL" && echo "✓ 今の会議はスキップします (録音中なら破棄)"
}

cmd_watch() {
  need_install
  exec "$REC_BIN" --watch --home "$MEETING_HOME" --on-stop "$INSTALLED" "$@"
}

write_meta() {
  python3 - "$@" <<'PY'
import datetime, json, os, sys
path, key = sys.argv[1], sys.argv[2]
meta = json.load(open(path)) if os.path.exists(path) else {}
if key == "start":
    meta.update(title=sys.argv[3], started_at=datetime.datetime.now().astimezone().isoformat(timespec="seconds"))
else:
    meta["ended_at"] = datetime.datetime.now().astimezone().isoformat(timespec="seconds")
json.dump(meta, open(path, "w"), ensure_ascii=False, indent=2)
PY
}

cmd_rec() {
  need_install
  local title="meeting"
  if [[ $# -gt 0 && "$1" != --* ]]; then title="$1"; shift; fi
  local dir
  dir="$MEETING_HOME/$(date +%Y-%m-%d_%H%M)-${title//\//_}"
  mkdir -p "$dir"
  write_meta "$dir/meta.json" start "$title"
  # Ctrl-C は meeting-rec が受けて綺麗に止まる。シェル側は殺されずに後続処理へ進む
  trap ':' INT
  "$REC_BIN" --out "$dir" "$@" || true
  trap - INT
  write_meta "$dir/meta.json" end
  cmd_transcribe "$dir"
  if [[ "${MEETING_AUTO_NOTES:-0}" == 1 ]]; then cmd_notes "$dir"; else
    echo "議事録を作るには: meeting notes \"$dir\""
  fi
}

# 自動録音の終了後に meeting-rec から呼ばれる (非対話)
cmd_post() {
  local dir="${1:?dir}"
  echo "== post $(date '+%F %T') $dir"
  if ! cmd_transcribe "$dir"; then
    notify "文字起こしに失敗しました: $(basename "$dir") (postprocess.log を確認)"
    exit 1
  fi
  if [[ "${MEETING_AUTO_NOTES:-0}" == 1 && -n "${MEETING_NOTES_DIR:-}" ]] && command -v claude >/dev/null; then
    # 文字起こしは第三者の発言をそのまま含むのに、-p では許可の確認ができない。ここで足すのは skill の
    # .gitignore 確認に要る git の許可と Web アクセスの禁止だけで、それ以外は絞れていない:
    # acceptEdits なので MEETING_NOTES_DIR 配下と録音 DIR のファイルはどれでも編集でき、ユーザー設定の
    # permissions.allow もそのまま効く。書き込みを議事録と全文の 2 ファイルに限っているのは SKILL.md の規則だけ
    # (output_dir は skill-config で決まるため、ここでパス単位の許可にすると探索を二重に持つことになる)。
    # プロンプトは可変長の --allowedTools に飲まれないよう -p の直後に置く
    (cd "$MEETING_NOTES_DIR" && claude -p "/meeting-notes $dir --non-interactive" \
      --permission-mode acceptEdits --add-dir "$dir" \
      --allowedTools "Bash(git check-ignore:*),Bash(git rev-parse:*)" \
      --disallowedTools "WebFetch,WebSearch") || { notify "議事録の作成に失敗しました: $(basename "$dir")"; exit 1; }
    notify "議事録を作成しました: $(basename "$dir")"
  else
    notify "文字起こし完了: $(basename "$dir") — meeting notes で議事録化"
  fi
}

cmd_transcribe() {
  need_install
  local dir
  if [[ $# -gt 0 && "$1" != --* ]]; then dir="$1"; shift; else dir="$(latest_dir)"; fi
  uv run --script "$TRANSCRIBE" "$dir" "$@"
}

cmd_notes() {
  local dir="${1:-$(latest_dir)}"
  [[ -f "$dir/transcript.json" ]] || die "$dir/transcript.json がありません。先に meeting transcribe"
  command -v claude >/dev/null || die "claude (Claude Code) がありません"
  cd "${MEETING_NOTES_DIR:-$PWD}" && claude --add-dir "$dir" "/meeting-notes $dir"
}

cmd_ls() {
  local d mark
  for d in "$MEETING_HOME"/*/; do
    [[ -d "$d" ]] || continue
    mark="  "
    [[ -f "$d/transcript.json" ]] && mark="✓ "
    echo "$mark$(basename "$d")"
  done
}

usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$SELF"; }

sub="${1:-}"; shift || true
case "$sub" in
  setup) cmd_setup "$@" ;;
  install) cmd_install ;;
  uninstall) cmd_uninstall ;;
  status) cmd_status ;;
  log) tail -f "$WATCH_LOG" ;;
  skip) cmd_skip ;;
  watch) cmd_watch "$@" ;;
  rec|record) cmd_rec "$@" ;;
  post) cmd_post "$@" ;;
  print-plist) cmd_print_plist ;;
  transcribe|tr) cmd_transcribe "$@" ;;
  notes) cmd_notes "$@" ;;
  ls) cmd_ls ;;
  -h|--help|help) usage ;;
  *) usage; exit 2 ;;
esac
