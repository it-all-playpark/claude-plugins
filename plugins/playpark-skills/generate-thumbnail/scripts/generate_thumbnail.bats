#!/usr/bin/env bats
# Tests for generate-thumbnail/scripts/generate_thumbnail.sh
#
# Strategy: stub `codex` via THUMBNAIL_CODEX_BIN. The stub logs the argv of
# `codex exec`, and its behaviour is switched by CODEX_STUB_MODE:
#   ok                 emit thread.started and write a valid PNG under
#                      $CODEX_HOME/generated_images/<thread_id>/ (as image_gen does), exit 0
#   no_image           emit thread.started but write no image, exit 0
#   model_unsupported  emit the real 400 invalid_request_error JSON, exit 1
#   fail               emit nothing useful, exit 3
# HOME is redirected so the global skill-config layer never leaks in; the
# project layer is a throwaway git repo under $BATS_TEST_TMPDIR.

setup() {
    SKILLS_REPO="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
    SCRIPT="$SKILLS_REPO/generate-thumbnail/scripts/generate_thumbnail.sh"

    export HOME="$BATS_TEST_TMPDIR/home"
    mkdir -p "$HOME"

    PROJECT="$BATS_TEST_TMPDIR/project"
    mkdir -p "$PROJECT/content/blog" "$PROJECT/.claude"
    git -C "$PROJECT" init -q
    MDX="content/blog/2026-09-15-example.mdx"
    cat > "$PROJECT/$MDX" << 'EOF'
---
title: "Example Title"
description: "Example description"
category: "ops"
tags: ["a", "b"]
---
body
EOF

    CALLS_LOG="$BATS_TEST_TMPDIR/codex_calls.log"
    rm -f "$CALLS_LOG"
    export CALLS_LOG
    export CODEX_STUB_MODE=ok
    export CODEX_HOME="$BATS_TEST_TMPDIR/codex-home"

    STUB="$BATS_TEST_TMPDIR/codex_stub.sh"
    cat > "$STUB" << 'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@" >> "$CALLS_LOG"
case "$CODEX_STUB_MODE" in
    ok)
        echo 'Reading additional input from stdin...'
        echo '{"type":"thread.started","thread_id":"t-1"}'
        mkdir -p "$CODEX_HOME/generated_images/t-1"
        printf 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==' | base64 -d > "$CODEX_HOME/generated_images/t-1/exec-1.png"
        echo '{"type":"turn.completed"}'
        exit 0
        ;;
    no_image)
        echo '{"type":"thread.started","thread_id":"t-2"}'
        echo '{"type":"turn.completed"}'
        exit 0
        ;;
    model_unsupported)
        echo '{"type":"thread.started","thread_id":"x"}'
        echo '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Model metadata for `gpt-5.4-mini` not found. Defaulting to fallback metadata; this can degrade performance and cause issues."}}'
        echo '{"type":"error","message":"{\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"The '"'"'gpt-5.4-mini'"'"' model is not supported when using Codex with a ChatGPT account.\"}}"}'
        echo '{"type":"turn.failed","error":{"message":"..."}}'
        exit 1
        ;;
    fail)
        echo '{"type":"error","message":"boom"}'
        exit 3
        ;;
esac
EOF
    chmod +x "$STUB"
    export THUMBNAIL_CODEX_BIN="$STUB"

    cd "$PROJECT"
}

model_arg() {
    # argv is logged one per line; the value after "-m"
    awk 'prev == "-m" { print; exit } { prev = $0 }' "$CALLS_LOG"
}

@test "default codex model is gpt-6-luna when codex_model is unset" {
    run bash "$SCRIPT" "$MDX"
    [ "$status" -eq 0 ]
    [ "$(model_arg)" = "gpt-6-luna" ]
    [ -f "$PROJECT/public/blog/2026-09-15-example.png" ]
}

@test "the image image_gen saved under CODEX_HOME is copied to output_dir" {
    run bash "$SCRIPT" "$MDX"
    [ "$status" -eq 0 ]
    cmp "$CODEX_HOME/generated_images/t-1/exec-1.png" "$PROJECT/public/blog/2026-09-15-example.png"
}

@test "codex runs read-only with the shell tools disabled" {
    run bash "$SCRIPT" "$MDX"
    [ "$status" -eq 0 ]
    grep -qx -- '-s' "$CALLS_LOG"
    grep -qx -- 'read-only' "$CALLS_LOG"
    grep -qx -- 'shell_tool' "$CALLS_LOG"
    grep -qx -- 'unified_exec' "$CALLS_LOG"
}

@test "codex success without a generated image fails with the searched directory" {
    export CODEX_STUB_MODE=no_image
    run bash "$SCRIPT" "$MDX"
    [ "$status" -eq 1 ]
    [[ "$output" == *"no generated image found: $CODEX_HOME/generated_images/t-2/"* ]]
    [ ! -e "$PROJECT/public/blog/2026-09-15-example.png" ]
}

@test "project skill-config codex_model overrides the default" {
    echo '{"generate-thumbnail":{"codex_model":"gpt-5.6-sol"}}' > "$PROJECT/.claude/skill-config.json"
    run bash "$SCRIPT" "$MDX"
    [ "$status" -eq 0 ]
    [ "$(model_arg)" = "gpt-5.6-sol" ]
}

@test "model-not-supported with unset codex_model blames the script default" {
    export CODEX_STUB_MODE=model_unsupported
    run bash "$SCRIPT" "$MDX"
    [ "$status" -eq 1 ]
    [[ "$output" == *"codex model 'gpt-6-luna' is not available for this account."* ]]
    [[ "$output" == *"script の既定モデル (gpt-6-luna) が提供終了している可能性"* ]]
    [[ "$output" == *"models_cache.json"* ]]
}

@test "model-not-supported with configured codex_model points at skill-config" {
    echo '{"generate-thumbnail":{"codex_model":"gpt-5.4-mini"}}' > "$PROJECT/.claude/skill-config.json"
    export CODEX_STUB_MODE=model_unsupported
    run bash "$SCRIPT" "$MDX"
    [ "$status" -eq 1 ]
    [[ "$output" == *"codex model 'gpt-5.4-mini' is not available for this account."* ]]
    [[ "$output" == *"skill-config.json の generate-thumbnail.codex_model を"* ]]
    [[ "$output" != *"script の既定モデル"* ]]
}

@test "generic codex failure reports the real exit code" {
    export CODEX_STUB_MODE=fail
    run bash "$SCRIPT" "$MDX"
    [ "$status" -eq 1 ]
    [[ "$output" == *"codex exec failed (exit=3)"* ]]
    [[ "$output" != *"is not available for this account"* ]]
}

@test "THUMBNAIL_CODEX_BIN satisfies the codex requirement without codex on PATH" {
    # CI runners have no codex; the requirement check must honor the override
    # (regression: require_cmds codex ran before THUMBNAIL_CODEX_BIN was read → exit 127).
    # Drop every PATH dir that holds codex (mise has both installs/ and shims/); jq/python3/git/file must remain reachable.
    local d newpath=""
    while IFS= read -r d; do
        [ -x "$d/codex" ] && continue
        newpath="${newpath:+$newpath:}$d"
    done <<< "$(printf '%s' "$PATH" | tr ':' '\n')"
    run env PATH="$newpath" bash -c 'command -v codex'
    [ "$status" -ne 0 ]
    run env PATH="$newpath" bash "$SCRIPT" "$MDX"
    [ "$status" -eq 0 ]
    [ "$(model_arg)" = "gpt-6-luna" ]
}
