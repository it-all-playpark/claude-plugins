#!/usr/bin/env bats
# mosh-paste.test.ts は claude plugin test でしか動かない（plugin の hooks module を engine に
# 読ませて回す）ので、run-all-bats.sh に載せるためにここから呼ぶ。

setup() {
    PLUGIN_DIR="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
}

@test "claude plugin test で mosh-paste.test.ts が全件 pass する" {
    command -v claude >/dev/null 2>&1 || skip "claude CLI not available"
    run claude plugin test "$PLUGIN_DIR"
    echo "$output"
    [ "$status" -eq 0 ]
    [[ "$output" == *"0 fail"* ]]
}

# 取得コマンド（paste.ts の FETCH）を、受け取ったリモートコマンドをそのまま zsh で
# 実行する偽 ssh に通し、空白・日本語・シングルクォートを含む名前でも同じバイト列が届き、
# 失敗時に書きかけのファイルが残らないことを確かめる。
@test "取得コマンドは空白・クォートを含むパスのバイナリをそのまま写し、失敗時は残骸を消す" {
    command -v zsh >/dev/null 2>&1 || skip "zsh not available"
    fetch="$(sed -n "/^const FETCH = \[/,/^\]/p" "$PLUGIN_DIR/hooks/paste.ts" | sed -n "s/^  '\(.*\)',$/\1/p" | paste -sd ' ' -)"
    [ -n "$fetch" ]

    mkdir -p "$BATS_TEST_TMPDIR/bin" "$BATS_TEST_TMPDIR/src"
    cat > "$BATS_TEST_TMPDIR/bin/ssh" <<'EOF'
#!/bin/sh
while [ $# -gt 0 ]; do
  case "$1" in -o) shift 2 ;; *) break ;; esac
done
shift
exec zsh -c "$*"
EOF
    chmod +x "$BATS_TEST_TMPDIR/bin/ssh"

    src="$BATS_TEST_TMPDIR/src/スクリーンショット 2026-10-14 10.23.45 it's.png"
    printf 'PNG\000\001\377data' > "$src"
    quoted="'$(printf %s "$src" | sed "s/'/'\\\\''/g")'"
    dest="$BATS_TEST_TMPDIR/out/copy.png"

    PATH="$BATS_TEST_TMPDIR/bin:$PATH" run /bin/sh -c "$fetch" mosh-paste host "$quoted" "$dest"
    [ "$status" -eq 0 ]
    cmp "$src" "$dest"
    [[ "$(ls -l "$dest")" == -rw-------* ]]

    PATH="$BATS_TEST_TMPDIR/bin:$PATH" run /bin/sh -c "$fetch" mosh-paste host "'/nonexistent/x.png'" "$BATS_TEST_TMPDIR/out/missing.png"
    [ "$status" -eq 1 ]
    [ ! -e "$BATS_TEST_TMPDIR/out/missing.png" ]
    [ -z "$(find "$BATS_TEST_TMPDIR/out" -name '.part.*')" ]
}

# 共有の場所に他ユーザーが置いた symlink を辿って書かないよう、保存先が symlink の
# ディレクトリなら取得せずに失敗する。
@test "取得コマンドは保存先ディレクトリが symlink なら書かずに失敗する" {
    fetch="$(sed -n "/^const FETCH = \[/,/^\]/p" "$PLUGIN_DIR/hooks/paste.ts" | sed -n "s/^  '\(.*\)',$/\1/p" | paste -sd ' ' -)"
    [ -n "$fetch" ]
    mkdir -p "$BATS_TEST_TMPDIR/bin" "$BATS_TEST_TMPDIR/elsewhere"
    printf '#!/bin/sh\necho fetched\n' > "$BATS_TEST_TMPDIR/bin/ssh"
    chmod +x "$BATS_TEST_TMPDIR/bin/ssh"
    ln -s "$BATS_TEST_TMPDIR/elsewhere" "$BATS_TEST_TMPDIR/planted"

    PATH="$BATS_TEST_TMPDIR/bin:$PATH" run /bin/sh -c "$fetch" mosh-paste host "'/x.png'" "$BATS_TEST_TMPDIR/planted/x.png"
    [ "$status" -eq 1 ]
    [[ "$output" == *"is not a directory owned by this user"* ]]
    [ -z "$(ls -A "$BATS_TEST_TMPDIR/elsewhere")" ]
}
