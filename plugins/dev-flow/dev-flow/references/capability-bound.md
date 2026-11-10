# capability-bound な判断

モデル性能・harness（Claude Code の workflow runtime・subagent・plugin loader）の能力しだいで見直す判断だけを置く。
モデル世代で変わらない不変条件（incentive-structural / blast-radius / contract）は `.claude/rules/dev-flow.md` にあり、
ここの判断を見直すときもそれは緩めない（軸A・human merge・fail-closed の理由）。

モデルか harness が更新されたら、このファイルだけを見直す。各項目の「sunset トリガ」に当たったものを「次のモデル世代での
測り直し方」に従って測り、撤去・緩和は issue → PR にする（merge は人間）。

本文のパスは `plugins/dev-flow/` を root とする plugin 相対パス（`tools/` と `.claude/rules/` は repo root）。

各項目は次の 4 欄を持つ（`_lib/devflow-rules-hygiene.test.mjs` が検査する）:

- **何をするか** — 今の仕組み
- **なぜ** — どの能力の不足を補っているか
- **sunset トリガ** — 見直しを始める合図。コードにある信号（`dev-flow-canary` の probe）か、major モデルリリースごとの dry-run。
  dry-run は、dev-flow-health が dev-flow の agent の解決後の model ID の変化（レポートの `model_changes`）を見つけて起票した
  self-improve issue を合図に回す（`agents/*.md` の `model:` は別名なので、世代が変わってもファイルに差分が出ない）
- **次のモデル世代での測り直し方** — 何を回し、何を見て撤去・緩和を決めるか

`dev-flow-canary` は `Workflow({ name: 'dev-flow:dev-flow-canary' })` で起動する read-only の capability canary
（`.claude/workflows/dev-flow-canary.js`）。probe ごとの pass / fail / unsupported を report JSON に書くので、直近世代の
report と比べて読む。

## 項目

### gate_policy の既定（LLM の major を advisory にする）

- **何をするか**: `_lib/gate-policy.mjs` の `DEFAULT_GATE_POLICY` を `llm-major-advisory` にし、evaluator の LLM major を
  収束・Merge tier の blocking に含めない（`gateLane`）。critical・決定論 check・seed は policy に依らず blocking で、
  ここの対象外（軸A）
- **なぜ**: LLM judge の major 判定は誤検知が多く、blocking にすると正しい変更を差し戻し続ける。判定精度はモデル世代で上がる
- **sunset トリガ**: major モデルリリースごとの dry-run
- **次のモデル世代での測り直し方**: evaluator の frontmatter model を新世代にして merge 済みの過去 run を replay し、major 指摘の
  うち人が merge 前後に直したもの（正しい指摘）と直さず merge したもの（誤検知）を数える。誤検知が blocking に耐える水準なら
  `DEFAULT_GATE_POLICY` を `llm-major-blocking` へ進める issue を立てる

### pr-iterate の major 閾値

- **何をするか**: pr-iterate は pr-reviewer の critical と major を blocking にし（`.claude/workflows/pr-iterate.js` と
  `_lib/review-normalize.mjs` の blocking 抽出）、gate_policy に連動させない。merge 直前の最終ゲートとしての
  critical/major-always-blocks は blast-radius（rules）で、critical は sunset しない。見直すのは major を blocking に含める線引きだけ
- **なぜ**: major と minor の線引きは pr-reviewer の判定精度に依存する
- **sunset トリガ**: major モデルリリースごとの dry-run
- **次のモデル世代での測り直し方**: pr-reviewer の frontmatter model を新世代にして過去 PR を replay し、major 判定と人の merge
  判断（直した / そのまま merge した）を突き合わせる。精度が実証されるまで major を advisory にしない。実証できたら pr-iterate の
  major blocking を `gateLane` 連動にする issue を立てる

### redgreen vdelta の deny-only

- **何をするか**: redgreen の R1↔R2 で `_lib/vdelta-transitions.mjs` の `vdeltaDenies` が veridelta の verdict から deny を
  出し、red&&green の決定論昇格に deny の `&&` 節としてだけ効かせる。blocking gate にはしない。verdict 不明は fail-open、
  `comparability` が `exact` でなければ abstain
- **なぜ**: test 変更込みの勝利宣言を見抜く信号だが、veridelta の record_integrity は advisory で、verdict の precision が
  blocking に耐えると示されていない
- **sunset トリガ**: major モデルリリースごとの dry-run
- **次のモデル世代での測り直し方**: 過去 run の redgreen を replay して `vdeltaDenies` の `status`（`deny` / `clean` /
  `abstain` / `fail_open`）を集計し、deny が実際に test 変更込みの勝利宣言だったかを人が確かめる。precision が実証され、
  veridelta が record_integrity を advisory 以外で返すなら blocking gate 化を issue にする

### exec-proxy の橋

- **何をするか**: workflow script から決定論 script を直接実行できないため、`agents/` の dev-runner 系 subagent に `bin/` の
  bare 名を実行させ、stdout を verbatim で返させる。agent は capability 別に分け、frontmatter に有限の `maxTurns` を置く
  （担当・tools は `agents/*.md` の frontmatter、proxy ごとの失敗ポリシーは `dev-flow/references/exec-proxy.md`）。起動形の不変条件は rules
- **なぜ**: workflow runtime に fs / exec が無い
- **sunset トリガ**: `dev-flow-canary` の `direct_shell` と `direct_fs` が pass
- **次のモデル世代での測り直し方**: Claude Code の更新後に `dev-flow-canary` を回す。report の
  `bridge_sunset.exec_proxy_removable` が true（両 probe が pass）なら exec-proxy の
  prompt 群を直接実行に置き換え、dev-runner 系 agent ごと撤去する issue を立てる

### CI polling の turn 会計

- **何をするか**: CI 待ちは 1 spawn = 1 判定・ループは script 側（`.claude/workflows/pr-iterate.js` と dev-flow の lite route）。
  初回 poll は `ci-check`、2 回目以降は `ci-wait-check`（`check-ci --wait` が待ってから 1 回判定する 1 単文）。polling ループを subagent 内に
  置かない。総待機上限は `args.ci_wait_ceiling_seconds`（未指定は `_lib/ci-check.mjs` の `CI_WAIT_CEILING_SECONDS`）。
  1 spawn の必要 turn（`CI_TURN_MARGIN` を含む）は中継の agent（`agents/stdout-relay.md`）の `maxTurns` を超えない（`_lib/ci-check.test.mjs` が
  agent md を実読して検査）。応答が `slept:true` でなければ積算せず、同じ応答の status も採らずに `ci_pending` で終端する
- **なぜ**: subagent の turn 会計は CI の所要時間に連動し、ループを subagent に置くと StructuredOutput 未達で `ci_error` に
  化ける。待機を check-ci の中の `ci-wait.sh` にする理由は下の「長い bare `sleep` の拒否」。`CI_TURN_MARGIN` は model が 1 判定に使う tool call 数の
  ばらつきを吸収する
- **sunset トリガ**: `dev-flow-canary` の `direct_shell` が pass（workflow が自分で待って CI を読める）。`CI_TURN_MARGIN` は
  major モデルリリースごとの dry-run
- **次のモデル世代での測り直し方**: `direct_shell` が pass なら polling を workflow 内へ移す issue を立てる。dev-flow-health の
  `model_changes` で `stdout-relay` の model ID の変化が起票されたら実 PR で `ci-check` / `ci-wait-check` を回し、
  transcript の API リクエスト数と文書化した手順数の差が `CI_TURN_MARGIN` に収まるかを見る

### inline generator の橋

- **何をするか**: `_lib` の canonical のうち、その workflow から参照される最上位宣言だけを `tools/sync-inlines.mjs` が
  workflow の `// ==== BEGIN inline:` 区間へ canonical の宣言順で生成する。参照は手書き部分の識別子から、生成した宣言の本文の
  識別子をたどって区間をまたいで決める（文字列・テンプレートの中も数える）。宣言名を決められない最上位の文は常に残す。
  宣言が 1 つも残らない区間は `--write` / `--check` が非 0 で止まるので `--remove` で区間ごと消す。区間との一致は generator と
  同じ `planInlineRegions` で `_lib/workflow-inlines.sync.test.mjs` が検証する。
  生成時にコメントを落とす（`dropComments`。literal の中身は保つ）ので、意図・理由のコメントは canonical 側に書く。
  区間の編集・canonical の構造制約・guard の不変条件は rules
- **なぜ**: workflow loader が ESM import を受け付けない。コメントと参照されない宣言を落とすのは、Workflow tool が上限サイズ
  以上の script を登録せず起動不能にするため（上限は `_lib/workflow-inlines.sync.test.mjs` の `WORKFLOW_SCRIPT_MAX_BYTES`。
  上限はファイルごとにかかり、工程を別 workflow に切り出すと同じ canonical が各ファイルに入る）。識別子の数え方は余分に
  残す側に倒す — 取りこぼしは実行時の ReferenceError になる
- **sunset トリガ**: `dev-flow-canary` の `direct_import` が pass
- **次のモデル世代での測り直し方**: Claude Code の更新後に `dev-flow-canary` を回す。report の
  `bridge_sunset.inline_generator_removable` が true ならマーカー区間を `import` 文に
  置き換え、generator・`_lib/workflow-inlines.sync.test.mjs`・inline guard hook（`hooks/hooks.json`）を撤去する issue を立てる

### plugin の bin/ PATH の version 固定

- **何をするか**: plugin の `bin/` はセッション起動時に version 込みで PATH に載る。plugin を更新したら新しいセッションで
  `command -v <bare 名>` を確かめる（plugin の PATH を持たない素のシェルでは常に失敗する。skill の一覧に `/dev-flow` が
  出ることは PATH が正しい証拠にならない）
- **なぜ**: harness の plugin loader が `bin/` の PATH を起動時に固定し、既存のセッション（長寿命の bg を含む）に更新を反映しない
- **sunset トリガ**: major モデルリリースごとの dry-run（同梱の Claude Code 更新を含む）
- **次のモデル世代での測り直し方**: plugin を更新した後、更新前から動いているセッションで `command -v` の解決先が新しい
  version を指すかを見る。指すなら「新しいセッションで確かめる」手順を外す

### 長い bare `sleep` の拒否

- **何をするか**: CI の待機は bare `sleep <秒>` を直接呼ばず、`check-ci --wait <秒>` の bare 単文で行う（check-ci が
  `pr-iterate/scripts/ci-wait.sh` — 短い sleep をつないで同じ総待機時間を作る script — を実行してから 1 回取得する）
- **なぜ**: harness の Bash tool は、呼び出し全体が `sleep <N>` で N が数秒を超える形を拒否する。bare `sleep` では実際には
  待たずに拒否され、待機の会計が実時間からずれる
- **sunset トリガ**: major モデルリリースごとの dry-run（同梱の Claude Code 更新を含む）
- **次のモデル世代での測り直し方**: subagent から長い bare `sleep` を 1 回呼び、拒否されずに実時間だけ待つかを見る。待つなら
  check-ci の中の `ci-wait.sh` の連結を 1 回の `sleep` に置き換える issue を立てる（中継の Bash は check-ci 1 単文のまま）

### 読み取り系 git の optional lock

- **何をするか**: dev-flow の `bin/` wrapper は exec の前に `GIT_OPTIONAL_LOCKS=0` を export し、読み取り系 git が index の
  書き戻しのために `.git/worktrees/*/index.lock` を取りに行かないようにする（`tests/bin-wrappers.bats` が pin）。commit・
  worktree add 等の必須ロックには効かない
- **なぜ**: 起動元 checkout の `.git` が sandbox から書けない場合（harness の組み込み保護や sandbox 設定が write deny している
  場合）だけ、optional lock の取得が EPERM で落ちる。`.git` が書ける checkout では踏まない
- **sunset トリガ**: major モデルリリースごとの dry-run（同梱の Claude Code 更新を含む）
- **次のモデル世代での測り直し方**: worktree 分離セッションで `GIT_OPTIONAL_LOCKS=0` を付けずに `git status` を回し、`index.lock`
  の EPERM が出るかを見る。出なければ wrapper の export を外す issue を立てる

### subagent の model・effort の割り当て

- **何をするか**: 各 subagent の model・effort・`maxTurns` は `agents/` の frontmatter で決める（値は `_lib/agent-frontmatter.test.mjs` が
  pin）。call site は effort を opts で渡さず、品質ゲート agent（evaluator・pr-reviewer・security-reviewer）には `opts.model` も渡さない
  （rules）。override は Validate の green-fix だけで、`dev-implementer` を sonnet で起動する（`_lib/impl-model-default.test.mjs` が pin）。
  pr-iterate の fix は専用の `pr-fixer` の frontmatter で起動する
- **なぜ**: 判定の精度・完走率と所要・コストの釣り合いは、モデル世代ごとに変わる。green-fix は環境起因の blocker 報告か小さな
  test script の修正が中心で implementer と同じ推論を要さず、green-fix が入った run は Evaluate のテスト弱体化監査が強制される。
  `maxTurns` は API リクエスト数で数え、opts では変えられないので frontmatter に置く
- **sunset トリガ**: major モデルリリースごとの dry-run
- **次のモデル世代での測り直し方**: 変える agent の frontmatter だけを新しい model・effort にして merge 済みの過去 run を同じ入力で
  回し直し、verdict と critical/major 指摘の再現・結果を返さずに打ち切られた spawn の数・所要とコストを比べる。品質を落とさずに
  所要かコストが下がるなら frontmatter を変える issue を立てる。品質ゲート agent に `opts.model` を渡さない不変条件は変えない。
  green-fix の override は frontmatter に無いので別に測る。override の別名（`'sonnet'`）が解決された ID の変化を dev-flow-health が
  起票したら（`model_changes` の `dev-flow:dev-implementer` のうち、transcript の prompt が green-fix のもの）、green-fix が入った
  merge 済みの過去 run の green-fix を同じ失敗の入力（同じ commit・同じ失敗したテストの出力）から新しい ID で回し直し、前の ID の
  結果と比べる — green-fix の後に Validate が green になるか・Evaluate のテスト弱体化監査で弱体化と判定されないか・結果を返さずに
  打ち切られた spawn の数・所要とコスト。劣化しなければ override の別名を保ち、劣化するなら別名を変える issue を立てる

### security-reviewer の cwd

- **何をするか**: `agent()` が cwd を受け付けないので、security-reviewer は worktree の cwd で起動する。PR が reviewer の
  session に自動で読み込まれる指示ファイルを変えるときは、Claude 経路の review を clear にせず止める（`reviewer_context_changed`）
- **なぜ**: harness が subagent の cwd を選ばせないため、PR が書いた指示ファイルが reviewer に届く
- **sunset トリガ**: `dev-flow-canary` の `agent_opts_cwd_applied` が pass
- **次のモデル世代での測り直し方**: pass なら reviewer を worktree の外の cwd で起動する形へ移す issue を立てる。
  `reviewer_context_changed` の停止は incentive-structural として残す

### agent 指示の capability-bound な部分

- **何をするか**: `agents/` の指示のうち、現行モデルの取りこぼしを防ぐための手順の分解・禁止表現の列挙・書き直し例・
  判定基準の細かな具体化。指示ごとに contract / incentive-structural / blast-radius / capability-bound を宣言する（rules）。
  evaluator・pr-reviewer・dev-implementer は各 `## ` 節に `正当化クラス: <class>` を書き（`_lib/devflow-rules-hygiene.test.mjs`
  が検査する）、capability-bound を宣言した節は `agents/evaluator.md` の「進め方」「書き方」、
  `agents/pr-reviewer.md` の「ワークフロー」「Step 1-2: 情報・context 収集」「Step 3: 系統的レビュー（dimension）」
  「文体ルール（日本語主体）」「原則」、`agents/dev-implementer.md` の「守ること」「Bash の書き方（worktree 隔離ガード）」
  「進め方の目安」。対象は節のうち capability-bound と宣言した段落・項目だけで、同じ節にある他のクラスの宣言は外さない
- **なぜ**: frontier モデルなら指示なしでも同じ品質が出る指示は、残すほど prompt が膨らむ
- **sunset トリガ**: major モデルリリースごとの dry-run
- **次のモデル世代での測り直し方**: dev-flow-health の `model_changes` で下のどれかの agent の model ID の変化が起票されたら、
  その agent の節だけを測り直す。その agent の capability-bound と宣言した段落・項目を外した agent と外す前の agent を
  同じ入力で回し、下の指標が劣化しないことを確かめてから削る。contract / incentive-structural / blast-radius の指示は外さない
  - `agents/evaluator.md`: merge 済みの過去 run の Evaluate を replay し、verdict と critical/major 指摘の再現が劣化しないこと
  - `agents/pr-reviewer.md`: 過去 PR の review を replay し、review の判定と critical/major 指摘の再現が劣化しないこと
  - `agents/dev-implementer.md`: `dev-flow:dev-implementer` の新しい ID がどの別名から解決されたものかで従う項目を分ける
    （transcript の prompt が Validate の green-fix のものなら override、それ以外は frontmatter）。frontmatter の `model:` の別名から
    来た ID の変化は、merge 済みの過去 issue を同じ base commit から Implement 〜 Evaluate まで回し直し、実装を
    受け取る側の結果が劣化しないこと — evaluator の verdict、Evaluate の差し戻しの回数、Validate が green-fix なしで green に
    なるか（evaluator の指示は変えずに回す。implementer 自身の報告は指標にしない）。green-fix の override の別名から来た ID の
    変化は節を測り直さず、「subagent の model・effort の割り当て」の測り直し方の green-fix の override の手順に従う
