// ci-check: pr-iterate の CI gate（`ci-check#i` / `ci-wait-check#i.k`）と dev-flow lite route の
// `ci-check-lite` が共有する CI ステータス取得の契約 — 定数 / StructuredOutput schema / prompt 本文。
// I/O なし、gh なし、Date.now() 非決定性なし。
//
// INLINE COPY POLICY: workflow から参照される最上位宣言だけが tools/sync-inlines.mjs --write で inline 生成される。
// 直接 workflow 側を編集しない。一致は _lib/workflow-inlines.sync.test.mjs が検証する。
//
// なぜ canonical 化するか: 以前は同じ prompt 本文・schema・定数が dev-flow.js と pr-iterate.js に
// 手で複製されており（inline 生成区間の外）、CI polling の仕様を変えると 2 箇所を手で同期する
// 必要があった。片側だけ直すと lite route と pr-iterate で CI 判定が食い違う。
//
// REVIEW schema をここに含めないのは、両者が実際に異なるため（dev-flow 側のみ clock telemetry の
// 給電元として optional `epoch` を持つ）。統合すると pr-iterate の受理 schema が変わる。

// 1 spawn = 1 判定。1 回目の poll は ci-check（待機なし）、2 回目以降は ci-wait-check（待機してから
// 1 回判定）。中継は stdout-relay（agents/stdout-relay.md）で、prompt の最終行の `check-ci` を 1 回実行して
// stdout の JSON をそのまま返す。待機も check-ci の `--wait <秒>` が行う（内部で ci-wait.sh の短い sleep の
// 連結 → `gh pr view` を 1 回）ので、どの prompt も Bash は 1 単文で、必要 turn は
// 1（check-ci）+ 1（StructuredOutput）+ CI_TURN_MARGIN = 5。stdout-relay の maxTurns を超えないこと
// （_lib/ci-check.test.mjs が agent md を実読して pin）。CI 待ちのループは workflow script 側（pr-iterate.js）が持ち、
// CI 所要時間は turn 会計に影響しない。待機と次の判定を 1 spawn にまとめるのは haiku spawn の固定費を
// poll ごとに 1 本削るため。
// 待機は bare `sleep <秒>` を直接呼ばない: Bash tool は「呼び出し全体が sleep <N>」の単文を N が数秒を
// 超えると拒否するため、待たずに失敗して待機会計が実時間から乖離する。
// 実待機が成立した証拠は check-ci が出す `slept:true` のみで、pr-iterate.js はそれ以外（null / throw /
// slept:false）を積算せず、同じ応答の status も採らずに即 ci_pending 終端にする。
//
// 中継の Bash と返り値は hooks/pretool-stdout-relay-guard.sh（_lib/scripts/stdout-relay-bind.mjs）が、
// prompt の最終行のコマンドとその実 stdout（または下の失敗時の JSON）に縛る。中継は PR の worktree を cwd に
// 起動され PR の文に誘導され得るので、返り値を転記の正しさに預けない（分類: incentive-structural）。
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

// CI gate schema。
// stdout-relay が bare `check-ci --pr <N> --repo <R>` を実行し、その stdout JSON を verbatim で返す。
// check-ci（pr-iterate/scripts/check-ci.sh）は内部で読み取り専用の `gh pr view --json headRefOid,statusCheckRollup` を
// 1 回実行して分類する。agent は rollup を argv に転写しないので、入力側の転写の破損で判定が変わらない。
// failed_checks の要素は script 出力と一致する {name, bucket, state}。
// status:'error' は check-ci が gh fetch 失敗を分類した値か、中継が stdout を返せないときの CI_RELAY_FAILED。
// workflow 側は proxy の空応答（turn 上限到達等）も同じ 'error' に合成するため、受け手は原因を 1 つに断定できない。
// 即座に人間へエスカレーションする。
// 件数（passed / failed / pending / skipped）は check-ci が status と一緒に出す値で、required にする。
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
    // check-ci が rollup と同じ gh 応答から取った PR head の commit sha。pr-iterate は review#i と並列に
    // 起動した ci-check#i の結果を、この値が review 開始時の head と一致するときだけ採る（ciHeadRejectReason）。
    head_sha: { type: 'string' },
    // dev-flow の clock telemetry（issue #443）が iterate_end の給電元として読む optional epoch。
    // 旧版 check-ci.sh（epoch 非対応）や失敗時は省略され、返り値の end_epoch も省略される（fail-open）。
    epoch: { type: 'number' },
  },
};

// 中継が check-ci の stdout を返せない（exit 非0・stdout 空・JSON 不正・hook の拒否）ときに返す JSON。prompt が定める
// fail-closed の形で、hooks/pretool-stdout-relay-guard.sh は中継の返り値を stdout の JSON かこの形のどちらかに限る。
// 待機しない prompt（ci-check / ci-check-lite / 待たない ci-verify）は status:'error'（ci_error に倒す）。
export const CI_RELAY_FAILED = { status: 'error', passed: 0, failed: 0, pending: 0, skipped: 0 };
// 待機する prompt（ci-wait-check / 待つ ci-verify。check-ci --wait）は slept:false も持つ — 待機の成否が分からないので
// workflow は待機を積算せず、同じ応答の status も採らない（ci-wait-check の slept 判定）。
export const CI_WAIT_RELAY_FAILED = { slept: false, status: 'error', passed: 0, failed: 0, pending: 0, skipped: 0 };

// check-ci の --only / --exclude に渡す check 名の引数列（名前は単一引用符で囲む。空なら空文字）。
function checkNameArgs(flag, names) {
  return (Array.isArray(names) ? names : []).map((name) => ` ${flag} '${String(name).split("'").join("'\\''")}'`).join('');
}

// CI gate の proxy（ci-check / ci-wait-check / ci-verify）が実行する check-ci の bare 単文。
// exclude: check-ci に --exclude で渡す check 名（ci_verify.checks。review ⇄ fix の round の CI 判定から外す）。
// only: check-ci に --only で渡す check 名（LGTM 後の ci-verify 待ち。check-ci は check run の URL を link で返す）。
// wait: check-ci に --wait で渡す待機秒数（0 / 省略なら待たない）。check-ci は待ってから 1 回だけ取得し slept を出す。
export function checkCiCommand({ pr, repo, exclude = [], only = [], wait = 0 }) {
  return `check-ci --pr ${pr}${repo ? ' --repo ' + repo : ''}${checkNameArgs('--only', only)}${checkNameArgs('--exclude', exclude)}`
    + (Number(wait) > 0 ? ' --wait ' + wait : '');
}

// stdout-relay へ渡す prompt（3 prompt で共通の形）。最終行は check-ci の bare 単文そのもの — hook はこの行と完全に一致する
// Bash だけを通し、返り値をその stdout の JSON か failed（CI_RELAY_FAILED / CI_WAIT_RELAY_FAILED）に限る。
function ciRelayPrompt({ objective, command, failed }) {
  return `## Objective\n${objective}\n\n`
    + `## Tools\n- 使用可: Bash のみ\n\n`
    + `## Boundary\n`
    + `- 読み取り専用。最終行のコマンド以外を実行しない（再実行・再取得をしない）\n`
    + `- ファイルを変更しない\n\n`
    + `## Output format\n`
    + `最終行のコマンドの **stdout の JSON object をそのまま** 返せ（キーの追加・削除・値の書き換え・要約をしない）。`
    + `exit 非0・stdout 空・JSON 不正・拒否されたときは ${JSON.stringify(failed)} を一字一句そのまま返せ（成功の値を作らない）。`
    + `prose 禁止。JSON のみ返せ。\n\n`
    + `## Token cap\nJSON のみ。1 行以内。\n\n`
    + `## Command\n`
    + `次のコマンドを 1 回だけ、一字一句そのままの単文で実行せよ（cd 前置・\`bash\` 前置・環境変数代入前置・&& 連結・パイプ・リダイレクトを付けない）:\n`
    + command;
}

/**
 * ci-check exec-proxy の prompt を組み立てる純粋関数。
 *
 * @param {object} opts
 * @param {number|string} opts.pr - 対象 PR 番号
 * @param {string|null} opts.repo - owner/name。null / 空なら --repo を付けない（cwd の repo を使う）
 * @param {string[]} [opts.exclude] - CI 判定から外す check 名（ci_verify.checks）
 * @returns {string} stdout-relay へ渡す prompt
 */
export function ciCheckPrompt({ pr, repo, exclude = [] }) {
  return ciRelayPrompt({
    objective: `PR #${pr} の head commit sha と CI ステータスを 1 回取得し、JSON を返せ。`,
    command: checkCiCommand({ pr, repo, exclude }),
    failed: CI_RELAY_FAILED,
  });
}

// ci-wait-check exec-proxy の応答 schema — script 側 poll ループの 2 回目以降の 1 poll 分
// （待機 + 1 回判定）。slept は check-ci --wait の stdout 由来で、true 以外なら workflow は status を採らない。
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
 * @returns {string} stdout-relay へ渡す prompt
 */
export function ciWaitCheckPrompt({ pr, repo, seconds, exclude = [] }) {
  return ciRelayPrompt({
    objective: `CI 完了待ちのため ${seconds} 秒待機してから PR #${pr} の CI ステータスを 1 回取得し、JSON を返せ（待機と取得は最終行のコマンドが行う）。`,
    command: checkCiCommand({ pr, repo, exclude, wait: seconds }),
    failed: CI_WAIT_RELAY_FAILED,
  });
}

// ---- ci-verify（issue #861）: LGTM 後に ci_verify.checks の完了を待つ poll ----
// repo が "dev-flow".ci_verify で宣言した check（E2E 等。sandbox 内で実行できず、CI でも数十分かかる）は
// review ⇄ fix の各 round の CI 判定（上限は ciWaitCeiling）から外し（--exclude）、pr-iterate が LGTM に
// 達した後に別ループで ci_verify.wait_ceiling_seconds まで待つ（--only）。1 spawn = 1 判定・ループは
// script 側なのは ci-check / ci-wait-check と同じ。2 回目以降の poll は CI_VERIFY_POLL_SECONDS 待ってから判定する
// （待機と取得は check-ci --wait の 1 回の Bash で、Bash tool の既定 timeout 120 秒に収まる長さにする — check-ci は
// 収まらない秒数を exit 1 で拒否する。長い待ちで poll 間隔を延ばし spawn 数を抑える）。
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
 * @returns {string} stdout-relay へ渡す prompt
 */
export function ciVerifyPrompt({ pr, repo, checks, seconds }) {
  const wait = Number(seconds) > 0;
  const names = (Array.isArray(checks) ? checks : []).join(', ');
  return ciRelayPrompt({
    objective: (wait ? seconds + ' 秒待機してから ' : '') + `PR #${pr} の CI check（${names}）の状態を 1 回取得し、JSON を返せ。`,
    command: checkCiCommand({ pr, repo, only: checks, wait: wait ? seconds : 0 }),
    failed: wait ? CI_WAIT_RELAY_FAILED : CI_RELAY_FAILED,
  });
}

// ci-verify の 1 回の判定（ciEffectiveStatus 済み）を待ちループの分岐に写す純関数。
// no_checks は pending（label を付けた直後は対象 job がまだ登録されていない）。error は待たずに終える（状態不明を
// 待ち続けて上限まで spawn しない）。
export function ciVerifyVerdict(eff) {
  const s = eff?.status;
  if (s === 'passed' || s === 'failed' || s === 'error') return s;
  return 'pending';
}

/**
 * ci-check / ci-wait-check / ci-verify / ci-check-lite の proxy 応答を workflow が採る形に直す純関数。
 * null（agent の null / throw）は status:'error' にし、それ以外はそのまま返す。応答は hook
 * （hooks/pretool-stdout-relay-guard.sh）が check-ci の実 stdout か CI_RELAY_FAILED / CI_WAIT_RELAY_FAILED に縛り、
 * 形は schema（CI_STATUS 等）が縛るので、件数との照合はしない。
 *
 * @param {object|null} ci - proxy の応答
 * @returns {object} status が 5 値 enum のいずれかで確定した応答
 */
export function ciEffectiveStatus(ci) {
  if (ci == null) return { status: 'error', failed_checks: [] };
  return ci;
}

// 並列 ci-check の採否判定。pr-iterate は review#i と ci-check#i を parallel() で同時に起動し、
// ci-check の応答 head_sha が review 開始時の head（expectedSha）と一致するときだけ結果を採る。
// 一致を要求するのは、fix の push 直後に起動した ci-check が GitHub 側の head 更新前の snapshot
// （旧 commit の check）を読んで、旧 head の green で LGTM を確定させないため。check-ci は head sha と
// checks を同じ gh 応答から取るので、sha が一致すれば checks も同じ head のもの。
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
