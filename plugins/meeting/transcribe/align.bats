#!/usr/bin/env bats
# align.py（Whisper の単語と話者分離の突き合わせ）の単体テスト test_align.py を CI から回す。
# 標準ライブラリだけで動くので ML 依存（mlx-whisper / pyannote）は不要。

@test "test_align.py が通る" {
    command -v python3 >/dev/null 2>&1 || skip "python3 not available"
    run python3 -B "$BATS_TEST_DIRNAME/test_align.py" -v
    echo "$output"
    [ "$status" -eq 0 ]
}

@test "test_transcribe.py (Groq 呼び出し) が通る" {
    command -v python3 >/dev/null 2>&1 || skip "python3 not available"
    run python3 -B "$BATS_TEST_DIRNAME/test_transcribe.py" -v
    echo "$output"
    [ "$status" -eq 0 ]
}

@test "transcribe.py は構文エラーなく compile できる（ML 依存は import しない）" {
    command -v python3 >/dev/null 2>&1 || skip "python3 not available"
    run python3 -B -c "import ast, sys; ast.parse(open(sys.argv[1]).read())" "$BATS_TEST_DIRNAME/transcribe.py"
    [ "$status" -eq 0 ]
}
