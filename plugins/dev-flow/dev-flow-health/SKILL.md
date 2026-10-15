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
2. `status` が `new` / `regressed` の signature について finding をまとめ、git-issue で起票する（`<issue_repo>` は
   レポートの `issue_repo` の値）。1〜4 は signature ごとに行い、5 は全 signature の分を 1 回で行う:
   1. **重複確認**: `gh issue list --repo <issue_repo> --label self-improve --state open --search "dev-flow-health:<id>" --json number,title`。
      既にあればその signature は finding に含めず（起票しない）、その issue 番号を報告に載せる。
   2. **該当 run を読む**: `recent_runs[].file` を `~/.claude/journal/` から Read し、error と telemetry を確認する。
   3. **候補 commit の diff を読む**: skills repo の checkout で `git show <sha> -- plugins/dev-flow/` を
      `candidates.commits` の各 sha について実行する。`candidates.error` があるときは推定の根拠が run だけになる
      ことを finding に書く。
   4. **finding をまとめる**: `$TMPDIR` の 1 つの file に、signature ごとに 1 節で次を書く:
      - 症状: signature・status・first_seen / last_seen（commit 付き）・発生回数・該当 run
      - 原因: どの候補 commit のどの変更が原因と考えるかの推定と、根拠（diff の該当箇所と error の対応）
      - 直し方: 修正案
      - 変更対象パス: 原因の推定で直す対象としたファイルの repo 相対パス
      - 本文末尾に残すマーカー: `<!-- dev-flow-health:<id> -->`（次回の重複確認に使う。git-issue が作る本文の末尾に
        この 1 行をそのまま残すよう finding に書く）
   5. **起票**: 重複を除いた finding が 1 件以上あれば、Skill ツールで `dev-flow:git-issue` を 1 回だけ起動し、
      全 finding を渡す（signature ごとに起動しない）:

      ```
      dev-flow:git-issue <finding の file> --repo <issue_repo> --labels self-improve
      ```

      各 finding は 1 signature = 1 agent issue・issue 間の依存なし・human タスクなしなので、git-issue は軽い経路で
      起票する。本文の構成・ゲート（ac-lint・`## 変更対象パス`・4000 字）で落ちたときの直し方は git-issue に任せ、
      本 skill は本文の雛形を持たない（素の `gh issue create` は dev-flow の hook が拒否する）。1 回の起動で渡すので、
      git-issue 軽い経路の手順 5 により `dev-flow-ready-set` が起票した全 issue に 1 回だけ走る。
3. 起票した issue 番号、重複で見送った signature、`candidates.error` で原因を絞れなかった signature と、git-issue が
   返した `## Launch Order` を報告する。

## 守ること

- 判定（status・候補 commit）は script の出力をそのまま使う。LLM 側で状態を付け直さない
- 起票した issue の実装は人間が `/dev-flow` で起動する。本 skill は実装・merge をしない
- 1 signature = 1 issue
- 起票先はレポートの `issue_repo` だけを使う。`null` のときは起票しない（fail-closed）
