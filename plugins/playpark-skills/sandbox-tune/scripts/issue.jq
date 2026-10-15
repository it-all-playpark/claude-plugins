# issue 化の材料（下書き）の組み立て。起票は github-issue-orchestrator が材料から AC・制約・変更対象パスを付けて行う。
# セキュリティ系かどうかは候補の security フラグと本文の語の両方で判定する（どちらかで真）。
# 判定漏れは公開 repo への起票に直結するので、語の一致は広めに取り、誤って真になる側に倒す。
def security_re:
  "secret|credential|password|passwd|private key|keychain|token|api[_ -]?key|\\.ssh|\\.aws|\\.gnupg|gh auth|environ|環境変数|資格情報|認証情報|秘密|鍵|他プロセス";

def is_security($text): (.security == true) or ($text | test(security_re; "i"));

def fill($v): reduce ($v | to_entries[]) as $e (.; gsub("\\{\\{\($e.key)\\}\\}"; $e.value | tostring));

def default_template:
  "## 概要\n\n{{title}}\n\n## 型\n\n`{{id}}`\n\n## 根拠\n\n{{evidence}}\n\n## 原因\n\n{{cause}}\n\n## 修正案\n\n{{fix}}\n\n## 安全性の評価\n\n{{safety}}\n\n---\nsandbox-tune が transcript の集計から書いた issue 化の材料。\n";

def evidence_md:
  "- 件数: \(.count) 件 / \(.sessions) session（\(.first_seen) 〜 \(.last_seen)）\n"
  + "- projects: \(.projects | join(", "))\n"
  + (if .status then "- 判定: \(.status)" + (if .evidence.commit then "（commit \(.evidence.commit[0:12]) \(.evidence.committed_at) の後に \(.evidence.after_count) 件、最終 \(.evidence.last_after // "なし")）" else "（関係する commit なし）" end) + "\n" else "" end)
  + "- 代表的なエラー文:\n" + ([ .examples[] | "  - `\(gsub("`"; "'"))`" ] | join("\n"));
