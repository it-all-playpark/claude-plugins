// classifyShape: realized diff の file 数・file ごとの追加/削除行数と REQ 由来の決定論特徴量（AC 数 /
// issue_type / 構造化 breaking_change）から実効 shape を決める純粋関数。dev-flow の Diff triage（realized diff 取得後）
// で 1 回だけ呼ばれ、返り値が EFFECTIVE_SHAPE（Evaluate 深さ・LITE gate・merge tier の入力）になる。
//
// 入力は実装後の realized diff のみ。Setup 末尾の analyze ゲートまでに得られる LLM の事前見積もり（shape / 見込み file 数）は
// decision に使わない（issue #676）— 実装前の予測は log と失敗 telemetry にしか効かず、決定論なのは
// 写像と「欠損 → complex」の既定則だけだったため。micro の LITE 経路に対する意味的リスクの安全網は
// runEval 強制条件（danger-grep / testsurf / greenFix / dropped task / undeclared file / UI 接触）が担う。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。
// issue #272: AC 粒度と floor の較正 — micro floor の AC 境界を 3→4 に緩和。
// issue #278: breaking 判定を LLM 自由文 (scope/summary への regex) から、analyze REQ の
// 構造化 breaking_change フィールド + issue 本文への決定論 keyword scan の OR に変更。
// issue #364: keyword scan 単独 (breaking_keyword_scan=true && breaking_change!==true) は
// complex floor に採用しない (低 precision ヒューリスティック、実測 FP: #359/#361)。
// 構造化判定 breaking_change===true との corroboration があるときのみ floor へ採用する。
// issue #442: issue_type enum ドリフト修正 — AGENTS.md の正規 Conventional Commits 型 (chore/test/perf/ci) を validTypes に追加。
//
// 差分の中身による補正（issue #740）: file 数だけだと docs / テスト / 削除だけの掃除 run が complex に上がるため、
// file ごとの追加・削除行数（lineStats）が取れた run に限り、floor を通過した後で次の 3 つを適用する。
// どれも file 数判定（uncorrected_shape）より上には上げない — 下げ方向の補正だけ。
//   1. 重み: docs（docs/** と *.md）と、同じ run で対応する本番ファイルも変えたテスト（stem 一致）は数えない
//   2. 削除主体: 重み付け後の 追加行 < 削除行 × SHAPE_DELETION_DOWNSHIFT_RATIO なら 1 段下げる
//   3. 追加行数: complex は「重み付け後の file 数 > 5」かつ「重み付け後の追加行 > SHAPE_COMPLEX_MIN_ADDED_LINES」
//      のときだけ（広く浅い変更を complex に上げない）
// lineStats が無い / 不正 / 件数が realizedCount と合わないときは補正せず file 数判定のまま（取れない行数を
// 0 と読んで下げない）。変更がテストだけの run も補正しない（testsurf / test-only 経路の扱いを変えない）。
// 下げた先で意味的リスクを拾うのは Validate（typecheck / test）と runEval 強制条件で、ここでは見ない。
const SHAPE_DELETION_DOWNSHIFT_RATIO = 0.3;
// main の直近 150 commit で「重み付け後 file 数 > 5 かつ追加 ≤ 100 行」は、path 移行・manifest 整理等の
// 機械的な広く浅い変更だけだった（ロジック変更を含む run は 134 行以上）。
const SHAPE_COMPLEX_MIN_ADDED_LINES = 100;
const SHAPE_TIERS = ['micro', 'standard', 'complex'];

function isShapeDocPath(path) {
  return /(^|\/)docs\//.test(path) || /\.md$/i.test(path);
}

function isShapeTestPath(path) {
  return /\.(test|spec)\.[^/]+$/.test(path) || /(^|\/)__tests__\//.test(path) || /\.bats$/.test(path)
    || /_(test|spec)\.rb$/.test(path) || /Test\.php$/.test(path);
}

// テストと本番ファイルの対応付けに使う basename の stem
// （foo.test.ts / __tests__/foo.ts / foo.bats / foo_spec.rb / foo_test.rb / foo.ts → foo、FooTest.php / Foo.php → Foo）
function shapeStem(path) {
  const base = path.split('/').pop();
  if (/\.(test|spec)\.[^.]+$/.test(base)) return base.replace(/\.(test|spec)\.[^.]+$/, '');
  if (/_(test|spec)\.rb$/.test(base)) return base.replace(/_(test|spec)\.rb$/, '');
  if (/Test\.php$/.test(base)) return base.replace(/Test\.php$/, '');
  return base.replace(/\.[^.]+$/, '');
}

function isValidLineStats(lineStats, count) {
  return Array.isArray(lineStats)
    && lineStats.length === count
    && lineStats.every((s) => s != null && typeof s === 'object' && typeof s.path === 'string'
      && Number.isInteger(s.added) && s.added >= 0 && Number.isInteger(s.deleted) && s.deleted >= 0);
}

/**
 * @param {object} req - analyze REQ（acceptance_criteria / issue_type / breaking_change / breaking_keyword_scan を読む）
 * @param {number} realizedCount - realized diff の file 数（宣言外・format-only・ephemeral 除外後の整数。
 *   取得不能は NaN）
 * @param {Array<{path: string, added: number, deleted: number}>|null} [lineStats] - realizedCount に数えた
 *   file ごとの追加・削除行数（同じ file 集合）。取得不能は null（補正なし = file 数判定）
 * @returns {{ shape: 'micro'|'standard'|'complex', reason: string, uncorrected_shape: 'micro'|'standard'|'complex' }}
 *   uncorrected_shape は file 数だけで決めた補正前の shape（floor で決まったときは shape と同じ complex）
 */
export function classifyShape(req, realizedCount, lineStats = null) {
  const count = realizedCount;
  if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) {
    return { shape: 'complex', reason: `realized file count missing or invalid → safe floor=complex`, uncorrected_shape: 'complex' };
  }

  const ac = req.acceptance_criteria;
  if (!Array.isArray(ac)) {
    return { shape: 'complex', reason: `acceptance_criteria missing or not array → safe floor=complex`, uncorrected_shape: 'complex' };
  }

  const validTypes = ['feat', 'fix', 'docs', 'refactor', 'chore', 'test', 'perf', 'ci'];
  if (!validTypes.includes(req.issue_type)) {
    return { shape: 'complex', reason: `issue_type '${req.issue_type}' not in allowed set → floor=complex`, uncorrected_shape: 'complex' };
  }

  // keyword-alone (breaking_keyword_scan=true かつ breaking_change!==true) は complex floor に
  // 採用しない (issue #364)。構造化判定とのみ組合せたときに blocking へ採用する。
  const keywordAlone = req.breaking_keyword_scan === true && req.breaking_change !== true;

  if (req.breaking_change === true) {
    const reason = `breaking change detected (analyze structured breaking_change=true`
      + (req.breaking_keyword_scan === true ? ' + issue title/body keyword scan hit' : '')
      + `) → floor=complex`;
    return { shape: 'complex', reason, uncorrected_shape: 'complex' };
  }

  let uncorrected;
  if (count <= 2 && ac.length <= 4) {
    uncorrected = 'micro';
  } else if (count <= 5 && ac.length <= 6) {
    uncorrected = 'standard';
  } else {
    uncorrected = 'complex';
  }

  const keywordNote = keywordAlone
    ? `（breaking keyword hit は構造化判定 breaking_change=false のため floor 不採用 — 可視化のみ。issue #364）`
    : '';
  const head = `realized ${count} file(s)`;
  const tail = `${ac.length} AC, type=${req.issue_type}`;

  if (!isValidLineStats(lineStats, count)) {
    return { shape: uncorrected, reason: `${head}, ${tail} → shape=${uncorrected}${keywordNote}`, uncorrected_shape: uncorrected };
  }
  if (lineStats.length > 0 && lineStats.every((s) => isShapeTestPath(s.path))) {
    return {
      shape: uncorrected,
      reason: `${head}, ${tail} → shape=${uncorrected}（test-only のため補正なし）${keywordNote}`,
      uncorrected_shape: uncorrected,
    };
  }

  const prodStems = new Set(lineStats
    .filter((s) => !isShapeDocPath(s.path) && !isShapeTestPath(s.path))
    .map((s) => shapeStem(s.path)));
  const docs = lineStats.filter((s) => isShapeDocPath(s.path));
  const pairedTests = lineStats.filter((s) => !isShapeDocPath(s.path) && isShapeTestPath(s.path) && prodStems.has(shapeStem(s.path)));
  const weighted = lineStats.filter((s) => !docs.includes(s) && !pairedTests.includes(s));
  const added = weighted.reduce((n, s) => n + s.added, 0);
  const deleted = weighted.reduce((n, s) => n + s.deleted, 0);

  let tier;
  if (weighted.length <= 2 && ac.length <= 4) {
    tier = 'micro';
  } else if ((weighted.length <= 5 || added <= SHAPE_COMPLEX_MIN_ADDED_LINES) && ac.length <= 6) {
    tier = 'standard';
  } else {
    tier = 'complex';
  }
  const tierRank = SHAPE_TIERS.indexOf(tier);
  const downshift = tierRank > 0 && deleted > 0 && added < deleted * SHAPE_DELETION_DOWNSHIFT_RATIO;
  const shape = SHAPE_TIERS[Math.min(downshift ? tierRank - 1 : tierRank, SHAPE_TIERS.indexOf(uncorrected))];

  const reason = `${head} → weighted ${weighted.length}（docs ${docs.length} / 対応本番ありの test ${pairedTests.length} を除外）, `
    + `+${added}/-${deleted} lines, ${tail} → file 数判定 ${uncorrected}, 重み・行数判定 ${tier}`
    + (downshift
      ?`, 削除主体（追加 < 削除×${SHAPE_DELETION_DOWNSHIFT_RATIO}）で 1 段下げ`
      : ', 1 段下げなし')
    + ` → shape=${shape}${keywordNote}`;
  return { shape, reason, uncorrected_shape: uncorrected };
}
