# dev-flow telemetry キー詳細

telemetry handoff の各キーの語彙定義と Stop hook の転送。不変条件は `.claude/rules/dev-flow.md` を参照。
本文中の `.claude/workflows/` / `_lib/` は `plugins/dev-flow/` を root とする plugin 相対パス。

## 経路

dev-flow.js / pr-iterate.js は run の終端（成功・失敗・abort）で telemetry handoff JSON を
`~/.claude/journal/pending/` へ書き出し、dev-flow plugin の Stop hook `hooks/stop-devflow-telemetry.sh`
（`hooks/hooks.json` から plugin root 変数経由で発火）が `journal.sh log` へ毎回自動 flush する。flush 失敗は
`~/.claude/logs/stop-devflow-telemetry.log` に記録され pending file が残るため記録漏れに気づける。

telemetry の読み手は `dev-flow-health` だけ。`health-report.sh` がプログラムから読むのは `plugin_commit` と、HOLD の run の `hold_reason_codes` / `hold_ac_human_judged` / `iterate_status`、
非 LGTM の細目の `fix_terminal_reason` / `security_review_status` / `security_review_stop_reason`、pr-iterate entry の `iterate_caller`、
LLM ステップは原因推定のときに該当 run の telemetry を手で読む。読み手の無いキーは書かない — 書くキーは下の
23 個に限り、`_lib/telemetry-keys.test.mjs` が workflow の telemetry object literal（成功・失敗・abort）と
VM 実行の handoff の両方で pin する。キーを足すときは読み手を先に決め、この一覧と同テストを同時に更新する。
いずれも記録専用で、gate・merge tier・ledger・shape 判定の入力にはしない（軸A 非抵触）。

## キー一覧

| キー | entry | 経路 | 値 |
|---|---|---|---|
| `merge_tier` | dev-flow / pr-iterate | dev-flow: 成功、pr-iterate: 成功・abort | dev-flow は `classifyMergeTier` の tier（`AUTO` / `REVIEW` / `HOLD`）、pr-iterate は固定値 `PR_ITERATE` |
| `shape` | dev-flow | 成功・PR phase 失敗・abort（実効 shape 確定後のみ） | 実効 shape（`micro` / `standard` / `complex`） |
| `route` | dev-flow | 成功 | PR phase の経路（`lite` / `full`） |
| `iterate_status` | dev-flow / pr-iterate | 成功 | pr-iterate の終端 status（`lgtm` / `stuck` / `fix_failed` / `max_reached` / `ci_error` / `ci_pending` 等）。nested pr-iterate が status を返さない run ではキー欠落 |
| `eval_verdict` | dev-flow | 成功・PR phase 失敗 | evaluator の最終 verdict。Evaluate を走らせない run（micro の skip）ではキー欠落 |
| `duration_seconds` | dev-flow | 成功・PR phase 失敗 | run 全体の wall-clock 秒（clock#start 〜 clock#end） |
| `phase_durations` | dev-flow | 成功・PR phase 失敗 | implement / validate / evaluate / pr / iterate / final の phase 別秒数 object |
| `eval_model_config` | dev-flow | 成功・失敗・abort | evaluator に渡す model（`opus`） |
| `impl_model_config` | dev-flow | 成功・失敗・abort | dev-implementer の既定 model（`opus`） |
| `review_model_config` | dev-flow / pr-iterate | 成功・失敗・abort | pr-reviewer に渡す model（`opus`） |
| `plugin_version` | dev-flow / pr-iterate | 成功・失敗・abort | `_lib/plugin-version.mjs` の `PLUGIN_VERSION` |
| `plugin_commit` | dev-flow / pr-iterate | 成功・失敗・abort | 実行中の dev-flow plugin の skills repo commit SHA 先頭 12 桁、決められなければ `null` |
| `final_test_flaky` | dev-flow | 成功（flake の run のみ） | test#final で落ち、落ちたファイルだけの単体再実行で green だったテストファイルと 1 回目のログのパス `{files, logs}` |
| `ci_wait_ceiling_seconds` | pr-iterate | 成功（nested・単体起動とも） | CI 待ちに使った上限（秒）。prerun が base branch の CI 所要時間から決めた `args.ci_wait_ceiling_seconds`、渡されなければ 300 |
| `ci_wait_seconds` | pr-iterate | 成功（nested・単体起動とも） | 全 round の CI 待ちの nominal 累積秒（返り値の `ci_wait_seconds` と同じ値） |
| `hold_reason_codes` | dev-flow | 成功（merge tier が `HOLD` の run のみ） | HOLD 理由の code の配列（返り値の `merge_tier_hold_reasons[].code` と同じ順） |
| `hold_ac_human_judged` | dev-flow | 成功（merge tier が `HOLD` の run のみ） | 人手 AC 待ちの未達 AC に、文面で人手になった AC（`HUMAN_AC_PATTERNS` に当たる・`classifyAcScope` が `external`）ではない AC が 1 件以上あるか（boolean） |
| `security_review_target` | pr-iterate | 成功（nested・単体起動とも） | 敵対的 security review の対象だったか（boolean。起動時の判定 `args.security_review` と LGTM 前の `security-scope#i` のどれか 1 回でも対象なら true、`args.security_review` が無い run も true） |
| `security_review_rounds` | pr-iterate | 成功（nested・単体起動とも） | security-reviewer を spawn した回数（LGTM の候補になった round ごとに 1 回） |
| `security_review_status` | dev-flow / pr-iterate | 成功 | pr-iterate の返り値 `security_review.status`（`not_target` / `cleared` / `unresolved` / `not_run`）。dev-flow は nested pr-iterate が返した値で、返さない run（lite の clean 終端）ではキー欠落 |
| `security_review_stop_reason` | dev-flow / pr-iterate | 成功 | pr-iterate の返り値 `security_review.stop_reason`（review の前提チェックで止めた理由の固定 code。`reviewer_context_changed` 等）。止めていない run ではキー欠落 |
| `fix_terminal_reason` | dev-flow / pr-iterate | 成功 | pr-iterate の返り値 `fix_terminal_reason`（`fix_failed` の分岐 `null_after_retry` / `applied_false` / `commit_unensured`）。`fix_failed` 以外の run ではキー欠落 |
| `iterate_caller` | pr-iterate | 成功（nested・単体起動とも） | pr-iterate の起動元。`args.nested.caller` の `dev-flow` / `standalone`、nested 無しの直接起動は `direct` |

nested pr-iterate を起動した dev-flow run は pr-iterate と dev-flow の entry が 1 件ずつ残る。集計は dev-flow entry
を使う。

### 値の補足

- `shape`: Security floor で `classifyShape(req, realizedCount, lineStats)` が realized diff の file 数・行数 +
  AC 数 / `issue_type` / 構造化 `breaking_change` で決めた値（事前見積もりは持たない）。判定根拠 `shape_reason`
  と `realized_file_count` は run の返り値に載り、telemetry には書かない。Security floor 前の失敗・abort は
  shape キーを持たない。
- `duration_seconds` / `phase_durations`: 各 phase は開始〜終了の全体時間（evaluate 差し戻し loop 等の内部反復を
  含む）。evaluate 区間は Security floor を含む。micro path（Evaluate skip）では evaluate キー自体が欠落し pr は直近
  mark（validate_end）起点で計算される。時刻は専用 clock probe を起動せず、start は wrapper（dev-flow-prerun、
  top-level Bash）が渡す `args.setup.epoch`、end は Merge tier 末尾の post-summary 応答の optional epoch から給電し、
  implement 区間の起点 `setup_end` は `args.setup.epoch_end`（prerun の後に wrapper が回す
  `ensure-worktree-deps --setup` の deps install 完了時）から、残りの mark は phase 境界に隣接する既存 exec-proxy / agent 応答の optional epoch から給電する
  （fail-open）。**給電元応答の完了タイミング依存の skew を含むため、絶対値ではなく相対比較・分布用途で解釈すること。
  start〜setup_end（deps install 等の prerun 決定論処理 + wrapper turn）はどの phase にも属さない残差
  （duration_seconds − Σphase_durations）。deps install は prerun（repo の任意コードを実行しない）の子にせず
  別呼び出しで回す（issue #868）ので、analyze 段と deps install は並列ではなく直列になり、この残差はその分長い。Final reconcile skip 時（fixes_applied=0）は final キー自体が欠落する**。
  PR phase 失敗の run は pr_end と end を PR phase proxy（`pr#<issue>`）応答の epoch から給電し、iterate / final キーを持たない。
  mark 取得失敗は当該 duration キーの欠落（全滅時は両キーとも出ない）。
- `eval_model_config` / `review_model_config` / `impl_model_config`: 3 agent とも override を渡さず frontmatter
  （`agents/evaluator.md` / `agents/pr-reviewer.md` / `agents/dev-implementer.md` の `model`）で spawn する。agent()
  は agentType しか観測できず frontmatter 由来の実モデルを workflow から取得できないため、workflow 側のリテラルと
  frontmatter の一致を `_lib/review-model-frontmatter.test.mjs` が pin する。green-fix の `sonnet` override は固定値
  なのでキーを持たない（世代は `plugin_version` で分かる）。evaluator / dev-implementer を spawn しない pr-iterate
  entry には `eval_model_config` / `impl_model_config` を載せない。
- `plugin_version`: workflow では plugin root 変数が展開されず fs も使えないため定数で持つ。plugin.json は version
  を持たない（marketplace install を git commit SHA で main に追随させるため）ので、manifest から独立した集計用の
  世代ラベルとして扱い、集計上区別したい挙動変更を入れるときに canonical を上げて `tools/sync-inlines.mjs --write`
  を実行する。
- `plugin_commit`: 「どの commit から失敗し始めたか / 修正後に再発していないか」を割り出すための値。
  `dev-flow-prerun` が `dev-flow/scripts/plugin-commit.sh` で plugin root から決め（cache mode はディレクトリ名、
  link mode は checkout の HEAD）、`args.setup.plugin_commit` → nested pr-iterate へは `args.plugin_commit` で渡る。
  単体起動の pr-iterate は `pr-iterate-prerun` が同じ `plugin-commit.sh` で決め、wrapper が `args.plugin_commit` で渡す。
  nested 無しで Workflow を直接起動した run は `null`。12 桁 hex 以外は `normalizePluginCommit`
  （`_lib/plugin-version.mjs`）が `null` に倒し run を止めない。キー欠落は本キー導入前の entry を意味する。
- `final_test_flaky`: Final reconcile が `_lib/final-test-rerun.mjs` で flake と判定した記録（issue #865）。test#final が
  red で `failed_files` が非空のとき、そのファイルだけを `run-tests <WT> --files …` で 1 回流し直し、green なら
  `final_test_green` を true にして載せる。同じファイルが run をまたいで繰り返し載るなら、そのテストの負荷耐性を
  直す issue の根拠になる（原因推定ではこのキーと `logs` の 1 回目の出力を読む）。再実行も red・再実行しなかった run には載らない。
- `ci_wait_ceiling_seconds` / `ci_wait_seconds`: `ci_pending` で終わった run が「上限が CI 所要時間に足りなかった」のか
  「CI 自体が詰まっていた」のかを、原因推定で切り分けるための値。上限は prerun の
  `_shared/scripts/ci-wait-ceiling.sh` が base branch の直近 20 件の成功 run の所要時間の p90 + 60 秒を 300〜900 秒に
  収めて決める（履歴 5 件未満・gh の読み取り失敗は 300）。`ci_wait_seconds` が上限に近い run の数で、上限の求め方を見直す。
  nested 起動でも pr-iterate entry に載る（dev-flow entry には載せない）。
- `hold_reason_codes` / `hold_ac_human_judged`: dev-flow 自身や実行環境の不具合で出た HOLD を `dev-flow-health` が
  signature にするための値（issue #1055）。HOLD の run も `outcome` は `success` のままなので、`health-report.sh` は
  この 2 つと `iterate_status` から、異常とする HOLD 理由（一覧は `health-report.sh` の `HOLD_SIGNATURE_CODES` /
  `HOLD_SIGNATURE_ITERATE_STATUSES`）を 1 つずつ signature にする。`hold_ac_human_judged` が true なのは、観測型の
  判定（`observational:true`）か evaluator の `unreachable_env:true` で人手になった AC が未達のとき
  （`_lib/ac-actor.mjs` の `hasJudgedHumanAcGap`）。merge tier が `HOLD` 以外の run には両キーとも載らない。

- `security_review_target` / `security_review_rounds`: 信頼境界をまたぎうる PR を既定で敵対的 security review に通す
  ようにした（issue #1063）ことで、run 時間とコストがどれだけ増えたかを見るための値。対象の run と対象外の run の
  `duration_seconds`（dev-flow entry）を比べ、`security_review_rounds` が多い run の型（critical/major が残り続ける・
  `security_unresolved` で終わる）を原因推定で読む。指摘の件数・本文は telemetry に書かない（件数は返り値の
  `security_review`、本文は fix の prompt にだけ渡る）。
- `security_review_status` / `security_review_stop_reason` / `fix_terminal_reason` / `iterate_caller`: pr-iterate が LGTM に
  届かなかった run（`security_review_unresolved` の HOLD と `iterate_status` の `stuck` / `fix_failed` / `max_reached` /
  `security_unresolved`）を、`health-report.sh` が止めた理由・fix の終わり方の細目で signature に分けるための値。
  ハーネスのループで止まった run（`stop=reviewer_context_changed` 等）と本物の指摘で止まった run を別の signature にする。
  `iterate_caller` が `dev-flow` の pr-iterate entry は signature にも resolved の判定にも入れない（その run は dev-flow
  entry の HOLD の側で数える）。値が無いとき workflow は `null` を handoff に載せ、Stop hook が落とす（キー欠落）。

## 失敗・abort entry

telemetry とは別に、handoff の top-level に失敗の型を載せる（journal の `.error`）。

- 失敗 run（`writeFailureTelemetry`）: `outcome:'failure'` + `error_category`（`needs_clarification` / `empty_diff`）+
  `error_msg`。cross-repo issue（修正対象が本 repo 外）で empty-diff gate が graceful 終了する run は
  `outcome:'partial'` + `error_category:'cross_repo'` を記録し、dev-flow の返り値は `status:'cross_repo_artifact'`
  （`issue`/`worktree`/`branch`/`artifacts`/`note` を含む）を返す。dev-flow-health の失敗の型
  （`outcome == "failure"` のみ集計）には混ぜない。
- PR phase 失敗（`pr#<issue>` の proxy が commit / push / `gh pr create` のどこかで中断した run）: throw せず
  `outcome:'failure'` + `error_category:'pr_phase_failed'` + `error_phase:'PR'` + `error_msg`（`prPhaseFailure` の
  1 文: `dev-flow: PR phase 失敗（step: <failed_step>、reason: <failure_reason>[、push 出力全文: <path>]）— proxy 応答 …`）
  を記録する（logLabel は `journal-log-failure`）。telemetry は `shape` / `eval_verdict` / `duration_seconds` /
  `phase_durations` と世代・model キー。dev-flow-health の失敗 signature は `dev-flow | pr_phase_failed | PR | <template>`
  になる。abort entry は書かない（Implement〜Evaluate を終えた run の成果物・所要時間を残し、回収を wrapper の
  issue コメントへ渡すため。返り値は `dev-flow/SKILL.md`「PR phase 失敗の扱い」）。
- guard/hook 由来 BLOCKED（block_class:'guard_blocked'）が Implement phase で 1 件以上発生した成功 run は、
  `outcome:'success'` のまま `error_category:'guard_blocked'` が付く。
- abort: run が journal handoff 到達前に throw した場合、dev-flow.js / pr-iterate.js の top-level try/catch が
  `outcome:'failure'` + `error_category:'abort'` + `error_msg:'abort@<phase>/<label>: <message>'`（500 字まで）+
  `error_phase`（journal の `.error.phase`。dev-flow-health の失敗 signature に入る）を記録し、元の例外を rethrow
  する（fail-open: handoff 失敗は run 終了を妨げない。終端サマリ・Merge tier は実行しない — 判定前提が揃わないため）。
  abort entry の組み立て口は `_lib/journal-handoff.mjs` の `buildAbortHandoffPayload` のみ。handoff は payload を
  pending/ へ直接書くので、WT 未確定の abort（Setup の args.setup 検証段）も同じ経路で記録する。empty_diff 経路は
  writeFailureTelemetry が先に記録済みなので abort entry を二重記録しない。

## Stop hook の転送

`hooks/stop-devflow-telemetry.sh` は handoff の `.telemetry` を丸ごと `journal.sh log --telemetry-json` で渡す。
キーごとの flag・型/enum 検証は持たず、journal.sh も telemetry 用の個別 flag を持たない（`--telemetry-json` の
object がそのまま entry の `telemetry` になる）。hook は値が `null` のキーを落とすが、`PASSTHROUGH_NULLABLE_KEYS`
に挙げたキー（`plugin_commit`）は `null` も JSON null として記録する — `plugin_commit` は「取得を試みて決められな
かった」（`null`）とキー欠落（導入前の entry）を区別するため。`.telemetry` が object でない handoff は malformed と
して `pending/malformed/` へ隔離する。

## run 返り値との関係

shape の判定根拠、Evaluate / Final reconcile の結果、danger / testsurf の hit、pr-iterate の round 履歴・
CI 待ち・終端理由などは run の返り値に載り、telemetry には書かない（読み方は `dev-flow/SKILL.md`
「完了後の返り値の読み方」）。返り値には加えて `merge_tier_hold_reasons`（`[{reason, kind}]`。`kind` は
`deterministic_recheck`（決定論再チェックで解消しうる HOLD。Final reconcile unavailable の CI 不成立理由のうち
pending / fetch-failed / invalid）と `human_judgment`（人間判断が必須な HOLD）の 2 値 closed enum）と
`merge_tier_hold_kind`（集約値。human_judgment が 1 件でもあれば `human_judgment`、全件 deterministic_recheck なら
`deterministic_recheck`、tier が HOLD でなければ `null`）が乗る。journal に残るのは code だけ（telemetry の
`hold_reason_codes`）で、reason の文面と `kind` は返り値と PR の終端サマリーにだけ載る。
