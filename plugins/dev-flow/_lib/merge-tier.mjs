// dev-flow W5: merge tiering + 決定論 danger floor の純粋関数群。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。

// diff-risk-classify.sh が出力する 7 danger クラス（固定順）。
export const DANGER_CLASSES = [
  'auth', 'crypto', 'config', 'data-migration', 'public-api', 'exec-sink', 'dependency',
];

const SEC_TEXT = {
  'auth': '認証/認可ファイルの変更が安全か（権限昇格・認可バイパスなし）',
  'crypto': '暗号処理の変更が安全か（弱いアルゴリズム・鍵漏洩なし）',
  'config': 'config/secret の変更が安全か（秘密情報の平文混入なし）',
  'data-migration': 'data migration が安全か（不可逆・データ欠損なし）',
  'public-api': 'public API 変更が後方互換か（破壊的変更の明示）',
  'exec-sink': 'exec/deserialization sink が安全か（任意コード実行なし）',
  'dependency': '依存追加が安全か（既知脆弱性・supply chain リスクなし）',
};

// 7 danger クラスを常時 blocking seed する。danger-grep clean なら reconcileDanger が
// 自動 check し、hit したクラスは critical へ raise して block 据え置きにする。
export function seedSecurityLedger() {
  return DANGER_CLASSES.map((cls) => ({
    id: `SEC-${cls.toUpperCase()}`,
    text: SEC_TEXT[cls],
    dimension: 'security',
    severity: 'major',
    source: 'seed',
    check: { kind: 'deterministic' },
    danger_class: cls,
  }));
}

// danger-grep の結果で SEC seed item を解決する。
// risk.ok !== true は danger-grep 実行失敗/転写失敗/空出力を表し、fail-closed として
// 全 SEC seed を unchecked に戻す（clean と区別する）。この際 fail_closed:true を付与する
// （danger_hits とは別軸の機械可読フラグ。Evaluate ループ収束判定からのみ除外するために使う。
// merge tier 側は unchecked のまま含めて HOLD を強制し続ける — danger-grep の fail-closed は緩めない）。
// clean/hit の成功分岐では fail_closed:false を明示セットして stale フラグを解消する。
// clean クラス → checked(evidence='danger-grep clean')。
// hit クラス → critical へ raise(floor=true)。
//   - floor=true かつ checked=true(evaluator が evidence で clearance 済み) → checked を維持する(HOLD に巻き戻さない)。
//   - floor=false かつ checked=true(前回 "danger-grep clean" 自動解決済み) → 今回 hit に転じたので unchecked 復活。
//   - checked=false → checked=false 据え置き(evaluator が次ラウンドで解消するまで block)。
// SEC 以外の item は touch しない。
//
// 再 reconcile ポリシー(pr-iterate 後の Merge tier phase での呼び出しを含む):
//   danger が増えた(新クラスが hit に転じた)場合 → floor=false なので unchecked 復活 = HOLD。
//   danger が減った(以前 hit だったクラスが clean に転じた)場合 → checked=true に解放(自動解消)。
//   danger が同じ hit クラスで残る かつ evaluator clearance 済み(floor=true, checked=true) → checked 維持(温存)。
export function reconcileDanger(ledger, risk) {
  if (!risk || risk.ok !== true) {
    // ツール欠落/スクリプト実行不能/JSON 不正などによる fail-closed。
    // 実際の danger 検出（risk.ok:true + hits）とは語彙を分け、
    // operator が log と HOLD reason から「danger を検出したのか」「ツールが走らなかったのか」を判別できるようにする。
    const errDetail = risk?.error ? `: ${risk.error}` : '';
    const evidence = `danger-grep unavailable (fail-closed)${errDetail}`;
    const items = ledger.items.map((it) => {
      if (it.source !== 'seed' || it.dimension !== 'security') return it;
      return { ...it, checked: false, fail_closed: true, evidence };
    });
    return { ...ledger, items };
  }

  const hits = new Set((risk.hits ?? []).map((h) => h.class));
  const items = ledger.items.map((it) => {
    if (it.source !== 'seed' || it.dimension !== 'security') return it;
    if (hits.has(it.danger_class)) {
      // floor=true かつ checked=true → evaluator が danger floor を evidence 付きで clearance 済み。
      // 同クラスが依然 hit でも checked を維持して HOLD に巻き戻さない。
      // floor=false かつ checked=true → 前回 reconcile で "danger-grep clean" 自動解決されたが
      // 今回 hit に転じた(pr-iterate で増えた) → 再度 unchecked にして block を復活させる。
      if (it.checked && it.floor) return it;
      // evidence を null クリアする。前回 reconcile が "danger-grep clean" 等で自動 check した
      // stale evidence を残すと、unchecked/critical に戻った item に矛盾した evidence 表示が残る。
      return { ...it, severity: 'critical', floor: true, checked: false, fail_closed: false, evidence: null };
    }
    return { ...it, checked: true, fail_closed: false, evidence: 'danger-grep clean' };
  });
  return { ...ledger, items };
}

// Merge tier phase で reconcileDanger 前後の SEC ledger を比較し、one-shot security
// clearance の対象候補を決定論的に算出する純関数。
// 「before で checked（Evaluate 時点等で解消済み）だったが after で unchecked に転じた」
// SEC seed item の danger_class のみを返す（Evaluate 時点から未解消のまま残る SEC は
// merge tier で clear させない = SEC item の blocking 不変）。
// after 側で fail_closed:true の item は defense-in-depth として除外する（fail-closed 時は
// clearance 対象にしない）。before に同 id が無い item も対象外。ledger は mutate しない。
export function newlyUncheckedSecClasses(before, after) {
  const beforeById = new Map(
    (before?.items ?? [])
      .filter((it) => it.source === 'seed' && it.dimension === 'security')
      .map((it) => [it.id, it]),
  );
  const result = [];
  for (const it of (after?.items ?? [])) {
    if (it.source !== 'seed' || it.dimension !== 'security') continue;
    if (it.fail_closed === true) continue;
    const prev = beforeById.get(it.id);
    if (!prev) continue;
    if (prev.checked === true && it.checked !== true) {
      result.push(it.danger_class);
    }
  }
  return result;
}

// 変更ファイルが docs(.md/.mdx/.txt, docs/) か test(*test*, *spec*, .bats, *_spec.rb / *_test.rb, *Test.php) のみか。
export function isDocsOrTestOnly(files) {
  if (!Array.isArray(files) || files.length === 0) return false;
  return files.every((f) =>
    /\.(md|mdx|txt)$/i.test(f) || /(^|\/)docs\//i.test(f)
    || /(^|\/|\.)(test|spec)([./]|$)/i.test(f) || /\.bats$/i.test(f)
    || /_(test|spec)\.rb$/.test(f) || /Test\.php$/.test(f));
}

// Final reconcile（pr-iterate fix 適用後の最終 tree 再検証、issue #320）の finalReconcile enum。
// 'skipped': fixes_applied=0 で Final reconcile 自体を実行しなかった（zero-overhead routing）。
// 'reverified': 最終 tree に対して sync + test 再実行を行った。
// 'unavailable': worktree sync 失敗 / test agent null・schema 不一致・tests:error 等で再検証結果を取得できなかった
//   （fail-safe。HOLD へ倒す）。CI の success では代替しない — pull_request の CI は PR head の workflow で
//   動き、CI が呼ぶスクリプトも PR が書き換えられる（テストを走らせない success job でも success になる）。
const FINAL_RECONCILE_VALUES = ['skipped', 'reverified', 'unavailable'];

// merge tier HOLD 理由の分類（issue #599）。'deterministic_recheck': 決定論的な再チェック
// （再取得・本文の再投入等）で解消しうる。'human_judgment': 決定論的手段では解消できず人間確認が
// 必須。
export const HOLD_REASON_KINDS = ['deterministic_recheck', 'human_judgment'];

// HOLD 理由の閉じた code enum（issue #658、issue #661 で pr_closes_missing 追加）。summary 側
// （devflow-summary-format.mjs）の「現状/対応」写像キー。reason は自由文で将来変わりうるため、summary は
// reason の prefix 一致ではなくこの安定 code で文言を写像する。out-of-enum/欠落時は summary が
// fail-safe（'—' / '人が確認する'）に落とすだけで throw しない（表示専用フィールドのため）。
export const HOLD_REASON_CODES = [
  'ledger_unconverged', 'danger_unresolved', 'breaking_structured', 'escalate',
  'ac_agent_unsatisfied', 'ac_human_pending', 'danger_fail_closed', 'final_reconcile_unavailable', 'final_test_red',
  'final_ac_unavailable', 'iterate_non_lgtm', 'hash_mismatch', 'testsurf_uncleared',
  'mergeable_conflicting', 'pr_closes_missing', 'merge_facts_dropped', 'ci_checks_failed', 'ac_ci_pending',
  'security_review_unresolved', 'validate_test_red', 'validate_tests_not_run',
];

// merge-tier-facts の checks サブ結果（parseChecks の返り値 {ok:true, checks} | {ok:false, error}）を
// CI 状態へ写像する純関数（issue #834）。bucket の分類は check-ci.sh の compute_verdict と同じ:
// fail / cancel と既知 5 値（pass / fail / pending / skipping / cancel）以外は failed（fail-closed —
// 未知値を数え漏らして green に見せない）、pending は pending、pass / skipping は passed。
// 返り値 state: 'failed'（1 件でも failed）> 'pending' > 'passed' > 'no_checks'（0 件）、
// 取得失敗（ok!==true / checks が配列でない）は 'unavailable'。failedNames / pendingNames は check 名。
export function classifyCiChecks(ciChecks) {
  if (!ciChecks || ciChecks.ok !== true || !Array.isArray(ciChecks.checks)) {
    return { state: 'unavailable', failedNames: [], pendingNames: [], error: ciChecks?.error ?? null };
  }
  const bucketOf = (c) => String(c?.bucket ?? '');
  const nameOf = (c) => String(c?.name ?? 'unknown');
  const isFailed = (c) => !['pass', 'pending', 'skipping'].includes(bucketOf(c));
  const failedNames = ciChecks.checks.filter(isFailed).map(nameOf);
  const pendingNames = ciChecks.checks.filter((c) => bucketOf(c) === 'pending').map(nameOf);
  const state = failedNames.length > 0 ? 'failed'
    : pendingNames.length > 0 ? 'pending'
      : ciChecks.checks.length > 0 ? 'passed' : 'no_checks';
  return { state, failedNames, pendingNames, error: null };
}

// PR body の Closes 行決定論検証（issue #661）の状態 enum。'verified': gh pr view --json body に
// Closes #<issue> 行を確認済み。'reinjected': 欠落を検出し gh pr edit --body-file で再投入し確認済み。
// 'missing': 欠落を検出し再投入も失敗（または再投入後も欠落）— fail-closed で HOLD 理由に載せる。
// 'unverified': gh pr view 自体が失敗（fail-open、警告のみ）。canonical は `_lib/pr-artifacts.mjs`
// の PR_CLOSES_STATUS_VALUES（同値性は merge-tier.test.mjs が pin する）。本ファイルでは top-level
// named export を持たない — pr-artifacts.mjs と本ファイルは両方とも dev-flow.js へ inline されるため、
// 同名 export const を重複宣言すると tools/sync-inlines.mjs の top-level declaration collision 検知に
// 抵触する（validateInlineDeclCollisions は export 有無に関わらず column-0 の const/let/var/function/class
// 宣言名を対象にする）。値は下記バリデーションに直接 literal で埋め込む（関数スコープ内 local const
// なら column-0 top-level 宣言に該当しないため collision 対象外）。
function isValidPrClosesStatus(v) {
  return ['verified', 'reinjected', 'missing', 'unverified'].includes(v);
}

// eval_staleness の閉じた enum（issue #288 の 4 値 + issue #631 の hash_reconverged）。
export const EVAL_STALENESS_VALUES = ['none', 'hash_mismatch', 'hash_reconverged', 'iterate_incomplete', 'iterate_fixed'];

// HOLD 理由配列（[{ reason, kind }]）から代表 kind を集約する純関数。
// いずれかが 'human_judgment' なら 'human_judgment'（human 判断が 1 件でもあれば全体を human 扱いにする
// fail-closed 側の集約）。全件 'deterministic_recheck' ならそのまま。空/非配列は null（HOLD 以外）。
export function aggregateHoldKind(holdReasons) {
  if (!Array.isArray(holdReasons) || holdReasons.length === 0) return null;
  if (holdReasons.some((r) => r.kind === 'human_judgment')) return 'human_judgment';
  return 'deterministic_recheck';
}

// gh pr view --json mergeable,mergeStateStatus の生出力を 3 値 enum に写像する pure 関数。
// 'conflicting': base branch と conflict（mergeable=CONFLICTING もしくは mergeStateStatus=DIRTY）。
// 'clean': mergeable=MERGEABLE かつ conflict なし。
// 'unknown': proxy 失敗（ok!==true / null）または GitHub が mergeability 未計算（UNKNOWN 等）。
//   fail-open — conflict gate を適用しない（後述 classifyMergeTier で reason 追加なし）。
export function classifyMergeableState(meta) {
  if (!meta || meta.ok !== true) return 'unknown';
  const ms = String(meta.mergeStateStatus ?? '').toUpperCase();
  const mg = String(meta.mergeable ?? '').toUpperCase();
  if (mg === 'CONFLICTING' || ms === 'DIRTY') return 'conflicting';
  if (mg === 'MERGEABLE') return 'clean';
  return 'unknown';
}

// merge tier を算出する。merge は全 tier 人間(AUTO も推奨ラベルのみ。真 auto-merge は W6)。
// HOLD: 未収束 / 未解消 danger / breaking / ESCALATE 項目あり（人間 required-block）。
// breaking は analyze 構造化判定 (breakingStructured) と issue title/body keyword scan
// (breakingKeyword) の 2 入力で、reason で由来を区別する（issue #278）。
// AUTO: micro かつ docs/test-only かつ danger clean かつ収束（推奨ラベル）。
// REVIEW: それ以外（標準。人間が LGTM して merge）。
// s.evalSkipped (optional boolean): true の場合、AUTO branch で AC 未検証開示 reason を追記する。
//   micro path は evaluator 0 回で AC を判定していないため、AUTO 推奨でもその事実を開示する（issue #233）。
//   danger-grep hit / green-fix で security path により eval が強制実行された場合は false にして虚偽開示を避ける。
// s.unsatisfiedAgentAc / s.unsatisfiedHumanAc (optional boolean): 最終の AC 判定で satisfied:false の AC が
//   actor（_lib/ac-actor.mjs）別に 1 件以上あるか（issue #747）。どちらも gate_policy に依らず HOLD だが、
//   code を分ける — 'ac_agent_unsatisfied' は worktree 内で満たせる AC を Evaluate 差し戻しで拾えなかった
//   取りこぼし（telemetry で異常として数える）、'ac_human_pending' は人手作業待ちの想定内の HOLD。
//   boolean 以外は明示 error。旧キー unsatisfiedAc は actor を区別できないので受理しない（明示 error）。
// s.unsatisfiedCiAc (optional boolean): ci の AC（repo の ci_verify で CI の check が判定する AC。issue #861）が
//   pr-iterate の LGTM 後の待ちで success にならなかった（上限まで未完了・failure・取得不能・待ちに未到達）。
//   'ac_ci_pending'（CI の結果を人間が確認して merge する）で HOLD。boolean 以外は明示 error。
// s.dangerFailClosed (optional boolean): true の場合、danger-grep が実行不能（fail-closed）だったことを
//   示す専用 HOLD reason を追記する（issue #271）。fail-closed 時は SEC seed item が unchecked のまま
//   残るため s.converged が既に false になり HOLD へ落ちるが、この reason は「なぜ未収束か」を
//   security 不明という意味論で明示するための defense-in-depth（danger_hits の実 hit とは別軸）。
//   未指定 = falsy = reason 追加なし、tier 判定値も従来と完全同一（regression なし）。
// s.riskValueDropped (optional boolean): true かつ dangerFailClosed のとき、fail-closed の原因が
//   danger-grep 実行不能ではなく merge-tier-facts の subagent 転記で risk.value が落ちたこと（issue #746。
//   isRiskValueDropped）を示す。reason を 'danger_fail_closed' ではなく 'merge_facts_dropped' で積む
//   （人間に「danger-grep が走らなかった」と誤読させない。security 未検証なのは同じなので HOLD は維持）。
//   boolean 以外は明示 error（後方互換 scaffolding 禁止規約）。
// s.finalReconcile (optional 'skipped'|'reverified'|'unavailable'): Final reconcile phase の実行結果
//   （issue #320）。'unavailable' は fail-safe HOLD reason を追記する。out-of-enum は明示 error
//   （後方互換 scaffolding 禁止規約）。未指定(undefined/null) = reason 追加なし。
// s.finalTestGreen (optional true|false|null): Final reconcile での最終 tree test 再実行結果。
//   false のとき専用 HOLD reason を追記する。true/null(未実行 or no_tests)は reason 追加なし。
// s.validateResult (optional { tests: 'passed'|'failed'|'no_tests'|'error', green: boolean }): Validate の最新の
//   test 結果（workflow の state.val。issue #1086）。finalReconcile === 'skipped'（fixes_applied=0 で最終 tree を
//   再検証していない）かつ tests:'failed' + green:false のとき 'validate_test_red'（human_judgment）で HOLD —
//   GREEN_MAX 到達で red のまま PR へ進んだ run で、この Validate の結果が PR tree のテスト状態そのもの
//   （base でも落ちる既存失敗は Validate が green:true にして抜けるので、ここに来る red は diff 起因）。
//   s.finalTestFlaky がある（落ちたファイルだけの 1 回の再実行が green）run でも積む — 単体再実行の成功は PR が
//   書き換えられるテストの出力で、全件実行のときだけ落ちるテストを書けば決定的な失敗でも green になる。
//   再実行の結果は flake 候補の開示行にだけ使う。
//   tests:'error'（起動失敗 = テストが 1 件も実行されていない）は常に 'validate_tests_not_run'（human_judgment）で
//   HOLD — テストを 1 件も確かめないまま REVIEW にしない。PR が書き換えられる CI の success では解除しない。
//   finalReconcile が skipped 以外のときは最終 tree の判定（final_test_red / final_reconcile_unavailable）が
//   持つので見ない。未指定 = reason 追加なし。object でない / tests が enum 外 / green が boolean でないものは明示 error。
// s.setupDeps (optional { ok: boolean, note: string }): Setup(deps) の結果（prerun の deps）。ok:false の run では
//   'validate_tests_not_run' の文言に note を載せる（テスト未実行の原因の手がかり）。tier 判定には使わない。
//   ok が boolean でない / note が string でないものは明示 error。
// s.breakingStructured / s.breakingKeyword: breaking 検出は analyze 構造化判定
//   (breakingStructured = breaking_change===true) と issue title/body keyword scan
//   (breakingKeyword) の 2 入力を持つ（issue #278）。ただし breakingKeyword は単独では
//   HOLD にしない（issue #364 precision fix）。issue 本文への keyword grep は変更の
//   破壊性を担保する oracle ではなく低 precision ヒューリスティック（実測 FP: #359/#361）
//   であり、構造化判定との corroboration があるときのみ blocking 理由に採用する。
//   keyword-alone（breakingKeyword && !breakingStructured）のときは tier/shape を
//   変えない可視化 reason を末尾に追記するのみ。コード実体に対する決定論 breaking 検出は
//   danger-grep 'public-api' クラス（realized diff 上、blast-radius floor）が別途担保する。
// s.iterateStatus (string|null): pr-iterate の終端 status（'lgtm'|'stuck'|'fix_failed'|
//   'max_reached'|'ci_error'|'ci_pending'|null）。'lgtm' 以外（未知値・null 含む）は
//   決定論的 HOLD（fail-safe、allowlist しない厳格判定）。blast-radius クラス（issue #319）—
//   merge 直前の最終ゲートが LGTM 未到達のまま AUTO/REVIEW を出すと既知の指摘が未解消のまま
//   出荷されるため、gate_policy で緩和しない（軸A 不変）。
// s.evalStaleness (string): 'none'|'hash_mismatch'|'hash_reconverged'|'iterate_incomplete'|
//   'iterate_fixed'（issue #288 の 4 値 + issue #631 の hash_reconverged。EVAL_STALENESS_VALUES）。
//   'hash_mismatch' のみ HOLD 追加（Evaluate 対象 tree と PR tree の乖離）。'hash_reconverged' は
//   PR 直前に一時乖離したが PR head tree === 評価済み tree === merge 対象 tree を決定論確認済み
//   （issue #631）— HOLD しない。gate が守る性質「merge 対象 tree = 評価済み tree」を merge 対象
//   そのもので確認しているため gate_policy に依らない（'none' と reasons/holdReasons/holdKind が
//   完全一致する no-op）。'iterate_incomplete' は iterateStatus !== 'lgtm' と必ず同時発生するため
//   個別条件にしない。'none'/'iterate_fixed'/'hash_reconverged' は tier に影響しない。
//   'hash_mismatch' は iterate_* より優先（'none' からのみ昇格、#288 AC-2）。
// s.evalDiffHash / s.prDiffHash (string|null): 'hash_mismatch' HOLD reason に載せる評価済み tree /
//   PR 直前 tree の hash（short 8 桁で表示。null は「不明」表記）。
// s.staleDiffFiles (Array<{path,insertions,deletions}>|null|undefined): 'hash_mismatch' HOLD reason
//   に載せる差分ファイル一覧（tree-diff-stat.mjs の解析結果）。配列なら先頭 10 件 + 件数 + 「他 N 件」
//   （0 件時は「numstat 空」注記）、null/undefined は取得失敗として両 hash 全文 + 手動確認コマンドを出す。
// s.prHeadTreeOid (string|null|undefined): 与えられれば 'hash_mismatch' HOLD reason に PR head tree
//   の short hash を追記する（issue #631）。
// s.finalAcReconcile (optional 'skipped'|'reverified'|'unavailable'): Final AC reconcile phase
//   （issue #331）の実行結果。fix 適用 run での既存 AC の最終 PR tree に対する再検証結果。
//   'unavailable' のみ専用 HOLD reason を追記する（軸A 決定論ゲート、gate_policy に依らず不変）。
//   'skipped'/'reverified'/未指定は tier 判定不変（fail/pass の gating は unsatisfiedAgentAc /
//   unsatisfiedHumanAc と ledger 未収束が担う）。未指定 = 従来と完全同一挙動（regression なし）。out-of-enum は明示 error
//   （後方互換 scaffolding 禁止規約）。
// s.testsurfUncleared (optional string[]): 未 checked の TESTSURF-* seed item id 一覧（issue #362）。
//   非空時に専用 HOLD reason を defense-in-depth として追記する（dangerFailClosed reason と同型の
//   可視化）。TESTSURF item は source:'seed' の unchecked のまま converged=false → HOLD は既に成立
//   しているため、この reason は tier 判定値そのものは変えない。未指定/空 = reason 追加なし
//   （regression なし）。
// s.mergeableState (optional 'clean'|'conflicting'|'unknown'): classifyMergeableState() が
//   gh pr view --json mergeable,mergeStateStatus を写像した結果（issue #405）。'conflicting' は
//   他条件によらず無条件 HOLD reason を追記する（blast-radius クラス、gate_policy に依らず不変 —
//   base branch と conflict した状態で AUTO/REVIEW を出すと merge 不能な PR を出荷することになる）。
//   'clean'/'unknown'/未指定は reason 追加なし（fail-open no-op、regression なし）。'unknown' は
//   proxy 失敗や GitHub 側 mergeability 未計算を含むため conflict と決めつけない。out-of-enum は
//   明示 error（後方互換 scaffolding 禁止規約）。
// s.evalVerdictFail (optional boolean): true の場合、evaluate phase が verdict=fail のまま PR へ
//   進んだ事実を開示する専用 reason を HOLD/AUTO/REVIEW 全分岐の reasons に追記する
//   （keywordAloneDisclosure と同型 — issue #536）。未解消 findings は ledger/HOLD 条件が別途
//   担保するため tier 判定値は変えない（可視化のみ）。未指定/null/false = reason 追加なし、
//   tier 判定値も従来と完全同一（regression なし）。boolean 以外は明示 error
//   （後方互換 scaffolding 禁止規約）。
// s.prClosesStatus (optional 'verified'|'reinjected'|'missing'|'unverified'): PR body の
//   `Closes #<issue>` 行の決定論検証結果（issue #661、PR_CLOSES_STATUS_VALUES）。'missing'
//   （欠落を検出し再投入も失敗）のときのみ専用 HOLD reason（deterministic_recheck）を追記する
//   （gh pr edit --body-file の再投入で解消しうるため human_judgment ではない）。
//   'verified'/'reinjected'/'unverified'/未指定は reason 追加なし（fail-open no-op、regression なし）。
//   out-of-enum は明示 error（後方互換 scaffolding 禁止規約）。
// s.ciChecks (optional {ok:true, checks:Array}|{ok:false, error}): merge-tier-facts の checks サブ結果
//   （parseChecks の返り値。issue #834）。classifyCiChecks で 'failed'（bucket が fail / cancel / 既知 5 値
//   以外の check が 1 件以上）なら blocking の HOLD reason 'ci_checks_failed'（human_judgment）を積む —
//   pr-iterate の lgtm は CI の真偽を保証しない（proxy の転記に依存する）ため、Merge tier が PR head の
//   checks を決定論で見て止める最後のゲート（軸A。gate_policy に依らず不変）。'pending' / 'unavailable'
//   （取得失敗）は HOLD にせず「CI 未完了」の開示行を disclosures に積む（fail-open。Merge tier は CI の
//   完了を待たない）。判定は bucket だけで行い mergeStateStatus（UNSTABLE 等）は見ない。
//   未指定 = reason・開示とも追加なし。object でない / ok が boolean でない / ok:true で checks が配列で
//   ないものは明示 error。
// s.finalTestFlaky (optional { files: string[], logs: string[] }): 全件実行で落ち、落ちたファイルだけの
//   単体再実行が green だった記録（_lib/final-test-rerun.mjs の finalTestRerunVerdict。issue #865）。どちらの経路でも
//   HOLD は解除せず flake 候補として開示するだけ — 単体再実行の成功は PR が書き換えられるテストの出力で、
//   全件実行のときだけ落ちるテストを書けば決定的な失敗でも green になる。2 経路ある:
//   - Final reconcile の test#final（finalReconcile !== 'skipped'）: workflow は finalTestGreen を false のままにするので
//     final_test_red は積まれる。
//   - Final reconcile が skip の run の Validate red（finalReconcile === 'skipped' かつ validateResult が
//     tests:'failed' / green:false。issue #1138）: validate_test_red は積まれる。
//   開示行（finalTestFlakyDisclosure）を disclosures に積む。未指定 = 開示なし。
//   files が非空の string[] でない / logs が string[] でない / どちらの経路の red にも当たらない
//   （red でないまま flake を名乗る矛盾）は明示 error。
// s.securityReviewUnresolved (optional boolean): 敵対的 security review の対象の run（Diff triage か pr-iterate の
//   判定のどちらかで対象）で、pr-iterate が今の PR head で security review を clear にしていない（LGTM 以外で終端した・
//   critical/major が残った・worktree の外を指す指摘がある・review を回せなかった。issue #1063）。true なら
//   'security_review_unresolved'（human_judgment）で HOLD。blast-radius — merge 直前の最終ゲートで、gate_policy に
//   依らず不変。boolean 以外は明示 error。
// 返り値: { tier, reasons, holdReasons, holdKind, disclosures }（issue #599 で holdReasons/holdKind、
//   issue #658 で disclosures を追加）。
//   reasons は従来どおり string[]（HOLD 時は blocking 文言 + 可視化行、AUTO/REVIEW 時は従来文言 +
//   可視化行）。holdReasons は HOLD 時のみ blocking 文言の [{ code, reason, kind }]（可視化行は
//   含めない）、AUTO/REVIEW 時は []。code は HOLD_REASON_CODES の閉じた enum（summary 側の
//   現状/対応写像キー）。holdKind は aggregateHoldKind(holdReasons)（HOLD 以外は null）。
//   disclosures は HOLD/AUTO/REVIEW 全 3 分岐共通で、可視化のみ（tier 判定に寄与しない）の開示
//   文言 string[]（keywordAloneDisclosure / evalFailDisclosure / ciIncompleteDisclosure / finalTestFlakyDisclosure のうち
//   非 null のもの）。reasons の内容・順序（可視化行を末尾に含む従来形）は不変 — disclosures は
//   reasons の部分集合を別途複製したものであり、reasons から可視化行を除去するものではない。
export function classifyMergeTier(s) {
  if (s.finalReconcile != null && !FINAL_RECONCILE_VALUES.includes(s.finalReconcile)) {
    throw new Error('classifyMergeTier: invalid finalReconcile: ' + s.finalReconcile);
  }
  if (s.finalAcReconcile != null && !['skipped', 'reverified', 'unavailable'].includes(s.finalAcReconcile)) {
    throw new Error('classifyMergeTier: invalid finalAcReconcile: ' + s.finalAcReconcile);
  }
  if (s.mergeableState != null && !['clean', 'conflicting', 'unknown'].includes(s.mergeableState)) {
    throw new Error('classifyMergeTier: invalid mergeableState: ' + s.mergeableState);
  }
  if (s.evalVerdictFail != null && typeof s.evalVerdictFail !== 'boolean') {
    throw new Error('classifyMergeTier: invalid evalVerdictFail: ' + s.evalVerdictFail);
  }
  if (Object.prototype.hasOwnProperty.call(s, 'unsatisfiedAc')) {
    throw new Error('classifyMergeTier: unsatisfiedAc は廃止 — unsatisfiedAgentAc / unsatisfiedHumanAc を渡す');
  }
  if (s.unsatisfiedAgentAc != null && typeof s.unsatisfiedAgentAc !== 'boolean') {
    throw new Error('classifyMergeTier: invalid unsatisfiedAgentAc: ' + s.unsatisfiedAgentAc);
  }
  if (s.unsatisfiedHumanAc != null && typeof s.unsatisfiedHumanAc !== 'boolean') {
    throw new Error('classifyMergeTier: invalid unsatisfiedHumanAc: ' + s.unsatisfiedHumanAc);
  }
  if (s.unsatisfiedCiAc != null && typeof s.unsatisfiedCiAc !== 'boolean') {
    throw new Error('classifyMergeTier: invalid unsatisfiedCiAc: ' + s.unsatisfiedCiAc);
  }
  if (s.riskValueDropped != null && typeof s.riskValueDropped !== 'boolean') {
    throw new Error('classifyMergeTier: invalid riskValueDropped: ' + s.riskValueDropped);
  }
  if (s.securityReviewUnresolved != null && typeof s.securityReviewUnresolved !== 'boolean') {
    throw new Error('classifyMergeTier: invalid securityReviewUnresolved: ' + s.securityReviewUnresolved);
  }
  if (s.evalStaleness != null && !EVAL_STALENESS_VALUES.includes(s.evalStaleness)) {
    throw new Error('classifyMergeTier: invalid evalStaleness: ' + s.evalStaleness);
  }
  if (s.prClosesStatus != null && !isValidPrClosesStatus(s.prClosesStatus)) {
    throw new Error('classifyMergeTier: invalid prClosesStatus: ' + s.prClosesStatus);
  }
  if (s.ciChecks != null && (typeof s.ciChecks !== 'object' || typeof s.ciChecks.ok !== 'boolean'
    || (s.ciChecks.ok === true && !Array.isArray(s.ciChecks.checks)))) {
    throw new Error('classifyMergeTier: invalid ciChecks');
  }
  const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
  if (s.finalTestFlaky != null && (!isStringArray(s.finalTestFlaky.files) || s.finalTestFlaky.files.length === 0
    || !isStringArray(s.finalTestFlaky.logs))) {
    throw new Error('classifyMergeTier: invalid finalTestFlaky');
  }
  if (s.validateResult != null && (typeof s.validateResult !== 'object'
    || !['passed', 'failed', 'no_tests', 'error'].includes(s.validateResult.tests)
    || typeof s.validateResult.green !== 'boolean')) {
    throw new Error('classifyMergeTier: invalid validateResult');
  }
  // Final reconcile が skip の run で、PR tree のテスト状態が Validate の red（tests:'failed'）のまま
  const validateRed = s.finalReconcile === 'skipped' && s.validateResult?.tests === 'failed' && s.validateResult.green === false;
  if (s.finalTestFlaky != null && !validateRed && s.finalTestGreen !== false) {
    throw new Error('classifyMergeTier: finalTestFlaky requires finalTestGreen===false (or a red Validate in a skipped Final reconcile)');
  }
  if (s.setupDeps != null && (typeof s.setupDeps.ok !== 'boolean' || typeof s.setupDeps.note !== 'string')) {
    throw new Error('classifyMergeTier: invalid setupDeps');
  }
  const ci =s.ciChecks != null ? classifyCiChecks(s.ciChecks) : null;
  // blocking 文言のみ（可視化行は含めない）。HOLD 判定・holdReasons/holdKind の入力に使う。
  const blockingReasons = [];
  const pushBlocking = (code, reason, kind) => blockingReasons.push({ code, reason, kind });
  if (!s.converged) pushBlocking('ledger_unconverged', 'ledger 未収束（未 checked blocking 残）', 'human_judgment');
  if (s.unresolvedDanger) pushBlocking('danger_unresolved', 'danger-grep hit 未解消（security 要確認）', 'human_judgment');
  if (s.breakingStructured) {
    pushBlocking('breaking_structured', 'breaking/migration 検出（analyze 構造化判定 breaking_change=true'
      + (s.breakingKeyword ? ' + issue title/body keyword scan hit' : '') + '）', 'human_judgment');
  }
  const keywordAloneDisclosure = (s.breakingKeyword && !s.breakingStructured)
    ? 'breaking keyword hit（issue title/body 決定論 scan）— 構造化判定 breaking_change=false のため HOLD 不採用（可視化のみ。issue #364）'
    : null;
  const evalFailDisclosure = s.evalVerdictFail === true
    ? 'evaluator verdict=fail のまま PR へ進行 — 未解消 findings は ledger/HOLD 条件が別途担保するため tier 判定は不変（可視化のみ。issue #536）'
    : null;
  if (s.escalateCount > 0) pushBlocking('escalate', `ESCALATE-TO-HUMAN 項目 ${s.escalateCount} 件`, 'human_judgment');
  if (s.unsatisfiedAgentAc === true) pushBlocking('ac_agent_unsatisfied', 'AC 未達（エージェント AC 未達 — worktree 内で満たせる AC が差し戻し上限後も satisfied:false。ループの取りこぼし。gate_policy に依らず人間確認必須）', 'human_judgment');
  if (s.unsatisfiedHumanAc === true) pushBlocking('ac_human_pending', 'AC 未達（人手 AC 待ち — （人手）/ staging / 本番等の worktree 外作業、または実行環境に届かない検証を要する AC が satisfied:false。人間が実施して確認する）', 'human_judgment');
  if (s.unsatisfiedCiAc === true) pushBlocking('ac_ci_pending', 'AC 未確定（CI 判定待ち — ci_verify の check で判定する AC が pr-iterate の LGTM 後の待ちで success にならなかった。CI の結果を確認して merge する）', 'human_judgment');
  if (s.dangerFailClosed === true) {
    if (s.riskValueDropped === true) pushBlocking('merge_facts_dropped', 'merge-tier-facts の転記欠落（subagent 応答から danger-grep 結果 risk.value が落ちた。danger-grep 自体は実行済みの可能性あり）— security 未検証のため人間確認必須', 'human_judgment');
    else pushBlocking('danger_fail_closed', 'danger-grep 実行不能（fail-closed）— security 未検証のため人間確認必須', 'human_judgment');
  }
  if (s.finalReconcile === 'unavailable') {
    pushBlocking('final_reconcile_unavailable', 'Final reconcile 再検証不能（pr-iterate fix 適用後の最終 tree の test 状態を確認できず）— 人間確認必須', 'human_judgment');
  }
  if (s.finalTestGreen === false) pushBlocking('final_test_red', 'final test red（pr-iterate fix 適用後の最終 tree でテスト失敗）', 'human_judgment');
  if (validateRed) {
    pushBlocking('validate_test_red', 'Validate test red（green-fix の上限後も diff 起因のテスト失敗が残ったまま PR へ進行。pr-iterate の fix が 0 件で Final reconcile は skip — PR tree のテスト状態は Validate の結果のまま）— 人間確認必須（gate_policy に依らず不変）', 'human_judgment');
  }
  if (s.finalReconcile === 'skipped' && s.validateResult?.tests === 'error') {
    const depsPart = s.setupDeps?.ok === false
      ? ' — Setup(deps) ok:false: ' + (s.setupDeps.note || '依存インストール結果を確認できなかった')
      : '';
    pushBlocking('validate_tests_not_run', 'テストが 1 件も実行されていない（Validate tests:error = テスト起動失敗。pr-iterate の fix が 0 件で Final reconcile は skip）'
      + depsPart + ' — 人間確認必須（gate_policy に依らず不変）', 'human_judgment');
  }
  if (s.finalAcReconcile === 'unavailable') pushBlocking('final_ac_unavailable', 'Final AC reconcile 判定不能（最終 PR tree に対する AC 再検証結果を取得できず — agent null / schema 不一致 / index 欠落・重複・範囲外 / evidence 不足）— 人間確認必須（gate_policy に依らず不変）', 'human_judgment');
  if (s.securityReviewUnresolved === true) pushBlocking('security_review_unresolved', '敵対的 security review が今の PR head で clear になっていない（信頼境界をまたぎうる変更を含む PR で、pr-iterate が critical/major 0 件の review を通さずに終端）— 指摘の本文は公開しない。merge 前に人が diff を確認する（gate_policy に依らず不変）', 'human_judgment');
  if (s.iterateStatus !== 'lgtm') pushBlocking('iterate_non_lgtm', `pr-iterate 非LGTM終端（status=${s.iterateStatus ?? 'null'}）— review⇄fix loop が LGTM 未到達のため人間確認必須（gate_policy に依らず不変）`, 'human_judgment');
  if (s.evalStaleness === 'hash_mismatch') {
    const short8 = (h) => (typeof h === 'string' && h.length > 0) ? h.slice(0, 8) : '不明';
    if (Array.isArray(s.staleDiffFiles)) {
      const n = s.staleDiffFiles.length;
      const head = s.staleDiffFiles.slice(0, 10)
        .map((f) => `${f.path} (+${f.insertions}/-${f.deletions})`).join(', ');
      const list = n === 0 ? '（numstat 空 — mode/permission のみの変更等）' : head;
      const rest = n > 10 ? ` 他 ${n - 10} 件` : '';
      const prHeadPart = typeof s.prHeadTreeOid === 'string' ? ' / PR head ' + short8(s.prHeadTreeOid) : '';
      pushBlocking(
        'hash_mismatch',
        `Evaluate 時点と PR 直前の diff hash 不一致（eval_staleness=hash_mismatch: eval ${short8(s.evalDiffHash)} / PR 直前 ${short8(s.prDiffHash)}${prHeadPart}）— 差分 ${n} 件: ${list}${rest} — 評価済み tree と merge 対象 tree が乖離しており人間確認必須（gate_policy に依らず不変）`,
        'human_judgment',
      );
    } else {
      pushBlocking(
        'hash_mismatch',
        `Evaluate 時点と PR 直前の diff hash 不一致（eval_staleness=hash_mismatch: eval ${s.evalDiffHash ?? '不明'} / PR 直前 ${s.prDiffHash ?? '不明'}）— 差分ファイル一覧の取得に失敗。\`git diff --stat ${s.evalDiffHash ?? '<eval>'} ${s.prDiffHash ?? '<pr>'}\` を手動確認 — 評価済み tree と merge 対象 tree が乖離しており人間確認必須（gate_policy に依らず不変）`,
        'human_judgment',
      );
    }
  }
  if (Array.isArray(s.testsurfUncleared) && s.testsurfUncleared.length > 0) {
    pushBlocking('testsurf_uncleared', `test-weakening 検出が未クリア（${s.testsurfUncleared.join(', ')}）: committed test の skip/削除/tautology 化の疑い。evaluator clearance か人間確認が必要`, 'human_judgment');
  }
  if (s.mergeableState === 'conflicting') pushBlocking('mergeable_conflicting', 'base branch と conflict（mergeStateStatus=DIRTY / mergeable=CONFLICTING）— merge 前に conflict 解消が必要（人間確認必須。gate_policy に依らず不変）', 'human_judgment');
  if (s.prClosesStatus === 'missing') pushBlocking('pr_closes_missing', 'PR body に `Closes #<issue>` 行が無い（PR 作成後の決定論検証で欠落を検出し、本文の再投入も失敗）— merge しても issue が自動 close されないため本文の再投入が必要（決定論再チェックで解消しうる）', 'deterministic_recheck');
  if (ci?.state === 'failed') pushBlocking('ci_checks_failed', `CI checks 失敗（${ci.failedNames.join(', ')}）— PR head の CI が red（bucket が fail / cancel / 未知値）。pr-iterate の lgtm は CI の真偽を保証しないため人間確認必須（gate_policy に依らず不変）`, 'human_judgment');
  const ciIncompleteDisclosure = ci?.state === 'pending'
    ? `CI 未完了（pending: ${ci.pendingNames.join(', ')}）— Merge tier は CI の完了を待たない（fail-open。HOLD 理由にしない）。merge 前に gh pr checks で結果を確認する`
    : ci?.state === 'unavailable'
      ? `CI 未完了（checks を取得できず: ${ci.error ?? 'unknown'}）— CI 結果は未確認（fail-open。HOLD 理由にしない）。merge 前に gh pr checks で結果を確認する`
      : null;
  const flakyLogs = s.finalTestFlaky != null && s.finalTestFlaky.logs.length ? s.finalTestFlaky.logs.join(', ') : '不明';
  const finalTestFlakyDisclosure = s.finalTestFlaky == null ? null
    : validateRed
      ? `Validate test flake 候補（単体再実行で green）: ${s.finalTestFlaky.files.join(', ')} — Validate の全件実行で落ち、落ちたファイルだけの 1 回の再実行で green（PR が書き換えられるテストの出力なので validate_test_red は解除しない。1 回目のログ: ${flakyLogs}）`
      : `final test flake 候補（単体再実行で green）: ${s.finalTestFlaky.files.join(', ')} — 最終 tree の全件実行で落ち、落ちたファイルだけの 1 回の再実行で green（PR が書き換えられるテストの出力なので final_test_red は解除しない。1 回目のログ: ${flakyLogs}）`;
  const disclosures = [keywordAloneDisclosure, evalFailDisclosure, ciIncompleteDisclosure, finalTestFlakyDisclosure].filter(Boolean);
  if (blockingReasons.length) {
    const reasons = blockingReasons.map((r) => r.reason);
    if (keywordAloneDisclosure) reasons.push(keywordAloneDisclosure);
    if (evalFailDisclosure) reasons.push(evalFailDisclosure);
    if (ciIncompleteDisclosure) reasons.push(ciIncompleteDisclosure);
    if (finalTestFlakyDisclosure) reasons.push(finalTestFlakyDisclosure);
    return { tier: 'HOLD', reasons, holdReasons: blockingReasons, holdKind: aggregateHoldKind(blockingReasons), disclosures };
  }
  if (s.shape === 'micro' && s.docsOrTestOnly) {
    const autoReasons = ['micro + docs/test-only + danger clean + 収束済 — 推奨ラベル（merge は人間）'];
    // micro path は evaluator 0 回で AC を判定していない — AUTO 推奨でもその事実を開示する（issue #233）。
    // evalSkipped は optional（未指定 = falsy = 開示なし）。tier 判定値は変更しない（ゲート境界不変）。
    // 注: evalSkipped 開示行は disclosures には含めない（tier 判断（micro eval skip）に関わる情報のため）。
    if (s.evalSkipped === true) autoReasons.push('AC は未検証（micro eval skip）— evaluator 0 回のため acceptance_criteria の充足は判定していない');
    if (keywordAloneDisclosure) autoReasons.push(keywordAloneDisclosure);
    if (evalFailDisclosure) autoReasons.push(evalFailDisclosure);
    if (ciIncompleteDisclosure) autoReasons.push(ciIncompleteDisclosure);
    if (finalTestFlakyDisclosure) autoReasons.push(finalTestFlakyDisclosure);
    return { tier: 'AUTO', reasons: autoReasons, holdReasons: [], holdKind: null, disclosures };
  }
  // REVIEW / AUTO の既定文は終端サマリーが「理由の節を出さない」判定に使う（devflow-summary-format.mjs の
  // DEFAULT_TIER_REASONS）。文言を変えるときは両方を揃える（不一致は summary 側のテストが落とす）。
  const reviewReasons = ['標準 — 人間が LGTM して merge'];
  if (keywordAloneDisclosure) reviewReasons.push(keywordAloneDisclosure);
  if (evalFailDisclosure) reviewReasons.push(evalFailDisclosure);
  if (ciIncompleteDisclosure) reviewReasons.push(ciIncompleteDisclosure);
  if (finalTestFlakyDisclosure) reviewReasons.push(finalTestFlakyDisclosure);
  return { tier: 'REVIEW', reasons: reviewReasons, holdReasons: [], holdKind: null, disclosures };
}
