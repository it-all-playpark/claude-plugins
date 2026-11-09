// stage-contract: dev-flow.js（orchestrator）と工程の workflow の受け渡しの形を検証する。
// 工程の workflow は workflow() の引数でだけ親の判定結果を受け取り、返り値でだけ結果を返す。形の検証はここだけに置き、
// 工程を切り出すたびに spec を足す（工程ごとに検証を書き分けない）。
//   - 子は引数を validateStageArgs で検証し、欠けている・型が違えば throw する（推測で埋めて続けない — 親の判定を
//     取り違えたまま merge tier を出すより、親が HOLD に倒す方が安全）
//   - 親は返り値を stageShapeErrors で検証し、不正なら HOLD に倒す（throw と同じ扱い）
//
// spec: { key: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null' を '|' で並べた型 | 入れ子の spec（object） }
// spec に無いキーは見ない（工程が足したキーで親を止めない）。値が undefined のキーは欠落と同じに扱う。
//
// INLINE COPY POLICY: workflow から参照される最上位宣言だけが tools/sync-inlines.mjs --write で inline 生成される。
// 直接 workflow 側を編集しない。一致は _lib/workflow-inlines.sync.test.mjs が検証する。

// dev-flow-test-commands.js（テストコマンドの解決。issue #1278）の引数と返り値。返り値はコマンドファイルの中身
// （_lib/test-commands.mjs）に commands_file（run-tests の --commands。解決できなければ null もある）と error を足したもの。
// dev-flow は Setup で 1 回だけ起動し、返り値を test_commands として evaluate / pr-iterate / finalize へ渡す。
export const TEST_COMMANDS_ARGS_SPEC = { worktree: 'string', base: 'string' }
export const TEST_COMMANDS_RESULT_SPEC = {
  source: 'string|null', status: 'string', full_command: 'string|null', files_command: 'string|null',
  sources: 'array', commands_file: 'string|null', error: 'string|null',
}

// dev-flow-evaluate.js（Diff triage・Evaluate・Evaluate 後の Validate と green-fix の再評価）の引数。
// state は Validate までの state をそのまま渡す（ledger・shape・security review の対象判定は子が Diff triage で決める）。
// notes は実装 spawn・evaluator の prompt に足す注記（Setup と Implement で決まる値）。
export const EVALUATE_ARGS_SPEC = {
  issue: 'string',
  repo: 'string|null',
  base: 'string',
  worktree: 'string',
  gate_policy: 'string',
  state: {
    req: 'object', plan: 'object', setup: { branch: 'string' }, concerns: 'array',
    val: 'object|null', validateDiffHash: 'string|null', dhPrompt: 'string',
    greenFixCount: 'number', greenFixIterations: 'array', implDroppedCount: 'number',
    baseFailing: { env: 'array', ran: 'array' }, acVerify: 'array',
    localVerifyReimplCount: 'number', acVerifyReimplCount: 'number',
  },
  ci_ac_indexes: 'array',
  notes: { deletion: 'string', deps: 'string', turbopack: 'string', test_discovery: 'string' },
  test_commands: TEST_COMMANDS_RESULT_SPEC,
}

// dev-flow-evaluate.js の返り値。state は PR 工程以降が読む state（評価ループの途中経過は返さない）。
// redgreen_state_dir は Evaluate の redgreen が作った state dir（Final reconcile の redgreen-final が使い回す）。
export const EVALUATE_RESULT_SPEC = {
  state: {
    plan: 'object', ledger: 'object', risk: 'object', dangerHits: 'array', testsurfHits: 'array', testsurfPatterns: 'array',
    securityReview: { target: 'boolean', reasons: 'array', reviewer_context_changed: 'boolean' },
    triage: 'object', EFFECTIVE_SHAPE: 'string', runEval: 'boolean',
    evalResult: 'object|null', evalDiffHash: 'string|null', secDiffHash: 'string|null',
    unsatisfiedAcByActor: 'object', val: 'object|null', greenFixCount: 'number', concerns: 'array',
  },
  redgreen_state_dir: 'string|null',
}

// dev-flow-finalize.js（pr-iterate の後の Final reconcile・Merge tier・終端サマリー）の引数。
// state は Implement〜PR の state をそのまま渡す（子は Final reconcile と merge-tier-facts を自分で取り直す）。
export const FINALIZE_ARGS_SPEC = {
  issue: 'string',
  repo: 'string|null',
  base: 'string',
  worktree: 'string',
  gate_policy: 'string',
  state: {
    req: 'object', plan: 'object', setup: { branch: 'string' }, ledger: 'object',
    val: 'object|null', risk: 'object|null', evalResult: 'object|null', runEval: 'boolean',
    acVerify: 'array', baseFailing: 'object', unsatisfiedAcByActor: 'object', guardBlockedResults: 'array',
  },
  pr: { pr_url: 'string', pr_number: 'string|number' },
  pr_body: 'string',
  iterate: 'object|null',
  route: 'string',
  eval_staleness: 'string',
  ac_verify: 'array',
  ac_verify_indexes: 'array',
  ci_ac_indexes: 'array',
  test_discovery_note: 'string',
  redgreen_state_dir: 'string|null',
  test_commands: TEST_COMMANDS_RESULT_SPEC,
}

// dev-flow-finalize.js の返り値。result は dev-flow の返り値（journal_log_status は親が足す）、handoff は親が journal
// handoff に載せる値（子は handoff しない）。
export const FINALIZE_RESULT_SPEC = {
  result: { merge_tier: 'string', merge_tier_reasons: 'array', summary_posted: 'boolean', note: 'string' },
  handoff: {
    merge_tier: 'string',
    hold_reason_codes: 'array|null',
    hold_ac_human_judged: 'boolean|null',
    final_test_flaky: 'object|null',
    clock: { final_end: 'object|null', end: 'object|null' },
  },
}

function stageTypeOf(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

export function stageShapeErrors(value, spec, path = '') {
  if (stageTypeOf(value) !== 'object') return [`${path || '(root)'}: object が必要（受信: ${stageTypeOf(value)}）`]
  const errors = []
  for (const [key, want] of Object.entries(spec)) {
    const at = path ? `${path}.${key}` : key
    const v = value[key]
    if (v === undefined) {
      errors.push(`${at}: 欠落`)
    } else if (typeof want === 'object') {
      errors.push(...stageShapeErrors(v, want, at))
    } else if (!want.split('|').includes(stageTypeOf(v))) {
      errors.push(`${at}: ${want} が必要（受信: ${stageTypeOf(v)}）`)
    }
  }
  return errors
}

export function validateStageArgs(stage, args, spec) {
  const errors = stageShapeErrors(args, spec)
  if (errors.length) throw new Error(`${stage}: 引数の形が不正 — ${errors.join(' / ')}`)
  return args
}
