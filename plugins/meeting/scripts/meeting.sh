#!/usr/bin/env bash
# meeting — 会議の録音 → 文字起こし/話者分離 → 議事録 をまとめて回す CLI (macOS / Apple Silicon)
#
#   meeting setup [opts]                依存の確認 → ビルドして $MEETING_PREFIX にインストール → モデルの取得 →
#                                       設定ファイルの作成 → 常駐の登録。何度実行してもよい (済んだ手順は飛ばす)
#       --home DIR                      録音の保存先
#       --notes-dir DIR                 議事録を置くリポジトリ / vault
#       --auto-notes | --no-auto-notes  文字起こし後に議事録作成まで自動で行うか
#       --calendar-tools A,B            自動議事録の claude -p に許可するカレンダー連携のツール名
#       --asr-backend mlx|groq          Whisper をどこで動かすか (groq は Keychain の meeting-groq を使う)
#       --no-daemon                     常駐を登録しない (登録済みなら再起動だけする)
#   meeting doctor                      依存・インストールの版・HF ログイン・設定・常駐・Keychain を 1 行ずつ確かめる
#   meeting install                     設定ファイルを変えずに常駐だけを登録し直す (ログイン時に起動, launchd)
#   meeting uninstall                   常駐を解除
#   meeting status | log                常駐の状態 / ログ
#   meeting skip                        今の会議を録音しない (録音中なら破棄)
#   meeting watch                       自動録音をフォアグラウンドで実行 (動作確認用)
#   meeting rec [タイトル] [rec opts]   手動で録音開始。Ctrl-C で停止 → 自動で文字起こし
#   meeting transcribe [DIR] [opts]     文字起こし + 話者分離だけやり直す
#   meeting notes [DIR]                 Claude Code の /meeting-notes で議事録を作成
#   meeting play <DIR> <話者ラベル>     その話者の声を約 5 秒再生する (自分 は mic.wav から)
#   meeting name [DIR]                  議事録の未確定の話者 (unresolved_speakers) に名前を入れる
#                                       DIR 省略時は未確定の話者が残る最新の録音
#   meeting set-names <DIR> <話者A=名前,...>
#                                       議事録と全文の話者ラベルを置き換える (claude は起動しない。sandbox の外で動かす入口)
#   meeting ls                         録音一覧
#
# 設定ファイル ${XDG_CONFIG_HOME:-~/.config}/meeting/config.json (meeting setup が書く。手で編集してもよい)。
# meeting / transcribe.py / meeting-rec (常駐) が起動のたびに読むので、変えても meeting install は要らない:
#   home            録音の保存先 (default: ~/Meetings)。home / notes_dir は絶対パスか ~ で始まるパスで書く
#   notes_dir       議事録を置くリポジトリ / vault。notes / name と自動議事録はここで claude を起動する (無ければ cwd)
#   auto_notes      true なら文字起こし後に議事録作成まで自動実行 (notes_dir が必要)
#   calendar_tools  自動議事録の claude -p に許可するカレンダー連携のツール名の配列 (既定なし)
#   apps            検知対象の上書き ["us.zoom.=Zoom", "com.microsoft.teams=Teams"]
#   asr_backend     mlx (default) | groq。asr_model / diar_model で Whisper / 話者分離のモデルを変えられる
#
# 環境変数 (ユーザー設定ではないもの):
#   MEETING_CONFIG        設定ファイルの場所 (常駐の plist が渡す)
#   MEETING_PREFIX        インストール先 (default: ${XDG_DATA_HOME:-~/.local/share}/meeting-rec)
#   MEETING_BIN_DIR       meeting コマンドの symlink 先 (default: ~/.local/bin)
#   MEETING_INSTALL_WAIT  install で旧常駐の登録が外れるのを待つ上限秒 (default: 30)
set -euo pipefail

SELF="$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || echo "${BASH_SOURCE[0]}")"
SRC="$(cd "$(dirname "$SELF")/.." && pwd)"  # plugin から実行したときは plugin root
PREFIX="${MEETING_PREFIX:-${XDG_DATA_HOME:-$HOME/.local/share}/meeting-rec}"
BIN_DIR="${MEETING_BIN_DIR:-$HOME/.local/bin}"
CONFIG="${MEETING_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/meeting/config.json}"
REC_BIN="$PREFIX/bin/meeting-rec"
INSTALLED="$PREFIX/bin/meeting"
TRANSCRIBE="$PREFIX/transcribe/transcribe.py"
LABEL="jp.co.playpark.meeting-watch"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
# 録音の保存先 (home) は設定で変わるので、plist に書くログの場所はそれに依存させない
WATCH_LOG="$HOME/Library/Logs/meeting/watch.log"
GROQ_SERVICE="meeting-groq"
GROQ_ADD_CMD="security add-generic-password -a \"\$USER\" -s $GROQ_SERVICE -w"
HF_TERMS_URL="https://huggingface.co/pyannote/speaker-diarization-community-1"
HF_LOGIN_CMD="uvx --from huggingface_hub hf auth login"

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
  if [[ ! -f "$SRC/recorder/Package.swift" ]]; then
    # インストール済みのコピー (~/.local/bin/meeting) にはソースが無い。Claude Code が今インストールしている
    # plugin に引き継ぎ、ターミナルからでも最新の plugin でインストールし直せるようにする
    local json="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/installed_plugins.json" plugin
    plugin="$(installed_plugin "$json")" \
      || die "インストール済みの meeting plugin が見つかりません ($json)。Claude Code から meeting setup を実行してください"
    echo "→ インストール済みの plugin から setup します: $plugin"
    exec bash "$plugin/scripts/meeting.sh" setup "$@"
  fi
  # 設定は「config_tool set に渡す キー 値 の並び」に集める。値の誤りはビルド (数分) の前に止める
  local daemon=1 sets=() key
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --home|--notes-dir|--calendar-tools|--asr-backend)
        [[ $# -ge 2 ]] || die "$1 には値を指定してください"
        key="${1#--}"
        sets+=("${key//-/_}" "$2"); shift 2 ;;
      --auto-notes) sets+=(auto_notes 1); shift ;;
      --no-auto-notes) sets+=(auto_notes 0); shift ;;
      --no-daemon) daemon=0; shift ;;
      *) die "不明なオプション: $1" ;;
    esac
  done
  local msg
  msg="$(config_tool set --check ${sets[@]+"${sets[@]}"})" || die "$msg"

  [[ "$(uname -s)" == Darwin ]] || die "macOS 専用です"
  command -v swift >/dev/null || die "swift がありません (xcode-select --install)"
  command -v ffmpeg >/dev/null || die "ffmpeg がありません"
  command -v uv >/dev/null || die "uv がありません"

  # swift build の成果物にはビルド元ソースの絶対パスが埋め込まれる。plugin root からそのままビルドすると
  # install 先が変わるたびにソースが同じでもバイナリ (= ad-hoc 署名の cdhash) が変わり、cmp をすり抜けて
  # 入れ替わって TCC の許可が外れるので、固定の $PREFIX/src/recorder に同期してからビルドする。
  # --delete は plugin 側で消したファイルを残さないため
  mkdir -p "$PREFIX/src"
  rsync -a --delete --exclude .build "$SRC/recorder/" "$PREFIX/src/recorder/"
  swift build -c release --package-path "$PREFIX/src/recorder" --scratch-path "$PREFIX/build"
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
  # 「文字起こしに失敗」の通知になってその会議の文字起こしが残らない。取得済みならダウンロードはしない
  local prefetch=(--prefetch)
  if ! hf_logged_in; then
    echo "! Hugging Face にログインしていないため、話者分離のモデルは取得しません。$HF_TERMS_URL で"
    echo "  利用規約に同意し、\`$HF_LOGIN_CMD\` を実行してから meeting setup をやり直してください"
    prefetch+=(--no-diarize)
  fi
  if uv run --script "$TRANSCRIBE" "${prefetch[@]}"; then
    echo "✓ モデルを取得しました"
  else
    echo "! モデルを取得できませんでした。話者分離は $HF_TERMS_URL で規約同意後に"
    echo "  \`$HF_LOGIN_CMD\` が必要です。ダウンロード自体が失敗する場合は"
    echo "  HF_HUB_DISABLE_XET=1 を付けて meeting setup をやり直してください"
  fi

  # 質問は最初の 1 回 (設定ファイルが無いとき) だけ、答えられる端末があるときだけ出す。
  # 端末が無い (Claude Code の Bash など) ときは引数と既存の設定ファイルだけで進める
  if [[ -t 0 && ! -f "$CONFIG" ]]; then
    local ans
    if ! has_key notes_dir "${sets[@]+"${sets[@]}"}"; then
      read -r -p "議事録を置くディレクトリ (絶対パスか ~/...。空なら meeting notes を実行した場所): " ans
      [[ -z "$ans" ]] || sets+=(notes_dir "$ans")
    fi
    if ! has_key auto_notes "${sets[@]+"${sets[@]}"}" && has_key notes_dir "${sets[@]+"${sets[@]}"}"; then
      read -r -p "文字起こしのあと議事録まで自動で作りますか [y/N]: " ans
      if [[ "$ans" == [yY]* ]]; then sets+=(auto_notes 1); fi
    fi
    if ! has_key asr_backend "${sets[@]+"${sets[@]}"}"; then
      read -r -p "Whisper を Groq で処理しますか (音声が Groq に送られます) [y/N]: " ans
      if [[ "$ans" == [yY]* ]]; then sets+=(asr_backend groq); fi
    fi
  fi
  msg="$(config_tool set ${sets[@]+"${sets[@]}"})" || die "$msg"
  load_config || die "$CONFIG_ERR"
  echo "✓ 設定: $CONFIG"

  if [[ "$ASR_BACKEND" == groq ]] && ! security find-generic-password -s "$GROQ_SERVICE" >/dev/null 2>&1; then
    if [[ -t 0 ]]; then
      echo "Groq の API キーをログイン Keychain に登録します (入力は表示されません)"
      security add-generic-password -a "${USER:-$(id -un)}" -s "$GROQ_SERVICE" -w \
        || die "Keychain に登録できませんでした。$GROQ_ADD_CMD を実行してから meeting setup をやり直してください"
      echo "✓ Keychain に $GROQ_SERVICE を登録しました"
    else
      echo "! Groq の API キーが Keychain にありません。ターミナルで次を実行してから meeting setup をやり直してください:" >&2
      echo "  $GROQ_ADD_CMD" >&2
      restart_daemon
      exit 1
    fi
  fi

  if [[ "$daemon" == 1 ]]; then
    cmd_install
  else
    restart_daemon
    echo "= 常駐は登録しません (--no-daemon)"
  fi
  echo "状態の確認: meeting doctor"
}

# 常駐が登録済みなら再起動する。常駐を登録し直さずに setup を終える経路で、差し替える前の meeting-rec が
# 動き続けないようにする
restart_daemon() {
  if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
    launchctl kickstart -k "gui/$(id -u)/$LABEL"
    echo "✓ 常駐を再起動しました"
  fi
}

# キー 値 の並び ($2...) にキー $1 があるか
has_key() {
  local want="$1"; shift
  while [[ $# -ge 2 ]]; do
    [[ "$1" == "$want" ]] && return 0
    shift 2
  done
  return 1
}

hf_logged_in() {
  [[ -n "${HF_TOKEN:-}" || -s "${HF_TOKEN_PATH:-${HF_HOME:-$HOME/.cache/huggingface}/token}" ]]
}

# 設定ファイル ($CONFIG) を読み書きする。誤りは stdout にメッセージを出して非 0
#   get                 home, asr_backend, auto_notes (1/0), notes_dir, calendar_tools (, 区切り) を 1 行ずつ出す
#   set [--check] [キー 値]...
#                       値を足して書き戻す (無ければ作る)。--check は確かめるだけで書かない
#   show                中身を 1 キー 1 行で出す (meeting doctor)
config_tool() {
  python3 -I - "$CONFIG" "$@" <<'PY'
import json, os, re, sys

KEYS = {"home": str, "notes_dir": str, "auto_notes": bool, "calendar_tools": list, "apps": list,
        "asr_backend": str, "asr_model": str, "diar_model": str}
BACKENDS = ("mlx", "groq")
PATHS = ("home", "notes_dir")

def fail(msg):
    print(msg)
    sys.exit(1)

def check(path, cfg):
    if not isinstance(cfg, dict):
        fail(f"{path} が JSON オブジェクトではありません")
    for k, v in cfg.items():
        if k not in KEYS:
            fail(f"{path}: 不明なキー {k} (使えるキー: {', '.join(KEYS)})")
        t = KEYS[k]
        if t is str:
            ok = isinstance(v, str) and v != "" and "\n" not in v
        elif t is list:
            ok = isinstance(v, list) and all(isinstance(x, str) and x and "," not in x and "\n" not in x for x in v)
        else:
            ok = isinstance(v, bool)
        if not ok:
            want = {str: "空でない文字列", list: "文字列の配列", bool: "true / false"}[t]
            fail(f"{path}: {k} は{want}で指定してください")
    # 相対パスは読んだ場所の cwd 基準になり、meeting と常駐 (meeting-rec の Config.swift) で別の場所を指すので受け付けない
    for k in PATHS:
        if k in cfg and not re.match(r"/|~(/|$)", cfg[k]):
            fail(f"{path}: {k} は絶対パスか ~ で始まるパスで指定してください: {cfg[k]}")
    if cfg.get("asr_backend", "mlx") not in BACKENDS:
        fail(f"{path}: asr_backend は {' / '.join(BACKENDS)} のどれかです: {cfg['asr_backend']}")
    # calendar_tools は相手の発言を含む文字起こしを読む claude -p の --allowedTools に入る。Bash や Write を
    # 通すと発言に仕込んだ指示でコマンドを実行できる状態が設定ファイルに残るので、MCP ツール名だけを受け付ける
    for t in cfg.get("calendar_tools", []):
        if not re.fullmatch(r"mcp__[A-Za-z0-9_-]+", t):
            fail(f"{path}: calendar_tools には MCP ツール名 (mcp__<server>__<tool>) だけを指定できます: {t}")

def load(path):
    if not os.path.exists(path):
        return {}
    try:
        cfg = json.load(open(path, encoding="utf-8"))
    except (OSError, ValueError) as e:
        fail(f"{path} を読めません: {e}")
    check(path, cfg)
    return cfg

def expand(p):
    return os.path.abspath(os.path.expanduser(p))

path, cmd, args = sys.argv[1], sys.argv[2], sys.argv[3:]
cfg = load(path)
if cmd == "get":
    print(expand(cfg.get("home", "~/Meetings")))
    print(cfg.get("asr_backend", "mlx"))
    print(1 if cfg.get("auto_notes") else 0)
    print(expand(cfg["notes_dir"]) if "notes_dir" in cfg else "")
    print(",".join(cfg.get("calendar_tools", [])))
elif cmd == "show":
    for k, v in cfg.items():
        print(f"{k} = {json.dumps(v, ensure_ascii=False)}")
elif cmd == "set":
    dry = args[:1] == ["--check"]
    args = args[1:] if dry else args
    for k, v in zip(args[::2], args[1::2]):
        if k == "auto_notes":
            cfg[k] = v == "1"
        elif k == "calendar_tools":
            cfg[k] = [t.strip() for t in v.split(",") if t.strip()]
        else:
            cfg[k] = v
    # 空文字列は expand すると cwd になって check をすり抜けるので、変換する前の値で確かめる
    check("meeting setup の引数" if dry else path, cfg)
    # 引数で渡したパスは、どこから読んでも同じ場所になるよう絶対パスにして書く
    for k in set(args[::2]) & set(PATHS):
        cfg[k] = expand(cfg[k])
    if not dry:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)
            f.write("\n")
        os.replace(tmp, path)
PY
}

# 設定ファイルの値を MEETING_HOME / ASR_BACKEND / AUTO_NOTES / NOTES_DIR / CALENDAR_TOOLS に読む。
# 読めなければ CONFIG_ERR に理由を入れて非 0 (値は既定のまま)
CONFIG_ERR=""
MEETING_HOME="$HOME/Meetings" ASR_BACKEND=mlx AUTO_NOTES=0 NOTES_DIR="" CALENDAR_TOOLS=""
load_config() {
  local out
  if ! out="$(config_tool get)"; then
    CONFIG_ERR="${out:-python3 で設定ファイル $CONFIG を読めません}"
    return 1
  fi
  CONFIG_ERR=""
  # macOS 標準の bash 3.2 には mapfile が無い。末尾の空の値は $(...) で落ちるので read の失敗は無視する
  { IFS= read -r MEETING_HOME; IFS= read -r ASR_BACKEND; IFS= read -r AUTO_NOTES
    IFS= read -r NOTES_DIR || NOTES_DIR=""; IFS= read -r CALENDAR_TOOLS || CALENDAR_TOOLS=""; } <<< "$out"
}

# installed_plugins.json ({"plugins": {"meeting@<marketplace>": [{"scope", "installPath", "lastUpdated", ...}]}}) から
# ソース (recorder/Package.swift と scripts/meeting.sh) のある meeting plugin の installPath を出す。無ければ失敗
installed_plugin() {
  python3 -I - "$1" <<'PY'
import json, os, sys
try:
    plugins = json.load(open(sys.argv[1], encoding="utf-8"))["plugins"].items()
except (OSError, ValueError, KeyError, AttributeError):
    sys.exit(1)
# scope 違い (user / project / local) で複数あるときは user を選ぶ。setup のインストール先はどのプロジェクトからでも
# 使う固定の場所なので、特定のプロジェクトにだけ入れた版より全体に入れた版を優先する。同じ scope なら最後に更新したもの
cands = []
for key, entries in plugins:
    if not key.startswith("meeting@"):
        continue
    for e in entries:
        p = e.get("installPath")
        if p and os.path.isfile(os.path.join(p, "recorder", "Package.swift")) and os.path.isfile(os.path.join(p, "scripts", "meeting.sh")):
            cands.append((e.get("scope") == "user", e.get("lastUpdated") or "", p))
if not cands:
    sys.exit(1)
print(max(cands)[2])
PY
}

# 常駐の plist。ユーザー設定は焼き込まず、設定ファイルの場所だけを渡す (常駐側が起動のたびにそのファイルを読む)。
# launchd はログインシェルの PATH を持たないので、今の PATH (ffmpeg, uv, claude) を引き継ぐ。
#   print          plist を出す
#   check <plist>  <plist> が今の print と PATH 以外で同じなら 0 (PATH は実行したシェルで変わるので比べない)
plist_tool() {
  python3 -I - "$LABEL" "$REC_BIN" "$INSTALLED" "$WATCH_LOG" "$CONFIG" "$@" <<'PY'
import os, plistlib, sys
label, rec, selfp, logp, config, cmd = sys.argv[1:7]
env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": os.environ["HOME"], "LANG": "ja_JP.UTF-8",
       "MEETING_CONFIG": config}
# インストール先はユーザー設定ではないが、既定以外に入れたときは常駐の post (= $PREFIX/bin/meeting) が
# 同じ場所の meeting-rec / transcribe.py を見るよう引き継ぐ
if os.environ.get("MEETING_PREFIX"):
    env["MEETING_PREFIX"] = os.environ["MEETING_PREFIX"]
plist = {
    "Label": label,
    "ProgramArguments": [rec, "--watch", "--on-stop", selfp],
    "EnvironmentVariables": env,
    "RunAtLoad": True,
    "KeepAlive": True,
    "ProcessType": "Interactive",
    "StandardOutPath": logp,
    "StandardErrorPath": logp,
}
if cmd == "print":
    sys.stdout.buffer.write(plistlib.dumps(plist))
else:
    try:
        cur = plistlib.load(open(sys.argv[7], "rb"))
    except (OSError, plistlib.InvalidFileException, ValueError):
        sys.exit(1)
    for p in (plist, cur):
        if isinstance(p, dict) and isinstance(p.get("EnvironmentVariables"), dict):
            p["EnvironmentVariables"].pop("PATH", None)
    sys.exit(0 if cur == plist else 1)
PY
}

cmd_print_plist() { plist_tool print; }

cmd_install() {
  need_install
  mkdir -p "$MEETING_HOME" "$(dirname "$PLIST")" "$(dirname "$WATCH_LOG")"
  plist_tool print > "$PLIST"
  local domain="gui/$(id -u)"
  if launchctl bootout "$domain/$LABEL" 2>/dev/null; then
    # bootout は旧 meeting-rec の終了を待たずに戻る。登録が残ったまま bootstrap すると error 5 で失敗し、
    # そのあと登録が外れて常駐が無いまま終わるので、外れるまで待つ (録音中は保存処理の分だけ長くかかる)
    local wait_s="${MEETING_INSTALL_WAIT:-30}" i=0
    while launchctl print "$domain/$LABEL" >/dev/null 2>&1; do
      (( i < wait_s * 10 )) || die "常駐が ${wait_s} 秒たっても止まりません (録音の保存中など)。常駐は止まっておらず、新しい設定はまだ反映していません。少し待って meeting install を再実行してください"
      sleep 0.1
      i=$((i + 1))
    done
  fi
  launchctl bootstrap "$domain" "$PLIST" \
    || die "常駐の登録に失敗しました。常駐は止まっています (自動録音しません)。meeting install を再実行してください"
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

# meeting doctor: 1 項目 1 行で ✅ / ❌ と直し方を出す。❌ が 1 つでもあれば非 0
DOCTOR_BAD=0
doctor_ok() { echo "✅ $1"; }
doctor_ng() { echo "❌ $1 → $2"; DOCTOR_BAD=1; }

cmd_doctor() {
  local dep hint
  for dep in swift ffmpeg uv; do
    case "$dep" in
      swift) hint="xcode-select --install" ;;
      *) hint="brew install $dep" ;;
    esac
    if command -v "$dep" >/dev/null; then doctor_ok "$dep"; else doctor_ng "$dep がありません" "$hint"; fi
  done

  local json="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/installed_plugins.json" plugin=""
  if [[ -f "$SRC/recorder/Package.swift" ]]; then plugin="$SRC"; else plugin="$(installed_plugin "$json")" || plugin=""; fi
  if [[ ! -x "$REC_BIN" || ! -f "$TRANSCRIBE" || ! -f "$INSTALLED" ]]; then
    doctor_ng "インストールされていません ($PREFIX)" "meeting setup"
  elif [[ -z "$plugin" ]]; then
    doctor_ng "比べる meeting plugin が見つかりません ($json)" "Claude Code から meeting setup"
  elif installed_matches "$plugin"; then
    doctor_ok "インストール済みの版は plugin と同じです ($plugin)"
  else
    doctor_ng "インストール済みの版が plugin と違います ($plugin)" "meeting setup"
  fi

  if hf_logged_in; then doctor_ok "Hugging Face にログイン済み"; else
    doctor_ng "Hugging Face にログインしていません (話者分離のモデルの取得に要る)" "$HF_TERMS_URL で規約に同意し $HF_LOGIN_CMD"
  fi

  if [[ -n "$CONFIG_ERR" ]]; then
    doctor_ng "設定ファイルを読めません: $CONFIG_ERR" "直すか消してから meeting setup"
  elif [[ ! -f "$CONFIG" ]]; then
    doctor_ng "設定ファイルがありません ($CONFIG)" "meeting setup"
  else
    doctor_ok "設定ファイル $CONFIG"
    config_tool show | sed 's/^/     /'
    if [[ -n "$NOTES_DIR" && ! -d "$NOTES_DIR" ]]; then
      doctor_ng "notes_dir のディレクトリがありません ($NOTES_DIR)" "作るか meeting setup --notes-dir DIR"
    fi
    if [[ "$AUTO_NOTES" == 1 && -z "$NOTES_DIR" ]]; then
      doctor_ng "auto_notes が true なのに notes_dir がありません (議事録は自動で作られません)" "meeting setup --notes-dir DIR"
    fi
  fi

  local st pid
  if ! st="$(launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null)"; then
    doctor_ng "常駐していません" "meeting setup (常駐だけなら meeting install)"
  elif ! grep -qE '^\s*state = running' <<< "$st"; then
    doctor_ng "常駐が動いていません ($(grep -E '^\s*state =' <<< "$st" | head -1 | sed 's/^[[:space:]]*//'))" "meeting log を確認して meeting install"
  elif ! plist_tool check "$PLIST"; then
    doctor_ng "常駐の登録が今の meeting と違います (設定を焼き込んだ古い登録など)" "meeting install"
  else
    pid="$(grep -E '^\s*pid =' <<< "$st" | head -1 | sed 's/.*= *//')"
    doctor_ok "常駐: running${pid:+ (pid $pid)}"
  fi

  if [[ "$ASR_BACKEND" == groq ]]; then
    if ! security find-generic-password -s "$GROQ_SERVICE" >/dev/null 2>&1; then
      doctor_ng "Keychain に $GROQ_SERVICE がありません (asr_backend = groq)" "$GROQ_ADD_CMD"
    else
      doctor_ok "Keychain に $GROQ_SERVICE があります"
      local rc=0
      keychain_from_launchd || rc=$?
      case "$rc" in
        0) doctor_ok "常駐 (launchd) のプロセスから Keychain を読めます" ;;
        2) doctor_ng "常駐 (launchd) から Keychain を読めるか確かめられません (確認用のジョブを登録できない)" "Mac にログインしたターミナルで meeting doctor" ;;
        *) doctor_ng "常駐 (launchd) のプロセスから Keychain を読めません (Groq を使わず手元で処理されます)" \
             "ロックされていれば security unlock-keychain。直らなければ security delete-generic-password -s $GROQ_SERVICE のあと $GROQ_ADD_CMD" ;;
      esac
    fi
  fi
  return "$DOCTOR_BAD"
}

# インストール済みのコピー ($PREFIX) が plugin $1 のソースと同じなら 0
installed_matches() {
  local plugin="$1" f
  cmp -s "$plugin/scripts/meeting.sh" "$INSTALLED" || return 1
  for f in align.py transcribe.py; do cmp -s "$plugin/transcribe/$f" "$PREFIX/transcribe/$f" || return 1; done
  diff -rq -x .build "$plugin/recorder" "$PREFIX/src/recorder" >/dev/null 2>&1
}

# 常駐と同じ gui ドメインの launchd ジョブから Keychain の $GROQ_SERVICE を読めるか (秘密は捨てる)。
# 0 = 読める / 1 = 読めない・応答なし / 2 = 確認用のジョブを登録できない
keychain_from_launchd() {
  local label="$LABEL.doctor" domain="gui/$(id -u)" tmp rc="" i
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/meeting-doctor.XXXXXX")"
  python3 -I - "$label" "$tmp" "$GROQ_SERVICE" > "$tmp/probe.plist" <<'PY'
import os, plistlib, sys
label, tmp, service = sys.argv[1:]
sys.stdout.buffer.write(plistlib.dumps({
    "Label": label,
    "ProgramArguments": ["/bin/sh", "-c", 'security find-generic-password -s "$1" -w >/dev/null 2>&1; echo $? > "$2/rc"',
                         "sh", service, tmp],
    "EnvironmentVariables": {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": os.environ["HOME"]},
    "RunAtLoad": True,
}))
PY
  launchctl bootout "$domain/$label" >/dev/null 2>&1 || true
  if ! launchctl bootstrap "$domain" "$tmp/probe.plist" >/dev/null 2>&1; then
    rm -rf "$tmp"
    return 2
  fi
  # 許可ダイアログが出ていれば答えるまで返らないので、10 秒で諦める
  for ((i = 0; i < 100; i++)); do
    [[ -s "$tmp/rc" ]] && break
    sleep 0.1
  done
  launchctl bootout "$domain/$label" >/dev/null 2>&1 || true
  [[ -s "$tmp/rc" ]] && rc="$(cat "$tmp/rc")"
  rm -rf "$tmp"
  [[ "$rc" == 0 ]]
}

cmd_skip() {
  launchctl kill SIGUSR1 "gui/$(id -u)/$LABEL" && echo "✓ 今の会議はスキップします (録音中なら破棄)"
}

cmd_watch() {
  need_install
  exec "$REC_BIN" --watch --on-stop "$INSTALLED" "$@"
}

write_meta() {
  python3 -I - "$@" <<'PY'
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
  if [[ "$AUTO_NOTES" == 1 ]]; then cmd_notes "$dir"; else
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
  if [[ "$AUTO_NOTES" == 1 && -n "$NOTES_DIR" ]] && command -v claude >/dev/null; then
    # 文字起こしは第三者の発言をそのまま含むのに、-p では許可の確認ができない。ここで足すのは skill の
    # .gitignore 確認に要る git の許可と Web アクセスの禁止だけで、それ以外は絞れていない:
    # acceptEdits なので notes_dir 配下・録音 DIR・(外にあれば) output_dir のファイルはどれでも編集でき、
    # ユーザー設定の permissions.allow もそのまま効く。書き込みを議事録と全文の 2 ファイルに限っているのは
    # SKILL.md の規則だけ。output_dir が外にあるときに --add-dir しないと、-p では Write が許可待ちのまま失敗する。
    # プロンプトは可変長の --allowedTools に飲まれないよう -p の直後に置く。
    # -p では許可されていない MCP ツールは拒否されるので、カレンダーの参加者を使うにはツール名を
    # 設定の calendar_tools で渡す (ツール名は環境ごとに違うので既定値は持たない)
    local allowed="Bash(git check-ignore:*),Bash(git rev-parse:*)" ext add=()
    [[ -n "$CALENDAR_TOOLS" ]] && allowed+=",$CALENDAR_TOOLS"
    ext="$(outside_notes_dir --create "$NOTES_DIR")" || { notify "議事録の保存先を作れません: $(basename "$dir")"; exit 1; }
    [[ -n "$ext" ]] && add=(--add-dir "$ext")
    (cd "$NOTES_DIR" && claude -p "/meeting-notes $dir --non-interactive" \
      --permission-mode acceptEdits --add-dir "$dir" ${add[@]+"${add[@]}"} \
      --allowedTools "$allowed" \
      --disallowedTools "WebFetch,WebSearch") || { notify "議事録の作成に失敗しました: $(basename "$dir")"; exit 1; }
    local unresolved labels
    unresolved="$(note_tool find "$dir" "$NOTES_DIR" ${ext:+"$ext"} | cut -f3)" || true
    if [[ -n "$unresolved" ]]; then
      IFS=, read -ra labels <<< "$unresolved"
      notify "議事録を作成しました: $(basename "$dir") — 名前が未確定の話者 ${#labels[@]} 人 (meeting name で名前を入れられます)"
    else
      notify "議事録を作成しました: $(basename "$dir")"
    fi
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
  local root="${NOTES_DIR:-$PWD}" ext add=()
  ext="$(outside_notes_dir --create "$root")" || die "議事録の保存先を作れません"
  [[ -n "$ext" ]] && add=(--add-dir "$ext")
  cd "$root" && claude --add-dir "$dir" ${add[@]+"${add[@]}"} "/meeting-notes $dir"
}

# skill-config の output_dir が root の外 (Drive の同期フォルダ等) なら出す。中なら何も出さない。
# 作るのは議事録を書く経路 (--create) だけ。探すだけの経路は、無ければ出さない (共有先に空フォルダを作らない)
outside_notes_dir() {
  local create=0 base out
  [[ "$1" == --create ]] && { create=1; shift; }
  base="$(cd "$1" && pwd -P)" || return 1
  out="$(note_tool outdir "$base")" || return 1
  case "$out/" in "$base"/*) return 0 ;; esac
  if [[ "$create" == 1 ]]; then mkdir -p "$out" || return 1
  elif [[ ! -d "$out" ]]; then return 0
  fi
  echo "$out"
}

# 話者の声を確かめる (/meeting-notes の「この発言は誰？」で質問の前に鳴らす)。
# どの区間を鳴らすかは align.pick_clips が決め、発言の source でトラックを選ぶ (自分 = mic.wav)
# afplay が sandbox の中で鳴らないので play だけは sandbox の外で動かす。録音 DIR・cwd・$TMPDIR は sandbox から
# 書けるので、そこに置かれたものに外の権限で読み書きさせない: python は -I (cwd の *.py を import しない)、
# 発言の改行・タブは空白にして 1 クリップ 1 行を保つ、入力はシンボリックリンクを拒んで wav 形式に固定する、
# 切り出し先は sandbox から書けない per-user の一時ディレクトリ (DARWIN_USER_TEMP_DIR) に作る
cmd_play() {
  [[ $# -eq 2 ]] || die "使い方: meeting play <DIR> <話者ラベル>"
  local dir="${1%/}" label="$2"
  [[ -f "$dir/transcript.json" ]] || die "$dir/transcript.json がありません。先に meeting transcribe"
  [[ ! -L "$dir/transcript.json" ]] || die "$dir/transcript.json がシンボリックリンクです"
  command -v ffmpeg >/dev/null || die "ffmpeg がありません"
  command -v afplay >/dev/null || die "afplay がありません (macOS 専用)"
  local clips
  clips="$(python3 -I - "$SRC/transcribe" "$dir/transcript.json" "$label" <<'PY'
import json, sys
sys.path.insert(0, sys.argv[1])
from align import Utterance, fmt_ts, pick_clips
utts = [Utterance(**u) for u in json.load(open(sys.argv[2]))["utterances"]]
for c in pick_clips(utts, sys.argv[3]):
    wav = "mic.wav" if c.source == "mic" else "system.wav"
    text = c.text.translate({ord("\n"): " ", ord("\r"): " ", ord("\t"): " "})
    print(f"{wav}\t{c.start:.2f}\t{c.end - c.start:.2f}\t[{fmt_ts(c.start)}] {text}")
PY
)"
  [[ -n "$clips" ]] || die "$label の発言がありません"
  local tmp base wav start dur line i=0
  # 切り出す前に全クリップの wav を確かめる (途中で止めて一部だけ鳴らさない)
  while IFS=$'\t' read -r wav _; do
    [[ -f "$dir/$wav" ]] || die "$dir/$wav がありません"
    [[ ! -L "$dir/$wav" ]] || die "$dir/$wav がシンボリックリンクです"
  done <<< "$clips"
  base="$(getconf DARWIN_USER_TEMP_DIR 2>/dev/null)" || base="${TMPDIR:-/tmp}"
  tmp="$(mktemp -d "${base%/}/meeting-play.XXXXXX")"
  trap "rm -rf '$tmp'" EXIT
  while IFS=$'\t' read -r wav start dur line; do
    echo "$line"
    ffmpeg -nostdin -loglevel error -y -ss "$start" -t "$dur" -f wav -i "$dir/$wav" "$tmp/$i.wav"
    afplay "$tmp/$i.wav" < /dev/null
    i=$((i + 1))
  done <<< "$clips"
}

# 議事録 = frontmatter の recording: が録音 DIR を指す Markdown。output_dir を変えても前の議事録を見失わないよう、
# 探索は root 配下を全部見て、output_dir が root の外 (Drive の同期フォルダ等) ならそこも見る (notes_roots)
#   outdir [--global] <base>
#                           skill-config の output_dir (既定 meetings) を base 相対で絶対パスにして出す。
#                           --global はグローバルの ~/.config/skills/config.json だけを読む
#   find <DIR|""> <root>... DIR の議事録 (DIR が空なら unresolved_speakers が残る最新の録音の議事録) を
#                           「議事録<TAB>録音 DIR<TAB>未確定のラベル (, 区切り)」で出す。無ければ何も出さない
#   set <root> <議事録> <話者A=田中,...>
#                           議事録と全文 (frontmatter の transcript_path:、無ければ root 相対の transcript:) の
#                           ラベルを置き換え、unresolved_speakers から外す。全文が見つからなければ非 0
#   set-names <root> <議事録> <話者A=田中,...> <許可する保存先>...
#                           set と同じ。ただし書く前に議事録と全文がシンボリックリンクでなく realpath が許可する
#                           保存先の配下にあることを確かめ、1 つでも外れたら (全文が無いときも) 何も書かずに非 0
note_tool() {
  python3 -I - "$@" <<'PY'
import json, os, re, stat, sys

def unq(v):
    return v.strip().strip("\"'")

def labels_of(v):
    v = v.strip()
    if v.startswith("[") and v.endswith("]"):
        v = v[1:-1]
    return [unq(x) for x in v.split(",") if unq(x)]

def split_note(text):
    """(frontmatter の行, 本文)。frontmatter が無ければ None。"""
    lines = text.split("\n")
    if not lines or lines[0] != "---":
        return None
    for i in range(1, len(lines)):
        if lines[i] == "---":
            return lines[1:i], "\n".join(lines[i + 1:])
    return None

def fields(fm_lines):
    out = {}
    for line in fm_lines:
        k, sep, v = line.partition(":")
        if sep:
            out[k.strip()] = v.strip()
    return out

def notes(root):
    for d, subdirs, files in os.walk(root):
        subdirs[:] = sorted(s for s in subdirs if not s.startswith("."))
        for name in sorted(files):
            if not name.endswith(".md"):
                continue
            path = os.path.join(d, name)
            try:
                parts = split_note(open(path, encoding="utf-8").read())
            except (OSError, UnicodeDecodeError):
                continue
            fm = fields(parts[0]) if parts else {}
            if fm.get("recording"):
                yield path, unq(fm["recording"]), labels_of(fm.get("unresolved_speakers", ""))

def output_dir(base, project=True):
    """SKILL.md と同じ順 (git root の skill-config.json → .claude/skill-config.json → グローバル) で
    最初に見つかった meeting-notes セクションの output_dir を、base 相対で絶対パスにする。
    project=False はグローバルだけを読む (set-names: base とその git root は sandbox から書ける)。"""
    top, d = None, os.path.abspath(base)
    while project:
        if os.path.exists(os.path.join(d, ".git")):
            top = d
            break
        if os.path.dirname(d) == d:
            break
        d = os.path.dirname(d)
    paths = [os.path.join(top, "skill-config.json"), os.path.join(top, ".claude", "skill-config.json")] if top else []
    paths.append(os.path.expanduser("~/.config/skills/config.json"))
    out = "meetings"
    for p in paths:
        try:
            sec = json.load(open(p, encoding="utf-8")).get("meeting-notes")
        except (OSError, ValueError, AttributeError):
            continue
        if isinstance(sec, dict):
            out = sec.get("output_dir") or out
            break
    print(os.path.normpath(os.path.join(os.path.abspath(base), os.path.expanduser(out))))

def find(roots, want=None):
    hits = [h for root in roots for h in notes(root)]
    if want:
        hits = [h for h in hits if os.path.realpath(h[1]) == os.path.realpath(want)]
    else:
        hits = sorted((h for h in hits if h[2]), key=lambda h: os.path.basename(h[1].rstrip("/")))
    if hits:
        path, rec, labels = hits[-1]
        print(f"{path}\t{rec}\t{','.join(labels)}")

def checked(path, allowed):
    """set-names: path がシンボリックリンクでない既存のファイルで、realpath が allowed のどれかの配下にあれば
    realpath を返す。外れたら何も書かずに非 0 で終わる。"""
    if os.path.islink(path):
        sys.exit(f"meeting: {path} がシンボリックリンクです")
    if not os.path.isfile(path):
        sys.exit(f"meeting: {path} がありません")
    real = os.path.realpath(path)
    if not any(real.startswith(os.path.join(a, "")) for a in allowed):
        sys.exit(f"meeting: {path} は議事録の保存先 ({', '.join(allowed)}) の外です")
    return real

def open_checked(path, allowed):
    """checked で確かめた realpath を / から 1 要素ずつ O_NOFOLLOW でたどって開き、(realpath, file) を返す。
    確かめたあとで途中のディレクトリや最後の要素を symlink に差し替えられても、許可外のファイルを開かない
    (O_NOFOLLOW は最後の要素にしか効かないので、パスを開き直さず dir_fd でたどる)。読み書きはこの 1 つの fd で行う。"""
    real = checked(path, allowed)
    parts = real.strip("/").split("/")
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for p in parts[:-1]:
            nxt = os.open(p, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = nxt
        ffd = os.open(parts[-1], os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    except OSError as e:
        sys.exit(f"meeting: {path} を開けません (確かめたあとで差し替えられた可能性があります): {e}")
    finally:
        os.close(fd)
    if not stat.S_ISREG(os.fstat(ffd).st_mode):
        os.close(ffd)
        sys.exit(f"meeting: {path} が通常のファイルではありません")
    return real, os.fdopen(ffd, "r+", encoding="utf-8")

def rewrite(f, text):
    f.seek(0)
    f.truncate()
    f.write(text)
    f.close()

def set_names(root, note, spec, allowed=None):
    """allowed (set-names) があれば、書く前に議事録と全文を checked で確かめ、1 つでも外れたら何も書かない。
    全文の transcript_path: は絶対パスだけを受け付ける (相対だと cwd 基準になる)。"""
    strict = allowed is not None
    names = {}
    for pair in spec.split(","):
        k, sep, v = pair.partition("=")
        if sep and k.strip() and v.strip():
            names[k.strip()] = v.strip()
    if not names:
        sys.exit("meeting: " + ("話者は" if strict else "--set には") + " 話者A=田中,話者B=佐藤 の形で渡してください")
    # 話者A を置き換えるとき 話者AB や 話者27 の頭を巻き込まない
    pat = re.compile("(?:" + "|".join(re.escape(k) for k in sorted(names, key=len, reverse=True)) + ")(?![A-Za-z0-9])")
    sub = lambda s: pat.sub(lambda m: names[m.group(0)], s)

    if strict:
        allowed = [os.path.realpath(a) for a in allowed]
        note, note_f = open_checked(note, allowed)
    else:
        note_f = open(note, "r+", encoding="utf-8")
    fm_lines, body = split_note(note_f.read())
    out, transcript, transcript_path, left = [], None, None, []
    for line in fm_lines:
        k, _, v = line.partition(":")
        if k.strip() == "unresolved_speakers":
            left = [x for x in labels_of(v) if x not in names]
            if left:
                out.append(f"unresolved_speakers: [{', '.join(left)}]")
            continue
        if k.strip() == "transcript":
            transcript = unq(v).removeprefix("[[").removesuffix("]]").split("|")[0]
        if k.strip() == "transcript_path":
            # ファイルの場所なので置き換えない
            transcript_path = unq(v)
            out.append(line)
            continue
        out.append(sub(line))

    # transcript: は作成時の cwd 相対なので、作成時の絶対パス (transcript_path:) があればそちらを使う。
    # 無い議事録は root 相対で探す
    path = None
    if transcript_path:
        path = os.path.expanduser(transcript_path)
        if strict and not os.path.isabs(path):
            sys.exit(f"meeting: transcript_path: が絶対パスではありません: {transcript_path}")
    elif transcript:
        path = transcript if transcript.endswith(".md") else transcript + ".md"
        path = os.path.join(root, os.path.expanduser(path))
    path_f = None
    if strict and path:
        path, path_f = open_checked(path, allowed)

    rewrite(note_f, "\n".join(["---", *out, "---"]) + "\n" + sub(body))
    print(f"✓ {note}")
    missing = False
    if path:
        if path_f is None and os.path.isfile(path):
            path_f = open(path, "r+", encoding="utf-8")
        if path_f is not None:
            rewrite(path_f, sub(path_f.read()))
            print(f"✓ {path}")
        else:
            print(f"! 全文が見つかりません: {path}", file=sys.stderr)
            missing = True
    print("未確定の話者: " + (", ".join(left) if left else "なし"))
    if missing:
        sys.exit(1)

cmd = sys.argv[1]
if cmd == "find":
    find(sys.argv[3:], sys.argv[2] or None)
elif cmd == "outdir":
    output_dir(sys.argv[-1], project=sys.argv[2] != "--global")
elif cmd == "set":
    set_names(*sys.argv[2:5])
elif cmd == "set-names":
    set_names(*sys.argv[2:5], allowed=sys.argv[5:])
PY
}

# 全自動で名前を確定できなかった話者に後から名前を入れる。要約は作り直さず、ラベルを置き換えるだけ。
# --set なしは claude の /meeting-notes --name-unresolved で「この発言は誰？」と聞き、答えを --set で反映する
cmd_name() {
  local dir="" spec=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --set) [[ $# -ge 2 ]] || die "--set には 話者A=田中,話者B=佐藤 の形で渡してください"; spec="$2"; shift 2 ;;
      -*) die "不明なオプション: $1" ;;
      *) [[ -z "$dir" ]] || die "DIR は 1 つだけ指定できます"; dir="${1%/}"; shift ;;
    esac
  done
  local root="${NOTES_DIR:-$PWD}" ext found note labels
  ext="$(outside_notes_dir "$root")" || die "議事録の保存先を解決できません"
  found="$(note_tool find "$dir" "$root" ${ext:+"$ext"})"
  if [[ -z "$found" ]]; then
    [[ -z "$dir" ]] || die "$dir の議事録が $root${ext:+ / $ext} にありません (frontmatter の recording: で探します)"
    echo "未確定の話者が残る議事録はありません ($root${ext:+ / $ext})"
    return 0
  fi
  IFS=$'\t' read -r note dir labels <<< "$found"
  if [[ -z "$labels" ]]; then
    echo "未確定の話者はありません: $note"
    return 0
  fi
  if [[ -n "$spec" ]]; then
    note_tool set "$root" "$note" "$spec"
    return
  fi
  command -v claude >/dev/null || die "claude (Claude Code) がありません"
  cd "$root" && claude --add-dir "$dir" ${ext:+--add-dir "$ext"} "/meeting-notes $dir --name-unresolved $note"
}

# name --set と同じ置き換えを、sandbox の外で動かしてよい形で行う (sandbox.excludedCommands に "meeting set-names *"
# だけを登録する)。録音 DIR・cwd・notes_dir は sandbox から書けるので、そこに置かれたものに外の権限で書く先を
# 決めさせない: root は notes_dir だけ ($PWD に落ちない)、output_dir はグローバルの skill-config だけから読み
# (cwd や notes_dir の git root の skill-config.json は sandbox から書ける)、claude は起動しない。
# 議事録と全文は書く前に symlink でなく realpath が notes_dir / output_dir の配下にあることを確かめる
cmd_set_names() {
  [[ $# -eq 2 && -n "$1" && -n "$2" ]] || die "使い方: meeting set-names <DIR> <話者A=名前,話者B=名前>"
  local dir="${1%/}" spec="$2"
  [[ -n "$NOTES_DIR" ]] || die "設定ファイルに notes_dir がありません (meeting setup --notes-dir DIR)"
  local root ext found note labels
  root="$(cd "$NOTES_DIR" && pwd -P)" || die "notes_dir がありません ($NOTES_DIR)"
  ext="$(note_tool outdir --global "$root")" || die "議事録の保存先を解決できません"
  case "$ext/" in "$root"/*) ext="" ;; esac
  [[ -z "$ext" || -d "$ext" ]] || ext=""
  found="$(note_tool find "$dir" "$root" ${ext:+"$ext"})"
  [[ -n "$found" ]] || die "$dir の議事録が $root${ext:+ / $ext} にありません (frontmatter の recording: で探します)"
  IFS=$'\t' read -r note dir labels <<< "$found"
  if [[ -z "$labels" ]]; then
    echo "未確定の話者はありません: $note"
    return 0
  fi
  note_tool set-names "$root" "$note" "$spec" "$root" ${ext:+"$ext"}
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
# 設定ファイルは起動のたびに読む (常駐から呼ばれる post も、install し直さずに今の値を使う)。
# 読めなくても doctor は ❌ として報告し、help は出す
if ! load_config; then
  case "$sub" in
    doctor|help|-h|--help|'') ;;
    post) notify "設定ファイルを読めません (meeting doctor で確認できます)"; die "$CONFIG_ERR" ;;
    *) die "$CONFIG_ERR" ;;
  esac
fi
case "$sub" in
  setup) cmd_setup "$@" ;;
  doctor) cmd_doctor ;;
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
  play) cmd_play "$@" ;;
  name) cmd_name "$@" ;;
  set-names) cmd_set_names "$@" ;;
  ls) cmd_ls ;;
  -h|--help|help) usage ;;
  *) usage; exit 2 ;;
esac
