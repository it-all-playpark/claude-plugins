#!/usr/bin/env bash
# local-verify.sh - repo が skill-config.json の "dev-flow".local_verify に宣言した検証コマンド（E2E 等）を、
# pg-broker に頼んだ使い捨ての Postgres に向けてバックグラウンドで実行する（issue #863）。
#
# dev-flow は ci の AC（ci_verify で CI の check が判定する AC）がある run で、Validate が green になった後に
# これを呼び、exit 0 ならその AC を satisfied にする（PR を出した後の CI 待ち 1 往復を省く）。
# 宣言コマンドは worktree のコードを実行するので、呼び出し元と同じ sandbox 内で動かす
# （本スクリプトを sandbox の excludedCommands に入れない — 入れると worktree の任意コードが sandbox 外で動く）。
#
# 宣言は --config-pct（JSON を percent-encoding した 1 トークン）か --config（JSON ファイル）でだけ受け取り、どちらも
# 無ければ error。dev-flow は Setup 時に検証した宣言（prerun が origin/<base> と user 設定から読んだ skill-config の
# "dev-flow".local_verify）を --config-pct で渡す。worktree の設定ファイルは読まない — 実装中に書き換えた宣言を
# 判定に使わないことは、読み先を PR の外に置くことで保つ:
#   "dev-flow": { "local_verify": {
#     "command": "pnpm test:e2e:local",              # worktree を cwd に bash -c で実行する
#     "db": { "engine": "postgres", "version": "17" }, # pg-broker create --version に渡す
#     "env": "E2E_EXTERNAL_DATABASE_URL",             # database_url を入れて command に渡す環境変数名
#     "timeout_seconds": 1500,                        # command の上限。超えたら止めて timeout
#     "expect_paths": ["out/index.html"]              # 省略可。command が exit 0 でも、終了後に worktree に無い・
#   } }                                               #   command の開始より前から更新されていないものがあれば failed
#
# expect_paths はその実行で作られた・更新されたことまで確かめる（mtime が command の開始以後）。前の実行や implementer が
# 残したファイルがあるだけで、生成を求めた AC を exit 0 で通さないため。
# db の無い宣言（{command, timeout_seconds, expect_paths?}）は pg-broker を呼ばずに command を実行する（env も渡さない）。
# dev-flow はこれで AC 自体が inline code で指定したコマンドを実行する（issue #1208。AC の文面から凍結した値を
# --config-pct で渡す）。
#
# paths（repo 相対の glob の配列。省略可）のある宣言は基準画像の撮影（"dev-flow".visual_snapshots。issue #1410）で、command が
# worktree に残してよい変化を「paths の下の PNG」（git の pathspec `:(glob)<path>/**/*.png`）だけに限る。command の前後で
# worktree 全体の tree（staged + unstaged + untracked。.gitignore は尊重）を比べ、次のどれかなら、その実行が変えたファイルを
# すべて command の前の内容に戻す（追跡ファイルの変更・削除は書き戻し、新しいファイルは消す。実 index は書かない）:
#   - command が exit 非 0・timeout・stop / TERM で終わった（途中まで書かれた PNG を残さない）
#   - exit 0 でも paths の下の PNG 以外が変わった（failed にし、reason と snapshot.outside に変わったパスを出す）
# 戻すのは supervisor で、結果の JSON に snapshot: {tree_before, tree, discarded, restored, outside, outside_count} を足す
# （tree は終了後の worktree の tree OID。discarded:true は結果を捨てた、restored:false は戻し切れなかった）。
# command は PR のコードなので、PNG 以外に書いたものを評価される tree と PR に入れない。state dir が worktree の中に
# あるときは git に無視されている必要がある（無視されていなければ error。state dir 自身が変化に数えられる）。
#
# プロセスモデル:
#   切り離し実行（detached supervisor・状態ファイル・上限時間・stop・wait）は _lib/scripts/bg-job.sh が持ち、ここは
#   宣言の読み込み・DB の確保と削除・環境変数・expect_paths を hook で載せる。DB の確保と削除も supervisor が行う。
#   DB の DELETE は supervisor の EXIT trap で必ず呼ぶ
#   — stop が呼ばれずに command が終わっても、timeout でも、supervisor が TERM / INT で止められても消す。
#
# 出力契約: start / wait / stop は常に exit 0 + stdout に JSON 1 行。usage error のみ exit 2。
#   1 回の Bash 呼び出し（上限 600 秒）に収まるよう、start は DB 確保まで最大 --wait-sec（既定 300）、
#   wait は最大 --wait-sec（既定 480）だけ待ち、終わっていなければ status:"running" を返す。
#   status: running（まだ実行中）/ passed（exit 0）/ failed（exit 非 0・exit 0 でも expect_paths が無い・古い — reason 付き）/
#           timeout（timeout_seconds 超過で停止）/
#           stopped（stop で停止）/ unavailable（pg-broker に届かない・DB を確保できない）/ error（宣言不正等）
#
# Usage:
#   local-verify start --worktree <abs> --state-dir <abs> [--config-pct <percent-encoded json> | --config <json file>] [--wait-sec <n=300>]
#   local-verify wait  --state-dir <abs> [--wait-sec <n=480>]
#   local-verify stop  --state-dir <abs> [--timeout-sec <n=60>]
#   （内部）local-verify supervise --state-dir <abs>
#
# LOCAL_VERIFY_PG_BROKER（pg-broker の実体）と LOCAL_VERIFY_POLL_SEC（状態確認の間隔）は bats が
# broker をスタブにし、短い間隔で回すための上書き口（workflow は渡さない）。
set -uo pipefail

SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
# shellcheck source=../../_lib/scripts/bg-job.sh
source "$(dirname "$SELF")/../../_lib/scripts/bg-job.sh"
BG_JOB_NAME=local-verify
BG_JOB_SELF="$SELF"
BG_JOB_POLL_SEC="${LOCAL_VERIFY_POLL_SEC:-1}"
BROKER="${LOCAL_VERIFY_PG_BROKER:-pg-broker}"

usage() { echo "local-verify: $1" >&2; exit 2; }

paths() {
    bg_job_paths "$1"
    DB_DELETED="$BG_JOB_STATE_DIR/db-deleted.json"
    BROKER_CREATE_OUT="$BG_JOB_STATE_DIR/broker-create.out"
    BROKER_CREATE_ERR="$BG_JOB_STATE_DIR/broker-create.err"
    # command を起こす直前に作る印。expect_paths がこれより古ければ、その実行で作られた・更新されたものではない
    CMD_STARTED="$BG_JOB_STATE_DIR/command-started"
    # paths のある宣言: command の前の tree OID・paths の下の PNG 以外で変わったパス・撮影の決着（受け入れた / 捨てた）
    SNAP_BEFORE="$BG_JOB_STATE_DIR/snapshot-before"
    SNAP_OUTSIDE="$BG_JOB_STATE_DIR/snapshot-outside"
    SNAP_RESULT="$BG_JOB_STATE_DIR/snapshot.json"
}

# ---------------------------------------------------------------------------
# config
# ---------------------------------------------------------------------------

# --config-pct の値（JSON を percent-encoding した 1 トークン）を戻す。形が違えば 1 を返す。
decode_pct() {
    local s="$1"
    [[ "$s" =~ ^[A-Za-z0-9._%-]+$ ]] || return 1
    printf '%b' "${s//%/\\x}"
}

# 宣言（--config-pct か --config）を読み、形を検証して spec に書く。不正・どちらも無ければ理由を stdout に 1 行出して 1 を返す。
load_config() {
    local worktree="$1" config_path="$2" config_pct="$3" raw=''
    if [[ -n "$config_pct" ]]; then
        local decoded
        decoded="$(decode_pct "$config_pct")" || { echo '--config-pct が percent-encoding の形でない'; return 1; }
        raw="$(jq -c '.' <<<"$decoded" 2>/dev/null)" || { echo '--config-pct を JSON として読めない'; return 1; }
    elif [[ -n "$config_path" ]]; then
        raw="$(jq -c '.' "$config_path" 2>/dev/null)" || { echo "--config を JSON として読めない: $config_path"; return 1; }
    else
        echo '宣言が無い（--config-pct か --config で local_verify の宣言を渡す）'; return 1
    fi
    local problem
    problem="$(jq -r '
        if type != "object" then "local_verify が object でない"
        elif (.command | type) != "string" or (.command | test("^\\s*$")) then "command が空でない string でない"
        elif .expect_paths != null and (.expect_paths | type) != "array" then "expect_paths が配列でない"
        elif (.expect_paths // []) | any(type != "string" or test("^\\s*$") or startswith("/") or (split("/") | map(select(. == "..")) | length > 0)) then "expect_paths に worktree からの相対パスでないもの（/ 始まり・.. を含む）がある"
        elif .paths != null and ((.paths | type) != "array" or (.paths | length) == 0 or (.paths | any(type != "string" or test("^\\s*$") or startswith("/") or (split("/") | any(. == ".."))))) then "paths が worktree からの相対パスの空でない配列でない（/ 始まり・.. を含むものは不可）"
        elif .db != null and ((.db | type) != "object" or .db.engine != "postgres") then "db.engine が \"postgres\" でない"
        elif .db != null and ((.db.version | type) != "string" or (.db.version | test("^\\s*$"))) then "db.version が空でない string でない"
        elif .db != null and ((.env | type) != "string" or (.env | test("^[A-Za-z_][A-Za-z0-9_]*$") | not)) then "env が環境変数名でない"
        elif (.timeout_seconds | type) != "number" or .timeout_seconds <= 0 or (.timeout_seconds | floor) != .timeout_seconds then "timeout_seconds が正の整数でない"
        else empty end' <<<"$raw")"
    [[ -z "$problem" ]] || { echo "local_verify の宣言が不正: $problem"; return 1; }
    bg_job_write_json "$BG_JOB_SPEC" --arg cwd "$worktree" --argjson cfg "$raw" \
        '{cwd: $cwd, command: $cfg.command, engine: $cfg.db.engine, version: $cfg.db.version, env: $cfg.env, timeout_seconds: $cfg.timeout_seconds, expect_paths: ($cfg.expect_paths // []), snapshot_paths: ($cfg.paths // [])}'
}

# ---------------------------------------------------------------------------
# paths のある宣言（基準画像の撮影）: command が残してよい変化を paths の下の PNG に限る
# ---------------------------------------------------------------------------

# worktree 全体（staged + unstaged + untracked。.gitignore は尊重）の tree OID。取れなければ何も出さない。
snapshot_tree() {
    "$(dirname "$SELF")/worktree-diff-hash.sh" "$1" HEAD 2>/dev/null | jq -r '.hash // empty' 2>/dev/null
}

# tree $2 → $3 で変わったパスのうち、paths の下の PNG でないものを 1 行 1 件で出す。
snapshot_outside() {
    local wt="$1" p specs=(':(top)') list
    list="$(jq -r '.snapshot_paths[]?' "$BG_JOB_SPEC" 2>/dev/null)"
    while IFS= read -r p; do
        while [[ "$p" == */ ]]; do p="${p%/}"; done
        [[ -n "$p" ]] || continue
        specs+=(":(top,exclude,glob)$p/**/*.png")
    done <<<"$list"
    git -C "$wt" -c core.quotePath=false diff --name-only --no-renames "$2" "$3" -- "${specs[@]}"
}

# worktree を tree $2 の内容に戻す（今の tree との差分だけ。$2 に無いファイルは消し、あるものは書き戻す）。
# 一時 index から checkout-index で書くので実 index は書かない。戻した後の tree が $2 と一致したら 0。
snapshot_restore() {
    local wt="$1" before="$2" now p
    local idx="$BG_JOB_STATE_DIR/snapshot-index" added="$BG_JOB_STATE_DIR/snapshot-added" changed="$BG_JOB_STATE_DIR/snapshot-changed"
    now="$(snapshot_tree "$wt")"
    [[ -n "$now" ]] || return 1
    [[ "$now" != "$before" ]] || return 0
    git -C "$wt" diff --name-only --no-renames -z --diff-filter=A "$before" "$now" >"$added" || return 1
    while IFS= read -r -d '' p; do rm -f -- "$wt/$p"; done <"$added"
    git -C "$wt" diff --name-only --no-renames -z --diff-filter=a "$before" "$now" >"$changed" || return 1
    if [[ -s "$changed" ]]; then
        rm -f "$idx"
        GIT_INDEX_FILE="$idx" git -C "$wt" read-tree "$before" || return 1
        GIT_INDEX_FILE="$idx" git -C "$wt" checkout-index -f -z --stdin <"$changed" || return 1
    fi
    [[ "$(snapshot_tree "$wt")" == "$before" ]]
}

# command が exit 0 で終わった後: paths の下の PNG 以外が変わっていれば理由を出す（failed になり、snapshot_settle が戻す）。
# 変わっていなければその撮影を受け入れる（SNAP_RESULT を書く — 以後 snapshot_settle は何もしない）。
snapshot_check() {
    [[ -f "$SNAP_BEFORE" ]] || return 0
    local wt before after outside
    wt="$(bg_job_read_field "$BG_JOB_SPEC" .cwd)"
    before="$(cat "$SNAP_BEFORE")"
    after="$(snapshot_tree "$wt")"
    if [[ -z "$after" ]]; then echo 'command は exit 0 だが、終了後の worktree の tree を取れず、変わったファイルを確かめられない'; return 0; fi
    if ! outside="$(snapshot_outside "$wt" "$before" "$after")"; then echo 'command は exit 0 だが、command の前後の差分を取れず、変わったファイルを確かめられない'; return 0; fi
    if [[ -n "$outside" ]]; then
        printf '%s\n' "$outside" >"$SNAP_OUTSIDE"
        echo "command は exit 0 だが paths の下の PNG 以外を変えた: $(head -n 5 "$SNAP_OUTSIDE" | tr '\n' ' ' | sed 's/ *$//')"
        return 0
    fi
    bg_job_write_json "$SNAP_RESULT" --arg before "$before" --arg tree "$after" \
        '{tree_before: $before, tree: $tree, discarded: false, restored: null, outside: [], outside_count: 0}'
}

# 受け入れなかった撮影（失敗・timeout・stop・paths の下の PNG 以外の変化）を捨て、worktree を command の前に戻す。
# cleanup（正常経路と EXIT trap）と stop から呼ばれるので、決着済み（SNAP_RESULT あり）なら何もしない。
snapshot_settle() {
    [[ -f "$SNAP_BEFORE" && ! -f "$SNAP_RESULT" ]] || return 0
    local wt before tree restored=false outside='[]'
    wt="$(bg_job_read_field "$BG_JOB_SPEC" .cwd)"
    before="$(cat "$SNAP_BEFORE")"
    if snapshot_restore "$wt" "$before"; then restored=true; tree="$before"; else tree="$(snapshot_tree "$wt")"; fi
    [[ -f "$SNAP_OUTSIDE" ]] && outside="$(jq -Rnc '[inputs | select(. != "")]' "$SNAP_OUTSIDE" 2>/dev/null || echo '[]')"
    bg_job_write_json "$SNAP_RESULT" --arg before "$before" --arg tree "$tree" --argjson restored "$restored" --argjson outside "$outside" \
        '{tree_before: $before, tree: (if $tree == "" then null else $tree end), discarded: true, restored: $restored, outside: $outside[0:20], outside_count: ($outside | length)}'
}

# ---------------------------------------------------------------------------
# bg-job の hook（DB の確保 → command の環境変数 → expect_paths → DB の削除）
# ---------------------------------------------------------------------------

DB_ID=''
DB_URL=''

# DB を消す。EXIT trap と正常経路の両方から呼ばれるので 1 回だけ実行する。
delete_db() {
    [[ -n "$DB_ID" ]] || return 0
    local id="$DB_ID" out rc
    DB_ID=''
    out="$("$BROKER" delete "$id" 2>&1)"; rc=$?
    if (( rc == 0 )); then
        bg_job_write_json "$DB_DELETED" --arg id "$id" '{id: $id, ok: true}'
    else
        bg_job_write_json "$DB_DELETED" --arg id "$id" --arg error "$out" '{id: $id, ok: false, error: $error}'
    fi
}

bg_job_hook_prepare() {
    local version out rc reason
    # db の無い宣言は DB を確保せず、env も渡さずに command を実行する
    if [[ -n "$(bg_job_read_field "$BG_JOB_SPEC" .engine)" ]]; then
        version="$(bg_job_read_field "$BG_JOB_SPEC" .version)"

        # broker に届かない（未インストール・停止中）・DB を確保できないときは unavailable で終える。
        # 呼び出し側（dev-flow）はこれを fail-open にして CI の check の結果で判定する。
        "$BROKER" create --version "$version" >"$BROKER_CREATE_OUT" 2>"$BROKER_CREATE_ERR"; rc=$?
        out="$(cat "$BROKER_CREATE_OUT" 2>/dev/null)"
        if (( rc != 0 )); then
            reason="$(tail -n 3 "$BROKER_CREATE_ERR" 2>/dev/null | tr '\n' ' ' | sed 's/ *$//')"
            [[ -n "$reason" ]] || reason="pg-broker create が exit $rc"
            bg_job_abort unavailable "$reason"
        fi
        DB_ID="$(jq -r '.id // empty' <<<"$out" 2>/dev/null)"
        DB_URL="$(jq -r '.database_url // empty' <<<"$out" 2>/dev/null)"
        if [[ -z "$DB_ID" || -z "$DB_URL" ]]; then
            bg_job_abort unavailable "pg-broker create の応答に id / database_url が無い: ${out:0:200}"
        fi
        bg_job_set_phase preparing --arg db_id "$DB_ID"
    fi
    if [[ "$(jq -r '.snapshot_paths | length' "$BG_JOB_SPEC" 2>/dev/null)" != 0 ]]; then
        local wt before
        wt="$(bg_job_read_field "$BG_JOB_SPEC" .cwd)"
        case "$BG_JOB_STATE_DIR/" in
            "$wt/"*) git -C "$wt" check-ignore -q "$BG_JOB_STATE_DIR" 2>/dev/null \
                || bg_job_abort error "--state-dir ($BG_JOB_STATE_DIR) が worktree の中にあり git に無視されていない — paths のある宣言は実行しない" ;;
        esac
        before="$(snapshot_tree "$wt")"
        [[ -n "$before" ]] || bg_job_abort error 'command の前の worktree の tree を取れない（git の worktree でない等）— paths のある宣言は実行しない'
        printf '%s' "$before" >"$SNAP_BEFORE"
    fi
    : >"$CMD_STARTED"
}

bg_job_hook_command_env() {
    [[ -z "$DB_URL" ]] || export "$(bg_job_read_field "$BG_JOB_SPEC" .env)=$DB_URL"
}

# expect_paths: exit 0 でも、宣言したファイルが終了後の worktree に無い・command の開始より前から更新されていなければ
# failed（理由は log にも残し、log_tail で返す）。mtime が開始の印と同じものはその実行の更新と読む（秒精度の fs で
# 開始と同じ秒に書かれた生成物を古いと誤判定しないため）
bg_job_hook_check_success() {
    local worktree missing='' stale='' p paths_list snap
    snap="$(snapshot_check)"
    if [[ -n "$snap" ]]; then echo "$snap"; return 0; fi
    worktree="$(bg_job_read_field "$BG_JOB_SPEC" .cwd)"
    paths_list="$(jq -r '.expect_paths[]?' "$BG_JOB_SPEC" 2>/dev/null)"
    while IFS= read -r p; do
        [[ -n "$p" ]] || continue
        if [[ ! -e "$worktree/$p" ]]; then missing+="${missing:+, }$p"
        elif [[ "$CMD_STARTED" -nt "$worktree/$p" ]]; then stale+="${stale:+, }$p"
        fi
    done <<<"$paths_list"
    [[ -n "$missing" || -n "$stale" ]] || return 0
    local reason="command は exit 0 だが"
    [[ -z "$missing" ]] || reason+=" expect_paths が worktree に無い: $missing"
    [[ -z "$missing" || -z "$stale" ]] || reason+=" /"
    [[ -z "$stale" ]] || reason+=" expect_paths がこの実行で作られて・更新されていない（command の開始より前のまま）: $stale"
    echo "$reason"
}

bg_job_hook_cleanup() {
    snapshot_settle
    # pg-broker create の途中で TERM を受けると、create が返った後・DB_ID を代入する前に trap が走る。
    # create の応答は file に残しているので、そこから id を拾って消す。
    if [[ -z "$DB_ID" && ! -f "$DB_DELETED" ]]; then
        DB_ID="$(jq -r '.id // empty' "$BROKER_CREATE_OUT" 2>/dev/null)"
    fi
    delete_db
}

# supervisor が KILL 等で trap を走らせずに居なくなったときは、stop がここで DB を消す
bg_job_hook_orphan_cleanup() {
    # start が前の実行を止めるとき（SNAP_KEEP_ORPHAN）は戻さない — 前の実行の後に入った変更（差し戻しの実装）まで巻き戻すため
    [[ -n "${SNAP_KEEP_ORPHAN:-}" ]] || snapshot_settle
    [[ ! -f "$DB_DELETED" ]] || return 0
    DB_ID="$(bg_job_read_field "$BG_JOB_STATE" .db_id)"
    delete_db
}

bg_job_hook_extra_fields() {
    local deleted='null' snapshot='null'
    [[ -f "$DB_DELETED" ]] && deleted="$(jq -c '.ok' "$DB_DELETED" 2>/dev/null || echo null)"
    [[ -f "$SNAP_RESULT" ]] && snapshot="$(jq -c '.' "$SNAP_RESULT" 2>/dev/null || echo null)"
    bg_job_emit --argjson db_deleted "$deleted" --argjson snapshot "$snapshot" \
        '{db_deleted: $db_deleted} + (if $snapshot != null then {snapshot: $snapshot} else {} end)'
}

# ---------------------------------------------------------------------------
# start
# ---------------------------------------------------------------------------

cmd_start() {
    local worktree="$1" config_path="$2" wait_sec="$3" config_pct="$4"
    # 前回 run の残り（同じ state dir）を先に止める
    SNAP_KEEP_ORPHAN=1
    bg_job_reset "$worktree" || return 0
    local problem
    if ! problem="$(load_config "$worktree" "$config_path" "$config_pct")"; then
        bg_job_emit --arg error "$problem" '{ok: false, status: "error", error: $error}'
        return
    fi
    if [[ -n "$(bg_job_read_field "$BG_JOB_SPEC" .engine)" ]] && ! command -v "$BROKER" >/dev/null 2>&1; then
        bg_job_emit --arg reason "pg-broker が PATH に無い（${BROKER}）" '{ok: false, status: "unavailable", reason: $reason}'
        return
    fi
    bg_job_start "$wait_sec"
}

# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

main() {
    local sub="${1:-}"
    [[ -n "$sub" ]] || usage 'subcommand (start|wait|stop) required'
    shift
    local state_dir='' worktree='' config_path='' config_pct='' wait_sec='' timeout_sec=''
    while (( $# > 0 )); do
        (( $# >= 2 )) || usage "Unknown or incomplete option: $1"
        case "$1" in
            --state-dir) state_dir="$2" ;;
            --worktree) worktree="$2" ;;
            --config) config_path="$2" ;;
            --config-pct) config_pct="$2" ;;
            --wait-sec) wait_sec="$2" ;;
            --timeout-sec) timeout_sec="$2" ;;
            *) usage "Unknown option: $1" ;;
        esac
        shift 2
    done
    [[ -n "$state_dir" ]] || usage '--state-dir is required'
    [[ -z "$wait_sec" || "$wait_sec" =~ ^[0-9]+$ ]] || usage "--wait-sec must be a non-negative integer, got '$wait_sec'"
    [[ -z "$timeout_sec" || "$timeout_sec" =~ ^[0-9]+$ ]] || usage "--timeout-sec must be a non-negative integer, got '$timeout_sec'"
    mkdir -p "$state_dir" 2>/dev/null
    paths "$(cd "$state_dir" 2>/dev/null && pwd || echo "$state_dir")"

    case "$sub" in
        supervise) bg_job_supervise ;;
        start)
            [[ -n "$worktree" ]] || usage '--worktree is required'
            cmd_start "$(cd "$worktree" 2>/dev/null && pwd || echo "$worktree")" "$config_path" "$wait_sec" "$config_pct" ;;
        wait) bg_job_wait "$wait_sec" ;;
        stop) bg_job_stop "$timeout_sec" ;;
        *) usage "unknown subcommand: $sub" ;;
    esac
}

main "$@"
