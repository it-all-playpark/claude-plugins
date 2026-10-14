#!/usr/bin/env bash
# subagent-dispatch-lint.sh
# Subagent Dispatch Rules 遵守を全 SKILL.md に対して検査する lint test。
#
# 検証項目:
#   1. docs/skill-creation-guide.md に "Subagent Dispatch Rules" セクションと必須5要素が含まれる
#   2. docs/skill-creation-guide.md に routing rule table が含まれる
#   3. _shared/references/subagent-dispatch.md が存在し必須5要素と routing table を含む
#   4. skill-creator/assets/skill-template.md に必須5要素と routing table が含まれる
#   5. **全 skill 走査**: `Task(` / `Agent(` / `subagent_type` を含む SKILL.md は
#      `## Subagent Dispatch Rules` セクションと必須5要素を含むこと
#
# Issue #42 で導入、Issue #63 で全 skill 走査化。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

fail_count=0
pass_count=0
violations=()

pass() { echo "  PASS: $1"; pass_count=$((pass_count + 1)); }
fail() { echo "  FAIL: $1"; fail_count=$((fail_count + 1)); }

check_file_contains() {
    local file="$1"
    local pattern="$2"
    local description="$3"
    if [[ ! -f "$file" ]]; then
        fail "$description (file not found: $file)"
        return
    fi
    if grep -q -- "$pattern" "$file"; then
        pass "$description"
    else
        fail "$description (pattern not found: $pattern)"
    fi
}

echo "=== Subagent Dispatch Lint ==="

# 1. docs/skill-creation-guide.md
GUIDE="$REPO_ROOT/docs/skill-creation-guide.md"
echo ""
echo "[1] docs/skill-creation-guide.md の必須要素"
check_file_contains "$GUIDE" "Subagent Dispatch Rules" "Subagent Dispatch Rules セクション存在"
check_file_contains "$GUIDE" "Objective" "必須要素: Objective"
check_file_contains "$GUIDE" "Output format" "必須要素: Output format"
check_file_contains "$GUIDE" "Tools" "必須要素: Tools"
check_file_contains "$GUIDE" "Boundary" "必須要素: Boundary"
check_file_contains "$GUIDE" "Token cap" "必須要素: Token cap"
check_file_contains "$GUIDE" "Routing Rule Table" "Routing Rule Table セクション存在"
check_file_contains "$GUIDE" "general-purpose" "routing table: general-purpose"
check_file_contains "$GUIDE" "code-reviewer" "routing table: code-reviewer"

# 2. _shared/references/subagent-dispatch.md
REF="$REPO_ROOT/plugins/playpark-core/_shared/references/subagent-dispatch.md"
echo ""
echo "[2] _shared/references/subagent-dispatch.md の必須要素"
check_file_contains "$REF" "必須5要素" "必須5要素セクション存在"
check_file_contains "$REF" "Objective" "Objective 記載"
check_file_contains "$REF" "Output format" "Output format 記載"
check_file_contains "$REF" "Tools" "Tools 記載"
check_file_contains "$REF" "Boundary" "Boundary 記載"
check_file_contains "$REF" "Token cap" "Token cap 記載"
check_file_contains "$REF" "Routing Rules" "Routing Rules セクション存在"
check_file_contains "$REF" "チェックリスト" "チェックリスト存在"

# 3. skill-creator/assets/skill-template.md
TEMPLATE="$REPO_ROOT/plugins/playpark-skills/skill-creator/assets/skill-template.md"
echo ""
echo "[3] skill-creator/assets/skill-template.md の必須要素"
check_file_contains "$TEMPLATE" "Subagent Dispatch Rules" "Subagent Dispatch Rules セクション存在"
check_file_contains "$TEMPLATE" "Objective" "必須要素: Objective"
check_file_contains "$TEMPLATE" "Output format" "必須要素: Output format"
check_file_contains "$TEMPLATE" "Tools" "必須要素: Tools"
check_file_contains "$TEMPLATE" "Boundary" "必須要素: Boundary"
check_file_contains "$TEMPLATE" "Token cap" "必須要素: Token cap"
check_file_contains "$TEMPLATE" "Routing" "Routing セクション存在"
check_file_contains "$TEMPLATE" "general-purpose" "routing table: general-purpose"
check_file_contains "$TEMPLATE" "code-reviewer" "routing table: code-reviewer"

# 4. 全 SKILL.md 走査: Task( / Agent( / subagent_type を含むものは
#    ## Subagent Dispatch Rules セクションと必須5要素を含むこと
echo ""
echo "[4] 全 SKILL.md 走査 (Task/Agent/subagent_type 使用スキル)"

# 除外: _shared / _lib / node_modules / .git など
# 対象は各 skill ディレクトリ直下の SKILL.md
mapfile -t ALL_SKILLS < <(
    find "$REPO_ROOT" \
        -type d \( -name node_modules -o -name .git -o -name _shared -o -name _lib -o -name skills-worktrees \) -prune \
        -o -type f -name 'SKILL.md' -print \
    | sort
)

total_scanned=0
total_dispatching=0

# 必須5要素（順不同、1ファイルにすべて登場すれば OK）
REQUIRED_ELEMENTS=("Objective" "Output format" "Tools" "Boundary" "Token cap")

for skill_md in "${ALL_SKILLS[@]}"; do
    rel_path="${skill_md#"$REPO_ROOT"/}"
    total_scanned=$((total_scanned + 1))

    # dispatch 使用を検出: Task(, Agent(, subagent_type のいずれか
    # コメントや文中の単語を除外するため、skill 側に実際の呼び出し構文があるかで判定
    if ! grep -qE '(Task\(|Agent\(|subagent_type)' "$skill_md"; then
        continue
    fi

    total_dispatching=$((total_dispatching + 1))

    missing_items=()

    # section header
    if ! grep -qE '^## Subagent Dispatch Rules' "$skill_md"; then
        missing_items+=("section:## Subagent Dispatch Rules")
    fi

    # 必須5要素（どこかに存在すればよい。既存 bug-hunt パターンに合わせる）
    for elem in "${REQUIRED_ELEMENTS[@]}"; do
        if ! grep -q -- "$elem" "$skill_md"; then
            missing_items+=("element:$elem")
        fi
    done

    if [[ ${#missing_items[@]} -gt 0 ]]; then
        fail "$rel_path (missing: ${missing_items[*]})"
        violations+=("$rel_path")
    else
        pass "$rel_path"
    fi
done

echo ""
echo "  Scanned: $total_scanned SKILL.md (dispatching: $total_dispatching)"

# Summary
echo ""
echo "=== Result ==="
echo "PASS: $pass_count"
echo "FAIL: $fail_count"

if [[ ${#violations[@]} -gt 0 ]]; then
    echo ""
    echo "=== Violations (Subagent Dispatch Rules 未遵守) ==="
    for v in "${violations[@]}"; do
        echo "  - $v"
    done
fi

if [[ $fail_count -gt 0 ]]; then
    exit 1
fi
exit 0
