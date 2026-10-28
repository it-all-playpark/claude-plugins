---
name: git-issue
description: |
  Creates GitHub issues of any size: concrete findings (bug, audit result, review comment with known symptom, cause and fix)
  go through a light path; plans from discussion go through multi-role investigation and adversarial review.
  Both paths pass ac-lint, create_issue.py and dev-flow-ready-set.
  Use when: (1) user asks to create an issue in any wording — "issue にして", "issue 化", "起票", "issue 立てて",
  "create an issue", "file an issue". issue を作る依頼は規模を問わずこの skill で行う（素の gh issue create を使わない）,
  (2) bugs / audit results / review findings should be filed as one or several issues,
  (3) user finished ideation in skills like plan-brainstorm/plan-workflow and now wants a concrete implementation issue,
  (4) user asks to turn discussion notes into an issue with frontend/backend/infra viewpoints,
  (5) user wants a devil's-advocate pass before posting issue.
  Accepts args: [discussion-source] [--repo owner/repo] [--title "TITLE"] [--labels a,b] [--assignees a,b] [--milestone name] [--max-review-rounds N] [--lang ja|en] [--dry-run]
allowed-tools:
  - Bash
model: opus
effort: xhigh
---

# GitHub Issue Orchestrator

## Overview

issue を作る依頼は規模を問わずこの skill で受ける。症状・原因・直し方の分かった小さな起票は軽い経路で、
議論から起こす計画は重い経路（Phase 1〜7）で起票する（経路の選択）。どちらも Phase 5〜7 を通る。
agent の作業は dev-flow 1 run（= 1 PR）に収まる単位の issue に分け、変更対象パスと issue 間の
`Blocked by` 依存を持たせる。

## Arguments

| Arg | Description |
|-----|-------------|
| `discussion-source` | Optional path to notes/markdown exported from brainstorming |
| `--repo` | Target repository (`owner/repo`); omit to use current repo |
| `--title` | Explicit issue title |
| `--labels` | Comma-separated labels |
| `--assignees` | Comma-separated GitHub usernames |
| `--milestone` | Milestone name |
| `--max-review-rounds` | Max devil's-advocate loops (default: `3`) |
| `--lang` | タイトル・本文・サマリーの言語（default: `ja`）。英語ラベル名・技術用語はそのまま |
| `--dry-run` | Build issue body only, do not create issue |

## Preconditions

1. Ensure discussion context exists in the conversation or as a file.
2. Ensure `gh` CLI is installed and authenticated for non-dry-run execution.
3. If key constraints are missing (deadline, non-goals, ownership), ask focused follow-up questions before planning.

## 経路の選択

起票の依頼を受けたら、入力を見て軽い経路か重い経路かを先に決める。

**軽い経路**（下の「軽い経路（Light Path）」）は、次をすべて満たすときに選ぶ:

1. 入力が症状・原因・直し方の分かった具体的な finding（bug・監査結果・レビュー指摘など）である
2. 1 finding = 1 agent issue で収まる（分割が要らない）
3. human タスクを含まない（Executor Classification で `executor: human` になる作業が無い）
4. issue 間の依存が無い（`Blocked by` が要らない）

**重い経路**（Phase 1〜7）は、それ以外のすべてで選ぶ: 議論から起こす新機能・設計判断が要る計画・
分割や依存が要るもの・human タスクを含むもの。

## Workflow

重い経路は次の Phase 1〜7 を順に行う。軽い経路は Phase 2〜4 を「軽い経路（Light Path）」の手順に置き換え、
Phase 5〜7 は同じように通る。

| Phase | Action | Complete When |
|-------|--------|---------------|
| 1 | Normalize input context | Problem statement, goals, constraints are explicit |
| 2 | Specialist investigation | Frontend/backend/infra findings are ready to feed AC and constraints |
| 3 | Draft implementation plan | Plan includes phases, executors, agent issue split, target paths, dependencies, AC, risks |
| 4 | Devil's-advocate review loop | No blocking gaps remain |
| 5 | Compose final issue body | Template is fully filled for every agent issue (human issue bodies too, if any) |
| 6 | Create issue | human issues (if any) → agent issues in topological order (`--blocked-by`) return URLs |
| 7 | Launch order | `dev-flow-ready-set` over the created agent issues fills `## Launch Order` (skipped on `--dry-run`) |

### Phase 1: Normalize Input

Summarize discussion into:
- objective
- target user/system
- in-scope / out-of-scope
- explicit constraints
- unknowns and assumptions

If input is ambiguous, resolve ambiguity before continuing.

### Phase 2: Specialist Investigation

Analyze from these lenses:
1. `frontend` - UX impact, component boundaries, state/data flow, accessibility, client test strategy.
2. `backend` - API contract, data model changes, migration impact, auth/security, server test strategy.
3. `infra` - deployment/runtime impact, observability, rollback path, cost/reliability, operational risks.

If a lens is not relevant, record `Not applicable` with reason.

If subagents are available, run analyses in parallel; otherwise run the same lenses sequentially.

### Phase 3: Draft Implementation Plan

Generate an actionable plan containing:
- phased tasks with ownership (`frontend` / `backend` / `infra`)
- executor per task (`executor: agent | human`) — required on every task (see below)
- agent issue split (see Issue Splitting) and `## 変更対象パス` per agent issue
- dependency order (between agent issues, and on human issues)
- acceptance criteria (testable)
- risk register
- rollout and rollback strategy
- open questions requiring user decision

この計画は issue の分割・AC・制約を決めるための作業メモ（本文に書くものは Phase 5）。

#### Executor Classification

Every task gets exactly one executor line: `executor: agent` or `executor: human`.
The human marker is the fixed string `executor: human` (same string as `references/issue-template.md`);
`create_issue.py` rejects any agent issue body that still contains it, so do not paraphrase it.

A task is `executor: human` when it needs any of the following (human 判定基準):

1. 外部サービスの管理画面操作・アカウント作成
2. secret・API キーの発行と登録
3. DNS・課金・契約
4. 顧客への確認・承認
5. 本番データの手作業操作
6. 実機での手動確認

Anything outside this list is `executor: agent` (default). Do not mark work human just because it is
tedious — over-splitting adds human toil. Human tasks are cut out of the implementation issue in
Phase 6 and filed as separate `human-task` issues; the implementation issue keeps only agent tasks and
references the human issue via `Blocked by`.

#### Issue Splitting

agent issue 1 本 = dev-flow 1 run = 1 PR。dev-flow は 1 issue を implementer 1 spawn で 1 PR に仕上げるので、
大きい計画を 1 本に詰めると走りきれないかレビュー不能な PR になる。agent タスクは次のいずれかに当たるとき
別の agent issue に分ける（分割基準）:

1. 単独で merge しても main のテストが green のまま価値を持つ成果物が 2 つ以上ある
2. AC の中に、別の成果物のコードが無いと検証できない組がある（先行成果物を別 issue にし Blocked by で繋ぐ）
3. 変更対象パスが互いに独立した 2 群に分かれ、どちらか片方だけで価値がある

分けない: 片方だけではテストが書けない・main を壊す（例: 呼び出し側の無い内部 API だけ）分割。
分けすぎは人手 merge 回数を増やす。

分けた agent issue はそれぞれ AC・制約・`## 変更対象パス` を持つ完結した issue にし、どの issue の成果物を
使うか（依存）を記録する。依存は循環させない（Phase 6 でトポロジカル順に起票する）。

#### 変更対象パス

agent issue の本文には `## 変更対象パス` が必須。書式は 1 行 1 エントリ `- <repo 相対パスまたは glob>`:

```markdown
## 変更対象パス
- <repo 相対パスまたは glob>
```

計画時点の見積もりでよい。後続の並列起動判定はこの欄を「触る範囲の申告」として保守的に扱う
（起票時に拒否される書き方は Phase 6）。

### Phase 4: Devil's-Advocate Review Loop

Apply the checklist in `references/devils-advocate-checklist.md`.

Loop rules:
1. Run devil's-advocate review on current plan.
2. Classify findings as `blocking` or `non-blocking`.
3. Revise the plan to resolve all blocking findings.
4. Repeat until no blocking findings or max rounds reached.

Do not create a GitHub issue while blocking findings remain.

ラウンド数と残った non-blocking の懸念は Output Contract の `## Plan Quality Gate` でユーザーに返す。

### Phase 5: Compose Final Issue Body

issue 本文を一時ファイルに書く（例: `/tmp/git-issue-body.md`）。agent issue を分けた場合は 1 本ごとに
本文ファイルを分け（`/tmp/git-issue-body-1.md`, `-body-2.md` …）、以降の AC Lint Self-Check と Phase 6 の
起票は本文ファイルごとに行う。

本文に含めるもの（agent issue。構成は `references/issue-template.md`）:
- `## ゴール` — 何を満たせば完了か
- `## なぜ` — 短く（2〜4 行）
- `## 受け入れ基準（Acceptance Criteria）`
- `## 制約・取らないこと`
- `## 変更対象パス` (agent issue only)
- `## 未解決事項（Open Questions）`

Phase 2（調査）・Phase 4（devil's advocate）の結果は AC と制約に反映させるだけで本文に書き写さない。
実装計画・テスト戦略・リリース/ロールバックの節も書かない（implementer はコードを読んで自分で計画を立て、
経緯は判断材料にならない）。リスクやロールバックの要件は AC か `## 制約・取らないこと` の 1 行にする。
AC 節を除いた本文は 4000 字以内に収める（dev-flow の analyze は超えた部分を切り、implementer に届かない）。

#### AC Lint Self-Check

After the body file is written, run the shared AC contract lint against it:

```bash
ac-lint /tmp/git-issue-body.md
```

stdout は 1 行 JSON `{"ok":true,"verdict":"t1|t2|non_compliant",...}`、exit code は `0` = t1/t2、
`3` = non_compliant、`1` = usage/IO error。`verdict` ごとに:

| Verdict | Policy |
|---------|--------|
| `t1` | そのまま Phase 6 へ進む。 |
| `t2` | AC 節内の箇条書き（`- `/`* `/番号リスト）を `- [ ]` checkbox に書き換え、`ac-lint` を再実行して `t1` を確認してから Phase 6 へ進む。 |
| `non_compliant` | `references/ac-lint-recovery.md` の手順で直して `ac-lint` を再実行する。直せなければ issue を作らず abort し、返った JSON verdict をそのままユーザーへ報告する。 |

### Phase 6: Create Issue

`create_issue.py` は同じ `ac-lint` を決定論ゲートとして内蔵し、`non_compliant` なら（`--dry-run` を含め）
exit 1 で abort する（`t2` は警告付きで通過）。加えて `--kind` で本文を検査する（`--dry-run` を含む）:

- `--kind agent`（既定）: 本文に `executor: human` が 1 つでもあれば exit 1 で起票を拒否する。
  `## 変更対象パス` が無い・エントリ 0 件・エントリが `/` 始まり・`..` セグメントを含む場合も exit 1。
  AC 節を除いた本文（先頭に足す `Blocked by` 行を含む）が 4000 字を超える場合も、超過字数を出して exit 1
  （字数は dev-flow の `analyze-issue.sh` の `scope_total_chars` と同じ数え方）。Phase 5 に戻って要点を絞って書き直す。
  AC の人手判定も dev-flow と同じ `_lib/ac-actor.mjs` の判定で行う: AC 節の checkbox 行に、dev-flow が人手扱いにする
  AC（`（人手）`・staging / 本番環境・外部サービス・repo 外だけの作業）があれば、AC 番号と本文を出して exit 1。
  repo 内外の作業が混ざった AC も理由を出して exit 1（起票時に通った AC が dev-flow の実行時に人手扱いで止まらないため）。
  人の作業は `--kind human` で別 issue に切り出して先に起票し（下の起票順序 1）、
  この issue は `--blocked-by` で紐付ける。判定できない（判定 CLI の起動失敗・非 0 終了・出力不正）ときも起票せず exit 1
- `--kind human`: `## 手順` 見出しと checkbox（`- [ ]`）付きの `## 完了条件` が無ければ exit 1。
  `human-task` ラベルを付けて起票し、ラベルが無ければ作成する

起票順序:

1. **human タスクがある場合、human issue を先に起票する**。human タスクごとに
   `references/issue-template.md` の human issue テンプレートで本文を作り、`--kind human` で起票して
   issue 番号を控える（`--dry-run` なら起票予定として扱う）
2. **agent issue を依存のトポロジカル順に起票する**（先行 issue が先、それを使う issue が後）。各 agent issue は
   `--kind agent` で起票し、先行 issue（その issue が待つ human issue と、先に起票した agent issue）の番号を
   `--blocked-by <番号[,…]>` に渡して、起票した番号を控えて後続の `--blocked-by` に使う。本文から human タスクを
   除く（`executor: human` を残さない）。`--blocked-by` は本文先頭に `Blocked by #N` 行を保証し、起票後に
   GitHub の issue dependencies API で依存を登録する。登録に失敗すると非 0 終了し、issue URL と手動登録
   コマンドを stderr に出すので、それをユーザーに報告する（本文の `Blocked by` 行は残るので dev-flow のゲートは効く）
3. 依存が循環していたら起票せず Phase 3 に戻って分割をやり直す（トポロジカル順が存在しない）
4. human タスクが無く agent issue が 1 本なら、その 1 本だけを `--blocked-by` なしで起票する

dev-flow は open な blocker を持つ issue を実装前に停止する（needs_clarification、source: `blocked_by`）ので、
先行 issue（human issue は close、agent issue は PR を merge）が片付いてから後続 issue に `/dev-flow` を流す。

Run（human issue。human タスクの数だけ繰り返す）:

```bash
python3 ${CLAUDE_PLUGIN_ROOT}/git-issue/scripts/create_issue.py \
  --kind human \
  --title "$HUMAN_TITLE" \
  --body-file /tmp/git-issue-human-1.md \
  [--repo owner/repo] \
  [--assignees a,b] \
  [--dry-run]
```

Run（agent issue。トポロジカル順に agent issue の数だけ繰り返す）:

```bash
python3 ${CLAUDE_PLUGIN_ROOT}/git-issue/scripts/create_issue.py \
  --title "$TITLE" \
  --body-file /tmp/git-issue-body-1.md \
  [--blocked-by N[,M]] \
  [--repo owner/repo] \
  [--labels a,b] \
  [--assignees a,b] \
  [--milestone name] \
  [--dry-run]
```

`--dry-run` では issue 番号が確定しないので、agent issue の起票コマンドは `--blocked-by` を付けずに
組み立てる（`--kind agent` の本文検査は `--dry-run` でも走る）。起票予定の全 issue に仮番号（human issue は
`H1`…、agent issue はトポロジカル順に `A1`…）を振り、全 issue（human issue → agent issue）と依存グラフ
（`A2 は Blocked by A1, H1` の形）を Output Contract に並べて表示する。

### Phase 7: Launch Order

起票した agent issue のうち、今 `/dev-flow` を流してよく互いに変更対象パスが重ならないものを
`dev-flow-ready-set` で判定し、Output Contract の `## Launch Order` に並べる。判定は dev-flow の並列実行
（dev-flow SKILL.md「並列実行」節）と同じ基準で、渡した issue 同士のパス重なりと blocker に加え、
`--with-in-flight` で他 issue の実行中 run（head が `feature/issue-<N>` の open PR・local branch・
`df-<N>` worktree）を自動で拾い、その変更対象パスとの衝突も判定する。

Run（Phase 6 で起票した agent issue の番号を起票順に全部渡す。human issue は渡さない）:

```bash
dev-flow-ready-set [--repo owner/repo] --with-in-flight <M1> <M2> ...
```

- bare 名を先頭トークンにして実行する（`cd` / env 前置・パイプ・リダイレクトを付けない。plugin の `bin/` は
  PATH 上の bare 名で解決する）
- in_flight の判定はカレントの git repo の local branch / worktree を読むので、対象 repo の作業ツリーの中で
  実行する。カレントが対象 repo でなければ実行せず、上のコマンドを `## Launch Order` に載せて人間に渡す
- `--dry-run` では issue 番号が無いので実行しない（`## Launch Order` は `- Dry-run: 起票後に判定`）
- 出力が `{"ok":false,...}` なら起票は成功のまま扱い、`error` と上のコマンドを `## Launch Order` に載せる
  （失敗した判定を launch として見せない）

stdout の 1 行 JSON を `## Launch Order` へ写す規則は `references/output-contract.md`。

### 軽い経路（Light Path）

「経路の選択」で軽い経路を選んだ finding は、Phase 2 の 3 観点調査（frontend / backend / infra）と
Phase 4 の devil's-advocate ループを行わない。複数の finding を 1 回の呼び出しでまとめて起票できる。

1. finding ごとに対象コード（と既存テスト）を読み、症状・原因・直し方を確かめたうえで、AC・
   `## 制約・取らないこと`・`## 変更対象パス` を埋める。本文の構成は重い経路と同じ実装 issue テンプレート
   （`references/issue-template.md`）。続けて `## 変更対象パス` の各パスについて
   `gh issue list --state closed --search "\"<path>\" in:body"` で close 済みの issue を引き（close 日と本文は
   `--json number,title,closedAt,body` を足して読む。`<path>` をコマンド文字列に書き込まない。パスは finding 由来で
   `$(…)` や引用符を含みうるので、文字列に置換するとシェルが評価する。パスは Write ツールで `/tmp/git-issue-path.txt` に書き、
   `--search "\"$(cat /tmp/git-issue-path.txt)\" in:body"` の形で 1 つの引数として渡す。置換の結果はシェルに再評価されない）、そのうち finding と同じ仕組み（同じ判定・同じ prompt の組み立て・
   同じガード）を直した issue が直近 30 日に 2 件以上あれば、その finding は重い経路に切り替える。パスが重なるだけでは
   切り替えない（よく触るファイルではほぼ全件の close 済み issue の本文に出るので、パスだけで数えると全 finding が重い経路になる）
2. 各本文を `references/devils-advocate-checklist.md` の Blocking Categories に 1 回だけ照らし、当たった項目を直す
   （ループはしない）。ただし「直し方が症状の条件の分岐・ガード・入力の追加だけ」の項目に当たった finding は、その場で
   直さずに重い経路に切り替える（他の Blocking 項目はこれまでどおりその場で直す）
3. Phase 5 と同じく finding ごとに本文ファイルを作り（`/tmp/git-issue-body-1.md`, `-body-2.md` …）、
   本文ファイルごとに AC Lint Self-Check（`ac-lint`）を通す
4. 本文ファイルごとに Phase 6 の `create_issue.py`（`--kind agent`、`--blocked-by` なし）で起票する。
   ゲート（ac-lint・4000 字・変更対象パス・`executor: human` の検出・AC の人手判定（dev-flow と同じ `ac-actor.mjs` の判定））は重い経路と同じ
5. Phase 7 は起票した全 issue の番号をまとめて `dev-flow-ready-set` に 1 回だけ渡す（finding ごとに実行しない）

途中で分割・issue 間の依存・human タスクが必要と分かったら、手順 1 で同じ仕組みを直した close 済みの issue が
直近 30 日に 2 件以上見つかったら、または手順 2 で「直し方が症状の条件の分岐・ガード・入力の追加だけ」の項目に
当たったら、その finding は軽い経路をやめて重い経路（Phase 1 から）に切り替える。切り替えた finding は、入力の
症状・原因・直し方を Phase 1 の入力にして、人に質問せずに進む（Preconditions の follow-up 質問はせず、足りない制約は
入力と対象コードから決める。dev-flow-health は無人の `claude -p` から呼ぶので、質問を待つと止まる）。重い経路では、
同じ型の別の症状まで消える直し方（削除・統合・一般化を含む）を設計してから起票する。切り替えた finding と理由は
Output Contract の `## Plan Quality Gate` に書く。

## Output Contract

実行後は必ず `references/output-contract.md` のサマリーを返す（`--lang` の言語で）。

## Journal Logging

On completion, log execution to journal:

```bash
# On success
journal log git-issue success \
  --duration-turns $TURNS

# On failure
journal log git-issue failure \
  --error-category <category> --error-msg "<message>"
```
