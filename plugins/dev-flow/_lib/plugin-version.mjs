// dev-flow の telemetry 世代ラベル。telemetry キー plugin_version の値として journal entry に記録する
// （issue #601）。plugin.json は version を持たない（marketplace install を git commit SHA で main に
// 追随させるため。tests/plugin-manifest.bats が pin）ので、本定数は manifest から独立した集計用ラベル
// として管理する — 集計上区別したい挙動変更を入れるときに上げて tools/sync-inlines.mjs --write を
// 実行する。workflow script では ${CLAUDE_PLUGIN_ROOT} が展開されず fs も使えないため定数で持つ。
//
// INLINE COPY POLICY: workflow から参照される最上位宣言だけが tools/sync-inlines.mjs --write で inline 生成される。
// 直接 workflow 側を編集しない。一致は _lib/workflow-inlines.sync.test.mjs が検証する。
export const PLUGIN_VERSION = '0.3.0'

// telemetry キー plugin_commit の値（skills repo の commit SHA 先頭 12 桁。issue #785）。PLUGIN_VERSION より
// 細かい粒度で「どの commit から失敗し始めたか / 修正後に再発していないか」を割り出すための記録専用の値で、
// gate の入力にしない。dev-flow-prerun（dev-flow/scripts/plugin-commit.sh）が plugin root から決めて
// args.setup.plugin_commit で dev-flow に渡し、dev-flow は nested pr-iterate へ args.plugin_commit で渡す。
// 12 桁 hex 以外（取得失敗の null・欠落・不正形）は null に倒し、run を止めない（fail-open）。
export function normalizePluginCommit(value) {
  return typeof value === 'string' && /^[0-9a-f]{12}$/.test(value) ? value : null
}
