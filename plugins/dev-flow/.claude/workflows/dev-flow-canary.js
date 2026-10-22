export const meta = {
  name: 'dev-flow-canary',
  description: 'dev-flow harness capability の read-only canary: schema付きagent/parallel/pipeline/nested workflow/model・effort routing（agent() opts の effort 受理 probe・cwd 適用 probe を含む）/pause・resume/direct fs・shell・import を pass/fail/unsupported で構造化出力。repo/git/GitHub state 不変。bridge 撤去は行わない（report のみ）。結果は report_path の JSON を直近世代と比べて読む',
  phases: [
    { title: 'Probe' },
    { title: 'Agents' },
    { title: 'Nested' },
    { title: 'Report' },
  ],
}

// dev-flow-canary は self-contained workflow（tools/sync-inlines.mjs による _lib inline 生成を使わない）。
// 検証対象そのものが inline bridge であるため、bridge に依存しない独立実装が診断の独立性を保つ
// （AGENTS.md「canary は self-contained な workflow ファイルとして実装」参照）。
//
// read-only 保証（AC1）: このファイルには mutating な git 操作（commit・push・add・worktree 作成等）・gh コマンドを一切含めない。
// 全 probe / model-report / parallel echo は dev-runner-haiku-ro（read-only exec-proxy）へ委譲し、
// report 書き出しのみ dev-runner-haiku の Write tool（repo 外 ~/.claude/logs への単一ファイル書き込み）を使う。
//
// agentType は `dev-flow:` 付きの namespaced id を直接書く。他 3 workflow は _lib/agent-namespace.mjs の
// nsAgentOpts() を inline して付与するが、canary は上記のとおり inline bridge 非依存を保つため
// 共有ヘルパを使わない（bridge が壊れたときに canary も道連れで観測不能になるのを避ける）。

// ---- Schemas ----------------------------------------------------------------------------------

const VERSION_PROBE = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    version: { type: 'string' },
    timestamp_utc: { type: 'string' },
    epoch: { type: 'string' },
  },
  required: ['ok', 'version'],
}

const MODEL_REPORT = {
  type: 'object',
  properties: {
    model_id: { type: 'string' },
    effort_visible: { type: 'boolean' },
    effort: { type: 'string' },
  },
  required: ['model_id'],
}

const ECHO = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    token: { type: 'string' },
  },
  required: ['ok', 'token'],
}

const CWD_REPORT = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    cwd: { type: 'string' },
  },
  required: ['ok', 'cwd'],
}

const WRITE_RESULT = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    path: { type: 'string' },
  },
  required: ['ok'],
}

// ---- direct capability probes（副作用ゼロ。すべて関数内に閉じる — top-level require/Date.now lint 回避）------

function probeRequireModule(moduleId, capLabel) {
  if (typeof require !== 'function') {
    return {
      status: 'unsupported',
      detail: `require が workflow runtime に公開されていない — ${capLabel} は probe 不能（module ロード自体は試みていない）`,
    }
  }
  try {
    require(moduleId)
    return {
      status: 'pass',
      detail: `require('${moduleId}') 成功 — ${capLabel} は module ロード可能`,
    }
  } catch (e) {
    return {
      status: 'fail',
      detail: `require('${moduleId}') が存在するが失敗: ${e?.message ?? String(e)}`,
    }
  }
}

// harness は dynamic import 式を含む workflow script を **parse 時に** 拒否する
// (`SyntaxError: import() is not available in workflow scripts` で workflow 全体が起動不能。
// 2026-08-18 実測。2026-08-04 の canary は runtime throw で `unsupported` を返せていた)。
// したがって probe 本体に import 式を書けない — 書いた瞬間 canary 自身が起動不能になり、
// direct_import だけでなく全 capability が観測不能になる。probe は globalThis に露出した
// module ローダの有無だけを見る (probePauseResume と同じ idiom)。
function probeDirectImport() {
  const candidates = ['dynamicImport', 'importModule', 'loadModule']
  const present = candidates.filter((name) => typeof globalThis[name] === 'function')
  if (typeof globalThis.import === 'function') present.push('import')
  if (present.length > 0) {
    return {
      status: 'pass',
      detail: `dynamic import API present (${present.join(', ')}) — workflow から module ロード可能`,
    }
  }
  return {
    status: 'unsupported',
    detail:
      'dynamic import 不可: import 式は parse 時に拒否され script 全体が起動不能になり、globalThis にも module ローダ相当の関数は無い。解禁検知は import 式 1 行を workflow に足して起動できるかで行う',
  }
}

function probePauseResume() {
  const candidates = ['pause', 'resume', 'checkpoint', 'suspend']
  const present = candidates.filter((name) => typeof globalThis[name] === 'function')
  if (present.length > 0) {
    return {
      status: 'pass',
      detail: `API present (${present.join(', ')}) — not invoked to avoid suspending canary; 実 suspend 検証は不能`,
    }
  }
  return {
    status: 'unsupported',
    detail: 'no pause/resume API exposed to workflow runtime — resume cache は同一 session 内から観測不能',
  }
}

function probeDirectCapabilities() {
  return {
    direct_fs: probeRequireModule('node:fs', 'direct_fs'),
    direct_shell: probeRequireModule('node:child_process', 'direct_shell'),
    pause_resume: probePauseResume(),
  }
}

// ---- agent prompt builders（必須5要素: Objective/Output format/Tools/Boundary/Token cap）--------------------

function versionProbePrompt() {
  return [
    '## Objective',
    'Claude Code の CLI version 文字列・現在時刻（UTC）・現在時刻の UNIX epoch 秒を取得する。',
    '',
    '## Output format',
    'JSON: {"ok": boolean, "version": string, "timestamp_utc": string, "epoch": string}。'
    + ' version は `claude --version` の生出力、timestamp_utc は `date -u +%Y-%m-%dT%H:%M:%SZ` の生出力、'
    + ' epoch は `date +%s` の生出力を、それぞれ verbatim で入れる。',
    '',
    '## Tools',
    '実行してよいコマンドは次の3つのみ: `claude --version`・`date -u +%Y-%m-%dT%H:%M:%SZ`・`date +%s`。'
    + ' それぞれ独立した単文として実行する（&& 等での連結禁止）。他のコマンドは一切実行しない。',
    '',
    '## Boundary',
    'ファイル書き込み・git 操作・gh コマンドは禁止。read-only probe のみ。',
    '',
    '## Token cap',
    '出力は schema フィールドのみ。説明文は不要。',
  ].join('\n')
}

function modelReportPrompt() {
  return [
    '## Objective',
    'ツールを一切使わず、自分の system prompt から model ID と effort 設定の可視性を報告する。',
    '',
    '## Output format',
    'JSON: {"model_id": string, "effort_visible": boolean, "effort"?: string}。'
    + ' model_id は system prompt 中の "The exact model ID is ..." の値を verbatim で返す。'
    + ' effort 設定値が system prompt から確認できる場合のみ effort_visible:true と effort を返し、'
    + ' 確認できなければ effort_visible:false のみ返す。',
    '',
    '## Tools',
    'ツール不使用（Bash/Read 等は呼ばない）。system prompt の自己観測のみ。',
    '',
    '## Boundary',
    'ファイル変更・git/gh 操作は禁止。',
    '',
    '## Token cap',
    '出力は schema フィールドのみ。',
  ].join('\n')
}

function echoPrompt(token) {
  return [
    '## Objective',
    `ツールを一切使わず、固定トークン "${token}" をそのまま echo する。`,
    '',
    '## Output format',
    `JSON: {"ok": true, "token": "${token}"}`,
    '',
    '## Tools',
    'ツール不使用。',
    '',
    '## Boundary',
    'ファイル変更・git/gh 操作は禁止。',
    '',
    '## Token cap',
    '出力は schema フィールドのみ。',
  ].join('\n')
}

function cwdReportPrompt() {
  return [
    '## Objective',
    '自分の作業ディレクトリ（Bash tool がコマンドを実行するディレクトリ）を報告する。',
    '',
    '## Output format',
    'JSON: {"ok": boolean, "cwd": string}。cwd は `pwd` の生出力を verbatim で入れる（末尾改行は除く）。',
    '',
    '## Tools',
    '実行してよいコマンドは `pwd` の1つのみ（単文。cd 等の前置・連結禁止）。他のコマンド・他の tool は一切使わない。',
    '',
    '## Boundary',
    'ファイルの作成・変更・git 操作・gh コマンドは禁止。read-only probe のみ。',
    '',
    '## Token cap',
    '出力は schema フィールドのみ。',
  ].join('\n')
}

function reportWritePrompt(report, targetPath) {
  const json = JSON.stringify(report, null, 2)
  return [
    '## Objective',
    `下記 JSON 内容を Write tool で ${targetPath} へ単一ファイルとして書き込み、Write tool が報告した絶対パス（~ 展開後）を返す。`,
    '',
    '## Output format',
    'JSON: {"ok": boolean, "path": string}。path は Write tool が書き込んだファイルの絶対パス（~ を展開した実パス）。',
    '',
    '## Tools',
    'Write tool のみ。Bash・他 tool は使用禁止（親ディレクトリは Write tool が自動作成するため mkdir 不要）。',
    '',
    '## Boundary',
    `指定パス（${targetPath}）以外への書き込み・repo 内への書き込み・git/gh 操作は一切禁止。`,
    '',
    '## Token cap',
    '出力は schema フィールドのみ。',
    '',
    '## 書き込み内容（verbatim）',
    json,
  ].join('\n')
}

// ============================================================
// Phase: Probe
// ============================================================

phase('Probe')
log('dev-flow-canary: harness capability probe を開始（read-only, repo/git/GitHub state 不変）')

const direct = probeDirectCapabilities()
const directImport = probeDirectImport()

const versionProbe = await agent(
  versionProbePrompt(),
  { agentType: 'dev-flow:dev-runner-haiku-ro', schema: VERSION_PROBE, label: 'canary:version', phase: 'Probe' },
)
const claudeCodeVersion = (versionProbe && versionProbe.ok !== false && typeof versionProbe.version === 'string')
  ? versionProbe.version
  : 'unknown'
const timestampUtc = (versionProbe && versionProbe.ok !== false && typeof versionProbe.timestamp_utc === 'string')
  ? versionProbe.timestamp_utc
  : 'unknown'
if (claudeCodeVersion === 'unknown') {
  log('⚠️ version probe が null/ok:false — claude_code_version=unknown（fail-open、throw しない）')
}

const epochStr = (versionProbe && versionProbe.ok !== false && versionProbe.epoch != null)
  ? String(versionProbe.epoch).trim()
  : ''
const epochValid = /^\d+$/.test(epochStr)
if (!epochValid) {
  log('⚠️ version probe から epoch を取得できず canary report の書き出しを skip（fail-open） — report_path=null')
}

// ============================================================
// Phase: Agents
// ============================================================

phase('Agents')
log('agent schema / model routing / effort routing / parallel fanout を probe する')

const modelReport = await agent(
  modelReportPrompt(),
  { agentType: 'dev-flow:dev-runner-haiku-ro', schema: MODEL_REPORT, label: 'canary:model-report', phase: 'Agents' },
)

const agentSchema = (modelReport != null && typeof modelReport.model_id === 'string')
  ? { status: 'pass', detail: 'schema-constrained agent が model_id 付き object を返した' }
  : { status: 'fail', detail: 'schema-constrained agent returned null' }

const modelId = modelReport?.model_id ?? ''
const modelRouting = /haiku/i.test(modelId)
  ? { status: 'pass', detail: `model_id=${modelId}（dev-runner-haiku-ro frontmatter の model:haiku が適用されている証拠）` }
  : { status: 'fail', detail: `model_id=${modelId || '<none>'}（haiku 系 model_id を期待したが一致しない）` }

const effortRouting = modelReport?.effort_visible === true
  ? { status: 'pass', detail: `effort=${modelReport.effort}` }
  : { status: 'unsupported', detail: 'effort は subagent の system prompt から観測不能 — frontmatter effort の適用は runtime 非公開' }

// agent() opts 受理 probe（issue #556）: opts に effort:'low' を渡し throw の有無だけを見る。
// 受理されたことしか判定できない — 実際に effort が適用されたかは runtime 非公開で未検証
// （effort_routing が unsupported のとおり）。適用可否の再判定はこの probe の結果と
// effort_routing を併読して行う。
let agentOptsEffortAccepted
try {
  const optsProbe = await agent(
    echoPrompt('EFFORT-OPTS'),
    { agentType: 'dev-flow:dev-runner-haiku-ro', schema: ECHO, label: 'canary:effort-opts', phase: 'Agents', effort: 'low' },
  )
  agentOptsEffortAccepted = {
    status: 'pass',
    detail: `agent() opts の effort:'low' が throw されず受理された（応答: ${JSON.stringify(optsProbe)}）。受理されたことしか判定できない — effort が実際に適用されたかは未検証（runtime 非公開）`,
  }
} catch (e) {
  agentOptsEffortAccepted = { status: 'unsupported', detail: `agent() が opts.effort 指定で throw: ${e?.message ?? String(e)} — opts 経由の effort 指定は現 harness で受理されない` }
}

// agent() opts.cwd probe（issue #1070）: repo 外の一時ディレクトリを opts.cwd に渡して 1 回 spawn し、
// agent が `pwd` で報告した作業ディレクトリが渡した値と一致するかを見る。throw は unsupported、
// throw せず無視された（既定 cwd のまま）場合は fail。canary は read-only のため一時ディレクトリを
// 作らず、どの環境にも在る /tmp を使う。macOS の /tmp は /private/tmp への symlink で pwd が実パスを
// 返し得るため、'/private' 前置の値も一致とみなす。
const CWD_PROBE_DIR = '/tmp'
let agentOptsCwdApplied
try {
  const cwdProbe = await agent(
    cwdReportPrompt(),
    { agentType: 'dev-flow:dev-runner-haiku-ro', schema: CWD_REPORT, label: 'canary:agent-cwd', phase: 'Agents', cwd: CWD_PROBE_DIR },
  )
  const reportedCwd = typeof cwdProbe?.cwd === 'string' ? cwdProbe.cwd.trim() : null
  agentOptsCwdApplied = (reportedCwd === CWD_PROBE_DIR || reportedCwd === '/private' + CWD_PROBE_DIR)
    ? { status: 'pass', detail: `agent() opts.cwd='${CWD_PROBE_DIR}' で spawn した agent の作業ディレクトリが一致（報告: ${reportedCwd}）` }
    : { status: 'fail', detail: `agent() は opts.cwd='${CWD_PROBE_DIR}' で throw しなかったが、agent の作業ディレクトリが一致しない（応答: ${JSON.stringify(cwdProbe)}）— opts.cwd は無視されたか別名で受け付けられている` }
} catch (e) {
  agentOptsCwdApplied = { status: 'unsupported', detail: `agent() が opts.cwd 指定で throw: ${e?.message ?? String(e)} — opts 経由の cwd 指定は現 harness で受理されない` }
}

const parTokens = ['A', 'B']
const parThunks = parTokens.map((t) => () => agent(
  echoPrompt(t),
  { agentType: 'dev-flow:dev-runner-haiku-ro', schema: ECHO, label: `canary:par:${t}`, phase: 'Agents' },
))
const parResults = await parallel(parThunks)
const parallelOk = Array.isArray(parResults)
  && parResults.length === parTokens.length
  && parTokens.every((t, i) => parResults[i]?.ok === true && parResults[i]?.token === t)
const parallelFanout = parallelOk
  ? { status: 'pass', detail: `parallel([A,B]) 結果一致: ${JSON.stringify(parResults)}` }
  : { status: 'fail', detail: `parallel() 結果不一致/欠落: ${JSON.stringify(parResults)}` }

// pipeline() probe（issue #560 — #332 AC-1 の判断材料。read-only、observation のみ）
let pipelineFanout
let pipelineFailureSemantics
if (typeof pipeline === 'undefined') {
  pipelineFanout = { status: 'unsupported', detail: 'pipeline は workflow runtime に定義されていない（typeof pipeline === \'undefined\'）— fan-out probe 不能。bare 参照は ReferenceError で canary 全体が落ちるため typeof ガードのみで判定' }
  pipelineFailureSemantics = { status: 'unsupported', detail: 'pipeline 未定義のため null item / callback throw の failure semantics は観測不能' }
} else {
  // fan-out: 入力 ['A','B'] と結果の入力順対応（agent 呼び出し 2 回）
  try {
    const pipeTokens = ['A', 'B']
    const pipeResults = await pipeline(pipeTokens, (t) => agent(
      echoPrompt(t),
      { agentType: 'dev-flow:dev-runner-haiku-ro', schema: ECHO, label: `canary:pipe:${t}`, phase: 'Agents' },
    ))
    const pipeOk = Array.isArray(pipeResults)
      && pipeResults.length === pipeTokens.length
      && pipeTokens.every((t, i) => pipeResults[i]?.ok === true && pipeResults[i]?.token === t)
    pipelineFanout = pipeOk
      ? { status: 'pass', detail: `pipeline(['A','B'], cb) の結果が入力順に対応: ${JSON.stringify(pipeResults)}` }
      : { status: 'fail', detail: `pipeline() 結果の順序ずれ/欠落: ${JSON.stringify(pipeResults)}` }
  } catch (e) {
    pipelineFanout = { status: 'fail', detail: `pipeline() が happy-path fan-out で throw: ${e?.message ?? String(e)}` }
  }
  // failure semantics: (a) item が null を返す（agent 1 回） (b) callback が throw（agent 0 回）
  let nullDetail
  try {
    const nullResults = await pipeline(['N'], async (t) => {
      await agent(
        echoPrompt(t),
        { agentType: 'dev-flow:dev-runner-haiku-ro', schema: ECHO, label: 'canary:pipe:null', phase: 'Agents' },
      )
      return null
    })
    nullDetail = `null item: pipeline() は reject せず resolve — 結果=${JSON.stringify(nullResults)}`
  } catch (e) {
    nullDetail = `null item: pipeline() が reject — ${e?.message ?? String(e)}`
  }
  let throwDetail
  try {
    const throwResults = await pipeline(['T'], () => {
      throw new Error('canary-pipe-throw')
    })
    throwDetail = `callback throw: pipeline() は reject せず resolve — 結果=${JSON.stringify(throwResults)}`
  } catch (e) {
    throwDetail = `callback throw: pipeline() が reject — ${e?.message ?? String(e)}`
  }
  pipelineFailureSemantics = { status: 'pass', detail: `両条件を観測（canary は abort していない）。${nullDetail} / ${throwDetail}` }
}

// ============================================================
// Phase: Nested
// ============================================================

phase('Nested')
log('nested workflow（1段）を probe する')

let nestedWorkflow
try {
  const child = await workflow('dev-flow:dev-flow-canary-child', { token: 'canary-nested-probe' })
  if (child?.child_ok === true && child?.echo === 'canary-nested-probe') {
    nestedWorkflow = { status: 'pass', detail: 'workflow() nested 1段呼び出しが期待 shape を返した' }
  } else {
    nestedWorkflow = { status: 'fail', detail: `nested workflow の戻り値が期待 shape と不一致: ${JSON.stringify(child)}` }
  }
} catch (e) {
  nestedWorkflow = { status: 'unsupported', detail: `workflow() threw: ${e?.message ?? String(e)}` }
}

// ============================================================
// Phase: Report
// ============================================================

phase('Report')
log('capability report を組み立てる')

const capabilities = [
  { id: 'agent_schema', ...agentSchema },
  { id: 'model_routing', ...modelRouting },
  { id: 'effort_routing', ...effortRouting },
  { id: 'agent_opts_effort_accepted', ...agentOptsEffortAccepted },
  { id: 'agent_opts_cwd_applied', ...agentOptsCwdApplied },
  { id: 'parallel_fanout', ...parallelFanout },
  { id: 'pipeline_fanout', ...pipelineFanout },
  { id: 'pipeline_failure_semantics', ...pipelineFailureSemantics },
  { id: 'nested_workflow', ...nestedWorkflow },
  { id: 'pause_resume', ...direct.pause_resume },
  { id: 'direct_fs', ...direct.direct_fs },
  { id: 'direct_shell', ...direct.direct_shell },
  { id: 'direct_import', ...directImport },
]

const execProxyRemovable = direct.direct_fs.status === 'pass' && direct.direct_shell.status === 'pass'
const inlineGeneratorRemovable = directImport.status === 'pass'
const bridgeVerdict = (execProxyRemovable && inlineGeneratorRemovable) ? 'reevaluate-bridges' : 'keep-bridges'

const report = {
  canary_version: '1.2.0',
  claude_code_version: claudeCodeVersion,
  timestamp_utc: timestampUtc,
  capabilities,
  bridge_sunset: {
    exec_proxy_removable: execProxyRemovable,
    inline_generator_removable: inlineGeneratorRemovable,
    verdict: bridgeVerdict,
    note: 'capability report only — bridge 撤去は別 issue + human review でのみ実施',
  },
  report_path: null,
}

if (epochValid) {
  const targetPath = '~/.claude/logs/dev-flow-canary/canary-' + epochStr + '.json'
  const writeResult = await agent(
    reportWritePrompt(report, targetPath),
    { agentType: 'dev-flow:dev-runner-haiku', schema: WRITE_RESULT, label: 'canary:report-write', phase: 'Report' },
  )
  const expectedSuffix = '/.claude/logs/dev-flow-canary/canary-' + epochStr + '.json'
  report.report_path = (writeResult && writeResult.ok === true && typeof writeResult.path === 'string' && writeResult.path.endsWith(expectedSuffix))
    ? writeResult.path
    : null
  if (report.report_path === null) {
    const suffixNote = (writeResult && typeof writeResult.path === 'string' && !writeResult.path.endsWith(expectedSuffix))
      ? `申告 path が期待 suffix (${expectedSuffix}) と不一致: ${writeResult.path}`
      : `write agent 応答: ${JSON.stringify(writeResult)}`
    log(`⚠️ canary report の書き出しに失敗（fail-open） — report_path=null。${suffixNote}。今回の結果は log だけに残る`)
  }
} else {
  report.report_path = null
}

const passCount = capabilities.filter((c) => c.status === 'pass').length
const failCount = capabilities.filter((c) => c.status === 'fail').length
const unsupportedCount = capabilities.filter((c) => c.status === 'unsupported').length
log(
  `dev-flow-canary summary: claude_code_version=${claudeCodeVersion} `
  + `pass=${passCount} fail=${failCount} unsupported=${unsupportedCount} `
  + `bridge_verdict=${bridgeVerdict} report_path=${report.report_path ?? 'null'}`,
)

return report
