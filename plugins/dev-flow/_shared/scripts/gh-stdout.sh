# gh-stdout.sh - gh の応答を stdout だけから受け取る（source 専用。単体では実行しない）
# pr-iterate-prerun.sh・dev-flow/scripts/ready-set.sh・_lib/scripts/issue-blockers.sh が使う。
#
# gh_stdout <gh の引数...>
#   成功（gh が exit 0）: gh の stdout だけを出して 0 を返す。stderr は捨てる。
#   失敗（gh が exit 非 0）: gh の stderr と stdout をこの順に出し、gh の exit code を返す（呼び出し側のエラー文に載せる）。
#
# gh の stderr を stdout と合わせて JSON として読まない。gh 2.105.0 は環境に AI_AGENT か CLAUDECODE があると、open な PR の
# `gh pr view` のたびに `gh event listen` の案内（hint: ...）を stderr に出し、成功した応答でも JSON の検証で落ちる。
# 成否は gh の exit code で決める。stderr は一時ファイル（$TMPDIR の下、関数の中で消す）で受ける。

gh_stdout() {
    local err out rc=0
    err="$(mktemp "${TMPDIR:-/tmp}/gh-stderr.XXXXXX")" || return 1
    out="$(gh "$@" 2>"$err")" || rc=$?
    if [[ "$rc" -ne 0 ]]; then
        out="$(cat "$err")${out:+$'\n'$out}"
    fi
    rm -f "$err"
    printf '%s' "$out"
    return "$rc"
}
