// implement-loop: dev-implementer の spawn（Implement・各差し戻し）と test ⇄ green-fix ループ（runValidateLoop）の canonical。
// dev-flow.js（Implement / Validate / local-verify / AC コマンド）と dev-flow-evaluate.js（Evaluate の差し戻しと post-eval
// 再テスト）が同じ prompt・break 条件・計上で動くよう、ここだけに置いて両方へ inline する（工程ごとに書き分けない）。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ inline 生成される。
// 直接 workflow 側を編集しない。一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。
//
// workflow ごとに違うもの（worktree・issue・spawn・log・実装 prompt に足す注記）は makeImplementLoop の env で受ける。
// 他の canonical（run-tests-prompt / bg-job-wait / pre-commit-hook / base-failure-triage / pr-artifacts）の関数・定数は
// inline 先の workflow で同じ名前に解決する（import できないため。単体テストは globalThis に置く）。

export const IMPL_AGENT = 'dev-implementer'
// 既定 model は agents/dev-implementer.md の frontmatter（opus。impl_model_config はそのリテラル、review-model-frontmatter.test.mjs が pin）。
// GREEN_FIX_MODEL: green-fix は opus 級の推論を要さず、green-fix > 0 の run は Evaluate のテスト弱体化監査が強制される。
export const GREEN_FIX_MODEL = 'sonnet'
export const GREEN_MAX = 3   // test green までの実装差し戻し上限

// 決定論 proxy が隣接しない境界（implement_end / evaluate_end / pr_end 等）は prompt 末尾にこの 1 文を注入して epoch を
// 返させる（fail-open — 取得失敗は mark null になるだけで、判断・schema required に影響しない）。
export const EPOCH_INSTRUCTION = '作業完了後、最後に Bash で `date +%s` を 1 回実行し、出力の整数を epoch フィールドとして返せ。取得に失敗した場合は epoch を省略してよい（本来の作業・判定には一切影響させるな）。\n'

// worktree 内の一時ファイルは realized-diff を膨らませ、実効 shape の誤判定・宣言外 concern の原因になる。agent 定義は
// sandbox write-deny なので workflow が全実装 spawn prompt に注入する。.devflow-tmp/ は isEphemeralPath が除外するので
// 後始末は不要 — 削除を指示すると agent が削除コマンドを組み立てて実行制御に弾かれ turn を失う。
export const STAGING_CONVENTION = `一時/handoff ファイルの配置規約: `
  + `一時ファイル・handoff ファイル（staging 用 markdown、断片テキスト等）は worktree 内に作るな。`
  + `mktemp "\${TMPDIR:-/tmp}/implementer-XXXXXX" で worktree 外の $TMPDIR に置くのが原則。`
  + `worktree 内が不可避な場合は .devflow-tmp/ 配下のみに置け（ephemeral として realized-diff から除外されるため、後始末は不要）。`
  + `worktree 直下に *.staged.* / fm_*.txt のような一時ファイルを残すことは禁止`
  + `（git status に混入し realized-diff の実効 shape 誤判定・宣言外変更 concern の原因になる）。\n`
  + EPOCH_INSTRUCTION

// prerun が issue 本文の全文を書くファイル（setup の args は wrapper の LLM が書き写すので本文を載せない）。
// 実装中に書き換えられるので判定系の prompt には渡さない（採点軸は acceptance_criteria）。
export const ISSUE_BODY_FILE = '.devflow-tmp/issue-body.md'

export const IMPL = {
  type: 'object', required: ['status', 'task_id'],
  properties: {
    status: { type: 'string', enum: ['DONE', 'DONE_WITH_CONCERNS', 'BLOCKED', 'NEEDS_CONTEXT'] },
    task_id: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
    concerns: { type: 'array' },
    blocking_reason: {
      type: ['object', 'null'],
      required: ['block_class', 'detail'],
      properties: {
        block_class: { type: 'string', enum: ['approach_mismatch', 'guard_blocked'] },
        detail: { type: 'string' },
        guard_id: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,39}$' },
      },
    },
    missing_context: { type: ['string', 'null'] },
    // PR 本文の見える部分（`<details>` の外）の要約。builder はどの欄も字数で切らない — 上限はここの maxLength /
    // maxItems だけで、超過は schema 検証で implementer に差し戻して何を残すかを選ばせる。
    // 字数は agents/dev-implementer.md の説明と一致させる（pr-artifacts.test.mjs が pin）。
    behavior_changes: { type: 'array', maxItems: 3, items: { type: 'string', maxLength: 100 } },
    review_points: { type: 'array', maxItems: 3, items: { type: 'string', maxLength: 120 } },
    // 「計測して PR 本文に書く」型の AC はここ以外に PR 本文へ届く経路が無い。section の enum は pr-artifacts の
    // PR_NOTE_SECTIONS と同値（import できないため literal）。
    design_decisions: {
      type: 'array',
      items: {
        type: 'object', required: ['title', 'rationale'],
        properties: { title: { type: 'string', maxLength: 40 }, rationale: { type: 'string', maxLength: 75 } },
      },
    },
    pr_notes: {
      type: 'array',
      items: {
        type: 'object', required: ['section', 'text'],
        properties: { section: { type: 'string', enum: ['verification', 'measurement'] }, text: { type: 'string', maxLength: 234 } },
      },
    },
    // maxLength は pr-artifacts の PR_SECTION_HEADING_MAX / PR_SECTIONS_MAX_CHARS と同値（literal の理由は上と同じ）。
    // 合計の上限は schema で表せないため trimPrSectionsIfOver が差し戻す。
    pr_sections: {
      type: 'array',
      items: {
        type: 'object', required: ['heading', 'markdown'],
        properties: { heading: { type: 'string', maxLength: 80 }, markdown: { type: 'string', maxLength: 3000 } },
      },
    },
    // PR 本文と終端サマリーの「この PR に含めなかったもの」に転記する（concerns だけでは人間の目に届かない）。
    out_of_scope: { type: 'array', items: { type: 'string', maxLength: 198 } },
    epoch: { type: 'number' },
  },
}
// failed_files: runValidateLoop が「base でも落ちる既存の失敗」を green 要件から外す材料（省略時は全失敗が green-fix 対象）。
// scripts[].log は同じ tree を判定する eval#N / final-ac-reconcile に渡し、実行済みのテストを evaluator に再実行させない。
// changed_runners（base と違う・base に無い tests/run-*.sh）は Merge tier が test_runner_changed の HOLD に使う。
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
    changed_runners: { type: 'array', items: { type: 'string' } },
    epoch: { type: 'number' },
  },
}
// base-rerun#<iter> の出力: 失敗したテストファイルを base tree で同じように再実行した結果（ファイルごと）。
export const BASE_RERUN = {
  type: 'object', required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object', required: ['file', 'ran', 'base_failed', 'same_failure'],
        properties: {
          file: { type: 'string' }, ran: { type: 'boolean' }, base_failed: { type: 'boolean' },
          same_failure: { type: 'boolean' }, summary: { type: 'string' },
        },
      },
    },
    epoch: { type: 'number' },
  },
}
// TREE_DIFF_LINES: git の stdout 各行の verbatim 転写（validate-diff#<iter> / `git diff --numstat <a> <b>`）。
// required は 'ok' のみ（取得失敗は呼び出し側が fail-open / fail-safe に倒す）。
export const TREE_DIFF_LINES = {
  type: 'object', required: ['ok'],
  properties: { ok: { type: 'boolean' }, lines: { type: 'array', items: { type: 'string' } }, error: { type: 'string' } },
}

// ---- Implement 経路（全 shape で dev-implementer 一本）: issue から単一 task の plan を合成し、1 spawn する。
// 合成 plan（isImplPlan）以外は Implement / Evaluate で受理しない（明示 error）。
export function synthesizeImplPlan(req, issue) {
  const title = String(req?.issue_title ?? `Issue #${issue}`)
  return {
    summary: title,
    serial: [{ id: `issue-${issue}`, desc: title, file_changes: [], test_plan: '', depends_on: [], agent: IMPL_AGENT }],
  }
}
export function isImplTask(t) { return t != null && t.agent === IMPL_AGENT }
export function isImplPlan(p) { return (p?.serial ?? []).some(isImplTask) }
// 返却 files を宣言として取り込み、宣言外監査・realized count・commit scope を同じ材料で動かす（宣言外は evaluator の focus に載る）。
export function adoptReportedFiles(plan, results) {
  if (!isImplPlan(plan)) return plan
  const filesOf = (id) => {
    const out = []
    for (const r of (results ?? [])) {
      if (!r || r.task_id !== id) continue
      for (const f of (r.files ?? [])) if (typeof f === 'string' && f.trim() && !out.includes(f)) out.push(f)
    }
    return out
  }
  const adopt = (t) => isImplTask(t) ? { ...t, file_changes: [...new Set([...(t.file_changes ?? []), ...filesOf(t.id)])] } : t
  return { ...plan, serial: (plan.serial ?? []).map(adopt) }
}

export function implementDrops(plan, results) {
  return Math.max(0, (plan.serial ?? []).length - results.length)
}

/**
 * workflow の実行状態に結び付いた実装 spawn と test ⇄ green-fix ループを作る。worktree / base / repo は Setup で確定した
 * 後に 1 回だけ呼ぶ（test spawn の prompt はここで 1 回だけ組み、全 test spawn で同じ byte 列にする — drift 防止）。
 *
 * @param {{wt: string, issue: string, repo: string|null, base: string, commandsFile: string|null,
 *   spawn: (prompt: string, opts: object) => Promise<unknown>,
 *   spawnFailOpen: (prompt: string, opts: object) => Promise<unknown>,
 *   log: (msg: string) => void,
 *   notes: () => {deletion: string, deps: string, turbopack: string}}} env
 *   commandsFile: Setup で解決したテストコマンドのファイル（run-tests の --commands。dev-flow-test-commands の commands_file）/
 *   spawn: throw を伝播させる spawn（trackedAgent）/ spawnFailOpen: throw を null に落とす spawn（failOpenAgent）/
 *   notes: 実装 spawn prompt に足す注記（呼び出しごとに読む — 削除手段の注記は Implement の途中で決まる）
 */
export function makeImplementLoop({ wt, issue, repo, base, commandsFile, spawn, spawnFailOpen, log, notes }) {
  // 中身は `run-tests start` の stdout 転写だけ（run-tests-prompt）。Turbopack fallback 規約は渡さない — 転写 agent は
  // テストを実行し直さないので判断の余地を持ち込むだけになる。--base は他の diff 系 proxy と同じ origin/<base>。
  const testRunPrompt = runTestsPrompt(wt, `origin/${base}`, commandsFile)
  // commit-hook#<iter>: PR phase の commit と同じ stage 内容に対象 repo の pre-commit hook を回す prompt。
  const hookPrompt = preCommitHookPrompt(wt)

  // start 1 回のあと wait を繰り返す（null・schema 不一致・待機上限は tests:'error'）。start / wait の throw は呼び出し側へ投げ直す。
  function runTestsAgent(label, phase) {
    const opts = { agentType: 'dev-runner-haiku', phase }
    return runTestsJob({
      wt, startPrompt: testRunPrompt, label, schema: GREEN, waitJob: waitBgJob,
      spawn: (prompt, o) => spawn(prompt, { ...opts, ...o }),
      spawnStop: (prompt, o) => spawnFailOpen(prompt, { ...opts, ...o }),
    })
  }

  // issue 本文は ISSUE_BODY_FILE を Read させ AC を直接渡す。全件テスト・red 証明・AC 判定は後段（Validate /
  // redgreen-verify / evaluator）が行うので、手順書型 task・AC テスト契約は渡さない。
  // blocked（BLOCKED 再計画時）: blockSeen 累積の approach_mismatch findings（回帰禁止）と DONE 成果（再実装させない）を付ける。
  function implPrompt(t, { req, fixFeedback, blocked }) {
    const note = notes()
    return `cwd は worktree（${wt}）。cd を前置しない。`
      + `issue #${issue} を計画から実装まで仕上げよ。git add / commit はするな。\n`
      + `task_id: ${t.id}（返却 JSON の task_id にそのまま echo せよ）\n`
      + `repo: ${repo ?? '(unknown)'} / issue: #${issue} ${String(req?.issue_title ?? '')} / worktree: ${wt} / base: ${base}\n`
      + `最初に ${wt}/${ISSUE_BODY_FILE} を Read せよ。issue 本文の全文で、この prompt には載せていない（大きければ offset / limit で分けて末尾まで読め）。\n`
      + `acceptance_criteria（evaluator はこの AC を採点軸にする。全 AC を満たし、各 AC を守るテストを残せ）:\n${JSON.stringify(req?.acceptance_criteria ?? [])}\n`
      + (fixFeedback ? `fix_feedback（Evaluate 差し戻し。各項目を解消）:\n${JSON.stringify(fixFeedback)}\n` : '')
      + (blocked
          ? `前回実装が BLOCKED になった。別アプローチで計画を立て直して実装せよ。\n`
            + (blocked.done.length
                ? `適用済み成果（worktree に既に存在する。再実装するな。残作業のみ実装せよ）:\n${JSON.stringify(blocked.done)}\n`
                : '')
            + `approach_mismatch findings（過去 iteration 全件の累積。**過去に BLOCKED になったいずれのアプローチへの回帰も禁止** — 全件と異なる代替設計を採れ）:\n${JSON.stringify(blocked.findings)}\n`
          : '')
      + note.deletion
      + STAGING_CONVENTION
      + note.deps
      + note.turbopack
  }

  // runImplement: 合成 plan の task（常に 1 件）を spawnFailOpen で spawn する。null は返り値に含めず、drop は implementDrops で数える。
  async function runImplement(req, plan, fixFeedback, tag, blocked) {
    if (!isImplPlan(plan)) throw new Error(`dev-flow: ${tag}: plan に dev-implementer task が無い（合成 plan 以外は受理しない）`)
    const results = []
    let dropped = 0
    for (const t of (plan.serial ?? [])) {
      const r = await spawnFailOpen(implPrompt(t, { req, fixFeedback, blocked }),
        { agentType: IMPL_AGENT, schema: IMPL, label: `${tag}:serial:${t.id}`, phase: 'Implement' })
      if (r) results.push(r)
      else dropped++
    }
    if (dropped) log(`⚠️ ${tag}: dev-implementer ${dropped} 件が失敗(null) — 要確認`)
    return results
  }

  // pr_sections の合計が PR_SECTIONS_MAX_CHARS を超えたら builder で切らず dev-implementer に要約を 1 回差し戻す（PR 本文は
  // 判定文脈に入るので短く保つ）。Evaluate より前に呼ぶ。差し戻し後も超過なら載せる（Closes 欠落は pr_closes_missing が拾う）。
  async function trimPrSectionsIfOver(req, plan, tag) {
    const feedback = prSectionsTrimFeedback(plan)
    if (!feedback) return plan
    log(`⚠️ pr_sections の合計が上限 ${PR_SECTIONS_MAX_CHARS} 字を超過 — dev-implementer へ要約を差し戻す（${tag}）`)
    const results = await runImplement(req, plan, feedback, tag)
    return adoptImplPrNotes(adoptReportedFiles(plan, results), results)
  }

  // 1 行要約欄に日本語を含まない項目があれば dev-implementer に 1 回だけ書き直しを差し戻す。残っても run は止めず警告だけ
  // （言語は AC の充足・HOLD の判定材料ではない）。
  async function rewriteNonJapanesePrBodyItems(req, plan, tag) {
    const feedback = prBodyLanguageFeedback(plan)
    if (!feedback) return plan
    log(`⚠️ PR 本文の項目 ${feedback[0].pr_body_not_japanese.items.length} 件が日本語でない — dev-implementer へ書き直しを差し戻す（${tag}）`)
    const results = await runImplement(req, plan, feedback, tag)
    const next = adoptImplPrNotes(adoptReportedFiles(plan, results), results)
    const left = prBodyLanguageFeedback(next)
    if (left) log(`⚠️ 差し戻し後も PR 本文の項目 ${left[0].pr_body_not_japanese.items.length} 件が日本語でない — 本文に載せたまま進む（${tag}）`)
    return next
  }

  // test ⇄ green-fix ループ（上限 GREEN_MAX）。Validate・empty-diff retry・local-verify / AC コマンドの差し戻し後・post-eval が
  // prompt・break 条件・計上を共有する。tests:'error' / 'no_tests' は green-fix せず break、GREEN_MAX 到達は red のまま返す。tests:'failed' の
  // うち base でも同じく落ちる既存の失敗（triageBaseFailures）は green 要件から外し、そのファイルは触らないよう prompt で伝える。
  // 各回は test の前に pre-commit hook を回す（formatter の書き換えをその回の test が見るため）。exit 非 0 はその回を green に
  // せず green-fix に渡す。hook を起動できない（none / error / null）は fail-open（PR phase の commit が同じ hook を通る）。

  // diff のファイル一覧（base → working tree の tracked 差分 + untracked）を verbatim 転写させる read-only exec-proxy の prompt。
  function validateDiffFilesPrompt() {
    return `次の 2 コマンドをそれぞれ **先頭トークンが git の bare 単文** で 1 回ずつ実行し、両方の stdout の各行（ファイルパス）を`
      + `1 つの配列 lines に一字一句そのまま（要約・整形・並べ替え・件数制限をせず）入れて {"ok": true, "lines": [...]} で返せ`
      + `（stdout が両方空なら {"ok": true, "lines": []}。どちらかが exit 非0・実行不能なら ok:false/error で返せ。失敗時に ok:true を生成してはならない。`
      + `cd 前置・\`bash\` 前置・環境変数代入前置・&& 連結・パイプ・リダイレクトは禁止。-C で worktree を渡しているため cd は不要）:\n`
      + `git -C ${wt} diff --name-only origin/${base}\n`
      + `git -C ${wt} ls-files --others --exclude-standard`
  }

  // 失敗したテストファイルを base tree で同じように再実行させる prompt（worktree は変更させない）。
  function baseRerunPrompt(files) {
    return `Validate のテストで失敗した次のテストファイルが、base（origin/${base}）の tree でも同じように失敗するかを確かめよ。`
      + `worktree のファイルは変更・stage・削除するな（修正もしない）。\n`
      + `対象（repo 相対パス）: ${JSON.stringify(files)}\n`
      + `手順:\n`
      + `1. \`mktemp -d "\${TMPDIR:-/tmp}/devflow-base-XXXXXX"\` を実行し、出力パスを D とする（worktree の外に置く）。\n`
      + `2. \`git -C ${wt} archive --format=tar -o <D>.tar origin/${base}\` を bare 単文で実行し、\`tar -xf <D>.tar -C <D>\` で base tree を D に展開せよ。`
      + `${wt}/node_modules があれば \`ln -s ${wt}/node_modules <D>/node_modules\` で共有せよ。\n`
      + `3. 対象ファイルごとに、そのファイルだけを実行するコマンド（*.bats は bats、*.test.mjs / *.test.ts は repo の test runner 等、repo のテスト規約に合わせる）を決め、`
      + `worktree（${wt}）と D で同じコマンドを 1 回ずつ実行し、それぞれで失敗したテスト名を記録せよ。\n`
      + `4. 対象ファイルごとに {"file": <対象のパス verbatim>, "ran": <worktree と D の両方でテストを実行できたか>, "base_failed": <D で 1 件以上失敗したか>, `
      + `"same_failure": <worktree で失敗したテスト名がすべて D でも失敗したか>, "summary": <失敗したテスト名の要約>} を results に入れて返せ。`
      + `起動失敗・D に当該ファイルが無い・テスト名を比べられない場合は ran:false または same_failure:false とせよ（判断に迷う場合は same_failure:false）。\n`
      + EPOCH_INSTRUCTION
  }

  // 落ちたファイルを diff・base 再実行と突き合わせ、既存の失敗（ENV）と green-fix 対象に分ける。baseFailing は run 内で共有する
  // { env, ran }。failed_files の欠落・取得失敗・再実行の失敗は「ENV なし」に倒す（green 要件を緩めない）。
  async function triageBaseFailures(v, baseFailing, iterLabel, phaseName) {
    const failed = normalizeTestPaths(v.failed_files)
    const evidence = { failedFiles: failed, diffTouched: null }
    if (!failed.length) return { env: [], code: [], evidence }
    const diff = await spawnFailOpen(validateDiffFilesPrompt(),
      { agentType: 'dev-runner-haiku-ro', schema: TREE_DIFF_LINES, label: `validate-diff#${iterLabel}`, phase: phaseName, retryOnContractViolation: true })
    if (diff?.ok !== true || !Array.isArray(diff.lines)) {
      log(`⚠️ ${phaseName}: diff のファイル一覧を取得できず（${diff?.error ?? 'null / schema 不一致'}）— base 再実行をせず失敗はすべて green-fix の対象にする`)
      return { env: [], code: failed, evidence }
    }
    const plan = planBaseRerun({ failedFiles: failed, diffFiles: diff.lines, knownEnv: baseFailing.env, knownBaseRan: baseFailing.ran })
    let env = plan.env
    const code = [...plan.touched, ...plan.code]
    const baseDiffers = [...plan.code]
    if (plan.rerun.length) {
      const br = await spawnFailOpen(baseRerunPrompt(plan.rerun),
        { agentType: 'dev-runner-haiku', schema: BASE_RERUN, label: `base-rerun#${iterLabel}`, phase: phaseName })
      if (!Array.isArray(br?.results)) log(`⚠️ ${phaseName}: base 再実行の結果を取得できず — ${plan.rerun.length} 件は green-fix の対象にする`)
      const cls = classifyBaseRerun(plan.rerun, br?.results)
      env = [...env, ...cls.env]
      code.push(...cls.code)
      for (const f of cls.ran) if (!cls.env.includes(f) && !baseFailing.ran.includes(f)) baseFailing.ran.push(f)
      baseDiffers.push(...cls.ran.filter((f) => !cls.env.includes(f)))
    }
    // diff が触るようになったファイルは既存の失敗から外す（diff と無関係ではなくなった）
    baseFailing.env = baseFailing.env.filter((f) => !plan.touched.includes(f))
    for (const f of env) if (!baseFailing.env.includes(f)) baseFailing.env.push(f)
    log(`${phaseName}: 失敗したテストファイル ${failed.length} 件 — diff が触った ${plan.touched.length} / ${BASE_FAILING_LABEL} ${env.length} / green-fix の対象 ${code.length}`)
    return { env, code, evidence: { failedFiles: failed, diffTouched: plan.touched, baseDiffers, baseSame: env } }
  }

  async function runValidateLoop(kind, { concerns, greenFixIterations, phaseName, baseFailing }) {
    let v = null
    for (let i = 1; i <= GREEN_MAX; i++) {
      const iterLabel = kind ? `${kind}-${i}` : `${i}`
      const testLabel = `test#${iterLabel}`
      const hookLabel = `commit-hook#${iterLabel}`
      const hookRes = await spawnFailOpen(hookPrompt,
        { agentType: 'dev-runner-haiku', schema: PRE_COMMIT_HOOK_SCHEMA, label: hookLabel, phase: phaseName })
      const hookFail = preCommitHookFailure(hookRes)
      if (hookFail) {
        log(`⚠️ ${phaseName}(${hookLabel}): pre-commit hook が exit ${hookFail.exit ?? '?'} で失敗 — この回は green にせず、hook のログのパスを green-fix に渡す`)
      } else if (hookRes?.hook !== 'none' && hookRes?.hook !== 'passed') {
        log(`⚠️ ${phaseName}(${hookLabel}): pre-commit hook の結果を取れず（${hookRes?.hook ?? 'null'}${hookRes?.error ? ': ' + String(hookRes.error).slice(0, 200) : ''}）— green 条件に足さず続行（PR phase の commit が同じ hook を通る）`)
      }
      let raw
      try {
        raw = await runTestsAgent(testLabel, phaseName)
      } catch (e) {
        log(`⚠️ ${phaseName}(${testLabel}): test proxy が throw（${e && e.message ? e.message : e}）— red 扱いで継続（fail-safe。issue #359）`)
        raw = { tests: 'failed', green: false, summary: `test proxy 実行失敗（throw）: ${String(e && e.message ? e.message : e)}` }
      }
      v = raw
      if (kind === 'retry') {
        log(`validate(after empty-diff retry) iteration ${i}: tests=${v.tests} green=${v.green}`)
      } else if (kind === 'post-eval') {
        log(`validate(after Evaluate reimpl) iteration ${i}: tests=${v.tests} green=${v.green}`)
      } else {
        log(`validate iteration ${i}: tests=${v.tests} green=${v.green}`)
      }
      const testsOk = v.green === true
      if (testsOk && !hookFail) break
      if (v.tests === 'error' && !hookFail) {
        // 起動失敗はコード修正で解消しないので green-fix せず break し、merge tier の HOLD に委ねる。hook の失敗は green-fix に回す。
        log(`⚠️ ${phaseName}: tests=error（起動失敗: ${String(v.summary ?? '').slice(0, 200)}）— green-fix をスキップ（環境失敗はコード修正で解消しない。merge tier で HOLD）`)
        break
      }
      if (v.tests === 'no_tests' && !hookFail) {
        // 実行対象のテストが 0 本。通過扱いにせず（green:false のまま）、テストを足すかはコード修正の問題ではないので green-fix にも
        // 回さず break し、merge tier の HOLD（no_tests_run）で人間に開示する。hook の失敗は green-fix に回す。
        log(`⚠️ ${phaseName}: tests=no_tests（実行対象のテストが 0 本）— 通過扱いにせず green-fix もスキップ（テストを 1 本も実行していない。merge tier で HOLD）`)
        break
      }
      // green-fix に直させるテストの失敗があるか（起動失敗・テスト 0 本・既存の失敗だけなら hook の失敗だけを渡す）
      let testsToFix = !testsOk && v.tests !== 'error' && v.tests !== 'no_tests'
      let envNote = ''
      if (v.tests === 'failed') {
        const tri = await triageBaseFailures(v, baseFailing, iterLabel, phaseName)
        v = { ...v, red_evidence: tri.evidence }
        if (tri.env.length && !tri.code.length) {
          if (!hookFail) {
            log(`${phaseName}: 失敗はすべて diff と無関係で base でも同じように落ちる ${BASE_FAILING_LABEL}（${tri.env.join(', ')}）— ENV 項目として green 要件から外し green-fix を起動しない`)
            v = { ...v, green: true }
            break
          }
          testsToFix = false
        }
        if (tri.env.length) {
          envNote = `次のテストファイルの失敗は diff と無関係で base でも同じように落ちる${BASE_FAILING_LABEL}で、green 要件から外した。修正対象外 — 触るな: ${JSON.stringify(tri.env)}\n`
        }
      }
      if (hookFail) v = { ...v, green: false }
      if (i === GREEN_MAX) {
        if (kind === 'retry') {
          log(`⚠️ empty-diff gate 後の再 validate: ${GREEN_MAX} 回試行しても test green にならず — Evaluate へ（human review 想定）`)
        } else if (kind === 'post-eval') {
          log(`⚠️ Evaluate 差し戻し後の再 validate: ${GREEN_MAX} 回試行しても test green にならず — PR へ（human review 想定）`)
        } else {
          log(`⚠️ ${GREEN_MAX} 回試行しても test green にならず — Evaluate へ（human review 想定）`)
        }
        break
      }
      const note = notes()
      const gfResult = await spawn(
        `cwd は worktree（${wt}）。cd を前置しない。${testsToFix ? 'テスト' : 'pre-commit hook'}が失敗している。原因を分析して実装/テストを修正し`
        + `green を目指せ。共有 worktree のため無関係ファイルは触るな。git add / commit はするな。\n`
        + `**禁止**: テストの期待値・assert を弱めて green にすることは禁止（テスト弱体化）。`
        + `テスト側を修正してよいのはテスト自体の誤り（誤った期待値・環境依存・typo）に根拠を示せる場合のみで、その根拠を summary に明記せよ。\n`
        + (testsToFix ? `失敗内容: ${v.summary ?? '(詳細はテスト出力を確認)'}\n` : '')
        + envNote
        + (hookFail ? preCommitHookFixNote(hookFail) : '')
        + `task_id: issue-${issue}（返却 JSON の task_id にそのまま echo せよ）\n`
        + note.deletion
        + STAGING_CONVENTION
        + note.turbopack,
        { agentType: IMPL_AGENT, model: GREEN_FIX_MODEL, schema: IMPL, label: `green-fix#${iterLabel}`, phase: phaseName },
      )
      // green-fix の concerns を evaluator focus_areas へ伝搬（retry 経路も同一）
      if (gfResult && Array.isArray(gfResult.concerns)) concerns.push(...gfResult.concerns)
      greenFixIterations.push({ files: gfResult?.files ?? [], summary: gfResult?.summary ?? '' })
    }
    return v
  }

  return { implPrompt, runImplement, trimPrSectionsIfOver, rewriteNonJapanesePrBodyItems, runValidateLoop }
}
