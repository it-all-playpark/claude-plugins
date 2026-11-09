#!/usr/bin/env python3
"""List recently closed issues whose body mentions any of the given paths.

git-issue の軽い経路の手順 1 が呼ぶ。パスは finding 由来で `$(…)`・引用符・バッククォートを含みうるので、
受け取る口はファイルだけにし、`gh` へは argv のリストで渡す（シェルを通さない）。同じ仕組みを直した issue かの
判断は呼び出し側の LLM が本文を読んで行い、このスクリプトは件数で経路を決めない。
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

DEFAULT_DAYS = 30
# GitHub の検索 API が返す件数の上限。よく触るファイルは close 済み issue の大半の本文に出るので、
# gh の既定（30 件）では直近の issue が落ちる
SEARCH_LIMIT = 1000


class JsonArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:  # type: ignore[override]
        fail(f"usage: {message}", 2)


def emit(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False))


def fail(message: str, code: int = 1) -> None:
    emit({"ok": False, "error": message})
    sys.exit(code)


def read_paths(path_file: str | None) -> list[str]:
    if not path_file:
        raise ValueError("--path-file is required")
    try:
        text = Path(path_file).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as e:
        raise ValueError(f"cannot read --path-file {path_file}: {e}") from e
    paths: list[str] = []
    for line in text.splitlines():
        if line.strip() and line not in paths:
            paths.append(line)
    if not paths:
        raise ValueError(f"--path-file {path_file} has no paths")
    return paths


def build_command(path: str, repo: str | None) -> list[str]:
    cmd = [
        "gh",
        "issue",
        "list",
        "--state",
        "closed",
        "--search",
        f'"{path}" in:body',
        "--json",
        "number,title,closedAt,body",
        "--limit",
        str(SEARCH_LIMIT),
    ]
    if repo:
        cmd.extend(["--repo", repo])
    return cmd


def search(path: str, repo: str | None) -> list[dict]:
    try:
        result = subprocess.run(build_command(path, repo), capture_output=True, text=True)
    except OSError as e:
        raise RuntimeError(f"cannot run gh: {e}") from e
    if result.returncode != 0:
        message = (result.stderr or result.stdout or "unknown gh error").strip()
        raise RuntimeError(f"gh issue list failed for {path!r} (exit {result.returncode}): {message}")
    try:
        issues = json.loads(result.stdout)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"gh issue list returned invalid JSON for {path!r}: {e}") from e
    if not isinstance(issues, list):
        raise RuntimeError(f"gh issue list returned non-list JSON for {path!r}")
    return issues


def parse_closed_at(value: object) -> datetime:
    if not isinstance(value, str):
        raise RuntimeError(f"issue closedAt is not a string: {value!r}")
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as e:
        raise RuntimeError(f"issue closedAt is not ISO 8601: {value!r}") from e


def collect(paths: list[str], repo: str | None, days: int) -> list[dict]:
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    by_number: dict[int, dict] = {}
    for path in paths:
        for issue in search(path, repo):
            if parse_closed_at(issue.get("closedAt")) < cutoff:
                continue
            number = issue.get("number")
            entry = by_number.setdefault(number, {
                "number": number,
                "title": issue.get("title"),
                "closedAt": issue.get("closedAt"),
                "body": issue.get("body"),
                "matched_paths": [],
            })
            if path not in entry["matched_paths"]:
                entry["matched_paths"].append(path)
    return sorted(by_number.values(), key=lambda i: parse_closed_at(i["closedAt"]), reverse=True)


def parse_args() -> argparse.Namespace:
    parser = JsonArgumentParser(
        description="List closed issues from the last N days whose body mentions a path in --path-file.",
    )
    parser.add_argument("--path-file", help="File with one repo-relative path per line (blank lines ignored)")
    parser.add_argument("--repo", help="Target repository in owner/repo format")
    parser.add_argument("--days", type=int, default=DEFAULT_DAYS, help=f"Window in days (default: {DEFAULT_DAYS})")
    args = parser.parse_args()
    if args.days < 1:
        parser.error("--days must be a positive integer")
    return args


def main() -> None:
    args = parse_args()
    try:
        paths = read_paths(args.path_file)
        issues = collect(paths, args.repo, args.days)
    except (ValueError, RuntimeError) as e:
        fail(str(e))
    emit({"ok": True, "window_days": args.days, "issues": issues})


if __name__ == "__main__":
    main()
