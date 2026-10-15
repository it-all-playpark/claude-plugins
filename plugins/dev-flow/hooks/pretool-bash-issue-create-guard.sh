#!/usr/bin/env bash
# PreToolUse(Bash) hook: 素の issue 起票を拒否し、git-issue（create_issue.py）に誘導する
#
# 目的:
#   agent が Bash で issue を作る経路を create_issue.py だけにする。create_issue.py は AC の checkbox
#   形式・4000 字・変更対象パス・人の作業の切り出しをゲートしており、素の gh issue create / gh api は
#   それを通らない。description や規約で頼むだけでは漏れるので、毎回確定で効く hook で止める。
#   create_issue.py は内部で gh issue create を subprocess で呼ぶが、Bash tool の command には
#   現れないので本 hook の対象にならない。
#
# 判定フロー:
#   1. stdin の JSON が読めない、tool_name が Bash 以外、command が空 → 無出力 exit 0
#   2. command を引用符（'…' / "…"）を考慮して、引用符の外の &&, ||, ;, |, &, 改行 で segment に分け、
#      各 segment を空白で token に分ける（引用符は外す。行末の \ による行継続は空白扱い）
#   3. segment 先頭の VAR=val / command / env を飛ばし、次の token が gh（または */gh）の segment だけを見る。
#      それ以外（rg "gh issue create"・echo 等）は対象外
#   4. gh の後ろのフラグ（-R / --repo は値を取る）を飛ばしてサブコマンドを確定し、次を deny する:
#      - issue create / issue new
#      - api で endpoint の末尾が /issues かつ -f / -F / --field / --raw-field / --input か
#        -X POST / --method POST を持つ
#      - api graphql で token のどれかが createIssue を含む
#
# agent 向けの抜け道（環境変数・フラグ・repo 除外）は作らない。dev-flow に流さない issue は人間が
# `! gh issue create ...` で起票する。
# hook は deny を出力するだけで、コマンドの書き換え・状態の変更・外部送信はしない。
#
# 既知の限界:
#   - ヒアドキュメント本文・$(…) / `…` / bash -c の中身は解釈しない。ヒアドキュメント本文の行頭に
#     gh issue create があると segment として拾う（偽陽性）
#   - gh api --input <file> の中身（graphql の createIssue）は読まない

set -euo pipefail

# 1 文字ずつ走査するので byte 単位にする（引用符・区切りはすべて ASCII）
export LC_ALL=C

INPUT=$(cat)

CMD=$(jq -r 'if .tool_name == "Bash" then (.tool_input.command // empty) else empty end' <<<"$INPUT" 2>/dev/null) || exit 0
if [[ -z $CMD ]]; then
  exit 0
fi

# gh と issue / Issue を両方含まない command は走査しない（大半の Bash を素通しにする）
if [[ $CMD != *gh* || $CMD != *[Ii]ssue* ]]; then
  exit 0
fi

deny() {
  jq -n --arg reason "$1" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    }
  }'
  exit 0
}

REASON='素の gh issue create / gh api による issue の起票は止めている（AC の checkbox 形式・4000 字・変更対象パス・人の作業の切り出しのゲートを通らないため）。
起票は git-issue（/dev-flow:git-issue、本体は create_issue.py）を使う。症状・原因・直し方の分かった小さな起票は軽い経路で受ける。
dev-flow に流さない issue は、人間がプロンプトで `! gh issue create ...` を実行して起票する。'

# check_segment <token...>
# 1 segment の token 列が issue の起票なら deny する
check_segment() {
  local -a t=("$@")
  local n=${#t[@]} i=0

  # 環境変数の前置・command / env を飛ばす
  while ((i < n)); do
    case "${t[i]}" in
    command | env) ;;
    *) [[ ${t[i]} =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || break ;;
    esac
    i=$((i + 1))
  done
  [[ ${t[i]:-} == gh || ${t[i]:-} == */gh ]] || return 0
  i=$((i + 1))

  # gh のフラグを飛ばしてサブコマンドを確定する（-R / --repo は値を取る）
  while ((i < n)); do
    case "${t[i]}" in
    -R | --repo) i=$((i + 2)) ;;
    -*) i=$((i + 1)) ;;
    *) break ;;
    esac
  done

  case "${t[i]:-}" in
  issue)
    i=$((i + 1))
    while ((i < n)); do
      case "${t[i]}" in
      -R | --repo) i=$((i + 2)) ;;
      -*) i=$((i + 1)) ;;
      *) break ;;
      esac
    done
    case "${t[i]:-}" in
    create | new) deny "$REASON" ;;
    esac
    ;;
  api)
    local endpoint="" write=0 create_mutation=0 tok
    i=$((i + 1))
    while ((i < n)); do
      tok="${t[i]}"
      [[ $tok == *createIssue* ]] && create_mutation=1
      case "$tok" in
      -f | -F | --field | --raw-field | --input)
        write=1
        [[ ${t[i + 1]:-} == *createIssue* ]] && create_mutation=1
        i=$((i + 2))
        continue
        ;;
      -f?* | -F?* | --field=* | --raw-field=* | --input=*) write=1 ;;
      -X | --method)
        [[ ${t[i + 1]:-} == [Pp][Oo][Ss][Tt] ]] && write=1
        i=$((i + 2))
        continue
        ;;
      -X[Pp][Oo][Ss][Tt] | --method=[Pp][Oo][Ss][Tt]) write=1 ;;
      -H | --header | -q | --jq | -t | --template | --hostname | -p | --preview | --cache)
        i=$((i + 2))
        continue
        ;;
      -*) ;;
      *) [[ -z $endpoint ]] && endpoint="$tok" ;;
      esac
      i=$((i + 1))
    done

    if [[ $endpoint == graphql ]]; then
      ((create_mutation)) && deny "$REASON"
      return 0
    fi
    endpoint="${endpoint%%\?*}"
    endpoint="${endpoint%/}"
    if [[ $endpoint == */issues ]] && ((write)); then
      deny "$REASON"
    fi
    ;;
  esac
  return 0
}

# --- command を segment / token に分ける ---
# awk が 1 segment を 1 行、token を US（\037）区切りで出す。引用符内の改行は token 内の空白にする
# （判定は token の部分一致と先頭の語だけを見るので、改行と空白を区別しなくてよい）。
# bash の ${s:i:1} は位置に比例して遅く、長い command（commit message 等）で timeout するので awk で走査する。
SEGMENTS=$(printf '%s' "$CMD" | awk '
  function end_tok() {
    if (has) { line = line (n++ ? "\037" : "") tok }
    tok = ""; has = 0
  }
  function end_seg() {
    end_tok()
    if (n) print line
    line = ""; n = 0
  }
  {
    len = split($0, ch, "")
    for (i = 1; i <= len; i++) {
      c = ch[i]
      if (q == "\047") {
        if (c == "\047") q = ""; else tok = tok c
        continue
      }
      if (q == "\"") {
        if (c == "\"") q = ""
        else if (c == "\\" && i < len) tok = tok ch[++i]
        else tok = tok c
        continue
      }
      if (c == "\047" || c == "\"") { q = c; has = 1 }
      else if (c == "\\") { if (i < len) { tok = tok ch[++i]; has = 1 } else cont = 1 }
      else if (c == " " || c == "\t") end_tok()
      else if (c == ";" || c == "&" || c == "|") end_seg()
      else { tok = tok c; has = 1 }
    }
    # 行末: 引用符内なら token 内の空白、行末の \ なら行継続、それ以外は segment の区切り
    if (q != "") tok = tok " "
    else if (cont) cont = 0
    else end_seg()
  }
  END { end_seg() }
')

while IFS=$'\037' read -r -a TOKENS; do
  ((${#TOKENS[@]} > 0)) && check_segment "${TOKENS[@]}"
done <<<"$SEGMENTS"

exit 0
