/**
 * Heuristic chunker.
 *
 * The goal is not a perfect AST — it is a *stable* mapping from "a question about the
 * code" to "a small region of a file". A chunk is one declaration: its signature, its
 * doc comment, and its body boundaries, so callers can retrieve exactly that function
 * instead of a whole 2,000-line file.
 *
 * The chunker is deliberately dependency-free and language-pluggable. An AST-based
 * backend (tree-sitter) can replace `chunkFile` without touching the index or the
 * query side, because both only depend on the `Chunk` shape.
 *
 * Four shapes cover most of the code in the wild:
 *   - named declarations      function f() {}  class C {}  const f = () => {}
 *   - CommonJS exports        exports.foo = function () {}
 *   - test blocks             describe('res', function () { it('…', …) })
 *   - Python def/class        indentation-delimited
 */

const MAX_BODY_CHARS = 12_000;
const MAX_SIGNATURE_CHARS = 200;
const MAX_DOC_CHARS = 800;
const LOOKAHEAD_LINES = 400;

/**
 * @typedef {object} Chunk
 * @property {string} symbol
 * @property {string|null} parent    Enclosing class/namespace/describe, when this is a member.
 * @property {string} kind           function | method | class | interface | type | const | export | test
 * @property {string} lang
 * @property {number} startLine      1-based
 * @property {number} endLine        1-based, inclusive
 * @property {string} signature
 * @property {string} doc
 * @property {string} body
 */

/**
 * Chunk one source file.
 * @param {{ relPath: string, text: string, lang: string }} input
 * @returns {Chunk[]}
 */
export function chunkFile({ text, lang }) {
  // No size cap here: `scan` already bounds file size, and silently skipping a large
  // file is the worst failure mode a code index can have — it looks like "no results".
  if (!text) return [];

  const lines = text.split('\n');
  const starts = lineStarts(text);
  const masked = maskSource(text);
  const maskedLines = masked.split('\n');

  const chunks = [];
  const seen = new Set();

  const push = (chunk) => {
    chunk.lang = lang;
    const key = `${chunk.startLine}:${chunk.symbol}`;
    if (seen.has(key)) return;
    if (chunk.endLine < chunk.startLine) return;
    seen.add(key);
    chunks.push(chunk);
  };

  if (lang === 'py') {
    chunkPython(lines, maskedLines, starts, text, push);
  } else {
    chunkJs(lines, masked, starts, text, push);
  }

  chunks.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
  return chunks;
}

/* ------------------------------------------------------------------ */
/* JavaScript / TypeScript                                             */
/* ------------------------------------------------------------------ */

const JS_DECL =
  /^[ \t]*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(function\s*\*?|class|interface|enum|namespace|module|type|const|let|var)\s+([A-Za-z_$][\w$]*)/;

const JS_MEMBER =
  /^([ \t]+)(?:(?:public|private|protected|static|readonly|async|abstract|override|declare|get|set)\s+)*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^<>]*>)?\s*\(/;

const JS_PROP_ARROW =
  /^([ \t]+)(?:(?:public|private|protected|static|readonly)\s+)*([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/;

/** `module.exports = function name()` / `= class Name` */
const JS_MODULE_EXPORT = /^[ \t]*module\.exports\s*=\s*(?:async\s+)?(?:function\s*\*?\s*([A-Za-z_$][\w$]*)|class\s+([A-Za-z_$][\w$]*))/;

/** `exports.name = …` / `module.exports.name = …` */
const JS_EXPORT = /^[ \t]*(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/;

/**
 * `app.set = function set(…)`, `res.status = (code) => …`.
 * CommonJS libraries attach nearly all their API this way, so without it a repo like
 * express indexes its README-level helpers and misses `lib/application.js` entirely.
 */
const JS_PROP_ASSIGN =
  /^[ \t]*(?!module\b|exports\b)([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b|class\b|[A-Za-z_$][\w$]*\s*=>|\()/;

/** `describe('…', function () {` and friends */
const JS_TEST_BLOCK = /^[ \t]*(describe|it|test|context|suite)\s*\(\s*(['"`])((?:\\.|(?!\2)[^\n])*)\2/;

function chunkJs(lines, masked, starts, text, push) {
  const depths = computeDepths(masked, starts);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line) {
      i++;
      continue;
    }

    const indent = line.length - line.trimStart().length;
    const startPos = starts[i] + indent;
    const maskedLine = maskedLineAt(masked, starts, i);

    // --- test blocks -------------------------------------------------
    const test = JS_TEST_BLOCK.exec(line);
    if (test) {
      const open = maskedLine.indexOf('{', test[0].length);
      if (open !== -1) {
        const close = matchPair(masked, starts[i] + open, '{', '}');
        const endLine = close === -1 ? i : lineAt(starts, close);
        const name = cleanTestName(test[3]) || test[1];
        const chunk = makeChunk({
          lines,
          starts,
          text,
          startLine: i + 1,
          endLine: endLine + 1,
          name,
          kind: 'test',
          parent: null,
        });
        if (chunk) push(chunk);

        // Nested `it` blocks carry the real assertions; index them separately so
        // "should respond with jsonp" is findable without reading the whole suite.
        if (test[1] !== 'it' && test[1] !== 'test') {
          collectTests({ lines, masked, starts, text, from: i + 1, to: endLine, parent: name, push });
        }
        i = endLine + 1;
        continue;
      }
    }

    // --- CommonJS exports --------------------------------------------
    const moduleExport = JS_MODULE_EXPORT.exec(maskedLine);
    if (moduleExport) {
      const name = moduleExport[1] || moduleExport[2];
      const endPos = findBlockEnd(masked, starts, startPos, indent);
      const chunk = makeChunk({
        lines,
        starts,
        text,
        startLine: i + 1,
        endLine: lineAt(starts, endPos) + 1,
        name,
        kind: moduleExport[1] ? 'function' : 'class',
        parent: null,
      });
      if (chunk) push(chunk);
      i = lineAt(starts, endPos) + 1;
      continue;
    }

    const exportAssign = JS_EXPORT.exec(maskedLine);
    if (exportAssign) {
      const endPos = findBlockEnd(masked, starts, startPos, indent);
      const statement = text.slice(startPos, endPos + 1);
      // Re-exports and value aliases (`exports.VERSION = '1.0'`, `exports.x = y`) point
      // at something else; only exports that carry a body are worth retrieving.
      if (!/[({]/.test(statement) && !/=>|\bfunction\b|\bclass\b/.test(statement)) {
        i = lineAt(starts, endPos) + 1;
        continue;
      }
      const chunk = makeChunk({
        lines,
        starts,
        text,
        startLine: i + 1,
        endLine: lineAt(starts, endPos) + 1,
        name: exportAssign[1],
        kind: /=>|\bfunction\b|\bclass\b/.test(statement) ? 'function' : 'export',
        parent: 'exports',
      });
      if (chunk) push(chunk);
      i = lineAt(starts, endPos) + 1;
      continue;
    }

    // --- property assignment (CommonJS API style) --------------------
    const propAssign = JS_PROP_ASSIGN.exec(maskedLine);
    if (propAssign) {
      const endPos = findBlockEnd(masked, starts, startPos, indent);
      const object = propAssign[1];
      const chunk = makeChunk({
        lines,
        starts,
        text,
        startLine: i + 1,
        endLine: lineAt(starts, endPos) + 1,
        name: propAssign[2],
        kind: 'method',
        parent: object === 'this' ? null : object,
      });
      if (chunk) push(chunk);
      i = lineAt(starts, endPos) + 1;
      continue;
    }

    // --- named declarations ------------------------------------------
    const m = JS_DECL.exec(maskedLine);
    if (!m) {
      i++;
      continue;
    }

    const keyword = m[1].replace(/\*$/, '').trim();
    const name = m[2];

    // At brace depth 0 we are at module level and every declaration is meaningful.
    // Deeper than that, an un-named wrapper (`(function () {`) or a callback body is
    // indistinguishable from a function body, so only *named* declarations are trusted;
    // local `const`s would otherwise flood the index with one-line variables.
    if (depths[i] > 0 && (keyword === 'const' || keyword === 'let' || keyword === 'var')) {
      i++;
      continue;
    }

    const endPos = findBlockEnd(masked, starts, startPos, indent);
    const endLine = lineAt(starts, endPos);

    let kind = keyword;
    if (keyword === 'const' || keyword === 'let' || keyword === 'var') {
      const statement = text.slice(startPos, endPos + 1);
      kind = /=>|\bfunction\b|\bclass\b/.test(statement) ? 'function' : 'const';
      if (/=\s*require\(/.test(statement)) {
        i = endLine + 1; // `const x = require('y')` is an import, not a symbol
        continue;
      }
    }

    // Scalar constants (`export const VERSION = '1.0'`) are noise in a code index.
    const bodyPreview = text.slice(startPos, Math.min(endPos + 1, startPos + 400));
    if (kind === 'const' && !bodyPreview.includes('{') && !bodyPreview.includes('(')) {
      i = endLine + 1;
      continue;
    }

    const chunk = makeChunk({ lines, starts, text, startLine: i + 1, endLine: endLine + 1, name, kind, parent: null });
    if (chunk) push(chunk);

    // Members of a class/interface/enum are worth indexing individually: they are the
    // unit a caller usually wants ("how does it paginate?") rather than the whole class.
    if (chunk && (kind === 'class' || kind === 'interface' || kind === 'enum')) {
      collectMembers({ lines, masked, starts, text, from: i + 1, to: endLine, parent: name, push });
    }

    i = endLine + 1;
  }
}

function collectMembers({ lines, masked, starts, text, from, to, parent, push }) {
  let i = from;
  while (i <= to && i < lines.length) {
    const maskedLine = maskedLineAt(masked, starts, i);
    const m = JS_MEMBER.exec(maskedLine) || JS_PROP_ARROW.exec(maskedLine);
    if (!m || /^\s*(\*|\/\/|\/\*)/.test(maskedLine)) {
      i++;
      continue;
    }
    const name = m[2];
    if (name === 'if' || name === 'for' || name === 'while' || name === 'switch' || name === 'catch') {
      i++;
      continue;
    }
    const indent = lines[i].length - lines[i].trimStart().length;
    const startPos = starts[i] + indent;
    const endPos = findBlockEnd(masked, starts, startPos, indent);
    const endLine = lineAt(starts, endPos);
    if (endLine > to) break;

    const chunk = makeChunk({ lines, starts, text, startLine: i + 1, endLine: endLine + 1, name, kind: 'method', parent });
    if (chunk) push(chunk);
    i = endLine + 1;
  }
}

function collectTests({ lines, masked, starts, text, from, to, parent, push }) {
  let i = from;
  while (i <= to && i < lines.length) {
    const test = JS_TEST_BLOCK.exec(lines[i] ?? '');
    if (!test) {
      i++;
      continue;
    }
    const maskedLine = maskedLineAt(masked, starts, i);
    const open = maskedLine.indexOf('{', test[0].length);
    if (open === -1) {
      i++;
      continue;
    }
    const close = matchPair(masked, starts[i] + open, '{', '}');
    const endLine = close === -1 ? i : lineAt(starts, close);
    if (endLine > to) break;

    const chunk = makeChunk({
      lines,
      starts,
      text,
      startLine: i + 1,
      endLine: endLine + 1,
      name: cleanTestName(test[3]) || test[1],
      kind: 'test',
      parent,
    });
    if (chunk) push(chunk);

    // `describe('res', …)` often wraps `describe('.jsonp(…)', …)`, which wraps the
    // actual `it` cases. Recurse so the assertions stay individually searchable.
    if (test[1] !== 'it' && test[1] !== 'test' && endLine > i) {
      collectTests({ lines, masked, starts, text, from: i + 1, to: endLine, parent: chunk ? chunk.symbol : parent, push });
    }
    i = endLine + 1;
  }
}

/** Turn a test description into a symbol: `should respond with jsonp` */
function cleanTestName(raw) {
  return String(raw)
    .replace(/\\(['"`])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90);
}

/* ------------------------------------------------------------------ */
/* Python                                                              */
/* ------------------------------------------------------------------ */

const PY_DEF = /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/;
const PY_CLASS = /^(\s*)class\s+([A-Za-z_]\w*)/;

function chunkPython(lines, maskedLines, starts, text, push) {
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const def = PY_DEF.exec(line);
    const cls = def ? null : PY_CLASS.exec(line);
    if (!def && !cls) {
      i++;
      continue;
    }
    const indent = (def ? def[1] : cls[1]).length;
    const name = def ? def[2] : cls[2];
    const kind = def ? 'function' : 'class';
    const endLine = pyBlockEnd(lines, i, indent);

    const chunk = makeChunk({
      lines,
      starts,
      text,
      startLine: i + 1,
      endLine: endLine + 1,
      name,
      kind,
      parent: null,
      docAfterSignature: true,
    });
    if (chunk) push(chunk);

    if (kind === 'class') {
      for (let j = i + 1; j <= endLine; j++) {
        const inner = PY_DEF.exec(lines[j] ?? '');
        if (!inner) continue;
        const innerIndent = inner[1].length;
        if (innerIndent <= indent) continue;
        const innerEnd = pyBlockEnd(lines, j, innerIndent);
        const m = makeChunk({
          lines,
          starts,
          text,
          startLine: j + 1,
          endLine: innerEnd + 1,
          name: inner[2],
          kind: 'method',
          parent: name,
          docAfterSignature: true,
        });
        if (m) push(m);
        j = innerEnd;
      }
    }
    i = endLine + 1;
  }
}

/**
 * Locate the start of a Python block body: the first line after the colon that closes
 * the signature. Handles multi-line signatures, where the closing paren can sit at
 * column 0 and look like a dedent.
 * @returns {{ line: number, inline: boolean }}
 */
function pyBodyStart(lines, startIdx) {
  let depth = 0;
  for (let li = startIdx; li < lines.length; li++) {
    const text = lines[li];
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
      else if (ch === ':' && depth === 0) {
        return { line: li, inline: Boolean(text.slice(i + 1).trim()) };
      }
    }
  }
  return { line: startIdx, inline: false };
}

/**
 * Python block end.
 *
 * Indentation alone is not enough: Black formats long signatures with the closing
 * paren at column 0 —
 *
 *     def get(
 *         url: str,
 *     ) -> Response:
 *
 * so the first `)` looks like a dedent. The signature is therefore skipped by bracket
 * depth first, and indentation scanning starts at the colon that opens the body.
 */
function pyBlockEnd(lines, startIdx, indent) {
  const body = pyBodyStart(lines, startIdx);
  if (body.inline) return body.line;

  let last = body.line;
  for (let i = body.line + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    const ind = line.length - line.trimStart().length;
    if (ind <= indent) break;
    last = i;
  }
  return last;
}

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

function makeChunk({ lines, starts, text, startLine, endLine, name, kind, parent, docAfterSignature }) {
  const clampedEnd = Math.min(endLine, lines.length);
  if (clampedEnd < startLine) return null;

  const startOffset = starts[startLine - 1] + (lines[startLine - 1].length - lines[startLine - 1].trimStart().length);
  const endOffset = clampedEnd < lines.length ? starts[clampedEnd] - 1 : text.length - 1;
  if (endOffset <= startOffset) return null;

  const rawBody = text.slice(startOffset, endOffset + 1);
  const signature = (lines[startLine - 1] || '').trim().slice(0, MAX_SIGNATURE_CHARS);
  const doc = docAfterSignature
    ? pyDocstring(lines, startLine) || precedingComment(lines, startLine - 1)
    : precedingComment(lines, startLine - 1);

  return {
    symbol: name,
    parent: parent ?? null,
    kind,
    lang: kind,
    startLine,
    endLine: clampedEnd,
    signature,
    doc: doc.slice(0, MAX_DOC_CHARS),
    body: rawBody.length > MAX_BODY_CHARS ? `${rawBody.slice(0, MAX_BODY_CHARS)}\n// … truncated` : rawBody,
  };
}

/** Walk backwards over `//`, `*`, and `/** … *\/` comment lines above a declaration. */
function precedingComment(lines, declIdx) {
  const buf = [];
  let i = declIdx - 1;
  // Decorators sit between the doc comment and the signature.
  while (i >= 0 && /^\s*@/.test(lines[i])) i--;

  if (i >= 0 && /\*\/\s*$/.test(lines[i])) {
    while (i >= 0) {
      buf.unshift(lines[i].trim());
      if (/^\s*\/\*\*?/.test(lines[i])) break;
      i--;
    }
    return buf.join('\n');
  }

  while (i >= 0 && /^\s*(\/\/|\*)/.test(lines[i])) {
    buf.unshift(lines[i].trim());
    i--;
  }
  return buf.join('\n');
}

/** Python docstring: the first non-empty line inside the body, if quoted. */
function pyDocstring(lines, declLine) {
  const body = pyBodyStart(lines, declLine - 1);
  if (body.inline) return '';

  for (let i = body.line + 1; i < Math.min(body.line + 6, lines.length); i++) {
    const t = (lines[i] || '').trim();
    if (!t) continue;
    const m = /^[rub]*("""|''')/.exec(t);
    if (!m) return '';
    const quote = m[1];
    const rest = t.slice(m[0].length);
    const closing = rest.indexOf(quote);
    return (closing === -1 ? rest : rest.slice(0, closing)).trim();
  }
  return '';
}

/**
 * Find the end of a declaration.
 *
 * Two things make this harder than "match the first brace":
 *
 *   1. `function f({ a, b })` opens a brace inside the parameter list, so parentheses
 *      are skipped first and only the body brace is matched.
 *   2. Semicolon-free JavaScript ends a statement at a newline (ASI). Without this,
 *      `exports.json = bodyParser.json` would keep scanning into the next function and
 *      swallow it. A following line whose indentation is at or below the declaration's
 *      is treated as the end of the statement.
 */
function findBlockEnd(masked, starts, startPos, indent) {
  const startLine = lineAt(starts, startPos);
  const lastLine = Math.min(startLine + LOOKAHEAD_LINES, starts.length - 1);
  let parens = 0;

  for (let li = startLine; li <= lastLine; li++) {
    const lineStart = starts[li];
    const lineEnd = li + 1 < starts.length ? starts[li + 1] - 1 : masked.length;
    let i = li === startLine ? startPos : lineStart;

    for (; i < lineEnd; i++) {
      const ch = masked[i];
      if (ch === '(') parens++;
      else if (ch === ')') parens = Math.max(0, parens - 1);
      else if (ch === ';' && parens === 0) return i;
      else if (ch === '{' && parens === 0) {
        const close = matchPair(masked, i, '{', '}');
        if (close === -1) {
          // Unbalanced (JSX, templating). Fail small: keep the line, not the file.
          return lineEnd;
        }
        return close;
      }
    }

    if (parens > 0) continue; // signature continues on the next line

    const next = nextCodeLine(masked, starts, li + 1);
    if (next === -1) return lineEnd;
    if (lineIndent(masked, starts, next) <= indent) return lineEnd;
  }

  return masked.length - 1;
}

/** Index of the next line that is not blank, or -1. */
function nextCodeLine(masked, starts, from) {
  for (let li = from; li < starts.length; li++) {
    const end = li + 1 < starts.length ? starts[li + 1] - 1 : masked.length;
    if (masked.slice(starts[li], end).trim()) return li;
  }
  return -1;
}

function lineIndent(masked, starts, line) {
  const end = line + 1 < starts.length ? starts[line + 1] - 1 : masked.length;
  const text = masked.slice(starts[line], end);
  return text.length - text.trimStart().length;
}

/** Index of the matching close character, or -1. */
function matchPair(masked, openPos, open, close) {
  let depth = 0;
  for (let i = openPos; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Blank out comments, string literals and regex literals so brace matching does not
 * trip over `{` inside a string or a comment.
 * @param {string} src
 */
function maskSource(src) {
  const out = src.split('');
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && src[i] !== '\n') out[i++] = ' ';
      continue;
    }
    if (c === '/' && next === '*') {
      out[i++] = ' ';
      out[i++] = ' ';
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] !== '\n') out[i] = ' ';
        i++;
      }
      if (i < n) {
        out[i++] = ' ';
        out[i++] = ' ';
      }
      continue;
    }
    // A regex literal can contain `{`, `}`, quotes and `//`. Treating it as plain code
    // (or as a comment) corrupts every brace that follows, so detect and skip it.
    if (c === '/' && isRegexStart(src, i)) {
      out[i++] = ' ';
      let inClass = false;
      while (i < n) {
        const ch = src[i];
        if (ch === '\\') {
          out[i++] = ' ';
          if (i < n) out[i++] = ' ';
          continue;
        }
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) {
          out[i++] = ' ';
          break;
        }
        if (ch !== '\n') out[i] = ' ';
        i++;
      }
      while (i < n && /[a-z]/i.test(src[i])) out[i++] = ' ';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out[i++] = ' ';
      while (i < n) {
        if (src[i] === '\\') {
          out[i++] = ' ';
          if (i < n && src[i] !== '\n') out[i++] = ' ';
          continue;
        }
        if (src[i] === quote) {
          out[i++] = ' ';
          break;
        }
        if (src[i] !== '\n') out[i] = ' ';
        i++;
      }
      continue;
    }
    i++;
  }
  return out.join('');
}

/**
 * Decide whether the `/` at `i` opens a regex literal rather than a division.
 * Heuristic: a regex can only start where an expression is expected, i.e. after an
 * operator, an opening bracket, or a keyword — never after an identifier or `)`.
 */
function isRegexStart(src, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(src[j])) j--;
  if (j < 0) return true;

  const prev = src[j];
  if ('(,=:[!&|?{};+-*%~^<>'.includes(prev)) return true;

  let k = j;
  while (k >= 0 && /[A-Za-z_$0-9]/.test(src[k])) k--;
  const word = src.slice(k + 1, j + 1);
  return /^(return|typeof|instanceof|case|in|of|new|delete|void|yield|await|else|do)$/.test(word);
}

/** Brace depth at the start of each line (after masking, so strings cannot skew it). */
function computeDepths(masked, starts) {
  const depths = new Array(starts.length).fill(0);
  let depth = 0;
  let line = 0;
  for (let i = 0; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === '\n') {
      line++;
      depths[line] = depth;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') depth = Math.max(0, depth - 1);
  }
  return depths;
}

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function maskedLineAt(masked, starts, lineIdx) {
  const start = starts[lineIdx];
  const end = lineIdx + 1 < starts.length ? starts[lineIdx + 1] - 1 : masked.length;
  return masked.slice(start, end);
}

function lineAt(starts, pos) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
