// visual-snapshots: repo が "dev-flow".visual_snapshots（基準画像を撮り直すコマンドと基準画像のディレクトリ paths）を宣言した
// run で、基準画像を撮り直す経路の部品。dev-flow-evaluate（Evaluate の各評価の前）と pr-iterate（各 review の前）が使う。
//
// 撮影の単位は worktree の tree OID（worktree-diff-hash。staged + unstaged + untracked）。撮影の前に tree を取り、最後に撮影した
// tree と違えば、宣言コマンドを plugin bin/ の local-verify（paths のある宣言。切り離した実行・使い捨て DB・上限時間）で
// head の worktree に対して実行する。evaluate は評価の前に撮るので、変わった PNG は評価される tree に入る。pr-iterate は
// review の前に撮り、変わった PNG を commit・push してから review するので、review は撮り直した PNG を含む head を見る。
//   passed: command が変えたのは paths の下の PNG だけ（local-verify が確かめた）→ PNG を worktree に残す
//   failed / timeout / unavailable / error: 表示だけ（fail-open）。その撮影の PNG は入れず（local-verify が worktree を
//     command の前に戻す）、呼び出し元の処理は続ける。理由を「画面の変化」に 1 行出す
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

// 最後に撮影できた tree と最終の tree が違う run の「画面の変化」に出す 1 行（pr-iterate の終わり。表示だけで gate に使わない）。
export const VISUAL_SNAPSHOTS_STALE_NOTE = '最終の画面は撮り直せていない（PNG は前の tree のもの）'

// 「画面の変化」の材料（buildPrBody の visualSnapshots・pr-iterate の終了レポート）。list は visualSnapshotsListPrompt の応答
// （取れなければ null）、note は最後の撮影の理由（撮影できた・撮影していないなら null）、stale は最後に撮影できた tree が
// 最終の tree と違うか。一覧が取れなかった run はその旨を理由に足す。
export function visualSnapshotsReport(list, note, stale = false) {
  const listed = list != null && list.ok === true && Array.isArray(list.lines)
  const changed = listed ? [...new Set(list.lines.filter((l) => typeof l === 'string').map((l) => l.replace(/\r$/, '')).filter((l) => l.trim() !== ''))] : []
  const notes = [
    ...(typeof note === 'string' && note ? [note] : []),
    ...(stale === true ? [VISUAL_SNAPSHOTS_STALE_NOTE] : []),
    ...(listed ? [] : ['変わった基準画像の一覧を取得できなかった（Files changed で確かめる）']),
  ]
  return { changed, notes }
}

// ---- 撮影と一覧の実行（evaluate と pr-iterate で共用）----
// agent の起動は呼び出し元が渡す spawn(prompt, { agentType, schema, label, retryOnContractViolation? })（throw せず、
// 取れなければ null を返すもの）で行う。local-verify の値と判定（_lib/local-verify.mjs）・waitBgJob（_lib/bg-job-wait.mjs）は
// 同じ workflow に inline されたものを使う。

// worktree の tree OID を取る read-only exec-proxy の prompt と応答。
export const VISUAL_SNAPSHOTS_TREE = {
  type: 'object', required: ['hash', 'empty'],
  properties: { hash: { type: 'string' }, empty: { type: 'boolean' }, epoch: { type: 'number' } },
}
export function visualSnapshotsTreePrompt(wt) {
  return `次のコマンドを **先頭トークンが worktree-diff-hash の bare 単文** で 1 回だけ実行し、**stdout の JSON 1 行をそのまま** verbatim で返せ（判定や脚色をしない）。`
    + `argv は一字一句そのまま実行する — which による絶対パス解決・絶対パスへの書き換え・cd 前置・\`bash\` 前置・環境変数代入前置・&& 連結は禁止`
    + `（第 1 引数で worktree 絶対パスを渡しているため cd は不要）:\n`
    + `worktree-diff-hash ${wt} HEAD`
}
// visualSnapshotsListPrompt の応答。
export const VISUAL_SNAPSHOTS_LINES = {
  type: 'object', required: ['ok'],
  properties: { ok: { type: 'boolean' }, lines: { type: 'array', items: { type: 'string' } }, error: { type: 'string' } },
}

// 撮影の run の状態。lastTree は最後に撮影を試みた後の tree（失敗した撮影の tree も記録する — 同じ tree で同じコマンドを
// 繰り返さない）、note は最後の撮影の理由（撮影できたら null）。
export function visualSnapshotsRunState(lastTree = null) {
  return { lastTree, attempts: 0, note: null }
}

// 1 回の撮影: tree を取り、最後に撮影した tree と違えば宣言コマンドを local-verify で実行する。
//   readTree(when): 今の worktree の tree OID（取れなければ null）。when は 'before' | 'after'
//   at: log に出す「どの処理の前か」（eval#1・review#2 等）、carryOn: 失敗しても続ける処理の呼び名
// start には検証済みの宣言を --config-pct で渡す（worktree の設定ファイルは読ませない）。stop は finally で必ず呼ぶ
// （呼ばれなくても supervisor の trap が DB の削除と worktree の後始末をする）。途中の例外もここで受けて理由にする —
// 表示だけの処理の失敗で呼び出し元を止めない。
// 返り値 { attempted, captured, before, after }: attempted は撮影コマンドを起動したか、captured はその撮影の PNG を
// worktree に残したか、before / after は撮影の前後の tree（取れなければ null）。
export async function captureVisualSnapshots({ decl, wt, run, readTree, at, carryOn, spawn, log }) {
  try {
    return await captureVisualSnapshotsOnce({ decl, wt, run, readTree, at, carryOn, spawn, log })
  } catch (e) {
    run.note = `撮影の途中で例外が起きたため、撮影の結果を確かめられていない（${String(e && e.message ? e.message : e).slice(0, 200)}）`
    run.lastTree = null
    log(`⚠️ visual-snapshots: ${at} の前の撮影が例外 — ${carryOn}（fail-open）: ${e && e.message ? e.message : e}`)
    return { attempted: true, captured: false, before: null, after: null }
  }
}
async function captureVisualSnapshotsOnce({ decl, wt, run, readTree, at, carryOn, spawn, log }) {
  const before = await readTree('before')
  if (before == null) {
    run.note = '撮影前の worktree の tree を取得できなかったため撮影していない'
    log(`⚠️ visual-snapshots: ${at} の前の tree を取得できない — 撮影しない（fail-open）`)
    return { attempted: false, captured: false, before: null, after: null }
  }
  if (before === run.lastTree) {
    log(`visual-snapshots: ${at} — tree が最後に撮影した tree と同じ（撮り直さない）`)
    return { attempted: false, captured: false, before, after: before }
  }
  const n = ++run.attempts
  const stateDir = `${wt}/${VISUAL_SNAPSHOTS_STATE_DIR}`
  const proxy = (cmd) => `次を Bash で **timeout 600000** を指定して 1 回だけ実行し、**stdout の JSON object をそのまま** 返せ`
    + `（判定や脚色をしない。失敗時に ok:true を生成してはならない。& や nohup を足さない — 常駐化はコマンド自身が行う）:\n${cmd}`
  const runner = (schema, label) => ({ agentType: 'dev-runner-haiku', schema, label })
  let res = null
  try {
    const start = await spawn(
      proxy(`local-verify start --worktree '${wt}' --state-dir '${stateDir}' --wait-sec ${LOCAL_VERIFY_START_WAIT_SEC} --config-pct ${localVerifyConfigArg(decl)}`),
      runner(VISUAL_SNAPSHOTS_RESULT, `visual-snapshots-start#${n}`),
    )
    res = await waitBgJob({
      start,
      wait: (k) => spawn(
        proxy(`local-verify wait --state-dir '${stateDir}' --wait-sec ${LOCAL_VERIFY_WAIT_SEC}`),
        runner(VISUAL_SNAPSHOTS_RESULT, `visual-snapshots-wait#${n}.${k}`),
      ),
      maxPolls: localVerifyWaitPolls(decl.timeout_seconds),
      schema: VISUAL_SNAPSHOTS_RESULT,
    })
  } finally {
    const stop = await spawn(proxy(`local-verify stop --state-dir '${stateDir}'`), runner(VISUAL_SNAPSHOTS_STOP, `visual-snapshots-stop#${n}`))
    if (!stop || stop.ok !== true) log(`⚠️ visual-snapshots-stop#${n}: 停止を確認できない（${stop?.error ?? 'proxy の応答が無い'}）— 後片付けは local-verify の supervisor の trap に委ねる`)
  }
  const outcome = visualSnapshotsOutcome(res, localVerifyVerdict(res), decl.timeout_seconds)
  // 終了後の tree は local-verify の応答（snapshot.tree）から取る。応答に無いときだけ取り直す
  const after = outcome.tree ?? await readTree('after')
  const unrestored = !outcome.captured && (outcome.restored === false || (outcome.restored == null && after != null && after !== before))
  run.note = outcome.captured ? null : `${outcome.note}${unrestored ? VISUAL_SNAPSHOTS_UNRESTORED_NOTE : ''}`
  run.lastTree = after
  log(outcome.captured
    ? `visual-snapshots#${n}: 撮影した（${at} の前。tree ${before.slice(0, 8)} → ${after ? after.slice(0, 8) : '不明'}${after === before ? '。変わった基準画像なし' : ''}）`
    : `⚠️ visual-snapshots#${n}: ${run.note} — ${carryOn}（fail-open）`)
  return { attempted: true, captured: outcome.captured, before, after }
}

// 「画面の変化」の材料を取る: origin/<base> と tree（tree OID か commit sha）の間で、宣言の paths の下で変わった PNG の一覧と、
// 最後の撮影の理由 note・stale。base か tree が分からない・取得に失敗した run は一覧なしの理由を足す（fail-open）。
export async function reportVisualSnapshots({ decl, wt, base, tree, note, stale = false, spawn, log }) {
  let list = null
  try {
    list = !base || tree == null ? null : await spawn(
      visualSnapshotsListPrompt({ wt, base, tree, paths: decl.paths }),
      { agentType: 'dev-runner-haiku-ro', schema: VISUAL_SNAPSHOTS_LINES, label: 'visual-snapshots-list', retryOnContractViolation: true },
    )
  } catch (e) { log(`⚠️ visual-snapshots-list が例外 — 一覧なしで続ける（fail-open）: ${e && e.message ? e.message : e}`) }
  return visualSnapshotsReport(list, note, stale)
}

// ---- pr-iterate の撮り直しの commit ----
// 撮り直しで変わった PNG を「画面の変化（撮り直し）」の commit として PR ブランチに push する exec-proxy の prompt と応答。
// stage と commit は宣言の paths の下の PNG（git の pathspec）だけに限る — worktree に前からある変更を PR に commit しない。
// push は呼び出し元の pushSteps（pr-push の start / wait）で行い、最初の wait までの結果を push_result で返す。
export const VISUAL_SNAPSHOTS_COMMIT_SUBJECT = '画面の変化（撮り直し）'
export const VISUAL_SNAPSHOTS_COMMIT = {
  type: 'object', required: ['committed', 'pushed'],
  properties: {
    head_before: { type: 'string' }, committed: { type: 'boolean' }, pushed: { type: 'boolean' }, head_sha: { type: 'string' },
    push_result: { type: 'object' },
  },
}
function visualSnapshotsPngSpecs(paths) {
  return paths.map((p) => visualSnapshotsShellArg(`:(top,glob)${String(p).replace(/\/+$/, '')}/**/*.png`)).join(' ')
}
// git add・git commit・git restore は合致するファイルが 1 つも無い pathspec があると失敗する（PNG の無い path を 1 つ含むだけで
// commit も取り消しもできない）。commit・取り消しの pathspec は、撮り直しで PNG が変わった path だけに絞る。
// 変わった PNG の一覧を取る read-only exec-proxy の prompt（応答は VISUAL_SNAPSHOTS_LINES。ls-files は合致しない pathspec で失敗しない）。
export function visualSnapshotsChangedPrompt({ wt, paths }) {
  return `次のコマンドを **先頭トークンが git の bare 単文** で 1 回だけ実行し、stdout の各行を配列 lines に一字一句そのまま（要約・整形・並べ替え・件数制限をせず）入れて {"ok": true, "lines": [...]} で返せ`
    + `（stdout が空なら {"ok": true, "lines": []}。exit 非0・コマンド実行不能なら ok:false/error で返せ。失敗時に ok:true を生成してはならない。`
    + `cd 前置・\`bash\` 前置・環境変数代入前置・&& 連結・パイプ・リダイレクトは禁止。-C で worktree を渡しているため cd は不要）:\n`
    + `git -C ${wt} -c core.quotePath=false ls-files --modified --deleted --others --exclude-standard -- ${visualSnapshotsPngSpecs(paths)}`
}
// 宣言の paths のうち、一覧（visualSnapshotsChangedPrompt の応答）に PNG がある path。一覧が取れなければ null。
// 一覧のファイル名は path の振り分けにだけ使い、コマンドには入れない（pathspec は宣言の paths から作る）。
export function visualSnapshotsChangedPaths(paths, list) {
  if (list == null || list.ok !== true || !Array.isArray(list.lines)) return null
  const files = list.lines.filter((l) => typeof l === 'string').map((l) => l.replace(/\r$/, '').replace(/^"/, ''))
  return paths.filter((p) => {
    const dir = `${String(p).replace(/^(\.\/)+/, '').replace(/\/+$/, '')}/`
    return files.some((f) => f.startsWith(dir))
  })
}
export function visualSnapshotsCommitPrompt({ wt, pr, headRef, paths, pushSteps }) {
  const specs = visualSnapshotsPngSpecs(paths)
  return `## Objective\n撮り直した基準画像の PNG を PR #${pr} のブランチに commit・push し、commit の前後の head sha を返す。\n\n`
    + `## Steps\n以下を順に bare 単文（先頭トークンが git・pr-push のいずれか。cd 前置・bash 前置・env 代入前置・&& 連結禁止）で実行せよ:\n`
    + `1. \`git -C ${wt} rev-parse HEAD\` を実行し、stdout の 40 桁 hex をそのまま head_before とする（失敗時は空文字）。\n`
    + `2. \`git add -- ${specs}\` を実行する（一字一句そのまま 1 回。パスを書き換え・追加・削除しない。ほかの add は実行しない）。\n`
    + `3. \`git commit -m "test(pr-${pr}): ${VISUAL_SNAPSHOTS_COMMIT_SUBJECT}" -- ${specs}\` を実行する。exit 0 なら committed:true。`
    + `それ以外は committed:false, pushed:false として push せずに手順 6 へ進む（原因調査・再試行をしない）。\n`
    + `4. push する。${pushSteps}失敗・timeout・running でも手順 5 へ進む。\n`
    + `5. \`git -C ${wt} rev-list ${visualSnapshotsShellArg(`origin/${headRef}..HEAD`)} --count\` を実行する。警告行を除いた出力が 0 なら pushed:true。コマンド失敗または非数値出力なら pushed:false。\n`
    + `6. \`git -C ${wt} rev-parse HEAD\` を実行し、stdout の 40 桁 hex をそのまま head_sha とする（失敗時は空文字）。\n`
    + `7. { "head_before": <1の結果>, "committed": <3の結果>, "pushed": <5の結果>, "head_sha": <6の結果>, "push_result": <4の push_result。手順 4 で push しなければキーごと省く> } を返す。\n\n`
    + `## Output format\n{ "head_before": string, "committed": boolean, "pushed": boolean, "head_sha": string, "push_result": object }\nprose 禁止。JSON のみ返せ。\n\n`
    + `## Tools\n使用可: Bash, Read\n\n## Boundary\n上記コマンド以外のファイル変更・git 操作禁止。\n\n## Token cap\nJSON のみ。1 行以内。`
}
// 撮り直しの commit・push に失敗したときに、その commit を取り消して paths の下の PNG を撮り直しの前（sha）に戻す exec-proxy の
// prompt と応答。戻すのは paths の下の PNG だけ（reset は --soft。worktree のほかの変更に触れない）。
export const VISUAL_SNAPSHOTS_REVERT = { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' }, error: { type: 'string' } } }
export function visualSnapshotsRevertPrompt({ sha, paths }) {
  const specs = visualSnapshotsPngSpecs(paths)
  return `## Objective\npush できなかった基準画像の撮り直しの commit を取り消し、基準画像の PNG を撮り直しの前の状態に戻す。\n\n`
    + `## Steps\n以下を順に bare 単文（先頭トークンが git。cd 前置・bash 前置・env 代入前置・&& 連結禁止）で 1 回ずつ実行せよ:\n`
    + `1. \`git reset --soft ${sha}\`\n`
    + `2. \`git restore --source=${sha} --staged --worktree -- ${specs}\`\n`
    + `両方 exit 0 なら {"ok": true}。どちらかが exit 非 0 なら {"ok": false, "error": <stderr の要旨>} を返す（再試行・原因調査をしない。失敗時に ok:true を生成してはならない）。\n\n`
    + `## Output format\n{ "ok": boolean, "error": string }\nprose 禁止。JSON のみ返せ。\n\n`
    + `## Tools\n使用可: Bash\n\n## Boundary\n上記コマンド以外のファイル変更・git 操作禁止。push しない。\n\n## Token cap\nJSON のみ。1 行以内。`
}
// 撮り直しの commit を push した round の review の prompt に足す 1 行。conflict の自動解消の直後（remerge）は読む範囲が
// merge commit だけなので、撮り直しの commit も読ませる（delta は範囲に入り、full は PR 全体を読む）。
export function visualSnapshotsReviewNote({ sha, scope, paths }) {
  return `この review の前に、パイプラインが基準画像を撮り直した commit ${sha}（${JSON.stringify(paths)} の下の PNG だけ）を PR ブランチに push した。`
    + `review の対象の head はこの commit を含む。`
    + (scope === 'remerge' ? `上の範囲に加えて \`git show --stat ${sha}\` でこの commit の変更も確かめる。` : '')
    + `画像の中身は判定しない（人間が PR の Files changed の画像差分で確かめる）。\n`
}
