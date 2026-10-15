# GitHub Issue Template (Japanese Default)

デフォルト（`--lang` 未指定）はこの日本語テンプレートを使う。`--lang en` のときのみ英語化する。

```markdown
## ゴール
[誰が何に困っていて、この issue で何ができるようになるか。完了した状態を 1〜3 文で]

## なぜ
- [今対応する理由を 2〜4 行で。議論ソース: link or file]

## 受け入れ基準（Acceptance Criteria）
- [ ] AC-1 ...
- [ ] AC-2 ...
- [ ] AC-3 ...

## 制約・取らないこと
- [守る不変条件・変えてはいけない挙動]
- [スコープ外にするもの（非目標）]

## 変更対象パス
- <repo 相対パスまたは glob>

## 未解決事項（Open Questions）
- ...
```

本文はゴールと境界条件（何を満たせば完了か・何をしてはいけないか）だけを書く。implementer（dev-flow）は
コードを読んで自分で実装計画を立てるので、issue 側の手順は重複し、ずれていれば実装を縛る。

品質基準:
- 各セクションは具体的かつ検証可能に書く。
- 「性能改善」などの曖昧表現は避け、指標/閾値を明記する。
- 専門観点の調査結果（Frontend/Backend/Infra）・実装計画・テスト戦略・リリース/ロールバック・
  悪魔の代弁者のレビュー履歴は節として書かない。そこで分かったことは AC か `## 制約・取らないこと` の 1 行に反映する
  （例: ロールバック手段が要る → 「旧経路を残す」を制約に、テストで守るべき挙動 → AC に）。
- AC 節を除いた本文は 4000 字以内（dev-flow の analyze はそれを超えた部分を切り、implementer に届かない）。
  `create_issue.py --kind agent` は超えた本文の起票を拒否する。

## 変更対象パス

実装 issue（上のテンプレート）は `## 変更対象パス` が必須。書式は 1 行 1 エントリ `- <repo 相対パスまたは glob>`
（SKILL.md の Phase 3「変更対象パス」と同じ）。`/` 始まりのエントリと `..` セグメントを含むエントリは書かない。
`create_issue.py --kind agent` は、欄が無い・エントリ 0 件・`/` 始まり・`..` セグメントのいずれかで起票を拒否する。
計画時点の見積もりであり、後続の並列起動判定はこの欄を「触る範囲の申告」として保守的に扱う。
human issue テンプレートには不要。

## executor（実行者）

各タスクに `executor: agent` か `executor: human` のどちらかを必ず付ける。human マーカーは固定文字列
`executor: human`（SKILL.md の Executor Classification と同じ文字列。言い換えない）。

human 判定基準（いずれかを要するタスクは `executor: human`）:

1. 外部サービスの管理画面操作・アカウント作成
2. secret・API キーの発行と登録
3. DNS・課金・契約
4. 顧客への確認・承認
5. 本番データの手作業操作
6. 実機での手動確認

基準外は `executor: agent`（既定）。executor は SKILL.md Phase 3 の計画上のタスクに付ける。実装 issue
（上のテンプレート）は `executor: agent` のタスクだけを扱い、`executor: human` のタスクは下の human issue
テンプレートで別 issue に切り出し、先に起票する（`create_issue.py --kind agent` は本文に `executor: human` が
残っていると起票を拒否する）。

## human issue テンプレート

`create_issue.py --kind human` で起票する（`human-task` ラベルが付く）。`## 手順` と、checkbox 付きの
`## 完了条件` は必須（無いと起票を拒否する）。

```markdown
## 背景
- 元の議論 / 実装 issue の目的:
- executor: human
- なぜ人手か: [human 判定基準のどれに当たるか]

## 手順
1. ...
2. ...

## 完了条件
- [ ] [完了を人が確認できる観察可能な状態。例: `API_KEY` が repository secret に登録されている]

## 後続 issue
- [この issue の完了を待つ実装 issue。実装 issue 側に `Blocked by #<この issue>` が付く]
```
