// devflow-durations: dev-flow run の duration_seconds / phase_durations 算出用の純関数群。
// I/O なし・Date.now/Math.random 不使用。専用 clock probe は 0 回 —
// start は wrapper が渡す args.setup.epoch（dev-flow-prerun の date +%s、deps install 前）、
// setup_end は同じ prerun 応答の args.setup.epoch_end（deps install / detect-stack / analyze 段
// 完了後、prerun.sh 末尾で採る）から給電する。end は Merge tier 末尾の post-summary 応答の
// optional epoch から給電し、残り 6 mark（implement_end/validate_end/evaluate_end/pr_end/
// iterate_end/final_end）は隣接する既存 exec-proxy / agent 応答の optional epoch フィールドから
// recordClockMark へ給電される（fail-open — 給電元失敗は当該 mark null → 対応 duration キー欠落）。
// epoch と epoch_end を分けているのは、deps install（npm ci 等で数分かかりうる）と prerun の
// analyze 段（issue 取得 + Jev 判定。deps と並列）を implement の phase_durations に付け替えないため —
// start〜setup_end の区間（deps/stack/analyze の決定論処理 + wrapper turn）はどの phase にも属さない
// 残差（duration_seconds − Σphase_durations）に留め、analyze 段の所要だけは telemetry の
// prerun_durations.analyze に別途載せる（issue #690）。Setup 末尾の analyze ゲート（args.setup.analyze の
// whitelist 検証と 3 条件ゲート判定）は agent を spawn しない純関数なので固有の mark を持たない —
// implement 区間は setup_end 起点で、isolation-probe / plan 合成の時間を含む（issue #695）。
//
// INLINE COPY POLICY: workflow から参照される最上位宣言だけが tools/sync-inlines.mjs --write で inline 生成される。
// 直接 workflow 側を編集しない。一致は _lib/workflow-inlines.sync.test.mjs が検証する。

// dev-flow.js の probe 発火順と一致する序列。
export const CLOCK_MARK_ORDER = [
  'start',
  'setup_end',
  'implement_end',
  'validate_end',
  'evaluate_end',
  'pr_end',
  'iterate_end',
  'final_end',
  'end',
];

// phase キー → 終端 mark 名。setup_end は implement 区間の起点としてだけ使い、setup 自体の
// duration は出さない（deps install 等の決定論処理は残差に留める）。
export const CLOCK_PHASE_ENDS = [
  ['implement', 'implement_end'],
  ['validate', 'validate_end'],
  ['evaluate', 'evaluate_end'],
  ['pr', 'pr_end'],
  ['iterate', 'iterate_end'],
  ['final', 'final_end'],
];

// marks から number 値のみを取り出す内部ヘルパー（null/undefined/非数値/NaN は null 扱い）。
function readMark(marks, name) {
  const v = marks ? marks[name] : undefined;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * exec-proxy の応答 res を marks[name] へ記録する。
 * 成功（ok:true かつ epoch が有限数値）なら marks[name]=epoch を設定し null を返す。
 * 失敗（null / ok:false / schema 不一致）は marks[name]=null を設定し警告文字列を返す（fail-open）。
 * @param {object} marks - mutate 対象の mark 集計 object
 * @param {string} name - CLOCK_MARK_ORDER 上の mark 名
 * @param {{ok?: boolean, epoch?: number}|null} res - exec-proxy 応答
 * @returns {string|null} 警告文字列、または成功時 null
 */
export function recordClockMark(marks, name, res) {
  const ok = res && res.ok === true && typeof res.epoch === 'number' && Number.isFinite(res.epoch);
  if (ok) {
    marks[name] = res.epoch;
    return null;
  }
  marks[name] = null;
  return `⚠️ clock#${name} の取得に失敗 — duration telemetry は当該区間を欠落させる（fail-open）`;
}

/**
 * 隣接する既存 exec-proxy / agent 応答から recordClockMark 給電用の {ok:true, epoch} を抽出する。
 * ok フラグの有無は見ない（LLM agent 応答には ok が無いため）。epoch が有限数値でなければ null。
 * @param {{epoch?: unknown}|null|undefined} res - 給電元の応答 object
 * @returns {{ok: true, epoch: number}|null}
 */
export function epochResOf(res) {
  if (!res || typeof res !== 'object') {
    return null;
  }
  const epoch = res.epoch;
  if (typeof epoch === 'number' && Number.isFinite(epoch)) {
    return { ok: true, epoch };
  }
  return null;
}

/**
 * epochResOf 由来の候補配列（null 混在可）から最大 epoch の給電結果を選ぶ。
 * 並列 implementer など完了順が不定な複数給電元から「最後に完了したもの」を採用するために使う。
 * @param {Array<{ok: true, epoch: number}|null>|null|undefined} list - epochResOf の適用結果配列
 * @returns {{ok: true, epoch: number}|null}
 */
export function maxEpochRes(list) {
  if (!Array.isArray(list)) {
    return null;
  }
  let best = null;
  for (const item of list) {
    const res = epochResOf(item);
    if (res !== null && (best === null || res.epoch > best.epoch)) {
      best = res;
    }
  }
  return best;
}

/**
 * marks から duration_seconds（run 全体）と phase_durations（6 phase）を算出する。
 * @param {object} marks - CLOCK_MARK_ORDER の各 mark 名をキーに持つ object（値は epoch 秒 or null）
 * @returns {{duration_seconds: number|null, phase_durations: object}}
 */
export function computeDurations(marks) {
  const start = readMark(marks, 'start');
  const end = readMark(marks, 'end');
  let duration_seconds = null;
  if (start !== null && end !== null) {
    const diff = end - start;
    if (diff >= 0) {
      duration_seconds = diff;
    }
  }

  const phase_durations = {};
  for (const [key, endMarkName] of CLOCK_PHASE_ENDS) {
    const endVal = readMark(marks, endMarkName);
    if (endVal === null) {
      continue;
    }
    const endIdx = CLOCK_MARK_ORDER.indexOf(endMarkName);
    let startVal = null;
    for (let i = endIdx - 1; i >= 0; i--) {
      const v = readMark(marks, CLOCK_MARK_ORDER[i]);
      if (v !== null) {
        startVal = v;
        break;
      }
    }
    if (startVal === null) {
      continue;
    }
    const diff = endVal - startVal;
    if (diff < 0) {
      continue;
    }
    phase_durations[key] = diff;
  }

  return { duration_seconds, phase_durations };
}
