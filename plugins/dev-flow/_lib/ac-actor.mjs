// _lib/ac-actor.mjs
// AC を actor（'agent' | 'human' | 'ci'）に決定論分類し、Evaluate の差し戻しと Merge tier の HOLD 理由を actor で
// 分ける純関数群（issue #747）。
//
// actor の意味:
//   - 'agent': 実装エージェントが worktree 内で満たせる AC（ローカル計測して PR 本文に書く、を含む）。
//     evaluator が satisfied:false を返したら gate_policy に依らず dev-implementer へ差し戻す。
//     差し戻し上限を使い切っても未達なら Merge tier は 'ac_agent_unsatisfied'（ループの取りこぼし）で HOLD。
//   - 'human': `（人手）` 表記・staging / 本番環境・外部サービスの操作・issue へのコメントを要する AC。
//     エージェントは worktree の外に出ない（agents/dev-implementer.md）ので差し戻しても満たせない。
//     未達は差し戻さず Merge tier の 'ac_human_pending'（人手 AC 待ち）へ回す。
//   - 'ci': sandbox 内で実行できない検証（E2E 等）を repo が CI の check で判定すると宣言した AC（issue #861）。
//     repo の skill-config.json / .claude/skill-config.json の "dev-flow".ci_verify（{label, checks, commands,
//     wait_ceiling_seconds}）の commands のどれかを inline code で書いた AC、または label に言及した AC。
//     evaluator は判定せず、reimpl / Evaluate の差し戻しにも回さない。PR に label を付け、pr-iterate の LGTM 後に
//     checks の完了を待って、その結果で satisfied を決める。未完了は Merge tier の 'ac_ci_pending'。
//     判定は repo が宣言した規則だけを使う（汎用の E2E 語の正規表現・Jev は使わない — 語彙の違う repo で
//     誤判定を語の追加で直す方式は収束しないため）。
// 判定できない AC は 'agent' に倒す。human への誤分類は差し戻しを失い未達のまま人間へ流れるが、agent への誤分類は
// 差し戻しの上限（AGENT_AC_REIMPL_MAX）で止まり、HOLD 理由に取りこぼしとして残るため。
// agent の AC でも、作り直しで埋まらない gap（isReimplUnfixableGap）は差し戻しの上限まで回さず人手 AC 待ちに数える
// （unsatisfiedAcByActor）。evaluator が未達の理由を実行環境に届かない（unreachable_env:true）と返したものと、
// evaluator が満たしたと判定したが red→green の実証が無い観測型 AC（proof_missing:true。非退行の AC のように変更前から
// テストが green なら作り直しで red→green を作れない）がこれに当たる。差し戻しても AGENT_AC_REIMPL_MAX を使い切ってから
// HOLD になるだけで、終端サマリーが「修正が必要」と人を誤った作業に向けるため。
//
// inline code（`...`）は判定前に除く。AC 本文が `（人手）` 等の語を識別子として引用しているだけのものを
// human にしないため。
//
// AC が指す作業の場所（scope）も決定論で分類する（issue #793）:
//   - 'external': repo 外（dotfiles・excludedCommands・settings.json・~/.claude・他 repo）の作業だけを書いた AC。
//     worktree では満たせないので actor は 'human'。
//   - 'mixed': repo 外の作業と repo 内の作業（テスト・README・rules・repo 内パス等）が 1 つの AC に混ざっている。
//     agent 部分を満たしても AC 全体は未達のまま残り、human 部分は差し戻しても満たせない。analyze ゲートで
//     needs_clarification にして repo 外の作業を human-task issue に切り出させる（mixedScopeAcReasons）。
//     （人手）と明記して同じ issue に残させない — human の AC は run 内で満たせず、Final reconcile で必ず HOLD になる。
//   - 'repo': それ以外。
// repo 外の目印は inline code の中も見る（設定名・パスは inline code で書かれるのが普通のため）。
// ただし repo 外を「作業の対象」として指していない目印は数えない:
//   - 目印を含む節（、。— 等で区切った単位）が否定・不在・条件・言及の形（「〜しない」「〜が無い」「0 箇所」
//     「不要」「必要なら」「理由にしていない」「記述」「grep」等）のもの。repo 内のファイルから文字列を
//     消す・repo 外を変えないと書いた AC を repo 外扱いにしないため
//   - 対象 repo 自身が持つもの（対象 repo が dotfiles のときの dotfiles / excludedCommands / settings.json）
// mixed の AC でも（人手）と明記されていれば external にする（人間が repo 外の作業として引き受けたと読む）。
// 判定に迷う形は repo 側に倒す（agent への誤分類は AGENT_AC_REIMPL_MAX で止まる。上の actor の倒し方と同じ理由）。
//
// 観測型 AC（issue #844）: 実行して出力・記録を観測しないと確かめられない AC（「実 run の journal に記録される」
// 「計測して比較する」等）。evaluator のコード読み（inspection）では確かめられないので actor は 'human'。
// Evaluate / Final reconcile は test の red→green 実証で deterministic 昇格したときだけ checked にし、それ以外は
// 差し戻さず ac_human_pending へ回す（merge 後の実 run・計測が要る AC は run 内で証跡を作れず、差し戻しても
// AGENT_AC_REIMPL_MAX を使い切ってから HOLD になるだけのため）。
// 判定は analyze ゲートの分類 agent に一本化する（issue #1259）: 全 AC を AC の文面と issue のタイトルだけを読む
// 分類 agent に 1 回で渡し、agent が null を返した・応答に無い・agent 自体が失敗した AC は true にする（resolveAcObservational）。
// 正規表現の絞り込みや prerun の判定で候補を減らさないのは、絞り込みが取りこぼした観測型 AC が agent に回らず
// 「観測型でない」で確定し、Evaluate のコード読みで達成扱いになるため（語の追加で取りこぼしを直す方式は語彙の違う repo で収束しない）。
// 分類 agent に diff・evaluator の結果を渡さないのは、観測型の仕組みが evaluator のコード読みだけで達成扱いになるのを
// 止めるためのもので、実装や評価を見た判定にすると抜け道になるため（incentive-structural）。
// 観測型でも、repo 内のテストファイル（TEST_FILE_PATH_RE に当たるパス）を inline code で名指しした AC は
// actor 'agent' にする（issue #1147）。テストでの検証を AC 自体が指定しており、red→green の実証は worktree 内で作れる
// 証跡なので、未達は差し戻せば満たせる。観測型の判定は true のまま変えない — 達成は red→green の deterministic 昇格
// だけで、文面が増やせるのは差し戻しの回数（AGENT_AC_REIMPL_MAX で止まる）だけにするため。
// evaluator が満たしたと判定して実証だけが無い（proof_missing）AC は、Evaluate が run 全体で 1 回だけ差し戻して
// red→green のテストを足させ、それでも実証が無ければ人手 AC 待ちにする（作り直しで実証を作れない AC に上限まで spawn を使わない）。
// worktree で実行するコマンドを AC 自体が inline code で指定した観測型 AC（issue #1208）は、分類 agent がそのコマンド
// と生成されるファイルを AC の inline code の候補の番号（verify_command_index / expect_path_indexes）で返し、freezeAcVerify が
// その番号で AC の inline code から取り出した文字列を analyze ゲートで凍結する。workflow はそれを local-verify で sandbox 内で実行し、失敗は dev-implementer へ差し戻し、
// 最終 tree の exit 0 は人手 AC の確認材料として終端サマリーに開示するだけにする（_lib/local-verify.mjs）。
// verify_command の有無で actor を変えない（'human' のまま）し、exit 0 を観測型 AC の proven にも入れない — 実行される
// script・build 設定・テストは PR が書き換えられるので、exit 0 で HOLD を外すと PR の内容で gate を誘導できる（incentive-structural）。
// agent の出力の文字列は実行しない — 実行するものを AC の文面から決定論で抜き出した inline code に縛り、実装後に読み直さない
// （implementer が差し戻しの判定に使うコマンドを書き換えられないように）。
//
// INLINE COPY POLICY: workflow から参照される最上位宣言だけが tools/sync-inlines.mjs --write で inline 生成される。
// 直接 workflow 側を編集しない。一致は _lib/workflow-inlines.sync.test.mjs が検証する。

export const AC_ACTORS = ['agent', 'human', 'ci']

// agent AC の未達だけを理由にした差し戻しの上限。standard shape（EVAL_PASSES=1）でもこの回数までは
// evaluate を延長して差し戻す。incentive-structural — 満たせない AC で差し戻しが続くのを総回数で止める。
export const AGENT_AC_REIMPL_MAX = 2

const EXPLICIT_HUMAN_RE = /[（(]\s*人手\s*[)）]/

const HUMAN_AC_PATTERNS = [
  EXPLICIT_HUMAN_RE,
  /staging|ステージング/i,
  /本番/,
  /\bprod(uction)?\s*(環境|environment)/i,
  /外部サービス/,
  /issue\s*(に|へ)(の)?\s*コメント/i,
]

// inline code の区切り（バッククォート）は \x60 で書く（sync-inlines の stripComments は regex literal を
// 解釈せず、生のバッククォートを template literal の開始と読むため）。
const INLINE_CODE_RE = /\x60[^\x60]*\x60/g

// repo 外を指す目印。g 付きで持ち、判定にも除去にも replace / match だけを使う（test() は lastIndex を持ち越すため使わない）。
// ownedBy: 対象 repo の名前（owner/name の name）がこれと一致するときは repo 内のものとして数えない。
const EXTERNAL_AC_PATTERNS = [
  { re: /dotfiles/gi, ownedBy: 'dotfiles' },
  { re: /excludedCommands/g, ownedBy: 'dotfiles' },
  { re: /settings(\.local)?\.json/g, ownedBy: 'dotfiles' },
  { re: /~\/\.claude\b/g, ownedBy: null },
  { re: /(別|他|ほか)の?\s*(repo|リポジトリ)/gi, ownedBy: null },
]

// 節の区切り。目印が否定・言及の節にあるかは節単位で見る。
const CLAUSE_SEP_RE = /[、，,。．；;—–\n]/g

// repo 外を作業の対象として指していない節の形（否定・不在・件数 0・不要・条件・言及・grep 対象）。g なし（test() で使う）。
const MENTION_CLAUSE_PATTERNS = [
  /(が|は|も)\s*(無|な)い/,
  /[てで]いない/,
  /しない|せず/,
  /不要/,
  /含ま(ない|ず)|を含む行/,
  /(^|[^\d])0\s*(箇所|件|個|行)|ヒット\s*0/,
  /必要(なら|に?なった場合|な場合|があれば)/,
  /記述|言及|理由(として|に)/,
  /\bgrep\b/i,
]

// 他 repo の参照（github.com/<owner>/<repo> と <owner>/<repo>#<n>）。repo（対象 repo の owner/name）と一致するものは repo 内。
const REPO_REF_RE = /github\.com\/([\w.-]+\/[\w.-]+)|(?:^|[^\w./-])([A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*)#\d+/g

// repo 内の作業を指す目印（repo 外の目印を取り除いた残りに対して見る）。
const REPO_AC_PATTERNS = [
  /テスト|\btests?\b|vitest|\bbats\b|fixture/i,
  /README|AGENTS\.md|ドキュメント/,
  /\brules\b|ルール/,
  /(repo|リポジトリ|worktree)\s*内/i,
  /(^|[\s\x60(（、「])(plugins|tools|src|lib|_lib|tests|scripts|docs|\.claude|\.github)[/]/,
]

function normalizeRepoSlug(s) {
  return String(s ?? '').trim().toLowerCase().replace(/\.git$/, '')
}

// 否定・言及の形をとる節の [start, end) 範囲を返す。
function mentionRanges(text) {
  const ranges = []
  let start = 0
  const push = (end) => {
    const clause = text.slice(start, end)
    if (MENTION_CLAUSE_PATTERNS.some((re) => re.test(clause))) ranges.push([start, end])
  }
  for (const m of text.matchAll(CLAUSE_SEP_RE)) {
    push(m.index)
    start = m.index + m[0].length
  }
  push(text.length)
  return ranges
}

// AC 本文から repo 外の目印を取り除いた残りと、作業の対象として repo 外を指す目印を返す。
// 目印は同じ長さの空白で置き換える（節の範囲を元の offset のまま使うため）。
function splitExternalMarkers(ac, repo) {
  const src = String(ac ?? '')
  const mentions = mentionRanges(src)
  const inMention = (off) => mentions.some(([s, e]) => off >= s && off < e)
  const self = normalizeRepoSlug(repo)
  const selfName = self.includes('/') ? self.split('/')[1] : ''
  const markers = []
  let text = src
  for (const { re, ownedBy } of EXTERNAL_AC_PATTERNS) {
    text = text.replace(re, (m, ...args) => {
      const off = args[args.length - 2]
      const owned = ownedBy !== null && ownedBy === selfName
      if (!owned && !inMention(off)) markers.push(m)
      return ' '.repeat(m.length)
    })
  }
  text = text.replace(REPO_REF_RE, (m, urlSlug, refSlug, off) => {
    const slug = normalizeRepoSlug(urlSlug ?? refSlug)
    if (!self || slug === self) return m
    if (!inMention(off)) markers.push(slug)
    return ' '.repeat(m.length)
  })
  return { rest: text, markers }
}

// AC を 'repo' | 'external' | 'mixed' に分類する。opts.repo は対象 repo の owner/name（他 repo 参照と自 repo が持つ
// 目印の判定に使う。省略時は他 repo 参照を判定しない）。
export function classifyAcScope(ac, opts = {}) {
  const { rest, markers } = splitExternalMarkers(ac, opts?.repo)
  if (markers.length === 0) return 'repo'
  if (!REPO_AC_PATTERNS.some((re) => re.test(rest))) return 'external'
  return EXPLICIT_HUMAN_RE.test(String(ac ?? '').replace(INLINE_CODE_RE, ' ')) ? 'external' : 'mixed'
}

// 観測型が true で、文面上の actor（HUMAN_AC_PATTERNS・ci_verify・external）が 'human' / 'ci' でない AC の index（0 始まり）。
// AC が指定したコマンドを run 内で実行できる候補で、分類 agent が返した verify_command を実行する対象。opts は classifyAcActor と同じ。
export function acVerifyCandidateIndexes(acceptanceCriteria, acObservational, opts = {}) {
  const acs = Array.isArray(acceptanceCriteria) ? acceptanceCriteria : []
  const obs = Array.isArray(acObservational) ? acObservational : []
  const out = []
  for (let i = 0; i < acs.length; i++) {
    if (obs[i] === true && classifyAcActor(acs[i], { repo: opts?.repo, ciVerify: opts?.ciVerify }) === 'agent') out.push(i)
  }
  return out
}

// 分類 agent の prompt。材料は issue のタイトルと渡す AC の文面だけ（diff・evaluator の結果・implementer の報告・issue 本文は渡さない）。
// indexes は全 AC の index（analyze ゲートは AC を絞り込まずに渡す）。
// 検証コマンドと生成物のパスは、AC ごとに決定論で抜き出した inline code の候補（inline_codes。AC 本文に出てくる順・重複もそのまま）
// から番号で選ばせる（agent に文字列を作らせない。freezeAcVerify がその番号で inlineCodesOf(ac) から取り出す）。
// inline code の区切りは文中で「バッククォート」と書く（sync-inlines の stripComments が生のバッククォートを template literal と読むため）。
export function acObservationalPrompt(issueTitle, acceptanceCriteria, indexes) {
  const acs = Array.isArray(acceptanceCriteria) ? acceptanceCriteria : []
  const items = (Array.isArray(indexes) ? indexes : []).map((i) => {
    const ac = String(acs[i] ?? '')
    return { ac_index: i, ac, inline_codes: inlineCodesOf(ac).map((code, index) => ({ index, code })) }
  })
  return '次の issue の受け入れ基準（AC）それぞれについて、観測型かどうかと、AC が指定した検証コマンドを判定せよ。判定材料は下に示す issue のタイトルと AC の文面だけ。'
    + 'ツールは使わず、ファイル・diff・issue 本文・コマンドの出力を読みに行かない。\n'
    + '観測型（observational:true）: コードとテストを読むだけでは確かめられず、実行した結果・ログ・計測を観測しないと確かめられない AC。'
    + 'AC がテストコードやソースコード自体の書き方・構成について述べているなら false。'
    + '文面だけでは決められない AC は observational:null を返せ（観測型として扱われる）。\n'
    + 'inline_codes: AC 本文の inline code（バッククォートで囲んだ部分）を本文に出てくる順に並べた候補で、index は 0 始まりの番号。\n'
    + 'verify_command_index: その AC の結果を exit code だけで決められる、worktree を cwd に実行するコマンドを AC 自身が inline code で書いているなら、'
    + 'その AC の inline_codes のうちそのコマンドの index。候補に無いコマンドを組み立てる・言い換える・候補の一部だけを使うことはしない。決まらなければ null。\n'
    + 'expect_path_indexes: verify_command_index のコマンドの終了後に worktree に生成されていることを AC が求めるファイルのうち、AC が inline code で書いたパス（worktree からの相対パスだけ）の、'
    + 'その AC の inline_codes での index。無ければ []。verify_command_index が null なら []。\n'
    + `issue のタイトル: ${JSON.stringify(String(issueTitle ?? ''))}\n`
    + `AC（ac_index は 0 始まり）: ${JSON.stringify(items)}\n`
    + '上の全 AC について 1 件ずつ {"results":[{"ac_index":<上の ac_index>,"observational":true|false|null,"verify_command_index":<inline_codes の index>|null,"expect_path_indexes":[<inline_codes の index>]}]} の形で返せ。\n'
}

// AC の inline code の中身（区切りのバッククォートを除いたもの。前後の空白も変えない）。
function inlineCodesOf(ac) {
  return (String(ac ?? '').match(INLINE_CODE_RE) ?? []).map((m) => m.slice(1, -1))
}

// worktree からの相対パスか（/ 始まりでなく、.. のセグメントを含まない）。
function isWorktreeRelativePath(p) {
  return p.trim() !== '' && !p.startsWith('/') && !p.split('/').includes('..')
}

// codes[k]。k が codes の範囲内の非負整数でなければ null（文字列・小数・負数・範囲外・欠落）。
function inlineCodeAt(codes, k) {
  return Number.isInteger(k) && k >= 0 && k < codes.length ? codes[k] : null
}

// 分類 agent が返した AC ごとの verify_command_index / expect_path_indexes で、その AC の inline code から文字列を取り出して
// 凍結する（analyze ゲートで 1 回だけ。実装後に読み直さない）。agent の出力の文字列は使わない（verify_command / expect_paths に
// 文字列を入れた応答も null）。verify_command は範囲内の index が指す空白だけでない inline code のときだけ採り、それ以外は null。
// expect_paths は範囲内の index が指す inline code のうち、/ 始まりでも .. のセグメントを含むものでもないものだけを値で重複を除いて残す。
// verify_command が null の AC は expect_paths も []（実行しないコマンドの生成物は確かめようがない）。
// inline code に verify_command と採った expect_paths 以外の値が残る AC も null（複合 AC を 1 本のコマンドで達成扱いにしない）。
// 返り値は AC ごとの { verify_command: string | null, expect_paths: string[] }（index は acceptanceCriteria と同じ）。
export function freezeAcVerify(acceptanceCriteria, agentResult) {
  const results = Array.isArray(agentResult?.results) ? agentResult.results : []
  return (Array.isArray(acceptanceCriteria) ? acceptanceCriteria : []).map((ac, i) => {
    const codes = inlineCodesOf(ac)
    const r = results.find((x) => x && x.ac_index === i)
    const cmd = r ? inlineCodeAt(codes, r.verify_command_index) : null
    if (cmd === null || cmd.trim() === '') return { verify_command: null, expect_paths: [] }
    const paths = (Array.isArray(r.expect_path_indexes) ? r.expect_path_indexes : [])
      .map((k) => inlineCodeAt(codes, k))
      .filter((p) => p !== null && isWorktreeRelativePath(p))
    // verify_command と採った expect_paths 以外の値の inline code が残る AC（コマンドを複数書いた複合 AC 等）は凍結しない —
    // 1 本の exit 0 で AC 全体を確かめたことにならないため。同じ値が 2 回現れる inline code は、どちらかを選べば残りに数えない。
    if (codes.some((c) => c !== cmd && !paths.includes(c))) return { verify_command: null, expect_paths: [] }
    return { verify_command: cmd, expect_paths: [...new Set(paths)] }
  })
}

// 分類 agent の応答から AC ごとの観測型判定（boolean）を確定する。agent の boolean をそのまま採り、agent が判定できない
// （null 応答・該当 index なし・agent 自体の失敗で agentResult が null）AC は true（観測型）に倒す — 観測型の誤判定は
// 人手 AC 待ちの HOLD で止まるだけだが、非観測型への誤判定は inspection の達成扱いを素通しするため。
export function resolveAcObservational(acceptanceCriteria, agentResult) {
  const results = Array.isArray(agentResult?.results) ? agentResult.results : []
  return (Array.isArray(acceptanceCriteria) ? acceptanceCriteria : []).map((_, i) => {
    const r = results.find((x) => x && x.ac_index === i)
    return typeof r?.observational === 'boolean' ? r.observational : true
  })
}

// run-tests の結果の run の種別（issue #1297）。'validate' は Validate の最後の実行（state.val）、'test_final' は Final reconcile の test#final。
export const TEST_RUN_KINDS = ['validate', 'test_final']

// AC の inline code を run-tests の入口のパスとして読むときに外す前置（「bash 」と「./」だけ。この順）。
const TEST_ENTRY_PREFIX_RE = /^(?:bash )?(?:\.\/)?/

// pipeline が実行したテストの入口だけを inline code に書いた AC について、その run の結果を開示する（issue #1297）。
// result は run-tests の結果（GREEN schema。tests / green / scripts[].path）、run は TEST_RUN_KINDS、changedFiles は PR の変更ファイル
// （base との差分から pipeline が求めた repo 相対パス。null は取得失敗）、worktree は scripts[].path を worktree 相対に直す起点。
// AC の inline code が 1 つ以上あり、前置を外した全部が実行した入口（worktree 配下の scripts[].path）と完全一致する AC だけを返す —
// 引数付き・入口以外の inline code が混ざる AC は、入口の結果で AC の主張を確かめたことにならないため。
// green は tests:'passed' かつ green:true のときだけ true。entry_changed は入口のどれかが変更ファイルにあれば true（null は不明）。
// 返り値は AC ごとの { ac_index, run, entries, green, entry_changed }。終端サマリーの開示だけに使い、AC の達成判定・merge tier・
// demoteUnprovenObservationalAc の proven には入れない — 入口とテストは PR が書き換えられ、選択実行の green は全件 green より弱い。
export function testRunAcDisclosures({ acceptanceCriteria, result, run, changedFiles, worktree }) {
  if (!TEST_RUN_KINDS.includes(run)) throw new Error(`testRunAcDisclosures: invalid run: ${run}`)
  if (!result || typeof result !== 'object' || typeof worktree !== 'string' || worktree === '') return []
  const root = worktree.replace(/\/+$/, '') + '/'
  const ran = (Array.isArray(result.scripts) ? result.scripts : [])
    .map((s) => (s && typeof s.path === 'string' && s.path.startsWith(root) ? s.path.slice(root.length) : ''))
    .filter((p) => p !== '')
  const green = result.tests === 'passed' && result.green === true
  const changed = Array.isArray(changedFiles) ? changedFiles : null
  const acs = Array.isArray(acceptanceCriteria) ? acceptanceCriteria : []
  const out = []
  for (let i = 0; i < acs.length; i++) {
    const entries = inlineCodesOf(acs[i]).map((c) => c.replace(TEST_ENTRY_PREFIX_RE, ''))
    if (!entries.length || !entries.every((e) => ran.includes(e))) continue
    const uniq = [...new Set(entries)]
    out.push({ ac_index: i, run, entries: uniq, green, entry_changed: changed === null ? null : uniq.some((e) => changed.includes(e)) })
  }
  return out
}

// label が AC 本文（inline code を含む）に語として現れるか。前後が英数字・_・- でない位置だけを数える
// （`full-ci` が `full-ci-nightly` の一部として現れたものを言及にしない）。
function mentionsLabel(text, label) {
  const isWordChar = (c) => c !== undefined && /[A-Za-z0-9_-]/.test(c)
  for (let at = text.indexOf(label); at >= 0; at = text.indexOf(label, at + 1)) {
    if (!isWordChar(text[at - 1]) && !isWordChar(text[at + label.length])) return true
  }
  return false
}

// AC が ci_verify（prerun が読んだ repo の宣言。null は未設定）で CI に回す AC か。inline code が commands の
// どれかと一致する（引数を足した `<command> <args>` も含む）か、label に言及していれば true。
export function matchesCiVerify(ac, ciVerify) {
  if (!ciVerify || typeof ciVerify !== 'object') return false
  const text = String(ac ?? '')
  const commands = (Array.isArray(ciVerify.commands) ? ciVerify.commands : [])
    .filter((c) => typeof c === 'string' && c.trim()).map((c) => c.trim())
  const codes = (text.match(INLINE_CODE_RE) ?? []).map((m) => m.slice(1, -1).trim())
  if (codes.some((code) => commands.some((cmd) => code === cmd || code.startsWith(cmd + ' ')))) return true
  const label = typeof ciVerify.label === 'string' ? ciVerify.label.trim() : ''
  return label !== '' && mentionsLabel(text, label)
}

// AC の文面がテストファイルを名指ししているかを見るための、よくあるテストファイル名の形（redgreen-verify の実行の形は
// 解決したテストコマンドが決め、この形には依らない）。
// glob（`*.test.*` 等）はファイルの名指しではないので `*` を含むものは数えない。
const TEST_FILE_PATH_RE = /(^|\/)([^/*\s]+\.(test|spec)\.[A-Za-z0-9]+|[^/*\s]+\.bats|__tests__\/[^*\s]+\.[A-Za-z0-9]+|test_[^/*\s]+\.py|[^/*\s]+_test\.(py|go|rb)|[^/*\s]+_spec\.rb|[^/*\s]+Test\.php|tests\/[^/*\s]+\.rs)$/
// 引用符は \x27 / \x22 で書く（INLINE_CODE_RE と同じく、sync-inlines の stripComments は regex literal を解釈しないため）。
const INLINE_CODE_TOKEN_SEP_RE = /[\s\x27\x22]+/

// AC が inline code でテストファイルを名指ししているか（inline code を空白・引用符で区切った語のどれかがテストファイルのパス）。
function namesTestFile(ac) {
  const codes = (String(ac ?? '').match(INLINE_CODE_RE) ?? []).map((m) => m.slice(1, -1))
  return codes.some((code) => code.split(INLINE_CODE_TOKEN_SEP_RE).some((tok) => TEST_FILE_PATH_RE.test(tok)))
}

// opts.observational は analyze ゲートで確定した AC の観測型判定（boolean）。true なら human — ただしテストファイルを
// inline code で名指しした AC は agent（red→green の実証を worktree 内で作れるので差し戻す）。AC が指定したコマンド
// （freezeAcVerify で凍結した verify_command）の有無では変えない（exit 0 は PR が書き換えうる出力のため。issue #1208）。
// opts.ciVerify は repo の ci_verify 宣言（null / 省略は未設定 — 'ci' を返さない）。
// （人手）・staging・本番等の明示は ci より優先する（CI の check では満たせない作業を書いた AC のため）。
// ci は観測型より優先する（実行しないと確かめられない AC を、CI の check が実行して確かめるため）。
export function classifyAcActor(ac, opts = {}) {
  const text = String(ac ?? '').replace(INLINE_CODE_RE, ' ')
  if (HUMAN_AC_PATTERNS.some((re) => re.test(text))) return 'human'
  if (matchesCiVerify(ac, opts?.ciVerify)) return 'ci'
  if (classifyAcScope(ac, opts) === 'external') return 'human'
  return opts?.observational === true && !namesTestFile(ac) ? 'human' : 'agent'
}

// opts.observational は AC ごとの観測型判定の配列（req.ac_observational）。opts.ciVerify は classifyAcActor と同じ。
export function acActorsOf(acceptanceCriteria, opts = {}) {
  const obs = Array.isArray(opts?.observational) ? opts.observational : []
  return (Array.isArray(acceptanceCriteria) ? acceptanceCriteria : []).map((ac, i) => classifyAcActor(ac, { repo: opts?.repo, observational: obs[i] === true, ciVerify: opts?.ciVerify }))
}

// actor が 'ci' の AC の index（0 始まり）。
export function ciAcIndexes(actors) {
  const out = []
  const list = Array.isArray(actors) ? actors : []
  for (let i = 0; i < list.length; i++) if (list[i] === 'ci') out.push(i)
  return out
}

// pr-iterate が返す ci_verify.status（LGTM 後の check 待ちの結果）。'not_run' は LGTM 前に終端して待ちに入らなかった。
export const CI_VERIFY_STATUSES = ['passed', 'failed', 'pending', 'error', 'not_run']

// ci AC の判定文。ciVerify は pr-iterate の返り値 ci_verify（null は未判定 — PR 作成前・pr-iterate 未起動）。
// source:'local' は local-verify（pg-broker の DB でのローカル実行。issue #863）の結果 {status, command, exit_code, log_path}。
function ciAcEvidence(ciVerify) {
  if (ciVerify?.source === 'local') {
    const run = `ローカル実行（${ciVerify.command ?? 'local_verify'}）が exit ${ciVerify.exit_code ?? '?'}`
    return `${run}${ciVerify.status === 'passed' ? '' : '（差し戻し上限まで直らなかった）'}: ${ciVerify.log_path ?? 'log なし'}`
  }
  const checks = Array.isArray(ciVerify?.checks) && ciVerify.checks.length ? ciVerify.checks.join(', ') : 'CI'
  switch (ciVerify?.status) {
    case 'passed': {
      const urls = Array.isArray(ciVerify.urls) ? ciVerify.urls.filter((u) => typeof u === 'string' && u) : []
      return `CI の ${checks} が success${urls.length ? `: ${urls.join(' ')}` : ''}`
    }
    case 'failed': return `CI の ${checks} が failure（pr-iterate の fix 後も green にならなかった）`
    case 'pending': return `CI の ${checks} 実行中（${Number.isFinite(ciVerify.waited_seconds) ? ciVerify.waited_seconds : '?'}s 待って未完了）`
    case 'error': return `CI の ${checks} の状態を取得できなかった`
    case 'not_run': return `CI の ${checks} の完了待ちに入っていない（pr-iterate が LGTM 前に終端）`
    default: return 'CI の check で判定する（pr-iterate の LGTM 後に完了を待つ）— 未判定'
  }
}

// ac_results の ci AC を CI の判定で置き換える（evaluator / final-ac-reconcile の判定は使わない）。
// ci AC の結果が無ければ足す。satisfied は ciVerify.status === 'passed' のときだけ true。非配列はそのまま返す。
// ciVerify.source === 'local'（local-verify の結果）なら verified_by は 'local'、根拠は log_path と exit code。
// ciVerify が null（CI の判定前 — Evaluate 時点）か status が 'pending' / 'not_run'（check が完了していない・待っていない）なら
// ci_pending:true を付ける。satisfied:false は「未達」ではなく「まだ判定していない」で、PR 本文の表（pr-artifacts の acRows）は
// これを ❌ ではなく未検証として出す。evaluator が返した gist（AC の要旨）だけは引き継ぐ（判定・根拠は CI のものに置き換える）。
export function applyCiAcResults(acResults, actors, ciVerify) {
  if (!Array.isArray(acResults)) return acResults
  const ci = ciAcIndexes(actors)
  if (!ci.length) return acResults
  const evidence = ciAcEvidence(ciVerify)
  const satisfied = ciVerify?.status === 'passed'
  const isCi = (r) => r && Number.isInteger(r.ac_index) && ci.includes(r.ac_index)
  const kept = acResults.filter((r) => !isCi(r))
  const gistOf = (i) => acResults.find((r) => isCi(r) && r.ac_index === i && typeof r.gist === 'string')?.gist
  const verifiedBy = ciVerify?.source === 'local' ? 'local' : 'ci'
  const pending = ciVerify == null || ciVerify.status === 'pending' || ciVerify.status === 'not_run' ? { ci_pending: true } : {}
  const ciResults = ci.map((i) => {
    const gist = gistOf(i)
    return { ac_index: i, ...(gist !== undefined ? { gist } : {}), satisfied, verified_by: verifiedBy, ci: true, ...pending, evidence }
  })
  return [...kept, ...ciResults].sort((a, b) => (Number.isInteger(a?.ac_index) ? a.ac_index : Infinity) - (Number.isInteger(b?.ac_index) ? b.ac_index : Infinity))
}

// ci AC のうち CI で未達（status !== 'passed'）の index。evaluator の ac_results の有無に依らず決まる。
export function unsatisfiedCiAcIndexes(actors, ciVerify) {
  return ciVerify?.status === 'passed' ? [] : ciAcIndexes(actors)
}

// evaluator feedback のうち ci AC に結び付けた（ac_index が ci AC の）項目を除く。ci AC は CI の check が判定するので、
// evaluator の指摘を差し戻し・ledger の critical に入れない。非配列はそのまま返す。
export function dropCiAcFeedback(feedback, actors) {
  if (!Array.isArray(feedback)) return feedback
  const ci = ciAcIndexes(actors)
  if (!ci.length) return feedback
  return feedback.filter((f) => !(f && Number.isInteger(f.ac_index) && ci.includes(f.ac_index)))
}

// ledger の AC-<n> item のうち、red→green 実証で deterministic 昇格して checked の AC の index（0 始まり）。
export function deterministicAcIndexes(ledgerItems) {
  const out = []
  for (const it of (Array.isArray(ledgerItems) ? ledgerItems : [])) {
    const m = it && typeof it.id === 'string' ? /^AC-(\d+)$/.exec(it.id) : null
    if (m && it.checked === true && it.check && it.check.kind === 'deterministic') out.push(Number(m[1]) - 1)
  }
  return out
}

// evaluator / final-ac-reconcile の ac_results で、deterministic 昇格していない観測型 AC を satisfied:false に倒し
// observational:true を付ける（inspection や red→green 不成立の satisfied:true を達成扱いにしない）。
// satisfied:true を倒した AC にだけ proof_missing:true（実証不足）を付け、もともと satisfied:false の AC（未達）には付けない。
// 倒した AC は isReimplUnfixableGap で人手 AC 待ちに数える。テストファイルを名指しした actor 'agent' の AC は、
// Evaluate が run 全体で 1 回だけ差し戻す（evaluator が満たしたと判定した AC は、作り直しで red→green を作れるとは限らない）。
// 非配列はそのまま返す。
export function demoteUnprovenObservationalAc(acResults, observational, provenIndexes) {
  if (!Array.isArray(acResults)) return acResults
  const obs = Array.isArray(observational) ? observational : []
  const proven = Array.isArray(provenIndexes) ? provenIndexes : []
  return acResults.map((r) => {
    if (!r || !Number.isInteger(r.ac_index) || obs[r.ac_index] !== true || proven.includes(r.ac_index)) return r
    if (r.satisfied !== true) return { ...r, observational: true }
    const evidence = typeof r.evidence === 'string' && r.evidence.trim() ? `（evaluator: ${r.evidence.trim()}）` : ''
    return { ...r, satisfied: false, observational: true, proof_missing: true, evidence: `観測型 AC — test の red→green 実証が無く、実行しないと確かめられない${evidence}` }
  })
}

// 作り直し（dev-implementer への差し戻し）で埋まらない gap か。実行環境に届かない未達（unreachable_env:true）と、
// evaluator が満たしたと判定して red→green の実証だけが無い観測型 AC（proof_missing:true）が当たる。
// agent→human の付け替え（unsatisfiedAcByActor）はこの述語だけで決める。
export function isReimplUnfixableGap(r) {
  return r != null && (r.unreachable_env === true || r.proof_missing === true)
}

// actor 'agent' で実証不足（proof_missing:true）の未達 AC の index（重複なし）。Evaluate が run 全体で 1 回だけ差し戻す対象。
export function proofMissingAgentAcIndexes(acResults, actors) {
  const list = Array.isArray(actors) ? actors : []
  const out = []
  for (const r of (Array.isArray(acResults) ? acResults : [])) {
    if (!r || r.satisfied !== false || r.proof_missing !== true || !Number.isInteger(r.ac_index)) continue
    if (list[r.ac_index] === 'agent' && !out.includes(r.ac_index)) out.push(r.ac_index)
  }
  return out
}

// analyze ゲートの理由行: repo 内外が混ざった AC ごとに 1 行。非空なら needs_clarification（source=analyze）で止める。
export function mixedScopeAcReasons(acceptanceCriteria, opts = {}) {
  const acs = Array.isArray(acceptanceCriteria) ? acceptanceCriteria : []
  const reasons = []
  acs.forEach((ac, i) => {
    if (classifyAcScope(ac, opts) !== 'mixed') return
    const { markers } = splitExternalMarkers(ac, opts?.repo)
    reasons.push(`AC-${i + 1}「${String(ac)}」は repo 内の作業と repo 外の作業（${[...new Set(markers)].join(' / ')}）が混ざっている — dev-flow は 1 issue = 1 PR・単一 worktree で repo 外の作業を満たせない。repo 外の作業は \`human-task\` ラベルの別 issue に切り出し、この issue の AC は repo 内で検証できるものだけにしてから再起動せよ。依存の向き: merge 前に人がやる作業ならこの issue に \`Blocked by #<human issue>\`、merge 後に確認する作業なら human issue に \`Blocked by #<実装 issue>\` を書く`)
  })
  return reasons
}

// evaluator / final-ac-reconcile の ac_results から satisfied:false の ac_index を actor 別に返す。
// actors の範囲外の ac_index（evaluator の誤応答）は数えない。同じ index の重複は 1 件にする。
// agent の AC で作り直しで埋まらない gap（isReimplUnfixableGap）は human に数える（上限まで差し戻さず人手 AC 待ちにする）。
export function unsatisfiedAcByActor(acResults, actors) {
  const out = { agent: [], human: [], ci: [] }
  const list = Array.isArray(actors) ? actors : []
  for (const r of (Array.isArray(acResults) ? acResults : [])) {
    if (!r || r.satisfied !== false || !Number.isInteger(r.ac_index)) continue
    let actor = list[r.ac_index]
    if (!AC_ACTORS.includes(actor)) continue
    if (actor === 'agent' && isReimplUnfixableGap(r)) actor = 'human'
    if (!out[actor].includes(r.ac_index)) out[actor].push(r.ac_index)
  }
  return out
}

// 人手 AC 待ち（unsatisfiedAcByActor の human の index）に、文面で人手になった AC（HUMAN_AC_PATTERNS に当たる・
// classifyAcScope が external）ではない AC が 1 件以上あるか。観測型の判定（observational:true）か
// isReimplUnfixableGap（unreachable_env:true・実証不足の proof_missing:true）で人手になった AC がこれに当たる。dev-flow の HOLD telemetry（hold_ac_human_judged）に載せ、
// dev-flow-health が ac_human_pending の HOLD を dev-flow / 実行環境の不具合の候補として拾う。記録専用で gate には使わない。
// opts.repo は classifyAcScope と同じ。
export function hasJudgedHumanAcGap(humanIndexes, acceptanceCriteria, opts = {}) {
  const acs = Array.isArray(acceptanceCriteria) ? acceptanceCriteria : []
  return (Array.isArray(humanIndexes) ? humanIndexes : []).some((i) => {
    const text = String(acs[i] ?? '').replace(INLINE_CODE_RE, ' ')
    return !HUMAN_AC_PATTERNS.some((re) => re.test(text)) && classifyAcScope(acs[i], opts) !== 'external'
  })
}

// agent AC の未達を dev-implementer へ渡す fix_feedback 項目にする（evaluator feedback と同じ形）。
// 「計測して PR 本文に書く」型の AC は、コードのコメントでは PR 本文に届かないので pr_notes / design_decisions で
// 返すよう suggestion に明記する。実証不足（proof_missing:true）の AC は未達ではないので、red→green になるテストを
// 足すよう伝える（作り直しで実証を作れない AC にテストを作り替えさせないため、そのまま返してよいことも書く）。
export function agentAcFeedback(indexes, acceptanceCriteria, acResults) {
  const acs = Array.isArray(acceptanceCriteria) ? acceptanceCriteria : []
  const results = Array.isArray(acResults) ? acResults : []
  return (Array.isArray(indexes) ? indexes : []).map((i) => {
    const r = results.find((x) => x && x.ac_index === i)
    const evidence = r && typeof r.evidence === 'string' && r.evidence.trim() ? r.evidence.trim() : '根拠なし'
    if (r && r.proof_missing === true) {
      return {
        severity: 'major',
        topic: `AC-${i + 1} 実証不足`,
        description: `AC-${i + 1}「${String(acs[i] ?? '')}」は evaluator が満たしたと判定したが、test の red→green 実証が無い（${evidence}）`,
        suggestion: 'AC が新しい挙動を求めるなら、実装を外すと落ちて実装で通るテスト（red→green）を足せ。変更前から green のテストで確かめる AC（非退行など）はテストを作り替えずそのまま返せ（人手 AC 待ちに回る）。この差し戻しは 1 回だけ',
      }
    }
    return {
      severity: 'major',
      topic: `AC-${i + 1} 未達`,
      description: `AC-${i + 1}「${String(acs[i] ?? '')}」を evaluator が satisfied:false と判定（${evidence}）`,
      suggestion: 'worktree 内で満たせ。計測値・検証結果を PR 本文に書く AC は pr_notes、設計判断は design_decisions に入れて返せ（コードのコメントだけでは PR 本文に載らない）',
    }
  })
}
