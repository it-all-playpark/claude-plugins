# distrust / prescription 正当化クラス詳細

W7 distrust 正当化クラスと sunset path、prescription 正当化クラスと sunset path の詳細。
不変条件は `.claude/rules/dev-flow.md` を参照。本文中の `.claude/agents/` は
`plugins/dev-flow/` を root とする plugin 相対パス。

## distrust 機構の正当化クラス (W7)

dev-flow の各「distrust 機構」（LLM/自動化の判定を信用しきらず決定論・人間で gate する仕組み）は、
以下 **3 つの正当化クラスのいずれか**に必ず分類する。**正当化クラスと sunset path の無い distrust
機構は定義上「将来の技術的負債」**（モデルが賢くなっても撤去判断ができず過小活用が累積する）。
新しい distrust を足すときは必ずクラスを宣言し、capability-bound なら sunset path
（パラメータ値での表現 + 再評価トリガ）を併記すること。

| クラス | 正当化根拠 | 能力依存 | 代表機構 |
|--------|-----------|---------|---------|
| **incentive-structural**（永続・撤去禁止） | 敵対ループの勝利宣言を当事者に self-judge させない incentive 設計 + cold-context moving-target の抑制 | **非依存**（賢いモデルほどシャープな non-convergent nitpick を出すため逆に悪化） | frozen target（planSeen/evalSeen/blockSeen 累積）・既出 findings/feedback 累積・topic-stuck 検出 + relax + early-cutoff・critical-always-blocks + severity floor + append 単調性・hard cap（PLAN/EVAL/GREEN/BLOCK_MAX, last-resort safety net）・guard_blocked の replan 除外（guard/hook 由来 BLOCKED を「別アプローチ探索」ループに入れず blockedConcerns→evaluator focus へ直行 — guard 迂回手順の探索 incentive を絶つ）・blocking_reason 決定論スクラバー（迂回コマンド列の replan/evaluator prompt への verbatim 伝播遮断）・review-finding 決定論スクラバー（pr-iterate の blocking finding description/suggestion の fix prompt への verbatim 伝播遮断 — メタ指示が実行指示へ変換される経路を断つ）・analyze provenance 突合（取得 issue 番号/title の決定論突合で REQ 捏造を反証可能化 — 取得成功の self-judge をさせない fail-closed） |
| **blast-radius**（永続） | 不可逆性 / accountability / liability / blast-radius。正確性ではなく当事者性で正当化するため frontier が人間を超えても残る | **非依存** | human merge（accountability/不可逆/values/novelty）・danger-grep on realized diff → security path 強制・seeded SEC + merge tiering HOLD（danger/breaking/不可逆）・pr-iterate critical/major-always-blocks（merge 直前の最終ゲート: この先は human merge のみで、ここで relax すると既知の critical/major が出荷される。修正コストは PR スコープに bounded）・Final reconcile（pr-iterate fix 適用後の最終 tree に対する決定論 test 再実行 + 既存 AC の one-shot 再検証（fail は critical AC-FINAL append・既存 checked は不変の append 単調） → red/unavailable で HOLD。merge 直前の最終ゲート）・sunset 昇格の issue→人間 merge 経由・dev-flow-health の status / 候補 commit 判定は決定論 script のみ（health-report.sh — LLM に解消・再発の self-judge をさせない）・TESTSURF seeding（test-weakening 決定論検出 + evaluator clearance、merge tier HOLD）・lite route の pr-reviewer 1-pass → critical/major findings 検出で `workflow('dev-flow:pr-iterate-run')` フル fix loop へ自動昇格（critical/major-always-blocks 不変。縮約経路でも merge 直前のゲートを維持）・信頼境界をまたぐ PR の security review（対象判定は realized diff / PR diff の決定論判定のみ — LLM に「対象外」を self-judge させない。対象の PR は security-reviewer が critical/major 0 件を返すまで LGTM にせず、上限で `security_unresolved` → merge tier `security_review_unresolved` HOLD。sandbox の外の書き込み・コード実行は出荷後に取り消せない） |
| **capability-bound**（**sunset 対象**） | 現行 LLM judge の信頼性不足（ECE≈39% / FPR≈35%）。モデルが賢くなるほど縮む | **依存** | `gate_policy = llm-major-advisory`（LLM major を blocking にしない distrust）・pr-reviewer とは別の security review 段（pr-reviewer の 1 回の full review と delta review だけでは列挙外の攻撃経路を拾い切れない distrust。`SECURITY_REVIEW_MAX` と対象判定の規則）・trust-layer 3 層（SurfaceProof / EvalSeal / EffectDelta。call site・exec-proxy・kernel・doctor レポート・telemetry 転送は全て撤去済み。復帰は下記 sunset path に従う） |

**capability-bound の sunset path（必須）**: パラメータ値で表現し再評価トリガを持たせる。
`gate_policy` の sunset path —
- 表現: `gate_policy` enum 値（`llm-major-advisory` → `llm-major-blocking`）。
- 再評価トリガ: **major モデルリリース毎** + W6b の calibration monitor が当該カテゴリの
  judge を well-calibrated と実証した時点。実証されたら `gate_policy` を LLM 側（blocking）へ進める。

pr-iterate major 閾値の sunset path —
- pr-iterate の critical/major-always-blocks は主分類 blast-radius（永続）だが、**major 閾値**（pr-reviewer の major 判定を blocking に含める線引き）は LLM judge の信頼性に**能力依存**する capability-bound 側面を持つ。critical-always-blocks 部分は永続で sunset しない。
- 表現: 将来 pr-iterate の major blocking 判定を `gate_policy` 連動（`llm-major-advisory` 系の値で major を advisory 化）にする形で表現する — 現在は policy 非連動の固定値（critical/major 常時 blocking）。
- 再評価トリガ: W6b の calibration monitor が pr-reviewer の major judge を well-calibrated と実証した時点で `gate_policy` 連動へ移行する。実証まではゲート後退（relax）させない。

redgreen vdelta deny の sunset path —
- 主分類は incentive-structural（red→green 昇格の勝利宣言を test 変更込みで self-judge させないラベル精度保護）だが、**blocking ゲート化しない点**（deny-only 存置）は capability-bound。
- 表現: 昇格条件の deny `&&` 節（deny-only）。
- 再評価トリガ: veridelta が record_integrity を advisory から昇格（INV-10 解消）し W6b calibration が vdelta verdict の precision を実証した時点で blocking gate 化を再評価する。

security review 段（pr-iterate の `security-reviewer`、issue #1063）の sunset path —
- 主分類は blast-radius（永続）: 信頼境界をまたぐ PR で critical/major が残るうちは LGTM にしない部分と、対象判定を
  決定論に限る部分（LLM に対象外を判定させない）は撤去しない。毎回新しい spawn に PR 全 diff を読ませる部分は
  incentive-structural（fix の差分・既出の指摘に引きずられると、fix が持ち込んだ別経路や列挙外の攻撃を見落とす）。
- capability-bound 側面は「pr-reviewer とは別の段を置くこと」そのものと反復上限。現行の pr-reviewer は宣言意図との照合が
  主で、iteration 2 以降は fix delta しか読まないため、#1058 の hardlink 経由の書き込み・frontmatter 注入・保存先内の
  `.git/config` 書き換えを拾えなかった。
- 表現: `_lib/security-review.mjs` の `SECURITY_REVIEW_MAX = 3`（1 run の security-reviewer の spawn 上限 = 初回 + fix 後の
  確認 2 回）と、`_lib/security-review-target.mjs` の規則（`permission_config` / `sandbox_boundary` / `path_write`）。
- 再評価トリガ: **major モデルリリース毎** + pr-iterate entry の telemetry `security_review_rounds` /
  `security_review_blocking` の実測。pr-reviewer が LGTM を出した後の security review が critical/major を返さない run が
  続く（security review が新しい指摘を出さない）なら、段を pr-reviewer の full review に畳むか上限を下げる。逆に上限で
  `security_unresolved` が続くなら上限か規則を見直す。

trust-layer（SurfaceProof / EvalSeal / EffectDelta）の sunset path —
- call site・exec-proxy・kernel・doctor レポート・telemetry 転送は全て撤去済み（接続点は残さない）。復帰は
  `.claude/rules/dev-flow.md` の sunset トリガ「trust-layer 復帰 → 3 条件を満たす再設計のみ」に従う。

逆に incentive-structural / blast-radius はモデル更新で撤去してはならない（軸A 保持）。

## 指示の規範性 (prescription) の正当化クラス

dev-flow の agent 指示・guardrail（`.claude/agents/*.md` の指示ブロック等、agent に「こう振る舞え」と
規範を課す記述）は、以下 **3 つの正当化クラスのいずれか**に必ず分類する。**正当化クラスの無い指示は
W7 の distrust 機構と同様「将来の技術的負債」**（モデルが賢くなっても削減判断ができず prompt 肥大が
累積する）。W7 が「LLM の出力を信用しない仕組み」の分類であるのに対し、本節は「LLM への指示の
規範性」の分類である。

| クラス | 正当化根拠 | 能力依存 | 判定基準 |
|--------|-----------|---------|---------|
| **contract**（永続） | 指示がインターフェース契約そのもの（出力 JSON schema・StructuredOutput 呼び出し義務・Boundary（触ってはいけないファイル・commit 禁止）・入出力キーの意味定義）。呼び出し側 workflow の parse / gate がその記述に依存するため、モデルがどれだけ賢くても明示が必要 | **非依存** | 指示を削除すると workflow 側の schema 検証・phase 遷移が壊れる、または契約が暗黙化して呼び出し側と drift する |
| **incentive-structural**（永続） | 賢いモデルでも incentive 構造・context 構造上、放置すると守られない方向に傾く指示。例: self-judge 禁止（勝利宣言を当事者にさせない）、feedback 全件対応義務（critical を握りつぶす incentive の抑制）、self-contained 記述強制（cold-context の implementer に周辺 context が無いという構造要因）、topic 反復時のアプローチ変更強制 | **非依存**（賢いモデルほど巧妙に逸脱し得る） | 逸脱がモデルの能力不足ではなく optimization pressure または context 分断に由来する |
| **capability-bound**（**sunset 対象**） | 現行モデルの能力不足を補う手取り足取り指示。例: 詳細な手順分解（step-by-step 列挙）、禁止表現の具体列挙、書き直し例・few-shot 例示、判定基準の過剰な具体化 | **依存** | frontier モデルなら指示なしでも同じ品質の出力が期待でき、指示の役割が「現行モデルの取りこぼし防止」のみである |

**capability-bound の sunset path（必須）**: capability-bound に分類した指示には sunset path を必ず
併記する。既存 gate_policy sunset path と同基準で、以下 2 項目を書く。
- 表現: どの指示ブロック（ファイル・セクション）を削減・パラメータ化するか。
- 再評価トリガ: **major モデルリリース毎**（品質ゲート agent の frontmatter model の世代交代時）に当該指示を外した
  dry-run / 実測で品質劣化が無いことを確認してから削減する。

新しく指示・guardrail を足すときは必ずクラスを宣言し、capability-bound なら sunset path
（表現 + 再評価トリガ）を併記すること。
