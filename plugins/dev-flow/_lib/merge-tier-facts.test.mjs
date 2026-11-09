import { test, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ciRollupCommand } from './ci-check.mjs';
import { classifyCiChecks } from './merge-tier.mjs';
import { runCheckCiWithRollup } from './test-helpers/check-ci-gh-stub.mjs';
import {
  parseMergeTierFacts, isWellFormedRiskFact, isRiskValueDropped, MERGE_FACTS_RISK_DROPPED_ERROR, mergeTierFactsTopLevelKeys,
  mergeTierFactsPrompt, mergeDiffHashError, closesCheckCommand, parseClosesFact, prClosesStatusOf,
  closesReinjectPrompt, closesReinjectStatus, CLOSES_REINJECT,
} from './merge-tier-facts.mjs';
import { PR_CLOSES_STATUS_VALUES } from './pr-artifacts.mjs';

const SHA = 'a'.repeat(40);
const TREE = 'b'.repeat(40);

function fullFacts() {
  return {
    diffhash: { ok: true, value: { hash: TREE, empty: false, epoch: 1 } },
    risk: { ok: true, value: { ok: true, hits: [{ file: 'a.js', class: 'exec-sink', severity: 'critical' }] } },
    changed: { ok: true, value: { files: ['src/x.ts', 'docs/a.md'] } },
    pr: { ok: true, value: { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', headRefOid: SHA } },
    head_tree: { ok: true, value: { tree: TREE } },
    checks: { ok: true, value: { checks: [{ name: 'build', bucket: 'pass' }] } },
    closes: { ok: true, value: { present: true } },
    epoch: 2,
  };
}

// (1) 全サブ結果正常 → 旧 6 spawn の個別形へそのまま写る
test('全サブ結果正常 → 各フィールドが旧 spawn の形で素通し', () => {
  const r = parseMergeTierFacts(fullFacts());
  assert.equal(r.mergeDiffHash, TREE);
  assert.deepEqual(r.risk, { ok: true, hits: [{ file: 'a.js', class: 'exec-sink', severity: 'critical' }] });
  assert.deepEqual(r.changedFiles, ['src/x.ts', 'docs/a.md']);
  assert.deepEqual(r.prMeta, { ok: true, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', headRefOid: SHA });
  assert.equal(r.headTreeOid, TREE);
  assert.deepEqual(r.checks, { ok: true, checks: [{ name: 'build', bucket: 'pass' }] });
  assert.equal(r.closes, 'present');
});

// (2) null 入力 → risk fail-closed 合成、他は fail-open の既定値
test('null 入力 → risk fail-closed (hits=[])、他フィールドは null / ok:false', () => {
  const r = parseMergeTierFacts(null);
  assert.equal(r.mergeDiffHash, null);
  assert.equal(r.risk.ok, false);
  assert.deepEqual(r.risk.hits, []);
  assert.equal(typeof r.risk.error, 'string');
  assert.equal(r.changedFiles, null);
  assert.equal(r.prMeta.ok, false);
  assert.equal(typeof r.prMeta.error, 'string');
  assert.equal(r.headTreeOid, null);
  assert.equal(r.checks.ok, false);
  assert.equal(r.closes, 'unknown');
  assert.equal(isWellFormedRiskFact(null), false);
  assert.equal(mergeTierFactsTopLevelKeys(null), 'null');
});

// (3) サブ結果独立性: 1 つを壊しても他は無傷（6 通り）
const BREAKERS = {
  diffhash: { ok: false, value: null, error: 'worktree-diff-hash.sh failed' },
  risk: { ok: false, value: null, error: 'no valid JSON' },
  changed: { ok: false, value: null, error: 'git diff failed' },
  pr: { ok: false, value: null, error: 'gh pr view failed' },
  head_tree: { ok: false, value: null, error: 'skipped: pr headRefOid unavailable' },
  checks: { ok: false, value: null, error: 'gh pr checks failed' },
  closes: { ok: false, value: null, error: 'closes data not provided' },
};
const FIELD_OF = { diffhash: 'mergeDiffHash', risk: 'risk', changed: 'changedFiles', pr: 'prMeta', head_tree: 'headTreeOid', checks: 'checks', closes: 'closes' };

for (const [key, broken] of Object.entries(BREAKERS)) {
  test(`${key} だけ ok:false → ${FIELD_OF[key]} だけ既定値に倒れ、他フィールドは正常値のまま`, () => {
    const facts = { ...fullFacts(), [key]: broken };
    const r = parseMergeTierFacts(facts);
    const good = parseMergeTierFacts(fullFacts());
    for (const [k, f] of Object.entries(FIELD_OF)) {
      if (k === key) continue;
      assert.deepEqual(r[f], good[f], `${f} が ${key} の失敗に巻き込まれた`);
    }
    switch (key) {
      case 'diffhash': assert.equal(r.mergeDiffHash, null); break;
      case 'risk':
        assert.deepEqual(r.risk, { ok: false, hits: [], error: 'no valid JSON' });
        assert.equal(isWellFormedRiskFact(facts), false);
        break;
      case 'changed': assert.equal(r.changedFiles, null); break;
      case 'pr': assert.deepEqual(r.prMeta, { ok: false, error: 'gh pr view failed' }); break;
      case 'head_tree': assert.equal(r.headTreeOid, null); break;
      case 'checks': assert.deepEqual(r.checks, { ok: false, error: 'gh pr checks failed' }); break;
      case 'closes': assert.equal(r.closes, 'unknown'); break;
      default: assert.fail('unreachable');
    }
  });
}

// (4) risk: スクリプト自身が ok:false を報告（契約通りの形）→ そのまま採用（fail-closed だが well-formed）
test('risk.value が {ok:false} の契約通り応答 → そのまま採用し isWellFormedRiskFact は true', () => {
  const facts = { ...fullFacts(), risk: { ok: true, value: { ok: false, hits: [], error: 'git failed', exit_code: 128 } } };
  const r = parseMergeTierFacts(facts);
  assert.deepEqual(r.risk, { ok: false, hits: [], error: 'git failed', exit_code: 128 });
  assert.equal(isWellFormedRiskFact(facts), true);
});

// (5) risk: 契約外形状（ok 非boolean / hits 非配列 / value 非object）→ fail-closed 合成
test('risk.value が契約外形状 → fail-closed 合成（hits=[]）', () => {
  for (const bad of [{ ok: 'yes', hits: [] }, { ok: true, hits: 'x' }, 'str', null, 42]) {
    const r = parseMergeTierFacts({ ...fullFacts(), risk: { ok: true, value: bad } });
    assert.equal(r.risk.ok, false, `value=${JSON.stringify(bad)}`);
    assert.deepEqual(r.risk.hits, []);
  }
});

// (6) changed: files に非 string 混入 / files 欠落 → null（空配列は正常 0 件として維持）
test('changed.value.files が string[] でない → null、[] は [] のまま', () => {
  assert.equal(parseMergeTierFacts({ ...fullFacts(), changed: { ok: true, value: { files: ['a', 1] } } }).changedFiles, null);
  assert.equal(parseMergeTierFacts({ ...fullFacts(), changed: { ok: true, value: {} } }).changedFiles, null);
  assert.deepEqual(parseMergeTierFacts({ ...fullFacts(), changed: { ok: true, value: { files: [] } } }).changedFiles, []);
});

// (7) pr: 値の欠落は null に正規化し ok:true は維持（classifyMergeableState が 'unknown' に倒す）
test('pr.value のフィールド欠落 → null に正規化（ok:true 維持）', () => {
  const r = parseMergeTierFacts({ ...fullFacts(), pr: { ok: true, value: { mergeable: 'UNKNOWN' } } });
  assert.deepEqual(r.prMeta, { ok: true, mergeable: 'UNKNOWN', mergeStateStatus: null, headRefOid: null });
});

// (8) head_tree: 空 / 非 string の tree → null。前後空白は trim（旧 head-tree-oid spawn と同じ受理条件）
test('head_tree.value.tree が空 / 非 string → null、空白付きは trim して採用', () => {
  assert.equal(parseMergeTierFacts({ ...fullFacts(), head_tree: { ok: true, value: { tree: '' } } }).headTreeOid, null);
  assert.equal(parseMergeTierFacts({ ...fullFacts(), head_tree: { ok: true, value: { tree: '   ' } } }).headTreeOid, null);
  assert.equal(parseMergeTierFacts({ ...fullFacts(), head_tree: { ok: true, value: { tree: 42 } } }).headTreeOid, null);
  assert.equal(parseMergeTierFacts({ ...fullFacts(), head_tree: { ok: true, value: { tree: ` ${TREE}\n` } } }).headTreeOid, TREE);
});

// (9) diffhash: hash 非 string / 空文字 → null
test('diffhash.value.hash が string でない / 空 → null', () => {
  assert.equal(parseMergeTierFacts({ ...fullFacts(), diffhash: { ok: true, value: { hash: 123, empty: false } } }).mergeDiffHash, null);
  assert.equal(parseMergeTierFacts({ ...fullFacts(), diffhash: { ok: true, value: { hash: '', empty: false } } }).mergeDiffHash, null);
});

// (9b) issue #790: mergeDiffHash=null の原因（diffhash.error。script が stderr 先頭を添える）を返す
test('mergeDiffHashError: diffhash ok:false → error をそのまま、hash 採用時・error 欠落・facts null は null', () => {
  const err = 'worktree-diff-hash.sh failed (exit 128): fatal: Unable to create index.lock';
  assert.equal(mergeDiffHashError({ ...fullFacts(), diffhash: { ok: false, value: null, error: err } }), err);
  assert.equal(mergeDiffHashError(fullFacts()), null);
  assert.equal(mergeDiffHashError({ ...fullFacts(), diffhash: { ok: false, value: null } }), null);
  assert.equal(mergeDiffHashError(null), null);
});

// (10) error 欠落の ok:false → fallback メッセージ
test('ok:false かつ error 欠落 → fallback の error 文字列', () => {
  const r = parseMergeTierFacts({ ...fullFacts(), risk: { ok: false }, pr: { ok: false }, checks: { ok: false } });
  assert.match(r.risk.error, /fail-closed/);
  assert.match(r.prMeta.error, /unavailable/);
  assert.match(r.checks.error, /unavailable/);
});

// (10b) issue #746: haiku 転記で value が落ちた応答（実測形）→ risk は fail-closed のまま、error は
// 「転記欠落」と識別でき、danger-grep 実行不能（スクリプト側の ok:false / 応答欠落）とは区別される
test('risk.ok:true で value 欠落 → isRiskValueDropped=true、error は転記欠落専用文言', () => {
  const dropped = { changed: { ok: true }, checks: { ok: true }, diffhash: { ok: true }, head_tree: { ok: true }, pr: { ok: true }, risk: { ok: true }, epoch: 1 };
  assert.equal(isRiskValueDropped(dropped), true);
  const r = parseMergeTierFacts(dropped);
  assert.deepEqual(r.risk, { ok: false, hits: [], error: MERGE_FACTS_RISK_DROPPED_ERROR });
  assert.match(MERGE_FACTS_RISK_DROPPED_ERROR, /transcription dropped/);
  for (const value of [null, {}, { ok: true }]) {
    assert.equal(isRiskValueDropped({ risk: { ok: true, value } }), true, `value=${JSON.stringify(value)}`);
    assert.equal(parseMergeTierFacts({ risk: { ok: true, value } }).risk.error, MERGE_FACTS_RISK_DROPPED_ERROR);
  }
});

test('isRiskValueDropped は転記欠落以外（正常 / スクリプトの ok:false / 応答欠落）では false', () => {
  assert.equal(isRiskValueDropped(fullFacts()), false);
  assert.equal(isRiskValueDropped({ risk: { ok: true, value: { ok: false, hits: [], error: 'git failed' } } }), false);
  assert.equal(isRiskValueDropped({ risk: { ok: false, value: null, error: 'no valid JSON' } }), false);
  assert.equal(isRiskValueDropped(null), false);
  assert.equal(isRiskValueDropped({}), false);
  assert.notEqual(parseMergeTierFacts({ risk: { ok: false, value: null, error: 'no valid JSON' } }).risk.error, MERGE_FACTS_RISK_DROPPED_ERROR);
  assert.notEqual(parseMergeTierFacts(null).risk.error, MERGE_FACTS_RISK_DROPPED_ERROR);
});

// (11) top-level 契約外形状の診断文字列
test('mergeTierFactsTopLevelKeys は診断用にキー一覧 / 型名を返す', () => {
  assert.equal(mergeTierFactsTopLevelKeys({ foo: 1, bar: 2 }), 'foo,bar');
  assert.equal(mergeTierFactsTopLevelKeys({}), '(none)');
  assert.equal(mergeTierFactsTopLevelKeys('x'), 'string');
});

// (12) prompt: gh 2 コマンドは bare 単文、script は bare 名先頭トークン、stdout は argv 転写。
// prompt に sandbox / excludedCommands / 特定パス起動の理由を書かない（.claude/rules/dev-flow.md）。
const promptOf = (o) => mergeTierFactsPrompt({ ...o, rollupCommand: ciRollupCommand({ pr: o.pr, repo: o.repo }) });

test('mergeTierFactsPrompt: gh 3 コマンド + merge-tier-facts bare 名の手順で、gh 出力は argv 転写', () => {
  const p = promptOf({ wt: '/tmp/wt', base: 'main', pr: 42, repo: 'acme/skills', issue: 824 });
  assert.ok(p.includes('`gh pr view 42 --repo acme/skills --json mergeable,mergeStateStatus,headRefOid`'));
  assert.ok(p.includes(`2. \`${ciRollupCommand({ pr: 42, repo: 'acme/skills' })}\` を先頭トークンが gh の bare 単文で 1 回だけ実行せよ`), p);
  assert.ok(p.includes('`merge-tier-facts --worktree /tmp/wt --base origin/main --pr-view-data \''));
  assert.ok(p.includes('--checks-data \''));
  assert.ok(p.includes('当該オプション自体を省略せよ'));
  assert.ok(p.includes('`value`') && p.includes('省略・空 object 化してはならない'), 'value の転記欠落を禁じる指示が無い（issue #746）');
  assert.ok(!/sandbox|excludedCommands/i.test(p), 'prompt に起動形の理由を書かない');
  assert.ok(!p.includes('bash merge-tier-facts'), 'bash 前置しない');
  assert.ok(!p.includes('.sh '), '拡張子付き呼び出しをしない');
});

test('mergeTierFactsPrompt: repo 省略時は --repo を付けない', () => {
  const p = promptOf({ wt: '/tmp/wt', base: 'dev', pr: 7, issue: 3 });
  assert.ok(p.includes('`gh pr view 7 --json mergeable,mergeStateStatus,headRefOid`'));
  assert.ok(p.includes(`\`${ciRollupCommand({ pr: 7 })}\``));
  assert.ok(p.includes(`\`gh pr view 7 --json body --jq '.body | test("Closes #3(\\\\D|$)")'\``));
  assert.ok(p.includes('--base origin/dev '));
  assert.ok(!p.includes('--repo'));
});

// (12') 同じ rollup で check-ci の判定と merge-tier-facts → classifyCiChecks の判定が一致する（issue #1232）。
// 片方だけ分類を変えると CI gate と Merge tier の判定が食い違う。check-ci には gh スタブの応答として同じ rollup を渡す。
const here = dirname(fileURLToPath(import.meta.url));
const scriptEnv = { ...process.env, PATH: `${join(here, '..', '..', 'playpark-core', 'bin')}:${process.env.PATH}` };
const factsWorktree = mkdtempSync(join(tmpdir(), 'merge-tier-facts-test-'));
afterAll(() => rmSync(factsWorktree, { recursive: true, force: true }));

function viaCheckCi(data) {
  return JSON.parse(runCheckCiWithRollup(data).stdout);
}

function viaMergeTierFacts(data) {
  const r = spawnSync('bash', [join(here, '..', '_shared', 'scripts', 'merge-tier-facts.sh'), '--worktree', factsWorktree, '--base', 'origin/main', '--checks-data', data], { encoding: 'utf8', env: scriptEnv });
  return classifyCiChecks(parseMergeTierFacts(JSON.parse(r.stdout)).checks);
}

const EARLY = '2026-01-01T00:00:00Z';
const LATE = '2026-01-01T00:05:00Z';
const run = (name, conclusion, status = 'COMPLETED', startedAt = EARLY, workflowName = 'CI') => ({ name, workflowName, status, conclusion, startedAt });
const ctx = (context, state, startedAt = EARLY) => ({ context, state, startedAt });

const ROLLUP_FIXTURES = [
  ['status が IN_PROGRESS のままの SUCCESS', [run('a', 'SUCCESS', 'IN_PROGRESS')], 'passed'],
  ['status が IN_PROGRESS のままの FAILURE', [run('a', 'FAILURE', 'IN_PROGRESS')], 'failed'],
  ['conclusion が空', [run('a', '', 'IN_PROGRESS')], 'pending'],
  ...['SUCCESS', 'SKIPPED', 'NEUTRAL'].map((v) => [`CheckRun ${v}`, [run('a', v)], 'passed']),
  ...['FAILURE', 'ERROR', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'CANCELLED', 'WHATEVER'].map((v) => [`CheckRun ${v}`, [run('a', v)], 'failed']),
  ...['PENDING', 'EXPECTED', 'STALE'].map((v) => [`CheckRun ${v}`, [run('a', v)], 'pending']),
  ['StatusContext SUCCESS', [ctx('v', 'SUCCESS')], 'passed'],
  ['StatusContext ERROR', [ctx('v', 'ERROR')], 'failed'],
  ['StatusContext PENDING', [ctx('v', 'PENDING')], 'pending'],
  ['StatusContext の未知の state', [ctx('v', 'WHATEVER')], 'failed'],
  ['同名 CheckRun: 先の failure を後の success で消さない', [run('a', 'FAILURE', 'COMPLETED', EARLY), run('a', 'SUCCESS', 'COMPLETED', LATE)], 'failed'],
  ['同名 CheckRun: failure なしは最新で判定', [run('a', 'SUCCESS', 'COMPLETED', EARLY), run('a', '', 'IN_PROGRESS', LATE)], 'pending'],
  ['同名 StatusContext: 最新で判定', [ctx('v', 'FAILURE', EARLY), ctx('v', 'SUCCESS', LATE)], 'passed'],
  ['failed と pending の混在', [run('a', 'FAILURE'), run('b', '', 'IN_PROGRESS'), run('c', 'SUCCESS')], 'failed'],
  ['空配列', [], 'no_checks'],
];

for (const [title, rollup, state] of ROLLUP_FIXTURES) {
  test(`rollup の判定が check-ci と Merge tier で一致する: ${title} → ${state}`, () => {
    const data = JSON.stringify(rollup);
    const gate = viaCheckCi(data);
    const tier = viaMergeTierFacts(data);
    assert.equal(gate.status, state);
    assert.equal(tier.state, state);
    assert.deepEqual(tier.failedNames, gate.failed_checks.map((c) => c.name));
    assert.deepEqual(tier.pendingNames, gate.pending_checks.map((c) => c.name));
  });
}

test('rollup が null: check-ci も Merge tier も no_checks', () => {
  assert.equal(viaCheckCi('null').status, 'no_checks');
  assert.equal(viaMergeTierFacts('null').state, 'no_checks');
});

test('rollup として読めない入力: check-ci は error、Merge tier は unavailable（どちらも green にしない）', () => {
  for (const data of ['not json', '{}', '[1]']) {
    assert.equal(viaCheckCi(data).status, 'error', data);
    assert.equal(viaMergeTierFacts(data).state, 'unavailable', data);
  }
});

// (13) closes: PR body は gh の --jq で true / false に畳み、その結果だけを merge-tier-facts へ渡す（issue #824）。
// 本文そのものは argv にも prompt にも載せない。
test('closesCheckCommand: repo 指定つき bare 単文の gh pr view --json body --jq で Closes #<issue> を真偽値にする', () => {
  assert.equal(
    closesCheckCommand({ pr: 42, repo: 'acme/skills', issue: 824 }),
    `gh pr view 42 --repo acme/skills --json body --jq '.body | test("Closes #824(\\\\D|$)")'`,
  );
  assert.equal(closesCheckCommand({ pr: 42, repo: '', issue: '824' }), `gh pr view 42 --json body --jq '.body | test("Closes #824(\\\\D|$)")'`);
});

test('mergeTierFactsPrompt: closes の gh コマンドを 1 本足し、stdout の true / false だけを --closes-data で渡す', () => {
  const p = promptOf({ wt: '/tmp/wt', base: 'main', pr: 42, repo: 'acme/skills', issue: 824 });
  const cmd = closesCheckCommand({ pr: 42, repo: 'acme/skills', issue: 824 });
  assert.ok(p.includes(`3. \`${cmd}\` を先頭トークンが gh の bare 単文で 1 回だけ実行せよ`), p);
  assert.ok(p.includes("--closes-data '<手順3の stdout（true または false）をそのまま>'"), p);
  assert.ok(p.includes('手順 1 / 2 / 3 の stdout が空、またはコマンドが実行できなかった場合は当該オプション自体を省略せよ'), p);
  // gh pr view --json body は --jq 付きの 1 本だけ（本文をそのまま stdout に出す形を指示しない）
  assert.equal(p.split('--json body').length - 1, 1, '--json body は closes の jq 判定 1 本だけ');
  assert.ok(!p.includes('--json body`'), '--jq なしの gh pr view --json body を指示しない');
  assert.ok(!/--closes-data '<[^>]*本文/.test(p), '本文を argv に載せさせない');
  assert.ok(p.includes('closes'), 'Output format に closes サブ結果が無い');
});

test('parseClosesFact: present:true → present、present:false → missing、取得失敗・契約外形状 → unknown', () => {
  assert.equal(parseClosesFact({ closes: { ok: true, value: { present: true } } }), 'present');
  assert.equal(parseClosesFact({ closes: { ok: true, value: { present: false } } }), 'missing');
  assert.equal(parseClosesFact({ closes: { ok: false, value: null, error: 'closes data not provided' } }), 'unknown');
  assert.equal(parseClosesFact({ closes: { ok: true, value: { present: 'true' } } }), 'unknown');
  assert.equal(parseClosesFact({ closes: { ok: true, value: null } }), 'unknown');
  assert.equal(parseClosesFact({}), 'unknown');
  assert.equal(parseClosesFact(null), 'unknown');
});

test('prClosesStatusOf: present → verified、missing → missing（再投入へ）、unknown → unverified（fail-open）', () => {
  assert.equal(prClosesStatusOf('present'), 'verified');
  assert.equal(prClosesStatusOf('missing'), 'missing');
  assert.equal(prClosesStatusOf('unknown'), 'unverified');
  for (const c of ['present', 'missing', 'unknown']) assert.ok(PR_CLOSES_STATUS_VALUES.includes(prClosesStatusOf(c)));
});

test('closesReinjectStatus: 再投入失敗・再取得 false は missing（fail-closed）、true は reinjected、再取得失敗は unverified', () => {
  assert.equal(closesReinjectStatus(null), 'missing');
  assert.equal(closesReinjectStatus({ edited: false, error: 'x' }), 'missing');
  assert.equal(closesReinjectStatus({ edited: true, closes: 'false' }), 'missing');
  assert.equal(closesReinjectStatus({ edited: true, closes: 'true\n' }), 'reinjected');
  assert.equal(closesReinjectStatus({ edited: true }), 'unverified');
  assert.equal(closesReinjectStatus({ edited: true, closes: 'gh: error' }), 'unverified');
  for (const r of [null, { edited: true, closes: 'true' }, { edited: true }]) assert.ok(PR_CLOSES_STATUS_VALUES.includes(closesReinjectStatus(r)));
});

test('closesReinjectPrompt: 決定論本文を Write → gh pr edit --body-file → 同じ spawn で closes の jq 判定を再取得', () => {
  const p = closesReinjectPrompt({ wt: '/w', pr: 5, repo: 'o/r', issue: 9, prBody: 'body\nCloses #9\n' });
  assert.ok(p.includes('<<<PR_BODY_BEGIN>>>\nbody\nCloses #9\n<<<PR_BODY_END>>>'), p);
  assert.ok(p.includes('`/w/.devflow-tmp/pr-body-reinject.md`'), p);
  assert.ok(p.includes('1. `gh pr edit 5 --repo o/r --body-file /w/.devflow-tmp/pr-body-reinject.md`'), p);
  assert.ok(p.includes(`2. \`${closesCheckCommand({ pr: 5, repo: 'o/r', issue: 9 })}\``), p);
  assert.ok(p.includes('{"edited": true, "closes": "<手順2の stdout（true または false）をそのまま>"}'), p);
  assert.ok(!/sandbox|excludedCommands/i.test(p), 'prompt に起動形の理由を書かない');
  assert.deepEqual(CLOSES_REINJECT.required, ['edited']);
  assert.ok('closes' in CLOSES_REINJECT.properties);
});
