#!/usr/bin/env python3
"""Render dependencies between filed issues as a Mermaid `graph LR`.

git-issue の Phase 7 が呼び、stdout を Output Contract の `## 依存グラフ` に ```mermaid フェンスでそのまま載せる。
図を LLM が手で書くと書き写しの誤りを人間が見分けられないので、起票時に `--blocked-by` に渡した番号から組む。
タイトルは finding 由来で `$(…)` や引用符を含みうるので、受け取る口は JSON ファイルだけにする。

入力: `[{"number": 12, "title": "...", "blocked_by": [11]}, ...]`。`--dry-run` の仮番号（`H1`・`A1`）も番号として受ける。
blocked_by が入力に無い番号を指す・番号が重なる等の不正な入力は、図を出さずに stderr にエラーを出して非 0 で終わる。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

# 番号はノード ID（`n<番号>`）にそのまま使うので、Mermaid の ID に置ける英数字だけを受ける
PLACEHOLDER_RE = re.compile(r"^[A-Za-z0-9]+$")

# ラベルは `["…"]` で囲む。囲みの `"` と、ノードの形・エッジのラベルに読まれる括弧と `|` を
# Mermaid の entity code に置き換え、表示はそのままの文字にする
LABEL_ESCAPES = {
    '"': "#quot;",
    "[": "#91;",
    "]": "#93;",
    "(": "#40;",
    ")": "#41;",
    "|": "#124;",
}


def fail(message: str) -> None:
    print(f"dep_graph: {message}", file=sys.stderr)
    sys.exit(1)


def parse_number(value: object, where: str) -> str:
    if isinstance(value, bool):
        raise ValueError(f"{where} must be an issue number, got {value!r}")
    if isinstance(value, int):
        if value < 1:
            raise ValueError(f"{where} must be a positive issue number, got {value!r}")
        return str(value)
    if isinstance(value, str) and PLACEHOLDER_RE.match(value):
        return value
    raise ValueError(f"{where} must be an issue number or a placeholder like A1, got {value!r}")


def load_issues(path: str) -> list[dict]:
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError) as e:
        raise ValueError(f"cannot read --input {path}: {e}") from e
    except json.JSONDecodeError as e:
        raise ValueError(f"--input {path} is not valid JSON: {e}") from e
    if not isinstance(data, list) or not data:
        raise ValueError("input must be a non-empty JSON array of issues")

    issues: list[dict] = []
    seen: set[str] = set()
    for i, item in enumerate(data):
        if not isinstance(item, dict):
            raise ValueError(f"issue [{i}] must be an object")
        number = parse_number(item.get("number"), f"issue [{i}] number")
        if number in seen:
            raise ValueError(f"issue #{number} appears more than once")
        seen.add(number)
        title = item.get("title")
        if not isinstance(title, str) or not title.strip():
            raise ValueError(f"issue #{number} title must be a non-empty string")
        blocked_by = item.get("blocked_by")
        if not isinstance(blocked_by, list):
            raise ValueError(f"issue #{number} blocked_by must be an array")
        blockers = [parse_number(b, f"issue #{number} blocked_by") for b in blocked_by]
        # 出力は ```mermaid フェンスにそのまま載るので、タイトルの改行（Unicode の行区切りを含む空白類）は
        # 1 つの空白に畳む。1 行に収まればノードの行の途中から ``` でフェンスを閉じられない
        issues.append({"number": number, "title": " ".join(title.split()), "blocked_by": blockers})

    for issue in issues:
        for blocker in issue["blocked_by"]:
            if blocker not in seen:
                raise ValueError(f"issue #{issue['number']} is blocked by #{blocker}, which is not in the input")
            if blocker == issue["number"]:
                raise ValueError(f"issue #{blocker} is blocked by itself")
    return issues


def escape_label(text: str) -> str:
    return "".join(LABEL_ESCAPES.get(c, c) for c in text)


def render(issues: list[dict]) -> str:
    lines = ["graph LR"]
    for issue in issues:
        lines.append(f'  n{issue["number"]}["#{issue["number"]} {escape_label(issue["title"])}"]')
    edges: list[str] = []
    for issue in issues:
        for blocker in issue["blocked_by"]:
            edge = f'  n{blocker} --> n{issue["number"]}'
            if edge not in edges:
                edges.append(edge)
    return "\n".join(lines + edges)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Print a Mermaid graph LR of filed issues, with arrows from each blocker to the issue it blocks.",
    )
    parser.add_argument(
        "--input",
        required=True,
        help='JSON file: [{"number": N, "title": "...", "blocked_by": [M, ...]}, ...]',
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    try:
        issues = load_issues(args.input)
    except ValueError as e:
        fail(str(e))
    print(render(issues))


if __name__ == "__main__":
    main()
