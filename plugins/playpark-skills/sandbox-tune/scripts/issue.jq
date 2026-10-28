# issue 化の材料（下書き）の組み立て。既定テンプレートは受け入れ基準と変更対象パスを持ち、
# dev-flow の起票ゲート（git-issue の create_issue.py --kind agent）をそのまま通る形にする。
# セキュリティ系かどうかは候補の security フラグと本文の語の両方で判定する（どちらかで真）。
# 判定漏れは公開 repo への起票に直結するので、語の一致は広めに取り、誤って真になる側に倒す。
def security_re:
  "secret|credential|password|passwd|private key|keychain|token|api[_ -]?key|\\.ssh|\\.aws|\\.gnupg|gh auth|environ|環境変数|資格情報|認証情報|秘密|鍵|他プロセス";

def is_security($text): (.security == true) or ($text | test(security_re; "i"));

def fill($v): reduce ($v | to_entries[]) as $e (.; gsub("\\{\\{\($e.key)\\}\\}"; $e.value | tostring));

def default_template:
  "## 概要\n\n{{title}}\n\n## 型\n\n`{{id}}`\n\n## 根拠\n\n{{evidence}}\n\n## 原因\n\n{{cause}}\n\n## 修正案\n\n{{fix}}\n\n## 安全性の評価\n\n{{safety}}\n\n"
  + "## 受け入れ基準（Acceptance Criteria）\n\n{{ac}}\n\n## 変更対象パス\n\n{{paths}}\n\n---\nsandbox-tune が transcript の集計から書いた issue 化の材料。\n";

# 候補ファイルの不正を 1 行 1 件で出す。paths は create_issue.py --kind agent と同じく repo の外を指すエントリを受理しない
# （改行を含むエントリは別の行として読まれ、この検査をすり抜けるので 1 行に限る）
def candidates_errors:
  def strs: type == "array" and length > 0 and all(.[]; type == "string" and . != "");
  if type != "object" or (.candidates | type) != "array" then
    "candidates は {\"candidates\":[{id,title,cause,fix,safety,ac,paths,security}]} の形にしてください"
  else
    .candidates | to_entries[] | .key as $i | .value
    | if type != "object" then "candidates[\($i)] はオブジェクトにしてください"
      else
        ("candidates[\($i)]" + (if (.id | type) == "string" then " (\(.id))" else "" end)) as $at
        | (if (.id | type) != "string" or ([.title, .cause, .fix, .safety] | all(type == "string" and . != "") | not)
           then "\($at): id・title・cause・fix・safety は空でない文字列にしてください" else empty end),
          (if .ac | strs | not then "\($at): ac は空でない文字列の配列にしてください（検証できる受け入れ基準を 1 項目 1 要素で）" else empty end),
          (if (.paths | type) != "array" or (.paths | length) == 0 then "\($at): paths は空でない配列にしてください（repo 相対パスか glob）"
           else
             .paths[]
             | if type != "string" or . == "" or test("[\r\n]") then "\($at): paths の要素は 1 行の空でない文字列にしてください: \(tojson)"
               elif startswith("/") then "\($at): paths は repo 相対で書いてください（/ 始まりは不可）: \(.)"
               elif split("/") | any(. == "..") then "\($at): paths に .. セグメントは使えません（repo の外を指せない）: \(.)"
               else empty end
           end)
      end
  end;

# 日次の判断（daily.sh）の skipped の不正を 1 行 1 件で出す。issue にしなかった型も判断済みとして記録するので、id と分類が要る
def skipped_errors:
  if (.skipped | type) != "array" then "skipped は [{id,class,reason}] の配列にしてください"
  else
    .skipped | to_entries[]
    | if (.value | type) != "object" or (.value.id | type) != "string" or (.value | has("class") | not)
      then "skipped[\(.key)] は id（文字列）と class を持つオブジェクトにしてください: \(.value | tojson)" else empty end
  end;

def ac_md: map("- [ ] " + .) | join("\n");

def paths_md: map("- " + .) | join("\n");

# 提出先が公開 repo のときに、公開 repo の cwd で起きた代表例と公開 repo の projects だけを残し、外した数を omitted_* に持つ。
# $public は公開 repo と確かめられた path の {path: true}。提出先が非公開なら null で、型をそのまま返す。
# 伏せ字は形しか見ず固有名詞（取引先名・案件名）を止められないので、名前ではなく出どころの公開範囲で落とす
def publishable($public):
  if $public == null then .
  else
    (.example_cwds // []) as $cwds
    | (.examples | to_entries | map(select(any(($cwds[.key] // [])[]; $public[. // ""] == true)) | .value)) as $examples
    | (.projects | map(select($public[.] == true))) as $projects
    | .omitted_examples = ((.examples | length) - ($examples | length))
    | .omitted_projects = ((.projects | length) - ($projects | length))
    | .examples = $examples
    | .projects = $projects
  end;

def evidence_md:
  "- 件数: \(.count) 件 / \(.sessions) session（\(.first_seen) 〜 \(.last_seen)）\n"
  + "- projects: \([(.projects | join(", ") | select(. != "")), (if (.omitted_projects // 0) > 0 then "非公開 repo \(.omitted_projects) 件" else empty end)] | join(" / "))\n"
  + (if .status then "- 判定: \(.status)" + (if .evidence.commit then "（commit \(.evidence.commit[0:12]) \(.evidence.committed_at) の後に \(.evidence.after_count) 件、最終 \(.evidence.last_after // "なし")）" else "（関係する commit なし）" end) + "\n" else "" end)
  + "- 代表的なエラー文:\n"
  + ([ (.examples[] | "  - `\(gsub("`"; "'"))`"),
       (if (.omitted_examples // 0) > 0 then "  - （非公開 repo で起きた例 \(.omitted_examples) 件は、提出先が公開 repo なので省いた）" else empty end) ]
     | join("\n"));
