// dev-flow micro lite 経路の escalation 判定を行う canonical。issue #376。
//
// INLINE COPY POLICY: workflow から参照される最上位宣言だけが tools/sync-inlines.mjs --write で inline 生成される。
// 直接 workflow 側を編集しない。一致は _lib/workflow-inlines.sync.test.mjs が検証する。

/**
 * lite pr-reviewer pass の review 結果から、full pr-iterate（fix loop）への
 * escalation 要否を判定する純粋関数。
 *
 * escalate 条件は `review == null || blocking.length > 0` に限定する。
 * review.decision には一切依存しない（comment / request-changes でも blocking が
 * 空なら escalate=false）。これは `_lib/review-normalize.mjs` の
 * classifyReviewRoute（blocking 空を decision 非依存で CI_GATE=続行扱いにする）との
 * parity を意味する。blocking フィルタ述語（severity === 'critical' || 'major'）は
 * classifyReviewRoute と同一だが、sync-inlines generator が canonical 内の
 * import/require/Date.now/Math.random を検出して error にするため、review-normalize
 * を import せず本ファイルに inline 再実装する。
 *
 * 真理値表:
 *   | review                                             | escalate | 備考 |
 *   |-----------------------------------------------------|----------|------|
 *   | null / undefined                                     | true     | safety fail（agent skip/drop 相当） |
 *   | { decision: 'approve', issues: undefined }           | false    | Array.isArray ガードで issues を [] 扱い |
 *   | { decision: 'comment', issues: [] }                  | false    | blocking 0 |
 *   | { decision: 'request-changes', issues: [minor] }     | false    | minor のみは blocking 対象外 |
 *   | { decision: 'comment', issues: [major] }             | true     | decision 非依存で blocking>0 は escalate |
 *   | { decision: 'approve', issues: [critical] }          | true     | contract mismatch も blocking>0 で escalate |
 *
 * @param {{ decision?: string, issues?: Array<{ severity: string }> } | null | undefined} review
 * @returns {{ escalate: boolean, blocking: Array<{ severity: string }>, minor: Array<{ severity: string }> }}
 */
export function classifyLiteReview(review) {
  const issues = Array.isArray(review?.issues) ? review.issues : [];
  const blocking = issues.filter((x) => x.severity === 'critical' || x.severity === 'major');
  const minor = issues.filter((x) => x.severity === 'minor');
  const escalate = review == null || blocking.length > 0;

  return { escalate, blocking, minor };
}
