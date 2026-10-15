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
# dev-flow の analyze（dev-issue-analyze/scripts/analyze-issue.sh の SCOPE_MAX_CHARS）は AC 節を除いた本文を
# この字数で切り、切られた部分は implementer に届かない。agent issue はこの上限内でしか起票しない。
# 字数は analyze-issue.sh の scope_total_chars と同じ規則で数える（下の 3 正規表現と scope_total_chars()）。
SCOPE_MAX_CHARS = 4000
AC_HEADING_LINE_RE = re.compile(
    r"^#{2,6}[ \t\n\v\f\r]+(acceptance criteria|受け入れ基準|受け入れ条件|受入基準|受入条件|完了条件)",
    re.IGNORECASE,
)
HEADING_LINE_RE = re.compile(r"^#{1,6}[ \t\n\v\f\r]+")
FENCE_LINE_RE = re.compile(r"^[ \t\n\v\f\r]{0,3}(`{3,}|~{3,})")


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


def build_command(args: argparse.Namespace, body_file: Path) -> list[str]:
    cmd = [
        "gh",
        "issue",
        "create",
        "--title",
        args.title,
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


def scope_total_chars(body: str) -> int:
    """AC 節（最初の AC 見出しから次の見出しまで。フェンス内の見出しは数えない）を除いた本文の字数。

    analyze-issue.sh の extract_non_ac_body と ${#SCOPE_FULL} の移植。bash の $(...) が末尾改行を落とすので、
    入力と出力の末尾改行は数えない。
    """
    kept: list[str] = []
    skip = found = in_fence = False
    for line in body.rstrip("\n").split("\n"):
        if FENCE_LINE_RE.match(line):
            in_fence = not in_fence
            if not skip:
                kept.append(line)
            continue
        if not in_fence and HEADING_LINE_RE.match(line):
            if found:
                skip = False
            elif AC_HEADING_LINE_RE.match(line):
                found = skip = True
                continue
        if not skip:
            kept.append(line)
    return len("\n".join(kept).rstrip("\n"))


def check_scope_chars(body: str) -> None:
    total = scope_total_chars(body)
    if total > SCOPE_MAX_CHARS:
        raise ValueError(
            f"agent issue の本文（AC 節を除く）が {total} 字で、上限 {SCOPE_MAX_CHARS} 字を {total - SCOPE_MAX_CHARS} 字超えている。"
            "dev-flow の analyze は超えた部分を切り、implementer に届かない。"
            "調査結果・実装計画・レビュー履歴を書き写さず、ゴールと制約・取らないことに要点を絞って書き直す"
        )


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
    ensure_body_file(args.body_file)
    body = args.body_file.read_text(encoding="utf-8")
    check_kind(args.kind, body)
    report = lint_ac(args.body_file)
    if args.kind == "human" and report.get("verdict") != "t1":
        raise ValueError("human issue の `## 完了条件` は `- [ ]` checkbox で書く（ac-lint verdict t1 が必要）")

    blocked_by = parse_blocked_by(args.blocked_by)
    final_body = ensure_blocked_by_lines(body, blocked_by)
    if args.kind == "agent":
        # 起票される本文（先頭に足す Blocked by 行を含む）を analyze が読むので、追記後の本文で数える
        check_scope_chars(final_body)

    if args.dry_run:
        preview = final_body.splitlines()
        print("Dry run: issue will not be created.")
        if args.kind == "human":
            print(f"Label command: {command_to_string(build_label_command(args))}")
        print(f"Command: {command_to_string(build_command(args, args.body_file))}")
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
        return create(args, body_file, blocked_by)
    finally:
        if body_file != args.body_file:
            body_file.unlink(missing_ok=True)


def create(args: argparse.Namespace, body_file: Path, blocked_by: list[int]) -> int:
    cmd = build_command(args, body_file)
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
    parser = argparse.ArgumentParser(
        description="Create a GitHub issue from a markdown file.",
    )
    parser.add_argument("--title", required=True, help="Issue title")
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
        help="agent: implementation issue (rejects `executor: human`, requires `## 変更対象パス`, "
        "caps the non-AC body at 4000 chars) / human: human-task issue",
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
