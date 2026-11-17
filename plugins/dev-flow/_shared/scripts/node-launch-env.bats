#!/usr/bin/env bats
bats_require_minimum_version 1.5.0

# 中継が stdout の JSON をそのまま返す node 起動の script は、起動元が渡す NODE_USE_SYSTEM_CA を外して node を起動する。
# この変数が 1 だと sandbox の中の node が OS の trust settings を読めず stderr に ERROR 行を出し、中継の Bash の出力が
# stdout の JSON と一致しなくなる（security-codex-relay の返り値が hook に拒否され、security review が判定不能で止まる）。
# 本物の node の stderr は OS と sandbox しだいなので、PATH の先頭に置いた偽の node が受け取った環境を JSON で返す形で確かめる。

BIN_DIR="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)/bin"

setup() {
    FAKE="$BATS_TEST_TMPDIR/fake-bin"
    mkdir -p "$FAKE"
    cat >"$FAKE/node" <<'NODE'
#!/usr/bin/env bash
printf '{"node_use_system_ca":"%s"}\n' "${NODE_USE_SYSTEM_CA-unset}"
NODE
    chmod +x "$FAKE/node"
}

@test "NODE_USE_SYSTEM_CA=1 で起動しても、node には変数が渡らない" {
    for name in security-review-scope security-review-codex-prep security-review-codex-result porcelain-verdict; do
        run --separate-stderr env NODE_USE_SYSTEM_CA=1 PATH="$FAKE:$PATH" bash "$BIN_DIR/$name" x
        [ "$status" -eq 0 ] || { echo "$name: status=$status"; false; }
        [ "$output" = '{"node_use_system_ca":"unset"}' ] || { echo "$name: $output"; false; }
    done
}
