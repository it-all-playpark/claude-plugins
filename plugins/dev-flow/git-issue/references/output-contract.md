# Output Contract

実行後に必ず返すサマリー:

```markdown
## Issue Creation Result
- 言語: ja/en
- タイトル: ...
- リポジトリ: ...
- URL: ... (or Dry-run)

## Human Tasks
- human issue: #N タイトル — URL (or Dry-run: 起票予定)
- 依存関係: 実装 issue #M は Blocked by #N（dependencies API 登録: ok / 失敗 → 手動登録コマンド）
- (human タスクが無い場合は `- なし`)

## Agent Issues
- agent issue（起票順 = トポロジカル順）:
  - #M1 タイトル — URL (or Dry-run: A1 起票予定) — 変更対象パス: path/a, path/b/*
  - #M2 タイトル — URL (or Dry-run: A2 起票予定) — 変更対象パス: ...
- 依存関係:
  - #M2 は Blocked by #M1, #N（dependencies API 登録: ok / 失敗 → 手動登録コマンド）
  - (依存が無い場合は `- なし`)

## 依存グラフ
（Phase 7 の `dep_graph.py` の stdout を mermaid のコードフェンスにそのまま載せる。agent issue が 1 本で依存も無いときは節ごと省く）

## Launch Order
- 判定: `dev-flow-ready-set [--repo owner/repo] --with-in-flight <M1> <M2> ...`（ok / 失敗 → error と手動実行コマンド / Dry-run: 起票後に判定）
- 今すぐ別セッションで起動（issue ごとに 1 セッション。起動するのは人間が指示した issue・本数だけ）:
  - `/dev-flow <M1>` — #M1 タイトル — bg_command: `claude --bg "/dev-flow <M1>"`
- 後の波:
  - #M2 — blocked_by #M1 / path_conflict #M1 / path_conflict #N(変更対象パスなし) / no_declared_paths / human_task
- 実行中（他 issue の run。パスを占有）: #N — open_pr / local_branch / worktree（無い場合は `- なし`）
- 後の波は先行 issue / 実行中 run の merge（human issue は close）後に上の判定コマンドを再実行して決まる

## Plan Quality Gate
- 経路: 軽い / 重い（軽い経路から重い経路に切り替えた finding があれば、その finding と理由）
- Devil's-advocate review rounds: N（`issue-plan-reviewer` の判定ラウンド数。軽い経路は `1`、直した本文を再判定したら `2`）
- Blocking findings resolved: yes/no
- 1 本にまとめた finding: 「元の finding の見出し」, 「元の finding の見出し」 → #M1 タイトル (or Dry-run: A1)
  （無い場合は `- なし`）
- 起票しなかった issue: タイトル — 理由（blocking が残った項目の文と本文の引用 / reviewer を spawn できない / reviewer の返り値が判定の形でない）
  （無い場合は `- なし`）
- Remaining non-blocking concerns:
  - ...
```

## 依存グラフへの写し方

Phase 7 の `dep_graph.py` の stdout（`graph LR` から始まる Mermaid）を、手を加えずに ` ```mermaid ` フェンスに入れて
`## 依存グラフ` に載せる。図を書き足す・書き換えると、起票時の `--blocked-by` と図の食い違いを人間が見分けられない。

- agent issue が 1 本で依存も無いときは `## 依存グラフ` の節ごと省く
- `dep_graph.py` が非 0 で終わったら図を載せず、stderr のエラーを `## 依存グラフ` に書く
- `--dry-run` では仮番号（`H1`…・`A1`…）のノードになる

## Launch Order への写し方

Phase 7 の `dev-flow-ready-set` が返す stdout の 1 行 JSON を次のように `## Launch Order` へ写す:

- `launch[]` → 「今すぐ別セッションで起動」。各要素の `command`（`/dev-flow <N>`）と `bg_command`
  （`claude --bg "/dev-flow <N>"`。repo ルートで実行すると別セッションが立つ）を並べ、**issue ごとに別セッション**で
  流す旨を添える。起動するのは人間が指示した issue・本数だけ（起動手段と範囲は dev-flow SKILL.md「並列実行」節）
- `waiting[]` → 「後の波」。`reason`（`blocked_by` / `path_conflict` / `no_declared_paths` / `human_task`）と
  `detail`（相手の issue 番号）を併記する。`detail` の番号に `(変更対象パスなし)` が付いていれば、その実行中
  issue は申告が無いので全パスと重なる扱いになっている。相手の issue に `## 変更対象パス` を足せば再判定で解ける旨を添える
- `in_flight[]` → 「実行中」。他 issue で走っている run の番号と `reason` を並べる（これらのパスが占有されている）

`launch[]` は「今の波」だけを表す。後の波の中身は、先行 issue の merge（human issue は close）の後に
同じコマンドを再実行して決まる。その旨を `## Launch Order` の末尾に書く。
