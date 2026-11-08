# analyze-issue（issue の取得と決定論 parse）

`analyze-issue`（`bin/analyze-issue` → `dev-flow/scripts/analyze-issue.sh`）は GitHub issue を取得し、
分析 JSON を stdout に出す exec-proxy。issue の取得は script の中で行う — 呼び出し側は issue を先に
取得せず、コマンドに redirect / pipe / `cd`・`bash`・env 前置 / `&&` 連結を付けない。

dev-flow の通常経路では prerun（`dev-flow/scripts/prerun-analyze.sh`）が `--contract` で呼び、その出力から
Setup 末尾の analyze ゲートが読む `args.setup.analyze` を組む。ゲートが引いたときだけ
`analyze-clarify#<issue>`（dev-runner）が `--depth comprehensive --dump-body <path>` で issue を読み直し、
質問文を起こす。

本ファイルは出力の意味と、判定できないときの fail-closed の扱いだけを書く。オプション・出力キーの一覧・
本文の切断上限と切断マーカーの文言・AC 見出しの許容表記・breaking キーワードは `analyze-issue.sh` が、
Jev に聞く質問・comment の分類・確信の閾値は `prerun-analyze.sh`（冒頭コメントとコード）が正で、ここには
写さない — 写しは script を変えるたびにずれる。

## prerun が読む出力の意味

`--contract` の出力のうち prerun が読むのは、次の意味を持つ生シグナル:

- **要件**: AC 節の項目（`acceptance_criteria`）と、AC 節を含む本文の全文（`issue_body`。切らない）。AC 見出しが
  許容表記に一致しないときは `acceptance_criteria` を空のまま、その見出し行を `ac_heading_near_miss` に載せる
- **互換性の手がかり**: title + body の決定論 keyword scan（`breaking_keyword_scan`）と、title の
  conventional prefix の `!`（`title_breaking_marker`）
- **comment**: `comments`（各 comment の author・`author_association`・作成時刻・本文）と件数、issue 報告者
  （`issue_author`）、issue の最終更新時刻（`issue_updated_at`。comment の後に body が編集されたかの
  前後関係に使う）

prerun はこれを決定論で処理し、下記の判定だけを Jev に回して、ゲートに渡す
`comment_overrides` / `comment_conflicts` / `uncertain` / `breaking_change` を組む。AC の観測型判定は prerun では行わない
（下記「観測型 AC の判定」）。

## prerun が Jev に回す理由

決定論の parse では次の 2 つを判定できない: 互換性に関わる語が title / body にあるときに非互換な変更・
既存データの変換が本当に要るか、comment が body の要件を訂正しているか。
LLM に issue を転写させて読ませる工程は持たず、この 2 つだけを Jev に回す。Jev は有界な確率だけを返す
判定モデルなので、確率を閾値で決定論の値に落とし、確信の無い判定は人間へ返す（下記の fail-closed）。
転写する工程が無いので、転写事故を突き合わせる工程（取得元の突合・comment 件数の突合・切断時の再実行）も
持たない。

どの入力を Jev に回すか、質問文、分類、閾値は `prerun-analyze.sh` が持つ。

互換性の判定は、issue body に `uncertain` の指示どおりの明記行（後方互換を保たない変更の有無・既存データの
変換の要否）が 2 行とも規定の値で書かれていれば Jev に回さず、その値で決める。issue body は dev-flow の要件の
出所で PR の作者が書き換えられる入力ではないので、作者の宣言として採る — 明記しても Jev の確率が閾値に届かず、
指示に従っても `uncertain` が解けないため。明記と本文の他の記述の食い違いは推定しない。

残余リスク: 互換性に関わる語を含まない実質的な非互換変更は Jev にも回らず、realized diff の danger-grep と
merge tier が補償する（意図的な設計判断）。

## 判定できないときの fail-closed

判定できない入力を「問題なし」と同一視しない。analyze ゲートは AC 空・`comment_conflicts` 非空・
`uncertain` 非空のどれかで needs_clarification に倒し、人間に返す。

- prerun の analyze 段の失敗（issue を取得できない・JSON 不正・本文ファイルを書けない・blocker を読めない）は `ok:false` で返り、
  ゲートは spawn せず needs_clarification で終える
- Jev が応答しない・低確信・無効（未導入・`DEVFLOW_JEV_DISABLE=1`）の互換性と comment の判定は
  `uncertain` に、権限の無い override・conflict・低確信の comment は `comment_conflicts` に積む。決定論は
  意味的な矛盾をどちらに解くべきか判定できず、LLM に黙って片方を採らせると、訂正が実装に反映されないまま
  進む

## 観測型 AC の判定

AC が観測型（コードとテストを読むだけでは確かめられず、実行した結果・ログ・計測を観測しないと確かめられない）かは、
ゲート通過後に全 AC を AC の文面と issue タイトルだけを読む分類 agent（`ac-observational#<issue>`）に 1 回で渡して決める。
正規表現や Jev で候補を絞らない — 絞り込みが取りこぼした観測型 AC は agent に回らず「観測型でない」で確定し、evaluator の
コード読みで達成扱いになるため。

- agent が null を返した AC・応答に無い AC・agent 自体が失敗した run は、その AC を観測型として扱う（`uncertain` には積まない）。
  観測型への誤判定は人手 AC 待ちの HOLD で止まるだけだが、逆は evaluator のコード読みだけで達成扱いになる
- 同じ agent は、AC が inline code で指定した検証コマンド（`verify_command`）と生成されるファイル（`expect_paths`）も返す。
  AC の inline code と完全一致するものだけをゲートで凍結し、観測型で文面上の actor が human / ci でない AC についてだけ
  workflow が local-verify で実行して、失敗は dev-implementer へ差し戻し、最終 tree の exit 0 は
  人手 AC の確認材料として終端サマリーに開示するだけにする（actor は human のまま。exit 0 で HOLD を外さない — 実行される
  中身は PR が書き換えられる）。LLM が組み立てた・言い換えたコマンドは実行しない（実行するものを AC の文面に縛り、
  実装後に書き換えられないようにする）

## comment の override 判定に使う `author_association` / `issue_author`

`author_association` は `gh` の `authorAssociation` を verbatim 転写し、`issue_author` は issue 報告者の
login。prerun はこの 2 つで、Jev が override と判定した comment を `comment_overrides` に採るかを決定論で
決める（issue 報告者本人か、repo の権限を持つ投稿者に限る）。権限の無い override は `comment_conflicts` に
入る。

これは fail-closed の一部: public repo では誰でも comment を書けるので、権限で絞らないと任意の外部
comment が issue body から抽出した要件を黙って上書きできる。`author` / `author_association` /
`issue_author` は取得できない場合も `null` ではなく `""` を返す。空文字列は「不明」であって一致ではない
ため、override 採用の判定材料にならない。

`comments` キーが無い / 配列でない取得結果は「comment 0 件」と同一視せず、`analyze-issue.sh` が非 0 で
落ちる（prerun は `ok:false`）— 取得の欠落を comment 無しとして通すと、comment による訂正の読み落としが
黙って起きる。

## 本文の全文の渡し方

prerun（`dev-flow-prerun`）は本文の全文を長さに関わらず `<worktree>/.devflow-tmp/issue-body.md` へ byte 一致で
書く（`.devflow-tmp` の clean の後なので、再利用 worktree の再実行では最新の本文になる）。dev-implementer は
このファイルを最初に Read し、互換性の明記行の判定と Jev の互換性・comment の判定は全文を入力にする。

`args.setup.analyze` と REQ には本文・`scope` を載せない。`setup` は wrapper の LLM が Workflow の `args` へ
書き写すので、載せると LLM に issue を転写させることになる。AC の採点軸は `acceptance_criteria` のままで、
本文ファイルは実装中に書き換えられるので判定の根拠にしない。本文は `jq --arg` などの argv で渡さない
（Linux の 1 引数 128KiB 上限で落ちる）。

## 本文の切断

`scope` / `body_preview` は context 予算のために上限で切る（読むのは `analyze-clarify`）。切断は黙って行わない:
切った抜粋の末尾にマーカーを付け、加えて切断の boolean と総文字数を常時出力する。`--dump-body <path>` を付けた
呼び出しは、切断があったときだけ body 全文をそのファイルに書いて `body_dump_path` に返す（無ければ `null`）。
`analyze-clarify` はそのファイルを Read してから要件を読み、issue を再取得しない。

切断が黙っていると、issue 末尾に書かれた確定仕様が抜粋の外へ落ち、それを読めない analyze が
needs_clarification を返し続ける。人間が回答を追記するほど末尾に押し出されて悪化する。
