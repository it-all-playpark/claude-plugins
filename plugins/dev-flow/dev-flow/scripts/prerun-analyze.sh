#!/usr/bin/env bash
# prerun-analyze.sh - dev-flow prerun の analyze 段 (issue #690)
#
# `analyze-issue <N> [--repo R] --contract` の決定論 parse を実行し、決定論で解けない 3 理由
# （breaking keyword hit / comments present / 観測型 AC の絞り込み hit）だけを Jev（有界判定モデル、
# PATH 上の Jev クライアント `jev-classify`。インターフェースは dev-flow/SKILL.md の Jev 節）に回して、dev-flow.js の Setup 末尾の analyze ゲートが whitelist 検証するだけで
# REQ を組める analyze JSON を stdout 1 行で返す。LLM が issue を転写する工程は持たない（転写者がいなければ
# provenance 突合も comment_count 突合も要らない — その代わり breaking / comment の Jev の低確信・応答なし・無効は
# 全て fail-closed で `uncertain[]` に積み、Workflow 側のゲートが needs_clarification に倒す）。
#
# Usage: prerun-analyze.sh --issue <N> [--repo <owner/name>]
#
# 出力（常に exit 0。失敗は ok:false + reason で報告し prerun.sh は他段を巻き込まない）:
#   { ok: true, analyze_path: "contract"|"jev", jev_reasons: [..],
#     issue_title, issue_type, acceptance_criteria: [..], scope, scope_truncated, scope_total_chars,
#     issue_body, issue_body_truncated, breaking_keyword_scan, breaking_change, breaking_evidence,
#     comment_count, comment_overrides: [..], comment_conflicts: [..], uncertain: [..],
#     ac_observational: [true|false|null ..], ac_observational_evidence: [..],
#     blockers: [{repo, number, state: "OPEN"|"CLOSED", source: "api"|"body", url}],
#     contract, ac_heading_near_miss: [..] }
#   { ok: false, reason: "...", analyze_path: "contract" }
#
# blockers（issue #744）は GitHub issue dependencies API（blocked_by）と本文の `Blocked by #N` /
# `Blocked by owner/repo#N` 行の和集合。取得・状態読み取りの失敗は ok:false（fail-closed）。
#
# Jev 判定の規則（閾値 JEV_CONF_MIN=0.9。低確信は常に安全側）:
#   breaking_keyword_scan true  → 1 request で noul を 2 問に分けて聞く: breaking「後方互換を保たない API / 形式の
#                                 変更か」と migration「既存データの変換を要するか」。古い値を読み込み時に捨てる
#                                 だけの項目削除は後方互換・変換不要として扱う（1 問に束ねると境界ケースで割れる）。
#                                 どちらかが p>=0.9 で breaking_change=true、両方 p<=0.1 で false、それ以外は
#                                 uncertain。title の `!` marker は決定論で true
#   comments present            → comment ごとに choice {override, conflict, resolved, unrelated}（確信 = choice の
#                                 確率）。state には comment の created_at・最新 comment の created_at・issue の
#                                 updated_at を並べ、comment 後に body で決着したかの前後関係を渡す。
#                                 override かつ権限あり（author == issue 報告者 or association が
#                                 OWNER/MEMBER/COLLABORATOR）→ comment_overrides、override だが権限なし /
#                                 conflict / 低確信 → comment_conflicts（fail-closed）、resolved / unrelated
#                                 （高確信）→ 無視（要件は body どおり）
#   観測型 AC（issue #859）      → acceptance_criteria を正規表現（_lib/ac-actor.mjs の isObservationalAc を
#                                 _lib/scripts/ac-observational-prefilter.mjs 経由で呼ぶ。拾いすぎてよい）で絞り込み、
#                                 当たった AC だけを 1 request で AC ごとに noul で聞く（質問 id は ac_<n>）:
#                                 「state の AC-<n> は、コードとテストを読むだけでは確かめられず、実行した結果・ログ・
#                                 計測を観測しないと確かめられないか。AC がテストコードやソースコード自体の書き方・構成
#                                 について述べているなら no」。state は issue の title と当たった AC の文面だけ（本文は
#                                 送らない）。p>=0.9 で true、p<=0.1 で false、低確信・Jev 応答なし・無効は null。
#                                 当たらない AC は Jev に聞かず false。絞り込み自体が失敗したら全 AC を null。
#                                 結果は ac_observational（AC ごとの true / false / null）、根拠は
#                                 ac_observational_evidence（AC ごとの 1 文）に載せ、uncertain には積まない — null は
#                                 Workflow の analyze ゲートが AC の文面と title だけを読む分類 agent に 1 回で渡し、
#                                 そこでも決まらなければ観測型（true）として扱う（観測型への誤判定は人手 AC 待ちの
#                                 HOLD で止まるだけだが、逆は evaluator のコード読みだけで達成扱いになるため）
#   Jev が空 stdout（失敗）      → 該当判定は uncertain（観測型 AC は null）。jev-classify の --reason-file が返す失敗理由
#                                 （jev-broker に接続できない / jev-broker 経由の失敗 / 鍵なし / Keychain に
#                                 届かない / Keychain 読み取り失敗 / タイムアウト / 通信失敗 / 応答不正）を
#                                 文言に載せる（「応答なし」だけでは人間が切り分けられない）。「Keychain に
#                                 届かない」は sandbox 内・bg job でも出るので、ロック中とは限らない
#   確率が 0〜1 の数値でない      → 判定値なしと同じく uncertain（観測型 AC は null）。true / 文字列 / 範囲外を含む
#   jev-classify が PATH に無い  → Jev 未導入として同じく uncertain（観測型 AC は null）
#   DEVFLOW_JEV_DISABLE=1       → Jev を呼ばず該当判定は uncertain（観測型 AC は null。private repo 向け opt-out）
#
# uncertain の「明記せよ」文言は analyze-issue.sh の breaking キーワード（breaking / incompatible /
# migration / 破壊的 / 非互換）を含めない。人間が指示どおり body に書いた語で再び Jev 判定の対象に
# なるのを避けるため。
#
# 環境変数: DEVFLOW_JEV_DISABLE=1 / DEVFLOW_JEV_MAX_TIME（既定 10 秒。hook 既定の 2 秒では issue 本文が
# 長いと落ちる）/ DEVFLOW_JEV_CLASSIFY（Jev クライアントのコマンド名、既定 jev-classify）。
# jev-classify には常に --redact と --reason-file を付ける。

set -euo pipefail

_CORE_BIN="$(command -v journal)" || { echo "playpark-core plugin (bin/journal) not on PATH" >&2; exit 127; }
source "$(dirname "$_CORE_BIN")/../_lib/common.sh"
has_jq || { echo "jq is required" >&2; exit 127; }

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ANALYZE_ISSUE="$PLUGIN_ROOT/dev-flow/scripts/analyze-issue.sh"
JEV_CLASSIFY_CMD="${DEVFLOW_JEV_CLASSIFY:-jev-classify}"
JEV_CLASSIFY="$(command -v "$JEV_CLASSIFY_CMD" || true)"
ISSUE_BLOCKERS="$PLUGIN_ROOT/_lib/scripts/issue-blockers.sh"
AC_OBS_PREFILTER="$PLUGIN_ROOT/_lib/scripts/ac-observational-prefilter.mjs"
JEV_CONF_MIN="0.9"
export JEV_MAX_TIME="${DEVFLOW_JEV_MAX_TIME:-10}"

ISSUE=""
REPO=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --issue) [[ $# -ge 2 ]] || { echo "--issue requires a value" >&2; exit 2; }; ISSUE="$2"; shift 2 ;;
        --repo) [[ $# -ge 2 ]] || { echo "--repo requires a value" >&2; exit 2; }; REPO="$2"; shift 2 ;;
        *) echo "Unknown option: $1" >&2; exit 2 ;;
    esac
done
[[ "$ISSUE" =~ ^[1-9][0-9]*$ ]] || { echo "--issue must be a positive integer" >&2; exit 2; }

fail_json() {
    jq -n --arg r "$1" '{ok: false, reason: $r, analyze_path: "contract"}'
    exit 0
}

# ============================================================================
# 1. contract 決定論 parse（issue 取得は analyze-issue.sh が bare gh で内蔵）
# ============================================================================

ANALYZE_ARGS=("$ISSUE")
[[ -n "$REPO" ]] && ANALYZE_ARGS+=(--repo "$REPO")
ANALYZE_ARGS+=(--contract)
ERR_FILE="$(mktemp "${TMPDIR:-/tmp}/dev-flow-prerun-analyze.XXXXXX")"
trap 'rm -f "$ERR_FILE" "${COMMENTS_FILE:-}" "${JEV_REASON_FILE:-}"' EXIT
if ! CONTRACT="$("$ANALYZE_ISSUE" "${ANALYZE_ARGS[@]}" 2>"$ERR_FILE")"; then
    ERR_MSG="$(tr '\n' ' ' <"$ERR_FILE")"
    # analyze-issue.sh は die_json で {"error": ...} を stdout に出す。あれば理由に載せる
    if [[ -n "$CONTRACT" ]] && printf '%s' "$CONTRACT" | jq -e '.error? | type == "string"' >/dev/null 2>&1; then
        ERR_MSG="$(printf '%s' "$CONTRACT" | jq -r '.error')"
    fi
    fail_json "analyze-issue --contract failed: ${ERR_MSG:-exit non-zero}"
fi
if ! printf '%s' "$CONTRACT" | jq -e 'type == "object" and (.acceptance_criteria | type == "array") and (.title | type == "string")' >/dev/null 2>&1; then
    fail_json "analyze-issue --contract returned non-object / malformed JSON"
fi

# ============================================================================
# 1b. blocker（issue #744）: GitHub issue dependencies API と本文の `Blocked by` 行の和集合
# ============================================================================
# 判定は dev-flow-ready-set と共有する _lib/scripts/issue-blockers.sh に一本化している（写しを持つとずれる）。
# 取得・状態読み取りの失敗は全て ok:false（fail-closed — 黙って素通りさせると未準備のまま実装が走る）。
# Workflow 側は state == "OPEN" が 1 つでもあれば実装前に止める。読み取りのみ。

BLOCKERS_ARGS=(--issue "$ISSUE")
[[ -n "$REPO" ]] && BLOCKERS_ARGS+=(--repo "$REPO")
if ! BLOCKERS_JSON="$(bash "$ISSUE_BLOCKERS" "${BLOCKERS_ARGS[@]}" 2>"$ERR_FILE")"; then
    BLOCKERS_ERR="$(tr '\n' ' ' <"$ERR_FILE")"
    fail_json "${BLOCKERS_ERR:-blocked_by: issue-blockers.sh が失敗した}"
fi
printf '%s' "$BLOCKERS_JSON" | jq -e 'type == "array"' >/dev/null 2>&1 \
    || fail_json "blocked_by: issue-blockers.sh の出力が不正（配列でない）"

TITLE="$(printf '%s' "$CONTRACT" | jq -r '.title')"
ISSUE_BODY="$(printf '%s' "$CONTRACT" | jq -r '.issue_body // ""')"
ISSUE_AUTHOR="$(printf '%s' "$CONTRACT" | jq -r '.issue_author // ""')"
ISSUE_UPDATED_AT="$(printf '%s' "$CONTRACT" | jq -r '.issue_updated_at // ""')"
BREAKING_KW="$(printf '%s' "$CONTRACT" | jq -r '.breaking_keyword_scan')"
TITLE_BANG="$(printf '%s' "$CONTRACT" | jq -r '.title_breaking_marker // false')"
COMMENT_COUNT="$(printf '%s' "$CONTRACT" | jq -r '.comment_count // 0')"

# ============================================================================
# 2. Jev 判定
# ============================================================================

JEV_DISABLED=false
[[ "${DEVFLOW_JEV_DISABLE:-0}" == "1" ]] && JEV_DISABLED=true

JEV_REASON_FILE="$(mktemp "${TMPDIR:-/tmp}/dev-flow-prerun-jev-reason.XXXXXX")"

# jev_call <state> <questions-json> → 応答 JSON（失敗 / 無効は空）。失敗理由は $JEV_REASON_FILE に残る
jev_call() {
    local state="$1" questions="$2"
    : >"$JEV_REASON_FILE"
    [[ "$JEV_DISABLED" == true ]] && return 0
    if [[ -z "$JEV_CLASSIFY" ]]; then
        printf 'not installed (%s not on PATH)\n' "$JEV_CLASSIFY_CMD" >"$JEV_REASON_FILE"
        return 0
    fi
    printf '%s' "$state" | "$JEV_CLASSIFY" --redact --questions "$questions" --reason-file "$JEV_REASON_FILE" 2>/dev/null || true
}

# 直前の jev_call が判定値を返さなかった理由（jev-classify の reason を原因別の見出し付きで載せる）
jev_unavailable_reason() {
    if [[ "$JEV_DISABLED" == true ]]; then
        printf 'Jev 無効（DEVFLOW_JEV_DISABLE=1）'
        return
    fi
    local reason label
    reason="$(head -n 1 "$JEV_REASON_FILE" 2>/dev/null || true)"
    case "$reason" in
        "") printf 'Jev 応答なし（応答に判定値（0〜1 の数値）が無い）'; return ;;
        "not installed"*) label="jev-classify が PATH に無い（Jev 未導入）" ;;
        "broker unreachable"*) label="jev-broker に接続できない" ;;
        "broker request failed"*) label="jev-broker 経由の呼び出し失敗" ;;
        "keychain unreachable"*) label="Keychain に届かない（ロック中・sandbox 内・bg job など別セッション）" ;;
        "keychain read failed"*) label="Keychain から API 鍵を読めない" ;;
        "no API key"*) label="API 鍵が無い" ;;
        "timeout"*) label="タイムアウト（DEVFLOW_JEV_MAX_TIME）" ;;
        "request failed"*) label="通信失敗" ;;
        "bad response"*) label="応答不正" ;;
        *) label="呼び出し失敗" ;;
    esac
    printf 'Jev 応答なし（%s: %s）' "$label" "$reason"
}

# jq の数値比較で閾値判定する（bash は小数を扱えない）
conf_at_least() { jq -n --argjson p "$1" --argjson m "$2" '$p >= $m' | grep -q true; }
conf_at_most() { jq -n --argjson p "$1" --argjson m "$2" '$p <= $m' | grep -q true; }

# jev_prob <応答 JSON> <jq の取り出し式> [jq の引数…] → 確率値（0〜1 の数値のときだけ。それ以外は空 = 判定値なし）
# true / 文字列を通すと閾値比較が jq の型順序（boolean < number）で no 側に倒れる（fail-open）ため型と範囲を見る
jev_prob() {
    local resp="$1" expr="$2"
    shift 2
    printf '%s' "$resp" | jq -r "$@" "$expr"' | select(type == "number" and . >= 0 and . <= 1)' 2>/dev/null || true
}

JEV_REASONS=()
UNCERTAIN=()
OVERRIDES=()
CONFLICTS=()
BREAKING_CHANGE=false
BREAKING_EVIDENCE=""

# ---- breaking ----
if [[ "$TITLE_BANG" == "true" ]]; then
    BREAKING_CHANGE=true
    BREAKING_EVIDENCE="title の breaking marker (!): ${TITLE}"
elif [[ "$BREAKING_KW" == "true" ]]; then
    JEV_REASONS+=("breaking_keyword_scan true")
    BREAKING_Q='{"breaking":{"type":"noul","instructions":"この issue の実装は、既存の API / schema / データ形式 / 設定形式を、既存の呼び出し側・既存データ・既存設定がそのままでは動かなくなる形（後方互換を保たない形）に変えるか。項目や設定を削除しても、古い値を読み込み時に無視・破棄して従来どおり動くなら後方互換なので no。『breaking を避ける』『非互換にしない』『breaking floor を変更しない』のような回避・不変条件への言及だけなら no。"},"migration":{"type":"noul","instructions":"この issue の実装は、保存済みの既存データ（DB のレコード・ファイル・設定ファイルの値など）を新しい形式へ書き換える変換処理や移行手順を必要とするか。古い値を読み込み時に無視・破棄するだけで既存データを書き換えないなら no。変換が不要と明記されていれば no。"}}'
    RESP="$(jev_call "# Issue: ${TITLE}"$'\n\n'"${ISSUE_BODY}" "$BREAKING_Q")"
    PB="$(jev_prob "$RESP" '.answers.breaking.noul')"
    PM="$(jev_prob "$RESP" '.answers.migration.noul')"
    # 明記の指示文は analyze-issue.sh の breaking キーワードを含めない（書いた語で再び Jev 判定の対象になる）
    COMPAT_ASK="issue body に「後方互換を保たない API / 形式の変更: あり / なし」と「既存データの変換: 要 / 不要」を明記せよ"
    CONF_MAX_NO="$(jq -n --argjson m "$JEV_CONF_MIN" '1 - $m')"
    if [[ -z "$PB" || -z "$PM" ]]; then
        UNCERTAIN+=("breaking_keyword_scan: title/body に互換性に関わるキーワードがあるが $(jev_unavailable_reason) — ${COMPAT_ASK}")
    elif conf_at_least "$PB" "$JEV_CONF_MIN" || conf_at_least "$PM" "$JEV_CONF_MIN"; then
        BREAKING_CHANGE=true
        BREAKING_EVIDENCE="Jev noul 後方互換を保たない変更 p=${PB} / 既存データの変換 p=${PM}（breaking 系キーワード hit）"
    elif conf_at_most "$PB" "$CONF_MAX_NO" && conf_at_most "$PM" "$CONF_MAX_NO"; then
        BREAKING_CHANGE=false
        BREAKING_EVIDENCE=""
    else
        UNCERTAIN+=("breaking_keyword_scan: Jev が低確信で判定できない（後方互換を保たない変更 p=${PB} / 既存データの変換 p=${PM}）— ${COMPAT_ASK}")
    fi
fi

# ---- comments ----
comment_excerpt() {
    local b
    b="$(printf '%s' "$1" | tr '\n' ' ')"
    printf '%s' "${b:0:200}"
}

if [[ "$COMMENT_COUNT" -gt 0 ]]; then
    JEV_REASONS+=("comments present (${COMMENT_COUNT})")
    COMMENT_Q='{"kind":{"type":"choice","instructions":"この comment は現在の issue body の要件に対してどれに当たるか。時系列（comment の created_at と issue の updated_at）も手がかりにする。","criteria":{"override":"body の記述を明示的に訂正・上書きしていて、body はまだ訂正前の記述のまま（『訂正』『前倒し』『X ではなく Y』等。要件が変わる）","conflict":"body と食い違う内容だが、どちらが有効か comment からも body からも確定できない","resolved":"comment が挙げた未決事項・提案・訂正が、その後 issue body に取り込まれて決着している（body に同じ決定が書かれている。要件は body どおり）","unrelated":"要件を変えない（了解・質問・進捗報告・感想・無関係な話題）"}}}'
    COMMENTS_FILE="$(mktemp "${TMPDIR:-/tmp}/dev-flow-prerun-comments.XXXXXX")"
    printf '%s' "$CONTRACT" | jq -c '.comments // [] | .[]' >"$COMMENTS_FILE"
    # 前後関係: gh の issue JSON に本文だけの編集時刻は無いので、issue の updated_at（本文編集・comment 追加・
    # label 変更のいずれかの最終時刻）と最新 comment の created_at を並べる。updated_at が最新 comment より
    # 後なら、comment の後に body（か label）が更新されている。
    LATEST_COMMENT_AT="$(printf '%s' "$CONTRACT" | jq -r '[.comments // [] | .[].created_at // empty | select(. != "")] | max // ""')"
    TIMELINE="# 時系列"$'\n'"- issue の updated_at: ${ISSUE_UPDATED_AT:-?}（本文編集・comment 追加・label 変更のいずれかの最終時刻）"$'\n'"- 最新 comment の created_at: ${LATEST_COMMENT_AT:-?}"
    # ISO 8601（UTC）同士なので文字列比較で順序が決まる（bash の [[ > ]] は locale 依存なので jq で比べる）
    if [[ -n "$ISSUE_UPDATED_AT" && -n "$LATEST_COMMENT_AT" ]] \
        && jq -n --arg u "$ISSUE_UPDATED_AT" --arg l "$LATEST_COMMENT_AT" '$u > $l' | grep -q true; then
        TIMELINE+=$'\n'"- issue は最新 comment より後に更新されている（comment の後に body が編集された可能性がある）"
    fi
    IDX=0
    while IFS= read -r C || [[ -n "$C" ]]; do
        [[ -z "$C" ]] && continue
        IDX=$((IDX + 1))
        C_AUTHOR="$(printf '%s' "$C" | jq -r '.author // ""')"
        C_ASSOC="$(printf '%s' "$C" | jq -r '.author_association // ""')"
        C_AT="$(printf '%s' "$C" | jq -r '.created_at // ""')"
        C_BODY="$(printf '%s' "$C" | jq -r '.body // ""')"
        C_LABEL="comment #${IDX} by ${C_AUTHOR:-unknown}（${C_ASSOC:-?}, ${C_AT:-?}）: $(comment_excerpt "$C_BODY")"
        # 権限は gh JSON から決定論判定（空文字列・不明は一致とみなさない）
        TRUSTED=false
        if [[ -n "$C_AUTHOR" && -n "$ISSUE_AUTHOR" && "$C_AUTHOR" == "$ISSUE_AUTHOR" ]]; then
            TRUSTED=true
        elif [[ "$C_ASSOC" == "OWNER" || "$C_ASSOC" == "MEMBER" || "$C_ASSOC" == "COLLABORATOR" ]]; then
            TRUSTED=true
        fi
        STATE="# Issue（author: ${ISSUE_AUTHOR:-unknown}, updated_at: ${ISSUE_UPDATED_AT:-?}）: ${TITLE}"$'\n\n'"${ISSUE_BODY}"$'\n\n'"# Comment（author: ${C_AUTHOR:-unknown}, association: ${C_ASSOC:-?}, created_at: ${C_AT:-?}）"$'\n'"${C_BODY}"$'\n\n'"${TIMELINE}"
        RESP="$(jev_call "$STATE" "$COMMENT_Q")"
        CHOICE="$(printf '%s' "$RESP" | jq -r '.answers.kind.choice // empty' 2>/dev/null || true)"
        CP="$(jev_prob "$RESP" '.answers.kind as $k | $k.probabilities[$k.choice]')"
        if [[ -z "$CHOICE" || -z "$CP" ]]; then
            UNCERTAIN+=("${C_LABEL} — $(jev_unavailable_reason)。comment が body を訂正しているなら issue body に反映せよ")
            continue
        fi
        if ! conf_at_least "$CP" "$JEV_CONF_MIN"; then
            CONFLICTS+=("low-confidence（${CHOICE} p=${CP}）: ${C_LABEL}")
            continue
        fi
        case "$CHOICE" in
            override)
                if [[ "$TRUSTED" == true ]]; then
                    OVERRIDES+=("override: ${C_LABEL}")
                else
                    CONFLICTS+=("override（権限なし: author_association=${C_ASSOC:-?}）: ${C_LABEL}")
                fi ;;
            conflict)
                CONFLICTS+=("conflict: ${C_LABEL}") ;;
            resolved | unrelated) ;;
            *)
                CONFLICTS+=("unknown-choice（${CHOICE}）: ${C_LABEL}") ;;
        esac
    done <"$COMMENTS_FILE"
fi

# ---- observational AC ----
# OBS_VALUES は AC ごとの JSON リテラル（true / false / null）、OBS_EVIDENCE は AC ごとの根拠
AC_JSON="$(printf '%s' "$CONTRACT" | jq -c '.acceptance_criteria')"
AC_COUNT="$(printf '%s' "$AC_JSON" | jq 'length')"
OBS_VALUES=()
OBS_EVIDENCE=()
if [[ "$AC_COUNT" -gt 0 ]]; then
    PREFILTER=""
    if PREFILTER="$(printf '%s' "$AC_JSON" | node "$AC_OBS_PREFILTER" 2>"$ERR_FILE")" \
        && printf '%s' "$PREFILTER" | jq -e --argjson n "$AC_COUNT" 'type == "array" and length == $n and all(.[]; type == "boolean")' >/dev/null 2>&1; then
        HITS_JSON="$(printf '%s' "$PREFILTER" | jq -c '[to_entries[] | select(.value) | .key]')"
    else
        PREFILTER_ERR="$(tr '\n' ' ' <"$ERR_FILE")"
        PREFILTER_ERR="${PREFILTER_ERR:0:200}"
        HITS_JSON="null"
    fi
    if [[ "$HITS_JSON" == "null" ]]; then
        for ((i = 0; i < AC_COUNT; i++)); do
            OBS_VALUES+=("null")
            OBS_EVIDENCE+=("正規表現の絞り込みを実行できない（${PREFILTER_ERR:-出力が不正}）— 分類 agent に回す")
        done
    else
        for ((i = 0; i < AC_COUNT; i++)); do
            OBS_VALUES+=("false")
            OBS_EVIDENCE+=("正規表現の絞り込みに当たらない")
        done
        if [[ "$HITS_JSON" != "[]" ]]; then
            JEV_REASONS+=("observational_ac prefilter hit ($(printf '%s' "$HITS_JSON" | jq -r 'map("AC-\(. + 1)") | join(", ")'))")
            OBS_INSTR="コードとテストを読むだけでは確かめられず、実行した結果・ログ・計測を観測しないと確かめられないか。AC がテストコードやソースコード自体の書き方・構成について述べているなら no。"
            OBS_Q="$(jq -cn --argjson idx "$HITS_JSON" --arg ins "$OBS_INSTR" \
                '[$idx[] | {key: "ac_\(. + 1)", value: {type: "noul", instructions: ("state の AC-\(. + 1) は、" + $ins)}}] | from_entries')"
            OBS_STATE="# Issue: ${TITLE}"$'\n\n'"# 受け入れ基準"$'\n'"$(printf '%s' "$AC_JSON" | jq -r --argjson idx "$HITS_JSON" '. as $a | $idx[] | "AC-\(. + 1): \($a[.] | gsub("\n"; " "))"')"
            RESP="$(jev_call "$OBS_STATE" "$OBS_Q")"
            CONF_MAX_NO="$(jq -n --argjson m "$JEV_CONF_MIN" '1 - $m')"
            for i in $(printf '%s' "$HITS_JSON" | jq -r '.[]'); do
                P="$(jev_prob "$RESP" '.answers[$q].noul' --arg q "ac_$((i + 1))")"
                if [[ -z "$P" ]]; then
                    OBS_VALUES[i]="null"
                    OBS_EVIDENCE[i]="正規表現の絞り込みに当たったが $(jev_unavailable_reason) — 分類 agent に回す"
                elif conf_at_least "$P" "$JEV_CONF_MIN"; then
                    OBS_VALUES[i]="true"
                    OBS_EVIDENCE[i]="Jev noul 観測型 p=${P}"
                elif conf_at_most "$P" "$CONF_MAX_NO"; then
                    OBS_VALUES[i]="false"
                    OBS_EVIDENCE[i]="Jev noul 観測型 p=${P}（コードとテストで確かめられる）"
                else
                    OBS_VALUES[i]="null"
                    OBS_EVIDENCE[i]="Jev が低確信（観測型 p=${P}）— 分類 agent に回す"
                fi
            done
        fi
    fi
fi

ANALYZE_PATH="contract"
[[ ${#JEV_REASONS[@]} -gt 0 ]] && ANALYZE_PATH="jev"

# ============================================================================
# 3. 出力
# ============================================================================

to_json_array() {
    if [[ $# -eq 0 ]]; then printf '[]'; return; fi
    printf '%s\n' "$@" | jq -R . | jq -sc .
}

JEV_REASONS_JSON="$(to_json_array "${JEV_REASONS[@]+"${JEV_REASONS[@]}"}")"
UNCERTAIN_JSON="$(to_json_array "${UNCERTAIN[@]+"${UNCERTAIN[@]}"}")"
OVERRIDES_JSON="$(to_json_array "${OVERRIDES[@]+"${OVERRIDES[@]}"}")"
CONFLICTS_JSON="$(to_json_array "${CONFLICTS[@]+"${CONFLICTS[@]}"}")"
OBS_EVIDENCE_JSON="$(to_json_array "${OBS_EVIDENCE[@]+"${OBS_EVIDENCE[@]}"}")"
if [[ ${#OBS_VALUES[@]} -eq 0 ]]; then
    OBS_VALUES_JSON="[]"
else
    OBS_VALUES_JSON="$(printf '%s\n' "${OBS_VALUES[@]}" | jq -sc .)"
fi

printf '%s' "$CONTRACT" | jq -c \
    --arg analyze_path "$ANALYZE_PATH" \
    --argjson jev_reasons "$JEV_REASONS_JSON" \
    --argjson breaking_change "$BREAKING_CHANGE" \
    --arg breaking_evidence "$BREAKING_EVIDENCE" \
    --argjson comment_overrides "$OVERRIDES_JSON" \
    --argjson comment_conflicts "$CONFLICTS_JSON" \
    --argjson uncertain "$UNCERTAIN_JSON" \
    --argjson blockers "$BLOCKERS_JSON" \
    --argjson ac_observational "$OBS_VALUES_JSON" \
    --argjson ac_observational_evidence "$OBS_EVIDENCE_JSON" \
    '{
      ok: true,
      analyze_path: $analyze_path,
      jev_reasons: $jev_reasons,
      issue_title: .title,
      issue_type: .issue_type,
      acceptance_criteria: .acceptance_criteria,
      scope: (.scope // ""),
      scope_truncated: (.scope_truncated // false),
      scope_total_chars: (.scope_total_chars // 0),
      issue_body: (.issue_body // ""),
      issue_body_truncated: (.issue_body_truncated // false),
      breaking_keyword_scan: (.breaking_keyword_scan // false),
      breaking_change: $breaking_change,
      breaking_evidence: $breaking_evidence,
      comment_count: (.comment_count // 0),
      comment_overrides: $comment_overrides,
      comment_conflicts: $comment_conflicts,
      uncertain: $uncertain,
      ac_observational: $ac_observational,
      ac_observational_evidence: $ac_observational_evidence,
      blockers: $blockers,
      contract: (.contract // "none"),
      ac_heading_near_miss: (.ac_heading_near_miss // [])
    }'

exit 0
