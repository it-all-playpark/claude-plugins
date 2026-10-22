// classifySecurityReviewTarget: 変更が信頼境界をまたぐか（pr-iterate の security review の対象か）を unified diff から
// 決定論で判定する純関数（issue #1063）。LLM に対象かどうかを判定させない — 入力は realized diff だけ。
//
// 呼び出し口は CLI `_lib/scripts/security-review-target.mjs` の 1 つで、dev-flow の Security floor
// （`_shared/scripts/secfloor-classify.sh` の secreview。realized diff = HEAD からの working tree 差分 + untracked）と
// 単体 /pr-iterate の preflight（`_shared/scripts/pr-iterate-prerun.sh` の security_review。PR の base...head の差分）が
// 同じ判定を通る。workflow へは inline しない（workflow は判定結果だけを受け取る）。
//
// 規則（どれか 1 つでも当たれば対象）:
//   - permission_config（パス）: sandbox の外で動く入口・権限の設定そのもの — `.claude/settings*.json`、plugin の
//     `hooks/`（hooks.json と hook script。harness が sandbox の外で起動する）、`.githooks/` / `.husky/`
//   - sandbox_boundary（追加行）: sandbox / 権限設定のキー（excludedCommands 等）に触れるコード。sandbox の外で
//     動かす入口を足す・広げる変更（#1058 の `meeting set-names` はこれ）
//   - path_write（追加行）: ファイルを書く・開いて書き換える・リンクを作る API。書き込み先のパスが sandbox から
//     書ける入力（cwd・設定・議事録の frontmatter 等）で決まると、sandbox の外の権限で任意の場所を書ける
// docs（.md / .mdx / .txt / .rst、docs/ 配下）とテスト（*.test.* / *.spec.* / .bats / tests/ 配下等）にはどの規則も
// 当てない — どちらも sandbox の外で実行される入口ではない。docs だけ・テストだけの diff は対象外。
// 過検出（mktemp 先への書き込み等）は security review 1 段の所要時間で済み、見逃しは sandbox 脱出の出荷になるため、
// 規則は広めに取る（blast-radius）。
//
// 返り値: { target: boolean, reasons: string[] }。reasons は `<規則>: <path>` を重複なしで最大 SECURITY_REVIEW_REASONS_MAX 件
// （security review の prompt に「どこが境界をまたぐか」の手がかりとして渡す）。

export const SECURITY_REVIEW_REASONS_MAX = 20;

const PERMISSION_CONFIG_PATH_RE = /(^|\/)\.claude\/settings(\.[^/]*)?\.json$|(^|\/)hooks\/|(^|\/)\.githooks\/|(^|\/)\.husky\//;

const SANDBOX_BOUNDARY_RE = /\b(excludedCommands|dangerouslyDisableSandbox|allowWrite|denyWrite|allowRead|denyRead|allowUnixSockets|allowAllUnixSockets|allowedDomains|allowMachLookup|bypassPermissions)\b/;

const PATH_WRITE_RES = [
  // Python: os の書き込み・リンク系、書き込みモードの open()、Path.write_*、shutil の copy / move
  /\bos\.(open|rename|replace|link|symlink|unlink|remove|chmod|chown|truncate)\s*\(/,
  /\bopen\s*\([^)]*['"][rwax]?b?\+?[wax+]b?['"]/,
  /\.write_(text|bytes)\s*\(/,
  /\bshutil\.(copy\w*|move)\s*\(/,
  // Node: fs の書き込み・リンク系
  /\b(writeFileSync|appendFileSync|createWriteStream|copyFileSync|renameSync|symlinkSync|linkSync|unlinkSync|rmSync|chmodSync|truncateSync)\s*\(/,
  /\bfs(\.promises)?\.(writeFile|appendFile|copyFile|rename|symlink|link|unlink|rm|chmod|truncate)\s*\(/,
  // shell: 変数で決まるパスへのリダイレクト・tee・cp / mv / ln
  /(^|[^<>&0-9=-])>>?\s*"?\$\{?[A-Za-z_]/,
  /\b(tee|cp|mv|ln)\s[^#\n]*"?\$\{?[A-Za-z_]/,
];

const DOC_PATH_RE = /\.(md|mdx|txt|rst)$|(^|\/)docs\//i;
const TEST_PATH_RE = /(^|\/|\.|_)(test|spec)s?([./_]|$)|\.bats$|(^|\/)tests?\/|(^|\/)test-fixtures\//i;

function isDocOrTestPath(path) {
  return DOC_PATH_RE.test(path) || TEST_PATH_RE.test(path);
}

// unified diff を file ごとの { path, added: string[] } に分ける。path は新しい側（`+++ b/<path>`）、削除された
// file は `diff --git a/<path> b/<path>` の b 側。`git diff --no-index /dev/null <file>` の新規 file も同じ形。
function splitDiff(diffText) {
  const files = [];
  let cur = null;
  for (const line of String(diffText ?? '').split('\n')) {
    const head = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (head) {
      cur = { path: head[2], added: [] };
      files.push(cur);
      continue;
    }
    if (cur == null) continue;
    if (line.startsWith('+++ ')) {
      const m = /^\+\+\+ b\/(.+)$/.exec(line);
      if (m) cur.path = m[1];
      continue;
    }
    if (line.startsWith('--- ')) continue;
    if (line.startsWith('+')) cur.added.push(line.slice(1));
  }
  return files;
}

export function classifySecurityReviewTarget(diffText) {
  const reasons = [];
  const push = (rule, path) => {
    const r = `${rule}: ${path}`;
    if (!reasons.includes(r)) reasons.push(r);
  };
  for (const { path, added } of splitDiff(diffText)) {
    if (isDocOrTestPath(path)) continue;
    if (PERMISSION_CONFIG_PATH_RE.test(path)) push('permission_config', path);
    if (added.some((l) => SANDBOX_BOUNDARY_RE.test(l))) push('sandbox_boundary', path);
    if (added.some((l) => PATH_WRITE_RES.some((re) => re.test(l)))) push('path_write', path);
  }
  return { target: reasons.length > 0, reasons: reasons.slice(0, SECURITY_REVIEW_REASONS_MAX) };
}
