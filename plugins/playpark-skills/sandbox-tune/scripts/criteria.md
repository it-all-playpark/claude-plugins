# sandbox-tune の判断基準

remaining の型を判断するときの基準。対話の `/sandbox-tune`（SKILL.md の判断手順）と、日次ジョブ（daily.sh）が
ツールなしの LLM に渡すプロンプトの両方がこのファイルを読む。設定の `criteriaFiles` の基準も同じ重みで適用する。

## 型ごとに出すもの

- **原因**: 何が何を拒否したか（sandbox の書き込み・socket・ネットワーク、permission rule、hook、classifier）。代表例の文から言い切れることだけ書く
- **修正案**: settings のキー（`sandbox.filesystem.allowWrite` / `sandbox.network.allowUnixSockets` / `sandbox.excludedCommands` / `permissions.allow` 等）、
  wrapper、hook、手順の変更のいずれか。設定 repo のどのファイルのどこを変えるかまで書く
- **安全性の評価**: 下の「安全性の基準」それぞれに照らして可否を書く。基準に反する修正案は出さず、手順の変更（作業場所を変える等）を代わりに出す

## host_exec:ran:* の振り分け

承認が形骸化しないよう次のどれかに振り分ける（理由は代表例の reason と `after_block` から言える範囲で書く）。
同じ型が複数 session で繰り返すなら、組み込み保護以外は直す対象として扱う。

- **組み込み保護**: 起動元 repo の `.git`・`~/.claude/projects` 等、設定で外せないもの。一回限りなら host-exec のままでよい
- **settings で直す**: sandbox の書き込み・socket・ネットワーク許可で Bash から通せるもの。修正案・安全性と同じ手順で出す
- **手順で直す**: `after_block` が 0 で、同じことが Bash で通る見込みがあるもの（reason が思い込みで、Bash を試していない）や、
  作業するセッション・場所を変えれば要らないもの。手順・ルールの変更を出す
- **一回限り**: repo の移動など再発しないもの。修正案なし

## 安全性の基準

- sandbox の外で動かす設定（`excludedCommands` 等）に足してよいのは、**sandbox 内から書き換えられない場所にある実体だけ**。
  書ける場所（repo の作業ツリー・worktree・`$TMPDIR` 等）のスクリプトや、任意のファイルを実行するランナー（`bash <path>`・テストランナー等）は不可。
  書き換えて sandbox の外で実行できる脱出口になる
- 前方一致の glob で引数を絞る形（例 `cmd -x *`）は、後ろに option を足して迂回できるので**安全策として扱わない**
- 他プロセスの環境変数や資格情報を読める経路（`ps e`・`/proc/*/environ`・keychain・資格情報ファイル等）を sandbox の外に開けない
- Unix socket の許可は個別のパスで行い、全許可（`allowAllUnixSockets` 等）は使わない
- `criteriaFiles` の基準も同じ重みで適用する

## issue の候補の書き方

候補は `{"id","title","cause","fix","safety","ac","paths","security"}` の object。

- `id`: 型の id をそのまま書く
- `title`: issue のタイトル。何をどう直すかを 1 行で書く
- `cause` / `fix` / `safety`: 上の「型ごとに出すもの」の原因・修正案・安全性の評価
- `ac`（空でない文字列の配列）: 受け入れ基準。1 要素 1 項目で、**検証できる形**に書く
  （どのコマンドがどう終わるか・設定のどのキーに何があるか等。「改善する」「確認する」のような判定できない書き方はしない）
- `paths`（空でない配列）: 修正で触る、設定 repo の root 相対パスか glob（例 `claude/settings.json`・`claude/bin/**`）。
  `/` 始まりと `..` セグメントは不可
- `security`: 秘密・資格情報・他プロセスの情報が sandbox の外から読める経路などに関わる候補は `true`

## issue にするか

原因と、安全性の基準を満たす修正案を言い切れる型を issue の候補にする。それ以外は次のどれかに分類して issue にしない。

- **intended**: 意図した拒否（permissions.deny・組み込み保護・人間がやると決めた操作等）。設定の `intended` に足す候補
- **noise**: 集計の誤検出（報告文を依頼と数えた等）や、一回限りで再発しないもの
- **unclear**: 代表例だけでは原因か安全な修正案を言い切れないもの
- **merged**: 別の型と同じ原因で、その型の候補にまとめたもの（理由にまとめた先の型の id を書く）
