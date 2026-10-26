#!/usr/bin/env bash
# PreToolUse(Edit|Write) hook: inline 生成区間への直接編集の防止
#
# 目的:
#   skills repo の tools/sync-inlines.mjs が _lib/ の canonical ソースから
#   .claude/workflows/*.js に inline 生成するコード区間を、Edit/Write で
#   直接書き換えられないようにする。生成物を手で編集すると、次回
#   sync-inlines.mjs --write 実行時に変更が黙って上書き・消失するため、
#   canonical 側（_lib/）を編集して再生成する運用を deterministic に強制する。
#
#   一方で、対象ファイルは inline 生成区間だけでなく大量の手書きコードを
#   含むことがある（例: dev-flow.js は生成区間外が大半）。ファイル単位で
#   一律 deny すると手書き区間への正規の Edit まで塞いでしまうため、
#   Edit は「生成区間そのものに触れる場合」のみ deny する。
#
# 検知対象:
#   1. tool_input.file_path が正規表現 (^|/)\.claude/workflows/[^/]+\.js$ に
#      マッチするファイルへの Edit/Write
#   2. Write: 以下のいずれかが生成マーカーを含む場合に deny
#      - 編集対象ファイルが既に存在し、その内容にマーカーを含む
#        （生成物の全体書き換え・削除を防ぐ）
#      - 新規内容（tool_input.content）にマーカーを含む
#        （生成物の手書き再作成 — 存在しないファイルへの Write も対象）
#   3. Edit: 以下のいずれかに該当する場合のみ deny（ファイル全体では判定しない）
#      - tool_input.old_string または tool_input.new_string がマーカー行
#        （BEGIN/END inline コメント）そのものを含む
#      - tool_input.old_string の、現在のファイル内での一致位置が
#        BEGIN〜END の生成区間の行範囲と重なる
#      いずれにも該当しなければ、ファイルに生成区間が存在していても
#      手書き区間への Edit として通過させる。
#   4. マーカー正規表現は skills repo の tools/sync-inlines.mjs の
#      BEGIN_RE = /^\/\/ ==== BEGIN inline: (\S+) .*====$/ / END_RE と同形
#      （grep -E '^// ==== BEGIN inline: ' 等）。行頭アンカー必須 —
#      文字列リテラル・ドキュメント内での言及への誤爆を防ぐ。
#
# 出力:
#   - 検知時: stdout に
#       {"hookSpecificOutput":{"hookEventName":"PreToolUse",
#         "permissionDecision":"deny",
#         "permissionDecisionReason":"<理由>"}}
#   - 非検知時: stdout 空で exit 0（チェーン通過 → Claude 通常の permission flow）
#
# 正規の再生成経路（deny されないことをテストで担保）:
#   `node tools/sync-inlines.mjs --write` は Bash tool 経由の実行であり、
#   本 hook は Edit/Write のみを対象とするため妨げられない。
#
# 誤検知（false-positive）テストケース:
#   - マーカーを含まない .claude/workflows/*.js への Edit
#   - canonical 側（_lib/ 配下）への Edit
#   - .claude/workflows/ 配下でも拡張子が .js でないファイル（README.md 等）
#   - 行頭 `// ==== BEGIN inline: ` 形式ではなく、文字列リテラル内に
#     "BEGIN inline:" という語だけが現れるケース（行頭アンカーで除外）
#   - 生成区間を含むファイルであっても、old_string が生成区間外
#     （手書きコード）にのみ一致する Edit
#   詳細は pretool-inline-edit-guard.test.sh を参照。

set -euo pipefail

INPUT=$(cat)

TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty')
if [[ $TOOL != "Edit" && $TOOL != "Write" ]]; then
  exit 0
fi

FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
if [[ -z $FILE_PATH ]]; then
  exit 0
fi

if ! echo "$FILE_PATH" | grep -qE '(^|/)\.claude/workflows/[^/]+\.js$'; then
  exit 0
fi

MARKER_RE='^// ==== (BEGIN|END) inline: '

deny() {
  local file_path="$1"
  jq -n --arg reason "${file_path} は tools/sync-inlines.mjs の生成区間を含む生成物。_lib/ の canonical 側（マーカー内に記載のパス）を編集し、node tools/sync-inlines.mjs --write で再生成せよ" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    }
  }'
  exit 0
}

# マーカー行（BEGIN/END inline コメント）そのものを含むか
contains_marker_line() {
  local text="$1"
  [[ -z $text ]] && return 1
  # here-string で渡す: 早く終わる grep -q へ pipe すると、一致の後ろが 64KB を超えたとき
  # 残りの write が SIGPIPE になり pipefail で偽（= deny 漏れ）になる
  grep -qE "$MARKER_RE" <<<"$text"
}

# needle（old_string）の、file_path 内での一致位置が
# BEGIN〜END の生成区間の行範囲と重なるかを判定する。
# 一致しない/区間が存在しない場合は「重ならない」として扱う
# （実際に一致しない old_string は Edit tool 自体が別途エラーにするため、
#   本 hook では false-negative 側に倒して害はない）。
overlaps_marked_region() {
  local file_path="$1"
  local needle="$2"

  [[ -z $needle ]] && return 1
  [[ -f $file_path ]] || return 1

  local needle_file
  needle_file=$(mktemp "${TMPDIR:-/tmp}/inline-guard-needle.XXXXXX")
  printf '%s' "$needle" >"$needle_file"

  local overlap
  overlap=$(perl -e '
    my ($file, $needle_file) = @ARGV;
    local $/;
    open(my $ff, "<", $file) or do { print "0"; exit };
    my $content = <$ff>;
    close($ff);
    open(my $nf, "<", $needle_file) or do { print "0"; exit };
    my $needle = <$nf>;
    close($nf);
    if (!defined($needle) || $needle eq "") { print "0"; exit; }

    my @lines = split /\n/, $content, -1;
    my @regions;
    my $open_start;
    for my $i (0 .. $#lines) {
      if ($lines[$i] =~ /^\/\/ ==== BEGIN inline: /) {
        $open_start = $i + 1;
      } elsif ($lines[$i] =~ /^\/\/ ==== END inline: /) {
        if (defined $open_start) {
          push @regions, [$open_start, $i + 1];
          $open_start = undef;
        }
      }
    }
    # BEGIN に対応する END が見つからない場合は、安全側に倒して
    # ファイル末尾までを生成区間とみなす
    push @regions, [$open_start, scalar(@lines)] if defined $open_start;
    if (!@regions) { print "0"; exit; }

    my $idx = index($content, $needle);
    if ($idx < 0) { print "0"; exit; }

    my $before = substr($content, 0, $idx);
    my $start_line = (() = $before =~ /\n/g) + 1;
    my $newlines_in_needle = (() = $needle =~ /\n/g);
    my $end_line = $start_line + $newlines_in_needle;

    for my $r (@regions) {
      my ($rs, $re) = @$r;
      if ($start_line <= $re && $end_line >= $rs) {
        print "1";
        exit;
      }
    }
    print "0";
  ' "$file_path" "$needle_file")

  rm -f "$needle_file"
  [[ $overlap == "1" ]]
}

if [[ $TOOL == "Write" ]]; then
  if [[ -f $FILE_PATH ]] && grep -qE "$MARKER_RE" "$FILE_PATH"; then
    deny "$FILE_PATH"
  fi

  CONTENT=$(echo "$INPUT" | jq -r '.tool_input.content // empty')
  if contains_marker_line "$CONTENT"; then
    deny "$FILE_PATH"
  fi

  exit 0
fi

# TOOL == "Edit": ファイル全体ではなく、生成区間そのものに触れる編集のみ deny
OLD_STRING=$(echo "$INPUT" | jq -r '.tool_input.old_string // empty')
NEW_STRING=$(echo "$INPUT" | jq -r '.tool_input.new_string // empty')

if contains_marker_line "$OLD_STRING" || contains_marker_line "$NEW_STRING"; then
  deny "$FILE_PATH"
fi

if overlaps_marked_region "$FILE_PATH" "$OLD_STRING"; then
  deny "$FILE_PATH"
fi

# 検知なし: pass-through（生成区間を含むファイルでも、手書き区間への Edit は通過）
exit 0
