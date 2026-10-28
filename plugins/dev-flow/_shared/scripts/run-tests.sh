#!/usr/bin/env bash
# run-tests.sh - Validate（test#i）・post-eval・test#final のテスト実行 exec-proxy（issue #821）。
# Usage: run-tests.sh <worktree> [--base <ref> | --files <test file>...]
#
# green 判定を LLM の解釈ではなく exit code から決める。呼び出し側 agent は stdout の JSON 1 行を
# verbatim で転写するだけで、スクリプトの選択・起動失敗の分類・failed_files の抽出はここで行う。
#
# 変更ファイルの受け渡し（issue #835）: --base があり `git merge-base <ref> HEAD` が解決できたときだけ、
# merge-base から working tree への差分（commit 済み・staged・未 stage）と untracked（--exclude-standard、
# .devflow-tmp/ を除く）の <WT> 相対パスを重複なく 1 行 1 件で $LOG_DIR/changed-files.txt に書き、
# tests/run-*.sh に DEVFLOW_CHANGED_FILES=<その絶対パス> と DEVFLOW_BASE=<merge-base の sha> を渡す。
# 何を回すかは repo 側のランナーが決める — run-tests はテストの選択・skip をしない（repo 固有の知識を持たない）。
# --base 無し・merge-base 解決失敗・git 失敗では両変数とも設定しない（未設定 = ランナーは全件実行）。
# 失敗は stderr に 1 行出すだけで status / green には影響させない。フォールバック経路には渡さない。
# 呼び出し元の環境に同名変数があっても継がない（入れ子の run-tests で外側の一覧を誤って使わない）。
#
# 落ちたファイルだけの再実行（issue #865。Final reconcile が test#final の red を flake と本物の red に分ける入口）:
# --files <WT 相対のテストファイル>... は、そのパスを 1 行 1 件で $LOG_DIR/test-files.txt に書き、
# tests/run-*.sh に DEVFLOW_TEST_FILES=<その絶対パス> を渡す（DEVFLOW_CHANGED_FILES / DEVFLOW_BASE は渡さない）。
# ランナーは一覧のうち自分が扱うファイルだけを実行し、扱うファイルが無ければ何も実行せず exit 0 する。
# 変数を読まないランナーは全件を実行する（遅くなるだけで green を緩めない）。どのファイルを誰が扱うかは repo 側が決める。
# 一覧のパスが WT 内の通常ファイルでなければ引数不正（exit 2）。tests/run-*.sh が無い repo はフォールバックの
# コマンドにファイルを渡す規約が無いため status "error" を返す（呼び出し側は flake と判定しない）。
#
# 手順:
#   0. <WT> の untracked で ignore 対象外のファイル（.devflow-tmp/ を除く）を git add --intent-to-add で index に
#      載せる（中身は stage しない）。git grep / git ls-files 系のテストから新規ファイルが見える状態で走らせる。
#   1. workspace-prebuild.sh <WT>（pnpm ワークスペースのビルド成果物をテストの直前に作り直す）。
#      status "failed" のときはテストを 1 本も実行せず status "failed"（reason を summary の先頭に置く）。
#      それ以外（built / skipped / JSON でない）はビルドを再試行せずテストへ進む。
#   2. <WT>/tests/run-*.sh のうち実行ビットを持つ通常ファイルを全本、名前順に絶対パスの bare 形で直列実行する
#      （1 本だけ選ぶと残りのランナーの回帰が CI まで検出されない。並列化しない — repo によっては共有資源を使う）。
#   3. tests/run-*.sh が 1 本も無いときだけ、検出したフォールバック（pnpm / yarn / npm test・cargo test・
#      go test・pytest・bundle exec rspec / bin/rails test・vendor/bin/pest / vendor/bin/phpunit）を <WT> で
#      全部実行する。何も無ければ tests "no_tests"。
#   リトライ・環境の自動修復はしない（起動失敗は環境要因で、同じ操作の繰り返しや store / ロックの操作では直らない）。
#
# status は全 script の exit code だけで決まる: 起動失敗（exit 126 / 127）が 1 本でもあれば "error"、
# それ以外で exit 非 0 が 1 本でもあれば "failed"、全本 0（0 本を含む）なら "passed"。
# 例外: フォールバックの `pnpm test` が、テストスクリプトを起動する前に pnpm 自身の失敗で非 0 になったときは
# 起動失敗とする — テストは 1 件も走っておらず、red と報告すると本物の失敗と区別できない。次のいずれか:
#   - テスト前の依存 install（pnpm の verifyDepsBeforeRun）の失敗（出力に `Command failed with exit code N: '<pnpm>' install`）
#   - pnpm のエラー見出し行（` ERROR  <msg>` / `ERR_PNPM_<CODE>`）があり、スクリプトを起動した痕跡
#     （`> <name>@<version> test` の見出し行・`ELIFECYCLE`・テストランナーの `FAIL` / `not ok` 行）が 1 つも無い
#   痕跡の有無だけでは判定しない — `--silent` 等で見出し行が出ない設定の本物の red を error に倒さないよう、
#   pnpm 自身のエラー見出し行があるときに限る。
#   - `scripts.test` の先頭のコマンドが、`pnpm test` の実行前に WT から `/` までの全祖先の `node_modules/.bin` を
#     先頭に足した PATH（cwd は WT）で解決できない（依存が入っていない。pnpm が足す workspace ルート等の
#     `node_modules/.bin` を含む上位集合にして、テストが走りうる環境を「無い」と判定しない。シェルの exit 127 は
#     pnpm が `ELIFECYCLE` 付きの exit 1 にくるむので exit code では拾えない）。ログの文字列（`command not found` 行・`FAIL` 行）では判定しない —
#     ログはテストファイル（PR が書ける）も出力できるので、本物の red を起動失敗に見せかけられる。ランナーが
#     解決できなければテストファイルは 1 本も動かない。実行前に解決するのは、実行中に PATH 上の実体を消して
#     判定を変えさせないため。先頭が代入（`NODE_ENV=test jest`）等で取り出せない形と、`scripts.test` 全体が
#     単一の単純コマンドでない形（`||` `;` `|` `&` 改行・クォート・展開などシェル構文を含む。`a || vitest run` は
#     a が無くても後続がテストを走らせる）は判定せず red のまま。
# tests / green は workflow の GREEN schema の必須キーで、status から機械的に写す（agent に組み立てさせない）:
#   passed → tests "passed" green true / failed → "failed" false / error → "error" false /
#   実行対象 0 本 → status "passed"・tests "no_tests"・green false（何も走っていないので green を主張しない）
#
# failed_files（status "failed" のときだけ非空になりうる）: exit 非 0 の script の出力から、bats の `not ok` 行
# （直後の診断行 `# (in test file <path>, line N)` のパス）と vitest / jest の `FAIL <path>` 行を抽出し、
# <WT> 相対にして重複なく並べる。exit 非 0 の script から 1 件も抽出できない・ファイルに結び付かない
# `not ok` がある・ビルド失敗のときは空配列にする — 一部だけ列挙すると、base でも落ちる既存の失敗の
# 切り分け（base-failure-triage）が結び付かない失敗を見落として green に倒しうるため。
#
# 出力（stdout, JSON 1 行。各 script の出力は $TMPDIR のログに残し stdout に混ぜない — Bash tool の出力上限で
# JSON 行が切れないように、stderr にも 1 script 1 行の要約だけを出す）:
#   {"status":"passed|failed|error","tests":"passed|failed|error|no_tests","green":bool,"summary":"...",
#    "scripts":[{"path":"...","exit":N,"launch_failed":bool,"log":"..."}],"failed_files":[...],"epoch":N}
#   scripts[].log はその script の stdout / stderr を書いたログの絶対パス（$TMPDIR 配下 = worktree の外。worktree 内に
#   置くと diff-hash が untracked を含むため merge tier を壊す）。evaluator が同じ tree で実行済みのテストを再実行せず
#   ログの行を根拠にするために渡す。どのテストファイルが走ったかはログの中身から読み手が判断する。
# exit: JSON を出力したら 0（判定は JSON の status）/ 引数不正は 2（status "error" の JSON を出す）。
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREBUILD="$SCRIPT_DIR/workspace-prebuild.sh"
SUMMARY_MAX=4000
LINES_MAX=30

emit() {
    # $1 status / $2 tests / $3 green / $4 summary / $5 scripts JSON / $6 failed_files JSON
    jq -nc --arg s "$1" --arg t "$2" --argjson g "$3" --arg m "${4:0:$SUMMARY_MAX}" \
        --argjson sc "$5" --argjson ff "$6" --argjson e "$(date +%s)" \
        '{status: $s, tests: $t, green: $g, summary: $m, scripts: $sc, failed_files: $ff, epoch: $e}'
}

unset DEVFLOW_CHANGED_FILES DEVFLOW_BASE DEVFLOW_TEST_FILES

BASE_REF=""
TEST_FILES=()
if [[ $# -eq 3 && "$2" == "--base" && -n "$3" ]]; then
    BASE_REF="$3"
elif [[ $# -ge 3 && "$2" == "--files" ]]; then
    TEST_FILES=("${@:3}")
elif [[ $# -ne 1 ]]; then
    emit error error false "usage: run-tests <worktree> [--base <ref> | --files <test file>...]" '[]' '[]'
    exit 2
fi
WT=$(cd "$1" 2>/dev/null && pwd) || { emit error error false "cd failed: $1" '[]' '[]'; exit 2; }
WT_PHYS=$(cd "$WT" && pwd -P)
# テスト script・フォールバックとも <WT> を cwd にして実行する
cd "$WT" || { emit error error false "cd failed: $WT" '[]' '[]'; exit 2; }

for p in "${TEST_FILES[@]+"${TEST_FILES[@]}"}"; do
    if [[ -z "$p" || "$p" == /* || "/$p/" == */../* || ! -f "$WT/$p" ]]; then
        emit error error false "--files: not a test file under the worktree: $p" '[]' '[]'
        exit 2
    fi
done

LOG_DIR=$(mktemp -d "${TMPDIR:-/tmp}/run-tests-XXXXXX") \
    || { emit error error false "cannot create log dir under ${TMPDIR:-/tmp}" '[]' '[]'; exit 0; }

TEST_FILES_LIST=""
if [[ ${#TEST_FILES[@]} -gt 0 ]]; then
    TEST_FILES_LIST="$LOG_DIR/test-files.txt"
    printf '%s\n' "${TEST_FILES[@]}" > "$TEST_FILES_LIST"
fi

# 変更ファイルの一覧（--base があるときだけ。intent-to-add の前に取る — 載せた後は untracked に出ないが、
# git diff <merge-base> には intent-to-add のファイルも出るので、再実行時も一覧は変わらない）。
# rename は旧パス・新パスの両方を載せる（--no-renames）。-z で取り、パスを quote させない
CHANGED_FILES=""
MERGE_BASE=""
if [[ -n "$BASE_REF" ]]; then
    changed="$LOG_DIR/changed-files.txt"
    if ! MERGE_BASE=$(git merge-base "$BASE_REF" HEAD 2>"$LOG_DIR/changed-files.log"); then
        echo "[run-tests] warning: merge-base of $BASE_REF and HEAD not resolved — DEVFLOW_CHANGED_FILES / DEVFLOW_BASE not set (log: $LOG_DIR/changed-files.log)" >&2
    elif ! { git diff -z --name-only --no-renames --relative "$MERGE_BASE" -- \
                && git ls-files -z --others --exclude-standard -- . ':(exclude).devflow-tmp'; } \
            > "$LOG_DIR/changed-files.raw" 2>>"$LOG_DIR/changed-files.log"; then
        echo "[run-tests] warning: git diff / ls-files failed — DEVFLOW_CHANGED_FILES / DEVFLOW_BASE not set (log: $LOG_DIR/changed-files.log)" >&2
    else
        tr '\0' '\n' < "$LOG_DIR/changed-files.raw" | LC_ALL=C awk 'length && !seen[$0]++' > "$changed"
        CHANGED_FILES="$changed"
    fi
fi

# 0. untracked の新規ファイルを intent-to-add で index に載せる
#    テストは commit 前の worktree で走るため、Implement / fix が作ったファイルは untracked のまま。
#    git grep / git ls-files で repo 全体を検査する invariant テストからは見えず、ローカル green・CI red になる
#    （個々のテストを --untracked に直すとテストを足すたびに同じ漏れが起きるので、runner で一度だけ載せる）。
#    intent-to-add は中身を stage しない — write-tree・commit される tree は変わらず、PR phase の
#    git add -A が従来どおり中身を載せる。.devflow-tmp/ は run の一時ファイル置き場なので載せない。
#    git の work tree でなければ何もしない。失敗してもテストは止めず stderr に警告を出す（従来の挙動に戻るだけ）。
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    if git ls-files -z --others --exclude-standard -- . ':(exclude).devflow-tmp' > "$LOG_DIR/untracked.list" \
        2>"$LOG_DIR/intent-to-add.log"; then
        if [[ -s "$LOG_DIR/untracked.list" ]] \
            && ! git --literal-pathspecs add --intent-to-add --pathspec-from-file="$LOG_DIR/untracked.list" \
                --pathspec-file-nul >>"$LOG_DIR/intent-to-add.log" 2>&1; then
            echo "[run-tests] warning: git add --intent-to-add failed — untracked files stay invisible to git grep (log: $LOG_DIR/intent-to-add.log)" >&2
        fi
    else
        echo "[run-tests] warning: git ls-files --others failed (log: $LOG_DIR/intent-to-add.log)" >&2
    fi
fi

# 1. workspace-prebuild
PREBUILD_OUT=$(bash "$PREBUILD" "$WT" 2>"$LOG_DIR/prebuild.log")
if [[ "$(jq -r '.status? // empty' <<< "$PREBUILD_OUT" 2>/dev/null)" == "failed" ]]; then
    reason=$(jq -r '.reason // "workspace build failed"' <<< "$PREBUILD_OUT")
    echo "[run-tests] workspace-prebuild failed — tests not run (log: $LOG_DIR/prebuild.log)" >&2
    emit failed failed false "$reason"$'\n'"$(tail -n "$LINES_MAX" "$LOG_DIR/prebuild.log")" '[]' '[]'
    exit 0
fi

# 2. 実行対象: tests/run-*.sh（実行ビットあり）、無ければフォールバック
TARGETS=()   # 表示・JSON 用の path
COMMANDS=()  # 実行内容（run-*.sh は空 = path を bare 実行、フォールバックはコマンド文字列）
shopt -s nullglob
CANDIDATES=("$WT"/tests/run-*.sh)
shopt -u nullglob
if [[ ${#CANDIDATES[@]} -gt 0 ]]; then
    while IFS= read -r f; do
        [[ -f "$f" && -x "$f" ]] || continue
        TARGETS+=("$f")
        COMMANDS+=("")
    done <<< "$(printf '%s\n' "${CANDIDATES[@]}" | LC_ALL=C sort)"
fi

if [[ ${#TARGETS[@]} -eq 0 && -n "$TEST_FILES_LIST" ]]; then
    emit error error false "--files needs tests/run-*.sh (fallback test runners have no file-list contract)" '[]' '[]'
    exit 0
fi

if [[ ${#TARGETS[@]} -eq 0 ]]; then
    if [[ -f "$WT/package.json" ]] && jq -e '.scripts.test | type == "string" and length > 0' "$WT/package.json" >/dev/null 2>&1; then
        if [[ -f "$WT/pnpm-lock.yaml" ]]; then pm=pnpm
        elif [[ -f "$WT/yarn.lock" ]]; then pm=yarn
        else pm=npm
        fi
        TARGETS+=("$pm test"); COMMANDS+=("$pm test")
    fi
    if [[ -f "$WT/Cargo.toml" ]]; then
        TARGETS+=("cargo test"); COMMANDS+=("cargo test")
    fi
    if [[ -f "$WT/go.mod" ]]; then
        TARGETS+=("go test ./..."); COMMANDS+=("go test ./...")
    fi
    if [[ -f "$WT/pytest.ini" || -f "$WT/conftest.py" ]] \
        || grep -qs '^\[tool\.pytest' "$WT/pyproject.toml" \
        || grep -qs '^\[tool:pytest\]' "$WT/setup.cfg" \
        || grep -qs '^\[pytest\]' "$WT/tox.ini"; then
        TARGETS+=("pytest"); COMMANDS+=("pytest")
    fi
    # Ruby / PHP は detect-test-runner.sh と同じ判定（rspec-core > bin/rails、pestphp/pest > phpunit/phpunit）
    if grep -qsE '^[[:space:]]+rspec-core([[:space:]]|$)' "$WT/Gemfile.lock"; then
        TARGETS+=("bundle exec rspec"); COMMANDS+=("bundle exec rspec")
    elif [[ -f "$WT/bin/rails" ]]; then
        TARGETS+=("bin/rails test"); COMMANDS+=("bin/rails test")
    fi
    if [[ -f "$WT/composer.json" ]]; then
        php_deps=$(jq -r '((.require // {}) + (."require-dev" // {})) | keys[]' "$WT/composer.json" 2>/dev/null)
        if grep -qx 'pestphp/pest' <<< "$php_deps"; then
            TARGETS+=("vendor/bin/pest"); COMMANDS+=("vendor/bin/pest")
        elif grep -qx 'phpunit/phpunit' <<< "$php_deps"; then
            TARGETS+=("vendor/bin/phpunit"); COMMANDS+=("vendor/bin/phpunit")
        fi
    fi
fi

if [[ ${#TARGETS[@]} -eq 0 ]]; then
    emit passed no_tests false "no tests/run-*.sh and no fallback test runner (package.json scripts.test / Cargo.toml / go.mod / pytest config / Gemfile.lock rspec-core / bin/rails / composer.json pest・phpunit)" '[]' '[]'
    exit 0
fi

# 出力から失敗したテストファイルを抽出する。1 行 1 パス。結び付かない `not ok` があれば "\t" 行を出す。
extract_failed_files() {
    LC_ALL=C sed $'s/\x1b\\[[0-9;]*[A-Za-z]//g' "$1" | LC_ALL=C awk '
        function flush() { if (pending) print "\t"; pending = 0 }
        /^not ok / { flush(); pending = 1; next }
        /^ok / { flush(); next }
        pending && match($0, /in test file .*, line [0-9]+\)/) {
            s = substr($0, RSTART + 13, RLENGTH - 13)
            sub(/, line [0-9]+\)$/, "", s)
            print s; pending = 0; next
        }
        /^[ \t]*FAIL[ \t]+/ {
            line = $0
            sub(/^[ \t]*FAIL[ \t]+/, "", line)
            n = split(line, tok, /[ \t]+/)
            i = 1
            if (tok[1] ~ /^\|.*\|$/) i = 2
            if (i <= n && tok[i] != "") print tok[i]
            next
        }
        END { flush() }
    '
}

# pnpm がテストスクリプトを起動する前に自身のエラーで終了したか（$1 = ログ）。判定規則は冒頭コメントの status 例外
pnpm_failed_before_script() {
    local plain
    plain=$(LC_ALL=C sed $'s/\x1b\\[[0-9;]*[A-Za-z]//g' "$1")
    LC_ALL=C grep -qE '^[[:space:]]*\[?(ERROR|ERR_PNPM_[A-Z0-9_]+)\]?[[:space:]]' <<< "$plain" \
        && ! LC_ALL=C grep -qE '^> |ELIFECYCLE|^(not ok |[[:space:]]*FAIL[[:space:]])' <<< "$plain"
}

# test スクリプトの先頭のコマンドが、全祖先の node_modules/.bin を先頭に足した PATH で解決できないか。
# 判定規則は冒頭コメントの status 例外。先頭のコマンドが取り出せない形は解決できる側（red）に倒す
pnpm_test_runner_missing() {
    local script runner root dir bins=""
    script=$(jq -r '.scripts.test' "$WT/package.json" 2>/dev/null) || return 1
    [[ "$script" =~ ^[A-Za-z0-9._@/+=:,%\ -]+$ ]] || return 1
    read -r runner _ <<< "$script"
    [[ "$runner" =~ ^[A-Za-z0-9._@/+-]+$ ]] || return 1
    for root in "$WT" "$WT_PHYS"; do
        dir="$root"
        while :; do
            bins="$bins${dir%/}/node_modules/.bin:"
            [[ "$dir" == / || "$dir" == . ]] && break
            dir=$(dirname "$dir")
        done
    done
    ! (cd "$WT" && PATH="$bins$PATH" command -v "$runner" >/dev/null 2>&1)
}

to_rel() {
    local p="$1"
    p="${p#"$WT"/}"
    p="${p#"$WT_PHYS"/}"
    printf '%s\n' "${p#./}"
}

# 3. 直列実行
SCRIPTS_JSON='[]'
FAILED_LIST=""
UNATTRIBUTED=false
LAUNCH_FAILED_ANY=false
NONZERO_ANY=false
SUMMARY_HEAD=""
SUMMARY_BODY=""
for i in "${!TARGETS[@]}"; do
    target="${TARGETS[$i]}"
    log="$LOG_DIR/$i.log"
    if [[ -z "${COMMANDS[$i]}" && -n "$TEST_FILES_LIST" ]]; then
        DEVFLOW_TEST_FILES="$TEST_FILES_LIST" "$target" > "$log" 2>&1 < /dev/null
        rc=$?
    elif [[ -z "${COMMANDS[$i]}" && -n "$CHANGED_FILES" ]]; then
        DEVFLOW_CHANGED_FILES="$CHANGED_FILES" DEVFLOW_BASE="$MERGE_BASE" "$target" > "$log" 2>&1 < /dev/null
        rc=$?
    elif [[ -z "${COMMANDS[$i]}" ]]; then
        "$target" > "$log" 2>&1 < /dev/null
        rc=$?
    else
        runner_missing=false
        [[ "${COMMANDS[$i]}" == "pnpm test" ]] && pnpm_test_runner_missing && runner_missing=true
        read -r -a cmd <<< "${COMMANDS[$i]}"
        "${cmd[@]}" > "$log" 2>&1 < /dev/null
        rc=$?
    fi
    launch=false
    if [[ $rc -eq 126 || $rc -eq 127 ]]; then
        launch=true
    elif [[ $rc -ne 0 && "${COMMANDS[$i]}" == "pnpm test" ]] \
        && LC_ALL=C sed $'s/\x1b\\[[0-9;]*[A-Za-z]//g' "$log" \
            | LC_ALL=C grep -qE "Command failed with exit code [0-9]+: '[^']*/pnpm[^'/]*' install[[:space:]]*$"; then
        launch=true
    elif [[ $rc -ne 0 && "${COMMANDS[$i]}" == "pnpm test" ]] && pnpm_failed_before_script "$log"; then
        launch=true
    elif [[ $rc -ne 0 && "${COMMANDS[$i]}" == "pnpm test" && "$runner_missing" == true ]]; then
        launch=true
    fi
    [[ "$launch" == true ]] && LAUNCH_FAILED_ANY=true
    echo "[run-tests] $target exit=$rc launch_failed=$launch (log: $log)" >&2
    SCRIPTS_JSON=$(jq -c --arg p "$target" --argjson e "$rc" --argjson l "$launch" --arg o "$log" \
        '. + [{path: $p, exit: $e, launch_failed: $l, log: $o}]' <<< "$SCRIPTS_JSON")
    [[ $rc -eq 0 ]] && continue
    NONZERO_ANY=true
    if [[ "$launch" == true ]]; then
        SUMMARY_HEAD+="launch failed: $target (exit $rc, log: $log)"$'\n'
        SUMMARY_BODY+="--- $target"$'\n'"$(tail -n 5 "$log")"$'\n'
        continue
    fi
    SUMMARY_HEAD+="failed: $target (exit $rc, log: $log)"$'\n'
    found=$(extract_failed_files "$log")
    if [[ -z "$found" ]] || grep -q $'^\t$' <<< "$found"; then
        UNATTRIBUTED=true
    fi
    while IFS= read -r p; do
        [[ -n "$p" && "$p" != $'\t' ]] || continue
        FAILED_LIST+="$(to_rel "$p")"$'\n'
    done <<< "$found"
    # 件数は最後まで読む awk で絞る（head へ pipe すると先に終わり、上流が SIGPIPE で pipefail が非 0 になる）
    fail_lines=$(LC_ALL=C sed $'s/\x1b\\[[0-9;]*[A-Za-z]//g' "$log" | LC_ALL=C grep -E '^(not ok |[[:space:]]*FAIL[[:space:]])' | awk -v max="$LINES_MAX" 'NR <= max')
    [[ -n "$fail_lines" ]] || fail_lines=$(tail -n "$LINES_MAX" "$log")
    SUMMARY_BODY+="--- $target"$'\n'"$fail_lines"$'\n'
done

FAILED_JSON='[]'
if [[ "$LAUNCH_FAILED_ANY" == false && "$NONZERO_ANY" == true && "$UNATTRIBUTED" == false && -n "$FAILED_LIST" ]]; then
    FAILED_JSON=$(printf '%s' "$FAILED_LIST" | awk 'NF && !seen[$0]++' | jq -R . | jq -sc .)
fi

if [[ "$LAUNCH_FAILED_ANY" == true ]]; then
    emit error error false "$SUMMARY_HEAD$SUMMARY_BODY" "$SCRIPTS_JSON" '[]'
elif [[ "$NONZERO_ANY" == true ]]; then
    emit failed failed false "$SUMMARY_HEAD$SUMMARY_BODY" "$SCRIPTS_JSON" "$FAILED_JSON"
else
    names=$(jq -r '[.[].path] | join(", ")' <<< "$SCRIPTS_JSON")
    emit passed passed true "passed: $names" "$SCRIPTS_JSON" '[]'
fi
exit 0
