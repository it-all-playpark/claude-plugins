# Stuck-Topic Dictionary

dev-flow の stuck 検出（dev-flow.js の blockSeen、dev-flow-evaluate.js の evalSeen、pr-iterate.js の
reviewSeen / securitySeen）は、`_lib/stuck-detector.mjs` の `stuckTopicKey` が `f.topic` から作るキーの
完全一致突合である。`stuckTopicKey` は problem-class 部分（最初の `::` より前）の表記ゆれ（大小文字・
空白・`_`・ハイフン）を吸収する。`<詳細>` 部分は trim と空白の圧縮だけで、大小文字を区別する。
同義語 rewrite は吸収しないため、本辞書で問題クラスを半構造化 enum に集約する。

なお `_lib/goal-ledger.mjs` の `topicKey`（`dimension::lowercase + 空白圧縮` 正規化）は
ledger の item dedup 用であり、stuck カウンタとは別機構である。

## 形式ルール

topic は `<problem-class>` 単独、または `<problem-class>::<詳細>` 形式で記述する。

- **problem-class**: 本辞書の enum から選ぶ。**辞書に該当クラスがあれば必ず enum 値を使う（自由作文禁止）**。
  該当なしのみ新語を kebab-case 英小文字で作る。
- **`<詳細>` suffix**: ファイルパス・関数名・AC index 等の**安定識別子**のみ（形容文を書かない）。
  `<詳細>` の stuck 突合は大小文字を区別するため、**kebab-case / 小文字 path 表記で統一**する
  （`<詳細>` の大小文字の揺れは stuck 検出を破る）。
- **再利用**: 同一問題は iteration を跨いで**同じ文字列を完全一致で再利用**する。

例: `input-validation-missing::create-user`、`test-missing::_lib/goal-ledger.mjs`

## 網羅基準

2 agent（evaluator / pr-reviewer）の checklist dimension で発生しうる
問題クラスを各 1 つ以上カバーする。新クラス遭遇時は新語使用 + 本辞書への追記を提案する（append-only）。

## Fallback

辞書が読めない環境では、従来通り安定した短い文字列を自作する（stuck 検出精度は落ちるが動作は壊れない）。

## Problem-Class Enum

| problem-class | 意味 | 主な検出元 | 例 |
|---|---|---|---|
| `scope-mismatch` | 要件の過不足・スコープ逸脱（実装が AC を超える / 足りない） | evaluator | `scope-mismatch::AC-3` |
| `yagni-violation` | 投機的機能・過剰実装（YAGNI 違反） | evaluator | `yagni-violation::_lib/foo.mjs` |
| `untestable-ac` | 受入条件が測定不能・検証困難（テスト不能な AC） | evaluator | `untestable-ac::AC-2` |
| `missing-file-reference` | 計画参照ファイルが実在しない | evaluator | `missing-file-reference::src/bar.ts` |
| `wrong-file-target` | 変更対象ファイルの取り違え（誤ったファイルを変更） | evaluator | `wrong-file-target::dev-flow.js` |
| `self-containment-violation` | task 記述の曖昧参照（「上述の通り」等、self-contained でない） | evaluator | `self-containment-violation::F3` |
| `edge-case-unhandled` | edge case の handling 未定義 / 未実装 | evaluator / pr-reviewer | `edge-case-unhandled::empty-input` |
| `error-handling-missing` | 異常系処理の欠落（エラー時のハンドリングなし） | evaluator / pr-reviewer | `error-handling-missing::read-file` |
| `input-validation-missing` | 入力検証漏れ（null / 型 / 範囲チェック欠如） | evaluator / pr-reviewer | `input-validation-missing::create-user` |
| `security-vuln` | 脆弱性（injection・権限昇格・SSRF 等） | pr-reviewer | `security-vuln::SQL-injection` |
| `secret-exposure` | credential / 機密の露出（ハードコード・ログ出力等） | pr-reviewer | `secret-exposure::API_KEY` |
| `logic-bug` | ロジック誤り・宣言意図との不一致（誤った条件分岐等） | evaluator / pr-reviewer | `logic-bug::resolve-gate-policy` |
| `regression` | 既存挙動の破壊（後退バグ） | evaluator / pr-reviewer | `regression::classify-shape` |
| `test-missing` | テスト欠落・カバレッジ穴 | evaluator | `test-missing::_lib/goal-ledger.mjs` |
| `test-weakening` | テスト弱体化（assert 削除・skip 追加・条件緩和） | evaluator / pr-reviewer | `test-weakening::gate-policy.test.mjs` |
| `test-not-asserting` | テストが非自明な assert をしていない（常に pass する等） | evaluator / pr-reviewer | `test-not-asserting::topic-dictionary-refs.test.mjs` |
| `performance-issue` | N+1・不要ループ・計算量超過等のパフォーマンス問題 | pr-reviewer | `performance-issue::find-all-files` |
| `naming-convention` | 命名・規約違反（kebab-case 違反・接頭辞漏れ等） | pr-reviewer | `naming-convention::topic-key` |
