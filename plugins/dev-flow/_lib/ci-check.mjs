// ci-check: pr-iterate の CI gate（`ci-check#i` / `ci-wait-check#i.k`）と dev-flow lite route の
// `ci-check-lite` が共有する CI ステータス取得の契約 — 定数 / StructuredOutput schema / prompt 本文。
// I/O なし、gh なし、Date.now() 非決定性なし。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証する。
//
// なぜ canonical 化するか: 以前は同じ prompt 本文・schema・定数が dev-flow.js と pr-iterate.js に
// 手で複製されており（inline 生成区間の外）、CI polling の仕様を変えると 2 箇所を手で同期する
// 必要があった。片側だけ直すと lite route と pr-iterate で CI 判定が食い違う。
//
// REVIEW schema をここに含めないのは、両者が実際に異なるため（dev-flow 側のみ clock telemetry の
// 給電元として optional `epoch` を持つ）。統合すると pr-iterate の受理 schema が変わる。

// 1 spawn = 1 判定。1 回目の poll は ci-check（待機なし）、2 回目以降は ci-wait-check（待機してから
// 1 回判定）。必要 turn は ci-check = 1（head sha fetch）+ 2（gh fetch + check-ci）+ 1（StructuredOutput）
// + CI_TURN_MARGIN = 7、
// ci-wait-check = 1（ci-wait）+ 2（gh fetch + check-ci）+ 1（StructuredOutput）+ CI_TURN_MARGIN = 7。
// どちらも dev-runner-haiku-ro の maxTurns を超えないこと（_lib/ci-check.test.mjs が agent md を
// 実読して pin）。CI 待ちのループは workflow script 側（pr-iterate.js）が持ち、CI 所要時間は
// turn 会計に影響しない（issue #663。旧: agent 内 attempt ループで ceiling 90 秒、attempt 増で
// StructuredOutput 未達 → ci_error に化けた issue #621）。待機と次の判定を 1 spawn にまとめるのは
// haiku spawn の固定費を poll ごとに 1 本削るため（issue #805）。
// ci-wait-check は bare `sleep <秒>` を直接呼ばない: Bash tool は「呼び出し全体が sleep <N>」の
// 単文を N が数秒を超えると拒否するため、待たずに失敗して待機会計が実時間から乖離する。
// `ci-wait <秒>`（pr-iterate/scripts/ci-wait.sh）は内部で短い sleep をチェーンして同じ総待機時間を
// 作る 1 本のスクリプトで、Bash 呼び出し全体は非 sleep 先頭トークンの bare 単文になる。
// 実待機が成立した証拠は応答の `slept:true` のみで、pr-iterate.js はそれ以外（null / throw /
// slept:false）を積算せず、同じ応答の status も採らずに即 ci_pending 終端にする。
export const CI_POLL_SECONDS = 45; // script 側 poll ループの poll 間隔（秒）
// script 側ループの nominal 総待機上限（秒）の既定値。上限は prerun（dev-flow-prerun / pr-iterate-prerun の
// _shared/scripts/ci-wait-ceiling.sh）が PR の base branch の CI 所要時間から決めて args.ci_wait_ceiling_seconds で
// 渡し、渡されないときだけこの値を使う（ciWaitCeiling）。一律の上限では CI が長い repo で ci_pending → HOLD になる（issue #1046）。
export const CI_WAIT_CEILING_SECONDS = 300;

/**
 * args.ci_wait_ceiling_seconds を CI 待ちの上限（秒）に直す純関数。未指定（null / undefined）は既定値、
 * 正の整数でなければ明示 throw（不正な上限で黙って待ち時間を変えない）。
 *
 * @param {unknown} raw - args.ci_wait_ceiling_seconds
 * @returns {number}
 */
export function ciWaitCeiling(raw) {
  if (raw == null) return CI_WAIT_CEILING_SECONDS;
  if (!(Number.isInteger(raw) && raw > 0)) {
    throw new Error(`pr-iterate: args.ci_wait_ceiling_seconds は正の整数（受信: ${JSON.stringify(raw)}）`);
  }
  return raw;
}

// 判定 spawn（ci-check + ci-wait-check）回数の上限。待機上限から導く（300 秒なら 6 wait・7 poll）。
export function ciMaxPolls(ceilingSeconds) {
  return Math.floor(ceilingSeconds / CI_POLL_SECONDS) + 1;
}
// 実測マージン。文書化 worst case 8 tool call に対し実測 10 で StructuredOutput 未達だった差分に基づく。
export const CI_TURN_MARGIN = 3;

// CI gate schema — the gate lost in eb8aa7e (issue #133) を復元したもの。
// dev-runner-haiku-ro が bare `gh pr checks` で CI snapshot を取得し、
// pr-iterate/scripts/check-ci.sh（snapshot に対する純変換）で分類して stdout JSON を verbatim で返す。
// fetch を script でなく agent 側に置くのは、exec-proxy script が認証付き network I/O を
// 持ってはならないため（issue #488）。
// failed_checks の要素は script 出力と一致する {name, bucket, state}
// （conclusion は bucket-field migration で削除。issue #133 / ci::bats-fabricated-schema）。
// status:'error' は check-ci が gh fetch 失敗を分類した値。workflow 側は proxy の空応答（turn 上限到達等）と、件数から導いた status との食い違い（ciEffectiveStatus）も同じ 'error' に合成するため、受け手は原因を 1 つに断定できない（issue #621）。即座に人間へエスカレーションする。
// 件数（passed / failed / pending / skipped）は check-ci が status と一緒に出す値で、required にする。
// workflow は proxy の status をそのまま採らず、件数から導き直した status と一致するときだけ採る
// （ciEffectiveStatus）。proxy が pending:2 の出力を status:'passed' と転記した実例があり（issue #834）、
// status 1 語の転記だけに CI の真偽を預けない。
export const CI_STATUS = {
  type: 'object',
  required: ['status', 'passed', 'failed', 'pending', 'skipped'],
  properties: {
    status: { type: 'string', enum: ['passed', 'failed', 'pending', 'no_checks', 'error'] },
    passed: { type: 'integer', minimum: 0 },
    failed: { type: 'integer', minimum: 0 },
    pending: { type: 'integer', minimum: 0 },
    skipped: { type: 'integer', minimum: 0 },
    failed_checks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          bucket: { type: 'string' },
          state: { type: 'string' },
        },
      },
    },
    // check-ci.sh が常に出す accounting キー（1 spawn = 1 判定では常に 0 / 1）。
    // workflow は読まず script 側で積算する（issue #663）。
    waited_seconds: { type: 'number' },
    poll_attempts: { type: 'number' },
    // ci-check が CI snapshot の直前に取った PR head の commit sha。pr-iterate は review#i と並列に
    // 起動した ci-check#i の結果を、この値が review 開始時の head と一致するときだけ採る（ciHeadRejectReason）。
    head_sha: { type: 'string' },
    // dev-flow の clock telemetry（issue #443）が iterate_end の給電元として読む optional epoch。
    // 旧版 check-ci.sh（epoch 非対応）や失敗時は省略され、返り値の end_epoch も省略される（fail-open）。
    epoch: { type: 'number' },
  },
};

// gh fetch → check-ci の 2 単文（ci-check / ci-wait-check で共通の手順本文）。
// n は最初の手順番号。両 prompt で転写契約の文言を食い違わせないために 1 箇所に置く。
// 件数キーの転記指示（ci-check / ci-wait-check 共通）。check-ci は status:'error' のとき件数を出さないので
// そのときだけ 0 を入れさせる（workflow 側は error を件数と照合せずそのまま error として扱う）。
const CI_COUNTS_NOTE = '`passed` / `failed` / `pending` / `skipped` の件数は stdout の値を一字一句そのまま写せ'
  + '（stdout に件数キーが無い場合 — status が error のとき — だけ各 0 を入れよ）。';

// check-ci の --only / --exclude に渡す check 名の引数列（名前は単一引用符で囲む。空なら空文字）。
function checkNameArgs(flag, names) {
  return (Array.isArray(names) ? names : []).map((name) => ` ${flag} '${String(name).split("'").join("'\\''")}'`).join('');
}

// exclude: check-ci に --exclude で渡す check 名（ci_verify.checks。review ⇄ fix の round の CI 判定から外す）。
// only: check-ci に --only で渡す check 名（LGTM 後の ci-verify 待ち）。only を渡すときは gh の --json に link を足し、
// check run の URL を AC の根拠に残す。
export function ciFetchSteps({ pr, repo, n, exclude = [], only = [] }) {
  const withLink = Array.isArray(only) && only.length > 0;
  return `${n}. \`gh pr checks ${pr}${repo ? ' --repo ' + repo : ''} --json name,state,bucket${withLink ? ',link' : ''}\` を gh を先頭トークンとする bare 単文で実行せよ`
    + `（リダイレクト・パイプ・複合コマンドは使わない）。`
    + `このコマンドの exit code を判定に使ってはならない（pending で 8、失敗ありで 1 を返す仕様であり、fetch 自体の成否とは無関係）。\n`
    + `${n + 1}. \`check-ci --checks-data '<手順${n}の stdout を一字一句そのまま。要約・整形・省略禁止>' `
    + `--fetch-error-data '<手順${n}の stderr を一字一句そのまま。stderr が空なら本オプション自体を省略>'`
    + `${checkNameArgs('--only', only)}${checkNameArgs('--exclude', exclude)}\` `
    + `を単文で実行し、stdout の JSON を読め。\n`;
}

/**
 * ci-check exec-proxy の prompt を組み立てる純粋関数。
 *
 * @param {object} opts
 * @param {number|string} opts.pr - 対象 PR 番号
 * @param {string|null} opts.repo - owner/name。null / 空なら --repo を付けない（cwd の repo を使う）
 * @param {string[]} [opts.exclude] - CI 判定から外す check 名（ci_verify.checks）
 * @returns {string} dev-runner-haiku-ro へ渡す prompt
 */
export function ciCheckPrompt({ pr, repo, exclude = [] }) {
  return `## Objective\nPR #${pr} の head commit sha と CI ステータスを取得し、JSON を返せ。\n\n`
    + `## Tools\n`
    + `- 使用可: Bash のみ\n`
    + `- 禁止: Write, Edit, git commit, git push\n\n`
    + `## Boundary\n`
    + `- 読み取り専用。git mutation（commit/push/reset 等）禁止\n`
    + `- 実行するスクリプト以外のファイルを変更しない\n\n`
    + `## Steps\n`
    + `1. \`gh pr view ${pr}${repo ? ' --repo ' + repo : ''} --json headRefOid -q .headRefOid\` を gh を先頭トークンとする bare 単文で実行せよ`
    + `（リダイレクト・パイプ・複合コマンドは使わない）。stdout の 40 桁 hex を一字一句そのまま head_sha とする（失敗・空なら head_sha は省略）。\n`
    + ciFetchSteps({ pr, repo, n: 2, exclude })
    + `4. 手順 3 の stdout JSON（{status, passed, failed, pending, skipped, failed_checks, waited_seconds, poll_attempts, ...}）に手順 1 の \`"head_sha"\` を加えて返せ。`
    + `それ以外のキーは要約・加工するな。${CI_COUNTS_NOTE}1 回の取得で判定を確定させ、待機や再取得は行うな。\n\n`
    + `## Output format\n`
    + `{ "status": "passed"|"failed"|"pending"|"no_checks"|"error", "passed": number, "failed": number, "pending": number, "skipped": number, `
    + `"failed_checks": [{name, bucket, state}, ...], "waited_seconds": number, "poll_attempts": number, "head_sha": string }\n`
    + `prose 禁止。JSON のみ返せ。\n\n`
    + `## Token cap\n`
    + `JSON のみ。1 行以内。`;
}

// ci-wait-check exec-proxy の応答 schema — script 側 poll ループの 2 回目以降の 1 poll 分
// （待機 + 1 回判定）。slept は ci-wait の stdout 由来で、true 以外なら workflow は status を採らない。
export const CI_WAIT_CHECK = {
  type: 'object',
  required: ['slept', ...CI_STATUS.required],
  properties: {
    slept: { type: 'boolean' },
    ...CI_STATUS.properties,
  },
};

/**
 * ci-wait-check exec-proxy の prompt を組み立てる純粋関数（待機してから 1 回だけ判定する）。
 *
 * @param {object} opts
 * @param {number|string} opts.pr - 対象 PR 番号
 * @param {string|null} opts.repo - owner/name。null / 空なら --repo を付けない（cwd の repo を使う）
 * @param {number} opts.seconds - 判定前の待機秒数
 * @param {string[]} [opts.exclude] - CI 判定から外す check 名（ci_verify.checks）
 * @returns {string} dev-runner-haiku-ro へ渡す prompt
 */
export function ciWaitCheckPrompt({ pr, repo, seconds, exclude = [] }) {
  return `## Objective\nCI 完了待ちのため ${seconds} 秒待機してから PR #${pr} の CI ステータスを 1 回取得し、JSON を返せ。\n\n`
    + `## Tools\n`
    + `- 使用可: Bash のみ\n`
    + `- 禁止: Write, Edit, git commit, git push\n\n`
    + `## Boundary\n`
    + `- 読み取り専用。git mutation（commit/push/reset 等）禁止\n`
    + `- 実行するスクリプト以外のファイルを変更しない\n\n`
    + `## Steps\n`
    + `1. \`ci-wait ${seconds}\` を ci-wait を先頭トークンとする bare 単文で実行せよ（リダイレクト・パイプ・複合コマンドは使わない）。`
    + `stdout の JSON が \`"slept": true\` でなければ（stdout が空・exit 非0 を含む）手順 2〜4 を実行せず、`
    + `\`{ "slept": false, "status": "pending", "passed": 0, "failed": 0, "pending": 0, "skipped": 0 }\` を返して終了せよ。\n`
    + ciFetchSteps({ pr, repo, n: 2, exclude })
    + `4. 手順 3 の stdout JSON（{status, passed, failed, pending, skipped, failed_checks, waited_seconds, poll_attempts, ...}）に \`"slept": true\` を加えて返せ。`
    + `それ以外のキーは要約・加工するな。${CI_COUNTS_NOTE}ci-wait と取得は各 1 回だけ実行し、再待機や再取得は行うな。\n\n`
    + `## Output format\n`
    + `{ "slept": boolean, "status": "passed"|"failed"|"pending"|"no_checks"|"error", "passed": number, "failed": number, "pending": number, "skipped": number, `
    + `"failed_checks": [{name, bucket, state}, ...], "waited_seconds": number, "poll_attempts": number }\n`
    + `prose 禁止。JSON のみ返せ。\n\n`
    + `## Token cap\n`
    + `JSON のみ。1 行以内。`;
}

// ---- ci-verify（issue #861）: LGTM 後に ci_verify.checks の完了を待つ poll ----
// repo が "dev-flow".ci_verify で宣言した check（E2E 等。sandbox 内で実行できず、CI でも数十分かかる）は
// review ⇄ fix の各 round の CI 判定（上限は ciWaitCeiling）から外し（--exclude）、pr-iterate が LGTM に
// 達した後に別ループで ci_verify.wait_ceiling_seconds まで待つ（--only）。1 spawn = 1 判定・ループは
// script 側なのは ci-check / ci-wait-check と同じ。2 回目以降の poll は CI_VERIFY_POLL_SECONDS 待ってから判定する
// （ci-wait は Bash tool の既定 timeout 120 秒に収まる長さにする。長い待ちで poll 間隔を延ばし spawn 数を抑える）。
export const CI_VERIFY_POLL_SECONDS = 90;

// ci-verify#i.k の応答 schema。slept は待機した poll（2 回目以降）でだけ返る。passed_checks は check-ci --only の出力
// （link 付き。success の根拠 URL）。
export const CI_VERIFY_CHECK = {
  type: 'object',
  required: [...CI_STATUS.required],
  properties: {
    slept: { type: 'boolean' },
    ...CI_STATUS.properties,
    passed_checks: CI_STATUS.properties.failed_checks,
  },
};

/**
 * ci-verify exec-proxy の prompt を組み立てる純粋関数（ci_verify.checks だけを判定する。seconds > 0 なら待機してから判定）。
 *
 * @param {object} opts
 * @param {number|string} opts.pr - 対象 PR 番号
 * @param {string|null} opts.repo - owner/name。null / 空なら --repo を付けない
 * @param {string[]} opts.checks - 判定する check 名（ci_verify.checks）
 * @param {number} opts.seconds - 判定前の待機秒数（0 なら待機しない）
 * @returns {string} dev-runner-haiku-ro へ渡す prompt
 */
export function ciVerifyPrompt({ pr, repo, checks, seconds }) {
  const wait = Number(seconds) > 0;
  const names = (Array.isArray(checks) ? checks : []).join(', ');
  return `## Objective\n${wait ? `${seconds} 秒待機してから ` : ''}PR #${pr} の CI check（${names}）の状態を 1 回取得し、JSON を返せ。\n\n`
    + `## Tools\n`
    + `- 使用可: Bash のみ\n`
    + `- 禁止: Write, Edit, git commit, git push\n\n`
    + `## Boundary\n`
    + `- 読み取り専用。git mutation（commit/push/reset 等）禁止\n`
    + `- 実行するスクリプト以外のファイルを変更しない\n\n`
    + `## Steps\n`
    + (wait
      ? `1. \`ci-wait ${seconds}\` を ci-wait を先頭トークンとする bare 単文で実行せよ（リダイレクト・パイプ・複合コマンドは使わない）。`
        + `stdout の JSON が \`"slept": true\` でなければ（stdout が空・exit 非0 を含む）手順 2〜4 を実行せず、`
        + `\`{ "slept": false, "status": "pending", "passed": 0, "failed": 0, "pending": 0, "skipped": 0 }\` を返して終了せよ。\n`
      : `1. 待機はしない（ci-wait を実行しない）。\n`)
    + ciFetchSteps({ pr, repo, n: 2, only: checks })
    + `4. 手順 3 の stdout JSON（{status, passed, failed, pending, skipped, failed_checks, pending_checks, passed_checks, waited_seconds, poll_attempts, ...}）${wait ? 'に `"slept": true` を加えて' : 'を'}返せ。`
    + `それ以外のキーは要約・加工するな。failed_checks / passed_checks の link は一字一句そのまま写せ。${CI_COUNTS_NOTE}`
    + `${wait ? 'ci-wait と' : ''}取得は 1 回だけ実行し、再待機や再取得は行うな。\n\n`
    + `## Output format\n`
    + `{ ${wait ? '"slept": boolean, ' : ''}"status": "passed"|"failed"|"pending"|"no_checks"|"error", "passed": number, "failed": number, "pending": number, "skipped": number, `
    + `"failed_checks": [{name, bucket, state, link}, ...], "passed_checks": [{name, bucket, state, link}, ...], "waited_seconds": number, "poll_attempts": number }\n`
    + `prose 禁止。JSON のみ返せ。\n\n`
    + `## Token cap\n`
    + `JSON のみ。1 行以内。`;
}

// ci-verify の 1 回の判定（ciEffectiveStatus 済み）を待ちループの分岐に写す純関数。
// no_checks は pending（label を付けた直後は対象 job がまだ登録されていない）。error は待たずに終える（状態不明を
// 待ち続けて上限まで spawn しない）。
export function ciVerifyVerdict(eff) {
  const s = eff?.status;
  if (s === 'passed' || s === 'failed' || s === 'error') return s;
  return 'pending';
}

// check-ci の件数から status を導き直す（check-ci.sh の compute_verdict と同じ優先順）。
// failed>0 → failed、pending>0 → pending、件数 0 → no_checks、それ以外 → passed。
// 件数のどれかが非負整数でなければ null（導けない）。skipped は passed に含まれる内訳なので判定に使わない。
export function ciStatusFromCounts(ci) {
  const keys = ['passed', 'failed', 'pending', 'skipped'];
  if (ci == null || !keys.every((k) => Number.isInteger(ci[k]) && ci[k] >= 0)) return null;
  if (ci.failed > 0) return 'failed';
  if (ci.pending > 0) return 'pending';
  if (ci.passed + ci.failed + ci.pending + ci.skipped === 0) return 'no_checks';
  return 'passed';
}

/**
 * ci-check / ci-wait-check / ci-check-lite の proxy 応答を workflow が採る形に直す純関数。
 * proxy の status は件数から導いた status と一致するときだけ採り、食い違い・件数欠落は error にする
 * （fail-closed。転記の食い違いを passed に倒さない — issue #834）。proxy が error を返したときは
 * check-ci が件数を出さない分類なので照合せず error のまま。null（agent の null / throw）も error。
 * error にした応答には count_mismatch: { reported, derived } を付け、呼び出し側が理由を log に出す。
 *
 * @param {object|null} ci - proxy の応答
 * @returns {object} status が 5 値 enum のいずれかで確定した応答
 */
export function ciEffectiveStatus(ci) {
  if (ci == null) return { status: 'error', failed_checks: [] };
  if (ci.status === 'error') return ci;
  const derived = ciStatusFromCounts(ci);
  if (derived !== null && derived === ci.status) return ci;
  return { ...ci, status: 'error', count_mismatch: { reported: ci.status ?? null, derived } };
}

// 並列 ci-check の採否判定。pr-iterate は review#i と ci-check#i を parallel() で同時に起動し、
// ci-check の応答 head_sha が review 開始時の head（expectedSha）と一致するときだけ結果を採る。
// 一致を要求するのは、fix の push 直後に起動した ci-check が GitHub 側の head 更新前の snapshot
// （旧 commit の check）を読んで、旧 head の green で LGTM を確定させないため。ci-check は head sha →
// checks の順に取るので、sha が一致すれば checks も同じ head のもの（round 中に他の push は無い）。
// 返り値 null は採用可。それ以外は不採用理由で、呼び出し側は review の後に直列で ci-check を起動し直す。
// 短縮 sha は一致と見なさない（照合しきれない値で採用側に倒さない）。
const CI_HEAD_SHA_RE = /^[0-9a-f]{40}$/i;

// 40 桁 hex の commit sha か。pr-iterate は review 開始時の head がこれを満たさない round では、
// 結果を照合できない並列 ci-check を起動しない（起動すると必ず不採用になり、直列の再起動で spawn が増える）。
export function isFullCommitSha(s) {
  return typeof s === 'string' && CI_HEAD_SHA_RE.test(s.trim());
}

/**
 * @param {object} opts
 * @param {object|null} opts.ci - 並列 ci-check の応答（null は agent の null / throw）
 * @param {string|null} opts.expectedSha - review 開始時の PR head commit sha
 * @returns {null|'ci_null'|'review_head_unknown'|'ci_head_missing'|'head_mismatch'}
 */
export function ciHeadRejectReason({ ci, expectedSha }) {
  if (!isFullCommitSha(expectedSha)) return 'review_head_unknown';
  if (ci == null) return 'ci_null';
  if (!isFullCommitSha(ci.head_sha)) return 'ci_head_missing';
  if (ci.head_sha.trim().toLowerCase() !== expectedSha.trim().toLowerCase()) return 'head_mismatch';
  return null;
}
