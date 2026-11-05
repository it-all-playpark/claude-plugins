// 切り離し実行の proxy（start で常駐化して返り、wait で結果を待つ exec-proxy）を workflow 側で待つ共有ループ。
// 1 回の Bash は 600 秒までしか待てないので、それより長い job は wait の spawn を繰り返して待つ。
// 起動形・label・判定は呼び出し側が持ち、ここは繰り返しと打ち切りだけを持つ。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。
// 制約: ESM import / require / Date.now / Math.random を含めない。export function / export const のみ。

function bgJobJsonType(value) {
  return value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
}

// spawn に渡したのと同じ schema の top-level（required / type / enum）だけを見る。
function bgJobResponseFits(res, schema) {
  if (bgJobJsonType(res) !== 'object') return false
  if (!(schema.required ?? []).every((key) => key in res)) return false
  return Object.entries(schema.properties ?? {}).every(([key, prop]) => !(key in res)
    || ((prop.type == null || [prop.type].flat().includes(bgJobJsonType(res[key])))
      && (prop.enum == null || prop.enum.includes(res[key]))))
}

/**
 * start の応答が running の間 wait の spawn を繰り返し、最後の応答を返す。
 *   - running 以外の応答: そのまま返す（判定は呼び出し側）
 *   - maxPolls 回 wait しても running: 最後の応答に wait_capped:true を足して返す（status は running のまま —
 *     完了と取り違えない）
 *   - null・schema に合わない応答: 以後 wait せず { ok:false, status:'error', error } を返す（読めない応答を
 *     待ち続けない・通過扱いにしない）
 * @param {{start: unknown, wait: (k: number) => Promise<unknown>, maxPolls: number, schema: object}} opts
 *   start: start の spawn の応答 / wait: k 回目（1 始まり）の wait の spawn / maxPolls: wait の上限回数 / schema: 応答の schema
 * @returns {Promise<object>}
 */
export async function waitBgJob({ start, wait, maxPolls, schema }) {
  let res = start
  for (let k = 1; bgJobResponseFits(res, schema) && res.status === 'running' && k <= maxPolls; k++) res = await wait(k)
  if (!bgJobResponseFits(res, schema)) return { ok: false, status: 'error', error: 'proxy の応答が無い・形が不正' }
  return res.status === 'running' ? { ...res, wait_capped: true } : res
}
