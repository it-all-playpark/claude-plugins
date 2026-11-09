---
name: dev-flow-health
description: |
  Reads the daily dev-flow health report (deterministic JSON of dev-flow / pr-iterate failure
  signatures with new / ongoing / resolved / regressed status and candidate commits), classifies
  each new or regressed signature as dev_flow / target_repo / environment / transient, explains the
  cause of each dev_flow signature from its runs and the candidate commit diffs, files one
  self-improve issue per dev_flow signature, files one self-improve issue per resolved model ID
  change (model_changes) asking to re-measure capability-bound.md, and outputs every classification
  in a marked block that daily.sh records.
  Use when: (1) the daily job or the journal trigger hands over a report with new / regressed signatures,
  (2) user asks why dev-flow started failing or which commit broke it,
  (3) keywords: dev-flow health, ヘルスレポート, 失敗の型, 再発, regressed, 回帰, どの commit から, self-improve.
  Accepts args: [<report.json>]（省略時は ~/.claude/logs/dev-flow-health/ の最新）
---

# dev-flow-health

dev-flow の失敗を決定論スクリプトで集計し、**新しく出た型（new）と、直ったはずが再び出た型
（regressed）があった実行だけ** LLM が原因の所在を振り分け、dev-flow 本体の欠陥と判断したものだけ原因と
修正案を書いて issue にする。dev-flow の agent が使った解決後の model ID が変わった実行（`model_changes`）では、
`capability-bound.md` の測り直しを求める issue を 1 変化 1 件で起票する。
集計・判定・候補 commit の列挙・model ID の変化の検出はすべて `scripts/health-report.sh` が行い、
振り分け結果の記録は `scripts/daily.sh` が本 skill の出力から `scripts/record-classification.sh` に渡して行う。
本 skill はその JSON を読んで考える部分（分類と理由・原因の推定）だけを担う。

## 日次の流れ

```
launchd 07:00（日次ジョブ）／ journal に entry が書かれた時（即時トリガ）→ scripts/daily.sh
  → lock（~/.claude/logs/dev-flow-health/.lock）を取って 1 本ずつ実行。重なった実行は待つ
  → scripts/health-report.sh（LLM 不使用。窓は直前の実行の generated_at から今まで）
    → ~/.claude/logs/dev-flow-health/YYYY-MM-DDTHHMMSSZ.json（実行ごとに別ファイル）
  → needs_llm（summary.new + summary.regressed > 0 か model_changes が 1 件以上）の実行だけ
    claude -p "/dev-flow:dev-flow-health <report>"
    → new / regressed がある実行は、出力の振り分けブロック（手順 7）を scripts/record-classification.sh に渡し
      classifications.jsonl に追記
```

即時トリガは journal ディレクトリ（`$CLAUDE_JOURNAL_DIR`、未設定なら `~/.claude/journal`）を launchd の
`WatchPaths` で監視し、失敗を日次を待たずに起票まで進める。日次ジョブは即時トリガの取りこぼし（スリープ中など）
を拾う網で、両方を登録しても窓が直前の実行から繋がるので、同じ失敗は 1 回だけ new / regressed になる。
成功 run の entry でも起動するが、new / regressed が無ければ決定論スクリプトだけで終わる。

登録はそれぞれ 1 回だけ手動で行う（`--print` で plist を確認、`--uninstall` で解除。即時トリガは
`--watch-journal` を付ける）。`--repo` は skills repo の git checkout を必須で渡す — plugin cache の install は
git ではなく候補 commit を列挙できないため、plist は checkout 内の `daily.sh` を `--repo <checkout>` 付きで起動する
（版付きの cache パスには固定しない）:

```bash
bash ${CLAUDE_PLUGIN_ROOT}/dev-flow-health/scripts/install-schedule.sh --install --repo <skills checkout>
bash ${CLAUDE_PLUGIN_ROOT}/dev-flow-health/scripts/install-schedule.sh --install --repo <skills checkout> --watch-journal
```

手元で今日のレポートだけ見たいときは `bash ${CLAUDE_PLUGIN_ROOT}/dev-flow-health/scripts/health-report.sh`
（`--since` / `--now` / `--resolve-after` / `--repo` は script 冒頭の Usage 参照）。

## レポートの読み方

| フィールド | 意味 |
|------------|------|
| `signatures[].signature` | `skill \| error.category \| error.phase \| テンプレート化した error.message`。パス・URL・hash・PR 番号・数値は `<*>`。`error.category == needs_clarification`（人間の判断待ちで止めた設計どおりの停止）は signature にしない |
| HOLD 由来の signature | `dev-flow \| hold \| Merge tier \| <HOLD 理由の code>`。merge tier が HOLD で終わった run（journal の `outcome` は `success`）の HOLD 理由のうち、dev-flow 自身や実行環境の不具合で出るものを 1 理由 1 signature で拾う（1 run に複数あれば別々に数える）。拾う理由は `final_reconcile_unavailable` / `final_ac_unavailable` / `pr_closes_missing` / `merge_facts_dropped` / `danger_fail_closed` / `ac_agent_unsatisfied` / `final_test_red`、Final reconcile を skip した run で Validate の red が残った `validate_test_red`、Validate でテストが起動しなかった（環境要因の起動失敗）`validate_tests_not_run`、実行対象のテストが 0 本だった `no_tests_run`（対象 repo 由来が多いがテスト検出の不具合でも起きる）、security review が今の PR head で clear にならなかった `security_review_unresolved`（template は `security_review_unresolved status=<security_review_status> stop=<security_review_stop_reason>`、例: `security_review_unresolved status=unresolved stop=reviewer_context_changed`。値の無い細目は `none`）、pr-iterate の終端 status が `ci_pending` / `ci_error` / `review_contract_error` / `stuck` / `fix_failed` / `max_reached` / `security_unresolved` の `iterate_non_lgtm`（template は `iterate_non_lgtm status=<status>`、`fix_failed` は `iterate_non_lgtm status=fix_failed fix=<fix_terminal_reason>`、`security_unresolved` は `security_review_unresolved` の template。`security_review_unresolved` のある run からは作らない）、観測型の判定か evaluator の `unreachable_env` で人手になった AC が未達の `ac_human_pending`。`mergeable_conflicting` など他の HOLD 理由は拾わない。再現率を優先して拾うので、必要だった HOLD も混ざる — 精度は手順の分類（`dev_flow` 以外は起票しない）で担う |
| 単体の pr-iterate の signature | `pr-iterate \| hold \| Iterate \| <template>`。単体起動（journal の `telemetry.iterate_caller` が `standalone`）の pr-iterate が LGTM に届かずに終わった run（`outcome` は `success`）を、HOLD 由来の `iterate_non_lgtm` と同じ status・同じ template で拾う。`iterate_caller` が `dev-flow`（dev-flow の nested）の entry は発生にも resolved の判定にも入れない — その run は dev-flow の HOLD 由来の signature が表す |
| `signatures[].id` | signature の sha1 先頭 12 桁。issue の重複検出に使う |
| `status` | `new`（窓内に初出）/ `regressed`（resolved の条件を満たした後に窓内で再発）/ `ongoing` / `resolved`（last_seen と別の `plugin_commit` で同じ skill が `resolve_after_runs` 回成功して再発なし。失敗 run は数えない） |
| `first_seen` / `last_seen` / `regressed_at` | `{timestamp, plugin_commit, file}`。`file` は `~/.claude/journal/` 下の entry |
| `recent_runs` | 直近 5 件の発生（issue / pr_number / `repo`（journal entry の `context.repo` = dev-flow を流した対象 repo、無ければ `null`）/ 元の message 付き） |
| `candidates` | new / regressed のみ。`last_good_commit..first_bad_commit` で `plugins/dev-flow/` を触った commit。列挙できなかったときは `error` に理由 |
| `issue_repo` | 起票先の `OWNER/NAME`。`--repo` の checkout の origin（GitHub URL）から script が解決する。checkout が無い・origin が GitHub でないときは `null` |
| `needs_llm` | new / regressed の signature が 1 件以上か、`model_changes` が 1 件以上なら `true` |
| `resolved_models` | agentType（`dev-flow:` で始まるものだけ）ごとの、窓の中に mtime が入る transcript で使われた解決後の model ID（`claude-` で始まるものだけ） |
| `known_models` | 直前の実行のレポートの `known_models` と `resolved_models` の和集合。これまでに見た ID |
| `model_changes` | `{agent_type, model_id, previous_model_ids, first_seen}` の配列。前回の `known_models` に無い ID が出た agentType ごとに 1 件。前回の `known_models` が空の agentType（初回）は種まきだけで変化にしない |
| `model_scan` | `{projects_dir, transcripts, error}`。transcript を読めないときは `error` に理由が入り、`model_changes` は空 |

## 手順（LLM 部分）

1. 引数のレポート（無ければ `~/.claude/logs/dev-flow-health/` の最新 `YYYY-MM-DDTHHMMSSZ*.json`）を Read する。
   `needs_llm` が false（new / regressed の signature も `model_changes` も無い）なら「new / regressed・model の変化なし」と
   報告して終える。
   `issue_repo` が `null` なら、重複確認・起票をせずに「起票先を解決できない（`--repo` に GitHub の origin を持つ
   checkout を渡す）」と報告して終える。起票先を推測したり別の repo を代わりに使ったりしない。
2. **model の変化**: `model_changes` の各件を、分類せずにそのまま 1 件 = 1 self-improve issue の finding にする。変化の判定は
   `health-report.sh` だけが行う — 件を足す・除く・まとめる・付け直すことをせず、3 の振り分けと 3.7 の記録ブロックにも入れない。
   `model_changes` が空なら 3 へ進む。各件について:
   1. **重複確認**: `gh issue list --repo <issue_repo> --label self-improve --state all --search "dev-flow-health:model:<agent_type>:<model_id>" --json number,title`。
      既にあればその件は finding に含めず、その issue 番号を報告に載せる（close 済みでも同じ ID の見直しは済んでいる）。
   2. **finding をまとめる**: 3.5 と同じ `$TMPDIR` の file に、1 件 1 節で次を書く:
      - 症状: 変わった agent（`agent_type`）・新しい ID（`model_id`）・前の ID（`previous_model_ids`）・`first_seen`
      - 求めること: `capability-bound.md`（`plugins/dev-flow/dev-flow/references/`）のうち、sunset トリガが
        「major モデルリリースごとの dry-run」の項目を、その項目の「次のモデル世代での測り直し方」に従って新しい ID で測り直し、
        撤去・緩和できると示せたものだけを別の issue → PR にする（gate・`gate_policy`・agent の frontmatter・項目をこの issue で
        直接変えない。merge は人間）
      - 変更対象パス: `plugins/dev-flow/dev-flow/references/capability-bound.md`
      - 本文末尾に残すマーカー: `<!-- dev-flow-health:model:<agent_type>:<model_id> -->`（次回の重複確認に使う。git-issue が
        作る本文の末尾にこの 1 行をそのまま残すよう finding に書く）
3. `status` が `new` / `regressed` の signature を原因の所在で振り分け、`dev_flow` に分類したものだけ finding に
   まとめて git-issue で起票し、全 signature の振り分けを記録用のブロックとして出力する（`<issue_repo>` はレポートの `issue_repo` の値）。
   1〜5 は signature ごとに行い、6・7 は全 signature の分を 1 回で行う。new / regressed の signature が無い
   （`model_changes` だけの）実行は 1〜5 と 7 を行わず、6 で 2 の finding だけを起票する:
   1. **該当 run を読む**: `recent_runs[].file` を `~/.claude/journal/` から Read し、error と telemetry を確認する。
      `recent_runs[].repo` が `issue_repo` と違えば、その run は PR 先の別 repo で走っている。
      HOLD 由来の signature（category が `hold`）は journal に HOLD 理由の code しか残らないので、該当 PR の dev-flow
      終端サマリー（PR コメント）を `gh pr view <recent_runs[].pr_number> --repo <recent_runs[].repo> --comments` で読み、
      HOLD の理由と現状から、HOLD が dev-flow・実行環境の不具合で出たのか、PR に必要な停止だったのかを判断する
      （`recent_runs[].repo` が `null` の run は `--repo <issue_repo>`。skill が `pr-iterate` の signature は同じコマンドで
      pr-iterate の終端サマリーを読む）。必要な停止だったもの（本物の脆弱性の指摘で止まった security review 等）は `dev_flow` にしない。
   2. **振り分け**: 次の 4 つのどれか 1 つに分類し、根拠を 1 文の理由にする（判定基準は 1 行ずつ）:
      - `dev_flow`: skills repo の plugin を直せば消える（dev-flow / pr-iterate の workflow・agent・script の欠陥）
      - `target_repo`: PR 先 repo のテスト・hook・lint が原因（pre-push の husky・tsc・vitest の失敗など）
      - `environment`: sandbox・認証・権限・hook 拒否など実行環境が原因（`Operation not permitted`・push の認証失敗など）
      - `transient`: 再実行で消える一過性（API の上限・ネットワークの一時的な断など）

      `dev_flow` 以外に分類した signature は 3〜5 と起票を行わず、7 の記録だけ行う。PR 先 repo や設定 repo にも
      起票しない。分類は起票の要否だけに使い、`status`・`candidates` を付け直さない。
   3. **重複確認**（`dev_flow` のみ）: `gh issue list --repo <issue_repo> --label self-improve --state open --search "dev-flow-health:<id>" --json number,title`。
      既にあればその signature は finding に含めず（起票しない）、その issue 番号を報告と記録に載せる。
   4. **候補 commit の diff を読む**（`dev_flow` のみ）: skills repo の checkout で `git show <sha> -- plugins/dev-flow/` を
      `candidates.commits` の各 sha について実行する。`candidates.error` があるときは推定の根拠が run だけになる
      ことを finding に書く。
   5. **finding をまとめる**（`dev_flow` のみ）: `$TMPDIR` の 1 つの file に、signature ごとに 1 節で次を書く:
      - 症状: signature・status・first_seen / last_seen（commit 付き）・発生回数・該当 run
      - 原因: どの候補 commit のどの変更が原因と考えるかの推定と、根拠（diff の該当箇所と error の対応）
      - 直し方: 修正案
      - 変更対象パス: 原因の推定で直す対象としたファイルの repo 相対パス
      - 本文末尾に残すマーカー: `<!-- dev-flow-health:<id> -->`（次回の重複確認に使う。git-issue が作る本文の末尾に
        この 1 行をそのまま残すよう finding に書く）
   6. **起票**: 重複を除いた finding（2 の model の変化と、`dev_flow` の signature）が 1 件以上あれば、Skill ツールで
      `dev-flow:git-issue` を 1 回だけ起動し、全 finding を渡す（signature・変化ごとに起動しない）:

      ```
      dev-flow:git-issue <finding の file> --repo <issue_repo> --labels self-improve
      ```

      各 finding は 1 signature（1 変化）= 1 agent issue・issue 間の依存なし・human タスクなしなので、git-issue は軽い経路で
      起票する。本文の構成・ゲート（ac-lint・`## 変更対象パス`・4000 字）で落ちたときの直し方は git-issue に任せ、
      本 skill は本文の雛形を持たない（素の `gh issue create` は dev-flow の hook が拒否する）。1 回の起動で渡すので、
      git-issue 軽い経路の手順 5 により `dev-flow-ready-set` が起票した全 issue に 1 回だけ走る。
   7. **記録**: 2 で振り分けた全 signature（`dev_flow` 以外も含む）の `{id, signature, classification, reason, issue}` を
      1 つの JSON 配列にし、次の 2 つのマーカー行で囲んだブロックとして最終出力に 1 回だけ含める。マーカー行は
      そのまま 1 行ずつ書き、間には JSON 配列だけを置く（コードフェンスで囲まない）:

      ```
      <!-- dev-flow-health-classifications:begin -->
      [{"id": "<id>", "signature": "<signature>", "classification": "dev_flow", "reason": "<理由 1 文>", "issue": 123}]
      <!-- dev-flow-health-classifications:end -->
      ```

      `id` / `signature` はレポートの値をそのまま写す。`issue` は 6 で起票した issue 番号か 3 で見つかった既存の
      issue 番号で、`dev_flow` 以外の分類と番号の無いものは `null`。記録は `claude -p` の終了後に `daily.sh` が
      出力の最後のブロックを `scripts/record-classification.sh` に渡し、レポートと同じディレクトリの
      `classifications.jsonl` に 1 signature 1 行で追記する — skill の Bash は sandbox 内で動き、`~/.claude/logs` に
      書けないため。本 skill から `record-classification.sh` を実行せず、JSONL を Write / Edit / echo で直接書かない。
      enum 外の `classification` が 1 件でもあると 1 行も記録されない。対話セッションから起動したときもブロックは
      出力する（その場合は記録されない）。
4. 分類ごとの signature 数、起票した issue 番号、重複で見送った signature と model の変化、
   `candidates.error` で原因を絞れなかった signature、`model_scan.error`（あれば）と、git-issue が返した `## Launch Order` を報告し、
   最後に 3.7 の振り分けブロックを置く（new / regressed の signature がある実行だけ）。

## 守ること

- 判定（status・候補 commit・`model_changes`）は script の出力をそのまま使う。LLM 側で状態を付け直さない。LLM が決めるのは分類と理由だけ
- 起票した issue の実装は人間が `/dev-flow` で起動する。本 skill は実装・merge をしない
- `dev_flow` に分類した signature だけ 1 signature = 1 issue で起票する。`target_repo` / `environment` / `transient` は記録だけ
- `model_changes` は分類せず 1 件 = 1 issue で起票する。起票は見直しの合図だけで、gate・agent の frontmatter・
  `capability-bound.md` の項目を本 skill から変えない
- 起票先はレポートの `issue_repo` だけを使う。`null` のときは起票しない（fail-closed）
