// parseMergeTierFacts: dev-flow Merge tier が使う統合 exec-proxy
// (`_shared/scripts/merge-tier-facts.sh`) の応答をサブ結果ごとに独立に検証する純関数 (issue #637)。
//
// 統合スクリプトは {diffhash, risk, changed, pr, head_tree, checks, closes, epoch} の 1 JSON object を返し、
// サブ結果は全て {ok, value, error?} 形。本関数は「1 サブ結果の不正が他サブ結果の判定に影響しない」
// ことを保証するため、各サブ結果を完全に独立して検証し、旧 6 spawn（diff-hash-merge /
// danger-grep-final / changed-files / gh-pr-view / head-tree-oid / ci-checks）が個別に返していた
// 形へ写す。呼び出し側の判定ロジック（reuseDiffTriage / reconcileDanger / classifyMergeableState /
// hash_reconverged / envChecksGreen）はこの写像の上で不変。
//
// サブ結果別失敗ポリシー（旧 spawn の fail-closed / fail-open 区別と同一）:
//   mergeDiffHash - fail-open。diffhash.ok===true かつ value.hash が string のときのみ採用、それ以外 null
//                   （null は「Diff triage 結果の再利用不可 → danger-grep 再判定」と
//                   「hash_reconverged 判定不能 → hash_mismatch 維持」に倒れる）。
//   risk          - fail-closed。risk.ok===true かつ value が {ok:boolean, hits:array} のときのみ採用。
//                   それ以外は {ok:false, hits:[], error} を合成（null は返さない — hits 欠落を clean と
//                   同一視しない。呼び出し側は risk.ok!==true を dangerFailClosed として HOLD 強制）。
//                   risk.ok===true なのに value が欠落 / 契約外形状の応答は、スクリプトが検証済みの value と
//                   組でしか ok:true を出さない以上 subagent の StructuredOutput 転記で落ちたもの（issue #746）。
//                   danger-grep 実行不能と区別するため error を MERGE_FACTS_RISK_DROPPED_ERROR にし、
//                   isRiskValueDropped で判別させる。
//   changedFiles  - fail-safe。changed.ok===true かつ value.files が string[] のときのみ採用、それ以外 null
//                   （null は isDocsOrTestOnly が false を返し AUTO 昇格しない安全側）。
//   prMeta        - fail-open。pr.ok===true かつ value が object のときのみ {ok:true, mergeable,
//                   mergeStateStatus, headRefOid}、それ以外 {ok:false, error}
//                   （classifyMergeableState が 'unknown' → conflict gate は HOLD しない）。
//   headTreeOid   - fail-open。head_tree.ok===true かつ value.tree が非空 string のときのみ trim して採用
//                   （旧 head-tree-oid spawn と同じ受理条件。40hex 検証は script 側）、それ以外 null
//                   （hash_mismatch 維持 = HOLD）。
//   checks        - fail-open。checks.ok===true かつ value.checks が array のときのみ {ok:true, checks}、
//                   それ以外 {ok:false, error}（ENV item 据え置き + 警告 log）。
//   closes        - fail-open。closes.ok===true かつ value.present が boolean のときのみ 'present' / 'missing'、
//                   それ以外 'unknown'（取得失敗を Closes 欠落と同一視しない。'unknown' は再投入せず
//                   pr_closes_status='unverified' の警告のみ。'missing' だけが Merge tier の再投入へ進み、
//                   再投入失敗 / 再投入後も欠落なら pr_closes_missing で HOLD — issue #824）。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。

// closesCheckCommand({ pr, repo, issue }): PR body に `Closes #<issue>` があるかを gh 側の jq で true / false に
// 畳むコマンド。本文そのものは stdout に出さない — 本文を haiku に転写させると転写のゆれで Closes 行を見落とし
// 偽の pr_closes_missing HOLD を出す（issue #713）。`(\D|$)` は `#8240` を `#824` と数えないための境界。
// 行全体一致ではなく部分一致なのは、GitHub の closing keyword が本文中のどこでも効くのに合わせるため。
export function closesCheckCommand({ pr, repo, issue }) {
  const repoArg = repo ? ' --repo ' + repo : '';
  return `gh pr view ${pr}${repoArg} --json body --jq '.body | test("Closes #${Number(issue)}(\\\\D|$)")'`;
}

// mergeTierFactsPrompt({ wt, base, pr, repo, issue }): 統合 exec-proxy の prompt。
// gh の 3 コマンドは subagent が bare 単文で実行し、stdout を argv で merge-tier-facts へ verbatim 転写する
// （exec-proxy スクリプトは認証付き network I/O を内部に持たない契約。check-ci / finalCiPrompt と同型）。
// PR body は closesCheckCommand で true / false に畳んだ結果だけを渡し、本文を argv にも prompt にも載せない。
// base は origin/ 無しの branch 名を受け、prompt 側で origin/ を付ける（既存 call site と同じ）。
export function mergeTierFactsPrompt({ wt, base, pr, repo, issue }) {
  const repoArg = repo ? ' --repo ' + repo : '';
  const bare = '（cd 前置・`bash` 前置・環境変数代入前置・&& 連結・パイプ・リダイレクトは禁止）';
  return `## Objective\nPR #${pr} の Merge tier 判定に使う事実を取得し、merge-tier-facts の stdout JSON をそのまま返せ。\n\n`
    + `## Tools\n`
    + `- 使用可: Bash のみ\n`
    + `- 禁止: Write, Edit, git commit, git push, git fetch, git pull\n\n`
    + `## Boundary\n`
    + `- 読み取り専用。git mutation（commit/push/reset/fetch/pull 等）禁止。ファイルを変更しない\n\n`
    + `## Steps\n`
    + `1. \`gh pr view ${pr}${repoArg} --json mergeable,mergeStateStatus,headRefOid\` を先頭トークンが gh の bare 単文で 1 回だけ実行せよ${bare}。stdout を <PR_VIEW> とする。\n`
    + `2. \`gh pr checks ${pr}${repoArg} --json name,bucket\` を先頭トークンが gh の bare 単文で 1 回だけ実行せよ${bare}。`
    + `このコマンドの exit code を判定に使ってはならない（pending で 8、失敗ありで 1 を返す仕様であり、fetch 自体の成否とは無関係）。stdout を <CHECKS> とする。\n`
    + `3. \`${closesCheckCommand({ pr, repo, issue })}\` を先頭トークンが gh の bare 単文で 1 回だけ実行せよ${bare}。`
    + `--jq の引数は単一引用符ごと一字一句そのまま渡す（単一引用符内の \`|\` は jq の構文でありシェルのパイプではない）。`
    + `stdout（\`true\` または \`false\`）を <CLOSES> とする。\n`
    + `4. \`merge-tier-facts --worktree ${wt} --base origin/${base} --pr-view-data '<手順1の stdout を一字一句そのまま。要約・整形・省略禁止>' `
    + `--checks-data '<手順2の stdout を一字一句そのまま。要約・整形・省略禁止>' `
    + `--closes-data '<手順3の stdout（true または false）をそのまま>'\` を先頭トークンが merge-tier-facts の bare 単文で 1 回だけ実行せよ。`
    + `手順 1 / 2 / 3 の stdout が空、またはコマンドが実行できなかった場合は当該オプション自体を省略せよ（値を捏造してはならない）。`
    + `argv は一字一句そのまま実行する — which による絶対パス解決・絶対パスへの書き換え・cd 前置・\`bash\` 前置・環境変数代入前置・&& 連結は禁止`
    + `（--worktree で worktree 絶対パスを渡しているため cd は不要）。\n`
    + `5. 手順 4 の stdout の JSON 1 行を **そのまま** 返せ（判定・要約・整形・省略禁止）。`
    + `各サブ結果の \`value\`（中身の object を含む。ok:false のときは null）を省略・空 object 化してはならない。`
    + `手順 4 自体が実行できなかった、または stdout が JSON でない場合のみ \`{"risk":{"ok":false,"value":null,"error":"<stderr の要約>"}}\` を返せ。`
    + `失敗時に ok:true を生成してはならない。原因調査はするな。再試行禁止。\n\n`
    + `## Output format\n`
    + `merge-tier-facts の stdout JSON（{diffhash, risk, changed, pr, head_tree, checks, closes, epoch}。各サブ結果は {ok, value, error?}）\n`
    + `prose 禁止。JSON のみ返せ。\n\n`
    + `## Token cap\n`
    + `JSON のみ。1 行以内。`;
}

// サブ結果が契約通りの形か（{ok:boolean} を持つ object）。error は ok:false 時の診断値。
function subOk(sub) {
  return sub != null && typeof sub === 'object' && sub.ok === true;
}

function subError(sub, fallback) {
  if (sub != null && typeof sub === 'object' && typeof sub.error === 'string' && sub.error !== '') return sub.error;
  return fallback;
}

export function parseMergeDiffHash(facts) {
  const sub = facts?.diffhash;
  const hash = subOk(sub) ? sub.value?.hash : null;
  return typeof hash === 'string' && hash !== '' ? hash : null;
}

// mergeDiffHash が null になった原因の診断値（diffhash サブ結果の error。script は子スクリプトの
// stderr 先頭 300 byte を添える）。hash を採用できるとき・error が無いときは null。
export function mergeDiffHashError(facts) {
  if (parseMergeDiffHash(facts) != null) return null;
  return subError(facts?.diffhash, null);
}

// risk サブ結果が契約通りの形か。fail-closed に倒れた 2 原因 — proxy が契約外形状を返した /
// スクリプトが契約通りの形で ok:false を報告した — を呼び出し側が区別するための述語。
export function isWellFormedRiskFact(facts) {
  const sub = facts?.risk;
  if (!subOk(sub)) return false;
  const v = sub.value;
  return v != null && typeof v === 'object' && typeof v.ok === 'boolean' && Array.isArray(v.hits);
}

// risk.ok===true なのに value が欠落 / 契約外形状（subagent の転記欠落。スクリプトは value が
// {ok:boolean, hits:array} のときだけ ok:true を出すため、ここに来るのは転記で落ちた場合のみ）。
export const MERGE_FACTS_RISK_DROPPED_ERROR = 'merge-tier-facts transcription dropped risk.value (fail-closed)';

export function isRiskValueDropped(facts) {
  return subOk(facts?.risk) && !isWellFormedRiskFact(facts);
}

export function parseRiskFact(facts) {
  if (isWellFormedRiskFact(facts)) return facts.risk.value;
  if (isRiskValueDropped(facts)) return { ok: false, hits: [], error: MERGE_FACTS_RISK_DROPPED_ERROR };
  return { ok: false, hits: [], error: subError(facts?.risk, 'merge-tier-facts risk unavailable (fail-closed)') };
}

export function parseChangedFiles(facts) {
  const sub = facts?.changed;
  const files = subOk(sub) ? sub.value?.files : null;
  if (Array.isArray(files) && files.every((f) => typeof f === 'string')) return files;
  return null;
}

export function parsePrMeta(facts) {
  const sub = facts?.pr;
  if (subOk(sub) && sub.value != null && typeof sub.value === 'object') {
    const v = sub.value;
    return {
      ok: true,
      mergeable: typeof v.mergeable === 'string' ? v.mergeable : null,
      mergeStateStatus: typeof v.mergeStateStatus === 'string' ? v.mergeStateStatus : null,
      headRefOid: typeof v.headRefOid === 'string' ? v.headRefOid : null,
    };
  }
  return { ok: false, error: subError(sub, 'merge-tier-facts pr unavailable') };
}

export function parseHeadTreeOid(facts) {
  const sub = facts?.head_tree;
  const tree = subOk(sub) ? sub.value?.tree : null;
  return typeof tree === 'string' && tree.trim() !== '' ? tree.trim() : null;
}

export function parseChecks(facts) {
  const sub = facts?.checks;
  if (subOk(sub) && Array.isArray(sub.value?.checks)) return { ok: true, checks: sub.value.checks };
  return { ok: false, error: subError(sub, 'merge-tier-facts checks unavailable') };
}

// closes サブ結果 → 'present' | 'missing' | 'unknown'（取得失敗・契約外形状は 'unknown'。fail-open）。
export function parseClosesFact(facts) {
  const sub = facts?.closes;
  const present = subOk(sub) ? sub.value?.present : null;
  if (present === true) return 'present';
  if (present === false) return 'missing';
  return 'unknown';
}

// closes サブ結果 → pr_closes_status の初期値（PR_CLOSES_STATUS_VALUES）。'missing' は Merge tier が
// closesReinjectPrompt で再投入し、closesReinjectStatus の値で置き換える。
export function prClosesStatusOf(closes) {
  if (closes === 'present') return 'verified';
  if (closes === 'missing') return 'missing';
  return 'unverified';
}

// Closes 欠落を検出したときの再投入 exec-proxy（label 'closes-reinject'）の応答 schema。
// closes は再投入後に closesCheckCommand を実行した stdout（'true' / 'false'。実行できなければ省略）。
export const CLOSES_REINJECT = {
  type: 'object',
  required: ['edited'],
  properties: {
    edited: { type: 'boolean' },
    closes: { type: 'string' },
    error: { type: 'string' },
  },
};

// PR #<pr> の本文を run が決定論で組んだ prBody で上書きし、同じ spawn の中で closesCheckCommand を
// 実行して再投入後の Closes 有無を返させる（再確認のための別 spawn を持たない）。本文は Write で
// `.devflow-tmp/pr-body-reinject.md` へ verbatim 保存し、bare 単文の gh pr edit --body-file で渡す。
export function closesReinjectPrompt({ wt, pr, repo, issue, prBody }) {
  const bodyFile = `${wt}/.devflow-tmp/pr-body-reinject.md`;
  const repoArg = repo ? ` --repo ${repo}` : '';
  const bare = '（cd 前置・bash 前置・環境変数代入前置・&& 連結・パイプ・リダイレクト禁止）';
  return `## Objective\n`
    + `PR #${pr} の本文を渡された内容で上書きし、上書き後の本文に Closes #${Number(issue)} があるかを返す。\n\n`
    + `## 本文の保存\n`
    + `**Write tool** を使い、下記 delimiter 内の本文を **一字一句そのまま**（要約・整形・追記・改変・shell 経由の書き出し禁止）`
    + `\`${bodyFile}\` へ保存せよ。\n`
    + `<<<PR_BODY_BEGIN>>>\n${prBody}<<<PR_BODY_END>>>\n\n`
    + `## Steps\n`
    + `1. \`gh pr edit ${pr}${repoArg} --body-file ${bodyFile}\` を先頭トークンが gh の bare 単文で 1 回だけ実行せよ${bare}。`
    + `失敗したら手順 2 へ進まず \`{"edited": false, "error": "<stderr の要約>"}\` を返せ。\n`
    + `2. \`${closesCheckCommand({ pr, repo, issue })}\` を先頭トークンが gh の bare 単文で 1 回だけ実行せよ${bare}。`
    + `--jq の引数は単一引用符ごと一字一句そのまま渡す（単一引用符内の \`|\` は jq の構文でありシェルのパイプではない）。\n`
    + `3. \`{"edited": true, "closes": "<手順2の stdout（true または false）をそのまま>"}\` を返せ。`
    + `手順 2 の stdout が空、またはコマンドが実行できなかった場合は closes を省略せよ（値を捏造してはならない）。原因調査はするな。再試行禁止。\n\n`
    + `## Output format\n{"edited": boolean, "closes"?: "true" | "false", "error"?: string}\nprose 禁止。JSON のみ 1 行で返せ。\n\n`
    + `## Tools\n使用可: Bash, Write\n\n`
    + `## Boundary\n${bodyFile} 以外を書かない。git 操作禁止。本文の書き換え禁止。\n\n`
    + `## Token cap\nJSON のみ。1 行以内。`;
}

// 再投入 exec-proxy の応答 → pr_closes_status。再投入失敗（edited!==true / null）と再投入後も欠落は
// 'missing'（fail-closed: classifyMergeTier が pr_closes_missing で HOLD）、再投入後に Closes を確認できれば
// 'reinjected'、再投入は通ったが確認の取得に失敗したら 'unverified'（fail-open。確認 probe の失敗を欠落と
// 同一視しない）。
export function closesReinjectStatus(res) {
  if (res == null || typeof res !== 'object' || res.edited !== true) return 'missing';
  const closes = typeof res.closes === 'string' ? res.closes.trim() : '';
  if (closes === 'true') return 'reinjected';
  if (closes === 'false') return 'missing';
  return 'unverified';
}

// 診断用: facts の top-level キー一覧（契約外形状のとき log に出す）
export function mergeTierFactsTopLevelKeys(facts) {
  if (facts == null) return 'null';
  if (typeof facts !== 'object') return typeof facts;
  const keys = Object.keys(facts);
  return keys.length ? keys.join(',') : '(none)';
}

export function parseMergeTierFacts(facts) {
  return {
    mergeDiffHash: parseMergeDiffHash(facts),
    risk: parseRiskFact(facts),
    changedFiles: parseChangedFiles(facts),
    prMeta: parsePrMeta(facts),
    headTreeOid: parseHeadTreeOid(facts),
    checks: parseChecks(facts),
    closes: parseClosesFact(facts),
  };
}
