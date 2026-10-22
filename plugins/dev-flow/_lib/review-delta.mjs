// review-delta: pr-iterate の review#i（i ≥ 2）を fix delta（前 round の head sha .. 現在 HEAD）に絞る
// ための純粋関数群。I/O なし、gh なし、Date.now() 非決定性なし。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証する。
//
// なぜ必要か: review#i（i ≥ 2）が毎 round 全 PR diff を cold で読み直すと、安定したコードに
// 新しい主観的 major を捻り出す churn（moving target）が生まれる。「既出は対応済み前提で読め」
// という指示だけでは抑止が指示ベースに留まるため、delta を sha 範囲で機械的に確定し
// 「読んでいないコードには新しい major を出せない」構造にする。
//
// 不変条件:
//   - delta の範囲は sha で機械的に決める。reviewer に「必要なら全体も読め」の裁量は渡さない
//     （裁量を残すと指示ベースに戻り churn が復活する）。
//   - sha が確定できない round は **full にフォールバック**する（fail-open）。delta を空扱いにして
//     「新規なし → approve」へ倒さない。sha_prev === sha_now（fix が commit を積まなかった）も
//     同じ理由で full に倒す（空 delta を approve の根拠にしない）。
//   - delta 外の regression は CI / Final reconcile の test 再実行が担当（ゲート境界は不変）。
//   - full review が critical を返した次の round は sha が揃っていても full に戻す。critical の無い full review を
//     経るまで delta にしない（delta review は delta 外の新規指摘を出さないので、critical が 1 件出た PR の
//     残りの critical は以後どの review にも載らない。critical が 1 件出た PR は他にもある前提で扱う）。
//     判定は reviewer 出力の severity だけで行う（security かどうかの分類・LLM 判定は挟まない）。

const SHA_RE = /^[0-9a-f]{7,40}$/i;

/**
 * delta 範囲に使える sha か（7〜40 桁 hex）。exec-proxy が空文字 / エラー文を返した場合を弾く。
 * @param {unknown} s
 * @returns {boolean}
 */
export function isDeltaSha(s) {
  return typeof s === 'string' && SHA_RE.test(s.trim());
}

/**
 * review#iteration の diff 範囲を決める。
 *
 * @param {{iteration: number, shaPrev: unknown, shaNow: unknown, criticalPending?: boolean}} p
 *   shaPrev: 前 round の review 時点の head sha / shaNow: 現在の head sha（fix 後の ensure-committed が返す）
 *   criticalPending: full review が critical を返し、まだ critical の無い full review を経ていない（nextCriticalPending）
 * @returns {{scope: 'full'|'delta', range: string|null, reason: string|null}}
 *   reason は full にした理由（iteration 1 は null）。呼び出し側が log に出す。
 */
export function resolveReviewScope({ iteration, shaPrev, shaNow, criticalPending = false }) {
  if (!(Number(iteration) >= 2)) return { scope: 'full', range: null, reason: null };
  if (criticalPending === true) return { scope: 'full', range: null, reason: 'critical_in_full_review' };
  if (!isDeltaSha(shaPrev)) return { scope: 'full', range: null, reason: 'sha_prev_unavailable' };
  if (!isDeltaSha(shaNow)) return { scope: 'full', range: null, reason: 'sha_now_unavailable' };
  const prev = shaPrev.trim();
  const now = shaNow.trim();
  if (prev.toLowerCase() === now.toLowerCase()) return { scope: 'full', range: null, reason: 'sha_unchanged' };
  return { scope: 'delta', range: `${prev}..${now}`, reason: null };
}

/**
 * round の review 結果から、次 round の criticalPending を決める。full review だけが値を更新する
 * （critical を 1 件以上返せば true、返さなければ false）。delta / remerge round は読んだ範囲が PR 全体ではないので
 * 値を変えない — critical の fix を delta review が approve しただけでは pending を解かない。
 * @param {{pending: boolean, scope: string, blocking: unknown}} p
 *   blocking: その round で fix の対象にした critical/major（classifyReviewRoute → routeInsideWorktree の後）
 * @returns {boolean}
 */
export function nextCriticalPending({ pending, scope, blocking }) {
  if (scope !== 'full') return pending === true;
  return Array.isArray(blocking) && blocking.some((x) => x?.severity === 'critical');
}

/**
 * review#i（i ≥ 2、delta 確定時）の prompt へ連結する delta ブロック。
 * @param {{shaPrev: string, shaNow: string}} p
 * @returns {string} 末尾改行つき
 */
export function reviewDeltaBlock({ shaPrev, shaNow }) {
  const range = `${shaPrev.trim()}..${shaNow.trim()}`;
  return `delta_range: ${range}\n`
    + `\`git diff ${range}\` が fix delta。既出 findings が delta で解消されたかの確認と、`
    + `delta 内の新規 critical/major のみ報告せよ。PR 全 diff の再読は不要。\n`;
}

/**
 * review#i（i ≥ 2）の prompt へ連結する既出 findings ブロック。既出 findings が空なら空文字。
 * reason が critical_in_full_review の round（critical 後に戻した full review）だけは、critical に
 * 「別観点の上乗せ禁止」を掛けず PR 全 diff の critical を既出 findings と関係なく報告させる（既出を見せて
 * 上乗せを禁じると、読む範囲が PR 全体でも新しい critical を出し渋りうる）。major の蒸し返し・上乗せの禁止
 * （moving target 対策）と topic 再利用（stuck 突合）はどの round でも残す。
 * @param {{prior: unknown[], reason: string|null}} p
 *   prior: 前 round までの累積 findings / reason: resolveReviewScope の reason（delta / remerge round は null）
 * @returns {string}
 */
export function priorFindingsBlock({ prior, reason }) {
  if (!prior.length) return '';
  const head = `既出 findings（前ラウンドまでに指摘済み。author は対応済みのはず）:\n${JSON.stringify(prior)}\n`;
  if (reason === 'critical_in_full_review') {
    return head
      + `この round は前の full review が critical を返したため PR 全 diff を読み直す full review。`
      + `**critical は既出 findings と関係なく**、PR 全 diff のどこにあるものも報告せよ（既出と別観点のものも含む）。`
      + `major は新規のもののみ報告し、前ラウンドで対応済み・却下済みの論点の蒸し返しと`
      + `別観点の上乗せ（moving target）は禁止。既出問題を再提起する場合は既出と同じ topic 文字列を`
      + `必ず再利用せよ（orchestrator が topic で stuck を突合する）。`;
  }
  return head
    + `**新規の critical/major のみ報告**せよ。前ラウンドで対応済み・却下済みの論点の蒸し返し、`
    + `別観点の上乗せ（moving target）は禁止。既出問題を再提起する場合は既出と同じ topic 文字列を`
    + `必ず再利用せよ（orchestrator が topic で stuck を突合する）。`;
}

/**
 * `git diff --shortstat A..B` の stdout（1 行）から変更行数（insertions + deletions）を取り出す。
 * 空文字は差分なし = 0。非文字列 / 数値を含まない文字列は null（不明）。
 * @param {unknown} text
 * @returns {number|null}
 */
export function parseShortstatLines(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  if (t === '') return 0;
  const ins = /(\d+) insertions?\(\+\)/.exec(t);
  const del = /(\d+) deletions?\(-\)/.exec(t);
  if (!ins && !del) return /\d+ files? changed/.test(t) ? 0 : null;
  return (ins ? Number.parseInt(ins[1], 10) : 0) + (del ? Number.parseInt(del[1], 10) : 0);
}
