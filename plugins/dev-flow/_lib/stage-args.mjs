// 工程の workflow（dev-flow.js が workflow() で起動する子）に渡す引数と、子の返り値の形を検証する。
// 子は親の判定結果を引数でだけ受け取るので、欠けたキー・型違いを黙って undefined のまま進めず throw する
// （親は子の throw を HOLD に倒す）。工程を切り出すたびに子ごとの検証を書かず、spec だけを足す。
// spec は { キー: 型 } で、型は STAGE_ARG_TYPES のどれか、または `|null` を付けた形（例: 'string|null'）。
// spec のキーはすべて必須（undefined は欠落扱い）。spec に無いキーは見ない。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。

export const STAGE_ARG_TYPES = ['string', 'number', 'boolean', 'object', 'array'];

export function stageArgType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

export function validateStageArgs(stage, value, spec) {
  if (stageArgType(value) !== 'object') {
    throw new Error(`${stage}: object が必要（受信: ${stageArgType(value)}）`);
  }
  for (const key of Object.keys(spec)) {
    const allowed = String(spec[key]).split('|');
    if (allowed.some((t) => t !== 'null' && !STAGE_ARG_TYPES.includes(t))) {
      throw new Error(`${stage}: spec のキー ${key} の型 ${spec[key]} は ${STAGE_ARG_TYPES.join(' / ')}（|null 可）のどれでもない`);
    }
    if (!(key in value) || value[key] === undefined) {
      throw new Error(`${stage}: 必須のキー ${key} が無い`);
    }
    const actual = stageArgType(value[key]);
    if (!allowed.includes(actual)) {
      throw new Error(`${stage}: キー ${key} の型が ${spec[key]} でない（受信: ${actual}）`);
    }
  }
  return value;
}
