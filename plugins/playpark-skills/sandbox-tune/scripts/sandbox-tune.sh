#!/usr/bin/env bash
# sandbox-tune: transcript から sandbox 拒否・人間への実行依頼・permission 拒否・host-exec の実行を型ごとに集計し、
# 設定 repo の git log と突き合わせてレポートにする。外部へは draft → post を明示したときだけ出す。
#
# Usage:
#   sandbox-tune.sh run     [--days N] [--config F] [--no-verify] [--out DIR] [--projects-dir D] [--now ISO]
#   sandbox-tune.sh collect [--days N] [--projects-dir D] [--now ISO]          # JSON を stdout へ
#   sandbox-tune.sh verify  <analysis.json> [--config F]                       # JSON を stdout へ
#   sandbox-tune.sh report  <analysis.json> [--out DIR]                        # 書いたパスを stdout へ
#   sandbox-tune.sh config  [--config F]                                       # 検証済みの設定を stdout へ
#   sandbox-tune.sh redact                                                     # stdin を伏せ字にして stdout へ
#   sandbox-tune.sh draft   --issue --analysis A --candidates C --ids id[,id] [--config F] [--out DIR]
#   sandbox-tune.sh post    <draft.md> --digest SHA256 [--allow-public]
#
# 設定は既定で cwd の sandbox-tune.json。run は設定（configRepo）が無ければ exit 2 で止まり、
# verify せず collect と report だけにするには --no-verify を明示する。
# --now は集計の基準時刻（UTC の ISO 8601、例 2026-10-01T00:00:00Z）。再現用で、既定は現在時刻。
#
# Exit: 0 成功 / 2 引数・設定の誤り / 3 下書きが表示したものと違う / 4 gh の失敗 / 5 投稿を拒否（公開 repo）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_NAME="sandbox-tune.json"

die() {
  local code="$1"
  shift
  printf 'sandbox-tune: %s\n' "$*" >&2
  exit "$code"
}

jqs() { jq -L "$SCRIPT_DIR" "$@"; }

iso_to_epoch() {
  jq -n --arg t "$1" '$t | sub("\\.[0-9]+"; "") | fromdateiso8601' 2>/dev/null || die 2 "時刻は 2026-10-01T00:00:00Z の形で渡してください: $1"
}

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    sha256sum "$1" | cut -d' ' -f1
  fi
}

home_rel() {
  case "$1" in
    "$HOME"/*) printf '~/%s\n' "${1#"$HOME"/}" ;;
    *) printf '%s\n' "$1" ;;
  esac
}

# 不正な設定は 1 行 1 件のエラーにする。未知のキーも拒否する（打ち間違いで verify や issue 化が黙って外れるのを防ぐ）
validate_jq() {
  cat <<'JQ'
def strs: type == "array" and all(.[]; type == "string" and . != "");
if type != "object" then "設定は JSON オブジェクトにしてください"
else
  (keys - ["configRepo", "criteriaFiles", "issue"] | .[] | "未知のキー: \(.)"),
  (if has("configRepo") then
     .configRepo
     | if type != "object" then "configRepo はオブジェクトにしてください"
       else
         (keys - ["path", "paths"] | .[] | "configRepo の未知のキー: \(.)"),
         (if (.path | type) != "string" or .path == "" then "configRepo.path は空でない文字列にしてください" else empty end),
         (if (.paths | strs | not) or (.paths | length) == 0 then "configRepo.paths は空でない文字列の配列にしてください" else empty end)
       end
   else empty end),
  (if has("criteriaFiles") and (.criteriaFiles | strs | not) then "criteriaFiles は空でない文字列の配列にしてください" else empty end),
  (if has("issue") then
     .issue
     | if type != "object" then "issue はオブジェクトにしてください"
       else
         (keys - ["repo", "template", "labels"] | .[] | "issue の未知のキー: \(.)"),
         (if (.repo | type) != "string" or (.repo | test("\\A[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\\z") | not) then "issue.repo は owner/name の形にしてください" else empty end),
         (if has("template") and ((.template | type) != "string" or .template == "") then "issue.template は空でない文字列にしてください" else empty end),
         (if has("labels") and (.labels | strs | not) then "issue.labels は空でない文字列の配列にしてください" else empty end)
       end
   else empty end)
end
JQ
}

# 検証して、パスを絶対パスに直した設定を出す（~ は $HOME、相対パスは設定ファイルのディレクトリ基準）
load_config() {
  local file="$1" dir errs cfg repo f
  [ -f "$file" ] || die 2 "設定ファイルがありません: $file"
  jq empty "$file" 2>/dev/null || die 2 "設定ファイルが JSON として読めません: $file"
  errs="$(jq -r "$(validate_jq)" "$file")"
  [ -z "$errs" ] || die 2 "設定が不正です ($file):
$errs"
  dir="$(cd "$(dirname "$file")" && pwd)"
  cfg="$(jq --arg home "$HOME" --arg base "$dir" '
    def expand: if . == "~" then $home elif startswith("~/") then $home + .[1:] elif startswith("/") then . else $base + "/" + . end;
    (if .configRepo then .configRepo.path |= expand else . end)
    | (if .criteriaFiles then .criteriaFiles |= map(expand) else . end)
    | (if .issue.template then .issue.template |= expand else . end)' "$file")"
  repo="$(jq -r '.configRepo.path // empty' <<<"$cfg")"
  if [ -n "$repo" ]; then
    git -C "$repo" rev-parse --git-dir >/dev/null 2>&1 || die 2 "configRepo.path が git repo ではありません: $repo"
  fi
  while IFS= read -r f; do
    [ -z "$f" ] || [ -f "$f" ] || die 2 "ファイルがありません: $f"
  done <<<"$(jq -r '(.criteriaFiles // [])[], (.issue.template // empty)' <<<"$cfg")"
  printf '%s\n' "$cfg"
}

# 明示された設定はそのまま読む。省略時は cwd の sandbox-tune.json があれば読み、無ければ空
resolve_config() {
  local explicit="$1"
  if [ -n "$explicit" ]; then
    load_config "$explicit"
  elif [ -f "./$CONFIG_NAME" ]; then
    load_config "./$CONFIG_NAME"
  else
    echo '{}'
  fi
}

cmd_collect() {
  local days=30 projects_dir="$HOME/.claude/projects" now="" until since list events n
  while [ $# -gt 0 ]; do
    case "$1" in
      --days) days="${2:-}"; shift 2 ;;
      --projects-dir) projects_dir="${2:-}"; shift 2 ;;
      --now) now="${2:-}"; shift 2 ;;
      *) die 2 "collect: 不明な引数: $1" ;;
    esac
  done
  [[ "$days" =~ ^[1-9][0-9]*$ ]] || die 2 "--days は正の整数にしてください: $days"
  [ -d "$projects_dir" ] || die 2 "transcript のディレクトリがありません: $projects_dir"
  if [ -n "$now" ]; then until="$(iso_to_epoch "$now")"; else until="$(date +%s)"; fi
  since=$((until - days * 86400))

  list="$(mktemp "${TMPDIR:-/tmp}/sandbox-tune-files.XXXXXX")"
  events="$(mktemp "${TMPDIR:-/tmp}/sandbox-tune-events.XXXXXX")"
  # <project>/<session>.jsonl だけを見る（<project>/<session>/subagents/ 配下は深さで外れる）。
  # 更新日時での絞り込みは基準時刻が現在のときだけ（--now で過去を指すと必要なファイルまで落ちる）
  if [ -n "$now" ]; then
    find "$projects_dir" -mindepth 2 -maxdepth 2 -type f -name '*.jsonl' -print0 >"$list"
  else
    find "$projects_dir" -mindepth 2 -maxdepth 2 -type f -name '*.jsonl' -mtime "-$((days + 1))" -print0 >"$list"
  fi
  n="$(tr -cd '\0' <"$list" | wc -c | tr -d ' ')"
  if [ "$n" -gt 0 ]; then
    xargs -0 jq -R -n -c -L "$SCRIPT_DIR" --arg home "$HOME" --argjson since "$since" --argjson until "$until" \
      -f "$SCRIPT_DIR/extract.jq" <"$list" >"$events"
  fi
  jq -s -L "$SCRIPT_DIR" --argjson since "$since" --argjson until "$until" --argjson days "$days" \
    --argjson files "$n" --arg dir "$(home_rel "$projects_dir")" '
    include "aggregate";
    {generated_at: ($until | todate),
     period: {since: ($since | todate), until: ($until | todate), days: $days},
     projects_dir: $dir, files_scanned: $files, types: aggregate}' "$events"
  rm -f "$list" "$events"
}

cmd_verify() {
  local analysis="" config="" cfg repo commits id needle p
  local paths=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --config) config="${2:-}"; shift 2 ;;
      -*) die 2 "verify: 不明な引数: $1" ;;
      *) analysis="$1"; shift ;;
    esac
  done
  [ -f "$analysis" ] || die 2 "verify: collect の JSON を渡してください"
  cfg="$(resolve_config "$config")"
  repo="$(jq -r '.configRepo.path // empty' <<<"$cfg")"
  [ -n "$repo" ] || die 2 "verify には設定の configRepo が要ります"
  while IFS= read -r p; do paths+=("$p"); done <<<"$(jq -r '.configRepo.paths[]' <<<"$cfg")"

  commits="$(mktemp "${TMPDIR:-/tmp}/sandbox-tune-commits.XXXXXX")"
  # 型の対象（ホスト・パス・コマンド名）が差分に増減した commit と、message に書かれた commit を「関係する commit」とする。
  # 1 語だけの対象（node / git 等）は無関係な commit にも当たり、誤って resolved にして型を隠すので突き合わせない
  while IFS=$'\t' read -r id needle; do
    [ -n "$needle" ] || continue
    {
      git -C "$repo" log -S"$needle" --format='%H%x09%ct%x09%s' -- "${paths[@]}"
      git -C "$repo" log -F --grep="$needle" --format='%H%x09%ct%x09%s' -- "${paths[@]}"
    } | jq -R -c --arg id "$id" 'split("\t") | {id: $id, hash: .[0], epoch: (.[1] | tonumber), subject: (.[2:] | join("\t"))}'
  done <<<"$(jq -r '.types[] | select(.needle | test("[./:_ -]")) | [.id, .needle] | @tsv' "$analysis")" >"$commits"

  jq --slurpfile c "$commits" --arg repo "$(home_rel "$repo")" --argjson paths "$(jq -c '.configRepo.paths' <<<"$cfg")" '
    def epoch: sub("\\.[0-9]+"; "") | fromdateiso8601;
    ($c | group_by(.id) | map({key: .[0].id, value: (unique_by(.hash) | sort_by(-.epoch))}) | from_entries) as $by
    | .verify = {repo: $repo, paths: $paths}
    | .types |= map(
        . as $t
        | ($by[$t.id] // []) as $cs
        | if ($cs | length) == 0 then
            .status = "remaining"
            | .evidence = {commit: null, committed_at: null, subject: null, after_count: $t.count, last_after: $t.last_seen, related_commits: [],
                           note: (if ($t.needle | test("[./:_ -]")) then null else "対象が 1 語で関係する commit を特定できない" end)}
          else
            $cs[0] as $fix
            | [ $t.occurrences[] | select(epoch > $fix.epoch) ] as $after
            | .status = (if ($after | length) == 0 then "resolved" else "remaining" end)
            | .evidence = {commit: $fix.hash, committed_at: ($fix.epoch | todate), subject: $fix.subject,
                           after_count: ($after | length), last_after: ($after | last),
                           related_commits: [ $cs[0:3][] | {hash: .hash[0:12], committed_at: (.epoch | todate), subject} ]}
          end)' "$analysis"
  rm -f "$commits"
}

cmd_report() {
  local analysis="" out="$PWD/claudedocs" md
  while [ $# -gt 0 ]; do
    case "$1" in
      --out) out="${2:-}"; shift 2 ;;
      -*) die 2 "report: 不明な引数: $1" ;;
      *) analysis="$1"; shift ;;
    esac
  done
  [ -f "$analysis" ] || die 2 "report: collect / verify の JSON を渡してください"
  mkdir -p "$out"
  md="$out/sandbox-tune-$(jq -r '.period.until[0:10]' "$analysis").md"
  jqs -r -f "$SCRIPT_DIR/report.jq" "$analysis" >"$md"
  printf '%s\n' "$md"
}

cmd_run() {
  local config="" out="$PWD/claudedocs" no_verify=0 cfg tmp json md
  local collect_args=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --config) config="${2:-}"; shift 2 ;;
      --out) out="${2:-}"; shift 2 ;;
      --no-verify) no_verify=1; shift ;;
      --days | --projects-dir | --now) collect_args+=("$1" "${2:-}"); shift 2 ;;
      *) die 2 "run: 不明な引数: $1" ;;
    esac
  done
  # verify の無いレポートは対応済みの型まで修正候補に見えるので、設定が無ければ止め、集計だけなら --no-verify で明示させる
  if [ "$no_verify" = 0 ] && [ -z "$config" ] && [ ! -f "./$CONFIG_NAME" ]; then
    die 2 "run: 設定がありません（--config も ./$CONFIG_NAME も無い）。configRepo を書いた $CONFIG_NAME を置くか、verify せず集計だけなら --no-verify を付けてください"
  fi
  cfg="$(resolve_config "$config")"
  if [ "$no_verify" = 0 ] && [ -z "$(jq -r '.configRepo.path // empty' <<<"$cfg")" ]; then
    die 2 "run: 設定 (${config:-./$CONFIG_NAME}) に configRepo がありません。$CONFIG_NAME に configRepo を書くか、verify せず集計だけなら --no-verify を付けてください"
  fi
  tmp="$(mktemp "${TMPDIR:-/tmp}/sandbox-tune-run.XXXXXX")"
  cmd_collect ${collect_args[@]+"${collect_args[@]}"} >"$tmp"
  if [ "$no_verify" = 0 ]; then
    cmd_verify "$tmp" --config "${config:-./$CONFIG_NAME}" >"$tmp.v"
    mv "$tmp.v" "$tmp"
  fi
  mkdir -p "$out"
  json="$out/sandbox-tune-$(jq -r '.period.until[0:10]' "$tmp").json"
  jqs --argjson cfg "$cfg" 'include "redact"; .criteria_files = ($cfg.criteriaFiles // []) | redact_all' "$tmp" >"$json"
  rm -f "$tmp"
  md="$(cmd_report "$json" --out "$out")"
  jq -c --arg report "$md" --arg analysis "$json" '{report: $report, analysis: $analysis, verified: (.verify != null),
    types: (.types | length), remaining: ([.types[] | select(.status == "remaining")] | length),
    resolved: ([.types[] | select(.status == "resolved")] | length)}' "$json"
}

cmd_config() {
  local config=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --config) config="${2:-}"; shift 2 ;;
      *) die 2 "config: 不明な引数: $1" ;;
    esac
  done
  resolve_config "$config"
}

cmd_draft() {
  local analysis="" candidates="" ids="" config="" out="$PWD/claudedocs" issue=0 cfg repo template id i=0 base body
  while [ $# -gt 0 ]; do
    case "$1" in
      --issue) issue=1; shift ;;
      --analysis) analysis="${2:-}"; shift 2 ;;
      --candidates) candidates="${2:-}"; shift 2 ;;
      --ids) ids="${2:-}"; shift 2 ;;
      --config) config="${2:-}"; shift 2 ;;
      --out) out="${2:-}"; shift 2 ;;
      *) die 2 "draft: 不明な引数: $1" ;;
    esac
  done
  [ "$issue" = 1 ] || die 2 "draft: issue 化は既定でオフです。ユーザーが --issue を明示したときだけ --issue を付けて呼んでください"
  [ -f "$analysis" ] || die 2 "draft: --analysis に run が書いた JSON を渡してください"
  [ -f "$candidates" ] || die 2 "draft: --candidates に候補の JSON を渡してください"
  [ -n "$ids" ] || die 2 "draft: --ids に issue にする型の id を渡してください"
  cfg="$(resolve_config "$config")"
  repo="$(jq -r '.issue.repo // empty' <<<"$cfg")"
  [ -n "$repo" ] || die 2 "draft には設定の issue.repo が要ります"
  template="$(jq -r '.issue.template // empty' <<<"$cfg")"
  jq -e '(.candidates | type) == "array" and all(.candidates[]; (.id | type) == "string" and ([.title, .cause, .fix, .safety] | all(type == "string" and . != "")))' \
    "$candidates" >/dev/null 2>&1 || die 2 "draft: candidates は {\"candidates\":[{id,title,cause,fix,safety,security}]} の形にしてください"
  mkdir -p "$out"

  while IFS= read -r id; do
    [ -n "$id" ] || continue
    i=$((i + 1))
    jq -e --arg id "$id" 'any(.candidates[]; .id == $id)' "$candidates" >/dev/null || die 2 "draft: 候補にない id です: $id"
    jq -e --arg id "$id" 'any(.types[]; .id == $id)' "$analysis" >/dev/null || die 2 "draft: レポートにない id です: $id"
    base="$out/sandbox-tune-issue-$i"
    body="$(jqs -r -n --arg id "$id" --slurpfile a "$analysis" --slurpfile c "$candidates" \
      --rawfile tpl "${template:-/dev/null}" --arg has_tpl "${template:+1}" '
      include "redact"; include "issue";
      ($a[0].types[] | select(.id == $id)) as $t
      | ($c[0].candidates[] | select(.id == $id)) as $cand
      | (if $has_tpl == "1" then $tpl else default_template end)
      | fill({title: $cand.title, id: $id, cause: $cand.cause, fix: $cand.fix, safety: $cand.safety, evidence: ($t | evidence_md)})
      | redact')"
    printf '%s\n' "$body" >"$base.md"
    jqs -n --arg id "$id" --arg repo "$repo" --arg sha "$(sha256_of "$base.md")" --rawfile body "$base.md" \
      --slurpfile a "$analysis" --slurpfile c "$candidates" --argjson cfg "$cfg" '
      include "redact"; include "issue";
      ($a[0].types[] | select(.id == $id)) as $t
      | ($c[0].candidates[] | select(.id == $id)) as $cand
      | {id: $id, repo: $repo, title: ($cand.title | redact), labels: ($cfg.issue.labels // []),
         security: ($cand | is_security([$cand.title, $cand.cause, $cand.fix, $cand.safety, $t.target, $body] | join("\n"))),
         sha256: $sha}' >"$base.meta.json"
    printf '=== %s.md（提出先 %s / security %s / digest %s）\n' "$base" "$repo" \
      "$(jq -r .security "$base.meta.json")" "$(jq -r .sha256 "$base.meta.json")"
    cat "$base.md"
  done <<<"$(tr ',' '\n' <<<"$ids")"
}

cmd_post() {
  local draft="" digest="" allow_public=0 meta actual repo title security vis
  local label_args=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --digest) digest="${2:-}"; shift 2 ;;
      --allow-public) allow_public=1; shift ;;
      -*) die 2 "post: 不明な引数: $1" ;;
      *) draft="$1"; shift ;;
    esac
  done
  meta="${draft%.md}.meta.json"
  [ -f "$draft" ] && [ -f "$meta" ] || die 2 "post: draft が書いた下書き (.md と .meta.json) を渡してください"
  [ -n "$digest" ] || die 2 "post: 人間に見せた下書きの digest を --digest で渡してください"
  # 人間に見せた内容から変わっていたら出さない（確認を経ずに投稿する経路を作らない）
  actual="$(sha256_of "$draft")"
  [ "$digest" = "$actual" ] && [ "$actual" = "$(jq -r .sha256 "$meta")" ] \
    || die 3 "下書きが人間に見せたものと違います。draft からやり直して確認を取ってください"
  [ "$(jqs -R -s -r 'include "redact"; redact' "$draft")" = "$(cat "$draft")" ] \
    || die 3 "下書きに伏せ字を通っていない文字列があります。draft からやり直してください"

  repo="$(jq -r .repo "$meta")"
  title="$(jq -r .title "$meta")"
  # meta の security が偽でも、本文の語で判定し直す（どちらかで真ならセキュリティ系として扱う）
  security="$(jqs -r -R -s --argjson m "$(cat "$meta")" 'include "issue"; . as $body | $m | is_security($body)' "$draft")"
  vis="$(gh repo view "$repo" --json visibility --jq .visibility)" || die 4 "提出先 $repo の公開範囲を確認できません"
  if [ "$vis" != "PRIVATE" ] && [ "$vis" != "INTERNAL" ]; then
    printf 'sandbox-tune: 警告: 提出先 %s は公開 repo です (%s)\n' "$repo" "$vis" >&2
    if [ "$security" = "true" ]; then
      die 5 "セキュリティ系の候補は公開 repo に投稿しません（--allow-public でも不可）。レポートに留めるか、非公開の報告先（https://github.com/$repo/security/advisories/new の private security advisory 等）を使ってください"
    fi
    [ "$allow_public" = 1 ] || die 5 "公開 repo へ投稿するには --allow-public を付けてください"
  fi
  while IFS= read -r l; do
    [ -z "$l" ] || label_args+=(--label "$l")
  done <<<"$(jq -r '.labels[]?' "$meta")"
  gh issue create --repo "$repo" --title "$title" --body-file "$draft" ${label_args[@]+"${label_args[@]}"} \
    || die 4 "gh issue create が失敗しました"
}

sub="${1:-}"
[ $# -gt 0 ] && shift
case "$sub" in
  run) cmd_run "$@" ;;
  collect) cmd_collect "$@" ;;
  verify) cmd_verify "$@" ;;
  report) cmd_report "$@" ;;
  config) cmd_config "$@" ;;
  redact) jqs -R -s -j 'include "redact"; redact' ;;
  draft) cmd_draft "$@" ;;
  post) cmd_post "$@" ;;
  *) die 2 "使い方: sandbox-tune.sh {run|collect|verify|report|config|redact|draft|post} ...（先頭のコメントを参照）" ;;
esac
