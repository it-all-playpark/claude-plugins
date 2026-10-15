# Devil's-Advocate Checklist

Use this checklist to challenge the implementation plan before issue creation.

## Blocking Categories

Treat findings as `blocking` if any item below is true:
- Missing acceptance criteria or untestable acceptance criteria
- No rollback strategy for risky change
- Security/privacy implications are ignored
- Migration/data-change plan is missing where required
- Dependency order is impossible or contradictory
- Ownership is unclear for critical tasks
- agent issue に `executor: human` タスクが残存している（agent 実行の計画・実装 issue に人手作業が混入。
  human 判定基準は SKILL.md の Executor Classification。human issue に切り出し、実装 issue は Blocked by で紐付ける）
- human タスクに完了確認方法が無い（human issue の `## 完了条件` が checkbox の観察可能な状態で書かれていない）
- 1 本の agent issue が単独で merge できる成果物を 2 つ以上含む（dev-flow は 1 issue = 1 PR。SKILL.md Phase 3
  の Issue Splitting の分割基準で分ける）
- agent issue に `## 変更対象パス` が無い（後続の並列起動判定の入力になる。書式は 1 行 1 エントリ
  `- <repo 相対パスまたは glob>`）
- agent issue 間の依存が循環している / 先行 issue の成果物を使うのに Blocked by が無い（起票はトポロジカル順で、
  先行 issue の番号を `--blocked-by` に渡す）
- agent issue の本文に調査結果・実装計画・テスト戦略・リリース/ロールバック・レビュー履歴の節がある、または
  AC 節を除いた本文が 4000 字を超える（本文はゴールと境界条件だけ。分かったことは AC と `## 制約・取らないこと` に反映する）

## Review Dimensions

1. Product/Scope
- Is the problem statement falsifiable?
- Is scope bounded and non-goals explicit?
- Are open questions isolated from committed work?

2. Architecture
- Does the plan define interface boundaries?
- Are contracts backward compatible or migration-safe?
- Are failure modes and graceful degradation covered?

3. Security/Compliance
- Are authn/authz impacts addressed?
- Is sensitive data handling documented?
- Are audit/compliance constraints considered when relevant?

4. Operations/Infra
- Are deployment and rollback paths explicit?
- Is observability (logs/metrics/alerts) included?
- Are cost and reliability trade-offs acknowledged?

5. Delivery
- Are dependencies and phase order realistic?
- Are test levels (unit/integration/e2e) aligned to risk?
- Are owners and exit criteria assigned per phase?

## Loop Protocol

1. Produce a list of findings with severity (`blocking` or `non-blocking`).
2. For each blocking finding, propose a concrete correction.
3. Revise the plan. 修正は AC と `## 制約・取らないこと` に反映し、指摘と修正の履歴は issue 本文に書き写さない
   （ラウンド数と残った non-blocking の懸念は SKILL.md Output Contract の `## Plan Quality Gate` で返す）。
4. Re-run review until blocking findings are zero or max rounds reached.

If max rounds reached with blocking findings remaining:
- Do not create issue.
- Return unresolved findings and required user decisions.
