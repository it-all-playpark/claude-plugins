#!/usr/bin/env bats
# Invariant (#571): bin/ exec ラッパーは playpark-core (journal 1本) と
# dev-flow (28本) に分割される。plugin install 環境では skills が
# plugin root 配下に入るため、絶対パス runtime 依存を断つ。
#
# 分割後もラッパーは plugin 境界を跨がない: exec 行（dev-flow は 4 行目、他は 3 行目）の target は
# `$(dirname "$0")/../<target>` の 1 段の `../` のみで、target 文字列自体に
# `../` を含まない（含めば隣接 plugin へ越境することになる）。
#
# wrapper は working tree の実行ビットに依存させず `bash bin/<name>` で
# 起動する（実行ビットの pin は git index mode の直接検査で行う）。

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
    TEST_TMP_DIRS=()
}

teardown() {
    for d in "${TEST_TMP_DIRS[@]:-}"; do
        if [ -n "$d" ]; then
            rm -rf "$d"
        fi
    done
    return 0
}

core_expected_names() {
    cat <<'EOF'
journal
EOF
}

devflow_expected_names() {
    cat <<'EOF'
ac-lint
analyze-issue
check-ci
ci-wait
conflict-autoresolve
cross-repo-artifacts
detect-and-install
detect-stack
dev-flow-prerun
dev-flow-ready-set
diff-risk-classify
ensure-worktree-deps
local-verify
merge-tier-facts
pr-iterate-prerun
pr-push
redgreen-verify
run-tests
secfloor-classify
security-review-codex-prep
security-review-codex-result
security-review-diff-check
security-review-isolated
security-review-scope
structural-classify
workspace-prebuild
worktree-diff-hash
worktree-teardown
EOF
}

skills_expected_names() {
    cat <<'EOF'
ga-analyzer-fetch
generate-thumbnail
gmail-cleanup
gmail-receipts
mem-triage
skill-creator-init
sns-announce-check-length
sns-announce-extract-metadata
sns-announce-get-posting-time
sns-announce-load-config
EOF
}

target_for() {
    case "$1" in
        journal) echo "journal/scripts/journal.sh" ;;
        conflict-autoresolve) echo "_shared/scripts/conflict-autoresolve.sh" ;;
        cross-repo-artifacts) echo "_shared/scripts/cross-repo-artifacts.sh" ;;
        detect-and-install) echo "_shared/scripts/detect-and-install.sh" ;;
        diff-risk-classify) echo "_shared/scripts/diff-risk-classify.sh" ;;
        ensure-worktree-deps) echo "_shared/scripts/ensure-worktree-deps.sh" ;;
        local-verify) echo "_shared/scripts/local-verify.sh" ;;
        redgreen-verify) echo "_shared/scripts/redgreen-verify.sh" ;;
        merge-tier-facts) echo "_shared/scripts/merge-tier-facts.sh" ;;
        secfloor-classify) echo "_shared/scripts/secfloor-classify.sh" ;;
        security-review-codex-prep) echo "_shared/scripts/security-review-codex-prep.sh" ;;
        security-review-codex-result) echo "_shared/scripts/security-review-codex-result.sh" ;;
        security-review-diff-check) echo "_shared/scripts/security-review-diff-check.sh" ;;
        security-review-isolated) echo "_shared/scripts/security-review-isolated.sh" ;;
        security-review-scope) echo "_shared/scripts/security-review-scope.sh" ;;
        structural-classify) echo "_shared/scripts/structural-classify.sh" ;;
        worktree-diff-hash) echo "_shared/scripts/worktree-diff-hash.sh" ;;
        worktree-teardown) echo "_shared/scripts/worktree-teardown.sh" ;;
        workspace-prebuild) echo "_shared/scripts/workspace-prebuild.sh" ;;
        run-tests) echo "_shared/scripts/run-tests.sh" ;;
        pr-iterate-prerun) echo "_shared/scripts/pr-iterate-prerun.sh" ;;
        check-ci) echo "pr-iterate/scripts/check-ci.sh" ;;
        ci-wait) echo "pr-iterate/scripts/ci-wait.sh" ;;
        analyze-issue) echo "dev-flow/scripts/analyze-issue.sh" ;;
        detect-stack) echo "_lib/scripts/detect-stack.sh" ;;
        dev-flow-prerun) echo "dev-flow/scripts/prerun.sh" ;;
        dev-flow-ready-set) echo "dev-flow/scripts/ready-set.sh" ;;
        pr-push) echo "dev-flow/scripts/pr-push.sh" ;;
        ac-lint) echo "_lib/scripts/ac-lint.sh" ;;
        *) echo "" ;;
    esac
}


skills_target_for() {
    case "$1" in
        ga-analyzer-fetch) echo "python3 ga-analyzer/scripts/ga_fetch.py" ;;
        generate-thumbnail) echo "bash generate-thumbnail/scripts/generate_thumbnail.sh" ;;
        gmail-cleanup) echo "bash gmail-cleanup/scripts/gmail-cleanup.sh" ;;
        gmail-receipts) echo "bash gmail-receipts/scripts/gmail-receipts.sh" ;;
        mem-triage) echo "bash mem-triage/scripts/mem-triage.sh" ;;
        skill-creator-init) echo "python3 skill-creator/scripts/init_skill.py" ;;
        sns-announce-check-length) echo "bash sns-announce/scripts/check-length.sh" ;;
        sns-announce-load-config) echo "bash sns-announce/scripts/load-config.sh" ;;
        sns-announce-extract-metadata) echo "bash sns-announce/scripts/extract-metadata.sh" ;;
        sns-announce-get-posting-time) echo "bash sns-announce/scripts/get-posting-time.sh" ;;
        *) echo "" ;;
    esac
}

@test "plugins/playpark-core/bin の entry は journal 1本と完全一致する" {
    expected="$(core_expected_names)"
    actual="$(/bin/ls -1 "$REPO_ROOT/plugins/playpark-core/bin" | sort)"
    [ "$actual" = "$expected" ]
}

@test "plugins/dev-flow/bin の entry は対象28本と完全一致する" {
    expected="$(devflow_expected_names)"
    actual="$(/bin/ls -1 "$REPO_ROOT/plugins/dev-flow/bin" | sort)"
    [ "$actual" = "$expected" ]
}

@test "core: 全wrapperがgit index上でexecutable(100755)である" {
    while IFS= read -r name; do
        run git -C "$REPO_ROOT" ls-files -s "plugins/playpark-core/bin/$name"
        [ "$status" -eq 0 ]
        case "$output" in
            100755\ *) : ;;
            *)
                echo "not executable in index: plugins/playpark-core/bin/$name -> $output"
                return 1
                ;;
        esac
    done <<< "$(core_expected_names)"
}

@test "dev-flow: 全wrapperがgit index上でexecutable(100755)である" {
    while IFS= read -r name; do
        run git -C "$REPO_ROOT" ls-files -s "plugins/dev-flow/bin/$name"
        [ "$status" -eq 0 ]
        case "$output" in
            100755\ *) : ;;
            *)
                echo "not executable in index: plugins/dev-flow/bin/$name -> $output"
                return 1
                ;;
        esac
    done <<< "$(devflow_expected_names)"
}

@test "core: 全wrapperの本文が3行exec形式に一致し対象ファイルが存在する" {
    plugin_root="$REPO_ROOT/plugins/playpark-core"
    while IFS= read -r name; do
        target="$(target_for "$name")"
        [ -n "$target" ]
        file="$plugin_root/bin/$name"
        [ -f "$file" ]

        line1=$(sed -n '1p' "$file")
        [ "$line1" = "#!/usr/bin/env bash" ]

        line3=$(sed -n '3p' "$file")
        expected_line3="exec bash \"\$(dirname \"\$0\")/../$target\" \"\$@\""
        [ "$line3" = "$expected_line3" ]

        [ -f "$plugin_root/$target" ]
    done <<< "$(core_expected_names)"
}

# dev-flow の wrapper は exec の前に GIT_OPTIONAL_LOCKS=0 を export する（issue #868）。dev-flow の読み取り系 git
# （status / diff 等）が index の opportunistic な書き戻しで index.lock を取りに行かないようにする — sandbox 内では
# repo によって .git/worktrees/*/index.lock が書けない。必須ロック（commit / worktree add 等）には効かない。
@test "dev-flow: 全wrapperの本文が4行exec形式（GIT_OPTIONAL_LOCKS=0 を export）に一致し対象ファイルが存在する" {
    plugin_root="$REPO_ROOT/plugins/dev-flow"
    while IFS= read -r name; do
        target="$(target_for "$name")"
        [ -n "$target" ]
        file="$plugin_root/bin/$name"
        [ -f "$file" ]

        line1=$(sed -n '1p' "$file")
        [ "$line1" = "#!/usr/bin/env bash" ]

        line3=$(sed -n '3p' "$file")
        [ "$line3" = "export GIT_OPTIONAL_LOCKS=0" ]

        line4=$(sed -n '4p' "$file")
        expected_line4="exec bash \"\$(dirname \"\$0\")/../$target\" \"\$@\""
        [ "$line4" = "$expected_line4" ]
        [ "$(wc -l < "$file" | tr -d ' ')" = "4" ]

        [ -f "$plugin_root/$target" ]
    done <<< "$(devflow_expected_names)"
}

@test "dev-flow: wrapper 経由で起動したスクリプトに GIT_OPTIONAL_LOCKS=0 が渡る" {
    d="$(mktemp -d)"
    TEST_TMP_DIRS+=("$d")
    mkdir -p "$d/bin" "$d/_shared/scripts"
    cp "$REPO_ROOT/plugins/dev-flow/bin/run-tests" "$d/bin/run-tests"
    printf '%s\n' 'printf "%s" "${GIT_OPTIONAL_LOCKS:-unset}"' > "$d/_shared/scripts/run-tests.sh"
    run env -u GIT_OPTIONAL_LOCKS bash "$d/bin/run-tests"
    [ "$status" -eq 0 ]
    [ "$output" = "0" ]
}

@test "全wrapperが plugin 境界を跨がない（target 文字列自体に ../ を含まない）" {
    for plugin in playpark-core dev-flow; do
        names="$([ "$plugin" = playpark-core ] && core_expected_names || devflow_expected_names)"
        while IFS= read -r name; do
            target="$(target_for "$name")"
            [ -n "$target" ]
            case "$target" in
                *../*)
                    echo "plugin boundary crossed: plugins/$plugin/bin/$name -> $target"
                    return 1
                    ;;
            esac
        done <<< "$names"
    done

    while IFS= read -r name; do
        target_pair="$(skills_target_for "$name")"
        [ -n "$target_pair" ]
        target="${target_pair#* }"
        case "$target" in
            *../*)
                echo "plugin boundary crossed: plugins/playpark-skills/bin/$name -> $target"
                return 1
                ;;
        esac
    done <<< "$(skills_expected_names)"
}

@test "plugins/playpark-skills/bin の entry は対象10本と完全一致する" {
    expected="$(skills_expected_names)"
    actual="$(/bin/ls -1 "$REPO_ROOT/plugins/playpark-skills/bin" | sort)"
    [ "$actual" = "$expected" ]
}

@test "skills: 全wrapperがgit index上でexecutable(100755)である" {
    while IFS= read -r name; do
        run git -C "$REPO_ROOT" ls-files -s "plugins/playpark-skills/bin/$name"
        [ "$status" -eq 0 ]
        case "$output" in
            100755\ *) : ;;
            *)
                echo "not executable in index: plugins/playpark-skills/bin/$name -> $output"
                return 1
                ;;
        esac
    done <<< "$(skills_expected_names)"
}

@test "skills: 全wrapperの本文が3行exec形式(interp対応)に一致し対象ファイルが存在しbash -nが通る" {
    plugin_root="$REPO_ROOT/plugins/playpark-skills"
    while IFS= read -r name; do
        target_pair="$(skills_target_for "$name")"
        [ -n "$target_pair" ]
        interp="${target_pair%% *}"
        target="${target_pair#* }"
        file="$plugin_root/bin/$name"
        [ -f "$file" ]

        line1=$(sed -n '1p' "$file")
        [ "$line1" = "#!/usr/bin/env bash" ]

        line3=$(sed -n '3p' "$file")
        expected_line3="exec $interp \"\$(dirname \"\$0\")/../$target\" \"\$@\""
        [ "$line3" = "$expected_line3" ]

        [ -f "$plugin_root/$target" ]

        run bash -n "$file"
        [ "$status" -eq 0 ]
    done <<< "$(skills_expected_names)"
}

@test "detect-stackがbin経由bare名で機能透過する" {
    export PATH="$REPO_ROOT/plugins/playpark-core/bin:$REPO_ROOT/plugins/dev-flow/bin:$PATH"
    d="$(mktemp -d "${TMPDIR:-/tmp}/binwrap-XXXXXX")"
    TEST_TMP_DIRS+=("$d")
    run bash "$REPO_ROOT/plugins/dev-flow/bin/detect-stack" "$d"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.frameworks | type == "array"'
}

@test "ac-lintがbin経由bare名で引数とexit codeを透過する(成功系)" {
    export PATH="$REPO_ROOT/plugins/playpark-core/bin:$REPO_ROOT/plugins/dev-flow/bin:$PATH"
    f="$(mktemp "${TMPDIR:-/tmp}/binwrap-ac-XXXXXX")"
    TEST_TMP_DIRS+=("$f")
    printf '## 受け入れ基準\n- [ ] x\n' > "$f"
    run bash "$REPO_ROOT/plugins/dev-flow/bin/ac-lint" "$f"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.verdict == "t1"'
}

@test "ac-lintがbin経由bare名でエラー経路を透過する(引数なし)" {
    export PATH="$REPO_ROOT/plugins/playpark-core/bin:$REPO_ROOT/plugins/dev-flow/bin:$PATH"
    run bash "$REPO_ROOT/plugins/dev-flow/bin/ac-lint"
    [ "$status" -eq 1 ]
    echo "$output" | jq -e '.ok == false'
}

