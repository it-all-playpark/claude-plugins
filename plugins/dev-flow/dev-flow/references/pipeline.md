# dev-flow パイプライン

`/dev-flow` と `/pr-iterate` の phase ごとの地図。各 phase の節は、何を判定するか（**判定**）、失敗を fail-closed / fail-safe /
fail-open のどれで扱うかとその理由（**失敗の扱い**）、コードの場所（**コード**）を持つ。回数・秒数・`maxTurns`・enum の値・
label の一覧は書き写さず、定数名かファイルで指す（値の正はコード）。

ほかの置き場所:

- 不変条件（軸A・human merge・正当化クラス・exec-proxy の起動形・inline 生成区間）は `.claude/rules/dev-flow.md`
- モデル・harness の能力しだいの判断（model・effort の割り当てを含む）は `capability-bound.md`
- 敵対的 security review の守る要件と境界（R1〜R3）と経路は `security-review.md`
- exec-proxy の一覧と proxy ごとの失敗ポリシー表は `exec-proxy.md`、telemetry キーは `telemetry.md`、analyze の出力は `analyze-issue.md`

本文のパス（`.claude/workflows/`・`agents/`・`_lib/`・`_shared/`・`hooks/`）は `plugins/dev-flow/` を root とする plugin 相対パス。
`tools/` と `.claude/rules/` は repo root。

失敗の扱いの語:

- **fail-closed** — 止める（throw・needs_clarification・HOLD を強制）。決定論 gate の入力が分からないことを通過と同一視しない
- **fail-safe** — 安全側の値に倒して続ける（complex floor・inspection 据え置き・HOLD 理由を立てる）。run の成果物と終端サマリーを残す
- **fail-open** — 警告の log だけで続ける。advisory 信号で、gate の入力にしない

## 全体の経路

```
/dev-flow <issue>   → [wrapper preflight] → Setup(末尾で決定論 analyze ゲート)
                      → Implement(dev-implementer 1 spawn) → Validate(test green)
                      → Diff triage(realized diff から shape 判定) → Evaluate → PR → workflow('dev-flow:pr-iterate-run')
                      → Final reconcile(fixes_applied>0 のみ) → Merge tier
/pr-iterate <pr>    → [wrapper preflight: pr-iterate-prerun → EnterWorktree]
                      → workflow('dev-flow:pr-iterate-run') で review ⇄ fix loop (LGTM まで) → 終端サマリー
```

- orchestration（phase 遷移・各ループ）と中間 state は workflow script（`.claude/workflows/dev-flow.js` / `.claude/workflows/pr-iterate.js`）の
  JS 変数だけに持つ。phase の並びは `dev-flow.js` の `meta.phases`。pr-iterate は親 meta に現れないサブ workflow で、自分の `Iterate` phase を持つ
- 起動名は namespaced（`dev-flow:dev-flow-run` / `dev-flow:pr-iterate-run`）。telemetry handoff の `skill` は `'dev-flow'` / `'pr-iterate'` のまま
- `agent()` の agentType は `nsAgentOpts()`（`_lib/agent-namespace.mjs`）でだけ namespace を付ける。判断系 leaf は `agents/` の subagent
- model は subagent の frontmatter で決め、品質ゲート agent の call site は `opts.model` を渡さない。override は Validate の green-fix の
  sonnet だけ（`_lib/impl-model-opus.test.mjs` が pin）。割り当ての判断は `capability-bound.md`
- effort は frontmatter で決め、call site は opts で渡さない（`_lib/agent-frontmatter.test.mjs` が pin）
- 決定論処理は `bin/` の bare 名の script を dev-runner 系 subagent に実行させる（exec-proxy。`exec-proxy.md`）
- worktree の後片付けは `_shared/scripts/worktree-teardown.sh`。merge は常に人間

## Setup

- **判定**: wrapper（`dev-flow/SKILL.md`）が `dev-flow-prerun --issue <N> --worktree <path>` で base 解決・worktree の作成/再利用・
  起点検証・書き込み probe・`.devflow-tmp` の clean・issue analyze（`analyze-issue --contract` の決定論 parse + Jev 有界判定）・
  framework 検出を済ませ、別の Bash 呼び出しの `ensure-worktree-deps --setup <worktree>/.devflow-tmp/prerun-setup.json` で deps を入れる
  （install は repo の任意コードを走らせるので prerun の子にしない）。`EnterWorktree` → `Workflow({ args: { issue, setup } })` の順で起動し、
  Setup は `args.setup` を検証して REQ を組み、次のゲートを順に判定する（通常経路の spawn は 0）:
  - blocked_by ゲート — `args.setup.analyze.blockers` に open な issue が 1 つでもあれば止める
  - analyze ゲート — AC 空 / comment_conflicts 非空 / uncertain 非空 / repo 内外が混ざった AC。引いたときだけ missing_context を書く
    agent を 1 spawn する。repo 内外の混在は `classifyAcScope` が決定論で判定し、
    `mixed` で、repo 外の作業を `human-task` ラベルの別 issue に切り出し、実装 issue の AC を repo 内で検証できるものだけにするよう求める
    （1 issue = 1 PR・単一 worktree では repo 外を満たせず、Evaluate 後に agent AC の取りこぼしと誤分類されるため）。依存の向きは、
    merge 前に人がやる作業なら実装 issue に `Blocked by #<human issue>`、merge 後に確認する作業なら human issue に `Blocked by #<実装 issue>`。
    `（人手）` と明記した AC は混在していても human
  - AC の actor — `agent` / `human` / `ci`（`_lib/ac-actor.mjs`）。観測型 AC（実行して観測しないと確かめられない AC）は prerun の
    正規表現 + Jev で決め、決まらない AC だけを AC の文面と issue タイトルだけを読む分類 agent に 1 回で渡す（diff・evaluator の結果は渡さない —
    実装を見た判定は抜け道になる）。ci AC は repo の `"dev-flow".ci_verify` の宣言に当たる AC（`matchesCiVerify`）
  - isolation probe — ゲート通過後・Implement の前に、tools を Write だけにした `dev-runner-haiku-wo` が worktree 直下
    `.devflow-tmp/.isolation-probe-<token>` に書けるかを確かめる（implementer と同じ Write tool の経路の検証。token は `args.setup.epoch`）
- **失敗の扱い**:
  - `args.setup` の欠落・`ok:false`・型不正、analyze の whitelist 不合格は throw（fail-closed。workflow 内に fallback を置かない）
  - analyze 段の失敗・open な blocker・analyze ゲートは needs_clarification で終端（fail-closed。REQ を推測で組まない。決定論は意味的矛盾の
    要否を判定できず、LLM に黙って片方を採らせると訂正が実装に反映されない）。missing_context を書く agent の失敗は fail-open
    （ゲート理由をそのまま返す）
  - 観測型の分類 agent が決められない AC は観測型にする（fail-safe。evaluator のコード読みで達成扱いにしない側）
  - isolation probe の `written:false` は throw（fail-closed）。回避手順（別の worktree を作る → `EnterWorktree` → prerun からやり直す）は
    `isolationFailureMessage` が throw メッセージに載せる。probe 自体の失敗（null）は fail-open
- **コード**: `phase('Setup')`（`.claude/workflows/dev-flow.js`）、`validatePrerunSetup`（`_lib/prerun-setup.mjs`）、`buildReqFromContract`・
  `analyzeGateReasons`・`blockedByReasons`（`_lib/analyze-contract.mjs`）、`classifyAcScope`・`mixedScopeAcReasons`・`resolveAcObservational`
  （`_lib/ac-actor.mjs`）、`isolationProbePrompt`・`isolationFailureMessage`（`_lib/isolation-probe.mjs`）、prerun は
  `dev-flow/scripts/prerun-analyze.sh` ほか

## Implement

- **判定**: issue から単一 task の plan を合成し（`synthesizeImplPlan`。planner は起動しない）、`dev-implementer`（plan+impl 統合）を
  1 spawn する。入力は issue 本文・AC・`fix_feedback` で、テスト全件・red 証明・AC 判定は後段（Validate / redgreen-verify / evaluator）が担う。
  返却の `files` を宣言として plan に取り込み（宣言外監査・実効 shape・PR 本文の材料）、PR 本文の材料は `adoptImplPrNotes` が取り込む。
  - BLOCKED（`approach_mismatch`）は累積の findings（過去のアプローチへの回帰禁止）と DONE 成果を付けて同じ agent を再 spawn する
    （上限 `BLOCK_MAX`）。`guard_blocked` は再 spawn せず evaluator の focus へ直行する。理由がファイル削除なら、以降の実装 spawn に
    削除手段の固定文を足す（`isDeletionGuardBlock`）
  - NEEDS_CONTEXT は needs_clarification で人間に返す
  - `pr_sections` が `PR_SECTIONS_MAX_CHARS` を超えたら要約を 1 回差し戻し、PR 本文の欄に日本語を含まない項目があれば書き直しを 1 回差し戻す
    （判定する LLM の文脈を薄めないため）
- **失敗の扱い**:
  - `blocking_reason` は閉じた enum の構造化 object で、string・out-of-enum は schema error（fail-closed）
  - implementer の null は再試行せず drop に数え（`implDroppedCount`）、Evaluate を強制する（fail-safe。計画した範囲が欠けても diff が
    非空なら後段を素通りするため）
  - 要約・日本語の差し戻し後も残ったものは切らずに載せ、log に警告を出す（fail-open。HOLD 理由にしない）
- **コード**: `execImplementPhase`・`runImplement`・`implPrompt`・`extractGuardBlocked`・`trimPrSectionsIfOver`・`rewriteNonJapanesePrBodyItems`
  （`.claude/workflows/dev-flow.js`）、`normalizeBlockingReason`（`_lib/block-routing.mjs`）、`prSectionsTrimFeedback`・`prBodyLanguageFeedback`
  （`_lib/pr-artifacts.mjs`）

## Validate

- **判定**: test が green か。test の実行は exec-proxy `run-tests <WT> --base origin/<base>` の stdout の転写だけで、`tests/run-*.sh` を
  全本実行し、全本 exit 0 のときだけ green。run-tests は merge-base が解決できたときだけ `tests/run-*.sh` に
  `DEVFLOW_CHANGED_FILES`（merge-base からの差分と untracked の WT 相対パスを 1 行 1 件で書いたファイルの絶対パス）と `DEVFLOW_BASE`
  （merge-base の sha）を渡す。未設定（`--base` 無し等）は全件実行。テストの選択は repo 側のランナーが行い、
  dev-flow は repo 固有の知識を持たない。テストの直前に `workspace-prebuild <WT>` が pnpm ワークスペースの成果物を作り直す
  （依存先の変更で古くなるため）
  - 各回の test の前に `pre-commit-hook <WT>` が対象 repo の pre-commit hook を PR phase の commit と同じ stage で回し、exit 非 0 は
    その回を green にせず出力のログのパスだけ green-fix に渡す（hook 無し・結果不明は何も足さない）
  - red なら green-fix（同じ `dev-implementer` を sonnet で）を `GREEN_MAX` まで回す。その前に失敗を分類し、diff と無関係で base でも
    同じように落ちるテストは ENV 項目（advisory）として green 要件から外す（`_lib/base-failure-triage.mjs`）
  - empty-diff gate — working tree が base と同じ tree なら 1 回だけ差し戻し、Validate をやり直す
  - repo が `"dev-flow".local_verify` を宣言していれば、ci AC を Validate の green 後・Evaluate の前に pg-broker の使い捨て DB で
    ローカル実行する（`execLocalVerify`）。失敗は dev-implementer に差し戻す（`AGENT_AC_REIMPL_MAX` を Evaluate と共有）
- **失敗の扱い**:
  - `tests:'error'`（起動失敗）は green-fix せずに抜け、`GREEN_MAX` 到達の red はそのまま先へ進む（fail-safe。Final reconcile を
    skip した run は Merge tier の HOLD 理由になる）
  - base 失敗の分類材料（`failed_files`・diff の一覧・base での再実行）が欠けた失敗はすべて green-fix の対象（fail-safe。green 要件を緩めない）
  - workspace-prebuild の失敗はテストを実行せず red（fail-safe）
  - 差し戻し後も空 diff なら throw（fail-closed）。例外は人間の cross-repo ラベル opt-in と、worktree 外の dirty な成果物の決定論の証拠が
    揃ったときだけの graceful 終端（`_lib/cross-repo-gate.mjs`）
  - local-verify が pg-broker に届かない・結果を取れない・Validate が red なら、pr-iterate の CI 待ちに戻す（fail-open。理由は終端サマリーの参考に出す）
- **コード**: `execValidatePhase`・`runValidateLoop`・`triageBaseFailures`・`execLocalVerify`（`.claude/workflows/dev-flow.js`）、
  `_lib/run-tests-prompt.mjs`、`_lib/base-failure-triage.mjs`、`_lib/cross-repo-gate.mjs`、`_lib/local-verify.mjs`

## Diff triage

- **判定**: 実装後・PR 前の realized diff を 1 本の exec-proxy（`diff-triage`）で読み、次を決める:
  - danger-grep（security の危険パターン）と test-surface の hit — hit は SEC seed / TESTSURF として ledger に積む
  - 実効 shape — `classifyShape` が realized diff の file 数・行数と issue 由来の決定論特徴量（AC 数・`issue_type`・構造化 `breaking_change`）で
    1 回で決める。数える file は ephemeral・宣言外・format-only を除いたもの。安全 floor（count 欠損・AC 欠落・out-of-enum の
    `issue_type`・`breaking_change === true` → complex）を通った run だけ、行数で下げ方向にだけ補正する。LLM の事前見積もりは使わない
  - Evaluate を走らせるか（`runEval`）— micro 以外、または danger-grep / testsurf の hit・green-fix・drop・宣言外変更がある run
  - 宣言外変更 — implementer が申告しなかった変更を concern に積み、evaluator の重点監査に回す
  - 敵対的 security review の対象か（security-scope。`security-review.md`）— lite route の入口と nested pr-iterate の引数になる
- shape は Evaluate の深さと Merge tier の入力になる: micro は evaluator を回さない（`runEval` で強制されたときだけ回す）、standard は
  差し戻さない（例外は agent AC の未達）、complex は差し戻しループを回す
- **失敗の扱い**:
  - danger-grep の失敗・契約外の形は全 SEC seed を unchecked にして HOLD へ（fail-closed。軸A）。proxy の null・例外は abort せず
    per-field のフォールバックに倒す（abort は終端サマリーと journal を失う）
  - realized の files 欠落は NaN → complex（fail-safe）。行数が 1 file でも欠けた run は補正しない
  - security-scope の取得失敗・形の崩れは対象（fail-closed）
  - structural 分類の欠落は分類なし（fail-open）。diff hash が取れなければ Merge tier で再判定する（fail-open）
- **コード**: `execDiffTriagePhase`・`parseDiffTriageFields`（`.claude/workflows/dev-flow.js`）、`classifyShape`（`_lib/triviality.mjs`）、
  `_lib/diff-triage.mjs`、`_lib/testsurf.mjs`、`_lib/declared-paths.mjs`、`_lib/security-scope.mjs`

## Evaluate

- **判定**: `evaluator` が diff・AC・PR 本文（PR 作成前に `buildPrBody` で組んだプレビュー）を読み、指摘を ledger に積む。収束は
  `isConvergedUnderPolicy` だけで判定し（verdict は見ない）、未収束なら `fix_feedback` 付きで同じ `dev-implementer` に差し戻す。
  - lane は `gate_policy` で決まる（`_lib/gate-policy.mjs`。既定は `DEFAULT_GATE_POLICY`）。critical・決定論 check・seed は全 policy で blocking
  - 差し戻しの上限は `EVAL_PASSES`（shape から決まる。上限 `EVAL_MAX`）、design 差し戻しは `DESIGN_REPLAN_MAX`、同じ topic の反復は
    `EVAL_STUCK` で stuck。既出の指摘を渡して蒸し返しを抑える
  - Validate と同じ tree の eval#N には Validate の結果と `run-tests` の各 script のログパス（`scripts[].log`。worktree の外）を渡す。
    evaluator はログに載っている AC 関連テストファイルを再実行せずログの行を根拠にし、載っていないものだけを実行する
    （`validateResultPromptBlock`）。ログを根拠にできるのは realized diff が変更したファイルだけ（ログの中身はテストが
    自由に書けるので、変更していないファイルの結果は偽の行と区別できない）。tree が違う・ログか変更ファイルが無いときは
    AC 関連テストファイルを実行させる
  - agent AC の `satisfied:false` は gate_policy に依らず差し戻す（`AGENT_AC_REIMPL_MAX` まで延長）。human AC は差し戻さない。
    観測型 AC は redgreen-verify で red→green を実証して deterministic 昇格したときだけ checked（`demoteUnprovenObservationalAc`）。
    ci AC は evaluator に判定させない。実行環境に届かない理由の未達（`unreachable_env`）は人手 AC 待ちに数える
  - redgreen-verify — AC のテストを実装を外した tree と戻した tree で走らせ、red→green なら AC を deterministic に昇格する
  - 差し戻し後の PR 前再テストで green-fix が入った run は、その差分を evaluator に評価させ直す（`_lib/post-eval-recheck.mjs`）。
    テストを弱めた critical は `GF-RECHECK-*`（全 gate_policy で blocking。test green では解消しない）
- **失敗の扱い**:
  - evaluator の null は throw（fail-closed。評価していない diff で PR に進まない）
  - stuck・上限到達は throw せず現状で PR へ進む（未解消の critical は Merge tier の HOLD と人のレビューが持つ）
  - redgreen-verify の spawn 失敗・結果の欠落は inspection 据え置き（fail-safe。deterministic 昇格しない）
  - post-eval の再評価で hash・evaluator の応答が取れなければ評価済み tree を進めず、PR 直前の `hash_mismatch`（HOLD）で人に返す（fail-safe）
- **コード**: `execEvaluatePhase`・`execPostEvalValidate`・`recheckPostEvalGreenFix`（`.claude/workflows/dev-flow.js`）、`_lib/gate-policy.mjs`、
  `_lib/goal-ledger.mjs`、`_lib/evaluator-contract.mjs`、`_lib/redgreen-targets.mjs`、`_lib/stuck-detector.mjs`、`_lib/vdelta-transitions.mjs`

## PR

- **判定**: commit message と PR 本文を state から純関数で組み（`buildCommitMessage` / `buildPrBody`）、proxy に verbatim で保存・
  commit・push・`gh pr create` させる。PR 本文の見える部分は人間向けの要約（`behavior_changes` / `review_points` / `out_of_scope` と
  `Closes #N`）に限り、受入条件・設計判断・検証・`pr_sections` は `<details>` に畳む。builder はどの欄も字数で切らない（1 行要約欄の
  長さは IMPL schema の `maxLength` で書き手に収めさせる）。ci AC がある run は PR に `ci_verify.label` を付ける。
  - **micro lite route**: `state.EFFECTIVE_SHAPE === 'micro' && !state.runEval && state.dangerHits.length === 0 && CI_AC_INDEXES.length === 0 && !state.securityReview.target`
    の run は、フル pr-iterate の代わりに `pr-review-lite`（pr-reviewer の 1-pass review）→ `ci-check-lite`（CI の 1 回判定）の 2 spawn で
    終える。review が null か blocking（critical/major）を返したら CI を読まずにフル pr-iterate へ昇格し、CI が passed / no_checks で
    なければ（failed・pending・error・null）同じく昇格する。どちらも clean なら lgtm で終える
  - それ以外の run は nested の `workflow('dev-flow:pr-iterate-run')`（`prIterateArgs()`。`nested.caller: 'dev-flow'`）
- **失敗の扱い**:
  - commit・push・PR 作成の中断（`committed:false`・PR 番号なし）は throw せず `pr_phase_failed` の failure で終える（fail-closed。
    nested pr-iterate・Merge tier は走らせない。成果物・所要・回収コマンドを返り値と journal に残し、回収は wrapper が issue コメントで人間に渡す。
    push の再発行・force push 等の fallback は持たない）
  - lite の review・CI が判定できないときはフル pr-iterate へ昇格する（fail-safe。lite route の critical/major で昇格するのは blast-radius）
- **コード**: `phase('PR')`・`prPhasePrompt`・`prPhaseFailure`・`prIterateArgs`（`.claude/workflows/dev-flow.js`）、`buildPrBody`・
  `buildCommitMessage`（`_lib/pr-artifacts.mjs`）、`classifyLiteReview`（`_lib/lite-route.mjs`）、`ciEffectiveStatus`（`_lib/ci-check.mjs`）

## pr-iterate

- **判定**: review ⇄ fix を LGTM まで回す（上限 `MAX` は `args.max_iterations`。同じ指摘の反復は `REVIEW_STUCK` で stuck）。LGTM は
  review の approve・CI gate（passed / no_checks）・conflict なし・security review の clear（対象の run のみ）がそろった round で確定する。
  終端の status は `STATUS_HEADLINE` が持つ。
  - delta review — review#i（i ≥ 2）は前 round の review 時点の head から今の head までの fix delta だけを読む（`resolveReviewScope`）。
    sha が確定できない round は full review。full review が critical を 1 件以上返したら、次の round は delta 範囲を渡さない full review に戻す（`nextCriticalPending`）。
    critical を返さない full review を経るまで delta review に戻さず LGTM にもしない — critical の fix を
    delta review が approve しただけでは LGTM にならない（delta review は delta 外の新規指摘を出さないので、critical が出た PR は他にもある前提で扱う）
  - fix — `pr-fixer` に blocking と CI 失敗をまとめて 1 回で渡す。review の finding の文は決定論でスクラブしてから渡す
    （`_lib/review-finding-scrub.mjs`）。worktree の外を指す finding は fix から外し、返り値 `human_followups` と終端サマリーの
    「人間側 follow-up」に載せる（`excludeOutsideWorktree`）
  - ci AC — 宣言された check を各 round の CI 判定から外し、LGTM 後に別ループで完了を待つ（`waitCiVerify`。local-verify で決着した run は待たない）
  - base との conflict — LGTM の候補の round で CONFLICTING / DIRTY なら base を merge し、`conflict-autoresolve` が衝突ファイルを型 A
    （全 hunk の base 側が空 → 和集合）/ 型 B（inline 生成区間内だけ → `sync-inlines --write` で再生成）に分類する。全ファイルが A / B なら
    push して次 round の review・CI gate を通してから LGTM。それ以外は merge を戻す — base の行を両側が書き換えた hunk は仕様判断なので LLM に解かせない
  - 敵対的 security review — 対象の run は各 round で review と並べて回す（`securityRound` / `securityGate`。`security-review.md`）
  - 単体起動 — wrapper（`pr-iterate/SKILL.md`）の `pr-iterate-prerun` が PR head の worktree を用意し `args.nested`
    （`caller: 'standalone'`）で渡す。`prior_devflow`（HOLD の dev-flow サマリー）があれば code ごとの回収状況を出し、pr-iterate が
    確かめられない code は未解消として人に返す（`priorHoldRecovery`）。`prior_summary` の head が今の head と違えば、review の前に
    「再 review 中」コメントを足す（古い LGTM を今の head の根拠にさせない）。`--direction <file>` の修正方針は prerun が PR の worktree の
    外で読み、fix の prompt にだけ入れる（判定者には渡さない）
- **失敗の扱い**:
  - review の null・throw は同じ prompt で 1 回だけ再試行し、だめなら `review_contract_error`、fix の null は 1 回再試行して `fix_failed`、
    fix の commit・push を保証できなければ `fix_failed`（fail-closed。LGTM にしない）
  - CI を確定できない・上限まで pending は LGTM にしない（fail-closed）
  - security review を clear にできない run は LGTM にしない（fail-closed。`security-review.md`）
  - mergeable の取得失敗は conflict の自動解消を試みない（fail-open。definitive な conflict は Merge tier が HOLD にする）。自動解消できない
    conflict は LGTM で終え、Merge tier の HOLD に任せる（fail-safe）
  - `nested.caller` の欠落・out-of-enum（`NESTED_CALLERS`）、`--direction` の不正は throw（fail-closed）
  - isolation probe の `written:false` は throw（fail-closed）。直前の cleanup と「再 review 中」コメントの投稿の失敗は fail-open
- **コード**: `.claude/workflows/pr-iterate.js`（`callReviewAgent`・`callFixAgent`・`ensureFixCommitted`・`applyCiFix`・`waitCiVerify`・
  `autoResolveConflict`・`securityRound`・`buildTerminalSummaryBody`）、`_lib/review-delta.mjs`、`_lib/review-normalize.mjs`、
  `_lib/ci-check.mjs`、`_lib/conflict-autoresolve.mjs`、`_lib/security-review.mjs`、`_lib/pr-comment-format.mjs`

## Final reconcile

- **判定**: pr-iterate が fix を適用した run（`fixes_applied > 0`）だけ、fix 後の最終 tree で確かめ直す:
  - worktree を PR の最終 HEAD に同期し、Validate と同じ prompt の `run-tests <WT>` を 1 回だけ実行する（green-fix はしない）。red で
    落ちたファイルが分かれば、そのファイルだけを 1 回流し直し、green なら flake 候補として開示する（HOLD・`EVAL-*` は外さない。
    PR が書いたテストの出力。`_lib/final-test-rerun.mjs`）
  - テストを実行できなければ（同期失敗・test の null・`tests:'error'`）`unavailable`。PR の CI の success では代えない
    （PR が CI の workflow・スクリプトを書き換えうる）
  - 最終の changed-files で宣言外変更を監査し直す
  - final test が green（no_tests を含む）の run（`reverified`）だけ、Final AC reconcile（evaluator）が最終 tree で AC・未解消 item・fix が触った
    解消済み item を判定し直す（`shouldRunFinalAcReconcile`）。未 checked の `EVAL-*` blocking は test#final green を head sha に pin した
    evidence で checked にする（evaluator は fix 後に再実行されないため。`finalEvalBlockingResolutions`）。SEC seed・TESTSURF・AC-FINAL は LLM の判断で解消しない
  - Evaluate で red→green を実証していない観測型 AC に Final AC reconcile が `verified_by:'test'` と `test_files` / `impl_files` を返したら、
    最終 tree で redgreen-verify（`redgreen-final`。impl は `origin/<base>` との merge-base まで戻す）を 1 spawn で実行し、red→green が成立して
    vdelta が deny しなければ deterministic に昇格する（`finalRedgreenTargets`）。fix がテストを直した run を人手 AC 待ちにしないため。
    inspection の観測型 AC と Evaluate で昇格済みの AC には spawn しない
  - test#final が green か no_tests なら、Final AC reconcile に test#final の `tests` / `green` と各 script のログパスを渡し、
    実行済みのテストファイルを再実行させない（根拠にできるのは changed-files-final のファイルだけ）
- skip した run の PR tree のテスト状態は Validate の結果のままで、`tests:'failed'` は `validate_test_red`（上と同じ再実行で開示）、
  `tests:'error'` は `validate_tests_not_run` で HOLD（PR の CI の success では解除しない）
- **失敗の扱い**:
  - 同期失敗・test の null・`tests:'error'` は `unavailable`（fail-safe → HOLD `final_reconcile_unavailable`）。
    flake の再実行は落ちたファイルだけで 1 回まで（繰り返すほど本物の red を通す）
  - Final AC reconcile の応答が検証に通らなければ `unavailable`（fail-closed → HOLD）
  - `redgreen-final` の spawn 失敗（throw・null）・結果の欠落・red→green 不成立・vdelta の deny は昇格せず、観測型 AC は人手 AC 待ちのまま（fail-safe）
  - changed-files の取得失敗は宣言外の再監査を skip（fail-open。test gate は維持）。PR 本文の AC checkbox の更新失敗も fail-open
- **コード**: `phase('Final reconcile')`（`.claude/workflows/dev-flow.js`）、`_lib/final-test-rerun.mjs`、
  `_lib/final-ac-reconcile.mjs`（`finalEvalBlockingResolutions`・`finalRedgreenTargets`）、`_lib/redgreen-targets.mjs`、`_lib/post-eval-recheck.mjs`

## Merge tier

- **判定**: fix 後の最終 tree に対して `merge-tier-facts`（danger-grep の再実行・changed-files・PR の mergeable・CI checks・Closes 行）を 1 回で
  読み、danger を reconcile し直して `classifyMergeTier` が tier を決める。micro + docs/test-only + danger clean + 収束は AUTO 推奨ラベル、
  標準は REVIEW、blocking が残れば HOLD。HOLD 理由の code は `_lib/merge-tier.mjs` の `pushBlocking` が持つ（一覧は
  `docs/dev-flow-atlas.md` の HOLD 理由表）。どの tier でも merge は人間
  - 敵対的 security review の対象の run（Diff triage か pr-iterate のどちらかで対象）は、pr-iterate が lgtm かつ security review が
    今の head で cleared でなければ HOLD（`security_review_unresolved`。gate_policy に依らない）
  - PR 本文に `Closes #N` が無ければ、run が決定論で組んだ最新の本文で入れ直す
  - 終端サマリーを PR に投稿する。末尾の marker（`<!-- dev-flow:<tier> head=<sha> -->`、HOLD は code 付き）は単体 pr-iterate の
    `prior_devflow` が読む
- **失敗の扱い**:
  - `merge-tier-facts` の null・例外・契約外の形は per-field のフォールバックで続け、danger は fail-closed（HOLD を強制）。転記欠落と
    実行不能は HOLD 理由を出し分ける。abort はしない（終端サマリーと journal を失う）
  - diff hash の取得失敗は Diff triage の結果を再利用せず再判定する（fail-safe）
  - mergeable が確定しないときは HOLD しない（fail-open。definitive な CONFLICTING / DIRTY だけ HOLD）
  - Closes 行の取得失敗は未検証（fail-open）。欠落は入れ直し、入れ直せなければ HOLD（fail-closed）
  - CI checks の取得失敗・終端サマリーの投稿失敗・journal handoff の失敗は fail-open（gate・tier に影響しない）
- **コード**: `phase('Merge tier')`（`.claude/workflows/dev-flow.js`）、`classifyMergeTier`（`_lib/merge-tier.mjs`）、`_lib/merge-tier-facts.mjs`、
  `_lib/devflow-summary-format.mjs`、`_lib/journal-handoff.mjs`
