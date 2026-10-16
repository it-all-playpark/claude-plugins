---
description: dev-flow / pr-iterate / dev-flow-health の不変条件（fail-closed の理由・sunset トリガ・起動形の制約）。詳細は plugins/dev-flow/dev-flow/references/
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

dev-flow 本体・dev-flow-health（frontmatter の paths）を触るときだけ読み込まれる。
詳細は `plugins/dev-flow/dev-flow/references/`:

- `pipeline.md` — phase 経路 / shape tier / model・fallback / isolation probe / gate_policy・block_class
- `telemetry.md` — telemetry キー一覧と Stop hook の転送
- `justification-classes.md` — W7 正当化クラスと sunset path
- `exec-proxy.md` — bin/ bare 名起動形・argv 転写・失敗ポリシー表
- `inline-generation.md` — sync-inlines の起動形・canonical の構造制約

## 構造

- Claude 専用（workflow 依存）。cross-vendor 放棄は dev-flow / pr-iterate のみ
- skill wrapper が isolation preflight → `Workflow({ name: 'dev-flow:dev-flow-run' })`。orchestration と中間 state は workflow script の JS 変数のみ
- `meta.name` は `dev-flow-run` でも telemetry handoff の `skill` は `'dev-flow'` 固定（集計連続性）
- `agent()` の agentType は `nsAgentOpts()` でのみ namespace 付与（bare 名は起動直後 abort）。routing test は論理名（bare）を保持。dev-flow-canary.js のみ namespaced id 直書き
- 1 issue = 1 PR。Implement は全 shape で `dev-implementer`（plan+impl 統合）を単一 worktree に 1 spawn（Plan phase・planner ⇄ reviewer ループ・parallel fan-out は持たない）。BLOCKED 再実装・green-fix（`model: 'sonnet'`）・Evaluate 差し戻しも同じ agent。複数 issue 分割は使わない
- model 既定は frontmatter。override は green-fix（`'sonnet'`）と pr-iterate の fix（`dev-runner` に `'opus'`）のみ。品質ゲート agent には渡さない — gate の判定モデルを credit で黙って変えない
- merge は常に人間（全 tier）
- 後方互換 scaffolding を作らない — out-of-enum は明示 error
- worktree の後片付けは `worktree-teardown`（`git worktree remove` 直打ちは veridelta 証跡を失う）

## ゲート（fail-closed / fail-safe の理由）

- 軸A invariant: deterministic oracle / seed / critical は全 gate_policy で blocking。security floor と決定論ゲートを policy で緩めない。記録専用 telemetry は gate 入力にしない
- Merge tier は pr-iterate の後（fix 後の最終 tree で danger 再 reconcile）。fixes_applied>0 は Final reconcile で test 再実行、red / 再検証不能は HOLD（PR head sha に pin した CI 決定論判定でのみ代替）。例外は flake だけ: `failed_files` 非空の red は落ちたファイルだけ 1 回再実行し、exit code が green なら flake（`final_test_flaky` に記録・HOLD 理由にしない）。全件・2 回目の再実行と LLM 判定はしない（繰り返すほど本物の red を通す）
- danger-grep 失敗は fail-closed（全 SEC seed unchecked → HOLD）。realized-diff / redgreen / final-reconcile / final-ac-reconcile / issue-labels の失敗は fail-safe（安全側 floor・HOLD）。advisory 信号（ci-checks / structural / vdelta / post-comment / clock / pr-meta）は fail-open。理由: 決定論 gate の入力不明を通過と同一視しない
- analyze ゲート（Setup 末尾）は prerun の決定論 analyze（`analyze-issue --contract` + Jev）の検証とゲートのみ。spawn は引いたら `analyze-clarify#N`、通過後に観測型 null の AC があれば `ac-observational#N` の 1 回ずつ。LLM に issue を転写させる経路を戻さない。AC 空 / comment_conflicts 非空 / uncertain 非空は needs_clarification で終端（決定論は意味的矛盾の要否を判定できず、LLM に黙って片方を採らせると訂正が実装に反映されない）
- empty-diff gate は fail-closed（cross-repo は人間ラベル opt-in + 決定論 dirty 検証が揃った場合のみ graceful 終端）
- block_class は `approach_mismatch` / `guard_blocked` の閉じた enum。guard_blocked は replan ループから除外し evaluator focus へ直行
- isolation probe: `written:false` は fail-closed（throw。回避手順は pipeline.md）。probe 自体の失敗は fail-open。`bgIsolation:"none"` による guard 無効化は採らない（共有 checkout 汚染は blast-radius。設定緩和で sunset しない）
- telemetry は Stop hook が `--telemetry-json` 一本で journal へ渡す（キー別 flag・検証は持たない）。workflow が書くキーは telemetry.md の一覧に限る（`_lib/telemetry-keys.test.mjs` が pin）。読み手の無いキーを足さない — 読まれない値の計算・転記コードが残るため

## distrust / prescription の正当化（sunset トリガ）

- 各 distrust 機構は incentive-structural（永続）/ blast-radius（永続）/ capability-bound（sunset 対象）を宣言。capability-bound はパラメータ値 + 再評価トリガを併記。クラス無しは負債
- agent への指示も contract / incentive-structural / capability-bound を宣言。capability-bound の再評価は major モデルリリース毎の dry-run
- sunset トリガ: `gate_policy` → calibration monitor が judge を well-calibrated と実証した時点で blocking へ。pr-iterate major 閾値 → 同（critical は永続）。redgreen vdelta → deny-only 固定、record_integrity 昇格 + precision 実証で再評価。trust-layer 復帰 → (1) 監査証跡の破壊的上書き無し (2) classifier ブロックが run abort へ波及しない実測 (3) 完走率が劣後しない、の 3 条件を満たす再設計のみ
- incentive-structural / blast-radius はモデル更新で撤去しない

## exec-proxy（起動形の制約）

- script は `bin/` の bare 名を**先頭トークン**にする。絶対パス・`bash`/`cd`/env 前置は書かない
- dev-flow の `bin/` は sandbox 内で動かし excludedCommands に登録しない（子の hook・テストが sandbox 外で走る。blast-radius）
- 起動元 repo の `.git/config` を書く git / gh（`push -u`・`--track`・`gh pr checkout`）を使わない（sandbox 内で書けない）
- plugin の `bin/` PATH はセッション起動時に version 込みで焼かれる — update 後は新セッションで `command -v` 確認（素のシェルでは常に失敗）

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
> **例外はない**。wall-clock polling も同じで、1 spawn = 1 判定・ループは script 側。初回 poll は
> `ci-check`、2 回目以降は `ci-wait-check`（1 spawn。数秒超の bare `sleep` は Bash tool が拒否する）。
> スクリプトは snapshot 1 枚の純変換に保つ。
>
> polling ループを subagent 内に置いてはならない（turn 会計が CI 所要時間に連動し、StructuredOutput
> 未達で `ci_error` に化ける）。総待機上限は `CI_WAIT_CEILING_SECONDS`（`_lib/ci-check.mjs`）。
> 1 spawn の必要 turn（ci-check / ci-wait-check とも 1 + 2 + 1 + CI_TURN_MARGIN）が
> 当該 agent の `maxTurns` を超えないこと。`slept:true` 以外は積算せず `ci_pending` で終端する

- exec-proxy と inline generator は harness-capability-bound な橋。再評価トリガ: harness が直接 exec / ESM import を解禁した時点で撤去（`/dev-flow-canary` の report で判定）

## inline 生成区間

- `// ==== BEGIN inline:` 〜 `END inline` は生成物で直接編集禁止。`_lib` canonical を直し `tools/sync-inlines.mjs --write`（先頭トークン=スクリプトパスの bare 形、node/cd/bash 前置なし）。新規区間は `--add <_lib/x.mjs> --into <workflow.js> --after '<一意な行>'`
- canonical 制約: ESM import / require / Date.now / Math.random を含めない。export function / export const のみ。ファイル全体が inline 可能
- git plumbing による guard 迂回禁止（手編集が次回 --write で黙って消える事故防止）。plugin disable で edit/commit 両 guard が同時に失われる

## dev-flow-health

- 起動は日次 07:00 と journal の WatchPaths 即時トリガ（opt-in）。`daily.sh` は lock で直列、窓は直前の実行の `generated_at` から（new の重複防止）
- status・候補 commit は `health-report.sh`（決定論）だけが決め、LLM は `needs_llm` の実行だけ起動し付け直さない
- 起票は label self-improve、1 signature = 1 issue。実装・merge はしない
