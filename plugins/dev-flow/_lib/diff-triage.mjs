// parseDiffTriageFields: dev-flow Diff triage が使う統合 exec-proxy
// (`_shared/scripts/diff-triage.sh`) の応答を per-field 独立に検証する純関数 (issue #544, S1)。
//
// 統合スクリプトは {"risk":..., "files":..., "diffhash":..., "lines":...} の 1 JSON object を返すが、
// 各フィールドはそれぞれ別のフィールド別失敗ポリシーを持つ (下記)。本関数は「1 フィールドの不正が
// 他フィールドの判定に影響しない」ことを保証するため、各フィールドを完全に独立して検証する。
//
// フィールド別失敗ポリシー:
//   risk   - fail-closed。unified?.risk が object かつ typeof ok==='boolean' かつ
//            Array.isArray(hits) のときのみそのまま採用。それ以外は
//            {ok:false, hits:[], error:'diff-triage unified proxy unavailable (fail-closed)'} を合成
//            (null は返さない -- hits フィールド欠落を clean と同一視しない fail-closed が要件。
//            Diff triage の reconcileDanger/reconcileTestsurf は risk.ok!==true を fail-closed
//            として扱い、全 SEC/TESTSURF seed を unchecked に倒す)。
//   files  - fail-safe。Array.isArray(unified?.files) かつ全要素が string のときのみ採用。
//            それ以外は null (呼び出し側の realizedCount が NaN になり complex floor 安全弁へ
//            流れる。空配列 [] は正常な 0 件の realized diff として null と区別して維持する)。
//   hash   - fail-open。typeof unified?.diffhash?.hash==='string' のときのみその文字列を採用。
//            それ以外は null。
//   lines  - fail-safe。Array.isArray(unified?.lines) かつ全要素が {path:string, added/deleted: 0 以上の
//            整数} のときのみ採用。それ以外は null（classifyShape が行数補正をせず file 数判定に戻る。
//            取れない行数を 0 と読んで shape を下げない）。
//
// INLINE COPY POLICY: workflow から参照される最上位宣言だけが tools/sync-inlines.mjs --write で inline 生成される。
// 直接 workflow 側を編集しない。一致は _lib/workflow-inlines.sync.test.mjs が検証する。

// risk フィールドが契約通りの形か (issue #617)。fail-closed に倒れた 2 原因
// ---- (a) proxy が契約外形状を返した (top-level risk 欠落) / (b) proxy が契約通りの形で
// ok:false を報告した (diff-triage.sh 自体の失敗) ---- を呼び出し側が区別するための述語。
// parseRiskField の採用条件そのもので、両者が drift しないよう単一定義を共有する。
export function isWellFormedRiskField(unified) {
  const risk = unified?.risk;
  return risk != null && typeof risk === 'object' && typeof risk.ok === 'boolean' && Array.isArray(risk.hits);
}

function parseRiskField(unified) {
  if (isWellFormedRiskField(unified)) {
    return unified.risk;
  }
  return { ok: false, hits: [], error: 'diff-triage unified proxy unavailable (fail-closed)' };
}

function parseFilesField(unified) {
  const files = unified?.files;
  if (Array.isArray(files) && files.every((f) => typeof f === 'string')) {
    return files;
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

export function parseDiffTriageFields(unified) {
  return {
    risk: parseRiskField(unified),
    files: parseFilesField(unified),
    hash: parseHashField(unified),
    lines: parseLinesField(unified),
  };
}

// 宣言 "dev-flow".visual_snapshots の paths（基準画像のディレクトリ。repo 相対の glob）1 件を、その下の PNG に一致する
// 正規表現にする。規則は git の pathspec `:(glob)<path>/**/*.png` と同じ（撮影の後始末をする local-verify と、PR の差分の
// 一覧を取る git がこの pathspec で判定するので、食い違うと数えないファイルと PR に入るファイルがずれる）:
// `*` と `?` は `/` をまたがず、segment 全体の `**` は 0 個以上のディレクトリに一致する。
function visualSnapshotPngRegex(dir) {
  const glob = `${String(dir).replace(/\/+$/, '')}/**/*.png`;
  const literal = (ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let re = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      let j = i;
      while (glob[j] === '*') j++;
      const wholeSegment = j - i === 2 && (i === 0 || glob[i - 1] === '/');
      if (wholeSegment && glob[j] === '/') { re += '(?:[^/]+/)*'; i = j + 1; continue; }
      if (wholeSegment && j === glob.length) { re += '.*'; i = j; continue; }
      re += '[^/]*';
      i = j;
      continue;
    }
    if (c === '?') { re += '[^/]'; i++; continue; }
    if (c === '[') {
      const close = glob.indexOf(']', i + 2);
      if (close > 0) {
        const body = glob.slice(i + 1, close);
        re += `[${(body[0] === '!' ? `^${body.slice(1)}` : body).replace(/\\/g, '\\\\')}]`;
        i = close + 1;
        continue;
      }
    }
    if (c === '\\' && i + 1 < glob.length) { re += literal(glob[i + 1]); i += 2; continue; }
    re += literal(c);
    i++;
  }
  return new RegExp(`^${re}$`);
}

// withoutVisualSnapshotPngs: shape の判定に数える変わったファイルから、宣言の paths の下の PNG を外す（issue #1410）。
// 基準画像は撮影コマンドが書き換える生成物で、枚数で shape を上げると画面の変わる PR がそれだけで complex になる。
// paths は PR の外（origin/<base>・user 設定）から読んだ宣言の値だけを渡す — PR が自分で数えないファイルを選べないように。
// paths の下でも PNG でないファイルは残す。files が配列でなければそのまま返す（取得失敗の null を空と取り違えない）。
export function withoutVisualSnapshotPngs(files, paths) {
  if (!Array.isArray(files) || !Array.isArray(paths) || paths.length === 0) return files;
  const res = paths.filter((p) => typeof p === 'string' && p.trim() !== '').map(visualSnapshotPngRegex);
  return files.filter((f) => !res.some((re) => re.test(f)));
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
