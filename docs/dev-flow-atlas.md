# i dev-flow Pipeline Atlas

GitHub issue から LGTM までを 8 phase で駆動する `dev-flow` の実処理を図で示す。
すべて実装ソース（`plugins/dev-flow/.claude/workflows/dev-flow.js` /
`plugins/dev-flow/.claude/workflows/pr-iterate.js` /
`.claude/rules/dev-flow.md`）から起こしたもので、要約や理想形ではない。

規約・設計判断の正典は [`.claude/rules/dev-flow.md`](../.claude/rules/dev-flow.md)。
本ドキュメントはその視覚的な索引であり、両者が食い違う場合は rules 側が正しい。

## 不変条件

どのモデル世代でも緩めない。

- **merge は常に人間。** LGTM 後にユーザーが merge する。AUTO tier も「推奨ラベル」であって
  自動 merge ではない。全 tier で例外なし
- **1 issue = 1 PR。** Implement は全 shape で `dev-implementer` を単一 worktree に 1 spawn する
  （parallel fan-out は持たない）。issue 分割も integration branch も使わない
- **軸A invariant。** 決定論オラクル・danger-grep の fail-closed・critical アイテムはどの `gate_policy` でも
  blocking。policy で緩めない
- **後方互換 scaffolding を作らない。** enum 外の値は legacy fallback ではなく明示 error にする

---

## 1. パイプライン全体

wrapper skill が worktree を用意して `EnterWorktree` した上で、dynamic workflow `dev-flow-run` を
起動する。phase 遷移とループは workflow script が JS で保持し、中間 state は外部 JSON ではなく
script 変数に持つ。

まず概観を示し、続いて 8 phase を 1 phase 1 節で展開する。

### 1.1 概観

```mermaid
flowchart TD
    U["/dev-flow ISSUE"] --> PF["wrapper preflight<br/>dev-flow-prerun（base → worktree → clean → analyze ‖ stack）<br/>→ ensure-worktree-deps --setup（deps install）<br/>→ EnterWorktree"]
    PF --> W["Workflow: dev-flow-run<br/>args.setup = ensure-worktree-deps の JSON<br/>（prerun の出力 + deps / epoch_end）"]
    W --> S["1. Setup"]
    S --> I["2. Implement"]
    I --> V["3. Validate"]
    V --> SF["4. Diff triage"]
    SF --> E["5. Evaluate"]
    E --> R["6. PR"]
    R --> FR["7. Final reconcile"]
    FR --> MT["8. Merge tier"]
    MT --> HU["merge は常に人間"]

    S -.->|"fail-closed"| AB["throw / workflow abort"]
    V -.->|"空 diff が 2 回連続"| AB
    S -.->|"analyze ゲート（Setup 末尾）:<br/>prerun analyze 失敗 / AC 空 /<br/>comment 矛盾 / Jev 未確定"| NC["needs_clarification<br/>worktree は保持"]
    I -.->|"NEEDS_CONTEXT"| NC
    SF -.->|"risk 欠落・実行不能"| FC["fail-closed<br/>merge tier HOLD 強制"]
```

破線は正常系から外れる経路。`needs_clarification` は worktree を保持したまま返るので、
人間が確認して `dev-flow-prerun` から再起動すれば同じ worktree が再利用される（`setup` は
再取得する — 前回の epoch を使い回すと isolation probe のファイル名が衝突して abort する）。

### 1.2 Setup

決定論処理（base 解決・worktree 作成/再利用と起点検証・`.devflow-tmp` clean・
issue analyze・stack 検出）は run 前に wrapper skill が top-level の Bash 1 コマンド
`dev-flow-prerun` で済ませる。prerun は deps install をしない。install は依存の postinstall（対象 repo の
任意コード）を走らせるので、repo の任意コードを実行しない prerun の子にせず、wrapper が別の Bash 呼び出し
`ensure-worktree-deps --setup <worktree>/.devflow-tmp/prerun-setup.json` で回す。その stdout JSON（prerun の出力に
`deps` / `epoch_end` を足したもの）を `args.setup` として渡す。analyze 段（`prerun-analyze.sh`:
`analyze-issue --contract` の決定論 parse + Jev 有界判定）は stack 検出（detect-stack）と並列に走る。
Setup phase の spawn は末尾の analyze ゲート判定後だけ: ゲートが引いたときは `analyze-clarify#N` 1 本で終端し、
通過したときは観測型判定が prerun で確定しない AC があれば `ac-observational#N` を 1 本、続けて isolation probe を 1 本。

```mermaid
flowchart TD
    PR["wrapper: dev-flow-prerun<br/>base → worktree → clean → analyze ‖ stack<br/>→ 別の Bash 呼び出しで ensure-worktree-deps --setup（deps install）<br/>JSON 1 行を args.setup へ"] --> IN["Workflow 起動"]
    IN --> S1["validatePrerunSetup(args.setup)<br/>純関数・spawn なし"]
    S1 --> OUT["Setup 末尾の analyze ゲートへ（下図）"]

    PR -.->|"ok:false"| STOP["wrapper が停止し人間へ報告"]
    S1 -.->|"setup 欠落 / ok:false<br/>必須キー欠落"| AB["throw / abort"]
```

`dev-flow-prerun` の各段は独立に `ok:false` を報告し後続段を巻き込まない。base は明示指定なら
origin に存在するか検証、未指定なら `origin/dev` → `origin/HEAD` の順。worktree は `--no-track` で作る
（upstream を持たない）。既存 worktree を再利用するときは、branch の reflog の作成記録
（`branch: Created from <ref>`）が `origin/BASE`（または pr-iterate-prerun が作った `origin/feature/issue-N`）かで
起点を検証する。`args.setup` が無い・`ok:false`・必須キー欠落は workflow が
即 throw し、workflow 内 proxy への fallback は置かない（後方互換 scaffolding 禁止）。
worktree は repo 内 `.claude/worktrees/df-N` を優先し、書き込めない
（`worktree_status:"unwritable"`）場合のみ wrapper が repo 外 `repo-wt/df-N` で prerun を再実行する。
isolation probe は wrapper で代替しない — subagent の Write 経路が通ることの検証であり、
top-level の Bash では意味が変わる。

**Setup 末尾: analyze ゲート**

```mermaid
flowchart TD
    PA["prerun（stack 検出と並列）: prerun-analyze.sh<br/>analyze-issue --contract → 決定論 parse<br/>breaking keyword hit → Jev noul<br/>comments present → comment ごとに Jev choice"] --> IN["args.setup.analyze"]
    IN --> A0{"analyze.ok ?"}
    A0 -->|no| NC["needs_clarification<br/>source=analyze_prerun<br/>spawn 0"]
    A0 -->|yes| A1["buildReqFromContract<br/>whitelist 検証 → REQ"]
    A1 -->|"不合格"| AB["throw（prerun 出力の契約違反）"]
    A1 --> A2{"AC 空 / comment_conflicts 非空 /<br/>uncertain 非空 / repo 内外が混ざった AC ?"}
    A2 -->|yes| A3["analyze-clarify（dev-runner）1 spawn<br/>人間向け missing_context を生成"]
    A3 --> NC2["needs_clarification<br/>source=analyze<br/>isolation-probe / 実装 agent は spawn しない"]
    A2 -->|no| AO{"ac_observational に<br/>null（prerun で未確定）?"}
    AO -->|yes| AOA["ac-observational（dev-runner）1 spawn<br/>AC の文面だけで観測型を判定<br/>失敗・判定不能は観測型"]
    AOA --> A4
    AO -->|no| A4["isolation probe<br/>Write tool で書けるか<br/>token = setup.epoch"]
    A4 -->|"written:false"| AB
    A4 --> OUT["Implement へ"]
```

analyze ゲートは Workflow 内では純関数の検証と上図のゲート判定だけで、ゲート自体の spawn は 0。
issue を LLM が転写する工程が無いので provenance 突合・comment_count 突合・scope 切断時の
再実行も無い。決定論で解けない 2 理由だけを prerun が Jev（有界判定モデル、PATH 上の `jev-classify`）に回す:
breaking keyword hit は noul 2 問（後方互換を保たない API / 形式の変更か・既存データの変換を要するか。
古い値を読み込み時に捨てるだけなら両方 no。どちらかが p ≥ 0.9 で `breaking_change=true`、両方 p ≤ 0.1 で
false、それ以外は `uncertain`）、comments present は comment ごとに choice
`{override, conflict, resolved, unrelated}`（state に issue の updated_at と最新 comment の created_at を載せる。
override かつ権限あり = issue 報告者本人 or OWNER/MEMBER/COLLABORATOR → `comment_overrides`、
override だが権限なし / conflict / 低確信 → `comment_conflicts`、本文で決着済みの resolved は無視）。Jev の応答なし・
`DEVFLOW_JEV_DISABLE=1` は `uncertain` に倒す（fail-closed。応答なしは jev-classify の `--reason-file` が返す
原因 — jev-broker に接続できない / jev-broker 経由の失敗 / 鍵なし / Keychain に届かない / Keychain 読み取り失敗 /
タイムアウト / 通信失敗 / 応答不正 — を文言に載せる）。ゲートが引いたときだけ sonnet を
1 spawn（`analyze-clarify#N`）して人間向けの質問文を作る。ゲートを通過した run でも、観測型 AC の判定が prerun で
確定しない（`ac_observational` が null — Jev 低確信・Jev に届かない）AC があれば、AC の文面と issue タイトルだけを読む
`ac-observational#N`（dev-runner）を 1 spawn する（失敗・判定不能の AC は観測型として扱う）。telemetry の `analyze_path` は `contract` / `jev` /
`sonnet`（ゲート後のみ）の 3 値。

### 1.3 Implement

Setup 末尾の analyze ゲート直後に issue から単一 task の plan を合成する（planner 0 回、`implement#synth-plan`。
shape はこの時点では決まっていない — Diff triage で realized diff から決める）。
合成 task の `file_changes` は空で始まり、Implement の返却 `files` を宣言として取り込む。

`dev-implementer`（plan+impl 統合、frontmatter opus）を単一 worktree に 1 spawn する。parallel fan-out・
issue 分割・integration branch は使わない。

```mermaid
flowchart TD
    IN["plan 確定"] --> I1["dev-implementer を 1 spawn<br/>impl:serial:issue-N"]
    I1 --> I3{"status"}
    I3 -->|OK| OUT["Validate へ"]
    I3 -->|BLOCKED| I4["累積 findings を付けて再 spawn<br/>reimpl-blocked#b / BLOCK_MAX"]
    I4 --> I3
    I3 -->|NEEDS_CONTEXT| NC["needs_clarification<br/>source=implement（再分析はしない）"]
```

### 1.4 Validate

```mermaid
flowchart TD
    IN["実装完了"] --> V1["test 実行"]
    V1 --> V2{"green ?"}
    V2 -->|no| V3["green-fix（sonnet）<br/>テスト弱体化は禁止"]
    V3 --> V1
    V2 -->|"yes / no_tests<br/>GREEN_MAX 到達"| V4{"empty-diff gate<br/>origin/BASE と一致 ?"}
    V4 -->|"差分あり"| OUT["Diff triage へ"]
    V4 -->|"空 diff"| V5["cross-repo probe<br/>差し戻し 1 回"]
    V5 -->|"差分あり"| OUT
    V5 -->|"再度空"| AB["throw / abort"]
```

format / lint はこの phase の責務外で、test の結果だけを見る。
`GREEN_MAX` 到達時は red のまま次へ進むが、未解消の状態は merge tier が HOLD で受け止める。

### 1.5 Diff triage

```mermaid
flowchart TD
    IN["test green"] --> C1["diff-triage.sh<br/>統合 exec-proxy・1 呼び出し"]
    C1 --> C2["ephemeral・宣言外・format_only を count から除外"]
    C2 --> C3["classifyShape(req, realizedCount, lineStats)<br/>EFFECTIVE_SHAPE 確定"]
    C3 --> C5{"runEval ?"}
    C5 -->|true| OUT["Evaluate へ"]
    C5 -->|false| SKIP["micro path<br/>evaluator 0 回"]

    C1 -.->|"risk 欠落・実行不能"| FC["fail-closed<br/>SEC 全 unchecked → HOLD"]
```

`diff-triage.sh` は risk（danger-grep）/ files（realized diff）/ struct（structural 分類）/
diffhash / lines（ファイルごとの追加・削除行数。untracked は `wc -l`）を 1 回で返す。フィールドごとに失敗セマンティクスが分かれており、**risk の欠落だけは
fail-closed** で SEC seed を全 unchecked にして merge tier を HOLD へ倒す（軸A invariant）。

`runEval` が true になる条件は次のいずれか。

- `EFFECTIVE_SHAPE` が micro 以外
- danger-grep hit / test-weakening 検出 / plan 宣言外の変更
- green-fix が発生した / dev-implementer が null を返して task を落とした

### 1.6 Evaluate

```mermaid
flowchart TD
    IN["runEval=true"] --> E1["evaluator<br/>standard=1 パス / complex=EVAL_MAX"]
    E1 --> E2{"verdict"}
    E2 -->|"fail: design"| E3["dev-implementer へ fix_feedback 付きで再 spawn（reimpl#i）<br/>DESIGN_REPLAN_MAX で cap"]
    E3 --> E1
    E2 -->|"fail: impl"| E4["同じく reimpl#i<br/>未解消 critical を最優先"]
    E4 --> E1
    E2 -->|pass| A0{"agent AC が satisfied:false ?"}
    A0 -->|"yes（AGENT_AC_REIMPL_MAX まで。standard も延長）"| E5["reimpl#i（fix_feedback に AC-n 未達）"]
    E5 --> E1
    A0 -->|"no / 上限到達"| P0{"reimpl#i が 1 回以上 ?"}
    P0 -->|no| OUT["PR へ"]
    P0 -->|yes| P1["test#post-eval-i（フルテスト 1 回）<br/>red → green-fix#post-eval-i / GREEN_MAX"]
    P1 --> OUT
```

standard は 1 パスのみで差し戻さない。未解消の critical は merge tier の HOLD が担保する。
例外は agent AC（`_lib/ac-actor.mjs` が `（人手）`・staging・本番・外部サービス・issue へのコメント以外と分類した AC）の
未達で、AC の ledger item は既定 gate_policy では advisory のため ledger 収束では拾えない。shape と gate_policy に依らず
`AGENT_AC_REIMPL_MAX` 回まで差し戻して再評価し、それでも未達なら merge tier の `ac_agent_unsatisfied`（取りこぼし）で
HOLD にする。human AC の未達は差し戻さず `ac_human_pending`（人手 AC 待ち）で HOLD にする。
reimpl が 1 回以上走った run だけ、PR 前にフルテストを再実行する（Evaluate 内は AC ごとの redgreen-verify しか
走らず、reimpl が AC 対象外のテストを壊しても Validate では捕まらないため）。red は Validate と同じ green-fix
ループ（`tests:'error'` は green-fix しない）。ここでの green-fix は evaluator が再評価しないので、
Evaluate 時点から tree が変わったことによる `eval_staleness=hash_mismatch` の HOLD（差分ファイル一覧つき）で
テスト弱体化の監査を人間に委ねる。reimpl 0 回の run は spawn しない。

### 1.7 PR

```mermaid
flowchart TD
    IN["Evaluate 完了 / micro path"] --> R1["diff-hash 比較<br/>不一致なら stale-eval"]
    R1 --> R2["pr-artifacts で commit message / PR body 確定<br/>haiku が verbatim 転写 + git commit / push / gh pr create"]
    R2 --> R4{"LITE ?<br/>micro かつ runEval=false<br/>かつ danger clean<br/>かつ ci の AC なし<br/>かつ security review 対象外"}
    R4 -->|yes| LITE["lite route<br/>pr-reviewer 1-pass → ci-check"]
    R4 -->|no| FULL["workflow: pr-iterate"]
    LITE -->|"clean かつ CI green"| OUT["Final reconcile へ"]
    LITE -->|"blocking finding<br/>CI 非 green"| FULL
    FULL --> OUT
```

nested 起動する `pr-iterate` には issue の acceptance criteria と
nested context（cwd / head_ref / repo / epoch）と、Diff triage の敵対的 security review の対象判定
（`security_review`）を渡す。Diff triage は merge-base と作業ツリーの diff を `security-review-scope --working-tree`
で判定し、全ファイルが決定論の許可リスト（指示ファイルでない文書・テスト）に当たる run だけが対象外 — lite route に
入れるのもこの run だけ。

### 1.8 Final reconcile

```mermaid
flowchart TD
    IN["pr-iterate 終端"] --> F0{"fixes_applied が 1 以上 ?"}
    F0 -->|no| FSKIP["skipped<br/>agent 呼び出しゼロ"]
    F0 -->|yes| F1["worktree を PR 最終 HEAD へ ff-sync"]
    F1 --> F2["test suite 再実行"]
    F2 --> F3["changed-files-final で<br/>宣言外を再判定"]
    F3 --> F4["final AC reconcile"]
    FSKIP --> OUT["Merge tier へ"]
    F4 --> OUT
```

`changed-files-final` の結果は Merge tier へ持ち越され、同一 tree に対する再実行を skip する。

### 1.9 Merge tier

```mermaid
flowchart TD
    IN["Final reconcile 完了"] --> M0["merge-tier-facts<br/>(diff-hash / danger-grep / changed-files /<br/>gh pr view / head tree / gh pr checks を 1 spawn)"]
    M0 --> M1["danger 再 reconcile<br/>one-shot security clearance"]
    M1 --> M2["classifyMergeTier"]
    M2 --> M3["終端サマリを PR へ投稿"]
    M3 --> M4["journal telemetry 記録"]
    M4 --> HU["merge は常に人間"]
```

`merge-tier-facts` の diffhash が Diff triage 時点の tree OID と一致すれば、facts の risk / changed
を使わず Diff triage の結果を再利用する。tier の判定ロジックは [4. merge tier 判定](#4-merge-tier-判定) を参照。

---

## 2. shape 判定

shape は Setup 末尾の analyze ゲートでは決めない。Implement 後の Diff triage で `classifyShape(req, realizedCount, lineStats)` が
realized diff のファイル数（ephemeral・宣言外・format_only を除外した数）・ファイルごとの追加/削除行数と issue 由来の決定論特徴量
（AC 数 / `issue_type` / 構造化 `breaking_change`）で **1 回で** 決め、その返り値が `EFFECTIVE_SHAPE`
になる。LLM の事前見積もりは入力にならない。入力が欠けていたり（realized count 取得不能）enum 外だったり
した場合は例外なく complex へ落ちる安全弁が効く。floor を通過した run だけ、行数が全ファイル分取れていれば
差分の中身で下げ方向に補正する（docs と対応本番ありのテストを数えない / 削除主体なら 1 段下げ / complex は
追加 100 行超のときだけ。テストだけの run は補正しない）。micro の LITE 経路に対する意味的リスクの安全網は
runEval 強制条件（danger-grep / testsurf / green-fix / dropped task / 宣言外変更 / UI 接触）が担う。

```mermaid
flowchart TD
    START["Diff triage: req + realized diff"] --> F1{"realized file count<br/>が有限の数値 ?"}
    F1 -->|"no（取得不能 NaN）"| CX["shape = complex"]
    F1 -->|yes| F2{"acceptance_criteria<br/>が配列 ?"}
    F2 -->|no| CX
    F2 -->|yes| F3{"issue_type が<br/>feat/fix/docs/refactor/chore/test/perf/ci ?"}
    F3 -->|no| CX
    F3 -->|yes| F4{"breaking_change が true ?"}
    F4 -->|yes| CX
    F4 -->|no| F5{"realized count と AC 数"}
    F5 -->|"count ≤ 2 かつ AC ≤ 4"| MI["shape = micro"]
    F5 -->|"count ≤ 5 かつ AC ≤ 6"| ST["shape = standard"]
    F5 -->|"それ以外"| CX2["shape = complex"]

    MI --> F6{"全ファイルの行数あり<br/>かつ test だけの run でない ?"}
    ST --> F6
    CX2 --> F6
    F6 -->|no| ES["EFFECTIVE_SHAPE 確定"]
    F6 -->|yes| CR["重み（docs・対応本番ありの test を除外）<br/>+ 追加行数（complex は > 100 行）<br/>+ 削除主体（追加 < 削除×0.3）で 1 段下げ<br/>（file 数判定より上げない）"]
    CR --> ES
    CX --> ES
```

### 3 tier の経路差

| shape | Implement | Evaluate | merge tier |
| --- | --- | --- | --- |
| `micro` | Setup 末尾の analyze ゲート直後に issue から単一 task の plan を合成（`implement#synth-plan`）→ Implement で `dev-implementer` を 1 spawn | skip（evaluator 0 回）。danger-grep hit 時は security path で強制実行 | `AUTO`（docs・test-only + danger clean + 収束時のみ） |
| `standard` | 同上 | 1 パスのみ。差し戻しなし。未解消 critical は merge tier HOLD で担保。agent AC の未達だけは `AGENT_AC_REIMPL_MAX` 回まで延長して差し戻す | `REVIEW` |
| `complex` | 同上 | 差し戻し loop（`EVAL_MAX` 上限、design 差し戻しは `DESIGN_REPLAN_MAX` まで。差し戻し先は同じ `dev-implementer`） | `REVIEW` / `HOLD`（danger・breaking 検出時） |

micro のうち `runEval=false` かつ danger clean かつ ci の AC（`ci_verify` の check で判定する AC。
`CI_AC_INDEXES`）を持たず、敵対的 security review の対象外（merge-base 基準の diff が許可リストだけ）のものだけが
PR phase で **lite route** に入り、
pr-reviewer 1-pass と CI green だけで終端する。blocking finding か CI 非 green を検出した時点で
通常の pr-iterate へ自動昇格する。

---

## 3. pr-iterate ループ

`pr-iterate`（workflow 名 `pr-iterate-run`）は dev-flow から入れ子で呼ばれるほか、`/pr-iterate` の wrapper skill
（`pr-iterate-prerun` で PR head の worktree を用意 → EnterWorktree）から単体でも起動できる。どちらも `args.nested` を
渡すので pr-meta / isolation-cleanup は起動しない（終端サマリーの投稿は単体起動だけ）。approve が出ても
CI gate を通らなければ LGTM にならず、**CI pending を成功扱いすることは決してない**。
同じ topic が `REVIEW_STUCK` 回繰り返された時点で stuck と判定して人間へ渡す。

CI gate を通った round でも、LGTM を確定する前に **敵対的 security review** の gate がある。今の PR head の
`<base>...<head>` の diff を `security-scope#i` が決定論の許可リストで判定し、起動時の判定（`args.security_review`。
無ければ対象）か run 中の判定のどれか 1 回でも対象なら run の終わりまで対象のまま。対象なら `security-reviewer` を
毎回新しく spawn して PR 全 diff（worktree の外に保存した file）を読ませ、critical / major が 0 件かつ `reviewed_sha` が
今の head と一致したときだけ LGTM にする。critical / major は fix に回し（同じ指摘の反復は stuck）、worktree の外を
指す指摘・diff を取れない・review が結果を返さない・head 不一致は `security_unresolved` で終端する。終端サマリーには
指摘の件数だけを載せる。

```mermaid
flowchart TD
    IN["pr-iterate PR 番号<br/>MAX / REVIEW_STUCK<br/>nested 起動時（dev-flow / /pr-iterate wrapper）は<br/>pr-meta / isolation-cleanup を skip<br/>（isolation probe 本体は不変で実行）"] --> LOOP["iteration i"]
    LOOP --> REV["pr-reviewer が実 diff を宣言意図に照合<br/>issue の acceptance criteria も判定に含める"]
    REV --> D{"decision"}
    REV -.->|"結果を返さない /<br/>approve と blocking の矛盾が<br/>1 回の再 review 後も再発"| RCE["status: review_contract_error"]

    D -->|approve| CI["ci-check 1 spawn = 1 判定<br/>gh pr checks → check-ci.sh<br/>pending なら script 側 ci-wait ループ（上限 CI_WAIT_CEILING_SECONDS）"]
    D -->|"request_changes / comment"| BL{"blocking findings あり ?"}

    CI --> CS{"status"}
    CS -->|"passed / no_checks"| SEC{"security review<br/>対象 ?"}
    SEC -->|"対象外"| LGTM["status: lgtm"]
    SEC -->|"対象: critical / major 0 件<br/>かつ reviewed_sha が今の head"| LGTM
    SEC -->|"対象: critical / major あり"| STK3{"同一 topic が反復 ?"}
    STK3 -->|yes| STUCK
    STK3 -->|no| FIX
    SEC -->|"worktree の外を指す /<br/>diff・結果・head が揃わない"| SECU["status: security_unresolved"]
    CS -->|error| ERR["status: ci_error<br/>CI 状態を確定できない<br/>（proxy が結果を返さない / gh 取得失敗 /<br/>status と件数の食い違い）"]
    CS -->|pending| PEND["status: ci_pending<br/>ceiling 到達・never auto-approve"]
    CS -->|failed| CIF["CI failure を findings 化"]

    CIF --> STK1{"同一 topic が反復 ?"}
    STK1 -->|yes| STUCK["status: stuck"]
    STK1 -->|no| FIX

    BL -->|no| CI
    BL -->|yes| STK2{"同一 topic が反復 ?"}
    STK2 -->|yes| STUCK
    STK2 -->|no| FIX["fix agent が修正適用"]

    FIX --> AP{"applied が true ?"}
    AP -->|no| FF["status: fix_failed"]
    AP -->|yes| CM{"ensureFixCommitted<br/>commit + push 成功 ?"}
    CM -->|no| FF
    CM -->|yes| NEXT{"i が MAX 未満 ?"}
    NEXT -->|yes| LOOP
    NEXT -->|no| MAXR["status: max_reached"]
```

### 終端 status

| status | 意味 | dev-flow 側の扱い |
| --- | --- | --- |
| `lgtm` | review clean かつ CI passed / no_checks（security review の対象なら今の head で clear） | Final reconcile へ。`fixes_applied` が 1 以上なら最終 tree を再検証 |
| `stuck` | 同一 topic が反復（review / CI failure） | merge tier `HOLD` |
| `fix_failed` | fix 未適用、または commit / push の保証に失敗 | merge tier `HOLD` |
| `max_reached` | `MAX` iteration で収束せず | merge tier `HOLD` |
| `ci_error` | CI 状態を確定できない（ci-check の proxy が結果を返さない / check-ci の gh 取得失敗 / proxy の status と件数の食い違い）。`gh pr checks` で実状態を確認する | merge tier `HOLD` |
| `ci_pending` | checks 未完了。自動承認しない | merge tier `HOLD` |
| `review_contract_error` | pr-reviewer が schema-retry 後も結果を返さない、または decision=approve と blocking の矛盾が 1 回の再 review 後も再発 | merge tier `HOLD` |
| `security_unresolved` | 敵対的 security review を今の head で clear にできない（worktree の外を指す critical / major・diff を取れない・review が結果を返さない・review した head が今の head と違う） | merge tier `HOLD`（`security_review_unresolved`） |

---

## 4. merge tier 判定

`classifyMergeTier` は純関数で、HOLD 理由の配列が空でなければ無条件に HOLD を返す。
AUTO は micro かつ docs/test-only かつすべての HOLD 条件が不成立のときだけで、それでも
「推奨ラベル」であり **merge 操作そのものは人間が行う**。

```mermaid
flowchart TD
    IN["classifyMergeTier の入力<br/>ledger / danger / AC / iterate status / mergeable ほか"] --> H{"HOLD 理由が<br/>1 つでも成立 ?<br/>（下表）"}

    H -->|"1 つでも成立"| HOLD["HOLD<br/>人間 review 必須"]
    H -->|"すべて不成立"| A{"shape が micro かつ<br/>docs / test-only ?"}
    A -->|yes| AUTO["AUTO<br/>推奨ラベル<br/>micro eval skip なら AC 未検証を開示"]
    A -->|no| REVIEW["REVIEW<br/>標準 — 人間が LGTM"]

    HOLD --> D["開示行を reasons に追記<br/>tier 判定値は不変"]
    AUTO --> D
    REVIEW --> D
    D --> M["merge 操作は常に人間<br/>全 tier 共通の不変条件"]
```

### HOLD 理由（1 つでも成立すれば HOLD）

`_lib/merge-tier.mjs` の `HOLD_REASON_CODES` と 1 対 1 に対応する（`_lib/devflow-docs-counts.test.mjs` が照合する）。

| code | 条件 | 備考 |
| --- | --- | --- |
| `ledger_unconverged` | ledger 未収束（未 checked の blocking item が残る） | |
| `danger_unresolved` | danger-grep hit 未解消 | |
| `breaking_structured` | `breaking_change=true`（構造化判定） | keyword 単独 hit は不採用 |
| `escalate` | ESCALATE-TO-HUMAN 項目あり | |
| `ac_agent_unsatisfied` | agent AC が差し戻し上限後も未達（取りこぼし） | |
| `ac_human_pending` | 人手 AC 待ち（worktree 外作業・実行環境に届かない検証を要する AC が未達） | |
| `ac_ci_pending` | ci の AC が pr-iterate の LGTM 後の待ちで success にならない（CI 判定待ち） | |
| `merge_facts_dropped` | merge-tier-facts の応答から danger-grep の結果（`risk.value`）が落ちた | danger-grep 自体は実行済みの可能性あり。security 未検証として扱う |
| `danger_fail_closed` | danger-grep 実行不能 | fail-closed |
| `final_reconcile_unavailable` | Final reconcile 再検証不能（同期失敗・test#final の null / `tests:'error'`） | PR の CI の success では解除しない |
| `final_test_red` | final test red | 落ちたファイルだけの 1 回の再実行で green なら flake として HOLD にしない |
| `validate_test_red` | Validate test red のまま PR へ進行し、pr-iterate の fix が 0 件で Final reconcile が skip された | PR tree のテスト状態は Validate の結果のまま。落ちたファイルだけの 1 回の再実行で green なら flake として HOLD にしない。gate_policy に依らず人間確認 |
| `validate_tests_not_run` | Validate が `tests:'error'`（テストが 1 件も実行されていない）で Final reconcile が skip された | PR の CI の success では解除しない。Setup(deps) が `ok:false` なら note を理由に載せる |
| `final_ac_unavailable` | Final AC reconcile 判定不能 | |
| `iterate_non_lgtm` | pr-iterate が `lgtm` 以外で終端 | |
| `hash_mismatch` | `eval_staleness = hash_mismatch` | 評価済み tree と merge 対象 tree の乖離 |
| `testsurf_uncleared` | test-weakening 未クリア | |
| `mergeable_conflicting` | base branch と conflict（`CONFLICTING` / `DIRTY`） | `UNKNOWN` は fail-open |
| `pr_closes_missing` | PR body に `Closes #<issue>` 行が無く、本文の再投入も失敗 | 決定論再チェックで解消しうる |
| `ci_checks_failed` | PR head の CI checks が red（bucket が fail / cancel / 未知値） | pending・取得不能は HOLD にせず開示行だけ |
| `security_review_unresolved` | 敵対的 security review の対象の run で、pr-iterate が今の PR head で clear にしていない（LGTM 以外で終端した run を含む） | 指摘の本文は公開しない。件数だけを出す |

### gate_policy に依らず常に blocking

軸A invariant により、以下は `gate_policy` の設定に関係なく blocking のまま。

| 理由 | なぜ緩めないか |
| --- | --- |
| AC 未達 | `acceptance_criteria` が `satisfied:false` |
| Final AC reconcile 判定不能 | agent null / schema 不一致 / evidence 不足 |
| pr-iterate 非 LGTM 終端 | review ⇄ fix loop が LGTM 未到達 |
| `eval_staleness = hash_mismatch` | 評価済み tree と merge 対象 tree の乖離 |
| base branch conflict | `mergeStateStatus=DIRTY` / `mergeable=CONFLICTING` |
| danger-grep 実行不能 | security 未検証のまま出荷しない fail-closed |
| 敵対的 security review 未 clear | 信頼境界をまたぎうる変更を critical / major が残ったまま出荷しない。対象判定できない入力は対象 |

`mergeable` が `UNKNOWN` の場合や proxy 失敗は fail-open で、definitive な `CONFLICTING` / `DIRTY` の
ときだけ HOLD する。breaking の keyword scan 単独ヒットは HOLD 理由に採用せず、構造化判定
`breaking_change=true` と組み合わさったときだけ blocking になる（単独ヒットは可視化のみ）。
evaluator が `verdict=fail` のまま PR へ進んだ run も同じ扱いで、開示行だけが reasons に入り
tier は動かない。

---

## 5. 定数と担当 agent

### ループ上限

<!-- atlas:loop-constants:begin -->

| 定数 | 値 | 効く場所 |
| --- | --- | --- |
| `EVAL_MAX` | 10 | complex の evaluate 差し戻しループ |
| `EVAL_STUCK` | 2 | 同一 topic 反復での design churn 打ち切り |
| `DESIGN_REPLAN_MAX` | 2 | design 差し戻し（replan + reimpl）の hard cap |
| `GREEN_MAX` | 3 | Validate と Evaluate 差し戻し後の PR 前再テストの test green 差し戻し |
| `BLOCK_MAX` | 2 | BLOCKED 由来の再計画 |
| `AGENT_AC_REIMPL_MAX` | 2 | agent AC の未達を理由にした evaluate 差し戻し（standard も延長） |
| `REVIEW_STUCK` | 2 | pr-iterate の同一 topic 反復での stuck 判定 |
| `CI_WAIT_CEILING_SECONDS` | 300 | pr-iterate の CI pending 待ち（script 側 ci-wait ループ）の nominal 総待機上限（秒）の既定値。prerun が base branch の CI 所要時間から決めた `args.ci_wait_ceiling_seconds`（300〜900）があればそちらを使う |

<!-- atlas:loop-constants:end -->

この表の値は `plugins/dev-flow/_lib/atlas-constants.test.mjs` が実装ソースと照合する。
ソース側の定数を変えたらこの表も更新しないと CI が落ちる。

pr-iterate の `MAX`（review ⇄ fix 反復、既定 10）は `args.max_iterations` で上書きできるため
上表には含めない。

### subagent の役割分担

| agent | 役割 | model / effort |
| --- | --- | --- |
| `dev-implementer` | plan+impl 統合実装（全 shape の唯一の実装 agent。Implement・BLOCKED 再実装・green-fix・evaluator 差し戻しを担う） | opus / high |
| `evaluator` | 実装品質ゲート | opus / medium |
| `pr-reviewer` | PR レビュー | opus / high |
| `security-reviewer` | 敵対的 security review（LGTM の前。PR 全 diff を worktree の外で読み取り専用に読む） | opus / high |
| `pr-fixer` | pr-iterate の fix（`fix#i` / `fix#i-retry`。maxTurns 100） | opus / medium |
| `dev-runner` | Setup 末尾の analyze ゲート後の `analyze-clarify#N`（missing_context 生成）と `ac-observational#N`（観測型 AC の分類）。通常経路の Setup では起動しない | sonnet / high |
| `dev-runner-haiku` | 書き込み・Skill 呼び出しを伴う exec-proxy | haiku / low |
| `dev-runner-haiku-ro` | read-only exec-proxy | haiku / low |
| `dev-runner-haiku-wo` | isolation probe 専任（Write のみ） | haiku / low |

model は subagent の frontmatter で決める。品質ゲート agent の call site は `opts.model` を渡さない
（evaluator / pr-reviewer の model を変えるなら `agents/*.md` の frontmatter を変える）。

effort も subagent の frontmatter で決める。`agent()` の `opts.effort` は frontmatter より優先して
実効値に反映される（transcript で確認済み。`dev-flow-canary` の `agent_opts_effort_accepted` probe は
受理可否だけを測る）が、dev-flow.js / pr-iterate.js の call site は opts で effort を渡さない。

---

## 補足

dev-flow は Workflow に依存するため **Claude 専用**で、cross-vendor portability を放棄する
唯一の例外扱いである。

本ドキュメントは実装ソースから起こした図であり、仕様書ではない。
dev-flow 本体（`plugins/dev-flow/.claude/workflows/` / `plugins/dev-flow/.claude/agents/` /
`plugins/dev-flow/_lib/` / `tools/`）を変更したら、
この図も同じ PR で更新すること。変更の経緯は git log を参照。
