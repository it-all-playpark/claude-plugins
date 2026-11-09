#!/usr/bin/env python3
"""Create a GitHub issue from a prepared markdown body file."""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

# human タスクのマーカー。references/issue-template.md の `executor: human` と同じ固定文字列で、
# agent issue に 1 つでも残っていれば起票を拒否する（LLM の判断に依存しない決定論ゲート）。
HUMAN_MARKER_RE = re.compile(r"executor:[ \t]*human\b")
HUMAN_TASK_LABEL = "human-task"
HUMAN_TASK_LABEL_COLOR = "FBCA04"
HUMAN_TASK_LABEL_DESCRIPTION = "人手作業（executor: human）。完了後に Blocked by の実装 issue を進める"
STEPS_HEADING_RE = re.compile(r"^##[ \t]+手順[ \t]*$", re.MULTILINE)
DONE_HEADING_RE = re.compile(r"^##[ \t]+完了条件[ \t]*$", re.MULTILINE)
# agent issue の `## 変更対象パス` 欄（1 行 1 エントリ `- <repo 相対パスまたは glob>`）。
# 後続の並列起動判定が「触る範囲の申告」として読むので、repo の外を指すエントリは受理しない。
PATHS_HEADING_RE = re.compile(r"^##[ \t]+変更対象パス[ \t]*$", re.MULTILINE)
NEXT_SECTION_RE = re.compile(r"^#{1,2}[ \t]", re.MULTILINE)
PATH_ENTRY_RE = re.compile(r"^-[ \t]+(\S.*?)[ \t]*$", re.MULTILINE)
ISSUE_URL_RE = re.compile(r"/issues/(\d+)$")
# agent issue の本文の文章の上限。本文をゴールと境界条件に絞るためのもので、調査結果や実装計画を書き写した
# 長い本文を止める。モック・スキーマ・出力例のような仕様の例は長くてよいので、閉じたコードフェンスの中身は数えない
# （中身が仕様の例かは決定論で判定できないので、issue-plan-reviewer が devils-advocate-checklist.md の項目で判定する）。
# AC 節の境界は dev-flow の analyze-issue.sh と同じ規則で決める（下の 3 正規表現と split_ac_section()）。
PROSE_MAX_CHARS = 4000
AC_HEADING_LINE_RE = re.compile(
    r"^#{2,6}[ \t\n\v\f\r]+(acceptance criteria|受け入れ基準|受け入れ条件|受入基準|受入条件|完了条件)",
    re.IGNORECASE,
)
HEADING_LINE_RE = re.compile(r"^#{1,6}[ \t\n\v\f\r]+")
FENCE_LINE_RE = re.compile(r"^[ \t\n\v\f\r]{0,3}(`{3,}|~{3,})")
# 字数から除くコードフェンスの開始行と閉じ行。GitHub が描画するフェンス（CommonMark）と同じ規則で対応を取る
FENCE_OPEN_RE = re.compile(r"^ {0,3}(`{3,}|~{3,})(.*)$")
FENCE_CLOSE_RE = re.compile(r"^ {0,3}(`{3,}|~{3,})[ \t]*$")
# AC 節の checkbox 行。analyze-issue.sh の extract_contract_ac_items（checkbox）と同じ規則で marker を除いた本文を取る
AC_CHECKBOX_RE = re.compile(r"^[ \t\n\v\f\r]*[-*][ \t\n\v\f\r]*\[[ xX]\][ \t\n\v\f\r]*")
# 対象 repo の owner/name を origin の URL から取る（dev-flow/scripts/prerun.sh の repo 解決と同じ形）
GITHUB_ORIGIN_PREFIXES = ("https://github.com/", "git@github.com:", "ssh://git@github.com/")


def split_csv(raw: str | None) -> list[str]:
    if not raw:
        return []
    return [item.strip() for item in raw.split(",") if item.strip()]


def parse_blocked_by(raw: str | None) -> list[int]:
    numbers: list[int] = []
    for item in split_csv(raw):
        if not re.fullmatch(r"[1-9][0-9]*", item):
            raise ValueError(f"--blocked-by must be comma-separated issue numbers: {item!r}")
        if int(item) not in numbers:
            numbers.append(int(item))
    return numbers


def api_repo(args: argparse.Namespace) -> str:
    # gh api は {owner}/{repo} をカレント repo に展開する
    return args.repo or "{owner}/{repo}"


def build_command(args: argparse.Namespace, title: str, body_file: Path) -> list[str]:
    cmd = [
        "gh",
        "issue",
        "create",
        "--title",
        title,
        "--body-file",
        str(body_file),
    ]

    if args.repo:
        cmd.extend(["--repo", args.repo])

    labels = split_csv(args.labels)
    if args.kind == "human" and HUMAN_TASK_LABEL not in labels:
        labels.append(HUMAN_TASK_LABEL)
    for label in labels:
        cmd.extend(["--label", label])

    for assignee in split_csv(args.assignees):
        cmd.extend(["--assignee", assignee])

    if args.milestone:
        cmd.extend(["--milestone", args.milestone])

    return cmd


def build_label_command(args: argparse.Namespace) -> list[str]:
    cmd = [
        "gh",
        "label",
        "create",
        HUMAN_TASK_LABEL,
        "--color",
        HUMAN_TASK_LABEL_COLOR,
        "--description",
        HUMAN_TASK_LABEL_DESCRIPTION,
        "--force",
    ]
    if args.repo:
        cmd.extend(["--repo", args.repo])
    return cmd


def build_dependency_command(args: argparse.Namespace, issue: int | str, blocker_id: int | str) -> list[str]:
    return [
        "gh",
        "api",
        "--method",
        "POST",
        f"repos/{api_repo(args)}/issues/{issue}/dependencies/blocked_by",
        "-F",
        f"issue_id={blocker_id}",
    ]


def read_title(path: Path) -> str:
    """タイトルファイルの中身から前後の空白と末尾改行を除いた 1 行。

    タイトルは finding 由来で `$(…)` やバッククォートを含みうるので、コマンド文字列ではなくファイルで受ける。
    """
    try:
        title = path.read_text(encoding="utf-8").strip()
    except (OSError, UnicodeDecodeError) as e:
        raise ValueError(f"title file を読めない: {path}: {e}") from e
    if not title:
        raise ValueError(f"title file が空: {path}")
    if len(title.splitlines()) > 1:
        raise ValueError(f"title file が 2 行以上（タイトルは 1 行で書く）: {path}")
    return title


def ensure_body_file(path: Path) -> None:
    if not path.exists():
        raise FileNotFoundError(f"body file not found: {path}")
    if not path.is_file():
        raise ValueError(f"body path is not a file: {path}")
    if path.stat().st_size == 0:
        raise ValueError(f"body file is empty: {path}")


def check_kind(kind: str, body: str) -> None:
    if kind == "agent":
        if HUMAN_MARKER_RE.search(body):
            raise ValueError(
                "agent issue の本文に `executor: human` が残っている。"
                "人手作業は --kind human で別 issue に切り出して先に起票し、"
                "この issue は --blocked-by <human issue 番号> 付きで起票せよ"
            )
        check_target_paths(body)
        return
    if not STEPS_HEADING_RE.search(body):
        raise ValueError("human issue の本文に `## 手順` 見出しが無い")
    if not DONE_HEADING_RE.search(body):
        raise ValueError("human issue の本文に `## 完了条件` 見出しが無い（完了確認は `- [ ]` checkbox で書く）")


def check_target_paths(body: str) -> None:
    heading = PATHS_HEADING_RE.search(body)
    if not heading:
        raise ValueError(
            "agent issue の本文に `## 変更対象パス` 見出しが無い"
            "（1 行 1 エントリ `- <repo 相対パスまたは glob>` で触るパスを書く）"
        )
    section = body[heading.end():]
    next_section = NEXT_SECTION_RE.search(section)
    if next_section:
        section = section[: next_section.start()]
    entries = PATH_ENTRY_RE.findall(section)
    if not entries:
        raise ValueError("`## 変更対象パス` にエントリが無い（1 行 1 エントリ `- <repo 相対パスまたは glob>`）")
    for entry in entries:
        if entry.startswith("/"):
            raise ValueError(f"`## 変更対象パス` のエントリが `/` 始まり（repo 相対パスで書く）: {entry}")
        if ".." in entry.split("/"):
            raise ValueError(f"`## 変更対象パス` のエントリが `..` セグメントを含む（repo の外を指せない）: {entry}")


def split_ac_section(body: str) -> tuple[list[str], list[str]]:
    """本文を AC 節（最初の AC 見出しから次の見出しまで。フェンス内の見出しは数えない）以外の行と AC 節の行に分ける。

    analyze-issue.sh の extract_non_ac_body / extract_ac_section の移植。bash の $(...) が末尾改行を落とすので、
    入力の末尾改行は数えない。
    """
    kept: list[str] = []
    section: list[str] = []
    skip = found = in_fence = False
    for line in body.rstrip("\n").split("\n"):
        if FENCE_LINE_RE.match(line):
            in_fence = not in_fence
            (section if skip else kept).append(line)
            continue
        if not in_fence and HEADING_LINE_RE.match(line):
            if found:
                skip = False
            elif AC_HEADING_LINE_RE.match(line):
                found = skip = True
                continue
        (section if skip else kept).append(line)
    return kept, section


def drop_closed_fence_content(lines: list[str]) -> list[str]:
    """閉じたコードフェンスの中身の行を落とす。フェンス行は残す。

    閉じていないフェンスの中身は残す（閉じ忘れで字数検査を抜けられないようにする）。
    閉じ行は開始行と同じ文字で同じ長さ以上の、info string の無い行に限る（``` は ~~~ や ```html では閉じない）。
    """
    kept: list[str] = []
    content: list[str] = []
    fence = None
    for line in lines:
        if fence is None:
            kept.append(line)
            opened = FENCE_OPEN_RE.match(line)
            # ``` の info string に ` があれば行内コードでフェンスではない
            if opened and not (opened[1][0] == "`" and "`" in opened[2]):
                fence = opened[1]
            continue
        closed = FENCE_CLOSE_RE.match(line)
        if closed and closed[1][0] == fence[0] and len(closed[1]) >= len(fence):
            kept.append(line)
            content = []
            fence = None
            continue
        content.append(line)
    return kept + content


def prose_chars(body: str) -> int:
    """AC 節と閉じたコードフェンスの中身を除いた本文の字数（末尾の改行は数えない）。"""
    kept, _ = split_ac_section(body)
    return len("\n".join(drop_closed_fence_content(kept)).rstrip("\n"))


def check_prose_chars(body: str) -> None:
    total = prose_chars(body)
    if total > PROSE_MAX_CHARS:
        raise ValueError(
            f"agent issue の本文の文章（AC 節と閉じたコードフェンスの中身を除く）が {total} 字で、"
            f"上限 {PROSE_MAX_CHARS} 字を {total - PROSE_MAX_CHARS} 字超えている。"
            f"{PROSE_MAX_CHARS} 字は本文の文章をゴールと境界条件に絞るための上限で、閉じていないフェンスの中身は文章として数える。"
            "調査結果・実装計画・レビュー履歴を書き写さず、ゴールと制約・取らないことに要点を絞って書き直す"
        )


def ac_checkbox_items(body: str) -> list[str]:
    """AC 節の checkbox 行の本文（marker を除き、空のものは落とす）。dev-flow の analyze が AC として読むものと同じ。"""
    _, section = split_ac_section(body)
    items: list[str] = []
    for line in section:
        marker = AC_CHECKBOX_RE.match(line)
        if marker and line[marker.end():].strip(" \t\n\v\f\r"):
            items.append(line[marker.end():])
    return items


def origin_repo() -> str | None:
    """カレントの git repo の origin（GitHub）の owner/name。決まらなければ None。"""
    try:
        result = subprocess.run(["git", "remote", "get-url", "origin"], capture_output=True, text=True)
    except OSError:
        return None
    if result.returncode != 0:
        return None
    url = result.stdout.strip()
    for prefix in GITHUB_ORIGIN_PREFIXES:
        if url.startswith(prefix):
            slug = url[len(prefix):].rstrip("/").removesuffix(".git")
            if re.fullmatch(r"[^/]+/[^/]+", slug):
                return slug
    return None


def classify_ac_actors(items: list[str], repo: str | None) -> dict:
    """_lib/scripts/ac-actor-classify.mjs（判定規則は _lib/ac-actor.mjs の 1 か所）で AC を分類する。

    起動できない・非 0 終了・出力が読めないときは RuntimeError（判定できない AC を通過扱いにしない）。
    """
    script = Path(__file__).resolve().parents[2] / "_lib" / "scripts" / "ac-actor-classify.mjs"
    cmd = ["node", str(script)]
    if repo:
        cmd.extend(["--repo", repo])
    try:
        result = subprocess.run(
            cmd,
            input=json.dumps(items, ensure_ascii=False),
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
    except OSError as e:
        raise RuntimeError(f"AC の人手判定（ac-actor-classify.mjs）を起動できないので起票しない: {e}") from e
    if result.returncode != 0:
        message = (result.stderr or result.stdout or "unknown error").strip()
        raise RuntimeError(
            f"AC の人手判定（ac-actor-classify.mjs）が exit {result.returncode} で失敗したので起票しない: {message}"
        )
    try:
        report = json.loads(result.stdout)
    except (json.JSONDecodeError, ValueError) as e:
        raise RuntimeError(f"AC の人手判定（ac-actor-classify.mjs）の出力が JSON として読めないので起票しない: {e}") from e
    actors = report.get("actors") if isinstance(report, dict) else None
    reasons = report.get("mixed_reasons") if isinstance(report, dict) else None
    if not (
        isinstance(actors, list)
        and len(actors) == len(items)
        and all(isinstance(a, str) for a in actors)
        and isinstance(reasons, list)
        and all(isinstance(r, str) for r in reasons)
    ):
        raise RuntimeError(f"AC の人手判定（ac-actor-classify.mjs）の出力の形が不正なので起票しない: {result.stdout.strip()}")
    return report


def check_ac_actors(body: str, repo: str | None) -> None:
    """dev-flow が人手扱いにする AC（actor human / repo 内外の混在）を含む agent issue を拒否する。"""
    items = ac_checkbox_items(body)
    if not items:
        return
    report = classify_ac_actors(items, repo)
    problems: list[str] = []
    human = [i for i, actor in enumerate(report["actors"]) if actor == "human"]
    if human:
        listed = "\n".join(f"  AC-{i + 1}「{items[i]}」" for i in human)
        problems.append(
            "agent issue の AC に dev-flow が人手扱いにするもの（_lib/ac-actor.mjs の classifyAcActor が human）がある:\n"
            f"{listed}\n"
            "人の作業は `--kind human` で別 issue に切り出して先に起票し、この issue は `--blocked-by` で紐付けよ"
        )
    problems.extend(report["mixed_reasons"])
    if problems:
        raise ValueError("\n".join(problems))


def has_blocked_by_line(body: str, number: int) -> bool:
    pattern = re.compile(
        rf"^[ \t]*(?:[-*][ \t]+)?blocked by\b[^\n]*(?<![\w./-])#{number}\b",
        re.IGNORECASE | re.MULTILINE,
    )
    return bool(pattern.search(body))


def ensure_blocked_by_lines(body: str, blocked_by: list[int]) -> str:
    missing = [n for n in blocked_by if not has_blocked_by_line(body, n)]
    if not missing:
        return body
    lines = "\n".join(f"Blocked by #{n}" for n in missing)
    return f"{lines}\n\n{body}"


def lint_ac(body_file: Path) -> dict:
    script = Path(__file__).resolve().parents[2] / "_lib" / "scripts" / "ac-lint.sh"
    if not script.exists():
        raise RuntimeError(f"AC lint script not found: {script}")

    result = subprocess.run(
        ["bash", str(script), str(body_file)],
        capture_output=True,
        text=True,
    )

    if result.returncode not in (0, 3):
        message = (result.stderr or result.stdout or "unknown ac-lint error").strip()
        raise RuntimeError(f"AC lint script failed: {message}")

    try:
        report = json.loads(result.stdout)
    except (json.JSONDecodeError, ValueError) as e:
        raise RuntimeError(f"AC lint script returned invalid JSON: {e}") from e

    if result.returncode == 3 or report.get("verdict") == "non_compliant":
        raise ValueError(
            "issue body does not satisfy the AC contract "
            "(missing AC heading and/or checkbox items). "
            "Add one of the headings "
            "'## 受け入れ基準' / '受け入れ条件' / '受入基準' / '受入条件' / "
            "'Acceptance Criteria' / '完了条件' "
            "followed by '- [ ]' checkbox items. "
            "If checkbox items already exist without a heading, insert "
            "'## 受け入れ基準（Acceptance Criteria）' directly above the checkbox "
            "block and re-run."
        )

    if report.get("verdict") == "t2":
        print(
            "Warning: AC section uses plain bullets (T2). "
            "Prefer `- [ ]` checkboxes (T1).",
            file=sys.stderr,
        )

    return report


def ensure_gh_ready() -> None:
    if shutil.which("gh") is None:
        raise RuntimeError("gh CLI is not installed or not in PATH")

    auth = subprocess.run(
        ["gh", "auth", "status"],
        capture_output=True,
        text=True,
    )
    if auth.returncode != 0:
        message = (auth.stderr or auth.stdout or "unknown auth error").strip()
        raise RuntimeError(f"gh auth check failed: {message}")


def resolve_blocker_id(args: argparse.Namespace, number: int) -> int:
    result = subprocess.run(
        ["gh", "api", f"repos/{api_repo(args)}/issues/{number}"],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        message = (result.stderr or result.stdout or "unknown gh error").strip()
        raise RuntimeError(f"blocked-by issue #{number} を読み取れない: {message}")
    try:
        issue_id = json.loads(result.stdout).get("id")
    except (json.JSONDecodeError, ValueError, AttributeError) as e:
        raise RuntimeError(f"blocked-by issue #{number} の応答が不正: {e}") from e
    if not isinstance(issue_id, int):
        raise RuntimeError(f"blocked-by issue #{number} の応答に id が無い")
    return issue_id


def register_dependencies(args: argparse.Namespace, url: str, blocker_ids: dict[int, int]) -> int:
    match = ISSUE_URL_RE.search(url)
    failed = False
    for number, blocker_id in blocker_ids.items():
        issue = match.group(1) if match else "<issue-number>"
        cmd = build_dependency_command(args, issue, blocker_id)
        if match:
            result = subprocess.run(cmd, capture_output=True, text=True)
            if result.returncode == 0:
                continue
            message = (result.stderr or result.stdout or "unknown gh error").strip()
        else:
            message = "gh の出力から issue 番号を取得できない"
        failed = True
        print(f"Error: Blocked by #{number} の依存登録に失敗: {message}", file=sys.stderr)
        print(f"  issue: {url or '(URL 不明)'}", file=sys.stderr)
        print(f"  手動登録: {command_to_string(cmd)}", file=sys.stderr)
    return 1 if failed else 0


def command_to_string(cmd: list[str]) -> str:
    return " ".join(shlex.quote(part) for part in cmd)


def run(args: argparse.Namespace) -> int:
    title = read_title(args.title_file)
    ensure_body_file(args.body_file)
    body = args.body_file.read_text(encoding="utf-8")
    check_kind(args.kind, body)
    report = lint_ac(args.body_file)
    if args.kind == "human" and report.get("verdict") != "t1":
        raise ValueError("human issue の `## 完了条件` は `- [ ]` checkbox で書く（ac-lint verdict t1 が必要）")
    if args.kind == "agent":
        check_ac_actors(body, args.repo or origin_repo())

    blocked_by = parse_blocked_by(args.blocked_by)
    final_body = ensure_blocked_by_lines(body, blocked_by)
    if args.kind == "agent":
        # 起票される本文（先頭に足す Blocked by 行を含む）で数える
        check_prose_chars(final_body)

    if args.dry_run:
        preview = final_body.splitlines()
        print("Dry run: issue will not be created.")
        if args.kind == "human":
            print(f"Label command: {command_to_string(build_label_command(args))}")
        print(f"Command: {command_to_string(build_command(args, title, args.body_file))}")
        for number in blocked_by:
            dep = build_dependency_command(args, "<new>", f"<id of #{number}>")
            print(f"Blocked by #{number}: {command_to_string(dep)}")
        print(f"Body file: {args.body_file}")
        if final_body != body:
            print("Body: Blocked by 行を先頭に追記した本文で起票する")
        print("Body preview (first 20 lines):")
        for line in preview[:20]:
            print(line)
        return 0

    body_file = args.body_file
    if final_body != body:
        fd, tmp = tempfile.mkstemp(prefix="create-issue-body-", suffix=".md")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(final_body)
        body_file = Path(tmp)

    try:
        return create(args, title, body_file, blocked_by)
    finally:
        if body_file != args.body_file:
            body_file.unlink(missing_ok=True)


def create(args: argparse.Namespace, title: str, body_file: Path, blocked_by: list[int]) -> int:
    cmd = build_command(args, title, body_file)
    ensure_gh_ready()
    blocker_ids = {number: resolve_blocker_id(args, number) for number in blocked_by}

    if args.kind == "human":
        label = subprocess.run(build_label_command(args), capture_output=True, text=True)
        if label.returncode != 0:
            message = (label.stderr or label.stdout or "unknown gh error").strip()
            raise RuntimeError(f"failed to create label {HUMAN_TASK_LABEL}: {message}")

    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        message = (result.stderr or result.stdout or "unknown gh error").strip()
        print(f"Failed to create issue: {message}", file=sys.stderr)
        return result.returncode

    output = (result.stdout or "").strip()
    url = output.splitlines()[-1] if output else ""
    if url:
        print(url)
    else:
        print("Issue created, but no URL returned by gh.")
    return register_dependencies(args, url, blocker_ids)


def parse_args() -> argparse.Namespace:
    # allow_abbrev=False: 既定の前方一致だと --title が --title-file の省略形として通り、値を直接受ける口が残る
    parser = argparse.ArgumentParser(
        description="Create a GitHub issue from a markdown file.",
        allow_abbrev=False,
    )
    parser.add_argument(
        "--title-file",
        type=Path,
        required=True,
        help="Path to a file holding the issue title (one line; surrounding whitespace is stripped)",
    )
    parser.add_argument(
        "--body-file",
        type=Path,
        required=True,
        help="Path to markdown file used as issue body",
    )
    parser.add_argument("--repo", help="Target repository in owner/repo format")
    parser.add_argument("--labels", help="Comma-separated labels")
    parser.add_argument("--assignees", help="Comma-separated assignees")
    parser.add_argument("--milestone", help="Milestone name")
    parser.add_argument(
        "--kind",
        choices=["agent", "human"],
        default="agent",
        help="agent: implementation issue (rejects `executor: human` and ACs dev-flow treats as human/mixed, "
        "requires `## 変更対象パス`, caps the body prose at 4000 chars, not counting the AC section or the contents "
        "of closed code fences; the contents of an unclosed fence count) / human: human-task issue",
    )
    parser.add_argument("--blocked-by", help="Comma-separated issue numbers this issue is blocked by")
    parser.add_argument("--dry-run", action="store_true", help="Preview only")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    try:
        sys.exit(run(args))
    except (FileNotFoundError, ValueError, RuntimeError) as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
