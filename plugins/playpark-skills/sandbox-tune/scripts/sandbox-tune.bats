#!/usr/bin/env bats
# sandbox-tune.sh のテスト。合成した transcript（<projects>/<project>/<session>.jsonl）を集計させる。
# gh は PATH 先頭の偽物で置き換え、呼び出しを記録する。

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
if [ "$1 $2" = "repo view" ]; then echo "${GH_VISIBILITY:-PUBLIC}"; exit 0; fi
if [ "$1 $2" = "issue create" ]; then echo "https://github.com/o/r/issues/1"; fi
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
  run bash "$SCRIPT" run --projects-dir "$P" --now "$NOW"
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

@test "report: 設定が無ければ verify せず、cwd の claudedocs/ に伏せ字済みのレポートを書く。gh は呼ばない" {
  fixture_basic
  use proj-a/s1.jsonl S1 2026-09-10T00:09:00Z r2 'deploy-tool push'
  result proj-a/s1.jsonl S1 2026-09-10T00:09:01Z r2 'Error: EPERM: operation not permitted, open DEPLOY_TOKEN=tok_zzz9'
  cd "$WORK"
  run bash "$SCRIPT" run --projects-dir "$P" --now "$NOW"
  [ "$status" -eq 0 ]
  md="$WORK/claudedocs/sandbox-tune-2026-10-01.md"
  [ "$(printf '%s' "$output" | jq -r '[.report, .verified] | @tsv')" = "$md	false" ]
  grep -q 'verify は未実施' "$md"
  grep -q 'sandbox:path:/etc/blocked' "$md"
  grep -q 'DEPLOY_TOKEN=\*\*\*' "$md"
  ! grep -q 'tok_zzz9' "$md"
  [ ! -s "$GH_LOG" ]
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
}

# run の結果と候補 JSON から下書きを作る。セキュリティ系の候補（S）と、そうでない候補（N）
make_drafts() {
  fixture_basic
  cd "$WORK"
  echo '{"issue":{"repo":"o/r","labels":["sandbox"]}}' >"$WORK/sandbox-tune.json"
  bash "$SCRIPT" run --projects-dir "$P" --now "$NOW" >/dev/null
  cat >"$WORK/candidates.json" <<'EOF'
{"candidates":[
  {"id":"sandbox:network:example.org","title":"example.org を allowedDomains に足す","cause":"許可リストに無い","fix":"sandbox.network.allowedDomains に example.org を足す","safety":"取得先が 1 ホスト増えるだけ","security":false},
  {"id":"sandbox:unix_socket:/run/db/x.sock","title":"db socket の経路","cause":"ghp_LEAKEDVALUE を持つプロセスに sandbox の外から届く","fix":"socket を個別に許可する","safety":"他プロセスの情報が読める","security":true}
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
  bash "$SCRIPT" run --projects-dir "$P" --now "$NOW" >/dev/null
  echo '{"candidates":[{"id":"sandbox:network:example.org","title":"t","cause":"c","fix":"f","safety":"s"}]}' >"$WORK/candidates.json"
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
  [ "$(jq -r .security "${N%.md}.meta.json")" = false ]
  [ "$(jq -r .security "${S%.md}.meta.json")" = true ]
  ! grep -q 'issue create' "$GH_LOG"
}

@test "issue: 公開 repo へは --allow-public なしで投稿しない" {
  make_drafts
  run bash "$SCRIPT" post "$N" --digest "$N_SHA"
  [ "$status" -eq 5 ]
  [[ "$output" == *"公開 repo"* ]]
  ! grep -q 'issue create' "$GH_LOG"

  run bash "$SCRIPT" post "$N" --digest "$N_SHA" --allow-public
  [ "$status" -eq 0 ]
  grep -q "issue create --repo o/r --title example.org を allowedDomains に足す --body-file $N --label sandbox" "$GH_LOG"
}

@test "issue: セキュリティ系の候補は --allow-public があっても公開 repo に投稿しない" {
  make_drafts
  run bash "$SCRIPT" post "$S" --digest "$S_SHA" --allow-public
  [ "$status" -eq 5 ]
  [[ "$output" == *"security advisory"* ]]
  ! grep -q 'issue create' "$GH_LOG"

  # 非公開 repo には投稿できる
  GH_VISIBILITY=PRIVATE run bash "$SCRIPT" post "$S" --digest "$S_SHA"
  [ "$status" -eq 0 ]
  grep -q 'issue create --repo o/r' "$GH_LOG"
}

@test "issue: 表示した下書きと違う内容（digest 不一致・書き換え）は投稿しない" {
  make_drafts
  GH_VISIBILITY=PRIVATE run bash "$SCRIPT" post "$N" --digest deadbeef
  [ "$status" -eq 3 ]
  echo 'SECRET_KEY=plain' >>"$N"
  GH_VISIBILITY=PRIVATE run bash "$SCRIPT" post "$N" --digest "$(shasum -a 256 "$N" | cut -d' ' -f1)"
  [ "$status" -eq 3 ]
  ! grep -q 'issue create' "$GH_LOG"
}
