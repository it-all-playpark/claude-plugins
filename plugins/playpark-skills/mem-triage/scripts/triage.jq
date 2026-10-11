# mem-triage の分析。mem-triage.sh が "@@<名前>" の行で区切って流す生の出力を受け取る（jq -Rs）。
#   @@ps       ps -axo pid=,ppid=,etime=,tty=,comm=
#   @@args     ps -axo pid=,args=
#   @@top      top -l 1 -stats pid,mem
#   @@swap     sysctl -n vm.swapusage
#   @@pressure memory_pressure -Q
#   @@lsof     lsof -a -d cwd -Fpn -p <pid,...>（任意）
# 引数: $top（出す塊の数）、$mode（"report" か、lsof に渡す pid 一覧を返す "pids"）、
#       $self（集計したプロセスの pid か null。その祖先を含む塊を閉じると、集計を頼んだ Claude Code のセッションも止まる）
#
# 塊の分け方:
#   - シェル・端末多重化・launchd・macOS 本体の直下で起動されたプロセスを根にして、子孫を全部足す
#     （nvim の下の language server、claude の下の MCP server やブラウザ、アプリの下のヘルパーや同梱の .app が親の塊に入る）
#   - 根が .app の中の実行ファイルならアプリの塊（名前は最も外側の .app）、それ以外は根の pid の塊
#   - macOS 本体（/System 等）は 1 つの塊、シェル・端末多重化そのものも 1 つの塊
# メモリは top の MEM（物理フットプリント、圧縮分を含む）。共有メモリの数え方が違うので合計は物理メモリと一致しない。

def sections:
  reduce (split("\n")[]) as $l ({cur: null, s: {}};
    if ($l | startswith("@@")) then .cur = $l[2:] | .s[.cur] = []
    elif .cur == null then .
    else .s[.cur] += [$l] end)
  | .s;

def bytes:
  capture("^(?<n>[0-9.]+)(?<u>[BKMGT]?)") as $m
  | ($m.n | tonumber) * ({"": 1, "B": 1, "K": 1024, "M": 1048576, "G": 1073741824, "T": 1099511627776}[$m.u])
  | floor;

def human:
  if . >= 1073741824 then "\((. / 1073741824 * 10 | round) / 10)G"
  elif . >= 1048576 then "\(. / 1048576 | round)M"
  elif . >= 1024 then "\(. / 1024 | round)K"
  else "\(.)B" end;

# ps の etime（[[dd-]hh:]mm:ss）を秒に
def etime_sec:
  (if test("-") then split("-") else ["0", .] end) as [$d, $rest]
  | ($rest | split(":") | map(tonumber)) as $p
  | ($d | tonumber) * 86400
    + (if ($p | length) == 3 then $p[0] * 3600 + $p[1] * 60 + $p[2] else $p[0] * 60 + $p[1] end);

def age:
  if . >= 86400 then "\(. / 86400 | floor)d\(. % 86400 / 3600 | floor)h"
  elif . >= 3600 then "\(. / 3600 | floor)h\(. % 3600 / 60 | floor)m"
  else "\(. / 60 | floor)m" end;

def basename: sub(".*/"; "");

# 実行ファイルのパスで最も外側の X.app の X
def appname: if startswith("/") then ((capture("^.*?/(?<a>[^/]+)\\.app/") | .a) // null) else null end;

def is_system: test("^/(System|usr/libexec|usr/sbin|sbin|Library/Apple)/");

# 子を別の塊として切り出す親（ここで起動されたものがユーザーの起動単位になる）
def is_container: .pid == 1 or (.name | IN("zsh", "bash", "fish", "sh", "dash", "ksh", "tcsh", "csh", "nu", "login", "tmux", "screen", "zellij"));

# 同じプログラムの別の版かを見るための鍵（nix store のハッシュと版番号を伏せる）
def version_key: sub("/nix/store/[a-z0-9]{32}-"; "/nix/store/*-") | gsub("[0-9]+(\\.[0-9]+)+"; "V");

def unit_of($by):
  if .kind == "system" then "system"
  elif .container then "shells"
  else
    ($by[.ppid | tostring]) as $parent
    | if $parent == null or $parent.container or $parent.kind == "system" or $parent.pid == .pid then
        (if .kind == "app" then "app:\(.app)" else "pid:\(.pid)" end)
      else $parent | unit_of($by) end
  end;

def claude_role:
  if .name != "claude" then null
  elif (.args | test("\\sdaemon\\s+run(\\s|$)")) then "claude-daemon"
  elif (.args | test("\\sagents(\\s|$)")) then "claude-agents"
  elif (.args | test("\\s(-p|--print)(\\s|$)")) then "claude-print"
  else "claude-cli" end;

def orphan_stdio:
  .ppid == 1 and .tty == "??" and (.args | test("(^|\\s)--stdio(\\s|$)|@modelcontextprotocol/server-"));

def short: if length > 120 then .[:117] + "..." else . end;

sections as $s
| (($s.top // []) | map(capture("^\\s*(?<pid>[0-9]+)\\s+(?<mem>[0-9.]+[BKMGT]?)[+-]?\\s*$") | {key: .pid, value: (.mem | bytes)}) | from_entries) as $mem
| (($s.args // []) | map(capture("^\\s*(?<pid>[0-9]+)\\s+(?<args>.*)$") | {key: .pid, value: .args}) | from_entries) as $args
| (($s.lsof // []) | reduce .[] as $l ({cur: null, cwd: {}};
    if ($l | startswith("p")) then .cur = $l[1:]
    elif ($l | startswith("n")) and .cur != null then .cwd[.cur] = $l[1:]
    else . end) | .cwd) as $cwd
| [($s.ps // [])[]
    | capture("^\\s*(?<pid>[0-9]+)\\s+(?<ppid>[0-9]+)\\s+(?<etime>\\S+)\\s+(?<tty>\\S+)\\s+(?<comm>.*)$")
    | .pid |= tonumber | .ppid |= tonumber
    | .name = (.comm | basename | ltrimstr("-"))
    | .mem = ($mem[.pid | tostring] // 0)
    | .args = ($args[.pid | tostring] // .comm)
    | .age_sec = (.etime | etime_sec)
    | .app = (.comm | appname)
    | .container = is_container
    | .kind = (if (.comm | is_system) or .pid == 1 then "system"
               elif .app != null then "app"
               elif .container then "shell"
               else "process" end)] as $procs
| ($procs | INDEX(.pid | tostring)) as $by
# 同じ版鍵で最も新しく起動したものと実行ファイルが違えば、更新前から動いている
| ([$procs[] | select(.comm | startswith("/"))]
   | group_by(.comm | version_key)
   | map((min_by(.age_sec) | .comm) as $newest | .[] | select(.comm != $newest) | .pid)) as $older
| (if $self == null then [] else [$self | recurse($by[tostring].ppid; . > 1)] end) as $ancestors
| [$procs[] | .unit = unit_of($by)]
| group_by(.unit)
| map(
    .[0].unit as $u
    | (map(.mem) | add) as $total
    | {
        id: $u,
        kind: (if ($u | startswith("pid:")) then "process" elif $u == "system" then "system" elif $u == "shells" then "shell" else "app" end),
        mem_bytes: $total,
        mem: ($total | human),
        procs: length,
        current_session: any(.[]; .pid as $p | any($ancestors[]; . == $p)),
        top: (sort_by(-.mem) | .[:3] | map({pid, name, mem: (.mem | human), args: (.args | short)}))
      }
    | if .kind == "process" then
        ($by[$u[4:]]) as $r
        | ($r | orphan_stdio) as $orphan
        | .name = $r.name
        | .role = ($r | claude_role)
        | .root = {pid: $r.pid, ppid: $r.ppid, tty: $r.tty, age: ($r.age_sec | age), age_sec: $r.age_sec, args: ($r.args | short), cwd: ($cwd[$r.pid | tostring] // null)}
        | .flags = ([if $orphan then "orphan_stdio" else empty end,
                     if ($r.ppid == 1 and $r.tty == "??" and ($orphan | not)) then "detached" else empty end,
                     if any($older[]; . == $r.pid) then "older_build" else empty end])
        | .safe_kill = $orphan
        | .kill = "kill \($r.pid)"
      elif .kind == "app" then .name = $u[4:]
      elif .kind == "system" then .name = "macOS"
      else .name = "シェル・端末" end)
| sort_by(-.mem_bytes) as $units
| if $mode == "pids" then
    [$units[:$top][] | select(.kind == "process") | .root.pid] | map(tostring) | join(",")
  else
    {
      summary: (
        (($s.top // []) | map(capture("^PhysMem: (?<used>\\S+) used \\((?<wired>\\S+) wired, (?<compressor>\\S+) compressor\\), (?<unused>\\S+) unused")) | first) as $pm
        | (($s.swap // []) | map(capture("total = (?<total>[0-9.]+[KMG])\\s+used = (?<used>[0-9.]+[KMG])")) | first) as $sw
        | (($s.pressure // []) | map(capture("free percentage: (?<p>[0-9]+)%") | .p | tonumber) | first) as $free
        | {
            used: ($pm.used // null), wired: ($pm.wired // null), compressor: ($pm.compressor // null), unused: ($pm.unused // null),
            swap_used: (if $sw then ($sw.used | bytes | human) else null end),
            swap_total: (if $sw then ($sw.total | bytes | human) else null end),
            free_percent: $free,
            processes: ($procs | length),
            units: ($units | length)
          }),
      units: $units[:$top],
      safe_kill: [$units[] | select(.safe_kill == true) | {pid: .root.pid, name, mem, args: .root.args, kill}]
    }
  end
