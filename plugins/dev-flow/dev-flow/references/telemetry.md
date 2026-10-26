# dev-flow telemetry キー

telemetry の各キーが何を表し、誰が読むか。不変条件は `.claude/rules/dev-flow.md` を参照。値の enum・要素の形・
算定式はここに写さず、決めているコード（定数名・ファイル）を指す。
本文のパスは `plugins/dev-flow/` を root とする plugin 相対パス。

## 経路

dev-flow.js / pr-iterate.js は run の終端（成功・失敗・abort）で telemetry handoff JSON を
`~/.claude/journal/pending/` へ書き出す。dev-flow plugin の Stop hook `hooks/stop-devflow-telemetry.sh` が handoff の
`.telemetry` を丸ごと `journal.sh log --telemetry-json` で渡し、object がそのまま journal entry の `telemetry` になる。
キーごとの flag・型/enum 検証は hook にも journal.sh にも持たない。hook は値が `null` のキーを落とし、
`PASSTHROUGH_NULLABLE_KEYS` に挙げたキーだけ `null` も記録する。`.telemetry` が object でない handoff は
`pending/malformed/` へ隔離し、flush の失敗は `~/.claude/logs/stop-devflow-telemetry.log` に残して pending file を消さない。

telemetry の読み手は `dev-flow-health` だけ。読み手は 2 種類で、キー一覧の「読み手」列に書く:

- `health-report.sh` が読む — `dev-flow-health/scripts/health-report.sh` が signature・状態・候補 commit を決める入力
- dev-flow-health の手読みだけ — LLM ステップが原因推定のときに該当 run の telemetry を手で読む

読み手の無いキーは書かない。書くキーは下の一覧に限り、`_lib/telemetry-keys.test.mjs` が workflow の telemetry
object literal（成功・失敗・abort）と VM 実行の handoff の両方で、一覧・entry 列・読み手列と突き合わせる。キーを足すときは
読み手を先に決め、この一覧と同テストを同時に更新する。いずれも記録専用で、gate・merge tier・ledger・shape 判定の
入力にはしない（軸A 非抵触）。

## キー一覧

| キー | entry | 読み手 | 表すもの |
|---|---|---|---|
| `merge_tier` | dev-flow / pr-iterate | dev-flow-health の手読みだけ | dev-flow は `classifyMergeTier` が決めた merge tier。pr-iterate は entry を見分ける固定値（`.claude/workflows/pr-iterate.js`） |
| `shape` | dev-flow | dev-flow-health の手読みだけ | Diff triage で `classifyShape` が realized diff から決めた実効 shape。判定前に終わった run には無い |
| `route` | dev-flow | dev-flow-health の手読みだけ | PR phase が通った経路（`.claude/workflows/dev-flow.js` の `route`） |
| `iterate_status` | dev-flow / pr-iterate | `health-report.sh` が読む | pr-iterate の終端 status。LGTM に届かなかった run を signature にする値は `HOLD_SIGNATURE_ITERATE_STATUSES` |
| `eval_verdict` | dev-flow | dev-flow-health の手読みだけ | evaluator の最終 verdict。Evaluate を走らせない run には無い |
| `duration_seconds` | dev-flow | dev-flow-health の手読みだけ | run 全体の wall-clock 秒。clock は下の「所要時間」 |
| `phase_durations` | dev-flow | dev-flow-health の手読みだけ | phase 別の秒数（phase は `CLOCK_PHASE_ENDS`）。clock は下の「所要時間」 |
| `eval_model_config` | dev-flow | dev-flow-health の手読みだけ | evaluator の model。frontmatter の値と workflow のリテラルの一致は `_lib/review-model-frontmatter.test.mjs` |
| `impl_model_config` | dev-flow | dev-flow-health の手読みだけ | dev-implementer の既定 model。一致は `eval_model_config` と同じテスト |
| `review_model_config` | dev-flow / pr-iterate | dev-flow-health の手読みだけ | pr-reviewer の model。一致は `eval_model_config` と同じテスト |
| `plugin_version` | dev-flow / pr-iterate | dev-flow-health の手読みだけ | 集計上区別したい挙動変更の世代ラベル（`_lib/plugin-version.mjs` の `PLUGIN_VERSION`） |
| `plugin_commit` | dev-flow / pr-iterate | `health-report.sh` が読む | 実行中の dev-flow plugin の commit。signature の first_seen / last_seen と候補 commit を決める |
| `final_test_flaky` | dev-flow | dev-flow-health の手読みだけ | test#final（Final reconcile が skip の run は Validate の最終結果）で落ち、落ちたファイルだけの再実行で green だった flake の記録（`_lib/final-test-rerun.mjs`） |
| `ci_wait_ceiling_seconds` | pr-iterate | dev-flow-health の手読みだけ | CI 待ちに使った上限秒（`_shared/scripts/ci-wait-ceiling.sh`、渡されなければ `CI_WAIT_CEILING_SECONDS`） |
| `ci_wait_seconds` | pr-iterate | dev-flow-health の手読みだけ | 全 round の CI 待ちの累積秒。上限に近い run が多ければ上限の決め方を見直す |
| `hold_reason_codes` | dev-flow | `health-report.sh` が読む | HOLD の run の HOLD 理由の code。signature にする code は `HOLD_SIGNATURE_CODES` |
| `hold_ac_human_judged` | dev-flow | `health-report.sh` が読む | 人手 AC 待ちの未達 AC に、文面ではなく判定で人手になった AC があるか（`_lib/ac-actor.mjs` の `hasJudgedHumanAcGap`） |
| `security_review_target` | pr-iterate | dev-flow-health の手読みだけ | 敵対的 security review の対象だったか。対象の run と対象外の run の所要を比べる |
| `security_review_rounds` | pr-iterate | dev-flow-health の手読みだけ | security review を回した回数。多い run の型を原因推定で読む |
| `security_review_status` | dev-flow / pr-iterate | `health-report.sh` が読む | pr-iterate の security review の結果（返り値の `security_review`）。非 LGTM の signature の細目 |
| `security_review_stop_reason` | dev-flow / pr-iterate | `health-report.sh` が読む | security review を前提チェックで止めた理由。ハーネスで止まった run を本物の指摘と別の signature にする |
| `fix_terminal_reason` | dev-flow / pr-iterate | `health-report.sh` が読む | pr-iterate の fix が失敗で終わったときの分岐（`.claude/workflows/pr-iterate.js` の `fixTerminalReason`）。非 LGTM の signature の細目 |
| `iterate_caller` | pr-iterate | `health-report.sh` が読む | pr-iterate の起動元。dev-flow から起動された entry は dev-flow entry の側で数える |

nested pr-iterate を起動した dev-flow run は pr-iterate と dev-flow の entry が 1 件ずつ残る。集計は dev-flow entry を使う。
どの経路（成功・失敗・abort）の entry がどのキーを持つかは workflow の telemetry object literal が決める。

### 所要時間

`duration_seconds` / `phase_durations` の clock は専用の probe を持たず、wrapper が渡す `args.setup.epoch` と、phase 境界に
隣接する既存の exec-proxy / agent 応答の optional epoch から給電する（mark の順と給電元は `_lib/devflow-durations.mjs`、
集計は `computeDurations`）。給電元の失敗はその mark に対応するキーの欠落になる（fail-open）。応答の完了タイミングに
よる skew を含むので、絶対値ではなく相対比較・分布に使う。どの phase にも属さない Setup の時間は
`duration_seconds` と `phase_durations` の合計の差として残る。

### `plugin_commit` の null

`dev-flow/scripts/plugin-commit.sh` で決められなかった run と nested 無しで Workflow を直接起動した run は `null`
（`normalizePluginCommit` が 12 桁 hex 以外を `null` に倒し、run は止めない）。`PASSTHROUGH_NULLABLE_KEYS` で `null` を
残すのは、「取得を試みて決められなかった」とキー欠落（キーを書く前の entry）を区別するため。

## 失敗・abort entry

telemetry とは別に、handoff の top-level に失敗の型（journal の `.error`）を載せる。`health-report.sh` は
`outcome` と `.error` から失敗の signature を作る。

- 失敗 run は `writeFailureTelemetry`、PR phase の失敗は `prPhaseFailure` の文面で記録する（PR phase 失敗の返り値は
  `dev-flow/SKILL.md`「PR phase 失敗の扱い」）
- abort（handoff 前の throw）は top-level の try/catch が `_lib/journal-handoff.mjs` の `buildAbortHandoffPayload` で記録し、
  元の例外を rethrow する。handoff の失敗は run の終了を妨げない（fail-open）

## run 返り値との関係

shape の判定根拠、Evaluate / Final reconcile の結果、HOLD 理由の文面と kind、pr-iterate の round 履歴などは run の
返り値と PR の終端サマリーにだけ載り、telemetry には書かない（読み方は `dev-flow/SKILL.md`「完了後の返り値の読み方」）。
journal に残る HOLD 理由は code だけ（`hold_reason_codes`）。
