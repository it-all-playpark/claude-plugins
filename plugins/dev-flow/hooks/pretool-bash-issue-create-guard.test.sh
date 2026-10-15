#!/usr/bin/env bash
# Test suite for pretool-bash-issue-create-guard.sh
#
# Usage: bash pretool-bash-issue-create-guard.test.sh
#
# Exit 0 on all pass, non-zero otherwise.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="${SCRIPT_DIR}/pretool-bash-issue-create-guard.sh"

if [[ ! -x ${HOOK} ]]; then
  echo "FAIL: hook not executable: ${HOOK}" >&2
  exit 1
fi

PASS=0
FAIL=0
FAILURES=()

record() {
  local name="$1" ok="$2" detail="$3"
  if [[ $ok == 1 ]]; then
    PASS=$((PASS + 1))
    printf "  \033[32mPASS\033[0m %s\n" "$name"
  else
    FAIL=$((FAIL + 1))
    FAILURES+=("$name: $detail")
    printf "  \033[31mFAIL\033[0m %s\n" "$name"
  fi
}

# run_raw <name> <stdin> <expected: allow|deny>
# allow は「何も出力しない」、deny は permissionDecision=deny を期待する
run_raw() {
  local name="$1" input="$2" expected="$3"

  local output
  output=$(printf '%s' "$input" | bash "$HOOK" 2>&1 || true)

  local ok=0
  if [[ $expected == "allow" ]]; then
    [[ -z $output ]] && ok=1
  else
    [[ $(jq -r '.hookSpecificOutput.permissionDecision // empty' <<<"$output" 2>/dev/null) == "deny" ]] && ok=1
  fi
  record "$name" "$ok" "expected=$expected input=$input output=$output"
}

# run_case <name> <command> <expected: allow|deny>
run_case() {
  run_raw "$1" "$(jq -n --arg cmd "$2" '{tool_name:"Bash", tool_input:{command:$cmd}}')" "$3"
}

echo "=== pretool-bash-issue-create-guard tests ==="

echo "[AC-1 gh issue create / new を segment ごとに deny]"
run_case "gh issue create" 'gh issue create --title t --body b' "deny"
run_case "gh issue new" 'gh issue new --title t' "deny"
run_case "&& の後" 'git status && gh issue create -t x -b y' "deny"
run_case "|| の後" 'false || gh issue create -t x' "deny"
run_case "; の後" 'echo a; gh issue create -t x' "deny"
run_case "| の後" 'cat body.md | gh issue create -t x -F -' "deny"
run_case "改行の後" $'echo a\ngh issue create -t x' "deny"

echo "[AC-2 gh のオプション前置・環境変数前置・command / env]"
run_case "gh -R o/r issue create" 'gh -R o/r issue create -t x' "deny"
run_case "gh --repo o/r issue create" 'gh --repo o/r issue create -t x' "deny"
run_case "gh --repo=o/r issue new" 'gh --repo=o/r issue new' "deny"
run_case "gh issue -R o/r create" 'gh issue -R o/r create -t x' "deny"
run_case "GH_REPO=o/r gh issue create" 'GH_REPO=o/r gh issue create -t x' "deny"
run_case "command gh issue create" 'command gh issue create -t x' "deny"
run_case "env gh issue create" 'env gh issue create -t x' "deny"
run_case "env GH_REPO=o/r gh issue create" 'env GH_REPO=o/r gh issue create -t x' "deny"

echo "[AC-3 gh api .../issues にフィールドか POST]"
run_case "api -f" 'gh api repos/o/r/issues -f title=x' "deny"
run_case "api -F" 'gh api repos/o/r/issues -F title=x' "deny"
run_case "api --field" 'gh api repos/o/r/issues --field title=x' "deny"
run_case "api --raw-field" 'gh api repos/o/r/issues --raw-field title=x' "deny"
run_case "api --input" 'gh api repos/o/r/issues --input body.json' "deny"
run_case "api -X POST" 'gh api -X POST repos/o/r/issues' "deny"
run_case "api --method POST" 'gh api repos/o/r/issues --method POST' "deny"
run_case "api 先頭スラッシュ + 引用符" 'gh api "/repos/o/r/issues" -f "title=a b"' "deny"
run_case "api 値に空白を含むフィールドの後ろに endpoint" 'gh api -f "title=a b" repos/o/r/issues' "deny"
run_case "api 行継続" $'gh api repos/o/r/issues \\\n  -f title=x' "deny"

echo "[AC-4 gh api graphql で createIssue]"
run_case "graphql createIssue" "gh api graphql -f query='mutation { createIssue(input: {repositoryId: \"R\", title: \"t\"}) { issue { url } } }'" "deny"
run_case "graphql createIssue 複数行" $'gh api graphql -f query=\'\nmutation {\n  createIssue(input: {repositoryId: "R", title: "t"}) { issue { url } }\n}\'' "deny"

echo "[AC-5 deny の理由文]"
reason=$(jq -n --arg cmd 'gh issue create -t x' '{tool_name:"Bash", tool_input:{command:$cmd}}' | bash "$HOOK" | jq -r '.hookSpecificOutput.permissionDecisionReason')
ok=0
[[ $reason == *git-issue* && $reason == *軽い経路* && $reason == *'dev-flow に流さない issue'* && $reason == *'! gh issue create ...'* ]] && ok=1
record "理由文が orchestrator（軽い経路）と人間の ! gh issue create を案内する" "$ok" "reason=$reason"

echo "[AC-6 起票でない gh は通す]"
run_case "gh issue view" 'gh issue view 12' "allow"
run_case "gh issue list" 'gh issue list --label self-improve' "allow"
run_case "gh issue comment" 'gh issue comment 12 --body "gh issue create を使う"' "allow"
run_case "gh issue edit" 'gh issue edit 12 --body-file b.md' "allow"
run_case "gh issue close" 'gh -R o/r issue close 12' "allow"
run_case "api comments -f" 'gh api repos/o/r/issues/12/comments -f body=x' "allow"
run_case "api issues GET" 'gh api repos/o/r/issues' "allow"
run_case "api issues GET --jq" 'gh api repos/o/r/issues --jq ".[].number"' "allow"
run_case "graphql query" "gh api graphql -f query='query { repository(owner: \"o\", name: \"r\") { issues(first: 1) { nodes { number } } } }'" "allow"

echo "[AC-7 create_issue.py と、gh が先頭でない segment の引数]"
run_case "python3 create_issue.py" 'python3 /x/git-issue/scripts/create_issue.py --kind agent --labels self-improve --title t --body-file b.md' "allow"
run_case "rg \"gh issue create\"" 'rg "gh issue create" plugins' "allow"
run_case "echo gh issue create" 'echo gh issue create' "allow"
run_case "引用符内の区切りの後" 'rg "foo|gh issue create -R o/r" plugins' "allow"
run_case "commit message の行頭" $'git commit -m "feat: hook\n\ngh issue create を止める"' "allow"

echo "[入力が読めない・command が空・Bash 以外は無出力で通す]"
run_raw "stdin が JSON でない" 'not json' "allow"
run_raw "stdin が空" '' "allow"
run_case "command が空" '' "allow"
run_raw "tool_name=Edit" '{"tool_name":"Edit","tool_input":{"file_path":"f","new_string":"gh issue create"}}' "allow"

echo ""
echo "=== Results: ${PASS} passed, ${FAIL} failed ==="
if ((FAIL > 0)); then
  printf '\n'
  printf 'Failures:\n'
  for f in "${FAILURES[@]}"; do
    printf '  - %s\n' "$f"
  done
  exit 1
fi
exit 0
