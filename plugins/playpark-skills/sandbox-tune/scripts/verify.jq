# verify の突き合わせ。sandbox-tune.sh verify が 2 段で使う
# （後の発生の branch 判定に要る組を出す → git で判定した結果を受けて status を決める）。
#   $c      関係する commit {id, git_dir, repo, source, hash, epoch, subject}
#           source は config（configRepo の paths）/ repo（発生した repo の .claude/settings.json）
#   $repos  発生の cwd → {git_dir, top, repo}。cwd が無い・git repo でない発生は載らない
#   $checks "<git_dir>\t<commit>\t<branch>" → contains / not_contains / unknown
def epoch: sub("\\.[0-9]+"; "") | fromdateiso8601;

# 型ごとの関係 commit（新しい順）。同じ由来で重複して引いた commit を除く
def commits_by_type: group_by(.id) | map({key: .[0].id, value: (unique_by([.source, .git_dir, .hash]) | sort_by(-.epoch))}) | from_entries;

# 全 repo の最新の関係 commit より後の発生。発生の repo（git）と、その repo の .claude/settings.json の最新の関係 commit（fix）を付ける。
# configRepo の設定は branch に関係なく効くので、configRepo 由来の commit は fix にしない（その repo 内の発生でも同じ）
def after_occurrences($cs; $repos):
  [ .occurrences[] | select((.ts | epoch) > $cs[0].epoch)
    | $repos[.cwd // ""] as $r
    | . + {git: $r, fix: (if $r then first($cs[] | select(.source == "repo" and .git_dir == $r.git_dir) | .hash) // null else null end)} ];

# 発生の branch がその repo の最新の関係 commit を含むか。repo・関係 commit・branch が無い、detached は判定不能
def needs_check: .fix != null and .git_branch != null and .git_branch != "HEAD";
def judge($checks):
  if needs_check then $checks["\(.git.git_dir)\t\(.fix)\t\(.git_branch)"] // "unknown" else "unknown" end;

# 後の発生がすべて修正を含まない branch なら stale_branch。判定不能は再発に数える（resolved / stale_branch に倒さない）
def verify_types($by; $repos; $checks):
  map(
    . as $t
    | ($by[$t.id] // []) as $cs
    | if ($cs | length) == 0 then
        .status = "remaining"
        | .evidence = {commit: null, committed_at: null, subject: null, repo: null, after_count: $t.count, last_after: $t.last_seen,
                       after_branches: null, related_commits: [],
                       note: (if ($t.needle | test("[./:_ -]")) then null else "対象が 1 語で関係する commit を特定できない" end)}
      else
        $cs[0] as $fix
        | ($t | after_occurrences($cs; $repos)) as $occ
        | ($occ | map(judge($checks))) as $after
        | .status = (if ($after | length) == 0 then "resolved"
                     elif all($after[]; . == "not_contains") then "stale_branch"
                     else "remaining" end)
        | .evidence = {commit: $fix.hash, committed_at: ($fix.epoch | todate), subject: $fix.subject, repo: $fix.repo,
                       after_count: ($after | length), last_after: ($occ | last | .ts),
                       after_branches: {contains: ([$after[] | select(. == "contains")] | length),
                                        not_contains: ([$after[] | select(. == "not_contains")] | length),
                                        unknown: ([$after[] | select(. == "unknown")] | length)},
                       related_commits: [ $cs[0:3][] | {repo, source, hash: .hash[0:12], committed_at: (.epoch | todate), subject} ]}
      end);

# 今も再発している remaining の型: 発生が $min_count 回以上で、最終発生が期間終端（.period.until）から $within_days 日以内
def recurring_types($min_count; $within_days):
  ((.period.until | epoch) - $within_days * 86400) as $recent
  | [.types[] | select(.status == "remaining" and .count >= $min_count and (.last_seen | epoch) >= $recent)];

# 設定の intended（意図した拒否）に id か kind が一致する型は、突き合わせの結果にかかわらず intended にする。
# remaining から外れるので、修正候補にも recurring にも数えない。先に書いた項目を優先する
def mark_intended($intended):
  map(
    . as $t
    | ([$intended[] | select(.id == $t.id or .kind == $t.kind)] | first) as $m
    | if $m then .status = "intended" | .intended = {reason: $m.reason, by: (if $m.id then "id" else "kind" end)} else . end);
