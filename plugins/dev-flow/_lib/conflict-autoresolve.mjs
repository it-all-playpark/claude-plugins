// conflict-autoresolve: pr-iterate が LGTM 確定前に base との conflict を読み（mergeable-check#i）、機械的に解ける型だけ
// 自動解消して push する（conflict-resolve#i）ための契約 — schema / prompt 本文 / 応答の正規化（issue #916）。
// I/O なし、gh なし、Date.now() 非決定性なし。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証する。
//
// 型の判定と解消は決定論スクリプト `conflict-autoresolve`（_shared/scripts/conflict-autoresolve.sh）だけが行い、
// agent は fetch / script / push の bare 単文を転写するだけにする。base 側が非空の hunk をどちらで解くかは仕様判断で、
// LLM に解かせると PR 側を黙って捨てる解消が起き得る（incentive-structural）。解けない conflict は従来どおり
// dev-flow の Merge tier が `mergeable_conflicting` で HOLD にする（判定は変えない）。

// mergeable-check#i（dev-runner-haiku-ro）の応答。gh pr view の値をそのまま写す。headRefOid は終了レポートの回収状況が
// 「どの head の観測か」を確かめる材料で、欠けても conflict の判定と自動解消は変わらない（回収状況が未確認になるだけ）。
export const MERGEABLE_STATE = {
  type: 'object',
  required: ['mergeable', 'mergeStateStatus'],
  properties: { mergeable: { type: 'string' }, mergeStateStatus: { type: 'string' }, headRefOid: { type: 'string' } },
};

// conflict-resolve#i（dev-runner-haiku）の応答。result は conflict-autoresolve の stdout JSON。
export const CONFLICT_RESOLVE = {
  type: 'object',
  required: ['fetched', 'pushed'],
  properties: {
    fetched: { type: 'boolean' },
    pushed: { type: 'boolean' },
    result: {
      type: 'object',
      properties: {
        status: { type: 'string' },
        reason: { type: 'string' },
        base_ref: { type: 'string' },
        head_before: { type: 'string' },
        head_after: { type: 'string' },
        restored: { type: 'boolean' },
        files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, type: { type: 'string' } } } },
      },
    },
  },
};

// conflict-autoresolve が返す status。resolved 以外は merge 前に戻している。
export const CONFLICT_SCRIPT_STATUSES = ['resolved', 'aborted', 'no_conflict', 'error'];

/**
 * base との conflict を自動解消の対象にするか。CONFLICTING / DIRTY のときだけ true。
 * UNKNOWN（GitHub が計算中）・取得失敗（null / 空）は false — 何もせず従来どおり LGTM へ進む。
 * @param {unknown} meta - MERGEABLE_STATE の応答
 * @returns {boolean}
 */
export function isConflictingMergeable(meta) {
  if (meta == null || typeof meta !== 'object') return false;
  const mg = String(meta.mergeable ?? '').toUpperCase();
  const ms = String(meta.mergeStateStatus ?? '').toUpperCase();
  return mg === 'CONFLICTING' || ms === 'DIRTY';
}

/**
 * mergeable-check#i の応答を、終了レポートの回収状況が使う conflict の観測にする。head は同じ gh pr view で読んだ値（無ければ null）。
 * 同じ head で自動解消を push した直後は GitHub が UNKNOWN を返しうるので、UNKNOWN・取得失敗では自動解消の観測を消さない。
 * @param {unknown} meta - MERGEABLE_STATE の応答
 * @param {{state: string, head: string|null}|null} [prev] - 直前の観測
 * @returns {{state: 'clean'|'conflicting'|'unknown'|'resolved', head: string|null}}
 */
export function mergeableObservation(meta, prev = null) {
  const raw = meta != null && typeof meta === 'object' && typeof meta.headRefOid === 'string' ? meta.headRefOid.trim().toLowerCase() : '';
  const head = /^[0-9a-f]{40}$/.test(raw) ? raw : null;
  if (isConflictingMergeable(meta)) return { state: 'conflicting', head };
  if (meta != null && typeof meta === 'object' && String(meta.mergeable ?? '').toUpperCase() === 'MERGEABLE') return { state: 'clean', head };
  if (prev?.state === 'resolved' && (head == null || head === prev.head)) return prev;
  return { state: 'unknown', head };
}

/**
 * conflict-resolve#i の結果（conflictAutoresolveRecord）を conflict の観測に反映する。push まで済んだ自動解消はその merge commit の
 * head で解消、衝突なしで merge できた（no_conflict）なら conflict なし。それ以外は mergeable-check の観測（conflict あり）のまま。
 * @param {{state: string, head: string|null}} seen - mergeableObservation の値
 * @param {{status: string, merge_sha: string|null}} rec
 * @returns {{state: string, head: string|null}}
 */
export function mergeableAfterAttempt(seen, rec) {
  if (rec.status === 'resolved') return { state: 'resolved', head: rec.merge_sha };
  if (rec.status === 'no_conflict') return { state: 'clean', head: seen.head };
  return seen;
}

/**
 * mergeable-check#i の prompt。
 * @param {{pr: number|string, repo?: string|null}} p
 * @returns {string}
 */
export function mergeableCheckPrompt({ pr, repo }) {
  const repoArg = repo ? ` --repo ${repo}` : '';
  return `## Objective\nPR #${pr} の base branch との conflict 状態（mergeable / mergeStateStatus）と、その head（headRefOid）を読む。\n\n`
    + `## Steps\n\`gh pr view ${pr}${repoArg} --json mergeable,mergeStateStatus,headRefOid\` を先頭トークンが gh の bare 単文で 1 回だけ実行せよ`
    + `（cd 前置・\`bash\` 前置・環境変数代入前置・&& 連結・パイプ・リダイレクトは禁止）。`
    + `stdout の mergeable・mergeStateStatus・headRefOid の値を一字一句そのまま返す。コマンドが失敗したら 3 つとも空文字で返す。\n\n`
    + `## Output format\n{ "mergeable": string, "mergeStateStatus": string, "headRefOid": string }\nprose 禁止。JSON のみ返せ。\n\n`
    + `## Tools\n使用可: Bash のみ\n\n`
    + `## Boundary\n読み取り専用。ファイル変更・git 操作禁止。\n\n`
    + `## Token cap\nJSON のみ。1 行以内。`;
}

/**
 * conflict-resolve#i の prompt。fetch と push は agent の bare 単文、merge・判定・解消は conflict-autoresolve が行う。
 * @param {{pr: number|string, wt: string, base: string, pushRule: string}} p
 *   wt: PR branch を checkout 済みの worktree の絶対パス / base: base branch 名 / pushRule: push の実行規約（timeout・再発行禁止）
 * @returns {string}
 */
export function conflictResolvePrompt({ pr, wt, base, pushRule }) {
  return `## Objective\nPR #${pr} の branch に base branch（\`${base}\`）を merge し、conflict が機械的に解ける型だけなら決定論スクリプトで解消して push する。\n\n`
    + `## Steps\n以下を順に bare 単文（先頭トークンが git または conflict-autoresolve。cd 前置・bash 前置・環境変数代入前置・&& 連結禁止）で実行せよ:\n`
    + `1. \`git fetch origin ${base}\` を実行する。失敗したら fetched:false, pushed:false として手順 2・3 を実行せずに返す。\n`
    + `2. \`conflict-autoresolve --worktree ${wt} --base-ref origin/${base}\` を実行し、stdout の JSON 1 行を一字一句そのまま result に入れる（要約・整形・フィールドの追加と削除は禁止）。\n`
    + `3. result.status が "resolved" のときだけ \`git push origin HEAD\` を実行する。${pushRule}`
    + `push が成功したら pushed:true、失敗・timeout なら pushed:false。resolved 以外は push せず pushed:false。\n`
    + `merge・衝突の解消・\`git merge --abort\` を自分で行わない（スクリプトが行う）。ファイルを編集しない。\n\n`
    + `## Output format\n{ "fetched": boolean, "result": <手順 2 の stdout JSON>, "pushed": boolean }\nprose 禁止。JSON のみ返せ。\n\n`
    + `## Tools\n使用可: Bash, Read\n\n`
    + `## Boundary\n上記コマンド以外のファイル変更・git 操作禁止。\n\n`
    + `## Token cap\nJSON のみ。`;
}

/**
 * conflict-resolve#i の応答を 1 回分の記録に正規化する（pr-iterate の返り値 conflict_autoresolve[] の要素）。
 * status:
 *   'resolved'    — merge commit を作り push まで済んだ（merge_sha は 40 桁 hex のときだけ値を持つ）
 *   'push_failed' — merge commit を作ったが push できなかった（worktree に未 push の commit が残る）
 *   'aborted' / 'no_conflict' / 'error' — 自動解消していない（script が merge 前に戻した / 実行できなかった）
 * @param {unknown} res - CONFLICT_RESOLVE の応答（null は proxy の失敗）
 * @param {number} iteration
 * @returns {{iteration: number, status: string, reason: string, files: Array<{path: string, type: string}>, merge_sha: string|null}}
 */
export function conflictAutoresolveRecord(res, iteration) {
  const base = { iteration, status: 'error', reason: '', files: [], merge_sha: null };
  if (res == null || typeof res !== 'object') return { ...base, reason: 'proxy_failed' };
  if (res.fetched !== true) return { ...base, reason: 'fetch_failed' };
  const r = res.result;
  if (r == null || typeof r !== 'object' || !CONFLICT_SCRIPT_STATUSES.includes(r.status)) return { ...base, reason: 'invalid_result' };
  const files = Array.isArray(r.files)
    ? r.files.filter((f) => f != null && typeof f.path === 'string').map((f) => ({ path: f.path, type: String(f.type ?? '') }))
    : [];
  const reason = typeof r.reason === 'string' ? r.reason : '';
  if (r.status !== 'resolved') return { ...base, status: r.status, reason, files };
  const sha = typeof r.head_after === 'string' && /^[0-9a-f]{40}$/i.test(r.head_after.trim()) ? r.head_after.trim() : null;
  return { ...base, status: res.pushed === true ? 'resolved' : 'push_failed', reason, files, merge_sha: sha };
}

/**
 * 自動解消の merge commit を push した次 round の review prompt。読む diff を解消で入った行に限る
 * （base 側・PR 側それぞれの変更は前 round までに review / CI を通っている）。
 * @param {{pr: number|string, mergeSha: string}} p
 * @returns {string} 末尾改行つき
 */
export function remergeReviewPrompt({ pr, mergeSha }) {
  return `PR #${pr} の base 取り込み merge commit ${mergeSha} をレビューせよ。conflict の自動解消で入った行だけが対象で、`
    + `読む diff は \`git show --remerge-diff ${mergeSha}\` の出力に限定する。解消で行が欠落・重複していないか、`
    + `両側の変更が意味的に両立しているかを確かめ、その範囲の新規 critical/major のみ報告せよ。PR 全 diff の再読は不要。\n`;
}
