# meeting

主催者が自分でなくても（録画ボタンが押せなくても）、**自分の Mac で鳴っている会議音声**を録音し、
Whisper で文字起こし・pyannote で話者分離して、`/meeting-notes` で議事録にする plugin。
Zoom / Google Meet / Teams などアプリを問わず使え、処理はすべてローカル（Apple Silicon）で完結する。

```
meeting-rec (Swift)                        transcribe.py                      /meeting-notes
  system.wav  … 相手の声 (ScreenCaptureKit) ──▶  mlx-whisper (large-v3-turbo)  ──▶  議事録 Markdown
  mic.wav     … 自分の声 (AVAudioEngine) ───▶  pyannote (相手側だけ話者分離)       (TL;DR / 決定事項 / TODO)
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
  `meeting setup` は keychain にコード署名用の自己署名証明書「meeting-rec local signing」を作り（初回だけ。信頼設定はしない）、
  それで `meeting-rec` を署名するので、plugin の更新でバイナリが差し替わっても許可は残る。ad-hoc 署名だった以前のインストールから
  切り替えるとき（と証明書を作り直したとき）だけ一度再許可が要る。`meeting-rec` が変わる `setup` では署名のたびに keychain のダイアログが
  出るので、ログインパスワードを入れて「許可」を押す（応答するまで `setup` は止まる。keychain に届かない sandbox の中からは署名できない）。
  **「常に許可」は押さない**: 押すと、同じユーザーで動くほかのプログラムがこの鍵で `meeting-rec` を差し替えて署名し直し、画面収録・マイクの
  許可を引き継げてしまう（押してしまったら keychain アクセスで鍵を削除し、`meeting setup` で作り直す）。
  権限エラーが続くときはシステム設定で `meeting-rec` を「−」で削除して
  「+」で追加し直す（トグルのオン・オフでは直らない）。macOS 15 以降は画面収録の許可を定期的に再確認するダイアログが出る。
- **ブラウザ**: ブラウザでマイクを使う = Web 会議とみなすので、ブラウザでの音声入力でも 8 秒続けば録音が始まる（`meeting skip` か `MEETING_APPS` から外す）。
  ブラウザがミュート中にマイクを閉じると、45 秒後に録音がいったん切れ、解除で別ファイルとして再開する。
- **全自動の議事録（`MEETING_AUTO_NOTES=1`）**: 相手の発言を含む文字起こしを、`MEETING_NOTES_DIR` 配下を編集できる
  非対話の Claude に読ませる。書き込みを議事録と全文に限るのは skill の指示だけなので、`MEETING_NOTES_DIR` には
  議事録専用のディレクトリを指定する。
- **全自動での話者名**: 全自動では名前を確定できなかった話者をラベルのまま残し、議事録の frontmatter に
  `unresolved_speakers` として記録する（完了通知に人数が出る）。後から `meeting name` で名前を入れられる。
  カレンダーの参加者を使わせるには、カレンダー連携の MCP ツール名を `MEETING_CALENDAR_TOOLS`（`,` 区切り）に
  入れて `meeting install` し直す（非対話の claude は許可していないツールを使えない。ツール名は環境ごとに違うので既定値は無い）。
  claude.ai の Google Calendar コネクタなら `mcp__claude_ai_Google_Calendar__list_events`。claude.ai のコネクタは
  `ANTHROPIC_API_KEY` が設定されていると読み込まれない（常駐はこの変数を引き継がないが、`meeting post` を手で実行する
  シェルに置いてあると参加者を取れない）。
- **ヘッドホン推奨**: スピーカーだと相手の声がマイクにも入り、`自分` として二重に文字起こしされる。
- **マイクの選び方**: 自動録音は、検知した会議アプリがいま入力に使っているデバイスで録る（`meeting log` の
  「録音開始」行に `(マイク: <名前>)` と出る）。引けないときはシステム既定の入力。会議アプリ自体が仮想デバイス
  （BlackHole 等）を拾っていると mic.wav は無音になるので、`mic.wav` が無音ならこの行のマイク名を確かめる。

## 手動で使う

```fish
meeting rec 週次定例                  # 録音開始。Ctrl-C で停止 → 文字起こし + 話者分離
meeting rec 商談 --app zoom           # Zoom の音だけ録る
meeting notes                         # 最新の録音から議事録（MEETING_NOTES_DIR か cwd で claude を起動）
meeting transcribe <DIR> --num-speakers 3 --prompt "固有名詞, 社内用語"
meeting play <DIR> 話者A              # その話者の声を約 5 秒再生（自分 は mic.wav から）
meeting name                          # 未確定の話者が残る最新の議事録に「この発言は誰？」で名前を入れる
meeting ls
```

`/meeting-notes`（対話時）は名前が確定しない話者ごとに、代表的な発言を見せ `meeting play` で声を鳴らしてから
「この発言は誰？」と聞く。`meeting name` は同じ質問を未確定の話者だけに行い、議事録本文と全文のラベルを置き換える
（要約は作り直さない）。

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
自動録音の議事録は常に `MEETING_NOTES_DIR` で作られるので、設定は `MEETING_NOTES_DIR` の repo の `skill-config.json` か、
どこから `/meeting-notes` を打っても揃うグローバルの `~/.config/skills/config.json` に書く。
全文の文字起こしには相手の発言がそのまま入るので、`transcripts_dir` は `.gitignore` に入れておく。

議事録をチームで読めるよう Google Drive に置くには、Google Drive for desktop の同期フォルダを `output_dir` に指定する
（`MEETING_NOTES_DIR` の外でよい。自動議事録の claude にはそのフォルダを `--add-dir` で渡し、`meeting name` もそこを探す）。
`output_dir` が外にあるとき、全文の既定の保存先は共有先ではなく `MEETING_NOTES_DIR` 側の `meetings/transcripts` になる
（git 管理外にしておく）:

```json
{
  "meeting-notes": {
    "output_dir": "~/Library/CloudStorage/GoogleDrive-<you>/Shared drives/<team>/議事録"
  }
}
```

Claude Code の sandbox を使っている場合、`meeting name` は Bash から議事録を書き換えるので、`output_dir` を
sandbox の書き込み許可（`sandbox.filesystem.allowWrite`）に入れておく。

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
