# dev-flow パイプライン詳細

phase 経路 / shape 3 tier / lite route / subagent の model・effort 割り当て / isolation probe /
gate_policy・block_class の詳細。不変条件は `.claude/rules/dev-flow.md` を参照。
本文中の `.claude/workflows/` / `agents/` / `_lib/` / `_shared/` は `plugins/dev-flow/` を root とする
plugin 相対パス。`tools/sync-inlines.mjs` のみ repo root。

## dev-flow (dynamic workflow)

`/dev-flow <issue>` は skill wrapper (`dev-flow/SKILL.md`) が `dev-flow-prerun --issue <N>
--worktree <path>`（top-level Bash、bare 形）で base 解決・worktree 作成/再利用・起点検証（独自コミット・未コミット変更の無い再利用 worktree は base へ fast-forward）・
書き込み probe・`.devflow-tmp` clean・issue analyze（`prerun-analyze.sh`:
`analyze-issue --contract` の決定論 parse + Jev 有界判定）・framework 検出を
1 コマンドで行い、続けて別の Bash 呼び出し `ensure-worktree-deps --setup <worktree>/.devflow-tmp/prerun-setup.json`
で deps install して prerun の出力に `deps` / `epoch_end` を足す（install は依存の postinstall = repo の任意コードを
走らせるので、repo の任意コードを実行しない prerun の子にしない）。
`EnterWorktree({ path })` で worktree に入ってから後者の stdout JSON を `Workflow({ args: { issue, setup } })`
の `args.setup` に渡す（順序は EnterWorktree → Workflow。逆だと isolation probe が fail-closed abort する）。
dev-flow-run の Setup phase は `args.setup` を fail-closed に検証し、その末尾の analyze ゲート（固有の
phase は持たない — 純関数の検証とゲート判定だけで所要 ≒0 のため phase_durations に区間を持たない）は
`args.setup.analyze` の whitelist 検証と 4 条件ゲート（AC 空 / comment_conflicts 非空 / uncertain 非空 /
repo 内外が混ざった AC）のみで通常経路の subagent 起動は 0（ゲートが引いたときだけ sonnet を 1 spawn して人間向け
missing_context を生成し needs_clarification で終端する。失敗 telemetry の phase 帰属は `Setup`）。
例外はゲート通過後の観測型判定で、`args.setup.analyze.ac_observational` に null（Jev 低確信・Jev に届かない）の AC が
あるときだけ、その AC を AC の文面と issue タイトルだけを読む分類 agent（`ac-observational#N`、dev-runner）に 1 回で渡す。
repo 内外の混在は `_lib/ac-actor.mjs` の `classifyAcScope` が決定論で判定する: repo 外の目印（`dotfiles` /
`excludedCommands` / `settings.json` / `~/.claude` / 別 repo・他 repo / 対象 repo 以外の `owner/repo#N`・
`github.com/owner/repo`）と repo 内の目印（テスト / README / rules / repo 内パス等）が 1 つの AC に両方あれば
`mixed` で、repo 外の作業を `human-task` ラベルの別 issue に切り出し、実装 issue の AC を repo 内で検証できる
ものだけにするよう求める（1 issue = 1 PR・単一 worktree では repo 外を満たせず、Evaluate 後に agent AC の
取りこぼしと誤分類されるため。`（人手）` と明記して同じ issue に残すと actor human の AC として Final reconcile で
必ず `ac_human_pending` の HOLD になる）。依存の向きは、merge 前に人がやる作業なら実装 issue に
`Blocked by #<human issue>`、merge 後に確認する作業なら human issue に `Blocked by #<実装 issue>`。
repo 外の目印は作業の対象として指すものだけを数える:
否定・不在・件数 0・不要・条件・理由の言及・grep 対象の節にある目印と、対象 repo 自身が持つ目印（対象 repo が
dotfiles のときの `dotfiles` / `excludedCommands` / `settings.json`）は数えない。`（人手）` と明記した AC は
混在していても `external`（human）にする。
analyze ゲートより前に blocked_by ゲートを置く: `args.setup.analyze.blockers`（prerun-analyze.sh が
GitHub の issue dependencies API と本文の `Blocked by #N` / `owner/repo#N` 行の和集合から読み取る）に
`state: "OPEN"` が 1 つでもあれば、sonnet も isolation-probe も起動せず needs_clarification
（source=`blocked_by`、missing_context は未完了 issue の番号と URL）で終端する。blocker の取得失敗は
`analyze.ok:false`（source=`analyze_prerun`）で止まる。
isolation-probe はゲート通過後・Implement 前の 1 回。orchestration (phase 遷移 / evaluate・pr-iterate の各ループ) は
workflow script が JS で保持し、中間 state は script 変数に
持つ (外部 state JSON は持たない)。workflow の `meta.name` は `dev-flow-run` だが、telemetry
handoff の `skill` キーは `'dev-flow'` のまま据え置く（集計連続性の不変条件、静的テストで pin 済み）。

```
/dev-flow <issue>   → [wrapper preflight] → Setup(末尾で決定論 analyze ゲート)
                      → Implement(dev-implementer 1 spawn) → Validate(test green)
                      → Security floor(realized diff から shape 判定) → Evaluate → PR → workflow('dev-flow:pr-iterate-run')
                      → Final reconcile(fixes_applied>0 のみ) → Merge tier
/pr-iterate <pr>    → [wrapper preflight: pr-iterate-prerun → EnterWorktree]
                      → workflow('dev-flow:pr-iterate-run') で review ⇄ fix loop (LGTM まで, 上限10) → 終端サマリー
```

`/pr-iterate <pr>` は wrapper skill（`pr-iterate/SKILL.md`）。workflow の meta 名は skill 名と衝突しないよう
`pr-iterate-run`（`dev-flow-run` と対称）で、起動名は namespaced の `dev-flow:pr-iterate-run`（bare 名・旧名
`pr-iterate` へのフォールバックや alias は無い）。telemetry handoff の `skill` は `'pr-iterate'` のまま。

wrapper は `pr-iterate-prerun <PR> [--repo owner/name]`（top-level Bash、bare 名）で `gh pr view` の
url / headRefName / baseRefName / headRefOid を取り、`origin/<head>` が headRefOid と一致することを確かめてから
PR head の worktree を用意する（head branch を checkout 済みの worktree があれば再利用、無ければ dev-flow と同じ
置き場所の規則 — 既定 `<repo>/.claude/worktrees/pr-<N>`・repo 外 `<repo>-wt/pr-<N>` — で `origin/<head>` から作成。
作った worktree に書けなければ remove して repo 外候補で作り直す）。出力の `{worktree, head_ref, base_ref, head_sha,
repo, epoch}` を `args.nested`（`caller: 'standalone'`）で渡すので、workflow は dev-flow からの nested 起動と同じ
NESTED 分岐で pr-meta と isolation-cleanup を起動しない。`nested.caller` は `dev-flow` / `standalone` の閉じた
enum で必須（欠落・out-of-enum は throw）。終端サマリーの投稿は `caller` で決まり、`dev-flow` のときだけ止める
（dev-flow は Merge tier の後に自分の終端サマリーを投稿する）。nested 無しで Workflow を直接起動した場合は従来どおり
pr-meta probe で値を取る。単体起動の worktree は run 後も削除しない（人間が確認してから `worktree-teardown` で片付ける）。

dev-flow の終端サマリーは末尾に `<!-- dev-flow:<tier> head=<sha> -->`（HOLD は `<!-- dev-flow:HOLD codes=<code>,... head=<sha> -->`、
code は `merge-tier.mjs` の holdReasons の code）を置く。`head` は merge tier を判定した PR head（merge-tier-facts の headRefOid。
取れなければ載せない）。`pr-iterate-prerun` は同じ `gh pr view` で comments を取り、この marker を
持つ最後のコメントを `prior_devflow`（`{tier, codes, url}` / null）で出し、wrapper が `args.prior_devflow` で渡す。
HOLD のとき単体 pr-iterate の終端サマリーは code ごとの回収状況を出す — pr-iterate が自分で確かめられるのは
`iterate_non_lgtm`（この run が lgtm）・`ci_checks_failed` / `ac_ci_pending`（最終 CI が passed）・`mergeable_conflicting`
（最後の conflict 自動解消が resolved）だけで、それ以外の code は未解消として人に返す。未解消が残れば見出しを「🎉 LGTM」に
しない（HOLD 後の回収ではこのレポートが PR の最後のコメント＝最新の結論になるため）。dev-flow のサマリー自体は編集しない。

**再 review 中コメント**: 単体 pr-iterate の終端サマリーも末尾に `<!-- pr-iterate:<status>:<n> head=<sha> -->`（`head` は
その結論を出した head — 最後の fix の push 後の PR head）を置く。`pr-iterate-prerun` は dev-flow / pr-iterate どちらかの marker を
持つ最後のコメント（最後の終端サマリー）を `prior_summary`（`{source, url, head_sha, head_mismatch}` / null）で出す。
`head_mismatch` は marker の head が今の PR head と違うとき true で、marker に head が無いサマリーも true（どの head に対する
結論か分からない）。wrapper が `args.prior_summary` で渡し、`head_mismatch:true` なら単体 pr-iterate は review を始める前に
「head `<sha>` で再 review 中。<古いサマリーの URL> の結論はこの head に当てはまらない」コメントを PR に足す。意味は
**その URL の LGTM / tier は今の head を見ていないので merge の根拠にしない — 今の head に対する結論はこの後に載る
pr-iterate の終了レポート**。LGTM サマリーの後に push して再実行した間、PR の最新コメントが古い LGTM のまま merge される
事故を防ぐため。古いサマリーは編集・削除しない（PR 上の証跡を残す）。投稿は `gh pr comment --body-file` の bare 単文で、
失敗しても review は止めない（advisory）。食い違いが無い・終端サマリーが無い PR、dev-flow からの nested 起動では投稿しない。
pr-iterate を経ない push（人手の push のみ）は検知しない。

pr-iterate の review#i（i ≥ 2）は fix delta（前 round の review 時点の head .. 今の head）だけを読む delta review
（`_lib/review-delta.mjs` の `resolveReviewScope`）。sha が確定できない round は full review にフォールバックする。
**full review が critical を 1 件以上返したら、次の round は `delta_range` を渡さない full review に戻す**
（`nextCriticalPending`。判定は fix の対象にした finding の `severity` だけ）。critical を返さない full review を経るまで
delta review に戻さず LGTM にもしない — critical の fix を delta review が approve しただけでは LGTM にならない。
delta review は delta 外の新規指摘を出さないので、critical が 1 件出た PR は他にもある前提で扱う。full review が critical を
返さなければ以降の round は従来どおり delta review。反復上限（`max_reached`）と stuck 判定は変えない。

pr-iterate は review と CI gate が通った round で LGTM を確定する直前に base との conflict を読む（`mergeable-check#i`）。
CONFLICTING / DIRTY のときだけ `conflict-resolve#i` が base を merge し、決定論スクリプト `conflict-autoresolve` が
衝突ファイルを diff3 で型 A（全 hunk の base 側が空 → PR 側 → base 側の和集合）/ 型 B（`.claude/workflows/*.js` の
inline 生成区間内だけの衝突で canonical は衝突なし → `sync-inlines --write` で再生成）に分類する。全ファイルが A / B
なら merge commit を push して次 iteration の review（`git show --remerge-diff` の範囲）→ CI gate を通してから LGTM を
確定し、merge commit は `fixes_applied` に数える（nested では Final reconcile が最終 tree の test を取り直す）。
1 ファイルでもそれ以外なら `git merge --abort` で戻して LGTM にし、Merge tier の `mergeable_conflicting` HOLD に任せる
（判定は変えない）。base の行を両側が書き換えた hunk は LLM に解かせない — どちらを採るかは仕様判断。
merge base 名は `args.nested.base_ref`（dev-flow は Setup の base、wrapper は `pr-iterate-prerun` の baseRefName）。

Merge tier を pr-iterate の後に置くのは、fix 適用後の最終 tree に対して danger-grep 再実行・danger 再
reconcile を行い、merge 判定を最新の PR 内容に基づかせるため。pr-iterate が fix を適用した run では
Final reconcile phase が worktree を PR 最終 HEAD へ同期し test suite を一発再実行する（red / 再検証
不能は merge tier HOLD。fixes_applied=0 は agent 呼び出しゼロで skip）。再検証不能時は PR head sha に
pin した CI check の決定論判定で代替し、成立しなければ HOLD を維持する。test suite の実行は Validate と
同じ exec-proxy `run-tests <WT>`（haiku は stdout の JSON 1 行を転写するだけ）で、実行可能な `tests/run-*.sh` を
全本実行し、全本 exit 0 のときだけ green とする（判定は exit code 由来。詳細は exec-proxy.md の validate-test 行）。
workflow は `run-tests <WT> --base origin/<PRERUN.base>` で起点を渡し（shape・gate_policy・経路によらず同じ）、
run-tests は merge-base が解決できたときだけ `tests/run-*.sh` に `DEVFLOW_CHANGED_FILES`（merge-base からの
差分 — commit 済み・staged・未 stage — と untracked の WT 相対パスを 1 行 1 件・重複なしで書いたファイルの
絶対パス）と `DEVFLOW_BASE`（merge-base の sha）を渡す。未設定は「全件実行」の意味で、`--base` 無し・
merge-base 解決失敗・git 失敗のとき（stderr 1 行の警告のみ、status / green は不変）とフォールバック経路では
設定しない。テストの選択は repo 側のランナーが行い、dev-flow は repo 固有の知識を持たない（skills repo では
`tests/run-all-bats.sh` が一覧から .bats を絞り、判定できなければ全件に倒す）。
run-tests と redgreen-verify（red・green の各 test 実行）は、テストの直前に `workspace-prebuild <WT>` で
pnpm ワークスペースのビルド成果物（ほかの package が `workspace:` で依存し、`scripts.build` を持ち、
`main` / `module` / `exports` が git 管理外を指す package）を `pnpm --filter <pkg>... run build` の 1 コマンドで
作り直す。Setup で 1 回だけビルドすると Implement / fix が依存先のソースを変えた時点で成果物が古くなり、
テストが変更前のコードを読むため、テストのたびに呼ぶ。ビルド失敗ではテストを実行せず red（Validate /
test#final は `tests:'failed'` + summary に対象パッケージ名、redgreen は当該ペアの `reason`）にする。
pnpm-workspace.yaml の無い repo と対象の無い repo では何もしない。

Validate（`test#i` / `test#retry-i` / `test#post-eval-i`）が `tests:'failed'` を返したら、green-fix の前に失敗を
分類する（`_lib/base-failure-triage.mjs`）。test proxy が `failed_files`（失敗したテストファイル）を返したときだけ、
`validate-diff#<iter>`（read-only。base → working tree の tracked 差分 + untracked のファイル一覧）と突き合わせ、
テストファイル自身もテスト対象のソース（同じディレクトリで stem が同じファイル）も diff に無いものを
`base-rerun#<iter>` で base tree（`git archive` を worktree 外に展開）に対して同じファイルだけ再実行する。
base でも同じテストが落ちたものは ENV 項目（`ENV-BASE-FAILING`、minor / advisory）として green 要件から外し、
失敗がすべてそれなら green-fix を起動せずに green として先へ進む。一部だけなら残りを green-fix に回し、
既存の失敗のファイルには触らないよう prompt で伝える。diff が触ったテストファイル・base では通る・再実行できない・
`failed_files` が無い・diff 一覧が取れない失敗は、すべてこれまでどおり green-fix の対象（ENV 判定の材料が欠けたら
green 要件を緩めない）。外したファイルは終端サマリーの参考セクションに「base でも失敗する既存の失敗」として載る。
`test#final`（Final reconcile）はこの分類をしない。代わりに red の `failed_files` が非空なら、そのファイルだけを
`test#final-rerun` で 1 回流し直し、green なら flake として `final_test_green` を true にする（`final_test_flaky` に
ファイルと 1 回目のログを記録し、終端サマリーのテスト欄は「flake（単体再実行で green）」。`_lib/final-test-rerun.mjs`）。
再実行も red・`failed_files` が空・再実行の応答が無いときは `final_test_red` で HOLD。
test#final green（head sha pin）または ci_verified が成立した run では、未 checked の `EVAL-*` blocking
item（evaluator 由来。escalate は除く）をその決定論 evidence で checked にする（evaluator は fix 後に再実行
されないため）。SEC seed / TESTSURF / AC-FINAL-* はこの経路で解消せず、LLM 判断（final_resolution）でも
blocking は解消しない。final test が green/ci_verified
のときは同じ targeted evaluator 呼び出し（Final AC reconcile）が既存 AC の最終 tree 再検証に加え、
未解消 advisory / ESCALATE item の fix 後 tree 再評価（item_resolutions。表示専用・checked 不変）も
回収し、終端サマリーの「現状 / 対応」列に反映する。

Evaluate 後に入った変更は、評価済みの台帳と tree を run 内で確かめ直す（`_lib/post-eval-recheck.mjs`）:

- **post-eval green-fix の再評価**: Evaluate 差し戻し（reimpl）後の PR 前再テストで `green-fix#post-eval-i` が
  入った run は、`green-fix-classify`（secfloor-classify）→ `green-fix-numstat`（評価済み tree → 現在の tree の
  numstat）で green-fix の差分を決め、差分ファイルに testsurf / danger hit が 0 件かつテストファイルだけなら
  `assert_only`（assert を弱めていないかだけ）、それ以外は `full`（差分全体・宣言外変更）で evaluator
  （`eval-green-fix`。model は override しない）に評価させる。評価できたら評価済み tree の hash を green-fix 後の
  tree へ進めるので、PR 直前の diff-hash と一致すれば `hash_mismatch` にならない。Evaluate round 以降の台帳は
  critical 以外を受け付けないため、ここでやるのは確認と clear に限る — critical finding は `GF-RECHECK-*`
  （全 gate_policy で blocking。`EVAL-*` と分けて fix 後の test green では解消しない — テスト弱体化は test
  green では否定できない）、未 clear の TESTSURF は testsurf_clearance で clear。hash / evaluator 応答が取れなければ
  評価済み tree を進めず `hash_mismatch`（HOLD）で人間へ回す（fail-safe）。green-fix が新たに触った plan 外の
  ファイルは full の評価対象に渡し、Final reconcile の宣言外再監査が pr-iterate fix 由来と取り違えないよう
  宣言外一覧に足す。
- **解消済み item の再検証**: green-fix / pr-iterate fix が触ったファイルを本文か evidence に含む、LLM 判断で
  解消済みの item（evaluator / concern 由来。seed・deterministic・AC・ESCALATE・環境ノートは除く）を決定論で
  再検証対象にする。green-fix 分は `eval-green-fix`、fix 分（PR 作成時の tree → 最終 HEAD の差分。
  `fix-diff-numstat`、取れなければ最終 diff 全体）は Final AC reconcile が `recheck_resolutions` で判定する。
  resolved + evidence は evidence を差し替えて解消済みに残し、それ以外（unresolved・未返却・Final AC reconcile が
  走らない run）は `reopenItem` で未解消へ戻す — 後の変更で崩れたかもしれない解消根拠を終端サマリーの
  「解消済み」に残さない（critical は blocking に戻る。seed / deterministic item は reopen しない）。

shape ごとの経路（3 tier）:

| shape | Implement 経路 | Evaluate 経路 | merge tier |
|-------|-----------|---------------|------------|
| **micro** | Setup 末尾の analyze ゲート通過後に issue から単一 task の plan を合成（`implement#synth-plan`）→ Implement で `dev-implementer`（plan+impl 統合、opus / high）を 1 spawn | skip（evaluator 0 回）。ただし danger-grep hit 時は security path で強制実行 | docs・test-only + danger clean + 収束なら AUTO 推奨ラベル（merge は人間） |
| **standard** | 同上 | 1 パスのみ（差し戻しなし。未解消 critical は merge tier HOLD + human review で担保）。例外は agent AC の未達で、`AGENT_AC_REIMPL_MAX` 回まで延長して差し戻す | REVIEW |
| **complex** | 同上 | 差し戻し loop（上限 EVAL_MAX=10、design 差し戻しは `DESIGN_REPLAN_MAX` まで。差し戻し先は同じ `dev-implementer`） | REVIEW、danger・breaking で HOLD |

AC は analyze ゲートで actor（`_lib/ac-actor.mjs`: `（人手）` 表記・staging・本番・外部サービス・issue へのコメントと、
repo 外の作業だけを書いた AC（`classifyAcScope` が `external`）は `human`、それ以外は `agent`）に分類する。AC の ledger item は LLM major で既定 `gate_policy` では advisory のため、
ledger 収束だけでは未達 AC がループを回さない。そこで agent AC の `satisfied:false` は gate_policy に依らず
`fix_feedback`（`topic: "AC-<n> 未達"`）付きで `dev-implementer` へ差し戻す（agent AC を理由にした差し戻しは全 shape で
`AGENT_AC_REIMPL_MAX` 回まで）。human AC は worktree 外の作業なので差し戻さない。
観測型 AC（実行して出力・記録を観測しないと確かめられない AC。actor は `human`）は 2 段構えで決める: prerun-analyze.sh が
正規表現（`isObservationalAc`。絞り込み専用で拾いすぎてよい）に当たった AC だけを Jev に noul で聞いて
`analyze.ac_observational`（true / false / null）を出し、analyze ゲートが null の AC だけを AC 文面と issue タイトルだけを読む
分類 agent に渡し、それでも決まらなければ true にする（`resolveAcObservational`。diff・evaluator の結果は渡さない —
evaluator のコード読みで達成扱いになるのを止める仕組みなので、実装を見た判定は抜け道になる）。観測型 AC は、Evaluate の
redgreen-verify で red→green を実証して deterministic 昇格したときだけ checked にする。evaluator・final AC reconcile の
inspection による `satisfied:true` は達成扱いにせず（`demoteUnprovenObservationalAc`）、差し戻さずに人手 AC 待ちへ回す。
evaluator が agent AC の未達理由を実行環境に届かない（`unreachable_env:true` — DB コンテナ等が sandbox 内で動かない）と
返したものも差し戻さず人手 AC 待ちに数える（コード上に未達の根拠が無いので終端サマリーは「修正が必要」にせず「実行して確認する」）。
ci AC（actor `ci`）: repo が `skill-config.json` / `.claude/skill-config.json` の `"dev-flow".ci_verify`
（`{ label, checks, commands, wait_ceiling_seconds }`。prerun が読み、`normalizeCiVerify` が不正形を fail-closed で止める）で
宣言した `commands` を inline code に書いた AC、または `label` に言及した AC（`matchesCiVerify`。汎用の E2E 語・Jev は使わない）。
evaluator・final AC reconcile の判定を使わず差し戻しにも回さない。PR 作成時に `label` を付け、pr-iterate は `checks` を各 round の
CI 判定から外し（check-ci `--exclude`）、LGTM 後に別ループ（`ci-verify#i.k`、check-ci `--only`）で `wait_ceiling_seconds` まで完了を待つ。
success は check run の URL を根拠に satisfied、failure は失敗 job の link を fix に渡して直させ次 iteration で再び待つ（MAX に含める）、
上限まで未完了は LGTM のまま `ci_verify.status='pending'`。
repo が `"dev-flow".local_verify`（`{ command, db: { engine: "postgres", version }, env, timeout_seconds }`。
`normalizeLocalVerify` が不正形を fail-closed で止める）も宣言していれば、ci AC は PR の前にローカル実行で判定する
（`execLocalVerify`。Validate green 後・Evaluate 前。`local-verify start / wait / stop` を `dev-runner-haiku` の exec-proxy で呼び、
local-verify が pg-broker の使い捨て Postgres の `database_url` を `env` に入れて `command` を実行する）。exit 0 は `log_path` と exit code を
根拠に satisfied、PR に `label` は付けるが pr-iterate には `ci_verify.wait:false` を渡して check の完了を待たない（full-ci の結果は
merge 前に人間が確認する — 終端サマリーの「あなたがやること」）。失敗は `log_tail` を付けて dev-implementer に差し戻し
（`AGENT_AC_REIMPL_MAX` を Evaluate の agent AC 差し戻しと共有）、上限後も失敗なら ci AC を agent の未達に数えて `ac_agent_unsatisfied`。
pg-broker に届かない・結果を取得できない・Validate が red なら fail-open で上の CI 待ちに戻し、理由を終端サマリーの「参考」に 1 行出す。
Merge tier の HOLD 理由は
`ac_agent_unsatisfied`（差し戻し上限後も未達 = ループの取りこぼし）と `ac_human_pending`（人手 AC 待ち）と
`ac_ci_pending`（ci AC が CI で success にならなかった。「CI の `<check>` 実行中 — 結果を確認して merge」）に分ける。
PR body（`buildPrBody`）は見える部分を人間向けの短い要約に限り、判定材料は `<details>` に畳む。見える部分は
結論 1 行 → `## 何が変わるか`（`behavior_changes`）→ `## 人間に見てほしい点`（`review_points`、任意）→
`## この PR に含めなかったもの`（`out_of_scope`）→ `Closes #N` の順で、材料が空の節は出さない。`<details>` には
受入条件（AC 全文の checkbox）・設計判断（`design_decisions`）・検証（danger-grep / test-surface の hit と `pr_notes`）・
`pr_sections`（1 件 1 つ）を載せる。`dev-implementer` の返却は `adoptImplPrNotes` が plan に取り込む。
builder はどの欄も字数で切らない — 1 行要約欄の長さは IMPL schema の `maxLength`（`behavior_changes` は `maxItems` 3 も）で
書き手に収めさせ、超過は schema 検証で差し戻す。`pr_sections` の合計が `PR_SECTIONS_MAX_CHARS`（3000 字）を超えたら、
Implement / reimpl の直後（Evaluate より前）に `dev-implementer` へ要約を 1 回差し戻す（`sections-trim` / `sections-trim#<i>`）。
判定する LLM の文脈を薄めないための上限で、差し戻し後も超えたら切らずに載せる。
evaluator（Evaluate / final-ac-reconcile）には plan の本文材料ではなく `buildPrBody` の出力（Evaluate は PR 作成前に
同じ builder・同じ材料で組んだプレビュー）を渡し、「PR 本文に書く」型の AC を本文テキスト（`<details>` の中を含む）で判定させる。
`out_of_scope` は終端サマリーの「この PR に含めなかったもの」節にもそのまま転記する（空なら節ごと出さない）。

pr-iterate の fix（`fix#i`）prompt は必須 5 要素を持ち、Boundary で worktree の外・他 repo への書き込み、ブランチ作成、
`gh api` での変更を禁止する。`file` が worktree の外（URL・`~`・`..` で出る相対パス・worktree 配下でない絶対パス）を
指す blocking finding は `excludeOutsideWorktree`（`_lib/review-normalize.mjs`）が fix の対象から外し、reviewSeen にも
積まない。残りの blocking が 0 件ならその round は CI 判定へ進む。外した finding は返り値 `human_followups` と
終端サマリーの「人間側 follow-up」節に載る（nested 起動では dev-flow の終端サマリーが表示する）。

Implement 経路は shape に関わらず `dev-implementer` 一本（planner ⇄ reviewer ループ・parallel fan-out・
`pipeline()` は持たない。切替定数は置かず、経路を戻すときは git revert）。`dev-implementer` は issue 本文
（`req.issue_body`、analyze-issue.sh が 4000 字で切詰め）+ AC + `fix_feedback` を受け取り、AC テスト契約
（red→green 自己実証）や手順書型 task は受け取らない — テスト全件・red 証明・AC 判定は Validate / redgreen-verify /
evaluator が担う。合成 task の `file_changes` は空で始まり、IMPL 返却の `files` を宣言として取り込む
（宣言外監査・実効 shape の realized count・PR body の材料になる）。BLOCKED（`approach_mismatch`）は planner を起動せず、
blockSeen 累積の findings（過去 BLOCKED アプローチへの回帰禁止）と DONE 成果を prompt に付けて同じ agent を
`reimpl-blocked#b` で再 spawn する（上限 `BLOCK_MAX`）。`guard_blocked` は再 spawn しないが、その理由がファイル削除
（`isDeletionGuardBlock`）なら、以降の実装 spawn（`reimpl#i` / green-fix 等）の prompt に削除手段の固定文
（tracked ファイルは `git rm`、削除後に unstage しない。agent 定義と同じ内容）を足す。Validate の green-fix（`green-fix#i` / `green-fix#retry-i` / Evaluate 差し戻し後の PR 前再テストの `green-fix#post-eval-i`）も
同じ agent 定義だが `model: 'sonnet'` を明示 override する（green-fix の実態は環境起因の blocker 報告か小さな
test script 修正で opus 級の推論を要さず、green-fix > 0 の run は Evaluate のテスト弱体化監査が強制されるため）。
Implement / BLOCKED 再実装 / Evaluate 差し戻しは `opts.model` を渡さず frontmatter の既定（opus / high）で spawn し、
null 返却は再試行せず drop（`implDroppedCount`）に計上する。

shape は analyze ゲートでは決めない。Security floor（実装後・PR 前）で `classifyShape(req, realizedCount, lineStats)` が
realized diff の file 数・file ごとの追加/削除行数 + issue 由来の決定論特徴量（AC 数 / `issue_type` / 構造化 `breaking_change`）で
1 回で決め、その返り値が `EFFECTIVE_SHAPE`（Evaluate 深さ・LITE gate・merge tier の入力）になる。安全 floor は
realized count 欠損（secfloor-unified（danger-grep）の files 欠落 → NaN）・`acceptance_criteria` 欠落・out-of-enum `issue_type`・
`breaking_change === true` → complex（軸A: 緩めない）。floor を通過した run だけ、secfloor の `lines`
（tracked は numstat、untracked は `wc -l`）から差分の中身で下げ方向に補正する: docs（`docs/**` / `*.md`）と
対応する本番ファイルも変えたテストは数えない、重み付け後の追加行 < 削除行×0.3 なら 1 段下げる、complex は
重み付け後 file 数 > 5 かつ追加 > 100 行のときだけ。file 数判定より上には上げない。行数が 1 file でも欠けた run と
変更がテストだけの run は補正しない（file 数判定のまま）。補正前の shape は返り値 `shape_reason` の「file 数判定」に出る。
LLM の事前見積もり（shape / 見込み file 数）は REQ に
持たず decision に使わない — micro の LITE 経路に対する意味的リスクの安全網は runEval 強制条件
（danger-grep / testsurf / green-fix / dropped task / 宣言外変更 / UI 接触）が担う。
`classifyShape` に渡す数は Security floor 時点の working tree から ephemeral・宣言外パス・format-only を
除外したもの（宣言外は size 信号にせず Evaluate 強制 + concern 監査で扱う）。その数は返り値
`realized_file_count` に、判定根拠は `shape_reason` に載る（journal telemetry には実効 `shape` だけを書く）。danger-grep hit が
あれば micro でも Evaluate を強制実行（security path）。

**micro lite route**: `state.EFFECTIVE_SHAPE === 'micro' && !state.runEval && state.dangerHits.length === 0 && CI_AC_INDEXES.length === 0 && !state.securityReview.target`
（clean-micro かつ contract 準拠かつ danger clean かつ ci の AC — `ci_verify` の check で判定する AC — を持たず、
Security floor の merge-base 基準の diff が敵対的 security review の対象外 — 下の「敵対的 security review」— の）を満たす run は、PR phase で dev-implementer 1 spawn → targeted test →
PR → pr-reviewer 1-pass の縮約経路（lite route、判断系 agent 呼び出し ≤10）を通る。lite の pr-reviewer
1-pass が `review==null || blocking.length>0`（critical/major finding あり）を検出した場合のみ
`workflow('dev-flow:pr-iterate-run')` フル loop へ自動昇格し、以降は通常の review⇄fix 経路で処理する。danger-grep
hit で `runEval=true` になったケースは lite ゲート条件を満たさないため lite に入らず、micro であっても
現行の security path（Evaluate 強制実行）へ強制昇格する（軸A invariant 不変）。

**敵対的 security review**（信頼境界をまたぎうる PR を既定で通す gate。正当化クラスは justification-classes.md）:

```
Security floor  → security-scope（dev-runner-haiku-ro）: `security-review-scope <WT> origin/<base> --working-tree`
                  （merge-base と作業ツリーの diff）→ state.securityReview.target → LITE の条件・nested args.security_review
/pr-iterate     → pr-iterate-prerun が `<base>...<PR head>` の diff を判定 → wrapper が args.security_review で渡す
pr-iterate      → CI gate を通り conflict も無い round（LGTM の候補）で:
                  security-scope#i: `security-review-scope <wt> origin/<base> <shaNow|HEAD> --save-diff`
                    → 起動時・run 中のどれか 1 回でも対象なら run の終わりまで対象（args.security_review が無い run も対象）
                  対象なら security-review#i（security-reviewer を毎回新しく spawn。PR 全 diff の file と head sha と
                    前回の未解消 critical/major を DATA として渡す）
                    → critical/major 0 件かつ reviewed_sha が今の head → LGTM
                    → critical/major あり → fix#i（dev-runner）→ commit-ensure#i → 次 iteration（同じ topic の反復は stuck、
                      上限まで残れば max_reached）
                    → worktree の外を指す・diff / head / 保存先が揃わない・結果なし・head 不一致・
                      reviewer_context_changed が false でない（起動時の args.security_review の決定論の値と run 中の判定の
                      どれか 1 回でも true なら run の終わりまで true）→ status: security_unresolved
Merge tier      → 対象（Security floor か pr-iterate のどちらか）かつ pr-iterate が lgtm + security_review.status 'cleared'
                  でなければ HOLD（security_review_unresolved）
```

- 対象かどうかは `_lib/security-review-scope.mjs` の決定論の判定だけで決める（LLM は使わない。コードの diff を外部 API に
  送らない）。対象外は「ファイルが 1 件以上で、全ファイルが許可リスト（mode 100644 の `.md` / `.mdx` / `.rst` のうち指示
  ファイルでないもの、テストコードの拡張子の `*.test.*` / `*.spec.*`、`.bats`。ドット始まりの要素の配下は除く）に当たる」
  diff だけ。指示ファイルは大文字小文字を区別せず `CLAUDE.md`・`CLAUDE.local.md`・`AGENTS.md`・`SKILL.md` と
  `.claude/`・`references/`・`output-styles/`・`agents/`・`commands/` 配下。diff は
  `git -c core.quotePath=false diff --no-renames --no-color --no-ext-diff --no-textconv --text --src-prefix=a/ --dst-prefix=b/`
  で取り、`--name-only -z` の一覧と件数・集合を照合する。取得失敗・空・読めない diff・binary・mode 120000 / 160000・mode の
  変更・`.gitattributes` / `.gitmodules` は対象
- security-reviewer（opus / high、tools は Read / Grep / Glob だけ）は `security-review-scope --save-diff` が worktree の外に
  作った一時ディレクトリを作業ディレクトリにし、PR 本文・diff・コード中のコメントをデータとして扱う。品質ゲート agent なので
  `opts.model` を渡さない
- workflow の `agent()` には cwd を渡せないので、security-reviewer の session の cwd は PR の worktree のまま。reviewer が読む
  ファイルは保存先の配下に限る。保存先の外への Read / Grep / Glob は PreToolUse hook（`hooks/pretool-security-reviewer-read-scope.sh`。
  入力の `agent_type` が `dev-flow:security-reviewer` のときだけ判定）が拒否する — 許可は対象パスの realpath が basename
  `dev-flow-security-review-[A-Za-z0-9]{6}` のディレクトリの配下で、そのディレクトリと対象パスが session の cwd の配下でないときだけ。
  Grep / Glob の `path` 無し・`pattern` / `glob` の絶対パスや `..`・判定できない入力も拒否する。PR が reviewer の session に自動で読み込まれる指示ファイル
  （basename が `CLAUDE.md` / `CLAUDE.local.md` / `AGENTS.md`、または repo 直下の `.claude/` 配下）を変える run は、
  security-scope#i の `reviewer_context_changed` で検出して review を spawn せず `security_unresolved`（人間が確かめる）
- security-scope の CLI は stdout・stderr に PR 由来の文字列（ファイルパス・git の stderr）を出さない。reasons は固定 code と
  件数、error は固定 code（`usage` / `git_failed`）だけ。stdout を写す exec-proxy の agent に判定を書き換える文を渡さないため
- 公開の PR コメント（pr-iterate・dev-flow の終端サマリー）には指摘の件数だけを載せ、本文（攻撃経路）は fix の prompt にだけ渡す。
  security の指摘は `history` / `human_followups` に入れない。返り値 `security_review` は `{target, status, stop_reason, rounds, critical, major, minor}`
- `stop_reason` は review の前提チェックで clear にできずに止めた理由の閉じた enum（`diff_unavailable` / `head_unknown` /
  `head_mismatch` / `review_dir_invalid` / `reviewer_context_changed`）。review を実行した・止めていない run は null。
  `reviewer_context_changed` の run は終端サマリーで「指示ファイルを変える PR なので自動 review をしていない」と出し分ける
  （HOLD は変えない。変わったファイルのパスは PR が決めた文字列なので載せず、固定の確認コマンドに PR 番号だけを差し込む）

**Codex 経路**（opt-in。`"dev-flow".security_reviewer = "codex"`）:

```
/pr-iterate     → pr-iterate-prerun が base branch（origin/<base>）の skill-config.json / .claude/skill-config.json、無ければ user 設定
                  （$SKILL_CONFIG_PATH / ~/.config/skills/config.json / ~/.claude/skill-config.json）から読み、
                  args.security_review.reviewer で渡す（PR head の設定ファイルは読まない。無ければ "claude"）
pr-iterate      → security-scope#i の前提チェックを通った round で（指示ファイルを変える PR も reviewer_context_changed で止めず Codex の
                  review に進む。Codex で判定できなかった round だけ Claude 経路と同じく security_unresolved で止める）:
                  security-codex-prep#i（security-codex-relay）: `security-review-codex-prep <保存先> <head> <PR>[ --verify-from <前回の保存先>]`
                    → 保存先に prompt.md（prompt + diff）・strict 形の schema.json、新しい空の mkdtemp（dev-flow-codex-cwd-XXXXXX）
                  security-review-codex#i（security-codex-relay）: 固定形の `codex exec ...`（先頭トークン codex の単文。返り値は使わない）
                  security-codex-verdict#i（security-codex-relay）: `security-review-codex-result <保存先> <head>`（自由文を出さない判定）
                    → clear でなければ security-codex-issues#i: `security-review-codex-result <保存先> <head> --issues`（指摘の本文）
                    → script と workflow の両方が securityReviewVerdict と同じ規則で clear のときだけ LGTM（以降は Claude 経路と同じ）
                    → clear を決める中継に自由文（codex の出力・指摘の本文）を読ませない — 引用された PR の文で偽の clear を作らせない
                    → Codex で判定できない（prep の失敗・codex が無い・hook の拒否・result.json が読めない）→ その round は security-review#i
```

- codex の起動形は `_lib/security-review.mjs` の `codexSecurityReviewCommand` が固定で持つ（中継が先頭トークン codex の単文で実行する —
  sandbox の外で通信できるのは先頭が codex の単文だけで、exec-proxy script の中から起動すると通信が拒否される）: `codex exec -s read-only --ephemeral --ignore-user-config
  --ignore-rules --skip-git-repo-check -C <空の mkdtemp> -c web_search="disabled" --disable shell_tool --disable unified_exec
  --disable apps --disable browser_use --disable computer_use -c model_instructions_file=<保存先>/prompt.md
  --output-schema <保存先>/schema.json -o <保存先>/result.json "<固定文>"`。空の `-C` で cwd の AGENTS.md を読ませず、shell 等を外して
  diff の外を読む手段を無くす。hook は起動の前に、保存先・作業ディレクトリが mkdtemp の形の実ディレクトリで cwd の配下でないこと、
  `-C` が空であること、保存先に prompt.md・schema.json があり result.json（symlink を含む）が無いことを確かめる
- PreToolUse hook（`hooks/pretool-codex-invocation-guard.sh`）は `security-codex-relay` の Bash を
  `security-review-codex-prep` / `codex exec`（上の固定形）/ `security-review-codex-result` の固定形の allowlist に限る
  （語を探す判定は引用の分割・`$` 展開で組み立てた語をすり抜けるので使わない）。他の dev-flow の agent には、引用符と
  バックスラッシュを外した command に `codex` の語か保存先・作業ディレクトリの名前があれば拒否する（任意の Bash を持つ agent への多層防御）
- `--output-schema` は OpenAI の strict 形（全 object が `additionalProperties:false`・全 property が required・`maxLength` 無し）
  でないと 400 になる。result.json の schema 適合は `security-review-codex-result` が判定し、適合しない結果は clear にしない
- Codex 用の脅威モデルは攻撃者の入力を PR の内容と外部データ（ファイル名・API 応答・取り込む文書）に限り、利用者自身が設定する
  環境変数を含めない。業務ロジックの正しさは critical / major にしない
- 返り値 `rounds` は Claude の security-reviewer と、結果を読めた Codex の review の合計

- **`agent()` へ渡す agentType は plugin namespace 必須** — subagent の実体は plugin 配下
  (`plugins/dev-flow/agents/`) にあり、harness は `dev-flow:<name>` の namespaced id でしか解決しない
  (bare 名は `agent type '<name>' not found` で run 全体が起動直後に abort する)。workflow 本体・
  pr-iterate の返り値 `subagent_invocations` の by_type キー・agent 名を静的検査する routing test は論理名 (bare) を保持し、
  namespace は `agent()` を呼ぶ直前の `nsAgentOpts()` (canonical `_lib/agent-namespace.mjs`。dev-flow.js /
  pr-iterate.js へ inline 生成) でのみ付与する。dev-flow-canary.js は inline bridge 非依存
  (self-contained) を保つため例外で、namespaced id を直接書く。新しい call site はこの経路に乗せる。
- **判断系 leaf は subagent** (`.claude/agents/{dev-implementer,evaluator,pr-reviewer,security-reviewer,security-codex-relay,dev-runner,dev-runner-haiku,dev-runner-haiku-ro,dev-runner-haiku-wo}.md`)。
  effort は原則 subagent frontmatter で決める。`agent()` の `opts.effort` は frontmatter より優先して実効値に反映される
  （transcript で確認済み。dev-flow-canary の `agent_opts_effort_accepted` probe は受理の有無だけを見る）が、
  opts で effort を渡すのは pr-iterate の fix（`fix#i` / `fix#i-retry`、`FIX_EFFORT = 'medium'`）のみ
  （`_lib/agent-frontmatter.test.mjs` が pin）。
  model は subagent frontmatter で決める。品質ゲート agent の call site は `opts.model` を渡さない —
  evaluator（`eval#i` / `eval-green-fix` / `final-ac-reconcile` / `security-clearance-final`）と pr-reviewer（`review#i` /
  schema-retry / `pr-review-lite`）はともに frontmatter（evaluator は opus / medium、pr-reviewer は opus / high）で spawn し、workflow 側に model 定数・
  null 時の model fallback 機構は持たない（`_lib/review-model-frontmatter.test.mjs` が call site と telemetry
  `eval_model_config` / `review_model_config` / `impl_model_config` = frontmatter 値の一致を pin）。同一入力での paired 比較で
  opus-high は fable-high と verdict・major 検出が同等以上かつコストが 2/3 だったため、両 gate とも override を外している。
  `dev-implementer` も frontmatter（opus / high）で spawn する（complex の盲検 replay で fable-high と品質同等・
  所要時間とコストが約 −45% だったため）。override は green-fix の `model: 'sonnet'` だけ
  （call site 別の挙動は `_lib/impl-model-opus.test.mjs` が pin）。
  pr-iterate の fix（`fix#i` / `fix#i-retry`）は `dev-runner`（frontmatter sonnet / high）に `model: 'opus'` と
  `effort: 'medium'` を渡す
  （reviewer 指摘は設計判断を伴う修正が中心で、sonnet は maxTurns 50 内に終わらず fix_failed になりやすい。
  失敗 6 ケースの盲検 replay で opus は完走 5/6 対 3/6・品質同等以上だった。effort は paired replay で high と
  完走率・品質同等のまま所要・コストが下がった。frontmatter は analyze-clarify と共用なので変えない。
  `_lib/priterate-fix-retry.test.mjs` が pin）。
  `_lib/plugin-version.mjs` の `PLUGIN_VERSION` は inline 生成方式（dev-flow.js / pr-iterate.js）。
  model を恒久的に別系統へ固定したい leaf には専用 agent 定義
  （例: `dev-runner-haiku.md`、`model: haiku`）を用意し `agentType` を切り替える。
  pr-reviewer は `effort: high`（max と精度同等で高速。medium は major を minor に下げ decision が甘くなる）、
  evaluator は `effort: medium`（paired replay で high と verdict・major/critical 検出が同等のまま所要・コストが下がる）、
  dev-implementer / dev-runner は
  `effort: high`、dev-runner-haiku / dev-runner-haiku-ro は `effort: low`（mechanical exec-proxy は
  low が high に schema 成功率で劣後しない）。
- **`agent()` の cwd 指定は `dev-flow-canary` の `agent_opts_cwd_applied` で判定する** — canary は
  `agent()` に `opts.cwd: '/tmp'`（repo 外の一時ディレクトリ。read-only のため作らず既存のものを使う）を渡して
  `dev-runner-haiku-ro` を 1 回 spawn し、agent が `pwd` だけで報告した作業ディレクトリと比べる
  （macOS の実パス `/private/tmp` も一致とみなす）。読み方: `pass` = cwd 指定が効く（security-reviewer を PR の
  worktree の外で起動する形へ移す後続 issue の着手条件）、`fail` = throw は
  しないが作業ディレクトリが変わらない（opts.cwd は無視されたか別名で受け付けられている）、`unsupported` =
  `agent()` が opts.cwd 指定で throw した。pass でも canary は report を出すだけで、起動形は変えない。
- **1 issue = 1 PR**。Implement は全 shape で `dev-implementer` を単一 worktree に 1 spawn する（parallel fan-out / `pipeline()` は持たない）。
- **merge は手動** (LGTM 後にユーザーが merge)。
- worktree の後片付けは `_shared/scripts/worktree-teardown.sh <worktree-path>` を使う。
- **bg-isolation guard と isolation probe**: bg 起動セッションが呼び出し元 cwd を worktree へ
  isolate しないまま dev-flow / pr-iterate を起動すると、harness の bg-isolation guard が
  subagent の Write/Edit を共有 checkout への書き込みとして拒否する。dev-flow は Setup 末尾の analyze
  ゲート通過後・Implement 直前（needs_clarification 経路では spawn しない）、pr-iterate は review loop 進入前（fix stage
  不到達の保証）に probe を配置する。probe は worktree 直下 `.devflow-tmp/.isolation-probe-<token>`
  （token は run 毎に一意 — dev-flow は wrapper（dev-flow-prerun、top-level Bash）が渡す
  `args.setup.epoch`（`date +%s`、必須キーのため fallback 経路は無い）、pr-iterate は
  `args.nested.epoch` — dev-flow からの nested 起動は PR phase の commit+PR 応答 epoch、`/pr-iterate` wrapper
  経由の単体起動は `pr-iterate-prerun` の epoch — で供給し pr-meta probe 自体を起動しない。nested 無しで
  直接起動した場合だけ pr-meta probe の epoch（fallback: PR 番号）。
  `Date.now()` / `Math.random()` は canonical の generator 制約上使わない）への Write で
  isolation 成立を検証する。probe agent は
  tools を `[Write]` のみに絞った専任 agent `dev-runner-haiku-wo`
  （model: haiku, effort: low, maxTurns: 5）— Write 以外の経路（Bash リダイレクト等）では
  ファイルを作れないため、「implementer と同じ Write tool 経路の検証」という probe の意味が
  harness レベルで保証される。`written:false` は fail-closed（確定回避手順つき throw）で、
  throw メッセージは決定論の error 文字列分類（`isolationErrorKind`: `overwrite_refused`
  / `isolation` / `unknown`）で「isolation 不成立」と「その他の書き込み失敗（前 run の残置物への
  上書き拒否等）」を区別して報告する — fail-closed（throw）自体は全分類で不変。回避手順は
  1. 書き込みに失敗した cwd とは別の worktree を `git worktree add`、2. `EnterWorktree({path})`、
  3. Workflow 再実行（dev-flow は `dev-flow-prerun --issue <N> --worktree <path>` の後、別の Bash 呼び出しで
  `ensure-worktree-deps --setup <path>/.devflow-tmp/prerun-setup.json` を実行し、その stdout JSON を `args.setup` に
  渡し直す。prerun の生 JSON は `deps` / `epoch_end` を持たず Setup で即 throw する）。probe 自体の失敗（null）は fail-open（警告 log のみ）で扱う。
  canonical は `_lib/isolation-probe.mjs` の `isolationCleanupPrompt` / `isolationProbePrompt`
  （token 引数必須。関数側にデフォルトを置かず呼び出し元が明示的に渡す） / `isolationFailureMessage` を
  dev-flow.js・pr-iterate.js 双方へ inline 生成して流用する（両 workflow で同一の文言・手順を
  使うためのもので、片側専用の canonical 関数は追加しない）。
  probe の直前の cleanup は dev-flow / pr-iterate で経路が分かれる。**dev-flow は wrapper の
  prerun が run 開始前に `.devflow-tmp` 全体を `git clean -fdx` 済み**（agent 呼び出しではなく
  決定論スクリプト内で完結する）——前 run の残置物（probe artifact / journal payload / local-verify
  state 等）の持ち越し防止（run 間衛生）を prerun が担う。**pr-iterate の `/pr-iterate` wrapper 経由の
  単体起動は `pr-iterate-prerun` が** canonical `_lib/isolation-probe.mjs` の exported 定数
  `ISOLATION_PROBE_CLEANUP_GLOB` と同じ `.devflow-tmp/.isolation-probe*`（probe の token 形ファイル名
  `.isolation-probe-<token>` と legacy 無 token 形の両方にマッチする）だけを `git clean -fdx` する
  （`.devflow-tmp` 全体は消さない — 再利用した dev-flow の `df-<N>` に PR phase 失敗の回収用 commit message /
  PR body が残っていることがある）。nested 無しの直接起動だけが isolation-cleanup subagent を呼ぶ。dev-flow からの
  nested 起動では probe 対象が実行中 dev-flow run の worktree 自身になり、`.devflow-tmp` 全体を消すと当該 run が
  既に書いた run 専用 scratch（journal payload 等の `.devflow-tmp` 配下生成物）を run 途中で失うため、pr-iterate 側の
  isolation-cleanup 呼び出しを skip する（dev-flow 側の prerun cleanup が同一 worktree の run 間衛生を
  既に担保済みのため、nested run でも二重に走らせる必要がない）。
  isolation-probe（Write 検証本体）は nested でも skip しない。pr-iterate 側 cleanup は fail-open
  （失敗しても一意パス化により直後の probe は通常どおり成立する）。
  probe prompt / throw メッセージは、実行制御の名称（sandbox・permission・excludedCommands・guard 等）を
  「だからこの経路を使え」という形の理由として述べない — exec-proxy 節の規範と同一で、canonical と
  2 つの inline 生成区間の双方を `_lib/isolation-control-reason.test.mjs` が pin する。
  失敗の診断としての `bg-isolation guard の可能性` は別（何が起きたかの説明であり経路指示ではない）。
  (a) `EnterWorktree({path})` は bg 起動セッションからも成立する — repo 内
  `.claude/worktrees/`（throw メッセージが提示する既定の先）・repo 外 worktree の双方で実測済み。
  したがって bg 経由でも上記の確定回避手順が正規経路として機能する。
  (b) `worktree.bgIsolation:"none"` 設定による guard 無効化は採らない —
  guard は共有 checkout への意図しない書き込みを防ぐ safety であり、設定で無効化すると
  保護ごと失われる（W7 分類: blast-radius。共有 checkout 汚染は blast-radius が大きく、
  guard 緩和ではなく fail-closed 検知 + 正規 isolation 経路で解決する。設定緩和による
  sunset はしない）。
- Claude 専用 (workflow 依存)。cross-vendor portability は dev-flow / pr-iterate のみ放棄する例外扱い。
- **gate_policy**: trust 昇順の 4 値 enum — `deterministic-only` / `llm-major-advisory`（既定）/ `llm-major-blocking` / `llm-autonomous`。
  **軸A invariant 不変** — deterministic oracle / seed / critical アイテムは全 policy で blocking のまま（security floor / 決定論ゲートは policy で緩めない）。
  **既定同一挙動** — 既定 `llm-major-advisory` は軸A invariant（critical / deterministic / seed = blocking）+ LLM major/minor = advisory の既定 lane 分類と全アイテムで一致し、非 default policy のみ gating が変わる（enum で境界を滑らせる設計）。
  out-of-enum 値は明示 error（legacy fallback / version 分岐なし）。canonical は `_lib/gate-policy.mjs`、dev-flow.js への inline は tools/sync-inlines.mjs で生成・`_lib/workflow-inlines.sync.test.mjs` が全文一致保証。
- **block_class**: dev-implementer 返り値 `status:'BLOCKED'` の `blocking_reason` は閉じた 2 値 enum
  `approach_mismatch` / `guard_blocked` を持つ構造化 object（`{block_class, detail, guard_id}`）で、
  string（free text）は受理せず schema error になる。`guard_blocked` は guard/hook 由来の BLOCKED
  （inline-edit-guard deny / sandbox EPERM / safety classifier block / bg-isolation 等）を指し、
  Implement phase の再実装ループ（blockSeen 登録・`approach_mismatch` findings 化・dev-implementer
  再 spawn）から除外され、blockedConcerns 経由で evaluator focus へ直行する。out-of-enum の
  `block_class` は明示 error（legacy fallback / version 分岐なし）。canonical は
  `_lib/block-routing.mjs`、dev-flow.js への inline は tools/sync-inlines.mjs で生成する。
