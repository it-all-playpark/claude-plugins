// Isolation probe: dev-flow の Setup phase 完了直後に bg-isolation guard を早期検知する純関数群
// （bg job から dev-flow を起動する際、呼び出し元セッションが自身の cwd を worktree へ isolate
// していないと、harness の bg-isolation guard により implementer の Write/Edit tool 呼び出しが
// 共有チェックアウトへの書き込みとして拒否される。放置すると Implement/Evaluate まで数十 agent
// 分の呼び出しを浪費した後に empty-diff として発覚するため、Setup 完了直後に probe で早期検知する）。
//
// isolationCleanupPrompt: probe の直前に gitignored な作業用パスを除去させる prompt を組み立てる
//   純関数（前 run の probe artifact（.isolation-probe-<token>）や run 専用 scratch を持ち越さない
//   衛生目的）。除去範囲 target は呼び出し元が明示的に渡す
//   必須引数: dev-flow Setup は run 開始時点なので `.devflow-tmp` 全体を消せるが、pr-iterate は
//   dev-flow から nested 起動されると isoWt が実行中 run の worktree 自身になるため、
//   `ISOLATION_PROBE_CLEANUP_GLOB`（`.devflow-tmp/.isolation-probe*`）だけに絞る（当該 run が既に
//   書いた run 専用 scratch（local-verify state 等の .devflow-tmp 配下生成物）を run 途中で消さない）。デフォルト値を持たせると、呼び出し元が範囲を意識しないまま広い方を選ぶ。
//   probe の成立自体はもう本 prompt の実行成否に依存しない（下記 isolationProbePrompt 参照）。
//   probe ファイル名（token 付き `.isolation-probe-<token>`）と `ISOLATION_PROBE_CLEANUP_GLOB` は
//   対応させて保つこと（git pathspec の前方一致は自動で辿らないため、drift すると cleanup が
//   0 件しか消せなくなる — issue #555）。
// isolationProbePrompt: probe 専用 agent（Write tool のみ）へ渡す prompt を組み立てる純関数
//   （worktree 直下の run 毎に一意なパスへ Write tool で実際に書き込ませ、成否を {written, error} で
//   verbatim 報告させる）。token は呼び出し元が渡す必須引数: probe 対象パスに run 毎の一意な token
//   を含めることで、cleanup が blocked/skip されて前 run の残置物が残っていても probe が成立する
//   （成立が cleanup の成功に依存しない — issue #521）。cleanup は前 run 残置物の持ち越し防止
//   （run 間衛生）の目的で独立に残る。
// isolationErrorKind: probe の error 文字列を既知シグネチャで分類する純関数。written:false の原因が
//   「isolation 不成立」なのか「その他の書き込み失敗（上書き拒否等）」なのかを isolationFailureMessage
//   が出し分けるための判別根拠にする。
//   「File has not been read yet. Read it first before writing to it.」は Write tool の
//   「既存ファイルは同一セッション内で Read 済みでないと上書き拒否」エラー文言そのもの（issue #482
//   で実測）。token による一意化後もこのシグネチャが出る場合は同一 run 内の再実行など probe パス
//   自体が既存ファイルだったケースであり、isolation 不成立とは別原因として区別する。
// isolationFailureMessage: probe が written:false を返した場合の throw メッセージを組み立てる純関数
//   （branch/起点 ref/workflow 名・args を含む復旧手順 — worktree 作成/EnterWorktree/Workflow 再実行 — を返す）。
//   呼び出し元（dev-flow.js / pr-iterate.js）ごとに workflow 名・再実行 args・回避手順で提示する
//   worktree 先（targetPath）・新規 worktree の起点 ref（startRef）が異なるため、いずれも呼び出し元が
//   明示的に渡す必須引数にする（デフォルト値による暗黙の workflow 名混同を避ける — issue #455 レビュー指摘）。
//   startRef は `origin/<ref>` 等の完全な ref 式を受け取る（関数側で origin/ を補わない）。
//   dev-flow は未実装 issue の作業を base から始めるため `origin/<base>`、pr-iterate は既存 PR の
//   head を再現する必要があるため `origin/<head_ref>` を渡す（base 起点だと PR の変更を含まない
//   worktree を提示してしまう — issue #455 レビュー指摘）。
//   EnterWorktree へ提示する worktree 先は 2 レイアウトをサポートする: repo 内 `.claude/worktrees/df-<N>`
//   は `.claude/worktrees/` 以降の相対パスへ変換して提示し、それ以外（repo 外 `<repo>-wt/df-<N>`。
//   issue #528）は絶対パスのまま pass-through する。後者は偶発的 fallback ではなく正規経路 —
//   EnterWorktree は絶対パスでも成立する（issue #449 実測）。
//
// INLINE COPY POLICY: workflow から参照される最上位宣言だけが tools/sync-inlines.mjs --write で inline 生成される。
// 直接 workflow 側を編集しない。一致は _lib/workflow-inlines.sync.test.mjs が検証する。
// 制約: ESM import / require / Date.now / Math.random を含めない。export function / export const のみ。
//
// 不変条件: 本ファイルが生成する prompt / メッセージは、実行制御の名称（sandbox・permission・
// excludedCommands・guard 等）を「だからこの経路を使え」という形の理由として述べない。
// 転写契約に判断余地を持ち込ませないための規範であり、`.claude/rules/dev-flow.md` の exec-proxy 節が
// 正典。canonical と 2 つの inline 生成区間の双方を _lib/isolation-control-reason.test.mjs が pin する。

// probe が実際に書くパスは token 付き `.devflow-tmp/.isolation-probe-<token>`（isolationProbePrompt
// 参照）。前方一致 + `*` にするのは、token 形に加え issue #521 以前の legacy 無 token 残置物
// `.devflow-tmp/.isolation-probe` も cleanup の衛生対象にするため（`-` を含まない
// `.isolation-probe*` にすることで両方にマッチする。`.isolation-probe-*` にすると legacy 形を
// 取りこぼす）。
export const ISOLATION_PROBE_CLEANUP_GLOB = '.devflow-tmp/.isolation-probe*';

export function isolationCleanupPrompt(worktree, target) {
  return `worktree ${worktree} の gitignored な作業用パス \`${target}\` を除去せよ。手順:\n`
    + `1. \`git -C ${worktree} clean -fdx -- ${target}\` を 1 回だけ実行する`
    + `（\`${target}\` が存在しない場合もこのコマンドは成功する）\n`
    + `2. 成功したら {"cleaned": true} を返せ。\n`
    + `コマンドがエラーを返した場合は、例外を投げずに `
    + `{"cleaned": false, "error": "<エラーメッセージ全文>"} を返せ。\n`
    + `\`${target}\` 以外のパスには触れるな。`;
}

export function isolationProbePrompt(worktree, token) {
  const tok = String(token).replace(/[^A-Za-z0-9._-]/g, '-');
  const path = `${worktree}/.devflow-tmp/.isolation-probe-${tok}`;
  return `Objective: 絶対パス \`${path}\` へ Write tool で内容 "ok" を書き込み、結果を verbatim 報告せよ。\n`
    + `Tools: 使用可: Write のみ。他の tool は使用禁止。\n`
    + `Boundary: \`${path}\` 以外のパスに書き込むな。Write tool がエラー・拒否を返した場合、`
    + `他の手段でファイルを作成しようと試みるな — 1 回の Write の結果をそのまま報告せよ。\n`
    + `成功したら {"written": true} を返せ。`
    + `Write tool がエラー・拒否を返した場合は、例外を投げずに `
    + `{"written": false, "error": "<エラーメッセージ全文>"} を返せ。`;
}

export function isolationErrorKind(error) {
  const text = String(error ?? '');
  if (/has not been read/i.test(text)) return 'overwrite_refused';
  if (/parent bg session hasn'?t isolated|bg.?isolation/i.test(text)) return 'isolation';
  return 'unknown';
}

export function isolationFailureMessage({ worktree, branch, startRef, workflowName, workflowArgs, targetPath, error }) {
  const wt = targetPath || worktree;
  const relWt = wt.includes('.claude/worktrees/') ? wt.slice(wt.indexOf('.claude/worktrees/')) : wt;
  const kind = isolationErrorKind(error);
  const heading = kind === 'overwrite_refused'
    ? `${workflowName}: isolation probe 書き込み失敗 — 既存 probe ファイルの上書き拒否`
      + `（isolation 不成立とは別原因。前 run の残置物が同名パスに残っている可能性）`
    : kind === 'isolation'
      ? `${workflowName}: worktree isolation エラー — implementer が ${worktree} に書き込めません`
        + `（bg-isolation guard の可能性: 呼び出し元セッションの cwd がこの worktree へ isolate されていない）`
      : `${workflowName}: isolation probe 書き込み失敗 — 原因を特定できず`
        + `（isolation 不成立の可能性を含む）`;
  return `${heading}。\n`
    + `対処: 呼び出し元セッションで以下を実行してから ${workflowName} を再起動してください`
    + `（新しい worktree には前 run の残置物が無いため、残置物が原因だった場合も同時に解消します）:\n`
    + `  1. git worktree add -b ${branch} ${wt} ${startRef}\n`
    + `     （branch ${branch} がローカルに既存なら -b と起点を外して \`git worktree add ${wt} ${branch}\`、`
    + `さらに他 worktree で checkout 済みなら \`git worktree add --force ${wt} ${branch}\`、`
    + `worktree ${wt} 自体が既存なら本手順ごと不要）\n`
    + `  2. EnterWorktree({ path: "${relWt}" })\n`
    + `  3. Workflow({ name: "${workflowName}", args: "${workflowArgs}" }) を再実行\n`
    + (error ? `probe error: ${error}` : '');
}
