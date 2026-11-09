#!/usr/bin/env bats
# Tests for git-issue/scripts/dep_graph.py
#
# 起票した issue の JSON から組む Mermaid の graph LR を、出力行そのもので確かめる。

setup() {
    command -v python3 >/dev/null || skip "python3 not available"

    SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)/dep_graph.py"
    INPUT="$BATS_TEST_TMPDIR/issues.json"
}

@test "(1) 依存 2 段の入力は全ノードと blocker から後続への矢印を出す" {
    cat >"$INPUT" <<'JSON'
[
  {"number": 10, "title": "set up schema", "blocked_by": []},
  {"number": 11, "title": "add API", "blocked_by": [10]},
  {"number": 12, "title": "add UI", "blocked_by": [11, 10]}
]
JSON

    run python3 "$SCRIPT" --input "$INPUT"

    [ "$status" -eq 0 ]
    expected='graph LR
  n10["#10 set up schema"]
  n11["#11 add API"]
  n12["#12 add UI"]
  n10 --> n11
  n11 --> n12
  n10 --> n12'
    [ "$output" = "$expected" ]
}

@test "(2) 依存の無い issue も単独のノードとして出る（dry-run の仮番号を含む）" {
    cat >"$INPUT" <<'JSON'
[
  {"number": "H1", "title": "create token", "blocked_by": []},
  {"number": "A1", "title": "use token", "blocked_by": ["H1"]},
  {"number": "A2", "title": "unrelated fix", "blocked_by": []}
]
JSON

    run python3 "$SCRIPT" --input "$INPUT"

    [ "$status" -eq 0 ]
    expected='graph LR
  nH1["#H1 create token"]
  nA1["#A1 use token"]
  nA2["#A2 unrelated fix"]
  nH1 --> nA1'
    [ "$output" = "$expected" ]
    # 単独ノードは矢印の行に現れない
    ! grep -E -- '-->.*nA2|nA2 -->' <<<"$output"
}

@test "(3) タイトル中の \" [ ] ( ) | は entity code に置き換わり、ラベルの囲みを崩さない" {
    cat >"$INPUT" <<'JSON'
[
  {"number": 7, "title": "fix \"quoted\" [a] (b) x|y $(rm -rf /)", "blocked_by": []}
]
JSON

    run python3 "$SCRIPT" --input "$INPUT"

    [ "$status" -eq 0 ]
    expected='graph LR
  n7["#7 fix #quot;quoted#quot; #91;a#93; #40;b#41; x#124;y $#40;rm -rf /#41;"]'
    [ "$output" = "$expected" ]
    # ラベルの中身（囲みの ["…"] の内側）に構文文字が残らない
    label="${lines[1]#  n7[\"}"
    label="${label%\"]}"
    [[ "$label" != *[\"\[\]\(\)\|]* ]]
}

@test "(4) 不正な入力（JSON でない・配列でない・blocked_by が入力に無い番号・番号の重複）は図を出さずに非 0 で終わる" {
    bad=(
        'not json'
        '{"number": 1, "title": "t", "blocked_by": []}'
        '[]'
        '[{"number": 1, "title": "t", "blocked_by": [2]}]'
        '[{"number": 1, "title": "t", "blocked_by": []}, {"number": 1, "title": "u", "blocked_by": []}]'
        '[{"number": 1, "title": "", "blocked_by": []}]'
        '[{"number": 1, "title": "t"}]'
        '[{"number": "a b", "title": "t", "blocked_by": []}]'
    )
    for body in "${bad[@]}"; do
        printf '%s\n' "$body" >"$INPUT"

        run python3 "$SCRIPT" --input "$INPUT"

        [ "$status" -ne 0 ]
        [[ "$output" != *"graph LR"* ]]
    done

    run python3 "$SCRIPT" --input "$BATS_TEST_TMPDIR/missing.json"
    [ "$status" -ne 0 ]
}
