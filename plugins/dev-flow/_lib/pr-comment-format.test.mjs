import { test } from 'vitest';
import assert from 'node:assert/strict';
import { buildTerminalSummaryBody } from './pr-comment-format.mjs';
import { mdCell } from './md-cell.mjs';
globalThis.mdCell = mdCell;

// --- buildTerminalSummaryBody ------------------------------------------------

test('buildTerminalSummaryBody: lgtm -> 🎉 LGTM 見出しと at-a-glance テーブルが出る', () => {
  const body = buildTerminalSummaryBody({
    pr: 42,
    status: 'lgtm',
    iterations: 2,
    lastDecision: 'approve',
    lastSummary: 'looks good',
    history: [],
  });
  assert.ok(body.includes('🎉 LGTM'), 'lgtm 見出しを含む');
  assert.ok(body.includes('| 終了状態 | 反復回数 | 最終判定 |'), 'at-a-glance テーブルヘッダを含む');
  assert.ok(body.includes('✅'), 'approve 絵文字を含む');
});

test('buildTerminalSummaryBody: stuck -> ⚠️ STUCK 見出しが出る', () => {
  const body = buildTerminalSummaryBody({
    pr: 10,
    status: 'stuck',
    iterations: 3,
    lastDecision: 'request-changes',
    lastSummary: 'not improving',
    history: [],
  });
  assert.ok(body.includes('⚠️ STUCK'), 'stuck 見出しを含む');
  assert.ok(body.includes('エスカレーション'), '人間エスカレーションへの言及');
});

test('buildTerminalSummaryBody: fix_failed -> ⚠️ 自動修正失敗 見出しが出る', () => {
  const body = buildTerminalSummaryBody({
    pr: 5,
    status: 'fix_failed',
    iterations: 1,
    lastDecision: 'request-changes',
    lastSummary: 'fix failed',
    history: [],
  });
  assert.ok(body.includes('⚠️ 自動修正失敗'), 'fix_failed 見出しを含む');
});

test('buildTerminalSummaryBody: max_reached -> ⚠️ 反復上限到達 見出しが出る', () => {
  const body = buildTerminalSummaryBody({
    pr: 8,
    status: 'max_reached',
    iterations: 10,
    lastDecision: 'request-changes',
    lastSummary: 'max iterations hit',
    history: [],
  });
  assert.ok(body.includes('⚠️ 反復上限到達'), 'max_reached 見出しを含む');
});

test('buildTerminalSummaryBody: ci_error -> ⚠️ CI エラー 見出しが出る', () => {
  const body = buildTerminalSummaryBody({
    pr: 12,
    status: 'ci_error',
    iterations: 2,
    lastDecision: 'request-changes',
    lastSummary: 'gh api failed',
    history: [],
  });
  assert.ok(body.includes('⚠️ CI エラー'), 'ci_error 見出しを含む');
  assert.ok(body.includes('エスカレーション'), '人間エスカレーションへの言及');
  assert.ok(!body.includes('auth/network'), 'ci_error 見出しは原因を auth/network と断定しない（issue #621）');
  assert.ok(body.includes('CI ステータスを確定できなかった'), '確定できなかった旨を含む');
  assert.ok(body.includes('gh pr checks 12'), '実 PR 番号入りの gh pr checks 確認手順を含む');
});

test('buildTerminalSummaryBody: ci_pending -> ⏳ CI 未完了 見出しが出る', () => {
  const body = buildTerminalSummaryBody({
    pr: 13,
    status: 'ci_pending',
    iterations: 2,
    lastDecision: 'request-changes',
    lastSummary: 'checks pending',
    history: [],
  });
  assert.ok(body.includes('⏳ CI 未完了'), 'ci_pending 見出しを含む');
});

// --- 最終 CI 状態行（issue #703: 全終端で必ず出す） ------------------------------

const ALL_TERMINALS = ['lgtm', 'stuck', 'fix_failed', 'max_reached', 'ci_error', 'ci_pending', 'review_contract_error'];

test('buildTerminalSummaryBody: 全終端で **最終 CI 状態** 行が出る（ciLastStatus 未指定 = 未観測）', () => {
  for (const status of ALL_TERMINALS) {
    const body = buildTerminalSummaryBody({
      pr: 703,
      status,
      iterations: 1,
      lastDecision: 'request-changes',
      lastSummary: 'summary',
      history: [],
    });
    assert.ok(body.includes('**最終 CI 状態**: 未観測'), status + ': 未観測の最終 CI 状態行を含む');
    assert.ok(body.includes('gh pr checks 703'), status + ': 未観測のとき実 PR 番号入りの確認手順を含む');
  }
});

test('buildTerminalSummaryBody: ciLastStatus=failed のとき最終 CI 状態行に check 名を列挙する（全終端）', () => {
  for (const status of ALL_TERMINALS) {
    const body = buildTerminalSummaryBody({
      pr: 703,
      status,
      iterations: 2,
      lastDecision: 'request-changes',
      lastSummary: 'summary',
      history: [],
      ciLastStatus: 'failed',
      ciLastFailedChecks: ['bats', 'node-tests'],
    });
    const line = body.split('\n').find((l) => l.startsWith('**最終 CI 状態**'));
    assert.ok(line, status + ': 最終 CI 状態行を含む');
    assert.ok(line.includes('failed'), status + ': failed を含む');
    assert.ok(line.includes('`bats`') && line.includes('`node-tests`'), status + ': check 名を列挙する: ' + line);
  }
});

test('buildTerminalSummaryBody: ciLastStatus=failed で check 名が空なら「check 名不明」', () => {
  const body = buildTerminalSummaryBody({
    pr: 1, status: 'stuck', iterations: 1, lastDecision: 'request-changes', lastSummary: 's', history: [],
    ciLastStatus: 'failed', ciLastFailedChecks: [],
  });
  assert.ok(body.includes('**最終 CI 状態**: 🔴 failed — （check 名不明）'), 'check 名不明を明示する');
});

test('buildTerminalSummaryBody: ciLastStatus passed / pending / no_checks / error はそれぞれのラベルで出て check 名を列挙しない', () => {
  const expected = {
    passed: '✅ passed',
    pending: '⏳ pending',
    no_checks: 'no_checks（CI 未設定）',
    error: '⚠️ error',
  };
  for (const [ciLastStatus, label] of Object.entries(expected)) {
    const body = buildTerminalSummaryBody({
      pr: 9, status: 'lgtm', iterations: 1, lastDecision: 'approve', lastSummary: 'ok', history: [],
      ciLastStatus, ciLastFailedChecks: ['should-not-appear'],
    });
    const line = body.split('\n').find((l) => l.startsWith('**最終 CI 状態**'));
    assert.ok(line && line.includes(label), ciLastStatus + ': ラベルを含む: ' + line);
    assert.ok(!line.includes('should-not-appear'), ciLastStatus + ': failed 以外は check 名を列挙しない');
    assert.ok(!line.includes('未観測'), ciLastStatus + ': 観測済みなので未観測と言わない');
  }
  const errBody = buildTerminalSummaryBody({
    pr: 9, status: 'ci_error', iterations: 1, lastDecision: 'approve', lastSummary: 'ok', history: [], ciLastStatus: 'error',
  });
  assert.ok(errBody.includes('**最終 CI 状態**: ⚠️ error（ステータス取得失敗 — `gh pr checks 9`'), 'error は実 PR 番号入りの確認手順を含む');
});

test('buildTerminalSummaryBody: 末尾マーカーが /<!-- pr-iterate:(lgtm|stuck|fix_failed|max_reached|ci_error|ci_pending):\\d+ -->$/ で末尾一致・完全一致で含まれる (AC-3)', () => {
  for (const status of ['lgtm', 'stuck', 'fix_failed', 'max_reached', 'ci_error', 'ci_pending']) {
    const body = buildTerminalSummaryBody({
      pr: 55,
      status,
      iterations: 3,
      lastDecision: 'request-changes',
      lastSummary: 'summary',
      history: [],
    });
    assert.ok(
      /<!-- pr-iterate:(lgtm|stuck|fix_failed|max_reached|ci_error|ci_pending):\d+ -->$/.test(body),
      status + ': 末尾マーカーが正規表現に一致する',
    );
    assert.ok(
      body.includes(`<!-- pr-iterate:${status}:3 -->`),
      status + ': マーカーが完全一致で含まれる (AC-3)',
    );
  }
});

test('buildTerminalSummaryBody: history 3 round（うち 2 round に blocking 計 3 件）で "#### Iteration" 見出しが存在せず <details> が 1 個だけ・統合テーブルに 反復 列と 3 行が入る (AC-7)', () => {
  const body = buildTerminalSummaryBody({
    pr: 1,
    status: 'lgtm',
    iterations: 3,
    lastDecision: 'approve',
    lastSummary: 'done',
    history: [
      {
        iteration: 1,
        decision: 'request-changes',
        summary: 'needs work',
        blocking: [
          { severity: 'critical', description: 'first critical' },
          { severity: 'major', description: 'first major' },
        ],
      },
      {
        iteration: 2,
        decision: 'request-changes',
        summary: 'still issues',
        blocking: [
          { severity: 'critical', description: 'second critical' },
        ],
      },
      {
        iteration: 3,
        decision: 'approve',
        summary: 'looks good',
        blocking: [],
      },
    ],
  });
  assert.ok(!body.includes('#### Iteration'), '#### Iteration 見出しが存在しない');
  const detailsMatches = body.match(/<details>/g);
  assert.ok(detailsMatches && detailsMatches.length === 1, '<details> が 1 個だけ存在する');
  assert.ok(body.includes('| 反復 |'), '統合テーブルに 反復 列を含む');
  assert.ok(body.includes('first critical'), 'first critical が含まれる');
  assert.ok(body.includes('first major'), 'first major が含まれる');
  assert.ok(body.includes('second critical'), 'second critical が含まれる');
});

test('buildTerminalSummaryBody: <summary> 行の直後が空行であること', () => {
  const body = buildTerminalSummaryBody({
    pr: 1,
    status: 'stuck',
    iterations: 2,
    lastDecision: 'request-changes',
    lastSummary: 'stuck',
    history: [
      {
        iteration: 1,
        decision: 'request-changes',
        summary: 'issue',
        blocking: [{ severity: 'critical', description: 'some issue' }],
      },
    ],
  });
  const lines = body.split('\n');
  const summaryLineIdx = lines.findIndex((l) => l.includes('<summary>'));
  assert.ok(summaryLineIdx !== -1, '<summary> 行が存在する');
  assert.equal(lines[summaryLineIdx + 1], '', '<summary> 直後が空行');
});

test('buildTerminalSummaryBody: history 空 / blocking 全 0 で details ブロック自体が無い', () => {
  const body = buildTerminalSummaryBody({
    pr: 1,
    status: 'lgtm',
    iterations: 1,
    lastDecision: 'approve',
    lastSummary: 'all good',
    history: [],
  });
  assert.ok(!body.includes('<details>'), 'details ブロックが存在しない');
});

test('buildTerminalSummaryBody: blocking 全 0 の history でも details ブロックが無い', () => {
  const body = buildTerminalSummaryBody({
    pr: 1,
    status: 'lgtm',
    iterations: 2,
    lastDecision: 'approve',
    lastSummary: 'all good',
    history: [
      { iteration: 1, decision: 'request-changes', summary: 'minor', blocking: [] },
      { iteration: 2, decision: 'approve', summary: 'ok', blocking: [] },
    ],
  });
  assert.ok(!body.includes('<details>'), 'blocking 0 なら details ブロックが存在しない');
});

test('buildTerminalSummaryBody: 反復履歴 summary が 120 文字超で truncate + "…"', () => {
  const longSummary = 'x'.repeat(130);
  const body = buildTerminalSummaryBody({
    pr: 1,
    status: 'lgtm',
    iterations: 1,
    lastDecision: 'approve',
    lastSummary: 'done',
    history: [
      { iteration: 1, decision: 'approve', summary: longSummary, blocking: [] },
    ],
  });
  const truncated = 'x'.repeat(120) + '…';
  assert.ok(body.includes(truncated), '120 文字で truncate + … が入る');
  assert.ok(!body.includes('x'.repeat(130)), '130 文字のままでは含まれない');
});

test('buildTerminalSummaryBody: **最終判定理由** が出力に含まれる', () => {
  const body = buildTerminalSummaryBody({
    pr: 20,
    status: 'lgtm',
    iterations: 4,
    lastDecision: 'approve',
    lastSummary: 'all checks pass',
    history: [],
  });
  assert.ok(body.includes('**最終判定理由**: all checks pass'), 'lastSummary を含む');
});

test('buildTerminalSummaryBody: history セクションの反復履歴テーブルに各 round の decision が出る', () => {
  const body = buildTerminalSummaryBody({
    pr: 1,
    status: 'lgtm',
    iterations: 2,
    lastDecision: 'approve',
    lastSummary: 'done',
    history: [
      {
        iteration: 1,
        decision: 'request-changes',
        summary: 'needs work',
        blocking: [],
      },
      {
        iteration: 2,
        decision: 'approve',
        summary: 'looks good now',
        blocking: [],
      },
    ],
  });
  assert.ok(body.includes('変更要求'), 'iteration 1 decision');
  assert.ok(body.includes('承認'), 'iteration 2 decision');
  assert.ok(body.includes('needs work'), 'iteration 1 summary');
  assert.ok(body.includes('looks good now'), 'iteration 2 summary');
});

test('buildTerminalSummaryBody: 決定性（同入力 -> 同出力）', () => {
  const input = {
    pr: 77,
    status: 'lgtm',
    iterations: 2,
    lastDecision: 'approve',
    lastSummary: 'perfect',
    history: [
      {
        iteration: 1,
        decision: 'request-changes',
        summary: 'minor issues',
        blocking: [{ severity: 'major', description: 'style' }],
      },
      {
        iteration: 2,
        decision: 'approve',
        summary: 'fixed',
        blocking: [],
      },
    ],
  };
  const first = buildTerminalSummaryBody(input);
  const second = buildTerminalSummaryBody(input);
  assert.equal(first, second, '同入力 -> バイト完全一致');
});

// --- New tests: verification_evidence support ------------------------------------

// (1) buildTerminalSummaryBody with lastVerificationEvidence — snapshot pin
test('buildTerminalSummaryBody: lastVerificationEvidence を渡すと **検証根拠**: + 箇条書きが出る（スナップショット pin）', () => {
  const body = buildTerminalSummaryBody({
    pr: 10,
    status: 'lgtm',
    iterations: 2,
    lastDecision: 'approve',
    lastSummary: '問題なし',
    lastVerificationEvidence: ['根拠A', '根拠B'],
    history: [
      { iteration: 1, decision: 'request-changes', summary: 'issues', blocking: [] },
      { iteration: 2, decision: 'approve', summary: 'fixed', blocking: [] },
    ],
  });

  const expectedBody = [
    '## PR #10 — pr-iterate 終了レポート',
    '',
    '### 🎉 LGTM',
    '',
    '| 終了状態 | 反復回数 | 最終判定 |',
    '|---|---|---|',
    '| lgtm | 2 | ✅ 承認 (LGTM) |',
    '',
    '**最終判定理由**: 問題なし',
    '',
    '**最終 CI 状態**: 未観測（この run では CI を判定していない — `gh pr checks 10` で確認すること）',
    '',
    '**検証根拠**:',
    '- 根拠A',
    '- 根拠B',
    '',
    '### 反復履歴',
    '',
    '| 反復 | 判定 | 要修正 (blocking) | 軽微 (minor) | 総評 |',
    '|---|---|---|---|---|',
    '| 1 | 🔴 変更要求 | 0 | 0 | issues |',
    '| 2 | ✅ 承認 (LGTM) | 0 | 0 | fixed |',
    '',
    '---',
    '*このコメントは pr-iterate により自動生成されました。*',
    '<!-- pr-iterate:lgtm:2 -->',
  ].join('\n');

  assert.equal(body, expectedBody, 'スナップショット全文一致');
});

// (2) lastVerificationEvidence が undefined のとき現行出力と完全一致
test('buildTerminalSummaryBody: lastVerificationEvidence が undefined のとき **検証根拠** を含まない', () => {
  const withoutEvidence = buildTerminalSummaryBody({
    pr: 5,
    status: 'lgtm',
    iterations: 1,
    lastDecision: 'approve',
    lastSummary: 'done',
    history: [],
  });
  const withUndefined = buildTerminalSummaryBody({
    pr: 5,
    status: 'lgtm',
    iterations: 1,
    lastDecision: 'approve',
    lastSummary: 'done',
    lastVerificationEvidence: undefined,
    history: [],
  });
  assert.ok(!withoutEvidence.includes('**検証根拠**'), 'undefined 時: **検証根拠** を含まない');
  assert.equal(withoutEvidence, withUndefined, 'undefined 省略と undefined 明示で出力が完全一致');
});

// (3) lastVerificationEvidence が空配列 [] のとき (2) と同一
test('buildTerminalSummaryBody: lastVerificationEvidence が [] のとき **検証根拠** を含まない', () => {
  const withoutEvidence = buildTerminalSummaryBody({
    pr: 5,
    status: 'lgtm',
    iterations: 1,
    lastDecision: 'approve',
    lastSummary: 'done',
    history: [],
  });
  const withEmpty = buildTerminalSummaryBody({
    pr: 5,
    status: 'lgtm',
    iterations: 1,
    lastDecision: 'approve',
    lastSummary: 'done',
    lastVerificationEvidence: [],
    history: [],
  });
  assert.ok(!withEmpty.includes('**検証根拠**'), '空配列時: **検証根拠** を含まない');
  assert.equal(withoutEvidence, withEmpty, '省略と空配列で出力が完全一致');
});

// (4) history の round.summary が 120 文字超でテーブル truncation、evidence 非混入
test('buildTerminalSummaryBody: 長文 summary truncation + evidence がテーブル行に混入しない', () => {
  const longSummary = 'a'.repeat(130);
  const body = buildTerminalSummaryBody({
    pr: 7,
    status: 'lgtm',
    iterations: 1,
    lastDecision: 'approve',
    lastSummary: 'done',
    lastVerificationEvidence: ['evidence item X'],
    history: [
      { iteration: 1, decision: 'approve', summary: longSummary, blocking: [] },
    ],
  });
  const truncated = 'a'.repeat(120) + '…';
  assert.ok(body.includes(truncated), '120文字+… が反復履歴テーブルに出る');

  // テーブル行（`| <数字> |` で始まる行）に evidence 文字列が混入しないことを検証
  const tableRows = body.split('\n').filter(l => /^\| \d+ \|/.test(l));
  assert.ok(tableRows.length > 0, 'テーブル行が存在する');
  for (const row of tableRows) {
    assert.ok(!row.includes('evidence item X'), 'テーブル行に evidence が混入しない');
  }
});

// --- New tests: minor findings + review_contract_error status (issue #321, F2) ---------

// (4) STATUS_HEADLINE: review_contract_error
test('buildTerminalSummaryBody: review_contract_error -> ⚠️ REVIEW CONTRACT ERROR 見出しとマーカーが出る', () => {
  const body = buildTerminalSummaryBody({
    pr: 30,
    status: 'review_contract_error',
    iterations: 4,
    lastDecision: 'approve',
    lastSummary: 'decision と blocking が矛盾',
    history: [],
  });
  assert.ok(body.includes('⚠️ REVIEW CONTRACT ERROR'), 'review_contract_error 見出しを含む');
  assert.ok(body.includes('<!-- pr-iterate:review_contract_error:4 -->'), '終端マーカーに review_contract_error が出る');
});

// STATUS_HEADLINE: security_unresolved（issue #1063）と、反復履歴の security review の行
test('buildTerminalSummaryBody: security_unresolved -> SECURITY REVIEW 未収束の見出し、security review の round は「（security）」付きの行', () => {
  const body = buildTerminalSummaryBody({
    pr: 31,
    status: 'security_unresolved',
    iterations: 3,
    lastDecision: 'request-changes',
    lastSummary: '保存先の外へ書ける経路が残る',
    history: [
      { iteration: 3, decision: 'approve', summary: 'delta ok', blocking: [], minor: [], scope: 'delta' },
      { iteration: 3, decision: 'request-changes', summary: 'hardlink 経由で書ける', blocking: [{ severity: 'critical', topic: 'hardlink-write::a.sh', file: 'a.sh', description: 'd', suggestion: 's' }], minor: [], scope: 'security' },
    ],
  });
  assert.ok(body.includes('### ⚠️ SECURITY REVIEW 未収束'), body);
  assert.ok(body.includes('| 3 | ✅ 承認 (LGTM) | 0 | 0 | delta ok |'), body);
  assert.ok(body.includes('| 3（security） | 🔴 変更要求 | 1 | 0 | hardlink 経由で書ける |'), body);
});

// (5) buildTerminalSummaryBody: history に minor を持つ round -> 反復履歴テーブルに minor 件数列、全 minor 詳細 details が箇条書きで出る
test('buildTerminalSummaryBody: history の minor が反復履歴テーブルの minor 列と全 minor 詳細 details（箇条書き）に出る', () => {
  const body = buildTerminalSummaryBody({
    pr: 40,
    status: 'lgtm',
    iterations: 2,
    lastDecision: 'approve',
    lastSummary: 'done',
    history: [
      {
        iteration: 1,
        decision: 'comment',
        summary: 'minor only',
        blocking: [],
        minor: [
          { severity: 'minor', description: 'nit one' },
          { severity: 'minor', description: 'nit two' },
        ],
      },
      {
        iteration: 2,
        decision: 'approve',
        summary: 'looks good',
        blocking: [],
      },
    ],
  });
  assert.ok(body.includes('| 反復 | 判定 | 要修正 (blocking) | 軽微 (minor) | 総評 |'), '反復履歴テーブルヘッダが新レイアウトで出る');
  assert.ok(body.includes('| 1 | 💬 コメント | 0 | 2 | minor only |'), 'iteration 1 の minor 件数 2 が出る');
  assert.ok(body.includes('| 2 | ✅ 承認 (LGTM) | 0 | 0 | looks good |'), 'iteration 2 の minor 件数 0 が出る（キー無し）');
  assert.ok(body.includes('軽微な指摘（minor）の全詳細（自動修正対象外・2 件）'), '全 minor 詳細見出しが件数付きで出る');
  assert.ok(body.includes('1. 🟡 minor — 場所指定なし（反復 1 回目）'), '全 minor 詳細の見出し行に反復番号が付く');
  assert.ok(body.includes('nit one'), '全 minor 詳細に nit one が出る');
  assert.ok(body.includes('nit two'), '全 minor 詳細に nit two が出る');
});

// (6) history round に minor キーが無い場合も throw せず minor 列 0、details も出ない
test('buildTerminalSummaryBody: history 全 round に minor キーが無い場合 throw せず minor 列 0・全 minor 詳細 details は出ない', () => {
  const body = buildTerminalSummaryBody({
    pr: 41,
    status: 'lgtm',
    iterations: 1,
    lastDecision: 'approve',
    lastSummary: 'all good',
    history: [
      { iteration: 1, decision: 'approve', summary: 'ok', blocking: [] },
    ],
  });
  assert.ok(body.includes('| 1 | ✅ 承認 (LGTM) | 0 | 0 | ok |'), 'minor キー無しでも minor 列 0 で出る');
  assert.ok(!body.includes('軽微な指摘（minor）の全詳細'), 'minor 0 件なら全 minor 詳細 details は出ない');
});

// --- buildTerminalSummaryBody: ci wait telemetry (F2) ---------------------

test('buildTerminalSummaryBody: ciWaitSeconds/ciPollAttempts を渡すと **CI 待機** 行が出る', () => {
  const body = buildTerminalSummaryBody({
    pr: 55,
    status: 'ci_pending',
    iterations: 3,
    lastDecision: 'approve',
    lastSummary: 'CI 未完了',
    history: [],
    ciWaitSeconds: 90,
    ciPollAttempts: 6,
  });
  assert.ok(
    body.includes('**CI 待機**: 90秒（ポーリング 6 回）'),
    '**CI 待機** 行に累積秒数とポーリング回数が出る',
  );
});

test('buildTerminalSummaryBody: ciWaitSeconds/ciPollAttempts 省略時は **CI 待機** 行を含まない（回帰保証）', () => {
  const body = buildTerminalSummaryBody({
    pr: 56,
    status: 'lgtm',
    iterations: 1,
    lastDecision: 'approve',
    lastSummary: 'ok',
    history: [],
  });
  assert.ok(!body.includes('**CI 待機**'), 'ciWaitSeconds/ciPollAttempts 省略時は **CI 待機** 行を含まない');
});

// issue #793: worktree の外を指すとして fix から外した指摘は「人間側 follow-up」節に出る
test('buildTerminalSummaryBody: humanFollowups 非空なら人間側 follow-up 節（反復番号つき）を出し、空・省略なら byte 一致', () => {
  const opts = { pr: 5, status: 'lgtm', iterations: 1, lastDecision: 'approve', lastSummary: 'ok', history: [] };
  const body = buildTerminalSummaryBody({ ...opts, humanFollowups: [
    { iter: 1, severity: 'major', topic: 'out', file: '~/dotfiles/settings.json', description: '許可が無い', suggestion: '人間が足す' },
  ] });
  assert.ok(body.includes('### 👤 人間側 follow-up（worktree の外を指す指摘 — 自動修正の対象外・1 件）\n\n1. 🟠 major — `~/dotfiles/settings.json`（反復 1 回目）\n   - 指摘: 許可が無い\n   - 提案: 人間が足す'), body);
  assert.equal(buildTerminalSummaryBody({ ...opts, humanFollowups: [] }), buildTerminalSummaryBody(opts));
});

// --- dev-flow の HOLD 理由の回収状況（issue #930） -------------------------------

const PRIOR_URL = 'https://github.com/acme/skills/pull/5#issuecomment-1';
const UNRESOLVED = '❌ 未解消（pr-iterate は再判定しない — 人が確認する）';
const recoveryLines = (body) => {
  const lines = body.split('\n');
  const start = lines.indexOf('### dev-flow の HOLD 理由の回収状況');
  if (start < 0) return [];
  const out = [];
  for (const l of lines.slice(start + 2)) {
    if (!l.startsWith('- ')) break;
    out.push(l);
  }
  return out;
};
const headlineOf = (body) => body.split('\n').find((l) => l.startsWith('### '));

test('buildTerminalSummaryBody: #870 相当（HOLD codes=ac_human_pending + lgtm）は未解消 1 件で、見出しを「🎉 LGTM」にしない', () => {
  const body = buildTerminalSummaryBody({
    pr: 870, status: 'lgtm', iterations: 1, lastDecision: 'approve', lastSummary: 'ok', history: [], ciLastStatus: 'passed',
    priorDevflow: { tier: 'HOLD', codes: ['ac_human_pending'], url: PRIOR_URL },
  });
  assert.equal(headlineOf(body), '### LGTM（review）— dev-flow の HOLD 理由 1 件が未解消。merge 前に確認');
  assert.ok(!body.includes('🎉 LGTM'), body);
  assert.deepEqual(recoveryLines(body), [`- \`ac_human_pending\` — ${UNRESOLVED}`]);
  assert.ok(body.includes('**dev-flow の HOLD 理由 1 件が未解消** — merge 前に人が確認する'), body);
  // 冒頭（見出しより前）に元の dev-flow サマリーへのリンク
  assert.ok(body.indexOf(PRIOR_URL) >= 0 && body.indexOf(PRIOR_URL) < body.indexOf('### '), body);
});

test('buildTerminalSummaryBody: #918 相当（HOLD codes=iterate_non_lgtm,ci_checks_failed + lgtm + CI passed）はすべて解消と明記する', () => {
  const body = buildTerminalSummaryBody({
    pr: 918, status: 'lgtm', iterations: 2, lastDecision: 'approve', lastSummary: 'ok', history: [], ciLastStatus: 'passed',
    priorDevflow: { tier: 'HOLD', codes: ['iterate_non_lgtm', 'ci_checks_failed'], url: PRIOR_URL },
  });
  assert.equal(headlineOf(body), '### 🎉 LGTM — dev-flow の HOLD 理由はすべて解消');
  assert.deepEqual(recoveryLines(body), [
    '- `iterate_non_lgtm` — ✅ 解消 — この run の終了状態: lgtm',
    '- `ci_checks_failed` — ✅ 解消 — 最終 CI 状態: passed',
  ]);
  assert.ok(body.includes('**dev-flow の HOLD 理由はすべて解消**'), body);
});

test('buildTerminalSummaryBody: 回収状況の写像 — 条件を満たさない確認可能な code と、pr-iterate が再判定しない code は未解消', () => {
  const opts = { pr: 5, iterations: 3, lastDecision: 'request-changes', lastSummary: 'ng', history: [] };
  const prior = { tier: 'HOLD', codes: ['iterate_non_lgtm', 'ci_checks_failed', 'ac_ci_pending', 'mergeable_conflicting', 'escalate'], url: PRIOR_URL };
  const unresolved = buildTerminalSummaryBody({
    ...opts, status: 'stuck', ciLastStatus: 'failed', ciLastFailedChecks: ['Bats Tests'], priorDevflow: prior,
    conflictAutoresolve: [{ iteration: 1, status: 'aborted', reason: 'type C', files: [] }],
  });
  assert.deepEqual(recoveryLines(unresolved), [
    `- \`iterate_non_lgtm\` — ${UNRESOLVED} — この run の終了状態: stuck`,
    `- \`ci_checks_failed\` — ${UNRESOLVED} — 最終 CI 状態: failed`,
    `- \`ac_ci_pending\` — ${UNRESOLVED} — 最終 CI 状態: failed`,
    `- \`mergeable_conflicting\` — ${UNRESOLVED} — conflict の自動解消: aborted`,
    `- \`escalate\` — ${UNRESOLVED}`,
  ]);
  // 非 lgtm 終端の見出しは従来どおり
  assert.equal(headlineOf(unresolved), '### ⚠️ STUCK — 人間レビューへエスカレーション');

  const resolved = buildTerminalSummaryBody({
    ...opts, status: 'lgtm', ciLastStatus: 'passed', priorDevflow: { ...prior, codes: ['ac_ci_pending', 'mergeable_conflicting'] },
    conflictAutoresolve: [{ iteration: 1, status: 'resolved', files: [], merge_sha: 'a'.repeat(40) }],
  });
  assert.deepEqual(recoveryLines(resolved), [
    '- `ac_ci_pending` — ✅ 解消 — 最終 CI 状態: passed',
    '- `mergeable_conflicting` — ✅ 解消 — conflict の自動解消: resolved',
  ]);
});

test('buildTerminalSummaryBody: code の無い HOLD marker（codes 空）は理由を確かめられないので未解消 1 件', () => {
  const body = buildTerminalSummaryBody({
    pr: 5, status: 'lgtm', iterations: 1, lastDecision: 'approve', lastSummary: 'ok', history: [], ciLastStatus: 'passed',
    priorDevflow: { tier: 'HOLD', codes: [], url: PRIOR_URL },
  });
  assert.equal(headlineOf(body), '### LGTM（review）— dev-flow の HOLD 理由 1 件が未解消。merge 前に確認');
  assert.equal(recoveryLines(body).length, 1);
});

test('buildTerminalSummaryBody: priorDevflow が null・HOLD 以外なら終了レポートは priorDevflow 省略時と byte 一致', () => {
  const opts = { pr: 5, status: 'lgtm', iterations: 1, lastDecision: 'approve', lastSummary: 'ok', history: [], ciLastStatus: 'passed' };
  const base = buildTerminalSummaryBody(opts);
  assert.equal(buildTerminalSummaryBody({ ...opts, priorDevflow: null }), base);
  assert.equal(buildTerminalSummaryBody({ ...opts, priorDevflow: { tier: 'REVIEW', codes: [], url: PRIOR_URL } }), base);
  assert.equal(buildTerminalSummaryBody({ ...opts, priorDevflow: { tier: 'AUTO', codes: [], url: PRIOR_URL } }), base);
});
