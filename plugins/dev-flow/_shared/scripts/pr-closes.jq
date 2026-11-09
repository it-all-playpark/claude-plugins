# pr-closes.jq - `gh pr view --json body` の応答 object から、本文に `Closes #<issue>` があるかを true / false にする。
# merge-tier-facts.sh（closes サブ結果）と pr-closes-check.sh（closes-reinject の再確認）が同じ判定を使うための 1 か所。
#
# Usage: jq --arg issue <N> -f pr-closes.jq   (<N> は呼び出し側が正の整数に検証済み)
#
# `(\D|$)` は `#8240` を `#824` と数えないための境界。行全体一致ではなく部分一致なのは、GitHub の closing keyword が
# 本文中のどこでも効くのに合わせるため。body が文字列でない応答は error にする（取得失敗を Closes 欠落と同一視しない）。
if (.body | type) == "string" then
  .body | test("Closes #" + $issue + "(\\D|$)")
else
  error("body is not a string")
end
