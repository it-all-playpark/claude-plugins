// dev-flow.js の blockSeen、dev-flow-evaluate.js の evalSeen、pr-iterate.js の reviewSeen / securitySeen が共有する
// stuck 検出 canonical。incentive-structural クラス — W7、撤去禁止。issue #123/#125/#126/#208。
//
// INLINE COPY POLICY: workflow から参照される最上位宣言だけが tools/sync-inlines.mjs --write で inline 生成される。
// 直接 workflow 側を編集しない。一致は _lib/workflow-inlines.sync.test.mjs が検証する。
//
// 命名注記: goal-ledger.mjs の topicKey と同一ファイル dev-flow.js に inline されるため
// 識別子衝突を避けて stuckTopicKey と命名。

// topic fingerprint を導出する。
// (a) x == null → ''
// (b) typeof x === 'string' → x をそのまま返す
// (c) typeof x.topic === 'string' かつ x.topic.trim() が非空 → 表記ゆれを吸収したキー
//     最初の `::` より前の problem-class は小文字化し、空白・`_`・ハイフンの連なりを 1 つのハイフンにまとめ、
//     前後のハイフンを落とす。`::` より後ろの詳細は trim と空白の圧縮だけで大小文字を保つ
//     （case-sensitive な FS では大小文字だけが違う別ファイルがあり得る）。同義語の統合はしない
//     （別の問題が 1 つの topic に畳まれて早く stuck する）。
// (d) x.file != null → `${String(x.file)}::${x.description != null ? String(x.description) : JSON.stringify(x)}`
// (e) x.description != null かつ String(x.description) が非空 → String(x.description)
// (f) それ以外 → JSON.stringify(x)
export function stuckTopicKey(x) {
  if (x == null) return '';
  if (typeof x === 'string') return x;
  if (typeof x.topic === 'string' && x.topic.trim()) {
    const topic = x.topic.trim();
    const sep = topic.indexOf('::');
    const cls = (sep < 0 ? topic : topic.slice(0, sep)).toLowerCase().replace(/[\s_-]+/g, '-').replace(/^-+|-+$/g, '');
    if (sep < 0) return cls;
    return `${cls}::${topic.slice(sep + 2).trim().replace(/\s+/g, ' ')}`;
  }
  if (x.file != null) {
    return `${String(x.file)}::${x.description != null ? String(x.description) : JSON.stringify(x)}`;
  }
  if (x.description != null && String(x.description)) return String(x.description);
  return JSON.stringify(x);
}

// stuck 検出 closure tracker を返す。
// 内部 state は plain object（Map 禁止 — Object.values/entries の列挙順序まで現行と一致させるため）。
// register(item): topic → { item, count } に累積。同一 topic の再登録は item を最新版で上書き + count 加算。
// prior(): Object.values(seen).map((s) => s.item) を返す。
// stuckTopics(): count >= threshold の topic キー配列を返す。
export function makeSeenTracker(threshold) {
  const seen = {};
  return {
    register(item) {
      const t = stuckTopicKey(item);
      if (seen[t]) { seen[t].item = item; seen[t].count += 1 }
      else seen[t] = { item, count: 1 };
    },
    prior() {
      return Object.values(seen).map((s) => s.item);
    },
    stuckTopics() {
      return Object.entries(seen).filter(([, s]) => s.count >= threshold).map(([t]) => t);
    },
  };
}
