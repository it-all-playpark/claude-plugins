/**
 * vm-sandbox.mjs — VM sandbox ハーネス共有モジュール
 *
 * green-fix 系 4 ファイルで byte 完全一致していた sandbox ヘルパーを抽出した共有モジュール。
 * 差分（agentStub の返り値ロジック）は呼び出し側の responder 関数に委譲する。
 *
 * Export:
 *   - JS_GLOBALS: VM sandbox に expose する 15 個の JS 組み込みをまとめた object
 *   - makeRecordingSandbox(responder, extraSandbox?): {ctx, calls, logs, phases} を返す
 *     （calls の各要素は {label, agentType, prompt, opts, schema}。opts は agent() に渡された
 *     opts をそのまま、schema は opts?.schema ?? null）
 *   - devFlowArgs(issue?, setupOverrides?): dev-flow.js 用 args の既定形（{issue, setup}）を返す
 *     （setup は dev-flow-prerun の stdout JSON と同形。setup.analyze は prerunAnalyze() の既定）
 *   - prerunAnalyze(overrides?): dev-flow-prerun の analyze 段（prerun-analyze.sh）の ok:true 出力を組み立てる
 *     （AC 2 件 / type fix / breaking なし / comment なし → Analyze phase は spawn 0 で通過）。
 *     REQ を変えたい test は devFlowArgs(issue, { analyze: prerunAnalyze({...}) }) を extra.args に渡す
 *   - analyzeArgs(issue?, analyzeOverrides?): 上記の薄い wrapper（args 全体を返す）
 *   - runDevFlowInSandbox(src, ctx): dev-flow.js ソースを strip して sandbox 実行する
 *   - runWorkflowCapture(src, ctx, filename?): strip + wrap + vm 実行し {result, error} を返す
 *     （dev-flow.js / pr-iterate.js 共用。filename 既定は '.claude/workflows/dev-flow.js'）
 *   - assertNoCrash(error, name): error が ReferenceError/SyntaxError なら assert.fail する
 *   - mergeTierFacts(overrides?): Merge tier 統合 exec-proxy（label 'merge-tier-facts'）の応答を組み立てる
 *   - devFlowResponder(overrides?, {issue?}?): dev-flow.js 標準経路（shape 'standard'）の既定 responder
 *   - STANDARD_FILES / COMPLEX_FILES / MICRO_FILES: 実効 shape を realized file 数で倒すための files 一覧
 *     （danger-grep と dev-implementer の両 stub に同じ一覧を渡すと宣言外 0 件で shape だけが変わる）
 *   - shapeOverrides('micro'|'complex'): 上記を impl / reimpl#1..2 / danger-grep（+ micro は ci-check-lite）の
 *     override にまとめたもの。既定（override なし）は standard
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
// prerunAnalyze: dev-flow-prerun の analyze 段（prerun-analyze.sh）の ok:true 出力
// ============================================================

/**
 * dev-flow-prerun の analyze 段の出力（args.setup.analyze）を返す。
 * 既定は contract 経路（AC ['a','b'] / issue_type 'fix' / breaking なし / comment なし / uncertain 空）で、
 * dev-flow.js の Analyze phase は agent を spawn せずゲートを通過する。
 * ac_observational / ac_observational_evidence は overrides に無ければ AC 数に合わせて全 AC false
 * （prerun で非観測型と確定 → 観測型の分類 agent も spawn しない）にする。
 *
 * @param {Record<string, unknown>} [overrides={}]
 */
export function prerunAnalyze(overrides = {}) {
  const acs = Array.isArray(overrides.acceptance_criteria) ? overrides.acceptance_criteria : ['a', 'b'];
  return {
    ok: true, analyze_path: 'contract', jev_reasons: [],
    issue_title: 'stub-issue-title', issue_type: 'fix', acceptance_criteria: ['a', 'b'],
    scope: 'src', scope_truncated: false, scope_total_chars: 3,
    issue_body: 'stub-issue-body', issue_body_truncated: false,
    breaking_keyword_scan: false, breaking_change: false, breaking_evidence: '',
    comment_count: 0, comment_overrides: [], comment_conflicts: [], uncertain: [], blockers: [],
    ac_observational: acs.map(() => false), ac_observational_evidence: acs.map(() => 'stub: 正規表現の絞り込みに当たらない'),
    contract: 't1', ac_heading_near_miss: [], duration_seconds: 5,
    ...overrides,
  };
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
      epoch: 1000, epoch_end: 1050, ci_wait_ceiling_seconds: 300,
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

  const ctx = vm.createContext(sandbox);
  return { ctx, calls, logs, phases };
}

// ============================================================
// runDevFlowInSandbox: dev-flow.js ソースを strip して sandbox 実行する
// （既存 green-fix 4 ファイルの当該関数を verbatim 移植）
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
// （hash-reconverged-routing.test.mjs の runDevFlowCapture と同一ロジック。
// dev-flow.js / pr-iterate.js 共用のため filename を引数化する）
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
 * @param {string} name - fail メッセージに含めるテストケース識別子
 */
export function assertNoCrash(error, name) {
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`[${name}] workflow が sandbox でクラッシュ: ${error.name}: ${error.message}`);
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
    'danger-grep': { risk: { ok: true, hits: [] }, files: [...files], struct: null, diffhash: { hash: 'AAA', empty: false }, secreview: { target: false, reasons: [] } },
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
    // Analyze phase は args.setup.analyze（prerunAnalyze）から REQ を組み、通常経路では spawn しない。
    // ゲート（AC 空 / comment_conflicts / uncertain）が引いたときだけ analyze-clarify#N（dev-runner）が
    // 人間向け missing_context を返す（issue #690）。
    if (label.startsWith('analyze-clarify')) return { missing_context: ['stub-clarify-question'] };
    // Implement / green-fix / reimpl は全 shape で dev-implementer 一本（issue #673）。
    // 合成 task `issue-<N>` を echo する（adoptReportedFiles の task_id 突合に必要）。
    // 既定は STANDARD_FILES（3 件）を申告し、danger-grep の realized files と一致させる（宣言外 0 件）。
    if (agentType === 'dev-flow:dev-implementer') {
      return { status: 'DONE', task_id: `issue-${issue}`, files: [...STANDARD_FILES], summary: 's', concerns: [] };
    }
    if (label.startsWith('test')) return { tests: 'passed', green: true, summary: '' };
    // 実効 shape は realized diff の file 数だけで決まる（issue #676）。既定の 3 件 + AC 2 件 + type=fix →
    // 'standard'（Evaluate 1 pass・full route）。micro / complex に倒したい test は files を override する。
    // secreview は security review の対象外（issue #1063。欠落は workflow が対象に倒すので既定で明示する）。
    if (label === 'danger-grep') {
      return { risk: { ok: true, hits: [] }, files: [...STANDARD_FILES], struct: null, diffhash: { hash: 'AAA', empty: false }, secreview: { target: false, reasons: [] } };
    }
    // label 'merge-tier-facts'（Merge tier。issue #637 統合呼び出し）は 6 サブ結果を {ok,value,error} で返す。
    // diffhash は既定で danger-grep（Security floor）と同一ハッシュ 'AAA'（Security floor 結果の再利用が発火）。
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
// prIterateResponder: pr-iterate.js 単体起動の既定 responder
// ============================================================

/**
 * pr-iterate.js 単体起動の既定応答を返す responder を生成する。
 * overrides[label] があればそれを優先する（関数なら {label, agentType, prompt, opts} で呼ぶ、
 * 値ならそのまま、null なら null）。
 *
 * @param {Record<string, unknown>} [overrides={}]
 * @returns {(ctx: {label: string, agentType: string, prompt: string, opts?: Record<string, unknown>}) => unknown}
 */
export function prIterateResponder(overrides = {}, rounds = null) {
  return function (callCtx) {
    const { label, agentType } = callCtx;
    if (Object.prototype.hasOwnProperty.call(overrides, label)) {
      const v = overrides[label];
      return typeof v === 'function' ? v(callCtx) : v;
    }
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
    if (agentType === 'dev-flow:pr-reviewer') return { decision: 'approve', issues: [], summary: 'ok' };
    if (label.startsWith('fix#')) return { applied: true, files: [], summary: 'fixed' };
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
    if (ci && agentType === 'dev-flow:dev-runner-haiku-ro' && String(prompt).includes('check-ci --checks-data')) return pick(ci, cis++);
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
  return makeRecordingSandbox(prIterateResponder(overrides, rounds), {
    workflow: async () => ({ status: 'lgtm' }),
    args,
    // pr-iterate.js は各 round で review#i と ci-check#i を parallel() で同時に起動する（issue #806）。
    // dev-flow.js 用の makeRecordingSandbox には置かない（fan-out を持たない側の偽陽性防止）。
    parallel: async (fns) => Promise.all((fns || []).map((f) => f())),
    ...extra,
  }, { calls });
}

