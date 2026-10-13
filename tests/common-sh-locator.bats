#!/usr/bin/env bats
# common-sh-locator.bats - Pins the cross-plugin _lib/common.sh resolution
# contract (issue #571).
#
# playpark-core ships the only copy of _lib/common.sh. Scripts in other
# plugins (dev-flow, playpark-skills) cannot reach it via a relative `../`
# path, because a plugin root is a version+hash-pinned cache path at
# install time - `../` cannot cross that boundary. They must instead
# locate playpark-core's bin/journal on PATH (which plugin install always
# puts there for a declared dependency - see plugin.json "dependencies")
# and derive _lib/common.sh from its location:
#
#   _CORE_BIN="$(command -v journal)" || { echo '...' >&2; exit 127; }
#   source "$(dirname "$_CORE_BIN")/../_lib/common.sh"
#
# Scripts that live inside playpark-core itself (only journal.sh today)
# keep the plain same-plugin relative source - they never need the
# locator because they can't be moved out from beside their own _lib/.
#
# This test is RED until the S2/S3 tasks apply the locator to every
# consuming script (S1 only performs the git mv reorganization).

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
    export PATH="$REPO_ROOT/plugins/playpark-core/bin:$REPO_ROOT/plugins/dev-flow/bin:$PATH"
}

@test "dev-flow / playpark-skills の common.sh 利用スクリプトは統一 locator を使う" {
    mapfile -t files < <(cd "$REPO_ROOT" && git ls-files 'plugins/dev-flow/*.sh' 'plugins/playpark-skills/*.sh' | while IFS= read -r f; do
        grep -qF 'common.sh' "$f" 2>/dev/null && echo "$f"
    done)

    [ "${#files[@]}" -gt 0 ]

    missing_locator=()
    wrong_form=()
    for f in "${files[@]}"; do
        full="$REPO_ROOT/$f"
        if ! grep -qF 'source "$(dirname "$_CORE_BIN")/../_lib/common.sh"' "$full"; then
            missing_locator+=("$f")
        fi
        if grep -qF '/../../_lib/common.sh' "$full"; then
            wrong_form+=("$f")
        fi
    done

    if [ "${#missing_locator[@]}" -gt 0 ]; then
        echo "locator missing in:"
        printf '  - %s\n' "${missing_locator[@]}"
    fi
    if [ "${#wrong_form[@]}" -gt 0 ]; then
        echo "cross-plugin ../../ form still present in:"
        printf '  - %s\n' "${wrong_form[@]}"
    fi

    [ "${#missing_locator[@]}" -eq 0 ]
    [ "${#wrong_form[@]}" -eq 0 ]
}

@test "playpark-core/journal/scripts/journal.sh は同一 plugin 相対 source を使い locator を含まない" {
    f="$REPO_ROOT/plugins/playpark-core/journal/scripts/journal.sh"
    [ -f "$f" ]
    run grep -qF '../../_lib/common.sh' "$f"
    [ "$status" -eq 0 ]
    run grep -qF '_CORE_BIN' "$f"
    [ "$status" -ne 0 ]
}

@test "機能透過: sns-announce/scripts/load-config.sh が locator 経由で成功する" {
    run bash "$REPO_ROOT/plugins/playpark-skills/sns-announce/scripts/load-config.sh"
    [ "$status" -eq 0 ]
}

@test "負の対照: playpark-core が PATH に無いと locator は 127 で fail-closed する" {
    run env PATH=/usr/bin:/bin bash "$REPO_ROOT/plugins/playpark-skills/sns-announce/scripts/load-config.sh"
    [ "$status" -eq 127 ]
    [[ "$output" == *"playpark-core"* ]]
}

# 例外は「plugin cache の playpark-core を version ワイルドカードで探す」行だけ
# （`../../../playpark-core/*/`）。hook の実行環境では plugin の bin/ が PATH に載らず
# locator（command -v journal）が使えないため、Stop hook はこの形でしか journal.sh に届かない。
# version を固定した ../ と違い、cache の hash が変わっても壊れない。
@test "plugins/*/bin/* と plugins/**/*.sh(_lib/infra/ 除く) に3段以上の ../../../ が無い" {
    mapfile -t offenders < <(cd "$REPO_ROOT" && git ls-files 'plugins/*/bin/*' 'plugins/**/*.sh' \
        | grep -v '/_lib/infra/' \
        | while IFS= read -r f; do
            grep -E '(\.\./){3,}' "$f" 2>/dev/null | grep -qvE '\.\./\.\./\.\./playpark-core/\*/' && echo "$f"
        done)
    if [ "${#offenders[@]}" -gt 0 ]; then
        echo "3+ level ../../../ found in:"
        printf '  - %s\n' "${offenders[@]}"
    fi
    [ "${#offenders[@]}" -eq 0 ]
}
