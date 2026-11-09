// Journal telemetry handoff helpers for workflow runtime.
// Workflow loader cannot import ESM, so tools/sync-inlines.mjs injects this file
// into .claude/workflows/*.js. Keep this file import-free and deterministic.
//
// INLINE COPY POLICY: workflow から参照される最上位宣言だけが tools/sync-inlines.mjs --write で inline 生成される。
// 直接 workflow 側を編集しない。一致は _lib/workflow-inlines.sync.test.mjs が検証する。

// handoff spawn が Write tool へ渡す最終書き込み先。shell 展開ではなく Write tool 側の `~` 展開に
// 依存する（spawn は shell を一切使わない — buildJournalPendingWriteInstr のコメント参照）。
// 副作用として CLAUDE_JOURNAL_DIR による書き込み先の差し替えは効かない。同 env を読むのは
// dev-flow-health の集計スクリプトと各 test harness だけで、書き込み側の
// production 経路では設定されないため、読み手（Stop hook）との不一致は生じない。
const JOURNAL_PENDING_DIR = '~/.claude/journal/pending';

export function buildJournalHandoffPayload({
  skill,
  outcome,
  args,
  issue,
  repo,
  pr_number,
  journal_sh,
  telemetry,
  error_category,
  error_msg,
  error_phase,
}) {
  if (!skill) throw new Error('journal-handoff: skill is required');
  if (!outcome) throw new Error('journal-handoff: outcome is required');

  const payload = { skill, outcome };
  if (args) payload.args = args;
  if (issue != null && issue !== '') payload.issue = Number(issue);
  if (repo != null && repo !== '') payload.repo = String(repo);
  if (pr_number != null && pr_number !== '') payload.pr_number = Number(pr_number);
  if (journal_sh) payload.journal_sh = journal_sh;
  if (telemetry != null) payload.telemetry = telemetry;
  if (error_category) payload.error_category = error_category;
  if (error_msg) payload.error_msg = error_msg;
  if (error_phase) payload.error_phase = String(error_phase);
  return JSON.stringify(payload);
}

// journalEffectId(payload): stable 16-hex effect ID derived from the payload string in pure JS.
// 以前は書き込み段の shell が `shasum -a 256 | cut -c1-16` で算出していたが、その算出には変数代入と
// コマンド置換が必要で、それが worktree 分離ガードの拒否要因だった（issue #526）。JS 側で先に
// 確定させることで書き込み先が prompt 構築時点で定まり、handoff spawn から shell を完全に外せる。
//
// 幅は従来と同じ 64bit（16 hex）で、衝突時の影響も従来と同じ「別 payload の entry を上書きする」
// クラスに留まる。暗号学的強度は不要 — 用途は同一 payload の再実行で同一ファイル名を再現する
// 冪等命名だけで、内容の真正性検証には使わない。BigInt を避けて 32bit 2 本（seed 違いの FNV-1a）に
// 分けているのは、workflow runtime が制限付き JS sandbox であり、inline 生成先とテストで同一挙動を
// 保証する必要があるため。
function fnv1a32(str, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    // 上位バイトも混ぜる: payload は日本語を含みうるので下位バイトだけでは区別が落ちる。
    h = Math.imul(h ^ (c & 0xff), 0x01000193) >>> 0;
    h = Math.imul(h ^ (c >>> 8), 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function journalEffectId(payload) {
  const s = String(payload ?? '');
  const lo = fnv1a32(s, 0x811c9dc5);
  const hi = fnv1a32(s, 0x811c9dc5 ^ 0x9e3779b9);
  return hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');
}

// buildJournalPendingPath({ prefix, id, effectId }): handoff spawn が Write tool へ渡す最終パス。
// prefix / id は Write tool のパスへ splice されるので、shell へ渡していた頃と同じ決定論検証を
// 残す（パス要素の混入は書き込み先の乗っ取りに直結するため、経路が shell でなくなっても緩めない）。
export function buildJournalPendingPath({ prefix, id, effectId }) {
  const safePrefix = String(prefix ?? '').trim();
  const safeId = String(id ?? '').trim();
  if (!/^[a-z][a-z0-9-]*$/.test(safePrefix)) {
    throw new Error(`journal-handoff: invalid prefix: ${JSON.stringify(prefix)}`);
  }
  if (!/^[1-9][0-9]*$/.test(safeId)) {
    throw new Error(`journal-handoff: invalid id: ${JSON.stringify(id)}`);
  }
  if (!/^[0-9a-f]{16}$/.test(String(effectId ?? ''))) {
    throw new Error(`journal-handoff: invalid effectId: ${JSON.stringify(effectId ?? null)}`);
  }
  return `${JOURNAL_PENDING_DIR}/${safePrefix}-${safeId}-effect-${effectId}.json`;
}

// handoff spawn の返り値 schema。saved / logged の意味は buildJournalPendingWriteInstr を参照。
export const JOURNAL_HANDOFF_RESULT = {
  type: 'object',
  required: ['saved', 'logged'],
  properties: {
    saved: { type: 'boolean' },
    logged: { type: 'boolean' },
  },
};

// buildJournalPendingWriteInstr({ prefix, id, payload }): payload を pending/ の確定パスへ
// Write tool で一字一句そのまま書かせる instruction。1 spawn で完結し、中間の一時ファイルは持たない。
//
// prompt に載る値は payload 本文と、payload から決まる書き込み先パスだけにする（呼び出し元の
// 結論値・要約を足さない）。journal-log の spawn は safety classifier にブロックされた実績があり、
// payload 以外の値を prompt に足すとブロックされうる面が広がるため。
//
// shell を一切使わないのは必須の性質で、緩めると issue #526 が再発する: redirect・変数代入・
// コマンド置換・パイプを含む単行コマンドは EnterWorktree 済みセッションの worktree 分離ガードに
// `too complex to verify that it stays inside the worktree` で拒否され、dev-flow / pr-iterate は
// 常にその分離セッションから走るため、shell に依存する限り telemetry は記録されない。Write tool は
// 同じセッションから pending/ へ書けることが実測で確認されており、`~` も Write tool 側で展開される。
//
// 代償: `jq -e` による事前検証と mktemp→mv の atomic 公開は無い。壊れた JSON や（他セッションの
// Stop hook と競合した場合の）部分書き込みは pending/ に現れうるが、Stop hook 側が malformed/ へ
// 隔離し replay runbook で回収できるため、silent loss ではなく観測可能な劣化に留まる。
//
// 返り値の saved / logged は classifyJournalLogStatus の 3 値帰属をそのまま保つための 2 段申告:
// saved は「payload を content にして Write tool を呼び出した（書き込みを試みた）」、logged は
// 「その Write が成功した」。Write の拒否・上書き拒否は saved:true / logged:false（log_failed）、
// 書き込みに到達しなかった場合は saved:false（save_failed）として区別される。
export function buildJournalPendingWriteInstr({ prefix, id, payload }) {
  if (typeof payload !== 'string' || payload === '') {
    throw new Error('journal-handoff: payload is required');
  }
  const pendingPath = buildJournalPendingPath({ prefix, id, effectId: journalEffectId(payload) });

  return `## Journal pending への書き出し\n`
    + `1. \`${pendingPath}\` が既に存在する場合は、先に **Read tool** で同ファイルを読め`
    + `（Write tool は既存ファイルを未 Read のまま上書きできない）。Read が失敗しても手順 2 は必ず試みること。\n`
    + `2. **Write tool** を使い、下記 delimiter 内の JSON を **一字一句そのまま** \`${pendingPath}\` へ書け。\n`
    + `本文は絶対に shell（echo/printf/heredoc 等）へ渡さず、必ず Write tool の content 引数として渡すこと。\n`
    + `エスケープ・再整形・pretty-print・truncate も禁止する。**Bash は使うな** — 書き込みは Write tool のみで行う。\n`
    + `<<<JOURNAL_HANDOFF_BODY_BEGIN>>>\n${payload}\n<<<JOURNAL_HANDOFF_BODY_END>>>\n\n`
    + `3. 手順 2 の Write tool を呼び出したら saved:true（呼び出しに到達しなかったら saved:false）、`
    + `その Write が成功したら logged:true（失敗・拒否されたら logged:false）とし、`
    + `結果を {saved, logged} で返せ。どの手順で失敗しても throw せず {saved, logged} を返すこと。\n`;
}

export const JOURNAL_LOG_STATUSES = ['logged', 'save_failed', 'log_failed'];

// classifyJournalLogStatus({ saved, logged }): reduces the handoff outcome to the 3-value closed
// enum reported on the caller's return object. saved!==true means the payload never reached a
// write attempt (save_failed). logged===true means the pending/ write succeeded (logged). A write
// that was attempted but failed is log_failed.
export function classifyJournalLogStatus({ saved, logged }) {
  if (saved !== true) return 'save_failed';
  if (logged === true) return 'logged';
  return 'log_failed';
}

// journal handoff choreography（issue #494/#499/#556/#607/#807）: payload を pending/ へ書く 1 spawn
// （dev-runner-haiku）と journal_log_status の帰属を canonical 化する。dev-flow.js の
// writeFailureTelemetry / Merge tier 成功 path / top-level abort catch、pr-iterate.js の
// 終端 / top-level abort catch の 5 call site が使う。
// 帰属: spawn の申告 {saved, logged} を classifyJournalLogStatus で 3 値へ落とす。spawn が throw / null
// の場合は Write 到達の申告が無いので save_failed のまま残す（申告の無い段を log_failed と推定しない）。
// fail-open: 例外は内部で吸収し、3 値 closed enum（logged / save_failed / log_failed）のいずれかを
// 必ず返す。gate・merge tier には影響しない。
// deps 注入: agent は呼び出し側の trackedAgent（ABORT_CTX の label 更新・pr-iterate の起動数計上のため）。
// logLabel は call site ごとの label（journal-log / journal-log-failure / journal-log-abort）で、
// prompt には載せない。
// agent は destructure 時に `runAgent` へ alias する（`agent(` という bare 呼び出しリテラルを
// 本体コードへ残さないため）。dev-flow.js / pr-iterate.js の静的検証
// _lib/subagent-invocations-routing.test.mjs は「bare agent( 呼び出しは trackedAgent wrapper
// 内の 2 箇所のみ」を pin しており、本関数が inline 生成される両ワークフローで `agent(` リテラルが
// 増えると誤検出する。呼び出し側の deps 注入契約（キー名 `agent`）は変えない。
export async function runJournalHandoff({ agent: runAgent, log, payload, prefix, id, logLabel, phase }) {
  let journalLogStatus = 'save_failed'
  try {
    const res = await runAgent(
      `## Objective\ntelemetry handoff payload を ~/.claude/journal/pending/ に書き出す（Stop hook が journal へ flush する）。\n\n`
      + `## Instructions\n`
      + buildJournalPendingWriteInstr({ prefix, id, payload })
      + `\n## Output format\n{ "saved": boolean, "logged": boolean }\n`
      + `\n## Tools\n使用可: Write, Read のみ（Read は既存ファイルの冪等上書きに必要）\n`
      + `\n## Boundary\n~/.claude/journal 以外のファイルを変更しない。git 操作禁止。\n`
      + `\n## Token cap\n100 語以内で完結すること。`,
      { agentType: 'dev-runner-haiku', schema: JOURNAL_HANDOFF_RESULT, label: logLabel, phase },
    )
    journalLogStatus = classifyJournalLogStatus({ saved: res?.saved === true, logged: res?.logged === true })
    if (journalLogStatus !== 'logged') {
      log(`⚠️ ${logLabel} の記録に失敗しました（${journalLogStatus}: saved=${res?.saved ?? 'null'}, logged=${res?.logged ?? 'null'}）。ワークフローは継続します。`)
    }
  } catch (e) {
    log(`⚠️ journal handoff 失敗（fail-open）: ${e?.message ?? e}`)
  }
  return journalLogStatus
}

export const ABORT_ERROR_CATEGORY = 'abort';
const ABORT_ERROR_MSG_MAX = 500;

// buildAbortErrorMsg({ phase, label, error }): abort entry の error_msg 単一形
// `abort@<phase>/<label>: <message>`。phase/label 欠落は '?'。message は改行・連続空白を
// 1 個の半角スペースへ正規化し、500 字（全体）で切る。
export function buildAbortErrorMsg({ phase, label, error }) {
  const raw = error && typeof error === 'object' && 'message' in error ? error.message : error;
  const msg = String(raw ?? 'unknown error').replace(/\s+/g, ' ').trim() || 'unknown error';
  return `abort@${phase || '?'}/${label || '?'}: ${msg}`.slice(0, ABORT_ERROR_MSG_MAX);
}

// buildAbortHandoffPayload({ skill, args, issue, repo, pr_number, journal_sh, phase, label,
// error, telemetry }): abort entry の唯一の組み立て口（dev-flow.js / pr-iterate.js の
// top-level catch が使う）。outcome:'failure' + error_category:'abort' + error_phase に固定する
// （legacy fallback / version 分岐なし）。phase/label は error_phase と error_msg に載せ、
// telemetry には呼び出し側が渡したキーだけを入れる。
export function buildAbortHandoffPayload({ skill, args, issue, repo, pr_number, journal_sh, phase, label, error, telemetry }) {
  return buildJournalHandoffPayload({
    skill,
    outcome: 'failure',
    args,
    issue,
    repo,
    pr_number,
    journal_sh,
    error_category: ABORT_ERROR_CATEGORY,
    error_msg: buildAbortErrorMsg({ phase, label, error }),
    error_phase: phase || undefined,
    telemetry,
  });
}

export function repoFromGithubUrl(url) {
  const match = String(url ?? '').match(
    /^https?:\/\/github\.com\/([^\/\s]+)\/([^\/\s#?]+)(?:[\/#?]|$)/,
  );
  if (!match) return null;
  return `${match[1]}/${match[2]}`;
}
