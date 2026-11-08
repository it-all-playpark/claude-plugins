#!/usr/bin/env node
// tools/sync-inlines.mjs
// Inline-sync generator: rewrites BEGIN/END inline marker zones in workflow files.
// Usage: node tools/sync-inlines.mjs [--write|--check] [--root <dir>]
//    or: node tools/sync-inlines.mjs --add <canonical> --into <workflow> --after <anchor> [--root <dir>]
//    or: node tools/sync-inlines.mjs --remove <canonical> --from <workflow> [--root <dir>]
//
// root は plugin root（`_lib/` と `.claude/workflows/` を直下に持つ dir）。既定は
// `<repo>/plugins/dev-flow`。
//
// Each inline region holds only the canonical's top-level declarations that its workflow
// references (directly from the hand-written part, or through other generated
// declarations), in canonical order — not the whole canonical. The Workflow script size
// limit applies per file, so an unused declaration costs bytes in every workflow it is in.
//
// Named exports (pure functions):
//   stripComments(src)              - remove JS comments for forbidden-token scanning
//   checkForbiddenTokens(src, lbl)  - error if import/require/Date.now/Math.random in code
//   dropComments(src)               - remove comments from generated code, literals intact
//   transformCanonical(src, lbl)    - strip 'export ' prefix, drop comments, normalize trailing newline
//   splitTopLevelStatements(src)    - split inline code into top-level statements + declared name
//   collectIdentifiers(src)         - identifier-shaped words, literals included
//   selectReferencedDecls(hand, regions)
//                                   - keep the statements reachable from the hand-written part
//   planInlineRegions(root, wf, src)
//                                   - body of every region of one workflow (generator + sync test)
//   scanMarkers(wfSrc, wfLabel)     - parse BEGIN/END markers, return [{source, beginLine, endLine}]
//   insertMarkerPair(wfSrc, source, anchor, wfLabel)
//                                   - insert a new BEGIN/END marker pair after a unique
//                                     literal anchor line; rejects anchors inside an
//                                     existing inline region (nested markers)
//   removeMarkerPair(wfSrc, source, wfLabel)
//                                   - remove an existing BEGIN/END marker pair (and its
//                                     body) for `source`; the mirror image of
//                                     insertMarkerPair. Throws if the region does not
//                                     exist (0 matches).
//   syncRepo(root, {write})         - orchestrate all workflow files

import { readFileSync, writeFileSync, readdirSync, existsSync, realpathSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const BEGIN_RE = /^\/\/ ==== BEGIN inline: (\S+) .*====$/;
const END_RE   = /^\/\/ ==== END inline: (\S+) ====$/;

// ─────────────────────────────────────────────────────────────────────────────
// stripComments(src): remove // line comments and /* */ block comments from JS source.
//
// Rules:
//   - String literals (', ", `) are traversed verbatim — // and /* inside are NOT stripped.
//   - Template literals: handled as string context up to the matching closing backtick.
//     ${ } expressions inside template literals are NOT recursed into (not needed for current
//     canonicals; a comment in the code makes this limitation explicit).
//   - Regex literals are not parsed as regex context. This is acceptable for current canonicals;
//     add a focused fixture before relying on regex literals containing comment-like tokens.
//   - After comment removal, the positions of remaining code are preserved (comments -> spaces).
//
// NOTE: canonicals with ${ } containing a nested backtick are NOT supported. The current 8
// canonical files do not have this pattern. If one is added, this function will need updating.
// ─────────────────────────────────────────────────────────────────────────────
export function stripComments(src) {
  let result = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    // String literals: ', ", `
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      result += ch;
      i++;
      while (i < n) {
        const c = src[i];
        result += c;
        if (c === '\\') {
          // escape: consume next char verbatim
          i++;
          if (i < n) { result += src[i]; i++; }
        } else if (c === quote) {
          i++;
          break;
        } else {
          i++;
        }
      }
      continue;
    }
    // Line comment: // ... (to end of line, preserve newline)
    if (ch === '/' && i + 1 < n && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    // Block comment: /* ... */
    if (ch === '/' && i + 1 < n && src[i + 1] === '*') {
      i += 2;
      while (i + 1 < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;  // skip */
      continue;
    }
    result += ch;
    i++;
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// checkForbiddenTokens(src, label): scan comment-stripped source for forbidden patterns.
// Throws an Error with label + pattern name if any forbidden token is found.
// ─────────────────────────────────────────────────────────────────────────────
export function checkForbiddenTokens(src, label) {
  const stripped = stripComments(src);
  if (/^\s*import[\s{(]/m.test(stripped)) {
    throw new Error(`${label}: canonical contains 'import' statement (forbidden in inline)`);
  }
  // Dynamic import does not have to start a line (`const m = await import('x')`,
  // `return import('x')`). The line-anchored statement check above misses those forms, and
  // the harness rejects any workflow script containing an import expression at PARSE time
  // (`SyntaxError: import() is not available in workflow scripts`) -- i.e. one such line
  // inlined into dev-flow.js makes the whole workflow unlaunchable, not just degraded.
  // Unanchored like the require() check below.
  if (/\bimport\s*\(/.test(stripped)) {
    throw new Error(`${label}: canonical contains dynamic 'import()' call (forbidden in inline)`);
  }
  if (/\brequire\s*\(/.test(stripped)) {
    throw new Error(`${label}: canonical contains 'require()' call (forbidden in inline)`);
  }
  if (/\bDate\.now\b/.test(stripped)) {
    throw new Error(`${label}: canonical contains 'Date.now' (forbidden in inline)`);
  }
  if (/\bMath\.random\b/.test(stripped)) {
    throw new Error(`${label}: canonical contains 'Math.random' (forbidden in inline)`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// dropComments(src): remove JS comments from generated inline code.
//
// Why: the Workflow tool rejects scripts over 524288 bytes, and canonical comments
// (kept in _lib/, the only place humans edit) were most of the inline bytes. The inline
// copy is never read for intent, so it carries code only.
//
// Unlike stripComments (a forbidden-token pre-filter that may over-strip), this output is
// executed, so it must never touch string / template / regex literal content:
//   - ', " strings and ` templates (with nested ${ } expressions) are copied verbatim.
//   - `/` starts a regex literal when the previous significant token cannot end an
//     expression (punctuator other than ) ] }, start of input, or a keyword like `return`).
//   - A line comment is removed together with the whitespace before it on its line.
//   - A block comment becomes a single space, keeping its newlines (ASI relies on them).
//   - A line that was non-blank and becomes whitespace-only is dropped; originally blank
//     lines are kept. At least one newline always remains between two code lines.
// ─────────────────────────────────────────────────────────────────────────────
const REGEX_AFTER_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw',
  'case', 'do', 'else', 'yield', 'await',
]);

export function dropComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  // Last significant token: '' (start), 'word' (identifier/number/keyword in prevWord),
  // 'literal' (string/template/regex), or the punctuator character itself.
  let prev = '';
  let prevWord = '';
  // One entry per open template `${`: the `{` nesting depth inside that expression.
  const braceStack = [];
  let inTemplate = false;

  const regexAllowed = () => {
    if (prev === '') return true;
    if (prev === 'word') return REGEX_AFTER_KEYWORDS.has(prevWord);
    if (prev === 'literal') return false;
    return prev !== ')' && prev !== ']' && prev !== '}';
  };

  while (i < n) {
    if (inTemplate) {
      const c = src[i];
      if (c === '\\') {
        out += src.slice(i, i + 2);
        i += 2;
      } else if (c === '`') {
        out += c;
        i++;
        inTemplate = false;
        prev = 'literal';
      } else if (c === '$' && src[i + 1] === '{') {
        out += '${';
        i += 2;
        braceStack.push(0);
        inTemplate = false;
        prev = '{';
      } else {
        out += c;
        i++;
      }
      continue;
    }

    const ch = src[i];
    if (ch === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      out = out.replace(/[ \t]+$/, '');
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end === -1) throw new Error('dropComments: unterminated block comment');
      const newlines = src.slice(i, end).split('\n').length - 1;
      out += newlines > 0 ? '\n'.repeat(newlines) : ' ';
      i = end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < n && src[j] !== ch) {
        if (src[j] === '\\') j++;
        else if (src[j] === '\n') throw new Error('dropComments: unterminated string literal');
        j++;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
      prev = 'literal';
      continue;
    }
    if (ch === '`') {
      out += ch;
      i++;
      inTemplate = true;
      continue;
    }
    if (ch === '/' && regexAllowed()) {
      let j = i + 1;
      let inClass = false;
      while (j < n) {
        const c = src[j];
        if (c === '\\') { j += 2; continue; }
        if (c === '\n') throw new Error('dropComments: unterminated regex literal');
        if (inClass) { if (c === ']') inClass = false; }
        else if (c === '[') inClass = true;
        else if (c === '/') break;
        j++;
      }
      j++;
      while (j < n && /[A-Za-z]/.test(src[j])) j++;
      out += src.slice(i, j);
      i = j;
      prev = 'literal';
      continue;
    }
    if (/[A-Za-z0-9_$\u0080-￿]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$\u0080-￿]/.test(src[j])) j++;
      prevWord = src.slice(i, j);
      prev = 'word';
      out += prevWord;
      i = j;
      continue;
    }
    if (/\s/.test(ch)) {
      out += ch;
      i++;
      continue;
    }
    if (ch === '{' && braceStack.length > 0) {
      braceStack[braceStack.length - 1]++;
    } else if (ch === '}' && braceStack.length > 0) {
      if (braceStack[braceStack.length - 1] === 0) {
        braceStack.pop();
        out += ch;
        i++;
        inTemplate = true;
        continue;
      }
      braceStack[braceStack.length - 1]--;
    }
    out += ch;
    i++;
    prev = ch;
  }
  if (inTemplate || braceStack.length > 0) {
    throw new Error('dropComments: unterminated template literal');
  }

  // out keeps every source newline, so output line k corresponds to source line k.
  const srcLines = src.split('\n');
  return out
    .split('\n')
    .filter((line, k) => line.trim() !== '' || srcLines[k].trim() === '')
    .join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// transformCanonical(src, label): apply the transformation rules:
//   Strip leading 'export ' from function/const/let/var/class/async function declarations.
//   After stripping, any remaining /^export\b/m triggers an error (export default, export {}).
//   Drop comments (dropComments).
//   Normalize trailing whitespace to exactly one newline.
// ─────────────────────────────────────────────────────────────────────────────
export function transformCanonical(src, label) {
  // Apply the transformation: strip 'export ' prefix from declarations
  const transformed = src.replace(
    /^export (?=(async )?(function|const|let|var|class)\b)/gm,
    '',
  );
  // Check for remaining export keywords (export default, export {}, export * from)
  if (/^export\b/m.test(transformed)) {
    throw new Error(
      `${label}: canonical contains unsupported 'export' form (export default / export { } / export * from)`,
    );
  }
  // Normalize trailing newline: trim trailing whitespace/newlines, then add exactly one \n
  return dropComments(transformed).trimEnd() + '\n';
}

// ─────────────────────────────────────────────────────────────────────────────
// collectTopLevelDeclNames(src): collect declaration names that will share the
// workflow file's top-level scope after inline generation. This intentionally
// only considers column-0 declarations; nested declarations stay scoped.
// ─────────────────────────────────────────────────────────────────────────────
export function collectTopLevelDeclNames(src) {
  const stripped = stripComments(src);
  const names = [];
  for (const line of stripped.split('\n')) {
    let match = line.match(/^(?:async\s+function|function)\s+([A-Za-z_$][\w$]*)\b/);
    if (match) {
      names.push(match[1]);
      continue;
    }
    match = line.match(/^class\s+([A-Za-z_$][\w$]*)\b/);
    if (match) {
      names.push(match[1]);
      continue;
    }
    match = line.match(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/);
    if (match) {
      names.push(match[1]);
    }
  }
  return names;
}

// ─────────────────────────────────────────────────────────────────────────────
// splitTopLevelStatements(src): split comment-free inline code (transformCanonical
// output) into top-level statements, in source order.
// Returns: [{ lines: string[], name: string | null }]
//
// A statement starts on a line that begins at column 0 while no bracket, string,
// template or regex is open. Each statement owns the lines up to the next start
// (trailing blank lines included), so concatenating every statement reproduces
// src minus the blank lines before the first one.
//
// `name` is the single declared name, or null when it cannot be decided (destructuring,
// multiple declarators, several statements on one line, a non-declaration statement).
// Unnamed statements are always generated: dropping one would drop a declaration or a
// side effect that nothing can be traced to.
// ─────────────────────────────────────────────────────────────────────────────
export function splitTopLevelStatements(src) {
  const lines = src.split('\n');
  const topLevelLine = new Array(lines.length).fill(false);
  topLevelLine[0] = true;
  // Line index of every depth-0 ',' and of every depth-0 ';' followed by more code.
  const commaLines = new Set();
  const midSemicolonLines = new Set();

  let line = 0;
  let depth = 0;
  let prev = '';
  let prevWord = '';
  const braceStack = [];
  let inTemplate = false;
  const n = src.length;
  const regexAllowed = () => {
    if (prev === '') return true;
    if (prev === 'word') return REGEX_AFTER_KEYWORDS.has(prevWord);
    if (prev === 'literal') return false;
    return prev !== ')' && prev !== ']' && prev !== '}';
  };

  let i = 0;
  while (i < n) {
    const ch = src[i];
    if (ch === '\n') {
      line++;
      topLevelLine[line] = !inTemplate && depth === 0 && braceStack.length === 0;
      i++;
      continue;
    }
    if (inTemplate) {
      if (ch === '\\') {
        if (src[i + 1] === '\n') line++;
        i += 2;
        continue;
      }
      if (ch === '`') { inTemplate = false; prev = 'literal'; i++; continue; }
      if (ch === '$' && src[i + 1] === '{') {
        braceStack.push(0);
        inTemplate = false;
        prev = '{';
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < n && src[j] !== ch) {
        if (src[j] === '\\') j++;
        if (src[j] === '\n') line++;  // line continuation inside the string
        j++;
      }
      i = j + 1;
      prev = 'literal';
      continue;
    }
    if (ch === '`') { inTemplate = true; i++; continue; }
    if (ch === '/' && regexAllowed()) {
      let j = i + 1;
      let inClass = false;
      while (j < n && src[j] !== '\n') {
        const c = src[j];
        if (c === '\\') { j += 2; continue; }
        if (inClass) { if (c === ']') inClass = false; }
        else if (c === '[') inClass = true;
        else if (c === '/') break;
        j++;
      }
      j++;
      while (j < n && /[A-Za-z]/.test(src[j])) j++;
      i = j;
      prev = 'literal';
      continue;
    }
    if (/[A-Za-z0-9_$\u0080-￿]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$\u0080-￿]/.test(src[j])) j++;
      prevWord = src.slice(i, j);
      prev = 'word';
      i = j;
      continue;
    }
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '{' && braceStack.length > 0) {
      braceStack[braceStack.length - 1]++;
    } else if (ch === '}' && braceStack.length > 0) {
      if (braceStack[braceStack.length - 1] === 0) {
        braceStack.pop();
        inTemplate = true;
        i++;
        continue;
      }
      braceStack[braceStack.length - 1]--;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (depth === 0 && braceStack.length === 0) {
      if (ch === ',') commaLines.add(line);
      else if (ch === ';') {
        const eol = src.indexOf('\n', i);
        if (src.slice(i + 1, eol === -1 ? n : eol).trim() !== '') midSemicolonLines.add(line);
      }
    }
    prev = ch;
    i++;
  }

  const starts = [];
  for (let k = 0; k < lines.length; k++) {
    if (topLevelLine[k] && /^[^\s})\]]/.test(lines[k])) starts.push(k);
  }

  return starts.map((start, s) => {
    const end = s + 1 < starts.length ? starts[s + 1] : lines.length;
    let ambiguous = false;
    for (let k = start; k < end; k++) {
      if (commaLines.has(k) || midSemicolonLines.has(k)) ambiguous = true;
    }
    const names = collectTopLevelDeclNames(lines[start]);
    const destructuring = /^(?:const|let|var)\s*[{[]/.test(lines[start]);
    const name = !ambiguous && !destructuring && names.length === 1 ? names[0] : null;
    return { lines: lines.slice(start, end), name };
  });
}

// collectIdentifiers(src): every identifier-shaped word in src, including words inside
// string / template / regex literals. Over-collecting only keeps an extra declaration;
// under-collecting drops one the workflow calls (a ReferenceError at run time).
export function collectIdentifiers(src) {
  return new Set(src.match(/[A-Za-z_$][\w$]*/g) ?? []);
}

// ─────────────────────────────────────────────────────────────────────────────
// selectReferencedDecls(handWrittenSrc, regions): decide what each inline region of one
// workflow generates.
//   regions: [{ source, transformed }] (transformCanonical output, one per region)
// Starting from the identifiers of the hand-written part (everything outside the inline
// regions) plus those of the unnamed statements, a named top-level statement is kept when
// its name is reached; its own identifiers are then followed, across regions.
// Returns: [{ source, body }] in region order; body keeps the canonical statement order and
// is '' when nothing in the region is kept.
// ─────────────────────────────────────────────────────────────────────────────
export function selectReferencedDecls(handWrittenSrc, regions) {
  const split = regions.map(r => splitTopLevelStatements(r.transformed));
  const kept = split.map(stmts => stmts.map(st => st.name === null));
  const byName = new Map();
  split.forEach((stmts, r) => stmts.forEach((st, s) => {
    if (st.name === null) return;
    if (!byName.has(st.name)) byName.set(st.name, []);
    byName.get(st.name).push([r, s]);
  }));

  const seen = new Set();
  const queue = [];
  const visit = (text) => {
    for (const id of collectIdentifiers(text)) {
      if (!seen.has(id)) { seen.add(id); queue.push(id); }
    }
  };
  visit(handWrittenSrc);
  split.forEach((stmts, r) => stmts.forEach((st, s) => {
    if (kept[r][s]) visit(st.lines.join('\n'));
  }));
  while (queue.length > 0) {
    for (const [r, s] of byName.get(queue.pop()) ?? []) {
      if (kept[r][s]) continue;
      kept[r][s] = true;
      visit(split[r][s].lines.join('\n'));
    }
  }

  return regions.map((region, r) => {
    const body = split[r]
      .filter((_, s) => kept[r][s])
      .flatMap(st => st.lines)
      .join('\n')
      .trimEnd();
    return { source: region.source, body: body === '' ? '' : body + '\n' };
  });
}

function validateInlineDeclCollisions(wfFile, inlineRegions) {
  const seen = new Map();
  for (const region of inlineRegions) {
    for (const name of collectTopLevelDeclNames(region.body)) {
      const firstSource = seen.get(name);
      if (firstSource) {
        throw new Error(
          `${wfFile}: top-level declaration collision '${name}' in ${firstSource} and ${region.source}`,
        );
      }
      seen.set(name, region.source);
    }
  }
}

function validateGeneratedWorkflowSyntax(wfFile, src) {
  const parseableSrc = src
    .replace(/^export\s+(?=(async\s+)?(function|const|let|var|class)\b)/gm, '')
    .replace(/^export\s+default\s+/gm, '');
  try {
    // Workflow bodies may contain top-level await/return. Wrapping in an async
    // function validates syntax without executing the generated workflow.
    // eslint-disable-next-line no-new-func
    new Function(`return (async () => {\n${parseableSrc}\n});`);
  } catch (err) {
    throw new Error(`${wfFile}: generated workflow syntax error: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// scanMarkers(wfSrc, wfLabel): parse BEGIN/END marker pairs in a workflow file source.
// Returns: [{source: string (canonical relative path), beginLine: number, endLine: number}]
// Line numbers are 0-indexed (index into wfSrc.split('\n')).
// Errors on: missing END, unexpected END, path mismatch, duplicate canonical in same file.
// ─────────────────────────────────────────────────────────────────────────────
export function scanMarkers(wfSrc, wfLabel) {
  const lines = wfSrc.split('\n');
  const markers = [];
  const seen = new Set();
  let openPath = null;
  let openLine = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const beginMatch = line.match(BEGIN_RE);
    const endMatch = line.match(END_RE);

    if (beginMatch) {
      const path = beginMatch[1];
      if (openPath !== null) {
        throw new Error(
          `${wfLabel}: nested BEGIN inline at line ${i + 1} (already inside '${openPath}')`,
        );
      }
      if (seen.has(path)) {
        throw new Error(
          `${wfLabel}: duplicate inline '${path}' — same canonical inlined twice in one file`,
        );
      }
      openPath = path;
      openLine = i;
    } else if (endMatch) {
      const path = endMatch[1];
      if (openPath === null) {
        throw new Error(
          `${wfLabel}: unexpected END inline '${path}' at line ${i + 1} — no matching BEGIN missing`,
        );
      }
      if (path !== openPath) {
        throw new Error(
          `${wfLabel}: BEGIN/END path mismatch — BEGIN '${openPath}' closed by END '${path}'`,
        );
      }
      seen.add(path);
      markers.push({ source: path, beginLine: openLine, endLine: i });
      openPath = null;
      openLine = -1;
    }
  }

  if (openPath !== null) {
    throw new Error(
      `${wfLabel}: no matching END for BEGIN inline '${openPath}' — END missing`,
    );
  }

  return markers;
}

// ─────────────────────────────────────────────────────────────────────────────
// insertMarkerPair(wfSrc, source, anchor, wfLabel): insert a new BEGIN/END inline
// marker pair immediately after a literal anchor line.
//
// Rules:
//   - `anchor` must match exactly one line in wfSrc (via `line === anchor` after
//     split('\n')). 0 or >1 matches throw.
//   - The anchor line must not fall inside an existing BEGIN..END region (checked
//     via scanMarkers): the range is [beginLine, endLine) — the END line itself
//     is "outside" and may be used as an anchor (i.e. inserting a new region
//     immediately after an existing one is allowed).
//   - Does not fill the region body or validate the canonical; callers run the
//     existing pipeline (scanMarkers -> checkForbiddenTokens -> transformCanonical
//     -> validateInlineDeclCollisions -> validateGeneratedWorkflowSyntax) via
//     syncWorkflowSource on the returned source.
//
// Returns: new wfSrc string with the marker pair inserted (region body empty).
// ─────────────────────────────────────────────────────────────────────────────
export function insertMarkerPair(wfSrc, source, anchor, wfLabel) {
  const lines = wfSrc.split('\n');
  const matchIndices = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === anchor) matchIndices.push(i);
  }
  if (matchIndices.length === 0) {
    throw new Error(`${wfLabel}: --after anchor not found (expected exactly 1 matching line): ${JSON.stringify(anchor)}`);
  }
  if (matchIndices.length > 1) {
    throw new Error(`${wfLabel}: --after anchor matched ${matchIndices.length} lines, expected exactly 1: ${JSON.stringify(anchor)}`);
  }
  const anchorIndex = matchIndices[0];

  // Reject anchors inside an existing inline region (nested markers). Let any
  // scanMarkers error on malformed existing marker structure propagate as-is.
  const markers = scanMarkers(wfSrc, wfLabel);
  for (const marker of markers) {
    if (anchorIndex >= marker.beginLine && anchorIndex < marker.endLine) {
      throw new Error(
        `${wfLabel}: --after anchor (line ${anchorIndex + 1}) is inside existing inline region '${marker.source}' (BEGIN line ${marker.beginLine + 1} - END line ${marker.endLine + 1}) — nested markers are not allowed`,
      );
    }
  }

  const beginLine = `// ==== BEGIN inline: ${source} (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====`;
  const endLine = `// ==== END inline: ${source} ====`;
  lines.splice(anchorIndex + 1, 0, beginLine, endLine);
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// removeMarkerPair(wfSrc, source, wfLabel): remove an existing BEGIN/END inline
// marker pair (and its body) for `source`, the mirror-image operation of
// insertMarkerPair. Used to retire an inline region entirely (e.g. when the
// canonical it inlines is being deleted).
//
// Rules:
//   - Exactly one BEGIN/END pair matching `source` must exist (via scanMarkers);
//     0 matches throws (nothing to remove). scanMarkers itself already rejects
//     >1 BEGIN of the same source within one file ("duplicate inline"), so that
//     case surfaces as a scanMarkers error rather than being re-checked here.
//   - Removes the BEGIN line through the END line, inclusive. No other region
//     or hand-written line is touched.
//   - If the removal leaves 3+ consecutive blank lines at the seam, they are
//     collapsed to a single blank line (cosmetic only; scoped to the seam so
//     unrelated blank-line runs elsewhere in the file are left untouched).
//
// Returns: new wfSrc string with the marker pair (and body) removed.
// ─────────────────────────────────────────────────────────────────────────────
export function removeMarkerPair(wfSrc, source, wfLabel) {
  const markers = scanMarkers(wfSrc, wfLabel);
  const matches = markers.filter(m => m.source === source);
  if (matches.length === 0) {
    throw new Error(`${wfLabel}: no inline region found for '${source}' — nothing to remove`);
  }
  if (matches.length > 1) {
    throw new Error(`${wfLabel}: multiple inline regions found for '${source}' (${matches.length}) — expected exactly 1`);
  }
  const { beginLine, endLine } = matches[0];
  const lines = wfSrc.split('\n');
  lines.splice(beginLine, endLine - beginLine + 1);

  // Collapse a 3+ blank-line run left exactly at the removal seam to a single
  // blank line. Scoped to the seam only: it does not scan or touch blank-line
  // runs elsewhere in the file.
  let seamStart = beginLine;
  while (seamStart > 0 && lines[seamStart - 1] === '') seamStart--;
  let seamEnd = beginLine;
  while (seamEnd < lines.length && lines[seamEnd] === '') seamEnd++;
  if (seamEnd - seamStart >= 3) {
    lines.splice(seamStart, seamEnd - seamStart, '');
  }

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// planInlineRegions(root, wfFile, wfSrc): compute the body every BEGIN/END inline region
// of one workflow must hold: forbidden tokens -> transform -> keep only the top-level
// statements referenced from the workflow (selectReferencedDecls) -> empty-region check
// -> decl collisions. The generator and _lib/workflow-inlines.sync.test.mjs both use it.
//
// A region left with nothing to generate is an error rather than an empty region: the
// workflow no longer uses that canonical, so its marker pair should go (--remove).
//
// Returns: [{ source, beginLine, endLine, body }] in scan order.
// ─────────────────────────────────────────────────────────────────────────────
export function planInlineRegions(root, wfFile, wfSrc) {
  const markers = scanMarkers(wfSrc, wfFile);
  const regions = markers.map(marker => {
    const canonicalPath = join(root, marker.source);
    if (!existsSync(canonicalPath)) {
      throw new Error(
        `${wfFile}: canonical '${marker.source}' not found at '${canonicalPath}'`,
      );
    }
    const canonicalSrc = readFileSync(canonicalPath, 'utf8');
    checkForbiddenTokens(canonicalSrc, marker.source);
    return { source: marker.source, transformed: transformCanonical(canonicalSrc, marker.source) };
  });

  const handWritten = wfSrc
    .split('\n')
    .filter((_, i) => !markers.some(m => i >= m.beginLine && i <= m.endLine))
    .join('\n');
  const selected = selectReferencedDecls(handWritten, regions);

  const unused = selected.filter(r => r.body === '');
  if (unused.length > 0) {
    throw new Error(
      `${wfFile}: inline region generates no declaration (nothing in it is referenced from the workflow): ` +
      unused.map(r => r.source).join(', ') +
      ` — remove it with: ${unused.map(r => `--remove ${r.source} --from ${wfFile}`).join(' / ')}`,
    );
  }
  validateInlineDeclCollisions(wfFile, selected);

  return markers.map((marker, k) => ({ ...marker, body: selected[k].body }));
}

// ─────────────────────────────────────────────────────────────────────────────
// syncWorkflowSource(root, wfFile, wfSrc): fill all BEGIN/END inline regions in a
// single workflow file source (planInlineRegions) and check the generated syntax.
// Shared by syncRepo (multi-file orchestration) and the --add / --remove CLI modes.
//
// Returns: { newSrc, changed, markerSources }
//   markerSources preserves scan order (top-to-bottom).
// ─────────────────────────────────────────────────────────────────────────────
function syncWorkflowSource(root, wfFile, wfSrc) {
  const planned = planInlineRegions(root, wfFile, wfSrc);

  if (planned.length === 0) {
    validateGeneratedWorkflowSyntax(wfFile, wfSrc);
    return { newSrc: wfSrc, changed: false, markerSources: [] };
  }

  const lines = wfSrc.split('\n');
  // Splice bottom-up so earlier regions' line indices stay valid.
  for (const region of [...planned].reverse()) {
    const newRegion = [
      lines[region.beginLine],
      ...region.body.split('\n').slice(0, -1),
      lines[region.endLine],
    ];
    lines.splice(region.beginLine, region.endLine - region.beginLine + 1, ...newRegion);
  }

  const newSrc = lines.join('\n');
  validateGeneratedWorkflowSyntax(wfFile, newSrc);

  return {
    newSrc,
    changed: newSrc !== wfSrc,
    markerSources: planned.map(m => m.source),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// syncRepo(root, {write}): orchestrate sync across all workflow files in root.
// Returns: { results: [{file, source, changed}], ... }
// ─────────────────────────────────────────────────────────────────────────────
export function syncRepo(root, { write }) {
  const wfDir = join(root, '.claude', 'workflows');
  const wfFiles = readdirSync(wfDir)
    .filter(f => f.endsWith('.js'))
    .sort();

  const results = [];

  for (const wfFile of wfFiles) {
    const wfPath = join(wfDir, wfFile);
    const wfSrc = readFileSync(wfPath, 'utf8');
    const { newSrc, changed, markerSources } = syncWorkflowSource(root, wfFile, wfSrc);

    if (markerSources.length === 0) {
      results.push({ file: wfFile, source: null, changed: false });
      continue;
    }

    for (const source of markerSources) {
      results.push({ file: wfFile, source, changed });
    }

    if (changed && write) {
      writeFileSync(wfPath, newSrc, 'utf8');
    }
  }

  return { results };
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI entry point: only runs when directly executed (not when imported).
//
// Compares realpath(process.argv[1]) against realpath(this file) so bare-form
// invocation (direct execve of the script path — e.g. exec-proxy subagent
// Bash calls, or invocation via a symlink) still resolves to the same file
// as `node tools/sync-inlines.mjs`. Falls back to the previous strict-path
// equality if realpath fails (e.g. argv[1] does not exist on disk).
// ─────────────────────────────────────────────────────────────────────────────
const isMain = (() => {
  if (!process.argv[1]) return false;
  const thisFile = fileURLToPath(import.meta.url);
  try {
    return realpathSync(process.argv[1]) === realpathSync(thisFile);
  } catch {
    return thisFile === process.argv[1];
  }
})();

const USAGE = 'Usage: sync-inlines.mjs [--write|--check] [--root <dir>]\n' +
  '   or: sync-inlines.mjs --add <canonical> --into <workflow> --after <anchor> [--root <dir>]\n' +
  '   or: sync-inlines.mjs --remove <canonical> --from <workflow> [--root <dir>]\n';

if (isMain) {
  const args = process.argv.slice(2);
  let write = false;
  let check = false;
  let root = null;
  let add = null;
  let into = null;
  let after = null;
  let remove = null;
  let from = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--write') { write = true; }
    else if (args[i] === '--check') { check = true; }
    else if (args[i] === '--root' && i + 1 < args.length) { root = args[++i]; }
    else if (args[i] === '--add' && i + 1 < args.length) { add = args[++i]; }
    else if (args[i] === '--into' && i + 1 < args.length) { into = args[++i]; }
    else if (args[i] === '--after' && i + 1 < args.length) { after = args[++i]; }
    else if (args[i] === '--remove' && i + 1 < args.length) { remove = args[++i]; }
    else if (args[i] === '--from' && i + 1 < args.length) { from = args[++i]; }
    else {
      process.stderr.write(`Unknown flag: ${args[i]}\n${USAGE}`);
      process.exit(2);
    }
  }

  const addMode = add !== null || into !== null || after !== null;
  const removeMode = remove !== null || from !== null;

  if (addMode && removeMode) {
    process.stderr.write(`--add and --remove cannot be combined.\n${USAGE}`);
    process.exit(2);
  }

  if (addMode) {
    if (write || check) {
      process.stderr.write(`--add cannot be combined with --write/--check.\n${USAGE}`);
      process.exit(2);
    }
    if (add === null || into === null || after === null) {
      process.stderr.write(`--add requires --into and --after.\n${USAGE}`);
      process.exit(2);
    }
    if (!add.startsWith('_lib/') || !add.endsWith('.mjs')) {
      process.stderr.write(`--add canonical must be a repo-root-relative path starting with '_lib/' and ending with '.mjs': ${add}\n${USAGE}`);
      process.exit(2);
    }
    // Reject '..' segments: join(root, add) would otherwise resolve outside _lib/ and the
    // non-normalized path would be embedded verbatim as the marker's canonical source,
    // making the marker unresolvable by --write/--check from a different cwd.
    if (add.split('/').includes('..')) {
      process.stderr.write(`--add canonical must not contain '..' path segments: ${add}\n${USAGE}`);
      process.exit(2);
    }
    if (into.includes('/')) {
      process.stderr.write(`--into must be a bare workflow file name (no '/'): ${into}\n${USAGE}`);
      process.exit(2);
    }
  } else if (removeMode) {
    if (write || check) {
      process.stderr.write(`--remove cannot be combined with --write/--check.\n${USAGE}`);
      process.exit(2);
    }
    if (remove === null || from === null) {
      process.stderr.write(`--remove requires --from.\n${USAGE}`);
      process.exit(2);
    }
    if (!remove.startsWith('_lib/') || !remove.endsWith('.mjs')) {
      process.stderr.write(`--remove canonical must be a repo-root-relative path starting with '_lib/' and ending with '.mjs': ${remove}\n${USAGE}`);
      process.exit(2);
    }
    if (remove.split('/').includes('..')) {
      process.stderr.write(`--remove canonical must not contain '..' path segments: ${remove}\n${USAGE}`);
      process.exit(2);
    }
    if (from.includes('/')) {
      process.stderr.write(`--from must be a bare workflow file name (no '/'): ${from}\n${USAGE}`);
      process.exit(2);
    }
  } else if (write === check) {  // both true (xor false) means either both set or neither
    process.stderr.write(`Exactly one of --write or --check is required.\n${USAGE}`);
    process.exit(2);
  }

  if (root === null) {
    root = join(dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'dev-flow');
  }

  try {
    if (addMode) {
      const canonicalPath = join(root, add);
      if (!existsSync(canonicalPath)) {
        throw new Error(`canonical '${add}' not found at '${canonicalPath}'`);
      }
      const wfPath = join(root, '.claude', 'workflows', into);
      if (!existsSync(wfPath)) {
        throw new Error(`workflow '${into}' not found at '${wfPath}'`);
      }
      const wfSrc = readFileSync(wfPath, 'utf8');
      const inserted = insertMarkerPair(wfSrc, add, after, into);
      const { newSrc } = syncWorkflowSource(root, into, inserted);
      writeFileSync(wfPath, newSrc, 'utf8');
      process.stdout.write(`added: ${into} (${add})\n`);
    } else if (removeMode) {
      const wfPath = join(root, '.claude', 'workflows', from);
      if (!existsSync(wfPath)) {
        throw new Error(`workflow '${from}' not found at '${wfPath}'`);
      }
      const wfSrc = readFileSync(wfPath, 'utf8');
      const removed = removeMarkerPair(wfSrc, remove, from);
      const { newSrc } = syncWorkflowSource(root, from, removed);
      writeFileSync(wfPath, newSrc, 'utf8');
      process.stdout.write(`removed: ${from} (${remove})\n`);
    } else {
      const { results } = syncRepo(root, { write });
      if (check) {
        const drifted = results.filter(r => r.changed);
        if (drifted.length > 0) {
          process.stderr.write('sync-inlines: inline sections out of date:\n');
          for (const r of drifted) {
            process.stderr.write(`  ${r.file}: _lib/${r.source}\n`);
          }
          process.exit(1);
        }
        process.exit(0);
      }
      // --write: report what changed
      const changed = results.filter(r => r.changed);
      if (changed.length > 0) {
        for (const r of changed) {
          process.stdout.write(`updated: ${r.file} (${r.source})\n`);
        }
      } else {
        process.stdout.write('sync-inlines: all inline sections are up to date.\n');
      }
    }
  } catch (err) {
    process.stderr.write(`sync-inlines error: ${err.message}\n`);
    process.exit(1);
  }
}
