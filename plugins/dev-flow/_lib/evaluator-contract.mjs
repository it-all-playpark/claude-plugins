// Evaluator operational contract shared by dev-flow.js and evaluator.md.
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。

export const EVALUATOR_OPERATIONAL_CONTRACT = {
  critical_resolutions: [
    'critical_resolutions 契約:',
    '- prompt に「未解消 critical 一覧」が渡された場合、各 item を実コードで再検証し、critical_resolutions:[{id, resolved, evidence}] で全件判定して返す。',
    '- id は渡された item の id をそのまま返す。',
    '- resolved:true は具体的 evidence 必須（file:line / テスト名 / diff 内容）。未解消なら resolved:false。',
    '- 既出 critical の解消状況は feedback ではなく critical_resolutions で返す。feedback[] への再報告は不要。',
    '- critical_resolutions が解消判定の唯一の経路。返さない item は未解消のまま据え置かれ収束しない。',
  ].join('\n'),
  security_clearance: [
    'security_clearance 契約:',
    '- security_focus が渡された場合、各 danger_class の変更が安全かを判定し、security_clearance:[{danger_class, cleared, evidence}] で返す。',
    '- danger_class は渡された危険クラス名をそのまま返す。',
    '- 安全確認できないものは cleared:false。',
    '- cleared:true は具体的 evidence 必須。evidence のない cleared:true は無視され、SEC item は blocking のまま残る。',
    '- cleared:false の SEC item は blocking のまま merge tier に反映される（SEC item の blocking は gate_policy で緩めない）。',
  ].join('\n'),
  concern_resolutions: [
    'concern_resolutions 契約:',
    '- prompt に「未解消 concern 一覧」が渡された場合、各 item を実コードで再検証し、concern_resolutions:[{id, resolution, evidence}] で全件判定して返す。',
    '- id は渡された item の id をそのまま返す。',
    '- resolution は resolved / triaged / unresolved の 3 値 enum（必須）。boolean キーは受理しない（error）。',
    '- resolved = 実コードで解消を確認。具体的 evidence 必須（file:line / テスト名 / diff 内容）。',
    '- triaged = 再検証済みだが対応不要と判断（advisory かつ実害なし等）。判断根拠の evidence 必須。evidence の無い triaged は unresolved と同一に扱われる。',
    '- 人間の作業（apply 前の手動検証・オペレータ確認依頼等）を含むものは triaged にしない。unresolved にするか、環境事象なら ENV note に載せる（triaged は「人間の対応不要」を意味し、要対応から外れる）。',
    '- unresolved = 未解消（据え置き）。',
    '- 対象は CONCERN-* のみ。ENV-* / SEC-* / AC-* は concern_resolutions の対象外（他経路で扱われる）。',
    '- concern は advisory であり収束を block しない。resolved は終端サマリーの要対応から除外され、triaged も要対応から除外されて要対応直後の折りたたみ「🔹 トリアージ済み N 件」に判断根拠を全文で残す（人間が誤トリアージを検算する。ゲート・merge tier・収束判定には影響しない）。',
  ].join('\n'),
  // testsurf_clearance は final_ac_reconcile と同様 prompt 注入のみで配送する（evaluator.md へ
  // mirror しない）。.claude/agents/ は sandbox の書き込み禁止領域（agent 定義の self-modification
  // 防止）であり、dev-flow の testsurf_focus 注入が本契約全文を毎回 prompt へ verbatim 注入するため
  // 機能上も mirror は不要。既存 3 キーの evaluator.md verbatim mirror 規約の対象外（issue #362）。
  testsurf_clearance: [
    'testsurf_clearance 契約:',
    '- testsurf_focus が渡された場合、各 pattern の test 変更が正当（refactor で網羅性維持 / 一時 skip でない 等）かを判定し、testsurf_clearance:[{pattern, cleared, evidence}] で返す。',
    '- pattern は渡された検出パターン名をそのまま返す。',
    '- 正当と確認できないものは cleared:false。',
    '- cleared:true は具体的 evidence 必須（どのテストがどこで同等以上に担保されるか）。evidence のない cleared:true は無視され、TESTSURF item は blocking のまま残る。',
    '- cleared:false の TESTSURF item は blocking のまま merge tier HOLD に反映される。',
  ].join('\n'),
  // final_ac_reconcile は prompt 注入のみで配送する（evaluator.md へ mirror しない）。
  // .claude/agents/ は sandbox の書き込み禁止領域（agent 定義の self-modification 防止）であり、
  // dev-flow の final-ac-reconcile 呼び出しが本契約全文を毎回 prompt へ verbatim 注入するため
  // 機能上も mirror は不要。既存 3 キーの evaluator.md verbatim mirror 規約の対象外。
  final_ac_reconcile: [
    'final_ac_reconcile 契約:',
    '- prompt で「final AC 再検証」が指示された場合、渡された既存 acceptance_criteria のみを最終 PR tree に対して one-shot で再検証し、ac_results:[{ac_index, satisfied, evidence, verified_by}] を全 AC 分ちょうど 1 回ずつ返す。',
    '- ac_index は渡された AC の index をそのまま返す。AC の追加・分割・言い換え・index の欠落や重複は禁止。',
    '- 新規 finding の報告・feedback の付与・コード修正・追加検証 loop の要求は禁止（出力は ac_results のみが使われる）。',
    '- satisfied:true / false のいずれでも非空 evidence 必須（file:line / テスト名 / 実行結果）。index 不完全・evidence 欠落は出力全体が unavailable 扱いとなり merge tier が HOLD になる。',
    '- prompt に「final 再評価対象 item 一覧」が渡された場合、各 item を fix 後の最終 PR tree で再検証し、item_resolutions:[{id, resolution, evidence}] で全件返す。resolution は resolved（指摘内容が最終 tree で解消されている — revert / 修正済み等）/ ci_delegated（ローカルでは実行不能だが PR CI が同等の検証を実行する — build / compose / e2e 等）/ unresolved の 3 値のみ。',
    '- id は渡された id をそのまま返す。resolved / ci_delegated は具体的 evidence 必須（commit / file:line / 該当 CI check 名）。evidence のない resolved / ci_delegated は無視され未解消のまま表示される。',
    '- item_resolutions は表示専用で checked / merge tier / HOLD 判定は変えない（ESCALATE は解消済みでも HOLD のまま人がマージ可否を判断する）。',
    '- ac_results の契約（全 AC ちょうど 1 回・追加禁止）は item_resolutions の有無に関わらず不変。',
  ].join('\n'),
  // resolved_recheck / green_fix_recheck も prompt 注入のみで配送する（evaluator.md へ mirror しない。
  // 理由は final_ac_reconcile と同じ）。
  resolved_recheck: [
    'resolved_recheck 契約:',
    '- prompt に「再検証対象 resolved item 一覧」が渡された場合、各 item の解消根拠（evidence）が現在の tree でも成り立つかを実コードで再検証し、recheck_resolutions:[{id, resolution, evidence}] で全件返す。',
    '- 一覧の item は、解消と判定された後に本文か evidence に言及するファイルが変更されたもの。過去の evidence を信用せず、現在の内容で確かめる。',
    '- id は渡された id をそのまま返す。resolution は resolved（解消根拠が現在の tree でも成立）/ unresolved（後の変更で根拠が崩れた・確認できない）の 2 値のみ。',
    '- resolved は現在の tree に基づく具体的 evidence 必須（file:line / テスト名 / diff 内容）。unresolved も崩れた根拠を evidence に書く。',
    '- evidence のない resolved と返さなかった item は unresolved と同じに扱われ、解消済みから外れる（critical は blocking に戻る）。',
  ].join('\n'),
  green_fix_recheck: [
    'green_fix_recheck 契約:',
    '- 「post-eval green-fix 再評価」が指示された場合、評価済み tree から green-fix が入れた差分だけを判定対象にし、findings:[{severity, topic, description}] で返す。',
    '- mode=assert_only（変更はテストファイルだけ・決定論の test-weakening / danger 検出は 0 件）: テストの assert・期待値・検査範囲を弱めて green にしていないか（assert 削除・期待値の緩和・skip 化・検査対象の縮小・tautology 化）だけを判定する。弱体化があれば severity:critical の finding、無ければ findings:[]。',
    '- mode=full: 差分が受け入れ条件・テストの検査力を損なっていないか、plan 宣言外の変更が妥当かを判定する。merge を止めるべき欠陥（テスト弱体化を含む）だけを severity:critical で返す。',
    '- critical 以外の finding は返しても使われない（評価 round 以降の台帳は critical 以外を受け付けない）。差分に無い既存コードへの指摘は禁止。',
    '- コード修正・ファイル変更は禁止。',
  ].join('\n'),
}

// evaluator 出力の自然文欄の字数上限。dev-flow.js の EVAL schema（feedback / 各 evidence）と FINAL_AC の
// item_resolutions[].evidence が maxLength に使い、evaluator.md の「書き方」が同じ値を案内する。超過は
// StructuredOutput の schema 検証で書き手に差し戻される（何を残すかは中身を知る evaluator が決める）。
// evidence は終端サマリーの解消済み折りたたみ表のセル上限（devflow-summary-format の RESOLVED_CELL_MAX）以下に保つ
// — 上限を超えた evidence は表で「…」に切られて人間が根拠を読めない。不変条件は evaluator-contract.test.mjs が pin。
export const EVAL_DESCRIPTION_MAX = 300
export const EVAL_SUGGESTION_MAX = 200
export const EVAL_EVIDENCE_MAX = 200

// 全件スイートの範囲。Validate と同じ tree を評価するときは evaluator に走らせない（Validate が同じ tree で
// 実行済みで、再実行は評価の所要時間とコストの大半を占める）。evaluator.md の「進め方」も同じ文字列で案内する。
export const EVAL_FULL_SUITE = '全件スイート（tests/run-*.sh・run-all-bats・vitest のディレクトリ全体実行）'

// eval prompt に足す Validate の結果と、全件スイートを走らせない指示。呼び出し側は Validate 終了時と
// eval 直前の diff hash が一致するとき（Validate と同じ tree）だけ足す。Validate が返した値をそのまま渡し、
// 「全件 green」とは断定しない — Validate は変更に関係するテストだけを回すことがある。
export function validateResultPromptBlock(val) {
  const v = val ?? {}
  return `validate_result（Validate がこの tree で実行したテストの結果。Validate の返り値をそのまま渡す）:\n`
    + `${JSON.stringify({ green: v.green ?? null, tests: v.tests ?? null, summary: v.summary ?? '' })}\n`
    + `${EVAL_FULL_SUITE}は走らせず、AC に関係するテストファイルだけを実行して根拠にせよ。\n`
}

// concern_resolutions[].resolution の closed enum（issue #614）。out-of-enum / 旧 boolean キー resolved は
// 明示 error（legacy fallback / dual-path なし）。triaged は表示専用で ledger の checked を変えない。
export const CONCERN_RESOLUTIONS = ['resolved', 'triaged', 'unresolved']

// evaluator が返した concern_resolutions[] の 1 要素を検証し {id, resolution, evidence} に正規化する純関数。
// evidence は string 以外なら null（有無の判定は呼び出し側）。不正形は throw（silent 無視しない）。
export function normalizeConcernResolution(cr) {
  if (!cr || typeof cr !== 'object' || Array.isArray(cr)) {
    throw new Error('normalizeConcernResolution: concern_resolutions[] の要素は object 必須')
  }
  if (Object.prototype.hasOwnProperty.call(cr, 'resolved')) {
    throw new Error(`normalizeConcernResolution: 旧 boolean キー resolved は受理しない（resolution enum ${JSON.stringify(CONCERN_RESOLUTIONS)} を使う）: ${JSON.stringify(cr)}`)
  }
  if (typeof cr.id !== 'string' || cr.id.length === 0) {
    throw new Error(`normalizeConcernResolution: id は非空 string 必須: ${JSON.stringify(cr)}`)
  }
  if (!CONCERN_RESOLUTIONS.includes(cr.resolution)) {
    throw new Error(`normalizeConcernResolution: resolution '${cr.resolution}' is out-of-enum (expected one of ${JSON.stringify(CONCERN_RESOLUTIONS)}): ${JSON.stringify(cr)}`)
  }
  return { id: cr.id, resolution: cr.resolution, evidence: typeof cr.evidence === 'string' ? cr.evidence : null }
}
