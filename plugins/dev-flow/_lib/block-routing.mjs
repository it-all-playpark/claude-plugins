// block-routing: BLOCKED task result の block_class 判定・決定論スクラブ・振り分けを行う純関数群。
// guard/hook 由来の BLOCKED（block_class:'guard_blocked'）を approach_mismatch の replan ループ
// （blockSeen 登録・findings 化・dev-implementer 再 spawn）から遮断し、迂回コマンド列を prompt へ
// 伝播させないためのチョークポイント（issue #448）。
//
// W7 正当化クラス: incentive-structural（永続・撤去禁止）。
// guard/hook 由来の BLOCKED を「別アプローチ探索」として実装 agent に渡すと、guard を迂回する
// コマンド列の組み立てを incentive 化する（run wf_17d7a7be の実害）。この遮断は capability 非依存
// （賢いモデルほど巧妙な迂回手順を組み立て得るため、モデル世代が進んでも撤去しない）。
//
// INLINE COPY POLICY: workflow から参照される最上位宣言だけが tools/sync-inlines.mjs --write で inline 生成される。
// 直接 workflow 側を編集しない。一致は _lib/workflow-inlines.sync.test.mjs が検証する。

export const BLOCK_CLASSES = ['approach_mismatch', 'guard_blocked']

export const GUARD_ID_PATTERN = '^[a-z][a-z0-9-]{0,39}$'

export function normalizeBlockingReason(raw) {
  if (raw === null) {
    return { block_class: 'approach_mismatch', detail: 'BLOCKED（詳細未申告）', guard_id: null }
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('normalizeBlockingReason: blocking_reason must be a structured object (null は approach_mismatch へ fallback、free text は受理しない)')
  }
  const { block_class, detail, guard_id } = raw
  if (!BLOCK_CLASSES.includes(block_class)) {
    throw new Error(`normalizeBlockingReason: block_class '${block_class}' is out-of-enum (expected one of ${JSON.stringify(BLOCK_CLASSES)})`)
  }
  if (typeof detail !== 'string') {
    throw new Error('normalizeBlockingReason: detail must be a string')
  }
  if (block_class !== 'guard_blocked') {
    return { block_class, detail, guard_id: null }
  }
  if (guard_id === undefined || guard_id === null) {
    return { block_class, detail, guard_id: 'unspecified' }
  }
  const guardIdRe = new RegExp(GUARD_ID_PATTERN)
  if (typeof guard_id !== 'string' || !guardIdRe.test(guard_id)) {
    throw new Error(`normalizeBlockingReason: guard_id '${guard_id}' does not match pattern ${GUARD_ID_PATTERN}`)
  }
  return { block_class, detail, guard_id }
}

const GUARD_EVASION_VOCAB_RE = /\b(fetch|FETCH_HEAD|mirror|checkout|clone|push|pull|remote|update-ref|worktree|symlink|chmod)\b/gi
const COMMAND_PREFIX_RE = /^(git|gh|sh|bash|node|npm|curl|wget|ssh|scp|rsync)\s.*$/gm
const CHAINED_LINE_RE = /^.*&&.*$/gm
const BACKTICK_SPAN_RE = /`[^`]*`/g
const SUBSHELL_SPAN_RE = /\$\([^)]*\)/g
const URL_RE = /https?:\/\/\S+/g

export function scrubBlockingDetail(text) {
  let scrubbed = String(text)
  scrubbed = scrubbed.replace(BACKTICK_SPAN_RE, '[REDACTED-CMD]')
  scrubbed = scrubbed.replace(SUBSHELL_SPAN_RE, '[REDACTED-CMD]')
  scrubbed = scrubbed.replace(CHAINED_LINE_RE, '[REDACTED-CMD]')
  scrubbed = scrubbed.replace(COMMAND_PREFIX_RE, '[REDACTED-CMD]')
  scrubbed = scrubbed.replace(URL_RE, '[REDACTED-CMD]')
  scrubbed = scrubbed.replace(GUARD_EVASION_VOCAB_RE, '[REDACTED]')
  scrubbed = scrubbed.replace(/\s+/g, ' ').trim()
  scrubbed = scrubbed.slice(0, 500)
  return scrubbed === '' ? '[REDACTED]' : scrubbed
}

export function partitionBlocked(results) {
  const guardBlocked = []
  const approachBlocked = []
  for (const r of results) {
    if (!r || r.status !== 'BLOCKED') continue
    const normalized = normalizeBlockingReason(r.blocking_reason ?? null)
    if (normalized.block_class === 'guard_blocked') {
      guardBlocked.push({ task_id: r.task_id, guard_id: normalized.guard_id, detail: normalized.detail })
    } else {
      approachBlocked.push({ task_id: r.task_id, detail: normalized.detail })
    }
  }
  return { guardBlocked, approachBlocked }
}

// guard_blocked の理由がファイル削除（rm / rip の deny 等）か。該当すれば workflow は以降の実装 spawn に
// 固定文の削除手段（git rm・unstage しない）を渡す。detail 本文は渡さない（スクラブ前の文を prompt へ
// 伝播させない上記の遮断と両立させるため、判定結果の真偽だけを使う）。
const DELETION_BLOCK_RE = /削除|消せ|消す|消去|\brm\b|\brip\b|delet|remov|unlink/i

export function isDeletionGuardBlock(detail) {
  return DELETION_BLOCK_RE.test(String(detail ?? ''))
}

export function buildGuardBlockedConcern({ task_id, guard_id, detail }) {
  return 'guard_blocked(' + task_id + ')[guard=' + guard_id + ']: ' + scrubBlockingDetail(detail)
}

export function buildApproachBlockFinding({ task_id, detail }) {
  return {
    severity: 'critical',
    dimension: 'approach_mismatch',
    topic: scrubBlockingDetail(detail).slice(0, 60),
    description: scrubBlockingDetail(detail),
    suggestion: '同アプローチでは進行不可。代替設計を立案すること（現アプローチの再試行は禁止）。',
  }
}
