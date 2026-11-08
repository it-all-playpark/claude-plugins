// _lib/stage-schemas.mjs
// dev-flow.js（Validate / Evaluate）と dev-flow-finalize.js（Final reconcile）が同じ exec-proxy に渡す schema と
// prompt 断片。両工程が同じスクリプトの stdout を読むので、片方だけ直してずれないよう 1 か所に置き、sync-inlines で
// 両ファイルに inline する。副作用の無い定数だけを置く（agent を起動する helper は各 workflow 側）。

// 決定論 proxy が隣接しない境界（implement_end / evaluate_end / pr_end 等）は prompt 末尾にこの 1 文を注入して epoch を
// 返させる（fail-open — 取得失敗は mark null になるだけで、判断・schema required に影響しない）。
export const EPOCH_INSTRUCTION = '作業完了後、最後に Bash で `date +%s` を 1 回実行し、出力の整数を epoch フィールドとして返せ。取得に失敗した場合は epoch を省略してよい（本来の作業・判定には一切影響させるな）。\n'

// run-tests の出力。failed_files: runValidateLoop が「base でも落ちる既存の失敗」を green 要件から外す材料
// （省略時は全失敗が green-fix 対象）。scripts[].log は同じ tree を判定する eval#N / final-ac-reconcile に渡す。
export const GREEN = {
  type: 'object', required: ['tests', 'green'],
  properties: {
    status: { type: 'string', enum: ['running', 'passed', 'failed', 'error'] },
    tests: { type: 'string', enum: ['running', 'passed', 'failed', 'no_tests', 'error'] },
    green: { type: 'boolean' },
    summary: { type: 'string' },
    scripts: {
      type: 'array',
      items: {
        type: 'object',
        properties: { path: { type: 'string' }, exit: { type: 'number' }, launch_failed: { type: 'boolean' }, log: { type: 'string' } },
      },
    },
    failed_files: { type: 'array', items: { type: 'string' } },
    epoch: { type: 'number' },
  },
}

// redgreen-verify の出力: 一意な AC ペアを 1 実行で判定し results に引数順で返す。root が object なのは agent() schema の
// 制約（haiku proxy に配列を包み直させない）。start / wait は未完了なら { status:'running', results:[] } を返す。
export const RG = {
  type: 'object', required: ['results'],
  properties: {
    status: { type: 'string', enum: ['running'] },
    results: {
      type: 'array',
      items: {
        type: 'object', required: ['index', 'red', 'green'],
        properties: {
          index: { type: 'number' },
          red: { type: 'boolean' }, green: { type: 'boolean' }, reason: { type: 'string' }, verdict: {},
          testcmd_ran: { type: 'boolean' }, headdiff: { type: 'object' },
        },
      },
    },
  },
}
export const RG_STOP = { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' }, stopped: { type: 'boolean' }, was_running: { type: 'boolean' }, error: { type: 'string' } } }
export const RG_STATE_DIR = { type: 'object', required: ['state_dir'], properties: { state_dir: { type: 'string' } } }

export const DIFFHASH = {
  type: 'object', required: ['hash', 'empty'],
  properties: { hash: { type: 'string' }, empty: { type: 'boolean' }, epoch: { type: 'number' } },
}
// TREE_DIFF_LINES: `git diff --numstat <from> <to>` の stdout 各行の verbatim 転写。required は 'ok' のみ（fail-open）。
export const TREE_DIFF_LINES = {
  type: 'object', required: ['ok'],
  properties: { ok: { type: 'boolean' }, lines: { type: 'array', items: { type: 'string' } }, error: { type: 'string' } },
}

// local-verify start / wait / stop の stdout JSON（_shared/scripts/local-verify.sh）。
export const LOCALVERIFY = { type: 'object', required: ['ok', 'status'], properties: { ok: { type: 'boolean' }, status: { type: 'string', enum: ['running', 'passed', 'failed', 'timeout', 'stopped', 'unavailable', 'error'] }, exit_code: { type: ['number', 'null'] }, log_path: { type: 'string' }, log_tail: { type: 'string' }, reason: { type: 'string' }, error: { type: 'string' }, db_deleted: { type: ['boolean', 'null'] } } }
export const LOCALVERIFY_STOP = { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' }, stopped: { type: 'boolean' }, was_running: { type: 'boolean' }, db_deleted: { type: ['boolean', 'null'] }, error: { type: 'string' } } }
export const LOCAL_VERIFY_LABELS = { start: (a) => `local-verify-start#${a}`, wait: (a, k) => `local-verify-wait#${a}.${k}`, stop: (a) => `local-verify-stop#${a}` }
export const AC_VERIFY_LABELS = { start: (a) => `ac-verify-start#${a}`, wait: (a, k) => `ac-verify-wait#${a}.${k}`, stop: (a) => `ac-verify-stop#${a}` }
