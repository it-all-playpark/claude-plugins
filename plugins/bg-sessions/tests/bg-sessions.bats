#!/usr/bin/env bats
# bg-sessions.test.ts は claude plugin test でしか動かない（plugin の hooks module を engine に
# 読ませて回す）ので、run-all-bats.sh に載せるためにここから呼ぶ。

setup() {
    PLUGIN_DIR="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
}

@test "claude plugin test で bg-sessions.test.ts が全件 pass する" {
    command -v claude >/dev/null 2>&1 || skip "claude CLI not available"
    run claude plugin test "$PLUGIN_DIR"
    echo "$output"
    [ "$status" -eq 0 ]
    [[ "$output" == *"0 fail"* ]]
}
