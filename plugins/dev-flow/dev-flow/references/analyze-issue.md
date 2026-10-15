# analyze-issue（issue の取得と決定論 parse）

`analyze-issue`（`bin/analyze-issue` → `dev-flow/scripts/analyze-issue.sh`）は GitHub issue を取得し、
分析 JSON を stdout に出す exec-proxy。issue の取得（`gh issue view <n> [--repo R] --json ...`）は
script の中で行う — 呼び出し側は issue を先に取得せず、コマンドに redirect / pipe / `cd`・`bash`・env
前置 / `&&` 連結を付けない。

呼び出し元は 2 つ:

- prerun（`prerun-analyze.sh`）が `--contract` で呼ぶ。dev-flow の通常経路の issue 分析はこれだけ
- analyze ゲートが引いたときの `analyze-clarify#<issue>`（dev-runner）が
  `analyze-issue <n> [--repo R] --depth comprehensive --dump-body <path>` で issue を読み、質問文を起こす

```bash
analyze-issue <issue-number> [--repo <owner/repo>] [--depth minimal|standard|comprehensive | --contract] [--dump-body <file>]
```

| Option | Default | Description |
|--------|---------|-------------|
| `--repo` | (cwd の repo) | `gh issue view --repo` へそのまま渡す `owner/repo`。dev-flow は `REPO` を渡して cwd 非依存にする |
| `--depth` | `standard` | 出力の深さ（下表） |
| `--contract` | off | T1/T2 契約の決定論 parse（下記）。`--depth` より優先 |
| `--dump-body` | (none) | 切断時のみ body 全文を書き出すファイルパス（standard / comprehensive のみ有効） |

`--depth standard|comprehensive` で呼ぶときは `--dump-body <path>` を付ける。`scope_truncated` /
`body_preview_truncated` / `issue_body_truncated` のいずれかが true のときだけ body 全文を `<path>` へ書き、
実際に書いた絶対パスを `body_dump_path` に返す（切断なしなら `null`、ファイルは作らない）。
`body_dump_path` が null でなければそのファイルを Read してから要件を読む — issue の再取得はしない。

## depth ごとの出力

| Level | Output |
|-------|--------|
| `minimal` | `issue_number`, `title`, `type`, `state`, `labels`, `milestone`, `breaking_keyword_scan`, `comment_count`, `issue_author` |
| `standard` | minimal + `acceptance_criteria`, `requirements`, `comments`, `ac_heading_near_miss`, `warnings`, `body_preview`, `body_preview_truncated`, `body_total_chars`, `scope`, `scope_truncated`, `scope_total_chars`, `issue_body`, `issue_body_truncated`, `body_dump_path` |
| `comprehensive` | standard の `body_preview` を `body_full`（body 全文）に置き換え、`affected_files`, `components` を足す |

- `type`: label から決める（`bug` → `fix` / `enhancement`・`feature` → `feat` / `refactor` → `refactor` /
  `doc` → `docs` / 既定 `feat`）
- `acceptance_criteria`: body の checkbox（`- [ ]` / `- [x]`）と番号付き項目、最大 20 件
- `comments`: `[{author, author_association, created_at, body}]`、先頭 50 件。0 件でも `[]`
- `warnings`: AC 0 件・切断・AC 見出しの near-miss を列挙する（AC 0 件を空配列のまま黙らせない）
- `affected_files` / `components`: body からの正規表現抽出、各最大 10 件

`breaking_keyword_scan` は全 depth と contract に出る決定論 keyword scan
（`breaking|incompatible|migration|破壊的|非互換`、title + body 全文、大文字小文字無視）。dev-flow の
shape floor / merge tier HOLD の breaking 判定入力の一つ（`req.breaking_change` との OR）。

## Contract mode（`--contract`）

T1/T2 契約準拠 issue の決定論 parse。T1 = AC 見出し（`## 受け入れ基準` / `受け入れ条件` / `受入基準` /
`受入条件` / `Acceptance Criteria` / `完了条件`、h2〜h6）+ checkbox 項目 1 件以上。T2 = 同見出し + 素の
箇条書き（`- ` / `* ` / 番号付き）1 件以上。h1 は `ac-lint.sh` の HEADING_RE が h2〜h6 のみを受理するため
AC 見出しとして扱わない（許容表記は `ac-lint.sh` と一致させる）。一致しない AC 風見出しは
`ac_heading_near_miss` に載り、`acceptance_criteria` は空のまま analyze ゲート（AC 空）が
needs_clarification に倒す。

| Key | Description |
|-----|-------------|
| `contract` | `t1` / `t2` / `none` |
| `eligible` | boolean |
| `ineligible_reason` | 不合格理由（`eligible: false` のときだけ） |
| `issue_number` | issue 番号 |
| `title` | issue title |
| `issue_type` | `feat`/`fix`/`docs`/`refactor`/`chore`/`test`/`perf`/`ci`（title の conventional prefix → label の `type`） |
| `acceptance_criteria` | AC 節の項目（marker 除去済み、最大 20 件） |
| `scope` | AC 節を除く body の先頭 4000 字（切断マーカーは下記） |
| `scope_truncated` | boolean、常時出力。`scope` が切断されたか |
| `scope_total_chars` | 整数、常時出力。AC 節を除く body の総文字数（切断前） |
| `issue_body` | AC 節を含む body の先頭 4000 字。dev-flow の Implement が dev-implementer へ issue 本文として渡す |
| `issue_body_truncated` | boolean、常時出力。`issue_body` が切断されたか |
| `breaking_keyword_scan` | 決定論 keyword scan の結果 |
| `title_breaking_marker` | boolean、常時出力。title の conventional prefix に `!`（`feat!:` 等）があるか |
| `comment_count` | issue comments 件数 |
| `issue_author` | issue 報告者の login（不明は `""`） |
| `issue_updated_at` | issue の `updatedAt`（prerun が最新 comment との前後関係を Jev に渡す） |
| `comments` | `[{author, author_association, created_at, body}]`（先頭 50 件、0 件でも `[]`） |
| `ac_heading_near_miss` | 許容表記に一致しない AC 風見出し行（0 件でも `[]`） |

**Eligibility**: `contract` ∈ `{t1, t2}` かつ `comment_count === 0` かつ `scope_truncated === false` かつ
`issue_type` ∈ `{feat, fix, docs, refactor, chore, test, perf, ci}` かつ title に `!` なし かつ
`breaking_keyword_scan === false`。`ineligible_reason` は最初に不合格になった 1 理由だけを載せる要約で、
不合格でも exit 0。prerun（`prerun-analyze.sh`）は `eligible` ではなく生シグナル（`acceptance_criteria` /
`breaking_keyword_scan` / `title_breaking_marker` / `comment_count` / `comments` / `issue_author`）を読み、
決定論で解けない 3 理由（breaking keyword hit / comments present / 観測型 AC の正規表現の絞り込み hit）だけを
Jev の有界判定に回す。

残余リスク: breaking keyword を含まない実質 breaking の issue は Jev にも回らず、realized diff の
danger-grep と merge tier が補償する（意図的な設計判断）。

## comment の override 判定に使う `author_association` / `issue_author`

`author_association` は `gh` の `authorAssociation`（`OWNER`/`MEMBER`/`COLLABORATOR`/`NONE` 等）を verbatim
転写する。`issue_author` は issue 報告者の login（`author.login`）。prerun はこの 2 つで comment を
`comment_overrides` に採るかを決める（issue 報告者本人 または OWNER/MEMBER/COLLABORATOR に限る。判定は
決定論、comment の意味分類は Jev の `{override, conflict, unrelated}`）。override だが権限なし / conflict /
低確信の comment は `comment_conflicts` に入り、dev-flow はそれが非空なら needs_clarification で終端する。

これは fail-closed の一部: public repo では誰でも comment を書けるので、権限で絞らないと任意の外部
comment が issue body から抽出した要件を黙って上書きできる。`author` / `author_association` /
`issue_author` は取得できない場合も `null` ではなく `""` を返す。空文字列は「不明」であって一致ではない
ため、override 採用の判定材料にならない。

`comments` キーが無い / 配列でない取得結果は「comment 0 件」と同一視せず `die_json` で落とす — 取得の
欠落を comment 無しとして通すと、comment による訂正の読み落としが黙って起きる。

## 4000 字切断とマーカー

`scope` / `issue_body` の 4000 字、`body_preview` の 500 字は context 予算の上限で、値自体は変えない。
切断は黙って行わない: 切断時は本文末尾に次のマーカーを付ける。

```
[TRUNCATED: <field> shows the first <N> of <total> chars...; the remainder was NOT included. Do not treat anything absent from this excerpt as unspecified — read the full body from the body_dump_path file (--dump-body) before raising ambiguities]
```

加えて `scope_truncated` / `body_preview_truncated` / `issue_body_truncated` と `scope_total_chars` /
`body_total_chars` を常時出力する — マーカー文字列を見ない下流（boolean だけを見る決定論ゲート）にも
切断の事実が届く。切断が黙っていると、issue 末尾に書かれた確定仕様が抜粋の外へ落ち、それを読めない
analyze が needs_clarification を返し続ける。人間が回答を追記するほど末尾に押し出されて悪化する。
