#!/usr/bin/env bats
# Tests for dev-flow-health/scripts/record-classification.sh
#
# - 振り分け結果 {id, signature, classification, reason, issue} を、レポートと同じディレクトリの
#   classifications.jsonl に 1 signature 1 行（レポートのパス付き）で追記する
# - classification が dev_flow / target_repo / environment / transient 以外なら 1 行も書かずに非 0

bats_require_minimum_version 1.5.0

setup() {
    SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)/record-classification.sh"
    OUT="$BATS_TEST_TMPDIR/logs"
    mkdir -p "$OUT"
    REPORT="$OUT/2026-10-16T070000Z.json"
    jq -n '{generated_at: "2026-10-16T07:00:00Z", signatures: []}' > "$REPORT"
    JSONL="$OUT/classifications.jsonl"
    INPUT="$BATS_TEST_TMPDIR/input.json"
}

record() {
    bash "$SCRIPT" --report "$REPORT" --input "$INPUT"
}

@test "各 signature の振り分けを、レポートと同じディレクトリの JSONL にレポートのパス付きで 1 行ずつ追記する" {
    jq -n '[
      {id: "aaaaaaaaaaaa", signature: "dev-flow | abort | PR | x", classification: "dev_flow", reason: "pr-create の引数", issue: 1234},
      {id: "bbbbbbbbbbbb", signature: "dev-flow | test | Validate | y", classification: "target_repo", reason: "PR 先の vitest", issue: null},
      {id: "cccccccccccc", signature: "dev-flow | abort | PR | z", classification: "environment", reason: "Operation not permitted", issue: null}
    ]' > "$INPUT"
    run record
    [ "$status" -eq 0 ]
    [ "$(printf '%s' "$output" | jq -r '.jsonl')" = "$JSONL" ]
    [ "$(printf '%s' "$output" | jq '.appended')" = "3" ]

    [ "$(wc -l < "$JSONL" | tr -d ' ')" = "3" ]
    [ "$(jq -s -c '[.[] | [.id, .classification, .issue]]' "$JSONL")" = '[["aaaaaaaaaaaa","dev_flow",1234],["bbbbbbbbbbbb","target_repo",null],["cccccccccccc","environment",null]]' ]
    [ "$(jq -s -r '[.[].report] | unique | join(",")' "$JSONL")" = "$REPORT" ]
    [ "$(jq -s -r '[.[].generated_at] | unique | join(",")' "$JSONL")" = "2026-10-16T07:00:00Z" ]
    [ "$(jq -r 'select(.id == "bbbbbbbbbbbb") | "\(.signature)|\(.reason)"' "$JSONL")" = "dev-flow | test | Validate | y|PR 先の vitest" ]
}

@test "既存の JSONL には追記し、単一オブジェクトの入力も 1 行になる" {
    jq -n '{id: "dddddddddddd", signature: "pr-iterate | abort | Iterate | w", classification: "transient", reason: "再実行で消えた", issue: null}' > "$INPUT"
    run record
    [ "$status" -eq 0 ]
    run record
    [ "$status" -eq 0 ]
    [ "$(wc -l < "$JSONL" | tr -d ' ')" = "2" ]
    [ "$(jq -s -r '[.[].classification] | join(",")' "$JSONL")" = "transient,transient" ]
}

@test "classification が enum 外の項目が 1 件でもあれば何も追記せず非 0 で終える" {
    printf '%s\n' '{"existing":true}' > "$JSONL"
    for bad in '"other"' '"DEV_FLOW"' 'null' '["dev_flow"]'; do
        jq -n --argjson bad "$bad" '[
          {id: "aaaaaaaaaaaa", signature: "s1", classification: "dev_flow", reason: "r", issue: 1},
          {id: "bbbbbbbbbbbb", signature: "s2", classification: $bad, reason: "r", issue: null}
        ]' > "$INPUT"
        run --separate-stderr record
        [ "$status" -ne 0 ]
        printf '%s' "$stderr" | jq -e '.error | test("invalid classification")'
    done
    [ "$(cat "$JSONL")" = '{"existing":true}' ]
}

@test "classification の項目が無い入力・レポートが無いときも追記せず非 0" {
    jq -n '[{id: "aaaaaaaaaaaa", signature: "s1", reason: "r", issue: null}]' > "$INPUT"
    run --separate-stderr record
    [ "$status" -ne 0 ]
    [ ! -e "$JSONL" ]

    jq -n '[{id: "aaaaaaaaaaaa", signature: "s1", classification: "dev_flow", reason: "r", issue: 1}]' > "$INPUT"
    run --separate-stderr bash "$SCRIPT" --report "$OUT/missing.json" --input "$INPUT"
    [ "$status" -ne 0 ]
    [ ! -e "$JSONL" ]
}
