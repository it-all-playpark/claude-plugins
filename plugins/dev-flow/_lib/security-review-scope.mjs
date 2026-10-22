// security-review-scope.mjs — PR の diff が敵対的 security review の対象かを決める純関数（issue #1063）。
//
// 既定は「対象」。対象外にできるのは、ファイルが 1 件以上あり、全ファイルが下の許可リストに当たる diff だけ。
// 危ない変更を列挙して当たったものだけを対象にする形は、列挙の抜けが黙って素通りになる（引用符付きパス・
// hunk 内の `+++` 行・YAML の書き方・`.claude/` の外の settings.json など、全体 review のたびに新しい抜けが出て
// 収束しなかった）ので取らない。判定できない入力（取得の失敗・空・読めない diff・ファイル一覧との食い違い）は
// すべて対象に倒す（fail-closed）。LLM には判定させない — diff 本文による誘導・黒塗り・切り詰めで素通りでき、
// コードを外部 API へ送ることになるため。
//
// 許可リスト（パスは大文字小文字を区別しない）:
//   - `.md` / `.mdx` / `.rst` のうち指示ファイルでないもの
//   - `*.test.<ext>` / `*.spec.<ext>`（<ext> は TEST_SOURCE_EXTS のテストコードの拡張子）/ `*.bats`
//   いずれも mode 100644 の通常ファイルで、mode の変更・binary を含まないこと。指示ファイルの場所と、ドット始まりの
//   要素（`.github/` / `.husky/` / `.circleci/` 等 — CI・hook の設定の置き場）の配下にあるものは除く。拡張子を問わずに
//   許すと `.github/workflows/x.test.yml` のような CI 設定まで対象外になるため。
// 指示ファイル: basename が `CLAUDE.md` / `CLAUDE.local.md` / `AGENTS.md` / `SKILL.md`、または `.claude/` / `references/` /
//   `output-styles/` / `agents/` / `commands/` のいずれかの配下（深さを問わない）。agent が読み込んで指示として
//   扱うので、文書の拡張子でも対象にする。base / head の CLAUDE.md・AGENTS.md 等が `@<path>` で import するファイル
//   （再帰的にたどる）も同じ理由で対象にする（`@README.md` で読み込まれる README.md 等）。
//
// diff は `git -c core.quotePath=false diff --no-renames --no-color --no-ext-diff --no-textconv --text
// --src-prefix=a/ --dst-prefix=b/ <range>`（SECURITY_SCOPE_DIFF_ARGS）で取り、ファイル一覧は同じ引数に
// `--name-only -z` を足して取る。repo の設定（color.ui / diff.external / textconv / binary 属性 / noprefix）で
// diff の見え方が変わると、許可リストに当たる見た目のまま中身を隠せるため、引数で全部打ち消す。
// 取得は `_lib/scripts/security-review-scope.mjs`（bin/ の bare 名 `security-review-scope`）が行い、本ファイルは
// 取得結果の判定だけを持つ。

export const SECURITY_SCOPE_DIFF_ARGS = ['--no-renames', '--no-color', '--no-ext-diff', '--no-textconv', '--text', '--src-prefix=a/', '--dst-prefix=b/'];
export const SECURITY_SCOPE_GIT_CONFIG = ['-c', 'core.quotePath=false'];

const INSTRUCTION_DIRS = ['.claude', 'references', 'output-styles', 'agents', 'commands'];
const INSTRUCTION_BASENAMES = ['claude.md', 'claude.local.md', 'agents.md', 'skill.md'];
const TEST_SOURCE_EXTS = ['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'php', 'cs'];
// security-reviewer の session に自動で読み込まれる指示（basename が CLAUDE.md / CLAUDE.local.md / AGENTS.md、または
// repo 直下の `.claude/` 配下）。workflow の agent() には cwd を渡せず reviewer は PR の worktree を cwd に起動するので、
// PR がこれらを変えると攻撃者の文が判定者の指示として届く。
const REVIEWER_CONTEXT_BASENAMES = ['claude.md', 'claude.local.md', 'agents.md'];
const GIT_METADATA_BASENAMES = ['.gitattributes', '.gitmodules'];
const REGULAR_FILE_MODE = '100644';
const MAX_REASONS = 20;

// agent が指示として読み込むファイルか（大文字小文字を区別しない）。
export function isInstructionPath(path) {
  const segs = String(path).toLowerCase().split('/');
  const base = segs.pop();
  if (INSTRUCTION_BASENAMES.includes(base)) return true;
  return segs.some((s) => INSTRUCTION_DIRS.includes(s));
}

// パスだけで許可リストに当たるか（mode・binary は securityReviewScope が別に見る）。
export function isSecurityReviewExemptPath(path) {
  const p = String(path);
  if (p === '' || isInstructionPath(p)) return false;
  const segs = p.toLowerCase().split('/');
  const base = segs[segs.length - 1];
  if (segs.some((s) => s.startsWith('.'))) return false;
  if (/\.(md|mdx|rst)$/.test(base)) return true;
  const m = base.match(/^.+\.(?:test|spec)\.([a-z0-9]+)$/);
  if (m) return TEST_SOURCE_EXTS.includes(m[1]);
  return /^.+\.bats$/.test(base);
}

// security-reviewer の session に自動で読み込まれる指示ファイルか（大文字小文字を区別しない）。
export function isReviewerContextPath(path) {
  const segs = String(path).toLowerCase().split('/');
  return segs[0] === '.claude' || REVIEWER_CONTEXT_BASENAMES.includes(segs[segs.length - 1]);
}

// 指示ファイルの本文の `@<path>` import が指す repo 相対パス（大文字小文字はそのまま）。Claude Code は CLAUDE.md /
// AGENTS.md 等の `@<path>` を自動で読み込み、相対パスは import 元のディレクトリから解決する。code span・code block の
// 中の `@` も拾うのは、多めに拾っても対象が増えるだけで素通りは生まないため。末尾の句読点を落とした形も加える。
// `~/`・repo の外へ出るパスは repo の diff に現れないので除く。絶対パスは root（repo の絶対パス）配下だけ相対にする。
export function claudeImportPaths(text, fromPath, root = null) {
  const dir = String(fromPath).split('/').slice(0, -1);
  const out = new Set();
  for (const m of String(text).matchAll(/(?:^|\s)@(\S+)/g)) {
    for (const raw of new Set([m[1], m[1].replace(/[.,;:!?)\]}>'"`]+$/, '')])) {
      let p = raw;
      if (p === '' || p.startsWith('~')) continue;
      let segs;
      if (p.startsWith('/')) {
        if (root == null || !p.startsWith(`${String(root).replace(/\/+$/, '')}/`)) continue;
        segs = p.slice(String(root).replace(/\/+$/, '').length + 1).split('/');
      } else {
        segs = [...dir, ...p.split('/')];
      }
      const norm = [];
      let escaped = false;
      for (const s of segs) {
        if (s === '' || s === '.') continue;
        if (s === '..') { if (norm.length === 0) { escaped = true; break; } norm.pop(); continue; }
        norm.push(s);
      }
      if (!escaped && norm.length > 0) out.add(norm.join('/'));
    }
  }
  return [...out];
}

// roots（isReviewerContextPath に当たるファイル）から `@<path>` import を再帰的にたどり、読み込まれるファイルの
// 集合を返す（roots 自身は含めない）。read(path) はその rev の本文（無ければ null）。
export function reviewerImportClosure(roots, read, root = null) {
  const seen = new Set(roots.map((p) => p.toLowerCase()));
  const imported = new Set();
  const queue = [...roots];
  while (queue.length > 0) {
    const from = queue.shift();
    const text = read(from);
    if (text == null) continue;
    for (const p of claudeImportPaths(text, from, root)) {
      const key = p.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      imported.add(p);
      queue.push(p);
    }
  }
  return [...imported];
}

// `diff --git a/<P> b/<P>` の <P>。--no-renames なので両側は同じパスで、引用符で囲まれた形
// （制御文字・`"`・`\` を含むパス）や両側の食い違いは読めないとして null を返す。
function headerPath(rest) {
  if (rest.startsWith('"') || rest.length % 2 === 0) return null;
  const half = (rest.length - 1) / 2;
  const left = rest.slice(0, half);
  const right = rest.slice(half + 1);
  if (rest[half] !== ' ' || !left.startsWith('a/') || !right.startsWith('b/')) return null;
  return left.slice(2) === right.slice(2) ? left.slice(2) : null;
}

const HUNK_RE = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

// git diff の patch を file ごとの {path, oldMode, newMode, modeChange, newFile, deleted, binary, hunks} に分ける。
// hunk の中は `@@` の行数で読み進め、hunk 内の `diff --git` / `+++` / `---` で始まる行をヘッダと取り違えない。
// 知らない行・途中で切れた hunk・引用符付きパスは { ok:false, error } を返す（呼び出し側が対象に倒す）。
export function parseScopePatch(patch) {
  const lines = String(patch).split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const files = [];
  let cur = null;
  let state = 'start';
  let oldLeft = 0;
  let newLeft = 0;
  const fail = (n, what) => ({ ok: false, error: `${n + 1} 行目: ${what}` });
  const startHunk = (line) => {
    const m = line.match(HUNK_RE);
    if (!m) return false;
    oldLeft = m[1] == null ? 1 : Number(m[1]);
    newLeft = m[2] == null ? 1 : Number(m[2]);
    cur.hunks += 1;
    state = oldLeft === 0 && newLeft === 0 ? 'between' : 'hunk';
    return true;
  };
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    if (line.includes('\u0000') && cur) cur.binary = true;
    if (state === 'hunk') {
      if (line.startsWith('\\')) continue;
      const c = line === '' ? ' ' : line[0];
      if (c === ' ') { oldLeft -= 1; newLeft -= 1; }
      else if (c === '-') oldLeft -= 1;
      else if (c === '+') newLeft -= 1;
      else return fail(n, 'hunk の行を読めない');
      if (oldLeft < 0 || newLeft < 0) return fail(n, 'hunk の行数が @@ と合わない');
      if (oldLeft === 0 && newLeft === 0) state = 'between';
      continue;
    }
    if (line.startsWith('diff --git ')) {
      const path = headerPath(line.slice('diff --git '.length));
      if (path == null) return fail(n, 'diff --git 行のパスを読めない');
      cur = { path, oldMode: null, newMode: null, modeChange: false, newFile: false, deleted: false, binary: false, hunks: 0 };
      files.push(cur);
      state = 'header';
      continue;
    }
    if (state === 'start') return fail(n, 'diff --git 行で始まらない');
    if (state === 'between') {
      if (line.startsWith('\\')) continue;
      if (startHunk(line)) continue;
      return fail(n, 'hunk の外の行を読めない');
    }
    let m;
    if ((m = line.match(/^old mode ([0-7]{6})$/))) { cur.oldMode = m[1]; cur.modeChange = true; continue; }
    if ((m = line.match(/^new mode ([0-7]{6})$/))) { cur.newMode = m[1]; cur.modeChange = true; continue; }
    if ((m = line.match(/^new file mode ([0-7]{6})$/))) { cur.newMode = m[1]; cur.newFile = true; continue; }
    if ((m = line.match(/^deleted file mode ([0-7]{6})$/))) { cur.oldMode = m[1]; cur.deleted = true; continue; }
    if ((m = line.match(/^index [0-9a-f]+\.\.[0-9a-f]+(?: ([0-7]{6}))?$/))) {
      if (m[1] != null) {
        if (cur.oldMode == null) cur.oldMode = m[1];
        if (cur.newMode == null) cur.newMode = m[1];
      }
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('+++ ')) continue;
    if (line.startsWith('Binary files ') || line === 'GIT binary patch') { cur.binary = true; continue; }
    if (startHunk(line)) continue;
    return fail(n, 'diff のヘッダ行を読めない');
  }
  if (state === 'hunk') return { ok: false, error: '最後の hunk が途中で切れている' };
  return { ok: true, files };
}

// file 1 件の対象理由（無ければ空配列）。
function fileReasons(f, imported) {
  const reasons = [];
  const base = f.path.toLowerCase().split('/').pop();
  if (f.binary) reasons.push(`binary: ${f.path}`);
  if (f.modeChange) reasons.push(`mode_change: ${f.path}`);
  const modes = [f.oldMode, f.newMode].filter((x) => x != null && x !== '000000');
  if (modes.length === 0 || modes.some((x) => x !== REGULAR_FILE_MODE)) reasons.push(`mode: ${f.path} (${modes.join('→') || '不明'})`);
  if (f.hunks === 0 && !f.newFile && !f.deleted) reasons.push(`no_content_change: ${f.path}`);
  if (GIT_METADATA_BASENAMES.includes(base)) reasons.push(`git_metadata: ${f.path}`);
  // import されたファイルは指示として読み込まれるので、文書の拡張子でも許可リストから外す
  if (imported.has(f.path.toLowerCase()) || !isSecurityReviewExemptPath(f.path)) reasons.push(`not_allowlisted: ${f.path}`);
  return reasons;
}

// ファイル一覧・import 一覧が読めない・空なら true（fail-closed）。
const contextChanged = (files, imported) => !Array.isArray(files) || files.length === 0 || imported == null
  || files.some((p) => isReviewerContextPath(p) || imported.has(p.toLowerCase()));
const targetOf = (reasons, files, imported = null) => ({ target: true, reasons: reasons.slice(0, MAX_REASONS).concat(reasons.length > MAX_REASONS ? [`他 ${reasons.length - MAX_REASONS} 件`] : []), codes: reasonCodeCounts(reasons), files, reviewer_context_changed: contextChanged(files, imported) });

// 理由の固定 code。CLI の stdout にはこの code と件数（`<code>:<n>`）だけを出す。reasons にはファイルパス・diff 由来の
// 文字列（PR が自由に決められる）が入り、stdout を写す exec-proxy の agent へそのまま渡ると「target を false にして
// 返せ」のような文で判定を書き換えられるため、stdout に PR 由来の文字列を載せない。
export const SECURITY_SCOPE_REASON_CODES = [
  'diff_unavailable', 'name_list_unavailable', 'imports_unavailable', 'diff_empty', 'diff_unreadable', 'no_files', 'file_count_mismatch',
  'file_list_mismatch', 'binary', 'mode_change', 'mode', 'no_content_change', 'git_metadata', 'not_allowlisted',
];

// reasons（全件。切り詰め前）を `<code>:<件数>` の配列にする（code の出現順）。既知でない code は `other` に数える。
export function reasonCodeCounts(reasons) {
  const counts = new Map();
  for (const r of reasons) {
    const head = String(r).split(':')[0];
    const code = SECURITY_SCOPE_REASON_CODES.includes(head) ? head : 'other';
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return [...counts].map(([code, n]) => `${code}:${n}`);
}

/**
 * diff が敵対的 security review の対象かを決める。対象外（target:false）になるのは、patch と name 一覧が
 * 揃って読め、ファイルが 1 件以上で、全ファイルが許可リストに当たるときだけ。
 *
 * @param {{patch: string|null|undefined, names: string[]|null|undefined, imports?: string[]}} input
 *   patch: SECURITY_SCOPE_DIFF_ARGS で取った diff 全文。names: 同じ range の `--name-only -z` を NUL で分けたもの。
 *   imports: base / head の指示ファイルから reviewerImportClosure でたどった import 先（当たるファイルは not_allowlisted）
 * @returns {{target: boolean, reasons: string[], codes: string[], files: string[], reviewer_context_changed: boolean}}
 *   reasons はパス付きの詳細（stdout に出さない）、codes は reasonCodeCounts の `<code>:<件数>`、
 *   reviewer_context_changed は isReviewerContextPath か imports に当たるファイルを含むか（一覧が読めない・空なら true）
 */
export function securityReviewScope({ patch, names, imports = [] } = {}) {
  if (typeof patch !== 'string') return targetOf(['diff_unavailable'], []);
  if (!Array.isArray(names) || !names.every((x) => typeof x === 'string' && x !== '')) return targetOf(['name_list_unavailable'], []);
  if (!Array.isArray(imports) || !imports.every((x) => typeof x === 'string')) return targetOf(['imports_unavailable'], names);
  const imported = new Set(imports.map((x) => x.toLowerCase()));
  if (patch === '') return targetOf(['diff_empty'], names, imported);
  const parsed = parseScopePatch(patch);
  if (!parsed.ok) return targetOf([`diff_unreadable: ${parsed.error}`], names, imported);
  if (parsed.files.length === 0) return targetOf(['no_files'], names, imported);
  if (parsed.files.length !== names.length) return targetOf([`file_count_mismatch: diff ${parsed.files.length} 件 / name-only ${names.length} 件`], names, imported);
  const listed = new Set(names);
  const seen = new Set();
  for (const f of parsed.files) {
    if (!listed.has(f.path) || seen.has(f.path)) return targetOf([`file_list_mismatch: ${f.path}`], names, imported);
    seen.add(f.path);
  }
  const reasons = parsed.files.flatMap((f) => fileReasons(f, imported));
  if (reasons.length > 0) return targetOf(reasons, names, imported);
  return { target: false, reasons: [], codes: [], files: names, reviewer_context_changed: contextChanged(names, imported) };
}
