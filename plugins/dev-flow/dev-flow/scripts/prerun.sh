#!/usr/bin/env bash
# prerun.sh - dev-flow Setup phase の決定論処理を 1 コマンドに集約する (issue #641)
#
# top-level Bash が bare 名 launcher (bin/dev-flow-prerun) 経由でこのスクリプトを実行する。ok:true なら
# stdout と同じ JSON を <worktree>/.devflow-tmp/prerun-setup.json にも書き、wrapper は続けて別の Bash 呼び出しで
# `ensure-worktree-deps --setup <そのファイル>` を実行して、その stdout（deps / epoch_end を足した setup）を
# `Workflow({ args: { issue, setup: <JSON> } })` の args.setup へそのまま渡す。
#
# 行う処理: base 解決 (origin/dev → origin/HEAD フォールバック) → worktree 作成/再利用 +
# 起点(base)一致検証 + 独自コミット無しの再利用 worktree を base へ fast-forward + 書き込み probe →.devflow-tmp の git clean -fdx → analyze
# （issue 取得 + contract parse + Jev 有界判定。prerun-analyze.sh。detect-stack と並列）‖
# detect-stack（+ detect-test-runner の受理パターンを stack.test_runners に載せる）。各段は独立に ok/error を報告し、後続段を巻き込まない。
# worktree 作成で取り出せないパスには skip-worktree を付け（出力の skip_worktree）、未ステージの削除が残る再利用 worktree は
# ok:false で止める（_shared/scripts/worktree-checkout.sh）。
#
# deps install はここで行わない（issue #868）。install は対象 repo の依存の postinstall（任意コード）を走らせる。
# このスクリプトは repo の任意コードを実行しない — install は wrapper が別の Bash 呼び出しで回す。
#
# sandbox 内で動く。起動元 repo の .git/config は sandbox 内から書けないので、config を書く git を使わない:
# worktree は --no-track で作り（upstream を書かない）、再利用 worktree の起点は upstream ではなく
# branch の reflog の作成記録（`branch: Created from <ref>`）で判定する。
#
# GitHub I/O は analyze 段の `analyze-issue`（GitHub CLI の issue 取得を内蔵）と blocker 判定
# （prerun-analyze.sh の dependencies API / Blocked by 先の issue 状態）、CI 待ちの上限を決める base branch の
# 成功 run の一覧（ci-wait-ceiling.sh が内蔵する run list）の読み取りのみ。
# リモート更新系の書き込みコマンドは持たない（.claude/rules/dev-flow.md 参照）。

set -euo pipefail

# _lib/common.sh は playpark-core plugin にある。core の bin/journal（PATH）を起点に解決する（plugin 境界を ../ で跨がない）
_CORE_BIN="$(command -v journal)" || { echo "playpark-core plugin (bin/journal) not on PATH" >&2; exit 127; }
source "$(dirname "$_CORE_BIN")/../_lib/common.sh"

has_jq || { echo "jq is required" >&2; exit 127; }

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=../../_shared/scripts/worktree-checkout.sh
source "$PLUGIN_ROOT/_shared/scripts/worktree-checkout.sh"
# shellcheck source=../../_shared/scripts/ci-wait-ceiling.sh
source "$PLUGIN_ROOT/_shared/scripts/ci-wait-ceiling.sh"
# shellcheck source=../../_shared/scripts/security-reviewer-config.sh
source "$PLUGIN_ROOT/_shared/scripts/security-reviewer-config.sh"

usage() {
    echo "Usage: dev-flow-prerun --issue <N> --worktree <abs-path> [--base <ref>]" >&2
}

# ============================================================================
# Args
# ============================================================================

ISSUE=""
WT=""
BASE_ARG=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --issue)
            [[ $# -ge 2 ]] || { usage; exit 2; }
            ISSUE="$2"; shift 2 ;;
        --worktree)
            [[ $# -ge 2 ]] || { usage; exit 2; }
            WT="$2"; shift 2 ;;
        --base)
            [[ $# -ge 2 ]] || { usage; exit 2; }
            BASE_ARG="$2"; shift 2 ;;
        *)
            echo "Unknown option: $1" >&2
            usage
            exit 2 ;;
    esac
done

[[ -n "$ISSUE" ]] || { echo "--issue is required" >&2; usage; exit 2; }
[[ "$ISSUE" =~ ^[1-9][0-9]*$ ]] || { echo "--issue must be a positive integer" >&2; exit 2; }
[[ -n "$WT" ]] || { echo "--worktree is required" >&2; usage; exit 2; }
[[ "$WT" == /* ]] || { echo "--worktree must be an absolute path" >&2; exit 2; }
if [[ -n "$BASE_ARG" ]]; then
    [[ "$BASE_ARG" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]] || {
        echo "--base contains invalid characters (allowed: [A-Za-z0-9][A-Za-z0-9._/-]*)" >&2
        exit 2
    }
fi

# ============================================================================
# ROOT resolution (main worktree is always the first block; cwd may be any worktree)
# ============================================================================

WTLIST_RAW="$(git worktree list --porcelain 2>&1)" || {
    echo "not a git repository (git worktree list failed): ${WTLIST_RAW}" >&2
    exit 2
}
ROOT="$(printf '%s\n' "$WTLIST_RAW" | awk '/^worktree /{print substr($0,10); exit}')"
[[ -n "$ROOT" ]] || { echo "failed to resolve git root from worktree list" >&2; exit 2; }

# git worktree list --porcelain はディレクトリの物理パス (シンボリックリンク解決済み) を報告する
# (macOS の /var -> /private/var 等)。引数 --worktree は raw のまま JSON へ出力する契約
# (常に引数値) だが、既存 worktree ブロックとの突合せだけはこの物理パスで行う。
canon_path() {
    local p="$1" dir base
    if [[ -e "$p" ]]; then
        (cd "$p" 2>/dev/null && pwd -P) || printf '%s' "$p"
    else
        dir="$(dirname "$p")"
        base="$(basename "$p")"
        if [[ -d "$dir" ]]; then
            printf '%s/%s' "$(cd "$dir" && pwd -P)" "$base"
        else
            printf '%s' "$p"
        fi
    fi
}

RECOVERY_STEPS_FOR() {
    local wt="$1" base_name="$2"
    printf 'このいずれかで復旧して再実行せよ: (1) git worktree remove %s（失敗時は --force）で当該 worktree を削除して dev-flow を再実行する（origin/%s 起点で作り直される）、(2) 既存 worktree の起点を意図しているなら --base を明示して一致させて再実行する。' "$wt" "$base_name"
}

# ============================================================================
# Segment 0: repo (owner/name) resolution — best-effort, independent of other segments
# ============================================================================

# epoch は run の clock mark `start`（duration_seconds の起点）と isolation-probe token の給電元。
# Setup 開始時点（fetch・worktree 作成・後続の deps install より前）で採る — 後で採ると npm ci 等の
# 数分が duration_seconds から抜け、着手前後の journal 比較が同条件でなくなる
epoch="$(date +%s)"

repo=""
ORIGIN_URL="$(git -C "$ROOT" remote get-url origin 2>/dev/null)" || ORIGIN_URL=""
REPO_BODY=""
if [[ "$ORIGIN_URL" =~ ^https://github\.com/(.+)$ ]]; then
    REPO_BODY="${BASH_REMATCH[1]}"
elif [[ "$ORIGIN_URL" =~ ^git@github\.com:(.+)$ ]]; then
    REPO_BODY="${BASH_REMATCH[1]}"
elif [[ "$ORIGIN_URL" =~ ^ssh://git@github\.com/(.+)$ ]]; then
    REPO_BODY="${BASH_REMATCH[1]}"
fi
if [[ -n "$REPO_BODY" ]]; then
    REPO_BODY="${REPO_BODY%/}"
    REPO_BODY="${REPO_BODY%.git}"
    if [[ "$REPO_BODY" =~ ^([^/]+)/([^/]+)$ ]]; then
        repo="${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"
    fi
fi

# plugin_commit: 実行中の dev-flow plugin の commit（12 桁 hex）。telemetry 記録専用で gate の入力にしない。
# 決められなければ null（fail-open）
plugin_commit="$(bash "$PLUGIN_ROOT/dev-flow/scripts/plugin-commit.sh" "$PLUGIN_ROOT" 2>/dev/null)" || plugin_commit=""

# ============================================================================
# Segment 1: base resolution
# ============================================================================

base=""
base_source=""
base_error=""
BASE_OK=false

if FETCH_OUT="$(git -C "$ROOT" fetch origin --quiet 2>&1)"; then
    if [[ -n "$BASE_ARG" ]]; then
        if git -C "$ROOT" ls-remote --exit-code --heads origin "refs/heads/$BASE_ARG" >/dev/null 2>&1; then
            base="$BASE_ARG"
            base_source="explicit"
            BASE_OK=true
        else
            base_error="指定された base origin/${BASE_ARG} が origin に存在しない"
        fi
    else
        if git -C "$ROOT" ls-remote --exit-code --heads origin "refs/heads/dev" >/dev/null 2>&1; then
            base="dev"
            base_source="origin/dev"
            BASE_OK=true
        else
            HEAD_REF="$(git -C "$ROOT" ls-remote --symref origin HEAD 2>/dev/null | awk '/^ref:/{sub("refs/heads/","",$2); print $2; exit}')"
            if [[ -n "$HEAD_REF" ]]; then
                base="$HEAD_REF"
                base_source="origin/HEAD"
                BASE_OK=true
            else
                base_error="origin/dev が存在せず origin/HEAD の default branch も取得できない"
            fi
        fi
    fi
else
    base_error="git fetch origin failed: ${FETCH_OUT}"
fi

# ci_wait_ceiling_seconds: nested pr-iterate の CI 待ちの上限（秒）。PR の base（= 上で解決した base）の
# CI 所要時間から決める（pr-iterate-prerun と同じ ci-wait-ceiling.sh）。base 未解決・run 一覧の読み取り失敗は 300
ci_wait_ceiling_seconds="$CI_WAIT_CEILING_DEFAULT"
if [[ "$BASE_OK" == true ]]; then
    ci_wait_ceiling_seconds="$(ci_wait_ceiling "$base" "$repo")"
fi

# security_reviewer: nested pr-iterate の security review を回す CLI の opt-in（"dev-flow".security_reviewer）。
# pr-iterate-prerun と同じ security-reviewer-config.sh で、解決した base の origin/<base> と user 設定から読む。
# worktree（PR head になる作業ツリー）の設定ファイルは読まない。値の検証は workflow（_lib/prerun-setup.mjs）が行う
security_reviewer="$(security_reviewer_config "$ROOT" "$base")"

# ============================================================================
# Segment 2: worktree create/reuse + base-origin match verification + write probe
# ============================================================================

BRANCH="feature/issue-${ISSUE}"
worktree_status=""
worktree_error=""
worktree_removed=false
head=""
SEG2_OK=false

validate_start_point() {
    # branch の起点を reflog の最古の記録（`branch: Created from <ref>`）で判定する。sets global worktree_error on mismatch.
    # origin/feature/issue-<N> は pr-iterate-prerun が PR head から作った branch。
    local br="$1" created start="" expected pushed
    created="$(git -C "$ROOT" log -g --format=%gs "refs/heads/${br}" -- 2>/dev/null | tail -n 1)" || created=""
    if [[ "$created" == "branch: Created from "* ]]; then
        start="${created#branch: Created from }"
    fi
    expected="origin/${base}"
    pushed="origin/feature/issue-${ISSUE}"
    if [[ "$start" == "$expected" || "$start" == "$pushed" ]]; then
        return 0
    fi
    if [[ -z "$start" ]]; then
        worktree_error="既存 worktree の起点を判定できなかった（branch ${br} の reflog に作成記録が無い）。期待する起点: ${expected}。$(RECOVERY_STEPS_FOR "$WT" "$base")"
    else
        worktree_error="既存 worktree の起点が一致しない。実際の起点: ${start} / 期待する起点: ${expected}。$(RECOVERY_STEPS_FOR "$WT" "$base")"
    fi
    return 1
}

fast_forward_reused() {
    # 独自コミット 0 件・未コミット変更なしの再利用 worktree を origin/<base>（冒頭の fetch で更新済み）へ
    # 進める。古い起点のまま run を始めると、その間に base へ入った変更と conflict した PR を作るため。
    # 独自コミット / 未コミット変更があれば作業中とみなし触らない。ff 失敗は fail-closed（worktree_error）。
    local ahead dirty behind ff_out
    ahead="$(git -C "$WT" rev-list --count "origin/${base}..HEAD" 2>&1)" || {
        worktree_error="再利用 worktree の独自コミット数を判定できなかった: ${ahead}"
        return 1
    }
    [[ "$ahead" == "0" ]] || return 0
    dirty="$(git -C "$WT" status --porcelain --untracked-files=all -- . ':(exclude).devflow-tmp' 2>&1)" || {
        worktree_error="再利用 worktree の未コミット変更を判定できなかった: ${dirty}"
        return 1
    }
    [[ -z "$dirty" ]] || return 0
    behind="$(git -C "$WT" rev-list --count "HEAD..origin/${base}" 2>&1)" || {
        worktree_error="再利用 worktree の遅れを判定できなかった: ${behind}"
        return 1
    }
    [[ "$behind" == "0" ]] && return 0
    if ! ff_out="$(git -C "$WT" merge --ff-only --quiet "origin/${base}" 2>&1)"; then
        worktree_error="再利用 worktree を origin/${base} へ fast-forward できなかった: ${ff_out}"
        return 1
    fi
    return 0
}

if [[ "$BASE_OK" == true ]]; then
    WTLIST2="$(git -C "$ROOT" worktree list --porcelain 2>&1)" || WTLIST2=""
    CANON_WT="$(canon_path "$WT")"
    BLOCK_INFO="$(printf '%s\n' "$WTLIST2" | awk -v target="worktree ${CANON_WT}" '
        BEGIN { RS=""; FS="\n"; found=0; prunable=0; branch=""; detached=0 }
        {
            if ($1 == target) {
                found=1
                for (i = 2; i <= NF; i++) {
                    if ($i ~ /^branch refs\/heads\//) { b=$i; sub(/^branch refs\/heads\//, "", b); branch=b }
                    else if ($i ~ /^prunable/) prunable=1
                    else if ($i == "detached") detached=1
                }
            }
        }
        END {
            print "FOUND=" found
            print "PRUNABLE=" prunable
            print "BRANCH=" branch
            print "DETACHED=" detached
        }
    ')"

    FOUND=0; PRUNABLE=0; BRANCH_FOUND=""; DETACHED=0
    while IFS='=' read -r k v; do
        case "$k" in
            FOUND) FOUND="$v" ;;
            PRUNABLE) PRUNABLE="$v" ;;
            BRANCH) BRANCH_FOUND="$v" ;;
            DETACHED) DETACHED="$v" ;;
        esac
    done <<<"$BLOCK_INFO"

    CREATED_THIS_CALL=false
    SEG2_CORE_OK=false

    if [[ "$FOUND" == "1" && "$PRUNABLE" == "0" ]]; then
        # (a) 既存 worktree を再利用
        worktree_status="reused"
        if [[ -z "$BRANCH_FOUND" ]]; then
            worktree_error="既存 worktree の起点を判定できなかった（detached HEAD）。$(RECOVERY_STEPS_FOR "$WT" "$base")"
        elif [[ "$BRANCH_FOUND" != "$BRANCH" ]]; then
            # 出力の branch は feature/issue-<N> 固定で下流（pr-iterate の head_ref / fetch）が信頼する。
            # 別 branch を checkout した worktree を ok:true で返すと存在しない branch を指すので fail-closed
            worktree_error="既存 worktree の checkout branch が ${BRANCH} でない（実際: ${BRANCH_FOUND}）。$(RECOVERY_STEPS_FOR "$WT" "$base")"
        else
            if validate_start_point "$BRANCH_FOUND" \
                && worktree_error="$(partial_checkout_error "$WT")" \
                && fast_forward_reused; then
                SEG2_CORE_OK=true
            fi
        fi
    else
        if [[ "$FOUND" == "1" && "$PRUNABLE" == "1" ]]; then
            git -C "$ROOT" worktree prune >/dev/null 2>&1 || true
        fi
        # (c) 未登録: 新規作成経路
        if [[ -d "$WT" ]]; then
            worktree_status="error"
            worktree_error="path exists but is not a registered git worktree: ${WT}"
        elif git -C "$ROOT" show-ref --verify --quiet "refs/heads/${BRANCH}"; then
            if worktree_add "$ROOT" "$WT" "$BRANCH" ""; then
                worktree_status="created"
                CREATED_THIS_CALL=true
                if validate_start_point "$BRANCH"; then
                    SEG2_CORE_OK=true
                fi
            else
                worktree_status="error"
                worktree_error="$WT_ADD_ERR"
            fi
        else
            # origin に同名 branch（close 済み PR の head 等）が残っていると、origin/<base> から作った branch は
            # 履歴を共有せず、PR phase の push（force なし）が non-fast-forward で必ず拒否される。remote の branch は
            # 人の作業・PR の履歴なので消さず、worktree を作る前に止めて回復手順を返す。
            # ls-remote が届かないときは base 解決と同じく先へ進めない（exit 2 = branch 無し だけを作成に倒す）
            remote_rc=0
            git -C "$ROOT" ls-remote --exit-code --heads origin "refs/heads/${BRANCH}" >/dev/null 2>&1 || remote_rc=$?
            if [[ "$remote_rc" -eq 0 ]]; then
                worktree_status="error"
                # (15b) の静的 pin（push を呼ばない）に掛からないよう、表示用コマンドの subcommand は引数で渡す
                worktree_error="$(printf 'origin に branch %s が残っている（close 済み PR の head 等）。origin/%s から作り直すと履歴を共有せず PR の push が non-fast-forward で拒否されるため worktree を作らずに止めた。次のどちらかで回復せよ: (1) この branch の open な PR があれば /pr-iterate <PR> で続ける、(2) 無ければ git %s origin --delete %s で remote の branch を消してから dev-flow を再実行する。' "$BRANCH" "$base" push "$BRANCH")"
            elif [[ "$remote_rc" -ne 2 ]]; then
                worktree_status="error"
                worktree_error="origin に branch ${BRANCH} があるかを git ls-remote で判定できなかった（exit ${remote_rc}）"
            elif worktree_add "$ROOT" "$WT" "$BRANCH" "origin/${base}"; then
                worktree_status="created"
                CREATED_THIS_CALL=true
                SEG2_CORE_OK=true
            else
                worktree_status="error"
                worktree_error="$WT_ADD_ERR"
            fi
        fi
    fi

    if [[ "$SEG2_CORE_OK" == true ]]; then
        # (d) 書き込み probe
        if PROBE_ERR="$( { mkdir -p "$WT/.devflow-tmp" && touch "$WT/.devflow-tmp/.prerun-write-probe" && rm -f "$WT/.devflow-tmp/.prerun-write-probe"; } 2>&1 )"; then
            SEG2_OK=true
            head="$(git -C "$WT" rev-parse HEAD)"
        else
            worktree_status="unwritable"
            worktree_error="$PROBE_ERR"
            if [[ "$CREATED_THIS_CALL" == true ]]; then
                # wrapper は worktree_removed:true を見て repo 外パスで再実行する（二重 checkout 無しの前提）。
                # remove に失敗したのに true を返すと再実行が「already checked out」で落ちるので実結果を載せる
                if REMOVE_ERR="$(git -C "$ROOT" worktree remove --force "$WT" 2>&1)"; then
                    worktree_removed=true
                else
                    worktree_error="${worktree_error}; worktree remove failed: ${REMOVE_ERR}"
                fi
            fi
        fi
    fi
else
    worktree_status="skipped"
    worktree_error="skipped: base unresolved"
fi

# ============================================================================
# Segment 3: .devflow-tmp の git clean -fdx (段2成功時のみ)
# ============================================================================

if [[ "$SEG2_OK" == true ]]; then
    if CLEAN_ERR="$(git -C "$WT" clean -fdx -- .devflow-tmp 2>&1)"; then
        clean_json='{"ok":true}'
    else
        clean_json="$(jq -n --arg e "$CLEAN_ERR" '{ok:false, error:$e}')"
    fi
else
    clean_json='{"ok":false,"error":"skipped: worktree unavailable"}'
fi

# ============================================================================
# Segment 6: analyze (Segment 5 と並列に走らせる。段2 の成否に依存しない)
# ============================================================================

# analyze-issue --contract + Jev 有界判定（prerun-analyze.sh）を detect-stack 等と同時に始める。
# issue 取得と Jev 判定を prerun の中で終えるため、Workflow 側（Setup 末尾の
# analyze ゲート）は args.setup.analyze の whitelist 検証とゲート判定だけになる（通常経路の analyze spawn 0）。
# 失敗（GitHub 到達不能 / JSON 不正）は analyze.ok:false + reason で報告し、Workflow が
# needs_clarification（source=analyze_prerun）に倒す。所要は duration_seconds に載せ、Workflow の
# telemetry では prerun_durations.analyze として記録する（Workflow 側のゲートは phase_durations に区間を持たない）。
ANALYZE_OUT="$(mktemp "${TMPDIR:-/tmp}/dev-flow-prerun-analyze-out.XXXXXX")"
ANALYZE_ARGS=(--issue "$ISSUE")
[[ -n "$repo" ]] && ANALYZE_ARGS+=(--repo "$repo")
(
    a_start="$(date +%s)"
    if ANALYZE_RAW="$("$PLUGIN_ROOT/dev-flow/scripts/prerun-analyze.sh" "${ANALYZE_ARGS[@]}" 2>/dev/null)" \
        && printf '%s' "$ANALYZE_RAW" | jq -e 'type == "object" and (.ok | type == "boolean")' >/dev/null 2>&1; then
        printf '%s' "$ANALYZE_RAW" | jq -c --argjson d "$(( $(date +%s) - a_start ))" '. + {duration_seconds: $d}'
    else
        jq -nc --argjson d "$(( $(date +%s) - a_start ))" \
            '{ok: false, reason: "prerun-analyze.sh failed or returned malformed JSON", analyze_path: "contract", duration_seconds: $d}'
    fi
) >"$ANALYZE_OUT" 2>/dev/null &
ANALYZE_PID=$!

# ============================================================================
# Segment 5: detect-stack (段2成功時のみ)
# ============================================================================

if [[ "$SEG2_OK" == true ]]; then
    STACK_ERR_FILE="$(mktemp "${TMPDIR:-/tmp}/dev-flow-prerun-stack.XXXXXX")"
    if STACK_RAW="$("$PLUGIN_ROOT/_lib/scripts/detect-stack.sh" "$WT" 2>"$STACK_ERR_FILE")" \
        && printf '%s' "$STACK_RAW" | jq -e 'type == "object"' >/dev/null 2>&1; then
        FRAMEWORKS_JSON="$(printf '%s' "$STACK_RAW" | jq -c '[ (.frameworks | if type == "array" then . else [] end)[] | select(type == "string") ]')"
        stack_json="$(jq -n --argjson f "$FRAMEWORKS_JSON" '{frameworks: $f}')"
    else
        STACK_ERR_CONTENT="$(cat "$STACK_ERR_FILE" 2>/dev/null || true)"
        stack_json="$(jq -n --arg e "${STACK_ERR_CONTENT:-detect-stack failed}" '{frameworks: [], error: $e}')"
    fi
    rm -f "$STACK_ERR_FILE"
    # テストランナー判定（redgreen-verify と同じ detect-test-runner.sh）。evaluator prompt の test_files 受理パターンに使う。
    # 判定失敗は test_runners [] — evaluator は test_files を挙げず inspection に倒れる（deterministic 昇格しない側）
    TEST_RUNNERS_JSON="$(bash "$PLUGIN_ROOT/_shared/scripts/detect-test-runner.sh" "$WT" 2>/dev/null \
        | jq -c '[.runners[] | {runner, accept, exclude, command}]' 2>/dev/null)" || TEST_RUNNERS_JSON='[]'
    [[ -n "$TEST_RUNNERS_JSON" ]] || TEST_RUNNERS_JSON='[]'
    stack_json="$(printf '%s' "$stack_json" | jq -c --argjson t "$TEST_RUNNERS_JSON" '. + {test_runners: $t}')"
else
    stack_json='{"frameworks":[],"test_runners":[],"error":"skipped: worktree unavailable"}'
fi

# ============================================================================
# Segment 5b: ci_verify / local_verify (段2成功時のみ)
# ============================================================================

# worktree の skill-config.json / .claude/skill-config.json（前者優先）の "dev-flow".<key> を verbatim で出す。
#   ci_verify: sandbox 内で実行できない検証を CI のどの check で判定するかの repo 側の宣言（issue #861）
#   local_verify: その検証を pg-broker の DB でローカル実行するコマンドの宣言（issue #863）
# 形の検証は workflow 側（_lib/prerun-setup.mjs の normalizeCiVerify / normalizeLocalVerify）が行い、不正なら fail-closed で止める。
# 無い・JSON として読めないファイルは未設定（null）として扱う。
devflow_config_json() {
    local key="$1" rel v
    for rel in skill-config.json .claude/skill-config.json; do
        [[ -f "$WT/$rel" ]] || continue
        v="$(jq -c --arg key "$key" 'if type == "object" and (.["dev-flow"] | type) == "object" then .["dev-flow"][$key] else null end' "$WT/$rel" 2>/dev/null)" || v=''
        if [[ -n "$v" && "$v" != 'null' ]]; then
            printf '%s' "$v"
            return
        fi
    done
    printf 'null'
}
ci_verify_json='null'
local_verify_json='null'
if [[ "$SEG2_OK" == true ]]; then
    ci_verify_json="$(devflow_config_json ci_verify)"
    local_verify_json="$(devflow_config_json local_verify)"
fi

# ============================================================================
# Segment 6 (join): analyze 段の完了を待つ
# ============================================================================

wait "$ANALYZE_PID" || true
analyze_json="$(cat "$ANALYZE_OUT" 2>/dev/null || true)"
rm -f "$ANALYZE_OUT"
if [[ -z "$analyze_json" ]] || ! printf '%s' "$analyze_json" | jq -e 'type == "object" and (.ok | type == "boolean")' >/dev/null 2>&1; then
    analyze_json='{"ok":false,"reason":"prerun-analyze.sh produced no output","analyze_path":"contract","duration_seconds":0}'
fi

# ============================================================================
# Output
# ============================================================================

if [[ "$BASE_OK" == true && "$SEG2_OK" == true ]]; then
    OK_JSON=true
else
    OK_JSON=false
fi

HAVE_REPO=false
[[ -n "$repo" ]] && HAVE_REPO=true
HAVE_BASE=false
[[ "$BASE_OK" == true ]] && HAVE_BASE=true
HAVE_HEAD=false
[[ -n "$head" ]] && HAVE_HEAD=true
HAVE_WT_ERROR=false
[[ -n "$worktree_error" ]] && HAVE_WT_ERROR=true

OUT_JSON="$(jq -n \
    --argjson ok "$OK_JSON" \
    --argjson issue "$ISSUE" \
    --arg repo "$repo" \
    --argjson have_repo "$HAVE_REPO" \
    --arg base "$base" \
    --arg base_source "$base_source" \
    --arg base_error "$base_error" \
    --argjson have_base "$HAVE_BASE" \
    --arg worktree "$WT" \
    --arg branch "$BRANCH" \
    --arg head "$head" \
    --argjson have_head "$HAVE_HEAD" \
    --arg worktree_status "$worktree_status" \
    --arg worktree_error "$worktree_error" \
    --argjson have_worktree_error "$HAVE_WT_ERROR" \
    --argjson worktree_removed "$worktree_removed" \
    --argjson clean "$clean_json" \
    --argjson stack "$stack_json" \
    --argjson analyze "$analyze_json" \
    --argjson ci_verify "$ci_verify_json" \
    --argjson local_verify "$local_verify_json" \
    --argjson skip_worktree "$(skip_worktree_json)" \
    --argjson epoch "$epoch" \
    --argjson ci_wait_ceiling_seconds "$ci_wait_ceiling_seconds" \
    --argjson security_reviewer "$security_reviewer" \
    --arg plugin_commit "$plugin_commit" \
    '
    {ok: $ok, issue: $issue}
    + (if $have_repo then {repo: $repo} else {} end)
    + (if $have_base then {base: $base, base_source: $base_source} else {base_error: $base_error} end)
    + {worktree: $worktree, branch: $branch}
    + (if $have_head then {head: $head} else {} end)
    + (if $have_worktree_error then {worktree_error: $worktree_error} else {} end)
    + {worktree_status: $worktree_status, worktree_removed: $worktree_removed, skip_worktree: $skip_worktree}
    + {clean: $clean, stack: $stack, analyze: $analyze, ci_verify: $ci_verify, local_verify: $local_verify, epoch: $epoch}
    + {ci_wait_ceiling_seconds: $ci_wait_ceiling_seconds, security_reviewer: $security_reviewer}
    + {plugin_commit: (if ($plugin_commit | test("^[0-9a-f]{12}$")) then $plugin_commit else null end)}
    ')"

# deps install（ensure-worktree-deps --setup）の入力。ok:false のときは前 run の値を消す（古い epoch の setup で
# run を起動させない）。書けなければ deps 段が「読めない」で止まり、wrapper がその stderr を人間へ返す
SETUP_FILE="$WT/.devflow-tmp/prerun-setup.json"
if [[ "$OK_JSON" == true ]]; then
    # Segment 3 の clean は .devflow-tmp ごと消すので作り直す
    { mkdir -p "$WT/.devflow-tmp" && printf '%s\n' "$OUT_JSON" >"$SETUP_FILE"; } || echo "prerun: failed to write $SETUP_FILE" >&2
elif [[ -f "$SETUP_FILE" ]]; then
    # 書けない worktree（unwritable）では消せない。ok:false なので wrapper はどのみち deps 段へ進まない
    rm -f "$SETUP_FILE" 2>/dev/null || true
fi
printf '%s\n' "$OUT_JSON"

exit 0
