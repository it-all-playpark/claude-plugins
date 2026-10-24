---
name: pr-iterate
description: |
  Iterates review ⇄ fix on an existing GitHub PR until LGTM (max 10 rounds): performs a
  deterministic isolation preflight (pr-iterate-prerun: gh pr view → PR head worktree
  create/reuse → write probe; then EnterWorktree) and launches the pr-iterate-run dynamic
  workflow, which posts the terminal summary on the PR. Merge is always human.
  Use when: (1) /pr-iterate <pr>, (2) user asks to re-review / fix review findings on a PR,
  (3) recovering a dev-flow run that stopped at pr-iterate (fix_failed / ci_pending / abort),
  (4) keywords: pr-iterate, PRレビュー反復, review fix loop, LGTMまで.
---

# pr-iterate

既存 PR を review ⇄ fix で LGTM まで反復する wrapper skill。orchestration の実体は dynamic workflow
`pr-iterate-run`（`plugins/dev-flow/.claude/workflows/pr-iterate.js`）が持つ。本 skill は
**isolation preflight**（PR head の worktree を決定論で用意してから Workflow を起動する）を行う。
dev-flow からの nested 起動はこの skill を通らない（dev-flow が自分の worktree を `nested` で渡す）。

## なぜ preflight が必要か

fix stage の Write/Edit は、呼び出し元セッションの cwd が worktree へ isolate されていないと bg-isolation
guard に拒否される。workflow は review loop の前に isolation probe（worktree 直下
`.devflow-tmp/.isolation-probe-<epoch>` への Write）を置き、`written:false` なら fail-closed で止まる。
preflight で PR head の worktree を作って `EnterWorktree` しておけば probe が成立し、workflow は
haiku に `gh pr view` を転写させる pr-meta と isolation-cleanup を起動しない（値は prerun が決定論で渡す）。

## Preflight 手順（1-4 を順に実行）

1. **prerun 実行**: launch dir（リポジトリルートか、その worktree）で Bash 1 コマンドとして
   `pr-iterate-prerun <PR>` を実行する（PR が cwd の repo と別なら `--repo owner/name` を付ける）。前置形
   （`cd X && ...` / `VAR=x ...` / `bash <path>` 等）は使わず、bare 名を先頭トークンにする。stdout の
   JSON 1 行（`{ok, pr, worktree, head_ref, base_ref, head_sha, repo, epoch, worktree_status, worktree_removed, skip_worktree, prior_devflow, prior_summary, ci_wait_ceiling_seconds, security_review, error?}`）
   をそのまま保持する。

   `pr-iterate-prerun` は PR の url / head / base / head の commit を `gh pr view` で取り、`git fetch origin` 後の
   `origin/<head>` が PR の head commit と一致することを確かめてから worktree を用意する:
   - PR の head branch を checkout 済みの worktree（dev-flow の `df-<N>` 等）があれば再利用する
   - 無ければ `<repo>/.claude/worktrees/pr-<N>`（既定）か `<repo>-wt/pr-<N>`（repo 外）に `origin/<head>` から作る。
     候補の選び方は dev-flow と同じ（既定候補が存在すればそれ、無ければ repo 外候補が存在すればそれ、
     どちらも無ければ既定候補）
   - 作った worktree に書き込めなければ remove して repo 外候補で 1 回だけ作り直す（`worktree_removed:true`）。
     wrapper 側で再実行する必要は無い
   - 書けないパス（`.githooks` 等）を追跡する repo で full checkout が失敗したら、取り出せるパスだけを取り出し、
     取り出せないパスに skip-worktree を付ける（`skip_worktree` に列挙）。再利用する worktree に未ステージの削除
     （部分 checkout）が残っていれば `ok:false`
   - 再利用した worktree の HEAD が PR head より遅れていて未コミット変更が無ければ fast-forward する。
     PR head に無いコミットを持つ（未 push・分岐）か、遅れていて未コミット変更があれば `ok:false`
   - 前 run の `.devflow-tmp/.isolation-probe*` を除去する（`.devflow-tmp` の他のファイルは残す）
   - 同じ `gh pr view` で PR コメントも取り、`<!-- dev-flow:<tier>[ codes=...] -->` marker を持つ最後のコメント
     （dev-flow の終端サマリー）を `prior_devflow`（`{tier, codes, url}`、無ければ null）に載せる
   - 終端サマリーの marker（`<!-- dev-flow:... head=<sha> -->` / `<!-- pr-iterate:<status>:<n> head=<sha> -->`）を持つ最後の
     コメントを `prior_summary`（`{source, url, head_sha, head_mismatch}`、無ければ null）に載せる。`head_mismatch` は
     marker の head（その結論を出した head）が今の PR head と違うか、marker に head が無いとき true
   - PR の base branch で直近に成功した CI の所要時間から CI 待ちの上限（秒）を決め、`ci_wait_ceiling_seconds` に載せる
     （dev-flow の nested 起動と同じ求め方。読み取りに失敗したら 300）
   - PR 全体（`origin/<base>...<PR head>`）の diff が敵対的 security review の対象かを決定論の許可リストで判定し、
     `security_review`（`{target, reasons, reviewer_context_changed, reviewer}`）に載せる。判定できないときは `target:true`・
     `reviewer_context_changed:true`。`reviewer` は review を回す CLI の opt-in（`"dev-flow".security_reviewer`。base branch の
     `skill-config.json` か user 設定から読み、PR head の設定は読まない。無ければ `"claude"`）

   結果に応じて分岐する:

   (a) `ok:true` → 手順2 へ進む。

   (b) `ok:false` → `error` を verbatim で人間に報告して停止する（fallback で worktree を自前作成しない・
   既存 worktree を強制上書きしない）。`worktree_status:"unwritable"` で `worktree_removed:false` は
   再利用した worktree が書けない場合で、`git worktree remove <path>` してから再実行するよう伝える。

2. **EnterWorktree**: `EnterWorktree({ path: '<prerun 出力の worktree>' })` を実行する（cwd が既にその
   worktree なら不要）。別の worktree に入っている場合は先に `ExitWorktree`（worktree は keep）で launch dir へ
   戻ってから入る。

3. **Workflow 起動**: 次の形で起動する。`nested`・`prior_devflow`・`prior_summary`・`ci_wait_ceiling_seconds`・`security_review` の値は prerun 出力をそのまま転記し、加工・要約しない:

   ```
   Workflow({ name: 'dev-flow:pr-iterate-run', args: {
     pr: <PR>,
     nested: { caller: 'standalone', cwd: <worktree>, head_ref: <head_ref>, head_sha: <head_sha>,
               base_ref: <base_ref>, repo: <repo>, epoch: <epoch> },
     prior_devflow: <prior_devflow>,
     prior_summary: <prior_summary>,
     ci_wait_ceiling_seconds: <ci_wait_ceiling_seconds>,
     security_review: <security_review>,
   } })
   ```

   - `security_review` を省くと workflow は対象として扱う（fail-closed）。対象の PR は、LGTM の前に PR 全 diff を
     敵対的 security review（security-reviewer）が読み、critical / major が 0 件になるまで LGTM にしない。
     終端サマリーには指摘の件数だけが載る。`reviewer:"codex"` なら Codex CLI が review する（Codex を起動できなければ
     security-reviewer の判定に戻る）。指示ファイルを変える PR はどちらの経路でも自動の review で clear にせず止める
     （`security-review-isolated` で人が確かめる）

   - `prior_devflow` が HOLD の dev-flow サマリーなら、終端サマリーは HOLD 理由の code ごとの回収状況を出し、
     未解消が残れば見出しを「🎉 LGTM」にしない（このレポートが PR の最後のコメント＝最新の結論になるため）。
     null でもそのまま渡す

   - `prior_summary.head_mismatch` が true なら、workflow は review を始める前に「head `<sha>` で再 review 中。
     <古いサマリーの URL> の結論はこの head に当てはまらない」コメントを PR に足す。意味: その URL の LGTM / tier は今の
     head を見ていないので merge の根拠にしない — 今の head に対する結論はこの run の終了レポート（PR の最新コメントが
     古い LGTM のまま merge されるのを防ぐ）。古いサマリーは編集・削除しない。投稿に失敗しても review は続ける。
     食い違いが無い（false）・終端サマリーが無い（null）なら投稿しない。null でもそのまま渡す

   - `caller: 'standalone'` が単体起動の印で、workflow は終端サマリーを PR に投稿する（dev-flow は
     `caller: 'dev-flow'` を渡し、終端サマリーは dev-flow 自身が投稿する）。`caller` を省くと workflow は即 throw する
   - `repo` が null ならキーごと省く。反復上限を変えるときだけ `max_iterations: <n>` を足す
   - Workflow 名は namespaced の `dev-flow:pr-iterate-run` のみ（bare 名・旧名 `pr-iterate` は解決しない）

4. **完了後**: 返り値の `status`（`lgtm` / `stuck` / `fix_failed` / `max_reached` / `ci_error` / `ci_pending` /
   `review_contract_error` / `security_unresolved`）と終端サマリーの URL を人間に報告する。security review の指摘の
   本文は報告に書き写さない（返り値 `security_review` の件数だけを伝える）。merge は人間が行う。worktree は削除しない
   （回収後も人間が中身を確認できるように残す。後片付けは人間が `worktree-teardown` で行う）。

## 再実行

同じ PR をもう一度回すときも手順1 からやり直す。前回の prerun 出力を使い回さない: isolation probe の token は
`epoch` で、使い回すと前 run の probe ファイルと同名になり Write-only agent の上書きが拒否されて
`written:false` → fail-closed で止まる。`pr-iterate-prerun` は毎回新しい `epoch` を返す。

## 実行環境

`pr-iterate-prerun` は `dev-flow-prerun` と同じく sandbox 内で動く（gh / git は sandbox 内で認証される）。
起動元 repo の `.git/config` は sandbox 内から書けないので、worktree は upstream を書かずに作り、fix の push は
`git push origin HEAD` で同名 branch へ送る（`gh pr checkout` / `git push -u` は使わない）。gh / git が失敗した
場合は `error` に載って `ok:false` で止まる — 手順1 (b) のとおり人間に報告して終える。
