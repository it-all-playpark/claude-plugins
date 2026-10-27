// buildTerminalSummaryBody: pr-iterate の終端サマリー markdown を生成する純粋関数。
// I/O なし、gh なし、Date.now() 非決定性なし。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。

const DECISION_LABEL = {
  'approve': '承認 (LGTM)',
  'request-changes': '変更要求',
  'comment': 'コメント',
};

const SEV_LABEL = { 'critical': '🔴 critical', 'major': '🟠 major', 'minor': '🟡 minor' };

/**
 * finding 配列を番号付き箇条書き markdown 行配列へ変換する。
 * 1 finding = 見出し行（severity + 場所）+ `指摘` 行 + （suggestion があれば）`提案` 行。
 * @param {Array} list - finding 配列（severity, file, line, description, suggestion, 任意で iter）
 * @param {object} [opts]
 * @param {boolean} [opts.withIter] - true の場合、見出し行末尾に `（反復 N 回目）` を付与する
 * @returns {string[]}
 */
function formatFindingsList(list, { withIter = false } = {}) {
  const out = [];
  let idx = 1;
  for (const f of list) {
    const sev = SEV_LABEL[f.severity] ?? f.severity;
    const loc = f.file != null
      ? (f.line != null ? `\`${f.file}:${f.line}\`` : `\`${f.file}\``)
      : '場所指定なし';
    const iterSuffix = withIter ? `（反復 ${f.iter} 回目）` : '';
    out.push(`${idx}. ${sev} — ${loc}${iterSuffix}`);
    out.push(`   - 指摘: ${mdCell(f.description)}`);
    if (f.suggestion != null) {
      out.push(`   - 提案: ${mdCell(f.suggestion)}`);
    }
    idx++;
  }
  return out;
}

const STATUS_HEADLINE = {
  'lgtm': '🎉 LGTM',
  'stuck': '⚠️ STUCK — 人間レビューへエスカレーション',
  'fix_failed': '⚠️ 自動修正失敗 — 人間へエスカレーション',
  'max_reached': '⚠️ 反復上限到達',
  'ci_error': '⚠️ CI エラー — CI ステータスを確定できなかった（proxy が結果を返さなかった）。`gh pr checks <PR>` で実状態を確認すること。人間へエスカレーション',
  'ci_pending': '⏳ CI 未完了 — checks pending。人間/CI 完了待ちへエスカレーション',
  'review_contract_error': '⚠️ REVIEW CONTRACT ERROR — reviewer の decision/blocking 矛盾の再発、または reviewer が StructuredOutput 契約違反で結果を返さず。人間へエスカレーション',
  'security_unresolved': '🛡️ SECURITY REVIEW 未完了 — 敵対的 security review が今の head で clear にならなかった。人間へエスカレーション',
};

// securityGate が PR は security-reviewer に読み込まれる指示ファイルを変えるとして review 前に止めた run の見出し（issue #1082）。
// 止めたのはゲートが正しく働いた結果で、指摘があったのではない — 「clear にならなかった」と読ませない
const SECURITY_CONTEXT_CHANGED_HEADLINE = '🛡️ SECURITY REVIEW 未実施 — 指示ファイルを変える PR なので自動 review をしていない（review <ROUNDS> 回）。変わった指示ファイルを人が確認する';

// /pr-iterate --direction で人の修正方針を fix に渡した run の 1 行。方針の本文は載せない（公開の PR コメントに出す前提で書かれていない）
const FIX_DIRECTION_LINE = '**修正方針**: /pr-iterate を起動した人が決めた修正方針（`--direction`）を fix に渡して回した（本文はこのコメントに載せない）';

const isSecurityContextChanged = (sr) => sr != null && sr.target === true && sr.stop_reason === 'reviewer_context_changed';

// reviewer_context_changed の run で人が回す隔離 review の案内（issue #1083）。差し込むのは PR 番号だけ（PR が決めた文字列を載せない）。
// 結果は gate に戻さない — 記録ファイルや PR コメントを gate が読めば、同じ場所に書ける fix agent が clear を偽造できる
const securityIsolatedReviewLine = (pr) => `**隔離した security review**: Anthropic API に通信できるシェル（plugin の bin/ が PATH に載る Claude Code のセッション等）で \`security-review-isolated ${pr}\` を実行すると、PR の worktree に入らない別プロセスで security-reviewer が PR の diff を review し、判定・件数・指摘を端末に出す。結果は gate に戻らない（Merge tier は HOLD のまま）— merge 判断の材料にする`;

/**
 * 敵対的 security review の結果行（issue #1063）。公開の PR コメントに載るので、指摘の本文（攻撃経路）は載せず件数だけを出す。
 * 変わった指示ファイルのパスも PR が決めた文字列なので載せない（stop_reason の固定 code で出し分けるだけ）。
 * deferred（fix が直さずに人の判断に返した security の指摘の件数）が 1 以上なら、その件数を出す（topic は載せない）。
 * @param {{target: boolean, status: string, stop_reason?: string|null, rounds: number, critical?: number, major?: number, minor?: number, deferred?: number}} sr
 *   status: 'cleared' | 'unresolved' | 'not_run' | 'not_target'
 * @returns {string}
 */
function formatSecurityReviewLine(sr) {
  if (sr.target !== true) return '**Security review**: 対象外（変更が許可リスト — 指示ファイルでない文書・テスト — だけ）';
  if (isSecurityContextChanged(sr)) {
    return `**Security review**: ⏸️ 自動 review をしていない（指示ファイルを変える PR — security-reviewer に読み込まれる CLAUDE.md / AGENTS.md / repo 直下の .claude/ 等を変えるので自動の review では clear にしない・review ${sr.rounds ?? 0} 回）— merge 前に人が変わった指示ファイルと diff を確認する`;
  }
  const counts = `敵対的 review ${sr.rounds ?? 0} 回・最終 critical ${sr.critical ?? 0} / major ${sr.major ?? 0} / minor ${sr.minor ?? 0}`;
  if (sr.status === 'cleared') return `**Security review**: ✅ clear（${counts}）`;
  const deferred = sr.deferred > 0 ? `security の指摘 ${sr.deferred} 件を fix が直さずに人の判断に返した。` : '';
  return `**Security review**: ❌ 未完了（${sr.status === 'not_run' ? 'LGTM の前の review に到達していない' : counts}）— ${deferred}指摘の本文は公開コメントに載せない。merge 前に人が diff を確認する`;
}

// 最終 CI 状態行のラベル。null（未観測）は「CI を判定していない」ことを明示する —
// stuck / fix_failed 終端で CI が赤のまま気づかれない事故を、終端サマリで必ず可視化するため
// 全終端で出す（CI を見ていない run と green の run を読み手が区別できるようにする）。
const CI_LAST_STATUS_LABEL = {
  'passed': '✅ passed',
  'failed': '🔴 failed',
  'pending': '⏳ pending（未完了）',
  'no_checks': 'no_checks（CI 未設定）',
  'error': '⚠️ error（ステータス取得失敗 — `gh pr checks <PR>` で実状態を確認すること）',
};

/**
 * 最終 CI 状態行を組み立てる。
 * @param {string|null} ciLastStatus - 'passed' | 'failed' | 'pending' | 'no_checks' | 'error' | null（未観測）
 * @param {string[]} ciLastFailedChecks - failed のとき列挙する check 名
 * @param {number|string} pr - PR 番号（error ラベルの <PR> 置換用）
 * @returns {string}
 */
function formatCiLastStatusLine(ciLastStatus, ciLastFailedChecks, pr) {
  if (ciLastStatus == null) return '**最終 CI 状態**: 未観測（この run では CI を判定していない — `gh pr checks <PR>` で確認すること）'.replace('<PR>', String(pr));
  const label = (CI_LAST_STATUS_LABEL[ciLastStatus] ?? ciLastStatus).replace('<PR>', String(pr));
  if (ciLastStatus === 'failed') {
    const names = (ciLastFailedChecks || []).map((n) => `\`${mdCell(n)}\``);
    return `**最終 CI 状態**: ${label} — ${names.length ? names.join(', ') : '（check 名不明）'}`;
  }
  return `**最終 CI 状態**: ${label}`;
}

/**
 * base との conflict の自動解消の試行を 1 試行 1 行の箇条書きにする（試行が無ければ空配列）。
 * 自動解消した試行は型とファイル、しなかった試行は止めたファイル（型 A / B 以外）とその型を出す。
 * @param {Array<{iteration:number, status:string, reason?:string, files?:Array<{path:string,type:string}>, merge_sha?:string|null}>} list
 * @returns {string[]}
 */
function formatConflictAutoresolveLines(list) {
  const fileCell = (f) => `\`${mdCell(f.path)}\`（${f.type === 'A' || f.type === 'B' ? `型 ${f.type}` : mdCell(f.type)}）`;
  return (list || []).filter((r) => r != null).map((r) => {
    const files = Array.isArray(r.files) ? r.files : [];
    if (r.status === 'resolved') {
      const sha = r.merge_sha ? `merge commit \`${String(r.merge_sha).slice(0, 7)}\` を push — ` : '';
      return `- 反復 ${r.iteration}: ✅ 自動解消した（${sha}${files.map(fileCell).join(' / ') || '—'}）`;
    }
    const stopped = files.filter((f) => f.type !== 'A' && f.type !== 'B');
    const shown = stopped.length > 0 ? stopped : files;
    const reason = r.reason ? `${mdCell(r.reason)}` : mdCell(r.status);
    return `- 反復 ${r.iteration}: ⚠️ 自動解消しなかった（${reason}${shown.length ? ` — 止めたファイル: ${shown.map(fileCell).join(' / ')}` : ''}）`;
  });
}

const PRIOR_HOLD_UNRESOLVED = '未解消（pr-iterate は再判定しない — 人が確認する）';
// 人の判断待ちの code。pr-iterate に判定する材料が無いので、どこを見るかだけを示す
const PRIOR_HOLD_HUMAN_CODES = ['escalate', 'ac_human_pending'];
const PRIOR_HOLD_HUMAN = '未解消（人の判断が要る — pr-iterate は判定しない。dev-flow のサマリーの該当項目を確認する）';
// final_test_red は HOLD を外さない。テストは PR（fix を含む）が書き換えられるので、全件 green・CI passed・テスト関連の変更なしの
// どれも解消の根拠にならない。PR が操作できない事実（git の diff・pipeline が実行した run-tests の結果）で人の確認範囲を絞るだけ
const PRIOR_HOLD_FINAL_TEST = '未解消（HOLD は外さない — 下の事実で確認範囲を絞って人が確認する）';

const shortShaCell = (s) => `\`${String(s).slice(0, 7)}\``;
// 人がコピーしてシェルに貼るコマンドには、シェルでも Markdown でも特別な意味を持たない文字だけのパスを入れる。
// PR が名付けたパスを引用して埋めると、Markdown の code span の区切り（backtick）や escape で引用が崩れ、貼った端末でコマンドが走る
const isPlainPath = (p) => /^[A-Za-z0-9_.@+\/-]+$/.test(p);
// backtick を含む名前は code span に入れない（code span を途中で閉じる）。外に出す名前は backtick を escape する
const pathCell = (p) => (p.includes('`') ? mdCell(p).replace(/`/g, '\\`') : `\`${mdCell(p)}\``);

function finalTestRunLabel(t) {
  if (t != null && t.tests === 'passed' && t.green === true) return 'passed';
  if (t != null && t.tests === 'failed') {
    const files = Array.isArray(t.failed_files) ? t.failed_files.filter((f) => typeof f === 'string' && f !== '') : [];
    return `failed — 失敗ファイル: ${files.length ? files.map(pathCell).join(' / ') : '不明（ファイルに結び付かない失敗）'}`;
  }
  if (t != null && t.tests === 'no_tests') return 'no_tests（実行対象のテストが無い）';
  return '実行できなかった';
}

/**
 * final_test_red の行の下に出す事実（決定論で取ったものだけ。LLM の要約・判断は載せない）。
 * @param {{ran: false, reason: 'same_head'|'hold_head_unknown'|'end_head_unknown', holdHead?: string}
 *   |{ran: true, holdHead: string, endHead: string, changes: {status: 'none'|'changed'|'unknown', files: string[]}, tests: object|null}|null} check
 * @returns {string[]}
 */
function finalTestRedFacts(check) {
  if (check == null) return [];
  if (check.ran !== true) {
    const reason = check.reason === 'same_head'
      ? `HOLD 時と同じ head（${shortShaCell(check.holdHead)}）で終わった — HOLD 時のテスト結果がそのまま当てはまる`
      : (check.reason === 'hold_head_unknown' ? 'HOLD 時の head 不明（dev-flow のサマリーの marker に head が無い）' : '終端 head 不明');
    return [`変更ファイルと最終 tree の全件テストは取っていない: ${reason}`];
  }
  const facts = [`HOLD 時の head ${shortShaCell(check.holdHead)} → 終端 head ${shortShaCell(check.endHead)}`];
  const changes = check.changes ?? { status: 'unknown', files: [] };
  if (changes.status === 'none') {
    facts.push('テスト関連の変更（テストとテストの実行を変えうる設定）: なし');
  } else if (changes.status === 'changed') {
    facts.push(`テスト関連の変更（テストとテストの実行を変えうる設定）: あり ${changes.files.length} 件 — ${changes.files.map(pathCell).join(' / ')}`);
    facts.push(changes.files.every(isPlainPath)
      ? `その diff: \`git diff ${check.holdHead}..${check.endHead} -- ${changes.files.join(' ')}\``
      : 'その diff: シェルに貼れないファイル名を含むのでコマンドは出さない — PR 全体の diff を確認する');
  } else {
    facts.push('テスト関連の変更（テストとテストの実行を変えうる設定）: 不明（変更ファイル一覧を取れなかったか、HOLD 時の head が終端 head の祖先でない — PR 全体の diff を確認する）');
  }
  facts.push(`最終 tree の全件テスト（run-tests 1 回）: ${finalTestRunLabel(check.tests)}`);
  return facts;
}

/**
 * 直前の dev-flow サマリーが HOLD のとき、HOLD 理由の code ごとの回収状況を決定論で 1 行ずつ出す（issue #930）。
 * pr-iterate が自分で確かめられるのは review の LGTM・最終 CI・conflict の自動解消・敵対的 security review だけで、
 * AC・ledger・danger-grep の security clearance・最終 tree のテストは再判定しない — それらの code は常に未解消として人に返す。
 * 未解消の文言は人の判断待ち（escalate / ac_human_pending）・final_test_red・それ以外で分ける。final_test_red は
 * finalTestCheck の事実を行の下に出す（resolved は常に false）。
 * code が 1 件も無い HOLD（code を marker に載せる前のサマリー）は理由を確かめられないので未解消 1 件にする。
 * @returns {{rows: Array<{code: string|null, resolved: boolean, detail: string|null, unresolvedLabel?: string, facts?: string[]}>, unresolved: number}}
 */
function priorHoldRecovery(codes, { status, ciLastStatus, conflictAutoresolve, securityReview, finalTestCheck }) {
  const attempts = (conflictAutoresolve || []).filter((r) => r != null);
  const lastConflict = attempts.length > 0 ? attempts[attempts.length - 1].status : null;
  const rows = (codes || []).map((code) => {
    if (code === 'iterate_non_lgtm') return { code, resolved: status === 'lgtm', detail: `この run の終了状態: ${status}` };
    // 敵対的 security review はこの run が今の head で判定し直す（対象外か、対象で clear なら終端 status に依らず解消）。
    // cleared は head を変えうる操作の前に securityHeadMayChange() が null に戻すので、cleared のまま返るのは今の head の結果だけ
    if (code === 'security_review_unresolved') {
      const sr = securityReview?.status ?? '未実施';
      return { code, resolved: sr === 'cleared' || sr === 'not_target', detail: `この run の security review: ${sr}` };
    }
    if (code === 'ci_checks_failed' || code === 'ac_ci_pending') {
      return { code, resolved: ciLastStatus === 'passed', detail: `最終 CI 状態: ${ciLastStatus ?? '未観測'}` };
    }
    if (code === 'mergeable_conflicting') {
      return { code, resolved: lastConflict === 'resolved', detail: `conflict の自動解消: ${lastConflict ?? '試行なし'}` };
    }
    if (PRIOR_HOLD_HUMAN_CODES.includes(code)) return { code, resolved: false, detail: null, unresolvedLabel: PRIOR_HOLD_HUMAN };
    if (code === 'final_test_red') {
      return { code, resolved: false, detail: null, unresolvedLabel: PRIOR_HOLD_FINAL_TEST, facts: finalTestRedFacts(finalTestCheck) };
    }
    return { code, resolved: false, detail: null };
  });
  if (rows.length === 0) rows.push({ code: null, resolved: false, detail: 'HOLD 理由の code がサマリーに無い — 元のサマリーで理由を確認する' });
  return { rows, unresolved: rows.filter((r) => !r.resolved).length };
}

/**
 * 終端サマリー markdown を生成する。
 * @param {object} opts
 * @param {number|string} opts.pr - PR 番号
 * @param {string} opts.status - 'lgtm' | 'stuck' | 'fix_failed' | 'max_reached' | 'ci_error' | 'ci_pending' | 'review_contract_error' | 'security_unresolved'
 * @param {number} opts.iterations - 総反復回数
 * @param {string} opts.lastDecision - 最終判定
 * @param {string} opts.lastSummary - 最終サマリーテキスト
 * @param {string[]} [opts.lastVerificationEvidence] - 最終検証根拠リスト（任意）
 * @param {Array} opts.history - ラウンド履歴 [{iteration, decision, summary, blocking, minor}]
 * @param {number} [opts.ciWaitSeconds] - CI pending 待機の累積秒数（任意。pr-iterate.js の script 側 ci-wait ループの積算）
 * @param {number} [opts.ciPollAttempts] - CI ステータス取得の累積ポーリング回数（任意）
 * @param {string|null} [opts.ciLastStatus] - 最後に観測した CI 状態 'passed' | 'failed' | 'pending' | 'no_checks' | 'error' | null（未観測）
 * @param {string[]} [opts.ciLastFailedChecks] - ciLastStatus が failed のとき列挙する check 名
 * @param {Array} [opts.humanFollowups] - worktree の外を指すとして fix から外した blocking finding（severity, file, line, description, suggestion, iter）
 * @param {Array} [opts.conflictAutoresolve] - base との conflict の自動解消の試行（_lib/conflict-autoresolve.mjs の conflictAutoresolveRecord の配列）
 * @param {{tier: string, codes: string[], url: string|null, head_sha: string|null}|null} [opts.priorDevflow] - 単体起動の前に PR に載っていた
 *   dev-flow サマリー（pr-iterate-prerun の prior_devflow）。tier が HOLD のときだけ HOLD 理由の回収状況を出す
 * @param {object|null} [opts.finalTestCheck] - final_test_red の確認範囲の事実（形は finalTestRedFacts）。HOLD の codes に
 *   final_test_red がある単体起動で pr-iterate が渡す。回収状況の final_test_red 行の下に出すだけで、解消にはしない
 * @param {{target: boolean, status: string, stop_reason?: string|null, rounds: number, critical?: number, major?: number, minor?: number, deferred?: number}|null} [opts.securityReview] -
 *   敵対的 security review の結果（pr-iterate の返り値 security_review）。件数だけを 1 行出す（null なら出さない）。
 *   stop_reason が 'reviewer_context_changed' なら見出しと行を「自動 review をしていない」に出し分け、`security-review-isolated <PR>` の実行案内を足す
 * @param {string|null} [opts.headSha] - この結論を出した PR head の commit sha。40 桁 hex のときだけ末尾 marker に `head=<sha>` で載せる
 * @param {boolean} [opts.fixDirectionUsed] - /pr-iterate を起動した人の修正方針（args.fix_direction）を fix に渡した run か。
 *   true なら渡したことだけを 1 行出す（方針の本文は受け取らない — 公開の PR コメントに載せない）
 * @returns {string}
 */
export function buildTerminalSummaryBody({ pr, status, iterations, lastDecision, lastSummary, lastVerificationEvidence, history, ciWaitSeconds, ciPollAttempts, ciLastStatus = null, ciLastFailedChecks = [], humanFollowups = [], conflictAutoresolve = [], priorDevflow = null, finalTestCheck = null, securityReview = null, headSha = null, fixDirectionUsed = false }) {
  const DECISION_EMOJI = { 'approve': '✅', 'request-changes': '🔴', 'comment': '💬' };
  const lines = [];
  const priorHold = priorDevflow != null && priorDevflow.tier === 'HOLD'
    ? priorHoldRecovery(priorDevflow.codes, { status, ciLastStatus, conflictAutoresolve, securityReview, finalTestCheck })
    : null;

  // dev-flow の HOLD 後の回収では、このレポートが PR の最後のコメント（最新の結論）になる。HOLD 理由が残っているのに
  // 「🎉 LGTM」を見出しにすると merge 可能に読めるので、見出しを回収状況に合わせる。
  let headline = (STATUS_HEADLINE[status] ?? status).replace('<PR>', String(pr));
  if (status === 'security_unresolved' && isSecurityContextChanged(securityReview)) {
    headline = SECURITY_CONTEXT_CHANGED_HEADLINE.replace('<ROUNDS>', String(securityReview.rounds ?? 0));
  }
  if (priorHold && status === 'lgtm') {
    headline = priorHold.unresolved > 0
      ? `LGTM（review）— dev-flow の HOLD 理由 ${priorHold.unresolved} 件が未解消。merge 前に確認`
      : `${headline} — dev-flow の HOLD 理由はすべて解消`;
  }

  lines.push(`## PR #${pr} — pr-iterate 終了レポート`);
  lines.push('');
  if (priorHold) {
    lines.push(`> dev-flow のサマリー（HOLD）: ${priorDevflow.url ?? '（URL 不明）'} — 下の「dev-flow の HOLD 理由の回収状況」がその後の結論`);
    lines.push('');
  }
  lines.push(`### ${headline}`);
  lines.push('');

  lines.push('| 終了状態 | 反復回数 | 最終判定 |');
  lines.push('|---|---|---|');
  const decEmoji = DECISION_EMOJI[lastDecision] ?? '';
  const decLabel = DECISION_LABEL[lastDecision] ?? lastDecision ?? '—';
  lines.push(`| ${status} | ${iterations} | ${decEmoji} ${decLabel} |`);

  lines.push('');
  lines.push(`**最終判定理由**: ${lastSummary}`);

  // 全終端で必ず出す（lgtm / stuck / fix_failed / max_reached / ci_error / ci_pending / review_contract_error）
  lines.push('');
  lines.push(formatCiLastStatusLine(ciLastStatus, ciLastFailedChecks, pr));

  if (securityReview != null) {
    lines.push('');
    lines.push(formatSecurityReviewLine(securityReview));
    if (isSecurityContextChanged(securityReview)) {
      lines.push('');
      lines.push(securityIsolatedReviewLine(Number(pr)));
    }
  }

  if (fixDirectionUsed === true) {
    lines.push('');
    lines.push(FIX_DIRECTION_LINE);
  }

  if (priorHold) {
    lines.push('');
    lines.push('### dev-flow の HOLD 理由の回収状況');
    lines.push('');
    for (const r of priorHold.rows) {
      const label = r.resolved ? '✅ 解消' : `❌ ${r.unresolvedLabel ?? PRIOR_HOLD_UNRESOLVED}`;
      const parts = [r.code != null ? `\`${mdCell(r.code)}\`` : null, label, r.detail].filter((p) => p != null);
      lines.push(`- ${parts.join(' — ')}`);
      for (const fact of r.facts ?? []) lines.push(`  - ${fact}`);
    }
    lines.push('');
    lines.push(priorHold.unresolved > 0
      ? `**dev-flow の HOLD 理由 ${priorHold.unresolved} 件が未解消** — merge 前に人が確認する`
      : '**dev-flow の HOLD 理由はすべて解消**');
  }

  if (ciWaitSeconds != null || ciPollAttempts != null) {
    lines.push('');
    lines.push(`**CI 待機**: ${ciWaitSeconds ?? 0}秒（ポーリング ${ciPollAttempts ?? 0} 回）`);
  }

  const evList2 = lastVerificationEvidence || [];
  if (evList2.length > 0) {
    lines.push('');
    lines.push('**検証根拠**:');
    for (const e of evList2) lines.push(`- ${mdCell(e)}`);
  }

  const histList = history || [];
  if (histList.length > 0) {
    lines.push('');
    lines.push('### 反復履歴');
    lines.push('');
    lines.push('| 反復 | 判定 | 要修正 (blocking) | 軽微 (minor) | 総評 |');
    lines.push('|---|---|---|---|---|');
    for (const round of histList) {
      const rEmoji = DECISION_EMOJI[round.decision] ?? '';
      const rLabel = DECISION_LABEL[round.decision] ?? round.decision;
      const bCount = (round.blocking ?? []).length;
      const mCount = (round.minor ?? []).length;
      const rawSummary = mdCell(round.summary);
      const rSummary = rawSummary.length > 120 ? rawSummary.slice(0, 120) + '…' : rawSummary;
      lines.push(`| ${round.iteration} | ${rEmoji} ${rLabel} | ${bCount} | ${mCount} | ${rSummary} |`);
    }
  }

  const allBlocking = histList.flatMap((r) => (r.blocking ?? []).map((f) => ({ iter: r.iteration, ...f })));
  const totalBlocking = allBlocking.length;
  if (totalBlocking > 0) {
    lines.push('');
    lines.push(`<details><summary>要修正（blocking）指摘の全詳細（${totalBlocking} 件）</summary>`);
    lines.push('');
    lines.push(...formatFindingsList(allBlocking, { withIter: true }));
    lines.push('');
    lines.push('</details>');
  }

  // 人間側 follow-up: worktree の外を指すとして fix から外した blocking 指摘（issue #793）。自動修正しないので
  // 折りたたまずに出す。空なら 1 行も足さない。
  const followups = (humanFollowups || []).filter((f) => f != null);
  if (followups.length > 0) {
    lines.push('');
    lines.push(`### 👤 人間側 follow-up（worktree の外を指す指摘 — 自動修正の対象外・${followups.length} 件）`);
    lines.push('');
    lines.push(...formatFindingsList(followups, { withIter: followups.every((f) => f.iter != null) }));
  }

  // base との conflict の自動解消（issue #916）。試行が無ければ 1 行も足さない。
  const conflictLines = formatConflictAutoresolveLines(conflictAutoresolve);
  if (conflictLines.length > 0) {
    lines.push('');
    lines.push('### 🔀 base との conflict の自動解消');
    lines.push('');
    lines.push(...conflictLines);
  }

  const allMinor = histList.flatMap((r) => (r.minor ?? []).map((f) => ({ iter: r.iteration, ...f })));
  const totalMinor = allMinor.length;
  if (totalMinor > 0) {
    lines.push('');
    lines.push(`<details><summary>軽微な指摘（minor）の全詳細（自動修正対象外・${totalMinor} 件）</summary>`);
    lines.push('');
    lines.push(...formatFindingsList(allMinor, { withIter: true }));
    lines.push('');
    lines.push('</details>');
  }

  lines.push('');
  lines.push('---');
  lines.push('*このコメントは pr-iterate により自動生成されました。*');
  // head は pr-iterate-prerun が「この結論が今の PR head に当てはまるか」を比べる材料（head の無い marker は食い違い扱い）
  lines.push(`<!-- pr-iterate:${status}:${iterations}${markerHead(headSha)} -->`);

  return lines.join('\n');
}

const TERMINAL_HEAD_SHA_RE = /^[0-9a-f]{40}$/i;

function markerHead(headSha) {
  return typeof headSha === 'string' && TERMINAL_HEAD_SHA_RE.test(headSha.trim()) ? ` head=${headSha.trim().toLowerCase()}` : '';
}

/**
 * 単体 pr-iterate が review を始める前に投稿する「再 review 中」コメントの本文（issue #1065）。
 * PR の最後の終端サマリーが今の head と別の head に対する結論のとき、そのサマリーを見て merge されないよう、
 * 古いサマリーは編集・削除せず（PR 上の証跡を残す）このコメントを足して、古い結論が今の head に当てはまらないことを示す。
 * @param {object} opts
 * @param {number|string} opts.pr - PR 番号
 * @param {string} opts.headSha - 今の PR head の commit sha
 * @param {{source: string, url: string|null, head_sha: string|null}} opts.priorSummary - pr-iterate-prerun の prior_summary
 * @returns {string}
 */
export function buildRereviewNoticeBody({ pr, headSha, priorSummary }) {
  const url = priorSummary.url ?? '（URL 不明）';
  const priorHead = priorSummary.head_sha ? `head \`${priorSummary.head_sha}\` に対する結論` : 'head の記録が無い結論';
  return [
    `## PR #${pr} — pr-iterate 再 review 中`,
    '',
    `head \`${headSha}\` で再 review 中。${url} の結論（${mdCell(priorSummary.source)} の終端サマリー・${priorHead}）はこの head に当てはまらない。`,
    '',
    'この head に対する結論は、この後に載る pr-iterate の終了レポート。それまで古いサマリーを根拠に merge しない。',
    '',
    '---',
    '*このコメントは pr-iterate により自動生成されました。*',
  ].join('\n');
}
