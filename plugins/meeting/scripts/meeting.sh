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
#   meeting play <DIR> <話者ラベル>     その話者の声を約 5 秒再生する (自分 は mic.wav から)
#   meeting name [DIR]                  議事録の未確定の話者 (unresolved_speakers) に名前を入れる
#                                       DIR 省略時は未確定の話者が残る最新の録音
#   meeting ls                          録音一覧
#
# 環境変数:
#   MEETING_HOME          録音の保存先 (default: ~/Meetings)
#   MEETING_NOTES_DIR     議事録を置くリポジトリ / vault。notes / name と自動議事録はここで claude を起動する
#   MEETING_AUTO_NOTES=1  文字起こし後に議事録作成まで自動実行 (MEETING_NOTES_DIR が必要)
#   MEETING_CALENDAR_TOOLS 自動議事録の claude -p に許可するカレンダー連携のツール名 (, 区切り。既定なし)
#   MEETING_APPS          検知対象の上書き "us.zoom.=Zoom,com.microsoft.teams=Teams"
#   MEETING_PREFIX        インストール先 (default: ${XDG_DATA_HOME:-~/.local/share}/meeting-rec)
#   MEETING_BIN_DIR       meeting コマンドの symlink 先 (default: ~/.local/bin)
#   MEETING_INSTALL_WAIT  install で旧常駐の登録が外れるのを待つ上限秒 (default: 30)
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
for k in ("MEETING_AUTO_NOTES", "MEETING_NOTES_DIR", "MEETING_CALENDAR_TOOLS", "MEETING_APPS", "MEETING_PREFIX", "MEETING_ASR_MODEL", "MEETING_DIAR_MODEL"):
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
    # acceptEdits なので MEETING_NOTES_DIR 配下・録音 DIR・(外にあれば) output_dir のファイルはどれでも編集でき、
    # ユーザー設定の permissions.allow もそのまま効く。書き込みを議事録と全文の 2 ファイルに限っているのは
    # SKILL.md の規則だけ。output_dir が外にあるときに --add-dir しないと、-p では Write が許可待ちのまま失敗する。
    # プロンプトは可変長の --allowedTools に飲まれないよう -p の直後に置く。
    # -p では許可されていない MCP ツールは拒否されるので、カレンダーの参加者を使うにはツール名を
    # MEETING_CALENDAR_TOOLS で渡す (ツール名は環境ごとに違うので既定値は持たない)
    local allowed="Bash(git check-ignore:*),Bash(git rev-parse:*)" ext add=()
    [[ -n "${MEETING_CALENDAR_TOOLS:-}" ]] && allowed+=",$MEETING_CALENDAR_TOOLS"
    ext="$(outside_notes_dir --create "$MEETING_NOTES_DIR")" || { notify "議事録の保存先を作れません: $(basename "$dir")"; exit 1; }
    [[ -n "$ext" ]] && add=(--add-dir "$ext")
    (cd "$MEETING_NOTES_DIR" && claude -p "/meeting-notes $dir --non-interactive" \
      --permission-mode acceptEdits --add-dir "$dir" ${add[@]+"${add[@]}"} \
      --allowedTools "$allowed" \
      --disallowedTools "WebFetch,WebSearch") || { notify "議事録の作成に失敗しました: $(basename "$dir")"; exit 1; }
    local unresolved labels
    unresolved="$(note_tool find "$dir" "$MEETING_NOTES_DIR" ${ext:+"$ext"} | cut -f3)" || true
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
  local root="${MEETING_NOTES_DIR:-$PWD}" ext add=()
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
cmd_play() {
  [[ $# -eq 2 ]] || die "使い方: meeting play <DIR> <話者ラベル>"
  local dir="${1%/}" label="$2"
  [[ -f "$dir/transcript.json" ]] || die "$dir/transcript.json がありません。先に meeting transcribe"
  command -v ffmpeg >/dev/null || die "ffmpeg がありません"
  command -v afplay >/dev/null || die "afplay がありません (macOS 専用)"
  local clips
  clips="$(python3 - "$SRC/transcribe" "$dir/transcript.json" "$label" <<'PY'
import json, sys
sys.path.insert(0, sys.argv[1])
from align import Utterance, fmt_ts, pick_clips
utts = [Utterance(**u) for u in json.load(open(sys.argv[2]))["utterances"]]
for c in pick_clips(utts, sys.argv[3]):
    wav = "mic.wav" if c.source == "mic" else "system.wav"
    print(f"{wav}\t{c.start:.2f}\t{c.end - c.start:.2f}\t[{fmt_ts(c.start)}] {c.text}")
PY
)"
  [[ -n "$clips" ]] || die "$label の発言がありません"
  local tmp wav start dur line i=0
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/meeting-play.XXXXXX")"
  trap "rm -rf '$tmp'" EXIT
  while IFS=$'\t' read -r wav start dur line; do
    [[ -f "$dir/$wav" ]] || die "$dir/$wav がありません"
    echo "$line"
    ffmpeg -nostdin -loglevel error -y -ss "$start" -t "$dur" -i "$dir/$wav" "$tmp/$i.wav"
    afplay "$tmp/$i.wav" < /dev/null
    i=$((i + 1))
  done <<< "$clips"
}

# 議事録 = frontmatter の recording: が録音 DIR を指す Markdown。output_dir を変えても前の議事録を見失わないよう、
# 探索は root 配下を全部見て、output_dir が root の外 (Drive の同期フォルダ等) ならそこも見る (notes_roots)
#   outdir <base>           skill-config の output_dir (既定 meetings) を base 相対で絶対パスにして出す
#   find <DIR|""> <root>... DIR の議事録 (DIR が空なら unresolved_speakers が残る最新の録音の議事録) を
#                           「議事録<TAB>録音 DIR<TAB>未確定のラベル (, 区切り)」で出す。無ければ何も出さない
#   set <root> <議事録> <話者A=田中,...>
#                           議事録と全文 (frontmatter の transcript:) のラベルを置き換え、unresolved_speakers から外す
note_tool() {
  python3 - "$@" <<'PY'
import json, os, re, sys

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

def output_dir(base):
    """SKILL.md と同じ順 (git root の skill-config.json → .claude/skill-config.json → グローバル) で
    最初に見つかった meeting-notes セクションの output_dir を、base 相対で絶対パスにする。"""
    top, d = None, os.path.abspath(base)
    while True:
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

def set_names(root, note, spec):
    names = {}
    for pair in spec.split(","):
        k, sep, v = pair.partition("=")
        if sep and k.strip() and v.strip():
            names[k.strip()] = v.strip()
    if not names:
        sys.exit("meeting: --set には 話者A=田中,話者B=佐藤 の形で渡してください")
    # 話者A を置き換えるとき 話者AB や 話者27 の頭を巻き込まない
    pat = re.compile("(?:" + "|".join(re.escape(k) for k in sorted(names, key=len, reverse=True)) + ")(?![A-Za-z0-9])")
    sub = lambda s: pat.sub(lambda m: names[m.group(0)], s)

    fm_lines, body = split_note(open(note, encoding="utf-8").read())
    out, transcript, left = [], None, []
    for line in fm_lines:
        k, _, v = line.partition(":")
        if k.strip() == "unresolved_speakers":
            left = [x for x in labels_of(v) if x not in names]
            if left:
                out.append(f"unresolved_speakers: [{', '.join(left)}]")
            continue
        if k.strip() == "transcript":
            transcript = unq(v).removeprefix("[[").removesuffix("]]").split("|")[0]
        out.append(sub(line))
    with open(note, "w", encoding="utf-8") as f:
        f.write("\n".join(["---", *out, "---"]) + "\n" + sub(body))
    print(f"✓ {note}")

    if transcript:
        path = transcript if transcript.endswith(".md") else transcript + ".md"
        path = os.path.join(root, os.path.expanduser(path))
        if os.path.isfile(path):
            text = open(path, encoding="utf-8").read()
            with open(path, "w", encoding="utf-8") as f:
                f.write(sub(text))
            print(f"✓ {path}")
        else:
            print(f"! 全文が見つかりません: {path}", file=sys.stderr)
    print("未確定の話者: " + (", ".join(left) if left else "なし"))

cmd = sys.argv[1]
if cmd == "find":
    find(sys.argv[3:], sys.argv[2] or None)
elif cmd == "outdir":
    output_dir(sys.argv[2])
elif cmd == "set":
    set_names(*sys.argv[2:5])
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
  local root="${MEETING_NOTES_DIR:-$PWD}" ext found note labels
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
  play) cmd_play "$@" ;;
  name) cmd_name "$@" ;;
  ls) cmd_ls ;;
  -h|--help|help) usage ;;
  *) usage; exit 2 ;;
esac
