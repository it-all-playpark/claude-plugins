#!/usr/bin/env bash
# mem-triage: macOS のメモリを「アプリ・端末で起動したもの・launchd の常駐」の塊ごとに合算し、
# 何を閉じれば空くか・聞かずに消してよいかを JSON で出す。プロセスは止めない。
#
# Usage:
#   mem-triage.sh [--top N]            # 実機の ps / top / sysctl / memory_pressure / lsof を読む
#   mem-triage.sh [--top N] --from DIR [--self PID]
#                                      # DIR の ps.txt args.txt top.txt swap.txt pressure.txt [lsof.txt] を読む（テスト用）。
#                                      # --self は実機での自分の pid の代わり（その祖先を含む塊に current_session が付く）
#
# 実機ではプロセス一覧が要るので sandbox の外で動かす必要がある。ファイルには何も書かない（外で動くので、書き込みを持たない）。
#
# Exit: 0 成功 / 2 引数の誤り・macOS 以外 / 3 プロセス一覧を読めない（sandbox 内で起動された等）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOP=15
FROM=""
SELF=null

die() {
  local code="$1"
  shift
  printf 'mem-triage: %s\n' "$*" >&2
  exit "$code"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --top)
      [[ "${2:-}" =~ ^[1-9][0-9]*$ ]] || die 2 "--top には 1 以上の整数を渡してください"
      TOP="$2"
      shift 2
      ;;
    --from)
      [[ -d "${2:-}" ]] || die 2 "--from にはディレクトリを渡してください: ${2:-}"
      FROM="$2"
      shift 2
      ;;
    --self)
      [[ "${2:-}" =~ ^[1-9][0-9]*$ ]] || die 2 "--self には pid を渡してください"
      SELF="$2"
      shift 2
      ;;
    *) die 2 "未知の引数: $1" ;;
  esac
done

section() {
  printf '@@%s\n' "$1"
}

from_dir() {
  local name
  for name in ps args top swap pressure lsof; do
    [[ -f "$FROM/$name.txt" ]] || continue
    section "$name"
    cat "$FROM/$name.txt"
  done
}

collect() {
  section ps
  /bin/ps -axo pid=,ppid=,etime=,tty=,comm=
  section args
  /bin/ps -axo pid=,args=
  section top
  /usr/bin/top -l 1 -stats pid,mem
  section swap
  /usr/sbin/sysctl -n vm.swapusage
  section pressure
  /usr/bin/memory_pressure -Q
}

analyze() {
  jq -Rrsc --argjson top "$TOP" --argjson self "$SELF" --arg mode "$1" -f "$SCRIPT_DIR/triage.jq"
}

if [[ -n "$FROM" ]]; then
  from_dir | analyze report
  exit 0
fi

[[ "$SELF" == null ]] || die 2 "--self は --from と一緒にだけ使えます"
[[ "$(uname -s)" == "Darwin" ]] || die 2 "macOS 専用です"
SELF="$$"
/bin/ps -p 1 -o pid= >/dev/null 2>&1 \
  || die 3 "プロセス一覧を読めません。sandbox 内で起動されています。plugin cache 配下の絶対パスで、パイプやリダイレクトを付けずに単独で起動してください"

raw="$(collect)"
# 作業ディレクトリは上位の塊の根だけ引く（全プロセスに lsof を掛けると遅い）
pids="$(printf '%s\n' "$raw" | analyze pids)"
cwd=""
[[ -n "$pids" ]] && cwd="$(/usr/sbin/lsof -a -d cwd -Fpn -p "$pids" 2>/dev/null || true)"
{
  printf '%s\n' "$raw"
  section lsof
  printf '%s\n' "$cwd"
} | analyze report
