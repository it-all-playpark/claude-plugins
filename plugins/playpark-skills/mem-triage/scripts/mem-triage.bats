#!/usr/bin/env bats
# mem-triage.sh のテスト。fixtures/ は実機の ps / top / sysctl / memory_pressure / lsof の出力形式を模したもの。
#   - Ghostty の 2 つのタブで nvim（古い版と新しい版）と claude を起動し、claude の Bash から dev server と stdio サーバーを起動
#   - launchd 直下に、親を失った stdio language server・claude daemon・常駐の python
#   - Claude.app / Dia / OrbStack のヘルパーと macOS 本体、Safari と WebKit のタブ
#   - 別の版の node（20 と 22）と python（3.11 と 3.12）を同じタブで並べて起動、launchd 直下に常駐の stdio ゲートウェイ

setup() {
  SCRIPT="$BATS_TEST_DIRNAME/mem-triage.sh"
  FIX="$BATS_TEST_DIRNAME/fixtures"
}

triage() {
  run bash "$SCRIPT" --from "$FIX" --top 50 "$@"
  [ "$status" -eq 0 ]
}

unit() {
  jq -c --arg id "$1" '.units[] | select(.id == $id)' <<<"$output"
}

@test "nvim の下で動く language server は nvim の塊に入り、メモリが合算される" {
  triage
  u="$(unit pid:110)"
  [ "$(jq -r .procs <<<"$u")" = "3" ]
  # 40M + 120M + 735M+（top の + 印つき）
  [ "$(jq -r .mem_bytes <<<"$u")" = "$(((40 + 120 + 735) * 1048576))" ]
  [ -z "$(unit pid:112)" ]
}

@test "アプリのヘルパーと、アプリが起動した子（同梱の別の .app を含む）は起動元のアプリの塊にまとまる" {
  triage
  u="$(unit app:Claude)"
  [ "$(jq -r .procs <<<"$u")" = "4" ]
  [ "$(jq -r .mem <<<"$u")" = "1.5G" ]
  [ -z "$(unit app:claude)" ]
  [ "$(jq -r '.units | map(select(.id == "app:Dia")) | .[0].procs' <<<"$output")" = "3" ]
}

@test "シェルを挟んで起動したものは、シェルの親とは別の塊になる" {
  triage
  [ "$(jq -r .procs <<<"$(unit pid:310)")" = "2" ]
  [ "$(jq -r .name <<<"$(unit pid:313)")" = "node" ]
  [ "$(jq -r .procs <<<"$(unit shells)")" = "6" ]
}

@test "聞かずに消してよいのは launchd 直下・端末なしの stdio サーバーだけ" {
  triage
  [ "$(jq -c '[.safe_kill[].pid]' <<<"$output")" = "[130]" ]
  [ "$(jq -c .flags <<<"$(unit pid:130)")" = '["orphan_stdio"]' ]
  [ "$(jq -r .kill <<<"$(unit pid:130)")" = "kill 130" ]
  # 親が生きている stdio サーバーは、塊の根でも消してよいとは言わない
  [ "$(jq -c '[.safe_kill, .flags]' <<<"$(unit pid:316)")" = '[false,[]]' ]
  # stdio を待ち受けポートへ中継する常駐ゲートウェイは、launchd 直下・端末なしでも消してよいとは言わない
  [ "$(jq -c '[.safe_kill, .flags]' <<<"$(unit pid:830)")" = '[false,["detached"]]' ]
  # launchd 直下・端末なしでも stdio サーバーでなければ消してよいとは言わない
  [ "$(jq -c '[.safe_kill, .flags]' <<<"$(unit pid:700)")" = '[false,["detached"]]' ]
  [ "$(jq -c '[.safe_kill, .flags]' <<<"$(unit pid:300)")" = '[false,["detached"]]' ]
}

@test "同じプログラムの古い版で動いているものに older_build が付き、最新の版には付かない" {
  triage
  [ "$(jq -c .flags <<<"$(unit pid:110)")" = '["older_build"]' ]
  [ "$(jq -c .flags <<<"$(unit pid:120)")" = "[]" ]
  [ "$(jq -r .root.age <<<"$(unit pid:110)")" = "2d1h" ]
}

@test "別の major.minor を並べて動かしているもの（node 20 と 22、python 3.11 と 3.12）には older_build を付けない" {
  triage
  [ "$(jq -c .flags <<<"$(unit pid:810)")" = "[]" ]
  [ "$(jq -c .flags <<<"$(unit pid:811)")" = "[]" ]
  [ "$(jq -c .flags <<<"$(unit pid:840)")" = "[]" ]
  [ "$(jq -c .flags <<<"$(unit pid:841)")" = "[]" ]
}

@test "/System/Applications の標準アプリはアプリの塊、WebKit のタブは専用の塊になり、macOS 本体に入らない" {
  triage
  [ "$(jq -r .kind <<<"$(unit app:Safari)")" = "app" ]
  [ "$(jq -c '[.kind, .procs]' <<<"$(unit webkit)")" = '["webkit",2]' ]
  [ "$(jq -r .procs <<<"$(unit system)")" = "3" ]
}

@test "claude は daemon と対話セッションを起動引数で見分ける" {
  triage
  [ "$(jq -r .role <<<"$(unit pid:300)")" = "claude-daemon" ]
  [ "$(jq -r .role <<<"$(unit pid:310)")" = "claude-cli" ]
  [ "$(jq -r .procs <<<"$(unit pid:300)")" = "3" ]
}

@test "自分の祖先を含む塊（起動元の claude・シェル・端末アプリ）に current_session が付く" {
  triage --self 313
  [ "$(jq -c '[.units[] | select(.current_session) | .id] | sort' <<<"$output")" = '["app:Ghostty","pid:310","pid:313","shells"]' ]
  triage
  [ "$(jq -c '[.units[] | select(.current_session)] | length' <<<"$output")" = "0" ]
}

@test "塊はメモリの大きい順に並び、--top の数だけ出る" {
  run bash "$SCRIPT" --from "$FIX" --top 3
  [ "$status" -eq 0 ]
  [ "$(jq -c '[.units[].id]' <<<"$output")" = '["app:OrbStack","app:Dia","app:Claude"]' ]
  [ "$(jq -r .summary.units <<<"$output")" = "21" ]
}

@test "summary は top のヘッダ・swap・memory_pressure から読む" {
  triage
  [ "$(jq -c '.summary | [.used, .compressor, .swap_used, .swap_total, .free_percent, .processes]' <<<"$output")" = '["31G","10G","2G","3G",54,41]' ]
}

@test "lsof の作業ディレクトリが塊の根に付き、引けなかった根は null になる" {
  triage
  [ "$(jq -r .root.cwd <<<"$(unit pid:110)")" = "/Users/x/proj-a" ]
  [ "$(jq -r .root.cwd <<<"$(unit pid:313)")" = "null" ]
}

@test "引数の誤りは exit 2" {
  run bash "$SCRIPT" --top 0 --from "$FIX"
  [ "$status" -eq 2 ]
  run bash "$SCRIPT" --kill
  [ "$status" -eq 2 ]
  run bash "$SCRIPT" --self 313
  [ "$status" -eq 2 ]
}
