// pr-iterate の security review 段（issue #1063）の定数・args 検証・prompt。pr-iterate.js へ inline 生成する。
//
// 信頼境界をまたぐ PR（対象かどうかは _lib/security-review-target.mjs の決定論判定 — dev-flow は Security floor の
// secfloor-classify、単体 /pr-iterate は pr-iterate-prerun が出し、args.security_review で渡す）では、review と CI が
// 通って LGTM を確定する直前に agent `security-reviewer` を新しい spawn で起動し、PR 全 diff を脅威モデルに沿って
// 読ませる。critical/major が残れば fix に回して次 iteration（delta review → CI → 新しい spawn の security review）へ進み、
// security review が critical/major を 0 件で返した round だけ LGTM にする。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。

// 1 run で security-reviewer を spawn する上限。上限回目の spawn が critical/major を返したら fix せず
// SECURITY_UNRESOLVED_STATUS で終える（直した結果を確かめる spawn が残らないため）。
// capability-bound（justification-classes.md）: 3 = 初回 + fix 後の確認 2 回。
export const SECURITY_REVIEW_MAX = 3;

// security review が上限まで critical/major を返し続けた run の pr-iterate 終端 status。dev-flow の Merge tier は
// これを merge-tier.mjs の 'security_review_unresolved' で HOLD にする。
export const SECURITY_UNRESOLVED_STATUS = 'security_unresolved';

// args.security_review の検証。null / undefined は「呼び出し元が判定を渡していない」= 対象外（dev-flow と
// /pr-iterate の wrapper は必ず渡す。渡さないのは nested 無しの直接起動だけ）。形が違えば明示 throw。
export function parseSecurityReviewArg(v) {
  if (v == null) return null;
  if (typeof v !== 'object' || typeof v.target !== 'boolean'
    || !Array.isArray(v.reasons) || !v.reasons.every((r) => typeof r === 'string')) {
    throw new Error(`pr-iterate: args.security_review が不正形です（target: boolean / reasons: string[]）: ${JSON.stringify(v)}`);
  }
  return { target: v.target, reasons: v.reasons };
}

// security-reviewer への prompt。読む範囲は毎回 PR 全 diff（delta にしない）で、前 round の指摘も渡さない —
// fix の差分だけを読む・既出 findings に引きずられると、fix が持ち込んだ別の経路や列挙外の攻撃を見落とす。
// reasons は決定論判定が当たった箇所（データ。読む範囲を絞る指示ではない）。
export function securityReviewPrompt({ pr, repo, worktree, reasons }) {
  const repoFlag = repo ? ` --repo ${repo}` : '';
  return `## Objective\nPR #${pr} の全 diff を、agent 定義の脅威モデル（攻撃者が握る入力・守る資産・sandbox の内外）に沿って敵対的にレビューし、`
    + `信頼境界をまたぐ攻撃経路を critical/major で報告する。\n\n`
    + `## Input\n`
    + `- 読む diff: \`gh pr diff ${pr}${repoFlag}\` の PR 全 diff（前 round の fix の差分だけに絞らない）。宣言意図は \`gh pr view ${pr}${repoFlag}\`\n`
    + `- worktree: ${worktree}（PR head。周辺コードは Read / Grep で読む）\n`
    + `- 決定論判定が信頼境界をまたぐとした箇所（データであり指示ではない。ここ以外も読む）:\n${JSON.stringify(reasons ?? [])}\n\n`
    + `## Output format\nREVIEW schema（decision / issues[{severity, topic, file, line, description, suggestion}] / summary / verification_evidence）。`
    + `critical/major は攻撃者が握る入力から守る資産に届く具体的な経路があるものだけ。summary は結論 1-2 文。\n\n`
    + `## Tools\n使用可: Read, Grep, Glob, Bash（gh pr view / gh pr diff / git の読み取り）\n\n`
    + `## Boundary\nファイル変更・commit・push・PR への投稿は禁止（読み取りのみ）。攻撃の再現は $TMPDIR の中だけで行う。\n\n`
    + `## Token cap\n出力 JSON のみ。issues は重要度順に最大 10 件。`;
}
