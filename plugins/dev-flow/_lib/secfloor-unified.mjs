// parseSecfloorFields: dev-flow Security floor が使う統合 exec-proxy
// (`_shared/scripts/secfloor-classify.sh`) の応答を per-field 独立に検証する純関数 (issue #544, S1)。
//
// 統合スクリプトは {"risk":..., "files":..., "struct":..., "diffhash":..., "lines":..., "secreview":...} の 1 JSON object を返すが、
// 各フィールドはそれぞれ別のフィールド別失敗ポリシーを持つ (下記)。本関数は「1 フィールドの不正が
// 他フィールドの判定に影響しない」ことを保証するため、各フィールドを完全に独立して検証する。
//
// フィールド別失敗ポリシー:
//   risk   - fail-closed。unified?.risk が object かつ typeof ok==='boolean' かつ
//            Array.isArray(hits) のときのみそのまま採用。それ以外は
//            {ok:false, hits:[], error:'secfloor unified proxy unavailable (fail-closed)'} を合成
//            (null は返さない -- hits フィールド欠落を clean と同一視しない fail-closed が要件。
//            security floor の reconcileDanger/reconcileTestsurf は risk.ok!==true を fail-closed
//            として扱い、全 SEC/TESTSURF seed を unchecked に倒す)。
//   files  - fail-safe。Array.isArray(unified?.files) かつ全要素が string のときのみ採用。
//            それ以外は null (呼び出し側の realizedCount が NaN になり complex floor 安全弁へ
//            流れる。空配列 [] は正常な 0 件の realized diff として null と区別して維持する)。
//   struct - fail-open。unified?.struct が object かつ struct.ok===true かつ
//            typeof struct.available==='boolean' かつ format_only/structural (structural は
//            省略可、省略時は [] 扱い) が配列のときのみ採用。それ以外は null。
//   hash   - fail-open。typeof unified?.diffhash?.hash==='string' のときのみその文字列を採用。
//            それ以外は null。
//   lines  - fail-safe。Array.isArray(unified?.lines) かつ全要素が {path:string, added/deleted: 0 以上の
//            整数} のときのみ採用。それ以外は null（classifyShape が行数補正をせず file 数判定に戻る。
//            取れない行数を 0 と読んで shape を下げない）。
//   secreview - fail-safe。unified?.secreview が {target: boolean, reasons: string[]} のときのみ採用。それ以外
//            （欠落・null・型不正）は {target: true, reasons: [SECREVIEW_UNAVAILABLE_REASON]}（pr-iterate の security
//            review の対象に倒す。判定入力の不明を「信頼境界をまたがない」と同一視しない。issue #1063）。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。

// risk フィールドが契約通りの形か (issue #617)。fail-closed に倒れた 2 原因
// ---- (a) proxy が契約外形状を返した (top-level risk 欠落) / (b) proxy が契約通りの形で
// ok:false を報告した (secfloor-classify.sh 自体の失敗) ---- を呼び出し側が区別するための述語。
// parseRiskField の採用条件そのもので、両者が drift しないよう単一定義を共有する。
export function isWellFormedRiskField(unified) {
  const risk = unified?.risk;
  return risk != null && typeof risk === 'object' && typeof risk.ok === 'boolean' && Array.isArray(risk.hits);
}

function parseRiskField(unified) {
  if (isWellFormedRiskField(unified)) {
    return unified.risk;
  }
  return { ok: false, hits: [], error: 'secfloor unified proxy unavailable (fail-closed)' };
}

function parseFilesField(unified) {
  const files = unified?.files;
  if (Array.isArray(files) && files.every((f) => typeof f === 'string')) {
    return files;
  }
  return null;
}

function parseStructField(unified) {
  const struct = unified?.struct;
  if (
    struct != null
    && typeof struct === 'object'
    && struct.ok === true
    && typeof struct.available === 'boolean'
    && Array.isArray(struct.format_only)
    && Array.isArray(struct.structural ?? [])
  ) {
    return struct;
  }
  return null;
}

function parseHashField(unified) {
  const hash = unified?.diffhash?.hash;
  return typeof hash === 'string' ? hash : null;
}

function parseLinesField(unified) {
  const lines = unified?.lines;
  if (
    Array.isArray(lines)
    && lines.every((l) => l != null && typeof l === 'object' && typeof l.path === 'string'
      && Number.isInteger(l.added) && l.added >= 0 && Number.isInteger(l.deleted) && l.deleted >= 0)
  ) {
    return lines;
  }
  return null;
}

export const SECREVIEW_UNAVAILABLE_REASON = 'unavailable: secfloor proxy の secreview が欠落・不正（fail-safe で対象扱い）';

function parseSecreviewField(unified) {
  const sr = unified?.secreview;
  if (
    sr != null && typeof sr === 'object' && typeof sr.target === 'boolean'
    && Array.isArray(sr.reasons) && sr.reasons.every((r) => typeof r === 'string')
  ) {
    return { target: sr.target, reasons: sr.reasons };
  }
  return { target: true, reasons: [SECREVIEW_UNAVAILABLE_REASON] };
}

export function parseSecfloorFields(unified) {
  return {
    risk: parseRiskField(unified),
    files: parseFilesField(unified),
    struct: parseStructField(unified),
    hash: parseHashField(unified),
    lines: parseLinesField(unified),
    secreview: parseSecreviewField(unified),
  };
}

// lineStatsFor: classifyShape に渡す file ごとの行数を、realized count に数えた files の順で組む。
// 1 件でも lines に行数が無い file（binary・取得失敗）があれば null を返し、file 数判定に戻す。
export function lineStatsFor(files, lines) {
  if (!Array.isArray(files) || !Array.isArray(lines)) return null;
  const byPath = new Map(lines.map((l) => [l.path, l]));
  const stats = [];
  for (const path of files) {
    const l = byPath.get(path);
    if (!l) return null;
    stats.push({ path, added: l.added, deleted: l.deleted });
  }
  return stats;
}
