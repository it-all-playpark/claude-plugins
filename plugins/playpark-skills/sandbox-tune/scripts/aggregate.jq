# extract.jq の事象（jq -s で配列にしたもの）を型ごとに集計する。
# 同じ行が複数の transcript に写っている（resume / fork）ことがあるので事象の id で重複を除く。
# session は sessionId で数える（session 名は自動で付け替わるので使わない）。
def first_n($n): reduce .[] as $e ([]; if length >= $n or any(.[]; . == $e) then . else . + [$e] end);

def aggregate:
  unique_by(.id)
  | sort_by(.epoch)
  | group_by(.key)
  # example_cwds は examples と同じ順で、その例が起きた cwd の一覧（公開 repo への下書きで出どころの公開範囲を見るのに使う）
  | map((map(.example) | first_n(2)) as $examples
    | {
      id: .[0].key,
      category: .[0].cat,
      kind: .[0].kind,
      target: .[0].target,
      needle: .[0].needle,
      count: length,
      sessions: (map(.session) | unique | length),
      first_seen: .[0].ts,
      last_seen: .[-1].ts,
      projects: (map(.project) | unique),
      examples: $examples,
      example_cwds: [ $examples[] as $e | map(select(.example == $e) | .cwd) | unique ],
      occurrences: map({ts, cwd, git_branch})
    }
    + (if .[0].cat == "host_exec" then {after_block: map(select(.after_block == true)) | length} else {} end))
  | sort_by(-.count, .id);
