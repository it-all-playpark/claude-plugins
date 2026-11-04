# security-reviewer-config.sh - security review を回す CLI の opt-in（"dev-flow".security_reviewer）を読む（source 専用。単体では実行しない）
# dev-flow-prerun（dev-flow/scripts/prerun.sh）と pr-iterate-prerun（pr-iterate-prerun.sh）が使い、値は pr-iterate-run の
# args.security_review.reviewer に渡る（nested・単体起動で同じ規則）。
#
# 読む場所と優先順は devflow-config.sh（user 設定の repo 別の節 → origin/<base> → user 設定。PR head は読まない —
# PR が gate の判定者を自分で選べないようにする）。どこにも無ければ "claude"。値の検証は workflow（dev-flow は _lib/prerun-setup.mjs、
# pr-iterate は parseSecurityReviewArg）が行い、out-of-enum は明示 error にする。

# shellcheck source=devflow-config.sh
source "$(dirname "${BASH_SOURCE[0]}")/devflow-config.sh"

# security_reviewer_config <root> <base_ref>
#   opt-in の値を JSON 値（既定は "claude"）で stdout に出す。<base_ref> が空なら user 設定だけを読む。
security_reviewer_config() {
    local v
    v="$(devflow_config "$1" "$2" security_reviewer)"
    if [[ "$v" == 'null' ]]; then
        printf '"claude"'
    else
        printf '%s' "$v"
    fi
}
