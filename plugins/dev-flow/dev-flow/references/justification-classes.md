# 正当化クラスごとの機構

`.claude/rules/dev-flow.md`「正当化クラス（W7）」のクラスに属する distrust 機構と agent への指示の一覧。クラスの定義と
クラス単位の理由は rules に置き、ここは機構の列挙だけを持つ。ここの機構はすべて永続で、モデル更新で撤去しない。
capability-bound へ移さず、`capability-bound.md` に載せない（capability-bound は sunset で撤去されうるため、移すと gate が抜ける）。
敵対的 security review の機構は rules と `security-review.md` が持つ。

## incentive-structural

勝利宣言の self-judge と moving target を断つ。

- frozen target: `evalSeen` / `blockSeen` / `reviewSeen`
- stuck 打ち切り: `EVAL_STUCK` / `REVIEW_STUCK`
- critical の append と severity `floor`
- hard cap: `EVAL_MAX` / `GREEN_MAX` / `BLOCK_MAX` / `DESIGN_REPLAN_MAX` / `AGENT_AC_REIMPL_MAX`
- guard_blocked の replan 除外
- blocking_reason 決定論スクラバー（`scrubBlockingDetail`）
- review-finding 決定論スクラバー（`scrubReviewFindingText`。finding の文を fix prompt へ verbatim に流さない）

## 指示の incentive-structural

逸脱が optimization pressure・context 分断に由来する指示。

- self-judge 禁止
- feedback 全件対応
- self-contained 記述
- topic 反復でアプローチ変更

## blast-radius

不可逆性・accountability で正当化する。

- human merge
- danger-grep → security path
- seeded SEC と HOLD
- pr-iterate の critical/major-always-blocks
- Final reconcile
- TESTSURF seeding
- lite route の critical/major で昇格
- health の status 判定は `health-report.sh` だけ
- sunset 昇格は人間 merge 経由
