# transcript (*.jsonl) を 1 行ずつ読み、集計前の事象を 1 件 1 行の JSON で出す。
# jq -R -n -c -L <scripts> --arg home --argjson since --argjson until -f extract.jq <files...>
#
# 事象の種類 (cat):
#   sandbox    Bash の tool_result に出た sandbox 由来の拒否
#   request    assistant が人間にコマンドの実行を頼んだ発言
#   permission permission の拒否（permission rule / hook / auto mode classifier / 人間の reject）
#   host_exec  host-exec plugin（mcp__host-exec__run）で sandbox の外に出した実行。kind は ran / declined / refused。
#              人間への依頼を置き換える経路なので、頻度が上がると承認が形骸化する。settings や手順で直すべきものが
#              ここに流れていないかを見るために数える
#
# 誤検出を避けるための不変条件:
#   - sandbox は Bash の tool_result だけを見る。assistant の文・人間の `!` 実行の出力（user の文字列 content）は見ない
#     ので、依頼の文に含まれたコマンドやエラー文を拒否として二重に数えない
#   - 出力を表示するだけのコマンド（grep / cat 等）の結果は、そのコマンド自身の診断行（`grep: ...`）だけを数える。
#     それ以外のコマンドも診断行の形をした行（diagnostic_line）だけを数える。
#     ファイル本文・issue 本文・JSON に拒否の文言が含まれていただけのものを拒否にしない
#   - <sandbox_violations> は出力末尾に付いたブロックだけを読む（harness が末尾に付ける。本文中の言及は数えない）
#   - subagent の transcript と isSidechain の行は数えない
include "redact";

def epoch_of: (sub("\\.[0-9]+"; "") | fromdateiso8601?) // null;

def text_of:
  if type == "string" then .
  elif type == "array" then [ .[]? | select(type == "object" and .type == "text") | .text // "" ] | join("\n")
  else "" end;

def home_rel: if startswith($home + "/") then "~" + .[($home | length):] else . end;

# 同じ対象を 1 つの型にまとめるため、worktree 名・一時ディレクトリ・UUID を潰す
def norm_path:
  home_rel
  | gsub("/\\.claude/worktrees/[^/]+"; "/.claude/worktrees/*")
  | gsub("/\\.git/worktrees/[^/]+"; "/.git/worktrees/*")
  | gsub("^/(?:private/)?var/folders/[^/]+/[^/]+/T(?=/|$)"; "$TMPDIR")
  | gsub("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"; "*")
  | if . == "/" then . else sub("/+$"; "") end;

def abs_path($cwd):
  if startswith("/") or startswith("~") or $cwd == "" or test("\\A[A-Za-z][A-Za-z0-9+.-]*://") then . else $cwd + "/" + sub("^\\./"; "") end
  | norm_path;

def project_of($l): ($l.cwd // "") | home_rel | sub("/\\.claude/worktrees/.*$"; "");

# 先頭の単純コマンドのトークン列（cd / 環境変数代入 / sudo などの前置は除く）
def cmd_tokens:
  [ (. // "") | splits("\\s*(?:&&|\\|\\||;|\\||\\n)\\s*")
    | select(test("\\S") and (test("\\A\\s*(?:cd|pushd)(?:\\s|\\z)") | not))
    | [ splits("\\s+") | select(. != "") | gsub("\\A[\"'(]+|[\"')]+\\z"; "") ]
    | until(
        (length == 0)
        or (((.[0] | test("\\A[A-Za-z_][A-Za-z0-9_]*=")) or (.[0] | IN("", "sudo", "env", "exec", "command", "time", "nohup", "!", "$"))) | not);
        .[1:])
    | select(length > 0) ]
  | .[0] // [];

# 型のキーに使うコマンド名（サブコマンドがあれば 2 語まで）
def cmd_head:
  cmd_tokens as $t
  | if ($t | length) == 0 then ""
    else ($t[0] | home_rel) + (if (($t[1] // "") | test("\\A[a-z][a-z0-9:_-]*\\z")) then " " + $t[1] else "" end)
    end;

# 出力を表示するだけのコマンドなら、その名前（診断行の接頭辞として使う）
def reader_name:
  cmd_tokens
  | ((.[0] // "") | sub("\\A.*/"; "")) as $c
  | (.[1] // "") as $s
  | if ($c | IN("grep", "egrep", "fgrep", "rg", "ag", "ack", "cat", "bat", "head", "tail", "less", "more",
                "sed", "awk", "jq", "nl", "wc", "sort", "uniq", "cut")) then $c
    elif $c == "git" and ($s | IN("grep", "show", "log", "diff", "blame")) then $c
    else null end;

# EPERM は大文字・語境界で見る（大小無視だと requirePermission 等の識別子に当たる）
def ls_re: "kLSServerCommunicationErr|error -10822|\\(-10822\\)|LSOpenURLsWithRole\\(\\) failed";
def is_denial_line: test("operation not permitted"; "i") or test("\\bEPERM\\b|" + ls_re);

# sandbox_events が事象を出しうる文言（is_denial_line・diagnostic_line・line_target・trailing_violations の上位集合）。
# どれも含まない Bash の結果は事象 0 件なので、行に割って正規表現を当てる前に本文全体への 1 回の test で飛ばす
# （collect の時間の大半がここ）。大小無視は operation not permitted だけ（全体に掛けると requirePermission 等に当たる）
def denial_hint_re: "(?i:operation not permitted)|EPERM|kLSServerCommunicationErr|-10822|LSOpenURLsWithRole|<sandbox_violations>";

def strip_ansi: gsub("\u001b\\[[0-9;]*[A-Za-z]"; "");

# 出力の 1 行。JSON の行（ツールが stderr を JSON に包んで返す形）は中の文字列を行に割って見る
def candidate_lines:
  splits("\\n") | strip_ansi
  | if test("\\A\\s*\\{") then ([ fromjson? | .. | strings | splits("\\n") ] | if length > 0 then .[] else empty end) else . end;

# 拒否の診断行の形をしているか。文書・JSON・表・箇条書きの中に拒否の文言が書かれていただけの行を外すため、
# 文言が行末にある（`<path>: Operation not permitted`）か、`operation not permitted, open '<path>'` の形か、
# エラーの接頭辞で始まる行の EPERM だけを数える
def diagnostic_line:
  sub("\\A\\s+"; "") as $s
  | ($s | test("\\A(?:[{\\[\"|*#>`]|- |[0-9]+\\. )") | not)
    and ($s | test("\\A[^\\s:]+:[0-9]+[:-]") | not)
    and (($s | test("operation not permitted(?: \\(os error [0-9]+\\))?[.\\s]*\\z"; "i"))
         or ($s | test("operation not permitted[,:] [^']{0,20}'[^']+'"; "i"))
         or (($s | test("`") | not)
             and ($s | test("\\A(?:[^\\s:]+: )?(?:npm (?:error|ERR!)|error|fatal|Error)\\b.*\\bEPERM\\b|" + ls_re))));

def trailing_violations:
  [ capture("<sandbox_violations>\\n(?<b>[\\s\\S]*?)</sandbox_violations>\\s*\\z") ] | .[0];

def violation_target:
  [ capture("\\Adeny (?<op>\\S+) (?<t>\\S+)") ] | .[0]
  | if . == null then empty
    elif (.op | startswith("network")) and (.t | startswith("/")) then {kind: "unix_socket", target: (.t | norm_path)}
    elif (.op | startswith("network")) then {kind: "network", target: (.t | sub(":[0-9]+\\z"; ""))}
    else {kind: "path", target: (.t | norm_path)} end;

def line_target($cwd; $head):
  if test("kLSServerCommunicationErr|-10822|LSOpenURLsWithRole") then {kind: "launch_services", target: $head}
  else
    ([ capture("(?:socket at|dial unix|connect EPERM|connect\\(\\) to) '?(?<p>/[^'\\s:]+)") ] | .[0]) as $sock
    | ([ capture("'(?<p>[^'\\s]*/[^'\\s]*|\\.[^'\\s/]+)'") ] | .[0]) as $quoted
    | ([ capture("(?:\\A|\\s)(?<p>[^\\s:'\"]*[/.][^\\s:'\"]*): operation not permitted"; "i") ] | .[0]) as $bare
    | if $sock then {kind: "unix_socket", target: ($sock.p | abs_path($cwd))}
      elif $quoted then {kind: "path", target: ($quoted.p | abs_path($cwd))}
      elif $bare then {kind: "path", target: ($bare.p | abs_path($cwd))}
      else {kind: "command", target: $head} end
    | if .kind == "path" and (.target | test("\\.sock\\z")) then .kind = "unix_socket" else . end
  end;

def needle_of:
  if .kind == "path" or .kind == "unix_socket" then
    # 設定ファイルには ~ 形式・絶対パス形式のどちらでも書かれるので、home 以下の部分で突き合わせる。
    # home 直下のドット dir（~/.npm/... 等）と home 外は先頭 2 段、repo 内などそれ以外は末尾 2 段を使う
    .target as $p
    | ($p | sub("\\A~/"; "") | [splits("/")] | map(select(. != ""))) as $s
    | (if ($p | startswith("~/.")) or ($p | startswith("~") | not) then $s[0:2] else $s[-2:] end)
    | map(select(test("\\*") | not)) | join("/")
  else .target end;

# 対象・代表例は伏せ字を通してから切り詰める（先に切ると PEM 等の終端が落ちて伏せ字から漏れる）。
# cwd と git_branch は verify が発生した repo の修正と branch を突き合わせるのに使う（worktree 名を潰さずに残す）
def event($l; $cat; $kind; $target; $id; $example):
  ($target | redact) as $t
  | {id: $id, cat: $cat, kind: $kind, target: $t,
     key: "\($cat):\($kind):\($t)",
     epoch: ($l.timestamp | epoch_of), session: $l.sessionId, project: project_of($l),
     cwd: (($l.cwd // "") | if . == "" then null else home_rel end),
     git_branch: (($l.gitBranch // "") | if . == "" then null else . end),
     example: ($example | redact | .[0:300])}
  | .ts = (.epoch | todate)
  | .needle = needle_of;

def worktree_guard_re: "\\A(?:Error: )?This session is isolated in the worktree \\S+, but this command";

def permission_events($l; $r; $tu; $txt):
  # hook の deny は permission rule と同じ kind で記録されるが、直す場所（hook）が違うので分ける
  # worktree 分離ガードは toolDenialKind を付けずに記録され、設定では外せない（コマンドの形を変えて直す）
  (if ($txt | test("\\APreToolUse:\\S+ hook error")) then "hook"
   elif ($txt | test(worktree_guard_re)) then "worktree-guard"
   else $l.toolDenialKind end
   // (if ($txt | test("doesn't want to proceed")) then "user-rejected"
       elif ($txt | test("auto mode classifier")) then "automode-blocked"
       else "permission-rule" end)) as $kind
  | ($tu.name // ([ $txt | capture("Permission to use (?<t>\\S+)") ] | .[0].t) // "unknown") as $tool
  | ($tu.command // ([ $txt | capture("with command (?<c>[\\s\\S]*) has been denied") ] | .[0].c)) as $cmd
  # worktree-guard はコマンド名でなく形（ループ・-C・複文）で拒否するので、コマンド名で割らず 1 つの型にする
  | (if $kind == "worktree-guard" then "*"
     elif $tool == "Bash" and $cmd != null then ($cmd | cmd_head)
     elif $tu.file_path then ($tu.file_path | norm_path)
     else $tool end) as $target
  | event($l; "permission"; $kind; "\($tool) \($target)"; "permission:" + $r.tool_use_id; $txt)
  | .needle = ($target | redact);

def sandbox_events($l; $r; $tu; $txt):
  ($tu.command // "") as $cmd
  | ($cmd | cmd_head) as $head
  | ($cmd | reader_name) as $reader
  | ($l.cwd // "") as $cwd
  | ($txt | trailing_violations) as $viol
  | (if $viol then ($txt | sub("<sandbox_violations>[\\s\\S]*\\z"; "")) else $txt end) as $body
  | ([ ($viol.b // "") | splits("\\n") | select(startswith("deny ")) | . as $line | violation_target + {example: $line} ]
     + [ $body
         | if $reader then splits("\\n") | strip_ansi | select(startswith($reader + ": ") and is_denial_line)
           else candidate_lines | select(diagnostic_line) end
         | . as $line | line_target($cwd; $head) + {example: $line} ]) as $found
  # 対象が特定できた行があれば、同じ失敗の言い換え（`npm error code EPERM` 等）をコマンド名の型として重ねない
  | (if any($found[]; .kind != "command") then [ $found[] | select(.kind != "command") ] else $found end)
  | unique_by([.kind, .target])
  | .[]
  | event($l; "sandbox"; .kind; .target; "sandbox:\($r.tool_use_id):\(.kind):\(.target)"; .example);

def request_re:
  "通常のターミナル|ターミナルで|手元で|ご自身で|手動で(?:実行|叩)|run (?:it|this|these|that|the following)(?: commands?)? (?:yourself|manually|in your (?:own )?terminal)|in (?:a|your) (?:regular|normal|own) terminal|please run";

def request_cmds:
  . as $t
  | [ $t | scan("`!\\s*([^`\\n]+)`") | .[0] ] as $bang
  | (if ($bang | length) > 0 then $bang
     elif ($t | test(request_re; "i")) then
       # コードブロックはコメント行を飛ばした最初の行、無ければ空白を含むインラインコード
       ([ $t | scan("```[A-Za-z0-9_-]*\\n([\\s\\S]*?)```") | .[0] | [splits("\\n")] | map(select(test("\\S") and (test("\\A\\s*#") | not))) | .[0] // empty ]
        + [ $t | scan("`([^`\\n]*\\s[^`\\n]*)`") | .[0] ]) | .[0:1]
     else [] end)
  | map(sub("\\A\\s*[!$]\\s*"; ""))
  # 先頭の語がコマンドの形をしていないもの（日本語の語句など）は依頼として扱わない
  | map(select(test("\\A[A-Za-z0-9_.~/+=-]+(?:\\s|\\z)")));

def request_events($l):
  ($l.message.id // $l.uuid) as $mid
  | [ $l.message.content[]? | select(type == "object" and .type == "text") | .text // "" ] | join("\n")
  | request_cmds
  | map({cmd: ., head: cmd_head}) | map(select(.head != "")) | unique_by(.head)
  | .[]
  | event($l; "request"; "request"; .head; "request:\($mid):\(.head)"; .cmd);

def host_exec_tool: "mcp__host-exec__run";

# argv の最初の位置引数（git の -C / -c は値ごと飛ばす。`git -C <repo> fetch` を `git fetch` にまとめる）
def first_positional($b):
  if length == 0 then null
  elif (.[0] | startswith("-")) then
    (if $b == "git" and (.[0] | IN("-C", "-c")) then .[2:] else .[1:] end) | first_positional($b)
  else .[0] end;

# 型のキーに使うコマンド名。インタプリタにスクリプトを渡す形はファイル名まで付ける
# （repo の移動でパスが変わっても同じスクリプトを 1 つの型にまとめる）。
# `bash -c <文字列>` / `node -e <文字列>` は文字列が毎回違うので、インタプリタ名＋フラグを型にする
# 最初の位置引数より前にあるインラインコードのフラグ（`-lc` のような束ねた形を含む）。
# 文字はインタプリタごとに違う: shell の -e は errexit、node -c / perl -c は構文チェックで、
# どちらもスクリプトファイルを取るのでインラインとみなさない
def eval_letter($b):
  if $b | IN("bash", "sh", "zsh", "fish", "python", "python3") then "c"
  elif $b | IN("node", "bun", "tsx", "perl", "ruby") then "e"
  else null end;
def eval_flag($b):
  eval_letter($b) as $l
  | if $l == null or length == 0 or (.[0] | startswith("-") | not) then null
    elif (.[0] | test("\\A-[A-Za-z]*" + $l + "\\z")) then .[0]
    else .[1:] | eval_flag($b) end;
def interpreters: ["bash", "sh", "zsh", "fish", "node", "deno", "bun", "tsx", "python", "python3", "ruby", "perl"];
def host_exec_head:
  ((.[0] // "") | sub("\\A.*/"; "")) as $b
  | (.[1:] | first_positional($b)) as $p
  | (.[1:] | eval_flag($b)) as $eval
  | if $b == "" then ""
    elif $eval != null and ($b | IN(interpreters[])) then (.[0] | home_rel) + " " + $eval
    elif ($p // "" | test("\\A[a-z][a-z0-9:_-]*\\z")) then (.[0] | home_rel) + " " + $p
    elif $p != null and ($b | IN(interpreters[]))
      and ($p | test("[/.]")) then (.[0] | home_rel) + " " + ($p | sub("\\A.*/"; ""))
    else .[0] | home_rel end;

# host-exec の tool_result の文面（register.ts の deny / result）から結末を決める
def host_exec_outcome:
  if test("\\A(?:<tool_use_error>)?host-exec: (?:the user declined|nobody approved)") then "declined"
  elif test("\\A\\$ |\\Ahost-exec: the command (?:ran|could not start)") then "ran"
  else "refused" end;

# $blocked: 同じ transcript で直前の Bash が sandbox / permission に拒否されていたか。
# false なら Bash を試さずに host-exec へ行った（settings で通るものまで流れている兆候）
def host_exec_events($l; $r; $tu; $txt; $blocked):
  ($tu.argv // []) as $argv
  | ($argv | host_exec_head) as $head
  | select($head != "")
  | event($l; "host_exec"; ($txt | host_exec_outcome); $head; "host_exec:" + $r.tool_use_id;
          "理由: \($tu.reason // "(なし)") / $ \($argv | join(" "))")
  | .after_block = $blocked;

def tool_entry:
  {name, command: ((.input.command // null) | if type == "string" then .[0:2000] else null end),
   file_path: (.input.file_path // .input.notebook_path // null)}
  + (if .name == host_exec_tool then
       {argv: ((.input.argv // []) | if type == "array" then map(tostring) else [] end),
        reason: ((.input.reason // null) | if type == "string" then .[0:500] else null end)}
     else {} end);

def in_window($l): ($l.timestamp | epoch_of) as $e | $e != null and $e >= $since and $e <= $until;

foreach (inputs | fromjson? | select(type == "object")) as $l (
  {file: null, tools: {}, blocked: false, out: []};
  (if .file != input_filename then .file = input_filename | .tools = {} | .blocked = false else . end)
  | .out = []
  | if (input_filename | test("/subagents/")) or $l.isSidechain == true then .
    elif $l.type == "assistant" then
      .tools += ([ $l.message.content[]? | select(type == "object" and .type == "tool_use") | {key: .id, value: tool_entry} ] | from_entries)
      | if in_window($l) then .out = [ request_events($l) ] else . end
    elif $l.type == "user" and ($l.timestamp | epoch_of) != null then
      # 期間外の行も「直前の Bash が拒否されたか」の追跡には使うので、事象は作ってから期間で絞る
      .tools as $tools
      | .blocked as $blocked
      | [ $l.message.content[]? | select(type == "object" and .type == "tool_result") as $r
          | ($tools[$r.tool_use_id] // {}) as $tu
          | ($r.content | text_of) as $txt
          | {bash: ($tu.name == "Bash"),
             events: [
               # host-exec の拒否は permission-rule として記録されるが、permission の型にすると中身（argv）が落ちるので先に拾う
               if $tu.name == host_exec_tool then host_exec_events($l; $r; $tu; $txt; $blocked)
               elif ($l.toolDenialKind != null and $r.is_error == true)
                 or ($txt | test("\\A(?:Error: )?(?:Permission to use [\\s\\S]* has been denied|Permission for this action [\\s\\S]*denied|The user doesn't want to proceed with this tool use|PreToolUse:\\S+ hook error)"))
                 or ($txt | test(worktree_guard_re))
               then permission_events($l; $r; $tu; $txt)
               elif $tu.name == "Bash" and ($txt | test(denial_hint_re)) then sandbox_events($l; $r; $tu; $txt)
               else empty end ]} ] as $rs
      | .out = (if in_window($l) then [ $rs[].events[] ] else [] end)
      | .blocked = (if any($rs[]; .bash) then any($rs[] | select(.bash); .events | length > 0) else $blocked end)
    else . end;
  .out[]
)
