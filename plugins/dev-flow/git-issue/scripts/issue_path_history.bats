#!/usr/bin/env bats
# Tests for git-issue/scripts/issue_path_history.py
#
# gh stub を PATH の先頭に置き（create_issue.bats の use_gh_stub と同じ形）、パスごとの検索・直近 N 日の窓・
# 番号での重複除去・パスをシェルに評価させないこと・失敗を 0 件として返さないことを確かめる。

setup() {
    command -v python3 >/dev/null || skip "python3 not available"
    command -v jq >/dev/null || skip "jq not available"

    SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)/issue_path_history.py"
    PATH_FILE="$BATS_TEST_TMPDIR/paths.txt"
}

# ---- gh stub ----
# 呼び出しを $GH_LOG に 1 行ずつ記録し、最後に受け取った --search の値を $GH_LAST_SEARCH に書く。
# 応答は $GH_STUB_FIXTURE の `<path>\t<number>\t<何日前に close したか>` 行のうち、--search の
# `"<path>" in:body` の path に一致する行から作る（closedAt は実行時刻から作る）。
# GH_STUB_EXIT を設定すると stderr にエラーを出してその値で終わる。
use_gh_stub() {
    local bin="$BATS_TEST_TMPDIR/bin"
    mkdir -p "$bin"
    cat >"$bin/gh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$GH_LOG"
if [[ -n "${GH_STUB_EXIT:-}" ]]; then
    echo "HTTP 502: Bad Gateway" >&2
    exit "$GH_STUB_EXIT"
fi
search=""
prev=""
for a in "$@"; do
    [[ "$prev" == "--search" ]] && search="$a"
    prev="$a"
done
printf '%s' "$search" >"$GH_LAST_SEARCH"
path="${search#\"}"
path="${path%\" in:body}"
closed_at() {
    date -u -d "$1 days ago" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-"$1"d +%Y-%m-%dT%H:%M:%SZ
}
sep=""
printf '['
while IFS=$'\t' read -r p number days; do
    [[ "$p" == "$path" ]] || continue
    printf '%s{"number":%d,"title":"issue %d","closedAt":"%s","body":"body %d"}' \
        "$sep" "$number" "$number" "$(closed_at "$days")" "$number"
    sep=","
done <"$GH_STUB_FIXTURE"
printf ']\n'
STUB
    chmod +x "$bin/gh"
    export PATH="$bin:$PATH"
    export GH_LOG="$BATS_TEST_TMPDIR/gh.log"
    export GH_LAST_SEARCH="$BATS_TEST_TMPDIR/last-search.txt"
    export GH_STUB_FIXTURE="$BATS_TEST_TMPDIR/fixture.tsv"
    : >"$GH_LOG"
    : >"$GH_STUB_FIXTURE"
}

fixture() {
    printf '%s\t%s\t%s\n' "$1" "$2" "$3" >>"$GH_STUB_FIXTURE"
}

@test "(1) 2 つのパスに当たった同じ issue は 1 件にまとまり、両方のパスを持つ" {
    use_gh_stub
    printf '%s\n' "src/a.py" "" "src/b.py" >"$PATH_FILE"
    fixture "src/a.py" 10 5
    fixture "src/b.py" 10 5
    fixture "src/b.py" 11 3

    run python3 "$SCRIPT" --path-file "$PATH_FILE" --repo acme/app

    [ "$status" -eq 0 ]
    jq -e '.ok == true and .window_days == 30' <<<"$output"
    [ "$(jq '.issues | length' <<<"$output")" -eq 2 ]
    [ "$(jq -c '.issues[] | select(.number == 10) | .matched_paths' <<<"$output")" = '["src/a.py","src/b.py"]' ]
    [ "$(jq -c '.issues[] | select(.number == 11) | .matched_paths' <<<"$output")" = '["src/b.py"]' ]
    # 空行は無視し、パスごとに 1 回ずつ argv で検索する
    [ "$(wc -l <"$GH_LOG" | tr -d ' ')" -eq 2 ]
    grep -qF -- 'issue list --state closed --search "src/a.py" in:body --json number,title,closedAt,body' "$GH_LOG"
    grep -qF -- '--repo acme/app' "$GH_LOG"
}

@test "(2) closedAt が 29 日前の issue は含まれ、31 日前の issue は含まれない（既定 30 日）" {
    use_gh_stub
    printf '%s\n' "src/a.py" >"$PATH_FILE"
    fixture "src/a.py" 20 29
    fixture "src/a.py" 21 31

    run python3 "$SCRIPT" --path-file "$PATH_FILE"

    [ "$status" -eq 0 ]
    [ "$(jq -c '[.issues[].number]' <<<"$output")" = '[20]' ]
}

@test "(3) --days で窓を変えられる" {
    use_gh_stub
    printf '%s\n' "src/a.py" >"$PATH_FILE"
    fixture "src/a.py" 20 29
    fixture "src/a.py" 21 31

    run python3 "$SCRIPT" --path-file "$PATH_FILE" --days 60

    [ "$status" -eq 0 ]
    jq -e '.window_days == 60' <<<"$output"
    [ "$(jq -c '[.issues[].number] | sort' <<<"$output")" = '[20,21]' ]
}

@test "(4) \$(…)・二重引用符・バッククォートを含むパスはシェルに評価されず、1 引数の --search で渡る" {
    use_gh_stub
    MARKER="$BATS_TEST_TMPDIR/marker"
    P='src/$(touch '"$MARKER"')/a"b`touch '"$MARKER"'2`.ts'
    printf '%s\n' "$P" >"$PATH_FILE"

    run python3 "$SCRIPT" --path-file "$PATH_FILE"

    [ "$status" -eq 0 ]
    jq -e '.ok == true and .issues == []' <<<"$output"
    [ ! -e "$MARKER" ]
    [ ! -e "${MARKER}2" ]
    [ "$(cat "$GH_LAST_SEARCH")" = "\"$P\" in:body" ]
}

@test "(5) gh が非 0 で終わると ok:false を出して非 0 で終わる" {
    use_gh_stub
    export GH_STUB_EXIT=1
    printf '%s\n' "src/a.py" >"$PATH_FILE"

    run python3 "$SCRIPT" --path-file "$PATH_FILE"

    [ "$status" -ne 0 ]
    jq -e '.ok == false and (.error | contains("HTTP 502"))' <<<"$output"
    jq -e 'has("issues") | not' <<<"$output"
}

@test "(6) --path-file が無いと ok:false を出して非 0 で終わる" {
    use_gh_stub

    run python3 "$SCRIPT"

    [ "$status" -ne 0 ]
    jq -e '.ok == false and (.error | contains("--path-file"))' <<<"$output"
    [ ! -s "$GH_LOG" ]
}

@test "(7) --path-file が読めない（存在しない・ディレクトリ）と ok:false を出して非 0 で終わる" {
    use_gh_stub

    for f in "$BATS_TEST_TMPDIR/missing.txt" "$BATS_TEST_TMPDIR"; do
        run python3 "$SCRIPT" --path-file "$f"

        [ "$status" -ne 0 ]
        jq -e '.ok == false and (.error | contains("cannot read --path-file"))' <<<"$output"
    done
    [ ! -s "$GH_LOG" ]
}
