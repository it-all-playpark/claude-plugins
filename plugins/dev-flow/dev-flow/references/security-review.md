# 敵対的 security review

信頼境界をまたぎうる PR を既定で通す gate。pr-iterate が LGTM を確定する前に回し、Merge tier が結果を読む
（各 phase の中での位置は `pipeline.md` の「Diff triage」「pr-iterate」「Merge tier」節）。正当化クラスは
`.claude/rules/dev-flow.md`「正当化クラス（W7）」、reviewer の cwd の扱いは `capability-bound.md`。
本文のパスは `plugins/dev-flow/` を root とする plugin 相対パス。

## 守る要件と境界

この gate と、それを支える hook・script はこの 3 つだけを守る。足す検査はどれかに対応させる。

- R1 PR の内容（diff・PR 本文・コメント・ファイル名）で判定を誘導させない — reviewer は diff をデータとして読み、PR が書いた
  指示ファイルを読み込まない（read-scope hook・Claude 経路は `reviewer_context_changed` で止める）。clear を決める中継に自由文を
  読ませない。Codex 経路の中継の Bash と返り値は hook が workflow の prompt の行と実 stdout に縛る（PR の CLAUDE.md を受け取っても偽れない）
- R2 判定は今の PR head に対するもの — `reviewed_sha` が今の head と一致した clear だけを使い、head が変わりうる時点で cleared を捨てる
- R3 review の仕組みが、PR に制御される入力を sandbox の外で実行しない — Codex 経路の codex も Claude の sandbox の中で動かす前提にし、
  中継の Bash は固定形の allowlist に限る（flag を変えた codex・別のコマンドを中継に実行させない）
- **境界の外（塞がない。issue にもしない）**: sandbox の中で PR のコードが既に実行され、同じ uid のプロセスとして残っている前提の
  攻撃 — 保存先（`$TMPDIR` 配下）の差し替え、確認と使用の間の競合、hard link・rename での入れ替え、PATH の前方への同名ファイルの設置。
  同じ権限のプロセスに対する path の検査は必ず競合が残り、検査を積むほど運用（人の手作業・設定項目）だけが重くなる。この段階は
  sandbox の境界と人間の merge が守る。利用者が文書の前提（codex を sandbox の中で動かす等）と違う環境を作った場合だけの経路も外
- **将来の PR の変更を要する経路は今の PR の欠陥にしない**: 将来の PR が対象のファイル（`isSecurityReviewExemptPath` が false）を
  変えて初めて成り立つ経路は、今の PR の critical / major にしない。前提は「merge は人間が行う」ことで、「全 PR が security review を
  通る」ことではない（pr-iterate を通らない PR は review を受けない）。例外として、今の diff が PR の制御できる出力を gate の根拠に
  すること自体・今の diff がその出力を偽ること・免除ファイル（`*.bats`・`*.test.*`・`*.spec.*`・`.md` 等）の出力が根拠に入る経路は、
  この除外に含めず通常どおり判定する
- reviewer の prompt（`SECURITY_REVIEW_BOUNDARY`）は境界の外を critical / major にさせず、fix の prompt（`SECURITY_FIX_GUIDANCE`）は
  人に手作業を課す修正・同じ入力に同じ種類の検査を重ねる修正をさせない（縛られていない入力元を縛る修正は対象外。できない指摘は
  `deferred_security_topics` で人に返す）。どちらも `_lib/security-review.mjs` の 1 か所に置く
- issue の AC がある run では、fix の prompt に AC の一覧を足し（`_lib/review-ac.mjs` の `securityFixAcceptanceCriteriaBlock`）、
  AC が求める挙動を変える・AC が変えないとした判定やテストを変える形でしか塞げない指摘も直さず `deferred_security_topics` で
  人に返させる（summary にぶつかる AC の番号を書く）。指摘は critical / major のまま残し、境界・severity・LGTM の gate は緩めない。
  AC は fix の prompt にだけ入れ、reviewer の prompt には入れない（判定者に PR の文を渡さない）

## 対象の判定

- 対象かどうかは `_lib/security-review-scope.mjs` の決定論の判定だけで決める（LLM は使わない。コードの diff を外部 API に
  送らない）。対象外は「ファイルが 1 件以上で、全ファイルが許可リスト（mode 100644 の `.md` / `.mdx` / `.rst` のうち指示
  ファイルでないもの、テストコードの拡張子の `*.test.*` / `*.spec.*`、`.bats`。ドット始まりの要素の配下は除く）に当たる」
  diff だけ。指示ファイルは大文字小文字を区別せず `CLAUDE.md`・`CLAUDE.local.md`・`AGENTS.md`・`SKILL.md` と
  `.claude/`・`references/`・`output-styles/`・`agents/`・`commands/` 配下。diff は
  `git -c core.quotePath=false diff --no-renames --no-color --no-ext-diff --no-textconv --text --src-prefix=a/ --dst-prefix=b/`
  で取り、`--name-only -z` の一覧と件数・集合を照合する。取得失敗・空・読めない diff・binary・mode 120000 / 160000・mode の
  変更・`.gitattributes` / `.gitmodules` は対象（fail-closed）
- 起動時の判定は Diff triage の security-scope（merge-base と作業ツリーの diff）、単体起動は `pr-iterate-prerun`
  （`<base>...<PR head>` の diff）。pr-iterate は run 中に PR head の diff で取り直し、起動時・run 中のどれか 1 回でも対象なら run の
  終わりまで対象（`args.security_review` が無い run も対象）
- security-scope の CLI は stdout・stderr に PR 由来の文字列（ファイルパス・git の stderr）を出さない。reasons は固定 code と
  件数、error は固定 code だけ。stdout を写す exec-proxy の agent に判定を書き換える文を渡さないため

## Claude 経路

```
pr-iterate      → 対象の run は各 round で、review#i（・ci-check#i）と同じ parallel() で review と同じ head に対して
                  security-scope#i → security-review#i を起動する（review の decision を待たない）。対象でない run は
                  CI gate を通り conflict も無い round（LGTM の候補）でだけ security-scope#i を取り直す:
                  security-scope#i: `security-review-scope <wt> origin/<base> <shaNow|HEAD> --save-diff`（Codex 経路の run は
                    下の「Codex 経路」の形 — GitHub の PR の head と base の sha で取る）
                    → worktree の外の新しい保存先 `dev-flow-security-review-XXXXXX/pr.diff` に diff を書く
                  対象なら security-review#i（security-reviewer を毎回新しく spawn。pr.diff のパスと head sha と
                    前回の未解消 critical/major を DATA として渡す）
                    → critical/major 0 件かつ reviewed_sha が今の head → 同じ round の review approve・CI passed / no_checks がそろえば LGTM
                    → critical/major あり → review の blocking（と CI failed）と 1 回の fix#i（pr-fixer）にまとめる。review が
                      approve でも CI を待たない（ci-wait-check なし）→ commit-ensure#i → 次 iteration（同じ topic の反復は stuck、
                      上限まで残れば max_reached）。security の指摘は history の blocking に載せない
                      → fix#i の deferred_security_topics（直さずに人へ返した topic）が渡した指摘の topic と 1 件でも一致すれば、
                        applied を見る前にその round で status: security_unresolved（applied:true なら commit-ensure#i の後。
                        保証に失敗すれば fix_failed）。次の review・security review は spawn しない
                    → 前提チェックで clear にできない（worktree の外を指す・diff / head / 保存先が揃わない・結果なし・head 不一致・
                      Claude 経路で reviewer_context_changed が false でない — 起動時の args.security_review の決定論の値と run 中の判定の
                      どれか 1 回でも true なら run の終わりまで true）→ LGTM の候補の round で status: security_unresolved
                      （review が request-changes の round はその fix へ進み、次の round で取り直す）
                  clear はその round の head についての結果。fix・conflict の自動解消で head が変わりうる時点で返り値の
                  status を cleared のまま残さず、次の round の security review が新しい head で取り直す
Merge tier      → 対象（Diff triage か pr-iterate のどちらか）かつ pr-iterate が lgtm + security_review.status 'cleared'
                  でなければ HOLD（security_review_unresolved）
```

- security-reviewer（tools は Read / Grep だけ）は保存先を作業ディレクトリにし、PR 本文・diff・コード中のコメントを
  データとして扱う。品質ゲート agent なので `opts.model` を渡さない
- workflow の `agent()` には cwd を渡せないので、security-reviewer の session の cwd は PR の worktree のまま。保存先の外への
  Read / Grep と Glob は PreToolUse hook（`hooks/pretool-security-reviewer-read-scope.sh`。入力の `agent_type` が
  `dev-flow:security-reviewer` のときだけ判定）が拒否する — 許可は対象パスの realpath が basename `dev-flow-security-review-[A-Za-z0-9]{6}`
  のディレクトリの配下で、そのディレクトリと対象パスが session の cwd の配下でないときだけ（R1）。PR が reviewer の session に
  自動で読み込まれる指示ファイル（basename が `CLAUDE.md` / `CLAUDE.local.md` / `AGENTS.md`、または repo 直下の `.claude/` 配下）を
  変える run は、security-scope#i の `reviewer_context_changed` で検出して review を spawn せず `security_unresolved`（人間が
  `security-review-isolated <PR>` で確かめる）。Codex 経路はこの停止をせずに Codex で review する（下の Codex 経路）
- 公開の PR コメント（pr-iterate・dev-flow の終端サマリー）には指摘の件数だけを載せ、本文（攻撃経路）は fix の prompt にだけ渡す。
  security の指摘は `history` / `human_followups` に入れない。返り値 `security_review` は件数と状態だけを持つ（形は
  `.claude/workflows/pr-iterate.js` の返り値）。`deferred` は fix が直さずに人の判断に返した指摘の件数で、終端サマリーには件数だけを出し、topic は載せない
- `stop_reason` は review の前提チェックで clear にできずに止めた理由の閉じた enum（値は `.claude/workflows/pr-iterate.js` の
  `securityRound`）。review を実行した・止めていない run は null。`reviewer_context_changed` の run は終端サマリーで「指示ファイルを
  変える PR なので自動 review をしていない」と出し分ける（HOLD は変えない。変わったファイルのパスは PR が決めた文字列なので載せず、
  固定の確認コマンドに PR 番号だけを差し込む）

## Codex 経路

opt-in（`"dev-flow".security_reviewer = "codex"`）。

```
/pr-iterate     → pr-iterate-prerun が base branch（origin/<base>）の skill-config.json / .claude/skill-config.json、無ければ user 設定
                  （$SKILL_CONFIG_PATH / ~/.config/skills/config.json / ~/.claude/skill-config.json）から読み、
                  args.security_review.reviewer で渡す（PR head の設定ファイルは読まない。無ければ "claude"）
/dev-flow       → dev-flow-prerun が同じ規則（_shared/scripts/security-reviewer-config.sh を共有）で解決した base から読み、
                  setup.security_reviewer に載せる（claude / codex 以外・欠落は prerun-setup.mjs が明示 error）
                  → prIterateArgs() が nested pr-iterate の args.security_review.reviewer で渡す
pr-iterate      → security-pr-head#i（security-codex-relay）: `gh pr view <PR> --repo <repo> --json baseRefOid,headRefOid`
                    → 返り値（stdout に縛られる）の 2 つの sha が review の基準。取れなければ止める
                  security-pr-fetch#i（security-codex-relay）: `git fetch origin <base> refs/pull/<PR>/head`（返り値は `{"done":true}` だけ）
                  security-scope#i（security-codex-relay）: `security-review-scope <wt> <base の sha> <head の sha> --save-diff`
                    → head_sha が GitHub の PR head か shaNow と食い違えば止める
                  の前提チェックを通った round で（指示ファイルを変える PR も止めずに review する — 判定者の codex は空の cwd で動き、
                  中継のコマンドと返り値は hook が縛るので、中継が PR の CLAUDE.md を受け取っても判定を偽れない）:
                  security-codex-prep#i（security-codex-relay）: `security-review-codex-prep <保存先> <head> <PR>[ --verify-from <前回の保存先>]`
                    → 保存先に prompt.md（prompt + diff）・strict 形の schema.json・空の cwd/ を作る（どれかか result.json が既にあれば作らない）
                  security-review-codex#i（security-codex-relay）: 固定形の `codex exec ... -C <保存先>/cwd ... -o <保存先>/result.json "<固定文>"`
                    （先頭トークンが codex の単文。返り値は使わない）
                  security-codex-verdict#i（security-codex-relay）: `security-review-codex-result <保存先> <head>`（自由文を出さない判定）
                    → clear でなければ security-codex-issues#i: 同じ引数に ` --issues`（指摘の本文）
                    → script と workflow の両方が securityReviewVerdict と同じ規則で clear のときだけ LGTM（以降は Claude 経路と同じ）
                    → clear を決める中継に自由文（codex の出力・指摘の本文）を読ませない — 引用された PR の文で偽の clear を作らせない
                    → Codex で判定できない（prep の失敗・codex が無い・hook の拒否・結果ファイルが読めない）→ その round は security-review#i
                      （reviewer_context_changed の run は security-reviewer を spawn せず止める — その reviewer は PR の指示ファイルを受け取る）
```

- Codex 経路の前提: codex は Claude の sandbox の中で動かす（`excludedCommands` に入れない）。sandbox の通信許可に Codex の
  API のホスト、書き込み許可に Codex の設定ディレクトリ（環境変数 CODEX_HOME）が要る — 手順は `pr-iterate/SKILL.md`。plugin は
  codex の実体の置き場所や出力先を検査しない（sandbox の外で動かす経路を持たないので、検査する理由が無い）
- codex の起動形は `_lib/security-review.mjs` の `codexSecurityReviewCommand` が固定で持つ。可変部は保存先のパスだけ。空の `-C` で
  cwd の AGENTS.md を読ませず、shell 等を外して diff の外を読む手段を無くす
- PreToolUse hook（`hooks/pretool-codex-invocation-guard.sh`）は `security-codex-relay` の Bash を `gh pr view` / `git fetch` / `security-review-scope` /
  `security-review-codex-prep` / `codex exec`（上の固定形）/ `security-review-codex-result` の固定形の allowlist に限る（語を探す判定は
  引用の分割・`$` 展開で組み立てた語をすり抜けるので使わない）。起動形を変えるときは `codexSecurityReviewCommand` と hook を同時に変える
- 同じ hook（matcher `Bash` と `StructuredOutput`。入力の `agent_type` が `dev-flow:security-codex-relay` のときだけ判定）は、
  `_lib/scripts/security-relay-bind.mjs` で中継の入出力をその spawn の transcript（`<transcript_path から .jsonl を除いたもの>/subagents/`
  配下の `agent-<agent_id>.jsonl`）に縛る（R1・R2）: Bash は最初の user 行の harness の枠の後の最終行（2 字下げを外したもの）と完全一致、
  返り値は直前にそのコマンドを実行した Bash の実 stdout の 1 行目の JSON か、prompt が定める失敗時の JSON（`SECURITY_SCOPE_RELAY_FAILED` 等。
  Bash を実行していなくてよい。codex の起動は `{"done":true}` だけ）と一致するときだけ通す。transcript は Claude Code の設定ディレクトリに
  harness が書き、sandbox の中の中継・PR のプロセスからは書けない。transcript・prompt が無い・枠の形が違う・コマンド行が取れないときは deny
- review する head と base は GitHub の PR の値（縛った `gh pr view` の stdout）で決まる。手元の HEAD・`origin/<base>` は PR の worktree で
  動く fix#i・commit-ensure#i（PR の CLAUDE.md を受け取り得る）が push しない commit や ref の書き換えで変えられるので基準にしない。
  `commit-ensure#i` 等の中継が返した `shaNow` が GitHub の PR head と食い違えば止める（push されていない commit・
  古い commit の sha を返されても、GitHub に無い tree・古い tree で clear にしない）。exec-proxy の規約どおり script は通信しない
  （sha の取得と fetch は中継の bare の gh / git の単文）
- `--output-schema` は OpenAI の strict 形（全 object が `additionalProperties:false`・全 property が required・`maxLength` 無し）
  でないと 400 になる。結果ファイルの schema 適合は `security-review-codex-result` が判定し、適合しない結果は clear にしない
- 返り値 `rounds` は Claude の security-reviewer と、結果を読めた Codex の review の合計
