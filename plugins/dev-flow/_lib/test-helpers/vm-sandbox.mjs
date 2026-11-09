/**
 * vm-sandbox.mjs — VM sandbox ハーネス共有モジュール
 *
 * workflow を VM で実行する routing test の共有ヘルパー。
 * 差分（agentStub の返り値ロジック）は呼び出し側の responder 関数に委譲する。
 *
 * Export:
 *   - JS_GLOBALS: VM sandbox に expose する 15 個の JS 組み込みをまとめた object
 *   - DEV_FLOW_STAGE_WORKFLOWS / chainStageWorkflows(stub, host): dev-flow.js が workflow() で起動する工程の workflow
 *     （dev-flow-test-commands.js / dev-flow-evaluate.js / dev-flow-finalize.js）を stub にせず同じ agent / log / phase で実行する
 *     workflow()。単体起動の pr-iterate.js が起動する dev-flow-test-commands.js も同じく実行する。
 *     makeRecordingSandbox と makeWorkflowContext は既定でこれを使い、親と工程の workflow をつないで実行する（pr-iterate は stub のまま）
 *   - makeRecordingSandbox(responder, extraSandbox?): {ctx, calls, logs, phases} を返す
 *     （calls の各要素は {label, agentType, prompt, opts, schema}。opts は agent() に渡された
 *     opts をそのまま、schema は opts?.schema ?? null）
 *   - devFlowArgs(issue?, setupOverrides?): dev-flow.js 用 args の既定形（{issue, setup}）を返す
 *     （setup は dev-flow-prerun の stdout JSON と同形。setup.analyze は prerunAnalyze() の既定）
 *   - prerunAnalyze(overrides?): dev-flow-prerun の analyze 段（prerun-analyze.sh）の ok:true 出力を組み立てる
 *     （AC 2 件 / type fix / breaking なし / comment なし → analyze ゲートは analyze-clarify を spawn せず通過）。
 *     REQ を変えたい test は devFlowArgs(issue, { analyze: prerunAnalyze({...}) }) を extra.args に渡す
 *   - analyzeArgs(issue?, analyzeOverrides?): 上記の薄い wrapper（args 全体を返す）
 *   - acObservationalResponse(observational, extra?): 分類 agent（label 'ac-observational#N'）の応答を AC ごとの
 *     観測型判定の配列から組み立てる（extra[i] は AC ごとの verify_command_index / expect_path_indexes の上書き）
 *   - acObservationalPromptIndexes(prompt): 分類 agent の prompt に載った AC の ac_index 一覧
 *   - acObservationalNone(prompt): 分類 agent の既定応答（prompt に載った全 AC を観測型でない・検証コマンドなし）。
 *     独自の responder を持つ test は label 'ac-observational#N' にこれを返す
 *   - makeWorkflowContext(sandbox): 独自の agent stub を持つ test 用の VM context を作る
 *   - runDevFlowInSandbox(src, ctx): dev-flow.js ソースを strip して sandbox 実行する
 *   - runWorkflowCapture(src, ctx, filename?): strip + wrap + vm 実行し {result, error} を返す
 *     （dev-flow.js / pr-iterate.js 共用。filename 既定は '.claude/workflows/dev-flow.js'）
 *   - assertNoCrash(error, name): error が ReferenceError/SyntaxError なら assert.fail する
 *   - mergeTierFacts(overrides?): Merge tier 統合 exec-proxy（label 'merge-tier-facts'）の応答を組み立てる
 *   - TEST_COMMANDS_FILE / testCommandsPrepareResponse(overrides?): test-commands-prepare（label 'resolve-test-commands'）の
 *     応答。既定は base の tree に tests/run-*.sh がある repo（source 'runners'。resolver を起動しない）
 *   - devFlowResponder(overrides?, {issue?}?): dev-flow.js 標準経路（shape 'standard'）の既定 responder
 *   - STANDARD_FILES / COMPLEX_FILES / MICRO_FILES: 実効 shape を realized file 数で倒すための files 一覧
 *     （danger-grep と dev-implementer の両 stub に同じ一覧を渡すと宣言外 0 件で shape だけが変わる）
 *   - shapeOverrides('micro'|'complex'): 上記を impl / reimpl#1..2 / danger-grep（+ micro は ci-check-lite）の
 *     override にまとめたもの。既定（override なし）は standard
 *   - PORCELAIN_BASELINE_DIGEST / porcelainBaselineResponse(digest?) / porcelainVerdictResponse(lines, baseline?, o?):
 *     pr-iterate の porcelain-verdict（fix-baseline#i / commit-ensure-status#i / worktree-dirty-check）の stdout と同形の応答
 *   - prIterateResponder(overrides?): pr-iterate.js 単体起動の既定 responder
 *   - makeDevFlowSandbox({overrides?, issue?, workflow?, extra?}?): devFlowResponder を使った
 *     makeRecordingSandbox の薄い wrapper
 *   - prIterateRounds({reviewer?, fix?, ci?, commitEnsure?}?): pr-iterate の round 系 call に呼び出し順で
 *     応答する関数（makePrIterateSandbox の rounds に渡す）
 *   - makePrIterateSandbox({overrides?, rounds?, args?, extra?}?): prIterateResponder を使った
 *     makeRecordingSandbox の薄い wrapper
 */

import vm from 'node:vm';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { porcelainVerdict } from '../porcelain-verdict.mjs';

// ============================================================
// JS_GLOBALS: VM sandbox に expose する JS 組み込み 15 個
// ============================================================

export const JS_GLOBALS = {
  console,
  JSON,
  Math,
  String,
  Number,
  Boolean,
  Array,
  Object,
  Error,
  RegExp,
  Promise,
  Symbol,
  Map,
  Set,
  Date,
};

// ============================================================
// 工程の workflow: dev-flow.js が workflow() で起動する子を同じ agent stub で実行する
// ============================================================

const WORKFLOWS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.claude', 'workflows');

/** dev-flow.js が workflow() で起動する工程の workflow（起動名 → ファイル名）。pr-iterate は test の stub に任せる。 */
export const DEV_FLOW_STAGE_WORKFLOWS = {
  'dev-flow:dev-flow-test-commands-run': 'dev-flow-test-commands.js',
  'dev-flow:dev-flow-evaluate-run': 'dev-flow-evaluate.js',
  'dev-flow:dev-flow-finalize-run': 'dev-flow-finalize.js',
};

/**
 * 工程の workflow を親と同じ agent / log / phase で実行する workflow() を返す。工程以外の起動名（pr-iterate）は stub に渡す。
 * 引数は JSON で複製して渡す（子が親の object を共有して動く前提を持ち込まない）。子の workflow() は 2 段目のネストなので throw する。
 * 子の throw はそのまま親の workflow() の throw になる。
 *
 * @param {Function} stub - 工程以外の workflow() の stub
 * @param {{agent: Function, log: Function, phase: Function}} host - 子に渡す agent / log / phase を持つ object（呼び出し時に読む）
 * @returns {(name: string, wargs: unknown) => Promise<unknown>}
 */
export function chainStageWorkflows(stub, host) {
  return async (name, wargs) => {
    const file = DEV_FLOW_STAGE_WORKFLOWS[name];
    if (!file) return stub(name, wargs);
    const ctx = vm.createContext({
      ...JS_GLOBALS,
      agent: (prompt, opts) => host.agent(prompt, opts),
      log: (m) => host.log(m),
      phase: (t) => host.phase(t),
      workflow: async (n) => { throw new Error(`workflow('${n}'): 工程の workflow からの workflow() はネスト 2 段で起動できない`); },
      args: JSON.parse(JSON.stringify(wargs)),
    });
    const { result, error } = await runWorkflowCapture(readFileSync(join(WORKFLOWS_DIR, file), 'utf8'), ctx, `.claude/workflows/${file}`);
    if (error) throw error;
    return result;
  };
}

// ============================================================
// prerunAnalyze: dev-flow-prerun の analyze 段（prerun-analyze.sh）の ok:true 出力
// ============================================================

/**
 * dev-flow-prerun の analyze 段の出力（args.setup.analyze）を返す。
 * 既定は contract 経路（AC ['a','b'] / issue_type 'fix' / breaking なし / comment なし / uncertain 空）で、
 * dev-flow.js の analyze ゲートは analyze-clarify を spawn せずに通過する（観測型の判定は通過後の分類 agent
 * ac-observational#N が行う。既定 responder は全 AC false を返す — devFlowResponder 参照）。
 *
 * @param {Record<string, unknown>} [overrides={}]
 */
export function prerunAnalyze(overrides = {}) {
  return {
    ok: true, analyze_path: 'contract', jev_reasons: [],
    issue_title: 'stub-issue-title', issue_type: 'fix', acceptance_criteria: ['a', 'b'],
    breaking_keyword_scan: false, breaking_change: false, breaking_evidence: '',
    comment_count: 0, comment_overrides: [], comment_conflicts: [], uncertain: [], blockers: [],
    contract: 't1', ac_heading_near_miss: [], duration_seconds: 5,
    ...overrides,
  };
}

// ============================================================
// acObservationalResponse: 分類 agent（ac-observational#N）の応答
// ============================================================

/**
 * 分類 agent の応答 {results} を AC ごとの観測型判定（true / false / null）の配列から組み立てる。
 * verify_command_index は null、expect_path_indexes は []。extra[i] があればその AC の項目に重ねる。
 *
 * @param {Array<boolean|null>} observational
 * @param {Record<number, Record<string, unknown>>} [extra={}]
 */
export function acObservationalResponse(observational, extra = {}) {
  return { results: observational.map((o, i) => ({ ac_index: i, observational: o, verify_command_index: null, expect_path_indexes: [], ...(extra[i] ?? {}) })) };
}

/** 分類 agent の prompt（acObservationalPrompt）に載る AC の ac_index 一覧。 */
export function acObservationalPromptIndexes(prompt) {
  const m = String(prompt).match(/^AC（ac_index は 0 始まり）: (.*)$/m);
  return m ? JSON.parse(m[1]).map((it) => it.ac_index) : [];
}

/** 分類 agent の既定応答: prompt に載った全 AC を観測型でない（false）・検証コマンドなしと返す。 */
export function acObservationalNone(prompt) {
  return { results: acObservationalPromptIndexes(prompt).map((i) => ({ ac_index: i, observational: false, verify_command_index: null, expect_path_indexes: [] })) };
}

// ============================================================
// devFlowArgs: dev-flow.js 用 args の既定形（{issue, setup}）
// ============================================================

/**
 * dev-flow.js 用 args の既定形を返す。setup は dev-flow-prerun の stdout JSON と同形。
 *
 * @param {number|string} [issue=1]
 * @param {Record<string, unknown>} [setupOverrides={}]
 * @returns {{issue: string, setup: Record<string, unknown>}}
 */
export function devFlowArgs(issue = 1, setupOverrides = {}) {
  const n = String(issue);
  return {
    issue: n,
    setup: {
      ok: true, issue: Number(n), base: 'main', base_source: 'origin/HEAD',
      worktree: '/tmp/wt', branch: `feature/issue-${n}`, head: 'a'.repeat(40),
      worktree_status: 'created', clean: { ok: true },
      deps: { ok: true, note: '' }, stack: { frameworks: [], test_runners: [] }, analyze: prerunAnalyze(),
      epoch: 1000, epoch_end: 1050, ci_wait_ceiling_seconds: 300, security_reviewer: 'claude', hooks_not_running: [],
      ...setupOverrides,
    },
  };
}

/**
 * setup.analyze だけを差し替えた args を返す（REQ の AC / issue_type / breaking / comment を変える test 用）。
 *
 * @param {number|string} [issue=1]
 * @param {Record<string, unknown>} [analyzeOverrides={}]
 */
export function analyzeArgs(issue = 1, analyzeOverrides = {}) {
  return devFlowArgs(issue, { analyze: prerunAnalyze(analyzeOverrides) });
}

// ============================================================
// makeRecordingSandbox: 記録付き sandbox を生成する
// ============================================================

/**
 * agent() 呼び出しを記録し、responder に委譲する VM sandbox を作る。
 *
 * @param {(call: {label: string, agentType: string, prompt: string, opts: Record<string, unknown>}) => unknown} responder
 *   各 agent() 呼び出しに対する応答を返す関数。undefined を返した場合は null に変換する。
 * @param {Record<string, unknown>} [extraSandbox={}]
 *   sandbox に追加注入するプロパティ（args 等を上書きする際に使う。log/phase もここで上書き可）。
 * @param {{calls?: Array<object>}} [record={}]
 *   calls: 呼び出しを積む配列（呼び出し側が先に持っている配列へ記録したいときに渡す。既定は新規配列）。
 * @returns {{
 *   ctx: vm.Context,
 *   calls: Array<{label: string, agentType: string, prompt: string, opts: Record<string, unknown>, schema: unknown, model: string|null}>,
 *   logs: string[],
 *   phases: string[],
 * }}
 */
export function makeRecordingSandbox(responder, extraSandbox = {}, { calls = [] } = {}) {
  const logs = [];
  const phases = [];

  const agent = async (prompt, opts) => {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';
    const p = prompt ?? '';
    // model: opts.model（dev-flow / pr-iterate の call site は override を渡さないので常に null。残存検知用）
    calls.push({ label, agentType, prompt: p, opts: opts ?? {}, schema: opts?.schema ?? null, model: opts?.model ?? null });
    const result = responder({ label, agentType, prompt: p, opts: opts ?? {} });
    return result === undefined ? null : result;
  };

  // parallel() / pipeline() は sandbox に置かない — dev-flow.js の Implement は
  // dev-implementer の単一 serial spawn で fan-out を持たない（issue #673）。

  const sandbox = {
    // control fns（既定で呼び出しを logs/phases に記録する。extraSandbox で上書き可）
    phase: (t) => { phases.push(String(t)); },
    log: (m) => { logs.push(String(m)); },
    workflow: async () => ({ status: 'lgtm', iterations: 1, fixes_applied: 0 }),
    args: devFlowArgs(1),
    // agent stub
    agent,
    // JS 組み込み
    ...JS_GLOBALS,
    // caller の上書き（args 等）
    ...extraSandbox,
  };
  // 工程の workflow（dev-flow-finalize 等）は stub にせず、同じ agent stub で実行して親とつなぐ
  sandbox.workflow = chainStageWorkflows(sandbox.workflow, sandbox);

  const ctx = vm.createContext(sandbox);
  return { ctx, calls, logs, phases };
}

/**
 * 独自の agent stub を持つ test 用の VM context を作る。phase / log は既定で何もしない（sandbox で上書きできる）。
 *
 * @param {Record<string, unknown>} sandbox - agent / workflow / args など
 * @returns {vm.Context}
 */
export function makeWorkflowContext(sandbox) {
  const host = { phase: () => {}, log: () => {}, ...JS_GLOBALS, ...sandbox };
  if (host.workflow) host.workflow = chainStageWorkflows(host.workflow, host);
  return vm.createContext(host);
}

// ============================================================
// runDevFlowInSandbox: dev-flow.js ソースを strip して sandbox 実行する
// ============================================================

/**
 * dev-flow.js ソースを strip して async IIFE でラップし vm sandbox で実行する。
 *
 * @param {string} src - dev-flow.js の raw ソース
 * @param {vm.Context} ctx - vm コンテキスト
 * @returns {Promise<Error|null>} エラーがあれば Error、無ければ null
 */
export async function runDevFlowInSandbox(src, ctx) {
  const stripped = src
    .replace(/^export\s+const\s+/gm, 'const ')
    .replace(/^export\s+function\s+/gm, 'function ');
  const wrapped = `(async () => {\n${stripped}\n})();`;

  let caughtError = null;
  try {
    const result = vm.runInContext(wrapped, ctx, { filename: '.claude/workflows/dev-flow.js' });
    if (result && typeof result.then === 'function') {
      await result.catch((e) => {
        caughtError = e;
      });
    }
  } catch (e) {
    caughtError = e;
  }
  return caughtError;
}

// ============================================================
// runWorkflowCapture: strip + wrap + vm 実行し {result, error} を返す
// （dev-flow.js / pr-iterate.js 共用のため filename を引数化する）
// ============================================================

/**
 * workflow ソースを strip して async IIFE でラップし vm sandbox で実行し、
 * 解決結果とエラーの両方を返す。
 *
 * @param {string} src - workflow の raw ソース（dev-flow.js / pr-iterate.js）
 * @param {vm.Context} ctx - vm コンテキスト
 * @param {string} [filename='.claude/workflows/dev-flow.js'] - vm.runInContext に渡す filename
 * @returns {Promise<{ result: unknown, error: Error|null }>}
 */
export async function runWorkflowCapture(src, ctx, filename = '.claude/workflows/dev-flow.js') {
  const stripped = src
    .replace(/^export\s+const\s+/gm, 'const ')
    .replace(/^export\s+function\s+/gm, 'function ');
  const wrapped = `(async () => {\n${stripped}\n})();`;

  let caughtError = null;
  let resolvedResult = null;
  try {
    const resultPromise = vm.runInContext(wrapped, ctx, { filename });
    if (resultPromise && typeof resultPromise.then === 'function') {
      resolvedResult = await resultPromise.catch((e) => {
        caughtError = e;
        return null;
      });
    }
  } catch (e) {
    caughtError = e;
  }
  return { result: resolvedResult, error: caughtError };
}

// ============================================================
// assertNoCrash: ReferenceError/SyntaxError のみを sandbox クラッシュとして fail させる
// ============================================================

/**
 * runDevFlowInSandbox / runWorkflowCapture が返す error を検査し、
 * ReferenceError/SyntaxError（sandbox 実行自体のクラッシュ）であれば assert.fail する。
 *
 * @param {Error|null} error
 * @param {string} [name] - fail メッセージに含めるテストケース識別子
 */
export function assertNoCrash(error, name) {
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`${name ? `[${name}] ` : ''}workflow が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }
}

// ============================================================
// ciCounts: ci-check / ci-wait-check / ci-check-lite stub に載せる check-ci の件数
// ============================================================

/**
 * status と整合する check-ci の件数（passed / failed / pending / skipped）を返す。workflow は proxy の status を
 * 件数から導き直した値と照合し、食い違い・件数欠落を error にする（ciEffectiveStatus。issue #834）ため、
 * status を採らせたい stub はこの件数を一緒に返す。'error' は check-ci が件数を出さないので 0 件。
 *
 * @param {'passed'|'failed'|'pending'|'no_checks'|'error'} status
 */
export function ciCounts(status) {
  return {
    passed: status === 'passed' ? 1 : 0,
    failed: status === 'failed' ? 1 : 0,
    pending: status === 'pending' ? 1 : 0,
    skipped: 0,
  };
}

// ============================================================
// mergeTierFacts: Merge tier 統合 exec-proxy（label 'merge-tier-facts'）の応答を組み立てる
// ============================================================

/**
 * merge-tier-facts の応答 {diffhash, risk, changed, pr, head_tree, checks, closes, epoch} を返す。
 * 各サブ結果は {ok:true, value} で、引数で個別に上書きできる。null を渡したサブ結果は
 * {ok:false, value:null, error} になる（当該サブ結果だけ失敗させる）。closes は PR body の
 * `Closes #<issue>` 有無（既定 true。false で欠落、null で取得失敗）。
 *
 * @param {{hash?: string, risk?: object|null, files?: string[]|null, pr?: object|null,
 *          tree?: string|null, checks?: object[]|null, closes?: boolean|null, epoch?: number}} [o]
 */
export function mergeTierFacts(o = {}) {
  const sub = (v, err) => (v === null ? { ok: false, value: null, error: err } : { ok: true, value: v });
  const hash = 'hash' in o ? o.hash : 'AAA';
  const risk = 'risk' in o ? o.risk : { ok: true, hits: [] };
  const files = 'files' in o ? o.files : ['src/x.ts'];
  const pr = 'pr' in o ? o.pr : { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', headRefOid: 'a'.repeat(40) };
  const tree = 'tree' in o ? o.tree : 'AAA';
  const checks = 'checks' in o ? o.checks : null;
  const closes = 'closes' in o ? o.closes : true;
  return {
    diffhash: sub(hash === null ? null : { hash, empty: false, epoch: 1 }, 'stub: diffhash unavailable'),
    risk: sub(risk, 'stub: risk unavailable'),
    changed: sub(files === null ? null : { files }, 'stub: changed unavailable'),
    pr: sub(pr, 'stub: pr unavailable'),
    head_tree: sub(tree === null ? null : { tree }, 'stub: head_tree unavailable'),
    checks: sub(checks === null ? null : { checks }, 'stub: no checks'),
    closes: sub(closes === null ? null : { present: closes }, 'stub: closes unavailable'),
    epoch: o.epoch ?? 2000,
  };
}

// ============================================================
// testCommandsPrepareResponse: test-commands-prepare（label 'resolve-test-commands'）の応答
// ============================================================

/** 既定の test-commands-prepare の応答の commands_file（worktree '/tmp/wt' の外）。 */
export const TEST_COMMANDS_FILE = '/tmp/test-commands-Stub01/commands.json';

/**
 * test-commands-prepare の stdout と同形の応答を返す。既定は base の tree に tests/run-*.sh がある repo（source 'runners'）。
 *
 * @param {Record<string, unknown>} [overrides={}]
 */
export function testCommandsPrepareResponse(overrides = {}) {
  return {
    ok: true, source: 'runners', status: 'resolved', full_command: null, files_command: null, sources: ['tests/run-unit.sh'],
    commands_file: TEST_COMMANDS_FILE, run_dir: '/tmp/test-commands-Stub01',
    ...overrides,
  };
}

// ============================================================
// devFlowResponder: dev-flow.js 標準経路（shape 'standard'）の既定 responder
// ============================================================

/**
 * 既定 run の realized / 申告ファイル（3 件 → 実効 shape 'standard'）。
 * dev-implementer stub の files と danger-grep stub の files の両方に使う（宣言外 0 件）。
 */
export const STANDARD_FILES = ['src/x.ts', 'src/y.ts', 'src/z.ts'];
/** complex（realized 6 件超）に倒す test 用のファイル一覧。danger-grep / dev-implementer の両 override に使う。 */
export const COMPLEX_FILES = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts', 'src/f.ts', 'src/g.ts'];
/** micro（realized 2 件以下）に倒す test 用のファイル一覧。 */
export const MICRO_FILES = ['src/x.ts'];

/**
 * 実効 shape を realized file 数で倒す override 集合を返す。
 * dev-implementer（impl / reimpl#1 / reimpl#2）の申告 files と danger-grep の files を同じ一覧にし、
 * 宣言外 0 件のまま shape だけを変える。micro は lite route の ci-check-lite 応答も含む。
 *
 * @param {'micro'|'complex'} shape
 * @param {{issue?: number}} [opts]
 */
export function shapeOverrides(shape, { issue = 1 } = {}) {
  const files = shape === 'micro' ? MICRO_FILES : shape === 'complex' ? COMPLEX_FILES : STANDARD_FILES;
  const impl = { status: 'DONE', task_id: `issue-${issue}`, files: [...files], summary: 's', concerns: [] };
  return {
    [`impl:serial:issue-${issue}`]: impl,
    [`reimpl#1:serial:issue-${issue}`]: impl,
    [`reimpl#2:serial:issue-${issue}`]: impl,
    'danger-grep': { risk: { ok: true, hits: [] }, files: [...files], diffhash: { hash: 'AAA', empty: false } },
    ...(shape === 'micro' ? { 'ci-check-lite': { status: 'passed', passed: 1, failed: 0, pending: 0, skipped: 0, failed_checks: [], waited_seconds: 0, poll_attempts: 0 } } : {}),
  };
}

/**
 * dev-flow.js 標準経路（shape 'standard'）の既定応答を返す responder を生成する。
 * overrides[label] があればそれを優先する（関数なら {label, agentType, prompt, opts} で呼ぶ、
 * 値ならそのまま、null なら null）。
 *
 * @param {Record<string, unknown>} [overrides={}]
 * @param {{issue?: number}} [opts]
 * @returns {(ctx: {label: string, agentType: string, prompt: string, opts?: Record<string, unknown>}) => unknown}
 */
export function devFlowResponder(overrides = {}, { issue = 1 } = {}) {
  return function (callCtx) {
    const { label, agentType } = callCtx;
    if (Object.prototype.hasOwnProperty.call(overrides, label)) {
      const v = overrides[label];
      return typeof v === 'function' ? v(callCtx) : v;
    }
    // Setup phase の subagent は isolation-probe のみ（base / worktree / deps / cleanup は
    // dev-flow-prerun が run 前に済ませ args.setup で渡る — devFlowArgs 参照）
    if (label === 'isolation-probe') return { written: true };
    // Setup のテストコマンドの解決（dev-flow-test-commands.js）。既定は base に tests/run-*.sh がある repo で resolver を起動しない
    if (label === 'resolve-test-commands') return testCommandsPrepareResponse();
    if (label === 'rg-state-dir') return { state_dir: '/tmp/rg-state' };
    // Analyze phase は args.setup.analyze（prerunAnalyze）から REQ を組み、通常経路では spawn しない。
    // ゲート（AC 空 / comment_conflicts / uncertain）が引いたときだけ analyze-clarify#N（dev-runner）が
    // 人間向け missing_context を返す（issue #690）。
    if (label.startsWith('analyze-clarify')) return { missing_context: ['stub-clarify-question'] };
    // ゲート通過後の観測型の分類 agent（ac-observational#N。全 AC を 1 回で渡す。issue #1259）。既定は prompt に載った
    // 全 AC を観測型でない（false）・検証コマンドなしと返す。観測型の経路を見る test は acObservationalResponse で上書きする。
    if (label.startsWith('ac-observational#')) return acObservationalNone(callCtx.prompt);
    // Implement / green-fix / reimpl は全 shape で dev-implementer 一本（issue #673）。
    // 合成 task `issue-<N>` を echo する（adoptReportedFiles の task_id 突合に必要）。
    // 既定は STANDARD_FILES（3 件）を申告し、danger-grep の realized files と一致させる（宣言外 0 件）。
    if (agentType === 'dev-flow:dev-implementer') {
      return { status: 'DONE', task_id: `issue-${issue}`, files: [...STANDARD_FILES], summary: 's', concerns: [] };
    }
    if (label.startsWith('test')) return { tests: 'passed', green: true, summary: '' };
    // Validate の各回の pre-commit hook（commit-hook#<iter>）。既定は hook の無い repo（何も実行せず成功扱い）
    if (label.startsWith('commit-hook#')) return { hook: 'none', exit: null, tail: '', log: '' };
    // 実効 shape は realized diff の file 数だけで決まる（issue #676）。既定の 3 件 + AC 2 件 + type=fix →
    // 'standard'（Evaluate 1 pass・full route）。micro / complex に倒したい test は files を override する。
    if (label === 'danger-grep') {
      return { risk: { ok: true, hits: [] }, files: [...STANDARD_FILES], diffhash: { hash: 'AAA', empty: false } };
    }
    // Diff triage の敵対的 security review の対象判定（issue #1063）。既定は対象外（nested pr-iterate の stub が
    // security_review を返さないので、対象にすると Merge tier が security_review_unresolved で HOLD になる）。
    // 対象の経路を見る test は override で target:true を返す（securityScopeResponse 参照）。
    if (label === 'security-scope') return securityScopeResponse({ target: false });
    // label 'merge-tier-facts'（Merge tier。issue #637 統合呼び出し）は 6 サブ結果を {ok,value,error} で返す。
    // diffhash は既定で danger-grep（Diff triage）と同一ハッシュ 'AAA'（Diff triage 結果の再利用が発火）。
    // 不一致・失敗にしたいテストは override で個別に上書きする（mergeTierFacts() helper 参照）。
    if (label === 'merge-tier-facts') return mergeTierFacts();
    if (agentType === 'dev-flow:evaluator') {
      return {
        verdict: 'pass', total: 100, threshold: 80, feedback: [],
        feedback_level: 'implementation',
        ac_results: [
          { ac_index: 0, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
          { ac_index: 1, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
        ],
        security_clearance: [], concern_resolutions: [],
      };
    }
    if (label.startsWith('diff-gate') || label.startsWith('diff-hash')) return { hash: 'AAA', empty: false };
    // Closes 行の再投入 / AC checkbox 同期（issue #661）の既定応答。Closes 有無は merge-tier-facts の closes
    // サブ結果（既定 present:true → 'verified'）。再投入は既定で成功し、同じ spawn の再取得も 'true'（issue #824）。
    if (label === 'closes-reinject') return { edited: true, closes: 'true' };
    if (label === 'ac-checkbox-sync') return { edited: true };
    if (label.startsWith('pr')) return { pr_url: 'http://x', pr_number: 1, committed: true };
    if (label === 'post-summary') return { posted: true, method: 'gh', url: 'http://x', epoch: 2000 };
    if (label.startsWith('journal-log')) return { saved: true, logged: true };
    return null;
  };
}

// ============================================================
// securityScopeResponse: security-review-scope（label 'security-scope' / 'security-scope#i'）の応答
// ============================================================

/** security-scope 応答の head を省いたときの既定（40 桁）。 */
export const SECURITY_SCOPE_DEFAULT_HEAD = 'c'.repeat(40);
/** Codex 経路の security-pr-head#i の応答の baseRefOid の既定（40 桁）。 */
export const SECURITY_PR_BASE_DEFAULT = 'd'.repeat(40);
/** security-scope 応答の review_dir / diff_path の既定（PR の worktree '/tmp/wt' の外）。 */
export const SECURITY_REVIEW_DIR = '/tmp/dev-flow-security-review-Stub01';

/**
 * security-review-scope の stdout と同形の応答を返す。
 *
 * @param {{target?: boolean, ok?: boolean, head?: string|null, reasons?: string[], reviewDir?: string, diffPath?: string, contextChanged?: boolean}} [o]
 */
export function securityScopeResponse({ target = true, ok = true, head = SECURITY_SCOPE_DEFAULT_HEAD, reasons, reviewDir = SECURITY_REVIEW_DIR, diffPath, contextChanged = false } = {}) {
  return {
    ok, target, reasons: reasons ?? (target ? ['not_allowlisted:1'] : []), file_count: 1,
    head_sha: head, reviewer_context_changed: contextChanged, review_dir: reviewDir, diff_path: diffPath ?? `${reviewDir}/pr.diff`,
  };
}

/** security-scope#i の prompt の `security-review-scope <wt> <base> <head> --save-diff` から head（40 桁でなければ既定）を取る。 */
export function securityScopeHeadOf(prompt) {
  const m = String(prompt).match(/security-review-scope \S+ \S+ ([0-9a-f]{40}) --save-diff/);
  return m ? m[1] : SECURITY_SCOPE_DEFAULT_HEAD;
}

/** security-review#i の prompt の DATA 区間の head_sha を取る（見つからなければ空文字）。 */
export function securityReviewHeadOf(prompt) {
  const m = String(prompt).match(/^head_sha: ([0-9a-f]{40})$/m);
  return m ? m[1] : '';
}

// ============================================================
// porcelain-verdict（label 'fix-baseline#i' / 'commit-ensure-status#i' / 'worktree-dirty-check'）の応答
// ============================================================

/** fix-baseline#i の応答の baseline_digest の既定（sha256 の形）。 */
export const PORCELAIN_BASELINE_DIGEST = 'd'.repeat(64);

/** `porcelain-verdict baseline` の stdout と同形の応答。 */
export const porcelainBaselineResponse = (digest = PORCELAIN_BASELINE_DIGEST) => ({ exit_code: 0, baseline_digest: digest });

/**
 * `porcelain-verdict check` の stdout と同形の応答を、判定の規則（_lib/porcelain-verdict.mjs）で作る。
 * lines は status の porcelain 行、baseline は基準線の行（null = 基準線なし）。
 *
 * @param {string[]} lines
 * @param {string[]|null} [baseline]
 * @param {{exitCode?: number, mismatch?: boolean}} [o]
 */
export function porcelainVerdictResponse(lines, baseline = [], { exitCode = 0, mismatch = false } = {}) {
  return porcelainVerdict({ output: lines.map((l) => `${l}\n`).join(''), exitCode, baseline, mismatch });
}

// ============================================================
// prIterateResponder: pr-iterate.js 単体起動の既定 responder
// ============================================================

/**
 * pr-iterate.js 単体起動の既定応答を返す responder を生成する。
 * overrides[label] があればそれを優先する（関数なら {label, agentType, prompt, opts} で呼ぶ、
 * 値ならそのまま、null なら null）。
 *
 * security-pr-head#n の既定の headRefOid は GitHub の PR head（最後に push された head）: args.nested.head_sha から始め、
 * pr-meta・commit-ensure#i の応答（override を含む）の head_sha と、自動解消した conflict-resolve#i の head_after で置き換える。
 * 40 桁の sha でなければ SECURITY_SCOPE_DEFAULT_HEAD（workflow の shaNow も 40 桁でなく、照合しない）。
 *
 * @param {Record<string, unknown>} [overrides={}]
 * @param {Function|null} [rounds=null]
 * @param {{initialHead?: unknown}} [o]
 * @returns {(ctx: {label: string, agentType: string, prompt: string, opts?: Record<string, unknown>}) => unknown}
 */
export function prIterateResponder(overrides = {}, rounds = null, { initialHead = null } = {}) {
  const fullSha = (v) => (typeof v === 'string' && /^[0-9a-f]{40}$/i.test(v.trim()) ? v.trim() : null);
  let prHead = fullSha(initialHead);
  const respond = defaultPrIterateResponse(overrides, rounds, () => prHead ?? SECURITY_SCOPE_DEFAULT_HEAD);
  return function (callCtx) {
    const res = respond(callCtx);
    if (callCtx.label === 'pr-meta' || /^commit-ensure#\d+$/.test(callCtx.label)) prHead = fullSha(res?.head_sha);
    if (/^conflict-resolve#\d+$/.test(callCtx.label) && res?.result?.status === 'resolved') prHead = fullSha(res.result.head_after);
    return res;
  };
}

function defaultPrIterateResponse(overrides, rounds, prHeadNow) {
  return function (callCtx) {
    const { label, agentType } = callCtx;
    if (Object.prototype.hasOwnProperty.call(overrides, label)) {
      const v = overrides[label];
      return typeof v === 'function' ? v(callCtx) : v;
    }
    // pr-push stop（fix#i.stop 等）は fix#i の応答列を消費させない
    if (label.endsWith('.stop')) return { ok: true, stopped: false, was_running: false };
    if (rounds) {
      const r = rounds(callCtx);
      if (r !== undefined) return r;
    }
    if (label === 'pr-meta') {
      return {
        url: 'https://github.com/acme/skills/pull/5', head_ref: 'feature/x', base_ref: 'main',
        cwd: '/tmp/wt', epoch: 999,
      };
    }
    if (label === 'isolation-cleanup') return { cleaned: true };
    if (label === 'isolation-probe') return { written: true };
    // 単体起動がテストを実行するときのテストコマンドの解決（dev-flow-test-commands.js）
    if (label === 'resolve-test-commands') return testCommandsPrepareResponse();
    if (agentType === 'dev-flow:pr-reviewer') return { decision: 'approve', issues: [], summary: 'ok' };
    // 敵対的 security review（issue #1063）: round 1 の前（#0）と各 round で security-pr-head#n → security-pr-fetch#n →
    // security-scope#n（GitHub の PR の sha の diff）が走り、対象なら security-review#i。既定は対象・clear（head は prompt の値を写す）
    if (label.startsWith('security-scope#')) return securityScopeResponse({ target: true, head: securityScopeHeadOf(callCtx.prompt) });
    // GitHub の PR の head と base（gh pr view の stdout と同形）と fetch の中継
    if (label.startsWith('security-pr-head#')) return { baseRefOid: SECURITY_PR_BASE_DEFAULT, headRefOid: prHeadNow() };
    if (label.startsWith('security-pr-fetch#')) return { done: true };
    if (agentType === 'dev-flow:security-reviewer') return { reviewed_sha: securityReviewHeadOf(callCtx.prompt), issues: [], summary: 'ok' };
    if (label.startsWith('fix#')) return { applied: true, files: [], summary: 'fixed', deferred_security_ids: [] };
    if (label.startsWith('commit-ensure#')) return { committed: true, pushed: true, dirty: false };
    if (label.startsWith('ci-check')) return { status: 'passed', passed: 1, failed: 0, pending: 0, skipped: 0, failed_checks: [] };
    if (label.startsWith('post-')) return { posted: true, method: 'gh', url: 'http://x', epoch: 3000 };
    if (label === 'worktree-dirty') return { dirty: false };
    if (label.startsWith('journal-log')) return { saved: true, logged: true };
    return null;
  };
}

// ============================================================
// makeDevFlowSandbox / makePrIterateSandbox: 既定 responder を使った薄い wrapper
// ============================================================

/**
 * devFlowResponder を使った makeRecordingSandbox の薄い wrapper。
 *
 * @param {{overrides?: Record<string, unknown>, issue?: number, workflow?: Function, extra?: Record<string, unknown>}} [opts]
 * @returns {ReturnType<typeof makeRecordingSandbox>}
 */
export function makeDevFlowSandbox({ overrides = {}, issue = 1, workflow, extra = {} } = {}) {
  return makeRecordingSandbox(devFlowResponder(overrides, { issue }), {
    workflow: workflow ?? (async () => ({ status: 'lgtm', iterations: 1, fixes_applied: 0 })),
    args: devFlowArgs(issue),
    ...extra,
  });
}

/**
 * pr-iterate の round 系 call（pr-reviewer / fix#i・fix#i-retry / check-ci を実行する ci-check 系 /
 * commit-ensure#i）に呼び出し順で応答する関数を返す（makePrIterateSandbox の rounds に渡す）。
 * round 番号ごとに label を列挙せずに「n 回目の reviewer」「k 回目の fix」を指定するためのもの。
 *   reviewer(n): n 回目（1 始まり）の pr-reviewer 呼び出し（schema-retry 等も 1 回と数える）の応答
 *   fix / ci: 応答の配列。呼び出し順に消費し、尽きたら末尾を繰り返す。要素が関数ならその戻り値
 *   commitEnsure: 全 round 共通の commit-ensure#i の応答（null も応答として返す）
 * 省略した系統は undefined を返し、overrides と既定 responder に任せる。
 *
 * @param {{reviewer?: (n: number) => unknown, fix?: unknown[], ci?: unknown[], commitEnsure?: unknown}} [spec]
 */
export function prIterateRounds({ reviewer, fix, ci, commitEnsure } = {}) {
  let reviews = 0;
  let fixes = 0;
  let cis = 0;
  const pick = (seq, i) => {
    if (!seq || seq.length === 0) return undefined;
    const v = seq[Math.min(i, seq.length - 1)];
    return typeof v === 'function' ? v() : v;
  };
  return ({ label, agentType, prompt }) => {
    if (reviewer && agentType === 'dev-flow:pr-reviewer') return reviewer(++reviews);
    if (fix && label.startsWith('fix#')) return pick(fix, fixes++);
    if (ci && agentType === 'dev-flow:dev-runner-haiku-ro' && String(prompt).includes('check-ci --pr ')) return pick(ci, cis++);
    if (commitEnsure !== undefined && label.startsWith('commit-ensure#')) return commitEnsure;
    return undefined;
  };
}

/**
 * prIterateResponder を使った makeRecordingSandbox の薄い wrapper。
 * rounds（prIterateRounds の戻り値、または {label, agentType, prompt} を受けて応答か undefined を返す関数）は
 * overrides の次、既定 responder の前に引かれる。calls を渡すとその配列へ呼び出しを記録する。
 *
 * @param {{overrides?: Record<string, unknown>, rounds?: Function|null, args?: unknown, extra?: Record<string, unknown>, calls?: Array<object>}} [opts]
 * @returns {ReturnType<typeof makeRecordingSandbox>}
 */
export function makePrIterateSandbox({ overrides = {}, rounds = null, args = '5', extra = {}, calls = [] } = {}) {
  return makeRecordingSandbox(prIterateResponder(overrides, rounds, { initialHead: args?.nested?.head_sha }), {
    workflow: async () => ({ status: 'lgtm' }),
    args,
    // pr-iterate.js は各 round で review#i と ci-check#i を parallel() で同時に起動する（issue #806）。
    // dev-flow.js 用の makeRecordingSandbox には置かない（fan-out を持たない側の偽陽性防止）。
    parallel: async (fns) => Promise.all((fns || []).map((f) => f())),
    ...extra,
  }, { calls });
}
