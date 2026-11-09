// base-failure-triage: Validate のテスト失敗を「diff が原因でありうる失敗（green-fix の対象）」と
// 「diff と無関係で base でも同じように落ちる既存の失敗（ENV 項目。green 要件から外す）」に分ける純粋関数群。
// I/O なし、非決定性なし。同入力 -> byte 一致。
//
// 判定の順序（呼び出し側 runValidateLoop の契約）:
//   1. 失敗したテストファイル（test 実行 proxy の failed_files）と diff のファイル一覧（base → working tree の
//      tracked 差分 + untracked）を突き合わせ、テストファイル自身か、そのテスト対象のソース（同じディレクトリで
//      stem が同じファイル。例: foo.bats ↔ foo.sh、foo.test.mjs ↔ foo.mjs）が diff にあれば green-fix の対象に残す。
//   2. 残りは base tree で同じファイルだけを再実行し、base でも同じテストが落ちたものだけを ENV にする。
//      再実行できなかった・base では通った・落ち方が違う、はすべて green-fix の対象に残す（ENV 判定の材料が
//      欠けたら green 要件を緩めない — 誤って ENV に倒すと diff 起因の red が green 扱いで PR まで流れる）。
//
// INLINE COPY POLICY: workflow から参照される最上位宣言だけが tools/sync-inlines.mjs --write で inline 生成される。
// 直接 workflow 側を編集しない。一致は _lib/workflow-inlines.sync.test.mjs が検証する。

// 終端サマリー・ledger の ENV 項目で使う表記（「base でも失敗する既存の失敗」）。
export const BASE_FAILING_LABEL = 'base でも失敗する既存の失敗';
export const BASE_FAILING_ENV_KEY = 'base-failing';

// repo 相対パスの配列に正規化する（非文字列・空を落とし、先頭の ./ を外し、重複を除く。順序は保つ）。
export function normalizeTestPaths(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const p = raw.trim().replace(/^(\.\/)+/, '');
    if (p === '' || out.includes(p)) continue;
    out.push(p);
  }
  return out;
}

function splitDirBase(path) {
  const i = path.lastIndexOf('/');
  return i < 0 ? { dir: '', base: path } : { dir: path.slice(0, i), base: path.slice(i + 1) };
}

// テストファイル名から、テスト対象のソースと共有する stem を取り出す。
export function testFileStem(testPath) {
  const { base } = splitDirBase(testPath);
  const patterns = [/^(.+)\.(?:test|spec)\.[^.]+$/, /^(.+)\.bats$/, /^(.+)_test\.[^.]+$/, /^test_(.+)\.py$/];
  for (const re of patterns) {
    const m = re.exec(base);
    if (m) return m[1];
  }
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

// changedPath がテストファイル testPath のテスト対象のソース（同じディレクトリで stem が同じ）か。
export function isTestSubjectOf(testPath, changedPath) {
  if (changedPath === testPath) return false;
  const t = splitDirBase(testPath);
  const c = splitDirBase(changedPath);
  if (t.dir !== c.dir) return false;
  const dot = c.base.indexOf('.');
  const changedStem = dot > 0 ? c.base.slice(0, dot) : c.base;
  return changedStem === testFileStem(testPath);
}

// 失敗したテストファイルを diff と突き合わせ、base で再実行するものを決める。
//   knownEnv:       前の iteration で ENV と判定済みのファイル（diff に入っていなければ再実行せず ENV のまま）
//   knownBaseRan:   前の iteration で base 再実行済みで ENV にならなかったファイル（再実行せず green-fix 対象）
// 返り値: touched（diff が触った: green-fix 対象）/ env（判定済み ENV）/ code（判定済み非 ENV）/ rerun（base で再実行する）
export function planBaseRerun({ failedFiles, diffFiles, knownEnv = [], knownBaseRan = [] }) {
  const failed = normalizeTestPaths(failedFiles);
  const diff = normalizeTestPaths(diffFiles);
  const touched = [];
  const env = [];
  const code = [];
  const rerun = [];
  for (const f of failed) {
    if (diff.includes(f) || diff.some((c) => isTestSubjectOf(f, c))) touched.push(f);
    else if (knownEnv.includes(f)) env.push(f);
    else if (knownBaseRan.includes(f)) code.push(f);
    else rerun.push(f);
  }
  return { touched, env, code, rerun };
}

// base 再実行の結果（proxy の results）から ENV を決める。base で実行でき（ran）、base でも失敗し（base_failed）、
// head で落ちたテストが base でもすべて落ちた（same_failure）ものだけが ENV。結果が無い・欠けたファイルは非 ENV。
// 返り値: env / code（非 ENV 全件）/ ran（base で実行できたファイル。次の iteration で再実行しない）
export function classifyBaseRerun(rerunFiles, results) {
  const files = normalizeTestPaths(rerunFiles);
  const byFile = new Map();
  for (const r of (Array.isArray(results) ? results : [])) {
    if (!r || typeof r !== 'object' || typeof r.file !== 'string') continue;
    const key = normalizeTestPaths([r.file])[0];
    if (key && !byFile.has(key)) byFile.set(key, r);
  }
  const env = [];
  const code = [];
  const ran = [];
  for (const f of files) {
    const r = byFile.get(f);
    if (r && r.ran === true) ran.push(f);
    if (r && r.ran === true && r.base_failed === true && r.same_failure === true) env.push(f);
    else code.push(f);
  }
  return { env, code, ran };
}
