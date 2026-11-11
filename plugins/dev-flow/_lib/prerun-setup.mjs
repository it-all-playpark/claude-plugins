// prerun setup: dev-flow.js の Setup phase が args.setup（dev-flow-prerun の stdout JSON）を
// fail-closed に検証・要約するための純関数群。
//
// dev-flow-prerun（wrapper preflight の bare 名 launcher）が base 解決・worktree 作成/再利用・
// .devflow-tmp の clean・framework 検出・issue analyze（analyze-issue --contract + Jev 有界判定）を行い、
// wrapper が別の Bash 呼び出しで回す ensure-worktree-deps --setup がその出力に deps と epoch_end を足して
// stdout JSON 1 行として返す（issue #868）。wrapper がそれを Workflow({ args: { issue, setup } }) の args.setup として渡すため、
// dev-flow.js 側はこれを唯一の入力源として検証する（workflow 内 fallback は持たない）。
// validatePrerunSetup: args.setup を検証し、Setup phase が使う正規化済み値を返す純関数。
//   raw が欠落/非 object/配列、raw.ok !== true、必須キー欠落/型不正のいずれも即 throw する
//   （fallback を作らない — 後方互換 scaffolding 禁止）。
// rejectLegacyBaseArg: 旧形式 args.base（base は dev-flow-prerun が解決し args.setup.base で渡る）
//   を検出し即 throw する純関数。Setup phase の try 節に入る前（args 節）で呼ぶことを想定する。
// summarizePrerunDeps: prerun の deps 結果（advisory）を implementer prompt 注入用の警告文と
//   ログ行に要約する純関数。deps.ok:false でも top-level ok には影響しない（fail-open）。
// hasNextJs: stack.frameworks に 'next' が含まれるかを判定する純関数。Turbopack 規約注入の判定に使う。
// testDiscoveryNote: Setup が解決したテストコマンド（dev-flow-test-commands の返り値。redgreen-verify が --commands で読む
//   のと同じもの）を evaluator prompt に注入する test_files の受理条件の文に整形する純関数。
// normalizeCiVerify: prerun の ci_verify（repo の CI 判定の宣言。null は未設定）を検証・正規化する純関数。
// normalizeLocalVerify: prerun の local_verify（ci の AC をローカル実行で判定する宣言。null は未設定）を検証・正規化する純関数。
// normalizeVisualSnapshots: prerun の visual_snapshots（基準画像を撮り直すコマンドと基準画像のディレクトリの宣言。null は未設定）を
//   受け取る純関数。宣言の検証は prerun（_shared/scripts/devflow-config.sh の devflow_visual_snapshots_of）が済ませているので、
//   ここは workflow が読むキーの型だけを確かめる。
// normalizePrTitleFormat: prerun の pr_title_format（commit subject = PR タイトルのテンプレート。null は未設定）を検証する純関数。
// analyze: prerun の analyze 段の結果（{ok, ...}）。ok:true の中身の whitelist 検証は
//   buildReqFromContract（_lib/analyze-contract.mjs）が担い、ここでは object / ok boolean /
//   ok:false のときの reason string だけを fail-closed に検証して verbatim で返す。
//
// INLINE COPY POLICY: workflow から参照される最上位宣言だけが tools/sync-inlines.mjs --write で inline 生成される。
// 直接 workflow 側を編集しない。一致は _lib/workflow-inlines.sync.test.mjs が検証する。
// 制約: ESM import / require / Date.now / Math.random を含めない。export function / export const のみ。

// security_reviewer の閉じた enum（pr-iterate の args.security_reviewer と同じ値）
export const SECURITY_REVIEWERS = ['claude', 'codex'];

export const PRERUN_MISSING_MSG = 'dev-flow: args.setup が無い — /dev-flow wrapper（dev-flow/SKILL.md の preflight）で `dev-flow-prerun --issue <N> --worktree <path>` を実行し、続けて別の Bash 呼び出しで `ensure-worktree-deps --setup <worktree>/.devflow-tmp/prerun-setup.json` を実行して、その stdout JSON を Workflow の args.setup に渡せ（workflow 内 fallback は無い）';

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function stringifyForError(value) {
  if (value === undefined) return 'undefined';
  try {
    const repr = JSON.stringify(value);
    return repr === undefined ? String(value) : repr;
  } catch {
    return String(value);
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function rejectLegacyBaseArg(args) {
  if (isPlainObject(args) && Object.prototype.hasOwnProperty.call(args, 'base')) {
    throw new Error('dev-flow: args.base は受理しない — base は dev-flow-prerun [--base <ref>] が解決し args.setup.base で渡る');
  }
}

export function validatePrerunSetup(raw, issue) {
  if (!isPlainObject(raw)) {
    throw new Error(PRERUN_MISSING_MSG);
  }

  if (raw.ok !== true) {
    throw new Error(
      `dev-flow: args.setup.ok が true でない — dev-flow-prerun が失敗している`
      + `（base_error: ${raw.base_error ?? '-'} / worktree_error: ${raw.worktree_error ?? '-'} / worktree_status: ${raw.worktree_status ?? '-'}）。`
      + `SKILL.md の preflight に従い prerun の失敗を解消してから再実行せよ`,
    );
  }

  const fail = (key, value) => {
    throw new Error(`dev-flow: args.setup の必須キーが欠落/型不正: ${key}（受信: ${stringifyForError(value)}）`);
  };

  // wrapper は issue ごと・needs_clarification 再起動ごとに prerun を再実行する契約。別 issue の
  // stale な setup を渡されると別 worktree / base で黙って走るので、issue 一致を fail-closed で検証する
  if (!(Number.isInteger(raw.issue) && raw.issue > 0)) fail('issue', raw.issue);
  if (raw.issue !== Number(issue)) {
    throw new Error(`dev-flow: args.setup.issue (${raw.issue}) が起動 issue (${issue}) と一致しない — この issue 用に dev-flow-prerun を実行し直し、その stdout JSON を渡せ`);
  }
  if (!isNonEmptyString(raw.base)) fail('base', raw.base);
  if (!isNonEmptyString(raw.worktree) || !raw.worktree.startsWith('/')) fail('worktree', raw.worktree);
  if (!isNonEmptyString(raw.head)) fail('head', raw.head);
  if (!isPlainObject(raw.deps)) fail('deps', raw.deps);
  if (typeof raw.deps.ok !== 'boolean') fail('deps.ok', raw.deps.ok);
  if (typeof raw.deps.note !== 'string') fail('deps.note', raw.deps.note);
  if (!isPlainObject(raw.stack)) fail('stack', raw.stack);
  if (!Array.isArray(raw.stack.frameworks)) fail('stack.frameworks', raw.stack.frameworks);
  const isStringList = (v) => Array.isArray(v) && v.every(isNonEmptyString);
  // analyze（issue #690）: prerun の analyze 段（analyze-issue --contract + Jev）の結果。ok:false は
  // Setup 末尾の analyze ゲートが needs_clarification（source=analyze_prerun）に倒すため throw しない（reason 必須）。
  if (!isPlainObject(raw.analyze)) fail('analyze', raw.analyze);
  if (typeof raw.analyze.ok !== 'boolean') fail('analyze.ok', raw.analyze.ok);
  if (raw.analyze.ok === false && !isNonEmptyString(raw.analyze.reason)) fail('analyze.reason', raw.analyze.reason);
  if (!(Number.isInteger(raw.epoch) && raw.epoch > 0)) fail('epoch', raw.epoch);
  // epoch_end は deps install 完了後（ensure-worktree-deps --setup。prerun の後に走る）で採る第2の時刻。
  // setup_end mark（implement 区間の起点）はここから給電する（epoch から給電すると deps install 等の
  // Setup 決定論処理時間が丸ごと implement の phase_durations に付け替わるため）。
  if (!(Number.isInteger(raw.epoch_end) && raw.epoch_end > 0)) fail('epoch_end', raw.epoch_end);
  // ci_wait_ceiling_seconds は nested pr-iterate の CI 待ちの上限（秒）。prerun が base branch の CI 所要時間から
  // 決め（_shared/scripts/ci-wait-ceiling.sh）、dev-flow は加工せず pr-iterate の args.ci_wait_ceiling_seconds へ渡す
  if (!(Number.isInteger(raw.ci_wait_ceiling_seconds) && raw.ci_wait_ceiling_seconds > 0)) fail('ci_wait_ceiling_seconds', raw.ci_wait_ceiling_seconds);
  // security_reviewer は nested pr-iterate の security review を回す CLI の opt-in（"dev-flow".security_reviewer）。prerun が
  // base branch か user 設定から読み（未設定は "claude"）、dev-flow は pr-iterate の args.security_reviewer へ渡す。
  // 品質ゲートの判定者なので、欠落・out-of-enum を "claude" に倒さず明示 error にする
  if (!SECURITY_REVIEWERS.includes(raw.security_reviewer)) {
    throw new Error(`dev-flow: args.setup の必須キーが欠落/型不正: security_reviewer（${SECURITY_REVIEWERS.join(' | ')}。受信: ${stringifyForError(raw.security_reviewer)}）— skill-config の "dev-flow".security_reviewer を直して dev-flow-prerun を再実行せよ`);
  }
  // hooks_not_running は repo が追跡している hook のうち worktree で動かない event 名（worktree-checkout.sh）。終端サマリーへの
  // 開示だけに使い、gate の入力にしない。欠落を [] に倒すと「動いている」と区別できないので必須にする
  if (!isStringList(raw.hooks_not_running)) fail('hooks_not_running', raw.hooks_not_running);

  const repo = isNonEmptyString(raw.repo) ? raw.repo : null;
  // branch は prerun が "dev-flow".branch_format（未設定は feature/issue-{issue}）で決めた作業ブランチ名。欠落時の
  // feature/issue-<N> は書式が未設定のときだけ prerun の名前と一致する（設定した書式の名前は --slug や既存ブランチで
  // 決まり、ここでは作れない）ので、書式があるのに branch が無ければ fail-closed で throw する
  if (!isNonEmptyString(raw.branch) && raw.branch_format != null) fail('branch', raw.branch);
  const branch = isNonEmptyString(raw.branch) ? raw.branch : `feature/issue-${issue}`;
  const frameworks = raw.stack.frameworks.filter((f) => typeof f === 'string');
  const ciVerify = normalizeCiVerify(raw.ci_verify);
  const localVerify = normalizeLocalVerify(raw.local_verify);
  const visualSnapshots = normalizeVisualSnapshots(raw.visual_snapshots);
  const prTitleFormat = normalizePrTitleFormat(raw.pr_title_format);

  return {
    base: raw.base.trim(),
    worktree: raw.worktree,
    branch,
    head: raw.head,
    repo,
    deps: { ok: raw.deps.ok, note: raw.deps.note },
    frameworks,
    analyze: raw.analyze,
    epoch: raw.epoch,
    epoch_end: raw.epoch_end,
    ci_wait_ceiling_seconds: raw.ci_wait_ceiling_seconds,
    security_reviewer: raw.security_reviewer,
    hooks_not_running: [...raw.hooks_not_running],
    ci_verify: ciVerify,
    local_verify: localVerify,
    visual_snapshots: visualSnapshots,
    pr_title_format: prTitleFormat,
  };
}

// pr_title_format: prerun が ci_verify と同じファイルから読んだ "dev-flow".pr_title_format。commit subject（= PR タイトル）
// の形は参画先の repo の規約で違う（`#<番号> <説明>` 等）ので repo が宣言する。差し込みは
// `{prefix}`（`type(scope)` か `type`）・`{type}`・`{scope}`・`{title}`・`{issue}`。埋めるのは _lib/pr-artifacts.mjs の buildCommitMessage。
// null / 欠落は未設定（既定の `{prefix}: {title} (#{issue})`）。`{title}` が無い・未知の `{...}`・改行入りは fail-closed で
// throw する — 黙って既定に倒すと repo の規約に合わない PR を作り続け、誤記に気付けないため。
export function normalizePrTitleFormat(raw) {
  if (raw == null) return null;
  const fail = (why) => {
    throw new Error(`dev-flow: skill-config の "dev-flow".pr_title_format が不正（${why}。受信: ${stringifyForError(raw)}）— {prefix} / {type} / {scope} / {title} / {issue} を差し込める 1 行の文字列（{title} 必須）に直してから再実行せよ`);
  };
  if (!isNonEmptyString(raw)) fail('空でない文字列でない');
  if (/[\r\n]/.test(raw)) fail('改行を含む');
  if (!raw.includes('{title}')) fail('{title} が無い');
  const unknown = (raw.match(/\{[^{}]*\}/g) ?? []).filter((p) => !['{prefix}', '{type}', '{scope}', '{title}', '{issue}'].includes(p));
  if (unknown.length) fail(`未知の差し込み ${unknown.join(' ')}`);
  return raw.trim();
}

// ci_verify（issue #861）: prerun が _shared/scripts/devflow-config.sh で、解決した base の origin/<base> の
// skill-config.json → .claude/skill-config.json → user 設定の順に読んだ "dev-flow".ci_verify（worktree とメイン checkout の
// 作業ツリーの設定は読まない — 実装が書き換えた宣言を判定に使わない）。sandbox 内で実行できない検証（E2E 等）を CI のどの check で判定するかを repo が宣言する。
//   label: AC に ci があれば PR に付けるラベル（CI がこのラベルで対象 job を回す）
//   checks: LGTM 後に完了を待つ check 名（gh pr checks の name）
//   commands: AC の inline code がこれに当たれば actor を ci にする（_lib/ac-actor.mjs の matchesCiVerify）
//   wait_ceiling_seconds: checks の完了を待つ上限（秒）
// null / 欠落は未設定（従来どおり）。設定されていて形が不正なら fail-closed で throw する — 不正な宣言を黙って
// 無視すると、CI に回すはずの AC が agent に戻って reimpl を空回りさせるため。
export function normalizeCiVerify(raw) {
  if (raw == null) return null;
  const fail = (key, value) => {
    throw new Error(`dev-flow: skill-config の "dev-flow".ci_verify.${key} が不正（受信: ${stringifyForError(value)}）— { label: string, checks: string[]（1 件以上）, commands: string[], wait_ceiling_seconds: 正の整数 } に直してから再実行せよ`);
  };
  if (!isPlainObject(raw)) fail('(object)', raw);
  if (!isNonEmptyString(raw.label)) fail('label', raw.label);
  const isNameList = (v) => Array.isArray(v) && v.every(isNonEmptyString);
  if (!isNameList(raw.checks) || raw.checks.length === 0) fail('checks', raw.checks);
  // checks は check-ci の --exclude / --only に入り、その単文を hooks/pretool-stdout-relay-guard.sh が改行・| ; & < > ` $ を
  // 含むだけで deny する（引用符の中でも）。通すと全 round の CI 判定が中継失敗になるので、設定の時点で止める
  if (raw.checks.some((c) => /[\n\r|;&<>`$]/.test(c))) fail('checks（改行・| ; & < > ` $ を含む check 名は CI 判定の中継で実行できない）', raw.checks);
  if (!isNameList(raw.commands)) fail('commands', raw.commands);
  if (!(Number.isInteger(raw.wait_ceiling_seconds) && raw.wait_ceiling_seconds > 0)) fail('wait_ceiling_seconds', raw.wait_ceiling_seconds);
  return {
    label: raw.label.trim(),
    checks: raw.checks.map((c) => c.trim()),
    commands: raw.commands.map((c) => c.trim()),
    wait_ceiling_seconds: raw.wait_ceiling_seconds,
  };
}

// local_verify（issue #863）: prerun が ci_verify と同じファイルから読んだ "dev-flow".local_verify。ci の AC を、
// pg-broker の使い捨て Postgres に向けたローカル実行（local-verify）で PR 前に判定するための宣言。
//   command: worktree を cwd に実行する検証コマンド（exit 0 で ci の AC を satisfied にする）
//   db: { engine: 'postgres', version } — pg-broker create --version に渡す
//   env: database_url を入れて command に渡す環境変数名
//   timeout_seconds: command の上限（秒）
// null / 欠落は未設定（ci の AC は CI の check で判定する）。形が不正なら ci_verify と同じく fail-closed で throw する。
export function normalizeLocalVerify(raw) {
  if (raw == null) return null;
  const fail = (key, value) => {
    throw new Error(`dev-flow: skill-config の "dev-flow".local_verify.${key} が不正（受信: ${stringifyForError(value)}）— { command: string, db: { engine: "postgres", version: string }, env: 環境変数名, timeout_seconds: 正の整数 } に直してから再実行せよ`);
  };
  if (!isPlainObject(raw)) fail('(object)', raw);
  if (!isNonEmptyString(raw.command)) fail('command', raw.command);
  if (!isPlainObject(raw.db)) fail('db', raw.db);
  if (raw.db.engine !== 'postgres') fail('db.engine', raw.db.engine);
  if (!isNonEmptyString(raw.db.version)) fail('db.version', raw.db.version);
  if (!(typeof raw.env === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(raw.env))) fail('env', raw.env);
  if (!(Number.isInteger(raw.timeout_seconds) && raw.timeout_seconds > 0)) fail('timeout_seconds', raw.timeout_seconds);
  return {
    command: raw.command.trim(),
    db: { engine: 'postgres', version: raw.db.version.trim() },
    env: raw.env,
    timeout_seconds: raw.timeout_seconds,
  };
}

// visual_snapshots（issue #1410）: prerun が検証済みの "dev-flow".visual_snapshots。dev-flow-evaluate が Evaluate の各評価の前に
// command を local-verify で実行し、paths の下で変わった PNG を PR に入れる。未設定（null / 欠落）は null。
export function normalizeVisualSnapshots(raw) {
  if (raw == null) return null;
  const ok = isPlainObject(raw) && isNonEmptyString(raw.command) && Number.isInteger(raw.timeout_seconds) && raw.timeout_seconds > 0
    && Array.isArray(raw.paths) && raw.paths.length > 0 && raw.paths.every(isNonEmptyString);
  if (!ok) {
    throw new Error(`dev-flow: args.setup の visual_snapshots が不正（受信: ${stringifyForError(raw)}）— dev-flow-prerun が検証して出した値（{ command, db, env, timeout_seconds, paths }）をそのまま渡せ`);
  }
  return raw;
}

export function summarizePrerunDeps(deps) {
  const note = deps && typeof deps.note === 'string' ? deps.note : '';
  if (deps && deps.ok === true) {
    return {
      outcome: 'ok',
      logLine: 'Setup(deps): ' + (note ? `依存インストール完了 — ${note}` : 'lockfile なし / 依存なし — install skip'),
      implNote: null,
    };
  }
  const msg = note || '依存インストール結果を確認できなかった';
  return {
    outcome: 'warn',
    logLine: `⚠️ Setup(deps): ${msg}（fail-open で続行）`,
    implNote: `依存インストール警告: ${msg}。この worktree では依存（node_modules 等）が未整備の可能性がある。自分の task の実装/テスト実行に必要なら worktree 直下で install コマンド（例: npm ci）を自分で実行してよい（lockfile は書き換えるな）。\n`,
  };
}

export function hasNextJs(frameworks) {
  return Array.isArray(frameworks) && frameworks.includes('next');
}

// redgreen-verify は test_files を、Setup が base の tree から解決したテストコマンド（コマンドファイル）の形でだけ実行する。
// evaluator にはその解決結果（解決元と起動の形）を渡す — 言語別の受理パターンの一覧は持たない（解決したコマンドで実行できない
// test_files を申告させると red→green が成立せず、解決できていない run で申告させると全ペアが入力エラーになる）。
export function testDiscoveryNote(testCommands) {
  const head = 'test_discovery（Setup が base ブランチの tree から解決したテストコマンド。redgreen-verify は test_files をこの形でだけ実行して red→green を測る）: ';
  const tc = testCommands;
  const tail = '（テストと実装の混在ファイルも挙げない）。\n';
  const resolved = tc != null && tc.status === 'resolved' && isNonEmptyString(tc.commands_file);
  const sources = resolved && Array.isArray(tc.sources) ? tc.sources.join(', ') : '';
  if (resolved && tc.source === 'runners') {
    return head + `解決元は base の tests/run-*.sh（${sources}）。各 script に test_files の一覧を DEVFLOW_TEST_FILES で渡して実行する — `
      + 'test_files はこれらの script が扱うテストファイルに限れ' + tail;
  }
  const entries = resolved && Array.isArray(tc.commands)
    ? tc.commands.filter((e) => e != null && isNonEmptyString(e.dir) && isNonEmptyString(e.files_command)) : [];
  const from = tc != null && tc.source === 'user_config' ? 'user 設定' : `resolver（根拠: ${sources}）`;
  if (entries.length === 1 && entries[0].dir === '.') {
    return head + `解決元は ${from}。\`${entries[0].files_command}\` の {files} に test_files を入れて実行する — `
      + 'test_files はこのコマンドで実行できるテストファイルに限れ' + tail;
  }
  if (entries.length > 0) {
    // コマンドは起動するディレクトリ（dir）ごと。redgreen-verify は 1 ペアの test_files を 1 つの dir のコマンドで実行する
    const list = entries.map((e) => `${e.dir} → \`${e.files_command}\``).join(' / ');
    return head + `解決元は ${from}。コマンドは起動するディレクトリごと（${list}。"." は repo の root）。test_files（repo の root からの相対パス）を含む最も深いディレクトリのコマンドを、`
      + 'そのディレクトリを cwd に {files} へディレクトリからの相対パスを入れて実行する — test_files はこれらのディレクトリ配下でそのコマンドが実行できるテストファイルに限り、'
      + '1 つの AC の test_files は同じディレクトリのコマンドに振り分けられるものにせよ' + tail;
  }
  return head + 'テストコマンド未解決 — test_files を挙げず verified_by は "inspection" にせよ。\n';
}
