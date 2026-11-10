#!/usr/bin/env bats
# redgreen-verify.sh: impl を退避して test が red→green に転じるか判定する。
# untracked 新規ファイル・tracked-modified ファイルの両シナリオをカバーする。
# 共有 stash スタックに触れない不変条件(G1/G2/G6)も pin する。
# 判定のテストは $RGV(start → 終わるまで wait。stdout と exit は結果を返した呼び出しのもの)で 1 ショットに回し、
# start / wait / stop そのものは N が見る。supervisor はバックグラウンドで残るので、start は fd 3 を閉じて呼ぶ
# (bats が子の終了を待って止まらないように)。
# テストの起動の形は Setup が解決したコマンドファイル(--commands)で渡す。$RGV は $COMMANDS_FILE が空でなければ
# --commands に付ける(既定は files_command が node --test {files}。use_commands / use_runners で差し替える)。

setup() {
  SCRIPT="$BATS_TEST_DIRNAME/redgreen-verify.sh"
  STATE_DIR="$BATS_TEST_TMPDIR/state"
  export REDGREEN_VERIFY_POLL_SEC=0.1
  export COMMANDS_FILE="$BATS_TEST_TMPDIR/commands.json"
  use_commands 'node --test {files}'
  RGV="$BATS_TEST_TMPDIR/rgv.sh"
  cat > "$RGV" <<EOF
#!/usr/bin/env bash
out="\$(bash '$SCRIPT' start --state-dir '$STATE_DIR' \${COMMANDS_FILE:+--commands "\$COMMANDS_FILE"} "\$@" 3>&-)"; rc=\$?
while [ "\$(jq -r '.status // empty' <<< "\$out" 2>/dev/null)" = running ]; do
  out="\$(bash '$SCRIPT' wait --state-dir '$STATE_DIR' --wait-sec 60)"; rc=\$?
done
printf '%s\n' "\$out"
exit "\$rc"
EOF
  REPO="$(mktemp -d)"
  cd "$REPO"
  git init -q && git config user.email t@t && git config user.name t
  # base commit(G1/G2 の事前 stash 素材にも使う .gitkeep を含める)
  echo "# placeholder" > .gitkeep
  echo '{"scripts":{"test":"node --test"}}' > package.json
  git add .gitkeep package.json && git commit -q -m base
}

# コマンドファイルを files_command <$1>(user 設定で解決した形)にする
use_commands() {
  jq -nc --arg f "$1" '{source: "user_config", status: "resolved", full_command: ($f | sub(" *\\{files\\}"; "")), files_command: $f, sources: []}' > "$COMMANDS_FILE"
}

# fixture の package.json を差し替えて commit する(vdelta で包むかの判定元は base の tree の package.json)
use_package_json() {
  echo "$1" > "$REPO/package.json"
  git -C "$REPO" add package.json && git -C "$REPO" commit -q -m "package.json"
}
teardown() {
  bash "$SCRIPT" stop --state-dir "$STATE_DIR" --timeout-sec 15 >/dev/null 2>&1 3>&- || true
  rm -rf "$REPO"
}

# --- helper: feature.test.mjs を生成 ---
make_test() {
  cat > "$REPO/feature.test.mjs" <<'EOF'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ok } from './impl.mjs';
test('ok is true', () => { assert.equal(ok, true); });
EOF
}

# -----------------------------------------------------------------------
# シナリオ A: tracked-modified (従来パス)
# impl を base で commit → worktree 上で変更 → untracked ではない
# -----------------------------------------------------------------------
@test "A: tracked-modified impl で red→green 判定が成立する" {
  # base commit に impl(false)を含める
  echo "export const ok = false;" > "$REPO/impl.mjs"
  git -C "$REPO" add impl.mjs && git -C "$REPO" commit -q -m "add impl base"
  # worktree 上で true に変更(tracked-modified = implementer の変更相当)
  echo "export const ok = true;" > "$REPO/impl.mjs"
  make_test

  run bash "$RGV" "$REPO" "feature.test.mjs" "impl.mjs"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"red":true'* ]]
  [[ "$output" == *'"green":true'* ]]
}

# -----------------------------------------------------------------------
# シナリオ B: untracked 新規 impl (dev-flow の主要ユースケース)
# impl を一度も commit せず worktree に置く → git ls-files で認識されない
# -----------------------------------------------------------------------
# 同じシナリオの実行 1 回(node --test が red / green の 2 回走る)に、判定・復元・
# 1 ペア呼び出しの配列形(J6 前半)の assert を並べる。
@test "B: untracked 新規 impl ファイルで red→green 判定が成立し、impl が復元され、1 ペアでも results 配列で返る" {
  # impl を commit しない(untracked のまま)
  echo "export const ok = true;" > "$REPO/impl.mjs"
  make_test

  run bash "$RGV" "$REPO" "feature.test.mjs" "impl.mjs"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"red":true'* ]]
  [[ "$output" == *'"green":true'* ]]
  # 判定後も impl が worktree に残っていること(worktree 破損なし)
  [ -f "$REPO/impl.mjs" ]
  grep -q "true" "$REPO/impl.mjs"
  # J6: 1 ペア呼び出しも配列で返り、判定完了は exit 0
  [ "$(printf '%s' "$output" | jq -r '.results | type')" = "array" ]
  [ "$(printf '%s' "$output" | jq -r '.results[0].index')" -eq 0 ]
}

# -----------------------------------------------------------------------
# シナリオ C: untracked impl が存在しない(パス誤り)→ exit 2
# -----------------------------------------------------------------------
@test "C: 存在しない untracked impl は exit 2" {
  make_test

  run bash "$RGV" "$REPO" "feature.test.mjs" "nonexistent.mjs"
  [ "$status" -eq 2 ]
  [[ "$output" == *'impl file not found'* ]]
}

# -----------------------------------------------------------------------
# 既存バリデーション
# -----------------------------------------------------------------------
@test "test と impl が同一ファイル(混在)は exit 2" {
  make_test
  run bash "$RGV" "$REPO" "feature.test.mjs" "feature.test.mjs"
  [ "$status" -eq 2 ]
}

# -----------------------------------------------------------------------
# シナリオ D: 別ディレクトリに同名 untracked impl が複数ある
# a/mod.mjs と b/mod.mjs を同時申告しても basename 衝突で上書きされないこと
# -----------------------------------------------------------------------
@test "D: 別ディレクトリの同名 untracked impl 2 件が両方正しく復元される" {
  mkdir -p "$REPO/a" "$REPO/b"
  echo "export const va = 1;" > "$REPO/a/mod.mjs"
  echo "export const vb = 2;" > "$REPO/b/mod.mjs"

  # test ファイル(参照しないが runner が必要)
  cat > "$REPO/feature.test.mjs" <<'EOF'
import { test } from 'node:test';
import assert from 'node:assert/strict';
test('dummy', () => { assert.ok(true); });
EOF

  run bash "$RGV" "$REPO" "feature.test.mjs" "a/mod.mjs,b/mod.mjs"
  [ "$status" -eq 0 ]

  # 両ファイルが正しい内容で復元されていること
  [ -f "$REPO/a/mod.mjs" ]
  grep -q "va = 1" "$REPO/a/mod.mjs"
  [ -f "$REPO/b/mod.mjs" ]
  grep -q "vb = 2" "$REPO/b/mod.mjs"
}

# -----------------------------------------------------------------------
# シナリオ E: 複数 untracked impl の一部が不在 → 先行ファイルが消失しないこと
# first.mjs は存在、second.mjs は不在 → exit 2 かつ first.mjs が復元されている
# -----------------------------------------------------------------------
@test "E: 複数 untracked impl の一部が不在のとき先行ファイルが消失しない" {
  echo "export const ok = true;" > "$REPO/first.mjs"
  # second.mjs は意図的に作らない

  cat > "$REPO/feature.test.mjs" <<'EOF'
import { test } from 'node:test';
import assert from 'node:assert/strict';
test('dummy', () => { assert.ok(true); });
EOF

  run bash "$RGV" "$REPO" "feature.test.mjs" "first.mjs,second.mjs"
  [ "$status" -eq 2 ]
  [[ "$output" == *'impl file not found'* ]]

  # first.mjs が削除されずに残っている(消失しない)
  [ -f "$REPO/first.mjs" ]
  grep -q "true" "$REPO/first.mjs"
}

# -----------------------------------------------------------------------
# F: vdelta 経路(issue #881 / #1279)。base の tree の package.json の dependencies / devDependencies に vdelta があり、
# files_command に vitest の語があるときだけコマンドを `<PM の exec> vdelta run --report json --` で包み、green 後の
# `<PM の exec> vdelta compare --report json` を verdict に載せる。.claude/redgreen.conf は読まない。
# -----------------------------------------------------------------------

# make_mock_pm <name> <compare 応答> [<impl>]: PM の exec(npx / pnpm)の stub。argv を "<name> <argv>" で
# calls.log に記録し、`vdelta compare` には <compare 応答> を返し(空なら exit 1)、それ以外は <impl>
# (既定 impl.ts)があるときだけ pass する
make_mock_pm() {
  mkdir -p "$REPO/mockbin"
  cat > "$REPO/mockbin/$1" <<EOF
#!/usr/bin/env bash
echo "$1 \$*" >> "$REPO/calls.log"
case "\$*" in
  *"vdelta compare"*) [ -n '$2' ] || exit 1; echo '$2' ;;
  *) [ -f "$REPO/${3:-impl.ts}" ] ;;
esac
EOF
  chmod +x "$REPO/mockbin/$1"
}

# vdelta と vitest を devDependencies に持つ repo(files_command は npx vitest run {files})+ impl.ts / feature.test.ts
use_vdelta_vitest() {
  use_package_json '{"devDependencies":{"vitest":"^3.0.0","vdelta":"^0.10.0"}}'
  use_commands 'npx vitest run {files}'
  echo "export const ok = true;" > "$REPO/impl.ts"
  echo "// feature test" > "$REPO/feature.test.ts"
}

@test "F1: devDependencies に vdelta がある vitest の repo は vdelta run 経由で実行し verdict を載せる(PM の exec で起動)" {
  use_vdelta_vitest
  make_mock_pm npx '{"comparability":"exact","verdict":"improved"}'

  run env PATH="$REPO/mockbin:$PATH" bash "$RGV" "$REPO" "feature.test.ts" "impl.ts"
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -r '.results[0].red and .results[0].green')" = "true" ]
  [ "$(printf '%s' "$output" | jq -c '.results[0].verdict')" = '{"comparability":"exact","verdict":"improved"}' ]
  [ "$(printf '%s' "$output" | jq -r '.results[0].testcmd_ran')" = "true" ]
  # vdelta run 経路が走ったペアは headdiff を出力しない
  [ "$(printf '%s' "$output" | jq -r '.results[0] | has("headdiff")')" = "false" ]
  [ "$(cat "$REPO/calls.log")" = "$(printf '%s\n' \
    'npx vdelta run --report json -- npx vitest run feature.test.ts' \
    'npx vdelta run --report json -- npx vitest run feature.test.ts' \
    'npx vdelta compare --report json')" ]

  # files_command が pnpm exec vitest の repo(vdelta は dependencies)では pnpm exec で包み、compare も pnpm exec で起動する
  rm "$REPO/calls.log"
  use_package_json '{"dependencies":{"vdelta":"^0.10.0"},"devDependencies":{"vitest":"^3.0.0"}}'
  use_commands 'pnpm exec vitest run {files}'
  make_mock_pm pnpm '{"comparability":"exact"}'
  run env PATH="$REPO/mockbin:$PATH" bash "$RGV" "$REPO" "feature.test.ts" "impl.ts"
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -c '.results[0].verdict')" = '{"comparability":"exact"}' ]
  [ "$(cat "$REPO/calls.log")" = "$(printf '%s\n' \
    'pnpm exec vdelta run --report json -- pnpm exec vitest run feature.test.ts' \
    'pnpm exec vdelta run --report json -- pnpm exec vitest run feature.test.ts' \
    'pnpm exec vdelta compare --report json')" ]
}

@test "F2: vdelta compare の非ゼロ exit / 不正 JSON は fail-open で verdict を載せず red→green は変わらない" {
  use_vdelta_vitest
  make_mock_pm npx ''
  run env PATH="$REPO/mockbin:$PATH" bash "$RGV" "$REPO" "feature.test.ts" "impl.ts"
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -r '.results[0].red and .results[0].green')" = "true" ]
  [ "$(printf '%s' "$output" | jq -r '.results[0] | has("verdict")')" = "false" ]

  make_mock_pm npx 'not-json'
  run env PATH="$REPO/mockbin:$PATH" bash "$RGV" "$REPO" "feature.test.ts" "impl.ts"
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -r '.results[0].red and .results[0].green')" = "true" ]
  [ "$(printf '%s' "$output" | jq -r '.results[0] | has("verdict")')" = "false" ]
  grep -q 'vdelta compare' "$REPO/calls.log"
}

@test "F3: vdelta が依存に無い vitest の repo は素の vitest で実行し vdelta を呼ばず verdict を載せない" {
  use_package_json '{"devDependencies":{"vitest":"^3.0.0"}}'
  use_commands 'npx vitest run {files}'
  echo "export const ok = true;" > "$REPO/impl.ts"
  echo "// feature test" > "$REPO/feature.test.ts"
  make_mock_pm npx '{"comparability":"exact"}'

  run env PATH="$REPO/mockbin:$PATH" bash "$RGV" "$REPO" "feature.test.ts" "impl.ts"
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -r '.results[0].red and .results[0].green')" = "true" ]
  [ "$(printf '%s' "$output" | jq -r '.results[0] | has("verdict")')" = "false" ]
  [ "$(printf '%s' "$output" | jq -r '.results[0].testcmd_ran')" = "false" ]
  [ "$(cat "$REPO/calls.log")" = "$(printf '%s\n' 'npx vitest run feature.test.ts' 'npx vitest run feature.test.ts')" ]
}

@test "F4: vdelta が依存にあっても vitest 以外のコマンド(jest)はそのまま実行し vdelta を呼ばず verdict を載せない" {
  use_package_json '{"devDependencies":{"jest":"^29.0.0","vdelta":"^0.10.0"}}'
  use_commands 'npx jest {files}'
  echo "export const ok = true;" > "$REPO/impl.ts"
  echo "// feature test" > "$REPO/feature.test.ts"
  make_mock_pm npx '{"comparability":"exact"}'

  run env PATH="$REPO/mockbin:$PATH" bash "$RGV" "$REPO" "feature.test.ts" "impl.ts"
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -r '.results[0].red and .results[0].green')" = "true" ]
  [ "$(printf '%s' "$output" | jq -r '.results[0] | has("verdict")')" = "false" ]
  [ "$(printf '%s' "$output" | jq -r '.results[0].testcmd_ran')" = "false" ]
  [ "$(cat "$REPO/calls.log")" = "$(printf '%s\n' 'npx jest feature.test.ts' 'npx jest feature.test.ts')" ]
}

@test "F5: vdelta が依存にあっても files_command が bats の repo は vdelta を呼ばず verdict を載せない" {
  use_vdelta_vitest
  use_commands 'bats {files}'
  # NOTE: heredoc でこの .bats ファイルのソース行頭に "@test" を直書きすると、
  # このファイル(redgreen-verify.bats)自身を静的スキャンする bats のテスト発見
  # ロジックが nested な行まで誤って test 宣言として拾ってしまう
  # (bats: unknown test name エラーで plan count がずれる。bats のバージョンに
  # よっては行頭インデントだけでは回避できない)。printf で1行ずつ書き出し、
  # ソース行が "@test" で始まらないようにして誤検出を避ける。
  {
    printf '%s\n' '#!/usr/bin/env bats'
    printf '%s\n' '@test "impl exists" {'
    printf '  [ -f "%s/impl.ts" ]\n' "$REPO"
    printf '%s\n' '}'
  } > "$REPO/feature.bats"
  make_mock_pm npx '{"comparability":"exact"}'

  run env PATH="$REPO/mockbin:$PATH" bash "$RGV" "$REPO" "feature.bats" "impl.ts"
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -r '.results[0].red and .results[0].green')" = "true" ]
  [ "$(printf '%s' "$output" | jq -r '.results[0] | has("verdict")')" = "false" ]
  [ ! -f "$REPO/calls.log" ]
}

@test "F6: .claude/redgreen.conf を置いても読まれず結果も起動コマンドも変わらない" {
  use_vdelta_vitest
  make_mock_pm npx '{"comparability":"exact"}'
  run env PATH="$REPO/mockbin:$PATH" bash "$RGV" "$REPO" "feature.test.ts" "impl.ts"
  [ "$status" -eq 0 ]
  without_conf="$output"
  calls_without_conf="$(cat "$REPO/calls.log")"
  rm "$REPO/calls.log"

  mkdir -p "$REPO/.claude"
  printf '#!/usr/bin/env bash\ntouch "%s/conf-called"\necho "{\\"from\\":\\"conf\\"}"\n' "$REPO" > "$REPO/conf-cmd.sh"
  {
    echo "test_cmd=bash ./conf-cmd.sh"
    echo "verdict_cmd=bash ./conf-cmd.sh"
  } > "$REPO/.claude/redgreen.conf"
  run env PATH="$REPO/mockbin:$PATH" bash "$RGV" "$REPO" "feature.test.ts" "impl.ts"
  [ "$status" -eq 0 ]
  [ "$output" = "$without_conf" ]
  [ "$(cat "$REPO/calls.log")" = "$calls_without_conf" ]
  [ ! -e "$REPO/conf-called" ]
}

@test "F7: base の package.json に vdelta があれば、worktree の package.json から vdelta を外しても vdelta で包む" {
  use_vdelta_vitest
  echo '{"devDependencies":{"vitest":"^3.0.0"}}' > "$REPO/package.json"
  make_mock_pm npx '{"comparability":"exact"}'

  run env PATH="$REPO/mockbin:$PATH" bash "$RGV" "$REPO" "feature.test.ts" "impl.ts"
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -r '.results[0].red and .results[0].green')" = "true" ]
  [ "$(printf '%s' "$output" | jq -c '.results[0].verdict')" = '{"comparability":"exact"}' ]
  [ "$(cat "$REPO/calls.log")" = "$(printf '%s\n' \
    'npx vdelta run --report json -- npx vitest run feature.test.ts' \
    'npx vdelta run --report json -- npx vitest run feature.test.ts' \
    'npx vdelta compare --report json')" ]
}

# -----------------------------------------------------------------------
# G1〜G6: issue #630 AC1〜AC6 の pin。共有 stash スタックへの読み書きを
# 撤廃する実装変更(F2)を先取りして red/green を固定する回帰・仕様テスト。
# -----------------------------------------------------------------------

@test "G1: 事前 stash があっても tracked-modified impl の redgreen が共有 stash スタックに触れない" {
  echo "export const ok = false;" > "$REPO/impl.mjs"
  git -C "$REPO" add impl.mjs && git -C "$REPO" commit -q -m "add impl base"
  # 別セッション相当の stash を 1 本積む(tracked ファイルの削除)。push 後 worktree は HEAD に戻る
  rm "$REPO/.gitkeep"
  git -C "$REPO" stash push -q -m "other-session" -- .gitkeep
  [ -f "$REPO/.gitkeep" ]
  echo "export const ok = true;" > "$REPO/impl.mjs"
  make_test
  before_n="$(git -C "$REPO" stash list | wc -l | tr -d ' ')"
  before_sha="$(git -C "$REPO" rev-parse 'stash@{0}')"

  run bash "$RGV" "$REPO" "feature.test.mjs" "impl.mjs"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"red":true'* ]]
  [[ "$output" == *'"green":true'* ]]
  [ "$(git -C "$REPO" stash list | wc -l | tr -d ' ')" = "$before_n" ]
  [ "$(git -C "$REPO" rev-parse 'stash@{0}')" = "$before_sha" ]
  [ -f "$REPO/.gitkeep" ]
  grep -q "true" "$REPO/impl.mjs"
}

@test "G2: HEAD と同一内容の tracked impl のみは exit 2・no impl changed vs HEAD・テスト未実行・tree 不変" {
  use_package_json '{"devDependencies":{"vitest":"^3.0.0"}}'
  echo "export const ok = true;" > "$REPO/impl.mjs"
  git -C "$REPO" add impl.mjs && git -C "$REPO" commit -q -m "add impl"
  rm "$REPO/.gitkeep"
  git -C "$REPO" stash push -q -m "other-session" -- .gitkeep
  make_test
  use_commands 'npx vitest run {files}'
  make_mock_pm npx '' impl.mjs
  before_status="$(git -C "$REPO" status --porcelain)"
  before_n="$(git -C "$REPO" stash list | wc -l | tr -d ' ')"
  before_sha="$(git -C "$REPO" rev-parse 'stash@{0}')"

  run env PATH="$REPO/mockbin:$PATH" bash "$RGV" "$REPO" "feature.test.mjs" "impl.mjs"
  [ "$status" -eq 2 ]
  [[ "$output" == *'"reason":"no impl changed vs HEAD'* ]]
  [ ! -f "$REPO/calls.log" ]
  [ "$(git -C "$REPO" status --porcelain)" = "$before_status" ]
  [ "$(git -C "$REPO" stash list | wc -l | tr -d ' ')" = "$before_n" ]
  [ "$(git -C "$REPO" rev-parse 'stash@{0}')" = "$before_sha" ]
  [ -f "$REPO/.gitkeep" ]
}

@test "G3: 変更あり tracked impl + 無変更 tracked impl の混在で変更ありのみ base 化され tree(mode 含む)が不変" {
  echo "export const ok = false;" > "$REPO/impl.mjs"
  echo "export const other = 1;" > "$REPO/other.mjs"
  git -C "$REPO" add impl.mjs other.mjs && git -C "$REPO" commit -q -m "add impls"
  echo "export const ok = true;" > "$REPO/impl.mjs"
  chmod +x "$REPO/impl.mjs"
  make_test
  before_status="$(git -C "$REPO" status --porcelain)"
  before_summary="$(git -C "$REPO" diff HEAD --summary)"
  [[ "$before_summary" == *"mode change"* ]]

  run bash "$RGV" "$REPO" "feature.test.mjs" "impl.mjs,other.mjs"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"red":true'* ]]
  [[ "$output" == *'"green":true'* ]]
  [ "$(git -C "$REPO" status --porcelain)" = "$before_status" ]
  [ "$(git -C "$REPO" diff HEAD --summary)" = "$before_summary" ]
  [ -x "$REPO/impl.mjs" ]
  grep -q "other = 1" "$REPO/other.mjs"
}

@test "G4: git add 済み未 commit の新規 impl は untracked と同様に red→green、終了後もファイルと index 登録が残る" {
  echo "export const ok = true;" > "$REPO/impl.mjs"
  git -C "$REPO" add impl.mjs
  make_test

  run bash "$RGV" "$REPO" "feature.test.mjs" "impl.mjs"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"red":true'* ]]
  [[ "$output" == *'"green":true'* ]]
  [ -f "$REPO/impl.mjs" ]
  grep -q "true" "$REPO/impl.mjs"
  git -C "$REPO" ls-files --error-unmatch impl.mjs
  [ "$(git -C "$REPO" diff --cached --name-only)" = "impl.mjs" ]
}

@test "G5: worktree から削除した tracked impl は exit 2・impl file not found・テスト未実行" {
  use_package_json '{"devDependencies":{"vitest":"^3.0.0"}}'
  echo "export const ok = true;" > "$REPO/impl.mjs"
  git -C "$REPO" add impl.mjs && git -C "$REPO" commit -q -m "add impl"
  rm "$REPO/impl.mjs"
  make_test
  use_commands 'npx vitest run {files}'
  make_mock_pm npx '' impl.mjs

  run env PATH="$REPO/mockbin:$PATH" bash "$RGV" "$REPO" "feature.test.mjs" "impl.mjs"
  [ "$status" -eq 2 ]
  [[ "$output" == *'impl file not found: impl.mjs'* ]]
  [ ! -f "$REPO/calls.log" ]
  [ ! -f "$REPO/impl.mjs" ]
}

@test "G5b: 削除済み tracked impl と存在する untracked impl の同時申告で untracked impl が消失しない" {
  echo "export const gone = 1;" > "$REPO/gone.mjs"
  git -C "$REPO" add gone.mjs && git -C "$REPO" commit -q -m "add gone"
  rm "$REPO/gone.mjs"
  echo "export const ok = true;" > "$REPO/impl.mjs"
  make_test

  run bash "$RGV" "$REPO" "feature.test.mjs" "impl.mjs,gone.mjs"
  [ "$status" -eq 2 ]
  [[ "$output" == *'impl file not found: gone.mjs'* ]]
  [ -f "$REPO/impl.mjs" ]
  grep -q "true" "$REPO/impl.mjs"
}

@test "G6: redgreen-verify.sh のコメント行を除いた行に git stash が出現しない" {
  run bash -c "grep -v '^[[:space:]]*#' '$SCRIPT' | grep -c 'git stash'"
  [ "$output" = "0" ]
}

# issue #868: テストは sandbox 内で走り、sandbox は repo によって .git/worktrees/*/index.lock を書かせない。
# 既存の index.lock で「index.lock を作れない」状態を再現し、tracked impl の base 化が index に触れずに
# 成立すること(HEAD の実行ビットへ戻すことも含む)と、index が書き換わらないことを pin する。
@test "G7: index.lock を作れない状態でも tracked-modified impl(内容 + 実行ビット)の red→green が成立し index は不変" {
  echo "export const ok = false;" > "$REPO/impl.mjs"
  git -C "$REPO" add impl.mjs && git -C "$REPO" commit -q -m "add impl base"
  echo "export const ok = true;" > "$REPO/impl.mjs"
  chmod +x "$REPO/impl.mjs"
  cat > "$REPO/feature.test.mjs" <<'EOF'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { ok } from './impl.mjs';
test('ok is true', () => { assert.equal(ok, true); });
test('impl is executable', () => { assert.ok(statSync(new URL('./impl.mjs', import.meta.url)).mode & 0o100); });
EOF
  before_index="$(shasum "$REPO/.git/index")"
  : > "$REPO/.git/index.lock"

  run bash "$RGV" "$REPO" "feature.test.mjs" "impl.mjs"
  rm -f "$REPO/.git/index.lock"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"red":true'* ]]
  [[ "$output" == *'"green":true'* ]]
  [ "$(shasum "$REPO/.git/index")" = "$before_index" ]
  grep -q "true" "$REPO/impl.mjs"
  [ -x "$REPO/impl.mjs" ]
}

# -----------------------------------------------------------------------
# I: testcmd_ran / headdiff (issue #654 AC-1/AC-2)
# vdelta run 経路が走らなかった invocation で testcmd_ran:false と headdiff が
# 常時出力されること、vdelta run 経路が走った invocation では headdiff が
# 出力されないことを pin する。
# -----------------------------------------------------------------------

make_feature_bats() {
  {
    printf '%s\n' '#!/usr/bin/env bats'
    printf '%s\n' '@test "impl exists" {'
    printf '  [ -f "%s/impl.mjs" ]\n' "$REPO"
    printf '%s\n' '}'
  } > "$REPO/feature.bats"
  use_commands 'bats {files}'
}

@test "I1: bats-only, untracked feature.bats は testcmd_ran:false と headdiff new:1 を出力する" {
  echo "export const ok = true;" > "$REPO/impl.mjs"
  make_feature_bats

  run bash "$RGV" "$REPO" "feature.bats" "impl.mjs"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"red":true'* ]]
  [[ "$output" == *'"green":true'* ]]
  [[ "$output" == *'"testcmd_ran":false'* ]]
  [[ "$output" == *'"headdiff":{"new":1,"modified":0,"unchanged":0,"total":1}'* ]]
}

@test "I2: HEAD にある feature.bats を worktree で変更すると headdiff modified:1" {
  echo "export const ok = true;" > "$REPO/impl.mjs"
  make_feature_bats
  git -C "$REPO" add feature.bats && git -C "$REPO" commit -q -m "add feature.bats"
  printf '%s\n' '# modified in worktree' >> "$REPO/feature.bats"

  run bash "$RGV" "$REPO" "feature.bats" "impl.mjs"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"headdiff":{"new":0,"modified":1,"unchanged":0,"total":1}'* ]]
}

@test "I3: HEAD と同一内容の feature.bats は headdiff unchanged:1" {
  echo "export const ok = true;" > "$REPO/impl.mjs"
  make_feature_bats
  git -C "$REPO" add feature.bats && git -C "$REPO" commit -q -m "add feature.bats"

  run bash "$RGV" "$REPO" "feature.bats" "impl.mjs"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"headdiff":{"new":0,"modified":0,"unchanged":1,"total":1}'* ]]
}

# vdelta run 経路が走った 1 ペアの testcmd_ran:true / headdiff なしは F1 が同じ実行で見る
@test "I6: node --test 直接経路も testcmd_ran:false と headdiff を出力する(拡張子非依存)" {
  echo "export const ok = true;" > "$REPO/impl.mjs"
  make_test

  run bash "$RGV" "$REPO" "feature.test.mjs" "impl.mjs"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"testcmd_ran":false'* ]]
  [[ "$output" == *'"headdiff":{"new":1,"modified":0,"unchanged":0,"total":1}'* ]]
}

@test "I7: exit 2 経路(入力エラー)の出力は testcmd_ran を含まない(不変)" {
  echo "export const ok = true;" > "$REPO/impl.mjs"
  git -C "$REPO" add impl.mjs && git -C "$REPO" commit -q -m "add impl"
  make_test

  run bash "$RGV" "$REPO" "feature.test.mjs" "impl.mjs"
  [ "$status" -eq 2 ]
  [[ "$output" == *'"reason":"no impl changed vs HEAD'* ]]
  [[ "$output" != *'"testcmd_ran"'* ]]
}

# -----------------------------------------------------------------------
# J: 複数ペア一括判定(issue #683)
# <WT> <T1> <I1> [<T2> <I2> ...] を 1 呼び出しで受け、ペアごとの結果を
# 引数順の JSON 配列(各要素に index)で返す。ペアの入力エラーは当該要素の
# reason に載せて続行し、exit 2 は全ペアが入力エラーのときだけ。
# -----------------------------------------------------------------------

# files_command を npx vitest run {files} にし、impl1 / impl2 が worktree 版の内容(a = 1 / b = 2)で存在するかを
# 呼び出しごとに記録する npx stub を mockbin に置く(`npx vitest run <test>` の末尾引数で振り分ける。ペア間の退避分離を
# 検証する。tracked-modified の base 化はファイルが残るので内容で判定する)
make_mock_runner_pairs() {
  use_commands 'npx vitest run {files}'
  mkdir -p "$REPO/mockbin"
  cat > "$REPO/mockbin/npx" <<EOF
#!/usr/bin/env bash
t="\${@: -1}"
s1=absent; s2=absent
grep -q "a = 1" "$REPO/impl1.mjs" 2>/dev/null && s1=present
grep -q "b = 2" "$REPO/impl2.mjs" 2>/dev/null && s2=present
echo "\$t impl1=\$s1 impl2=\$s2" >> "$REPO/calls.log"
case "\$t" in
  t1.test.mjs) [ "\$s1" = present ] ;;
  t2.test.mjs) [ "\$s2" = present ] ;;
  *) exit 99 ;;
esac
EOF
  chmod +x "$REPO/mockbin/npx"
}

@test "J1: 2 ペアを 1 呼び出しで判定し index 付き配列で両方 red→green が返る" {
  echo "export const a = 1;" > "$REPO/impl1.mjs"
  echo "export const b = 2;" > "$REPO/impl2.mjs"
  echo "// t1" > "$REPO/t1.test.mjs"
  echo "// t2" > "$REPO/t2.test.mjs"
  make_mock_runner_pairs

  run env PATH="$REPO/mockbin:$PATH" bash "$RGV" "$REPO" "t1.test.mjs" "impl1.mjs" "t2.test.mjs" "impl2.mjs"
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -r '.results | length')" -eq 2 ]
  [ "$(printf '%s' "$output" | jq -r '.results[0].index')" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -r '.results[1].index')" -eq 1 ]
  [ "$(printf '%s' "$output" | jq -r '.results[0].red and .results[0].green')" = "true" ]
  [ "$(printf '%s' "$output" | jq -r '.results[1].red and .results[1].green')" = "true" ]
  [ -f "$REPO/impl1.mjs" ] && [ -f "$REPO/impl2.mjs" ]
}

@test "J2: ペアごとの red は当該ペアの impl だけを外して測る(他ペアの impl は残る)" {
  echo "export const a = 1;" > "$REPO/impl1.mjs"
  echo "export const b = 2;" > "$REPO/impl2.mjs"
  echo "// t1" > "$REPO/t1.test.mjs"
  echo "// t2" > "$REPO/t2.test.mjs"
  make_mock_runner_pairs

  run env PATH="$REPO/mockbin:$PATH" bash "$RGV" "$REPO" "t1.test.mjs" "impl1.mjs" "t2.test.mjs" "impl2.mjs"
  [ "$status" -eq 0 ]
  # 呼び出し順: pair0 red / pair0 green / pair1 red / pair1 green
  [ "$(sed -n 1p "$REPO/calls.log")" = "t1.test.mjs impl1=absent impl2=present" ]
  [ "$(sed -n 2p "$REPO/calls.log")" = "t1.test.mjs impl1=present impl2=present" ]
  [ "$(sed -n 3p "$REPO/calls.log")" = "t2.test.mjs impl1=present impl2=absent" ]
  [ "$(sed -n 4p "$REPO/calls.log")" = "t2.test.mjs impl1=present impl2=present" ]
  [ "$(wc -l < "$REPO/calls.log" | tr -d ' ')" -eq 4 ]
}

@test "J3: 1 ペアが入力エラーでも他ペアは判定完了し exit 0(当該要素だけ red:false green:false + reason)" {
  echo "export const a = 1;" > "$REPO/impl1.mjs"
  echo "export const b = 2;" > "$REPO/impl2.mjs"
  echo "// t2" > "$REPO/t2.test.mjs"
  make_mock_runner_pairs

  # pair0 は test と impl が同一ファイル、pair1 は正常
  run env PATH="$REPO/mockbin:$PATH" bash "$RGV" "$REPO" "impl1.mjs" "impl1.mjs" "t2.test.mjs" "impl2.mjs"
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -r '.results | length')" -eq 2 ]
  [ "$(printf '%s' "$output" | jq -r '.results[0].red or .results[0].green')" = "false" ]
  [ "$(printf '%s' "$output" | jq -r '.results[0].reason')" = "file is both test and impl: impl1.mjs" ]
  [ "$(printf '%s' "$output" | jq -r '.results[0] | has("testcmd_ran")')" = "false" ]
  [ "$(printf '%s' "$output" | jq -r '.results[1].red and .results[1].green')" = "true" ]
  # pair0 の入力エラーで pair1 の判定が走っている(退避・復元も完了)
  [ "$(grep -c 't2.test.mjs' "$REPO/calls.log")" -eq 2 ]
  [ -f "$REPO/impl1.mjs" ] && [ -f "$REPO/impl2.mjs" ]
}

@test "J4: 全ペアが入力エラーなら exit 2 で配列は全要素 reason 付き" {
  echo "export const a = 1;" > "$REPO/impl1.mjs"
  echo "// t2" > "$REPO/t2.test.mjs"

  run bash "$RGV" "$REPO" "impl1.mjs" "impl1.mjs" "t2.test.mjs" "nonexistent.mjs"
  [ "$status" -eq 2 ]
  [ "$(printf '%s' "$output" | jq -r '.results | length')" -eq 2 ]
  [ "$(printf '%s' "$output" | jq -r '.results[0].reason')" = "file is both test and impl: impl1.mjs" ]
  [ "$(printf '%s' "$output" | jq -r '.results[1].reason')" = "impl file not found: nonexistent.mjs" ]
}

@test "J5: ペア引数が奇数(test_csv だけ余る)なら exit 2 で stdout は空配列" {
  echo "export const a = 1;" > "$REPO/impl1.mjs"
  echo "// t1" > "$REPO/t1.test.mjs"

  run bash "$RGV" "$REPO" "t1.test.mjs" "impl1.mjs" "t2.test.mjs"
  [ "$status" -eq 2 ]
  # usage は stderr(run は stdout/stderr を混ぜる)。stdout 側の最終行が空配列であること
  [ "${lines[${#lines[@]}-1]}" = '{"results":[]}' ]
  [[ "$output" == *'usage: redgreen-verify.sh'* ]]
}

# 判定完了 exit 0 で配列が返る側は B のテストが同じ実行で見る
@test "J6: 1 ペア呼び出しの入力エラーも配列で返り exit 2" {
  echo "export const ok = true;" > "$REPO/impl.mjs"
  make_test

  run bash "$RGV" "$REPO" "feature.test.mjs" "feature.test.mjs"
  [ "$status" -eq 2 ]
  [ "$(printf '%s' "$output" | jq -r '.results | type')" = "array" ]
}

@test "J7: tracked-modified と untracked のペアが混在しても各ペアが判定され tree(status)は不変" {
  echo "export const a = 0;" > "$REPO/impl1.mjs"
  git -C "$REPO" add impl1.mjs && git -C "$REPO" commit -q -m "add impl1"
  echo "export const a = 1;" > "$REPO/impl1.mjs"
  echo "export const b = 2;" > "$REPO/impl2.mjs"
  echo "// t1" > "$REPO/t1.test.mjs"
  echo "// t2" > "$REPO/t2.test.mjs"
  make_mock_runner_pairs
  # mock runner が calls.log を作るので比較は calls.log を除いた status で行う
  before_status="$(git -C "$REPO" status --porcelain | grep -v calls.log)"

  run env PATH="$REPO/mockbin:$PATH" bash "$RGV" "$REPO" "t1.test.mjs" "impl1.mjs" "t2.test.mjs" "impl2.mjs"
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -r '.results[0].red and .results[0].green')" = "true" ]
  [ "$(printf '%s' "$output" | jq -r '.results[1].red and .results[1].green')" = "true" ]
  [ "$(git -C "$REPO" status --porcelain | grep -v calls.log)" = "$before_status" ]
  grep -q "a = 1" "$REPO/impl1.mjs"
  grep -q "b = 2" "$REPO/impl2.mjs"
}

# -----------------------------------------------------------------------
# M: --base <ref>(Final reconcile の commit 済み tree。issue #1146)
# impl・test は全部 commit 済みで worktree は HEAD と同一。HEAD 基準では何も外せないので、
# HEAD と <ref> の merge-base を base にして red→green を測る。
# -----------------------------------------------------------------------
@test "M1: --base は commit 済みの impl(base で変更 + base 以降の新規)を merge-base に戻して red→green を測り、tree は HEAD のまま" {
  echo "export const ok = false;" > "$REPO/impl.mjs"
  git -C "$REPO" add impl.mjs && git -C "$REPO" commit -q -m "add impl base"
  git -C "$REPO" branch base-ref
  echo "export const ok = true;" > "$REPO/impl.mjs"
  echo "export const extra = 1;" > "$REPO/extra.mjs"
  cat > "$REPO/feature.test.mjs" <<'EOF'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ok } from './impl.mjs';
import { extra } from './extra.mjs';
test('ok is true', () => { assert.equal(ok, true); assert.equal(extra, 1); });
EOF
  git -C "$REPO" add -A && git -C "$REPO" commit -q -m "pr commit"
  [ -z "$(git -C "$REPO" status --porcelain)" ]

  run bash "$RGV" --base base-ref "$REPO" "feature.test.mjs" "impl.mjs,extra.mjs"
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -r '.results[0].red and .results[0].green')" = "true" ]
  [ "$(printf '%s' "$output" | jq -r '.results[0].headdiff.new')" -eq 1 ]
  [ -z "$(git -C "$REPO" status --porcelain)" ]
  grep -q "ok = true" "$REPO/impl.mjs"
  grep -q "extra = 1" "$REPO/extra.mjs"
}

@test "M2: --base の merge-base が解決できなければ exit 2・空配列・テスト未実行" {
  use_package_json '{"devDependencies":{"vitest":"^3.0.0"}}'
  echo "export const ok = true;" > "$REPO/impl.mjs"
  make_test
  use_commands 'npx vitest run {files}'
  make_mock_pm npx '' impl.mjs

  run env PATH="$REPO/mockbin:$PATH" bash "$RGV" --base no-such-ref "$REPO" "feature.test.mjs" "impl.mjs"
  [ "$status" -eq 2 ]
  [ "${lines[${#lines[@]}-1]}" = '{"results":[]}' ]
  [ ! -f "$REPO/calls.log" ]
  [ -f "$REPO/impl.mjs" ]
}

# -----------------------------------------------------------------------
# N: start / wait / stop(issue #1226)。red→green が Bash 1 回の上限を超えても結果を返せるように切り離して実行する。
# 止めたときは impl が worktree に戻っていることを、止まり方(TERM・KILL・supervisor の消失)ごとに見る。
# -----------------------------------------------------------------------

# files_command を npx vitest run {files} にし、tracked-modified の impl.ts + untracked の new.ts を置く。npx stub は
# started に印を残してから <本文> を実行し、new.ts があるときだけ pass する
make_slow_runner() {
  use_commands 'npx vitest run {files}'
  echo "export const ok = false;" > "$REPO/impl.ts"
  git -C "$REPO" add impl.ts && git -C "$REPO" commit -q -m "add impl"
  echo "export const ok = true;" > "$REPO/impl.ts"
  chmod +x "$REPO/impl.ts"
  echo "export const added = 1;" > "$REPO/new.ts"
  echo "// feature test" > "$REPO/feature.test.ts"
  mkdir -p "$REPO/mockbin"
  printf '#!/usr/bin/env bash\n: > "%s/started"\n%s\n[ -f "%s/new.ts" ]\n' "$REPO" "$1" "$REPO" > "$REPO/mockbin/npx"
  chmod +x "$REPO/mockbin/npx"
}

start_slow() {
  run env PATH="$REPO/mockbin:$PATH" bash "$SCRIPT" start --state-dir "$STATE_DIR" --commands "$COMMANDS_FILE" "$REPO" "feature.test.ts" "impl.ts,new.ts" 3>&-
}

# stub が red の実行に入るまで待つ(この時点で impl は退避済み)
wait_red_phase() {
  local i
  for i in $(seq 1 100); do
    [ -f "$REPO/started" ] && break
    sleep 0.1
  done
  [ -f "$REPO/started" ]
  [ ! -f "$REPO/new.ts" ]
  grep -q "ok = false" "$REPO/impl.ts"
}

assert_impl_restored() {
  grep -q "ok = true" "$REPO/impl.ts"
  [ -x "$REPO/impl.ts" ]
  grep -q "added = 1" "$REPO/new.ts"
  [ ! -e "$STATE_DIR/impl-backup" ]
}

@test "N1: テストが --wait-sec より長く sleep するとき start はすぐ running を返し、1 回目の wait は running、2 回目に結果の JSON を返す" {
  make_slow_runner 'sleep 4'

  start_slow
  [ "$status" -eq 0 ]
  [ "$output" = '{"status":"running","results":[]}' ]

  run bash "$SCRIPT" wait --state-dir "$STATE_DIR" --wait-sec 1
  [ "$status" -eq 0 ]
  [ "$output" = '{"status":"running","results":[]}' ]

  run bash "$SCRIPT" wait --state-dir "$STATE_DIR" --wait-sec 60
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -c 'keys')" = '["results"]' ]
  [ "$(printf '%s' "$output" | jq -c '.results[0] | {index, red, green, reason}')" = '{"index":0,"red":true,"green":true,"reason":"ok"}' ]
  assert_impl_restored
}

@test "N2: stop は red の途中のテストを止めて impl(内容・実行ビット・untracked)を戻し、wait は空の results で exit 2 を返す" {
  make_slow_runner 'sleep 300'
  start_slow
  wait_red_phase

  run bash "$SCRIPT" stop --state-dir "$STATE_DIR" --timeout-sec 30
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -c '{ok, stopped}')" = '{"ok":true,"stopped":true}' ]
  assert_impl_restored

  run bash "$SCRIPT" wait --state-dir "$STATE_DIR" --wait-sec 1
  [ "$status" -eq 2 ]
  [ "${lines[${#lines[@]}-1]}" = '{"results":[]}' ]
}

@test "N3: TERM を無視するテストは KILL で止まり、KILL でも supervisor が impl を戻す" {
  make_slow_runner $'trap \'\' TERM\nsleep 300'
  start_slow
  wait_red_phase

  run bash "$SCRIPT" stop --state-dir "$STATE_DIR" --timeout-sec 30
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -r '.ok')" = "true" ]
  assert_impl_restored
}

@test "N4: supervisor が KILL で消えても、wait が結果の無いことを返すときに impl を戻す" {
  make_slow_runner 'sleep 5'
  start_slow
  wait_red_phase

  kill -9 "$(jq -r '.supervisor_pid' "$STATE_DIR/state.json")"
  run bash "$SCRIPT" wait --state-dir "$STATE_DIR" --wait-sec 5
  [ "$status" -eq 2 ]
  [ "${lines[${#lines[@]}-1]}" = '{"results":[]}' ]
  assert_impl_restored
}

@test "N5: start の前の wait は空の results で exit 2" {
  run bash "$SCRIPT" wait --state-dir "$STATE_DIR" --wait-sec 1
  [ "$status" -eq 2 ]
  [ "${lines[${#lines[@]}-1]}" = '{"results":[]}' ]
}

@test "N6: テストが results.json を書いて run ごと落としても結果として読まず、空の results で exit 2 を返して impl を戻す" {
  make_slow_runner "printf '%s\n' '{\"results\":[{\"index\":0,\"red\":true,\"green\":true,\"reason\":\"ok\"}]}' > '$STATE_DIR/results.json'; kill -9 0"
  start_slow

  run bash "$SCRIPT" wait --state-dir "$STATE_DIR" --wait-sec 30
  [ "$status" -eq 2 ]
  [ "${lines[${#lines[@]}-1]}" = '{"results":[]}' ]
  [ -f "$STATE_DIR/results.json" ]
  assert_impl_restored
}

@test "N7: テストが results.json を書いても、完走した run の結果が上書きする" {
  make_slow_runner "printf '%s\n' '{\"results\":[{\"index\":0,\"red\":true,\"green\":true,\"forged\":true}]}' > '$STATE_DIR/results.json'"
  start_slow

  run bash "$SCRIPT" wait --state-dir "$STATE_DIR" --wait-sec 30
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -r '.results[0].forged // "none"')" = none ]
  [ "$(printf '%s' "$output" | jq -r '.results[0].reason')" = ok ]
}

@test "N8: state-dir は TMPDIR の下に呼び出しごとに別のディレクトリを作って JSON で返す" {
  TMPDIR="$BATS_TEST_TMPDIR" run bash "$SCRIPT" state-dir
  [ "$status" -eq 0 ]
  local first second
  first="$(printf '%s' "$output" | jq -r '.state_dir')"
  [ -d "$first" ]
  [ "$(dirname "$first")" = "$BATS_TEST_TMPDIR" ]

  TMPDIR="$BATS_TEST_TMPDIR/" run bash "$SCRIPT" state-dir
  second="$(printf '%s' "$output" | jq -r '.state_dir')"
  [ -d "$second" ]
  # dirname は // を畳むので、末尾 / の TMPDIR で返るパスは文字列のまま比べる
  [ "$second" = "$BATS_TEST_TMPDIR/$(basename "$second")" ]
  [ "$first" != "$second" ]
}

@test "N9: state-dir はディレクトリを作れないと空のパスで exit 2" {
  TMPDIR="$BATS_TEST_TMPDIR/missing" run bash "$SCRIPT" state-dir
  [ "$status" -eq 2 ]
  [ "${lines[${#lines[@]}-1]}" = '{"state_dir":""}' ]
}

@test "N10: start は worktree の中の state dir を拒否し、テストを実行しない" {
  make_slow_runner ':'
  run env PATH="$REPO/mockbin:$PATH" bash "$SCRIPT" start --state-dir "$REPO/.devflow-tmp/redgreen-verify" --commands "$COMMANDS_FILE" "$REPO" "feature.test.ts" "impl.ts,new.ts" 3>&-
  [ "$status" -eq 2 ]
  [ "${lines[${#lines[@]}-1]}" = '{"results":[]}' ]
  [ ! -e "$REPO/started" ]
}

# -----------------------------------------------------------------------
# K: pnpm ワークスペースのビルド成果物(issue #754)
# packages/shared の exports は git 管理外の ./dist を指し、packages/backend が workspace:* で依存する。
# impl は shared のソース(base: v1 → worktree: v2)。テストランナー(files_command は npx vitest run {files}。npx の stub)は
# dist の中身を calls.log に残し、dist が v2 のときだけ pass する。pnpm は stub(scripts.build を実行し呼び出し時点のソースを記録)。
# -----------------------------------------------------------------------
make_pnpm_workspace_pair() {
  use_commands 'npx vitest run {files}'
  mkdir -p "$REPO/packages/shared/src" "$REPO/packages/backend"
  echo '{"name":"root","private":true,"devDependencies":{"vitest":"^3.0.0"}}' > "$REPO/package.json"
  printf 'packages:\n  - packages/*\n' > "$REPO/pnpm-workspace.yaml"
  printf 'dist/\n' > "$REPO/.gitignore"
  cat > "$REPO/packages/shared/package.json" <<'JSON'
{"name":"@fx/shared","exports":{"./greet":{"import":"./dist/greet.js"}},"scripts":{"build":"mkdir -p dist && cp src/greet.js dist/greet.js"}}
JSON
  echo '{"name":"backend","dependencies":{"@fx/shared":"workspace:*"}}' > "$REPO/packages/backend/package.json"
  echo "export const greet = () => 'hello v1';" > "$REPO/packages/shared/src/greet.js"
  git -C "$REPO" add -A && git -C "$REPO" commit -q -m "add workspace base"
  echo "export const greet = () => 'hello v2';" > "$REPO/packages/shared/src/greet.js"
  echo "// greet test" > "$REPO/packages/backend/greet.test.mjs"

  STUB_DIR="$REPO/.stubbin"
  mkdir -p "$STUB_DIR"
  cat > "$STUB_DIR/pnpm" <<EOF
#!/usr/bin/env bash
echo "pnpm \$* src=\$(grep -o 'hello v[0-9]' "$REPO/packages/shared/src/greet.js")" >> "$REPO/calls.log"
cd "$REPO/packages/shared" && sh -c "\$(jq -r '.scripts.build' package.json)"
EOF
  chmod +x "$STUB_DIR/pnpm"

  cat > "$STUB_DIR/npx" <<EOF
#!/usr/bin/env bash
echo "test \${@: -1} dist=\$(grep -o 'hello v[0-9]' "$REPO/packages/shared/dist/greet.js" 2>/dev/null || echo absent)" >> "$REPO/calls.log"
grep -q 'hello v2' "$REPO/packages/shared/dist/greet.js" 2>/dev/null
EOF
  chmod +x "$STUB_DIR/npx"
}

@test "K1: red / green の両方でテストの前にその時点のソースからビルドが走り red→green が成立する(AC-3)" {
  make_pnpm_workspace_pair
  [ ! -e "$REPO/packages/shared/dist" ]

  PATH="$STUB_DIR:$PATH" run bash "$RGV" "$REPO" "packages/backend/greet.test.mjs" "packages/shared/src/greet.js"
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -r '.results[0].red')" = "true" ]
  [ "$(printf '%s' "$output" | jq -r '.results[0].green')" = "true" ]
  # red: impl 退避後(v1)をビルド → test / green: 復元後(v2)をビルド → test の順
  [ "$(sed -n 1p "$REPO/calls.log")" = "pnpm --filter @fx/shared... run build src=hello v1" ]
  [ "$(sed -n 2p "$REPO/calls.log")" = "test packages/backend/greet.test.mjs dist=hello v1" ]
  [ "$(sed -n 3p "$REPO/calls.log")" = "pnpm --filter @fx/shared... run build src=hello v2" ]
  [ "$(sed -n 4p "$REPO/calls.log")" = "test packages/backend/greet.test.mjs dist=hello v2" ]
  [ "$(wc -l < "$REPO/calls.log" | tr -d ' ')" -eq 4 ]
}

@test "K2: ビルドが失敗したらテストを実行せず、reason にビルド失敗と対象パッケージ名が残る(AC-4)" {
  make_pnpm_workspace_pair
  printf '#!/usr/bin/env bash\nexit 1\n' > "$STUB_DIR/pnpm"

  PATH="$STUB_DIR:$PATH" run bash "$RGV" "$REPO" "packages/backend/greet.test.mjs" "packages/shared/src/greet.js"
  [ "$status" -eq 2 ]
  [ "$(printf '%s' "$output" | jq -r '.results[0].red')" = "false" ]
  [ "$(printf '%s' "$output" | jq -r '.results[0].green')" = "false" ]
  [ "$(printf '%s' "$output" | jq -r '.results[0].reason')" = "workspace build failed: @fx/shared (red)" ]
  ! grep -q '^test ' "$REPO/calls.log" 2>/dev/null
  # 判定後も impl は worktree に復元されている
  grep -q 'hello v2' "$REPO/packages/shared/src/greet.js"
}

@test "K3: ビルド対象の無い repo ではビルドせず判定も変わらない(AC-5)" {
  echo "export const ok = true;" > "$REPO/impl.mjs"
  make_test
  STUB_DIR="$REPO/.stubbin"
  mkdir -p "$STUB_DIR"
  printf '#!/usr/bin/env bash\necho called >> "%s/pnpm.log"\n' "$REPO" > "$STUB_DIR/pnpm"
  chmod +x "$STUB_DIR/pnpm"

  PATH="$STUB_DIR:$PATH" run bash "$RGV" "$REPO" "feature.test.mjs" "impl.mjs"
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -r '.results[0].red and .results[0].green')" = "true" ]
  [ "$(printf '%s' "$output" | jq -r '.results[0].reason')" = "ok" ]
  [ ! -e "$REPO/pnpm.log" ]
}

# -----------------------------------------------------------------------
# L: テストの起動の形は Setup が解決したコマンドファイルと base の tree で決まる(issue #1279)。言語・framework ごとの
# 判定は持たない。runner は PATH 上の stub か base に commit した tests/run-*.sh で、impl があるときだけ pass する。
# -----------------------------------------------------------------------

# make_stub_runner <name> <impl の REPO 相対パス>: PATH 上(mockbin/)のランナー。argv を "<name> <argv>" で calls.log に残す
make_stub_runner() {
  mkdir -p "$REPO/mockbin"
  printf '#!/usr/bin/env bash\necho "%s $*" >> "%s/calls.log"\n[ -f "%s/%s" ]\n' "$1" "$REPO" "$REPO" "$2" > "$REPO/mockbin/$1"
  chmod +x "$REPO/mockbin/$1"
}

# use_runners <impl の REPO 相対パス>: tests/run-unit.sh を base に commit し、コマンドファイルを source "runners" にする。
# script は DEVFLOW_TEST_FILES の一覧の中身を calls.log に残し、impl があるときだけ pass する
use_runners() {
  mkdir -p "$REPO/tests"
  printf '#!/usr/bin/env bash\necho "run-unit $(tr "\\n" " " < "$DEVFLOW_TEST_FILES")" >> "%s/calls.log"\n[ -f "%s/%s" ]\n' "$REPO" "$REPO" "$1" > "$REPO/tests/run-unit.sh"
  chmod +x "$REPO/tests/run-unit.sh"
  git -C "$REPO" add tests/run-unit.sh && git -C "$REPO" commit -q -m "add runner"
  jq -nc '{source: "runners", status: "resolved", full_command: null, files_command: null, sources: ["tests/run-unit.sh"]}' > "$COMMANDS_FILE"
}

@test "L1: 言語別の判定に当たらない repo(pytest 設定の無い tests/test_demo.py)でも files_command で red→green 判定する" {
  use_commands 'uv run pytest {files}'
  mkdir -p "$REPO/tests"
  echo "OK = True" > "$REPO/demo.py"
  echo "from demo import OK" > "$REPO/tests/test_demo.py"
  echo "from demo import OK" > "$REPO/tests/test_more.py"
  make_stub_runner uv demo.py

  run env PATH="$REPO/mockbin:$PATH" bash "$RGV" "$REPO" "tests/test_demo.py,tests/test_more.py" "demo.py"
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -c '.results[0] | {red, green, reason}')" = '{"red":true,"green":true,"reason":"ok"}' ]
  # {files} の語がペアの test_files に置き換わり、red(impl 退避中)と green(復元後)の 2 回実行される
  [ "$(cat "$REPO/calls.log")" = "$(printf 'uv run pytest tests/test_demo.py tests/test_more.py\nuv run pytest tests/test_demo.py tests/test_more.py')" ]
  grep -q "OK = True" "$REPO/demo.py"
}

@test "L2: 何も実行せず常に exit 0 を返す files_command は red:false で実証が成立しない" {
  use_commands 'true {files}'
  echo "export const ok = true;" > "$REPO/impl.mjs"
  make_test

  run bash "$RGV" "$REPO" "feature.test.mjs" "impl.mjs"
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -c '.results[0] | {red, green}')" = '{"red":false,"green":true}' ]
  grep -q "true" "$REPO/impl.mjs"
}

@test "L3: 解決元が tests/run-*.sh のときは base の script に DEVFLOW_TEST_FILES を渡して red→green 判定する" {
  use_runners impl.mjs
  echo "export const ok = true;" > "$REPO/impl.mjs"
  make_test

  run bash "$RGV" "$REPO" "feature.test.mjs" "impl.mjs"
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -c '.results[0] | {red, green, reason, testcmd_ran}')" = '{"red":true,"green":true,"reason":"ok","testcmd_ran":false}' ]
  [ "$(cat "$REPO/calls.log")" = "$(printf 'run-unit feature.test.mjs \nrun-unit feature.test.mjs ')" ]
}

@test "L4: 実行する tests/run-*.sh が base から変更されていれば入力エラー(reason に script のパス)で実行しない" {
  use_runners impl.mjs
  echo "export const ok = true;" > "$REPO/impl.mjs"
  make_test
  printf '#!/usr/bin/env bash\necho forged >> "%s/calls.log"\n[ -f "%s/impl.mjs" ]\n' "$REPO" "$REPO" > "$REPO/tests/run-unit.sh"

  run bash "$RGV" "$REPO" "feature.test.mjs" "impl.mjs"
  [ "$status" -eq 2 ]
  [ "$(printf '%s' "$output" | jq -c '.results[0]')" = '{"index":0,"red":false,"green":false,"reason":"test runner script changed vs base: tests/run-unit.sh"}' ]
  [ ! -f "$REPO/calls.log" ]
  [ -f "$REPO/impl.mjs" ]

  # --base の merge-base から変更された(commit 済みの)script も同じ
  git -C "$REPO" branch base-ref
  git -C "$REPO" add -A && git -C "$REPO" commit -q -m "pr commit"
  run bash "$RGV" --base base-ref "$REPO" "feature.test.mjs" "impl.mjs"
  [ "$status" -eq 2 ]
  [ "$(printf '%s' "$output" | jq -r '.results[0].reason')" = "test runner script changed vs base: tests/run-unit.sh" ]
  [ ! -f "$REPO/calls.log" ]
}

@test "L5: base に無い tests/run-*.sh を PR が足していれば入力エラー(reason に script のパス)で実行しない" {
  use_runners impl.mjs
  echo "export const ok = true;" > "$REPO/impl.mjs"
  make_test
  printf '#!/usr/bin/env bash\n[ -f "%s/impl.mjs" ]\n' "$REPO" > "$REPO/tests/run-added.sh"
  chmod +x "$REPO/tests/run-added.sh"

  run bash "$RGV" "$REPO" "feature.test.mjs" "impl.mjs"
  [ "$status" -eq 2 ]
  [ "$(printf '%s' "$output" | jq -c '.results[0]')" = '{"index":0,"red":false,"green":false,"reason":"test runner script not in base: tests/run-added.sh"}' ]
  [ ! -f "$REPO/calls.log" ]
  [ -f "$REPO/impl.mjs" ]
}

@test "L5b: files_command が委譲する package.json の scripts・名指す script が base から変われば入力エラーで実行しない" {
  use_commands 'npm test -- {files}'
  echo "export const ok = true;" > "$REPO/impl.mjs"
  make_test
  make_stub_runner npm impl.mjs

  # scripts が base と同じなら実行する(依存だけの変更は委譲先を変えない)
  echo '{"scripts":{"test":"node --test"},"devDependencies":{"x":"1"}}' > "$REPO/package.json"
  run env PATH="$REPO/mockbin:$PATH" bash "$RGV" "$REPO" "feature.test.mjs" "impl.mjs"
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -c '.results[0] | {red, green, reason}')" = '{"red":true,"green":true,"reason":"ok"}' ]
  rm "$REPO/calls.log"

  # PR が test の script を差し替える(impl の有無だけで終了コードを決める)
  echo '{"scripts":{"test":"node -e \"process.exit(require(\"fs\").existsSync(\"impl.mjs\")?0:1)\""}}' > "$REPO/package.json"
  run env PATH="$REPO/mockbin:$PATH" bash "$RGV" "$REPO" "feature.test.mjs" "impl.mjs"
  [ "$status" -eq 2 ]
  [ "$(printf '%s' "$output" | jq -c '.results[0]')" = '{"index":0,"red":false,"green":false,"reason":"test command script changed vs base: package.json (scripts)"}' ]
  [ ! -f "$REPO/calls.log" ]

  # workspace の package に script を足す(--filter で委譲できる)
  git -C "$REPO" checkout -q -- package.json
  mkdir -p "$REPO/packages/a"
  echo '{"scripts":{"test":"true"}}' > "$REPO/packages/a/package.json"
  run env PATH="$REPO/mockbin:$PATH" bash "$RGV" "$REPO" "feature.test.mjs" "impl.mjs"
  [ "$status" -eq 2 ]
  [ "$(printf '%s' "$output" | jq -r '.results[0].reason')" = "test command script changed vs base: packages/a/package.json (scripts)" ]
  [ ! -f "$REPO/calls.log" ]
  rm -r "$REPO/packages"

  # コマンドが名指す repo の script
  mkdir -p "$REPO/scripts"
  printf '#!/usr/bin/env bash\n[ -f "%s/impl.mjs" ]\n' "$REPO" > "$REPO/scripts/test.sh"
  git -C "$REPO" add scripts/test.sh && git -C "$REPO" commit -q -m "test script"
  use_commands 'bash scripts/test.sh {files}'
  echo 'exit 0' >> "$REPO/scripts/test.sh"
  run bash "$RGV" "$REPO" "feature.test.mjs" "impl.mjs"
  [ "$status" -eq 2 ]
  [ "$(printf '%s' "$output" | jq -r '.results[0].reason')" = "test command file changed vs base: scripts/test.sh" ]
  [ -f "$REPO/impl.mjs" ]
}

@test "L5c: files_command が名指す未追跡のローカル実行ファイル(.venv/bin 等)は照合せずに実行する" {
  echo "export const ok = true;" > "$REPO/impl.mjs"
  make_test
  mkdir -p "$REPO/.venv/bin"
  printf '#!/usr/bin/env bash\necho "pytest $*" >> "%s/calls.log"\n[ -f "%s/impl.mjs" ]\n' "$REPO" "$REPO" > "$REPO/.venv/bin/pytest"
  chmod +x "$REPO/.venv/bin/pytest"
  use_commands '.venv/bin/pytest {files}'

  run bash "$RGV" "$REPO" "feature.test.mjs" "impl.mjs"
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -c '.results[0] | {red, green, reason}')" = '{"red":true,"green":true,"reason":"ok"}' ]
  [ -f "$REPO/calls.log" ]

  # 同じパスでも PR が追跡に足したものは照合して入力エラー
  rm "$REPO/calls.log"
  git -C "$REPO" add -f .venv/bin/pytest
  run bash "$RGV" "$REPO" "feature.test.mjs" "impl.mjs"
  [ "$status" -eq 2 ]
  [ "$(printf '%s' "$output" | jq -r '.results[0].reason')" = "test command file changed vs base: .venv/bin/pytest" ]
  [ ! -f "$REPO/calls.log" ]
}

@test "L6: コマンドファイルが無い・unresolved のときは全ペアが入力エラーで exit 2、テストを実行しない" {
  echo "export const a = 1;" > "$REPO/impl1.mjs"
  echo "export const b = 2;" > "$REPO/impl2.mjs"
  echo "// t1" > "$REPO/t1.test.mjs"
  echo "// t2" > "$REPO/t2.test.mjs"
  make_stub_runner node impl1.mjs
  local want='["test command unresolved (コマンドファイルが無い)","test command unresolved (コマンドファイルが無い)"]'

  # --commands を渡さない
  run env COMMANDS_FILE= PATH="$REPO/mockbin:$PATH" bash "$RGV" "$REPO" "t1.test.mjs" "impl1.mjs" "t2.test.mjs" "impl2.mjs"
  [ "$status" -eq 2 ]
  [ "$(printf '%s' "$output" | jq -c '[.results[] | select(.red == false and .green == false) | .reason]')" = "$want" ]

  # --commands のパスにファイルが無い(resolver が解決できずコマンドファイルを書かなかった run)
  run env COMMANDS_FILE="$BATS_TEST_TMPDIR/missing.json" PATH="$REPO/mockbin:$PATH" bash "$RGV" "$REPO" "t1.test.mjs" "impl1.mjs" "t2.test.mjs" "impl2.mjs"
  [ "$status" -eq 2 ]
  [ "$(printf '%s' "$output" | jq -c '[.results[] | select(.red == false and .green == false) | .reason]')" = "$want" ]

  # status "unresolved"
  jq -nc '{source: "resolver", status: "unresolved", full_command: null, files_command: null, sources: []}' > "$COMMANDS_FILE"
  run env PATH="$REPO/mockbin:$PATH" bash "$RGV" "$REPO" "t1.test.mjs" "impl1.mjs" "t2.test.mjs" "impl2.mjs"
  [ "$status" -eq 2 ]
  [ "$(printf '%s' "$output" | jq -c '[.results[] | select(.red == false and .green == false) | .reason]')" \
    = '["test command unresolved (status unresolved)","test command unresolved (status unresolved)"]' ]

  # {files} の語が無い files_command は、テストファイルを渡せないので実行しない
  use_commands 'node --test'
  run env PATH="$REPO/mockbin:$PATH" bash "$RGV" "$REPO" "t1.test.mjs" "impl1.mjs"
  [ "$status" -eq 2 ]
  [ "$(printf '%s' "$output" | jq -r '.results[0].reason')" = "test command unresolved (files_command に {files} の語がちょうど 1 つ無い)" ]

  [ ! -f "$REPO/calls.log" ]
  [ -f "$REPO/impl1.mjs" ] && [ -f "$REPO/impl2.mjs" ]
}
