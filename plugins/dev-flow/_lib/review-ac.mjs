// review-ac: pr-reviewer の prompt へ issue の acceptance criteria を注入するブロックを組み立てる。
// I/O なし、gh なし、Date.now() 非決定性なし。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証する。
//
// なぜ必要か: pr-reviewer は「PR の title/body（buildPrBody が AC / plan から確定した宣言意図）と実 diff の照合」しか
// しておらず、issue の AC を渡されていなかった。evaluator（requirements/AC 忠実性）と
// pr-reviewer（commit 後 PR の品質 + CI）は評価軸が直交しており統合すべきではないが、
// pr-reviewer が AC を「見ないまま approve する」状態は縮められる。
// 実測（journal 145 run）で lgtm 後の merge tier HOLD 理由の最頻値は「AC 未達」8 件 —
// pr-reviewer が approve したものを evaluator 系ゲートが止めている。
//
// ゲート境界は変えない（本ブロックは pr-reviewer への **入力の追加のみ**）。AC 未達を blocking に
// する判定は既存の merge tier HOLD が引き続き担う。
//
// dev-flow lite route（pr-review-lite）と pr-iterate（review#i）の双方が同一文言を使うため
// canonical 化する（片側だけ直すと 2 経路で reviewer の見るものが食い違う）。
//
// scope='delta'（pr-iterate review#i, i≥2 の fix delta round）は文言を変える: delta round は
// diff を fix delta にしか渡さないため「AC 未達を新規 finding として探せ」という指示のままだと、
// delta 外（review scope 外）の AC 未達まで reviewer に判定させてしまい、本来 delta に絞りたい
// churn を AC 経由で復活させる。delta round では「既出 findings 中の AC 未達が今回の delta で
// 解消されたか」の確認にだけ AC を使わせ、新規の AC 未達探索はさせない。
//
// securityFixAcceptanceCriteriaBlock は pr-iterate の security review の指摘を含む fix#i の prompt に入れる（issue #1163）。
// AC を知らない fix は、AC が求める挙動を変えないと塞げない指摘を「最も単純な形で塞ぐ」側に倒して AC を書き換え、
// 次の round の review が「AC と逆」を出して review ⇄ fix が逆向きの指摘で stuck まで回る。AC と security の要件の
// どちらを取るかは人が決めるので、fix にはぶつかる指摘を直させず deferred_security_topics で返させる。

// 文字列の要素だけを trim して空を除き、1 始まりで番号を振る。注入しないときは空文字。
function numberedAcceptanceCriteria(acceptanceCriteria) {
  if (!Array.isArray(acceptanceCriteria)) return '';
  return acceptanceCriteria
    .filter((a) => typeof a === 'string')
    .map((a) => a.trim())
    .filter((a) => a.length > 0)
    .map((a, idx) => `${idx + 1}. ${a}`)
    .join('\n');
}

/**
 * acceptance criteria ブロックを組み立てる純粋関数。
 *
 * @param {unknown} acceptanceCriteria - issue の AC 配列。未指定 / 非配列 / 空配列 / 全要素が
 *   空文字のときは空文字を返す（fail-open — 単体起動の /pr-iterate は issue context を持たない）。
 * @param {{scope?: 'full'|'delta'}} [opts] - scope='delta' は fix delta round 用の文言に切り替える
 *   （既定 'full'。review#1 や dev-flow lite route など PR 全体を読む経路はこちら）。
 * @returns {string} prompt へ連結するブロック（末尾改行つき）。注入しない場合は空文字。
 */
export function acceptanceCriteriaBlock(acceptanceCriteria, { scope = 'full' } = {}) {
  const numbered = numberedAcceptanceCriteria(acceptanceCriteria);
  if (numbered === '') return '';
  const instruction = scope === 'delta'
    ? `このラウンドは fix delta（前回 review 以降の差分）のみを読む。AC は delta 外まで含めた`
      + `新規の未達探しには使わず、既出 findings の中に AC 未達があれば今回の delta で解消されたか`
      + `だけを確認せよ。delta 外の AC 未達を新規 finding として報告するな`
      + `（severity は他の finding と同じ基準で付ける。AC 未達であることだけを理由に critical へ引き上げない）。\n`
    : `diff がこれらを満たしているかも判定に含めよ。未達があれば issue として報告せよ`
      + `（severity は他の finding と同じ基準で付ける。AC 未達であることだけを理由に critical へ引き上げない）。\n`;
  return `issue の受入条件（acceptance criteria）:\n${numbered}\n` + instruction;
}

/**
 * security review の指摘を含む fix#i の prompt に足す、AC の一覧と AC とぶつかる指摘を人に返させる指示。
 *
 * @param {unknown} acceptanceCriteria - issue の AC 配列。acceptanceCriteriaBlock と同じく、注入する要素が無ければ空文字
 *   （単体起動の /pr-iterate は AC を持たない）。
 * @returns {string} SECURITY_FIX_GUIDANCE の後ろへ連結するブロック（末尾改行つき）。注入しない場合は空文字。
 */
export function securityFixAcceptanceCriteriaBlock(acceptanceCriteria) {
  const numbered = numberedAcceptanceCriteria(acceptanceCriteria);
  if (numbered === '') return '';
  return `この PR の issue の受入条件（AC）:\n${numbered}\n`
    + '- security review の指摘のうち、AC が求める挙動を変える・AC が変えないとした判定やテストを変える形でしか塞げない指摘は直さず、'
    + 'その指摘行の `[topic: <topic>]` の <topic> を一字も変えずに deferred_security_topics に入れ、summary にぶつかる AC の番号を書く'
    + '（AC と security の要件のどちらを取るかは人が決める）。AC を書き換えて指摘を塞がない\n';
}
