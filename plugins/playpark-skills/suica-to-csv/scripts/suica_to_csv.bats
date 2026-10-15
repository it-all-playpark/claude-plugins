#!/usr/bin/env bats
# Tests for suica-to-csv/scripts/suica_to_csv.py argument handling and payee classification.

setup() {
    SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)/suica_to_csv.py"
    INPUT="$BATS_TEST_TMPDIR/transactions.txt"
    printf '%s\n' '10 01 入 新橋 出 大崎 -200' '10 02 ﾊﾞｽ等 神奈中 -180' > "$INPUT"
    WORKDIR="$BATS_TEST_TMPDIR/work"
    mkdir -p "$WORKDIR"
    cd "$WORKDIR"
}

# Converts the given transaction lines (one per argument) for 2026 into $OUT.
convert_2026() {
    printf '%s\n' "$@" > "$BATS_TEST_TMPDIR/lines.txt"
    OUT="$BATS_TEST_TMPDIR/out.csv"
    run python3 "$SCRIPT" "$BATS_TEST_TMPDIR/lines.txt" --start-year 2026 --end-year 2026 -o "$OUT"
    [ "$status" -eq 0 ]
}

# Asserts $OUT has exactly this row: date, payee, category, amount, memo.
assert_row() {
    grep -qxF "$1,$2,$3,$4,,,,,$5,,,,,JPY,1,,," "$OUT"
}

@test "-o writes the CSV to the given path instead of CWD" {
    out="$BATS_TEST_TMPDIR/out/expenses.csv"
    mkdir -p "$(dirname "$out")"
    run python3 "$SCRIPT" "$INPUT" --start-year 2025 --end-year 2025 -o "$out"
    [ "$status" -eq 0 ]
    [ -f "$out" ]
    [ ! -e "$WORKDIR/suica_transactions.csv" ]
    grep -q '^2025/10/01,JR東日本,電車代,200,' "$out"
    grep -q '^2025/10/02,神奈中バス,バス代,180,' "$out"
}

@test "without -o the CSV goes to CWD/suica_transactions.csv" {
    run python3 "$SCRIPT" "$INPUT" --start-year 2025 --end-year 2025
    [ "$status" -eq 0 ]
    [ -f "$WORKDIR/suica_transactions.csv" ]
}

@test "unknown argument exits non-zero and writes nothing" {
    run python3 "$SCRIPT" "$INPUT" --start-year 2025 --end-year 2025 --output-file x.csv
    [ "$status" -ne 0 ]
    [[ "$output" == *"unrecognized arguments"* ]]
    [ ! -e "$WORKDIR/suica_transactions.csv" ]
    [ ! -e "$WORKDIR/x.csv" ]
}

@test "小　 prefix is 小田急電鉄 and the prefix is stripped from the memo" {
    convert_2026 '07 31 入 小　新宿 出 小　町田 -387'
    assert_row 2026/07/31 小田急電鉄 電車代 387 '新宿 → 町田'
}

@test "FC prefix is 福岡市地下鉄" {
    convert_2026 '08 07 入 FC福岡空 出 FC博多 -260'
    assert_row 2026/08/07 福岡市地下鉄 電車代 260 '福岡空 → 博多'
}

@test "JK prefix is JR九州" {
    convert_2026 '08 07 入 JK博多 出 JK鳥栖 -660'
    assert_row 2026/08/07 JR九州 電車代 660 '博多 → 鳥栖'
}

@test "KS prefix is 京成電鉄" {
    convert_2026 '08 09 入 KS空港２ 出 北総新鎌 -922'
    assert_row 2026/08/09 京成電鉄 電車代 922 '空港２ → 北総新鎌'
}

@test "東武 prefix is 東武鉄道 and no full-width space is left in the memo" {
    convert_2026 '08 09 入 東武新鎌 出 東武　柏 -261' '06 29 入 東武宇都 出 おもちゃ -261'
    assert_row 2026/08/09 東武鉄道 電車代 261 '新鎌 → 柏'
    assert_row 2026/06/29 東武鉄道 電車代 261 '宇都 → おもちゃ'
    run grep -q '　' "$OUT"
    [ "$status" -eq 1 ]
}

@test "八戸市交 / 岩手県北 buses are named in full" {
    convert_2026 '09 05 ﾊﾞｽ等 八戸市交 -200' '09 09 ﾊﾞｽ等 岩手県北 -370'
    assert_row 2026/09/05 八戸市交通部 バス代 200 八戸市交通部
    assert_row 2026/09/09 岩手県北バス バス代 370 岩手県北バス
}

# JR東日本 (no prefix) and 神奈中 are covered by the "-o writes the CSV" test above.
@test "京王 / 都 prefixes keep their payee" {
    convert_2026 '10 03 入 京王新宿 出 西調布 -220' '10 04 入 都　新宿 出 都麻布十 -220'
    assert_row 2026/10/03 京王電鉄 電車代 220 '新宿 → 西調布'
    assert_row 2026/10/04 都営地下鉄 電車代 220 '新宿 → 麻布十'
}
