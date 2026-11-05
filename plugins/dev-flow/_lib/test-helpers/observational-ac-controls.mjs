// 観測型 AC 判定（issue #844 / #859）の対照 AC。vitest（_lib/*.test.mjs）と prerun-analyze.bats が共有する
// （bats は node でこの module を import して fixture の issue 本文を組む）。過去 issue の AC 本文そのまま。

// positive control: inspection で達成扱いになり、実際に動かすと満たさなかった既知 9 issue の AC
export const KNOWN_OBSERVATIONAL_ACS = {
  '423-5': `AC-5: 変更前後で各 5 run 以上の A/B を実施し、\`plan_iter\` / \`eval_iter\` / \`iterate_status\` / findings 件数 / \`duration_seconds\` の比較表が作成されている`,
  '431-4': '`error_category` / `error_msg` が失敗 run の journal entry に到達する',
  '431-5': 'pr-iterate 単体起動で `iterate_status` / `ci_wait_seconds` / `ci_poll_attempts` が記録される',
  '471-6': 'AC-6: receipt 欠落時に `trust_evalseal_missing_reason` が closed enum 値で journal telemetry の `telemetry` へ到達する（実 `journal.sh` との結合テストで確認）',
  '471-12': 'AC-12: 修正後の run で `missing_receipt.evalseal.rate` が修正前（1.0）と同一コマンドで比較可能な形で記録される',
  '476-1': 'AC-1: PR stage probe が receipt を生成できなかった run で、理由が closed enum 値として telemetry へ記録される',
  '476-8': 'AC-8: 修正後の実 run で `layer_status.effectdelta.stages` に `pr` が 1 件以上現れる（修正前 0 件と同一コマンドで比較可能）',
  '485-1': '実 dev-flow run（本 repo、AC を持つ PR）で redgreen-verify.sh の verdict_cmd 実行を直接検証し、fail_open の root cause（vitest sandbox EPERM 再発 / adapter 検出失敗 / .veridelta RunStore 非共有 等）を切り分けて特定する',
  '485-4': "修正後の直近 dev-flow run（min_runs>=5）で `analyze-dev-flow-telemetry.sh --window 30d` の vdelta_verdict fail_open rate が閾値0.5未満に低下していることを確認する（doctor anomaly 'vdelta_unhealthy' が再発火しない）",
  '491-6': 'AC-6: 修正後の run において `trust-receipts-report.sh --window 30d` の `missing_receipt.evalseal.reason_distribution` に `unrecorded` 以外の closed enum 値が現れる（実測。run 数が 0 の場合は本 AC を満たさないものとする）',
  '495-4': 'receipt の evidence が実行証跡ファイル由来であることを統合テストで検証する。evidence ファイルが欠落・不正な場合は receipt を発行せず `inconclusive` に倒す（成功扱いにしない）ことを含める',
  '526-1': 'dev-flow を1回流すと `~/.claude/journal/` に `*-dev-flow-*.json` が生成される',
  '526-3': 'pr-iterate 単体起動でも同様に記録される',
  '815-5': '長文欄を上限いっぱいにした本文で PR を作成し、closes-check が `verified` になる（転写で後半が落ちないことを少なくとも 1 run で実測）',
};

// negative control: 観測の語を含むが、否定形・文書の内容・定数の編集・コード構造・名詞の「実測」で、コード読みで確かめられる AC
export const NON_OBSERVATIONAL_ACS = {
  '807-3': 'spawn の prompt に payload 以外の結論値・要約を載せない（classifier による journal-log ブロックの面を広げない）',
  '561-5': 'AC-5: `.claude/agents/evaluator.md` と `.claude/agents/pr-reviewer.md` に confidence の判定基準が記載され、verdict と独立に付ける旨が明記されている',
  '786-5': 'journal の prune で残す一覧（`PRUNE_KEEP_DEFAULT`）から doctor / improve を外す',
  '556-5': 'journal choreography が `_lib/journal-handoff.mjs` へ deps 注入形で canonical 化され、',
  'acme/site#106-1': '`real-case-catalog.md` が存在し、実案件14本すべてに解法パターン・引用可能な実測値・実測セッション数が入っている',
};

// 回帰ケース（issue #859）: 語彙の違うアプリ repo（acme/webapp）で正規表現だけの判定が誤った AC。
// 値は正しい観測型判定。
export const APP_REPO_REGRESSION_ACS = [
  // /本番/ で actor は human のまま（HUMAN_AC_PATTERNS は issue #859 の対象外）。観測型ではない
  { id: 'table-1', ac: '本番コードは変更しない（テストのみ）', observational: false },
  { id: 'table-2', ac: 'ログの件数表示を修正する', observational: false },
  { id: 'table-3', ac: 'エラー件数を返す関数にテストを足す', observational: false },
  { id: 'table-4', ac: '実行ログに 1 件以上記録される', observational: true },
  { id: 'acme/webapp#104-2', ac: '件数の直書きを、元データ（GUIDE_SLUGS 等）の長さとの比較か、件数に依存しない不変条件に置き換える', observational: false },
];
