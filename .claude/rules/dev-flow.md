---
description: dev-flow / pr-iterate / dev-flow-health の不変条件（fail-closed の理由・正当化クラス・起動形の制約）。詳細は plugins/dev-flow/dev-flow/references/
paths:
  - "plugins/dev-flow/.claude/workflows/**"
  - "plugins/dev-flow/agents/**"
  - "plugins/dev-flow/.claude/agents/**"
  - "plugins/dev-flow/_lib/**"
  - "plugins/dev-flow/_shared/**"
  - "plugins/dev-flow/dev-flow/**"
  - "plugins/dev-flow/dev-flow-health/**"
  - "tools/**"
---

# dev-flow 不変条件

モデル世代で変わらない不変条件だけを置く。詳細は `plugins/dev-flow/dev-flow/references/`:

- `pipeline.md` — phase 経路 / shape / model / isolation probe / gate_policy
- `telemetry.md` — telemetry キー一覧
- `exec-proxy.md` — 起動形・argv 転写・失敗ポリシー表
- `analyze-issue.md` — analyze-issue の出力キー
- `capability-bound.md` — モデル・harness の能力しだいの判断と sunset トリガ

## 構造

- Claude 専用（workflow 依存）。cross-vendor 放棄は dev-flow / pr-iterate のみ
- skill wrapper が isolation preflight → `Workflow({ name: 'dev-flow:dev-flow-run' })`。orchestration と中間 state は workflow script の JS 変数のみ
- `meta.name` は `dev-flow-run` でも telemetry handoff の `skill` は `'dev-flow'` 固定（集計連続性）
- `agent()` の agentType は `nsAgentOpts()` でのみ namespace 付与（bare 名は起動直後 abort）。routing test は論理名（bare）を保持。dev-flow-canary.js のみ namespaced id 直書き
- 1 issue = 1 PR。Implement は全 shape で `dev-implementer`（plan+impl 統合）を単一 worktree に 1 spawn（Plan phase・planner ⇄ reviewer ループ・parallel fan-out は持たない）。BLOCKED 再実装・green-fix・Evaluate 差し戻しも同じ agent
- model 既定は frontmatter。override は green-fix（`'sonnet'`）のみ（pr-iterate の fix は `pr-fixer` の frontmatter）。品質ゲート agent には渡さない — gate の判定モデルを credit で黙って変えない
- merge は常に人間（全 tier）
- 後方互換 scaffolding を作らない — out-of-enum は明示 error
- worktree の後片付けは `worktree-teardown`

## ゲート（fail-closed / fail-safe の理由）

- 軸A invariant: deterministic oracle / seed / critical は全 gate_policy で blocking。danger-grep の fail-closed と決定論ゲートを policy で緩めない。記録専用 telemetry は gate 入力にしない
- Merge tier は pr-iterate の後（fix 後の最終 tree で danger 再 reconcile）。fixes_applied>0 は Final reconcile で test 再実行、red / 再検証不能は HOLD（PR head sha に pin した CI 決定論判定でのみ代替）。例外は flake だけ: `failed_files` 非空の red は落ちたファイルだけ 1 回再実行し、exit code が green なら flake（`final_test_flaky` に記録・HOLD 理由にしない）。全件・2 回目の再実行と LLM 判定はしない（繰り返すほど本物の red を通す）
- danger-grep 失敗は fail-closed（全 SEC seed unchecked → HOLD）。realized-diff / redgreen / final-reconcile / final-ac-reconcile / issue-labels の失敗は fail-safe（安全側 floor・HOLD）。advisory 信号（ci-checks / structural / vdelta / post-comment / clock / pr-meta）は fail-open。理由: 決定論 gate の入力不明を通過と同一視しない
- analyze ゲート（Setup 末尾）は prerun の決定論 analyze（`analyze-issue --contract` + Jev）の検証とゲートのみ。spawn は引いたら `analyze-clarify#N`、通過後に観測型 null の AC があれば `ac-observational#N` の 1 回ずつ。LLM に issue を転写させる経路を戻さない。AC 空 / comment_conflicts 非空 / uncertain 非空は needs_clarification で終端（決定論は意味的矛盾の要否を判定できず、LLM に黙って片方を採らせると訂正が実装に反映されない）
- empty-diff gate は fail-closed（cross-repo は人間ラベル opt-in + 決定論 dirty 検証が揃った場合のみ graceful 終端）
- block_class は `approach_mismatch` / `guard_blocked` の閉じた enum。guard_blocked は replan ループから除外し evaluator focus へ直行
- isolation probe: `written:false` は fail-closed（throw。回避手順は pipeline.md）。probe 自体の失敗は fail-open。`bgIsolation:"none"` による guard 無効化は採らない（共有 checkout 汚染は blast-radius。設定緩和で sunset しない）
- telemetry は Stop hook が `--telemetry-json` 一本で journal へ渡す（キー別 flag・検証は持たない）。workflow が書くキーは telemetry.md の一覧に限る（`_lib/telemetry-keys.test.mjs` が pin）。読み手の無いキーを足さない — 読まれない値の計算・転記コードが残るため

## 正当化クラス（W7）

- distrust 機構と agent への指示は下のクラスか capability-bound を宣言する（無いと撤去判断ができない）
- **incentive-structural**（永続。勝利宣言の self-judge と moving target を断つ。賢いモデルほど巧妙に逸脱する）: frozen target（`evalSeen` / `blockSeen` / `reviewSeen`）・stuck 打ち切り（`EVAL_STUCK` / `REVIEW_STUCK`）・critical の append と severity `floor`・hard cap（`EVAL_MAX` / `GREEN_MAX` / `BLOCK_MAX` / `DESIGN_REPLAN_MAX` / `AGENT_AC_REIMPL_MAX`）・guard_blocked の replan 除外・blocking_reason 決定論スクラバー（`scrubBlockingDetail`）・review-finding 決定論スクラバー（`scrubReviewFindingText`。finding の文を fix prompt へ verbatim に流さない）
- **指示の incentive-structural**（永続。逸脱が optimization pressure・context 分断由来）: self-judge 禁止・feedback 全件対応・self-contained 記述・topic 反復でアプローチ変更
- **blast-radius**（永続。不可逆性・accountability で正当化）: human merge・danger-grep → security path・seeded SEC と HOLD・pr-iterate の critical/major-always-blocks・Final reconcile・TESTSURF seeding・lite route の critical/major で昇格・health の status 判定は `health-report.sh` だけ・sunset 昇格は人間 merge 経由
- **contract**（永続・指示）: 出力 schema・StructuredOutput 義務・Boundary など呼び出し側が依存する指示
- 敵対的 security review: critical/major 0 件まで LGTM にしない gate は blast-radius。incentive-structural: 許可リストで対象判定（判定不能・一度対象は対象）・毎回新 spawn・`reviewed_sha` 一致で clear・PR の文はデータ・公開は件数・`reviewer_context_changed`・Codex 中継（hook で縛る）の判定不能で停止。許可リスト拡大は非読込・非実行を示してから
- 上の 3 クラスはモデル更新で撤去しない。capability-bound の判断は `capability-bound.md` にだけ置く

## exec-proxy（起動形の制約）

- script は `bin/` の bare 名を**先頭トークン**にする。絶対パス・`bash`/`cd`/env 前置は書かない
- dev-flow の `bin/` は sandbox 内で動かし excludedCommands に登録しない（子の hook・テストが sandbox 外で走る。blast-radius）
- 起動元 repo の `.git/config` を書く git / gh（`push -u`・`--track`・`gh pr checkout`）を使わない（sandbox 内で書けない）

> exec-proxy スクリプトは認証付き network I/O（gh・git push）を内部に持ってはならない（例外は 2 つ:
> `analyze-issue` は issue 取得の bare `gh issue view` を内蔵し stdout を in-process で受ける。呼び出し元は
> subagent ではなく prerun（`dev-flow-prerun` → `prerun-analyze.sh`）で、Jev もそこから呼ぶ。
> `pr-push` は PR phase の push 1 回を内蔵し全文を log に残して末尾だけ返す — 長い hook 出力の末尾を落とさない）。GitHub I/O は subagent の Bash で「先頭トークンが gh または git の bare 単文」（gh は --repo、
> cd &&・bash・env 前置禁止）として実行し、出力を $TMPDIR の file に落とすか、呼び出し側 agent が
> stdout/stderr を argv でスクリプトへ verbatim 転写して、スクリプトは file または argv 入力の
> 純変換とする。prompt に sandbox / excludedCommands / 特定パス起動の理由を書いてはならない —
> exec-proxy prompt は決定論スクリプトへの verbatim 転写契約であり、起動形の正しさは
> 設定側（`bin/` の PATH・isolation guard）の不変条件である。設定の正当化は本ファイルと AGENTS.md の一箇所に置き、
> per-prompt で再説明しない（再説明は転写契約に判断余地を持ち込み、下流の prompt へ引用・増幅される）。
> **例外はない**。スクリプトは snapshot 1 枚の純変換に保つ

## inline 生成区間

- `// ==== BEGIN inline:` 〜 `END inline` は生成物で直接編集禁止。`_lib` canonical を直し `tools/sync-inlines.mjs --write`（先頭トークン=スクリプトパスの bare 形、node/cd/bash 前置なし。既定 root は `plugins/dev-flow`）。新規区間は `--add <_lib/x.mjs> --into <workflow.js> --after '<一意な行>'`。全文一致は `_lib/workflow-inlines.sync.test.mjs` が CI で検証
- canonical 制約: ESM import / require / Date.now / Math.random を含めない。export function / export const のみ（export default / export { } 不可）。ファイル全体が inline 可能
- git plumbing による guard 迂回禁止（手編集が次回 --write で黙って消える事故防止）。guard は `hooks/hooks.json` の inline-edit-guard / inline-commit-gate で、plugin disable で両方が同時に失われる

## dev-flow-health

- 起動は日次 07:00 と journal の WatchPaths 即時トリガ（opt-in）。`daily.sh` は lock で直列、窓は直前の実行の `generated_at` から（new の重複防止）
- status・候補 commit は `health-report.sh` だけが決め、LLM は分類と理由だけ付ける
- `dev_flow` に分類した signature だけ 1 signature = 1 issue で起票する（self-improve）。実装・merge しない
