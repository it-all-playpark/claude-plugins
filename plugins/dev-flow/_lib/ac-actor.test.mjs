// _lib/ac-actor.test.mjs
// AC の actor 分類（agent / human / ci）と、ac_results の actor 別集計・差し戻し用 fix_feedback の pin（issue #747 / #861）。
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AC_ACTORS, AC_SCOPES, AGENT_AC_REIMPL_MAX, classifyAcActor, acActorsOf, unsatisfiedAcByActor, agentAcFeedback, matchesCiVerify, ciAcIndexes, applyCiAcResults, unsatisfiedCiAcIndexes, dropCiAcFeedback, classifyAcScope, mixedScopeAcReasons, isObservationalAc, acObservationalOf, deterministicAcIndexes, demoteUnprovenObservationalAc, pendingAcObservationalIndexes, resolveAcObservational, acObservationalPrompt, hasJudgedHumanAcGap } from './ac-actor.mjs';
import { KNOWN_OBSERVATIONAL_ACS } from './test-helpers/observational-ac-controls.mjs';

// repo 内外が混ざった AC（テスト・README・rules の削除と dotfiles の excludedCommands の変更を 1 つに書いたもの）
const MIXED_AC = '古い skill を参照するテスト・README・rules を削除し、dotfiles の excludedCommands から dev-flow-doctor を外す';
// repo 外の作業だけを書いた AC
const EXTERNAL_AC = 'dotfiles の `claude-code/settings.json` の excludedCommands に dev-flow-health の起動形を足す';

test('[ac-actor] 「ローカルで測って PR 本文に書く」型の AC は agent', () => {
  assert.equal(classifyAcActor('512Mi で、想定する同時生成数の worker を持てることをローカルで測り、PR 本文に書く'), 'agent');
  assert.equal(classifyAcActor('Merge tier の HOLD 理由で、人手 AC 待ちとエージェント AC 未達を区別できる'), 'agent');
});

test('[ac-actor] （人手）表記・staging・本番・外部サービス・issue へのコメントは human', () => {
  for (const ac of [
    'staging で実測する（人手）',
    'Cloud Run の設定値を確認する(人手)',
    'staging にデプロイして動作確認する',
    'ステージング環境で 1 回生成する',
    '本番環境の worker 数を 4 に変更する',
    'production 環境で flag を有効にする',
    '外部サービスの Webhook 設定を更新する',
    '結果を issue にコメントする',
    '計測値を issue へのコメントで共有する',
  ]) assert.equal(classifyAcActor(ac), 'human', ac);
});

test('[ac-actor] inline code で引用しただけの `（人手）` は human にしない', () => {
  assert.equal(classifyAcActor('`（人手）` と書かれた AC だけが未達の場合は、差し戻さずに HOLD（人手待ち）になる'), 'agent');
  assert.equal(classifyAcActor('`staging` ラベルの付いた PR を skip する'), 'agent');
});

test('[ac-actor] 空・非文字列は agent（判定できない AC は差し戻し側に倒す）', () => {
  assert.equal(classifyAcActor(''), 'agent');
  assert.equal(classifyAcActor(null), 'agent');
  assert.deepEqual(AC_ACTORS, ['agent', 'human', 'ci']);
  assert.ok(Number.isInteger(AGENT_AC_REIMPL_MAX) && AGENT_AC_REIMPL_MAX >= 1);
});

test('[ac-actor] acActorsOf は index 順に actor を返す（非配列は空）', () => {
  assert.deepEqual(acActorsOf(['ローカルで測る', 'staging で確認する（人手）']), ['agent', 'human']);
  assert.deepEqual(acActorsOf(undefined), []);
});

test('[ac-actor] unsatisfiedAcByActor: satisfied:false だけを actor 別に数え、範囲外・重複・不正 index は数えない', () => {
  const actors = ['agent', 'human', 'agent'];
  const r = unsatisfiedAcByActor([
    { ac_index: 0, satisfied: false },
    { ac_index: 1, satisfied: false },
    { ac_index: 2, satisfied: true },
    { ac_index: 0, satisfied: false },
    { ac_index: 7, satisfied: false },
    { ac_index: '1', satisfied: false },
    null,
  ], actors);
  assert.deepEqual(r, { agent: [0], human: [1], ci: [] });
  assert.deepEqual(unsatisfiedAcByActor(null, actors), { agent: [], human: [], ci: [] });
});

// ---- issue #861: ci の AC（repo の "dev-flow".ci_verify で CI の check が判定する AC） ----

// acme/webapp#105 の AC#4（E2E は sandbox 内で DB が起動せず実行できない）
const WEBAPP_105_AC4 = '`pnpm test:e2e:local`（または full-ci ラベルの CI）で `tenant-isolation.spec.ts` が通ることを確認する';
const CI_VERIFY = { label: 'full-ci', commands: ['pnpm test:e2e:local'] };

test('[ac-actor] ci_verify の commands を inline code で書いた / label に言及した AC は ci、ci_verify が無ければ従来どおり', () => {
  assert.equal(classifyAcActor(WEBAPP_105_AC4, { ciVerify: CI_VERIFY }), 'ci');
  assert.equal(classifyAcActor(WEBAPP_105_AC4), 'agent');
  assert.equal(classifyAcActor(WEBAPP_105_AC4, { ciVerify: null }), 'agent');
  // commands だけ・label だけでも ci（どちらか一方に当たれば足りる）
  assert.equal(classifyAcActor('`pnpm test:e2e:local` で spec が通る', { ciVerify: { label: 'other', commands: ['pnpm test:e2e:local'] } }), 'ci');
  assert.equal(classifyAcActor('`pnpm test:e2e:local --grep tenant` が通る', { ciVerify: CI_VERIFY }), 'ci');
  assert.equal(classifyAcActor('full-ci ラベルの CI で通る', { ciVerify: { label: 'full-ci', commands: [] } }), 'ci');
  assert.deepEqual(acActorsOf(['a', WEBAPP_105_AC4], { ciVerify: CI_VERIFY }), ['agent', 'ci']);
  assert.deepEqual(acActorsOf(['a', WEBAPP_105_AC4]), ['agent', 'agent']);
});

test('[ac-actor] negative control: vitest のテスト追加・`pnpm test` が通る AC は ci_verify があっても agent', () => {
  for (const ac of [
    'vitest で tenant 分離のテストを追加する',
    '`pnpm test` が通る',
    '`pnpm test:e2e:locale` が通る',
    'full-ci-nightly の設定は変えない',
  ]) assert.equal(classifyAcActor(ac, { ciVerify: CI_VERIFY }), 'agent', ac);
  assert.equal(matchesCiVerify('`pnpm test` が通る', CI_VERIFY), false);
});

test('[ac-actor] （人手）・staging の明示は ci より優先し、ci は観測型より優先する', () => {
  assert.equal(classifyAcActor('staging で `pnpm test:e2e:local` を流す', { ciVerify: CI_VERIFY }), 'human');
  assert.equal(classifyAcActor(WEBAPP_105_AC4, { ciVerify: CI_VERIFY, observational: true }), 'ci');
});

test('[ac-actor] ci の AC: CI の結果で ac_results を置き換え、success だけ satisfied。未達は ci に数え agent / human に数えない', () => {
  const actors = ['agent', 'ci'];
  assert.deepEqual(ciAcIndexes(actors), [1]);
  const evalResults = [
    { ac_index: 0, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
    { ac_index: 1, satisfied: true, verified_by: 'inspection', evidence: 'evaluator の判定は使わない' },
  ];
  const pending = applyCiAcResults(evalResults, actors, null);
  assert.equal(pending[1].satisfied, false);
  assert.equal(pending[1].ci, true);
  assert.equal(pending[1].verified_by, 'ci');
  assert.deepEqual(unsatisfiedAcByActor(pending, actors), { agent: [], human: [], ci: [1] });
  const passed = applyCiAcResults(evalResults, actors, { status: 'passed', checks: ['e2e'], urls: ['https://github.com/o/r/actions/runs/2/job/22'] });
  assert.equal(passed[1].satisfied, true);
  assert.match(passed[1].evidence, /e2e.*success.*runs\/2\/job\/22/);
  assert.deepEqual(unsatisfiedCiAcIndexes(actors, { status: 'passed' }), []);
  for (const status of ['pending', 'failed', 'error', 'not_run']) assert.deepEqual(unsatisfiedCiAcIndexes(actors, { status }), [1], status);
  assert.equal(applyCiAcResults(null, actors, null), null);
});

test('[ac-actor] ci の AC: local-verify の結果（source:local）なら verified_by:local、根拠は log_path と exit code', () => {
  const actors = ['agent', 'ci'];
  const evalResults = [{ ac_index: 0, satisfied: true, verified_by: 'inspection', evidence: 'ok' }];
  const local = { source: 'local', command: 'pnpm test:e2e:local', log_path: '/wt/.devflow-tmp/local-verify/logs/command.log' };
  const passed = applyCiAcResults(evalResults, actors, { ...local, status: 'passed', exit_code: 0 });
  assert.deepEqual({ ...passed[1], evidence: undefined }, { ac_index: 1, satisfied: true, verified_by: 'local', ci: true, evidence: undefined });
  assert.equal(passed[1].evidence, 'ローカル実行（pnpm test:e2e:local）が exit 0: /wt/.devflow-tmp/local-verify/logs/command.log');
  const failed = applyCiAcResults(evalResults, actors, { ...local, status: 'failed', exit_code: 1 });
  assert.equal(failed[1].satisfied, false);
  assert.match(failed[1].evidence, /exit 1（差し戻し上限まで直らなかった）: \/wt\//);
});

test('[ac-actor] dropCiAcFeedback: ci の AC に結び付いた evaluator feedback を差し戻しから外す', () => {
  const fb = [{ topic: 'a', ac_index: 1 }, { topic: 'b', ac_index: 0 }, { topic: 'c' }];
  assert.deepEqual(dropCiAcFeedback(fb, ['agent', 'ci']).map((f) => f.topic), ['b', 'c']);
  assert.equal(dropCiAcFeedback(fb, ['agent', 'agent']), fb);
});

test('[ac-actor] unsatisfiedAcByActor: unreachable_env:true の agent AC は差し戻さず human（人手 AC 待ち）に数える', () => {
  const actors = ['agent', 'agent'];
  const r = unsatisfiedAcByActor([
    { ac_index: 0, satisfied: false, unreachable_env: true },
    { ac_index: 1, satisfied: false },
  ], actors);
  assert.deepEqual(r, { agent: [1], human: [0], ci: [] });
});

test('[ac-actor] hasJudgedHumanAcGap: 人手 AC 待ちに文面で人手になった AC（HUMAN_AC_PATTERNS・external）以外があるときだけ true', () => {
  const acs = [
    '（人手）staging で動作を確認する',
    '`~/.claude/settings.json` に許可を足す',
    '実 run の journal に `duration_seconds` が記録される',
    'worker 数の上限を設定で変えられる',
  ];
  // 文面で人手（明示・repo 外）だけなら false
  assert.equal(hasJudgedHumanAcGap([0, 1], acs, { repo: 'acme/app' }), false);
  // 観測型（文面は agent）・unreachable_env（文面は agent）で人手になった AC があれば true
  assert.equal(hasJudgedHumanAcGap([0, 2], acs, { repo: 'acme/app' }), true);
  assert.equal(hasJudgedHumanAcGap([3], acs, { repo: 'acme/app' }), true);
  // 人手 AC 待ちが無ければ false
  assert.equal(hasJudgedHumanAcGap([], acs), false);
  assert.equal(hasJudgedHumanAcGap(null, acs), false);
  // inline code で引用しただけの `（人手）` は文面の人手にしない
  assert.equal(hasJudgedHumanAcGap([0], ['`（人手）` の表記を README に書く']), true);
});

test('[ac-actor] agentAcFeedback: evaluator feedback と同じ形で AC 番号・本文・根拠と PR 本文の返し方を渡す', () => {
  const fb = agentAcFeedback([0], ['ローカルで測り PR 本文に書く'], [{ ac_index: 0, satisfied: false, evidence: 'コードのコメントにだけ記載' }]);
  assert.equal(fb.length, 1);
  assert.equal(fb[0].severity, 'major');
  assert.equal(fb[0].topic, 'AC-1 未達');
  assert.match(fb[0].description, /AC-1「ローカルで測り PR 本文に書く」/);
  assert.match(fb[0].description, /コードのコメントにだけ記載/);
  assert.match(fb[0].suggestion, /pr_notes/);
  assert.match(fb[0].suggestion, /design_decisions/);
  assert.match(agentAcFeedback([0], ['x'], [])[0].description, /根拠なし/);
});

test('[ac-scope] repo 外の目印と repo 内の目印が 1 つの AC にあれば mixed、repo 外だけなら external、どちらも無ければ repo', () => {
  assert.deepEqual(AC_SCOPES, ['repo', 'external', 'mixed']);
  assert.equal(classifyAcScope(MIXED_AC), 'mixed');
  assert.equal(classifyAcScope(EXTERNAL_AC), 'external');
  assert.equal(classifyAcScope('worker 数の上限を設定で変えられる'), 'repo');
  for (const ac of [
    'plugins/dev-flow/_lib/a.mjs を直し、~/.claude/settings.json の allow にも足す',
    'vitest を green にし、別 repo の CI 設定も更新する',
    'README に手順を書き、settings.local.json の deny を外す',
  ]) assert.equal(classifyAcScope(ac), 'mixed', ac);
  for (const ac of [
    '`~/.claude/settings.json` の allow に bin を足す',
    '他のリポジトリの workflow を更新する',
    'dotfiles に worktree を作って excludedCommands を直す',
  ]) assert.equal(classifyAcScope(ac), 'external', ac);
});

test('[ac-scope] 他 repo の参照は対象 repo と違うときだけ repo 外（repo 省略時は判定しない）', () => {
  const repo = 'it-all-playpark/skills';
  assert.equal(classifyAcScope('acme/infra#206 の設定を入れる', { repo }), 'external');
  assert.equal(classifyAcScope('https://github.com/acme/infra の設定を入れ、テストを足す', { repo }), 'mixed');
  assert.equal(classifyAcScope('It-All-Playpark/Skills#786 の再発をテストで防ぐ', { repo }), 'repo');
  assert.equal(classifyAcScope('acme/infra#206 の設定を入れる'), 'repo');
});

// 過去 issue の repo 内 AC（本文そのまま）。repo 外の語は否定・件数 0・不要・条件・理由の言及・grep 対象として
// 出てくるだけで、作業は repo 内で完結する。skills 絶対パスは bin-bare-name-routing.test.mjs の禁止パターンに
// かからないよう組み立てる。
const SKILLS_ABS = ['~/.claude', 'skills/'].join('/');
const PAST_REPO_ACS = {
  493: 'probe prompt / throw メッセージいずれにも sandbox・permission・excludedCommands・guard 名を理由として述べる記述が無いことを静的テストで pin する（`_lib/` の canonical と `.claude/workflows/*.js` の inline 双方を対象）',
  569: 'dev-flow の実行経路（`.claude/workflows/*.js`、`_lib/*.mjs`）に `' + SKILLS_ABS + '` 絶対パスが 0 箇所',
  606: '契約文の理由が「verbatim 転写の破壊」として書かれており、sandbox / excludedCommands を理由にしていない（`_lib/isolation-control-reason.test.mjs` が green）',
  637: 'wrapper script は `plugins/dev-flow/bin/` の bare 名で公開し、既存 exec-proxy と同じ起動形（先頭トークン = bare 名。cd / bash / node 前置なし）で呼ぶ。dotfiles 側 `sandbox.excludedCommands` への登録が必要なら PR 本文にその bare 名を明記する',
  640: '`tests/run-node-tests.sh` green、`bash tests/run-all-bats.sh` green。telemetry キー追加は受け側（skills）で完結する passthrough 経路のため dotfiles 側の変更は不要 — 変更が必要になった場合は PR 本文にその理由を書く',
  16: "`grep -r '~/.claude/skills' --include='*.md' --include='*.sh' --include='*.ts' --include='*.py'` がヒット 0件",
  570: '非 dev-flow skill の `.md` から `' + SKILLS_ABS + '` 絶対パス記述が 0 箇所',
  576: '`bug-hunt` / `code-audit-team` / `incident-response` の `allowed-tools` に `' + SKILLS_ABS + '` を含む行が 0 件で、`${CLAUDE_PLUGIN_ROOT}` 版のみが残っている',
};

test('[ac-scope] 過去 issue の repo 内 AC（否定・件数 0・不要・条件・理由の言及・grep 対象）は repo で、actor は agent', () => {
  const repo = 'it-all-playpark/skills';
  for (const [n, ac] of Object.entries(PAST_REPO_ACS)) {
    assert.equal(classifyAcScope(ac, { repo }), 'repo', `#${n}: ${ac}`);
    assert.equal(classifyAcActor(ac, { repo }), 'agent', `#${n}: ${ac}`);
  }
  assert.deepEqual(mixedScopeAcReasons(Object.values(PAST_REPO_ACS), { repo }), []);
});

test('[ac-scope] 否定の節にある目印だけを除き、同じ AC の別の節で repo 外を作業対象にしていれば数える', () => {
  assert.equal(classifyAcScope('dotfiles の settings.json は変更しない'), 'repo');
  assert.equal(classifyAcScope('テストを足し、dotfiles の excludedCommands は変更しない'), 'repo');
  assert.equal(classifyAcScope('README の `' + SKILLS_ABS + '` 記述を 0 箇所にし、dotfiles の excludedCommands に bare 名を足す'), 'mixed');
});

test('[ac-scope] 対象 repo が dotfiles のときは dotfiles / excludedCommands / settings.json を repo 内として扱う', () => {
  const repo = 'it-all-playpark/dotfiles';
  assert.equal(classifyAcScope('claude-code/settings.json の excludedCommands に bare 名を足し、bats テストを足す', { repo }), 'repo');
  assert.equal(classifyAcScope('dotfiles の README を更新する', { repo }), 'repo');
  assert.equal(classifyAcScope('claude-code/settings.json の excludedCommands に bare 名を足し、bats テストを足す', { repo: 'it-all-playpark/skills' }), 'mixed');
  assert.equal(classifyAcScope('~/.claude/settings.json の allow に bin を足す', { repo }), 'external', '~/.claude はどの repo の worktree でもない');
});

test('[ac-scope] （人手）と明記した AC は repo 内外が混ざっていても mixed にせず external（human）', () => {
  const ac = 'vitest を green にし、dotfiles の excludedCommands に bare 名を足す（人手）';
  assert.equal(classifyAcScope(ac), 'external');
  assert.equal(classifyAcActor(ac), 'human');
  assert.deepEqual(mixedScopeAcReasons([ac]), []);
  assert.equal(classifyAcScope('vitest を green にし、dotfiles の excludedCommands に `（人手）` を足す'), 'mixed', 'inline code の（人手）は明記に数えない');
});

test('[ac-actor] repo 外の作業だけを書いた AC は human（エージェント AC 未達に数えない）', () => {
  assert.equal(classifyAcActor(EXTERNAL_AC), 'human');
  assert.equal(classifyAcActor(MIXED_AC), 'agent', 'mixed は analyze ゲートで止めるので actor は agent のまま');
  const actors = acActorsOf(['worker 数の上限を設定で変えられる', EXTERNAL_AC]);
  assert.deepEqual(actors, ['agent', 'human']);
  assert.deepEqual(unsatisfiedAcByActor([{ ac_index: 1, satisfied: false }], actors), { agent: [], human: [1], ci: [] });
  assert.deepEqual(acActorsOf(['acme/infra#206 の設定を入れる'], { repo: 'it-all-playpark/skills' }), ['human']);
});

test('[ac-scope] mixedScopeAcReasons: 混ざった AC だけを AC 番号・本文・repo 外の目印つきで 1 行ずつ返し、repo 外の作業を human-task issue に切り出させる', () => {
  const reasons = mixedScopeAcReasons(['worker 数の上限を設定で変えられる', MIXED_AC, EXTERNAL_AC]);
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /^AC-2「/);
  assert.ok(reasons[0].includes(MIXED_AC));
  assert.match(reasons[0], /dotfiles \/ excludedCommands/);
  assert.match(reasons[0], /repo 外の作業は `human-task` ラベルの別 issue に切り出し/);
  assert.match(reasons[0], /この issue の AC は repo 内で検証できるものだけにして/);
  assert.match(reasons[0], /merge 前に人がやる作業ならこの issue に `Blocked by #<human issue>`/);
  assert.match(reasons[0], /merge 後に確認する作業なら human issue に `Blocked by #<実装 issue>`/);
  // （人手）と明記して同じ issue に残すと actor human の AC になり、Final reconcile で必ず HOLD になる
  assert.doesNotMatch(reasons[0], /人手/);
  assert.deepEqual(mixedScopeAcReasons(['worker 数の上限を設定で変えられる', EXTERNAL_AC]), []);
  assert.deepEqual(mixedScopeAcReasons(undefined), []);
});

// 観測型 AC の絞り込み規則 v2（issue #844）。positive / negative control（過去 issue の AC 本文）が prerun の
// 絞り込み + Jev で観測型になる / ならないことは prerun-analyze.bats が Jev スタブで確かめる（issue #859）。

test('[ac-observational] 強い語は否定・言及の節でも発火し、OBS_STRONG_NEG（実測しない・計測不要）だけ外す', () => {
  assert.equal(isObservationalAc('変更前後で計測し、差分が記述されている'), true, '強い語は言及の節でも発火');
  assert.equal(isObservationalAc('計測を行い PR 本文に書く'), true);
  assert.equal(isObservationalAc('この変更は実測しない'), false);
  assert.equal(isObservationalAc('A/B は不要'), false);
  assert.equal(isObservationalAc('計測値を定数に持つ'), false, '「計測」が名詞（計測値）なら強い語にしない');
});

test('[ac-observational] 弱い語は否定・言及の節では発火せず、inline code と鉤括弧の引用の中は見ない', () => {
  assert.equal(isObservationalAc('run ごとに duration が journal に記録される'), true);
  assert.equal(isObservationalAc('journal に記録されないことを確かめる'), false, '否定の節');
  assert.equal(isObservationalAc('telemetry のキー名を変える'), false, '言及の節（キー名）');
  assert.equal(isObservationalAc('`journal` を引数に取る'), false, 'inline code の中');
  assert.equal(isObservationalAc('見出しを「計測する」から「確認」に変える'), false, '鉤括弧の引用の中');
  assert.equal(isObservationalAc(''), false);
  assert.equal(isObservationalAc(null), false);
  assert.deepEqual(acObservationalOf(['worker 数の上限を設定で変えられる', KNOWN_OBSERVATIONAL_ACS['526-3']]), [false, true]);
  assert.deepEqual(acObservationalOf(undefined), []);
});

test('[ac-observational] classifyAcActor: 観測型の human 判定は確定した観測型判定（opts.observational）だけを使い、正規表現では決めない', () => {
  const OBS = '修正後の実 run で receipt が生成される';
  assert.equal(classifyAcActor(OBS, { observational: true }), 'human');
  assert.equal(classifyAcActor(OBS, { observational: false }), 'agent', '正規表現の絞り込みに当たっても、確定判定が false なら agent');
  assert.equal(classifyAcActor(OBS), 'agent');
  assert.equal(classifyAcActor('staging で計測する（人手）', { observational: false }), 'human', '既存の human 判定（（人手）・staging）は観測型判定に依らない');
  assert.equal(classifyAcActor('worker 数の上限を設定で変えられる', { observational: true }), 'human', '絞り込みに当たらない AC でも確定判定が true なら human');
  // repo 内外が混ざった AC は観測型でなければ analyze ゲートに任せて agent のまま
  assert.equal(classifyAcActor(MIXED_AC, { observational: false }), 'agent');
  assert.deepEqual(acActorsOf([OBS, OBS, EXTERNAL_AC], { repo: 'it-all-playpark/skills', observational: [true, false, false] }), ['human', 'agent', 'human']);
  assert.deepEqual(acActorsOf([OBS], { observational: 'x' }), ['agent']);
});

test('[ac-observational] pendingAcObservationalIndexes / resolveAcObservational: null の AC だけを agent に回し、agent が判定できない AC は true', () => {
  assert.deepEqual(pendingAcObservationalIndexes([false, null, true, null]), [1, 3]);
  assert.deepEqual(pendingAcObservationalIndexes([false, true]), []);
  assert.deepEqual(pendingAcObservationalIndexes(undefined), []);
  const prerun = [false, null, true, null, null];
  const agentResult = { results: [{ ac_index: 1, observational: false }, { ac_index: 3, observational: null }, { ac_index: 0, observational: true }] };
  assert.deepEqual(resolveAcObservational(prerun, agentResult), [false, false, true, true, true],
    'prerun の確定値は agent の応答で上書きしない / agent の null・応答欠落は true');
  assert.deepEqual(resolveAcObservational(prerun, null), [false, true, true, true, true], 'agent が null（失敗）なら未確定は全て true');
  assert.deepEqual(resolveAcObservational(prerun, { results: 'x' }), [false, true, true, true, true]);
  assert.deepEqual(resolveAcObservational([false, true], null), [false, true]);
});

test('[ac-observational] acObservationalPrompt: issue のタイトルと未確定 AC の文面だけを渡し、判定できない AC は null で返させる', () => {
  const acs = ['ログの件数表示を修正する', 'エラー件数を返す関数にテストを足す', '実行ログに 1 件以上記録される'];
  const prompt = acObservationalPrompt('fix: ログの件数', acs, [1]);
  assert.ok(prompt.includes('"fix: ログの件数"'), prompt);
  assert.ok(prompt.includes('{"ac_index":1,"ac":"エラー件数を返す関数にテストを足す"}'), prompt);
  assert.ok(!prompt.includes(acs[0]) && !prompt.includes(acs[2]), `確定済みの AC を渡している: ${prompt}`);
  assert.match(prompt, /コードとテストを読むだけでは確かめられず、実行した結果・ログ・計測を観測しないと確かめられない/);
  assert.match(prompt, /テストコードやソースコード自体の書き方・構成について述べているなら false/);
  assert.match(prompt, /observational:null/);
  assert.match(prompt, /ツールは使わず/);
  assert.equal(acObservationalPrompt.length, 3, '入力は title / AC / index だけ（diff・evaluator の結果を受け取る引数を持たない）');
});

test('[ac-observational] deterministicAcIndexes: red→green 実証で deterministic 昇格して checked の AC-<n> だけを 0 始まりで返す', () => {
  assert.deepEqual(deterministicAcIndexes([
    { id: 'AC-1', checked: true, check: { kind: 'deterministic' } },
    { id: 'AC-2', checked: true, check: { kind: 'inspection' } },
    { id: 'AC-3', checked: false, check: { kind: 'deterministic' } },
    { id: 'AC-FINAL-4', checked: true, check: { kind: 'deterministic' } },
    { id: 'SEC-X', checked: true, check: { kind: 'deterministic' } },
    null,
  ]), [0]);
  assert.deepEqual(deterministicAcIndexes(undefined), []);
});

test('[ac-observational] demoteUnprovenObservationalAc: 実証の無い観測型 AC の satisfied:true を未達に倒し、実証済み・非観測型は変えない', () => {
  const results = [
    { ac_index: 0, satisfied: true, verified_by: 'inspection', evidence: 'コードを読んだ' },
    { ac_index: 1, satisfied: true, verified_by: 'test', evidence: 'test green' },
    { ac_index: 2, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
    { ac_index: 3, satisfied: false, verified_by: 'inspection', evidence: 'ng' },
  ];
  const out = demoteUnprovenObservationalAc(results, [true, true, false, true], [1]);
  assert.equal(out[0].satisfied, false);
  assert.equal(out[0].observational, true);
  assert.match(out[0].evidence, /観測型 AC/);
  assert.match(out[0].evidence, /コードを読んだ/);
  assert.equal(out[1], results[1], 'red→green 実証済みは変えない');
  assert.equal(out[2], results[2], '非観測型は変えない');
  assert.deepEqual(out[3], { ...results[3], observational: true });
  assert.equal(results[0].satisfied, true, '入力は書き換えない');
  assert.equal(demoteUnprovenObservationalAc(null, [true], []), null);
  // 倒した AC は actor human なので人手 AC 待ちに数え、差し戻し（agent）には数えない
  const actors = ['human', 'human', 'agent', 'human'];
  assert.deepEqual(unsatisfiedAcByActor(out, actors), { agent: [], human: [0, 3], ci: [] });
});
