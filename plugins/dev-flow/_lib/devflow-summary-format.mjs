// buildDevflowSummaryBody: dev-flow の終端サマリー markdown を生成する純粋関数。
// I/O なし、gh なし、Date.now() 等の非決定性なし。同入力 -> byte 一致。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。

// マージ後確認の定型文（danger class → 文言）の閉じたテーブル（issue #658）。danger-grep の
// 8 クラス全件を網羅する。未知 class は buildDevflowSummaryBody 側で汎用文にフォールバックする
// （fail-safe。throw しない）。
const POST_MERGE_CHECK = {
  'config': 'CI/CD・環境設定の変更を含む — PR CI で通らない経路（push トリガの deploy workflow 等）があれば対象 workflow の初回実行を確認する',
  'data-migration': 'migration を含む — マージ後に migration が実行される経路（migrate workflow / deploy hook）の初回実行結果を確認し、ロールバック手順を手元に置く',
  'dependency': '依存関係の変更を含む — deploy 環境（CI runner / Dockerfile / deploy workflow）で lockfile・パッケージマネージャ版が解決できるか、マージ後の初回 build / deploy を確認する',
  'auth': '認証・認可経路の変更を含む — マージ後に本番相当環境でログイン / 権限チェックの smoke を行う',
  'crypto': '暗号・秘密情報の扱いの変更を含む — 鍵 / トークンのローテーション要否と、ログへの秘密情報出力がないことを確認する',
  'public-api': '公開 API の変更を含む — 利用側（他 repo / クライアント）への告知と互換性を確認する',
  'exec-sink': '外部コマンド実行経路の変更を含む — 入力の sanitization を再確認し、マージ後の実行ログに異常がないか監視する',
  'test-weakening': 'テスト弱体化の疑いを含む — マージ後の CI で当該テストが実行されていること（skip / only が残っていないこと）を確認する',
};

// classifyMergeTier（merge-tier.mjs）が REVIEW / AUTO で必ず先頭に積む既定の理由文。tier を言い換えた
// だけで情報が無いため、理由がこれだけなら「Merge tier 理由」の節を出さない。canonical は merge-tier.mjs
// で、import できないため重複定義する（同値性は devflow-summary-format.test.mjs が classifyMergeTier の
// 返り値と突き合わせて pin する）。
const DEFAULT_TIER_REASONS = [
  '標準 — 人間が LGTM して merge',
  'micro + docs/test-only + danger clean + 収束済 — 推奨ラベル（merge は人間）',
];

// 解消済み証跡の折りたたみ表の上限（issue #707）。GitHub のコメント本文上限（65536 文字）を
// 解消済み項目の件数・evidence 長で超えないよう、行数とセル長の両方を決定論で切る。
// セルは空白・改行を 1 空白に畳んでから code point 単位で切るので、1 セルは escape 後も
// 高々 2 × RESOLVED_CELL_MAX 文字（'|' → '\|'）、表全体は 30 行 × 2 セルで約 25,000 文字に収まる。
// 切った残りは打ち切り件数だけを出す（全文の保存先は持たない）。
// RESOLVED_CELL_MAX は evaluator の evidence 上限（evaluator-contract の EVAL_EVIDENCE_MAX）以上に保つ
// （evaluator-contract.test.mjs が pin）。
const RESOLVED_ROWS_MAX = 30;
export const RESOLVED_CELL_MAX = 200;

// 観測型 AC（実行して出力・記録を観測しないと確かめられない AC）が未達のときの対応欄（issue #844）。
const OBSERVATIONAL_AC_ACTION = '実行して AC の主張を確認する（例: merge 後の実 run・計測）';
// evaluator が未達の理由を実行環境に届かない（unreachable_env:true）と返した AC の対応欄（issue #861）。
// コード上に未達の根拠が無いので「修正が必要」とは書かない。
const UNREACHABLE_ENV_AC_ACTION = '実行して確認する';

// ci の AC（ci_verify の check で判定する AC。issue #861）が未確定のときの対応欄。ciVerify は pr-iterate の返り値 ci_verify。
function ciAcAction(ciVerify) {
  const checks = Array.isArray(ciVerify?.checks) && ciVerify.checks.length ? ciVerify.checks.map((c) => `\`${c}\``).join(', ') : 'CI の check';
  if (ciVerify?.status === 'pending') return `CI の ${checks} 実行中 — 結果を確認して merge`;
  if (ciVerify?.status === 'failed') return `CI の ${checks} の失敗ログを確認する`;
  return `CI の ${checks} の結果を確認して merge`;
}

// local-verify の結果の 1 行（「参考」節。issue #863）。unavailable / error / skipped は CI の check 待ちに回した理由、
// stale は passed を最終 tree の根拠にしなかった理由を出す。
function localVerifyLine(lv) {
  const cmd = `\`${lv.command ?? 'local_verify'}\``;
  const log = lv.log_path ? `log: ${lv.log_path}` : 'log なし';
  if (lv.status === 'passed') return `${cmd} が exit 0（${log}）— ci の AC を satisfied にした。CI の check の結果は待っていない`;
  if (lv.status === 'failed') {
    return `${cmd} が exit ${lv.exit_code ?? '?'}（差し戻し ${Number.isInteger(lv.reimpl_count) ? lv.reimpl_count : '?'} 回後も失敗。${log}）— ci の AC は未達（エージェント）`;
  }
  // stale: passed を出した tree と最終 tree が異なり、最終 tree で確かめられなかった。CI の check は待っていない
  if (lv.status === 'stale') return `${cmd} の exit 0 は最終 tree の結果ではない（${mdCell(lv.reason ?? '最終 tree で確かめられない')}）— ci の AC は未確定。PR の CI の結果で判定する`;
  return `${mdCell(lv.reason ?? '実行できなかった')} — ci の AC は CI の check の結果で判定した`;
}

// base との conflict の自動解消（issue #916）の表示。conflictAutoresolve は pr-iterate の返り値 conflict_autoresolve
// （_lib/conflict-autoresolve.mjs の conflictAutoresolveRecord の配列）。自動解消した試行は「参考」に型とファイルを出し、
// 解消しなかった試行は mergeable_conflicting の HOLD 理由の「現状」に止めたファイル（型 A / B 以外）と型を添える。
function conflictFileCell(f) {
  return `\`${mdCell(f.path)}\`（${f.type === 'A' || f.type === 'B' ? `型 ${f.type}` : mdCell(f.type)}）`;
}
function conflictResolvedLines(conflictAutoresolve) {
  return (Array.isArray(conflictAutoresolve) ? conflictAutoresolve : [])
    .filter((r) => r != null && r.status === 'resolved')
    .map((r) => `- base との conflict を自動解消した（pr-iterate 反復 ${r.iteration}${r.merge_sha ? `・merge commit \`${String(r.merge_sha).slice(0, 7)}\`` : ''}）: `
      + `${(Array.isArray(r.files) ? r.files : []).map(conflictFileCell).join(' / ') || '—'}`);
}
function conflictStoppedNote(conflictAutoresolve) {
  const list = (Array.isArray(conflictAutoresolve) ? conflictAutoresolve : []).filter((r) => r != null && r.status !== 'resolved');
  if (list.length === 0) return '';
  const last = list[list.length - 1];
  const files = Array.isArray(last.files) ? last.files : [];
  const stopped = files.filter((f) => f.type !== 'A' && f.type !== 'B');
  const shown = stopped.length > 0 ? stopped : files;
  return `（自動解消せず: ${mdCell(last.reason || last.status)}${shown.length ? ` — ${shown.map(conflictFileCell).join(' / ')}` : ''}）`;
}

function resolvedCell(v) {
  if (v == null) return '';
  const chars = Array.from(String(v).replace(/\s+/g, ' ').trim());
  const s = chars.length > RESOLVED_CELL_MAX ? chars.slice(0, RESOLVED_CELL_MAX - 1).join('') + '…' : chars.join('');
  return mdCell(s);
}

/**
 * dev-flow 終端サマリー markdown を生成する。
 * @param {object} opts
 * @param {number|string} opts.pr - PR 番号
 * @param {string} opts.mergeTier - 'HOLD'|'REVIEW'|'AUTO'
 * @param {string[]} opts.mergeTierReasons - 理由文字列の配列
 * @param {string} opts.gatePolicy - gate policy 文字列（例 'llm-major-advisory'）。本文には出さず末尾の HTML コメントに置く
 * @param {Array<{id,text,severity,checked,dimension,evidence,source,floor,danger_class,fail_closed}>} opts.blockingItems - blocking items。
 *   SEC seed item（source:'seed' && dimension:'security'）は danger-grep 由来の決定論 floor item で、
 *   floor:true が付いた item から Security clearance セクションを導出する（checked/evidence/danger_class を使用）。
 *   fail_closed:true は danger-grep-final 実行不能を示し、専用の fail-closed 空状態行を出す。
 *   blocking lane では item.final_resolution / item.final_evidence を無視する（軸A invariant。issue #658）
 * @param {Array<{id,text,severity,checked,dimension,evidence,escalate,escalate_reason,escalate_description,env_key,env_count,triaged,triaged_evidence,final_resolution,final_evidence}>} opts.advisoryItems - advisory items（dimension:'environment' の item は「環境ノート」として件数のみ常時可視で表示される。issue #296）。
 *   advisory lane かつ `triaged:true` かつ `triaged_evidence` 非空（escalate でない）の item は要対応表・要対応判定から除外し、
 *   要対応セクション直後の `<details>`（🔹 トリアージ済み N 件）に 観点/内容/triaged_evidence を全文で出す（表示のみ。checked/ゲート不変。blocking lane では無視。issue #614, #626）。
 *   `escalate_description`: escalate item の詳細説明（要対応テーブルの内容列に要約として連結。issue #658）。
 *   `final_resolution`: 'resolved'|'ci_delegated'|'unresolved'|undefined — Final AC reconcile が
 *   fix 後の最終 tree で item を再評価した結果（表示専用。checked/ゲート/escalateCount には影響しない。issue #658）。
 *   `final_evidence`: string|null|undefined — final_resolution の根拠
 * @param {boolean} opts.ledgerConverged - ledger 収束フラグ
 * @param {Array<{ac_index,satisfied,evidence,verified_by}>|null|undefined} opts.acResults - AC 判定結果
 * @param {string[]} opts.dangerHits - danger-grep で検出したクラス名
 * @param {string[]} [opts.testsurfHits] - danger-grep（test-weakening クラス）で検出した TESTSURF pattern 名の配列（issue #362）
 * @param {string|null|undefined} opts.shape - 実効 shape（'micro'|'standard'|'complex'）
 * @param {boolean|null|undefined} opts.testGreen - test green フラグ（at-a-glance 表では finalReconcile が 'reverified' のとき最終状態を優先。issue #625）
 * @param {'passed'|'failed'|'no_tests'|'error'|null|undefined} [opts.validateTests] - Validate 時点の GREEN.tests。
 *   'error' は起動失敗（テストが 1 件も実行されていない）で、at-a-glance 表では ❌ red と区別する（issue #707）。
 *   CI の success では green 扱いにしない（merge tier も validate_tests_not_run で HOLD。issue #1138）
 * @param {string|null|undefined} opts.evalVerdict - evaluator verdict（'pass'|'fail' 等）（at-a-glance 表では iterate_fixed+lgtm+finalAcReconcile=reverified の fail を '✅ pass (fix 後 LGTM)' と表示。issue #625）
 * @param {string|null|undefined} opts.evalStaleness - 'none'|'hash_mismatch'|'hash_reconverged'|'iterate_incomplete'|'iterate_fixed'（issue #288, #631）
 * @param {string|null|undefined} [opts.evalDiffHash] - Evaluate 時点の tree diff hash（issue #631）
 * @param {string|null|undefined} [opts.prDiffHash] - PR phase 直前の tree diff hash（issue #631）
 * @param {Array<{path:string,insertions:number,deletions:number}>|null|undefined} [opts.staleDiffFiles] - hash_mismatch/hash_reconverged 時の eval→PR 直前の差分ファイル一覧。null は取得失敗（issue #631）
 * @param {string|null|undefined} [opts.prHeadTreeOid] - PR head commit の tree OID（issue #631）
 * @param {number|null|undefined} opts.iterateFixesApplied - pr-iterate の適用 fix 件数（iterate_fixed 表示用）
 * @param {string|null|undefined} opts.finalReconcile - Final reconcile 結果（'skipped'|'reverified'|'unavailable'。issue #320）
 * @param {boolean|null|undefined} opts.finalTestGreen - Final reconcile 時の test green フラグ（issue #320）
 * @param {{files:string[], logs:string[]}|null|undefined} [opts.finalTestFlaky] - 全件実行で落ち、落ちたファイルだけの
 *   単体再実行が green だった記録（issue #865）。finalReconcile==='reverified' かつ finalTestGreen===true（test#final の flake）
 *   のときテスト欄（と Final reconcile 行）を flake 表記にする。finalReconcile==='skipped' かつ validateTests==='failed'
 *   （Validate の単体再実行 green。issue #1138）は red のまま flake 候補を添える（表示専用。merge tier の開示行は disclosures 側で出る）
 * @param {string|null|undefined} opts.finalAcReconcile - Final AC reconcile 結果（'skipped'|'reverified'|'unavailable'。issue #331）
 * @param {{decision:string|null, ci:string, summary:string|null}|null|undefined} [opts.liteReview] - dev-flow lite 経路の pr-review-lite 結果。非 null の場合のみ「lite レビュー」セクションを描画する（issue #392 AC-6）
 * @param {string|null|undefined} [opts.iterateStatus] - pr-iterate 終端 status（'lgtm'|'stuck'|'fix_failed'|'max_reached'|'ci_error'|'ci_pending'|'review_contract_error'。非 'lgtm' のときのみ未解消指摘セクションを描画する。issue #602）
 * @param {Array<{iteration:number,decision:string,summary:string,blocking:Array<{severity,topic,file,line,description,suggestion}>,minor:Array}>|null|undefined} [opts.iterateHistory] - pr-iterate の round 履歴（issue #602）
 * @param {number|null|undefined} [opts.iterateIterations] - pr-iterate 返り値 iterations。history 末尾 round の iteration と一致するときのみその round を終端 round とみなす（ci_error/ci_pending/review_contract_error は終端 round を history に push しないため）。null なら末尾 round を採用（issue #602）
 * @param {Array<{code:string, reason:string, kind:'deterministic_recheck'|'human_judgment'}>|null|undefined} [opts.holdReasons] - HOLD 判定に寄与した理由（HOLD 時のみ非空。merge-tier.mjs の
 *   閉じた code enum（HOLD_REASON_CODES）を持つ）。summary は code から「現状/対応」列を fail-safe に
 *   写像する（out-of-enum/欠落は '—' / '人が確認する'。throw しない。表示専用。issue #658）
 * @param {'deterministic_recheck'|'human_judgment'|null|undefined} [opts.holdKind] - HOLD 理由の代表 kind（merge-tier.mjs の aggregateHoldKind の返り値。issue #658）
 * @param {string[]|null|undefined} [opts.disclosures] - 可視化のみで HOLD 判定に寄与しない理由行（breaking keyword hit 等）。
 *   非 HOLD tier では Merge tier 理由の箇条書きから除外し「参考」セクションへ回す（HOLD tier は従来どおり
 *   mergeTierReasons を無加工で列挙する。issue #658）
 * @param {string[]|null|undefined} [opts.changedFiles] - 変更ファイルパス一覧。`.github/workflows/` 配下の変更が
 *   含まれる場合、あなたがやること に「マージ後: 対象 workflow の初回実行を確認する」を追加する
 *   （config danger class は .env / config/*.yml / secret 代入のみを判定し .github/workflows/*.yml に
 *   一致しないため、workflow 変更は別途 changedFiles から直接検出する。issue #662）
 * @param {string[]|null|undefined} [opts.baseFailingTests] - Validate が「diff と無関係で base でも同じように落ちる」と
 *   判定し green 要件から外したテストファイル（_lib/base-failure-triage.mjs）。非空なら at-a-glance のテスト欄の
 *   green に除外件数を添え、参考セクションに「base でも失敗する既存の失敗」としてファイルを列挙する（表示専用）
 * @param {Array<{severity,topic,file,line,description,suggestion}>|null|undefined} [opts.humanFollowups] - pr-iterate が
 *   worktree の外を指すとして fix から外した指摘（返り値 human_followups）。非空なら「人間側 follow-up」節に出す（表示専用）
 * @param {string[]|null|undefined} [opts.outOfScope] - dev-implementer が out_of_scope[] で申告した、issue 本文にあるが
 *   実施しなかった作業。非空なら「この PR に含めなかったもの」節にそのまま出す（表示専用）
 * @param {{agent:number[], human:number[], ci?:number[]}|null|undefined} [opts.unsatisfiedAcByActor] - merge tier が
 *   ac_agent_unsatisfied / ac_human_pending / ac_ci_pending の入力にした AC 未達の actor 別 index（0 始まり）。同じ AC に紐づく
 *   HOLD 理由をまとめるとき、AC 未達の code を AC ごとに決めるのに使う。human / ci の AC の未達はコード上の未達の根拠では
 *   ないので、結論行の「修正作業が必要」の根拠に数えない（表示専用。欠落なら AC 未達の code はまとめず、未達 AC は全件修正の根拠に数える）
 * @param {{status:string, checks:string[], urls?:string[], waited_seconds?:number}|null|undefined} [opts.ciVerify] - pr-iterate の返り値
 *   ci_verify（LGTM 後の ci_verify.checks の待ち結果）。ac_ci_pending の「現状/対応」に check 名と状態を出す（表示専用）
 * @param {{status:string, command:string, label?:string, reason?:string, exit_code?:number|null, log_path?:string|null, reimpl_count?:number}|null|undefined} [opts.localVerify] -
 *   local-verify（ci の AC を pg-broker の DB でローカル実行。issue #863）の結果。「参考」に 1 行出す（unavailable / error / skipped は
 *   CI の check 待ちに回した理由）。passed なら「あなたがやること」に merge 前の CI 確認を足す（run は check の結果を待っていない）。表示専用
 * @param {Array<{iteration:number, status:string, reason?:string, files?:Array<{path:string,type:string}>, merge_sha?:string|null}>|null|undefined} [opts.conflictAutoresolve] -
 *   pr-iterate の返り値 conflict_autoresolve（base との conflict の自動解消の試行。issue #916）。自動解消した試行は「参考」に型とファイルを、
 *   解消しなかった試行は mergeable_conflicting の HOLD 理由の「現状」に止めたファイルと型を出す（表示専用）
 * @param {{target:boolean, status:string, stop_reason?:string|null, rounds?:number, critical?:number, major?:number, minor?:number, deferred?:number}|null|undefined} [opts.securityReview] -
 *   敵対的 security review の結果（issue #1063）。security_review_unresolved の「現状」に回数と件数だけを出す — 指摘の本文
 *   （攻撃経路）は公開コメントに載せない（表示専用）。deferred（fix が直さずに人の判断に返した指摘の件数）が 1 以上ならその件数も出す。
 *   stop_reason が 'reviewer_context_changed' なら「自動 review をしていない」と
 *   変わった指示ファイルを一覧する固定の確認コマンドと、`security-review-isolated <PR>` の実行案内を出す
 * @param {string|null|undefined} [opts.headSha] - merge tier の結論を出した PR head の commit sha（merge-tier-facts の headRefOid）。
 *   40 桁 hex のときだけ末尾 marker に `head=<sha>` で載せる（issue #1065）
 * @returns {string}
 */
export function buildDevflowSummaryBody({
  pr,
  mergeTier,
  mergeTierReasons,
  gatePolicy,
  blockingItems,
  advisoryItems,
  ledgerConverged,
  acResults,
  dangerHits,
  testsurfHits,
  shape,
  testGreen,
  validateTests,
  evalVerdict,
  evalStaleness,
  evalDiffHash,
  prDiffHash,
  staleDiffFiles,
  prHeadTreeOid,
  iterateFixesApplied,
  finalReconcile,
  finalTestGreen,
  finalTestFlaky,
  finalAcReconcile,
  liteReview,
  iterateStatus,
  iterateHistory,
  iterateIterations,
  holdReasons,
  holdKind,
  disclosures,
  changedFiles,
  baseFailingTests,
  humanFollowups,
  outOfScope,
  unsatisfiedAcByActor,
  ciVerify,
  localVerify,
  conflictAutoresolve,
  securityReview,
  headSha,
}) {
  const EVAL_STALENESS_VALUES = ['none', 'hash_mismatch', 'hash_reconverged', 'iterate_incomplete', 'iterate_fixed'];
  if (evalStaleness != null && !EVAL_STALENESS_VALUES.includes(evalStaleness)) {
    throw new Error('buildDevflowSummaryBody: invalid evalStaleness: ' + evalStaleness);
  }

  const FINAL_RECONCILE_VALUES = ['skipped', 'reverified', 'unavailable'];
  if (finalReconcile != null && !FINAL_RECONCILE_VALUES.includes(finalReconcile)) {
    throw new Error('buildDevflowSummaryBody: invalid finalReconcile: ' + finalReconcile);
  }

  const FINAL_AC_RECONCILE_VALUES_LOCAL = ['skipped', 'reverified', 'unavailable'];
  if (finalAcReconcile != null && !FINAL_AC_RECONCILE_VALUES_LOCAL.includes(finalAcReconcile)) {
    throw new Error('buildDevflowSummaryBody: invalid finalAcReconcile: ' + finalAcReconcile);
  }

  const VALIDATE_TESTS_VALUES = ['passed', 'failed', 'no_tests', 'error'];
  if (validateTests != null && !VALIDATE_TESTS_VALUES.includes(validateTests)) {
    throw new Error('buildDevflowSummaryBody: invalid validateTests: ' + validateTests);
  }

  // 非空文字列判定（final_evidence / escalate_description の妥当性チェックに使う。issue #658）。
  const nonEmpty = (s) => typeof s === 'string' && s.length > 0;

  // advisory item の「fix 後 tree での再評価」解消判定。blocking lane では呼ばない（軸A invariant）。
  // 'resolved': fix 後の最終 tree で直接再検証済み。'ci_delegated' は解消扱いにしない — PR の CI の success は
  // PR が書き換えられる（CI が呼ぶスクリプトも PR head のもの）ため、検証の決定論事実にならない。
  const isResolved = (it) => it.final_resolution === 'resolved' && nonEmpty(it.final_evidence);

  // Security clearance は最終 ledger の SEC seed item（source:'seed' && dimension:'security' && floor:true）
  // から導出する（evalResult.security_clearance は使わない — PR #16 型の表示矛盾を防ぐため）。
  // SEC seed item は check.kind:'deterministic' のため全 gate_policy で blocking lane（軸A invariant）
  // であり、blockingItems からの導出は gate_policy に依存せず成立する。
  // danger-grep が clean と判定して自動 check した SEC seed（evidence が reconcileDanger の clean 文言と
  // 完全一致）はクラスごとの行を出さず、Security の 1 行に件数でまとめる。LLM の evidence で clear した
  // SEC は従来どおり 1 行ずつ出す（clearance の根拠が人間の確認対象になるため）。
  const isDangerGrepCleanSec = (it) => it.source === 'seed' && it.dimension === 'security'
    && it.checked === true && it.evidence === 'danger-grep clean';
  const secSeedItems = (blockingItems || []).filter((it) => it.source === 'seed' && it.dimension === 'security');
  const cleanSecItems = secSeedItems.filter(isDangerGrepCleanSec);
  const secLedgerItems = secSeedItems.filter((it) => it.floor === true && !isDangerGrepCleanSec(it));
  const securityClearance = secLedgerItems.map((it) => ({
    danger_class: it.danger_class,
    cleared: it.checked === true,
    evidence: it.evidence,
  }));
  // fail_closed:true の SEC seed item がある場合、danger-grep-final が実行不能だったことを示す。
  // この場合は「clean（clearance 不要）」と混同せず、専用の fail-closed 空状態行を出す。
  const secFailClosed = (blockingItems || []).some(
    (it) => it.source === 'seed' && it.dimension === 'security' && it.fail_closed === true
  );

  // TESTSURF clearance は最終 ledger の TESTSURF seed item（source:'seed' && id が 'TESTSURF-' 始まり）
  // から導出する（SEC seed item と同型。issue #362）。id 形式は `TESTSURF-<PATTERN>` 固定。
  const testsurfLedgerItems = (blockingItems || []).filter(
    (it) => it.source === 'seed' && typeof it.id === 'string' && it.id.startsWith('TESTSURF-')
  );
  const testsurfClearance = testsurfLedgerItems.map((it) => ({
    pattern: it.id.slice('TESTSURF-'.length),
    cleared: it.checked === true,
    evidence: it.evidence,
  }));

  // ─── 要対応判定に使う派生集合（結論行・あなたがやること・要対応表で共有する。issue #658） ───
  const blockArr = blockingItems || [];
  const advArr = advisoryItems || [];
  const envItems = advArr.filter(it => it.dimension === 'environment');
  const uncheckedBlocking = blockArr.filter(it => it.checked !== true);

  // triaged: evaluator が「再検証済み・対応不要」と判断した advisory item の表示専用フラグ
  // （checked は false のまま・ゲート不変。issue #614）。evidence 非空文字列のときのみ有効。
  const isTriaged = (it) => it.triaged === true && typeof it.triaged_evidence === 'string' && it.triaged_evidence.length > 0;
  // triaged advisory: 要対応表・hasActionItems から除外し、要対応セクション直後の <details> に全文で残す（issue #626）。
  // escalate:true は要判断として要対応に残す（escalate 優先）。environment は環境ノート経路（除外）。blocking lane では triaged を無視する（#614 仕様 4 項）。
  const isTriagedAdvisory = (it) => it.checked !== true && it.dimension !== 'environment' && it.escalate !== true && isTriaged(it);
  const triagedAdvisory = advArr.filter(isTriagedAdvisory);

  // escalate 行は「全 escalate」（checked / 解消済みを問わず）を要対応表に常時表示する（issue #658）。
  // 解消状態は行の状態/現状/対応列に反映するが、行自体は隠さない — HOLD の ESCALATE は
  // human required-block のままであることを可視化する。
  const escalateAll = advArr.filter(it => it.escalate === true && it.dimension !== 'environment');

  const acArr = acResults && acResults.length > 0 ? acResults : null;
  const unsatisfiedAC = acArr ? acArr.filter(a => a.satisfied !== true) : [];
  // 観点 ac の ledger item（id: AC-<n> / AC-FINAL-<n>）が未達 AC を指すなら、未達 AC 表（必須）と重なるので
  // 助言の行には出さない — 同じ AC を「任意」と「必須」の両方で出さないため（issue #738）。
  const unsatisfiedAcIndexes = new Set(unsatisfiedAC.map(a => a.ac_index));
  const isUnsatisfiedAcItem = (it) => {
    if (it.dimension !== 'ac' || typeof it.id !== 'string') return false;
    const m = /^AC-(?:FINAL-)?(\d+)$/.exec(it.id);
    return m != null && unsatisfiedAcIndexes.has(Number(m[1]) - 1);
  };
  // 非 escalate advisory の表示候補。fix 後 tree で解消確認済み（isResolved）のものは折りたたみの
  // 「解消済み」表にだけ出し、「要対応」・「任意の確認事項」の表には出さない（同じ項目の二重掲載を防ぐ）。
  const nonEscalateUnchecked = advArr.filter(
    it => it.checked !== true && it.dimension !== 'environment' && it.escalate !== true && !isTriagedAdvisory(it)
      && !isUnsatisfiedAcItem(it) && !isResolved(it)
  );
  // hasActionItems（見出し判定）には isResolved で解消済みのものを含めない。
  const unresolvedEscalate = escalateAll.filter(it => !isResolved(it));
  const unresolvedAdvisory = nonEscalateUnchecked.filter(it => !isResolved(it));
  // 解消済み advisory（escalate 含む・environment/triaged 除く）の件数のみ表示用（issue #658）。
  const resolvedAdvisory = advArr.filter(it => it.dimension !== 'environment' && !isTriagedAdvisory(it) && isResolved(it));

  // ─── 同じ AC に紐づく ledger 未収束・ESCALATE・AC 未達のまとめ（issue #794） ───
  // 1 件の AC 未達が未 checked blocking（AC-FINAL-<n>）・ESCALATE・AC 未達の 3 系統で別々に数えられ、
  // HOLD 理由表と要対応表で同じ問題が複数行に分かれていた。AC への紐付けは決定論で、item.ac_index
  // （evaluator feedback の ac_index を転写したもの）か観点 ac の id（AC-<n> / AC-FINAL-<n>）だけを使う。
  // 2 系統以上が同じ AC に揃ったときだけ 1 行にまとめ、元の reason code を内訳に残す。1 系統だけ・
  // AC に紐づかない項目は従来どおりの行で出す。表示専用 — holdReasons・merge tier・blocking は変えない。
  const itemAcIndex = (it) => {
    if (Number.isInteger(it.ac_index) && it.ac_index >= 0) return it.ac_index;
    if (it.dimension !== 'ac' || typeof it.id !== 'string') return null;
    const m = /^AC-(?:FINAL-)?(\d+)$/.exec(it.id);
    return m != null ? Number(m[1]) - 1 : null;
  };
  const acGapsByActor = unsatisfiedAcByActor != null && typeof unsatisfiedAcByActor === 'object' ? unsatisfiedAcByActor : {};
  const acAgentGaps = Array.isArray(acGapsByActor.agent) ? acGapsByActor.agent : [];
  const acHumanGaps = Array.isArray(acGapsByActor.human) ? acGapsByActor.human : [];
  const acCiGaps = Array.isArray(acGapsByActor.ci) ? acGapsByActor.ci : [];
  // 観測型 AC（ac_results の observational:true。_lib/ac-actor.mjs の demoteUnprovenObservationalAc が付ける）の未達は
  // 人手 AC 待ちのうち「実行して確かめる」もの。対応欄の文言を分け、どの AC が観測型かを AC 番号で出す。
  const observationalGaps = unsatisfiedAC.filter((a) => a.observational === true).map((a) => a.ac_index);
  // evaluator が実行環境に届かない（unreachable_env:true）と返した AC の未達も人手 AC 待ちのうち「実行して確かめる」もの。
  const unreachableGaps = unsatisfiedAC.filter((a) => a.unreachable_env === true && acHumanGaps.includes(a.ac_index) && a.observational !== true).map((a) => a.ac_index);
  const acUnsatisfiedCode = (k) => {
    if (acAgentGaps.includes(k)) return 'ac_agent_unsatisfied';
    if (acHumanGaps.includes(k)) return 'ac_human_pending';
    if (acCiGaps.includes(k)) return 'ac_ci_pending';
    return null;
  };
  // 人手 AC 待ち・CI 判定待ちの AC の未達はコード上の未達の根拠ではない（worktree で直す対象が無い）。
  // unsatisfiedAcByActor が渡されないときは actor が分からないので、未達 AC を全件修正の根拠に数える。
  const pendingAcIndexes = new Set([...acHumanGaps, ...acCiGaps]);
  const fixableUnsatisfiedAC = unsatisfiedAC.filter((a) => !pendingAcIndexes.has(a.ac_index));
  const acGroupMap = new Map();
  const acGroupOf = (k) => {
    if (!acGroupMap.has(k)) acGroupMap.set(k, { acIndex: k, blocking: [], escalate: [], ac: null });
    return acGroupMap.get(k);
  };
  for (const it of uncheckedBlocking) {
    const k = itemAcIndex(it);
    if (k != null) acGroupOf(k).blocking.push(it);
  }
  for (const it of escalateAll) {
    const k = itemAcIndex(it);
    if (k != null) acGroupOf(k).escalate.push(it);
  }
  for (const a of unsatisfiedAC) {
    if (acGroupMap.has(a.ac_index)) acGroupMap.get(a.ac_index).ac = a;
  }
  const acGroups = [...acGroupMap.values()]
    .filter((g) => [g.blocking.length > 0, g.escalate.length > 0, g.ac != null].filter(Boolean).length >= 2)
    .sort((a, b) => a.acIndex - b.acIndex)
    .map((g) => {
      const acCode = g.ac != null ? acUnsatisfiedCode(g.acIndex) : null;
      const codes = [
        ...(g.blocking.length > 0 ? ['ledger_unconverged'] : []),
        ...(g.escalate.length > 0 ? ['escalate'] : []),
        ...(acCode ? [acCode] : []),
      ];
      const observational = observationalGaps.includes(g.acIndex);
      const label = `AC#${g.acIndex + 1}${g.ac != null ? ' 未達' : ''}${observational ? '（観測型）' : ''}`;
      const unresolvedEsc = g.escalate.filter((it) => !isResolved(it));
      const actions = [];
      if (acCode === 'ac_human_pending') actions.push(observational ? OBSERVATIONAL_AC_ACTION : unreachableGaps.includes(g.acIndex) ? UNREACHABLE_ENV_AC_ACTION : '人手で実施して AC を確認する');
      else if (acCode === 'ac_ci_pending') actions.push(ciAcAction(ciVerify));
      else if (g.blocking.length > 0 || g.ac != null) actions.push('修正が必要');
      for (const it of unresolvedEsc) actions.push(`要判断${it.escalate_reason ? '（' + mdCell(it.escalate_reason) + '）' : ''}`);
      return { ...g, codes, label, actions };
    });
  const groupedAcIndexes = new Set(acGroups.map((g) => g.acIndex));
  const isGroupedItem = (it) => groupedAcIndexes.has(itemAcIndex(it));

  const uncleared = securityClearance.filter(sc => sc.cleared !== true);

  // fixRequired: 結論行・あなたがやること の分岐に使う「修正作業」の要否（escalate/advisory の
  // 要判断・助言は含めない — 人間の判断のみで済む項目は「修正」ではない）。
  // holdReasons に conflict/final_test_red/iterate_non_lgtm/pr_closes_missing の code があれば、
  // 他の指標が空でも修正必須と判定する（PR #662 レビュー: mergeable_conflicting 単独 HOLD で
  // 結論行「修正作業は不要です」と HOLD 理由テーブルの対応列「conflict を解消して push する」が
  // 自己矛盾していた。pr_closes_missing も同型 — issue #661）。
  const FIX_REQUIRED_HOLD_CODES = ['mergeable_conflicting', 'final_test_red', 'validate_test_red', 'iterate_non_lgtm', 'pr_closes_missing', 'ci_checks_failed'];
  const testsurfUncleared = testsurfClearance.some(tc => !tc.cleared);
  const fixRequiredHold = Array.isArray(holdReasons) && holdReasons.some(hr => FIX_REQUIRED_HOLD_CODES.includes(hr && hr.code));
  const fixRequired = uncheckedBlocking.length > 0
    || fixableUnsatisfiedAC.length > 0
    || uncleared.length > 0
    || testsurfUncleared
    || finalTestGreen === false
    || (iterateStatus != null && iterateStatus !== 'lgtm')
    || fixRequiredHold;

  // hasRequiredItems: 見出し「⚠️ 要対応」の判定。必須項目（unchecked blocking / 未解消 escalate /
  // AC 未達 / 未クリアの security・testsurf / 修正必須の HOLD reason）だけで決める。advisory（任意）
  // だけのときは「ℹ️ 任意の確認事項」にして、結論行の「助言 N 件は任意」と矛盾させない（issue #707）。
  const hasRequiredItems = uncheckedBlocking.length > 0
    || unresolvedEscalate.length > 0
    || unsatisfiedAC.length > 0
    || uncleared.length > 0
    || testsurfUncleared
    || fixRequiredHold;

  const lines = [];

  const TIER_EMOJI = { 'HOLD': '🔶', 'REVIEW': '🔷', 'AUTO': '✅' };

  // 1. 見出し
  lines.push(`## dev-flow 終端サマリー — PR #${pr}`);
  lines.push('');

  // 2. 結論行（issue #658 AC-1）。要対応テーブルより前・at-a-glance 表より前に置く。
  let tierPhrase;
  if (mergeTier === 'HOLD') tierPhrase = '自動マージ対象外（HOLD）';
  else if (mergeTier === 'REVIEW') tierPhrase = '人間レビュー後にマージ（REVIEW）';
  else tierPhrase = '低リスク・AUTO 推奨（merge は人間）';

  let fixPhrase;
  // 修正が要るときも助言の件数を「任意」と添え、「要対応」の ❌ と「任意の確認事項」の分け方に揃える（issue #738）。
  if (fixRequired) fixPhrase = unresolvedAdvisory.length > 0 ? `修正作業が必要です（助言 ${unresolvedAdvisory.length} 件は任意）` : '修正作業が必要です';
  else if (unresolvedAdvisory.length > 0) fixPhrase = `必須の修正作業はありません（助言 ${unresolvedAdvisory.length} 件は任意）`;
  else fixPhrase = '修正作業は不要です';
  // 行動指示は直下の「あなたがやること」にだけ書く（結論行で同じ指示を繰り返さない）。

  // at-a-glance は最終状態を出す（issue #625）。Final reconcile が最終 tree の test 状態を確定させた
  // 場合はそれを優先し、Validate 時点の testGreen は finalReconcile が 'skipped'/'unavailable'/null
  // （= 最終 tree の再検証が行われていない）のときだけ使う。経過は参考セクションの Final reconcile 行に残る。
  // Validate の tests:'error' はテストが 1 件も実行されていない起動失敗で red ではない（issue #707）。
  // 未検証として結論行で CI 確認を促す（PR が書き換えられる CI の success では green 扱いにしない）。
  const baseFailing = Array.isArray(baseFailingTests) ? baseFailingTests.filter((f) => typeof f === 'string' && f.length > 0) : [];
  // flake: 全件実行で落ち、落ちたファイルだけの単体再実行で green（issue #865）。green 扱いだが「一度落ちた」事実を
  // テスト欄（test#final の flake は Final reconcile 行にも）に残す（ファイルとログは merge tier の開示行に出る）。
  // Final reconcile が skip の run の Validate red の単体再実行 green（issue #1138）は red のまま flake 候補として添える
  // （PR が書き換えられるテストの出力なので green 扱いにしない。merge tier も validate_test_red で HOLD）。
  const hasFlakyFiles = Array.isArray(finalTestFlaky?.files) && finalTestFlaky.files.length > 0;
  const finalFlaky = finalReconcile === 'reverified' && finalTestGreen === true && hasFlakyFiles;
  const validateFlaky = finalReconcile === 'skipped' && validateTests === 'failed' && hasFlakyFiles;
  const FLAKY_CELL = '⚠️ flake（単体再実行で green）';
  let testCell;
  let testUnverified = false;
  if (finalFlaky) {
    testCell = FLAKY_CELL;
  } else if (validateFlaky) {
    testCell = '❌ red（単体再実行は green — flake 候補）';
  } else if (finalReconcile === 'reverified') {
    testCell = finalTestGreen === true ? '✅ green' : finalTestGreen === false ? '❌ red' : '不明';
  } else if (validateTests === 'error') {
    testCell = '⚠️ 未実行（環境）・未検証';
    testUnverified = true;
  } else if (testGreen == null) {
    testCell = '不明';
  } else if (testGreen === true) {
    testCell = baseFailing.length > 0 ? `✅ green（base でも失敗する既存の失敗 ${baseFailing.length} 件を除く）` : '✅ green';
  } else {
    testCell = '❌ red';
  }

  const testPhrase = testUnverified ? 'テストはローカル未実行・CI 未確認のため、CI の test 結果を確認してからマージ。' : '';
  lines.push(`**結論: ${tierPhrase}。${fixPhrase}。${testPhrase}**`);
  lines.push('');

  // 3. at-a-glance テーブル
  const tierCell = `${TIER_EMOJI[mergeTier] ?? ''} **${mergeTier}**`;
  const shapeCell = shape != null ? shape : '不明';
  // evaluator verdict=fail でも、pr-iterate が fix を適用して LGTM 終端し（iterate_fixed + lgtm）、
  // AC が最終 tree で再検証済み（finalAcReconcile=reverified）なら最終状態は pass。4 条件 AND。
  // 表示のみ — merge tier / HOLD reasons / telemetry の eval_verdict は fix 前 verdict のまま不変。
  let evalCell;
  if (evalVerdict == null) {
    evalCell = '不明';
  } else if (evalVerdict === 'pass') {
    evalCell = '✅ pass';
  } else if (
    evalVerdict === 'fail' && evalStaleness === 'iterate_fixed'
    && iterateStatus === 'lgtm' && finalAcReconcile === 'reverified'
  ) {
    evalCell = '✅ pass (fix 後 LGTM)';
  } else {
    evalCell = `❌ ${evalVerdict}`;
  }
  const ledgerCell = ledgerConverged ? '✅ 収束' : '⚠️ 未収束';
  let acCell;
  if (!acArr) {
    acCell = '—';
  } else {
    const s = acArr.filter(a => a.satisfied === true).length;
    const t = acArr.length;
    acCell = s === t ? `✅ ${s}/${t}` : `❌ ${s}/${t}`;
  }
  const dangerArr = dangerHits && dangerHits.length > 0 ? dangerHits : null;
  // evaluator が security clearance で cleared にした danger class。危険検出セル・検出クラス行・マージ後の行で
  // 「未解決の危険」として扱わない（同じサマリの解消済み証跡と矛盾させない。issue #858）。
  // SEC seed が無い・unchecked・fail-closed のクラスは cleared に入らず従来どおり ⚠️ / マージ後の行を出す。
  const clearedDangerClasses = new Set(securityClearance.filter(sc => sc.cleared === true).map(sc => sc.danger_class));
  let dangerCell;
  if (!dangerArr) dangerCell = '✅ clean';
  else if (dangerArr.every(cls => clearedDangerClasses.has(cls))) dangerCell = `✅ cleared（${dangerArr.length} クラス）`;
  else dangerCell = `⚠️ ${dangerArr.length} クラス`;
  const testsurfArr = testsurfHits && testsurfHits.length > 0 ? testsurfHits : null;
  const hasTestsurf = testsurfArr != null || testsurfClearance.length > 0;

  lines.push('| Merge tier | shape | テスト | 評価 | 台帳 (Ledger) | AC | 危険検出 |');
  lines.push('|---|---|---|---|---|---|---|');
  lines.push(`| ${tierCell} | ${shapeCell} | ${testCell} | ${evalCell} | ${ledgerCell} | ${acCell} | ${dangerCell} |`);
  lines.push('');

  // 2b. eval_staleness 警告（at-a-glance テーブル直後・gate_policy 行前。issue #288, #631）
  const short8 = (h) => (typeof h === 'string' && h.length > 0) ? h.slice(0, 8) : '不明';
  const renderDiffFiles = (files) => {
    if (files.length === 0) return '（numstat 空 — mode/permission のみの変更等）';
    const shown = files.slice(0, 10).map((f) => `${f.path} (+${f.insertions}/-${f.deletions})`).join(', ');
    const rest = files.length - 10;
    return rest > 0 ? `${shown} 他 ${rest} 件` : shown;
  };
  if (evalStaleness === 'hash_mismatch') {
    lines.push('> ⚠️ **Evaluate は古い tree に対して実行された**（Evaluate 時点と PR phase 直前の diff hash が不一致: eval ' + short8(evalDiffHash) + ' / PR 直前 ' + short8(prDiffHash) + '。eval/AC/security clearance の判定は現在の PR 内容を反映していない可能性がある）');
    if (Array.isArray(staleDiffFiles)) {
      lines.push('> 差分 ' + staleDiffFiles.length + ' 件: ' + renderDiffFiles(staleDiffFiles));
    } else {
      lines.push('> 差分ファイル一覧の取得に失敗 — `git diff --stat ' + (evalDiffHash ?? '<eval>') + ' ' + (prDiffHash ?? '<pr>') + '` を手動確認');
    }
    lines.push('');
  } else if (evalStaleness === 'hash_reconverged') {
    lines.push('> ℹ️ **PR 直前に tree が一時乖離したが PR head tree は評価済み tree と一致**（eval ' + short8(evalDiffHash) + ' / PR 直前 ' + short8(prDiffHash) + ' / PR head ' + short8(prHeadTreeOid) + '。merge 対象 tree = 評価済み tree を決定論確認済みのため HOLD しない — eval_staleness=hash_reconverged）');
    if (Array.isArray(staleDiffFiles)) {
      lines.push('> 一時差分 ' + staleDiffFiles.length + ' 件: ' + renderDiffFiles(staleDiffFiles));
    } else {
      lines.push('> 一時差分の一覧は取得失敗');
    }
    lines.push('');
  } else if (evalStaleness === 'iterate_incomplete') {
    lines.push('> ⚠️ **pr-iterate が LGTM 以外で終端した**（fix 適用後の tree に対する再評価・LGTM が得られていない。eval/AC/security clearance の判定は現在の PR 内容を反映していない可能性がある）');
    lines.push('');
  } else if (evalStaleness === 'iterate_fixed') {
    const fixCount = (typeof iterateFixesApplied === 'number' && iterateFixesApplied >= 0) ? String(iterateFixesApplied) : '不明';
    // Final AC reconcile が最終 tree で AC を再検証したときは AC テーブルが final snapshot（参考の注記と同じ）
    // なので、「AC も fix 前 tree 基準」とは書かない — 同じコメント内で基準が食い違わないようにする。
    const basis = finalAcReconcile === 'reverified'
      ? 'AC は最終 tree で再検証済み。security clearance は fix 前 tree 基準'
      : '下記の eval/AC テーブル・security clearance は fix 前 tree 基準';
    lines.push('> ℹ️ **pr-iterate が ' + fixCount + ' 件の fix を適用して LGTM 終端**（fix 内容は pr-reviewer の再レビューで担保済み。' + basis + '）');
    lines.push('');
  }

  // 4. dangerHits 検出クラス行（1件以上のとき）。gate_policy は本文に出さず末尾の HTML コメントに置く。
  if (dangerArr) {
    lines.push(`検出クラス: ${dangerArr.map(cls => clearedDangerClasses.has(cls) ? `${cls}（cleared）` : cls).join(', ')}`);
  }

  // 4b. testsurfHits 検出パターン行（1件以上のとき。issue #362）
  if (testsurfArr) {
    lines.push(`検出パターン (test-weakening): ${testsurfArr.join(', ')}`);
  }

  // 4c. あなたがやること（issue #658 AC-4）。全 tier で出す。
  if (dangerArr || testsurfArr) lines.push('');
  lines.push('### あなたがやること');
  lines.push('');
  const youDoLines = [];
  if (mergeTier === 'HOLD' && fixRequired) {
    youDoLines.push(`1. 下記「要対応」の ❌ 項目を修正して push する（レビュー再開は \`/pr-iterate ${pr}\`）`);
    youDoLines.push(`2. 再 review LGTM 後に diff を確認 → \`gh pr ready ${pr}\` → マージ`);
  } else if (mergeTier === 'HOLD' && !fixRequired && holdKind === 'deterministic_recheck') {
    youDoLines.push(`1. CI 完了 / 再取得を待って \`/pr-iterate ${pr}\` で再確認する`);
    youDoLines.push(`2. LGTM 後に diff を確認 → \`gh pr ready ${pr}\` → マージ`);
  } else if (mergeTier === 'HOLD' && !fixRequired) {
    youDoLines.push('1. 下記「HOLD になった理由と現状」を確認し、対応列が「不要」以外の行を判断する');
    youDoLines.push(`2. diff 確認 → \`gh pr ready ${pr}\` → マージ`);
  } else if (mergeTier === 'REVIEW') {
    youDoLines.push(`1. diff を review し LGTM → \`gh pr ready ${pr}\` → マージ`);
  } else {
    youDoLines.push(`1. diff を一読 → \`gh pr ready ${pr}\` → マージ`);
  }
  let youDoN = youDoLines.length + 1;
  // ci の AC をローカル実行で satisfied にした run は、PR に付けた label の CI（full-ci の build / docker-build / 全 unit テスト等）の
  // 結果を run が待っていない。merge 前に人間が確認する（issue #863）。
  if (localVerify != null && localVerify.status === 'passed') {
    youDoLines.push(`${youDoN}. マージ前: PR の CI（${localVerify.label ? `\`${localVerify.label}\` ラベルで走る ` : ''}build / docker-build / 全 unit テスト等）の結果を確認する — ci の AC はローカル実行で判定済みで、run は check の結果を待っていない`);
    youDoN++;
  }
  const seenDangerClasses = new Set();
  const dangerForYouDo = Array.isArray(dangerHits) ? dangerHits : [];
  for (const cls of dangerForYouDo) {
    if (seenDangerClasses.has(cls) || clearedDangerClasses.has(cls)) continue;
    seenDangerClasses.add(cls);
    const msg = POST_MERGE_CHECK[cls] ?? `danger class "${cls}" の変更箇所の初回動作を確認する`;
    youDoLines.push(`${youDoN}. マージ後: ${msg}`);
    youDoN++;
  }
  // 4d. workflow ファイル変更検知（config danger class は .github/workflows/*.yml に一致しないため、
  // changedFiles から直接判定する。issue #662）。
  const changedFilesArr = Array.isArray(changedFiles) ? changedFiles : [];
  const hasWorkflowChange = changedFilesArr.some((f) => /^\.github\/workflows\//.test(f));
  if (hasWorkflowChange) {
    youDoLines.push(`${youDoN}. マージ後: 対象 workflow の初回実行を確認する`);
    youDoN++;
  }
  for (const l of youDoLines) lines.push(l);

  // 5. HOLD になった理由と現状 / Merge tier 理由（常時可視。issue #658 AC-3）
  // HOLD 以外: 可視化のみの理由（disclosures）は箇条書きから除外し「参考」セクションへ回す。残りが
  // classifyMergeTier の既定文（tier そのものの言い換え）だけなら理由の節自体を出さない。
  const disclosureSet = new Set(Array.isArray(disclosures) ? disclosures : []);
  const nonHoldReasons = (mergeTierReasons || []).filter((r) => !disclosureSet.has(r));
  const showNonHoldReasons = nonHoldReasons.some((r) => !DEFAULT_TIER_REASONS.includes(r));
  if (mergeTier === 'HOLD' || showNonHoldReasons) lines.push('');
  if (mergeTier === 'HOLD' && Array.isArray(holdReasons) && holdReasons.length > 0) {
    lines.push('### HOLD になった理由と現状');
    lines.push('');
    lines.push('| 理由 | 現状 | 対応 |');
    lines.push('|---|---|---|');
    const escalateTotal = escalateAll.length;
    const escalateResolved = escalateAll.filter((it) => isResolved(it)).length;
    // 同じ AC に紐づく HOLD 理由が 2 つ以上あるときだけ AC ごとに 1 行にまとめる（issue #794）。
    // 各 code の行は、その code が数えた項目が全部まとめた行の AC に入るときだけ消す（AC に紐づかない
    // 項目が残る code は従来の行のまま残す）。
    const holdCodeSet = new Set(holdReasons.map((hr) => hr && hr.code));
    const holdAcGroups = acGroups
      .map((g) => ({ ...g, holdCodes: g.codes.filter((c) => holdCodeSet.has(c)) }))
      .filter((g) => g.holdCodes.length >= 2);
    const codeAcIndexes = {
      ledger_unconverged: uncheckedBlocking.map(itemAcIndex),
      escalate: escalateAll.map(itemAcIndex),
      ac_agent_unsatisfied: acAgentGaps,
      ac_human_pending: acHumanGaps,
      ac_ci_pending: acCiGaps,
    };
    const absorbedCodes = new Set(Object.keys(codeAcIndexes).filter((code) => {
      const covered = new Set(holdAcGroups.filter((g) => g.holdCodes.includes(code)).map((g) => g.acIndex));
      return covered.size > 0 && codeAcIndexes[code].every((k) => covered.has(k));
    }));
    const CODE_LABEL = {
      ledger_unconverged: 'ledger 未収束',
      escalate: 'ESCALATE',
      ac_agent_unsatisfied: 'AC 未達（エージェント）',
      ac_human_pending: 'AC 未達（人手）',
      ac_ci_pending: 'AC 未確定（CI）',
    };
    let acGroupRowsEmitted = false;
    for (const hr of holdReasons) {
      if (!acGroupRowsEmitted && holdAcGroups.some((g) => g.holdCodes.includes(hr && hr.code))) {
        acGroupRowsEmitted = true;
        for (const g of holdAcGroups) {
          const reason = `${g.label} — ${g.holdCodes.map((c) => CODE_LABEL[c]).join('・')} を 1 行にまとめた（内訳: ${g.holdCodes.join(' / ')}）`;
          const current = g.holdCodes.map((c) => {
            if (c === 'ledger_unconverged') return `未 checked blocking ${g.blocking.length} 件`;
            if (c === 'escalate') return `ESCALATE ${g.escalate.length} 件中 ${g.escalate.filter((it) => isResolved(it)).length} 件は fix 後 tree で解消確認済み`;
            return 'AC 判定 satisfied:false';
          }).join('・');
          lines.push(`| ${reason} | ${current} | ${g.actions.join('・')}（下表 ${g.label} 行） |`);
        }
      }
      if (absorbedCodes.has(hr && hr.code)) continue;
      const { current, action } = holdReasonDisplay(hr && hr.code, hr && hr.kind, {
        escalateTotal,
        escalateResolved,
        uncheckedBlockingCount: uncheckedBlocking.length,
        unclearedCount: uncleared.length,
        iterateStatus,
        pr,
        humanAcGaps: acHumanGaps,
        observationalAcGaps: observationalGaps,
        unreachableAcGaps: unreachableGaps,
        ciVerify,
        conflictAutoresolve,
        securityReview,
      });
      lines.push(`| ${mdCell(hr && hr.reason)} | ${current} | ${action} |`);
    }
  } else if (mergeTier === 'HOLD') {
    // fail-safe フォールバック: holdReasons が null/空でも従来どおり mergeTierReasons を列挙する。
    lines.push('**Merge tier 理由**:');
    if (!mergeTierReasons || mergeTierReasons.length === 0) {
      lines.push('- 理由記載なし');
    } else {
      for (const reason of mergeTierReasons) {
        lines.push(`- ${reason}`);
      }
    }
  } else if (showNonHoldReasons) {
    lines.push('**Merge tier 理由**:');
    for (const reason of nonHoldReasons) {
      lines.push(`- ${reason}`);
    }
  }

  // 5d. TESTSURF セクション（committed test の skip/削除/tautology 化 疑いを検出したときのみ表示。issue #362）
  // dangerHits/Security clearance と別系統（dimension:'test-integrity'）。hit ゼロ（testsurfHits 空 かつ
  // ledger に TESTSURF item なし）では一切出力しない（既存サマリーとの byte 同一を保つ regression 要件）。
  if (hasTestsurf) {
    lines.push('');
    lines.push('### 🧪 TESTSURF（test-weakening 検出）');
    if (testsurfClearance.length > 0) {
      lines.push('');
      lines.push('| 状態 | pattern | 内容 |');
      lines.push('|---|---|---|');
      for (const tc of testsurfClearance) {
        if (tc.cleared) {
          const evidenceCell = tc.evidence ? mdCell(tc.evidence) : '—';
          lines.push(`| ✅ cleared | ${tc.pattern} | ${evidenceCell} |`);
        } else {
          lines.push(`| ❌ 未解消 | ${tc.pattern} | **要人間確認**: committed test の skip/削除/tautology 化の疑い |`);
        }
      }
    }
  }

  // 6. 要対応セクション（常時可視。issue #658 AC-2）
  lines.push('');
  if (hasRequiredItems) {
    lines.push('### ⚠️ 要対応');
  } else if (unresolvedAdvisory.length > 0) {
    lines.push('### ℹ️ 任意の確認事項');
  } else {
    lines.push(triagedAdvisory.length > 0 ? `### ✅ 要対応事項なし（トリアージ済み ${triagedAdvisory.length} 件）` : '### ✅ 要対応事項なし');
  }

  // ledger 表（(i)(ii)(iii)）。escalate は解消済みでも常時表示する（issue #658）。
  // 必須があるときは助言を「⚠️ 要対応」の表に混ぜず、後段の「ℹ️ 任意の確認事項」節に分ける（issue #738）。
  // 必須が無いときは見出しが既に任意 / 要対応なしなので、従来どおり 1 表にまとめる（issue #707）。
  // 同じ AC にまとめた行（issue #794）は先頭に置き、まとめた blocking / escalate 行と未達 AC 表の行は出さない。
  // 現状列の「未解消」は blocking（必須）の項目にだけ使う。ESCALATE は人間の判断待ちなので「未判断」、
  // 助言（advisory）は対応が任意なので「未対応（任意）」と書き、必須の未解消と読み違えさせない。
  const escalateCurrent = (item) => {
    if (isResolved(item)) return 'fix 後 tree で確認: ' + mdCell(item.final_evidence);
    if (item.final_resolution === 'unresolved' && nonEmpty(item.final_evidence)) return 'fix 後 tree でも残る: ' + mdCell(item.final_evidence);
    return item.evidence ? mdCell(item.evidence) : '未判断';
  };
  const advisoryCurrent = (item) => {
    if (item.final_resolution === 'unresolved' && nonEmpty(item.final_evidence)) return '未対応（任意）— fix 後 tree でも残る: ' + mdCell(item.final_evidence);
    return item.evidence ? '未対応（任意）: ' + mdCell(item.evidence) : '未対応（任意）';
  };
  const acGroupRows = acGroups.map((g) => {
    const count = g.blocking.length + g.escalate.length + (g.ac != null ? 1 : 0);
    const breakdown = g.codes.length > 0 ? ` — 内訳: ${g.codes.join(' / ')}` : '';
    const content = `${g.label}: ` + [
      ...g.blocking.map((it) => mdCell(it.text)),
      ...g.escalate.map((it) => mdCell(it.text) + (nonEmpty(it.escalate_description) ? ' — ' + mdCell(it.escalate_description) : '')),
    ].join(' / ');
    const current = [
      ...g.blocking.map((it) => (it.evidence ? mdCell(it.evidence) : '未解消')),
      ...(g.ac != null ? [`AC 判定 satisfied:false（${g.ac.verified_by != null ? g.ac.verified_by : 'inspection'}）${g.ac.evidence ? ': ' + mdCell(g.ac.evidence) : ''}`] : []),
      ...g.escalate.map((it) => 'ESCALATE: ' + escalateCurrent(it)),
    ].join(' / ');
    return { _kind: 'ac_group', _line: `| ❌ 未解消 | 必須（${g.label} に紐づく ${count} 件${breakdown}） | ac | ${content} | ${current} | ${g.actions.join('・')} |` };
  });
  const requiredRows = [
    ...acGroupRows,
    ...uncheckedBlocking.filter(it => !isGroupedItem(it)).map(it => ({ ...it, _lane: '必須（blocking）', _kind: 'blocking' })),
    ...escalateAll.filter(it => !isGroupedItem(it)).map(it => ({ ...it, _lane: '要判断（advisory ESCALATE）', _kind: 'escalate' })),
  ];
  const advisoryRows = nonEscalateUnchecked.map(it => ({ ...it, _lane: '助言（advisory）', _kind: 'advisory' }));

  const pushLedgerTable = (rows) => {
    if (rows.length === 0) return;
    lines.push('');
    // id 列は出さない（ledger 内部識別子はレビュアーにはノイズ。機構側は ledger データを直接参照する）
    lines.push('| 状態 | 区分 | 観点 | 内容 | 現状 | 対応 |');
    lines.push('|---|---|---|---|---|---|');
    for (const item of rows) {
      if (item._kind === 'ac_group') {
        lines.push(item._line);
        continue;
      }
      const resolved = item._kind !== 'blocking' && isResolved(item);
      let status;
      if (item._kind === 'blocking') {
        status = '❌ 未解消';
      } else if (item._kind === 'escalate') {
        status = resolved ? '✅ 解消済み' : '⚠️ 要判断';
      } else {
        // 助言の未解消に ❌ を使わない — ❌ は結論行・「あなたがやること」が指す修正対象に限る（issue #738）。
        status = resolved ? '✅ 解消済み' : 'ℹ️ 未確認';
      }
      const dimension = item.dimension != null ? item.dimension : '—';
      let content = mdCell(item.text);
      if (item._kind === 'escalate' && nonEmpty(item.escalate_description)) {
        content += ' — ' + mdCell(item.escalate_description);
      }
      let current;
      if (item._kind === 'blocking') {
        current = item.evidence ? mdCell(item.evidence) : '未解消';
      } else if (item._kind === 'escalate') {
        current = escalateCurrent(item);
      } else {
        current = advisoryCurrent(item);
      }
      let action;
      if (resolved) {
        action = '不要';
      } else if (item._kind === 'blocking') {
        action = '修正が必要';
      } else if (item._kind === 'escalate') {
        action = `要判断${item.escalate_reason ? '（' + mdCell(item.escalate_reason) + '）' : ''}`;
      } else {
        action = '任意（助言）';
      }
      lines.push(`| ${status} | ${item._lane} | ${dimension} | ${content} | ${current} | ${action} |`);
    }
  };

  pushLedgerTable(hasRequiredItems ? requiredRows : [...requiredRows, ...advisoryRows]);

  // 必須項目が TESTSURF / 修正必須の HOLD reason だけのときは直下に表が出ないため、参照先を 1 行で示す。
  if (hasRequiredItems && requiredRows.length === 0 && unsatisfiedAC.length === 0 && uncleared.length === 0) {
    lines.push('');
    lines.push('- Goal Ledger / AC / security clearance の未解消はなし — 「HOLD になった理由と現状」・TESTSURF・pr-iterate 未解消の指摘 の未解消行を対応する');
  }

  if (hasRequiredItems) {
    // 未達 AC テーブル（(iv)）。同じ AC にまとめた行に入った AC は出さない（issue #794）
    const unsatisfiedACRows = unsatisfiedAC.filter(a => !groupedAcIndexes.has(a.ac_index));
    if (unsatisfiedACRows.length > 0) {
      lines.push('');
      lines.push('| 状態 | AC | 検証 | 根拠 |');
      lines.push('|---|---|---|---|');
      for (const ac of unsatisfiedACRows) {
        const verifiedBy = ac.verified_by != null ? ac.verified_by : 'inspection';
        const evidenceCell = ac.evidence ? mdCell(ac.evidence) : '—';
        lines.push(`| ❌ 未達 | AC#${ac.ac_index + 1}${ac.observational === true ? '（観測型）' : ''}${ac.ci === true ? '（CI）' : ''} | ${verifiedBy} | ${evidenceCell} |`);
      }
    }

    // 未確認 clearance テーブル（(v)）
    if (uncleared.length > 0) {
      lines.push('');
      lines.push('| 状態 | danger class | 根拠 |');
      lines.push('|---|---|---|');
      for (const sc of uncleared) {
        const evidenceCell = sc.evidence ? mdCell(sc.evidence) : '—';
        lines.push(`| ❌ 未確認 | ${sc.danger_class} | ${evidenceCell} |`);
      }
    }

    // 必須と並ぶ助言は別節に分ける（issue #738）。
    if (advisoryRows.length > 0) {
      lines.push('');
      lines.push('### ℹ️ 任意の確認事項');
      pushLedgerTable(advisoryRows);
    }
  }

  // 6a. トリアージ済み advisory の折りたたみ（issue #626）。要対応からは外すが、evaluator（LLM）判断の
  // 誤トリアージ検算のため 観点 / 内容 / triaged_evidence を全文で残す（件数のみに落とさない）。
  // <summary> 直後と </details> 直前の空行は GFM が details 内の table をレンダリングするために必須。
  if (triagedAdvisory.length > 0) {
    lines.push('');
    lines.push(`<details><summary>🔹 トリアージ済み ${triagedAdvisory.length} 件（evaluator 判断 — 誤トリアージ検算用）</summary>`);
    lines.push('');
    lines.push('| 観点 | 内容 | トリアージ根拠 |');
    lines.push('|---|---|---|');
    for (const item of triagedAdvisory) {
      const dimension = item.dimension != null ? item.dimension : '—';
      lines.push(`| ${dimension} | ${mdCell(item.text)} | ${mdCell(item.triaged_evidence)} |`);
    }
    lines.push('');
    lines.push('</details>');
  }

  // 6b. pr-iterate 未解消の指摘（issue #602）。iterateStatus が非 'lgtm' のときのみ描画する。
  // 出すのは終端 round（history 末尾かつ iteration === iterateIterations）の blocking findings のみ。
  // ci_error / ci_pending / review_contract_error は終端 round を history に push しないため、
  // 末尾 round の iteration が iterateIterations と一致しなければ「未解消なし」として省略する
  // （末尾 round の findings は fix → 再 review 済み）。lgtm / history 空 / findings 空では 1 行も
  // 追加しない（LGTM 終端との byte 一致を保つ regression 要件）。
  if (iterateStatus != null && iterateStatus !== 'lgtm') {
    const hist = Array.isArray(iterateHistory) ? iterateHistory : [];
    const lastRound = hist.length > 0 ? hist[hist.length - 1] : null;
    const isTerminalRound = lastRound != null
      && (typeof iterateIterations !== 'number' || lastRound.iteration === iterateIterations);
    const unresolved = isTerminalRound && Array.isArray(lastRound.blocking) ? lastRound.blocking : [];
    if (unresolved.length > 0) {
      const SEV_LABEL_LOCAL = { 'critical': '🔴 critical', 'major': '🟠 major', 'minor': '🟡 minor' };
      lines.push('');
      lines.push(`### 🔁 pr-iterate 未解消の指摘（${unresolved.length} 件 — status: ${iterateStatus}、最終反復 ${lastRound.iteration} の review 時点）`);
      lines.push('');
      let idx = 1;
      for (const f of unresolved) {
        const sev = SEV_LABEL_LOCAL[f.severity] ?? String(f.severity ?? '不明');
        const loc = (f.file != null && f.file !== '')
          ? (f.line != null ? `\`${f.file}:${f.line}\`` : `\`${f.file}\``)
          : '場所指定なし';
        lines.push(`${idx}. ${sev} — ${loc}`);
        lines.push(`   - 指摘: ${mdCell(f.description)}`);
        if (f.suggestion != null && f.suggestion !== '') {
          lines.push(`   - 提案: ${mdCell(f.suggestion)}`);
        }
        idx++;
      }
    }
  }

  // 6c. 人間側 follow-up（issue #793）。pr-iterate が worktree の外を指すとして fix から外した指摘。
  // 空なら 1 行も追加しない（既存サマリーとの byte 一致を保つ）。
  const followups = Array.isArray(humanFollowups) ? humanFollowups.filter((f) => f != null) : [];
  if (followups.length > 0) {
    const SEV_LABEL_FOLLOWUP = { 'critical': '🔴 critical', 'major': '🟠 major', 'minor': '🟡 minor' };
    lines.push('');
    lines.push(`### 👤 人間側 follow-up（worktree の外を指す指摘 — 自動修正の対象外・${followups.length} 件）`);
    lines.push('');
    followups.forEach((f, i) => {
      const sev = SEV_LABEL_FOLLOWUP[f.severity] ?? String(f.severity ?? '不明');
      const loc = (f.file != null && f.file !== '')
        ? (f.line != null ? `\`${f.file}:${f.line}\`` : `\`${f.file}\``)
        : '場所指定なし';
      lines.push(`${i + 1}. ${sev} — ${loc}`);
      lines.push(`   - 指摘: ${mdCell(f.description)}`);
      if (f.suggestion != null && f.suggestion !== '') {
        lines.push(`   - 提案: ${mdCell(f.suggestion)}`);
      }
    });
  }

  // 6d. この PR に含めなかったもの（issue #793）。dev-implementer が out_of_scope[] で申告した、issue 本文にあるが
  // 実施しなかった作業をそのまま転記する。空なら 1 行も追加しない。
  const outOfScopeItems = Array.isArray(outOfScope) ? outOfScope.filter((s) => typeof s === 'string' && s.trim().length > 0) : [];
  if (outOfScopeItems.length > 0) {
    lines.push('');
    lines.push('### この PR に含めなかったもの');
    lines.push('');
    for (const s of outOfScopeItems) lines.push(`- ${mdCell(s)}`);
  }

  // 8. 空状態の常時可視行
  // 直前コンテンツ（テーブル行 / bullet）との間に必ず空行を挿入する。
  // GFM はテーブル終端行を空行で判定し、bullet も lazy continuation で吸収するため
  // 空行なしで push するとテーブル壊れ・bullet 併合が起きる（AC-2 実効性を損なう）。
  if (lines[lines.length - 1] !== '') lines.push('');
  if (blockArr.length === 0 && advArr.length === 0) {
    lines.push('Goal Ledger: item なし');
  }
  if (!acResults || acResults.length === 0) {
    lines.push('Acceptance Criteria: AC 判定なし（evaluator 未実行 or AC 欠落）');
  }
  if (securityClearance.length === 0 && secFailClosed) {
    if ((holdReasons || []).some((r) => r?.code === 'merge_facts_dropped')) {
      lines.push('Security clearance: merge-tier-facts の転記欠落（fail-closed — danger-grep 結果を受け取れず security 未検証）');
    } else {
      lines.push('Security clearance: danger-grep 実行不能（fail-closed — security 未検証）');
    }
  } else if (cleanSecItems.length > 0) {
    lines.push(cleanSecItems.length === secSeedItems.length
      ? `Security: ${cleanSecItems.length} クラスとも danger-grep clean`
      : `Security: ${cleanSecItems.length} クラス（${cleanSecItems.map((it) => it.danger_class).join(', ')}）は danger-grep clean`);
  } else if (securityClearance.length === 0) {
    lines.push('Security clearance: danger-grep clean（clearance 不要）');
  }

  // 7. 解消済み証跡（issue #603, #707）。件数行を <details> のサマリ行にし、折りたたみの中に
  // Goal Ledger の解消済み項目を 1 行ずつ 区分 / 内容 / 解消根拠 で出す（PR 上で何が指摘され何が
  // 直ったかを追えるようにする）。未解消・未 clear の item は上記「要対応」セクションに全文で出る。
  // danger-grep clean の SEC seed は上の Security の 1 行に集約済みなので、ここでは数えず行も出さない。
  const resolvedItems = [
    ...blockArr.filter(it => it.checked === true && !isDangerGrepCleanSec(it)).map(it => ({ ...it, _lane: 'blocking' })),
    ...advArr.filter(it => it.checked === true && it.escalate !== true && it.dimension !== 'environment').map(it => ({ ...it, _lane: 'advisory' })),
  ];
  const countLines = [];
  if (resolvedItems.length > 0) countLines.push(`- ✅ Goal Ledger 解消済み ${resolvedItems.length} 件`);
  if (envItems.length > 0) countLines.push(`- 🏗 環境ノート ${envItems.length} 件（sandbox 環境事象 — 人間の対応は通常不要）`);
  if (acArr) {
    const s = acArr.filter(a => a.satisfied === true).length;
    const t = acArr.length;
    if (s > 0) countLines.push(`- ✅ 受け入れ基準 (AC) ${s}/${t} 達成`);
  }
  if (securityClearance.length > 0) {
    const c = securityClearance.filter(sc => sc.cleared === true).length;
    if (c > 0) countLines.push(`- ✅ セキュリティ確認 (Security clearance) ${c}/${securityClearance.length} 済`);
  }
  // fix 後 tree での解消確認（advisory / ESCALATE。issue #658 AC-5）。要対応表より下、この件数
  // セクションの末尾に置く（解消済み証跡セクション自体の位置は不変 — 要対応表より下のまま）。
  if (resolvedAdvisory.length > 0) countLines.push(`- ✅ fix 後 tree で解消確認 ${resolvedAdvisory.length} 件（advisory / ESCALATE — checked は不変）`);
  if (countLines.length > 0) {
    // 行の対象: checked の ledger item（上記件数と同じ選別）+ fix 後 tree で解消確認された advisory / ESCALATE。
    const resolvedRows = [
      ...resolvedItems,
      ...resolvedAdvisory.filter(it => !(it.checked === true && it.escalate !== true)).map(it => ({ ...it, _lane: 'advisory' })),
    ];
    lines.push('');
    if (resolvedRows.length === 0) {
      // 折りたたむ項目が無い（環境ノート / AC / clearance の件数だけ）ときは件数行をそのまま出す。
      lines.push('**解消済み証跡（件数のみ）**:');
      for (const l of countLines) lines.push(l);
    } else {
      // <summary> 直後と </details> 直前の空行は GFM が details 内の table をレンダリングするために必須。
      lines.push('**解消済み証跡**:');
      lines.push('');
      lines.push(`<details><summary>${countLines.map(l => l.replace(/^- /, '')).join(' / ')}</summary>`);
      lines.push('');
      lines.push('| 区分 | 内容 | 解消根拠 |');
      lines.push('|---|---|---|');
      for (const item of resolvedRows.slice(0, RESOLVED_ROWS_MAX)) {
        let kind;
        if (item.source === 'seed' && item.dimension === 'security') kind = 'security';
        else if (item.source === 'ac') kind = 'AC';
        else kind = item._lane;
        let how;
        if (item._lane === 'advisory' && isResolved(item)) {
          how = 'fix 後 tree で確認: ' + resolvedCell(item.final_evidence);
        } else {
          how = nonEmpty(item.evidence) ? resolvedCell(item.evidence) : '—';
        }
        lines.push(`| ${kind} | ${resolvedCell(item.text)} | ${how} |`);
      }
      if (resolvedRows.length > RESOLVED_ROWS_MAX) {
        lines.push('');
        lines.push(`他 ${resolvedRows.length - RESOLVED_ROWS_MAX} 件は省略`);
      }
      lines.push('');
      lines.push('</details>');
    }
  }

  // 参考（可視化のみ — merge tier 判定に不使用）。disclosures・Final reconcile 行を
  // ここに集約する（issue #658 AC-3）。1 行もなければセクション自体を出さない。
  const referenceLines = [];
  if (Array.isArray(disclosures)) {
    for (const line of disclosures) referenceLines.push(`- ${line}`);
  }
  if (baseFailing.length > 0) {
    referenceLines.push(`- base でも失敗する既存の失敗 ${baseFailing.length} 件（diff と無関係のため green 要件から除外）: ${baseFailing.map((f) => '`' + f + '`').join(', ')}`);
  }
  if (localVerify != null) {
    referenceLines.push(`- ローカル検証 (local_verify): ${localVerifyLine(localVerify)}`);
  }
  referenceLines.push(...conflictResolvedLines(conflictAutoresolve));
  if (finalReconcile != null && finalReconcile !== 'skipped') {
    const t = finalFlaky ? FLAKY_CELL : finalTestGreen === true ? '✅ green' : finalTestGreen === false ? '❌ red' : '不明';
    referenceLines.push(`- Final reconcile (pr-iterate fix 後の最終 tree 再検証): ${finalReconcile} — final test: ${t}` + (finalAcReconcile != null ? `, final AC: ${finalAcReconcile}` : ''));
    if (finalAcReconcile === 'reverified') {
      referenceLines.push('- ✅ AC は最終 PR tree で再検証済み（Final AC reconcile — AC テーブルは final snapshot）');
    } else if (finalAcReconcile !== 'reverified' && acArr) {
      referenceLines.push('- ⚠️ AC 判定は stale（fix 適用後の最終 tree に対する AC 再検証が未実施/判定不能 — AC テーブルは Evaluate 時点（fix 前 tree）基準であり final ではない）');
    }
  }
  if (referenceLines.length > 0) {
    lines.push('');
    lines.push('**参考（可視化のみ — merge tier 判定に不使用）**:');
    for (const l of referenceLines) lines.push(l);
  }

  // 8b. lite レビュー統合セクション（issue #392 AC-6）
  // liteReview が非 null の場合のみ描画する。既存の post-review-lite が独立コメントで
  // 出していた decision / CI status / summary を dev-flow 終端サマリーへ統合する。
  // null/undefined 時は 1 行も追加せず既存出力と byte 一致を維持する（回帰保証）。
  if (liteReview != null) {
    lines.push('');
    lines.push('### lite レビュー（pr-iterate 起動なし）');
    lines.push('');
    lines.push(`- **decision**: ${liteReview.decision ?? 'n/a'}`);
    lines.push(`- **CI**: ${liteReview.ci}`);
    if (liteReview.summary != null && liteReview.summary !== '') {
      lines.push(`- **総評**: ${mdCell(liteReview.summary)}`);
    }
  }

  // 9. 末尾
  lines.push('');
  lines.push('---');
  lines.push('*このコメントは dev-flow により自動生成されました。*');
  // gate_policy は人間の判断に使わない機構側の情報なので、本文ではなく HTML コメントに残す。
  if (typeof gatePolicy === 'string' && gatePolicy.length > 0) lines.push(`<!-- gate_policy: ${gatePolicy} -->`);
  // HOLD は理由の code を marker に載せる。単体 /pr-iterate の回収で pr-iterate-prerun がこの marker を読み、
  // 終了レポートに code ごとの回収状況を出す（本文の文言は変わり得るので code を機械可読で残す）。
  const holdCodes = mergeTier === 'HOLD'
    ? ` codes=${(holdReasons || []).map((hr) => hr && hr.code).filter((c) => typeof c === 'string').join(',')}`
    : '';
  // head は結論を出した PR head。pr-iterate-prerun が今の PR head と比べ、食い違えば単体 pr-iterate が「この結論は今の head に
  // 当てはまらない」コメントを足す（head の無い marker は食い違い扱い）
  const markerHead = typeof headSha === 'string' && /^[0-9a-f]{40}$/i.test(headSha.trim()) ? ` head=${headSha.trim().toLowerCase()}` : '';
  lines.push(`<!-- dev-flow:${mergeTier}${holdCodes}${markerHead} -->`);

  return lines.join('\n');
}

// HOLD 理由 code -> {現状, 対応} の fail-safe 写像（issue #658）。merge-tier.mjs の
// HOLD_REASON_CODES を canonical とする（import 不可のため重複定義）。out-of-enum / 欠落は
// throw せず '—' / '人が確認する' に落とす（表示専用フィールドのため）。
function holdReasonDisplay(code, kind, ctx) {
  switch (code) {
    case 'escalate': {
      const { escalateTotal, escalateResolved } = ctx;
      return {
        current: `ESCALATE ${escalateTotal} 件中 ${escalateResolved} 件は fix 後 tree で解消確認済み`,
        action: escalateTotal === escalateResolved ? '不要（マージ可否の判断のみ）' : `要判断 ${escalateTotal - escalateResolved} 件（下表 ⚠️ 行）`,
      };
    }
    case 'ledger_unconverged':
      return { current: `未 checked blocking ${ctx.uncheckedBlockingCount} 件`, action: '修正が必要（下表 ❌ 行）' };
    case 'ac_agent_unsatisfied':
      return { current: 'エージェントで満たせる AC が差し戻し後も未達（ループの取りこぼし）', action: '修正が必要（下表 ❌ 未達 行）' };
    case 'ac_human_pending': {
      const obs = Array.isArray(ctx.observationalAcGaps) ? ctx.observationalAcGaps : [];
      const unreachable = Array.isArray(ctx.unreachableAcGaps) ? ctx.unreachableAcGaps : [];
      if (obs.length === 0 && unreachable.length === 0) return { current: '人手作業を要する AC が未達（人手 AC 待ち）', action: '人手で実施して AC を確認する（下表 ❌ 未達 行）' };
      const others = (Array.isArray(ctx.humanAcGaps) ? ctx.humanAcGaps : []).filter((k) => !obs.includes(k) && !unreachable.includes(k));
      const acList = (ks) => ks.map((k) => `AC#${k + 1}`).join(', ');
      const current = [
        ...(others.length > 0 ? ['人手作業を要する AC が未達（人手 AC 待ち）'] : []),
        ...(unreachable.length > 0 ? [`AC（${acList(unreachable)}）は実行環境に届かず run 内で確かめられない`] : []),
        ...(obs.length > 0 ? [`観測型 AC（${acList(obs)}）は実行しないと確かめられず、test の red→green 実証が無い`] : []),
      ];
      const actions = [
        ...(others.length > 0 ? ['人手で実施して AC を確認する'] : []),
        ...(unreachable.length > 0 ? [UNREACHABLE_ENV_AC_ACTION] : []),
        ...(obs.length > 0 ? [OBSERVATIONAL_AC_ACTION] : []),
      ];
      return { current: current.join('・'), action: `${actions.join('・')}（下表 ❌ 未達 行）` };
    }
    case 'ac_ci_pending': {
      const v = ctx.ciVerify;
      const checks = Array.isArray(v?.checks) && v.checks.length ? v.checks.map((c) => `\`${c}\``).join(', ') : 'CI の check';
      const current = v?.status === 'pending' ? `CI の ${checks} が待機上限${Number.isFinite(v.waited_seconds) ? `（${v.waited_seconds}s 待機）` : ''}までに完了しない`
        : v?.status === 'failed' ? `CI の ${checks} が failure（pr-iterate の fix 後も green にならない）`
          : v?.status === 'error' ? `CI の ${checks} の状態を取得できない`
            : `CI の ${checks} の完了待ちに到達していない（pr-iterate が LGTM 前に終端）`;
      return { current, action: ciAcAction(v) };
    }
    case 'danger_unresolved':
      return { current: `security clearance 未確認 ${ctx.unclearedCount} 件`, action: '人が該当 diff を確認する' };
    case 'danger_fail_closed':
      return { current: 'danger-grep 実行不能（security 未検証）', action: 'danger-grep を手動実行して確認する' };
    case 'merge_facts_dropped':
      return { current: 'merge-tier-facts の転記欠落（danger-grep 結果を受け取れず security 未検証）', action: 'danger-grep を手動実行して確認する' };
    case 'breaking_structured':
      return { current: 'analyze が breaking_change=true と判定', action: '互換性影響と告知要否を判断する' };
    case 'final_reconcile_unavailable':
      return { current: '最終 tree のテスト状態が未確認', action: '最終 tree でテストを手動実行する' };
    case 'final_test_red':
      return { current: 'fix 後の最終 tree でテスト失敗', action: '修正が必要' };
    case 'validate_test_red':
      return { current: 'Validate のテスト失敗が残ったまま PR へ進行（pr-iterate の fix 0 件で最終 tree の再検証なし）', action: '修正が必要（落ちたテストを直して push する）' };
    case 'validate_tests_not_run':
      return { current: 'テストが 1 件も実行されていない（ローカルは起動失敗）', action: 'テストを手元で実行するか、CI の test 結果を確認する' };
    case 'final_ac_unavailable':
      return { current: '最終 tree の AC 再検証結果を取得できず', action: 'AC を手動で再確認する' };
    case 'iterate_non_lgtm':
      return { current: `pr-iterate status=${ctx.iterateStatus ?? 'null'}`, action: `未解消指摘を修正する（\`/pr-iterate ${ctx.pr}\` 単体起動で回収可）` };
    case 'hash_mismatch':
      return { current: '評価済み tree と PR tree が乖離', action: '差分を確認し必要なら再評価する' };
    case 'testsurf_uncleared':
      return { current: 'test-weakening 未クリア', action: '該当テスト変更の正当性を確認する' };
    case 'mergeable_conflicting':
      return { current: `base branch と conflict${conflictStoppedNote(ctx.conflictAutoresolve)}`, action: 'conflict を解消して push する' };
    case 'pr_closes_missing':
      return {
        current: 'PR body に Closes 行が無い（merge しても issue が自動 close されない）',
        action: `\`gh pr edit ${ctx.pr} --body-file <本文ファイル>\` で Closes 行を含む本文を再投入する`,
      };
    case 'ci_checks_failed':
      return {
        current: 'PR head の CI checks が失敗（fail / cancel）',
        action: `\`gh pr checks ${ctx.pr}\` で失敗した check を確認し、修正して push する`,
      };
    case 'security_review_unresolved': {
      const s = ctx.securityReview;
      // review 前に指示ファイルの変更で止めた run（issue #1082）は指摘があったのではないので「clear にならない」と書かない。
      // 確認コマンドは固定で PR 番号だけを差し込む（変わったファイル名・branch 名など PR が決めた文字列を載せない）。
      // 隔離 review（issue #1083）の結果は gate に戻さない — gate が読む記録には、同じ場所に書ける fix agent が clear を偽造できる
      if (s && s.target === true && s.stop_reason === 'reviewer_context_changed') {
        return {
          current: `指示ファイルを変える PR なので自動 review をしていない（review ${Number.isFinite(s.rounds) ? s.rounds : 0} 回）`,
          action: `\`gh pr diff ${ctx.pr} --name-only \\| grep -iE '(^\\|/)(claude(\\.local)?\\|agents)\\.md$\\|^\\.claude/'\` で変わった指示ファイルを一覧し、人が中身と diff を確認する（\`@\` import 先も確かめる）。`
            + `Anthropic API に通信できるシェル（plugin の bin/ が PATH に載る Claude Code のセッション等）で \`security-review-isolated ${ctx.pr}\` を実行すると、PR の worktree に入らない別プロセスで security review を回せる（結果は gate に戻らない — merge 判断の材料）`,
        };
      }
      const counts = s && s.status !== 'not_run' && Number.isFinite(s.rounds)
        ? `（敵対的 review ${s.rounds} 回・最終 critical ${s.critical ?? 0} / major ${s.major ?? 0}）`
        : '（LGTM の前の review に到達していない）';
      const deferred = s && s.deferred > 0 ? `— security の指摘 ${s.deferred} 件を fix が直さずに人の判断に返した` : '';
      return {
        current: `security review が今の PR head で clear になっていない${counts}${deferred}`,
        action: `\`/pr-iterate ${ctx.pr}\` で回収するか、人が diff を確認する（指摘の本文は公開コメントに載せない）`,
      };
    }
    default:
      return { current: '—', action: '人が確認する' };
  }
}
