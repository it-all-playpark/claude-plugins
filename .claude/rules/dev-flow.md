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

- `pipeline.md` — phase ごとの判定・失敗の扱い
- `security-review.md` — security review の境界と経路
- `telemetry.md` — telemetry キー一覧
- `visual-snapshots.md` — 基準画像の撮影
- `exec-proxy.md` — exec-proxy の失敗ポリシー表
- `analyze-issue.md` — analyze の出力キー
- `capability-bound.md` — 能力しだいの判断と sunset トリガ
- `jev.md` — analyze の意味判定（Jev）の前提条件とインターフェース
- `justification-classes.md` — 正当化クラスごとの機構の一覧

## 構造

- Claude 専用（workflow 依存）。cross-vendor 放棄は dev-flow / pr-iterate のみ
- skill wrapper が isolation preflight → `Workflow({ name: 'dev-flow:dev-flow-run' })`。orchestration と中間 state は workflow script の JS 変数のみ
- `dev-flow.js` が持つ phase は `phase('Setup')`・`phase('Implement')`・`phase('Validate')`・`phase('PR')`（lite review を含む）、起動する工程の workflow は `workflow('dev-flow:dev-flow-test-commands-run')`・`workflow('dev-flow:dev-flow-evaluate-run')`・`workflow('dev-flow:pr-iterate-run')`・`workflow('dev-flow:dev-flow-finalize-run')`。新しい処理（agent の起動・prompt の組み立て・判定）は既存の工程 workflow か新しく切り出す工程 workflow に書き、`dev-flow.js` に足してよいのは工程の起動・state の受け渡し・ゲートの分岐だけ（script 上限はファイルごと）。phase・workflow を増減したらこの行を直す
- `meta.name` は `dev-flow-run` でも telemetry handoff の `skill` は `'dev-flow'` 固定（集計連続性）
- `agent()` の agentType は `nsAgentOpts()` でのみ namespace 付与（bare 名は起動直後 abort）。dev-flow-canary.js のみ namespaced id 直書き
- 1 issue = 1 PR。Implement は全 shape で `dev-implementer` を単一 worktree に 1 spawn。BLOCKED 再実装・green-fix・Evaluate 差し戻しも同じ agent
- model 既定は frontmatter。override は green-fix（`'sonnet'`）のみ（pr-iterate の fix は `pr-fixer` の frontmatter）。品質ゲート agent には渡さない — gate の判定モデルを credit で黙って変えない
- merge は常に人間（全 tier）
- 後方互換 scaffolding を作らない — out-of-enum は明示 error
- worktree の後片付けは `worktree-teardown`

## ゲート（fail-closed / fail-safe の理由）

- 軸A invariant: deterministic oracle / seed / critical は全 gate_policy で blocking。danger-grep の fail-closed と決定論ゲートを policy で緩めない。記録専用 telemetry は gate 入力にしない
- Merge tier は pr-iterate の後（fix 後の最終 tree で danger 再 reconcile）。fixes_applied>0 は Final reconcile で test 再実行、red / 再検証不能は HOLD（PR の CI は PR が書き換えうるため代替しない）。flake も外さない: `failed_files` 非空の red（skip の run は Validate）は落ちたファイルだけ 1 回再実行し、green は `final_test_flaky` で開示のみ（単体再実行の green は PR が書いたテストの出力）。全件・2 回目の再実行・LLM 判定はしない
- danger-grep 失敗は fail-closed（全 SEC seed unchecked → HOLD）。決定論 gate の入力の失敗は fail-safe（安全側 floor・HOLD）、advisory 信号は fail-open（proxy ごとの割り当ては `exec-proxy.md`）。理由: 決定論 gate の入力不明を通過と同一視しない
- analyze ゲート（Setup 末尾）は prerun の決定論 analyze（`analyze-issue --contract` + Jev）の検証とゲートのみ。spawn は引いたら `analyze-clarify#N`、通過後は全 AC を渡す `ac-observational#N` の 1 回ずつ（観測型は絞らずこれだけが判定）。LLM に issue を転写させない。AC 空・comment_conflicts / uncertain 非空は needs_clarification で終端（意味的矛盾の要否は決定論で決まらず、LLM が黙って片方を採ると訂正が反映されない）
- empty-diff gate は fail-closed（cross-repo は人間ラベル opt-in + 決定論 dirty 検証が揃った場合のみ graceful 終端）
- block_class は `approach_mismatch` / `guard_blocked` の閉じた enum。guard_blocked は replan ループから除外し evaluator focus へ直行
- isolation probe: `written:false` は fail-closed（throw）。probe 自体の失敗は fail-open。`bgIsolation:"none"` による guard 無効化は採らない（共有 checkout 汚染は blast-radius。設定緩和で sunset しない）
- telemetry は Stop hook が `--telemetry-json` 一本で journal へ渡す。workflow が書くキーは telemetry.md の一覧に限る。読み手の無いキーを足さない — 読まれない値の計算・転記コードが残るため

## 正当化クラス（W7）

- distrust 機構と agent への指示は下のクラスか capability-bound を宣言する（無いと撤去判断ができない）。クラスごとの機構の列挙は `justification-classes.md`
- **incentive-structural**（永続。勝利宣言の self-judge と moving target を断つ。賢いモデルほど巧妙に逸脱する）: frozen target・stuck 打ち切り・hard cap・review-finding 決定論スクラバー 等
- **指示の incentive-structural**（永続。逸脱が optimization pressure・context 分断由来）
- **blast-radius**（永続。不可逆性・accountability で正当化）: human merge・Final reconcile 等
- **contract**（永続・指示）: 出力 schema・StructuredOutput 義務・Boundary など呼び出し側が依存する指示
- 敵対的 security review: critical/major 0 件まで LGTM にしない gate は blast-radius。incentive-structural: 許可リストで対象判定（判定不能・一度対象は対象）・毎回新 spawn・head 照合（workflow が scope と今の PR head を照合）で clear・PR の文はデータ・公開は件数・`reviewer_context_changed`・Codex 中継（hook で縛る）の判定不能で停止。許可リスト拡大は非読込・非実行を示してから
- 上の 3 クラスはモデル更新で撤去しない。capability-bound の判断は `capability-bound.md` にだけ置く

## exec-proxy（起動形の制約）

- script は `bin/` の bare 名を**先頭トークン**にする。絶対パス・`bash`/`cd`/env 前置は書かない。人が起動する `security-review-isolated` は workflow・subagent から呼ばない
- dev-flow の `bin/` は sandbox 内で動かし excludedCommands に登録しない（子の hook・テストが sandbox 外で走る。blast-radius）。sandbox で揃わない pre-push の前提は hook で skip。prerun は repo の任意コードを実行しない
- 起動元 repo の `.git/config` を書く git / gh（`push -u`・`--track`・`gh pr checkout`）を使わない（sandbox 内で書けない）。push は `pr-push`（`git push origin HEAD`）、済みかは `origin/<branch>` と比べる。`redgreen-verify` / `run-tests` は index を書く git も使わない

> GitHub I/O の規範の適用範囲は workflow の subagent が起動する `bin/` のスクリプト（skill wrapper の preflight の `dev-flow-prerun`・`pr-iterate-prerun` は範囲の外）。スクリプトが持てる認証付き network I/O は、読み取り専用の gh を 1 回（snapshot 1 枚。失敗は error / ok:false に倒し成功を合成しない）と、`pr-push` の push（`start` / `wait` / `stop` で切り離す。lock 1800 秒・待機累計 3600 秒。全文は log、末尾を返す）の 2 つに限り、その外に**例外はない**。書き込み系の gh は subagent の bare 単文に置く（先頭トークンが gh・--repo 付き、cd &&・bash・env 前置禁止）。prompt に sandbox / excludedCommands / 特定パス起動の理由を書いてはならない — exec-proxy prompt は決定論スクリプトへの verbatim 転写契約であり、起動形の正しさは設定側（`bin/` の PATH・isolation guard）の不変条件。設定の正当化は本ファイルにだけ置き、per-prompt で再説明しない（再説明は転写契約に判断余地を持ち込み、下流の prompt へ引用・増幅される）

## inline 生成区間

- `// ==== BEGIN inline:` 〜 `END inline` は生成物で直接編集禁止。`_lib` canonical を直し `tools/sync-inlines.mjs --write`（先頭トークン=スクリプトの bare 形、node/cd/bash 前置なし。既定 root は `plugins/dev-flow`）。新規区間は `--add <_lib/x.mjs> --into <workflow.js> --after '<一意な行>'`。参照宣言のみ生成し一致は `_lib/workflow-inlines.sync.test.mjs` が CI 検証
- canonical 制約: ESM import / require / Date.now / Math.random を含めない。export function / export const のみ（export default / export { } 不可）。ファイル全体が inline 可能
- git plumbing による guard 迂回禁止（手編集が次回 --write で黙って消える事故防止）。guard は `hooks/hooks.json` の inline-edit-guard / inline-commit-gate で、plugin disable で両方が同時に失われる

## dev-flow-health

- 起動は日次 07:00 と journal の WatchPaths 即時トリガ（opt-in）。`daily.sh` は lock で直列、窓は直前の実行の `generated_at` から（new の重複防止）
- status・候補 commit は `health-report.sh` だけが決め、LLM は分類と理由だけ付ける
- `dev_flow` に分類した signature だけ 1 signature = 1 issue で起票する（self-improve）。実装・merge しない
