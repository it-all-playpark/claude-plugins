import { test } from 'vitest';
import assert from 'node:assert/strict';
import { buildTerminalSummaryBody, buildRereviewNoticeBody, STATUS_HEADLINE } from './pr-comment-format.mjs';
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

test('buildTerminalSummaryBody: issue #1065 — 末尾マーカーに結論を出した head sha が head=<sha> で載り、40 桁 hex 以外は載せない', () => {
  const sha = 'ABCDEF0123456789abcdef0123456789ABCDEF01';
  const base = { pr: 55, status: 'lgtm', iterations: 2, lastDecision: 'approve', lastSummary: 'ok', history: [] };
  const body = buildTerminalSummaryBody({ ...base, headSha: sha });
  assert.equal(body.split('\n').at(-1), `<!-- pr-iterate:lgtm:2 head=${sha.toLowerCase()} -->`);
  for (const bad of [null, undefined, '', 'abc1234', 'z'.repeat(40)]) {
    const b = buildTerminalSummaryBody({ ...base, headSha: bad });
    assert.equal(b.split('\n').at(-1), '<!-- pr-iterate:lgtm:2 -->', `headSha=${JSON.stringify(bad)} は marker に head を載せない`);
  }
});

test('buildRereviewNoticeBody: issue #1065 — 今の head と、古いサマリーの URL の結論がこの head に当てはまらないことを書く', () => {
  const head = 'b'.repeat(40);
  const url = 'https://github.com/acme/skills/pull/5#issuecomment-2';
  const body = buildRereviewNoticeBody({ pr: 5, headSha: head, priorSummary: { source: 'pr-iterate', url, head_sha: 'a'.repeat(40) } });
  assert.ok(body.includes(`head \`${head}\` で再 review 中。${url} の結論`), body);
  assert.ok(body.includes('この head に当てはまらない'), body);
  assert.ok(body.includes(`head \`${'a'.repeat(40)}\` に対する結論`), '古いサマリーの head を書く');
  assert.ok(!/<!-- (dev-flow|pr-iterate):/.test(body), '終端サマリーの marker を持たない（次の prerun が終端サマリーと取り違えない）');

  const noHead = buildRereviewNoticeBody({ pr: 5, headSha: head, priorSummary: { source: 'dev-flow', url: null, head_sha: null } });
  assert.ok(noHead.includes('（URL 不明） の結論（dev-flow の終端サマリー・head の記録が無い結論）'), noHead);
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
    '**あなたが決めること**: review は LGTM。下の確かめることが済んだら `gh pr ready 10` して merge してよいか',
    '',
    '機械の確認（最終レビュー、CI、security review）: ✅ 確認済み 1 / ⚠️ 未検証 2 / ❌ 不合格 0',
    '',
    '### あなたが確かめること',
    '',
    '- ⚠️ CI: 未観測 — `gh pr checks 10` で確かめる',
    '- ⚠️ security review: この run の結果が無い — diff の security を確かめる',
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
    '| 反復 | 判定 | critical | major | minor | blocking の扱い | 総評 |',
    '|---|---|---|---|---|---|---|',
    '| 1 | 🔴 変更要求 | 0 | 0 | 0 | なし | issues |',
    '| 2 | ✅ 承認 (LGTM) | 0 | 0 | 0 | なし | fixed |',
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

// (4) STATUS_HEADLINE: review_contract_error（review が schema-retry 後も null のときだけの終端。issue #1283）
test('buildTerminalSummaryBody: review_contract_error -> StructuredOutput 契約違反だけを説明する見出しとマーカーが出る', () => {
  const body = buildTerminalSummaryBody({
    pr: 30,
    status: 'review_contract_error',
    iterations: 4,
    lastDecision: null,
    lastSummary: null,
    history: [],
  });
  assert.ok(
    body.includes('\n### ⚠️ REVIEW CONTRACT ERROR — reviewer が StructuredOutput 契約違反で結果を返さず（schema-retry 後も null）。人間へエスカレーション\n'),
    'review_contract_error 見出しの全文を含む',
  );
  assert.ok(body.includes('<!-- pr-iterate:review_contract_error:4 -->'), '終端マーカーに review_contract_error が出る');
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
  assert.ok(body.includes('| 反復 | 判定 | critical | major | minor | blocking の扱い | 総評 |'), '反復履歴テーブルヘッダが新レイアウトで出る');
  assert.ok(body.includes('| 1 | 💬 コメント | 0 | 0 | 2 | なし | minor only |'), 'iteration 1 の minor 件数 2 が出る');
  assert.ok(body.includes('| 2 | ✅ 承認 (LGTM) | 0 | 0 | 0 | なし | looks good |'), 'iteration 2 の minor 件数 0 が出る（キー無し）');
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
  assert.ok(body.includes('| 1 | ✅ 承認 (LGTM) | 0 | 0 | 0 | なし | ok |'), 'minor キー無しでも minor 列 0 で出る');
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
// 観測した head と終端 head（同じ head の観測を渡す既定の組）
const OBS_HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);
const ON_HEAD = { headSha: OBS_HEAD, ciLastHead: OBS_HEAD, ciVerifyHead: OBS_HEAD, securityReviewHead: OBS_HEAD };
const NOT_JUDGED = '❔ 未確認 — pr-iterate はこの code を判定しない — 人が確認する';
const UNRESOLVED_HUMAN = '❌ 未解消（人の判断が要る — pr-iterate は判定しない。dev-flow のサマリーの該当項目を確認する）';
const UNRESOLVED_FINAL_TEST = '❌ 未解消（HOLD は外さない — 下の事実で確認範囲を絞って人が確認する）';
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
  assert.deepEqual(recoveryLines(body), [`- \`ac_human_pending\` — ${UNRESOLVED_HUMAN}`]);
  assert.ok(body.includes('**dev-flow の HOLD 理由 1 件が未解消** — merge 前に人が確認する'), body);
  // 冒頭（見出しより前）に元の dev-flow サマリーへのリンク
  assert.ok(body.indexOf(PRIOR_URL) >= 0 && body.indexOf(PRIOR_URL) < body.indexOf('### '), body);
});

test('buildTerminalSummaryBody: #918 相当（HOLD codes=iterate_non_lgtm,ci_checks_failed + lgtm + CI passed）はすべて解消と明記する', () => {
  const body = buildTerminalSummaryBody({
    pr: 918, status: 'lgtm', iterations: 2, lastDecision: 'approve', lastSummary: 'ok', history: [], ciLastStatus: 'passed', ...ON_HEAD,
    priorDevflow: { tier: 'HOLD', codes: ['iterate_non_lgtm', 'ci_checks_failed'], url: PRIOR_URL },
  });
  assert.equal(headlineOf(body), '### 🎉 LGTM — dev-flow の HOLD 理由はすべて解消');
  assert.deepEqual(recoveryLines(body), [
    '- `iterate_non_lgtm` — ✅ 解消 — この run の終了状態: lgtm',
    '- `ci_checks_failed` — ✅ 解消 — 最終 CI 状態: passed',
  ]);
  assert.ok(body.includes('**dev-flow の HOLD 理由はすべて解消**'), body);
});

// 判定表の 1 code を 1 行だけ出した本文の行
const recoveryRow = (code, extra) => recoveryLines(buildTerminalSummaryBody({
  pr: 5, status: 'lgtm', iterations: 1, lastDecision: 'approve', lastSummary: 'ok', history: [],
  ...ON_HEAD, priorDevflow: { tier: 'HOLD', codes: [code], url: PRIOR_URL }, ...extra,
}))[0];
const sr = (status, extra = {}) => ({ target: status !== 'not_target', status, rounds: 1, critical: 0, major: 0, minor: 0, ...extra });
const mergeableAt = (state, head = OBS_HEAD) => ({ mergeableLast: { state, head } });

test('buildTerminalSummaryBody: 回収状況の判定表 — iterate_non_lgtm は lgtm で解消、ci_pending / ci_error で未確認、他の非 lgtm で未解消', () => {
  assert.equal(recoveryRow('iterate_non_lgtm', { status: 'lgtm' }), '- `iterate_non_lgtm` — ✅ 解消 — この run の終了状態: lgtm');
  for (const status of ['stuck', 'fix_failed', 'max_reached', 'review_contract_error', 'security_unresolved']) {
    assert.equal(recoveryRow('iterate_non_lgtm', { status }), `- \`iterate_non_lgtm\` — ❌ 未解消 — この run の終了状態: ${status}`);
  }
  for (const status of ['ci_pending', 'ci_error']) {
    assert.equal(recoveryRow('iterate_non_lgtm', { status }), `- \`iterate_non_lgtm\` — ❔ 未確認 — この run の終了状態: ${status} — CI の確定前に終わり、LGTM に届くか確かめられなかった`);
  }
});

test('buildTerminalSummaryBody: 回収状況の判定表 — ci_checks_failed は passed で解消、failed で未解消、pending / error / no_checks / null で未確認', () => {
  assert.equal(recoveryRow('ci_checks_failed', { ciLastStatus: 'passed' }), '- `ci_checks_failed` — ✅ 解消 — 最終 CI 状態: passed');
  assert.equal(recoveryRow('ci_checks_failed', { ciLastStatus: 'failed' }), '- `ci_checks_failed` — ❌ 未解消 — 最終 CI 状態: failed');
  assert.equal(recoveryRow('ci_checks_failed', { ciLastStatus: 'pending' }), '- `ci_checks_failed` — ❔ 未確認 — 最終 CI 状態: pending — check が完了していない');
  assert.equal(recoveryRow('ci_checks_failed', { ciLastStatus: 'error' }), '- `ci_checks_failed` — ❔ 未確認 — 最終 CI 状態: error — CI の状態を取得できなかった');
  assert.equal(recoveryRow('ci_checks_failed', { ciLastStatus: 'no_checks' }), '- `ci_checks_failed` — ❔ 未確認 — 最終 CI 状態: no_checks — check が 1 件も無く、失敗が直ったか確かめられない');
  assert.equal(recoveryRow('ci_checks_failed', { ciLastStatus: null }), '- `ci_checks_failed` — ❔ 未確認 — 最終 CI 状態: 未観測 — この run では CI を判定していない');
});

test('buildTerminalSummaryBody: 回収状況の判定表 — ac_ci_pending は ciLastStatus でなく ci_verify で決まる（passed で解消、failed で未解消、pending / error / 未実行で未確認）', () => {
  assert.equal(recoveryRow('ac_ci_pending', { ciVerifyStatus: 'passed', ciLastStatus: 'failed' }), '- `ac_ci_pending` — ✅ 解消 — ci_verify: passed');
  assert.equal(recoveryRow('ac_ci_pending', { ciVerifyStatus: 'failed', ciLastStatus: 'passed' }), '- `ac_ci_pending` — ❌ 未解消 — ci_verify: failed');
  assert.equal(recoveryRow('ac_ci_pending', { ciVerifyStatus: 'pending', ciLastStatus: 'passed' }), '- `ac_ci_pending` — ❔ 未確認 — ci_verify: pending — check が完了していない');
  assert.equal(recoveryRow('ac_ci_pending', { ciVerifyStatus: 'error', ciLastStatus: 'passed' }), '- `ac_ci_pending` — ❔ 未確認 — ci_verify: error — CI の状態を取得できなかった');
  assert.equal(recoveryRow('ac_ci_pending', { ciLastStatus: 'passed' }), '- `ac_ci_pending` — ❔ 未確認 — ci_verify: 未実行 — この run は ci_verify の check の完了を確かめていない');
});

test('buildTerminalSummaryBody: 回収状況の判定表 — mergeable_conflicting は conflict なしの観測か自動解消で解消、残る観測で未解消、未到達 / UNKNOWN / 取得失敗で未確認', () => {
  assert.equal(recoveryRow('mergeable_conflicting', mergeableAt('clean')), '- `mergeable_conflicting` — ✅ 解消 — conflict なしを観測');
  assert.equal(recoveryRow('mergeable_conflicting', {
    ...mergeableAt('resolved'), conflictAutoresolve: [{ iteration: 1, status: 'resolved', files: [], merge_sha: OBS_HEAD }],
  }), '- `mergeable_conflicting` — ✅ 解消 — conflict の自動解消: resolved');
  assert.equal(recoveryRow('mergeable_conflicting', {
    ...mergeableAt('conflicting'), conflictAutoresolve: [{ iteration: 1, status: 'aborted', reason: 'type C', files: [] }],
  }), '- `mergeable_conflicting` — ❌ 未解消 — conflict が残ると観測（conflict の自動解消: aborted）');
  assert.equal(recoveryRow('mergeable_conflicting', {}), '- `mergeable_conflicting` — ❔ 未確認 — conflict の確認に到達していない（conflict の自動解消: 試行なし）');
  assert.equal(recoveryRow('mergeable_conflicting', mergeableAt('unknown')), '- `mergeable_conflicting` — ❔ 未確認 — mergeable が UNKNOWN か取得失敗で、conflict の有無を確かめられない');
});

test('buildTerminalSummaryBody: 回収状況の判定表 — security_review_unresolved は cleared / not_target で解消、critical+major>0 で未解消、それ以外（review 前に止めた run を含む）で未確認', () => {
  const row = (securityReview, status = 'lgtm') => recoveryRow('security_review_unresolved', { status, securityReview });
  assert.equal(row(sr('cleared')), '- `security_review_unresolved` — ✅ 解消 — この run の security review: cleared');
  assert.equal(row(sr('not_target')), '- `security_review_unresolved` — ✅ 解消 — この run の security review: not_target');
  // 終端 status に依らない（LGTM に届かないことは iterate_non_lgtm が扱う）
  assert.equal(row(sr('cleared'), 'stuck'), '- `security_review_unresolved` — ✅ 解消 — この run の security review: cleared');
  assert.equal(row(sr('unresolved', { critical: 1, major: 2 }), 'security_unresolved'), '- `security_review_unresolved` — ❌ 未解消 — この run の security review: unresolved — critical 1 / major 2');
  assert.equal(row(sr('unresolved', { major: 1 }), 'security_unresolved'), '- `security_review_unresolved` — ❌ 未解消 — この run の security review: unresolved — critical 0 / major 1');
  assert.equal(row(sr('not_run'), 'max_reached'), '- `security_review_unresolved` — ❔ 未確認 — この run の security review: not_run — 終端 head の review に到達していない');
  assert.equal(row(null), '- `security_review_unresolved` — ❔ 未確認 — この run の security review: 未実施 — 終端 head の review に到達していない');
  // review 前に止めた run は前の round の件数が残っていても未解消にしない
  assert.equal(row(sr('unresolved', { stop_reason: 'reviewer_context_changed', critical: 1 }), 'security_unresolved'), '- `security_review_unresolved` — ❔ 未確認 — この run の security review: unresolved — review の前に止めた（reviewer_context_changed）');
  assert.equal(row(sr('unresolved'), 'security_unresolved'), '- `security_review_unresolved` — ❔ 未確認 — この run の security review: unresolved — review の結果を確かめられなかった');
});

test('buildTerminalSummaryBody: 判定表の観測は head と組で扱い、終端 head と違う・head が不明な観測は値に関わらず未確認', () => {
  const stale = (what) => `${what} — head \`aaaaaaa\` の観測で、終端 head \`bbbbbbb\` では確かめていない`;
  const unknown = (what) => `${what} — 観測した head が終端 head と同じか確かめられない`;
  for (const [code, value, what] of [
    ['ci_checks_failed', { ciLastStatus: 'passed' }, '最終 CI 状態: passed'],
    ['ci_checks_failed', { ciLastStatus: 'failed' }, '最終 CI 状態: failed'],
    ['ac_ci_pending', { ciVerifyStatus: 'passed' }, 'ci_verify: passed'],
    ['ac_ci_pending', { ciVerifyStatus: 'failed' }, 'ci_verify: failed'],
    ['mergeable_conflicting', mergeableAt('clean'), 'conflict の確認: clean'],
    ['mergeable_conflicting', mergeableAt('conflicting'), 'conflict の確認: conflicting'],
    ['mergeable_conflicting', mergeableAt('resolved'), 'conflict の確認: resolved'],
    ['security_review_unresolved', { securityReview: sr('cleared') }, 'この run の security review: cleared'],
    ['security_review_unresolved', { securityReview: sr('not_target') }, 'この run の security review: not_target'],
    ['security_review_unresolved', { securityReview: sr('unresolved', { critical: 1 }) }, 'この run の security review: unresolved'],
  ]) {
    assert.ok(!recoveryRow(code, value).includes('未確認'), `${what}: 同じ head の観測は解消か未解消`);
    assert.equal(recoveryRow(code, { ...value, headSha: OTHER_HEAD }), `- \`${code}\` — ❔ 未確認 — ${stale(what)}`, `${what}: 古い head の観測`);
    // 大文字小文字の違いは同じ head
    assert.ok(!recoveryRow(code, { ...value, headSha: OBS_HEAD.toUpperCase() }).includes('未確認'), `${what}: 大文字の head`);
    // fix が head を動かしたか確かめられなかった run（endHead: null）。marker の head は残る
    const unsettled = buildTerminalSummaryBody({
      pr: 5, status: 'fix_failed', iterations: 1, lastDecision: 'approve', lastSummary: 'ok', history: [],
      ...ON_HEAD, endHead: null, priorDevflow: { tier: 'HOLD', codes: [code], url: PRIOR_URL }, ...value,
    });
    assert.deepEqual(recoveryLines(unsettled), [`- \`${code}\` — ❔ 未確認 — ${unknown(what)}`], `${what}: 終端 head 不明`);
    assert.ok(unsettled.endsWith(`<!-- pr-iterate:fix_failed:1 head=${OBS_HEAD} -->`), 'marker の形式と head は変わらない');
  }
  assert.equal(recoveryRow('ci_checks_failed', { ciLastStatus: 'passed', ciLastHead: null }), `- \`ci_checks_failed\` — ❔ 未確認 — ${unknown('最終 CI 状態: passed')}`);
  assert.equal(recoveryRow('mergeable_conflicting', mergeableAt('clean', null)), `- \`mergeable_conflicting\` — ❔ 未確認 — ${unknown('conflict の確認: clean')}`);
});

test('buildTerminalSummaryBody: 古い head の観測なら **最終 CI 状態** の行にそう出す（終端 head と同じ観測・未観測の行は変えない）', () => {
  const ciLine = (extra) => buildTerminalSummaryBody({
    pr: 5, status: 'max_reached', iterations: 1, lastDecision: 'approve', lastSummary: 'ok', history: [], ...ON_HEAD, ...extra,
  }).split('\n').find((l) => l.startsWith('**最終 CI 状態**'));
  assert.equal(ciLine({ ciLastStatus: 'passed' }), '**最終 CI 状態**: ✅ passed');
  assert.equal(ciLine({ ciLastStatus: 'passed', headSha: OTHER_HEAD }), '**最終 CI 状態**: ✅ passed — ⚠️ 古い head `aaaaaaa` の観測（終端 head `bbbbbbb` の CI は確かめていない — `gh pr checks 5` で確認すること）');
  assert.equal(ciLine({ ciLastStatus: 'failed', ciLastFailedChecks: ['bats'], headSha: OTHER_HEAD }), '**最終 CI 状態**: 🔴 failed — `bats` — ⚠️ 古い head `aaaaaaa` の観測（終端 head `bbbbbbb` の CI は確かめていない — `gh pr checks 5` で確認すること）');
  assert.equal(ciLine({ ciLastStatus: 'passed', endHead: null }), '**最終 CI 状態**: ✅ passed — ⚠️ 観測した head が終端 head と同じか確かめられない（`gh pr checks 5` で確認すること）');
  assert.ok(ciLine({ ciLastStatus: null, headSha: OTHER_HEAD }).startsWith('**最終 CI 状態**: 未観測'));
});

test('buildTerminalSummaryBody: 未確認の行は ❌ を付けず、集計は未解消と未確認の件数を分け、未確認だけなら「未解消」の語を出さない', () => {
  const opts = { pr: 5, iterations: 1, lastDecision: 'approve', lastSummary: 'ok', history: [], ...ON_HEAD };
  const onlyUnconfirmed = buildTerminalSummaryBody({
    ...opts, status: 'ci_pending', ciLastStatus: 'pending',
    priorDevflow: { tier: 'HOLD', codes: ['iterate_non_lgtm', 'ci_checks_failed', 'mergeable_conflicting', 'ac_ci_pending', 'security_review_unresolved', 'danger_unresolved'], url: PRIOR_URL },
  });
  for (const row of recoveryLines(onlyUnconfirmed)) {
    assert.ok(row.includes('未確認') && !row.includes('❌'), row);
    assert.ok(row.split(' — ').length >= 3, `何を確かめられなかったかを載せる: ${row}`);
  }
  assert.ok(onlyUnconfirmed.includes('**dev-flow の HOLD 理由 6 件が未確認** — merge 前に人が確認する'), onlyUnconfirmed);
  assert.ok(!onlyUnconfirmed.includes('未解消'), onlyUnconfirmed);
  assert.ok(!onlyUnconfirmed.includes('すべて解消'), onlyUnconfirmed);

  const mixed = buildTerminalSummaryBody({
    ...opts, status: 'stuck', ciLastStatus: 'failed',
    priorDevflow: { tier: 'HOLD', codes: ['ci_checks_failed', 'iterate_non_lgtm', 'danger_unresolved'], url: PRIOR_URL },
  });
  assert.ok(mixed.includes('**dev-flow の HOLD 理由 2 件が未解消・1 件が未確認** — merge 前に人が確認する'), mixed);

  const onlyUnresolved = buildTerminalSummaryBody({
    ...opts, status: 'stuck', ciLastStatus: 'failed', priorDevflow: { tier: 'HOLD', codes: ['ci_checks_failed'], url: PRIOR_URL },
  });
  assert.ok(onlyUnresolved.includes('**dev-flow の HOLD 理由 1 件が未解消** — merge 前に人が確認する'), onlyUnresolved);
  assert.ok(!onlyUnresolved.includes('未確認'), onlyUnresolved);
  // 非 lgtm 終端の見出しは回収状況で変えない
  assert.equal(headlineOf(onlyUnresolved), '### ⚠️ STUCK — 人間レビューへエスカレーション');
});

test('buildTerminalSummaryBody: 未確認が 1 件でもある lgtm は「すべて解消」とも「🎉 LGTM」とも出さず、見出しに件数を分けて出す', () => {
  const opts = { pr: 5, status: 'lgtm', iterations: 1, lastDecision: 'approve', lastSummary: 'ok', history: [], ciLastStatus: 'passed', ...ON_HEAD };
  const unconfirmed = buildTerminalSummaryBody({ ...opts, priorDevflow: { tier: 'HOLD', codes: ['iterate_non_lgtm', 'ac_ci_pending'], url: PRIOR_URL } });
  assert.equal(headlineOf(unconfirmed), '### LGTM（review）— dev-flow の HOLD 理由 1 件が未確認。merge 前に確認');
  assert.ok(!unconfirmed.includes('🎉 LGTM'), unconfirmed);
  assert.ok(!unconfirmed.includes('すべて解消'), unconfirmed);
  assert.ok(!unconfirmed.includes('未解消'), unconfirmed);

  const both = buildTerminalSummaryBody({ ...opts, priorDevflow: { tier: 'HOLD', codes: ['escalate', 'ac_ci_pending'], url: PRIOR_URL } });
  assert.equal(headlineOf(both), '### LGTM（review）— dev-flow の HOLD 理由 1 件が未解消・1 件が未確認。merge 前に確認');
  assert.ok(!both.includes('🎉 LGTM'), both);
});

test('buildTerminalSummaryBody: ci_pending / ci_error の終了レポートは HOLD の有無に関わらず再実行の案内を PR 番号入りで載せ、他の status では載せない', () => {
  const opts = { pr: 77, iterations: 1, lastDecision: 'approve', lastSummary: 'ok', history: [] };
  const guide = '**次の手順**: CI の確定後に `/pr-iterate 77` を再実行すると判定が確定する';
  for (const status of ['ci_pending', 'ci_error']) {
    for (const priorDevflow of [null, { tier: 'REVIEW', codes: [], url: PRIOR_URL }, { tier: 'HOLD', codes: ['ci_checks_failed'], url: PRIOR_URL }]) {
      assert.ok(buildTerminalSummaryBody({ ...opts, status, priorDevflow }).split('\n').includes(guide), `${status} / ${JSON.stringify(priorDevflow)}`);
    }
  }
  for (const status of ['lgtm', 'stuck', 'fix_failed', 'max_reached', 'review_contract_error', 'security_unresolved']) {
    assert.ok(!buildTerminalSummaryBody({ ...opts, status }).includes('/pr-iterate 77'), status);
  }
  // blocking 付きの round で security review が終端した run（lastDecision が approve でない）
  const unreviewed = buildTerminalSummaryBody({ ...opts, status: 'security_unresolved', lastDecision: 'request-changes' });
  assert.ok(!unreviewed.includes('/pr-iterate 77'), unreviewed);
  assert.ok(card1359(unreviewed).checks.includes('- ⚠️ 最終レビュー: blocking の指摘を fix に回したが再レビューしていない（security review で終了）— 最後の反復の指摘と修正の diff を確かめる'), unreviewed);
});

test('buildTerminalSummaryBody: 「pr-iterate は判定しない」の文言はこの run が判定しない code の行にだけ出る', () => {
  const body = buildTerminalSummaryBody({
    pr: 5, status: 'stuck', iterations: 1, lastDecision: 'approve', lastSummary: 'ok', history: [], ciLastStatus: 'failed', ...ON_HEAD, ...mergeableAt('conflicting'),
    securityReview: sr('unresolved', { critical: 1 }), ciVerifyStatus: 'failed',
    priorDevflow: { tier: 'HOLD', codes: ['iterate_non_lgtm', 'ci_checks_failed', 'ac_ci_pending', 'mergeable_conflicting', 'security_review_unresolved', 'danger_unresolved', 'escalate', 'ac_human_pending'], url: PRIOR_URL },
  });
  const rows = recoveryLines(body);
  const judged = rows.filter((l) => l.includes('判定しない')).map((l) => l.split(' — ')[0]);
  assert.deepEqual(judged, ['- `danger_unresolved`', '- `escalate`', '- `ac_human_pending`']);
  assert.ok(!body.includes('再判定しない'), body);
  // 判定した code の未解消・未確認の行にも、判定表の未確認の行にも出ない
  for (const extra of [{ ciLastStatus: 'pending' }, { ciLastStatus: 'passed', headSha: OTHER_HEAD }]) {
    assert.ok(!recoveryRow('ci_checks_failed', extra).includes('判定しない'), JSON.stringify(extra));
  }
  assert.ok(!recoveryRow('mergeable_conflicting', {}).includes('判定しない'));
  assert.ok(!recoveryRow('security_review_unresolved', { securityReview: sr('not_run') }).includes('判定しない'));
  assert.ok(!recoveryRow('ac_ci_pending', {}).includes('判定しない'));
});

test('buildTerminalSummaryBody: security review の行は件数だけを出す（対象外 / clear / 未完了）', () => {
  const opts = { pr: 5, iterations: 2, lastDecision: 'approve', lastSummary: 'ok', history: [], ciLastStatus: 'passed' };
  const line = (status, securityReview) => buildTerminalSummaryBody({ ...opts, status, securityReview }).split('\n').find((l) => l.startsWith('**Security review**'));
  assert.equal(line('lgtm', { target: false, status: 'not_target', rounds: 0 }), '**Security review**: 対象外（変更が許可リスト — 指示ファイルでない文書・テスト — だけ）');
  assert.equal(line('lgtm', { target: true, status: 'cleared', rounds: 2, critical: 0, major: 0, minor: 1 }), '**Security review**: ✅ clear（敵対的 review 2 回・最終 critical 0 / major 0 / minor 1）');
  assert.equal(line('max_reached', { target: true, status: 'unresolved', rounds: 3, critical: 1, major: 2, minor: 0 }), '**Security review**: ❌ 未完了（敵対的 review 3 回・最終 critical 1 / major 2 / minor 0）— 指摘の本文は公開コメントに載せない。merge 前に人が diff を確認する');
  // fix が直さずに人の判断に返した指摘は件数だけを出す（issue #1121）
  assert.equal(line('security_unresolved', { target: true, status: 'unresolved', rounds: 1, critical: 2, major: 0, minor: 0, deferred: 2 }), '**Security review**: ❌ 未完了（敵対的 review 1 回・最終 critical 2 / major 0 / minor 0）— security の指摘 2 件を fix が直さずに人の判断に返した。指摘の本文は公開コメントに載せない。merge 前に人が diff を確認する');
  assert.equal(line('max_reached', { target: true, status: 'unresolved', rounds: 3, critical: 1, major: 2, minor: 0, deferred: 0 }), line('max_reached', { target: true, status: 'unresolved', rounds: 3, critical: 1, major: 2, minor: 0 }), 'deferred 0 は件数を出さない');
  assert.equal(line('lgtm', null), undefined, 'securityReview が無ければ行を出さない');
  assert.equal(buildTerminalSummaryBody({ ...opts, status: 'security_unresolved', securityReview: { target: true, status: 'unresolved', rounds: 1 } }).split('\n').find((l) => l.startsWith('### ')), '### 🛡️ SECURITY REVIEW 未完了 — 敵対的 security review が今の head で clear にならなかった。人間へエスカレーション');
});

test('buildTerminalSummaryBody: stop_reason=reviewer_context_changed は見出しと Security review 行を「自動 review をしていない」に出し分け、それ以外は従来の文面', () => {
  const opts = { pr: 5, iterations: 1, lastDecision: 'approve', lastSummary: 'ok', history: [], ciLastStatus: 'passed' };
  const parts = (securityReview) => {
    const body = buildTerminalSummaryBody({ ...opts, status: 'security_unresolved', securityReview });
    return { body, headline: body.split('\n').find((l) => l.startsWith('### ')), line: body.split('\n').find((l) => l.startsWith('**Security review**')) };
  };
  const changed = parts({ target: true, status: 'unresolved', stop_reason: 'reviewer_context_changed', rounds: 0, critical: 0, major: 0, minor: 0 });
  assert.equal(changed.headline, '### 🛡️ SECURITY REVIEW 未実施 — 指示ファイルを変える PR なので自動 review をしていない（review 0 回）。変わった指示ファイルを人が確認する');
  assert.equal(changed.line, '**Security review**: ⏸️ 自動 review をしていない（指示ファイルを変える PR — security-reviewer に読み込まれる CLAUDE.md / AGENTS.md / repo 直下の .claude/ 等を変えるので自動の review では clear にしない・review 0 回）— merge 前に人が変わった指示ファイルと diff を確認する');
  for (const want of ['自動 review をしていない', '指示ファイルを変える PR', 'review 0 回']) assert.ok(changed.headline.includes(want) && changed.line.includes(want), want);
  assert.ok(!changed.body.includes('clear にならなかった'), changed.body);
  assert.ok(!changed.body.includes('未完了'), '「未完了」（指摘が残ったように読める）を出さない');

  // review を実行して critical / major が残った・review 前の別の前提チェックで止めた run は従来の文面
  for (const sr of [
    { target: true, status: 'unresolved', stop_reason: null, rounds: 2, critical: 1, major: 1, minor: 0 },
    { target: true, status: 'unresolved', stop_reason: 'diff_unavailable', rounds: 0, critical: 0, major: 0, minor: 0 },
  ]) {
    const other = parts(sr);
    assert.equal(other.headline, '### 🛡️ SECURITY REVIEW 未完了 — 敵対的 security review が今の head で clear にならなかった。人間へエスカレーション', sr.stop_reason);
    assert.equal(other.line, `**Security review**: ❌ 未完了（敵対的 review ${sr.rounds} 回・最終 critical ${sr.critical} / major ${sr.major} / minor 0）— 指摘の本文は公開コメントに載せない。merge 前に人が diff を確認する`, sr.stop_reason);
  }
});

test('buildTerminalSummaryBody: stop_reason=reviewer_context_changed のときだけ `security-review-isolated <PR>` の実行案内を出す（値は PR 番号だけ・API に通信できるシェル・gate に戻らない）', () => {
  const opts = { iterations: 1, lastDecision: 'approve', lastSummary: 'ok', history: [], ciLastStatus: 'passed' };
  const guideOf = (pr, status, securityReview) => buildTerminalSummaryBody({ ...opts, pr, status, securityReview })
    .split('\n').filter((l) => l.includes('security-review-isolated'));
  const changed = { target: true, status: 'unresolved', stop_reason: 'reviewer_context_changed', rounds: 0, critical: 0, major: 0, minor: 0 };
  const guide = guideOf(5, 'security_unresolved', changed);
  assert.deepEqual(guide, ['**隔離した security review**: Anthropic API に通信できるシェル（plugin の bin/ が PATH に載る Claude Code のセッション等）で `security-review-isolated 5` を実行すると、PR の worktree に入らない別プロセスで security-reviewer が PR の diff を review し、判定・件数・指摘を端末に出す。結果は gate に戻らない（Merge tier は HOLD のまま）— merge 判断の材料にする']);
  for (const want of ['Anthropic API に通信できるシェル', 'plugin の bin/ が PATH に載る Claude Code のセッション', 'gate に戻らない', 'merge 判断の材料']) assert.ok(guide[0].includes(want), want);
  // 差し込む値は PR 番号だけ（PR 番号を変えるとコマンドの引数だけが変わる）
  assert.deepEqual(guideOf(77, 'security_unresolved', changed), [guide[0].replace('`security-review-isolated 5`', '`security-review-isolated 77`')]);

  // reviewer_context_changed 以外（review して残った・別の前提で止めた・clear・対象外・null）では出さない
  for (const [status, sr] of [
    ['security_unresolved', { ...changed, stop_reason: null, rounds: 2, critical: 1 }],
    ['security_unresolved', { ...changed, stop_reason: 'diff_unavailable' }],
    ['lgtm', { target: true, status: 'cleared', stop_reason: null, rounds: 1, critical: 0, major: 0, minor: 0 }],
    ['lgtm', { target: false, status: 'not_target', stop_reason: 'reviewer_context_changed', rounds: 0 }],
    ['lgtm', null],
  ]) {
    assert.deepEqual(guideOf(5, status, sr), [], JSON.stringify(sr));
  }
});

test('buildTerminalSummaryBody: code の無い HOLD marker（codes 空）は理由を確かめられないので未確認 1 件', () => {
  const body = buildTerminalSummaryBody({
    pr: 5, status: 'lgtm', iterations: 1, lastDecision: 'approve', lastSummary: 'ok', history: [], ciLastStatus: 'passed',
    priorDevflow: { tier: 'HOLD', codes: [], url: PRIOR_URL },
  });
  assert.equal(headlineOf(body), '### LGTM（review）— dev-flow の HOLD 理由 1 件が未確認。merge 前に確認');
  assert.deepEqual(recoveryLines(body), ['- ❔ 未確認 — HOLD 理由の code がサマリーに無い — 元のサマリーで理由を確認する']);
});

test('buildTerminalSummaryBody: priorDevflow が null・HOLD 以外なら終了レポートは priorDevflow 省略時と byte 一致', () => {
  const opts = { pr: 5, status: 'lgtm', iterations: 1, lastDecision: 'approve', lastSummary: 'ok', history: [], ciLastStatus: 'passed' };
  const base = buildTerminalSummaryBody(opts);
  assert.equal(buildTerminalSummaryBody({ ...opts, priorDevflow: null }), base);
  assert.equal(buildTerminalSummaryBody({ ...opts, priorDevflow: { tier: 'REVIEW', codes: [], url: PRIOR_URL } }), base);
});

// --- final_test_red の確認範囲と未解消の文言の出し分け（issue #1180） ---------------------

const HOLD_HEAD = '1'.repeat(40);
const END_HEAD = '2'.repeat(40);
// 回収状況の節の行（code の行と、その下の事実の行）
const recoverySection = (body) => {
  const lines = body.split('\n');
  const start = lines.indexOf('### dev-flow の HOLD 理由の回収状況');
  if (start < 0) return [];
  const out = [];
  for (const l of lines.slice(start + 2)) {
    if (!l.startsWith('- ') && !l.startsWith('  - ')) break;
    out.push(l);
  }
  return out;
};
const finalTestBody = (finalTestCheck, extra = {}) => buildTerminalSummaryBody({
  pr: 5, status: 'lgtm', iterations: 1, lastDecision: 'approve', lastSummary: 'ok', history: [], ciLastStatus: 'passed', ciLastHead: END_HEAD, headSha: END_HEAD,
  priorDevflow: { tier: 'HOLD', codes: ['final_test_red'], url: PRIOR_URL, head_sha: HOLD_HEAD }, finalTestCheck, ...extra,
});
const ranCheck = (changes, tests) => ({ ran: true, holdHead: HOLD_HEAD, endHead: END_HEAD, changes, tests });
const PASSED = { tests: 'passed', green: true, summary: 'ok', failed_files: [] };
const FINAL_TEST_ROW = `- \`final_test_red\` — ${UNRESOLVED_FINAL_TEST}`;
const HEADS_FACT = '  - HOLD 時の head `1111111` → 終端 head `2222222`';
const CHANGES_FACT = '  - テスト関連の変更（テストとテストの実行を変えうる設定）: ';
const RUN_FACT = '  - 最終 tree の全件テスト（run-tests 1 回）: ';

test('buildTerminalSummaryBody: final_test_red の行は変更の有無（なし / あり + git diff コマンド / 不明）と最終 tree の全件テストの結果を出し、どれでも未解消', () => {
  const cases = [
    [ranCheck({ status: 'none', files: [] }, PASSED), [`${CHANGES_FACT}なし`, `${RUN_FACT}passed`]],
    [ranCheck({ status: 'changed', files: ['tests/a.test.js', 'package.json'] }, PASSED), [
      `${CHANGES_FACT}あり 2 件 — \`tests/a.test.js\` / \`package.json\``,
      `  - その diff: \`git diff ${HOLD_HEAD}..${END_HEAD} -- tests/a.test.js package.json\``,
      `${RUN_FACT}passed`,
    ]],
    // シェルや Markdown で意味を持つ文字を含む名前が 1 件でもあればコマンドは出さない。backtick を含む名前は code span に入れない
    [ranCheck({ status: 'changed', files: ['tests/a|b.test.js', 'package.json', "tests/a`';touch pwn;'`b.bats"] }, PASSED), [
      `${CHANGES_FACT}あり 3 件 — \`tests/a\\|b.test.js\` / \`package.json\` / tests/a\\\`';touch pwn;'\\\`b.bats`,
      '  - その diff: シェルに貼れないファイル名を含むのでコマンドは出さない — PR 全体の diff を確認する',
      `${RUN_FACT}passed`,
    ]],
    [ranCheck({ status: 'unknown', files: [] }, PASSED), [
      `${CHANGES_FACT}不明（変更ファイル一覧を取れなかったか、HOLD 時の head が終端 head の祖先でない — PR 全体の diff を確認する）`,
      `${RUN_FACT}passed`,
    ]],
    [ranCheck({ status: 'none', files: [] }, { tests: 'failed', green: false, failed_files: ['tests/x.bats', 'src/a|b.test.ts'] }), [
      `${CHANGES_FACT}なし`, `${RUN_FACT}failed — 失敗ファイル: \`tests/x.bats\` / \`src/a\\|b.test.ts\``,
    ]],
    [ranCheck({ status: 'none', files: [] }, { tests: 'failed', green: false, failed_files: [] }), [
      `${CHANGES_FACT}なし`, `${RUN_FACT}failed — 失敗ファイル: 不明（ファイルに結び付かない失敗）`,
    ]],
    [ranCheck({ status: 'none', files: [] }, { tests: 'no_tests', green: false }), [`${CHANGES_FACT}なし`, `${RUN_FACT}no_tests（実行対象のテストが無い）`]],
    [ranCheck({ status: 'none', files: [] }, { tests: 'error', green: false }), [`${CHANGES_FACT}なし`, `${RUN_FACT}実行できなかった`]],
    [ranCheck({ status: 'none', files: [] }, null), [`${CHANGES_FACT}なし`, `${RUN_FACT}実行できなかった`]],
  ];
  for (const [check, facts] of cases) {
    const body = finalTestBody(check);
    assert.deepEqual(recoverySection(body), [FINAL_TEST_ROW, HEADS_FACT, ...facts], JSON.stringify(check));
    assert.equal(headlineOf(body), '### LGTM（review）— dev-flow の HOLD 理由 1 件が未解消。merge 前に確認', JSON.stringify(check));
    assert.ok(body.includes('**dev-flow の HOLD 理由 1 件が未解消** — merge 前に人が確認する'), JSON.stringify(check));
  }
});

test('buildTerminalSummaryBody: final_test_red の事実を取らなかった run は理由（HOLD 時と同じ head / head 不明）を出し、未解消', () => {
  for (const [check, fact] of [
    [{ ran: false, reason: 'same_head', holdHead: HOLD_HEAD }, '  - 変更ファイルと最終 tree の全件テストは取っていない: HOLD 時と同じ head（`1111111`）で終わった — HOLD 時のテスト結果がそのまま当てはまる'],
    [{ ran: false, reason: 'hold_head_unknown' }, '  - 変更ファイルと最終 tree の全件テストは取っていない: HOLD 時の head 不明（dev-flow のサマリーの marker に head が無い）'],
    [{ ran: false, reason: 'end_head_unknown', holdHead: HOLD_HEAD }, '  - 変更ファイルと最終 tree の全件テストは取っていない: 終端 head 不明'],
  ]) {
    const body = finalTestBody(check);
    assert.deepEqual(recoverySection(body), [FINAL_TEST_ROW, fact], check.reason);
    assert.equal(headlineOf(body), '### LGTM（review）— dev-flow の HOLD 理由 1 件が未解消。merge 前に確認', check.reason);
  }
});

test('buildTerminalSummaryBody: テスト関連の変更なし・全件 green・終端 CI passed でも final_test_red は未解消で、見出しは「HOLD 理由 N 件が未解消」のまま', () => {
  const body = finalTestBody(ranCheck({ status: 'none', files: [] }, PASSED), { ciLastStatus: 'passed' });
  assert.equal(headlineOf(body), '### LGTM（review）— dev-flow の HOLD 理由 1 件が未解消。merge 前に確認');
  assert.ok(body.includes('**dev-flow の HOLD 理由 1 件が未解消** — merge 前に人が確認する'), body);
  assert.ok(!body.includes('🎉 LGTM'), body);
  assert.ok(!body.includes('すべて解消'), body);
  assert.ok(!recoverySection(body).some((l) => l.includes('✅ 解消')), body);
  // 他の code と並んでも final_test_red の分だけ未解消に数える（ci_checks_failed は CI passed で解消）
  const mixed = finalTestBody(ranCheck({ status: 'none', files: [] }, PASSED), {
    priorDevflow: { tier: 'HOLD', codes: ['ci_checks_failed', 'final_test_red'], url: PRIOR_URL, head_sha: HOLD_HEAD },
  });
  assert.equal(headlineOf(mixed), '### LGTM（review）— dev-flow の HOLD 理由 1 件が未解消。merge 前に確認');
});

test('buildTerminalSummaryBody: 判定表の外の code — 人の判断待ち（escalate / ac_human_pending）と final_test_red は未解消、それ以外は未確認で、文言は互いに異なる', () => {
  const body = finalTestBody(ranCheck({ status: 'none', files: [] }, PASSED), {
    priorDevflow: { tier: 'HOLD', codes: ['escalate', 'ac_human_pending', 'final_test_red', 'danger_unresolved'], url: PRIOR_URL, head_sha: HOLD_HEAD },
  });
  const rows = recoverySection(body).filter((l) => l.startsWith('- '));
  assert.deepEqual(rows, [
    `- \`escalate\` — ${UNRESOLVED_HUMAN}`,
    `- \`ac_human_pending\` — ${UNRESOLVED_HUMAN}`,
    FINAL_TEST_ROW,
    `- \`danger_unresolved\` — ${NOT_JUDGED}`,
  ]);
  assert.equal(new Set([NOT_JUDGED, UNRESOLVED_HUMAN, UNRESOLVED_FINAL_TEST]).size, 3);
  assert.equal(headlineOf(body), '### LGTM（review）— dev-flow の HOLD 理由 3 件が未解消・1 件が未確認。merge 前に確認');
});

// --- 判断カード（issue #1359） ---------------------------------------------------

const CLEARED_SR_1359 = { target: true, status: 'cleared', stop_reason: null, rounds: 1, critical: 0, major: 0, minor: 0 };

// 見出しの直後の判断カード: 問い / 件数 / 「あなたが確かめること」の見出しと箇条書き（次の空行まで）
function card1359(body) {
  const lines = body.split('\n');
  const h = lines.findIndex((l) => l.startsWith('### ') && !l.startsWith('### あなたが確かめること'));
  const c = lines.indexOf('### あなたが確かめること');
  return {
    question: lines[h + 2],
    count: lines[h + 4],
    heading: lines[h + 6],
    checks: lines.slice(c + 2, lines.indexOf('', c + 2)),
  };
}

test('issue #1359 AC-3: STATUS_HEADLINE の全キーで判断カードの問いが空でない', () => {
  for (const status of Object.keys(STATUS_HEADLINE)) {
    const card = card1359(buildTerminalSummaryBody({ pr: 9, status, iterations: 1, lastDecision: 'approve', lastSummary: 'ok', history: [] }));
    assert.ok(card.question.startsWith('**あなたが決めること**: '), `${status}: ${card.question}`);
    assert.ok(card.question.slice('**あなたが決めること**: '.length).trim().length > 0, `${status}: 問いが空でない`);
    assert.ok(!card.question.includes(`${status} で終了した`), `${status}: 既定の問いに落ちない`);
    assert.equal(card.heading, '### あなたが確かめること', status);
  }
});

test('issue #1359 AC-3: CI が pending なら CI を ⚠️ に数え「あなたが確かめること」に出す', () => {
  const body = buildTerminalSummaryBody({
    pr: 9, status: 'ci_pending', iterations: 1, lastDecision: 'approve', lastSummary: 'ok', history: [],
    ciLastStatus: 'pending', securityReview: CLEARED_SR_1359, ...ON_HEAD,
  });
  const card = card1359(body);
  assert.equal(card.count, '機械の確認（最終レビュー、CI、security review）: ✅ 確認済み 1 / ⚠️ 未検証 2 / ❌ 不合格 0');
  assert.ok(card.checks.includes('- ⚠️ CI: pending（未完了）— 完了を待って `gh pr checks 9` で結果を確かめる'), card.checks.join('\n'));
});

test('issue #1359 AC-3: 全項目が確認済みの lgtm は「あなたが確かめること」の下が「なし」だけ。HOLD の後の回収 run は HOLD 回収も数える', () => {
  const opts = { pr: 9, status: 'lgtm', iterations: 1, lastDecision: 'approve', lastSummary: 'ok', history: [], ciLastStatus: 'passed', securityReview: CLEARED_SR_1359, ...ON_HEAD };
  const card = card1359(buildTerminalSummaryBody(opts));
  assert.equal(card.count, '機械の確認（最終レビュー、CI、security review）: ✅ 確認済み 3 / ⚠️ 未検証 0 / ❌ 不合格 0');
  assert.deepEqual(card.checks, ['なし']);

  const recovered = card1359(buildTerminalSummaryBody({ ...opts, priorDevflow: { tier: 'HOLD', codes: ['ci_checks_failed'], url: PRIOR_URL } }));
  assert.equal(recovered.count, '機械の確認（最終レビュー、CI、security review、dev-flow の HOLD 回収）: ✅ 確認済み 4 / ⚠️ 未検証 0 / ❌ 不合格 0');
  assert.deepEqual(recovered.checks, ['なし']);
  const open = card1359(buildTerminalSummaryBody({ ...opts, priorDevflow: { tier: 'HOLD', codes: ['escalate'], url: PRIOR_URL } }));
  assert.deepEqual(open.checks, ['- ❌ dev-flow の HOLD 回収: HOLD 理由 1 件が未解消 — 下の「dev-flow の HOLD 理由の回収状況」を確かめる']);
});

test('issue #1359 AC-3: 指摘が残った stuck・critical / major が残る security review は ❌、終端 head と別の head の CI は ⚠️', () => {
  const card = card1359(buildTerminalSummaryBody({
    pr: 9, status: 'stuck', iterations: 1, lastDecision: 'request-changes', lastSummary: 'x', history: [],
    ciLastStatus: 'passed', ...ON_HEAD, ciLastHead: OTHER_HEAD,
    securityReview: { target: true, status: 'unresolved', stop_reason: null, rounds: 2, critical: 1, major: 0, minor: 0 },
  }));
  assert.equal(card.count, '機械の確認（最終レビュー、CI、security review）: ✅ 確認済み 0 / ⚠️ 未検証 1 / ❌ 不合格 2');
  assert.deepEqual(card.checks.map((l) => l.split(':')[0]), ['- ❌ 最終レビュー', '- ⚠️ CI', '- ❌ security review']);
});

// 反復履歴の本文行（| <反復> | で始まる行）
const historyRows1359 = (body) => body.split('\n').filter((l) => /^\| \d+ \|/.test(l));
const finding1359 = (severity) => ({ severity, file: 'a.js', line: 1, description: `${severity} finding` });

test('issue #1359 AC-4: 反復履歴は反復ごとに critical / major / minor の件数と blocking の扱いを出す（stuck・max_reached・lgtm）', () => {
  const history = [
    { iteration: 1, decision: 'request-changes', summary: 'r1', blocking: [finding1359('critical'), finding1359('major'), finding1359('major')], minor: [finding1359('minor')] },
    { iteration: 2, decision: 'request-changes', summary: 'r2', blocking: [finding1359('major')], minor: [finding1359('minor'), finding1359('minor')] },
  ];
  const rowsOf = (status, h, iterations) => historyRows1359(buildTerminalSummaryBody({ pr: 9, status, iterations, lastDecision: h[h.length - 1].decision, lastSummary: 'x', history: h }));
  assert.deepEqual(rowsOf('stuck', history, 2), [
    '| 1 | 🔴 変更要求 | 1 | 2 | 1 | 修正に回した | r1 |',
    '| 2 | 🔴 変更要求 | 0 | 1 | 2 | 未修正で終了 | r2 |',
  ]);
  assert.deepEqual(rowsOf('max_reached', history, 2), [
    '| 1 | 🔴 変更要求 | 1 | 2 | 1 | 修正に回した | r1 |',
    '| 2 | 🔴 変更要求 | 0 | 1 | 2 | 修正したが再レビューなし | r2 |',
  ]);
  assert.deepEqual(rowsOf('lgtm', [{ iteration: 1, decision: 'approve', summary: 'ok', blocking: [], minor: [finding1359('minor')] }], 1), [
    '| 1 | ✅ 承認 (LGTM) | 0 | 0 | 1 | なし | ok |',
  ]);
});
