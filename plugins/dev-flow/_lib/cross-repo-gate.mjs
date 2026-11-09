// cross-repo-gate: empty-diff gate に cross-repo issue の graceful 終了経路を追加するための純関数群
// （implementer の成果が本 repo の worktree ではなく別リポジトリの working tree にある場合、
// 空 diff を fail-closed で throw する既存 gate は実装完了済みの run を誤って中断させてしまう。
// 人間が明示的に付与した `cross-repo` ラベルと、implementer 申告ファイルのうち worktree 外の
// working tree が実際に dirty である決定論的証拠が揃った場合のみ graceful 終了へ倒す — cross-repo と判定
// されたケースでも成果物の所在を人間に報告し、黙って破棄しない）。
//
// hasCrossRepoLabel: `gh issue view --json labels` の生形式（文字列配列 or {name} オブジェクト配列）を
//   受け取り、'cross-repo' ラベルの厳密一致有無を判定する純関数。
// crossRepoCandidatePaths: implementer 結果配列から、worktree 外の絶対パス候補を抽出する純関数
//   （BLOCKED/NEEDS_CONTEXT の files は対象外、worktree 配下・.devflow-tmp/ は除外、重複排除、最大50件）。
//   後続の cross-repo-artifacts.sh 呼び出しは各パスを単一引用符で囲んで bash コマンド行に埋め込むため
//   （dev-runner-haiku-ro が exec-proxy として実行）、単一引用符 (') と改行/制御文字を含むパスは
//   shell quoting を突破しコマンド注入に使われ得る。files は implementer（LLM）申告値であり issue 本文
//   経由の間接汚染経路もあるため、当該文字を含む候補はここで除外する（PR #434 review）。
// summarizeCrossRepoArtifacts: cross-repo-artifacts.sh exec-proxy の結果を fail-safe に正規化する純関数。
// crossRepoReturnNote: 成果物の所在を人間に報告する定型文を組み立てる純関数。
//
// INLINE COPY POLICY: workflow から参照される最上位宣言だけが tools/sync-inlines.mjs --write で inline 生成される。
// 直接 workflow 側を編集しない。一致は _lib/workflow-inlines.sync.test.mjs が検証する。
// 制約: ESM import / require / Date.now / Math.random を含めない。export function / export const のみ。

export function hasCrossRepoLabel(labels) {
  if (!Array.isArray(labels)) return false;
  return labels.some((label) => {
    if (typeof label === 'string') return label === 'cross-repo';
    if (label && typeof label === 'object' && typeof label.name === 'string') return label.name === 'cross-repo';
    return false;
  });
}

export function crossRepoCandidatePaths(implResults, worktree) {
  if (!Array.isArray(implResults)) return [];
  const normalizedWorktree = worktree.endsWith('/') ? worktree.slice(0, -1) : worktree;
  const out = [];
  const seen = new Set();
  for (const result of implResults) {
    if (!result || (result.status !== 'DONE' && result.status !== 'DONE_WITH_CONCERNS')) continue;
    if (!Array.isArray(result.files)) continue;
    for (const file of result.files) {
      if (typeof file !== 'string') continue;
      if (!(file.startsWith('/') || file.startsWith('~/'))) continue;
      if (file === normalizedWorktree || file.startsWith(`${normalizedWorktree}/`)) continue;
      if (file.includes('.devflow-tmp/')) continue;
      // shell quoting breakout guard: 単一引用符・改行・制御文字を含む候補は、後段で単一引用符
      // 囲みのまま bash コマンド行へ埋め込まれる際に quoting を突破し得るため除外する。
      if (/['\n\r\x00-\x1f]/.test(file)) continue;
      if (seen.has(file)) continue;
      seen.add(file);
      out.push(file);
      if (out.length >= 50) return out;
    }
  }
  return out;
}

export function summarizeCrossRepoArtifacts(res) {
  const handoff = res != null && res.ok === true && typeof res.found === 'number' && res.found >= 1;
  if (!handoff) {
    return { handoff: false, found: 0, artifacts: [] };
  }
  return {
    handoff: true,
    found: res.found,
    artifacts: Array.isArray(res.artifacts) ? res.artifacts : [],
  };
}

export function crossRepoReturnNote(artifacts) {
  const list = Array.isArray(artifacts) ? artifacts : [];
  const dirty = list.filter((a) => a && a.dirty === true);
  const header = '実装成果は本 repo の worktree ではなく別リポジトリの working tree に存在する'
    + '（cross-repo issue）。以下のファイルを手動で commit / PR 化すること。'
    + '放置すると成果物が失われる。';
  if (dirty.length === 0) {
    return `${header}\n対象リポジトリ: なし（成果物は検出されなかった）`;
  }
  const lines = dirty.map((a) => {
    const p = typeof a.path === 'string' && a.path !== '' ? a.path : '(path 不明)';
    return `- ${p} (repo_root: ${a.repo_root})`;
  });
  return `${header}\n${lines.join('\n')}\n列挙されたファイルのみを stage すること（git add -A は使わない）。`;
}
