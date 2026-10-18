#!/usr/bin/env bash
# PreToolUse(Bash|Read) hook: コンテキスト浪費の検知と専用 CLI への誘導
#
# 目的:
#   RULES.md の Tool Routing（jq / yq / duckdb / rga で絞ってから読む）は
#   「読ませるルール」では発火しなかった（導入 18 日の実測で新 CLI の
#   使用率は Bash 1000 回あたり 1 回未満、cat/head/tail はむしろ増加）。
#   判断に頼らず、コンテキストを実際に浪費する瞬間を機械的に検知して
#   deny + 代替コマンドの提示で確実に発火させる。
#
# 検知対象:
#   1. 構造化ファイル (json/yaml/toml/xml/csv/tsv/parquet) の全読み
#      - 20KB 超かつ出力が絞られていない cat/Read → jq / yq / duckdb へ誘導
#   2. 巨大プレーンファイル (100KB 超) の全読み
#      - cat / limit なし Read → rg で位置特定、sed -n 範囲指定、Read の limit へ誘導
#   3. バイナリ文書 (pdf/docx/xlsx/pptx/epub/zip/sqlite) への rg/grep
#      - そもそも失敗するので rga へ誘導
#
# 画像 (png/jpg/jpeg/gif/webp) の Read はサイズで止めない:
#   Read は画像をテキストとして全文載せるわけではなく、rg / sed -n も代替にならない。
#
# fail-open の方針:
#   これは安全性ではなく効率のためのガードなので、判定できないものは通す。
#     - ファイルが存在しない / パスが変数・glob → 通す
#     - パイプやリダイレクトで出力が絞られている (`cat x.json | jq …`) → 通す
#       (コンテキストに載るのは絞った後の出力なので害がない)
#     - 閾値以下のサイズ → 通す
#
# 出力:
#   - 検知時: stdout に
#       {"hookSpecificOutput":{"hookEventName":"PreToolUse",
#         "permissionDecision":"deny",
#         "permissionDecisionReason":"<理由と代替コマンド>"}}
#   - 非検知時: stdout 空で exit 0（チェーン通過）

set -euo pipefail

# --- 閾値 ---
# 20KB ≈ 5k tokens: 構造化ファイルはこのサイズを超えたら抽出すべき
STRUCTURED_LIMIT=${CONTEXT_GUARD_STRUCTURED_LIMIT:-20480}
# 100KB ≈ 25k tokens: プレーンテキストでもこれを超える全読みは事故
PLAIN_LIMIT=${CONTEXT_GUARD_PLAIN_LIMIT:-102400}

INPUT=$(cat)

TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
if [[ -n $CWD && -d $CWD ]]; then
  cd "$CWD" || true
fi

emit_deny() {
  local reason="$1"
  jq -n --arg reason "$reason" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    }
  }'
  exit 0
}

file_size() {
  local f="$1"
  stat -f%z "$f" 2>/dev/null || stat -c%s "$f" 2>/dev/null || echo 0
}

human_size() {
  local bytes="$1"
  echo "$((bytes / 1024))KB"
}

# 拡張子から種別を返す: structured_json / structured_yaml / tabular / binary_doc / image / plain
classify() {
  local f="$1"
  local ext="${f##*.}"
  case "$(echo "$ext" | tr '[:upper:]' '[:lower:]')" in
  json | jsonl | ndjson) echo "structured_json" ;;
  yaml | yml | toml | xml) echo "structured_yaml" ;;
  csv | tsv | parquet) echo "tabular" ;;
  pdf | docx | xlsx | pptx | epub | zip | sqlite | sqlite3 | db) echo "binary_doc" ;;
  png | jpg | jpeg | gif | webp) echo "image" ;;
  *) echo "plain" ;;
  esac
}

# 種別ごとの代替コマンド提示
advice_for() {
  local kind="$1" f="$2"
  case "$kind" in
  structured_json)
    echo "jq で必要キーだけ抽出する: jq '.foo.bar' ${f}  /  構造が未知なら gron ${f} | rg <keyword> でパスを見つけてから jq"
    ;;
  structured_yaml)
    echo "yq で必要部分だけ抽出する: yq '.foo.bar' ${f}"
    ;;
  tabular)
    echo "duckdb で集計・抽出する: duckdb -c \"SELECT … FROM '${f}' LIMIT 20\""
    ;;
  binary_doc)
    echo "rga（ripgrep-all）で中身を検索する: rga <pattern> ${f}"
    ;;
  *)
    echo "rg <pattern> ${f} で該当行を特定し、sed -n 'START,ENDp' ${f} か Read の offset/limit で必要な範囲だけ読む"
    ;;
  esac
}

# ---------------------------------------------------------------------------
# Read ツール
# ---------------------------------------------------------------------------
if [[ $TOOL == "Read" ]]; then
  FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
  HAS_LIMIT=$(echo "$INPUT" | jq -r 'if (.tool_input.limit // .tool_input.offset) then "yes" else "no" end')

  [[ -z $FILE || ! -f $FILE ]] && exit 0
  # 範囲指定済みなら意図通りに絞れている
  [[ $HAS_LIMIT == "yes" ]] && exit 0

  SIZE=$(file_size "$FILE")
  KIND=$(classify "$FILE")

  case "$KIND" in
  structured_json | structured_yaml | tabular)
    if ((SIZE > STRUCTURED_LIMIT)); then
      emit_deny "$(human_size "$SIZE") の構造化ファイルを全読みしようとしている: ${FILE}
コンテキストを浪費するので、必要な部分だけ抽出すること。
→ $(advice_for "$KIND" "$FILE")
どうしても全体が必要なら Read に offset/limit を付けて分割して読む。"
    fi
    ;;
  plain)
    if ((SIZE > PLAIN_LIMIT)); then
      emit_deny "$(human_size "$SIZE") のファイルを全読みしようとしている: ${FILE}
コンテキストを浪費するので、必要な範囲だけ読むこと。
→ $(advice_for "$KIND" "$FILE")"
    fi
    ;;
  esac
  exit 0
fi

# ---------------------------------------------------------------------------
# Bash ツール
# ---------------------------------------------------------------------------
[[ $TOOL != "Bash" ]] && exit 0

CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
[[ -z $CMD ]] && exit 0

# コマンドを「出力がコンテキストに載るセグメント」へ分解する。
#   - `;` `&&` `||` で文に分割
#   - 各文をパイプで分割し、最後の要素だけを残す
#     (`cat x.json | jq …` の cat は出力が jq に渡るので対象外)
TERMINAL_SEGMENTS=$(echo "$CMD" | awk '
{
  n = split($0, stmts, /\|\||&&|;/)
  for (i = 1; i <= n; i++) {
    m = split(stmts[i], parts, /\|/)
    print parts[m]
  }
}')

# セグメントから読み取り対象のファイル引数を抽出する。
# 先頭コマンドが $1 に一致する場合のみ、オプションでない最初の引数を返す。
extract_file_arg() {
  local segment="$1" wanted="$2"
  echo "$segment" | awk -v want="$wanted" '
  {
    # 先頭トークンを探す
    idx = 0
    for (i = 1; i <= NF; i++) {
      tok = $i
      gsub(/^["'"'"']|["'"'"']$/, "", tok)
      if (tok == want) { idx = i; break }
      # 先頭が別コマンドなら対象外（`echo foo` の中の cat 等を拾わない）
      if (tok !~ /^(sudo|env|command|time)$/) break
    }
    if (idx == 0) exit
    for (i = idx + 1; i <= NF; i++) {
      tok = $i
      gsub(/^["'"'"']|["'"'"']$/, "", tok)
      if (tok ~ /^-/) continue
      print tok
      exit
    }
  }'
}

while IFS= read -r SEG; do
  [[ -z ${SEG// /} ]] && continue

  # リダイレクトで出力がファイルへ向かうなら、コンテキストには載らない
  if echo "$SEG" | grep -q '>'; then
    continue
  fi

  # --- 1) rg/grep をバイナリ文書に向けている ---
  for GREP_CMD in rg grep egrep; do
    GREP_TARGET=$(extract_file_arg "$SEG" "$GREP_CMD")
    # rg/grep の第1引数は pattern なので、拡張子を持つ引数を全部見る
    if [[ -n $GREP_TARGET ]]; then
      for TOKEN in $SEG; do
        TOKEN="${TOKEN%\"}"
        TOKEN="${TOKEN#\"}"
        TOKEN="${TOKEN%\'}"
        TOKEN="${TOKEN#\'}"
        [[ $TOKEN == -* ]] && continue
        [[ ! -f $TOKEN ]] && continue
        if [[ $(classify "$TOKEN") == "binary_doc" ]]; then
          emit_deny "バイナリ文書に ${GREP_CMD} を向けている: ${TOKEN}
プレーンテキストではないので取りこぼす。
→ $(advice_for binary_doc "$TOKEN")"
        fi
      done
    fi
  done

  # --- 2) cat / head / tail による全読み ---
  for READ_CMD in cat bat; do
    TARGET=$(extract_file_arg "$SEG" "$READ_CMD")
    [[ -z $TARGET || ! -f $TARGET ]] && continue

    SIZE=$(file_size "$TARGET")
    KIND=$(classify "$TARGET")

    case "$KIND" in
    binary_doc)
      emit_deny "バイナリ文書を ${READ_CMD} しようとしている: ${TARGET}
→ $(advice_for binary_doc "$TARGET")"
      ;;
    structured_json | structured_yaml | tabular)
      if ((SIZE > STRUCTURED_LIMIT)); then
        emit_deny "$(human_size "$SIZE") の構造化ファイルを ${READ_CMD} で全部コンテキストに載せようとしている: ${TARGET}
→ $(advice_for "$KIND" "$TARGET")"
      fi
      ;;
    plain | image)
      if ((SIZE > PLAIN_LIMIT)); then
        emit_deny "$(human_size "$SIZE") のファイルを ${READ_CMD} で全部コンテキストに載せようとしている: ${TARGET}
→ $(advice_for "$KIND" "$TARGET")"
      fi
      ;;
    esac
  done
done <<<"$TERMINAL_SEGMENTS"

exit 0
