// local-verify: ci の AC（repo の ci_verify で CI の check が判定する AC。issue #861）を、PR を出す前に
// pg-broker の使い捨て Postgres に向けたローカル実行（plugin bin/ の local-verify）で判定する経路の純関数（issue #863）。
//
// Validate が green になった後・Evaluate の前に、ci の AC があり repo が "dev-flow".local_verify を宣言した run だけ
// local-verify start → wait（終わるまで繰り返す）→ stop を exec-proxy で呼ぶ。
//   passed（exit 0）: ci の AC を satisfied にする（根拠は log_path と exit code）。PR に ci_verify.label は付けるが
//     pr-iterate は check の結果を待たない（ci_verify.wait:false）
//   failed（exit 非 0・timeout）: log_tail を付けて dev-implementer に差し戻す。回数は agent AC の差し戻しと同じ
//     AGENT_AC_REIMPL_MAX に含め、上限後も失敗なら ci の AC を agent の未達に数えて ac_agent_unsatisfied で HOLD
//   unavailable（pg-broker のソケットに届かない・DB を確保できない）/ error（proxy の応答が無い・宣言不正等）:
//     fail-open。従来どおり pr-iterate が LGTM 後に CI の check を待って判定する。理由は終端サマリーに 1 行出す
//
// AC コマンド（issue #1208）: 観測型 AC のうち、AC 自体が inline code で指定したコマンド（_lib/ac-actor.mjs の freezeAcVerify が
// analyze ゲートで凍結した verify_command / expect_paths）も同じ local-verify で sandbox 内で実行する（db の無い宣言 —
// pg-broker を呼ばない。宣言は --config-pct で渡し、worktree の宣言とは突き合わせない）。
// 結果は差し戻し（判定を厳しくする側）と開示だけに使い、AC の達成判定と merge tier は変えない — 実行される script・
// build 設定・テストは PR が書き換えられるので、exit 0 で ac_human_pending の HOLD を外すと PR の内容で gate を誘導できる
// （incentive-structural）。
//   Validate green 後に 1 本ずつ実行する（acVerifyValidateAction）。failed / timeout は log_tail を付けて dev-implementer へ
//     差し戻す（AGENT_AC_REIMPL_MAX を ci の AC・Evaluate と共有）。上限後も失敗なら agent の未達（ac_agent_unsatisfied）。
//     passed / unavailable / error は人手 AC（ac_human_pending）のまま
//   Final reconcile は passed を出した tree と最終 tree が異なるときだけ再実行する（acVerifyFinalAction。ci の AC の
//     tree_hash の突合と同じ規則）。最終 tree で passed の AC だけ、コマンド・exit code・log_path を終端サマリーのその AC の
//     行に人手確認の材料として載せる（acVerifyDisclosures。demoteUnprovenObservationalAc の proven には入れない）
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。
// 制約: ESM import / require / Date.now / Math.random を含めない。export function / export const のみ。

// start が DB の確保（pg-broker create。broker 側の上限は 240 秒）を待つ秒数と、wait 1 回あたりの待機秒数。
// どちらも 1 回の Bash 呼び出し（timeout 600000）に収まる値にする。
export const LOCAL_VERIFY_START_WAIT_SEC = 300
export const LOCAL_VERIFY_WAIT_SEC = 480
// 差し戻しに添える log の末尾の上限（文字）。local-verify も同じ長さで切って返す。
export const LOCAL_VERIFY_TAIL_MAX = 4000
// local-verify の state dir（worktree 内の .devflow-tmp は realized diff から除外される）。
export const LOCAL_VERIFY_STATE_DIR = '.devflow-tmp/local-verify'

// local-verify start の --config-pct に渡す値。Setup 時に検証した宣言（normalizeLocalVerify の結果）を JSON にして
// percent-encoding し、shell のクォートが要らない文字（英数字と . _ - %）だけの 1 トークンにする。
// local-verify はこれを宣言として使い、worktree の宣言（実装で書き換えられうる）が一致しなければ error を返す。
export function localVerifyConfigArg(cfg) {
  return encodeURIComponent(JSON.stringify(cfg)).replace(/[!'()*~]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
}

// wait の最大回数。timeout_seconds を 1 回の待機秒数で割った回数 + 1（local-verify 側も timeout_seconds で
// command を止めて timeout を返すので、これは応答が欠けたときの workflow 側の安全上限）。
export function localVerifyWaitPolls(timeoutSeconds) {
  const t = Number.isInteger(timeoutSeconds) && timeoutSeconds > 0 ? timeoutSeconds : 0
  return Math.ceil(t / LOCAL_VERIFY_WAIT_SEC) + 1
}

// local-verify start / wait の stdout JSON を判定に畳む。
//   'passed' | 'failed' | 'unavailable' | 'error' | 'running'（まだ実行中 — wait を続ける）
// passed は exit_code 0 が揃ったときだけ（転記の食い違いを passed に倒さない）。
export function localVerifyVerdict(res) {
  if (!res || typeof res !== 'object') return 'error'
  switch (res.status) {
    case 'passed': return res.exit_code === 0 ? 'passed' : 'error'
    case 'failed':
    case 'timeout': return 'failed'
    case 'unavailable': return 'unavailable'
    case 'running': return 'running'
    default: return 'error'
  }
}

// local-verify が失敗した run の差し戻し（fix_feedback）。ci の AC ごとに 1 項目、log の末尾を添える。
export function localVerifyFeedback({ result, command, acIndexes, acceptanceCriteria }) {
  const acs = Array.isArray(acceptanceCriteria) ? acceptanceCriteria : []
  const how = result?.status === 'timeout' ? 'timeout_seconds を超えて止められた' : `exit ${result?.exit_code ?? '?'} で失敗した`
  const logTail = String(result?.log_tail ?? '').slice(-LOCAL_VERIFY_TAIL_MAX)
  return (Array.isArray(acIndexes) ? acIndexes : []).map((i) => ({
    severity: 'major',
    topic: `AC-${i + 1} 未達`,
    ac_index: i,
    description: `AC-${i + 1}「${String(acs[i] ?? '')}」のローカル実行（\`${command}\`。pg-broker の使い捨て Postgres に向けて実行）が ${how}`,
    suggestion: 'log_tail（失敗した実行の出力の末尾）から原因を特定して実装を直せ。テストの期待値を弱めて通さない。全文は log_path にある',
    log_path: typeof result?.log_path === 'string' ? result.log_path : null,
    log_tail: logTail,
  }))
}

// applyCiAcResults（_lib/ac-actor.mjs）に渡す ci AC の判定（source:'local'）。passed / failed で決着した run だけ作る。
export function localVerifyCiOutcome(localVerify) {
  if (!localVerify || !['passed', 'failed'].includes(localVerify.status)) return null
  return {
    source: 'local',
    status: localVerify.status,
    command: localVerify.command,
    exit_code: localVerify.exit_code ?? null,
    log_path: localVerify.log_path ?? null,
  }
}

// ---- AC コマンド（issue #1208） ----

// AC コマンドの上限秒数（local-verify の timeout_seconds）。AC の文面は秒数を持たないので run 側で決める。
// build の完走を確かめる AC が収まり、wait 3 回（localVerifyWaitPolls）で終わる長さ。
export const AC_VERIFY_TIMEOUT_SEC = 900
// AC ごとの local-verify の state dir の親（AC-<n> の下に置く。ci の AC の LOCAL_VERIFY_STATE_DIR と分ける）。
export const AC_VERIFY_STATE_DIR = '.devflow-tmp/ac-verify'

// local-verify start の --config-pct に渡す宣言（db の無い宣言。pg-broker を呼ばずに command を実行する）。
// frozen は freezeAcVerify の 1 要素（{ verify_command, expect_paths }）。
export function acVerifyConfig(frozen) {
  return {
    command: frozen.verify_command,
    expect_paths: Array.isArray(frozen.expect_paths) ? frozen.expect_paths : [],
    timeout_seconds: AC_VERIFY_TIMEOUT_SEC,
  }
}

// Validate green 後の 1 回の実行結果（localVerifyVerdict の値）を経路に畳む。
//   'passed': 開示の候補（Final reconcile で最終 tree と突き合わせる。人手 AC のまま）
//   'reimpl': failed / timeout で差し戻し回数（reimplCount。ci の AC・Evaluate と共有）が reimplMax 未満 → log_tail を付けて差し戻す
//   'failed': 差し戻し上限後も失敗 → agent の未達（ac_agent_unsatisfied）
//   'human': unavailable / error / running（終わらない）→ 人手 AC のまま（差し戻さず、開示もしない）
// reimplMax は呼び出し側が AGENT_AC_REIMPL_MAX を渡す（本ファイルは ac-actor.mjs を import できないため）。
export function acVerifyValidateAction(verdict, reimplCount, reimplMax) {
  if (verdict === 'passed') return 'passed'
  if (verdict === 'failed') return reimplCount < reimplMax ? 'reimpl' : 'failed'
  return 'human'
}

// Final reconcile: AC コマンドの記録（{ status, tree_hash }）と最終 tree の diff hash から経路を決める。
//   'disclose': passed を出した tree が最終 tree と一致する（hash が取れたときだけ）→ 終端サマリーに開示するだけ。proven にしない
//   'rerun': passed だが tree が異なる・最終 tree の hash が取れない → 最終 tree で 1 回だけ再実行する（差し戻しはしない）
//   'failed': 差し戻し上限後も失敗した記録 → agent の未達のまま
//   'human': unavailable / error / skipped / stale → 人手 AC のまま
export function acVerifyFinalAction(entry, finalTreeHash) {
  if (entry?.status === 'passed') return typeof finalTreeHash === 'string' && entry.tree_hash === finalTreeHash ? 'disclose' : 'rerun'
  if (entry?.status === 'failed') return 'failed'
  return 'human'
}

// 終端サマリーの AC の行に載せる、最終 tree で passed の AC コマンドの記録（buildDevflowSummaryBody の acVerify）。
// Final reconcile の後は最終 tree で passed のものだけが passed のまま残る（突き合わせられなかったものは stale）。
// 人手確認の材料で、AC の達成判定・merge tier には使わない。
export function acVerifyDisclosures(entries) {
  return (Array.isArray(entries) ? entries : [])
    .filter((e) => e && e.status === 'passed' && Number.isInteger(e.ac_index) && typeof e.command === 'string')
    .map((e) => ({ ac_index: e.ac_index, command: e.command, exit_code: e.exit_code ?? 0, log_path: e.log_path ?? null }))
}

function acVerifyHow(e) {
  return e.timeout === true ? 'timeout_seconds を超えて止められた' : `exit ${e.exit_code ?? '?'}`
}

// AC コマンドが失敗した AC の差し戻し（fix_feedback）。AC ごとに 1 項目、log の末尾を添える。
// result は local-verify wait の応答（status / exit_code / log_path / log_tail / reason）。
export function acVerifyFeedback({ result, command, acIndex, acceptanceCriteria }) {
  const acs = Array.isArray(acceptanceCriteria) ? acceptanceCriteria : []
  const how = result?.status === 'timeout' ? 'timeout_seconds を超えて止められた' : `exit ${result?.exit_code ?? '?'} で失敗した`
  const reason = typeof result?.reason === 'string' && result.reason ? `（${result.reason}）` : ''
  return {
    severity: 'major',
    topic: `AC-${acIndex + 1} 未達`,
    ac_index: acIndex,
    description: `AC-${acIndex + 1}「${String(acs[acIndex] ?? '')}」が指定したコマンド（\`${command}\`）を worktree で実行したら ${how}${reason}`,
    suggestion: 'log_tail（失敗した実行の出力の末尾）から原因を特定して実装を直せ。AC のコマンドや期待するファイルを変えて通さない。全文は log_path にある',
    log_path: typeof result?.log_path === 'string' ? result.log_path : null,
    log_tail: String(result?.log_tail ?? '').slice(-LOCAL_VERIFY_TAIL_MAX),
  }
}

// ac_results に、差し戻し上限後も AC コマンドが失敗した（status 'failed'）AC を agent の未達として重ねる
// （evaluator / final-ac-reconcile の同じ AC の結果を置き換える。無ければ足す）。失敗以外の記録（passed / unavailable /
// error / skipped / stale）は判定を変えない — passed は開示だけ（acVerifyDisclosures）、それ以外は人手 AC のまま。
// 記録が無い・非配列はそのまま返す。
export function applyAcVerifyResults(acResults, entries) {
  if (!Array.isArray(acResults)) return acResults
  const list = (Array.isArray(entries) ? entries : []).filter((e) => e && Number.isInteger(e.ac_index) && e.status === 'failed')
  if (!list.length) return acResults
  const decided = new Set(list.map((e) => e.ac_index))
  const kept = acResults.filter((r) => !(r && decided.has(r.ac_index)))
  const replaced = list.map((e) => ({
    ...(acResults.find((r) => r && r.ac_index === e.ac_index) ?? {}),
    ac_index: e.ac_index, observational: true, satisfied: false, verified_by: 'local', unreachable_env: false,
    evidence: `AC のコマンド（\`${e.command}\`）が ${acVerifyHow(e)}${e.reason ? `（${e.reason}）` : ''}（差し戻し上限まで直らなかった）: ${e.log_path ?? 'log なし'}`,
  }))
  return [...kept, ...replaced].sort((a, b) => (Number.isInteger(a?.ac_index) ? a.ac_index : Infinity) - (Number.isInteger(b?.ac_index) ? b.ac_index : Infinity))
}

// AC 未達の actor 別内訳（unsatisfiedAcByActor の形）に AC コマンドの記録を重ねる（Final reconcile の最終判定）。
// 差し戻し上限後も失敗した AC だけを agent に入れる（human から外す — actor は 'human' のまま unsatisfiedAcByActor が
// 人手 AC 待ちに数えるため）。失敗以外の記録は内訳を変えない（passed でも人手 AC のまま）。他のキー（ci 等）は変えない。
export function mergeAcVerifyGaps(byActor, entries) {
  const src = byActor && typeof byActor === 'object' ? byActor : {}
  const failed = (Array.isArray(entries) ? entries : []).filter((e) => e && Number.isInteger(e.ac_index) && e.status === 'failed').map((e) => e.ac_index)
  const agent = Array.isArray(src.agent) ? [...src.agent] : []
  for (const k of failed) if (!agent.includes(k)) agent.push(k)
  const human = (Array.isArray(src.human) ? src.human : []).filter((k) => !failed.includes(k))
  return { ...src, agent: agent.sort((a, b) => a - b), human: [...human].sort((a, b) => a - b) }
}
