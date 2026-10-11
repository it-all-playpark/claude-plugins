#!/usr/bin/env bats
bats_require_minimum_version 1.5.0

# Tests for dev-flow/scripts/prerun.sh (issue #641)
#
# prerun.sh は dev-flow Setup phase の決定論処理 (base 解決 / worktree 作成・再利用+起点検証+
# 書き込み probe / .devflow-tmp の git clean / analyze / detect-stack) を 1 コマンドに
# 集約する。deps install は持たない (issue #868。ensure-worktree-deps --setup の bats 参照)。
# fixture は bare origin + clone した ROOT リポジトリ (main/dev の2ブランチ)。

SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)/prerun.sh"

setup() {
    ORIGIN="$BATS_TEST_TMPDIR/origin.git"
    git init --bare -q "$ORIGIN"

    SEED="$BATS_TEST_TMPDIR/seed"
    git init -q -b main "$SEED"
    git -C "$SEED" config user.name "Test"
    git -C "$SEED" config user.email "test@example.com"
    echo "# seed" > "$SEED/README.md"
    git -C "$SEED" add README.md
    git -C "$SEED" commit -q -m "init"
    git -C "$SEED" checkout -q -b dev
    echo "dev" >> "$SEED/README.md"
    git -C "$SEED" add README.md
    git -C "$SEED" commit -q -m "dev commit"
    git -C "$SEED" remote add origin "$ORIGIN"
    git -C "$SEED" push -q origin main dev
    git -C "$ORIGIN" symbolic-ref HEAD refs/heads/main

    ROOT="$BATS_TEST_TMPDIR/root"
    git clone -q "$ORIGIN" "$ROOT"
    git -C "$ROOT" config user.name "Test"
    git -C "$ROOT" config user.email "test@example.com"

    WT="$BATS_TEST_TMPDIR/wt/df-1"

    # analyze 段（Segment 6）が内蔵する gh を stub する。GH_STUB_FIXTURE 未設定なら失敗
    # （analyze.ok:false 経路）。dependencies API（blocked_by）は依存なし（[]）を返す。
    # Jev は呼ばれない（マシンに入っている jev-classify を拾わないよう、存在しないコマンド名を指す）。
    STUB_DIR="$BATS_TEST_TMPDIR/stub-bin"
    mkdir -p "$STUB_DIR"
    cat >"$STUB_DIR/gh" <<'STUB'
#!/usr/bin/env bash
if [[ -z "${GH_STUB_FIXTURE:-}" ]]; then
    echo "gh stub: no fixture (GH_STUB_FIXTURE unset)" >&2
    exit 1
fi
if [[ "$1" == "api" && "$2" == */dependencies/blocked_by* ]]; then
    echo '[]'
    exit 0
fi
cat "$GH_STUB_FIXTURE"
STUB
    chmod +x "$STUB_DIR/gh"
    export PATH="$STUB_DIR:$PATH"
    export DEVFLOW_JEV_CLASSIFY=jev-classify-not-installed
    unset GH_STUB_FIXTURE
}

# issue fixture（AC あり・comment 無し・breaking 無し → Jev 不要の contract 経路）
make_issue_fixture() {
    jq -n '{title: "feat: add thing", state: "open", body: "## 受け入れ基準\n\n- [ ] AC one\n- [ ] AC two", labels: [], assignees: [], milestone: null, comments: [], author: {login: "reporter"}}' \
        >"$BATS_TEST_TMPDIR/issue.json"
    export GH_STUB_FIXTURE="$BATS_TEST_TMPDIR/issue.json"
}

# ---- (1) base 未指定 + origin/dev あり ----

@test "(1) base 未指定 + origin/dev あり -> dev を起点に新規作成" {
    cd "$ROOT"
    run --separate-stderr "$SCRIPT" --issue 1 --worktree "$WT"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true'
    echo "$output" | jq -e '.base == "dev"'
    echo "$output" | jq -e '.base_source == "origin/dev"'
    echo "$output" | jq -e '.worktree_status == "created"'
    echo "$output" | jq -e '.branch == "feature/issue-1"'
    expected_head="$(git -C "$ROOT" rev-parse origin/dev)"
    echo "$output" | jq -e --arg h "$expected_head" '.head == $h'
    echo "$output" | jq -e '(.epoch | type) == "number" and (.epoch == (.epoch | floor))'
    echo "$output" | jq -e '.clean.ok == true'
    echo "$output" | jq -e '.stack.frameworks == []'
    # 書けないパスが無ければ full checkout で、skip-worktree を付けない
    echo "$output" | jq -e '.skip_worktree == []'
    [ -z "$(git -C "$WT" ls-files -v | grep '^S' || true)" ]
}

# ---- (1c) 起動元 repo の .git/config に書かない ----
# sandbox 内からは起動元 repo の .git/config を書けない。config.lock を置いて config の書き込みを全て失敗させ、
# それでも worktree を作れること（upstream を書かない）と、再利用時の起点判定が通ることを確かめる。

@test "(1c) .git/config に書けなくても新規作成・再利用とも ok:true で、upstream を書かない" {
    : >"$ROOT/.git/config.lock"
    cd "$ROOT"
    run --separate-stderr "$SCRIPT" --issue 1 --worktree "$WT"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true and .worktree_status == "created"'
    run git -C "$ROOT" config --get "branch.feature/issue-1.merge"
    [ "$status" -ne 0 ]

    run --separate-stderr "$SCRIPT" --issue 1 --worktree "$WT"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true and .worktree_status == "reused"'
}

# ---- (2) origin に dev 無し ----

@test "(2) origin に dev が無い -> origin/HEAD の default branch (main) を起点にする" {
    ORIGIN2="$BATS_TEST_TMPDIR/origin2.git"
    git init --bare -q "$ORIGIN2"
    SEED2="$BATS_TEST_TMPDIR/seed2"
    git init -q -b main "$SEED2"
    git -C "$SEED2" config user.name "Test"
    git -C "$SEED2" config user.email "test@example.com"
    echo "# seed2" > "$SEED2/README.md"
    git -C "$SEED2" add README.md
    git -C "$SEED2" commit -q -m "init"
    git -C "$SEED2" remote add origin2 "$ORIGIN2"
    git -C "$SEED2" push -q origin2 main
    git -C "$ORIGIN2" symbolic-ref HEAD refs/heads/main

    ROOT2="$BATS_TEST_TMPDIR/root2"
    git clone -q "$ORIGIN2" "$ROOT2"
    git -C "$ROOT2" config user.name "Test"
    git -C "$ROOT2" config user.email "test@example.com"

    cd "$ROOT2"
    run --separate-stderr "$SCRIPT" --issue 1 --worktree "$BATS_TEST_TMPDIR/wt2/df-1"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.base == "main"'
    echo "$output" | jq -e '.base_source == "origin/HEAD"'
}

# ---- (3) --base に origin に存在しない ref ----

@test "(3) --base release (origin に無い) -> ok:false, worktree skipped" {
    cd "$ROOT"
    run --separate-stderr "$SCRIPT" --issue 1 --worktree "$WT" --base release
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == false'
    echo "$output" | jq -e '.base_error | test("origin/release")'
    echo "$output" | jq -e '.worktree_status == "skipped"'
    echo "$output" | jq -e --arg wt "$WT" '.worktree == $wt'
    echo "$output" | jq -e '.stack.frameworks == []'
}

# ---- (4) --base main (存在する) ----

@test "(4) --base main -> explicit" {
    cd "$ROOT"
    run --separate-stderr "$SCRIPT" --issue 1 --worktree "$WT" --base main
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.base == "main"'
    echo "$output" | jq -e '.base_source == "explicit"'
}

# ---- (5) 同じ WT で 2 回目 -> reused + clean ----

@test "(5) 同じ WT で2回目実行 -> reused, head同一, .devflow-tmpがcleanされる" {
    cd "$ROOT"
    run --separate-stderr "$SCRIPT" --issue 1 --worktree "$WT"
    [ "$status" -eq 0 ]
    first_head="$(echo "$output" | jq -r '.head')"

    mkdir -p "$WT/.devflow-tmp"
    echo "stale" > "$WT/.devflow-tmp/stale.txt"

    run --separate-stderr "$SCRIPT" --issue 1 --worktree "$WT"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true'
    echo "$output" | jq -e '.worktree_status == "reused"'
    echo "$output" | jq -e --arg h "$first_head" '.head == $h'
    [ ! -f "$WT/.devflow-tmp/stale.txt" ]
}

# ---- (6) 既存 worktree の起点が origin/main（期待は origin/dev）-> 不一致 ----

@test "(6) 既存worktreeの起点が不一致 -> ok:false, reused, worktree_errorに詳細" {
    cd "$ROOT"
    git worktree add -q --no-track -b feature/issue-1 "$WT" origin/main

    run --separate-stderr "$SCRIPT" --issue 1 --worktree "$WT"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == false'
    echo "$output" | jq -e '.worktree_status == "reused"'
    echo "$output" | jq -e '.worktree_error | test("origin/main")'
    echo "$output" | jq -e '.worktree_error | test("origin/dev")'
    echo "$output" | jq -e '.worktree_error | test("git worktree remove")'
}

# ---- (6b) 既存 worktree が別 branch を checkout（起点は正しい）-> branch 不一致で fail-closed ----
# 出力の branch は feature/issue-<N> 固定で下流（pr-iterate head_ref / fetch）が信頼するため、
# 別 branch の worktree を ok:true で返してはならない

@test "(6b) 既存worktreeのcheckout branchがfeature/issue-Nでない -> ok:false, worktree_errorに実branch" {
    cd "$ROOT"
    git worktree add -q --no-track -b other-branch "$WT" origin/dev

    run --separate-stderr "$SCRIPT" --issue 1 --worktree "$WT"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == false'
    echo "$output" | jq -e '.worktree_status == "reused"'
    echo "$output" | jq -e '.worktree_error | test("feature/issue-1")'
    echo "$output" | jq -e '.worktree_error | test("other-branch")'
}

# ---- (6c) epoch は script 開始時点（fetch・worktree 作成より前）で採る ----

@test "(6c) epoch は script 開始時の時刻（出力直前ではない）" {
    cd "$ROOT"
    before="$(date +%s)"
    run --separate-stderr "$SCRIPT" --issue 1 --worktree "$WT"
    after="$(date +%s)"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e --argjson b "$before" --argjson a "$after" '.epoch >= $b and .epoch <= $a'
    # 静的 pin: epoch の採取行が git fetch より前にある
    epoch_line="$(grep -n '^epoch="\$(date +%s)"' "$SCRIPT" | head -1 | cut -d: -f1)"
    fetch_line="$(grep -n 'fetch origin --quiet' "$SCRIPT" | head -1 | cut -d: -f1)"
    [ -n "$epoch_line" ] && [ -n "$fetch_line" ] && [ "$epoch_line" -lt "$fetch_line" ]
}

# ---- (6d) deps install を呼ばない（issue #868）----
# prerun は repo の任意コードを実行しない。install（依存の postinstall = repo の任意コード）を
# その子として走らせないことを、lockfile のある repo で install コマンドが 1 度も起動されないことで pin する。
# install は wrapper が別の Bash 呼び出しで ensure-worktree-deps --setup を実行して行う（そちらの bats 参照）。

@test "(6d) lockfile があっても install を呼ばず、出力に deps / epoch_end を持たず、同じ JSON を .devflow-tmp/prerun-setup.json に書く" {
    git -C "$SEED" checkout -q dev
    echo '{"name":"t","version":"1.0.0"}' > "$SEED/package.json"
    echo '{"lockfileVersion":3}' > "$SEED/package-lock.json"
    git -C "$SEED" add package.json package-lock.json
    git -C "$SEED" commit -q -m "add npm lockfile"
    git -C "$SEED" push -q origin dev
    for pm in npm pnpm yarn bun; do
        printf '#!/usr/bin/env bash\necho "%s $*" >> "%s/install-calls.log"\n' "$pm" "$BATS_TEST_TMPDIR" >"$STUB_DIR/$pm"
        chmod +x "$STUB_DIR/$pm"
    done
    export DEVFLOW_DEPS_CACHE_DIR="$BATS_TEST_TMPDIR/deps-cache"

    cd "$ROOT"
    run --separate-stderr "$SCRIPT" --issue 1 --worktree "$WT"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true'
    echo "$output" | jq -e 'has("deps") | not'
    echo "$output" | jq -e 'has("epoch_end") | not'
    [ ! -f "$BATS_TEST_TMPDIR/install-calls.log" ]
    [ ! -d "$WT/node_modules" ]
    jq -e --argjson out "$output" '. == $out' "$WT/.devflow-tmp/prerun-setup.json"
}

@test "(6e) ok:false のときは .devflow-tmp/prerun-setup.json を書かない" {
    cd "$ROOT"
    run --separate-stderr "$SCRIPT" --issue 1 --worktree "$WT"
    [ "$status" -eq 0 ]
    [ -f "$WT/.devflow-tmp/prerun-setup.json" ]
    run --separate-stderr "$SCRIPT" --issue 1 --worktree "$WT" --base main
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == false'
    [ ! -f "$WT/.devflow-tmp/prerun-setup.json" ]
}

# ---- (7) pr-iterate-prerun が PR head（origin/feature/issue-N）から作った branch も一致扱い ----

@test "(7) origin/feature/issue-1 から作った branch の worktree は一致扱い" {
    git -C "$SEED" checkout -q -b feature/issue-1 dev
    git -C "$SEED" push -q origin feature/issue-1
    cd "$ROOT"
    git fetch -q origin
    git worktree add -q --no-track -b feature/issue-1 "$WT" origin/feature/issue-1

    run --separate-stderr "$SCRIPT" --issue 1 --worktree "$WT"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true and .worktree_status == "reused"'
}

# ---- (8) branch の reflog に作成記録が無い ----

@test "(8) 起点の記録（branch の reflog）が無い -> ok:false, worktree_errorに'reflog'を含む" {
    cd "$ROOT"
    git -c core.logAllRefUpdates=false branch --no-track feature/issue-1 origin/dev
    git worktree add -q "$WT" feature/issue-1

    run --separate-stderr "$SCRIPT" --issue 1 --worktree "$WT"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == false'
    echo "$output" | jq -e '.worktree_error | test("reflog")'
}

# ---- (9) prunable (実体削除) からの再作成 ----

@test "(9) 実体を rm -rf した stale worktree -> prune後に既存branchをcheckoutしてcreated" {
    cd "$ROOT"
    run --separate-stderr "$SCRIPT" --issue 1 --worktree "$WT"
    [ "$status" -eq 0 ]

    rm -rf "$WT"

    run --separate-stderr "$SCRIPT" --issue 1 --worktree "$WT"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true'
    echo "$output" | jq -e '.worktree_status == "created"'
}

# ---- (9b-d) 再利用 worktree が origin/<base> より遅れている（issue #776）----

# origin/dev に 1 コミット進める（prerun 冒頭の git fetch origin で ROOT の origin/dev に反映される）
advance_origin_dev() {
    echo "later" >> "$SEED/README.md"
    git -C "$SEED" add README.md
    git -C "$SEED" commit -q -m "later dev commit"
    git -C "$SEED" push -q origin dev
}

@test "(9b) 独自コミット0件・未コミット変更なしで遅れた再利用worktree -> origin/devへfast-forward、headも進めた後の値" {
    cd "$ROOT"
    run --separate-stderr "$SCRIPT" --issue 1 --worktree "$WT"
    [ "$status" -eq 0 ]
    old_head="$(echo "$output" | jq -r '.head')"

    advance_origin_dev
    # .devflow-tmp 配下の残骸は未コミット変更とみなさない
    mkdir -p "$WT/.devflow-tmp"
    echo "stale" > "$WT/.devflow-tmp/stale.txt"

    run --separate-stderr "$SCRIPT" --issue 1 --worktree "$WT"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true'
    echo "$output" | jq -e '.worktree_status == "reused"'
    new_base="$(git -C "$ROOT" rev-parse origin/dev)"
    [ "$new_base" != "$old_head" ]
    [ "$(git -C "$WT" rev-parse HEAD)" = "$new_base" ]
    echo "$output" | jq -e --arg h "$new_base" '.head == $h'
}

@test "(9c) 独自コミットがある再利用worktree -> origin/devが進んでもHEADは変わらない" {
    cd "$ROOT"
    run --separate-stderr "$SCRIPT" --issue 1 --worktree "$WT"
    [ "$status" -eq 0 ]

    git -C "$WT" config user.name "Test"
    git -C "$WT" config user.email "test@example.com"
    echo "work" > "$WT/work.txt"
    git -C "$WT" add work.txt
    git -C "$WT" commit -q -m "own commit"
    own_head="$(git -C "$WT" rev-parse HEAD)"

    advance_origin_dev

    run --separate-stderr "$SCRIPT" --issue 1 --worktree "$WT"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true'
    [ "$(git -C "$WT" rev-parse HEAD)" = "$own_head" ]
    echo "$output" | jq -e --arg h "$own_head" '.head == $h'
}

@test "(9d) 未コミット変更がある再利用worktree -> origin/devが進んでもHEADは変わらない" {
    cd "$ROOT"
    run --separate-stderr "$SCRIPT" --issue 1 --worktree "$WT"
    [ "$status" -eq 0 ]
    old_head="$(echo "$output" | jq -r '.head')"

    echo "uncommitted" > "$WT/wip.txt"

    advance_origin_dev

    run --separate-stderr "$SCRIPT" --issue 1 --worktree "$WT"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true'
    [ "$(git -C "$WT" rev-parse HEAD)" = "$old_head" ]
    echo "$output" | jq -e --arg h "$old_head" '.head == $h'
    [ -f "$WT/wip.txt" ]
}

# ---- (9e-f) 書けないパスを追跡する repo（issue #875）----
# sandbox は `.githooks` の作成を EPERM で拒み、git は full checkout を fatal で中断して作りかけの worktree を片付ける。
# テストでは同じ「git が .githooks 配下を取り出せない」状態を、失敗する required smudge filter で作る
# （attributes は .git/info に置くので全 worktree に効き、main checkout の main には .githooks が無い）。
track_unwritable_githooks() {
    git -C "$SEED" checkout -q dev
    mkdir -p "$SEED/.githooks"
    echo "#!/bin/sh" > "$SEED/.githooks/pre-commit"
    echo "#!/bin/sh" > "$SEED/.githooks/pre-push"
    git -C "$SEED" add .githooks
    git -C "$SEED" commit -q -m "track githooks"
    git -C "$SEED" push -q origin dev
    echo '.githooks/** filter=deny' >"$ROOT/.git/info/attributes"
    git -C "$ROOT" config filter.deny.smudge false
    git -C "$ROOT" config filter.deny.clean cat
    git -C "$ROOT" config filter.deny.required true
}

@test "(9e) .githooks を取り出せない repo -> ok:true で作成し、取り出せないパスに skip-worktree を付けて status が空" {
    track_unwritable_githooks
    cd "$ROOT"
    git fetch -q origin
    run git worktree add -q --detach "$BATS_TEST_TMPDIR/full" origin/dev
    [ "$status" -ne 0 ]

    run --separate-stderr "$SCRIPT" --issue 1 --worktree "$WT"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true and .worktree_status == "created"'
    echo "$output" | jq -e '.skip_worktree == [".githooks/pre-commit", ".githooks/pre-push"]'
    echo "$output" | jq -e --arg h "$(git -C "$ROOT" rev-parse origin/dev)" '.head == $h'
    [ "$(git -C "$WT" rev-parse --abbrev-ref HEAD)" = "feature/issue-1" ]
    [ -f "$WT/README.md" ]
    # .devflow-tmp（prerun-setup.json）は fixture では ignore されていないので除いて見る
    [ -z "$(git -C "$WT" status --porcelain -- . ':(exclude).devflow-tmp')" ]
    [ -z "$(git -C "$WT" add -A --dry-run -- . ':(exclude).devflow-tmp')" ]

    # 作り直した worktree の再利用は ok:true（skip-worktree のパスは未ステージの削除に数えない）
    run --separate-stderr "$SCRIPT" --issue 1 --worktree "$WT"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true and .worktree_status == "reused" and .skip_worktree == []'
}

@test "(9f) 部分 checkout の worktree を再利用 -> ok:false、worktree を書き換えない" {
    cd "$ROOT"
    git fetch -q origin
    git worktree add -q --no-checkout --no-track -b feature/issue-1 "$WT" origin/dev
    git -C "$WT" read-tree HEAD

    run --separate-stderr "$SCRIPT" --issue 1 --worktree "$WT"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == false and .worktree_status == "reused"'
    echo "$output" | jq -e '.worktree_error | test("未ステージの削除が 1 件") and test("README.md") and test("git worktree remove")'
    [ "$(git -C "$WT" status --porcelain --untracked-files=no)" = " D README.md" ]
    [ -z "$(git -C "$WT" ls-files -v | grep '^S' || true)" ]
}

# ---- (10) package.json (next, lockfile無し) -> stack検出 ----

@test "(10) next依存のpackage.json(lockfile無し) -> stack.frameworksにnext" {
    git -C "$SEED" checkout -q dev
    cat > "$SEED/package.json" <<'JSON'
{
  "dependencies": {
    "next": "14.0.0"
  }
}
JSON
    git -C "$SEED" add package.json
    git -C "$SEED" commit -q -m "add next"
    git -C "$SEED" push -q origin dev

    cd "$ROOT"
    run --separate-stderr "$SCRIPT" --issue 1 --worktree "$WT"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.stack.frameworks | index("next") != null'
}

# ---- (10b) テストランナー判定 -> stack.test_runners（evaluator prompt の受理パターンの元） ----

@test "(10b) vitest の package.json + pytest.ini -> stack.test_runners に detect-test-runner の判定が載る" {
    git -C "$SEED" checkout -q dev
    echo '{"devDependencies":{"vitest":"^3.0.0"}}' > "$SEED/package.json"
    printf '[pytest]\n' > "$SEED/pytest.ini"
    git -C "$SEED" add package.json pytest.ini
    git -C "$SEED" commit -q -m "add runners"
    git -C "$SEED" push -q origin dev

    cd "$ROOT"
    run --separate-stderr "$SCRIPT" --issue 1 --worktree "$WT"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '[.stack.test_runners[].runner] == ["vitest","pytest","bats"]'
    echo "$output" | jq -e '.stack.test_runners[1] == {runner: "pytest", accept: ["test_*.py","*_test.py"], exclude: [], command: "pytest <files>"}'
}

# ---- (10c) ci_verify / local_verify: worktree の skill-config の "dev-flow".<key> を verbatim で渡す (issue #861 / #863) ----

@test "(10c) .claude/skill-config.json の \"dev-flow\".ci_verify / local_verify -> 同名キーに verbatim、無ければ null" {
    cd "$ROOT"
    run --separate-stderr "$SCRIPT" --issue 1 --worktree "$WT"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e 'has("ci_verify") and .ci_verify == null'
    echo "$output" | jq -e 'has("local_verify") and .local_verify == null'

    git -C "$SEED" checkout -q dev
    mkdir -p "$SEED/.claude"
    echo '{"dev-flow":{"ci_verify":{"label":"full-ci","checks":["e2e"],"commands":["pnpm test:e2e:local"],"wait_ceiling_seconds":1500},"local_verify":{"command":"pnpm test:e2e:local","db":{"engine":"postgres","version":"17"},"env":"E2E_EXTERNAL_DATABASE_URL","timeout_seconds":1500}}}' > "$SEED/.claude/skill-config.json"
    git -C "$SEED" add .claude/skill-config.json
    git -C "$SEED" commit -q -m "add ci_verify"
    git -C "$SEED" push -q origin dev

    WT2="$BATS_TEST_TMPDIR/wt/df-2"
    run --separate-stderr "$SCRIPT" --issue 2 --worktree "$WT2"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ci_verify == {"label":"full-ci","checks":["e2e"],"commands":["pnpm test:e2e:local"],"wait_ceiling_seconds":1500}'
    echo "$output" | jq -e '.local_verify == {"command":"pnpm test:e2e:local","db":{"engine":"postgres","version":"17"},"env":"E2E_EXTERNAL_DATABASE_URL","timeout_seconds":1500}'
}

# ---- (11) 引数エラー ----

@test "(11a) --issue 欠落 -> exit 2, stdout空" {
    cd "$ROOT"
    run --separate-stderr "$SCRIPT" --worktree "$WT"
    [ "$status" -eq 2 ]
    [ -z "$output" ]
}

@test "(11b) --issue が数値でない -> exit 2, stdout空" {
    cd "$ROOT"
    run --separate-stderr "$SCRIPT" --issue abc --worktree "$WT"
    [ "$status" -eq 2 ]
    [ -z "$output" ]
}

@test "(11c) --worktree が相対パス -> exit 2, stdout空" {
    cd "$ROOT"
    run --separate-stderr "$SCRIPT" --issue 1 --worktree "relative/path"
    [ "$status" -eq 2 ]
    [ -z "$output" ]
}

@test "(11d) 未知オプション -> exit 2, stdout空" {
    cd "$ROOT"
    run --separate-stderr "$SCRIPT" --issue 1 --worktree "$WT" --bogus
    [ "$status" -eq 2 ]
    [ -z "$output" ]
}

# ---- (12) repo 解決 ----

@test "(12a) https origin -> repo キーが owner/name" {
    git -C "$ROOT" remote set-url origin https://github.com/acme/skills.git
    cd "$ROOT"
    run --separate-stderr "$SCRIPT" --issue 1 --worktree "$WT" --base main
    echo "$output" | jq -e '.repo == "acme/skills"'
    echo "$output" | jq -e '(.epoch | type) == "number"'
}

@test "(12b) file:// origin -> repo キーが無い" {
    cd "$ROOT"
    run --separate-stderr "$SCRIPT" --issue 1 --worktree "$WT" --base main
    echo "$output" | jq -e 'has("repo") == false'
    echo "$output" | jq -e '(.epoch | type) == "number"'
}

# ---- (13) 既存 worktree が unwritable ----

@test "(13) 既存worktreeがunwritable -> ok:false, worktree_status=unwritable, worktree_removed=false" {
    cd "$ROOT"
    run --separate-stderr "$SCRIPT" --issue 1 --worktree "$WT"
    [ "$status" -eq 0 ]

    # 1 回目の ok:true は .devflow-tmp/prerun-setup.json を残すので、.devflow-tmp ごと書けなくする
    chmod a-w "$WT" "$WT/.devflow-tmp"

    run --separate-stderr "$SCRIPT" --issue 1 --worktree "$WT"
    status_after_chmod="$status"
    output_after_chmod="$output"

    chmod u+w "$WT" "$WT/.devflow-tmp"

    [ "$status_after_chmod" -eq 0 ]
    echo "$output_after_chmod" | jq -e '.ok == false'
    echo "$output_after_chmod" | jq -e '.worktree_status == "unwritable"'
    echo "$output_after_chmod" | jq -e '.worktree_error | ascii_downcase | test("permission|not permitted")'
    echo "$output_after_chmod" | jq -e '.worktree_removed == false'
}

# ---- (14) 新規作成先の親ディレクトリが unwritable ----

@test "(14) 新規worktreeの親ディレクトリがunwritable -> git worktree add失敗でworktree_status=error" {
    cd "$ROOT"
    PARENT="$BATS_TEST_TMPDIR/roparent"
    mkdir -p "$PARENT"
    chmod a-w "$PARENT"

    run --separate-stderr "$SCRIPT" --issue 1 --worktree "$PARENT/df-1"
    chmod u+w "$PARENT"

    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == false'
    echo "$output" | jq -e '.worktree_status == "error"'
}

@test "(14b) 静的pin: worktree remove --force 呼び出しが存在する" {
    count="$(grep -c 'worktree remove --force' "$SCRIPT")"
    [ "$count" -ge 1 ]
}

# ---- (15) 静的 pin: gh / git push を呼ばない ----

@test "(15a) 静的pin: gh を呼ばない" {
    run grep -E '(^|[^A-Za-z0-9_-])gh ' "$SCRIPT"
    [ "$status" -ne 0 ]
}

@test "(15b) 静的pin: git push を呼ばない" {
    run grep -E 'git (-C [^ ]+ )?push' "$SCRIPT"
    [ "$status" -ne 0 ]
}

# ---- (16) Segment 6: analyze（issue #690）----

@test "(16a) analyze 段: issue 取得成功 -> analyze キーに contract 経路の結果が載る" {
    make_issue_fixture
    cd "$ROOT"
    run --separate-stderr "$SCRIPT" --issue 1 --worktree "$WT"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true'
    echo "$output" | jq -e '.analyze.ok == true and .analyze.analyze_path == "contract"'
    echo "$output" | jq -e '.analyze.acceptance_criteria == ["AC one", "AC two"] and .analyze.issue_type == "feat" and .analyze.issue_title == "feat: add thing"'
    echo "$output" | jq -e '(.analyze.issue_body | type) == "string" and .analyze.breaking_change == false and .analyze.comment_overrides == [] and .analyze.comment_conflicts == [] and .analyze.uncertain == []'
    echo "$output" | jq -e '.analyze.blockers == []'
    echo "$output" | jq -e '(.analyze.duration_seconds | type) == "number" and .analyze.duration_seconds >= 0'
}

@test "(16b) analyze 段: issue 取得失敗 -> analyze.ok:false + reason、他段は影響を受けない" {
    cd "$ROOT"
    run --separate-stderr "$SCRIPT" --issue 1 --worktree "$WT"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true and .worktree_status == "created" and .clean.ok == true'
    echo "$output" | jq -e '.analyze.ok == false and (.analyze.reason | test("gh stub: no fixture")) and .analyze.analyze_path == "contract"'
    echo "$output" | jq -e '(.analyze.duration_seconds | type) == "number"'
}

@test "(16c) analyze 段は base 未解決（ok:false）でも走る" {
    make_issue_fixture
    cd "$ROOT"
    run --separate-stderr "$SCRIPT" --issue 1 --worktree "$WT" --base release
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == false and .analyze.ok == true'
}

@test "(16d) analyze は detect-stack と並列に走り、出力前に join する（静的 pin: 起動 & → detect-stack → wait の順）" {
    analyze_launch_line="$(grep -n 'prerun-analyze.sh' "$SCRIPT" | head -1 | cut -d: -f1)"
    analyze_bg_line="$(grep -n '^) >"\$ANALYZE_OUT" 2>/dev/null &$' "$SCRIPT" | head -1 | cut -d: -f1)"
    stack_line="$(grep -n 'detect-stack.sh' "$SCRIPT" | head -1 | cut -d: -f1)"
    analyze_wait_line="$(grep -n '^wait "\$ANALYZE_PID"' "$SCRIPT" | head -1 | cut -d: -f1)"
    output_line="$(grep -n '^OUT_JSON="\$(jq -n' "$SCRIPT" | head -1 | cut -d: -f1)"
    [ -n "$analyze_launch_line" ] && [ -n "$analyze_bg_line" ] && [ -n "$stack_line" ] && [ -n "$analyze_wait_line" ] && [ -n "$output_line" ]
    [ "$analyze_launch_line" -lt "$analyze_bg_line" ]
    [ "$analyze_bg_line" -lt "$stack_line" ]
    [ "$stack_line" -lt "$analyze_wait_line" ]
    [ "$analyze_wait_line" -lt "$output_line" ]
}

# ---- (17) plugin_commit（issue #785）----

@test "(17a) link mode: plugin_commit は plugin root を含む checkout の HEAD 先頭 12 桁" {
    plugin_root="$(cd "$(dirname "$SCRIPT")/../.." && pwd)"
    expected="$(git -C "$plugin_root" rev-parse HEAD)"
    cd "$ROOT"
    run --separate-stderr "$SCRIPT" --issue 1 --worktree "$WT"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e --arg c "${expected:0:12}" '.plugin_commit == $c'
}

@test "(17b) cache mode: plugin_commit は plugin root のディレクトリ名（commit SHA 先頭 12 桁）" {
    plugin_root="$(cd "$(dirname "$SCRIPT")/../.." && pwd)"
    cache_root="$BATS_TEST_TMPDIR/cache/playpark/dev-flow/1ef2e0ab6254"
    mkdir -p "$cache_root"
    for d in dev-flow _lib _shared bin; do
        ln -s "$plugin_root/$d" "$cache_root/$d"
    done
    cd "$ROOT"
    run --separate-stderr "$cache_root/dev-flow/scripts/prerun.sh" --issue 1 --worktree "$WT"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true'
    echo "$output" | jq -e '.plugin_commit == "1ef2e0ab6254"'
}

@test "(17c) plugin_commit を決められなくても prerun は止まらず plugin_commit:null を返す" {
    plugin_root="$(cd "$(dirname "$SCRIPT")/../.." && pwd)"
    cache_root="$BATS_TEST_TMPDIR/nogit/dev-flow/unknown"
    mkdir -p "$cache_root"
    for d in dev-flow _lib _shared bin; do
        ln -s "$plugin_root/$d" "$cache_root/$d"
    done
    cd "$ROOT"
    GIT_CEILING_DIRECTORIES="$BATS_TEST_TMPDIR" run --separate-stderr "$cache_root/dev-flow/scripts/prerun.sh" --issue 1 --worktree "$WT"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true and .worktree_status == "created"'
    echo "$output" | jq -e 'has("plugin_commit") and .plugin_commit == null'
}
