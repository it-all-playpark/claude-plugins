# meeting

主催者が自分でなくても（録画ボタンが押せなくても）、**自分の Mac で鳴っている会議音声**を録音し、
Whisper で文字起こし・pyannote で話者分離して、`/meeting-notes` で議事録にする plugin。
Zoom / Google Meet / Teams などアプリを問わず使え、既定では処理はすべてローカル（Apple Silicon）で完結する
（Whisper だけ Groq に出して作業マシンを軽くすることもできる: [Whisper を Groq で処理する](#whisper-を-groq-で処理する)）。

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

1. plugin を入れる: `/plugin install meeting@playpark`
2. `meeting setup` を実行する: Claude Code に「`meeting setup` を実行して」と頼む（plugin の `bin/` は Claude Code の
   Bash の PATH に入る）か、ターミナルで `bash "<plugin の install 先>/bin/meeting" setup` を実行する

`meeting setup` は次を順に行う。何度実行してもよく、済んでいる手順は飛ばす:

1. 依存（`swift` / `ffmpeg` / `uv`）の確認
2. Swift の録音バイナリをビルドし、`${XDG_DATA_HOME:-~/.local/share}/meeting-rec`（`MEETING_PREFIX`）にインストールして
   `~/.local/bin/meeting` に symlink を張る（バイナリが変わったときだけ差し替わる）
3. 文字起こし・話者分離のモデルの取得。Hugging Face にログインしていなければ、規約のページとログインのコマンドを出す
4. 設定ファイル（[設定](#設定)）の作成。答えられる端末があり設定ファイルがまだ無いときだけ、議事録の置き場所・
   全自動にするか・Groq を使うかを聞く。Groq を選んで Keychain にキーが無ければ、その場で登録させる
5. 自動録音の常駐（launchd）の登録

端末が無いとき（Claude Code の Bash など）は質問せず、引数と既存の設定ファイルだけで最後まで進む:

```
meeting setup --notes-dir ~/notes --auto-notes --asr-backend groq
```

| 引数 | 設定ファイルのキー |
|---|---|
| `--home DIR` | `home` |
| `--notes-dir DIR` | `notes_dir` |
| `--auto-notes` / `--no-auto-notes` | `auto_notes` |
| `--calendar-tools A,B` | `calendar_tools` |
| `--asr-backend mlx\|groq` | `asr_backend` |
| `--no-daemon` | （常駐を登録しない。登録済みなら再起動だけする） |

端末が無いときに Groq を選んで Keychain にキーが無ければ、登録のコマンドを出して止まる（ターミナルで実行してから
`meeting setup` をやり直す）。常駐を登録し直さずに終わるとき（`--no-daemon` とこの場合）も、常駐が登録済みなら
差し替えた録音バイナリで動くよう再起動する。

plugin の install 先は更新のたびに変わるが、launchd とマイク / 画面収録の許可は実行ファイルのパスに紐づくため、
録音バイナリは固定の場所に置く。plugin を更新したら `meeting setup` を再実行する。ターミナルの `meeting setup`
（インストール済みのコピー）は、Claude Code の `installed_plugins.json` が指す今の plugin に引き継いでインストールし直すので、
更新後の plugin の install 先を探す必要はない。

状態は `meeting doctor` で 1 行ずつ確かめられる（依存・インストール済みの版が plugin と同じか・HF のログイン・
設定ファイルの中身・常駐・Groq を使うなら Keychain のキーと、常駐（launchd）のプロセスからそのキーを読めるか）。
足りない項目は ❌ と直し方を出す。

## 設定

設定は `${XDG_CONFIG_HOME:-~/.config}/meeting/config.json` の 1 ファイルにある。`meeting setup` が書き、手で編集してもよい。
`meeting`・文字起こし・常駐（`meeting-rec`）は起動のたびにこのファイルを読むので、書き換えても `meeting install` の
やり直しは要らない（常駐は録音していない間に読み直す）。環境変数からは読まない。

```json
{
  "notes_dir": "~/notes",
  "auto_notes": true,
  "asr_backend": "groq"
}
```

| キー | 既定 | 説明 |
|---|---|---|
| `home` | `~/Meetings` | 録音の保存先 |
| `notes_dir` | なし（`meeting notes` を実行した場所） | 議事録を置く repo / vault。`meeting notes` / `meeting name` と全自動の議事録はここで claude を起動する |
| `auto_notes` | `false` | `true` で文字起こしのあと議事録作成まで全自動にする（`notes_dir` が要る） |
| `calendar_tools` | なし | 全自動の議事録で claude に許可するカレンダー連携の MCP ツール名の配列（`mcp__` で始まる名前だけ。文字起こしを読む claude に Bash 等を渡さないため） |
| `apps` | 下記の会議アプリ | 検知対象の上書き。`["us.zoom.=Zoom", "com.microsoft.teams=Teams"]`（bundle id の前方一致=表示名） |
| `asr_backend` | `mlx` | `groq` で Whisper を Groq に送る（[下記](#whisper-を-groq-で処理する)） |
| `asr_model` | `mlx-community/whisper-large-v3-turbo` | Whisper のモデル |
| `diar_model` | `pyannote/speaker-diarization-community-1` | 話者分離のモデル（pyannote.audio 3 系なら `pyannote/speaker-diarization-3.1`） |

`home` / `notes_dir` は絶対パスか `~` で始まるパス（`~` 単体か `~/...`）で書く。空や相対パスは、`meeting` と常駐で
別の場所を指すので、`meeting setup` の引数でも設定ファイルでもエラーにする。

一回だけ別の値で動かすときは引数で渡す（例: `meeting transcribe <DIR> --asr-backend groq`）。
`meeting install` は設定ファイルを変えずに常駐だけを登録し直す。

## 自動録音（おすすめ）

`meeting setup` が常駐（launchd）を登録し、以後ログイン時に起動する。
会議アプリが**マイクを使い始めた瞬間**を検知して録音を開始し、会議が終わったら止めて文字起こし →（任意で）議事録作成まで進む。
主催者・URL・カレンダーに依存しないので、相手が作った会議でも録れる。開始・終了時に macOS の通知が出る。

| タイミング | 判定 |
|---|---|
| 開始 | 会議アプリがマイクを **8 秒以上**使い続けた（macOS 14+ の CoreAudio でプロセス単位に判定） |
| 継続 | マイク使用中、または Zoom / Teams 等の専用アプリが音声出力中（長時間ミュートでも切れない） |
| 終了 | 上記が **45 秒**途切れた。30 秒未満の録音（マイクテスト等）は破棄 |

対象: Zoom / Teams / Webex / Slack ハドル / Discord / FaceTime / LINE / ブラウザ（Chrome, Arc, Brave, Edge, Firefox, Safari → Google Meet など）。
設定の `apps` で上書きできる（bundle id は `meeting-rec --list-apps` で確認）。

```
meeting skip      # 今の会議を録らない（録音中なら破棄。その会議が終わるまで再開しない）
meeting status    # 常駐状態と直近ログ
meeting log
meeting uninstall
```

注意点:

- **権限**: 常駐時はターミナルではなく `meeting-rec` 自身に「画面収録とシステムオーディオ録音」「マイク」の許可が要る。
  常駐を登録した直後（常駐の起動時）にダイアログが出るので許可する（出なければシステム設定から
  `$MEETING_PREFIX/bin/meeting-rec` を追加）。許可する前に会議が始まっても、許可した時点から録音を始める。
  ad-hoc 署名なので、バイナリが差し替わると再許可が必要になることがある。macOS 15 以降は画面収録の許可を定期的に再確認するダイアログが出る。
- **ブラウザ**: ブラウザでマイクを使う = Web 会議とみなすので、ブラウザでの音声入力でも 8 秒続けば録音が始まる（`meeting skip` か設定の `apps` から外す）。
  ブラウザがミュート中にマイクを閉じると、45 秒後に録音がいったん切れ、解除で別ファイルとして再開する。
- **全自動の議事録（`auto_notes: true`）**: 相手の発言を含む文字起こしを、`notes_dir` 配下を編集できる
  非対話の Claude に読ませる。書き込みを議事録と全文に限るのは skill の指示だけなので、`notes_dir` には
  議事録専用のディレクトリを指定する。
- **全自動での話者名**: 全自動では名前を確定できなかった話者をラベルのまま残し、議事録の frontmatter に
  `unresolved_speakers` として記録する（完了通知に人数が出る）。後から `meeting name` で名前を入れられる。
  カレンダーの参加者を使わせるには、カレンダー連携の MCP ツール名を設定の `calendar_tools` に入れる
  （`meeting setup --calendar-tools A,B`。非対話の claude は許可していないツールを使えない。ツール名は環境ごとに違うので既定値は無い）。
  claude.ai の Google Calendar コネクタなら `mcp__claude_ai_Google_Calendar__list_events`。claude.ai のコネクタは
  `ANTHROPIC_API_KEY` が設定されていると読み込まれない（常駐はこの変数を引き継がないが、`meeting post` を手で実行する
  シェルに置いてあると参加者を取れない）。
- **ヘッドホン推奨**: スピーカーだと相手の声がマイクにも入り、`自分` として二重に文字起こしされる。
- **マイクの選び方**: 自動録音は、検知した会議アプリがいま入力に使っているデバイスで録る（`meeting log` の
  「録音開始」行に `(マイク: <名前>)` と出る）。引けないときはシステム既定の入力。会議アプリ自体が仮想デバイス
  （BlackHole 等）を拾っていると mic.wav は無音になるので、`mic.wav` が無音ならこの行のマイク名を確かめる。

## 手動で使う

```
meeting rec 週次定例                  # 録音開始。Ctrl-C で停止 → 文字起こし + 話者分離
meeting rec 商談 --app zoom           # Zoom の音だけ録る
meeting notes                         # 最新の録音から議事録（設定の notes_dir か cwd で claude を起動）
meeting transcribe <DIR> --num-speakers 3 --prompt "固有名詞, 社内用語"
meeting play <DIR> 話者A              # その話者の声を約 5 秒再生（自分 は mic.wav から）
meeting name                          # 未確定の話者が残る最新の議事録に「この発言は誰？」で名前を入れる
meeting set-names <DIR> 話者A=田中    # その録音の議事録と全文のラベルを置き換える（claude は起動しない）
meeting ls
```

`/meeting-notes`（対話時）は名前が確定しない話者ごとに、代表的な発言を見せ `meeting play` で声を鳴らしてから
「この発言は誰？」と聞く。`meeting name` は同じ質問を未確定の話者だけに行い、議事録本文と全文のラベルを置き換える
（要約は作り直さない）。

自動録音と手動録音を同時に動かすと二重に録れる。

精度を上げるコツ: 相手の人数が分かれば `--num-speakers N`（自分を除く）。固有名詞は `--prompt`（`meta.json` の `"prompt"` でも可）。

## 出力

```
~/Meetings/2026-01-01_1400-Zoom/      # 設定の home
├── meta.json         # title, started_at, ended_at（自動録音なら app, auto）
├── system.wav        # 相手側 (48kHz mono)
├── mic.wav           # 自分
├── transcript.json   # utterances: [{start, end, speaker, text, source}]
├── transcript.md     # **[00:01:23] 話者A**: ...
└── postprocess.log   # 自動録音時の文字起こし / 議事録のログ
```

議事録の保存先は `skill-config.json` の `meeting-notes` セクションで変えられる（`output_dir` / `transcripts_dir` / `save_transcript`）。
自動録音の議事録は常に `notes_dir` で作られるので、設定は `notes_dir` の repo の `skill-config.json` か、
どこから `/meeting-notes` を打っても揃うグローバルの `~/.config/skills/config.json` に書く。
全文の文字起こしには相手の発言がそのまま入るので、`transcripts_dir` は `.gitignore` に入れておく。

議事録をチームで読めるよう Google Drive に置くには、Google Drive for desktop の同期フォルダを `output_dir` に指定する
（`notes_dir` の外でよい。自動議事録の claude にはそのフォルダを `--add-dir` で渡し、`meeting name` もそこを探す）。
`output_dir` が外にあるとき、全文の既定の保存先は共有先ではなく `notes_dir` 側の `meetings/transcripts` になる
（git 管理外にしておく）:

```json
{
  "meeting-notes": {
    "output_dir": "~/Library/CloudStorage/GoogleDrive-<you>/Shared drives/<team>/議事録"
  }
}
```

Claude Code の sandbox を使っている場合、名前の後入れ（`/meeting-notes --name-unresolved`）は Bash の
`meeting set-names <DIR> "話者A=田中,..."` で議事録と全文を書き換える。保存先を sandbox の書き込み許可に入れる代わりに、
このコマンドだけを sandbox の外で動かす:

```json
{
  "sandbox": {
    "excludedCommands": ["meeting set-names *"]
  }
}
```

`meeting set-names` は sandbox から書ける場所（録音 DIR・cwd・議事録）に置かれたものに書き込み先を決めさせない:

- 書くのは `notes_dir` と `output_dir` の配下（realpath で比べる）だけ。議事録の `transcript_path:` / `transcript:` が
  その外を指す（絶対パス・`..`・シンボリックリンク経由）か、議事録・全文がシンボリックリンクなら、どれも書かずに失敗する
- `notes_dir` は `meeting` の設定ファイルから、`notes_dir` の外の `output_dir` はグローバルの
  `~/.config/skills/config.json` からだけ読む。cwd や `notes_dir` の git root の `skill-config.json` は読まず、
  `notes_dir` が無ければ cwd では探さずに失敗する。この 2 つの設定ファイルは sandbox の書き込み許可に入れない
- claude を起動しない

`"meeting name *"` は登録しない。`meeting name` は claude を起動し、cwd や `notes_dir` の `skill-config.json` で
書き込み先が決まる。

## Whisper を Groq で処理する

文字起こしで重いのは Whisper（手元の計測で、同じ音声に対し pyannote の約 2 倍。しかも 2 トラック分走る）。
設定の `asr_backend` を `groq` にすると Whisper だけを [Groq](https://console.groq.com/) の
`whisper-large-v3-turbo` に送り、作業マシンの GPU を空ける（5.5 分の音声で約 2 秒）。話者分離は手元のまま。
既定は `mlx` で、設定しない限り音声は外に出ない。

1. Groq のアカウントを作り API キーを発行する。コンソールの Data Controls で **Zero Data Retention** を有効にする
   （無効のままだと不正利用の監視用に入出力が最大 30 日残る）。Groq は規約で入出力を学習に使わない
2. ターミナルで `meeting setup --asr-backend groq` を実行し、聞かれたら API キーを入れる（ログイン Keychain に
   `meeting-groq` として入る。ssh / mosh 越しなら先に `security unlock-keychain`）。端末の無い Claude Code から
   実行した場合は、出てくる `security add-generic-password -a "$USER" -s meeting-groq -w` をターミナルで実行してから
   `meeting setup` をやり直す
3. `meeting doctor` で、常駐（launchd）のプロセスからキーを読めることを確かめる。一回だけ Groq で処理するなら
   `meeting transcribe <dir> --asr-backend groq`

送るもの・送らないもの:

- 送るのは**話している区間だけ**をつないだ音声（16kHz モノラル Opus 32kbps）。無音を送ると Groq は無音区間に
  「ご視聴ありがとうございました」を書き起こし、しかも `no_speech_prob` が常に 0 なので後から落とせないため
- `meta.json` の `prompt`（固有名詞のヒント）は送らない。送り先は `api.groq.com` に固定
- Keychain が読めない・上限超過（429）・通信失敗のときは手元の mlx-whisper で処理し直す。どのトラックを
  Groq に送ったかは `transcript.json` の `asr_backend` に残る

無料枠の上限は 1 時間 7,200 秒・1 日 28,800 秒（音声の秒数）。話している区間だけを送るので、60 分の会議でも
多くは数十分ぶんに収まる。音声は Groq（米国）に渡るので、客先の会議などで外部に出せない場合は使わない。

## 録音のマナー

会話の当事者による録音でも、会社の規程・NDA・相手との関係で問題になり得る。録音していることを一言伝え、
音声と全文は手元に留めて共有は議事録だけにする運用を推奨する。

## テスト

```
bats plugins/meeting/scripts/meeting.bats plugins/meeting/transcribe/align.bats plugins/meeting/recorder/*.bats
```

録音（ScreenCaptureKit / CoreAudio）と ML 推論は macOS 実機でしか動かないため、CI では引数処理・設定ファイルの読み書き・
plist 生成・doctor の各項目・文字起こしと話者の突き合わせロジックだけを検証する（`recorder/*.bats` は swiftc のある macOS でだけ動く）。
