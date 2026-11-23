/** Zero-dependency Kotlin tokenizer for build-time HTML syntax highlighting. */

import { escapeHtml, span } from './source_tokens.mts';

const KEYWORDS = new Set([
  'abstract', 'as', 'break', 'by', 'catch', 'class', 'companion', 'const',
  'constructor', 'continue', 'crossinline', 'data', 'do', 'else', 'enum',
  'finally', 'for', 'fun', 'if', 'import', 'in', 'infix', 'init', 'inline',
  'interface', 'internal', 'is', 'lateinit', 'noinline', 'object', 'open',
  'operator', 'out', 'override', 'package', 'private', 'protected', 'public',
  'reified', 'return', 'sealed', 'super', 'suspend', 'tailrec', 'this',
  'throw', 'try', 'typealias', 'val', 'var', 'vararg', 'when', 'where', 'while',
]);

const LITERALS = new Set(['true', 'false', 'null']);

function isIdentStart(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
}

function isIdentPart(ch: string): boolean {
  return isIdentStart(ch) || (ch >= '0' && ch <= '9');
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

/** Find matching closing brace for a `${...}` template expression, respecting nested braces and strings. */
function findTemplateEnd(line: string, openBrace: number): number {
  let depth = 1;
  let i = openBrace + 1;
  while (i < line.length && depth > 0) {
    const ch = line[i];
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i += 1;
      while (i < line.length) {
        if (line[i] === '\\' && i + 1 < line.length) i += 2;
        else if (line[i] === quote) { i += 1; break; }
        else i += 1;
      }
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    i += 1;
  }
  return depth === 0 ? i - 1 : -1;
}

/** Highlight string contents, handling Kotlin `$name` / `${expr}` templates and optional backslash escapes. */
function highlightStringSegment(segment: string, allowEscapes: boolean): string {
  let out = '';
  let plainStart = 0;
  let i = 0;
  const flushPlain = (end: number) => {
    if (end > plainStart) out += span('tok-str', segment.slice(plainStart, end));
  };

  while (i < segment.length) {
    const ch = segment[i];
    if (allowEscapes && ch === '\\' && i + 1 < segment.length) {
      flushPlain(i);
      const escEnd = segment[i + 1] === 'u' && i + 6 <= segment.length ? i + 6 : i + 2;
      out += span('tok-num', segment.slice(i, escEnd));
      i = escEnd;
      plainStart = i;
      continue;
    }
    if (ch === '$' && i + 1 < segment.length) {
      if (segment[i + 1] === '{') {
        const closeBrace = findTemplateEnd(segment, i + 1);
        if (closeBrace !== -1) {
          flushPlain(i);
          const expr = segment.slice(i + 2, closeBrace);
          out += `${span('tok-kw', '${')}${highlightCodeSlice(expr)}${span('tok-kw', '}')}`;
          i = closeBrace + 1;
          plainStart = i;
          continue;
        }
      } else if (isIdentStart(segment[i + 1])) {
        flushPlain(i);
        let end = i + 2;
        while (end < segment.length && isIdentPart(segment[end])) end += 1;
        out += `${span('tok-kw', '$')}${escapeHtml(segment.slice(i + 1, end))}`;
        i = end;
        plainStart = i;
        continue;
      }
    }
    i += 1;
  }
  flushPlain(segment.length);
  return out;
}

function highlightCodeSlice(line: string): string {
  return highlightKotlinLines([line])[0].trimEnd() === '' && line === '' ? '' : highlightKotlinLines([line])[0];
}

/**
 * Highlight an array of raw Kotlin source lines into escaped HTML strings.
 * Preserves multi-line block/KDoc comment depth and triple-quoted raw strings across lines.
 */
export function highlightKotlinLines(lines: string[]): string[] {
  let blockCommentDepth = 0;
  let inTripleString = false;

  return lines.map((line) => {
    let out = '';
    let i = 0;
    const len = line.length;

    while (i < len) {
      if (blockCommentDepth > 0) {
        const start = i;
        while (i < len && blockCommentDepth > 0) {
          if (line[i] === '/' && line[i + 1] === '*') {
            blockCommentDepth += 1;
            i += 2;
          } else if (line[i] === '*' && line[i + 1] === '/') {
            blockCommentDepth -= 1;
            i += 2;
          } else {
            i += 1;
          }
        }
        out += span('tok-cm', line.slice(start, i));
        continue;
      }

      if (inTripleString) {
        const start = i;
        const end = line.indexOf('"""', i);
        if (end === -1) {
          i = len;
          out += highlightStringSegment(line.slice(start, i), false);
        } else {
          out += highlightStringSegment(line.slice(start, end), false) + span('tok-str', '"""');
          i = end + 3;
          inTripleString = false;
        }
        continue;
      }

      const ch = line[i];
      const next = line[i + 1];

      if (ch === '/' && next === '/') {
        out += span('tok-cm', line.slice(i));
        break;
      }

      if (ch === '/' && next === '*') {
        const start = i;
        blockCommentDepth = 1;
        i += 2;
        while (i < len && blockCommentDepth > 0) {
          if (line[i] === '/' && line[i + 1] === '*') {
            blockCommentDepth += 1;
            i += 2;
          } else if (line[i] === '*' && line[i + 1] === '/') {
            blockCommentDepth -= 1;
            i += 2;
          } else {
            i += 1;
          }
        }
        out += span('tok-cm', line.slice(start, i));
        continue;
      }

      if (ch === '"' && next === '"' && line[i + 2] === '"') {
        const contentStart = i + 3;
        const end = line.indexOf('"""', contentStart);
        if (end === -1) {
          inTripleString = true;
          out += span('tok-str', '"""') + highlightStringSegment(line.slice(contentStart), false);
          i = len;
        } else {
          out += span('tok-str', '"""') + highlightStringSegment(line.slice(contentStart, end), false) + span('tok-str', '"""');
          i = end + 3;
        }
        continue;
      }

      if (ch === '"') {
        const start = i;
        i += 1;
        while (i < len) {
          if (line[i] === '\\' && i + 1 < len) {
            i += 2;
          } else if (line[i] === '$' && line[i + 1] === '{') {
            const closeBrace = findTemplateEnd(line, i + 1);
            i = closeBrace === -1 ? i + 2 : closeBrace + 1;
          } else if (line[i] === '"') {
            i += 1;
            break;
          } else {
            i += 1;
          }
        }
        const closed = i > start + 1 && line[i - 1] === '"';
        const inner = closed ? line.slice(start + 1, i - 1) : line.slice(start + 1, i);
        out += span('tok-str', '"') + highlightStringSegment(inner, true) + (closed ? span('tok-str', '"') : '');
        continue;
      }

      if (ch === "'") {
        const start = i;
        i += 1;
        while (i < len) {
          if (line[i] === '\\' && i + 1 < len) {
            i += 2;
          } else if (line[i] === "'") {
            i += 1;
            break;
          } else {
            i += 1;
          }
        }
        const closed = i > start + 1 && line[i - 1] === "'";
        const inner = closed ? line.slice(start + 1, i - 1) : line.slice(start + 1, i);
        const innerHtml = inner.startsWith('\\') ? span('tok-num', inner) : span('tok-str', inner);
        out += span('tok-str', "'") + innerHtml + (closed ? span('tok-str', "'") : '');
        continue;
      }

      if (ch === '@' && i + 1 < len && isIdentStart(line[i + 1])) {
        const start = i;
        i += 2;
        while (i < len && isIdentPart(line[i])) i += 1;
        out += span('tok-ann', line.slice(start, i));
        continue;
      }

      if (isDigit(ch)) {
        const start = i;
        if (ch === '0' && (next === 'x' || next === 'X' || next === 'b' || next === 'B')) {
          i += 2;
          while (i < len && /[0-9a-fA-F_]/.test(line[i])) i += 1;
        } else {
          while (i < len && (isDigit(line[i]) || line[i] === '_')) i += 1;
          if (line[i] === '.' && i + 1 < len && isDigit(line[i + 1])) {
            i += 1;
            while (i < len && (isDigit(line[i]) || line[i] === '_')) i += 1;
          }
        }
        while (i < len && /[fFlLuU]/.test(line[i])) i += 1;
        out += span('tok-num', line.slice(start, i));
        continue;
      }

      if (isIdentStart(ch)) {
        const start = i;
        i += 1;
        while (i < len && isIdentPart(line[i])) i += 1;
        const word = line.slice(start, i);
        if (KEYWORDS.has(word)) {
          out += span('tok-kw', word);
        } else if (LITERALS.has(word)) {
          out += span('tok-num', word);
        } else if (/^[A-Z][A-Z0-9_]+$/.test(word)) {
          out += span('tok-const', word);
        } else if (word[0] >= 'A' && word[0] <= 'Z') {
          out += span('tok-ty', word);
        } else if (line[i] === '(') {
          out += span('tok-fn', word);
        } else {
          out += escapeHtml(word);
        }
        continue;
      }

      out += escapeHtml(ch);
      i += 1;
    }

    return out || ' ';
  });
}
