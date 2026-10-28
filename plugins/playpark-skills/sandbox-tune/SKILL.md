---
name: sandbox-tune
description: >-
  Aggregates sandbox denials, permission denials, "please run this in your terminal" requests, and host-exec
  (out-of-sandbox) runs from Claude Code transcripts by type, checks them against the settings repo's git log (resolved / remaining),
  and proposes settings / wrapper / hook fixes with a safety review. Writes a local Markdown report; with --issue, hands
  human-confirmed drafts to dev-flow:git-issue for filing. Reviews the issue drafts the daily job left and files only confirmed ones.
  Use when: (1) user asks why the agent keeps asking them to run commands, or which sandbox denials still recur,
  (2) user wants settings.json / excludedCommands / allowUnixSockets fix candidates backed by evidence,
  (3) user asks whether host-exec is being used for things settings should fix,
  (4) user asks to review the daily sandbox-tune drafts (日次の下書き),
  (5) keywords: sandbox-tune, sandbox 拒否, Operation not permitted, EPERM, 人間に実行依頼, 通常のターミナルで, settings 修正, permission 拒否, host-exec.
  Accepts args: [--days N] [--no-verify] [--issue] [--allow-public]
---

# Sandbox Tune

transcript（`~/.claude/projects/<project>/<session>.jsonl`）から、繰り返し起きている拒否と人間への実行依頼を型にまとめ、
直すべきものだけを根拠付きで出す。`/fewer-permission-prompts` が扱う read-only の allow rule は対象外。

集計（collect）・突き合わせ（verify）・レポートはスクリプトが決定論で行う。あなたの仕事は remaining の型の原因・修正案・安全性の判断と、
`--issue` のときの下書きと確認、日次ジョブが残した下書きの確認。レポートはローカルに書くだけで、外部には何も送らない（日次ジョブの判断だけは、新しい再発の型と判断基準を `claude -p` に渡す）。

## 設定 (`<repo>/sandbox-tune.json`)

呼び出した repo（cwd）の `sandbox-tune.json`（`--config F` を渡したらそのファイル）を読む。
`run` は `configRepo` のある設定が要る。設定が無い・`configRepo` が無いときは何も書かずに exit 2 で止まる
（verify の無いレポートは、設定 repo で対応済みの型まで修正候補に見えるため）。
ユーザーが集計だけでよいと言ったときだけ `--no-verify` を付ける。設定ファイルを自分で作らない。

```json
{
  "configRepo": { "path": "~/src/dotfiles", "paths": ["claude/settings.json", "claude/bin", "claude/hooks"] },
  "criteriaFiles": ["~/src/dotfiles/claude/RULES.md"],
  "intended": [{ "kind": "permission-rule", "reason": "permissions.deny で止めている" }],
  "issue": { "repo": "owner/dotfiles", "template": "sandbox-tune-issue.md", "labels": ["sandbox"] }
}
```

| キー | 型 | 意味 |
|------|----|------|
| `configRepo.path` | 文字列（必須: configRepo を書くとき） | settings を管理している git repo。`run` の verify に使い、無ければ `run` は exit 2（`--no-verify` を除く） |
| `configRepo.paths` | 空でない文字列の配列 | verify で git log を見るパス（設定ファイル・wrapper・hook）。repo root 相対 |
| `criteriaFiles` | 文字列の配列 | 安全性の判定に加える基準のファイル（個人の運用ルール等）。必ず読む |
| `intended` | オブジェクトの配列 | 意図した拒否（permissions.deny・組み込みガード・人間がやると決めた操作等）。各項目は `id`（型の id と完全一致）か `kind`（型の kind と一致）のどちらか一方と、`reason`（空でない文字列）を持つ。verify で一致した型は status を `intended` にし、remaining・`recurring` から外す。同じ型に意図した拒否と直すべき拒否が混ざる kind（hook 等）は kind で書かず、型の `id` で書く |
| `issue.repo` | `owner/name` | issue の提出先。`--issue` のときに必須 |
| `issue.template` | 文字列 | issue 化の材料（下書き）のテンプレート。`{{title}}` `{{id}}` `{{evidence}}` `{{cause}}` `{{fix}}` `{{safety}}` `{{ac}}`（`ac` を `- [ ] ` で並べたもの）`{{paths}}`（`paths` を `- ` で並べたもの）を置換する。`{{ac}}` と `{{paths}}` の両方が無いテンプレートはエラー（exit 2）。dev-flow で走らせるには `{{ac}}` を受け入れ基準の見出し（`## 受け入れ基準（Acceptance Criteria）` 等）、`{{paths}}` を `## 変更対象パス` の下に置く。省略時は既定のテンプレート（両方の節を持つ） |
| `issue.labels` | 文字列の配列 | git-issue に渡すラベル |

- `~` は `$HOME`、相対パスは設定ファイルのディレクトリ基準
- 未知のキー・型違い・存在しないファイル・git repo でない `configRepo.path` はエラー（exit 2）。直してから再実行する

## 実行

スクリプトは `bash ${CLAUDE_PLUGIN_ROOT}/sandbox-tune/scripts/sandbox-tune.sh <subcommand>` で呼ぶ（以下 `ST`）。

```bash
ST run [--days N]              # collect → verify → report。書いたパスを JSON で返す
ST run --no-verify [--days N]  # verify せず collect → report だけ（出力の verified は false）
ST config                      # 検証済みの設定（criteriaFiles の絶対パスを含む）
```

- `run` は設定（`configRepo`）が無ければ exit 2 で止まり、stderr で `sandbox-tune.json` と `--no-verify` を案内する。
  ユーザーに `configRepo` を書いた設定を用意してもらうか、集計だけでよいか確かめて `--no-verify` で再実行する
- `--no-verify` は設定の有無にかかわらず verify しない。レポート冒頭に verify 未実施と書かれ、resolved / remaining の判定は付かない
- `run` は `claudedocs/sandbox-tune-<日付>.md`（レポート）と同名の `.json`（集計結果）を cwd に書く。`--out DIR` で変えられる
- `run` の最終行は要約 JSON（`report`・`analysis`・`verified`・`types` と status ごとの型の数 `remaining`・`stale_branch`・`resolved`・`intended`、`recurring`）。
  `recurring` は今も再発している remaining の型の数で、status が `remaining`・`count` が 2 以上・`last_seen` が期間終端（`.period.until`）から
  7 日以内（ちょうど 7 日前を含む）の型を数える。閾値は `sandbox-tune.sh` の `RECURRING_MIN_COUNT` / `RECURRING_WITHIN_DAYS`。
  数えた型には集計結果の `.json` で `recurring: true` が付く。`--no-verify` の run では status が無いので `null`（型にも付かない）
- 期間は既定 30 日。ユーザーが `--days N` を渡したらそのまま渡す

### 日次実行（任意・macOS）

既定では何も登録しない。ユーザーが日次の集計を望んだときだけ、`install-schedule.sh` を手で 1 回実行して
launchd に登録する。登録すると毎日 06:30 に `scripts/daily.sh` が `run --config <設定> --out ~/.claude/logs/sandbox-tune`
を走らせ、新しい再発を issue の下書きまでにし、実行ごとに `~/.claude/logs/sandbox-tune/runs.jsonl` へ 1 行追記する。

- 成功: `run` の要約 JSON（`report`・`analysis`・`verified`・`types`・`remaining`・`stale_branch`・`resolved`・`intended`・`recurring`）に
  `ts`（ISO 8601 UTC）と `new_recurring`（新しい再発の数）・`drafts`（作った下書きの数）・`drafts_root`・`draft_error`（下書き段階の失敗の理由。無ければ null）を足した行
- 失敗: `{ts, exit, error}`（`exit` は `run` の終了コード、`error` は stderr の末尾）

下書き段階（終了コードは `run` のまま。起票はしない — `handoff` / `git-issue` は呼ばない）:

- verify した run の recurring の型のうち、判断済みの記録 `~/.claude/logs/sandbox-tune/triaged.json`（型の id の配列）に無いものが新しい再発。
  `triaged.json` が無い初回は今の recurring を判断済みとして記録するだけ。resolved になった型は記録から外れる
- 新しい再発があり、設定に `issue.repo` があるときだけ、`claude -p` を**ツールなし**（`--tools ""` `--safe-mode` `--strict-mcp-config`
  `--disable-slash-commands`。skill 経由で起動しない）で 1 回起動する。代表例は transcript 由来で外部の文字列（指示文を含みうる）を含み、
  ツールがあれば代表例経由の指示でファイルを読ませて伏せ字を通らない出力に残せるため。入力は daily.sh が決定論で用意して stdin で渡す:
  新しい再発の型（analysis JSON の該当型）・`criteriaFiles` の本文・判断基準（`scripts/criteria.md`）。
  settings や git log は見ずに判断するので、下書きの原因・修正案は人が確かめる前提で読む
- 置き場は設定ファイルのディレクトリの `claudedocs/sandbox-tune-drafts/<実行時刻>/`。claude の判断 `triage.json`
  （`{candidates, skipped}`。`skipped` は `{id, class, reason}` で、class は `scripts/criteria.md` の分類）と、`candidates` を
  `draft --issue` にかけた下書き（`sandbox-tune-issue-<n>.md` と `.meta.json`）を書く。置き場が git に無視されていると
  確かめられない（`git check-ignore` が 0 で終わらない・git repo でない）ときは claude を呼ばず何も書かない
- `candidates` か `skipped` に挙がった型だけが判断済みになる。挙がらなかった型と、下書き段階が失敗した（claude の失敗・
  出力の誤り・draft の失敗）run の新しい再発は、翌日の run で再び渡される

```bash
bash ${CLAUDE_PLUGIN_ROOT}/sandbox-tune/scripts/install-schedule.sh --print --repo <skills checkout> --config <sandbox-tune.json>    # plist を確認（登録しない）
bash ${CLAUDE_PLUGIN_ROOT}/sandbox-tune/scripts/install-schedule.sh --install --repo <skills checkout> --config <sandbox-tune.json>  # 登録
bash ${CLAUDE_PLUGIN_ROOT}/sandbox-tune/scripts/install-schedule.sh --uninstall                                                     # 解除（bootout と plist 削除）
```

- `--repo` は skills repo の git checkout。plist は checkout 内の `daily.sh` を指す（版付きの plugin cache パスに固定しない）
- `--config` は `configRepo` を書いた設定。launchd は `~` を展開しないので、登録時に絶対パスにして plist に書く
- launchd の PATH は最小なので、登録時の PATH を plist に焼き込む（jq / git / claude の解決用）。PATH が変わったら登録し直す

### 日次の下書きを処理する

ユーザーが日次の下書きの確認を頼んだとき、または `/sandbox-tune` を実行したときに置き場（`runs.jsonl` の最終行の
`drafts_root`）に下書きが残っていれば、そのことを伝えてから次を行う。日次の下書きは人の確認を経ていないので、確認なしに起票しない。

1. 置き場の `<実行時刻>/` ごとに、下書き（`sandbox-tune-issue-<n>.md`）の本文と、`triage.json` の `skipped`（型 / class / reason）を
   そのままユーザーに示す。伏せ字は形での判定なので、秘密が残っていないかもユーザーに見てもらう
2. 下書きごとに、起票するか見送るかをユーザーに確認する（AskUserQuestion）。確認なしに次へ進まない。
   直したいときは `triage.json` の候補を直して `draft --issue`（`--out` にその `<実行時刻>/`）からやり直し、表示した下書きで確認を取り直す
3. 起票する下書きだけを、`.meta.json` の `sha256` を digest にして `ST handoff <下書き> --digest <sha256> [--allow-public]` に通す
   （終了コードの扱いは「issue 化」の 4 と同じ。0 以外なら 4 に進まない）
4. handoff が出した JSON で `dev-flow:git-issue` を呼ぶ（「issue 化」の 5 と同じ）
5. その `<実行時刻>/` の下書きをすべて起票か見送りにしたら、ディレクトリを `rip` で消す（処理済みの下書きを残さない。`rm` は使わない）

### 集計の決まり（スクリプトが守っていること）

- 型は「拒否された対象」で分ける: `sandbox:path:<書き込み先>` / `sandbox:unix_socket:<path>` / `sandbox:network:<host>` /
  `sandbox:command:<コマンド>`（対象が出ない拒否）/ `sandbox:launch_services:<コマンド>`（`open` 等の `-10822`）/
  `request:request:<コマンド>`（人間への実行依頼）/ `permission:<kind>:<tool> <対象>`（kind は permission-rule / hook / automode-blocked / user-rejected /
  worktree-guard 等。worktree-guard はコマンドの形で拒否するのでコマンド名で割らず `Bash *` の 1 型。
  hook はコマンド名で割らず、エラー文の 1 行目（`PreToolUse:<tool> hook error: ` を除き、最初の `。` か改行まで）で
  `permission:hook:<tool> <エラー文>` に分ける。needle はその文を伏せ字に通したもので、hook のファイルからその文を消した・
  変えた commit が差分に現れる）/
  `host_exec:<ran|declined|refused>:<コマンド>`（host-exec plugin で sandbox の外に出した実行。ran は承認されて実行、declined は人間が拒否、
  refused は host-exec 自身の拒否パターン。`git -C <dir>` の値は飛ばし、インタプリタに渡したスクリプトはファイル名でまとめる）
- `host_exec` の型には `after_block`（同じ transcript で直前の Bash が sandbox / permission に拒否されていた件数）が付く。
  残りは Bash を試さずに host-exec へ行ったもの。代表例は `理由: <Claude が書いた reason> / $ <argv>`
- 各型に `count`・`sessions`（`sessionId` で数える）・`first_seen`・`last_seen`・`projects`・伏せ字済みの代表例（2 件まで）と
  その例が起きた cwd（`example_cwds`。`examples` と同じ順）、発生ごとの `occurrences`（`ts`・`cwd`（home 相対）・`git_branch`（transcript の `gitBranch`。無ければ null））が付く
- subagent の transcript と `isSidechain` の行、grep / cat 等の出力やファイル本文に拒否の文言が含まれていただけの行、
  依頼の文に書かれたコマンドやエラー文は数えない
- `request` は `` `! <cmd>` `` か、依頼の文言（「通常のターミナルで」「手元で」等）を含む発言のコードブロックの最初のコマンド行から数える。
  コードブロックが無いときのインラインコードは、依頼の文言と同じ文（`。`・`！`・`？`・改行で区切る）にあるものだけを数え、
  別の文のインラインコード（「手元でもテストは通っています」と `` `Closes #740` `` のような報告文）は依頼として数えない
- verify の「関係する commit」は、型の対象（ホスト・パスの一部・コマンド名）が差分に現れた commit か、commit message に書かれた commit。
  見るのは `configRepo.paths` と、発生の `cwd` が属する git repo（worktree は本体の repo にまとめる）の `.claude/settings.json`。
  発生した repo は履歴を読むだけで、cwd が存在しない・git repo でない発生はその突き合わせを飛ばす。
  evidence の commit には、どの repo の commit か（`repo`）が付く
- 全 repo の関係 commit の最新のものより後に発生が無ければ `resolved`、commit が無ければ `remaining`。
  後の発生があれば、発生ごとに `git_branch` がその repo の最新の関係 commit を含むか（含む / 含まない / 判定不能: branch が無い・detached・
  repo や関係 commit が無い）を判定し、`evidence.after_branches` に件数を載せる。すべて「含まない」なら `stale_branch`、
  1 件でも「含む」か「判定不能」があれば `remaining`。branch は今の先端で見る（発生後に修正を取り込んだ branch は「含む」になる）
- 対象が 1 語のコマンド名（`node` 等）の型は無関係な commit に当たるので突き合わせず `remaining` にする
- 設定の `intended` に `id` か `kind` が一致する型は、上の判定にかかわらず `intended` にする（先に書いた項目を優先し、`intended.reason` と
  一致の仕方 `intended.by` を付ける）。レポートでは resolved の後の `intended` 節に出す。`--no-verify` の run では付かない
- 型は数百件になることがある。レポートは件数順なので、Read の offset / limit で `remaining` 節を上から読む

## 判断手順（remaining の型ごと）

`--no-verify` のレポートの型は修正候補（remaining）として扱わない。対応済みかどうかが分からないので、
型の一覧と件数を示すだけにし、原因・修正案・issue 化は `configRepo` のある設定で `run` し直してから行う。

1. `ST config` の `criteriaFiles` を全部読む（追加の判定基準）
2. レポートの `remaining` 節を上から読む。verify の根拠の commit が型と無関係（文字列が偶然一致しただけ）なら、関係する commit なしとして扱う。
   後の発生に「修正を含む branch」が 1 件でもある型は再発として扱う。
   commit の後の発生が、commit より前に起動していた session だけなら（`first_seen` と commit 日時で判断）再発ではない可能性を書く
   - `stale_branch` 節の型には原因・修正案を出さない。「修正前の branch での発生」として型と件数を一覧に留める
   - `intended` 節の型にも原因・修正案を出さない。ただし同じ型が多くの session で繰り返すなら、エージェントが拒否を避ける手順
     （RULES 等）を知らない兆候として件数を添えて伝える
3. 型ごとに原因・修正案・安全性の評価を出す。`host_exec:ran:*` の型は振り分けてから出す。
   基準は判断基準のファイル（下記）の「型ごとに出すもの」「host_exec:ran:* の振り分け」「安全性の基準」
4. 結果をユーザーに表で示す（型 / 件数・最終発生 / 原因 / 修正案 / 安全性）。`stale_branch` の型は別の一覧（型 / 件数・最終発生）にする

### 判断基準のファイル

原因・修正案・安全性の評価・`host_exec:ran:*` の振り分け・安全性の基準・issue の候補の書き方・issue にしない型の分類は
`${CLAUDE_PLUGIN_ROOT}/sandbox-tune/scripts/criteria.md` にある。判断の前に必ず読む（日次ジョブの claude にも同じファイルを渡す）。

## issue 化（`--issue` のときだけ）

ユーザーが `--issue` を付けなかったら、ここは行わない（レポートと提案で終える）。

sandbox-tune は伏せ字・人の確認・公開範囲の判定までを受け持ち、issue は作らない。起票は dev-flow plugin の
`git-issue` に下書きを材料として渡して行う。下書きは候補の `ac` と `paths` から受け入れ基準と
`## 変更対象パス` の節を持ち、dev-flow の起票ゲート（AC の無い issue は analyze ゲートで止まる）をそのまま通る形になる。

**前提条件**: dev-flow plugin の `dev-flow:git-issue` が入っていること。使える skill に無ければ issue 化は行わず、
その旨をユーザーに伝えてレポートと提案で終える（sandbox-tune から直接 issue を作る経路は無い）。

1. ユーザーに issue にする型を選んでもらい、判断手順の結果を候補ファイルに書く（`$TMPDIR` に置く）:
   `{"candidates":[{"id":"<型の id>","title":"...","cause":"...","fix":"...","safety":"...","ac":["..."],"paths":["..."],"security":true|false}]}`。
   各フィールドの書き方（`ac` は検証できる形・`paths` は設定 repo の root 相対・`security` の付け方）は判断基準のファイルの「issue の候補の書き方」に従う
   - 欠けている・形が違うときは draft が理由を出して exit 2 で止まる。直して再実行する
2. 下書き（材料）を作る。本文は伏せ字を通して `claudedocs/sandbox-tune-issue-<n>.md` に書かれ、本文と digest が表示される
   ```bash
   ST draft --issue --analysis claudedocs/sandbox-tune-<日付>.json --candidates "$TMPDIR/candidates.json" --ids <id>[,<id>]
   ```
   - 提出先（`issue.repo`）が公開 repo なら（公開範囲を確かめられないときも同じ）、出どころが公開 repo と確かめられない
     代表例を載せず、`projects` にもその repo 名を出さずに件数だけを書く。出どころの repo は cwd の `origin` から gh で引き、
     git repo でない・`origin` が無い・gh が失敗するものは非公開として扱う。伏せ字は形しか見ず、取引先名・案件名のような
     固有名詞は止められないので、名前ではなく出どころの公開範囲で落とす。レポートと集計 JSON（ローカル用）の代表例は削らない
3. 表示された下書きをそのままユーザーに見せ、これを材料に issue 化してよいか確認を取る（AskUserQuestion）。確認なしに次へ進まない。
   伏せ字は形での判定なので、秘密が残っていないかもユーザーに見てもらう。直すなら候補ファイルを直して 2 からやり直す
4. 確認が取れた下書きだけを、表示された digest を付けて handoff に通す。issue は作らず、通ったら orchestrator に渡す引数を
   1 行の JSON `{"material":"<下書きの絶対パス>","repo":"owner/name","title":"...","labels":["..."]}` で出す
   ```bash
   ST handoff claudedocs/sandbox-tune-issue-<n>.md --digest <表示された digest> [--allow-public]
   ```
   - 下書きが表示後に変わっていた・伏せ字を通っていない文字列がある → exit 3
   - 提出先の公開範囲を確認できない → exit 4
   - 提出先が公開 repo なら警告し、ユーザーが `--allow-public` を付けたときだけ通す（無ければ exit 5）
   - **セキュリティ系の候補は公開 repo に渡さない**（`--allow-public` でも exit 5）。レポートに留めるか、
     非公開の報告先（GitHub の private security advisory 等）を案内する。経路を説明する本文を公開の場に書くこと自体が漏えいになる
   - **handoff が 0 以外で終わったら 5 には進まない**（orchestrator を呼ばない）
5. handoff が出した JSON の値をそのまま使って `dev-flow:git-issue` を呼ぶ（Skill ツール。labels は `,` で結合し、空なら `--labels` を省く）
   ```
   dev-flow:git-issue <material> --repo <repo> --title "<title>" [--labels <labels>]
   ```
   材料はすでに受け入れ基準と変更対象パスを持つ。orchestrator は ac-lint を通して起票する。材料の内容は書き足さずに渡す

## Exit

0 成功 / 2 引数・設定の誤り / 3 下書きが表示したものと違う / 4 提出先の公開範囲を確認できない / 5 引き渡しを拒否（公開 repo）
