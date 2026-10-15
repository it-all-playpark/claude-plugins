---
name: sandbox-tune
description: >-
  Aggregates sandbox denials, permission denials, "please run this in your terminal" requests, and host-exec
  (out-of-sandbox) runs from Claude Code transcripts by type, checks them against the settings repo's git log (resolved / remaining),
  and proposes settings / wrapper / hook fixes with a safety review. Writes a local Markdown report; with --issue, hands
  human-confirmed drafts to dev-flow:git-issue for filing.
  Use when: (1) user asks why the agent keeps asking them to run commands, or which sandbox denials still recur,
  (2) user wants settings.json / excludedCommands / allowUnixSockets fix candidates backed by evidence,
  (3) user asks whether host-exec is being used for things settings should fix,
  (4) keywords: sandbox-tune, sandbox 拒否, Operation not permitted, EPERM, 人間に実行依頼, 通常のターミナルで, settings 修正, permission 拒否, host-exec.
  Accepts args: [--days N] [--no-verify] [--issue] [--allow-public]
---

# Sandbox Tune

transcript（`~/.claude/projects/<project>/<session>.jsonl`）から、繰り返し起きている拒否と人間への実行依頼を型にまとめ、
直すべきものだけを根拠付きで出す。`/fewer-permission-prompts` が扱う read-only の allow rule は対象外。

集計（collect）・突き合わせ（verify）・レポートはスクリプトが決定論で行う。あなたの仕事は remaining の型の原因・修正案・安全性の判断と、
`--issue` のときの下書きと確認。レポートはローカルに書くだけで、外部には何も送らない。

## 設定 (`<repo>/sandbox-tune.json`)

呼び出した repo（cwd）の `sandbox-tune.json`（`--config F` を渡したらそのファイル）を読む。
`run` は `configRepo` のある設定が要る。設定が無い・`configRepo` が無いときは何も書かずに exit 2 で止まる
（verify の無いレポートは、設定 repo で対応済みの型まで修正候補に見えるため）。
ユーザーが集計だけでよいと言ったときだけ `--no-verify` を付ける。設定ファイルを自分で作らない。

```json
{
  "configRepo": { "path": "~/src/dotfiles", "paths": ["claude/settings.json", "claude/bin", "claude/hooks"] },
  "criteriaFiles": ["~/src/dotfiles/claude/RULES.md"],
  "issue": { "repo": "owner/dotfiles", "template": "sandbox-tune-issue.md", "labels": ["sandbox"] }
}
```

| キー | 型 | 意味 |
|------|----|------|
| `configRepo.path` | 文字列（必須: configRepo を書くとき） | settings を管理している git repo。`run` の verify に使い、無ければ `run` は exit 2（`--no-verify` を除く） |
| `configRepo.paths` | 空でない文字列の配列 | verify で git log を見るパス（設定ファイル・wrapper・hook）。repo root 相対 |
| `criteriaFiles` | 文字列の配列 | 安全性の判定に加える基準のファイル（個人の運用ルール等）。必ず読む |
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
- 期間は既定 30 日。ユーザーが `--days N` を渡したらそのまま渡す

### 集計の決まり（スクリプトが守っていること）

- 型は「拒否された対象」で分ける: `sandbox:path:<書き込み先>` / `sandbox:unix_socket:<path>` / `sandbox:network:<host>` /
  `sandbox:command:<コマンド>`（対象が出ない拒否）/ `sandbox:launch_services:<コマンド>`（`open` 等の `-10822`）/
  `request:request:<コマンド>`（人間への実行依頼）/ `permission:<kind>:<tool> <対象>`（kind は permission-rule / hook / automode-blocked / user-rejected /
  worktree-guard 等。worktree-guard はコマンドの形で拒否するのでコマンド名で割らず `Bash *` の 1 型）/
  `host_exec:<ran|declined|refused>:<コマンド>`（host-exec plugin で sandbox の外に出した実行。ran は承認されて実行、declined は人間が拒否、
  refused は host-exec 自身の拒否パターン。`git -C <dir>` の値は飛ばし、インタプリタに渡したスクリプトはファイル名でまとめる）
- `host_exec` の型には `after_block`（同じ transcript で直前の Bash が sandbox / permission に拒否されていた件数）が付く。
  残りは Bash を試さずに host-exec へ行ったもの。代表例は `理由: <Claude が書いた reason> / $ <argv>`
- 各型に `count`・`sessions`（`sessionId` で数える）・`first_seen`・`last_seen`・`projects`・伏せ字済みの代表例（2 件まで）と、
  発生ごとの `occurrences`（`ts`・`cwd`（home 相対）・`git_branch`（transcript の `gitBranch`。無ければ null））が付く
- subagent の transcript と `isSidechain` の行、grep / cat 等の出力やファイル本文に拒否の文言が含まれていただけの行、
  依頼の文に書かれたコマンドやエラー文は数えない
- verify の「関係する commit」は、型の対象（ホスト・パスの一部・コマンド名）が差分に現れた commit か、commit message に書かれた commit。
  見るのは `configRepo.paths` と、発生の `cwd` が属する git repo（worktree は本体の repo にまとめる）の `.claude/settings.json`。
  発生した repo は履歴を読むだけで、cwd が存在しない・git repo でない発生はその突き合わせを飛ばす。
  evidence の commit には、どの repo の commit か（`repo`）が付く
- 全 repo の関係 commit の最新のものより後に発生が無ければ `resolved`、commit が無ければ `remaining`。
  後の発生があれば、発生ごとに `git_branch` がその repo の最新の関係 commit を含むか（含む / 含まない / 判定不能: branch が無い・detached・
  repo や関係 commit が無い）を判定し、`evidence.after_branches` に件数を載せる。すべて「含まない」なら `stale_branch`、
  1 件でも「含む」か「判定不能」があれば `remaining`。branch は今の先端で見る（発生後に修正を取り込んだ branch は「含む」になる）
- 対象が 1 語のコマンド名（`node` 等）の型は無関係な commit に当たるので突き合わせず `remaining` にする
- 型は数百件になることがある。レポートは件数順なので、Read の offset / limit で `remaining` 節を上から読む

## 判断手順（remaining の型ごと）

`--no-verify` のレポートの型は修正候補（remaining）として扱わない。対応済みかどうかが分からないので、
型の一覧と件数を示すだけにし、原因・修正案・issue 化は `configRepo` のある設定で `run` し直してから行う。

1. `ST config` の `criteriaFiles` を全部読む（追加の判定基準）
2. レポートの `remaining` 節を上から読む。verify の根拠の commit が型と無関係（文字列が偶然一致しただけ）なら、関係する commit なしとして扱う。
   後の発生に「修正を含む branch」が 1 件でもある型は再発として扱う。
   commit の後の発生が、commit より前に起動していた session だけなら（`first_seen` と commit 日時で判断）再発ではない可能性を書く
   - `stale_branch` 節の型には原因・修正案を出さない。「修正前の branch での発生」として型と件数を一覧に留める
3. 型ごとに次の 3 つを出す
   - **原因**: 何が何を拒否したか（sandbox の書き込み・socket・ネットワーク、permission rule、hook、classifier）。代表例の文から言い切れることだけ書く
   - **修正案**: settings のキー（`sandbox.filesystem.allowWrite` / `sandbox.network.allowUnixSockets` / `sandbox.excludedCommands` / `permissions.allow` 等）、
     wrapper、hook、手順の変更のいずれか。設定 repo のどのファイルのどこを変えるかまで書く
   - **安全性の評価**: 下の基準それぞれに照らして可否を書く。基準に反する修正案は出さず、手順の変更（作業場所を変える等）を代わりに出す
4. `host_exec:ran:*` の型は、承認が形骸化しないよう次のどれかに振り分ける（理由は代表例の reason と `after_block` から言える範囲で書く）
   - **組み込み保護**: 起動元 repo の `.git`・`~/.claude/projects` 等、設定で外せないもの。一回限りなら host-exec のままでよい
   - **settings で直す**: sandbox の書き込み・socket・ネットワーク許可で Bash から通せるもの。上の修正案・安全性と同じ手順で出す
   - **手順で直す**: `after_block` が 0 で、同じことが Bash で通る見込みがあるもの（reason が思い込みで、Bash を試していない）や、
     作業するセッション・場所を変えれば要らないもの。手順・ルールの変更を出す
   - **一回限り**: repo の移動など再発しないもの。修正案なし
   同じ型が複数 session で繰り返すなら、組み込み保護以外は直す対象として扱う
5. 結果をユーザーに表で示す（型 / 件数・最終発生 / 原因 / 修正案 / 安全性）。`stale_branch` の型は別の一覧（型 / 件数・最終発生）にする

### 安全性の基準

- sandbox の外で動かす設定（`excludedCommands` 等）に足してよいのは、**sandbox 内から書き換えられない場所にある実体だけ**。
  書ける場所（repo の作業ツリー・worktree・`$TMPDIR` 等）のスクリプトや、任意のファイルを実行するランナー（`bash <path>`・テストランナー等）は不可。
  書き換えて sandbox の外で実行できる脱出口になる
- 前方一致の glob で引数を絞る形（例 `cmd -x *`）は、後ろに option を足して迂回できるので**安全策として扱わない**
- 他プロセスの環境変数や資格情報を読める経路（`ps e`・`/proc/*/environ`・keychain・資格情報ファイル等）を sandbox の外に開けない
- Unix socket の許可は個別のパスで行い、全許可（`allowAllUnixSockets` 等）は使わない
- `criteriaFiles` の基準も同じ重みで適用する

## issue 化（`--issue` のときだけ）

ユーザーが `--issue` を付けなかったら、ここは行わない（レポートと提案で終える）。

sandbox-tune は伏せ字・人の確認・公開範囲の判定までを受け持ち、issue は作らない。起票は dev-flow plugin の
`git-issue` に下書きを材料として渡して行う。下書きは候補の `ac` と `paths` から受け入れ基準と
`## 変更対象パス` の節を持ち、dev-flow の起票ゲート（AC の無い issue は analyze ゲートで止まる）をそのまま通る形になる。

**前提条件**: dev-flow plugin の `dev-flow:git-issue` が入っていること。使える skill に無ければ issue 化は行わず、
その旨をユーザーに伝えてレポートと提案で終える（sandbox-tune から直接 issue を作る経路は無い）。

1. ユーザーに issue にする型を選んでもらい、判断手順の結果を候補ファイルに書く（`$TMPDIR` に置く）:
   `{"candidates":[{"id":"<型の id>","title":"...","cause":"...","fix":"...","safety":"...","ac":["..."],"paths":["..."],"security":true|false}]}`。
   秘密・資格情報・他プロセスの情報が sandbox の外から読める経路などに関わる候補は `security: true` にする
   - `ac`（必須・空でない文字列の配列）: 受け入れ基準。1 要素 1 項目で、**検証できる形**に書く
     （どのコマンドがどう終わるか・設定のどのキーに何があるか等。「改善する」「確認する」のような判定できない書き方はしない）
   - `paths`（必須・空でない配列）: 修正で触る、設定 repo の root 相対パスか glob（例 `claude/settings.json`・`claude/bin/**`）。
     `/` 始まりと `..` セグメントは不可
   - 欠けている・形が違うときは draft が理由を出して exit 2 で止まる。直して再実行する
2. 下書き（材料）を作る。本文は伏せ字を通して `claudedocs/sandbox-tune-issue-<n>.md` に書かれ、本文と digest が表示される
   ```bash
   ST draft --issue --analysis claudedocs/sandbox-tune-<日付>.json --candidates "$TMPDIR/candidates.json" --ids <id>[,<id>]
   ```
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
