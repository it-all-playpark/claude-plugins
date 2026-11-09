// _lib/ac-actor.test.mjs
// AC の actor 分類（agent / human / ci）と、ac_results の actor 別集計・差し戻し用 fix_feedback の pin（issue #747 / #861）。
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AC_ACTORS, AC_SCOPES, AGENT_AC_REIMPL_MAX, classifyAcActor, acActorsOf, unsatisfiedAcByActor, agentAcFeedback, matchesCiVerify, ciAcIndexes, applyCiAcResults, unsatisfiedCiAcIndexes, dropCiAcFeedback, classifyAcScope, mixedScopeAcReasons, deterministicAcIndexes, demoteUnprovenObservationalAc, isReimplUnfixableGap, proofMissingAgentAcIndexes, resolveAcObservational, acObservationalPrompt, hasJudgedHumanAcGap, freezeAcVerify, acVerifyCandidateIndexes, testRunAcDisclosures } from './ac-actor.mjs';
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

test('[ac-actor] unsatisfiedAcByActor: 作り直しで埋まらない gap（unreachable_env:true・proof_missing:true）の agent AC は human（人手 AC 待ち）に数え、それ以外の未達は agent のまま', () => {
  assert.equal(isReimplUnfixableGap({ satisfied: false, unreachable_env: true }), true);
  assert.equal(isReimplUnfixableGap({ satisfied: false, proof_missing: true }), true);
  assert.equal(isReimplUnfixableGap({ satisfied: false }), false);
  assert.equal(isReimplUnfixableGap({ satisfied: false, unreachable_env: false, proof_missing: false }), false);
  assert.equal(isReimplUnfixableGap(null), false);
  const actors = ['agent', 'agent', 'agent', 'human'];
  const results = [
    { ac_index: 0, satisfied: false, unreachable_env: true },
    { ac_index: 1, satisfied: false },
    { ac_index: 2, satisfied: false, observational: true, proof_missing: true },
    { ac_index: 3, satisfied: false, observational: true, proof_missing: true },
  ];
  assert.deepEqual(unsatisfiedAcByActor(results, actors), { agent: [1], human: [0, 2, 3], ci: [] });
  // Evaluate が 1 回だけ差し戻す実証不足の AC は actor agent のものだけ
  assert.deepEqual(proofMissingAgentAcIndexes(results, actors), [2]);
  assert.deepEqual(proofMissingAgentAcIndexes([{ ac_index: 2, satisfied: true, proof_missing: true }], actors), []);
  assert.deepEqual(proofMissingAgentAcIndexes(null, actors), []);
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
  // 実証不足の AC は未達ではなく、red→green になるテストを足すよう伝える
  const proof = agentAcFeedback([1], ['a', '`x.test.mjs` で確かめる'], [{ ac_index: 1, satisfied: false, proof_missing: true, evidence: '観測型 AC — test の red→green 実証が無く' }]);
  assert.equal(proof[0].topic, 'AC-2 実証不足');
  assert.match(proof[0].description, /evaluator が満たしたと判定したが、test の red→green 実証が無い/);
  assert.match(proof[0].suggestion, /red→green/);
  assert.match(proof[0].suggestion, /そのまま返せ/);
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

// 観測型 AC の判定は analyze ゲートの分類 agent に一本化している（issue #1259）。全 AC を渡すことと agent が判定できない
// AC を観測型に倒す経路は observational-ac-routing.test.mjs が VM 実行で確かめる。

test('[ac-observational] classifyAcActor: 観測型の human 判定は確定した観測型判定（opts.observational）だけを使い、正規表現では決めない', () => {
  const OBS = '修正後の実 run で receipt が生成される';
  assert.equal(classifyAcActor(OBS, { observational: true }), 'human');
  assert.equal(classifyAcActor(OBS, { observational: false }), 'agent', '観測の語を含んでも、確定判定が false なら agent');
  assert.equal(classifyAcActor(OBS), 'agent');
  assert.equal(classifyAcActor('staging で計測する（人手）', { observational: false }), 'human', '既存の human 判定（（人手）・staging）は観測型判定に依らない');
  assert.equal(classifyAcActor('worker 数の上限を設定で変えられる', { observational: true }), 'human', '観測の語を含まない AC でも確定判定が true なら human');
  // repo 内外が混ざった AC は観測型でなければ analyze ゲートに任せて agent のまま
  assert.equal(classifyAcActor(MIXED_AC, { observational: false }), 'agent');
  assert.deepEqual(acActorsOf([OBS, OBS, EXTERNAL_AC], { repo: 'it-all-playpark/skills', observational: [true, false, false] }), ['human', 'agent', 'human']);
  assert.deepEqual(acActorsOf([OBS], { observational: 'x' }), ['agent']);
});

test('[ac-observational] resolveAcObservational: 全 AC について agent の boolean を採り、null・応答に無い AC・agent の失敗は true', () => {
  const acs = ['a', 'b', 'c', 'd', 'e'];
  const agentResult = { results: [{ ac_index: 1, observational: false }, { ac_index: 3, observational: null }, { ac_index: 0, observational: true }, { ac_index: 2, observational: false }] };
  assert.deepEqual(resolveAcObservational(acs, agentResult), [true, false, false, true, true], 'agent の null（AC-4）・応答欠落（AC-5）は true');
  assert.deepEqual(resolveAcObservational(acs, null), [true, true, true, true, true], 'agent が null（失敗）なら全 AC を true');
  assert.deepEqual(resolveAcObservational(acs, { results: 'x' }), [true, true, true, true, true]);
  assert.deepEqual(resolveAcObservational(['a'], { results: [{ ac_index: 0, observational: 'false' }] }), [true], 'boolean でない応答は true');
  assert.deepEqual(resolveAcObservational(undefined, agentResult), []);
});

test('[ac-observational] acObservationalPrompt: issue のタイトルと渡す AC の文面だけを渡し、判定できない AC は null で返させる', () => {
  const acs = ['ログの件数表示を修正する', 'エラー件数を返す関数にテストを足す', '実行ログに 1 件以上記録される'];
  const prompt = acObservationalPrompt('fix: ログの件数', acs, [1]);
  assert.ok(prompt.includes('"fix: ログの件数"'), prompt);
  assert.ok(prompt.includes('{"ac_index":1,"ac":"エラー件数を返す関数にテストを足す","inline_codes":[]}'), prompt);
  assert.ok(!prompt.includes(acs[0]) && !prompt.includes(acs[2]), `渡していない AC を含めている: ${prompt}`);
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
  assert.equal(out[0].proof_missing, true, 'satisfied:true を倒した AC は実証不足');
  assert.match(out[0].evidence, /観測型 AC/);
  assert.match(out[0].evidence, /コードを読んだ/);
  assert.equal(out[1], results[1], 'red→green 実証済みは変えない');
  assert.equal(out[2], results[2], '非観測型は変えない');
  assert.deepEqual(out[3], { ...results[3], observational: true });
  assert.ok(!('proof_missing' in out[3]), 'もともと satisfied:false の AC（未達）は実証不足にしない');
  assert.equal(results[0].satisfied, true, '入力は書き換えない');
  assert.equal(demoteUnprovenObservationalAc(null, [true], []), null);
  // 倒した AC は actor human なので人手 AC 待ちに数え、差し戻し（agent）には数えない
  const actors = ['human', 'human', 'agent', 'human'];
  assert.deepEqual(unsatisfiedAcByActor(out, actors), { agent: [], human: [0, 3], ci: [] });
});

// issue #1147: テストファイルを inline code で名指しした観測型 AC（#1142 の AC-2）。観測型の判定は true のまま actor だけ agent。
const AC_1142_2 = 'AC-2 `journal.sh hook-capture` は、64KB を超える error（一致行を多数含むもの・一致行を含まないものの両方）でも exit 0 で終わり、journal に 1 件記録する。記録の `error.message` は現行と同じ規則（一致行の先頭 3 行、一致が無ければ先頭 3 行、各 300 文字まで）で作られる。`journal.bats` に両ケースを足し、そのテストは現行の hook-capture では落ちる';
// 分類 agent が観測型の AC に null（判定できない）、それ以外に false を返した経路を通す（obsIndexes は観測型の AC の index）
const resolveActorsViaAnalyze = (acs, obsIndexes = acs.map((_, i) => i)) => {
  const observational = resolveAcObservational(acs, { results: acs.map((_, i) => ({ ac_index: i, observational: obsIndexes.includes(i) ? null : false })) });
  return { observational, actors: acActorsOf(acs, { repo: 'it-all-playpark/claude-plugins', observational }) };
};

test('[ac-observational] テストファイルを inline code で名指しした観測型 AC（#1142 AC-2）は ac_observational:true のまま actor agent', () => {
  const { observational, actors } = resolveActorsViaAnalyze([AC_1142_2]);
  assert.deepEqual(observational, [true], '分類 agent が null なら観測型');
  assert.deepEqual(actors, ['agent']);
  for (const ac of [
    '`plugins/dev-flow/_lib/ac-actor.test.mjs` に足すテストで、実 run の journal に記録されることを確かめる',
    '`src/__tests__/journal.ts` と `pkg/journal_test.go` で run ごとに journal に記録される',
    'run ごとに journal に記録される（`bats tests/journal.bats` で確認）',
  ]) assert.deepEqual(resolveActorsViaAnalyze([ac]).actors, ['agent'], ac);
});

test('[ac-observational] テストファイルを名指しした観測型 AC: red→green の昇格が無い inspection の satisfied:true は実証不足に倒れ人手 AC 待ち（judged human gap）に数え、昇格済みなら達成のまま', () => {
  const CODE = 'worker 数の上限を設定で変えられる';
  const { observational, actors } = resolveActorsViaAnalyze([AC_1142_2, CODE], [0]);
  assert.deepEqual(observational, [true, false]);
  const results = [
    { ac_index: 0, satisfied: true, verified_by: 'inspection', evidence: '追加テストを読んだ' },
    { ac_index: 1, satisfied: true, verified_by: 'inspection', evidence: 'ok' },
  ];
  const unproven = demoteUnprovenObservationalAc(results, observational, deterministicAcIndexes([]));
  assert.equal(unproven[0].satisfied, false);
  assert.equal(unproven[0].observational, true);
  assert.equal(unproven[0].proof_missing, true);
  const gaps = unsatisfiedAcByActor(unproven, actors);
  assert.deepEqual(gaps, { agent: [], human: [0], ci: [] });
  // 文面は人手でも repo 外でもないので、Merge tier の hold_ac_human_judged に数える
  assert.equal(hasJudgedHumanAcGap(gaps.human, [AC_1142_2, CODE], { repo: 'it-all-playpark/claude-plugins' }), true);
  // もともと satisfied:false（未達）なら実証不足にせず、従来どおり agent（上限まで差し戻し）
  const unmet = demoteUnprovenObservationalAc([{ ...results[0], satisfied: false }, results[1]], observational, deterministicAcIndexes([]));
  assert.deepEqual(unsatisfiedAcByActor(unmet, actors), { agent: [0], human: [], ci: [] });
  const proven = demoteUnprovenObservationalAc(results, observational, deterministicAcIndexes([{ id: 'AC-1', checked: true, check: { kind: 'deterministic' } }]));
  assert.equal(proven[0].satisfied, true);
  assert.deepEqual(unsatisfiedAcByActor(proven, actors), { agent: [], human: [], ci: [] });
});

test('[ac-observational] テストファイルを inline code で名指ししていない観測型 AC は actor human のまま', () => {
  for (const ac of [
    '修正後の dev-flow run で journal に 1 件以上記録される',
    'A/B 比較表を issue コメントに載せる',
    'journal.bats で run ごとに journal に記録される',
    '`journal.sh` の実 run で journal に記録される',
    '`*.test.mjs` で run ごとに journal に記録される',
    ...Object.values(KNOWN_OBSERVATIONAL_ACS),
  ]) {
    const { observational, actors } = resolveActorsViaAnalyze([ac]);
    assert.deepEqual(observational, [true], ac);
    assert.deepEqual(actors, ['human'], ac);
  }
});

// ---- issue #1208: AC 自体が inline code で指定した検証コマンド（verify_command / expect_paths） ----

// private repo の PR の AC-2（build の完走と生成物を AC が指定した観測型 AC）。workspace の scope 名だけ placeholder に置き換えた
const BUILD_CMD = 'timeout 300 pnpm --filter @acme/landing build';
const BUILD_PATHS = ['packages/landing/out/index.html', 'packages/landing/out/404.html'];
const BUILD_AC = `sandbox 内で \`${BUILD_CMD}\` が exit 0 で終わり、\`${BUILD_PATHS[0]}\` と \`${BUILD_PATHS[1]}\` が生成される`;

// BUILD_AC の inline code の候補は [BUILD_CMD, BUILD_PATHS[0], BUILD_PATHS[1]]（index 0 / 1 / 2）
test('[ac-verify] freezeAcVerify: verify_command_index / expect_path_indexes が指す AC の inline code（build の完走を指定した AC）を凍結する', () => {
  const frozen = freezeAcVerify(['worker 数の上限を設定で変えられる', BUILD_AC], {
    results: [{ ac_index: 1, observational: true, verify_command_index: 0, expect_path_indexes: [1, 2] }],
  });
  assert.deepEqual(frozen, [
    { verify_command: null, expect_paths: [] },
    { verify_command: BUILD_CMD, expect_paths: BUILD_PATHS },
  ]);
});

test('[ac-verify] freezeAcVerify: verify_command_index が範囲内の非負整数でない応答・旧形式（文字列の verify_command）の応答は凍結しない', () => {
  const NONE = { verify_command: null, expect_paths: [] };
  const freeze = (r) => freezeAcVerify([BUILD_AC], { results: [{ ac_index: 0, observational: true, ...r }] })[0];
  for (const [name, r] of [
    ['範囲外', { verify_command_index: 3, expect_path_indexes: [1, 2] }],
    ['負数', { verify_command_index: -1, expect_path_indexes: [1, 2] }],
    ['非整数', { verify_command_index: 0.5, expect_path_indexes: [1, 2] }],
    ['文字列', { verify_command_index: '0', expect_path_indexes: [1, 2] }],
    ['null', { verify_command_index: null, expect_path_indexes: [1, 2] }],
    ['欠落', { expect_path_indexes: [1, 2] }],
    ['旧形式（文字列の verify_command / expect_paths）', { verify_command: BUILD_CMD, expect_paths: [...BUILD_PATHS] }],
    ['旧形式と index の混在（旧形式の文字列は使わない）', { verify_command: BUILD_CMD, verify_command_index: 9, expect_path_indexes: [1, 2] }],
  ]) assert.deepEqual(freeze(r), NONE, name);
  // 空白だけの inline code は verify_command に採らない
  assert.deepEqual(freezeAcVerify(['`  ` が exit 0 で終わる'], { results: [{ ac_index: 0, observational: true, verify_command_index: 0, expect_path_indexes: [] }] }), [NONE]);
  // 応答なし・形が違う・ac_index 違いは null
  assert.deepEqual(freezeAcVerify([BUILD_AC], null), [NONE]);
  assert.deepEqual(freezeAcVerify([BUILD_AC], { results: [{ ac_index: 1, verify_command_index: 0, expect_path_indexes: [1, 2] }] }), [NONE]);
  assert.deepEqual(freezeAcVerify(undefined, { results: [] }), []);
});

test('[ac-verify] freezeAcVerify: expect_path_indexes は範囲内の非負整数が指す worktree 相対のパスだけを、値で重複を除いて採る', () => {
  const freeze = (r) => freezeAcVerify([BUILD_AC], { results: [{ ac_index: 0, observational: true, verify_command_index: 0, ...r }] })[0];
  // 範囲外・負数・非整数・文字列の index は捨て、残りは採る
  assert.deepEqual(freeze({ expect_path_indexes: [1, 7, -1, 1.5, '2', 2] }), { verify_command: BUILD_CMD, expect_paths: BUILD_PATHS });
  // 同じパスを 2 つの index で選んだ（同じ値の inline code が 2 回現れる AC）場合は 1 つにまとめる
  const twice = '`make site` が exit 0 で、`site/index.html` が生成される（`site/index.html` は空でない）';
  assert.deepEqual(freezeAcVerify([twice], { results: [{ ac_index: 0, observational: true, verify_command_index: 0, expect_path_indexes: [1, 2] }] })[0], { verify_command: 'make site', expect_paths: ['site/index.html'] });
  const site = (ac, expectPathIndexes) => freezeAcVerify([ac], { results: [{ ac_index: 0, observational: true, verify_command_index: 0, expect_path_indexes: expectPathIndexes }] })[0];
  assert.deepEqual(site('`make site` が exit 0 で、`site/./index.html` が生成される', [1]), { verify_command: 'make site', expect_paths: ['site/./index.html'] });
  // .. を含む・/ 始まりのパスは index で選んでも採らない（採らなかった inline code が残るので AC ごと凍結しない）
  assert.deepEqual(site('`make site` が exit 0 で、`../site/index.html` が生成される', [1]), { verify_command: null, expect_paths: [] });
  assert.deepEqual(site('`make site` が exit 0 で、`/tmp/site/index.html` が生成される', [1]), { verify_command: null, expect_paths: [] });
  // verify_command が採れなければ expect_paths も採らない
  assert.deepEqual(freeze({ verify_command_index: null, expect_path_indexes: [1, 2] }), { verify_command: null, expect_paths: [] });
});

test('[ac-verify] freezeAcVerify: verify_command と採った expect_paths 以外の inline code が残る AC（複数コマンドの複合 AC 等）は凍結しない', () => {
  const multi = '`node --test plugins/dev-flow/_lib/` と `bash tests/run-all-bats.sh` が通り、`tools/sync-inlines.mjs --write` を実行した後の inline 区間が一致する';
  for (const k of [0, 1, 2]) {
    assert.deepEqual(freezeAcVerify([multi], { results: [{ ac_index: 0, observational: true, verify_command_index: k, expect_path_indexes: [] }] }), [{ verify_command: null, expect_paths: [] }], String(k));
  }
  // 生成物のパスを expect_paths に採らなかった AC も、残った inline code を確かめていないので凍結しない
  assert.deepEqual(freezeAcVerify([BUILD_AC], { results: [{ ac_index: 0, observational: true, verify_command_index: 0, expect_path_indexes: [1] }] }), [{ verify_command: null, expect_paths: [] }]);
  // 残りは値で数える: 同じコマンドが 2 回現れる AC は、どちらの index を選んでも凍結する
  const repeated = '`pnpm build` が exit 0 で終わる（`pnpm build` を 2 回続けて実行しても壊れない）';
  for (const k of [0, 1]) {
    assert.deepEqual(freezeAcVerify([repeated], { results: [{ ac_index: 0, observational: true, verify_command_index: k, expect_path_indexes: [] }] }), [{ verify_command: 'pnpm build', expect_paths: [] }], String(k));
  }
  // 選ばれなかった別の値が 1 つでも残れば凍結しない
  const repeatedPlus = '`pnpm build` が exit 0 で終わり、`pnpm build` の後に `pnpm lint` も通る';
  assert.deepEqual(freezeAcVerify([repeatedPlus], { results: [{ ac_index: 0, observational: true, verify_command_index: 0, expect_path_indexes: [] }] }), [{ verify_command: null, expect_paths: [] }]);
});

test('[ac-verify] classifyAcActor: verify_command が凍結された観測型 AC も、テストファイルの名指しが無ければ human のまま（verify_command の有無で actor を変えない）', () => {
  const acVerify = freezeAcVerify([BUILD_AC], { results: [{ ac_index: 0, observational: true, verify_command_index: 0, expect_path_indexes: [1, 2] }] });
  assert.equal(acVerify[0].verify_command, BUILD_CMD, '前提: verify_command が凍結されている');
  assert.equal(classifyAcActor(BUILD_AC, { observational: true, verifyCommand: acVerify[0].verify_command }), 'human');
  assert.equal(classifyAcActor(BUILD_AC, { observational: true }), 'human');
  assert.deepEqual(acActorsOf([BUILD_AC], { observational: [true], acVerify }), ['human']);
  // テストファイルを名指しした観測型 AC は従来どおり agent（verify_command で変わるのではない）
  assert.equal(classifyAcActor('`node --test plugins/dev-flow/_lib/foo.test.mjs` が exit 0 で終わる', { observational: true, verifyCommand: 'node --test plugins/dev-flow/_lib/foo.test.mjs' }), 'agent');
  // HUMAN_AC_PATTERNS・ci_verify・external の優先順は変えない
  assert.equal(classifyAcActor('staging で `pnpm build` が exit 0 で終わる', { observational: true, verifyCommand: 'pnpm build' }), 'human');
  assert.equal(classifyAcActor('`pnpm test:e2e:local` が exit 0 で終わる', { observational: true, verifyCommand: 'pnpm test:e2e:local', ciVerify: { label: 'full-ci', commands: ['pnpm test:e2e:local'] } }), 'ci');
  assert.equal(classifyAcActor('dotfiles で `make apply` が exit 0 で終わる', { observational: true, verifyCommand: 'make apply' }), 'human');
});

test('[ac-verify] acVerifyCandidateIndexes: 観測型が true で文面上の actor が human / ci でない AC だけを分類 agent に聞く候補にする', () => {
  const acs = [BUILD_AC, 'staging で `pnpm build` が exit 0 で終わる', '`pnpm test:e2e:local` が通る', 'worker 数の上限を設定で変えられる', '実行ログに 1 件以上記録される'];
  const ciVerify = { label: 'full-ci', commands: ['pnpm test:e2e:local'] };
  assert.deepEqual(acVerifyCandidateIndexes(acs, [true, true, true, false, null], { ciVerify }), [0]);
  assert.deepEqual(acVerifyCandidateIndexes(acs, [true, true, true, true, true], { ciVerify }), [0, 3, 4]);
  assert.deepEqual(acVerifyCandidateIndexes(acs, [false, false, false, false, null], { ciVerify }), [], '観測型 true が無ければ候補なし');
  assert.deepEqual(acVerifyCandidateIndexes(undefined, undefined), []);
});

test('[ac-verify] acObservationalPrompt: AC ごとに inline code の候補配列（0 始まりの番号付き・出てくる順・重複そのまま）を載せ、verify_command_index / expect_path_indexes を返させる', () => {
  const repeated = '`pnpm build` が exit 0 で終わり、`out/a.html` が生成される（`pnpm build` を 2 回続けても壊れない）';
  const acs = ['worker 数の上限を設定で変えられる', BUILD_AC, repeated];
  const prompt = acObservationalPrompt('fix(landing): build を直す', acs, [1, 2]);
  assert.ok(prompt.includes('"fix(landing): build を直す"'), prompt);
  assert.ok(prompt.includes(JSON.stringify({ ac_index: 1, ac: BUILD_AC, inline_codes: [{ index: 0, code: BUILD_CMD }, { index: 1, code: BUILD_PATHS[0] }, { index: 2, code: BUILD_PATHS[1] }] })), prompt);
  assert.ok(prompt.includes(JSON.stringify({ ac_index: 2, ac: repeated, inline_codes: [{ index: 0, code: 'pnpm build' }, { index: 1, code: 'out/a.html' }, { index: 2, code: 'pnpm build' }] })), prompt);
  assert.ok(!prompt.includes(acs[0]), `渡していない AC を含めている: ${prompt}`);
  assert.match(prompt, /verify_command_index: その AC の結果を exit code だけで決められる、worktree を cwd に実行するコマンド/);
  assert.match(prompt, /inline_codes のうちそのコマンドの index/);
  assert.match(prompt, /決まらなければ null/);
  assert.match(prompt, /expect_path_indexes: /);
  assert.ok(prompt.includes('"verify_command_index":<inline_codes の index>|null,"expect_path_indexes":[<inline_codes の index>]'), prompt);
  // 転写の指示は無い（agent に文字列を作らせない）
  for (const s of ['1 文字も変えずに写せ', '中身をそのまま写す', '"<inline code の中身>"', '"verify_command":', '"expect_paths":']) assert.ok(!prompt.includes(s), `${s}: ${prompt}`);
});

test('[ac-verify] dev-flow.js の AC_OBSERVATIONAL schema は results の項目に verify_command_index / expect_path_indexes を求め、文字列の verify_command / expect_paths を持たない', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '.claude/workflows/dev-flow.js'), 'utf8');
  const start = src.indexOf('const AC_OBSERVATIONAL = {');
  assert.ok(start >= 0, 'AC_OBSERVATIONAL の定義が見つからない');
  const block = src.slice(start, src.indexOf('\n}\n', start) + 2);
  assert.ok(block.includes("required: ['ac_index', 'observational', 'verify_command_index', 'expect_path_indexes']"), block);
  assert.ok(block.includes("verify_command_index: { type: ['integer', 'null'] }"), block);
  assert.ok(block.includes("expect_path_indexes: { type: 'array', items: { type: 'integer' } }"), block);
  assert.ok(!/\bverify_command:/.test(block) && !/\bexpect_paths:/.test(block), block);
});

// ---- issue #1297: pipeline が実行したテストの入口だけを inline code に書いた AC の開示 ----

const TR_WT = '/tmp/wt';
// run-tests の結果（scripts[].path は worktree 配下の絶対パス）
const trResult = (o = {}) => ({
  tests: 'passed', green: true, summary: '',
  scripts: [
    { path: `${TR_WT}/tests/run-a.sh`, exit: 0, launch_failed: false, log: '/tmp/run-tests-x/0.log' },
    { path: `${TR_WT}/tests/run-b.sh`, exit: 0, launch_failed: false, log: '/tmp/run-tests-x/1.log' },
  ],
  ...o,
});
const trDisclose = (acs, o = {}) => testRunAcDisclosures({ acceptanceCriteria: acs, result: trResult(), run: 'validate', changedFiles: ['src/x.ts'], worktree: TR_WT, ...o });

test('[test-run-ac] testRunAcDisclosures: 入口を tests/x・./tests/x・bash tests/x の形で書いた AC は、全部が実行済みの入口なら返る（scripts[].path は worktree 相対に直して照合）', () => {
  const acs = ['`tests/run-a.sh` が green', '`./tests/run-a.sh` が green', '`bash tests/run-a.sh` が green'];
  assert.deepEqual(trDisclose(acs), [0, 1, 2].map((i) => ({ ac_index: i, run: 'validate', entries: ['tests/run-a.sh'], green: true, entry_changed: false })));
  // worktree の末尾の / は区切りとして扱う
  assert.deepEqual(trDisclose([acs[0]], { worktree: `${TR_WT}/` }).map((d) => d.ac_index), [0]);
  // run は渡した種別をそのまま返す
  assert.equal(trDisclose([acs[2]], { run: 'test_final' })[0].run, 'test_final');
});

test('[test-run-ac] testRunAcDisclosures: inline code が 2 つあり両方とも実行済みの入口なら、その 2 つを entries にして返る', () => {
  const ac = '`bash tests/run-a.sh` と `bash tests/run-b.sh` が green';
  assert.deepEqual(trDisclose(['無関係な AC', ac]), [{ ac_index: 1, run: 'validate', entries: ['tests/run-a.sh', 'tests/run-b.sh'], green: true, entry_changed: false }]);
});

test('[test-run-ac] testRunAcDisclosures: 実行していない入口・引数付きの入口・入口以外の inline code が混ざる AC・inline code の無い AC は返らない', () => {
  for (const ac of [
    '`bash tests/run-c.sh` が green',
    '`bash tests/run-a.sh --strict` が green',
    '`bash tests/run-a.sh` と `pnpm build` が green',
    '`bash tests/run-a.sh` と `bash tests/run-c.sh` が green',
    '`sh tests/run-a.sh` が green',
    'テストが全部 green',
  ]) assert.deepEqual(trDisclose([ac]), [], ac);
  // worktree の外のパス・フォールバックのコマンド（run-tests の scripts[].path に入る pnpm test 等）は入口に数えない
  const other = trResult({ scripts: [{ path: '/elsewhere/tests/run-a.sh', exit: 0 }, { path: 'pnpm test', exit: 0 }] });
  assert.deepEqual(trDisclose(['`tests/run-a.sh` が green', '`pnpm test` が green'], { result: other }), []);
});

test('[test-run-ac] testRunAcDisclosures: green は tests:passed かつ green:true のときだけ true。結果が null なら何も返さない', () => {
  const ac = ['`bash tests/run-a.sh` が green'];
  assert.equal(trDisclose(ac)[0].green, true);
  for (const o of [{ tests: 'failed', green: false }, { tests: 'error', green: false }, { tests: 'no_tests', green: false }, { tests: null, green: null }, { tests: 'passed', green: false }]) {
    const d = trDisclose(ac, { result: trResult(o) });
    assert.equal(d.length, 1, JSON.stringify(o));
    assert.equal(d[0].green, false, JSON.stringify(o));
  }
  assert.deepEqual(trDisclose(ac, { result: null }), []);
  assert.throws(() => trDisclose(ac, { run: 'validate-rerun' }), /invalid run/);
});

test('[test-run-ac] testRunAcDisclosures: 入口が変更ファイル一覧にあれば entry_changed:true、無ければ false、一覧が null（取得失敗）なら null', () => {
  const ac = ['`bash tests/run-a.sh` と `bash tests/run-b.sh` が green'];
  assert.equal(trDisclose(ac, { changedFiles: ['src/x.ts', 'tests/run-b.sh'] })[0].entry_changed, true);
  assert.equal(trDisclose(ac, { changedFiles: ['src/x.ts'] })[0].entry_changed, false);
  assert.equal(trDisclose(ac, { changedFiles: [] })[0].entry_changed, false);
  assert.equal(trDisclose(ac, { changedFiles: null })[0].entry_changed, null);
});
