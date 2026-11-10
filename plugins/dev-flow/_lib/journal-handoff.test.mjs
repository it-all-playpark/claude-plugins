import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import os from 'node:os';

import {
  ABORT_ERROR_CATEGORY,
  JOURNAL_HANDOFF_RESULT,
  buildAbortErrorMsg,
  buildAbortHandoffPayload,
  buildJournalHandoffPayload,
  buildJournalPendingPath,
  buildJournalPendingWriteInstr,
  classifyJournalLogStatus,
  journalEffectId,
  repoFromGithubUrl,
  runJournalHandoff,
} from './journal-handoff.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

// issue #433 regression fixture: a payload that stresses the multi-escaping class the
// Write-tool verbatim pattern is meant to eliminate — a Japanese test name, a backtick-quoted
// shell anchor, and a JSON string value whose content is itself an escaped JSON string
// (mirrors the devflow-411 malformed-park incident shape, but valid here).
const EDGE_CASE_PAYLOAD = JSON.stringify({
  skill: 'dev-flow',
  outcome: 'success',
  telemetry: {
    vdelta_verdicts: [
      {
        ac: 'AC-1',
        name: '日本語テスト名の検証',
        anchor: '`vdelta show run_x --raw`',
        raw: '{"verdict":"{\\"transitions\\":{\\"new_fail\\":[]}}"}',
      },
    ],
  },
});

// exercise the pending/ naming + verbatim-write contract against a scratch journal dir
// (not just the literal instruction string).
function withScratchJournalDir(fn) {
  const dir = mkdtempSync(join(os.tmpdir(), 'journal-handoff-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const PENDING_PREFIX = '~/.claude/journal/pending/';
const BODY_RE = /<<<JOURNAL_HANDOFF_BODY_BEGIN>>>\n([\s\S]*?)\n<<<JOURNAL_HANDOFF_BODY_END>>>/;

// Simulates the agent step described by buildJournalPendingWriteInstr: take the delimited body
// and the backtick-quoted pending path out of the instruction itself, then Write the body
// verbatim there. Driving the simulation from the instruction string (not from the JS inputs)
// pins that the single spawn carries everything the write needs — there is no intermediate
// payload file to read. The `~` prefix — expanded by the Write tool in production — is rebased
// onto a scratch dir so the test never touches the real journal.
function simulateHandoffWrite({ instr, journalDir }) {
  const body = instr.match(BODY_RE);
  assert.ok(body, 'instruction に JOURNAL_HANDOFF_BODY delimiter が無い');
  const pathMatch = instr.match(/`(~\/\.claude\/journal\/pending\/[^`]+)`/);
  assert.ok(pathMatch, `instruction に pending パスが無い: ${instr}`);
  const pendingPath = pathMatch[1];
  assert.ok(pendingPath.startsWith(PENDING_PREFIX), `pending パスの接頭辞が変わっている: ${pendingPath}`);
  const rebased = join(journalDir, 'pending', pendingPath.slice(PENDING_PREFIX.length));
  mkdirSync(dirname(rebased), { recursive: true });
  writeFileSync(rebased, body[1], 'utf8');
  return rebased;
}

function listPending(journalDir) {
  try {
    return readdirSync(join(journalDir, 'pending'));
  } catch {
    return [];
  }
}

test('buildJournalHandoffPayload creates compact handoff JSON', () => {
  const payload = buildJournalHandoffPayload({
    skill: 'pr-iterate',
    outcome: 'success',
    args: 'pr=251',
    telemetry: { merge_tier: 'PR_ITERATE', iterate_status: 'lgtm' },
  });

  assert.equal(
    payload,
    '{"skill":"pr-iterate","outcome":"success","args":"pr=251","telemetry":{"merge_tier":"PR_ITERATE","iterate_status":"lgtm"}}',
  );
});

test('buildJournalHandoffPayload includes repo and pr_number top-level between issue and journal_sh', () => {
  const payload = buildJournalHandoffPayload({
    skill: 'dev-flow',
    outcome: 'success',
    issue: 309,
    repo: 'acme/skills',
    pr_number: 12,
    telemetry: { merge_tier: 'REVIEW' },
  });

  assert.equal(
    payload,
    '{"skill":"dev-flow","outcome":"success","issue":309,"repo":"acme/skills","pr_number":12,"telemetry":{"merge_tier":"REVIEW"}}',
  );
});

test('buildJournalHandoffPayload omits repo/pr_number when not provided', () => {
  const payload = buildJournalHandoffPayload({
    skill: 'dev-flow',
    outcome: 'success',
    issue: 309,
    telemetry: { merge_tier: 'REVIEW' },
  });

  assert.ok(!payload.includes('"repo"'));
  assert.ok(!payload.includes('"pr_number"'));
});

// issue #607: error_phase carries the abort phase at the top level, feeding
// journal.sh's existing --error-phase flag (journal `.error.phase`) so dev-flow-health's
// failure signature (skill | category | phase | message) can tell abort entries apart by phase.
test('buildJournalHandoffPayload includes error_phase immediately after error_msg when provided', () => {
  const payload = buildJournalHandoffPayload({
    skill: 'dev-flow',
    outcome: 'failure',
    error_category: 'abort',
    error_msg: 'abort@Plan/plan#1: boom',
    error_phase: 'Plan',
  });

  assert.equal(
    payload,
    '{"skill":"dev-flow","outcome":"failure","error_category":"abort","error_msg":"abort@Plan/plan#1: boom","error_phase":"Plan"}',
  );
});

test('buildJournalHandoffPayload omits error_phase when not provided', () => {
  const payload = buildJournalHandoffPayload({
    skill: 'dev-flow',
    outcome: 'failure',
    error_category: 'empty_diff',
    error_msg: 'no changes',
  });

  assert.ok(!payload.includes('"error_phase"'));
});

test('repoFromGithubUrl parses owner/name from GitHub pull request and repo URLs', () => {
  assert.equal(repoFromGithubUrl('https://github.com/acme/skills/pull/12'), 'acme/skills');
  assert.equal(repoFromGithubUrl('https://github.com/acme/skills'), 'acme/skills');
});

test('repoFromGithubUrl returns null for non-GitHub or malformed input', () => {
  assert.equal(repoFromGithubUrl('http://x'), null);
  assert.equal(repoFromGithubUrl(''), null);
  assert.equal(repoFromGithubUrl(null), null);
  assert.equal(repoFromGithubUrl('https://example.com/a/b'), null);
});

// ---- buildJournalPendingWriteInstr ----

test('buildJournalPendingWriteInstr embeds the payload verbatim between JOURNAL_HANDOFF_BODY delimiters, including Japanese/backtick/nested-escaped-JSON edge cases', () => {
  const instr = buildJournalPendingWriteInstr({ prefix: 'devflow', id: 807, payload: EDGE_CASE_PAYLOAD });
  const match = instr.match(BODY_RE);
  assert.ok(match, 'expected instr to contain the delimited payload block');
  assert.equal(match[1], EDGE_CASE_PAYLOAD);
});

test('buildJournalPendingWriteInstr targets the JS-determined pending path derived from the payload', () => {
  const payload = '{"skill":"dev-flow","outcome":"success"}';
  const instr = buildJournalPendingWriteInstr({ prefix: 'devflow', id: 807, payload });
  assert.ok(instr.includes(`\`${buildJournalPendingPath({ prefix: 'devflow', id: 807, effectId: journalEffectId(payload) })}\``));
});

test('buildJournalPendingWriteInstr instructs Write tool usage and forbids passing the payload through shell', () => {
  const instr = buildJournalPendingWriteInstr({ prefix: 'devflow', id: 807, payload: '{"ok":true}' });
  assert.ok(instr.includes('Write tool'));
  assert.ok(instr.includes('echo'));
  assert.ok(instr.includes('printf'));
  assert.ok(instr.includes('heredoc'));
  assert.ok(instr.includes('**Bash は使うな**'));
});

// issue #498 review: Write tool refuses to overwrite an existing file it hasn't Read in the
// same session. The pending file name is stable for an identical payload (effect ID), so a rerun
// with the same payload deterministically fails to write unless the instruction tells the agent
// to Read-then-Write (same idempotency pattern as isolationProbePrompt, issue #482).
test('buildJournalPendingWriteInstr instructs a Read-before-overwrite idempotency step', () => {
  const instr = buildJournalPendingWriteInstr({ prefix: 'devflow', id: 807, payload: '{"ok":true}' });
  assert.ok(instr.includes('Read tool'));
  assert.ok(/Read tool[\s\S]*Write tool/.test(instr), 'Read の指示は Write の指示より前に現れるべき');
});

// issue #526 regression pin: 指示に shell 構文が 1 つでも戻ると、EnterWorktree 済み
// セッションの worktree 分離ガードに `too complex to verify that it stays inside the worktree`
// で拒否され、dev-flow / pr-iterate のテレメトリが再び全損する（2026-08-20〜28 の実害）。
// 「Write tool のみで書く」という性質を、生成文字列の側から機械的に固定する。payload 本文は
// shell へ渡らない data なので、delimiter 区間を除いた指示文だけを検査する。
test('buildJournalPendingWriteInstr (issue #526) emits no shell constructs outside the payload body — writes through the Write tool only', () => {
  const instr = buildJournalPendingWriteInstr({ prefix: 'devflow', id: 526, payload: EDGE_CASE_PAYLOAD });
  const outsideBody = instr.replace(BODY_RE, '');
  for (const shellToken of ['$(', '&&', '||', '>/dev/null', '${', '|', 'mktemp', 'shasum', 'mkdir ', 'mv ', 'cp ', 'jq ']) {
    assert.ok(
      !outsideBody.includes(shellToken),
      `指示に shell 構文 '${shellToken}' が含まれている: ${outsideBody}`,
    );
  }
});

// fail-open 契約: どの手順で失敗しても throw せず {saved, logged} を返す。呼び出し側はこれを
// classifyJournalLogStatus で save_failed / log_failed として観測できる。
test('buildJournalPendingWriteInstr keeps the fail-open contract — never throw, report {saved, logged}', () => {
  const instr = buildJournalPendingWriteInstr({ prefix: 'devflow', id: 526, payload: '{"ok":true}' });
  assert.ok(instr.includes('saved:true'));
  assert.ok(instr.includes('saved:false'));
  assert.ok(instr.includes('logged:true'));
  assert.ok(instr.includes('logged:false'));
  assert.ok(instr.includes('{saved, logged}'));
});

test('buildJournalPendingWriteInstr throws when payload is missing or not a string', () => {
  for (const bad of [undefined, null, '', 42, {}]) {
    assert.throws(
      () => buildJournalPendingWriteInstr({ prefix: 'devflow', id: 807, payload: bad }),
      /payload is required/,
      `payload=${JSON.stringify(bad ?? null)} は reject されるべき`,
    );
  }
});

test('buildJournalPendingWriteInstr rejects unsafe prefix / id before splicing them into the Write path', () => {
  assert.throws(() => buildJournalPendingWriteInstr({ prefix: 'bad/prefix', id: 807, payload: '{}' }), /invalid prefix/);
  assert.throws(() => buildJournalPendingWriteInstr({ prefix: 'devflow', id: '807;rm', payload: '{}' }), /invalid id/);
});

test('JOURNAL_HANDOFF_RESULT requires both saved and logged booleans', () => {
  assert.equal(JOURNAL_HANDOFF_RESULT.type, 'object');
  assert.deepEqual(JOURNAL_HANDOFF_RESULT.required, ['saved', 'logged']);
  assert.deepEqual(JOURNAL_HANDOFF_RESULT.properties.saved, { type: 'boolean' });
  assert.deepEqual(JOURNAL_HANDOFF_RESULT.properties.logged, { type: 'boolean' });
});

// ---- classifyJournalLogStatus ----

test('classifyJournalLogStatus returns save_failed when saved is not true', () => {
  assert.equal(classifyJournalLogStatus({ saved: false, logged: true }), 'save_failed');
  assert.equal(classifyJournalLogStatus({ saved: undefined, logged: true }), 'save_failed');
  assert.equal(classifyJournalLogStatus({ saved: null, logged: true }), 'save_failed');
});

test('classifyJournalLogStatus returns logged when saved is true and logged is true', () => {
  assert.equal(classifyJournalLogStatus({ saved: true, logged: true }), 'logged');
});

test('classifyJournalLogStatus returns log_failed when saved is true but logged is not true', () => {
  assert.equal(classifyJournalLogStatus({ saved: true, logged: false }), 'log_failed');
  assert.equal(classifyJournalLogStatus({ saved: true, logged: undefined }), 'log_failed');
  assert.equal(classifyJournalLogStatus({ saved: true, logged: null }), 'log_failed');
});

// ---- journalEffectId / buildJournalPendingPath ----

test('buildJournalPendingPath rejects unsafe path parts', () => {
  const effectId = journalEffectId('{}');
  assert.throws(() => buildJournalPendingPath({ prefix: 'bad/prefix', id: 251, effectId }), /invalid prefix/);
  assert.throws(() => buildJournalPendingPath({ prefix: 'priterate', id: '251;rm', effectId }), /invalid id/);
  assert.throws(() => buildJournalPendingPath({ prefix: 'devflow', id: 251, effectId: '../escape' }), /invalid effectId/);
  assert.throws(() => buildJournalPendingPath({ prefix: 'devflow', id: 251, effectId: 'ABCDEF0123456789' }), /invalid effectId/);
});

test('buildJournalPendingPath builds the pending path under the tilde journal dir', () => {
  const effectId = journalEffectId('{"skill":"dev-flow"}');
  assert.equal(
    buildJournalPendingPath({ prefix: 'devflow', id: 526, effectId }),
    `~/.claude/journal/pending/devflow-526-effect-${effectId}.json`,
  );
});

test('journalEffectId is deterministic, 16 lowercase hex, and separates payloads that differ only in a high byte', () => {
  assert.match(journalEffectId(EDGE_CASE_PAYLOAD), /^[0-9a-f]{16}$/);
  assert.equal(journalEffectId(EDGE_CASE_PAYLOAD), journalEffectId(EDGE_CASE_PAYLOAD));
  assert.notEqual(
    journalEffectId('{"skill":"dev-flow","outcome":"success"}'),
    journalEffectId('{"skill":"dev-flow","outcome":"failure"}'),
  );
  // 'あ'(U+3042) と 'B'(U+0042) は下位バイトが同一。下位バイトだけを混ぜる実装だと衝突するため、
  // 日本語を含む payload の識別が落ちていないことをここで固定する。
  assert.notEqual(journalEffectId('あ'), journalEffectId('B'));
});

test('the handoff write against the real instruction produces exactly one valid-JSON effect file matching the payload', () => {
  withScratchJournalDir((journalDir) => {
    simulateHandoffWrite({ instr: buildJournalPendingWriteInstr({ prefix: 'devflow', id: 433, payload: EDGE_CASE_PAYLOAD }), journalDir });

    const files = listPending(journalDir);
    assert.equal(files.length, 1);
    assert.match(files[0], /^devflow-433-effect-[0-9a-f]{16}\.json$/);
    const content = readFileSync(join(journalDir, 'pending', files[0]), 'utf8');
    assert.equal(content, EDGE_CASE_PAYLOAD);
    assert.doesNotThrow(() => JSON.parse(content));
  });
});

test('re-running the handoff write with an identical payload does not create a duplicate entry (idempotent overwrite)', () => {
  withScratchJournalDir((journalDir) => {
    const payload = '{"skill":"dev-flow","outcome":"success","issue":412}';
    const instr = buildJournalPendingWriteInstr({ prefix: 'devflow', id: 412, payload });
    simulateHandoffWrite({ instr, journalDir });
    const firstListing = listPending(journalDir);
    simulateHandoffWrite({ instr, journalDir });
    const secondListing = listPending(journalDir);

    assert.equal(firstListing.length, 1);
    assert.deepEqual(secondListing, firstListing);
    const content = readFileSync(join(journalDir, 'pending', secondListing[0]), 'utf8');
    assert.equal(content, payload);
  });
});

test('a different payload for the same prefix/id produces a distinct effect file (no collision)', () => {
  withScratchJournalDir((journalDir) => {
    simulateHandoffWrite({ instr: buildJournalPendingWriteInstr({ prefix: 'devflow', id: 412, payload: '{"skill":"dev-flow","outcome":"success"}' }), journalDir });
    simulateHandoffWrite({ instr: buildJournalPendingWriteInstr({ prefix: 'devflow', id: 412, payload: '{"skill":"dev-flow","outcome":"failure"}' }), journalDir });

    const files = listPending(journalDir).sort();
    assert.equal(files.length, 2);
    assert.notEqual(files[0], files[1]);
  });
});

test('the handoff write leaves a single plain *.json entry (no dot-prefixed or non-json leftovers)', () => {
  withScratchJournalDir((journalDir) => {
    simulateHandoffWrite({ instr: buildJournalPendingWriteInstr({ prefix: 'priterate', id: 99, payload: '{"skill":"pr-iterate","outcome":"success"}' }), journalDir });

    const files = listPending(journalDir);
    assert.ok(files.every((f) => !f.startsWith('.')));
    assert.ok(files.every((f) => f.endsWith('.json')));
  });
});

// ---- runJournalHandoff (deps-injected single-spawn choreography, issue #807) ----

const HANDOFF_PAYLOAD = '{"skill":"dev-flow","outcome":"success"}';

function makeStubAgent(responders) {
  const calls = [];
  const agent = async (prompt, opts) => {
    calls.push({ prompt, opts });
    const responder = responders[opts.label];
    if (!responder) throw new Error(`unexpected label: ${opts.label}`);
    return responder({ prompt, opts });
  };
  return { agent, calls };
}

function makeStubLog() {
  const messages = [];
  return { log: (msg) => messages.push(msg), messages };
}

async function runHandoffWith(responder, overrides = {}) {
  const { agent, calls } = makeStubAgent({ 'journal-log-failure': responder });
  const { log, messages } = makeStubLog();
  const status = await runJournalHandoff({
    agent,
    log,
    payload: HANDOFF_PAYLOAD,
    prefix: 'devflow',
    id: 807,
    logLabel: 'journal-log-failure',
    phase: 'Setup',
    ...overrides,
  });
  return { status, calls, messages };
}

// AC-1: 1 spawn（dev-runner-haiku）で payload を pending/ のパスへ一字一句そのまま Write させる。
// 一時ファイルを経由しないので、spawn の prompt だけで書き込みが完結することを、prompt から
// 実際に書き出した内容で確認する。
test('runJournalHandoff spawns exactly one dev-runner-haiku agent whose prompt alone writes the payload verbatim to pending/', async () => {
  const { status, calls } = await runHandoffWith(async () => ({ saved: true, logged: true }), { payload: EDGE_CASE_PAYLOAD });

  assert.equal(status, 'logged');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.agentType, 'dev-runner-haiku');
  assert.equal(calls[0].opts.label, 'journal-log-failure');
  assert.equal(calls[0].opts.phase, 'Setup');
  assert.equal(calls[0].opts.schema, JOURNAL_HANDOFF_RESULT);

  const pendingPath = buildJournalPendingPath({ prefix: 'devflow', id: 807, effectId: journalEffectId(EDGE_CASE_PAYLOAD) });
  assert.ok(calls[0].prompt.includes(pendingPath));
  assert.ok(!calls[0].prompt.includes('.devflow-tmp'), 'payload の一時ファイルを経由してはならない');

  withScratchJournalDir((journalDir) => {
    simulateHandoffWrite({ instr: calls[0].prompt, journalDir });
    const files = listPending(journalDir);
    assert.equal(files.length, 1);
    assert.equal(readFileSync(join(journalDir, 'pending', files[0]), 'utf8'), EDGE_CASE_PAYLOAD);
  });
});

// AC-2: 統合 spawn の申告 {saved, logged} から 3 値を帰属できる（issue #499 の段の区別を保つ）。
test('runJournalHandoff returns log_failed and warns when the spawn reports the write was attempted but failed (saved:true, logged:false)', async () => {
  const { status, calls, messages } = await runHandoffWith(async () => ({ saved: true, logged: false }));
  assert.equal(status, 'log_failed');
  assert.equal(calls.length, 1);
  assert.ok(messages.some((m) => m.includes('log_failed')), `log dep に log_failed の警告が無い: ${JSON.stringify(messages)}`);
});

test('runJournalHandoff returns save_failed and warns when the spawn reports the write was never attempted (saved:false)', async () => {
  const { status, calls, messages } = await runHandoffWith(async () => ({ saved: false, logged: false }));
  assert.equal(status, 'save_failed');
  assert.equal(calls.length, 1);
  assert.ok(messages.some((m) => m.includes('save_failed')), `log dep に save_failed の警告が無い: ${JSON.stringify(messages)}`);
});

// saved が true でない申告は logged の値に関係なく save_failed（書き込み試行に到達していない段を
// logged / log_failed へ昇格させない）。
test('runJournalHandoff never promotes a report without saved:true to logged', async () => {
  const { status } = await runHandoffWith(async () => ({ saved: false, logged: true }));
  assert.equal(status, 'save_failed');
});

// spawn が throw / null の場合は Write 到達の申告が無いので save_failed のまま残す。throw は外へ漏らさない（fail-open）。
test('runJournalHandoff returns save_failed — and never lets the throw escape — when the spawn throws', async () => {
  const { status, calls, messages } = await runHandoffWith(async () => { throw new Error('handoff boom'); });
  assert.equal(status, 'save_failed');
  assert.equal(calls.length, 1);
  assert.ok(messages.some((m) => m.includes('handoff boom')));
});

test('runJournalHandoff returns save_failed when the spawn returns null', async () => {
  const { status } = await runHandoffWith(async () => null);
  assert.equal(status, 'save_failed');
});

test('runJournalHandoff always returns one of the 3-value closed enum', async () => {
  for (const responder of [
    async () => ({ saved: true, logged: true }),
    async () => ({ saved: true, logged: false }),
    async () => ({ saved: false, logged: false }),
    async () => null,
    async () => { throw new Error('boom'); },
  ]) {
    const { status } = await runHandoffWith(responder);
    assert.ok(['logged', 'save_failed', 'log_failed'].includes(status), `3 値 enum 外: ${status}`);
  }
});

// AC-3: spawn の prompt に payload 以外の結論値・要約を載せない（classifier による journal-log
// ブロックの面を広げない）。call site ごとの label / phase や payload の中身が変わっても、
// payload 本文と payload 由来の pending パスを除いた prompt は一字一句同じでなければならない。
test('runJournalHandoff prompt carries no conclusion value or summary other than the payload itself', async () => {
  const capture = async ({ payload, prefix, id, logLabel, phase }) => {
    const calls = [];
    await runJournalHandoff({
      agent: async (prompt, opts) => { calls.push({ prompt, opts }); return { saved: true, logged: true }; },
      log: () => {},
      payload,
      prefix,
      id,
      logLabel,
      phase,
    });
    assert.equal(calls.length, 1);
    const pendingPath = buildJournalPendingPath({ prefix, id, effectId: journalEffectId(payload) });
    return calls[0].prompt.replace(BODY_RE, '<BODY>').split(pendingPath).join('<PENDING>');
  };

  const success = await capture({
    payload: '{"skill":"dev-flow","outcome":"success","telemetry":{"merge_tier":"REVIEW"}}',
    prefix: 'devflow', id: 807, logLabel: 'journal-log', phase: 'Merge tier',
  });
  const failure = await capture({
    payload: '{"skill":"dev-flow","outcome":"failure","error_category":"empty_diff"}',
    prefix: 'devflow', id: 807, logLabel: 'journal-log-failure', phase: 'Validate',
  });
  const abort = await capture({
    payload: '{"skill":"pr-iterate","outcome":"failure","error_category":"abort","error_msg":"abort@Iterate/fix#1: boom"}',
    prefix: 'priterate', id: 12, logLabel: 'journal-log-abort', phase: 'Iterate',
  });

  assert.equal(failure, success);
  assert.equal(abort, success);
  // 旧 prompt の Objective に載っていた call site の subject（'dev-flow 完走' / 'dev-flow 失敗' /
  // 'pr-iterate abort' 等）や label / phase も現れない。
  for (const leaked of ['success', 'failure', 'abort', 'REVIEW', 'empty_diff', 'merge_tier', '完走', '終端', 'journal-log-failure', 'Merge tier', 'Validate', 'Iterate', 'dev-flow', 'pr-iterate']) {
    assert.ok(!success.includes(leaked), `payload 外の prompt に '${leaked}' が含まれている:\n${success}`);
  }
});

// ---- buildAbortErrorMsg / buildAbortHandoffPayload (issue #607) ----

test('ABORT_ERROR_CATEGORY is the fixed abort error_category value', () => {
  assert.equal(ABORT_ERROR_CATEGORY, 'abort');
});

test('buildAbortErrorMsg formats abort@<phase>/<label>: <message> from an Error', () => {
  assert.equal(
    buildAbortErrorMsg({ phase: 'Plan', label: 'plan#1', error: new Error('planner boom') }),
    'abort@Plan/plan#1: planner boom',
  );
});

test('buildAbortErrorMsg falls back to ? for missing phase/label', () => {
  assert.equal(
    buildAbortErrorMsg({ phase: null, label: null, error: new Error('boom') }),
    'abort@?/?: boom',
  );
});

test('buildAbortErrorMsg accepts a plain string error', () => {
  assert.equal(
    buildAbortErrorMsg({ phase: 'Evaluate', label: 'eval#1', error: 'plain string boom' }),
    'abort@Evaluate/eval#1: plain string boom',
  );
});

test('buildAbortErrorMsg falls back to "unknown error" when error is undefined', () => {
  assert.equal(
    buildAbortErrorMsg({ phase: 'Setup', label: 'prerun-setup', error: undefined }),
    'abort@Setup/prerun-setup: unknown error',
  );
});

test('buildAbortErrorMsg normalizes newlines/whitespace in the message to single spaces', () => {
  assert.equal(
    buildAbortErrorMsg({ phase: 'Plan', label: 'plan#1', error: new Error('line1\n\nline2\tline3') }),
    'abort@Plan/plan#1: line1 line2 line3',
  );
});

test('buildAbortErrorMsg truncates a 600-char message to 500 chars total', () => {
  const longMsg = 'x'.repeat(600);
  const result = buildAbortErrorMsg({ phase: 'Plan', label: 'plan#1', error: new Error(longMsg) });
  assert.equal(result.length, 500);
  assert.equal(result, `abort@Plan/plan#1: ${longMsg}`.slice(0, 500));
});

test('buildAbortHandoffPayload sets outcome:failure, error_category:abort, error_phase, and passes telemetry through without abort_phase/abort_label', () => {
  const payload = JSON.parse(buildAbortHandoffPayload({
    skill: 'dev-flow',
    issue: '607',
    phase: 'Evaluate',
    label: 'eval#1',
    error: new Error('evaluator boom'),
    telemetry: { shape: 'complex' },
  }));

  assert.equal(payload.outcome, 'failure');
  assert.equal(payload.error_category, 'abort');
  assert.equal(payload.error_phase, 'Evaluate');
  assert.equal(payload.error_msg, 'abort@Evaluate/eval#1: evaluator boom');
  // phase/label は error_phase / error_msg に載る。telemetry は呼び出し側が渡したキーだけ
  assert.deepEqual(payload.telemetry, { shape: 'complex' });
  assert.equal(payload.issue, 607);
});

test('buildAbortHandoffPayload Number-izes issue and pr_number', () => {
  const payload = JSON.parse(buildAbortHandoffPayload({
    skill: 'pr-iterate',
    issue: '451',
    pr_number: '12',
    phase: 'Iterate',
    label: 'fix#1',
    error: new Error('boom'),
  }));

  assert.equal(payload.issue, 451);
  assert.equal(payload.pr_number, 12);
});

test('buildAbortHandoffPayload omits telemetry when none is given (phase/label absent → "?" in error_msg, no error_phase)', () => {
  const payload = JSON.parse(buildAbortHandoffPayload({
    skill: 'dev-flow',
    error: new Error('boom'),
  }));

  assert.equal(Object.hasOwn(payload, 'telemetry'), false);
  assert.equal(Object.hasOwn(payload, 'error_phase'), false);
  assert.equal(payload.error_msg, 'abort@?/?: boom');
});

// ---- conformance: call sites use the canonical single-spawn handoff ----
//
// dev-flow.js（writeFailureTelemetry / 評価できなかった終端 / PR phase 失敗 / Merge tier / top-level abort）と pr-iterate.js
// （終端 / top-level abort）の 7 call site は canonical `runJournalHandoff` を通り、payload を pending/ へ
// 直接書く 1 spawn に集約されている（issue #807）。工程の workflow（dev-flow-evaluate.js / dev-flow-finalize.js）は handoff しない。

test('workflows route every journal handoff through the canonical single-spawn runJournalHandoff', () => {
  const devFlow = readFileSync(join(repoRoot, '.claude/workflows/dev-flow.js'), 'utf8');
  const prIterate = readFileSync(join(repoRoot, '.claude/workflows/pr-iterate.js'), 'utf8');
  for (const stage of ['dev-flow-evaluate.js', 'dev-flow-finalize.js']) {
    const stageSrc = readFileSync(join(repoRoot, '.claude/workflows', stage), 'utf8');
    assert.equal((stageSrc.match(/runJournalHandoff\(/g) ?? []).length, 0, `${stage} は journal handoff しない（親が run ごとに 1 回）`);
  }

  assert.equal((devFlow.match(/(?<!function )runJournalHandoff\(\{/g) ?? []).length, 5);
  assert.equal((prIterate.match(/(?<!function )runJournalHandoff\(\{/g) ?? []).length, 2);
  // logLabel は現行値のまま維持されている（issue #556 AC6）。
  assert.ok(devFlow.includes("logLabel: 'journal-log',"));
  assert.ok(devFlow.includes("logLabel: 'journal-log-failure',"));
  assert.ok(devFlow.includes("logLabel: 'journal-log-abort',"));
  assert.ok(prIterate.includes("logLabel: 'journal-log',"));
  assert.ok(prIterate.includes("logLabel: 'journal-log-abort',"));
});
