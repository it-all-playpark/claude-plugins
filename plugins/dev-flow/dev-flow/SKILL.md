---
name: dev-flow
description: |
  Runs the issue-to-LGTM dev-flow pipeline for a GitHub issue: performs isolation
  preflight (dev-flow-prerun: base resolution, worktree creation, the deterministic issue
  analyze (analyze-issue --contract + bounded Jev judgement); then deps install via
  ensure-worktree-deps --setup as a separate Bash call; then EnterWorktree) then launches the dev-flow-run dynamic workflow
  (analyze gate (no LLM spawn on the normal path) → implement → validate → diff
  triage (effective shape from the realized diff) → evaluate → PR → pr-iterate → merge
  tier). Merge is always human.
  Use when: (1) user asks to implement a GitHub issue end-to-end,
  (2) /dev-flow <issue>, (3) keywords: dev-flow, issue実装, issue→PR, 自動実装.
---

# dev-flow

Issue から LGTM までの pipeline を起動する wrapper skill。orchestration の実体は dynamic
workflow `dev-flow-run`（`plugins/dev-flow/.claude/workflows/dev-flow.js`）が持つ。本 skill は
**isolation preflight**（worktree を先に用意してから Workflow を起動する）を行う。

## なぜ preflight が必要か

bg 起動セッションで、呼び出し元 cwd が共有 checkout のまま `Workflow({ name: 'dev-flow:dev-flow-run' })`
を直接起動すると、Setup phase 直後の isolation probe（worktree 直下 `.devflow-tmp/.isolation-probe`
への Write 検証）が `written:false` となり run 全体が fail-closed abort する。preflight で先に
worktree を作り `EnterWorktree` しておくことで probe が成立する。

## Preflight 手順（issue ごとに 1-4 を実行）

1. **worktree パスの決定**: worktree dir の候補は 2 つ — 既定 `<repo>/.claude/worktrees/df-<N>`、
   repo 外 `<repo>-wt/df-<N>`（`<repo>` の sibling ディレクトリ。例: `/path/to/repo` に対し
   `/path/to/repo-wt/df-<N>`）。既定候補が存在すればそれを使う。既定候補が無ければ repo 外候補が
   存在すればそれを使う。どちらも存在しなければ既定候補を使う。**worktree ディレクトリ名は
   `df-<N>` 固定**（配置が既定/repo 外いずれでも共通）。

2. **prerun 実行**: リポジトリルート（launch dir）で Bash 1 コマンドとして
   `dev-flow-prerun --issue <N> --worktree <手順1で決めた絶対パス>` を実行する（`args.base` を
   明示する場合のみ `--base <ref>` を付ける）。前置形（`cd X && ...` / `VAR=x ...` /
   `bash <path>` 等）は使わず、bare 名を先頭トークンにする。stdout の JSON 1 行で分岐する
   （`{ok, issue, base, worktree, worktree_status, stack, analyze, epoch, ...}`）。
   `dev-flow-prerun` は base 解決・worktree 作成/再利用・起点一致検証（独自コミット・未コミット変更の無い再利用 worktree は base へ fast-forward）・worktree 直下への
   書き込み probe・`.devflow-tmp` の clean・issue analyze（`analyze-issue --contract` の
   決定論 parse + Jev 有界判定）・framework 検出を 1 コマンドで行い、`ok:true` なら同じ JSON を
   `<worktree>/.devflow-tmp/prerun-setup.json` にも書く。deps install はしない（手順2b）。
   `security_reviewer` は nested pr-iterate の security review を回す CLI の opt-in（`"dev-flow".security_reviewer`）で、
   `pr-iterate-prerun` と同じ規則（base branch の設定 → user 設定、worktree の設定は読まない、無ければ `"claude"`）で読む。
   `claude` / `codex` 以外は `dev-flow-run` が明示 error で止める。security review の守る要件と境界・経路は
   `references/security-review.md`。
   書けないパス（`.githooks` 等）を追跡する repo で full checkout が失敗したら、取り出せるパスだけを取り出して
   取り出せないパスに skip-worktree を付ける（`skip_worktree` に列挙）。再利用する worktree に未ステージの削除
   （部分 checkout）が残っていれば `ok:false`（手順 (c)）。
   `analyze` 段が失敗（GitHub 到達不能 / JSON 不正）しても prerun は `ok:true` のまま
   `analyze.ok:false` + `reason` を返し、`dev-flow-run` が needs_clarification（source=analyze_prerun）で
   人間へ返す。private repo 等で issue 本文を Jev（外部 API）に送りたくない場合は
   `DEVFLOW_JEV_DISABLE=1` を prerun の環境に置く（Jev 判定が要る issue は uncertain として
   needs_clarification に倒れる）。Jev の要否と設定方法は「Jev（issue analyze の意味判定）」節。
   Jev 判定が行われないと該当判定は uncertain になり、その文言には原因（jev-broker に接続できない /
   jev-broker 経由の失敗 / Keychain に届かない / Keychain から API 鍵を読めない / API 鍵が無い /
   タイムアウト / 通信失敗 / 応答不正）と exit code が載る。wrapper は鍵の取得経路を探さず、
   needs_clarification をそのまま人間へ返す（鍵の設定や実行環境の調整は人間が判断する。
   「Keychain に届かない」を見て Keychain のロック解除を試しても直らない）。

   結果に応じて分岐する:

   (a) `ok:true` → 手順2b へ進む。

   (b) `worktree_status:"unwritable"`（`worktree_error` に `Permission denied` /
   `Operation not permitted` 等の permission 文言が載る）: 対象 repo の checkout 先が
   書き込み不可の場合の退避。`worktree_removed:true` なら、`--worktree <repo>-wt/df-<N>`
   （repo 外候補）を付けて手順2 をもう一度だけ実行する（作成直後の worktree は
   `dev-flow-prerun` が既に remove 済みなので二重 checkout にならない）。`worktree_removed:false`
   （既存 worktree を再利用したが書けない）なら、そこで停止し `git worktree remove <path>` を
   実行してから再実行するよう人間に報告する。

   (c) それ以外の `ok:false`: `base_error` / `worktree_error` を verbatim で人間に報告して
   停止する（fallback で worktree を自前作成しない）。

   `clean.ok:false` / `stack.error` / `analyze.ok:false` は advisory なので停止しない
   （Workflow 起動後、run 内で implementer への警告 / needs_clarification として扱われる）。

2b. **deps install**: 手順2 とは**別の** Bash 呼び出しで、bare 名を先頭トークンにして
   `ensure-worktree-deps --setup <prerun 出力の worktree>/.devflow-tmp/prerun-setup.json` を 1 回実行する
   （前置形は使わない。手順2 のコマンドに `&&` / `;` / パイプで繋がない）。stdout の JSON 1 行が prerun の出力に
   `deps`（`{ok, note}`）と `epoch_end`（install 完了後の時刻）を足した **setup** で、手順4 にこれを渡す。
   install は依存の postinstall（対象 repo の任意コード）を走らせるので、`dev-flow-prerun`（repo の
   任意コードを実行しない）の子にせず、この呼び出しで回す。`deps.ok:false` は advisory なので停止しない
   （run 内で implementer への警告になる）。exit 2（stdout 空）は setup ファイルが読めない場合で、
   stderr を verbatim で人間に報告して停止する。

3. **EnterWorktree**: `EnterWorktree({ path: '<prerun 出力の worktree>' })` を実行する。
   bg 起動セッションからも成立する。

4. **Workflow 起動**: `Workflow({ name: 'dev-flow:dev-flow-run', args: { issue: <N>, setup: <手順2bの
   stdout JSON を parse した object> } })`。`setup` は加工・要約・キー削除をせずそのまま渡す（手順2 の
   prerun 出力は `deps` / `epoch_end` を持たないので、渡すと `dev-flow-run` が即 throw する）。
   `args.base` は渡さない（base は `dev-flow-prerun` が解決済みで、渡すと `dev-flow-run` が
   即 throw する）。

## Jev（issue analyze の意味判定）

prerun の analyze は、正規表現では決められない判定を Jev（Vercel AI Gateway 経由の判定専用モデル）に聞く。
Jev のクライアントは plugin に同梱せず、公開された参照実装も無い。**前提条件**: Jev を使うには、下記の
インターフェースを満たす `jev-classify` を自分で用意して PATH に置く（`DEVFLOW_JEV_CLASSIFY` で別名にできる）。
置かない場合は下の「効かないときの挙動」になる。plugin は `jev-classify` を次のインターフェースで呼ぶ:

- 入力: stdin に state（判定対象の issue 本文などを Markdown で並べたテキスト）、引数
  `--questions '<questions JSON>' --redact --reason-file <path>`（`--redact` は送信前に token / password 等を
  伏せる。応答の上限秒数を環境変数 `JEV_MAX_TIME` で渡す。値は `DEVFLOW_JEV_MAX_TIME`、既定 10）
- questions JSON: 質問 id → 質問のオブジェクト。型は 2 つ:
  - `{"type":"noul","instructions":"…"}` — yes / no の質問。id は `breaking`・`migration`・`ac_<n>`
  - `{"type":"choice","instructions":"…","criteria":{"<選択肢>":"<基準>",…}}` — 選択肢から 1 つ選ぶ質問。
    id は `kind`、選択肢は `override` / `conflict` / `resolved` / `unrelated`
- 出力: 成功時は `{"answers":{…}}` を stdout に 1 行で出す（他のキーは読まない）。`answers` は質問 id ごとに
  - noul: `{"noul":<yes の確率 0〜1>}`
  - choice: `{"choice":"<選んだ選択肢>","probabilities":{"<選択肢>":<確率>,…}}`（選んだ選択肢の確率は必須）

  plugin は確率 0.9 以上を yes / その選択肢、0.1 以下を no とし、その間は低確信として安全側（uncertain・
  conflict・分類 agent）に倒す。確率は 0〜1 の数値。それ以外（`true` / `false` / `null` / 文字列 / 範囲外）は
  判定値なしと同じく uncertain（観測型 AC は分類 agent）になる。答えられない質問は id ごと省いてよい（その判定だけ
  uncertain になる）。
  最小の実装例は `dev-flow/scripts/prerun-analyze.bats` の偽 `jev-classify`、質問の全文は
  `dev-flow/scripts/prerun-analyze.sh`
- 失敗時は stdout を空にし、理由 1 行を `--reason-file` に書く。exit は常に 0。理由の先頭語（`no API key` /
  `keychain unreachable` / `keychain read failed` / `broker unreachable` / `broker request failed` / `timeout` /
  `request failed` / `bad response`）で uncertain の見出しを変える

- **要否**: 必須ではない。Jev を呼ぶのは、title / body に breaking 系キーワードがある issue、comment が付いた
  issue、観測型に見える AC を持つ issue だけで、どれにも当たらない issue は Jev が無くても同じ結果になる
- **効かないときの挙動**: `jev-classify` が PATH に無い・鍵が無い・届かない・タイムアウト・低確信のとき、breaking と comment の判定は
  uncertain に積まれ、run は Setup 末尾の analyze ゲートで**必ず needs_clarification で止まる**（実装に進まない）。
  観測型 AC の判定だけは止まらず、分類 agent の 1 spawn に回る。`DEVFLOW_JEV_DISABLE=1` で切ったときも同じ
- **node が無いとき**: 観測型 AC の正規表現の絞り込みは `node` で動くので、prerun を実行する環境の PATH に `node` が
  無いと「node を実行できない」が uncertain に積まれ、AC を持つ issue の run は analyze ゲートで needs_clarification で止まる
  （分類 agent には回さない。PATH に node を通すのは実行環境の側）
- **注記: 作者の `jev-classify` 実装を使う場合の鍵の設定**（その実装は上から順に試す。plugin には含まれず、
  自前の実装ならこの手順ではなくその実装に従う。`AI_GATEWAY_API_KEY` を置くだけでは `jev-classify` は手に入らない）:
  1. 環境変数 `AI_GATEWAY_API_KEY`（Vercel AI Gateway の API key `vck_…`）— 第一の方法。`dev-flow-prerun` を
     実行する Claude Code セッションの環境に置く（起動前のシェルで export する、または settings.json の `env`）。
     鍵は Bash ツールの環境から見える。sandbox 下では network の許可に `ai-gateway.vercel.sh` が要る
  2. jev-broker（**任意**）: 鍵を Bash の環境に出さずに中継する Unix socket。`JEV_BROKER_SOCKET`（既定
     `$HOME/.local/state/jev-broker/jev.sock`）に socket があれば経由する。sandbox 下では socket のパスを
     `sandbox.network.allowUnixSockets` に足す。broker が無くても 1 か 3 で動く
  3. macOS Keychain の service `vercel-ai-gateway`（`JEV_KEYCHAIN_SERVICE` で変更可）の generic password。
     登録は `security add-generic-password -s vercel-ai-gateway -a <任意のアカウント名> -w 'vck_…'`。
     Keychain の解除は監査セッションごとに効くので、sandbox 内の Bash と bg job からは解除済みでも届かない
     （exit 36）。その環境では 1 か 2 を使う

## 完了後の返り値の読み方

`test_green` は Validate の最終 test 結果の `green` そのもので、テストが起動できず 0 件実行
（`tests:'error'`）の run でも `false` になる。本物の red と区別するには次の 2 キーを併せて読む:

- `validate_tests`: Validate の最終 test 状態（`'passed' | 'failed' | 'no_tests' | 'error' | null`）
- `ci_test_verified`: 終端サマリーのテスト欄と merge tier に使った CI 照合結果（`true | false | null`）。
  Validate が `'error'` か red（`'failed'`）で Final reconcile が skipped の run だけ、PR head sha に pin した CI check を読んで決まる

`validate_tests === 'error' && ci_test_verified === true` は「ローカルではテスト未実行、同じ head sha の
CI test は green」を意味する。呼び出し元は journal・`gh pr checks`・`gh run view` で再検証せず、
その旨をそのまま報告する。Final reconcile が skipped の run で `validate_tests === 'error'` かつ
`ci_test_verified` が `true` でなければ（`null` は PR head sha が無く CI を読んでいない）、テストは
1 件も実行されていないので merge tier は HOLD（`validate_tests_not_run`。Setup の deps が `ok:false` なら
その note が理由に載る）になる。その旨を報告して CI の確認を人間に委ねる。`validate_tests === 'failed'` は
ローカルの red で、`ci_test_verified === true` なら同じ head sha の CI test は green（ローカルだけの失敗）、そうでなければ
merge tier は HOLD（`validate_test_red`）。

## PR phase 失敗の扱い（`error_category: "pr_phase_failed"`）

PR phase（commit / push / `gh pr create`）が失敗した run は throw せず、`status` / `error_category` が
`"pr_phase_failed"` の返り値で終わる（PR は無く、pr-iterate・Merge tier・終端サマリは走っていない）。返り値には
`failed_step`（`commit` / `push` / `pr-create` / `unknown`）・`failure_reason`（失敗コマンドの stderr 末尾 verbatim）・
`committed`・`head_sha`（取れた場合）・`push_log`（push 失敗時。pr-push が出力全文を残したファイル。proxy が
pr-push を経ずに push した場合は載らず、`failure_reason` が `pr-push not invoked` で始まる固定文言になる）・`branch`・
`worktree`・`shape`・`eval_verdict`・`phase_durations`・`recovery_commands`・`issue_comment` が載る。

呼び出し元セッションは次の 2 手順で失敗段・理由と回収コマンドを issue に残す:

1. 返り値の `issue_comment` を **Write tool** で `<worktree>/.devflow-tmp/pr-phase-failure-comment.md` へ
   一字一句そのまま保存する（要約・追記・書き換えをしない）
2. top-level の Bash で bare 単文 `gh issue comment <issue> --repo <repo> --body-file <worktree>/.devflow-tmp/pr-phase-failure-comment.md`
   を実行する（`repo` が null なら `--repo` を省く。`cd X &&` / env 前置 / `bash` 前置は付けない）

`issue_comment` の回収コマンドは `committed` と `failed_step` から決まる。commit 未了なら `git add -A` →
`git commit -F .devflow-tmp/commit-msg.txt` から、push で止まった run は `git push origin HEAD` から、
pr-create で止まった run は `gh pr create --draft --body-file .devflow-tmp/pr-body.md ...` から始まり、最後は
`/pr-iterate <N>`。commit message と PR body は run が `.devflow-tmp/` に保存済みのものを使い、再生成しない
（run が決定論で組んだ Closes 行・AC・設計判断と食い違うため）。wrapper は回収コマンドを自分で実行しない —
push / PR 作成は run 内でも wrapper でも再試行せず（pre-push hook の失敗等は原因を人間が判断する）、
コメント投稿の後に失敗段・理由と issue コメントの URL を人間に報告して終える。

## Implement 経路（全 shape で dev-implementer 一本）

Setup 末尾の analyze ゲート（固有の phase は持たない）は `args.setup.analyze`（prerun の決定論 analyze）を
whitelist 検証してゲート（AC 空 / comment_conflicts 非空 / uncertain 非空 / repo 内外が混ざった AC）を判定するだけで、
通常経路では agent を起動しない（ゲートが引いたときだけ sonnet を 1 spawn（`analyze-clarify#N`）し、人間向けの
missing_context を作って needs_clarification で終端する。ゲートを通過しても、観測型判定が prerun で確定しない
AC があるときは AC の文面だけを読む分類 agent（`ac-observational#N`）を 1 spawn する）。ゲート直後に issue から単一 task の plan を合成するだけ（Plan phase は
持たず、planner 系 agent は起動しない）で、Implement で `dev-implementer`（plan+impl 統合、opus / high）を
1 spawn する。BLOCKED 再実装（`reimpl-blocked#b`）・Validate の green-fix・Evaluate の差し戻し（`reimpl#i`）も
同じ agent への再 spawn。shape（micro / standard / complex）は analyze ゲートでは決めず、Diff triage で
realized diff の file 数 + AC 数 / issue_type / 構造化 breaking_change から決定論に決める
（Evaluate の深さ・LITE gate・merge tier の入力）。詳細は `references/pipeline.md` の「Diff triage」節。

## 直列複数 issue 実行時の worktree 切替

複数 issue を直列に処理する場合は、**issue ごとに手順1-4 を繰り返し**、必ず
`EnterWorktree({ path: '<選択した worktree の絶対パス>' })` で当該 issue の worktree（既定
`<repo>/.claude/worktrees/df-<N>` または repo 外 `<repo>-wt/df-<N>`）へ切り替えてから手順4 の
Workflow を起動する。前 issue の worktree に入ったまま次の issue の Workflow を起動すると、
isolation probe が fail-closed abort する。

## 並列実行（dev-flow-ready-set で波を回す）

1 セッションの中では並列にできない（Workflow tool は top-level 専用、EnterWorktree はセッションに 1 つ）。
issue ごとに別セッションで `/dev-flow <N>` を起動すれば、各 run が自分の `df-<N>` worktree と
`feature/issue-<N>` を持つので並列になる。どれを同時に流してよいかは `dev-flow-ready-set` が決める:

```
dev-flow-ready-set [--repo owner/repo] [--label <label>] [--with-in-flight] [<issue>...]
```

リポジトリルートで bare 名を先頭トークンにして実行する（read-only。issue / PR / label・push・ファイルに
書き込まない）。stdout の 1 行 JSON `{ok, launch, in_flight, waiting}` を次の波で回す:

1. 人間が流すよう指示した issue を、agent が **issue ごとに別セッション**で自分で起動する（人間に起動を頼まない）。
   自分のセッションで Workflow を回す 1 本は `launch[].command`（`/dev-flow <N>`）として上の Preflight 手順で回し、
   残りは repo ルートで各要素の `bg_command`（`claude --bg "/dev-flow <N>"`）を実行して別セッションを起動する。
   起動すると `backgrounded · <id>` が返るので、以後は `claude logs <id>` で進行を、`claude attach <id>` で
   そのセッション自体を追える
   - **起動するのは人間が指示した issue・本数だけ**: `launch[]` は「同時に流しても衝突しにくい集合」であって
     起動の指示ではない。人間が指示した範囲を超えて `launch[]` の残りを起動しない
   - **`waiting[]` の issue は起動しない**。ただし人間が明示的に指名した `path_conflict` の issue は、`detail` の
     相手と merge 時に conflict が出る見込みを伝えたうえで起動してよい（`blocked_by` / `human_task` は指名されても
     起動しない）
   - **sandbox 内の Bash からは起動できない**: `claude --bg` はセッションの状態を `~/.claude/jobs` に作るが、
     sandbox 内の Bash からはそこを作れず `EPERM: operation not permitted, mkdir '<home>/.claude/jobs/<id>'` で
     失敗する（API への通信も拒否される）。その場合は sandbox の外でコマンドを実行できる経路で `bg_command` を
     実行し、それも無ければ `bg_command` を人間に示して起動を頼む
2. 各 run が LGTM に達したら人間が merge する（merge は常に人間）
3. merge 後にもう一度 `dev-flow-ready-set` を実行し、新しい `launch[]` で次の波を起こす。blocker の close や
   in_flight の解消で `waiting[]` / `in_flight[]` にいた issue が launch に上がってくる

分類は closed → 出力しない / `human-task` ラベル → waiting `human_task` / open な blocker → waiting `blocked_by`
（判定は prerun と共有の `_lib/scripts/issue-blockers.sh`）/ open な linked PR・`feature/issue-<N>` の local branch・
worktree → in_flight / それ以外 → ready。ready は番号の昇順に貪欲に選び、in_flight と既に選んだ issue の
変更対象パスと重なるものは waiting `path_conflict` に回す。

- **`--with-in-flight`**: 渡した候補に加え、今走っている他 issue（head が `feature/issue-<N>` の open PR・
  `feature/issue-<N>` の local branch・その branch か `df-<N>` の worktree）を自動で in_flight に入れ、その
  変更対象パスを占有にする。無しでは渡した候補の中しか見ないので、別セッションで実行中の run とのパス衝突は
  検出されない。自動で拾った issue は human-task / blocker を見ずに in_flight とし（実際に走っているので占有
  から漏らさない）、closed は残骸として出力しない。`--with-in-flight` 単独なら実行中の一覧だけを返す
- 相手が `## 変更対象パス` の無い issue で全パスと重なっただけなら、`detail` の番号に `(変更対象パスなし)` が付く。
  その issue に申告を足せば再実行で解ける

- **パス申告は見積もり**: 重なり判定は issue 本文の `## 変更対象パス` だけを見る。実際の diff は申告からはみ出し
  得るので、launch に並んでも衝突しないことの保証にはならない。はみ出しによる衝突は pr-iterate の mergeable
  確認と人間の merge 順で吸収する。判定は誤って並列にするより直列に倒す側に寄せてある（glob は静的 prefix に
  縮めて比べ、`## 変更対象パス` が無い・空の issue は全パスと重なる扱いで、他に何も選ばれていないときだけ単独で
  launch、それ以外は waiting `no_declared_paths`）
- **lockfile は常に衝突扱い**: `package-lock.json` / `pnpm-lock.yaml` / `yarn.lock` / `bun.lockb` / `Cargo.lock` /
  `go.sum` / `flake.lock` / `uv.lock` / `poetry.lock` は repo 内のどこにあっても互いに重なりとみなす（依存追加は
  別 issue でも同じ lockfile を書き換え、merge 時に必ず衝突するため）。依存を足す issue は lockfile を申告に含める
- **読み取り失敗は ok:false**: gh の読み取りに失敗すると `{"ok":false,"error":...}` で非 0 終了する（失敗した
  issue を ready に倒さない）

## needs_clarification の扱い

`source: "blocked_by"` は open な blocker（GitHub の issue dependencies と本文の `Blocked by #N` 行。
人手作業の human-task issue など）が残っているための停止で、`missing_context` に未完了 issue の
番号と URL が並ぶ。AskUserQuestion で要件を聞き直さず、その未完了 issue をそのまま人間に提示し、
「完了・close した後に `/dev-flow` を再起動する」よう案内して終える（worktree は保持したまま。
再起動時は下記と同じく手順2 からやり直す）。blocker の読み取りに失敗した場合は
`source: "analyze_prerun"` で止まる（fail-closed）。

それ以外の `needs_clarification` は、AskUserQuestion で人間に確認したうえで、
**同じ worktree を保持したまま手順2 から**やり直す（`dev-flow-prerun` を同じ `--worktree` で
再実行 → 手順2b の `ensure-worktree-deps --setup` を再実行 → その新しい stdout JSON を `setup` として
手順4 を起動。手順3 は既に入っているので不要）。
前回の `setup` object を使い回してはならない: isolation probe の token は `setup.epoch` 固定で、
run 内に前回 probe ファイルの cleanup が無いため、同じ epoch で再起動すると Write-only agent が
既存の `.devflow-tmp/.isolation-probe-<epoch>` へ上書きを試みて `written:false` → fail-closed
abort する。`dev-flow-prerun` は再利用経路で `.devflow-tmp` を clean し新しい `epoch` を返すので
衝突しない。
