// porcelain-verdict.test.mjs — pr-iterate の status 判定（_lib/porcelain-verdict.mjs）と bin/porcelain-verdict の CLI。
//   AC-1: 警告行・exit code・基準線（null / stage 済みの行）からの dirty・新規行・回収可否
//   AC-2: 回収の add コマンドの組み立て規則
//   AC-3: CLI が一時 git repo で基準線ファイルを書き、digest で検証して判定する（HEAD・index は変えない）
//   #1383: fix が追跡をやめて worktree に残したファイル（fix の前の HEAD で追跡されていた `??` 行）は新規行・回収に数えない

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { leftoverAddCommand, porcelainLines, porcelainVerdict, PORCELAIN_BASELINE_DIR } from './porcelain-verdict.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, '..', 'bin', 'porcelain-verdict');

const ENV_FILE = '?? .worktreeinclude';
const ADD = 'git --literal-pathspecs add --ignore-removal -- ';
const verdict = (lines, baseline, extra = {}) => porcelainVerdict({ output: `${lines.join('\n')}\n`, exitCode: 0, baseline, ...extra });

// ---- AC-1: 判定 ----

test('[AC-1] 警告行（`x: Operation not permitted`・`warning:` 始まり）しか無い出力は clean', () => {
  const output = '.env.example: Operation not permitted\nwarning: could not open directory \'secret/\': Operation not permitted\n';
  for (const baseline of [[], null]) {
    const v = porcelainVerdict({ output, exitCode: 0, baseline });
    assert.equal(v.dirty, false, JSON.stringify(v));
    assert.deepEqual(v.new_lines, []);
  }
});

test('[AC-1] exit 非0 は porcelain 行が無くても dirty で、回収しない', () => {
  const v = porcelainVerdict({ output: 'fatal: not a git repository\n', exitCode: 128, baseline: [] });
  assert.equal(v.dirty, true);
  assert.equal(v.recoverable, false);
  assert.equal(v.add_command, null);
  assert.equal(v.exit_code, 128);
});

test('[AC-1] 基準線の行だけなら clean（警告行が混ざっても）。基準線に無い行が 1 行でもあれば dirty', () => {
  const baseline = [ENV_FILE, ' D kept.txt'];
  const clean = porcelainVerdict({ output: `${ENV_FILE}\nx: Operation not permitted\n D kept.txt\n`, exitCode: 0, baseline });
  assert.deepEqual([clean.dirty, clean.new_lines, clean.baseline, clean.recoverable], [false, [], 'ok', true]);
  const dirty = verdict([ENV_FILE, ' D kept.txt', ' M a.ts'], baseline);
  assert.deepEqual([dirty.dirty, dirty.new_lines], [true, [' M a.ts']]);
});

test('[AC-1] 基準線が null なら全 porcelain 行が新規行で、回収不可（add コマンドを出さない）', () => {
  const v = verdict([ENV_FILE, ' M a.ts'], null);
  assert.deepEqual(v.new_lines, [ENV_FILE, ' M a.ts']);
  assert.equal(v.baseline, 'none');
  assert.equal(v.dirty, true);
  assert.equal(v.recoverable, false);
  assert.equal(v.add_command, null);
  assert.equal(verdict([], null).dirty, false, '基準線が null でも porcelain 行が無ければ clean');
});

test('[AC-1] 基準線に stage 済みの行（1 文字目が空白・?・! 以外）があれば回収不可', () => {
  for (const staged of ['A  secret.env', 'M  a.ts', 'MM a.ts', 'D  gone.ts', 'R  old -> new']) {
    const v = verdict([staged, ' M b.ts'], [staged]);
    assert.equal(v.recoverable, false, `${staged}: ${JSON.stringify(v)}`);
    assert.equal(v.add_command, null, staged);
    assert.equal(v.dirty, true, staged);
  }
  for (const unstaged of [' M a.ts', ' D kept.txt', ENV_FILE, '!! ignored']) {
    assert.equal(verdict([unstaged, ' M b.ts'], [unstaged]).recoverable, true, unstaged);
  }
});

test('[AC-1] 基準線ファイルの不一致（mismatch）は基準線 null として扱い、porcelain 行が無くても dirty・回収不可', () => {
  const v = verdict([ENV_FILE], [ENV_FILE], { mismatch: true });
  assert.deepEqual([v.baseline, v.dirty, v.recoverable, v.add_command, v.new_lines], ['mismatch', true, false, null, [ENV_FILE]]);
  assert.equal(verdict([], [], { mismatch: true }).dirty, true);
});

test('[#1383 AC-5] untrackedByFix に入るパスの `??` 行は新規行・dirty・add から外れる（空なら外さない。`??` 以外の行と基準線なし・mismatch は外さない）', () => {
  const lines = [ENV_FILE, '?? pnpm-lock.yaml', '?? "\\346\\227\\245\\346\\234\\254.md"'];
  const untrackedByFix = new Set(['pnpm-lock.yaml', '日本.md']);
  const dropped = verdict(lines, [ENV_FILE], { untrackedByFix });
  assert.deepEqual([dropped.dirty, dropped.new_lines, dropped.add_command, dropped.recoverable], [false, [], null, true]);

  const empty = verdict(lines, [ENV_FILE], { untrackedByFix: new Set() });
  assert.deepEqual(empty, verdict(lines, [ENV_FILE]), '集合が空なら引数なしと同じ結果');
  assert.deepEqual([empty.dirty, empty.new_lines], [true, lines.slice(1)]);

  const mixed = verdict(['D  pnpm-lock.yaml', '?? pnpm-lock.yaml', ' M a.ts', '?? new.md'], [], { untrackedByFix: new Set(['pnpm-lock.yaml', 'a.ts']) });
  assert.deepEqual(mixed.new_lines, ['D  pnpm-lock.yaml', ' M a.ts', '?? new.md']);
  assert.equal(mixed.add_command, `${ADD}'a.ts' 'new.md'`);

  for (const extra of [{ baseline: null }, { mismatch: true }]) {
    const v = porcelainVerdict({ output: '?? pnpm-lock.yaml\n', exitCode: 0, baseline: [], untrackedByFix, ...extra });
    assert.deepEqual([v.dirty, v.new_lines], [true, ['?? pnpm-lock.yaml']], JSON.stringify(extra));
  }
});

test('[AC-3 (b)] 基準線ファイルの行は porcelain 行に数えない', () => {
  assert.deepEqual(porcelainLines(`?? ${PORCELAIN_BASELINE_DIR}/${'a'.repeat(64)}\n M a.ts\n`), [' M a.ts']);
});

// ---- AC-2: add コマンド ----

test('[AC-2] 未 stage の変更・未追跡ファイルを単一引用符の引数で `git --literal-pathspecs add --ignore-removal --` に並べる', () => {
  assert.equal(leftoverAddCommand([' M a.ts', '?? new.md', 'AM b.ts', ' D gone.ts']), `${ADD}'a.ts' 'new.md' 'b.ts' 'gone.ts'`);
  assert.equal(leftoverAddCommand(["?? it's.md", '?? $(touch pwned).md', '?? :!x.md']), `${ADD}'it'\\''s.md' '$(touch pwned).md' ':!x.md'`);
});

test('[AC-2] 2 文字目が空白の行（stage 済み）・rename / copy の行・`/` で終わるパスは並べない', () => {
  assert.equal(leftoverAddCommand(['M  staged.ts', 'A  added.ts', 'RM old -> "x -> secret.env"', 'C  a -> b', ' R x -> y', '?? d/']), null);
  assert.equal(leftoverAddCommand(['RM old -> new', '?? d/', ' M fixed.txt']), `${ADD}'fixed.txt'`);
});

test('[AC-2] C 引用パスは戻してから単一引用符で囲む。戻せない C 引用パスと制御文字・backtick を含むパスは並べない', () => {
  assert.equal(leftoverAddCommand(['?? "\\346\\227\\245\\346\\234\\254 \\350\\252\\236.md"']), `${ADD}'日本 語.md'`);
  assert.equal(leftoverAddCommand(['?? "a\\"b.md"']), `${ADD}'a"b.md'`);
  for (const bad of ['?? "a\\tb.md"', '?? "a\\nb.md"', '?? "bad\\q.md"', '?? "unterminated', '?? "a"b".md"', '?? a`b`.md']) {
    assert.equal(leftoverAddCommand([bad]), null, bad);
  }
});

test('[AC-2] 並べるパスが無ければ add しない（null）。基準線の行は判定で新規行から外れ、add に並ばない', () => {
  assert.equal(leftoverAddCommand([]), null);
  const v = verdict(['?? secret.env', ' M fixed.txt'], ['?? secret.env']);
  assert.equal(v.add_command, `${ADD}'fixed.txt'`);
  assert.equal(verdict(['?? secret.env'], ['?? secret.env']).add_command, null);
});

// ---- AC-3: CLI（一時 git repo） ----

function withRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'porcelain-verdict-'));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' });
  const cli = (...args) => JSON.parse(execFileSync('bash', [BIN, ...args], { cwd: dir, env, encoding: 'utf8' }));
  try {
    git('init', '-q');
    git('config', 'user.name', 't');
    git('config', 'user.email', 't@example.com');
    writeFileSync(join(dir, 'kept.txt'), 'kept\n');
    writeFileSync(join(dir, 'fixed.txt'), 'before\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    return fn({ dir, git, cli });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** fix の前の状態（環境が置く未追跡ファイル・部分 checkout の未 stage の削除）を作って基準線を取る。 */
function takeBaseline({ dir, cli }) {
  writeFileSync(join(dir, '.worktreeinclude'), 'env\n');
  unlinkSync(join(dir, 'kept.txt'));
  const b = cli('baseline');
  assert.equal(b.exit_code, 0);
  assert.match(b.baseline_digest, /^[0-9a-f]{64}$/);
  const file = join(dir, PORCELAIN_BASELINE_DIR, b.baseline_digest);
  assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'), b.baseline_digest, 'baseline_digest は基準線ファイルの内容の sha256');
  return { digest: b.baseline_digest, file };
}

test('[AC-3 (a)] 基準線を取ったあとで fix 相当の変更を足すと、新規行だけが出て回収の add に並ぶ', () => withRepo((repo) => {
  const { digest } = takeBaseline(repo);
  writeFileSync(join(repo.dir, 'fixed.txt'), 'after\n');
  writeFileSync(join(repo.dir, 'added.txt'), 'new\n');
  const v = repo.cli('check', digest);
  assert.equal(v.baseline, 'ok');
  assert.deepEqual(new Set(v.new_lines), new Set([' M fixed.txt', '?? added.txt']));
  assert.equal(v.dirty, true);
  assert.equal(v.recoverable, true);
  assert.deepEqual(v.add_command.slice(ADD.length).split(' ').sort(), ["'added.txt'", "'fixed.txt'"]);
}));

test('[AC-3 (b)] 基準線ファイル自体は porcelain 行に数えない（fix の変更が無ければ clean）', () => withRepo((repo) => {
  const { digest } = takeBaseline(repo);
  const raw = repo.git('status', '--porcelain', '--untracked-files=all');
  assert.ok(raw.includes(`?? ${PORCELAIN_BASELINE_DIR}/${digest}`), `基準線ファイルは git status には出る: ${raw}`);
  const v = repo.cli('check', digest);
  assert.deepEqual([v.dirty, v.new_lines], [false, []], JSON.stringify(v));
  assert.equal(repo.cli('baseline').baseline_digest, digest, '基準線ファイルがあっても基準線の行は変わらない');
}));

test('[AC-3 (c)] baseline・check の実行の前後で HEAD と index が変わらない', () => withRepo((repo) => {
  writeFileSync(join(repo.dir, 'fixed.txt'), 'staged\n');
  repo.git('add', 'fixed.txt');
  writeFileSync(join(repo.dir, 'fixed.txt'), 'unstaged\n');
  const index = join(repo.dir, '.git', 'index');
  const head = repo.git('rev-parse', 'HEAD');
  const before = readFileSync(index);
  const { digest } = takeBaseline(repo);
  writeFileSync(join(repo.dir, 'added.txt'), 'new\n');
  const v = repo.cli('check', digest);
  repo.cli('check');
  assert.equal(v.recoverable, false, '基準線に stage 済みの行（MM fixed.txt）がある');
  assert.equal(repo.git('rev-parse', 'HEAD'), head);
  assert.deepEqual(readFileSync(index), before, 'index が書き換えられた');
  assert.equal(existsSync(join(repo.dir, '.git', 'index.lock')), false);
}));

test('[AC-3 (d)] 基準線を取ったあとで基準線ファイルに新規行を書き足すと、その行は基準線として扱われず dirty・回収不可', () => withRepo((repo) => {
  const { digest, file } = takeBaseline(repo);
  writeFileSync(join(repo.dir, 'added.txt'), 'new\n');
  appendFileSync(file, '?? added.txt\n');
  const v = repo.cli('check', digest);
  assert.equal(v.baseline, 'mismatch');
  assert.ok(v.new_lines.includes('?? added.txt'), JSON.stringify(v));
  assert.deepEqual([v.dirty, v.recoverable, v.add_command], [true, false, null]);
}));

test('[AC-3 (e)] 基準線ファイルを消しても dirty・回収不可', () => withRepo((repo) => {
  const { digest, file } = takeBaseline(repo);
  unlinkSync(file);
  const v = repo.cli('check', digest);
  assert.deepEqual([v.baseline, v.dirty, v.recoverable, v.add_command], ['mismatch', true, false, null]);
  assert.deepEqual(new Set(v.new_lines), new Set([ENV_FILE, ' D kept.txt']));
}));

// ---- #1383: fix が追跡をやめて worktree に残したファイル ----

test('[#1383 AC-1] 基準線のあとで追跡解除を commit して worktree に残したファイルは、新規行・add に入らず clean', () => withRepo((repo) => {
  const { digest } = takeBaseline(repo);
  repo.git('rm', '-q', '--cached', 'fixed.txt');
  repo.git('commit', '-q', '-m', 'untrack fixed.txt');
  assert.ok(repo.git('status', '--porcelain', '--untracked-files=all').includes('?? fixed.txt'), 'fixed.txt は worktree に未追跡で残る');
  const v = repo.cli('check', digest);
  assert.deepEqual([v.baseline, v.dirty, v.new_lines, v.add_command], ['ok', false, [], null], JSON.stringify(v));
}));

test('[#1383 AC-2] 未 commit の追跡解除は `D  p` だけが新規行で `?? p` を add しない。commit すると clean', () => withRepo((repo) => {
  const { digest } = takeBaseline(repo);
  repo.git('rm', '-q', '--cached', 'fixed.txt');
  const v = repo.cli('check', digest);
  assert.deepEqual([v.baseline, v.dirty, v.new_lines, v.add_command], ['ok', true, ['D  fixed.txt'], null], JSON.stringify(v));
  repo.git('commit', '-q', '-m', 'untrack fixed.txt');
  const after = repo.cli('check', digest);
  assert.deepEqual([after.dirty, after.new_lines], [false, []], JSON.stringify(after));
}));

test('[#1383 AC-3] 基準線の HEAD でも追跡されていなかった未追跡ファイルは、追跡解除と並んでも新規行・add に入り dirty', () => withRepo((repo) => {
  const { digest } = takeBaseline(repo);
  repo.git('rm', '-q', '--cached', 'fixed.txt');
  repo.git('commit', '-q', '-m', 'untrack fixed.txt');
  writeFileSync(join(repo.dir, 'added.txt'), 'new\n');
  const v = repo.cli('check', digest);
  assert.deepEqual([v.baseline, v.dirty, v.recoverable, v.new_lines, v.add_command], ['ok', true, true, ['?? added.txt'], `${ADD}'added.txt'`], JSON.stringify(v));
}));

test('[#1383 AC-4] 基準線ファイルの HEAD の sha を書き換えると mismatch。HEAD の sha を持たない基準線ファイルも digest が合っていても mismatch', () => withRepo((repo) => {
  const { digest, file } = takeBaseline(repo);
  const head = repo.git('rev-parse', 'HEAD').trim();
  const content = readFileSync(file, 'utf8');
  assert.ok(content.startsWith(`HEAD ${head}\n`), `基準線ファイルの 1 行目は fix の前の HEAD: ${content}`);
  repo.git('rm', '-q', '--cached', 'fixed.txt');
  repo.git('commit', '-q', '-m', 'untrack fixed.txt');

  // 追跡解除の commit の sha に書き換える（その HEAD では fixed.txt は追跡されていない）
  writeFileSync(file, content.replace(head, repo.git('rev-parse', 'HEAD').trim()));
  const tampered = repo.cli('check', digest);
  assert.deepEqual([tampered.baseline, tampered.dirty, tampered.recoverable, tampered.add_command], ['mismatch', true, false, null], JSON.stringify(tampered));

  const headless = content.slice(content.indexOf('\n') + 1);
  const headlessDigest = createHash('sha256').update(headless).digest('hex');
  writeFileSync(join(repo.dir, PORCELAIN_BASELINE_DIR, headlessDigest), headless);
  const old = repo.cli('check', headlessDigest);
  assert.deepEqual([old.baseline, old.dirty, old.recoverable, old.add_command], ['mismatch', true, false, null], JSON.stringify(old));
}));

/** porcelain 行の無い基準線ファイルの内容と digest（今の HEAD）。 */
function emptyBaseline(repo) {
  const content = `HEAD ${repo.git('rev-parse', 'HEAD').trim()}\n`;
  return { content, digest: createHash('sha256').update(content).digest('hex') };
}

test('[AC-3] PR が基準線のパスに追跡させた symlink の先へは書かない（symlink 自体を基準線ファイルで置き換える）', () => withRepo((repo) => {
  const outside = mkdtempSync(join(tmpdir(), 'porcelain-verdict-outside-'));
  try {
    const target = join(outside, 'settings.json');
    writeFileSync(target, '{"keep":true}\n');
    mkdirSync(join(repo.dir, PORCELAIN_BASELINE_DIR), { recursive: true });
    // digest は HEAD の sha を含むので、symlink は commit せず index に載せる（基準線のパスの行は porcelain 行に数えない）
    const { digest: EMPTY_DIGEST } = emptyBaseline(repo);
    const link = join(repo.dir, PORCELAIN_BASELINE_DIR, EMPTY_DIGEST);
    symlinkSync(target, link);
    repo.git('add', '-A');
    const b = repo.cli('baseline');
    assert.equal(b.baseline_digest, EMPTY_DIGEST);
    assert.equal(readFileSync(target, 'utf8'), '{"keep":true}\n', 'symlink の先が書き換えられた');
    assert.equal(lstatSync(link).isSymbolicLink(), false);
    assert.equal(repo.cli('check', EMPTY_DIGEST).baseline, 'ok');
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
}));

test('[AC-3] 基準線のディレクトリが symlink なら書かず・読まず、基準線 null（mismatch）になる', () => withRepo((repo) => {
  const outside = mkdtempSync(join(tmpdir(), 'porcelain-verdict-outside-'));
  try {
    mkdirSync(join(repo.dir, '.devflow-tmp'));
    symlinkSync(outside, join(repo.dir, PORCELAIN_BASELINE_DIR));
    assert.equal(repo.cli('baseline').baseline_digest, null);
    assert.deepEqual(readdirSync(outside), [], 'symlink の先に基準線ファイルが作られた');
    const { content, digest } = emptyBaseline(repo);
    writeFileSync(join(outside, digest), content);
    assert.equal(repo.cli('check', digest).baseline, 'mismatch');
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
}));

test('[AC-3] digest を渡さない check は基準線 null（全 porcelain 行が新規行・回収不可）。digest の形でない引数は mismatch', () => withRepo((repo) => {
  takeBaseline(repo);
  const none = repo.cli('check');
  assert.deepEqual([none.baseline, none.dirty, none.recoverable], ['none', true, false]);
  assert.deepEqual(new Set(none.new_lines), new Set([ENV_FILE, ' D kept.txt']));
  assert.equal(repo.cli('check', `../${PORCELAIN_BASELINE_DIR}`).baseline, 'mismatch');
}));
