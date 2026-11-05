# ci-rollup.jq - `gh pr view --json statusCheckRollup` の rollup を check ごとの {name, state, bucket, link?} に写す。
# check-ci.sh と merge-tier-facts.sh の分類の定義はこの 1 か所（片方だけ直すと CI gate と Merge tier の判定が食い違う）。
#
# 入力: rollup の配列か null（PR に check が無いと gh は null を返す）。null は空配列と同じ。
#       それ以外の JSON・object でない要素は error で落とす（呼び出し側が取得失敗として扱う。部分的に読まない）。
# bucket: pass | skipping | fail | cancel | pending
#   CheckRun は conclusion が空でなければ conclusion で分類し、空のときだけ pending にする。status では判定しない:
#   GitHub 側で status が IN_PROGRESS のまま残った check があり、status を見ると結果の確定した check を pending と数える。
#   StatusContext は context を check 名とし、state で分類する。表に無い値は fail（fail-closed — 未知の値を green に倒さない）。
# 重複: CheckRun は同じ name + workflowName に 1 件でも failed（fail / cancel）があれば failed にする。
#   rollup は event を持たず、on: [push, pull_request] の repo では merge ref の failure を後から走った push の success が隠しうる。
#   それ以外と StatusContext は startedAt が最新の 1 件で判定する。
#   未開始の run（startedAt が空か gh の zero time）は最新と見なす: 再実行の待ちを古い run の success で green にしない。
#   同時刻は pass 以外を採る（同じ秒に始まった push と pull_request の片方が完了しても、もう片方を待つ）。

def bucket_of:
  if . == "SUCCESS" then "pass"
  elif IN("SKIPPED", "NEUTRAL") then "skipping"
  elif IN("FAILURE", "ERROR", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE") then "fail"
  elif . == "CANCELLED" then "cancel"
  elif IN("PENDING", "EXPECTED", "STALE") then "pending"
  else "fail" end;

def started_key:
  (.startedAt // "") as $s
  | if $s == "" or ($s | startswith("0001-")) then "9999" else $s end;

def normalize:
  started_key as $started
  | if has("context") then
      (.state // "") as $state
      | {group: ["status", .context], name: .context, state: $state, bucket: ($state | bucket_of), link: (.targetUrl // ""), started: $started}
    else
      (.conclusion // "") as $conclusion
      | {group: ["run", .name, (.workflowName // "")], name,
         state: (if $conclusion == "" then (.status // "") else $conclusion end),
         bucket: (if $conclusion == "" then "pending" else ($conclusion | bucket_of) end),
         link: (.detailsUrl // ""), started: $started}
    end;

def is_failed: .bucket | IN("fail", "cancel");
def latest: max_by([.started, .bucket != "pass", .bucket == "pending"]);

def settle:
  if .[0].group[0] == "run" and any(.[]; is_failed) then map(select(is_failed)) | latest else latest end;

if . == null then []
elif type != "array" then error("rollup is not an array")
else
  map(normalize) | group_by(.group)
  | map(settle | {name, state, bucket} + (if .link != "" then {link} else {} end))
end
