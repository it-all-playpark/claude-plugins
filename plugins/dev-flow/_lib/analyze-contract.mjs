// _lib/analyze-contract.mjs
// buildReqFromContract: dev-flow-prerun の analyze 段（prerun-analyze.sh = `analyze-issue --contract` の
// 決定論 parse + Jev 有界判定）の出力 `args.setup.analyze` から REQ を決定論構成する純粋関数。
// dev-flow の Setup 末尾の analyze ゲートはこの whitelist 検証と 4 条件ゲート（AC 空 / AC が上限超え /
// comment_conflicts 非空 / uncertain 非空）だけを行い、通常経路では agent を 1 つも spawn しない（issue #690 / #695）。
//
// INLINE COPY POLICY: workflow から参照される最上位宣言だけが tools/sync-inlines.mjs --write で inline 生成される。
// 直接 workflow 側を編集しない。一致は _lib/workflow-inlines.sync.test.mjs が検証する。
//
// whitelist 検証項目（1 つでも不合格なら null。呼び出し元は prerun 出力の契約違反として throw する —
// LLM 転写経路は存在しないので fallback 先は無い）:
//   - analyze が object（配列・null 除く）で analyze.ok === true
//   - analyze.analyze_path が 'contract' か 'jev'（'sonnet' はゲート後に Workflow 側が付ける値で入力には現れない）
//   - analyze.issue_title が非空 string
//   - analyze.issue_type が非空 string（enum 外は classifyShape が floor=complex に倒すので here では弾かない）
//   - analyze.acceptance_criteria が配列で全要素が非空 string（空配列・上限超えは許容 — 件数のゲートは analyzeGateReasons）
//   - analyze.breaking_change / breaking_keyword_scan が boolean
//   - analyze.comment_overrides / comment_conflicts / uncertain / jev_reasons が string 配列
//   - analyze.blockers が配列で、全要素が {repo: string, number: 正整数, state: 非空 string,
//     source: 'api'|'body', url: string}（issue #744。依存なしは空配列）
//
// AC の観測型判定（ac_observational）は prerun の出力に持たない。analyze ゲート通過後に全 AC を分類 agent に渡して
// 確定し、REQ に足す（_lib/ac-actor.mjs の resolveAcObservational。issue #1259）。
//
// 合格時、REQ をキー個別 copy で構成する（spread しない — 未知キーの混入防止）。
// issue 本文は REQ に載せない — dev-implementer は worktree の .devflow-tmp/issue-body.md で全文を読み、
// 実装中に書き換えられるそのファイルを判定の根拠にしない（採点軸は acceptance_criteria）。
// 事前 shape 見積もりは REQ に載せない — 実効 shape は realized diff の file 数から classifyShape が決める（issue #676）。
export const ANALYZE_PATH_INPUT = ['contract', 'jev']
export const BLOCKER_SOURCES = ['api', 'body']
// REQ に載せる AC 件数の上限。超えた issue は切らずに analyze ゲートで止める（黙って切ると落ちた AC を誰も採点しない）。
// 値は現行の evaluator 入力の想定量で、実測で決めた値ではない。
export const ACCEPTANCE_CRITERIA_MAX = 20

function isStringArray(v) {
  return Array.isArray(v) && v.every((s) => typeof s === 'string')
}

function isBlocker(b) {
  return b !== null && typeof b === 'object' && !Array.isArray(b)
    && typeof b.repo === 'string'
    && Number.isInteger(b.number) && b.number > 0
    && typeof b.state === 'string' && b.state.length > 0
    && BLOCKER_SOURCES.includes(b.source)
    && typeof b.url === 'string'
}

export function buildReqFromContract(analyze, issueNumber) {
  if (analyze === null || typeof analyze !== 'object' || Array.isArray(analyze)) return null
  if (analyze.ok !== true) return null
  if (!ANALYZE_PATH_INPUT.includes(analyze.analyze_path)) return null
  if (typeof analyze.issue_title !== 'string' || analyze.issue_title.length === 0) return null
  if (typeof analyze.issue_type !== 'string' || analyze.issue_type.length === 0) return null

  if (!Array.isArray(analyze.acceptance_criteria)) return null
  if (!analyze.acceptance_criteria.every((ac) => typeof ac === 'string' && ac.length > 0)) return null

  if (typeof analyze.breaking_change !== 'boolean') return null
  if (typeof analyze.breaking_keyword_scan !== 'boolean') return null
  if (!isStringArray(analyze.comment_overrides)) return null
  if (!isStringArray(analyze.comment_conflicts)) return null
  if (!isStringArray(analyze.uncertain)) return null
  if (!isStringArray(analyze.jev_reasons)) return null
  if (!Array.isArray(analyze.blockers) || !analyze.blockers.every(isBlocker)) return null

  const req = {
    summary: `Issue #${issueNumber}: ${analyze.issue_title}`,
    issue_number: Number(issueNumber),
    issue_title: analyze.issue_title,
    issue_type: analyze.issue_type,
    acceptance_criteria: analyze.acceptance_criteria.slice(),
    breaking_change: analyze.breaking_change,
    breaking_keyword_scan: analyze.breaking_keyword_scan,
    breaking_evidence: typeof analyze.breaking_evidence === 'string' ? analyze.breaking_evidence : '',
    comment_overrides: analyze.comment_overrides.slice(),
    comment_conflicts: analyze.comment_conflicts.slice(),
    uncertain: analyze.uncertain.slice(),
    analyze_path: analyze.analyze_path,
    jev_reasons: analyze.jev_reasons.slice(),
    blockers: analyze.blockers.map((b) => ({ repo: b.repo, number: b.number, state: b.state, source: b.source, url: b.url })),
  }
  if (Number.isInteger(analyze.comment_count) && analyze.comment_count >= 0) {
    req.comment_count = analyze.comment_count
  }
  return req
}

// analyzeGateReasons: Setup 末尾の analyze ゲート（4 条件）。非空なら needs_clarification（source=analyze）で終端し、
// ゲート後にだけ sonnet を 1 spawn して人間向け missing_context を生成する。
//   - AC 空: 決定論 parse が AC 見出し / 項目を見つけられなかった
//   - AC が上限超え: 件数の比較だけで決める（切る・先頭だけ採点するといった件数を減らして進む扱いはしない）
//   - comment_conflicts 非空: body と comment の矛盾、または権限なし / 低確信の上書き（fail-closed）
//   - uncertain 非空: Jev の低確信 / 応答なし / 無効（fail-closed）
// 返り値は人間向けの理由行（missing_context の決定論部分）。
export function analyzeGateReasons(req) {
  const reasons = []
  if (!Array.isArray(req?.acceptance_criteria) || req.acceptance_criteria.length === 0) {
    reasons.push('acceptance_criteria が空 — issue に受け入れ基準（`## 受け入れ基準` / `## Acceptance Criteria` 見出し + checkbox / 箇条書き）を書いてから再起動せよ')
  } else if (req.acceptance_criteria.length > ACCEPTANCE_CRITERIA_MAX) {
    reasons.push(`acceptance_criteria が ${req.acceptance_criteria.length} 件で上限 ${ACCEPTANCE_CRITERIA_MAX} 件を超える — AC を減らすか issue を分けてから再起動せよ`)
  }
  for (const c of (req?.comment_conflicts ?? [])) reasons.push(`issue body と comment の矛盾（どちらが有効か確定できない）: ${c}`)
  for (const u of (req?.uncertain ?? [])) reasons.push(`決定論 / Jev で確定できない判定: ${u}`)
  return reasons
}

// blockedByReasons: Setup 末尾の blocked_by ゲート（issue #744）。state が OPEN の blocker（dependencies API /
// 本文の Blocked by）ごとに人間向けの 1 行を返す。非空なら needs_clarification（source=blocked_by）で終端する。
// 前提 issue（人手作業など）が未完了のまま実装を走らせると、途中で詰まる・mock で逃げる・未完了の PR が出るため、
// analyze ゲートより前で止めて sonnet も spawn しない（未完了 issue の列挙は決定論で足りる）。
export function blockedByReasons(req) {
  return (req?.blockers ?? [])
    .filter((b) => b.state === 'OPEN')
    .map((b) => `未完了の blocker ${b.repo}#${b.number}（${b.url}、source=${b.source}）— この issue を完了・close してから /dev-flow を再起動せよ`)
}
