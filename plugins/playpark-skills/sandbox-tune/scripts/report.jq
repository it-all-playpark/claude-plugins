# collect / verify の結果を Markdown にする。出す文字列はすべて伏せ字を通す。
include "redact";

def cell: tostring | gsub("\\|"; "\\|") | gsub("\\n"; " ");

def category_label:
  {sandbox: "sandbox 拒否", request: "人間への実行依頼", permission: "permission 拒否", host_exec: "host-exec"}[.] // .;

# 後の発生の branch が修正 commit を含むかの内訳
def branches_text:
  .evidence.after_branches as $b
  | if $b and .evidence.after_count > 0 then "（修正を含む branch \($b.contains) / 含まない \($b.not_contains) / 判定不能 \($b.unknown)）" else "" end;

def evidence_cell:
  if .status == null then "-"
  elif .evidence.commit then "\(.evidence.commit[0:12]) (\(.evidence.repo) \(.evidence.committed_at)) の後 \(.evidence.after_count) 件" + (if .evidence.last_after then "、最終 \(.evidence.last_after)" else "" end) + branches_text
  else "関係する commit なし" + (if .evidence.note then "（\(.evidence.note)）" else "" end) end;

def detail:
  "### `\(.id | gsub("`"; "'"))`\n\n"
  + "- 種別: \(.category | category_label) / \(.kind)\n"
  + "- 件数: \(.count) 件 / \(.sessions) session（\(.first_seen) 〜 \(.last_seen)）\n"
  + "- projects: \(.projects | join(", "))\n"
  + (if .after_block != null then "- 直前の Bash が拒否されていた: \(.after_block) / \(.count) 件（残りは Bash を試さずに host-exec へ行った）\n" else "" end)
  + (if .status then
       "- 判定: **\(.status)** — "
       + (if .evidence.commit then
            "関係する commit `\(.evidence.commit[0:12])`（\(.evidence.repo) \(.evidence.committed_at)「\(.evidence.subject)」）の後の発生 \(.evidence.after_count) 件"
            + (if .evidence.last_after then "、最終 \(.evidence.last_after)" else "" end) + branches_text
          else "関係する commit なし（発生 \(.count) 件、最終 \(.last_seen)）" + (if .evidence.note then "。\(.evidence.note)" else "" end) end)
       + "\n"
     else "" end)
  + (if .intended then "- 意図した拒否: \(.intended.reason)（設定の intended に \(.intended.by) で一致）\n" else "" end)
  + "- 代表的なエラー文:\n\n" + ([ .examples[] | "  ~~~\n  \(gsub("\\n"; "\n  "))\n  ~~~" ] | join("\n")) + "\n";

redact_all
| (.verify != null) as $verified
| "# sandbox-tune レポート（\(.period.since) 〜 \(.period.until)）\n\n"
  + "- 期間: \(.period.days) 日 / transcript: \(.files_scanned) ファイル（\(.projects_dir)）/ 型: \(.types | length) 件\n"
  + (if $verified then "- 設定 repo: \(.verify.repo)（見たパス: \(.verify.paths | join(", "))）。拒否が起きた repo は .claude/settings.json を見た\n"
     else "- 設定 repo: なし（verify は未実施。resolved / remaining の判定なし）\n" end)
  + (if (.criteria_files // []) | length > 0 then "- 追加の判定基準: \(.criteria_files | join(", "))\n" else "" end)
  + "\n## 型の一覧\n\n"
  + "| 判定 | 種別 | 対象 | 件数 | session | 最初 | 最後 | 根拠 |\n|---|---|---|---|---|---|---|---|\n"
  + ([ .types[] | "| \(.status // "-") | \(.category | category_label) / \(.kind) | `\(.target | cell | gsub("`"; "'"))` | \(.count) | \(.sessions) | \(.first_seen) | \(.last_seen) | \(evidence_cell | cell) |" ] | join("\n"))
  + "\n\n"
  + (if $verified then
       "## remaining（原因・修正案・安全性を判断する対象）\n\n"
       + ([ .types[] | select(.status == "remaining") | detail ] | if length == 0 then "なし\n" else join("\n") end)
       + "\n## stale_branch（修正前の branch での発生。修正案は出さない）\n\n"
       + ([ .types[] | select(.status == "stale_branch") | detail ] | if length == 0 then "なし\n" else join("\n") end)
       + "\n## resolved\n\n"
       + ([ .types[] | select(.status == "resolved") | detail ] | if length == 0 then "なし\n" else join("\n") end)
       + "\n## intended（設定の intended に当たる意図した拒否。修正案は出さない）\n\n"
       + ([ .types[] | select(.status == "intended") | detail ] | if length == 0 then "なし\n" else join("\n") end)
     else
       "## 型の詳細\n\n" + ([ .types[] | detail ] | if length == 0 then "なし\n" else join("\n") end)
     end)
