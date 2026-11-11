# 基準画像の撮影（visual_snapshots）

画面を持つ repo が `"dev-flow".visual_snapshots` を宣言すると、dev-flow は Evaluate の各評価の前に基準画像を撮り直し、変わった PNG を
PR に入れる。人は PR の Files changed の画像差分（2-up / Swipe / Onion skin）で画面の変化を見比べる。宣言の無い repo では何もしない。
phase 全体の地図は `pipeline.md`、不変条件は `.claude/rules/dev-flow.md`。本文のパスは `plugins/dev-flow/` 相対。

## 宣言

```json
{"dev-flow": {"visual_snapshots": {"command": "pnpm test:visual:update", "db": {"engine": "postgres", "version": "17"},
  "env": "E2E_EXTERNAL_DATABASE_URL", "timeout_seconds": 900, "paths": ["apps/*/e2e/__screenshots__"]}}}
```

- `command`・`db`・`env`・`timeout_seconds` は `local_verify` と同じ意味。`command` は撮影して、許容幅を超えて変わった基準画像の PNG だけを
  書き換える。何を撮り、どう比べるか（画面・シナリオ・許容幅）は repo の側が持ち、dev-flow は対象 repo の画面や撮影手順を知らない
- `paths` は基準画像のディレクトリ（repo 相対の glob の配列）。その下の PNG は git の pathspec `:(glob)<path>/**/*.png` で決める
- 読み先はほかのキーと同じ（user 設定の repo 別の節 → `origin/<base>` の skill-config → user 設定。`_shared/scripts/devflow-config.sh`）。
  worktree（PR head）の設定ファイルは読まない — 実装が書き換えた宣言で、撮影コマンドと「変えてよい場所」を PR が選べないように
- 検証は `devflow_visual_snapshots_of`。不正な宣言（`paths` が空・`/` 始まり・`..` を含む等）は `dev-flow-prerun` が worktree を作らずに
  `ok:false` で止める（黙って未設定にすると、撮影されないまま画面の変わる PR が出続ける）

## 判定

- **Diff triage**: shape の判定に数える変わったファイルから、`paths` の下の PNG を外す（`withoutVisualSnapshotPngs`）。`paths` の下でも PNG で
  ないファイルは数える。基準画像は撮影コマンドの生成物で、枚数で shape を上げない
- **Evaluate**: 各評価（eval#N）の前に worktree の tree を取り、最後に撮影した tree と違えば、宣言コマンドを `local-verify`（`paths` のある
  宣言。sandbox 内・切り離した実行・使い捨て DB・上限時間）で head の worktree に対して実行する（`captureVisualSnapshots`）。
  評価の前に撮るので、変わった PNG は評価される tree に入り、PR 直前の diff hash の照合（`hash_mismatch`）はそのまま成り立つ。
  tree が変わらない評価（差し戻しが何も変えなかった）と、失敗した撮影と同じ tree では撮り直さない。base の tree は撮らない
- **撮影が残してよい変化は `paths` の下の PNG だけ**: `local-verify` が command の前後で worktree 全体の tree を比べ、それ以外の変化
  （追跡ファイルの変更・削除、新しいファイル、`paths` の下の PNG でないファイル）があれば、その撮影の結果を PNG ごとすべて捨てて
  worktree を command の前に戻す（実 index は書かない）。command は PR のコードなので、PNG 以外に書いたものを評価される tree と PR に入れない
- **PR 本文**: 評価の後に、PR の差分（`origin/<base>` と評価した tree の間）で `paths` の下で変わった PNG の一覧を取り
  （`reportVisualSnapshots`）、「画面の変化」にパスを並べる（`visualSnapshotsSection`）。変わった PNG も理由も無ければ節を出さない。
  pr-iterate の fix の後は撮り直さず、PR 本文を作り直すときも PR 作成時の一覧を載せる

## 失敗の扱い

- 撮影の失敗（exit 非 0・上限時間の超過・DB を確保できない・proxy の応答が無い・例外・`paths` の下の PNG 以外の変化）は fail-open:
  その撮影の PNG を入れず、評価と PR を続け、理由を「画面の変化」に 1 行出す。`paths` の下の PNG 以外の変化は変わったパスを添える
- 撮影の成否は ledger・差し戻し・merge tier・HOLD 理由に使わない。撮影コマンドは PR のコードを実行するので、結果で gate を動かすと
  PR の内容で判定を誘導できる。確かめるのは人間（Files changed の画像差分）
- 捨てた撮影の後始末は `local-verify` の supervisor が行う（stop・TERM でも走る）。戻し切れなかったとき・終了後の tree が撮影前と違うときは、
  その旨を理由に足す（残った変更は評価される diff と PR に見える）
- 変わった PNG の一覧が取れなければ、その旨を「画面の変化」に出す

## コード

- 宣言: `devflow_visual_snapshots`（`_shared/scripts/devflow-config.sh`）、`dev-flow/scripts/prerun.sh`、`normalizeVisualSnapshots`（`_lib/prerun-setup.mjs`）
- 撮影: `captureVisualSnapshots`・`reportVisualSnapshots`（`.claude/workflows/dev-flow-evaluate.js`）、`_lib/visual-snapshots.mjs`、
  `_shared/scripts/local-verify.sh`（`paths` のある宣言）
- shape: `withoutVisualSnapshotPngs`（`_lib/diff-triage.mjs`）
- PR 本文: `buildPrBody`（`_lib/pr-artifacts.mjs`）
- label: `diff-hash-snapshot#<i>`・`visual-snapshots-start#<n>`・`visual-snapshots-wait#<n>.<k>`・`visual-snapshots-stop#<n>`・
  `diff-hash-snapshot-after#<i>`・`visual-snapshots-list`
