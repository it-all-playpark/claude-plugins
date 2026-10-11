---
name: meeting-notes
description: >
  Creates meeting notes from a speaker-labelled transcript produced by the `meeting` CLI
  (meeting-rec + whisper + pyannote): replaces 話者A/話者B labels with real names, extracts
  TL;DR / decisions / TODOs / open issues, and saves Markdown into the current repo or vault.
  Use when: (1) user wants 議事録 from a recorded Zoom / Google Meet / Teams meeting,
  (2) invoked by `meeting notes` or the auto-recording post-process,
  (3) keywords: 議事録, 会議メモ, 文字起こし, 話者識別, MTG まとめ, meeting notes, transcript, minutes.
  Accepts args: [DIR] [--names "話者A=田中,話者B=佐藤"] [--no-transcript] [--non-interactive]
---

# meeting-notes

`meeting` CLI（同 plugin の `bin/meeting`）が録音・文字起こしした会議から議事録を作る。

## Usage

```
/meeting-notes [DIR] [--names "話者A=田中,話者B=佐藤"] [--no-transcript] [--non-interactive]
```

| Arg | Default | Description |
|-----|---------|-------------|
| `DIR` | `$MEETING_HOME`（既定 `~/Meetings`）配下の最新ディレクトリ | 録音ディレクトリ |
| `--names` | なし | 話者ラベル → 実名の対応。無ければ Step 2 で推定・確認 |
| `--no-transcript` | off | 全文の文字起こしを保存しない |
| `--non-interactive` | off | 質問しない（自動録音後に `claude -p` から呼ばれる場合）。不確かな話者はラベルのまま残し、推定候補を「メモ」に書く |

## 設定（skill-config.json の `meeting-notes`）

| キー | 既定 | 説明 |
|------|------|------|
| `output_dir` | `meetings` | 議事録の保存先（cwd 相対） |
| `transcripts_dir` | `<output_dir>/transcripts` | 全文の保存先。相手の発言全文を含むので git 管理外にする |
| `save_transcript` | `true` | 全文を保存するか（`--no-transcript` が優先） |

`meeting-notes` セクションを、プロジェクト（git root の `skill-config.json`、無ければ `.claude/skill-config.json`）→ グローバル（`~/.config/skills/config.json`）の順に探して Read し、無いキーは既定値を使う。

## 入力ファイル (DIR 内)

- `meta.json` … `title`, `started_at`, `ended_at`。自動録音（`auto: true`）では `title` は「Zoom 会議」のような仮タイトルで、`app` に検知したアプリ名が入る
- `transcript.json` … `utterances[]` = `{start, end, speaker, text, source}`。`source: "mic"` は自分、`"system"` は相手側
- `transcript.md` … 人間向けの同内容

## Workflow

### Step 1: 読み込み
`meta.json` と `transcript.json` を Read する。長い場合は分割して全体を読む（途中を飛ばさない）。

### Step 2: タイトルと話者の実名を決める
`--names` があればそれを使う。無ければ以下の手がかりで推定する:

1. 発話中の自己紹介・呼びかけ（「田中さん、どうですか」の直後に話した話者 = 田中 など）
2. カレンダー連携ツール（Google Calendar 等）が使えれば `started_at` 前後の予定を検索し、予定名と参加者を取得
3. `meta.json` の `title`

**タイトル**: `auto: true` の仮タイトルなら、カレンダーの予定名 → 会話内容から付けた短い名前、の順で決める。

推定結果は根拠付きで AskUserQuestion で確認する（1 問に最大 4 話者、選択肢に「不明のまま」を含める）。
`--non-interactive` のときは確認せず、確信度の高いものだけ置き換える。`自分` はユーザー本人。

話者分離は完璧ではない。同一人物が 2 ラベルに割れている・短い相槌が別人に付いている可能性を念頭に置き、
文脈上明らかな誤りは要約側で吸収する（文字起こし本文は書き換えない）。

### Step 3: 議事録を作成
保存先: `<output_dir>/YYYY-MM-DD-<slug>.md`（日付は `started_at`。slug はタイトルを英小文字ケバブケースにしたもの。日本語タイトルなら内容を表す短い英語 slug）

```markdown
---
tags: [meeting]
created: YYYY-MM-DD
started_at: <meta.started_at>
duration_min: <ended_at - started_at>
attendees: [自分, 田中, 佐藤]
transcript: "[[<transcripts_dir>/YYYY-MM-DD-<slug>]]"
---

# <タイトル>

## TL;DR
3 行以内。

## 決定事項
- ...

## TODO
- [ ] <内容> — 担当: <名前> / 期限: <言及があれば>

## 議論のポイント
論点ごとに箇条書き。誰がどの立場だったかを残す。重要発言は `[hh:mm:ss]` を添える。

## 未解決・持ち越し
- ...

## メモ
（固有名詞の聞き取りが怪しい箇所、話者分離の誤りと思われる箇所など）
```

- 書かれていないことを補完しない。推測は「(推測)」と明記する。
- TODO は自分の担当分を先頭に。
- 既存ノートに関連があれば `[[wikilink]]` を張る（cwd を Glob で軽く確認）。

### Step 4: 全文の保存（`save_transcript` かつ `--no-transcript` でないとき）
`transcript.md` の話者ラベルを実名に置き換えたものを `<transcripts_dir>/YYYY-MM-DD-<slug>.md` に Write する。
cwd が git repo で `git check-ignore -q <transcripts_dir>/x.md` が失敗する（= 追跡対象になる）場合は、
保存はするが報告で「.gitignore に `<transcripts_dir>/` を追加すること」を必ず伝える。

### Step 5: 報告
保存したパス、TL;DR、自分の TODO を短く返す。commit はユーザーに指示されたときだけ行う。
