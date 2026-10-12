# meeting

主催者が自分でなくても（録画ボタンが押せなくても）、**自分の Mac で鳴っている会議音声**を録音し、
Whisper で文字起こし・pyannote で話者分離して、`/meeting-notes` で議事録にする plugin。
Zoom / Google Meet / Teams などアプリを問わず使え、処理はすべてローカル（Apple Silicon）で完結する。

```
meeting-rec (Swift, ScreenCaptureKit)      transcribe.py                      /meeting-notes
  system.wav  … 相手の声 ─────────────▶  mlx-whisper (large-v3-turbo)  ──▶  議事録 Markdown
  mic.wav     … 自分の声 ─────────────▶  pyannote (相手側だけ話者分離)       (TL;DR / 決定事項 / TODO)
```

自分の声（マイク）と相手の声（システム音声）を**別トラック**で録るので「自分」は話者分離なしで確定し、
話者分離は相手側だけに掛かる。

## 必要なもの

- macOS 15 以降 / Apple Silicon
- Xcode Command Line Tools（`swift`）、`ffmpeg`、`uv`、`python3`
- Hugging Face アカウント: <https://huggingface.co/pyannote/speaker-diarization-community-1> で利用規約に同意し、
  `uvx --from huggingface_hub hf auth login`（初回のモデル取得にだけ使う）

## セットアップ

```
/plugin install meeting@playpark
```

Claude Code に「`meeting setup` を実行して」と頼む（plugin の `bin/` は Claude Code の Bash の PATH に入る）か、
ターミナルで `bash "<plugin の install 先>/bin/meeting" setup` を実行する。

`setup` は Swift の録音バイナリをビルドし、`${XDG_DATA_HOME:-~/.local/share}/meeting-rec`（`MEETING_PREFIX`）に
インストールして `~/.local/bin/meeting` に symlink を張る。plugin の install 先は更新のたびに変わるが、
launchd とマイク / 画面収録の許可は実行ファイルのパスに紐づくため、固定の場所に置く。
plugin を更新したら `meeting setup` を再実行する（バイナリが変わったときだけ差し替わる）。

## 自動録音（おすすめ）

```fish
set -Ux MEETING_NOTES_DIR ~/notes   # 議事録を置く repo / vault（任意）
set -Ux MEETING_AUTO_NOTES 1        # 議事録作成まで全自動にする場合（任意）
meeting install                     # ログイン時に常駐（launchd）。以後ずっと有効
```

会議アプリが**マイクを使い始めた瞬間**を検知して録音を開始し、会議が終わったら止めて文字起こし →（任意で）議事録作成まで進む。
主催者・URL・カレンダーに依存しないので、相手が作った会議でも録れる。開始・終了時に macOS の通知が出る。

| タイミング | 判定 |
|---|---|
| 開始 | 会議アプリがマイクを **8 秒以上**使い続けた（macOS 14+ の CoreAudio でプロセス単位に判定） |
| 継続 | マイク使用中、または Zoom / Teams 等の専用アプリが音声出力中（長時間ミュートでも切れない） |
| 終了 | 上記が **45 秒**途切れた。30 秒未満の録音（マイクテスト等）は破棄 |

対象: Zoom / Teams / Webex / Slack ハドル / Discord / FaceTime / ブラウザ（Chrome, Arc, Brave, Edge, Firefox, Safari → Google Meet など）。
`MEETING_APPS="us.zoom.=Zoom,com.microsoft.teams=Teams"` で上書きできる（bundle id は `meeting-rec --list-apps` で確認。変更後は `meeting install` し直す）。

```fish
meeting skip      # 今の会議を録らない（録音中なら破棄。その会議が終わるまで再開しない）
meeting status    # 常駐状態と直近ログ
meeting log
meeting uninstall
```

注意点:

- **権限**: 常駐時はターミナルではなく `meeting-rec` 自身に「画面収録とシステムオーディオ録音」「マイク」の許可が要る。
  `meeting install` の直後（常駐の起動時）にダイアログが出るので許可する（出なければシステム設定から
  `$MEETING_PREFIX/bin/meeting-rec` を追加）。許可する前に会議が始まっても、許可した時点から録音を始める。
  ad-hoc 署名なので、バイナリが差し替わると再許可が必要になることがある。macOS 15 以降は画面収録の許可を定期的に再確認するダイアログが出る。
- **ブラウザ**: ブラウザでマイクを使う = Web 会議とみなすので、ブラウザでの音声入力でも 8 秒続けば録音が始まる（`meeting skip` か `MEETING_APPS` から外す）。
  ブラウザがミュート中にマイクを閉じると、45 秒後に録音がいったん切れ、解除で別ファイルとして再開する。
- **全自動の議事録（`MEETING_AUTO_NOTES=1`）**: 相手の発言を含む文字起こしを、`MEETING_NOTES_DIR` 配下を編集できる
  非対話の Claude に読ませる。書き込みを議事録と全文に限るのは skill の指示だけなので、`MEETING_NOTES_DIR` には
  議事録専用のディレクトリを指定する。
- **ヘッドホン推奨**: スピーカーだと相手の声がマイクにも入り、`自分` として二重に文字起こしされる。

## 手動で使う

```fish
meeting rec 週次定例                  # 録音開始。Ctrl-C で停止 → 文字起こし + 話者分離
meeting rec 商談 --app zoom           # Zoom の音だけ録る
meeting notes                         # 最新の録音から議事録（MEETING_NOTES_DIR か cwd で claude を起動）
meeting transcribe <DIR> --num-speakers 3 --prompt "固有名詞, 社内用語"
meeting ls
```

自動録音と手動録音を同時に動かすと二重に録れる。

精度を上げるコツ: 相手の人数が分かれば `--num-speakers N`（自分を除く）。固有名詞は `--prompt`（`meta.json` の `"prompt"` でも可）。

## 出力

```
~/Meetings/2026-01-01_1400-Zoom/      # MEETING_HOME
├── meta.json         # title, started_at, ended_at（自動録音なら app, auto）
├── system.wav        # 相手側 (48kHz mono)
├── mic.wav           # 自分
├── transcript.json   # utterances: [{start, end, speaker, text, source}]
├── transcript.md     # **[00:01:23] 話者A**: ...
└── postprocess.log   # 自動録音時の文字起こし / 議事録のログ
```

議事録の保存先は `skill-config.json` の `meeting-notes` セクションで変えられる（`output_dir` / `transcripts_dir` / `save_transcript`）。
全文の文字起こしには相手の発言がそのまま入るので、`transcripts_dir` は `.gitignore` に入れておく。

| 環境変数 | 既定 |
|---|---|
| `MEETING_ASR_MODEL` | `mlx-community/whisper-large-v3-turbo` |
| `MEETING_DIAR_MODEL` | `pyannote/speaker-diarization-community-1`（pyannote.audio 3 系なら `pyannote/speaker-diarization-3.1`） |

## 録音のマナー

会話の当事者による録音でも、会社の規程・NDA・相手との関係で問題になり得る。録音していることを一言伝え、
音声と全文は手元に留めて共有は議事録だけにする運用を推奨する。

## テスト

```
bats plugins/meeting/scripts/meeting.bats plugins/meeting/transcribe/align.bats
```

録音（ScreenCaptureKit / CoreAudio）と ML 推論は macOS 実機でしか動かないため、CI では引数処理・plist 生成・
文字起こしと話者の突き合わせロジックだけを検証する。
