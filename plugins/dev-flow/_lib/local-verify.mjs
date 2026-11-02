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
// AC コマンド（issue #1203）: 観測型 AC のうち、AC 自体が inline code で指定したコマンド（_lib/ac-actor.mjs の freezeAcVerify が
// analyze ゲートで凍結した verify_command / expect_paths）も同じ local-verify で sandbox 内で実行する（db の無い宣言 —
// pg-broker を呼ばない。宣言は --config-pct で渡し、worktree の宣言とは突き合わせない）。
//   Validate green 後に 1 本ずつ実行する（acVerifyValidateAction）。passed は demoteUnprovenObservationalAc の proven に入れる
//     （evaluator の satisfied:true を倒さないだけ。evaluator の未達は覆さず、ledger の deterministic 昇格にもしない — exit code は
//     PR が書き換えうるコマンド・テストの出力のため）。
//     failed / timeout は log_tail を付けて dev-implementer へ差し戻す（AGENT_AC_REIMPL_MAX を ci の AC・Evaluate と共有）。
//     上限後も失敗なら agent の未達（ac_agent_unsatisfied）。unavailable / error は proven にせず人手 AC 待ちのまま
//   Final reconcile は passed を出した tree と最終 tree が異なるときだけ再実行する（acVerifyFinalAction。ci の AC の
//     tree_hash の突合と同じ規則）。最終 tree の passed だけが達成の根拠になる
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

// ---- AC コマンド（issue #1203） ----

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
//   'passed': proven の候補（Final reconcile で最終 tree と突き合わせる）
//   'reimpl': failed / timeout で差し戻し回数（reimplCount。ci の AC・Evaluate と共有）が reimplMax 未満 → log_tail を付けて差し戻す
//   'failed': 差し戻し上限後も失敗 → agent の未達（ac_agent_unsatisfied）
//   'unproven': unavailable / error / running（終わらない）→ proven にしない
// reimplMax は呼び出し側が AGENT_AC_REIMPL_MAX を渡す（本ファイルは ac-actor.mjs を import できないため）。
export function acVerifyValidateAction(verdict, reimplCount, reimplMax) {
  if (verdict === 'passed') return 'passed'
  if (verdict === 'failed') return reimplCount < reimplMax ? 'reimpl' : 'failed'
  return 'unproven'
}

// Final reconcile: AC コマンドの記録（{ status, tree_hash }）と最終 tree の diff hash から経路を決める。
//   'proven': passed を出した tree が最終 tree と一致する（hash が取れたときだけ）
//   'rerun': passed だが tree が異なる・最終 tree の hash が取れない → 最終 tree で 1 回だけ再実行する（差し戻しはしない）
//   'failed': 差し戻し上限後も失敗した記録 → agent の未達のまま
//   'unproven': unavailable / error / skipped / stale → 達成の根拠にしない
export function acVerifyFinalAction(entry, finalTreeHash) {
  if (entry?.status === 'passed') return typeof finalTreeHash === 'string' && entry.tree_hash === finalTreeHash ? 'proven' : 'rerun'
  if (entry?.status === 'failed') return 'failed'
  return 'unproven'
}

// passed の AC コマンドの記録の ac_index。demoteUnprovenObservationalAc の provenIndexes に足す。
// Final reconcile の後は最終 tree で passed のものだけが passed のまま残る（突き合わせられなかったものは stale）。
export function acVerifyProvenIndexes(entries) {
  return (Array.isArray(entries) ? entries : []).filter((e) => e && e.status === 'passed' && Number.isInteger(e.ac_index)).map((e) => e.ac_index)
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

// AC コマンドの記録 1 件を ac_results の 1 要素にする（r は evaluator / final-ac-reconcile の同じ AC の結果。無ければ null）。
// passed は evaluator の判定を保ち、コマンド・exit code・log_path を根拠に添えるだけにする（evaluator が satisfied:true の
// ときだけ達成。結果が無ければ確かめられなかった扱い）。exit code は PR が書き換えうるコマンド・テストの出力なので、それだけで
// evaluator の未達を覆さない（incentive-structural）。failed は agent の未達、それ以外は実行で確かめられなかった
// 観測型 AC として unreachable_env:true の未達（差し戻さず人手 AC 待ち — 差し戻しても AC コマンドは再実行されないため）。
function acVerifyResult(e, r) {
  const base = { ...(r ?? {}), ac_index: e.ac_index, observational: true }
  if (e.status === 'passed') {
    const run = `AC のコマンド（\`${e.command}\`）が exit ${e.exit_code ?? 0}: ${e.log_path ?? 'log なし'}`
    if (r?.satisfied === true) return { ...base, satisfied: true, unreachable_env: false, evidence: `${run}${typeof r.evidence === 'string' && r.evidence.trim() ? `（evaluator: ${r.evidence.trim()}）` : ''}` }
    if (r) return { ...base, satisfied: false, evidence: `evaluator が未達と判定（AC のコマンドの exit 0 だけでは達成にしない）: ${typeof r.evidence === 'string' ? r.evidence : ''} / ${run}` }
    return { ...base, satisfied: false, unreachable_env: true, evidence: `evaluator の判定が無い（AC のコマンドの exit 0 だけでは達成にしない）: ${run}` }
  }
  if (e.status === 'failed') {
    return { ...base, satisfied: false, verified_by: 'local', unreachable_env: false, evidence: `AC のコマンド（\`${e.command}\`）が ${acVerifyHow(e)}${e.reason ? `（${e.reason}）` : ''}（差し戻し上限まで直らなかった）: ${e.log_path ?? 'log なし'}` }
  }
  return { ...base, satisfied: false, unreachable_env: true, evidence: `AC のコマンド（\`${e.command}\`）で確かめられなかった（${e.status}${e.reason ? `: ${e.reason}` : ''}）` }
}

// ac_results の AC コマンドの AC を記録の結果で置き換える（無ければ足す）。passed は evaluator の判定に根拠を添えるだけ、
// failed / 確かめられなかった記録は未達にする（acVerifyResult）。記録が無い・非配列はそのまま返す。
export function applyAcVerifyResults(acResults, entries) {
  if (!Array.isArray(acResults)) return acResults
  const list = (Array.isArray(entries) ? entries : []).filter((e) => e && Number.isInteger(e.ac_index))
  if (!list.length) return acResults
  const decided = new Set(list.map((e) => e.ac_index))
  const kept = acResults.filter((r) => !(r && decided.has(r.ac_index)))
  const replaced = list.map((e) => acVerifyResult(e, acResults.find((r) => r && r.ac_index === e.ac_index) ?? null))
  return [...kept, ...replaced].sort((a, b) => (Number.isInteger(a?.ac_index) ? a.ac_index : Infinity) - (Number.isInteger(b?.ac_index) ? b.ac_index : Infinity))
}

// AC 未達の actor 別内訳（unsatisfiedAcByActor の形）に AC コマンドの記録を重ねる（Final reconcile の最終判定）。
// passed は内訳を変えない（evaluator の判定のまま — exit 0 だけで未達を外さない）、failed は agent に入れる（human から外す）。
// それ以外（unavailable / error / skipped / stale）は human に入れる（applyAcVerifyResults の unreachable_env と同じ扱い — Evaluate では passed だったが最終 tree で
// 確かめられなかった AC も人手 AC 待ちにする）。他のキー（ci 等）は変えない。
export function mergeAcVerifyGaps(byActor, entries) {
  const src = byActor && typeof byActor === 'object' ? byActor : {}
  let agent = Array.isArray(src.agent) ? [...src.agent] : []
  let human = Array.isArray(src.human) ? [...src.human] : []
  for (const e of (Array.isArray(entries) ? entries : [])) {
    if (!e || !Number.isInteger(e.ac_index) || e.status === 'passed') continue
    const k = e.ac_index
    agent = agent.filter((x) => x !== k)
    human = human.filter((x) => x !== k)
    if (e.status === 'failed') agent.push(k)
    else human.push(k)
  }
  return { ...src, agent: agent.sort((a, b) => a - b), human: human.sort((a, b) => a - b) }
}
