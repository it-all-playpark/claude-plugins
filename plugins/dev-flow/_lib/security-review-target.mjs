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
//   - permission_config（agent / command / skill 定義）: `agents/*.md` / `commands/*.md` / `SKILL.md` のどの行の変更も
//     （frontmatter の権限キーかどうかを hunk から確定できないので fail-closed）
//   - unparsed_path: `diff --git` のヘッダからパスを読めない file（判定できない入力を対象外に倒さない）
// 上の 2 つの permission_config を除き、docs（.md / .mdx / .txt / .rst、docs/ 配下）とテスト（*.test.* / *.spec.* /
// .bats / tests/ 配下等）には規則を当てない — どちらも sandbox の外で実行される入口ではない。sandbox_boundary は
// 追加行と削除行の両方を見る（deny の削除も境界を広げる）。
// 過検出（mktemp 先への書き込み等）は security review 1 段の所要時間で済み、見逃しは sandbox 脱出の出荷になるため、
// 規則は広めに取る（blast-radius）。
//
// 返り値: { target: boolean, reasons: string[] }。reasons は `<規則>: <path>` を重複なしで最大 SECURITY_REVIEW_REASONS_MAX 件
// （security review の prompt に「どこが境界をまたぐか」の手がかりとして渡す）。

export const SECURITY_REVIEW_REASONS_MAX = 20;

const PERMISSION_CONFIG_PATH_RE = /(^|\/)\.claude\/settings(\.[^/]*)?\.json$|(^|\/)hooks\/|(^|\/)\.githooks\/|(^|\/)\.husky\/|(^|\/)\.mcp\.json$|(^|\/)\.claude-plugin\/plugin\.json$/;

const SANDBOX_BOUNDARY_RE = /\b(excludedCommands|dangerouslyDisableSandbox|allowWrite|denyWrite|allowRead|denyRead|allowUnixSockets|allowAllUnixSockets|allowedDomains|allowMachLookup|bypassPermissions|mcpServers)\b/;

const PATH_WRITE_RES = [
  // Python: os の書き込み・リンク系、書き込みモードの open()、Path.write_*、shutil の copy / move。
  // open の mode literal は同じ行のどこにあっても当てる（`open(os.path.join(d, n), "w")` の内側の `)` で止めない）
  /\bos\.(open|rename|replace|link|symlink|unlink|remove|chmod|chown|truncate)\s*\(/,
  /\bopen\s*\(.*['"][rwax]?b?\+?[wax+]b?['"]/,
  /\.write_(text|bytes)\s*\(/,
  /\bshutil\.(copy\w*|move)\s*\(/,
  // Node: fs の書き込み・リンク系
  /\b(writeFileSync|appendFileSync|createWriteStream|copyFileSync|cpSync|renameSync|symlinkSync|linkSync|unlinkSync|rmSync|mkdirSync|chmodSync|truncateSync)\s*\(/,
  // `fs.` の有無を問わない（node:fs/promises から import した素の `writeFile(...)` も当てる）
  /\b(writeFile|appendFile|copyFile|cp|rename|symlink|link|unlink|rm|mkdir|chmod|truncate)\s*\(/,
  // shell: 変数で決まるパスへのリダイレクト・tee・cp / mv / ln
  /(^|[^<>&0-9=-])>>?\s*"?\$\{?[A-Za-z_]/,
  /\b(tee|cp|mv|ln)\s[^#\n]*"?\$\{?[A-Za-z_]/,
];

// agent / command / skill の定義は .md でも、frontmatter で権限（使える tool・permission mode・起動する hook / MCP）を、
// 本文で tool を持つ agent への指示を決める。diff の hunk から frontmatter の範囲や YAML のキーを決定論で確定できない
// （途中から始まる hunk・コメント・quote されたキー・複数行の値）ので、どの行の変更も対象にする（fail-closed）
const PLUGIN_DEF_PATH_RE = /(^|\/)(agents|commands)\/[^/]+\.md$|(^|\/)SKILL\.md$/;

const DOC_PATH_RE = /\.(md|mdx|txt|rst)$|(^|\/)docs\//i;
// テストとして除外するのは名前・置き場所でテストと決まるものだけ。`scripts/test.sh` のような実行スクリプトは除外しない
const TEST_PATH_RE = /\.(test|spec)\.[^/]+$|\.bats$|(^|\/)(tests?|__tests__|test-fixtures)\//i;

function isDocOrTestPath(path) {
  return DOC_PATH_RE.test(path) || TEST_PATH_RE.test(path);
}

// git は core.quotePath（既定 true）で非 ASCII・制御文字を含むパスを `"b/\346\227\245.md"` の形に C-quote する。
// 8 進エスケープはバイト列なので UTF-8 として戻す。戻せなければ null（呼び出し側が対象に倒す）
function unquoteGitPath(s) {
  if (!s.startsWith('"')) return s;
  if (!/^"(?:[^"\\]|\\.)*"$/.test(s)) return null;
  const bytes = [];
  const enc = new TextEncoder();
  const body = s.slice(1, -1);
  const ESC = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') { bytes.push(...enc.encode(c)); continue; }
    const oct = /^[0-7]{3}/.exec(body.slice(i + 1));
    if (oct) { bytes.push(parseInt(oct[0], 8)); i += 3; continue; }
    const e = ESC[body[i + 1]];
    if (e == null) return null;
    bytes.push(e);
    i += 1;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    return null;
  }
}

// `diff --git` の b 側。quote されていれば末尾の `"b/..."` を、無ければ ` b/` 以降を取る
function headerPath(rest) {
  const quoted = /("(?:[^"\\]|\\.)*")$/.exec(rest);
  if (quoted) {
    const p = unquoteGitPath(quoted[1]);
    return p != null && p.startsWith('b/') ? p.slice(2) : null;
  }
  const m = /^a\/.+ b\/(.+)$/.exec(rest);
  return m ? m[1] : null;
}

// unified diff を file ごとの { path, added: string[], removed: string[] } に分ける。path は新しい側
// （`+++ b/<path>`）、削除された file は `diff --git a/<path> b/<path>` の b 側。`git diff --no-index /dev/null <file>`
// の新規 file も同じ形。読めないヘッダの file は path: null（判定できないので対象に倒す）。
// `--- ` / `+++ ` をヘッダとして読むのは `diff --git` から最初の `@@` までだけ。hunk の中は先頭 1 文字で分ける
// （`++ x` を足した行は diff 上 `+++ x` になる。ヘッダと読むと path が書き換わり、その行も判定から漏れる）
function splitDiff(diffText) {
  const files = [];
  let cur = null;
  let inHunk = false;
  for (const line of String(diffText ?? '').split('\n')) {
    if (line.startsWith('diff --git ')) {
      cur = { path: headerPath(line.slice('diff --git '.length)), raw: line, added: [], removed: [] };
      files.push(cur);
      inHunk = false;
      continue;
    }
    if (cur == null) continue;
    if (line.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    if (!inHunk) {
      if (line.startsWith('+++ ')) {
        const target = line.slice(4);
        if (target !== '/dev/null') {
          const p = unquoteGitPath(target);
          cur.path = p != null && p.startsWith('b/') ? p.slice(2) : null;
        }
      }
      continue;
    }
    if (line.startsWith('+')) cur.added.push(line.slice(1));
    else if (line.startsWith('-')) cur.removed.push(line.slice(1));
  }
  return files;
}

export function classifySecurityReviewTarget(diffText) {
  const reasons = [];
  const push = (rule, path) => {
    const r = `${rule}: ${path}`;
    if (!reasons.includes(r)) reasons.push(r);
  };
  for (const { path, raw, added, removed } of splitDiff(diffText)) {
    if (path == null) {
      push('unparsed_path', raw);
      continue;
    }
    const changed = [...added, ...removed];
    // 権限の設定は docs・テストの除外より先に見る（hooks/ 配下の .md・agents/*.md・SKILL.md）
    if (PERMISSION_CONFIG_PATH_RE.test(path) || PLUGIN_DEF_PATH_RE.test(path)) push('permission_config', path);
    if (isDocOrTestPath(path)) continue;
    // sandbox / 権限の設定は、足す変更だけでなく消す変更（deny を外す等）も境界を動かす
    if (changed.some((l) => SANDBOX_BOUNDARY_RE.test(l))) push('sandbox_boundary', path);
    if (added.some((l) => PATH_WRITE_RES.some((re) => re.test(l)))) push('path_write', path);
  }
  return { target: reasons.length > 0, reasons: reasons.slice(0, SECURITY_REVIEW_REASONS_MAX) };
}
