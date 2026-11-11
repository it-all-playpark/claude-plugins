// visual-snapshots: repo が "dev-flow".visual_snapshots（基準画像を撮り直すコマンドと基準画像のディレクトリ paths）を宣言した
// run で、dev-flow-evaluate が Evaluate の各評価の前に基準画像を撮り直す経路の純関数（issue #1410）。
//
// 各評価（eval#i）の前に worktree の tree を取り、最後に撮影した tree と違えば、宣言コマンドを plugin bin/ の local-verify
// （paths のある宣言。切り離した実行・使い捨て DB・上限時間）で head の worktree に対して実行する。撮影は評価の前なので、
// 変わった PNG は評価される tree に入り、Evaluate と PR の間の diff hash の照合はそのまま成り立つ。
//   passed: command が変えたのは paths の下の PNG だけ（local-verify が確かめた）→ PNG を worktree に残す
//   failed / timeout / unavailable / error: 表示だけ（fail-open）。その撮影の PNG は入れず（local-verify が worktree を
//     command の前に戻す）、評価と PR は続ける。理由を PR 本文の「画面の変化」に 1 行出す
//   exit 0 でも paths の下の PNG 以外が変わった: local-verify がその撮影の結果をすべて捨てて command の前に戻す。
//     変わったパスを添えて理由を出す
// 撮影の成否は merge tier・HOLD 理由・差し戻しに使わない — 撮影コマンドは PR のコードを実行するので、その結果で gate を
// 動かすと PR の内容で判定を誘導できる。確かめるのは人間（Files changed の画像差分）。
//
// INLINE COPY POLICY: workflow から参照される最上位宣言だけが tools/sync-inlines.mjs --write で inline 生成される。
// 直接 workflow 側を編集しない。一致は _lib/workflow-inlines.sync.test.mjs が検証する。
// 制約: ESM import / require / Date.now / Math.random を含めない。export function / export const のみ。

// local-verify の state dir（worktree 内の .devflow-tmp は git に無視され、tree にも realized diff にも入らない）。
// ci の AC の local-verify・AC コマンドの state dir と分ける。
export const VISUAL_SNAPSHOTS_STATE_DIR = '.devflow-tmp/visual-snapshots'
// 理由に並べる「paths の下の PNG 以外で変わったパス」の件数。超過分は件数だけ出す。
export const VISUAL_SNAPSHOTS_OUTSIDE_SHOWN = 5
// 撮影の結果を捨てたのに worktree が command の前の tree に戻っていないときに理由へ足す文。
export const VISUAL_SNAPSHOTS_UNRESTORED_NOTE = '（worktree を撮影前の状態に戻し切れていない。Files changed で意図しない変更が無いか確かめる）'

const VISUAL_SNAPSHOTS_GUARD = {
  type: ['object', 'null'],
  properties: {
    tree_before: { type: 'string' }, tree: { type: ['string', 'null'] }, discarded: { type: 'boolean' }, restored: { type: ['boolean', 'null'] },
    outside: { type: 'array', items: { type: 'string' } }, outside_count: { type: 'number' },
  },
}
// local-verify start / wait の stdout JSON（paths のある宣言は snapshot が付く。_shared/scripts/local-verify.sh）。
export const VISUAL_SNAPSHOTS_RESULT = {
  type: 'object', required: ['ok', 'status'],
  properties: {
    ok: { type: 'boolean' }, status: { type: 'string', enum: ['running', 'passed', 'failed', 'timeout', 'stopped', 'unavailable', 'error'] },
    exit_code: { type: ['number', 'null'] }, log_path: { type: 'string' }, log_tail: { type: 'string' }, reason: { type: 'string' }, error: { type: 'string' },
    db_deleted: { type: ['boolean', 'null'] }, snapshot: VISUAL_SNAPSHOTS_GUARD,
  },
}
// local-verify stop の stdout JSON。
export const VISUAL_SNAPSHOTS_STOP = {
  type: 'object', required: ['ok'],
  properties: {
    ok: { type: 'boolean' }, stopped: { type: 'boolean' }, was_running: { type: 'boolean' }, db_deleted: { type: ['boolean', 'null'] },
    error: { type: 'string' }, snapshot: VISUAL_SNAPSHOTS_GUARD,
  },
}

function visualSnapshotsOneLine(v) {
  return String(v ?? '').replace(/\s+/g, ' ').trim()
}

// 1 回の撮影（local-verify wait の応答 res と、localVerifyVerdict で畳んだ verdict）を決着に畳む。
//   captured: その撮影の PNG を worktree に残したか（passed のときだけ。local-verify は paths の下の PNG 以外が変わった
//     exit 0 を failed にするので、passed は「変わったのは paths の下の PNG だけ」を含む）
//   tree: 終了後の worktree の tree OID（local-verify の snapshot.tree。無ければ null — 呼び出し側が取り直す）
//   restored: 結果を捨てたとき worktree を command の前に戻せたか（local-verify の snapshot.restored。分からなければ null）
//   note: 撮影できなかった・結果を捨てた理由（PR 本文の「画面の変化」に 1 行で出す。captured なら null）
export function visualSnapshotsOutcome(res, verdict, timeoutSeconds) {
  const snap = res != null && typeof res === 'object' && res.snapshot != null && typeof res.snapshot === 'object' ? res.snapshot : null
  const tree = typeof snap?.tree === 'string' && snap.tree ? snap.tree : null
  if (verdict === 'passed') return { captured: true, tree, restored: null, note: null }
  const outside = (Array.isArray(snap?.outside) ? snap.outside : []).filter((p) => typeof p === 'string' && p).map(visualSnapshotsOneLine)
  const detail = (v) => (visualSnapshotsOneLine(v) ? `（${visualSnapshotsOneLine(v).slice(0, 200)}）` : '')
  let note
  if (outside.length) {
    const total = Number.isInteger(snap.outside_count) && snap.outside_count > outside.length ? snap.outside_count : outside.length
    const shown = outside.slice(0, VISUAL_SNAPSHOTS_OUTSIDE_SHOWN)
    note = `撮影のコマンドが paths の下の PNG 以外を変えたため、この撮影の結果をすべて捨てた: ${shown.join(', ')}${total > shown.length ? ` ほか ${total - shown.length} 件` : ''}`
  } else if (res?.status === 'timeout') {
    note = `撮影のコマンドが上限時間（${timeoutSeconds} 秒）を超えて止められたため、この撮影の PNG は入れていない`
  } else if (res?.status === 'failed') {
    note = `撮影のコマンドが exit ${res.exit_code ?? '?'} で失敗したため、この撮影の PNG は入れていない${detail(res.reason)}`
  } else if (verdict === 'unavailable') {
    note = `使い捨ての DB を確保できなかったため撮影できなかった${detail(res?.reason)}`
  } else if (verdict === 'running') {
    note = `撮影が上限時間（${timeoutSeconds} 秒）を過ぎても終わらなかったため、この撮影の PNG は入れていない`
  } else {
    note = `撮影の結果を取得できなかったため、この撮影の PNG は入れていない${detail(res?.error ?? res?.reason ?? 'proxy の応答が無い・形が不正')}`
  }
  return { captured: false, tree, restored: typeof snap?.restored === 'boolean' ? snap.restored : null, note }
}

// evaluator の prompt に足す注記（宣言のある run だけ）。撮影が入れた PNG は plan にも PR 本文のプレビューにも無いので、
// 実装エージェントの宣言外変更として指摘させない。画像の中身は evaluator ではなく人間が PR の画像差分で確かめる。
export function visualSnapshotsEvalNote(decl) {
  if (decl == null || !Array.isArray(decl.paths)) return ''
  return `visual_snapshots: realized diff のうち ${JSON.stringify(decl.paths)} の下の PNG は、パイプラインが評価の前に撮影コマンドで撮り直した基準画像で、`
    + `実装エージェントの変更ではない。plan に無いことを指摘にせず、画像の中身も判定しない（人間が PR の Files changed の画像差分で確かめる）。\n`
}

function visualSnapshotsShellArg(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

// PR の差分（origin/<base> と tree の間）で、宣言の paths の下で変わった PNG の一覧を取る read-only exec-proxy の prompt。
// 一致の判定は git の pathspec（`:(glob)<path>/**/*.png`。local-verify の後始末と同じ規則）に任せる。
export function visualSnapshotsListPrompt({ wt, base, tree, paths }) {
  const specs = paths.map((p) => visualSnapshotsShellArg(`:(top,glob)${String(p).replace(/\/+$/, '')}/**/*.png`)).join(' ')
  return `次のコマンドを **先頭トークンが git の bare 単文** で 1 回だけ実行し、stdout の各行を配列 lines に一字一句そのまま（要約・整形・並べ替え・件数制限をせず）入れて {"ok": true, "lines": [...]} で返せ`
    + `（stdout が空なら {"ok": true, "lines": []}。exit 非0・コマンド実行不能なら ok:false/error で返せ。失敗時に ok:true を生成してはならない。`
    + `cd 前置・\`bash\` 前置・環境変数代入前置・&& 連結・パイプ・リダイレクトは禁止。-C で worktree を渡しているため cd は不要）:\n`
    + `git -C ${wt} -c core.quotePath=false diff --name-only --no-renames origin/${base} ${tree} -- ${specs}`
}

// PR 本文の「画面の変化」の材料（buildPrBody の visualSnapshots）。list は visualSnapshotsListPrompt の応答（取れなければ null）、
// note は最後の撮影の理由（撮影できた・撮影していないなら null）。一覧が取れなかった run はその旨を理由に足す。
export function visualSnapshotsReport(list, note) {
  const listed = list != null && list.ok === true && Array.isArray(list.lines)
  const changed = listed ? [...new Set(list.lines.filter((l) => typeof l === 'string').map((l) => l.replace(/\r$/, '')).filter((l) => l.trim() !== ''))] : []
  const notes = [
    ...(typeof note === 'string' && note ? [note] : []),
    ...(listed ? [] : ['変わった基準画像の一覧を取得できなかった（Files changed で確かめる）']),
  ]
  return { changed, notes }
}
