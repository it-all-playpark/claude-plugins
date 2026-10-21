#!/usr/bin/env bats
bats_require_minimum_version 1.5.0
# sandbox-tune.sh のテスト。合成した transcript（<projects>/<project>/<session>.jsonl）を集計させる。
# gh は PATH 先頭の偽物で置き換え、呼び出しを記録する。
bats_require_minimum_version 1.5.0

NOW="2026-10-01T00:00:00Z"

setup() {
  SCRIPT="$BATS_TEST_DIRNAME/sandbox-tune.sh"
  WORK="$BATS_TEST_TMPDIR"
  export TMPDIR="$WORK/tmp"
  export HOME="$WORK/home"
  P="$WORK/projects"
  mkdir -p "$TMPDIR" "$HOME" "$WORK/bin" "$P/proj-a"

  cat >"$WORK/bin/gh" <<'EOF'
#!/usr/bin/env bash
echo "$*" >>"$GH_LOG"
if [ "$1 $2" = "repo view" ]; then
  [ -z "${GH_VIEW_FAIL:-}" ] || exit 1
  echo "${GH_VISIBILITY:-PUBLIC}"
fi
EOF
  chmod +x "$WORK/bin/gh"
  export PATH="$WORK/bin:$PATH"
  export GH_LOG="$WORK/gh.log"
  : >"$GH_LOG"
}

# Bash の tool_use: <file> <sessionId> <timestamp> <tool_use_id> <command> [追加の JSON]
use() {
  local extra="${6:-}"
  [ -n "$extra" ] || extra='{}'
  mkdir -p "$(dirname "$P/$1")"
  jq -nc --arg s "$2" --arg t "$3" --arg id "$4" --arg c "$5" --argjson x "$extra" \
    '{type: "assistant", sessionId: $s, timestamp: $t, isSidechain: false, cwd: "/w/repo", uuid: ("u-" + $id),
      message: {id: ("m-" + $id), role: "assistant", content: [{type: "tool_use", id: $id, name: "Bash", input: {command: $c}}]}} + $x' >>"$P/$1"
}

# tool_result: <file> <sessionId> <timestamp> <tool_use_id> <出力> [追加の JSON]
result() {
  local extra="${6:-}"
  [ -n "$extra" ] || extra='{}'
  mkdir -p "$(dirname "$P/$1")"
  jq -nc --arg s "$2" --arg t "$3" --arg id "$4" --arg x "$5" --argjson e "$extra" \
    '{type: "user", sessionId: $s, timestamp: $t, isSidechain: false, cwd: "/w/repo", uuid: ("r-" + $id),
      message: {role: "user", content: [{type: "tool_result", tool_use_id: $id, content: $x, is_error: true}]}} + $e' >>"$P/$1"
}

# host-exec の tool_use: <file> <sessionId> <timestamp> <tool_use_id> <reason> <argv...>
hexec() {
  local f="$1" s="$2" t="$3" id="$4" reason="$5"
  shift 5
  # argv の `--x` を jq のオプションとして読ませないよう、JSON 配列にしてから渡す
  local argv
  argv="$(printf '%s\n' "$@" | jq -R . | jq -sc .)"
  jq -nc --arg s "$s" --arg t "$t" --arg id "$id" --arg r "$reason" --argjson a "$argv" \
    '{type: "assistant", sessionId: $s, timestamp: $t, isSidechain: false, cwd: "/w/repo", uuid: ("u-" + $id),
      message: {id: ("m-" + $id), role: "assistant", content: [{type: "tool_use", id: $id, name: "mcp__host-exec__run", input: {argv: $a, reason: $r}}]}}' >>"$P/$f"
}

# assistant の文: <file> <sessionId> <timestamp> <message id> <本文>
say() {
  jq -nc --arg s "$2" --arg t "$3" --arg id "$4" --arg x "$5" \
    '{type: "assistant", sessionId: $s, timestamp: $t, isSidechain: false, cwd: "/w/repo", uuid: ("u-" + $id + ($x | length | tostring)),
      message: {id: $id, role: "assistant", content: [{type: "text", text: $x}]}}' >>"$P/$1"
}

# 人間の文字列 content（`!` 実行の入出力など）: <file> <sessionId> <timestamp> <本文>
human() {
  jq -nc --arg s "$2" --arg t "$3" --arg x "$4" \
    '{type: "user", sessionId: $s, timestamp: $t, isSidechain: false, cwd: "/w/repo", uuid: ("h-" + $t), message: {role: "user", content: $x}}' >>"$P/$1"
}

violation() { printf 'curl: (56) CONNECT tunnel failed\n<sandbox_violations>\ndeny network-outbound %s:443 (host is not on the allow list)\n</sandbox_violations>' "$1"; }

collect() { bash "$SCRIPT" collect --projects-dir "$P" --now "$NOW" "$@"; }

ids() { jq -r '.types[] | "\(.id) \(.count) \(.sessions)"' | sort; }

# 3 系統の拒否を 1 件ずつ + 別 session の同じ拒否 + 期間外・subagent・sidechain の同じ拒否
fixture_basic() {
  local f=proj-a/s1.jsonl
  use $f S1 2026-09-10T00:00:00.000Z t1 'touch /etc/blocked'
  result $f S1 2026-09-10T00:00:01.000Z t1 'touch: /etc/blocked: Operation not permitted'
  use $f S1 2026-09-10T00:01:00.000Z t2 'curl -sS https://example.org'
  result $f S1 2026-09-10T00:01:01.000Z t2 "$(violation example.org)"
  use $f S1 2026-09-10T00:02:00.000Z t3 'pg-client status'
  result $f S1 2026-09-10T00:02:01.000Z t3 "cannot connect to socket at '/run/db/x.sock': Operation not permitted"
  use $f S1 2026-09-10T00:03:00.000Z t4 'git push origin main'
  result $f S1 2026-09-10T00:03:01.000Z t4 'Permission to use Bash with command git push origin main has been denied.' '{"toolDenialKind":"permission-rule"}'
  say $f S1 2026-09-10T00:04:00.000Z m1 $'sandbox 内からは認証できないので、通常のターミナルで実行してください:\n```bash\n# 認証\ngh auth login\n```'
  use $f S1 2026-09-20T00:00:00.000Z t5 'touch /etc/blocked'
  result $f S1 2026-09-20T00:00:01.000Z t5 'touch: /etc/blocked: Operation not permitted'
  # 期間外（--days 30 の外）
  use $f S1 2026-08-01T00:00:00.000Z t0 'touch /etc/blocked'
  result $f S1 2026-08-01T00:00:01.000Z t0 'touch: /etc/blocked: Operation not permitted'
  # sidechain の行
  use $f S1 2026-09-11T00:00:00.000Z t6 'touch /etc/blocked' '{"isSidechain":true}'
  result $f S1 2026-09-11T00:00:01.000Z t6 'touch: /etc/blocked: Operation not permitted' '{"isSidechain":true}'
  # 別 session
  use proj-a/s2.jsonl S2 2026-09-12T00:00:00.000Z t7 'touch /etc/blocked'
  result proj-a/s2.jsonl S2 2026-09-12T00:00:01.000Z t7 'touch: /etc/blocked: Operation not permitted'
  # subagent の transcript
  use proj-a/s1/subagents/agent-1.jsonl S1 2026-09-13T00:00:00.000Z t8 'touch /etc/blocked'
  result proj-a/s1/subagents/agent-1.jsonl S1 2026-09-13T00:00:01.000Z t8 'touch: /etc/blocked: Operation not permitted'
}

@test "collect: sandbox 拒否・人間への依頼・permission 拒否を型ごとに集計し、期間外・subagent・sidechain を除く" {
  fixture_basic
  run collect --days 30
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | ids)" = "permission:permission-rule:Bash git push 1 1
request:request:gh auth 1 1
sandbox:network:example.org 1 1
sandbox:path:/etc/blocked 3 2
sandbox:unix_socket:/run/db/x.sock 1 1" ]
  [ "$(printf '%s' "$output" | jq -c '.types[] | select(.id == "sandbox:path:/etc/blocked") | [.first_seen, .last_seen, .projects, .examples]')" \
    = '["2026-09-10T00:00:01Z","2026-09-20T00:00:01Z",["/w/repo"],["touch: /etc/blocked: Operation not permitted"]]' ]
  # 発生ごとに時刻・cwd・gitBranch（行に無ければ null）を持つ
  [ "$(printf '%s' "$output" | jq -c '.types[] | select(.id == "sandbox:path:/etc/blocked") | .occurrences[0]')" \
    = '{"ts":"2026-09-10T00:00:01Z","cwd":"/w/repo","git_branch":null}' ]
  [ "$(printf '%s' "$output" | jq -c '[.period.since, .period.until, .files_scanned]')" = '["2026-09-01T00:00:00Z","2026-10-01T00:00:00Z",2]' ]
}

@test "collect: --days で期間を変えると、その前の事象も数える" {
  fixture_basic
  run collect --days 90
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -r '.types[] | select(.id == "sandbox:path:/etc/blocked") | .count')" = 4 ]
}

@test "collect: grep の出力やファイル本文に拒否の文言が含まれていただけのものは数えない" {
  local f=proj-a/s1.jsonl
  use $f S1 2026-09-10T00:00:00Z g1 'rg -n "Operation not permitted" README.md'
  result $f S1 2026-09-10T00:00:01Z g1 $'README.md:12:touch: /x: Operation not permitted\nREADME.md:13:`<sandbox_violations>` に deny network-outbound が出る'
  use $f S1 2026-09-10T00:01:00Z g2 'cat docs/sandbox.md'
  result $f S1 2026-09-10T00:01:01Z g2 $'mkdir: cannot create directory \'/y\': Operation not permitted\n<sandbox_violations>\ndeny network-outbound docs.example:443\n</sandbox_violations> が出たら許可を足す'
  use $f S1 2026-09-10T00:02:00Z g3 'gh issue view 1 --json body'
  result $f S1 2026-09-10T00:02:01Z g3 '{"body":"- `/z: Operation not permitted` が出たら\n`kLSServerCommunicationErr` は open の失敗\nrequirePermission を使う"}'
  # 表示系コマンドでも、そのコマンド自身の診断行は数える
  use $f S1 2026-09-10T00:03:00Z g4 'grep -r token /secret/dir'
  result $f S1 2026-09-10T00:03:01Z g4 'grep: /secret/dir: Operation not permitted'
  run collect
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | ids)" = "sandbox:path:/secret/dir 1 1" ]
}

@test "collect: operation not permitted を含まず EPERM だけの診断行も sandbox の拒否として数える" {
  local f=proj-a/s1.jsonl
  use $f S1 2026-09-10T00:00:00Z e1 'npm install'
  result $f S1 2026-09-10T00:00:01Z e1 $'npm error code EPERM\nnpm error syscall mkdir'
  run collect
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | ids)" = "sandbox:command:npm install 1 1" ]
}

@test "collect: LaunchServices の拒否は 3 つの文言のどれか 1 つだけでも launch_services として数える" {
  local f=proj-a/s1.jsonl
  # 各出力は 1 文言だけを含む（他の 2 文言・operation not permitted・EPERM を含めない）
  use $f S1 2026-09-10T00:00:00Z l1 'open https://example.com'
  result $f S1 2026-09-10T00:00:01Z l1 'LSOpenURLsWithRole() failed with error -54 for the URL https://example.com.'
  use $f S1 2026-09-10T00:01:00Z l2 'code .'
  result $f S1 2026-09-10T00:01:01Z l2 'code: launching the app failed with error -10822'
  use $f S1 2026-09-10T00:02:00Z l3 'osascript -e beep'
  result $f S1 2026-09-10T00:02:01Z l3 'osascript: kLSServerCommunicationErr'
  run collect
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | ids)" = "sandbox:launch_services:code 1 1
sandbox:launch_services:open 1 1
sandbox:launch_services:osascript 1 1" ]
}

@test "collect: session 名が途中で変わった session も sessionId で 1 つと数える" {
  local f=proj-a/s1.jsonl
  echo '{"type":"summary","summary":"最初の名前","leafUuid":"x"}' >"$P/$f"
  use $f S1 2026-09-10T00:00:00Z n1 'touch /etc/blocked'
  result $f S1 2026-09-10T00:00:01Z n1 'touch: /etc/blocked: Operation not permitted'
  echo '{"type":"custom-title","customTitle":"付け替わった名前","sessionId":"S1"}' >>"$P/$f"
  # resume で別ファイルに続きが書かれても sessionId は同じ
  use proj-a/s1-resumed.jsonl S1 2026-09-11T00:00:00Z n2 'touch /etc/blocked'
  result proj-a/s1-resumed.jsonl S1 2026-09-11T00:00:01Z n2 'touch: /etc/blocked: Operation not permitted'
  run collect
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | ids)" = "sandbox:path:/etc/blocked 2 1" ]
}

@test "collect: 人間への依頼の文に含まれるコマンドやエラー文を、応答や拒否として二重に数えない" {
  local f=proj-a/s1.jsonl
  # 1 つの応答が複数行に分かれて記録される（同じ message id）
  say $f S1 2026-09-10T00:00:00Z m9 $'`touch /etc/blocked` が `touch: /etc/blocked: Operation not permitted` になるので、`! touch /etc/blocked` で実行してください。'
  say $f S1 2026-09-10T00:00:00Z m9 $'```\ntouch /etc/blocked\n```\nPermission to use Bash with command touch /etc/blocked has been denied. とは別です。'
  human $f S1 2026-09-10T00:01:00Z '<bash-input>touch /etc/blocked</bash-input>'
  human $f S1 2026-09-10T00:01:01Z '<bash-stdout></bash-stdout><bash-stderr>touch: /etc/blocked: Operation not permitted</bash-stderr>'
  human $f S1 2026-09-10T00:02:00Z 'Permission to use Bash with command touch /etc/blocked has been denied.'
  run collect
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | ids)" = "request:request:touch 1 1" ]
}

@test "collect: host-exec の実行を結末とコマンドで型にし、直前の Bash が拒否されていたかを数える" {
  local f=proj-a/s1.jsonl
  # Bash が sandbox に拒否された直後の host-exec
  use $f S1 2026-09-10T00:00:00Z b1 'git -C /w/dotfiles fetch origin'
  result $f S1 2026-09-10T00:00:01Z b1 'error: cannot open .git/FETCH_HEAD: Operation not permitted'
  hexec $f S1 2026-09-10T00:01:00Z h1 '分離中は dotfiles の git を書けない' git -C /w/dotfiles fetch origin
  result $f S1 2026-09-10T00:01:01Z h1 $'$ git -C /w/dotfiles fetch origin\nexit code: 0'
  # 間に成功した Bash を挟むと、次の host-exec は Bash を試さずに来たものとして数える
  use $f S1 2026-09-10T00:02:00Z b2 'ls'
  result $f S1 2026-09-10T00:02:01Z b2 'README.md'
  hexec $f S1 2026-09-10T00:03:00Z h2 'origin を更新する' git -c core.x=1 -C /w/other fetch
  result $f S1 2026-09-10T00:03:01Z h2 $'$ git -c core.x=1 -C /w/other fetch\nexit code: 0'
  # パスが違っても同じスクリプトは 1 つの型（repo の移動前後）
  hexec $f S1 2026-09-10T00:04:00Z h3 'launchctl は sandbox 内で動かない' bash /w/old/scripts/install.sh --uninstall
  result $f S1 2026-09-10T00:04:01Z h3 $'$ bash /w/old/scripts/install.sh --uninstall\nexit code: 0'
  hexec $f S1 2026-09-10T00:05:00Z h4 'launchctl は sandbox 内で動かない' bash /w/new/scripts/install.sh --install
  result $f S1 2026-09-10T00:05:01Z h4 'host-exec: the command ran (exit code 0), but its output was withheld because it contained: JWT.'
  # 拒否は permission-rule として記録されるが、permission の型にはしない
  hexec $f S1 2026-09-10T00:06:00Z h5 'PR を見る' gh pr view 1
  result $f S1 2026-09-10T00:06:01Z h5 '<tool_use_error>host-exec: the user declined to run this command.</tool_use_error>' '{"toolDenialKind":"permission-rule"}'
  hexec $f S1 2026-09-10T00:07:00Z h6 '消す' rm -rf /w/x
  result $f S1 2026-09-10T00:07:01Z h6 '<tool_use_error>host-exec: refused (再帰的な強制削除). Do not retry this command another way.</tool_use_error>' '{"toolDenialKind":"permission-rule"}'
  # worktree 分離ガードの拒否（toolDenialKind なしで記録される）も直前の拒否として数える
  use $f S1 2026-09-10T00:08:00Z b3 'git -C /w/dotfiles merge --ff-only origin/main'
  result $f S1 2026-09-10T00:08:01Z b3 'This session is isolated in the worktree /w/repo/.claude/worktrees/x, but this command redirects git to the shared checkout via -C. Refusing to run it.'
  hexec $f S1 2026-09-10T00:09:00Z h7 '分離中は dotfiles の git を書けない' git -C /w/dotfiles merge --ff-only origin/main
  result $f S1 2026-09-10T00:09:01Z h7 $'$ git -C /w/dotfiles merge --ff-only origin/main\nexit code: 0'
  # インラインのスクリプトは文字列が毎回違っても インタプリタ名＋フラグの 1 型
  hexec $f S1 2026-09-10T00:10:00Z h8 'launchctl は sandbox 内で動かない' bash -c 'cd /w/x && ./run.sh'
  result $f S1 2026-09-10T00:10:01Z h8 $'$ bash -c ...\nexit code: 0'
  hexec $f S1 2026-09-10T00:11:00Z h9 'launchctl は sandbox 内で動かない' bash -c 'launchctl list'
  result $f S1 2026-09-10T00:11:01Z h9 $'$ bash -c ...\nexit code: 0'
  # shell の -e は errexit なのでインラインではなく、スクリプト名の型にまとめる
  hexec $f S1 2026-09-10T00:12:00Z h10 'launchctl は sandbox 内で動かない' bash -e /w/new/scripts/install.sh
  result $f S1 2026-09-10T00:12:01Z h10 $'$ bash -e /w/new/scripts/install.sh\nexit code: 0'
  run collect
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | ids)" = "host_exec:declined:gh pr 1 1
host_exec:ran:bash -c 2 1
host_exec:ran:bash install.sh 3 1
host_exec:ran:git fetch 2 1
host_exec:ran:git merge 1 1
host_exec:refused:rm 1 1
permission:worktree-guard:Bash * 1 1
sandbox:path:/w/repo/.git/FETCH_HEAD 1 1" ]
  [ "$(printf '%s' "$output" | jq -c '.types[] | select(.id == "host_exec:ran:git merge") | .after_block')" = 1 ]
  [ "$(printf '%s' "$output" | jq -c '.types[] | select(.id == "host_exec:ran:git fetch") | [.after_block, .examples[0]]')" \
    = '[1,"理由: 分離中は dotfiles の git を書けない / $ git -C /w/dotfiles fetch origin"]' ]
  [ "$(printf '%s' "$output" | jq -c '[.types[] | select(.category != "host_exec") | has("after_block")] | any')" = false ]
  cd "$WORK"
  run bash "$SCRIPT" run --no-verify --projects-dir "$P" --now "$NOW"
  [ "$status" -eq 0 ]
  grep -q '^- 種別: host-exec / ran$' "$WORK/claudedocs/sandbox-tune-2026-10-01.md"
  grep -q '^- 直前の Bash が拒否されていた: 1 / 2 件' "$WORK/claudedocs/sandbox-tune-2026-10-01.md"
}

@test "redact: 秘密の形をしたものを伏せ、通常のパスやコマンドは残す" {
  input=$'git clone https://alice:hunter2@git.example.com/r.git\nGITHUB_TOKEN=abc123 API_KEY="k v" AWS_SECRET=\'s3\' gh api\nstripe sk_live_AAA111 sk_test_BBB222 ghp_CCC333 gho_DDD444 xoxb-EEE555 xoxp-FFF666\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEA\n-----END OPENSSH PRIVATE KEY-----\n/usr/local/bin/tool --flag ~/.config/app/settings.json https://example.com/path monkey=banana'
  run bash -c 'printf "%s" "$1" | bash "$2" redact' _ "$input" "$SCRIPT"
  [ "$status" -eq 0 ]
  for secret in hunter2 abc123 '"k v"' "'s3'" AAA111 BBB222 CCC333 DDD444 EEE555 FFF666 b3BlbnNzaC1rZXktdjEA; do
    if [[ "$output" == *"$secret"* ]]; then echo "残った: $secret"; return 1; fi
  done
  [[ "$output" == *"https://***:***@git.example.com/r.git"* ]]
  [[ "$output" == *"GITHUB_TOKEN=*** API_KEY=*** AWS_SECRET=***"* ]]
  [[ "$output" == *"-----BEGIN OPENSSH PRIVATE KEY----- [REDACTED] -----END OPENSSH PRIVATE KEY-----"* ]]
  [[ "$output" == *"/usr/local/bin/tool --flag ~/.config/app/settings.json https://example.com/path monkey=banana"* ]]
}

@test "collect: 代表的なエラー文と対象は伏せ字済みで出す" {
  local f=proj-a/s1.jsonl
  use $f S1 2026-09-10T00:00:00Z r1 'git fetch'
  result $f S1 2026-09-10T00:00:01Z r1 "fatal: unable to write 'https://bob:pa55word@git.example.com/r.git': Operation not permitted"
  run collect
  [ "$status" -eq 0 ]
  [[ "$output" != *pa55word* ]]
  [ "$(printf '%s' "$output" | jq -r '.types[0].target')" = 'https://***:***@git.example.com/r.git' ]
}

# 設定 repo: 2026-09-15 に example.org と /run/db/x.sock を足す commit がある
make_config_repo() {
  local repo="$WORK/conf"
  mkdir -p "$repo"
  git -C "$repo" init -q
  echo '{}' >"$repo/settings.json"
  echo 'example.org /run/db/x.sock' >"$repo/unrelated.txt"
  git -C "$repo" add settings.json unrelated.txt
  GIT_AUTHOR_DATE=2026-09-01T00:00:00Z GIT_COMMITTER_DATE=2026-09-01T00:00:00Z \
    git -C "$repo" -c user.name=t -c user.email=t@example.com commit -q -m init
  echo '{"permissions":{"allow":["Bash(node --version)"]},"sandbox":{"network":{"allowedDomains":["example.org"],"allowUnixSockets":["/run/db/x.sock"]}}}' >"$repo/settings.json"
  git -C "$repo" add settings.json
  GIT_AUTHOR_DATE=2026-09-15T00:00:00Z GIT_COMMITTER_DATE=2026-09-15T00:00:00Z \
    git -C "$repo" -c user.name=t -c user.email=t@example.com commit -q -m 'sandbox: allow example.org and db socket'
  FIX_COMMIT="$(git -C "$repo" rev-parse HEAD)"
  echo '{"configRepo":{"path":"conf","paths":["settings.json"]}}' >"$WORK/sandbox-tune.json"
}

@test "verify: 修正 commit の前だけに発生した型は resolved、後にも発生した型と commit の無い型は remaining" {
  fixture_basic
  # unix socket は修正 commit の後にも発生している
  use proj-a/s1.jsonl S1 2026-09-20T00:05:00Z t9 'pg-client status'
  result proj-a/s1.jsonl S1 2026-09-20T00:05:01Z t9 "cannot connect to socket at '/run/db/x.sock': Operation not permitted"
  # 対象が 1 語（node）の型は、その語を含む commit があっても resolved にしない
  use proj-a/s1.jsonl S1 2026-09-10T00:06:00Z t10 'node -e 1'
  result proj-a/s1.jsonl S1 2026-09-10T00:06:01Z t10 'Permission to use Bash with command node -e 1 has been denied.' '{"toolDenialKind":"permission-rule"}'
  make_config_repo
  cd "$WORK"
  run bash "$SCRIPT" run --projects-dir "$P" --now "$NOW"
  [ "$status" -eq 0 ]
  json="$WORK/claudedocs/sandbox-tune-2026-10-01.json"
  [ "$(printf '%s' "$output" | jq -r .analysis)" = "$json" ]
  [ "$(jq -c '.types[] | select(.id == "sandbox:network:example.org") | [.status, .evidence.commit, .evidence.committed_at, .evidence.after_count, .evidence.last_after]' "$json")" \
    = "[\"resolved\",\"$FIX_COMMIT\",\"2026-09-15T00:00:00Z\",0,null]" ]
  [ "$(jq -c '.types[] | select(.id == "sandbox:unix_socket:/run/db/x.sock") | [.status, .evidence.commit, .evidence.after_count, .evidence.last_after]' "$json")" \
    = "[\"remaining\",\"$FIX_COMMIT\",1,\"2026-09-20T00:05:01Z\"]" ]
  [ "$(jq -c '.types[] | select(.id == "sandbox:path:/etc/blocked") | [.status, .evidence.commit, .evidence.after_count]' "$json")" = '["remaining",null,3]' ]
  [ "$(jq -c '.types[] | select(.id == "permission:permission-rule:Bash node") | [.status, .evidence.commit]' "$json")" = '["remaining",null]' ]
  grep -q '^## remaining' "$WORK/claudedocs/sandbox-tune-2026-10-01.md"
}

# 拒否が起きた repo（$HOME/src/app）: 2026-09-15 に .claude/settings.json へ a〜d.example.test を足す commit がある。
# old は修正前に切った branch、feat は修正後に切った worktree（.claude/worktrees/w1）の branch
make_app_repo() {
  APP="$HOME/src/app"
  mkdir -p "$APP/.claude"
  git -C "$APP" init -q -b main
  echo '{}' >"$APP/.claude/settings.json"
  git -C "$APP" add .claude/settings.json
  GIT_AUTHOR_DATE=2026-09-01T00:00:00Z GIT_COMMITTER_DATE=2026-09-01T00:00:00Z \
    git -C "$APP" -c user.name=t -c user.email=t@example.com commit -q -m init
  git -C "$APP" branch old
  echo '{"sandbox":{"network":{"allowedDomains":["a.example.test","b.example.test","c.example.test","d.example.test"]}}}' >"$APP/.claude/settings.json"
  git -C "$APP" add .claude/settings.json
  GIT_AUTHOR_DATE=2026-09-15T00:00:00Z GIT_COMMITTER_DATE=2026-09-15T00:00:00Z \
    git -C "$APP" -c user.name=t -c user.email=t@example.com commit -q -m 'sandbox: allow test hosts'
  APP_FIX="$(git -C "$APP" rev-parse HEAD)"
  git -C "$APP" worktree add -q -b feat "$APP/.claude/worktrees/w1"
}

# ネットワーク拒否 1 件: <tool_use_id> <timestamp> <host> <cwd> [gitBranch]
deny_at() {
  local x
  x="$(jq -nc --arg c "$4" --arg b "${5:-}" '{cwd: $c} + (if $b == "" then {} else {gitBranch: $b} end)')"
  use proj-a/s1.jsonl S1 "$2" "$1" "curl -sS https://$3" "$x"
  result proj-a/s1.jsonl S1 "$2" "$1" "$(violation "$3")" "$x"
}

@test "verify: 発生した repo の .claude/settings.json の修正と、後の発生の branch がそれを含むかを突き合わせる" {
  export GIT_CEILING_DIRECTORIES="$WORK"
  make_config_repo
  make_app_repo
  mkdir -p "$HOME/plain"
  # (1) 修正後の発生なし → resolved
  deny_at a1 2026-09-10T00:00:00Z a.example.test "$APP" main
  # (2) 修正後の発生がすべて修正を含まない branch → stale_branch
  deny_at b1 2026-09-10T00:00:00Z b.example.test "$APP" main
  deny_at b2 2026-09-20T00:00:00Z b.example.test "$APP" old
  # (3) 修正を含む branch（worktree は本体の repo にまとめる）での発生がある → remaining
  deny_at c1 2026-09-20T00:00:00Z c.example.test "$APP" old
  deny_at c2 2026-09-20T00:01:00Z c.example.test "$APP/.claude/worktrees/w1" feat
  # (4) cwd が存在しない発生は判定不能 → エラーにならず remaining
  deny_at d1 2026-09-10T00:00:00Z d.example.test "$APP" main
  deny_at d2 2026-09-20T00:00:00Z d.example.test "$HOME/src/gone" old
  # git repo でない cwd だけの型は、関係する commit なしで remaining
  deny_at e1 2026-09-20T00:00:00Z e.example.test "$HOME/plain" old
  # configRepo だけに修正がある型
  deny_at o1 2026-09-10T00:00:00Z example.org "$APP" main
  before="$(git -C "$APP" for-each-ref; git -C "$APP" status --porcelain; cat "$APP/.claude/settings.json")"
  cd "$WORK"
  run bash "$SCRIPT" run --projects-dir "$P" --now "$NOW"
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -c '[.remaining, .stale_branch, .resolved]')" = '[3,1,2]' ]
  json="$WORK/claudedocs/sandbox-tune-2026-10-01.json"
  [ "$(jq -c '.types[] | select(.id == "sandbox:network:c.example.test") | .occurrences[1]' "$json")" \
    = '{"ts":"2026-09-20T00:01:00Z","cwd":"~/src/app/.claude/worktrees/w1","git_branch":"feat"}' ]
  [ "$(jq -c '.types[] | select(.id == "sandbox:network:a.example.test") | [.status, .evidence.commit, .evidence.repo, .evidence.related_commits[0].repo, .evidence.related_commits[0].source]' "$json")" \
    = "[\"resolved\",\"$APP_FIX\",\"~/src/app\",\"~/src/app\",\"repo\"]" ]
  [ "$(jq -c '.types[] | select(.id == "sandbox:network:b.example.test") | [.status, .evidence.after_branches]' "$json")" \
    = '["stale_branch",{"contains":0,"not_contains":1,"unknown":0}]' ]
  [ "$(jq -c '.types[] | select(.id == "sandbox:network:c.example.test") | [.status, .evidence.after_branches]' "$json")" \
    = '["remaining",{"contains":1,"not_contains":1,"unknown":0}]' ]
  [ "$(jq -c '.types[] | select(.id == "sandbox:network:d.example.test") | [.status, .evidence.after_branches]' "$json")" \
    = '["remaining",{"contains":0,"not_contains":0,"unknown":1}]' ]
  [ "$(jq -c '.types[] | select(.id == "sandbox:network:e.example.test") | [.status, .evidence.commit]' "$json")" = '["remaining",null]' ]
  # configRepo 側の突き合わせは今と同じ
  [ "$(jq -c '.types[] | select(.id == "sandbox:network:example.org") | [.status, .evidence.commit, .evidence.repo]' "$json")" \
    = "[\"resolved\",\"$FIX_COMMIT\",\"$(jq -r .verify.repo "$json")\"]" ]
  # report は stale_branch を remaining と別の節に出す
  md="$WORK/claudedocs/sandbox-tune-2026-10-01.md"
  sed -n '/^## stale_branch/,/^## resolved/p' "$md" | grep -q 'sandbox:network:b.example.test'
  ! sed -n '/^## remaining/,/^## stale_branch/p' "$md" | grep -q 'sandbox:network:b.example.test'
  sed -n '/^## remaining/,/^## stale_branch/p' "$md" | grep -q '修正を含む branch 1 / 含まない 1 / 判定不能 0'
  # 発生した repo は読むだけ
  [ "$(git -C "$APP" for-each-ref; git -C "$APP" status --porcelain; cat "$APP/.claude/settings.json")" = "$before" ]
}

@test "verify: configRepo の修正は branch に関係なく効くので、configRepo 内の修正を含まない branch での後の発生も remaining" {
  export GIT_CEILING_DIRECTORIES="$WORK"
  make_config_repo
  git -C "$WORK/conf" branch old HEAD~1
  deny_at o1 2026-09-10T00:00:00Z example.org "$WORK/conf" main
  deny_at o2 2026-09-20T00:00:00Z example.org "$WORK/conf" old
  cd "$WORK"
  run bash "$SCRIPT" run --projects-dir "$P" --now "$NOW"
  [ "$status" -eq 0 ]
  json="$WORK/claudedocs/sandbox-tune-2026-10-01.json"
  [ "$(jq -c '.types[] | select(.id == "sandbox:network:example.org") | [.status, .evidence.commit, .evidence.after_branches, .evidence.related_commits[0].source]' "$json")" \
    = "[\"remaining\",\"$FIX_COMMIT\",{\"contains\":0,\"not_contains\":0,\"unknown\":1},\"config\"]" ]
}

@test "run: 要約の recurring は remaining のうち発生 2 回以上で最終発生が期間終端から 7 日以内の型の数" {
  export GIT_CEILING_DIRECTORIES="$WORK"
  mkdir -p "$HOME/plain"
  # fixed.example.test を 2026-09-29 に許可した設定 repo
  local repo="$WORK/conf"
  git -C "$WORK" init -q conf
  echo '{"sandbox":{"network":{"allowedDomains":["fixed.example.test"]}}}' >"$repo/settings.json"
  git -C "$repo" add settings.json
  GIT_AUTHOR_DATE=2026-09-29T00:00:00Z GIT_COMMITTER_DATE=2026-09-29T00:00:00Z \
    git -C "$repo" -c user.name=t -c user.email=t@example.com commit -q -m 'sandbox: allow test host'
  echo '{"configRepo":{"path":"conf","paths":["settings.json"]}}' >"$WORK/sandbox-tune.json"
  # 2 回・最終発生がちょうど 7 日前（NOW = 2026-10-01T00:00:00Z）→ 数える
  deny_at e1 2026-09-01T00:00:00Z edge.example.test "$HOME/plain"
  deny_at e2 2026-09-24T00:00:00Z edge.example.test "$HOME/plain"
  # 2 回・最終発生が 7 日と 1 秒前 → 数えない
  deny_at b1 2026-09-01T00:00:00Z before.example.test "$HOME/plain"
  deny_at b2 2026-09-23T23:59:59Z before.example.test "$HOME/plain"
  # 2 回・最終発生が 7 日より 1 秒後 → 数える
  deny_at a1 2026-09-01T00:00:00Z after.example.test "$HOME/plain"
  deny_at a2 2026-09-24T00:00:01Z after.example.test "$HOME/plain"
  # 1 回だけ（最近）→ 数えない
  deny_at o1 2026-09-30T00:00:00Z once.example.test "$HOME/plain"
  # 2 回・最近だが修正 commit より前だけ（resolved）→ 数えない
  deny_at f1 2026-09-27T00:00:00Z fixed.example.test "$HOME/plain"
  deny_at f2 2026-09-28T00:00:00Z fixed.example.test "$HOME/plain"
  cd "$WORK"
  run bash "$SCRIPT" run --projects-dir "$P" --now "$NOW"
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -c '[.types, .remaining, .resolved, .recurring]')" = '[5,4,1,2]' ]
}

@test "verify: 設定の intended に id か kind で一致する型は intended にし、remaining・recurring から外してレポートの別の節に出す" {
  export GIT_CEILING_DIRECTORIES="$WORK"
  mkdir -p "$HOME/plain"
  make_config_repo
  echo '{"configRepo":{"path":"conf","paths":["settings.json"]},
         "intended":[{"kind":"permission-rule","reason":"permissions.deny で止めている"},
                     {"id":"sandbox:network:intended.example.test","reason":"送らせない宛先"}]}' >"$WORK/sandbox-tune.json"
  # id で一致（2 回・最近）
  deny_at i1 2026-09-29T00:00:00Z intended.example.test "$HOME/plain"
  deny_at i2 2026-09-30T00:00:00Z intended.example.test "$HOME/plain"
  # kind で一致（2 回・最近）
  use proj-a/s1.jsonl S1 2026-09-29T00:00:00Z k1 'node -e 1'
  result proj-a/s1.jsonl S1 2026-09-29T00:00:01Z k1 'Permission to use Bash with command node -e 1 has been denied.' '{"toolDenialKind":"permission-rule"}'
  use proj-a/s1.jsonl S1 2026-09-30T00:00:00Z k2 'node -e 2'
  result proj-a/s1.jsonl S1 2026-09-30T00:00:01Z k2 'Permission to use Bash with command node -e 2 has been denied.' '{"toolDenialKind":"permission-rule"}'
  # どれにも一致しない（2 回・最近）→ remaining のまま recurring に数える
  deny_at o1 2026-09-29T00:00:00Z other.example.test "$HOME/plain"
  deny_at o2 2026-09-30T00:00:00Z other.example.test "$HOME/plain"
  cd "$WORK"
  run bash "$SCRIPT" run --projects-dir "$P" --now "$NOW"
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -c '[.types, .remaining, .intended, .recurring]')" = '[3,1,2,1]' ]
  json="$WORK/claudedocs/sandbox-tune-2026-10-01.json"
  [ "$(jq -c '[.types[] | select(.status == "intended") | [.id, .intended.by, .intended.reason]] | sort' "$json")" \
    = '[["permission:permission-rule:Bash node","kind","permissions.deny で止めている"],["sandbox:network:intended.example.test","id","送らせない宛先"]]' ]
  md="$WORK/claudedocs/sandbox-tune-2026-10-01.md"
  sed -n '/^## intended/,$p' "$md" | grep -q 'sandbox:network:intended.example.test'
  sed -n '/^## intended/,$p' "$md" | grep -q '意図した拒否: 送らせない宛先（設定の intended に id で一致）'
  ! sed -n '/^## remaining/,/^## stale_branch/p' "$md" | grep -q 'intended.example.test'
  sed -n '/^## remaining/,/^## stale_branch/p' "$md" | grep -q 'sandbox:network:other.example.test'
}

@test "verify: occurrences が時刻だけの古い collect の JSON は受け付けない" {
  make_config_repo
  echo '{"types":[{"id":"sandbox:network:x.example","needle":"x.example","count":1,"last_seen":"2026-09-10T00:00:00Z","occurrences":["2026-09-10T00:00:00Z"]}]}' >"$WORK/old.json"
  cd "$WORK"
  run bash "$SCRIPT" verify "$WORK/old.json"
  [ "$status" -eq 2 ]
  [[ "$output" == *"collect からやり直してください"* ]]
}

@test "run: 設定が無い・configRepo が無いときは何も書かずに exit 2。--no-verify なら verify せず伏せ字済みのレポートを書く。gh は呼ばない" {
  fixture_basic
  use proj-a/s1.jsonl S1 2026-09-10T00:09:00Z r2 'deploy-tool push'
  result proj-a/s1.jsonl S1 2026-09-10T00:09:01Z r2 'Error: EPERM: operation not permitted, open DEPLOY_TOKEN=tok_zzz9'
  cd "$WORK"
  # --config も cwd の sandbox-tune.json も無い
  run --separate-stderr bash "$SCRIPT" run --projects-dir "$P" --now "$NOW" --out "$WORK/out"
  [ "$status" -eq 2 ]
  [[ "$stderr" == *"sandbox-tune.json"* ]]
  [[ "$stderr" == *"--no-verify"* ]]
  [ ! -e "$WORK/out" ]
  # 設定はあるが configRepo が無い（cwd・--config とも）
  echo '{"issue":{"repo":"o/r"}}' >"$WORK/sandbox-tune.json"
  run --separate-stderr bash "$SCRIPT" run --projects-dir "$P" --now "$NOW" --out "$WORK/out"
  [ "$status" -eq 2 ]
  [[ "$stderr" == *"--no-verify"* ]]
  [ ! -e "$WORK/out" ]
  mv "$WORK/sandbox-tune.json" "$WORK/other.json"
  run --separate-stderr bash "$SCRIPT" run --config "$WORK/other.json" --projects-dir "$P" --now "$NOW" --out "$WORK/out"
  [ "$status" -eq 2 ]
  [ ! -e "$WORK/out" ]

  # --no-verify は設定が無くても collect と report を書く
  run bash "$SCRIPT" run --no-verify --projects-dir "$P" --now "$NOW"
  [ "$status" -eq 0 ]
  md="$WORK/claudedocs/sandbox-tune-2026-10-01.md"
  [ "$(printf '%s' "$output" | jq -r '[.report, .verified] | @tsv')" = "$md	false" ]
  grep -q 'verify は未実施' "$md"
  grep -q 'sandbox:path:/etc/blocked' "$md"
  grep -q 'DEPLOY_TOKEN=\*\*\*' "$md"
  ! grep -q 'tok_zzz9' "$md"
  [ ! -s "$GH_LOG" ]

  # configRepo のある設定でも --no-verify なら verify しない
  make_config_repo
  run bash "$SCRIPT" run --no-verify --projects-dir "$P" --now "$NOW" --out "$WORK/nv"
  [ "$status" -eq 0 ]
  # status が無いので recurring は数えず null
  [ "$(printf '%s' "$output" | jq -c '[.verified, .resolved, .remaining, has("recurring"), .recurring]')" = '[false,0,0,true,null]' ]
  [ "$(jq -c '[.verify, ([.types[] | has("status")] | any)]' "$WORK/nv/sandbox-tune-2026-10-01.json")" = '[null,false]' ]
  head -n 5 "$WORK/nv/sandbox-tune-2026-10-01.md" | grep -q 'verify は未実施'
}

@test "config: 不正な設定はエラーにする" {
  echo '{"configRepo":{"path":"x","paths":[]},"issue":{"repo":"no-slash"},"typo":1}' >"$WORK/bad.json"
  run bash "$SCRIPT" config --config "$WORK/bad.json"
  [ "$status" -eq 2 ]
  [[ "$output" == *"未知のキー: typo"* ]]
  [[ "$output" == *"configRepo.paths は空でない文字列の配列にしてください"* ]]
  [[ "$output" == *"issue.repo は owner/name の形にしてください"* ]]

  echo '{"configRepo":{"path":"not-a-repo","paths":["settings.json"]}}' >"$WORK/bad2.json"
  run bash "$SCRIPT" config --config "$WORK/bad2.json"
  [ "$status" -eq 2 ]
  [[ "$output" == *"git repo ではありません"* ]]

  # intended の項目は id か kind の一方と reason を持つ
  echo '{"intended":[{"id":"a","kind":"b","reason":"r"},{"kind":"hook"},{"id":"x","reason":"r","typo":1},"s"]}' >"$WORK/bad5.json"
  run bash "$SCRIPT" config --config "$WORK/bad5.json"
  [ "$status" -eq 2 ]
  [[ "$output" == *"intended[0] は id か kind のどちらか一方を書いてください"* ]]
  [[ "$output" == *"intended[1].reason は空でない文字列にしてください"* ]]
  [[ "$output" == *"intended[2] の未知のキー: typo"* ]]
  [[ "$output" == *"intended[3] はオブジェクトにしてください"* ]]
  echo '{"intended":{}}' >"$WORK/bad6.json"
  run bash "$SCRIPT" config --config "$WORK/bad6.json"
  [ "$status" -eq 2 ]
  [[ "$output" == *"intended は配列にしてください"* ]]

  # issue.template は {{ac}} と {{paths}} の両方を持つ
  printf '## 概要\n\n{{title}}\n\n{{ac}}\n' >"$WORK/tpl-ac-only.md"
  echo '{"issue":{"repo":"o/r","template":"tpl-ac-only.md"}}' >"$WORK/bad3.json"
  run bash "$SCRIPT" config --config "$WORK/bad3.json"
  [ "$status" -eq 2 ]
  [[ "$output" == *"issue.template に {{paths}} がありません"* ]]
  printf '## 概要\n\n{{title}}\n' >"$WORK/tpl-none.md"
  echo '{"issue":{"repo":"o/r","template":"tpl-none.md"}}' >"$WORK/bad4.json"
  run bash "$SCRIPT" config --config "$WORK/bad4.json"
  [ "$status" -eq 2 ]
  [[ "$output" == *"issue.template に {{ac}} {{paths}} がありません"* ]]
  printf '{{title}}\n\n{{ac}}\n\n{{paths}}\n' >"$WORK/tpl-ok.md"
  echo '{"issue":{"repo":"o/r","template":"tpl-ok.md"}}' >"$WORK/ok.json"
  run bash "$SCRIPT" config --config "$WORK/ok.json"
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -r .issue.template)" = "$WORK/tpl-ok.md" ]
}

# run の結果と候補 JSON から下書きを作る。セキュリティ系の候補（S）と、そうでない候補（N）
make_drafts() {
  fixture_basic
  cd "$WORK"
  echo '{"issue":{"repo":"o/r","labels":["sandbox"]}}' >"$WORK/sandbox-tune.json"
  bash "$SCRIPT" run --no-verify --projects-dir "$P" --now "$NOW" >/dev/null
  cat >"$WORK/candidates.json" <<'EOF'
{"candidates":[
  {"id":"sandbox:network:example.org","title":"example.org を allowedDomains に足す","cause":"許可リストに無い","fix":"sandbox.network.allowedDomains に example.org を足す","safety":"取得先が 1 ホスト増えるだけ","security":false,
   "ac":["sandbox 内の curl -sS https://example.org が exit 0 で終わる","settings.json の allowedDomains に example.org が 1 件だけある"],"paths":["claude/settings.json","claude/bin/**"]},
  {"id":"sandbox:unix_socket:/run/db/x.sock","title":"db socket の経路","cause":"ghp_LEAKEDVALUE を持つプロセスに sandbox の外から届く","fix":"socket を個別に許可する","safety":"他プロセスの情報が読める","security":true,
   "ac":["DB_TOKEN=acleak9 を読めない"],"paths":["claude/ghp_PATHLEAK.json"]}
]}
EOF
  run bash "$SCRIPT" draft --issue --analysis "$WORK/claudedocs/sandbox-tune-2026-10-01.json" --candidates "$WORK/candidates.json" \
    --ids 'sandbox:network:example.org,sandbox:unix_socket:/run/db/x.sock'
  [ "$status" -eq 0 ]
  N="$WORK/claudedocs/sandbox-tune-issue-1.md"
  S="$WORK/claudedocs/sandbox-tune-issue-2.md"
  N_SHA="$(jq -r .sha256 "${N%.md}.meta.json")"
  S_SHA="$(jq -r .sha256 "${S%.md}.meta.json")"
}

@test "issue: 既定でオフ。--issue を明示しなければ下書きを作らない" {
  fixture_basic
  cd "$WORK"
  echo '{"issue":{"repo":"o/r"}}' >"$WORK/sandbox-tune.json"
  bash "$SCRIPT" run --no-verify --projects-dir "$P" --now "$NOW" >/dev/null
  echo '{"candidates":[{"id":"sandbox:network:example.org","title":"t","cause":"c","fix":"f","safety":"s","ac":["a"],"paths":["p"]}]}' >"$WORK/candidates.json"
  run bash "$SCRIPT" draft --analysis "$WORK/claudedocs/sandbox-tune-2026-10-01.json" --candidates "$WORK/candidates.json" \
    --ids sandbox:network:example.org
  [ "$status" -eq 2 ]
  [ ! -e "$WORK/claudedocs/sandbox-tune-issue-1.md" ]
  [ ! -s "$GH_LOG" ]
}

@test "issue: 下書きは伏せ字を通し、表示した内容の digest を出す。投稿はしない" {
  make_drafts
  [[ "$output" == *"digest $N_SHA"* ]]
  [[ "$output" == *"example.org を allowedDomains に足す"* ]]
  grep -q 'ghp_\*\*\*' "$S"
  ! grep -q 'LEAKEDVALUE' "$S"
  # ac と paths も伏せ字を通る
  grep -q '^- \[ \] DB_TOKEN=\*\*\* を読めない$' "$S"
  grep -q '^- claude/ghp_\*\*\*.json$' "$S"
  ! grep -q 'acleak9' "$S"
  ! grep -q 'PATHLEAK' "$S"
  [ "$(jq -r .security "${N%.md}.meta.json")" = false ]
  [ "$(jq -r .security "${S%.md}.meta.json")" = true ]
  ! grep -q 'issue create' "$GH_LOG"
}

@test "issue: 既定テンプレートの下書きは受け入れ基準と変更対象パスを持ち、dev-flow の起票ゲート（create_issue.py --kind agent）を通る" {
  command -v python3 >/dev/null || skip "python3 not available"
  make_drafts
  [ "$(sed -n '/^## 受け入れ基準（Acceptance Criteria）$/,/^## /p' "$N" | grep '^- ')" \
    = $'- [ ] sandbox 内の curl -sS https://example.org が exit 0 で終わる\n- [ ] settings.json の allowedDomains に example.org が 1 件だけある' ]
  [ "$(sed -n '/^## 変更対象パス$/,/^---$/p' "$N" | grep '^- ')" = $'- claude/settings.json\n- claude/bin/**' ]
  run python3 "$BATS_TEST_DIRNAME/../../../dev-flow/git-issue/scripts/create_issue.py" \
    --kind agent --dry-run --repo o/dotfiles --title "$(jq -r .title "${N%.md}.meta.json")" --body-file "$N"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Dry run: issue will not be created."* ]]
}

@test "issue: 候補に ac と paths が無い・形が違うときは draft が理由を出して exit 2" {
  fixture_basic
  cd "$WORK"
  echo '{"issue":{"repo":"o/r"}}' >"$WORK/sandbox-tune.json"
  bash "$SCRIPT" run --no-verify --projects-dir "$P" --now "$NOW" >/dev/null
  draft() {
    printf '%s' "$1" >"$WORK/candidates.json"
    run --separate-stderr bash "$SCRIPT" draft --issue --analysis "$WORK/claudedocs/sandbox-tune-2026-10-01.json" \
      --candidates "$WORK/candidates.json" --ids sandbox:network:example.org
  }
  local base='"id":"sandbox:network:example.org","title":"t","cause":"c","fix":"f","safety":"s"'
  # ac・paths の無い旧形式
  draft "{\"candidates\":[{$base}]}"
  [ "$status" -eq 2 ]
  [[ "$stderr" == *"(sandbox:network:example.org): ac は空でない文字列の配列にしてください"* ]]
  [[ "$stderr" == *"(sandbox:network:example.org): paths は空でない配列にしてください"* ]]
  # 空の配列・空文字列の要素
  draft "{\"candidates\":[{$base,\"ac\":[],\"paths\":[]}]}"
  [ "$status" -eq 2 ]
  [[ "$stderr" == *"ac は空でない文字列の配列"* ]]
  [[ "$stderr" == *"paths は空でない配列"* ]]
  draft "{\"candidates\":[{$base,\"ac\":[\"a\",\"\"],\"paths\":[\"p\"]}]}"
  [ "$status" -eq 2 ]
  [[ "$stderr" == *"ac は空でない文字列の配列"* ]]
  # repo の外を指す・複数行の paths
  draft "{\"candidates\":[{$base,\"ac\":[\"a\"],\"paths\":[\"/etc/x\",\"a/../../b\",\"ok\\n- /etc/y\",1]}]}"
  [ "$status" -eq 2 ]
  [[ "$stderr" == *"/ 始まりは不可）: /etc/x"* ]]
  [[ "$stderr" == *".. セグメントは使えません（repo の外を指せない）: a/../../b"* ]]
  [[ "$stderr" == *'paths の要素は 1 行の空でない文字列にしてください: "ok\n- /etc/y"'* ]]
  [[ "$stderr" == *"paths の要素は 1 行の空でない文字列にしてください: 1"* ]]
  [ ! -e "$WORK/claudedocs/sandbox-tune-issue-1.md" ]
  # 揃っていれば通る（glob も受け付ける）
  draft "{\"candidates\":[{$base,\"ac\":[\"a\"],\"paths\":[\"claude/**/*.json\"]}]}"
  [ "$status" -eq 0 ]
  [ -f "$WORK/claudedocs/sandbox-tune-issue-1.md" ]
}

@test "issue: 公開 repo へは --allow-public なしで渡さない。通ったら orchestrator に渡す引数を 1 行の JSON で出し、issue は作らない" {
  make_drafts
  run bash "$SCRIPT" handoff "$N" --digest "$N_SHA"
  [ "$status" -eq 5 ]
  [[ "$output" == *"公開 repo"* ]]

  run --separate-stderr bash "$SCRIPT" handoff "$N" --digest "$N_SHA" --allow-public
  [ "$status" -eq 0 ]
  [[ "$stderr" == *"公開 repo です"* ]]
  [[ "$output" != *$'\n'* ]]
  [ "$(printf '%s' "$output" | jq -c 'keys')" = '["labels","material","repo","title"]' ]
  [ "$(printf '%s' "$output" | jq -r .material)" = "$N" ]
  [ "$(printf '%s' "$output" | jq -r .repo)" = o/r ]
  [ "$(printf '%s' "$output" | jq -r .title)" = 'example.org を allowedDomains に足す' ]
  [ "$(printf '%s' "$output" | jq -c .labels)" = '["sandbox"]' ]
  grep -q 'repo view o/r' "$GH_LOG"
  ! grep -q 'issue create' "$GH_LOG"

  # 直接起票する post は無い
  run bash "$SCRIPT" post "$N" --digest "$N_SHA" --allow-public
  [ "$status" -eq 2 ]
  [[ "$output" == *"|handoff}"* ]]
  ! grep -q 'issue create' "$GH_LOG"
}

@test "issue: セキュリティ系の候補は --allow-public があっても公開 repo に渡さない" {
  make_drafts
  run bash "$SCRIPT" handoff "$S" --digest "$S_SHA" --allow-public
  [ "$status" -eq 5 ]
  [[ "$output" == *"security advisory"* ]]

  # 非公開 repo には渡せる
  GH_VISIBILITY=PRIVATE run bash "$SCRIPT" handoff "$S" --digest "$S_SHA"
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -r '[.material, .repo] | @tsv')" = "$S	o/r" ]
  ! grep -q 'issue create' "$GH_LOG"
}

@test "issue: 提出先の公開範囲を確認できなければ渡さない" {
  make_drafts
  GH_VIEW_FAIL=1 run bash "$SCRIPT" handoff "$N" --digest "$N_SHA" --allow-public
  [ "$status" -eq 4 ]
  [[ "$output" == *"公開範囲を確認できません"* ]]
  ! grep -q 'issue create' "$GH_LOG"
}

@test "issue: 表示した下書きと違う内容（digest 不一致・書き換え）は渡さない" {
  make_drafts
  GH_VISIBILITY=PRIVATE run bash "$SCRIPT" handoff "$N" --digest deadbeef
  [ "$status" -eq 3 ]
  echo 'SECRET_KEY=plain' >>"$N"
  GH_VISIBILITY=PRIVATE run bash "$SCRIPT" handoff "$N" --digest "$(shasum -a 256 "$N" | cut -d' ' -f1)"
  [ "$status" -eq 3 ]
  # meta の digest まで合わせても、伏せ字を通っていない文字列があれば渡さない
  local sha
  sha="$(shasum -a 256 "$N" | cut -d' ' -f1)"
  jq --arg s "$sha" '.sha256 = $s' "${N%.md}.meta.json" >"$WORK/meta.json"
  mv "$WORK/meta.json" "${N%.md}.meta.json"
  GH_VISIBILITY=PRIVATE run bash "$SCRIPT" handoff "$N" --digest "$sha"
  [ "$status" -eq 3 ]
  [[ "$output" == *"伏せ字を通っていない"* ]]
  ! grep -q 'issue create' "$GH_LOG"
}
