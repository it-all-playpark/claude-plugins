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
| **incentive-structural**（永続・撤去禁止） | 敵対ループの勝利宣言を当事者に self-judge させない incentive 設計 + cold-context moving-target の抑制 | **非依存**（賢いモデルほどシャープな non-convergent nitpick を出すため逆に悪化） | frozen target（planSeen/evalSeen/blockSeen 累積）・既出 findings/feedback 累積・topic-stuck 検出 + relax + early-cutoff・critical-always-blocks + severity floor + append 単調性・hard cap（PLAN/EVAL/GREEN/BLOCK_MAX, last-resort safety net）・guard_blocked の replan 除外（guard/hook 由来 BLOCKED を「別アプローチ探索」ループに入れず blockedConcerns→evaluator focus へ直行 — guard 迂回手順の探索 incentive を絶つ）・blocking_reason 決定論スクラバー（迂回コマンド列の replan/evaluator prompt への verbatim 伝播遮断）・review-finding 決定論スクラバー（pr-iterate の blocking finding description/suggestion の fix prompt への verbatim 伝播遮断 — メタ指示が実行指示へ変換される経路を断つ）・analyze provenance 突合（取得 issue 番号/title の決定論突合で REQ 捏造を反証可能化 — 取得成功の self-judge をさせない fail-closed）・敵対的 security review の対象判定（決定論の許可リストだけで対象外を決め、判定不能は対象・run 中に一度でも対象なら対象のまま — LLM triage・列挙型の素通りを断つ）と security-reviewer の運用（毎回新しい spawn・`reviewed_sha` 一致・PR 本文/diff/コメントはデータ・公開コメントは件数だけ） |
| **blast-radius**（永続） | 不可逆性 / accountability / liability / blast-radius。正確性ではなく当事者性で正当化するため frontier が人間を超えても残る | **非依存** | human merge（accountability/不可逆/values/novelty）・danger-grep on realized diff → security path 強制・seeded SEC + merge tiering HOLD（danger/breaking/不可逆）・pr-iterate critical/major-always-blocks（merge 直前の最終ゲート: この先は human merge のみで、ここで relax すると既知の critical/major が出荷される。修正コストは PR スコープに bounded）・Final reconcile（pr-iterate fix 適用後の最終 tree に対する決定論 test 再実行 + 既存 AC の one-shot 再検証（fail は critical AC-FINAL append・既存 checked は不変の append 単調） → red/unavailable で HOLD。merge 直前の最終ゲート）・sunset 昇格の issue→人間 merge 経由・dev-flow-health の status / 候補 commit 判定は決定論 script のみ（health-report.sh — LLM に解消・再発の self-judge をさせない）・TESTSURF seeding（test-weakening 決定論検出 + evaluator clearance、merge tier HOLD）・lite route の pr-reviewer 1-pass → critical/major findings 検出で `workflow('dev-flow:pr-iterate-run')` フル fix loop へ自動昇格（critical/major-always-blocks 不変。縮約経路でも merge 直前のゲートを維持）・敵対的 security review（信頼境界をまたぎうる PR は critical/major 0 件の review を今の head で通すまで LGTM にしない。下記） |
| **capability-bound**（**sunset 対象**） | 現行 LLM judge の信頼性不足（ECE≈39% / FPR≈35%）。モデルが賢くなるほど縮む | **依存** | `gate_policy = llm-major-advisory`（LLM major を blocking にしない distrust）・trust-layer 3 層（SurfaceProof / EvalSeal / EffectDelta。call site・exec-proxy・kernel・doctor レポート・telemetry 転送は全て撤去済み。復帰は下記 sunset path に従う） |

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

trust-layer（SurfaceProof / EvalSeal / EffectDelta）の sunset path —
- call site・exec-proxy・kernel・doctor レポート・telemetry 転送は全て撤去済み（接続点は残さない）。復帰は
  `.claude/rules/dev-flow.md` の sunset トリガ「trust-layer 復帰 → 3 条件を満たす再設計のみ」に従う。

敵対的 security review（`_lib/security-review-scope.mjs` / `_lib/security-review.mjs` / `agents/security-reviewer.md`。
経路は pipeline.md「敵対的 security review」）—
- 主分類: **blast-radius**（永続）。信頼境界をまたぎうる変更（sandbox の外で動く CLI・hook・設定・指示ファイル）の
  critical / major は出荷後に取り返せず、eval pass・pr-iterate LGTM の後に外部 review が書き込み経路を見つけた実例がある。
  merge 直前の最終ゲートなので、対象の PR は critical / major 0 件の review を今の head で通すまで LGTM にしない
  （`security_unresolved` / Merge tier の `security_review_unresolved`）。gate_policy で緩めない。
- 対象判定を決定論の許可リストだけに置き、判定できない入力を対象にする（fail-closed）のは **incentive-structural**（永続）。
  危ない変更を列挙して当たったものだけを対象にすると列挙の抜けが黙って素通りし、LLM に対象外を決めさせると diff 本文による
  誘導・黒塗り・切り詰めで素通りできる — どちらも賢いモデルほど巧妙に抜け道を作れるため能力に依らない。
- 起動時・run 中の判定のどれか 1 回でも対象なら run の終わりまで対象（sticky）、毎回新しい spawn で PR 全 diff を読ませる、
  前回の未解消の指摘を確かめる項目として渡す、`reviewed_sha` と今の head の一致を clear の条件にする、reviewer を worktree の
  外で読み取り専用にし PR 本文・diff・コメントをデータとして扱わせる、公開コメントに件数だけを出す — いずれも
  **incentive-structural**（永続）。diff を書き換えて判定だけをすり抜ける・古い diff の review で clear にする・攻撃者が書いた
  文に reviewer が従う・公開コメントが攻撃手順になる、を構造で断つ。
- reviewer の session に自動で読み込まれる指示ファイルを変える PR を自動の review で clear にしない
  （`reviewer_context_changed`）、security-scope の CLI の出力に PR 由来の文字列を載せない、は **incentive-structural**（永続）。
  判定者・判定の中継者が攻撃者の書いた文を指示として受け取る経路を、prompt の文ではなく構造で断つ。cwd の扱いは
  **harness-capability-bound** な面もあり、`agent()` が cwd を受け付けるようになった時点で reviewer を worktree の外の cwd で
  起動する形に移す（`/dev-flow-canary` の report で判定）。それでも `reviewer_context_changed` の停止は残す。
  Codex 経路はこの停止をせず、中継の Bash を workflow の prompt の行に、返り値を実 stdout に hook で縛る（**incentive-structural**・永続。
  中継が攻撃者の文を読める限り prompt の文では誘導を否定できない）。Codex で判定できない round は Claude 経路に倒さずに止める。
- sunset しない。許可リストを広げるときは、広げる種類が agent の指示として読まれず実行もされないことを示してからにする。

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
