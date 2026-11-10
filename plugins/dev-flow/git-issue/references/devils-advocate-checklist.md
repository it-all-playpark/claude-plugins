# Devil's-Advocate Checklist

起票前の issue 本文を、本文とこのチェックリストだけで判定するためのチェックリスト。本文に無い前提は補わない。

## Blocking Categories

Treat findings as `blocking` if any item below is true:
- Missing acceptance criteria or untestable acceptance criteria
- リスクのある変更（失敗すると既存の挙動やデータを壊しうる変更など）なのに、戻し方の要件が AC か `## 制約・取らないこと` に無い
  （要件は 1 行で書く。ロールバックの節は求めない — 節があると下の本文の節の項目で blocking になる）
- agent issue の AC が実行結果・出力・ログ・計測を観測しないと確かめられないのに
  （テストスイートやテストの入口スクリプトの green を含む）、
  実装を外すと落ちて実装で通るテストファイルを inline code で名指ししていない
  （dev-flow が観測型の人手 AC として `ac_human_pending` の HOLD で止める。
  代わりに、テストファイルと確かめる振る舞いを書くか、`human-task` の issue に切り出す。
  テストスイートの green は dev-flow の Validate が gate として確かめるので、AC にしない。
  コードとテストを読めば確かめられる AC はこの項目に当たらない）
- Security/privacy implications are ignored
- AC・制約が、PR が書き換えられる入力（CI workflow の結果・テストや script の stdout・AC や PR 本文の文面・PR 内の
  設定ファイル）を根拠に、merge gate・HOLD を外す、または検証（テストの再実行・evaluator の判定）を省くよう指示している。
  pipeline が自分で実行した結果でも、実行する中身（テスト・script）を PR が書けるなら PR が書き換えられる入力に当たる。
  gate 自身の判定より弱い実行（落ちたファイルだけの単体再実行など）の green で、その gate を外すのも同じ
  （dev-flow の security review は PR の作者を攻撃者と見るので、実装が指示どおりでも PR が差し戻される。全件実行のときだけ
  落ちるテストは単体再実行で green になる。根拠は PR が書き換えられない側（base の tree にある定義）に置くか、gate は
  外さずに開示だけにする）
- 直し方が症状の条件の分岐・ガード・入力の追加だけで、同じ型の別の症状が残る、または削除・統合で済む案を検討していない
  （同じ仕組みに入力やガードを 1 つずつ足す issue が続く。直し方は同じ型の別の症状まで消えるもの（削除・統合・一般化を
  含む）にする。広い範囲のリファクタにはせず、Phase 3 の Issue Splitting（1 つの目的 = 1 本、1 issue = 1 PR）で収める。
  SKILL.md の軽い経路ではこの項目に当たった issue はその場で直さず重い経路に切り替える）
- データや形式を変える変更（保存済みデータ・設定・API の形式）なのに、移行の要件が AC か `## 制約・取らないこと` に無い
  （移行の要件は、既存データの変換の要否と、後方互換を保たない変更の範囲）
- Dependency order is impossible or contradictory
- agent issue に `executor: human` タスクが残存している（agent 実行の計画・実装 issue に人手作業が混入。
  human 判定基準は SKILL.md の Executor Classification。human issue に切り出し、実装 issue は Blocked by で紐付ける）
- human タスクに完了確認方法が無い（human issue の `## 完了条件` が checkbox の観察可能な状態で書かれていない）
- 1 本の agent issue が 2 つ以上の目的（別の原因・別の直し方）を含む、または 1 本では dev-flow 1 run で走りきれないか
  1 PR でレビューできない大きさである（agent issue の単位は 1 つの目的 = 同じ原因を同じ直し方で直す変更のまとまりで、
  複数の finding・箇所・文書にまたがってよい。SKILL.md Phase 3 の Issue Splitting）
- agent issue に `## 変更対象パス` が無い（後続の並列起動判定の入力になる。書式は 1 行 1 エントリ
  `- <repo 相対パスまたは glob>`）
- agent issue 間の依存が循環している / 先行 issue の成果物を使うのに Blocked by が無い（起票はトポロジカル順で、
  先行 issue の番号を `--blocked-by` に渡す）
- agent issue の本文に調査結果・実装計画・テスト戦略・リリース/ロールバック・レビュー履歴の節がある、または
  AC 節と閉じたコードフェンスの中身を除いた本文の文章が 4000 字を超える（4000 字は本文の文章をゴールと境界条件に絞るための
  上限。閉じていないフェンスの中身は数える。分かったことは AC と `## 制約・取らないこと` に反映する）
- コードフェンスに仕様の例（モック・スキーマ・出力例など）以外の、調査結果や実装計画の文章が入っている
  （`create_issue.py` の字数検査はフェンスの中身を数えず、中身が仕様の例かも判定しない。文章はフェンスの外に出して 4000 字に収める）
- 見取り図か AC 早見表が AC または `## 変更対象パス` と食い違う（図に AC に無い構成の変化がある・AC にある構成の変化が図に無い・
  早見表の行が AC と件数か内容で対応しない）（人間は図と早見表を信じて AC を読まずに通すので、AC を正として照合する）
- 変更対象パスが 2 つ以上のファイルにまたがり、ファイル間の呼び出し・データの流れ・構成要素が増減または付け替わる変更なのに
  `## 見取り図` が無い（それ以外の変更では節が無くてよい）

## Loop Protocol

Blocking Categories の判定は本文を書いた本人が行わない（書き手は設計の正当化を知ったまま読むので、塞いでいない
経路を見落とす）。判定する役は `issue-plan-reviewer` agent で、渡すのは本文ファイルとこのチェックリストのパスだけ
（調査結果・会話・書き手の判断理由・前のラウンドの判定を渡さない）。spawn の形は SKILL.md の
「Blocking Categories の判定（issue-plan-reviewer）」。

1. Phase 4 の前に、Phase 3 の計画から SKILL.md Phase 5 と同じテンプレートで本文ファイルを書く。
2. 各ラウンドで、本文ファイルごとに、そのラウンドで新しく spawn した `issue-plan-reviewer` に Blocking Categories の
   項目ごとの判定（`blocking` / `non-blocking`）をさせる。
3. 書き手が `blocking` の項目を計画と本文ファイルで直す。修正は AC と `## 制約・取らないこと` に反映し、指摘と修正の履歴は
   issue 本文に書き写さない（ラウンド数と残った non-blocking の懸念は SKILL.md Output Contract の `## Plan Quality Gate` で返す）。
4. blocking が 0 になるか max rounds に達するまで 2・3 を繰り返す。
5. Phase 5 で本文を書き直したら、Phase 6 の前に最終の本文ファイルを新しく spawn した `issue-plan-reviewer` にもう 1 回
   判定させ、blocking があれば起票しない。

If max rounds reached with blocking findings remaining:
- Do not create issue.
- Return unresolved findings and required user decisions.

reviewer を spawn できない、または返り値が項目ごとの判定の形でないときも起票しない（書き手の自己判定で代えない）。
