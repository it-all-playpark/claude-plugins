---
name: dev-flow-health
description: |
  Reads the daily dev-flow health report (deterministic JSON of dev-flow / pr-iterate failure
  signatures with new / ongoing / resolved / regressed status and candidate commits), explains
  the cause of each new or regressed signature from its runs and the candidate commit diffs,
  and files one self-improve issue per signature.
  Use when: (1) the daily job hands over a report with new / regressed signatures,
  (2) user asks why dev-flow started failing or which commit broke it,
  (3) keywords: dev-flow health, ヘルスレポート, 失敗の型, 再発, regressed, 回帰, どの commit から, self-improve.
  Accepts args: [<report.json>]（省略時は ~/.claude/logs/dev-flow-health/ の最新）
---

# dev-flow-health

dev-flow の失敗を毎日決定論スクリプトで集計し、**新しく出た型（new）と、直ったはずが再び出た型
（regressed）があった日だけ** LLM が原因と修正案を書いて issue にする。集計・判定・候補 commit の
列挙はすべて `scripts/health-report.sh` が行い、本 skill はその JSON を読んで考える部分だけを担う。

## 日次の流れ

```
launchd 07:00 → scripts/daily.sh
  → scripts/health-report.sh（LLM 不使用）→ ~/.claude/logs/dev-flow-health/YYYY-MM-DD.json
  → summary.new + summary.regressed > 0 の日だけ claude -p "/dev-flow:dev-flow-health <report>"
```

登録は 1 回だけ手動で行う（`--print` で plist を確認、`--uninstall` で解除）。`--repo` は skills repo の
git checkout を必須で渡す — plugin cache の install は git ではなく候補 commit を列挙できないため、plist は
checkout 内の `daily.sh` を `--repo <checkout>` 付きで起動する（版付きの cache パスには固定しない）:

```bash
bash ${CLAUDE_PLUGIN_ROOT}/dev-flow-health/scripts/install-schedule.sh --install --repo <skills checkout>
```

手元で今日のレポートだけ見たいときは `bash ${CLAUDE_PLUGIN_ROOT}/dev-flow-health/scripts/health-report.sh`
（`--since` / `--now` / `--resolve-after` / `--repo` は script 冒頭の Usage 参照）。

## レポートの読み方

| フィールド | 意味 |
|------------|------|
| `signatures[].signature` | `skill \| error.category \| error.phase \| テンプレート化した error.message`。パス・URL・hash・PR 番号・数値は `<*>`。`error.category == needs_clarification`（人間の判断待ちで止めた設計どおりの停止）は signature にしない |
| `signatures[].id` | signature の sha1 先頭 12 桁。issue の重複検出に使う |
| `status` | `new`（窓内に初出）/ `regressed`（resolved の条件を満たした後に窓内で再発）/ `ongoing` / `resolved`（last_seen と別の `plugin_commit` で同じ skill が `resolve_after_runs` 回成功して再発なし。失敗 run は数えない） |
| `first_seen` / `last_seen` / `regressed_at` | `{timestamp, plugin_commit, file}`。`file` は `~/.claude/journal/` 下の entry |
| `recent_runs` | 直近 5 件の発生（issue / pr_number / 元の message 付き） |
| `candidates` | new / regressed のみ。`last_good_commit..first_bad_commit` で `plugins/dev-flow/` を触った commit。列挙できなかったときは `error` に理由 |
| `issue_repo` | 起票先の `OWNER/NAME`。`--repo` の checkout の origin（GitHub URL）から script が解決する。checkout が無い・origin が GitHub でないときは `null` |

## 手順（LLM 部分）

1. 引数のレポート（無ければ `~/.claude/logs/dev-flow-health/` の最新 `YYYY-MM-DD.json`）を Read する。
   `needs_llm` が false なら「new / regressed なし」と報告して終える。
   `issue_repo` が `null` なら、重複確認・起票をせずに「起票先を解決できない（`--repo` に GitHub の origin を持つ
   checkout を渡す）」と報告して終える。起票先を推測したり別の repo を代わりに使ったりしない。
2. `status` が `new` / `regressed` の signature ごとに、以下を行う（`<issue_repo>` はレポートの `issue_repo` の値）:
   1. **重複確認**: `gh issue list --repo <issue_repo> --label self-improve --state open --search "dev-flow-health:<id>" --json number,title`。
      既にあれば起票せず、その issue 番号を報告に載せる。
   2. **該当 run を読む**: `recent_runs[].file` を `~/.claude/journal/` から Read し、error と telemetry を確認する。
   3. **候補 commit の diff を読む**: skills repo の checkout で `git show <sha> -- plugins/dev-flow/` を
      `candidates.commits` の各 sha について実行する。`candidates.error` があるときは推定の根拠が run だけになる
      ことを本文に書く。
   4. **起票**: 本文を `$TMPDIR` の file に書き、github-issue-orchestrator の `create_issue.py` で起票する
      （素の `gh issue create` は dev-flow の hook が拒否する）:

      ```bash
      python3 ${CLAUDE_PLUGIN_ROOT}/github-issue-orchestrator/scripts/create_issue.py --kind agent --labels self-improve \
        --repo <issue_repo> --title "<fix(dev-flow): 症状を一文で>" --body-file <file>
      ```

      本文は analyze が先頭から読むので、次の雛形の順で短く書く。`## 変更対象パス` には原因の推定で直す対象とした
      ファイルを repo 相対パスで 1 行 1 つ並べる。`create_issue.py` が exit 1 で拒否したら（受け入れ条件が
      `- [ ]` でない・`## 変更対象パス` が無い / 空・AC 節を除いて 4000 字超など）、stderr の理由に沿って本文を直して再実行する:

      ```markdown
      ## 背景
      <signature・status・first_seen / last_seen（commit 付き）・発生回数・該当 run>

      ## 原因の推定
      <どの候補 commit のどの変更が原因と考えるか、根拠（diff の該当箇所と error の対応）>

      ## 修正案
      <直し方>

      ## 変更対象パス
      - <原因の推定で直す対象としたファイルの repo 相対パス>

      ## 受け入れ条件
      - [ ] <検証可能な条件>

      <!-- dev-flow-health:<id> -->
      ```

      末尾の `<!-- dev-flow-health:<id> -->` は次回の重複確認に使う。
3. 起票した issue 番号、重複で見送った signature、`candidates.error` で原因を絞れなかった signature を報告する。

## 守ること

- 判定（status・候補 commit）は script の出力をそのまま使う。LLM 側で状態を付け直さない
- 起票した issue の実装は人間が `/dev-flow` で起動する。本 skill は実装・merge をしない
- 1 signature = 1 issue
- 起票先はレポートの `issue_repo` だけを使う。`null` のときは起票しない（fail-closed）
