#!/usr/bin/env bats
# redgreen-verify.sh: impl を退避して test が red→green に転じるか判定する。
# untracked 新規ファイル・tracked-modified ファイルの両シナリオをカバーする。
# 共有 stash スタックに触れない不変条件(G1/G2/G6)も pin する。

setup() {
  SCRIPT="$BATS_TEST_DIRNAME/redgreen-verify.sh"
  REPO="$(mktemp -d)"
  cd "$REPO"
  git init -q && git config user.email t@t && git config user.name t
  # base commit(G1/G2 の事前 stash 素材にも使う .gitkeep を含める)。ランナーは repo の設定から判定されるので、
  # 既定の fixture は scripts.test が node --test の JS repo にする(*.test.mjs → node --test)
  echo "# placeholder" > .gitkeep
  echo '{"scripts":{"test":"node --test"}}' > package.json
  git add .gitkeep package.json && git commit -q -m base
}

# fixture の package.json を差し替えて commit する(JS ランナーの判定元)
use_package_json() {
  echo "$1" > "$REPO/package.json"
  git -C "$REPO" add package.json && git -C "$REPO" commit -q -m "package.json"
}
teardown() { rm -rf "$REPO"; }

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

  run bash "$SCRIPT" "$REPO" "feature.test.mjs" "impl.mjs"
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

  run bash "$SCRIPT" "$REPO" "feature.test.mjs" "impl.mjs"
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

  run bash "$SCRIPT" "$REPO" "feature.test.mjs" "nonexistent.mjs"
  [ "$status" -eq 2 ]
  [[ "$output" == *'impl file not found'* ]]
}

# -----------------------------------------------------------------------
# 既存バリデーション
# -----------------------------------------------------------------------
@test "非 test ファイル申告は exit 2(昇格拒否)" {
  echo "export const ok = true;" > "$REPO/impl.mjs"
  run bash "$SCRIPT" "$REPO" "impl.mjs" "impl.mjs"
  [ "$status" -eq 2 ]
  [[ "$output" == *'non-test file'* ]]
}

@test "test と impl が同一ファイル(混在)は exit 2" {
  make_test
  run bash "$SCRIPT" "$REPO" "feature.test.mjs" "feature.test.mjs"
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

  run bash "$SCRIPT" "$REPO" "feature.test.mjs" "a/mod.mjs,b/mod.mjs"
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

  run bash "$SCRIPT" "$REPO" "feature.test.mjs" "first.mjs,second.mjs"
  [ "$status" -eq 2 ]
  [[ "$output" == *'impl file not found'* ]]

  # first.mjs が削除されずに残っている(消失しない)
  [ -f "$REPO/first.mjs" ]
  grep -q "true" "$REPO/first.mjs"
}

# -----------------------------------------------------------------------
# F: vdelta 経路(issue #881)。package.json の dependencies / devDependencies に vdelta があり、ランナーが
# vitest のときだけ vitest コマンドを `<PM の exec> vdelta run --report json --` で包み、green 後の
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

# vdelta と vitest を devDependencies に持つ repo + impl.ts / feature.test.ts
use_vdelta_vitest() {
  use_package_json '{"devDependencies":{"vitest":"^3.0.0","vdelta":"^0.10.0"}}'
  echo "export const ok = true;" > "$REPO/impl.ts"
  echo "// feature test" > "$REPO/feature.test.ts"
}

@test "F1: devDependencies に vdelta がある vitest の repo は vdelta run 経由で実行し verdict を載せる(PM の exec で起動)" {
  use_vdelta_vitest
  make_mock_pm npx '{"comparability":"exact","verdict":"improved"}'

  run env PATH="$REPO/mockbin:$PATH" bash "$SCRIPT" "$REPO" "feature.test.ts" "impl.ts"
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

  # pnpm-lock.yaml のある repo(vdelta は dependencies)では pnpm exec で包み、compare も pnpm exec で起動する
  rm "$REPO/calls.log"
  use_package_json '{"dependencies":{"vdelta":"^0.10.0"},"devDependencies":{"vitest":"^3.0.0"}}'
  : > "$REPO/pnpm-lock.yaml"
  make_mock_pm pnpm '{"comparability":"exact"}'
  run env PATH="$REPO/mockbin:$PATH" bash "$SCRIPT" "$REPO" "feature.test.ts" "impl.ts"
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
  run env PATH="$REPO/mockbin:$PATH" bash "$SCRIPT" "$REPO" "feature.test.ts" "impl.ts"
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -r '.results[0].red and .results[0].green')" = "true" ]
  [ "$(printf '%s' "$output" | jq -r '.results[0] | has("verdict")')" = "false" ]

  make_mock_pm npx 'not-json'
  run env PATH="$REPO/mockbin:$PATH" bash "$SCRIPT" "$REPO" "feature.test.ts" "impl.ts"
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -r '.results[0].red and .results[0].green')" = "true" ]
  [ "$(printf '%s' "$output" | jq -r '.results[0] | has("verdict")')" = "false" ]
  grep -q 'vdelta compare' "$REPO/calls.log"
}

@test "F3: vdelta が依存に無い vitest の repo は素の vitest で実行し vdelta を呼ばず verdict を載せない" {
  use_package_json '{"devDependencies":{"vitest":"^3.0.0"}}'
  echo "export const ok = true;" > "$REPO/impl.ts"
  echo "// feature test" > "$REPO/feature.test.ts"
  make_mock_pm npx '{"comparability":"exact"}'

  run env PATH="$REPO/mockbin:$PATH" bash "$SCRIPT" "$REPO" "feature.test.ts" "impl.ts"
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -r '.results[0].red and .results[0].green')" = "true" ]
  [ "$(printf '%s' "$output" | jq -r '.results[0] | has("verdict")')" = "false" ]
  [ "$(printf '%s' "$output" | jq -r '.results[0].testcmd_ran')" = "false" ]
  [ "$(cat "$REPO/calls.log")" = "$(printf '%s\n' 'npx vitest run feature.test.ts' 'npx vitest run feature.test.ts')" ]
}

@test "F4: vdelta が依存にあっても vitest 以外のランナー(jest)は素のランナーで実行し vdelta を呼ばず verdict を載せない" {
  use_package_json '{"devDependencies":{"jest":"^29.0.0","vdelta":"^0.10.0"}}'
  echo "export const ok = true;" > "$REPO/impl.ts"
  echo "// feature test" > "$REPO/feature.test.ts"
  make_mock_pm npx '{"comparability":"exact"}'

  run env PATH="$REPO/mockbin:$PATH" bash "$SCRIPT" "$REPO" "feature.test.ts" "impl.ts"
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -r '.results[0].red and .results[0].green')" = "true" ]
  [ "$(printf '%s' "$output" | jq -r '.results[0] | has("verdict")')" = "false" ]
  [ "$(printf '%s' "$output" | jq -r '.results[0].testcmd_ran')" = "false" ]
  [ "$(cat "$REPO/calls.log")" = "$(printf '%s\n' 'npx jest feature.test.ts' 'npx jest feature.test.ts')" ]
}

@test "F5: vdelta + vitest の repo でも bats だけのペアは vdelta を呼ばず verdict を載せない" {
  use_vdelta_vitest
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

  run env PATH="$REPO/mockbin:$PATH" bash "$SCRIPT" "$REPO" "feature.bats" "impl.ts"
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -r '.results[0].red and .results[0].green')" = "true" ]
  [ "$(printf '%s' "$output" | jq -r '.results[0] | has("verdict")')" = "false" ]
  [ ! -f "$REPO/calls.log" ]
}

@test "F6: .claude/redgreen.conf を置いても読まれず結果も起動コマンドも変わらない" {
  use_vdelta_vitest
  make_mock_pm npx '{"comparability":"exact"}'
  run env PATH="$REPO/mockbin:$PATH" bash "$SCRIPT" "$REPO" "feature.test.ts" "impl.ts"
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
  run env PATH="$REPO/mockbin:$PATH" bash "$SCRIPT" "$REPO" "feature.test.ts" "impl.ts"
  [ "$status" -eq 0 ]
  [ "$output" = "$without_conf" ]
  [ "$(cat "$REPO/calls.log")" = "$calls_without_conf" ]
  [ ! -e "$REPO/conf-called" ]
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

  run bash "$SCRIPT" "$REPO" "feature.test.mjs" "impl.mjs"
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
  make_mock_pm npx '' impl.mjs
  before_status="$(git -C "$REPO" status --porcelain)"
  before_n="$(git -C "$REPO" stash list | wc -l | tr -d ' ')"
  before_sha="$(git -C "$REPO" rev-parse 'stash@{0}')"

  run env PATH="$REPO/mockbin:$PATH" bash "$SCRIPT" "$REPO" "feature.test.mjs" "impl.mjs"
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

  run bash "$SCRIPT" "$REPO" "feature.test.mjs" "impl.mjs,other.mjs"
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

  run bash "$SCRIPT" "$REPO" "feature.test.mjs" "impl.mjs"
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
  make_mock_pm npx '' impl.mjs

  run env PATH="$REPO/mockbin:$PATH" bash "$SCRIPT" "$REPO" "feature.test.mjs" "impl.mjs"
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

  run bash "$SCRIPT" "$REPO" "feature.test.mjs" "impl.mjs,gone.mjs"
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

  run bash "$SCRIPT" "$REPO" "feature.test.mjs" "impl.mjs"
  rm -f "$REPO/.git/index.lock"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"red":true'* ]]
  [[ "$output" == *'"green":true'* ]]
  [ "$(shasum "$REPO/.git/index")" = "$before_index" ]
  grep -q "true" "$REPO/impl.mjs"
  [ -x "$REPO/impl.mjs" ]
}

# -----------------------------------------------------------------------
# H: JS の runner は repo の設定(package.json / vitest.config.* / jest.config.* / playwright.config.*)から
# 判定する(issue #656 / #880)。判定した runner を lockfile の PM 経由(lockfile 無しは npx)で起動する。
# playwright.config.* がある repo の *.spec.ts はランナー未検出として exit 2。
# -----------------------------------------------------------------------

# npx の呼び出し argv を npx-calls.log に記録し、impl があるときだけ pass する stub
make_mock_npx() {
  local impl_name="${1:-impl.ts}"
  mkdir -p "$REPO/mockbin"
  cat > "$REPO/mockbin/npx" <<EOF
#!/usr/bin/env bash
echo "\$@" >> "$REPO/npx-calls.log"
[ -f "$REPO/$impl_name" ]
EOF
  chmod +x "$REPO/mockbin/npx"
}

@test "H1: vitest の repo の *.test.ts / *.test.tsx は vitest run で red→green 判定される" {
  use_package_json '{"devDependencies":{"vitest":"^3.0.0"}}'
  echo "export const ok = true;" > "$REPO/impl.ts"
  echo "// feature test" > "$REPO/feature.test.ts"
  echo "// component test" > "$REPO/Component.test.tsx"
  make_mock_npx

  run env PATH="$REPO/mockbin:$PATH" bash "$SCRIPT" "$REPO" "feature.test.ts,Component.test.tsx" "impl.ts"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"red":true'* ]]
  [[ "$output" == *'"green":true'* ]]
  [ -f "$REPO/npx-calls.log" ]
  [ "$(wc -l < "$REPO/npx-calls.log" | tr -d ' ')" -eq 2 ]
  [ "$(grep -c '^vitest run feature.test.ts Component.test.tsx$' "$REPO/npx-calls.log")" -eq 2 ]
  [ -f "$REPO/impl.ts" ]
  grep -q "true" "$REPO/impl.ts"
}

@test "H2: vitest の repo で .test.mjs / .test.ts は vitest 1 回、.bats は bats に振り分けられる" {
  use_package_json '{"devDependencies":{"vitest":"^3.0.0"}}'
  echo "export const ok = true;" > "$REPO/impl.mjs"
  make_test
  {
    printf '%s\n' '#!/usr/bin/env bats'
    printf '%s\n' '@test "impl exists" {'
    printf '  [ -f "%s/impl.mjs" ]\n' "$REPO"
    printf '%s\n' '}'
  } > "$REPO/feature.bats"
  echo "// feature test" > "$REPO/feature.test.ts"
  make_mock_npx impl.mjs

  run env PATH="$REPO/mockbin:$PATH" bash "$SCRIPT" "$REPO" "feature.test.mjs,feature.bats,feature.test.ts" "impl.mjs"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"red":true'* ]]
  [[ "$output" == *'"green":true'* ]]
  [ "$(wc -l < "$REPO/npx-calls.log" | tr -d ' ')" -eq 2 ]
  [ "$(grep -c '^vitest run feature.test.mjs feature.test.ts$' "$REPO/npx-calls.log")" -eq 2 ]
  ! grep -q ".bats" "$REPO/npx-calls.log"
}

@test "H3: playwright.config.* がある repo の *.spec.ts はランナー未検出で exit 2・runner 未実行" {
  use_package_json '{"devDependencies":{"vitest":"^3.0.0","@playwright/test":"^1.0.0"}}'
  echo "export default {};" > "$REPO/playwright.config.ts"
  git -C "$REPO" add playwright.config.ts && git -C "$REPO" commit -q -m playwright
  echo "export const ok = true;" > "$REPO/impl.ts"
  echo "// spec test" > "$REPO/feature.spec.ts"
  make_mock_npx

  run env PATH="$REPO/mockbin:$PATH" bash "$SCRIPT" "$REPO" "feature.spec.ts" "impl.ts"
  [ "$status" -eq 2 ]
  [ "$(printf '%s' "$output" | jq -r '.results[0].reason')" = "non-test file declared (ランナー未検出): feature.spec.ts" ]
  [ ! -f "$REPO/npx-calls.log" ]
}

@test "H7: jest の repo の *.test.ts は vitest ではなく jest で red→green 判定される(lockfile の PM で起動)" {
  use_package_json '{"devDependencies":{"jest":"^29.0.0"}}'
  echo "export const ok = true;" > "$REPO/impl.ts"
  echo "// feature test" > "$REPO/feature.test.ts"
  make_mock_npx

  run env PATH="$REPO/mockbin:$PATH" bash "$SCRIPT" "$REPO" "feature.test.ts" "impl.ts"
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -r '.results[0].red and .results[0].green')" = "true" ]
  [ "$(cat "$REPO/npx-calls.log")" = "$(printf 'jest feature.test.ts\njest feature.test.ts')" ]

  # pnpm-lock.yaml のある jest repo では pnpm exec jest で起動する
  rm "$REPO/npx-calls.log"
  : > "$REPO/pnpm-lock.yaml"
  printf '#!/usr/bin/env bash\necho "pnpm $*" >> "%s/pnpm-calls.log"\n[ -f "%s/impl.ts" ]\n' "$REPO" "$REPO" > "$REPO/mockbin/pnpm"
  chmod +x "$REPO/mockbin/pnpm"
  run env PATH="$REPO/mockbin:$PATH" bash "$SCRIPT" "$REPO" "feature.test.ts" "impl.ts"
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -r '.results[0].red and .results[0].green')" = "true" ]
  [ "$(grep -c '^pnpm exec jest feature.test.ts$' "$REPO/pnpm-calls.log")" -eq 2 ]
  [ ! -f "$REPO/npx-calls.log" ]
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
}

@test "I1: bats-only, untracked feature.bats は testcmd_ran:false と headdiff new:1 を出力する" {
  echo "export const ok = true;" > "$REPO/impl.mjs"
  make_feature_bats

  run bash "$SCRIPT" "$REPO" "feature.bats" "impl.mjs"
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

  run bash "$SCRIPT" "$REPO" "feature.bats" "impl.mjs"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"headdiff":{"new":0,"modified":1,"unchanged":0,"total":1}'* ]]
}

@test "I3: HEAD と同一内容の feature.bats は headdiff unchanged:1" {
  echo "export const ok = true;" > "$REPO/impl.mjs"
  make_feature_bats
  git -C "$REPO" add feature.bats && git -C "$REPO" commit -q -m "add feature.bats"

  run bash "$SCRIPT" "$REPO" "feature.bats" "impl.mjs"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"headdiff":{"new":0,"modified":0,"unchanged":1,"total":1}'* ]]
}

# vdelta run 経路が走った 1 ペアの testcmd_ran:true / headdiff なしは F1 が同じ実行で見る
@test "I5: vdelta run 経路に乗る test_files が bats と混在しても testcmd_ran:true で headdiff を出力しない" {
  use_package_json '{"devDependencies":{"vitest":"^3.0.0","vdelta":"^0.10.0"}}'
  echo "export const ok = true;" > "$REPO/impl.mjs"
  make_test
  make_feature_bats
  make_mock_pm npx '' impl.mjs

  run env PATH="$REPO/mockbin:$PATH" bash "$SCRIPT" "$REPO" "feature.test.mjs,feature.bats" "impl.mjs"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"testcmd_ran":true'* ]]
  [[ "$output" != *'"headdiff"'* ]]
}

@test "I6: node --test 直接経路も testcmd_ran:false と headdiff を出力する(拡張子非依存)" {
  echo "export const ok = true;" > "$REPO/impl.mjs"
  make_test

  run bash "$SCRIPT" "$REPO" "feature.test.mjs" "impl.mjs"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"testcmd_ran":false'* ]]
  [[ "$output" == *'"headdiff":{"new":1,"modified":0,"unchanged":0,"total":1}'* ]]
}

@test "I7: exit 2 経路(入力エラー)の出力は testcmd_ran を含まない(不変)" {
  echo "export const ok = true;" > "$REPO/impl.mjs"
  git -C "$REPO" add impl.mjs && git -C "$REPO" commit -q -m "add impl"
  make_test

  run bash "$SCRIPT" "$REPO" "feature.test.mjs" "impl.mjs"
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

# vitest の repo にし、impl1 / impl2 が worktree 版の内容(a = 1 / b = 2)で存在するかを呼び出しごとに記録する
# npx stub を mockbin に置く(`npx vitest run <test>` の末尾引数で振り分ける。ペア間の退避分離を検証する。
# tracked-modified の base 化はファイルが残るので内容で判定する)
make_mock_runner_pairs() {
  use_package_json '{"devDependencies":{"vitest":"^3.0.0"}}'
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

  run env PATH="$REPO/mockbin:$PATH" bash "$SCRIPT" "$REPO" "t1.test.mjs" "impl1.mjs" "t2.test.mjs" "impl2.mjs"
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

  run env PATH="$REPO/mockbin:$PATH" bash "$SCRIPT" "$REPO" "t1.test.mjs" "impl1.mjs" "t2.test.mjs" "impl2.mjs"
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

  # pair0 は non-test glob(impl1.mjs を test として申告)、pair1 は正常
  run env PATH="$REPO/mockbin:$PATH" bash "$SCRIPT" "$REPO" "impl1.mjs" "impl1.mjs" "t2.test.mjs" "impl2.mjs"
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -r '.results | length')" -eq 2 ]
  [ "$(printf '%s' "$output" | jq -r '.results[0].red or .results[0].green')" = "false" ]
  [ "$(printf '%s' "$output" | jq -r '.results[0].reason')" = "non-test file declared (ランナー未検出): impl1.mjs" ]
  [ "$(printf '%s' "$output" | jq -r '.results[0] | has("testcmd_ran")')" = "false" ]
  [ "$(printf '%s' "$output" | jq -r '.results[1].red and .results[1].green')" = "true" ]
  # pair0 の入力エラーで pair1 の判定が走っている(退避・復元も完了)
  [ "$(grep -c 't2.test.mjs' "$REPO/calls.log")" -eq 2 ]
  [ -f "$REPO/impl1.mjs" ] && [ -f "$REPO/impl2.mjs" ]
}

@test "J4: 全ペアが入力エラーなら exit 2 で配列は全要素 reason 付き" {
  echo "export const a = 1;" > "$REPO/impl1.mjs"
  echo "// t2" > "$REPO/t2.test.mjs"

  run bash "$SCRIPT" "$REPO" "impl1.mjs" "impl1.mjs" "t2.test.mjs" "nonexistent.mjs"
  [ "$status" -eq 2 ]
  [ "$(printf '%s' "$output" | jq -r '.results | length')" -eq 2 ]
  [ "$(printf '%s' "$output" | jq -r '.results[0].reason')" = "non-test file declared (ランナー未検出): impl1.mjs" ]
  [ "$(printf '%s' "$output" | jq -r '.results[1].reason')" = "impl file not found: nonexistent.mjs" ]
}

@test "J5: ペア引数が奇数(test_csv だけ余る)なら exit 2 で stdout は空配列" {
  echo "export const a = 1;" > "$REPO/impl1.mjs"
  echo "// t1" > "$REPO/t1.test.mjs"

  run bash "$SCRIPT" "$REPO" "t1.test.mjs" "impl1.mjs" "t2.test.mjs"
  [ "$status" -eq 2 ]
  # usage は stderr(run は stdout/stderr を混ぜる)。stdout 側の最終行が空配列であること
  [ "${lines[${#lines[@]}-1]}" = '{"results":[]}' ]
  [[ "$output" == *'usage: redgreen-verify.sh'* ]]
}

# 判定完了 exit 0 で配列が返る側は B のテストが同じ実行で見る
@test "J6: 1 ペア呼び出しの入力エラーも配列で返り exit 2" {
  echo "export const ok = true;" > "$REPO/impl.mjs"
  make_test

  run bash "$SCRIPT" "$REPO" "feature.test.mjs" "feature.test.mjs"
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

  run env PATH="$REPO/mockbin:$PATH" bash "$SCRIPT" "$REPO" "t1.test.mjs" "impl1.mjs" "t2.test.mjs" "impl2.mjs"
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

  run bash "$SCRIPT" --base base-ref "$REPO" "feature.test.mjs" "impl.mjs,extra.mjs"
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
  make_mock_pm npx '' impl.mjs

  run env PATH="$REPO/mockbin:$PATH" bash "$SCRIPT" --base no-such-ref "$REPO" "feature.test.mjs" "impl.mjs"
  [ "$status" -eq 2 ]
  [ "${lines[${#lines[@]}-1]}" = '{"results":[]}' ]
  [ ! -f "$REPO/calls.log" ]
  [ -f "$REPO/impl.mjs" ]
}

# -----------------------------------------------------------------------
# K: pnpm ワークスペースのビルド成果物(issue #754)
# packages/shared の exports は git 管理外の ./dist を指し、packages/backend が workspace:* で依存する。
# impl は shared のソース(base: v1 → worktree: v2)。テストランナー(root は vitest・lockfile 無しなので npx の stub)は
# dist の中身を calls.log に残し、dist が v2 のときだけ pass する。pnpm は stub(scripts.build を実行し呼び出し時点のソースを記録)。
# -----------------------------------------------------------------------
make_pnpm_workspace_pair() {
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

  PATH="$STUB_DIR:$PATH" run bash "$SCRIPT" "$REPO" "packages/backend/greet.test.mjs" "packages/shared/src/greet.js"
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

  PATH="$STUB_DIR:$PATH" run bash "$SCRIPT" "$REPO" "packages/backend/greet.test.mjs" "packages/shared/src/greet.js"
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

  PATH="$STUB_DIR:$PATH" run bash "$SCRIPT" "$REPO" "feature.test.mjs" "impl.mjs"
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -r '.results[0].red and .results[0].green')" = "true" ]
  [ "$(printf '%s' "$output" | jq -r '.results[0].reason')" = "ok" ]
  [ ! -e "$REPO/pnpm.log" ]
}

# -----------------------------------------------------------------------
# L: JS / bats 以外のランナー(issue #880 / #883)。repo の既存設定(pytest 設定 / go.mod / Cargo.toml /
# Gemfile.lock・bin/rails / composer.json)から detect-test-runner.sh が判定したコマンドで red→green を実行する。
# runner は PATH 上・repo 内(bin/rails / vendor/bin)の stub で、呼び出し argv を calls.log に記録し、
# impl があるときだけ pass する。
# -----------------------------------------------------------------------

# make_stub_at <stub の REPO 相対パス> <calls.log に残す名前> <impl の REPO 相対パス>
make_stub_at() {
  mkdir -p "$(dirname "$REPO/$1")"
  printf '#!/usr/bin/env bash\necho "%s $*" >> "%s/calls.log"\n[ -f "%s/%s" ]\n' "$2" "$REPO" "$REPO" "$3" > "$REPO/$1"
  chmod +x "$REPO/$1"
}

# make_stub_runner <name> <impl の REPO 相対パス>: PATH 上(mockbin/)のランナー
make_stub_runner() { make_stub_at "mockbin/$1" "$1" "$2"; }

@test "L1: pytest 設定のある repo の test_foo.py を pytest で red→green 判定する" {
  printf '[pytest]\n' > "$REPO/pytest.ini"
  git -C "$REPO" add pytest.ini && git -C "$REPO" commit -q -m pytest
  echo "OK = True" > "$REPO/foo.py"
  echo "from foo import OK" > "$REPO/test_foo.py"
  make_stub_runner pytest foo.py

  run env PATH="$REPO/mockbin:$PATH" bash "$SCRIPT" "$REPO" "test_foo.py" "foo.py"
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -r '.results[0].red and .results[0].green')" = "true" ]
  [ "$(cat "$REPO/calls.log")" = "$(printf 'pytest test_foo.py\npytest test_foo.py')" ]
  grep -q "OK = True" "$REPO/foo.py"
}

@test "L2: go.mod のある repo の foo_test.go をパッケージ単位の go test で red→green 判定する" {
  printf 'module example.com/fx\n' > "$REPO/go.mod"
  git -C "$REPO" add go.mod && git -C "$REPO" commit -q -m go
  mkdir -p "$REPO/pkg"
  echo "package pkg" > "$REPO/pkg/foo.go"
  echo "package pkg" > "$REPO/pkg/foo_test.go"
  make_stub_runner go pkg/foo.go

  run env PATH="$REPO/mockbin:$PATH" bash "$SCRIPT" "$REPO" "pkg/foo_test.go" "pkg/foo.go"
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -r '.results[0].red and .results[0].green')" = "true" ]
  [ "$(cat "$REPO/calls.log")" = "$(printf 'go test ./pkg\ngo test ./pkg')" ]
}

@test "L3: Cargo.toml のある repo の tests/foo.rs を cargo test --test foo で red→green 判定する" {
  printf '[package]\nname = "fx"\n' > "$REPO/Cargo.toml"
  git -C "$REPO" add Cargo.toml && git -C "$REPO" commit -q -m cargo
  mkdir -p "$REPO/src" "$REPO/tests"
  echo "pub fn ok() -> bool { true }" > "$REPO/src/lib.rs"
  echo "#[test] fn t() { assert!(fx::ok()); }" > "$REPO/tests/foo.rs"
  make_stub_runner cargo src/lib.rs

  run env PATH="$REPO/mockbin:$PATH" bash "$SCRIPT" "$REPO" "tests/foo.rs" "src/lib.rs"
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -r '.results[0].red and .results[0].green')" = "true" ]
  [ "$(cat "$REPO/calls.log")" = "$(printf 'cargo test --test foo\ncargo test --test foo')" ]
}

@test "L4: ランナー未検出のファイル(pytest 設定の無い repo の test_foo.py / Cargo の src/ 内)は拒否され runner を実行しない" {
  printf '[package]\nname = "fx"\n' > "$REPO/Cargo.toml"
  git -C "$REPO" add Cargo.toml && git -C "$REPO" commit -q -m cargo
  mkdir -p "$REPO/src"
  echo "pub fn ok() -> bool { true }" > "$REPO/src/lib.rs"
  echo "OK = True" > "$REPO/foo.py"
  echo "from foo import OK" > "$REPO/test_foo.py"
  make_stub_runner pytest foo.py
  make_stub_runner cargo src/lib.rs

  run env PATH="$REPO/mockbin:$PATH" bash "$SCRIPT" "$REPO" "test_foo.py" "foo.py" "src/lib.rs" "src/lib.rs"
  [ "$status" -eq 2 ]
  [ "$(printf '%s' "$output" | jq -r '[.results[] | .red or .green] | any')" = "false" ]
  [ "$(printf '%s' "$output" | jq -r '.results[0].reason')" = "non-test file declared (ランナー未検出): test_foo.py" ]
  [ "$(printf '%s' "$output" | jq -r '.results[1].reason')" = "non-test file declared (ランナー未検出): src/lib.rs" ]
  [ ! -f "$REPO/calls.log" ]
  grep -q "OK = True" "$REPO/foo.py"
}

@test "L5: Gemfile.lock に rspec-core のある repo の spec/foo_spec.rb を bundle exec rspec で red→green 判定する" {
  printf 'GEM\n  specs:\n    rspec-core (3.13.0)\n' > "$REPO/Gemfile.lock"
  git -C "$REPO" add Gemfile.lock && git -C "$REPO" commit -q -m rspec
  mkdir -p "$REPO/lib" "$REPO/spec"
  echo "OK = true" > "$REPO/lib/foo.rb"
  echo "require 'foo'" > "$REPO/spec/foo_spec.rb"
  make_stub_runner bundle lib/foo.rb

  run env PATH="$REPO/mockbin:$PATH" bash "$SCRIPT" "$REPO" "spec/foo_spec.rb" "lib/foo.rb"
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -r '.results[0].red and .results[0].green')" = "true" ]
  [ "$(cat "$REPO/calls.log")" = "$(printf 'bundle exec rspec spec/foo_spec.rb\nbundle exec rspec spec/foo_spec.rb')" ]
  grep -q "OK = true" "$REPO/lib/foo.rb"
}

@test "L6: bin/rails のある repo の test/foo_test.rb を bin/rails test で red→green 判定する" {
  make_stub_at bin/rails bin/rails app/models/foo.rb
  git -C "$REPO" add bin/rails && git -C "$REPO" commit -q -m rails
  mkdir -p "$REPO/app/models" "$REPO/test"
  echo "class Foo; end" > "$REPO/app/models/foo.rb"
  echo "require 'test_helper'" > "$REPO/test/foo_test.rb"

  run bash "$SCRIPT" "$REPO" "test/foo_test.rb" "app/models/foo.rb"
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -r '.results[0].red and .results[0].green')" = "true" ]
  [ "$(cat "$REPO/calls.log")" = "$(printf 'bin/rails test test/foo_test.rb\nbin/rails test test/foo_test.rb')" ]
}

@test "L7: composer.json に pestphp/pest のある repo の tests/Unit/FooTest.php を vendor/bin/pest で red→green 判定する" {
  echo '{"require-dev":{"pestphp/pest":"^3.0"}}' > "$REPO/composer.json"
  git -C "$REPO" add composer.json && git -C "$REPO" commit -q -m pest
  mkdir -p "$REPO/src" "$REPO/tests/Unit"
  echo "<?php class Foo {}" > "$REPO/src/Foo.php"
  echo "<?php test('foo', fn () => expect(new Foo)->toBeObject());" > "$REPO/tests/Unit/FooTest.php"
  make_stub_at vendor/bin/pest vendor/bin/pest src/Foo.php

  run bash "$SCRIPT" "$REPO" "tests/Unit/FooTest.php" "src/Foo.php"
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -r '.results[0].red and .results[0].green')" = "true" ]
  [ "$(cat "$REPO/calls.log")" = "$(printf 'vendor/bin/pest tests/Unit/FooTest.php\nvendor/bin/pest tests/Unit/FooTest.php')" ]
}

@test "L8: composer.json に phpunit/phpunit のある repo の tests/Unit/FooTest.php を vendor/bin/phpunit で red→green 判定する" {
  echo '{"require-dev":{"phpunit/phpunit":"^11.0"}}' > "$REPO/composer.json"
  git -C "$REPO" add composer.json && git -C "$REPO" commit -q -m phpunit
  mkdir -p "$REPO/src" "$REPO/tests/Unit"
  echo "<?php class Foo {}" > "$REPO/src/Foo.php"
  echo "<?php class FooTest extends PHPUnit\\Framework\\TestCase {}" > "$REPO/tests/Unit/FooTest.php"
  make_stub_at vendor/bin/phpunit vendor/bin/phpunit src/Foo.php

  run bash "$SCRIPT" "$REPO" "tests/Unit/FooTest.php" "src/Foo.php"
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -r '.results[0].red and .results[0].green')" = "true" ]
  [ "$(cat "$REPO/calls.log")" = "$(printf 'vendor/bin/phpunit tests/Unit/FooTest.php\nvendor/bin/phpunit tests/Unit/FooTest.php')" ]
}
