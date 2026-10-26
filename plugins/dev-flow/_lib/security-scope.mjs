// security-scope.mjs — 敵対的 security review の対象判定を exec-proxy で取る prompt と、その応答の読み方（issue #1063）。
// dev-flow.js（Security floor の起動時の判定）と pr-iterate.js（LGTM を確定する前の判定）が使う。
// 判定の規則そのものは _lib/security-review-scope.mjs（bin/ の bare 名 `security-review-scope` が実行する）にあり、
// workflow 側は応答の ok / target を読むだけ。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。

export const SECURITY_SCOPE_SCHEMA = {
  type: 'object', required: ['ok', 'target'],
  properties: {
    ok: { type: 'boolean' },
    target: { type: 'boolean' },
    reasons: { type: 'array', items: { type: 'string' } },
    file_count: { type: ['number', 'null'] },
    head_sha: { type: ['string', 'null'] },
    reviewer_context_changed: { type: 'boolean' },
    review_dir: { type: ['string', 'null'] },
    diff_path: { type: ['string', 'null'] },
    error: { type: 'string' },
  },
};

// 中継が stdout を写せないときに返す JSON（prompt が定める fail-closed の形）。Codex 経路の run では
// hooks/pretool-codex-invocation-guard.sh が、中継の返り値を stdout の JSON かこの形のどちらかに限る。
export const SECURITY_SCOPE_RELAY_FAILED = { ok: false, target: true, reasons: [], reviewer_context_changed: true, error: 'relay_failed' };

// head が null なら作業ツリー（未コミット・untracked を含む）と merge-base の diff（dev-flow の Security floor —
// implementer は commit しない）、head があれば `<base>...<head>` の diff。saveDiff は diff 全文を worktree の外の
// 新しい一時ディレクトリの pr.diff に書かせる（pr-iterate の security-reviewer・Codex 経路の prep が読む）。
export function securityScopePrompt({ worktree, base, head = null, saveDiff = false }) {
  const tail = head == null ? '--working-tree' : `${head}${saveDiff ? ' --save-diff' : ''}`;
  return '次のコマンドを 1 回だけ実行し、**stdout の JSON object をそのまま** 返せ（判定・要約・脚色をしない。'
    + `exit 非0・stdout 空・JSON 不正なら ${JSON.stringify(SECURITY_SCOPE_RELAY_FAILED)} で返せ。`
    + '失敗時に target:false を生成してはならない）。先頭トークンが bare 名の単文で実行し、cd 前置・`bash` 前置・'
    + '環境変数代入前置・&& 連結・パイプ・リダイレクトは付けない:\n'
    + `security-review-scope ${worktree} ${base} ${tail}`;
}

// Codex 経路の run が review する head と base は、GitHub の PR の値で決める。手元の HEAD・origin/<base> は PR の worktree で動く
// fix#i や commit-ensure#i（PR の CLAUDE.md を受け取り得る）が push しない commit や ref の書き換えで変えられるので、基準にしない。
// sha は security-codex-relay が bare の gh で取り（hook が返り値を stdout に縛る）、object は同じ中継の git fetch で取る。
export const SECURITY_PR_HEAD_SCHEMA = {
  type: 'object',
  properties: {
    baseRefOid: { type: 'string' },
    headRefOid: { type: 'string' },
    ok: { type: 'boolean' },
    error: { type: 'string' },
  },
};

export const SECURITY_PR_HEAD_RELAY_FAILED = { ok: false, error: 'relay_failed' };

export function securityPrHeadPrompt({ pr, repo }) {
  return '次のコマンドを 1 回だけ実行し、**stdout の JSON object をそのまま** 返せ（判定・要約・脚色をしない。'
    + `exit 非0・stdout 空・JSON 不正なら ${JSON.stringify(SECURITY_PR_HEAD_RELAY_FAILED)} で返せ）。先頭トークンが gh の単文で実行し、cd 前置・`
    + '`bash` 前置・環境変数代入前置・&& 連結・パイプ・リダイレクトは付けない:\n'
    + `gh pr view ${pr} --repo ${repo} --json baseRefOid,headRefOid`;
}

// 返り値は SECURITY_CODEX_RUN_SCHEMA の {"done":true} だけ（fetch の成否は scope が sha の object を読めるかで決まる）
export function securityPrFetchPrompt({ base, pr }) {
  return '次のコマンドを 1 回だけ実行せよ。一字一句そのままの単文で実行し、cd 前置・`bash` 前置・環境変数代入前置・&& 連結・パイプ・'
    + 'リダイレクトを付けない。exit code・出力に関わらず（失敗・拒否されても）{"done":true} だけを返す。出力を要約・転記しない:\n'
    + `git fetch origin ${base} refs/pull/${pr}/head`;
}

// 40 桁の hex の sha が 2 つそろったときだけ { base, head }。それ以外（失敗時の JSON・null・形の崩れ）は null
export function prHeadOf(res) {
  const sha = (v) => typeof v === 'string' && /^[0-9a-f]{40}$/i.test(v);
  if (res == null || typeof res !== 'object' || !sha(res.baseRefOid) || !sha(res.headRefOid)) return null;
  return { base: res.baseRefOid.toLowerCase(), head: res.headRefOid.toLowerCase() };
}

// 対象外は ok:true かつ target:false のときだけ。null・throw 由来の null・形の崩れ・取得失敗は対象（fail-closed —
// 判定できない入力を対象外と同一視しない）。
export function isSecurityScopeExempt(res) {
  return res != null && typeof res === 'object' && res.ok === true && res.target === false;
}

// diff が security-reviewer の session に自動で読み込まれる指示ファイル（CLAUDE.md / AGENTS.md / repo 直下の .claude/ 等）を
// 変えるか。false を返すのは ok:true かつ reviewer_context_changed:false のときだけ（欠落・取得失敗は変えた扱い —
// fail-closed）。変えた PR は reviewer の判定に攻撃者の文が混ざり得るので、自動の security review では clear にしない。
export function isReviewerContextChanged(res) {
  return !(res != null && typeof res === 'object' && res.ok === true && res.reviewer_context_changed === false);
}
